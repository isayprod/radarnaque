"""Environnement Alembic : schéma `app`, URL via DATABASE_URL ou `-x url=...`."""

import os

from sqlalchemy import create_engine, text

from alembic import context
from radarnaque_api.config import normalize_database_url
from radarnaque_api.models import Base

config = context.config
target_metadata = Base.metadata


def _database_url() -> str:
    url = context.get_x_argument(as_dictionary=True).get("url") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("Base inconnue : définir DATABASE_URL ou passer `-x url=...`.")
    return normalize_database_url(url)


def include_object(obj, name, type_, reflected, compare_to) -> bool:
    """Ignore le schéma `auth` (Better Auth) : seul `app` est migré."""
    if type_ == "table":
        return getattr(obj, "schema", None) != "auth"
    return True


_CONTEXT_OPTS = {
    "target_metadata": target_metadata,
    "include_schemas": True,
    "include_object": include_object,
    "version_table_schema": "app",
}


def run_migrations_offline() -> None:
    context.configure(url=_database_url(), literal_binds=True, **_CONTEXT_OPTS)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(_database_url())
    try:
        with engine.connect() as connection:
            # La table de version vit dans `app` : le schéma doit exister avant la 1re migration.
            connection.execute(text("create schema if not exists app"))
            connection.commit()
            context.configure(connection=connection, **_CONTEXT_OPTS)
            with context.begin_transaction():
                context.run_migrations()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
