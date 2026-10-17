import asyncio
import io
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

from radarnaque_api.errors import ApiError
from radarnaque_api.llm.client import Bilingual, LLMAnalysis, LLMError, LLMReason, LLMResult
from radarnaque_api.llm.providers import ProviderError
from radarnaque_api.models import (
    Analysis,
    AnalysisReason,
    AnalysisText,
    AuthUser,
    ListingSnapshot,
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
        "scanKind": "text",
        "trigger": "button",
    }
    body["listing"].update(listing or {})
    body.update(overrides)
    return ScanIn.model_validate(body)


async def _scan_once(engine, user, scan, llm, http, clock, **kw) -> AnalysisResultOut:
    return await run_scan(
        engine=engine,
        user=user,
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
    assert llm.calls[0]["model"] == "google/gemini-2.5-flash-lite"
    assert llm.calls[0]["system_prompt"].startswith("Tu es un expert anti-arnaque")
    assert result.score == 61 and result.level == "high"
    assert result.partial is False and result.from_cache is False
    assert (result.summary.fr, result.summary.nl) == ("Résumé 1", "Samenvatting 1")
    assert (result.advice.fr, result.advice.nl) == ("Conseil 1", "Advies 1")
    assert [(r.severity, r.text.fr, r.text.nl) for r in result.reasons] == [
        ("danger", "Raison A1", "Reden A1"),
        ("info", "Raison B1", "Reden B1"),
    ]
    assert result.analyzed_at == T0
    assert result.remaining.total == 2
    assert (result.remaining.text, result.remaining.image) == (2, 2)
    assert await _remaining_total(engine, user, clock()) == 2

    analysis = await _scalar(engine, select(Analysis).where(Analysis.id == result.analysis_id))
    assert (analysis.tokens_in, analysis.tokens_out, analysis.cost_usd_micros) == (100, 10, 42)
    assert analysis.rules_version == 1 and analysis.created_at == T0
    event = await _scalar(engine, select(ScanEvent).where(ScanEvent.user_id == user.id))
    assert (event.scan_kind, event.trigger, event.created_at) == ("text", "button", T0)


async def test_same_listing_twice_is_served_from_cache_but_counts_twice(engine, http, clock, llm):
    user = await _user(engine)
    first = await _scan_once(engine, user, _scan(), llm, http, clock)
    clock.advance(seconds=1)
    second = await _scan_once(engine, user, _scan(), llm, http, clock)

    assert len(llm.calls) == 1
    assert first.from_cache is False and second.from_cache is True
    assert second.analysis_id == first.analysis_id and second.score == first.score
    assert second.analyzed_at == T0
    assert (first.remaining.total, second.remaining.total) == (2, 1)
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
    assert [r.remaining.total for r in results] == [2, 2]


async def test_concurrent_scans_with_one_remaining_scan(engine, http, clock, llm):
    user = await _user(engine)
    async with AsyncSession(engine) as session:
        for _ in range(2):
            session.add(
                ScanEvent(user_id=user.id, scan_kind="text", trigger="button", created_at=T0)
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
    assert errors[0].details == {"plan": "trial", "scanKind": "text"}
    assert successes[0].remaining.total == 0
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
            engine=engine, user=user, scan=_scan(), llm_for=llm_for, http=http, now=clock
        )
    assert (info.value.status, info.value.details) == (502, {"reason": "configuration"})
    assert (await _scalar(engine, select(ScanFailure))).error_code == "configuration"
    assert await _remaining_total(engine, user, clock()) == 3


async def test_scan_kind_without_active_prompt_is_a_configuration_failure(engine, http, clock, llm):
    user = await _user(engine)
    async with AsyncSession(engine) as session:
        previous = (
            await session.execute(
                text("select active_prompt_version_id from app.scan_kinds where code = 'text'")
            )
        ).scalar_one()
        await session.execute(
            text("update app.scan_kinds set active_prompt_version_id = null where code = 'text'")
        )
        await session.commit()
    try:
        with pytest.raises(ScanError) as info:
            await _scan_once(engine, user, _scan(), llm, http, clock)
    finally:
        async with AsyncSession(engine) as session:
            await session.execute(
                text("update app.scan_kinds set active_prompt_version_id = :p where code = 'text'"),
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
    assert result.from_cache is False and result.remaining.total == 2


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


async def test_image_scan_downloads_the_photos_and_sends_them(engine, http, mock, clock, llm):
    for url in IMAGE_URLS:
        mock.get(url).respond(200, content=_png(), headers={"content-type": "image/png"})
    user = await _user(engine)

    result = await _scan_once(
        engine, user, _scan(images=IMAGE_URLS, scanKind="image"), llm, http, clock
    )

    assert result.from_cache is False
    assert llm.calls[0]["model"] == "google/gemini-3.1-flash-lite"
    parts = llm.calls[0]["messages"][0]["content"]
    assert [p["type"] for p in parts] == ["text", "image_url", "image_url"]
    assert parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert result.remaining.image == 2


async def test_image_scan_respects_the_provider_image_limit(engine, http, mock, clock):
    routes = [
        mock.get(url).respond(200, content=_png(), headers={"content-type": "image/png"})
        for url in IMAGE_URLS
    ]
    llm = FakeLLM(max_images=1)
    user = await _user(engine)

    await _scan_once(engine, user, _scan(images=IMAGE_URLS, scanKind="image"), llm, http, clock)

    parts = llm.calls[0]["messages"][0]["content"]
    assert [p["type"] for p in parts] == ["text", "image_url"]
    assert [r.call_count for r in routes] == [1, 0]


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
            _scan(images=IMAGE_URLS[:1], scanKind="image"),
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


@pytest.mark.parametrize("overrides", [{"scanKind": "image"}, {"trigger": "card"}])
async def test_standard_plan_lacks_image_scan_and_card_icons(engine, http, clock, llm, overrides):
    user = await _user(engine, plan="standard")
    with pytest.raises(ScanError) as info:
        await _scan_once(engine, user, _scan(**overrides), llm, http, clock)
    assert (info.value.status, info.value.code) == (403, "feature_not_in_plan")
    assert await _count(engine, ScanEvent) == 0


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
        _scan(images=IMAGE_URLS[:1], scanKind="image", trigger="card"),
        llm,
        http,
        clock,
    )

    assert result.remaining.model_dump() == {"text": None, "image": None, "total": None}
    assert await _count(engine, ScanEvent, ScanEvent.user_id == admin.id) == 1


async def test_quota_exhausted_gives_402_with_plan_and_kind(engine, http, clock, llm):
    user = await _user(engine)
    for i in range(3):
        await _scan_once(engine, user, _scan(description=f"annonce {i}"), llm, http, clock)
    with pytest.raises(ScanError) as info:
        await _scan_once(engine, user, _scan(), llm, http, clock)
    assert (info.value.status, info.value.code) == (402, "quota_exhausted")
    assert info.value.details == {"plan": "trial", "scanKind": "text"}
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
                ScanEvent(user_id=admin.id, scan_kind="text", trigger="button", created_at=T0)
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
