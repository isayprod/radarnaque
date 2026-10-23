import logging
from collections.abc import Awaitable, Callable
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from jwt_helpers import make_jwks
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.config import Settings
from radarnaque_api.llm.client import (
    Bilingual,
    LLMAnalysis,
    LLMError,
    LLMReason,
    LLMResult,
    OpenAICompatibleClient,
)
from radarnaque_api.llm.events import EventSink
from radarnaque_api.llm.providers import ProviderError
from radarnaque_api.llm.tools import WebSearchTool
from radarnaque_api.main import create_app
from radarnaque_api.search import SearchHit
from radarnaque_api.services import scans as scans_service

# Analyse seule : l'identification qui la précède a ses propres tests (test_identify_routes.py,
# test_scan_service.py).
pytestmark = pytest.mark.usefixtures("without_identification")

PROVIDER_SECRET = "provider-secret-body-9c41"


class FakeLLM:
    """Faux client LLM : `error` le fait échouer, chaque appel rend un score différent."""

    def __init__(self) -> None:
        self.error: Exception | None = None
        self.calls = 0

    def llm_for(self, provider: str) -> "FakeLLM":
        return self

    async def analyze(
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict],
        tools: WebSearchTool | None = None,
        on_event: EventSink | None = None,
    ) -> LLMResult:
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
    assert data["remaining"] == {"scans": 2}
    assert data["imagesAnalyzed"] == 0 and data["webSearches"] == []

    again = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert again.status_code == 200, again.text
    assert again.json()["fromCache"] is True
    assert again.json()["analysisId"] == data["analysisId"]
    assert llm.calls == 1


class _SearchingLLM(FakeLLM):
    """Faux client qui fait une recherche web par l'outil reçu (le moteur de `app.state`)."""

    async def analyze(self, *, tools: WebSearchTool | None = None, **kw) -> LLMResult:
        assert tools is not None
        await tools.run('{"query": "velo de course prix", "aspect": "price"}')
        result = await super().analyze(**kw)
        result.searches = tools.records
        return result


class _OneHitBackend:
    async def search(self, query: str) -> list[SearchHit]:
        return [SearchHit(title="Vélo", url="https://exemple.be/velo", snippet="Prix")]


async def test_scan_without_stream_has_web_searches_and_images(
    app, client, bearer, user, monkeypatch
):
    """`POST /api/scans` passe par le même code que le flux : moteur de recherche de
    l'application, photos, et réponse `AnalysisResultOut` complète."""

    async def fake_fetch(urls, suffixes, *, http, resolve, limit):
        return ["aW1n"] * min(limit, len(urls))

    monkeypatch.setattr(scans_service, "fetch_images", fake_fetch)
    fake = _SearchingLLM()
    app.state.llm_for = fake.llm_for
    app.state.search = _OneHitBackend()
    uid = await user()
    images = ["https://images.2dehands.com/api/a.jpg", "https://images.2dehands.com/api/b.jpg"]

    r = await client.post("/api/scans", json=_body(images=images), headers=bearer(uid))

    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/json"
    data = r.json()
    assert data["imagesAnalyzed"] == 2
    assert data["webSearches"] == [{"query": "velo de course prix", "aspect": "price"}]


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


async def test_superuser_scans_without_subscription_outside_production(
    client, bearer, make_user, llm
):
    uid = await make_user("superuser@radarnaque.test", role="superuser")
    for i in range(31):  # au-delà de la limite de requêtes (30 par minute)
        r = await client.post("/api/scans", json=_body(f"m{i}"), headers=bearer(uid))
        assert r.status_code == 200, r.text
    assert r.json()["remaining"] == {"scans": None}


async def test_superuser_without_subscription_gets_402_in_production(
    client, bearer, make_user, llm, production, caplog
):
    uid = await make_user("superuser@radarnaque.test", role="superuser")
    with caplog.at_level(logging.WARNING, logger="radarnaque.privileges"):
        r = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert r.status_code == 402
    assert r.json()["error"]["code"] == "no_active_subscription"
    assert "rôle superuser ignoré en production" in caplog.text
    assert llm.calls == 0


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
    assert {item["scanKind"] for item in items} == {"full"}
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


# --- Le type de scan n'est plus un choix du client ---------------------------------------------


async def test_scan_in_rejects_scan_kind_before_reserving(client, bearer, user, llm, db):
    uid = await user()
    body = {**_body(), "scanKind": "image"}
    r = await client.post("/api/scans", json=body, headers=bearer(uid))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "invalid_listing"
    assert r.json()["error"]["details"]["field"] == "scanKind"
    assert llm.calls == 0
    events = await db.scalar(
        text("select count(*) from app.scan_events where user_id = :uid"), {"uid": uid}
    )
    assert events == 0


# --- Bloc debug du superuser et logger de debug -------------------------------------------------


async def test_scan_response_has_debug_only_for_a_superuser(client, bearer, make_user, user, llm):
    superuser = await make_user("superuser@radarnaque.test", role="superuser")
    admin = await make_user(f"{uuid4().hex}@b.test", role="admin")
    ordinary = await user()

    r = await client.post("/api/scans", json=_body("s1"), headers=bearer(superuser))
    assert r.status_code == 200, r.text
    debug = r.json()["debug"]
    assert debug["llmCalled"] is True and debug["fromCache"] is False
    assert debug["promptVersion"] == {"scanKind": "full", "version": 3}
    assert debug["analysisId"] == r.json()["analysisId"]
    assert "Bearer" not in r.text  # le JWT reçu n'est jamais renvoyé

    for uid in (admin, ordinary):
        r = await client.post("/api/scans", json=_body(f"o-{uid}"), headers=bearer(uid))
        assert r.status_code == 200, r.text
        assert r.json()["debug"] is None


async def test_no_cache_is_accepted_and_honoured_only_for_a_superuser(
    client, bearer, make_user, user, llm
):
    superuser = await make_user("superuser@radarnaque.test", role="superuser")
    ordinary = await user()
    body = {**_body(), "noCache": True}

    responses = [
        await client.post("/api/scans", json=body, headers=bearer(ordinary)) for _ in range(2)
    ]
    assert [r.status_code for r in responses] == [200, 200]
    assert llm.calls == 1  # ignoré pour un compte ordinaire
    assert responses[1].json()["fromCache"] is True
    assert responses[1].json()["remaining"]["scans"] == 1

    again = await client.post("/api/scans", json=body, headers=bearer(superuser))
    assert again.status_code == 200, again.text
    assert llm.calls == 2  # relance sans cache
    assert again.json()["analysisId"] == responses[0].json()["analysisId"]
    assert again.json()["debug"]["llmCalled"] is True


def _debug_handlers() -> list[logging.Handler]:
    return [
        h
        for h in logging.getLogger("radarnaque.debug").handlers
        if getattr(h, "radarnaque_debug", False)
    ]


@pytest.fixture
def bare_debug_logger():
    """Logger de debug sans son gestionnaire console, rétabli après le test."""
    logger = logging.getLogger("radarnaque.debug")
    saved = (list(logger.handlers), logger.level, logger.propagate)
    for handler in _debug_handlers():
        logger.removeHandler(handler)
    logger.propagate = True
    yield logger
    logger.handlers[:] = saved[0]
    logger.setLevel(saved[1])
    logger.propagate = saved[2]


def test_debug_logger_has_one_console_handler_outside_production(settings, bare_debug_logger):
    create_app(settings)
    create_app(settings)  # plusieurs applications (tests) : pas de doublon
    [handler] = _debug_handlers()
    assert isinstance(handler, logging.StreamHandler)
    assert bare_debug_logger.level == logging.INFO
    assert bare_debug_logger.propagate is False


def test_debug_logger_is_silenced_in_production(settings, bare_debug_logger):
    """En production : aucune console, un seul NullHandler et aucune propagation (rien ne
    remonte aux gestionnaires de la racine), même après plusieurs applications."""
    prod = Settings.model_validate({**settings.model_dump(), "env": "production"})
    create_app(prod)
    create_app(prod)
    assert _debug_handlers() == []
    [handler] = bare_debug_logger.handlers
    assert isinstance(handler, logging.NullHandler)
    assert bare_debug_logger.propagate is False
