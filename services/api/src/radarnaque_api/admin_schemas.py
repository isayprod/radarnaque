"""Schémas de l'API admin."""

from datetime import datetime
from typing import Any, Literal

from radarnaque_api.schemas import CamelInModel, CamelModel, QuotaOut, ScanHistoryItemOut


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


class AdminUserRowOut(CamelModel):
    """Une ligne de la liste des comptes. `used` et `remaining` sont ceux du quota `full` de
    l'abonnement actif ; `None` sans abonnement actif."""

    id: str
    email: str
    role: Literal["user", "admin", "superuser"]
    plan: str | None
    used: int | None
    remaining: int | None
    created_at: datetime
    last_scan_at: datetime | None


class AdminUserListOut(CamelModel):
    """Page de la liste, du plus récent au plus ancien ; `next_before` est à passer en `before`
    pour la page suivante (`None` : plus rien)."""

    items: list[AdminUserRowOut]
    next_before: str | None


class AdminSubscriptionOut(CamelModel):
    id: int
    plan: str
    status: str
    provider: str
    period_start: datetime
    period_end: datetime | None


class AdminUsageOut(CamelModel):
    """Consommation de l'abonnement actif, comme `GET /api/me`. `purged_scans` : scans de
    l'essai effacés par la purge, comptés dans le quota."""

    period_start: datetime
    quotas: list[QuotaOut]
    total_cap: QuotaOut | None
    purged_scans: int


class AdminUserOut(CamelModel):
    """Fiche d'un compte."""

    id: str
    email: str
    email_verified: bool
    created_at: datetime
    role: Literal["user", "admin", "superuser"]
    subscription: AdminSubscriptionOut | None
    usage: AdminUsageOut | None
    subscriptions: list[AdminSubscriptionOut]
    scans: list[ScanHistoryItemOut]
    actions: list[AdminActionOut]


class AdminPlanIn(CamelInModel):
    plan: str


class AdminRoleIn(CamelInModel):
    # `superuser` n'est jamais attribué depuis l'admin : refusé par la validation.
    role: Literal["admin", "user"]
