"""Sorties structurées des trois étapes d'identification (lecture des photos, critères,
vérification) et vues de la base de critères.

Les champs et leurs formes suivent les prompts figés de la migration 0011 (READ_PHOTOS_V1,
CRITERIA_V1, IDENTIFY_V1) : tous les champs sont requis (mode strict), `None` seulement là où le
prompt annonce `null`."""

from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

from radarnaque_api.llm.client import Bilingual, NonEmptyStr

SCHEMA_READ_PHOTOS = "radarnaque_read_photos"
SCHEMA_CRITERIA = "radarnaque_criteria"
SCHEMA_IDENTIFY = "radarnaque_identify"

PhotoNumber = Annotated[int, Field(ge=1, le=4)]


class ReadPhotosObject(BaseModel):
    role: Literal["main", "accessory"]
    category: str
    brand: str | None
    candidates: list[NonEmptyStr] = Field(min_length=1, max_length=3)
    relative_value: Literal["high", "medium", "low"]


class Clue(BaseModel):
    text: NonEmptyStr
    photo: PhotoNumber | None


class PhotoObservation(BaseModel):
    photo: PhotoNumber | None
    kind: Literal["catalog", "screenshot", "watermark", "inconsistency", "missing_object"]
    note: NonEmptyStr


class ReadPhotosOut(BaseModel):
    status: Literal["ok", "nothing"]
    objects: list[ReadPhotosObject] = Field(max_length=4)
    clues: list[Clue] = Field(max_length=10)
    read_reference: str | None
    hint_criteria: list[NonEmptyStr] = Field(max_length=6)
    photo_observations: list[PhotoObservation] = Field(max_length=6)
    title_mismatch: str | None

    @model_validator(mode="after")
    def _one_main_when_ok(self) -> "ReadPhotosOut":
        if self.status == "ok" and sum(o.role == "main" for o in self.objects) != 1:
            raise ValueError("status ok : exactement un objet main attendu")
        return self


class ExpectedValue(BaseModel):
    candidate: NonEmptyStr
    fr: NonEmptyStr
    nl: NonEmptyStr


class ExtractedCriterion(BaseModel):
    kind: Literal["photo", "ask_seller", "invisible"]
    decisive: bool
    fr: NonEmptyStr
    nl: NonEmptyStr
    expected: list[ExpectedValue] = Field(max_length=3)
    sources: list[Annotated[int, Field(ge=1)]] = Field(min_length=1, max_length=5)


class CriteriaOut(BaseModel):
    criteria: list[ExtractedCriterion] = Field(max_length=8)


class CheckOut(BaseModel):
    criterion: int
    observation: Literal["seen_match", "seen_contrary", "not_visible"]
    photo: int | None


class IdentifiedObjectOut(BaseModel):
    object: int
    checks: list[CheckOut]
    reference: str | None
    remaining: list[NonEmptyStr] = Field(max_length=3)
    pages: list[int] = Field(max_length=3)


class IdentifyOut(BaseModel):
    objects: list[IdentifiedObjectOut]
    seller_question: Bilingual | None
    retry_query: str | None


@dataclass(frozen=True)
class StoredCriterion:
    id: int
    position: int
    kind: Literal["photo", "ask_seller"]
    decisive: bool
    fr: str
    nl: str
    expected: dict[str, dict[str, str]]
    sources: tuple[tuple[str, str, str], ...]  # (url, title, domain)

    @property
    def single_source(self) -> bool:
        return len(self.sources) == 1


@dataclass(frozen=True)
class CriteriaSetView:
    id: int
    status: Literal["auto", "verified"]
    criteria: tuple[StoredCriterion, ...]
