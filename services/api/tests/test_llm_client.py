import json
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
import respx
from pydantic import BaseModel

from radarnaque_api.llm.client import (
    LLMAnalysis,
    LLMClientFactory,
    LLMError,
    LLMResult,
    OpenAICompatibleClient,
    StepResult,
    strict_analysis_schema,
    strict_json_schema,
)
from radarnaque_api.llm.events import LLMEvent, SearchDone, SearchStarted, Thinking, Writing
from radarnaque_api.llm.providers import ProviderConfig, ProviderError, load_providers
from radarnaque_api.llm.tools import SearchRecord, WebSearchTool
from radarnaque_api.search import SearchHit

BASE = "https://llm.test/v1"
KEY = "sk-test-secret"
ENV = {"TEST_LLM_KEY": KEY}
BODY_MARKER = "provider-body-marker-7f3a"

VALID = {
    "score": 72,
    "summary": {"fr": "Annonce suspecte.", "nl": "Verdachte advertentie."},
    "advice": {"fr": "Ne payez pas à l'avance.", "nl": "Betaal niet vooraf."},
    "reasons": [{"severity": "danger", "fr": "Paiement à l'avance.", "nl": "Vooruitbetaling."}],
}
MESSAGES = [{"role": "user", "content": [{"type": "text", "text": "faits"}]}]


def _provider(
    structured_output: str = "json_schema",
    cost_source: str = "usage_cost",
    extra_body: dict | None = None,
    api_key_env: str | None = "TEST_LLM_KEY",
    max_images: int | None = None,
    omit_params: tuple[str, ...] = (),
    api: str = "chat",
    reasoning_effort: str = "none",
) -> ProviderConfig:
    return ProviderConfig(
        code="testprov",
        base_url=BASE,
        api_key_env=api_key_env,
        base_url_env=None,
        structured_output=structured_output,  # type: ignore[arg-type]
        cost_source=cost_source,  # type: ignore[arg-type]
        extra_body=extra_body or {},
        max_images=max_images,
        omit_params=omit_params,  # type: ignore[arg-type]
        api=api,  # type: ignore[arg-type]
        reasoning_effort=reasoning_effort,  # type: ignore[arg-type]
    )


OPENROUTER_EXTRA = {
    "provider": {"data_collection": "deny"},
    "usage": {"include": True},
}
USAGE = {"prompt_tokens": 120, "completion_tokens": 80, "total_tokens": 200}


def _chunk(delta: dict | None = None, finish: str | None = None, usage: dict | None = None) -> str:
    body: dict = {"id": "gen-1", "object": "chat.completion.chunk", "created": 1, "model": "m"}
    body["choices"] = (
        [] if usage is not None else [{"index": 0, "delta": delta or {}, "finish_reason": finish}]
    )
    if usage is not None:
        body["usage"] = usage
    return f"data: {json.dumps(body)}\n\n"


def _stream(*events: str, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream", **(headers or {})},
        content="".join(events).encode(),
    )


def _chat(content: str | None, usage: dict | None = USAGE, headers=None) -> httpx.Response:
    """Réponse en flux de l'API Chat : le contenu en deux morceaux, la fin du choix, puis le
    morceau d'usage (absent si `usage` vaut None) et `[DONE]`."""
    events = [_chunk({"role": "assistant", "content": ""})]
    if content is not None:
        middle = len(content) // 2
        events += [_chunk({"content": content[:middle]}), _chunk({"content": content[middle:]})]
    events.append(_chunk(finish="stop"))
    if usage is not None:
        events.append(_chunk(usage=usage))
    return _stream(*events, "data: [DONE]\n\n", headers=headers)


def _ok(analysis: dict | None = None, usage: dict | None = USAGE, headers=None) -> httpx.Response:
    return _chat(json.dumps(analysis or VALID), usage, headers)


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as client:
        yield client


@pytest.fixture
def mock() -> Iterator[respx.MockRouter]:
    with respx.mock(base_url=BASE, assert_all_called=False) as router:
        yield router


def _assert_not_chained(error: BaseException) -> None:
    # Ni cause ni contexte : l'exception d'origine porte le corps et la requête (Authorization).
    assert error.__cause__ is None
    assert error.__context__ is None


async def _analyze(provider: ProviderConfig, http: httpx.AsyncClient, env=ENV):
    client = OpenAICompatibleClient(provider, env, http_client=http)
    return await client.analyze(model="vendor/model", system_prompt="SYS", messages=MESSAGES)


async def test_json_schema_mode_sends_strict_format_and_extra_body(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok())
    result = await _analyze(_provider(extra_body=OPENROUTER_EXTRA), http)

    assert route.call_count == 1
    request = route.calls.last.request
    assert request.headers["authorization"] == f"Bearer {KEY}"
    body = json.loads(request.content)
    assert body["model"] == "vendor/model"
    assert body["temperature"] == 0.2
    assert body["max_tokens"] == 4000
    assert body["stream"] is True
    assert body["stream_options"] == {"include_usage": True}
    assert body["response_format"] == {
        "type": "json_schema",
        "json_schema": {
            "name": "radarnaque_analysis",
            "strict": True,
            "schema": strict_analysis_schema(),
        },
    }
    assert body["provider"]["data_collection"] == "deny"
    assert body["usage"]["include"] is True
    for absent in ("reasoning", "tools", "tool_choice"):  # effort `none`, sans outil
        assert absent not in body
    assert body["messages"][0] == {"role": "system", "content": "SYS"}
    assert body["messages"][1:] == MESSAGES
    assert result.analysis == LLMAnalysis.model_validate(VALID)
    assert (result.tokens_in, result.tokens_out) == (120, 80)


async def test_json_object_mode_appends_schema_to_system_prompt(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok())
    await _analyze(_provider(structured_output="json_object", cost_source="none"), http)

    body = json.loads(route.calls.last.request.content)
    assert body["response_format"] == {"type": "json_object"}
    system = body["messages"][0]["content"]
    assert system.startswith("SYS")
    schema_text = json.dumps(strict_analysis_schema(), ensure_ascii=False)
    assert system.endswith(schema_text)


def test_strict_schema_is_self_contained_and_closed():
    schema = strict_analysis_schema()
    text = json.dumps(schema)
    assert "$ref" not in text and "$defs" not in text

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False
                assert sorted(node["required"]) == sorted(node["properties"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(schema)
    assert schema["properties"]["score"]["minimum"] == 0
    assert schema["properties"]["score"]["maximum"] == 100
    assert schema["properties"]["reasons"]["maxItems"] == 5
    # Fresh copy: mutating it must not alter the next one.
    schema["properties"].clear()
    assert strict_analysis_schema()["properties"]


def test_strict_schema_requires_professional_as_a_plain_boolean():
    schema = strict_analysis_schema()
    assert "professional" in schema["required"]
    # Ni `title` ni `default` : le mode strict exige le champ, une valeur par défaut n'a pas de
    # sens dans le schéma envoyé.
    assert schema["properties"]["professional"] == {"type": "boolean"}


@pytest.mark.parametrize(("extra", "expected"), [({}, False), ({"professional": True}, True)])
async def test_professional_is_read_and_defaults_to_false(mock, http, extra, expected):
    # Une réponse au format v1, sans `professional`, reste valide.
    mock.post("/chat/completions").mock(return_value=_ok({**VALID, **extra}))
    result = await _analyze(_provider(), http)
    assert result.analysis.professional is expected


def test_analysis_without_professional_is_not_professional():
    assert LLMAnalysis.model_validate(VALID).professional is False


class _Titled(BaseModel):
    title: str
    maxLength: int  # nom de champ volontairement identique à un mot-clé


class _WithTitled(BaseModel):
    title: _Titled
    items: list[_Titled]


def test_strict_schema_keeps_fields_named_like_keywords():
    schema = strict_json_schema(_WithTitled)
    assert sorted(schema["properties"]) == ["items", "title"]
    assert sorted(schema["required"]) == ["items", "title"]
    titled = schema["properties"]["title"]
    assert sorted(titled["properties"]) == ["maxLength", "title"]
    assert titled["properties"]["title"] == {"type": "string"}
    assert sorted(schema["properties"]["items"]["items"]["properties"]) == ["maxLength", "title"]
    # Les mots-clés `title` des nœuds de schéma, eux, sont bien retirés.
    assert "title" not in titled["properties"]["maxLength"]


async def test_invalid_then_valid_response_succeeds_with_two_calls(mock, http):
    route = mock.post("/chat/completions").mock(side_effect=[_chat("pas du json"), _ok()])
    result = await _analyze(_provider(), http)
    assert route.call_count == 2
    assert result.analysis.score == 72


async def test_two_invalid_responses_raise_invalid_response(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_chat("{cassé"))
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "invalid_response"
    assert route.call_count == 2
    _assert_not_chained(info.value)


@pytest.mark.parametrize(
    "analysis",
    [
        {**VALID, "score": 101},
        {**VALID, "score": -1},
        {**VALID, "summary": {"fr": "Résumé.", "nl": ""}},
        {**VALID, "advice": {"fr": "Conseil."}},
        {**VALID, "reasons": [{"severity": "danger", "fr": "Raison.", "nl": "   "}]},
        {**VALID, "reasons": [{"severity": "critical", "fr": "Raison.", "nl": "Reden."}]},
        {**VALID, "reasons": [VALID["reasons"][0]] * 6},
    ],
    ids=[
        "score-101",
        "score-neg",
        "nl-empty",
        "nl-missing",
        "nl-blank",
        "bad-severity",
        "6-reasons",
    ],
)
async def test_out_of_contract_analysis_is_an_invalid_response(mock, http, analysis):
    route = mock.post("/chat/completions").mock(return_value=_ok(analysis))
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "invalid_response"
    assert route.call_count == 2


async def test_empty_content_or_unreadable_chunk_is_an_invalid_response(mock, http):
    route = mock.post("/chat/completions").mock(
        side_effect=[_chat(None), _stream("data: {cassé\n\n")]
    )
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "invalid_response"
    assert route.call_count == 2
    _assert_not_chained(info.value)


async def test_body_that_is_not_a_stream_is_transport(mock, http):
    # Aucun morceau, donc aucune fin de choix : flux incomplet, repris une fois (rien d'émis).
    route = mock.post("/chat/completions").mock(
        return_value=httpx.Response(200, text="<html>oops</html>")
    )
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "transport"
    assert route.call_count == 2
    _assert_not_chained(info.value)


@pytest.mark.parametrize("status", [401, 403])
async def test_auth_rejection_is_configuration_error_without_retry_or_leak(mock, http, status):
    route = mock.post("/chat/completions").mock(
        return_value=httpx.Response(
            status,
            json={"error": {"message": f"bad key {KEY} {BODY_MARKER}", "code": status}},
        )
    )
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    error = info.value
    assert error.code == "configuration"
    assert route.call_count == 1
    for text in (str(error), repr(error), str(error.args)):
        assert KEY not in text
        assert BODY_MARKER not in text
        assert BASE not in text
    _assert_not_chained(error)


async def test_missing_api_key_is_configuration_error_without_any_call(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok())
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http, env={})
    assert info.value.code == "configuration"
    assert route.call_count == 0
    _assert_not_chained(info.value)


async def test_omitted_params_are_not_sent(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok())
    await _analyze(_provider(omit_params=("temperature",)), http)

    body = json.loads(route.calls.last.request.content)
    assert "temperature" not in body
    assert body["max_tokens"] == 4000


async def test_all_omittable_params_can_be_dropped(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok())
    await _analyze(_provider(omit_params=("temperature", "max_tokens")), http)

    body = json.loads(route.calls.last.request.content)
    assert "temperature" not in body
    assert "max_tokens" not in body
    assert body["response_format"]["type"] == "json_schema"


def test_client_exposes_the_provider_image_limit():
    assert OpenAICompatibleClient(_provider(max_images=3), ENV).max_images == 3
    assert OpenAICompatibleClient(_provider(), ENV).max_images is None


def test_llm_error_provider_is_optional():
    error = LLMError("transport")
    assert error.code == "transport"
    assert "injoignable" in str(error)


async def test_provider_without_key_sends_placeholder(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok())
    await _analyze(_provider(api_key_env=None, cost_source="none"), http, env={})
    assert route.calls.last.request.headers["authorization"] == "Bearer unused"


async def test_timeout_twice_raises_timeout(mock, http):
    route = mock.post("/chat/completions").mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "timeout"  # spec §11 : `timeout` dans les détails
    assert route.call_count == 2
    _assert_not_chained(info.value)


async def test_server_error_twice_raises_transport_after_two_calls(mock, http):
    route = mock.post("/chat/completions").mock(
        return_value=httpx.Response(502, json={"error": {"message": BODY_MARKER}})
    )
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "transport"
    assert route.call_count == 2
    assert BODY_MARKER not in str(info.value)
    _assert_not_chained(info.value)


async def test_rate_limited_is_transport_without_retry(mock, http):
    route = mock.post("/chat/completions").mock(
        return_value=httpx.Response(429, json={"error": {"message": BODY_MARKER}})
    )
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "transport"
    assert route.call_count == 1
    _assert_not_chained(info.value)


async def test_timeout_of_90_seconds_reaches_the_request(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok())
    await _analyze(_provider(), http)
    timeout = route.calls.last.request.extensions["timeout"]
    assert timeout == {"connect": 90, "read": 90, "write": 90, "pool": 90}


async def test_server_error_then_success_retries_once(mock, http):
    route = mock.post("/chat/completions").mock(
        side_effect=[httpx.Response(503, json={"error": {"message": BODY_MARKER}}), _ok()]
    )
    result = await _analyze(_provider(), http)
    assert route.call_count == 2
    assert result.analysis.score == 72


async def test_connection_errors_twice_raise_transport_without_leak(mock, http):
    route = mock.post("/chat/completions").mock(side_effect=httpx.ConnectError(BODY_MARKER))
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "transport"
    assert route.call_count == 2
    assert BODY_MARKER not in str(info.value)


async def test_other_client_error_is_transport_without_retry(mock, http):
    route = mock.post("/chat/completions").mock(
        return_value=httpx.Response(400, json={"error": {"message": BODY_MARKER}})
    )
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "transport"
    assert route.call_count == 1
    assert BODY_MARKER not in str(info.value)
    _assert_not_chained(info.value)


async def test_openrouter_usage_cost_in_micro_dollars(mock, http):
    usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": 0.000412}
    mock.post("/chat/completions").mock(return_value=_ok(usage=usage))
    result = await _analyze(_provider(cost_source="usage_cost"), http)
    assert result.cost_usd_micros == 412
    assert (result.tokens_in, result.tokens_out) == (10, 5)


@pytest.mark.parametrize("cost", [None, "abc", -0.5, True])
async def test_usage_cost_missing_or_unusable_is_zero(mock, http, cost):
    usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    if cost is not None:
        usage["cost"] = cost
    mock.post("/chat/completions").mock(return_value=_ok(usage=usage))
    result = await _analyze(_provider(cost_source="usage_cost"), http)
    assert result.cost_usd_micros == 0


async def test_missing_usage_gives_zero_tokens(mock, http):
    mock.post("/chat/completions").mock(return_value=_ok(usage=None))
    result = await _analyze(_provider(cost_source="usage_cost"), http)
    assert (result.tokens_in, result.tokens_out, result.cost_usd_micros) == (0, 0, 0)


@pytest.mark.parametrize(
    "headers",
    [None, {"X-OmniRoute-Response-Cost": "0.0012345679"}, {"X-OmniRoute-Response-Cost": "n/a"}],
)
async def test_omniroute_cost_header_is_not_read_from_a_stream(mock, http, headers):
    # OmniRoute ne donne son coût que sans flux (l'en-tête part avant la génération) : 0.
    mock.post("/chat/completions").mock(return_value=_ok(headers=headers))
    result = await _analyze(_provider(cost_source="omniroute_headers"), http)
    assert result.cost_usd_micros == 0


async def test_cost_source_none_ignores_reported_cost(mock, http):
    usage = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2, "cost": 0.5}
    headers = {"X-OmniRoute-Response-Cost": "0.5000000000"}
    mock.post("/chat/completions").mock(return_value=_ok(usage=usage, headers=headers))
    result = await _analyze(_provider(cost_source="none"), http)
    assert result.cost_usd_micros == 0


async def test_extra_body_of_provider_is_not_mutated(mock, http):
    mock.post("/chat/completions").mock(return_value=_ok())
    provider = _provider(extra_body=OPENROUTER_EXTRA)
    before = provider.extra_body_dict()
    await _analyze(provider, http)
    assert provider.extra_body_dict() == before


async def test_aclose_closes_the_sdk_client_once_used(mock, http):
    mock.post("/chat/completions").mock(return_value=_ok())
    client = OpenAICompatibleClient(_provider(), ENV, http_client=http)
    await client.aclose()  # jamais utilisé : rien à fermer
    assert not http.is_closed
    await client.analyze(model="vendor/model", system_prompt="SYS", messages=MESSAGES)
    await client.aclose()
    assert http.is_closed


async def test_client_factory_caches_one_client_per_provider():
    other = replace(_provider(), code="other")
    factory = LLMClientFactory({"testprov": _provider(), "other": other}, ENV)
    client = factory("testprov")
    assert isinstance(client, OpenAICompatibleClient)
    assert factory("testprov") is client
    assert factory("other") is not client
    with pytest.raises(ProviderError, match="inconnu"):
        factory("missing")
    await factory.aclose()


# --- Trace pour le bloc debug du superuser -----------------------------------------------------


async def test_result_carries_the_raw_text_and_the_sent_system_prompt(mock, http):
    raw = json.dumps(VALID, ensure_ascii=False)
    mock.post("/chat/completions").mock(return_value=_chat(raw))
    result = await _analyze(_provider(), http)
    assert result.raw_text == raw
    assert result.system_prompt == "SYS"


async def test_json_object_result_system_prompt_is_the_one_sent_with_the_schema(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok())
    provider = _provider(structured_output="json_object", cost_source="none")
    result = await _analyze(provider, http)

    sent = json.loads(route.calls.last.request.content)["messages"][0]["content"]
    assert result.system_prompt == sent
    assert sent.endswith(json.dumps(strict_analysis_schema(), ensure_ascii=False))
    # Le même texte est disponible sans appel (scan servi par le cache).
    client = OpenAICompatibleClient(provider, ENV, http_client=http)
    assert client.final_system_prompt("SYS") == sent
    assert OpenAICompatibleClient(_provider(), ENV).final_system_prompt("SYS") == "SYS"


def test_llm_result_trace_fields_default_to_empty():
    result = LLMResult(
        analysis=LLMAnalysis.model_validate(VALID), tokens_in=0, tokens_out=0, cost_usd_micros=0
    )
    assert (result.raw_text, result.system_prompt) == ("", "")
    assert (result.searches, result.search_traces, result.reasoning_text) == ([], [], "")
    assert result.rounds == 1


# --- Boucle d'outils sur l'API Chat (OpenRouter, Groq, Ollama, stub) --------------------------

FIXTURES = Path(__file__).parent / "fixtures"
REPO_PROVIDERS = Path(__file__).parent.parent / "providers.toml"
HITS = [
    SearchHit(title="iPhone 18 Pro", url="https://www.apple.com/be-fr/iphone", snippet="Prix"),
    SearchHit(title="Comparatif", url="https://exemple.be/iphone-18-pro", snippet="1 329 €"),
]
SEARCH_ARGUMENTS = '{"query": "iPhone 18 Pro prix", "aspect": "price"}'


def _fixture(name: str) -> httpx.Response:
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=(FIXTURES / name).read_bytes(),
    )


class _Proxy:
    """Faux fournisseur : une réponse par requête, dans l'ordre (la dernière se répète) ; garde
    le corps JSON de chaque requête."""

    def __init__(self, *replies: str | Callable[[], httpx.Response]) -> None:
        self._replies = replies
        self.bodies: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content))
        reply = self._replies[min(len(self.bodies), len(self._replies)) - 1]
        return _fixture(reply) if isinstance(reply, str) else reply()


class _Backend:
    def __init__(self) -> None:
        self.queries: list[str] = []

    async def search(self, query: str) -> list[SearchHit]:
        self.queries.append(query)
        return list(HITS)


class _Recorder:
    def __init__(self) -> None:
        self.events: list[LLMEvent] = []

    async def __call__(self, event: LLMEvent) -> None:
        self.events.append(event)


async def _chat_run(
    proxy: _Proxy,
    *,
    provider: ProviderConfig | None = None,
    tool: WebSearchTool | None = None,
    sink: _Recorder | None = None,
    env=ENV,
) -> LLMResult:
    async with httpx.AsyncClient(transport=httpx.MockTransport(proxy)) as http:
        client = OpenAICompatibleClient(provider or _provider(), env, http_client=http)
        return await client.analyze(
            model="vendor/model", system_prompt="SYS", messages=MESSAGES, tools=tool, on_event=sink
        )


def _tool_messages(body: dict) -> dict[str, str]:
    return {m["tool_call_id"]: m["content"] for m in body["messages"] if m["role"] == "tool"}


async def test_chat_tool_loop():
    proxy = _Proxy("chat_search_price.sse", "chat_final.sse")
    backend, sink = _Backend(), _Recorder()
    tool = WebSearchTool(backend, max_searches=3, on_event=sink)
    result = await _chat_run(proxy, tool=tool, sink=sink)

    assert len(proxy.bodies) == 2
    first, second = proxy.bodies
    assert first["stream"] is True
    assert first["stream_options"] == {"include_usage": True}
    assert first["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": WebSearchTool.DESCRIPTION,
                "parameters": tool.parameters(),
            },
        }
    ]
    assert "tool_choice" not in first  # tour 1 sur 5 : le modèle choisit
    assert first["max_tokens"] == 4000
    assert first["response_format"]["type"] == "json_schema"  # gardé avec les outils
    assert second["messages"][:2] == first["messages"]
    assistant, answer = second["messages"][2:]
    # Arguments recollés depuis trois deltas ; détails de réflexion recopiés dans l'ordre.
    assert assistant == {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": "call_search",
                "type": "function",
                "function": {"name": "web_search", "arguments": SEARCH_ARGUMENTS},
            }
        ],
        "reasoning_details": [
            {
                "type": "reasoning.encrypted",
                "data": "chiffre-fictif",
                "id": "tool_call_search",
                "format": "google-gemini-v1",
                "index": 0,
            }
        ],
    }
    assert answer["role"] == "tool" and answer["tool_call_id"] == "call_search"
    assert answer["content"].startswith("<resultats_recherche>")
    assert "apple.com" in answer["content"]

    assert sink.events == [
        SearchStarted(1, "iPhone 18 Pro prix", "price"),
        SearchDone(1, True, 2, ("apple.com", "exemple.be")),
        Writing(),
    ]
    assert result.searches == [SearchRecord("iPhone 18 Pro prix", "price")]
    assert backend.queries == ["iPhone 18 Pro prix"]
    assert result.analysis.score == 72 and result.rounds == 2
    assert (result.tokens_in, result.tokens_out) == (100 + 300, 20 + 80)
    # Contenu recollé depuis trois deltas coupés au milieu du JSON.
    assert json.loads(result.raw_text)["summary"]["fr"] == "Prix cohérent avec le marché."


async def test_chat_reasoning_delta_events():
    sink = _Recorder()
    result = await _chat_run(_Proxy("chat_reasoning_final.sse"), sink=sink)
    # `delta.reasoning` (OpenRouter) : texte cumulé de la partie du tour.
    assert sink.events == [Thinking(0, "Vérif"), Thinking(0, "Vérifie le prix"), Writing()]
    assert result.reasoning_text == "Vérifie le prix"


async def test_chat_reasoning_content_and_parts_across_rounds():
    sink = _Recorder()
    tool = WebSearchTool(_Backend(), max_searches=3, on_event=sink)
    proxy = _Proxy("chat_search_thinking.sse", "chat_reasoning_final.sse")
    result = await _chat_run(proxy, tool=tool, sink=sink)
    # `delta.reasoning_content` (Groq, Ollama…) au tour 1, une nouvelle partie au tour 2.
    assert [type(e) for e in sink.events] == [
        Thinking,
        SearchStarted,
        SearchDone,
        Thinking,
        Thinking,
        Writing,
    ]
    thinking = [e for e in sink.events if isinstance(e, Thinking)]
    assert thinking == [
        Thinking(0, "Je cherche le prix."),
        Thinking(1, "Vérif"),
        Thinking(1, "Vérifie le prix"),
    ]
    assert result.reasoning_text == "Je cherche le prix.\n\nVérifie le prix"
    # Pas de `reasoning_details` reçu : aucun n'est recopié.
    assert "reasoning_details" not in proxy.bodies[1]["messages"][2]


async def test_chat_reasoning_of_a_retried_round_is_a_new_part():
    bad = _stream(
        _chunk({"reasoning": "Premier essai"}),
        _chunk({"content": "{cassé"}),
        _chunk(finish="stop"),
    )
    sink = _Recorder()
    await _chat_run(_Proxy(lambda: bad, "chat_reasoning_final.sse"), sink=sink)
    thinking = [e for e in sink.events if isinstance(e, Thinking)]
    assert thinking[0] == Thinking(0, "Premier essai")
    assert thinking[1:] == [Thinking(1, "Vérif"), Thinking(1, "Vérifie le prix")]


@pytest.mark.parametrize("max_searches", [0, 2])
async def test_chat_last_round_tool_choice_none(max_searches):
    # Un modèle qui appelle l'outil à chaque tour, même quand on le lui interdit.
    proxy = _Proxy("chat_search_price.sse")
    backend = _Backend()
    tool = WebSearchTool(backend, max_searches=max_searches, on_event=None)
    with pytest.raises(LLMError) as info:
        await _chat_run(proxy, tool=tool)
    assert info.value.code == "invalid_response"
    _assert_not_chained(info.value)
    rounds = max_searches + 2
    assert len(proxy.bodies) == rounds + 1  # tous les tours, plus une seule reprise du dernier
    choices = [body.get("tool_choice") for body in proxy.bodies]
    assert choices == [None] * (rounds - 1) + ["none", "none"]
    assert all(body["tools"] for body in proxy.bodies)
    assert len(backend.queries) == max_searches


async def test_chat_search_limit_then_conclude():
    proxy = _Proxy("chat_search_price.sse", "chat_search_price.sse", "chat_final.sse")
    backend, sink = _Backend(), _Recorder()
    tool = WebSearchTool(backend, max_searches=1, on_event=sink)
    result = await _chat_run(proxy, tool=tool, sink=sink)

    assert [body.get("tool_choice") for body in proxy.bodies] == [None, None, "none"]
    outputs = [m["content"] for m in proxy.bodies[2]["messages"] if m["role"] == "tool"]
    assert outputs[0].startswith("<resultats_recherche>")
    assert outputs[1] == "Limite de recherches atteinte : conclus avec ce que tu sais."
    assert [type(e) for e in sink.events] == [SearchStarted, SearchDone, Writing]
    assert result.rounds == 3 and backend.queries == ["iPhone 18 Pro prix"]


async def test_chat_unknown_tool_and_bad_arguments():
    proxy = _Proxy("chat_bad_calls.sse", "chat_final.sse")
    backend, sink = _Backend(), _Recorder()
    tool = WebSearchTool(backend, max_searches=3, on_event=sink)
    result = await _chat_run(proxy, tool=tool, sink=sink)

    assistant = proxy.bodies[1]["messages"][2]
    assert [call["id"] for call in assistant["tool_calls"]] == ["call_foo", "call_bad"]
    assert _tool_messages(proxy.bodies[1]) == {
        "call_foo": "Outil inconnu.",
        "call_bad": "Arguments invalides.",
    }
    roles = [m["role"] for m in proxy.bodies[1]["messages"]]
    assert roles == ["system", "user", "assistant", "tool", "tool"]
    assert backend.queries == [] and sink.events == [Writing()]
    assert result.analysis.score == 72 and result.searches == []


async def test_chat_tool_call_without_id_is_an_invalid_response():
    call = {"index": 0, "type": "function", "function": {"name": "web_search", "arguments": "{}"}}
    reply = _stream(_chunk({"tool_calls": [call]}), _chunk(finish="tool_calls"))
    proxy = _Proxy(lambda: reply)
    tool = WebSearchTool(_Backend(), max_searches=3, on_event=None)
    with pytest.raises(LLMError) as info:
        await _chat_run(proxy, tool=tool)
    assert info.value.code == "invalid_response"
    assert len(proxy.bodies) == 2


async def test_chat_tool_call_without_tools_is_an_invalid_response():
    proxy = _Proxy("chat_search_price.sse")
    with pytest.raises(LLMError) as info:
        await _chat_run(proxy)
    assert info.value.code == "invalid_response"
    assert len(proxy.bodies) == 2
    assert "tools" not in proxy.bodies[0]


async def test_chat_truncated_answer_is_an_invalid_response():
    truncated = _stream(_chunk({"content": '{"score": 7'}), _chunk(finish="length"))
    proxy = _Proxy(lambda: truncated, "chat_final.sse")
    result = await _chat_run(proxy)
    assert len(proxy.bodies) == 2 and result.analysis.score == 72


async def test_chat_stream_cut_after_an_event_is_transport_without_retry():
    # Ni fin de choix ni `[DONE]` après un `Thinking` : pas de reprise, l'extension l'a affiché.
    cut = _stream(_chunk({"reasoning": "Vérif"}))
    proxy = _Proxy(lambda: cut, "chat_final.sse")
    sink = _Recorder()
    with pytest.raises(LLMError) as info:
        await _chat_run(proxy, sink=sink)
    assert info.value.code == "transport"
    _assert_not_chained(info.value)
    assert len(proxy.bodies) == 1
    assert sink.events == [Thinking(0, "Vérif")]


async def test_chat_error_chunk_is_transport_without_leak():
    error = f'data: {{"error": {{"code": 502, "message": "{BODY_MARKER}"}}}}\n\n'
    proxy = _Proxy(lambda: _stream(error))
    with pytest.raises(LLMError) as info:
        await _chat_run(proxy)
    assert info.value.code == "transport"
    assert BODY_MARKER not in str(info.value) and BODY_MARKER not in repr(info.value)
    _assert_not_chained(info.value)
    assert len(proxy.bodies) == 2  # rien d'émis : une nouvelle tentative


async def test_chat_event_sink_error_propagates_without_retry():
    class SinkBug(ValueError):
        pass

    async def failing_sink(event: LLMEvent) -> None:
        raise SinkBug("récepteur cassé")

    proxy = _Proxy("chat_reasoning_final.sse")
    with pytest.raises(SinkBug):
        await _chat_run(proxy, sink=failing_sink)  # type: ignore[arg-type]
    assert len(proxy.bodies) == 1  # ni réponse invalide, ni nouvelle tentative


async def test_chat_cost_summed():
    proxy = _Proxy("chat_search_price.sse", "chat_final.sse")
    tool = WebSearchTool(_Backend(), max_searches=3, on_event=None)
    result = await _chat_run(proxy, provider=_provider(cost_source="usage_cost"), tool=tool)
    # `usage.cost` du dernier morceau de chaque tour : 0,001 $ puis 0,002 $.
    assert result.cost_usd_micros == 3000


@pytest.mark.parametrize("effort", ["low", "high"])
async def test_chat_reasoning_effort_goes_to_extra_body(effort):
    proxy = _Proxy("chat_final.sse")
    await _chat_run(proxy, provider=_provider(reasoning_effort=effort))
    assert proxy.bodies[0]["reasoning"] == {"effort": effort}


async def test_openrouter_reasoning_low():
    config = load_providers(REPO_PROVIDERS)["openrouter"]
    openrouter = replace(config, base_url=BASE, extra_body=config.extra_body_dict())
    assert openrouter.reasoning_effort == "low"
    proxy = _Proxy("chat_final.sse")
    await _chat_run(proxy, provider=openrouter, env={"OPENROUTER_API_KEY": KEY})
    [body] = proxy.bodies
    assert body["reasoning"] == {"effort": "low"}  # remplace `reasoning: { enabled: false }`
    assert body["provider"]["data_collection"] == "deny"
    assert body["usage"] == {"include": True}
    assert body["response_format"]["type"] == "json_schema"


# --- complete() : sortie structurée générique -----------------------------------------------------


class _Out(BaseModel):
    name: str


async def _complete(provider: ProviderConfig, http: httpx.AsyncClient, **kwargs) -> StepResult:
    client = OpenAICompatibleClient(provider, ENV, http_client=http)
    return await client.complete(
        model="vendor/model",
        system_prompt="SYS",
        messages=MESSAGES,
        output=_Out,
        schema_name="step_out",
        **kwargs,
    )


async def test_complete_returns_validated_output_and_usage(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok({"name": "x"}))
    result = await _complete(_provider(), http)
    assert route.call_count == 1
    assert result.output.name == "x"
    assert (result.tokens_in, result.tokens_out) == (120, 80)
    assert result.raw_text == '{"name": "x"}'
    assert result.system_prompt == "SYS"


async def test_complete_sends_schema_named_and_strict(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok({"name": "x"}))
    await _complete(_provider(), http)
    body = json.loads(route.calls.last.request.content)
    assert body["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "step_out", "strict": True, "schema": strict_json_schema(_Out)},
    }
    assert "tools" not in body


async def test_complete_json_object_appends_schema_to_prompt(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok({"name": "x"}))
    result = await _complete(_provider(structured_output="json_object"), http)
    body = json.loads(route.calls.last.request.content)
    assert body["response_format"] == {"type": "json_object"}
    system = body["messages"][0]["content"]
    assert system.startswith("SYS")
    assert json.dumps(strict_json_schema(_Out), ensure_ascii=False) in system
    assert result.system_prompt == system


async def test_complete_reasoning_override_none_drops_reasoning(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok({"name": "x"}))
    await _complete(_provider(reasoning_effort="low"), http, reasoning="none")
    assert "reasoning" not in json.loads(route.calls.last.request.content)


async def test_complete_reasoning_override_high(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok({"name": "x"}))
    await _complete(_provider(reasoning_effort="low"), http, reasoning="high")
    assert json.loads(route.calls.last.request.content)["reasoning"] == {"effort": "high"}


async def test_complete_reasoning_none_keeps_provider_setting(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok({"name": "x"}))
    await _complete(_provider(reasoning_effort="low"), http)
    assert json.loads(route.calls.last.request.content)["reasoning"] == {"effort": "low"}


async def test_complete_reasoning_override_on_responses_api(mock, direct_http):
    route = mock.post("/responses").mock(return_value=_responses_ok({"name": "x"}))
    await _complete(_responses_provider(reasoning_effort="low"), direct_http, reasoning="medium")
    body = json.loads(route.calls.last.request.content)
    assert body["reasoning"] == {"effort": "medium", "summary": "auto"}
    await _complete(_responses_provider(reasoning_effort="low"), direct_http, reasoning="none")
    assert "reasoning" not in json.loads(route.calls.last.request.content)


async def test_complete_retries_once_on_invalid_json_then_raises_invalid_response(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_chat("{cassé"))
    with pytest.raises(LLMError) as info:
        await _complete(_provider(), http)
    assert info.value.code == "invalid_response"
    assert route.call_count == 2
    _assert_not_chained(info.value)


async def test_complete_retries_once_then_succeeds(mock, http):
    route = mock.post("/chat/completions").mock(
        side_effect=[_chat('{"name": 1}'), _ok({"name": "y"})]
    )
    result = await _complete(_provider(), http)
    assert route.call_count == 2
    assert result.output.name == "y"
    assert (result.tokens_in, result.tokens_out) == (240, 160)  # réponse refusée comprise


# --- API Responses (`api = "responses"`, proxy openai-oauth) -----------------------------------

IMAGE_URL = "data:image/jpeg;base64,/9j/AAAA"
IMAGE_MESSAGES = [
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "faits"},
            {"type": "image_url", "image_url": {"url": IMAGE_URL}},
        ],
    }
]


def _responses_provider(**overrides) -> ProviderConfig:
    base = {
        "structured_output": "json_object",
        "cost_source": "none",
        "api_key_env": None,
        "omit_params": ("temperature",),
        "api": "responses",
    }
    return _provider(**{**base, **overrides})


def _response(text: str | None, usage: dict | None = None) -> dict:
    content = [] if text is None else [{"type": "output_text", "text": text, "annotations": []}]
    return {
        "id": "resp_1",
        "object": "response",
        "created_at": 1,
        "model": "m",
        "status": "completed",
        "parallel_tool_calls": False,
        "tool_choice": "auto",
        "tools": [],
        "output": [
            {
                "type": "message",
                "id": "msg_1",
                "role": "assistant",
                "status": "completed",
                "content": content,
            }
        ],
        "usage": usage
        if usage is not None
        else {
            "input_tokens": 74,
            "output_tokens": 45,
            "total_tokens": 119,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
    }


def _sse_of(response: dict) -> httpx.Response:
    """Flux SSE réduit à `response.completed`, sortie complète comprise (le texte est lu dans
    `output` quand aucun élément n'est arrivé en cours de flux)."""
    data = json.dumps({"type": "response.completed", "sequence_number": 0, "response": response})
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=f"event: response.completed\ndata: {data}\n\n".encode(),
    )


def _responses_ok(analysis: dict | None = None, usage: dict | None = None) -> httpx.Response:
    return _sse_of(_response(json.dumps(analysis or VALID), usage))


@pytest.fixture
async def direct_http() -> AsyncIterator[httpx.AsyncClient]:
    # Sans les variables de proxy de l'environnement : respx intercepte à coup sûr.
    async with httpx.AsyncClient(trust_env=False) as client:
        yield client


async def _analyze_responses(
    provider: ProviderConfig, http: httpx.AsyncClient, env=ENV, messages=IMAGE_MESSAGES
) -> LLMResult:
    client = OpenAICompatibleClient(provider, env, http_client=http)
    return await client.analyze(model="gpt-test", system_prompt="SYS", messages=messages)


async def test_responses_api_request_shape(mock, direct_http):
    chat = mock.post("/chat/completions").mock(return_value=_ok())
    route = mock.post("/responses").mock(return_value=_responses_ok())
    provider = _responses_provider(extra_body={"store": False})
    result = await _analyze_responses(provider, direct_http)

    assert (route.call_count, chat.call_count) == (1, 0)
    body = json.loads(route.calls.last.request.content)
    client = OpenAICompatibleClient(provider, ENV)
    assert body["model"] == "gpt-test"
    assert body["instructions"] == client.final_system_prompt("SYS")
    assert body["input"] == [
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": "faits"},
                # L'image en data URL passe telle quelle.
                {"type": "input_image", "image_url": IMAGE_URL},
            ],
        }
    ]
    assert body["max_output_tokens"] == 4000
    assert body["store"] is False  # extra_body transmis
    assert body["stream"] is True
    assert body["include"] == ["reasoning.encrypted_content"]
    for absent in (
        "temperature",
        "response_format",
        "messages",
        "max_tokens",
        "text",
        "reasoning",  # reasoning_effort = none
        "tools",
        "tool_choice",
    ):
        assert absent not in body
    assert result.analysis == LLMAnalysis.model_validate(VALID)
    assert result.system_prompt == body["instructions"]


async def test_responses_api_plain_string_content_is_one_input_text(mock, direct_http):
    route = mock.post("/responses").mock(return_value=_responses_ok())
    messages = [{"role": "user", "content": "bonjour"}]
    await _analyze_responses(_responses_provider(), direct_http, messages=messages)

    body = json.loads(route.calls.last.request.content)
    assert body["input"] == [
        {"role": "user", "content": [{"type": "input_text", "text": "bonjour"}]}
    ]


async def test_responses_api_sends_temperature_unless_omitted(mock, direct_http):
    route = mock.post("/responses").mock(return_value=_responses_ok())
    await _analyze_responses(_responses_provider(omit_params=()), direct_http)
    body = json.loads(route.calls.last.request.content)
    assert body["temperature"] == 0.2
    assert body["max_output_tokens"] == 4000

    await _analyze_responses(_responses_provider(omit_params=("max_tokens",)), direct_http)
    body = json.loads(route.calls.last.request.content)
    assert "max_output_tokens" not in body
    assert body["temperature"] == 0.2


async def test_responses_api_reads_output_text_and_maps_tokens(mock, direct_http):
    raw = json.dumps(VALID, ensure_ascii=False)
    mock.post("/responses").mock(return_value=_sse_of(_response(raw)))
    result = await _analyze_responses(_responses_provider(), direct_http)

    assert result.raw_text == raw
    assert result.analysis == LLMAnalysis.model_validate(VALID)
    assert (result.tokens_in, result.tokens_out) == (74, 45)
    assert result.cost_usd_micros == 0


async def test_responses_api_cost_follows_cost_source(mock, direct_http):
    usage = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15, "cost": 0.0012}
    mock.post("/responses").mock(return_value=_responses_ok(usage=usage))
    result = await _analyze_responses(_responses_provider(cost_source="usage_cost"), direct_http)
    assert (result.tokens_in, result.tokens_out, result.cost_usd_micros) == (10, 5, 1200)


async def test_responses_api_invalid_then_valid_json_uses_two_calls(mock, direct_http):
    route = mock.post("/responses").mock(
        side_effect=[
            _sse_of(_response("pas du json")),
            _responses_ok(),
        ]
    )
    result = await _analyze_responses(_responses_provider(), direct_http)
    assert route.call_count == 2
    assert result.analysis == LLMAnalysis.model_validate(VALID)


async def test_responses_api_empty_output_twice_is_an_invalid_response(mock, direct_http):
    route = mock.post("/responses").mock(return_value=_sse_of(_response(None)))
    with pytest.raises(LLMError) as info:
        await _analyze_responses(_responses_provider(), direct_http)
    assert info.value.code == "invalid_response"
    assert route.call_count == 2
    _assert_not_chained(info.value)


async def test_responses_api_server_error_twice_raises_transport(mock, direct_http):
    route = mock.post("/responses").mock(
        return_value=httpx.Response(500, json={"error": {"message": BODY_MARKER}})
    )
    with pytest.raises(LLMError) as info:
        await _analyze_responses(_responses_provider(), direct_http)
    assert info.value.code == "transport"
    assert route.call_count == 2
    assert BODY_MARKER not in str(info.value)
    _assert_not_chained(info.value)


async def test_responses_api_auth_rejection_is_configuration_without_leak(mock, direct_http):
    route = mock.post("/responses").mock(
        return_value=httpx.Response(
            401, json={"error": {"message": f"bad key {KEY} {BODY_MARKER}", "code": 401}}
        )
    )
    provider = _responses_provider(api_key_env="TEST_LLM_KEY")
    with pytest.raises(LLMError) as info:
        await _analyze_responses(provider, direct_http)
    error = info.value
    assert error.code == "configuration"
    assert route.call_count == 1
    assert route.calls.last.request.headers["authorization"] == f"Bearer {KEY}"
    for text in (str(error), repr(error), str(error.args)):
        assert KEY not in text
        assert BODY_MARKER not in text
        assert BASE not in text
    _assert_not_chained(error)


def test_response_text_walks_output_without_output_text():
    from types import SimpleNamespace

    from radarnaque_api.llm.client import response_text

    part = SimpleNamespace(type="output_text", text='{"a"')
    other = SimpleNamespace(type="refusal", refusal="non")
    tail = SimpleNamespace(type="output_text", text=": 1}")
    response = SimpleNamespace(
        output=[
            SimpleNamespace(type="reasoning"),
            SimpleNamespace(type="message", content=[part, other, tail]),
        ]
    )
    assert response_text(response) == '{"a": 1}'
