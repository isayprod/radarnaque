"""Migration 0011 : prompts des étapes d'identification et prompt `full` v3."""

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


_0009 = _load_migration("0009_prompt_attributes.py")
_0011 = _load_migration("0011_identification_prompts.py")

_STEPS = {
    "read_photos": _0011.READ_PHOTOS_V1,
    "criteria": _0011.CRITERIA_V1,
    "identify": _0011.IDENTIFY_V1,
}
_STEP_ACTIVE = (
    "select s.code, p.step, p.version, p.system_prompt from app.pipeline_steps s"
    " join app.prompt_versions p on p.id = s.active_prompt_version_id order by s.code"
)
_FULL_ACTIVE = (
    "select p.version, p.system_prompt from app.scan_kinds k"
    " join app.prompt_versions p on p.id = k.active_prompt_version_id where k.code = 'full'"
)
_FULL = "select version, system_prompt from app.prompt_versions where scan_kind = 'full' order by 1"


async def _rows(db, sql: str, **params) -> list[tuple]:
    await db.rollback()  # lit l'état laissé par les migrations, jouées sur une autre connexion
    return [tuple(r) for r in (await db.execute(text(sql), params)).all()]


async def test_each_step_has_active_v1(db):
    assert await _rows(db, _STEP_ACTIVE) == [
        (code, code, 1, _STEPS[code]) for code in sorted(_STEPS)
    ]


async def test_full_v3_activated_when_0009_active(db):
    assert await _rows(db, _FULL_ACTIVE) == [(3, _0011.FULL_PROMPT_V3)]
    assert await _rows(db, _FULL) == [
        (1, (await _rows(db, _FULL))[0][1]),
        (2, _0009.FULL_PROMPT_ATTRIBUTES),
        (3, _0011.FULL_PROMPT_V3),
    ]
    assert _0011.FULL_PROMPT_V3.startswith(_0009.FULL_PROMPT_ATTRIBUTES.rstrip("\n"))
    assert "<identification>" in _0011.FULL_PROMPT_V3


async def test_full_v3_not_activated_when_admin_chose_another(db, alembic_config):
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0010")
        await db.execute(
            text(
                "insert into app.prompt_versions(scan_kind, version, system_prompt)"
                " values ('full', 3, 'prompt de l''admin')"
            )
        )
        await db.execute(
            text(
                "update app.scan_kinds set active_prompt_version_id ="
                " (select id from app.prompt_versions where scan_kind = 'full' and version = 3)"
                " where code = 'full'"
            )
        )
        await db.commit()
        command.upgrade(alembic_config, "head")
        assert await _rows(db, _FULL_ACTIVE) == [(3, "prompt de l'admin")]
        assert await _rows(db, _FULL) == [
            (1, (await _rows(db, _FULL))[0][1]),
            (2, _0009.FULL_PROMPT_ATTRIBUTES),
            (3, "prompt de l'admin"),
            (4, _0011.FULL_PROMPT_V3),
        ]
    finally:
        await db.rollback()
        command.downgrade(alembic_config, "0010")
        await db.execute(
            text(
                "update app.scan_kinds set active_prompt_version_id ="
                " (select id from app.prompt_versions where scan_kind = 'full' and version = 2)"
                " where code = 'full'"
            )
        )
        await db.execute(
            text("delete from app.prompt_versions where scan_kind = 'full' and version = 3")
        )
        await db.commit()
        command.upgrade(alembic_config, "head")


def test_prompts_within_admin_bounds():
    for text_ in (*_STEPS.values(), _0011.FULL_PROMPT_V3):
        assert 200 <= len(text_) <= 20_000


async def test_upgrade_is_idempotent_after_downgrade(db, alembic_config):
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0010")
        assert await _rows(db, _STEP_ACTIVE) == []
        assert await _rows(db, "select step from app.prompt_versions where step is not null") == []
        assert await _rows(db, _FULL_ACTIVE) == [(2, _0009.FULL_PROMPT_ATTRIBUTES)]
        assert [r[0] for r in await _rows(db, _FULL)] == [1, 2]
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")
    command.downgrade(alembic_config, "0010")
    command.upgrade(alembic_config, "head")
    assert len(await _rows(db, _STEP_ACTIVE)) == 3
    assert await _rows(db, _FULL_ACTIVE) == [(3, _0011.FULL_PROMPT_V3)]
    assert [r[0] for r in await _rows(db, _FULL)] == [1, 2, 3]
