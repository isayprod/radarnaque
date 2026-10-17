import asyncio
import base64
import gzip
import io
import socket
import struct
import warnings
import zlib
from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
import respx
from PIL import Image
from PIL.PngImagePlugin import PngImageFile

from radarnaque_api import images
from radarnaque_api.images import ImageFetchError, default_resolve, fetch_images

SUFFIXES = ["images.2dehands.com", "fbcdn.net"]
URL = "https://images.2dehands.com/api/a.jpg"
PUBLIC = "93.184.216.34"


class FakeResolver:
    """Résolution simulée : aucune requête DNS, et chaque hôte demandé est noté."""

    def __init__(self, mapping: dict[str, list[str]] | None = None) -> None:
        self.mapping = mapping or {}
        self.calls: list[str] = []

    async def __call__(self, host: str) -> list[str]:
        self.calls.append(host)
        return self.mapping.get(host, [PUBLIC])


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    # `follow_redirects=True` : le module doit désactiver lui-même le suivi automatique.
    async with httpx.AsyncClient(follow_redirects=True) as client:
        yield client


@pytest.fixture
def mock() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False) as router:
        yield router


def _image_bytes(width: int, height: int, mode: str = "RGB", fmt: str = "PNG", **save) -> bytes:
    out = io.BytesIO()
    Image.new(mode, (width, height), "red").save(out, fmt, **save)
    return out.getvalue()


PNG = _image_bytes(40, 20)


def _png_header_only(width: int, height: int) -> bytes:
    """PNG minuscule qui déclare des dimensions énormes (bombe de décompression)."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(b""))
        + chunk(b"IEND", b"")
    )


def _decode(encoded: str) -> Image.Image:
    image = Image.open(io.BytesIO(base64.b64decode(encoded, validate=True)))
    image.load()
    return image


async def _reason(urls: list[str], http: httpx.AsyncClient, resolve=None, **kwargs) -> str:
    with pytest.raises(ImageFetchError) as caught:
        await fetch_images(urls, SUFFIXES, http=http, resolve=resolve or FakeResolver(), **kwargs)
    return caught.value.reason


# --- Hôtes et URL -------------------------------------------------------------------------


async def test_host_outside_list_is_refused_without_resolution_or_request(mock, http):
    resolve = FakeResolver()
    reason = await _reason(["https://evil.example/a.jpg"], http, resolve)

    assert reason == "host_not_allowed"
    assert resolve.calls == []
    assert len(mock.calls) == 0


@pytest.mark.parametrize(
    "host",
    # un seul point final est retiré : « fbcdn.net.. » reste refusé
    ["evil-fbcdn.net", "fbcdn.net.evil.com", "notfbcdn.net", "fbcdn.net..", "2dehands.com"],
)
async def test_lookalike_hosts_are_refused(mock, http, host):
    assert await _reason([f"https://{host}/a.jpg"], http) == "host_not_allowed"
    assert len(mock.calls) == 0


@pytest.mark.parametrize(
    "url",
    [
        "https://fbcdn.net/a.jpg",
        "https://scontent-bru2-1.xx.fbcdn.net/a.jpg",
        "https://SCONTENT.FBCDN.NET./a.jpg",
        "https://images.2dehands.com:443/a.jpg",
        "http://images.2dehands.com:80/a.jpg",
        "http://images.2dehands.com:443/a.jpg",
    ],
)
async def test_allowed_hosts_and_ports_are_fetched(mock, http, url):
    route = mock.get(url).mock(return_value=httpx.Response(200, content=PNG))
    resolve = FakeResolver()

    result = await fetch_images([url], SUFFIXES, http=http, resolve=resolve)

    assert len(result) == 1
    assert route.call_count == 1
    assert resolve.calls == [httpx.URL(url).host.removesuffix(".")]


async def test_suffix_with_leading_dot_behaves_like_bare_suffix(mock, http):
    url = "https://scontent.fbcdn.net/a.jpg"
    mock.get(url).mock(return_value=httpx.Response(200, content=PNG))
    mock.get("https://fbcdn.net/a.jpg").mock(return_value=httpx.Response(200, content=PNG))

    result = await fetch_images(
        [url, "https://fbcdn.net/a.jpg"], [".FBCDN.NET."], http=http, resolve=FakeResolver()
    )
    assert len(result) == 2
    with pytest.raises(ImageFetchError) as caught:
        await fetch_images(
            ["https://evil-fbcdn.net/a.jpg"], [".fbcdn.net"], http=http, resolve=FakeResolver()
        )
    assert caught.value.reason == "host_not_allowed"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://images.2dehands.com/a.jpg",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://user:pass@images.2dehands.com/a.jpg",
        "https://user@images.2dehands.com/a.jpg",
        "https://images.2dehands.com\\@evil.example/a.jpg",
        "https://images.2dehands.com:8443/a.jpg",
        "http://images.2dehands.com:8080/a.jpg",
        "https:///a.jpg",
        "pas une url",
    ],
)
async def test_bad_scheme_userinfo_port_or_url_are_refused(mock, http, url):
    resolve = FakeResolver()
    assert await _reason([url], http, resolve) == "host_not_allowed"
    assert resolve.calls == []
    assert len(mock.calls) == 0


# --- Adresses résolues --------------------------------------------------------------------


@pytest.mark.parametrize(
    "addresses",
    [
        ["10.0.0.5"],
        ["127.0.0.1"],
        ["169.254.169.254"],
        ["192.168.1.1"],
        ["100.100.100.200"],  # partagé (100.64.0.0/10), métadonnées de certains clouds
        ["0.0.0.0"],
        ["::"],
        ["::1"],
        ["fe80::1"],
        ["fc00::1"],
        ["fec0::1"],  # site-local (obsolète)
        ["64:ff9b::7f00:1"],  # NAT64 vers 127.0.0.1 : refusé par `is_reserved`
        ["2002:7f00:1::"],  # 6to4 vers 127.0.0.1
        ["224.0.0.1"],
        ["::ffff:127.0.0.1"],
        ["::ffff:10.0.0.1"],
        ["::ffff:169.254.169.254"],
        [PUBLIC, "10.0.0.5"],  # toutes les adresses doivent être publiques
        ["pas-une-adresse"],
    ],
)
async def test_private_resolution_is_refused_without_request(mock, http, addresses):
    resolve = FakeResolver({"images.2dehands.com": addresses})
    assert await _reason([URL], http, resolve) == "private_address"
    assert len(mock.calls) == 0


async def test_empty_resolution_is_http_error(mock, http):
    resolve = FakeResolver({"images.2dehands.com": []})
    assert await _reason([URL], http, resolve) == "http_error"
    assert len(mock.calls) == 0


@pytest.mark.parametrize(
    "url", ["http://169.254.169.254/latest/meta-data/", "http://[::ffff:127.0.0.1]/a.jpg"]
)
async def test_private_ip_literal_is_refused_without_resolution(mock, http, url):
    resolve = FakeResolver()
    assert await _reason([url], http, resolve) == "private_address"
    assert resolve.calls == []
    assert len(mock.calls) == 0


async def test_public_mapped_ipv6_address_is_accepted(mock, http):
    mock.get(URL).mock(return_value=httpx.Response(200, content=PNG))
    resolve = FakeResolver({"images.2dehands.com": ["::ffff:93.184.216.34", "2606:4700::1111"]})
    assert len(await fetch_images([URL], SUFFIXES, http=http, resolve=resolve)) == 1


# --- Redirections ---------------------------------------------------------------------------


def _redirect(location: str, status: int = 302) -> httpx.Response:
    return httpx.Response(status, headers={"Location": location})


async def test_redirect_to_metadata_address_is_refused(mock, http):
    first = mock.get(URL).mock(return_value=_redirect("http://169.254.169.254/"))

    assert await _reason([URL], http) == "private_address"
    assert first.call_count == 1
    assert len(mock.calls) == 1


async def test_redirect_to_host_outside_list_is_refused(mock, http):
    mock.get(URL).mock(return_value=_redirect("https://evil.example/a.jpg"))

    assert await _reason([URL], http) == "host_not_allowed"
    assert len(mock.calls) == 1


async def test_redirect_rechecks_resolution_of_the_new_host(mock, http):
    mock.get(URL).mock(return_value=_redirect("https://scontent.fbcdn.net/a.jpg"))
    resolve = FakeResolver({"scontent.fbcdn.net": ["10.1.2.3"]})

    assert await _reason([URL], http, resolve) == "private_address"
    assert resolve.calls == ["images.2dehands.com", "scontent.fbcdn.net"]
    assert len(mock.calls) == 1


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
async def test_two_redirects_are_followed_including_relative_location(mock, http, status):
    mock.get(URL).mock(return_value=_redirect("https://scontent.fbcdn.net/b.jpg", status))
    mock.get("https://scontent.fbcdn.net/b.jpg").mock(return_value=_redirect("../c/d.jpg", status))
    final = mock.get("https://scontent.fbcdn.net/c/d.jpg").mock(
        return_value=httpx.Response(200, content=PNG)
    )

    assert len(await fetch_images([URL], SUFFIXES, http=http, resolve=FakeResolver())) == 1
    assert final.call_count == 1
    assert len(mock.calls) == 3


async def test_three_redirects_are_http_error(mock, http):
    mock.get(URL).mock(return_value=_redirect("/b.jpg"))
    mock.get("https://images.2dehands.com/b.jpg").mock(return_value=_redirect("/c.jpg"))
    mock.get("https://images.2dehands.com/c.jpg").mock(return_value=_redirect("/d.jpg"))
    last = mock.get("https://images.2dehands.com/d.jpg").mock(
        return_value=httpx.Response(200, content=PNG)
    )

    assert await _reason([URL], http) == "http_error"
    assert last.call_count == 0
    assert len(mock.calls) == 3


async def test_redirect_without_location_is_http_error(mock, http):
    mock.get(URL).mock(return_value=httpx.Response(302))
    assert await _reason([URL], http) == "http_error"


# --- Statuts, transport et délais -----------------------------------------------------------


@pytest.mark.parametrize("status", [304, 403, 404, 500, 503])
async def test_non_success_status_is_http_error(mock, http, status):
    mock.get(URL).mock(return_value=httpx.Response(status, content=PNG))
    assert await _reason([URL], http) == "http_error"


async def test_transport_error_is_http_error(mock, http):
    mock.get(URL).mock(side_effect=httpx.ConnectError("boom"))
    assert await _reason([URL], http) == "http_error"


@pytest.mark.parametrize("error", [httpx.ConnectTimeout, httpx.ReadTimeout, httpx.PoolTimeout])
async def test_httpx_timeouts_are_timeout(mock, http, error):
    mock.get(URL).mock(side_effect=error("lent"))
    assert await _reason([URL], http) == "timeout"


async def test_overall_deadline_covers_resolution_and_redirects(mock, http, monkeypatch):
    monkeypatch.setattr(images, "TIMEOUT_S", 0.05)

    class SlowResolver(FakeResolver):
        async def __call__(self, host: str) -> list[str]:
            if self.calls:  # la deuxième résolution (après redirection) bloque
                await asyncio.sleep(1)
            return await super().__call__(host)

    mock.get(URL).mock(return_value=_redirect("/b.jpg"))
    assert await _reason([URL], http, SlowResolver()) == "timeout"


async def test_request_asks_for_identity_encoding(mock, http):
    route = mock.get(URL).mock(return_value=httpx.Response(200, content=PNG))
    await fetch_images([URL], SUFFIXES, http=http, resolve=FakeResolver())
    assert route.calls.last.request.headers["accept-encoding"] == "identity"


async def test_client_authentication_is_never_sent(mock):
    route = mock.get(URL).mock(return_value=httpx.Response(200, content=PNG))
    async with httpx.AsyncClient(auth=("user", "secret")) as client:
        await fetch_images([URL], SUFFIXES, http=client, resolve=FakeResolver())
    assert "authorization" not in route.calls.last.request.headers


# --- Taille ---------------------------------------------------------------------------------


def _counting_stream(chunks: list[bytes], read: list[int]) -> AsyncIterator[bytes]:
    async def body() -> AsyncIterator[bytes]:
        for chunk in chunks:
            read.append(len(chunk))
            yield chunk

    return body()


async def test_content_length_over_limit_is_too_large_before_reading(mock, http):
    read: list[int] = []
    size = 6 * 1024 * 1024
    stream = _counting_stream([b"\0" * (1024 * 1024)] * 6, read)
    mock.get(URL).mock(
        return_value=httpx.Response(200, headers={"Content-Length": str(size)}, content=stream)
    )

    assert await _reason([URL], http) == "too_large"
    assert read == []


@pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "zstd", "gzip, identity", "x"])
async def test_compressed_response_is_refused_before_reading(mock, http, encoding):
    # 64 Mo de zéros compressés en quelques dizaines de Ko, derrière un petit Content-Length.
    bomb = gzip.compress(b"\0" * (64 * 1024 * 1024))
    read: list[int] = []
    headers = {"Content-Encoding": encoding, "Content-Length": str(len(bomb))}
    mock.get(URL).mock(
        return_value=httpx.Response(200, headers=headers, content=_counting_stream([bomb], read))
    )

    assert await _reason([URL], http) == "too_large"
    assert read == []


async def test_identity_content_encoding_is_accepted(mock, http):
    headers = {"Content-Encoding": "Identity"}
    mock.get(URL).mock(return_value=httpx.Response(200, headers=headers, content=PNG))
    assert len(await fetch_images([URL], SUFFIXES, http=http, resolve=FakeResolver())) == 1


async def test_streamed_body_over_limit_is_cut_early(mock, http):
    sent: list[int] = []

    async def body() -> AsyncIterator[bytes]:
        for _ in range(20):  # 20 Mo annoncés, sans Content-Length
            sent.append(1)
            yield b"\0" * (1024 * 1024)

    mock.get(URL).mock(return_value=httpx.Response(200, content=body()))

    assert await _reason([URL], http) == "too_large"
    assert len(sent) <= 6


async def test_body_of_exactly_the_limit_is_read(mock, http, monkeypatch):
    monkeypatch.setattr(images, "MAX_BYTES", len(PNG))
    mock.get(URL).mock(return_value=httpx.Response(200, content=PNG))
    assert len(await fetch_images([URL], SUFFIXES, http=http, resolve=FakeResolver())) == 1


# --- Contenu de l'image ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "content",
    [
        b"<html>pas une image</html>",
        b"",
        PNG[: len(PNG) // 2],  # PNG tronqué
        _image_bytes(10, 10, fmt="BMP"),  # format décodable mais non accepté
    ],
)
async def test_non_image_content_is_bad_image(mock, http, content):
    mock.get(URL).mock(return_value=httpx.Response(200, content=content))
    assert await _reason([URL], http) == "bad_image"


@pytest.mark.parametrize(
    ("width", "height"),
    [
        (20_000, 20_000),  # au-delà de 2 × MAX_IMAGE_PIXELS : DecompressionBombError
        (10_000, 10_000),  # au-delà de MAX_IMAGE_PIXELS : DecompressionBombWarning
    ],
)
async def test_decompression_bomb_is_bad_image(mock, http, width, height):
    mock.get(URL).mock(return_value=httpx.Response(200, content=_png_header_only(width, height)))
    filters_before = list(warnings.filters)

    with warnings.catch_warnings(record=True) as emitted:
        warnings.simplefilter("always")
        reason = await _reason([URL], http)

    assert reason == "bad_image"
    assert emitted == []  # l'avertissement devient une erreur, il n'est jamais émis
    assert warnings.filters == filters_before


async def test_image_over_pixel_limit_is_refused_from_its_header(mock, http, monkeypatch):
    # 6000 × 5000 = 30 Mpx : sous la limite de Pillow, au-dessus de MAX_PIXELS. Le refus vient
    # de l'en-tête seul : ni `verify` ni `load` ne sont appelés.
    touched: list[str] = []
    monkeypatch.setattr(PngImageFile, "verify", lambda self: touched.append("verify"))
    monkeypatch.setattr(PngImageFile, "load", lambda self: touched.append("load"))
    mock.get(URL).mock(return_value=httpx.Response(200, content=_png_header_only(6000, 5000)))

    assert await _reason([URL], http) == "bad_image"
    assert touched == []


async def test_image_at_pixel_limit_is_accepted(mock, http, monkeypatch):
    monkeypatch.setattr(images, "MAX_PIXELS", 2000 * 1000)
    mock.get(URL).mock(return_value=httpx.Response(200, content=_image_bytes(2000, 1000)))
    assert len(await fetch_images([URL], SUFFIXES, http=http, resolve=FakeResolver())) == 1


async def test_png_is_resized_to_768_jpeg(mock, http):
    mock.get(URL).mock(return_value=httpx.Response(200, content=_image_bytes(2000, 1000)))

    [encoded] = await fetch_images([URL], SUFFIXES, http=http, resolve=FakeResolver())
    image = _decode(encoded)

    assert image.format == "JPEG"
    assert image.size == (768, 384)
    assert image.mode == "RGB"


async def test_transparent_and_small_images_become_rgb_jpeg_without_upscaling(mock, http):
    mock.get(URL).mock(return_value=httpx.Response(200, content=_image_bytes(30, 50, "RGBA")))

    [encoded] = await fetch_images([URL], SUFFIXES, http=http, resolve=FakeResolver())
    image = _decode(encoded)

    assert (image.format, image.mode, image.size) == ("JPEG", "RGB", (30, 50))


async def test_exif_orientation_is_applied(mock, http):
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation : rotation de 90°
    content = _image_bytes(200, 100, fmt="JPEG", exif=exif)
    mock.get(URL).mock(return_value=httpx.Response(200, content=content))

    [encoded] = await fetch_images([URL], SUFFIXES, http=http, resolve=FakeResolver())

    assert _decode(encoded).size == (100, 200)


# --- Plusieurs images -----------------------------------------------------------------------


async def test_only_the_first_four_urls_are_downloaded(mock, http):
    urls = [f"https://images.2dehands.com/{i}.jpg" for i in range(6)]
    for url in urls:
        mock.get(url).mock(return_value=httpx.Response(200, content=PNG))

    result = await fetch_images(urls, SUFFIXES, http=http, resolve=FakeResolver())

    assert len(result) == 4
    assert len(mock.calls) == 4
    assert [str(call.request.url) for call in mock.calls] == urls[:4]


async def test_limit_parameter_is_respected(mock, http):
    urls = [f"https://images.2dehands.com/{i}.jpg" for i in range(3)]
    for url in urls:
        mock.get(url).mock(return_value=httpx.Response(200, content=PNG))

    result = await fetch_images(urls, SUFFIXES, http=http, resolve=FakeResolver(), limit=2)

    assert len(result) == 2
    assert len(mock.calls) == 2


async def test_no_url_gives_no_image(mock, http):
    assert await fetch_images([], SUFFIXES, http=http, resolve=FakeResolver()) == []


async def test_one_failing_image_fails_the_whole_call(mock, http):
    urls = [f"https://images.2dehands.com/{i}.jpg" for i in range(3)]
    mock.get(urls[0]).mock(return_value=httpx.Response(200, content=PNG))
    mock.get(urls[1]).mock(return_value=httpx.Response(404))
    mock.get(urls[2]).mock(return_value=httpx.Response(200, content=PNG))

    assert await _reason(urls, http) == "http_error"


# --- Messages d'erreur ----------------------------------------------------------------------

SECRET_URL = "https://images.2dehands.com/secret-path-91c2.jpg"


def _assert_clean(error: ImageFetchError, reason: str) -> None:
    # Ni l'URL, ni les octets, ni les adresses ; aucune exception d'origine rattachée.
    assert str(error) == reason
    assert error.args == (reason,)
    assert error.__cause__ is None
    assert error.__context__ is None


async def test_timeout_error_is_not_chained_and_names_only_the_reason(mock, http):
    mock.get(SECRET_URL).mock(side_effect=httpx.ConnectTimeout("lent"))
    with pytest.raises(ImageFetchError) as caught:
        await fetch_images([SECRET_URL], SUFFIXES, http=http, resolve=FakeResolver())
    _assert_clean(caught.value, "timeout")


async def test_bad_image_error_is_not_chained_and_names_only_the_reason(mock, http):
    mock.get(SECRET_URL).mock(return_value=httpx.Response(200, content=b"not-an-image"))
    with pytest.raises(ImageFetchError) as caught:
        await fetch_images([SECRET_URL], SUFFIXES, http=http, resolve=FakeResolver())
    _assert_clean(caught.value, "bad_image")


async def test_private_address_error_does_not_name_the_address(mock, http):
    resolve = FakeResolver({"images.2dehands.com": ["10.9.8.7"]})
    with pytest.raises(ImageFetchError) as caught:
        await fetch_images([SECRET_URL], SUFFIXES, http=http, resolve=resolve)
    _assert_clean(caught.value, "private_address")


# --- Résolution par défaut ------------------------------------------------------------------


async def test_default_resolve_returns_ip_literal_itself():
    assert await default_resolve("127.0.0.1") == ["127.0.0.1"]


async def test_default_resolve_deduplicates_addresses(monkeypatch):
    async def getaddrinfo(host, port, *args, **kwargs):
        assert (host, port) == ("cdn.example", None)
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0)),
            (socket.AF_INET, socket.SOCK_DGRAM, 17, "", ("93.184.216.34", 0)),
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700::1111", 0, 0, 0)),
        ]

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", getaddrinfo)
    assert await default_resolve("cdn.example") == ["93.184.216.34", "2606:4700::1111"]


async def test_default_resolve_failure_is_http_error(monkeypatch):
    async def getaddrinfo(*args, **kwargs):
        raise socket.gaierror(socket.EAI_NONAME, "unknown host cdn.example")

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", getaddrinfo)
    with pytest.raises(ImageFetchError) as caught:
        await default_resolve("cdn.example")
    _assert_clean(caught.value, "http_error")
