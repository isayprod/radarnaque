import importlib.util
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from alembic import command

_VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"


def _load_migration(filename: str):
    """Charge un module de migration par son chemin (son nom commence par un chiffre)."""
    spec = importlib.util.spec_from_file_location(
        filename.removesuffix(".py"), _VERSIONS / filename
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_0004 = _load_migration("0004_prompt_v2.py")
_0005 = _load_migration("0005_full_scans.py")


async def _rows(db, sql: str, **params) -> list[tuple]:
    return [tuple(r) for r in (await db.execute(text(sql), params)).all()]


async def _column_exists(db, table: str, column: str) -> bool:
    return bool(
        await _rows(
            db,
            "select 1 from information_schema.columns where table_schema = 'app'"
            " and table_name = :t and column_name = :c",
            t=table,
            c=column,
        )
    )


async def _table_exists(db, table: str) -> bool:
    return bool(
        await _rows(
            db,
            "select 1 from information_schema.tables where table_schema = 'app'"
            " and table_name = :t",
            t=table,
        )
    )


def test_prompt_constants_reuse_the_0004_texts():
    assert _0005.FULL_PROMPT_V1 == (
        _0004.COMMON_V2 + "\n" + _0004.IMAGE_V2 + "\n" + _0005.SEARCH_V1 + "\n" + _0004.FORMAT_V2
    )
    assert _0005.COMMON_V2 == _0004.COMMON_V2
    assert _0005.IMAGE_V2 == _0004.IMAGE_V2
    assert _0005.FORMAT_V2 == _0004.FORMAT_V2


async def test_full_kind_uses_image_model(db):
    rows = await _rows(
        db,
        "select f.active_model_id = i.active_model_id from app.scan_kinds f, app.scan_kinds i"
        " where f.code = 'full' and i.code = 'image'",
    )
    assert rows == [(True,)]


async def test_full_prompt_v1_active(db):
    rows = await _rows(
        db,
        "select p.version, p.scan_kind, p.system_prompt from app.scan_kinds k"
        " join app.prompt_versions p on p.id = k.active_prompt_version_id where k.code = 'full'",
    )
    assert rows == [(1, "full", _0005.FULL_PROMPT_V1)]


def test_full_prompt_contains_search_rules():
    for fragment in (
        "web_search",
        "n'existe pas",
        "Réfléchis en français",
        "<resultats_recherche>",
    ):
        assert fragment in _0005.FULL_PROMPT_V1


async def test_full_quotas_and_images(db):
    quotas = {
        (plan, kind): quota
        for plan, kind, quota in await _rows(
            db, "select plan, scan_kind, quota from app.plan_quotas"
        )
    }
    assert quotas[("trial", "full")] == 3
    assert quotas[("standard", "full")] == 150
    assert quotas[("premium", "full")] == 300
    images = dict(await _rows(db, "select code, max_images from app.plans"))
    assert images == {"trial": 4, "standard": 1, "premium": 4}


async def test_plan_quotas_only_full(db):
    quotas = {
        (plan, kind): quota
        for plan, kind, quota in await _rows(
            db, "select plan, scan_kind, quota from app.plan_quotas"
        )
    }
    assert quotas == {("trial", "full"): 3, ("standard", "full"): 150, ("premium", "full"): 300}


async def test_image_scan_feature_removed(db):
    assert await _rows(db, "select 1 from app.features where code = 'image_scan'") == []
    assert await _rows(db, "select 1 from app.plan_features where feature = 'image_scan'") == []
    assert await _rows(db, "select plan, feature from app.plan_features order by 1, 2") == [
        ("premium", "card_icons"),
        ("trial", "card_icons"),
    ]


async def test_max_images_is_checked_between_0_and_4(db):
    with pytest.raises(IntegrityError):
        await db.execute(text("update app.plans set max_images = 5 where code = 'trial'"))
    await db.rollback()


async def test_settings_max_web_searches(db):
    assert await _rows(db, "select max_web_searches from app.settings") == [(3,)]
    with pytest.raises(IntegrityError):
        await db.execute(text("update app.settings set max_web_searches = 6"))
    await db.rollback()


async def test_analysis_web_searches_table(db):
    assert await _column_exists(db, "analyses", "images_analyzed")
    rows = await _rows(
        db,
        "select column_name from information_schema.columns where table_schema = 'app'"
        " and table_name = 'analysis_web_searches' order by ordinal_position",
    )
    assert rows == [("analysis_id",), ("position",), ("query",), ("aspect",)]


async def _assert_after_0004_offer(db) -> None:
    """Quotas et fonctionnalités tels que 0001 les sème (état après 0004)."""
    assert await _rows(
        db, "select plan, scan_kind, quota from app.plan_quotas order by plan, scan_kind"
    ) == [
        ("premium", "image", 100),
        ("premium", "text", 1000),
        ("standard", "image", 0),
        ("standard", "text", 150),
        ("trial", "image", 3),
        ("trial", "text", 3),
    ]
    assert await _rows(db, "select code from app.features order by 1") == [
        ("card_icons",),
        ("image_scan",),
    ]
    assert await _rows(db, "select plan, feature from app.plan_features order by 1, 2") == [
        ("premium", "card_icons"),
        ("premium", "image_scan"),
        ("trial", "card_icons"),
        ("trial", "image_scan"),
    ]


async def test_downgrade_restores_text_image(db, alembic_config):
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0004")
        await _assert_after_0004_offer(db)
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")


async def test_downgrade_removes_full(db, alembic_config):
    await db.rollback()  # aucune transaction ouverte ne doit bloquer la migration
    try:
        command.downgrade(alembic_config, "0004")
        assert await _rows(db, "select code from app.scan_kinds order by 1") == [
            ("image",),
            ("text",),
        ]
        assert await _rows(db, "select 1 from app.prompt_versions where scan_kind = 'full'") == []
        assert await _rows(db, "select 1 from app.plan_quotas where scan_kind = 'full'") == []
        assert not await _column_exists(db, "plans", "max_images")
        assert not await _column_exists(db, "settings", "max_web_searches")
        assert not await _column_exists(db, "analyses", "images_analyzed")
        assert not await _table_exists(db, "analysis_web_searches")
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")
    # Le cycle complet restitue l'état d'origine.
    assert await _rows(db, "select code from app.scan_kinds order by 1") == [
        ("full",),
        ("image",),
        ("text",),
    ]
    assert await _table_exists(db, "analysis_web_searches")
    assert await _rows(db, "select plan, scan_kind from app.plan_quotas order by 1, 2") == [
        ("premium", "full"),
        ("standard", "full"),
        ("trial", "full"),
    ]
    assert await _rows(db, "select code from app.features") == [("card_icons",)]


async def test_downgrade_keeps_full_when_used(db, make_user, alembic_config):
    uid = await make_user("full-user@example.test")
    await db.execute(
        text(
            "insert into app.scan_events(user_id, scan_kind, trigger) values (:u, 'full', 'button')"
        ),
        {"u": uid},
    )
    await db.commit()  # le downgrade tourne sur une autre connexion
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0004")  # ne doit pas échouer
        assert await _rows(db, "select code from app.scan_kinds order by 1") == [
            ("full",),
            ("image",),
            ("text",),
        ]
        assert await _rows(
            db, "select scan_kind, version from app.prompt_versions where scan_kind = 'full'"
        ) == [("full", 1)]
        assert await _rows(db, "select 1 from app.plan_quotas where scan_kind = 'full'") == []
        await _assert_after_0004_offer(db)
        assert not await _column_exists(db, "plans", "max_images")
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")  # ne doit pas échouer non plus
    assert await _rows(
        db,
        "select p.system_prompt from app.scan_kinds k"
        " join app.prompt_versions p on p.id = k.active_prompt_version_id where k.code = 'full'",
    ) == [(_0005.FULL_PROMPT_V1,)]
    assert await _rows(db, "select plan from app.plan_quotas where scan_kind = 'full'") != []
