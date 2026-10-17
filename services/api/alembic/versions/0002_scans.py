"""Annonces, snapshots, analyses, prompts, réglages et résultats de scan, avec données initiales.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-17
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "app"

_COMMON_PROMPT = """\
Tu es un expert anti-arnaque des petites annonces belges (2ememain, 2dehands, \
Facebook Marketplace). On te fournit les faits d'une annonce et les signaux détectés par des \
règles locales. Ta mission : estimer le risque qu'il s'agisse d'une arnaque.

Règles :
- N'utilise que les faits fournis. N'invente jamais d'information.
- Tiens compte des signaux des règles locales sans les répéter mot pour mot.
- Les numéros de téléphone et les emails de la description sont masqués \
(« [téléphone] », « [email] ») : ne le signale pas comme suspect en soi.
- Donne un score entier de 0 (aucun risque) à 100 (arnaque quasi certaine).
"""

_IMAGE_PROMPT = """\
- Examine aussi la cohérence des photos : photo de catalogue ou de site marchand, filigrane \
d'un autre site, incohérence avec le titre ou la description.
"""

_ANSWER_FORMAT = """\
Réponds UNIQUEMENT par un objet JSON, sans texte autour, de cette forme exacte :
{"score": <entier 0-100>,
 "summary": {"fr": "<résumé>", "nl": "<samenvatting>"},
 "advice": {"fr": "<conseil>", "nl": "<advies>"},
 "reasons": [{"severity": "info|warning|danger", "fr": "<raison>", "nl": "<reden>"}]}

Contraintes :
- "summary" : 2 phrases au plus, dans chaque langue.
- "advice" : 1 phrase, dans chaque langue.
- "reasons" : 5 raisons au plus, de la plus grave à la moins grave.
- Les textes français et néerlandais disent la même chose.
"""

TEXT_PROMPT_V1 = _COMMON_PROMPT + "\n" + _ANSWER_FORMAT
IMAGE_PROMPT_V1 = _COMMON_PROMPT + _IMAGE_PROMPT + "\n" + _ANSWER_FORMAT


def _ts(name: str, *, default_now: bool = False) -> sa.Column:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        nullable=False,
        server_default=sa.text("now()") if default_now else None,
    )


def _fk(target: str, **kw) -> sa.ForeignKey:
    return sa.ForeignKey(f"{S}.{target}", **kw)


def upgrade() -> None:
    # Référentiels.
    op.create_table("locales", sa.Column("code", sa.Text, primary_key=True), schema=S)
    op.create_table("severities", sa.Column("code", sa.Text, primary_key=True), schema=S)
    op.create_table(
        "marketplaces",
        sa.Column("id", sa.Integer, sa.Identity(), primary_key=True),
        sa.Column("code", sa.Text, nullable=False, unique=True),
        schema=S,
    )
    op.create_table(
        "sites",
        sa.Column("id", sa.Integer, sa.Identity(), primary_key=True),
        sa.Column("marketplace_id", sa.Integer, _fk("marketplaces.id"), nullable=False),
        sa.Column("domain", sa.Text, nullable=False, unique=True),
        sa.Column("default_locale", sa.Text, _fk("locales.code"), nullable=False),
        schema=S,
    )
    op.create_table(
        "site_image_hosts",
        sa.Column("site_id", sa.Integer, _fk("sites.id"), primary_key=True),
        sa.Column("host_suffix", sa.Text, primary_key=True),
        schema=S,
    )
    op.create_table(
        "settings",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("cache_ttl_hours", sa.Integer, nullable=False),
        sa.Column("rate_limit_per_minute", sa.Integer, nullable=False),
        sa.CheckConstraint("id = 1", name="ck_settings_single_row"),
        schema=S,
    )
    op.create_table(
        "prompt_versions",
        sa.Column("id", sa.Integer, sa.Identity(), primary_key=True),
        sa.Column("scan_kind", sa.Text, _fk("scan_kinds.code"), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("system_prompt", sa.Text, nullable=False),
        _ts("created_at", default_now=True),
        sa.UniqueConstraint("scan_kind", "version"),
        schema=S,
    )
    # Référence circulaire avec prompt_versions.scan_kind : la clé est différée.
    op.add_column("scan_kinds", sa.Column("active_prompt_version_id", sa.Integer), schema=S)
    op.create_foreign_key(
        "scan_kinds_active_prompt_version_id_fkey",
        "scan_kinds",
        "prompt_versions",
        ["active_prompt_version_id"],
        ["id"],
        source_schema=S,
        referent_schema=S,
        deferrable=True,
        initially="DEFERRED",
    )

    # Annonces et cache.
    op.create_table(
        "listings",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("site_id", sa.Integer, _fk("sites.id"), nullable=False),
        sa.Column("external_id", sa.Text, nullable=False),
        sa.UniqueConstraint("site_id", "external_id"),
        schema=S,
    )
    op.create_table(
        "listing_snapshots",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("listing_id", sa.BigInteger, _fk("listings.id"), nullable=False),
        sa.Column("content_hash", sa.Text, nullable=False),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("price_cents", sa.Integer),
        sa.Column("currency", sa.Text, _fk("currencies.code")),
        _ts("captured_at", default_now=True),
        sa.UniqueConstraint("listing_id", "content_hash"),
        schema=S,
    )
    op.create_table(
        "snapshot_images",
        sa.Column("snapshot_id", sa.BigInteger, _fk("listing_snapshots.id"), primary_key=True),
        sa.Column("position", sa.Integer, primary_key=True),
        sa.Column("url", sa.Text, nullable=False),
        schema=S,
    )
    op.create_table(
        "analyses",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("snapshot_id", sa.BigInteger, _fk("listing_snapshots.id"), nullable=False),
        sa.Column("model_id", sa.Integer, _fk("models.id"), nullable=False),
        sa.Column("prompt_version_id", sa.Integer, _fk("prompt_versions.id"), nullable=False),
        sa.Column("rules_version", sa.Integer, nullable=False),
        sa.Column("input_hash", sa.Text, nullable=False),
        sa.Column("score", sa.Integer, nullable=False),
        sa.Column("partial", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("tokens_in", sa.Integer, nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cost_usd_micros", sa.BigInteger, nullable=False, server_default="0"),
        _ts("created_at", default_now=True),
        sa.CheckConstraint("score between 0 and 100", name="ck_analyses_score_range"),
        sa.UniqueConstraint("snapshot_id", "model_id", "prompt_version_id", "input_hash"),
        schema=S,
    )
    op.create_table(
        "analysis_texts",
        sa.Column("analysis_id", sa.BigInteger, _fk("analyses.id"), primary_key=True),
        sa.Column("locale", sa.Text, _fk("locales.code"), primary_key=True),
        sa.Column("summary", sa.Text, nullable=False),
        sa.Column("advice", sa.Text, nullable=False),
        schema=S,
    )
    op.create_table(
        "analysis_reasons",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("analysis_id", sa.BigInteger, _fk("analyses.id"), nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("severity", sa.Text, _fk("severities.code"), nullable=False),
        sa.UniqueConstraint("analysis_id", "position"),
        schema=S,
    )
    op.create_table(
        "analysis_reason_texts",
        sa.Column("reason_id", sa.BigInteger, _fk("analysis_reasons.id"), primary_key=True),
        sa.Column("locale", sa.Text, _fk("locales.code"), primary_key=True),
        sa.Column("text", sa.Text, nullable=False),
        schema=S,
    )

    # Scans.
    op.create_table(
        "scan_results",
        sa.Column(
            "scan_event_id",
            sa.BigInteger,
            _fk("scan_events.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("analysis_id", sa.BigInteger, _fk("analyses.id"), nullable=False),
        schema=S,
    )
    # « Servi depuis le cache » se calcule à partir de analysis_id : on l'indexe.
    op.create_index("ix_scan_results_analysis_id", "scan_results", ["analysis_id"], schema=S)

    _seed()


def _seed() -> None:
    op.bulk_insert(
        sa.table("locales", sa.column("code", sa.Text), schema=S), [{"code": "fr"}, {"code": "nl"}]
    )
    op.bulk_insert(
        sa.table("severities", sa.column("code", sa.Text), schema=S),
        [{"code": "info"}, {"code": "warning"}, {"code": "danger"}],
    )
    op.bulk_insert(
        sa.table("marketplaces", sa.column("code", sa.Text), schema=S),
        [{"code": "twh"}, {"code": "facebook"}],
    )

    # Les identifiants viennent de l'identité : on les relit au lieu de les imposer.
    bind = op.get_bind()
    marketplace_ids = dict(bind.execute(sa.text(f"select code, id from {S}.marketplaces")).all())
    op.bulk_insert(
        sa.table(
            "sites",
            sa.column("marketplace_id", sa.Integer),
            sa.column("domain", sa.Text),
            sa.column("default_locale", sa.Text),
            schema=S,
        ),
        [
            {
                "marketplace_id": marketplace_ids["twh"],
                "domain": "2ememain.be",
                "default_locale": "fr",
            },
            {
                "marketplace_id": marketplace_ids["twh"],
                "domain": "2dehands.be",
                "default_locale": "nl",
            },
            {
                "marketplace_id": marketplace_ids["facebook"],
                "domain": "facebook.com",
                "default_locale": "fr",
            },
        ],
    )
    site_ids = dict(bind.execute(sa.text(f"select domain, id from {S}.sites")).all())
    op.bulk_insert(
        sa.table(
            "site_image_hosts",
            sa.column("site_id", sa.Integer),
            sa.column("host_suffix", sa.Text),
            schema=S,
        ),
        [
            {"site_id": site_ids["2ememain.be"], "host_suffix": "images.2dehands.com"},
            {"site_id": site_ids["2dehands.be"], "host_suffix": "images.2dehands.com"},
            {"site_id": site_ids["facebook.com"], "host_suffix": "fbcdn.net"},
        ],
    )
    op.bulk_insert(
        sa.table(
            "settings",
            sa.column("id", sa.Integer),
            sa.column("cache_ttl_hours", sa.Integer),
            sa.column("rate_limit_per_minute", sa.Integer),
            schema=S,
        ),
        [{"id": 1, "cache_ttl_hours": 24, "rate_limit_per_minute": 30}],
    )

    op.bulk_insert(
        sa.table(
            "prompt_versions",
            sa.column("scan_kind", sa.Text),
            sa.column("version", sa.Integer),
            sa.column("system_prompt", sa.Text),
            schema=S,
        ),
        [
            {"scan_kind": "text", "version": 1, "system_prompt": TEXT_PROMPT_V1},
            {"scan_kind": "image", "version": 1, "system_prompt": IMAGE_PROMPT_V1},
        ],
    )
    op.execute(
        f"update {S}.scan_kinds k set active_prompt_version_id = p.id"
        f" from {S}.prompt_versions p where p.scan_kind = k.code and p.version = 1"
    )


def downgrade() -> None:
    # Ordre inverse de la création ; les index partent avec leur table.
    op.drop_table("scan_results", schema=S)
    op.drop_table("analysis_reason_texts", schema=S)
    op.drop_table("analysis_reasons", schema=S)
    op.drop_table("analysis_texts", schema=S)
    op.drop_table("analyses", schema=S)
    op.drop_table("snapshot_images", schema=S)
    op.drop_table("listing_snapshots", schema=S)
    op.drop_table("listings", schema=S)
    op.drop_constraint(
        "scan_kinds_active_prompt_version_id_fkey", "scan_kinds", schema=S, type_="foreignkey"
    )
    op.drop_column("scan_kinds", "active_prompt_version_id", schema=S)
    op.drop_table("prompt_versions", schema=S)
    op.drop_table("settings", schema=S)
    op.drop_table("site_image_hosts", schema=S)
    op.drop_table("sites", schema=S)
    op.drop_table("marketplaces", schema=S)
    op.drop_table("severities", schema=S)
    op.drop_table("locales", schema=S)
