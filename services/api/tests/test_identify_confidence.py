import pytest

from radarnaque_api.identify.confidence import (
    CheckEvidence,
    ObjectEvidence,
    level_of,
    object_confidence,
    overall_status,
)


def _seen(decisive: bool = True, single_source: bool = False) -> CheckEvidence:
    return CheckEvidence(decisive=decisive, single_source=single_source, observation="seen_match")


def _not_visible(decisive: bool = True, single_source: bool = False) -> CheckEvidence:
    return CheckEvidence(decisive=decisive, single_source=single_source, observation="not_visible")


def _contrary(decisive: bool = True, single_source: bool = False) -> CheckEvidence:
    return CheckEvidence(
        decisive=decisive, single_source=single_source, observation="seen_contrary"
    )


def _ev(**overrides) -> ObjectEvidence:
    base = {
        "candidate_count": 2,
        "reference": "apple iphone 13",
        "checks": (),
        "reference_read_and_found": False,
        "photos": 2,
        "unsourced": False,
        "criteria_step": True,
        "verified": False,
    }
    base.update(overrides)
    return ObjectEvidence(**base)


@pytest.mark.parametrize(
    ("evidence", "expected"),
    [
        # Un seul candidat connu : 85.
        (_ev(candidate_count=1), 85),
        # Un seul candidat et une seule photo : toujours 85.
        (_ev(candidate_count=1, photos=1), 85),
        # Un seul candidat vérifié par un admin : 85 + 5.
        (_ev(candidate_count=1, verified=True), 90),
        # Deux décisifs vus sur deux : 40 + 55 = 95.
        (_ev(checks=(_seen(), _seen())), 95),
        # Un vu et un not_visible sur deux décisifs : floor(67,5 + 0,5) = 68, sous le plafond de 70.
        (_ev(checks=(_seen(), _not_visible())), 68),
        # Deux décisifs vus, l'un d'une seule source : 40 + 55 × 1,5/1,5 = 95.
        (_ev(checks=(_seen(), _seen(single_source=True))), 95),
        # Un décisif vu et un non décisif not_visible : 40 + 55 × 1/(4/3) = 81,25 → 81.
        (_ev(checks=(_seen(), _not_visible(decisive=False))), 81),
        # Un seen_contrary : 50 au plus.
        (_ev(checks=(_seen(), _contrary())), 50),
        # Référence lue et trouvée, rien d'autre : plancher 95.
        (_ev(reference_read_and_found=True), 95),
        # Référence lue et trouvée avec une seule photo : pas de plafond 85.
        (_ev(reference_read_and_found=True, photos=1), 95),
        # Non sourcé avec deux décisifs vus : 70 au plus.
        (_ev(checks=(_seen(), _seen()), unsourced=True), 70),
        # Accessoire sans étape criteria, deux candidats : 84 au plus.
        (_ev(checks=(_seen(), _seen()), criteria_step=False), 84),
        # Vérifié avec une référence lue et trouvée : 95 + 5 plafonné à 99.
        (_ev(reference_read_and_found=True, verified=True), 99),
        # Référence nulle : 59 au plus.
        (_ev(reference=None, checks=(_seen(), _seen())), 59),
        # Aucun critère et deux candidats : 40.
        (_ev(), 40),
    ],
)
def test_object_confidence(evidence: ObjectEvidence, expected: int) -> None:
    assert object_confidence(evidence) == expected


@pytest.mark.parametrize(
    ("confidence", "reference", "expected"),
    [
        (85, "apple iphone 13", "sure"),
        (84, "apple iphone 13", "probable"),
        (60, "apple iphone 13", "probable"),
        (59, "apple iphone 13", "uncertain"),
        (90, None, "uncertain"),
    ],
)
def test_level_of(confidence: int, reference: str | None, expected: str) -> None:
    assert level_of(confidence, reference) == expected


@pytest.mark.parametrize(
    ("main_level", "expected"),
    [
        ("sure", "identified"),
        ("probable", "identified"),
        ("uncertain", "uncertain"),
        (None, "none"),
    ],
)
def test_overall_status(main_level: str | None, expected: str) -> None:
    assert overall_status(main_level) == expected
