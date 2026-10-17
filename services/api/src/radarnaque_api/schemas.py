from datetime import datetime
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Modèle de réponse : JSON en camelCase, Python en snake_case."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class CamelInModel(CamelModel):
    """Modèle d'entrée : tout champ inconnu est refusé (un champ vendeur interdit → 422)."""

    model_config = ConfigDict(extra="forbid")


Severity = Literal["info", "warning", "danger"]


class MonthRangeIn(CamelInModel):
    min: int = Field(ge=0)
    max: int = Field(ge=0)

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if self.max < self.min:
            raise ValueError("max doit être supérieur ou égal à min")
        return self


class SellerFactsIn(CamelInModel):
    """Faits sur le vendeur, jamais son identité : `id`, `name` et `profileUrl` sont refusés."""

    account_age_months: MonthRangeIn | None = None
    review_count: int | None = Field(default=None, ge=0)
    rating: float | None = Field(default=None, ge=0, le=5)
    other_listings_count: int | None = Field(default=None, ge=0)
    verified: bool | None = None


class PriceIn(CamelInModel):
    amount_cents: int = Field(ge=0)
    currency: Literal["EUR"]


class LocationIn(CamelInModel):
    city: str | None = None
    region: str | None = None
    country: str | None = None


class ListingIn(CamelInModel):
    site: Literal["2ememain.be", "2dehands.be", "facebook.com"]
    external_id: str = Field(min_length=1, max_length=64)
    url: HttpUrl
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(max_length=5000)
    price: PriceIn | None = None
    price_type: Literal["fixed", "bidding", "free", "unknown"]
    category: str | None = None
    condition: str | None = None
    posted_at: str | None = None
    location: LocationIn
    images: list[HttpUrl] = Field(default_factory=list, max_length=10)
    seller: SellerFactsIn


class SignalIn(CamelInModel):
    id: str = Field(min_length=1, max_length=40)
    weight: int = Field(ge=0, le=100)
    severity: Severity
    params: dict[str, str | int] | None = None


class RulesIn(CamelInModel):
    version: int = Field(ge=1)
    signals: list[SignalIn] = Field(max_length=20)


class ScanIn(CamelInModel):
    listing: ListingIn
    rules: RulesIn
    scan_kind: Literal["text", "image"]
    trigger: Literal["button", "card"]
    partial: bool = False


RiskLevel = Literal["low", "medium", "high"]


class LocalizedTextOut(CamelModel):
    fr: str
    nl: str


class AnalysisReasonOut(CamelModel):
    severity: Severity
    text: LocalizedTextOut


class RemainingOut(CamelModel):
    """Scans restants après celui-ci ; `None` : illimité (admin) ou sans plafond."""

    text: int | None
    image: int | None
    total: int | None


class AnalysisResultOut(CamelModel):
    analysis_id: int
    score: int
    level: RiskLevel
    partial: bool
    from_cache: bool
    summary: LocalizedTextOut
    advice: LocalizedTextOut
    reasons: list[AnalysisReasonOut]
    analyzed_at: datetime
    remaining: RemainingOut


class QuotaOut(CamelModel):
    scan_kind: str | None
    limit: int
    used: int
    remaining: int


class MeOut(CamelModel):
    user_id: str
    email: str
    role: Literal["user", "admin"]
    plan: str | None
    features: list[str]
    unlimited: bool
    period_start: datetime | None
    quotas: list[QuotaOut]
    total_cap: QuotaOut | None


class BootstrapOut(BaseModel):
    created: bool
