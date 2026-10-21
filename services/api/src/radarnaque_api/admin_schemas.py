"""Schémas de l'API admin."""

from datetime import datetime
from typing import Any

from radarnaque_api.schemas import CamelModel


class AdminActionOut(CamelModel):
    """Une ligne du journal des modifications faites depuis l'admin. `admin_email` vient de
    `auth.user` (affichage seulement) ; il est `None` quand l'admin a été supprimé."""

    id: int
    action: str
    admin_user_id: str | None
    admin_email: str | None
    target_user_id: str | None
    details: dict[str, Any]
    created_at: datetime
