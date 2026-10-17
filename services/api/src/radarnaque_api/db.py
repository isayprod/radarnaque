from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Taille du pool. Un `POST /api/scans` garde une connexion pendant sa transaction sous verrou
# consultatif : téléchargement des photos (4 × 5 s) puis appel LLM (2 × 30 s), soit ~80 s au
# pire, et un scan concurrent de la même annonce garde la sienne en attendant ce verrou. Les
# 5 + 10 connexions par défaut de SQLAlchemy seraient vite prises par quelques analyses lentes ;
# au-delà de 20, une requête attend au plus `POOL_TIMEOUT_S` une connexion libre, puis échoue,
# plutôt que de s'empiler sans limite. À multiplier par le nombre de processus de l'API pour
# rester sous `max_connections` de Postgres (100 par défaut).
POOL_SIZE = 10
MAX_OVERFLOW = 10
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
