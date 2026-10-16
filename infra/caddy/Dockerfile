# Caddy de production avec le site compilé. Contexte de build : racine du dépôt.
FROM node:24.13-slim AS site
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/extension/package.json apps/extension/package.json
COPY services/auth/package.json services/auth/package.json
COPY packages/shared packages/shared
COPY apps/site apps/site

RUN pnpm install --frozen-lockfile --filter site...

# Identifiant de l'extension compilé dans la page /auth/callback.
ARG VITE_EXTENSION_ID
ENV VITE_EXTENSION_ID=$VITE_EXTENSION_ID
RUN pnpm --filter site build

FROM caddy:2
COPY --from=site /repo/apps/site/dist /srv/site
