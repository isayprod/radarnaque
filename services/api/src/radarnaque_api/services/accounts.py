from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.models import AuthUser


async def delete_account(session: AsyncSession, user_id: str) -> bool:
    """Supprime la ligne `auth."user"` ; les clés étrangères `ON DELETE CASCADE` effacent la
    session, les comptes liés, l'abonnement et l'historique des scans (résultats et échecs
    compris). Les analyses et les snapshots d'annonces restent : ils ne pointent pas vers
    l'utilisateur.

    Renvoie False si l'utilisateur n'existe plus. Ne valide pas la transaction."""
    result = await session.execute(delete(AuthUser).where(AuthUser.id == user_id))
    return result.rowcount > 0
