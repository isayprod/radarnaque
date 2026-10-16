from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_DRIVER = "postgresql+psycopg://"
_ACCEPTED_PREFIXES = ("postgres://", "postgresql://", _DRIVER)


class Settings(BaseSettings):
    """Configuration lue dans l'environnement (sans préfixe)."""

    model_config = SettingsConfigDict(extra="ignore")

    database_url: str
    jwks_url: str
    jwt_issuer: str
    jwt_audience: str
    internal_api_secret: SecretStr
    env: Literal["development", "test", "production"] = "development"

    @field_validator("database_url")
    @classmethod
    def _normalize_database_url(cls, value: str) -> str:
        """Accepte postgres://, postgresql:// et postgresql+psycopg://, renvoie le dernier."""
        for prefix in _ACCEPTED_PREFIXES:
            if value.startswith(prefix):
                return _DRIVER + value[len(prefix) :]
        raise ValueError(
            "DATABASE_URL doit commencer par postgres://, postgresql:// ou postgresql+psycopg://"
        )
