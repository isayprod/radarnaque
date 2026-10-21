"""Offre publique (`GET /api/offer`), lue par la page des prix du site."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import PublicOfferOut
from radarnaque_api.db import get_session
from radarnaque_api.services import admin_offer

router = APIRouter()


@router.get("/api/offer", response_model=PublicOfferOut)
async def offer(
    response: Response, session: Annotated[AsyncSession, Depends(get_session)]
) -> PublicOfferOut:
    """Quotas, photos, icônes et prix des trois plans. Publique, sans identifiant Stripe ;
    gardée cinq minutes par les caches."""
    response.headers["Cache-Control"] = "public, max-age=300"
    return await admin_offer.public_offer(session)
