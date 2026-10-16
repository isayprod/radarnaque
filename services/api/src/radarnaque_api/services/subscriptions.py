from sqlalchemy import func, literal, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.models import Subscription

TRIAL_PLAN = "trial"


async def get_active_subscription(session: AsyncSession, user_id: str) -> Subscription | None:
    return (
        await session.execute(
            select(Subscription).where(
                Subscription.user_id == user_id, Subscription.status == "active"
            )
        )
    ).scalar_one_or_none()


async def bootstrap_trial(session: AsyncSession, user_id: str) -> bool:
    """Crée l'essai si l'utilisateur n'a encore aucun abonnement (quel que soit son statut).

    Un seul INSERT … SELECT … WHERE NOT EXISTS, avec ON CONFLICT DO NOTHING sur l'index partiel
    des abonnements actifs : des appels concurrents ne produisent ni doublon ni erreur.
    Ne valide pas la transaction. Renvoie True si une ligne a été créée."""
    already = select(literal(1)).where(Subscription.user_id == user_id).exists()
    candidate = select(
        literal(user_id),
        literal(TRIAL_PLAN),
        literal("active"),
        literal("manual"),
        func.now(),
    ).where(~already)
    stmt = (
        insert(Subscription)
        .from_select(["user_id", "plan", "status", "provider", "period_start"], candidate)
        .on_conflict_do_nothing()
        .returning(Subscription.id)
    )
    return (await session.execute(stmt)).scalar_one_or_none() is not None
