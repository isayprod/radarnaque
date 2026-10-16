"""Schéma app (3NF) : référentiels, offre, abonnements, scans, et offre initiale.

Revision ID: 0001
Revises:
Create Date: 2026-10-16
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "app"
CODE_TABLES = (
    "billing_intervals",
    "currencies",
    "features",
    "quota_periods",
    "subscription_statuses",
    "billing_providers",
    "scan_triggers",
)


def _ts(name: str, *, nullable: bool = False, default_now: bool = False) -> sa.Column:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        nullable=nullable,
        server_default=sa.text("now()") if default_now else None,
    )


def upgrade() -> None:
    op.execute(f"create schema if not exists {S}")

    # Référentiels réduits à un code.
    for table in CODE_TABLES:
        op.create_table(table, sa.Column("code", sa.Text, primary_key=True), schema=S)

    op.create_table(
        "models",
        sa.Column("id", sa.Integer, sa.Identity(), primary_key=True),
        sa.Column("provider", sa.Text, nullable=False),
        sa.Column("slug", sa.Text, nullable=False),
        sa.UniqueConstraint("provider", "slug"),
        schema=S,
    )
    op.create_table(
        "scan_kinds",
        sa.Column("code", sa.Text, primary_key=True),
        sa.Column("active_model_id", sa.Integer, sa.ForeignKey(f"{S}.models.id"), nullable=False),
        schema=S,
    )

    # Offre.
    op.create_table(
        "plans",
        sa.Column("code", sa.Text, primary_key=True),
        sa.Column(
            "quota_period", sa.Text, sa.ForeignKey(f"{S}.quota_periods.code"), nullable=False
        ),
        sa.Column("total_scan_cap", sa.Integer),
        schema=S,
    )
    op.create_table(
        "plan_prices",
        sa.Column("plan", sa.Text, sa.ForeignKey(f"{S}.plans.code"), primary_key=True),
        sa.Column(
            "interval", sa.Text, sa.ForeignKey(f"{S}.billing_intervals.code"), primary_key=True
        ),
        sa.Column("currency", sa.Text, sa.ForeignKey(f"{S}.currencies.code"), primary_key=True),
        sa.Column("amount_cents", sa.Integer, nullable=False),
        sa.Column("stripe_price_id", sa.Text),
        schema=S,
    )
    op.create_table(
        "plan_quotas",
        sa.Column("plan", sa.Text, sa.ForeignKey(f"{S}.plans.code"), primary_key=True),
        sa.Column("scan_kind", sa.Text, sa.ForeignKey(f"{S}.scan_kinds.code"), primary_key=True),
        sa.Column("quota", sa.Integer, nullable=False),
        schema=S,
    )
    op.create_table(
        "plan_features",
        sa.Column("plan", sa.Text, sa.ForeignKey(f"{S}.plans.code"), primary_key=True),
        sa.Column("feature", sa.Text, sa.ForeignKey(f"{S}.features.code"), primary_key=True),
        schema=S,
    )

    # Clients.
    op.create_table(
        "subscriptions",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column(
            "user_id", sa.Text, sa.ForeignKey("auth.user.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("plan", sa.Text, sa.ForeignKey(f"{S}.plans.code"), nullable=False),
        sa.Column(
            "status", sa.Text, sa.ForeignKey(f"{S}.subscription_statuses.code"), nullable=False
        ),
        sa.Column(
            "provider", sa.Text, sa.ForeignKey(f"{S}.billing_providers.code"), nullable=False
        ),
        sa.Column("provider_ref", sa.Text),
        _ts("period_start"),
        _ts("period_end", nullable=True),
        _ts("created_at", default_now=True),
        schema=S,
    )
    op.create_index(
        "ux_subscriptions_one_active",
        "subscriptions",
        ["user_id"],
        unique=True,
        schema=S,
        postgresql_where=sa.text("status = 'active'"),
    )

    # Scans.
    op.create_table(
        "scan_events",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column(
            "user_id", sa.Text, sa.ForeignKey("auth.user.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("scan_kind", sa.Text, sa.ForeignKey(f"{S}.scan_kinds.code"), nullable=False),
        sa.Column("trigger", sa.Text, sa.ForeignKey(f"{S}.scan_triggers.code"), nullable=False),
        _ts("created_at", default_now=True),
        schema=S,
    )
    op.create_index(
        "ix_scan_events_user_kind_time",
        "scan_events",
        ["user_id", "scan_kind", "created_at"],
        schema=S,
    )
    op.create_table(
        "scan_failures",
        sa.Column(
            "scan_event_id",
            sa.BigInteger,
            sa.ForeignKey(f"{S}.scan_events.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("error_code", sa.Text, nullable=False),
        _ts("created_at", default_now=True),
        schema=S,
    )

    _seed()


def _seed() -> None:
    def codes(table: str, values: Sequence[str]) -> None:
        op.bulk_insert(
            sa.table(table, sa.column("code", sa.Text), schema=S), [{"code": v} for v in values]
        )

    codes("billing_intervals", ["month", "year"])
    codes("currencies", ["EUR"])
    codes("features", ["card_icons", "image_scan"])
    codes("quota_periods", ["subscription_month", "lifetime"])
    codes("subscription_statuses", ["active", "canceled", "past_due", "expired"])
    codes("billing_providers", ["manual", "stripe"])
    codes("scan_triggers", ["button", "card"])

    models = sa.table(
        "models", sa.column("provider", sa.Text), sa.column("slug", sa.Text), schema=S
    )
    op.bulk_insert(
        models,
        [
            {"provider": "openrouter", "slug": "google/gemini-2.5-flash-lite"},
            {"provider": "openrouter", "slug": "google/gemini-3.1-flash-lite"},
        ],
    )
    # Les identifiants viennent de l'identité : on les relit au lieu de les imposer.
    bind = op.get_bind()
    model_ids = {
        slug: id_
        for id_, slug in bind.execute(
            sa.text(f"select id, slug from {S}.models where provider = 'openrouter'")
        )
    }
    op.bulk_insert(
        sa.table(
            "scan_kinds",
            sa.column("code", sa.Text),
            sa.column("active_model_id", sa.Integer),
            schema=S,
        ),
        [
            {"code": "text", "active_model_id": model_ids["google/gemini-2.5-flash-lite"]},
            {"code": "image", "active_model_id": model_ids["google/gemini-3.1-flash-lite"]},
        ],
    )

    op.bulk_insert(
        sa.table(
            "plans",
            sa.column("code", sa.Text),
            sa.column("quota_period", sa.Text),
            sa.column("total_scan_cap", sa.Integer),
            schema=S,
        ),
        [
            {"code": "trial", "quota_period": "lifetime", "total_scan_cap": 3},
            {"code": "standard", "quota_period": "subscription_month", "total_scan_cap": None},
            {"code": "premium", "quota_period": "subscription_month", "total_scan_cap": None},
        ],
    )
    op.bulk_insert(
        sa.table(
            "plan_prices",
            sa.column("plan", sa.Text),
            sa.column("interval", sa.Text),
            sa.column("currency", sa.Text),
            sa.column("amount_cents", sa.Integer),
            schema=S,
        ),
        [
            {"plan": "standard", "interval": "month", "currency": "EUR", "amount_cents": 299},
            {"plan": "standard", "interval": "year", "currency": "EUR", "amount_cents": 2900},
            {"plan": "premium", "interval": "month", "currency": "EUR", "amount_cents": 699},
            {"plan": "premium", "interval": "year", "currency": "EUR", "amount_cents": 6900},
        ],
    )
    op.bulk_insert(
        sa.table(
            "plan_quotas",
            sa.column("plan", sa.Text),
            sa.column("scan_kind", sa.Text),
            sa.column("quota", sa.Integer),
            schema=S,
        ),
        [
            {"plan": "trial", "scan_kind": "text", "quota": 3},
            {"plan": "trial", "scan_kind": "image", "quota": 3},
            {"plan": "standard", "scan_kind": "text", "quota": 150},
            {"plan": "standard", "scan_kind": "image", "quota": 0},
            {"plan": "premium", "scan_kind": "text", "quota": 1000},
            {"plan": "premium", "scan_kind": "image", "quota": 100},
        ],
    )
    op.bulk_insert(
        sa.table(
            "plan_features", sa.column("plan", sa.Text), sa.column("feature", sa.Text), schema=S
        ),
        [
            {"plan": "trial", "feature": "card_icons"},
            {"plan": "trial", "feature": "image_scan"},
            {"plan": "premium", "feature": "card_icons"},
            {"plan": "premium", "feature": "image_scan"},
        ],
    )


def downgrade() -> None:
    # Ordre inverse de la création ; les index partent avec leur table.
    for table in (
        "scan_failures",
        "scan_events",
        "subscriptions",
        "plan_features",
        "plan_quotas",
        "plan_prices",
        "plans",
        "scan_kinds",
        "models",
        *reversed(CODE_TABLES),
    ):
        op.drop_table(table, schema=S)
