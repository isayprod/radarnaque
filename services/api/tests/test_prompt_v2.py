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
_0004 = _load_migration("0004_prompt_v2.py")

# Le type `full` (0005) a ses propres versions : ces tests ne regardent que `text` et `image`.
_VERSIONS_SQL = (
    "select scan_kind, version from app.prompt_versions where scan_kind <> 'full' order by 1, 2"
)
_ACTIVE = (
    "select k.code, p.version, p.scan_kind, p.system_prompt from app.scan_kinds k"
    " join app.prompt_versions p on p.id = k.active_prompt_version_id"
    " where k.code <> 'full' order by 1"
)


async def _rows(db, sql: str) -> list[tuple]:
    return [tuple(r) for r in (await db.execute(text(sql))).all()]


async def _prompts(db) -> dict[tuple[str, int], str]:
    rows = await _rows(
        db,
        "select scan_kind, version, system_prompt from app.prompt_versions"
        " where scan_kind <> 'full'",
    )
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
        # Amendements R6 (vague finale, avant publication).
        "N'invente jamais",
        "sous forme de fourchette",
        "signal modéré",
        "animal, ticket",
        "camping-cars et caravanes",
        "électroménager neuf en boîte",
        "Un prix « sur demande » seul ne suffit pas",
        "sans facture ni numéro de cadre : score 55",
    ):
        assert fragment in prompt
    # L'ancienne formulation (maskedContacts = signal fort à lui seul) a disparu.
    assert "maskedContacts supérieur à 0) ;" not in prompt
    assert "Vélo électrique récent à 250 €" not in prompt
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
            db,
            _VERSIONS_SQL,
        ) == [
            ("image", 1),
            ("text", 1),
        ]
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")
    assert [r[:3] for r in await _rows(db, _ACTIVE)] == [("image", 2, "image"), ("text", 2, "text")]


async def test_downgrade_keeps_a_v2_row_referenced_by_an_analysis(db, alembic_config):
    site = (
        await db.execute(text("select id from app.sites where domain = '2ememain.be'"))
    ).scalar_one()
    listing = (
        await db.execute(
            text("insert into app.listings(site_id, external_id) values (:s, 'v2') returning id"),
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
    await db.execute(
        text(
            "insert into app.analyses(snapshot_id, model_id, prompt_version_id, rules_version,"
            " input_hash, score)"
            " select :s, k.active_model_id, k.active_prompt_version_id, 1, 'i', 50"
            " from app.scan_kinds k where k.code = 'text'"
        ),
        {"s": snap},
    )
    await (
        db.commit()
    )  # le downgrade tourne sur une autre connexion : les lignes doivent être validées
    v2_text_id = (
        await db.execute(
            text("select id from app.prompt_versions where scan_kind = 'text' and version = 2")
        )
    ).scalar_one()
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0003")  # ne doit pas échouer
        rows = await _rows(db, _ACTIVE)
        assert [(r[0], r[1]) for r in rows] == [("image", 1), ("text", 1)]
        # La v2 texte, référencée par une analyse, est conservée ; la v2 image est supprimée.
        assert await _rows(
            db,
            _VERSIONS_SQL,
        ) == [("image", 1), ("text", 1), ("text", 2)]
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")  # ne doit pas échouer non plus
    assert [r[:3] for r in await _rows(db, _ACTIVE)] == [("image", 2, "image"), ("text", 2, "text")]
    assert await _rows(
        db,
        _VERSIONS_SQL,
    ) == [
        ("image", 1),
        ("image", 2),
        ("text", 1),
        ("text", 2),
    ]
    # La ligne v2 texte n'a pas été recréée : l'analyse pointe toujours vers elle.
    assert (
        await db.execute(
            text("select count(*) from app.analyses where prompt_version_id = :p"),
            {"p": v2_text_id},
        )
    ).scalar_one() == 1
    active_text_id = (
        await db.execute(
            text("select active_prompt_version_id from app.scan_kinds where code = 'text'")
        )
    ).scalar_one()
    assert active_text_id == v2_text_id


async def test_upgrade_refuses_an_existing_v2_with_a_different_text(db, alembic_config):
    """R6 : une v2 au texte différent (ancienne 0004) bloque l'upgrade au lieu d'être gardée."""
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0003")
        await db.execute(
            text(
                "insert into app.prompt_versions(scan_kind, version, system_prompt)"
                " values ('text', 2, 'ancien texte v2')"
            )
        )
        await db.commit()
        with pytest.raises(
            RuntimeError,
            match=r"prompt_versions \(text, 2\) existe avec un autre texte : réinitialiser la base"
            r" de dev ou créer une v3",
        ):
            command.upgrade(alembic_config, "head")
        # L'upgrade a échoué en entier : la base reste en 0003, v1 active.
        rows = await _rows(db, _ACTIVE)
        assert [(r[0], r[1]) for r in rows] == [("image", 1), ("text", 1)]
        await db.rollback()
    finally:
        # Sans effet si la base est déjà en 0003 ; sinon v1 réactivée, v2 non référencée supprimée.
        await db.rollback()
        command.downgrade(alembic_config, "0003")
        await db.execute(text("delete from app.prompt_versions where version = 2"))
        await db.commit()
        command.upgrade(alembic_config, "head")
    prompts = await _prompts(db)
    assert prompts[("text", 2)] == _0004.TEXT_PROMPT_V2
    assert prompts[("image", 2)] == _0004.IMAGE_PROMPT_V2


async def test_upgrade_accepts_an_existing_v2_with_the_same_text(db, alembic_config):
    """Le cas idempotent (v2 identique conservée par un downgrade) passe toujours."""
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0003")
        await db.execute(
            text(
                "insert into app.prompt_versions(scan_kind, version, system_prompt)"
                " values ('text', 2, :p)"
            ),
            {"p": _0004.TEXT_PROMPT_V2},
        )
        await db.commit()
    finally:
        command.upgrade(alembic_config, "head")
    assert [r[:3] for r in await _rows(db, _ACTIVE)] == [("image", 2, "image"), ("text", 2, "text")]
