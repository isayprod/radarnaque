"""Une ligne `llm_calls` par appel au modèle qui produit une analyse (insertion ou
rafraîchissement), aucune pour un scan servi par le cache ni pour un appel en échec."""

from datetime import timedelta

import pytest
import test_scans_routes
from sqlalchemy import text

from radarnaque_api.llm.client import LLMError, LLMResult
from radarnaque_api.llm.tools import SearchRecord

FakeLLM = test_scans_routes.FakeLLM
_body = test_scans_routes._body
# Fixtures de test_scans_routes.py : le faux LLM et l'utilisateur avec un essai actif.
llm = test_scans_routes.llm
user = test_scans_routes.user


class _SearchingFake(FakeLLM):
    """Faux client dont chaque réponse annonce deux recherches web faites."""

    async def analyze(self, **kw) -> LLMResult:
        result = await super().analyze(**kw)
        result.searches = [SearchRecord("velo prix", "price"), SearchRecord("velo arnaque", "scam")]
        return result


async def _calls(db) -> list[tuple]:
    rows = await db.execute(
        text(
            "select analysis_id, model_id, prompt_version_id, tokens_in, tokens_out,"
            " cost_usd_micros, images_analyzed, web_searches, created_at"
            " from app.llm_calls order by created_at, id"
        )
    )
    return [tuple(r) for r in rows.all()]


@pytest.fixture
def searching_llm(app) -> _SearchingFake:
    fake = _SearchingFake()
    app.state.llm_for = fake.llm_for
    return fake


async def test_llm_call_written_on_new_analysis(client, bearer, user, db, searching_llm):
    uid = await user()
    r = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert r.status_code == 200, r.text
    analysis_id = r.json()["analysisId"]

    (call,) = await _calls(db)
    analysis_model = (
        await db.execute(
            text("select model_id, prompt_version_id, created_at from app.analyses where id = :a"),
            {"a": analysis_id},
        )
    ).one()
    assert call[:3] == (analysis_id, analysis_model.model_id, analysis_model.prompt_version_id)
    # Tokens et coût du LLMResult, deux recherches annoncées, aucune photo.
    assert call[3:8] == (100, 10, 42, 0, 2)
    assert call[8] == analysis_model.created_at  # date de l'événement qui l'a produite


async def test_llm_call_written_on_refresh(client, bearer, user, db, searching_llm):
    uid = await user()
    first = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert first.status_code == 200, first.text
    # L'horloge du scan n'est pas injectable : on vieillit l'analyse en base, avec un cache d'une
    # heure, pour que le scan suivant la rafraîchisse sur place.
    await db.execute(text("update app.settings set cache_ttl_hours = 1"))
    await db.execute(
        text("update app.analyses set created_at = created_at - :age"),
        {"age": timedelta(hours=2)},
    )
    await db.commit()
    try:
        second = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    finally:
        await db.execute(text("update app.settings set cache_ttl_hours = 24"))
        await db.commit()

    assert second.status_code == 200, second.text
    assert second.json()["fromCache"] is False
    assert second.json()["analysisId"] == first.json()["analysisId"]
    assert searching_llm.calls == 2
    calls = await _calls(db)
    assert len(calls) == 2
    assert calls[0][0] == calls[1][0] == first.json()["analysisId"]
    assert calls[0][8] < calls[1][8]  # deux dates distinctes, la plus récente en dernier
    assert [c[3:8] for c in calls] == [(100, 10, 42, 0, 2)] * 2


async def test_no_llm_call_on_cache_hit_or_failure(client, bearer, user, db, llm):
    uid = await user()
    first = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert first.status_code == 200, first.text
    assert len(await _calls(db)) == 1

    cached = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert cached.json()["fromCache"] is True
    assert len(await _calls(db)) == 1  # servi par le cache : rien de plus

    llm.error = LLMError("transport", "fake")
    failed = await client.post("/api/scans", json=_body(external_id="m999"), headers=bearer(uid))
    assert failed.status_code >= 400
    assert len(await _calls(db)) == 1  # appel en échec : rien de plus
