import httpx
import pytest

from radarnaque_api.config import Settings
from radarnaque_api.search import (
    SearchHit,
    SearchUnavailable,
    SearxngBackend,
    clean_query,
    format_hits,
    hit_domains,
    make_search_backend,
)

BASE = "http://searxng.test"
DAY = 24 * 3600


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _results(n: int) -> dict:
    return {
        "results": [
            {
                "title": f"Titre {i}",
                "url": f"https://site{i}.example/page",
                "content": f"Extrait {i}",
                "score": float(i),
            }
            for i in range(n)
        ]
    }


def _backend(handler, clock: Clock | None = None) -> SearxngBackend:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return SearxngBackend(BASE, http, now=clock or Clock())


async def test_searxng_request():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_results(1))

    hits = await _backend(handler).search("iPhone 13 prix")
    assert len(hits) == 1
    request = seen[0]
    assert request.method == "GET"
    assert request.url.path == "/search"
    assert request.url.params["q"] == "iPhone 13 prix"
    assert request.url.params["format"] == "json"
    assert request.url.params["language"] == "fr-BE"
    assert request.extensions["timeout"]["read"] == 8.0
    assert request.extensions["timeout"]["connect"] == 8.0


async def test_top_five_sorted_and_truncated():
    payload = _results(8)
    payload["results"][2]["title"] = "T" * 300
    payload["results"][2]["content"] = "C" * 900
    payload["results"][2]["score"] = 99.0

    hits = await _backend(lambda r: httpx.Response(200, json=payload)).search("x")
    assert [h.url for h in hits] == [
        "https://site2.example/page",
        "https://site7.example/page",
        "https://site6.example/page",
        "https://site5.example/page",
        "https://site4.example/page",
    ]
    assert len(hits[0].title) == 120
    assert len(hits[0].snippet) == 300


async def test_results_without_valid_url_are_skipped():
    payload = {
        "results": [
            {"title": "sans url", "content": "x", "score": 9},
            {"title": "script", "url": "javascript:alert(1)", "score": 8},
            {"title": "ok", "url": "https://ok.example/", "score": 1},
        ]
    }
    hits = await _backend(lambda r: httpx.Response(200, json=payload)).search("x")
    assert [h.title for h in hits] == ["ok"]


async def test_malformed_url_is_skipped_not_fatal():
    payload = {
        "results": [
            {"title": "ipv6 cassée", "url": "http://[::1", "score": 9},
            {"title": "ok", "url": "https://ok.example/", "score": 1},
        ]
    }
    hits = await _backend(lambda r: httpx.Response(200, json=payload)).search("x")
    assert [h.title for h in hits] == ["ok"]


async def test_weird_scores_do_not_break_sorting():
    # json.loads accepte NaN et les entiers géants ; 1e400 devient inf.
    body = (
        b'{"results": ['
        b'{"title": "nan", "url": "https://a.example/", "score": NaN},'
        b'{"title": "inf", "url": "https://b.example/", "score": 1e400},'
        b'{"title": "geant", "url": "https://c.example/", "score": 1' + b"0" * 400 + b"},"
        b'{"title": "texte", "url": "https://d.example/", "score": "haut"},'
        b'{"title": "bon", "url": "https://e.example/", "score": 5}'
        b"]}"
    )
    hits = await _backend(lambda r: httpx.Response(200, content=body)).search("x")
    assert hits[0].title == "bon"  # les autres valent 0, dans l'ordre du moteur
    assert [h.title for h in hits[1:]] == ["nan", "inf", "geant", "texte"]


@pytest.mark.parametrize(
    "url",
    [
        "https://a.example/avec espace",
        "https://a.example/tab\there",
        "https://a.example/nul\x00",
        "https://a.example/del\x7f",
        "https://a.example/" + "x" * 300,
    ],
)
async def test_bad_urls_are_skipped(url):
    payload = {
        "results": [
            {"title": "mauvaise", "url": url, "score": 9},
            {"title": "ok", "url": "https://ok.example/" + "y" * 100, "score": 1},
        ]
    }
    hits = await _backend(lambda r: httpx.Response(200, json=payload)).search("x")
    assert [h.title for h in hits] == ["ok"]


async def test_url_of_exactly_300_characters_is_kept():
    url = "https://a.example/" + "x" * (300 - len("https://a.example/"))
    payload = {"results": [{"title": "limite", "url": url}]}
    hits = await _backend(lambda r: httpx.Response(200, json=payload)).search("x")
    assert [h.url for h in hits] == [url]


async def test_empty_results_are_not_cached():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"results": []})

    backend = _backend(handler)
    assert await backend.search("x") == []
    assert await backend.search("x") == []
    assert calls == 2


async def test_unexpected_parsing_error_becomes_unavailable(monkeypatch):
    import radarnaque_api.search as search

    def boom(body):
        raise RuntimeError("imprévu")

    monkeypatch.setattr(search, "_parse_hits", boom)
    with pytest.raises(SearchUnavailable):
        await _backend(lambda r: httpx.Response(200, json=_results(1))).search("x")


async def test_cache_hit_no_second_request():
    calls = 0
    clock = Clock()

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=_results(1))

    backend = _backend(handler, clock)
    first = await backend.search("iPhone  13")
    clock.t += DAY - 1
    second = await backend.search("  iphone 13 ")
    assert calls == 1
    assert second == first
    clock.t += 2
    await backend.search("iphone 13")
    assert calls == 2


async def test_cache_bounded_1000():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.params["q"])
        return httpx.Response(200, json=_results(1))

    backend = _backend(handler)
    for i in range(1001):
        await backend.search(f"requete {i}")
    assert len(calls) == 1001
    await backend.search("requete 1000")  # la plus récente reste en cache
    assert len(calls) == 1001
    await backend.search("requete 0")  # la plus ancienne a été évincée
    assert len(calls) == 1002


async def test_failures_are_not_cached():
    answers = [httpx.Response(500), httpx.Response(200, json=_results(1))]

    def handler(request: httpx.Request) -> httpx.Response:
        return answers.pop(0)

    backend = _backend(handler)
    with pytest.raises(SearchUnavailable):
        await backend.search("x")
    assert len(await backend.search("x")) == 1


@pytest.mark.parametrize("failure", ["timeout", "http_500", "bad_json", "not_an_object"])
async def test_unavailable_on_timeout_http_error_bad_json(failure):
    def handler(request: httpx.Request) -> httpx.Response:
        if failure == "timeout":
            raise httpx.ReadTimeout("trop lent", request=request)
        if failure == "http_500":
            return httpx.Response(500, text="boom")
        if failure == "bad_json":
            return httpx.Response(200, content=b"<html>pas du json")
        return httpx.Response(200, json=["liste"])

    with pytest.raises(SearchUnavailable):
        await _backend(handler).search("x")


async def test_query_is_masked_before_reaching_searxng():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json=_results(1))

    await _backend(handler).search("iphone 0471 12 34 56 jean@exemple.be")
    assert "0471" not in seen[0]
    assert "exemple" not in seen[0]


async def test_empty_query_makes_no_request():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("aucune requête attendue")

    assert await _backend(handler).search("   ") == []


def test_clean_query_masks_contacts():
    cleaned = clean_query("iphone 0471 12 34 56 jean@exemple.be")
    assert "0471" not in cleaned
    assert "@" not in cleaned
    assert cleaned.startswith("iphone")


def test_clean_query_collapses_spaces_and_bounds_length():
    assert clean_query("  a \n\t b   c ") == "a b c"
    assert clean_query("   ") == ""
    assert len(clean_query("mot " * 200)) <= 200


def test_format_hits_bounded():
    hits = [
        SearchHit(title=f"<b>Titre {i}</b>", url=f"https://s{i}.example/", snippet="<x>" * 100)
        for i in range(5)
    ]
    out = format_hits(hits)
    assert out.startswith("<resultats_recherche>")
    assert out.endswith("</resultats_recherche>")
    assert len(out) <= 2500
    inner = out[len("<resultats_recherche>") : -len("</resultats_recherche>")]
    assert "<" not in inner
    assert ">" not in inner
    assert "1." in inner


def test_format_hits_bounded_with_huge_single_hit():
    out = format_hits([SearchHit(title="<" * 5000, url="https://a.example/", snippet=">" * 5000)])
    assert len(out) <= 2500
    assert out.endswith("</resultats_recherche>")


def test_format_hits_empty():
    out = format_hits([])
    assert out.startswith("<resultats_recherche>")
    assert out.endswith("</resultats_recherche>")


def test_hit_domains():
    hits = [
        SearchHit("a", "https://www.apple.com/x", ""),
        SearchHit("b", "https://apple.com/y", ""),
        SearchHit("c", "https://Support.Apple.com/z", ""),
        SearchHit("d", "https://www.test.be/", ""),
        SearchHit("e", "https://autre.example/", ""),
    ]
    assert hit_domains(hits) == ("apple.com", "support.apple.com", "test.be")
    assert hit_domains(hits, limit=1) == ("apple.com",)


def _settings(**extra) -> Settings:
    return Settings(
        database_url="postgres://u:p@h:5432/d",
        jwks_url="http://j",
        jwt_issuer="i",
        jwt_audience="a",
        internal_api_secret="s" * 32,  # type: ignore[arg-type]
        **extra,
    )


async def test_make_search_backend():
    async with httpx.AsyncClient() as http:
        assert make_search_backend(_settings(search_backend="none"), http) is None
        backend = make_search_backend(
            _settings(search_backend="searxng", searxng_url="http://s:8080"), http
        )
        assert isinstance(backend, SearxngBackend)


def test_search_settings_defaults(monkeypatch):
    monkeypatch.delenv("SEARCH_BACKEND", raising=False)
    monkeypatch.delenv("SEARXNG_URL", raising=False)
    s = _settings()
    assert s.search_backend == "searxng"
    assert s.searxng_url == "http://127.0.0.1:8888"


async def test_app_state_search_follows_settings(app, settings):
    from radarnaque_api.main import create_app

    assert app.state.search is None  # SEARCH_BACKEND=none dans les tests
    assert app.state.http_search is None

    on = create_app(Settings.model_validate({**settings.model_dump(), "search_backend": "searxng"}))
    async with on.router.lifespan_context(on):
        assert isinstance(on.state.search, SearxngBackend)
        assert on.state.http_search.trust_env is False
    assert on.state.http_search.is_closed
