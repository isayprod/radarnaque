"""Écrit le schéma OpenAPI (JSON trié) sur stdout. N'a besoin ni d'environnement ni de base."""

import json
import sys

from radarnaque_api.config import Settings
from radarnaque_api.main import create_app


def build_schema() -> dict:
    # Valeurs factices : le schéma ne dépend pas de la configuration, et la base n'est jamais
    # ouverte (le moteur est créé dans le lifespan, que l'on ne démarre pas).
    settings = Settings(
        database_url="postgresql+psycopg://openapi:openapi@localhost:5432/openapi",
        jwks_url="http://localhost:3000/auth/jwks",
        jwt_issuer="http://localhost:8080",
        jwt_audience="http://localhost:8080",
        internal_api_secret="x" * 32,  # type: ignore[arg-type]
        env="test",
    )
    return create_app(settings).openapi()


def main() -> None:
    sys.stdout.write(json.dumps(build_schema(), indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
