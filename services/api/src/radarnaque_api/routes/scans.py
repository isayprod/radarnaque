from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.auth.deps import current_user
from radarnaque_api.auth.privileges import privileges_of
from radarnaque_api.db import get_session
from radarnaque_api.errors import validation_issues
from radarnaque_api.models import AuthUser
from radarnaque_api.schemas import AnalysisResultOut, ScanHistoryOut, ScanIn
from radarnaque_api.services.history import scan_history
from radarnaque_api.services.scans import ScanError, run_scan

router = APIRouter()

HISTORY_DEFAULT_LIMIT = 20
HISTORY_MAX_LIMIT = 50


def _now() -> datetime:
    return datetime.now(UTC)


class _ListingRoute(APIRoute):
    """Un corps de `POST /api/scans` invalide (JSON illisible, champ manquant ou interdit) donne
    `422 invalid_listing` (spec §7.5), et non le `invalid_request` des autres routes."""

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


async def create_scan(
    scan: ScanIn,
    request: Request,
    user: Annotated[AuthUser, Depends(current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AnalysisResultOut:
    # La session de l'authentification n'a plus d'usage : sa connexion retourne au pool au lieu
    # de rester « idle in transaction » pendant l'analyse (jusqu'à ~80 s, photos et LLM).
    await session.close()
    state = request.app.state
    return await run_scan(
        engine=state.engine,
        user=user,
        privileges=privileges_of(user, state.settings),
        scan=scan,
        llm_for=state.llm_for,
        http=state.http_images,
        now=_now,
    )


router.add_api_route(
    "/api/scans",
    create_scan,
    methods=["POST"],
    response_model=AnalysisResultOut,
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
