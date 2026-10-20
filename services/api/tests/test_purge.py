import asyncio
import io
import logging
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from radarnaque_api import main as main_module
from radarnaque_api.config import Settings
from radarnaque_api.main import PROJECT_LOGGER, create_app
from radarnaque_api.models import Subscription
from radarnaque_api.purge_cli import main as purge_main
from radarnaque_api.services import purge
from radarnaque_api.services.purge import (
    PURGE_LOCK_KEY,
    purge_forever,
    purge_old_scans,
    retention_cutoff,
)

# Date fixe : « 11 mois et 29 jours » reste après la limite quel que soit le jour réel.
NOW = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)
OLD = datetime(2025, 9, 20, 12, 0, tzinfo=UTC)  # 13 mois
RECENT = datetime(2025, 10, 22, 12, 0, tzinfo=UTC)  # 11 mois et 29 jours


def _raw(pg_url: str) -> str:
    return pg_url.replace("postgresql+psycopg://", "postgresql://", 1)


async def _scalar(db, sql: str, **params):
    return (await db.execute(text(sql), params)).scalar_one()


async def _analysis(db, suffix: str) -> int:
    """Une annonce, un snapshot et une analyse ; renvoie l'identifiant de l'analyse."""
    listing_id = await _scalar(
        db,
        "insert into app.listings(site_id, external_id)"
        " select id, :x from app.sites order by id limit 1 returning id",
        x=f"ext-{suffix}",
    )
    snapshot_id = await _scalar(
        db,
        "insert into app.listing_snapshots(listing_id, content_hash, title, description)"
        " values (:l, :h, 'titre', 'description') returning id",
        l=listing_id,
        h=f"hash-{suffix}",
    )
    return await _scalar(
        db,
        "insert into app.analyses(snapshot_id, model_id, prompt_version_id, rules_version,"
        " input_hash, score)"
        " select :s, k.active_model_id, k.active_prompt_version_id, 1, :h, 10"
        " from app.scan_kinds k where k.code = 'full' returning id",
        s=snapshot_id,
        h=f"input-{suffix}",
    )


async def _event(
    db, uid: str, at: datetime, *, analysis_id: int | None = None, failed: bool = False
) -> int:
    """Un scan_event daté de `at`, réussi (lié à `analysis_id`) ou en échec."""
    event_id = await _scalar(
        db,
        "insert into app.scan_events(user_id, scan_kind, trigger, created_at)"
        " values (:u, 'full', 'button', :at) returning id",
        u=uid,
        at=at,
    )
    if analysis_id is not None:
        await db.execute(
            text("insert into app.scan_results(scan_event_id, analysis_id) values (:e, :a)"),
            {"e": event_id, "a": analysis_id},
        )
    if failed:
        await db.execute(
            text("insert into app.scan_failures(scan_event_id, error_code) values (:e, 'boom')"),
            {"e": event_id},
        )
    await db.commit()
    return event_id


async def _subscription(db, uid: str, plan: str, period_start: datetime) -> None:
    db.add(
        Subscription(
            user_id=uid, plan=plan, status="active", provider="manual", period_start=period_start
        )
    )
    await db.commit()


async def _ids(db, table: str, column: str = "scan_event_id") -> set[int]:
    await db.rollback()  # relire l'état validé
    return set((await db.execute(text(f"select {column} from {table}"))).scalars())


async def _purged_scans(db, uid: str) -> int:
    await db.rollback()
    return await _scalar(db, "select purged_scans from app.subscriptions where user_id = :u", u=uid)


def test_cutoff_calendar_months():
    assert retention_cutoff(datetime(2026, 10, 20, 9, 30, tzinfo=UTC)) == datetime(
        2025, 10, 20, 9, 30, tzinfo=UTC
    )
    assert retention_cutoff(datetime(2028, 2, 29, tzinfo=UTC)) == datetime(2027, 2, 28, tzinfo=UTC)


async def test_purge_old_keeps_recent(app, db, make_user):
    uid = await make_user("old@b.test")
    old_analysis = await _analysis(db, "old")
    recent_analysis = await _analysis(db, "recent")
    old_ok = await _event(db, uid, OLD, analysis_id=old_analysis)
    old_failed = await _event(db, uid, OLD, failed=True)
    recent_ok = await _event(db, uid, RECENT, analysis_id=recent_analysis)
    recent_failed = await _event(db, uid, RECENT, failed=True)
    # Pile à la limite : pas antérieur, donc gardé.
    at_cutoff = await _event(db, uid, retention_cutoff(NOW))
    analyses = await _scalar(db, "select count(*) from app.analyses")
    snapshots = await _scalar(db, "select count(*) from app.listing_snapshots")

    assert await purge_old_scans(app.state.engine, NOW) == 2

    assert await _ids(db, "app.scan_events", "id") == {recent_ok, recent_failed, at_cutoff}
    assert await _ids(db, "app.scan_results") == {recent_ok}
    assert await _ids(db, "app.scan_failures") == {recent_failed}
    assert old_ok not in await _ids(db, "app.scan_results")
    assert old_failed not in await _ids(db, "app.scan_failures")
    assert await _scalar(db, "select count(*) from app.analyses") == analyses
    assert await _scalar(db, "select count(*) from app.listing_snapshots") == snapshots


async def test_purge_batches(app, db, make_user, monkeypatch):
    monkeypatch.setattr(purge, "PURGE_BATCH", 2)
    uid = await make_user("old@b.test")
    for _ in range(5):
        await _event(db, uid, OLD)
    recent = await _event(db, uid, RECENT)

    assert await purge_old_scans(app.state.engine, NOW) == 5

    assert await _ids(db, "app.scan_events", "id") == {recent}
    # Plus rien à purger : une seconde passe ne supprime rien.
    assert await purge_old_scans(app.state.engine, NOW) == 0


async def test_trial_keeps_quota_after_purge(app, client, db, make_user, bearer):
    uid = await make_user("trial@b.test")
    await _subscription(db, uid, "trial", OLD - timedelta(days=30))
    analysis_id = await _analysis(db, "trial")
    for _ in range(3):
        await _event(db, uid, OLD, analysis_id=analysis_id)
    await _event(db, uid, OLD, failed=True)
    before = (await client.get("/api/me", headers=bearer(uid))).json()
    assert before["totalCap"]["used"] == 3

    assert await purge_old_scans(app.state.engine, NOW) == 4

    assert await _purged_scans(db, uid) == 3
    body = (await client.get("/api/me", headers=bearer(uid))).json()
    full = {q["scanKind"]: q for q in body["quotas"]}["full"]
    assert full["remaining"] == 0 and full["used"] == 3
    assert body["totalCap"]["used"] == 3 and body["totalCap"]["remaining"] == 0


async def test_trial_counts_only_scans_since_period_start(app, db, make_user):
    uid = await make_user("trial@b.test")
    await _subscription(db, uid, "trial", OLD)
    await _event(db, uid, OLD - timedelta(days=1))  # avant le début de l'essai
    await _event(db, uid, OLD + timedelta(days=1))

    assert await purge_old_scans(app.state.engine, NOW) == 2

    assert await _purged_scans(db, uid) == 1


async def test_trial_of_other_user_untouched(app, db, make_user):
    old = await make_user("old@b.test")
    other = await make_user("other@b.test")
    await _subscription(db, old, "trial", OLD - timedelta(days=30))
    await _subscription(db, other, "trial", OLD - timedelta(days=30))
    await _event(db, old, OLD)
    await _event(db, other, RECENT)

    assert await purge_old_scans(app.state.engine, NOW) == 1

    assert await _purged_scans(db, old) == 1
    assert await _purged_scans(db, other) == 0


async def test_monthly_subscription_not_counted(app, db, make_user):
    uid = await make_user("std@b.test")
    await _subscription(db, uid, "standard", OLD - timedelta(days=30))
    for _ in range(2):
        await _event(db, uid, OLD)

    assert await purge_old_scans(app.state.engine, NOW) == 2

    assert await _purged_scans(db, uid) == 0


async def test_lock_skips_second_purge(app, db, make_user, pg_url):
    uid = await make_user("old@b.test")
    event_id = await _event(db, uid, OLD)
    with psycopg.connect(_raw(pg_url), autocommit=True) as other:
        other.execute("select pg_advisory_lock(%s)", (PURGE_LOCK_KEY,))
        assert await purge_old_scans(app.state.engine, NOW) is None
        assert await _ids(db, "app.scan_events", "id") == {event_id}
        other.execute("select pg_advisory_unlock(%s)", (PURGE_LOCK_KEY,))
    # Verrou libéré : la passe suivante purge, puis libère le sien.
    assert await purge_old_scans(app.state.engine, NOW) == 1
    with psycopg.connect(_raw(pg_url), autocommit=True) as other:
        assert other.execute("select pg_try_advisory_lock(%s)", (PURGE_LOCK_KEY,)).fetchone() == (
            True,
        )


async def test_purge_logs_count_without_identifier(app, db, make_user, caplog):
    uid = await make_user("old@b.test")
    for _ in range(2):
        await _event(db, uid, OLD)
    with caplog.at_level(logging.INFO, logger="radarnaque.purge"):
        assert await purge_old_scans(app.state.engine, NOW) == 2
    records = [r for r in caplog.records if r.name == "radarnaque.purge"]
    assert [(r.levelno, r.getMessage()) for r in records] == [
        (logging.INFO, "purge des scans : 2 scan_events supprimés")
    ]
    # Le nombre seul : ni identifiant d'utilisateur ni identifiant d'événement.
    assert uid not in caplog.text and "old@b.test" not in caplog.text


def _project_handlers() -> list[logging.Handler]:
    return [
        h
        for h in logging.getLogger(PROJECT_LOGGER).handlers
        if getattr(h, main_module._PROJECT_HANDLER_MARK, False)
    ]


async def test_purge_line_reaches_project_console(app, db, make_user):
    """Sous uvicorn, la racine n'a pas de gestionnaire (seuls les WARNING passent) : la ligne
    INFO doit sortir par le gestionnaire du logger `radarnaque`."""
    uid = await make_user("old@b.test")
    await _event(db, uid, OLD)
    [handler] = _project_handlers()
    assert isinstance(handler, logging.StreamHandler)
    stream = io.StringIO()
    previous = handler.setStream(stream)
    try:
        assert await purge_old_scans(app.state.engine, NOW) == 1
    finally:
        handler.setStream(previous)
    assert "INFO radarnaque.purge purge des scans : 1 scan_events supprimés" in stream.getvalue()


def test_project_console_single_handler_and_no_debug_duplicate(settings):
    create_app(settings)
    create_app(settings)
    assert len(_project_handlers()) == 1
    assert logging.getLogger("radarnaque.purge").getEffectiveLevel() == logging.INFO
    assert logging.getLogger("radarnaque.accounts").getEffectiveLevel() == logging.INFO
    # Le logger de debug garde son propre gestionnaire et ne remonte pas : pas de doublon.
    assert logging.getLogger(main_module.DEBUG_LOGGER).propagate is False


async def test_purge_forever_survives_error(monkeypatch, caplog):
    broken = create_async_engine("postgresql+psycopg://u:secret-pw@127.0.0.1:1/x")
    calls: list[datetime] = []
    second_pass = asyncio.Event()
    real = purge.purge_old_scans

    async def fake(engine, now):
        calls.append(now)
        if len(calls) == 1:
            return await real(broken, now)  # base injoignable : exception
        second_pass.set()
        return 0

    monkeypatch.setattr(purge, "purge_old_scans", fake)
    with caplog.at_level(logging.WARNING, logger="radarnaque.purge"):
        task = asyncio.create_task(
            purge_forever(broken, lambda: NOW, first_delay_s=0, interval_s=0)
        )
        await asyncio.wait_for(second_pass.wait(), timeout=10)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    await broken.dispose()
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and warnings[0].name == "radarnaque.purge"
    assert "secret-pw" not in caplog.text and "127.0.0.1" not in caplog.text
    assert len(calls) >= 2


async def test_purge_forever_waits_first_delay(monkeypatch):
    calls: list[datetime] = []

    async def fake(engine, now):
        calls.append(now)
        return 0

    monkeypatch.setattr(purge, "purge_old_scans", fake)
    task = asyncio.create_task(purge_forever(None, lambda: NOW, first_delay_s=60))  # type: ignore[arg-type]
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls == []


async def test_lifespan_no_purge_when_disabled(app):
    assert app.state.settings.purge_enabled is False
    assert app.state.purge_task is None


async def test_lifespan_starts_and_cancels_purge(settings):
    enabled = Settings.model_validate({**settings.model_dump(), "purge_enabled": True})
    application = create_app(enabled)
    async with application.router.lifespan_context(application):
        task = application.state.purge_task
        assert task is not None and not task.done()
    assert task.cancelled()


@pytest.fixture
def cli_env(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    """Environnement de la commande, lu comme celui de l'API."""
    monkeypatch.setenv("DATABASE_URL", settings.database_url)
    monkeypatch.setenv("JWKS_URL", settings.jwks_url)
    monkeypatch.setenv("JWT_ISSUER", settings.jwt_issuer)
    monkeypatch.setenv("JWT_AUDIENCE", settings.jwt_audience)
    monkeypatch.setenv("INTERNAL_API_SECRET", settings.internal_api_secret.get_secret_value())
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("SEARCH_BACKEND", "none")


def _insert_old_event(pg_url: str) -> None:
    with psycopg.connect(_raw(pg_url), autocommit=True) as conn:
        conn.execute("insert into auth.\"user\"(id, email) values ('u-cli', 'cli@b.test')")
        conn.execute(
            "insert into app.scan_events(user_id, scan_kind, trigger, created_at)"
            " values ('u-cli', 'full', 'button', now() - interval '13 months')"
        )


def test_cli_one_pass(cli_env, pg_url, capsys):
    _insert_old_event(pg_url)
    assert purge_main() == 0
    assert capsys.readouterr().out.strip() == "scan_events supprimés : 1"
    with psycopg.connect(_raw(pg_url)) as conn:
        assert conn.execute("select count(*) from app.scan_events").fetchone() == (0,)


def test_cli_lock_taken(cli_env, pg_url, capsys):
    _insert_old_event(pg_url)
    with psycopg.connect(_raw(pg_url), autocommit=True) as other:
        other.execute("select pg_advisory_lock(%s)", (PURGE_LOCK_KEY,))
        assert purge_main() == 0
        other.execute("select pg_advisory_unlock(%s)", (PURGE_LOCK_KEY,))
    assert capsys.readouterr().out.strip() == "purge déjà en cours ailleurs"
    with psycopg.connect(_raw(pg_url)) as conn:
        assert conn.execute("select count(*) from app.scan_events").fetchone() == (1,)


def test_cli_invalid_config(cli_env, monkeypatch, capsys):
    monkeypatch.delenv("DATABASE_URL")
    assert purge_main() == 2
    err = capsys.readouterr().err
    assert "radarnaque-purge" in err and "database_url" in err
    # Les valeurs lues dans l'environnement ne sont jamais affichées.
    assert "test-internal-secret" not in err
