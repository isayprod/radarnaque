from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.auth.deps import require_internal_secret
from radarnaque_api.db import get_session
from radarnaque_api.errors import ApiError
from radarnaque_api.models import AuthUser
from radarnaque_api.schemas import BootstrapOut
from radarnaque_api.services.subscriptions import bootstrap_trial

router = APIRouter(dependencies=[Depends(require_internal_secret)])


@router.post("/api/internal/users/{user_id}/bootstrap", response_model=BootstrapOut)
async def bootstrap_user(
    user_id: str, session: Annotated[AsyncSession, Depends(get_session)]
) -> BootstrapOut:
    """Appelé par le service auth à la création d'un utilisateur. Idempotent."""
    if await session.get(AuthUser, user_id) is None:
        raise ApiError(404, "not_found", "Utilisateur inconnu.")
    created = await bootstrap_trial(session, user_id)
    await session.commit()
    return BootstrapOut(created=created)
