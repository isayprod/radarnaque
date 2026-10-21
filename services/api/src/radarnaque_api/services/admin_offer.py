"""Offre de l'admin : plans, prix, quotas, photos, icônes des cartes et plafond total.

Comme `admin_ai`, les fonctions d'action contrôlent d'abord (404, 422), puis appellent
`record_action` pour chaque champ réellement changé, juste avant le commit de la route : aucune
ligne de journal ne décrit une modification refusée, et le changement part avec sa ligne.

Le plan modifié est verrouillé (`FOR NO KEY UPDATE` sur sa ligne `plans`) : deux enregistrements
simultanés du même plan se suivent. Les quotas et prix sont relus sous ce verrou pour écrire
`from` dans le journal."""

import time
from collections.abc import Callable
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import (
    AdminOfferOut,
    BillingInterval,
    OfferPlanIn,
    OfferPlanOut,
    OfferPriceOut,
    PublicOfferOut,
    PublicPlanOut,
)
from radarnaque_api.errors import ApiError
from radarnaque_api.models import Plan, PlanFeature, PlanPrice, PlanQuota
from radarnaque_api.services.admin_log import recent_actions, record_action
from radarnaque_api.services.scans import CARD_ICONS_FEATURE, SCAN_KIND

OFFER_ACTIONS = 20
CURRENCY = "EUR"
# Ordre d'affichage ; l'essai n'a pas de prix.
PLAN_ORDER = ("trial", "standard", "premium")
TRIAL = "trial"
INTERVALS: tuple[BillingInterval, ...] = ("month", "year")
PUBLIC_OFFER_TTL_SECONDS = 60.0


async def load_plans(session: AsyncSession) -> list[OfferPlanOut]:
    """Les plans dans l'ordre `PLAN_ORDER`, lus en colonnes (jamais d'entités : la session de la
    route, déjà validée, ne renvoie pas d'objets périmés)."""
    rows = (
        await session.execute(
            select(Plan.code, Plan.quota_period, Plan.total_scan_cap, Plan.max_images)
        )
    ).all()
    quotas = dict(
        (
            await session.execute(
                select(PlanQuota.plan, PlanQuota.quota).where(PlanQuota.scan_kind == SCAN_KIND)
            )
        ).all()
    )
    prices: dict[str, dict[BillingInterval, OfferPriceOut]] = {}
    for plan, interval, cents, stripe_id in (
        await session.execute(
            select(
                PlanPrice.plan,
                PlanPrice.interval,
                PlanPrice.amount_cents,
                PlanPrice.stripe_price_id,
            )
            .where(PlanPrice.currency == CURRENCY)
            .order_by(PlanPrice.interval)
        )
    ).all():
        prices.setdefault(plan, {})[interval] = OfferPriceOut(
            amount_cents=cents, stripe_price_id=stripe_id
        )
    with_icons = set(
        await session.scalars(
            select(PlanFeature.plan).where(PlanFeature.feature == CARD_ICONS_FEATURE)
        )
    )
    plans = [
        OfferPlanOut(
            code=code,
            quota_period=period,
            quota=quotas.get(code, 0),
            total_scan_cap=cap,
            max_images=images,
            card_icons=code in with_icons,
            prices=prices.get(code, {}),
        )
        for code, period, cap, images in rows
    ]
    return sorted(
        plans, key=lambda p: PLAN_ORDER.index(p.code) if p.code in PLAN_ORDER else len(PLAN_ORDER)
    )


async def build_overview(session: AsyncSession) -> AdminOfferOut:
    return AdminOfferOut(
        plans=await load_plans(session),
        actions=await recent_actions(session, prefix="offer.", limit=OFFER_ACTIONS),
    )


async def public_offer(session: AsyncSession) -> PublicOfferOut:
    """L'offre pour la page des prix : sans identifiant Stripe, sans prix pour l'essai. `scans`
    est le quota, limité par le plafond total quand il existe (l'essai : 5 scans de quota avec un
    plafond de 3 en annonce 3)."""
    by_code = {p.code: p for p in await load_plans(session)}

    def public(code: str) -> PublicPlanOut:
        plan = by_code[code]
        month, year = plan.prices.get("month"), plan.prices.get("year")
        scans = plan.quota
        if plan.total_scan_cap is not None:
            scans = min(scans, plan.total_scan_cap)
        priced = code != TRIAL
        return PublicPlanOut(
            scans=scans,
            max_images=plan.max_images,
            card_icons=plan.card_icons,
            monthly_cents=None if month is None or not priced else month.amount_cents,
            yearly_cents=None if year is None or not priced else year.amount_cents,
        )

    return PublicOfferOut(
        trial=public("trial"), standard=public("standard"), premium=public("premium")
    )


class PublicOfferCache:
    """Garde l'offre publique 60 s en mémoire du processus (la page des prix ne doit pas relire
    la base à chaque visite). Un enregistrement de l'admin la vide aussitôt (`clear`). Modèle de
    `SearchHealth` : horloge injectable."""

    def __init__(self, *, now: Callable[[], float] = time.monotonic) -> None:
        self._now = now
        self._known: tuple[float, PublicOfferOut] | None = None
        self._generation = 0

    async def get(self, session: AsyncSession) -> PublicOfferOut:
        if self._known is not None and self._now() - self._known[0] < PUBLIC_OFFER_TTL_SECONDS:
            return self._known[1]
        started, generation = self._now(), self._generation
        offer = await public_offer(session)
        if generation == self._generation:  # pas de `clear` pendant la lecture : sinon, périmée
            self._known = (started, offer)
        return offer

    def clear(self) -> None:
        self._known = None
        self._generation += 1


async def update_plan(
    session: AsyncSession, *, admin_id: str, plan_code: str, changes: OfferPlanIn
) -> None:
    """Applique les champs fournis et réellement changés ; une ligne de journal par champ, dans
    l'ordre prix (`month`, `year`), quota, icônes, photos, plafond. Rien de changé : rien n'est
    écrit."""
    plan = (
        await session.execute(
            select(Plan)
            .where(Plan.code == plan_code)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if plan is None:
        raise ApiError(404, "not_found", "Plan introuvable.")
    if changes.prices is not None and plan_code == TRIAL:
        raise ApiError(422, "invalid_value", "L'essai n'a pas de prix.", {"field": "prices"})

    def log(action: Any, details: dict[str, Any]) -> None:
        record_action(
            session,
            admin_id=admin_id,
            action=action,
            details={"plan": plan_code, **details},
        )

    if changes.prices is not None:
        for interval in INTERVALS:
            new = getattr(changes.prices, interval)
            if new is None:
                continue
            old = await session.scalar(
                select(PlanPrice.amount_cents).where(
                    PlanPrice.plan == plan_code,
                    PlanPrice.interval == interval,
                    PlanPrice.currency == CURRENCY,
                )
            )
            if new == old:
                continue
            await session.execute(
                insert(PlanPrice)
                .values(plan=plan_code, interval=interval, currency=CURRENCY, amount_cents=new)
                .on_conflict_do_update(
                    index_elements=["plan", "interval", "currency"], set_={"amount_cents": new}
                )
            )
            log("offer.price_set", {"interval": interval, "from": old, "to": new})

    if changes.quota is not None:
        old = await session.scalar(
            select(PlanQuota.quota).where(
                PlanQuota.plan == plan_code, PlanQuota.scan_kind == SCAN_KIND
            )
        )
        if changes.quota != old:
            await session.execute(
                insert(PlanQuota)
                .values(plan=plan_code, scan_kind=SCAN_KIND, quota=changes.quota)
                .on_conflict_do_update(
                    index_elements=["plan", "scan_kind"], set_={"quota": changes.quota}
                )
            )
            log("offer.quota_set", {"from": old, "to": changes.quota})

    if changes.card_icons is not None:
        had = (
            await session.scalar(
                select(PlanFeature.plan).where(
                    PlanFeature.plan == plan_code, PlanFeature.feature == CARD_ICONS_FEATURE
                )
            )
            is not None
        )
        if changes.card_icons != had:
            if changes.card_icons:
                await session.execute(
                    insert(PlanFeature)
                    .values(plan=plan_code, feature=CARD_ICONS_FEATURE)
                    .on_conflict_do_nothing()
                )
            else:
                await session.execute(
                    delete(PlanFeature).where(
                        PlanFeature.plan == plan_code, PlanFeature.feature == CARD_ICONS_FEATURE
                    )
                )
            log(
                "offer.feature_set",
                {"feature": CARD_ICONS_FEATURE, "from": had, "to": changes.card_icons},
            )

    if changes.max_images is not None and changes.max_images != plan.max_images:
        old_images, plan.max_images = plan.max_images, changes.max_images
        log("offer.max_images_set", {"from": old_images, "to": changes.max_images})

    # `null` explicite vide le plafond ; champ absent : inchangé.
    if (
        "total_scan_cap" in changes.model_fields_set
        and changes.total_scan_cap != plan.total_scan_cap
    ):
        old_cap, plan.total_scan_cap = plan.total_scan_cap, changes.total_scan_cap
        log("offer.total_cap_set", {"from": old_cap, "to": changes.total_scan_cap})

    await session.flush()
