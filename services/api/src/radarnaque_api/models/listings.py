from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from radarnaque_api.models.base import Base


class Listing(Base):
    __tablename__ = "listings"
    __table_args__ = (UniqueConstraint("site_id", "external_id"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("app.sites.id"))
    external_id: Mapped[str]


class ListingSnapshot(Base):
    """État d'une annonce à un instant donné ; la description est déjà masquée (contacts)."""

    __tablename__ = "listing_snapshots"
    __table_args__ = (
        # Un prix n'a de sens qu'avec sa devise, et inversement.
        CheckConstraint(
            "(price_cents IS NULL) = (currency IS NULL)", name="ck_listing_snapshots_price_currency"
        ),
        UniqueConstraint("listing_id", "content_hash"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    listing_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("app.listings.id"))
    content_hash: Mapped[str]
    title: Mapped[str]
    description: Mapped[str]
    price_cents: Mapped[int | None]
    currency: Mapped[str | None] = mapped_column(ForeignKey("app.currencies.code"))
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class SnapshotImage(Base):
    __tablename__ = "snapshot_images"

    snapshot_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("app.listing_snapshots.id"), primary_key=True
    )
    position: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str]
