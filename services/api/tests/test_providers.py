from pathlib import Path

import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from radarnaque_api.config import Settings
from radarnaque_api.llm.providers import (
    ProviderConfig,
    ProviderError,
    ensure_models_use_known_providers,
    load_providers,
)
from radarnaque_api.main import create_app

REPO_PROVIDERS = Path(__file__).resolve().parents[1] / "providers.toml"

VALID = """
[providers.p]
base_url = "http://x/v1"
structured_output = "json_schema"
cost_source = "none"
"""


def _write(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "providers.toml"
    path.write_text(content, encoding="utf-8")
    return path


def test_repo_file_loads_the_four_providers():
    providers = load_providers(REPO_PROVIDERS)
    assert set(providers) == {"openrouter", "omniroute", "ollama", "stub"}
    openrouter = providers["openrouter"]
    assert openrouter.code == "openrouter"
    assert openrouter.api_key_env == "OPENROUTER_API_KEY"
    assert openrouter.structured_output == "json_schema"
    assert openrouter.cost_source == "usage_cost"
    assert openrouter.extra_body["provider"] == {"data_collection": "deny"}
    assert providers["omniroute"].structured_output == "json_object"
    assert providers["ollama"].api_key_env is None
    assert providers["stub"].extra_body == {}


def test_repo_file_contains_no_secret():
    # Le fichier ne donne que le nom des variables d'environnement.
    content = REPO_PROVIDERS.read_text(encoding="utf-8")
    assert "sk-" not in content


def test_default_providers_file_is_repo_file(monkeypatch):
    monkeypatch.delenv("PROVIDERS_FILE", raising=False)
    s = Settings(
        database_url="postgres://u:p@h/d",
        jwks_url="http://j",
        jwt_issuer="i",
        jwt_audience="a",
        internal_api_secret="s" * 32,  # type: ignore[arg-type]
    )
    assert s.providers_file == REPO_PROVIDERS


def test_unknown_structured_output_names_the_key(tmp_path):
    path = _write(tmp_path, VALID.replace("json_schema", "yaml"))
    with pytest.raises(ProviderError, match=r"providers\.p\.structured_output"):
        load_providers(path)


def test_unknown_cost_source_names_the_key(tmp_path):
    path = _write(tmp_path, VALID.replace('"none"', '"magic"'))
    with pytest.raises(ProviderError, match=r"providers\.p\.cost_source"):
        load_providers(path)


def test_missing_base_url_names_the_key(tmp_path):
    path = _write(tmp_path, VALID.replace('base_url = "http://x/v1"\n', ""))
    with pytest.raises(ProviderError, match=r"providers\.p\.base_url"):
        load_providers(path)


def test_unknown_key_is_rejected(tmp_path):
    path = _write(tmp_path, VALID + 'api_key = "sk-oops"\n')
    with pytest.raises(ProviderError, match=r"providers\.p\.api_key") as exc:
        load_providers(path)
    assert "sk-oops" not in str(exc.value)


def test_malformed_toml(tmp_path):
    path = _write(tmp_path, "[providers.p\nbase_url = ")
    with pytest.raises(ProviderError, match="providers.toml"):
        load_providers(path)


def test_missing_file(tmp_path):
    with pytest.raises(ProviderError, match="introuvable"):
        load_providers(tmp_path / "nope.toml")


def test_no_providers_table(tmp_path):
    with pytest.raises(ProviderError, match="providers"):
        load_providers(_write(tmp_path, "x = 1\n"))


def _config(**overrides) -> ProviderConfig:
    base = {
        "code": "p",
        "base_url": "http://file/v1",
        "api_key_env": "P_KEY",
        "base_url_env": "P_URL",
        "structured_output": "json_schema",
        "cost_source": "none",
        "extra_body": {},
    }
    return ProviderConfig(**{**base, **overrides})


def test_api_key_reads_the_environment():
    assert _config().api_key({"P_KEY": "sk-abc"}) == "sk-abc"


def test_api_key_empty_without_api_key_env():
    assert _config(api_key_env=None).api_key({}) == ""


def test_api_key_missing_raises_without_leaking_values():
    with pytest.raises(ProviderError, match="P_KEY"):
        _config().api_key({"OTHER": "sk-secret-value"})
    with pytest.raises(ProviderError, match="P_KEY") as exc:
        _config().api_key({"P_KEY": ""})
    assert "sk-secret-value" not in str(exc.value)


def test_resolved_base_url_env_wins():
    assert _config().resolved_base_url({"P_URL": "http://env/v1"}) == "http://env/v1"
    assert _config().resolved_base_url({}) == "http://file/v1"
    assert _config(base_url_env=None).resolved_base_url({"P_URL": "http://env/v1"}) == (
        "http://file/v1"
    )


async def test_known_providers_pass(db: AsyncSession):
    await ensure_models_use_known_providers(db, load_providers(REPO_PROVIDERS))


async def test_unknown_provider_in_models_names_it(db: AsyncSession):
    await db.execute(text("insert into app.models(provider, slug) values ('ghost', 'm')"))
    await db.commit()
    try:
        with pytest.raises(ProviderError, match="ghost"):
            await ensure_models_use_known_providers(db, load_providers(REPO_PROVIDERS))
    finally:
        await db.execute(text("delete from app.models where provider = 'ghost'"))
        await db.commit()


async def test_startup_fails_when_a_model_has_an_unknown_provider(
    settings: Settings, db: AsyncSession
):
    await db.execute(text("insert into app.models(provider, slug) values ('ghost', 'm')"))
    await db.commit()
    try:
        application: FastAPI = create_app(settings)
        with pytest.raises(ProviderError, match="ghost"):
            async with application.router.lifespan_context(application):
                pass
    finally:
        await db.execute(text("delete from app.models where provider = 'ghost'"))
        await db.commit()


async def test_startup_exposes_providers(app: FastAPI):
    assert set(app.state.providers) == {"openrouter", "omniroute", "ollama", "stub"}
