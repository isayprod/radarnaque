"""API Tableau de bord de l'admin : cartes, abonnés, mois, santé et série quotidienne."""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import DailyOut, DashboardOut
from radarnaque_api.auth.deps import AdminContext, require_admin
from radarnaque_api.db import get_session
from radarnaque_api.services import dashboard as dashboard_service

router = APIRouter(prefix="/api/admin/dashboard")

DEFAULT_DAYS = 30
MAX_DAYS = 90


@router.get("", response_model=DashboardOut)
async def overview(
    request: Request,
    _admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> DashboardOut:
    """Cartes du jour et des 7 derniers jours civils de Bruxelles, abonnés actifs, coût du mois
    et santé du service. Aucune donnée personnelle."""
    return await dashboard_service.dashboard(
        session,
        datetime.now(UTC),
        settings=request.app.state.settings,
        health=request.app.state.search_health,
        search=request.app.state.search,
    )


@router.get("/daily", response_model=DailyOut)
async def daily(
    _admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
    days: Annotated[int, Query(ge=1, le=MAX_DAYS)] = DEFAULT_DAYS,
) -> DailyOut:
    """Un point par jour civil de Bruxelles, jours vides compris, du plus ancien au plus récent."""
    return await dashboard_service.daily(session, datetime.now(UTC), days)
