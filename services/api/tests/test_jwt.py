from collections.abc import Callable
from typing import Annotated

import httpx
import pytest
from fastapi import Depends
from jwt_helpers import KeyPair, make_jwks, sign

from radarnaque_api.auth.deps import current_user, require_internal_secret
from radarnaque_api.auth.jwt import JwtVerifier
from radarnaque_api.errors import ApiError
from radarnaque_api.models.auth_user import AuthUser

ISS = "http://issuer.test"
AUD = "http://audience.test"


class Fetcher:
    """Fetcher de test : compte les appels et sert un JWKS modifiable."""

    def __init__(self, *pairs: KeyPair) -> None:
        self.jwks = make_jwks(*pairs)
        self.calls = 0

    async def __call__(self) -> dict:
        self.calls += 1
        return self.jwks


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def verifier(fetcher: Fetcher, clock: Callable[[], float] | None = None) -> JwtVerifier:
    if clock is None:
        return JwtVerifier(fetcher, ISS, AUD)
    return JwtVerifier(fetcher, ISS, AUD, clock=clock)


async def assert_unauthenticated(v: JwtVerifier, token: str) -> None:
    with pytest.raises(ApiError) as exc:
        await v.verify(token)
    assert exc.value.status == 401
    assert exc.value.code == "unauthenticated"


async def test_valid_token_returns_sub():
    k1 = KeyPair.generate("k1")
    v = verifier(Fetcher(k1))
    assert await v.verify(sign(k1, "user-1", ISS, AUD)) == "user-1"


async def test_expired_token_rejected():
    k1 = KeyPair.generate("k1")
    await assert_unauthenticated(verifier(Fetcher(k1)), sign(k1, "user-1", ISS, AUD, exp_in=-10))


async def test_wrong_issuer_or_audience_rejected():
    k1 = KeyPair.generate("k1")
    v = verifier(Fetcher(k1))
    await assert_unauthenticated(v, sign(k1, "user-1", "http://evil.test", AUD))
    await assert_unauthenticated(v, sign(k1, "user-1", ISS, "http://evil.test"))


async def test_hs256_and_none_rejected():
    k1 = KeyPair.generate("k1")
    v = verifier(Fetcher(k1))
    await assert_unauthenticated(v, sign(k1, "user-1", ISS, AUD, alg="HS256"))
    await assert_unauthenticated(v, sign(k1, "user-1", ISS, AUD, alg="none"))


async def test_garbage_and_wrong_signature_rejected():
    k1, other = KeyPair.generate("k1"), KeyPair.generate("k1")
    v = verifier(Fetcher(k1))
    await assert_unauthenticated(v, "not-a-jwt")
    await assert_unauthenticated(v, sign(other, "user-1", ISS, AUD))


async def test_unknown_kid_refetches_once_per_interval():
    k1, k2, k3 = (KeyPair.generate(k) for k in ("k1", "k2", "k3"))
    fetcher, clock = Fetcher(k1), Clock()
    v = verifier(fetcher, clock)

    assert await v.verify(sign(k1, "u", ISS, AUD)) == "u"
    assert fetcher.calls == 1

    # k2 apparaît dans le JWKS : un jeton k2 déclenche un rechargement (2 appels).
    fetcher.jwks = make_jwks(k1, k2)
    clock.now = 100
    assert await v.verify(sign(k2, "u", ISS, AUD)) == "u"
    assert fetcher.calls == 2

    # k3 est inconnu : un seul rechargement, même répété dans la même minute.
    clock.now = 200
    await assert_unauthenticated(v, sign(k3, "u", ISS, AUD))
    assert fetcher.calls == 3
    clock.now = 230
    await assert_unauthenticated(v, sign(k3, "u", ISS, AUD))
    assert fetcher.calls == 3

    # Après l'intervalle, un nouveau rechargement est permis.
    clock.now = 270
    fetcher.jwks = make_jwks(k1, k2, k3)
    assert await v.verify(sign(k3, "u", ISS, AUD)) == "u"
    assert fetcher.calls == 4


async def assert_unavailable(v: JwtVerifier, token: str) -> None:
    with pytest.raises(ApiError) as exc:
        await v.verify(token)
    assert exc.value.status == 503
    assert exc.value.code == "auth_unavailable"


class FlakyFetcher(Fetcher):
    """Échoue (exception ou réponse mal formée) tant que `failure` n'est pas None."""

    def __init__(self, *pairs: KeyPair) -> None:
        super().__init__(*pairs)
        self.failure: Exception | object | None = None

    async def __call__(self) -> dict:
        self.calls += 1
        if isinstance(self.failure, Exception):
            raise self.failure
        if self.failure is not None:
            return self.failure  # type: ignore[return-value]
        return self.jwks


async def test_fetch_failure_is_503_then_recovers_immediately():
    k1 = KeyPair.generate("k1")
    fetcher, clock = FlakyFetcher(k1), Clock()
    fetcher.failure = RuntimeError("jwks indisponible")
    v = verifier(fetcher, clock)
    token = sign(k1, "u", ISS, AUD)

    await assert_unavailable(v, token)
    assert fetcher.calls == 1

    # L'auth revient : pas de blocage de 60 s, la requête suivante réussit.
    fetcher.failure = None
    clock.now = 1
    assert await v.verify(token) == "u"
    assert fetcher.calls == 2


@pytest.mark.parametrize("bad", [[], ["x"], {}, {"keys": None}, {"keys": {"a": 1}}, "nope"])
async def test_malformed_jwks_is_503_and_not_cached(bad):
    k1 = KeyPair.generate("k1")
    fetcher, clock = FlakyFetcher(k1), Clock()
    fetcher.failure = bad
    v = verifier(fetcher, clock)
    token = sign(k1, "u", ISS, AUD)

    await assert_unavailable(v, token)
    fetcher.failure = None
    assert await v.verify(token) == "u"


async def test_failed_rotation_refetch_is_503_but_known_kid_still_works():
    k1, k2 = KeyPair.generate("k1"), KeyPair.generate("k2")
    fetcher, clock = FlakyFetcher(k1), Clock()
    v = verifier(fetcher, clock)
    assert await v.verify(sign(k1, "u", ISS, AUD)) == "u"

    fetcher.failure = RuntimeError("down")
    clock.now = 100
    await assert_unavailable(v, sign(k2, "u", ISS, AUD))
    # Un kid en cache n'a pas besoin du réseau ; un jeton forgé reste 401.
    assert await v.verify(sign(k1, "u", ISS, AUD)) == "u"
    await assert_unauthenticated(v, sign(k1, "u", ISS, AUD, alg="HS256"))

    fetcher.failure = None
    fetcher.jwks = make_jwks(k1, k2)
    clock.now = 101
    assert await v.verify(sign(k2, "u", ISS, AUD)) == "u"


async def test_bad_token_stays_401_when_jwks_down():
    k1 = KeyPair.generate("k1")
    fetcher = FlakyFetcher(k1)
    fetcher.failure = RuntimeError("down")
    v = verifier(fetcher)
    await assert_unauthenticated(v, "not-a-jwt")
    await assert_unauthenticated(v, sign(k1, "u", ISS, AUD, alg="none"))
    assert fetcher.calls == 0


@pytest.fixture
def protected(app):
    @app.get("/_test/me")
    async def _me(user: Annotated[AuthUser, Depends(current_user)]) -> dict:
        return {"id": user.id, "email": user.email, "role": user.role}

    return app


async def test_current_user_missing_header_401(protected, client: httpx.AsyncClient):
    r = await client.get("/_test/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthenticated"
    r = await client.get("/_test/me", headers={"Authorization": "Basic abc"})
    assert r.status_code == 401


async def test_current_user_unknown_user_401(protected, client: httpx.AsyncClient, bearer):
    r = await client.get("/_test/me", headers=bearer("ghost"))
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthenticated"


async def test_current_user_ok(protected, client: httpx.AsyncClient, make_user, bearer):
    uid = await make_user("a@example.com", role="admin")
    r = await client.get("/_test/me", headers=bearer(uid))
    assert r.status_code == 200
    assert r.json() == {"id": uid, "email": "a@example.com", "role": "admin"}


async def test_require_internal_secret(app, client: httpx.AsyncClient):
    @app.get("/_test/internal", dependencies=[Depends(require_internal_secret)])
    async def _internal() -> dict:
        return {"ok": True}

    ok = await client.get(
        "/_test/internal", headers={"X-Internal-Secret": "test-internal-secret-0123456789abcdef"}
    )
    assert ok.status_code == 200
    for headers in ({"X-Internal-Secret": "wrong"}, {"X-Internal-Secret": ""}, {}):
        r = await client.get("/_test/internal", headers=headers)
        assert r.status_code == 403
        assert r.json()["error"]["code"] == "forbidden"
