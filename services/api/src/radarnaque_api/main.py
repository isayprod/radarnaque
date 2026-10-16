from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from radarnaque_api.config import Settings
from radarnaque_api.db import make_engine
from radarnaque_api.errors import install_error_handlers
from radarnaque_api.routes import health


def create_app(settings: Settings | None = None, *, jwks_fetcher: Any | None = None) -> FastAPI:
    """Construit l'application. Sans argument, lit la configuration dans l'environnement
    (utilisable comme factory uvicorn). `jwks_fetcher` est accepté mais ignoré pour l'instant."""
    settings = settings or Settings()  # type: ignore[call-arg]

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.engine = make_engine(settings.database_url)
        try:
            yield
        finally:
            await app.state.engine.dispose()

    app = FastAPI(title="Radarnaque API", lifespan=lifespan)
    app.state.settings = settings
    install_error_handlers(app)
    app.include_router(health.router)
    return app
