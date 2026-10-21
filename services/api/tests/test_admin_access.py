"""Socle de l'API admin : accès, journal des actions, limiteur de fréquence."""

import logging
from datetime import datetime
from typing import Annotated

import pytest
from fastapi import Depends, FastAPI
from sqlalchemy import text

from radarnaque_api.auth.deps import AdminContext, require_admin
from radarnaque_api.services.admin_log import recent_actions, record_action
from radarnaque_api.services.rate_window import SlidingWindowLimiter

ADMIN_EMAIL = "admin@radarnaque.test"
TARGET_EMAIL = "cible@radarnaque.test"


@pytest.fixture
def admin_route(app: FastAPI) -> str:
    """Route de test protégée par `require_admin`, montée sur l'application."""

    @app.get("/api/admin/_test")
    async def _probe(ctx: Annotated[AdminContext, Depends(require_admin)]) -> dict[str, str]:
        return {"role": ctx.user.role}

    return "/api/admin/_test"


async def test_require_admin_without_jwt(client, admin_route):
    r = await client.get(admin_route)
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthenticated"


async def test_require_admin_refuses_user(client, bearer, make_user, admin_route):
    uid = await make_user("simple@radarnaque.test", "user")
    r = await client.get(admin_route, headers=bearer(uid))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "admin_required"


async def test_require_admin_accepts_admin(client, bearer, make_user, admin_route):
    uid = await make_user(ADMIN_EMAIL, "admin")
    r = await client.get(admin_route, headers=bearer(uid))
    assert r.status_code == 200
    assert r.json() == {"role": "admin"}


async def test_require_admin_superuser_outside_production(client, bearer, make_user, admin_route):
    uid = await make_user("super@radarnaque.test", "superuser")
    r = await client.get(admin_route, headers=bearer(uid))
    assert r.status_code == 200


async def test_require_admin_superuser_refused_in_production(
    client, bearer, make_user, admin_route, production
):
    uid = await make_user("super@radarnaque.test", "superuser")
    r = await client.get(admin_route, headers=bearer(uid))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "admin_required"


async def _count(db) -> int:
    return (await db.execute(text("select count(*) from app.admin_actions"))).scalar_one()


async def test_record_action_is_transactional(db, make_user, caplog):
    admin = await make_user(ADMIN_EMAIL, "admin")
    target = await make_user(TARGET_EMAIL)

    record_action(db, admin_id=admin, action="ai.settings_set", details={"from": 24, "to": 48})
    await db.rollback()
    assert await _count(db) == 0

    caplog.clear()
    with caplog.at_level(logging.INFO, logger="radarnaque.admin"):
        record_action(
            db,
            admin_id=admin,
            action="ai.settings_set",
            target_user_id=target,
            details={"from": 24, "to": 48},
        )
        await db.commit()
    assert await _count(db) == 1
    row = (
        await db.execute(
            text("select admin_user_id, action, target_user_id, details from app.admin_actions")
        )
    ).one()
    assert row == (admin, "ai.settings_set", target, {"from": 24, "to": 48})
    messages = [r.getMessage() for r in caplog.records if r.name == "radarnaque.admin"]
    assert messages == ["action admin : ai.settings_set"]
    for secret in (ADMIN_EMAIL, TARGET_EMAIL, admin, target):
        assert secret not in caplog.text


async def test_record_action_details_default_to_empty(db, make_user):
    admin = await make_user(ADMIN_EMAIL, "admin")
    record_action(db, admin_id=admin, action="ai.model_added")
    await db.commit()
    (action,) = await recent_actions(db)
    assert action.details == {}
    assert action.target_user_id is None


async def test_recent_actions_filters(db, make_user):
    admin = await make_user(ADMIN_EMAIL, "admin")
    target = await make_user(TARGET_EMAIL)
    other = await make_user("autre@radarnaque.test")
    record_action(db, admin_id=admin, action="user.plan_set", target_user_id=target)
    record_action(db, admin_id=admin, action="user.role_set", target_user_id=other)
    record_action(db, admin_id=admin, action="ai.prompt_created")
    record_action(db, admin_id=admin, action="ai.model_activated")
    # La purge écrit elle-même ses lignes (pas d'administrateur) ; elles ne sortent jamais.
    await db.execute(
        text("insert into app.admin_actions(action, details) values ('system.purge', '{}')")
    )
    await db.commit()

    everything = await recent_actions(db)
    assert [a.action for a in everything] == [
        "ai.model_activated",
        "ai.prompt_created",
        "user.role_set",
        "user.plan_set",
    ]
    assert all(a.action != "system.purge" for a in everything)
    assert everything[0].admin_email == ADMIN_EMAIL
    assert everything[0].admin_user_id == admin
    assert isinstance(everything[0].created_at, datetime)
    assert everything[0].created_at.tzinfo is not None

    ai = await recent_actions(db, prefix="ai.")
    assert [a.action for a in ai] == ["ai.model_activated", "ai.prompt_created"]
    # Le préfixe `system.` ne rend pas la purge non plus.
    assert await recent_actions(db, prefix="system.") == []

    mine = await recent_actions(db, target_user_id=target)
    assert [a.action for a in mine] == ["user.plan_set"]
    both = await recent_actions(db, prefix="ai.", target_user_id=target)
    assert both == []


async def test_recent_actions_prefix_is_not_a_pattern(db, make_user):
    admin = await make_user(ADMIN_EMAIL, "admin")
    record_action(db, admin_id=admin, action="ai.prompt_created")
    record_action(db, admin_id=admin, action="user.plan_set")
    await db.commit()
    # `%` et `_` sont des caractères, pas des jokers.
    assert await recent_actions(db, prefix="%") == []
    assert await recent_actions(db, prefix="a_.") == []


async def test_recent_actions_limit_and_order(db, make_user):
    admin = await make_user(ADMIN_EMAIL, "admin")
    for i in range(25):
        record_action(db, admin_id=admin, action="ai.settings_set", details={"to": i})
    await db.commit()
    rows = await recent_actions(db)
    assert len(rows) == 20
    assert [a.details["to"] for a in rows] == list(range(24, 4, -1))
    assert len(await recent_actions(db, limit=3)) == 3


async def test_recent_actions_keeps_deleted_admin_and_target(db, make_user):
    """Un admin supprimé laisse une ligne sans admin ; une cible supprimée reste filtrable."""
    admin = await make_user(ADMIN_EMAIL, "admin")
    target = await make_user(TARGET_EMAIL)
    record_action(db, admin_id=admin, action="user.deleted", target_user_id=target)
    await db.commit()
    await db.execute(text('delete from auth."user" where id = :i'), {"i": admin})
    await db.commit()
    (action,) = await recent_actions(db, target_user_id=target)
    assert action.admin_user_id is None
    assert action.admin_email is None


def test_sliding_window():
    clock = [1000.0]
    limiter = SlidingWindowLimiter(10, 3600, now=lambda: clock[0])
    assert [limiter.hit("a") for _ in range(10)] == [True] * 10
    assert limiter.hit("a") is False
    # Un coup refusé n'est pas compté : il ne repousse pas la fin de la fenêtre.
    clock[0] += 3599
    assert limiter.hit("a") is False
    clock[0] += 1.5
    assert limiter.hit("a") is True
    # Les clés sont indépendantes.
    assert limiter.hit("b") is True


def test_sliding_window_slides():
    clock = [0.0]
    limiter = SlidingWindowLimiter(2, 10, now=lambda: clock[0])
    assert limiter.hit("a")
    clock[0] = 6
    assert limiter.hit("a")
    assert not limiter.hit("a")
    clock[0] = 11  # le premier coup (t=0) sort de la fenêtre, le second (t=6) y reste
    assert limiter.hit("a")
    assert not limiter.hit("a")


def test_create_app_installs_limiters(app):
    assert app.state.model_test_limiter.hit("x")
    assert isinstance(app.state.search_test_limiter, SlidingWindowLimiter)
