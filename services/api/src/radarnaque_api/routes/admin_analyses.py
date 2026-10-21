"""API Analyses de l'admin : liste filtrée et détail, en lecture seule. Aucune écriture, aucune
ligne `admin_actions`, aucune donnée de compte."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import AnalysisDetailOut, AnalysisListOut
from radarnaque_api.auth.deps import AdminContext, require_admin
from radarnaque_api.db import get_session
from radarnaque_api.schemas import RiskLevel
from radarnaque_api.services import admin_analyses

router = APIRouter(prefix="/api/admin/analyses")

ListLimit = Annotated[int, Query(ge=1, le=50)]


@router.get("", response_model=AnalysisListOut)
async def list_analyses(
    _admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
    site: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    level: RiskLevel | None = None,
    model_id: Annotated[int | None, Query(alias="modelId")] = None,
    prompt_version_id: Annotated[int | None, Query(alias="promptVersionId")] = None,
    day_from: Annotated[date | None, Query(alias="from")] = None,
    day_to: Annotated[date | None, Query(alias="to")] = None,
    with_search: Annotated[bool | None, Query(alias="withSearch")] = None,
    partial: bool | None = None,
    q: Annotated[str | None, Query(min_length=3, max_length=200)] = None,
    before: Annotated[int | None, Query(ge=1)] = None,
    limit: ListLimit = 50,
) -> AnalysisListOut:
    """Les analyses, de la plus récente à la plus ancienne. `from` et `to` : jours civils de
    Bruxelles (`YYYY-MM-DD`), bornes incluses ; `q` : sous-chaîne du titre, casse ignorée (3
    caractères au moins) ; `before` : identifiant de la dernière analyse de la page précédente."""
    return await admin_analyses.list_analyses(
        session,
        site=site,
        level=level,
        model_id=model_id,
        prompt_version_id=prompt_version_id,
        day_from=day_from,
        day_to=day_to,
        with_search=with_search,
        partial=partial,
        q=q,
        before=before,
        limit=limit,
    )


@router.get("/{analysis_id}", response_model=AnalysisDetailOut)
async def get_analysis(
    analysis_id: int,
    _admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AnalysisDetailOut:
    return await admin_analyses.build_analysis_detail(session, analysis_id)
