import argparse
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
import pytest
import pytest_asyncio
from alembic.config import Config
from fastapi import FastAPI
from jwt_helpers import KeyPair, make_jwks, sign
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
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


API_ROOT = Path(__file__).resolve().parents[1]


def _alembic_config(url: str) -> Config:
    config = Config(str(API_ROOT / "alembic.ini"))
    # Équivalent de `alembic -x url=...` : lu par alembic/env.py.
    config.cmd_opts = argparse.Namespace(x=[f"url={url}"])
    return config


@pytest.fixture(scope="session")
def pg_url() -> Iterator[str]:
    """URL SQLAlchemy (postgresql+psycopg://) d'un Postgres 17 jetable.

    Schémas auth/app prêts, `alembic upgrade head` déjà appliqué (offre initiale incluse)."""
    with PostgresContainer("postgres:17", driver=None) as pg:
        raw = pg.get_connection_url()  # postgresql://user:pass@host:port/db
        with psycopg.connect(raw, autocommit=True) as conn:
            conn.execute(SETUP_SQL)
        url = raw.replace("postgresql://", "postgresql+psycopg://", 1)
        command.upgrade(_alembic_config(url), "head")
        yield url


@pytest.fixture(scope="session")
def alembic_config(pg_url: str) -> Config:
    return _alembic_config(pg_url)


@pytest.fixture(autouse=True)
def _clean_user_data(request: pytest.FixtureRequest) -> Iterator[None]:
    """Après chaque test qui touche la base : vide les données utilisateur (jamais l'offre)."""
    yield
    if "pg_url" not in request.fixturenames:
        return
    url = request.getfixturevalue("pg_url").replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(
            "truncate app.scan_results, app.scan_failures, app.scan_events,"
            " app.analysis_reason_texts, app.analysis_reasons, app.analysis_texts, app.analyses,"
            " app.snapshot_images, app.listing_snapshots, app.listings,"
            ' app.subscriptions, auth."user" cascade'
        )


@pytest.fixture
def settings(pg_url: str) -> Settings:
    return Settings(
        database_url=pg_url,
        jwks_url="http://auth.test/auth/jwks",
        jwt_issuer="http://issuer.test",
        jwt_audience="http://audience.test",
        internal_api_secret="test-internal-secret-0123456789abcdef",  # type: ignore[arg-type]
        env="test",
        providers_file=API_ROOT / "providers.toml",
    )


@pytest.fixture
def production(app: FastAPI, settings: Settings) -> Settings:
    """Fait tourner l'application `app` en production : une configuration revalidée avec
    `env="production"`, lue par les routes dans `app.state.settings`."""
    prod = Settings.model_validate({**settings.model_dump(), "env": "production"})
    app.state.settings = prod
    return prod


@pytest.fixture(scope="session")
def test_key_pair() -> KeyPair:
    """Paire de clés Ed25519 dont la partie publique est servie par le JWKS de test."""
    return KeyPair.generate("test-key")


@pytest_asyncio.fixture
async def app(settings: Settings, test_key_pair: KeyPair) -> AsyncIterator[FastAPI]:
    jwks = make_jwks(test_key_pair)

    async def jwks_fetcher() -> dict:
        return jwks

    application = create_app(settings, jwks_fetcher=jwks_fetcher)
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


@pytest_asyncio.fixture
async def make_user(db: AsyncSession) -> Callable[..., Awaitable[str]]:
    """Insère un utilisateur dans auth."user" (validé) et renvoie son identifiant."""

    async def _make(email: str, role: str = "user") -> str:
        uid = uuid4().hex
        await db.execute(
            text('insert into auth."user"(id, email, role) values (:id, :email, :role)'),
            {"id": uid, "email": email, "role": role},
        )
        await db.commit()
        return uid

    return _make


@pytest.fixture
def bearer(settings: Settings, test_key_pair: KeyPair) -> Callable[[str], dict[str, str]]:
    """Renvoie `bearer(uid)` -> en-tête Authorization avec un JWT valide signé pour `uid`."""

    def _bearer(uid: str) -> dict[str, str]:
        token = sign(test_key_pair, uid, settings.jwt_issuer, settings.jwt_audience)
        return {"Authorization": f"Bearer {token}"}

    return _bearer
