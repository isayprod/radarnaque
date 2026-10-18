import logging
from collections.abc import Awaitable, Callable
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from jwt_helpers import make_jwks
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.llm.client import (
    Bilingual,
    LLMAnalysis,
    LLMError,
    LLMReason,
    LLMResult,
    OpenAICompatibleClient,
)
from radarnaque_api.llm.providers import ProviderError
from radarnaque_api.main import create_app

PROVIDER_SECRET = "provider-secret-body-9c41"


class FakeLLM:
    """Faux client LLM : `error` le fait échouer, chaque appel rend un score différent."""

    def __init__(self) -> None:
        self.error: Exception | None = None
        self.calls = 0

    def llm_for(self, provider: str) -> "FakeLLM":
        return self

    async def analyze(self, *, model: str, system_prompt: str, messages: list[dict]) -> LLMResult:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return LLMResult(
            analysis=LLMAnalysis(
                score=60 + self.calls,
                summary=Bilingual(fr="Résumé", nl="Samenvatting"),
                advice=Bilingual(fr="Conseil", nl="Advies"),
                reasons=[LLMReason(severity="danger", fr="Raison", nl="Reden")],
            ),
            tokens_in=100,
            tokens_out=10,
            cost_usd_micros=42,
        )


class ProviderFailure(LLMError):
    """Erreur du fournisseur dont le texte imite un corps de réponse brut."""

    def __init__(self) -> None:
        super().__init__("transport", "fake")
        self.args = (f"fournisseur fake : {PROVIDER_SECRET}",)


@pytest.fixture
def llm(app: FastAPI) -> FakeLLM:
    fake = FakeLLM()
    app.state.llm_for = fake.llm_for
    return fake


@pytest.fixture
async def user(
    make_user: Callable[..., Awaitable[str]], db: AsyncSession
) -> Callable[[], Awaitable[str]]:
    """Crée un utilisateur avec un essai actif et renvoie son identifiant."""

    async def _make() -> str:
        uid = await make_user(f"{uuid4().hex}@b.test")
        await db.execute(
            text(
                "insert into app.subscriptions(user_id, plan, status, provider, period_start)"
                " values (:uid, 'trial', 'active', 'manual', now() - interval '1 day')"
            ),
            {"uid": uid},
        )
        await db.commit()
        return uid

    return _make


def _body(external_id: str = "m123", **listing: object) -> dict:
    body: dict = {
        "listing": {
            "site": "2dehands.be",
            "externalId": external_id,
            "url": f"https://www.2dehands.be/v/a/{external_id}",
            "title": "Vélo de course",
            "description": "Vélo en bon état.",
            "price": {"amountCents": 15000, "currency": "EUR"},
            "priceType": "fixed",
            "location": {"city": "Gent"},
            "images": [],
            "seller": {"reviewCount": 0},
        },
        "rules": {
            "version": 1,
            "signals": [{"id": "new_account", "weight": 30, "severity": "warning"}],
        },
        "scanKind": "text",
        "trigger": "button",
    }
    body["listing"].update(listing)
    return body


# --- POST /api/scans ---------------------------------------------------------------------


async def test_scan_returns_camel_case_result_then_from_cache(client, bearer, user, llm):
    uid = await user()
    r = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert r.status_code == 200, r.text
    data = r.json()
    assert {"analysisId", "fromCache", "remaining", "analyzedAt", "level"} <= set(data)
    assert data["fromCache"] is False
    assert data["score"] == 61 and data["level"] == "high"
    assert data["remaining"] == {"text": 2, "image": 2, "total": 2}

    again = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert again.status_code == 200, again.text
    assert again.json()["fromCache"] is True
    assert again.json()["analysisId"] == data["analysisId"]
    assert llm.calls == 1


async def test_scan_rejects_seller_identity(client, bearer, user, llm):
    uid = await user()
    body = _body(seller={"reviewCount": 0, "name": "Jan"})
    r = await client.post("/api/scans", json=body, headers=bearer(uid))
    assert r.status_code == 422
    error = r.json()["error"]
    assert error["code"] == "invalid_listing"
    assert error["details"]["field"] == "listing.seller.name"
    assert "Jan" not in r.text  # la valeur refusée n'est pas renvoyée
    assert llm.calls == 0


async def test_scan_accepts_new_price_types_and_seller_kind(client, bearer, user, llm):
    uid = await user()
    body = _body(priceType="on_request", seller={"reviewCount": 0, "sellerKind": "professional"})
    r = await client.post("/api/scans", json=body, headers=bearer(uid))
    assert r.status_code == 200, r.text
    assert r.json()["professional"] is False


async def test_scan_rejects_an_unknown_seller_kind(client, bearer, user, llm):
    uid = await user()
    body = _body(seller={"reviewCount": 0, "sellerKind": "shop"})
    r = await client.post("/api/scans", json=body, headers=bearer(uid))
    assert r.status_code == 422
    error = r.json()["error"]
    assert error["code"] == "invalid_listing"
    assert error["details"]["field"] == "listing.seller.sellerKind"
    assert llm.calls == 0


async def test_scan_requires_jwt(client, llm):
    r = await client.post("/api/scans", json=_body())
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"


async def test_scan_checks_jwt_before_the_listing(client, llm):
    r = await client.post("/api/scans", json=_body(seller={"name": "Jan"}))
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"


async def test_scan_rejects_more_than_ten_images(client, bearer, user, llm):
    uid = await user()
    images = [f"https://images.2dehands.com/api/{n}.jpg" for n in range(11)]
    r = await client.post("/api/scans", json=_body(images=images), headers=bearer(uid))
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_listing"
    assert r.json()["error"]["details"]["field"] == "listing.images"


@pytest.mark.parametrize(
    "content",
    [b"not json", b"{", b"[]", b'{"rules": {"version": 1, "signals": []}}', b""],
    ids=["text", "truncated", "array", "no-listing", "empty"],
)
async def test_scan_rejects_malformed_body(client, bearer, user, llm, content):
    uid = await user()
    headers = {**bearer(uid), "content-type": "application/json"}
    r = await client.post("/api/scans", content=content, headers=headers)
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "invalid_listing"
    expected = "listing" if content.startswith(b'{"') else "body"
    assert r.json()["error"]["details"]["field"] == expected


async def test_validation_elsewhere_keeps_invalid_request(client, bearer, user):
    uid = await user()
    r = await client.get("/api/scans/history", params={"limit": "x"}, headers=bearer(uid))
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"


async def test_scan_llm_failure_is_502_without_provider_text(client, bearer, user, llm):
    uid = await user()
    llm.error = ProviderFailure()
    r = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert r.status_code == 502
    error = r.json()["error"]
    assert error["code"] == "analysis_failed"
    assert error["details"] == {"reason": "transport"}
    assert PROVIDER_SECRET not in r.text and "fake" not in r.text


# --- GET /api/scans/history --------------------------------------------------------------


async def _three_scans(client, bearer, uid: str, llm: FakeLLM) -> list[dict]:
    """Deux scans réussis de la même annonce (le second depuis le cache), puis un échec."""
    first = await client.post("/api/scans", json=_body("m1"), headers=bearer(uid))
    second = await client.post("/api/scans", json=_body("m1"), headers=bearer(uid))
    llm.error = ProviderFailure()
    failed = await client.post("/api/scans", json=_body("m2"), headers=bearer(uid))
    llm.error = None
    assert [first.status_code, second.status_code, failed.status_code] == [200, 200, 502]
    return [first.json(), second.json()]


async def test_history_lists_scans_newest_first(client, bearer, user, llm):
    uid = await user()
    first, _second = await _three_scans(client, bearer, uid, llm)

    r = await client.get("/api/scans/history", headers=bearer(uid))
    assert r.status_code == 200, r.text
    data = r.json()
    items = data["items"]
    assert data["nextBefore"] is None
    assert len(items) == 3
    ids = [item["scanEventId"] for item in items]
    assert ids == sorted(ids, reverse=True)
    assert [item["failed"] for item in items] == [True, False, False]
    assert [item["fromCache"] for item in items] == [False, True, False]

    failed, cached, fresh = items
    assert {k: failed[k] for k in ("score", "level", "site", "title")} == {
        "score": None,
        "level": None,
        "site": None,
        "title": None,
    }
    for item in (cached, fresh):
        assert item["site"] == "2dehands.be"
        assert item["title"] == "Vélo de course"
        assert item["score"] == first["score"] and item["level"] == "high"
    assert {item["scanKind"] for item in items} == {"text"}
    assert {item["trigger"] for item in items} == {"button"}
    assert all(item["createdAt"] for item in items)


async def test_history_paginates_with_before(client, bearer, user, llm):
    uid = await user()
    await _three_scans(client, bearer, uid, llm)
    all_ids = [
        item["scanEventId"]
        for item in (await client.get("/api/scans/history", headers=bearer(uid))).json()["items"]
    ]

    page1 = (
        await client.get("/api/scans/history", params={"limit": 2}, headers=bearer(uid))
    ).json()
    assert [item["scanEventId"] for item in page1["items"]] == all_ids[:2]
    assert page1["nextBefore"] == all_ids[1]

    page2 = (
        await client.get(
            "/api/scans/history",
            params={"limit": 2, "before": page1["nextBefore"]},
            headers=bearer(uid),
        )
    ).json()
    assert [item["scanEventId"] for item in page2["items"]] == all_ids[2:]
    assert page2["nextBefore"] is None

    exact = (
        await client.get("/api/scans/history", params={"limit": 3}, headers=bearer(uid))
    ).json()
    assert len(exact["items"]) == 3 and exact["nextBefore"] is None


async def test_history_is_private(client, bearer, user, llm):
    owner = await user()
    other = await user()
    await _three_scans(client, bearer, owner, llm)
    owner_ids = {
        item["scanEventId"]
        for item in (await client.get("/api/scans/history", headers=bearer(owner))).json()["items"]
    }

    assert (await client.get("/api/scans/history", headers=bearer(other))).json() == {
        "items": [],
        "nextBefore": None,
    }
    own = await client.post("/api/scans", json=_body("m9"), headers=bearer(other))
    assert own.status_code == 200
    seen = (
        await client.get(
            "/api/scans/history", params={"before": max(owner_ids) + 10}, headers=bearer(other)
        )
    ).json()["items"]
    assert len(seen) == 1 and seen[0]["scanEventId"] not in owner_ids


async def test_history_result_wins_over_failure(client, bearer, user, llm, db):
    # Annulation juste après le commit du résultat : le scan a les deux lignes (règle R13).
    uid = await user()
    done = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert done.status_code == 200
    await db.execute(
        text(
            "insert into app.scan_failures(scan_event_id, error_code)"
            " select scan_event_id, 'internal' from app.scan_results"
            " join app.scan_events e on e.id = scan_event_id where e.user_id = :uid"
        ),
        {"uid": uid},
    )
    await db.commit()

    [item] = (await client.get("/api/scans/history", headers=bearer(uid))).json()["items"]
    assert item["failed"] is False
    assert item["score"] == done.json()["score"] and item["site"] == "2dehands.be"


async def test_history_requires_jwt(client):
    r = await client.get("/api/scans/history")
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"


@pytest.mark.parametrize("limit", [0, 51])
async def test_history_limit_bounds(client, bearer, user, limit):
    uid = await user()
    r = await client.get("/api/scans/history", params={"limit": limit}, headers=bearer(uid))
    assert r.status_code == 422


# --- Câblage de l'application ------------------------------------------------------------


async def test_lifespan_creates_dedicated_photo_client(settings, test_key_pair):
    jwks = make_jwks(test_key_pair)

    async def jwks_fetcher() -> dict:
        return jwks

    application = create_app(settings, jwks_fetcher=jwks_fetcher)
    async with application.router.lifespan_context(application):
        photos: httpx.AsyncClient = application.state.http_images
        assert photos.trust_env is False
        assert photos.follow_redirects is False
        assert photos.auth is None
        assert not photos.cookies
        assert "authorization" not in photos.headers
        assert not photos.is_closed

        llm_for = application.state.llm_for
        code = next(iter(application.state.providers))
        client = llm_for(code)
        assert isinstance(client, OpenAICompatibleClient)
        assert llm_for(code) is client
        others = [llm_for(c) for c in application.state.providers if c != code]
        assert all(other is not client for other in others)
        with pytest.raises(ProviderError):
            llm_for("unknown-provider")
    assert photos.is_closed


def test_http_loggers_are_quiet(settings):
    for name in ("httpx", "httpcore", "openai"):
        logging.getLogger(name).setLevel(logging.DEBUG)
    create_app(settings)
    for name in ("httpx", "httpcore", "openai"):
        assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING


# --- Bornes des champs envoyés au LLM (règle R14) ---------------------------------------------


def _with_signal_params(params: dict) -> dict:
    body = _body()
    body["rules"]["signals"] = [
        {"id": "foreign_location", "weight": 20, "severity": "warning", "params": params}
    ]
    return body


_LISTING_BOUNDS = [
    ("category", 200),
    ("condition", 100),
    ("postedAt", 64),
]
_LOCATION_BOUNDS = [("city", 100), ("region", 100), ("country", 100)]


@pytest.mark.parametrize(("field", "limit"), _LISTING_BOUNDS)
async def test_listing_text_field_over_its_bound_is_invalid_listing(
    client, bearer, user, llm, field, limit
):
    uid = await user()
    r = await client.post(
        "/api/scans", json=_body(**{field: "x" * (limit + 1)}), headers=bearer(uid)
    )
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "invalid_listing"
    assert r.json()["error"]["details"]["field"] == f"listing.{field}"
    assert llm.calls == 0


@pytest.mark.parametrize(("field", "limit"), _LOCATION_BOUNDS)
async def test_location_field_over_its_bound_is_invalid_listing(
    client, bearer, user, llm, field, limit
):
    uid = await user()
    body = _body(location={field: "x" * (limit + 1)})
    r = await client.post("/api/scans", json=body, headers=bearer(uid))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "invalid_listing"
    assert r.json()["error"]["details"]["field"] == f"listing.location.{field}"
    assert llm.calls == 0


async def test_listing_fields_at_their_exact_bounds_are_accepted(client, bearer, user, llm):
    uid = await user()
    body = _body(
        **{field: "x" * limit for field, limit in _LISTING_BOUNDS},
        location={field: "x" * limit for field, limit in _LOCATION_BOUNDS},
    )
    r = await client.post("/api/scans", json=body, headers=bearer(uid))
    assert r.status_code == 200, r.text


@pytest.mark.parametrize(
    "params",
    [
        {f"k{n}": n for n in range(11)},
        {"k" * 41: 1},
        {"": 1},
        {"country": "x" * 201},
    ],
    ids=["11-entries", "41-char-key", "empty-key", "201-char-value"],
)
async def test_signal_params_over_their_bounds_are_invalid_listing(
    client, bearer, user, llm, params
):
    uid = await user()
    r = await client.post("/api/scans", json=_with_signal_params(params), headers=bearer(uid))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "invalid_listing"
    assert r.json()["error"]["details"]["field"].startswith("rules.signals.0.params")
    assert llm.calls == 0


async def test_signal_params_at_their_exact_bounds_are_accepted(client, bearer, user, llm):
    uid = await user()
    params: dict = {f"{n:02d}" + "k" * 38: n for n in range(9)}
    params["v" * 40] = "x" * 200
    assert len(params) == 10
    r = await client.post("/api/scans", json=_with_signal_params(params), headers=bearer(uid))
    assert r.status_code == 200, r.text


async def test_real_extension_signal_params_are_accepted(client, bearer, user, llm):
    """Paramètres réellement émis par les règles de l'extension (apps/extension/lib/rules)."""
    uid = await user()
    body = _body()
    body["rules"]["signals"] = [
        {"id": "few_photos", "weight": 15, "severity": "warning", "params": {"count": 0}},
        {
            "id": "foreign_location",
            "weight": 20,
            "severity": "warning",
            "params": {"country": "NL"},
        },
        {"id": "contact_outside", "weight": 25, "severity": "danger", "params": {"kind": "phone"}},
    ]
    r = await client.post("/api/scans", json=body, headers=bearer(uid))
    assert r.status_code == 200, r.text


# --- Scan « image » sans photo -------------------------------------------------------------


async def test_image_scan_without_images_is_invalid_listing_before_reserving(
    client, bearer, user, llm, db
):
    uid = await user()
    body = {**_body(), "scanKind": "image"}
    r = await client.post("/api/scans", json=body, headers=bearer(uid))
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert error["code"] == "invalid_listing"
    assert error["details"]["field"] == "listing.images"
    assert llm.calls == 0
    events = await db.scalar(
        text("select count(*) from app.scan_events where user_id = :uid"), {"uid": uid}
    )
    assert events == 0
