# Admin — Tableau de bord

*Spec du 21 octobre 2026*, partie de la phase 4b (voir le [socle](2026-10-21-phase-4b-admin-socle-design.md)).

## 1. Rôle

Montrer en un coup d'œil l'activité, les coûts et la santé du service. Écran d'accueil de l'admin. Lecture seule.

## 2. Contenu

**Bandeau du haut :** des cartes, chacune avec la valeur du jour et celle des 7 derniers jours.

| Carte | Calcul |
|---|---|
| Analyses | `scan_events` créés dans la période |
| Appels au modèle | lignes `llm_calls` de la période (socle §5 bis) |
| Servies depuis le cache | scans réussis (avec `scan_results`) moins appels au modèle, rapporté aux scans réussis, en % (borné à 0) |
| Échecs | part des `scan_events` qui ont un `scan_failures`, en %, avec les trois codes les plus fréquents |
| Coût IA | somme de `llm_calls.cost_usd_micros` de la période, en dollars, sur 2 décimales |
| Coût moyen par appel | coût IA divisé par le nombre d'appels au modèle |
| Recherches web | somme de `llm_calls.web_searches` de la période, et la moyenne par appel |

Ces calculs ne lisent ni `analyses.cost_usd_micros` ni `from_cache_expr` : un rafraîchissement sur place écrase le coût et la date d'une analyse (socle §5 bis). Un scan servi par l'analyse d'un autre scan en cours (course sur le verrou) compte comme servi depuis le cache, puisqu'il n'a pas fait d'appel.

**Abonnés actifs par plan :** essai, Standard et Premium (abonnements `active`), avec le nombre de nouveaux comptes dans les 7 derniers jours.

**Graphique des 30 derniers jours :** analyses par jour, en barres empilées (réussies servies depuis le cache, réussies avec un appel au modèle, en échec), avec le coût IA du jour en ligne. Les mêmes règles que les cartes : appels et coût viennent de `llm_calls`, « depuis le cache » est la différence.

**Mois en cours :** coût IA du mois civil, et projection linéaire sur le mois entier.

**Santé :**
- modèle actif et fournisseur du type `full` ;
- moteur de recherche (`SEARCH_BACKEND`) et sa disponibilité, selon la vérification du socle (§6) ;
- date de la dernière purge (§4 de la phase 4a), et le nombre d'événements supprimés.

## 3. Fuseau et périodes

Les jours sont des jours civils de Bruxelles (Europe/Brussels), comme `today` dans le prompt. « Aujourd'hui » va de minuit à maintenant, et « 7 jours » couvre les 7 jours civils qui finissent aujourd'hui.

## 4. API

- **`GET /api/admin/dashboard`** renvoie toutes les cartes, les abonnés et la santé en une seule réponse :
  `{ today: Stats, last7Days: Stats, subscribers: {...}, month: { costUsd, projectedUsd }, health: {...} }`.
- **`GET /api/admin/dashboard/daily?days=30`** renvoie un point par jour (`date`, `fromCache`, `llm`, `failed`, `costUsd`). `days` vaut entre 1 et 90.
- **`Stats`** : `{ scans, llmCalls, fromCachePct, failedPct, topFailures: [{ code, count }], costUsd, avgCostUsd, webSearches, avgWebSearches }`.
- **Requêtes :** des agrégats SQL sur `scan_events`, `scan_results`, `scan_failures` et `llm_calls`. Aucune donnée personnelle n'est renvoyée, seulement des nombres.
- **Dernière purge :** la dernière ligne `system.purge` de `admin_actions` (socle §5), avec sa date et `deletedScans`.

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
- Rafraîchissement : une analyse appelée le 18, servie le 19 et rafraîchie le 20 donne un appel et son coût le 18, un scan servi depuis le cache le 19, un appel et son coût le 20.
- Limite d'un jour au fuseau de Bruxelles : une analyse à 23 h 30 UTC un 20 octobre compte pour le 21.
- `days` hors de 1 à 90 donne `422`.
- Santé : moteur joignable, en échec, et désactivé (`none`) ; dernière purge lue dans `system.purge`.
- Interface : cartes, graphique et bouton « Actualiser ».
