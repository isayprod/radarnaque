"""API IA de l'admin : vue d'ensemble, modèles, prompts, réglages."""

import asyncio
import json
import logging
from collections.abc import Iterator
from uuid import uuid4

import psycopg
import pytest
from sqlalchemy import text
from test_scans_routes import FakeLLM, _body

from radarnaque_api.llm.client import LLMResult
from radarnaque_api.llm.events import EventSink
from radarnaque_api.llm.tools import WebSearchTool
from radarnaque_api.search import SearchHit

ADMIN_EMAIL = "admin@radarnaque.test"
PROMPT = "Tu es un expert des arnaques en ligne. " * 8  # 304 caractères
SECRET_KEY = "sk-valeur-secrete-a-ne-jamais-rendre-7f3a"


@pytest.fixture
async def admin(make_user) -> str:
    return await make_user(ADMIN_EMAIL, "admin")


@pytest.fixture(autouse=True)
def _restore_ai_state(pg_url: str) -> Iterator[None]:
    """Ces tests modifient le référentiel (modèles, prompts, réglages, version active) que la
    purge de `conftest.py` ne touche pas : il est remis en l'état après chacun."""
    url = pg_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(url, autocommit=True) as conn:
        kinds = conn.execute(
            "select code, active_model_id, active_prompt_version_id from app.scan_kinds"
        ).fetchall()
        settings = conn.execute(
            "select cache_ttl_hours, rate_limit_per_minute, max_web_searches from app.settings"
        ).fetchone()
        max_model = conn.execute("select coalesce(max(id), 0) from app.models").fetchone()[0]
        max_prompt = conn.execute(
            "select coalesce(max(id), 0) from app.prompt_versions"
        ).fetchone()[0]
    yield
    with psycopg.connect(url, autocommit=True) as conn:
        # Les analyses des tests référencent les modèles et prompts ajoutés.
        conn.execute("truncate app.analyses cascade")
        conn.execute("truncate app.admin_actions")
        for code, model_id, prompt_id in kinds:
            conn.execute(
                "update app.scan_kinds set active_model_id = %s, active_prompt_version_id = %s"
                " where code = %s",
                (model_id, prompt_id, code),
            )
        conn.execute("delete from app.prompt_versions where id > %s", (max_prompt,))
        conn.execute("delete from app.models where id > %s", (max_model,))
        conn.execute(
            "update app.settings set cache_ttl_hours = %s, rate_limit_per_minute = %s,"
            " max_web_searches = %s",
            settings,
        )


async def _scalar(db, sql: str, **params):
    await db.rollback()  # relire l'état validé
    return (await db.execute(text(sql), params)).scalar_one()


async def _actions(db) -> list[tuple]:
    await db.rollback()
    rows = await db.execute(
        text(
            "select action, admin_user_id, target_user_id, details"
            " from app.admin_actions order by id"
        )
    )
    return [tuple(r) for r in rows]


async def _count_actions(db) -> int:
    return await _scalar(db, "select count(*) from app.admin_actions")


async def _overview(client, bearer, admin) -> dict:
    r = await client.get("/api/admin/ai", headers=bearer(admin))
    assert r.status_code == 200, r.text
    return r.json()


async def _add_model(client, bearer, admin, provider="stub", slug="nouveau/modele") -> dict:
    r = await client.post(
        "/api/admin/ai/models", json={"provider": provider, "slug": slug}, headers=bearer(admin)
    )
    assert r.status_code == 200, r.text
    return next(m for m in r.json()["models"] if m["slug"] == slug and m["provider"] == provider)


async def _create_prompt(client, bearer, admin, text_: str = PROMPT):
    return await client.post(
        "/api/admin/ai/prompts", json={"systemPrompt": text_}, headers=bearer(admin)
    )


# --- Accès ----------------------------------------------------------------------------------


async def test_routes_require_admin(client, bearer, make_user):
    uid = await make_user("simple@radarnaque.test")
    calls = [
        ("GET", "/api/admin/ai", None),
        ("POST", "/api/admin/ai/models", {"provider": "stub", "slug": "x"}),
        ("POST", "/api/admin/ai/active-model", {"modelId": 1}),
        ("GET", "/api/admin/ai/prompts/1", None),
        ("POST", "/api/admin/ai/prompts", {"systemPrompt": PROMPT}),
        ("POST", "/api/admin/ai/prompts/1/activate", None),
        ("PATCH", "/api/admin/ai/settings", {"maxWebSearches": 1}),
    ]
    for method, url, body in calls:
        r = await client.request(method, url, json=body)
        assert r.status_code == 401, (method, url)
        r = await client.request(method, url, json=body, headers=bearer(uid))
        assert r.status_code == 403, (method, url)
        assert r.json()["error"]["code"] == "admin_required"


# --- Vue d'ensemble -------------------------------------------------------------------------


async def test_overview_shape(client, db, bearer, admin, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    data = await _overview(client, bearer, admin)

    providers = {p["code"]: p for p in data["providers"]}
    assert set(providers) == {"openrouter", "groq", "openai-oauth", "omniroute", "ollama", "stub"}
    assert providers["stub"] == {
        "code": "stub",
        "api": "chat",
        "structuredOutput": "json_schema",
        "reasoningEffort": None,  # "none" dans providers.toml
        "maxImages": None,
        "key": "not_required",
    }
    assert providers["openrouter"]["reasoningEffort"] == "low"
    assert providers["openrouter"]["key"] == "absent"
    assert providers["groq"]["maxImages"] == 3
    assert providers["openai-oauth"]["api"] == "responses"
    assert providers["openai-oauth"]["key"] == "not_required"

    active = await _scalar(db, "select active_model_id from app.scan_kinds where code = 'full'")
    assert data["activeModelId"] == active
    assert [m["id"] for m in data["models"] if m["active"]] == [active]
    assert all(m["knownProvider"] for m in data["models"])
    assert {"id", "provider", "slug", "analyses"} <= set(data["models"][0])

    active_prompt = await _scalar(
        db, "select active_prompt_version_id from app.scan_kinds where code = 'full'"
    )
    assert data["activePromptVersionId"] == active_prompt
    assert [p["version"] for p in data["prompts"]] == sorted(
        (p["version"] for p in data["prompts"]), reverse=True
    )
    assert [p["id"] for p in data["prompts"] if p["active"]] == [active_prompt]
    assert "systemPrompt" not in json.dumps(data)  # le texte n'est jamais dans la vue d'ensemble

    assert set(data["settings"]) == {"cacheTtlHours", "rateLimitPerMinute", "maxWebSearches"}
    assert data["search"] == {
        "backend": "none",
        "url": None,
        "status": "disabled",
        "cacheEntries": None,
    }
    assert data["actions"] == []


async def test_overview_key_state_never_shows_the_value(client, bearer, admin, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET_KEY)
    r = await client.get("/api/admin/ai", headers=bearer(admin))
    assert r.status_code == 200
    providers = {p["code"]: p for p in r.json()["providers"]}
    assert providers["openrouter"]["key"] == "present"
    assert SECRET_KEY not in r.text
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    providers = {p["code"]: p for p in (await _overview(client, bearer, admin))["providers"]}
    assert providers["openrouter"]["key"] == "absent"  # variable vide : comme absente


async def test_overview_counts_analyses_per_model_and_prompt(
    client, db, bearer, admin, make_user, llm
):
    uid = await make_user("abonne@radarnaque.test")
    await _subscribe(db, uid)
    r = await client.post("/api/scans", json=_body("m1"), headers=bearer(uid))
    assert r.status_code == 200, r.text
    data = await _overview(client, bearer, admin)
    assert [m["analyses"] for m in data["models"] if m["active"]] == [1]
    assert sum(m["analyses"] for m in data["models"]) == 1
    assert [p["analyses"] for p in data["prompts"] if p["active"]] == [1]


async def test_overview_search_url_hides_credentials(app, client, bearer, admin):
    settings = app.state.settings
    app.state.settings = settings.model_copy(
        update={"search_backend": "searxng", "searxng_url": "http://moi:mdp@searx.test:8080/x"}
    )
    data = await _overview(client, bearer, admin)
    # Le moteur répond en tâche 7 ; d'ici là, un moteur actif est annoncé « down ».
    assert data["search"] == {
        "backend": "searxng",
        "url": "http://searx.test:8080/x",
        "status": "down",
        "cacheEntries": None,
    }
    assert "mdp" not in json.dumps(data) and "moi" not in json.dumps(data)


async def test_overview_lists_only_the_20_last_ai_actions(client, db, bearer, admin):
    for i in range(22):
        await db.execute(
            text(
                "insert into app.admin_actions(admin_user_id, action, details)"
                " values (:a, :c, '{}')"
            ),
            {"a": admin, "c": "ai.settings_set" if i % 2 else "user.plan_set"},
        )
    await db.commit()
    actions = (await _overview(client, bearer, admin))["actions"]
    assert len(actions) == 11
    assert {a["action"] for a in actions} == {"ai.settings_set"}
    assert actions[0]["adminEmail"] == ADMIN_EMAIL


# --- Ajout d'un modèle ----------------------------------------------------------------------


async def test_add_model(client, db, bearer, admin):
    model = await _add_model(client, bearer, admin, "openrouter", "vendor/nouveau")
    assert model["analyses"] == 0 and model["active"] is False and model["knownProvider"] is True
    assert await _actions(db) == [
        ("ai.model_added", admin, None, {"provider": "openrouter", "slug": "vendor/nouveau"})
    ]


async def test_add_model_unknown_provider_is_422(client, db, bearer, admin):
    r = await client.post(
        "/api/admin/ai/models", json={"provider": "inconnu", "slug": "x"}, headers=bearer(admin)
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_value"
    assert await _count_actions(db) == 0
    assert await _scalar(db, "select count(*) from app.models where slug = 'x'") == 0


async def test_add_model_duplicate_is_409(client, db, bearer, admin):
    await _add_model(client, bearer, admin)
    r = await client.post(
        "/api/admin/ai/models",
        json={"provider": "stub", "slug": "nouveau/modele"},
        headers=bearer(admin),
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "conflict"
    assert await _count_actions(db) == 1  # seul l'ajout réussi est journalisé
    # Le même slug chez un autre fournisseur est un autre modèle.
    await _add_model(client, bearer, admin, "groq", "nouveau/modele")


async def test_add_model_rejects_bad_slug_and_extra_fields(client, db, bearer, admin):
    h = bearer(admin)
    for body in (
        {"provider": "stub", "slug": "avec espace"},
        {"provider": "stub", "slug": "tab\tulation"},
        {"provider": "stub", "slug": ""},
        {"provider": "stub", "slug": "x" * 201},
        {"provider": "stub"},
        {"slug": "x"},
        {"provider": "stub", "slug": "x", "active": True},
    ):
        r = await client.post("/api/admin/ai/models", json=body, headers=h)
        assert r.status_code == 422, body
        assert r.json()["error"]["code"] == "invalid_request"
    r = await client.post(
        "/api/admin/ai/models", json={"provider": "stub", "slug": "x" * 200}, headers=h
    )
    assert r.status_code == 200
    assert await _count_actions(db) == 1


# --- Modèle actif ---------------------------------------------------------------------------


class _RecordingLLM(FakeLLM):
    """Faux client qui retient le slug du modèle et l'outil de chaque appel."""

    def __init__(self) -> None:
        super().__init__()
        self.slugs: list[str] = []
        self.tools: list[WebSearchTool | None] = []

    async def analyze(
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict],
        tools: WebSearchTool | None = None,
        on_event: EventSink | None = None,
    ) -> LLMResult:
        self.slugs.append(model)
        self.tools.append(tools)
        return await super().analyze(
            model=model, system_prompt=system_prompt, messages=messages, tools=tools
        )


class _OneHitBackend:
    async def search(self, query: str) -> list[SearchHit]:
        return [SearchHit(title="Vélo", url="https://exemple.be/velo", snippet="Prix")]


@pytest.fixture
def llm(app) -> _RecordingLLM:
    fake = _RecordingLLM()
    app.state.llm_for = fake.llm_for
    app.state.search = _OneHitBackend()
    return fake


async def _subscribe(db, uid: str) -> None:
    await db.execute(
        text(
            "insert into app.subscriptions(user_id, plan, status, provider, period_start)"
            " values (:u, 'standard', 'active', 'manual', now() - interval '1 day')"
        ),
        {"u": uid},
    )
    await db.commit()


async def _scan(client, bearer, uid: str, external_id: str = "m1") -> dict:
    r = await client.post("/api/scans", json=_body(external_id), headers=bearer(uid))
    assert r.status_code == 200, r.text
    return r.json()


async def _activate_model(client, bearer, admin, model_id: int):
    return await client.post(
        "/api/admin/ai/active-model", json={"modelId": model_id}, headers=bearer(admin)
    )


async def test_activate_model_next_scan_uses_it(client, db, bearer, admin, make_user, llm):
    uid = await make_user(f"{uuid4().hex}@radarnaque.test")
    await _subscribe(db, uid)
    before = await _overview(client, bearer, admin)
    old_id = before["activeModelId"]
    first = await _scan(client, bearer, uid)
    assert first["fromCache"] is False and len(llm.slugs) == 1
    old_slug = llm.slugs[0]

    new = await _add_model(client, bearer, admin)
    r = await _activate_model(client, bearer, admin, new["id"])
    assert r.status_code == 200, r.text
    assert r.json()["activeModelId"] == new["id"]
    assert [m["id"] for m in r.json()["models"] if m["active"]] == [new["id"]]

    # Même annonce : l'analyse de l'ancien modèle n'est pas servie, le nouveau modèle est appelé.
    second = await _scan(client, bearer, uid)
    assert second["fromCache"] is False
    assert llm.slugs == [old_slug, "nouveau/modele"]
    assert second["analysisId"] != first["analysisId"]

    # L'ancien résultat est resté en base : réactiver l'ancien modèle le sert depuis le cache.
    assert (await _activate_model(client, bearer, admin, old_id)).status_code == 200
    third = await _scan(client, bearer, uid)
    assert third["fromCache"] is True and third["analysisId"] == first["analysisId"]
    assert len(llm.slugs) == 2

    assert await _actions(db) == [
        ("ai.model_added", admin, None, {"provider": "stub", "slug": "nouveau/modele"}),
        ("ai.model_activated", admin, None, {"from": old_id, "to": new["id"]}),
        ("ai.model_activated", admin, None, {"from": new["id"], "to": old_id}),
    ]


async def test_activate_unknown_model_is_404(client, db, bearer, admin):
    r = await _activate_model(client, bearer, admin, 999_999)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"
    assert await _count_actions(db) == 0


async def test_activate_model_with_unknown_provider_is_422(client, db, bearer, admin):
    before = (await _overview(client, bearer, admin))["activeModelId"]
    # Un fournisseur retiré de providers.toml après coup : la ligne existe encore en base.
    orphan = await _scalar(
        db, "insert into app.models(provider, slug) values ('disparu', 'x/y') returning id"
    )
    await db.commit()
    data = await _overview(client, bearer, admin)
    assert [m["knownProvider"] for m in data["models"] if m["id"] == orphan] == [False]

    r = await _activate_model(client, bearer, admin, orphan)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_value"
    assert (await _overview(client, bearer, admin))["activeModelId"] == before
    assert (
        await _scalar(db, "select active_model_id from app.scan_kinds where code='full'") == before
    )
    assert await _count_actions(db) == 0


async def test_activate_active_model_is_200_without_trace(client, db, bearer, admin):
    active = (await _overview(client, bearer, admin))["activeModelId"]
    r = await _activate_model(client, bearer, admin, active)
    assert r.status_code == 200 and r.json()["activeModelId"] == active
    assert await _count_actions(db) == 0


async def test_activate_model_rejects_bad_body(client, bearer, admin):
    for body in ({}, {"modelId": "x"}, {"modelId": 1, "extra": 1}):
        r = await client.post("/api/admin/ai/active-model", json=body, headers=bearer(admin))
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"


# --- Prompts --------------------------------------------------------------------------------


async def test_create_prompt_numbers_and_inactive(client, db, bearer, admin):
    before = await _overview(client, bearer, admin)
    last = max(p["version"] for p in before["prompts"])
    r = await _create_prompt(client, bearer, admin)
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["version"] == last + 1
    assert created["active"] is False and created["analyses"] == 0
    assert created["systemPrompt"] == PROMPT
    r = await _create_prompt(client, bearer, admin, PROMPT + "bis")
    assert r.json()["version"] == last + 2

    after = await _overview(client, bearer, admin)
    assert after["activePromptVersionId"] == before["activePromptVersionId"]
    assert [p["version"] for p in after["prompts"]][:2] == [last + 2, last + 1]
    # Le texte reste lisible, en lecture seule.
    got = await client.get(f"/api/admin/ai/prompts/{created['id']}", headers=bearer(admin))
    assert got.status_code == 200 and got.json() == created
    assert (
        await _scalar(
            db, "select scan_kind from app.prompt_versions where id = :i", i=created["id"]
        )
        == "full"
    )


async def test_concurrent_prompt_creation(client, db, bearer, admin):
    last = max(p["version"] for p in (await _overview(client, bearer, admin))["prompts"])
    first, second = await asyncio.gather(
        _create_prompt(client, bearer, admin, PROMPT + "A"),
        _create_prompt(client, bearer, admin, PROMPT + "B"),
    )
    assert (first.status_code, second.status_code) == (201, 201)
    assert sorted([first.json()["version"], second.json()["version"]]) == [last + 1, last + 2]


async def test_prompt_bounds(client, db, bearer, admin):
    for size in (199, 20_001):
        r = await _create_prompt(client, bearer, admin, "x" * size)
        assert r.status_code == 422, size
        assert r.json()["error"]["code"] == "invalid_request"
    for size in (200, 20_000):
        assert (await _create_prompt(client, bearer, admin, "x" * size)).status_code == 201
    r = await client.post(
        "/api/admin/ai/prompts", json={"systemPrompt": PROMPT, "x": 1}, headers=bearer(admin)
    )
    assert r.status_code == 422
    assert await _count_actions(db) == 2


async def test_prompt_journal_has_no_text(client, db, bearer, admin, caplog):
    with caplog.at_level(logging.INFO, logger="radarnaque.admin"):
        created = (await _create_prompt(client, bearer, admin)).json()
    assert await _actions(db) == [
        ("ai.prompt_created", admin, None, {"version": created["version"]})
    ]
    stored = await _scalar(db, "select details::text from app.admin_actions")
    assert "expert" not in stored and PROMPT[:30] not in stored
    assert [r.getMessage() for r in caplog.records if r.name == "radarnaque.admin"] == [
        "action admin : ai.prompt_created"
    ]
    assert PROMPT[:30] not in caplog.text


async def test_get_unknown_prompt_is_404(client, bearer, admin):
    r = await client.get("/api/admin/ai/prompts/999999", headers=bearer(admin))
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


async def test_activate_prompt(client, db, bearer, admin, make_user, llm):
    uid = await make_user(f"{uuid4().hex}@radarnaque.test")
    await _subscribe(db, uid)
    before = await _overview(client, bearer, admin)
    old = next(p for p in before["prompts"] if p["active"])
    created = (await _create_prompt(client, bearer, admin)).json()
    first = await _scan(client, bearer, uid)

    r = await client.post(f"/api/admin/ai/prompts/{created['id']}/activate", headers=bearer(admin))
    assert r.status_code == 200, r.text
    assert r.json()["activePromptVersionId"] == created["id"]
    assert [p["id"] for p in r.json()["prompts"] if p["active"]] == [created["id"]]
    # Le cache est lié à la version du prompt : le scan suivant relance une analyse.
    second = await _scan(client, bearer, uid)
    assert second["fromCache"] is False and second["analysisId"] != first["analysisId"]
    assert llm.calls == 2

    assert await _actions(db) == [
        ("ai.prompt_created", admin, None, {"version": created["version"]}),
        ("ai.prompt_activated", admin, None, {"from": old["version"], "to": created["version"]}),
    ]


async def test_activate_unknown_prompt_is_404(client, db, bearer, admin):
    r = await client.post("/api/admin/ai/prompts/999999/activate", headers=bearer(admin))
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    assert await _count_actions(db) == 0


async def test_activate_prompt_of_other_kind_is_422(client, db, bearer, admin):
    before = (await _overview(client, bearer, admin))["activePromptVersionId"]
    other = await _scalar(
        db, "select id from app.prompt_versions where scan_kind <> 'full' order by id limit 1"
    )
    r = await client.post(f"/api/admin/ai/prompts/{other}/activate", headers=bearer(admin))
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_value"
    assert (await _overview(client, bearer, admin))["activePromptVersionId"] == before
    assert await _scalar(db, "select count(*) from app.admin_actions") == 0


async def test_activate_active_prompt_is_200_without_trace(client, db, bearer, admin):
    active = (await _overview(client, bearer, admin))["activePromptVersionId"]
    r = await client.post(f"/api/admin/ai/prompts/{active}/activate", headers=bearer(admin))
    assert r.status_code == 200 and r.json()["activePromptVersionId"] == active
    assert await _count_actions(db) == 0


async def test_no_route_modifies_a_prompt(client, bearer, admin):
    active = (await _overview(client, bearer, admin))["activePromptVersionId"]
    url = f"/api/admin/ai/prompts/{active}"
    for method in ("PUT", "PATCH", "DELETE", "POST"):
        r = await client.request(method, url, json={"systemPrompt": PROMPT}, headers=bearer(admin))
        assert r.status_code == 405, method
    r = await client.request("PUT", "/api/admin/ai/prompts", json={}, headers=bearer(admin))
    assert r.status_code == 405


# --- Réglages -------------------------------------------------------------------------------


async def _patch(client, bearer, admin, body: dict):
    return await client.patch("/api/admin/ai/settings", json=body, headers=bearer(admin))


async def test_settings_bounds_journal_and_effect(client, db, bearer, admin, make_user, llm):
    uid = await make_user(f"{uuid4().hex}@radarnaque.test")
    await _subscribe(db, uid)
    current = (await _overview(client, bearer, admin))["settings"]
    assert current["maxWebSearches"] > 0

    for body in (
        {"cacheTtlHours": 0},
        {"cacheTtlHours": 169},
        {"rateLimitPerMinute": 0},
        {"rateLimitPerMinute": 601},
        {"maxWebSearches": -1},
        {"maxWebSearches": 6},
        {"maxWebSearches": "x"},
        {"inconnu": 1},
    ):
        r = await _patch(client, bearer, admin, body)
        assert r.status_code == 422, body
        assert r.json()["error"]["code"] == "invalid_request"
    assert await _count_actions(db) == 0
    assert (await _overview(client, bearer, admin))["settings"] == current

    # Avec la recherche réglée à 3, le scan reçoit l'outil ; à 0, plus aucun.
    await _scan(client, bearer, uid, "a1")
    assert llm.tools[-1] is not None
    r = await _patch(client, bearer, admin, {"maxWebSearches": 0})
    assert r.status_code == 200 and r.json()["settings"]["maxWebSearches"] == 0
    await _scan(client, bearer, uid, "a2")
    assert llm.tools[-1] is None

    # Deux champs changés : deux lignes ; un champ inchangé n'en écrit pas.
    r = await _patch(
        client,
        bearer,
        admin,
        {"cacheTtlHours": 168, "rateLimitPerMinute": 600, "maxWebSearches": 0},
    )
    assert r.status_code == 200
    assert r.json()["settings"] == {
        "cacheTtlHours": 168,
        "rateLimitPerMinute": 600,
        "maxWebSearches": 0,
    }
    assert await _actions(db) == [
        (
            "ai.settings_set",
            admin,
            None,
            {"field": "max_web_searches", "from": current["maxWebSearches"], "to": 0},
        ),
        (
            "ai.settings_set",
            admin,
            None,
            {"field": "cache_ttl_hours", "from": current["cacheTtlHours"], "to": 168},
        ),
        (
            "ai.settings_set",
            admin,
            None,
            {"field": "rate_limit_per_minute", "from": current["rateLimitPerMinute"], "to": 600},
        ),
    ]
    # Les bornes sont acceptées.
    r = await _patch(client, bearer, admin, {"cacheTtlHours": 1, "rateLimitPerMinute": 1})
    assert r.status_code == 200 and r.json()["settings"]["cacheTtlHours"] == 1
    r = await _patch(client, bearer, admin, {"maxWebSearches": 5})
    assert r.status_code == 200 and r.json()["settings"]["maxWebSearches"] == 5


async def test_settings_empty_or_unchanged_writes_nothing(client, db, bearer, admin):
    current = (await _overview(client, bearer, admin))["settings"]
    for body in ({}, {"cacheTtlHours": current["cacheTtlHours"]}, {"maxWebSearches": None}):
        r = await _patch(client, bearer, admin, body)
        assert r.status_code == 200, body
        assert r.json()["settings"] == current
    assert await _count_actions(db) == 0
