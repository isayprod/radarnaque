from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    UniqueConstraint,
    false,
    func,
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
