import calendar
from datetime import UTC, datetime


def _add_months(anchor: datetime, months: int) -> datetime:
    """`anchor` décalé de `months` mois ; le jour d'origine est plafonné à la fin du mois."""
    index = anchor.year * 12 + (anchor.month - 1) + months
    year, month0 = divmod(index, 12)
    month = month0 + 1
    day = min(anchor.day, calendar.monthrange(year, month)[1])
    return anchor.replace(year=year, month=month, day=day)


def current_period_start(anchor: datetime, now: datetime) -> datetime:
    """Dernier anniversaire mensuel de `anchor` qui est ≤ `now` (calendrier UTC).

    Le jour est toujours plafonné à partir du jour d'origine : 31 janv. → 28 févr. → 31 mars.
    Fonction pure : aucun accès à la base ni à l'horloge. Avant `anchor`, renvoie `anchor`.
    """
    anchor = anchor.astimezone(UTC)
    now = now.astimezone(UTC)
    if now <= anchor:
        return anchor
    months = (now.year - anchor.year) * 12 + (now.month - anchor.month)
    candidate = _add_months(anchor, months)
    if candidate > now:
        candidate = _add_months(anchor, months - 1)
    return candidate
