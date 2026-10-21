# Admin — Offre

*Spec du 21 octobre 2026*, partie de la phase 4b (voir le [socle](2026-10-21-phase-4b-admin-socle-design.md)).

## 1. Rôle

Régler l'offre sans migration : prix affichés, quotas, fonctionnalités, nombre de photos et plafond de l'essai. Les changements s'appliquent tout de suite, car les droits sont relus en base à chaque requête (§5.3 de la spécification principale).

## 2. Contenu

Un tableau par plan : essai, Standard et Premium.

| Champ | Table | Règles |
|---|---|---|
| Prix mensuel et annuel (EUR, TTC) | `plan_prices` | entier en centimes, de 0 à 100 000 ; pas pour l'essai |
| Quota d'analyses (`full`) | `plan_quotas` | entier de 0 à 100 000 |
| Période du quota | `plans.quota_period` | lecture seule (`subscription_month` ou `lifetime`) |
| Plafond total | `plans.total_scan_cap` | entier de 0 à 100 000, ou vide (aucun plafond) |
| Photos par analyse | `plans.max_images` | entier de 0 à 4 (CHECK de la migration 0005) |
| Icônes sur les cartes | `plan_features` (`card_icons`) | case à cocher |
| Identifiant de prix Stripe | `plan_prices.stripe_price_id` | lecture seule (phase 5) |

## 3. Comportement

- **Modification :** un formulaire par plan, avec un bouton « Enregistrer ». Seuls les champs modifiés sont envoyés. Une confirmation résume les changements (« Quota Premium : 300 → 400 »).
- **Prix :** dans le MVP, le prix ne sert qu'à l'affichage (page des prix, phase 5 pour le paiement). Quand un `stripe_price_id` existe, un avertissement rappelle de créer le nouveau prix dans Stripe. Le prix stocké ne change pas ce que paie un abonné existant.
- **Effet immédiat :**
  - un quota baissé sous la consommation actuelle donne 0 restant, sans rien rembourser ni effacer ;
  - une fonctionnalité retirée est refusée dès la requête suivante (`403 feature_not_in_plan`).
- **Journal :** chaque champ modifié donne une ligne `admin_actions` (`offer.price_set`, `offer.quota_set`, `offer.feature_set`, `offer.max_images_set`, `offer.total_cap_set`), avec `{ plan, from, to }`. Toutes les lignes d'un enregistrement sont écrites dans la même transaction que les changements.
- **Historique :** les 20 dernières modifications de l'offre sous le tableau.

## 4. Page des prix du site

La page `/pricing` lit aujourd'hui des prix codés en dur. Dans cette phase, elle les lit au chargement de la page, par une nouvelle route publique `GET /api/offer` (prix, quotas, photos et fonctionnalités des plans payants, sans authentification, avec un cache HTTP de 5 min). Si la route ne répond pas, la page garde ses valeurs actuelles.

## 5. API

- `GET /api/admin/offer` : les plans avec tous les champs du §2 et l'historique.
- `PATCH /api/admin/offer/plans/{plan}` : les champs modifiés, par exemple `{ quota: 400, maxImages: 4, cardIcons: true, totalScanCap: null, prices: { month: 699, year: 6900 } }`.
- `GET /api/offer` (publique) : les données de la page des prix.

## 6. Tests

- **Bornes :** quota, prix, photos, plafond hors bornes donnent `422` ; prix sur l'essai donne `422`.
- **Effet immédiat :**
  - baisser le quota Premium donne 0 restant à un abonné qui l'a dépassé ;
  - retirer `card_icons` donne `403` sur un scan depuis une carte.
- **Journal :** une ligne par champ modifié, dans la même transaction.
- **`GET /api/offer` :** pas de données de l'essai sauf son quota, cache de 5 min, aucune authentification.
- **Page des prix :** elle affiche les valeurs de l'API, et ses valeurs par défaut si l'API ne répond pas.
- **Interface :** formulaire, confirmation récapitulative, avertissement Stripe.
