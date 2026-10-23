"""Commande `radarnaque-eval-identify` : lecture du jeu, justesse et synthèse (fonctions pures)."""

import json
from types import SimpleNamespace

import pytest

from radarnaque_api.identify.eval_cli import (
    Outcome,
    is_correct,
    load_cases,
    main,
    outcome_of,
    summary_lines,
)

SCAN = {
    "listing": {
        "site": "2ememain.be",
        "externalId": "m1",
        "url": "https://www.2ememain.be/a/m1",
        "title": "TITRE-SECRET",
        "description": "DESCRIPTION-SECRETE",
        "price": {"amountCents": 1000, "currency": "EUR"},
        "priceType": "fixed",
        "category": None,
        "condition": None,
        "postedAt": None,
        "location": {"city": None, "region": None, "country": None},
        "images": [],
        "seller": {},
    },
    "rules": {"version": 1, "signals": []},
    "trigger": "button",
}


def _write(tmp_path, *lines: str):
    path = tmp_path / "identify.jsonl"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_load_cases_reads_scan_and_expected(tmp_path):
    path = _write(tmp_path, json.dumps({"scan": SCAN, "expected": "Foo 1"}), "")
    [case] = load_cases(path)
    assert case.expected == "Foo 1"
    assert case.scan.listing.external_id == "m1"


@pytest.mark.parametrize(
    "line", ["pas du json", json.dumps({"scan": SCAN}), json.dumps({"scan": {}, "expected": "x"})]
)
def test_invalid_line_names_only_its_number(tmp_path, line):
    with pytest.raises(ValueError, match=r"ligne 1 invalide") as info:
        load_cases(_write(tmp_path, line))
    assert "SECRET" not in str(info.value)


def test_is_correct_ignores_case_and_accents():
    assert is_correct("galaxy s21", "Samsung Galaxy S21 5G")
    assert is_correct("Électrique", "velo electrique pliant")
    assert not is_correct("S22", "Samsung Galaxy S21")
    assert not is_correct("S21", None)


def _run(reference, level="sure", status="identified", calls=()):
    main_object = SimpleNamespace(role="main", reference=reference, level=level)
    return SimpleNamespace(
        objects=[main_object], status=status, calls=list(calls), images_analyzed=0
    )


def test_outcome_sums_cost_by_step():
    calls = [
        SimpleNamespace(step="read_photos", cost_usd_micros=100),
        SimpleNamespace(step="identify", cost_usd_micros=200),
        SimpleNamespace(step="identify", cost_usd_micros=50),
    ]
    outcome = outcome_of("foo", _run("Foo 1", calls=calls))
    assert outcome.correct and outcome.reference == "Foo 1"
    assert outcome.cost_by_step == {"read_photos": 100, "identify": 250}


def test_outcome_without_object_is_uncertain():
    run = SimpleNamespace(objects=[], status="none", calls=[], images_analyzed=0)
    outcome = outcome_of("foo", run)
    assert (outcome.level, outcome.reference, outcome.correct) == ("uncertain", None, False)


def test_summary_gives_accuracy_levels_and_average_cost_per_step():
    outcomes = [
        Outcome("identified", "sure", "A", True, {"identify": 2_000_000, "criteria": 1_000_000}),
        Outcome("uncertain", "uncertain", None, False, {"identify": 4_000_000}),
    ]
    text = "\n".join(summary_lines(outcomes, failures=1))
    assert "annonces : 3 (identifiées : 2, en échec : 1)" in text
    assert "justesse : 1/2 (50 %)" in text
    assert "niveaux : sure 1, probable 0, uncertain 1" in text
    assert "coût moyen identify : 3.00000 USD" in text
    assert "coût moyen criteria : 1.00000 USD" in text


def test_main_rejects_missing_and_empty_files(tmp_path, capsys):
    assert main([str(tmp_path / "absent.jsonl")]) == 2
    assert main([str(_write(tmp_path))]) == 2
    err = capsys.readouterr().err
    assert "lecture" in err and "aucune annonce" in err
