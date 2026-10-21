import logging
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import AdminActionOut
from radarnaque_api.models.admin import AdminAction
from radarnaque_api.models.auth_user import AuthUser

logger = logging.getLogger("radarnaque.admin")

# `system.purge` n'y figure pas : la purge écrit elle-même ses lignes (services/purge.py).
AdminActionCode = Literal[
    "user.plan_set",
    "user.role_set",
    "user.deleted",
    "ai.model_added",
    "ai.model_activated",
    "ai.prompt_created",
    "ai.prompt_activated",
    "ai.settings_set",
    "offer.price_set",
    "offer.quota_set",
    "offer.feature_set",
    "offer.max_images_set",
    "offer.total_cap_set",
]


def record_action(
    session: AsyncSession,
    *,
    admin_id: str,
    action: AdminActionCode,
    target_user_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """Ajoute la ligne du journal à la transaction en cours (sans commit : elle est validée ou
    annulée avec le changement qu'elle décrit). `details` : `{from, to}`, jamais d'email ni le
    texte d'un prompt. Le log ne porte que le code de l'action."""
    session.add(
        AdminAction(
            admin_user_id=admin_id,
            action=action,
            target_user_id=target_user_id,
            details=details or {},
        )
    )
    logger.info("action admin : %s", action)


async def recent_actions(
    session: AsyncSession,
    *,
    prefix: str | None = None,
    target_user_id: str | None = None,
    limit: int = 20,
) -> list[AdminActionOut]:
    """Dernières actions, de la plus récente à la plus ancienne. Les lignes `system.purge` ne
    sont jamais rendues. `prefix` est un préfixe littéral (`ai.`), pas un motif LIKE."""
    query = (
        select(AdminAction, AuthUser.email)
        .outerjoin(AuthUser, AuthUser.id == AdminAction.admin_user_id)
        .where(AdminAction.action != "system.purge")
        .order_by(AdminAction.created_at.desc(), AdminAction.id.desc())
        .limit(limit)
    )
    if prefix is not None:
        query = query.where(AdminAction.action.startswith(prefix, autoescape=True))
    if target_user_id is not None:
        query = query.where(AdminAction.target_user_id == target_user_id)
    rows = await session.execute(query)
    return [
        AdminActionOut(
            id=a.id,
            action=a.action,
            admin_user_id=a.admin_user_id,
            admin_email=email,
            target_user_id=a.target_user_id,
            details=a.details,
            created_at=a.created_at,
        )
        for a, email in rows.all()
    ]
