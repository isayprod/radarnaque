"""Client LLM compatible OpenAI, paramétré par un fournisseur de `providers.toml`.

Aucun secret ne sort d'ici : ni la clé, ni l'URL résolue, ni les corps de requête ou de réponse
n'apparaissent dans un message d'erreur, et rien n'est journalisé.

L'analyse est une boucle de tours, commune aux deux API : un tour qui appelle l'outil
`web_search` reçoit ses sorties au tour suivant ; le premier tour sans appel d'outil donne la
réponse finale, validée par `LLMAnalysis`. Seules la construction des requêtes et la lecture
des réponses dépendent de l'API (Responses en flux ; Chat sans flux ni outil jusqu'à la
tâche 6)."""

import asyncio
import json
import math
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from functools import cache
from typing import Annotated, Any, Literal, Protocol

import httpx
import openai
from openai import AsyncOpenAI
from pydantic import BaseModel, Field, StringConstraints

from radarnaque_api.llm.events import EventSink, LLMEvent, Thinking, Writing
from radarnaque_api.llm.providers import ProviderConfig, ProviderError
from radarnaque_api.llm.tools import UNKNOWN_TOOL, SearchRecord, SearchTrace, WebSearchTool

__all__ = ["SearchRecord"]  # réexporté : défini avec l'outil, utilisé avec LLMResult

TEMPERATURE = 0.2
MAX_TOKENS = 4000  # place laissée à la réflexion
TIMEOUT_S = 90  # par tour de modèle : délai du SDK et durée totale du tour
ATTEMPTS = 2  # une seule nouvelle tentative par analyse
SCHEMA_NAME = "radarnaque_analysis"
THINKING_MAX = 600  # caractères d'une partie de réflexion relayés à l'extension

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
    # Faux par défaut : une réponse au format v1, sans ce champ, reste valide. Le schéma strict
    # l'exige, comme tous les champs.
    professional: bool = False
    summary: Bilingual
    advice: Bilingual
    reasons: list[LLMReason] = Field(max_length=5)


@dataclass
class LLMResult:
    """`raw_text` : contenu de la réponse du modèle, tel que reçu ; `system_prompt` : prompt
    système réellement envoyé (schéma compris en mode `json_object`). Les deux ne servent qu'au
    bloc debug du superuser ; les faux clients des tests peuvent les laisser vides. `searches` :
    recherches web réussies, dans l'ordre ; vide pour un client sans l'outil. `search_traces`,
    `reasoning_text` (résumés de réflexion complets) et `rounds` (tours du modèle, nouvelle
    tentative non comptée) servent au bloc debug. Les tokens et le coût couvrent tous les
    appels faits, réponse refusée comprise."""

    analysis: LLMAnalysis
    tokens_in: int
    tokens_out: int
    cost_usd_micros: int
    raw_text: str = ""
    system_prompt: str = ""
    searches: list[SearchRecord] = field(default_factory=list)
    search_traces: list[SearchTrace] = field(default_factory=list)
    reasoning_text: str = ""
    rounds: int = 1


LLMErrorCode = Literal["transport", "timeout", "invalid_response", "configuration"]

_MESSAGES: dict[str, str] = {
    "transport": "fournisseur LLM injoignable ou en erreur",
    "timeout": "fournisseur LLM trop lent (délai d'un tour dépassé)",
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
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict],
        tools: WebSearchTool | None = None,
        on_event: EventSink | None = None,
    ) -> LLMResult: ...


# Mots-clés que la sortie structurée stricte d'OpenAI refuse ; Pydantic les vérifie de toute
# façon à la réception. `default` n'a pas de sens en mode strict, où tout champ est exigé.
_UNSUPPORTED_KEYWORDS = {"title", "minLength", "maxLength", "default"}


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


class _StreamFailed(Exception):
    """Flux coupé avant `response.completed`, ou erreur annoncée dans le flux."""


@dataclass(frozen=True)
class _ToolCall:
    call_id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class _Round:
    """Un tour du modèle, quelle que soit l'API : appels d'outils, ou texte de la réponse finale.
    `replay` : éléments de la réponse à recopier dans l'historique du tour suivant."""

    text: str
    calls: list[_ToolCall]
    tokens_in: int
    tokens_out: int
    cost_usd_micros: int
    replay: list[dict[str, Any]] = field(default_factory=list)


class _Reasoning:
    """Résumés de réflexion de toute l'analyse. Une partie (élément de réflexion, index de
    résumé) reçoit un numéro à sa première apparition, à partir de 0, sans repartir à zéro d'un
    tour à l'autre."""

    def __init__(self) -> None:
        self._parts: dict[tuple[object, object], int] = {}
        self._texts: list[str] = []

    def add(self, key: tuple[object, object], delta: str) -> Thinking | None:
        """`Thinking` à relayer, ou None si le texte affiché (600 caractères) ne change pas."""
        part = self._parts.get(key)
        if part is None:
            part = self._parts[key] = len(self._texts)
            self._texts.append("")
        shown = self._texts[part][:THINKING_MAX]
        self._texts[part] += delta
        text = self._texts[part][:THINKING_MAX]
        return Thinking(part, text) if text != shown else None

    @property
    def text(self) -> str:
        """Texte complet, parties séparées par une ligne vide (bloc debug)."""
        return "\n\n".join(text for text in self._texts if text)


class _RoundSink:
    """Récepteur des événements d'un tour : note si l'un d'eux est parti. Une coupure ne se
    reprend alors plus, l'extension ayant déjà affiché une partie du tour."""

    def __init__(self, on_event: EventSink | None) -> None:
        self._on_event = on_event
        self.emitted = False

    async def __call__(self, event: LLMEvent) -> None:
        self.emitted = True
        if self._on_event is not None:
            await self._on_event(event)


def _validated(text: str) -> LLMAnalysis | None:
    if not text:
        return None
    try:
        return LLMAnalysis.model_validate_json(text)
    except ValueError:  # inclut ValidationError et les JSON illisibles
        return None


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _is_call(item: Any) -> bool:
    return getattr(item, "type", None) == "function_call"


def _tool_call(item: Any) -> _ToolCall:
    """Appel de fonction d'un élément `output` ; identifiant ou nom absent : réponse invalide."""
    call_id, name = getattr(item, "call_id", None), getattr(item, "name", None)
    if not isinstance(call_id, str) or not call_id or not isinstance(name, str):
        raise _Invalid
    return _ToolCall(call_id=call_id, name=name, arguments=_str(getattr(item, "arguments", None)))


def _dump(item: Any) -> dict[str, Any]:
    """Élément `output` recopié tel quel dans l'`input` du tour suivant."""
    if isinstance(item, BaseModel):
        return item.model_dump(exclude_none=True)
    if isinstance(item, dict):
        return dict(item)
    raise _Invalid


# Nom, dans l'API Responses, des paramètres de `omit_params` (désignés par leur nom Chat).
_RESPONSES_PARAMS: dict[str, str] = {
    "temperature": "temperature",
    "max_tokens": "max_output_tokens",
}


def _responses_content(content: str | list[dict]) -> list[dict[str, Any]]:
    """Contenu d'un message au format Chat converti en parts de l'API Responses : `text` devient
    `input_text`, `image_url` devient `input_image` (l'URL, data URL comprise, passe telle
    quelle)."""
    if isinstance(content, str):
        return [{"type": "input_text", "text": content}]
    parts: list[dict[str, Any]] = []
    for part in content:
        if part.get("type") == "image_url":
            parts.append({"type": "input_image", "image_url": part["image_url"]["url"]})
        else:
            parts.append({"type": "input_text", "text": part.get("text", "")})
    return parts


def response_text(response: Any) -> str:
    """Texte d'une réponse de l'API Responses : `output_text` (raccourci du SDK) ou, à défaut,
    la concaténation des parts `output_text` des messages de `output`."""
    text = getattr(response, "output_text", None)
    if isinstance(text, str):
        return text
    return output_text(getattr(response, "output", None) or [])


def output_text(items: list[Any]) -> str:
    """Concaténation des parts `output_text` des messages d'une liste d'éléments `output`."""
    texts: list[str] = []
    for item in items:
        if getattr(item, "type", None) != "message":
            continue
        for part in getattr(item, "content", None) or []:
            value = getattr(part, "text", None)
            if getattr(part, "type", None) == "output_text" and isinstance(value, str):
                texts.append(value)
    return "".join(texts)


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

    def final_system_prompt(self, system_prompt: str) -> str:
        """Prompt système tel qu'envoyé au fournisseur : en mode `json_object`, le schéma exact
        de la réponse y est ajouté. Réutilisé par le bloc debug d'un scan servi par le cache."""
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

    # --- Boucle commune aux deux API -----------------------------------------------------------

    async def analyze(
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict],
        tools: WebSearchTool | None = None,
        on_event: EventSink | None = None,
    ) -> LLMResult:
        """Tours du modèle jusqu'à sa réponse finale. Au plus `max_searches + 2` tours : le
        dernier possible est demandé sans outil (`tool_choice: "none"`), et un appel d'outil
        reçu à ce tour est une réponse invalide. Une seule nouvelle tentative pour toute
        l'analyse : d'une réponse invalide (même tour, même requête), ou d'une erreur de
        transport tant que le tour n'a émis aucun événement."""
        client = self._openai()
        request = self._request(model, system_prompt, messages)
        max_rounds = (tools.max_searches if tools else 0) + 2
        reasoning = _Reasoning()
        retries = ATTEMPTS - 1
        tokens_in = tokens_out = cost = 0
        round_no = 1
        # Chaque `except` ne fait que noter le code ; l'erreur est levée hors du bloc, pour
        # qu'aucune exception d'origine (corps, requête, Authorization) ne lui soit chaînée.
        while True:
            last = tools is None or round_no >= max_rounds
            sink = _RoundSink(on_event)
            code: LLMErrorCode = "transport"
            retryable = False
            fatal: LLMErrorCode | None = None
            outcome: _Round | None = None
            try:
                async with asyncio.timeout(TIMEOUT_S):
                    outcome = await self._round(
                        client, self._round_request(request, tools, last), sink, reasoning
                    )
            except (_Invalid, openai.APIResponseValidationError):
                code, retryable = "invalid_response", True
            except openai.APIStatusError as exc:
                if exc.status_code in (401, 403):
                    fatal = "configuration"
                elif exc.status_code < 500:  # requête refusée : la répéter ne changerait rien
                    fatal = "transport"
                else:
                    retryable = not sink.emitted
            # Délai dépassé : celui du SDK (90 s sans réponse) ou la durée totale du tour.
            except (openai.APITimeoutError, TimeoutError):
                code, retryable = "timeout", not sink.emitted
            # Connexion impossible, flux coupé, ou erreur annoncée dans le flux
            # (`openai.APIError`).
            except (openai.APIError, _StreamFailed):
                retryable = not sink.emitted
            if fatal is not None:
                raise self._error(fatal)
            if outcome is not None:
                tokens_in += outcome.tokens_in
                tokens_out += outcome.tokens_out
                cost += outcome.cost_usd_micros
                if outcome.calls and not last:
                    assert tools is not None  # `last` est vrai sans outil
                    await self._answer_calls(request, outcome, tools)
                    round_no += 1
                    continue
                analysis = None if outcome.calls else _validated(outcome.text)
                if analysis is not None:
                    return LLMResult(
                        analysis=analysis,
                        tokens_in=tokens_in,
                        tokens_out=tokens_out,
                        cost_usd_micros=cost,
                        raw_text=outcome.text,
                        system_prompt=self.final_system_prompt(system_prompt),
                        searches=tools.records if tools else [],
                        search_traces=tools.traces if tools else [],
                        reasoning_text=reasoning.text,
                        rounds=round_no,
                    )
                code, retryable = "invalid_response", True
            if retryable and retries > 0:
                retries -= 1
                continue
            raise self._error(code)

    async def _answer_calls(
        self, request: dict[str, Any], outcome: _Round, tools: WebSearchTool
    ) -> None:
        """Exécute les appels d'outils du tour, dans l'ordre, puis ajoute le tour et leurs
        sorties à l'historique. Un outil inconnu reçoit une sortie fixe, sans rien exécuter."""
        outputs: list[tuple[_ToolCall, str]] = []
        for call in outcome.calls:
            output = await tools.run(call.arguments) if call.name == tools.NAME else UNKNOWN_TOOL
            outputs.append((call, output))
        # Voie Chat : aucun outil n'est proposé, donc aucun appel, avant la tâche 6.
        self._responses_extend(request, outcome, outputs)

    def _request(self, model: str, system_prompt: str, messages: list[dict]) -> dict[str, Any]:
        if self._provider.api == "responses":
            return self._responses_request(model, system_prompt, messages)
        return self._chat_request(model, system_prompt, messages)

    def _round_request(
        self, request: dict[str, Any], tools: WebSearchTool | None, last: bool
    ) -> dict[str, Any]:
        if self._provider.api == "responses":
            return self._responses_round_request(request, tools, last)
        return request  # voie Chat : `tools` ignoré jusqu'à la tâche 6

    async def _round(
        self,
        client: AsyncOpenAI,
        request: dict[str, Any],
        sink: _RoundSink,
        reasoning: _Reasoning,
    ) -> _Round:
        if self._provider.api == "responses":
            return await self._responses_round(client, request, sink, reasoning)
        return await self._chat_round(client, request)  # sans flux ni événement (tâche 6)

    # --- API Responses (en flux) ---------------------------------------------------------------

    def _responses_request(
        self, model: str, system_prompt: str, messages: list[dict]
    ) -> dict[str, Any]:
        """Requête de l'API Responses : prompt système dans `instructions`, messages convertis
        dans `input`. Pas de `response_format` : le JSON est imposé par le prompt (schéma
        ajouté en mode `json_object`) puis vérifié par Pydantic. Le proxy openai-oauth force
        `store=false` : `input` porte tout l'historique, réflexion chiffrée comprise."""
        extra_body = self._provider.extra_body_dict()
        request: dict[str, Any] = {
            "model": model,
            "instructions": self.final_system_prompt(system_prompt),
            "input": [
                {"role": message["role"], "content": _responses_content(message["content"])}
                for message in messages
            ],
            "stream": True,
            "include": ["reasoning.encrypted_content"],
            "temperature": TEMPERATURE,
            "max_output_tokens": MAX_TOKENS,
            "extra_body": extra_body or None,
        }
        effort = self._provider.reasoning_effort
        if effort != "none":
            request["reasoning"] = {"effort": effort, "summary": "auto"}
        for param in self._provider.omit_params:
            del request[_RESPONSES_PARAMS[param]]
        return request

    def _responses_round_request(
        self, request: dict[str, Any], tools: WebSearchTool | None, last: bool
    ) -> dict[str, Any]:
        round_request = {**request, "input": list(request["input"])}
        if tools is not None:
            round_request["tools"] = [
                {
                    "type": "function",
                    "name": tools.NAME,
                    "description": tools.DESCRIPTION,
                    # Filtré comme le schéma de la réponse : le mode strict refuse `maxLength`
                    # (la requête est de toute façon coupée à 200 caractères par clean_query).
                    "parameters": _strict(tools.parameters(), {}),
                    "strict": True,
                }
            ]
            if last:
                round_request["tool_choice"] = "none"
        return round_request

    def _responses_extend(
        self, request: dict[str, Any], outcome: _Round, outputs: list[tuple[_ToolCall, str]]
    ) -> None:
        """L'`input` reçoit les éléments `output` du tour (réflexion chiffrée, appels), puis un
        `function_call_output` par appel."""
        history = request["input"]
        history.extend(outcome.replay)
        history.extend(
            {"type": "function_call_output", "call_id": call.call_id, "output": output}
            for call, output in outputs
        )

    async def _responses_round(
        self,
        client: AsyncOpenAI,
        request: dict[str, Any],
        sink: _RoundSink,
        reasoning: _Reasoning,
    ) -> _Round:
        """Un tour en flux : relaie les résumés de réflexion et le début de la réponse finale,
        puis rend les éléments de `output` (ceux de `response.output_item.done`, ou à défaut
        ceux de `response.completed`)."""
        stream = await client.responses.create(**request)
        items: dict[int, Any] = {}
        deltas: list[str] = []
        completed: Any = None
        calling = writing = False
        try:
            while True:
                # Seuls la lecture et le décodage du flux sont sous `try` : une erreur du
                # récepteur d'événements remonte telle quelle, jamais prise pour une réponse
                # invalide.
                try:
                    event = await anext(stream)
                except StopAsyncIteration:
                    break
                except ValueError:  # ligne `data:` illisible
                    raise _Invalid from None
                kind = getattr(event, "type", None)
                if kind == "response.reasoning_summary_text.delta":
                    key = (getattr(event, "item_id", None), getattr(event, "summary_index", None))
                    thinking = reasoning.add(key, _str(getattr(event, "delta", None)))
                    if thinking is not None:
                        await sink(thinking)
                elif kind in ("response.output_item.added", "response.output_item.done"):
                    item = getattr(event, "item", None)
                    calling = calling or getattr(item, "type", None) == "function_call"
                    if kind == "response.output_item.done":
                        index = getattr(event, "output_index", None)
                        items[index if isinstance(index, int) else len(items)] = item
                elif kind == "response.output_text.delta":
                    deltas.append(_str(getattr(event, "delta", None)))
                    if not calling and not writing:
                        writing = True
                        await sink(Writing())
                elif kind == "response.completed":
                    completed = getattr(event, "response", None)
                elif kind in ("error", "response.failed"):
                    raise _StreamFailed
                elif kind == "response.incomplete":  # réponse coupée (limite de tokens)
                    raise _Invalid
        finally:
            await stream.close()
        if completed is None:
            raise _StreamFailed
        output = [items[index] for index in sorted(items)]
        if not output:
            output = list(getattr(completed, "output", None) or [])
        usage = getattr(completed, "usage", None)
        return _Round(
            text=output_text(output) or "".join(deltas),
            calls=[_tool_call(item) for item in output if _is_call(item)],
            tokens_in=_count(getattr(usage, "input_tokens", None)),
            tokens_out=_count(getattr(usage, "output_tokens", None)),
            cost_usd_micros=self._cost(usage, stream.response.headers),
            replay=[_dump(item) for item in output],
        )

    # --- API Chat (sans flux ni outil jusqu'à la tâche 6) --------------------------------------

    async def _chat_round(self, client: AsyncOpenAI, request: dict[str, Any]) -> _Round:
        raw = await client.chat.completions.with_raw_response.create(**request)
        try:
            completion = raw.parse()
            content = completion.choices[0].message.content
        except (
            ValueError,  # JSON illisible
            TypeError,
            IndexError,
            AttributeError,
            openai.APIResponseValidationError,
        ):
            raise _Invalid from None
        usage = getattr(completion, "usage", None)
        return _Round(
            text=content if isinstance(content, str) else "",
            calls=[],
            tokens_in=_count(getattr(usage, "prompt_tokens", None)),
            tokens_out=_count(getattr(usage, "completion_tokens", None)),
            cost_usd_micros=self._cost(usage, raw.headers),
        )

    def _chat_request(self, model: str, system_prompt: str, messages: list[dict]) -> dict[str, Any]:
        extra_body = self._provider.extra_body_dict()
        request: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": self.final_system_prompt(system_prompt)},
                *messages,
            ],
            "temperature": TEMPERATURE,
            "max_tokens": MAX_TOKENS,
            "response_format": self._response_format(),
            "extra_body": extra_body or None,
        }
        for param in self._provider.omit_params:
            del request[param]
        return request


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
