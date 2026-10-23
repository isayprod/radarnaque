"""Indice de confiance d'un objet identifié (spec §4).

Calculé par l'API à partir des observations des critères, jamais recopié du modèle. Fonctions
pures : aucune base, aucune I/O. Les poids et plafonds sont des constantes du module."""

from dataclasses import dataclass
from fractions import Fraction
from math import floor
from typing import Literal

SINGLE_CANDIDATE = 85
FLOOR_READ_REFERENCE = 95
NO_CRITERIA = 40
CRITERIA_SPAN = 55
NON_DECISIVE_WEIGHT = Fraction(1, 3)
SINGLE_SOURCE_WEIGHT = Fraction(1, 2)
CONTRARY_CAP = 50
NOT_VISIBLE_DECISIVE_CAP = 70
SINGLE_PHOTO_CAP = 85
UNSOURCED_CAP = 70
NO_CRITERIA_STEP_CAP = 84
VERIFIED_BONUS = 5
GENERAL_CAP = 99
NO_REFERENCE_CAP = 59
SURE_MIN = 85
PROBABLE_MIN = 60

Level = Literal["sure", "probable", "uncertain"]


@dataclass(frozen=True)
class CheckEvidence:
    """Un critère `photo` : décisif ou non, tiré d'une seule source ou non, et son observation."""

    decisive: bool
    single_source: bool
    observation: Literal["seen_match", "seen_contrary", "not_visible"]


@dataclass(frozen=True)
class ObjectEvidence:
    candidate_count: int
    reference: str | None
    checks: tuple[CheckEvidence, ...]
    reference_read_and_found: bool
    photos: int
    unsourced: bool
    criteria_step: bool
    verified: bool


def _weight(check: CheckEvidence) -> Fraction:
    weight = Fraction(1) if check.decisive else NON_DECISIVE_WEIGHT
    return weight * (SINGLE_SOURCE_WEIGHT if check.single_source else 1)


def object_confidence(e: ObjectEvidence) -> int:
    if e.candidate_count == 1:
        c = SINGLE_CANDIDATE
    else:
        total = sum(_weight(k) for k in e.checks)
        seen = sum(_weight(k) for k in e.checks if k.observation == "seen_match")
        # Arrondi « ,5 vers le haut » : floor(x + 0,5), exact grâce aux fractions.
        c = (
            NO_CRITERIA
            if total == 0
            else floor(NO_CRITERIA + CRITERIA_SPAN * seen / total + Fraction(1, 2))
        )
    if e.reference_read_and_found:
        c = max(c, FLOOR_READ_REFERENCE)
    if any(k.observation == "seen_contrary" for k in e.checks):
        c = min(c, CONTRARY_CAP)
    if any(k.decisive and k.observation == "not_visible" for k in e.checks):
        c = min(c, NOT_VISIBLE_DECISIVE_CAP)
    if e.photos <= 1 and not e.reference_read_and_found:
        c = min(c, SINGLE_PHOTO_CAP)
    if e.unsourced:
        c = min(c, UNSOURCED_CAP)
    if not e.criteria_step and e.candidate_count > 1:
        c = min(c, NO_CRITERIA_STEP_CAP)
    if e.verified:
        c += VERIFIED_BONUS
    c = min(c, GENERAL_CAP)
    if e.reference is None:
        c = min(c, NO_REFERENCE_CAP)
    return c


def level_of(confidence: int, reference: str | None) -> Level:
    if reference is None or confidence < PROBABLE_MIN:
        return "uncertain"
    return "sure" if confidence >= SURE_MIN else "probable"


def overall_status(main_level: Level | None) -> Literal["identified", "uncertain", "none"]:
    """Statut d'après le niveau de l'objet principal (`None` : rien d'identifiable)."""
    if main_level is None:
        return "none"
    return "uncertain" if main_level == "uncertain" else "identified"
