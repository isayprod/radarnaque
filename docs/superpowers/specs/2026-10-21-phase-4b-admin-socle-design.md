# Phase 4b — Administration : socle commun

*Spec du 21 octobre 2026.* La phase 4b livre l'administration de Radarnaque (§8 de la [spécification principale](2026-10-16-radarnaque-v4-design.md)). Elle est décrite en six documents :

| Document | Contenu |
|---|---|
| **Ce document** | application, connexion, droits, journal des actions, conventions de l'API |
| [Tableau de bord](2026-10-21-phase-4b-admin-tableau-de-bord-design.md) | activité, coûts, cache, échecs, abonnés |
| [Utilisateurs](2026-10-21-phase-4b-admin-utilisateurs-design.md) | recherche, fiche, plan, rôle, suppression |
| [Offre](2026-10-21-phase-4b-admin-offre-design.md) | prix, quotas, fonctionnalités, photos, plafond de l'essai |
| [IA](2026-10-21-phase-4b-admin-ia-design.md) | modèles, modèle actif, prompts, réglages, recherche web |
| [Analyses](2026-10-21-phase-4b-admin-analyses-design.md) | liste et détail des analyses récentes |

Branche : `feat/phase-4b`, au-dessus de `main` (la phase 4a y est fusionnée).

## 1. Objectifs

- Gérer les comptes, l'offre et l'IA sans toucher à la base ni à la ligne de commande.
- Suivre l'activité et les coûts.
- Garder une trace de chaque modification faite dans l'admin.

## 2. Application

- **Nouvelle application `apps/admin`** : Vite, React et Tailwind, comme la popup de l'extension. Elle est servie sous `/admin/`, sur la même origine que l'API et l'auth (Caddy).
- **Construction :** `pnpm --filter admin build` produit des fichiers statiques. En production, le Dockerfile de Caddy (`infra/caddy/Dockerfile`) construit l'admin en plus du site et copie ses fichiers dans `/srv/admin`. Toute URL `/admin/*` sert `index.html`, et le routage se fait côté client.
- **Développement :** comme le site, l'admin est compilée en continu (`pnpm dev:admin`, `vite build --watch`) et servie par le Caddy de dev sur `http://localhost:8080/admin/` :
  - `Caddyfile.dev` reçoit le même bloc `/admin/*` que le Caddyfile de production ;
  - `docker-compose.dev.yml` monte `apps/admin/dist` en lecture seule sur `/srv/admin` ;
  - `pnpm dev` lance aussi `dev:admin`. Pas de serveur de dev Vite : aucun port de plus, et l'admin reste sur la même origine que l'auth.
- **Langue :** l'interface est en français seulement.
- **Navigation :** une barre latérale avec les cinq écrans. L'en-tête montre l'email de l'admin connecté et un bouton « Se déconnecter ».
- **Pas de données sensibles dans le navigateur :** aucun stockage local hors de la session. Le JWT reste en mémoire et est redemandé au besoin.
- **En-têtes de sécurité** (Caddy, sur `/admin/*`) :
  - `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'` ;
  - `X-Frame-Options: DENY` ;
  - `Referrer-Policy: no-referrer` ;
  - `Cache-Control: no-store` sur `index.html`.

## 3. Connexion

- **Page de connexion** de l'admin : champ email, puis lien magique **ou** code à 6 chiffres, comme l'extension.
  - L'admin appelle `POST /auth/start` avec `{ email, locale: "fr", target: "admin" }`.
  - Le service auth accepte `target` dans une liste fermée : `extension` (défaut) ou `admin`. Avec `admin`, le lien magique renvoie vers `/admin/` au lieu de `/auth/callback`. Le code se saisit dans la page de l'admin, via `POST /auth/sign-in/email-otp` de Better Auth.
  - L'email a une variante pour `admin` : il dit de saisir le code « dans la page d'administration », et non « dans l'extension » (`services/auth/src/mail/templates.ts`). Il reste en français.
  - Le lien comme le code ouvrent une session Better Auth par cookie, sur la même origine.
- **JWT :** l'application obtient un JWT par `GET /auth/token`, avec le cookie de session. Elle l'envoie en `Authorization: Bearer` à `/api/admin/*`. Elle redemande un JWT après un `401`, une seule fois, puis revient à l'écran de connexion.
- **Accès refusé :** un utilisateur connecté qui n'a pas le droit d'admin voit « Accès réservé aux administrateurs » et un bouton de déconnexion. Aucune donnée n'est chargée.
- **Déconnexion :** `POST /auth/sign-out`, puis retour à l'écran de connexion.

## 4. Droits

- **Accès à l'admin :** `auth.user.role = 'admin'`. Hors production, un superuser y a aussi accès, pour les essais en dev. En production, ce rôle n'a aucun droit (§5.3 bis).
- **Toutes les routes `/api/admin/*`** exigent ce droit. Sinon : `401 unauthenticated` (sans JWT valide) ou `403 admin_required`.
- **Premier admin :** `pnpm admin:grant <email>` donne le rôle `admin` à un compte existant, y compris en production. La commande se lance sur le serveur, avec l'accès à la base. `pnpm admin:revoke <email>` le retire.
- **Routes d'administration de Better Auth fermées :** le plugin `admin()` reste activé, car il fournit la colonne `role`. Mais ses routes HTTP (`/auth/admin/set-role`, `remove-user`, `list-users`, `ban-user`, `impersonate-user`…) donneraient à toute session admin un accès qui contourne `admin_actions` et les garde-fous. Le service auth répond donc `404` à tout `/auth/admin/*`, avant `auth.handler`. Les changements de rôle et les suppressions passent uniquement par `/api/admin/*`, et l'API écrit `auth.user.role` comme elle supprime déjà la ligne `auth.user` (phase 4a).
- **Garde-fous** (détail dans le spec des utilisateurs) :
  - un admin ne peut ni retirer son propre rôle ni supprimer son propre compte depuis l'admin ;
  - le dernier admin ne peut pas être rétrogradé. Le contrôle verrouille les lignes des admins (`SELECT … FOR UPDATE`) : deux retraits simultanés ne peuvent pas laisser zéro admin ;
  - un admin peut toujours supprimer son compte depuis la popup (`DELETE /api/me`, phase 4a), même s'il est le dernier. C'est accepté : `pnpm admin:grant` rétablit un admin.

## 5. Journal des actions : `admin_actions`

- **Table** (migration 0007), d'après le §6.3 de la spécification principale :

```
admin_actions(id PK, admin_user_id FK→auth.user ON DELETE SET NULL NULL,
              action TEXT, target_user_id TEXT NULL, details JSONB NOT NULL DEFAULT '{}',
              created_at TIMESTAMPTZ NOT NULL DEFAULT now())
  INDEX (created_at DESC), INDEX (target_user_id)
```

- **Choix de clé étrangère :**
  - `target_user_id` n'a pas de clé étrangère, ce qui garde la trace d'une suppression de compte (§6.3) ;
  - `admin_user_id` passe à `NULL` si l'admin est supprimé.
- **Actions enregistrées**, avec leur code :
  - comptes : `user.plan_set`, `user.role_set`, `user.deleted` ;
  - offre : `offer.price_set`, `offer.quota_set`, `offer.feature_set`, `offer.max_images_set`, `offer.total_cap_set` ;
  - IA : `ai.model_added`, `ai.model_activated`, `ai.prompt_created`, `ai.prompt_activated`, `ai.settings_set` ;
  - système : `system.purge`, écrite par la purge quotidienne (`admin_user_id` à `NULL`, `{ "deletedScans": n, "deletedActions": n, "deletedLlmCalls": n }`). Elle n'est écrite que si la passe a tourné : une passe sautée (verrou tenu ailleurs) ou en échec n'écrit rien. Les journaux affichés dans l'admin (fiche, IA, Offre) ne la montrent pas ; le tableau de bord lit la dernière.
- **`details`** contient l'ancienne et la nouvelle valeur, par exemple `{ "from": "trial", "to": "premium" }`. Elle ne contient jamais d'email, ni le texte complet d'un prompt (seulement sa version).
- **Écriture :** chaque route de modification écrit sa ligne `admin_actions` **dans la même transaction** que le changement. Pas de changement sans trace.
- **Consultation :** chaque fiche utilisateur montre les actions qui le visent. L'écran IA et l'écran Offre montrent leurs 20 dernières actions.
- **Durée :** le journal est gardé 12 mois. La purge quotidienne de la phase 4a est étendue dans cette phase pour supprimer aussi les lignes `admin_actions` et `llm_calls` (§5 bis) de plus de 12 mois. On garde les références au compte visé (identifiant seul), pas son email.

## 5 bis. Appels au modèle : `llm_calls`

Une analyse du cache expirée est rafraîchie sur place (`save_analysis`, règle R4) : son coût, ses tokens et sa date sont écrasés. Les statistiques de coût et de cache ne peuvent donc pas se calculer sur `analyses`, ni sur `from_cache_expr`, qui classe « appel au modèle » un scan servi avant un rafraîchissement. Le tableau de bord lit à la place une trace par appel.

- **Table** (même migration 0007) :

```
llm_calls(id BIGINT PK, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          analysis_id FK→analyses, model_id FK→models, prompt_version_id FK→prompt_versions,
          tokens_in INT, tokens_out INT, cost_usd_micros BIGINT,
          images_analyzed INT, web_searches INT)
  INDEX (created_at), INDEX (analysis_id)
```

- **Écriture :** une ligne par appel au modèle qui produit une analyse, dans la même transaction que `save_analysis` (insertion comme rafraîchissement), avec la date de l'événement qui l'a produite. Un appel en échec n'écrit rien, comme aujourd'hui pour `analyses`. Les essais « Tester » de l'écran IA n'y sont pas écrits.
- **Pas de donnée personnelle :** ni utilisateur ni événement de scan. Comme `analyses`, la table ne relie pas un appel à un compte.
- **Reprise :** la migration crée une ligne par analyse existante (sa date, son modèle, son prompt, ses tokens et son coût actuels). L'historique d'avant la migration reste approximatif pour les analyses déjà rafraîchies.
- **Usage :** le tableau de bord (coûts, appels, part servie depuis le cache) et l'écran Analyses (nombre d'appels et coût total d'une analyse).

## 6. Conventions de l'API admin

- **Routeur `/api/admin/*`** dans l'API FastAPI, avec une dépendance `require_admin` qui renvoie l'utilisateur et ses privilèges.
- **Schémas Pydantic** en camelCase, comme le reste de l'API. Le contrat OpenAPI est régénéré (`pnpm gen:api`) et l'application admin utilise les types de `@radarnaque/shared`.
- **Erreurs :** le format habituel `{ error: { code, message, details } }`. Les codes nouveaux sont :
  - `403 admin_required` ;
  - `404 not_found` ;
  - `409 conflict` (le dernier admin, ou soi-même) ;
  - `422 invalid_value` : contrôle métier qui suit une requête bien formée (fournisseur absent de `providers.toml`, plan inconnu, prix sur l'essai).
- **Validation :** les bornes et les types sont déclarés dans les schémas Pydantic. Une valeur hors bornes donne donc le `422 invalid_request` existant, avec la liste des champs en cause. Dans les specs des écrans, « `422` » désigne l'un ou l'autre selon cette règle.
- **Pagination :** par curseur (`before`, `limit` de 50 au plus), comme `GET /api/scans/history`.
- **Lecture seule par défaut :** les routes `GET` ne modifient rien. Les modifications passent par `POST`, `PATCH` ou `DELETE`, et demandent une confirmation dans l'interface quand elles sont lourdes (suppression, rétrogradation, changement de modèle actif).
- **Journal de l'API :** une ligne `INFO` par modification, sous `radarnaque.admin`, avec le code de l'action. Ni email ni identifiant.
- **Pas de journal d'accès HTTP :** uvicorn journalise par défaut chaque requête avec son chemin et sa query string, donc un email cherché (`/api/admin/users?q=…`) ou l'identifiant d'une fiche. L'API est lancée avec `--no-access-log`, en production (Dockerfile) comme en dev (`pnpm dev:api`). Caddy n'a pas de journal d'accès.
- **Disponibilité du moteur de recherche** (écrans IA et Tableau de bord) : `GET {SEARXNG_URL}/healthz`, délai de 3 s, résultat gardé 60 s en mémoire. Trois états : `ok`, `down`, `disabled` (`SEARCH_BACKEND=none`). L'appel n'envoie aucune requête aux moteurs externes.

## 7. Tests communs

- **API :**
  - `require_admin` : `401` sans JWT, `403` pour un utilisateur, accès pour un admin ;
  - superuser accepté hors production et refusé en production ;
  - chaque route de modification écrit sa ligne `admin_actions` dans la même transaction (une erreur après le changement ne laisse ni changement ni trace) ;
  - migration 0007, en montée et en descente, avec la reprise de `llm_calls` ;
  - `llm_calls` : une ligne par appel, à l'insertion comme au rafraîchissement d'une analyse ; aucune ligne pour un scan servi depuis le cache, ni pour un appel en échec ;
  - purge : `admin_actions` et `llm_calls` de plus de 12 mois supprimés, une ligne `system.purge` par passe qui a tourné, aucune pour une passe sautée ;
  - dernier admin : deux retraits simultanés laissent un admin ;
  - aucune ligne de journal d'accès pour une requête `/api/admin/users?q=…` ;
  - disponibilité du moteur : `ok`, `down` (délai dépassé), `disabled`.
- **Auth :**
  - `target: "admin"` produit un lien vers `/admin/` ;
  - une valeur hors liste est refusée (`400 invalid_target`) ;
  - l'email de `target: "admin"` renvoie à la page d'administration, pas à l'extension ;
  - `/auth/admin/*` donne `404`, y compris avec la session d'un admin ;
  - `admin:grant` et `admin:revoke`, sur un compte existant ou absent.
- **Application admin :**
  - connexion par code et par lien ;
  - accès refusé à un utilisateur ordinaire ;
  - nouveau JWT après un `401` ;
  - déconnexion.
- **Caddy :** `/admin/x` sert `index.html` ; les en-têtes de sécurité sont présents ; même comportement avec `Caddyfile.dev`.

## 8. Hors de cette phase

- Les paiements (phase 5).
- L'export des données d'un utilisateur (droit d'accès), à prévoir dans une phase ultérieure.
- La double authentification de l'admin.
