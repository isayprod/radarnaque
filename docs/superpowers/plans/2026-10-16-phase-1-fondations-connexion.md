# Phase 1 — Fondations et connexion : plan d'implémentation

> **Pour les agents :** sous-skill OBLIGATOIRE : utiliser superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans pour exécuter ce plan tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`) pour le suivi.

**Objectif :** un utilisateur installe l'extension, se connecte sans mot de passe (lien magique ou code à 6 chiffres) et voit dans la popup son plan d'essai avec 3 scans restants. Ces données sont servies par FastAPI, qui vérifie le JWT émis par Better Auth.

**Architecture :** un monorepo pnpm + uv. Le service `auth` (Node, Hono, Better Auth) émet des sessions et des JWT EdDSA. Le service `api` (FastAPI, SQLAlchemy async, Alembic) les vérifie grâce au JWKS et possède le schéma `app`. Les deux partagent un même PostgreSQL 17, mais chacun a son propre schéma. L'extension WXT ne parle au backend qu'à travers son service worker. Une page statique `/auth/callback` transmet la session du lien magique à l'extension.

**Pile technique :** Node 24, pnpm 10, TypeScript 6.0, Hono 4, `@hono/node-server` 2, better-auth 1.7.10, pg 8, Resend 6, Vitest 5, Testcontainers, React 19, WXT 0.21, Tailwind 4, Python 3.13, uv ≥ 0.9, FastAPI 0.143, SQLAlchemy 2.1 (async) + psycopg 3, Alembic 1.20, PyJWT 2.15 + cryptography, pytest 9, testcontainers-python 4, PostgreSQL 17, Caddy 2.

**Spec :** `docs/superpowers/specs/2026-10-16-radarnaque-v4-design.md`. Les sections concernées sont §2, §3, §4.1, §4.6, §4.7, §5, §6.1–6.3, §6.5, §7.1, §7.5, §11 et §12. Le lire avant de commencer.

## Contraintes globales

- Domaine de production : `https://radarnaque.mostconsult.be`. En développement : `http://localhost:8080` (Caddy).
- Routage sur une seule origine : `/auth/*` → service auth (port 3000), `/api/*` → api (port 8000), `/` → `apps/site/dist`.
- Better Auth est monté avec `basePath: "/auth"`. Les tables Better Auth sont dans le schéma Postgres `auth` (pool `pg` avec `options: "-c search_path=auth"`). Les tables FastAPI sont dans le schéma `app`.
- Plugins Better Auth : `magicLink`, `emailOTP`, `bearer`, `jwt`, `admin`. Pas d'`emailAndPassword`.
- Le lien magique et le code OTP expirent tous deux au bout de **600 s**. Le code fait **6** chiffres.
- JWT : EdDSA/Ed25519, `expirationTime: "15m"`, `issuer` et `audience` égaux à `PUBLIC_URL`, `sub` = identifiant de l'utilisateur. Le payload ne contient rien d'autre (`definePayload: () => ({})`).
- `auth.user.role` vaut `user` ou `admin`. Le niveau (`trial`, `standard`, `premium`) se trouve **uniquement** dans `app.subscriptions`.
- Format des erreurs de l'API : `{"error": {"code": str, "message": str, "details": {}}}`. Codes utilisés dans cette phase : `unauthenticated` (401), `forbidden` (403, secret interne invalide), `invalid_request` (422).
- Les champs JSON de l'API sont en camelCase (alias Pydantic). Le Python reste en snake_case.
- Toute l'interface et tous les emails existent en **FR et NL**. La langue par défaut est `nl` si la langue du navigateur commence par `nl`, sinon `fr`.
- Valeurs initiales de l'offre (spec §2.2), insérées par la migration :
  - prix : standard 299 / 2900 centimes, premium 699 / 6900 centimes (EUR, `month` / `year`) ;
  - quotas : trial texte 3, image 3, `total_scan_cap` 3 ; standard texte 150, image 0 ; premium texte 1000, image 100 ;
  - fonctionnalités : trial et premium ont `card_icons` et `image_scan` ; standard n'en a aucune ;
  - périodes : trial `lifetime`, standard et premium `subscription_month`.
- Modèles insérés : `openrouter` / `google/gemini-2.5-flash-lite`, actif pour `text` ; `openrouter` / `google/gemini-3.1-flash-lite`, actif pour `image`.
- Secrets uniquement dans `.env`, jamais versionné. `infra/.env.example` documente chaque variable.
- TDD pour tout le code. Un commit par tâche au minimum. Chaque message de commit se termine par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Points de vigilance

1. **Lien magique ouvert dans un navigateur sans l'extension, ou avec un autre identifiant d'extension.** La page de retour doit afficher clairement « Ouvrez ce lien dans le navigateur où Radarnaque est installé, ou saisissez le code reçu par email ». Elle ne doit jamais rester bloquée sur un chargement. Testé dans la tâche 9.
2. **Code OTP erroné ou expiré, ou email saisi avec des majuscules ou des espaces.** L'email est normalisé (`trim` + minuscules) avant tout envoi. Un mauvais code donne un message d'erreur clair et la possibilité de renvoyer un email. Testé dans les tâches 10 et 11.
3. **API indisponible au moment de l'inscription.** Le hook de création d'utilisateur échoue sans bloquer la connexion, et `/api/me` crée l'essai manquant. Testé dans les tâches 5 et 8.
4. **Rotation de clé ou JWT expiré.** Un `kid` inconnu provoque **un** rechargement du JWKS (au plus une fois par minute). Côté extension, un 401 provoque **un** renouvellement du JWT, puis une déconnexion locale. Testé dans les tâches 4 et 10.
5. **Appels concurrents à `/api/me` ou au bootstrap pour un nouvel utilisateur.** Ils ne doivent jamais créer deux abonnements d'essai ni renvoyer une erreur 500. Testé dans la tâche 5.

---

## Structure des fichiers

```
package.json, pnpm-workspace.yaml, biome.json, .gitignore, .nvmrc, README.md
infra/
  docker-compose.dev.yml        postgres + caddy (auth/api tournent sur l'hôte en dev)
  docker-compose.yml            production : caddy, postgres, auth, api, migrate, backup
  Caddyfile.dev, Caddyfile
  postgres/init/01-schemas.sql  CREATE SCHEMA auth; CREATE SCHEMA app;
  backup/backup.sh
  .env.example
services/api/
  pyproject.toml, alembic.ini, Dockerfile
  alembic/env.py, alembic/versions/0001_initial.py
  src/radarnaque_api/
    main.py            create_app()
    config.py          Settings
    db.py              moteur et session async
    errors.py          ApiError + gestionnaires
    export_openapi.py  écrit l'OpenAPI sur stdout
    auth/jwt.py        JwtVerifier, http_jwks_fetcher
    auth/deps.py       current_user, require_internal_secret
    models/            base.py, reference.py, offer.py, subscriptions.py, scans.py, auth_user.py
    services/          periods.py, subscriptions.py, usage.py
    routes/            health.py, me.py, internal.py
    schemas.py         MeOut, QuotaOut
  tests/               conftest.py + un fichier par module
services/auth/
  package.json, tsconfig.json, vitest.config.ts, Dockerfile
  src/
    env.ts             lecture et validation des variables
    auth.ts            createAuth()
    auth-instance.ts   instance construite depuis l'environnement (CLI, migrate, server)
    migrate.ts         applique les migrations Better Auth
    server.ts          démarrage HTTP
    app.ts             createApp() Hono
    sign-in.ts         collecte lien + OTP → un seul email (AsyncLocalStorage)
    rate-limit.ts      limiteur mémoire
    bootstrap.ts       client HTTP vers /api/internal/users/{id}/bootstrap
    mail/mailer.ts, mail/templates.ts
  test/                helpers.ts (Postgres + app), *.test.ts
packages/shared/
  package.json, openapi.json (généré), src/api.ts (généré), src/index.ts
apps/site/
  package.json, vite.config.ts, index.html, auth/callback/index.html
  src/callback.ts, src/deliver-session.ts, src/i18n.ts
  test/deliver-session.test.ts
apps/extension/
  package.json, wxt.config.ts, vitest.config.ts, scripts/extension-id.mjs
  lib/ config.ts, storage.ts, email.ts, i18n.ts, auth-client.ts, jwt-provider.ts,
       api-client.ts, messages.ts, background-handlers.ts
  entrypoints/background.ts, entrypoints/popup/{index.html, main.tsx, App.tsx, style.css}
  test/ *.test.ts(x)
```

---

### Tâche 1 : socle du monorepo et Postgres de développement

**Fichiers :**
- Créer : `package.json`, `pnpm-workspace.yaml`, `biome.json`, `.gitignore`, `.nvmrc`, `README.md`, `infra/docker-compose.dev.yml`, `infra/postgres/init/01-schemas.sql`, `infra/.env.example`

**Interfaces :**
- Produit :
  - l'espace de travail pnpm (`apps/*`, `services/auth`, `packages/*`) ;
  - les scripts racine `lint` (`biome check .`), `test` (`pnpm -r test`) et `db:up` (`docker compose -f infra/docker-compose.dev.yml up -d postgres`) ;
  - en dev, la base `radarnaque` sur `localhost:5432`, avec l'utilisateur `radarnaque` et le mot de passe `radarnaque`.

- [ ] **Étape 1 : écrire les fichiers.**
  - `.nvmrc` = `24`.
  - Le `package.json` racine est `private`, avec `packageManager: "pnpm@10.26.1"` et `engines.node: ">=24"`.
  - `.gitignore` couvre `node_modules`, `dist`, `.output`, `.wxt`, `.venv`, `__pycache__`, `.env`, `*.pem` et `.pytest_cache`.
  - `01-schemas.sql` crée les schémas `auth` et `app`.
  - `.env.example` liste toutes les variables de la spec §11 (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `RESEND_API_KEY`, `OPENROUTER_API_KEY`, `INTERNAL_API_SECRET`, `EXTENSION_ID`, `JWT_ISSUER`, `JWT_AUDIENCE`), plus `PUBLIC_URL`, `API_INTERNAL_URL`, `AUTH_INTERNAL_URL`, `MAIL_FROM` et `NODE_ENV`, chacune avec un commentaire d'une ligne.
  - `README.md` contient uniquement la section « Démarrer en dev », complétée dans la tâche 12.
- [ ] **Étape 2 : vérifier.**
  Lancer d'abord `uv self update`, car le uv local est en 0.6.9 et le plan exige ≥ 0.9.
  Lancer ensuite `pnpm install && pnpm db:up && docker compose -f infra/docker-compose.dev.yml exec postgres psql -U radarnaque -d radarnaque -c '\dn'`.
  Résultat attendu : la liste contient `app`, `auth` et `public`.
- [ ] **Étape 3 : commit.** Message : `chore: socle du monorepo et Postgres de dev`.

---

### Tâche 2 : squelette de l'API (configuration, erreurs, santé, harnais de test)

**Fichiers :**
- Créer :
  - `services/api/pyproject.toml` (projet `radarnaque-api`, `requires-python = ">=3.13"`, disposition `src/`, groupe de dépendances `dev`) ;
  - `src/radarnaque_api/{__init__,main,config,db,errors}.py` et `routes/health.py` ;
  - `tests/conftest.py` et `tests/test_health_errors.py`.

**Interfaces :**
- Produit :
  - `Settings` (pydantic-settings, préfixe vide) : `database_url: str` (`postgresql+psycopg://…`), `jwks_url: str`, `jwt_issuer: str`, `jwt_audience: str`, `internal_api_secret: SecretStr`, `env: Literal["development", "test", "production"] = "development"`.
  - `ApiError(status: int, code: str, message: str, details: dict | None = None)` (exception), et `install_error_handlers(app: FastAPI) -> None`. Ce dernier convertit `ApiError` au format de la spec et `RequestValidationError` en `422 invalid_request`.
  - `make_engine(url: str) -> AsyncEngine` ; la dépendance `get_session() -> AsyncIterator[AsyncSession]`, avec l'engine dans `app.state.engine`.
  - `create_app(settings: Settings | None = None, *, jwks_fetcher: JwksFetcher | None = None) -> FastAPI`. Le `JwksFetcher` est défini dans la tâche 4. Pour l'instant, le paramètre est accepté mais ignoré.
  - `GET /api/health` → `200 {"status": "ok"}`.
  - Fixtures pytest :
    - `pg_url` (session) : conteneur `postgres:17` lancé par testcontainers ; il crée les schémas `auth` et `app`, ainsi qu'une table **simulant** `auth."user"(id text primary key, email text not null unique, role text not null default 'user')` ;
    - `app`, `client` (`httpx.AsyncClient` avec `ASGITransport`) et `db` (`AsyncSession`).
  - Toutes les dépendances : `fastapi`, `uvicorn[standard]`, `sqlalchemy[asyncio]>=2.1`, `psycopg[binary]>=3.3`, `alembic`, `pydantic-settings`, `pyjwt[crypto]`, `httpx`. En dev : `pytest`, `pytest-asyncio` (`asyncio_mode = "auto"`), `testcontainers[postgres]` et `ruff`.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  ```python
  async def test_health(client):
      r = await client.get("/api/health")
      assert r.status_code == 200 and r.json() == {"status": "ok"}

  async def test_api_error_format(app, client):
      @app.get("/api/_boom")
      async def boom():
          raise ApiError(403, "forbidden", "nope", {"x": 1})
      r = await client.get("/api/_boom")
      assert r.status_code == 403
      assert r.json() == {"error": {"code": "forbidden", "message": "nope", "details": {"x": 1}}}

  async def test_validation_error_format(app, client):
      @app.get("/api/_typed")
      async def typed(n: int):
          return {"n": n}
      r = await client.get("/api/_typed", params={"n": "abc"})
      assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"
  ```
- [ ] **Étape 2 : lancer `cd services/api && uv sync && uv run pytest tests/test_health_errors.py -v`.** Résultat attendu : ÉCHEC (import impossible).
- [ ] **Étape 3 : implémenter** `config.py`, `errors.py`, `db.py`, `routes/health.py`, `main.py` et `conftest.py` selon les interfaces ci-dessus.
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : 3 tests passent.
- [ ] **Étape 5 : commit.** Message : `feat(api): squelette FastAPI, format d'erreur, harnais Postgres`.

---

### Tâche 3 : schéma `app` en 3NF (migration 0001 et données initiales)

**Fichiers :**
- Créer : `services/api/alembic.ini`, `alembic/env.py`, `alembic/versions/0001_initial.py`, `src/radarnaque_api/models/{__init__,base,reference,offer,subscriptions,scans,auth_user}.py` et `tests/test_migration.py`
- Modifier : `tests/conftest.py` (lancer `alembic upgrade head` sur `pg_url` avant les fixtures `app` et `db`)

**Interfaces :**
- Produit des modèles ORM (`Base.metadata.schema = "app"`), exactement selon la spec §6.1 à §6.3 et §6.5, **limités à** :
  - `billing_intervals`, `currencies`, `features`, `quota_periods`, `subscription_statuses`, `billing_providers`, `scan_triggers` ;
  - `models`, `scan_kinds` (sans `active_prompt_version_id`, qui sera ajouté en phase 3) ;
  - `plans`, `plan_prices`, `plan_quotas`, `plan_features` ;
  - `subscriptions` ;
  - `scan_events`, `scan_failures`.
  `scan_results`, les tables d'annonces, `settings`, `admin_actions`, `sites`, `marketplaces` et `locales` viendront dans les phases suivantes.
- `AuthUser` : mapping **en lecture seule** de `auth."user"`, avec les colonnes `id`, `email` et `role`. Il ne fait pas partie des métadonnées migrées par Alembic : `include_object` exclut le schéma `auth`.
- Clés étrangères : `subscriptions.user_id` et `scan_events.user_id` → `auth."user"(id) ON DELETE CASCADE`.
- Index : unique partiel `ux_subscriptions_one_active ON subscriptions(user_id) WHERE status = 'active'` ; `ix_scan_events_user_kind_time ON scan_events(user_id, scan_kind, created_at)`.
- `env.py` lit `DATABASE_URL` (ou `-x url=…`) et range la table de version Alembic dans le schéma `app` (`version_table_schema="app"`).
- Les données initiales sont insérées par la migration elle-même (`op.bulk_insert`) : voir les valeurs des Contraintes globales, ainsi que les statuts (`active`, `canceled`, `past_due`, `expired`), les fournisseurs (`manual`, `stripe`) et les déclencheurs (`button`, `card`).

- [ ] **Étape 1 : écrire les tests qui échouent** dans `tests/test_migration.py`.
  ```python
  async def test_seeded_offer(db):
      q = await db.execute(text(
          "select plan, scan_kind, quota from app.plan_quotas order by plan, scan_kind"))
      assert q.all() == [("premium","image",100),("premium","text",1000),
                         ("standard","image",0),("standard","text",150),
                         ("trial","image",3),("trial","text",3)]
      caps = dict((await db.execute(text("select code, total_scan_cap from app.plans"))).all())
      assert caps == {"trial": 3, "standard": None, "premium": None}
      prices = (await db.execute(text(
          "select plan, interval, amount_cents from app.plan_prices order by 1,2"))).all()
      assert prices == [("premium","month",699),("premium","year",6900),
                        ("standard","month",299),("standard","year",2900)]
      feats = (await db.execute(text("select plan, feature from app.plan_features order by 1,2"))).all()
      assert feats == [("premium","card_icons"),("premium","image_scan"),
                       ("trial","card_icons"),("trial","image_scan")]

  async def test_one_active_subscription_per_user(db, make_user):
      uid = await make_user("a@x.be")
      ins = text("insert into app.subscriptions(user_id, plan, status, provider, period_start, created_at)"
                 " values (:u,'trial','active','manual',now(),now())")
      await db.execute(ins, {"u": uid})
      with pytest.raises(IntegrityError):
          await db.execute(ins, {"u": uid})

  def test_downgrade_then_upgrade(pg_url):  # alembic downgrade base puis upgrade head sans erreur
      ...
  ```
  Ajouter la fixture `make_user(email, role="user") -> str` dans `conftest.py`. Elle insère dans `auth."user"` avec un identifiant `uuid4().hex`.
- [ ] **Étape 2 : lancer `uv run pytest tests/test_migration.py -v`.** Résultat attendu : ÉCHEC (la table `app.plan_quotas` n'existe pas).
- [ ] **Étape 3 : implémenter** les modèles, `env.py` et `0001_initial.py`. Pour la migration, écrire les `op.create_table` explicitement (sans autogénération à l'exécution) et un `downgrade()` qui supprime tout dans l'ordre inverse.
- [ ] **Étape 4 : relancer les tests de la tâche 3 et de la tâche 2.** Résultat attendu : tous passent.
- [ ] **Étape 5 : commit.** Message : `feat(api): schéma app 3NF et offre initiale`.

---

### Tâche 4 : vérification du JWT et identité de l'utilisateur

**Fichiers :**
- Créer : `src/radarnaque_api/auth/{__init__,jwt,deps}.py`, `tests/jwt_helpers.py` et `tests/test_jwt.py`
- Modifier : `main.py` (construire `JwtVerifier` dans `app.state.jwt_verifier` à partir de `jwks_fetcher` ou de `http_jwks_fetcher(settings.jwks_url)`), et `conftest.py` (fournir un fetcher de test)

**Interfaces :**
- Produit :
  - `JwksFetcher = Callable[[], Awaitable[dict]]` ; `http_jwks_fetcher(url: str) -> JwksFetcher` (httpx, délai de 5 s).
  - `JwtVerifier(fetch_jwks: JwksFetcher, issuer: str, audience: str, *, min_refetch_interval: float = 60.0, clock: Callable[[], float] = time.monotonic)`, et `async verify(token: str) -> str`, qui renvoie `sub`.
    - Algorithme accepté : **uniquement `EdDSA`**.
    - Les clés sont mises en cache par `kid`. Pour un `kid` inconnu, le JWKS est rechargé au plus une fois par `min_refetch_interval`.
    - Toute erreur lève `ApiError(401, "unauthenticated", …)`.
  - `async current_user(request, session) -> AuthUser` : lit `Authorization: Bearer <jwt>`, vérifie le JWT, puis charge `auth."user"`. Si l'utilisateur est absent → `401 unauthenticated`.
  - `require_internal_secret(x_internal_secret: str = Header())` : comparaison en temps constant. Si le secret ne correspond pas → `403 forbidden`.
  - `tests/jwt_helpers.py` : `KeyPair.generate(kid)`, `make_jwks(*pairs) -> dict` et `sign(pair, sub, iss, aud, exp_in=900, alg="EdDSA") -> str`.

- [ ] **Étape 1 : écrire les tests qui échouent.** Les tests unitaires portent sur `JwtVerifier`. Le test d'intégration ajoute une route de test protégée par `current_user`.
  ```python
  async def test_valid_token_returns_sub(): ...                      # == "user-1"
  async def test_expired_token_rejected(): ...                       # exp_in=-10 → ApiError 401 "unauthenticated"
  async def test_wrong_issuer_or_audience_rejected(): ...
  async def test_hs256_and_none_rejected(): ...                      # jeton forgé alg=HS256 / alg=none → 401
  async def test_unknown_kid_refetches_once_per_interval():
      # fetcher qui compte les appels ; jeton signé par une clé "k2" absente du 1er JWKS
      # 1er verify → refetch (2 appels) → OK si k2 dans le 2e JWKS
      # jeton "k3" inconnu deux fois dans la même minute → un seul refetch supplémentaire
  async def test_current_user_missing_header_401(client): ...
  async def test_current_user_unknown_user_401(client): ...          # JWT valide, sub absent de auth."user"
  async def test_current_user_ok(client, make_user): ...             # renvoie id/email/role
  ```
- [ ] **Étape 2 : lancer `uv run pytest tests/test_jwt.py -v`.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter** `jwt.py` et `deps.py`. Utiliser `jwt.PyJWK(jwk_dict)` pour les clés OKP/Ed25519 et `jwt.decode(token, key, algorithms=["EdDSA"], issuer=…, audience=…, options={"require": ["exp", "sub", "iss", "aud"]})`.
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : ils passent.
- [ ] **Étape 5 : commit.** Message : `feat(api): vérification JWT EdDSA via JWKS`.

---

### Tâche 5 : abonnement d'essai, calcul des quotas, `/api/me` et bootstrap interne

**Fichiers :**
- Créer :
  - `src/radarnaque_api/services/{periods,subscriptions,usage}.py`, `routes/{me,internal}.py` et `schemas.py` ;
  - `tests/test_periods.py`, `tests/test_subscriptions.py` et `tests/test_me.py`.
- Modifier : `main.py` (enregistrer les routes)

**Interfaces :**
- Produit :
  - `current_period_start(anchor: datetime, now: datetime) -> datetime`. Renvoie le dernier anniversaire mensuel de `anchor` qui est ≤ `now`. Le jour est plafonné à la fin du mois, **toujours à partir du jour d'origine** de `anchor` (31 janv. → 28 févr. → 31 mars).
  - `bootstrap_trial(session, user_id: str) -> bool`.
    - Ne crée rien si l'utilisateur a déjà **au moins un** abonnement, quel que soit son statut. Un essai terminé ne se renouvelle donc pas.
    - Sinon, insère `trial` / `active` / `manual` avec `period_start = now()`. Renvoie `True` si une ligne a été créée.
    - Doit être sûr en cas d'appels concurrents : `INSERT … ON CONFLICT DO NOTHING` sur l'index partiel, ou capture de `IntegrityError`.
  - `get_active_subscription(session, user_id) -> Subscription | None`.
  - `compute_usage(session, sub: Subscription, now: datetime) -> UsageSummary`.
    - `UsageSummary(period_start: datetime, per_kind: dict[str, KindUsage], total: KindUsage | None)` et `KindUsage(limit: int, used: int, remaining: int)`.
    - `used` compte les `scan_events` de l'utilisateur, pour ce type, depuis le début de la période, en excluant ceux qui ont un `scan_failures`.
    - Le début de période vaut `sub.period_start` pour `lifetime`, et `current_period_start(sub.period_start, now)` pour `subscription_month`.
    - `remaining` = `max(0, limit - used)`. Si `total_scan_cap` est défini, le résultat est plafonné par `max(0, cap - used_total)`.
  - `MeOut` (camelCase) : `userId`, `email`, `role: Literal["user", "admin"]`, `plan: str | None`, `features: list[str]`, `unlimited: bool`, `periodStart: datetime | None`, `quotas: list[QuotaOut]` et `totalCap: QuotaOut | None`, avec `QuotaOut(scanKind: str | None, limit: int, used: int, remaining: int)`.
  - `GET /api/me` :
    - **admin** : `unlimited=true`, toutes les fonctionnalités de la table `features`, `quotas=[]`, `totalCap=null`, et `plan` égal à son abonnement actif s'il en a un.
    - **utilisateur sans aucun abonnement** : appel de `bootstrap_trial`, puis réponse.
    - **utilisateur sans abonnement actif** : `plan=null`, `features=[]`, `quotas=[]`.
  - `POST /api/internal/users/{user_id}/bootstrap` (`require_internal_secret`) : renvoie `{"created": bool}` ; si l'utilisateur est inconnu de `auth."user"` → `404 not_found`.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  ```python
  # test_periods.py — dates en UTC
  @pytest.mark.parametrize("anchor,now,expected", [
      ("2026-01-31T10:00", "2026-03-15T00:00", "2026-02-28T10:00"),
      ("2026-01-31T10:00", "2026-03-31T11:00", "2026-03-31T10:00"),
      ("2026-01-31T10:00", "2026-03-31T09:00", "2026-02-28T10:00"),
      ("2026-05-15T00:00", "2026-05-15T00:00", "2026-05-15T00:00"),
      ("2025-12-10T00:00", "2026-01-09T23:59", "2025-12-10T00:00"),
  ])
  def test_current_period_start(anchor, now, expected): ...

  # test_subscriptions.py
  async def test_bootstrap_creates_trial_once(db, make_user): ...          # True puis False
  async def test_bootstrap_skips_user_with_canceled_sub(db, make_user): ...  # False, aucun nouvel essai
  async def test_bootstrap_concurrent_calls_single_row(pg_url, make_user):
      # 10 x asyncio.gather sur des sessions distinctes → exactement 1 ligne, aucune exception
  async def test_usage_trial_shared_cap(db, make_user):
      # essai + 2 events texte + 1 event image dont 1 texte en échec (scan_failures)
      # → text used=1, image used=1, remaining text=1, image=1, total used=2 remaining=1
  async def test_usage_standard_monthly_window(db, make_user):
      # period_start 2026-01-31 ; events au 2026-02-27 et 2026-03-01 ; now=2026-03-10
      # → période 2026-02-28 ; used text = 1 ; remaining = 149

  # test_me.py
  async def test_me_new_user_gets_trial(client, make_user, bearer):
      body = (await client.get("/api/me", headers=bearer(uid))).json()
      assert body["plan"] == "trial" and body["unlimited"] is False
      assert sorted(body["features"]) == ["card_icons", "image_scan"]
      assert {q["scanKind"]: q["remaining"] for q in body["quotas"]} == {"text": 3, "image": 3}
      assert body["totalCap"] == {"scanKind": None, "limit": 3, "used": 0, "remaining": 3}
  async def test_me_admin_unlimited(...): ...
  async def test_me_without_active_sub(...): ...           # abonnement canceled → plan None
  async def test_me_requires_auth(client): ...             # 401 unauthenticated
  async def test_internal_bootstrap_requires_secret(client, make_user): ...  # 403 forbidden
  async def test_internal_bootstrap_ok_and_idempotent(...): ...              # {"created": true} puis false
  async def test_internal_bootstrap_unknown_user_404(...): ...
  ```
  La fixture `bearer(uid) -> dict` signe un JWT avec la paire de clés de test.
- [ ] **Étape 2 : lancer `uv run pytest -v`.** Résultat attendu : les nouveaux tests échouent.
- [ ] **Étape 3 : implémenter** `periods.py`, `subscriptions.py`, `usage.py`, `schemas.py` et les deux routes.
- [ ] **Étape 4 : relancer `uv run pytest -v`.** Résultat attendu : tous les tests passent.
- [ ] **Étape 5 : commit.** Message : `feat(api): essai automatique, calcul des quotas, /api/me`.

---

### Tâche 6 : contrat OpenAPI et types TypeScript partagés

**Fichiers :**
- Créer : `services/api/src/radarnaque_api/export_openapi.py`, `packages/shared/{package.json,tsconfig.json,src/index.ts}` et `scripts/gen-api.sh`
- Générés et versionnés : `packages/shared/openapi.json` et `packages/shared/src/api.ts`

**Interfaces :**
- Produit :
  - `uv run python -m radarnaque_api.export_openapi` écrit l'OpenAPI JSON trié sur stdout. Il fonctionne avec des `Settings` factices, sans base de données.
  - `pnpm gen:api` (script racine) appelle `scripts/gen-api.sh`, qui exporte `openapi.json` puis lance `openapi-typescript openapi.json -o src/api.ts`.
  - `pnpm check:api` régénère les fichiers dans un dossier temporaire puis exécute `diff`. Il échoue si les fichiers versionnés divergent.
  - `@radarnaque/shared` exporte `type Me = components["schemas"]["MeOut"]`, `type ApiErrorBody = { error: { code: string; message: string; details: Record<string, unknown> } }` et `type Locale = "fr" | "nl"`.

- [ ] **Étape 1 : écrire `export_openapi.py` et le script, puis lancer `pnpm gen:api`.** Résultat attendu : `packages/shared/src/api.ts` contient `MeOut` avec `userId`, `unlimited` et `totalCap`.
- [ ] **Étape 2 : lancer `pnpm check:api`.** Résultat attendu : code de sortie 0. Ajouter ensuite temporairement un champ à `MeOut`, relancer `pnpm check:api` : il doit échouer (code ≠ 0). Retirer le champ.
- [ ] **Étape 3 : commit.** Message : `feat(shared): types TS générés depuis l'OpenAPI`.

---

### Tâche 7 : service auth, configuration Better Auth, migrations et emails

**Fichiers :**
- Créer :
  - `services/auth/{package.json,tsconfig.json,vitest.config.ts}` ;
  - `src/{env,auth,auth-instance,migrate}.ts` et `src/mail/{mailer,templates}.ts` ;
  - `test/helpers.ts`, `test/templates.test.ts` et `test/migrate.test.ts`.

**Interfaces :**
- Produit :
  - `loadEnv(source = process.env) -> Env`. `Env` contient `PUBLIC_URL`, `BETTER_AUTH_SECRET` (≥ 32 caractères), `DATABASE_URL`, `EXTENSION_ID` (32 lettres de a à p), `API_INTERNAL_URL`, `INTERNAL_API_SECRET`, `MAIL_FROM`, `RESEND_API_KEY` (obligatoire si `NODE_ENV=production`) et `NODE_ENV`. Une variable manquante ou invalide lève une `Error` qui nomme la variable.
  - `interface Mailer { send(msg: { to: string; subject: string; html: string; text: string }): Promise<void> }`. Trois implémentations :
    - `ResendMailer(apiKey, from)` ;
    - `ConsoleMailer`, qui affiche dans les logs ;
    - `MemoryMailer`, qui conserve les messages envoyés et expose `last(to)` (tests et route de dev).
  - `renderSignInEmail({ locale, url, otp }: { locale: Locale; url: string; otp: string }) -> { subject, html, text }`. Il y a un texte FR et un texte NL. L'email contient le lien et le code, avec la mention de leur validité de 10 minutes.
  - `createAuth(o: { pool: Pool; env: Env; mailer: Mailer; onUserCreated: (userId: string) => Promise<void> })` renvoie l'instance `betterAuth`. Sa configuration :
    - `basePath: "/auth"`, `baseURL: env.PUBLIC_URL`, `secret`, `trustedOrigins: [env.PUBLIC_URL, \`chrome-extension://${env.EXTENSION_ID}\`]` ;
    - les plugins des Contraintes globales, avec les expirations à 600 s, `otpLength: 6` et `jwt.definePayload: () => ({})` ;
    - `rateLimit: { enabled: true }` ;
    - `databaseHooks.user.create.after`, qui appelle `onUserCreated(user.id)`. **En cas d'erreur, il la journalise sans la relancer**, pour que la connexion n'échoue jamais à cause de l'API.
    - Les callbacks `sendMagicLink` et `sendVerificationOTP` délèguent à `sign-in.ts`, qui sera créé dans la tâche 8. Pour l'instant, ils envoient un email minimal via `mailer`.
  - `auth-instance.ts` exporte `auth`, construit à partir de `loadEnv()` et d'un `Pool` qui a `options: "-c search_path=auth"`.
  - `migrate.ts` : `runAuthMigrations(auth) -> Promise<void>` utilise `getMigrations(auth.options)` de `better-auth/db/migration`, puis `runMigrations()`. Exécuté directement (`node --import tsx src/migrate.ts`), il migre l'instance de l'environnement.
  - `test/helpers.ts` : `startPg()` (testcontainers `postgres:17`, crée les schémas `auth` et `app`) et `testEnv(overrides)`.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  ```ts
  test("FR/NL sign-in email contains link and 6-digit code", () => {
    for (const locale of ["fr", "nl"] as const) {
      const m = renderSignInEmail({ locale, url: "https://x/auth/magic-link/verify?token=t", otp: "123456" });
      expect(m.html).toContain("https://x/auth/magic-link/verify?token=t");
      expect(m.text).toContain("123456");
    }
    expect(renderSignInEmail({ locale: "nl", url: "u", otp: "1" }).subject).not.toEqual(
      renderSignInEmail({ locale: "fr", url: "u", otp: "1" }).subject);
  });
  test("migrations create Better Auth tables in schema auth, with role column", async () => {
    // startPg → createAuth → runAuthMigrations
    // information_schema.columns : table_schema='auth' contient user, session, account, verification, jwks
    // et la colonne auth."user".role existe ; aucune table créée dans public
  });
  test("loadEnv rejects a short secret and an invalid EXTENSION_ID", () => { ... });
  ```
- [ ] **Étape 2 : lancer `pnpm --filter auth test`.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter.** Dépendances : `better-auth@1.7.10`, `pg`, `hono`, `@hono/node-server`, `resend`, `tsx`. En dev : `vitest`, `@testcontainers/postgresql`, `jose`, `typescript@~6.0`, `@types/node`, `@types/pg`.
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : ils passent.
- [ ] **Étape 5 : commit.** Message : `feat(auth): configuration Better Auth, migrations, emails FR/NL`.

---

### Tâche 8 : routes du service auth (connexion combinée, jeton pour l'extension, bootstrap)

**Fichiers :**
- Créer : `services/auth/src/{app,server,sign-in,rate-limit,bootstrap}.ts` et `test/flows.test.ts`
- Modifier : `src/auth.ts` (callbacks d'email → `sign-in.ts`)

**Interfaces :**
- Consomme : `createAuth`, `Mailer`, `renderSignInEmail` et `loadEnv` (tâche 7).
- Produit :
  - `sign-in.ts` :
    - `signInBag: AsyncLocalStorage<{ url?: string; otp?: string }>` ;
    - `onMagicLink(url, email)` et `onOtp(otp, email)`. Dans un `signInBag`, ces fonctions **mémorisent** la valeur. Hors d'un `signInBag`, elles envoient un email autonome ;
    - `startSignIn(auth, mailer, { email, locale, headers }) -> Promise<void>`. Exécute dans `signInBag.run` les appels `auth.api.signInMagicLink({ body: { email, callbackURL: "/auth/callback" }, headers })` puis `auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } })`, et envoie **un seul** email `renderSignInEmail`.
  - `createRateLimiter({ max: 5, windowMs: 15 * 60_000 })` → `hit(key: string): boolean`.
  - `makeBootstrapClient(apiUrl, secret) -> (userId: string) => Promise<void>`. Envoie `POST {apiUrl}/api/internal/users/{id}/bootstrap` avec l'en-tête `x-internal-secret`, un délai de 3 s, et lève une exception si le statut n'est pas 2xx.
  - `createApp({ auth, mailer, env, devMailer?: MemoryMailer }) -> Hono`, avec les routes :
    - `GET /auth/health` → `{ status: "ok" }` ;
    - `POST /auth/start` `{ email, locale }` :
      - l'email est normalisé (`trim` + minuscules) et validé (format invalide → `400 { error: { code: "invalid_email" } }`) ;
      - limite de requêtes par email (`429 { error: { code: "rate_limited" } }`) ;
      - si l'`Origin` est présent et absent de `trustedOrigins` → `403` ;
      - **toujours `200 { ok: true }`** dès que l'email est valide, que l'utilisateur existe ou non ;
    - `GET /auth/extension/session-token` → `{ token }`, à partir de `auth.api.getSession({ headers })`. Sans session → `401` ;
    - `GET /auth/dev/last-email?to=…` **uniquement si `NODE_ENV === "development"`** (sinon `404`) → `{ url, otp }` extraits du dernier email du `MemoryMailer` ;
    - `ALL /auth/*` → `auth.handler(c.req.raw)`.
  - `server.ts` :
    - lance `runAuthMigrations` si `AUTH_MIGRATE_ON_START=1`, puis `serve({ fetch: app.fetch, port: 3000 })` ;
    - en développement : `MemoryMailer` + `ConsoleMailer` ; en production : `ResendMailer`.

- [ ] **Étape 1 : écrire les tests qui échouent** (`test/flows.test.ts`, Postgres réel, `app.request(...)` de Hono).
  ```ts
  test("start sends exactly one email with link and 6-digit code", ...)
    // POST /auth/start {email:" Alice@Test.BE ", locale:"nl"} → 200 ; mailer.sent.length === 1 ;
    // destinataire "alice@test.be" ; lien contient "/auth/magic-link/verify?token=" ; code /^\d{6}$/
  test("unknown or known email both return 200 {ok:true}", ...)
  test("6th start within 15 min for same email → 429", ...)
  test("OTP sign-in returns set-auth-token, usable to get a JWT", async () => {
    // POST /auth/sign-in/email-otp {email, otp} (Origin chrome-extension://<EXTENSION_ID>) → 200
    // token = res.headers.get("set-auth-token") ; GET /auth/token Authorization: Bearer token → { token: jwt }
    // jose.jwtVerify(jwt, createLocalJWKSet(await GET /auth/jwks), { issuer: PUBLIC_URL, audience: PUBLIC_URL })
    // payload.sub === user id ; exp - iat === 900 ; protectedHeader.alg === "EdDSA"
  })
  test("wrong OTP → non-2xx and no set-auth-token header", ...)
  test("request from untrusted Origin is rejected", ...)   // Origin https://evil.example → 403
  test("magic link verify then /auth/extension/session-token returns bearer token", ...)
    // GET lien de vérification → cookie de session ; GET /auth/extension/session-token avec ce cookie → {token}
    // le token fonctionne sur GET /auth/token
  test("session-token without session → 401", ...)
  test("new user triggers onUserCreated exactly once; failing hook does not break sign-in", ...)
  test("dev last-email route is 404 when NODE_ENV=production", ...)
  ```
- [ ] **Étape 2 : lancer `pnpm --filter auth test`.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter** `sign-in.ts`, `rate-limit.ts`, `bootstrap.ts`, `app.ts` et `server.ts`. Dans `startSignIn`, si `url` ou `otp` manque encore après les deux appels (par exemple parce que Better Auth a exécuté un callback en arrière-plan), lever une erreur explicite plutôt que d'envoyer un email incomplet. Le test « exactly one email » révèle ce cas.
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : tous passent.
- [ ] **Étape 5 : commit.** Message : `feat(auth): connexion lien+code en un email, jeton extension, bootstrap`.

---

### Tâche 9 : page `/auth/callback` (site statique)

**Fichiers :**
- Créer : `apps/site/{package.json,vite.config.ts,index.html,auth/callback/index.html}`, `src/{callback,deliver-session,i18n}.ts` et `test/deliver-session.test.ts`

**Interfaces :**
- Produit :
  - `deliverSession(deps: { fetchToken: () => Promise<string | null>; sendToExtension: (token: string) => Promise<boolean> }) -> Promise<"connected" | "expired" | "no-extension">`. Un délai de 3 s sur `sendToExtension` donne `"no-extension"`.
  - `callback.ts` :
    - branche `fetchToken` sur `fetch("/auth/extension/session-token", { credentials: "same-origin" })` (statut ≠ 200 → `null`) ;
    - branche `sendToExtension` sur `chrome.runtime.sendMessage(import.meta.env.VITE_EXTENSION_ID, { type: "radarnaque/session", token })`. Si `chrome.runtime` est absent, la valeur vaut `false`. Sinon, la réponse doit être `{ ok: true }` ;
    - affiche le message correspondant en FR ou NL.
  - Messages :
    - `connected` : « Connecté ✓ Vous pouvez fermer cet onglet. » / « Verbonden ✓ U kunt dit tabblad sluiten. » ;
    - `expired` : « Lien expiré ou déjà utilisé. Demandez un nouveau lien depuis l'extension. » / « Link verlopen of al gebruikt. Vraag een nieuwe link aan via de extensie. » ;
    - `no-extension` : « Ouvrez ce lien dans le navigateur où Radarnaque est installé, ou saisissez le code reçu par email dans l'extension. » / « Open deze link in de browser waar Radarnaque geïnstalleerd is, of voer de code uit de e-mail in de extensie in. »
  - Le build Vite multi-pages produit `dist/auth/callback/index.html`. L'`index.html` racine est un simple placeholder.

- [ ] **Étape 1 : écrire les tests qui échouent.** Couvrir les quatre cas :
  - jeton présent et extension qui répond ok → `"connected"` ;
  - `fetchToken` qui renvoie `null` → `"expired"`, et `sendToExtension` n'est **pas** appelé ;
  - `sendToExtension` qui renvoie `false` → `"no-extension"` ;
  - `sendToExtension` qui ne se résout jamais → `"no-extension"` après 3 s (faux minuteurs).
  Ajouter un test i18n : les 3 états ont un texte FR et un texte NL non vides et différents.
- [ ] **Étape 2 : lancer `pnpm --filter site test`.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : relancer les tests, puis `pnpm --filter site build`.** Résultat attendu : les tests passent et `apps/site/dist/auth/callback/index.html` existe.
- [ ] **Étape 5 : commit.** Message : `feat(site): page de retour du lien magique`.

---

### Tâche 10 : extension, service worker et clients

**Fichiers :**
- Créer :
  - `apps/extension/{package.json,wxt.config.ts,vitest.config.ts,scripts/extension-id.mjs}` ;
  - `lib/{config,storage,email,auth-client,jwt-provider,api-client,messages,background-handlers}.ts` et `entrypoints/background.ts` ;
  - `test/{email,auth-client,jwt-provider,api-client,background-handlers}.test.ts`.

**Interfaces :**
- Consomme : `Me`, `ApiErrorBody` et `Locale` de `@radarnaque/shared` (tâche 6) ; les routes `/auth/start`, `/auth/sign-in/email-otp`, `/auth/token` et `/auth/sign-out` (tâches 7 et 8) ; `GET /api/me` (tâche 5).
- Produit :
  - `wxt.config.ts` :
    - module `@wxt-dev/module-react` ;
    - `manifest.key = process.env.WXT_EXTENSION_KEY` ;
    - `permissions: ["storage"]` ;
    - `host_permissions: [\`${PUBLIC_URL}/*\`]` ;
    - `externally_connectable.matches` : `["https://radarnaque.mostconsult.be/*"]` en production, `["http://localhost/*"]` en dev (les motifs de correspondance ignorent le port).
  - `scripts/extension-id.mjs <public-key.pem>` affiche la valeur de `key` (DER en base64) et l'identifiant de l'extension : les 32 premiers caractères hexadécimaux du SHA-256 du DER, convertis de `0`–`f` vers `a`–`p`.
  - `config.ts` : `PUBLIC_URL = import.meta.env.WXT_PUBLIC_URL`.
  - `storage.ts` : `sessionToken = storage.defineItem<string | null>("local:sessionToken", { fallback: null })` et `localePref = storage.defineItem<Locale | null>("local:locale", { fallback: null })`.
  - `email.ts` : `normalizeEmail(s: string): string` et `isValidEmail(s: string): boolean`.
  - `auth-client.ts` :
    - `startSignIn(email, locale): Promise<void>` ;
    - `verifyOtp(email, otp): Promise<string>`, qui lit l'en-tête `set-auth-token` ;
    - `fetchJwt(sessionToken): Promise<string>` ;
    - `signOutRemote(sessionToken): Promise<void>`, qui ignore les erreurs réseau.
    - En cas d'erreur, ces fonctions lèvent `AuthError(code: "invalid_email" | "rate_limited" | "invalid_otp" | "session_expired" | "network")`.
  - `jwt-provider.ts` : `createJwtProvider({ getSessionToken, fetchJwt, now = Date.now }) -> { get(): Promise<string>; invalidate(): void }`.
    - Renouvelle le JWT si son `exp` (lu dans le payload base64url) est à moins de 60 s.
    - Des appels simultanés partagent **une seule** requête en cours.
    - Sans jeton de session, lève `AuthError("session_expired")`.
  - `api-client.ts` : `createApiClient({ jwt, fetch, onUnauthenticated }) -> { getMe(): Promise<Me> }`.
    - Sur un 401 : `jwt.invalidate()` puis **une** seule nouvelle tentative.
    - Si la deuxième réponse est encore 401, appel de `onUnauthenticated()` puis `AuthError("session_expired")`.
    - Les autres erreurs donnent `ApiRequestError(status, body: ApiErrorBody)`.
  - `messages.ts` :
    - `type BgRequest = { type: "auth/start"; email: string; locale: Locale } | { type: "auth/verify-otp"; email: string; otp: string } | { type: "auth/state" } | { type: "auth/sign-out" }` ;
    - `type BgResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string } }` ;
    - `type AuthState = { status: "signedOut" } | { status: "signedIn"; me: Me }` ;
    - `sendToBackground<T>(req: BgRequest): Promise<BgResponse<T>>`.
  - `background-handlers.ts` :
    - `createHandlers(deps) -> (req: BgRequest) => Promise<BgResponse<unknown>>`. `auth/verify-otp` enregistre le jeton. `auth/state` renvoie un `AuthState` (via `getMe`). `auth/sign-out` appelle `signOutRemote`, puis efface le jeton et invalide le JWT ;
    - `handleExternal(message, sender, deps) -> Promise<{ ok: boolean }>`. Accepte **uniquement** si `new URL(sender.url).origin === new URL(PUBLIC_URL).origin` et si le message est `{ type: "radarnaque/session", token: string non vide }`. Dans ce cas, enregistre le jeton.
  - `entrypoints/background.ts` branche `browser.runtime.onMessage` et `onMessageExternal` sur ces fonctions.

- [ ] **Étape 1 : écrire les tests qui échouent.** Configuration : Vitest avec `WxtVitest()` et `fakeBrowser.reset()` dans `beforeEach` ; `fetch` simulé avec `vi.fn`.
  ```ts
  test("normalizeEmail trims and lowercases", ...)                // " A@B.BE " → "a@b.be"
  test("verifyOtp returns set-auth-token header; 4xx → AuthError invalid_otp", ...)
  test("startSignIn maps 429 → rate_limited, 400 → invalid_email", ...)
  test("jwt provider caches until 60s before exp and dedupes concurrent refresh", ...)
  test("api client retries once after 401 then calls onUnauthenticated", ...)
  test("handlers: verify-otp stores token; state returns signedIn with me; sign-out clears token", ...)
  test("handlers: state without token → signedOut, no network call", ...)
  test("external message from PUBLIC_URL stores token", ...)
  test("external message from other origin or malformed payload is refused", ...)
  ```
- [ ] **Étape 2 : lancer `pnpm --filter extension test`.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter** les fichiers de `lib/` et `entrypoints/background.ts`. Dépendances : `wxt@0.21`, `@wxt-dev/module-react`, `react@19`, `react-dom@19`, `@radarnaque/shared` (workspace). En dev : `vitest`, `happy-dom`, `@testing-library/react`, `typescript@~6.0`.
- [ ] **Étape 4 : relancer les tests, puis `pnpm --filter extension build`.** Résultat attendu : les tests passent et `.output/chrome-mv3/manifest.json` contient `key`, `externally_connectable` et la permission `storage`.
- [ ] **Étape 5 : commit.** Message : `feat(extension): service worker, session, JWT et client API`.

---

### Tâche 11 : popup de connexion et de compte

**Fichiers :**
- Créer : `apps/extension/lib/i18n.ts`, `entrypoints/popup/{index.html,main.tsx,App.tsx,style.css}` et `test/popup.test.tsx`
- Modifier : `apps/extension/package.json` (Tailwind 4 + `@tailwindcss/vite`), `wxt.config.ts` (plugin Vite Tailwind)

**Interfaces :**
- Consomme : `sendToBackground`, `AuthState`, `sessionToken` et `localePref` (tâche 10).
- Produit :
  - `i18n.ts` : `detectLocale(uiLanguage: string): Locale` et `t(locale, key)`. Toutes les clés existent en FR et en NL. Un test vérifie que les deux dictionnaires ont exactement les mêmes clés.
  - `App` affiche quatre états :
    1. `loading` ;
    2. `signedOut` : champ email + « Recevoir mon lien de connexion » ;
    3. `codeSent` : « Vérifiez votre boîte mail : cliquez sur le lien ou saisissez le code », un champ de 6 chiffres (`inputMode="numeric"`, envoi automatique au 6ᵉ chiffre), « Renvoyer l'email » et « Changer d'adresse » ;
    4. `signedIn` : email, nom du plan, scans restants par type (et plafond d'essai), « Se déconnecter ».
  - La popup surveille `sessionToken.watch`. Quand la page de retour enregistre le jeton, la popup passe d'elle-même à `signedIn`.
  - Les codes d'erreur s'affichent sous forme de messages traduits (`invalid_email`, `rate_limited`, `invalid_otp`, `network`).
  - Un sélecteur FR/NL enregistre `localePref`.

- [ ] **Étape 1 : écrire les tests qui échouent** (Testing Library, avec `sendToBackground` simulé par `vi.mock`).
  ```tsx
  test("signed out → submit email sends auth/start with normalized email and shows code step", ...)
  test("6th digit auto-submits auth/verify-otp; success shows plan and remaining scans", ...)
    // me = trial, quotas text 3 / image 3, totalCap remaining 3 → affiche "3"
  test("invalid_otp shows translated error and keeps code step", ...)
  test("token written by callback (storage change) switches to signed in without user action", ...)
  test("sign out returns to email step", ...)
  test("NL locale renders Dutch labels", ...)
  test("fr and nl dictionaries have identical keys", ...)
  ```
- [ ] **Étape 2 : lancer `pnpm --filter extension test`.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter.** Style : popup de 360 px de large, sobre, avec le logo Radarnaque. Reprendre `icon-with-shadow.svg` et `icon/*.png` de `../radarnaque-v2/public` et les copier dans `apps/extension/public/`.
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : ils passent.
- [ ] **Étape 5 : commit.** Message : `feat(extension): popup de connexion et de compte`.

---

### Tâche 12 : stack de développement et test de connexion de bout en bout

**Fichiers :**
- Créer : `infra/Caddyfile.dev` et `scripts/e2e-login.ts`
- Modifier : `infra/docker-compose.dev.yml` (service `caddy`), le `package.json` racine (scripts) et `README.md`

**Interfaces :**
- Produit :
  - **Caddy de dev** sur `:8080` : `/auth/*` → `host.docker.internal:3000`, `/api/*` → `host.docker.internal:8000`, tout le reste → `file_server` sur `apps/site/dist` (monté en lecture seule). `extra_hosts: ["host.docker.internal:host-gateway"]`.
  - **Scripts racine :**
    - `dev:auth` : `NODE_ENV=development AUTH_MIGRATE_ON_START=1 tsx watch src/server.ts` ;
    - `dev:api` : `alembic upgrade head && uvicorn --reload --port 8000 --factory radarnaque_api.main:create_app` ;
    - `dev:site` : `vite build --watch` ;
    - `dev:ext` : `wxt` ;
    - `e2e:login` : `tsx scripts/e2e-login.ts`.
    Les migrations Better Auth passent **avant** Alembic, car `app` a des clés étrangères vers `auth."user"`. Le README l'indique.
  - **`scripts/e2e-login.ts`**, à lancer contre la stack de dev :
    1. `POST /auth/start` (Origin = `chrome-extension://<EXTENSION_ID>`) ;
    2. `GET /auth/dev/last-email` → `otp` ;
    3. `POST /auth/sign-in/email-otp` → `set-auth-token` ;
    4. `GET /auth/token` → JWT ;
    5. `GET /api/me` → vérifie `plan === "trial"` et `totalCap.remaining === 3`.
    Le script affiche `E2E LOGIN OK` et sort avec le code 0 ; toute autre issue sort avec le code 1.

- [ ] **Étape 1 : écrire les fichiers.** Dans `README.md`, la section « Démarrer en dev » décrit : `.env` à partir de `.env.example`, `pnpm db:up`, `docker compose … up -d caddy`, `pnpm dev:auth`, `pnpm dev:api`, `pnpm dev:site`, `pnpm dev:ext`, la génération de la clé (`openssl genrsa -out infra/extension-dev.pem 2048` puis `node apps/extension/scripts/extension-id.mjs`) et le chargement de l'extension non empaquetée.
- [ ] **Étape 2 : lancer la stack, puis `pnpm e2e:login`.** Résultat attendu : `E2E LOGIN OK`.
- [ ] **Étape 3 : vérification manuelle dans Chrome.**
  - Popup → email → code lu dans les logs de `dev:auth` → affichage « Essai · 3 scans restants ».
  - Déconnexion. Nouvelle demande, et cette fois clic sur le lien des logs dans le même Chrome → « Connecté ✓ ». La popup s'ouvre directement connectée.
  - Résultat attendu : les deux parcours fonctionnent.
- [ ] **Étape 4 : commit.** Message : `chore(dev): stack de dev Caddy et test e2e de connexion`.

---

### Tâche 13 : déploiement de production

**Fichiers :**
- Créer : `services/api/Dockerfile`, `services/auth/Dockerfile`, `infra/docker-compose.yml`, `infra/Caddyfile` et `infra/backup/backup.sh`
- Modifier : `README.md` (section « Déployer »)

**Interfaces :**
- Produit :
  - **Images :**
    - `api` : `python:3.13-slim` + uv, `uv sync --frozen --no-dev`, utilisateur non-root, `uvicorn --factory radarnaque_api.main:create_app --host 0.0.0.0 --port 8000 --proxy-headers` ;
    - `auth` : `node:24-slim`, `pnpm deploy --filter auth --prod`, utilisateur non-root, `node --import tsx src/server.ts`.
  - **`docker-compose.yml`** :
    - `postgres:17` avec un volume et le script `init/01-schemas.sql` ;
    - `migrate` (image auth puis image api, `restart: "no"`) : `node --import tsx src/migrate.ts`, puis `alembic upgrade head`. `auth` et `api` en dépendent (`depends_on: condition: service_completed_successfully`) ;
    - `auth`, `api` ;
    - `caddy` (ports 80 et 443, site `radarnaque.mostconsult.be`, mêmes routes qu'en dev, `apps/site/dist` copié dans l'image ou monté) ;
    - `backup`.
    Le JWKS est lu en interne : `JWKS_URL=http://auth:3000/auth/jwks`. Seul Caddy expose des ports.
  - **`backup.sh`** : toutes les 24 h, `pg_dump | gzip | age -r $BACKUP_AGE_RECIPIENT > /backups/radarnaque-<date>.sql.gz.age`, puis `rclone copy` vers `$BACKUP_RCLONE_REMOTE` et suppression des fichiers locaux de plus de 14 jours. Les variables sont documentées dans `.env.example`.

- [ ] **Étape 1 : écrire les fichiers.**
- [ ] **Étape 2 : lancer `docker compose -f infra/docker-compose.yml --env-file infra/.env.example config -q && docker compose -f infra/docker-compose.yml build`.** Résultat attendu : code de sortie 0.
- [ ] **Étape 3 : lancer la composition de production en local**, avec `PUBLIC_URL=http://localhost` et un Caddy servi en `http://localhost` (variable `SITE_ADDRESS`). Exécuter ensuite `pnpm e2e:login` avec `NODE_ENV=development` sur le service `auth` uniquement pour ce test. Résultat attendu : `E2E LOGIN OK`. Remettre `NODE_ENV=production`, puis vérifier que `curl localhost/auth/dev/last-email?to=x` renvoie 404.
- [ ] **Étape 4 : commit.** Message : `chore(infra): composition de production, images et sauvegardes`.

---

## Couverture de la spec pour la phase 1

| Exigence de la spec | Tâche |
|---|---|
| §3.2 monorepo | 1, 6 |
| §5.1 Better Auth (plugins, `basePath`, Resend, `trustedOrigins`, hook) | 7, 8 |
| §5.2 flux lien + OTP, page de retour, JWT renouvelé, 401 → un renouvellement | 8, 9, 10, 11 |
| §5.3 JWKS, rôle et plan relus en base | 4, 5 |
| §6 schéma 3NF (tables de la phase 1) | 3 |
| §2.1–2.2 offre et essai (3 scans, plafond commun) | 3, 5 |
| §7.1 `/api/me`, `/api/internal/.../bootstrap` | 5 |
| §7.5 format des erreurs | 2 |
| §3.1-4 contrat OpenAPI → TS | 6 |
| §4.1 WXT, `key`, permissions minimales | 10 |
| §4.7 FR/NL | 7, 9, 11 |
| §11 docker-compose, Caddy, migrate, sauvegardes, `.env.example` | 1, 12, 13 |
| §12 tests (Postgres réel, JWT invalide ou expiré, contrat, authentification de bout en bout) | 2–12 |

Hors phase 1 (prévu dans les phases suivantes) :
- adaptateurs et règles (phase 2) ;
- `/api/scans`, cache, LLM, `settings`, `scan_results`, `prompt_versions` (phase 3) ;
- admin, `admin_actions`, vues SQL, `DELETE /api/me`, purge à 12 mois (phase 4) ;
- routes `/api/billing/*` (phase 3 pour la réponse 501, phase 5 pour Stripe) ;
- pages `/pricing` et `/privacy` (phase 3).
