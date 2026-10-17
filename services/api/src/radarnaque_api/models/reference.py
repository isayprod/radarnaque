from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Identity, UniqueConstraint, func
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


class Locale(_CodeTable, Base):
    __tablename__ = "locales"


class Severity(_CodeTable, Base):
    __tablename__ = "severities"


class Marketplace(Base):
    __tablename__ = "marketplaces"

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    code: Mapped[str] = mapped_column(unique=True)


class Site(Base):
    __tablename__ = "sites"

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    marketplace_id: Mapped[int] = mapped_column(ForeignKey("app.marketplaces.id"))
    domain: Mapped[str] = mapped_column(unique=True)
    default_locale: Mapped[str] = mapped_column(ForeignKey("app.locales.code"))


class SiteImageHost(Base):
    """Liste blanche anti-SSRF : suffixes d'hôtes d'images autorisés par site."""

    __tablename__ = "site_image_hosts"

    site_id: Mapped[int] = mapped_column(ForeignKey("app.sites.id"), primary_key=True)
    host_suffix: Mapped[str] = mapped_column(primary_key=True)


class AppSettings(Base):
    """Réglages d'exploitation : une seule ligne (`id = 1`)."""

    __tablename__ = "settings"
    __table_args__ = (CheckConstraint("id = 1", name="ck_settings_single_row"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)
    cache_ttl_hours: Mapped[int]
    rate_limit_per_minute: Mapped[int]


class Model(Base):
    __tablename__ = "models"
    __table_args__ = (UniqueConstraint("provider", "slug"),)

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    provider: Mapped[str]
    slug: Mapped[str]


class PromptVersion(Base):
    """Prompt système versionné ; non modifiable une fois créé."""

    __tablename__ = "prompt_versions"
    __table_args__ = (UniqueConstraint("scan_kind", "version"),)

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    scan_kind: Mapped[str] = mapped_column(ForeignKey("app.scan_kinds.code"))
    version: Mapped[int]
    system_prompt: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ScanKind(Base):
    """Type de scan (`text`, `image`), modèle actif et version de prompt active."""

    __tablename__ = "scan_kinds"

    code: Mapped[str] = mapped_column(primary_key=True)
    active_model_id: Mapped[int] = mapped_column(ForeignKey("app.models.id"))
    # Référence circulaire avec PromptVersion.scan_kind : la clé est différée.
    active_prompt_version_id: Mapped[int | None] = mapped_column(
        ForeignKey(
            "app.prompt_versions.id",
            name="scan_kinds_active_prompt_version_id_fkey",
            use_alter=True,
            deferrable=True,
            initially="DEFERRED",
        )
    )
