import logging
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.auth.deps import current_user
from radarnaque_api.auth.privileges import privileges_of
from radarnaque_api.db import get_session
from radarnaque_api.errors import ApiError
from radarnaque_api.models import AuthUser, Feature
from radarnaque_api.schemas import MeOut, QuotaOut
from radarnaque_api.services.accounts import delete_account
from radarnaque_api.services.subscriptions import bootstrap_trial, get_active_subscription
from radarnaque_api.services.usage import compute_usage, plan_features, plan_max_images

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/api/me", response_model=MeOut)
async def me(
    request: Request,
    user: Annotated[AuthUser, Depends(current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> MeOut:
    privileges = privileges_of(user, request.app.state.settings)
    sub = await get_active_subscription(session, user.id)

    # Compte illimité : admin, ou superuser hors production (seul à avoir le debug). En
    # production, le superuser n'a aucun privilège et suit le chemin ordinaire, en `user`.
    # Le superuser se voit en Premium (`plan_override`) : plan, fonctionnalités et photos du
    # plan Premium, lus en base ; l'admin garde toutes les fonctionnalités. Ni l'un ni l'autre
    # n'a de quota affiché.
    if privileges.unlimited:
        if privileges.plan_override is not None:
            features = await plan_features(session, privileges.plan_override)
        else:
            features = list(
                (await session.execute(select(Feature.code).order_by(Feature.code))).scalars()
            )
        return MeOut(
            user_id=user.id,
            email=user.email,
            role="superuser" if privileges.debug else "admin",
            plan=privileges.plan_override or (sub.plan if sub else None),
            features=features,
            unlimited=True,
            max_images=await plan_max_images(session, sub.plan if sub else None, privileges),
            period_start=None,
            quotas=[],
            total_cap=None,
        )

    if sub is None:
        # Aucun abonnement du tout (hook d'inscription raté) : on crée l'essai ici. Sans effet
        # si l'utilisateur a déjà eu un abonnement (essai terminé, résilié…).
        if await bootstrap_trial(session, user.id):
            await session.commit()
        sub = await get_active_subscription(session, user.id)

    role: Literal["user", "admin"] = "user"
    if sub is None:
        return MeOut(
            user_id=user.id,
            email=user.email,
            role=role,
            plan=None,
            features=[],
            unlimited=False,
            max_images=0,
            period_start=None,
            quotas=[],
            total_cap=None,
        )

    usage = await compute_usage(session, sub, datetime.now(UTC))
    return MeOut(
        user_id=user.id,
        email=user.email,
        role=role,
        plan=sub.plan,
        features=await plan_features(session, sub.plan),
        unlimited=False,
        max_images=await plan_max_images(session, sub.plan, privileges),
        period_start=usage.period_start,
        quotas=[
            QuotaOut(scan_kind=kind, limit=q.limit, used=q.used, remaining=q.remaining)
            for kind, q in usage.per_kind.items()
        ],
        total_cap=(
            None
            if usage.total is None
            else QuotaOut(
                scan_kind=None,
                limit=usage.total.limit,
                used=usage.total.used,
                remaining=usage.total.remaining,
            )
        ),
    )


@router.delete("/api/me", status_code=204)
async def delete_me(
    user: Annotated[AuthUser, Depends(current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Supprime le compte de l'utilisateur et ses données personnelles (cascade en base)."""
    if not await delete_account(session, user.id):
        raise ApiError(401, "unauthenticated", "Authentification requise.")
    await session.commit()
    logger.info("compte supprimé")
    return Response(status_code=204)
