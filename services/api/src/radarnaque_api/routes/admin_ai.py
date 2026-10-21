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
    ModelTestOut,
    PromptIn,
    PromptTextOut,
    SearchTestIn,
    SearchTestOut,
)
from radarnaque_api.auth.deps import AdminContext, require_admin
from radarnaque_api.db import get_session
from radarnaque_api.errors import ApiError
from radarnaque_api.models import Model
from radarnaque_api.services import admin_ai, ai_probes
from radarnaque_api.services.scan_store import active_setup
from radarnaque_api.services.scans import SCAN_KIND

router = APIRouter(prefix="/api/admin/ai")


async def _overview(request: Request, session: AsyncSession) -> AiOverviewOut:
    return await admin_ai.build_overview(
        session,
        providers=request.app.state.providers,
        settings=request.app.state.settings,
        environ=os.environ,
        search_health=request.app.state.search_health,
        search=request.app.state.search,
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


def _too_many_probes() -> ApiError:
    return ApiError(429, "rate_limited", "Trop d'essais en une heure, réessayez plus tard.")


@router.post("/models/{model_id}/test", response_model=ModelTestOut)
async def test_model(
    request: Request,
    model_id: int,
    admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ModelTestOut:
    """Essaie un modèle avec le prompt actif sur une annonce fictive, sans outil ni photo. Rien
    n'est écrit. 10 essais par heure et par admin. Une erreur du fournisseur rend `200` avec
    `ok: false`."""
    state = request.app.state
    if not state.model_test_limiter.hit(admin.user.id):
        raise _too_many_probes()
    model = await session.get(Model, model_id)
    if model is None:
        raise ApiError(404, "not_found", "Modèle introuvable.")
    setup = await active_setup(session, SCAN_KIND)
    if setup is None:
        raise ApiError(409, "conflict", "Aucune version de prompt active.")
    # Fin de la lecture avant l'appel au modèle : aucune connexion n'est gardée pendant l'essai.
    # Le modèle est détaché d'abord : le rollback ne le périme pas.
    session.expunge(model)
    await session.rollback()
    return await ai_probes.probe_model(state, model, setup.system_prompt)


@router.post("/search-test", response_model=SearchTestOut)
async def test_search(
    request: Request,
    body: SearchTestIn,
    admin: Annotated[AdminContext, Depends(require_admin)],
) -> SearchTestOut:
    """Interroge le moteur de recherche sans passer par le cache. 30 essais par heure et par
    admin. La requête n'est ni journalisée ni enregistrée."""
    state = request.app.state
    if not state.search_test_limiter.hit(admin.user.id):
        raise _too_many_probes()
    return await ai_probes.probe_search(state.search, body.query)
