"""Routes de l'identification : `POST /api/identify` et `POST /api/identify/stream` (spec §6)."""

from collections.abc import Awaitable, Callable
from uuid import uuid4

import pytest
from fake_llm import FakeLLM
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from test_identify_pipeline import identify_out as _identify_out
from test_identify_pipeline import read_out
from test_scan_stream import _parse

from radarnaque_api.identify.schemas import SCHEMA_IDENTIFY, SCHEMA_READ_PHOTOS
from radarnaque_api.llm.client import LLMError


@pytest.fixture
def llm(app: FastAPI) -> FakeLLM:
    fake = FakeLLM()
    fake.step_outputs = {SCHEMA_READ_PHOTOS: read_out(), SCHEMA_IDENTIFY: _identify_out()}
    app.state.llm_for = fake.llm_for
    return fake


@pytest.fixture
async def user(
    make_user: Callable[..., Awaitable[str]], db: AsyncSession
) -> Callable[..., Awaitable[str]]:
    """Crée un utilisateur, avec un essai actif (3 scans) par défaut."""

    async def _make(*, plan: str | None = "trial") -> str:
        uid = await make_user(f"{uuid4().hex}@b.test")
        if plan is not None:
            await db.execute(
                text(
                    "insert into app.subscriptions(user_id, plan, status, provider, period_start)"
                    " values (:uid, :plan, 'active', 'manual', now() - interval '1 day')"
                ),
                {"uid": uid, "plan": plan},
            )
            await db.commit()
        return uid

    return _make


def _body(external_id: str = "m1", **listing: object) -> dict:
    body: dict = {
        "listing": {
            "site": "2dehands.be",
            "externalId": external_id,
            "url": f"https://www.2dehands.be/v/a/{external_id}",
            "title": "Steam Deck OLED 512 Go",
            "description": "Très bon état",
            "price": {"amountCents": 40000, "currency": "EUR"},
            "priceType": "fixed",
            "location": {"city": "Gent"},
            "images": [],
            "seller": {"reviewCount": 0},
        },
        "rules": {"version": 1, "signals": []},
        "trigger": "button",
    }
    body["listing"].update(listing)
    return body


def _schemas(llm: FakeLLM) -> list[str]:
    return [c["schema_name"] for c in llm.step_calls]


async def _rows(db: AsyncSession, sql: str, **params) -> list[tuple]:
    await db.rollback()  # relire l'état validé
    return [tuple(r) for r in (await db.execute(text(sql), params)).all()]


async def _events_of(db: AsyncSession, uid: str) -> list[tuple]:
    return await _rows(
        db,
        "select e.purpose, r.identification_id is not null, f.error_code"
        " from app.scan_events e"
        " left join app.identification_results r on r.scan_event_id = e.id"
        " left join app.scan_failures f on f.scan_event_id = e.id"
        " where e.user_id = :u order by e.id",
        u=uid,
    )


async def test_identify_route_returns_identification_and_consumes_one(
    client, bearer, user, llm, db
):
    uid = await user()

    r = await client.post("/api/identify", json=_body(), headers=bearer(uid))

    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/json"
    data = r.json()
    assert {"identificationId", "status", "confidence", "level", "objects", "searches"} <= set(data)
    assert data["fromCache"] is False and data["remaining"] == {"scans": 2}
    assert "debug" in data and data["debug"] is None
    # Annonce sans photo et sans moteur de recherche : ni critères ni photo vérifiée.
    assert _schemas(llm) == [SCHEMA_READ_PHOTOS, SCHEMA_IDENTIFY]
    assert data["objects"][0]["reference"] == "Steam Deck OLED"
    assert llm.calls == []  # aucune analyse de l'arnaque
    assert await _events_of(db, uid) == [("identify", True, None)]


async def test_identify_stream_emits_stages_then_identification_then_result(
    client, bearer, user, llm
):
    uid = await user()

    async with client.stream(
        "POST", "/api/identify/stream", json=_body(), headers=bearer(uid)
    ) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        raw = "".join([chunk async for chunk in r.aiter_text()])
    events = [(name, data) for name, data in _parse(raw) if name != ":"]

    names = [f"stage {d['stage']}" if n == "stage" else n for n, d in events]  # type: ignore[index]
    # Étapes du pipeline (recherches comprises, ici sans moteur), puis le résultat, deux fois.
    assert names[0] == "stage reading_photos" and names[-2:] == ["identification", "result"]
    assert [n for n in names if n.startswith("stage")] == [
        "stage reading_photos",
        "stage criteria",
        "stage identifying",
    ]
    assert {"search", "search_done"} <= set(names) and "error" not in names
    identification, result = events[-2][1], events[-1][1]
    # `identification` omet un `debug` nul (événement du flux), `result` le garde (réponse).
    assert {k: v for k, v in result.items() if k != "debug"} == identification  # type: ignore[union-attr]
    assert result["remaining"] == {"scans": 2}  # type: ignore[index]


async def _exhaust(db: AsyncSession, uid: str, count: int, minutes_ago: int = 5) -> None:
    for _ in range(count):
        await db.execute(
            text(
                "insert into app.scan_events(user_id, scan_kind, trigger, purpose, created_at)"
                " values (:u, 'full', 'button', 'identify',"
                f" now() - interval '{minutes_ago} minutes')"
            ),
            {"u": uid},
        )
    await db.commit()


@pytest.mark.parametrize("path", ["/api/identify", "/api/identify/stream"])
async def test_identify_refusals_are_json(client, bearer, user, llm, db, path):
    async def refusal(uid: str, body: dict) -> tuple[int, str]:
        r = await client.post(path, json=body, headers=bearer(uid))
        assert r.headers["content-type"] == "application/json"
        return r.status_code, r.json()["error"]["code"]

    assert await refusal(await user(plan=None), _body()) == (402, "no_active_subscription")
    exhausted = await user()
    await _exhaust(db, exhausted, 3)
    assert await refusal(exhausted, _body()) == (402, "quota_exhausted")
    assert await refusal(await user(), _body(seller={"name": "Jan"})) == (422, "invalid_listing")
    limit = (await _rows(db, "select rate_limit_per_minute from app.settings"))[0][0]
    busy = await user(plan="premium")
    await _exhaust(db, busy, limit, minutes_ago=0)
    assert await refusal(busy, _body()) == (429, "rate_limited")
    assert _schemas(llm) == []


async def test_identify_failure_gives_back_with_reason(client, bearer, user, llm, db):
    uid = await user()
    llm.step_errors[SCHEMA_READ_PHOTOS] = LLMError("transport")

    r = await client.post("/api/identify", json=_body(), headers=bearer(uid))

    assert r.status_code == 502
    error = r.json()["error"]
    assert error["code"] == "analysis_failed"
    assert error["details"] == {"reason": "identify_read_photos"}
    assert await _events_of(db, uid) == [("identify", False, "identify_read_photos")]
    llm.step_errors.clear()
    again = await client.post("/api/identify", json=_body(), headers=bearer(uid))
    assert again.json()["remaining"] == {"scans": 2}  # l'échec n'a rien coûté


async def test_identify_resolve_failure_has_its_code(client, bearer, user, llm, db):
    uid = await user()
    llm.step_errors[SCHEMA_IDENTIFY] = LLMError("invalid_response")

    r = await client.post("/api/identify", json=_body(), headers=bearer(uid))

    assert (r.status_code, r.json()["error"]["details"]) == (502, {"reason": "identify_resolve"})
    assert await _events_of(db, uid) == [("identify", False, "identify_resolve")]


async def test_identify_timeout_gives_back(client, app, bearer, user, llm, db):
    uid = await user()
    app.state.identify_timeout_s = 0.1
    llm.delay = 2

    r = await client.post("/api/identify", json=_body(), headers=bearer(uid))

    assert r.status_code == 502
    assert r.json()["error"]["details"] == {"reason": "timeout"}
    assert await _events_of(db, uid) == [("identify", False, "timeout")]


async def test_identify_served_from_cache_for_second_user(client, bearer, user, llm, db):
    first, second = await user(), await user()
    one = await client.post("/api/identify", json=_body(), headers=bearer(first))
    assert one.status_code == 200, one.text
    calls = len(llm.step_calls)

    two = await client.post("/api/identify", json=_body(), headers=bearer(second))

    assert two.status_code == 200, two.text
    assert len(llm.step_calls) == calls  # aucun appel au modèle
    data = two.json()
    assert data["fromCache"] is True
    assert data["identificationId"] == one.json()["identificationId"]
    assert data["remaining"] == {"scans": 2}  # décompté, même servi par le cache
    assert await _events_of(db, second) == [("identify", True, None)]


async def test_identify_is_in_the_history_with_its_listing(client, bearer, user, llm):
    uid = await user()
    assert (await client.post("/api/identify", json=_body(), headers=bearer(uid))).is_success
    llm.step_errors[SCHEMA_READ_PHOTOS] = LLMError("transport")
    await client.post("/api/identify", json=_body("m2"), headers=bearer(uid))

    items = (await client.get("/api/scans/history", headers=bearer(uid))).json()["items"]

    failed, done = items
    assert (done["purpose"], done["site"], done["title"]) == (
        "identify",
        "2dehands.be",
        "Steam Deck OLED 512 Go",
    )
    assert (done["failed"], done["fromCache"], done["score"], done["level"]) == (
        False,
        False,
        None,
        None,
    )
    assert (failed["purpose"], failed["failed"], failed["site"]) == ("identify", True, None)
