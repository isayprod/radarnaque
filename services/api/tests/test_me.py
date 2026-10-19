import asyncio
import logging

from sqlalchemy import select

from radarnaque_api.models import PlanFeature, Subscription

SECRET = {"X-Internal-Secret": "test-internal-secret-0123456789abcdef"}


async def test_me_new_user_gets_trial(client, make_user, bearer):
    uid = await make_user("new@b.test")
    body = (await client.get("/api/me", headers=bearer(uid))).json()
    assert body["userId"] == uid and body["email"] == "new@b.test" and body["role"] == "user"
    assert body["plan"] == "trial" and body["unlimited"] is False
    assert sorted(body["features"]) == ["card_icons", "image_scan"]
    assert {q["scanKind"]: q["remaining"] for q in body["quotas"]} == {
        "text": 3,
        "image": 3,
        "full": 3,
    }
    assert body["totalCap"] == {"scanKind": None, "limit": 3, "used": 0, "remaining": 3}
    assert body["periodStart"] is not None


async def test_me_concurrent_calls_single_trial(client, db, make_user, bearer):
    uid = await make_user("new@b.test")
    responses = await asyncio.gather(
        *(client.get("/api/me", headers=bearer(uid)) for _ in range(8))
    )
    assert [r.status_code for r in responses] == [200] * 8
    rows = (await db.execute(select(Subscription).where(Subscription.user_id == uid))).all()
    assert len(rows) == 1


async def test_me_admin_unlimited(client, make_user, bearer):
    uid = await make_user("admin@b.test", role="admin")
    body = (await client.get("/api/me", headers=bearer(uid))).json()
    assert body["role"] == "admin" and body["unlimited"] is True
    assert sorted(body["features"]) == ["card_icons", "image_scan"]
    assert body["quotas"] == [] and body["totalCap"] is None and body["maxImages"] == 4


async def test_me_superuser_is_premium(client, db, make_user, bearer):
    uid = await make_user("superuser@radarnaque.test", role="superuser")
    body = (await client.get("/api/me", headers=bearer(uid))).json()
    assert body["role"] == "superuser" and body["unlimited"] is True
    assert body["plan"] == "premium" and body["maxImages"] == 4
    assert "card_icons" in body["features"]
    # Comme tout compte illimité : pas de quota affiché.
    assert body["quotas"] == [] and body["totalCap"] is None
    # Comme l'admin : aucun essai créé.
    rows = (await db.execute(select(Subscription).where(Subscription.user_id == uid))).all()
    assert rows == []


async def test_me_superuser_features_are_the_premium_ones(client, db, make_user, bearer):
    uid = await make_user("superuser@radarnaque.test", role="superuser")
    body = (await client.get("/api/me", headers=bearer(uid))).json()
    premium = (
        (await db.execute(select(PlanFeature.feature).where(PlanFeature.plan == "premium")))
        .scalars()
        .all()
    )
    assert sorted(body["features"]) == sorted(premium)


async def test_me_standard_max_images(client, db, make_user, bearer):
    from datetime import UTC, datetime

    uid = await make_user("std@b.test")
    db.add(
        Subscription(
            user_id=uid,
            plan="standard",
            status="active",
            provider="manual",
            period_start=datetime(2026, 1, 1, tzinfo=UTC),
        )
    )
    await db.commit()
    body = (await client.get("/api/me", headers=bearer(uid))).json()
    assert body["plan"] == "standard" and body["maxImages"] == 1
    quotas = {q["scanKind"]: q for q in body["quotas"]}
    assert quotas["full"]["limit"] == 150 and quotas["full"]["used"] == 0


async def test_me_trial_quota_full(client, make_user, bearer):
    uid = await make_user("new@b.test")
    body = (await client.get("/api/me", headers=bearer(uid))).json()
    assert body["maxImages"] == 4
    full = {q["scanKind"]: q for q in body["quotas"]}["full"]
    assert full["limit"] == 3 and full["remaining"] == 3
    assert body["totalCap"]["limit"] == 3


async def test_me_superuser_is_a_user_in_production(client, make_user, bearer, production, caplog):
    uid = await make_user("superuser@radarnaque.test", role="superuser")
    with caplog.at_level(logging.WARNING, logger="radarnaque.privileges"):
        body = (await client.get("/api/me", headers=bearer(uid))).json()
    assert body["role"] == "user" and body["unlimited"] is False
    assert body["plan"] == "trial" and body["maxImages"] == 4
    assert {q["scanKind"]: q["remaining"] for q in body["quotas"]} == {
        "text": 3,
        "image": 3,
        "full": 3,
    }
    assert "rôle superuser ignoré en production" in caplog.text
    assert "superuser@radarnaque.test" not in caplog.text and uid not in caplog.text


async def test_me_admin_stays_admin_in_production(client, make_user, bearer, production):
    uid = await make_user("admin@b.test", role="admin")
    body = (await client.get("/api/me", headers=bearer(uid))).json()
    assert body["role"] == "admin" and body["unlimited"] is True


async def test_me_admin_reports_active_plan(client, db, make_user, bearer):
    from datetime import UTC, datetime

    uid = await make_user("admin@b.test", role="admin")
    db.add(
        Subscription(
            user_id=uid,
            plan="premium",
            status="active",
            provider="manual",
            period_start=datetime(2026, 1, 1, tzinfo=UTC),
        )
    )
    await db.commit()
    body = (await client.get("/api/me", headers=bearer(uid))).json()
    assert body["plan"] == "premium" and body["unlimited"] is True and body["quotas"] == []


async def test_me_without_active_sub(client, db, make_user, bearer):
    from datetime import UTC, datetime

    uid = await make_user("old@b.test")
    db.add(
        Subscription(
            user_id=uid,
            plan="standard",
            status="canceled",
            provider="manual",
            period_start=datetime(2026, 1, 1, tzinfo=UTC),
        )
    )
    await db.commit()
    body = (await client.get("/api/me", headers=bearer(uid))).json()
    assert body["plan"] is None and body["features"] == [] and body["quotas"] == []
    assert body["maxImages"] == 0
    assert body["totalCap"] is None and body["periodStart"] is None and body["unlimited"] is False


async def test_me_requires_auth(client):
    response = await client.get("/api/me")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


async def test_internal_bootstrap_requires_secret(client, make_user):
    uid = await make_user("a@b.test")
    response = await client.post(f"/api/internal/users/{uid}/bootstrap")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"
    response = await client.post(
        f"/api/internal/users/{uid}/bootstrap", headers={"X-Internal-Secret": "wrong"}
    )
    assert response.status_code == 403


async def test_internal_bootstrap_ok_and_idempotent(client, make_user):
    uid = await make_user("a@b.test")
    first = await client.post(f"/api/internal/users/{uid}/bootstrap", headers=SECRET)
    assert first.status_code == 200 and first.json() == {"created": True}
    second = await client.post(f"/api/internal/users/{uid}/bootstrap", headers=SECRET)
    assert second.status_code == 200 and second.json() == {"created": False}


async def test_internal_bootstrap_unknown_user_404(client):
    response = await client.post("/api/internal/users/nope/bootstrap", headers=SECRET)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
