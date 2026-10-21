"""URL de l'annonce (`listings.url`).

La fiche d'une analyse, dans l'admin, renvoie vers l'annonce. L'URL est écrite à chaque scan
(`scheme://host/path`, sans query ni fragment) ; les annonces déjà scannées gardent `NULL` jusqu'à
leur prochain scan.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S = "app"


def upgrade() -> None:
    op.add_column("listings", sa.Column("url", sa.Text, nullable=True), schema=S)


def downgrade() -> None:
    op.drop_column("listings", "url", schema=S)
