"""Offre publique (`GET /api/offer`), lue par la page des prix du site."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import PublicOfferOut
from radarnaque_api.db import get_session

router = APIRouter()


@router.get("/api/offer", response_model=PublicOfferOut)
async def offer(
    request: Request, response: Response, session: Annotated[AsyncSession, Depends(get_session)]
) -> PublicOfferOut:
    """Quotas, photos, icônes et prix des trois plans. Publique, sans identifiant Stripe ;
    gardée cinq minutes par les caches, et 60 s en mémoire par le serveur (vidée par chaque
    enregistrement de l'admin)."""
    response.headers["Cache-Control"] = "public, max-age=300"
    return await request.app.state.public_offer_cache.get(session)
