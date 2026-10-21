from sqlalchemy import text

from alembic import command


async def _rows(db, sql: str, **params) -> list[tuple]:
    return [tuple(r) for r in (await db.execute(text(sql), params)).all()]


async def _url_column(db) -> list[tuple]:
    return await _rows(
        db,
        "select data_type, is_nullable, column_default from information_schema.columns"
        " where table_schema = 'app' and table_name = 'listings' and column_name = 'url'",
    )


async def test_listings_url_column_is_nullable_text(db):
    assert await _url_column(db) == [("text", "YES", None)]


async def test_downgrade_drops_column_and_upgrade_restores_it(db, alembic_config):
    await db.execute(
        text(
            "insert into app.listings(site_id, external_id)"
            " select id, 'ext-old' from app.sites order by id limit 1"
        )
    )
    await db.commit()  # la migration tourne sur une autre connexion
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0007")
        assert await _url_column(db) == []
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")

    # L'annonce existante survit à l'aller-retour, sans URL.
    assert await _url_column(db) == [("text", "YES", None)]
    assert await _rows(db, "select external_id, url from app.listings") == [("ext-old", None)]
