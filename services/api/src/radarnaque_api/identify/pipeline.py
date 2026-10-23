"""Pipeline d'identification du produit (spec §3) : lecture des photos, critères de distinction
(base partagée, sinon recherches, pages lues et extraction), vérification sur les photos,
confiance calculée par l'API (§4), puis une relance au plus.

Les photos sont téléchargées une seule fois et gardées en mémoire. Aucune URL écrite par le
modèle n'est rendue : les pages sont des numéros de résultats de recherche, revérifiés. Le
résultat n'est pas enregistré ici (`store.save_identification`) ; une erreur de `read_photos`
ou d'`identify` (`LLMError`), des photos (`ImageFetchError`) ou d'un fournisseur inconnu
(`ProviderError`) remonte à l'appelant."""

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field, fields
from datetime import datetime, timedelta
from typing import Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from radarnaque_api.identify.confidence import (
    CheckEvidence,
    Level,
    ObjectEvidence,
    level_of,
    object_confidence,
    overall_status,
)
from radarnaque_api.identify.criteria_store import (
    candidates_key,
    lock_criteria,
    normalize_name,
    save_criteria,
    valid_criteria,
)
from radarnaque_api.identify.payload import (
    build_criteria_messages,
    build_identify_messages,
    build_read_photos_messages,
)
from radarnaque_api.identify.research import (
    Query,
    SearchOutcome,
    criteria_queries,
    price_query,
    reference_query,
    run_searches,
)
from radarnaque_api.identify.schemas import (
    SCHEMA_CRITERIA,
    SCHEMA_IDENTIFY,
    SCHEMA_READ_PHOTOS,
    CheckOut,
    CriteriaOut,
    CriteriaSetView,
    ExpectedValue,
    ExtractedCriterion,
    IdentifyOut,
    ReadPhotosObject,
    ReadPhotosOut,
    StoredCriterion,
)
from radarnaque_api.identify.store import StepSetup, record_criteria_call
from radarnaque_api.images import Resolver, fetch_images
from radarnaque_api.llm.client import LLMClient, LLMError, StepResult
from radarnaque_api.llm.events import CriteriaCached
from radarnaque_api.llm.payload import summarize_messages
from radarnaque_api.llm.providers import ReasoningEffort
from radarnaque_api.models import AppSettings
from radarnaque_api.pages import PageText
from radarnaque_api.schemas import (
    DebugMessageOut,
    IdentificationStatus,
    IdentifyDebugOut,
    IdentifyStepDebugOut,
    ListingIn,
    ScanIn,
)
from radarnaque_api.search import DOMAIN_MAX, URL_MAX, SearchBackend, SearchHit, clean_query
from radarnaque_api.services.scan_stream import ScanEventSink, Stage

logger = logging.getLogger(__name__)

StepCode = Literal["read_photos", "criteria", "identify"]
Observation = Literal["seen_match", "seen_contrary", "not_visible"]

_VALUE_RANK = {"high": 0, "medium": 1, "low": 2}
_BAD_URL_CHARS = re.compile(r"[\s\x00-\x1f\x7f]")
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
NAME_MAX = 120


@dataclass(frozen=True)
class IdentifySettings:
    """Réglages de l'identification (`settings`), lus une fois au début du scan."""

    identification_cache_ttl_hours: int
    criteria_ttl_days: int
    criteria_max_searches: int
    criteria_max_pages: int
    identify_retry_threshold: int
    identify_image_side: int
    scam_sends_photos: bool
    identify_escalation_model_id: int | None

    @classmethod
    def of(cls, row: AppSettings) -> "IdentifySettings":
        return cls(**{f.name: getattr(row, f.name) for f in fields(cls)})


@dataclass
class PipelineContext:
    """Ce dont le pipeline a besoin. `photos` : photos à envoyer (offre, fournisseur et annonce,
    déjà bornées par l'appelant) ; `escalation` : modèle de la relance (`None` : celui
    d'`identify`) ; `at` : date de l'événement, celle des critères enregistrés."""

    steps: dict[str, StepSetup]
    llm_for: Callable[[str], LLMClient]
    search: SearchBackend | None
    http_images: httpx.AsyncClient
    http_pages: httpx.AsyncClient
    resolve: Resolver
    maker: async_sessionmaker[AsyncSession]
    settings: IdentifySettings
    image_host_suffixes: list[str]
    photos: int
    at: datetime
    escalation: StepSetup | None


@dataclass(frozen=True)
class CallRecord:
    """Un appel au modèle, pour `llm_calls` (`criteria_set_id` : appel `criteria` seulement).
    La ligne d'un appel `criteria` est écrite dans la transaction des critères, celle des autres
    par `save_identification`."""

    step: StepCode
    model_id: int
    prompt_version_id: int
    tokens_in: int
    tokens_out: int
    cost_usd_micros: int
    images: int
    web_searches: int
    criteria_set_id: int | None = None


@dataclass(frozen=True)
class CheckRecord:
    """Un critère vérifié, avec sa copie (texte, `decisive`, sources `(url, titre, domaine)`).
    `criterion_id` : `None` pour un critère non sourcé, absent de la base."""

    criterion_id: int | None
    text_fr: str
    text_nl: str
    decisive: bool
    sources: tuple[tuple[str, str, str], ...]
    observation: Observation
    photo: int | None


@dataclass(frozen=True)
class PageLink:
    url: str
    title: str
    domain: str


@dataclass(frozen=True)
class ObjectRecord:
    role: Literal["main", "accessory"]
    label: str
    reference: str | None
    remaining: tuple[str, ...]
    confidence: int
    level: Level
    checks: tuple[CheckRecord, ...]
    pages: tuple[PageLink, ...]
    criteria_set_id: int | None


@dataclass(frozen=True)
class SearchLog:
    """Une recherche faite : requête nettoyée, type, domaines des pages lues. `search_id` : le
    numéro de l'événement `search`, qui donne l'ordre d'affichage."""

    search_id: int
    query: str
    kind: str
    pages_read: tuple[str, ...]


@dataclass(frozen=True)
class StepTrace:
    """Un appel au modèle pour le bloc debug : messages déjà résumés (aucune photo en base64)."""

    step: StepCode
    provider: str
    model: str
    system_prompt: str
    messages: list[dict[str, str]]
    raw_response: str
    ms: int
    tokens_in: int
    tokens_out: int
    cost_usd_micros: int


@dataclass
class PipelineRun:
    """Résultat d'un pipeline. `objects` : un par objet de `read_photos`, dans son ordre ;
    `status`, `confidence` et `verified_criteria` : ceux de l'objet principal (`none` et 0 sans
    objet)."""

    read_photos: ReadPhotosOut | None = None
    identify: IdentifyOut | None = None
    objects: list[ObjectRecord] = field(default_factory=list)
    status: IdentificationStatus = "none"
    confidence: int = 0
    searches: list[SearchLog] = field(default_factory=list)
    price_hits: list[SearchHit] = field(default_factory=list)
    calls: list[CallRecord] = field(default_factory=list)
    retried: bool = False
    unsourced: bool = False
    verified_criteria: bool = False
    images_analyzed: int = 0
    traces: list[StepTrace] = field(default_factory=list)

    def debug(self) -> IdentifyDebugOut:
        return IdentifyDebugOut(
            steps=[
                IdentifyStepDebugOut(
                    step=t.step,
                    provider=t.provider,
                    model=t.model,
                    system_prompt=t.system_prompt,
                    messages=[DebugMessageOut(**m) for m in t.messages],
                    raw_response=t.raw_response,
                    ms=t.ms,
                    tokens_in=t.tokens_in,
                    tokens_out=t.tokens_out,
                    cost_usd_micros=t.cost_usd_micros,
                )
                for t in self.traces
            ]
        )


@dataclass(frozen=True)
class _Criteria:
    """Critères d'un objet visé. `stored` : ceux de la base (identifiants valides) ; `hits` :
    extraits des recherches de critères, montrés à `identify`."""

    items: tuple[StoredCriterion, ...] = ()
    stored: bool = False
    set_id: int | None = None
    verified: bool = False
    unsourced: bool = False
    hits: tuple[SearchHit, ...] = ()


class _SearchIds:
    """Numéros des événements `search`, continus sur tout le pipeline : chaque lot de requêtes
    réserve les siens avant de les lancer (aucun `await` entre la lecture et l'avance)."""

    def __init__(self) -> None:
        self._next = 1

    def take(self, count: int) -> int:
        first = self._next
        self._next += count
        return first


async def run_pipeline(
    ctx: PipelineContext, scan: ScanIn, on_event: ScanEventSink | None
) -> PipelineRun:
    """Déroulé de la spec §3 : photos, `read_photos`, critères des objets visés (en parallèle
    des recherches de fiche technique et de prix), `identify`, confiance, relance éventuelle.
    `IdentificationReady` est émis par l'appelant, après l'enregistrement."""

    async def emit(event) -> None:
        if on_event is not None:
            await on_event(event)

    run = PipelineRun()
    ids = _SearchIds()
    listing = scan.listing
    images: list[str] = []
    if ctx.photos > 0:
        await emit(Stage("photos", ctx.photos))
        images = await fetch_images(
            [str(url) for url in listing.images],
            ctx.image_host_suffixes,
            http=ctx.http_images,
            resolve=ctx.resolve,
            limit=ctx.photos,
            max_side=ctx.settings.identify_image_side,
        )
    run.images_analyzed = len(images)

    await emit(Stage("reading_photos"))
    setup = ctx.steps["read_photos"]
    result = await _call(
        ctx,
        run,
        setup,
        build_read_photos_messages(listing, images),
        ReadPhotosOut,
        SCHEMA_READ_PHOTOS,
        "none",
        on_event,
    )
    run.calls.append(_record("read_photos", setup, result, images=len(images)))
    read = run.read_photos = result.output
    if read.status == "nothing":
        return run

    targets = _targets(read.objects)
    main = targets[0]
    side_queries = [reference_query(read.objects[n - 1].candidates[0]) for n in targets]
    side_queries.append(price_query(read.objects[main - 1].candidates[0]))
    side_first = ids.take(len(side_queries))
    side, *found = await _gather(
        run_searches(
            side_queries,
            backend=ctx.search,
            http_pages=ctx.http_pages,
            max_pages=0,
            page_kinds=frozenset(),
            on_event=on_event,
            first_id=side_first,
            resolve=ctx.resolve,
        ),
        *(_criteria_for(ctx, run, read, read.objects[n - 1], ids, emit) for n in targets),
    )
    _log_searches(run, side_queries, side, side_first)
    criteria: dict[int, _Criteria] = dict(zip(targets, found, strict=True))
    run.price_hits = list(side.hits.get(side_queries[-1], []))
    hits = _unique(
        [h for q in side_queries[:-1] for h in side.hits.get(q, [])]
        + [h for c in found for h in c.hits]
    )

    await emit(Stage("identifying"))
    identify = await _identify(
        ctx, run, ctx.steps["identify"], listing, images, read, criteria, hits, on_event
    )
    _resolve(run, read, identify, criteria, hits, targets, len(images))

    retry_text = clean_query(identify.retry_query or "")
    if run.confidence < ctx.settings.identify_retry_threshold and retry_text:
        run.retried = True
        await emit(Stage("retrying"))
        query = Query(retry_text, "retry")
        first = ids.take(1)
        outcome = await run_searches(
            [query],
            backend=ctx.search,
            http_pages=ctx.http_pages,
            max_pages=1,
            page_kinds=frozenset({"retry"}),
            on_event=on_event,
            first_id=first,
            resolve=ctx.resolve,
        )
        _log_searches(run, [query], outcome, first)
        retry_hits = outcome.hits.get(query, [])
        criteria[main] = await _complete_criteria(
            ctx,
            run,
            read,
            read.objects[main - 1],
            criteria[main],
            outcome.pages,
            retry_hits,
            on_event,
        )
        hits = _unique(hits + retry_hits)
        identify = await _identify(
            ctx,
            run,
            ctx.escalation or ctx.steps["identify"],
            listing,
            images,
            read,
            criteria,
            hits,
            on_event,
        )
        _resolve(run, read, identify, criteria, hits, targets, len(images))

    run.searches.sort(key=lambda s: s.search_id)
    run.unsourced = any(c.unsourced for c in criteria.values())
    return run


# --- Étapes ------------------------------------------------------------------------------------


async def _call[T: BaseModel](
    ctx: PipelineContext,
    run: PipelineRun,
    setup: StepSetup,
    messages: list[dict],
    output: type[T],
    schema_name: str,
    reasoning: ReasoningEffort | None,
    on_event: ScanEventSink | None,
) -> StepResult[T]:
    """Un appel `complete` sur le modèle de `setup`, tracé pour le bloc debug."""
    llm = ctx.llm_for(setup.provider)
    started = time.perf_counter()
    result = await llm.complete(
        model=setup.slug,
        system_prompt=setup.system_prompt,
        messages=messages,
        output=output,
        schema_name=schema_name,
        reasoning=reasoning,
        on_event=on_event,
    )
    run.traces.append(
        StepTrace(
            step=_step_of(schema_name),
            provider=setup.provider,
            model=setup.slug,
            system_prompt=result.system_prompt or setup.system_prompt,
            messages=summarize_messages(messages),
            raw_response=result.raw_text,
            ms=round((time.perf_counter() - started) * 1000),
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            cost_usd_micros=result.cost_usd_micros,
        )
    )
    return result


def _step_of(schema_name: str) -> StepCode:
    return {
        SCHEMA_READ_PHOTOS: "read_photos",
        SCHEMA_CRITERIA: "criteria",
        SCHEMA_IDENTIFY: "identify",
    }[schema_name]  # type: ignore[return-value]


def _record(
    step: StepCode,
    setup: StepSetup,
    result: StepResult,
    *,
    images: int = 0,
    web_searches: int = 0,
    criteria_set_id: int | None = None,
) -> CallRecord:
    return CallRecord(
        step=step,
        model_id=setup.model_id,
        prompt_version_id=setup.prompt_version_id,
        tokens_in=result.tokens_in,
        tokens_out=result.tokens_out,
        cost_usd_micros=result.cost_usd_micros,
        images=images,
        web_searches=web_searches,
        criteria_set_id=criteria_set_id,
    )


async def _identify(
    ctx: PipelineContext,
    run: PipelineRun,
    setup: StepSetup,
    listing: ListingIn,
    images: list[str],
    read: ReadPhotosOut,
    criteria: dict[int, "_Criteria"],
    hits: list[SearchHit],
    on_event: ScanEventSink | None,
) -> IdentifyOut:
    messages = build_identify_messages(
        listing, images, read.objects, {n: list(c.items) for n, c in criteria.items()}, hits
    )
    result = await _call(ctx, run, setup, messages, IdentifyOut, SCHEMA_IDENTIFY, None, on_event)
    run.calls.append(_record("identify", setup, result, images=len(images)))
    run.identify = result.output
    return result.output


def _targets(objects: list[ReadPhotosObject]) -> list[int]:
    """Numéros (à partir de 1) des objets visés par `criteria` : le principal, puis l'accessoire
    de plus grande valeur (à valeur égale, le premier)."""
    main = next(n for n, o in enumerate(objects, start=1) if o.role == "main")
    accessories = [n for n, o in enumerate(objects, start=1) if o.role == "accessory"]
    if not accessories:
        return [main]
    best = min(accessories, key=lambda n: (_VALUE_RANK[objects[n - 1].relative_value], n))
    return [main, best]


def _distinct(candidates: list[str]) -> int:
    return len({normalize_name(c) for c in candidates})


def _designated(reference: str | None, candidates: list[str]) -> str | None:
    """Candidat (normalisé) que `reference` désigne seul : son nom normalisé figure dans la
    référence normalisée (« Steam Deck OLED 1010 » désigne « Steam Deck OLED » ; une lecture
    partielle comme « OLED » ne désigne rien). `None` si aucun ou plusieurs."""
    ref = normalize_name(reference or "")
    if not ref:
        return None
    names = {normalize_name(c) for c in candidates}
    matched = [n for n in names if n and n in ref]
    return matched[0] if len(matched) == 1 else None


def _clean_name(value: str | None) -> str | None:
    """Nom de produit écrit par le modèle, rendu tel quel à l'extension : `None` s'il contient
    une URL (`://`, `www.`), un caractère de contrôle ou `<`/`>` ; 120 caractères au plus."""
    text = (value or "").strip()
    lowered = text.lower()
    if (
        not text
        or "://" in lowered
        or "www." in lowered
        or _CONTROL_CHARS.search(text)
        or "<" in text
        or ">" in text
    ):
        return None
    return text[:NAME_MAX].strip()


# --- Critères ----------------------------------------------------------------------------------


def _from_view(view: CriteriaSetView, hits: Iterable[SearchHit] = ()) -> _Criteria:
    return _Criteria(
        items=view.criteria,
        stored=True,
        set_id=view.id,
        verified=view.status == "verified",
        hits=tuple(hits),
    )


def _unsourced(hints: list[str], hits: Iterable[SearchHit]) -> _Criteria:
    """Indices de `read_photos`, à défaut de critères sourcés : vérifiables sur photo, jamais
    décisifs, absents de la base."""
    return _Criteria(
        items=tuple(
            StoredCriterion(
                id=0,
                position=n,
                kind="photo",
                decisive=False,
                fr=hint,
                nl=hint,
                expected={},
                sources=(),
            )
            for n, hint in enumerate(hints)
        ),
        unsourced=True,
        hits=tuple(hits),
    )


async def _criteria_for(
    ctx: PipelineContext,
    run: PipelineRun,
    read: ReadPhotosOut,
    obj: ReadPhotosObject,
    ids: _SearchIds,
    emit: Callable[[object], Awaitable[None]],
) -> _Criteria:
    """Critères d'un objet visé : ceux de la base s'ils sont valides ; rien pour un seul
    candidat ou une référence lue qui en désigne un ; sinon recherches, pages et extraction
    sous le verrou de l'ensemble de candidats (un seul calcul pour des scans simultanés).

    Sans page lue (moteur en panne, aucune page lisible) ou si le modèle échoue, les indices
    de `read_photos` servent, non sourcés, et rien n'est enregistré : une panne passagère ne
    laisse pas un ensemble vide dans la base."""
    key = candidates_key(obj.candidates)
    ttl = timedelta(days=ctx.settings.criteria_ttl_days)
    async with ctx.maker() as session:
        view = await valid_criteria(session, key, ctx.at, ttl)
    if view is not None:
        await emit(CriteriaCached(len(view.criteria)))
        return _from_view(view)
    if _distinct(obj.candidates) < 2 or _designated(read.read_reference, obj.candidates):
        return _Criteria()

    async with ctx.maker() as session, session.begin():
        await lock_criteria(session, key)
        view = await valid_criteria(session, key, ctx.at, ttl)
        if view is not None:  # calculés par un scan concurrent pendant l'attente du verrou
            await emit(CriteriaCached(len(view.criteria)))
            return _from_view(view)
        await emit(Stage("criteria"))
        queries = criteria_queries(
            obj.candidates, read.hint_criteria, ctx.settings.criteria_max_searches
        )
        first = ids.take(len(queries))
        outcome = await run_searches(
            queries,
            backend=ctx.search,
            http_pages=ctx.http_pages,
            max_pages=ctx.settings.criteria_max_pages,
            page_kinds=frozenset({"criteria"}),
            on_event=emit,
            first_id=first,
            resolve=ctx.resolve,
        )
        _log_searches(run, queries, outcome, first)
        hits = _unique([h for q in queries for h in outcome.hits.get(q, [])])
        snippets = [h for h in hits if h.url not in {p.url for p in outcome.pages}]
        result = await _extract(ctx, run, obj, read.hint_criteria, outcome.pages, snippets)
        if result is None:
            return _unsourced(read.hint_criteria, hits)
        view = await save_criteria(
            session, key, obj.candidates, result.output, outcome.pages, ctx.at
        )
        call = _record(
            "criteria",
            ctx.steps["criteria"],
            result,
            web_searches=len(queries),
            criteria_set_id=view.id,
        )
        record_criteria_call(session, call, ctx.at)
        run.calls.append(call)
        return _from_view(view, hits)


async def _extract(
    ctx: PipelineContext,
    run: PipelineRun,
    obj: ReadPhotosObject,
    hints: list[str],
    pages: list[PageText],
    snippets: list[SearchHit],
) -> StepResult[CriteriaOut] | None:
    """Extraction des critères, ou `None` sans page lue (un extrait n'est jamais une source) ou
    si le modèle échoue."""
    if not pages:
        return None
    messages = build_criteria_messages(obj.candidates, hints, pages, snippets)
    try:
        return await _call(
            ctx, run, ctx.steps["criteria"], messages, CriteriaOut, SCHEMA_CRITERIA, "none", None
        )
    except LLMError as exc:
        logger.warning("critères : échec du modèle (%s), indices non sourcés", exc.code)
        return None


async def _complete_criteria(
    ctx: PipelineContext,
    run: PipelineRun,
    read: ReadPhotosOut,
    obj: ReadPhotosObject,
    current: _Criteria,
    pages: list[PageText],
    hits: list[SearchHit],
    on_event: ScanEventSink | None,
) -> _Criteria:
    """Relance : complète les critères de l'objet principal avec la page lue, sous le verrou de
    l'ensemble ; les critères déjà connus restent en tête. Un ensemble relu par un admin n'est
    pas touché ; sans page, ou si le modèle échoue, rien ne change."""
    if current.verified or not pages or _distinct(obj.candidates) < 2:
        return current
    key = candidates_key(obj.candidates)
    async with ctx.maker() as session, session.begin():
        await lock_criteria(session, key)
        view = await valid_criteria(
            session, key, ctx.at, timedelta(days=ctx.settings.criteria_ttl_days)
        )
        if view is not None and view.status == "verified":
            return _from_view(view, current.hits)
        snippets = [h for h in hits if h.url not in {p.url for p in pages}]
        result = await _extract(ctx, run, obj, read.hint_criteria, pages, snippets)
        if result is None:
            return current
        merged, merged_pages = _merge(view.criteria if view else (), result.output, pages)
        view = await save_criteria(session, key, obj.candidates, merged, merged_pages, ctx.at)
        call = _record(
            "criteria", ctx.steps["criteria"], result, web_searches=1, criteria_set_id=view.id
        )
        record_criteria_call(session, call, ctx.at)
        run.calls.append(call)
        return _from_view(view, current.hits)


def _merge(
    known: tuple[StoredCriterion, ...], extracted: CriteriaOut, pages: list[PageText]
) -> tuple[CriteriaOut, list[PageText]]:
    """Critères connus suivis des nouveaux, avec une seule liste de pages : celles des sources
    connues (sans texte), puis les pages lues. Un nouveau critère qui ne cite qu'un extrait est
    écarté, comme par `save_criteria`."""
    merged_pages: list[PageText] = []
    numbers: dict[str, int] = {}

    def number(page: PageText) -> int:
        if page.url not in numbers:
            merged_pages.append(page)
            numbers[page.url] = len(merged_pages)
        return numbers[page.url]

    criteria: list[ExtractedCriterion] = [
        ExtractedCriterion.model_construct(
            kind=c.kind,
            decisive=c.decisive,
            fr=c.fr,
            nl=c.nl,
            expected=[
                ExpectedValue.model_construct(
                    candidate=cand, fr=v.get("fr", ""), nl=v.get("nl", "")
                )
                for cand, v in c.expected.items()
            ],
            sources=[number(PageText(url, domain, title, "")) for url, title, domain in c.sources],
        )
        for c in known
    ]
    renumbered = {n: number(p) for n, p in enumerate(pages, start=1)}
    for c in extracted.criteria:
        sources = [renumbered[n] for n in c.sources if n in renumbered]
        if sources:
            criteria.append(c.model_copy(update={"sources": sources}))
    return CriteriaOut.model_construct(criteria=criteria), merged_pages


# --- Résultat ----------------------------------------------------------------------------------


def _resolve(
    run: PipelineRun,
    read: ReadPhotosOut,
    identify: IdentifyOut,
    criteria: dict[int, _Criteria],
    hits: list[SearchHit],
    targets: list[int],
    photos: int,
) -> None:
    """Objets, confiance et statut, calculés par l'API à partir de la sortie d'`identify`."""
    answers = {}
    for answer in identify.objects:
        answers.setdefault(answer.object, answer)
    found_anywhere = _reference_found(read.read_reference, hits + run.price_hits)
    read_designates = {
        n: _designated(read.read_reference, obj.candidates)
        for n, obj in enumerate(read.objects, start=1)
    }
    objects: list[ObjectRecord] = []
    for n, obj in enumerate(read.objects, start=1):
        crit = criteria.get(n, _Criteria())
        answer = answers.get(n)
        shown = [c for c in crit.items if c.kind == "photo"]
        checks = _checks(answer.checks if answer else [], shown, crit.stored, photos)
        reference = _clean_name(answer.reference) if answer else None
        remaining = (
            [r for r in map(_clean_name, answer.remaining) if r] if answer else obj.candidates
        )
        # Plancher de la référence lue : seulement si `identify` retient le candidat qu'elle
        # désigne, et si elle figure dans un résultat de recherche.
        designated = read_designates[n]
        read_and_found = (
            found_anywhere
            and designated is not None
            and reference is not None
            and normalize_name(reference) == designated
        )
        confidence = object_confidence(
            ObjectEvidence(
                candidate_count=_distinct(obj.candidates),
                reference=reference,
                checks=tuple(
                    CheckEvidence(
                        decisive=c.decisive,
                        single_source=len(c.sources) == 1,
                        observation=c.observation,
                    )
                    for c in checks
                ),
                reference_read_and_found=read_and_found,
                photos=photos,
                unsourced=crit.unsourced,
                criteria_step=n in targets,
                verified=crit.verified,
            )
        )
        objects.append(
            ObjectRecord(
                role=obj.role,
                label=obj.category.strip() or obj.candidates[0],
                reference=reference,
                remaining=tuple(remaining),
                confidence=confidence,
                level=level_of(confidence, reference),
                checks=tuple(checks),
                pages=tuple(_pages(answer.pages if answer else [], hits)),
                criteria_set_id=crit.set_id,
            )
        )
    run.objects = objects
    main = objects[targets[0] - 1]
    run.status = overall_status(main.level)
    run.confidence = main.confidence
    run.verified_criteria = criteria.get(targets[0], _Criteria()).verified


def _checks(
    answers: list[CheckOut], shown: list[StoredCriterion], stored: bool, photos: int
) -> list[CheckRecord]:
    """Une vérification par critère `photo` montré à `identify` (numérotés de 1, dans l'ordre),
    retrouvé par son numéro. Un numéro inconnu est ignoré ; un critère sans réponse compte comme
    `not_visible` (omettre un critère décisif ne doit pas relever la confiance), comme une
    observation `seen_*` sans numéro de photo valide (rien n'a été vu sans photo)."""
    by_number: dict[int, CheckOut] = {}
    for answer in answers:
        by_number.setdefault(answer.criterion, answer)
    records: list[CheckRecord] = []
    for n, criterion in enumerate(shown, start=1):
        answer = by_number.get(n)
        photo = answer.photo if answer and answer.photo and 1 <= answer.photo <= photos else None
        seen = answer is not None and answer.observation != "not_visible" and photo is not None
        records.append(
            CheckRecord(
                criterion_id=criterion.id if stored else None,
                text_fr=criterion.fr,
                text_nl=criterion.nl,
                decisive=criterion.decisive,
                sources=criterion.sources,
                observation=answer.observation if seen and answer else "not_visible",
                photo=photo if seen else None,
            )
        )
    return records


def _reference_found(reference: str | None, hits: list[SearchHit]) -> bool:
    """`read_reference` figure (normalisée) dans le titre ou l'extrait d'un résultat."""
    ref = normalize_name(reference or "")
    return bool(ref) and any(
        ref in normalize_name(h.title) or ref in normalize_name(h.snippet) for h in hits
    )


def _safe_url(url: str) -> bool:
    """Mêmes règles que les liens des résultats : HTTPS, 300 caractères au plus, ni espace ni
    caractère de contrôle (spec §8.3)."""
    return url.startswith("https://") and len(url) <= URL_MAX and not _BAD_URL_CHARS.search(url)


def _pages(numbers: list[int], hits: list[SearchHit]) -> list[PageLink]:
    """Pages désignées par leur numéro dans les résultats montrés à `identify` (à partir de 1) :
    hors bornes, doublon, URL refusée ou sans hôte lisible, le numéro est ignoré."""
    links: list[PageLink] = []
    for n in numbers:
        if not 1 <= n <= len(hits):
            continue
        h = hits[n - 1]
        if not _safe_url(h.url) or any(link.url == h.url for link in links):
            continue
        try:
            domain = (urlsplit(h.url).hostname or "")[:DOMAIN_MAX]
        except ValueError:
            continue
        if not domain:
            continue
        links.append(PageLink(url=h.url, title=h.title, domain=domain))
    return links


def _unique(hits: list[SearchHit]) -> list[SearchHit]:
    seen: set[str] = set()
    return [h for h in hits if not (h.url in seen or seen.add(h.url))]


def _log_searches(
    run: PipelineRun, queries: list[Query], outcome: SearchOutcome, first_id: int
) -> None:
    """Note chaque requête lancée, avec les domaines des pages lues pour elle."""
    read = {(query, kind): domains for query, kind, domains in outcome.records}
    for n, query in enumerate(queries):
        text = clean_query(query.text)
        if text:
            run.searches.append(
                SearchLog(first_id + n, text, query.kind, tuple(read.get((text, query.kind), ())))
            )


async def _gather(*aws: Awaitable):
    """`asyncio.gather` qui annule les autres tâches dès qu'une échoue (aucune ne survit au
    pipeline) et lève l'erreur d'origine, pas un groupe d'exceptions."""
    tasks = [asyncio.ensure_future(a) for a in aws]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
