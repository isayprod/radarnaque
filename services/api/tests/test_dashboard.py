"""Tableau de bord de l'admin : agrégats sur des jours civils de Bruxelles, coûts lus dans
`llm_calls`, abonnés, projection du mois et santé du service."""

import json
from datetime import UTC, date, datetime

import httpx
import pytest
from sqlalchemy import text

from radarnaque_api.services.ai_probes import SearchHealth
from radarnaque_api.services.dashboard import BRUSSELS, daily, dashboard

ADMIN_EMAIL = "admin@radarnaque.test"
# 12 h à Bruxelles (heure d'été) : « aujourd'hui » commence le 20 à 22 h UTC.
NOW = datetime(2026, 10, 21, 10, 0, tzinfo=UTC)


@pytest.fixture
async def admin(make_user) -> str:
    return await make_user(ADMIN_EMAIL, "admin")


@pytest.fixture
async def user(make_user) -> str:
    return await make_user("scanneur@radarnaque.test")


async def _scalar(db, sql: str, **params):
    return (await db.execute(text(sql), params)).scalar_one()


@pytest.fixture
async def analysis(db) -> int:
    """Une annonce, un snapshot et une analyse ; renvoie l'identifiant de l'analyse."""
    listing_id = await _scalar(
        db,
        "insert into app.listings(site_id, external_id)"
        " select id, 'ext-dash' from app.sites order by id limit 1 returning id",
    )
    snapshot_id = await _scalar(
        db,
        "insert into app.listing_snapshots(listing_id, content_hash, title, description)"
        " values (:l, 'hash-dash', 'titre', 'description') returning id",
        l=listing_id,
    )
    analysis_id = await _scalar(
        db,
        "insert into app.analyses(snapshot_id, model_id, prompt_version_id, rules_version,"
        " input_hash, score)"
        " select :s, k.active_model_id, k.active_prompt_version_id, 1, 'input-dash', 10"
        " from app.scan_kinds k where k.code = 'full' returning id",
        s=snapshot_id,
    )
    await db.commit()
    return analysis_id


async def _event(
    db,
    uid: str,
    at: datetime,
    analysis_id: int | None = None,
    *,
    failure: str | None = None,
    call: int | None = None,
    web: int = 0,
) -> int:
    """Un scan_event daté de `at`. `analysis_id` : il a un résultat ; `failure` : il a une ligne
    d'échec ; `call` : coût en micro-dollars de l'appel au modèle qu'il a produit (même date)."""
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
    if failure is not None:
        await db.execute(
            text("insert into app.scan_failures(scan_event_id, error_code) values (:e, :c)"),
            {"e": event_id, "c": failure},
        )
    if call is not None:
        assert analysis_id is not None
        await _call(db, analysis_id, at, call, web)
    await db.commit()
    return event_id


async def _call(db, analysis_id: int, at: datetime, cost: int, web: int = 0) -> None:
    await db.execute(
        text(
            "insert into app.llm_calls(created_at, analysis_id, model_id, prompt_version_id,"
            " cost_usd_micros, web_searches)"
            " select :at, a.id, a.model_id, a.prompt_version_id, :c, :w"
            " from app.analyses a where a.id = :a"
        ),
        {"at": at, "a": analysis_id, "c": cost, "w": web},
    )
    await db.commit()


def _search(app, health_status: int | None):
    """Remplace le moteur de recherche de l'application : joignable (200), en échec (503) ou
    désactivé (None)."""
    settings = app.state.settings
    if health_status is None:
        return settings.model_copy(update={"search_backend": "none"}), None
    http = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(health_status)))
    return (
        settings.model_copy(
            update={"search_backend": "searxng", "searxng_url": "http://searx.test:8080"}
        ),
        SearchHealth(http, "http://searx.test:8080"),
    )


async def _dashboard(db, app, now: datetime = NOW):
    return await dashboard(
        db,
        now,
        settings=app.state.settings,
        health=app.state.search_health,
        search=app.state.search,
    )


# --- Cartes : aujourd'hui et 7 jours ---------------------------------------------------------


async def test_stats_today_and_7_days(app, db, user, analysis):
    today = datetime(2026, 10, 21, 7, 0, tzinfo=UTC)
    await _event(db, user, today, analysis, call=2_000_000, web=2)  # réussi, appel
    await _event(db, user, today, analysis)  # réussi, servi depuis le cache
    await _event(db, user, today, analysis, call=1_000_000, web=1)  # réussi, appel
    await _event(db, user, today, analysis, failure="timeout")  # a un résultat : réussi
    await _event(db, user, today, failure="timeout")
    await _event(db, user, today, failure="timeout")
    await _event(db, user, today, failure="rate")
    await _event(db, user, today, failure="alpha")
    await _event(db, user, today, failure="zeta")
    # Le 15 à 00 h 30 à Bruxelles : premier jour des 7 jours ; la veille ne compte pas.
    await _event(db, user, datetime(2026, 10, 14, 22, 30, tzinfo=UTC), analysis, call=500_000)
    await _event(
        db, user, datetime(2026, 10, 14, 21, 30, tzinfo=UTC), analysis, call=9_000_000, web=7
    )

    data = await _dashboard(db, app)

    t = data.today
    assert (t.scans, t.llm_calls) == (9, 2)
    assert t.from_cache_pct == pytest.approx(50.0)  # (4 réussis - 2 appels) / 4
    assert t.failed_pct == pytest.approx(5 / 9 * 100)  # le scan avec résultat n'est pas un échec
    assert [(f.code, f.count) for f in t.top_failures] == [
        ("timeout", 2),
        ("alpha", 1),
        ("rate", 1),
    ]
    assert t.cost_usd == pytest.approx(3.0)
    assert t.avg_cost_usd == pytest.approx(1.5)
    assert (t.web_searches, t.avg_web_searches) == (3, 1.5)

    w = data.last_7_days
    assert (w.scans, w.llm_calls) == (10, 3)
    assert w.from_cache_pct == pytest.approx(40.0)  # (5 - 3) / 5
    assert w.failed_pct == pytest.approx(50.0)
    assert [(f.code, f.count) for f in w.top_failures] == [
        ("timeout", 2),
        ("alpha", 1),
        ("rate", 1),
    ]
    assert w.cost_usd == pytest.approx(3.5)
    assert w.avg_cost_usd == pytest.approx(3.5 / 3)
    assert (w.web_searches, w.avg_web_searches) == (3, 1.0)


async def test_from_cache_is_never_negative(app, db, user, analysis):
    # Un appel de plus que de scans réussis (un appel dont le scan a échoué ensuite).
    await _event(db, user, NOW, analysis, call=1_000_000)
    await _call(db, analysis, NOW, 1_000_000)
    assert (await _dashboard(db, app)).today.from_cache_pct == 0.0


async def test_refresh_counts_two_calls(db, user, analysis):
    """Appelée le 18, servie le 19, rafraîchie le 20 : deux appels, un scan servi du cache."""
    await _event(db, user, datetime(2026, 10, 18, 10, 0, tzinfo=UTC), analysis, call=1_500_000)
    await _event(db, user, datetime(2026, 10, 19, 10, 0, tzinfo=UTC), analysis)
    await _event(db, user, datetime(2026, 10, 20, 10, 0, tzinfo=UTC), analysis, call=2_500_000)

    points = (await daily(db, datetime(2026, 10, 21, 8, 0, tzinfo=UTC), 4)).points

    by_day = {p.date: p for p in points}
    assert (by_day[date(2026, 10, 18)].llm, by_day[date(2026, 10, 18)].from_cache) == (1, 0)
    assert by_day[date(2026, 10, 18)].cost_usd == pytest.approx(1.5)
    assert (by_day[date(2026, 10, 19)].llm, by_day[date(2026, 10, 19)].from_cache) == (0, 1)
    assert by_day[date(2026, 10, 19)].cost_usd == 0
    assert (by_day[date(2026, 10, 20)].llm, by_day[date(2026, 10, 20)].from_cache) == (1, 0)
    assert by_day[date(2026, 10, 20)].cost_usd == pytest.approx(2.5)
    assert by_day[date(2026, 10, 21)].llm == 0


async def test_daily_counts_failures_apart(db, user, analysis):
    at = datetime(2026, 10, 21, 7, 0, tzinfo=UTC)
    await _event(db, user, at, analysis, call=1_000_000)
    await _event(db, user, at, failure="timeout")
    await _event(db, user, at, analysis, failure="timeout")  # a un résultat : pas un échec
    (point,) = (await daily(db, NOW, 1)).points
    assert (point.from_cache, point.llm, point.failed) == (1, 1, 1)


# --- Fuseau ----------------------------------------------------------------------------------


async def test_brussels_day_boundary(db, user, analysis):
    # 23 h 30 UTC le 20 octobre = 1 h 30 le 21 à Bruxelles ; 21 h 59 UTC reste le 20.
    await _event(db, user, datetime(2026, 10, 20, 23, 30, tzinfo=UTC), analysis, call=1_000_000)
    await _event(db, user, datetime(2026, 10, 20, 21, 59, tzinfo=UTC), analysis)

    by_day = {p.date: p for p in (await daily(db, NOW, 2)).points}

    assert (by_day[date(2026, 10, 21)].llm, by_day[date(2026, 10, 21)].from_cache) == (1, 0)
    assert (by_day[date(2026, 10, 20)].llm, by_day[date(2026, 10, 20)].from_cache) == (0, 1)


async def test_today_starts_at_brussels_midnight(app, db, user, analysis):
    await _event(db, user, datetime(2026, 10, 20, 21, 59, tzinfo=UTC), analysis)  # le 20
    await _event(db, user, datetime(2026, 10, 20, 22, 0, tzinfo=UTC), analysis)  # le 21, 0 h
    data = await _dashboard(db, app)
    assert (data.today.scans, data.last_7_days.scans) == (1, 2)


async def test_dst_day(db, user, analysis):
    """Le 25 octobre 2026 dure 25 h à Bruxelles : fin de l'heure d'été à 3 h → 2 h."""
    first = datetime(2026, 10, 24, 22, 30, tzinfo=UTC)  # 0 h 30 le 25 (CEST)
    last = datetime(2026, 10, 25, 22, 30, tzinfo=UTC)  # 23 h 30 le 25 (CET)
    next_day = datetime(2026, 10, 25, 23, 30, tzinfo=UTC)  # 0 h 30 le 26
    for at in (first, last):
        await _event(db, user, at, analysis, call=1_000_000)
    await _event(db, user, next_day, analysis)

    points = (await daily(db, datetime(2026, 10, 27, 10, 0, tzinfo=UTC), 5)).points

    assert [p.date for p in points] == [date(2026, 10, d) for d in (23, 24, 25, 26, 27)]
    assert [p.llm for p in points] == [0, 0, 2, 0, 0]
    assert [p.from_cache for p in points] == [0, 0, 0, 1, 0]


# --- Période sans scan -----------------------------------------------------------------------


async def test_empty_period(app, db):
    data = await _dashboard(db, app)

    for stats in (data.today, data.last_7_days):
        assert (stats.scans, stats.llm_calls, stats.web_searches) == (0, 0, 0)
        assert stats.cost_usd == 0
        assert stats.from_cache_pct is None and stats.failed_pct is None
        assert stats.avg_cost_usd is None and stats.avg_web_searches is None
        assert stats.top_failures == []
    assert data.month.cost_usd == 0
    assert (data.subscribers.trial, data.subscribers.standard, data.subscribers.premium) == (
        0,
        0,
        0,
    )
    assert data.subscribers.new_accounts_7_days == 0
    assert data.health.last_purge is None

    points = (await daily(db, NOW, 30)).points
    assert len(points) == 30
    assert points[-1].date == date(2026, 10, 21) and points[0].date == date(2026, 9, 22)
    assert all((p.from_cache, p.llm, p.failed, p.cost_usd) == (0, 0, 0, 0) for p in points)


async def test_just_after_midnight_has_no_division_by_zero(app, db, user, analysis):
    # 00 h 05 à Bruxelles, rien depuis minuit : le jour est vide, la semaine non.
    await _event(db, user, datetime(2026, 10, 20, 12, 0, tzinfo=UTC), analysis, call=1_000_000)
    now = datetime(2026, 10, 20, 22, 5, tzinfo=UTC)
    data = await _dashboard(db, app, now)
    assert data.today.scans == 0 and data.today.from_cache_pct is None
    assert data.today.failed_pct is None and data.today.avg_cost_usd is None
    assert data.last_7_days.scans == 1 and data.last_7_days.from_cache_pct == 0.0


# --- Mois en cours ---------------------------------------------------------------------------


async def test_month_projection(app, db, user, analysis):
    await _call(db, analysis, datetime(2026, 9, 30, 21, 0, tzinfo=UTC), 9_000_000)  # septembre
    await _call(db, analysis, datetime(2026, 10, 3, 9, 0, tzinfo=UTC), 2_000_000)
    await _call(db, analysis, datetime(2026, 10, 21, 7, 0, tzinfo=UTC), 1_000_000)

    month = (await _dashboard(db, app)).month

    # Octobre à Bruxelles : du 30/09 à 22 h UTC au 31/10 à 23 h UTC, soit 745 h (le 25 dure
    # 25 h) ; 492 h écoulées à `NOW`.
    assert month.cost_usd == pytest.approx(3.0)
    assert month.projected_usd == pytest.approx(3.0 * 745 / 492)


async def test_month_projection_waits_24_hours(app, db, user, analysis):
    # Le mois de novembre commence le 31/10 à 23 h UTC.
    await _call(db, analysis, datetime(2026, 11, 1, 1, 0, tzinfo=UTC), 2_000_000)

    early = (await _dashboard(db, app, datetime(2026, 11, 1, 5, 0, tzinfo=UTC))).month
    assert early.cost_usd == pytest.approx(2.0)
    assert early.projected_usd is None

    just_before = (await _dashboard(db, app, datetime(2026, 11, 1, 22, 59, tzinfo=UTC))).month
    assert just_before.projected_usd is None
    at_24h = (await _dashboard(db, app, datetime(2026, 11, 1, 23, 0, tzinfo=UTC))).month
    assert at_24h.projected_usd == pytest.approx(2.0 * 720 / 24)  # novembre : 720 h


# --- Abonnés ---------------------------------------------------------------------------------


async def _subscribe(db, uid: str, plan: str, status: str = "active") -> None:
    await db.execute(
        text(
            "insert into app.subscriptions(user_id, plan, status, provider, period_start)"
            " values (:u, :p, :s, 'manual', now())"
        ),
        {"u": uid, "p": plan, "s": status},
    )
    await db.commit()


async def _created(db, uid: str, at: datetime) -> None:
    await db.execute(
        text('update auth."user" set "createdAt" = :at where id = :u'), {"at": at, "u": uid}
    )
    await db.commit()


async def test_subscribers(app, db, make_user):
    # Les 7 jours civils qui finissent le 21 commencent le 15 à 0 h, soit le 14 à 22 h UTC.
    created = {
        "trial": datetime(2026, 10, 14, 22, 0, tzinfo=UTC),  # compte
        "standard1": datetime(2026, 10, 21, 8, 0, tzinfo=UTC),  # compte
        "standard2": datetime(2026, 10, 14, 21, 59, tzinfo=UTC),  # trop ancien
        "premium": datetime(2026, 1, 1, tzinfo=UTC),  # trop ancien
        "expired": datetime(2026, 10, 20, tzinfo=UTC),  # compte, mais abonnement échu
        "future": datetime(2026, 10, 21, 10, 1, tzinfo=UTC),  # après `NOW`
    }
    ids = {}
    for name, at in created.items():
        ids[name] = await make_user(f"{name}@radarnaque.test")
        await _created(db, ids[name], at)
    await _subscribe(db, ids["trial"], "trial")
    await _subscribe(db, ids["standard1"], "standard")
    await _subscribe(db, ids["standard2"], "standard")
    await _subscribe(db, ids["premium"], "premium")
    await _subscribe(db, ids["expired"], "standard", "expired")

    subscribers = (await _dashboard(db, app)).subscribers

    assert (subscribers.trial, subscribers.standard, subscribers.premium) == (1, 2, 1)
    assert subscribers.new_accounts_7_days == 3


# --- Santé -----------------------------------------------------------------------------------


async def test_health_search_states(app, db):
    for status, expected in ((200, "ok"), (503, "down"), (None, "disabled")):
        settings, health = _search(app, status)
        data = await dashboard(db, NOW, settings=settings, health=health, search=None)
        assert data.health.search.status == expected
        assert data.health.search.backend == ("none" if status is None else "searxng")


async def test_health_active_model_and_purge(app, db):
    row = (
        await db.execute(
            text(
                "select m.provider, m.slug from app.scan_kinds k"
                " join app.models m on m.id = k.active_model_id where k.code = 'full'"
            )
        )
    ).one()
    data = await _dashboard(db, app)
    assert (data.health.active_model.provider, data.health.active_model.slug) == tuple(row)
    assert data.health.last_purge is None

    for at, deleted in (
        (datetime(2026, 10, 1, 3, 0, tzinfo=UTC), 4),
        (datetime(2026, 10, 20, 3, 0, tzinfo=UTC), 12),
    ):
        await db.execute(
            text(
                "insert into app.admin_actions(action, details, created_at)"
                " values ('system.purge', cast(:d as jsonb), :at)"
            ),
            {
                "d": json.dumps(
                    {"deletedScans": deleted, "deletedActions": 0, "deletedLlmCalls": 0}
                ),
                "at": at,
            },
        )
    await db.commit()
    purge = (await _dashboard(db, app)).health.last_purge
    assert purge.at == datetime(2026, 10, 20, 3, 0, tzinfo=UTC)
    assert purge.deleted_scans == 12


async def test_calls_without_analysis_count_in_calls_and_cost(
    client, bearer, admin, db, user, analysis
):
    now = datetime.now(UTC)
    snapshot_id = await _scalar(
        db, "select snapshot_id from app.analyses where id = :a", a=analysis
    )
    ident = await _scalar(
        db,
        "insert into app.identifications(snapshot_id, config_hash, input_hash, status, confidence)"
        " values (:s, 'c', 'i', 'identified', 90) returning id",
        s=snapshot_id,
    )
    for cost in (300_000, 700_000):
        await db.execute(
            text(
                "insert into app.llm_calls(created_at, step, identification_id, model_id,"
                " prompt_version_id, cost_usd_micros)"
                " select :at, 'read_photos', :i, k.active_model_id, k.active_prompt_version_id,"
                " :c from app.scan_kinds k where k.code = 'full'"
            ),
            {"at": now, "i": ident, "c": cost},
        )
    await db.commit()

    await _call(db, analysis, now, 0)  # l'appel de l'analyse, lui, reste seul dans son détail

    before = (await client.get(f"/api/admin/analyses/{analysis}", headers=bearer(admin))).json()
    body = (await client.get("/api/admin/dashboard", headers=bearer(admin))).json()
    after = (await client.get(f"/api/admin/analyses/{analysis}", headers=bearer(admin))).json()

    assert body["today"]["llmCalls"] == 3
    assert body["today"]["costUsd"] == pytest.approx(1.0)
    assert before == after
    assert len(before["technical"]["calls"]) == 1


# --- Routes ----------------------------------------------------------------------------------


async def test_routes_return_camel_case_shape(client, bearer, admin, db, user, analysis):
    await _event(db, user, datetime.now(UTC), analysis, call=1_000_000, web=1)
    r = await client.get("/api/admin/dashboard", headers=bearer(admin))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"today", "last7Days", "subscribers", "month", "health"}
    assert set(body["today"]) == {
        "scans",
        "llmCalls",
        "fromCachePct",
        "failedPct",
        "topFailures",
        "costUsd",
        "avgCostUsd",
        "webSearches",
        "avgWebSearches",
    }
    assert set(body["subscribers"]) == {"trial", "standard", "premium", "newAccounts7Days"}
    assert set(body["month"]) == {"costUsd", "projectedUsd"}
    assert set(body["health"]) == {"activeModel", "search", "lastPurge"}
    assert body["today"]["llmCalls"] == 1

    r = await client.get("/api/admin/dashboard/daily", headers=bearer(admin))
    assert r.status_code == 200, r.text
    points = r.json()["points"]
    assert len(points) == 30  # 30 jours par défaut
    assert set(points[0]) == {"date", "fromCache", "llm", "failed", "costUsd"}
    assert points[-1]["date"] == datetime.now(BRUSSELS).date().isoformat()


async def test_days_bounds(client, bearer, admin):
    for days in (0, 91, -1):
        r = await client.get(f"/api/admin/dashboard/daily?days={days}", headers=bearer(admin))
        assert r.status_code == 422, days
        assert r.json()["error"]["code"] == "invalid_request"
    for days in (1, 90):
        r = await client.get(f"/api/admin/dashboard/daily?days={days}", headers=bearer(admin))
        assert r.status_code == 200
        assert len(r.json()["points"]) == days


async def test_dashboard_has_no_account_data(client, bearer, admin, db, user, analysis):
    await _event(db, user, datetime.now(UTC), analysis, call=1_000_000)
    await _event(db, user, datetime.now(UTC), failure="timeout")
    for path in ("/api/admin/dashboard", "/api/admin/dashboard/daily"):
        r = await client.get(path, headers=bearer(admin))
        assert r.status_code == 200, r.text
        assert "radarnaque.test" not in r.text
        assert user not in r.text and admin not in r.text


async def test_dashboard_routes_need_admin(client, bearer, make_user):
    simple = await make_user("simple@radarnaque.test")
    for path in ("/api/admin/dashboard", "/api/admin/dashboard/daily"):
        r = await client.get(path)
        assert r.status_code == 401
        assert r.json()["error"]["code"] == "unauthenticated"
        r = await client.get(path, headers=bearer(simple))
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "admin_required"
