from datetime import UTC, datetime

import pytest

from radarnaque_api.services.periods import current_period_start


def _dt(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=UTC)


@pytest.mark.parametrize(
    "anchor,now,expected",
    [
        ("2026-01-31T10:00", "2026-03-15T00:00", "2026-02-28T10:00"),
        ("2026-01-31T10:00", "2026-03-31T11:00", "2026-03-31T10:00"),
        ("2026-01-31T10:00", "2026-03-31T09:00", "2026-02-28T10:00"),
        ("2026-05-15T00:00", "2026-05-15T00:00", "2026-05-15T00:00"),
        ("2025-12-10T00:00", "2026-01-09T23:59", "2025-12-10T00:00"),
        # Année bissextile et passage d'année.
        ("2027-12-31T00:00", "2028-02-29T12:00", "2028-02-29T00:00"),
        ("2025-11-30T08:00", "2026-01-05T00:00", "2025-12-30T08:00"),
    ],
)
def test_current_period_start(anchor: str, now: str, expected: str) -> None:
    assert current_period_start(_dt(anchor), _dt(now)) == _dt(expected)


def test_current_period_start_before_anchor_returns_anchor() -> None:
    anchor = _dt("2026-05-15T00:00")
    assert current_period_start(anchor, _dt("2026-05-01T00:00")) == anchor
