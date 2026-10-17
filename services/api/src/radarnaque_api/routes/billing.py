from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request

from radarnaque_api.auth.deps import current_user
from radarnaque_api.billing import BillingProvider
from radarnaque_api.errors import ApiError
from radarnaque_api.models import AuthUser
from radarnaque_api.schemas import BillingUrlOut, CheckoutIn

router = APIRouter()

# Même plafond que Caddy (`request_body max_size 1MB` sur /api/*) : l'API ne dépend pas du proxy.
WEBHOOK_MAX_BYTES = 1024 * 1024


def _too_large() -> ApiError:
    return ApiError(413, "payload_too_large", "Requête trop volumineuse.")


async def _read_capped(request: Request, limit: int) -> bytes:
    """Corps brut, refusé (413) au-delà de `limit` octets : d'abord d'après `Content-Length`,
    sans rien lire, puis pendant la lecture, pour un envoi par morceaux (chunked) sans longueur
    annoncée ou une longueur annoncée fausse."""
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise _too_large()
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            raise _too_large()
    return bytes(body)


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
    lu brut, sans être interprété, dans la limite de 1 Mio ; ni lui ni la signature ne sont
    journalisés."""
    payload = await _read_capped(request, WEBHOOK_MAX_BYTES)
    await billing.handle_webhook(payload, stripe_signature)
