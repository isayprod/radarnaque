"""Analyses de l'admin, en lecture seule : liste filtrée et paginée, et détail d'une analyse.

Aucune donnée de compte n'est lue : une analyse n'est pas une donnée personnelle, et elle n'est
jamais reliée à un utilisateur (pas de jointure avec `scan_events.user_id`). Le coût total est la
somme des `llm_calls` de l'analyse (un rafraîchissement sur place écrase le coût de l'analyse
elle-même) ; « servie » compte ses `scan_results`. La date d'une analyse est celle de son dernier
appel au modèle (`analyses.created_at`)."""

from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import ColumnElement, Select, func, literal, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import (
    ActiveModelOut,
    AnalysisCallOut,
    AnalysisDetailOut,
    AnalysisDetailResultOut,
    AnalysisListingOut,
    AnalysisListOut,
    AnalysisReasonRowOut,
    AnalysisRowOut,
    AnalysisSearchOut,
    AnalysisTechnicalOut,
    AnalysisTextOut,
    AnalysisUsageOut,
)
from radarnaque_api.errors import ApiError
from radarnaque_api.models import (
    Analysis,
    AnalysisReason,
    AnalysisReasonText,
    AnalysisText,
    AnalysisWebSearch,
    Listing,
    ListingSnapshot,
    LlmCall,
    Model,
    PromptVersion,
    ScanEvent,
    ScanResult,
    Site,
    SnapshotImage,
)
from radarnaque_api.schemas import RiskLevel
from radarnaque_api.services.admin_users import escape_like
from radarnaque_api.services.dashboard import BRUSSELS, MICROS
from radarnaque_api.services.scans import risk_level

# Bornes de score de chaque niveau (mêmes seuils que `risk_level`) : [min, max[.
_LEVEL_BOUNDS: dict[RiskLevel, tuple[int, int]] = {
    "low": (0, 30),
    "medium": (30, 60),
    "high": (60, 101),
}


def _not_found() -> ApiError:
    return ApiError(404, "not_found", "Analyse introuvable.")


def _day_start(day: date) -> datetime:
    """Minuit à Bruxelles du jour civil `day`, en UTC."""
    return datetime.combine(day, time.min, tzinfo=BRUSSELS).astimezone(UTC)


def _cost(micros: int) -> float:
    return micros / MICROS


def _base_query(*columns) -> Select:
    """Analyse, snapshot, annonce, site, modèle et version du prompt."""
    return (
        select(*columns)
        .select_from(Analysis)
        .join(ListingSnapshot, ListingSnapshot.id == Analysis.snapshot_id)
        .join(Listing, Listing.id == ListingSnapshot.listing_id)
        .join(Site, Site.id == Listing.site_id)
        .join(Model, Model.id == Analysis.model_id)
        .join(PromptVersion, PromptVersion.id == Analysis.prompt_version_id)
    )


def _searches_exist() -> ColumnElement[bool]:
    return select(literal(1)).where(AnalysisWebSearch.analysis_id == Analysis.id).exists()


async def list_analyses(
    session: AsyncSession,
    *,
    site: str | None,
    level: RiskLevel | None,
    model_id: int | None,
    prompt_version_id: int | None,
    day_from: date | None,
    day_to: date | None,
    with_search: bool | None,
    partial: bool | None,
    q: str | None,
    before: int | None,
    limit: int,
) -> AnalysisListOut:
    """Au plus `limit` analyses, de la plus récente à la plus ancienne (égalité : identifiant
    décroissant). `before` est l'identifiant de la dernière analyse de la page précédente, relue
    pour sa date. `day_from` et `day_to` sont des jours civils de Bruxelles, bornes incluses ;
    `day_from > day_to` donne 422."""
    if day_from is not None and day_to is not None and day_from > day_to:
        raise ApiError(
            422,
            "invalid_value",
            "La date de début doit précéder la date de fin.",
            {"field": "from"},
        )
    calls = select(func.count()).where(LlmCall.analysis_id == Analysis.id).scalar_subquery()
    cost = (
        select(func.coalesce(func.sum(LlmCall.cost_usd_micros), 0))
        .where(LlmCall.analysis_id == Analysis.id)
        .scalar_subquery()
    )
    served = select(func.count()).where(ScanResult.analysis_id == Analysis.id).scalar_subquery()
    searches = (
        select(func.count()).where(AnalysisWebSearch.analysis_id == Analysis.id).scalar_subquery()
    )
    query = (
        _base_query(
            Analysis,
            Site.domain,
            ListingSnapshot.title,
            Model.provider,
            Model.slug,
            PromptVersion.version,
            searches,
            cost,
            calls,
            served,
        )
        .order_by(Analysis.created_at.desc(), Analysis.id.desc())
        .limit(limit + 1)
    )
    if site is not None:
        query = query.where(Site.domain == site)
    if level is not None:
        low, high = _LEVEL_BOUNDS[level]
        query = query.where(Analysis.score >= low, Analysis.score < high)
    if model_id is not None:
        query = query.where(Analysis.model_id == model_id)
    if prompt_version_id is not None:
        query = query.where(Analysis.prompt_version_id == prompt_version_id)
    if day_from is not None:
        query = query.where(Analysis.created_at >= _day_start(day_from))
    if day_to is not None:
        query = query.where(Analysis.created_at < _day_start(day_to + timedelta(days=1)))
    if with_search is not None:
        query = query.where(_searches_exist() if with_search else ~_searches_exist())
    if partial is not None:
        query = query.where(Analysis.partial == partial)
    if q is not None:
        query = query.where(ListingSnapshot.title.ilike(f"%{escape_like(q)}%", escape="\\"))
    if before is not None:
        cursor = (
            await session.execute(select(Analysis.created_at).where(Analysis.id == before))
        ).scalar_one_or_none()
        if cursor is None:
            raise _not_found()
        query = query.where(
            tuple_(Analysis.created_at, Analysis.id) < tuple_(literal(cursor), literal(before))
        )
    rows = (await session.execute(query)).all()

    items = [
        AnalysisRowOut(
            id=analysis.id,
            created_at=analysis.created_at,
            site=domain,
            title=title,
            score=analysis.score,
            level=risk_level(analysis.score),
            professional=analysis.professional,
            model_id=analysis.model_id,
            model=ActiveModelOut(provider=provider, slug=slug),
            prompt_version_id=analysis.prompt_version_id,
            prompt_version=version,
            images_analyzed=analysis.images_analyzed,
            web_searches=web_searches,
            cost_usd=_cost(int(micros)),
            llm_calls=call_count,
            served=served_count,
            partial=analysis.partial,
        )
        for (
            analysis,
            domain,
            title,
            provider,
            slug,
            version,
            web_searches,
            micros,
            call_count,
            served_count,
        ) in rows[:limit]
    ]
    return AnalysisListOut(items=items, next_before=items[-1].id if len(rows) > limit else None)


async def build_analysis_detail(session: AsyncSession, analysis_id: int) -> AnalysisDetailOut:
    """Détail d'une analyse ; 404 si elle n'existe pas. Ne dit jamais qui l'a demandée."""
    row = (
        await session.execute(
            _base_query(
                Analysis,
                Listing,
                ListingSnapshot,
                Site.domain,
                Model.provider,
                Model.slug,
                PromptVersion.version,
            ).where(Analysis.id == analysis_id)
        )
    ).one_or_none()
    if row is None:
        raise _not_found()
    analysis, listing, snapshot, domain, provider, slug, version = row

    images = (
        await session.scalars(
            select(SnapshotImage.url)
            .where(SnapshotImage.snapshot_id == snapshot.id)
            .order_by(SnapshotImage.position)
        )
    ).all()
    texts = {
        text.locale: AnalysisTextOut(summary=text.summary, advice=text.advice)
        for text in await session.scalars(
            select(AnalysisText).where(AnalysisText.analysis_id == analysis_id)
        )
    }
    reason_rows = await session.execute(
        select(
            AnalysisReason.id,
            AnalysisReason.position,
            AnalysisReason.severity,
            AnalysisReasonText.locale,
            AnalysisReasonText.text,
        )
        .join(AnalysisReasonText, AnalysisReasonText.reason_id == AnalysisReason.id)
        .where(AnalysisReason.analysis_id == analysis_id)
        .order_by(AnalysisReason.position)
    )
    reasons: dict[int, dict] = {}
    for reason_id, position, severity, locale, label in reason_rows:
        reasons.setdefault(reason_id, {"position": position, "severity": severity})[locale] = label
    searches = (
        await session.execute(
            select(AnalysisWebSearch.position, AnalysisWebSearch.query, AnalysisWebSearch.aspect)
            .where(AnalysisWebSearch.analysis_id == analysis_id)
            .order_by(AnalysisWebSearch.position)
        )
    ).all()
    calls = (
        await session.scalars(
            select(LlmCall)
            .where(LlmCall.analysis_id == analysis_id)
            .order_by(LlmCall.created_at.desc(), LlmCall.id.desc())
        )
    ).all()
    served, first_served, last_served = (
        await session.execute(
            select(func.count(), func.min(ScanEvent.created_at), func.max(ScanEvent.created_at))
            .select_from(ScanResult)
            .join(ScanEvent, ScanEvent.id == ScanResult.scan_event_id)
            .where(ScanResult.analysis_id == analysis_id)
        )
    ).one()

    return AnalysisDetailOut(
        listing=AnalysisListingOut(
            site=domain,
            external_id=listing.external_id,
            url=listing.url,
            title=snapshot.title,
            description=snapshot.description,
            price_cents=snapshot.price_cents,
            currency=snapshot.currency,
            images=list(images),
            captured_at=snapshot.captured_at,
        ),
        result=AnalysisDetailResultOut(
            score=analysis.score,
            level=risk_level(analysis.score),
            professional=analysis.professional,
            texts=texts,  # type: ignore[arg-type]  # clés `fr` et `nl` (référentiel des langues)
            reasons=[AnalysisReasonRowOut(**reason) for reason in reasons.values()],
        ),
        searches=[
            AnalysisSearchOut(position=position, query=query, aspect=aspect)
            for position, query, aspect in searches
        ],
        technical=AnalysisTechnicalOut(
            model=ActiveModelOut(provider=provider, slug=slug),
            prompt_version_id=analysis.prompt_version_id,
            prompt_version=version,
            tokens_in=analysis.tokens_in,
            tokens_out=analysis.tokens_out,
            cost_usd=_cost(analysis.cost_usd_micros),
            images_analyzed=analysis.images_analyzed,
            input_hash=analysis.input_hash,
            created_at=analysis.created_at,
            calls=[
                AnalysisCallOut(
                    created_at=call.created_at,
                    tokens_in=call.tokens_in,
                    tokens_out=call.tokens_out,
                    cost_usd=_cost(call.cost_usd_micros),
                    images_analyzed=call.images_analyzed,
                    web_searches=call.web_searches,
                )
                for call in calls
            ],
        ),
        usage=AnalysisUsageOut(
            served=served, first_served_at=first_served, last_served_at=last_served
        ),
    )
