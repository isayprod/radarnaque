from datetime import UTC, datetime

from sqlalchemy import text

from alembic import command

T1 = datetime(2026, 10, 1, 8, 0, tzinfo=UTC)
T2 = datetime(2026, 10, 2, 9, 30, tzinfo=UTC)


async def _rows(db, sql: str, **params) -> list[tuple]:
    return [tuple(r) for r in (await db.execute(text(sql), params)).all()]


async def _tables(db) -> list[str]:
    return [
        name
        for (name,) in await _rows(
            db,
            "select table_name from information_schema.tables where table_schema = 'app'"
            " and table_name in ('admin_actions', 'llm_calls') order by table_name",
        )
    ]


async def _index_names(db, table: str) -> list[str]:
    return [
        name
        for (name,) in await _rows(
            db,
            "select indexname from pg_indexes where schemaname = 'app' and tablename = :t"
            " order by indexname",
            t=table,
        )
    ]


async def _insert_analysis(db, suffix: str, created_at: datetime, *, tokens: int, cost: int):
    """Une annonce, un snapshot et une analyse (modèle et prompt actifs de `full`)."""
    listing_id = (
        await db.execute(
            text(
                "insert into app.listings(site_id, external_id)"
                " select id, :x from app.sites order by id limit 1 returning id"
            ),
            {"x": f"ext-{suffix}"},
        )
    ).scalar_one()
    snapshot_id = (
        await db.execute(
            text(
                "insert into app.listing_snapshots(listing_id, content_hash, title, description)"
                " values (:l, :h, 'titre', 'description') returning id"
            ),
            {"l": listing_id, "h": f"hash-{suffix}"},
        )
    ).scalar_one()
    return (
        await db.execute(
            text(
                "insert into app.analyses(snapshot_id, model_id, prompt_version_id, rules_version,"
                " input_hash, score, created_at, tokens_in, tokens_out, cost_usd_micros,"
                " images_analyzed)"
                " select :s, k.active_model_id, k.active_prompt_version_id, 1, :h, 10, :at,"
                " :tin, :tout, :cost, :img from app.scan_kinds k where k.code = 'full'"
                " returning id"
            ),
            {
                "s": snapshot_id,
                "h": f"input-{suffix}",
                "at": created_at,
                "tin": tokens,
                "tout": tokens // 10,
                "cost": cost,
                "img": 2,
            },
        )
    ).scalar_one()


async def test_migration_0007_tables(db):
    assert await _tables(db) == ["admin_actions", "llm_calls"]
    admin_indexes = await _index_names(db, "admin_actions")
    assert "ix_admin_actions_created_at" in admin_indexes
    assert "ix_admin_actions_target_user_id" in admin_indexes
    llm_indexes = await _index_names(db, "llm_calls")
    assert "ix_llm_calls_created_at" in llm_indexes
    assert "ix_llm_calls_analysis_id" in llm_indexes
    # L'index du journal est trié du plus récent au plus ancien.
    (indexdef,) = (
        await _rows(
            db,
            "select indexdef from pg_indexes where indexname = 'ix_admin_actions_created_at'",
        )
    )[0]
    assert "created_at DESC" in indexdef

    # admin_user_id : ON DELETE SET NULL ; target_user_id : aucune clé étrangère.
    foreign_keys = await _rows(
        db,
        "select a.attname, c.confdeltype from pg_constraint c"
        " join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)"
        " where c.contype = 'f' and c.conrelid = 'app.admin_actions'::regclass",
    )
    assert foreign_keys == [("admin_user_id", "n")]


async def test_admin_deleted_keeps_action(db, make_user):
    admin = await make_user("admin@radarnaque.test", role="admin")
    target = await make_user("cible@radarnaque.test")
    await db.execute(
        text(
            "insert into app.admin_actions(admin_user_id, action, target_user_id, details)"
            ' values (:a, \'user.plan_set\', :t, \'{"from": null, "to": "premium"}\')'
        ),
        {"a": admin, "t": target},
    )
    await db.commit()

    await db.execute(text('delete from auth."user" where id = :u'), {"u": admin})
    await db.commit()

    assert await _rows(
        db, "select admin_user_id, action, target_user_id from app.admin_actions"
    ) == [(None, "user.plan_set", target)]


async def test_migration_0007_backfill_and_downgrade(db, alembic_config):
    first = await _insert_analysis(db, "a", T1, tokens=500, cost=70)
    second = await _insert_analysis(db, "b", T2, tokens=900, cost=120)
    await db.execute(
        text(
            "insert into app.analysis_web_searches(analysis_id, position, query, aspect)"
            " values (:a, 0, 'q1', 'price'), (:a, 1, 'q2', 'scam')"
        ),
        {"a": second},
    )
    await db.commit()  # la migration tourne sur une autre connexion
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0006")
        assert await _tables(db) == []
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")

    assert await _tables(db) == ["admin_actions", "llm_calls"]
    rows = await _rows(
        db,
        "select analysis_id, created_at, tokens_in, tokens_out, cost_usd_micros, images_analyzed,"
        " web_searches from app.llm_calls order by created_at",
    )
    assert rows == [
        (first, T1, 500, 50, 70, 2, 0),
        (second, T2, 900, 90, 120, 2, 2),
    ]
