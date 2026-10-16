from collections.abc import AsyncIterator, Iterator

import httpx
import psycopg
import pytest
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from testcontainers.community.postgres import PostgresContainer

from radarnaque_api.config import Settings
from radarnaque_api.main import create_app

SETUP_SQL = """
create schema if not exists auth;
create schema if not exists app;
create table if not exists auth."user" (
    id text primary key,
    email text not null unique,
    role text not null default 'user'
);
"""


@pytest.fixture(scope="session")
def pg_url() -> Iterator[str]:
    """URL SQLAlchemy (postgresql+psycopg://) d'un Postgres 17 jetable, schémas auth/app prêts."""
    with PostgresContainer("postgres:17", driver=None) as pg:
        raw = pg.get_connection_url()  # postgresql://user:pass@host:port/db
        with psycopg.connect(raw, autocommit=True) as conn:
            conn.execute(SETUP_SQL)
        yield raw.replace("postgresql://", "postgresql+psycopg://", 1)


@pytest.fixture
def settings(pg_url: str) -> Settings:
    return Settings(
        database_url=pg_url,
        jwks_url="http://auth.test/auth/jwks",
        jwt_issuer="http://issuer.test",
        jwt_audience="http://audience.test",
        internal_api_secret="test-internal-secret",  # type: ignore[arg-type]
        env="test",
    )


@pytest_asyncio.fixture
async def app(settings: Settings) -> AsyncIterator[FastAPI]:
    application = create_app(settings)
    # ASGITransport n'exécute pas le lifespan : on le fait ici (engine dans app.state).
    async with application.router.lifespan_context(application):
        yield application


@pytest_asyncio.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def db(app: FastAPI) -> AsyncIterator[AsyncSession]:
    maker = async_sessionmaker(app.state.engine, expire_on_commit=False)
    async with maker() as session:
        yield session
