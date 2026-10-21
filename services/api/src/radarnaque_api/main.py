import asyncio
import contextlib
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

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
from radarnaque_api.routes import (
    admin_ai,
    admin_analyses,
    admin_dashboard,
    admin_offer,
    admin_users,
    billing,
    health,
    internal,
    me,
    offer,
    scans,
)
from radarnaque_api.search import make_search_backend
from radarnaque_api.services.admin_offer import PublicOfferCache
from radarnaque_api.services.ai_probes import SearchHealth
from radarnaque_api.services.purge import purge_forever
from radarnaque_api.services.rate_window import SlidingWindowLimiter
from radarnaque_api.services.scans import ANALYSIS_TIMEOUT_S

# En DEBUG, ces bibliothèques journalisent les URL et les corps des requêtes : l'annonce, les
# photos, et les réponses du fournisseur.
_QUIET_LOGGERS = ("httpx", "httpcore", "openai")


def _quiet_http_loggers() -> None:
    for name in _QUIET_LOGGERS:
        logger = logging.getLogger(name)
        if logger.getEffectiveLevel() < logging.WARNING:
            logger.setLevel(logging.WARNING)


# Logs détaillés des scans du superuser (services/scans.py), affichés sur la console hors
# production seulement : en production, ce logger est réduit au silence.
DEBUG_LOGGER = "radarnaque.debug"
_DEBUG_HANDLER_MARK = "radarnaque_debug"
_DEBUG_NULL_MARK = "radarnaque_debug_null"


def _debug_console(settings: Settings) -> None:
    """Hors production, un seul gestionnaire console sur `radarnaque.debug`, au niveau INFO et
    sans propagation (pas de doublon dans les logs d'uvicorn). En production, un seul
    `NullHandler` et aucune propagation : rien ne remonte à la racine, quelle que soit sa
    configuration. Idempotent : créer plusieurs applications (tests) n'ajoute rien."""
    logger = logging.getLogger(DEBUG_LOGGER)
    if settings.env == "production":
        logger.propagate = False
        if not any(getattr(h, _DEBUG_NULL_MARK, False) for h in logger.handlers):
            null = logging.NullHandler()
            setattr(null, _DEBUG_NULL_MARK, True)
            logger.addHandler(null)
        return
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if any(getattr(h, _DEBUG_HANDLER_MARK, False) for h in logger.handlers):
        return
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    setattr(handler, _DEBUG_HANDLER_MARK, True)
    logger.addHandler(handler)


# Logger parent des journaux du projet (`radarnaque.purge`, `radarnaque.accounts`…). Sous
# uvicorn, la racine n'a aucun gestionnaire : sans le sien, seuls les WARNING s'afficheraient
# (gestionnaire de dernier recours de `logging`), jamais les lignes INFO de la purge ni de la
# suppression d'un compte. Ces lignes ne portent aucun identifiant : affichées aussi en production.
PROJECT_LOGGER = "radarnaque"
_PROJECT_HANDLER_MARK = "radarnaque_console"


def _project_console() -> None:
    """Un seul gestionnaire console sur `radarnaque`, au niveau INFO. La propagation reste
    active (la racine n'a pas de gestionnaire sous uvicorn ; caplog s'y branche en test).
    `radarnaque.debug` ne propage pas (`_debug_console`) : ses lignes ne passent pas ici en
    double. Idempotent : créer plusieurs applications (tests) n'ajoute rien."""
    logger = logging.getLogger(PROJECT_LOGGER)
    logger.setLevel(logging.INFO)
    if any(getattr(h, _PROJECT_HANDLER_MARK, False) for h in logger.handlers):
        return
    handler = logging.StreamHandler()
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    setattr(handler, _PROJECT_HANDLER_MARK, True)
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
    _project_console()
    providers = load_providers(settings.providers_file)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.engine = make_engine(settings.database_url)
        # Client dédié aux photos (règles R6, R7, R13) : ni proxy de l'environnement (il
        # résoudrait l'hôte à la place de la vérification SSRF), ni redirection automatique
        # (fetch_images vérifie chaque saut), ni en-têtes, cookies ou authentification partagés.
        app.state.http_images = httpx.AsyncClient(trust_env=False, follow_redirects=False)
        # Client dédié à SearXNG, seul hôte que l'API appelle pour la recherche : pas de proxy de
        # l'environnement ni de redirection. Absent (None) quand SEARCH_BACKEND vaut "none".
        app.state.http_search = (
            None
            if settings.search_backend == "none"
            else httpx.AsyncClient(trust_env=False, follow_redirects=False)
        )
        app.state.search = (
            None
            if app.state.http_search is None
            else make_search_backend(settings, app.state.http_search)
        )
        # Disponibilité de SearXNG (`/healthz`), pour l'écran IA de l'admin.
        app.state.search_health = (
            None
            if app.state.http_search is None
            else SearchHealth(app.state.http_search, settings.searxng_url)
        )
        # Un client par fournisseur, créé au premier scan ; jamais le client des photos.
        app.state.llm_clients = LLMClientFactory(providers, os.environ)
        app.state.llm_for = app.state.llm_clients
        app.state.purge_task = None
        try:
            async with AsyncSession(app.state.engine) as session:
                await ensure_models_use_known_providers(session, providers)
            # Purge quotidienne des scans de plus de 12 mois (première passe après 60 s).
            app.state.purge_task = (
                asyncio.create_task(purge_forever(app.state.engine, lambda: datetime.now(UTC)))
                if settings.purge_enabled
                else None
            )
            yield
        finally:
            # Arrêtée avant la fermeture de l'engine. Une passe en cours s'interrompt : son lot
            # en cours n'est pas validé, les précédents restent supprimés.
            if app.state.purge_task is not None:
                app.state.purge_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await app.state.purge_task
            await app.state.llm_clients.aclose()
            await app.state.http_images.aclose()
            if app.state.http_search is not None:
                await app.state.http_search.aclose()
            await app.state.engine.dispose()

    app = FastAPI(title="Radarnaque API", lifespan=lifespan)
    app.state.settings = settings
    app.state.providers = providers
    app.state.billing = ManualBillingProvider()
    app.state.public_offer_cache = PublicOfferCache()  # `GET /api/offer` : 60 s en mémoire
    app.state.analysis_timeout_s = ANALYSIS_TIMEOUT_S  # délai total d'une analyse (réduit en test)
    app.state.jwt_verifier = JwtVerifier(
        jwks_fetcher or http_jwks_fetcher(settings.jwks_url),
        settings.jwt_issuer,
        settings.jwt_audience,
    )
    # Essais de l'admin (modèle, recherche) : par administrateur, en mémoire du processus. Un
    # redémarrage les remet à zéro ; plusieurs processus auraient chacun leur compteur.
    app.state.model_test_limiter = SlidingWindowLimiter(10, 3600)
    app.state.search_test_limiter = SlidingWindowLimiter(30, 3600)
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(me.router)
    app.include_router(scans.router)
    app.include_router(billing.router)
    app.include_router(internal.router)
    app.include_router(admin_users.router)
    app.include_router(admin_ai.router)
    app.include_router(admin_analyses.router)
    app.include_router(admin_dashboard.router)
    app.include_router(admin_offer.router)
    app.include_router(offer.router)
    return app
