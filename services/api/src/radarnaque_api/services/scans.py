"""Service de scan (spec §7.2).

Déroulé, dans cet ordre : 1. limite de requêtes, 2. droits, 3. validation de l'annonce,
4. snapshot masqué, 5. réservation du quota (le `scan_event`), 6. cache, 7. analyse sous verrou
consultatif. Toute erreur après la réservation enregistre un `scan_failures`, qui rend le scan à
l'utilisateur : ni un fournisseur en panne ni un bogue du serveur ne consomment son quota.

Un seul type de scan, `full` : les photos (selon l'offre) et la recherche web servent toute
annonce. Le nombre de photos envoyées entre dans la clé du cache.

Le scan se fait en deux temps : `admit_scan` (étapes 1 à 5), dont un refus est une erreur JSON
même pour la route en flux, puis `serve_admitted` (étapes 6 et 7, 180 s au plus), qui émet les
événements du scan vers un récepteur facultatif (`services/scan_stream.py`).

Superuser hors production (`privileges.debug`) : la réponse porte un bloc `debug`, aussi écrit
dans le logger `radarnaque.debug`, et `noCache` relance l'analyse sans consulter le cache."""

import asyncio
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, NoReturn
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import ColumnElement, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from radarnaque_api.auth.privileges import Privileges
from radarnaque_api.errors import ApiError
from radarnaque_api.images import (
    MAX_IMAGES,
    ImageFetchError,
    Resolver,
    default_resolve,
    fetch_images,
    is_allowed_url,
)
from radarnaque_api.llm.client import LLMClient, LLMError
from radarnaque_api.llm.payload import build_messages, summarize_messages
from radarnaque_api.llm.providers import ProviderError
from radarnaque_api.llm.tools import SearchTrace, WebSearchTool
from radarnaque_api.models import (
    Analysis,
    AppSettings,
    AuthUser,
    ScanEvent,
    ScanFailure,
    ScanResult,
    Site,
    SiteImageHost,
    Subscription,
)
from radarnaque_api.schemas import (
    AnalysisResultOut,
    DebugMessageOut,
    DebugSearchOut,
    DebugTimingsOut,
    PromptVersionDebugOut,
    RemainingOut,
    RiskLevel,
    ScanDebugOut,
    ScanIn,
)
from radarnaque_api.search import SearchBackend
from radarnaque_api.services.hashing import input_hash
from radarnaque_api.services.scan_store import (
    ActiveSetup,
    CacheKey,
    active_setup,
    load_analysis,
    save_analysis,
    upsert_snapshot,
    valid_analysis_id,
)
from radarnaque_api.services.scan_stream import ScanEvent as StreamEvent
from radarnaque_api.services.scan_stream import ScanEventSink, Stage
from radarnaque_api.services.subscriptions import get_active_subscription
from radarnaque_api.services.usage import compute_usage, plan_features, plan_max_images

RATE_WINDOW = timedelta(minutes=1)
SCAN_KIND = "full"  # type de scan unique ; `text` et `image` ne survivent que dans l'historique
CARD_ICONS_FEATURE = "card_icons"
INTERNAL_FAILURE = "internal"
ANALYSIS_TIMEOUT_S = 180  # toute l'analyse après l'admission : cache, photos, tours, recherches
TIMEOUT_FAILURE = "timeout"
# Le modèle reçoit la date du jour en Belgique : entre minuit et 2 h, la date UTC serait la veille.
LOCAL_TZ = ZoneInfo("Europe/Brussels")

logger = logging.getLogger(__name__)
# Logs détaillés du superuser hors production ; son gestionnaire console est posé par
# `create_app` (jamais en production).
debug_logger = logging.getLogger("radarnaque.debug")


class ScanError(ApiError):
    """Refus ou échec d'un scan (statut, code stable, détails), rendu tel quel par le
    gestionnaire des `ApiError`."""


class _NotConfigured(Exception):
    """Type de scan sans modèle actif ou sans version de prompt active (pour ce type)."""


def risk_level(score: int) -> RiskLevel:
    """Mêmes seuils que les règles locales (§4.4) : 0–29 faible, 30–59 moyen, 60+ élevé."""
    if score >= 60:
        return "high"
    if score >= 30:
        return "medium"
    return "low"


def from_cache_expr(result: Any = ScanResult) -> ColumnElement[bool]:
    """« Servi depuis le cache » pour la ligne `result` de `scan_results` (l'entité ou un alias
    de la requête englobante). Calculé, jamais stocké (règle R8) : il existe un résultat
    antérieur (identifiant d'événement plus petit) vers la même analyse, dont l'événement date
    d'après la création, ou le dernier rafraîchissement, de cette analyse.

    `analyses.created_at` est la date de l'événement qui a produit l'analyse : le scan qui a
    appelé le LLM n'a pas de prédécesseur plus récent, ceux qu'elle a servis en ont un.

    Limite connue : lors d'une course, le scan qui attendait le verrou peut avoir l'identifiant
    le plus petit ; il est alors marqué « pas depuis le cache » alors qu'il a été servi par
    l'analyse de l'autre."""
    earlier = aliased(ScanResult)
    earlier_event = aliased(ScanEvent)
    analysis = aliased(Analysis)
    return (
        select(earlier.scan_event_id)
        .join(earlier_event, earlier_event.id == earlier.scan_event_id)
        .join(analysis, analysis.id == earlier.analysis_id)
        .where(
            earlier.analysis_id == result.analysis_id,
            earlier.scan_event_id < result.scan_event_id,
            earlier_event.created_at >= analysis.created_at,
        )
        .exists()
    )


@dataclass(frozen=True)
class _Admission:
    """Scan admis et réservé (étapes 1 à 5)."""

    event_id: int
    event_at: datetime
    snapshot_id: int
    content_hash: str
    image_host_suffixes: list[str]
    cache_ttl: timedelta
    max_images: int  # photos au plus, selon l'offre (avant la limite du fournisseur)
    max_searches: int  # recherches web au plus (`settings.max_web_searches`)


@dataclass(frozen=True)
class _Trace:
    """Ce que le service a fait d'un scan de superuser, pour son bloc `debug`. `messages` est
    déjà résumé (photos en `[image n : …]`) : aucune donnée base64 ni secret n'y figure."""

    setup: ActiveSetup
    key: CacheKey
    system_prompt: str
    messages: list[dict[str, str]]
    raw_response: str | None
    llm_called: bool
    images_ms: int | None
    llm_ms: int | None
    rounds: int = 0
    searches: tuple[SearchTrace, ...] = ()
    reasoning: str = ""


def _invalid_listing(field: str) -> ScanError:
    return ScanError(422, "invalid_listing", "Annonce invalide.", {"field": field})


async def _check_rate_limit(session: AsyncSession, user_id: str, limit: int, at: datetime) -> None:
    recent = await session.scalar(
        select(func.count())
        .select_from(ScanEvent)
        .where(ScanEvent.user_id == user_id, ScanEvent.created_at > at - RATE_WINDOW)
    )
    if (recent or 0) >= limit:
        raise ScanError(429, "rate_limited", "Trop de scans en une minute, réessayez plus tard.")


async def _check_rights(session: AsyncSession, sub: Subscription | None, scan: ScanIn) -> None:
    """Abonnement actif exigé ; les icônes des cartes (`trigger="card"`) sont une fonctionnalité de
    l'offre. Les photos, elles, dépendent de l'offre (`plans.max_images`), pas d'un droit."""
    if sub is None:
        raise ScanError(402, "no_active_subscription", "Aucun abonnement actif.")
    if scan.trigger == "card" and CARD_ICONS_FEATURE not in await plan_features(session, sub.plan):
        raise ScanError(
            403,
            "feature_not_in_plan",
            "Fonctionnalité absente de l'offre.",
            {"feature": CARD_ICONS_FEATURE},
        )


async def _validated_site(session: AsyncSession, scan: ScanIn) -> tuple[int, list[str]]:
    """Identifiant du site et suffixes d'hôtes d'images autorisés ; chaque image est vérifiée,
    même celles qui ne seront pas envoyées (avant toute réservation du quota)."""
    listing = scan.listing
    site_id = await session.scalar(select(Site.id).where(Site.domain == listing.site))
    if site_id is None:
        raise _invalid_listing("listing.site")
    suffixes = list(
        await session.scalars(
            select(SiteImageHost.host_suffix).where(SiteImageHost.site_id == site_id)
        )
    )
    for position, url in enumerate(listing.images):
        if not is_allowed_url(str(url), suffixes):
            raise _invalid_listing(f"listing.images.{position}")
    return site_id, suffixes


async def _reserve(
    session: AsyncSession,
    user: AuthUser,
    privileges: Privileges,
    scan: ScanIn,
    at: datetime,
    rate_limit: int,
) -> int:
    """Étape 5, en une transaction. Un verrou consultatif propre à l'utilisateur couvre le
    recomptage de la limite de requêtes et l'insertion de l'événement : des scans simultanés ne
    la dépassent pas, admins compris. Puis l'abonnement actif est verrouillé (`FOR UPDATE`) le
    temps de compter le quota. Un compte illimité (admin, superuser hors production) passe sans
    abonnement ni comptage du quota, mais son événement est enregistré. Les deux verrous sont
    toujours pris dans cet ordre. Le superuser hors production n'est pas soumis à la limite :
    il ne prend aucun des deux."""
    if privileges.rate_limited:
        await session.execute(
            select(func.pg_advisory_xact_lock(func.hashtextextended(f"rate:{user.id}", 0)))
        )
        await _check_rate_limit(session, user.id, rate_limit, at)
    if not privileges.unlimited:
        sub = (
            await session.execute(
                select(Subscription)
                .where(Subscription.user_id == user.id, Subscription.status == "active")
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if sub is None:
            raise ScanError(402, "no_active_subscription", "Aucun abonnement actif.")
        usage = await compute_usage(session, sub, at)
        kind = usage.per_kind.get(SCAN_KIND)
        if kind is None or kind.remaining <= 0:  # `remaining` tient déjà compte du plafond
            raise ScanError(
                402,
                "quota_exhausted",
                "Quota de scans atteint.",
                {"plan": sub.plan, "scanKind": SCAN_KIND},
            )
    event_id = (
        await session.execute(
            insert(ScanEvent)
            .values(user_id=user.id, scan_kind=SCAN_KIND, trigger=scan.trigger, created_at=at)
            .returning(ScanEvent.id)
        )
    ).scalar_one()
    await session.commit()
    return event_id


async def _admit(
    session: AsyncSession,
    user: AuthUser,
    privileges: Privileges,
    scan: ScanIn,
    now: Callable[[], datetime],
) -> _Admission:
    """Étapes 1 à 5. Une `ScanError` levée ici ne laisse aucun événement."""
    settings = (await session.execute(select(AppSettings))).scalar_one()
    # Lus tout de suite : rien ne dépend de l'objet `settings` après les commits qui suivent.
    rate_limit = settings.rate_limit_per_minute
    cache_ttl = timedelta(hours=settings.cache_ttl_hours)
    max_searches = settings.max_web_searches
    # Premier contrôle sans verrou, pour refuser tôt ; `_reserve` recompte sous verrou.
    if privileges.rate_limited:
        await _check_rate_limit(session, user.id, rate_limit, now())
    # Toutes les fonctionnalités vont de pair avec l'absence de quota (admin, superuser hors
    # production) : ni l'offre ni l'abonnement ne sont alors consultés ; leurs photos viennent de
    # `plan_max_images` (Premium pour le superuser, le maximum pour l'admin).
    sub = None if privileges.all_features else await get_active_subscription(session, user.id)
    if not privileges.all_features:
        await _check_rights(session, sub, scan)
    max_images = await plan_max_images(session, sub.plan if sub else None, privileges)
    site_id, suffixes = await _validated_site(session, scan)
    snapshot_id, digest = await upsert_snapshot(session, site_id, scan.listing, now())
    event_at = now()  # date de l'événement, et de l'analyse qu'il produira (règle R8)
    event_id = await _reserve(session, user, privileges, scan, event_at, rate_limit)
    return _Admission(
        event_id=event_id,
        event_at=event_at,
        snapshot_id=snapshot_id,
        content_hash=digest,
        image_host_suffixes=suffixes,
        cache_ttl=cache_ttl,
        max_images=max_images,
        max_searches=max_searches,
    )


def _link(session: AsyncSession, event_id: int, analysis_id: int) -> None:
    session.add(ScanResult(scan_event_id=event_id, analysis_id=analysis_id))


async def _emit(on_event: ScanEventSink | None, event: StreamEvent) -> None:
    """Émet un événement du flux (`StreamEvent` : le `ScanEvent` de `scan_stream`, renommé à
    l'import pour ne pas masquer le modèle de la table `scan_events`)."""
    if on_event is not None:
        await on_event(event)


async def _serve(
    maker: async_sessionmaker[AsyncSession],
    admission: _Admission,
    scan: ScanIn,
    privileges: Privileges,
    *,
    llm_for: Callable[[str], LLMClient],
    http: httpx.AsyncClient,
    resolve: Resolver,
    search: SearchBackend | None,
    on_event: ScanEventSink | None,
) -> _Trace | None:
    """Étapes 6 et 7 : relie l'événement à une analyse, en cache ou nouvelle. Renvoie la trace
    du scan pour le bloc debug, `None` sans le privilège `debug`.

    Événements : `cache` pour un succès du cache ; sinon `photos` (s'il y en a à télécharger),
    `analyzing`, puis ceux du client LLM. Sans moteur de recherche (`search` à None), ou avec
    `max_web_searches` à 0, aucun outil n'est proposé au modèle.

    `noCache` (superuser hors production seulement) saute les deux lectures du cache : le LLM
    est rappelé et l'analyse enregistrée par `save_analysis`, qui rafraîchit sur place l'entrée
    existante (règle R4), sous le même verrou consultatif."""
    debug = privileges.debug
    fresh = debug and scan.no_cache
    async with maker() as session:
        setup = await active_setup(session, SCAN_KIND)
        if setup is None:
            raise _NotConfigured
        # Le fournisseur borne les photos, donc la clé du cache : il est résolu avant la lecture
        # du cache. Un fournisseur devenu inconnu ne fait pas échouer un succès du cache.
        client = _client_for(llm_for, setup.provider)
        photos = _photos_to_send(admission, scan, client)
        key = CacheKey(
            snapshot_id=admission.snapshot_id,
            model_id=setup.model_id,
            prompt_version_id=setup.prompt_version_id,
            input_hash=input_hash(scan, photos),
        )
        cached = (
            None
            if fresh
            else await valid_analysis_id(session, key, admission.event_at, admission.cache_ttl)
        )
        if cached is not None:
            trace = _cached_trace(setup, key, scan, client, admission, photos) if debug else None
            _link(session, admission.event_id, cached)
            await session.commit()
            await _emit(on_event, Stage("cache"))
            return trace

    # Nouvelle connexion : le verrou consultatif, propre à la clé du cache, est libéré par le
    # commit (ou le rollback). Un scan concurrent de la même annonce l'attend, puis trouve
    # l'analyse en revérifiant le cache : un seul appel LLM.
    async with maker() as session, session.begin():
        await session.execute(
            select(func.pg_advisory_xact_lock(func.hashtextextended(key.lock_name(), 0)))
        )
        analysis_id = (
            None
            if fresh
            else await valid_analysis_id(session, key, admission.event_at, admission.cache_ttl)
        )
        if analysis_id is None:
            if isinstance(client, ProviderError):
                raise client
            llm = client
            images_ms: int | None = None
            images: list[str] = []
            if photos:
                await _emit(on_event, Stage("photos", photos))
                started = time.perf_counter()
                images = await fetch_images(
                    [str(url) for url in scan.listing.images],
                    admission.image_host_suffixes,
                    http=http,
                    resolve=resolve,
                    limit=photos,
                )
                images_ms = _elapsed_ms(started)
            # `fetch_images` rend toutes les photos demandées ou échoue : `photos` sont envoyées.
            messages = build_messages(
                scan.listing, scan.rules, images, today=_today(admission), images_sent=photos
            )
            tools = (
                WebSearchTool(search, admission.max_searches, on_event)
                if search is not None and admission.max_searches > 0
                else None
            )
            await _emit(on_event, Stage("analyzing", photos))
            started = time.perf_counter()
            result = await llm.analyze(
                model=setup.slug,
                system_prompt=setup.system_prompt,
                messages=messages,
                tools=tools,
                on_event=on_event,
            )
            llm_ms = _elapsed_ms(started)
            analysis_id = await save_analysis(
                session, key, scan, result, admission.event_at, images_analyzed=len(images)
            )
            trace = (
                _Trace(
                    setup=setup,
                    key=key,
                    # Un faux client (tests) peut ne pas renseigner le prompt envoyé.
                    system_prompt=result.system_prompt
                    or _final_system_prompt(llm, setup.system_prompt),
                    messages=summarize_messages(messages),
                    raw_response=result.raw_text,
                    llm_called=True,
                    images_ms=images_ms,
                    llm_ms=llm_ms,
                    rounds=result.rounds,
                    searches=tuple(result.search_traces),
                    reasoning=result.reasoning_text,
                )
                if debug
                else None
            )
            cache_hit = False
        else:  # analysée par un scan concurrent pendant l'attente du verrou
            trace = _cached_trace(setup, key, scan, client, admission, photos) if debug else None
            cache_hit = True
        _link(session, admission.event_id, analysis_id)
    if cache_hit:  # après le commit, comme le succès de la première lecture du cache
        await _emit(on_event, Stage("cache"))
    return trace


def _elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


def _final_system_prompt(llm: LLMClient, system_prompt: str) -> str:
    """Prompt système tel que le client l'enverrait (schéma ajouté en mode `json_object`). Un
    client sans `final_system_prompt` (faux client des tests) l'envoie tel quel."""
    final = getattr(llm, "final_system_prompt", None)
    return system_prompt if final is None else final(system_prompt)


def _client_for(llm_for: Callable[[str], LLMClient], provider: str) -> LLMClient | ProviderError:
    """Client du fournisseur, ou l'erreur si le fournisseur est inconnu : rien n'échoue tant que
    l'appel au LLM n'est pas nécessaire (un succès du cache reste un succès)."""
    try:
        return llm_for(provider)
    except ProviderError as exc:
        return exc


def _photos_to_send(admission: _Admission, scan: ScanIn, client: LLMClient | ProviderError) -> int:
    """Photos envoyées au modèle : au plus celles de l'offre, du fournisseur (la limite globale
    si le fournisseur est inconnu) et de l'annonce. Entre dans la clé du cache."""
    provider_limit = MAX_IMAGES if isinstance(client, ProviderError) else _image_limit(client)
    return min(admission.max_images, provider_limit, len(scan.listing.images))


def _today(admission: _Admission) -> date:
    """Date du jour à Bruxelles au moment de l'événement, donnée au modèle (hors des
    empreintes)."""
    return admission.event_at.astimezone(LOCAL_TZ).date()


def _cached_trace(
    setup: ActiveSetup,
    key: CacheKey,
    scan: ScanIn,
    client: LLMClient | ProviderError,
    admission: _Admission,
    photos: int,
) -> _Trace:
    """Trace d'un scan servi par le cache : les messages qui auraient été envoyés, construits
    sans appel au LLM ni téléchargement des photos (résumées comme non téléchargées). Un
    fournisseur devenu inconnu ne fait pas échouer ce succès du cache : le prompt système brut
    est repris."""
    messages = build_messages(
        scan.listing, scan.rules, [], today=_today(admission), images_sent=photos
    )
    return _Trace(
        setup=setup,
        key=key,
        system_prompt=(
            setup.system_prompt
            if isinstance(client, ProviderError)
            else _final_system_prompt(client, setup.system_prompt)
        ),
        messages=summarize_messages(messages, cached_images=photos),
        raw_response=None,
        llm_called=False,
        images_ms=None,
        llm_ms=None,
    )


def _image_limit(llm: LLMClient) -> int:
    """Photos envoyées : la limite globale, réduite si le fournisseur en accepte moins (Groq :
    3). Un client sans `max_images` (faux client des tests, par exemple) n'en a pas."""
    provider_limit = getattr(llm, "max_images", None)
    return MAX_IMAGES if provider_limit is None else min(MAX_IMAGES, provider_limit)


def _failure_code(exc: Exception) -> str:
    """Code stocké dans `scan_failures` et renvoyé dans `details.reason` : jamais de message
    brut ni de corps de réponse du fournisseur."""
    if isinstance(exc, LLMError):
        return exc.code
    if isinstance(exc, TimeoutError):  # délai total de l'analyse (`ANALYSIS_TIMEOUT_S`)
        return TIMEOUT_FAILURE
    if isinstance(exc, ImageFetchError):
        return f"image_{exc.reason}"
    if isinstance(exc, ProviderError | _NotConfigured):
        return "configuration"
    return INTERNAL_FAILURE


async def _record_failure(
    maker: async_sessionmaker[AsyncSession], event_id: int, code: str, at: datetime
) -> None:
    """Rend le scan, dans une nouvelle transaction.

    Si l'écriture échoue, le scan reste décompté : une ligne ERROR le signale (l'identifiant de
    l'événement et la classe de l'exception, jamais son message, qui peut porter des données),
    puis l'erreur remonte comme avant. Le rapprochement automatique viendra en phase 4."""
    try:
        async with maker() as session, session.begin():
            session.add(ScanFailure(scan_event_id=event_id, error_code=code, created_at=at))
    except (Exception, asyncio.CancelledError) as exc:
        logger.error(
            "remboursement impossible pour scan_event_id=%s (%s)", event_id, type(exc).__name__
        )
        raise


async def _give_back(
    maker: async_sessionmaker[AsyncSession], event_id: int, exc: Exception, at: datetime
) -> NoReturn:
    """Rend le scan, puis lève `502 analysis_failed`, ou relance une erreur inattendue telle
    quelle (500) une fois le scan rendu (règle R10)."""
    code = _failure_code(exc)
    await _record_failure(maker, event_id, code, at)
    if code == INTERNAL_FAILURE:
        raise exc
    raise ScanError(
        502, "analysis_failed", "L'analyse a échoué ; ce scan n'est pas décompté.", {"reason": code}
    )


async def _remaining(
    session: AsyncSession, user: AuthUser, privileges: Privileges, at: datetime
) -> RemainingOut:
    sub = None if privileges.unlimited else await get_active_subscription(session, user.id)
    if sub is None:  # compte illimité
        return RemainingOut(scans=None)
    usage = await compute_usage(session, sub, at)
    full = usage.per_kind.get(SCAN_KIND)
    return RemainingOut(scans=None if full is None else full.remaining)


def _debug_block(
    trace: _Trace,
    admission: _Admission,
    scan: ScanIn,
    analysis: Analysis,
    from_cache: bool,
    started: float,
) -> ScanDebugOut:
    """Bloc debug du superuser : jetons et coût de l'analyse servie, empreintes et identifiants
    du déroulé, tours, recherches et réflexion du modèle, durée totale depuis le début du scan
    (avant l'admission)."""
    return ScanDebugOut(
        provider=trace.setup.provider,
        model=trace.setup.slug,
        prompt_version=PromptVersionDebugOut(
            scan_kind=SCAN_KIND, version=trace.setup.prompt_version
        ),
        system_prompt=trace.system_prompt,
        messages=[DebugMessageOut(**message) for message in trace.messages],
        raw_response=trace.raw_response,
        llm_called=trace.llm_called,
        from_cache=from_cache,
        tokens_in=analysis.tokens_in,
        tokens_out=analysis.tokens_out,
        cost_usd_micros=analysis.cost_usd_micros,
        timings_ms=DebugTimingsOut(
            images=trace.images_ms,
            llm=trace.llm_ms,
            search=sum(s.ms for s in trace.searches) if trace.searches else None,
            total=_elapsed_ms(started),
        ),
        rounds=trace.rounds,
        searches=[
            DebugSearchOut(query=s.query, aspect=s.aspect, ok=s.ok, output=s.output, ms=s.ms)
            for s in trace.searches
        ],
        reasoning=trace.reasoning,
        content_hash=admission.content_hash,
        input_hash=trace.key.input_hash,
        snapshot_id=admission.snapshot_id,
        analysis_id=analysis.id,
    )


def _log_debug(scan: ScanIn, debug: ScanDebugOut) -> None:
    """Un enregistrement par scan de superuser : en-tête, puis le bloc `debug` en JSON indenté.
    Le bloc ne contient ni secret ni photo en base64 (voir `ScanDebugOut`)."""
    listing = scan.listing
    debug_logger.info(
        "[debug superuser] scan %s %s|%s\n%s",
        SCAN_KIND,
        listing.site,
        listing.external_id,
        json.dumps(debug.model_dump(mode="json", by_alias=True), ensure_ascii=False, indent=2),
    )


async def _result(
    engine: AsyncEngine,
    user: AuthUser,
    privileges: Privileges,
    admission: _Admission,
    scan: ScanIn,
    at: datetime,
    *,
    trace: _Trace | None = None,
    started: float = 0.0,
) -> AnalysisResultOut:
    """Réponse du scan de `admission`, déjà relié à son analyse ; avec `trace` (superuser hors
    production), elle porte le bloc `debug`, `started` donnant le début du scan.

    Appelée après le commit du `scan_result` : si elle échoue (base indisponible…), l'erreur
    remonte (500) mais le scan reste décompté et l'analyse conservée. C'est voulu : l'analyse a
    bien été servie et figure dans l'historique, et la redemander la sert depuis le cache."""
    # Une seule image de la base pour toute la réponse : un rafraîchissement concurrent de
    # l'analyse (règle R4) ne mélange pas l'ancienne note et les nouveaux textes.
    snapshot_engine = engine.execution_options(isolation_level="REPEATABLE READ")
    async with AsyncSession(snapshot_engine, expire_on_commit=False) as session:
        analysis, from_cache = (
            await session.execute(
                select(Analysis, from_cache_expr())
                .join(ScanResult, ScanResult.analysis_id == Analysis.id)
                .where(ScanResult.scan_event_id == admission.event_id)
            )
        ).one()
        texts = await load_analysis(session, analysis.id)
        remaining = await _remaining(session, user, privileges, at)
    return AnalysisResultOut(
        analysis_id=analysis.id,
        score=analysis.score,
        level=risk_level(analysis.score),
        partial=analysis.partial,
        professional=analysis.professional,
        from_cache=from_cache,
        summary=texts.summary,
        advice=texts.advice,
        reasons=texts.reasons,
        images_analyzed=analysis.images_analyzed,
        web_searches=texts.web_searches,
        analyzed_at=analysis.created_at,
        remaining=remaining,
        debug=None
        if trace is None
        else _debug_block(trace, admission, scan, analysis, from_cache, started),
    )


@dataclass(frozen=True)
class _Admitted:
    """Scan admis et réservé par `admit_scan`, prêt à être servi par `serve_admitted`."""

    engine: AsyncEngine
    maker: async_sessionmaker[AsyncSession]
    user: AuthUser
    privileges: Privileges
    scan: ScanIn
    admission: _Admission
    llm_for: Callable[[str], LLMClient]
    http: httpx.AsyncClient
    search: SearchBackend | None
    now: Callable[[], datetime]
    resolve: Resolver
    started: float  # début du scan (`time.perf_counter`), pour la durée totale du bloc debug


async def admit_scan(
    *,
    engine: AsyncEngine,
    user: AuthUser,
    privileges: Privileges,
    scan: ScanIn,
    llm_for: Callable[[str], LLMClient],
    http: httpx.AsyncClient,
    now: Callable[[], datetime],
    search: SearchBackend | None = None,
    resolve: Resolver = default_resolve,
) -> _Admitted:
    """Étapes 1 à 5 : lève `ScanError` pour un refus (402, 403, 422, 429), sans rien réserver.
    Une fois admis, le scan est décompté : `serve_admitted` doit suivre, qui le rend en cas
    d'échec.

    `privileges` : ceux de `user` (`privileges_of`), qui décident de la limite de requêtes, des
    droits et du quota. `llm_for(code)` donne le client du fournisseur du modèle actif. `http`
    est le client dédié aux photos (règles R6/R7 : `trust_env=False`, `follow_redirects=False`,
    ni en-têtes, ni cookies, ni authentification partagés), jamais celui du LLM. `search` : le
    moteur de recherche web (`None` : aucun outil proposé au modèle). `resolve` remplace la
    résolution DNS des hôtes d'images (tests)."""
    started = time.perf_counter()
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as session:
        admission = await _admit(session, user, privileges, scan, now)
    return _Admitted(
        engine=engine,
        maker=maker,
        user=user,
        privileges=privileges,
        scan=scan,
        admission=admission,
        llm_for=llm_for,
        http=http,
        search=search,
        now=now,
        resolve=resolve,
        started=started,
    )


async def serve_admitted(
    admitted: _Admitted,
    on_event: ScanEventSink | None = None,
    *,
    timeout_s: float = ANALYSIS_TIMEOUT_S,
) -> AnalysisResultOut:
    """Étapes 6 et 7, en `timeout_s` secondes au plus ; `on_event` reçoit les événements du
    scan. Toute erreur rend le scan : un échec de l'analyse, ou le délai dépassé, donne
    `502 analysis_failed` (`details.reason`) ; une annulation (client parti) est propagée."""
    admission, maker, now = admitted.admission, admitted.maker, admitted.now
    failure: Exception | None = None
    trace: _Trace | None = None
    try:
        # Le délai annule l'étape en cours (verrou consultatif libéré par le rollback) et
        # devient une `TimeoutError` à la sortie du bloc : `_failure_code` la note `timeout`.
        async with asyncio.timeout(timeout_s):
            trace = await _serve(
                maker,
                admission,
                admitted.scan,
                admitted.privileges,
                llm_for=admitted.llm_for,
                http=admitted.http,
                resolve=admitted.resolve,
                search=admitted.search,
                on_event=on_event,
            )
    except asyncio.CancelledError:
        # Annulation (client parti, arrêt du serveur) : une `BaseException`, que `except
        # Exception` laisserait passer. Le scan est rendu sous `shield`, pour que l'écriture
        # aboutisse même si l'annulation se répète, puis l'annulation continue.
        await asyncio.shield(_record_failure(maker, admission.event_id, INTERNAL_FAILURE, now()))
        raise
    except Exception as exc:  # toute erreur après la réservation rend le scan
        failure = exc
    if failure is not None:  # hors du `except` : aucun contexte chaîné à l'erreur rendue
        await _give_back(maker, admission.event_id, failure, now())

    result = await _result(
        admitted.engine,
        admitted.user,
        admitted.privileges,
        admission,
        admitted.scan,
        now(),
        trace=trace,
        started=admitted.started,
    )
    if result.debug is not None:
        _log_debug(admitted.scan, result.debug)
    return result


async def give_back_unserved(admitted: _Admitted) -> None:
    """Rend un scan admis que `serve_admitted` n'a jamais servi (client parti avant le début
    du flux)."""
    await _record_failure(
        admitted.maker, admitted.admission.event_id, INTERNAL_FAILURE, admitted.now()
    )


async def run_scan(
    *,
    engine: AsyncEngine,
    user: AuthUser,
    privileges: Privileges,
    scan: ScanIn,
    llm_for: Callable[[str], LLMClient],
    http: httpx.AsyncClient,
    now: Callable[[], datetime],
    search: SearchBackend | None = None,
    on_event: ScanEventSink | None = None,
    resolve: Resolver = default_resolve,
    timeout_s: float = ANALYSIS_TIMEOUT_S,
) -> AnalysisResultOut:
    """Lance un scan pour `user` et renvoie le résultat : `admit_scan` puis `serve_admitted`
    (voir leurs paramètres). Lève `ScanError` pour un refus (402, 403, 422, 429) ou un échec de
    l'analyse (502)."""
    admitted = await admit_scan(
        engine=engine,
        user=user,
        privileges=privileges,
        scan=scan,
        llm_for=llm_for,
        http=http,
        now=now,
        search=search,
        resolve=resolve,
    )
    return await serve_admitted(admitted, on_event, timeout_s=timeout_s)
