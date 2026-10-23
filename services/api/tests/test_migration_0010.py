"""Migration 0010 : schéma de l'identification du produit."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from alembic import command


async def _rows(db, sql: str, **params) -> list[tuple]:
    await db.rollback()  # lit l'état laissé par les migrations, jouées sur une autre connexion
    return [tuple(r) for r in (await db.execute(text(sql), params)).all()]


async def _insert_analysis(db, suffix: str) -> int:
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
                " input_hash, score)"
                " select :s, k.active_model_id, k.active_prompt_version_id, 1, :h, 10"
                " from app.scan_kinds k where k.code = 'full' returning id"
            ),
            {"s": snapshot_id, "h": f"input-{suffix}"},
        )
    ).scalar_one()


_INSERT_CALL = (
    "insert into app.llm_calls(analysis_id, model_id, prompt_version_id)"
    " select :a, k.active_model_id, k.active_prompt_version_id"
    " from app.scan_kinds k where k.code = 'full'"
)


async def test_upgrade_creates_tables_and_seeds_steps(db):
    full_model = (await _rows(db, "select active_model_id from app.scan_kinds where code='full'"))[
        0
    ][0]
    assert await _rows(
        db,
        "select code, active_model_id, active_prompt_version_id is not null from app.pipeline_steps"
        " order by code",
    ) == [
        ("criteria", full_model, True),  # prompts créés par 0011
        ("identify", full_model, True),
        ("read_photos", full_model, True),
    ]
    tables = await _rows(
        db,
        "select table_name from information_schema.tables where table_schema = 'app'"
        " and (table_name like 'identification%' or table_name like 'criteri%') order by 1",
    )
    assert [t[0] for t in tables] == [
        "criteria",
        "criteria_sets",
        "criteria_sources",
        "identification_checks",
        "identification_objects",
        "identification_pages",
        "identification_results",
        "identification_searches",
        "identifications",
    ]


async def test_settings_defaults(db):
    assert await _rows(
        db,
        "select identification_cache_ttl_hours, criteria_ttl_days, criteria_max_searches,"
        " criteria_max_pages, identify_retry_threshold, identify_image_side, scam_sends_photos,"
        " identify_escalation_model_id from app.settings where id = 1",
    ) == [(168, 180, 2, 3, 60, 1280, False, None)]


@pytest.mark.parametrize(
    ("column", "bad"),
    [
        ("identification_cache_ttl_hours", 0),
        ("identification_cache_ttl_hours", 2161),
        ("criteria_ttl_days", 731),
        ("criteria_max_searches", 6),
        ("criteria_max_pages", -1),
        ("identify_retry_threshold", 101),
        ("identify_image_side", 767),
        ("identify_image_side", 1537),
    ],
)
async def test_settings_bounds(db, column, bad):
    await db.rollback()
    with pytest.raises(IntegrityError):
        await db.execute(text(f"update app.settings set {column} = :v"), {"v": bad})
    await db.rollback()


async def test_prompt_version_needs_exactly_one_owner(db):
    await db.rollback()
    with pytest.raises(IntegrityError):
        await db.execute(
            text("insert into app.prompt_versions(version, system_prompt) values (9, 'x')")
        )
    await db.rollback()
    with pytest.raises(IntegrityError):
        await db.execute(
            text(
                "insert into app.prompt_versions(scan_kind, step, version, system_prompt)"
                " values ('full', 'identify', 9, 'x')"
            )
        )
    await db.rollback()


async def test_step_prompt_versions_are_unique_per_step(db):
    await db.rollback()
    insert = text(
        "insert into app.prompt_versions(step, version, system_prompt) values ('criteria', 99, 'x')"
    )
    await db.execute(insert)
    with pytest.raises(IntegrityError):
        await db.execute(insert)
    await db.rollback()


async def test_llm_call_scam_needs_analysis(db):
    await db.rollback()
    with pytest.raises(IntegrityError):
        await db.execute(
            text(
                "insert into app.llm_calls(step, model_id, prompt_version_id)"
                " select 'scam', k.active_model_id, k.active_prompt_version_id"
                " from app.scan_kinds k where k.code = 'full'"
            )
        )
    await db.rollback()


async def test_llm_call_has_at_most_one_target(db):
    analysis = await _insert_analysis(db, "target")
    await db.commit()
    snapshot = (await _rows(db, "select id from app.listing_snapshots"))[0][0]
    ident = (
        await db.execute(
            text(
                "insert into app.identifications(snapshot_id, config_hash, input_hash, status,"
                " confidence) values (:s, 'c', 'i', 'none', 0) returning id"
            ),
            {"s": snapshot},
        )
    ).scalar_one()
    base = (
        "insert into app.llm_calls(step, analysis_id, identification_id, model_id,"
        " prompt_version_id) select 'identify', :a, :i, k.active_model_id,"
        " k.active_prompt_version_id from app.scan_kinds k where k.code = 'full'"
    )
    with pytest.raises(IntegrityError):
        await db.execute(text(base), {"a": analysis, "i": ident})
    await db.rollback()


async def test_existing_llm_calls_become_scam(db, alembic_config):
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0009")
        analysis = await _insert_analysis(db, "scam")
        await db.execute(text(_INSERT_CALL), {"a": analysis})
        await db.commit()
        command.upgrade(alembic_config, "head")
        assert await _rows(db, "select step, analysis_id from app.llm_calls") == [
            ("scam", analysis)
        ]
    finally:
        await db.rollback()
        command.upgrade(alembic_config, "head")


async def test_downgrade_then_upgrade(db, alembic_config):
    analysis = await _insert_analysis(db, "down")
    await db.execute(text(_INSERT_CALL), {"a": analysis})
    snapshot = (await db.execute(text("select id from app.listing_snapshots limit 1"))).scalar_one()
    ident = (
        await db.execute(
            text(
                "insert into app.identifications(snapshot_id, config_hash, input_hash, status,"
                " confidence) values (:s, 'c', 'i', 'none', 0) returning id"
            ),
            {"s": snapshot},
        )
    ).scalar_one()
    await db.execute(
        text(
            "insert into app.llm_calls(step, identification_id, model_id, prompt_version_id)"
            " select 'read_photos', :i, k.active_model_id, k.active_prompt_version_id"
            " from app.scan_kinds k where k.code = 'full'"
        ),
        {"i": ident},
    )
    await db.commit()
    await db.rollback()
    try:
        command.downgrade(alembic_config, "0009")
        assert await _rows(db, "select analysis_id from app.llm_calls") == [(analysis,)]
        await db.rollback()
    finally:
        command.upgrade(alembic_config, "head")
    assert await _rows(db, "select code from app.pipeline_steps order by code") == [
        ("criteria",),
        ("identify",),
        ("read_photos",),
    ]


async def test_identification_flags_default_to_false(db):
    assert await _rows(
        db,
        "select column_name, is_nullable, column_default from information_schema.columns"
        " where table_schema = 'app' and table_name = 'identifications'"
        " and column_name in ('retried', 'unsourced', 'verified_criteria') order by 1",
    ) == [
        ("retried", "NO", "false"),
        ("unsourced", "NO", "false"),
        ("verified_criteria", "NO", "false"),
    ]
