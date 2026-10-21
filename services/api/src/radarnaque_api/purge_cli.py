"""Commande `radarnaque-purge` : une passe de la purge à 12 mois (scans, journal admin, appels
au modèle)."""

import asyncio
import sys
from datetime import UTC, datetime

from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from radarnaque_api.config import Settings
from radarnaque_api.db import make_engine
from radarnaque_api.services.purge import PurgeReport, run_purge

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_CONFIG = 2


def _fail(message: str, code: int) -> int:
    print(f"radarnaque-purge : {message}", file=sys.stderr)
    return code


async def _run(settings: Settings) -> PurgeReport | None:
    engine = make_engine(settings.database_url)
    try:
        return await run_purge(engine, datetime.now(UTC))
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
        report = asyncio.run(_run(settings))
    except SQLAlchemyError as exc:
        # Ni l'URL ni le détail de l'erreur : ils peuvent contenir l'hôte ou des identifiants.
        return _fail(
            f"base de données inaccessible ou requête refusée ({type(exc).__name__})", EXIT_ERROR
        )
    if report is None:
        print("purge déjà en cours ailleurs")
    else:
        print(
            f"scan_events supprimés : {report.scans}, admin_actions : {report.admin_actions}, "
            f"llm_calls : {report.llm_calls}"
        )
    return EXIT_OK
