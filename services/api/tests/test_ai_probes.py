"""Essais de l'admin : un modèle sur une annonce fictive, une recherche hors cache, et l'état
du moteur de recherche (`/healthz`)."""

import logging
from collections.abc import Iterator

import httpx
import psycopg
import pytest
import respx
from sqlalchemy import text
from test_scans_routes import FakeLLM

from radarnaque_api.llm.client import LLMError, LLMResult
from radarnaque_api.llm.providers import ProviderError
from radarnaque_api.main import _quiet_http_loggers as quiet_http_loggers
from radarnaque_api.main import create_app
from radarnaque_api.search import SearxngBackend
from radarnaque_api.services.ai_probes import (
    PROBE_LISTING,
    PROBE_RULES,
    SearchHealth,
    probe_search,
)

ADMIN_EMAIL = "admin@radarnaque.test"
BASE = "http://searxng.test"
PHONE = "0470 12 34 56"
MODEL_URL = "/api/admin/ai/models/{}/test"


@pytest.fixture(autouse=True)
def _restore_models(pg_url: str) -> Iterator[None]:
    """Ces tests ajoutent des modèles au référentiel, que la purge de `conftest.py` ne touche
    pas : ils sont retirés après chacun."""
    url = pg_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(url, autocommit=True) as conn:
        max_model = conn.execute("select coalesce(max(id), 0) from app.models").fetchone()[0]
    yield
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("delete from app.models where id > %s", (max_model,))


@pytest.fixture
async def admin(make_user) -> str:
    return await make_user(ADMIN_EMAIL, "admin")


class RecordingLLM(FakeLLM):
    """Garde ce que reçoit le client ; sa réponse porte un texte brut."""

    def __init__(self) -> None:
        super().__init__()
        self.received: list[dict] = []

    async def analyze(self, *, model, system_prompt, messages, tools=None, on_event=None):
        self.received.append(
            {"model": model, "system_prompt": system_prompt, "messages": messages, "tools": tools}
        )
        result: LLMResult = await super().analyze(
            model=model, system_prompt=system_prompt, messages=messages, tools=tools
        )
        result.raw_text = '{"score": 61}'
        return result


@pytest.fixture
def llm(app) -> RecordingLLM:
    fake = RecordingLLM()
    app.state.llm_for = fake.llm_for
    return fake


async def _add_model(client, bearer, admin, provider: str, slug: str) -> int:
    r = await client.post(
        "/api/admin/ai/models", json={"provider": provider, "slug": slug}, headers=bearer(admin)
    )
    assert r.status_code == 200, r.text
    return next(m["id"] for m in r.json()["models"] if m["slug"] == slug)


async def _count(db, table: str) -> int:
    await db.rollback()
    return (await db.execute(text(f"select count(*) from app.{table}"))).scalar_one()


class _Handler:
    """Faux SearXNG : compte les appels et garde les requêtes."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        results = [{"title": "Vélo", "url": "https://exemple.be/velo", "content": "Prix"}]
        return httpx.Response(200, json={"results": results})


def _searxng(handler) -> SearxngBackend:
    return SearxngBackend(BASE, httpx.AsyncClient(transport=httpx.MockTransport(handler)))


# --- Essai d'un modèle ----------------------------------------------------------------------


def test_probe_listing_is_the_fixed_fictional_ad():
    assert PROBE_LISTING.title == "Vélo de course aluminium, taille 56"
    assert PROBE_LISTING.price is not None and PROBE_LISTING.price.amount_cents == 25000
    assert PROBE_LISTING.images == []
    assert PROBE_RULES.signals == []


async def test_model_test_calls_fake_llm_with_probe_listing(client, db, bearer, admin, llm):
    model_id = await _add_model(client, bearer, admin, "stub", "essai/modele")
    prompt = await _scalar_prompt(db)
    actions = await _count(db, "admin_actions")  # l'ajout du modèle y a laissé une ligne
    r = await client.post(MODEL_URL.format(model_id), headers=bearer(admin))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["ok"] is True and data["error"] is None
    assert data["score"] == 61
    assert data["tokensIn"] == 100 and data["tokensOut"] == 10
    assert data["raw"] == '{"score": 61}'
    assert isinstance(data["durationMs"], int) and data["durationMs"] >= 0

    (received,) = llm.received
    assert received["model"] == "essai/modele"
    assert received["system_prompt"] == prompt  # le prompt actif
    assert received["tools"] is None
    content = received["messages"][0]["content"]
    assert all(part["type"] == "text" for part in content)  # aucune photo
    assert "Vélo de course aluminium, taille 56" in content[0]["text"]

    # Rien n'est écrit : ni scan, ni analyse, ni appel LLM comptabilisé.
    for table in ("scan_events", "analyses", "llm_calls"):
        assert await _count(db, table) == 0
    assert await _count(db, "admin_actions") == actions


async def _scalar_prompt(db) -> str:
    await db.rollback()
    return (
        await db.execute(
            text(
                "select p.system_prompt from app.prompt_versions p"
                " join app.scan_kinds k on k.active_prompt_version_id = p.id"
                " where k.code = 'full'"
            )
        )
    ).scalar_one()


@pytest.mark.parametrize("code", ["transport", "timeout", "invalid_response", "configuration"])
async def test_model_test_llm_error_is_ok_false(client, bearer, admin, llm, code):
    llm.error = LLMError(code, "stub")
    model_id = await _add_model(client, bearer, admin, "stub", "essai/modele")
    r = await client.post(MODEL_URL.format(model_id), headers=bearer(admin))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["ok"] is False and data["error"] == code
    assert data["score"] is None and data["tokensIn"] == 0 and data["raw"] == ""


async def test_model_test_unknown_provider_is_configuration(app, client, bearer, admin):
    def refuse(provider: str):
        raise ProviderError("fournisseur inconnu dans providers.toml : stub")

    model_id = await _add_model(client, bearer, admin, "stub", "essai/modele")
    app.state.llm_for = refuse
    r = await client.post(MODEL_URL.format(model_id), headers=bearer(admin))
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False and r.json()["error"] == "configuration"


async def test_model_test_timeout_is_timeout(app, client, bearer, admin, llm):
    import asyncio

    async def slow(**_kwargs):
        await asyncio.sleep(5)

    llm.analyze = slow  # type: ignore[method-assign]
    app.state.analysis_timeout_s = 0.05
    model_id = await _add_model(client, bearer, admin, "stub", "essai/modele")
    r = await client.post(MODEL_URL.format(model_id), headers=bearer(admin))
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False and r.json()["error"] == "timeout"


async def test_model_test_missing_key_is_configuration_without_network(
    client, bearer, admin, monkeypatch
):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    model_id = await _add_model(client, bearer, admin, "openrouter", "essai/sans-cle")
    with respx.mock(assert_all_called=False) as router:
        route = router.route().mock(side_effect=AssertionError("appel réseau"))
        r = await client.post(MODEL_URL.format(model_id), headers=bearer(admin))
        assert not route.called
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["ok"] is False and data["error"] == "configuration"


async def test_model_test_unknown_model_is_404(client, bearer, admin, llm):
    r = await client.post(MODEL_URL.format(999999), headers=bearer(admin))
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"
    assert llm.calls == 0


async def test_model_test_rate_limit(client, bearer, admin, make_user, llm):
    other = await make_user("autre-admin@radarnaque.test", "admin")
    model_id = await _add_model(client, bearer, admin, "stub", "essai/modele")
    for _ in range(10):
        assert (
            await client.post(MODEL_URL.format(model_id), headers=bearer(admin))
        ).status_code == 200
    r = await client.post(MODEL_URL.format(model_id), headers=bearer(admin))
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "rate_limited"
    assert llm.calls == 10  # le 11e n'a pas appelé le modèle
    assert (await client.post(MODEL_URL.format(model_id), headers=bearer(other))).status_code == 200


async def test_probe_routes_require_admin(client, bearer, make_user):
    uid = await make_user("simple@radarnaque.test")
    for headers in ({}, bearer(uid)):
        r = await client.post(MODEL_URL.format(1), headers=headers)
        assert r.status_code == (401 if not headers else 403)
        r = await client.post("/api/admin/ai/search-test", json={"query": "x"}, headers=headers)
        assert r.status_code == (401 if not headers else 403)


# --- Recherche hors cache -------------------------------------------------------------------


async def test_search_fresh_bypasses_cache():
    handler = _Handler()
    backend = _searxng(handler)
    await backend.search("vélo de course")
    await backend.search("vélo de course")
    assert len(handler.requests) == 1 and backend.cache_entries == 1
    hits = await backend.search("vélo de course", fresh=True)
    assert len(handler.requests) == 2 and len(hits) == 1
    assert backend.cache_entries == 1


async def test_search_fresh_does_not_write_the_cache():
    handler = _Handler()
    backend = _searxng(handler)
    await backend.search("vélo", fresh=True)
    assert backend.cache_entries == 0
    await backend.search("vélo")  # rien en cache : nouvel appel, puis mémorisé
    assert len(handler.requests) == 2 and backend.cache_entries == 1


async def test_search_test_masks_contacts_and_limits(app, client, bearer, admin):
    handler = _Handler()
    app.state.search = _searxng(handler)
    r = await client.post(
        "/api/admin/ai/search-test",
        json={"query": f"vélo {PHONE} {ADMIN_EMAIL}"},
        headers=bearer(admin),
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "ok" and data["count"] == 1
    assert "<resultats_recherche>" in data["text"] and "exemple.be/velo" in data["text"]
    sent = str(handler.requests[0].url)
    for secret in ("0470", "12%2034", ADMIN_EMAIL, "radarnaque.test"):
        assert secret not in sent and secret not in data["text"]

    for _ in range(29):
        assert (
            await client.post(
                "/api/admin/ai/search-test", json={"query": "x"}, headers=bearer(admin)
            )
        ).status_code == 200
    r = await client.post("/api/admin/ai/search-test", json={"query": "x"}, headers=bearer(admin))
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"


async def test_search_test_is_fresh_and_does_not_fill_the_cache(app, client, bearer, admin):
    handler = _Handler()
    backend = _searxng(handler)
    app.state.search = backend
    for _ in range(2):
        r = await client.post(
            "/api/admin/ai/search-test", json={"query": "vélo"}, headers=bearer(admin)
        )
        assert r.status_code == 200
    assert len(handler.requests) == 2 and backend.cache_entries == 0


async def test_search_test_disabled_when_engine_is_none(client, bearer, admin):
    r = await client.post(
        "/api/admin/ai/search-test", json={"query": "vélo"}, headers=bearer(admin)
    )
    assert r.status_code == 200
    assert r.json() == {"status": "disabled", "count": 0, "text": ""}


async def test_search_test_down_when_engine_fails():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    out = await probe_search(_searxng(handler), "vélo")
    assert (out.status, out.count, out.text) == ("down", 0, "")


async def test_search_test_empty_result_is_ok_with_count_zero():
    out = await probe_search(_searxng(lambda r: httpx.Response(200, json={"results": []})), "vélo")
    assert out.status == "ok" and out.count == 0
    assert "Aucun résultat." in out.text


@pytest.mark.parametrize("query", ["", "x" * 201])
async def test_search_test_query_length_is_validated(client, bearer, admin, query):
    r = await client.post("/api/admin/ai/search-test", json={"query": query}, headers=bearer(admin))
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"


async def test_search_test_accepts_200_characters(client, bearer, admin):
    r = await client.post(
        "/api/admin/ai/search-test", json={"query": "x" * 200}, headers=bearer(admin)
    )
    assert r.status_code == 200


# --- État du moteur -------------------------------------------------------------------------


class _Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _health(handler, clock: _Clock | None = None, base: str = BASE) -> SearchHealth:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return SearchHealth(http, base, now=clock or _Clock())


async def test_search_health_ok_then_down_on_error_status():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text="OK")

    assert await _health(handler, base=BASE + "/").status() == "ok"
    assert seen[0].url.path == "/healthz" and seen[0].method == "GET"
    assert await _health(lambda r: httpx.Response(503)).status() == "down"


async def test_search_health_timeout_is_down():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("trop lent", request=request)

    assert await _health(handler).status() == "down"


async def test_search_health_asks_with_a_3_second_timeout():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200)

    await _health(handler).status()
    assert seen[0].extensions["timeout"]["read"] == 3.0


async def test_search_health_is_kept_for_60_seconds():
    clock = _Clock()
    answers = [httpx.Response(200), httpx.Response(503)]
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return answers[len(calls) - 1]

    health = _health(handler, clock)
    assert await health.status() == "ok"
    clock.t += 59
    assert await health.status() == "ok" and len(calls) == 1  # mémorisé : aucune requête
    clock.t += 1
    assert await health.status() == "down" and len(calls) == 2  # 60 s : on redemande


async def test_overview_search_is_disabled_when_engine_is_none(client, bearer, admin):
    data = (await client.get("/api/admin/ai", headers=bearer(admin))).json()
    assert data["search"] == {
        "backend": "none",
        "url": None,
        "status": "disabled",
        "cacheEntries": None,
    }


async def test_overview_search_reports_health_and_cache_size(app, client, bearer, admin):
    app.state.settings = app.state.settings.model_copy(
        update={"search_backend": "searxng", "searxng_url": "http://moi:mdp@searx.test:8080/x"}
    )
    backend = _searxng(_Handler())
    await backend.search("vélo")
    app.state.search = backend
    app.state.search_health = _health(lambda r: httpx.Response(200))
    data = (await client.get("/api/admin/ai", headers=bearer(admin))).json()
    assert data["search"] == {
        "backend": "searxng",
        "url": "http://searx.test:8080/x",
        "status": "ok",
        "cacheEntries": 1,
    }
    app.state.search_health = _health(lambda r: httpx.Response(503))
    data = (await client.get("/api/admin/ai", headers=bearer(admin))).json()
    assert data["search"]["status"] == "down"


async def test_lifespan_wires_search_health(settings):
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        assert app.state.search_health is None  # SEARCH_BACKEND=none
    on = create_app(settings.model_copy(update={"search_backend": "searxng"}))
    async with on.router.lifespan_context(on):
        assert isinstance(on.state.search_health, SearchHealth)


# --- Journal --------------------------------------------------------------------------------


async def test_probe_requests_not_logged(app, client, bearer, admin, llm, caplog):
    secret = "zebulon-introuvable"
    app.state.search = _searxng(_Handler())
    model_id = await _add_model(client, bearer, admin, "stub", "essai/modele")
    with caplog.at_level(logging.DEBUG):
        quiet_http_loggers()  # la protection de create_app, que caplog (racine en DEBUG) lève
        r = await client.post(
            "/api/admin/ai/search-test",
            json={"query": f"{secret} {PHONE}"},
            headers=bearer(admin),
        )
        assert r.status_code == 200
        r = await client.post(MODEL_URL.format(model_id), headers=bearer(admin))
        assert r.status_code == 200
    for name in ("httpx", "httpcore", "openai"):
        logging.getLogger(name).setLevel(logging.NOTSET)
    assert secret not in caplog.text and PHONE not in caplog.text
    assert ADMIN_EMAIL not in caplog.text
