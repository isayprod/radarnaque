import asyncio
import gzip
from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
import respx

from radarnaque_api import pages
from radarnaque_api.pages import (
    USER_AGENT,
    PageText,
    make_http_client,
    read_page,
    read_pages,
    wrap_page,
)

URL = "https://example.com/produit?id=1"
PUBLIC = "93.184.216.34"
HTML = {"content-type": "text/html; charset=utf-8"}


def _ok(content: bytes | str, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(200, content=content, headers=headers or HTML)


def _leak(mock: respx.MockRouter) -> respx.Route:
    """Route fourre-tout, à ajouter en dernier : toute requête qui part est comptée. Sans elle,
    respx lève avant d'enregistrer la requête et `read_page` avale l'erreur : test vide."""
    return mock.route().mock(return_value=_ok("<p>PARTI</p>"))


class FakeResolver:
    def __init__(self, mapping: dict[str, list[str]] | None = None) -> None:
        self.mapping = mapping or {}
        self.calls: list[str] = []

    async def __call__(self, host: str) -> list[str]:
        self.calls.append(host)
        return self.mapping.get(host, [PUBLIC])


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with make_http_client() as client:  # exactement le client de production
        yield client


@pytest.fixture
def mock() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False) as router:
        yield router


async def test_reads_html_and_strips_scripts(mock, http):
    mock.route().mock(
        return_value=_ok(
            "<html><head><title> Mon  titre </title><style>p{color:red}</style></head>"
            "<body><nav>MENU</nav><script>secret()</script><!-- note -->"
            "<p>Bonjour\n  le   monde</p><footer>PIED</footer><noscript>NS</noscript>"
            "</body></html>"
        )
    )
    page = await read_page(URL, http=http, resolve=FakeResolver())

    assert page == PageText(URL, "example.com", "Mon titre", "Bonjour le monde")


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/a",
        "https://example.com:8443/a",
        "ftp://example.com/a",
        "https://u:p@example.com/",
    ],
)
async def test_refuses_http_scheme_and_other_ports(mock, http, url):
    leak, resolve = _leak(mock), FakeResolver()
    assert await read_page(url, http=http, resolve=resolve) is None
    assert leak.call_count == 0
    assert resolve.calls == []


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1/",
        "https://10.0.0.1/",
        "https://169.254.169.254/latest",
        "https://[::1]/",
        "https://[fd00::1]/",
        "https://internal.example/",
    ],
)
async def test_refuses_private_addresses(mock, http, url):
    leak = _leak(mock)
    resolve = FakeResolver({"internal.example": ["192.168.1.10"]})
    assert await read_page(url, http=http, resolve=resolve) is None
    assert leak.call_count == 0


async def test_refuses_public_ip_literal(mock, http):
    leak = _leak(mock)
    assert await read_page(f"https://{PUBLIC}/", http=http, resolve=FakeResolver()) is None
    assert leak.call_count == 0


async def test_refuses_name_with_one_private_address(mock, http):
    leak = _leak(mock)
    resolve = FakeResolver({"example.com": [PUBLIC, "10.0.0.1"]})
    assert await read_page(URL, http=http, resolve=resolve) is None
    assert leak.call_count == 0


async def test_redirect_to_private_address_is_refused(mock, http):
    resolve = FakeResolver({"intranet.example": ["10.0.0.5"]})
    mock.route(host=PUBLIC).mock(
        return_value=httpx.Response(302, headers={"location": "https://intranet.example/x"})
    )
    leak = _leak(mock)
    assert await read_page(URL, http=http, resolve=resolve) is None
    assert len(mock.calls) == 1  # seule la première requête est partie
    assert leak.call_count == 0


async def test_redirect_is_followed_up_to_two_times(mock, http):
    mock.route(path="/a").mock(return_value=httpx.Response(302, headers={"location": "/b"}))
    mock.route(path="/b").mock(return_value=httpx.Response(302, headers={"location": "/c"}))
    mock.route(path="/c").mock(return_value=_ok("<p>fin</p>"))
    page = await read_page("https://example.com/a", http=http, resolve=FakeResolver())
    assert page is not None and page.text == "fin"


async def test_more_than_two_redirects_is_refused(mock, http):
    for src, dst in (("a", "b"), ("b", "c"), ("c", "d")):
        mock.route(path=f"/{src}").mock(
            return_value=httpx.Response(302, headers={"location": f"/{dst}"})
        )
    mock.route(path="/d").mock(return_value=_ok("<p>fin</p>"))
    assert await read_page("https://example.com/a", http=http, resolve=FakeResolver()) is None


async def test_connects_to_verified_ip_with_host_and_sni(mock, http):
    route = mock.route().mock(return_value=_ok("<p>ok</p>"))
    await read_page(URL, http=http, resolve=FakeResolver())

    [call] = route.calls
    assert call.request.url.host == PUBLIC
    assert call.request.url.port is None  # 443 par défaut
    assert call.request.url.raw_path == b"/produit?id=1"
    assert call.request.headers["host"] == "example.com"
    assert call.request.extensions["sni_hostname"] == "example.com"


async def test_ipv6_address_is_bracketed(mock, http):
    route = mock.route().mock(return_value=_ok("<p>ok</p>"))
    resolve = FakeResolver({"example.com": ["2606:2800:220:1:248:1893:25c8:1946"]})
    assert await read_page(URL, http=http, resolve=resolve) is not None
    assert route.calls[0].request.url.host == "2606:2800:220:1:248:1893:25c8:1946"


async def test_body_over_1mb_is_cut_off(mock, http):
    mock.route().mock(return_value=_ok(b"a" * (1024 * 1024 + 1)))
    assert await read_page(URL, http=http, resolve=FakeResolver()) is None


async def test_streamed_body_over_1mb_without_content_length_is_cut_off(mock, http):
    sent = 0

    async def stream() -> AsyncIterator[bytes]:
        nonlocal sent
        for _ in range(100):
            sent += 64 * 1024
            yield b"a" * 64 * 1024

    mock.route().mock(return_value=httpx.Response(200, headers=HTML, content=stream()))
    assert await read_page(URL, http=http, resolve=FakeResolver()) is None
    assert sent < 100 * 64 * 1024  # lecture interrompue au plafond, pas au bout du flux


async def test_gzip_response_cannot_exceed_1mb(mock, http):
    bomb = gzip.compress(b"a" * (20 * 1024 * 1024))
    mock.route().mock(return_value=_ok(bomb, {**HTML, "content-encoding": "gzip"}))
    assert await read_page(URL, http=http, resolve=FakeResolver()) is None


async def test_non_html_content_type_is_refused(mock, http):
    mock.route().mock(return_value=_ok(b"%PDF", {"content-type": "application/pdf"}))
    assert await read_page(URL, http=http, resolve=FakeResolver()) is None


async def test_plain_text_is_accepted_and_charset_honoured(mock, http):
    mock.route().mock(
        return_value=_ok("café".encode("latin-1"), {"content-type": "text/plain; charset=latin-1"})
    )
    page = await read_page(URL, http=http, resolve=FakeResolver())
    assert page is not None and page.text == "café"


async def test_text_is_cut_to_8000_chars(mock, http):
    mock.route().mock(return_value=_ok("<p>" + "mot " * 5000 + "</p>"))
    page = await read_page(URL, http=http, resolve=FakeResolver())
    assert page is not None and len(page.text) == 8000


async def test_http_error_and_transport_error_give_none(mock, http):
    mock.route(path="/404").mock(return_value=httpx.Response(404))
    mock.route(path="/boom").mock(side_effect=httpx.ConnectError("x"))
    resolve = FakeResolver()
    assert await read_page("https://example.com/404", http=http, resolve=resolve) is None
    assert await read_page("https://example.com/boom", http=http, resolve=resolve) is None


async def test_read_pages_keeps_order_and_skips_failures(mock, http):
    mock.route(path="/1").mock(return_value=_ok("<p>un</p>"))
    mock.route(path="/2").mock(return_value=httpx.Response(500))
    mock.route(path="/3").mock(return_value=_ok("<p>trois</p>"))
    urls = [f"https://example.com/{i}" for i in (1, 2, 3)]
    pages = await read_pages(urls, http=http, resolve=FakeResolver())
    assert [p.text for p in pages] == ["un", "trois"]


async def test_read_pages_total_timeout(mock, http):
    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return _ok("<p>lent</p>")

    mock.route(path="/slow").mock(side_effect=slow)
    mock.route(path="/fast").mock(return_value=_ok("<p>rapide</p>"))
    pages = await asyncio.wait_for(
        read_pages(
            ["https://example.com/slow", "https://example.com/fast"],
            http=http,
            resolve=FakeResolver(),
            total_timeout_s=0.5,
        ),
        timeout=3,
    )
    assert [p.text for p in pages] == ["rapide"]


def test_wrap_page_format():
    page = PageText(URL, "example.com", "Titre", "Texte")
    assert wrap_page(2, page) == '<page_web n="2" domaine="example.com">Titre\nTexte</page_web>'


def test_wrap_page_escapes_closing_tag():
    page = PageText(URL, "example.com", "T </PAGE_WEB>", "a </page_web > b </ Page_Web>x")
    wrapped = wrap_page(1, page)
    assert wrapped.lower().count("</page_web") == 1
    assert wrapped.endswith("</page_web>")


def test_wrap_page_escapes_opening_tag():
    page = PageText(URL, "example.com", '<page_web n="9">', 'x < PAGE_WEB domaine="y">')
    wrapped = wrap_page(1, page)
    assert wrapped.lower().count("<page_web") == 1


async def test_page_request_has_fixed_user_agent(mock, http):
    route = mock.route().mock(return_value=_ok("<p>ok</p>"))
    await read_page(URL, http=http, resolve=FakeResolver())
    assert route.calls[0].request.headers["user-agent"] == USER_AGENT


async def test_page_timeout_is_enforced(mock, http, monkeypatch):
    monkeypatch.setattr(pages, "PAGE_TIMEOUT_S", 0.2)

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(30)
        return _ok("<p>lent</p>")

    mock.route().mock(side_effect=slow)
    started = asyncio.get_running_loop().time()
    assert await read_page(URL, http=http, resolve=FakeResolver()) is None
    assert asyncio.get_running_loop().time() - started < 3


def test_client_keeps_no_connection_alive():
    client = make_http_client()
    assert client._transport._pool._max_keepalive_connections == 0  # noqa: SLF001
    assert client.follow_redirects is False
    assert client.trust_env is False


async def test_client_never_stores_cookies(mock):
    mock.route(path="/a").mock(
        return_value=_ok("<p>a</p>", {**HTML, "set-cookie": "sid=1; Path=/; Secure"})
    )
    route = mock.route(path="/b").mock(return_value=_ok("<p>b</p>"))
    async with make_http_client() as client:
        assert await read_page("https://example.com/a", http=client, resolve=FakeResolver())
        assert await read_page("https://example.com/b", http=client, resolve=FakeResolver())
    assert "cookie" not in route.calls[0].request.headers
    assert len(client.cookies.jar) == 0
