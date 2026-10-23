import importlib.util
from pathlib import Path

from sqlalchemy import text

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


_0005 = _load_migration("0005_full_scans.py")
_0009 = _load_migration("0009_prompt_attributes.py")
_0011 = _load_migration("0011_identification_prompts.py")

_ACTIVE = (
    "select p.version, p.system_prompt from app.scan_kinds k"
    " join app.prompt_versions p on p.id = k.active_prompt_version_id where k.code = 'full'"
)
_FULL = "select version, system_prompt from app.prompt_versions where scan_kind = 'full' order by 1"


async def _rows(db, sql: str, **params) -> list[tuple]:
    await db.rollback()  # lit l'état laissé par les migrations, jouées sur une autre connexion
    return [tuple(r) for r in (await db.execute(text(sql), params)).all()]


def test_new_prompt_is_v1_plus_the_attributes():
    prompt = _0009.FULL_PROMPT_ATTRIBUTES
    assert _0009.FULL_PROMPT_V1 == _0005.FULL_PROMPT_V1
    assert "caractéristiques (attributes : libellé et valeur" in prompt
    assert "(titre, description, caractéristiques, faits sur le vendeur," in prompt
    restored = prompt
    for old, new in _0009.AMENDMENTS:
        restored = restored.replace(new, old)
    assert restored == _0005.FULL_PROMPT_V1


async def test_attributes_prompt_is_active_after_head_and_v1_unchanged(db):
    # 0011 a activé la v3 au-dessus de celle de 0009.
    assert await _rows(db, _ACTIVE) == [(3, _0011.FULL_PROMPT_V3)]
    assert await _rows(db, _FULL) == [
        (1, _0005.FULL_PROMPT_V1),
        (2, _0009.FULL_PROMPT_ATTRIBUTES),
        (3, _0011.FULL_PROMPT_V3),
    ]


async def test_downgrade_reactivates_v1_and_upgrade_restores(db, alembic_config):
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0008")
        assert await _rows(db, _ACTIVE) == [(1, _0005.FULL_PROMPT_V1)]
        assert await _rows(db, _FULL) == [(1, _0005.FULL_PROMPT_V1)]
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")
    assert await _rows(db, _ACTIVE) == [(3, _0011.FULL_PROMPT_V3)]


async def test_a_prompt_chosen_in_the_admin_stays_active(db, alembic_config):
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0008")
        await db.execute(
            text(
                "insert into app.prompt_versions(scan_kind, version, system_prompt)"
                " values ('full', 2, 'prompt de l''admin')"
            )
        )
        await db.execute(
            text(
                "update app.scan_kinds set active_prompt_version_id ="
                " (select id from app.prompt_versions where scan_kind = 'full' and version = 2)"
                " where code = 'full'"
            )
        )
        await db.commit()
        command.upgrade(alembic_config, "head")
        # Rejouée : pas de doublon, la version de l'admin reste active.
        command.downgrade(alembic_config, "0008")
        command.upgrade(alembic_config, "head")
        assert await _rows(db, _ACTIVE) == [(2, "prompt de l'admin")]
        assert await _rows(db, _FULL) == [
            (1, _0005.FULL_PROMPT_V1),
            (2, "prompt de l'admin"),
            (3, _0009.FULL_PROMPT_ATTRIBUTES),
            (4, _0011.FULL_PROMPT_V3),
        ]
    finally:
        await db.rollback()
        command.downgrade(alembic_config, "0008")
        await db.execute(
            text(
                "update app.scan_kinds set active_prompt_version_id ="
                " (select id from app.prompt_versions where scan_kind = 'full' and version = 1)"
                " where code = 'full'"
            )
        )
        await db.execute(
            text("delete from app.prompt_versions where scan_kind = 'full' and version = 2")
        )
        await db.commit()
        command.upgrade(alembic_config, "head")
