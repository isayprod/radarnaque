"""Commande `radarnaque-purge` : une passe de la purge des scans de plus de 12 mois."""

import asyncio
import sys
from datetime import UTC, datetime

from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from radarnaque_api.config import Settings
from radarnaque_api.db import make_engine
from radarnaque_api.services.purge import purge_old_scans

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CONFIG = 2


def _fail(message: str, code: int) -> int:
    print(f"radarnaque-purge : {message}", file=sys.stderr)
    return code


async def _run(settings: Settings) -> int | None:
    engine = make_engine(settings.database_url)
    try:
        return await purge_old_scans(engine, datetime.now(UTC))
    finally:
        await engine.dispose()


def main() -> int:
    try:
        settings = Settings()  # type: ignore[call-arg]
    except ValidationError as exc:
        # Les noms des variables seulement : les valeurs lues peuvent contenir des secrets.
        fields = sorted({".".join(str(p) for p in e["loc"]) for e in exc.errors()})
        return _fail(f"configuration invalide ({', '.join(fields)})", EXIT_CONFIG)
    try:
        deleted = asyncio.run(_run(settings))
    except SQLAlchemyError as exc:
        # Ni l'URL ni le détail de l'erreur : ils peuvent contenir l'hôte ou des identifiants.
        return _fail(
            f"base de données inaccessible ou requête refusée ({type(exc).__name__})", EXIT_ERROR
        )
    if deleted is None:
        print("purge déjà en cours ailleurs")
    else:
        print(f"scan_events supprimés : {deleted}")
    return EXIT_OK
