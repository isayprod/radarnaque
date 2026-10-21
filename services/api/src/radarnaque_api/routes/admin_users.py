from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.admin_schemas import (
    AdminPlanIn,
    AdminRoleIn,
    AdminUserListOut,
    AdminUserOut,
)
from radarnaque_api.auth.deps import AdminContext, require_admin
from radarnaque_api.db import get_session
from radarnaque_api.services import admin_users

router = APIRouter(prefix="/api/admin/users")

ListLimit = Annotated[int, Query(ge=1, le=50)]


def _now() -> datetime:
    return datetime.now(UTC)


@router.get("", response_model=AdminUserListOut)
async def list_users(
    _admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
    q: Annotated[str | None, Query(min_length=3, max_length=200)] = None,
    role: Literal["user", "admin", "superuser"] | None = None,
    plan: Annotated[str | None, Query(min_length=1, max_length=50)] = None,
    before: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
    limit: ListLimit = 50,
) -> AdminUserListOut:
    """Les comptes, du plus récent au plus ancien. `q` : sous-chaîne de l'email, casse ignorée
    (3 caractères au moins) ; `plan` : un code d'offre, ou `none` ; `before` : curseur."""
    return await admin_users.list_users(
        session, q=q, role=role, plan=plan, before=before, limit=limit, now=_now()
    )


@router.get("/{user_id}", response_model=AdminUserOut)
async def get_user(
    user_id: str,
    _admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AdminUserOut:
    return await admin_users.build_user_card(session, user_id, _now())


@router.post("/{user_id}/plan", response_model=AdminUserOut)
async def assign_plan(
    user_id: str,
    body: AdminPlanIn,
    admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AdminUserOut:
    """Attribue un plan (abonnement `manual`) ; l'abonnement actif est terminé."""
    await admin_users.assign_plan(session, admin_id=admin.user.id, user_id=user_id, plan=body.plan)
    await session.commit()
    return await admin_users.build_user_card(session, user_id, _now())


@router.post("/{user_id}/role", response_model=AdminUserOut)
async def set_role(
    user_id: str,
    body: AdminRoleIn,
    admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AdminUserOut:
    """Nomme ou retire un admin (jamais soi-même, jamais le dernier)."""
    await admin_users.set_role(session, admin_id=admin.user.id, user_id=user_id, role=body.role)
    await session.commit()
    return await admin_users.build_user_card(session, user_id, _now())


@router.delete("/{user_id}", status_code=204)
async def delete_user(
    user_id: str,
    admin: Annotated[AdminContext, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Supprime le compte et ses données (cascade), comme `DELETE /api/me`."""
    await admin_users.delete_user(session, admin_id=admin.user.id, user_id=user_id)
    await session.commit()
    return Response(status_code=204)
