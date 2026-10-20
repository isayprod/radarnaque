import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from radarnaque_api.models import Subscription
from radarnaque_api.services.usage import compute_usage

# Tables qui portent des données personnelles : plus aucune ligne après la suppression.
PERSONAL_TABLES = (
    ('auth."user"', "id"),
    ("auth.session", "user_id"),
    ("auth.account", "user_id"),
    ("app.subscriptions", "user_id"),
    ("app.scan_events", "user_id"),
)


async def _scalar(db, sql: str, **params):
    return (await db.execute(text(sql), params)).scalar_one()


async def _personal_rows(db, uid: str) -> dict[str, int]:
    counts = {
        table: await _scalar(db, f"select count(*) from {table} where {column} = :u", u=uid)
        for table, column in PERSONAL_TABLES
    }
    counts["app.scan_results"] = await _scalar(
        db,
        "select count(*) from app.scan_results r join app.scan_events e on e.id = r.scan_event_id"
        " where e.user_id = :u",
        u=uid,
    )
    counts["app.scan_failures"] = await _scalar(
        db,
        "select count(*) from app.scan_failures f join app.scan_events e on e.id = f.scan_event_id"
        " where e.user_id = :u",
        u=uid,
    )
    return counts


async def _populate(db, uid: str, suffix: str) -> int:
    """Session, compte, essai, un scan réussi (avec résultat) et un scan en échec.

    Renvoie l'identifiant de l'analyse servie."""
    await db.execute(
        text("insert into auth.session(id, user_id, token) values (:i, :u, :t)"),
        {"i": f"s-{suffix}", "u": uid, "t": f"tok-{suffix}"},
    )
    await db.execute(
        text("insert into auth.account(id, user_id, provider_id) values (:i, :u, 'email-otp')"),
        {"i": f"a-{suffix}", "u": uid},
    )
    db.add(
        Subscription(
            user_id=uid,
            plan="trial",
            status="active",
            provider="manual",
            period_start=datetime.now(UTC),
        )
    )
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
    analysis_id = await _scalar(
        db,
        "insert into app.analyses(snapshot_id, model_id, prompt_version_id, rules_version,"
        " input_hash, score)"
        " select :s, k.active_model_id, k.active_prompt_version_id, 1, :h, 10"
        " from app.scan_kinds k where k.code = 'full' returning id",
        s=snapshot_id,
        h=f"input-{suffix}",
    )
    ok_id = await _scalar(
        db,
        "insert into app.scan_events(user_id, scan_kind, trigger) values (:u, 'full', 'button')"
        " returning id",
        u=uid,
    )
    await db.execute(
        text("insert into app.scan_results(scan_event_id, analysis_id) values (:e, :a)"),
        {"e": ok_id, "a": analysis_id},
    )
    failed_id = await _scalar(
        db,
        "insert into app.scan_events(user_id, scan_kind, trigger) values (:u, 'full', 'button')"
        " returning id",
        u=uid,
    )
    await db.execute(
        text("insert into app.scan_failures(scan_event_id, error_code) values (:e, 'boom')"),
        {"e": failed_id},
    )
    await db.commit()
    return analysis_id


async def test_delete_me_cascades(client, db, make_user, bearer):
    uid = await make_user("gone@b.test")
    await _populate(db, uid, "gone")
    before = await _personal_rows(db, uid)
    assert all(count == 1 for table, count in before.items() if table != "app.scan_events")
    assert before["app.scan_events"] == 2
    analyses = await _scalar(db, "select count(*) from app.analyses")
    snapshots = await _scalar(db, "select count(*) from app.listing_snapshots")

    response = await client.delete("/api/me", headers=bearer(uid))

    assert response.status_code == 204
    assert response.content == b""
    await db.rollback()  # relire l'état validé
    assert set((await _personal_rows(db, uid)).values()) == {0}
    assert await _scalar(db, "select count(*) from app.analyses") == analyses
    assert await _scalar(db, "select count(*) from app.listing_snapshots") == snapshots


async def test_delete_me_logs_without_identifier(client, make_user, bearer, caplog):
    uid = await make_user("quiet@b.test")
    with caplog.at_level(logging.INFO):
        response = await client.delete("/api/me", headers=bearer(uid))
    assert response.status_code == 204
    assert "compte supprimé" in caplog.text
    assert uid not in caplog.text and "quiet@b.test" not in caplog.text


async def test_delete_me_then_401(client, make_user, bearer):
    uid = await make_user("twice@b.test")
    headers = bearer(uid)
    assert (await client.delete("/api/me", headers=headers)).status_code == 204
    second = await client.delete("/api/me", headers=headers)
    assert second.status_code == 401
    assert second.json()["error"]["code"] == "unauthenticated"
    assert (await client.get("/api/me", headers=headers)).status_code == 401


async def test_delete_me_requires_jwt(client):
    response = await client.delete("/api/me")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthenticated"


async def test_delete_me_other_users_untouched(client, db, make_user, bearer):
    gone = await make_user("gone@b.test")
    kept = await make_user("kept@b.test")
    await _populate(db, gone, "gone")
    await _populate(db, kept, "kept")
    before = await _personal_rows(db, kept)

    assert (await client.delete("/api/me", headers=bearer(gone))).status_code == 204

    await db.rollback()
    assert await _personal_rows(db, kept) == before
    assert before["app.scan_events"] == 2 and before['auth."user"'] == 1


async def test_delete_me_admin_and_superuser(client, make_user, bearer):
    admin = await make_user("admin@b.test", role="admin")
    superuser = await make_user("superuser@radarnaque.test", role="superuser")
    assert (await client.delete("/api/me", headers=bearer(admin))).status_code == 204
    assert (await client.delete("/api/me", headers=bearer(superuser))).status_code == 204
    assert (await client.get("/api/me", headers=bearer(admin))).status_code == 401


async def _add_trial(db, uid: str, plan: str, purged: int, period_start: datetime) -> Subscription:
    sub = Subscription(
        user_id=uid,
        plan=plan,
        status="active",
        provider="manual",
        period_start=period_start,
        purged_scans=purged,
    )
    db.add(sub)
    await db.commit()
    return sub


async def test_usage_counts_purged_scans_for_lifetime(db, make_user):
    now = datetime.now(UTC)
    uid = await make_user("trial@b.test")
    sub = await _add_trial(db, uid, "trial", 3, now - timedelta(days=400))

    usage = await compute_usage(db, sub, now)

    assert usage.per_kind["full"].used == 3
    assert usage.per_kind["full"].remaining == 0
    assert usage.total is not None
    assert (usage.total.used, usage.total.remaining) == (3, 0)


async def test_usage_adds_purged_scans_to_recent_events(db, make_user):
    now = datetime.now(UTC)
    uid = await make_user("trial@b.test")
    sub = await _add_trial(db, uid, "trial", 2, now - timedelta(days=400))
    await db.execute(
        text(
            "insert into app.scan_events(user_id, scan_kind, trigger) values (:u, 'full', 'button')"
        ),
        {"u": uid},
    )
    await db.commit()

    usage = await compute_usage(db, sub, now)

    assert usage.per_kind["full"].used == 3 and usage.per_kind["full"].remaining == 0
    assert usage.total is not None and usage.total.used == 3


async def test_usage_ignores_purged_scans_for_monthly_plan(db, make_user):
    now = datetime.now(UTC)
    uid = await make_user("monthly@b.test")
    sub = await _add_trial(db, uid, "standard", 5, now - timedelta(days=400))

    usage = await compute_usage(db, sub, now)

    assert usage.per_kind["full"].used == 0
    assert usage.per_kind["full"].remaining == usage.per_kind["full"].limit
