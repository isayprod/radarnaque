"""Lecture d'un tour du modèle en flux, pour les deux API : événements typés de l'API Responses,
morceaux `chat.completion.chunk` de l'API Chat. Chaque lecteur relaie les résumés de réflexion et
le début de la réponse finale, puis rend le tour (texte, appels d'outils, tokens, coût, éléments
à recopier dans l'historique).

Seuls la lecture et le décodage du flux lèvent `InvalidResponse` ou `StreamFailed` : une erreur
du récepteur d'événements remonte telle quelle, jamais prise pour une réponse invalide. Ces deux
exceptions restent internes au client, qui lève `LLMError` hors de tout `except`."""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from openai import AsyncStream
from pydantic import BaseModel

from radarnaque_api.llm.events import EventSink, LLMEvent, Thinking, Writing

THINKING_MAX = 600  # caractères d'une partie de réflexion relayés à l'extension

# Coût d'un tour, en micro-dollars, d'après son usage (selon la source du fournisseur).
CostOf = Callable[[Any], int]


class InvalidResponse(Exception):
    """Réponse inexploitable : ligne illisible, réponse coupée, appel d'outil sans identifiant."""


class StreamFailed(Exception):
    """Flux coupé avant sa fin, ou erreur annoncée dans le flux."""


@dataclass(frozen=True)
class ToolCall:
    call_id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class Round:
    """Un tour du modèle, quelle que soit l'API : appels d'outils, ou texte de la réponse finale.
    `replay` : éléments de la réponse à recopier dans l'historique du tour suivant."""

    text: str
    calls: list[ToolCall]
    tokens_in: int
    tokens_out: int
    cost_usd_micros: int
    replay: list[dict[str, Any]] = field(default_factory=list)


class Reasoning:
    """Résumés de réflexion de toute l'analyse. Une partie (clé propre à l'API) reçoit un numéro
    à sa première apparition, à partir de 0, sans repartir à zéro d'un tour à l'autre."""

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


class RoundSink:
    """Récepteur des événements d'un tour : note si l'un d'eux est parti. Une coupure ne se
    reprend alors plus, l'extension ayant déjà affiché une partie du tour."""

    def __init__(self, on_event: EventSink | None) -> None:
        self._on_event = on_event
        self.emitted = False

    async def __call__(self, event: LLMEvent) -> None:
        self.emitted = True
        if self._on_event is not None:
            await self._on_event(event)


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _dump(item: Any) -> dict[str, Any] | None:
    """Élément reçu, recopié tel quel dans l'historique du tour suivant (None : ni modèle ni
    objet JSON)."""
    if isinstance(item, BaseModel):
        return item.model_dump(exclude_none=True)
    if isinstance(item, dict):
        return dict(item)
    return None


async def _next(stream: AsyncStream[Any]) -> Any | None:
    """Événement ou morceau suivant, None en fin de flux."""
    try:
        return await anext(stream)
    except StopAsyncIteration:
        return None
    except ValueError:  # ligne `data:` illisible
        raise InvalidResponse from None


# --- API Responses -------------------------------------------------------------------------------


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


def _is_call(item: Any) -> bool:
    return getattr(item, "type", None) == "function_call"


def _tool_call(item: Any) -> ToolCall:
    """Appel de fonction d'un élément `output` ; identifiant ou nom absent : réponse invalide."""
    call_id, name = getattr(item, "call_id", None), getattr(item, "name", None)
    if not isinstance(call_id, str) or not call_id or not isinstance(name, str):
        raise InvalidResponse
    return ToolCall(call_id=call_id, name=name, arguments=_str(getattr(item, "arguments", None)))


def _replayed(item: Any) -> dict[str, Any]:
    dumped = _dump(item)
    if dumped is None:
        raise InvalidResponse
    return dumped


async def read_responses_round(
    stream: AsyncStream[Any], sink: RoundSink, reasoning: Reasoning, cost_of: CostOf
) -> Round:
    """Un tour en flux de l'API Responses : relaie les résumés de réflexion (partie = élément de
    réflexion et index de résumé) et le début de la réponse finale, puis rend les éléments de
    `output` (ceux de `response.output_item.done`, ou à défaut ceux de `response.completed`)."""
    items: dict[int, Any] = {}
    deltas: list[str] = []
    completed: Any = None
    calling = writing = False
    try:
        while (event := await _next(stream)) is not None:
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
                raise StreamFailed
            elif kind == "response.incomplete":  # réponse coupée (limite de tokens)
                raise InvalidResponse
    finally:
        await stream.close()
    if completed is None:
        raise StreamFailed
    output = [items[index] for index in sorted(items)]
    if not output:
        output = list(getattr(completed, "output", None) or [])
    usage = getattr(completed, "usage", None)
    return Round(
        text=output_text(output) or "".join(deltas),
        calls=[_tool_call(item) for item in output if _is_call(item)],
        tokens_in=_count(getattr(usage, "input_tokens", None)),
        tokens_out=_count(getattr(usage, "output_tokens", None)),
        cost_usd_micros=cost_of(usage),
        replay=[_replayed(item) for item in output],
    )


# --- API Chat ------------------------------------------------------------------------------------


@dataclass
class _PartialCall:
    """Appel d'outil en cours de réception : identifiant et nom donnés une fois, arguments
    découpés sur plusieurs deltas."""

    id: str = ""
    name: str = ""
    arguments: str = ""


async def read_chat_round(
    stream: AsyncStream[Any], sink: RoundSink, reasoning: Reasoning, cost_of: CostOf
) -> Round:
    """Un tour en flux de l'API Chat. `delta.reasoning` (OpenRouter) ou `delta.reasoning_content`
    (Groq, Ollama…) donne la réflexion du tour, une partie par appel (une nouvelle tentative en
    ouvre une autre) ; le premier `delta.content` reçu avant tout appel d'outil donne `Writing`.
    Les deltas `tool_calls` sont recollés par `index`. Le tour rendu recopie dans l'historique
    le message `assistant`, avec ses `tool_calls` et les `reasoning_details` d'OpenRouter reçus,
    dans l'ordre et sans retouche (réflexion à rendre au modèle avec les appels d'outils)."""
    part = (object(), 0)
    calls: dict[int, _PartialCall] = {}
    details: list[dict[str, Any]] = []
    texts: list[str] = []
    usage: Any = None
    finish = ""
    writing = False
    try:
        while (chunk := await _next(stream)) is not None:
            # Morceau d'usage (`stream_options.include_usage`) : le dernier, sans choix.
            chunk_usage = getattr(chunk, "usage", None)
            if chunk_usage is not None:
                usage = chunk_usage
            choices = _list(getattr(chunk, "choices", None))
            if not choices:
                continue
            choice = choices[0]
            finish = _str(getattr(choice, "finish_reason", None)) or finish
            delta = getattr(choice, "delta", None)
            thought = _str(getattr(delta, "reasoning", None)) or _str(
                getattr(delta, "reasoning_content", None)
            )
            if thought:
                thinking = reasoning.add(part, thought)
                if thinking is not None:
                    await sink(thinking)
            for position, piece in enumerate(_list(getattr(delta, "tool_calls", None))):
                index = getattr(piece, "index", None)
                key = index if isinstance(index, int) else position
                call = calls.setdefault(key, _PartialCall())
                function = getattr(piece, "function", None)
                call.id = _str(getattr(piece, "id", None)) or call.id
                call.name = _str(getattr(function, "name", None)) or call.name
                call.arguments += _str(getattr(function, "arguments", None))
            for detail in _list(getattr(delta, "reasoning_details", None)):
                dumped = _dump(detail)
                if dumped is not None:
                    details.append(dumped)
            content = _str(getattr(delta, "content", None))
            if content:
                texts.append(content)
                if not calls and not writing:
                    writing = True
                    await sink(Writing())
    finally:
        await stream.close()
    if not finish or finish == "error":  # flux coupé avant la fin du choix
        raise StreamFailed
    if finish == "length":  # réponse coupée (limite de tokens)
        raise InvalidResponse
    tool_calls = [ToolCall(c.id, c.name, c.arguments) for _, c in sorted(calls.items())]
    if any(not call.call_id for call in tool_calls):
        raise InvalidResponse
    text = "".join(texts)
    message: dict[str, Any] = {"role": "assistant", "content": text or None}
    if tool_calls:
        message["tool_calls"] = [
            {
                "id": call.call_id,
                "type": "function",
                "function": {"name": call.name, "arguments": call.arguments},
            }
            for call in tool_calls
        ]
    if details:
        message["reasoning_details"] = details
    return Round(
        text=text,
        calls=tool_calls,
        tokens_in=_count(getattr(usage, "prompt_tokens", None)),
        tokens_out=_count(getattr(usage, "completion_tokens", None)),
        cost_usd_micros=cost_of(usage),
        replay=[message],
    )
