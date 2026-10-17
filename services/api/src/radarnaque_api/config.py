from pathlib import Path
from typing import Literal, Self
from urllib.parse import unquote, urlsplit

from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MIN_INTERNAL_SECRET_LENGTH = 32
# Préfixe des valeurs d'exemple de infra/.env.example : publiques, donc refusées en production.
_PLACEHOLDER_PREFIX = "change-me"
# providers.toml se trouve à côté de pyproject.toml (et /app/providers.toml dans l'image).
DEFAULT_PROVIDERS_FILE = Path(__file__).resolve().parents[2] / "providers.toml"
_DRIVER = "postgresql+psycopg://"
_ACCEPTED_PREFIXES = ("postgres://", "postgresql://", _DRIVER)


def _is_placeholder(value: str) -> bool:
    """Valeur d'exemple de infra/.env.example (préfixe `change-me`, casse ignorée)."""
    return value.lower().startswith(_PLACEHOLDER_PREFIX)


def normalize_database_url(value: str) -> str:
    """Accepte postgres://, postgresql:// et postgresql+psycopg://, renvoie le dernier."""
    for prefix in _ACCEPTED_PREFIXES:
        if value.startswith(prefix):
            return _DRIVER + value[len(prefix) :]
    raise ValueError(
        "DATABASE_URL doit commencer par postgres://, postgresql:// ou postgresql+psycopg://"
    )


class Settings(BaseSettings):
    """Configuration lue dans l'environnement (sans préfixe)."""

    model_config = SettingsConfigDict(extra="ignore")

    database_url: str
    jwks_url: str
    jwt_issuer: str
    jwt_audience: str
    internal_api_secret: SecretStr
    env: Literal["development", "test", "production"] = "development"
    providers_file: Path = DEFAULT_PROVIDERS_FILE

    @field_validator("internal_api_secret")
    @classmethod
    def _check_internal_secret(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < MIN_INTERNAL_SECRET_LENGTH:
            raise ValueError(
                f"INTERNAL_API_SECRET : au moins {MIN_INTERNAL_SECRET_LENGTH} caractères requis"
            )
        return value

    @field_validator("database_url")
    @classmethod
    def _normalize_database_url(cls, value: str) -> str:
        return normalize_database_url(value)

    @model_validator(mode="after")
    def _reject_placeholders_in_production(self) -> Self:
        if self.env != "production":
            return self
        if _is_placeholder(self.internal_api_secret.get_secret_value()):
            raise ValueError(
                "INTERNAL_API_SECRET : valeur d'exemple change-me refusée en production "
                "(générer avec `openssl rand -hex 32`)"
            )
        if _is_placeholder(unquote(urlsplit(self.database_url).password or "")):
            raise ValueError(
                "DATABASE_URL : mot de passe d'exemple change-me (POSTGRES_PASSWORD) "
                "refusé en production"
            )
        return self
