# Admin — Tableau de bord

*Spec du 21 octobre 2026*, partie de la phase 4b (voir le [socle](2026-10-21-phase-4b-admin-socle-design.md)).

## 1. Rôle

Montrer en un coup d'œil l'activité, les coûts et la santé du service. Écran d'accueil de l'admin. Lecture seule.

## 2. Contenu

**Bandeau du haut :** des cartes, chacune avec la valeur du jour et celle des 7 derniers jours.

| Carte | Calcul |
|---|---|
| Analyses | `scan_events` créés dans la période |
| Servies depuis le cache | part des analyses réussies servies depuis le cache partagé (`from_cache_expr`), en % |
| Échecs | part des `scan_events` qui ont un `scan_failures`, en %, avec les trois codes les plus fréquents |
| Coût IA | somme de `analyses.cost_usd_micros` des analyses **créées** dans la période, en dollars, sur 2 décimales |
| Coût moyen par analyse | coût IA divisé par le nombre d'analyses créées (appels au modèle) |
| Recherches web | nombre de lignes `analysis_web_searches` des analyses créées dans la période, et la moyenne par analyse |

**Abonnés actifs par plan :** essai, Standard et Premium (abonnements `active`), avec le nombre de nouveaux comptes dans les 7 derniers jours.

**Graphique des 30 derniers jours :** analyses par jour, en barres empilées (réussies servies depuis le cache, réussies avec un appel au modèle, en échec), avec le coût IA du jour en ligne.

**Mois en cours :** coût IA du mois civil, et projection linéaire sur le mois entier.

**Santé :**
- modèle actif et fournisseur du type `full` ;
- moteur de recherche (`SEARCH_BACKEND`) et sa disponibilité : un appel `GET /search?q=test&format=json` au moteur, avec un délai de 3 s, et le résultat gardé 60 s ;
- date de la dernière purge (§4 de la phase 4a), et le nombre d'événements supprimés.

## 3. Fuseau et périodes

Les jours sont des jours civils de Bruxelles (Europe/Brussels), comme `today` dans le prompt. « Aujourd'hui » va de minuit à maintenant, et « 7 jours » couvre les 7 jours civils qui finissent aujourd'hui.

## 4. API

- **`GET /api/admin/dashboard`** renvoie toutes les cartes, les abonnés et la santé en une seule réponse :
  `{ today: Stats, last7Days: Stats, subscribers: {...}, month: { costUsd, projectedUsd }, health: {...} }`.
- **`GET /api/admin/dashboard/daily?days=30`** renvoie un point par jour (`date`, `fromCache`, `llm`, `failed`, `costUsd`). `days` vaut entre 1 et 90.
- **Requêtes :** des agrégats SQL sur `scan_events`, `scan_results`, `scan_failures`, `analyses` et `analysis_web_searches`. Aucune donnée personnelle n'est renvoyée, seulement des nombres.
- **Dernière purge :** la purge de la phase 4a enregistre sa dernière passe dans une ligne de `admin_actions`, avec `action = 'system.purge'`, l'administrateur `NULL`, et `{ "deleted": n }` dans `details`.

## 5. Comportement

- Données rafraîchies à l'ouverture de l'écran, puis par un bouton « Actualiser ». Pas d'actualisation automatique.
- Les montants sont affichés en dollars, la devise des fournisseurs, avec le symbole `$`.
- Un moteur de recherche injoignable est affiché en orange, « Recherche indisponible ». Ce n'est pas une erreur de l'écran.

## 6. Tests

- Calculs sur un jeu de données fixe :
  - analyses du jour et sur 7 jours ;
  - part servie depuis le cache ;
  - part d'échecs et codes les plus fréquents ;
  - coût et coût moyen ;
  - recherches web.
- Limite d'un jour au fuseau de Bruxelles : une analyse à 23 h 30 UTC un 20 octobre compte pour le 21.
- `days` hors de 1 à 90 donne `422`.
- Santé : moteur joignable, en échec, et désactivé (`none`).
- Interface : cartes, graphique et bouton « Actualiser ».
