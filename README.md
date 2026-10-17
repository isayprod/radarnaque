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
valeurs aléatoires (`openssl rand -hex 32`). Si un autre Postgres occupe déjà le port
5432 de la machine, choisir un autre `POSTGRES_PORT` (lu par docker compose dans
`infra/.env`) et reporter ce port dans `DATABASE_URL`.

### 2. Lancer la stack

```sh
pnpm dev
```

Une seule commande, un seul terminal. Elle vérifie d'abord que les ports 3000, 8000 et
3100 sont libres (sinon elle s'arrête en nommant le port et la commande
`lsof -nP -iTCP:<port> -sTCP:LISTEN` pour trouver le processus). Elle démarre ensuite
Postgres et Caddy (Docker, `http://localhost:8080`), puis, avec des logs préfixés et
colorés :

- `[auth]` : migrations Better Auth, puis service auth (port 3000) ;
- `[api]` : `alembic upgrade head`, puis API (port 8000), lancée **seulement après** la
  réponse 200 de `GET /auth/health` (attente de 120 s au plus, sinon l'API ne démarre pas) ;
- `[site]` : `vite build --watch` vers `apps/site/dist` ;
- `[ext]` : wxt, qui ouvre un Chrome avec l'extension (`Opened browser`).

Un seul Ctrl+C arrête les 4 processus ; si l'un d'eux s'arrête en erreur, les autres sont
arrêtés aussi et la commande sort avec un code non nul. Postgres et Caddy restent lancés ;
`pnpm dev:stop` les arrête (les données Postgres sont conservées).

Le service auth doit appliquer les migrations Better Auth (schéma `auth`) **avant**
qu'Alembic ne tourne, car les tables du schéma `app` ont des clés étrangères vers
`auth."user"` : c'est pourquoi `pnpm dev` attend `/auth/health` avant de lancer l'API.

Alternative : lancer les services séparément, chacun dans son terminal.

```sh
pnpm db:up                                                   # Postgres, schémas auth et app
docker compose -f infra/docker-compose.dev.yml up -d caddy   # http://localhost:8080
pnpm dev:auth    # terminal 1 : migrations Better Auth, puis service auth (port 3000)
pnpm dev:api     # terminal 2 : alembic upgrade head, puis API (port 8000)
pnpm dev:site    # terminal 3 : vite build --watch vers apps/site/dist
pnpm dev:ext     # terminal 4 : wxt (extension en mode dev)
```

Dans ce mode, l'ordre est important : au tout premier démarrage, lancer `dev:auth` et
attendre `[auth] migrations appliquées` avant `dev:api`.

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

### 5. Tests

```sh
pnpm test        # tests JS de tous les paquets (pnpm -r test)
pnpm test:api    # tests de l'API (cd services/api && uv run pytest ; Docker requis)
pnpm test:all    # les deux
```

### 6. Tester sur les vrais sites

La pastille de risque est calculée localement, sans appel réseau : la stack n'est pas
nécessaire, seul `apps/extension/.env` doit exister (voir « 1. Configuration »).

1. Lancer `pnpm dev:ext`.
2. Dans le Chrome ouvert, afficher une annonce 2ememain (`https://www.2ememain.be/v/…`),
   une annonce 2dehands (`https://www.2dehands.be/v/…`) et une annonce Facebook
   Marketplace (`https://www.facebook.com/marketplace/item/…`, compte Facebook requis).
3. Vérifier, sur chacune :
   - la pastille apparaît juste après le titre de l'annonce, une seule fois ;
   - un clic ouvre le panneau des signaux ; Escape ou un clic ailleurs le ferme ;
   - la langue : français sur 2ememain, néerlandais sur 2dehands, langue du navigateur
     sur Facebook, sauf si une langue a été choisie dans la popup ;
   - sur 2ememain, la pastille se met à jour quand la section vendeur finit de charger,
     sans se dupliquer.
4. Sur Facebook, ouvrir une annonce depuis la grille (modale), puis passer à une autre
   annonce et revenir à la grille : la pastille est remplacée à chaque annonce, jamais
   empilée, et disparaît sur la grille.

Si une fiche n'est pas reconnue, rien ne s'affiche et la console de la page (niveau
« Verbose ») contient une seule ligne `radarnaque: extraction impossible (<adaptateur>)`.

## Analyses IA en dev (OmniRoute, Ollama ou faux fournisseur)

Les fournisseurs LLM sont décrits dans `services/api/providers.toml` : URL, format de sortie
structurée, source du coût et **nom** de la variable d'environnement de la clé (jamais la
clé elle-même). Le modèle utilisé pour chaque type de scan (`text`, `image`) est choisi en
base avec `radarnaque-llm`, depuis `services/api` :

```sh
cd services/api
uv run --env-file ../../infra/.env radarnaque-llm list                     # fournisseurs (clé: oui/non), modèles, modèle actif par type
uv run --env-file ../../infra/.env radarnaque-llm use <fournisseur> <modèle> --kind text
```

`use` crée le modèle en base s'il n'existe pas encore. Le modèle actif est relu à chaque
scan : inutile de redémarrer l'API. Noter la sortie de `list` avant de changer de modèle,
pour pouvoir revenir ensuite au modèle d'origine.

### Faux fournisseur (`stub`), sans réseau ni clé

```sh
pnpm llm:stub                # terminal à part : http://127.0.0.1:20199/v1 (autre port : pnpm llm:stub 20200)
cd services/api && uv run --env-file ../../infra/.env radarnaque-llm use stub stub-model --kind text
pnpm e2e:scan                # contre la stack lancée (pnpm dev)
```

Le faux fournisseur répond toujours la même analyse (score 42, une raison, textes FR/NL fixes)
et écrit une ligne par requête : modèle, nombre de messages, présence d'images, jamais le
contenu ni les en-têtes. Il n'écoute que sur `127.0.0.1`.

`pnpm e2e:scan` reprend la connexion de `pnpm e2e:login` (compte neuf, donc essai neuf de 3
scans à chaque exécution), puis envoie deux fois le même scan texte, sans photo : le premier
appelle le LLM (`fromCache: false`), le second est servi depuis le cache (`fromCache: true`,
même analyse) et `remaining.total` baisse de 1 à chaque scan. Il affiche
`E2E SCAN OK (provider=<p>, model=<m>, score=<n>)` ; sinon il nomme l'étape en échec
(connexion, modèle actif, premier scan, second scan, cache ou quota) et sort avec le code 1.
Le modèle affiché est le modèle actif du type `text`, lu avec `radarnaque-llm list` ;
`E2E_PROVIDER` et `E2E_MODEL` permettent de l'imposer. Il fonctionne avec n'importe quel
fournisseur ; le score 42 n'est vérifié qu'avec `stub`.

Le fournisseur `stub` figure aussi dans le `providers.toml` de la production : il n'a pas de
clé et ne vise que `localhost:20199`, où rien n'écoute en production. Il est donc sans effet
tant qu'aucun type de scan ne l'utilise.

### OmniRoute (routeur local vers des modèles gratuits ou par abonnement)

1. Lancer OmniRoute sur le port 20128 : `npx omniroute`, ou avec Docker
   `docker run -d --name omniroute -p 20128:20128 diegosouzapw/omniroute`.
2. Dans son interface (`http://localhost:20128`), connecter au moins un fournisseur, puis
   copier la clé d'API dans **Dashboard → Endpoints**.
3. Dans `infra/.env` : `OMNIROUTE_API_KEY=<clé>` (et `OMNIROUTE_BASE_URL` seulement si
   OmniRoute n'écoute pas sur `http://localhost:20128/v1`). Redémarrer `pnpm dev:api` pour
   que l'API lise la clé.
4. Activer OmniRoute pour les deux types de scan, avec son routage automatique :

   ```sh
   cd services/api
   uv run --env-file ../../infra/.env radarnaque-llm use omniroute auto --kind text
   uv run --env-file ../../infra/.env radarnaque-llm use omniroute auto --kind image
   ```

5. `pnpm e2e:scan` doit afficher `E2E SCAN OK (provider=omniroute, model=auto, …)`.

OmniRoute reçoit une sortie `json_object` (le schéma attendu est ajouté au prompt système) ;
le coût de chaque analyse est lu dans l'en-tête `X-OmniRoute-Response-Cost`.

### Ollama (modèles locaux)

```sh
ollama serve                         # http://localhost:11434 ; sinon OLLAMA_BASE_URL dans infra/.env
ollama pull <modèle>                 # par exemple qwen2.5:7b ; un modèle « vision » pour --kind image
cd services/api && uv run --env-file ../../infra/.env radarnaque-llm use ollama <modèle> --kind text
```

Ollama n'a pas de clé ; le coût enregistré est nul.

## Changer de fournisseur

En production, les modèles sont ceux d'OpenRouter (clé `OPENROUTER_API_KEY` dans
`infra/.env`) :

```sh
docker compose -f infra/docker-compose.yml --env-file infra/.env exec api \
  radarnaque-llm use openrouter google/gemini-2.5-flash-lite --kind text
docker compose -f infra/docker-compose.yml --env-file infra/.env exec api \
  radarnaque-llm use openrouter google/gemini-3.1-flash-lite --kind image
```

En dev, mêmes commandes avec `cd services/api && uv run --env-file ../../infra/.env
radarnaque-llm …`. La composition de production passe à l'API `OPENROUTER_API_KEY`,
`OMNIROUTE_API_KEY`, `OMNIROUTE_BASE_URL` et `OLLAMA_BASE_URL`, toutes facultatives.

**Changer de modèle change la clé du cache.** Une analyse est réutilisée pour la même
annonce, le même modèle et la même version de prompt : après un changement de modèle, les
annonces déjà analysées le sont à nouveau (nouvel appel LLM, nouveau coût) ; revenir à
l'ancien modèle retrouve ses analyses tant qu'elles ont moins de 24 h (`cache_ttl_hours`).

Ajouter un fournisseur compatible OpenAI (`POST <base_url>/chat/completions`) :

1. Ajouter une entrée dans `services/api/providers.toml` :

   ```toml
   [providers.monfournisseur]
   base_url = "https://api.exemple.com/v1"
   api_key_env = "MONFOURNISSEUR_API_KEY"   # nom de la variable, jamais la clé
   structured_output = "json_object"        # ou "json_schema" s'il accepte un schéma strict
   cost_source = "none"                     # ou "usage_cost" (usage.cost, comme OpenRouter)
   ```

   `base_url_env` (facultatif) nomme une variable qui remplace `base_url`, et `extra_body`
   (facultatif) ajoute des champs à chaque requête (voir l'entrée `openrouter`).
2. Définir la variable dans `infra/.env` ; en production, l'ajouter aussi à l'environnement
   du service `api` dans `infra/docker-compose.yml` (`MONFOURNISSEUR_API_KEY:
   ${MONFOURNISSEUR_API_KEY:-}`).
3. Redémarrer l'API : `providers.toml` est lu au démarrage, et l'API refuse de démarrer si un
   modèle en base référence un fournisseur absent du fichier.
4. `radarnaque-llm list` doit afficher le fournisseur avec `clé: oui` ; puis
   `radarnaque-llm use monfournisseur <modèle> --kind text` et `pnpm e2e:scan`.

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
- `BETTER_AUTH_SECRET` et `INTERNAL_API_SECRET` : générer chaque secret avec
  `openssl rand -hex 32`. Les valeurs d'exemple commencent par `change-me` : auth et api
  refusent de démarrer en production avec un secret (ou un mot de passe Postgres dans
  `DATABASE_URL`) qui commence par `change-me` ;
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
elle renvoie 404. Les routes internes de l'API (`/api/internal/*`, appelées par auth via
`http://api:8000`) ne sont jamais servies par Caddy : 404 elles aussi. À vérifier après
chaque déploiement :

```sh
curl -s -o /dev/null -w '%{http_code}\n' 'https://radarnaque.mostconsult.be/auth/dev/last-email?to=x'          # 404
curl -s -o /dev/null -w '%{http_code}\n' 'https://radarnaque.mostconsult.be/api/internal/users/x/bootstrap'   # 404
curl -s -o /dev/null -w '%{http_code}\n' 'https://radarnaque.mostconsult.be/auth/callback'                     # 200
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
`RESEND_API_KEY` factice), remplacer `BETTER_AUTH_SECRET`, `INTERNAL_API_SECRET` et
`POSTGRES_PASSWORD` par des valeurs qui ne commencent pas par `change-me` (sinon auth et
api refusent de démarrer : `openssl rand -hex 32`), définir `SITE_ADDRESS=http://localhost` et
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
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost/api/internal/users/x/bootstrap'   # 404
dc down -v                                                # supprime les volumes de ce projet de test
```

`E2E_ENV_FILE` (facultatif) indique à `pnpm e2e:login` un autre fichier que `infra/.env`.
