from datetime import datetime

from sqlalchemy import DateTime
from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base


class AuthUser(Base):
    """Mapping de `auth."user"` (table gérée par Better Auth).

    Il n'est pas migré par Alembic (`include_object` exclut le schéma `auth`) ; il sert aux
    clés étrangères et aux lectures de l'API. L'API n'écrit que `role` (admin : changement de
    rôle) ; les autres colonnes restent à Better Auth.
    """

    __tablename__ = "user"
    __table_args__ = {"schema": "auth", "info": {"read_only": True}}

    id: Mapped[str] = mapped_column(primary_key=True)
    email: Mapped[str]
    role: Mapped[str]
    # Colonnes de Better Auth en camelCase, lues par la liste des comptes de l'admin.
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime(timezone=True))
    email_verified: Mapped[bool] = mapped_column("emailVerified")
