# Radarnaque

## Démarrer en dev

Prérequis : Node 24, pnpm 10.26.1, Docker, uv.

En dev, tout passe par une seule origine, `http://localhost:8080` (Caddy, dans Docker) :
`/auth/*` → service auth (hôte, port 3000), `/api/*` → API (hôte, port 8000), `/admin/*` →
`apps/admin/dist`, le reste → `apps/site/dist`. Seuls Postgres, Caddy et SearXNG (le moteur de recherche web des analyses,
`http://127.0.0.1:8888`, configuré par `infra/searxng/settings.yml`) tournent dans Docker, liés à
`127.0.0.1`.

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
Postgres, Caddy (Docker, `http://localhost:8080`) et SearXNG (sans attendre sa réponse), puis, avec des logs préfixés et
colorés :

- `[auth]` : migrations Better Auth, puis service auth (port 3000) ;
- `[api]` : `alembic upgrade head`, puis API (port 8000), lancée **seulement après** la
  réponse 200 de `GET /auth/health` (attente de 120 s au plus, sinon l'API ne démarre pas) ;
- `[site]` : `vite build --watch` vers `apps/site/dist` ;
- `[admin]` : `vite build --watch` vers `apps/admin/dist`, servi sur `http://localhost:8080/admin/` ;
- `[ext]` : wxt, qui ouvre un Chrome avec l'extension (`Opened browser`).

Un seul Ctrl+C arrête les 5 processus ; si l'un d'eux s'arrête en erreur, les autres sont
arrêtés aussi et la commande sort avec un code non nul. Postgres, Caddy et SearXNG restent lancés ;
`pnpm dev:stop` les arrête (les données Postgres sont conservées).

Le service auth doit appliquer les migrations Better Auth (schéma `auth`) **avant**
qu'Alembic ne tourne, car les tables du schéma `app` ont des clés étrangères vers
`auth."user"` : c'est pourquoi `pnpm dev` attend `/auth/health` avant de lancer l'API.

Alternative : lancer les services séparément, chacun dans son terminal.

```sh
pnpm db:up                                                   # Postgres, schémas auth et app
docker compose -f infra/docker-compose.dev.yml up -d caddy searxng   # :8080 (Caddy) et :8888 (SearXNG)
pnpm dev:auth    # terminal 1 : migrations Better Auth, puis service auth (port 3000)
pnpm dev:api     # terminal 2 : alembic upgrade head, puis API (port 8000)
pnpm dev:site    # terminal 3 : vite build --watch vers apps/site/dist
pnpm dev:admin   # terminal 4 : vite build --watch vers apps/admin/dist (http://localhost:8080/admin/)
pnpm dev:ext     # terminal 5 : wxt (extension en mode dev)
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

#### Le parcours de la pastille, en deux temps

Sur une fiche, il n'y a qu'une seule pilule, qui avance en deux temps (il faut l'API et
un compte connecté, voir « Tester les analyses IA dans l'extension ») :

1. **Identifier.** Au repos, la pilule affiche « Identifier ». Un clic lance l'identification du
   produit : une ligne d'état en direct, puis la référence et le niveau (Sûr, Probable,
   Incertain), sans pourcentage ni couleur de risque. Le pourcentage est dans le panneau.
2. **Analyser le risque.** Dans la même pilule, une fois le produit identifié, « Analyser le
   risque » lance l'analyse anti-arnaque, incluse avec l'identification (rien n'est décompté,
   même à zéro analyse restante). Pendant l'analyse, la ligne d'état suit le déroulé ; à la fin,
   la pilule montre le niveau de risque et le score.

Le panneau suit les mêmes étapes, sous le titre « Analyse Radarnaque » :

- avant l'identification : la section Identification seule ;
- produit identifié : la section « Produit » (référence, niveau, critères, pages de référence),
  puis le bouton « Analyser le risque » ;
- risque analysé : le risque (score, conseil, raisons), puis « Détail du produit », replié, qui
  garde la section Produit.

Pour voir tous ces états sans réseau : `pnpm --filter extension gallery` (port 3101).

Si une fiche n'est pas reconnue, rien ne s'affiche et la console de la page (niveau
« Verbose ») contient une seule ligne `radarnaque: extraction impossible (<adaptateur>)`.

## Analyses IA en dev (Groq, abonnement ChatGPT, OmniRoute, Ollama ou faux fournisseur)

Les fournisseurs LLM sont décrits dans `services/api/providers.toml` : URL, format de sortie
structurée, source du coût et **nom** de la variable d'environnement de la clé (jamais la
clé elle-même). Le modèle utilisé pour les analyses (type de scan `full`, le seul utilisé ;
`text` et `image` ne restent que dans l'historique) est choisi en base avec `radarnaque-llm`,
depuis `services/api` :

```sh
cd services/api
uv run --env-file ../../infra/.env radarnaque-llm list                     # fournisseurs (clé: oui/non), modèles, modèle actif par type
uv run --env-file ../../infra/.env radarnaque-llm use <fournisseur> <modèle> --kind full
```

`use` crée le modèle en base s'il n'existe pas encore. Le modèle actif est relu à chaque
scan : inutile de redémarrer l'API. Noter la sortie de `list` avant de changer de modèle,
pour pouvoir revenir ensuite au modèle d'origine.

### Faux fournisseur (`stub`), sans réseau ni clé

```sh
pnpm llm:stub                # terminal à part : http://127.0.0.1:20199/v1
cd services/api && uv run --env-file ../../infra/.env radarnaque-llm use stub stub-model --kind full
pnpm e2e:scan                # contre la stack lancée (pnpm dev)
```

Le faux fournisseur répond toujours la même analyse (score 42, une raison, textes FR/NL fixes),
ou, pour les étapes de l'identification, une sortie fixe valide selon le nom du schéma demandé
(`radarnaque_read_photos`, `radarnaque_criteria`, `radarnaque_identify` ; en mode `json_object`,
d'après le schéma ajouté au prompt) : un vélo à deux candidats, donc une étape de critères.
Il écrit une ligne par requête : modèle, nombre de messages, présence d'images, jamais le
contenu ni les en-têtes. Il n'écoute que sur `127.0.0.1`. Le port 20199 est imposé : le
fournisseur `stub` de `providers.toml` n'a pas de `base_url_env`, l'API appelle donc toujours
`http://localhost:20199/v1`, même si le faux fournisseur est lancé sur un autre port.

`pnpm e2e:scan` reprend la connexion de `pnpm e2e:login` (compte neuf, donc essai neuf de 3
scans à chaque exécution), puis envoie deux fois le même scan, sans photo, par la route en flux
`POST /api/scans/stream` (chaque événement `stage`, `thinking`, `search`, `search_done` est
affiché à son arrivée ; `pnpm e2e:scan -- --no-stream` utilise l'ancienne route `POST /api/scans`) :
le premier appelle le LLM (`fromCache: false`, étape `analyzing`), le second est servi depuis le
cache (`fromCache: true`, étape `cache`, même analyse) et `remaining.scans` baisse de 1 à chaque
scan. Il affiche
`E2E SCAN OK (provider=<p>, model=<m>, score=<n>)` ; sinon il nomme l'étape en échec
(connexion, modèle actif, premier scan, second scan, cache ou quota) et sort avec le code 1.
Le modèle affiché est le modèle actif du type `full`, lu avec `radarnaque-llm list` ;
`E2E_PROVIDER` et `E2E_MODEL` permettent de l'imposer, à condition de définir les deux : avec
une seule des deux, le modèle est lu avec `radarnaque-llm list`. Il fonctionne avec n'importe
quel fournisseur ; le score 42 n'est vérifié qu'avec `stub`.

`pnpm e2e:identify` fait de même pour l'identification : deux appels identiques à
`POST /api/identify/stream` (`-- --no-stream` : `POST /api/identify`). Le premier lance le pipeline
(`fromCache: false`, étapes `reading_photos` puis `identifying`, et `criteria` avec ses
recherches quand SearXNG répond), le second est servi depuis le cache (`fromCache: true`, même
`identificationId`). Il affiche `E2E IDENTIFY OK (status=<s>, confidence=<n>, level=<l>)` ; sinon
il nomme l'étape en échec.

Pour `pnpm e2e:identify` avec `stub`, `radarnaque-llm use` ne suffit pas : son option `--kind`
ne vise que les types de scan (`text`, `image`, `full`). Les trois étapes se règlent dans
l'écran IA de l'admin :

1. noter les modèles actuels : `cd services/api && uv run --env-file ../../infra/.env radarnaque-llm list`
   (types de scan), et le modèle actif de chaque étape dans l'écran IA ;
2. lancer `pnpm llm:stub` ;
3. dans l'écran IA de l'admin, choisir `stub/stub-model` comme modèle actif des étapes
   `read_photos`, `criteria` et `identify` (le modèle `stub/stub-model` existe après
   `radarnaque-llm use stub stub-model --kind full`) ;
4. lancer `pnpm e2e:identify` puis `pnpm e2e:scan` ;
5. remettre les modèles notés : écran IA pour les trois étapes, `radarnaque-llm use <fournisseur>
   <modèle> --kind full` pour le type `full`.

Au-delà d'environ 3 connexions par minute (`pnpm e2e:login` et `pnpm e2e:scan` confondus),
le limiteur du service auth répond 429 à l'étape « connexion 3 »
(`POST /auth/sign-in/email-otp`) : attendre une minute avant de relancer.

Le fournisseur `stub` figure aussi dans le `providers.toml` de la production : il n'a pas de
clé et ne vise que `localhost:20199`, où rien n'écoute en production. Il est donc sans effet
tant qu'aucun type de scan ne l'utilise. Après `radarnaque-llm use stub stub-model`, la ligne
`stub/stub-model` reste dans la table `models`, même une fois un autre modèle activé : tant
qu'elle existe, l'API refuse de démarrer si `stub` est retiré de `providers.toml`.

### Groq (fournisseur de dev par défaut, gratuit)

1. Créer une clé gratuite sur [console.groq.com](https://console.groq.com) → **API Keys**.
2. Dans `infra/.env` : `GROQ_API_KEY=<clé>`, puis redémarrer `pnpm dev:api`.
3. Activer Groq pour les analyses (modèle vision : elles joignent des photos) :

   ```sh
   cd services/api
   uv run --env-file ../../infra/.env radarnaque-llm use groq qwen/qwen3.8-27b --kind full
   ```

4. `pnpm e2e:scan` doit afficher `E2E SCAN OK (provider=groq, model=qwen/qwen3.8-27b, …)`.

L'offre gratuite limite les requêtes et les tokens par minute et par jour (une réponse 429 de
Groq donne un scan en échec `502`, rendu à l'utilisateur). Groq reçoit une sortie
`json_object`, avec le schéma attendu dans le prompt système : la sortie stricte
(`json_schema`) n'est acceptée que par certains de ses modèles. Son modèle vision accepte au
plus 3 images par requête : `max_images = 3` dans `providers.toml` limite les photos
envoyées. La liste des modèles change souvent : la vérifier sur
[console.groq.com/docs/models](https://console.groq.com/docs/models) (modèles vision :
[console.groq.com/docs/vision](https://console.groq.com/docs/vision)). Le coût enregistré est
nul.

### Abonnement ChatGPT/Codex (`openai-oauth`), en local uniquement

[openai-oauth](https://github.com/EvanZhouDev/openai-oauth) est un proxy local, non officiel,
qui expose l'abonnement ChatGPT (Plus/Pro) comme une API compatible OpenAI, en réutilisant la
session de Codex (`~/.codex/auth.json`).

1. Se connecter si ce n'est pas déjà fait (`npx openai-oauth login`, ou `codex login`), puis
   lancer le proxy dans un terminal à part : `npx openai-oauth`. Il écoute sur
   `http://127.0.0.1:10531/v1` et affiche les modèles de l'abonnement.
2. Activer le modèle de dev par défaut, `gpt-6-luna` (ou un autre modèle de la liste du
   proxy) :

   ```sh
   cd services/api
   uv run --env-file ../../infra/.env radarnaque-llm use openai-oauth gpt-6-luna --kind full
   ```

3. `pnpm e2e:scan` doit afficher `E2E SCAN OK (provider=openai-oauth, model=gpt-6-luna, …)`.

Les modèles de raisonnement du service Codex (dont `gpt-6-luna`) refusent `temperature` :
l'entrée `openai-oauth` a `omit_params = ["temperature"]`. Sans cela, chaque scan échoue en
`502` avec la raison `transport` (le proxy transforme le refus en erreur 500). Le proxy n'a
pas de clé et ignore `response_format` : l'entrée `openai-oauth` est donc en
`json_object` (schéma dans le prompt système, réponse validée par l'API, une nouvelle
tentative si elle est invalide). Ce fournisseur passe par l'API Responses
(`api = "responses"`, `POST <base_url>/responses`) : le proxy n'accepte pas les photos dans
les chat completions. **À n'utiliser qu'en local** : toute requête qui atteint le
proxy est décomptée de l'abonnement, OpenAI peut changer ou fermer ce service interne à tout
moment, et ses conditions d'utilisation ne prévoient pas cet usage. Il n'est jamais passé à
la composition de production. Le coût enregistré est nul.

### OmniRoute (alternative : routeur local vers des modèles gratuits ou par abonnement)

1. Lancer OmniRoute sur le port 20128 : `npx omniroute`, ou avec Docker
   `docker run -d --name omniroute -p 20128:20128 diegosouzapw/omniroute` (commande à
   vérifier dans la documentation d'OmniRoute). Sans volume monté pour ses données, la
   configuration d'OmniRoute (fournisseurs connectés, clé d'API) est perdue quand le
   conteneur est recréé.
2. Dans son interface (`http://localhost:20128`), connecter au moins un fournisseur, puis
   copier la clé d'API dans **Dashboard → Endpoints**.
3. Dans `infra/.env` : `OMNIROUTE_API_KEY=<clé>` (et `OMNIROUTE_BASE_URL` seulement si
   OmniRoute n'écoute pas sur `http://localhost:20128/v1`). Redémarrer `pnpm dev:api` pour
   que l'API lise la clé.
4. Activer OmniRoute pour les analyses, avec son routage automatique :

   ```sh
   cd services/api
   uv run --env-file ../../infra/.env radarnaque-llm use omniroute auto --kind full
   ```

5. `pnpm e2e:scan` doit afficher `E2E SCAN OK (provider=omniroute, model=auto, …)`.

OmniRoute reçoit une sortie `json_object` (le schéma attendu est ajouté au prompt système) ;
le coût de chaque analyse est lu dans l'en-tête `X-OmniRoute-Response-Cost`.

### Ollama (modèles locaux)

```sh
ollama serve                         # http://localhost:11434 ; sinon OLLAMA_BASE_URL dans infra/.env
ollama pull <modèle>                 # par exemple qwen2.5:7b ; un modèle « vision » (analyses avec photos)
cd services/api && uv run --env-file ../../infra/.env radarnaque-llm use ollama <modèle> --kind full
```

Ollama n'a pas de clé ; le coût enregistré est nul.

## Identification du produit (API)

Avant d'analyser une annonce, l'API sait identifier le produit vendu : elle lit les photos
(étape `read_photos`), cherche sur le web les critères qui distinguent les candidats
(`criteria`, partagés entre utilisateurs dans une base de critères), vérifie ces critères sur
les photos (`identify`), puis calcule elle-même un indice de confiance (Sûr, Probable ou
Incertain). Le résultat nourrit ensuite l'analyse anti-arnaque (`scam`). La spécification est dans
[`docs/superpowers/specs/2026-10-23-identification-produit-design.md`](docs/superpowers/specs/2026-10-23-identification-produit-design.md).

- **Routes :**
  - `POST /api/identify/stream` : mêmes corps (`ScanIn`), admission, refus JSON et événements SSE
    que le scan, plus les étapes `reading_photos`, `criteria`, `identifying` et `retrying` et les
    événements `criteria_cached`, `page_read` et `identification` ; le dernier événement est
    `result` (un `IdentificationOut`) ou `error`. Délai de 120 s.
  - `POST /api/identify` : la même, sans flux.
  - `POST /api/scans(/stream)` : identifient d'abord l'annonce (80 s au plus), puis analysent. Un
    échec de l'identification donne un événement `identification_error` et l'analyse continue sans
    elle. Le scan entier est borné à 190 s (voir le [suivi](docs/superpowers/plans/2026-10-23-identification-partie-1-suivi.md)).
- **Quota :** « identifier » consomme 1 analyse ; l'analyse qui suit (même utilisateur, même
  annonce, moins de 24 h, après un `identify` réussi) est incluse, une seule fois par
  identification.
- **Réglages** (écran IA de l'admin, table `settings`) :
  | Réglage | Défaut | Rôle |
  |---|---|---|
  | `identification_cache_ttl_hours` | 168 | validité d'une identification en cache |
  | `criteria_ttl_days` | 180 | âge au-delà duquel les critères d'un ensemble sont recherchés de nouveau |
  | `criteria_max_searches` | 2 | recherches web de l'étape `criteria` |
  | `criteria_max_pages` | 3 | pages publiques lues par le serveur pour les critères |
  | `identify_retry_threshold` | 60 | confiance en dessous de laquelle `identify` est relancé (recherche en plus, modèle de relance) |
  | `identify_image_side` | 1280 | côté maximal des photos envoyées à l'identification (768 à 1536 px) |
  | `scam_sends_photos` | non | l'analyse anti-arnaque reçoit-elle aussi les photos ; à non, l'analyse enregistre `images_analyzed = 0` alors que les photos ont été analysées par l'identification (voir `identifications.images_analyzed`) |
  | `identify_escalation_model_id` | aucun | modèle de la relance (sinon celui d'`identify`) |
- **Étapes :** un modèle actif et un prompt versionné par étape (`read_photos`, `criteria`,
  `identify`), réglés dans l'écran IA de l'admin ; l'analyse (`scam`, prompt `full`) garde ses
  réglages habituels. Les migrations
  0010 (tables, réglages) et 0011 (prompts v1) les créent.

### Évaluer l'identification en local

```sh
pnpm eval:identify     # cd services/api && uv run --env-file ../../infra/.env radarnaque-eval-identify evals/identify.jsonl
```

Le fichier `services/api/evals/identify.jsonl` (ignoré par Git : `services/api/evals/`) contient
une ligne `{ "scan": <ScanIn>, "expected": "<référence attendue>" }` par annonce, construite à la
main à partir de pages enregistrées. La commande lance le pipeline comme pour un scan, sur la
configuration active, sans quota ni cache d'identification, puis affiche pour chaque annonce son
statut, son niveau, la référence trouvée et le coût, et au final la justesse (référence attendue
contenue, sans accents ni majuscules, dans la référence trouvée), la répartition des niveaux et le
coût moyen par étape. Elle n'affiche jamais le contenu d'une annonce. Elle écrit dans la base de
critères (et les lignes `llm_calls` de l'étape `criteria`), jamais d'identification.
Ne jamais mettre ce fichier, ni `web-pages/`, dans un commit.

## Tester les analyses IA dans l'extension

La pastille a un bouton « Analyser avec l'IA », le panneau une section « Analyse IA », et les
pages de résultats une icône « R » sur chaque carte. Les trois passent par le service worker, qui
appelle l'API en flux (`POST /api/scans/stream`) : contrairement à la pastille seule (voir
« 6. Tester sur les vrais sites »), la stack doit tourner. Il n'y a qu'un seul type d'analyse :
elle joint toujours les photos de l'annonce (4 en essai et en Premium, 1 en Standard) et le
modèle peut chercher sur le web (SearXNG, démarré par `pnpm dev`).

### Prérequis

1. `pnpm dev` est lancé (stack et extension : voir « 2. Lancer la stack »).
2. Le compte est connecté depuis la popup de l'extension (email, puis code à 6 chiffres, lu
   dans les logs `[auth]` en dev). Un compte neuf a un essai de 3 analyses au total.
3. Un fournisseur LLM est actif pour le type `full`, le seul utilisé (les analyses joignent des
   photos : il faut un modèle vision) : le faux fournisseur `stub` (sans réseau), `Groq` ou
   `openai-oauth`. Voir les sections « Faux fournisseur (`stub`) », « Groq » et « Abonnement
   ChatGPT/Codex (`openai-oauth`) » ci-dessus. `radarnaque-llm list` donne le modèle actif.

### Pilule « Identifier » et délai du flux

La pastille a une seule pilule : « Identifier » (logo et « Identifier », nommée « Identifier le
produit »), puis l'action « Analyser le risque ». « Identifier » appelle
`POST /api/identify/stream` et consomme 1 analyse ; l'analyse du risque qui suit, sur la même
annonce, est incluse (décrite par « Inclus avec l'identification », même quota à 0). Le résultat
s'affiche dans la pilule (glyphe ● Sûr, ◐ Probable, ○ Incertain, référence et niveau ; le
pourcentage est dans le panneau) et dans la section Produit du panneau ; sur une page de
résultats, l'infobulle d'une carte analysée ajoute la ligne « référence · niveau ». Après une
erreur de l'analyse du risque, le message de la pilule ouvre le panneau, qui garde le produit.
Le service worker coupe un flux au bout de 310 s
(`SCAN_TIMEOUT_MS`) : l'API plafonne aujourd'hui un scan à 190 s au total, dont 80 s
d'identification ; la marge laisse la place aux budgets de la spécification (80 s d'identification
puis 180 s d'analyse) quand l'API y reviendra.
La galerie (`pnpm --filter extension gallery`, port 3101) montre chacun de ces états.

### Sur une annonce (2ememain, 2dehands ou Facebook Marketplace)

1. Ouvrir une annonce, par exemple `https://www.2ememain.be/v/…` ou
   `https://www.facebook.com/marketplace/item/…`.
2. Cliquer sur « Analyser avec l'IA », dans la pastille, ou ouvrir le panneau puis cliquer sur
   « Lancer une analyse IA ». Pendant l'analyse, la pastille s'élargit : une icône qui tourne et
   une ligne de texte qui suit l'analyse en direct (photos, titres de réflexion du modèle,
   recherches web et leurs domaines, rédaction). Le panneau montre le déroulé complet.
3. Le résultat montre le niveau de risque et le score, un résumé, un conseil, les raisons
   (« Pourquoi »), le déroulé replié sous « Comment l'IA a analysé » et « Analyses restantes : n »,
   qui baisse à chaque analyse. Un admin n'a pas de compteur.
4. Cliquer une seconde fois sur « Lancer une analyse IA » pour la même annonce : le résultat
   est identique et la mention « Résultat déjà disponible : servi depuis le cache » apparaît.
   Le compteur baisse quand même d'une unité.
5. Une annonce sans photo est analysée quand même : le résultat indique « Analysée sans photo ».
6. Sans être connecté, le bouton de la pastille ouvre la popup de connexion et le panneau propose
   « Se connecter » ; sans abonnement actif, il l'indique et renvoie vers les formules. Quota
   épuisé, le bouton est grisé (« Plus d'analyses IA disponibles »).
7. Si le flux est coupé (service worker arrêté, réseau), la pastille affiche « Analyse
   interrompue » avec « Relancer » ; le scan est rendu à l'utilisateur.

### Quand un résultat IA existe

- **La pastille passe sur l'IA.** Elle affiche le score de l'analyse IA, suivi de la mention
  « IA ». Le panneau ne montre plus que l'analyse IA : la liste des signaux locaux disparaît.
  Tant qu'aucun résultat n'existe (ou pendant un premier scan), l'analyse locale reste affichée.
- **Le résultat est gardé 24 h dans le navigateur**, avec une seule place par annonce (une
  entrée à l'ancienne forme, texte et photos, est ignorée). Revenir sur l'annonce l'affiche
  tout de suite, sans nouveau scan. Si le titre, la description, le prix ou
  le type de prix change, la page revient à l'analyse locale.
- **Le résultat partiel d'une carte** (Facebook, voir « Limites à connaître ») ne remplace
  jamais l'analyse de la page de l'annonce.
- **La déconnexion vide ces résultats** (ordinateur partagé).
- **Un résultat repris du navigateur n'affiche pas « Analyses restantes »** : ce compteur n'est
  connu qu'au moment du scan.
- **Bandeau « annonce professionnelle ».** Il apparaît en haut du panneau (et dans l'infobulle
  des cartes) quand 2ememain ou 2dehands classe le vendeur comme professionnel (`sellerType`),
  ou quand l'IA le détecte (`professional`). Son style est neutre : il n'est pas un signal
  d'arnaque et ne cache jamais le score ni les raisons.

### Prompt v2 et règles locales v3

- **Le prompt v2 relance les analyses.** La clé du cache de l'API change avec le prompt : une
  annonce déjà analysée avec le prompt v1 est donc analysée de nouveau, et décomptée du quota.
  Les résultats déjà gardés dans le navigateur restent affichés jusqu'à leurs 24 h.
- **Revenir au prompt v1 :**

  ```sh
  cd services/api && uv run --env-file ../../infra/.env alembic downgrade 0003
  ```

  Les lignes du prompt v2 déjà utilisées par des analyses sont conservées (l'historique reste
  lisible) ; le prompt v1 redevient le prompt actif. Revenir au prompt v2 : `alembic upgrade head`
  (rejouable sans risque). La montée refuse une ligne v2 dont le texte diffère de celui de la
  migration (base de dev qui a joué une version antérieure de 0004) : réinitialiser cette base.
- **Règles locales v4** (`RULES_VERSION = 4`) : une règle `abroad_seller` (vendeur ou objet à
  l'étranger ; un envoi par transporteur ne compte qu'avec « étranger », « buitenland » ou un
  intermédiaire), des listes de mots-clés plus riches et plus précises (carte cadeau seulement
  comme moyen de paiement, « acompte » et « voorschot » ignorés après une négation, « mail me »
  en mots entiers), et, pour un prix fixe de moins de 30 €, des signaux faibles (`few_photos`,
  `no_reviews`, `new_account`, `short_description`) qui ne comptent que pour la moitié de leur
  poids ; un `new_account` ainsi atténué passe en `warning`.

### Sur une page de résultats

Pages concernées : une recherche ou une liste de catégorie sur 2ememain ou 2dehands
(`https://www.2ememain.be/q/iphone/`, `https://www.2ememain.be/l/…`), et la grille de
Facebook Marketplace.

1. Une icône « R » apparaît sur chaque carte, pour un compte en essai, premium ou admin
   seulement. Elle n'est jamais lancée toute seule : un scan n'est consommé qu'au clic.
2. Un clic sur « R » analyse l'annonce de la carte sans ouvrir l'annonce. L'icône
   indique « Analyse… » pendant le scan, puis le niveau de risque.
3. Passer la souris sur l'icône (ou la focaliser au clavier) affiche le résumé. Échap le
   ferme. Un second clic sur une carte déjà analysée ne fait rien ; si l'analyse a échoué
   (« R ! »), il la relance.
4. Ouvrir ensuite l'annonce elle-même et lancer l'analyse depuis le panneau : elle est
   servie depuis le cache.

### Limites à connaître

- **Facebook, analyse partielle.** L'extension lit la fiche de l'annonce par une requête
  directe, sans exécuter le JavaScript de la page. Sur Facebook, cette fiche ne contient
  souvent pas les données complètes : l'analyse se fait alors avec les seules informations de
  la carte et le résumé indique « Analyse partielle ». Pour une analyse complète, ouvrir
  l'annonce et l'analyser depuis le panneau.
- **Annonces professionnelles de 2ememain** (`a…`), dont la fiche n'est pas encore prise en
  charge : pas d'icône.
- **Carte sans icône sur 2ememain.** Certaines cartes reçoivent leur lien tard : l'icône
  apparaît dès que le site l'a renseigné (au défilement, ou après quelques instants).
- **Fiche Facebook ouverte en fenêtre modale.** Les icônes de la grille restent en place
  derrière la fiche ; les cartes chargées pendant qu'elle est ouverte n'en reçoivent qu'à
  sa fermeture.
- **Connexion depuis la popup.** Au retour sur l'onglet, le panneau et les icônes se mettent
  à jour d'eux-mêmes : inutile de recharger la page. Un abonnement tout juste souscrit
  peut mettre jusqu'à 30 s à apparaître (l'accès d'un compte sans abonnement est relu au
  plus toutes les 30 s), et un accès actif est gardé 5 min d'une page à l'autre.

### En cas de problème

- **« Session expirée, reconnectez-vous. »** : se reconnecter depuis la popup de l'extension
  (le bouton « Se connecter » du panneau l'ouvre, sinon cliquer sur l'icône Radarnaque de la
  barre d'outils), puis revenir sur l'onglet. Sur une recherche, seule l'icône cliquée reste,
  avec ce message ; les autres reviennent après la reconnexion.
- **« L'analyse a échoué. Elle ne vous a pas été décomptée. »** : c'est l'erreur
  `analysis_failed` (502) de l'API. Vérifier le fournisseur actif (`radarnaque-llm list`) :
  `pnpm llm:stub` lancé pour `stub`, clé valide et quota non atteint pour Groq, proxy
  `npx openai-oauth` lancé pour `openai-oauth`. Les logs `[api]` donnent la raison.
- **« Vous avez utilisé toutes vos analyses… »** : le quota est épuisé. Un essai n'a que 3
  analyses au total ; se connecter depuis la popup avec une
  nouvelle adresse email crée un compte neuf, donc un nouvel essai de 3 analyses.
- **Pas d'icône « R » sur une recherche** : le compte est-il en essai, premium ou admin ? la
  page est-elle bien une recherche (`/q/…`, `/l/…`) et non une fiche ? Une annonce
  professionnelle (`a…`), dont la fiche n'est pas encore prise en charge, n'en a jamais.

## Superuser de développement

Un compte « superuser » sert à essayer les analyses IA sans compter : aucun quota, aucune
limite de requêtes, toutes les fonctionnalités (photos, icônes des cartes). Il voit aussi tout
ce qui se passe pendant une analyse. La popup affiche « Superuser (dev) ».

### L'activer

1. Ajouter `DEV_SUPERUSER_EMAIL=<email>` dans `infra/.env` (jamais commité : le dépôt est
   public).
2. Relancer `pnpm dev`. Au démarrage, le service auth donne le rôle `superuser` à ce compte
   et le crée s'il n'existe pas.
3. Se connecter normalement depuis la popup avec cette adresse.

Changer la variable ne rétrograde pas l'ancien compte. Si besoin, dans la base :
`update auth."user" set role = 'user' where email = '<email>';`

Un compte admin n'est jamais rétrogradé en superuser : il garde son rôle.

Pour un autre compte, sans toucher à `infra/.env` :

```bash
pnpm dev:superuser <email>
```

Codes de sortie : `1` compte inconnu, `2` production, `3` compte admin (laissé tel quel),
`64` argument absent ou invalide.

> Au tout premier démarrage, le log de l'auth peut afficher une erreur d'initialisation de
> l'essai (« trial bootstrap ») tant que l'API n'est pas encore lancée. Elle est sans gravité.

### Où voir les logs

| Où | Comment l'ouvrir |
|---|---|
| Console de l'API | Le terminal de `pnpm dev`, lignes `[api]` : blocs `[debug superuser]`. |
| Console de la page | Sur la fiche ou la page de recherche : DevTools (F12), onglet Console, filtre « Radarnaque debug ». |
| Console du service worker | `chrome://extensions`, carte Radarnaque, lien « service worker », onglet Console. |
| Panneau | Section « Debug (superuser) » du badge, avec les boutons « Copier » et « Relancer sans cache ». |

Ce que chacun montre :

- **Console de la page :** l'annonce extraite et ses champs manquants, les règles locales
  (score, niveau, signaux), la requête envoyée (sans l'identité du vendeur) et la réponse
  reçue, avec le bloc `debug`.
- **Console du service worker :** la requête envoyée à l'API (sans l'identité du vendeur), la
  réponse avec le bloc `debug`, ou le code d'erreur. Après une mise en veille du service
  worker, les logs reprennent au scan suivant.
- **Console de l'API :** le fournisseur et le modèle, le prompt système, les messages envoyés
  au modèle, la réponse brute, le cache (résultat servi du cache ou nouvel appel), les
  tokens, le coût, les durées et les empreintes (hashes).
- **Panneau :** les mêmes éléments du bloc `debug`, repliés. « Copier » met le bloc complet
  en JSON dans le presse-papiers.

Jamais affichés : les clés d'API, les jetons de session et le contenu des images. Le bloc
`debug` n'est jamais conservé dans le stockage local du navigateur.

### Relancer sans cache

Le bouton « Relancer sans cache » du panneau force un nouvel appel au modèle, même si
l'annonce a déjà été analysée. Le résultat remplace l'analyse partagée, sur place. Il est
sans effet pour les autres rôles.

### Inactif en production

Le rôle est ignoré par l'API quand `ENV=production` (posé par l'image Docker de l'API), et
le service auth refuse de l'attribuer quand `NODE_ENV=production` (`DEV_SUPERUSER_EMAIL` y
est ignoré). Le build de production de l'extension (`pnpm --filter extension build`)
n'envoie jamais `content/debug` et ne lit pas `me` pour le debug. Rien de tout cela
n'existe donc pour un vrai utilisateur.

## Changer de fournisseur

En production, les modèles sont ceux d'OpenRouter (clé `OPENROUTER_API_KEY` dans
`infra/.env`) :

```sh
docker compose -f infra/docker-compose.yml --env-file infra/.env exec api \
  radarnaque-llm use openrouter google/gemini-3.1-flash-lite --kind full
```

En dev, mêmes commandes avec `cd services/api && uv run --env-file ../../infra/.env
radarnaque-llm …`. La composition de production passe à l'API `OPENROUTER_API_KEY`,
`GROQ_API_KEY`, `OMNIROUTE_API_KEY`, `OMNIROUTE_BASE_URL` et `OLLAMA_BASE_URL`, toutes
facultatives.

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

   `base_url_env` (facultatif) nomme une variable qui remplace `base_url`, `extra_body`
   (facultatif) ajoute des champs à chaque requête (voir l'entrée `openrouter`), et
   `max_images` (facultatif) réduit le nombre de photos envoyées si le fournisseur en accepte
   moins de 4 par requête (voir l'entrée `groq`), et `omit_params` (facultatif, parmi
   `temperature` et `max_tokens`) retire des paramètres d'appel qu'il refuse (voir l'entrée
   `openai-oauth`). `api` (facultatif, `"chat"` par défaut) choisit l'API d'appel : `"chat"`
   (`/chat/completions`) ou `"responses"` (`/responses`, pour un fournisseur qui n'accepte
   les photos que par l'API Responses, voir l'entrée `openai-oauth`). `reasoning_effort`
   (facultatif, `none` par défaut) règle la réflexion du modèle : voir « Réflexion et recherche
   web » ci-dessous.
2. Définir la variable dans `infra/.env` ; en production, l'ajouter aussi à l'environnement
   du service `api` dans `infra/docker-compose.yml` (`MONFOURNISSEUR_API_KEY:
   ${MONFOURNISSEUR_API_KEY:-}`).
3. Redémarrer l'API : `providers.toml` est lu au démarrage, et l'API refuse de démarrer si un
   modèle en base référence un fournisseur absent du fichier.
4. `radarnaque-llm list` doit afficher le fournisseur avec `clé: oui` ; puis
   `radarnaque-llm use monfournisseur <modèle> --kind full` et `pnpm e2e:scan`.

## Réflexion et recherche web

Chaque analyse peut réfléchir et chercher sur le web. Les deux se règlent sans toucher au code.

- **`reasoning_effort`** (`none`, `low`, `medium` ou `high`) est une option de chaque fournisseur
  de `services/api/providers.toml`. Avec l'API Responses (`openai-oauth`), l'API envoie
  `reasoning: { effort, summary: "auto" }` ; avec l'API Chat d'OpenRouter, `reasoning: { effort }`
  dans le corps. Valeurs de départ : `openai-oauth` `high`, `openrouter` `low`, les autres
  `none`. Les résumés de réflexion sont relayés en direct à l'extension. Le fournisseur est lu
  au démarrage de l'API : la redémarrer après une modification du fichier.
- **Recherche web :** le modèle appelle l'outil `web_search`, que l'API exécute sur SearXNG
  (`SEARCH_BACKEND=searxng`, `SEARXNG_URL=http://127.0.0.1:8888` en dev). Au plus
  `settings.max_web_searches` recherches par analyse (3 par défaut, de 0 à 5), modifiable en
  base : `UPDATE app.settings SET max_web_searches = 2;`. `SEARCH_BACKEND=none` retire l'outil.
  Un SearXNG arrêté n'empêche pas l'analyse : l'outil répond « Recherche indisponible ».
- **`pnpm e2e:scan`** passe par la route en flux et affiche chaque événement (`stage`,
  `thinking`, `search`, `search_done`) à son arrivée, puis `E2E SCAN OK`. Avec un fournisseur qui
  réfléchit et cherche (`openai-oauth`, modèle `gpt-6-luna`), on y voit les titres de réflexion et
  les recherches. `--no-stream` revient à la route JSON, sans événements.

## Suppression du compte et purge à 12 mois (RGPD)

- **Supprimer son compte :** dans la popup, connecté, ouvrir « Supprimer mon compte » (en bas),
  taper `SUPPRIMER` (FR) ou `VERWIJDEREN` (NL), puis « Supprimer définitivement ». L'extension appelle
  `DELETE /api/me` (`204`) : l'utilisateur, sa session, son abonnement et ses scans sont
  supprimés en cascade ; les analyses d'annonces restent. La popup revient à l'écran de
  connexion avec « Votre compte a été supprimé. ». Se reconnecter avec la même adresse crée un
  compte neuf, donc un nouvel essai.
- **Purge :** l'API supprime les scans de plus de 12 mois (`SCAN_RETENTION_MONTHS`, par lots de
  5 000), ainsi que les lignes du journal de l'admin (`admin_actions`) et des appels au modèle
  (`llm_calls`) de plus de 12 mois, puis écrit une ligne `system.purge` par passe. La tâche de fond démarre 60 s après l'API, puis tourne toutes les 24 h ; un verrou
  consultatif PostgreSQL empêche deux processus de purger en même temps. L'essai garde son plafond
  de 3 analyses : le nombre de scans purgés est ajouté à `subscriptions.purged_scans`.
- **`PURGE_ENABLED`** (`infra/.env`, `true` par défaut) coupe la tâche de fond. Les tests le
  mettent à `false`. La composition de production ne le transmet pas : la purge y reste active.
- **`radarnaque-purge`** fait une passe tout de suite, quelle que soit `PURGE_ENABLED`, et affiche
  `scan_events supprimés : <n>, admin_actions : <n>, llm_calls : <n>` (ou « purge déjà en cours
  ailleurs ») :

```sh
cd services/api && uv run --env-file ../../infra/.env radarnaque-purge
```

- **Journaux :** une ligne `INFO` par suppression de compte et par passe de purge, sans
  identifiant ni email.
- **Page `/privacy` :** `http://localhost:8080/privacy/?lang=fr` (ou `nl`) ; la popup y mène par
  « Confidentialité ».

## Administration (phase 4b)

L'admin est une application à part (`apps/admin`), servie par Caddy sous `/admin/` sur la même
origine que l'API et l'auth. Interface en français. La barre latérale a cinq écrans :

- **Tableau de bord** (accueil) : activité du jour et des 7 jours (analyses, appels au modèle,
  part servie depuis le cache, échecs, coût IA, recherches web), graphique des 30 derniers jours
  avec un tableau « Voir les données », abonnés actifs, coût du mois et projection, santé du
  service. Les jours sont des jours civils de Bruxelles ; les pourcentages sont arrondis à
  l'entier, le coût moyen par appel s'affiche à 4 décimales.
- **Utilisateurs** : recherche, fiche, plan, rôle, suppression.
- **Offre** : prix, quota, photos, icônes sur les cartes et plafond de chaque plan. Une
  confirmation résume les changements, et l'effet est immédiat. Chaque champ modifié écrit une
  ligne de journal. Un avertissement rappelle de créer le prix dans Stripe quand un identifiant
  Stripe existe, et de mettre `/privacy` à jour quand le nombre de photos change.
- **IA** : fournisseurs, modèles, prompts, réglages, essais du modèle et de la recherche web.
- **Analyses** : liste filtrée des analyses récentes (site, niveau, modèle, prompt, période,
  recherche web, partielle, titre), puis détail avec l'annonce (lien et photos en liens, pas en
  images), le résultat FR et NL, les recherches, les appels au modèle et un lien vers le prompt.
  Les analyses faites avant la migration 0008 n'ont pas de lien vers l'annonce.

### La page des prix et `GET /api/offer`

La page `/pricing` du site (FR et NL) affiche l'offre en cours. Elle lit `GET /api/offer`, une
route publique sans authentification : prix, quotas, photos et icônes des trois plans, sans prix
pour l'essai et sans identifiant Stripe. La réponse a `Cache-Control: public, max-age=300` : après
une modification dans l'écran Offre, la page peut avoir 5 minutes de retard (le serveur garde en plus l'offre 60 s en mémoire, et l'enregistrement vide ce cache). Si l'API ne répond
pas, la page garde des valeurs de secours (3, 150 et 300 analyses ; 4, 1 et 4 photos).

```sh
curl -s http://localhost:8080/api/offer
curl -sI http://localhost:8080/api/offer | grep -i cache-control
```

### L'ouvrir en dev

1. `pnpm dev` (compile l'admin en continu, `[admin]`) ou `pnpm dev:admin` seul.
2. Donner le rôle admin à un compte **déjà créé** (se connecter une fois depuis la popup, ou
   avec `pnpm e2e:login`) :

```sh
pnpm admin:grant <email>
pnpm admin:revoke <email>     # retire le rôle
```

   Codes de sortie : `1` compte inconnu, `3` refus de retirer le dernier admin, `64` argument
   absent ou invalide.
3. Ouvrir `http://localhost:8080/admin/`, saisir l'email : le lien magique et le code arrivent
   dans les logs de l'auth (`[auth]`), comme pour l'extension. Le lien ramène sur `/admin/`, et le
   code se saisit dans la page.

Un utilisateur qui n'est pas admin voit « Accès réservé aux administrateurs ». En dev, un
superuser a aussi accès à l'admin. Les routes d'administration de Better Auth (`/auth/admin/*`)
répondent `404` : tout passe par `/api/admin/*`.

### Premier admin en production

La commande se lance sur le serveur, avec la composition de production :

```sh
docker compose -f infra/docker-compose.yml --env-file infra/.env exec auth \
  node --import tsx scripts/admin-role.ts grant <email>
```

(`revoke` pour retirer le rôle.) Le compte doit déjà exister : se connecter une fois par la
popup avant.

### Journal et vie privée

- Chaque modification faite dans l'admin écrit une ligne dans `admin_actions` (dans la même
  transaction), avec l'ancienne et la nouvelle valeur, jamais d'email ni le texte d'un prompt.
  Une ligne `INFO` sans email ni identifiant est écrite sous `radarnaque.admin`.
- L'API est lancée avec `--no-access-log` (Dockerfile et `pnpm dev:api`) : un email cherché dans
  l'admin n'apparaît dans aucun journal d'accès. Caddy n'a pas de journal d'accès non plus.
- Le rôle est relu en base à chaque requête : retirer le rôle à un admin agit tout de suite.
- Les écrans Tableau de bord et Analyses ne montrent aucun email ni identifiant de compte.
- Vérifications à faire en vrai : voir les suivis de la [partie 1](docs/superpowers/plans/2026-10-21-phase-4b-partie-1-suivi.md) et de la [partie 2](docs/superpowers/plans/2026-10-21-phase-4b-partie-2-suivi.md).

## Déployer

Production : un serveur (Allemagne) avec Docker et Docker Compose, un enregistrement DNS
`radarnaque.mostconsult.be` qui pointe vers lui, et les ports 80 et 443 ouverts (Let's
Encrypt valide le certificat par le port 80). Caddy est le seul service qui publie des
ports ; postgres, auth (3000), api (8000) et searxng (8080) restent sur le réseau interne de
la composition (`SEARXNG_SECRET` est obligatoire dans `infra/.env`). Les routes sont celles du
dev : `/auth/*` → auth, `/api/*` → api, `/admin/*` → l'admin compilée (`apps/admin`), le reste → le
site compilé (`apps/site`), tous deux construits dans l'image Caddy.

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
curl -s -o /dev/null -w '%{http_code}\n' 'https://radarnaque.mostconsult.be/admin/'                           # 200
curl -sI 'https://radarnaque.mostconsult.be/admin/' | grep -iE 'content-security|x-frame|referrer|cache-control'
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
