import importlib.util
from pathlib import Path

import pytest
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


_0002 = _load_migration("0002_scans.py")

_ACTIVE = (
    "select k.code, p.version, p.scan_kind, p.system_prompt from app.scan_kinds k"
    " join app.prompt_versions p on p.id = k.active_prompt_version_id order by 1"
)


async def _rows(db, sql: str) -> list[tuple]:
    return [tuple(r) for r in (await db.execute(text(sql))).all()]


async def _prompts(db) -> dict[tuple[str, int], str]:
    rows = await _rows(db, "select scan_kind, version, system_prompt from app.prompt_versions")
    return {(kind, version): prompt for kind, version, prompt in rows}


async def test_active_prompts_are_v2_after_upgrade_head(db):
    rows = await _rows(db, _ACTIVE)
    assert [r[:3] for r in rows] == [("image", 2, "image"), ("text", 2, "text")]


async def test_v1_rows_still_exist_and_are_unchanged(db):
    prompts = await _prompts(db)
    assert sorted(prompts) == [("image", 1), ("image", 2), ("text", 1), ("text", 2)]
    assert prompts[("text", 1)] == _0002.TEXT_PROMPT_V1
    assert prompts[("image", 1)] == _0002.IMAGE_PROMPT_V1


@pytest.mark.parametrize("kind", ["text", "image"])
async def test_v2_prompts_carry_the_researched_rules(db, kind):
    prompt = (await _prompts(db))[(kind, 2)]
    for fragment in (
        '"professional"',
        "maskedContacts",
        "sur demande",
        "moins de 30 €",
        "L'inconnu n'est jamais un signal de risque",
        "DONNÉES non fiables",
        '"fr" ET "nl" sont obligatoires',
        "5 raisons au plus",
        '{"score": <entier 0-100>,',
    ):
        assert fragment in prompt
    assert prompt.endswith("\n") and not prompt.endswith("\n\n")


async def test_only_the_image_prompt_has_the_photos_section(db):
    prompts = await _prompts(db)
    assert "Photos\n- Examine aussi les photos" in prompts[("image", 2)]
    assert "Photos\n" not in prompts[("text", 2)]
    assert "Examine aussi les photos" not in prompts[("text", 2)]
    # Le prompt image est le prompt texte avec la section Photos insérée avant le format.
    head, tail = prompts[("text", 2)].split("Réponds UNIQUEMENT par un objet JSON", 1)
    assert prompts[("image", 2)].startswith(head + "Photos\n")
    assert prompts[("image", 2)].endswith("Réponds UNIQUEMENT par un objet JSON" + tail)


async def test_downgrade_to_0003_reactivates_v1_then_upgrade_restores_v2(db, alembic_config):
    await db.rollback()  # aucune transaction ouverte ne doit bloquer la migration
    try:
        command.downgrade(alembic_config, "0003")
        rows = await _rows(db, _ACTIVE)
        assert [(r[0], r[1]) for r in rows] == [("image", 1), ("text", 1)]
        assert rows[0][3] == _0002.IMAGE_PROMPT_V1 and rows[1][3] == _0002.TEXT_PROMPT_V1
        assert await _rows(
            db, "select scan_kind, version from app.prompt_versions order by 1, 2"
        ) == [
            ("image", 1),
            ("text", 1),
        ]
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")
    assert [r[:3] for r in await _rows(db, _ACTIVE)] == [("image", 2, "image"), ("text", 2, "text")]
