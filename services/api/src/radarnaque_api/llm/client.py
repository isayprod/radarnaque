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
    de corps de réponse. Elle est toujours levée **hors** du bloc `except` qui a intercepté
    l'erreur d'origine : ni `__cause__` ni `__context__` ne la rattachent à cette exception, qui
    peut porter le corps renvoyé et la requête (en-tête Authorization compris)."""

    def __init__(self, code: LLMErrorCode, provider: str | None = None) -> None:
        prefix = f"fournisseur {provider} : " if provider else ""
        super().__init__(prefix + _MESSAGES[code])
        self.code: LLMErrorCode = code


class LLMClient(Protocol):
    async def analyze(
        self, *, model: str, system_prompt: str, messages: list[dict]
    ) -> LLMResult: ...


# Mots-clés que la sortie structurée stricte d'OpenAI refuse ; Pydantic les vérifie de toute
# façon à la réception.
_UNSUPPORTED_KEYWORDS = {"title", "minLength", "maxLength"}


_SUBSCHEMA_KEYS = {"items", "additionalProperties", "not"}
_SUBSCHEMA_LIST_KEYS = {"anyOf", "allOf", "oneOf", "prefixItems"}
_SUBSCHEMA_MAP_KEYS = {"properties", "patternProperties"}


def _strict(node: dict[str, Any], defs: Mapping[str, Any]) -> dict[str, Any]:
    """Transforme un nœud de schéma. Les mots-clés ne sont filtrés que sur les nœuds : les clés
    d'une table `properties` sont des noms de champs (un champ `title` reste)."""
    if "$ref" in node:
        return _strict(defs[node["$ref"].removeprefix("#/$defs/")], defs)
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key in _UNSUPPORTED_KEYWORDS:
            continue
        if key in _SUBSCHEMA_MAP_KEYS:
            out[key] = {name: _strict(sub, defs) for name, sub in value.items()}
        elif key in _SUBSCHEMA_KEYS and isinstance(value, dict):
            out[key] = _strict(value, defs)
        elif key in _SUBSCHEMA_LIST_KEYS:
            out[key] = [_strict(sub, defs) for sub in value]
        else:
            out[key] = deepcopy(value)
    if out.get("type") == "object":
        out["additionalProperties"] = False
        out["required"] = list(out.get("properties", {}))
    return out


def strict_json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Schéma JSON de `model`, autonome (sans `$ref`) et fermé, accepté en mode strict."""
    schema = model.model_json_schema()
    defs = schema.pop("$defs", {})
    return _strict(schema, defs)


@cache
def _strict_schema_cached() -> dict[str, Any]:
    return strict_json_schema(LLMAnalysis)


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

    @property
    def max_images(self) -> int | None:
        """Limite d'images par requête propre au fournisseur (None : aucune)."""
        return self._provider.max_images

    def _error(self, code: LLMErrorCode) -> LLMError:
        return LLMError(code, self._provider.code)

    async def aclose(self) -> None:
        """Ferme le client du SDK (et le client HTTP qu'il utilise), s'il a été créé."""
        if self._client is not None:
            client, self._client = self._client, None
            await client.close()

    def _openai(self) -> AsyncOpenAI:
        # Résolu au premier appel : une clé absente fait échouer l'analyse, pas la construction.
        if self._client is None:
            try:
                base_url = self._provider.resolved_base_url(self._env)
                api_key: str | None = self._provider.api_key(self._env)
            except ProviderError:
                api_key = None
            if api_key is None:  # levée hors du `except` : aucun contexte chaîné
                raise self._error("configuration")
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
        for param in self._provider.omit_params:
            del request[param]
        # Chaque `except` ne fait que noter le code ; l'erreur est levée après le bloc, pour
        # qu'aucune exception d'origine (corps, requête, Authorization) ne lui soit chaînée.
        code: LLMErrorCode = "transport"
        for _ in range(ATTEMPTS):
            fatal: LLMErrorCode | None = None
            try:
                return await self._attempt(client, request)
            except _Invalid:
                code = "invalid_response"
            except openai.APIStatusError as exc:
                if exc.status_code in (401, 403):
                    fatal = "configuration"
                elif exc.status_code < 500:  # requête refusée : la répéter ne changerait rien
                    fatal = "transport"
                else:
                    code = "transport"
            except openai.APIConnectionError:  # connexion impossible ou délai dépassé
                code = "transport"
            if fatal is not None:
                raise self._error(fatal)
        raise self._error(code)


class LLMClientFactory:
    """`factory(code)` : le client du fournisseur `code`, créé au premier appel puis réutilisé.
    Chaque client a son propre client HTTP, celui du SDK : jamais celui des photos. Un code
    absent de `providers.toml` lève `ProviderError`."""

    def __init__(self, providers: Mapping[str, ProviderConfig], env: Mapping[str, str]) -> None:
        self._providers = providers
        self._env = env
        self._clients: dict[str, OpenAICompatibleClient] = {}

    def __call__(self, code: str) -> OpenAICompatibleClient:
        client = self._clients.get(code)
        if client is None:
            provider = self._providers.get(code)
            if provider is None:
                raise ProviderError(f"fournisseur inconnu dans providers.toml : {code}")
            client = self._clients[code] = OpenAICompatibleClient(provider, self._env)
        return client

    async def aclose(self) -> None:
        """Ferme les clients créés (arrêt de l'application)."""
        clients, self._clients = list(self._clients.values()), {}
        for client in clients:
            await client.aclose()
