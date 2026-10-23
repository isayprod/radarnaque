from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    UniqueConstraint,
    false,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base


class Analysis(Base):
    """Résultat d'une analyse ; (snapshot, modèle, prompt, input_hash) est la clé du cache.

    Le niveau de risque et la validité du cache se calculent : ils ne sont pas stockés.
    """

    __tablename__ = "analyses"
    __table_args__ = (
        CheckConstraint("score between 0 and 100", name="ck_analyses_score_range"),
        UniqueConstraint("snapshot_id", "model_id", "prompt_version_id", "input_hash"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("app.listing_snapshots.id"))
    model_id: Mapped[int] = mapped_column(ForeignKey("app.models.id"))
    prompt_version_id: Mapped[int] = mapped_column(ForeignKey("app.prompt_versions.id"))
    rules_version: Mapped[int]
    input_hash: Mapped[str]
    score: Mapped[int]
    partial: Mapped[bool] = mapped_column(server_default=false())
    # L'IA juge que l'annonce vient d'un professionnel (vitrine) ; ce n'est pas un signal.
    professional: Mapped[bool] = mapped_column(server_default=false())
    # Nombre de photos réellement envoyées au modèle.
    images_analyzed: Mapped[int] = mapped_column(server_default="0")
    tokens_in: Mapped[int] = mapped_column(server_default="0")
    tokens_out: Mapped[int] = mapped_column(server_default="0")
    cost_usd_micros: Mapped[int] = mapped_column(BigInteger, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AnalysisText(Base):
    __tablename__ = "analysis_texts"

    analysis_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.analyses.id"), primary_key=True
    )
    locale: Mapped[str] = mapped_column(ForeignKey("app.locales.code"), primary_key=True)
    summary: Mapped[str]
    advice: Mapped[str]


class AnalysisReason(Base):
    __tablename__ = "analysis_reasons"
    __table_args__ = (UniqueConstraint("analysis_id", "position"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    analysis_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("app.analyses.id"))
    position: Mapped[int]
    severity: Mapped[str] = mapped_column(ForeignKey("app.severities.code"))


class AnalysisReasonText(Base):
    __tablename__ = "analysis_reason_texts"

    reason_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.analysis_reasons.id"), primary_key=True
    )
    locale: Mapped[str] = mapped_column(ForeignKey("app.locales.code"), primary_key=True)
    text: Mapped[str]


class AnalysisWebSearch(Base):
    """Une recherche web faite pour une analyse (affichée aussi quand l'analyse vient du cache)."""

    __tablename__ = "analysis_web_searches"

    analysis_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.analyses.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(primary_key=True)
    query: Mapped[str]
    aspect: Mapped[str]


class LlmCall(Base):
    """Un appel au modèle : une analyse, une identification ou des critères (insertion ou
    rafraîchissement sur place).

    Une analyse expirée est rafraîchie sur place : son coût, ses tokens et sa date sont écrasés.
    Cette trace garde donc chaque appel, pour les statistiques de coût et de cache. Elle ne relie
    un appel ni à un utilisateur ni à un scan.
    """

    __tablename__ = "llm_calls"
    __table_args__ = (
        Index("ix_llm_calls_created_at", "created_at"),
        Index("ix_llm_calls_analysis_id", "analysis_id"),
        Index("ix_llm_calls_identification_id", "identification_id"),
        Index(
            "ix_llm_calls_criteria_set_id",
            "criteria_set_id",
            postgresql_where=text("criteria_set_id is not null"),
        ),
        CheckConstraint(
            "step in ('read_photos', 'criteria', 'identify', 'scam')", name="ck_llm_calls_step"
        ),
        CheckConstraint(
            "num_nonnulls(analysis_id, identification_id, criteria_set_id) <= 1"
            " and (step <> 'scam' or analysis_id is not null)",
            name="ck_llm_calls_target",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    step: Mapped[str] = mapped_column(server_default="scam")
    # Une seule cible : l'analyse (étape `scam`), l'identification ou l'ensemble de critères.
    analysis_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("app.analyses.id"))
    identification_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("app.identifications.id")
    )
    criteria_set_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("app.criteria_sets.id", ondelete="SET NULL")
    )
    model_id: Mapped[int] = mapped_column(ForeignKey("app.models.id"))
    prompt_version_id: Mapped[int] = mapped_column(ForeignKey("app.prompt_versions.id"))
    tokens_in: Mapped[int] = mapped_column(server_default="0")
    tokens_out: Mapped[int] = mapped_column(server_default="0")
    images_analyzed: Mapped[int] = mapped_column(server_default="0")
    web_searches: Mapped[int] = mapped_column(server_default="0")
    cost_usd_micros: Mapped[int] = mapped_column(BigInteger, server_default="0")
