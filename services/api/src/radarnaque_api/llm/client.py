"""Client LLM compatible OpenAI, paramétré par un fournisseur de `providers.toml`.

Aucun secret ne sort d'ici : ni la clé, ni l'URL résolue, ni les corps de requête ou de réponse
n'apparaissent dans un message d'erreur, et rien n'est journalisé."""

import json
import math
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from functools import cache
from typing import Annotated, Any, Literal, Protocol

import httpx
import openai
from openai import AsyncOpenAI
from pydantic import BaseModel, Field, StringConstraints

from radarnaque_api.llm.providers import ProviderConfig, ProviderError

TEMPERATURE = 0.2
MAX_TOKENS = 800
TIMEOUT_S = 30
ATTEMPTS = 2  # une seule nouvelle tentative
SCHEMA_NAME = "radarnaque_analysis"

# OmniRoute (https://github.com/diegosouzapw/OmniRoute, docs/reference/API_REFERENCE.md,
# « Cost telemetry headers ») : les réponses non diffusées en flux portent
# `X-OmniRoute-Response-Cost`, coût en dollars US avec 10 décimales fixes (« 0.0000000000 »
# pour un modèle gratuit ou sans tarif, et pour un succès servi depuis son cache sémantique).
OMNIROUTE_COST_HEADER = "x-omniroute-response-cost"

NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class Bilingual(BaseModel):
    fr: NonEmptyStr
    nl: NonEmptyStr


class LLMReason(BaseModel):
    severity: Literal["info", "warning", "danger"]
    fr: NonEmptyStr
    nl: NonEmptyStr


class LLMAnalysis(BaseModel):
    score: int = Field(ge=0, le=100)
    summary: Bilingual
    advice: Bilingual
    reasons: list[LLMReason] = Field(max_length=5)


@dataclass
class LLMResult:
    analysis: LLMAnalysis
    tokens_in: int
    tokens_out: int
    cost_usd_micros: int


LLMErrorCode = Literal["transport", "invalid_response", "configuration"]

_MESSAGES: dict[str, str] = {
    "transport": "fournisseur LLM injoignable ou en erreur",
    "invalid_response": "réponse du LLM invalide",
    "configuration": "fournisseur LLM mal configuré (clé absente ou refusée, URL invalide)",
}


class LLMError(Exception):
    """Le message ne contient que le code du fournisseur et un texte fixe, jamais de secret ni
    de corps de réponse. Toujours levée avec `from None` : l'exception d'origine (qui peut
    citer le corps renvoyé) n'est pas chaînée."""

    def __init__(self, code: LLMErrorCode, provider: str) -> None:
        super().__init__(f"fournisseur {provider} : {_MESSAGES[code]}")
        self.code: LLMErrorCode = code


class LLMClient(Protocol):
    async def analyze(
        self, *, model: str, system_prompt: str, messages: list[dict]
    ) -> LLMResult: ...


# Mots-clés que la sortie structurée stricte d'OpenAI refuse ; Pydantic les vérifie de toute
# façon à la réception.
_UNSUPPORTED_KEYWORDS = {"title", "minLength", "maxLength"}


def _strict(node: Any, defs: Mapping[str, Any]) -> Any:
    if isinstance(node, list):
        return [_strict(item, defs) for item in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        return _strict(defs[node["$ref"].removeprefix("#/$defs/")], defs)
    out = {k: _strict(v, defs) for k, v in node.items() if k not in _UNSUPPORTED_KEYWORDS}
    if out.get("type") == "object":
        out["additionalProperties"] = False
        out["required"] = list(out.get("properties", {}))
    return out


@cache
def _strict_schema_cached() -> dict[str, Any]:
    schema = LLMAnalysis.model_json_schema()
    defs = schema.pop("$defs", {})
    return _strict(schema, defs)


def strict_analysis_schema() -> dict[str, Any]:
    """Schéma JSON de `LLMAnalysis`, autonome (sans `$ref`) et fermé, accepté en mode strict."""
    return deepcopy(_strict_schema_cached())


def _non_negative_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            return None
    if not isinstance(value, int | float) or not math.isfinite(value) or value < 0:
        return None
    return float(value)


def _micros(dollars: Any) -> int:
    value = _non_negative_number(dollars)
    return 0 if value is None else round(value * 1_000_000)


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


class _Invalid(Exception):
    pass


class OpenAICompatibleClient:
    def __init__(
        self,
        provider: ProviderConfig,
        env: Mapping[str, str],
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._provider = provider
        self._env = env
        self._http_client = http_client
        self._client: AsyncOpenAI | None = None

    def _error(self, code: LLMErrorCode) -> LLMError:
        return LLMError(code, self._provider.code)

    def _openai(self) -> AsyncOpenAI:
        # Résolu au premier appel : une clé absente fait échouer l'analyse, pas la construction.
        if self._client is None:
            try:
                base_url = self._provider.resolved_base_url(self._env)
                api_key = self._provider.api_key(self._env)
            except ProviderError:
                raise self._error("configuration") from None
            self._client = AsyncOpenAI(
                base_url=base_url,
                api_key=api_key or "unused",
                timeout=TIMEOUT_S,
                max_retries=0,
                http_client=self._http_client,
            )
        return self._client

    def _response_format(self) -> dict[str, Any]:
        if self._provider.structured_output == "json_schema":
            return {
                "type": "json_schema",
                "json_schema": {
                    "name": SCHEMA_NAME,
                    "strict": True,
                    "schema": strict_analysis_schema(),
                },
            }
        return {"type": "json_object"}

    def _system_prompt(self, system_prompt: str) -> str:
        if self._provider.structured_output == "json_schema":
            return system_prompt
        schema = json.dumps(strict_analysis_schema(), ensure_ascii=False)
        return f"{system_prompt}\n\nSchéma JSON exact de la réponse :\n{schema}"

    def _cost(self, usage: Any, headers: httpx.Headers) -> int:
        match self._provider.cost_source:
            case "usage_cost":
                return _micros(getattr(usage, "cost", None))
            case "omniroute_headers":
                return _micros(headers.get(OMNIROUTE_COST_HEADER))
            case _:
                return 0

    async def _attempt(self, client: AsyncOpenAI, request: dict[str, Any]) -> LLMResult:
        raw = await client.chat.completions.with_raw_response.create(**request)
        try:
            completion = raw.parse()
            content = completion.choices[0].message.content
            if not content:
                raise _Invalid
            analysis = LLMAnalysis.model_validate_json(content)
        except (
            ValueError,  # inclut ValidationError et les JSON illisibles
            TypeError,
            IndexError,
            AttributeError,
            openai.APIResponseValidationError,
        ):
            raise _Invalid from None
        usage = completion.usage
        return LLMResult(
            analysis=analysis,
            tokens_in=_count(getattr(usage, "prompt_tokens", None)),
            tokens_out=_count(getattr(usage, "completion_tokens", None)),
            cost_usd_micros=self._cost(usage, raw.headers),
        )

    async def analyze(self, *, model: str, system_prompt: str, messages: list[dict]) -> LLMResult:
        client = self._openai()
        extra_body = self._provider.extra_body_dict()
        request: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": self._system_prompt(system_prompt)},
                *messages,
            ],
            "temperature": TEMPERATURE,
            "max_tokens": MAX_TOKENS,
            "response_format": self._response_format(),
            "extra_body": extra_body or None,
        }
        code: LLMErrorCode = "transport"
        for _ in range(ATTEMPTS):
            try:
                return await self._attempt(client, request)
            except _Invalid:
                code = "invalid_response"
            except openai.APIStatusError as exc:
                status = exc.status_code
                if status in (401, 403):
                    raise self._error("configuration") from None
                if status < 500:  # requête refusée : la répéter ne changerait rien
                    raise self._error("transport") from None
                code = "transport"
            except openai.APIConnectionError:  # connexion impossible ou délai dépassé
                code = "transport"
        raise self._error(code) from None
