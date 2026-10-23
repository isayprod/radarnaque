"""Service de l'identification du produit (spec §6, §7, §9).

`ensure_identification` relie un scan à une identification valide, en cache ou nouvelle, sous
le verrou consultatif de sa clé : des scans simultanés de la même annonce (un `identify` et un
`analyze` compris) ne lancent qu'un pipeline.

Deux usages :
- `POST /api/identify` : `admit_identify` (la même admission que le scan, `purpose =
  identify`), puis `serve_identify` (120 s au plus), qui relie l'événement à l'identification
  (`identification_results`) ou rend le scan en cas d'échec, comme `serve_admitted` ;
- le scan (`serve_admitted`) : `identify_for_scan` identifie d'abord le produit pour nourrir
  l'analyse ; un échec n'y est qu'un événement `identification_error`, jamais un échec du scan.

Un `identify` relié à son identification n'est jamais rendu ensuite (`scan_failures`) : le lien
est écrit dans la transaction qui produit ou retrouve l'identification, et un échec n'est
enregistré qu'en l'absence de lien. Ainsi un `identify` réussi reste réussi, et l'`analyze`
qu'il inclut (§7) le reste aussi."""

import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

import httpx
from sqlalchemy import exists, func, literal, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from radarnaque_api.auth.privileges import Privileges
from radarnaque_api.identify.pipeline import (
    IdentifySettings,
    PipelineContext,
    PipelineRun,
    StepError,
    run_pipeline,
)
from radarnaque_api.identify.store import (
    IdentificationKey,
    StepSetup,
    active_steps,
    config_hash,
    identify_input_hash,
    load_identification,
    save_identification,
    valid_identification_id,
)
from radarnaque_api.images import MAX_IMAGES, Resolver, default_resolve
from radarnaque_api.llm.client import LLMClient, LLMError
from radarnaque_api.llm.providers import ProviderError
from radarnaque_api.models import (
    AuthUser,
    Identification,
    IdentificationResult,
    IdentificationSearch,
    Model,
    ScanFailure,
)
from radarnaque_api.schemas import IdentificationOut, IdentifyDebugOut, ScanIn
from radarnaque_api.search import SearchBackend, SearchHit
from radarnaque_api.services.scan_stream import (
    IdentificationFailed,
    IdentificationReady,
    ScanEventSink,
)
from radarnaque_api.services.scans import (
    IDENTIFY_TIMEOUT_S,
    INTERNAL_FAILURE,
    ScanError,
    ScanIdentification,
    _Admission,
    _Admitted,
    _client_for,
    _emit,
    _failure_code,
    _image_limit,
    _NotConfigured,
    _remaining,
    admit_scan,
)

__all__ = [
    "IDENTIFY_TIMEOUT_S",
    "Identified",
    "admit_identify",
    "ensure_identification",
    "identify_for_scan",
    "serve_identify",
]

# Code d'échec de l'identification selon l'étape dont le modèle a échoué (spec §9).
_STEP_FAILURES = {"read_photos": "identify_read_photos", "identify": "identify_resolve"}

logger = logging.getLogger(__name__)
debug_logger = logging.getLogger("radarnaque.debug")


@dataclass(frozen=True)
class Identified:
    """Identification reliée au scan. `run` : le pipeline lancé par ce scan, `None` si elle
    vient du cache (ou d'un scan concurrent, attendu sous le verrou)."""

    identification_id: int
    from_cache: bool
    run: PipelineRun | None


def failure_code(exc: Exception) -> str:
    """Code d'échec de l'identification : l'étape dont le modèle a échoué
    (`identify_read_photos`, `identify_resolve`), sinon celui du scan (`timeout`,
    `configuration`, `image_*`, `internal`)."""
    if isinstance(exc, StepError) and exc.code != "configuration":
        return _STEP_FAILURES[exc.step]
    if isinstance(exc, LLMError) and exc.code != "configuration":
        return _STEP_FAILURES["identify"]
    return _failure_code(exc)


async def _escalation(
    session: AsyncSession, settings: IdentifySettings, identify: StepSetup
) -> StepSetup | None:
    """Modèle de la relance (`identify_escalation_model_id`), avec le prompt d'`identify`."""
    if settings.identify_escalation_model_id is None:
        return None
    model = await session.get(Model, settings.identify_escalation_model_id)
    if model is None:
        return None
    return StepSetup(
        step="identify",
        model_id=model.id,
        provider=model.provider,
        slug=model.slug,
        prompt_version_id=identify.prompt_version_id,
        system_prompt=identify.system_prompt,
    )


def _photos(
    admission: _Admission,
    scan: ScanIn,
    setups: list[StepSetup],
    llm_for: Callable[[str], LLMClient],
) -> int:
    """Photos envoyées à `read_photos` et `identify` : au plus celles de l'offre, de chaque
    fournisseur qui les reçoit (la limite globale s'il est inconnu) et de l'annonce. Entre dans
    la clé du cache."""
    limits = [
        MAX_IMAGES if isinstance(client, ProviderError) else _image_limit(client)
        for client in (_client_for(llm_for, s.provider) for s in setups)
    ]
    return min(admission.max_images, len(scan.listing.images), *limits)


def _link(session: AsyncSession, admission: _Admission, identification_id: int) -> None:
    """Relie un `identify` à son identification ; un `analyze` ne l'est pas (son résultat est
    son analyse, `scan_results`)."""
    if admission.purpose == "identify":
        session.add(
            IdentificationResult(
                scan_event_id=admission.event_id, identification_id=identification_id
            )
        )


async def _lock(session: AsyncSession, key: IdentificationKey) -> None:
    await session.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended(key.lock_name(), 0)))
    )


async def ensure_identification(
    maker: async_sessionmaker[AsyncSession],
    admission: _Admission,
    scan: ScanIn,
    privileges: Privileges,
    *,
    llm_for: Callable[[str], LLMClient],
    http: httpx.AsyncClient,
    http_pages: httpx.AsyncClient,
    resolve: Resolver,
    search: SearchBackend | None,
    on_event: ScanEventSink | None,
) -> Identified | None:
    """Identification valide du scan de `admission`, en cache ou produite par le pipeline sous
    le verrou consultatif de sa clé (un scan concurrent l'attend, puis la trouve en relisant le
    cache) ; un `identify` y est relié dans la même transaction. `None` : étapes non
    configurées. `noCache` (superuser hors production) relance le pipeline, qui rafraîchit
    l'identification sur place, mais garde la base de critères (§9).

    Aucun `Stage("cache")` n'est émis : l'événement `identification` porte `fromCache`. Les
    erreurs du pipeline remontent (`failure_code` en donne le code)."""
    settings = admission.identify
    async with maker() as session:
        steps = await active_steps(session)
        if steps is None:
            return None
        escalation = await _escalation(session, settings, steps["identify"])
    receivers = [steps["read_photos"], steps["identify"]]
    if escalation is not None:
        receivers.append(escalation)
    photos = _photos(admission, scan, receivers, llm_for)
    key = IdentificationKey(
        snapshot_id=admission.snapshot_id,
        config_hash=config_hash(
            steps, escalation_model_id=None if escalation is None else escalation.model_id
        ),
        input_hash=identify_input_hash(scan, photos, settings.identify_image_side),
    )
    ttl = timedelta(hours=settings.identification_cache_ttl_hours)
    fresh = privileges.debug and scan.no_cache

    if not fresh:
        async with maker() as session:
            cached = await valid_identification_id(session, key, admission.event_at, ttl)
            if cached is not None:
                _link(session, admission, cached)
                await session.commit()
                return Identified(cached, True, None)

    # Le verrou, propre à la clé, est libéré par le commit (ou le rollback).
    async with maker() as session, session.begin():
        await _lock(session, key)
        cached = (
            None if fresh else await valid_identification_id(session, key, admission.event_at, ttl)
        )
        if cached is not None:  # identifiée par un scan concurrent pendant l'attente du verrou
            _link(session, admission, cached)
            return Identified(cached, True, None)
        ctx = PipelineContext(
            steps=steps,
            llm_for=llm_for,
            search=search,
            http_images=http,
            http_pages=http_pages,
            resolve=resolve,
            maker=maker,
            settings=settings,
            image_host_suffixes=admission.image_host_suffixes,
            photos=photos,
            at=admission.event_at,
            escalation=escalation,
        )
        run = await run_pipeline(ctx, scan, on_event)
        identification_id = await save_identification(session, key, run, admission.event_at)
        _link(session, admission, identification_id)
    return Identified(identification_id, False, run)


def _debug(privileges: Privileges, run: PipelineRun | None) -> IdentifyDebugOut | None:
    """Bloc debug du superuser hors production : les appels du pipeline, aucun pour une
    identification servie par le cache."""
    if not privileges.debug:
        return None
    return run.debug() if run is not None else IdentifyDebugOut(steps=[])


def _log_debug(scan: ScanIn, out: IdentificationOut) -> None:
    """Comme le scan : un enregistrement par identification de superuser (aucun secret ni
    photo en base64 dans le bloc)."""
    listing = scan.listing
    debug_logger.info(
        "[debug superuser] identification %s|%s\n%s",
        listing.site,
        listing.external_id,
        json.dumps(out.model_dump(mode="json", by_alias=True), ensure_ascii=False, indent=2),
    )


# --- Scan : l'identification nourrit l'analyse --------------------------------------------------


async def _stored_price_hits(
    maker: async_sessionmaker[AsyncSession],
    identification_id: int,
    search: SearchBackend | None,
) -> list[SearchHit]:
    """Résultats de la requête « prix » d'une identification en cache : ils ne sont pas
    enregistrés (règle R11), la requête l'est ; elle est relancée (le moteur garde 24 h ses
    réponses en cache). Un moteur absent ou en échec donne une liste vide, jamais un échec."""
    if search is None:
        return []
    async with maker() as session:
        query = await session.scalar(
            select(IdentificationSearch.query)
            .where(
                IdentificationSearch.identification_id == identification_id,
                IdentificationSearch.kind == "price",
            )
            .order_by(IdentificationSearch.position)
            .limit(1)
        )
    if query is None:
        return []
    try:
        return await search.search(query)
    except Exception as exc:  # `SearchUnavailable`, ou tout autre échec : sans prix
        logger.warning("identification : requête « prix » en échec (%s)", type(exc).__name__)
        return []


async def identify_for_scan(
    admitted: _Admitted,
    on_event: ScanEventSink | None,
    *,
    timeout_s: float = IDENTIFY_TIMEOUT_S,
) -> ScanIdentification | None:
    """Identification qui précède l'analyse d'un scan, en `timeout_s` secondes au plus. Émet
    `identification` (le résultat), ou `identification_error` (son code) si elle échoue : toute
    erreur, délai compris, donne `None` sans faire échouer le scan, qui n'est pas rendu pour
    autant. `None` aussi, sans événement, si les étapes ne sont pas configurées. Une annulation
    est propagée."""
    admission = admitted.admission
    try:
        async with asyncio.timeout(timeout_s):
            identified = await ensure_identification(
                admitted.maker,
                admission,
                admitted.scan,
                admitted.privileges,
                llm_for=admitted.llm_for,
                http=admitted.http,
                http_pages=admitted.http_pages,
                resolve=admitted.resolve,
                search=admitted.search,
                on_event=on_event,
            )
            if identified is None:
                return None
            async with admitted.maker() as session:
                out = await load_identification(session, identified.identification_id)
    except Exception as exc:  # jamais un échec du scan ; l'annulation, elle, passe
        code = failure_code(exc)
        logger.warning("identification en échec pendant un scan (%s)", code)
        await _emit(on_event, IdentificationFailed(code))
        return None
    out = out.model_copy(
        update={
            "from_cache": identified.from_cache,
            "debug": _debug(admitted.privileges, identified.run),
        }
    )
    await _emit(on_event, IdentificationReady(out))
    if out.status == "none":  # rien à chercher : l'analyse se fera sans identification
        prices: list[SearchHit] = []
    elif identified.run is not None:
        prices = identified.run.price_hits
    else:
        prices = await _stored_price_hits(
            admitted.maker, identified.identification_id, admitted.search
        )
    return ScanIdentification(identification=out, price_hits=prices)


# --- POST /api/identify -------------------------------------------------------------------------


async def admit_identify(
    *,
    engine: AsyncEngine,
    user: AuthUser,
    privileges: Privileges,
    scan: ScanIn,
    llm_for: Callable[[str], LLMClient],
    http: httpx.AsyncClient,
    http_pages: httpx.AsyncClient,
    now: Callable[[], datetime],
    search: SearchBackend | None = None,
    resolve: Resolver = default_resolve,
) -> _Admitted:
    """La même admission que le scan (limite de requêtes, droits, validation, snapshot,
    réservation), avec `purpose = identify` : 1 analyse du quota `full`. Lève `ScanError` pour
    un refus (402, 403, 422, 429), sans rien réserver ; `serve_identify` doit suivre."""
    return await admit_scan(
        engine=engine,
        user=user,
        privileges=privileges,
        scan=scan,
        llm_for=llm_for,
        http=http,
        http_pages=http_pages,
        now=now,
        search=search,
        resolve=resolve,
        purpose="identify",
    )


async def _record_failure_unless_linked(
    maker: async_sessionmaker[AsyncSession], event_id: int, code: str, at: datetime
) -> bool:
    """Rend l'`identify` (`scan_failures`), sauf s'il est déjà relié à son identification : le
    lien est écrit avec le succès, un délai ou une annulation juste après ne le défait pas.
    Renvoie vrai si le scan est rendu. Comme `_record_failure` : une écriture en échec est
    signalée (ERROR, sans message), puis l'erreur remonte."""
    linked = exists().where(IdentificationResult.scan_event_id == event_id)
    try:
        async with maker() as session, session.begin():
            inserted = await session.scalar(
                insert(ScanFailure)
                .from_select(
                    ["scan_event_id", "error_code", "created_at"],
                    select(literal(event_id), literal(code), literal(at)).where(~linked),
                )
                .returning(ScanFailure.scan_event_id)
            )
    except (Exception, asyncio.CancelledError) as exc:
        logger.error(
            "remboursement impossible pour scan_event_id=%s (%s)", event_id, type(exc).__name__
        )
        raise
    return inserted is not None


async def _linked_identification(
    maker: async_sessionmaker[AsyncSession], admission: _Admission
) -> tuple[int, bool]:
    """Identification déjà reliée à l'`identify`, et « servie par le cache » : produite avant
    l'événement."""
    async with maker() as session:
        identification_id, created_at = (
            await session.execute(
                select(Identification.id, Identification.created_at)
                .join(
                    IdentificationResult,
                    IdentificationResult.identification_id == Identification.id,
                )
                .where(IdentificationResult.scan_event_id == admission.event_id)
            )
        ).one()
    return identification_id, created_at < admission.event_at


async def serve_identify(
    admitted: _Admitted,
    on_event: ScanEventSink | None = None,
    *,
    timeout_s: float = IDENTIFY_TIMEOUT_S,
) -> IdentificationOut:
    """Identification du scan admis par `admit_identify`, en `timeout_s` secondes au plus ;
    `on_event` reçoit les événements du pipeline, puis `identification`. Mêmes garanties que
    `serve_admitted` : toute erreur rend le scan (sous `shield`) et donne `502 analysis_failed`
    (`details.reason` : `identify_read_photos`, `identify_resolve`, `timeout`, `configuration`,
    `image_*`), une erreur inattendue est relancée telle quelle (500), une annulation est
    propagée. Un `identify` déjà relié à son identification n'est jamais rendu."""
    admission, maker, now = admitted.admission, admitted.maker, admitted.now
    failure: Exception | None = None
    identified: Identified | None = None
    try:
        async with asyncio.timeout(timeout_s):
            identified = await ensure_identification(
                maker,
                admission,
                admitted.scan,
                admitted.privileges,
                llm_for=admitted.llm_for,
                http=admitted.http,
                http_pages=admitted.http_pages,
                resolve=admitted.resolve,
                search=admitted.search,
                on_event=on_event,
            )
            if identified is None:
                raise _NotConfigured
    except asyncio.CancelledError:
        await asyncio.shield(
            _record_failure_unless_linked(maker, admission.event_id, INTERNAL_FAILURE, now())
        )
        raise
    except Exception as exc:  # toute erreur après la réservation rend le scan
        failure = exc
    if failure is not None:  # hors du `except` : aucun contexte chaîné à l'erreur rendue
        code = failure_code(failure)
        if await asyncio.shield(
            _record_failure_unless_linked(maker, admission.event_id, code, now())
        ):
            if code == INTERNAL_FAILURE:
                raise failure
            raise ScanError(
                502,
                "analysis_failed",
                "L'identification a échoué ; ce scan n'est pas décompté.",
                {"reason": code},
            )
        # Relié juste avant l'erreur (délai dépassé après le commit) : un succès.
        identification_id, from_cache = await _linked_identification(maker, admission)
        identified = Identified(identification_id, from_cache, None)
    assert identified is not None

    async with maker() as session:
        out = await load_identification(session, identified.identification_id)
        remaining = await _remaining(session, admitted.user, admitted.privileges, now())
    out = out.model_copy(
        update={
            "from_cache": identified.from_cache,
            "remaining": remaining,
            "debug": _debug(admitted.privileges, identified.run),
        }
    )
    if out.debug is not None:
        _log_debug(admitted.scan, out)
    await _emit(on_event, IdentificationReady(out))
    return out
