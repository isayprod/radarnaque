"""Recherche web de l'outil `web_search` : un moteur SearXNG auto-hébergé, derrière une interface
minimale (`SearchBackend`) pour qu'un autre moteur puisse s'ajouter sans toucher au reste."""

import math
import re
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit

import httpx

from radarnaque_api.config import Settings
from radarnaque_api.llm.payload import mask_contacts

LANGUAGE = "fr-BE"
SEARCH_TIMEOUT_SECONDS = 8.0
MAX_HITS = 5
TITLE_MAX = 120
SNIPPET_MAX = 300
QUERY_MAX = 200
OUTPUT_MAX = 2500
CACHE_TTL_SECONDS = 24 * 3600
CACHE_MAX_ENTRIES = 1000
DOMAIN_MAX = 100
URL_MAX = 300

_OPEN_TAG = "<resultats_recherche>"
_CLOSE_TAG = "</resultats_recherche>"
_SPACES_RE = re.compile(r"\s+")
# Espace ou caractère de contrôle (dont DEL) dans une URL : le résultat est écarté.
_BAD_URL_CHARS_RE = re.compile(r"[\s\x00-\x1f\x7f]")
# Fin de texte coupée au milieu d'une entité (`&l`, `&gt`) : retirée après une troncature.
_PARTIAL_ENTITY_RE = re.compile(r"&[a-z]*$")


@dataclass(frozen=True)
class SearchHit:
    title: str
    url: str
    snippet: str


class SearchUnavailable(Exception):
    """Le moteur ne répond pas (délai dépassé, erreur HTTP, réponse illisible)."""


class SearchBackend(Protocol):
    async def search(self, query: str) -> list[SearchHit]:  # lève SearchUnavailable
        ...


def clean_query(raw: str) -> str:
    """Requête prête à sortir : emails et téléphones masqués (le modèle peut les recopier de la
    description), espaces réduits, 200 caractères au plus. Chaîne vide si rien ne reste."""
    return _SPACES_RE.sub(" ", mask_contacts(raw)).strip()[:QUERY_MAX].strip()


def _cache_key(query: str) -> tuple[str, str]:
    return query.casefold(), LANGUAGE


def _score(result: dict) -> float:
    """Score SearXNG, ou 0 s'il est absent, non numérique, infini, NaN ou hors des flottants."""
    score = result.get("score")
    if not isinstance(score, int | float) or isinstance(score, bool):
        return 0.0
    try:
        value = float(score)
    except OverflowError:  # entier JSON géant
        return 0.0
    return value if math.isfinite(value) else 0.0


def _text(value: object, limit: int) -> str:
    return _SPACES_RE.sub(" ", value).strip()[:limit] if isinstance(value, str) else ""


def _valid_url(url: object) -> bool:
    """URL http(s) d'au plus 300 caractères, sans espace ni caractère de contrôle, qui se
    découpe (`http://[::1` lève ValueError). Les résultats viennent du web : rien n'est supposé."""
    if not isinstance(url, str) or len(url) > URL_MAX or _BAD_URL_CHARS_RE.search(url):
        return False
    try:
        return urlsplit(url).scheme in ("http", "https")
    except ValueError:
        return False


def _parse_hits(body: object) -> list[SearchHit]:
    results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(results, list):
        raise SearchUnavailable("réponse SearXNG sans liste de résultats")
    valid = [r for r in results if isinstance(r, dict) and _valid_url(r.get("url"))]
    valid.sort(key=_score, reverse=True)  # tri stable : à score égal, l'ordre du moteur
    return [
        SearchHit(
            title=_text(r.get("title"), TITLE_MAX),
            url=r["url"],
            snippet=_text(r.get("content"), SNIPPET_MAX),
        )
        for r in valid[:MAX_HITS]
    ]


class SearxngBackend:
    """SearXNG via `GET /search?format=json`. Cache en mémoire de l'API : 24 h, 1 000 requêtes
    au plus, clé = requête normalisée (minuscules, espaces réduits) et langue. Un échec n'est
    jamais mis en cache, ni une réponse sans résultat exploitable."""

    def __init__(
        self,
        base_url: str,
        http: httpx.AsyncClient,
        *,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._url = base_url.rstrip("/") + "/search"
        self._http = http
        self._now = now
        self._cache: OrderedDict[tuple[str, str], tuple[float, list[SearchHit]]] = OrderedDict()

    async def search(self, query: str) -> list[SearchHit]:
        # Masquage ici aussi (idempotent) : rien ne part vers SearXNG sans passer par clean_query.
        query = clean_query(query)
        if not query:
            return []
        key = _cache_key(query)
        cached = self._cache.get(key)
        if cached is not None and self._now() - cached[0] < CACHE_TTL_SECONDS:
            return list(cached[1])
        hits = await self._fetch(query)
        self._cache.pop(key, None)  # une entrée périmée repasse en dernière position
        if not hits:
            # Pas de cache : SearXNG répond 200 avec `results: []` quand ses moteurs amont sont
            # bloqués, et cette panne passagère ne doit pas durer 24 h.
            return []
        self._cache[key] = (self._now(), hits)
        while len(self._cache) > CACHE_MAX_ENTRIES:
            self._cache.popitem(last=False)
        return list(hits)

    async def _fetch(self, query: str) -> list[SearchHit]:
        try:
            response = await self._http.get(
                self._url,
                params={"q": query, "format": "json", "language": LANGUAGE},
                timeout=SEARCH_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            # Message sans la requête ni l'URL : rien d'autre que le type d'erreur dans les logs.
            raise SearchUnavailable(type(exc).__name__) from exc
        try:
            return _parse_hits(body)
        except SearchUnavailable:
            raise
        except Exception as exc:  # dernier filet : le web ne doit pas faire échouer l'analyse
            raise SearchUnavailable(type(exc).__name__) from exc


def _escape(text: str) -> str:
    return text.replace("<", "&lt;").replace(">", "&gt;")


def format_hits(hits: list[SearchHit]) -> str:
    """Bloc `<resultats_recherche>` rendu au modèle : résultats numérotés, `<` et `>` échappés (un
    résultat ne peut pas fermer le bloc), 2 500 caractères au plus au total. Ce sont des données
    non fiables : le prompt interdit d'obéir à ce qu'elles contiennent."""
    room = OUTPUT_MAX - len(_OPEN_TAG) - len(_CLOSE_TAG) - 2  # deux sauts de ligne
    lines: list[str] = []
    for i, hit in enumerate(hits, start=1):
        entry = f"{i}. {_escape(hit.title)} ({_escape(hit.url)})"
        if hit.snippet:
            entry += f"\n   {_escape(hit.snippet)}"
        if len(entry) + 1 > room and lines:
            break
        entry = _PARTIAL_ENTITY_RE.sub("", entry[: max(room - 1, 0)])
        lines.append(entry)
        room -= len(entry) + 1
    body = "\n".join(lines) if lines else "Aucun résultat."
    return f"{_OPEN_TAG}\n{body}\n{_CLOSE_TAG}"


def hit_domains(hits: list[SearchHit], limit: int = 3) -> tuple[str, ...]:
    """Domaines des résultats (sans « www. », sans doublon, dans l'ordre), pour l'affichage."""
    domains: list[str] = []
    for hit in hits:
        host = (urlsplit(hit.url).hostname or "").removeprefix("www.")[:DOMAIN_MAX]
        if host and host not in domains:
            domains.append(host)
        if len(domains) == limit:
            break
    return tuple(domains)


def make_search_backend(settings: Settings, http: httpx.AsyncClient) -> SearchBackend | None:
    """Le moteur choisi par `SEARCH_BACKEND`, ou None (l'outil n'est alors pas proposé)."""
    if settings.search_backend == "none":
        return None
    return SearxngBackend(settings.searxng_url, http)
