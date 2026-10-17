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
    assert "  text -> openrouter/google/gemini-2.5-flash-lite" in out
    assert "  image -> openrouter/google/gemini-3.1-flash-lite" in out


def test_list_shows_every_kind_when_one_model_is_active_for_both(cli_env, capsys):
    assert main(["use", "omniroute", "auto", "--kind", "text"]) == 0
    assert main(["use", "omniroute", "auto", "--kind", "image"]) == 0
    capsys.readouterr()
    assert main(["list"]) == 0
    out = capsys.readouterr().out
    assert "  text -> omniroute/auto" in out
    assert "  image -> omniroute/auto" in out


def test_list_shows_kind_without_active_model(cli_env, pg_url, capsys):
    raw = pg_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(raw, autocommit=True) as conn:
        conn.execute("alter table app.scan_kinds alter column active_model_id drop not null")
        conn.execute("update app.scan_kinds set active_model_id = null where code = 'image'")
    try:
        assert main(["list"]) == 0
        out = capsys.readouterr().out
    finally:
        # cli_env restaure ensuite les modèles actifs ; la contrainte est remise après coup.
        with psycopg.connect(raw, autocommit=True) as conn:
            conn.execute(
                "update app.scan_kinds set active_model_id = (select id from app.models"
                " where provider = 'openrouter' and slug = 'google/gemini-3.1-flash-lite')"
                " where code = 'image'"
            )
            conn.execute("alter table app.scan_kinds alter column active_model_id set not null")
    assert "  image -> (aucun)" in out
    assert "  text -> " in out


def test_list_key_presence_for_empty_variable_is_no(cli_env, monkeypatch, capsys):
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    assert main(["list"]) == 0
    line = next(
        ln for ln in capsys.readouterr().out.splitlines() if ln.strip().startswith("openrouter")
    )
    assert "clé: non" in line


def test_use_empty_slug_exits_2(cli_env, capsys):
    assert main(["use", "omniroute", "  ", "--kind", "text"]) == 2
    assert "slug" in capsys.readouterr().err


def test_database_unreachable_exits_2_without_leaking_url(cli_env, monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:hunter2@127.0.0.1:1/db?connect_timeout=2")
    assert main(["list"]) == 2
    err = capsys.readouterr().err
    assert "hunter2" not in err and "127.0.0.1" not in err
    assert "Traceback" not in err
