from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    UniqueConstraint,
    false,
    func,
)
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
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_settings_single_row"),
        CheckConstraint("max_web_searches between 0 and 5", name="ck_settings_max_web_searches"),
        CheckConstraint(
            "identification_cache_ttl_hours between 1 and 2160",
            name="ck_settings_identification_cache_ttl_hours",
        ),
        CheckConstraint(
            "criteria_ttl_days between 1 and 730", name="ck_settings_criteria_ttl_days"
        ),
        CheckConstraint(
            "criteria_max_searches between 0 and 5", name="ck_settings_criteria_max_searches"
        ),
        CheckConstraint(
            "criteria_max_pages between 0 and 5", name="ck_settings_criteria_max_pages"
        ),
        CheckConstraint(
            "identify_retry_threshold between 0 and 100",
            name="ck_settings_identify_retry_threshold",
        ),
        CheckConstraint(
            "identify_image_side between 768 and 1536", name="ck_settings_identify_image_side"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)
    cache_ttl_hours: Mapped[int]
    rate_limit_per_minute: Mapped[int]
    # Recherches web au plus par analyse ; la boucle du modèle s'arrête à ce nombre + 2 tours.
    max_web_searches: Mapped[int] = mapped_column(server_default="3")
    # Identification du produit (migration 0010).
    identification_cache_ttl_hours: Mapped[int] = mapped_column(server_default="168")
    criteria_ttl_days: Mapped[int] = mapped_column(server_default="180")
    criteria_max_searches: Mapped[int] = mapped_column(server_default="2")
    criteria_max_pages: Mapped[int] = mapped_column(server_default="3")
    identify_retry_threshold: Mapped[int] = mapped_column(server_default="60")
    identify_image_side: Mapped[int] = mapped_column(server_default="1280")
    scam_sends_photos: Mapped[bool] = mapped_column(server_default=false())
    identify_escalation_model_id: Mapped[int | None] = mapped_column(ForeignKey("app.models.id"))


class Model(Base):
    __tablename__ = "models"
    __table_args__ = (UniqueConstraint("provider", "slug"),)

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    provider: Mapped[str]
    slug: Mapped[str]


class PromptVersion(Base):
    """Prompt système versionné ; non modifiable une fois créé."""

    __tablename__ = "prompt_versions"
    __table_args__ = (
        UniqueConstraint("scan_kind", "version"),
        UniqueConstraint("step", "version", name="uq_prompt_versions_step_version"),
        # Un prompt appartient soit à un type de scan, soit à une étape du pipeline.
        CheckConstraint("(scan_kind is null) <> (step is null)", name="ck_prompt_versions_owner"),
    )

    id: Mapped[int] = mapped_column(Identity(), primary_key=True)
    scan_kind: Mapped[str | None] = mapped_column(ForeignKey("app.scan_kinds.code"))
    step: Mapped[str | None] = mapped_column(
        ForeignKey("app.pipeline_steps.code", name="prompt_versions_step_fkey")
    )
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


class PipelineStep(Base):
    """Étape du pipeline d'identification : modèle et prompt actifs."""

    __tablename__ = "pipeline_steps"

    code: Mapped[str] = mapped_column(primary_key=True)
    active_model_id: Mapped[int] = mapped_column(ForeignKey("app.models.id"))
    # Référence circulaire avec PromptVersion.step : la clé est différée.
    active_prompt_version_id: Mapped[int | None] = mapped_column(
        ForeignKey(
            "app.prompt_versions.id",
            name="pipeline_steps_active_prompt_version_id_fkey",
            use_alter=True,
            deferrable=True,
            initially="DEFERRED",
        )
    )
