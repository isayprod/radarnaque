"""Tableau de bord de l'admin : activité, coûts, cache, échecs, abonnés et santé du service.

Les jours sont des jours civils de Bruxelles : les bornes des périodes sont calculées en Python
(`BRUSSELS`, puis converties en UTC) et le jour d'un instant en SQL
(`(created_at AT TIME ZONE 'Europe/Brussels')::date`). Un jour de changement d'heure dure 23 h
ou 25 h : les séries sont bâties sur des dates, jamais sur des multiples de 24 h.

Les coûts, les appels et les recherches web viennent de `llm_calls` (une ligne par appel au
modèle), jamais de `analyses`, dont un rafraîchissement écrase le coût et la date. « Servi depuis
le cache » se déduit : scans réussis moins appels. Un échec est un `scan_events` avec
`scan_failures` et sans `scan_results` (règle R13, comme l'historique). Un `identify` (spec §6)
est un scan : réussi s'il a un `identification_results` et aucun `scan_failures`. Aucune donnée
personnelle n'est lue ni renvoyée, seulement des nombres et des codes."""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import Date, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import (
    ActiveModelOut,
    DailyOut,
    DailyPointOut,
    DashboardHealthOut,
    DashboardOut,
    DashboardStatsOut,
    LastPurgeOut,
    MonthCostOut,
    SubscribersOut,
    TopFailureOut,
)
from radarnaque_api.config import Settings
from radarnaque_api.models import (
    AdminAction,
    AuthUser,
    IdentificationResult,
    LlmCall,
    Model,
    ScanEvent,
    ScanFailure,
    ScanKind,
    ScanResult,
    Subscription,
)
from radarnaque_api.search import SearchBackend
from radarnaque_api.services.admin_ai import search_status
from radarnaque_api.services.ai_probes import SearchHealth
from radarnaque_api.services.scans import SCAN_KIND

BRUSSELS = ZoneInfo("Europe/Brussels")
TOP_FAILURES = 3
WEEK_DAYS = 7
# Avant 24 h d'activité dans le mois, une projection n'aurait aucun sens.
PROJECTION_AFTER = timedelta(hours=24)
MICROS = 1_000_000


def _day_start(day: date) -> datetime:
    """Minuit à Bruxelles du jour civil `day`, en UTC."""
    return datetime.combine(day, time.min, tzinfo=BRUSSELS).astimezone(UTC)


def _brussels_day(now: datetime) -> date:
    return now.astimezone(BRUSSELS).date()


def _ratio(numerator: float, denominator: int) -> float | None:
    return None if denominator == 0 else numerator / denominator


# Le jour civil de Bruxelles d'un instant, calculé par Postgres.
_EVENT_DAY = cast(func.timezone("Europe/Brussels", ScanEvent.created_at), Date)
_CALL_DAY = cast(func.timezone("Europe/Brussels", LlmCall.created_at), Date)

# Scan réussi : il a un résultat (une analyse ; ou une identification, sans échec, pour un
# `identify`). Échec : une ligne d'échec et aucune analyse.
_SUCCEEDED = ScanResult.scan_event_id.is_not(None) | (
    IdentificationResult.scan_event_id.is_not(None) & ScanFailure.scan_event_id.is_(None)
)
_FAILED = ScanResult.scan_event_id.is_(None) & ScanFailure.scan_event_id.is_not(None)


def _events_query(*columns):
    return (
        select(*columns)
        .select_from(ScanEvent)
        .outerjoin(ScanResult, ScanResult.scan_event_id == ScanEvent.id)
        .outerjoin(IdentificationResult, IdentificationResult.scan_event_id == ScanEvent.id)
        .outerjoin(ScanFailure, ScanFailure.scan_event_id == ScanEvent.id)
    )


async def _stats(session: AsyncSession, start: datetime, end: datetime) -> DashboardStatsOut:
    """Les cartes de la période `[start, end]`."""
    scans, succeeded, failed = (
        await session.execute(
            _events_query(
                func.count(),
                func.count().filter(_SUCCEEDED),
                func.count().filter(_FAILED),
            ).where(ScanEvent.created_at >= start, ScanEvent.created_at <= end)
        )
    ).one()
    top = (
        await session.execute(
            _events_query(ScanFailure.error_code, func.count().label("n"))
            .where(ScanEvent.created_at >= start, ScanEvent.created_at <= end, _FAILED)
            .group_by(ScanFailure.error_code)
            .order_by(func.count().desc(), ScanFailure.error_code)
            .limit(TOP_FAILURES)
        )
    ).all()
    calls, micros, searches = (
        await session.execute(
            select(
                func.count(),
                func.coalesce(func.sum(LlmCall.cost_usd_micros), 0),
                func.coalesce(func.sum(LlmCall.web_searches), 0),
            ).where(LlmCall.created_at >= start, LlmCall.created_at <= end)
        )
    ).one()
    cost = int(micros) / MICROS
    searches = int(searches)
    from_cache = _ratio(max(0, succeeded - calls), succeeded)
    return DashboardStatsOut(
        scans=scans,
        llm_calls=calls,
        from_cache_pct=None if from_cache is None else from_cache * 100,
        failed_pct=None if scans == 0 else failed / scans * 100,
        top_failures=[TopFailureOut(code=code, count=count) for code, count in top],
        cost_usd=cost,
        avg_cost_usd=_ratio(cost, calls),
        web_searches=searches,
        avg_web_searches=_ratio(searches, calls),
    )


async def _subscribers(session: AsyncSession, start: datetime, end: datetime) -> SubscribersOut:
    per_plan = dict(
        (
            await session.execute(
                select(Subscription.plan, func.count())
                .where(Subscription.status == "active")
                .group_by(Subscription.plan)
            )
        ).all()
    )
    new_accounts = await session.scalar(
        select(func.count()).where(AuthUser.created_at >= start, AuthUser.created_at <= end)
    )
    return SubscribersOut(
        trial=per_plan.get("trial", 0),
        standard=per_plan.get("standard", 0),
        premium=per_plan.get("premium", 0),
        new_accounts_7_days=new_accounts or 0,
    )


async def _month(session: AsyncSession, now: datetime) -> MonthCostOut:
    """Coût du mois civil et projection linéaire : coût × durée du mois / durée écoulée. Les
    durées sont réelles (un mois de changement d'heure compte 1 h de plus ou de moins)."""
    today = _brussels_day(now)
    start = _day_start(today.replace(day=1))
    following = (today.replace(day=1) + timedelta(days=32)).replace(day=1)
    micros = await session.scalar(
        select(func.coalesce(func.sum(LlmCall.cost_usd_micros), 0)).where(
            LlmCall.created_at >= start, LlmCall.created_at <= now
        )
    )
    cost = int(micros or 0) / MICROS
    elapsed = now - start
    projected = (
        None if elapsed < PROJECTION_AFTER else cost * ((_day_start(following) - start) / elapsed)
    )
    return MonthCostOut(cost_usd=cost, projected_usd=projected)


async def _health(
    session: AsyncSession,
    *,
    settings: Settings,
    health: SearchHealth | None,
    search: SearchBackend | None,
) -> DashboardHealthOut:
    model = (
        await session.execute(
            select(Model.provider, Model.slug)
            .join(ScanKind, ScanKind.active_model_id == Model.id)
            .where(ScanKind.code == SCAN_KIND)
        )
    ).one_or_none()
    purge = (
        await session.execute(
            select(AdminAction.created_at, AdminAction.details)
            .where(AdminAction.action == "system.purge")
            .order_by(AdminAction.created_at.desc(), AdminAction.id.desc())
            .limit(1)
        )
    ).one_or_none()
    return DashboardHealthOut(
        active_model=None if model is None else ActiveModelOut(provider=model[0], slug=model[1]),
        search=await search_status(settings, health, search),
        last_purge=(
            None
            if purge is None
            else LastPurgeOut(at=purge[0], deleted_scans=purge[1].get("deletedScans", 0))
        ),
    )


async def dashboard(
    session: AsyncSession,
    now: datetime,
    *,
    settings: Settings,
    health: SearchHealth | None,
    search: SearchBackend | None,
) -> DashboardOut:
    """Toute la page : cartes du jour et des 7 jours civils, abonnés, mois et santé. Lit des
    colonnes, jamais des entités."""
    today = _brussels_day(now)
    day_start = _day_start(today)
    week_start = _day_start(today - timedelta(days=WEEK_DAYS - 1))
    return DashboardOut(
        today=await _stats(session, day_start, now),
        last_7_days=await _stats(session, week_start, now),
        subscribers=await _subscribers(session, week_start, now),
        month=await _month(session, now),
        health=await _health(session, settings=settings, health=health, search=search),
    )


async def daily(session: AsyncSession, now: datetime, days: int) -> DailyOut:
    """Un point par jour civil des `days` derniers jours (aujourd'hui compris), jours vides
    compris, du plus ancien au plus récent."""
    last = _brussels_day(now)
    first = last - timedelta(days=days - 1)
    start = _day_start(first)
    events = {
        day: (succeeded, failed)
        for day, succeeded, failed in (
            await session.execute(
                _events_query(
                    _EVENT_DAY,
                    func.count().filter(_SUCCEEDED),
                    func.count().filter(_FAILED),
                )
                .where(ScanEvent.created_at >= start, ScanEvent.created_at <= now)
                .group_by(_EVENT_DAY)
            )
        ).all()
    }
    calls = {
        day: (count, int(micros))
        for day, count, micros in (
            await session.execute(
                select(_CALL_DAY, func.count(), func.coalesce(func.sum(LlmCall.cost_usd_micros), 0))
                .where(LlmCall.created_at >= start, LlmCall.created_at <= now)
                .group_by(_CALL_DAY)
            )
        ).all()
    }
    points = []
    for offset in range(days):
        day = first + timedelta(days=offset)
        succeeded, failed = events.get(day, (0, 0))
        count, micros = calls.get(day, (0, 0))
        points.append(
            DailyPointOut(
                date=day,
                from_cache=max(0, succeeded - count),
                llm=count,
                failed=failed,
                cost_usd=micros / MICROS,
            )
        )
    return DailyOut(points=points)
