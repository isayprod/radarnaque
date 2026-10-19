"""Flux d'un scan en Server-Sent Events (`POST /api/scans/stream`, spec §8.3).

L'analyse tourne dans sa propre tâche ; ses événements (étapes du service, événements du client
LLM) passent par une file sans borne, jamais bloquante : le délai d'un tour du modèle englobe
le récepteur. Le flux se termine par `result` ou par `error`. Si le client part, la fermeture du
générateur annule la tâche, et `serve_admitted` rend alors le scan."""

import asyncio
import json
import logging
import math
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel

from radarnaque_api.errors import ApiError
from radarnaque_api.llm.events import LLMEvent, SearchDone, SearchStarted, Thinking, Writing
from radarnaque_api.schemas import (
    AnalysisResultOut,
    ScanStreamErrorOut,
    SearchDoneEventOut,
    SearchEventOut,
    StageEventOut,
    ThinkingEventOut,
)

PING_S = 15  # garde la connexion et le service worker actifs
THROTTLE_S = 0.3  # au plus un `thinking` par partie dans cet intervalle
PING = ": ping\n\n"

logger = logging.getLogger(__name__)

# Tâches d'analyse en cours : la boucle ne garde qu'une référence faible à une tâche ; celle-ci
# la tient jusqu'à la fin, même si le générateur qui l'a lancée est abandonné.
_TASKS: set[asyncio.Task[AnalysisResultOut]] = set()


@dataclass(frozen=True)
class Stage:
    """Étape du service. `count` : photos à télécharger (`photos`) ou envoyées (`analyzing`)."""

    stage: Literal["cache", "photos", "analyzing"]
    count: int | None = None


ScanEvent = Stage | LLMEvent
ScanEventSink = Callable[[ScanEvent], Awaitable[None]]


def encode_sse(event: str, data: dict[str, Any]) -> str:
    """Un événement SSE : `event:` puis `data:` en JSON compact sur une ligne (UTF-8)."""
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n"


def _encode(event: str, model: BaseModel) -> str:
    return encode_sse(event, model.model_dump(mode="json", by_alias=True, exclude_none=True))


def sse_of(event: ScanEvent) -> str:
    """Événement SSE d'un événement du scan ; `Writing` devient l'étape `writing`."""
    match event:
        case Stage(stage=stage, count=count):
            return _encode("stage", StageEventOut(stage=stage, count=count))
        case Writing():
            return _encode("stage", StageEventOut(stage="writing"))
        case Thinking(part=part, text=text):
            return _encode("thinking", ThinkingEventOut(part=part, text=text))
        case SearchStarted(id=search_id, query=query, aspect=aspect):
            return _encode("search", SearchEventOut(id=search_id, query=query, aspect=aspect))
        case SearchDone(id=search_id, ok=ok, count=count, domains=domains):
            return _encode(
                "search_done",
                SearchDoneEventOut(id=search_id, ok=ok, count=count, domains=list(domains)),
            )
    raise TypeError(f"événement inconnu : {type(event).__name__}")


def _outcome(task: asyncio.Task[AnalysisResultOut]) -> str:
    """Dernier événement : `result`, ou `error` avec le code et les détails de la réponse JSON
    équivalente. Une erreur inattendue donne `analysis_failed`, avec un message neutre : le
    scan a pu être rendu ou non (erreur après l'enregistrement du résultat, remboursement en
    échec)."""
    exc = None if task.cancelled() else task.exception()
    if exc is None and not task.cancelled():
        return encode_sse("result", task.result().model_dump(mode="json", by_alias=True))
    if isinstance(exc, ApiError):
        error = ScanStreamErrorOut(code=exc.code, message=exc.message, details=exc.details)
    else:
        if exc is not None:  # comme une 500 de `POST /api/scans` : trace dans les logs
            logger.error("analyse en flux en échec", exc_info=exc)
        error = ScanStreamErrorOut(
            code="analysis_failed",
            message="L'analyse a échoué.",
            details={"reason": "internal"},
        )
    return _encode("error", error)


async def stream_scan(
    admitted: Callable[[ScanEventSink], Coroutine[Any, Any, AnalysisResultOut]],
    *,
    ping_s: float = PING_S,
    throttle_s: float = THROTTLE_S,
) -> AsyncIterator[str]:
    """Événements SSE de l'analyse `admitted(sink)`, puis `result` ou `error`.

    Un `: ping` part après `ping_s` secondes sans rien envoyer. Les `thinking` d'une même partie
    reçus moins de `throttle_s` après le dernier envoyé sont fusionnés : seul le dernier (texte
    cumulé) part, au plus tard `throttle_s` après le précédent. Tout autre événement, ou une
    autre partie, fait d'abord partir le `thinking` en attente : l'ordre est préservé."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[ScanEvent | None] = asyncio.Queue()  # None : l'analyse est finie

    async def sink(event: ScanEvent) -> None:
        queue.put_nowait(event)

    def finished(done: asyncio.Task[AnalysisResultOut]) -> None:
        queue.put_nowait(None)
        if not done.cancelled():
            done.exception()  # lue ici : jamais d'avertissement « exception never retrieved »

    task = asyncio.create_task(admitted(sink))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    task.add_done_callback(finished)
    pending: Thinking | None = None  # dernier `thinking` retenu, pas encore envoyé
    thinking_at: dict[int, float] = {}  # dernier envoi d'un `thinking`, par partie
    last_out = loop.time()

    def thinking(event: Thinking) -> str:
        thinking_at[event.part] = loop.time()
        return sse_of(event)

    try:
        while True:
            ping_at = last_out + ping_s
            flush_at = math.inf if pending is None else thinking_at[pending.part] + throttle_s
            try:
                item = await asyncio.wait_for(
                    queue.get(), max(0.0, min(ping_at, flush_at) - loop.time())
                )
            except TimeoutError:
                if pending is not None and flush_at <= ping_at:
                    chunk, pending = thinking(pending), None
                else:
                    chunk = PING
                yield chunk
                last_out = loop.time()
                continue
            chunks: list[str] = []
            if pending is not None and not (
                isinstance(item, Thinking) and item.part == pending.part
            ):
                chunks.append(thinking(pending))
                pending = None
            if item is None:
                chunks.append(_outcome(task))
            elif not isinstance(item, Thinking):
                chunks.append(sse_of(item))
            elif loop.time() - thinking_at.get(item.part, -math.inf) >= throttle_s:
                chunks.append(thinking(item))
                pending = None
            else:
                pending = item
            for chunk in chunks:
                yield chunk
                last_out = loop.time()
            if item is None:
                return
    finally:
        if not task.done():
            # Client parti : l'annulation rend le scan (`serve_admitted`). On attend qu'elle
            # aboutisse, sans relever l'erreur de la tâche ; si l'appelant est lui-même annulé
            # pendant cette attente, la tâche, déjà annulée, finit seule.
            task.cancel()
            await asyncio.wait([task])
