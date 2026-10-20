"""Purge à 12 mois de l'historique des scans (`scan_events`, avec leurs `scan_results` et
`scan_failures` par cascade). Les analyses et les snapshots d'annonces restent."""

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine

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
            and not exists (select 1 from app.scan_failures f where f.scan_event_id = e.id)
        group by sub.id
    ) c
    where s.id = c.subscription_id
    """
)
_DELETE_BATCH = text("delete from app.scan_events where id = any(:ids)")


def retention_cutoff(now: datetime) -> datetime:
    """`now` moins `SCAN_RETENTION_MONTHS` mois calendaires : même jour et même heure, le jour
    plafonné à la fin du mois (29 février → 28 février)."""
    return add_months(now, -SCAN_RETENTION_MONTHS)


async def purge_old_scans(engine: AsyncEngine, now: datetime) -> int | None:
    """Une passe : supprime les `scan_events` antérieurs à `retention_cutoff(now)`, par lots de
    `PURGE_BATCH`, chacun dans sa transaction. Renvoie le nombre d'événements supprimés, ou
    None sans rien faire si un autre processus tient déjà le verrou de la purge.

    Un lot en échec lève l'exception : les lots précédents restent supprimés."""
    cutoff = retention_cutoff(now)
    total = 0
    # Connexion dédiée au verrou de session, hors transaction : elle ne reste pas « idle in
    # transaction » pendant toute la passe.
    async with engine.connect() as lock_conn:
        await lock_conn.execution_options(isolation_level="AUTOCOMMIT")
        locked = (
            await lock_conn.execute(select(func.pg_try_advisory_lock(PURGE_LOCK_KEY)))
        ).scalar_one()
        if not locked:
            return None
        try:
            while True:
                async with engine.begin() as conn:
                    ids = list(
                        (
                            await conn.execute(
                                _SELECT_BATCH, {"cutoff": cutoff, "batch": PURGE_BATCH}
                            )
                        ).scalars()
                    )
                    if not ids:
                        break
                    await conn.execute(_COUNT_LIFETIME_SCANS, {"ids": ids})
                    await conn.execute(_DELETE_BATCH, {"ids": ids})
                total += len(ids)
        finally:
            logger.info("purge des scans : %d scan_events supprimés", total)
            try:
                await lock_conn.execute(select(func.pg_advisory_unlock(PURGE_LOCK_KEY)))
            except BaseException:
                # Connexion fermée plutôt que rendue au pool avec le verrou : la fin de la
                # session Postgres le libère.
                await lock_conn.invalidate()
                raise
    return total


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
            await purge_old_scans(engine, now())
        except Exception as exc:
            logger.warning(
                "purge des scans en échec (%s), nouvel essai plus tard", type(exc).__name__
            )
        await asyncio.sleep(interval_s)
