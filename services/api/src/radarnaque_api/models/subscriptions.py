from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Identity, Index, func, text
from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base


class Subscription(Base):
    __tablename__ = "subscriptions"
    __table_args__ = (
        # Au plus un abonnement actif par utilisateur.
        Index(
            "ux_subscriptions_one_active",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("auth.user.id", ondelete="CASCADE"))
    plan: Mapped[str] = mapped_column(ForeignKey("app.plans.code"))
    status: Mapped[str] = mapped_column(ForeignKey("app.subscription_statuses.code"))
    provider: Mapped[str] = mapped_column(ForeignKey("app.billing_providers.code"))
    provider_ref: Mapped[str | None]
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Scans réussis de l'essai effacés par la purge à 12 mois : ils comptent encore dans le
    # quota « à vie » (voir `compute_usage`).
    purged_scans: Mapped[int] = mapped_column(server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
