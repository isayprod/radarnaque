"""Historique des scans d'un utilisateur (`GET /api/scans/history`).

Tout se calcule (3NF) : l'échec, « servi depuis le cache » (règle R8) et le niveau de risque.
Un événement n'est relié à un snapshot que par `scan_results` → `analyses` : un scan sans
résultat n'a donc ni site ni titre."""

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.models import (
    Analysis,
    Listing,
    ListingSnapshot,
    ScanEvent,
    ScanFailure,
    ScanResult,
    Site,
)
from radarnaque_api.schemas import ScanHistoryItemOut, ScanHistoryOut
from radarnaque_api.services.scans import from_cache_expr, risk_level


async def scan_history(
    session: AsyncSession, user_id: str, *, limit: int, before: int | None
) -> ScanHistoryOut:
    """Au plus `limit` scans de `user_id`, du plus récent au plus ancien, d'identifiant
    strictement inférieur à `before` s'il est donné. Une ligne de plus est lue pour savoir s'il
    reste une page."""
    has_failure = exists().where(ScanFailure.scan_event_id == ScanEvent.id)
    # Un scan peut avoir un échec et un résultat (règle R13) : seul le résultat compte.
    failed = has_failure & ScanResult.scan_event_id.is_(None)
    query = (
        select(
            ScanEvent.id,
            ScanEvent.created_at,
            ScanEvent.scan_kind,
            ScanEvent.trigger,
            Site.domain,
            ListingSnapshot.title,
            Analysis.score,
            from_cache_expr(ScanResult),
            failed,
        )
        .outerjoin(ScanResult, ScanResult.scan_event_id == ScanEvent.id)
        .outerjoin(Analysis, Analysis.id == ScanResult.analysis_id)
        .outerjoin(ListingSnapshot, ListingSnapshot.id == Analysis.snapshot_id)
        .outerjoin(Listing, Listing.id == ListingSnapshot.listing_id)
        .outerjoin(Site, Site.id == Listing.site_id)
        .where(ScanEvent.user_id == user_id)
        .order_by(ScanEvent.id.desc())
        .limit(limit + 1)
    )
    if before is not None:
        query = query.where(ScanEvent.id < before)
    rows = (await session.execute(query)).all()
    items = [
        ScanHistoryItemOut(
            scan_event_id=event_id,
            created_at=created_at,
            scan_kind=scan_kind,
            trigger=trigger,
            site=site,
            title=title,
            score=score,
            level=None if score is None else risk_level(score),
            from_cache=from_cache,
            failed=is_failed,
        )
        for (
            event_id,
            created_at,
            scan_kind,
            trigger,
            site,
            title,
            score,
            from_cache,
            is_failed,
        ) in rows[:limit]
    ]
    next_before = items[-1].scan_event_id if len(rows) > limit else None
    return ScanHistoryOut(items=items, next_before=next_before)
