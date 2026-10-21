"""Essais de l'admin : un modèle sur une annonce fictive fixe, une recherche web hors cache, et
l'état du moteur de recherche.

Rien n'est écrit en base ni dans les journaux : ni scan, ni analyse, ni appel LLM comptabilisé, ni
la requête de recherche. Les noms commencent par `probe_` : un nom en `test_` importé dans un
module de test serait collecté par pytest."""

import asyncio
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal

import httpx

from radarnaque_api.admin_schemas import ModelTestOut, SearchTestOut
from radarnaque_api.llm.client import LLMError, LLMErrorCode
from radarnaque_api.llm.payload import build_messages
from radarnaque_api.llm.providers import ProviderError
from radarnaque_api.models import Model
from radarnaque_api.schemas import ListingIn, RulesIn
from radarnaque_api.search import SearchBackend, SearchUnavailable, format_hits

HEALTH_TIMEOUT_SECONDS = 3.0
HEALTH_TTL_SECONDS = 60.0

# Annonce fictive fixe : le même texte à chaque essai, pour comparer deux modèles ou deux prompts.
PROBE_LISTING = ListingIn.model_validate(
    {
        "site": "2dehands.be",
        "externalId": "essai-admin",
        "url": "https://www.2dehands.be/v/essai-admin",
        "title": "Vélo de course aluminium, taille 56",
        "description": (
            "Vélo de course en aluminium, taille 56, groupe Shimano 105, très bon état. "
            "Révisé le mois dernier. Cause double emploi. À récupérer à Gand."
        ),
        "price": {"amountCents": 25000, "currency": "EUR"},
        "priceType": "fixed",
        "location": {"city": "Gent", "country": "BE"},
        "images": [],
        "seller": {"reviewCount": 12, "rating": 4.5, "sellerKind": "private"},
    }
)
# Aucune règle locale déclenchée : le modèle juge l'annonce seule.
PROBE_RULES = RulesIn(version=1, signals=[])


class SearchHealth:
    """Disponibilité de SearXNG : `GET {base_url}/healthz`, 3 s au plus. La réponse, bonne ou
    mauvaise, est gardée 60 s : l'écran de l'admin ne doit pas marteler le moteur."""

    def __init__(
        self,
        http: httpx.AsyncClient,
        base_url: str,
        *,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._http = http
        self._url = base_url.rstrip("/") + "/healthz"
        self._now = now
        self._known: tuple[float, Literal["ok", "down"]] | None = None

    async def status(self) -> Literal["ok", "down"]:
        if self._known is not None and self._now() - self._known[0] < HEALTH_TTL_SECONDS:
            return self._known[1]
        state: Literal["ok", "down"]
        try:
            response = await self._http.get(self._url, timeout=HEALTH_TIMEOUT_SECONDS)
            response.raise_for_status()
            state = "ok"
        except (httpx.HTTPError, httpx.InvalidURL):
            state = "down"
        self._known = (self._now(), state)
        return state


def _elapsed_ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


def _failed(code: LLMErrorCode, started: float) -> ModelTestOut:
    return ModelTestOut(
        ok=False,
        score=None,
        duration_ms=_elapsed_ms(started),
        tokens_in=0,
        tokens_out=0,
        raw="",
        error=code,
    )


async def probe_model(app_state: Any, model: Model, prompt: str) -> ModelTestOut:
    """Soumet `PROBE_LISTING` à `model` avec `prompt` : sans outil, sans photo. Une erreur du
    fournisseur (`LLMError`, fournisseur ou clé absents, délai dépassé) rend `ok: False` ; une
    clé absente échoue avant tout appel réseau."""
    started = time.perf_counter()
    try:
        client = app_state.llm_for(model.provider)
    except ProviderError:
        return _failed("configuration", started)
    messages = build_messages(PROBE_LISTING, PROBE_RULES, [], today=datetime.now(UTC).date())
    failure: LLMErrorCode | None = None
    try:
        async with asyncio.timeout(app_state.analysis_timeout_s):
            result = await client.analyze(
                model=model.slug, system_prompt=prompt, messages=messages, tools=None
            )
    except LLMError as exc:
        failure = exc.code
    except TimeoutError:
        failure = "timeout"
    if failure is not None:  # hors du `except` : rien d'autre que le code n'est gardé
        return _failed(failure, started)
    return ModelTestOut(
        ok=True,
        score=result.analysis.score,
        duration_ms=_elapsed_ms(started),
        tokens_in=result.tokens_in,
        tokens_out=result.tokens_out,
        raw=result.raw_text,
        error=None,
    )


async def probe_search(search: SearchBackend | None, query: str) -> SearchTestOut:
    """Interroge le moteur sans passer par le cache. Le masquage des emails et téléphones est
    celui du moteur (`clean_query`) ; `text` est le bloc que verrait le modèle."""
    if search is None:
        return SearchTestOut(status="disabled", count=0, text="")
    try:
        hits = await search.search(query, fresh=True)
    except SearchUnavailable:
        return SearchTestOut(status="down", count=0, text="")
    return SearchTestOut(status="ok", count=len(hits), text=format_hits(hits))
