"""Fournisseurs LLM décrits dans `providers.toml` (aucun secret, que le nom des variables)."""

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, get_args

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.models.reference import Model

StructuredOutput = Literal["json_schema", "json_object"]
CostSource = Literal["usage_cost", "omniroute_headers", "none"]

_KNOWN_KEYS = {
    "base_url",
    "api_key_env",
    "base_url_env",
    "structured_output",
    "cost_source",
    "extra_body",
}


class ProviderError(Exception):
    """Fichier de fournisseurs invalide, clé absente ou fournisseur inconnu."""


@dataclass(frozen=True)
class ProviderConfig:
    code: str
    base_url: str
    api_key_env: str | None
    base_url_env: str | None
    structured_output: StructuredOutput
    cost_source: CostSource
    extra_body: dict

    def resolved_base_url(self, env: Mapping[str, str]) -> str:
        """`base_url_env`, s'il est défini et non vide dans `env`, l'emporte sur `base_url`."""
        if self.base_url_env and env.get(self.base_url_env):
            return env[self.base_url_env]
        return self.base_url

    def api_key(self, env: Mapping[str, str]) -> str:
        """Clé du fournisseur ; "" s'il n'en a pas. Aucune valeur dans le message d'erreur."""
        if self.api_key_env is None:
            return ""
        value = env.get(self.api_key_env)
        if not value:
            raise ProviderError(
                f"fournisseur {self.code} : variable d'environnement {self.api_key_env} absente"
            )
        return value


def _optional_str(code: str, raw: Mapping[str, Any], key: str) -> str | None:
    value = raw.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ProviderError(f"providers.{code}.{key} : chaîne non vide attendue")
    return value


def _choice[T: str](code: str, raw: Mapping[str, Any], key: str, literal: Any) -> T:
    allowed = get_args(literal)
    value = raw.get(key)
    if value not in allowed:
        raise ProviderError(f"providers.{code}.{key} : valeur parmi {', '.join(allowed)} attendue")
    return value  # type: ignore[return-value]


def _parse_provider(code: str, raw: object) -> ProviderConfig:
    if not isinstance(raw, dict):
        raise ProviderError(f"providers.{code} : table attendue")
    for key in sorted(set(raw) - _KNOWN_KEYS):
        raise ProviderError(f"providers.{code}.{key} : clé inconnue")
    base_url = _optional_str(code, raw, "base_url")
    if base_url is None:
        raise ProviderError(f"providers.{code}.base_url : obligatoire")
    extra_body = raw.get("extra_body", {})
    if not isinstance(extra_body, dict):
        raise ProviderError(f"providers.{code}.extra_body : table attendue")
    return ProviderConfig(
        code=code,
        base_url=base_url,
        api_key_env=_optional_str(code, raw, "api_key_env"),
        base_url_env=_optional_str(code, raw, "base_url_env"),
        structured_output=_choice(code, raw, "structured_output", StructuredOutput),
        cost_source=_choice(code, raw, "cost_source", CostSource),
        extra_body=extra_body,
    )


def load_providers(path: Path) -> dict[str, ProviderConfig]:
    """Charge et valide le fichier ; `ProviderError` nomme le fichier, la clé ou la valeur."""
    try:
        with path.open("rb") as f:
            data = tomllib.load(f)
    except FileNotFoundError:
        raise ProviderError(f"{path} : fichier de fournisseurs introuvable") from None
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ProviderError(f"{path} : fichier de fournisseurs illisible ({exc})") from exc
    table = data.get("providers")
    if not isinstance(table, dict) or not table:
        raise ProviderError(f"{path} : table `providers` absente ou vide")
    return {code: _parse_provider(code, raw) for code, raw in table.items()}


async def ensure_models_use_known_providers(
    session: AsyncSession, providers: Mapping[str, ProviderConfig]
) -> None:
    """Échoue si une ligne de `models` référence un fournisseur absent de `providers.toml`."""
    used = set((await session.scalars(select(Model.provider).distinct())).all())
    unknown = sorted(used - set(providers))
    if unknown:
        raise ProviderError(
            f"models.provider : fournisseur inconnu dans providers.toml : {', '.join(unknown)}"
        )
