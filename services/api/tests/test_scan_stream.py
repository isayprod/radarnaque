"""Route en flux `POST /api/scans/stream` (SSE, spec §8.3) et `stream_scan`.

Le transport ASGI de httpx attend la fin de la réponse avant de la rendre : `_StreamingASGI`
rend le corps au fil de l'eau et signale la déconnexion (`http.disconnect`) quand le client
ferme le flux, comme uvicorn."""

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import ClientDisconnect

from radarnaque_api.llm.client import Bilingual, LLMAnalysis, LLMError, LLMReason, LLMResult
from radarnaque_api.llm.events import EventSink, SearchDone, SearchStarted, Thinking, Writing
from radarnaque_api.llm.tools import WebSearchTool
from radarnaque_api.schemas import (
    AnalysisResultOut,
    LocalizedTextOut,
    RemainingOut,
)
from radarnaque_api.search import SearchHit
from radarnaque_api.services import scan_stream
from radarnaque_api.services import scans as scans_service
from radarnaque_api.services.scan_stream import Stage, encode_sse, sse_of, stream_scan

HITS = [
    SearchHit(title="iPhone 18 Pro", url="https://www.apple.com/be-fr/iphone", snippet="Prix"),
    SearchHit(title="Comparatif", url="https://exemple.be/iphone-18-pro", snippet="1 329 €"),
]
IMAGES = ["https://images.2dehands.com/api/a.jpg", "https://images.2dehands.com/api/b.jpg"]


# --- Transport ASGI en flux ----------------------------------------------------------------


class _Body(httpx.AsyncByteStream):
    def __init__(
        self, chunks: asyncio.Queue[bytes | None], gone: asyncio.Event, task: asyncio.Task
    ) -> None:
        self._chunks = chunks
        self._gone = gone
        self._task = task

    async def __aiter__(self) -> AsyncIterator[bytes]:
        while (chunk := await self._chunks.get()) is not None:
            yield chunk

    async def aclose(self) -> None:
        self._gone.set()  # le client part : `receive` rend `http.disconnect`
        await asyncio.wait([self._task], timeout=5)


class _StreamingASGI(httpx.AsyncBaseTransport):
    def __init__(
        self, app: FastAPI, *, gone_at_start: bool = False, spec_version: str = "2.3"
    ) -> None:
        self._app = app
        self._gone_at_start = gone_at_start  # client déjà parti quand la réponse commence
        # Version d'ASGI annoncée (uvicorn 0.54 : 2.3). En 2.4, le serveur ne signale plus la
        # déconnexion par `receive` : c'est `send` qui lève `OSError` (client parti).
        self._spec_version = spec_version

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = b"".join([part async for part in request.stream])  # type: ignore[union-attr]
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": self._spec_version},
            "http_version": "1.1",
            "method": request.method,
            "headers": [(k.lower(), v) for k, v in request.headers.raw],
            "scheme": request.url.scheme,
            "path": request.url.path,
            "raw_path": request.url.raw_path.split(b"?")[0],
            "query_string": request.url.query,
            "server": (request.url.host, request.url.port),
            "client": ("127.0.0.1", 123),
            "root_path": "",
        }
        chunks: asyncio.Queue[bytes | None] = asyncio.Queue()
        gone = asyncio.Event()
        if self._gone_at_start:
            gone.set()
        start: asyncio.Future[dict] = asyncio.get_running_loop().create_future()
        delivered = False

        async def receive() -> dict:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            await gone.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            if message["type"] == "http.response.start":
                start.set_result(message)
                if self._gone_at_start:
                    if self._spec_version == "2.4":
                        raise OSError("client parti")
                    await asyncio.sleep(0)  # point d'annulation avant le premier événement
            elif message["type"] == "http.response.body":
                chunks.put_nowait(message.get("body", b""))
                if not message.get("more_body", False):
                    chunks.put_nowait(None)

        async def run() -> None:
            try:
                await self._app(scope, receive, send)
            except ClientDisconnect:
                pass  # ASGI 2.4 : client parti, ignoré comme par le serveur
            finally:
                chunks.put_nowait(None)
                if not start.done():
                    start.set_exception(RuntimeError("aucune réponse"))

        task = asyncio.create_task(run())
        message = await start
        return httpx.Response(
            message["status"], headers=message["headers"], stream=_Body(chunks, gone, task)
        )


@pytest_asyncio.fixture
async def stream_client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=_StreamingASGI(app), base_url="http://test") as c:
        yield c


# --- Faux LLM, faux moteur de recherche --------------------------------------------------------


class FakeBackend:
    def __init__(self) -> None:
        self.queries: list[str] = []

    async def search(self, query: str) -> list[SearchHit]:
        self.queries.append(query)
        return list(HITS)


class FakeLLM:
    """Joue `Thinking`, une recherche (par l'outil reçu), puis `Writing`."""

    def __init__(self) -> None:
        self.calls = 0
        self.error: Exception | None = None
        self.delay = 0.0
        self.block: asyncio.Event | None = None  # jamais libéré : seule l'annulation en sort
        self.thinking: list[Thinking] = [Thinking(0, "Je regarde le prix.")]

    def llm_for(self, provider: str) -> "FakeLLM":
        return self

    async def analyze(
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict],
        tools: WebSearchTool | None = None,
        on_event: EventSink | None = None,
    ) -> LLMResult:
        self.calls += 1

        async def emit(event) -> None:  # `POST /api/scans` : aucun récepteur
            if on_event is not None:
                await on_event(event)

        if self.block is not None:
            await self.block.wait()
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        for event in self.thinking:
            await emit(event)
        if tools is not None:
            await tools.run(json.dumps({"query": "iphone 18 pro prix", "aspect": "price"}))
        await emit(Writing())
        return LLMResult(
            analysis=LLMAnalysis(
                score=70,
                summary=Bilingual(fr="Résumé", nl="Samenvatting"),
                advice=Bilingual(fr="Conseil", nl="Advies"),
                reasons=[LLMReason(severity="danger", fr="Raison", nl="Reden")],
            ),
            tokens_in=100,
            tokens_out=10,
            cost_usd_micros=42,
            searches=tools.records if tools else [],
            search_traces=tools.traces if tools else [],
            reasoning_text="Je regarde le prix.",
            rounds=2,
        )


@pytest.fixture
def llm(app: FastAPI) -> FakeLLM:
    fake = FakeLLM()
    app.state.llm_for = fake.llm_for
    return fake


@pytest.fixture
def backend(app: FastAPI) -> FakeBackend:
    fake = FakeBackend()
    app.state.search = fake
    return fake


@pytest.fixture
def photos(monkeypatch: pytest.MonkeyPatch) -> None:
    """Photos « téléchargées » sans réseau : une donnée base64 factice par photo demandée."""

    async def fake_fetch(urls, suffixes, *, http, resolve, limit):
        return ["aW1n"] * min(limit, len(urls))

    monkeypatch.setattr(scans_service, "fetch_images", fake_fetch)


@pytest.fixture
async def user(
    make_user: Callable[..., Awaitable[str]], db: AsyncSession
) -> Callable[[], Awaitable[str]]:
    """Crée un utilisateur avec un essai actif (3 scans) et renvoie son identifiant."""

    async def _make() -> str:
        uid = await make_user(f"{uuid4().hex}@b.test")
        await db.execute(
            text(
                "insert into app.subscriptions(user_id, plan, status, provider, period_start)"
                " values (:uid, 'trial', 'active', 'manual', now() - interval '1 day')"
            ),
            {"uid": uid},
        )
        await db.commit()
        return uid

    return _make


def _body(external_id: str = "m123", images: list[str] | None = None) -> dict:
    return {
        "listing": {
            "site": "2dehands.be",
            "externalId": external_id,
            "url": f"https://www.2dehands.be/v/a/{external_id}",
            "title": "iPhone 18 Pro",
            "description": "Comme neuf.",
            "price": {"amountCents": 40000, "currency": "EUR"},
            "priceType": "fixed",
            "location": {"city": "Gent"},
            "images": images or [],
            "seller": {"reviewCount": 0},
        },
        "rules": {"version": 1, "signals": []},
        "trigger": "button",
    }


def _parse(raw: str) -> list[tuple[str, object]]:
    """Événements SSE (`(nom, données)`) et commentaires (`(":", texte)`), dans l'ordre."""
    out: list[tuple[str, object]] = []
    for block in raw.split("\n\n"):
        if not block:
            continue
        if block.startswith(":"):
            out.append((":", block[1:].strip()))
            continue
        lines = dict(line.split(": ", 1) for line in block.split("\n"))
        out.append((lines["event"], json.loads(lines["data"])))
    return out


async def _stream(client: httpx.AsyncClient, headers: dict, body: dict) -> list[tuple[str, object]]:
    async with client.stream("POST", "/api/scans/stream", json=body, headers=headers) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        raw = "".join([chunk async for chunk in r.aiter_text()])
    return _parse(raw)


async def _wait_failures(db: AsyncSession, uid: str) -> list[str]:
    """Échecs enregistrés, attendus 5 s au plus : après une déconnexion, le scan est rendu par
    la tâche annulée, qui finit sans attendre le client."""
    for _ in range(100):
        if found := await _failures(db, uid):
            return found
        await asyncio.sleep(0.05)
    return []


def _names(events: list[tuple[str, object]]) -> list[str]:
    return [
        f"stage {data['stage']}" if name == "stage" else name  # type: ignore[index]
        for name, data in events
        if name != ":"
    ]


async def _failures(db: AsyncSession, uid: str) -> list[str]:
    rows = await db.execute(
        text(
            "select f.error_code from app.scan_failures f"
            " join app.scan_events e on e.id = f.scan_event_id where e.user_id = :uid"
        ),
        {"uid": uid},
    )
    await db.commit()  # nouvelle image de la base à la prochaine lecture
    return list(rows.scalars())


# --- Route en flux -----------------------------------------------------------------------


async def test_stream_event_order(stream_client, bearer, user, llm, backend, photos):
    uid = await user()

    events = await _stream(stream_client, bearer(uid), _body(images=IMAGES))

    assert _names(events) == [
        "stage photos",
        "stage analyzing",
        "thinking",
        "search",
        "search_done",
        "stage writing",
        "result",
    ]
    data = [d for _, d in events]
    assert data[0] == {"stage": "photos", "count": 2}
    assert data[1] == {"stage": "analyzing", "count": 2}
    assert data[2] == {"part": 0, "text": "Je regarde le prix."}
    assert data[3] == {"id": 1, "query": "iphone 18 pro prix", "aspect": "price"}
    assert data[4] == {
        "id": 1,
        "ok": True,
        "count": 2,
        "domains": ["apple.com", "exemple.be"],
    }
    assert data[5] == {"stage": "writing"}
    result = data[6]
    assert result["webSearches"] == [{"query": "iphone 18 pro prix", "aspect": "price"}]  # type: ignore[index]
    assert result["imagesAnalyzed"] == 2 and result["remaining"] == {"scans": 2}  # type: ignore[index]
    assert backend.queries == ["iphone 18 pro prix"]


async def test_stream_without_photos_has_no_photos_stage(stream_client, bearer, user, llm):
    uid = await user()  # SEARCH_BACKEND=none (tests) : aucun outil proposé au modèle

    events = await _stream(stream_client, bearer(uid), _body())

    assert _names(events) == ["stage analyzing", "thinking", "stage writing", "result"]
    assert events[0][1] == {"stage": "analyzing", "count": 0}


async def test_refusal_before_stream_is_json(stream_client, client, bearer, user, llm):
    uid = await user()
    for n in range(3):  # l'essai compte 3 scans
        done = await client.post("/api/scans", json=_body(f"m{n}"), headers=bearer(uid))
        assert done.status_code == 200

    r = await stream_client.post("/api/scans/stream", json=_body("m9"), headers=bearer(uid))

    assert r.status_code == 402
    assert r.headers["content-type"] == "application/json"
    assert r.json()["error"]["code"] == "quota_exhausted"


async def test_stream_requires_jwt(stream_client, llm):
    r = await stream_client.post("/api/scans/stream", json=_body())
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"


async def test_stream_invalid_body_is_invalid_listing(stream_client, bearer, user, llm, db):
    uid = await user()
    body = _body()
    body["listing"]["seller"] = {"reviewCount": 0, "name": "Jan"}

    r = await stream_client.post("/api/scans/stream", json=body, headers=bearer(uid))

    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_listing"
    assert r.json()["error"]["details"]["field"] == "listing.seller.name"
    assert llm.calls == 0


async def test_cache_hit_stage_cache(stream_client, bearer, user, llm):
    uid = await user()
    await _stream(stream_client, bearer(uid), _body())

    events = await _stream(stream_client, bearer(uid), _body())

    assert _names(events) == ["stage cache", "result"]
    assert events[0][1] == {"stage": "cache"}
    assert events[1][1]["fromCache"] is True  # type: ignore[index]
    assert llm.calls == 1


async def test_failure_event_and_give_back(stream_client, client, bearer, user, llm, db):
    uid = await user()
    llm.error = LLMError("transport", "fake")

    events = await _stream(stream_client, bearer(uid), _body())

    assert _names(events) == ["stage analyzing", "error"]
    error = events[-1][1]
    assert error["code"] == "analysis_failed"  # type: ignore[index]
    assert error["details"] == {"reason": "transport"}  # type: ignore[index]
    assert "fake" not in json.dumps(error)
    assert await _failures(db, uid) == ["transport"]
    llm.error = None
    again = await client.post("/api/scans", json=_body("m2"), headers=bearer(uid))
    assert again.json()["remaining"] == {"scans": 2}  # le scan en échec a été rendu


async def test_disconnect_gives_back(stream_client, bearer, user, llm, db):
    uid = await user()
    llm.block = asyncio.Event()

    async with stream_client.stream(
        "POST", "/api/scans/stream", json=_body(), headers=bearer(uid)
    ) as r:
        async for chunk in r.aiter_text():
            if "analyzing" in chunk:
                break
    assert llm.calls == 1
    assert await _wait_failures(db, uid) == ["internal"]


async def test_total_timeout(stream_client, app, bearer, user, llm, db):
    uid = await user()
    app.state.analysis_timeout_s = 0.1
    llm.delay = 2

    events = await _stream(stream_client, bearer(uid), _body())

    assert _names(events) == ["stage analyzing", "error"]
    assert events[-1][1]["code"] == "analysis_failed"  # type: ignore[index]
    assert events[-1][1]["details"] == {"reason": "timeout"}  # type: ignore[index]
    assert await _failures(db, uid) == ["timeout"]


async def test_concurrent_same_listing_second_from_cache(stream_client, bearer, user, llm):
    uid = await user()
    llm.delay = 0.3

    first, second = await asyncio.gather(
        _stream(stream_client, bearer(uid), _body()), _stream(stream_client, bearer(uid), _body())
    )

    assert llm.calls == 1
    assert first[-1][0] == "result" and second[-1][0] == "result"
    assert sorted([_names(first)[0], _names(second)[0]]) == ["stage analyzing", "stage cache"]


async def test_superuser_debug_has_rounds_searches_and_reasoning(
    stream_client, bearer, make_user, llm, backend
):
    uid = await make_user("superuser@radarnaque.test", role="superuser")

    events = await _stream(stream_client, bearer(uid), _body())

    debug = events[-1][1]["debug"]  # type: ignore[index]
    assert debug["rounds"] == 2
    assert debug["reasoning"] == "Je regarde le prix."
    [search] = debug["searches"]
    assert (search["query"], search["aspect"]) == ("iphone 18 pro prix", "price")
    assert search["ok"] is True
    assert "<resultats_recherche>" in search["output"] and search["ms"] >= 0
    assert debug["timingsMs"]["search"] == search["ms"]


# --- stream_scan ---------------------------------------------------------------------------


def _result() -> AnalysisResultOut:
    text_ = LocalizedTextOut(fr="a", nl="b")
    return AnalysisResultOut(
        analysis_id=1,
        score=10,
        level="low",
        partial=False,
        professional=False,
        from_cache=False,
        summary=text_,
        advice=text_,
        reasons=[],
        images_analyzed=0,
        web_searches=[],
        analyzed_at="2026-10-19T10:00:00Z",  # type: ignore[arg-type]
        remaining=RemainingOut(scans=None),
    )


async def _collect(stream: AsyncIterator[str]) -> list[tuple[str, object]]:
    return _parse("".join([chunk async for chunk in stream]))


async def test_ping_when_idle():
    async def admitted(sink):
        await asyncio.sleep(0.2)
        return _result()

    events = await _collect(stream_scan(admitted, ping_s=0.05))

    assert (":", "ping") in events
    assert events[-1][0] == "result"


async def test_thinking_throttled():
    async def admitted(sink):
        for n in range(1, 6):
            await sink(Thinking(0, "abcde"[:n]))
            await asyncio.sleep(0.002)
        return _result()

    events = await _collect(stream_scan(admitted, throttle_s=0.3))

    thinking = [data for name, data in events if name == "thinking"]
    assert 1 <= len(thinking) <= 2
    assert thinking[-1] == {"part": 0, "text": "abcde"}
    assert events[-1][0] == "result"


async def test_other_event_flushes_pending_thinking_first():
    async def admitted(sink):
        await sink(Thinking(0, "a"))
        await sink(Thinking(0, "ab"))  # en attente (moins de 300 ms après le premier)
        await sink(Thinking(1, "x"))  # autre partie : « ab » part d'abord
        await sink(Thinking(1, "xy"))
        await sink(SearchStarted(1, "prix", "price"))  # « xy » part avant la recherche
        return _result()

    events = await _collect(stream_scan(admitted, throttle_s=10))

    assert [(name, data) for name, data in events if name != "result"] == [
        ("thinking", {"part": 0, "text": "a"}),
        ("thinking", {"part": 0, "text": "ab"}),
        ("thinking", {"part": 1, "text": "x"}),
        ("thinking", {"part": 1, "text": "xy"}),
        ("search", {"id": 1, "query": "prix", "aspect": "price"}),
    ]


async def test_pending_thinking_sent_after_throttle_delay():
    gate = asyncio.Event()

    async def admitted(sink):
        await sink(Thinking(0, "a"))
        await sink(Thinking(0, "ab"))
        await gate.wait()
        return _result()

    stream = stream_scan(admitted, throttle_s=0.05)
    assert await anext(stream) == encode_sse("thinking", {"part": 0, "text": "a"})
    assert await anext(stream) == encode_sse("thinking", {"part": 0, "text": "ab"})
    gate.set()
    assert (await anext(stream)).startswith("event: result\n")
    await stream.aclose()


async def test_unexpected_error_message_stays_neutral():
    """Erreur inattendue : on ne sait pas si le scan a été rendu (erreur après l'enregistrement
    du résultat, ou remboursement en échec) ; le message ne le promet donc pas."""

    async def admitted(sink):
        raise RuntimeError("bogue")

    events = await _collect(stream_scan(admitted))

    assert events == [
        (
            "error",
            {
                "code": "analysis_failed",
                "message": "L'analyse a échoué.",
                "details": {"reason": "internal"},
            },
        )
    ]


async def test_analysis_task_is_strongly_referenced_until_done():
    gate = asyncio.Event()

    async def admitted(sink):
        await sink(Stage("analyzing", 0))
        await gate.wait()
        return _result()

    stream = stream_scan(admitted)
    await anext(stream)
    [task] = [t for t in scan_stream._TASKS if not t.done()]  # tenue hors du générateur
    gate.set()
    assert (await anext(stream)).startswith("event: result\n")
    await stream.aclose()
    assert task.done() and task not in scan_stream._TASKS


async def test_closing_the_stream_cancels_the_analysis():
    cancelled = asyncio.Event()

    async def admitted(sink):
        await sink(Stage("analyzing", 0))
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return _result()

    stream = stream_scan(admitted)
    assert await anext(stream) == encode_sse("stage", {"stage": "analyzing", "count": 0})
    await stream.aclose()
    assert cancelled.is_set()


def test_encode_and_sse_of():
    assert encode_sse("search", {"q": "é €"}) == 'event: search\ndata: {"q":"é €"}\n\n'
    assert sse_of(Writing()) == 'event: stage\ndata: {"stage":"writing"}\n\n'
    assert sse_of(Stage("cache")) == 'event: stage\ndata: {"stage":"cache"}\n\n'
    assert sse_of(SearchDone(2, False, 0, ())) == (
        'event: search_done\ndata: {"id":2,"ok":false,"count":0,"domains":[]}\n\n'
    )


@pytest.mark.parametrize("spec_version", ["2.3", "2.4"])
async def test_client_gone_before_the_stream_gives_back(
    app, bearer, user, llm, db, spec_version, monkeypatch: pytest.MonkeyPatch
):
    """Client parti pendant l'admission : la déconnexion arrive avant que le flux ne
    démarre (le générateur ne tourne jamais) ; le scan est rendu après la réponse, une seule
    fois, quelle que soit la version d'ASGI (Starlette n'exécute `background` qu'en 2.3)."""
    record, given_back = scans_service._record_failure, []

    async def counted(*args, **kwargs) -> None:
        given_back.append(args[1])  # identifiant de l'événement rendu
        await record(*args, **kwargs)

    monkeypatch.setattr(scans_service, "_record_failure", counted)
    uid = await user()
    transport = _StreamingASGI(app, gone_at_start=True, spec_version=spec_version)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        async with client.stream(
            "POST", "/api/scans/stream", json=_body(), headers=bearer(uid)
        ) as r:
            assert r.status_code == 200
            assert [chunk async for chunk in r.aiter_bytes()] == []
    assert llm.calls == 0
    assert await _wait_failures(db, uid) == ["internal"]
    assert len(given_back) == 1
