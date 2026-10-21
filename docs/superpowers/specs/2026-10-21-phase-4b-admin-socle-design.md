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

Branche : `feat/phase-4b`, au-dessus de `feat/phase-4a`.

## 1. Objectifs

- Gérer les comptes, l'offre et l'IA sans toucher à la base ni à la ligne de commande.
- Suivre l'activité et les coûts.
- Garder une trace de chaque modification faite dans l'admin.

## 2. Application

- **Nouvelle application `apps/admin`** : Vite, React et Tailwind, comme la popup de l'extension. Elle est servie sous `/admin/`, sur la même origine que l'API et l'auth (Caddy).
- **Construction :** `pnpm --filter admin build` produit des fichiers statiques. En production, ils sont copiés dans l'image Caddy (`/srv/admin`). Toute URL `/admin/*` sert `index.html`, et le routage se fait côté client.
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
  - Le lien comme le code ouvrent une session Better Auth par cookie, sur la même origine.
- **JWT :** l'application obtient un JWT par `GET /auth/token`, avec le cookie de session. Elle l'envoie en `Authorization: Bearer` à `/api/admin/*`. Elle redemande un JWT après un `401`, une seule fois, puis revient à l'écran de connexion.
- **Accès refusé :** un utilisateur connecté qui n'a pas le droit d'admin voit « Accès réservé aux administrateurs » et un bouton de déconnexion. Aucune donnée n'est chargée.
- **Déconnexion :** `POST /auth/sign-out`, puis retour à l'écran de connexion.

## 4. Droits

- **Accès à l'admin :** `auth.user.role = 'admin'`. Hors production, un superuser y a aussi accès, pour les essais en dev. En production, ce rôle n'a aucun droit (§5.3 bis).
- **Toutes les routes `/api/admin/*`** exigent ce droit. Sinon : `401 unauthenticated` (sans JWT valide) ou `403 admin_required`.
- **Premier admin :** `pnpm admin:grant <email>` donne le rôle `admin` à un compte existant, y compris en production. La commande se lance sur le serveur, avec l'accès à la base. `pnpm admin:revoke <email>` le retire.
- **Garde-fous** (détail dans le spec des utilisateurs) :
  - un admin ne peut ni retirer son propre rôle ni supprimer son propre compte depuis l'admin ;
  - le dernier admin ne peut pas être rétrogradé.

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
  - IA : `ai.model_added`, `ai.model_activated`, `ai.prompt_created`, `ai.prompt_activated`, `ai.settings_set`.
- **`details`** contient l'ancienne et la nouvelle valeur, par exemple `{ "from": "trial", "to": "premium" }`. Elle ne contient jamais d'email, ni le texte complet d'un prompt (seulement sa version).
- **Écriture :** chaque route de modification écrit sa ligne `admin_actions` **dans la même transaction** que le changement. Pas de changement sans trace.
- **Consultation :** chaque fiche utilisateur montre les actions qui le visent. L'écran IA et l'écran Offre montrent leurs 20 dernières actions.
- **Durée :** le journal est gardé 12 mois. La purge quotidienne de la phase 4a est étendue dans cette phase pour supprimer aussi les lignes `admin_actions` de plus de 12 mois. On garde les références au compte visé (identifiant seul), pas son email.

## 6. Conventions de l'API admin

- **Routeur `/api/admin/*`** dans l'API FastAPI, avec une dépendance `require_admin` qui renvoie l'utilisateur et ses privilèges.
- **Schémas Pydantic** en camelCase, comme le reste de l'API. Le contrat OpenAPI est régénéré (`pnpm gen:api`) et l'application admin utilise les types de `@radarnaque/shared`.
- **Erreurs :** le format habituel `{ error: { code, message, details } }`. Les codes nouveaux sont :
  - `403 admin_required` ;
  - `404 not_found` ;
  - `409 conflict` (le dernier admin, ou soi-même) ;
  - `422 invalid_value`.
- **Pagination :** par curseur (`before`, `limit` de 50 au plus), comme `GET /api/scans/history`.
- **Lecture seule par défaut :** les routes `GET` ne modifient rien. Les modifications passent par `POST`, `PATCH` ou `DELETE`, et demandent une confirmation dans l'interface quand elles sont lourdes (suppression, rétrogradation, changement de modèle actif).
- **Journal de l'API :** une ligne `INFO` par modification, sous `radarnaque.admin`, avec le code de l'action. Ni email ni identifiant.

## 7. Tests communs

- **API :**
  - `require_admin` : `401` sans JWT, `403` pour un utilisateur, accès pour un admin ;
  - superuser accepté hors production et refusé en production ;
  - chaque route de modification écrit sa ligne `admin_actions` dans la même transaction (une erreur après le changement ne laisse ni changement ni trace) ;
  - migration 0007, en montée et en descente.
- **Auth :**
  - `target: "admin"` produit un lien vers `/admin/` ;
  - une valeur hors liste est refusée (`400 invalid_target`) ;
  - `admin:grant` et `admin:revoke`, sur un compte existant ou absent.
- **Application admin :**
  - connexion par code et par lien ;
  - accès refusé à un utilisateur ordinaire ;
  - nouveau JWT après un `401` ;
  - déconnexion.
- **Caddy :** `/admin/x` sert `index.html` ; les en-têtes de sécurité sont présents.

## 8. Hors de cette phase

- Les paiements (phase 5).
- L'export des données d'un utilisateur (droit d'accès), à prévoir dans une phase ultérieure.
- La double authentification de l'admin.
