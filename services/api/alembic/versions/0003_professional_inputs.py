"""Annonce professionnelle détectée par l'IA : colonne `analyses.professional`.

Les nouveaux types de prix et `sellerKind` ne sont pas stockés (ils ne vivent que dans le schéma
d'entrée et les empreintes du cache) : seule cette colonne est ajoutée.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-18
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "app"


def upgrade() -> None:
    # Les analyses existantes valent `false` : le prompt v1 ne demandait pas ce champ.
    op.add_column(
        "analyses",
        sa.Column("professional", sa.Boolean, nullable=False, server_default=sa.false()),
        schema=S,
    )


def downgrade() -> None:
    op.drop_column("analyses", "professional", schema=S)
