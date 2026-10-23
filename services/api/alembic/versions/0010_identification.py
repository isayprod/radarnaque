"""Schéma de l'identification du produit.

Étapes du pipeline (`pipeline_steps`) et leurs prompts (`prompt_versions.step`), réglages de
l'identification (`settings`), base de critères partagée (`criteria_*`), identifications et leur
déroulé (`identification*`), `scan_events.purpose` et `included_by_event_id`, et `llm_calls`
étendu aux étapes autres que l'arnaque.

Aucune de ces tables ne contient de donnée personnelle, sauf `scan_events` (déjà le cas). Les
prompts des étapes sont créés par la migration 0011 : `active_prompt_version_id` reste vide ici.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB

from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "app"

STEPS = ("read_photos", "criteria", "identify")

# Réglages : (colonne, défaut, borne basse, borne haute).
SETTINGS = (
    ("identification_cache_ttl_hours", "168", 1, 2160),
    ("criteria_ttl_days", "180", 1, 730),
    ("criteria_max_searches", "2", 0, 5),
    ("criteria_max_pages", "3", 0, 5),
    ("identify_retry_threshold", "60", 0, 100),
    ("identify_image_side", "1280", 768, 1536),
)


def _fk(target: str, **kwargs) -> sa.ForeignKey:
    return sa.ForeignKey(f"{S}.{target}", **kwargs)


def _created_at() -> sa.Column:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
    )


def _pages_columns() -> list[sa.Column]:
    return [
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("url", sa.Text, nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("domain", sa.Text, nullable=False),
    ]


def upgrade() -> None:
    # --- Étapes du pipeline et prompts -----------------------------------------------------
    op.create_table(
        "pipeline_steps",
        sa.Column("code", sa.Text, primary_key=True),
        sa.Column("active_model_id", sa.Integer, _fk("models.id"), nullable=False),
        sa.Column("active_prompt_version_id", sa.Integer, nullable=True),
        schema=S,
    )
    for code in STEPS:
        op.execute(
            f"insert into {S}.pipeline_steps(code, active_model_id)"
            f" select '{code}', active_model_id from {S}.scan_kinds where code = 'full'"
        )
    op.alter_column("prompt_versions", "scan_kind", nullable=True, schema=S)
    op.add_column("prompt_versions", sa.Column("step", sa.Text, nullable=True), schema=S)
    op.create_foreign_key(
        "prompt_versions_step_fkey",
        "prompt_versions",
        "pipeline_steps",
        ["step"],
        ["code"],
        source_schema=S,
        referent_schema=S,
    )
    op.create_check_constraint(
        "ck_prompt_versions_owner",
        "prompt_versions",
        "(scan_kind is null) <> (step is null)",
        schema=S,
    )
    op.create_unique_constraint(
        "uq_prompt_versions_step_version", "prompt_versions", ["step", "version"], schema=S
    )
    # Référence circulaire avec prompt_versions.step : la clé est différée.
    op.create_foreign_key(
        "pipeline_steps_active_prompt_version_id_fkey",
        "pipeline_steps",
        "prompt_versions",
        ["active_prompt_version_id"],
        ["id"],
        source_schema=S,
        referent_schema=S,
        deferrable=True,
        initially="DEFERRED",
    )

    # --- Réglages --------------------------------------------------------------------------
    for column, default, low, high in SETTINGS:
        op.add_column(
            "settings",
            sa.Column(column, sa.Integer, nullable=False, server_default=default),
            schema=S,
        )
        op.create_check_constraint(
            f"ck_settings_{column}", "settings", f"{column} between {low} and {high}", schema=S
        )
    op.add_column(
        "settings",
        sa.Column("scam_sends_photos", sa.Boolean, nullable=False, server_default=sa.false()),
        schema=S,
    )
    op.add_column(
        "settings",
        sa.Column("identify_escalation_model_id", sa.Integer, _fk("models.id"), nullable=True),
        schema=S,
    )

    # --- Base de critères ------------------------------------------------------------------
    op.create_table(
        "criteria_sets",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("candidates_key", sa.Text, nullable=False, unique=True),
        sa.Column("candidates", ARRAY(sa.Text), nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="auto"),
        _created_at(),
        sa.Column(
            "refreshed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status in ('auto', 'verified')", name="ck_criteria_sets_status"),
        schema=S,
    )
    op.create_table(
        "criteria",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column(
            "set_id",
            sa.BigInteger,
            _fk("criteria_sets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("decisive", sa.Boolean, nullable=False),
        sa.Column("text_fr", sa.Text, nullable=False),
        sa.Column("text_nl", sa.Text, nullable=False),
        sa.Column("expected", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("edited_by_admin", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.CheckConstraint("kind in ('photo', 'ask_seller')", name="ck_criteria_kind"),
        sa.UniqueConstraint("set_id", "position"),
        schema=S,
    )
    op.create_table(
        "criteria_sources",
        sa.Column(
            "criterion_id",
            sa.BigInteger,
            _fk("criteria.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        *[
            sa.Column(c.name, c.type, nullable=False, primary_key=c.name == "position")
            for c in _pages_columns()
        ],
        schema=S,
    )

    # --- Identifications -------------------------------------------------------------------
    op.create_table(
        "identifications",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("snapshot_id", sa.BigInteger, _fk("listing_snapshots.id"), nullable=False),
        sa.Column("config_hash", sa.Text, nullable=False),
        sa.Column("input_hash", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("confidence", sa.Integer, nullable=False),
        sa.Column(
            "photo_observations", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column("title_mismatch", sa.Text, nullable=True),
        sa.Column("seller_question_fr", sa.Text, nullable=True),
        sa.Column("seller_question_nl", sa.Text, nullable=True),
        sa.Column("retried", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("unsourced", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("images_analyzed", sa.Integer, nullable=False, server_default="0"),
        sa.Column("tokens_in", sa.Integer, nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cost_usd_micros", sa.BigInteger, nullable=False, server_default="0"),
        _created_at(),
        sa.CheckConstraint(
            "status in ('identified', 'uncertain', 'none')", name="ck_identifications_status"
        ),
        sa.CheckConstraint("confidence between 0 and 100", name="ck_identifications_confidence"),
        sa.UniqueConstraint("snapshot_id", "config_hash", "input_hash"),
        schema=S,
    )
    op.create_table(
        "identification_objects",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column(
            "identification_id",
            sa.BigInteger,
            _fk("identifications.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("role", sa.Text, nullable=False),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("reference", sa.Text, nullable=True),
        sa.Column("confidence", sa.Integer, nullable=False),
        sa.Column("remaining", ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'")),
        sa.Column(
            "criteria_set_id",
            sa.BigInteger,
            _fk("criteria_sets.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.CheckConstraint("role in ('main', 'accessory')", name="ck_identification_objects_role"),
        sa.CheckConstraint(
            "confidence between 0 and 100", name="ck_identification_objects_confidence"
        ),
        sa.UniqueConstraint("identification_id", "position"),
        schema=S,
    )
    op.create_table(
        "identification_checks",
        sa.Column(
            "object_id",
            sa.BigInteger,
            _fk("identification_objects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("position", sa.Integer, primary_key=True),
        # Critère de la base partagée, qui peut être rafraîchie : la vérification garde sa copie.
        sa.Column(
            "criterion_id",
            sa.BigInteger,
            _fk("criteria.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("text_fr", sa.Text, nullable=False),
        sa.Column("text_nl", sa.Text, nullable=False),
        sa.Column("decisive", sa.Boolean, nullable=False),
        sa.Column(
            "sources",
            JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("observation", sa.Text, nullable=False),
        sa.Column("photo_index", sa.Integer, nullable=True),
        sa.CheckConstraint(
            "observation in ('seen_match', 'seen_contrary', 'not_visible')",
            name="ck_identification_checks_observation",
        ),
        schema=S,
    )
    op.create_table(
        "identification_pages",
        sa.Column(
            "object_id",
            sa.BigInteger,
            _fk("identification_objects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        *[
            sa.Column(c.name, c.type, nullable=False, primary_key=c.name == "position")
            for c in _pages_columns()
        ],
        schema=S,
    )
    op.create_table(
        "identification_searches",
        sa.Column(
            "identification_id",
            sa.BigInteger,
            _fk("identifications.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("position", sa.Integer, primary_key=True),
        sa.Column("query", sa.Text, nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("pages_read", ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'")),
        sa.CheckConstraint(
            "kind in ('criteria', 'price', 'reference', 'retry')",
            name="ck_identification_searches_kind",
        ),
        schema=S,
    )
    op.create_table(
        "identification_results",
        sa.Column(
            "scan_event_id",
            sa.BigInteger,
            _fk("scan_events.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("identification_id", sa.BigInteger, _fk("identifications.id"), nullable=False),
        schema=S,
    )
    op.create_index(
        "ix_identification_results_identification_id",
        "identification_results",
        ["identification_id"],
        schema=S,
    )

    # --- scan_events -----------------------------------------------------------------------
    op.add_column(
        "scan_events",
        sa.Column("purpose", sa.Text, nullable=False, server_default="analyze"),
        schema=S,
    )
    op.create_check_constraint(
        "ck_scan_events_purpose", "scan_events", "purpose in ('identify', 'analyze')", schema=S
    )
    op.add_column(
        "scan_events",
        sa.Column(
            "included_by_event_id",
            sa.BigInteger,
            _fk("scan_events.id", ondelete="SET NULL"),
            nullable=True,
        ),
        schema=S,
    )
    op.create_index(
        "ix_scan_events_user_purpose_time",
        "scan_events",
        ["user_id", "purpose", "created_at"],
        schema=S,
    )

    # --- llm_calls -------------------------------------------------------------------------
    op.alter_column("llm_calls", "analysis_id", nullable=True, schema=S)
    op.add_column(
        "llm_calls",
        sa.Column("step", sa.Text, nullable=False, server_default="scam"),
        schema=S,
    )
    op.add_column(
        "llm_calls",
        sa.Column("identification_id", sa.BigInteger, _fk("identifications.id"), nullable=True),
        schema=S,
    )
    op.add_column(
        "llm_calls",
        sa.Column(
            "criteria_set_id",
            sa.BigInteger,
            _fk("criteria_sets.id", ondelete="SET NULL"),
            nullable=True,
        ),
        schema=S,
    )
    op.create_check_constraint(
        "ck_llm_calls_step",
        "llm_calls",
        "step in ('read_photos', 'criteria', 'identify', 'scam')",
        schema=S,
    )
    op.create_check_constraint(
        "ck_llm_calls_target",
        "llm_calls",
        "num_nonnulls(analysis_id, identification_id, criteria_set_id) <= 1"
        " and (step <> 'scam' or analysis_id is not null)",
        schema=S,
    )
    op.create_index("ix_llm_calls_identification_id", "llm_calls", ["identification_id"], schema=S)


def downgrade() -> None:
    op.drop_index("ix_llm_calls_identification_id", table_name="llm_calls", schema=S)
    op.drop_constraint("ck_llm_calls_target", "llm_calls", schema=S, type_="check")
    op.drop_constraint("ck_llm_calls_step", "llm_calls", schema=S, type_="check")
    # Les appels des nouvelles étapes n'ont pas d'analyse : ils disparaissent.
    op.execute(f"delete from {S}.llm_calls where analysis_id is null")
    op.drop_column("llm_calls", "criteria_set_id", schema=S)
    op.drop_column("llm_calls", "identification_id", schema=S)
    op.drop_column("llm_calls", "step", schema=S)
    op.alter_column("llm_calls", "analysis_id", nullable=False, schema=S)

    op.drop_index("ix_scan_events_user_purpose_time", table_name="scan_events", schema=S)
    op.drop_column("scan_events", "included_by_event_id", schema=S)
    op.drop_constraint("ck_scan_events_purpose", "scan_events", schema=S, type_="check")
    op.drop_column("scan_events", "purpose", schema=S)

    op.drop_table("identification_results", schema=S)
    op.drop_table("identification_searches", schema=S)
    op.drop_table("identification_pages", schema=S)
    op.drop_table("identification_checks", schema=S)
    op.drop_table("identification_objects", schema=S)
    op.drop_table("identifications", schema=S)
    op.drop_table("criteria_sources", schema=S)
    op.drop_table("criteria", schema=S)
    op.drop_table("criteria_sets", schema=S)

    op.drop_column("settings", "identify_escalation_model_id", schema=S)
    op.drop_column("settings", "scam_sends_photos", schema=S)
    for column, _default, _low, _high in reversed(SETTINGS):
        op.drop_constraint(f"ck_settings_{column}", "settings", schema=S, type_="check")
        op.drop_column("settings", column, schema=S)

    op.drop_constraint(
        "pipeline_steps_active_prompt_version_id_fkey",
        "pipeline_steps",
        schema=S,
        type_="foreignkey",
    )
    op.execute(f"delete from {S}.prompt_versions where step is not null")
    op.drop_constraint(
        "uq_prompt_versions_step_version", "prompt_versions", schema=S, type_="unique"
    )
    op.drop_constraint("ck_prompt_versions_owner", "prompt_versions", schema=S, type_="check")
    op.drop_constraint("prompt_versions_step_fkey", "prompt_versions", schema=S, type_="foreignkey")
    op.drop_column("prompt_versions", "step", schema=S)
    op.alter_column("prompt_versions", "scan_kind", nullable=False, schema=S)
    op.drop_table("pipeline_steps", schema=S)
