from datetime import datetime
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    StrictInt,
    StringConstraints,
    model_validator,
)
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
    # Particulier ou professionnel, lu sur 2ememain/2dehands ; inconnu (None) sur Facebook.
    seller_kind: Literal["private", "professional"] | None = None


class PriceIn(CamelInModel):
    amount_cents: int = Field(ge=0)
    currency: Literal["EUR"]


# Bornes des champs texte transmis au LLM (règle R14). L'extension (phase 3b) tronque côté
# client aux mêmes valeurs : une annonce réelle n'est jamais refusée.
LOCATION_MAX = 100
CATEGORY_MAX = 200
CONDITION_MAX = 100
POSTED_AT_MAX = 64
PARAMS_MAX_ENTRIES = 10
PARAM_KEY_MAX = 40
PARAM_VALUE_MAX = 200


class LocationIn(CamelInModel):
    city: str | None = Field(default=None, max_length=LOCATION_MAX)
    region: str | None = Field(default=None, max_length=LOCATION_MAX)
    country: str | None = Field(default=None, max_length=LOCATION_MAX)


# Types de prix lus sur les annonces : `on_request`, `see_description`, `exchange` et
# `reserved` ne déclenchent aucune règle locale (spec §4.2).
PriceType = Literal[
    "fixed", "bidding", "free", "on_request", "see_description", "exchange", "reserved", "unknown"
]


class ListingIn(CamelInModel):
    site: Literal["2ememain.be", "2dehands.be", "facebook.com"]
    external_id: str = Field(min_length=1, max_length=64)
    url: HttpUrl
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(max_length=5000)
    price: PriceIn | None = None
    price_type: PriceType
    category: str | None = Field(default=None, max_length=CATEGORY_MAX)
    condition: str | None = Field(default=None, max_length=CONDITION_MAX)
    posted_at: str | None = Field(default=None, max_length=POSTED_AT_MAX)
    location: LocationIn
    images: list[HttpUrl] = Field(default_factory=list, max_length=10)
    seller: SellerFactsIn


ParamKey = Annotated[str, StringConstraints(min_length=1, max_length=PARAM_KEY_MAX)]
# Entier strict : une longue chaîne de chiffres n'est pas convertie en entier, ce qui
# contournerait la borne des chaînes.
ParamValue = Annotated[str, StringConstraints(max_length=PARAM_VALUE_MAX)] | StrictInt


class SignalIn(CamelInModel):
    id: str = Field(min_length=1, max_length=40)
    weight: int = Field(ge=0, le=100)
    severity: Severity
    params: dict[ParamKey, ParamValue] | None = Field(default=None, max_length=PARAMS_MAX_ENTRIES)


class RulesIn(CamelInModel):
    version: int = Field(ge=1)
    signals: list[SignalIn] = Field(max_length=20)


ScanKindCode = Literal["text", "image"]
TriggerCode = Literal["button", "card"]


def _drop_default(schema: dict[str, Any]) -> None:
    """Retire `default` du schéma JSON d'un champ facultatif (voir `ScanIn.no_cache`)."""
    schema.pop("default", None)


class ScanIn(CamelInModel):
    listing: ListingIn
    rules: RulesIn
    scan_kind: ScanKindCode
    trigger: TriggerCode
    partial: bool = False
    # Relance sans cache : honorée seulement pour un superuser hors production, ignorée sans
    # erreur pour tout autre compte. Hors des empreintes du cache (rien n'est envoyé au LLM).
    # Sans `default` dans le schéma OpenAPI : openapi-typescript rendrait sinon le champ
    # obligatoire, alors que l'extension ne l'envoie que lorsqu'il est vrai.
    no_cache: bool = Field(default=False, json_schema_extra=_drop_default)


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


class PromptVersionDebugOut(CamelModel):
    scan_kind: ScanKindCode
    version: int


class DebugMessageOut(CamelModel):
    """Message envoyé au LLM, en texte : chaque photo y est résumée (`[image n : N octets]`)."""

    role: str
    content: str


class DebugTimingsOut(CamelModel):
    """Durées en millisecondes ; `None` pour une étape sautée (pas de photo, cache)."""

    images: int | None
    llm: int | None
    total: int


class ScanDebugOut(CamelModel):
    """Bloc de débogage du superuser hors production. Jamais de clé d'API, d'en-tête
    `Authorization`, de jeton ni de photo en base64. `system_prompt` : le texte réellement
    envoyé (schéma compris en mode `json_object`) ; `raw_response` : la réponse brute du modèle,
    `None` si le LLM n'a pas été appelé. Les jetons et le coût sont ceux de l'analyse servie."""

    provider: str
    model: str
    prompt_version: PromptVersionDebugOut
    system_prompt: str
    messages: list[DebugMessageOut]
    raw_response: str | None
    llm_called: bool
    from_cache: bool
    tokens_in: int
    tokens_out: int
    cost_usd_micros: int
    timings_ms: DebugTimingsOut
    content_hash: str
    input_hash: str
    snapshot_id: int
    analysis_id: int


class AnalysisResultOut(CamelModel):
    analysis_id: int
    score: int
    level: RiskLevel
    partial: bool
    # L'annonce vient visiblement d'un professionnel, selon l'IA (`analyses.professional`).
    professional: bool
    from_cache: bool
    summary: LocalizedTextOut
    advice: LocalizedTextOut
    reasons: list[AnalysisReasonOut]
    analyzed_at: datetime
    remaining: RemainingOut
    # Seulement pour un superuser hors production ; `None` (null) pour tout autre compte.
    debug: ScanDebugOut | None = None


class ScanHistoryItemOut(CamelModel):
    """Un scan de l'historique. `site` et `title` viennent du snapshot de l'analyse servie :
    `None` pour un scan sans résultat (échec ou en cours), qui n'est relié à aucun snapshot.
    `score` et `level` sont `None` dans le même cas."""

    scan_event_id: int
    created_at: datetime
    scan_kind: ScanKindCode
    trigger: TriggerCode
    site: str | None
    title: str | None
    score: int | None
    level: RiskLevel | None
    from_cache: bool
    failed: bool


class ScanHistoryOut(CamelModel):
    """Page de l'historique, du plus récent au plus ancien ; `next_before` est à passer en
    `before` pour la page suivante (`None` : plus rien)."""

    items: list[ScanHistoryItemOut]
    next_before: int | None


class QuotaOut(CamelModel):
    scan_kind: str | None
    limit: int
    used: int
    remaining: int


class MeOut(CamelModel):
    user_id: str
    email: str
    role: Literal["user", "admin", "superuser"]
    plan: str | None
    features: list[str]
    unlimited: bool
    period_start: datetime | None
    quotas: list[QuotaOut]
    total_cap: QuotaOut | None


class BootstrapOut(BaseModel):
    created: bool


class CheckoutIn(CamelInModel):
    """Corps de `POST /api/billing/checkout` : l'offre payante et la périodicité choisies."""

    plan: Literal["standard", "premium"]
    interval: Literal["month", "year"]


class BillingUrlOut(CamelModel):
    """Adresse vers laquelle rediriger l'utilisateur (paiement ou portail de gestion)."""

    url: str
