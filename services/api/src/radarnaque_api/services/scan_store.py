"""Persistance du service de scan : configuration active, clé et lecture du cache, snapshot de
l'annonce, analyse (insertion ou rafraîchissement sur place) et relecture de ses textes."""

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import ColumnElement, delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.llm.client import LLMResult
from radarnaque_api.llm.payload import mask_contacts
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
    ScanKind,
    SnapshotImage,
)
from radarnaque_api.schemas import (
    AnalysisReasonOut,
    ListingIn,
    LocalizedTextOut,
    ScanIn,
    WebSearchOut,
)
from radarnaque_api.services.hashing import content_hash


@dataclass(frozen=True)
class CacheKey:
    """Clé du cache d'analyses : `UNIQUE(snapshot_id, model_id, prompt_version_id, input_hash)`."""

    snapshot_id: int
    model_id: int
    prompt_version_id: int
    input_hash: str

    def where(self) -> tuple[ColumnElement[bool], ...]:
        return (
            Analysis.snapshot_id == self.snapshot_id,
            Analysis.model_id == self.model_id,
            Analysis.prompt_version_id == self.prompt_version_id,
            Analysis.input_hash == self.input_hash,
        )

    def lock_name(self) -> str:
        """Texte haché par `hashtextextended` pour le verrou consultatif de cette clé."""
        return (
            f"analysis:{self.snapshot_id}:{self.model_id}:"
            f"{self.prompt_version_id}:{self.input_hash}"
        )


@dataclass(frozen=True)
class ActiveSetup:
    """Modèle et version de prompt actifs d'un type de scan."""

    model_id: int
    provider: str
    slug: str
    prompt_version_id: int
    prompt_version: int  # numéro de version, pour le bloc debug
    system_prompt: str


async def active_setup(session: AsyncSession, scan_kind: str) -> ActiveSetup | None:
    """None si le type n'a pas de version de prompt active, ou une version d'un autre type."""
    row = (
        await session.execute(
            select(
                Model.id,
                Model.provider,
                Model.slug,
                PromptVersion.id,
                PromptVersion.version,
                PromptVersion.system_prompt,
            )
            .select_from(ScanKind)
            .join(Model, Model.id == ScanKind.active_model_id)
            .join(
                PromptVersion,
                (PromptVersion.id == ScanKind.active_prompt_version_id)
                & (PromptVersion.scan_kind == ScanKind.code),
            )
            .where(ScanKind.code == scan_kind)
        )
    ).one_or_none()
    return None if row is None else ActiveSetup(*row)


async def valid_analysis_id(
    session: AsyncSession, key: CacheKey, at: datetime, ttl: timedelta
) -> int | None:
    """Analyse en cache encore valide pour `key` : `created_at + ttl > at`."""
    return await session.scalar(
        select(Analysis.id).where(*key.where(), Analysis.created_at > at - ttl)
    )


async def upsert_snapshot(
    session: AsyncSession, site_id: int, listing: ListingIn, at: datetime
) -> tuple[int, str]:
    """Annonce, snapshot et images (`INSERT … ON CONFLICT DO NOTHING`, puis relecture), puis
    commit. Renvoie l'identifiant du snapshot et son empreinte de contenu. Le titre et la
    description sont masqués **avant** l'empreinte et l'enregistrement (règle R9), comme dans le
    message envoyé au LLM : aucun contact n'est stocké."""
    title = mask_contacts(listing.title)
    description = mask_contacts(listing.description)
    await session.execute(
        insert(Listing)
        .values(site_id=site_id, external_id=listing.external_id)
        .on_conflict_do_nothing()
    )
    listing_id = (
        await session.execute(
            select(Listing.id).where(
                Listing.site_id == site_id, Listing.external_id == listing.external_id
            )
        )
    ).scalar_one()
    digest = content_hash(listing, title, description)
    price = listing.price
    snapshot_id = await session.scalar(
        insert(ListingSnapshot)
        .values(
            listing_id=listing_id,
            content_hash=digest,
            title=title,
            description=description,
            price_cents=None if price is None else price.amount_cents,
            currency=None if price is None else price.currency,
            captured_at=at,
        )
        .on_conflict_do_nothing()
        .returning(ListingSnapshot.id)
    )
    if snapshot_id is None:  # snapshot déjà connu, images comprises (même empreinte)
        snapshot_id = (
            await session.execute(
                select(ListingSnapshot.id).where(
                    ListingSnapshot.listing_id == listing_id,
                    ListingSnapshot.content_hash == digest,
                )
            )
        ).scalar_one()
    elif listing.images:
        await session.execute(
            insert(SnapshotImage),
            [
                {"snapshot_id": snapshot_id, "position": position, "url": str(url)}
                for position, url in enumerate(listing.images)
            ],
        )
    await session.commit()
    return snapshot_id, digest


async def save_analysis(
    session: AsyncSession,
    key: CacheKey,
    scan: ScanIn,
    result: LLMResult,
    at: datetime,
    *,
    images_analyzed: int,
) -> int:
    """Insère l'analyse de `key`, ou rafraîchit sur place l'entrée expirée qui détient déjà la
    clé (règle R4) : sa ligne est mise à jour, ses textes, raisons et recherches web remplacés,
    et les anciens `scan_results` continuent d'y pointer. `images_analyzed` : photos réellement
    envoyées au modèle. `created_at` est la date de l'événement qui la
    produit (règle R8). Écrit aussi une ligne `llm_calls` : une par appel au modèle, insertion
    comme rafraîchissement, dans la même transaction. À appeler sous le verrou consultatif de la
    clé ; ne valide pas."""
    analysis = result.analysis
    values = {
        "rules_version": scan.rules.version,
        "score": analysis.score,
        "professional": analysis.professional,
        "partial": scan.partial,
        "images_analyzed": images_analyzed,
        "tokens_in": result.tokens_in,
        "tokens_out": result.tokens_out,
        "cost_usd_micros": result.cost_usd_micros,
        "created_at": at,
    }
    stmt = insert(Analysis).values(
        snapshot_id=key.snapshot_id,
        model_id=key.model_id,
        prompt_version_id=key.prompt_version_id,
        input_hash=key.input_hash,
        **values,
    )
    analysis_id = (
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=["snapshot_id", "model_id", "prompt_version_id", "input_hash"],
                set_=values,
            ).returning(Analysis.id)
        )
    ).scalar_one()

    # Sans effet pour une nouvelle analyse ; pour un rafraîchissement, efface les anciens textes.
    reason_ids = select(AnalysisReason.id).where(AnalysisReason.analysis_id == analysis_id)
    await session.execute(
        delete(AnalysisReasonText).where(AnalysisReasonText.reason_id.in_(reason_ids))
    )
    await session.execute(delete(AnalysisReason).where(AnalysisReason.analysis_id == analysis_id))
    await session.execute(delete(AnalysisText).where(AnalysisText.analysis_id == analysis_id))
    await session.execute(
        delete(AnalysisWebSearch).where(AnalysisWebSearch.analysis_id == analysis_id)
    )

    await session.execute(
        insert(AnalysisText),
        [
            {
                "analysis_id": analysis_id,
                "locale": locale,
                "summary": getattr(analysis.summary, locale),
                "advice": getattr(analysis.advice, locale),
            }
            for locale in ("fr", "nl")
        ],
    )
    for position, reason in enumerate(analysis.reasons):
        reason_id = (
            await session.execute(
                insert(AnalysisReason)
                .values(analysis_id=analysis_id, position=position, severity=reason.severity)
                .returning(AnalysisReason.id)
            )
        ).scalar_one()
        await session.execute(
            insert(AnalysisReasonText),
            [
                {"reason_id": reason_id, "locale": "fr", "text": reason.fr},
                {"reason_id": reason_id, "locale": "nl", "text": reason.nl},
            ],
        )
    if result.searches:
        await session.execute(
            insert(AnalysisWebSearch),
            [
                {
                    "analysis_id": analysis_id,
                    "position": position,
                    "query": search.query,
                    "aspect": search.aspect,
                }
                for position, search in enumerate(result.searches)
            ],
        )
    session.add(
        LlmCall(
            created_at=at,
            analysis_id=analysis_id,
            model_id=key.model_id,
            prompt_version_id=key.prompt_version_id,
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            cost_usd_micros=result.cost_usd_micros,
            images_analyzed=images_analyzed,
            web_searches=len(result.searches),
        )
    )
    return analysis_id


@dataclass(frozen=True)
class AnalysisTexts:
    summary: LocalizedTextOut
    advice: LocalizedTextOut
    reasons: list[AnalysisReasonOut]
    web_searches: list[WebSearchOut]


async def load_analysis(session: AsyncSession, analysis_id: int) -> AnalysisTexts:
    """Résumé, conseil, raisons et recherches web (dans l'ordre) d'une analyse ; textes en français
    et en néerlandais."""
    texts = {
        text.locale: text
        for text in await session.scalars(
            select(AnalysisText).where(AnalysisText.analysis_id == analysis_id)
        )
    }
    rows = await session.execute(
        select(
            AnalysisReason.id,
            AnalysisReason.severity,
            AnalysisReasonText.locale,
            AnalysisReasonText.text,
        )
        .join(AnalysisReasonText, AnalysisReasonText.reason_id == AnalysisReason.id)
        .where(AnalysisReason.analysis_id == analysis_id)
        .order_by(AnalysisReason.position)
    )
    searches = await session.execute(
        select(AnalysisWebSearch.query, AnalysisWebSearch.aspect)
        .where(AnalysisWebSearch.analysis_id == analysis_id)
        .order_by(AnalysisWebSearch.position)
    )
    reasons: dict[int, tuple[str, dict[str, str]]] = {}
    for reason_id, severity, locale, reason_text in rows:
        reasons.setdefault(reason_id, (severity, {}))[1][locale] = reason_text
    return AnalysisTexts(
        summary=LocalizedTextOut(fr=texts["fr"].summary, nl=texts["nl"].summary),
        advice=LocalizedTextOut(fr=texts["fr"].advice, nl=texts["nl"].advice),
        reasons=[
            AnalysisReasonOut(severity=severity, text=LocalizedTextOut(**by_locale))
            for severity, by_locale in reasons.values()
        ],
        web_searches=[WebSearchOut(query=query, aspect=aspect) for query, aspect in searches],
    )
