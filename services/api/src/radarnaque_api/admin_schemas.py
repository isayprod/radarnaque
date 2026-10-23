"""Schémas de l'API admin."""

from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import Field, StringConstraints

from radarnaque_api.schemas import (
    CamelInModel,
    CamelModel,
    QuotaOut,
    RiskLevel,
    ScanHistoryItemOut,
    Severity,
)


class AdminActionOut(CamelModel):
    """Une ligne du journal des modifications faites depuis l'admin. `admin_email` vient de
    `auth.user` (affichage seulement) ; il est `None` quand l'admin a été supprimé."""

    id: int
    action: str
    admin_user_id: str | None
    admin_email: str | None
    target_user_id: str | None
    details: dict[str, Any]
    created_at: datetime


class AdminUserRowOut(CamelModel):
    """Une ligne de la liste des comptes. `used` et `remaining` sont ceux du quota `full` de
    l'abonnement actif ; `None` sans abonnement actif."""

    id: str
    email: str
    role: Literal["user", "admin", "superuser"]
    plan: str | None
    used: int | None
    remaining: int | None
    created_at: datetime
    last_scan_at: datetime | None


class AdminUserListOut(CamelModel):
    """Page de la liste, du plus récent au plus ancien ; `next_before` est à passer en `before`
    pour la page suivante (`None` : plus rien)."""

    items: list[AdminUserRowOut]
    next_before: str | None


class AdminSubscriptionOut(CamelModel):
    id: int
    plan: str
    status: str
    provider: str
    period_start: datetime
    period_end: datetime | None


class AdminUsageOut(CamelModel):
    """Consommation de l'abonnement actif, comme `GET /api/me`. `purged_scans` : scans de
    l'essai effacés par la purge, comptés dans le quota."""

    period_start: datetime
    quotas: list[QuotaOut]
    total_cap: QuotaOut | None
    purged_scans: int


class AdminUserOut(CamelModel):
    """Fiche d'un compte."""

    id: str
    email: str
    email_verified: bool
    created_at: datetime
    role: Literal["user", "admin", "superuser"]
    subscription: AdminSubscriptionOut | None
    usage: AdminUsageOut | None
    subscriptions: list[AdminSubscriptionOut]
    scans: list[ScanHistoryItemOut]
    actions: list[AdminActionOut]


class AdminPlanIn(CamelInModel):
    plan: str


class AdminRoleIn(CamelInModel):
    # `superuser` n'est jamais attribué depuis l'admin : refusé par la validation.
    role: Literal["admin", "user"]


# --- IA : modèles, prompts, réglages -------------------------------------------------------

# Slug d'un modèle chez son fournisseur : 1 à 200 caractères, aucun espace.
ModelSlug = Annotated[str, StringConstraints(pattern=r"^\S{1,200}$")]
# Texte d'un prompt système : 200 à 20 000 caractères.
PromptText = Annotated[str, StringConstraints(min_length=200, max_length=20_000)]


class ProviderOut(CamelModel):
    """Un fournisseur de `providers.toml`, en lecture seule. `key` : l'état de la variable
    d'environnement de la clé, jamais sa valeur ; `not_required` sans `api_key_env`."""

    code: str
    api: Literal["chat", "responses"]
    structured_output: Literal["json_schema", "json_object"]
    reasoning_effort: str | None
    max_images: int | None
    key: Literal["present", "absent", "not_required"]


class ModelOut(CamelModel):
    """Un modèle de `app.models`. `known_provider` : son fournisseur figure encore dans
    `providers.toml` (sinon il ne peut pas être activé)."""

    id: int
    provider: str
    slug: str
    analyses: int
    active: bool
    known_provider: bool


class PromptVersionOut(CamelModel):
    id: int
    version: int
    created_at: datetime
    active: bool
    analyses: int


class PromptTextOut(PromptVersionOut):
    """`step` : l'étape d'identification propriétaire du prompt ; `None` pour le type `full`."""

    system_prompt: str
    step: str | None = None


class StepOut(CamelModel):
    """Une étape de l'identification : modèle actif, prompt actif et versions du prompt (sans
    leur texte, plus récente d'abord)."""

    code: Literal["read_photos", "criteria", "identify"]
    active_model_id: int
    active_prompt_id: int | None
    prompts: list[PromptVersionOut]


class AiSettingsOut(CamelModel):
    cache_ttl_hours: int
    rate_limit_per_minute: int
    max_web_searches: int
    identification_cache_ttl_hours: int
    criteria_ttl_days: int
    criteria_max_searches: int
    criteria_max_pages: int
    identify_retry_threshold: int
    identify_image_side: int
    scam_sends_photos: bool
    identify_escalation_model_id: int | None


class AiSettingsIn(CamelInModel):
    """Champ absent ou `null` : inchangé, sauf `identifyEscalationModelId`, où `null` explicite
    retire le modèle de relance."""

    cache_ttl_hours: int | None = Field(default=None, ge=1, le=168)
    rate_limit_per_minute: int | None = Field(default=None, ge=1, le=600)
    max_web_searches: int | None = Field(default=None, ge=0, le=5)
    identification_cache_ttl_hours: int | None = Field(default=None, ge=1, le=2160)
    criteria_ttl_days: int | None = Field(default=None, ge=1, le=730)
    criteria_max_searches: int | None = Field(default=None, ge=0, le=5)
    criteria_max_pages: int | None = Field(default=None, ge=0, le=5)
    identify_retry_threshold: int | None = Field(default=None, ge=0, le=100)
    identify_image_side: int | None = Field(default=None, ge=768, le=1536)
    scam_sends_photos: bool | None = None
    identify_escalation_model_id: int | None = None


class SearchStatusOut(CamelModel):
    """Moteur de recherche web. `url` : celle de SearXNG sans `user:pass@` (`None` quand le moteur
    est désactivé). `cache_entries` : taille du cache en mémoire du processus qui répond."""

    backend: Literal["searxng", "none"]
    url: str | None
    status: Literal["ok", "down", "disabled"]
    cache_entries: int | None


class AiOverviewOut(CamelModel):
    """Vue d'ensemble de l'IA : modèle et prompt actifs du type `full`, versions sans leur texte,
    et les 20 dernières actions `ai.*`."""

    providers: list[ProviderOut]
    models: list[ModelOut]
    active_model_id: int
    prompts: list[PromptVersionOut]
    active_prompt_version_id: int | None
    steps: list[StepOut]
    settings: AiSettingsOut
    search: SearchStatusOut
    actions: list[AdminActionOut]


class ModelTestOut(CamelModel):
    """Essai d'un modèle sur l'annonce fictive. Une erreur du fournisseur n'est pas une erreur
    de l'API : `ok` vaut `False` et `error` en donne le code."""

    ok: bool
    score: int | None
    duration_ms: int
    tokens_in: int
    tokens_out: int
    raw: str
    error: Literal["transport", "timeout", "invalid_response", "configuration"] | None


class SearchTestIn(CamelInModel):
    query: Annotated[str, StringConstraints(min_length=1, max_length=200)]


class SearchTestOut(CamelModel):
    """Résultat d'une recherche hors cache : `text` est le bloc rendu au modèle."""

    status: Literal["ok", "down", "disabled"]
    count: int
    text: str


class ModelIn(CamelInModel):
    provider: str
    slug: ModelSlug


class ActiveModelIn(CamelInModel):
    model_id: int


class PromptIn(CamelInModel):
    system_prompt: PromptText


# --- Offre : plans, prix, quotas ------------------------------------------------------------

# Bornes de saisie de l'offre : prix en centimes, quotas et plafond en scans.
OFFER_MAX_CENTS = 100_000
OFFER_MAX_SCANS = 100_000
# Photos envoyées au modèle : même borne que la contrainte `ck_plans_max_images`.
OFFER_MAX_IMAGES = 4

BillingInterval = Literal["month", "year"]


class OfferPriceOut(CamelModel):
    """Prix en euros d'un plan pour un intervalle. `stripe_price_id` : lecture seule, il ne
    sert qu'à l'admin (jamais renvoyé par la route publique)."""

    amount_cents: int
    stripe_price_id: str | None


class OfferPlanOut(CamelModel):
    """Un plan. `quota` : scans `full` par période ; `total_scan_cap` : plafond total (`None` :
    aucun) ; `prices` est vide pour l'essai."""

    code: str
    quota_period: str
    quota: int
    total_scan_cap: int | None
    max_images: int
    card_icons: bool
    prices: dict[BillingInterval, OfferPriceOut]


class AdminOfferOut(CamelModel):
    """L'offre dans l'ordre `trial`, `standard`, `premium`, et les 20 dernières actions
    `offer.*`."""

    plans: list[OfferPlanOut]
    actions: list[AdminActionOut]


class OfferPricesIn(CamelInModel):
    month: int | None = Field(default=None, ge=0, le=OFFER_MAX_CENTS)
    year: int | None = Field(default=None, ge=0, le=OFFER_MAX_CENTS)


class OfferPlanIn(CamelInModel):
    """Champs à modifier, tous optionnels. `total_scan_cap: null` explicite vide le plafond :
    l'absence du champ (`model_fields_set`) le laisse tel quel."""

    quota: int | None = Field(default=None, ge=0, le=OFFER_MAX_SCANS)
    total_scan_cap: int | None = Field(default=None, ge=0, le=OFFER_MAX_SCANS)
    max_images: int | None = Field(default=None, ge=0, le=OFFER_MAX_IMAGES)
    card_icons: bool | None = None
    prices: OfferPricesIn | None = None


class PublicPlanOut(CamelModel):
    """Un plan tel que le site l'affiche : jamais d'identifiant Stripe ; prix `None` pour l'essai
    ou quand il manque."""

    scans: int
    max_images: int
    card_icons: bool
    monthly_cents: int | None
    yearly_cents: int | None


class PublicOfferOut(CamelModel):
    """Réponse de `GET /api/offer`, lue par la page des prix du site."""

    trial: PublicPlanOut
    standard: PublicPlanOut
    premium: PublicPlanOut


class TopFailureOut(CamelModel):
    """Un code d'erreur et le nombre de scans en échec qui le portent."""

    code: str
    count: int


class DashboardStatsOut(CamelModel):
    """Les cartes du Tableau de bord sur une période. Parts et moyennes valent `None` quand leur
    dénominateur est nul (aucun scan, aucun scan réussi, aucun appel). `from_cache_pct` et
    `failed_pct` sont des pourcentages de 0 à 100. Coûts en dollars, lus dans `llm_calls`."""

    scans: int
    llm_calls: int
    from_cache_pct: float | None
    failed_pct: float | None
    top_failures: list[TopFailureOut]
    cost_usd: float
    avg_cost_usd: float | None
    web_searches: int
    avg_web_searches: float | None


class SubscribersOut(CamelModel):
    """Abonnements `active` par plan, et comptes créés dans les 7 derniers jours civils."""

    trial: int
    standard: int
    premium: int
    new_accounts_7_days: int


class MonthCostOut(CamelModel):
    """Coût du mois civil et projection linéaire sur le mois entier (`None` pendant les
    premières 24 h du mois)."""

    cost_usd: float
    projected_usd: float | None


class ActiveModelOut(CamelModel):
    provider: str
    slug: str


class LastPurgeOut(CamelModel):
    at: datetime
    deleted_scans: int


class DashboardHealthOut(CamelModel):
    """`active_model` : modèle actif du type `full` (`None` sans modèle actif). `last_purge` :
    dernière ligne `system.purge` du journal (`None` sans purge)."""

    active_model: ActiveModelOut | None
    search: SearchStatusOut
    last_purge: LastPurgeOut | None


class DashboardOut(CamelModel):
    today: DashboardStatsOut
    last_7_days: DashboardStatsOut
    subscribers: SubscribersOut
    month: MonthCostOut
    health: DashboardHealthOut


class DailyPointOut(CamelModel):
    """Un jour civil de Bruxelles : scans réussis servis depuis le cache, appels au modèle,
    scans en échec, et coût du jour en dollars."""

    date: date
    from_cache: int
    llm: int
    failed: int
    cost_usd: float


class DailyOut(CamelModel):
    """Un point par jour, jours vides compris, du plus ancien au plus récent."""

    points: list[DailyPointOut]


# --- Analyses (lecture seule) -------------------------------------------------------------
# Aucune de ces réponses ne porte d'email ni d'identifiant d'utilisateur : une analyse n'est pas
# une donnée personnelle et l'écran ne la relie jamais à un compte.

Locale = Literal["fr", "nl"]


class AnalysisRowOut(CamelModel):
    """Une ligne de la liste des analyses. `created_at` est la date du dernier appel au modèle ;
    `cost_usd` additionne tous les appels (`llm_calls`) ; `served` compte les `scan_results` qui
    pointent vers l'analyse."""

    id: int
    created_at: datetime
    site: str
    title: str
    score: int
    level: RiskLevel
    professional: bool
    model_id: int
    model: ActiveModelOut
    prompt_version_id: int
    prompt_version: int
    images_analyzed: int
    web_searches: int
    cost_usd: float
    llm_calls: int
    served: int
    partial: bool


class AnalysisListOut(CamelModel):
    """`next_before` : jeton opaque à repasser tel quel dans `before` pour la page suivante,
    `None` à la dernière page."""

    items: list[AnalysisRowOut]
    next_before: str | None


class AnalysisListingOut(CamelModel):
    """L'annonce du snapshot. `url` est `None` pour une annonce scannée avant la migration 0008 ;
    la description est déjà masquée (contacts)."""

    site: str
    external_id: str
    url: str | None
    title: str
    description: str
    price_cents: int | None
    currency: str | None
    images: list[str]
    captured_at: datetime


class AnalysisTextOut(CamelModel):
    summary: str
    advice: str


class AnalysisReasonRowOut(CamelModel):
    position: int
    severity: Severity
    fr: str
    nl: str


class AnalysisDetailResultOut(CamelModel):
    score: int
    level: RiskLevel
    professional: bool
    texts: dict[Locale, AnalysisTextOut]
    reasons: list[AnalysisReasonRowOut]


class AnalysisSearchOut(CamelModel):
    position: int
    query: str
    aspect: str


class AnalysisCallOut(CamelModel):
    """Un appel au modèle (`llm_calls`)."""

    created_at: datetime
    tokens_in: int
    tokens_out: int
    cost_usd: float
    images_analyzed: int
    web_searches: int


class AnalysisTechnicalOut(CamelModel):
    """Contexte technique. Tokens et coût sont ceux du dernier appel (ceux de l'analyse) ;
    `calls` liste tous les appels, du plus récent au plus ancien."""

    model: ActiveModelOut
    prompt_version_id: int
    prompt_version: int
    tokens_in: int
    tokens_out: int
    cost_usd: float
    images_analyzed: int
    input_hash: str
    created_at: datetime
    calls: list[AnalysisCallOut]


class AnalysisUsageOut(CamelModel):
    """Nombre de services de l'analyse, et dates du premier et du dernier (`None` si jamais
    servie). Jamais le demandeur."""

    served: int
    first_served_at: datetime | None
    last_served_at: datetime | None


class AnalysisDetailOut(CamelModel):
    listing: AnalysisListingOut
    result: AnalysisDetailResultOut
    searches: list[AnalysisSearchOut]
    technical: AnalysisTechnicalOut
    usage: AnalysisUsageOut
