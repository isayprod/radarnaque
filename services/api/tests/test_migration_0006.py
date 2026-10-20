from sqlalchemy import text

from alembic import command


async def _rows(db, sql: str, **params) -> list[tuple]:
    return [tuple(r) for r in (await db.execute(text(sql), params)).all()]


async def _purged_scans_column(db) -> list[tuple]:
    return await _rows(
        db,
        "select data_type, is_nullable, column_default from information_schema.columns"
        " where table_schema = 'app' and table_name = 'subscriptions'"
        " and column_name = 'purged_scans'",
    )


async def test_purged_scans_column(db):
    assert await _purged_scans_column(db) == [("integer", "NO", "0")]


async def test_downgrade_drops_and_upgrade_restores_zero(db, make_user, alembic_config):
    uid = await make_user("old@b.test")
    await db.execute(
        text(
            "insert into app.subscriptions(user_id, plan, status, provider, period_start)"
            " values (:u, 'trial', 'active', 'manual', now())"
        ),
        {"u": uid},
    )
    await db.commit()  # la migration tourne sur une autre connexion
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0005")
        assert await _purged_scans_column(db) == []
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")
    # Les lignes existantes reçoivent 0.
    assert await _rows(db, "select purged_scans from app.subscriptions") == [(0,)]
    assert await _purged_scans_column(db) == [("integer", "NO", "0")]
