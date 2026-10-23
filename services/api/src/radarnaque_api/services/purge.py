"""Purge à 12 mois de l'historique des scans (`scan_events`, avec leurs `scan_results` et
`scan_failures` par cascade), du journal de l'admin (`admin_actions`) et de la trace des appels
au modèle (`llm_calls`). Les analyses et les snapshots d'annonces restent. Chaque passe qui a
tourné écrit une ligne `system.purge` dans le journal."""

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, insert, select, text
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.sql.expression import TextClause

from radarnaque_api.models import AdminAction
from radarnaque_api.services.periods import add_months

SCAN_RETENTION_MONTHS = 12
PURGE_BATCH = 5_000
PURGE_FIRST_DELAY_S = 60
PURGE_INTERVAL_S = 24 * 3600
# Clé fixe du verrou consultatif de session (« RADAPURG ») : un seul processus purge à la fois.
PURGE_LOCK_KEY = 0x52414441_50555247

logger = logging.getLogger("radarnaque.purge")

_SELECT_BATCH = text(
    "select id from app.scan_events where created_at < :cutoff"
    " order by id limit :batch for update skip locked"
)
# Quota « à vie » de l'essai : ses scans réussis (sans `scan_failures`) faits depuis le début
# de l'abonnement comptent toujours après la purge. Les périodes mensuelles n'en ont pas besoin :
# un événement de plus de 12 mois est hors de toute période en cours.
_COUNT_LIFETIME_SCANS = text(
    """
    update app.subscriptions s set purged_scans = s.purged_scans + c.n
    from (
        select sub.id as subscription_id, count(*) as n
        from app.scan_events e
        join app.subscriptions sub
            on sub.user_id = e.user_id and e.created_at >= sub.period_start
        join app.plans p on p.code = sub.plan and p.quota_period = 'lifetime'
        where e.id = any(:ids)
            and not e.included
            and not exists (select 1 from app.scan_failures f where f.scan_event_id = e.id)
        group by sub.id
    ) c
    where s.id = c.subscription_id
    """
)
_DELETE_BATCH = text("delete from app.scan_events where id = any(:ids)")
_DELETE_ADMIN_ACTIONS = text("delete from app.admin_actions where created_at < :cutoff")
_DELETE_LLM_CALLS = text("delete from app.llm_calls where created_at < :cutoff")


@dataclass(frozen=True)
class PurgeReport:
    """Ce qu'une passe a supprimé."""

    scans: int
    admin_actions: int
    llm_calls: int


def retention_cutoff(now: datetime) -> datetime:
    """`now` moins `SCAN_RETENTION_MONTHS` mois calendaires : même jour et même heure, le jour
    plafonné à la fin du mois (29 février → 28 février)."""
    return add_months(now, -SCAN_RETENTION_MONTHS)


async def _purge_scans(engine: AsyncEngine, cutoff: datetime) -> int:
    """Supprime les `scan_events` antérieurs à `cutoff`, par lots de `PURGE_BATCH`, chacun dans sa
    transaction. Renvoie leur nombre. Un lot en échec lève l'exception : les lots précédents
    restent supprimés."""
    total = 0
    try:
        while True:
            async with engine.begin() as conn:
                ids = list(
                    (
                        await conn.execute(_SELECT_BATCH, {"cutoff": cutoff, "batch": PURGE_BATCH})
                    ).scalars()
                )
                if not ids:
                    break
                await conn.execute(_COUNT_LIFETIME_SCANS, {"ids": ids})
                await conn.execute(_DELETE_BATCH, {"ids": ids})
            total += len(ids)
    finally:
        logger.info("purge des scans : %d scan_events supprimés", total)
    return total


async def _delete_older(engine: AsyncEngine, query: TextClause, cutoff: datetime) -> int:
    """Une suppression par date, dans sa transaction. Renvoie le nombre de lignes supprimées."""
    async with engine.begin() as conn:
        return (await conn.execute(query, {"cutoff": cutoff})).rowcount


async def run_purge(engine: AsyncEngine, now: datetime) -> PurgeReport | None:
    """Une passe : supprime les `scan_events`, les `admin_actions` et les `llm_calls` antérieurs à
    `retention_cutoff(now)`, puis écrit la ligne `system.purge` avec les trois compteurs.
    Renvoie ce qui a été supprimé, ou None sans rien faire si un autre processus tient déjà le
    verrou de la purge.

    Une étape en échec lève l'exception : les étapes précédentes restent supprimées, et la ligne
    `system.purge` n'est pas écrite."""
    cutoff = retention_cutoff(now)
    # Connexion dédiée au verrou de session, hors transaction : elle ne reste pas « idle in
    # transaction » pendant toute la passe.
    async with engine.connect() as lock_conn:
        await lock_conn.execution_options(isolation_level="AUTOCOMMIT")
        locked = (
            await lock_conn.execute(select(func.pg_try_advisory_lock(PURGE_LOCK_KEY)))
        ).scalar_one()
        if not locked:
            logger.info("purge déjà en cours ailleurs, passe sautée")
            return None
        try:
            scans = await _purge_scans(engine, cutoff)
            actions = await _delete_older(engine, _DELETE_ADMIN_ACTIONS, cutoff)
            llm_calls = await _delete_older(engine, _DELETE_LLM_CALLS, cutoff)
            async with engine.begin() as conn:
                await conn.execute(
                    insert(AdminAction).values(
                        admin_user_id=None,
                        action="system.purge",
                        details={
                            "deletedScans": scans,
                            "deletedActions": actions,
                            "deletedLlmCalls": llm_calls,
                        },
                    )
                )
        finally:
            try:
                await lock_conn.execute(select(func.pg_advisory_unlock(PURGE_LOCK_KEY)))
            except BaseException:
                # Connexion fermée plutôt que rendue au pool avec le verrou : la fin de la
                # session Postgres le libère.
                await lock_conn.invalidate()
                raise
    return PurgeReport(scans=scans, admin_actions=actions, llm_calls=llm_calls)


async def purge_forever(
    engine: AsyncEngine,
    now: Callable[[], datetime],
    *,
    first_delay_s: float = PURGE_FIRST_DELAY_S,
    interval_s: float = PURGE_INTERVAL_S,
) -> None:
    """Tâche de fond de l'API : une passe après `first_delay_s`, puis toutes les `interval_s`.
    Une passe en échec est journalisée (type de l'erreur seulement : son texte peut contenir
    l'hôte de la base ou des identifiants) et la suivante réessaie. L'annulation passe."""
    await asyncio.sleep(first_delay_s)
    while True:
        try:
            await run_purge(engine, now())
        except Exception as exc:
            logger.warning(
                "purge des scans en échec (%s), nouvel essai plus tard", type(exc).__name__
            )
        await asyncio.sleep(interval_s)
