"""Téléchargement des photos d'une annonce, sûr contre les attaques SSRF.

Chaque URL (et chaque cible de redirection) est vérifiée avant toute requête : schéma `http` ou
`https`, ni identifiants ni port autre que 80 ou 443, hôte égal à un suffixe autorisé ou se
terminant par « . » + ce suffixe, et **toutes** les adresses résolues publiques. Les redirections
sont suivies à la main, deux au plus. Une réponse compressée est refusée : le corps est lu brut,
en flux, sans aucun décodage de notre côté, et coupé au-delà de 5 Mo, avec un délai global de
5 s par image, résolution et redirections comprises. L'image, refusée dès son en-tête au-delà
de MAX_PIXELS, est ensuite vérifiée et réencodée par Pillow en JPEG de 768 px au plus par
défaut (réglable).

Les adresses IPv6 qui embarquent une IPv4 (NAT64 `64:ff9b::/96`, 6to4, Teredo) sont refusées
par `is_reserved` ou `is_global`, quelle que soit l'IPv4 embarquée : le contrôle échoue fermé.

Aucune information ne sort d'ici : le message d'une `ImageFetchError` n'est que sa raison, sans
URL, ni octets, ni adresse, et aucune exception d'origine ne lui est chaînée.

Limite connue : httpx résout l'hôte **à nouveau** au moment de se connecter. Un DNS qui change
de réponse entre notre vérification et cette connexion (DNS rebinding) n'est pas couvert : il
faudrait un transport qui se connecte à l'adresse vérifiée. La liste d'hôtes autorisés, limitée
aux CDN des sites, reste la première protection."""

import asyncio
import base64
import io
import ipaddress
import warnings
from collections.abc import Awaitable, Callable
from typing import Literal

import httpx
from PIL import Image, ImageOps

MAX_IMAGES = 4
MAX_SIDE = 768
JPEG_QUALITY = 80
TIMEOUT_S = 5
MAX_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 24_000_000  # bien sous la limite de Pillow (≈ 89,5 Mpx), mémoire décodée bornée
MAX_REDIRECTS = 2
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
ALLOWED_SCHEMES = frozenset({"http", "https"})
ALLOWED_PORTS = frozenset({None, 80, 443})  # None : port par défaut du schéma
# Formats courants des CDN d'annonces ; les décodeurs plus rares de Pillow restent hors d'atteinte.
ALLOWED_FORMATS = ("JPEG", "PNG", "WEBP", "GIF")

ImageFetchReason = Literal[
    "host_not_allowed", "private_address", "too_large", "timeout", "bad_image", "http_error"
]

Resolver = Callable[[str], Awaitable[list[str]]]


class ImageFetchError(Exception):
    """Le message n'est que la raison. Elle est toujours levée **hors** du bloc `except` qui a
    intercepté l'erreur d'origine : ni `__cause__` ni `__context__` ne la rattachent à une
    exception qui pourrait porter l'URL, les octets reçus ou les adresses résolues."""

    def __init__(self, reason: ImageFetchReason) -> None:
        super().__init__(reason)
        self.reason: ImageFetchReason = reason


async def default_resolve(host: str) -> list[str]:
    """Adresses de `host`, sans doublon. Une adresse IP littérale se résout en elle-même."""
    infos = None
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None)
    except (OSError, UnicodeError):  # `socket.gaierror` est une `OSError`
        pass
    if infos is None:  # levée hors du `except` : aucun contexte chaîné
        raise ImageFetchError("http_error")
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def is_public_address(address: str) -> bool:
    """Vrai si `address` est une adresse IP globale, hors plages privées ou réservées."""
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    # `::ffff:a.b.c.d` est vérifiée comme l'IPv4 qu'elle contient, quelle que soit la version
    # de Python.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or (isinstance(ip, ipaddress.IPv6Address) and ip.is_site_local)
    )


_is_public = is_public_address  # alias conservé


def _normalize(host: str) -> str:
    return host.lower().removesuffix(".")


def _normalize_suffix(suffix: str) -> str:
    # « .fbcdn.net » se comporte comme « fbcdn.net ».
    return _normalize(suffix).lstrip(".")


def _host_allowed(host: str, suffixes: list[str]) -> bool:
    return any(
        host == suffix or host.endswith("." + suffix)
        for suffix in map(_normalize_suffix, suffixes)
        if suffix
    )


def _parse(raw: str) -> tuple[httpx.URL, str] | None:
    """URL et hôte normalisé, ou None si le schéma, les identifiants, le port ou l'URL elle-même
    sont refusés. httpx analyse l'URL : on vérifie exactement ce qu'il contactera."""
    try:
        url = httpx.URL(raw)
        host = _normalize(url.raw_host.decode("ascii"))
    except (httpx.InvalidURL, UnicodeError):
        return None
    if url.scheme not in ALLOWED_SCHEMES or url.userinfo or url.port not in ALLOWED_PORTS:
        return None
    return (url, host) if host else None


def is_allowed_url(raw: str, allowed_suffixes: list[str]) -> bool:
    """Contrôle statique, sans résolution DNS, fait à la validation de l'annonce : schéma,
    identifiants, port et hôte autorisé. Les adresses sont vérifiées au téléchargement."""
    parsed = _parse(raw)
    return parsed is not None and _host_allowed(parsed[1], allowed_suffixes)


async def _checked(raw: str, suffixes: list[str], resolve: Resolver) -> httpx.URL:
    """URL à contacter, après vérification de l'hôte et de toutes ses adresses."""
    parsed = _parse(raw)
    if parsed is None:
        raise ImageFetchError("host_not_allowed")
    url, host = parsed
    try:
        literal: str | None = str(ipaddress.ip_address(host))
    except ValueError:
        literal = None
    # Une IP littérale privée est refusée comme telle, avant même la liste d'hôtes.
    if literal is not None and not _is_public(literal):
        raise ImageFetchError("private_address")
    if not _host_allowed(host, suffixes):
        raise ImageFetchError("host_not_allowed")
    addresses = [literal] if literal is not None else await resolve(host)
    if not addresses:
        raise ImageFetchError("http_error")
    if not all(_is_public(address) for address in addresses):
        raise ImageFetchError("private_address")
    return url


async def _read_body(response: httpx.Response) -> bytes:
    # `Accept-Encoding: identity` n'est qu'une demande. Un corps compressé serait décodé par
    # httpx sans borne (gzip jusqu'à ~1000:1, brotli ou zstd au-delà) : il est refusé avant
    # toute lecture, et le corps est lu brut (`aiter_raw`), sans décodage.
    encoding = response.headers.get("content-encoding", "").strip().lower()
    if encoding not in ("", "identity"):
        raise ImageFetchError("too_large")
    declared = response.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BYTES:
        raise ImageFetchError("too_large")
    body = bytearray()
    async for chunk in response.aiter_raw():
        body += chunk
        if len(body) > MAX_BYTES:
            raise ImageFetchError("too_large")
    return bytes(body)


async def _follow(
    raw: str, suffixes: list[str], http: httpx.AsyncClient, resolve: Resolver
) -> bytes:
    for _ in range(MAX_REDIRECTS + 1):
        url = await _checked(raw, suffixes, resolve)
        async with http.stream(
            "GET",
            url,
            # Demande seulement : une réponse compressée reste refusée par `_read_body`.
            headers={"Accept-Encoding": "identity"},
            auth=None,  # jamais l'authentification du client
            follow_redirects=False,
        ) as response:
            if response.status_code in REDIRECT_STATUSES:
                location = response.headers.get("location")
                if not location:
                    raise ImageFetchError("http_error")
                raw = str(url.join(location))
                continue
            if not response.is_success:
                raise ImageFetchError("http_error")
            return await _read_body(response)
    raise ImageFetchError("http_error")  # plus de MAX_REDIRECTS redirections


async def _download(
    raw: str, suffixes: list[str], http: httpx.AsyncClient, resolve: Resolver
) -> bytes:
    # Chaque `except` ne fait que noter la raison ; l'erreur est levée après le bloc, pour
    # qu'aucune exception d'origine (URL, adresses) ne lui soit chaînée.
    reason: ImageFetchReason
    try:
        async with asyncio.timeout(TIMEOUT_S):
            return await _follow(raw, suffixes, http, resolve)
    except (TimeoutError, httpx.TimeoutException):
        reason = "timeout"
    except (httpx.HTTPError, httpx.InvalidURL):  # transport, ou `Location` illisible
        reason = "http_error"
    raise ImageFetchError(reason)


def _to_jpeg(data: bytes, max_side: int = MAX_SIDE) -> bytes | None:
    """JPEG RGB de `max_side` px au plus, ou None si `data` n'est pas une image acceptée."""
    try:
        # Avertissement de bombe de décompression changé en erreur, ici seulement : les filtres
        # sont restaurés à la sortie, et aucun `await` n'a lieu entre-temps.
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data), formats=ALLOWED_FORMATS) as probe:
                # `open` n'a lu que l'en-tête : refus avant `verify` et tout décodage.
                if probe.width * probe.height > MAX_PIXELS:
                    return None
                probe.verify()
            with Image.open(io.BytesIO(data), formats=ALLOWED_FORMATS) as image:
                # Décodage JPEG réduit d'emblée (sans effet sur les autres formats).
                image.draft("RGB", (max_side, max_side))
                rgb = ImageOps.exif_transpose(image).convert("RGB")
            rgb.thumbnail((max_side, max_side))
            out = io.BytesIO()
            rgb.save(out, "JPEG", quality=JPEG_QUALITY)
    except Exception:  # entrée non fiable : toute erreur de décodage signifie « pas une image »
        return None
    return out.getvalue()


async def fetch_images(
    urls: list[str],
    allowed_suffixes: list[str],
    *,
    http: httpx.AsyncClient,
    resolve: Resolver = default_resolve,
    limit: int = MAX_IMAGES,
    max_side: int = MAX_SIDE,
) -> list[str]:
    """Les `limit` premières images, en JPEG de `max_side` px au plus (encodé en base64), dans
    l'ordre des URL. Les téléchargements se font l'un après l'autre ; une seule image en échec
    fait échouer tout l'appel.

    `http` doit être un client dédié à ce téléchargement : `trust_env=False` (aucun proxy, qui
    résoudrait l'hôte à notre place), sans en-têtes, cookies ni authentification partagés."""
    encoded: list[str] = []
    for raw in urls[:limit]:
        jpeg = _to_jpeg(await _download(raw, allowed_suffixes, http, resolve), max_side)
        if jpeg is None:
            raise ImageFetchError("bad_image")
        encoded.append(base64.b64encode(jpeg).decode("ascii"))
    return encoded
