"""Compteur `subscriptions.purged_scans` : scans réussis de l'essai effacés par la purge.

L'essai a un quota « à vie » compté sur les `scan_events`. La purge à 12 mois supprime ces
événements : sans compteur, l'essai récupérerait ses analyses. `compute_usage` ajoute ce nombre
à la consommation d'une période `lifetime`.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-20
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "app"


def upgrade() -> None:
    # Les abonnements existants reçoivent 0 (`server_default`), qu'on garde : la colonne est
    # NOT NULL DEFAULT 0, y compris pour les insertions faites sans la renseigner.
    op.add_column(
        "subscriptions",
        sa.Column("purged_scans", sa.Integer, nullable=False, server_default="0"),
        schema=S,
    )


def downgrade() -> None:
    op.drop_column("subscriptions", "purged_scans", schema=S)
