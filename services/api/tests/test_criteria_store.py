import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest_asyncio
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from radarnaque_api.identify.criteria_store import (
    candidates_key,
    lock_criteria,
    save_criteria,
    valid_criteria,
)
from radarnaque_api.identify.schemas import CriteriaOut, ExpectedValue, ExtractedCriterion
from radarnaque_api.models import Listing, ListingSnapshot
from radarnaque_api.models.identification import (
    CriteriaSet,
    Criterion,
    CriterionSource,
    Identification,
    IdentificationCheck,
    IdentificationObject,
)
from radarnaque_api.pages import PageText

T0 = datetime(2026, 10, 23, 10, 0, tzinfo=UTC)
TTL = timedelta(days=30)
CANDIDATES = ["Steam Deck OLED", "Steam Deck LCD"]
PAGES = [
    PageText("https://a.example/1", "a.example", "Page A", "texte"),
    PageText("https://b.example/2", "b.example", "Page B", "texte"),
]


@pytest_asyncio.fixture
async def engine(pg_url: str) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(pg_url)
    try:
        yield eng
    finally:
        await eng.dispose()


def crit(
    fr: str = "Écran",
    *,
    kind: str = "photo",
    sources: list[int] | None = None,
    candidate: str = "Steam Deck OLED",
) -> ExtractedCriterion:
    return ExtractedCriterion(
        kind=kind,  # type: ignore[arg-type]
        decisive=True,
        fr=fr,
        nl=f"{fr} nl",
        expected=[ExpectedValue(candidate=candidate, fr="oui", nl="ja")],
        sources=sources or [1],
    )


async def save(
    maker: async_sessionmaker[AsyncSession], *criteria: ExtractedCriterion, at: datetime = T0
):
    async with maker() as session, session.begin():
        return await save_criteria(
            session,
            candidates_key(CANDIDATES),
            CANDIDATES,
            CriteriaOut.model_construct(criteria=list(criteria)),
            PAGES,
            at,
        )


def test_candidates_key_is_order_and_accent_insensitive() -> None:
    a = candidates_key(["Steam Deck OLED", "steam deck lcd"])
    b = candidates_key(["Steam  Deck LCD", "Steam Deck OLÉD", "steam deck lcd"])
    assert a == b == "steam deck lcd | steam deck oled"


async def test_save_then_valid_criteria_round_trip(engine: AsyncEngine) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    saved = await save(maker, crit("Écran", sources=[1, 2]), crit("Port", kind="ask_seller"))
    async with maker() as session:
        view = await valid_criteria(session, candidates_key(CANDIDATES), T0, TTL)
    assert view == saved
    assert view is not None and view.status == "auto"
    first, second = view.criteria
    assert (first.position, first.kind, first.fr, first.nl) == (0, "photo", "Écran", "Écran nl")
    assert first.expected == {"Steam Deck OLED": {"fr": "oui", "nl": "ja"}}
    assert first.sources == (
        ("https://a.example/1", "Page A", "a.example"),
        ("https://b.example/2", "Page B", "b.example"),
    )
    assert not first.single_source and second.single_source
    assert second.kind == "ask_seller"


async def test_invisible_and_unsourced_criteria_are_dropped(engine: AsyncEngine) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    view = await save(
        maker,
        crit("garde"),
        crit("invisible", kind="invisible"),
        crit("snippet", sources=[3]),  # numéro hors des pages
        crit("autre produit", candidate="Switch OLED"),
        *[crit(f"c{i}") for i in range(10)],
    )
    assert [c.fr for c in view.criteria] == ["garde", *[f"c{i}" for i in range(7)]]


async def test_expired_set_is_not_valid_but_verified_never_expires(engine: AsyncEngine) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    await save(maker, crit())
    key = candidates_key(CANDIDATES)
    async with maker() as session, session.begin():
        assert await valid_criteria(session, key, T0 + TTL - timedelta(seconds=1), TTL)
        assert await valid_criteria(session, key, T0 + TTL, TTL) is None
        assert await valid_criteria(session, "inconnu", T0, TTL) is None
        row = await session.scalar(select(CriteriaSet))
        assert row is not None
        row.status = "verified"
    async with maker() as session:
        view = await valid_criteria(session, key, T0 + TTL * 10, TTL)
    assert view is not None and view.status == "verified"


async def test_refresh_replaces_criteria_and_sources_keeps_auto_status(
    engine: AsyncEngine,
) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    first = await save(maker, crit("ancien", sources=[1, 2]))
    later = T0 + timedelta(days=40)
    second = await save(maker, crit("nouveau 1"), crit("nouveau 2"), at=later)
    assert second.id == first.id and second.status == "auto"
    assert [c.fr for c in second.criteria] == ["nouveau 1", "nouveau 2"]
    async with maker() as session:
        assert await session.scalar(select(func.count()).select_from(CriteriaSet)) == 1
        assert await session.scalar(select(func.count()).select_from(Criterion)) == 2
        assert await session.scalar(select(func.count()).select_from(CriterionSource)) == 2
        assert (await session.scalar(select(CriteriaSet.refreshed_at))) == later


async def test_verified_set_is_not_replaced(engine: AsyncEngine) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    first = await save(maker, crit("relu"))
    async with maker() as session, session.begin():
        row = await session.scalar(select(CriteriaSet))
        assert row is not None
        row.status = "verified"
    later = T0 + timedelta(days=40)
    second = await save(maker, crit("nouveau"), at=later)
    assert second.status == "verified"
    assert second.criteria == first.criteria and second.id == first.id
    async with maker() as session:
        assert (await session.scalar(select(CriteriaSet.refreshed_at))) == T0


async def test_mixed_sources_keep_only_pages(engine: AsyncEngine) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    one_page = PAGES[:1]
    async with maker() as session, session.begin():
        view = await save_criteria(
            session,
            candidates_key(CANDIDATES),
            CANDIDATES,
            CriteriaOut(criteria=[crit(sources=[1, 3])]),
            one_page,
            T0,
        )
    assert view.criteria[0].sources == (("https://a.example/1", "Page A", "a.example"),)


async def test_deleting_criterion_keeps_identification_check(engine: AsyncEngine) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    view = await save(maker, crit("Écran"))
    async with maker() as session, session.begin():
        site_id = await session.scalar(text("select id from app.sites limit 1"))
        listing = Listing(site_id=site_id, external_id="x")
        session.add(listing)
        await session.flush()
        snapshot = ListingSnapshot(
            listing_id=listing.id, content_hash="h", title="t", description="d"
        )
        session.add(snapshot)
        await session.flush()
        ident = Identification(
            snapshot_id=snapshot.id,
            config_hash="c",
            input_hash="h",
            status="identified",
            confidence=50,
        )
        session.add(ident)
        await session.flush()
        obj = IdentificationObject(
            identification_id=ident.id,
            position=0,
            role="main",
            label="x",
            confidence=50,
            criteria_set_id=view.id,
        )
        session.add(obj)
        await session.flush()
        session.add(
            IdentificationCheck(
                object_id=obj.id,
                position=0,
                criterion_id=view.criteria[0].id,
                text_fr="Écran",
                text_nl="Écran nl",
                decisive=True,
                sources=[{"url": "https://a.example/1", "title": "Page A", "domain": "a.example"}],
                observation="seen_match",
                photo_index=1,
            )
        )
    async with maker() as session, session.begin():
        await session.execute(delete(Criterion))
    async with maker() as session:
        check = await session.scalar(select(IdentificationCheck))
    assert check is not None and check.criterion_id is None
    assert (check.text_fr, check.text_nl, check.decisive) == ("Écran", "Écran nl", True)
    assert check.sources[0]["domain"] == "a.example"


async def test_lock_serializes_two_sessions(engine: AsyncEngine) -> None:
    maker = async_sessionmaker(engine)
    key = candidates_key(CANDIDATES)
    events: list[str] = []
    async with maker() as one, one.begin():
        await lock_criteria(one, key)

        async def second() -> None:
            async with maker() as two, two.begin():
                await lock_criteria(two, key)
                events.append("second")

        task = asyncio.create_task(second())
        await asyncio.sleep(0.5)
        assert events == [] and not task.done()
        events.append("first")
    await asyncio.wait_for(task, 5)
    assert events == ["first", "second"]
