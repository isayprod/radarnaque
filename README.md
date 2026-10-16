# Radarnaque

## Démarrer en dev

Prérequis : Node 24, pnpm 10.26.1, Docker, uv.

```sh
pnpm install
cp infra/.env.example infra/.env   # puis adapter les valeurs
pnpm db:up                         # Postgres 5432, schémas auth et app
```
