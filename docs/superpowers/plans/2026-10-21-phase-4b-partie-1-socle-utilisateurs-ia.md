# Phase 4b, partie 1 — Admin : socle, Utilisateurs et IA : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** un admin se connecte sur `/admin/`, gère les comptes (plan, rôle, suppression) et pilote l'IA (modèles, prompts, réglages, essais), chaque modification étant tracée dans `admin_actions` ; la table `llm_calls` commence à se remplir pour le tableau de bord de la partie 2.

**Architecture :**
- **Base :** migration 0007 avec `admin_actions` et `llm_calls` (reprise des analyses existantes). `save_analysis` écrit une ligne `llm_calls` par appel ; la purge quotidienne supprime aussi ces deux tables à 12 mois et écrit `system.purge`.
- **Auth :** `/auth/admin/*` fermé, `target` (`extension` ou `admin`) dans `/auth/start`, email adapté, commandes `admin:grant` et `admin:revoke`.
- **API :** dépendance `require_admin`, routeur `/api/admin/users` et `/api/admin/ai`, journal `admin_actions` écrit dans la transaction de chaque modification, essais du modèle et de la recherche limités par admin.
- **Admin :** nouvelle SPA `apps/admin` (Vite, React, Tailwind), servie par Caddy sous `/admin/` en production comme en dev (build en continu, pas de serveur Vite).

**Tech Stack :** FastAPI, SQLAlchemy async, Alembic, Hono et Better Auth 1.7.10, Vite 8, React 19, Tailwind 4, Vitest et Testing Library, Caddy 2.

**Spec :**
- `docs/superpowers/specs/2026-10-21-phase-4b-admin-socle-design.md` ;
- `docs/superpowers/specs/2026-10-21-phase-4b-admin-utilisateurs-design.md` ;
- `docs/superpowers/specs/2026-10-21-phase-4b-admin-ia-design.md`.

La spécification principale `docs/superpowers/specs/2026-10-16-radarnaque-v4-design.md` s'applique pour le reste. Les écrans Tableau de bord, Offre et Analyses sont la partie 2 (hors de ce plan).

## Global Constraints

**Git et fichiers locaux :**
- Branche `feat/phase-4b`, au-dessus de `main`. Pas de push.
- Le trailer de commit est celui que donnent les instructions de session pour le modèle.
- Ne jamais toucher : `video/`, `.DS_Store`, `services/api/tests/.conftest.py.swp`, `docs/superpowers/plans/.Rhistory`.
- `web-pages/` n'est jamais lu ; `infra/.env` n'est jamais affiché.
- Aucun email réel, aucune clé, aucun jeton. Emails de test en `@radarnaque.test`.

**Langue :** le code, les commentaires, les messages, l'interface de l'admin et les docs sont en français, dans le style des fichiers voisins. L'admin n'a pas de NL.

**Valeurs fixées par le spec :**

| Élément | Valeur |
|---|---|
| Migration | `0007_admin_actions_llm_calls.py`, `revision = "0007"`, `down_revision = "0006"` |
| `admin_actions` | `id BIGINT identity PK`, `admin_user_id TEXT NULL FK→auth."user"(id) ON DELETE SET NULL`, `action TEXT NOT NULL`, `target_user_id TEXT NULL` (sans FK), `details JSONB NOT NULL DEFAULT '{}'`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` ; index `(created_at DESC)` et `(target_user_id)` |
| `llm_calls` | `id BIGINT identity PK`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `analysis_id BIGINT NOT NULL FK→analyses`, `model_id INT NOT NULL FK→models`, `prompt_version_id INT NOT NULL FK→prompt_versions`, `tokens_in`, `tokens_out`, `images_analyzed`, `web_searches` `INT NOT NULL DEFAULT 0`, `cost_usd_micros BIGINT NOT NULL DEFAULT 0` ; index `(created_at)` et `(analysis_id)` |
| Codes d'action | `user.plan_set`, `user.role_set`, `user.deleted`, `ai.model_added`, `ai.model_activated`, `ai.prompt_created`, `ai.prompt_activated`, `ai.settings_set`, `system.purge` (et ceux de l'offre, partie 2) |
| `details` | `{ from, to }` ; jamais d'email, jamais le texte d'un prompt |
| Rétention | 12 mois pour `admin_actions` et `llm_calls` (`retention_cutoff`) |
| Accès | `auth.user.role = 'admin'` ; superuser accepté seulement hors production |
| Erreurs | `401 unauthenticated`, `403 admin_required`, `404 not_found`, `409 conflict`, `422 invalid_value` (contrôle métier), `422 invalid_request` (validation Pydantic, existant), `429 rate_limited` |
| Pagination | curseur `before`, `limit` de 1 à 50 (50 par défaut) |
| Recherche d'utilisateur | `q` de 3 caractères au moins, sous-chaîne, casse ignorée |
| `target` de `/auth/start` | `extension` (défaut) → `callbackURL: "/auth/callback"` ; `admin` → `callbackURL: "/admin/"`, locale forcée à `fr` ; autre → `400 invalid_target` |
| Slug de modèle | 1 à 200 caractères, aucun espace (`^\S{1,200}$`) |
| Prompt | 200 à 20 000 caractères |
| Réglages | `cache_ttl_hours` 1–168, `rate_limit_per_minute` 1–600, `max_web_searches` 0–5 |
| Essai du modèle | 10 par heure et par admin |
| Essai de recherche | 30 par heure et par admin ; requête de 1 à 200 caractères |
| Disponibilité du moteur | `GET {SEARXNG_URL}/healthz`, délai 3 s, résultat gardé 60 s ; états `ok`, `down`, `disabled` |
| Journal | logger `radarnaque.admin`, une ligne `INFO` par modification : `action admin : <code>`, sans email ni identifiant |
| uvicorn | `--no-access-log` (Dockerfile et `dev:api`) |
| Caddy `/admin/*` | `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` sauf `/admin/assets/*` |

**Commandes :**
- API : `cd services/api && uv run pytest -q && uv run ruff check . && uv run ruff format --check .` ;
- contrat : `pnpm check:api`, régénéré par `pnpm gen:api` ;
- auth : `pnpm --filter auth test && pnpm --filter auth typecheck` ;
- admin : `pnpm --filter admin test && pnpm --filter admin typecheck && pnpm --filter admin build` ;
- racine : `pnpm lint`, puis `pnpm test:all` à la fin.

## Review Focus

1. **Une recherche d'email avec `%` ou `_`** (`q=a_b`) les traite comme des caractères, pas comme des jokers : `a_b` ne trouve pas `axb@…`. Test en tâche 5.
2. **Attribuer un plan à un compte sans abonnement actif** (essai expiré, ou aucun abonnement) crée l'abonnement actif sans erreur, et le journal note `from: null`. Test en tâche 5.
3. **Un admin rétrogradé ou supprimé pendant que son onglet est ouvert** reçoit `403 admin_required` à la requête suivante : l'interface affiche « Accès réservé aux administrateurs », sans boucle de nouvelles tentatives. Test en tâche 9.
4. **Activer un modèle dont le fournisseur n'est plus dans `providers.toml`**, ou une version de prompt d'un autre type (`text`, `image`), est refusé (`422 invalid_value`) sans rien changer. Test en tâche 6.
5. **Deux créations de prompt simultanées** donnent deux numéros distincts qui se suivent, jamais une erreur 500. Test en tâche 6.

---

### Tâche 1 : migration 0007, `admin_actions` et `llm_calls`

**Fichiers :**
- Créer :
  - `services/api/alembic/versions/0007_admin_actions_llm_calls.py`
  - `services/api/src/radarnaque_api/models/admin.py` (`AdminAction`)
  - `services/api/tests/test_migration_0007.py`
  - `services/api/tests/test_llm_calls.py`
- Modifier :
  - `services/api/src/radarnaque_api/models/analyses.py` (`LlmCall`) et `models/__init__.py` ;
  - `services/api/src/radarnaque_api/services/scan_store.py` (`save_analysis` insère la ligne `llm_calls`) ;
  - `services/api/tests/conftest.py` (`truncate` : ajouter `app.admin_actions, app.llm_calls`).

**Interfaces :**
- Fournit : les modèles `AdminAction` (`app.admin_actions`) et `LlmCall` (`app.llm_calls`), colonnes du tableau des valeurs.
- `save_analysis` garde sa signature ; elle ajoute `LlmCall(created_at=at, analysis_id=…, model_id=key.model_id, prompt_version_id=key.prompt_version_id, tokens_in=result.tokens_in, tokens_out=result.tokens_out, cost_usd_micros=result.cost_usd_micros, images_analyzed=images_analyzed, web_searches=len(result.searches))`.
- **Reprise dans `upgrade()` :** `insert into app.llm_calls(created_at, analysis_id, model_id, prompt_version_id, tokens_in, tokens_out, cost_usd_micros, images_analyzed, web_searches) select a.created_at, a.id, a.model_id, a.prompt_version_id, a.tokens_in, a.tokens_out, a.cost_usd_micros, a.images_analyzed, (select count(*) from app.analysis_web_searches w where w.analysis_id = a.id) from app.analyses a`.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `test_migration_0007_tables` : les deux tables et leurs index existent ; `admin_actions.admin_user_id` est `ON DELETE SET NULL` ; `target_user_id` n'a pas de clé étrangère.
  - `test_migration_0007_backfill_and_downgrade` : deux analyses insérées, `downgrade` vers `0006` puis `upgrade head` : 2 lignes `llm_calls` avec leur date, coût, tokens et nombre de recherches ; la descente supprime les tables.
  - `test_admin_deleted_keeps_action` : une ligne `admin_actions` dont l'admin est supprimé garde son `target_user_id` et passe `admin_user_id` à `NULL`.
  - `test_llm_call_written_on_new_analysis` : un scan (faux LLM de `test_scans_routes.py`, 2 recherches) donne 1 ligne avec `web_searches == 2`, les tokens et le coût du `LLMResult`.
  - `test_llm_call_written_on_refresh` : même annonce, cache expiré (`cache_ttl_hours` à 1 et événement daté de 2 h plus tard) : 2 lignes `llm_calls` pour la même analyse, à deux dates.
  - `test_no_llm_call_on_cache_hit_or_failure` : un second scan servi par le cache et un scan dont le LLM échoue n'ajoutent aucune ligne.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter** la migration, les modèles et l'insertion dans `save_analysis`.
- [ ] **Étape 4 : vérifier.** Commandes de l'API. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): migration 0007, journal admin_actions et trace llm_calls par appel au modèle`.

### Tâche 2 : purge étendue et `system.purge`

**Fichiers :**
- Modifier :
  - `services/api/src/radarnaque_api/services/purge.py`
  - `services/api/src/radarnaque_api/purge_cli.py`
  - `services/api/tests/test_purge.py`

**Interfaces :**
- Utilise : `AdminAction`, `LlmCall` (tâche 1), `retention_cutoff`.
- Fournit :

```python
@dataclass(frozen=True)
class PurgeReport:
    scans: int
    admin_actions: int
    llm_calls: int

async def run_purge(engine: AsyncEngine, now: datetime) -> PurgeReport | None  # None : verrou pris ailleurs
```

- `purge_old_scans` perd le verrou et devient `_purge_scans(engine, cutoff) -> int` (même algorithme par lots). `run_purge` prend le verrou consultatif existant, appelle `_purge_scans`, supprime `admin_actions` puis `llm_calls` antérieurs à la limite (une transaction chacun), puis insère `AdminAction(admin_user_id=None, action="system.purge", details={"deletedScans": …, "deletedActions": …, "deletedLlmCalls": …})` dans une dernière transaction. Une exception avant cette insertion la saute.
- `purge_forever` et `purge_cli` appellent `run_purge` ; le CLI affiche `scan_events supprimés : N, admin_actions : N, llm_calls : N`.

- [ ] **Étape 1 : adapter et écrire les tests.**
  - Les tests existants passent de `purge_old_scans` à `run_purge` (`.scans` pour le nombre).
  - `test_purge_old_admin_actions_and_llm_calls` : des lignes à 13 mois partent, celles à 11 mois et 29 jours restent ; les analyses restent.
  - `test_purge_writes_system_purge` : une passe écrit une ligne `system.purge` avec les trois compteurs et `admin_user_id` à `NULL`, même quand tout vaut 0.
  - `test_skipped_purge_writes_nothing` : verrou tenu ailleurs → `None` et aucune ligne `system.purge`.
  - `test_failed_purge_writes_nothing` : la requête de suppression de `llm_calls` remplacée par une requête invalide (`monkeypatch` de sa constante) → exception, aucune ligne `system.purge`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier.** Commandes de l'API. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): purge à 12 mois du journal admin et de llm_calls, ligne system.purge par passe`.

### Tâche 3 : service auth, accès admin

**Fichiers :**
- Créer :
  - `services/auth/src/admin-role.ts`
  - `services/auth/scripts/admin-role.ts`
  - `services/auth/test/admin-role.test.ts`
- Modifier :
  - `services/auth/src/app.ts` (`/auth/admin/*` en 404 ; `target` dans `/auth/start`) ;
  - `services/auth/src/sign-in.ts` (`startSignIn` reçoit `target`) ;
  - `services/auth/src/mail/templates.ts` (variante admin) ;
  - `services/auth/test/flows.test.ts`, `sign-in.test.ts`, `templates.test.ts` ;
  - `package.json` racine (`admin:grant`, `admin:revoke`).

**Interfaces :**
- Fournit :

```ts
export type SignInTarget = "extension" | "admin";
export function parseTarget(value: unknown): SignInTarget | null; // undefined → "extension"
// startSignIn(auth, mailer, { email, locale, headers, target })
// renderSignInEmail({ locale, url, otp, target })
export const ADMIN_EXIT = { ok: 0, notFound: 1, lastAdmin: 3, usage: 64 } as const;
export async function adminRoleCommand(
	args: string[], // ["grant" | "revoke", email]
	source: Record<string, string | undefined>,
	makePool: (databaseUrl: string) => Pool,
): Promise<number>;
```

- **`/auth/admin/*` :** `app.all("/auth/admin/*", …)` déclaré avant `app.all("/auth/*", …)`, renvoie `404 { error: { code: "not_found", … } }`. Les appels internes `auth.api.*` ne passent pas par là.
- **`target: "admin"` :** `signInMagicLink` reçoit `callbackURL: "/admin/"` et `errorCallbackURL: "/admin/?erreur=lien"` ; la locale est `fr` quelle que soit la valeur reçue.
- **Email admin (FR) :** la phrase d'introduction devient « Pour vous connecter à l'administration de Radarnaque, cliquez sur le lien ci-dessous ou saisissez le code dans la page d'administration. » ; le reste est inchangé.
- **`adminRoleCommand` :** même structure que `devSuperuserCommand` (normalisation de l'email, `DATABASE_URL` jamais affichée, email masqué par `maskEmail`), autorisée en production. `grant` met `role = 'admin'` (code 1 si aucun compte). `revoke` met `role = 'user'` ; il refuse le dernier admin (code 3), sous `SELECT … FOR UPDATE` des admins dans une transaction.
- **Scripts racine :**
  - `"admin:grant": "cd services/auth && tsx --env-file=../../infra/.env scripts/admin-role.ts grant"` ;
  - `"admin:revoke": "cd services/auth && tsx --env-file=../../infra/.env scripts/admin-role.ts revoke"` ;
  - en production : `docker compose exec auth node --import tsx scripts/admin-role.ts grant <email>` (à écrire dans le README en tâche 12).

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `auth admin routes return 404 even for an admin session` : `GET /auth/admin/list-users` et `POST /auth/admin/impersonate-user` avec le cookie d'un compte `admin` → 404.
  - `start with target admin links to /admin/` : le lien de l'email contient `callbackURL=%2Fadmin%2F` ; l'email contient « page d'administration » et pas « extension ».
  - `start without target keeps /auth/callback` ;
  - `start rejects an unknown target` → `400 invalid_target`, aucun email envoyé ;
  - `start with target admin ignores locale nl` (email en français) ;
  - `admin:grant promotes, admin:revoke demotes` ; `grant` d'un email inconnu → 1 ; `revoke` du dernier admin → 3 et le rôle reste ; usage invalide → 64 ; les logs ne contiennent ni l'email complet ni `DATABASE_URL`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier.** Commandes : `pnpm --filter auth test && pnpm --filter auth typecheck && pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(auth): routes /auth/admin/* fermées, connexion de l'admin (target), admin:grant et admin:revoke`.

### Tâche 4 : socle de l'API admin

**Fichiers :**
- Créer :
  - `services/api/src/radarnaque_api/admin_schemas.py`
  - `services/api/src/radarnaque_api/services/admin_log.py`
  - `services/api/src/radarnaque_api/services/rate_window.py`
  - `services/api/tests/test_admin_access.py`
  - `services/api/tests/test_access_log.py`
- Modifier :
  - `services/api/src/radarnaque_api/auth/deps.py` (`require_admin`) ;
  - `services/api/src/radarnaque_api/models/auth_user.py` (colonnes `created_at` ↔ `"createdAt"`, `email_verified` ↔ `"emailVerified"`, et `role` écrit par l'API : retirer « lecture seule » du docstring pour `role`) ;
  - `services/api/tests/conftest.py` (`SETUP_SQL` : `"createdAt"` et `"emailVerified"`, du même type que dans la base de dev, vérifié par `\d auth."user"`, avec des valeurs par défaut `now()` et `false`) ;
  - `services/api/Dockerfile` et `package.json` racine (`dev:api`) : `--no-access-log`.

**Interfaces :**
- Fournit :

```python
@dataclass(frozen=True)
class AdminContext:
    user: AuthUser
    privileges: Privileges

async def require_admin(request: Request, user: Annotated[AuthUser, Depends(current_user)]) -> AdminContext
# admin, ou superuser quand privileges.debug (hors production) ; sinon ApiError(403, "admin_required", …)

AdminActionCode = Literal["user.plan_set", "user.role_set", "user.deleted", "ai.model_added",
    "ai.model_activated", "ai.prompt_created", "ai.prompt_activated", "ai.settings_set"]

def record_action(session: AsyncSession, *, admin_id: str, action: AdminActionCode,
                  target_user_id: str | None = None, details: dict[str, Any] | None = None) -> None
# ajoute la ligne (sans commit) et journalise « action admin : <code> » sous radarnaque.admin

async def recent_actions(session: AsyncSession, *, prefix: str | None = None,
                         target_user_id: str | None = None, limit: int = 20) -> list[AdminActionOut]
# du plus récent au plus ancien ; exclut toujours system.purge

class SlidingWindowLimiter:
    def __init__(self, max_hits: int, window_s: float, now: Callable[[], float] = time.monotonic) -> None
    def hit(self, key: str) -> bool  # False quand la limite est atteinte (le coup n'est pas compté)
```

- `AdminActionOut` (dans `admin_schemas.py`, `CamelModel`) : `id: int`, `action: str`, `admin_user_id: str | None`, `admin_email: str | None` (jointure sur `auth.user`, pour l'affichage), `target_user_id: str | None`, `details: dict[str, Any]`, `created_at: datetime`.
- Les limiteurs sont créés dans `create_app` : `app.state.model_test_limiter = SlidingWindowLimiter(10, 3600)` et `app.state.search_test_limiter = SlidingWindowLimiter(30, 3600)` ; ils sont propres au processus (à noter dans le suivi).

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `test_require_admin` (via une route de test montée sur l'app) : sans JWT 401 ; rôle `user` 403 `admin_required` ; `admin` 200 ; `superuser` 200 en test et 403 avec la fixture `production`.
  - `test_record_action_is_transactional` : `record_action` puis `rollback` → aucune ligne ; après `commit`, une ligne et un log `action admin : ai.settings_set` sans email ni identifiant (`caplog`).
  - `test_recent_actions_filters` : par préfixe `ai.`, par compte visé ; `system.purge` jamais rendu ; 20 au plus.
  - `test_sliding_window` : 10 coups acceptés, le 11e refusé, accepté de nouveau après la fenêtre (horloge injectée) ; clés indépendantes.
  - `test_no_access_log` : `services/api/Dockerfile` et le script `dev:api` du `package.json` racine contiennent `--no-access-log`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier.** Commandes de l'API. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): socle de l'admin (require_admin, journal admin_actions, limiteur), sans journal d'accès`.

### Tâche 5 : API Utilisateurs

**Fichiers :**
- Créer :
  - `services/api/src/radarnaque_api/services/admin_users.py`
  - `services/api/src/radarnaque_api/routes/admin_users.py`
  - `services/api/tests/test_admin_users.py`
- Modifier : `admin_schemas.py`, `main.py` (routeur), `packages/shared/openapi.json` et `src/api.ts` (régénérés).

**Interfaces :**
- Utilise : `require_admin`, `record_action`, `recent_actions` (tâche 4) ; `compute_usage`, `get_active_subscription`, `scan_history`, `delete_account`.
- Fournit les routes du spec Utilisateurs §5, avec ces schémas :
  - `AdminUserRowOut` : `id`, `email`, `role`, `plan: str | None`, `used: int | None`, `remaining: int | None` (quota `full`, `None` sans abonnement actif), `created_at`, `last_scan_at: datetime | None` ; `AdminUserListOut` : `items`, `next_before: str | None` ;
  - `AdminSubscriptionOut` : `id`, `plan`, `status`, `provider`, `period_start`, `period_end` ;
  - `AdminUsageOut` : `period_start`, `quotas: list[QuotaOut]`, `total_cap: QuotaOut | None`, `purged_scans: int` ;
  - `AdminUserOut` : `id`, `email`, `email_verified`, `created_at`, `role`, `subscription: AdminSubscriptionOut | None`, `usage: AdminUsageOut | None`, `subscriptions: list[AdminSubscriptionOut]`, `scans: list[ScanHistoryItemOut]` (20 derniers), `actions: list[AdminActionOut]` ;
  - entrées : `AdminPlanIn { plan: str }`, `AdminRoleIn { role: Literal["admin", "user"] }` (`CamelInModel`).
- **Règles :**
  - liste : `q` échappé (`\`, `%`, `_`) puis `ILIKE '%q%' ESCAPE '\'` ; filtres `role` (`user`, `admin`, `superuser`) et `plan` (code ou `none`) ; tri `("createdAt" desc, id desc)` ; `before` = identifiant du dernier compte de la page précédente ;
  - `POST …/plan` : compte absent 404 ; plan absent de `app.plans` 422 `invalid_value` ; abonnement actif `stripe` 409 `conflict` ; sinon l'actif passe `expired` avec `period_end = now`, un nouvel abonnement `active`, `manual`, `period_start = now` est créé, `details = { from: <plan ou null>, to }`. Le même plan est accepté (nouvelle période). Réponse : la fiche.
  - `POST …/role` : soi-même 409 ; rôle inchangé → 200 sans ligne de journal ; retrait d'un admin : `select id from auth."user" where role = 'admin' for update`, et 409 s'il n'en reste qu'un. Réponse : la fiche.
  - `DELETE /api/admin/users/{id}` : soi-même 409 ; absent 404 ; `record_action(user.deleted, target_user_id=id)` puis `delete_account`, un seul commit ; 204.

- [ ] **Étape 1 : écrire les tests qui échouent** (les tests du spec Utilisateurs §7, plus) :
  - `test_search_escapes_wildcards` (point 1 de Review Focus) ;
  - `test_search_under_3_chars_is_422` ; `test_list_filters_and_pagination` (55 comptes, deux pages, filtres `role=admin` et `plan=none`) ;
  - `test_card_usage_matches_api_me` (un essai avec `purged_scans = 2`) ;
  - `test_assign_plan_ends_previous_and_resets_month` ; `test_assign_plan_without_active_subscription` (point 2) ; `test_assign_plan_stripe_is_409` ; `test_assign_unknown_plan_is_422` ;
  - `test_role_grant_and_revoke` ; `test_role_self_is_409` ; `test_last_admin_is_409` ; `test_two_admins_revoking_each_other_leave_one` (deux requêtes lancées par `asyncio.gather`) ; `test_role_superuser_is_422` ;
  - `test_delete_cascades_and_keeps_trace` (lignes de 4a absentes, `admin_actions.target_user_id` garde l'identifiant) ; `test_delete_self_is_409` ;
  - `test_failed_action_leaves_no_trace` (erreur provoquée après `record_action`, par exemple un `delete_account` remplacé par une fonction qui lève : ni changement ni ligne) ;
  - `test_users_routes_need_admin` (403 pour un `user` sur chaque route).
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter,** puis `pnpm gen:api`.
- [ ] **Étape 4 : vérifier.** Commandes de l'API et `pnpm check:api`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): admin, utilisateurs (recherche, fiche, plan, rôle, suppression)`.

### Tâche 6 : API IA, modèles, prompts et réglages

**Fichiers :**
- Créer :
  - `services/api/src/radarnaque_api/services/admin_ai.py`
  - `services/api/src/radarnaque_api/routes/admin_ai.py`
  - `services/api/tests/test_admin_ai.py`
- Modifier : `admin_schemas.py`, `main.py`, contrat régénéré.

**Interfaces :**
- Utilise : `require_admin`, `record_action`, `recent_actions` ; `app.state.providers` (`ProviderConfig`) ; `os.environ` pour l'état des clés.
- Fournit :
  - `ProviderOut` : `code`, `api`, `structured_output`, `reasoning_effort: str | None` (`None` quand il vaut `"none"`), `max_images: int | None`, `key: Literal["present", "absent", "not_required"]` ;
  - `ModelOut` : `id`, `provider`, `slug`, `analyses: int`, `active: bool`, `known_provider: bool` ;
  - `PromptVersionOut` : `id`, `version`, `created_at`, `active`, `analyses: int` ; `PromptTextOut` : les mêmes champs et `system_prompt` ;
  - `AiSettingsOut` / `AiSettingsIn` : `cache_ttl_hours` (1–168), `rate_limit_per_minute` (1–600), `max_web_searches` (0–5), tous optionnels à l'entrée ;
  - `SearchStatusOut` : `backend: Literal["searxng", "none"]`, `url: str | None` (sans partie `user:pass@`), `status: Literal["ok", "down", "disabled"]`, `cache_entries: int | None` (rempli en tâche 7 ; `None` d'ici là) ;
  - `AiOverviewOut` : `providers`, `models`, `active_model_id`, `prompts`, `active_prompt_version_id`, `settings`, `search`, `actions` (20 dernières `ai.*`) ;
  - routes : `GET /api/admin/ai`, `POST /api/admin/ai/models`, `POST /api/admin/ai/active-model`, `GET /api/admin/ai/prompts/{id}`, `POST /api/admin/ai/prompts`, `POST /api/admin/ai/prompts/{id}/activate`, `PATCH /api/admin/ai/settings` (spec IA §6 ; les deux essais sont en tâche 7). Les modifications répondent par `AiOverviewOut` à jour, sauf la création d'un prompt ;
  - entrées : `ModelIn { provider: str, slug: constr(pattern=r"^\S{1,200}$") }`, `ActiveModelIn { model_id: int }`, `PromptIn { system_prompt: constr(min_length=200, max_length=20_000) }`.
- **Règles :**
  - ajout : fournisseur absent de `providers` 422 `invalid_value` ; doublon 409 ; `details = { provider, slug }` ;
  - activation d'un modèle : absent 404 ; fournisseur inconnu 422 `invalid_value` (point 4) ; `details = { from: <id>, to: <id> }` ;
  - création d'un prompt : `select … from app.scan_kinds where code = 'full' for update`, numéro = max + 1, non actif ; `details = { version }` ; 201 avec `PromptTextOut` ;
  - activation d'un prompt : absent 404 ; `scan_kind != 'full'` 422 `invalid_value` ; `details = { from: <version>, to: <version> }` ;
  - réglages : une ligne `ai.settings_set` par champ réellement changé, `details = { field, from, to }` (`field` en snake_case de la colonne) ; corps vide ou sans changement → 200 sans ligne.

- [ ] **Étape 1 : écrire les tests qui échouent** (tests du spec IA §7 hors essais, plus) :
  - `test_overview_shape` : fournisseurs de `providers.toml` ; `stub` a `key == "not_required"` ; `openrouter` a `"absent"` sans `OPENROUTER_API_KEY` et `"present"` avec (monkeypatch), et la valeur n'apparaît nulle part dans le JSON ;
  - `test_add_model` (422 fournisseur inconnu, 409 doublon, slug avec espace 422, journal) ;
  - `test_activate_model_next_scan_uses_it` (faux LLM : le scan suivant reçoit le nouveau slug ; le cache de l'ancien modèle n'est pas servi) ;
  - `test_activate_model_with_unknown_provider_is_422` (point 4 : modèle inséré directement avec `provider = 'disparu'`) ;
  - `test_create_prompt_numbers_and_inactive` ; `test_concurrent_prompt_creation` (point 5, `asyncio.gather` de deux créations → deux numéros consécutifs) ; `test_prompt_bounds` (199 et 20 001 → 422) ; `test_prompt_journal_has_no_text` ;
  - `test_activate_prompt_of_other_kind_is_422` (point 4) ;
  - `test_no_route_modifies_a_prompt` (`PUT`, `PATCH` sur `/api/admin/ai/prompts/{id}` → 405) ;
  - `test_settings_bounds_journal_and_effect` (`max_web_searches = 0` : le scan suivant n'a pas d'outil ; deux champs changés → deux lignes).
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter,** puis `pnpm gen:api`.
- [ ] **Étape 4 : vérifier.** Commandes de l'API et `pnpm check:api`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): admin, IA (modèles, modèle actif, prompts, réglages)`.

### Tâche 7 : API IA, essais et état du moteur

**Fichiers :**
- Créer :
  - `services/api/src/radarnaque_api/services/ai_probes.py`
  - `services/api/tests/test_ai_probes.py`
- Modifier :
  - `services/api/src/radarnaque_api/search.py` (`fresh` et `cache_entries`) ;
  - `services/api/src/radarnaque_api/main.py` (`app.state.search_health`) ;
  - `routes/admin_ai.py`, `services/admin_ai.py` (`SearchStatusOut` complet), `admin_schemas.py`, contrat régénéré.

**Interfaces :**
- Utilise : `SlidingWindowLimiter` (tâche 4), `active_setup`, `build_messages`, `LLMError`, `ProviderError`, `format_hits`.
- Fournit :

```python
# search.py
class SearchBackend(Protocol):
    async def search(self, query: str, *, fresh: bool = False) -> list[SearchHit]: ...
# SearxngBackend.search(query, *, fresh=False) : fresh=True ne lit ni n'écrit le cache
# SearxngBackend.cache_entries -> int (propriété)

# ai_probes.py
PROBE_LISTING: ListingIn  # annonce fictive fixe : « Vélo de course aluminium, taille 56 », 250 €, sans photo
PROBE_RULES: RulesIn       # aucune règle locale déclenchée
class SearchHealth:
    def __init__(self, http: httpx.AsyncClient, base_url: str, *, now: Callable[[], float] = time.monotonic) -> None
    async def status(self) -> Literal["ok", "down"]  # GET {base_url}/healthz, 3 s ; mémorisé 60 s
async def probe_model(app_state: Any, model: Model, prompt: str) -> ModelTestOut
async def probe_search(search: SearchBackend | None, query: str) -> SearchTestOut
# préfixe « probe_ » : un nom en « test_ » importé dans un module de test serait collecté par pytest
```

- `ModelTestOut` : `ok: bool`, `score: int | None`, `duration_ms: int`, `tokens_in: int`, `tokens_out: int`, `raw: str`, `error: Literal["transport", "timeout", "invalid_response", "configuration"] | None`. Un `LLMError` ou un `ProviderError` (clé absente : `configuration`, sans appel réseau) donne `200` avec `ok: false` ; délai : `app_state.analysis_timeout_s`. Aucun outil, aucune photo, aucune écriture en base.
- `SearchTestOut` : `status: Literal["ok", "down", "disabled"]`, `count: int`, `text: str` (`format_hits`, déjà masqué par `clean_query` et `format_hits`).
- Routes : `POST /api/admin/ai/models/{id}/test` (limiteur, clé = identifiant de l'admin, refus `429 rate_limited`, modèle absent 404) et `POST /api/admin/ai/search-test { query }` (1 à 200 caractères ; même limiteur pour la recherche). Aucune n'écrit dans `admin_actions` ni ne journalise la requête.
- `app.state.search_health` : `None` quand `SEARCH_BACKEND=none`, sinon `SearchHealth(app.state.http_search, settings.searxng_url)`.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `test_model_test_calls_fake_llm_with_probe_listing` : le faux client reçoit le prompt actif, `tools is None`, aucun `image_url` ; la réponse a le score, les tokens et `raw` ; aucune ligne `scan_events`, `analyses` ni `llm_calls`.
  - `test_model_test_missing_key_is_configuration_without_network` : modèle `openrouter` sans clé, `respx` (ou faux transport) qui échoue s'il est appelé → `ok: false`, `error: "configuration"`.
  - `test_model_test_rate_limit` : 11e appel du même admin → 429 ; un autre admin passe encore.
  - `test_search_fresh_bypasses_cache` : avec un faux transport httpx comptant les appels, `search(q)` deux fois = 1 appel ; `search(q, fresh=True)` = 1 appel de plus et `cache_entries` inchangé.
  - `test_search_test_masks_contacts_and_limits` : requête contenant `0470 12 34 56` → aucune trace du numéro dans ce qui part ni dans `text` ; 31e appel → 429 ; moteur `none` → `status: "disabled"`, `count: 0`.
  - `test_search_health` : 200 → `ok` ; délai dépassé → `down` ; deuxième appel dans les 60 s sans requête ; `disabled` dans `GET /api/admin/ai` quand le moteur est `none`.
  - `test_probe_requests_not_logged` : `caplog` vide de la requête de recherche et de l'email de l'admin.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter,** puis `pnpm gen:api`.
- [ ] **Étape 4 : vérifier.** Commandes de l'API et `pnpm check:api`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): admin, essai du modèle, essai de recherche hors cache et état du moteur`.

### Tâche 8 : application `apps/admin`, Caddy et dev

**Fichiers :**
- Créer :
  - `apps/admin/package.json` (`name: "admin"` ; dépendances `@radarnaque/shared`, `react`, `react-dom` ; dev : `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `vite`, `vitest`, `happy-dom`, `@testing-library/react`, `@testing-library/user-event`, `@types/react`, `@types/react-dom`, `typescript`, aux versions déjà présentes dans `pnpm-lock.yaml`) ; scripts `build`, `test`, `typecheck` ;
  - `apps/admin/index.html`, `vite.config.ts` (`base: "/admin/"`), `vitest.config.ts`, `tsconfig.json` ;
  - `apps/admin/src/main.tsx`, `src/styles.css`, `src/App.tsx` (shell : barre latérale, en-tête, contenu), `src/router.ts`, `src/pages/NotFound.tsx` ;
  - `apps/admin/test/router.test.ts`.
- Modifier :
  - `infra/Caddyfile` et `infra/Caddyfile.dev` (bloc `/admin`) ;
  - `infra/caddy/Dockerfile` (construit l'admin, copie `dist` dans `/srv/admin`) ;
  - `services/auth/Dockerfile` (`COPY apps/admin/package.json apps/admin/package.json`, sinon le lockfile échoue) ;
  - `infra/docker-compose.dev.yml` (`../apps/admin/dist:/srv/admin:ro`) ;
  - `package.json` racine (`"dev:admin": "pnpm --filter admin exec vite build --watch"`, ajouté à `pnpm dev` sous le nom `admin`).

**Interfaces :**
- Fournit :

```ts
// src/router.ts
export type Route =
	| { name: "users" }
	| { name: "user"; id: string }
	| { name: "ai" }
	| { name: "notFound" };
export function parseRoute(pathname: string): Route; // "/admin/" et "/admin" → users
export function hrefOf(route: Route): string;
export function useRoute(): [Route, (route: Route) => void]; // history.pushState + popstate
```

- **Barre latérale (partie 1) :** « Utilisateurs » et « IA ». Les trois autres écrans arrivent avec la partie 2 : pas d'entrée morte.
- **Bloc Caddy** (identique en prod et en dev, avant le `handle` final) :

```
redir /admin /admin/ 308
handle /admin/* {
	header {
		Content-Security-Policy "default-src 'self'; frame-ancestors 'none'"
		X-Frame-Options DENY
		Referrer-Policy no-referrer
	}
	# Deux matchers exclusifs : Caddy trie les directives `header` par matcher, un
	# `Cache-Control` sans matcher écraserait celui des assets.
	@adminAssets path /admin/assets/*
	@adminPages not path /admin/assets/*
	header @adminAssets Cache-Control "public, max-age=31536000, immutable"
	header @adminPages Cache-Control no-store
	root * /srv
	try_files {path} /admin/index.html
	file_server
}
```

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `parseRoute` : `/admin/`, `/admin`, `/admin/utilisateurs`, `/admin/utilisateurs/abc`, `/admin/ia`, `/admin/inconnu` ; `hrefOf(parseRoute(x))` stable.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer (`pnpm install` d'abord : aucun paquet nouveau ne doit être téléchargé hors du lockfile, sinon le signaler).
- [ ] **Étape 3 : implémenter** l'application vide (shell et routeur), Caddy, Dockerfiles et scripts.
- [ ] **Étape 4 : vérifier.**
  - `pnpm --filter admin test && pnpm --filter admin typecheck && pnpm --filter admin build && pnpm lint` : PASS ;
  - `docker run --rm -v "$PWD/infra:/etc/caddy:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile` et de même pour `Caddyfile.dev` : `Valid configuration` ;
  - `docker compose -f infra/docker-compose.dev.yml up -d caddy`, puis `curl -sI http://localhost:8080/admin/x` : `200`, avec les trois en-têtes de sécurité et `Cache-Control: no-store` ; un fichier de `/admin/assets/` a `Cache-Control: public, max-age=31536000, immutable` ; `curl -s http://localhost:8080/admin/x` renvoie l'`index.html` de l'admin ; `curl -sI http://localhost:8080/admin` : `308` vers `/admin/` ;
  - `docker build -f infra/caddy/Dockerfile .` et `docker build -f services/auth/Dockerfile .` : succès.
- [ ] **Étape 5 : commiter.** Message : `feat(admin): application apps/admin servie par Caddy sous /admin (prod et dev)`.

### Tâche 9 : connexion de l'admin

**Fichiers :**
- Créer :
  - `apps/admin/src/auth.ts`, `src/api.ts`, `src/session.tsx` (contexte React de la session) ;
  - `apps/admin/src/pages/SignIn.tsx`, `src/pages/AccessDenied.tsx` ;
  - `apps/admin/test/api.test.ts`, `test/session.test.tsx`.
- Modifier : `src/App.tsx`.

**Interfaces :**
- Utilise : `Route` (tâche 8) ; types `components["schemas"][…]` de `@radarnaque/shared`.
- Fournit :

```ts
// src/auth.ts (fetch même origine, credentials "same-origin")
export async function startSignIn(email: string): Promise<void>; // POST /auth/start { email, locale: "fr", target: "admin" }
export async function verifyCode(email: string, otp: string): Promise<void>; // POST /auth/sign-in/email-otp
export async function fetchToken(): Promise<string | null>; // GET /auth/token ; null sur 401
export async function signOut(): Promise<void>; // POST /auth/sign-out {}

// src/api.ts
export class ApiFailure extends Error { status: number; code: string }
export interface AdminApi {
	get<T>(path: string): Promise<T>;
	send<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
}
export function createApi(deps: {
	fetchToken: () => Promise<string | null>;
	onSignedOut: () => void;
	onForbidden: () => void;
}): AdminApi;
// JWT en mémoire ; 401 → un nouveau JWT et une seule nouvelle tentative, puis onSignedOut ;
// 403 admin_required → onForbidden, sans nouvelle tentative ; 204 → undefined.

// src/session.tsx
export type SessionState =
	| { status: "loading" }
	| { status: "signedOut"; linkError: boolean }
	| { status: "denied"; email: string | null }
	| { status: "ready"; email: string; api: AdminApi };
export function SessionProvider(props: { children: React.ReactNode }): JSX.Element;
export function useSession(): SessionState & { signOut: () => Promise<void>; refresh: () => Promise<void> };
```

- **Démarrage :** `fetchToken()` ; sans session → `signedOut` (`linkError` vrai quand l'URL contient `?erreur=lien`, message « Lien expiré ou déjà utilisé. Demandez un nouveau code. ») ; sinon `GET /api/me` : rôle `admin` ou `superuser` → `ready`, sinon `denied`. Aucun appel `/api/admin/*` avant `ready`.
- **Écran de connexion :** champ email → « Recevoir un code » ; puis champ code à 6 chiffres et rappel « Vous pouvez aussi cliquer sur le lien reçu par email. » ; erreurs : `429` « Trop de demandes, réessayez plus tard. », code refusé « Code invalide ou expiré. ».
- **Accès refusé :** « Accès réservé aux administrateurs » et un bouton « Se déconnecter ».
- **En-tête :** email de l'admin et « Se déconnecter » (`signOut`, puis `signedOut`).

- [ ] **Étape 1 : écrire les tests qui échouent** (`fetch` remplacé par un faux) :
  - `api retries once with a new token after 401` ; `api signs out after a second 401` ;
  - `api calls onForbidden on 403 admin_required without retry` (point 3 de Review Focus) ;
  - `boot without session shows sign-in` ; `boot with ?erreur=lien shows the link message` ;
  - `sign-in by code` (start puis verify, puis `ready`) ;
  - `ordinary user sees access denied and no admin call` ;
  - `sign-out returns to sign-in` ;
  - `demoted admin mid-session sees access denied` (point 3 : `ready`, puis une requête admin reçoit 403 → écran refusé).
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter,** dans le style Tailwind de la popup de l'extension.
- [ ] **Étape 4 : vérifier.** Commandes de l'admin et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(admin): connexion par code ou lien, JWT en mémoire, accès refusé et déconnexion`.

### Tâche 10 : écran Utilisateurs

**Fichiers :**
- Créer :
  - `apps/admin/src/pages/Users.tsx` (liste), `src/pages/UserCard.tsx` (fiche et actions), `src/components/ConfirmDialog.tsx`, `src/components/ActionLog.tsx` ;
  - `apps/admin/test/users.test.tsx`.

**Interfaces :**
- Utilise : `useSession().api` (tâche 9), `useRoute` (tâche 8), schémas `AdminUserListOut`, `AdminUserOut` (tâche 5).
- Fournit :

```ts
export function ConfirmDialog(props: {
	title: string;
	message: string;
	confirmLabel: string;
	typedConfirmation?: string; // le bouton reste désactivé tant que la saisie n'est pas identique
	onConfirm: () => Promise<void>;
	onCancel: () => void;
}): JSX.Element; // un seul envoi même en double clic
export function ActionLog(props: { actions: AdminActionOut[] }): JSX.Element; // date, code lisible, admin, from → to
```

- **Liste :** champ de recherche (requête envoyée à partir de 3 caractères, 300 ms après la dernière frappe), filtres rôle et plan, colonnes du spec §2, « Page suivante » tant que `nextBefore` existe.
- **Fiche :** sections du spec §3. Actions :
  - « Attribuer un plan » (menu des trois plans ; confirmation « Plan actuel : X. Le nouveau plan commence maintenant. ») ; désactivé avec la mention « Géré dans Stripe » si l'abonnement actif est `stripe` ;
  - « Nommer admin » / « Retirer le rôle admin » ; absent sur sa propre fiche ;
  - « Supprimer le compte » : `typedConfirmation` = l'email du compte ; absent sur sa propre fiche ; après succès, retour à la liste.
- Les erreurs de l'API s'affichent en clair dans la fiche (`409` : « Impossible : c'est le dernier admin. » ou « Impossible sur votre propre compte. » selon le message renvoyé).

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `search waits for 3 characters` ; `filters and next page` ;
  - `card shows usage, subscriptions, scans and log` ;
  - `assign plan confirms then refreshes the card` ; `stripe subscription disables plan assignment` ;
  - `own card has no role or delete action` ;
  - `delete requires the exact email and sends once` ;
  - `409 last admin shows the message`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier.** Commandes de l'admin et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(admin): écran Utilisateurs (recherche, fiche, plan, rôle, suppression)`.

### Tâche 11 : écran IA

**Fichiers :**
- Créer :
  - `apps/admin/src/pages/Ai.tsx`, `src/pages/ai/Models.tsx`, `src/pages/ai/Prompts.tsx`, `src/pages/ai/Settings.tsx`, `src/pages/ai/Search.tsx` ;
  - `apps/admin/test/ai.test.tsx`.

**Interfaces :**
- Utilise : `ConfirmDialog`, `ActionLog` (tâche 10), `api`, schémas de la tâche 6 et 7.
- **Contenu :**
  - Fournisseurs (lecture seule, « — » pour une valeur absente ; « Clé présente », « Clé absente », « Pas de clé requise ») ;
  - Modèles : liste, ajout (fournisseur dans un menu, slug), « Activer » avec confirmation « Les analyses repartiront de zéro pour ce modèle (cache). », « Tester » avec le résultat (score, durée, tokens, réponse brute repliée) ou l'erreur ;
  - Prompts : liste, consultation en lecture seule, « Nouvelle version » (éditeur `<textarea>` prérempli du texte actif, compteur de caractères, rappel « La réponse doit rester au format JSON attendu : le schéma est ajouté par le serveur en mode json_object. »), « Activer » avec confirmation ;
  - Réglages : formulaire des trois champs, bornes dans les champs, confirmation qui liste les changements ; si `maxWebSearches` change : « Pensez à mettre à jour la page /privacy, qui annonce jusqu'à 3 recherches. » ;
  - Recherche web : état (`ok` vert, `down` orange « Recherche indisponible », `disabled` gris), URL, entrées du cache, « Tester une recherche » ;
  - Journal : `ActionLog` des 20 dernières actions IA.
- `429` sur un essai : « Limite d'essais atteinte, réessayez dans une heure. ».

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `providers show key state without value` ;
  - `add model then list refreshes` ; `activate model asks confirmation` ;
  - `model test shows score or error` ; `model test 429 shows the limit message` ;
  - `new prompt prefilled from active, counter and json reminder` ; `prompt under 200 chars cannot be sent` ;
  - `settings confirmation lists changes and privacy warning on maxWebSearches` ;
  - `search test shows results and disabled state`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier.** Commandes de l'admin et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(admin): écran IA (fournisseurs, modèles, prompts, réglages, recherche web)`.

### Tâche 12 : documentation et suivi

**Fichiers :**
- Modifier :
  - la spécification principale : §5.4 (connexion de l'admin, `target`), §6.3 (`admin_actions` complète, `llm_calls`), §8 (écrans livrés en partie 1), §13 (phase 4b en deux parties) ;
  - `docs/etat-du-projet.md` ;
  - `README.md` (`pnpm dev:admin`, `http://localhost:8080/admin/`, `pnpm admin:grant <email>` et `admin:revoke`, commande `docker compose exec auth …` en production, `--no-access-log`) ;
  - `infra/.env.example` si une variable change (aucune n'est prévue).
- Créer : `docs/superpowers/plans/2026-10-21-phase-4b-partie-1-suivi.md`.

- **Contenu du suivi :**
  - vérifications en vrai : connexion de l'admin par lien et par code sur `localhost:8080/admin/`, `admin:grant` sur la base de dev, `/auth/admin/list-users` en 404 avec la session admin, essai du modèle sur `stub` puis OmniRoute, essai de recherche sur SearXNG, en-têtes de Caddy, `docker compose logs api` sans ligne d'accès ;
  - limites connues : limiteurs des essais propres à chaque processus de l'API ; cache des recherches propre à chaque processus ; un admin peut supprimer son compte depuis la popup, même s'il est le dernier ;
  - reste pour la partie 2 : Tableau de bord, Offre (dont `/pricing`), Analyses.

- [ ] **Étape 1 : mettre à jour les docs,** dans le style de `docs/etat-du-projet.md`.
- [ ] **Étape 2 : vérifier.** Commandes : `pnpm lint && pnpm test:all && pnpm check:api`. Résultat attendu : PASS.
- [ ] **Étape 3 : commiter.** Message : `docs: phase 4b partie 1 (admin : socle, utilisateurs, IA) et suivi`.
