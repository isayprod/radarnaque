import json
from collections.abc import AsyncIterator, Iterator
from dataclasses import replace

import httpx
import pytest
import respx
from pydantic import BaseModel

from radarnaque_api.llm.client import (
    LLMAnalysis,
    LLMClientFactory,
    LLMError,
    OpenAICompatibleClient,
    strict_analysis_schema,
    strict_json_schema,
)
from radarnaque_api.llm.providers import ProviderConfig, ProviderError

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
    )


OPENROUTER_EXTRA = {
    "provider": {"data_collection": "deny"},
    "usage": {"include": True},
    "reasoning": {"enabled": False},
}


def _completion(content: str | None, usage: dict | None = None) -> dict:
    return {
        "id": "cmpl-1",
        "object": "chat.completion",
        "created": 1,
        "model": "m",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": content},
            }
        ],
        "usage": usage
        if usage is not None
        else {"prompt_tokens": 120, "completion_tokens": 80, "total_tokens": 200},
    }


def _ok(analysis: dict | None = None, usage: dict | None = None, headers=None) -> httpx.Response:
    return httpx.Response(
        200, json=_completion(json.dumps(analysis or VALID), usage), headers=headers
    )


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
    assert body["max_tokens"] == 800
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
    assert body["reasoning"] == {"enabled": False}
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
    route = mock.post("/chat/completions").mock(
        side_effect=[httpx.Response(200, json=_completion("pas du json")), _ok()]
    )
    result = await _analyze(_provider(), http)
    assert route.call_count == 2
    assert result.analysis.score == 72


async def test_two_invalid_responses_raise_invalid_response(mock, http):
    route = mock.post("/chat/completions").mock(
        return_value=httpx.Response(200, json=_completion("{cassé"))
    )
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


async def test_empty_content_or_non_json_body_is_an_invalid_response(mock, http):
    route = mock.post("/chat/completions").mock(
        side_effect=[
            httpx.Response(200, json=_completion(None)),
            httpx.Response(200, text="<html>oops</html>"),
        ]
    )
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "invalid_response"
    assert route.call_count == 2


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
    assert body["max_tokens"] == 800


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


async def test_timeout_twice_raises_transport(mock, http):
    route = mock.post("/chat/completions").mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(LLMError) as info:
        await _analyze(_provider(), http)
    assert info.value.code == "transport"
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


async def test_timeout_of_30_seconds_reaches_the_request(mock, http):
    route = mock.post("/chat/completions").mock(return_value=_ok())
    await _analyze(_provider(), http)
    timeout = route.calls.last.request.extensions["timeout"]
    assert timeout == {"connect": 30, "read": 30, "write": 30, "pool": 30}


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
    body = _completion(json.dumps(VALID))
    del body["usage"]
    mock.post("/chat/completions").mock(return_value=httpx.Response(200, json=body))
    result = await _analyze(_provider(cost_source="usage_cost"), http)
    assert (result.tokens_in, result.tokens_out, result.cost_usd_micros) == (0, 0, 0)


async def test_omniroute_cost_header_in_micro_dollars(mock, http):
    headers = {"X-OmniRoute-Response-Cost": "0.0012345679"}
    mock.post("/chat/completions").mock(return_value=_ok(headers=headers))
    result = await _analyze(_provider(cost_source="omniroute_headers"), http)
    assert result.cost_usd_micros == 1235


@pytest.mark.parametrize("headers", [None, {"X-OmniRoute-Response-Cost": "n/a"}])
async def test_omniroute_cost_header_absent_or_unreadable_is_zero(mock, http, headers):
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
