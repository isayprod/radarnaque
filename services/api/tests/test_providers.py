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


def test_repo_file_loads_the_providers():
    providers = load_providers(REPO_PROVIDERS)
    assert set(providers) == {"openrouter", "groq", "openai-oauth", "omniroute", "ollama", "stub"}
    openrouter = providers["openrouter"]
    assert openrouter.code == "openrouter"
    assert openrouter.api_key_env == "OPENROUTER_API_KEY"
    assert openrouter.structured_output == "json_schema"
    assert openrouter.cost_source == "usage_cost"
    assert openrouter.extra_body["provider"] == {"data_collection": "deny"}
    assert providers["omniroute"].structured_output == "json_object"
    assert providers["ollama"].api_key_env is None
    assert providers["stub"].extra_body == {}
    assert providers["openrouter"].max_images is None


def test_repo_file_groq_and_openai_oauth():
    providers = load_providers(REPO_PROVIDERS)
    groq = providers["groq"]
    assert groq.base_url == "https://api.groq.com/openai/v1"
    assert groq.api_key_env == "GROQ_API_KEY"
    assert groq.structured_output == "json_object"
    assert groq.cost_source == "none"
    assert groq.max_images == 3  # modèle vision de Groq : 3 images par requête au plus
    oauth = providers["openai-oauth"]
    assert oauth.base_url == "http://127.0.0.1:10531/v1"
    assert oauth.base_url_env == "OPENAI_OAUTH_BASE_URL"
    assert oauth.api_key_env is None  # le proxy local utilise la session Codex, pas de clé
    assert oauth.structured_output == "json_object"  # le proxy ignore response_format
    assert oauth.cost_source == "none"
    # Les modèles de raisonnement du service Codex refusent `temperature` (400, que le proxy
    # transforme en 500).
    # `max_tokens` aussi : la réflexion élevée compte dans `max_output_tokens`.
    assert oauth.omit_params == ("temperature", "max_tokens")
    assert providers["openrouter"].omit_params == ()


def test_repo_file_openai_oauth_uses_the_responses_api():
    # Le proxy openai-oauth refuse les images en data URL sur /chat/completions (500), mais
    # les accepte sur /responses.
    providers = load_providers(REPO_PROVIDERS)
    assert providers["openai-oauth"].api == "responses"
    others = {code: p.api for code, p in providers.items() if code != "openai-oauth"}
    assert set(others.values()) == {"chat"}


def test_api_defaults_to_chat(tmp_path):
    assert load_providers(_write(tmp_path, VALID))["p"].api == "chat"
    assert _config().api == "chat"


def test_repo_file_reasoning_effort():
    providers = load_providers(REPO_PROVIDERS)
    assert providers["openai-oauth"].reasoning_effort == "high"
    assert providers["openrouter"].reasoning_effort == "low"
    assert "reasoning" not in providers["openrouter"].extra_body  # plus de `enabled = false`
    others = {
        p.reasoning_effort
        for code, p in providers.items()
        if code not in ("openai-oauth", "openrouter")
    }
    assert others == {"none"}


@pytest.mark.parametrize("value", ["none", "low", "medium", "high"])
def test_reasoning_effort_is_read(tmp_path, value):
    path = _write(tmp_path, VALID + f'reasoning_effort = "{value}"\n')
    assert load_providers(path)["p"].reasoning_effort == value


def test_reasoning_effort_defaults_to_none(tmp_path):
    assert load_providers(_write(tmp_path, VALID))["p"].reasoning_effort == "none"
    assert _config().reasoning_effort == "none"


@pytest.mark.parametrize("value", ['"max"', '"HIGH"', '""', "1", "true", '["low"]'])
def test_invalid_reasoning_effort_names_the_key(tmp_path, value):
    path = _write(tmp_path, VALID + f"reasoning_effort = {value}\n")
    with pytest.raises(ProviderError, match=r"providers\.p\.reasoning_effort"):
        load_providers(path)


@pytest.mark.parametrize("value", ['"responses"', '"chat"'])
def test_api_is_read(tmp_path, value):
    path = _write(tmp_path, VALID + f"api = {value}\n")
    assert load_providers(path)["p"].api == value.strip('"')


@pytest.mark.parametrize("value", ['"completions"', '""', "1", '["chat"]'])
def test_invalid_api_names_the_key(tmp_path, value):
    path = _write(tmp_path, VALID + f"api = {value}\n")
    with pytest.raises(ProviderError, match=r"providers\.p\.api"):
        load_providers(path)


def test_omit_params_is_read(tmp_path):
    path = _write(tmp_path, VALID + 'omit_params = ["temperature", "max_tokens"]\n')
    assert load_providers(path)["p"].omit_params == ("temperature", "max_tokens")


@pytest.mark.parametrize(
    "value", ['"temperature"', '["model"]', '["messages"]', "[1]", '["temperature", "top_p"]']
)
def test_omit_params_only_accepts_known_sampling_params(tmp_path, value):
    path = _write(tmp_path, VALID + f"omit_params = {value}\n")
    with pytest.raises(ProviderError, match=r"providers\.p\.omit_params"):
        load_providers(path)


def test_max_images_is_read(tmp_path):
    path = _write(tmp_path, VALID + "max_images = 2\n")
    assert load_providers(path)["p"].max_images == 2


@pytest.mark.parametrize("value", ["0", "-1", "'3'", "true", "1.5"])
def test_max_images_must_be_a_positive_integer(tmp_path, value):
    path = _write(tmp_path, VALID + f"max_images = {value}\n")
    with pytest.raises(ProviderError, match=r"providers\.p\.max_images"):
        load_providers(path)


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


@pytest.mark.parametrize(
    ("line", "key"),
    [
        ("base_url = true", "base_url"),
        ("base_url = 12", "base_url"),
        ("base_url = ''", "base_url"),
        ("base_url = 'ftp://x/v1'", "base_url"),
        ("base_url = 'localhost:11434/v1'", "base_url"),
        ("api_key_env = true", "api_key_env"),
        ("api_key_env = 3", "api_key_env"),
        ("api_key_env = ''", "api_key_env"),
        ("base_url_env = false", "base_url_env"),
        ("extra_body = 'x'", "extra_body"),
        ("extra_body = [1]", "extra_body"),
    ],
)
def test_wrongly_typed_values_name_the_key(tmp_path, line, key):
    content = (
        VALID.replace('base_url = "http://x/v1"\n', "") if line.startswith("base_url =") else VALID
    )
    path = _write(tmp_path, content + line + "\n")
    with pytest.raises(ProviderError, match=rf"providers\.p\.{key}"):
        load_providers(path)


def test_non_utf8_file(tmp_path):
    path = tmp_path / "providers.toml"
    path.write_bytes(b'[providers.p]\nbase_url = "http://x/\xff\xfe"\n')
    with pytest.raises(ProviderError, match="illisible"):
        load_providers(path)


def test_extra_body_is_immutable_and_copied(tmp_path):
    source = {"provider": {"order": ["a", "b"]}}
    config = _config(extra_body=source)
    source["provider"]["order"].append("c")  # la source ne doit pas affecter la config
    assert config.extra_body["provider"]["order"] == ("a", "b")
    with pytest.raises(TypeError):
        config.extra_body["x"] = 1  # type: ignore[index]
    with pytest.raises(TypeError):
        config.extra_body["provider"]["order"] = []  # type: ignore[index]
    hash(config)  # reste hachable


def test_extra_body_dict_returns_a_fresh_deep_copy():
    config = load_providers(REPO_PROVIDERS)["openrouter"]
    first = config.extra_body_dict()
    assert first["provider"] == {"data_collection": "deny"}
    assert type(first["provider"]) is dict
    first["provider"]["data_collection"] = "allow"
    assert config.extra_body_dict()["provider"] == {"data_collection": "deny"}
    assert config.extra_body["provider"]["data_collection"] == "deny"


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


def test_api_key_env_empty_name_is_a_missing_key():
    with pytest.raises(ProviderError, match="absente"):
        _config(api_key_env="").api_key({"OTHER": "x"})


def test_resolved_base_url_override_must_be_http():
    with pytest.raises(ProviderError, match="P_URL") as exc:
        _config().resolved_base_url({"P_URL": "file:///etc/passwd"})
    assert "passwd" not in str(exc.value)


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
    assert set(app.state.providers) == set(load_providers(REPO_PROVIDERS))
