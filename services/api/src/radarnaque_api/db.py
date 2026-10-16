from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def make_engine(url: str) -> AsyncEngine:
    return create_async_engine(url, pool_pre_ping=True)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """Dépendance FastAPI : une session par requête, sur l'engine de `app.state.engine`."""
    maker = async_sessionmaker(request.app.state.engine, expire_on_commit=False)
    async with maker() as session:
        yield session
