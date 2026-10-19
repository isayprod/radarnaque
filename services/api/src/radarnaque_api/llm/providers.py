"""Fournisseurs LLM décrits dans `providers.toml` (aucun secret, que le nom des variables)."""

import tomllib
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Literal, get_args

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.models.reference import Model

StructuredOutput = Literal["json_schema", "json_object"]
CostSource = Literal["usage_cost", "omniroute_headers", "none"]
# Paramètres d'appel qu'un fournisseur peut refuser (modèles de raisonnement, par exemple).
OmittableParam = Literal["temperature", "max_tokens"]
# API d'appel : Chat Completions (`/chat/completions`, par défaut) ou Responses (`/responses`).
ProviderApi = Literal["chat", "responses"]
# Effort de réflexion demandé au modèle (`none` : aucun paramètre de réflexion envoyé).
ReasoningEffort = Literal["none", "low", "medium", "high"]

_KNOWN_KEYS = {
    "base_url",
    "api_key_env",
    "base_url_env",
    "structured_output",
    "cost_source",
    "extra_body",
    "max_images",
    "omit_params",
    "api",
    "reasoning_effort",
}


class ProviderError(Exception):
    """Fichier de fournisseurs invalide, clé absente ou fournisseur inconnu."""


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({k: _freeze(v) for k, v in value.items()})
    if isinstance(value, list | tuple):
        return tuple(_freeze(v) for v in value)
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {k: _thaw(v) for k, v in value.items()}
    if isinstance(value, tuple):
        return [_thaw(v) for v in value]
    return value


def _check_http_url(value: str, where: str) -> None:
    if not value.startswith(("http://", "https://")):
        raise ProviderError(f"{where} : URL http:// ou https:// attendue")


@dataclass(frozen=True)
class ProviderConfig:
    """`extra_body` est stocké sous forme immuable (copie profonde, exclue du hachage) ;
    `extra_body_dict()` en rend une copie modifiable pour le client."""

    code: str
    base_url: str
    api_key_env: str | None
    base_url_env: str | None
    structured_output: StructuredOutput
    cost_source: CostSource
    extra_body: Mapping[str, Any] = field(hash=False)
    # Nombre maximal d'images par requête accepté par le fournisseur (None : pas de limite
    # propre, la limite globale des photos s'applique).
    max_images: int | None = None
    # Paramètres d'appel à ne pas envoyer à ce fournisseur.
    omit_params: tuple[OmittableParam, ...] = ()
    # API d'appel ; `max_tokens` dans `omit_params` retire aussi `max_output_tokens` (Responses).
    api: ProviderApi = "chat"
    # Si l'effort n'est pas `none` : `reasoning = { effort, summary = "auto" }` avec l'API
    # Responses, `reasoning = { effort }` dans le corps avec l'API Chat (paramètre d'OpenRouter).
    # Les résumés de réflexion sont relayés à l'extension.
    reasoning_effort: ReasoningEffort = "none"

    def __post_init__(self) -> None:
        object.__setattr__(self, "extra_body", _freeze(deepcopy(dict(self.extra_body))))

    def extra_body_dict(self) -> dict[str, Any]:
        """Copie profonde et modifiable de `extra_body`."""
        return _thaw(self.extra_body)

    def resolved_base_url(self, env: Mapping[str, str]) -> str:
        """`base_url_env`, s'il est défini et non vide dans `env`, l'emporte sur `base_url`."""
        if self.base_url_env and env.get(self.base_url_env):
            value = env[self.base_url_env]
            _check_http_url(value, f"fournisseur {self.code} : variable {self.base_url_env}")
            return value
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


def _optional_positive_int(code: str, raw: Mapping[str, Any], key: str) -> int | None:
    value = raw.get(key)
    if value is None:
        return None
    # bool est un sous-type d'int : `true` serait accepté comme 1.
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ProviderError(f"providers.{code}.{key} : entier positif attendu")
    return value


def _omit_params(code: str, raw: Mapping[str, Any]) -> tuple[OmittableParam, ...]:
    value = raw.get("omit_params", [])
    allowed = get_args(OmittableParam)
    if not isinstance(value, list) or any(item not in allowed for item in value):
        raise ProviderError(
            f"providers.{code}.omit_params : liste de valeurs parmi {', '.join(allowed)} attendue"
        )
    return tuple(value)


def _choice[T: str](
    code: str, raw: Mapping[str, Any], key: str, literal: Any, default: T | None = None
) -> T:
    allowed = get_args(literal)
    value = raw.get(key, default)
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
    _check_http_url(base_url, f"providers.{code}.base_url")
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
        max_images=_optional_positive_int(code, raw, "max_images"),
        omit_params=_omit_params(code, raw),
        api=_choice(code, raw, "api", ProviderApi, default="chat"),
        reasoning_effort=_choice(code, raw, "reasoning_effort", ReasoningEffort, default="none"),
    )


def load_providers(path: Path) -> dict[str, ProviderConfig]:
    """Charge et valide le fichier ; `ProviderError` nomme le fichier, la clé ou la valeur."""
    try:
        with path.open("rb") as f:
            data = tomllib.load(f)
    except FileNotFoundError:
        raise ProviderError(f"{path} : fichier de fournisseurs introuvable") from None
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
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
