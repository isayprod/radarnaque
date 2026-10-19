import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from alembic import command


async def test_seeded_offer(db):
    q = await db.execute(
        text("select plan, scan_kind, quota from app.plan_quotas order by plan, scan_kind")
    )
    assert q.all() == [
        ("premium", "full", 300),
        ("standard", "full", 150),
        ("trial", "full", 3),
    ]
    caps = dict((await db.execute(text("select code, total_scan_cap from app.plans"))).all())
    assert caps == {"trial": 3, "standard": None, "premium": None}
    periods = dict((await db.execute(text("select code, quota_period from app.plans"))).all())
    assert periods == {
        "trial": "lifetime",
        "standard": "subscription_month",
        "premium": "subscription_month",
    }
    prices = (
        await db.execute(
            text("select plan, interval, currency, amount_cents from app.plan_prices order by 1,2")
        )
    ).all()
    assert prices == [
        ("premium", "month", "EUR", 699),
        ("premium", "year", "EUR", 6900),
        ("standard", "month", "EUR", 299),
        ("standard", "year", "EUR", 2900),
    ]
    feats = (
        await db.execute(text("select plan, feature from app.plan_features order by 1,2"))
    ).all()
    assert feats == [
        ("premium", "card_icons"),
        ("trial", "card_icons"),
    ]


async def test_seeded_reference_data(db):
    async def codes(table: str) -> set[str]:
        return {r[0] for r in (await db.execute(text(f"select code from app.{table}"))).all()}

    assert await codes("billing_intervals") == {"month", "year"}
    assert await codes("currencies") == {"EUR"}
    assert await codes("features") == {"card_icons"}
    assert await codes("quota_periods") == {"subscription_month", "lifetime"}
    assert await codes("subscription_statuses") == {"active", "canceled", "past_due", "expired"}
    assert await codes("billing_providers") == {"manual", "stripe"}
    assert await codes("scan_triggers") == {"button", "card"}
    kinds = (
        await db.execute(
            text(
                "select k.code, m.provider, m.slug from app.scan_kinds k"
                " join app.models m on m.id = k.active_model_id order by k.code"
            )
        )
    ).all()
    assert kinds == [
        ("full", "openrouter", "google/gemini-3.1-flash-lite"),
        ("image", "openrouter", "google/gemini-3.1-flash-lite"),
        ("text", "openrouter", "google/gemini-2.5-flash-lite"),
    ]


async def test_one_active_subscription_per_user(db, make_user):
    uid = await make_user("a@x.be")
    ins = text(
        "insert into app.subscriptions(user_id, plan, status, provider, period_start, created_at)"
        " values (:u,'trial','active','manual',now(),now())"
    )
    await db.execute(ins, {"u": uid})
    with pytest.raises(IntegrityError):
        await db.execute(ins, {"u": uid})


async def test_inactive_subscriptions_may_coexist_with_an_active_one(db, make_user):
    uid = await make_user("a@x.be")  # même email que le test précédent : vérifie le nettoyage
    ins = text(
        "insert into app.subscriptions(user_id, plan, status, provider, period_start)"
        " values (:u,'trial',:s,'manual',now())"
    )
    for status in ("active", "expired", "canceled"):
        await db.execute(ins, {"u": uid, "s": status})
    count = (
        await db.execute(
            text("select count(*) from app.subscriptions where user_id = :u"), {"u": uid}
        )
    ).scalar_one()
    assert count == 3


async def test_deleting_user_cascades(db, make_user):
    uid = await make_user("c@x.be")
    await db.execute(
        text(
            "insert into app.subscriptions(user_id, plan, status, provider, period_start)"
            " values (:u,'trial','active','manual',now())"
        ),
        {"u": uid},
    )
    ev = (
        await db.execute(
            text(
                "insert into app.scan_events(user_id, scan_kind, trigger)"
                " values (:u,'text','button') returning id"
            ),
            {"u": uid},
        )
    ).scalar_one()
    await db.execute(
        text("insert into app.scan_failures(scan_event_id, error_code) values (:e,'llm_timeout')"),
        {"e": ev},
    )
    await db.execute(text('delete from auth."user" where id = :u'), {"u": uid})
    for table in ("subscriptions", "scan_events", "scan_failures"):
        assert (await db.execute(text(f"select count(*) from app.{table}"))).scalar_one() == 0


def test_downgrade_then_upgrade(alembic_config):
    command.downgrade(alembic_config, "base")
    command.upgrade(alembic_config, "head")


def test_models_match_migration(alembic_config, pg_url):
    """La migration écrite à la main ne doit pas diverger des modèles ORM."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlalchemy import create_engine

    from radarnaque_api.models import Base

    engine = create_engine(pg_url)
    try:
        with engine.connect() as conn:
            ctx = MigrationContext.configure(
                conn,
                opts={
                    "include_schemas": True,
                    "include_object": lambda obj, name, type_, reflected, compare_to: (
                        getattr(obj, "schema", None) == "app" and name != "alembic_version"
                        if type_ == "table"
                        else True
                    ),
                    "version_table_schema": "app",
                },
            )
            diff = compare_metadata(ctx, Base.metadata)
    finally:
        engine.dispose()
    assert diff == []
