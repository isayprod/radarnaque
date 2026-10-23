import asyncio
import io
import json
from collections.abc import AsyncIterator, Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
import respx
from fake_llm import FakeLLM
from PIL import Image
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from radarnaque_api.identify import pipeline as pipeline_module
from radarnaque_api.identify.criteria_store import candidates_key
from radarnaque_api.identify.payload import build_identify_messages, build_read_photos_messages
from radarnaque_api.identify.pipeline import (
    IdentifySettings,
    PipelineContext,
    PipelineRun,
    run_pipeline,
)
from radarnaque_api.identify.schemas import (
    SCHEMA_CRITERIA,
    SCHEMA_IDENTIFY,
    SCHEMA_READ_PHOTOS,
    CheckOut,
    CriteriaOut,
    ExpectedValue,
    ExtractedCriterion,
    IdentifiedObjectOut,
    IdentifyOut,
    PhotoObservation,
    ReadPhotosObject,
    ReadPhotosOut,
)
from radarnaque_api.identify.store import (
    IdentificationKey,
    StepSetup,
    active_steps,
    config_hash,
    identification_digest,
    identify_input_hash,
    load_identification,
    save_identification,
    valid_identification_id,
)
from radarnaque_api.llm.client import Bilingual, LLMError
from radarnaque_api.llm.events import CriteriaCached, PageRead, SearchStarted
from radarnaque_api.models import AppSettings, LlmCall, Model, Site, SiteImageHost
from radarnaque_api.models.identification import (
    CriteriaSet,
    Criterion,
    Identification,
    IdentificationCheck,
    IdentificationObject,
    IdentificationSearch,
)
from radarnaque_api.pages import make_http_client
from radarnaque_api.schemas import ScanIn
from radarnaque_api.search import SearchHit, SearchUnavailable
from radarnaque_api.services.hashing import content_hash
from radarnaque_api.services.scan_store import upsert_snapshot
from radarnaque_api.services.scan_stream import Stage

T0 = datetime(2026, 10, 23, 10, 0, tzinfo=UTC)
PUBLIC_IP = "93.184.216.34"
OLED, LCD = "Steam Deck OLED", "Steam Deck LCD"
SETTINGS = IdentifySettings(
    identification_cache_ttl_hours=168,
    criteria_ttl_days=180,
    criteria_max_searches=2,
    criteria_max_pages=3,
    identify_retry_threshold=60,
    identify_image_side=1280,
    scam_sends_photos=False,
    identify_escalation_model_id=None,
)

Q_VS = f"{OLED} vs {LCD} différence"
Q_HOW = f"how to tell {OLED} from {LCD}"
Q_REF = f"{OLED} fiche technique"
Q_PRICE = f"{OLED} prix occasion"
Q_RETRY = "Steam Deck OLED 1010 boîte"


def hit(url: str, title: str = "Titre", snippet: str = "Extrait") -> SearchHit:
    return SearchHit(title=title, url=url, snippet=snippet)


HITS = {
    Q_VS: [hit("https://versus.example/oled-vs-lcd", "OLED vs LCD")],
    Q_HOW: [hit("https://guide.example/how-to-tell", "How to tell")],
    Q_REF: [
        hit("https://www.steamdeck.com/fr/tech", "Steam Deck — Tech specs"),
        hit("https://specs.example/steam-deck-oled", "Fiche Steam Deck OLED"),
    ],
    Q_PRICE: [hit("https://prix.example/steam-deck", "Prix Steam Deck")],
}


# --- Faux services -----------------------------------------------------------------------------


class FakeBackend:
    def __init__(self, hits=None, *, delay: float = 0.0, down: bool = False) -> None:
        self.hits = dict(HITS if hits is None else hits)
        self.delay = delay
        self.down = down
        self.queries: list[str] = []

    async def search(self, query: str, *, fresh: bool = False) -> list[SearchHit]:
        self.queries.append(query)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.down:
            raise SearchUnavailable("panne")
        return list(self.hits.get(query, []))


async def resolve(host: str) -> list[str]:
    return [PUBLIC_IP]


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 20), "red").save(out, "PNG")
    return out.getvalue()


def _html(title: str) -> httpx.Response:
    body = f"<html><head><title>{title}</title></head><body><p>Texte de {title}</p></body></html>"
    return httpx.Response(200, text=body, headers={"content-type": "text/html; charset=utf-8"})


@pytest.fixture
def mock() -> Iterator[respx.MockRouter]:
    # Aucune requête réseau : photos et pages simulées. Le lecteur de pages vise l'IP vérifiée
    # (`https://<ip>:443/<chemin>`) : les pages se distinguent par leur chemin.
    with respx.mock(assert_all_called=False) as router:
        for n in range(4):
            router.get(f"https://images.2dehands.com/api/p{n}.jpg").respond(
                200, content=_png(), headers={"content-type": "image/png"}
            )
        router.get(path="/oled-vs-lcd").mock(return_value=_html("OLED vs LCD"))
        router.get(path="/how-to-tell").mock(return_value=_html("How to tell"))
        router.get(path="/retry-page").mock(return_value=_html("Boîte 1010"))
        yield router


@pytest_asyncio.fixture
async def engine(pg_url: str) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(pg_url)
    try:
        yield eng
    finally:
        await eng.dispose()


@pytest.fixture
def maker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest_asyncio.fixture
async def clients(mock) -> AsyncIterator[tuple[httpx.AsyncClient, httpx.AsyncClient]]:
    async with (
        httpx.AsyncClient(trust_env=False, follow_redirects=False) as images,
        make_http_client() as pages,
    ):
        yield images, pages


@pytest_asyncio.fixture
async def steps(maker) -> dict[str, StepSetup]:
    async with maker() as session:
        found = await active_steps(session)
    assert found is not None
    return found


@pytest_asyncio.fixture
async def suffixes(maker) -> list[str]:
    async with maker() as session:
        site_id = await session.scalar(select(Site.id).where(Site.domain == "2dehands.be"))
        return list(
            await session.scalars(
                select(SiteImageHost.host_suffix).where(SiteImageHost.site_id == site_id)
            )
        )


# --- Sorties préparées -------------------------------------------------------------------------


def obj(*candidates: str, role: str = "main", value: str = "high", category: str = "Console"):
    return ReadPhotosObject(
        role=role,  # type: ignore[arg-type]
        category=category,
        brand="Valve",
        candidates=list(candidates),
        relative_value=value,  # type: ignore[arg-type]
    )


def read_out(*objects: ReadPhotosObject, read_reference: str | None = None, **kw) -> ReadPhotosOut:
    return ReadPhotosOut(
        status=kw.pop("status", "ok"),
        objects=list(objects) or [obj(OLED, LCD)],
        clues=[],
        read_reference=read_reference,
        hint_criteria=kw.pop("hints", ["anneau du joystick noir"]),
        photo_observations=kw.pop(
            "photo_observations",
            [PhotoObservation(photo=1, kind="catalog", note="photo du fabricant")],
        ),
        title_mismatch=kw.pop("title_mismatch", None),
    )


def crit(fr: str, *, kind: str = "photo", decisive: bool = True, sources=(1, 2)):
    return ExtractedCriterion(
        kind=kind,  # type: ignore[arg-type]
        decisive=decisive,
        fr=fr,
        nl=f"{fr} (nl)",
        expected=[
            ExpectedValue(candidate=OLED, fr="noir", nl="zwart"),
            ExpectedValue(candidate=LCD, fr="blanc", nl="wit"),
        ],
        sources=list(sources),
    )


# Un critère `ask_seller` en tête : `identify` ne voit que les critères `photo`, numérotés 1..k.
CRITERIA = CriteriaOut(
    criteria=[
        crit("Demander la facture", kind="ask_seller"),
        crit("Anneau du joystick"),
        crit("Étui de transport"),
    ]
)


def checks(*observations: str) -> list[CheckOut]:
    return [
        CheckOut(criterion=n, observation=o, photo=1 if o != "not_visible" else None)  # type: ignore[arg-type]
        for n, o in enumerate(observations, start=1)
    ]


def identify_out(
    reference: str | None = OLED,
    *,
    checks_: list[CheckOut] | None = None,
    pages: list[int] | None = None,
    retry_query: str | None = None,
    objects: list[IdentifiedObjectOut] | None = None,
) -> IdentifyOut:
    return IdentifyOut(
        objects=objects
        or [
            IdentifiedObjectOut(
                object=1,
                checks=checks("seen_match", "seen_match") if checks_ is None else checks_,
                reference=reference,
                remaining=[reference] if reference else [OLED, LCD],
                pages=[1, 2] if pages is None else pages,
            )
        ],
        seller_question=Bilingual(fr="Une photo de la boîte ?", nl="Een foto van de doos?"),
        retry_query=retry_query,
    )


@pytest.fixture
def llm() -> FakeLLM:
    fake = FakeLLM()
    fake.step_outputs = {
        SCHEMA_READ_PHOTOS: read_out(),
        SCHEMA_CRITERIA: CRITERIA,
        SCHEMA_IDENTIFY: identify_out(),
    }
    return fake


def scan_in(external_id: str = "m1", photos: int = 2) -> ScanIn:
    return ScanIn.model_validate(
        {
            "listing": {
                "site": "2dehands.be",
                "externalId": external_id,
                "url": f"https://www.2dehands.be/v/a/{external_id}",
                "title": "Steam Deck OLED 512 Go",
                "description": "Très bon état",
                "price": {"amountCents": 40000, "currency": "EUR"},
                "priceType": "fixed",
                "category": "Consoles",
                "location": {"city": "Gent"},
                "images": [f"https://images.2dehands.com/api/p{n}.jpg" for n in range(photos)],
                "seller": {"reviewCount": 2},
            },
            "rules": {"version": 1, "signals": []},
            "trigger": "button",
        }
    )


class Recorder:
    def __init__(self) -> None:
        self.events: list = []

    async def __call__(self, event) -> None:
        self.events.append(event)


async def pipeline(
    maker,
    llm: FakeLLM,
    clients,
    steps,
    suffixes,
    *,
    backend: FakeBackend | None = None,
    scan: ScanIn | None = None,
    escalation: StepSetup | None = None,
    settings: IdentifySettings = SETTINGS,
    recorder: Recorder | None = None,
) -> PipelineRun:
    scan = scan or scan_in()
    images, pages = clients
    ctx = PipelineContext(
        steps=steps,
        llm_for=llm.llm_for,
        search=FakeBackend() if backend is None else backend,
        http_images=images,
        http_pages=pages,
        resolve=resolve,
        maker=maker,
        settings=settings,
        image_host_suffixes=suffixes,
        photos=len(scan.listing.images),
        at=T0,
        escalation=escalation,
    )
    return await run_pipeline(ctx, scan, recorder)


def schemas_called(llm: FakeLLM) -> list[str]:
    return [c["schema_name"] for c in llm.step_calls]


async def count(maker, model, *where) -> int:
    async with maker() as session:
        return await session.scalar(select(func.count()).select_from(model).where(*where)) or 0


async def snapshot_of(maker, scan: ScanIn) -> int:
    async with maker() as session:
        site_id = await session.scalar(select(Site.id).where(Site.domain == scan.listing.site))
        snapshot_id, _ = await upsert_snapshot(session, site_id, scan.listing, T0)
    return snapshot_id


# --- Pipeline ----------------------------------------------------------------------------------


async def test_full_pipeline_identifies_with_criteria_from_pages(
    maker, llm, clients, steps, suffixes
):
    backend = FakeBackend()
    recorder = Recorder()
    run = await pipeline(maker, llm, clients, steps, suffixes, backend=backend, recorder=recorder)

    assert schemas_called(llm) == [SCHEMA_READ_PHOTOS, SCHEMA_CRITERIA, SCHEMA_IDENTIFY]
    assert run.status == "identified" and run.confidence == 95
    main = run.objects[0]
    assert (main.reference, main.level, main.confidence) == (OLED, "sure", 95)
    # Les pages sont les résultats n° 1 et 2 (recherche « fiche technique »), URL des résultats.
    assert [p.url for p in main.pages] == [
        "https://www.steamdeck.com/fr/tech",
        "https://specs.example/steam-deck-oled",
    ]
    assert main.pages[0].domain == "www.steamdeck.com"
    # Critère 1 et 2 d'`identify` : les deux critères `photo`, pas le critère `ask_seller`.
    assert [c.text_fr for c in main.checks] == ["Anneau du joystick", "Étui de transport"]
    assert all(c.criterion_id is not None and c.decisive for c in main.checks)
    assert [c.photo for c in main.checks] == [1, 1]
    assert {s[0] for s in main.checks[0].sources} == {
        "https://versus.example/oled-vs-lcd",
        "https://guide.example/how-to-tell",
    }
    # Critères enregistrés dans la base, avec les deux pages lues comme sources.
    assert (
        await count(maker, CriteriaSet, CriteriaSet.candidates_key == candidates_key([OLED, LCD]))
        == 1
    )
    assert await count(maker, Criterion) == 3
    assert sorted(backend.queries) == sorted([Q_VS, Q_HOW, Q_REF, Q_PRICE])
    assert run.price_hits == HITS[Q_PRICE]
    # Le message de `criteria` ne porte aucune donnée de l'annonce.
    criteria_text = json.dumps(llm.step_calls[1]["messages"], ensure_ascii=False)
    assert "Très bon état" not in criteria_text and "OLED vs LCD" in criteria_text
    # Événements : étapes, recherches numérotées sans doublon, pages lues.
    stages = [e.stage for e in recorder.events if isinstance(e, Stage)]
    assert stages == ["photos", "reading_photos", "criteria", "identifying"]
    ids = sorted(e.id for e in recorder.events if isinstance(e, SearchStarted))
    assert ids == [1, 2, 3, 4]
    assert sorted(e.domain for e in recorder.events if isinstance(e, PageRead)) == [
        "guide.example",
        "versus.example",
    ]
    assert run.images_analyzed == 2 and not run.retried and not run.unsourced
    assert [c.step for c in run.calls] == ["read_photos", "criteria", "identify"]
    debug = run.debug()
    assert [(d.step, d.model) for d in debug.steps] == [
        ("read_photos", steps["read_photos"].slug),
        ("criteria", steps["criteria"].slug),
        ("identify", steps["identify"].slug),
    ]
    assert "[image 1 : " in debug.steps[0].messages[0].content
    assert "base64" not in debug.model_dump_json()
    # Les photos de `read_photos` et d'`identify` sont téléchargées une fois, à 1280 px au plus.
    assert len([c for c in recorder.events if isinstance(c, Stage) and c.stage == "photos"]) == 1


async def test_check_numbers_map_through_photo_criteria_only(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(
        checks_=[
            CheckOut(criterion=2, observation="seen_contrary", photo=2),
            CheckOut(criterion=1, observation="seen_match", photo=1),
        ]
    )
    run = await pipeline(maker, llm, clients, steps, suffixes)
    main = run.objects[0]
    assert [(c.text_fr, c.observation) for c in main.checks] == [
        ("Anneau du joystick", "seen_match"),
        ("Étui de transport", "seen_contrary"),
    ]
    assert main.confidence <= 50  # un `seen_contrary` élimine le candidat
    sent = llm.step_calls[2]["messages"][0]["content"][0]["text"]
    assert "Critère 1 : Anneau du joystick" in sent and "Demander la facture" not in sent


async def test_criterion_left_unchecked_counts_as_not_visible(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(checks_=checks("seen_match"))
    run = await pipeline(maker, llm, clients, steps, suffixes)
    main = run.objects[0]
    assert [c.observation for c in main.checks] == ["seen_match", "not_visible"]
    assert main.confidence <= 70  # critère décisif non visible


async def test_criteria_reused_from_base_skips_searches_and_llm(
    maker, llm, clients, steps, suffixes
):
    await pipeline(maker, llm, clients, steps, suffixes)
    llm.step_calls.clear()
    backend = FakeBackend()
    recorder = Recorder()
    run = await pipeline(
        maker,
        llm,
        clients,
        steps,
        suffixes,
        backend=backend,
        scan=scan_in("m2"),
        recorder=recorder,
    )
    assert schemas_called(llm) == [SCHEMA_READ_PHOTOS, SCHEMA_IDENTIFY]
    assert CriteriaCached(3) in recorder.events
    assert "criteria" not in [e.stage for e in recorder.events if isinstance(e, Stage)]
    assert sorted(backend.queries) == sorted([Q_REF, Q_PRICE])
    assert run.confidence == 95 and not [c for c in run.calls if c.step == "criteria"]


async def test_single_candidate_skips_criteria(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_READ_PHOTOS] = read_out(obj(OLED))
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(checks_=[])
    backend = FakeBackend()
    run = await pipeline(maker, llm, clients, steps, suffixes, backend=backend)
    assert schemas_called(llm) == [SCHEMA_READ_PHOTOS, SCHEMA_IDENTIFY]
    assert sorted(backend.queries) == sorted([Q_REF, Q_PRICE])
    assert run.objects[0].confidence == 85 and run.status == "identified"
    assert await count(maker, CriteriaSet) == 0


async def test_read_reference_found_in_results_gives_95(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_READ_PHOTOS] = read_out(read_reference="Steam Deck OLED 1010")
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(checks_=[])
    hits = dict(HITS)
    hits[Q_REF] = [hit("https://www.steamdeck.com/fr/tech", "Steam Deck OLED 1010 : fiche")]
    run = await pipeline(maker, llm, clients, steps, suffixes, backend=FakeBackend(hits))
    # `read_reference` désigne un seul candidat : l'étape `criteria` est sautée.
    assert schemas_called(llm) == [SCHEMA_READ_PHOTOS, SCHEMA_IDENTIFY]
    assert run.confidence == 95 and run.objects[0].level == "sure"


async def test_read_reference_floor_needs_identify_to_retain_the_designated_candidate(
    maker, llm, clients, steps, suffixes
):
    llm.step_outputs[SCHEMA_READ_PHOTOS] = read_out(read_reference="Steam Deck OLED 1010")
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(LCD, checks_=[])
    hits = dict(HITS)
    hits[Q_REF] = [hit("https://www.steamdeck.com/fr/tech", "Steam Deck OLED 1010 : fiche")]
    run = await pipeline(maker, llm, clients, steps, suffixes, backend=FakeBackend(hits))
    # La référence lue désigne l'OLED, `identify` retient la LCD : aucun plancher.
    assert run.objects[0].reference == LCD and run.confidence == 40


async def test_partial_read_reference_designates_no_candidate(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_READ_PHOTOS] = read_out(read_reference="OLED")
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(checks_=[])
    hits = dict(HITS)
    hits[Q_REF] = [hit("https://www.steamdeck.com/fr/tech", "OLED")]
    run = await pipeline(maker, llm, clients, steps, suffixes, backend=FakeBackend(hits))
    # « OLED » ne contient aucun nom de candidat : `criteria` tourne, pas de plancher.
    assert SCHEMA_CRITERIA in schemas_called(llm)
    assert run.confidence == 40


async def test_read_reference_absent_from_results_gets_no_floor(
    maker, llm, clients, steps, suffixes
):
    llm.step_outputs[SCHEMA_READ_PHOTOS] = read_out(read_reference="Steam Deck OLED 1010")
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(checks_=[])
    run = await pipeline(maker, llm, clients, steps, suffixes)
    assert run.confidence == 40


async def test_nothing_status_stops_after_read_photos(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_READ_PHOTOS] = ReadPhotosOut(
        status="nothing",
        objects=[],
        clues=[],
        read_reference=None,
        hint_criteria=[],
        photo_observations=[],
        title_mismatch=None,
    )
    backend = FakeBackend()
    run = await pipeline(maker, llm, clients, steps, suffixes, backend=backend)
    assert schemas_called(llm) == [SCHEMA_READ_PHOTOS]
    assert (run.status, run.confidence, run.objects) == ("none", 0, [])
    assert backend.queries == []


async def test_listing_without_photos_runs_text_only_and_caps_confidence(
    maker, llm, clients, steps, suffixes, mock
):
    recorder = Recorder()
    run = await pipeline(
        maker, llm, clients, steps, suffixes, scan=scan_in(photos=0), recorder=recorder
    )
    assert "photos" not in [e.stage for e in recorder.events if isinstance(e, Stage)]
    assert not any("images.2dehands.com" in str(call.request.url) for call in mock.calls)
    sent = llm.step_calls[0]["messages"][0]["content"]
    assert [p["type"] for p in sent] == ["text"]
    # Sans photo, rien n'a été vu : chaque `seen_match` compte comme `not_visible`.
    assert run.images_analyzed == 0
    assert [c.observation for c in run.objects[0].checks] == ["not_visible", "not_visible"]
    assert run.confidence == 40 and run.objects[0].level != "sure"


async def test_seen_observation_without_valid_photo_is_not_visible(
    maker, llm, clients, steps, suffixes
):
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(
        checks_=[
            CheckOut(criterion=1, observation="seen_match", photo=None),
            CheckOut(criterion=2, observation="seen_contrary", photo=7),
        ]
    )
    run = await pipeline(maker, llm, clients, steps, suffixes)
    assert [(c.observation, c.photo) for c in run.objects[0].checks] == [
        ("not_visible", None),
        ("not_visible", None),
    ]


async def test_criteria_llm_failure_falls_back_to_unsourced_hints(
    maker, llm, clients, steps, suffixes
):
    llm.step_errors[SCHEMA_CRITERIA] = LLMError("transport")
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(checks_=checks("seen_match"))
    run = await pipeline(maker, llm, clients, steps, suffixes)
    assert schemas_called(llm) == [SCHEMA_READ_PHOTOS, SCHEMA_CRITERIA, SCHEMA_IDENTIFY]
    sent = llm.step_calls[2]["messages"][0]["content"][0]["text"]
    assert "Critère 1 : anneau du joystick noir" in sent
    main = run.objects[0]
    assert run.unsourced and main.confidence <= 70
    assert [(c.text_fr, c.criterion_id, c.decisive) for c in main.checks] == [
        ("anneau du joystick noir", None, False)
    ]
    assert await count(maker, CriteriaSet) == 0
    assert [c.step for c in run.calls] == ["read_photos", "identify"]


async def test_search_down_still_identifies(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(checks_=checks("seen_match"), pages=[])
    run = await pipeline(maker, llm, clients, steps, suffixes, backend=FakeBackend(down=True))
    # Aucune page lue : aucun critère sourçable, les indices servent (non sourcés).
    assert schemas_called(llm) == [SCHEMA_READ_PHOTOS, SCHEMA_IDENTIFY]
    assert run.status == "identified" and run.unsourced and run.confidence == 70
    assert await count(maker, CriteriaSet) == 0


async def test_retry_runs_once_with_escalation_model(maker, llm, clients, steps, suffixes):
    async with maker() as session:
        other = await session.scalar(
            select(Model).where(Model.id != steps["identify"].model_id).order_by(Model.id)
        )
    identify = steps["identify"]
    escalation = StepSetup(
        step="identify",
        model_id=other.id,
        provider=other.provider,
        slug=other.slug,
        prompt_version_id=identify.prompt_version_id,
        system_prompt=identify.system_prompt,
    )
    undecided = identify_out(
        None, checks_=checks("not_visible", "not_visible"), retry_query=Q_RETRY
    )
    llm.step_outputs[SCHEMA_IDENTIFY] = [undecided, undecided]
    llm.step_outputs[SCHEMA_CRITERIA] = [
        CRITERIA,
        CriteriaOut(criteria=[crit("Numéro 1010 sur la boîte", sources=[1])]),
    ]
    hits = dict(HITS)
    hits[Q_RETRY] = [hit("https://retry.example/retry-page", "Boîte 1010")]
    backend = FakeBackend(hits)
    recorder = Recorder()
    run = await pipeline(
        maker,
        llm,
        clients,
        steps,
        suffixes,
        backend=backend,
        escalation=escalation,
        recorder=recorder,
    )
    identify_calls = [c for c in llm.step_calls if c["schema_name"] == SCHEMA_IDENTIFY]
    assert [c["model"] for c in identify_calls] == [identify.slug, escalation.slug]
    assert run.retried and backend.queries.count(Q_RETRY) == 1
    assert [e.stage for e in recorder.events if isinstance(e, Stage)][-1] == "retrying"
    ids = [e.id for e in recorder.events if isinstance(e, SearchStarted)]
    assert sorted(ids) == [1, 2, 3, 4, 5]
    assert [(c.step, c.model_id) for c in run.calls] == [
        ("read_photos", steps["read_photos"].model_id),
        ("criteria", steps["criteria"].model_id),
        ("identify", identify.model_id),
        ("criteria", steps["criteria"].model_id),
        ("identify", other.id),
    ]
    # Les critères de la relance complètent ceux de la base, qui restent.
    async with maker() as session:
        texts = list(await session.scalars(select(Criterion.text_fr).order_by(Criterion.position)))
    assert texts == [
        "Demander la facture",
        "Anneau du joystick",
        "Étui de transport",
        "Numéro 1010 sur la boîte",
    ]
    assert len(run.objects[0].checks) == 3
    assert run.searches[-1].kind == "retry" and run.searches[-1].pages_read == ("retry.example",)


async def test_retry_without_escalation_uses_the_same_model(maker, llm, clients, steps, suffixes):
    undecided = identify_out(
        None, checks_=checks("not_visible", "not_visible"), retry_query=Q_RETRY
    )
    llm.step_outputs[SCHEMA_IDENTIFY] = undecided
    run = await pipeline(maker, llm, clients, steps, suffixes)
    identify_calls = [c for c in llm.step_calls if c["schema_name"] == SCHEMA_IDENTIFY]
    assert [c["model"] for c in identify_calls] == [steps["identify"].slug] * 2
    assert run.retried


async def test_no_retry_above_threshold(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(retry_query=Q_RETRY)
    run = await pipeline(maker, llm, clients, steps, suffixes)
    assert schemas_called(llm).count(SCHEMA_IDENTIFY) == 1 and not run.retried


async def test_page_numbers_out_of_range_are_dropped(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(
        pages=[0, 2, 99],
        checks_=[
            *checks("seen_match", "seen_match"),
            CheckOut(criterion=9, observation="seen_contrary", photo=1),
        ],
    )
    run = await pipeline(maker, llm, clients, steps, suffixes)
    main = run.objects[0]
    assert [p.url for p in main.pages] == ["https://specs.example/steam-deck-oled"]
    assert len(main.checks) == 2 and main.confidence == 95


async def test_model_cannot_inject_urls(maker, llm, clients, steps, suffixes):
    evil = "https://evil.example/piege"
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(
        f"Steam Deck OLED {evil}",
        checks_=checks("not_visible", "not_visible"),
        pages=[1, 2, 3],
        retry_query=f"Steam Deck {evil}",
    )
    hits = dict(HITS)
    # Un résultat en HTTP n'est jamais rendu comme page, même désigné par son numéro.
    hits[Q_REF] = [hit("http://insecure.example/fiche"), *HITS[Q_REF]]
    run = await pipeline(maker, llm, clients, steps, suffixes, backend=FakeBackend(hits))
    assert run.retried
    urls = [p.url for o in run.objects for p in o.pages]
    assert urls == ["https://www.steamdeck.com/fr/tech", "https://specs.example/steam-deck-oled"]
    assert not any("evil" in u or u.startswith("http:") for u in urls)
    # Une URL écrite par le modèle dans `reference` ou `remaining` n'est jamais rendue.
    assert run.objects[0].reference is None and run.objects[0].remaining == ()


async def test_model_names_are_sanitized(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(
        objects=[
            IdentifiedObjectOut(
                object=1,
                checks=checks("seen_match", "seen_match"),
                reference="X" * 200,
                remaining=["www.evil.example", "<b>OLED</b>", OLED],
                pages=[],
            )
        ]
    )
    run = await pipeline(maker, llm, clients, steps, suffixes)
    main = run.objects[0]
    assert main.reference == "X" * 120 and main.remaining == (OLED,)


@pytest.mark.parametrize(
    ("raw", "cleaned"),
    [
        ("  Steam Deck OLED  ", OLED),
        ("voir https://evil.example", None),
        ("javascript://x", None),
        ("WWW.evil.example", None),
        ("Steam Deck\x07", None),
        ("Steam\u0085Deck", None),
        ("<img src=x>", None),
        ("", None),
        (None, None),
        ("Y" * 121, "Y" * 120),
        ("javascript:alert(1)", None),
        ("DATA:text/html,x", None),
        ("mailto:a@b.be", None),
        ("Note : écran rayé", "Note : écran rayé"),
    ],
)
def test_clean_name(raw, cleaned):
    assert pipeline_module._clean_name(raw) == cleaned


def test_clean_sentence_is_longer_but_drops_any_url():
    assert pipeline_module._clean_sentence("Q" * 301) == "Q" * 300
    assert pipeline_module._clean_sentence("Voir https://evil.example pour la boîte") is None
    assert pipeline_module._clean_sentence("Écrivez-moi sur www.evil.example") is None
    assert pipeline_module._clean_sentence("  Une photo de la boîte ?  ") == (
        "Une photo de la boîte ?"
    )


async def test_free_texts_are_sanitized(maker, llm, clients, steps, suffixes):
    """Les textes libres écrits par le modèle et rendus à l'extension passent le même filtre que
    les noms : une phrase qui contient une URL disparaît, une phrase trop longue est coupée."""
    llm.step_outputs[SCHEMA_READ_PHOTOS] = read_out(
        obj(OLED, LCD, category="<b>Console</b>"),
        obj(
            "www.evil.example",
            "Manette A",
            role="accessory",
            value="low",
            category="Manette https://evil.example",
        ),
        title_mismatch="T" * 400,
        photo_observations=[
            PhotoObservation(photo=1, kind="catalog", note="photo du fabricant"),
            PhotoObservation(photo=2, kind="watermark", note="Filigrane <script>x</script>"),
            PhotoObservation(photo=None, kind="screenshot", note="Voir http://evil.example"),
        ],
    )
    out = identify_out()
    llm.step_outputs[SCHEMA_IDENTIFY] = out.model_copy(
        update={
            "seller_question": Bilingual(
                fr="Envoyez une photo sur www.evil.example", nl="Stuur een foto van de doos"
            )
        }
    )
    scan = scan_in()
    run = await pipeline(maker, llm, clients, steps, suffixes, scan=scan)
    assert run.read_photos is not None and run.identify is not None
    assert run.read_photos.title_mismatch == "T" * 300
    assert [o.note for o in run.read_photos.photo_observations] == ["photo du fabricant"]
    assert run.identify.seller_question is None
    main, accessory = run.objects
    # Catégorie refusée : le premier candidat acceptable la remplace.
    assert main.label == OLED and accessory.label == "Manette A"
    # Sans réponse d'`identify` pour l'accessoire, ses candidats sont filtrés eux aussi.
    assert accessory.remaining == ("Manette A",)

    key = IdentificationKey(
        await snapshot_of(maker, scan), config_hash(steps, escalation_model_id=None), "x"
    )
    async with maker() as session, session.begin():
        identification_id = await save_identification(session, key, run, T0)
    async with maker() as session:
        loaded = await load_identification(session, identification_id)
    # Les requêtes (`searches`) passent par `clean_query` : hors du périmètre de ce filtre.
    dumped = json.dumps(loaded.model_dump(mode="json", exclude={"searches"}))
    assert "evil" not in dumped and "<" not in dumped


async def test_unparsable_result_hosts_do_not_fail_the_identification(
    maker, llm, clients, steps, suffixes
):
    hits = dict(HITS)
    hits[Q_REF] = [hit("https://xn--zz.com/a"), hit("https://exa\u200bmple.com/a")]
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(pages=[1, 2])
    run = await pipeline(maker, llm, clients, steps, suffixes, backend=FakeBackend(hits))
    assert run.status == "identified"
    assert {p.domain for p in run.objects[0].pages} <= {"xn--zz.com", "exa\u200bmple.com"}


async def test_targets_main_and_most_valuable_accessory(maker, llm, clients, steps, suffixes):
    llm.step_outputs[SCHEMA_READ_PHOTOS] = read_out(
        obj("Manette A", "Manette B", role="accessory", value="low", category="Manette"),
        obj(OLED, LCD),
        obj("Dock A", "Dock B", role="accessory", value="medium", category="Dock"),
        obj("Étui A", "Étui B", role="accessory", value="medium", category="Étui"),
    )
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(
        objects=[
            IdentifiedObjectOut(object=n, checks=[], reference=ref, remaining=[ref], pages=[])
            for n, ref in [(1, "Manette A"), (2, OLED), (3, "Dock A"), (4, "Étui A")]
        ]
    )
    backend = FakeBackend()
    run = await pipeline(maker, llm, clients, steps, suffixes, backend=backend)
    # Objet principal et premier accessoire de valeur `medium` (le dock) : critères et fiche.
    assert set(backend.queries) >= {Q_REF, "Dock A fiche technique", "Dock A vs Dock B différence"}
    assert not any("Manette" in q or "Étui" in q for q in backend.queries)
    assert [o.label for o in run.objects] == ["Manette", "Console", "Dock", "Étui"]
    assert run.status == "uncertain" and run.confidence == 40
    # Un accessoire sans étape `criteria` : 84 au plus (ici 40, aucun critère vérifié).
    assert all(o.confidence <= 84 for o in run.objects)


async def test_two_pipelines_same_candidates_search_once(maker, llm, clients, steps, suffixes):
    backend = FakeBackend(delay=0.2)
    first, second = Recorder(), Recorder()
    await asyncio.gather(
        pipeline(maker, llm, clients, steps, suffixes, backend=backend, recorder=first),
        pipeline(
            maker,
            llm,
            clients,
            steps,
            suffixes,
            backend=backend,
            scan=scan_in("m2"),
            recorder=second,
        ),
    )
    assert backend.queries.count(Q_VS) == 1 and backend.queries.count(Q_HOW) == 1
    assert schemas_called(llm).count(SCHEMA_CRITERIA) == 1
    assert any(isinstance(e, CriteriaCached) for e in first.events + second.events)


# --- Persistance -------------------------------------------------------------------------------


async def test_save_and_load_round_trip_with_llm_calls_per_step(
    maker, llm, clients, steps, suffixes
):
    llm.step_outputs[SCHEMA_READ_PHOTOS] = read_out(title_mismatch="Le titre annonce une LCD")
    scan = scan_in()
    run = await pipeline(maker, llm, clients, steps, suffixes, scan=scan)
    key = IdentificationKey(
        snapshot_id=await snapshot_of(maker, scan),
        config_hash=config_hash(steps, escalation_model_id=None),
        input_hash=identify_input_hash(scan, 2, 1280),
    )
    async with maker() as session, session.begin():
        identification_id = await save_identification(session, key, run, T0)
    async with maker() as session:
        out = await load_identification(session, identification_id)
        ttl = timedelta(hours=168)
        assert await valid_identification_id(session, key, T0, ttl) == identification_id
        assert await valid_identification_id(session, key, T0 + ttl, ttl) is None

    assert (out.identification_id, out.status, out.confidence, out.level) == (
        identification_id,
        "identified",
        95,
        "sure",
    )
    assert out.from_cache is False and out.remaining is None and out.debug is None
    assert out.identified_at == T0 and out.images_analyzed == 2
    assert out.title_mismatch == "Le titre annonce une LCD"
    assert out.seller_question is not None and out.seller_question.nl == "Een foto van de doos?"
    assert not out.verified_criteria and not out.unsourced
    main = out.objects[0]
    assert (main.role, main.label, main.reference, main.remaining) == (
        "main",
        "Console",
        OLED,
        [OLED],
    )
    assert [c.text.fr for c in main.checks] == ["Anneau du joystick", "Étui de transport"]
    assert main.checks[0].text.nl == "Anneau du joystick (nl)"
    assert {s.url for s in main.checks[0].sources} == {
        "https://versus.example/oled-vs-lcd",
        "https://guide.example/how-to-tell",
    }
    assert [p.domain for p in main.pages] == ["www.steamdeck.com", "specs.example"]
    assert [(s.query, s.kind) for s in out.searches] == [
        (Q_REF, "reference"),
        (Q_PRICE, "price"),
        (Q_VS, "criteria"),
        (Q_HOW, "criteria"),
    ]
    assert out.searches[2].pages_read == ["versus.example"]
    dumped = out.model_dump(mode="json", by_alias=True)
    assert {"identificationId", "sellerQuestion", "verifiedCriteria", "identifiedAt"} <= set(dumped)
    assert dumped["searches"][2]["pagesRead"] == ["versus.example"]
    assert dumped["photoObservations"] == [
        {"photo": 1, "kind": "catalog", "note": "photo du fabricant"}
    ]

    async with maker() as session:
        calls = (
            await session.execute(
                select(LlmCall.step, LlmCall.identification_id, LlmCall.criteria_set_id).order_by(
                    LlmCall.id
                )
            )
        ).all()
        set_id = await session.scalar(select(CriteriaSet.id))
    # La ligne `criteria` est écrite avec les critères, avant l'identification.
    assert calls == [
        ("criteria", None, set_id),
        ("read_photos", identification_id, None),
        ("identify", identification_id, None),
    ]
    async with maker() as session:
        row = await session.get(Identification, identification_id)
        assert row is not None
        own = [c for c in run.calls if c.step != "criteria"]
        assert row.tokens_in == sum(c.tokens_in for c in own)
        assert row.cost_usd_micros == sum(c.cost_usd_micros for c in own)
        assert row.photo_observations == [
            {"photo": 1, "kind": "catalog", "note": "photo du fabricant"}
        ]

    # Rafraîchissement sur place : même ligne, contenu remplacé ; les appels du `run` déjà
    # enregistrés (`criteria`) ne sont pas dupliqués.
    async with maker() as session, session.begin():
        refreshed = await save_identification(session, key, run, T0 + timedelta(days=8))
    assert refreshed == identification_id
    assert await count(maker, Identification) == 1
    assert await count(maker, IdentificationObject) == 1
    assert await count(maker, IdentificationCheck) == 2
    assert await count(maker, IdentificationSearch) == 4
    assert await count(maker, LlmCall) == 5

    # Les vérifications gardent leur copie du critère : la base peut changer après coup.
    async with maker() as session, session.begin():
        await session.execute(delete(Criterion))
    async with maker() as session:
        again = await load_identification(session, identification_id)
    assert [c.text.fr for c in again.objects[0].checks] == [
        "Anneau du joystick",
        "Étui de transport",
    ]
    assert again.identified_at == T0 + timedelta(days=8)


async def test_save_nothing_status(maker, llm, clients, steps, suffixes):
    scan = scan_in()
    llm.step_outputs[SCHEMA_READ_PHOTOS] = ReadPhotosOut(
        status="nothing",
        objects=[],
        clues=[],
        read_reference=None,
        hint_criteria=[],
        photo_observations=[],
        title_mismatch=None,
    )
    run = await pipeline(maker, llm, clients, steps, suffixes, scan=scan)
    key = IdentificationKey(
        await snapshot_of(maker, scan), config_hash(steps, escalation_model_id=None), "x"
    )
    async with maker() as session, session.begin():
        identification_id = await save_identification(session, key, run, T0)
    async with maker() as session:
        out = await load_identification(session, identification_id)
    assert (out.status, out.confidence, out.level, out.objects) == ("none", 0, "uncertain", [])
    assert out.seller_question is None


async def test_verified_criteria_reported(maker, llm, clients, steps, suffixes):
    async with maker() as session, session.begin():
        session.add(
            CriteriaSet(
                candidates_key=candidates_key([OLED, LCD]),
                candidates=[OLED, LCD],
                status="verified",
                created_at=T0 - timedelta(days=900),
                refreshed_at=T0 - timedelta(days=900),
            )
        )
    llm.step_outputs[SCHEMA_IDENTIFY] = identify_out(checks_=[])
    scan = scan_in()
    run = await pipeline(maker, llm, clients, steps, suffixes, scan=scan)
    assert SCHEMA_CRITERIA not in schemas_called(llm)
    key = IdentificationKey(
        await snapshot_of(maker, scan), config_hash(steps, escalation_model_id=None), "x"
    )
    async with maker() as session, session.begin():
        identification_id = await save_identification(session, key, run, T0)
    async with maker() as session:
        out = await load_identification(session, identification_id)
    assert out.verified_criteria and out.confidence == 45  # 40 + bonus de 5


async def test_verified_criteria_is_a_snapshot(maker, llm, clients, steps, suffixes):
    scan = scan_in()
    run = await pipeline(maker, llm, clients, steps, suffixes, scan=scan)
    key = IdentificationKey(
        await snapshot_of(maker, scan), config_hash(steps, escalation_model_id=None), "x"
    )
    async with maker() as session, session.begin():
        identification_id = await save_identification(session, key, run, T0)
    async with maker() as session, session.begin():
        await session.execute(update(CriteriaSet).values(status="verified"))
    async with maker() as session:
        out = await load_identification(session, identification_id)
    assert not out.verified_criteria and out.confidence == 95


async def test_check_of_a_criterion_replaced_meanwhile_keeps_its_copy(
    maker, llm, clients, steps, suffixes
):
    scan = scan_in()
    run = await pipeline(maker, llm, clients, steps, suffixes, scan=scan)
    # Un autre scan rafraîchit l'ensemble entre le pipeline et l'enregistrement.
    async with maker() as session, session.begin():
        await session.execute(delete(Criterion).where(Criterion.position == 1))
    key = IdentificationKey(
        await snapshot_of(maker, scan), config_hash(steps, escalation_model_id=None), "x"
    )
    async with maker() as session, session.begin():
        identification_id = await save_identification(session, key, run, T0)
    async with maker() as session:
        rows = (
            await session.execute(
                select(IdentificationCheck.text_fr, IdentificationCheck.criterion_id).order_by(
                    IdentificationCheck.position
                )
            )
        ).all()
        out = await load_identification(session, identification_id)
    assert [(text, cid is None) for text, cid in rows] == [
        ("Anneau du joystick", True),
        ("Étui de transport", False),
    ]
    assert [c.text.fr for c in out.objects[0].checks] == ["Anneau du joystick", "Étui de transport"]


async def test_refresh_and_criteria_deletion_do_not_deadlock(maker, llm, clients, steps, suffixes):
    """Un rafraîchissement de l'identification et un rafraîchissement des critères simultanés.

    La suppression d'un critère met à nul les vérifications qui le citent ; un rafraîchissement
    supprime ces vérifications. Le verrou partagé sur les critères est donc pris avant les
    suppressions, sinon chaque transaction attend l'autre (40P01)."""
    scan = scan_in()
    run = await pipeline(maker, llm, clients, steps, suffixes, scan=scan)
    key = IdentificationKey(
        await snapshot_of(maker, scan), config_hash(steps, escalation_model_id=None), "x"
    )
    async with maker() as session, session.begin():
        await save_identification(session, key, run, T0)
    target = run.objects[0].checks[0].criterion_id
    assert target is not None

    async def blocked() -> bool:
        async with maker() as probe:
            waiting = await probe.scalar(
                text(
                    "select count(*) from pg_stat_activity where wait_event_type = 'Lock'"
                    " and query like 'DELETE FROM app.criteria%'"
                )
            )
        return bool(waiting)

    async def delete_criterion() -> None:
        async with maker() as other, other.begin():
            await other.execute(delete(Criterion).where(Criterion.id == target))

    statements: list[str] = []
    deleter: asyncio.Task[None] | None = None
    async with maker() as session, session.begin():
        execute = session.execute

        async def spy(statement, *args, **kwargs):
            nonlocal deleter
            statements.append(str(statement.compile(dialect=postgresql.dialect())))
            result = await execute(statement, *args, **kwargs)
            if statements[-1].startswith("DELETE FROM app.identification_searches"):
                # Les vérifications du rafraîchissement sont supprimées : un autre scan supprime
                # maintenant le critère qu'elles citent.
                deleter = asyncio.create_task(delete_criterion())
                for _ in range(50):
                    if await blocked():
                        break
                    await asyncio.sleep(0.1)
                else:
                    pytest.fail("la suppression du critère n'attend pas")
            return result

        session.execute = spy  # type: ignore[method-assign]
        await save_identification(session, key, run, T0 + timedelta(days=8))
    assert deleter is not None
    await asyncio.wait_for(deleter, 10)

    locks = [n for n, sql in enumerate(statements) if "FROM app.criteria" in sql]
    deletes = [n for n, sql in enumerate(statements) if sql.startswith("DELETE")]
    assert len(locks) == 1 and locks[0] < min(deletes)
    assert statements[locks[0]].endswith("FOR KEY SHARE")
    async with maker() as session:
        rows = (
            await session.execute(
                select(IdentificationCheck.position, IdentificationCheck.criterion_id).order_by(
                    IdentificationCheck.position
                )
            )
        ).all()
    # La suppression a attendu l'enregistrement, puis a mis la vérification à nul.
    assert rows[0] == (0, None) and rows[1][1] is not None


async def test_criteria_call_recorded_even_if_identify_fails(maker, llm, clients, steps, suffixes):
    llm.step_errors[SCHEMA_IDENTIFY] = LLMError("transport")
    with pytest.raises(LLMError):
        await pipeline(maker, llm, clients, steps, suffixes)
    async with maker() as session:
        calls = (await session.execute(select(LlmCall.step, LlmCall.criteria_set_id))).all()
        set_id = await session.scalar(select(CriteriaSet.id))
    assert calls == [("criteria", set_id)] and set_id is not None


def test_identification_digest_follows_the_result():
    from radarnaque_api.schemas import IdentificationOut, IdentifiedObjectPublicOut

    def out(**kw) -> IdentificationOut:
        values = {
            "identification_id": 1,
            "status": "identified",
            "confidence": 95,
            "level": "sure",
            "objects": [
                IdentifiedObjectPublicOut(
                    role="main",
                    label="Console",
                    reference=OLED,
                    confidence=95,
                    level="sure",
                    remaining=[OLED],
                    checks=[],
                    pages=[],
                )
            ],
            "seller_question": None,
            "title_mismatch": None,
            "photo_observations": [],
            "searches": [],
            "verified_criteria": False,
            "unsourced": False,
            "images_analyzed": 2,
            "from_cache": False,
            "identified_at": T0,
        }
        values.update(kw)
        return IdentificationOut(**values)

    base = identification_digest(out())
    assert identification_digest(out(identification_id=2, from_cache=True)) == base
    changed = [
        out(confidence=90),
        out(status="uncertain"),
        out(title_mismatch="autre"),
        out(objects=[]),
        out(objects=[out().objects[0].model_copy(update={"remaining": [OLED, LCD]})]),
        out(objects=[out().objects[0].model_copy(update={"label": "Étui"})]),
        out(objects=[out().objects[0].model_copy(update={"confidence": 90})]),
        out(photo_observations=[{"photo": None, "kind": "screenshot", "note": "capture"}]),
    ]
    assert base not in {identification_digest(o) for o in changed}


# --- Configuration et empreintes ---------------------------------------------------------------


async def test_active_steps_and_config_hash(maker, steps):
    assert set(steps) == {"read_photos", "criteria", "identify"}
    assert all(s.system_prompt and s.step == code for code, s in steps.items())
    changed = dict(steps)
    changed["criteria"] = replace(steps["criteria"], prompt_version_id=999)
    base = config_hash(steps, escalation_model_id=None)
    assert config_hash(dict(reversed(list(steps.items()))), escalation_model_id=None) == base
    assert config_hash(changed, escalation_model_id=None) != base
    # Le modèle de la relance change le résultat : il entre dans l'empreinte.
    assert config_hash(steps, escalation_model_id=steps["identify"].model_id) != base


async def test_identify_settings_read_from_the_settings_row(maker):
    async with maker() as session:
        row = await session.scalar(select(AppSettings))
    assert IdentifySettings.of(row) == SETTINGS


def _scan_body() -> dict:
    return {
        "listing": {
            "site": "2dehands.be",
            "externalId": "m1",
            "url": "https://www.2dehands.be/v/a/m1",
            "title": "Steam Deck",
            "description": "Bon état",
            "price": {"amountCents": 1000, "currency": "EUR"},
            "priceType": "fixed",
            "location": {"city": "Gent"},
            "images": ["https://images.2dehands.com/a.jpg", "https://images.2dehands.com/b.jpg"],
            "seller": {"accountAgeMonths": {"min": 1, "max": 3}, "reviewCount": 2},
        },
        "rules": {"version": 3, "signals": [{"id": "a", "weight": 40, "severity": "danger"}]},
        "trigger": "button",
    }


def _facts_sent(scan: ScanIn) -> dict:
    text = build_read_photos_messages(scan.listing, ["QUJD", "QUJD"])[0]["content"][0]["text"]
    return json.loads(text.split("<annonce>\n", 1)[1].split("\n</annonce>", 1)[0])


CONTENT, INPUT = "content_hash", "identify_input_hash"
# Pour chaque fait envoyé à `read_photos` et `identify` : l'empreinte qui le couvre, et une
# modification qui change sa valeur. `site` est couvert par la clé (snapshot → annonce).
IDENTIFY_FACTS = {
    "site": ("cache_key", None),
    "imagesSent": ("photos", None),
    "title": (CONTENT, lambda b: b["listing"].update(title="Steam Deck LCD")),
    "description": (CONTENT, lambda b: b["listing"].update(description="Écran rayé")),
    "maskedContacts": (
        CONTENT,
        lambda b: b["listing"].update(description="Bel 0472 12 34 56 of jan@voorbeeld.be"),
    ),
    "price": (CONTENT, lambda b: b["listing"]["price"].update(amountCents=2000)),
    "priceType": (CONTENT, lambda b: b["listing"].update(priceType="on_request")),
    "imageCount": (
        CONTENT,
        lambda b: b["listing"]["images"].append("https://images.2dehands.com/c.jpg"),
    ),
    "category": (INPUT, lambda b: b["listing"].update(category="Consoles")),
    "condition": (INPUT, lambda b: b["listing"].update(condition="Gebruikt")),
    "attributes": (
        INPUT,
        lambda b: b["listing"].update(attributes=[{"label": "Opslag", "value": "512 GB"}]),
    ),
    "postedAt": (INPUT, lambda b: b["listing"].update(postedAt="2026-10-01")),
    "location": (INPUT, lambda b: b["listing"]["location"].update(city="Brugge")),
    "seller.accountAgeMonths": (
        INPUT,
        lambda b: b["listing"]["seller"].update(accountAgeMonths={"min": 12, "max": 24}),
    ),
    "seller.reviewCount": (INPUT, lambda b: b["listing"]["seller"].update(reviewCount=9)),
    "seller.rating": (INPUT, lambda b: b["listing"]["seller"].update(rating=4.5)),
    "seller.otherListingsCount": (
        INPUT,
        lambda b: b["listing"]["seller"].update(otherListingsCount=7),
    ),
    "seller.verified": (INPUT, lambda b: b["listing"]["seller"].update(verified=True)),
    "seller.sellerKind": (
        INPUT,
        lambda b: b["listing"]["seller"].update(sellerKind="professional"),
    ),
}


def _paths(facts: dict) -> set[str]:
    return {k for k in facts if k != "seller"} | {f"seller.{k}" for k in facts["seller"]}


def _fact(facts: dict, path: str):
    head, _, sub = path.partition(".")
    return facts[head][sub] if sub else facts[head]


def _content(scan: ScanIn) -> str:
    from radarnaque_api.llm.payload import mask_contacts

    listing = scan.listing
    return content_hash(listing, mask_contacts(listing.title), mask_contacts(listing.description))


def test_identify_input_hash_covers_every_field_sent():
    base = ScanIn.model_validate(_scan_body())
    # Un fait ajouté plus tard aux messages de `read_photos` / `identify` fait échouer ce test.
    assert _paths(_facts_sent(base)) == set(IDENTIFY_FACTS)
    # `identify` reçoit exactement les mêmes faits que `read_photos`.
    identify_text = build_identify_messages(base.listing, ["QUJD", "QUJD"], [], {}, [])[0][
        "content"
    ][0]["text"]
    sent = json.loads(identify_text.split("<annonce>\n", 1)[1].split("\n</annonce>", 1)[0])
    assert sent == _facts_sent(base)
    for field, (coverage, mutate) in IDENTIFY_FACTS.items():
        if mutate is None:
            continue
        body = _scan_body()
        mutate(body)
        changed = ScanIn.model_validate(body)
        assert _fact(_facts_sent(changed), field) != _fact(_facts_sent(base), field), field
        if coverage == CONTENT:
            assert _content(changed) != _content(base), field
        else:
            assert identify_input_hash(changed, 2, 1280) != identify_input_hash(base, 2, 1280), (
                field
            )


def test_identify_input_hash_photos_side_and_unsent_fields():
    base = ScanIn.model_validate(_scan_body())
    digest = identify_input_hash(base, 2, 1280)
    assert identify_input_hash(base, 1, 1280) != digest
    assert identify_input_hash(base, 2, 768) != digest
    # Signaux, version des règles, scan partiel et déclencheur ne sont pas envoyés.
    body = _scan_body()
    body["rules"] = {"version": 9, "signals": []}
    body["partial"] = True
    body["trigger"] = "card"
    assert identify_input_hash(ScanIn.model_validate(body), 2, 1280) == digest
