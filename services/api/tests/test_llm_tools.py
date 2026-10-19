"""Boucle d'outils du client LLM sur l'API Responses (proxy openai-oauth), avec les fixtures SSE
de `tests/fixtures/` (écrites à la main, aucune donnée réelle), et l'outil `web_search`."""

import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import httpx
import pytest

from radarnaque_api.llm import client as client_module
from radarnaque_api.llm.client import LLMError, OpenAICompatibleClient, SearchRecord
from radarnaque_api.llm.events import LLMEvent, SearchDone, SearchStarted, Thinking, Writing
from radarnaque_api.llm.providers import ProviderConfig
from radarnaque_api.llm.tools import WebSearchTool
from radarnaque_api.search import SearchHit, SearchUnavailable

FIXTURES = Path(__file__).parent / "fixtures"
BASE = "http://proxy.test/v1"
MESSAGES = [{"role": "user", "content": [{"type": "text", "text": "faits"}]}]
HITS = [
    SearchHit(title="iPhone 18 Pro", url="https://www.apple.com/be-fr/iphone", snippet="Prix"),
    SearchHit(title="Comparatif", url="https://exemple.be/iphone-18-pro", snippet="1 329 €"),
]
LIMIT = "Limite de recherches atteinte : conclus avec ce que tu sais."
UNAVAILABLE = "Recherche indisponible."
INVALID = "Arguments invalides."
UNKNOWN = "Outil inconnu."


def _provider(reasoning_effort: str = "high") -> ProviderConfig:
    return ProviderConfig(
        code="openai-oauth",
        base_url=BASE,
        api_key_env=None,
        base_url_env=None,
        structured_output="json_object",
        cost_source="none",
        extra_body={},
        omit_params=("temperature", "max_tokens"),
        api="responses",
        reasoning_effort=reasoning_effort,  # type: ignore[arg-type]
    )


def _sse(name: str) -> httpx.Response:
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=(FIXTURES / name).read_bytes(),
    )


class _CutStream(httpx.AsyncByteStream):
    """Flux qui envoie `data` puis coupe la connexion."""

    def __init__(self, data: bytes) -> None:
        self._data = data

    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield self._data
        raise httpx.ReadError("connexion coupée")


Reply = str | Callable[[], httpx.Response]


class Proxy:
    """Faux proxy : une réponse par requête, dans l'ordre (la dernière se répète) ; garde le
    corps JSON de chaque requête."""

    def __init__(self, *replies: Reply) -> None:
        self._replies = replies
        self.bodies: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content))
        reply = self._replies[min(len(self.bodies), len(self._replies)) - 1]
        return _sse(reply) if isinstance(reply, str) else reply()


class FakeBackend:
    def __init__(self, hits: list[SearchHit] | None = None, error: Exception | None = None):
        self.hits = HITS if hits is None else hits
        self.error = error
        self.queries: list[str] = []

    async def search(self, query: str) -> list[SearchHit]:
        self.queries.append(query)
        if self.error is not None:
            raise self.error
        return list(self.hits)


class Recorder:
    def __init__(self) -> None:
        self.events: list[LLMEvent] = []

    async def __call__(self, event: LLMEvent) -> None:
        self.events.append(event)


async def _run(
    proxy: Proxy,
    *,
    tool: WebSearchTool | None = None,
    sink: Recorder | None = None,
    reasoning_effort: str = "high",
):
    async with httpx.AsyncClient(transport=httpx.MockTransport(proxy)) as http:
        client = OpenAICompatibleClient(_provider(reasoning_effort), {}, http_client=http)
        return await client.analyze(
            model="gpt-test",
            system_prompt="SYS",
            messages=MESSAGES,
            tools=tool,
            on_event=sink,
        )


def _outputs(body: dict) -> dict[str, str]:
    return {
        item["call_id"]: item["output"]
        for item in body["input"]
        if item.get("type") == "function_call_output"
    }


def _assert_not_chained(error: BaseException) -> None:
    assert error.__cause__ is None
    assert error.__context__ is None


# --- Boucle d'outils ---------------------------------------------------------------------------


async def test_responses_tool_loop():
    proxy = Proxy("responses_search_price.sse", "responses_final.sse")
    backend, sink = FakeBackend(), Recorder()
    tool = WebSearchTool(backend, max_searches=3, on_event=sink)
    result = await _run(proxy, tool=tool, sink=sink)

    assert len(proxy.bodies) == 2
    first, second = proxy.bodies
    assert first["stream"] is True
    assert first["include"] == ["reasoning.encrypted_content"]
    [definition] = first["tools"]
    parameters = definition.pop("parameters")
    assert definition == {
        "type": "function",
        "name": "web_search",
        "description": WebSearchTool.DESCRIPTION,
        "strict": True,
    }
    # Le schéma de l'outil, sans `maxLength` que le mode strict refuse (clean_query coupe à 200).
    expected = tool.parameters()
    del expected["properties"]["query"]["maxLength"]
    assert parameters == expected
    assert "max_output_tokens" not in first  # omis pour openai-oauth
    assert "tool_choice" not in first  # tour 1 sur 5 : le modèle choisit
    # Le proxy force store=false : le tour 2 reprend tout l'historique.
    assert second["input"][0] == first["input"][0]
    kinds = [item.get("type") for item in second["input"][1:]]
    assert kinds == ["reasoning", "function_call", "function_call_output"]
    reasoning, call, output = second["input"][1:]
    assert reasoning["encrypted_content"] == "gAAAA-chiffre-fictif"
    assert (call["call_id"], call["name"]) == ("call_search", "web_search")
    assert json.loads(call["arguments"]) == {"query": "iPhone 18 Pro prix", "aspect": "price"}
    assert output["call_id"] == "call_search"
    assert output["output"].startswith("<resultats_recherche>")
    assert "apple.com" in output["output"]

    assert sink.events == [
        SearchStarted(1, "iPhone 18 Pro prix", "price"),
        SearchDone(1, True, 2, ("apple.com", "exemple.be")),
        Writing(),
    ]
    assert result.searches == [SearchRecord("iPhone 18 Pro prix", "price")]
    assert result.analysis.score == 72
    assert result.rounds == 2
    assert backend.queries == ["iPhone 18 Pro prix"]
    [trace] = result.search_traces
    assert (trace.query, trace.aspect, trace.ok) == ("iPhone 18 Pro prix", "price", True)
    assert trace.output == output["output"] and trace.ms >= 0


async def test_reasoning_summary_events():
    sink = Recorder()
    result = await _run(Proxy("responses_reasoning_final.sse"), sink=sink)
    assert sink.events == [
        Thinking(0, "Vérif"),
        Thinking(0, "Vérifie le prix"),
        Thinking(1, "Annonce cohérente."),
        Writing(),
    ]
    assert result.reasoning_text == "Vérifie le prix\n\nAnnonce cohérente."


async def test_reasoning_parts_continue_across_rounds():
    sink = Recorder()
    tool = WebSearchTool(FakeBackend(), max_searches=3, on_event=sink)
    proxy = Proxy("responses_search_thinking.sse", "responses_reasoning_final.sse")
    await _run(proxy, tool=tool, sink=sink)
    thinking = [e for e in sink.events if isinstance(e, Thinking)]
    assert thinking == [
        Thinking(0, "Je cherche le prix."),
        Thinking(1, "Vérif"),
        Thinking(1, "Vérifie le prix"),
        Thinking(2, "Annonce cohérente."),
    ]
    assert isinstance(sink.events[1], SearchStarted)


def _event(kind: str, **data) -> str:
    return f"event: {kind}\ndata: {json.dumps({'type': kind, **data})}\n\n"


def _synthetic(*events: str) -> Callable[[], httpx.Response]:
    body = "".join(events).encode()
    return lambda: httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)


def _completed(usage: dict | None = None) -> str:
    response = {
        "id": "r",
        "object": "response",
        "created_at": 1,
        "model": "m",
        "status": "completed",
        "output": [],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "usage": usage or {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
    }
    return _event("response.completed", response=response)


def _final_text_events() -> list[str]:
    text = (FIXTURES / "responses_final.sse").read_text(encoding="utf-8")
    return [
        block + "\n\n"
        for block in text.split("\n\n")
        if "output_text.delta" in block or "output_item.done" in block
    ]


async def test_thinking_text_is_capped_at_600_characters():
    sink = Recorder()
    delta = {"item_id": "rs", "output_index": 0, "summary_index": 0}
    reply = _synthetic(
        _event("response.reasoning_summary_text.delta", delta="a" * 590, **delta),
        _event("response.reasoning_summary_text.delta", delta="b" * 20, **delta),
        _event("response.reasoning_summary_text.delta", delta="c" * 5, **delta),
        *_final_text_events(),
        _completed(),
    )
    result = await _run(Proxy(reply), sink=sink)
    thinking = [e for e in sink.events if isinstance(e, Thinking)]
    # Coupé à 600 : le troisième morceau ne change plus le texte affiché, rien n'est émis.
    assert [len(e.text) for e in thinking] == [590, 600]
    assert thinking[-1].text == "a" * 590 + "b" * 10
    assert result.reasoning_text == "a" * 590 + "b" * 20 + "c" * 5  # texte complet (debug)


@pytest.mark.parametrize(("effort", "expected"), [("high", "high"), ("low", "low")])
async def test_reasoning_param_by_effort(effort, expected):
    proxy = Proxy("responses_final.sse")
    await _run(proxy, reasoning_effort=effort)
    assert proxy.bodies[0]["reasoning"] == {"effort": expected, "summary": "auto"}


async def test_reasoning_effort_none_sends_no_reasoning_key():
    proxy = Proxy("responses_final.sse")
    await _run(proxy, reasoning_effort="none")
    assert "reasoning" not in proxy.bodies[0]


async def test_search_limit_then_conclude():
    proxy = Proxy("responses_search_price.sse", "responses_search_price.sse", "responses_final.sse")
    backend, sink = FakeBackend(), Recorder()
    tool = WebSearchTool(backend, max_searches=1, on_event=sink)
    result = await _run(proxy, tool=tool, sink=sink)

    assert len(proxy.bodies) == 3
    assert backend.queries == ["iPhone 18 Pro prix"]
    outputs = [
        item["output"]
        for item in proxy.bodies[2]["input"]
        if item.get("type") == "function_call_output"
    ]
    assert outputs[0].startswith("<resultats_recherche>")
    assert outputs[1] == LIMIT
    assert tool.exhausted
    # max_searches + 2 = 3 tours : le troisième est le dernier possible.
    assert [body.get("tool_choice") for body in proxy.bodies] == [None, None, "none"]
    assert [type(e) for e in sink.events] == [SearchStarted, SearchDone, Writing]
    assert result.rounds == 3
    assert len(result.searches) == 1


@pytest.mark.parametrize("max_searches", [0, 2])
async def test_last_round_tool_choice_none_then_invalid(max_searches):
    # Un modèle qui appelle l'outil à chaque tour, même quand on le lui interdit.
    proxy = Proxy("responses_search_price.sse")
    backend = FakeBackend()
    tool = WebSearchTool(backend, max_searches=max_searches, on_event=None)
    with pytest.raises(LLMError) as info:
        await _run(proxy, tool=tool)
    assert info.value.code == "invalid_response"
    _assert_not_chained(info.value)
    rounds = max_searches + 2
    # Tous les tours, plus une seule nouvelle tentative du dernier.
    assert len(proxy.bodies) == rounds + 1
    choices = [body.get("tool_choice") for body in proxy.bodies]
    assert choices == [None] * (rounds - 1) + ["none", "none"]
    assert len(backend.queries) == max_searches


async def test_unknown_tool_and_bad_arguments():
    proxy = Proxy("responses_bad_calls.sse", "responses_final.sse")
    backend, sink = FakeBackend(), Recorder()
    tool = WebSearchTool(backend, max_searches=3, on_event=sink)
    result = await _run(proxy, tool=tool, sink=sink)

    assert _outputs(proxy.bodies[1]) == {"call_foo": UNKNOWN, "call_bad": INVALID}
    assert backend.queries == []
    assert sink.events == [Writing()]
    assert result.analysis.score == 72 and result.searches == []
    assert result.rounds == 2


@pytest.mark.parametrize("error", [SearchUnavailable("ConnectError"), RuntimeError("bug")])
async def test_backend_down_continues(error):
    proxy = Proxy("responses_search_price.sse", "responses_final.sse")
    sink = Recorder()
    tool = WebSearchTool(FakeBackend(error=error), max_searches=3, on_event=sink)
    result = await _run(proxy, tool=tool, sink=sink)

    assert _outputs(proxy.bodies[1]) == {"call_search": UNAVAILABLE}
    assert sink.events == [
        SearchStarted(1, "iPhone 18 Pro prix", "price"),
        SearchDone(1, False, 0, ()),
        Writing(),
    ]
    assert result.analysis.score == 72
    # Une recherche qui a échoué n'a rien apporté : elle n'est pas affichée, seulement tracée.
    assert result.searches == []
    [trace] = result.search_traces
    assert (trace.ok, trace.output) == (False, UNAVAILABLE)


async def test_no_tools_single_round():
    proxy = Proxy("responses_final.sse")
    sink = Recorder()
    result = await _run(proxy, sink=sink)
    assert len(proxy.bodies) == 1
    assert "tools" not in proxy.bodies[0]
    assert "tool_choice" not in proxy.bodies[0]
    assert result.rounds == 1
    assert (result.searches, result.search_traces) == ([], [])
    assert sink.events == [Writing()]


async def test_function_call_without_tools_is_an_invalid_response():
    proxy = Proxy("responses_search_price.sse")
    with pytest.raises(LLMError) as info:
        await _run(proxy)
    assert info.value.code == "invalid_response"
    assert len(proxy.bodies) == 2


def _server_error() -> httpx.Response:
    return httpx.Response(500, json={"error": {"message": "provider-body-marker"}})


async def test_transport_retry_only_before_events():
    # Erreur 500 avant tout événement : une nouvelle tentative, qui réussit.
    proxy = Proxy(_server_error, "responses_final.sse")
    result = await _run(proxy)
    assert len(proxy.bodies) == 2
    assert result.analysis.score == 72

    # Flux coupé après un `Thinking` : l'extension a déjà reçu quelque chose, pas de reprise.
    data = (FIXTURES / "responses_cut_after_thinking.sse").read_bytes()
    proxy = Proxy(
        lambda: httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=_CutStream(data)
        ),
        "responses_final.sse",
    )
    sink = Recorder()
    with pytest.raises(LLMError) as info:
        await _run(proxy, sink=sink)
    assert info.value.code == "transport"
    assert "provider-body-marker" not in str(info.value)
    _assert_not_chained(info.value)
    assert len(proxy.bodies) == 1
    assert sink.events == [Thinking(0, "Vérif")]


async def test_stream_ending_without_completed_is_transport():
    # Fin de flux sans `response.completed`, après un événement : pas de reprise non plus.
    proxy = Proxy("responses_cut_after_thinking.sse", "responses_final.sse")
    with pytest.raises(LLMError) as info:
        await _run(proxy, sink=Recorder())
    assert info.value.code == "transport"
    assert len(proxy.bodies) == 1


async def test_stream_ending_without_completed_before_events_is_retried():
    proxy = Proxy(_synthetic(_event("response.in_progress", response={})), "responses_final.sse")
    result = await _run(proxy, sink=Recorder())
    assert len(proxy.bodies) == 2
    assert result.analysis.score == 72


async def test_error_event_in_stream_is_transport_without_leak():
    marker = "provider-body-marker-9c1"
    proxy = Proxy(_synthetic(_event("error", code="server_error", message=marker)))
    with pytest.raises(LLMError) as info:
        await _run(proxy)
    assert info.value.code == "transport"
    assert marker not in str(info.value) and marker not in repr(info.value)
    _assert_not_chained(info.value)
    assert len(proxy.bodies) == 2  # aucun événement émis : une nouvelle tentative


async def test_round_timeout_is_transport(monkeypatch):
    class SlowStream(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            import asyncio

            await asyncio.sleep(5)
            yield b""

    monkeypatch.setattr(client_module, "TIMEOUT_S", 0.05)
    proxy = Proxy(
        lambda: httpx.Response(
            200, headers={"content-type": "text/event-stream"}, stream=SlowStream()
        )
    )
    with pytest.raises(LLMError) as info:
        await _run(proxy)
    assert info.value.code == "transport"
    _assert_not_chained(info.value)
    assert len(proxy.bodies) == 2


async def test_tokens_summed_across_rounds():
    proxy = Proxy("responses_search_price.sse", "responses_final.sse")
    tool = WebSearchTool(FakeBackend(), max_searches=3, on_event=None)
    result = await _run(proxy, tool=tool)
    assert (result.tokens_in, result.tokens_out) == (100 + 300, 20 + 80)
    assert result.cost_usd_micros == 0  # cost_source = none


async def test_invalid_final_text_is_retried_then_succeeds():
    bad = _synthetic(
        _event(
            "response.output_text.delta", item_id="m", output_index=0, content_index=0, delta="{"
        ),
        _completed({"input_tokens": 7, "output_tokens": 3, "total_tokens": 10}),
    )
    proxy = Proxy(bad, "responses_final.sse")
    sink = Recorder()
    result = await _run(proxy, sink=sink)
    assert len(proxy.bodies) == 2
    assert proxy.bodies[0] == proxy.bodies[1]  # même tour, même requête
    assert result.analysis.score == 72
    assert result.rounds == 1
    # Les tokens de la réponse refusée sont comptés aussi : ils ont été facturés.
    assert (result.tokens_in, result.tokens_out) == (307, 83)


# --- WebSearchTool -----------------------------------------------------------------------------


def test_parameters_schema():
    tool = WebSearchTool(FakeBackend(), max_searches=3, on_event=None)
    schema = tool.parameters()
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert sorted(schema["required"]) == ["aspect", "query"]
    assert schema["properties"]["query"]["type"] == "string"
    assert schema["properties"]["query"]["maxLength"] == 200
    assert schema["properties"]["aspect"]["enum"] == ["model", "price", "scam", "other"]
    assert WebSearchTool.NAME == "web_search"


async def test_query_is_masked_before_events_and_backend():
    backend, sink = FakeBackend(), Recorder()
    tool = WebSearchTool(backend, max_searches=3, on_event=sink)
    arguments = json.dumps({"query": "arnaque  0470 12 34 56 vendeur@exemple.be", "aspect": "scam"})
    await tool.run(arguments)
    started = sink.events[0]
    assert isinstance(started, SearchStarted)
    assert started.query == "arnaque [téléphone] [email]"
    assert backend.queries == ["arnaque [téléphone] [email]"]
    assert tool.records == [SearchRecord("arnaque [téléphone] [email]", "scam")]


async def test_ids_start_at_one_and_increment():
    sink = Recorder()
    tool = WebSearchTool(FakeBackend(), max_searches=3, on_event=sink)
    for query in ("a", "b"):
        await tool.run(json.dumps({"query": query, "aspect": "other"}))
    assert [e.id for e in sink.events] == [1, 1, 2, 2]
    assert not tool.exhausted


@pytest.mark.parametrize(
    "arguments",
    [
        "{cassé",
        "[]",
        '"texte"',
        "null",
        json.dumps({"query": "x"}),
        json.dumps({"aspect": "price"}),
        json.dumps({"query": 3, "aspect": "price"}),
        json.dumps({"query": "x", "aspect": "prix"}),
        json.dumps({"query": "   ", "aspect": "price"}),
        "[" * 100_000,  # trop profond pour le décodeur
    ],
)
async def test_bad_arguments_are_invalid_without_event_or_search(arguments):
    backend, sink = FakeBackend(), Recorder()
    tool = WebSearchTool(backend, max_searches=3, on_event=sink)
    assert await tool.run(arguments) == INVALID
    assert (backend.queries, sink.events, tool.records, tool.traces) == ([], [], [], [])


async def test_limit_reached_without_event_or_search():
    backend, sink = FakeBackend(), Recorder()
    tool = WebSearchTool(backend, max_searches=1, on_event=sink)
    arguments = json.dumps({"query": "x", "aspect": "price"})
    assert (await tool.run(arguments)).startswith("<resultats_recherche>")
    assert tool.exhausted
    assert await tool.run(arguments) == LIMIT
    assert len(backend.queries) == 1 and len(sink.events) == 2


async def test_empty_results_are_a_successful_search():
    sink = Recorder()
    tool = WebSearchTool(FakeBackend(hits=[]), max_searches=3, on_event=sink)
    output = await tool.run(json.dumps({"query": "x", "aspect": "model"}))
    assert "Aucun résultat." in output
    assert sink.events[1] == SearchDone(1, True, 0, ())


async def test_failed_search_counts_toward_the_limit():
    tool = WebSearchTool(FakeBackend(error=SearchUnavailable("x")), max_searches=1, on_event=None)
    assert await tool.run(json.dumps({"query": "x", "aspect": "model"})) == UNAVAILABLE
    assert tool.exhausted
