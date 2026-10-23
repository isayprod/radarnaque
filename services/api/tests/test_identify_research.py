import asyncio
import time

import httpx
import pytest

from radarnaque_api.identify import research
from radarnaque_api.identify.research import (
    Query,
    criteria_queries,
    price_query,
    reference_query,
    run_searches,
)
from radarnaque_api.llm.events import LLMEvent, PageRead, SearchDone, SearchStarted
from radarnaque_api.pages import PageText
from radarnaque_api.search import SearchHit, SearchUnavailable


class FakeBackend:
    def __init__(self, hits=None, delay=0.0, fail=()):
        self.hits = hits or {}
        self.delay = delay
        self.fail = fail
        self.queries: list[str] = []

    async def search(self, query, *, fresh=False):
        self.queries.append(query)
        await asyncio.sleep(self.delay)
        if query in self.fail:
            raise SearchUnavailable("x")
        return self.hits.get(query, [])


def hit(url):
    return SearchHit(title="t", url=url, snippet="s")


@pytest.fixture
def read(monkeypatch):
    calls: list[list[str]] = []

    async def fake(urls, *, http, resolve=None, total_timeout_s=12.0):
        calls.append(list(urls))
        return [PageText(u, "d", "t", "x") for u in urls if "bad" not in u]

    monkeypatch.setattr(research, "read_pages", fake)
    return calls


async def run(queries, backend, **kw):
    async with httpx.AsyncClient() as http:
        return await run_searches(
            queries,
            backend=backend,
            http_pages=http,
            max_pages=kw.pop("max_pages", 3),
            page_kinds=kw.pop("page_kinds", frozenset({"criteria"})),
            on_event=kw.pop("on_event", None),
            **kw,
        )


def test_criteria_queries_order_and_limit():
    qs = criteria_queries(["A", "B", "C"], ["bord", "x"], 5)
    assert [q.text for q in qs] == ["A vs B différence", "how to tell A from B", "A B bord"]
    assert all(q.kind == "criteria" for q in qs)
    assert [q.text for q in criteria_queries(["A", "B"], ["h"], 2)] == [
        "A vs B différence",
        "how to tell A from B",
    ]
    assert reference_query("A") == Query("A fiche technique", "reference")
    assert price_query("A") == Query("A prix occasion", "price")


async def test_queries_are_cleaned():
    backend = FakeBackend()
    await run([Query("Phone a@b.be vs B", "criteria")], backend)
    assert backend.queries and "a@b.be" not in backend.queries[0]


async def test_searches_run_in_parallel():
    backend = FakeBackend(delay=0.2)
    start = time.monotonic()
    await run([Query("a", "criteria"), Query("b", "price")], backend)
    assert time.monotonic() - start < 0.35


async def test_backend_none_or_failing_gives_empty_hits():
    q = Query("a", "criteria")
    assert (await run([q], None)).hits == {q: []}
    out = await run([q], FakeBackend(fail=("a",)))
    assert out.hits == {q: []} and out.pages == []


async def test_pages_skip_marketplace_domains_and_respect_max_pages(read):
    q = Query("a", "criteria")
    p = Query("p", "price")
    backend = FakeBackend(
        hits={
            "a": [
                hit("https://www.2ememain.be/x"),
                hit("https://m.facebook.com/y"),
                hit("https://one.com/1"),
                hit("https://two.com/2"),
                hit("https://one.com/1"),
                hit("https://three.com/3"),
            ],
            "p": [hit("https://price.com/4")],
        }
    )
    out = await run([q, p], backend, max_pages=2)
    assert read == [["https://one.com/1", "https://two.com/2"]]
    assert [pg.url for pg in out.pages] == read[0]
    assert out.records == [("a", "criteria", ["one.com", "two.com"])]


async def test_events_emitted_in_order(read):
    events: list[LLMEvent] = []

    async def sink(e):
        events.append(e)

    backend = FakeBackend(hits={"a": [hit("https://one.com/1"), hit("https://bad.com/2")]})
    await run([Query("a", "criteria")], backend, on_event=sink, first_id=4)
    assert events == [
        SearchStarted(4, "a", "model"),
        SearchDone(4, True, 2, ("one.com", "bad.com")),
        PageRead("one.com", True),
        PageRead("bad.com", False),
    ]
