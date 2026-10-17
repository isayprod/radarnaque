from typing import Literal, Protocol

from radarnaque_api.errors import ApiError
from radarnaque_api.models import AuthUser

BILLING_UNAVAILABLE_MESSAGE = "Le paiement en ligne n'est pas encore disponible."


class BillingProvider(Protocol):
    """Interface d'un fournisseur de paiement. Les routes ne connaissent que ce contrat : un
    futur `StripeBillingProvider` remplace `app.state.billing` sans toucher aux routes."""

    async def create_checkout(
        self,
        user: AuthUser,
        plan: Literal["standard", "premium"],
        interval: Literal["month", "year"],
    ) -> str:
        """Adresse de la page de paiement pour l'offre et la périodicité demandées."""
        ...

    async def create_portal(self, user: AuthUser) -> str:
        """Adresse du portail de gestion de l'abonnement."""
        ...

    async def handle_webhook(self, payload: bytes, signature: str | None) -> None:
        """Traite un événement du fournisseur. `payload` est le corps brut, tel que reçu : la
        signature se vérifie sur ces octets, jamais sur un JSON relu."""
        ...


def _unavailable() -> ApiError:
    return ApiError(501, "billing_unavailable", BILLING_UNAVAILABLE_MESSAGE)


class ManualBillingProvider:
    """Fournisseur par défaut tant que Stripe n'est pas branché : tout répond 501."""

    async def create_checkout(
        self,
        user: AuthUser,
        plan: Literal["standard", "premium"],
        interval: Literal["month", "year"],
    ) -> str:
        raise _unavailable()

    async def create_portal(self, user: AuthUser) -> str:
        raise _unavailable()

    async def handle_webhook(self, payload: bytes, signature: str | None) -> None:
        raise _unavailable()
