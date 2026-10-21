# Admin — Utilisateurs

*Spec du 21 octobre 2026*, partie de la phase 4b (voir le [socle](2026-10-21-phase-4b-admin-socle-design.md)).

## 1. Rôle

Retrouver un compte, voir son plan et sa consommation, et agir dessus : donner un plan, nommer ou retirer un admin, supprimer le compte.

## 2. Liste

- **Recherche par email** : un champ, une recherche sur le début ou une partie de l'email, sans tenir compte de la casse. Il faut au moins 3 caractères.
- **Sans recherche**, la liste montre les 50 derniers comptes créés, avec une pagination par curseur.
- **Colonnes :**
  - email ;
  - rôle (user, admin ; superuser hors production) ;
  - plan actif ou « aucun » ;
  - analyses utilisées et restantes sur la période ;
  - date de création ;
  - dernière analyse.
- **Filtres :** rôle et plan.

## 3. Fiche d'un utilisateur

- **Identité :** email, identifiant, date de création, email vérifié, rôle.
- **Abonnement actif :**
  - plan, statut, fournisseur (`manual` ou `stripe`) ;
  - début de période et fin éventuelle ;
  - consommation de la période (`compute_usage`), dont `purged_scans` pour l'essai.
- **Historique des abonnements** : tous les abonnements, du plus récent au plus ancien.
- **Activité :** les 20 derniers scans, comme `GET /api/scans/history` (date, site, titre, score, depuis le cache, en échec).
- **Journal :** les actions de l'admin qui visent ce compte (`admin_actions.target_user_id`).

## 4. Actions

| Action | Effet | Garde-fous |
|---|---|---|
| **Attribuer un plan** | Termine l'abonnement actif (`status = 'expired'`, statut existant de `subscription_statuses`, `period_end = now()`), puis crée un abonnement `active` du plan choisi, `provider = 'manual'`, `period_start = now()`. La consommation repart de zéro pour un plan mensuel. | Confirmation qui rappelle le plan actuel. Refusé (`409`) si l'abonnement actif vient de Stripe : on le gère dans Stripe (phase 5). |
| **Nommer admin / retirer le rôle** | Modifie `auth.user.role` (`admin` ou `user`). | Pas sur soi-même. Pas de retrait du dernier admin (`409 conflict`). Le rôle `superuser` n'est jamais attribué depuis l'admin. |
| **Supprimer le compte** | Même effet que `DELETE /api/me` (phase 4a) : suppression en cascade. La ligne `admin_actions` garde l'identifiant visé, pas l'email. | Confirmation par la saisie de l'email du compte. Pas sur soi-même (`409`). |

Chaque action écrit sa ligne `admin_actions` (`user.plan_set`, `user.role_set`, `user.deleted`) dans la même transaction.

## 5. API

- `GET /api/admin/users?q=&role=&plan=&before=&limit=` : la liste. `q` contient au moins 3 caractères quand il est présent.
- `GET /api/admin/users/{id}` : la fiche, avec l'abonnement actif, la consommation, l'historique des abonnements, les 20 derniers scans et le journal.
- `POST /api/admin/users/{id}/plan` `{ plan }` : attribue un plan.
- `POST /api/admin/users/{id}/role` `{ role: "admin" | "user" }` : nomme ou retire un admin.
- `DELETE /api/admin/users/{id}` : supprime le compte.

## 6. Données personnelles

- L'email n'apparaît que dans l'interface de l'admin et dans les réponses de ces routes, jamais dans les journaux de l'API ni dans `admin_actions`.
- La recherche par email n'est pas journalisée.

## 7. Tests

- **Recherche :**
  - casse ignorée, partie de l'email ;
  - moins de 3 caractères donne `422` ;
  - filtres et pagination.
- **Fiche :** consommation identique à `GET /api/me` pour le même compte, `purged_scans` compris.
- **Plan :**
  - l'ancien abonnement est terminé et le nouveau est actif ;
  - la consommation mensuelle repart ;
  - `409` sur un abonnement Stripe ;
  - plan inconnu donne `422`.
- **Rôle :**
  - nommer et retirer un admin ;
  - `409` sur soi-même et sur le dernier admin ;
  - `superuser` refusé.
- **Suppression :**
  - cascade identique à la phase 4a ;
  - `409` sur soi-même ;
  - `admin_actions` garde l'identifiant après la suppression.
- **Journal :** chaque action écrit sa ligne, et une erreur annule l'action et sa trace.
- **Interface :** recherche, fiche, confirmations (saisie de l'email pour la suppression).
