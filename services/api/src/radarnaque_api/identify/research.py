"""Recherches web de l'identification : requêtes de distinction, de référence et de prix, puis
lecture de quelques pages. Les requêtes passent toutes par `clean_query` ; un moteur absent ou
en échec donne simplement aucun résultat."""

import asyncio
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlsplit

import httpx

from radarnaque_api.images import Resolver, default_resolve
from radarnaque_api.llm.events import EventSink, PageRead, SearchDone, SearchStarted
from radarnaque_api.pages import PageText, read_pages
from radarnaque_api.search import (
    SearchBackend,
    SearchHit,
    SearchUnavailable,
    clean_query,
    hit_domains,
)

EXCLUDED_DOMAINS = ("2ememain.be", "2dehands.be", "facebook.com")


@dataclass(frozen=True)
class Query:
    text: str
    kind: Literal["criteria", "price", "reference", "retry"]


@dataclass
class SearchOutcome:
    hits: dict[Query, list[SearchHit]] = field(default_factory=dict)
    pages: list[PageText] = field(default_factory=list)
    records: list[tuple[str, str, list[str]]] = field(
        default_factory=list
    )  # requête, kind, domaines lus


def criteria_queries(candidates: list[str], limit: int) -> list[Query]:
    """Requêtes de distinction entre les deux premiers candidats, tronquées à `limit`. Elles ne
    contiennent que des noms de produits : rien de l'annonce, pas même les indices de lecture."""
    if len(candidates) < 2:
        return []
    a, b = candidates[0], candidates[1]
    texts = [f"{a} vs {b} différence", f"how to tell {a} from {b}"]
    return [Query(t, "criteria") for t in texts[: max(limit, 0)]]


def reference_query(candidate: str) -> Query:
    return Query(f"{candidate} fiche technique", "reference")


def price_query(candidate: str) -> Query:
    return Query(f"{candidate} prix occasion", "price")


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").removeprefix("www.")
    except ValueError:
        return ""


def _excluded(host: str) -> bool:
    return any(host == d or host.endswith("." + d) for d in EXCLUDED_DOMAINS)


async def run_searches(
    queries: list[Query],
    *,
    backend: SearchBackend | None,
    http_pages: httpx.AsyncClient,
    max_pages: int,
    page_kinds: frozenset[str],
    on_event: EventSink | None,
    first_id: int = 1,
    resolve: Resolver = default_resolve,
) -> SearchOutcome:
    """Requêtes en parallèle, puis lecture des `max_pages` premières pages distinctes des
    requêtes dont le kind est dans `page_kinds` (hors sites d'annonces et réseaux sociaux)."""

    async def emit(event) -> None:
        if on_event is not None:
            await on_event(event)

    async def one(search_id: int, query: Query) -> list[SearchHit]:
        text = clean_query(query.text)
        aspect = "price" if query.kind == "price" else "model"
        await emit(SearchStarted(search_id, text, aspect))
        hits: list[SearchHit] = []
        ok = False
        if backend is not None and text:
            try:
                hits = await backend.search(text)
                ok = True
            except SearchUnavailable:
                hits = []
        await emit(SearchDone(search_id, ok, len(hits), hit_domains(hits)))
        return hits

    results = await asyncio.gather(*(one(first_id + i, q) for i, q in enumerate(queries)))
    outcome = SearchOutcome(hits=dict(zip(queries, results, strict=True)))

    urls: list[str] = []
    origin: dict[str, list[Query]] = {}
    for query, hits in outcome.hits.items():
        if query.kind not in page_kinds:
            continue
        for h in hits:
            if _excluded(_host(h.url)):
                continue
            origin.setdefault(h.url, []).append(query)
            if h.url not in urls:
                urls.append(h.url)
    urls = urls[: max(max_pages, 0)]
    if not urls:
        return outcome

    outcome.pages = await read_pages(urls, http=http_pages, resolve=resolve)
    read_urls = {p.url for p in outcome.pages}
    for url in urls:
        await emit(PageRead(_host(url), url in read_urls))
    for query in outcome.hits:
        domains = [_host(u) for u in urls if u in read_urls and query in origin[u]]
        if domains:
            outcome.records.append((clean_query(query.text), query.kind, domains))
    return outcome
