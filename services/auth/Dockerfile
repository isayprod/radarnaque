# Image du service d'authentification (Better Auth). Contexte de build : racine du dépôt.
FROM node:24.13-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
WORKDIR /repo

# Le lockfile référence tous les paquets du workspace : leurs package.json doivent exister.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/extension/package.json apps/extension/package.json
COPY apps/site/package.json apps/site/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/shared packages/shared
COPY services/auth services/auth

RUN pnpm install --frozen-lockfile --filter auth...
RUN pnpm --filter auth deploy --prod --legacy /out

FROM node:24.13-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/server.ts"]
