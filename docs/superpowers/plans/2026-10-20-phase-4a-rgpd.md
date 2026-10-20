# Phase 4a — RGPD : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** l'utilisateur supprime son compte depuis la popup, l'historique des scans est purgé à 12 mois, et la page `/privacy` est publiable.

**Architecture :**
- **API :**
  - `DELETE /api/me` supprime `auth."user"`, et les clés étrangères en cascade font le reste ;
  - une tâche de fond quotidienne, protégée par un verrou consultatif, purge les `scan_events` de plus de 12 mois ;
  - le compteur `subscriptions.purged_scans` garde le quota à vie de l'essai.
- **Extension :** un message `account/delete`, réservé à la popup, et une section de confirmation tapée.
- **Site :** les textes de `/privacy` sont mis à jour.

**Tech Stack :** FastAPI, SQLAlchemy async, Alembic, WXT et React (popup), Vite (site).

**Spec :** `docs/superpowers/specs/2026-10-20-phase-4a-rgpd-design.md`. La spécification principale `docs/superpowers/specs/2026-10-16-radarnaque-v4-design.md` s'applique pour le reste.

## Global Constraints

**Git et fichiers locaux :**
- Branche `feat/phase-4a`. Pas de push.
- Le trailer de commit est celui que donnent les instructions de session pour le modèle.
- Ne jamais toucher : `video/`, `.DS_Store`, `services/api/tests/.conftest.py.swp`, `docs/superpowers/plans/.Rhistory`.
- `web-pages/` n'est jamais lu ; `infra/.env` n'est jamais affiché.
- Aucun email réel, aucune clé, aucun jeton.

**Langue :** le code, les commentaires, les messages et les docs sont en français, dans le style des fichiers voisins.

**Valeurs fixées par le spec :**

| Élément | Valeur |
|---|---|
| Rétention | `SCAN_RETENTION_MONTHS = 12` |
| Purge | lots de 5 000 événements ; tâche lancée 60 s après le démarrage, puis toutes les 24 h ; `pg_try_advisory_lock` sur une clé fixe |
| Désactivation | `PURGE_ENABLED` (`false` dans les tests) |
| Compteur de l'essai | colonne `subscriptions.purged_scans INTEGER NOT NULL DEFAULT 0` (migration 0006) |
| `DELETE /api/me` | `204` sans corps ; `401 unauthenticated` si l'utilisateur est absent |
| Message de l'extension | `account/delete`, jamais dans `CONTENT_SCRIPT_MESSAGES` |
| Mot de confirmation | `SUPPRIMER` (FR) et `VERWIJDEREN` (NL), sans tenir compte de la casse ni des espaces autour |
| Contact | `privacy@mostconsult.be` |

**Commandes :**
- API : `cd services/api && uv run pytest -q && uv run ruff check . && uv run ruff format --check .` ;
- contrat : `pnpm check:api`, régénéré par `pnpm gen:api` ;
- extension : `pnpm --filter extension test && pnpm --filter extension exec tsc --noEmit` ;
- site : `pnpm --filter site test` ;
- racine : `pnpm lint`.

## Review Focus

1. **La purge ne doit pas rendre ses analyses à un essai.** Un essai qui a fait 3 scans il y a 13 mois a toujours 0 analyse restante après la purge, et le plafond total compte `purged_scans`. Test en tâche 2.
2. **La purge ne doit jamais toucher un événement récent ni une analyse.** Un événement de 11 mois et 29 jours reste, et `analyses` comme `listing_snapshots` gardent leur nombre de lignes. Test en tâche 2.
3. **Un content script qui envoie `account/delete`** reçoit `forbidden_sender`, sans aucun appel à l'API, même s'il imite la forme exacte du message de la popup. Test en tâche 3.
4. **Une suppression qui échoue côté serveur** (500, réseau) laisse la session locale intacte, et la popup dit que rien n'a changé. Une suppression qui réussit, puis une session déjà invalide (401), nettoient tout. Test en tâche 3.
5. **Un double clic sur « Supprimer définitivement »** n'envoie qu'une requête. Test en tâche 4.

---

### Tâche 1 : `DELETE /api/me` et compteur `purged_scans`

**Fichiers :**
- Créer :
  - `services/api/alembic/versions/0006_purged_scans.py`
  - `services/api/tests/test_migration_0006.py`
  - `services/api/tests/test_account_deletion.py`
- Modifier :
  - `services/api/src/radarnaque_api/models/subscriptions.py` (`Subscription.purged_scans: Mapped[int]`) ;
  - `services/api/src/radarnaque_api/services/usage.py` (`compute_usage` ajoute `purged_scans` pour une période `lifetime`) ;
  - `services/api/src/radarnaque_api/routes/me.py` (route `DELETE /api/me`) ;
  - `packages/shared/openapi.json` et `packages/shared/src/api.ts`, régénérés.

**Interfaces :**
- Fournit :
  - `async def delete_account(session: AsyncSession, user_id: str) -> bool` dans `services/api/src/radarnaque_api/services/accounts.py`. Elle renvoie `False` si l'utilisateur n'existe plus, et ne fait pas le commit ;
  - la colonne `purged_scans`.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `test_delete_me_cascades` : 204. Ensuite, aucune ligne pour cet utilisateur dans `auth."user"`, `auth.session`, `auth.account`, `app.subscriptions`, `app.scan_events`, `app.scan_results` et `app.scan_failures`. Le nombre de lignes de `app.analyses` et de `app.listing_snapshots` est inchangé.
  - `test_delete_me_then_401` : un second `DELETE` avec le même JWT donne 401, et `GET /api/me` aussi.
  - `test_delete_me_requires_jwt` : sans en-tête, 401.
  - `test_delete_me_other_users_untouched` : les lignes d'un autre utilisateur restent.
  - `test_delete_me_admin_and_superuser` : un admin et un superuser peuvent se supprimer (204).
  - `test_usage_counts_purged_scans_for_lifetime` : un essai avec `purged_scans = 3` et aucun `scan_event` donne 0 restant, `total.used == 3`. Un abonnement mensuel avec `purged_scans = 5` n'est pas affecté.
  - `test_migration_0006` : la montée ajoute la colonne avec 0 pour les lignes existantes ; la descente la retire.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.** La route utilise `current_user` puis `delete_account`, et fait le commit. Elle répond `Response(status_code=204)`. Une ligne `INFO` « compte supprimé », sans identifiant. Puis `pnpm gen:api`.
- [ ] **Étape 4 : vérifier.** Commandes : `uv run pytest -q && uv run ruff check . && pnpm check:api`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): DELETE /api/me (suppression en cascade) et compteur purged_scans`.

### Tâche 2 : purge à 12 mois

**Fichiers :**
- Créer :
  - `services/api/src/radarnaque_api/services/purge.py`
  - `services/api/src/radarnaque_api/purge_cli.py`
  - `services/api/tests/test_purge.py`
- Modifier :
  - `services/api/pyproject.toml` (`radarnaque-purge = "radarnaque_api.purge_cli:main"`) ;
  - `services/api/src/radarnaque_api/config.py` (`purge_enabled: bool = True`) ;
  - `services/api/src/radarnaque_api/main.py` (tâche de fond dans le `lifespan`, annulée à l'arrêt) ;
  - `services/api/tests/conftest.py` (`purge_enabled=False`) ;
  - `infra/.env.example` (`PURGE_ENABLED`, commenté).

**Interfaces :**
- Utilise : `Subscription.purged_scans` (tâche 1).
- Fournit :

```python
SCAN_RETENTION_MONTHS = 12
PURGE_BATCH = 5_000
PURGE_FIRST_DELAY_S = 60
PURGE_INTERVAL_S = 24 * 3600
def retention_cutoff(now: datetime) -> datetime  # now moins 12 mois calendaires (même jour, 12 mois plus tôt ; 29 février → 28 février)
async def purge_old_scans(engine: AsyncEngine, now: datetime) -> int | None  # nombre supprimé ; None si le verrou est pris
async def purge_forever(engine: AsyncEngine, now: Callable[[], datetime], *, first_delay_s: float = PURGE_FIRST_DELAY_S, interval_s: float = PURGE_INTERVAL_S) -> None
```

- **Algorithme de `purge_old_scans` :**
  1. prendre `pg_try_advisory_lock(<clé fixe>)` sur une connexion dédiée (session), et renvoyer `None` sans rien faire si le verrou est pris ;
  2. tant qu'il reste des événements plus anciens que la limite : dans une transaction, sélectionner au plus `PURGE_BATCH` ids `FOR UPDATE SKIP LOCKED`. Puis, pour les abonnements à période `lifetime`, ajouter à `purged_scans` le nombre de ces événements réussis (sans `scan_failures`) de l'utilisateur dont `created_at >= period_start`. Enfin, supprimer les événements par id et commiter ;
  3. libérer le verrou dans un `finally`, et journaliser une ligne `INFO` avec le total.
- **`purge_forever` :** attend `first_delay_s`, puis boucle (purge, puis attente de `interval_s`). Une exception d'une passe est journalisée en `WARNING`, sans identifiant, et la boucle continue. `CancelledError` passe sans être capturée.
- **`purge_cli.main()` :** une passe, et affiche `scan_events supprimés : N`, ou `purge déjà en cours ailleurs`. Elle lit la configuration comme l'API.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `test_cutoff_calendar_months` : 2026-10-20 donne 2025-10-20 ; 2028-02-29 donne 2027-02-28.
  - `test_purge_old_keeps_recent` : des événements à 13 mois et à 11 mois 29 jours : seul le premier part ; ses `scan_results` et `scan_failures` partent aussi ; `analyses` et `listing_snapshots` gardent leur nombre de lignes.
  - `test_purge_batches` : avec `PURGE_BATCH` ramené à 2 et 5 vieux événements, les 5 partent et le total renvoyé vaut 5.
  - `test_trial_keeps_quota_after_purge` : un essai a fait 3 scans réussis il y a 13 mois et 1 scan en échec. Après la purge, `purged_scans == 3` et `GET /api/me` donne `remaining` 0 sur `full` et `totalCap.used == 3`.
  - `test_monthly_subscription_not_counted` : un abonnement Standard dont les vieux événements sont purgés garde `purged_scans == 0`.
  - `test_lock_skips_second_purge` : avec le verrou tenu par une autre connexion, `purge_old_scans` renvoie `None` et ne supprime rien.
  - `test_purge_forever_survives_error` : un moteur en panne à la première passe donne un `WARNING`, et la seconde passe a lieu (délais ramenés à 0).
  - `test_lifespan_no_purge_when_disabled` : avec `purge_enabled=False`, aucune tâche de purge n'est créée.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.** La tâche de fond est gardée dans `app.state.purge_task`, annulée puis attendue à l'arrêt.
- [ ] **Étape 4 : vérifier.** Commandes : `uv run pytest -q && uv run ruff check . && uv run ruff format --check .`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): purge quotidienne des scans de plus de 12 mois, quota de l'essai préservé`.

### Tâche 3 : message `account/delete` dans le service worker

**Fichiers :**
- Modifier :
  - `apps/extension/lib/api-client.ts` (`deleteMe(): Promise<void>`) ;
  - `apps/extension/lib/messages.ts` (`{ type: "account/delete" }` dans `BgRequest`, hors de `CONTENT_SCRIPT_MESSAGES`) ;
  - `apps/extension/lib/background-handlers.ts` (handler) ;
  - les tests `api-client.test.ts` et `background-handlers.test.ts`.

**Interfaces :**
- Fournit : `HandlerDeps.api.deleteMe(): Promise<void>`. Le message répond `{ ok: true, data: null }` ou `{ ok: false, error: { code } }`.
- **Comportement :**
  - `deleteMe` envoie `DELETE /api/me` et accepte `204`. Un `401` passe par le renouvellement habituel du JWT, puis devient `session_expired`. Un autre statut lève `ApiRequestError`.
  - Le handler appelle `api.deleteMe()`. Sur un succès ou sur `session_expired`, il exécute `storeSession(null)`, puis `deps.clearAiResults()` (dont l'échec est ignoré), et répond ok. Toute autre erreur renvoie le code sans rien effacer.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `api-client` :
    - `deleteMe sends DELETE /api/me with bearer` ;
    - `deleteMe 204 resolves` ;
    - `deleteMe 500 throws ApiRequestError`.
  - `background-handlers` :
    - `account/delete from popup deletes then clears session and ai results` ;
    - `account/delete treats session_expired as done` ;
    - `account/delete keeps session on 500` (jeton toujours présent, `clearAiResults` non appelé) ;
    - `account/delete from content script is forbidden_sender without network` (point 3 de Review Focus : `deleteMe` jamais appelé) ;
    - `CONTENT_SCRIPT_MESSAGES does not contain account/delete`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier.** Commandes : `pnpm --filter extension test && pnpm --filter extension exec tsc --noEmit && pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(extension): message account/delete réservé à la popup, nettoyage local après suppression`.

### Tâche 4 : section « Supprimer mon compte » et lien « Confidentialité » dans la popup

**Fichiers :**
- Modifier :
  - `apps/extension/entrypoints/popup/App.tsx` (section repliable et lien dans le pied) ;
  - `apps/extension/lib/i18n.ts` (textes FR et NL) ;
  - `apps/extension/test/popup.test.tsx`.

**Interfaces :**
- Utilise : le message `account/delete` (tâche 3) et `PUBLIC_URL` (`lib/config.ts`).
- **Textes :**
  - titre « Supprimer mon compte » / « Mijn account verwijderen » ;
  - explication « Votre compte, votre abonnement et l'historique de vos analyses seront effacés. Les analyses d'annonces, anonymes, sont conservées. » / « Uw account, uw abonnement en de geschiedenis van uw analyses worden gewist. De analyses van advertenties, die anoniem zijn, blijven bewaard. » ;
  - invite « Tapez SUPPRIMER pour confirmer » / « Typ VERWIJDEREN om te bevestigen » ;
  - bouton « Supprimer définitivement » / « Definitief verwijderen » ;
  - pendant l'appel « Suppression… » / « Verwijderen… » ;
  - succès « Votre compte a été supprimé. » / « Uw account is verwijderd. » ;
  - échec « La suppression a échoué, votre compte n'a pas été modifié. Réessayez. » / « Verwijderen is mislukt, uw account is niet gewijzigd. Probeer opnieuw. » ;
  - lien « Confidentialité » / « Privacy », vers `${PUBLIC_URL}/privacy/?lang=<langue>`, dans un nouvel onglet.
- **Comportement :**
  - la section est repliée par défaut (`<details>`), et seulement visible quand l'utilisateur est connecté ;
  - le bouton reste désactivé tant que le champ, une fois les espaces retirés et en majuscules, ne vaut pas le mot de la langue active ;
  - pendant l'appel, le bouton est désactivé, et un second clic n'envoie rien ;
  - en cas de succès : le message de succès, puis l'écran de connexion (état relu) ;
  - en cas d'échec : le message d'échec, la section reste ouverte, le champ est conservé.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `delete section hidden when signed out` ;
  - `delete button disabled until the word is typed (fr)` (avec « supprimer » en minuscules et des espaces autour, il est actif) ;
  - `delete word is VERWIJDEREN in nl` ;
  - `double click sends one account/delete` (point 5 de Review Focus) ;
  - `success shows message then sign-in screen` ;
  - `failure keeps the section and shows the error` ;
  - `privacy link points to /privacy with the active locale`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter,** dans le style Tailwind de la popup existante.
- [ ] **Étape 4 : vérifier.** Commandes : `pnpm --filter extension test && pnpm --filter extension exec tsc --noEmit && pnpm lint && pnpm --filter extension build`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(extension): suppression du compte depuis la popup (confirmation tapée) et lien Confidentialité`.

### Tâche 5 : page `/privacy` et documentation

**Fichiers :**
- Modifier :
  - `apps/site/src/pages-i18n.ts` (sections et ordre) ;
  - `apps/site/test/pages-i18n.test.ts` ;
  - la spécification principale (§7.1 `DELETE /api/me`, §10, §4.6 messagerie, §13 phases 4a et 4b) ;
  - `docs/etat-du-projet.md` ;
  - `README.md` (`radarnaque-purge`, `PURGE_ENABLED`).
- Créer : `docs/superpowers/plans/2026-10-20-phase-4a-suivi.md` (vérifications à faire, décisions, déclarations du Chrome Web Store à préparer).

**Interfaces :**
- Utilise : la clé de section `web` (nouvelle) et les clés existantes de `PRIVACY_ORDER`.
- **Contenu, d'après le spec §5 :**
  - `photos` réécrite pour toutes les analyses ;
  - nouvelle section `web`, placée après `photos` ;
  - nouvelle section `browser`, après `web`, sur le résultat gardé 24 h et effacé à la déconnexion ;
  - `kept`, qui précise que seul le nombre d'analyses de l'essai est gardé après 12 mois ;
  - `erasure`, qui cite « Supprimer mon compte » dans la popup, puis `{email}` ;
  - le commentaire « Ne pas publier avant la phase 4 » est retiré.

- [ ] **Étape 1 : écrire les tests qui échouent** (pages-i18n.test.ts) :
  - FR et NL ont les mêmes clés, dans l'ordre de `PRIVACY_ORDER` ;
  - `web` et `browser` existent ;
  - `photos` ne contient plus « Premium » comme condition ;
  - `erasure` contient `{email}` ;
  - `kept` contient `{months}`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : mettre à jour les textes et les docs.** Les docs suivent le style de `docs/etat-du-projet.md`.
- [ ] **Étape 4 : vérifier.** Commandes : `pnpm --filter site test && pnpm lint && pnpm test:all`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `docs: page /privacy à jour (photos, recherche web, navigateur, effacement) et phase 4a`.
