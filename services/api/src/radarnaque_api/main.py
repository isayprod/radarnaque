import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.auth.jwt import JwksFetcher, JwtVerifier, http_jwks_fetcher
from radarnaque_api.billing import ManualBillingProvider
from radarnaque_api.config import Settings
from radarnaque_api.db import make_engine
from radarnaque_api.errors import install_error_handlers
from radarnaque_api.llm.client import LLMClientFactory
from radarnaque_api.llm.providers import ensure_models_use_known_providers, load_providers
from radarnaque_api.routes import billing, health, internal, me, scans

# En DEBUG, ces bibliothèques journalisent les URL et les corps des requêtes : l'annonce, les
# photos, et les réponses du fournisseur.
_QUIET_LOGGERS = ("httpx", "httpcore", "openai")


def _quiet_http_loggers() -> None:
    for name in _QUIET_LOGGERS:
        logger = logging.getLogger(name)
        if logger.getEffectiveLevel() < logging.WARNING:
            logger.setLevel(logging.WARNING)


# Logs détaillés des scans du superuser (services/scans.py), affichés sur la console hors
# production seulement : en production, ce logger n'a aucun gestionnaire.
DEBUG_LOGGER = "radarnaque.debug"
_DEBUG_HANDLER_MARK = "radarnaque_debug"


def _debug_console(settings: Settings) -> None:
    """Hors production, un seul gestionnaire console sur `radarnaque.debug`, au niveau INFO et
    sans propagation (pas de doublon dans les logs d'uvicorn). Idempotent : créer plusieurs
    applications (tests) n'ajoute pas de gestionnaire."""
    if settings.env == "production":
        return
    logger = logging.getLogger(DEBUG_LOGGER)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if any(getattr(h, _DEBUG_HANDLER_MARK, False) for h in logger.handlers):
        return
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    setattr(handler, _DEBUG_HANDLER_MARK, True)
    logger.addHandler(handler)


def create_app(
    settings: Settings | None = None, *, jwks_fetcher: JwksFetcher | None = None
) -> FastAPI:
    """Construit l'application. Sans argument, lit la configuration dans l'environnement
    (utilisable comme factory uvicorn). `jwks_fetcher` remplace la récupération HTTP du JWKS
    (tests)."""
    settings = settings or Settings()  # type: ignore[call-arg]
    _quiet_http_loggers()
    _debug_console(settings)
    providers = load_providers(settings.providers_file)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.engine = make_engine(settings.database_url)
        # Client dédié aux photos (règles R6, R7, R13) : ni proxy de l'environnement (il
        # résoudrait l'hôte à la place de la vérification SSRF), ni redirection automatique
        # (fetch_images vérifie chaque saut), ni en-têtes, cookies ou authentification partagés.
        app.state.http_images = httpx.AsyncClient(trust_env=False, follow_redirects=False)
        # Un client par fournisseur, créé au premier scan ; jamais le client des photos.
        app.state.llm_clients = LLMClientFactory(providers, os.environ)
        app.state.llm_for = app.state.llm_clients
        try:
            async with AsyncSession(app.state.engine) as session:
                await ensure_models_use_known_providers(session, providers)
            yield
        finally:
            await app.state.llm_clients.aclose()
            await app.state.http_images.aclose()
            await app.state.engine.dispose()

    app = FastAPI(title="Radarnaque API", lifespan=lifespan)
    app.state.settings = settings
    app.state.providers = providers
    app.state.billing = ManualBillingProvider()
    app.state.jwt_verifier = JwtVerifier(
        jwks_fetcher or http_jwks_fetcher(settings.jwks_url),
        settings.jwt_issuer,
        settings.jwt_audience,
    )
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(me.router)
    app.include_router(scans.router)
    app.include_router(billing.router)
    app.include_router(internal.router)
    return app
