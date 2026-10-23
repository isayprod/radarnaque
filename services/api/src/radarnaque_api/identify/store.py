"""Persistance de l'identification : configuration des étapes, clé et lecture du cache,
enregistrement d'un résultat (insertion ou rafraîchissement sur place) et relecture.

Une identification se suffit à elle-même : chaque vérification garde une copie du critère tel
qu'il a été vérifié (texte, `decisive`, sources), jamais relue dans la base de critères, qu'un
rafraîchissement ou un admin peut modifier ensuite."""

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, cast

from sqlalchemy import ColumnElement, delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.identify.confidence import level_of
from radarnaque_api.models import (
    CriteriaSet,
    Identification,
    IdentificationCheck,
    IdentificationObject,
    IdentificationPage,
    IdentificationSearch,
    LlmCall,
    Model,
    PipelineStep,
    PromptVersion,
)
from radarnaque_api.schemas import (
    CriterionCheckOut,
    IdentificationOut,
    IdentificationSearchOut,
    IdentifiedObjectPublicOut,
    LocalizedTextOut,
    PageLinkOut,
    ScanIn,
)
from radarnaque_api.services.hashing import canonical_json

if TYPE_CHECKING:
    from radarnaque_api.identify.pipeline import PipelineRun

STEPS = ("read_photos", "criteria", "identify")


def _sha256(obj: Any) -> str:
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class StepSetup:
    """Modèle et version de prompt actifs d'une étape du pipeline."""

    step: str
    model_id: int
    provider: str
    slug: str
    prompt_version_id: int
    system_prompt: str


async def active_steps(session: AsyncSession) -> dict[str, StepSetup] | None:
    """Configuration des trois étapes, ou `None` si l'une n'a pas de prompt actif (ou un prompt
    d'une autre étape)."""
    rows = await session.execute(
        select(
            PipelineStep.code,
            Model.id,
            Model.provider,
            Model.slug,
            PromptVersion.id,
            PromptVersion.system_prompt,
        )
        .select_from(PipelineStep)
        .join(Model, Model.id == PipelineStep.active_model_id)
        .join(
            PromptVersion,
            (PromptVersion.id == PipelineStep.active_prompt_version_id)
            & (PromptVersion.step == PipelineStep.code),
        )
        .where(PipelineStep.code.in_(STEPS))
    )
    steps = {row[0]: StepSetup(*row) for row in rows}
    return steps if len(steps) == len(STEPS) else None


def config_hash(steps: dict[str, StepSetup]) -> str:
    """Empreinte des modèles et prompts des étapes : une autre configuration, un autre cache."""
    return _sha256(sorted([s.step, s.model_id, s.prompt_version_id] for s in steps.values()))


def identify_input_hash(scan: ScanIn, photos: int, image_side: int) -> str:
    """Empreinte de ce qui, hors contenu du snapshot, change l'identification : les faits de
    l'annonce envoyés à `read_photos` et `identify` (ceux d'`input_hash`, sans les signaux, la
    version des règles ni le scan partiel, qui ne leur sont pas envoyés), le nombre de photos
    envoyées et leur plus grand côté.

    Invariant (règle R12) : tout champ envoyé (`identify.payload`) est couvert par
    `content_hash` (le snapshot, dans la clé) ou par cette empreinte. Vérifié par
    tests/test_identify_pipeline.py."""
    listing = scan.listing
    return _sha256(
        {
            "seller": listing.seller.model_dump(mode="json", by_alias=True),
            "category": listing.category,
            "condition": listing.condition,
            "attributes": [a.model_dump(mode="json") for a in listing.attributes],
            "postedAt": listing.posted_at,
            "location": listing.location.model_dump(mode="json", by_alias=True),
            "photos": photos,
            "imageSide": image_side,
        }
    )


@dataclass(frozen=True)
class IdentificationKey:
    """Clé du cache : `UNIQUE(snapshot_id, config_hash, input_hash)`."""

    snapshot_id: int
    config_hash: str
    input_hash: str

    def where(self) -> tuple[ColumnElement[bool], ...]:
        return (
            Identification.snapshot_id == self.snapshot_id,
            Identification.config_hash == self.config_hash,
            Identification.input_hash == self.input_hash,
        )

    def lock_name(self) -> str:
        """Texte haché par `hashtextextended` pour le verrou consultatif de cette clé."""
        return f"identification:{self.snapshot_id}:{self.config_hash}:{self.input_hash}"


async def valid_identification_id(
    session: AsyncSession, key: IdentificationKey, at: datetime, ttl: timedelta
) -> int | None:
    """Identification en cache encore valide pour `key` : `created_at + ttl > at`."""
    return await session.scalar(
        select(Identification.id).where(*key.where(), Identification.created_at > at - ttl)
    )


async def save_identification(
    session: AsyncSession, key: IdentificationKey, run: "PipelineRun", at: datetime
) -> int:
    """Insère l'identification de `key`, ou rafraîchit sur place celle qui détient déjà la clé
    (règle R4) : sa ligne est mise à jour, ses objets (vérifications et pages comprises) et ses
    recherches remplacés. Écrit une ligne `llm_calls` par appel du `run`, reliée à
    l'identification, ou à l'ensemble de critères pour un appel `criteria`. Les jetons et le
    coût de l'identification sont ceux de tous les appels du `run`. À appeler sous le verrou
    consultatif de la clé ; ne valide pas."""
    read = run.read_photos
    question = run.identify.seller_question if run.identify is not None else None
    values = {
        "status": run.status,
        "confidence": run.confidence,
        "photo_observations": (
            [o.model_dump(mode="json") for o in read.photo_observations] if read else []
        ),
        "title_mismatch": read.title_mismatch if read else None,
        "seller_question_fr": question.fr if question else None,
        "seller_question_nl": question.nl if question else None,
        "retried": run.retried,
        "unsourced": run.unsourced,
        "images_analyzed": run.images_analyzed,
        "tokens_in": sum(c.tokens_in for c in run.calls),
        "tokens_out": sum(c.tokens_out for c in run.calls),
        "cost_usd_micros": sum(c.cost_usd_micros for c in run.calls),
        "created_at": at,
    }
    stmt = insert(Identification).values(
        snapshot_id=key.snapshot_id,
        config_hash=key.config_hash,
        input_hash=key.input_hash,
        **values,
    )
    identification_id = (
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=["snapshot_id", "config_hash", "input_hash"], set_=values
            ).returning(Identification.id)
        )
    ).scalar_one()

    # Sans effet pour une nouvelle identification ; pour un rafraîchissement, les vérifications
    # et les pages partent avec leurs objets (`ON DELETE CASCADE`).
    await session.execute(
        delete(IdentificationObject).where(
            IdentificationObject.identification_id == identification_id
        )
    )
    await session.execute(
        delete(IdentificationSearch).where(
            IdentificationSearch.identification_id == identification_id
        )
    )

    for position, obj in enumerate(run.objects):
        object_id = (
            await session.execute(
                insert(IdentificationObject)
                .values(
                    identification_id=identification_id,
                    position=position,
                    role=obj.role,
                    label=obj.label,
                    reference=obj.reference,
                    confidence=obj.confidence,
                    remaining=list(obj.remaining),
                    criteria_set_id=obj.criteria_set_id,
                )
                .returning(IdentificationObject.id)
            )
        ).scalar_one()
        if obj.checks:
            await session.execute(
                insert(IdentificationCheck),
                [
                    {
                        "object_id": object_id,
                        "position": n,
                        "criterion_id": check.criterion_id,
                        "text_fr": check.text_fr,
                        "text_nl": check.text_nl,
                        "decisive": check.decisive,
                        "sources": [
                            {"url": url, "title": title, "domain": domain}
                            for url, title, domain in check.sources
                        ],
                        "observation": check.observation,
                        "photo_index": check.photo,
                    }
                    for n, check in enumerate(obj.checks)
                ],
            )
        if obj.pages:
            await session.execute(
                insert(IdentificationPage),
                [
                    {
                        "object_id": object_id,
                        "position": n,
                        "url": page.url,
                        "title": page.title,
                        "domain": page.domain,
                    }
                    for n, page in enumerate(obj.pages)
                ],
            )
    if run.searches:
        await session.execute(
            insert(IdentificationSearch),
            [
                {
                    "identification_id": identification_id,
                    "position": position,
                    "query": search.query,
                    "kind": search.kind,
                    "pages_read": list(search.pages_read),
                }
                for position, search in enumerate(run.searches)
            ],
        )
    session.add_all(
        LlmCall(
            created_at=at,
            step=call.step,
            identification_id=None if call.step == "criteria" else identification_id,
            criteria_set_id=call.criteria_set_id if call.step == "criteria" else None,
            model_id=call.model_id,
            prompt_version_id=call.prompt_version_id,
            tokens_in=call.tokens_in,
            tokens_out=call.tokens_out,
            cost_usd_micros=call.cost_usd_micros,
            images_analyzed=call.images,
            web_searches=call.web_searches,
        )
        for call in run.calls
    )
    await session.flush()
    return identification_id


async def load_identification(session: AsyncSession, identification_id: int) -> IdentificationOut:
    """Identification relue telle qu'enregistrée (sans `remaining`, ni `debug`, avec
    `from_cache` faux : à l'appelant de les renseigner). Les vérifications viennent de leur
    copie, jamais de la base de critères. `verified_criteria` : l'ensemble de critères de
    l'objet principal est relu par un admin."""
    ident = (
        await session.execute(
            select(Identification)
            .where(Identification.id == identification_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    objects = list(
        await session.scalars(
            select(IdentificationObject)
            .where(IdentificationObject.identification_id == identification_id)
            .order_by(IdentificationObject.position)
            .execution_options(populate_existing=True)
        )
    )
    ids = [o.id for o in objects]
    checks: dict[int, list[CriterionCheckOut]] = {}
    pages: dict[int, list[PageLinkOut]] = {}
    if ids:
        for c in await session.scalars(
            select(IdentificationCheck)
            .where(IdentificationCheck.object_id.in_(ids))
            .order_by(IdentificationCheck.object_id, IdentificationCheck.position)
            .execution_options(populate_existing=True)
        ):
            checks.setdefault(c.object_id, []).append(
                CriterionCheckOut(
                    text=LocalizedTextOut(fr=c.text_fr, nl=c.text_nl),
                    observation=cast(Any, c.observation),
                    photo=c.photo_index,
                    sources=[PageLinkOut(**s) for s in c.sources],
                )
            )
        for p in await session.scalars(
            select(IdentificationPage)
            .where(IdentificationPage.object_id.in_(ids))
            .order_by(IdentificationPage.object_id, IdentificationPage.position)
            .execution_options(populate_existing=True)
        ):
            pages.setdefault(p.object_id, []).append(
                PageLinkOut(url=p.url, title=p.title, domain=p.domain)
            )
    searches = await session.execute(
        select(
            IdentificationSearch.query, IdentificationSearch.kind, IdentificationSearch.pages_read
        )
        .where(IdentificationSearch.identification_id == identification_id)
        .order_by(IdentificationSearch.position)
    )
    main = next((o for o in objects if o.role == "main"), None)
    verified = main is not None and main.criteria_set_id is not None
    if verified:
        status = await session.scalar(
            select(CriteriaSet.status).where(CriteriaSet.id == cast(int, main.criteria_set_id))
        )
        verified = status == "verified"
    question = (
        LocalizedTextOut(fr=ident.seller_question_fr, nl=ident.seller_question_nl)
        if ident.seller_question_fr is not None and ident.seller_question_nl is not None
        else None
    )
    return IdentificationOut(
        identification_id=ident.id,
        status=cast(Any, ident.status),
        confidence=ident.confidence,
        level=level_of(ident.confidence, main.reference if main else None),
        objects=[
            IdentifiedObjectPublicOut(
                role=cast(Any, o.role),
                label=o.label,
                reference=o.reference,
                confidence=o.confidence,
                level=level_of(o.confidence, o.reference),
                remaining=list(o.remaining),
                checks=checks.get(o.id, []),
                pages=pages.get(o.id, []),
            )
            for o in objects
        ],
        seller_question=question,
        title_mismatch=ident.title_mismatch,
        searches=[
            IdentificationSearchOut(query=query, kind=cast(Any, kind), pages_read=list(read))
            for query, kind, read in searches
        ],
        verified_criteria=verified,
        unsourced=ident.unsourced,
        images_analyzed=ident.images_analyzed,
        from_cache=False,
        identified_at=ident.created_at,
    )


def identification_digest(out: IdentificationOut) -> str:
    """Empreinte du résultat qui nourrit `scam` (statut, confiance, référence et niveau de
    chaque objet, `title_mismatch`) : elle entre dans l'`input_hash` de l'analyse."""
    return _sha256(
        {
            "status": out.status,
            "confidence": out.confidence,
            "objects": [{"reference": o.reference, "level": o.level} for o in out.objects],
            "titleMismatch": out.title_mismatch,
        }
    )
