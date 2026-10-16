from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Identity, Index, func
from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base


class ScanEvent(Base):
    __tablename__ = "scan_events"
    __table_args__ = (Index("ix_scan_events_user_kind_time", "user_id", "scan_kind", "created_at"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("auth.user.id", ondelete="CASCADE"))
    scan_kind: Mapped[str] = mapped_column(ForeignKey("app.scan_kinds.code"))
    trigger: Mapped[str] = mapped_column(ForeignKey("app.scan_triggers.code"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ScanFailure(Base):
    """Un scan en échec ne consomme pas de quota."""

    __tablename__ = "scan_failures"

    scan_event_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.scan_events.id", ondelete="CASCADE"), primary_key=True
    )
    error_code: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
