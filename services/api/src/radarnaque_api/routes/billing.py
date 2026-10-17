from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request

from radarnaque_api.auth.deps import current_user
from radarnaque_api.billing import BillingProvider
from radarnaque_api.models import AuthUser
from radarnaque_api.schemas import BillingUrlOut, CheckoutIn

router = APIRouter()


def _billing(request: Request) -> BillingProvider:
    return request.app.state.billing


@router.post("/api/billing/checkout", response_model=BillingUrlOut)
async def checkout(
    body: CheckoutIn,
    user: Annotated[AuthUser, Depends(current_user)],
    billing: Annotated[BillingProvider, Depends(_billing)],
) -> BillingUrlOut:
    return BillingUrlOut(url=await billing.create_checkout(user, body.plan, body.interval))


@router.post("/api/billing/portal", response_model=BillingUrlOut)
async def portal(
    user: Annotated[AuthUser, Depends(current_user)],
    billing: Annotated[BillingProvider, Depends(_billing)],
) -> BillingUrlOut:
    return BillingUrlOut(url=await billing.create_portal(user))


@router.post("/api/billing/webhooks/stripe", status_code=200)
async def stripe_webhook(
    request: Request,
    billing: Annotated[BillingProvider, Depends(_billing)],
    stripe_signature: Annotated[str | None, Header()] = None,
) -> None:
    """Sans authentification : l'appelant est Stripe, authentifié par sa signature. Le corps est
    lu brut, sans être interprété ; ni lui ni la signature ne sont journalisés."""
    await billing.handle_webhook(await request.body(), stripe_signature)
