from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Identity, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base


class ScanEvent(Base):
    __tablename__ = "scan_events"
    __table_args__ = (
        Index("ix_scan_events_user_kind_time", "user_id", "scan_kind", "created_at"),
        # Purge à 12 mois : recherche par date seule.
        Index("ix_scan_events_created_at", "created_at"),
        Index("ix_scan_events_user_purpose_time", "user_id", "purpose", "created_at"),
        CheckConstraint("purpose in ('identify', 'analyze')", name="ck_scan_events_purpose"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("auth.user.id", ondelete="CASCADE"))
    scan_kind: Mapped[str] = mapped_column(ForeignKey("app.scan_kinds.code"))
    trigger: Mapped[str] = mapped_column(ForeignKey("app.scan_triggers.code"))
    purpose: Mapped[str] = mapped_column(server_default="analyze")
    # L'`identify` qui a inclus cette analyse : elle ne compte alors pas dans le quota.
    included_by_event_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("app.scan_events.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ScanFailure(Base):
    """Un scan en échec ne consomme pas de quota."""

    __tablename__ = "scan_failures"

    scan_event_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.scan_events.id", ondelete="CASCADE"), primary_key=True
    )
    error_code: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ScanResult(Base):
    """Lie un scan réussi à l'analyse servie (« servi depuis le cache » se calcule)."""

    __tablename__ = "scan_results"
    __table_args__ = (Index("ix_scan_results_analysis_id", "analysis_id"),)

    scan_event_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.scan_events.id", ondelete="CASCADE"), primary_key=True
    )
    analysis_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("app.analyses.id"))
