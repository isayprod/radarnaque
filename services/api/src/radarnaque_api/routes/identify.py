"""Identification du produit (spec §6) : `POST /api/identify` et sa version en flux, avec la
même admission, les mêmes refus JSON et les mêmes garanties de remboursement que le scan."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.auth.deps import current_user
from radarnaque_api.db import get_session
from radarnaque_api.models import AuthUser
from radarnaque_api.routes.scans import (
    _GiveBackStreamingResponse,
    _ListingRoute,
    _scan_args,
    _sse_headers,
)
from radarnaque_api.schemas import IdentificationOut, ScanIn
from radarnaque_api.services.identify_service import admit_identify, serve_identify
from radarnaque_api.services.scan_stream import ScanEventSink, stream_scan
from radarnaque_api.services.scans import give_back_unserved

router = APIRouter()


async def create_identification(
    scan: ScanIn,
    request: Request,
    user: Annotated[AuthUser, Depends(current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> IdentificationOut:
    """Sans flux, pour les tests et `e2e`."""
    await session.close()  # comme `create_scan` : rien ne reste « idle in transaction »
    admitted = await admit_identify(**_scan_args(scan, request, user))
    return await serve_identify(admitted, timeout_s=request.app.state.identify_timeout_s)


async def create_identification_stream(
    scan: ScanIn,
    request: Request,
    user: Annotated[AuthUser, Depends(current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StreamingResponse:
    """Événements du pipeline, `identification`, puis `result` (le même `IdentificationOut`)
    ou `error`. L'admission se fait avant toute réponse : un refus reste une erreur JSON."""
    await session.close()
    admitted = await admit_identify(**_scan_args(scan, request, user))
    timeout_s = request.app.state.identify_timeout_s
    served = False

    async def serve(sink: ScanEventSink) -> IdentificationOut:
        nonlocal served
        served = True  # dès lors, `serve_identify` rend le scan s'il est annulé
        return await serve_identify(admitted, sink, timeout_s=timeout_s)

    async def give_back_if_unserved() -> None:
        if not served:  # client parti avant le début du flux
            await give_back_unserved(admitted)

    return _GiveBackStreamingResponse(
        stream_scan(serve),
        media_type="text/event-stream",
        headers=_sse_headers(),
        give_back=give_back_if_unserved,
    )


router.add_api_route(
    "/api/identify",
    create_identification,
    methods=["POST"],
    response_model=IdentificationOut,
    route_class_override=_ListingRoute,
)
router.add_api_route(
    "/api/identify/stream",
    create_identification_stream,
    methods=["POST"],
    response_class=StreamingResponse,
    route_class_override=_ListingRoute,
)
