from sqlalchemy import ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base


class Plan(Base):
    __tablename__ = "plans"

    code: Mapped[str] = mapped_column(primary_key=True)
    quota_period: Mapped[str] = mapped_column(ForeignKey("app.quota_periods.code"))
    total_scan_cap: Mapped[int | None]


class PlanPrice(Base):
    __tablename__ = "plan_prices"

    plan: Mapped[str] = mapped_column(ForeignKey("app.plans.code"), primary_key=True)
    interval: Mapped[str] = mapped_column(
        ForeignKey("app.billing_intervals.code"), primary_key=True
    )
    currency: Mapped[str] = mapped_column(ForeignKey("app.currencies.code"), primary_key=True)
    amount_cents: Mapped[int]
    stripe_price_id: Mapped[str | None]


class PlanQuota(Base):
    __tablename__ = "plan_quotas"

    plan: Mapped[str] = mapped_column(ForeignKey("app.plans.code"), primary_key=True)
    scan_kind: Mapped[str] = mapped_column(ForeignKey("app.scan_kinds.code"), primary_key=True)
    quota: Mapped[int]


class PlanFeature(Base):
    __tablename__ = "plan_features"

    plan: Mapped[str] = mapped_column(ForeignKey("app.plans.code"), primary_key=True)
    feature: Mapped[str] = mapped_column(ForeignKey("app.features.code"), primary_key=True)
