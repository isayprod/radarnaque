"""API Utilisateurs de l'admin : liste, fiche, plan, rôle, suppression."""

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.models import Subscription
from radarnaque_api.services import admin_users

ADMIN_EMAIL = "admin@radarnaque.test"


@pytest.fixture
async def admin(make_user) -> str:
    return await make_user(ADMIN_EMAIL, "admin")


async def _scalar(db, sql: str, **params):
    return (await db.execute(text(sql), params)).scalar_one()


async def _count_actions(db) -> int:
    await db.rollback()  # relire l'état validé
    return await _scalar(db, "select count(*) from app.admin_actions")


async def _add_sub(
    db,
    uid: str,
    plan: str = "trial",
    *,
    status: str = "active",
    provider: str = "manual",
    period_start: datetime | None = None,
    purged: int = 0,
) -> Subscription:
    sub = Subscription(
        user_id=uid,
        plan=plan,
        status=status,
        provider=provider,
        period_start=period_start or datetime.now(UTC),
        purged_scans=purged,
    )
    db.add(sub)
    await db.commit()
    return sub


async def _add_scans(db, uid: str, count: int, at: datetime) -> None:
    for _ in range(count):
        await db.execute(
            text(
                "insert into app.scan_events(user_id, scan_kind, trigger, created_at)"
                " values (:u, 'full', 'button', :t)"
            ),
            {"u": uid, "t": at},
        )
    await db.commit()


def _emails(body) -> list[str]:
    return [item["email"] for item in body["items"]]


# --- Liste et recherche -------------------------------------------------------------------


async def test_search_is_case_insensitive_substring(client, bearer, admin, make_user):
    await make_user("Marie.Dupont@radarnaque.test")
    await make_user("paul@radarnaque.test")
    r = await client.get("/api/admin/users?q=DUPONT", headers=bearer(admin))
    assert r.status_code == 200
    assert _emails(r.json()) == ["Marie.Dupont@radarnaque.test"]
    r = await client.get("/api/admin/users?q=ie.dup", headers=bearer(admin))
    assert _emails(r.json()) == ["Marie.Dupont@radarnaque.test"]


async def test_search_escapes_wildcards(client, bearer, admin, make_user):
    for email in (
        "axb@radarnaque.test",
        "a_b@radarnaque.test",
        "50%off@radarnaque.test",
        "50xoff@radarnaque.test",
        "back\\slash@radarnaque.test",
    ):
        await make_user(email)
    h = bearer(admin)
    # `_` et `%` sont des caractères : `a_b` ne trouve pas `axb@…`.
    assert _emails((await client.get("/api/admin/users?q=a_b", headers=h)).json()) == [
        "a_b@radarnaque.test"
    ]
    assert _emails((await client.get("/api/admin/users?q=50%25o", headers=h)).json()) == [
        "50%off@radarnaque.test"
    ]
    assert _emails((await client.get("/api/admin/users?q=k%5Csl", headers=h)).json()) == [
        "back\\slash@radarnaque.test"
    ]
    # Un `%` seul ne ressort pas tout le monde.
    assert _emails((await client.get("/api/admin/users?q=%25%25%25", headers=h)).json()) == []


async def test_search_under_3_chars_is_422(client, bearer, admin):
    for q in ("", "a", "ab"):
        r = await client.get(f"/api/admin/users?q={q}", headers=bearer(admin))
        assert r.status_code == 422, q
        assert r.json()["error"]["code"] == "invalid_request"


async def test_list_filters_and_pagination(client, db, bearer, admin):
    # 55 comptes, créés à des minutes décroissantes ; trois d'entre eux partagent chaque instant
    # (le tri départage par identifiant). Les 5 premiers ont un essai actif.
    await db.execute(
        text(
            'insert into auth."user"(id, email, role, "createdAt")'
            " select 'u' || lpad(i::text, 3, '0'), 'user' || i || '@radarnaque.test', 'user',"
            "   now() - (i / 3) * interval '1 minute' - interval '1 hour'"
            " from generate_series(1, 55) i"
        )
    )
    await db.commit()
    for i in range(1, 6):
        await _add_sub(db, f"u{i:03d}")
    h = bearer(admin)

    first = (await client.get("/api/admin/users", headers=h)).json()
    assert len(first["items"]) == 50
    assert first["items"][0]["email"] == ADMIN_EMAIL  # le plus récent
    assert first["nextBefore"] == first["items"][-1]["id"]
    second = (await client.get(f"/api/admin/users?before={first['nextBefore']}", headers=h)).json()
    assert len(second["items"]) == 6
    assert second["nextBefore"] is None
    ids = [i["id"] for i in first["items"] + second["items"]]
    assert len(ids) == len(set(ids)) == 56
    stamps = [i["createdAt"] for i in first["items"] + second["items"]]
    assert stamps == sorted(stamps, reverse=True)

    small = (await client.get("/api/admin/users?limit=10", headers=h)).json()
    assert len(small["items"]) == 10 and small["nextBefore"] == small["items"][-1]["id"]
    for bad in ("0", "51"):
        r = await client.get(f"/api/admin/users?limit={bad}", headers=h)
        assert r.status_code == 422

    only_admin = (await client.get("/api/admin/users?role=admin", headers=h)).json()
    assert _emails(only_admin) == [ADMIN_EMAIL]
    assert only_admin["nextBefore"] is None

    no_plan = (await client.get("/api/admin/users?plan=none&limit=50", headers=h)).json()
    assert len(no_plan["items"]) == 50 and no_plan["nextBefore"] is not None
    assert all(i["plan"] is None for i in no_plan["items"])
    no_plan2 = (
        await client.get(f"/api/admin/users?plan=none&before={no_plan['nextBefore']}", headers=h)
    ).json()
    assert len(no_plan["items"]) + len(no_plan2["items"]) == 51  # 56 - 5 avec un essai

    trial = (await client.get("/api/admin/users?plan=trial", headers=h)).json()
    assert len(trial["items"]) == 5
    assert {i["plan"] for i in trial["items"]} == {"trial"}
    both = (await client.get("/api/admin/users?plan=trial&role=admin", headers=h)).json()
    assert both["items"] == []


async def test_list_before_unknown_is_404(client, bearer, admin):
    r = await client.get("/api/admin/users?before=inconnu", headers=bearer(admin))
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


async def test_list_row_columns(client, db, bearer, admin, make_user):
    uid = await make_user("colonnes@radarnaque.test")
    await _add_sub(db, uid, period_start=datetime.now(UTC) - timedelta(days=30))
    last = datetime.now(UTC) - timedelta(hours=2)
    await _add_scans(db, uid, 1, last - timedelta(days=1))
    await _add_scans(db, uid, 1, last)
    nobody = await make_user("sans-plan@radarnaque.test")

    r = await client.get("/api/admin/users?q=radarnaque.test", headers=bearer(admin))
    rows = {i["email"]: i for i in r.json()["items"]}
    row = rows["colonnes@radarnaque.test"]
    assert row["id"] == uid and row["role"] == "user" and row["plan"] == "trial"
    assert (row["used"], row["remaining"]) == (2, 1)
    assert datetime.fromisoformat(row["lastScanAt"]) == last
    assert row["createdAt"]
    bare = rows["sans-plan@radarnaque.test"]
    assert bare["id"] == nobody
    assert (bare["plan"], bare["used"], bare["remaining"], bare["lastScanAt"]) == (
        None,
        None,
        None,
        None,
    )


# --- Fiche ---------------------------------------------------------------------------------


async def test_card_usage_matches_api_me(client, db, bearer, admin, make_user):
    uid = await make_user("essai@radarnaque.test")
    await _add_sub(db, uid, "trial", period_start=datetime.now(UTC) - timedelta(days=400), purged=2)
    await _add_scans(db, uid, 1, datetime.now(UTC) - timedelta(days=3))

    card = (await client.get(f"/api/admin/users/{uid}", headers=bearer(admin))).json()
    me = (await client.get("/api/me", headers=bearer(uid))).json()

    assert card["usage"]["quotas"] == me["quotas"]
    assert card["usage"]["totalCap"] == me["totalCap"]
    assert card["usage"]["periodStart"] == me["periodStart"]
    assert card["usage"]["purgedScans"] == 2
    assert card["usage"]["quotas"] == [{"scanKind": "full", "limit": 3, "used": 3, "remaining": 0}]
    assert card["usage"]["totalCap"]["used"] == 3


async def test_card_content(client, db, bearer, admin, make_user):
    uid = await make_user("fiche@radarnaque.test")
    old = await _add_sub(db, uid, "standard", status="expired", provider="stripe")
    sub = await _add_sub(db, uid, "trial")
    await _add_scans(db, uid, 25, datetime.now(UTC) - timedelta(minutes=5))
    other = await make_user("autre@radarnaque.test")
    admin_actions = [
        ("user.plan_set", uid, {"from": None, "to": "trial"}),
        ("user.plan_set", other, {"from": None, "to": "trial"}),
    ]
    for action, target, details in admin_actions:
        await db.execute(
            text(
                "insert into app.admin_actions(admin_user_id, action, target_user_id, details)"
                " values (:a, :c, :t, cast(:d as jsonb))"
            ),
            {"a": admin, "c": action, "t": target, "d": json.dumps(details)},
        )
    await db.commit()

    r = await client.get(f"/api/admin/users/{uid}", headers=bearer(admin))
    assert r.status_code == 200
    card = r.json()
    assert card["id"] == uid and card["email"] == "fiche@radarnaque.test"
    assert card["emailVerified"] is False and card["role"] == "user" and card["createdAt"]
    assert card["subscription"]["id"] == sub.id
    assert card["subscription"]["plan"] == "trial"
    assert {"status", "provider", "periodStart", "periodEnd"} <= card["subscription"].keys()
    assert [s["id"] for s in card["subscriptions"]] == [sub.id, old.id]  # le plus récent d'abord
    assert len(card["scans"]) == 20
    ids = [s["scanEventId"] for s in card["scans"]]
    assert ids == sorted(ids, reverse=True)
    assert [a["targetUserId"] for a in card["actions"]] == [uid]
    assert card["actions"][0]["adminEmail"] == ADMIN_EMAIL


async def test_card_without_subscription(client, bearer, admin, make_user):
    uid = await make_user("rien@radarnaque.test")
    card = (await client.get(f"/api/admin/users/{uid}", headers=bearer(admin))).json()
    assert card["subscription"] is None and card["usage"] is None
    assert card["subscriptions"] == [] and card["scans"] == [] and card["actions"] == []


async def test_card_unknown_is_404(client, bearer, admin):
    r = await client.get("/api/admin/users/inconnu", headers=bearer(admin))
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


# --- Plan ----------------------------------------------------------------------------------


async def _actions(db) -> list[tuple]:
    await db.rollback()
    rows = await db.execute(
        text(
            "select action, admin_user_id, target_user_id, details from app.admin_actions"
            " order by id"
        )
    )
    return [tuple(r) for r in rows]


async def test_assign_plan_ends_previous_and_resets_month(client, db, bearer, admin, make_user):
    uid = await make_user("mensuel@radarnaque.test")
    await _add_sub(db, uid, "standard", period_start=datetime.now(UTC) - timedelta(days=40))
    await _add_scans(db, uid, 4, datetime.now(UTC) - timedelta(hours=1))
    before = (await client.get(f"/api/admin/users/{uid}", headers=bearer(admin))).json()
    assert before["usage"]["quotas"][0]["used"] == 4

    r = await client.post(
        f"/api/admin/users/{uid}/plan", json={"plan": "premium"}, headers=bearer(admin)
    )

    assert r.status_code == 200
    card = r.json()
    assert card["subscription"]["plan"] == "premium"
    assert card["subscription"]["status"] == "active"
    assert card["subscription"]["provider"] == "manual"
    assert card["subscription"]["periodEnd"] is None
    assert card["usage"]["quotas"][0]["used"] == 0  # la consommation repart de zéro
    ended = next(s for s in card["subscriptions"] if s["plan"] == "standard")
    assert ended["status"] == "expired" and ended["periodEnd"] is not None
    assert card["subscription"]["periodStart"] == ended["periodEnd"]
    assert [s["status"] for s in card["subscriptions"]].count("active") == 1
    assert await _actions(db) == [
        ("user.plan_set", admin, uid, {"from": "standard", "to": "premium"})
    ]


async def test_assign_same_plan_starts_new_period(client, db, bearer, admin, make_user):
    uid = await make_user("meme@radarnaque.test")
    first = await _add_sub(db, uid, "standard", period_start=datetime.now(UTC) - timedelta(days=40))
    r = await client.post(
        f"/api/admin/users/{uid}/plan", json={"plan": "standard"}, headers=bearer(admin)
    )
    assert r.status_code == 200
    card = r.json()
    assert card["subscription"]["id"] != first.id
    assert len(card["subscriptions"]) == 2
    assert (await _actions(db))[0][3] == {"from": "standard", "to": "standard"}


@pytest.mark.parametrize("previous", [None, "expired"])
async def test_assign_plan_without_active_subscription(
    client, db, bearer, admin, make_user, previous
):
    uid = await make_user("sansplan@radarnaque.test")
    if previous:
        await _add_sub(db, uid, "trial", status=previous)

    r = await client.post(
        f"/api/admin/users/{uid}/plan", json={"plan": "standard"}, headers=bearer(admin)
    )

    assert r.status_code == 200
    assert r.json()["subscription"]["plan"] == "standard"
    assert len(r.json()["subscriptions"]) == (2 if previous else 1)
    assert await _actions(db) == [("user.plan_set", admin, uid, {"from": None, "to": "standard"})]


async def test_assign_plan_stripe_is_409(client, db, bearer, admin, make_user):
    uid = await make_user("stripe@radarnaque.test")
    await _add_sub(db, uid, "premium", provider="stripe")
    r = await client.post(
        f"/api/admin/users/{uid}/plan", json={"plan": "standard"}, headers=bearer(admin)
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "conflict"
    assert await _count_actions(db) == 0
    rows = await _scalar(db, "select count(*) from app.subscriptions where user_id = :u", u=uid)
    assert rows == 1


async def test_assign_unknown_plan_is_422(client, db, bearer, admin, make_user):
    uid = await make_user("inconnu@radarnaque.test")
    sub = await _add_sub(db, uid, "trial")
    r = await client.post(
        f"/api/admin/users/{uid}/plan", json={"plan": "platine"}, headers=bearer(admin)
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_value"
    assert await _count_actions(db) == 0
    status = await _scalar(db, "select status from app.subscriptions where id = :i", i=sub.id)
    assert status == "active"


async def test_assign_plan_unknown_user_is_404(client, bearer, admin):
    r = await client.post(
        "/api/admin/users/inconnu/plan", json={"plan": "standard"}, headers=bearer(admin)
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


async def test_assign_plan_rejects_extra_and_missing_fields(client, bearer, admin, make_user):
    uid = await make_user("champs@radarnaque.test")
    for body in ({}, {"plan": "standard", "x": 1}):
        r = await client.post(f"/api/admin/users/{uid}/plan", json=body, headers=bearer(admin))
        assert r.status_code == 422
        assert r.json()["error"]["code"] == "invalid_request"


async def test_assign_plan_logs_without_email_or_id(client, bearer, admin, make_user, caplog):
    uid = await make_user("discret@radarnaque.test")
    with caplog.at_level(logging.INFO, logger="radarnaque.admin"):
        await client.post(
            f"/api/admin/users/{uid}/plan", json={"plan": "standard"}, headers=bearer(admin)
        )
    messages = [r.getMessage() for r in caplog.records if r.name == "radarnaque.admin"]
    assert messages == ["action admin : user.plan_set"]
    assert "discret@radarnaque.test" not in caplog.text and uid not in caplog.text


# --- Rôle ----------------------------------------------------------------------------------


async def test_role_grant_and_revoke(client, db, bearer, admin, make_user):
    uid = await make_user("futur@radarnaque.test")
    r = await client.post(
        f"/api/admin/users/{uid}/role", json={"role": "admin"}, headers=bearer(admin)
    )
    assert r.status_code == 200
    assert r.json()["role"] == "admin" and r.json()["id"] == uid
    # Le nouvel admin passe `require_admin` aussitôt.
    assert (await client.get("/api/admin/users", headers=bearer(uid))).status_code == 200

    r = await client.post(
        f"/api/admin/users/{uid}/role", json={"role": "user"}, headers=bearer(admin)
    )
    assert r.status_code == 200 and r.json()["role"] == "user"
    assert (await client.get("/api/admin/users", headers=bearer(uid))).status_code == 403
    assert await _actions(db) == [
        ("user.role_set", admin, uid, {"from": "user", "to": "admin"}),
        ("user.role_set", admin, uid, {"from": "admin", "to": "user"}),
    ]


async def test_role_unchanged_is_200_without_trace(client, db, bearer, admin, make_user):
    uid = await make_user("pareil@radarnaque.test")
    r = await client.post(
        f"/api/admin/users/{uid}/role", json={"role": "user"}, headers=bearer(admin)
    )
    assert r.status_code == 200 and r.json()["role"] == "user"
    other = await make_user("deja-admin@radarnaque.test", "admin")
    r = await client.post(
        f"/api/admin/users/{other}/role", json={"role": "admin"}, headers=bearer(admin)
    )
    assert r.status_code == 200 and r.json()["role"] == "admin"
    assert await _count_actions(db) == 0


async def test_role_self_is_409(client, db, bearer, admin, make_user):
    await make_user("second@radarnaque.test", "admin")
    for role in ("user", "admin"):
        r = await client.post(
            f"/api/admin/users/{admin}/role", json={"role": role}, headers=bearer(admin)
        )
        assert r.status_code == 409
        assert r.json()["error"]["code"] == "conflict"
    assert await _count_actions(db) == 0
    assert await _scalar(db, 'select role from auth."user" where id = :i', i=admin) == "admin"


async def test_last_admin_is_409(client, db, bearer, make_user):
    # Un superuser (hors production) passe `require_admin` sans être admin : il tente de
    # retirer le seul admin.
    only = await make_user("seul@radarnaque.test", "admin")
    root = await make_user("root@radarnaque.test", "superuser")
    r = await client.post(
        f"/api/admin/users/{only}/role", json={"role": "user"}, headers=bearer(root)
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "conflict"
    assert await _count_actions(db) == 0
    assert await _scalar(db, 'select role from auth."user" where id = :i', i=only) == "admin"


async def test_two_admins_revoking_each_other_leave_one(client, db, bearer, make_user):
    a = await make_user("a@radarnaque.test", "admin")
    b = await make_user("b@radarnaque.test", "admin")
    first, second = await asyncio.gather(
        client.post(f"/api/admin/users/{b}/role", json={"role": "user"}, headers=bearer(a)),
        client.post(f"/api/admin/users/{a}/role", json={"role": "user"}, headers=bearer(b)),
    )
    codes = sorted([first.status_code, second.status_code])
    # Le perdant reçoit 409 (dernier admin) ; 403 si le gagnant l'a déjà rétrogradé avant qu'il
    # ne passe `require_admin`.
    assert codes[0] == 200 and codes[1] in (403, 409), codes
    await db.rollback()
    assert await _scalar(db, "select count(*) from auth.\"user\" where role = 'admin'") == 1
    assert await _scalar(db, "select count(*) from app.admin_actions") == 1


async def test_last_admin_is_checked_under_the_lock(client, db, bearer, make_user):
    """Un retrait attend le verrou des admins puis relit la liste à jour : si l'autre admin a
    été retiré entre-temps, il ne reste que la cible, et le retrait est refusé."""
    a = await make_user("a@radarnaque.test", "admin")
    b = await make_user("b@radarnaque.test", "admin")
    # Une transaction concurrente (comme la commande `admin:revoke`) tient le verrou.
    await db.execute(
        text("select id from auth.\"user\" where role = 'admin' order by id for no key update")
    )
    pending = asyncio.create_task(
        client.post(f"/api/admin/users/{a}/role", json={"role": "user"}, headers=bearer(b))
    )
    await asyncio.sleep(0.5)
    assert not pending.done()  # bloqué sur le verrou
    await db.execute(text("update auth.\"user\" set role = 'user' where id = :i"), {"i": b})
    await db.commit()
    r = await pending
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "conflict"
    assert await _count_actions(db) == 0
    assert await _scalar(db, 'select role from auth."user" where id = :i', i=a) == "admin"


async def test_journal_insert_does_not_wait_for_a_no_key_update_lock(db, make_user):
    """Le journal d'un admin prend un `FOR KEY SHARE` sur sa ligne (clé étrangère) : il ne doit
    pas attendre un `FOR NO KEY UPDATE` tenu par un retrait de rôle. `lock_timeout` court : si
    le verrou était `FOR UPDATE`, l'insertion échouerait."""
    actor = await make_user("acteur@radarnaque.test", "admin")
    engine = db.bind
    async with AsyncSession(engine) as holder:
        await holder.execute(
            text('select id from auth."user" where id = :i for no key update'), {"i": actor}
        )
        await db.execute(text("set local lock_timeout = '500ms'"))
        await db.execute(
            text(
                "insert into app.admin_actions(admin_user_id, action) values (:i, 'user.plan_set')"
            ),
            {"i": actor},
        )
        await db.commit()
        await holder.rollback()
    assert await _scalar(db, "select count(*) from app.admin_actions") == 1


async def test_plan_and_role_removal_do_not_deadlock_across_admins(client, db, bearer, make_user):
    """Croisement : l'admin A attribue un plan à l'admin C (verrou sur C) pendant que l'admin B
    retire un rôle (verrou sur tous les admins par id : il tient A, attend C). A écrit ensuite son
    journal, qui prend un `FOR KEY SHARE` sur la ligne de A : tenue en `FOR NO KEY UPDATE` par B,
    cette ligne ne bloque pas A (avec `FOR UPDATE`, c'était un interblocage et un 500)."""
    ids = sorted([await make_user(f"{n}@radarnaque.test", "admin") for n in "abc"])
    a, b, c = ids  # B verrouille dans cet ordre : a, puis b, puis il attend c
    async with AsyncSession(db.bind) as acting_as_a:
        # L'attribution de A, vue de l'extérieur : elle tient déjà le verrou sur C.
        await acting_as_a.execute(
            text('select id from auth."user" where id = :i for no key update'), {"i": c}
        )
        pending = asyncio.create_task(
            client.post(f"/api/admin/users/{c}/role", json={"role": "user"}, headers=bearer(b))
        )
        await asyncio.sleep(0.5)
        assert not pending.done()  # B tient a et b, attend c
        await acting_as_a.execute(text("set local lock_timeout = '2s'"))
        await acting_as_a.execute(
            text(
                "insert into app.admin_actions(admin_user_id, action) values (:i, 'user.plan_set')"
            ),
            {"i": a},
        )
        await acting_as_a.commit()
    r = await asyncio.wait_for(pending, timeout=10)
    assert r.status_code == 200, r.text
    await db.rollback()
    assert await _scalar(db, 'select role from auth."user" where id = :i', i=c) == "user"
    assert await _scalar(db, "select count(*) from app.admin_actions") == 2


async def test_role_superuser_is_422(client, db, bearer, admin, make_user):
    uid = await make_user("pas-super@radarnaque.test")
    r = await client.post(
        f"/api/admin/users/{uid}/role", json={"role": "superuser"}, headers=bearer(admin)
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_request"
    assert await _count_actions(db) == 0
    assert await _scalar(db, 'select role from auth."user" where id = :i', i=uid) == "user"


async def test_role_unknown_user_is_404(client, bearer, admin):
    r = await client.post(
        "/api/admin/users/inconnu/role", json={"role": "admin"}, headers=bearer(admin)
    )
    assert r.status_code == 404
    r = await client.post(
        "/api/admin/users/inconnu/role", json={"role": "user"}, headers=bearer(admin)
    )
    assert r.status_code == 404


# --- Suppression ---------------------------------------------------------------------------


async def test_delete_cascades_and_keeps_trace(client, db, bearer, admin, make_user):
    uid = await make_user("partant@radarnaque.test")
    await _add_sub(db, uid)
    await _add_scans(db, uid, 2, datetime.now(UTC))
    await db.execute(
        text("insert into auth.session(id, user_id, token) values ('s1', :u, 't1')"), {"u": uid}
    )
    await db.execute(
        text("insert into auth.account(id, user_id, provider_id) values ('a1', :u, 'p')"),
        {"u": uid},
    )
    await db.commit()
    other = await make_user("reste@radarnaque.test")
    await _add_sub(db, other)

    r = await client.delete(f"/api/admin/users/{uid}", headers=bearer(admin))

    assert r.status_code == 204 and r.content == b""
    await db.rollback()
    for sql in (
        'select count(*) from auth."user" where id = :u',
        "select count(*) from auth.session where user_id = :u",
        "select count(*) from auth.account where user_id = :u",
        "select count(*) from app.subscriptions where user_id = :u",
        "select count(*) from app.scan_events where user_id = :u",
    ):
        assert await _scalar(db, sql, u=uid) == 0, sql
    assert await _scalar(db, "select count(*) from app.subscriptions where user_id = :u", u=other)
    assert await _actions(db) == [("user.deleted", admin, uid, {})]


async def test_delete_unknown_is_404(client, db, bearer, admin):
    r = await client.delete("/api/admin/users/inconnu", headers=bearer(admin))
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"
    assert await _count_actions(db) == 0


async def test_delete_self_is_409(client, db, bearer, admin):
    r = await client.delete(f"/api/admin/users/{admin}", headers=bearer(admin))
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "conflict"
    assert await _count_actions(db) == 0
    assert await _scalar(db, 'select count(*) from auth."user" where id = :i', i=admin) == 1


async def test_conflict_reasons(client, db, bearer, admin, make_user):
    """Chaque 409 de l'écran Utilisateurs porte `details.reason` (l'interface s'en sert)."""
    other = await make_user("autre-admin@radarnaque.test", "admin")
    root = await make_user("root@radarnaque.test", "superuser")
    stripe_user = await make_user("stripe@radarnaque.test")
    await _add_sub(db, stripe_user, "premium", provider="stripe")

    # rôle sur soi
    r = await client.post(
        f"/api/admin/users/{admin}/role", json={"role": "user"}, headers=bearer(admin)
    )
    assert r.status_code == 409 and r.json()["error"]["details"] == {"reason": "self"}

    # dernier admin : l'autre admin disparaît, le superuser tente de retirer celui qui reste
    await db.execute(text("update auth.\"user\" set role = 'user' where id = :i"), {"i": other})
    await db.commit()
    r = await client.post(
        f"/api/admin/users/{admin}/role", json={"role": "user"}, headers=bearer(root)
    )
    assert r.status_code == 409 and r.json()["error"]["details"] == {"reason": "last_admin"}

    # plan sur un abonnement Stripe
    r = await client.post(
        f"/api/admin/users/{stripe_user}/plan", json={"plan": "standard"}, headers=bearer(admin)
    )
    assert r.status_code == 409 and r.json()["error"]["details"] == {"reason": "stripe"}

    # suppression de soi
    r = await client.delete(f"/api/admin/users/{admin}", headers=bearer(admin))
    assert r.status_code == 409 and r.json()["error"]["details"] == {"reason": "self"}


# --- Journal -------------------------------------------------------------------------------


async def test_failed_action_leaves_no_trace(client, db, bearer, admin, make_user, monkeypatch):
    """Une erreur après `record_action` annule le changement et sa ligne de journal."""
    uid = await make_user("survivant@radarnaque.test")
    real = admin_users.delete_account

    async def delete_then_fail(session, user_id):
        await real(session, user_id)  # la suppression et la ligne sont écrites, pas validées
        raise RuntimeError("panne simulée")

    monkeypatch.setattr(admin_users, "delete_account", delete_then_fail)
    with pytest.raises(RuntimeError, match="panne simulée"):
        await client.delete(f"/api/admin/users/{uid}", headers=bearer(admin))

    assert await _count_actions(db) == 0
    assert await _scalar(db, 'select count(*) from auth."user" where id = :i', i=uid) == 1


async def test_failed_plan_change_leaves_no_trace(
    client, db, bearer, admin, make_user, monkeypatch
):
    uid = await make_user("intact@radarnaque.test")
    sub = await _add_sub(db, uid, "standard")
    real = admin_users.record_action

    def record_then_fail(*args, **kwargs):
        real(*args, **kwargs)
        raise RuntimeError("panne simulée")

    monkeypatch.setattr(admin_users, "record_action", record_then_fail)
    with pytest.raises(RuntimeError, match="panne simulée"):
        await client.post(
            f"/api/admin/users/{uid}/plan", json={"plan": "premium"}, headers=bearer(admin)
        )

    # L'ancien abonnement reste actif, aucun autre n'a été créé, aucune ligne de journal.
    assert await _count_actions(db) == 0
    assert await _scalar(db, "select status from app.subscriptions where id = :i", i=sub.id) == (
        "active"
    )
    assert (
        await _scalar(db, "select count(*) from app.subscriptions where user_id = :u", u=uid) == 1
    )


# --- Accès ---------------------------------------------------------------------------------


async def test_users_routes_need_admin(client, bearer, make_user):
    simple = await make_user("simple@radarnaque.test")
    target = await make_user("cible@radarnaque.test")
    calls = [
        ("GET", "/api/admin/users", None),
        ("GET", f"/api/admin/users/{target}", None),
        ("POST", f"/api/admin/users/{target}/plan", {"plan": "standard"}),
        ("POST", f"/api/admin/users/{target}/role", {"role": "admin"}),
        ("DELETE", f"/api/admin/users/{target}", None),
    ]
    for method, url, body in calls:
        r = await client.request(method, url, json=body, headers=bearer(simple))
        assert r.status_code == 403, (method, url)
        assert r.json()["error"]["code"] == "admin_required"
        anonymous = await client.request(method, url, json=body)
        assert anonymous.status_code == 401, (method, url)
