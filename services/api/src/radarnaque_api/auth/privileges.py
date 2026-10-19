"""Privilèges d'un compte, déduits de son rôle et de l'environnement (spec §5.3 bis).

| Cas                       | unlimited | all_features | rate_limited | debug | plan_override |
|---------------------------|-----------|--------------|--------------|-------|---------------|
| admin                     | vrai      | vrai         | vrai         | faux  | aucun         |
| superuser hors production | vrai      | vrai         | faux         | vrai  | premium       |
| superuser en production   | faux      | faux         | vrai         | faux  | aucun         |
| user (ou rôle inconnu)    | faux      | faux         | vrai         | faux  | aucun         |
"""

import logging
from dataclasses import dataclass

from radarnaque_api.config import Settings
from radarnaque_api.models.auth_user import AuthUser

logger = logging.getLogger("radarnaque.privileges")


@dataclass(frozen=True)
class Privileges:
    """`unlimited` : ni quota ni abonnement requis ; `all_features` : photos et icônes des
    cartes sans regarder l'offre ; `rate_limited` : soumis à la limite de requêtes par minute ;
    `debug` : informations de débogage dans les réponses (superuser de développement) ;
    `plan_override` : code du plan dont `/api/me` reprend l'offre (fonctionnalités, photos) à la
    place de l'abonnement ; `None` : l'offre réelle du compte."""

    unlimited: bool
    all_features: bool
    rate_limited: bool
    debug: bool
    plan_override: str | None = None


_ADMIN = Privileges(unlimited=True, all_features=True, rate_limited=True, debug=False)
_SUPERUSER = Privileges(
    unlimited=True, all_features=True, rate_limited=False, debug=True, plan_override="premium"
)
_ORDINARY = Privileges(unlimited=False, all_features=False, rate_limited=True, debug=False)


def privileges_of(user: AuthUser, settings: Settings) -> Privileges:
    """Privilèges de `user`. Sans effet de bord, hormis une ligne WARNING quand un compte
    `superuser` se présente en production : il y est traité comme un compte ordinaire. Ni son
    identifiant ni son email ne sont journalisés."""
    if user.role == "admin":
        return _ADMIN
    if user.role == "superuser":
        if settings.env != "production":
            return _SUPERUSER
        logger.warning("rôle superuser ignoré en production")
    return _ORDINARY
