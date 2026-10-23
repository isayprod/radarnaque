"""Événements d'une analyse en cours, relayés en direct à l'extension : résumés de réflexion,
recherches web et début de la réponse finale. Aucun ne porte de donnée personnelle : la
requête d'une recherche est déjà masquée (`clean_query`)."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

Aspect = Literal["model", "price", "scam", "other"]


@dataclass(frozen=True)
class Thinking:
    """Résumé de réflexion : `part` numérotée à partir de 0 sur toute l'analyse (tous tours
    confondus), `text` cumulé depuis le début de la partie, 600 caractères au plus."""

    part: int
    text: str


@dataclass(frozen=True)
class SearchStarted:
    """Le modèle lance une recherche ; `id` à partir de 1, `query` déjà masquée."""

    id: int
    query: str
    aspect: Aspect


@dataclass(frozen=True)
class SearchDone:
    """Résultats renvoyés au modèle (`ok` faux, `count` nul : moteur indisponible)."""

    id: int
    ok: bool
    count: int
    domains: tuple[str, ...]


@dataclass(frozen=True)
class Writing:
    """Le modèle commence sa réponse finale."""


@dataclass(frozen=True)
class PageRead:
    """Une page web lue pour l'identification (`ok` faux : refusée ou en échec)."""

    domain: str
    ok: bool


@dataclass(frozen=True)
class CriteriaCached:
    """Critères de distinction déjà connus, repris de la base partagée."""

    count: int


LLMEvent = Thinking | SearchStarted | SearchDone | Writing | PageRead | CriteriaCached
EventSink = Callable[[LLMEvent], Awaitable[None]]
