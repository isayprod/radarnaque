from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.auth.privileges import Privileges
from radarnaque_api.images import MAX_IMAGES
from radarnaque_api.models import Plan, PlanQuota, ScanEvent, ScanFailure, Subscription
from radarnaque_api.services.periods import current_period_start


@dataclass(frozen=True)
class KindUsage:
    limit: int
    used: int
    remaining: int


@dataclass(frozen=True)
class UsageSummary:
    period_start: datetime
    per_kind: dict[str, KindUsage]
    total: KindUsage | None


async def compute_usage(session: AsyncSession, sub: Subscription, now: datetime) -> UsageSummary:
    """Consommation de l'abonnement sur sa période. Les scans en échec ne comptent pas."""
    plan = await session.get(Plan, sub.plan)
    if plan is None:  # impossible : clé étrangère
        raise LookupError(f"plan inconnu : {sub.plan}")
    period_start = (
        sub.period_start
        if plan.quota_period == "lifetime"
        else current_period_start(sub.period_start, now)
    )
    limits = dict(
        (
            await session.execute(
                select(PlanQuota.scan_kind, PlanQuota.quota).where(PlanQuota.plan == sub.plan)
            )
        ).all()
    )
    used_by_kind = dict(
        (
            await session.execute(
                select(ScanEvent.scan_kind, func.count())
                .outerjoin(ScanFailure, ScanFailure.scan_event_id == ScanEvent.id)
                .where(
                    ScanEvent.user_id == sub.user_id,
                    ScanEvent.created_at >= period_start,
                    ScanFailure.scan_event_id.is_(None),
                )
                .group_by(ScanEvent.scan_kind)
            )
        ).all()
    )
    total_used = sum(used_by_kind.values())
    cap = plan.total_scan_cap
    cap_remaining = None if cap is None else max(0, cap - total_used)

    per_kind: dict[str, KindUsage] = {}
    for kind, limit in sorted(limits.items()):
        used = used_by_kind.get(kind, 0)
        remaining = max(0, limit - used)
        if cap_remaining is not None:
            remaining = min(remaining, cap_remaining)
        per_kind[kind] = KindUsage(limit=limit, used=used, remaining=remaining)
    total = (
        None if cap is None else KindUsage(limit=cap, used=total_used, remaining=cap_remaining or 0)
    )
    return UsageSummary(period_start=period_start, per_kind=per_kind, total=total)


async def plan_max_images(
    session: AsyncSession, plan_code: str | None, privileges: Privileges
) -> int:
    """Nombre maximal de photos analysées par scan : `MAX_IMAGES` pour l'admin, celui du plan
    de substitution pour le superuser hors production, celui du plan du compte sinon ; 0 sans
    plan."""
    if privileges.unlimited and privileges.plan_override is None:
        return MAX_IMAGES
    code = privileges.plan_override or plan_code
    if code is None:
        return 0
    plan = await session.get(Plan, code)
    return 0 if plan is None else plan.max_images
