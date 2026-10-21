# Image de l'API FastAPI. Contexte de build : services/api.
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv

# Image de production : ENV=production coupe le rôle superuser, le bloc `debug` et ses
# logs (Settings.env vaut `development` par défaut). Le dev passe par `uv run`, sans
# cette image ; infra/docker-compose.yml le répète.
ENV ENV=production

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# Dépendances d'abord (couche en cache tant que uv.lock ne change pas).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY alembic.ini providers.toml ./
COPY alembic ./alembic
COPY src ./src
RUN uv sync --frozen --no-dev

RUN useradd --system --uid 10001 --no-create-home radarnaque
USER radarnaque

EXPOSE 8000
CMD ["uvicorn", "--factory", "radarnaque_api.main:create_app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--no-access-log"]
