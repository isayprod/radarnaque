import asyncio
import base64
import io
import json
import logging
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
import respx
from PIL import Image
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine

from radarnaque_api.auth.privileges import privileges_of
from radarnaque_api.config import Settings
from radarnaque_api.errors import ApiError
from radarnaque_api.llm.client import (
    Bilingual,
    LLMAnalysis,
    LLMError,
    LLMReason,
    LLMResult,
    OpenAICompatibleClient,
    SearchRecord,
)
from radarnaque_api.llm.providers import ProviderConfig, ProviderError
from radarnaque_api.models import (
    Analysis,
    AnalysisReason,
    AnalysisText,
    AnalysisWebSearch,
    AuthUser,
    ListingSnapshot,
    PromptVersion,
    ScanEvent,
    ScanFailure,
    ScanResult,
    Subscription,
)
from radarnaque_api.schemas import AnalysisResultOut, ScanIn
from radarnaque_api.services import scans as scans_service
from radarnaque_api.services.scans import ScanError, from_cache_expr, risk_level, run_scan
from radarnaque_api.services.usage import compute_usage

T0 = datetime(2026, 10, 17, 10, 0, tzinfo=UTC)
PUBLIC_IP = "93.184.216.34"
IMAGE_URLS = ["https://images.2dehands.com/api/a.jpg", "https://images.2dehands.com/api/b.jpg"]
_SETTINGS = {
    "database_url": "postgres://u:p@h/d",
    "jwks_url": "http://j",
    "jwt_issuer": "i",
    "jwt_audience": "a",
    "internal_api_secret": "s" * 32,
}
TEST_SETTINGS = Settings(env="test", **_SETTINGS)
PRODUCTION_SETTINGS = Settings(env="production", **_SETTINGS)


class Clock:
    """Horloge figée, avancée à la main entre deux scans."""

    def __init__(self, at: datetime = T0) -> None:
        self.at = at

    def __call__(self) -> datetime:
        return self.at

    def advance(self, **delta: float) -> None:
        self.at += timedelta(**delta)


class FakeLLM:
    """Faux client LLM : compte ses appels, et chaque appel rend un score différent."""

    def __init__(
        self, *, delay: float = 0.0, error: Exception | None = None, max_images: int | None = None
    ) -> None:
        self.max_images = max_images
        self.delay = delay
        self.error = error
        self.calls: list[dict] = []
        self.providers: list[str] = []
        self.professional = False  # valeur de `professional` des prochaines réponses
        self.searches: list[
            SearchRecord
        ] = []  # recherches web « faites » par les prochaines réponses

    def llm_for(self, provider: str) -> "FakeLLM":
        self.providers.append(provider)
        return self

    async def analyze(self, *, model: str, system_prompt: str, messages: list[dict]) -> LLMResult:
        self.calls.append({"model": model, "system_prompt": system_prompt, "messages": messages})
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        n = len(self.calls)
        return LLMResult(
            analysis=LLMAnalysis(
                score=60 + n,
                professional=self.professional,
                summary=Bilingual(fr=f"Résumé {n}", nl=f"Samenvatting {n}"),
                advice=Bilingual(fr=f"Conseil {n}", nl=f"Advies {n}"),
                reasons=[
                    LLMReason(severity="danger", fr=f"Raison A{n}", nl=f"Reden A{n}"),
                    LLMReason(severity="info", fr=f"Raison B{n}", nl=f"Reden B{n}"),
                ][: 1 + n % 2],
            ),
            tokens_in=100 * n,
            tokens_out=10 * n,
            cost_usd_micros=42 * n,
            raw_text=f'{{"score": {60 + n}}}',
            searches=list(self.searches),
        )


class FakeResolver:
    def __init__(self, address: str = PUBLIC_IP) -> None:
        self.address = address

    async def __call__(self, host: str) -> list[str]:
        return [self.address]


@pytest_asyncio.fixture
async def engine(pg_url: str) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(pg_url)
    try:
        yield eng
    finally:
        await eng.dispose()


@pytest.fixture
def mock() -> Iterator[respx.MockRouter]:
    # Aucune requête réseau : toute URL non simulée échoue.
    with respx.mock(assert_all_called=False) as router:
        yield router


@pytest_asyncio.fixture
async def http(mock: respx.MockRouter) -> AsyncIterator[httpx.AsyncClient]:
    # Client dédié aux photos (règles R6/R7) : ni proxy, ni redirection automatique.
    async with httpx.AsyncClient(trust_env=False, follow_redirects=False) as client:
        yield client


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def llm() -> FakeLLM:
    return FakeLLM()


async def _user(engine: AsyncEngine, *, role: str = "user", plan: str | None = "trial") -> AuthUser:
    uid = uuid4().hex
    email = f"{uid}@b.test"
    async with AsyncSession(engine) as session:
        await session.execute(
            text('insert into auth."user"(id, email, role) values (:id, :email, :role)'),
            {"id": uid, "email": email, "role": role},
        )
        if plan is not None:
            session.add(
                Subscription(
                    user_id=uid,
                    plan=plan,
                    status="active",
                    provider="manual",
                    period_start=T0 - timedelta(days=1),
                )
            )
        await session.commit()
    return AuthUser(id=uid, email=email, role=role)


def _scan(
    *,
    description: str = "Vélo en bon état.",
    title: str = "Vélo de course",
    signals: list[dict] | None = None,
    images: list[str] | None = None,
    listing: dict | None = None,
    **overrides,
) -> ScanIn:
    body = {
        "listing": {
            "site": "2dehands.be",
            "externalId": "m123",
            "url": "https://www.2dehands.be/v/a/m123",
            "title": title,
            "description": description,
            "price": {"amountCents": 15000, "currency": "EUR"},
            "priceType": "fixed",
            "location": {"city": "Gent"},
            "images": images if images is not None else [],
            "seller": {"reviewCount": 0},
        },
        "rules": {
            "version": 1,
            "signals": signals
            if signals is not None
            else [{"id": "new_account", "weight": 30, "severity": "warning"}],
        },
        "trigger": "button",
    }
    body["listing"].update(listing or {})
    body.update(overrides)
    return ScanIn.model_validate(body)


async def _scan_once(
    engine, user, scan, llm, http, clock, *, settings: Settings = TEST_SETTINGS, **kw
) -> AnalysisResultOut:
    """Un scan avec les privilèges que `settings` (hors production par défaut) donne à `user`."""
    return await run_scan(
        engine=engine,
        user=user,
        privileges=privileges_of(user, settings),
        scan=scan,
        llm_for=llm.llm_for,
        http=http,
        now=clock,
        resolve=kw.pop("resolve", FakeResolver()),
        **kw,
    )


async def _remaining_total(engine: AsyncEngine, user: AuthUser, at: datetime) -> int | None:
    async with AsyncSession(engine) as session:
        sub = (
            await session.execute(select(Subscription).where(Subscription.user_id == user.id))
        ).scalar_one()
        usage = await compute_usage(session, sub, at)
    return None if usage.total is None else usage.total.remaining


async def _scalar(engine: AsyncEngine, stmt):
    async with AsyncSession(engine) as session:
        return (await session.execute(stmt)).scalar_one()


async def _count(engine: AsyncEngine, model, *where) -> int:
    return await _scalar(engine, select(func.count()).select_from(model).where(*where))


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 20), "red").save(out, "PNG")
    return out.getvalue()


# --- Niveau de risque --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("score", "level"),
    [(0, "low"), (29, "low"), (30, "medium"), (59, "medium"), (60, "high"), (100, "high")],
)
def test_risk_level_thresholds(score, level):
    assert risk_level(score) == level


def test_scan_error_is_an_api_error():
    error = ScanError(402, "quota_exhausted", "Quota atteint.", {"plan": "trial"})
    assert isinstance(error, ApiError)
    assert (error.status, error.code, error.details) == (402, "quota_exhausted", {"plan": "trial"})


# --- Déroulé nominal et cache ------------------------------------------------------------------


async def test_trial_text_scan_succeeds_and_consumes_one_scan(engine, http, clock, llm):
    user = await _user(engine)
    assert await _remaining_total(engine, user, clock()) == 3

    result = await _scan_once(engine, user, _scan(), llm, http, clock)

    assert len(llm.calls) == 1
    assert llm.providers == ["openrouter"]
    assert llm.calls[0]["model"] == "google/gemini-3.1-flash-lite"
    assert llm.calls[0]["system_prompt"].startswith("Tu aides un acheteur à repérer")
    assert result.score == 61 and result.level == "high"
    assert result.partial is False and result.from_cache is False
    assert (result.summary.fr, result.summary.nl) == ("Résumé 1", "Samenvatting 1")
    assert (result.advice.fr, result.advice.nl) == ("Conseil 1", "Advies 1")
    assert [(r.severity, r.text.fr, r.text.nl) for r in result.reasons] == [
        ("danger", "Raison A1", "Reden A1"),
        ("info", "Raison B1", "Reden B1"),
    ]
    assert result.analyzed_at == T0
    assert result.remaining.scans == 2
    assert result.remaining.scans == 2
    assert result.images_analyzed == 0 and result.web_searches == []
    assert await _remaining_total(engine, user, clock()) == 2

    analysis = await _scalar(engine, select(Analysis).where(Analysis.id == result.analysis_id))
    assert (analysis.tokens_in, analysis.tokens_out, analysis.cost_usd_micros) == (100, 10, 42)
    assert analysis.rules_version == 1 and analysis.created_at == T0
    # L'analyse est enregistrée avec le prompt full v1 (prompt actif du type unique « full »).
    prompt = await _scalar(
        engine, select(PromptVersion).where(PromptVersion.id == analysis.prompt_version_id)
    )
    assert (prompt.scan_kind, prompt.version) == ("full", 1)
    assert prompt.system_prompt == llm.calls[0]["system_prompt"]
    event = await _scalar(engine, select(ScanEvent).where(ScanEvent.user_id == user.id))
    assert (event.scan_kind, event.trigger, event.created_at) == ("full", "button", T0)


async def test_same_listing_twice_is_served_from_cache_but_counts_twice(engine, http, clock, llm):
    user = await _user(engine)
    first = await _scan_once(engine, user, _scan(), llm, http, clock)
    clock.advance(seconds=1)
    second = await _scan_once(engine, user, _scan(), llm, http, clock)

    assert len(llm.calls) == 1
    assert first.from_cache is False and second.from_cache is True
    assert second.analysis_id == first.analysis_id and second.score == first.score
    assert second.analyzed_at == T0
    assert (first.remaining.scans, second.remaining.scans) == (2, 1)
    assert await _count(engine, ScanResult, ScanResult.analysis_id == first.analysis_id) == 2


async def test_from_cache_expr_labels_every_scan_result(engine, http, clock, llm):
    user = await _user(engine, plan="premium")
    for _ in range(3):
        await _scan_once(engine, user, _scan(), llm, http, clock)
        clock.advance(seconds=1)
    async with AsyncSession(engine) as session:
        labels = (
            await session.execute(
                select(from_cache_expr()).select_from(ScanResult).order_by(ScanResult.scan_event_id)
            )
        ).scalars()
        assert list(labels) == [False, True, True]


async def test_edited_listing_gets_a_new_snapshot_and_a_new_call(engine, http, clock, llm):
    user = await _user(engine)
    first = await _scan_once(engine, user, _scan(), llm, http, clock)
    clock.advance(seconds=1)
    second = await _scan_once(engine, user, _scan(description="Vélo, état neuf."), llm, http, clock)

    assert len(llm.calls) == 2
    assert second.analysis_id != first.analysis_id and second.from_cache is False
    assert await _count(engine, ListingSnapshot) == 2


async def test_other_signals_give_a_new_call_without_poisoning_the_cache(engine, http, clock, llm):
    user = await _user(engine, plan="premium")
    honest = await _scan_once(engine, user, _scan(), llm, http, clock)
    clock.advance(seconds=1)
    forged = await _scan_once(engine, user, _scan(signals=[]), llm, http, clock)
    clock.advance(seconds=1)
    again = await _scan_once(engine, user, _scan(), llm, http, clock)

    assert len(llm.calls) == 2
    assert forged.analysis_id != honest.analysis_id and forged.from_cache is False
    assert again.analysis_id == honest.analysis_id and again.from_cache is True
    assert again.score == honest.score == 61 and forged.score == 62
    assert again.summary == honest.summary
    assert await _count(engine, ListingSnapshot) == 1


async def test_expired_cache_entry_is_refreshed_in_place(engine, http, clock, llm):
    user = await _user(engine, plan="premium")
    first = await _scan_once(engine, user, _scan(), llm, http, clock)
    clock.advance(hours=25)
    second = await _scan_once(engine, user, _scan(), llm, http, clock)

    assert len(llm.calls) == 2
    # Règle R4 : la clé du cache est unique, l'entrée expirée est rafraîchie sur place.
    assert second.analysis_id == first.analysis_id
    assert second.from_cache is False
    assert second.score == 62 and second.analyzed_at == T0 + timedelta(hours=25)
    assert [r.text.fr for r in second.reasons] == ["Raison A2"]
    analysis = await _scalar(engine, select(Analysis).where(Analysis.id == first.analysis_id))
    assert analysis.created_at == T0 + timedelta(hours=25)
    assert (analysis.tokens_in, analysis.cost_usd_micros) == (200, 84)
    aid = first.analysis_id
    assert await _count(engine, AnalysisText, AnalysisText.analysis_id == aid) == 2
    assert await _count(engine, AnalysisReason, AnalysisReason.analysis_id == aid) == 1
    # L'ancien scan pointe toujours vers l'analyse.
    assert await _count(engine, ScanResult, ScanResult.analysis_id == aid) == 2

    clock.advance(seconds=1)
    third = await _scan_once(engine, user, _scan(), llm, http, clock)
    assert len(llm.calls) == 2 and third.from_cache is True and third.score == 62


@pytest.mark.parametrize(
    "change",
    [
        {"category": "Fietsen"},
        {"condition": "Gebruikt"},
        {"postedAt": "2026-10-01"},
        {"location": {"city": "Brugge"}},
        {"seller": {"reviewCount": 0, "sellerKind": "professional"}},
    ],
)
async def test_listing_facts_sent_to_the_llm_are_part_of_the_cache_key(
    engine, http, clock, llm, change
):
    # Règle R12 : un champ envoyé au LLM hors du snapshot (ici, injecté dans la catégorie ou le
    # lieu) donne une autre clé de cache, et ne peut pas empoisonner l'analyse des autres.
    user = await _user(engine, plan="premium")
    honest = await _scan_once(engine, user, _scan(), llm, http, clock)
    clock.advance(seconds=1)
    forged = await _scan_once(engine, user, _scan(listing=change), llm, http, clock)
    clock.advance(seconds=1)
    again = await _scan_once(engine, user, _scan(), llm, http, clock)

    assert len(llm.calls) == 2
    assert forged.analysis_id != honest.analysis_id and forged.from_cache is False
    assert again.analysis_id == honest.analysis_id and again.from_cache is True
    assert again.score == honest.score == 61 and again.summary == honest.summary
    assert await _count(engine, ListingSnapshot) == 1


async def test_professional_is_returned_stored_and_served_from_cache(engine, http, clock, llm):
    user = await _user(engine)
    llm.professional = True
    first = await _scan_once(engine, user, _scan(), llm, http, clock)
    clock.advance(seconds=1)
    second = await _scan_once(engine, user, _scan(), llm, http, clock)

    assert len(llm.calls) == 1
    assert first.professional is True
    assert second.from_cache is True and second.professional is True
    analysis = await _scalar(engine, select(Analysis).where(Analysis.id == first.analysis_id))
    assert analysis.professional is True


async def test_professional_defaults_to_false(engine, http, clock, llm):
    user = await _user(engine)
    result = await _scan_once(engine, user, _scan(), llm, http, clock)
    assert result.professional is False
    analysis = await _scalar(engine, select(Analysis).where(Analysis.id == result.analysis_id))
    assert analysis.professional is False


async def test_refresh_in_place_updates_professional(engine, http, clock, llm):
    user = await _user(engine, plan="premium")
    llm.professional = True
    first = await _scan_once(engine, user, _scan(), llm, http, clock)
    clock.advance(hours=25)
    llm.professional = False
    second = await _scan_once(engine, user, _scan(), llm, http, clock)

    # Règle R4 : `professional` fait partie de l'analyse, il est rafraîchi avec la note.
    assert second.analysis_id == first.analysis_id and second.from_cache is False
    assert first.professional is True and second.professional is False
    analysis = await _scalar(engine, select(Analysis).where(Analysis.id == first.analysis_id))
    assert analysis.professional is False


async def test_partial_scan_is_cached_separately(engine, http, clock, llm):
    user = await _user(engine, plan="premium")
    await _scan_once(engine, user, _scan(), llm, http, clock)
    partial = await _scan_once(engine, user, _scan(partial=True), llm, http, clock)
    assert len(llm.calls) == 2 and partial.partial is True and partial.from_cache is False


async def test_snapshot_stores_masked_title_and_description(engine, http, clock, llm):
    user = await _user(engine)
    scan = _scan(
        title="iPhone 15, écrire à jean.dupont@example.com",
        description="Appelez le 0470 12 34 56 ou écrivez à jean.dupont@example.com.",
    )
    await _scan_once(engine, user, scan, llm, http, clock)

    snapshot = await _scalar(engine, select(ListingSnapshot))
    assert snapshot.title == "iPhone 15, écrire à [email]"
    assert snapshot.description == "Appelez le [téléphone] ou écrivez à [email]."
    assert "0470" not in snapshot.description and "@" not in snapshot.title + snapshot.description
    sent = llm.calls[0]["messages"][0]["content"][0]["text"]
    assert "0470" not in sent and "jean.dupont" not in sent


# --- Concurrence -------------------------------------------------------------------------------


async def test_concurrent_scans_of_the_same_listing_make_a_single_llm_call(engine, http, clock):
    llm = FakeLLM(delay=0.3)
    alice, bob = await _user(engine), await _user(engine)

    results = await asyncio.gather(
        _scan_once(engine, alice, _scan(), llm, http, clock),
        _scan_once(engine, bob, _scan(), llm, http, clock),
    )

    assert len(llm.calls) == 1
    assert results[0].analysis_id == results[1].analysis_id
    assert results[0].score == results[1].score
    aid = results[0].analysis_id
    assert await _count(engine, ScanResult, ScanResult.analysis_id == aid) == 2
    assert await _count(engine, Analysis) == 1
    assert [r.remaining.scans for r in results] == [2, 2]


async def test_concurrent_scans_with_one_remaining_scan(engine, http, clock, llm):
    user = await _user(engine)
    async with AsyncSession(engine) as session:
        for _ in range(2):
            session.add(
                ScanEvent(user_id=user.id, scan_kind="full", trigger="button", created_at=T0)
            )
        await session.commit()
    clock.advance(minutes=5)

    results = await asyncio.gather(
        _scan_once(engine, user, _scan(), llm, http, clock),
        _scan_once(engine, user, _scan(description="Autre annonce"), llm, http, clock),
        return_exceptions=True,
    )

    successes = [r for r in results if isinstance(r, AnalysisResultOut)]
    errors = [r for r in results if isinstance(r, ScanError)]
    assert len(successes) == 1 and len(errors) == 1, results
    assert (errors[0].status, errors[0].code) == (402, "quota_exhausted")
    assert errors[0].details == {"plan": "trial", "scanKind": "full"}
    assert successes[0].remaining.scans == 0
    assert await _count(engine, ScanEvent, ScanEvent.user_id == user.id) == 3


# --- Échecs : le scan est rendu ----------------------------------------------------------------


async def test_llm_failure_gives_502_and_returns_the_scan(engine, http, clock):
    llm = FakeLLM(error=LLMError("transport", "openrouter"))
    user = await _user(engine)
    before = await _remaining_total(engine, user, clock())

    with pytest.raises(ScanError) as info:
        await _scan_once(engine, user, _scan(), llm, http, clock)

    assert (info.value.status, info.value.code) == (502, "analysis_failed")
    assert info.value.details == {"reason": "transport"}
    assert "openrouter" not in info.value.message
    failure = await _scalar(engine, select(ScanFailure))
    assert failure.error_code == "transport"
    assert await _remaining_total(engine, user, clock()) == before == 3
    assert await _count(engine, ScanResult) == 0 and await _count(engine, Analysis) == 0


async def test_invalid_llm_response_gives_502_invalid_response(engine, http, clock):
    llm = FakeLLM(error=LLMError("invalid_response", "openrouter"))
    user = await _user(engine)
    with pytest.raises(ScanError) as info:
        await _scan_once(engine, user, _scan(), llm, http, clock)
    assert info.value.details == {"reason": "invalid_response"}
    assert (await _scalar(engine, select(ScanFailure))).error_code == "invalid_response"


async def test_unknown_provider_is_a_configuration_failure(engine, http, clock, llm):
    user = await _user(engine)

    def llm_for(provider: str):
        raise ProviderError(f"fournisseur inconnu : {provider}")

    with pytest.raises(ScanError) as info:
        await run_scan(
            engine=engine,
            user=user,
            privileges=privileges_of(user, TEST_SETTINGS),
            scan=_scan(),
            llm_for=llm_for,
            http=http,
            now=clock,
        )
    assert (info.value.status, info.value.details) == (502, {"reason": "configuration"})
    assert (await _scalar(engine, select(ScanFailure))).error_code == "configuration"
    assert await _remaining_total(engine, user, clock()) == 3


async def test_scan_kind_without_active_prompt_is_a_configuration_failure(engine, http, clock, llm):
    user = await _user(engine)
    async with AsyncSession(engine) as session:
        previous = (
            await session.execute(
                text("select active_prompt_version_id from app.scan_kinds where code = 'full'")
            )
        ).scalar_one()
        await session.execute(
            text("update app.scan_kinds set active_prompt_version_id = null where code = 'full'")
        )
        await session.commit()
    try:
        with pytest.raises(ScanError) as info:
            await _scan_once(engine, user, _scan(), llm, http, clock)
    finally:
        async with AsyncSession(engine) as session:
            await session.execute(
                text("update app.scan_kinds set active_prompt_version_id = :p where code = 'full'"),
                {"p": previous},
            )
            await session.commit()
    assert (info.value.status, info.value.details) == (502, {"reason": "configuration"})
    assert llm.calls == []
    assert await _remaining_total(engine, user, clock()) == 3


async def test_unexpected_error_returns_the_scan_then_propagates(engine, http, clock):
    llm = FakeLLM(error=RuntimeError("bogue serveur"))
    user = await _user(engine)

    with pytest.raises(RuntimeError, match="bogue serveur"):
        await _scan_once(engine, user, _scan(), llm, http, clock)

    assert (await _scalar(engine, select(ScanFailure))).error_code == "internal"
    assert await _remaining_total(engine, user, clock()) == 3


async def test_cancellation_during_the_analysis_returns_the_scan(engine, http, clock):
    started = asyncio.Event()

    class BlockingLLM(FakeLLM):
        async def analyze(self, *, model: str, system_prompt: str, messages: list[dict]):
            self.calls.append({"model": model})
            started.set()
            await asyncio.Event().wait()  # jamais libéré : seule l'annulation en sort

    user = await _user(engine)
    task = asyncio.create_task(_scan_once(engine, user, _scan(), BlockingLLM(), http, clock))
    await asyncio.wait_for(started.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert (await _scalar(engine, select(ScanFailure))).error_code == "internal"
    assert await _remaining_total(engine, user, clock()) == 3
    # Le verrou consultatif a été libéré : un nouveau scan de la même annonce aboutit.
    clock.advance(seconds=1)
    result = await asyncio.wait_for(_scan_once(engine, user, _scan(), FakeLLM(), http, clock), 10)
    assert result.from_cache is False and result.remaining.scans == 2


class _FailureWriteError(RuntimeError):
    """Échec simulé de l'écriture du `scan_failures` ; son message n'est jamais journalisé."""


@pytest.fixture
def failing_failure_write(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(**_kw):
        raise _FailureWriteError("secret-db-message-4471")

    monkeypatch.setattr(scans_service, "ScanFailure", _raise)


async def test_failed_give_back_is_logged_without_the_message(
    engine, http, clock, caplog, failing_failure_write
):
    caplog.set_level(logging.DEBUG)
    llm = FakeLLM(error=LLMError("transport", "fake"))
    user = await _user(engine)

    # Comportement d'origine conservé : l'erreur de l'écriture remonte.
    with pytest.raises(_FailureWriteError):
        await _scan_once(engine, user, _scan(), llm, http, clock)

    event_id = await _scalar(engine, select(ScanEvent.id))
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert [r.getMessage() for r in errors] == [
        f"remboursement impossible pour scan_event_id={event_id} (_FailureWriteError)"
    ]
    assert errors[0].exc_info is None
    assert "secret-db-message-4471" not in caplog.text
    assert await _count(engine, ScanFailure) == 0


async def test_failed_give_back_after_cancellation_is_logged(
    engine, http, clock, caplog, failing_failure_write
):
    caplog.set_level(logging.DEBUG)
    started = asyncio.Event()

    class BlockingLLM(FakeLLM):
        async def analyze(self, *, model: str, system_prompt: str, messages: list[dict]):
            started.set()
            await asyncio.Event().wait()

    user = await _user(engine)
    task = asyncio.create_task(_scan_once(engine, user, _scan(), BlockingLLM(), http, clock))
    await asyncio.wait_for(started.wait(), 5)
    task.cancel()
    with pytest.raises(_FailureWriteError):
        await task

    event_id = await _scalar(engine, select(ScanEvent.id))
    errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
    assert errors == [
        f"remboursement impossible pour scan_event_id={event_id} (_FailureWriteError)"
    ]
    assert "secret-db-message-4471" not in caplog.text


# --- Photos ------------------------------------------------------------------------------------


async def _mock_photos(mock: respx.MockRouter, count: int) -> list:
    return [
        mock.get(f"https://images.2dehands.com/api/p{n}.jpg").respond(
            200, content=_png(), headers={"content-type": "image/png"}
        )
        for n in range(count)
    ]


def _photo_urls(count: int) -> list[str]:
    return [f"https://images.2dehands.com/api/p{n}.jpg" for n in range(count)]


def _sent_images(llm: FakeLLM, call: int = 0) -> int:
    parts = llm.calls[call]["messages"][0]["content"]
    return sum(1 for part in parts if part["type"] == "image_url")


async def test_trial_downloads_the_photos_and_sends_them(engine, http, mock, clock, llm):
    for url in IMAGE_URLS:
        mock.get(url).respond(200, content=_png(), headers={"content-type": "image/png"})
    user = await _user(engine)

    result = await _scan_once(engine, user, _scan(images=IMAGE_URLS), llm, http, clock)

    assert result.from_cache is False
    assert llm.calls[0]["model"] == "google/gemini-3.1-flash-lite"
    parts = llm.calls[0]["messages"][0]["content"]
    assert [p["type"] for p in parts] == ["text", "image_url", "image_url"]
    assert parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert result.remaining.scans == 2 and result.images_analyzed == 2


async def test_standard_sends_one_photo(engine, http, mock, clock, llm):
    routes = await _mock_photos(mock, 3)
    user = await _user(engine, plan="standard")

    result = await _scan_once(engine, user, _scan(images=_photo_urls(3)), llm, http, clock)

    assert _sent_images(llm) == 1 and result.images_analyzed == 1
    assert [r.call_count for r in routes] == [1, 0, 0]
    assert '"imagesSent":1' in llm.calls[0]["messages"][0]["content"][0]["text"]
    assert result.remaining.scans == 149
    analysis = await _scalar(engine, select(Analysis).where(Analysis.id == result.analysis_id))
    assert analysis.images_analyzed == 1


async def test_premium_sends_four_photos(engine, http, mock, clock, llm):
    await _mock_photos(mock, 6)
    user = await _user(engine, plan="premium")

    result = await _scan_once(engine, user, _scan(images=_photo_urls(6)), llm, http, clock)

    assert _sent_images(llm) == 4 and result.images_analyzed == 4


async def test_provider_image_limit_applies_below_the_plan_limit(engine, http, mock, clock):
    routes = await _mock_photos(mock, 6)
    llm = FakeLLM(max_images=3)
    user = await _user(engine, plan="premium")

    result = await _scan_once(engine, user, _scan(images=_photo_urls(6)), llm, http, clock)

    assert _sent_images(llm) == 3 and result.images_analyzed == 3
    assert [r.call_count for r in routes] == [1, 1, 1, 0, 0, 0]


async def test_no_photo_listing_analyzed(engine, http, clock, llm):
    user = await _user(engine, plan="premium")

    result = await _scan_once(engine, user, _scan(images=[]), llm, http, clock)

    assert result.score == 61 and result.images_analyzed == 0
    assert _sent_images(llm) == 0
    assert '"imagesSent":0' in llm.calls[0]["messages"][0]["content"][0]["text"]


async def test_today_in_the_payload_is_the_event_day(engine, http, clock, llm):
    user = await _user(engine)
    await _scan_once(engine, user, _scan(), llm, http, clock)
    assert '"today":"2026-10-17"' in llm.calls[0]["messages"][0]["content"][0]["text"]


async def test_cache_key_differs_by_photo_count(engine, http, mock, clock, llm):
    await _mock_photos(mock, 3)
    standard = await _user(engine, plan="standard")
    premium = await _user(engine, plan="premium")
    scan = _scan(images=_photo_urls(3))

    first = await _scan_once(engine, standard, scan, llm, http, clock)
    clock.advance(seconds=1)
    second = await _scan_once(engine, premium, scan, llm, http, clock)
    clock.advance(seconds=1)
    third = await _scan_once(engine, premium, scan, llm, http, clock)

    assert len(llm.calls) == 2
    assert (_sent_images(llm, 0), _sent_images(llm, 1)) == (1, 3)
    assert first.analysis_id != second.analysis_id
    assert (first.images_analyzed, second.images_analyzed) == (1, 3)
    assert third.from_cache is True and third.analysis_id == second.analysis_id
    assert await _count(engine, Analysis) == 2


async def test_cached_result_returns_web_searches(engine, http, clock, llm):
    llm.searches = [
        SearchRecord(query="iphone 17 pro prix occasion", aspect="price"),
        SearchRecord(query="iphone 17 pro existe", aspect="model"),
    ]
    user = await _user(engine)

    first = await _scan_once(engine, user, _scan(), llm, http, clock)
    clock.advance(seconds=1)
    second = await _scan_once(engine, user, _scan(), llm, http, clock)

    expected = [("iphone 17 pro prix occasion", "price"), ("iphone 17 pro existe", "model")]
    assert [(w.query, w.aspect) for w in first.web_searches] == expected
    assert second.from_cache is True and len(llm.calls) == 1
    assert [(w.query, w.aspect) for w in second.web_searches] == expected
    dumped = second.model_dump(mode="json", by_alias=True)
    assert dumped["webSearches"][0] == {
        "query": "iphone 17 pro prix occasion",
        "aspect": "price",
    }


async def test_refresh_replaces_web_searches_and_images_analyzed(engine, http, mock, clock, llm):
    await _mock_photos(mock, 2)
    llm.searches = [SearchRecord(query="première", aspect="other")]
    user = await _user(engine, plan="premium")
    first = await _scan_once(engine, user, _scan(images=_photo_urls(2)), llm, http, clock)
    clock.advance(hours=25)  # cache expiré : rafraîchi sur place (règle R4)
    llm.searches = [SearchRecord(query="deuxième", aspect="scam")]

    second = await _scan_once(engine, user, _scan(images=_photo_urls(2)), llm, http, clock)

    assert second.analysis_id == first.analysis_id and len(llm.calls) == 2
    assert [(w.query, w.aspect) for w in second.web_searches] == [("deuxième", "scam")]
    assert await _count(engine, AnalysisWebSearch) == 1


@pytest.mark.parametrize(
    ("address", "status", "reason"),
    [(PUBLIC_IP, 404, "image_http_error"), ("10.0.0.7", 200, "image_private_address")],
)
async def test_image_download_failure_gives_502_and_returns_the_scan(
    engine, http, mock, clock, llm, address, status, reason
):
    route = mock.get(IMAGE_URLS[0]).respond(status, content=_png())
    user = await _user(engine)

    with pytest.raises(ScanError) as info:
        await _scan_once(
            engine,
            user,
            _scan(images=IMAGE_URLS[:1]),
            llm,
            http,
            clock,
            resolve=FakeResolver(address),
        )

    assert (info.value.status, info.value.details) == (502, {"reason": reason})
    assert (await _scalar(engine, select(ScanFailure))).error_code == reason
    assert llm.calls == []
    assert route.called is (status == 404)
    assert await _remaining_total(engine, user, clock()) == 3


async def test_image_host_not_allowed_is_refused_before_reserving(engine, http, clock, llm):
    user = await _user(engine)
    images = [IMAGE_URLS[0], "https://evil.example.com/a.jpg"]

    with pytest.raises(ScanError) as info:
        await _scan_once(engine, user, _scan(images=images), llm, http, clock)

    assert (info.value.status, info.value.code) == (422, "invalid_listing")
    assert info.value.details == {"field": "listing.images.1"}
    assert await _count(engine, ScanEvent) == 0
    assert await _count(engine, ListingSnapshot) == 0
    assert await _remaining_total(engine, user, clock()) == 3


async def test_image_host_of_another_site_is_refused(engine, http, clock, llm):
    user = await _user(engine)
    with pytest.raises(ScanError) as info:
        await _scan_once(
            engine, user, _scan(images=["https://scontent.fbcdn.net/a.jpg"]), llm, http, clock
        )
    assert info.value.details == {"field": "listing.images.0"}


# --- Droits ------------------------------------------------------------------------------------


async def test_card_requires_card_icons(engine, http, clock, llm):
    user = await _user(engine, plan="standard")
    with pytest.raises(ScanError) as info:
        await _scan_once(engine, user, _scan(trigger="card"), llm, http, clock)
    assert (info.value.status, info.value.code) == (403, "feature_not_in_plan")
    assert info.value.details == {"feature": "card_icons"}
    assert await _count(engine, ScanEvent) == 0


@pytest.mark.parametrize("role", ["admin", "superuser"])
async def test_unlimited_accounts_send_four_photos(engine, http, mock, clock, llm, role):
    await _mock_photos(mock, 6)
    user = await _user(engine, role=role, plan=None)

    result = await _scan_once(engine, user, _scan(images=_photo_urls(6)), llm, http, clock)

    assert _sent_images(llm) == 4 and result.images_analyzed == 4


async def test_user_without_subscription_gets_402(engine, http, clock, llm):
    user = await _user(engine, plan=None)
    with pytest.raises(ScanError) as info:
        await _scan_once(engine, user, _scan(), llm, http, clock)
    assert (info.value.status, info.value.code) == (402, "no_active_subscription")
    assert await _count(engine, ScanEvent) == 0


async def test_admin_without_subscription_can_scan_everything(engine, http, mock, clock, llm):
    mock.get(IMAGE_URLS[0]).respond(200, content=_png())
    admin = await _user(engine, role="admin", plan=None)

    result = await _scan_once(
        engine,
        admin,
        _scan(images=IMAGE_URLS[:1], trigger="card"),
        llm,
        http,
        clock,
    )

    assert result.remaining.model_dump() == {"scans": None}
    assert await _count(engine, ScanEvent, ScanEvent.user_id == admin.id) == 1


async def test_superuser_without_subscription_has_every_feature_and_no_quota(
    engine, http, mock, clock, llm
):
    mock.get(IMAGE_URLS[0]).respond(200, content=_png())
    superuser = await _user(engine, role="superuser", plan=None)

    for i in range(5):  # plus que les 3 scans de l'essai
        result = await _scan_once(
            engine,
            superuser,
            _scan(description=f"annonce {i}", images=IMAGE_URLS[:1], trigger="card"),
            llm,
            http,
            clock,
        )
        assert result.remaining.model_dump() == {"scans": None}

    assert await _count(engine, ScanEvent, ScanEvent.user_id == superuser.id) == 5
    assert await _count(engine, Subscription, Subscription.user_id == superuser.id) == 0


async def test_superuser_in_production_is_an_ordinary_user(engine, http, clock, llm):
    superuser = await _user(engine, role="superuser", plan=None)
    with pytest.raises(ScanError) as info:
        await _scan_once(engine, superuser, _scan(), llm, http, clock, settings=PRODUCTION_SETTINGS)
    assert (info.value.status, info.value.code) == (402, "no_active_subscription")
    assert await _count(engine, ScanEvent) == 0


async def test_superuser_in_production_keeps_the_trial_quota(engine, http, clock, llm):
    superuser = await _user(engine, role="superuser")
    for i in range(3):
        await _scan_once(
            engine,
            superuser,
            _scan(description=f"annonce {i}"),
            llm,
            http,
            clock,
            settings=PRODUCTION_SETTINGS,
        )
    with pytest.raises(ScanError) as info:
        await _scan_once(engine, superuser, _scan(), llm, http, clock, settings=PRODUCTION_SETTINGS)
    assert (info.value.status, info.value.code) == (402, "quota_exhausted")


async def test_quota_exhausted_gives_402_with_plan_and_kind(engine, http, clock, llm):
    user = await _user(engine)
    for i in range(3):
        await _scan_once(engine, user, _scan(description=f"annonce {i}"), llm, http, clock)
    with pytest.raises(ScanError) as info:
        await _scan_once(engine, user, _scan(), llm, http, clock)
    assert (info.value.status, info.value.code) == (402, "quota_exhausted")
    assert info.value.details == {"plan": "trial", "scanKind": "full"}
    assert await _count(engine, ScanEvent) == 3


# --- Limite de requêtes ------------------------------------------------------------------------


async def test_rate_limit_applies_to_admins_too(engine, http, clock, llm):
    admin = await _user(engine, role="admin", plan=None)
    for _ in range(30):
        await _scan_once(engine, admin, _scan(), llm, http, clock)

    with pytest.raises(ScanError) as info:
        await _scan_once(engine, admin, _scan(), llm, http, clock)
    assert (info.value.status, info.value.code) == (429, "rate_limited")
    assert await _count(engine, ScanEvent) == 30

    clock.advance(seconds=61)
    await _scan_once(engine, admin, _scan(), llm, http, clock)
    assert len(llm.calls) == 1


async def test_superuser_is_not_rate_limited(engine, http, clock, llm):
    superuser = await _user(engine, role="superuser", plan=None)
    for _ in range(31):
        await _scan_once(engine, superuser, _scan(), llm, http, clock)
    assert await _count(engine, ScanEvent, ScanEvent.user_id == superuser.id) == 31


async def test_superuser_concurrent_scans_are_not_rate_limited(engine, http, clock, llm):
    # Le recomptage atomique de `_reserve` ne s'applique pas non plus au superuser.
    superuser = await _user(engine, role="superuser", plan=None)
    async with AsyncSession(engine) as session:
        for _ in range(29):
            session.add(
                ScanEvent(user_id=superuser.id, scan_kind="full", trigger="button", created_at=T0)
            )
        await session.commit()

    results = await asyncio.gather(
        *(_scan_once(engine, superuser, _scan(), llm, http, clock) for _ in range(4)),
        return_exceptions=True,
    )

    assert all(isinstance(r, AnalysisResultOut) for r in results), results
    assert await _count(engine, ScanEvent, ScanEvent.user_id == superuser.id) == 33


async def test_superuser_in_production_is_rate_limited(engine, http, clock, llm):
    superuser = await _user(engine, role="superuser", plan="standard")
    for _ in range(30):
        await _scan_once(engine, superuser, _scan(), llm, http, clock, settings=PRODUCTION_SETTINGS)
    with pytest.raises(ScanError) as info:
        await _scan_once(engine, superuser, _scan(), llm, http, clock, settings=PRODUCTION_SETTINGS)
    assert (info.value.status, info.value.code) == (429, "rate_limited")


async def test_rate_limit_applies_to_a_standard_user(engine, http, clock, llm):
    user = await _user(engine, plan="standard")
    for _ in range(30):
        await _scan_once(engine, user, _scan(), llm, http, clock)

    with pytest.raises(ScanError) as info:
        await _scan_once(engine, user, _scan(), llm, http, clock)
    assert (info.value.status, info.value.code) == (429, "rate_limited")
    assert await _count(engine, ScanEvent, ScanEvent.user_id == user.id) == 30


async def test_rate_limit_is_atomic_under_concurrency(engine, http, clock, llm):
    # Un admin ne verrouille pas d'abonnement : seul le verrou de la limite sérialise ses scans.
    admin = await _user(engine, role="admin", plan=None)
    async with AsyncSession(engine) as session:
        for _ in range(29):
            session.add(
                ScanEvent(user_id=admin.id, scan_kind="full", trigger="button", created_at=T0)
            )
        await session.commit()

    results = await asyncio.gather(
        *(_scan_once(engine, admin, _scan(), llm, http, clock) for _ in range(4)),
        return_exceptions=True,
    )

    successes = [r for r in results if isinstance(r, AnalysisResultOut)]
    limited = [r for r in results if isinstance(r, ScanError) and r.code == "rate_limited"]
    assert (len(successes), len(limited)) == (1, 3), results
    assert await _count(engine, ScanEvent, ScanEvent.user_id == admin.id) == 30


# --- Bloc debug, logs et relance sans cache (superuser hors production) -------------------------

DEBUG_LOGGER = "radarnaque.debug"
SECRET_KEY = "sk-test-secret"
LLM_BASE = "https://llm.test/v1"


@pytest.fixture
def debug_log(caplog: pytest.LogCaptureFixture) -> Iterator[pytest.LogCaptureFixture]:
    """Capture le logger de debug même quand `create_app` lui a retiré la propagation (le
    gestionnaire de `caplog` n'est attaché qu'à la racine)."""
    logger = logging.getLogger(DEBUG_LOGGER)
    caplog.set_level(logging.INFO, logger=DEBUG_LOGGER)
    # Sans propagation, chaque enregistrement n'est capturé qu'une fois, quel que soit l'état
    # laissé par une application créée plus tôt dans la session.
    propagate, logger.propagate = logger.propagate, False
    logger.addHandler(caplog.handler)
    try:
        yield caplog
    finally:
        logger.removeHandler(caplog.handler)
        logger.propagate = propagate


def _debug_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == DEBUG_LOGGER]


def _b64_size(b64: str) -> int:
    return len(base64.b64decode(b64))


async def test_superuser_scan_has_a_debug_block(engine, http, clock, llm):
    superuser = await _user(engine, role="superuser", plan=None)
    scan = _scan()

    result = await _scan_once(engine, superuser, scan, llm, http, clock)

    debug = result.debug
    assert debug is not None
    assert (debug.provider, debug.model) == ("openrouter", "google/gemini-3.1-flash-lite")
    assert (debug.prompt_version.scan_kind, debug.prompt_version.version) == ("full", 1)
    assert debug.system_prompt == llm.calls[0]["system_prompt"]
    sent = llm.calls[0]["messages"]
    assert debug.messages[0].model_dump() == {
        "role": "user",
        "content": sent[0]["content"][0]["text"],
    }
    assert len(debug.messages) == 1
    assert debug.raw_response == '{"score": 61}'
    assert debug.llm_called is True and debug.from_cache is False
    assert (debug.tokens_in, debug.tokens_out, debug.cost_usd_micros) == (100, 10, 42)
    assert debug.timings_ms.images is None
    assert isinstance(debug.timings_ms.llm, int) and debug.timings_ms.llm >= 0
    assert debug.timings_ms.total >= debug.timings_ms.llm
    analysis = await _scalar(engine, select(Analysis).where(Analysis.id == result.analysis_id))
    snapshot = await _scalar(
        engine, select(ListingSnapshot).where(ListingSnapshot.id == analysis.snapshot_id)
    )
    assert debug.analysis_id == result.analysis_id
    assert debug.snapshot_id == snapshot.id
    assert debug.content_hash == snapshot.content_hash
    assert debug.input_hash == analysis.input_hash
    # Sérialisé en camelCase, comme le reste de la réponse.
    dumped = result.model_dump(mode="json", by_alias=True)["debug"]
    assert {"promptVersion", "systemPrompt", "rawResponse", "llmCalled", "timingsMs"} <= set(dumped)
    assert dumped["promptVersion"] == {"scanKind": "full", "version": 1}


@pytest.mark.parametrize(("role", "plan"), [("admin", None), ("user", "trial")])
async def test_no_debug_block_for_admin_or_user(engine, http, clock, llm, role, plan):
    user = await _user(engine, role=role, plan=plan)
    result = await _scan_once(engine, user, _scan(), llm, http, clock)
    assert result.debug is None


async def test_no_debug_block_for_a_superuser_in_production(engine, http, clock, llm):
    superuser = await _user(engine, role="superuser")
    result = await _scan_once(
        engine, superuser, _scan(), llm, http, clock, settings=PRODUCTION_SETTINGS
    )
    assert result.debug is None


async def test_debug_block_summarizes_images_by_size(engine, http, mock, clock, llm):
    for url in IMAGE_URLS:
        mock.get(url).respond(200, content=_png(), headers={"content-type": "image/png"})
    superuser = await _user(engine, role="superuser", plan=None)

    result = await _scan_once(engine, superuser, _scan(images=IMAGE_URLS), llm, http, clock)

    parts = llm.calls[0]["messages"][0]["content"]
    sizes = [_b64_size(p["image_url"]["url"].split("base64,", 1)[1]) for p in parts[1:]]
    content = result.debug.messages[0].content
    assert content == "\n".join(
        [parts[0]["text"], f"[image 1 : {sizes[0]} octets]", f"[image 2 : {sizes[1]} octets]"]
    )
    assert "base64" not in result.model_dump_json()
    assert isinstance(result.debug.timings_ms.images, int)
    assert (result.debug.prompt_version.scan_kind, result.debug.model) == (
        "full",
        "google/gemini-3.1-flash-lite",
    )


async def test_debug_block_from_cache_shows_the_messages_without_calling_the_llm(
    engine, http, mock, clock, llm
):
    routes = [
        mock.get(url).respond(200, content=_png(), headers={"content-type": "image/png"})
        for url in IMAGE_URLS
    ]
    superuser = await _user(engine, role="superuser", plan=None)
    scan = _scan(images=IMAGE_URLS)
    first = await _scan_once(engine, superuser, scan, llm, http, clock)
    clock.advance(seconds=1)

    second = await _scan_once(engine, superuser, scan, llm, http, clock)

    assert len(llm.calls) == 1 and second.from_cache is True
    assert [r.call_count for r in routes] == [1, 1]  # aucune photo retéléchargée
    debug = second.debug
    assert debug.llm_called is False and debug.from_cache is True
    assert debug.raw_response is None
    assert debug.timings_ms.images is None and debug.timings_ms.llm is None
    assert debug.system_prompt == first.debug.system_prompt
    text = llm.calls[0]["messages"][0]["content"][0]["text"]
    assert debug.messages[0].content == "\n".join(
        [text, "[image 1 : non téléchargée (cache)]", "[image 2 : non téléchargée (cache)]"]
    )
    assert debug.analysis_id == first.analysis_id
    assert (debug.input_hash, debug.content_hash) == (
        first.debug.input_hash,
        first.debug.content_hash,
    )
    # Coût de l'analyse servie (celle du premier appel).
    assert (debug.tokens_in, debug.cost_usd_micros) == (100, 42)


async def test_cached_debug_system_prompt_uses_the_client_helper(engine, http, clock, llm):
    superuser = await _user(engine, role="superuser", plan=None)
    await _scan_once(engine, superuser, _scan(), llm, http, clock)
    clock.advance(seconds=1)
    llm.final_system_prompt = lambda prompt: f"{prompt}\n<schéma>"  # type: ignore[attr-defined]

    cached = await _scan_once(engine, superuser, _scan(), llm, http, clock)

    assert cached.debug.llm_called is False
    assert cached.debug.system_prompt == f"{llm.calls[0]['system_prompt']}\n<schéma>"


async def test_cached_debug_survives_an_unknown_provider(engine, http, mock, clock, llm):
    """Fournisseur retiré de providers.toml après l'analyse : un succès du cache reste un
    succès (limite globale des photos, prompt système brut), jamais un 502."""
    for url in IMAGE_URLS:
        mock.get(url).respond(200, content=_png(), headers={"content-type": "image/png"})
    superuser = await _user(engine, role="superuser", plan=None)
    scan = _scan(images=IMAGE_URLS)
    await _scan_once(engine, superuser, scan, llm, http, clock)
    clock.advance(seconds=1)

    def unknown(provider: str):
        raise ProviderError(f"fournisseur inconnu : {provider}")

    cached = await run_scan(
        engine=engine,
        user=superuser,
        privileges=privileges_of(superuser, TEST_SETTINGS),
        scan=scan,
        llm_for=unknown,
        http=http,
        now=clock,
        resolve=FakeResolver(),
    )

    assert cached.from_cache is True
    assert cached.debug.llm_called is False
    assert cached.debug.system_prompt == llm.calls[0]["system_prompt"]
    assert cached.debug.messages[0].content.endswith(
        "[image 1 : non téléchargée (cache)]\n[image 2 : non téléchargée (cache)]"
    )


async def test_superuser_no_cache_calls_the_llm_again_and_refreshes_in_place(
    engine, http, clock, llm
):
    superuser = await _user(engine, role="superuser", plan=None)
    first = await _scan_once(engine, superuser, _scan(), llm, http, clock)
    clock.advance(seconds=1)

    again = await _scan_once(engine, superuser, _scan(noCache=True), llm, http, clock)

    assert len(llm.calls) == 2
    assert again.analysis_id == first.analysis_id  # rafraîchie sur place (règle R4)
    assert again.from_cache is False and again.score == 62
    assert again.analyzed_at == T0 + timedelta(seconds=1)
    assert again.debug.llm_called is True and again.debug.raw_response == '{"score": 62}'
    assert await _count(engine, Analysis) == 1
    aid = first.analysis_id
    assert await _count(engine, ScanResult, ScanResult.analysis_id == aid) == 2

    clock.advance(seconds=1)
    third = await _scan_once(engine, superuser, _scan(), llm, http, clock)
    assert len(llm.calls) == 2 and third.from_cache is True and third.score == 62


async def test_no_cache_from_a_user_is_ignored(engine, http, clock, llm):
    user = await _user(engine)
    first = await _scan_once(engine, user, _scan(), llm, http, clock)
    clock.advance(seconds=1)

    second = await _scan_once(engine, user, _scan(noCache=True), llm, http, clock)

    assert len(llm.calls) == 1
    assert second.from_cache is True and second.analysis_id == first.analysis_id
    assert second.debug is None
    assert (first.remaining.scans, second.remaining.scans) == (2, 1)  # quota normal


@pytest.mark.parametrize("role", ["admin", "superuser"])
async def test_no_cache_is_ignored_without_debug_privileges(engine, http, clock, llm, role):
    # Admin partout, et superuser en production : pas de relance sans cache.
    user = await _user(engine, role=role)
    for _ in range(2):
        await _scan_once(
            engine, user, _scan(noCache=True), llm, http, clock, settings=PRODUCTION_SETTINGS
        )
        clock.advance(seconds=1)
    assert len(llm.calls) == 1


async def test_superuser_scan_is_logged_with_its_debug_block(engine, http, clock, llm, debug_log):
    superuser = await _user(engine, role="superuser", plan=None)
    result = await _scan_once(engine, superuser, _scan(), llm, http, clock)

    [record] = _debug_records(debug_log)
    assert record.levelno == logging.INFO
    header, _, body = record.getMessage().partition("\n")
    assert header == "[debug superuser] scan full 2dehands.be|m123"
    assert json.loads(body) == result.model_dump(mode="json", by_alias=True)["debug"]
    assert body.startswith("{\n  ")  # JSON indenté, lisible dans la console


async def test_user_scan_is_not_logged(engine, http, clock, llm, debug_log):
    user = await _user(engine)
    await _scan_once(engine, user, _scan(), llm, http, clock)
    await _scan_once(engine, user, _scan(noCache=True), llm, http, clock)
    assert _debug_records(debug_log) == []


async def test_debug_block_and_log_contain_no_secret(engine, http, mock, clock, debug_log):
    caplog = debug_log
    caplog.set_level(logging.DEBUG)
    for url in IMAGE_URLS:
        mock.get(url).respond(200, content=_png(), headers={"content-type": "image/png"})
    llm_route = mock.post(f"{LLM_BASE}/chat/completions").respond(
        200,
        json={
            "id": "c1",
            "object": "chat.completion",
            "created": 1,
            "model": "m",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": json.dumps(
                            {
                                "score": 70,
                                "summary": {"fr": "Résumé", "nl": "Samenvatting"},
                                "advice": {"fr": "Conseil", "nl": "Advies"},
                                "reasons": [],
                            }
                        ),
                    },
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        },
    )
    provider = ProviderConfig(
        code="fake",
        base_url=LLM_BASE,
        api_key_env="FAKE_LLM_KEY",
        base_url_env=None,
        structured_output="json_object",
        cost_source="none",
        extra_body={},
    )
    # Client HTTP explicite (comme dans test_llm_client) : intercepté par respx.
    client = OpenAICompatibleClient(
        provider, {"FAKE_LLM_KEY": SECRET_KEY}, http_client=httpx.AsyncClient()
    )

    class Provider:
        def llm_for(self, code: str) -> OpenAICompatibleClient:
            return client

    superuser = await _user(engine, role="superuser", plan=None)
    try:
        result = await _scan_once(
            engine, superuser, _scan(images=IMAGE_URLS), Provider(), http, clock
        )
    finally:
        await client.aclose()

    # Le fournisseur a bien reçu la clé et les photos en base64…
    request = llm_route.calls.last.request
    assert request.headers["authorization"] == f"Bearer {SECRET_KEY}"
    assert b"base64," in request.content
    # … mais ni la réponse ni les logs ne les contiennent.
    assert result.debug is not None and result.debug.llm_called is True
    assert result.debug.system_prompt.startswith("Tu aides")
    assert "Schéma JSON exact" in result.debug.system_prompt
    payload = result.model_dump_json(by_alias=True)
    assert _debug_records(caplog)
    for secret in (SECRET_KEY, "Bearer", "base64,"):
        assert secret not in payload
        assert secret not in caplog.text


async def test_debug_block_summarizes_images_through_the_responses_api(engine, http, mock, clock):
    # Fournisseur en API Responses (openai-oauth) : le bloc debug résume toujours les messages
    # au format Chat, avant leur conversion en `input_image`.
    for url in IMAGE_URLS:
        mock.get(url).respond(200, content=_png(), headers={"content-type": "image/png"})
    analysis = {
        "score": 70,
        "summary": {"fr": "Résumé", "nl": "Samenvatting"},
        "advice": {"fr": "Conseil", "nl": "Advies"},
        "reasons": [],
    }
    llm_route = mock.post(f"{LLM_BASE}/responses").respond(
        200,
        json={
            "id": "resp_1",
            "object": "response",
            "created_at": 1,
            "model": "m",
            "status": "completed",
            "parallel_tool_calls": False,
            "tool_choice": "auto",
            "tools": [],
            "output": [
                {
                    "type": "message",
                    "id": "msg_1",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {"type": "output_text", "text": json.dumps(analysis), "annotations": []}
                    ],
                }
            ],
            "usage": {"input_tokens": 74, "output_tokens": 45, "total_tokens": 119},
        },
    )
    provider = ProviderConfig(
        code="fake",
        base_url=LLM_BASE,
        api_key_env=None,
        base_url_env=None,
        structured_output="json_object",
        cost_source="none",
        extra_body={},
        omit_params=("temperature",),
        api="responses",
    )
    client = OpenAICompatibleClient(provider, {}, http_client=httpx.AsyncClient(trust_env=False))

    class Provider:
        def llm_for(self, code: str) -> OpenAICompatibleClient:
            return client

    superuser = await _user(engine, role="superuser", plan=None)
    try:
        result = await _scan_once(
            engine, superuser, _scan(images=IMAGE_URLS), Provider(), http, clock
        )
    finally:
        await client.aclose()

    parts = json.loads(llm_route.calls.last.request.content)["input"][0]["content"]
    assert [p["type"] for p in parts] == ["input_text", "input_image", "input_image"]
    sizes = [_b64_size(p["image_url"].split("base64,", 1)[1]) for p in parts[1:]]
    assert result.debug is not None and result.debug.llm_called is True
    assert result.debug.messages[0].content == "\n".join(
        [parts[0]["text"], f"[image 1 : {sizes[0]} octets]", f"[image 2 : {sizes[1]} octets]"]
    )
    assert result.debug.raw_response == json.dumps(analysis)
    assert "Schéma JSON exact" in result.debug.system_prompt
    assert "base64," not in result.model_dump_json(by_alias=True)
