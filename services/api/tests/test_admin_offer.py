"""API Offre de l'admin (`/api/admin/offer`) et route publique `GET /api/offer`."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from sqlalchemy import text
from test_scans_routes import FakeLLM, _body

from radarnaque_api.services import admin_offer

ADMIN_EMAIL = "admin@radarnaque.test"


@pytest.fixture
async def admin(make_user) -> str:
    return await make_user(ADMIN_EMAIL, "admin")


@pytest.fixture(autouse=True)
def _restore_offer(pg_url: str) -> Iterator[None]:
    """Ces tests modifient l'offre (référentiel que la purge de `conftest.py` ne touche pas) :
    elle est remise en l'état après chacun."""
    url = pg_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(url, autocommit=True) as conn:
        plans = conn.execute("select code, total_scan_cap, max_images from app.plans").fetchall()
        prices = conn.execute("select * from app.plan_prices").fetchall()
        quotas = conn.execute("select * from app.plan_quotas").fetchall()
        features = conn.execute("select * from app.plan_features").fetchall()
    yield
    with psycopg.connect(url, autocommit=True) as conn:
        for code, cap, images in plans:
            conn.execute(
                "update app.plans set total_scan_cap = %s, max_images = %s where code = %s",
                (cap, images, code),
            )
        for table, rows in (
            ("plan_prices", prices),
            ("plan_quotas", quotas),
            ("plan_features", features),
        ):
            conn.execute(f"delete from app.{table}")  # noqa: S608
            for row in rows:
                marks = ", ".join(["%s"] * len(row))
                conn.execute(f"insert into app.{table} values ({marks})", row)  # noqa: S608


async def _scalar(db, sql: str, **params):
    await db.rollback()  # relire l'état validé
    return (await db.execute(text(sql), params)).scalar_one()


async def _count_actions(db) -> int:
    return await _scalar(db, "select count(*) from app.admin_actions")


async def _actions(db) -> list[tuple]:
    await db.rollback()
    rows = await db.execute(
        text(
            "select action, admin_user_id, target_user_id, details"
            " from app.admin_actions order by id"
        )
    )
    return [tuple(r) for r in rows]


async def _overview(client, bearer, admin) -> dict:
    r = await client.get("/api/admin/offer", headers=bearer(admin))
    assert r.status_code == 200, r.text
    return r.json()


def _plan(data: dict, code: str) -> dict:
    return next(p for p in data["plans"] if p["code"] == code)


async def _patch(client, bearer, admin, plan: str, body: dict):
    return await client.patch(f"/api/admin/offer/plans/{plan}", json=body, headers=bearer(admin))


async def _subscribe(db, uid: str, plan: str) -> None:
    await db.execute(
        text(
            "insert into app.subscriptions(user_id, plan, status, provider, period_start)"
            " values (:u, :p, 'active', 'manual', now() - interval '1 day')"
        ),
        {"u": uid, "p": plan},
    )
    await db.commit()


# --- Accès ----------------------------------------------------------------------------------


async def test_offer_routes_need_admin(client, bearer, make_user):
    uid = await make_user("simple@radarnaque.test")
    calls = [
        ("GET", "/api/admin/offer", None),
        ("PATCH", "/api/admin/offer/plans/standard", {"quota": 10}),
    ]
    for method, url, body in calls:
        r = await client.request(method, url, json=body)
        assert r.status_code == 401, (method, url)
        r = await client.request(method, url, json=body, headers=bearer(uid))
        assert r.status_code == 403, (method, url)
        assert r.json()["error"]["code"] == "admin_required"


# --- Vue d'ensemble -------------------------------------------------------------------------


async def test_offer_overview(client, bearer, admin):
    data = await _overview(client, bearer, admin)

    assert [p["code"] for p in data["plans"]] == ["trial", "standard", "premium"]
    trial, standard, premium = data["plans"]
    assert (trial["quota"], standard["quota"], premium["quota"]) == (3, 150, 300)
    assert (trial["maxImages"], standard["maxImages"], premium["maxImages"]) == (4, 1, 4)
    assert (trial["cardIcons"], standard["cardIcons"], premium["cardIcons"]) == (True, False, True)
    assert (trial["totalScanCap"], standard["totalScanCap"]) == (3, None)
    assert trial["quotaPeriod"] == "lifetime"
    assert standard["quotaPeriod"] == "subscription_month"
    assert trial["prices"] == {}
    assert standard["prices"]["month"] == {"amountCents": 299, "stripePriceId": None}
    assert standard["prices"]["year"]["amountCents"] == 2900
    assert premium["prices"]["month"]["amountCents"] == 699
    assert premium["prices"]["year"]["amountCents"] == 6900
    assert data["actions"] == []


# --- Bornes et erreurs ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"quota": 100_001},
        {"quota": -1},
        {"prices": {"month": -1}},
        {"prices": {"year": 100_001}},
        {"maxImages": 5},
        {"maxImages": -1},
        {"totalScanCap": 100_001},
        {"totalScanCap": -1},
        {"inconnu": 1},
    ],
)
async def test_offer_bounds(client, db, bearer, admin, body):
    r = await _patch(client, bearer, admin, "standard", body)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_request"
    assert await _count_actions(db) == 0


async def test_offer_bounds_accept_the_limits(client, bearer, admin):
    r = await _patch(
        client,
        bearer,
        admin,
        "standard",
        {
            "quota": 100_000,
            "prices": {"month": 100_000, "year": 0},
            "maxImages": 0,
            "totalScanCap": 100_000,
        },
    )
    assert r.status_code == 200, r.text
    standard = _plan(r.json(), "standard")
    assert standard["quota"] == 100_000
    assert standard["prices"]["month"]["amountCents"] == 100_000
    assert standard["prices"]["year"]["amountCents"] == 0
    assert standard["maxImages"] == 0
    assert standard["totalScanCap"] == 100_000


async def test_price_on_trial_is_422(client, db, bearer, admin):
    r = await _patch(client, bearer, admin, "trial", {"quota": 5, "prices": {"month": 100}})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_value"
    # Rien n'est appliqué, pas même le quota valide du même corps.
    assert await _scalar(db, "select quota from app.plan_quotas where plan = 'trial'") == 3
    assert await _scalar(db, "select count(*) from app.plan_prices where plan = 'trial'") == 0
    assert await _count_actions(db) == 0


async def test_unknown_plan_is_404(client, db, bearer, admin):
    for body in ({"quota": 10}, {"prices": {"month": 100}}, {}):
        r = await _patch(client, bearer, admin, "inconnu", body)
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "not_found"
    assert await _count_actions(db) == 0
    assert await _scalar(db, "select count(*) from app.plan_quotas where plan = 'inconnu'") == 0


# --- Journal --------------------------------------------------------------------------------


async def test_offer_journal_one_line_per_field(client, db, bearer, admin):
    r = await _patch(
        client,
        bearer,
        admin,
        "standard",
        {"quota": 200, "prices": {"month": 399, "year": 3900}},
    )
    assert r.status_code == 200, r.text
    assert _plan(r.json(), "standard")["quota"] == 200

    actions = await _actions(db)
    assert [a[0] for a in actions] == ["offer.price_set", "offer.price_set", "offer.quota_set"]
    assert all(a[1] == admin and a[2] is None for a in actions)
    assert actions[0][3] == {
        "plan": "standard",
        "interval": "month",
        "from": 299,
        "to": 399,
    }
    assert actions[1][3] == {"plan": "standard", "interval": "year", "from": 2900, "to": 3900}
    assert actions[2][3] == {"plan": "standard", "from": 150, "to": 200}

    # Les actions reviennent dans la vue, de la plus récente à la plus ancienne.
    shown = r.json()["actions"]
    assert len(shown) == 3
    assert {a["action"] for a in shown} == {"offer.price_set", "offer.quota_set"}
    assert shown[0]["adminEmail"] == ADMIN_EMAIL


async def test_offer_journal_other_fields(client, db, bearer, admin):
    r = await _patch(
        client,
        bearer,
        admin,
        "standard",
        {"maxImages": 3, "totalScanCap": 50, "cardIcons": True},
    )
    assert r.status_code == 200, r.text
    standard = _plan(r.json(), "standard")
    assert (standard["maxImages"], standard["totalScanCap"], standard["cardIcons"]) == (3, 50, True)

    by_action = {a[0]: a[3] for a in await _actions(db)}
    assert by_action == {
        "offer.feature_set": {
            "plan": "standard",
            "feature": "card_icons",
            "from": False,
            "to": True,
        },
        "offer.max_images_set": {"plan": "standard", "from": 1, "to": 3},
        "offer.total_cap_set": {"plan": "standard", "from": None, "to": 50},
    }


async def test_offer_same_values_write_nothing(client, db, bearer, admin):
    same = {
        "quota": 150,
        "totalScanCap": None,
        "maxImages": 1,
        "cardIcons": False,
        "prices": {"month": 299, "year": 2900},
    }
    r = await _patch(client, bearer, admin, "standard", same)
    assert r.status_code == 200
    assert _plan(r.json(), "standard")["quota"] == 150
    assert await _count_actions(db) == 0

    # Corps vide : même résultat.
    r = await _patch(client, bearer, admin, "standard", {})
    assert r.status_code == 200
    assert await _count_actions(db) == 0


async def test_offer_failure_leaves_no_trace(client, db, bearer, admin, monkeypatch):
    real = admin_offer.record_action

    def record_then_fail(*args, **kwargs):
        real(*args, **kwargs)
        raise RuntimeError("panne simulée")

    monkeypatch.setattr(admin_offer, "record_action", record_then_fail)
    with pytest.raises(RuntimeError, match="panne simulée"):
        await _patch(client, bearer, admin, "standard", {"quota": 200})

    assert await _count_actions(db) == 0
    assert await _scalar(db, "select quota from app.plan_quotas where plan = 'standard'") == 150


# --- Effets sur les comptes -----------------------------------------------------------------


async def test_lower_quota_gives_zero_remaining(client, db, bearer, admin, make_user):
    uid = await make_user("abonne@radarnaque.test")
    await _subscribe(db, uid, "premium")
    await db.execute(
        text(
            "insert into app.scan_events(user_id, scan_kind, trigger, created_at)"
            " select :u, 'full', 'button', :t from generate_series(1, 310)"
        ),
        {"u": uid, "t": datetime.now(UTC) - timedelta(minutes=5)},
    )
    await db.commit()

    r = await _patch(client, bearer, admin, "premium", {"quota": 400})
    assert r.status_code == 200
    me = (await client.get("/api/me", headers=bearer(uid))).json()
    assert me["quotas"][0]["remaining"] == 90

    r = await _patch(client, bearer, admin, "premium", {"quota": 300})
    assert r.status_code == 200
    me = (await client.get("/api/me", headers=bearer(uid))).json()
    assert me["quotas"][0]["limit"] == 300
    assert me["quotas"][0]["used"] == 310
    assert me["quotas"][0]["remaining"] == 0


async def test_removing_card_icons_refuses_card_scan(client, db, app, bearer, admin, make_user):
    app.state.llm_for = FakeLLM().llm_for
    uid = await make_user("cartes@radarnaque.test")
    await _subscribe(db, uid, "premium")
    body = _body()
    body["trigger"] = "card"

    r = await client.post("/api/scans", json=body, headers=bearer(uid))
    assert r.status_code == 200, r.text

    r = await _patch(client, bearer, admin, "premium", {"cardIcons": False})
    assert r.status_code == 200
    assert _plan(r.json(), "premium")["cardIcons"] is False

    r = await client.post("/api/scans", json=_body("m456"), headers=bearer(uid))
    assert r.status_code == 200  # le bouton n'est pas concerné
    body = _body("m789")
    body["trigger"] = "card"
    r = await client.post("/api/scans", json=body, headers=bearer(uid))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "feature_not_in_plan"


async def test_total_cap_null_clears_cap(client, db, bearer, admin):
    assert await _scalar(db, "select total_scan_cap from app.plans where code = 'trial'") == 3

    # Absent : le plafond ne bouge pas.
    r = await _patch(client, bearer, admin, "trial", {"quota": 3})
    assert _plan(r.json(), "trial")["totalScanCap"] == 3

    # `null` explicite : le plafond est vidé, et la ligne de journal le dit.
    r = await _patch(client, bearer, admin, "trial", {"totalScanCap": None})
    assert r.status_code == 200
    assert _plan(r.json(), "trial")["totalScanCap"] is None
    assert await _scalar(db, "select total_scan_cap from app.plans where code = 'trial'") is None
    actions = await _actions(db)
    assert actions == [
        ("offer.total_cap_set", admin, None, {"plan": "trial", "from": 3, "to": None})
    ]


# --- Route publique -------------------------------------------------------------------------


async def test_public_offer(client, bearer, admin):
    r = await client.get("/api/offer")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=300"
    assert "stripePriceId" not in r.text and "stripe_price_id" not in r.text
    assert r.json() == {
        "trial": {
            "scans": 3,
            "maxImages": 4,
            "cardIcons": True,
            "monthlyCents": None,
            "yearlyCents": None,
        },
        "standard": {
            "scans": 150,
            "maxImages": 1,
            "cardIcons": False,
            "monthlyCents": 299,
            "yearlyCents": 2900,
        },
        "premium": {
            "scans": 300,
            "maxImages": 4,
            "cardIcons": True,
            "monthlyCents": 699,
            "yearlyCents": 6900,
        },
    }

    # Une modification de l'admin se lit sur la route publique ; un prix absent donne `null`.
    r = await _patch(client, bearer, admin, "standard", {"quota": 175, "maxImages": 2})
    assert r.status_code == 200
    public = (await client.get("/api/offer")).json()
    assert public["standard"]["scans"] == 175
    assert public["standard"]["maxImages"] == 2


async def test_public_offer_missing_price_is_null(client, pg_url):
    url = pg_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("delete from app.plan_prices where plan = 'premium' and interval = 'year'")
    public = (await client.get("/api/offer")).json()
    assert public["premium"]["yearlyCents"] is None
    assert public["premium"]["monthlyCents"] == 699
