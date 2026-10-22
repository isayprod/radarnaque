# Caddy de production avec le site et l'administration compilés. Contexte de build : racine du dépôt.
FROM node:24.13-slim AS web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /repo

# Le lockfile référence tous les paquets du workspace : leurs package.json doivent exister.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/extension/package.json apps/extension/package.json
COPY services/auth/package.json services/auth/package.json
COPY packages/design packages/design
COPY packages/shared packages/shared
COPY apps/site apps/site
COPY apps/admin apps/admin

RUN pnpm install --frozen-lockfile --filter site... --filter admin...

# Identifiant de l'extension compilé dans la page /auth/callback.
ARG VITE_EXTENSION_ID
ENV VITE_EXTENSION_ID=$VITE_EXTENSION_ID
RUN pnpm --filter site build
RUN pnpm --filter admin build

FROM caddy:2
COPY --from=web /repo/apps/site/dist /srv/site
COPY --from=web /repo/apps/admin/dist /srv/admin
