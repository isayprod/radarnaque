"""Base de critères de distinction partagée entre les scans.

Un groupe de candidats (noms normalisés, triés) a un seul jeu de critères, rafraîchi sur place.
Les critères viennent de la sortie du modèle : seuls ceux qui se vérifient sur photo ou auprès du
vendeur, appuyés par une page lue et qui citent un des candidats, sont gardés."""

import unicodedata
from datetime import datetime, timedelta
from typing import Literal, cast

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.identify.schemas import (
    CriteriaOut,
    CriteriaSetView,
    ExtractedCriterion,
    StoredCriterion,
)
from radarnaque_api.models.identification import CriteriaSet, Criterion, CriterionSource
from radarnaque_api.pages import PageText

MAX_CRITERIA = 8


def normalize_name(name: str) -> str:
    """Nom comparable : sans accents, en minuscules, espaces réduits."""
    stripped = "".join(
        c for c in unicodedata.normalize("NFKD", name) if not unicodedata.combining(c)
    )
    return " ".join(stripped.lower().split())


def candidates_key(candidates: list[str]) -> str:
    return " | ".join(sorted({normalize_name(c) for c in candidates}))


async def lock_criteria(session: AsyncSession, key: str) -> None:
    """Verrou de transaction : un seul calcul de critères à la fois pour un même groupe."""
    await session.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended(f"criteria:{key}", 0)))
    )


async def _view(session: AsyncSession, criteria_set: CriteriaSet) -> CriteriaSetView:
    rows = (
        await session.scalars(
            select(Criterion)
            .where(Criterion.set_id == criteria_set.id)
            .order_by(Criterion.position)
        )
    ).all()
    sources: dict[int, list[tuple[str, str, str]]] = {}
    if rows:
        source_rows = await session.scalars(
            select(CriterionSource)
            .where(CriterionSource.criterion_id.in_([r.id for r in rows]))
            .order_by(CriterionSource.criterion_id, CriterionSource.position)
        )
        for s in source_rows:
            sources.setdefault(s.criterion_id, []).append((s.url, s.title, s.domain))
    return CriteriaSetView(
        id=criteria_set.id,
        status=cast(Literal["auto", "verified"], criteria_set.status),
        criteria=tuple(
            StoredCriterion(
                id=r.id,
                position=r.position,
                kind=cast(Literal["photo", "ask_seller"], r.kind),
                decisive=r.decisive,
                fr=r.text_fr,
                nl=r.text_nl,
                expected=r.expected,
                sources=tuple(sources.get(r.id, ())),
            )
            for r in rows
        ),
    )


async def valid_criteria(
    session: AsyncSession, key: str, at: datetime, ttl: timedelta
) -> CriteriaSetView | None:
    """Jeu de critères du groupe, sauf s'il a expiré (un jeu `verified` n'expire jamais).

    L'appelant tient `lock_criteria` (même transaction) avant `valid_criteria` / `save_criteria`."""
    criteria_set = await session.scalar(
        select(CriteriaSet).where(CriteriaSet.candidates_key == key)
    )
    if criteria_set is None:
        return None
    if criteria_set.status != "verified" and criteria_set.refreshed_at + ttl <= at:
        return None
    return await _view(session, criteria_set)


async def save_criteria(
    session: AsyncSession,
    key: str,
    candidates: list[str],
    extracted: CriteriaOut,
    pages: list[PageText],
    at: datetime,
) -> CriteriaSetView:
    """Crée le jeu ou le rafraîchit sur place (critères remplacés, `status` gardé).

    Un jeu `verified` (relu par un admin) n'est jamais remplacé : sa vue est renvoyée telle
    quelle. L'appelant tient `lock_criteria` dans la même transaction.

    Les sources sont les numéros de page (1-based) de `pages` ; un numéro hors de `pages` (extrait
    de recherche, sans page) n'est pas une source valide."""
    criteria_set = await session.scalar(
        select(CriteriaSet).where(CriteriaSet.candidates_key == key)
    )
    if criteria_set is not None and criteria_set.status == "verified":
        return await _view(session, criteria_set)
    known = {normalize_name(c) for c in candidates}
    kept: list[tuple[ExtractedCriterion, list[PageText]]] = []
    for crit in extracted.criteria:
        if crit.kind == "invisible":
            continue
        used = list(dict.fromkeys(n for n in crit.sources if 1 <= n <= len(pages)))
        if not used:
            continue
        if not any(normalize_name(e.candidate) in known for e in crit.expected):
            continue
        kept.append((crit, [pages[n - 1] for n in used]))
        if len(kept) == MAX_CRITERIA:
            break

    if criteria_set is None:
        criteria_set = CriteriaSet(
            candidates_key=key, candidates=candidates, created_at=at, refreshed_at=at
        )
        session.add(criteria_set)
    else:
        criteria_set.candidates = candidates
        criteria_set.refreshed_at = at
        await session.execute(delete(Criterion).where(Criterion.set_id == criteria_set.id))
    await session.flush()

    for position, (crit, crit_pages) in enumerate(kept):
        row = Criterion(
            set_id=criteria_set.id,
            position=position,
            kind=crit.kind,
            decisive=crit.decisive,
            text_fr=crit.fr,
            text_nl=crit.nl,
            expected={e.candidate: {"fr": e.fr, "nl": e.nl} for e in crit.expected},
        )
        session.add(row)
        await session.flush()
        seen: set[str] = set()
        distinct = [p for p in crit_pages if not (p.url in seen or seen.add(p.url))]
        session.add_all(
            CriterionSource(
                criterion_id=row.id, position=i, url=p.url, title=p.title, domain=p.domain
            )
            for i, p in enumerate(distinct)
        )
    await session.flush()
    return await _view(session, criteria_set)
