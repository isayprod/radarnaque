"""Historique des scans d'un utilisateur (`GET /api/scans/history`).

Tout se calcule (3NF) : l'échec, « servi depuis le cache » (règle R8) et le niveau de risque.
Un événement n'est relié à un snapshot que par son résultat : `scan_results` → `analyses` pour
un `analyze`, `identification_results` → `identifications` pour un `identify` (spec §6). Un scan
sans résultat n'a donc ni site ni titre ; un `identify` n'a ni note ni niveau de risque."""

from sqlalchemy import case, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.models import (
    Analysis,
    Identification,
    IdentificationResult,
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
    failed = (
        has_failure
        & ScanResult.scan_event_id.is_(None)
        & IdentificationResult.scan_event_id.is_(None)
    )
    # Un `identify` est servi par le cache si son identification date d'avant lui.
    from_cache = case(
        (
            IdentificationResult.scan_event_id.is_not(None),
            Identification.created_at < ScanEvent.created_at,
        ),
        else_=from_cache_expr(ScanResult),
    )
    query = (
        select(
            ScanEvent.id,
            ScanEvent.created_at,
            ScanEvent.scan_kind,
            ScanEvent.trigger,
            ScanEvent.purpose,
            Site.domain,
            ListingSnapshot.title,
            Analysis.score,
            from_cache,
            failed,
        )
        .outerjoin(ScanResult, ScanResult.scan_event_id == ScanEvent.id)
        .outerjoin(Analysis, Analysis.id == ScanResult.analysis_id)
        .outerjoin(IdentificationResult, IdentificationResult.scan_event_id == ScanEvent.id)
        .outerjoin(Identification, Identification.id == IdentificationResult.identification_id)
        .outerjoin(
            ListingSnapshot,
            ListingSnapshot.id == func.coalesce(Analysis.snapshot_id, Identification.snapshot_id),
        )
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
            purpose=purpose,
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
            purpose,
            site,
            title,
            score,
            from_cache,
            is_failed,
        ) in rows[:limit]
    ]
    next_before = items[-1].scan_event_id if len(rows) > limit else None
    return ScanHistoryOut(items=items, next_before=next_before)
