"""Journal des actions d'administration (`admin_actions`) et trace des appels au modèle
(`llm_calls`).

`admin_actions` : une ligne par modification faite depuis l'admin. `target_user_id` n'a pas de
clé étrangère, pour garder la trace d'une suppression de compte ; `admin_user_id` passe à NULL si
l'admin est supprimé.

`llm_calls` : une ligne par appel au modèle qui produit une analyse. Une analyse expirée est
rafraîchie sur place (son coût, ses tokens et sa date sont écrasés) : les statistiques de coût et
de cache ne peuvent donc pas se calculer sur `analyses`. La table ne relie un appel ni à un
utilisateur ni à un scan. L'`upgrade` crée une ligne par analyse existante (approximatif pour
celles déjà rafraîchies).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "app"


def upgrade() -> None:
    op.create_table(
        "admin_actions",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column(
            "admin_user_id",
            sa.Text,
            sa.ForeignKey("auth.user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("action", sa.Text, nullable=False),
        sa.Column("target_user_id", sa.Text, nullable=True),
        sa.Column("details", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        schema=S,
    )
    op.create_index(
        "ix_admin_actions_created_at",
        "admin_actions",
        [sa.text("created_at DESC")],
        schema=S,
    )
    op.create_index(
        "ix_admin_actions_target_user_id", "admin_actions", ["target_user_id"], schema=S
    )

    op.create_table(
        "llm_calls",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("analysis_id", sa.BigInteger, sa.ForeignKey(f"{S}.analyses.id"), nullable=False),
        sa.Column("model_id", sa.Integer, sa.ForeignKey(f"{S}.models.id"), nullable=False),
        sa.Column(
            "prompt_version_id",
            sa.Integer,
            sa.ForeignKey(f"{S}.prompt_versions.id"),
            nullable=False,
        ),
        sa.Column("tokens_in", sa.Integer, nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.Integer, nullable=False, server_default="0"),
        sa.Column("images_analyzed", sa.Integer, nullable=False, server_default="0"),
        sa.Column("web_searches", sa.Integer, nullable=False, server_default="0"),
        sa.Column("cost_usd_micros", sa.BigInteger, nullable=False, server_default="0"),
        schema=S,
    )
    op.create_index("ix_llm_calls_created_at", "llm_calls", ["created_at"], schema=S)
    op.create_index("ix_llm_calls_analysis_id", "llm_calls", ["analysis_id"], schema=S)

    # Reprise : un appel par analyse existante.
    op.execute(
        "insert into app.llm_calls(created_at, analysis_id, model_id, prompt_version_id,"
        " tokens_in, tokens_out, cost_usd_micros, images_analyzed, web_searches)"
        " select a.created_at, a.id, a.model_id, a.prompt_version_id, a.tokens_in, a.tokens_out,"
        " a.cost_usd_micros, a.images_analyzed,"
        " (select count(*) from app.analysis_web_searches w where w.analysis_id = a.id)"
        " from app.analyses a"
    )


def downgrade() -> None:
    op.drop_table("llm_calls", schema=S)
    op.drop_table("admin_actions", schema=S)
