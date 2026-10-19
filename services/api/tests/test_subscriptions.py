import asyncio
from datetime import UTC, datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from radarnaque_api.models import Subscription
from radarnaque_api.services.subscriptions import bootstrap_trial, get_active_subscription
from radarnaque_api.services.usage import compute_usage


def _utc(year: int, month: int, day: int, hour: int = 0) -> datetime:
    return datetime(year, month, day, hour, tzinfo=UTC)


async def _add_sub(
    db: AsyncSession, uid: str, plan: str, status: str, period_start: datetime
) -> Subscription:
    sub = Subscription(
        user_id=uid, plan=plan, status=status, provider="manual", period_start=period_start
    )
    db.add(sub)
    await db.commit()
    return sub


async def _add_event(
    db: AsyncSession, uid: str, kind: str, at: datetime, *, failed: bool = False
) -> None:
    event_id = (
        await db.execute(
            text(
                "insert into app.scan_events(user_id, scan_kind, trigger, created_at) "
                "values (:u, :k, 'button', :t) returning id"
            ),
            {"u": uid, "k": kind, "t": at},
        )
    ).scalar_one()
    if failed:
        await db.execute(
            text("insert into app.scan_failures(scan_event_id, error_code) values (:e, 'boom')"),
            {"e": event_id},
        )
    await db.commit()


async def test_bootstrap_creates_trial_once(db, make_user):
    uid = await make_user("a@b.test")
    assert await bootstrap_trial(db, uid) is True
    assert await bootstrap_trial(db, uid) is False
    await db.commit()
    sub = await get_active_subscription(db, uid)
    assert sub is not None
    assert (sub.plan, sub.status, sub.provider) == ("trial", "active", "manual")
    count = (await db.execute(select(Subscription).where(Subscription.user_id == uid))).all()
    assert len(count) == 1


async def test_bootstrap_skips_user_with_canceled_sub(db, make_user):
    uid = await make_user("a@b.test")
    await _add_sub(db, uid, "standard", "canceled", _utc(2026, 1, 1))
    assert await bootstrap_trial(db, uid) is False
    await db.commit()
    rows = (await db.execute(select(Subscription).where(Subscription.user_id == uid))).all()
    assert len(rows) == 1
    assert await get_active_subscription(db, uid) is None


async def test_bootstrap_concurrent_calls_single_row(pg_url, make_user):
    uid = await make_user("a@b.test")
    engine = create_async_engine(pg_url)
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def _call() -> bool:
        async with maker() as session:
            created = await bootstrap_trial(session, uid)
            await session.commit()
            return created

    try:
        results = await asyncio.gather(*(_call() for _ in range(10)))
        async with maker() as session:
            active = (
                await session.execute(
                    select(Subscription).where(
                        Subscription.user_id == uid, Subscription.status == "active"
                    )
                )
            ).all()
    finally:
        await engine.dispose()
    assert results.count(True) == 1
    assert len(active) == 1


async def test_usage_trial_shared_cap(db, make_user):
    uid = await make_user("a@b.test")
    now = _utc(2026, 3, 10)
    sub = await _add_sub(db, uid, "trial", "active", _utc(2026, 3, 1))
    await _add_event(db, uid, "full", _utc(2026, 3, 2))
    await _add_event(db, uid, "full", _utc(2026, 3, 3), failed=True)
    await _add_event(db, uid, "full", _utc(2026, 3, 4))
    usage = await compute_usage(db, sub, now)
    assert usage.period_start == sub.period_start
    assert list(usage.per_kind) == ["full"]
    assert (usage.per_kind["full"].used, usage.per_kind["full"].remaining) == (2, 1)
    assert usage.total is not None
    assert (usage.total.limit, usage.total.used, usage.total.remaining) == (3, 2, 1)
    # Le plafond global borne aussi le reste du type.
    await _add_event(db, uid, "full", _utc(2026, 3, 5))
    usage = await compute_usage(db, sub, now)
    assert usage.total is not None and usage.total.remaining == 0
    assert usage.per_kind["full"].remaining == 0


async def test_usage_standard_monthly_window(db, make_user):
    uid = await make_user("a@b.test")
    sub = await _add_sub(db, uid, "standard", "active", _utc(2026, 1, 31))
    await _add_event(db, uid, "full", _utc(2026, 2, 27))
    await _add_event(db, uid, "full", _utc(2026, 3, 1))
    usage = await compute_usage(db, sub, _utc(2026, 3, 10))
    assert usage.period_start == _utc(2026, 2, 28)
    assert usage.total is None
    assert usage.per_kind["full"].used == 1
    assert usage.per_kind["full"].remaining == 149
    assert list(usage.per_kind) == ["full"]
