"""IA de l'admin : vue d'ensemble, modèles, prompts et réglages du type de scan `full`.

Les fonctions d'action contrôlent d'abord (404, 409, 422), puis appellent `record_action` en
dernier : aucune ligne de journal ne décrit une modification refusée. Elles ne valident pas la
transaction : le changement et sa ligne partent ensemble au commit de la route.

Le modèle actif, la version de prompt active et les versions elles-mêmes se modifient sous le
même verrou, celui de la ligne `scan_kinds` du type `full` : deux créations de prompt
simultanées reçoivent deux numéros qui se suivent."""

from collections.abc import Mapping
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import (
    AiOverviewOut,
    AiSettingsIn,
    AiSettingsOut,
    ModelOut,
    PromptTextOut,
    PromptVersionOut,
    ProviderOut,
    SearchStatusOut,
)
from radarnaque_api.config import Settings
from radarnaque_api.errors import ApiError
from radarnaque_api.llm.providers import ProviderConfig
from radarnaque_api.models import Analysis, AppSettings, Model, PromptVersion, ScanKind
from radarnaque_api.search import SearchBackend, SearxngBackend
from radarnaque_api.services.admin_log import recent_actions, record_action
from radarnaque_api.services.ai_probes import SearchHealth
from radarnaque_api.services.scans import SCAN_KIND

AI_ACTIONS = 20
# Champs des réglages, dans l'ordre où leurs lignes de journal sont écrites.
SETTING_FIELDS = ("cache_ttl_hours", "rate_limit_per_minute", "max_web_searches")


def _not_found(what: str) -> ApiError:
    return ApiError(404, "not_found", f"{what} introuvable.")


def _provider_out(provider: ProviderConfig, environ: Mapping[str, str]) -> ProviderOut:
    if provider.api_key_env is None:
        key = "not_required"
    else:
        # Variable vide : traitée comme absente, comme `ProviderConfig.api_key`.
        key = "present" if environ.get(provider.api_key_env) else "absent"
    return ProviderOut(
        code=provider.code,
        api=provider.api,
        structured_output=provider.structured_output,
        reasoning_effort=None if provider.reasoning_effort == "none" else provider.reasoning_effort,
        max_images=provider.max_images,
        key=key,
    )


def public_search_url(url: str) -> str:
    """L'URL sans la partie `user:pass@`."""
    scheme, sep, rest = url.partition("://")
    authority, slash, path = rest.partition("/")
    return f"{scheme}{sep}{authority.rpartition('@')[2]}{slash}{path}"


async def search_status(
    settings: Settings, health: SearchHealth | None, search: SearchBackend | None
) -> SearchStatusOut:
    """État du moteur de recherche : `/healthz` (gardé 60 s par `health`) et taille du cache du
    processus qui répond. Sans moteur : `disabled`."""
    if settings.search_backend == "none":
        return SearchStatusOut(backend="none", url=None, status="disabled", cache_entries=None)
    return SearchStatusOut(
        backend=settings.search_backend,
        url=public_search_url(settings.searxng_url),
        status="down" if health is None else await health.status(),
        cache_entries=search.cache_entries if isinstance(search, SearxngBackend) else None,
    )


async def _lock_kind(session: AsyncSession) -> ScanKind:
    """La ligne `scan_kinds` du type `full`, sous verrou et relue en base."""
    return (
        await session.execute(
            select(ScanKind)
            .where(ScanKind.code == SCAN_KIND)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _prompt_version(session: AsyncSession, prompt_id: int | None) -> int | None:
    if prompt_id is None:
        return None
    return await session.scalar(select(PromptVersion.version).where(PromptVersion.id == prompt_id))


async def build_overview(
    session: AsyncSession,
    *,
    providers: Mapping[str, ProviderConfig],
    settings: Settings,
    environ: Mapping[str, str],
    search_health: SearchHealth | None,
    search: SearchBackend | None,
) -> AiOverviewOut:
    """Lit des colonnes, jamais des entités : la session de la route, déjà validée, ne renvoie
    pas d'objets périmés."""
    active_model_id, active_prompt_id = (
        await session.execute(
            select(ScanKind.active_model_id, ScanKind.active_prompt_version_id).where(
                ScanKind.code == SCAN_KIND
            )
        )
    ).one()
    model_counts = dict(
        (
            await session.execute(
                select(Analysis.model_id, func.count()).group_by(Analysis.model_id)
            )
        ).all()
    )
    prompt_counts = dict(
        (
            await session.execute(
                select(Analysis.prompt_version_id, func.count()).group_by(
                    Analysis.prompt_version_id
                )
            )
        ).all()
    )
    models = [
        ModelOut(
            id=id_,
            provider=provider,
            slug=slug,
            analyses=model_counts.get(id_, 0),
            active=id_ == active_model_id,
            known_provider=provider in providers,
        )
        for id_, provider, slug in (
            await session.execute(
                select(Model.id, Model.provider, Model.slug).order_by(Model.provider, Model.slug)
            )
        ).all()
    ]
    prompts = [
        PromptVersionOut(
            id=id_,
            version=version,
            created_at=created_at,
            active=id_ == active_prompt_id,
            analyses=prompt_counts.get(id_, 0),
        )
        for id_, version, created_at in (
            await session.execute(
                select(PromptVersion.id, PromptVersion.version, PromptVersion.created_at)
                .where(PromptVersion.scan_kind == SCAN_KIND)
                .order_by(PromptVersion.version.desc())
            )
        ).all()
    ]
    cache_ttl, rate_limit, max_searches = (
        await session.execute(
            select(
                AppSettings.cache_ttl_hours,
                AppSettings.rate_limit_per_minute,
                AppSettings.max_web_searches,
            )
        )
    ).one()
    return AiOverviewOut(
        providers=[_provider_out(p, environ) for p in providers.values()],
        models=models,
        active_model_id=active_model_id,
        prompts=prompts,
        active_prompt_version_id=active_prompt_id,
        settings=AiSettingsOut(
            cache_ttl_hours=cache_ttl,
            rate_limit_per_minute=rate_limit,
            max_web_searches=max_searches,
        ),
        search=await search_status(settings, search_health, search),
        actions=await recent_actions(session, prefix="ai.", limit=AI_ACTIONS),
    )


async def add_model(
    session: AsyncSession,
    *,
    admin_id: str,
    providers: Mapping[str, ProviderConfig],
    provider: str,
    slug: str,
) -> None:
    """Ajoute un modèle : fournisseur de `providers.toml` (422), couple unique (409)."""
    if provider not in providers:
        raise ApiError(
            422, "invalid_value", "Fournisseur inconnu de providers.toml.", {"field": "provider"}
        )
    inserted = await session.scalar(
        insert(Model)
        .values(provider=provider, slug=slug)
        .on_conflict_do_nothing(index_elements=[Model.provider, Model.slug])
        .returning(Model.id)
    )
    if inserted is None:
        raise ApiError(409, "conflict", "Ce modèle existe déjà pour ce fournisseur.")
    record_action(
        session,
        admin_id=admin_id,
        action="ai.model_added",
        details={"provider": provider, "slug": slug},
    )


async def activate_model(
    session: AsyncSession,
    *,
    admin_id: str,
    providers: Mapping[str, ProviderConfig],
    model_id: int,
) -> None:
    """Active un modèle pour le type `full`. Absent : 404 ; fournisseur retiré de
    `providers.toml` : 422. Déjà actif : rien n'est écrit."""
    kind = await _lock_kind(session)
    model = (
        await session.execute(
            select(Model).where(Model.id == model_id).execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if model is None:
        raise _not_found("Modèle")
    if model.provider not in providers:
        raise ApiError(
            422,
            "invalid_value",
            "Le fournisseur de ce modèle n'est plus dans providers.toml.",
            {"field": "modelId"},
        )
    previous = kind.active_model_id
    if previous == model_id:
        return
    kind.active_model_id = model_id
    await session.flush()
    record_action(
        session,
        admin_id=admin_id,
        action="ai.model_activated",
        details={"from": previous, "to": model_id},
    )


async def get_prompt(session: AsyncSession, prompt_id: int) -> PromptTextOut:
    """Le texte d'une version, avec ses compteurs ; 404 si elle n'existe pas."""
    row = (
        await session.execute(
            select(
                PromptVersion.id,
                PromptVersion.version,
                PromptVersion.created_at,
                PromptVersion.system_prompt,
                PromptVersion.id == ScanKind.active_prompt_version_id,
                select(func.count())
                .where(Analysis.prompt_version_id == PromptVersion.id)
                .correlate(PromptVersion)
                .scalar_subquery(),
            )
            .select_from(PromptVersion)
            .outerjoin(ScanKind, ScanKind.code == SCAN_KIND)
            .where(PromptVersion.id == prompt_id)
        )
    ).one_or_none()
    if row is None:
        raise _not_found("Version de prompt")
    id_, version, created_at, system_prompt, active, analyses = row
    return PromptTextOut(
        id=id_,
        version=version,
        created_at=created_at,
        active=bool(active),
        analyses=analyses,
        system_prompt=system_prompt,
    )


async def create_prompt(session: AsyncSession, *, admin_id: str, system_prompt: str) -> int:
    """Crée la version suivante du type `full`, non active ; renvoie son identifiant. Le verrou
    de `scan_kinds` sérialise les créations : jamais deux fois le même numéro."""
    await _lock_kind(session)
    last = await session.scalar(
        select(func.max(PromptVersion.version)).where(PromptVersion.scan_kind == SCAN_KIND)
    )
    version = (last or 0) + 1
    created = await session.scalar(
        insert(PromptVersion)
        .values(scan_kind=SCAN_KIND, version=version, system_prompt=system_prompt)
        .returning(PromptVersion.id)
    )
    record_action(
        session, admin_id=admin_id, action="ai.prompt_created", details={"version": version}
    )
    assert created is not None
    return created


async def activate_prompt(session: AsyncSession, *, admin_id: str, prompt_id: int) -> None:
    """Active une version du type `full`. Absente : 404 ; d'un autre type : 422. Déjà active :
    rien n'est écrit."""
    kind = await _lock_kind(session)
    prompt = (
        await session.execute(
            select(PromptVersion.id, PromptVersion.version, PromptVersion.scan_kind).where(
                PromptVersion.id == prompt_id
            )
        )
    ).one_or_none()
    if prompt is None:
        raise _not_found("Version de prompt")
    if prompt.scan_kind != SCAN_KIND:
        raise ApiError(
            422,
            "invalid_value",
            "Cette version n'est pas une version du type de scan actif.",
            {"field": "promptId"},
        )
    previous_id = kind.active_prompt_version_id
    if previous_id == prompt_id:
        return
    previous = await _prompt_version(session, previous_id)
    kind.active_prompt_version_id = prompt_id
    await session.flush()
    record_action(
        session,
        admin_id=admin_id,
        action="ai.prompt_activated",
        details={"from": previous, "to": prompt.version},
    )


async def update_settings(session: AsyncSession, *, admin_id: str, changes: AiSettingsIn) -> None:
    """Applique les champs fournis et réellement changés ; une ligne de journal par champ.
    Corps vide ou sans changement : rien n'est écrit."""
    row = (
        await session.execute(
            select(AppSettings).with_for_update().execution_options(populate_existing=True)
        )
    ).scalar_one()
    wanted: dict[str, Any] = {f: getattr(changes, f) for f in SETTING_FIELDS}
    for field in SETTING_FIELDS:
        new = wanted[field]
        old = getattr(row, field)
        if new is None or new == old:
            continue
        setattr(row, field, new)
        await session.flush()
        record_action(
            session,
            admin_id=admin_id,
            action="ai.settings_set",
            details={"field": field, "from": old, "to": new},
        )
