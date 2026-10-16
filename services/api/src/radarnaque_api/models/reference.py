from sqlalchemy import ForeignKey, Identity, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base


class _CodeTable:
    """Référentiel réduit à un code texte (clé primaire naturelle)."""

    code: Mapped[str] = mapped_column(primary_key=True)


class BillingInterval(_CodeTable, Base):
    __tablename__ = "billing_intervals"


class Currency(_CodeTable, Base):
    __tablename__ = "currencies"


class Feature(_CodeTable, Base):
    __tablename__ = "features"


class QuotaPeriod(_CodeTable, Base):
    __tablename__ = "quota_periods"


class SubscriptionStatus(_CodeTable, Base):
    __tablename__ = "subscription_statuses"


class BillingProvider(_CodeTable, Base):
    __tablename__ = "billing_providers"


class ScanTrigger(_CodeTable, Base):
    __tablename__ = "scan_triggers"


class Model(Base):
    __tablename__ = "models"
    __table_args__ = (UniqueConstraint("provider", "slug"),)

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    provider: Mapped[str]
    slug: Mapped[str]


class ScanKind(Base):
    """Type de scan (`text`, `image`) et modèle actif associé.

    `active_prompt_version_id` sera ajouté avec `prompt_versions` en phase 3.
    """

    __tablename__ = "scan_kinds"

    code: Mapped[str] = mapped_column(primary_key=True)
    active_model_id: Mapped[int] = mapped_column(ForeignKey("app.models.id"))
