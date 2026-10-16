from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base


class AuthUser(Base):
    """Mapping en lecture seule de `auth."user"` (table gérée par Better Auth).

    Il n'est pas migré par Alembic (`include_object` exclut le schéma `auth`) ; il sert aux
    clés étrangères et aux lectures de l'API.
    """

    __tablename__ = "user"
    __table_args__ = {"schema": "auth", "info": {"read_only": True}}

    id: Mapped[str] = mapped_column(primary_key=True)
    email: Mapped[str]
    role: Mapped[str]
