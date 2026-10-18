from sqlalchemy import text

from alembic import command


async def _column(db) -> tuple | None:
    row = (
        await db.execute(
            text(
                "select data_type, is_nullable, column_default from information_schema.columns"
                " where table_schema = 'app' and table_name = 'analyses'"
                " and column_name = 'professional'"
            )
        )
    ).one_or_none()
    return None if row is None else tuple(row)


async def test_analyses_professional_is_a_non_null_boolean_defaulting_to_false(db):
    assert await _column(db) == ("boolean", "NO", "false")
    site = (
        await db.execute(text("select id from app.sites where domain = '2ememain.be'"))
    ).scalar_one()
    listing = (
        await db.execute(
            text("insert into app.listings(site_id, external_id) values (:s, 'p1') returning id"),
            {"s": site},
        )
    ).scalar_one()
    snap = (
        await db.execute(
            text(
                "insert into app.listing_snapshots(listing_id, content_hash, title, description)"
                " values (:l, 'c', 't', 'd') returning id"
            ),
            {"l": listing},
        )
    ).scalar_one()
    professional = (
        await db.execute(
            text(
                "insert into app.analyses(snapshot_id, model_id, prompt_version_id, rules_version,"
                " input_hash, score)"
                " select :s, k.active_model_id, k.active_prompt_version_id, 1, 'i', 50"
                " from app.scan_kinds k where k.code = 'text' returning professional"
            ),
            {"s": snap},
        )
    ).scalar_one()
    assert professional is False


async def test_downgrade_to_0002_drops_professional_then_upgrade_restores_it(db, alembic_config):
    await db.rollback()  # aucune transaction ouverte ne doit bloquer le ALTER TABLE
    try:
        command.downgrade(alembic_config, "0002")
        assert await _column(db) is None
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")
    assert await _column(db) == ("boolean", "NO", "false")
