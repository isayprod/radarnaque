"""Commande `radarnaque-eval-identify` : évalue l'identification sur un jeu d'annonces local.

    radarnaque-eval-identify evals/identify.jsonl

Chaque ligne du fichier (jamais commité, construit à la main) est un objet JSON
`{"scan": <ScanIn>, "expected": "<référence attendue>"}`. Le pipeline tourne comme pour un scan
(configuration active des trois étapes, mêmes réglages, mêmes photos), sans quota, sans cache
d'identification et sans enregistrer d'identification : seules la base de critères et les lignes
`llm_calls` des critères sont écrites. Une référence attendue est juste quand elle est contenue,
sans accents ni majuscules, dans la référence trouvée pour l'objet principal.

Sortie : une ligne par annonce (rang, statut, niveau, référence trouvée, coût), puis la justesse,
la répartition des niveaux et le coût moyen par étape. Jamais le titre, la description, les
photos ni aucun autre contenu d'annonce."""

import argparse
import asyncio
import json
import os
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import async_sessionmaker

from radarnaque_api.config import Settings
from radarnaque_api.db import make_engine
from radarnaque_api.identify.criteria_store import normalize_name
from radarnaque_api.identify.pipeline import (
    IdentifySettings,
    PipelineContext,
    PipelineRun,
    run_pipeline,
)
from radarnaque_api.identify.store import active_steps
from radarnaque_api.images import MAX_IMAGES, default_resolve
from radarnaque_api.llm.client import LLMClientFactory
from radarnaque_api.llm.providers import load_providers
from radarnaque_api.models import AppSettings
from radarnaque_api.pages import make_http_client
from radarnaque_api.schemas import ScanIn
from radarnaque_api.search import make_search_backend
from radarnaque_api.services.identify_service import _escalation, _photos
from radarnaque_api.services.scans import _validated_site

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2


@dataclass(frozen=True)
class Case:
    scan: ScanIn
    expected: str


@dataclass(frozen=True)
class Outcome:
    status: str
    level: str
    reference: str | None
    correct: bool
    cost_by_step: dict[str, int]  # micro-dollars


def _fail(message: str, code: int = EXIT_USAGE) -> int:
    print(f"radarnaque-eval-identify : {message}", file=sys.stderr)
    return code


def load_cases(path: Path) -> list[Case]:
    """Lignes du fichier ; une ligne invalide lève `ValueError` avec son seul numéro (le contenu
    d'une annonce n'est jamais repris dans le message)."""
    cases: list[Case] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            data = json.loads(line)
            expected = data["expected"]
            if not isinstance(expected, str) or not expected.strip():
                raise ValueError
            cases.append(Case(ScanIn.model_validate(data["scan"]), expected))
        except (ValueError, KeyError, TypeError, ValidationError):
            raise ValueError(f"ligne {number} invalide (attendu : scan et expected)") from None
    return cases


def is_correct(expected: str, found: str | None) -> bool:
    """Référence attendue contenue (normalisée) dans la référence trouvée."""
    return found is not None and normalize_name(expected) in normalize_name(found)


def outcome_of(expected: str, run: PipelineRun) -> Outcome:
    main = next((o for o in run.objects if o.role == "main"), None)
    reference = None if main is None else main.reference
    costs: dict[str, int] = defaultdict(int)
    for call in run.calls:
        costs[call.step] += call.cost_usd_micros
    return Outcome(
        status=run.status,
        level="uncertain" if main is None else main.level,
        reference=reference,
        correct=is_correct(expected, reference),
        cost_by_step=dict(costs),
    )


def summary_lines(outcomes: list[Outcome], failures: int) -> list[str]:
    """Justesse, répartition des niveaux et coût moyen par étape (sur les annonces où l'étape a
    tourné)."""
    total = len(outcomes) + failures
    lines = [f"annonces : {total} (identifiées : {len(outcomes)}, en échec : {failures})"]
    if outcomes:
        right = sum(o.correct for o in outcomes)
        lines.append(
            f"justesse : {right}/{len(outcomes)} ({100 * right // len(outcomes)} %)"
            + (f" ; {total} avec les échecs : {100 * right // total} %" if failures else "")
        )
        levels = Counter(o.level for o in outcomes)
        lines.append("niveaux : " + ", ".join(f"{lv} {levels.get(lv, 0)}" for lv in _LEVELS))
        sums: dict[str, list[int]] = defaultdict(list)
        for o in outcomes:
            for step, cost in o.cost_by_step.items():
                sums[step].append(cost)
        for step, costs in sorted(sums.items()):
            lines.append(
                f"coût moyen {step} : {sum(costs) / len(costs) / 1_000_000:.5f} USD "
                f"({len(costs)} annonces)"
            )
        every = [sum(o.cost_by_step.values()) for o in outcomes]
        lines.append(f"coût moyen par annonce : {sum(every) / len(every) / 1_000_000:.5f} USD")
    return lines


_LEVELS = ("sure", "probable", "uncertain")


async def evaluate(settings: Settings, cases: list[Case]) -> int:
    engine = make_engine(settings.database_url)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    providers = load_providers(settings.providers_file)
    llm_for = LLMClientFactory(providers, os.environ)
    http_images = httpx.AsyncClient(trust_env=False, follow_redirects=False)
    http_pages = make_http_client()
    http_search = (
        None
        if settings.search_backend == "none"
        else httpx.AsyncClient(trust_env=False, follow_redirects=False)
    )
    search = None if http_search is None else make_search_backend(settings, http_search)
    outcomes: list[Outcome] = []
    failures = 0
    try:
        for rank, case in enumerate(cases, start=1):
            try:
                async with maker() as session:
                    row = (await session.execute(select(AppSettings))).scalar_one()
                    id_settings = IdentifySettings.of(row)
                    steps = await active_steps(session)
                    if steps is None:
                        return _fail("les trois étapes d'identification ne sont pas configurées")
                    escalation = await _escalation(session, id_settings, steps["identify"])
                    _, suffixes = await _validated_site(session, case.scan)
                receivers = [steps["read_photos"], steps["identify"]]
                if escalation is not None:
                    receivers.append(escalation)
                photos = _photos(
                    SimpleNamespace(max_images=MAX_IMAGES), case.scan, receivers, llm_for
                )  # type: ignore[arg-type]
                ctx = PipelineContext(
                    steps=steps,
                    llm_for=llm_for,
                    search=search,
                    http_images=http_images,
                    http_pages=http_pages,
                    resolve=default_resolve,
                    maker=maker,
                    settings=id_settings,
                    image_host_suffixes=suffixes,
                    photos=photos,
                    at=datetime.now(UTC),
                    escalation=escalation,
                )
                run = await run_pipeline(ctx, case.scan, None)
            except Exception as exc:  # noqa: BLE001 - une annonce en échec ne coupe pas l'évaluation
                # Le type de l'erreur seulement : le message peut citer l'annonce ou une clé.
                failures += 1
                print(f"{rank:>3}  échec ({type(exc).__name__})")
                continue
            outcome = outcome_of(case.expected, run)
            outcomes.append(outcome)
            cost = sum(outcome.cost_by_step.values()) / 1_000_000
            print(
                f"{rank:>3}  {'juste' if outcome.correct else 'faux '}  {outcome.status:<10} "
                f"{outcome.level:<9} référence : {outcome.reference or '-'}  "
                f"({run.images_analyzed} photos, {cost:.5f} USD)"
            )
    finally:
        await llm_for.aclose()
        await http_images.aclose()
        await http_pages.aclose()
        if http_search is not None:
            await http_search.aclose()
        await engine.dispose()
    print()
    for line in summary_lines(outcomes, failures):
        print(line)
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="radarnaque-eval-identify", description=__doc__)
    parser.add_argument("file", type=Path, help="fichier .jsonl : {scan, expected} par ligne")
    args = parser.parse_args(argv)
    try:
        cases = load_cases(args.file)
    except OSError:
        return _fail(f"lecture de {args.file} impossible")
    except ValueError as exc:
        return _fail(str(exc))
    if not cases:
        return _fail("aucune annonce dans le fichier")
    try:
        settings = Settings()  # type: ignore[call-arg]
    except ValidationError as exc:
        fields = sorted({".".join(str(p) for p in e["loc"]) for e in exc.errors()})
        return _fail(f"configuration invalide ({', '.join(fields)})")
    try:
        return asyncio.run(evaluate(settings, cases))
    except SQLAlchemyError as exc:
        return _fail(f"base de données inaccessible ({type(exc).__name__})", EXIT_ERROR)
