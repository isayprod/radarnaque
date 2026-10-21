"""API Offre de l'admin : plans, prix, quotas, photos, icônes et plafond (`/api/admin/offer`)."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import AdminOfferOut, OfferPlanIn
from radarnaque_api.auth.deps import AdminContext, require_admin
from radarnaque_api.db import get_session
from radarnaque_api.services import admin_offer

router = APIRouter(prefix="/api/admin/offer")


@router.get("", response_model=AdminOfferOut)
async def overview(
    _admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AdminOfferOut:
    """Les trois plans (prix, quota, photos, icônes, plafond) et les 20 dernières actions
    `offer.*`."""
    return await admin_offer.build_overview(session)


@router.patch("/plans/{plan}", response_model=AdminOfferOut)
async def update_plan(
    plan: str,
    body: OfferPlanIn,
    admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AdminOfferOut:
    """Modifie les champs fournis ; une ligne de journal par champ réellement changé. Les
    abonnés actuels sont concernés aussitôt : un quota abaissé sous leur consommation leur
    laisse 0 scan restant."""
    await admin_offer.update_plan(session, admin_id=admin.user.id, plan_code=plan, changes=body)
    await session.commit()
    return await admin_offer.build_overview(session)
