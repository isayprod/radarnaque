from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Text,
    UniqueConstraint,
    false,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base

# Aucune de ces tables ne contient de donnée personnelle : elles survivent à la suppression d'un
# compte, comme `analyses`.


class CriteriaSet(Base):
    """Critères de reconnaissance d'un groupe de candidats ; base partagée entre les scans."""

    __tablename__ = "criteria_sets"
    __table_args__ = (
        CheckConstraint("status in ('auto', 'verified')", name="ck_criteria_sets_status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    # Noms normalisés, triés et joints.
    candidates_key: Mapped[str] = mapped_column(unique=True)
    candidates: Mapped[list[str]] = mapped_column(ARRAY(Text))
    status: Mapped[str] = mapped_column(server_default="auto")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    refreshed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Criterion(Base):
    __tablename__ = "criteria"
    __table_args__ = (
        CheckConstraint("kind in ('photo', 'ask_seller')", name="ck_criteria_kind"),
        UniqueConstraint("set_id", "position"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    set_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.criteria_sets.id", ondelete="CASCADE")
    )
    position: Mapped[int]
    kind: Mapped[str]
    decisive: Mapped[bool] = mapped_column(Boolean)
    text_fr: Mapped[str]
    text_nl: Mapped[str]
    # Candidat -> valeur attendue, en français et en néerlandais.
    expected: Mapped[dict] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    edited_by_admin: Mapped[bool] = mapped_column(server_default=false())


class CriterionSource(Base):
    __tablename__ = "criteria_sources"

    criterion_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.criteria.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str]
    title: Mapped[str]
    domain: Mapped[str]


class Identification(Base):
    """Résultat d'une identification ; (snapshot, config, input_hash) est la clé du cache."""

    __tablename__ = "identifications"
    __table_args__ = (
        CheckConstraint(
            "status in ('identified', 'uncertain', 'none')", name="ck_identifications_status"
        ),
        CheckConstraint("confidence between 0 and 100", name="ck_identifications_confidence"),
        UniqueConstraint("snapshot_id", "config_hash", "input_hash"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("app.listing_snapshots.id"))
    # Modèles et prompts des trois étapes.
    config_hash: Mapped[str]
    # Photos envoyées et leur taille.
    input_hash: Mapped[str]
    status: Mapped[str]
    confidence: Mapped[int]
    photo_observations: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))
    title_mismatch: Mapped[str | None]
    seller_question_fr: Mapped[str | None]
    seller_question_nl: Mapped[str | None]
    retried: Mapped[bool] = mapped_column(server_default=false())
    unsourced: Mapped[bool] = mapped_column(server_default=false())
    # Critères de l'objet principal relus par un admin, au moment de l'identification.
    verified_criteria: Mapped[bool] = mapped_column(server_default=false())
    images_analyzed: Mapped[int] = mapped_column(server_default="0")
    tokens_in: Mapped[int] = mapped_column(server_default="0")
    tokens_out: Mapped[int] = mapped_column(server_default="0")
    cost_usd_micros: Mapped[int] = mapped_column(BigInteger, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class IdentificationObject(Base):
    __tablename__ = "identification_objects"
    __table_args__ = (
        CheckConstraint("role in ('main', 'accessory')", name="ck_identification_objects_role"),
        CheckConstraint(
            "confidence between 0 and 100", name="ck_identification_objects_confidence"
        ),
        UniqueConstraint("identification_id", "position"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    identification_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.identifications.id", ondelete="CASCADE")
    )
    position: Mapped[int]
    role: Mapped[str]
    label: Mapped[str]
    reference: Mapped[str | None]
    confidence: Mapped[int]
    # Candidats restants quand la référence n'est pas tranchée.
    remaining: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'"))
    criteria_set_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("app.criteria_sets.id", ondelete="SET NULL")
    )


class IdentificationCheck(Base):
    __tablename__ = "identification_checks"
    __table_args__ = (
        CheckConstraint(
            "observation in ('seen_match', 'seen_contrary', 'not_visible')",
            name="ck_identification_checks_observation",
        ),
    )

    object_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("app.identification_objects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    position: Mapped[int] = mapped_column(primary_key=True)
    # Le critère de la base partagée peut être remplacé par un rafraîchissement : la vérification
    # garde une copie du critère tel qu'il a été vérifié.
    criterion_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("app.criteria.id", ondelete="SET NULL")
    )
    text_fr: Mapped[str]
    text_nl: Mapped[str]
    decisive: Mapped[bool] = mapped_column(Boolean)
    # [{url, title, domain}]
    sources: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))
    observation: Mapped[str]
    photo_index: Mapped[int | None]


class IdentificationPage(Base):
    """Page web lue pour identifier un objet (source affichée à l'utilisateur)."""

    __tablename__ = "identification_pages"

    object_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("app.identification_objects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    position: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str]
    title: Mapped[str]
    domain: Mapped[str]


class IdentificationSearch(Base):
    """Une recherche web faite pour une identification (affichée aussi depuis le cache)."""

    __tablename__ = "identification_searches"
    __table_args__ = (
        CheckConstraint(
            "kind in ('criteria', 'price', 'reference', 'retry')",
            name="ck_identification_searches_kind",
        ),
    )

    identification_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.identifications.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(primary_key=True)
    query: Mapped[str]
    kind: Mapped[str]
    # Domaines des pages lues.
    pages_read: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'"))


class IdentificationResult(Base):
    """Lie un scan `identify` à l'identification servie, comme `scan_results`."""

    __tablename__ = "identification_results"
    __table_args__ = (Index("ix_identification_results_identification_id", "identification_id"),)

    scan_event_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.scan_events.id", ondelete="CASCADE"), primary_key=True
    )
    identification_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("app.identifications.id"))
