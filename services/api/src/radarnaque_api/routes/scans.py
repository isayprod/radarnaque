import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import Receive, Scope, Send

from radarnaque_api.auth.deps import current_user
from radarnaque_api.auth.privileges import privileges_of
from radarnaque_api.db import get_session
from radarnaque_api.errors import validation_issues
from radarnaque_api.models import AuthUser
from radarnaque_api.schemas import AnalysisResultOut, ScanHistoryOut, ScanIn
from radarnaque_api.services.history import scan_history
from radarnaque_api.services.scan_stream import ScanEventSink, stream_scan
from radarnaque_api.services.scans import (
    ScanError,
    admit_scan,
    give_back_unserved,
    run_scan,
    serve_admitted,
)

router = APIRouter()

HISTORY_DEFAULT_LIMIT = 20
HISTORY_MAX_LIMIT = 50


def _now() -> datetime:
    return datetime.now(UTC)


class _ListingRoute(APIRoute):
    """Un corps de `POST /api/scans`, `POST /api/identify` ou de leur version en flux invalide
    (JSON illisible, champ manquant ou interdit) donne `422 invalid_listing` (spec §7.5), et non
    le `invalid_request` des autres routes."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def _handler(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError as exc:
                issues = validation_issues(exc)
            # Levée hors du `except` : l'erreur de validation, qui porte le corps reçu, ne lui
            # est pas chaînée. `field` : le premier champ en cause, sans le préfixe `body` ;
            # `body` pour un JSON illisible (dont l'emplacement est une position, pas un champ).
            first = issues[0] if issues else {"loc": [], "type": "json_invalid"}
            loc = [] if first["type"] == "json_invalid" else [str(p) for p in first["loc"][1:]]
            raise ScanError(
                422,
                "invalid_listing",
                "Annonce invalide.",
                {"field": ".".join(loc) or "body", "errors": issues},
            )

        return _handler


class _GiveBackStreamingResponse(StreamingResponse):
    """`StreamingResponse` qui lance `give_back` à la fin de la réponse, quelle qu'en soit
    l'issue. Starlette n'exécute `background` qu'en ASGI < 2.4 quand le client est parti (en
    2.4, l'`OSError` de `send` devient `ClientDisconnect`) : ce `finally` ne dépend pas de la
    version annoncée par le serveur. `shield` : l'écriture aboutit même si la requête est
    annulée pendant celle-ci."""

    def __init__(self, *args: Any, give_back: Callable[[], Awaitable[None]], **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._give_back = give_back

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await asyncio.shield(self._give_back())


def _scan_args(scan: ScanIn, request: Request, user: AuthUser) -> dict[str, Any]:
    """Arguments communs de `run_scan`, `admit_scan` et `admit_identify`, tirés de l'état de
    l'application."""
    state = request.app.state
    return {
        "engine": state.engine,
        "user": user,
        "privileges": privileges_of(user, state.settings),
        "scan": scan,
        "llm_for": state.llm_for,
        "http": state.http_images,
        "http_pages": state.http_pages,
        "search": state.search,
        "now": _now,
    }


def _sse_headers() -> dict[str, str]:
    # Ni cache ni tampon d'un proxy : chaque événement part aussitôt (Caddy : flush_interval).
    return {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


async def create_scan(
    scan: ScanIn,
    request: Request,
    user: Annotated[AuthUser, Depends(current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AnalysisResultOut:
    # La session de l'authentification n'a plus d'usage : sa connexion retourne au pool au lieu
    # de rester « idle in transaction » pendant l'analyse (jusqu'à 180 s, photos et LLM).
    await session.close()
    state = request.app.state
    return await run_scan(
        **_scan_args(scan, request, user),
        timeout_s=state.analysis_timeout_s,
        identify_timeout_s=state.scan_identify_budget_s,
        total_s=state.scan_total_budget_s,
    )


async def create_scan_stream(
    scan: ScanIn,
    request: Request,
    user: Annotated[AuthUser, Depends(current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StreamingResponse:
    """Même scan que `POST /api/scans`, en Server-Sent Events (spec §8.3). L'admission se fait
    avant toute réponse : un refus (401, 402, 403, 422, 429) reste une erreur JSON."""
    await session.close()  # comme `create_scan`
    admitted = await admit_scan(**_scan_args(scan, request, user))
    timeout_s = request.app.state.analysis_timeout_s
    identify_timeout_s = request.app.state.scan_identify_budget_s
    total_s = request.app.state.scan_total_budget_s
    served = False

    async def serve(sink: ScanEventSink) -> AnalysisResultOut:
        nonlocal served
        served = True  # dès lors, `serve_admitted` rend le scan s'il est annulé
        return await serve_admitted(
            admitted,
            sink,
            timeout_s=timeout_s,
            identify_timeout_s=identify_timeout_s,
            total_s=total_s,
        )

    async def give_back_if_unserved() -> None:
        # Client parti avant que l'analyse ne commence (flux jamais lancé, ou tâche annulée
        # avant son premier pas) : rien d'autre ne rendrait le scan réservé. Lancé à la fin de
        # la réponse, même interrompue par la déconnexion.
        if not served:
            await give_back_unserved(admitted)

    return _GiveBackStreamingResponse(
        stream_scan(serve),
        media_type="text/event-stream",
        headers=_sse_headers(),
        give_back=give_back_if_unserved,
    )


router.add_api_route(
    "/api/scans",
    create_scan,
    methods=["POST"],
    response_model=AnalysisResultOut,
    route_class_override=_ListingRoute,
)
router.add_api_route(
    "/api/scans/stream",
    create_scan_stream,
    methods=["POST"],
    response_class=StreamingResponse,
    route_class_override=_ListingRoute,
)


@router.get("/api/scans/history", response_model=ScanHistoryOut)
async def history(
    user: Annotated[AuthUser, Depends(current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    limit: Annotated[int, Query(ge=1, le=HISTORY_MAX_LIMIT)] = HISTORY_DEFAULT_LIMIT,
    before: Annotated[int | None, Query(ge=1)] = None,
) -> ScanHistoryOut:
    return await scan_history(session, user.id, limit=limit, before=before)
