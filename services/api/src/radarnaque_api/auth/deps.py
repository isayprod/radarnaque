import hmac
from typing import Annotated

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.db import get_session
from radarnaque_api.errors import ApiError
from radarnaque_api.models.auth_user import AuthUser


def _unauthenticated() -> ApiError:
    return ApiError(401, "unauthenticated", "Authentification requise.")


async def current_user(
    request: Request, session: Annotated[AsyncSession, Depends(get_session)]
) -> AuthUser:
    """Utilisateur authentifié : `Authorization: Bearer <jwt>` puis lecture de auth."user"."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise _unauthenticated()
    user_id = await request.app.state.jwt_verifier.verify(token)
    user = await session.get(AuthUser, user_id)
    if user is None:
        raise _unauthenticated()
    return user


async def require_internal_secret(
    request: Request, x_internal_secret: Annotated[str | None, Header()] = None
) -> None:
    """Protège les routes internes (appelées par le service auth) par un secret partagé."""
    expected = request.app.state.settings.internal_api_secret.get_secret_value()
    if x_internal_secret is None or not hmac.compare_digest(
        x_internal_secret.encode(), expected.encode()
    ):
        raise ApiError(403, "forbidden", "Secret interne invalide.")
