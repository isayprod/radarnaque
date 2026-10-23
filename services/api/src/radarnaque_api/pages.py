"""Lecture du texte de pages web, sûre contre les attaques SSRF.

Seules les URL `https` (port 443, ni identifiants ni IP littérale) sont lues. Pour chaque URL et
chaque cible de redirection, le nom d'hôte est résolu puis **toutes** ses adresses doivent être
publiques (`is_public_address`). Les redirections sont suivies à la main, deux au plus. La page
est lue avec un délai de 5 s, résolution et redirections comprises ; le corps est lu brut, en
flux, sans aucun décodage de notre côté, et coupé au-delà de 1 Mo ; une réponse compressée est
refusée. Seuls `text/html` et `text/plain` sont acceptés. Le texte est extrait par `html.parser`
(sans `script`, `style`, `nav`, `footer`, `noscript` ni commentaires), puis réduit à 8 000
caractères.

DNS rebinding : la requête vise l'**adresse vérifiée** (`https://<ip>:443/...`), pas le nom. Le
nom n'est plus résolu au moment de se connecter, un DNS qui change de réponse entre la
vérification et la connexion est donc sans effet. L'en-tête `Host` et l'extension httpcore
`sni_hostname` portent le nom : le certificat TLS est vérifié contre le nom d'hôte.

Aucune connexion n'est réutilisée entre requêtes (voir `make_http_client`) : le certificat est
vérifié à chaque connexion pour le nom demandé.

Les adresses IPv6 qui embarquent une IPv4 sont traitées comme dans `images.py` (refus fermé).
`read_page` ne lève jamais (hors annulation) : tout refus ou échec donne `None`, sans détail.

Limites connues : le texte d'une page est une donnée non fiable, d'où `wrap_page` qui l'encadre ;
une page dont le contenu est un document HTML mal formé est extraite au mieux."""

import asyncio
import ipaddress
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from http.cookiejar import Cookie, CookieJar

import httpx

from radarnaque_api.images import (
    MAX_REDIRECTS,
    REDIRECT_STATUSES,
    Resolver,
    default_resolve,
    is_public_address,
)

PAGE_TIMEOUT_S = 5
USER_AGENT = "Radarnaque/1.0 (+https://radarnaque.mostconsult.be)"
MAX_BYTES = 1024 * 1024
MAX_TEXT_CHARS = 8000
MAX_TITLE_CHARS = 300
ALLOWED_TYPES = frozenset({"text/html", "text/plain"})
SKIPPED_TAGS = frozenset({"script", "style", "nav", "footer", "noscript"})
_PAGE_TAG = re.compile(r"<(?=\s*/?\s*page_web)", re.IGNORECASE)


class _NoCookies(CookieJar):
    """Jar qui ne retient jamais rien."""

    def set_cookie(self, cookie: Cookie) -> None:
        return None


def make_http_client() -> httpx.AsyncClient:
    """Client dédié au lecteur de pages. Sans proxy ni redirection automatique ; aucune
    connexion n'est gardée (`max_keepalive_connections=0`) : httpcore choisit une connexion par
    origine (`https://<ip>:443`), sans le nom d'hôte. Un second nom qui résoudrait vers la même
    IP réutiliserait la connexion déjà vérifiée pour un autre nom, sans contrôle de son
    certificat. Aucun cookie n'est jamais retenu (les requêtes visent des IP, et le client est
    partagé entre sites)."""
    client = httpx.AsyncClient(
        trust_env=False,
        follow_redirects=False,
        limits=httpx.Limits(max_keepalive_connections=0),
    )
    client.cookies.jar = _NoCookies()  # httpx recopie un jar fourni : on remplace celui du client
    return client


@dataclass(frozen=True)
class PageText:
    url: str
    domain: str
    title: str
    text: str


class _Refused(Exception):
    """Refus ou échec interne ; jamais exposé par `read_page`."""


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()  # convert_charrefs=True ; les commentaires ne sont pas collectés
        self._skip = 0
        self._in_title = False
        self._title: list[str] = []
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in SKIPPED_TAGS:
            self._skip += 1
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag in SKIPPED_TAGS:
            self._skip = max(0, self._skip - 1)
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title.append(data)
        elif not self._skip:
            self._text.append(data)

    @property
    def title(self) -> str:
        return " ".join("".join(self._title).split())[:MAX_TITLE_CHARS]

    @property
    def text(self) -> str:
        return " ".join(" ".join(self._text).split())[:MAX_TEXT_CHARS]


def _decode(body: bytes, content_type: str) -> str:
    charset = "utf-8"
    for param in content_type.split(";")[1:]:
        key, _, value = param.partition("=")
        if key.strip().lower() == "charset" and value.strip():
            charset = value.strip().strip("\"'")
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def _parse(raw: str) -> tuple[httpx.URL, str]:
    """URL et nom d'hôte normalisé ; `_Refused` si autre chose que `https`, port 443, nom d'hôte."""
    try:
        url = httpx.URL(raw)
        host = url.raw_host.decode("ascii").lower().removesuffix(".")
    except (httpx.InvalidURL, UnicodeError):
        raise _Refused from None
    if url.scheme != "https" or url.userinfo or url.port not in (None, 443) or not host:
        raise _Refused
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return url, host
    raise _Refused  # IP littérale : le certificat se vérifie contre un nom


async def _verified_address(host: str, resolve: Resolver) -> str:
    addresses = await resolve(host)
    if not addresses or not all(is_public_address(a) for a in addresses):
        raise _Refused
    return addresses[0]


def _ip_url(url: httpx.URL, address: str) -> str:
    netloc = f"[{address}]" if ":" in address else address
    return f"https://{netloc}:443{url.raw_path.decode('ascii')}"


async def _read_body(response: httpx.Response) -> bytes:
    encoding = response.headers.get("content-encoding", "").strip().lower()
    if encoding not in ("", "identity"):
        raise _Refused
    declared = response.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BYTES:
        raise _Refused
    body = bytearray()
    async for chunk in response.aiter_raw():
        body += chunk
        if len(body) > MAX_BYTES:
            raise _Refused
    return bytes(body)


async def _fetch(raw: str, http: httpx.AsyncClient, resolve: Resolver) -> tuple[str, str, str]:
    """(domaine, type de contenu, texte brut décodé) de la page, après redirections."""
    for _ in range(MAX_REDIRECTS + 1):
        url, host = _parse(raw)
        address = await _verified_address(host, resolve)
        async with http.stream(
            "GET",
            _ip_url(url, address),
            headers={"Host": host, "Accept-Encoding": "identity", "User-Agent": USER_AGENT},
            extensions={"sni_hostname": host},
            auth=None,
            follow_redirects=False,
        ) as response:
            if response.status_code in REDIRECT_STATUSES:
                location = response.headers.get("location")
                if not location:
                    raise _Refused
                raw = str(url.join(location))
                continue
            if not response.is_success:
                raise _Refused
            content_type = response.headers.get("content-type", "")
            if content_type.split(";")[0].strip().lower() not in ALLOWED_TYPES:
                raise _Refused
            return host, content_type, _decode(await _read_body(response), content_type)
    raise _Refused  # plus de MAX_REDIRECTS redirections


async def read_page(
    url: str, *, http: httpx.AsyncClient, resolve: Resolver = default_resolve
) -> PageText | None:
    """Titre et texte de la page, ou None pour tout refus ou échec (jamais d'exception, hors
    annulation). `http` doit être un client dédié : `trust_env=False`, sans redirection."""
    try:
        async with asyncio.timeout(PAGE_TIMEOUT_S):
            domain, _, source = await _fetch(url, http, resolve)
        extractor = _TextExtractor()
        extractor.feed(source)
        extractor.close()
    except Exception:  # entrée non fiable ; `CancelledError` n'est pas une `Exception`
        return None
    return PageText(url=url, domain=domain, title=extractor.title, text=extractor.text)


async def read_pages(
    urls: list[str],
    *,
    http: httpx.AsyncClient,
    resolve: Resolver = default_resolve,
    total_timeout_s: float = 12.0,
) -> list[PageText]:
    """Pages lues en parallèle, dans l'ordre des URL ; celles en échec ou encore en cours après
    `total_timeout_s` sont omises."""
    tasks = [asyncio.ensure_future(read_page(u, http=http, resolve=resolve)) for u in urls]
    try:
        await asyncio.wait(tasks, timeout=total_timeout_s)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return [
        page
        for task in tasks
        if task.done() and not task.cancelled() and (page := task.result()) is not None
    ]


def neutralize(value: str) -> str:
    return _PAGE_TAG.sub("&lt;", value)


def wrap_page(n: int, page: PageText) -> str:
    """Page encadrée pour le prompt ; toute fermeture `</page_web>` du contenu est neutralisée."""
    domain = page.domain.replace('"', "")
    return (
        f'<page_web n="{n}" domaine="{domain}">{neutralize(page.title)}\n'
        f"{neutralize(page.text)}</page_web>"
    )
