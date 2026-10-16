#!/usr/bin/env bash
# Exporte l'OpenAPI de l'API FastAPI et génère les types TypeScript de @radarnaque/shared.
#   scripts/gen-api.sh           régénère packages/shared/openapi.json et src/api.ts
#   scripts/gen-api.sh --check   régénère dans un dossier temporaire et échoue si ça diffère
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARED="$ROOT/packages/shared"

generate() {
  local out="$1"
  mkdir -p "$out/src"
  (cd "$ROOT/services/api" && uv run python -m radarnaque_api.export_openapi) >"$out/openapi.json"
  (cd "$SHARED" && pnpm exec openapi-typescript "$out/openapi.json" -o "$out/src/api.ts")
}

case "${1:-}" in
  "")
    generate "$SHARED"
    ;;
  --check)
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    generate "$tmp"
    status=0
    diff -u "$SHARED/openapi.json" "$tmp/openapi.json" || status=1
    diff -u "$SHARED/src/api.ts" "$tmp/src/api.ts" || status=1
    if [ "$status" -ne 0 ]; then
      echo "Contrat API périmé : lancer 'pnpm gen:api' et versionner le résultat." >&2
    fi
    exit "$status"
    ;;
  *)
    echo "Usage : $0 [--check]" >&2
    exit 2
    ;;
esac
