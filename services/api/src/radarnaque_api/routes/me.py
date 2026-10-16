from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.auth.deps import current_user
from radarnaque_api.db import get_session
from radarnaque_api.models import AuthUser, Feature, PlanFeature
from radarnaque_api.schemas import MeOut, QuotaOut
from radarnaque_api.services.subscriptions import bootstrap_trial, get_active_subscription
from radarnaque_api.services.usage import compute_usage

router = APIRouter()


@router.get("/api/me", response_model=MeOut)
async def me(
    user: Annotated[AuthUser, Depends(current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> MeOut:
    sub = await get_active_subscription(session, user.id)

    if user.role == "admin":
        features = (await session.execute(select(Feature.code).order_by(Feature.code))).scalars()
        return MeOut(
            user_id=user.id,
            email=user.email,
            role="admin",
            plan=sub.plan if sub else None,
            features=list(features),
            unlimited=True,
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
            period_start=None,
            quotas=[],
            total_cap=None,
        )

    usage = await compute_usage(session, sub, datetime.now(UTC))
    features = (
        await session.execute(
            select(PlanFeature.feature)
            .where(PlanFeature.plan == sub.plan)
            .order_by(PlanFeature.feature)
        )
    ).scalars()
    return MeOut(
        user_id=user.id,
        email=user.email,
        role=role,
        plan=sub.plan,
        features=list(features),
        unlimited=False,
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
