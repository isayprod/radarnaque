from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Taille du pool. Un scan garde une connexion pendant sa transaction sous verrou consultatif :
# téléchargement des photos, tours du modèle et recherches web, jusqu'à 180 s (délai total de
# l'analyse), et un scan concurrent de la même annonce garde la sienne en attendant ce verrou.
# Les 5 + 10 connexions par défaut de SQLAlchemy seraient vite prises par quelques analyses
# longues ; au-delà de 30, une requête attend au plus `POOL_TIMEOUT_S` une connexion libre, puis
# échoue, plutôt que de s'empiler sans limite. À multiplier par le nombre de processus de l'API
# pour rester sous `max_connections` de Postgres (100 par défaut).
POOL_SIZE = 15
MAX_OVERFLOW = 15
POOL_TIMEOUT_S = 30


def make_engine(url: str) -> AsyncEngine:
    return create_async_engine(
        url,
        pool_pre_ping=True,
        pool_size=POOL_SIZE,
        max_overflow=MAX_OVERFLOW,
        pool_timeout=POOL_TIMEOUT_S,
    )


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """Dépendance FastAPI : une session par requête, sur l'engine de `app.state.engine`."""
    maker = async_sessionmaker(request.app.state.engine, expire_on_commit=False)
    async with maker() as session:
        yield session
