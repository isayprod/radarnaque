# Radarnaque

## Démarrer en dev

Prérequis : Node 24, pnpm 10.26.1, Docker, uv.

En dev, tout passe par une seule origine, `http://localhost:8080` (Caddy, dans Docker) :
`/auth/*` → service auth (hôte, port 3000), `/api/*` → API (hôte, port 8000), le reste →
`apps/site/dist`. Seuls Postgres et Caddy tournent dans Docker, liés à `127.0.0.1`.

### 1. Configuration

```sh
pnpm install
cp infra/.env.example infra/.env                       # source unique : auth, api, site
cp apps/extension/.env.example apps/extension/.env     # extension (WXT)
pnpm dev:keys
```

`pnpm dev:keys` crée la clé de dev de l'extension si elle n'existe pas, puis affiche
l'identifiant et la clé publique. C'est l'équivalent de :

```sh
openssl genrsa -out infra/extension-dev.pem 2048
node apps/extension/scripts/extension-id.mjs infra/extension-dev.pem
```

La clé `infra/extension-dev.pem` n'est jamais versionnée. Le même identifiant doit être
utilisé partout :

- `infra/.env` : `EXTENSION_ID` (service auth) et `VITE_EXTENSION_ID` (site) ;
- `apps/extension/.env` : `WXT_EXTENSION_KEY` (l'identifiant en découle) et
  `WXT_PUBLIC_URL`, égal au `PUBLIC_URL` de `infra/.env`.

Dans `infra/.env`, remplacer aussi `BETTER_AUTH_SECRET` et `INTERNAL_API_SECRET` par des
valeurs aléatoires (`openssl rand -base64 32`). Si un autre Postgres occupe déjà le port
5432 de la machine, choisir un autre `POSTGRES_PORT` (lu par docker compose dans
`infra/.env`) et reporter ce port dans `DATABASE_URL`.

### 2. Lancer la stack

```sh
pnpm db:up                                                   # Postgres, schémas auth et app
docker compose -f infra/docker-compose.dev.yml up -d caddy   # http://localhost:8080
pnpm dev:auth    # terminal 1 : migrations Better Auth, puis service auth (port 3000)
pnpm dev:api     # terminal 2 : alembic upgrade head, puis API (port 8000)
pnpm dev:site    # terminal 3 : vite build --watch vers apps/site/dist
pnpm dev:ext     # terminal 4 : wxt (extension en mode dev)
```

Ordre important : `pnpm dev:auth` applique les migrations Better Auth (schéma `auth`)
**avant** que `pnpm dev:api` lance Alembic, car les tables du schéma `app` ont des clés
étrangères vers `auth."user"`. Au tout premier démarrage, lancer `dev:auth` et attendre
`[auth] migrations appliquées` avant `dev:api`.

Les scripts lisent `infra/.env` (`node --env-file` / `tsx --env-file` pour auth et le
site, `uv run --env-file` pour l'API). En dev, aucun email n'est envoyé : le service auth
écrit chaque email (lien magique et code à 6 chiffres) dans ses logs.

Sous Linux, Caddy joint l'hôte par `host-gateway` : l'API doit alors écouter au-delà de
`127.0.0.1` (ajouter `--host 0.0.0.0` à la commande uvicorn de `dev:api`). Docker Desktop
(macOS, Windows) n'en a pas besoin.

### 3. Charger l'extension

`pnpm dev:ext` ouvre un Chrome avec l'extension déjà chargée. Pour l'utiliser dans votre
Chrome habituel : `pnpm --filter extension build`, puis `chrome://extensions` → activer le
mode développeur → « Charger l'extension non empaquetée » → choisir
`apps/extension/.output/chrome-mv3`. L'identifiant affiché doit être celui de
`pnpm dev:keys`.

### 4. Test de connexion de bout en bout

```sh
pnpm e2e:login
```

Contre la stack lancée, le script crée un compte neuf (`e2e+<horodatage>@radarnaque.test`)
et enchaîne `POST /auth/start` → `GET /auth/dev/last-email` (code) →
`POST /auth/sign-in/email-otp` (jeton de session) → `GET /auth/token` (JWT) →
`GET /api/me` (essai, 3 scans restants). Il affiche `E2E LOGIN OK` ; sinon il nomme
l'étape en échec avec le statut HTTP et le corps de la réponse, et sort avec le code 1.
Vérification de types : `pnpm typecheck:scripts`.
