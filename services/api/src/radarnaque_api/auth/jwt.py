import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
import jwt

from radarnaque_api.errors import ApiError

logger = logging.getLogger(__name__)

JwksFetcher = Callable[[], Awaitable[dict]]

_ALGORITHM = "EdDSA"


def http_jwks_fetcher(url: str) -> JwksFetcher:
    """Fetcher JWKS via HTTP (délai de 5 s)."""

    async def fetch() -> dict:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.json()

    return fetch


def _unauthenticated(message: str = "Authentification requise.") -> ApiError:
    return ApiError(401, "unauthenticated", message)


class JwtVerifier:
    """Vérifie les JWT EdDSA émis par Better Auth, avec les clés du JWKS (cache par `kid`).

    Un `kid` inconnu recharge le JWKS, au plus une fois par `min_refetch_interval` secondes.
    """

    def __init__(
        self,
        fetch_jwks: JwksFetcher,
        issuer: str,
        audience: str,
        *,
        min_refetch_interval: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._fetch_jwks = fetch_jwks
        self._issuer = issuer
        self._audience = audience
        self._min_refetch_interval = min_refetch_interval
        self._clock = clock
        self._keys: dict[str, jwt.PyJWK] = {}
        self._last_fetch: float | None = None
        self._lock = asyncio.Lock()

    async def _load_jwks(self) -> dict[str, jwt.PyJWK]:
        """Télécharge et analyse le JWKS. Lève une exception si la réponse est inutilisable,
        y compris sans aucune clé lisible : un JWKS vide ne remplace jamais le cache."""
        jwks = await self._fetch_jwks()
        raw_keys = jwks["keys"]
        if not isinstance(raw_keys, list):
            raise TypeError("le champ « keys » du JWKS n'est pas une liste")
        keys: dict[str, jwt.PyJWK] = {}
        for jwk in raw_keys:
            try:
                keys[jwk["kid"]] = jwt.PyJWK(jwk)
            except Exception:
                logger.warning("Clé JWKS illisible ignorée", exc_info=True)
        if not keys:
            raise ValueError("le JWKS ne contient aucune clé lisible")
        return keys

    async def _refresh(self, kid: str) -> jwt.PyJWK | None:
        """Recharge le JWKS si l'intervalle minimal est écoulé, puis cherche `kid`.

        Lève ApiError(503) si le JWKS est injoignable ou invalide : l'échéance de rechargement
        n'est alors pas consommée, la requête suivante réessaie.
        """
        async with self._lock:
            # Un appel concurrent a pu charger la clé entre-temps.
            if kid in self._keys:
                return self._keys[kid]
            now = self._clock()
            if self._last_fetch is not None and now - self._last_fetch < self._min_refetch_interval:
                return None
            try:
                keys = await self._load_jwks()
            except Exception:
                logger.warning("Impossible de charger le JWKS", exc_info=True)
                raise ApiError(
                    503, "auth_unavailable", "Service d'authentification indisponible."
                ) from None
            self._last_fetch = now
            self._keys = keys
            return keys.get(kid)

    async def verify(self, token: str) -> str:
        """Renvoie `sub` si le jeton est valide, sinon lève ApiError(401, "unauthenticated")."""
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError:
            raise _unauthenticated() from None
        if header.get("alg") != _ALGORITHM:
            raise _unauthenticated()
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise _unauthenticated()

        key = self._keys.get(kid) or await self._refresh(kid)
        if key is None:
            raise _unauthenticated()

        try:
            claims: dict[str, Any] = jwt.decode(
                token,
                key.key,
                algorithms=[_ALGORITHM],
                issuer=self._issuer,
                audience=self._audience,
                options={"require": ["exp", "sub", "iss", "aud"]},
            )
        except jwt.PyJWTError:
            raise _unauthenticated() from None
        sub = claims["sub"]
        if not isinstance(sub, str) or not sub:
            raise _unauthenticated()
        return sub
