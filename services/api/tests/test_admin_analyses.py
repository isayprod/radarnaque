"""API Analyses de l'admin (`/api/admin/analyses`) : liste filtrée et paginée, détail, et
URL de l'annonce écrite par le scan (migration 0008). Lecture seule."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
import test_scans_routes
from sqlalchemy import text

from radarnaque_api.llm.client import LLMResult
from radarnaque_api.llm.tools import SearchRecord

# Analyse seule : l'identification qui la précède a ses propres tests (test_identify_routes.py,
# test_scan_service.py).
pytestmark = pytest.mark.usefixtures("without_identification")

FakeLLM = test_scans_routes.FakeLLM
_body = test_scans_routes._body
# Fixtures de test_scans_routes.py : le faux LLM et l'utilisateur avec un essai actif.
llm = test_scans_routes.llm
user = test_scans_routes.user

ADMIN_EMAIL = "admin@radarnaque.test"
BASE = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)


class _SearchingFake(FakeLLM):
    async def analyze(self, **kw) -> LLMResult:
        result = await super().analyze(**kw)
        result.searches = [SearchRecord("velo prix", "price"), SearchRecord("velo arnaque", "scam")]
        return result


@pytest.fixture
async def admin(make_user) -> str:
    return await make_user(ADMIN_EMAIL, "admin")


@pytest.fixture
async def other_setup(db, pg_url: str) -> Iterator[tuple[int, int]]:
    """Un second modèle et une seconde version de prompt `full` (référentiels que la purge de
    `conftest.py` ne touche pas) : retirés après le test, analyses d'abord."""
    model_id = (
        await db.execute(
            text("insert into app.models(provider, slug) values ('autre', 'm-test') returning id")
        )
    ).scalar_one()
    prompt_id = (
        await db.execute(
            text(
                "insert into app.prompt_versions(scan_kind, version, system_prompt)"
                " values ('full', (select max(version) + 1 from app.prompt_versions"
                " where scan_kind = 'full'), 'prompt de test') returning id"
            )
        )
    ).scalar_one()
    await db.commit()
    yield model_id, prompt_id
    url = pg_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("truncate app.analyses cascade")
        conn.execute("delete from app.prompt_versions where id = %s", (prompt_id,))
        conn.execute("delete from app.models where id = %s", (model_id,))


async def _active(db) -> tuple[int, int]:
    """Modèle et version de prompt actifs du type `full`."""
    row = (
        await db.execute(
            text(
                "select active_model_id, active_prompt_version_id from app.scan_kinds"
                " where code = 'full'"
            )
        )
    ).one()
    return row.active_model_id, row.active_prompt_version_id


async def _make_analysis(
    db,
    *,
    ext: str,
    site: str = "2dehands.be",
    title: str = "Vélo",
    description: str = "Vélo en bon état.",
    url: str | None = None,
    price_cents: int | None = None,
    images: tuple[str, ...] = (),
    score: int = 10,
    model_id: int | None = None,
    prompt_version_id: int | None = None,
    created_at: datetime = BASE,
    partial: bool = False,
    professional: bool = False,
    images_analyzed: int = 0,
    tokens: tuple[int, int] = (100, 10),
    cost: int = 42,
    reasons: tuple[tuple[int, str, str, str], ...] = (),
    searches: tuple[tuple[int, str, str], ...] = (),
    calls: tuple[tuple[datetime, int], ...] | None = None,
) -> int:
    """Une annonce, un snapshot et une analyse, directement en base. `calls` : (date, coût en
    micro-dollars) de chaque `llm_calls` ; par défaut un appel au coût et à la date de l'analyse.
    `reasons` : (position, gravité, fr, nl) ; `searches` : (position, requête, aspect)."""
    default_model, default_prompt = await _active(db)
    model_id = model_id or default_model
    prompt_version_id = prompt_version_id or default_prompt
    listing_id = (
        await db.execute(
            text(
                "insert into app.listings(site_id, external_id, url)"
                " select id, :x, :u from app.sites where domain = :d returning id"
            ),
            {"x": ext, "u": url, "d": site},
        )
    ).scalar_one()
    snapshot_id = (
        await db.execute(
            text(
                "insert into app.listing_snapshots(listing_id, content_hash, title, description,"
                " price_cents, currency, captured_at)"
                " values (:l, :h, :t, :d, :p, :c, :at) returning id"
            ),
            {
                "l": listing_id,
                "h": f"hash-{ext}",
                "t": title,
                "d": description,
                "p": price_cents,
                "c": None if price_cents is None else "EUR",
                "at": created_at - timedelta(minutes=1),
            },
        )
    ).scalar_one()
    for position, image in enumerate(images):
        await db.execute(
            text("insert into app.snapshot_images(snapshot_id, position, url) values (:s, :p, :u)"),
            {"s": snapshot_id, "p": position, "u": image},
        )
    analysis_id = (
        await db.execute(
            text(
                "insert into app.analyses(snapshot_id, model_id, prompt_version_id, rules_version,"
                " input_hash, score, professional, partial, images_analyzed, tokens_in,"
                " tokens_out, cost_usd_micros, created_at)"
                " values (:s, :m, :p, 1, :h, :score, :pro, :partial, :img, :tin, :tout, :cost,"
                " :at) returning id"
            ),
            {
                "s": snapshot_id,
                "m": model_id,
                "p": prompt_version_id,
                "h": f"input-{ext}",
                "score": score,
                "pro": professional,
                "partial": partial,
                "img": images_analyzed,
                "tin": tokens[0],
                "tout": tokens[1],
                "cost": cost,
                "at": created_at,
            },
        )
    ).scalar_one()
    for locale, summary, advice in (("fr", "Résumé", "Conseil"), ("nl", "Samenvatting", "Advies")):
        await db.execute(
            text(
                "insert into app.analysis_texts(analysis_id, locale, summary, advice)"
                " values (:a, :l, :s, :v)"
            ),
            {"a": analysis_id, "l": locale, "s": summary, "v": advice},
        )
    for position, severity, fr, nl in reasons:
        reason_id = (
            await db.execute(
                text(
                    "insert into app.analysis_reasons(analysis_id, position, severity)"
                    " values (:a, :p, :s) returning id"
                ),
                {"a": analysis_id, "p": position, "s": severity},
            )
        ).scalar_one()
        for locale, label in (("fr", fr), ("nl", nl)):
            await db.execute(
                text(
                    "insert into app.analysis_reason_texts(reason_id, locale, text)"
                    " values (:r, :l, :t)"
                ),
                {"r": reason_id, "l": locale, "t": label},
            )
    for position, query, aspect in searches:
        await db.execute(
            text(
                "insert into app.analysis_web_searches(analysis_id, position, query, aspect)"
                " values (:a, :p, :q, :s)"
            ),
            {"a": analysis_id, "p": position, "q": query, "s": aspect},
        )
    for at, micros in calls if calls is not None else ((created_at, cost),):
        await db.execute(
            text(
                "insert into app.llm_calls(created_at, analysis_id, model_id, prompt_version_id,"
                " tokens_in, tokens_out, images_analyzed, web_searches, cost_usd_micros)"
                " values (:at, :a, :m, :p, :tin, :tout, :img, :ws, :cost)"
            ),
            {
                "at": at,
                "a": analysis_id,
                "m": model_id,
                "p": prompt_version_id,
                "tin": tokens[0],
                "tout": tokens[1],
                "img": images_analyzed,
                "ws": len(searches),
                "cost": micros,
            },
        )
    await db.commit()
    return analysis_id


async def _serve(db, analysis_id: int, user_id: str, at: datetime) -> None:
    """Un scan réussi de `user_id` servi par `analysis_id`."""
    event_id = (
        await db.execute(
            text(
                "insert into app.scan_events(user_id, scan_kind, trigger, created_at)"
                " values (:u, 'full', 'button', :at) returning id"
            ),
            {"u": user_id, "at": at},
        )
    ).scalar_one()
    await db.execute(
        text("insert into app.scan_results(scan_event_id, analysis_id) values (:e, :a)"),
        {"e": event_id, "a": analysis_id},
    )
    await db.commit()


async def _list(client, bearer, admin, **params):
    r = await client.get("/api/admin/analyses", params=params, headers=bearer(admin))
    assert r.status_code == 200, r.text
    return r.json()


async def _ids(client, bearer, admin, **params) -> set[int]:
    return {item["id"] for item in (await _list(client, bearer, admin, **params))["items"]}


# --- URL de l'annonce (migration 0008) ------------------------------------------------------


async def _listing_urls(db) -> list[str | None]:
    await db.rollback()  # relire l'état validé
    rows = await db.execute(text("select url from app.listings order by id"))
    return [url for (url,) in rows.all()]


async def test_scan_stores_listing_url_without_query(client, bearer, user, db, llm):
    uid = await user()
    first = _body(
        external_id="m123",
        site="2ememain.be",
        url="https://www.2ememain.be/v/a/b/m123-velo?utm=x#y",
    )
    r = await client.post("/api/scans", json=first, headers=bearer(uid))
    assert r.status_code == 200, r.text
    # Ni la query ni le fragment, qui peuvent porter des traceurs.
    assert await _listing_urls(db) == ["https://www.2ememain.be/v/a/b/m123-velo"]

    # Mise à jour au scan suivant de la même annonce, sans nouvelle ligne.
    second = _body(
        external_id="m123",
        site="2ememain.be",
        url="https://www.2ememain.be/v/a/b/m123-velo-rouge?ref=z",
    )
    r = await client.post("/api/scans", json=second, headers=bearer(uid))
    assert r.status_code == 200, r.text
    assert await _listing_urls(db) == ["https://www.2ememain.be/v/a/b/m123-velo-rouge"]


async def _scan_url(client, bearer, uid, url: str, *, site: str = "2dehands.be"):
    r = await client.post(
        "/api/scans", json=_body(external_id="m1", site=site, url=url), headers=bearer(uid)
    )
    assert r.status_code == 200, r.text


async def test_foreign_host_does_not_create_or_replace_listing_url(client, bearer, user, db, llm):
    uid = await user()
    # Premier scan avec un autre domaine : aucune URL n'est créée.
    await _scan_url(client, bearer, uid, "https://evil.test/x")
    assert await _listing_urls(db) == [None]
    # Une URL valide, puis un scan avec un autre domaine : elle est conservée.
    await _scan_url(client, bearer, uid, "https://www.2dehands.be/v/a/m1")
    assert await _listing_urls(db) == ["https://www.2dehands.be/v/a/m1"]
    await _scan_url(client, bearer, uid, "https://evil.test/x")
    assert await _listing_urls(db) == ["https://www.2dehands.be/v/a/m1"]


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://2dehands.be/v/a/m1", "https://2dehands.be/v/a/m1"),
        ("https://WWW.2dehands.be/v/a/m1?x=1", "https://www.2dehands.be/v/a/m1"),
        (
            "https://not2dehands.be/v/a/m1",
            None,
        ),  # finit par le domaine sans en être un sous-domaine
        ("https://2dehands.be.evil.test/v/a/m1", None),
        ("https://user:pass@www.2dehands.be/v/a/m1", "https://www.2dehands.be/v/a/m1"),
        ("https://user:pass@evil.test/v/a/m1", None),
    ],
)
async def test_listing_url_must_belong_to_the_site(client, bearer, user, db, llm, url, expected):
    uid = await user()
    await _scan_url(client, bearer, uid, url)
    assert await _listing_urls(db) == [expected]


async def test_detail_exposes_scanned_listing_url(client, bearer, user, admin, llm):
    uid = await user()
    url = "https://www.2dehands.be/v/a/m123-velo?utm=x"
    r = await client.post("/api/scans", json=_body(url=url), headers=bearer(uid))
    assert r.status_code == 200, r.text
    analysis_id = r.json()["analysisId"]

    detail = await client.get(f"/api/admin/analyses/{analysis_id}", headers=bearer(admin))
    assert detail.status_code == 200, detail.text
    assert detail.json()["listing"]["url"] == "https://www.2dehands.be/v/a/m123-velo"


# --- Liste ----------------------------------------------------------------------------------


async def test_list_row_fields(client, bearer, admin, db):
    model_id, prompt_id = await _active(db)
    version = (
        await db.execute(
            text("select version from app.prompt_versions where id = :p"), {"p": prompt_id}
        )
    ).scalar_one()
    provider, slug = (
        await db.execute(
            text("select provider, slug from app.models where id = :m"), {"m": model_id}
        )
    ).one()
    analysis_id = await _make_analysis(
        db,
        ext="a",
        title="Vélo de course",
        score=45,
        professional=True,
        partial=True,
        images_analyzed=2,
        searches=((0, "q1", "price"), (1, "q2", "scam")),
        cost=1500,
    )

    (item,) = (await _list(client, bearer, admin))["items"]
    assert item == {
        "id": analysis_id,
        "createdAt": BASE.isoformat().replace("+00:00", "Z"),
        "site": "2dehands.be",
        "title": "Vélo de course",
        "score": 45,
        "level": "medium",
        "professional": True,
        "modelId": model_id,
        "model": {"provider": provider, "slug": slug},
        "promptVersionId": prompt_id,
        "promptVersion": version,
        "imagesAnalyzed": 2,
        "webSearches": 2,
        "costUsd": 0.0015,
        "llmCalls": 1,
        "served": 0,
        "partial": True,
    }
    assert (await _list(client, bearer, admin))["nextBefore"] is None


async def test_list_levels_use_the_scan_thresholds(client, bearer, admin, db):
    scores = {0: "low", 29: "low", 30: "medium", 59: "medium", 60: "high", 100: "high"}
    for i, score in enumerate(scores):
        await _make_analysis(db, ext=f"s{score}", score=score, created_at=BASE + timedelta(hours=i))
    items = (await _list(client, bearer, admin))["items"]
    assert {i["score"]: i["level"] for i in items} == scores


async def test_list_filters(client, bearer, admin, db, other_setup):
    other_model, other_prompt = other_setup
    _, default_prompt = await _active(db)
    a = await _make_analysis(
        db, ext="a", site="2dehands.be", title="Vélo de course", score=10, created_at=BASE
    )
    # 22 h 30 UTC le 11 octobre = 00 h 30 le 12 à Bruxelles (UTC+2).
    b = await _make_analysis(
        db,
        ext="b",
        site="2ememain.be",
        title="Trottinette Xiaomi",
        score=45,
        model_id=other_model,
        partial=True,
        searches=((0, "q", "price"),),
        created_at=datetime(2026, 10, 11, 22, 30, tzinfo=UTC),
    )
    c = await _make_analysis(
        db,
        ext="c",
        site="facebook.com",
        title="Vélo électrique 100% neuf",
        score=80,
        prompt_version_id=other_prompt,
        professional=True,
        created_at=BASE + timedelta(days=4),
    )
    assert default_prompt != other_prompt

    async def ids(**params):
        return await _ids(client, bearer, admin, **params)

    assert await ids() == {a, b, c}
    assert await ids(site="2ememain.be") == {b}
    assert await ids(site="inconnu.be") == set()
    assert await ids(level="low") == {a}
    assert await ids(level="medium") == {b}
    assert await ids(level="high") == {c}
    assert await ids(modelId=other_model) == {b}
    assert await ids(promptVersionId=other_prompt) == {c}
    assert await ids(promptVersionId=default_prompt) == {a, b}
    assert await ids(withSearch="true") == {b}
    assert await ids(withSearch="false") == {a, c}
    assert await ids(partial="true") == {b}
    assert await ids(partial="false") == {a, c}
    # Période : jours civils de Bruxelles, bornes incluses.
    assert await ids(**{"from": "2026-10-12"}) == {b, c}
    assert await ids(**{"from": "2026-10-12", "to": "2026-10-12"}) == {b}
    assert await ids(to="2026-10-10") == {a}
    assert await ids(to="2026-10-11") == {a}  # b est le 12 à Bruxelles
    assert await ids(**{"from": "2026-10-14", "to": "2026-10-14"}) == {c}
    assert await ids(**{"from": "2026-10-15"}) == set()
    # Recherche : casse ignorée, sous-chaîne ; `%` et `_` sont des caractères, pas des jokers.
    assert await ids(q="xiaomi") == {b}
    assert await ids(q="vélo") == {a, c}
    assert await ids(q="XIAOMI") == {b}
    assert await ids(q="100%") == {c}
    assert await ids(q="%xia") == set()
    assert await ids(q="x_aomi") == set()
    # Combinés.
    assert await ids(q="vélo", level="high") == {c}
    assert await ids(q="vélo", site="2dehands.be", partial="false") == {a}
    assert await ids(
        site="2ememain.be", level="medium", modelId=other_model, withSearch="true"
    ) == {b}
    assert await ids(site="2ememain.be", level="high") == set()
    assert await ids(level="high", **{"from": "2026-10-10", "to": "2026-10-13"}) == set()


async def test_list_pagination(client, bearer, admin, db):
    created = []
    for i in range(55):
        # Les analyses vont par deux à la même minute : l'identifiant départage.
        created.append(
            await _make_analysis(db, ext=f"p{i}", created_at=BASE + timedelta(minutes=i // 2))
        )

    first = await _list(client, bearer, admin)
    assert len(first["items"]) == 50
    ids = [item["id"] for item in first["items"]]
    # Tri (created_at décroissant, id décroissant).
    keys = [(item["createdAt"], item["id"]) for item in first["items"]]
    assert keys == sorted(keys, reverse=True)
    last = first["items"][-1]
    assert first["nextBefore"] == f"{last['createdAt']}~{last['id']}"  # jeton opaque

    second = await _list(client, bearer, admin, before=first["nextBefore"])
    assert len(second["items"]) == 5
    assert second["nextBefore"] is None
    all_ids = ids + [item["id"] for item in second["items"]]
    assert len(set(all_ids)) == 55 == len(created) and set(all_ids) == set(created)
    keys = [(item["createdAt"], item["id"]) for item in first["items"] + second["items"]]
    assert keys == sorted(keys, reverse=True)

    page = await _list(client, bearer, admin, limit=10)
    assert len(page["items"]) == 10 and page["nextBefore"] is not None
    r = await client.get("/api/admin/analyses?limit=51", headers=bearer(admin))
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"
    r = await client.get("/api/admin/analyses?limit=0", headers=bearer(admin))
    assert r.status_code == 422


@pytest.mark.parametrize(
    "shift", [timedelta(days=10), timedelta(days=-10)], ids=["avance", "recule"]
)
async def test_pagination_stable_when_cursor_analysis_is_refreshed(
    client, bearer, admin, db, shift
):
    ids = [
        await _make_analysis(db, ext=f"r{i}", created_at=BASE + timedelta(hours=i))
        for i in range(6)
    ]
    newest_first = ids[::-1]
    first = await _list(client, bearer, admin, limit=3)
    assert [i["id"] for i in first["items"]] == newest_first[:3]
    moved = newest_first[2]  # la dernière de la page 1, celle du curseur

    # Entre deux pages, l'analyse du curseur est rafraîchie : sa date change.
    await db.execute(
        text("update app.analyses set created_at = created_at + :s where id = :a"),
        {"s": shift, "a": moved},
    )
    await db.commit()

    rest: list[int] = []
    token = first["nextBefore"]
    while token is not None:
        page = await _list(client, bearer, admin, limit=3, before=token)
        rest += [i["id"] for i in page["items"]]
        token = page["nextBefore"]
    # Les trois plus anciennes, qui n'ont pas bougé, sont là une fois chacune ; aucun doublon.
    assert len(rest) == len(set(rest))
    assert set(newest_first[3:]) <= set(rest)
    assert not set(newest_first[:2]) & set(
        rest
    )  # les deux premières de la page 1 ne reviennent pas
    if shift > timedelta(0):
        assert rest == newest_first[3:]  # avancée : elle ne reparaît pas en page 2


async def test_cursor_does_not_read_the_database(client, bearer, admin, db):
    """Le jeton porte la date : celui d'une analyse supprimée ou inconnue reste valide."""
    older = await _make_analysis(db, ext="a", created_at=BASE)
    newer = await _make_analysis(db, ext="b", created_at=BASE + timedelta(days=1))
    token = f"{(BASE + timedelta(hours=1)).isoformat().replace('+00:00', 'Z')}~999999999"
    page = await _list(client, bearer, admin, before=token)
    assert [i["id"] for i in page["items"]] == [older]
    assert newer not in {i["id"] for i in page["items"]}


@pytest.mark.parametrize(
    "token",
    [
        "n'importe quoi",
        "123",
        "2026-10-10T12:00:00Z",  # sans identifiant
        "2026-10-10T12:00:00Z~abc",
        "2026-10-10T12:00:00Z~0",
        "2026-10-10T12:00:00Z~99999999999999999999",
        "2026-10-10T12:00:00~5",  # sans fuseau
        "hier~5",
    ],
)
async def test_malformed_cursor_is_422(client, bearer, admin, db, token):
    await _make_analysis(db, ext="a")
    r = await client.get("/api/admin/analyses", params={"before": token}, headers=bearer(admin))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "invalid_value"


async def test_title_search_under_3_chars_is_422(client, bearer, admin, db):
    await _make_analysis(db, ext="a")
    r = await client.get("/api/admin/analyses?q=ab", headers=bearer(admin))
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_request"


async def test_from_after_to_is_422(client, bearer, admin, db):
    await _make_analysis(db, ext="a")
    r = await client.get(
        "/api/admin/analyses",
        params={"from": "2026-10-12", "to": "2026-10-11"},
        headers=bearer(admin),
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_value"
    # Une date mal formée est une erreur de validation, pas une erreur métier.
    r = await client.get("/api/admin/analyses?from=hier", headers=bearer(admin))
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"


@pytest.mark.parametrize(
    "params",
    [
        {"from": "0001-01-01"},
        {"to": "9999-12-31"},
        {"from": "0001-01-01", "to": "9999-12-31"},
        {"from": "1969-12-31"},
        {"to": "2101-01-01"},
    ],
)
async def test_extreme_dates_are_422_never_500(client, bearer, admin, params):
    r = await client.get("/api/admin/analyses", params=params, headers=bearer(admin))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "invalid_request"


async def test_date_bounds_are_accepted(client, bearer, admin):
    r = await client.get(
        "/api/admin/analyses",
        params={"from": "1970-01-01", "to": "2100-12-31"},
        headers=bearer(admin),
    )
    assert r.status_code == 200, r.text


async def test_served_count(client, bearer, admin, db, make_user):
    consumer = await make_user("client@radarnaque.test")
    served = await _make_analysis(db, ext="a", created_at=BASE)
    never = await _make_analysis(db, ext="b", created_at=BASE + timedelta(hours=1))
    times = [BASE, BASE + timedelta(days=1), BASE + timedelta(days=2)]
    for at in times:
        await _serve(db, served, consumer, at)

    by_id = {i["id"]: i for i in (await _list(client, bearer, admin))["items"]}
    assert by_id[served]["served"] == 3
    assert by_id[never]["served"] == 0

    detail = (await client.get(f"/api/admin/analyses/{served}", headers=bearer(admin))).json()
    assert detail["usage"] == {
        "served": 3,
        "firstServedAt": times[0].isoformat().replace("+00:00", "Z"),
        "lastServedAt": times[2].isoformat().replace("+00:00", "Z"),
    }
    unserved = (await client.get(f"/api/admin/analyses/{never}", headers=bearer(admin))).json()
    assert unserved["usage"] == {"served": 0, "firstServedAt": None, "lastServedAt": None}


async def test_refreshed_analysis_lists_two_calls(client, bearer, user, admin, db, app):
    fake = _SearchingFake()
    app.state.llm_for = fake.llm_for
    uid = await user()
    first = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert first.status_code == 200, first.text
    # L'horloge du scan n'est pas injectable : on vieillit l'analyse en base, avec un cache d'une
    # heure, pour que le scan suivant la rafraîchisse sur place.
    await db.execute(text("update app.settings set cache_ttl_hours = 1"))
    await db.execute(
        text("update app.analyses set created_at = created_at - :age"), {"age": timedelta(hours=2)}
    )
    await db.execute(
        text("update app.llm_calls set created_at = created_at - :age"), {"age": timedelta(hours=2)}
    )
    await db.commit()
    try:
        second = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    finally:
        await db.execute(text("update app.settings set cache_ttl_hours = 24"))
        await db.commit()
    assert second.status_code == 200, second.text
    assert second.json()["fromCache"] is False
    analysis_id = first.json()["analysisId"]
    assert second.json()["analysisId"] == analysis_id

    (item,) = (await _list(client, bearer, admin))["items"]
    assert item["llmCalls"] == 2
    assert item["costUsd"] == pytest.approx(84 / 1_000_000)  # 42 + 42 micro-dollars
    assert item["served"] == 2
    assert item["webSearches"] == 2  # les recherches du dernier appel

    detail = (await client.get(f"/api/admin/analyses/{analysis_id}", headers=bearer(admin))).json()
    calls = detail["technical"]["calls"]
    assert len(calls) == 2
    assert calls[0]["createdAt"] > calls[1]["createdAt"]  # du plus récent au plus ancien
    assert sum(call["costUsd"] for call in calls) == pytest.approx(item["costUsd"])


# --- Détail ---------------------------------------------------------------------------------


async def test_detail_texts_reasons_searches_in_order(client, bearer, admin, db):
    analysis_id = await _make_analysis(
        db,
        ext="a",
        title="Vélo de course",
        description="Neuf, jamais servi.",
        url="https://www.2dehands.be/v/a/a",
        price_cents=15000,
        images=("https://img.2dehands.be/1.jpg", "https://img.2dehands.be/2.jpg"),
        score=72,
        professional=True,
        # Insérées dans le désordre : la position fait foi.
        reasons=(
            (2, "info", "Raison C", "Reden C"),
            (0, "danger", "Raison A", "Reden A"),
            (1, "warning", "Raison B", "Reden B"),
        ),
        searches=((1, "deuxième", "scam"), (0, "première", "price")),
    )

    r = await client.get(f"/api/admin/analyses/{analysis_id}", headers=bearer(admin))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["listing"] == {
        "site": "2dehands.be",
        "externalId": "a",
        "url": "https://www.2dehands.be/v/a/a",
        "title": "Vélo de course",
        "description": "Neuf, jamais servi.",
        "priceCents": 15000,
        "currency": "EUR",
        "images": ["https://img.2dehands.be/1.jpg", "https://img.2dehands.be/2.jpg"],
        "capturedAt": (BASE - timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
    }
    assert data["result"]["score"] == 72
    assert data["result"]["level"] == "high"
    assert data["result"]["professional"] is True
    assert data["result"]["texts"] == {
        "fr": {"summary": "Résumé", "advice": "Conseil"},
        "nl": {"summary": "Samenvatting", "advice": "Advies"},
    }
    assert data["result"]["reasons"] == [
        {"position": 0, "severity": "danger", "fr": "Raison A", "nl": "Reden A"},
        {"position": 1, "severity": "warning", "fr": "Raison B", "nl": "Reden B"},
        {"position": 2, "severity": "info", "fr": "Raison C", "nl": "Reden C"},
    ]
    assert data["searches"] == [
        {"position": 0, "query": "première", "aspect": "price"},
        {"position": 1, "query": "deuxième", "aspect": "scam"},
    ]


async def test_detail_cost_and_tokens(client, bearer, admin, db, other_setup):
    other_model, other_prompt = other_setup
    old, new = BASE, BASE + timedelta(days=1)
    analysis_id = await _make_analysis(
        db,
        ext="a",
        model_id=other_model,
        prompt_version_id=other_prompt,
        created_at=new,
        images_analyzed=3,
        tokens=(900, 90),
        cost=120,
        searches=((0, "q", "price"),),
        calls=((old, 70), (new, 120)),
    )
    version = (
        await db.execute(
            text("select version from app.prompt_versions where id = :p"), {"p": other_prompt}
        )
    ).scalar_one()

    r = await client.get(f"/api/admin/analyses/{analysis_id}", headers=bearer(admin))
    assert r.status_code == 200, r.text
    technical = r.json()["technical"]
    iso = lambda d: d.isoformat().replace("+00:00", "Z")  # noqa: E731
    assert technical == {
        "model": {"provider": "autre", "slug": "m-test"},
        "promptVersionId": other_prompt,
        "promptVersion": version,
        "tokensIn": 900,
        "tokensOut": 90,
        "costUsd": 0.00012,  # celui du dernier appel
        "imagesAnalyzed": 3,
        "inputHash": "input-a",
        "createdAt": iso(new),
        "calls": [
            {
                "createdAt": iso(new),
                "tokensIn": 900,
                "tokensOut": 90,
                "costUsd": 0.00012,
                "imagesAnalyzed": 3,
                "webSearches": 1,
            },
            {
                "createdAt": iso(old),
                "tokensIn": 900,
                "tokensOut": 90,
                "costUsd": 0.00007,
                "imagesAnalyzed": 3,
                "webSearches": 1,
            },
        ],
    }
    # Dans la liste : coût total = somme des appels.
    (item,) = (await _list(client, bearer, admin))["items"]
    assert item["costUsd"] == pytest.approx(0.00019) and item["llmCalls"] == 2


async def test_old_analysis_without_url_price_or_images(client, bearer, admin, db):
    """Une analyse antérieure à la migration 0008 : ni URL, ni prix, ni photo, ni raison."""
    analysis_id = await _make_analysis(db, ext="old", url=None, price_cents=None, images=())

    r = await client.get(f"/api/admin/analyses/{analysis_id}", headers=bearer(admin))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["listing"]["url"] is None
    assert data["listing"]["priceCents"] is None
    assert data["listing"]["currency"] is None
    assert data["listing"]["images"] == []
    assert data["result"]["reasons"] == []
    assert data["searches"] == []


async def test_no_account_data(client, bearer, user, admin, db, llm):
    uid = await user()
    email = (
        await db.execute(text('select email from auth."user" where id = :u'), {"u": uid})
    ).scalar_one()
    r = await client.post("/api/scans", json=_body(), headers=bearer(uid))
    assert r.status_code == 200, r.text
    analysis_id = r.json()["analysisId"]

    listing = await client.get("/api/admin/analyses", headers=bearer(admin))
    detail = await client.get(f"/api/admin/analyses/{analysis_id}", headers=bearer(admin))
    assert listing.status_code == detail.status_code == 200
    for response in (listing, detail):
        body = response.text
        admin_id = (
            await db.execute(
                text('select id from auth."user" where email = :e'), {"e": ADMIN_EMAIL}
            )
        ).scalar_one()
        for forbidden in (uid, email, admin_id, ADMIN_EMAIL):
            assert forbidden not in body
        assert "email" not in body.lower() and "userid" not in body.lower()


async def test_unknown_analysis_is_404(client, bearer, admin):
    r = await client.get("/api/admin/analyses/999999999", headers=bearer(admin))
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"
    r = await client.get("/api/admin/analyses/abc", headers=bearer(admin))
    assert r.status_code == 422


async def test_analyses_are_read_only(client, bearer, admin, db):
    analysis_id = await _make_analysis(db, ext="a")
    await _list(client, bearer, admin)
    r = await client.get(f"/api/admin/analyses/{analysis_id}", headers=bearer(admin))
    assert r.status_code == 200
    await db.rollback()
    assert (await db.execute(text("select count(*) from app.admin_actions"))).scalar_one() == 0
    for method in ("POST", "PATCH", "PUT", "DELETE"):
        r = await client.request(
            method, f"/api/admin/analyses/{analysis_id}", headers=bearer(admin)
        )
        assert r.status_code == 405, method


async def test_analyses_routes_need_admin(client, bearer, make_user):
    uid = await make_user("simple@radarnaque.test")
    for url in ("/api/admin/analyses", "/api/admin/analyses/1"):
        r = await client.get(url)
        assert r.status_code == 401, url
        r = await client.get(url, headers=bearer(uid))
        assert r.status_code == 403, url
        assert r.json()["error"]["code"] == "admin_required"
