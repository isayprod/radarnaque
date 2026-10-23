"""Quota de l'identification : `purpose`, et `analyze` inclus dans l'`identify` qui le précède."""

import asyncio
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from test_scan_service import TEST_SETTINGS, Clock, _scan, _user

from radarnaque_api.auth.privileges import privileges_of
from radarnaque_api.models import (
    AuthUser,
    Identification,
    IdentificationResult,
    ScanEvent,
    ScanFailure,
    Subscription,
)
from radarnaque_api.schemas import ScanIn
from radarnaque_api.services.scans import ScanError, ScanPurpose, _Admission, _admit
from radarnaque_api.services.usage import compute_usage


@pytest_asyncio.fixture
async def engine(pg_url: str) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(pg_url)
    try:
        yield eng
    finally:
        await eng.dispose()


@pytest.fixture
def clock() -> Clock:
    return Clock()


async def admit(
    engine: AsyncEngine,
    user: AuthUser,
    clock: Clock,
    purpose: ScanPurpose,
    scan: ScanIn | None = None,
) -> _Admission:
    async with AsyncSession(engine) as session:
        return await _admit(
            session,
            user,
            privileges_of(user, TEST_SETTINGS),
            scan or _scan(),
            clock,
            purpose=purpose,
        )


async def succeed(engine: AsyncEngine, admission: _Admission) -> None:
    """Marque l'`identify` réservé comme réussi : une identification et son lien."""
    async with AsyncSession(engine) as session:
        identification_id = await session.scalar(
            Identification.__table__.insert()
            .values(
                snapshot_id=admission.snapshot_id,
                config_hash=uuid4().hex,
                input_hash=uuid4().hex,
                status="identified",
                confidence=80,
            )
            .returning(Identification.id)
        )
        session.add(
            IdentificationResult(
                scan_event_id=admission.event_id, identification_id=identification_id
            )
        )
        await session.commit()


async def fail(engine: AsyncEngine, event_id: int) -> None:
    async with AsyncSession(engine) as session:
        session.add(ScanFailure(scan_event_id=event_id, error_code="internal"))
        await session.commit()


async def remaining(engine: AsyncEngine, user: AuthUser, clock: Clock) -> int:
    async with AsyncSession(engine) as session:
        sub = (
            await session.execute(select(Subscription).where(Subscription.user_id == user.id))
        ).scalar_one()
        usage = await compute_usage(session, sub, clock())
    assert usage.total is not None
    return usage.total.remaining


async def included_by(engine: AsyncEngine, event_id: int) -> int | None:
    async with AsyncSession(engine) as session:
        return await session.scalar(
            select(ScanEvent.included_by_event_id).where(ScanEvent.id == event_id)
        )


async def test_identify_consumes_one_scan(engine, clock):
    user = await _user(engine)
    admission = await admit(engine, user, clock, "identify")
    assert admission.purpose == "identify" and not admission.included
    assert admission.identify.criteria_max_pages > 0
    async with AsyncSession(engine) as session:
        purpose = await session.scalar(
            select(ScanEvent.purpose).where(ScanEvent.id == admission.event_id)
        )
    assert purpose == "identify"
    assert await remaining(engine, user, clock) == 2


async def test_analyze_after_own_identify_is_included_once(engine, clock):
    user = await _user(engine)
    identify = await admit(engine, user, clock, "identify")
    await succeed(engine, identify)
    clock.advance(minutes=1)
    first = await admit(engine, user, clock, "analyze")
    assert first.included and first.purpose == "analyze"
    assert await included_by(engine, first.event_id) == identify.event_id
    assert await remaining(engine, user, clock) == 2
    clock.advance(minutes=1)
    second = await admit(engine, user, clock, "analyze")
    assert not second.included
    assert await included_by(engine, second.event_id) is None
    assert await remaining(engine, user, clock) == 1


async def test_analyze_included_even_with_zero_remaining(engine, clock):
    user = await _user(engine)
    identify = await admit(engine, user, clock, "identify")
    await succeed(engine, identify)
    for i in range(2):
        clock.advance(seconds=1)
        await admit(engine, user, clock, "identify", _scan(description=f"autre {i}"))
    assert await remaining(engine, user, clock) == 0
    with pytest.raises(ScanError) as info:
        await admit(engine, user, clock, "identify", _scan(description="encore"))
    assert info.value.code == "quota_exhausted"
    clock.advance(seconds=1)
    analysis = await admit(engine, user, clock, "analyze")
    assert analysis.included
    # Sans identify à inclure, le quota épuisé refuse.
    clock.advance(seconds=1)
    with pytest.raises(ScanError) as info:
        await admit(engine, user, clock, "analyze")
    assert info.value.code == "quota_exhausted"


async def test_failed_identify_does_not_include(engine, clock):
    user = await _user(engine)
    identify = await admit(engine, user, clock, "identify")
    await succeed(engine, identify)
    await fail(engine, identify.event_id)
    clock.advance(minutes=1)
    assert not (await admit(engine, user, clock, "analyze")).included


async def test_identify_without_result_does_not_include(engine, clock):
    user = await _user(engine)
    await admit(engine, user, clock, "identify")
    clock.advance(minutes=1)
    assert not (await admit(engine, user, clock, "analyze")).included


async def test_failed_included_analyze_frees_the_identify(engine, clock):
    user = await _user(engine)
    identify = await admit(engine, user, clock, "identify")
    await succeed(engine, identify)
    clock.advance(minutes=1)
    first = await admit(engine, user, clock, "analyze")
    assert first.included
    await fail(engine, first.event_id)
    clock.advance(minutes=1)
    second = await admit(engine, user, clock, "analyze")
    assert second.included
    assert await included_by(engine, second.event_id) == identify.event_id
    assert await remaining(engine, user, clock) == 2


async def test_identify_older_than_24h_does_not_include(engine, clock):
    user = await _user(engine)
    identify = await admit(engine, user, clock, "identify")
    await succeed(engine, identify)
    clock.advance(hours=24, seconds=1)
    assert not (await admit(engine, user, clock, "analyze")).included


async def test_other_listing_or_user_does_not_include(engine, clock):
    owner = await _user(engine)
    other = await _user(engine)
    identify = await admit(engine, owner, clock, "identify")
    await succeed(engine, identify)
    clock.advance(minutes=1)
    assert not (await admit(engine, other, clock, "analyze")).included
    different = _scan(listing={"externalId": "m999", "url": "https://www.2dehands.be/v/a/m999"})
    assert not (await admit(engine, owner, clock, "analyze", different)).included


async def test_other_users_identify_does_not_include(engine, clock):
    owner = await _user(engine)
    other = await _user(engine)
    await succeed(engine, await admit(engine, owner, clock, "identify"))
    clock.advance(minutes=1)
    assert not (await admit(engine, other, clock, "analyze")).included


async def test_unlimited_account_is_never_marked_included(engine, clock):
    admin = await _user(engine, role="admin", plan=None)
    await succeed(engine, await admit(engine, admin, clock, "identify"))
    clock.advance(minutes=1)
    analysis = await admit(engine, admin, clock, "analyze")
    assert not analysis.included
    assert await included_by(engine, analysis.event_id) is None


async def test_concurrent_identify_and_analyze(engine, clock):
    """Niveau réservation. Un `analyze` réservé alors que l'`identify` n'a pas encore de
    `identification_results` est décompté ; réservé après, il est inclus ; deux `analyze`
    simultanés n'incluent l'`identify` qu'une fois."""
    user = await _user(engine)
    identify = await admit(engine, user, clock, "identify")
    early = await admit(engine, user, clock, "analyze")
    assert not early.included
    await succeed(engine, identify)
    await fail(engine, early.event_id)  # l'analyse décomptée échoue : seul l'identify reste
    clock.advance(seconds=1)
    late = await admit(engine, user, clock, "analyze")
    assert late.included and await included_by(engine, late.event_id) == identify.event_id

    racer = await _user(engine)
    identify = await admit(engine, racer, clock, "identify")
    await succeed(engine, identify)
    clock.advance(seconds=1)
    pair = await asyncio.gather(
        admit(engine, racer, clock, "analyze"), admit(engine, racer, clock, "analyze")
    )
    assert sorted(a.included for a in pair) == [False, True]
    async with AsyncSession(engine) as session:
        marked = await session.scalar(
            select(func.count())
            .select_from(ScanEvent)
            .where(ScanEvent.included_by_event_id == identify.event_id)
        )
    assert marked == 1
    assert await remaining(engine, racer, clock) == 1
