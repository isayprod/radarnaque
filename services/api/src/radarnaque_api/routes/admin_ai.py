"""API IA de l'admin : modèles, modèle actif, prompts et réglages (`GET /api/admin/ai`)."""

import os
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import (
    ActiveModelIn,
    AiOverviewOut,
    AiSettingsIn,
    ModelIn,
    PromptIn,
    PromptTextOut,
)
from radarnaque_api.auth.deps import AdminContext, require_admin
from radarnaque_api.db import get_session
from radarnaque_api.services import admin_ai

router = APIRouter(prefix="/api/admin/ai")


async def _overview(request: Request, session: AsyncSession) -> AiOverviewOut:
    return await admin_ai.build_overview(
        session,
        providers=request.app.state.providers,
        settings=request.app.state.settings,
        environ=os.environ,
    )


@router.get("", response_model=AiOverviewOut)
async def overview(
    request: Request,
    _admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AiOverviewOut:
    """Modèles, fournisseurs (état des clés, jamais leur valeur), versions de prompt sans leur
    texte, réglages, moteur de recherche et 20 dernières actions IA."""
    return await _overview(request, session)


@router.post("/models", response_model=AiOverviewOut)
async def add_model(
    request: Request,
    body: ModelIn,
    admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AiOverviewOut:
    """Ajoute un modèle : fournisseur de `providers.toml` (422), couple unique (409)."""
    await admin_ai.add_model(
        session,
        admin_id=admin.user.id,
        providers=request.app.state.providers,
        provider=body.provider,
        slug=body.slug,
    )
    await session.commit()
    return await _overview(request, session)


@router.post("/active-model", response_model=AiOverviewOut)
async def activate_model(
    request: Request,
    body: ActiveModelIn,
    admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AiOverviewOut:
    """Active un modèle pour les scans suivants (le cache est lié au modèle)."""
    await admin_ai.activate_model(
        session,
        admin_id=admin.user.id,
        providers=request.app.state.providers,
        model_id=body.model_id,
    )
    await session.commit()
    return await _overview(request, session)


@router.get("/prompts/{prompt_id}", response_model=PromptTextOut)
async def get_prompt(
    prompt_id: int,
    _admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PromptTextOut:
    """Le texte d'une version, en lecture seule : aucune route ne modifie une version."""
    return await admin_ai.get_prompt(session, prompt_id)


@router.post("/prompts", response_model=PromptTextOut, status_code=201)
async def create_prompt(
    body: PromptIn,
    admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PromptTextOut:
    """Crée la version suivante, non active."""
    prompt_id = await admin_ai.create_prompt(
        session, admin_id=admin.user.id, system_prompt=body.system_prompt
    )
    await session.commit()
    return await admin_ai.get_prompt(session, prompt_id)


@router.post("/prompts/{prompt_id}/activate", response_model=AiOverviewOut)
async def activate_prompt(
    request: Request,
    prompt_id: int,
    admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AiOverviewOut:
    """Active une version du type `full` pour les scans suivants (le cache est lié au prompt)."""
    await admin_ai.activate_prompt(session, admin_id=admin.user.id, prompt_id=prompt_id)
    await session.commit()
    return await _overview(request, session)


@router.patch("/settings", response_model=AiOverviewOut)
async def update_settings(
    request: Request,
    body: AiSettingsIn,
    admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AiOverviewOut:
    """Modifie les réglages fournis ; une ligne de journal par champ réellement changé."""
    await admin_ai.update_settings(session, admin_id=admin.user.id, changes=body)
    await session.commit()
    return await _overview(request, session)
