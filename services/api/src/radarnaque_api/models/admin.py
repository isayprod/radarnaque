from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, ForeignKey, Identity, Index, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base


class AdminAction(Base):
    """Une modification faite depuis l'admin, écrite dans la même transaction que le changement.

    `target_user_id` n'a pas de clé étrangère : la trace d'une suppression de compte survit au
    compte. `admin_user_id` passe à NULL si l'admin est supprimé. `details` contient l'ancienne et
    la nouvelle valeur (`{ from, to }`), jamais d'email ni le texte d'un prompt.
    """

    __tablename__ = "admin_actions"
    __table_args__ = (
        Index("ix_admin_actions_created_at", text("created_at DESC")),
        Index("ix_admin_actions_target_user_id", "target_user_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    admin_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("auth.user.id", ondelete="SET NULL")
    )
    action: Mapped[str]
    target_user_id: Mapped[str | None]
    details: Mapped[dict[str, Any]] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb"), default=dict
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
