"""uvicorn ne journalise pas les accès : l'URL d'une requête et l'adresse du client n'ont pas à
finir dans les logs."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_no_access_log():
    dockerfile = (ROOT / "services" / "api" / "Dockerfile").read_text(encoding="utf-8")
    assert "--no-access-log" in dockerfile
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert "--no-access-log" in scripts["dev:api"]
