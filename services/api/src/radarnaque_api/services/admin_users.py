"""Utilisateurs de l'admin : liste, fiche et actions (plan, rôle, suppression).

Les fonctions d'action contrôlent d'abord (404, 409, 422), puis appellent `record_action` en
dernier : aucune ligne de journal ne décrit une modification refusée. Elles ne valident pas la
transaction : le changement et sa ligne partent ensemble au commit de la route."""

from datetime import datetime
from typing import Literal

from sqlalchemy import and_, func, literal, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import (
    AdminSubscriptionOut,
    AdminUsageOut,
    AdminUserListOut,
    AdminUserOut,
    AdminUserRowOut,
)
from radarnaque_api.errors import ApiError
from radarnaque_api.models import AuthUser, Plan, ScanEvent, Subscription
from radarnaque_api.schemas import QuotaOut
from radarnaque_api.services.accounts import delete_account
from radarnaque_api.services.admin_log import recent_actions, record_action
from radarnaque_api.services.history import scan_history
from radarnaque_api.services.subscriptions import get_active_subscription
from radarnaque_api.services.usage import compute_usage

CARD_SCANS = 20


def _not_found() -> ApiError:
    return ApiError(404, "not_found", "Compte introuvable.")


def escape_like(text: str) -> str:
    """Échappe `\\`, `%` et `_` pour une recherche `LIKE … ESCAPE '\\'` : ce sont des caractères,
    pas des jokers."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def _lock_user(session: AsyncSession, user_id: str) -> AuthUser:
    """Le compte, sous verrou (`FOR UPDATE`) et relu en base ; 404 s'il n'existe pas."""
    user = (
        await session.execute(
            select(AuthUser)
            .where(AuthUser.id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if user is None:
        raise _not_found()
    return user


async def list_users(
    session: AsyncSession,
    *,
    q: str | None,
    role: str | None,
    plan: str | None,
    before: str | None,
    limit: int,
    now: datetime,
) -> AdminUserListOut:
    """Au plus `limit` comptes, du plus récent au plus ancien (égalité : identifiant décroissant).
    `before` est l'identifiant du dernier compte de la page précédente ; `plan` est un code ou
    `none` (aucun abonnement actif)."""
    last_scan = (
        select(func.max(ScanEvent.created_at))
        .where(ScanEvent.user_id == AuthUser.id)
        .correlate(AuthUser)
        .scalar_subquery()
    )
    query = (
        select(AuthUser, Subscription, last_scan)
        .outerjoin(
            Subscription,
            and_(Subscription.user_id == AuthUser.id, Subscription.status == "active"),
        )
        .order_by(AuthUser.created_at.desc(), AuthUser.id.desc())
        .limit(limit + 1)
    )
    if q is not None:
        query = query.where(AuthUser.email.ilike(f"%{escape_like(q)}%", escape="\\"))
    if role is not None:
        query = query.where(AuthUser.role == role)
    if plan == "none":
        query = query.where(Subscription.id.is_(None))
    elif plan is not None:
        query = query.where(Subscription.plan == plan)
    if before is not None:
        cursor = (
            await session.execute(select(AuthUser.created_at).where(AuthUser.id == before))
        ).scalar_one_or_none()
        if cursor is None:
            raise _not_found()
        query = query.where(
            tuple_(AuthUser.created_at, AuthUser.id) < tuple_(literal(cursor), literal(before))
        )
    rows = (await session.execute(query)).all()

    items: list[AdminUserRowOut] = []
    for user, sub, last_scan_at in rows[:limit]:
        used = remaining = None
        if sub is not None:
            full = (await compute_usage(session, sub, now)).per_kind.get("full")
            if full is not None:
                used, remaining = full.used, full.remaining
        items.append(
            AdminUserRowOut(
                id=user.id,
                email=user.email,
                role=user.role,  # type: ignore[arg-type]
                plan=None if sub is None else sub.plan,
                used=used,
                remaining=remaining,
                created_at=user.created_at,
                last_scan_at=last_scan_at,
            )
        )
    next_before = items[-1].id if len(rows) > limit else None
    return AdminUserListOut(items=items, next_before=next_before)


def _subscription_out(sub: Subscription) -> AdminSubscriptionOut:
    return AdminSubscriptionOut(
        id=sub.id,
        plan=sub.plan,
        status=sub.status,
        provider=sub.provider,
        period_start=sub.period_start,
        period_end=sub.period_end,
    )


async def build_user_card(session: AsyncSession, user_id: str, now: datetime) -> AdminUserOut:
    """Fiche d'un compte ; 404 s'il n'existe pas. La consommation est celle de `GET /api/me`."""
    user = (
        await session.execute(
            select(AuthUser).where(AuthUser.id == user_id).execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if user is None:
        raise _not_found()
    subscriptions = (
        await session.scalars(
            select(Subscription)
            .where(Subscription.user_id == user_id)
            .order_by(Subscription.id.desc())
            .execution_options(populate_existing=True)
        )
    ).all()
    active = next((s for s in subscriptions if s.status == "active"), None)
    usage = None
    if active is not None:
        summary = await compute_usage(session, active, now)
        usage = AdminUsageOut(
            period_start=summary.period_start,
            quotas=[
                QuotaOut(scan_kind=kind, limit=q.limit, used=q.used, remaining=q.remaining)
                for kind, q in summary.per_kind.items()
            ],
            total_cap=(
                None
                if summary.total is None
                else QuotaOut(
                    scan_kind=None,
                    limit=summary.total.limit,
                    used=summary.total.used,
                    remaining=summary.total.remaining,
                )
            ),
            purged_scans=active.purged_scans,
        )
    return AdminUserOut(
        id=user.id,
        email=user.email,
        email_verified=user.email_verified,
        created_at=user.created_at,
        role=user.role,  # type: ignore[arg-type]
        subscription=None if active is None else _subscription_out(active),
        usage=usage,
        subscriptions=[_subscription_out(s) for s in subscriptions],
        scans=(await scan_history(session, user_id, limit=CARD_SCANS, before=None)).items,
        actions=await recent_actions(session, target_user_id=user_id),
    )


async def assign_plan(session: AsyncSession, *, admin_id: str, user_id: str, plan: str) -> None:
    """Termine l'abonnement actif (`expired`, fin = maintenant) et en crée un `active` du plan
    choisi, `manual`, qui commence maintenant. Le même plan est accepté (nouvelle période). Un
    abonnement actif de Stripe se gère dans Stripe : 409."""
    await _lock_user(session, user_id)  # sérialise deux attributions, et la suppression du compte
    if await session.get(Plan, plan) is None:
        raise ApiError(422, "invalid_value", "Plan inconnu.", {"field": "plan"})
    active = await get_active_subscription(session, user_id)
    if active is not None and active.provider == "stripe":
        raise ApiError(409, "conflict", "L'abonnement actif vient de Stripe : à gérer dans Stripe.")
    previous = None if active is None else active.plan
    if active is not None:
        active.status = "expired"
        active.period_end = func.now()
        await session.flush()  # l'index unique des abonnements actifs : l'ancien d'abord
    session.add(
        Subscription(
            user_id=user_id,
            plan=plan,
            status="active",
            provider="manual",
            period_start=func.now(),
        )
    )
    await session.flush()
    record_action(
        session,
        admin_id=admin_id,
        action="user.plan_set",
        target_user_id=user_id,
        details={"from": previous, "to": plan},
    )


async def set_role(
    session: AsyncSession, *, admin_id: str, user_id: str, role: Literal["admin", "user"]
) -> None:
    """Nomme ou retire un admin. Pas sur soi-même (409). Rôle inchangé : rien n'est écrit. Le
    retrait d'un admin verrouille les admins comme la commande `admin:revoke` du service auth
    (même requête, même ordre), puis refuse (409) de retirer le dernier."""
    if user_id == admin_id:
        raise ApiError(409, "conflict", "Vous ne pouvez pas modifier votre propre rôle.")
    admin_ids: list[str] = []
    if role == "user":
        admin_ids = list(
            await session.scalars(
                select(AuthUser.id)
                .where(AuthUser.role == "admin")
                .order_by(AuthUser.id)
                .with_for_update()
            )
        )
    user = await _lock_user(session, user_id)
    if user.role == role:
        return
    if user.role == "admin" and not any(other != user.id for other in admin_ids):
        raise ApiError(409, "conflict", "Impossible de retirer le dernier admin.")
    previous = user.role
    user.role = role
    await session.flush()
    record_action(
        session,
        admin_id=admin_id,
        action="user.role_set",
        target_user_id=user_id,
        details={"from": previous, "to": role},
    )


async def delete_user(session: AsyncSession, *, admin_id: str, user_id: str) -> None:
    """Supprime le compte comme `DELETE /api/me` (cascade). La ligne du journal garde
    l'identifiant, pas l'email."""
    if user_id == admin_id:
        raise ApiError(409, "conflict", "Vous ne pouvez pas supprimer votre propre compte.")
    await _lock_user(session, user_id)  # 404 ; le compte ne peut plus disparaître sous nos pieds
    record_action(session, admin_id=admin_id, action="user.deleted", target_user_id=user_id)
    await delete_account(session, user_id)
