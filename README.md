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

## Déployer

Production : un serveur (Allemagne) avec Docker et Docker Compose, un enregistrement DNS
`radarnaque.mostconsult.be` qui pointe vers lui, et les ports 80 et 443 ouverts (Let's
Encrypt valide le certificat par le port 80). Caddy est le seul service qui publie des
ports ; postgres, auth (3000) et api (8000) restent sur le réseau interne de la
composition. Les routes sont celles du dev : `/auth/*` → auth, `/api/*` → api, le reste →
le site compilé (`apps/site`), construit dans l'image Caddy.

### 1. Configuration

```sh
git clone <dépôt> radarnaque && cd radarnaque
cp infra/.env.example infra/.env
```

Dans `infra/.env`, définir au minimum :

- `PUBLIC_URL=https://radarnaque.mostconsult.be` et `SITE_ADDRESS=radarnaque.mostconsult.be` ;
- `POSTGRES_PASSWORD` (`openssl rand -hex 24`) : elle est insérée telle quelle dans l'URL de
  connexion, donc uniquement des caractères sûrs pour une URL (l'hexadécimal convient). Elle
  n'est lue qu'à la **création** du volume Postgres : la modifier ensuite dans `.env` ne
  change pas le mot de passe de la base existante (il faudrait `ALTER USER`) et casse la
  connexion de auth, api et backup ;
- `BETTER_AUTH_SECRET` et `INTERNAL_API_SECRET` (`openssl rand -base64 32`) ;
- `EXTENSION_ID` : identifiant de l'extension publiée. C'est la seule variable utilisée en
  production pour cela : la composition la passe aussi à l'image Caddy comme argument de build
  (le site compile l'identifiant dans `/auth/callback`). `VITE_EXTENSION_ID` ne sert qu'en dev
  (`pnpm dev:site`) et est ignorée ici ;
- `RESEND_API_KEY` et `MAIL_FROM` (voir « Emails Resend » ci-dessous) ; `OPENROUTER_API_KEY` ;
- les variables de sauvegarde (voir plus bas).

La composition fixe elle-même `NODE_ENV=production`, `ENV=production`, `DATABASE_URL`
(`postgres:5432`), `API_INTERNAL_URL=http://api:8000` et
`JWKS_URL=http://auth:3000/auth/jwks` : les valeurs de dev de ces variables sont ignorées.

#### Emails Resend

Avant la mise en production, ajouter dans la zone DNS du domaine d'envoi (ou du
sous-domaine) tous les enregistrements affichés par Resend : SPF (TXT), DKIM (TXT ou CNAME)
et return-path (MX et TXT). `MAIL_FROM` doit utiliser ce domaine vérifié, par exemple
`"Radarnaque <no-reply@radarnaque.mostconsult.be>"`. Sans cela, les liens magiques et codes
partent en spam ou sont refusés.

#### Extension de production

L'identifiant d'une extension découle de sa clé : créer une clé de production dédiée
(`openssl genrsa -out radarnaque-prod.pem 2048`), la **garder hors de git et la sauvegarder**
(la perdre change l'identifiant), puis :

```sh
node apps/extension/scripts/extension-id.mjs radarnaque-prod.pem   # affiche la clé publique et l'identifiant
```

Reporter l'identifiant dans `EXTENSION_ID` (`infra/.env` du serveur) et construire
l'extension avec la clé publique correspondante :

```sh
WXT_PUBLIC_URL=https://radarnaque.mostconsult.be \
WXT_EXTENSION_KEY=<clé publique affichée> \
pnpm --filter extension build
```

### 2. Lancer

```sh
docker compose -f infra/docker-compose.yml --env-file infra/.env config -q   # valide la configuration
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build
```

L'ordre est garanti : postgres sain → `migrate` (migrations Better Auth, schéma `auth`) →
`migrate-api` (`alembic upgrade head`, schéma `app`) → `auth` et `api` → `caddy`. Les deux
services `migrate*` s'arrêtent après leur travail (`restart: "no"`). Pour mettre à jour :
`git pull`, puis la même commande `up -d --build`. Suivi : `docker compose -f infra/docker-compose.yml ps`
et `logs -f <service>`. Les données vivent dans les volumes `radarnaque_postgres-data`
(base), `radarnaque_caddy-data` (certificats) et `radarnaque_backups` (sauvegardes locales).

La route `/auth/dev/last-email` n'existe qu'avec `NODE_ENV=development` : en production
elle renvoie 404, ce que l'on vérifie après chaque déploiement :

```sh
curl -s -o /dev/null -w '%{http_code}\n' 'https://radarnaque.mostconsult.be/auth/dev/last-email?to=x'   # 404
```

### 3. Sauvegardes

Le service `backup` fait, au démarrage puis toutes les 24 h :
`pg_dump | gzip | age -r $BACKUP_AGE_RECIPIENT > /backups/radarnaque-<date>.sql.gz.age`,
copie le fichier avec `rclone copy` vers `BACKUP_RCLONE_REMOTE`, puis supprime les
sauvegardes locales de plus de 14 jours. Une erreur (par exemple `pg_dump` en échec) est
écrite sur stderr et visible dans `docker compose logs backup`. La rétention côté distant
est à régler chez le fournisseur.

1. Générer la clé : `age-keygen -o backup.key`. Mettre la clé **publique** (`age1...`)
   dans `BACKUP_AGE_RECIPIENT` ; conserver `backup.key` hors du serveur.
2. Créer `infra/backup/rclone/rclone.conf` (jamais versionné) avec le remote voulu
   (`rclone config` ou à la main), puis `BACKUP_RCLONE_REMOTE=<remote>:<chemin>`.
3. Essai à blanc : `docker compose -f infra/docker-compose.yml --env-file infra/.env run --rm -e BACKUP_RUN_ONCE=1 backup`.

Restaurer. Postgres n'est pas publié sur l'hôte : tout passe par `docker compose exec`.
La sauvegarde est un `pg_dump` complet qui crée les schémas `auth` et `app` : elle se
restaure dans une base **sans** ces schémas, avec `ON_ERROR_STOP` pour qu'une erreur
n'aboutisse jamais à une restauration partielle silencieuse. L'ordre ci-dessous est
important : rien n'est supprimé avant que la sauvegarde soit déchiffrée et vérifiée.
Le fichier à restaurer est dans le volume `radarnaque_backups` (récupérable avec
`docker compose ... cp backup:/backups/<fichier> .`) ou dans le dépôt rclone.

```sh
set -o pipefail                                  # bash : un échec de age ou gunzip fait échouer la commande
dc() { docker compose -f infra/docker-compose.yml --env-file infra/.env "$@"; }

# (a) Obligatoire : sauvegarde fraîche de l'état actuel, avant toute suppression.
dc exec backup /usr/local/bin/backup.sh --once

# (b) Déchiffrer vers un fichier local, puis le vérifier.
age -d -i backup.key radarnaque-<date>.sql.gz.age | gunzip > restore.sql
test -s restore.sql && grep -q 'CREATE SCHEMA app' restore.sql

# (c) Seulement ensuite : plus aucune connexion à la base, puis suppression des schémas.
dc stop caddy auth api backup
dc exec -T postgres psql -v ON_ERROR_STOP=1 -U radarnaque -d radarnaque \
  -c 'DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS app CASCADE;'

# (d) Restaurer, en s'arrêtant à la première erreur.
dc exec -T postgres psql -v ON_ERROR_STOP=1 -U radarnaque -d radarnaque < restore.sql

# (e) Redémarrer : migrate et migrate-api passent sans rien changer.
dc up -d

# (f) restore.sql contient des données personnelles : le supprimer.
rm restore.sql
```

Sans le `DROP SCHEMA`, la restauration s'arrête à la première erreur (`schema "app" already
exists`, code de sortie non nul) et ne modifie rien. Sur un serveur neuf, faire d'abord
`dc up -d postgres` : le script d'initialisation crée des schémas vides, à supprimer comme
en (c) avant la restauration (sautez alors l'étape (a), il n'y a rien à sauvegarder).
Ne pas lancer `dc up -d` entre (c) et (d) : `migrate` échoue si le schéma `auth` manque.

### 4. Essayer la composition de production en local

Même composition, sans TLS : dans un fichier d'environnement hors du dépôt (par exemple
`/tmp/prod-local.env`, copie de `infra/.env.example` avec des valeurs jetables, dont un
`RESEND_API_KEY` factice), définir `SITE_ADDRESS=http://localhost` et
`PUBLIC_URL=http://localhost` (si le port 80 est occupé : `CADDY_HTTP_PORT=8081` et
`PUBLIC_URL=http://localhost:8081`). Utiliser un nom de projet à part (`-p`) pour ne pas
toucher aux volumes de la production ni du dev, et n'activer la route de dev
(`NODE_ENV=development` sur auth) que le temps du test :

```sh
printf 'services:\n  auth:\n    environment:\n      NODE_ENV: development\n' > /tmp/auth-dev.yml
dc() { docker compose -p radarnaque-test -f infra/docker-compose.yml --env-file /tmp/prod-local.env "$@"; }
dc -f /tmp/auth-dev.yml up -d --build
E2E_ENV_FILE=/tmp/prod-local.env pnpm e2e:login          # E2E LOGIN OK
dc up -d --force-recreate auth                            # retour en NODE_ENV=production
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost/auth/dev/last-email?to=x'   # 404
dc down -v                                                # supprime les volumes de ce projet de test
```

`E2E_ENV_FILE` (facultatif) indique à `pnpm e2e:login` un autre fichier que `infra/.env`.
