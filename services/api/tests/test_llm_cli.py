from collections.abc import Iterator
from pathlib import Path

import psycopg
import pytest

from radarnaque_api.llm.cli import main

REPO_PROVIDERS = Path(__file__).resolve().parents[1] / "providers.toml"


@pytest.fixture
def cli_env(pg_url: str, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Environnement du CLI ; restaure les modèles actifs et supprime les modèles créés."""
    monkeypatch.setenv("DATABASE_URL", pg_url)
    monkeypatch.setenv("PROVIDERS_FILE", str(REPO_PROVIDERS))
    for name in ("OPENROUTER_API_KEY", "OMNIROUTE_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    raw = pg_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(raw, autocommit=True) as conn:
        before = conn.execute("select code, active_model_id from app.scan_kinds").fetchall()
        known = {r[0] for r in conn.execute("select id from app.models").fetchall()}
    yield
    with psycopg.connect(raw, autocommit=True) as conn:
        for code, model_id in before:
            conn.execute(
                "update app.scan_kinds set active_model_id = %s where code = %s", (model_id, code)
            )
        conn.execute("delete from app.models where id <> all(%s)", (list(known),))


def _active(pg_url: str, kind: str) -> tuple[str, str]:
    raw = pg_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(raw) as conn:
        row = conn.execute(
            "select m.provider, m.slug from app.scan_kinds k"
            " join app.models m on m.id = k.active_model_id where k.code = %s",
            (kind,),
        ).fetchone()
    assert row is not None
    return row


def test_use_creates_and_activates_the_model(cli_env, pg_url, capsys):
    assert main(["use", "omniroute", "auto", "--kind", "text"]) == 0
    assert _active(pg_url, "text") == ("omniroute", "auto")
    assert "omniroute/auto" in capsys.readouterr().out
    # Idempotent : la ligne `models` existe déjà, pas de doublon.
    assert main(["use", "omniroute", "auto", "--kind", "text"]) == 0
    raw = pg_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(raw) as conn:
        count = conn.execute(
            "select count(*) from app.models where provider = 'omniroute' and slug = 'auto'"
        ).fetchone()
    assert count == (1,)


def test_use_reuses_an_existing_model(cli_env, pg_url):
    before = _active(pg_url, "image")
    assert main(["use", "openrouter", "google/gemini-2.5-flash-lite", "--kind", "image"]) == 0
    assert _active(pg_url, "image") == ("openrouter", "google/gemini-2.5-flash-lite")
    assert before != _active(pg_url, "image")


def test_use_unknown_provider_exits_2(cli_env, pg_url, capsys):
    before = _active(pg_url, "text")
    assert main(["use", "nope", "x", "--kind", "text"]) == 2
    err = capsys.readouterr().err
    assert "nope" in err
    assert _active(pg_url, "text") == before


def test_use_invalid_kind_exits_2(cli_env, capsys):
    assert main(["use", "omniroute", "auto", "--kind", "video"]) == 2


def test_missing_command_exits_2(cli_env, capsys):
    assert main([]) == 2


def test_invalid_providers_file_exits_2(cli_env, monkeypatch, tmp_path, capsys):
    bad = tmp_path / "providers.toml"
    bad.write_text("[providers.p]\n", encoding="utf-8")
    monkeypatch.setenv("PROVIDERS_FILE", str(bad))
    assert main(["list"]) == 2
    assert "providers.p.base_url" in capsys.readouterr().err


def test_list_never_prints_key_values(cli_env, monkeypatch, capsys):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test-secret")
    assert main(["list"]) == 0
    out = capsys.readouterr().out
    assert "sk-test-secret" not in out
    openrouter_line = next(
        line for line in out.splitlines() if line.strip().startswith("openrouter")
    )
    assert "clé: oui" in openrouter_line
    omniroute_line = next(line for line in out.splitlines() if line.strip().startswith("omniroute"))
    assert "clé: non" in omniroute_line
    # ollama et stub n'ont pas de variable de clé.
    for code in ("ollama", "stub"):
        assert code in out


def test_list_shows_models_and_active_ones(cli_env, capsys):
    assert main(["list"]) == 0
    out = capsys.readouterr().out
    assert "google/gemini-2.5-flash-lite" in out
    assert "google/gemini-3.1-flash-lite" in out
    assert "text" in out and "image" in out
    assert "actif" in out
