# Phase 4b, partie 2 — Admin : Tableau de bord, Offre et Analyses : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** l'admin a ses trois derniers écrans : le Tableau de bord (activité, coûts, cache, échecs, abonnés, santé), l'Offre (prix, quotas, photos, icônes, plafond, avec la page `/pricing` du site qui lit l'offre en base) et les Analyses (liste filtrée et détail), et les durcissements demandés par la relecture finale de la partie 1.

**Architecture :**
- **API :** trois routeurs en lecture (`/api/admin/dashboard`, `/api/admin/analyses`) ou en écriture (`/api/admin/offer`, journalisé dans `admin_actions`), une route publique `GET /api/offer`, une migration 0008 (`listings.url`) pour le lien vers l'annonce. Les statistiques lisent `llm_calls` (partie 1), jamais `analyses.cost_usd_micros` ni `from_cache_expr`.
- **Site :** `/pricing` réécrite sur l'offre `full`, avec des valeurs de secours et la lecture de `GET /api/offer`.
- **Admin :** composants partagés (fin des duplications), boîte de confirmation vraiment modale, routes et barre latérale à cinq entrées, trois écrans, graphique en SVG sans dépendance.

**Tech Stack :** FastAPI, SQLAlchemy async, Alembic, Vite 8, React 19, Tailwind 4, Vitest et Testing Library.

**Spec :**
- `docs/superpowers/specs/2026-10-21-phase-4b-admin-tableau-de-bord-design.md` ;
- `docs/superpowers/specs/2026-10-21-phase-4b-admin-offre-design.md` ;
- `docs/superpowers/specs/2026-10-21-phase-4b-admin-analyses-design.md` ;
- le [socle](../specs/2026-10-21-phase-4b-admin-socle-design.md) (journal, conventions, `llm_calls`, vérification du moteur).

La partie 1 (`docs/superpowers/plans/2026-10-21-phase-4b-partie-1-socle-utilisateurs-ia.md`) est livrée ; ce plan s'appuie sur son code.

## Global Constraints

**Git et fichiers locaux :**
- Branche `feat/phase-4b-2`, au-dessus de `feat/phase-4b` (partie 1, PR ouverte). Après la fusion de la partie 1 dans `main` (par rebase), la branche est rebasée sur `origin/main` avant d'être poussée. Pas de push sans demande.
- Chaque commit porte le trailer `Co-Authored-By` de la session du modèle qui l'écrit.
- Ne jamais toucher : `video/`, `.DS_Store`, `services/api/tests/.conftest.py.swp`, `docs/superpowers/plans/.Rhistory`.
- `web-pages/` n'est jamais lu ; `infra/.env` n'est jamais affiché.
- Aucun email réel, aucune clé, aucun jeton. Emails de test en `@radarnaque.test`.
- Docker de dev : seule `docker compose -f infra/docker-compose.dev.yml up -d --no-deps --force-recreate caddy` est permise si Caddy doit être rechargé ; jamais `down`, `rm`, `-v`.

**Langue :** code, commentaires, messages, interface de l'admin et docs en français, dans le style des fichiers voisins. La page `/pricing` est en FR et en NL.

**Valeurs fixées par le spec :**

| Élément | Valeur |
|---|---|
| Fuseau | `Europe/Brussels` ; « aujourd'hui » = minuit civil → maintenant ; « 7 jours » = les 7 jours civils qui finissent aujourd'hui |
| Série quotidienne | `days` de 1 à 90 (30 par défaut), un point par jour civil, jours vides compris, du plus ancien au plus récent |
| Échec | un `scan_events` avec `scan_failures` et **sans** `scan_results` (règle R13, comme l'historique) : ainsi « depuis le cache + appel + échec = analyses » |
| Servies depuis le cache | `max(0, réussis − appels) / réussis × 100` ; `null` sans scan réussi |
| Coûts | `llm_calls.cost_usd_micros / 1 000 000` ; affichés `$` à 2 décimales, le coût moyen par appel à 4 |
| Projection du mois | `coût du mois × (durée du mois / durée écoulée)` ; `null` pendant les premières 24 h du mois |
| Offre, bornes | prix en centimes 0–100 000 (pas pour l'essai) ; quota `full` 0–100 000 ; plafond total 0–100 000 ou `null` ; photos 0–4 |
| Codes d'action de l'offre | `offer.price_set`, `offer.quota_set`, `offer.feature_set`, `offer.max_images_set`, `offer.total_cap_set` ; une ligne par champ modifié |
| `details` de l'offre | `{ plan, from, to }`, plus `interval` (`month`/`year`) pour un prix et `feature` (`card_icons`) pour une fonctionnalité |
| `GET /api/offer` | publique, `Cache-Control: public, max-age=300`, aucun `stripe_price_id`, pas de prix pour l'essai |
| Analyses | 50 par page au plus, curseur `before` ; recherche dans le titre ≥ 3 caractères, casse ignorée ; niveau : `low` 0–29, `medium` 30–59, `high` ≥ 60 |
| Données personnelles | aucune réponse du Tableau de bord ni des Analyses ne contient d'email ni d'identifiant d'utilisateur |
| Erreurs | celles du socle : `404 not_found`, `409 conflict`, `422 invalid_value` (métier), `422 invalid_request` (validation) |

**Commandes :**
- API : `cd services/api && uv run pytest -q && uv run ruff check . && uv run ruff format --check .` ;
- contrat : `pnpm check:api`, régénéré par `pnpm gen:api` ;
- site : `pnpm --filter site test && pnpm --filter site typecheck && pnpm --filter site build` ;
- admin : `pnpm --filter admin test && pnpm --filter admin typecheck && pnpm --filter admin build` ;
- racine : `pnpm lint`, puis `pnpm test:all` à la fin.

## Review Focus

1. **Une période sans scan** (aujourd'hui à 00 h 05, ou une base vide) : cartes à 0, parts et moyennes à `null` affichées « — », aucune division par zéro, graphique avec des jours à zéro. Tests en tâches 3 et 7.
2. **Le changement d'heure** (le 25 octobre 2026 dure 25 h à Bruxelles) : un scan à `2026-10-24T22:30Z` compte pour le 25 ; la série quotidienne qui couvre le 25 a des dates contiguës, sans doublon ni trou. Test en tâche 3.
3. **Un enregistrement de l'offre sans changement réel** (valeurs identiques renvoyées) : `200`, aucune ligne de journal ; un plan inconnu donne `404` sans rien écrire. Test en tâche 2.
4. **`GET /api/offer` en panne ou qui renvoie un JSON inattendu** : la page des prix garde ses valeurs de secours et reste lisible ; un plan à 0 photo affiche « Pas de photo analysée » au lieu de « 0 photo ». Test en tâche 5.
5. **Une analyse ancienne sans URL** (antérieure à la migration 0008), sans prix ni photo : le détail s'affiche sans lien ni ligne vide ; `from` postérieur à `to` dans les filtres donne `422`. Tests en tâches 4 et 9.

---

### Tâche 1 : durcissements de l'API (relecture finale de la partie 1)

**Fichiers :**
- Modifier :
  - `services/api/src/radarnaque_api/errors.py` (gestionnaire de `sqlalchemy.exc.DataError`) ;
  - `services/api/src/radarnaque_api/services/admin_users.py` (`details.reason` des 409) ;
  - `services/api/src/radarnaque_api/services/admin_log.py` (codes `offer.*` dans `AdminActionCode`).
- Tests : `services/api/tests/test_health_errors.py`, `tests/test_admin_users.py`.

**Interfaces :**
- Fournit :
  - un gestionnaire `DataError` → `422 invalid_request`, message « Requête invalide. », `details: {}` (jamais la valeur reçue, jamais le texte de Postgres) ;
  - les 409 de l'écran Utilisateurs portent `details.reason` : `"self"` (soi-même, rôle ou suppression), `"last_admin"`, `"stripe"` ;
  - `AdminActionCode` inclut les cinq codes `offer.*` du tableau des valeurs.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `test_nul_character_is_422` : `POST /api/admin/ai/models` avec un slug contenant `\u0000` et `GET /api/admin/users?q=ab%00c` → `422 invalid_request`, et la réponse ne contient ni le slug ni le mot `DataError`.
  - `test_conflict_reasons` : rôle sur soi → `details.reason == "self"` ; dernier admin → `"last_admin"` ; plan sur un abonnement Stripe → `"stripe"` ; suppression de soi → `"self"`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter,** puis `pnpm gen:api`.
- [ ] **Étape 4 : vérifier.** Commandes de l'API et `pnpm check:api`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `fix(api): caractère NUL en 422, raison des 409 de l'admin, codes d'action de l'offre`.

### Tâche 2 : API Offre (admin et publique)

**Fichiers :**
- Créer :
  - `services/api/src/radarnaque_api/services/admin_offer.py`
  - `services/api/src/radarnaque_api/routes/admin_offer.py`
  - `services/api/src/radarnaque_api/routes/offer.py` (route publique)
  - `services/api/tests/test_admin_offer.py`
- Modifier : `admin_schemas.py`, `main.py` (deux routeurs), contrat régénéré.

**Interfaces :**
- Utilise : `require_admin`, `record_action`, `recent_actions(prefix="offer.")` ; les modèles `Plan`, `PlanPrice`, `PlanQuota`, `PlanFeature`.
- Fournit (schémas dans `admin_schemas.py`) :
  - `OfferPriceOut` : `amount_cents: int`, `stripe_price_id: str | None` ;
  - `OfferPlanOut` : `code`, `quota_period`, `quota: int`, `total_scan_cap: int | None`, `max_images: int`, `card_icons: bool`, `prices: dict[Literal["month", "year"], OfferPriceOut]` (vide pour l'essai) ;
  - `AdminOfferOut` : `plans: list[OfferPlanOut]` (ordre `trial`, `standard`, `premium`), `actions: list[AdminActionOut]` (20 dernières `offer.*`) ;
  - `OfferPricesIn` : `month: int | None`, `year: int | None` (0–100 000) ; `OfferPlanIn` (`CamelInModel`) : `quota`, `total_scan_cap`, `max_images` (0–4), `card_icons`, `prices`, tous optionnels ; `total_scan_cap: null` explicite vide le plafond (distinguer absent et `null` par `model_fields_set`) ;
  - `PublicPlanOut` : `scans: int`, `max_images: int`, `card_icons: bool`, `monthly_cents: int | None`, `yearly_cents: int | None` ; `PublicOfferOut` : `trial`, `standard`, `premium` (`PublicPlanOut`).
- Routes : `GET /api/admin/offer`, `PATCH /api/admin/offer/plans/{plan}` (renvoie `AdminOfferOut` à jour), `GET /api/offer` (sans authentification, en-tête `Cache-Control: public, max-age=300`).
- **Règles du PATCH :** plan absent → 404 ; `prices` sur `trial` → `422 invalid_value` ; verrou `FOR NO KEY UPDATE` sur la ligne `plans` du plan ; quota et prix en upsert (`plan_quotas(plan, 'full')`, `plan_prices(plan, interval, 'EUR')`) ; `card_icons` ajoute ou retire la ligne `plan_features` ; une ligne `record_action` par champ réellement changé, après les contrôles, juste avant le commit ; aucun changement → 200 sans ligne.
- `GET /api/offer` : `scans` = quota `full` du plan ; prix absents → `null`.

- [ ] **Étape 1 : écrire les tests qui échouent** (spec Offre §6, plus) :
  - `test_offer_overview` : trois plans dans l'ordre, valeurs de la base (150/300, photos 1/4, icônes essai et Premium), l'essai sans prix ;
  - `test_offer_bounds` (quota 100 001, prix −1, photos 5, plafond 100 001 → 422) ; `test_price_on_trial_is_422` ; `test_unknown_plan_is_404` (point 3 de Review Focus : aucune ligne écrite) ;
  - `test_offer_journal_one_line_per_field` (quota et deux prix changés → 3 lignes, `details` avec `interval` pour les prix) ; `test_offer_same_values_write_nothing` (point 3) ; `test_offer_failure_leaves_no_trace` (erreur provoquée après `record_action` : ni changement ni ligne) ;
  - `test_lower_quota_gives_zero_remaining` (abonné Premium à 310 scans, quota passé à 300 → `GET /api/me` donne 0 restant) ;
  - `test_removing_card_icons_refuses_card_scan` (403 `feature_not_in_plan` sur un scan `trigger: "card"`) ;
  - `test_total_cap_null_clears_cap` ;
  - `test_public_offer` : sans JWT, `Cache-Control: public, max-age=300`, aucun `stripe_price_id` ni `stripePriceId` dans le corps, essai sans prix ;
  - `test_offer_routes_need_admin`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter,** puis `pnpm gen:api`.
- [ ] **Étape 4 : vérifier.** Commandes de l'API et `pnpm check:api`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): admin, offre (prix, quotas, photos, icônes, plafond) et GET /api/offer publique`.

### Tâche 3 : API Tableau de bord

**Fichiers :**
- Créer :
  - `services/api/src/radarnaque_api/services/dashboard.py`
  - `services/api/src/radarnaque_api/routes/admin_dashboard.py`
  - `services/api/tests/test_dashboard.py`
- Modifier : `admin_schemas.py`, `main.py`, contrat régénéré.

**Interfaces :**
- Utilise : `llm_calls`, `scan_events`, `scan_results`, `scan_failures`, `subscriptions`, `auth.user."createdAt"`, `admin_actions` (`system.purge`) ; `search_status(settings, health, search)` de `services/admin_ai.py`.
- Fournit :

```python
BRUSSELS = ZoneInfo("Europe/Brussels")
async def dashboard(session: AsyncSession, now: datetime, *, settings: Settings,
                    health: SearchHealth | None, search: SearchBackend | None) -> DashboardOut
async def daily(session: AsyncSession, now: datetime, days: int) -> DailyOut
```

- Schémas :
  - `TopFailureOut` : `code`, `count` ;
  - `DashboardStatsOut` : `scans`, `llm_calls`, `from_cache_pct: float | None`, `failed_pct: float | None`, `top_failures: list[TopFailureOut]` (3 au plus), `cost_usd: float`, `avg_cost_usd: float | None`, `web_searches: int`, `avg_web_searches: float | None` ;
  - `SubscribersOut` : `trial`, `standard`, `premium` (abonnements `active`), `new_accounts_7_days` ;
  - `MonthCostOut` : `cost_usd`, `projected_usd: float | None` ;
  - `ActiveModelOut` : `provider`, `slug` ; `LastPurgeOut` : `at`, `deleted_scans` ;
  - `DashboardHealthOut` : `active_model: ActiveModelOut | None`, `search: SearchStatusOut`, `last_purge: LastPurgeOut | None` ;
  - `DashboardOut` : `today`, `last_7_days`, `subscribers`, `month`, `health` ;
  - `DailyPointOut` : `date: date`, `from_cache`, `llm`, `failed`, `cost_usd` ; `DailyOut` : `points`.
- Routes : `GET /api/admin/dashboard`, `GET /api/admin/dashboard/daily?days=30` (`days` 1–90, sinon 422). Les routes passent `datetime.now(UTC)` ; les tests appellent les fonctions du service avec un `now` fixe.
- Jour civil d'un instant : `(created_at AT TIME ZONE 'Europe/Brussels')::date` en SQL ; bornes des périodes calculées en Python avec `BRUSSELS` puis converties en UTC.

- [ ] **Étape 1 : écrire les tests qui échouent** (spec Tableau de bord §6, sur un jeu fixe) :
  - `test_stats_today_and_7_days` : scans, appels, part du cache, échecs (un événement avec échec **et** résultat compte comme réussi), trois codes les plus fréquents, coût, coût moyen, recherches et moyenne ;
  - `test_refresh_counts_two_calls` : analyse appelée le 18, servie le 19, rafraîchie le 20 → le 18 un appel et son coût, le 19 un scan servi depuis le cache, le 20 un appel et son coût ;
  - `test_brussels_day_boundary` : un scan à `2026-10-20T23:30Z` compte pour le 21 ;
  - `test_dst_day` (point 2 de Review Focus) : un scan à `2026-10-24T22:30Z` compte pour le 25 ; `daily(now=2026-10-27T10:00Z, days=5)` donne les dates du 23 au 27, contiguës, sans doublon ;
  - `test_empty_period` (point 1) : base vide → zéros, `from_cache_pct`, `failed_pct`, `avg_*` à `None`, `daily(…, 30)` donne 30 points à zéro ;
  - `test_month_projection` : coût du mois et projection ; `projected_usd is None` à `2026-11-01T05:00Z` ;
  - `test_subscribers` (abonnements actifs par plan, comptes créés dans les 7 jours civils) ;
  - `test_health` : modèle actif, moteur `ok`/`down`/`disabled`, dernière `system.purge` (`at`, `deletedScans`), `None` sans purge ;
  - `test_days_bounds` (0 et 91 → 422) ; `test_dashboard_has_no_account_data` (ni email ni identifiant d'utilisateur dans le JSON) ; `test_dashboard_routes_need_admin`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter,** puis `pnpm gen:api`.
- [ ] **Étape 4 : vérifier.** Commandes de l'API et `pnpm check:api`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): admin, tableau de bord (activité, coûts sur llm_calls, cache, échecs, abonnés, santé)`.

### Tâche 4 : API Analyses et URL de l'annonce

**Fichiers :**
- Créer :
  - `services/api/alembic/versions/0008_listing_url.py`
  - `services/api/src/radarnaque_api/services/admin_analyses.py`
  - `services/api/src/radarnaque_api/routes/admin_analyses.py`
  - `services/api/tests/test_admin_analyses.py`
  - `services/api/tests/test_migration_0008.py`
- Modifier :
  - `services/api/src/radarnaque_api/models/listings.py` (`Listing.url: Mapped[str | None]`) ;
  - `services/api/src/radarnaque_api/services/scan_store.py` (`upsert_snapshot` écrit l'URL) ;
  - `admin_schemas.py`, `main.py`, contrat régénéré.

**Interfaces :**
- Migration 0008 : `listings.url TEXT NULL` ; descente : suppression de la colonne. Les annonces existantes gardent `NULL`.
- `upsert_snapshot` : l'URL stockée est `scheme://host/path` de `listing.url` (sans query ni fragment, qui peuvent porter des traceurs) ; l'insertion devient `ON CONFLICT (site_id, external_id) DO UPDATE SET url = excluded.url`.
- Fournit :
  - `AnalysisRowOut` : `id`, `created_at`, `site`, `title`, `score`, `level`, `professional`, `model_id: int`, `model: ActiveModelOut` (fournisseur et slug, tâche 3), `prompt_version_id: int`, `prompt_version: int` (numéro), `images_analyzed`, `web_searches: int`, `cost_usd: float` (somme de `llm_calls`), `llm_calls: int`, `served: int` (`scan_results`), `partial: bool` ; `AnalysisListOut` : `items`, `next_before: int | None` ;
  - `AnalysisDetailOut` : `listing` (`site`, `external_id`, `url: str | None`, `title`, `description`, `price_cents: int | None`, `currency: str | None`, `images: list[str]`, `captured_at`), `result` (`score`, `level`, `professional`, `texts: dict[Locale, {summary, advice}]`, `reasons: list[{position, severity, fr, nl}]`), `searches: list[{position, query, aspect}]`, `technical` (`model`, `prompt_version_id`, `prompt_version`, `tokens_in`, `tokens_out`, `cost_usd` du dernier appel, `images_analyzed`, `input_hash`, `created_at`, `calls: list[{created_at, tokens_in, tokens_out, cost_usd, images_analyzed, web_searches}]` du plus récent au plus ancien), `usage` (`served`, `first_served_at`, `last_served_at`).
- Routes : `GET /api/admin/analyses?site=&level=&modelId=&promptVersionId=&from=&to=&withSearch=&partial=&q=&before=&limit=` et `GET /api/admin/analyses/{id}` (404 si absente). `from`/`to` : dates `YYYY-MM-DD`, jours civils de Bruxelles inclus ; `from > to` → `422 invalid_value`. Tri `(created_at desc, id desc)`, `before` = identifiant de la dernière analyse de la page précédente (relue pour sa date). `q` échappé comme la recherche d'utilisateurs. Aucune écriture, aucune ligne `admin_actions`.

- [ ] **Étape 1 : écrire les tests qui échouent** (spec Analyses §6, plus) :
  - `test_migration_0008` (colonne nullable, descente) ; `test_scan_stores_listing_url_without_query` (`https://www.2ememain.be/v/a/b/m123-velo?utm=x#y` → `https://www.2ememain.be/v/a/b/m123-velo`, mis à jour au scan suivant) ;
  - `test_list_filters` (chaque filtre seul, puis combinés) ; `test_list_pagination` (55 analyses) ; `test_title_search_under_3_chars_is_422` ; `test_from_after_to_is_422` (point 5) ;
  - `test_served_count` ; `test_refreshed_analysis_lists_two_calls` (coût total = somme) ;
  - `test_detail_texts_reasons_searches_in_order` ; `test_detail_cost_and_tokens` ;
  - `test_old_analysis_without_url_price_or_images` (point 5 : `url is None`, `price_cents is None`, `images == []`) ;
  - `test_no_account_data` (ni email ni identifiant d'utilisateur dans la liste et le détail) ; `test_unknown_analysis_is_404` ; `test_analyses_routes_need_admin`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter,** puis `pnpm gen:api`.
- [ ] **Étape 4 : vérifier.** Commandes de l'API et `pnpm check:api`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(api): admin, analyses (liste filtrée, détail) et URL de l'annonce (migration 0008)`.

### Tâche 5 : page `/pricing` sur l'offre actuelle

**Fichiers :**
- Créer : `apps/site/src/offer.ts`, `apps/site/test/offer.test.ts`.
- Modifier : `apps/site/src/pages-i18n.ts` (`PLANS`, textes de `PRICING`), `apps/site/src/pages-render.ts` (`renderPricing`), `apps/site/src/pricing.ts`, `apps/site/test/pages-i18n.test.ts`.

**Interfaces :**
- Utilise : `GET /api/offer` (tâche 2), même origine.
- Fournit :

```ts
export interface OfferPlan { scans: number; maxImages: number; cardIcons: boolean; monthlyCents: number | null; yearlyCents: number | null }
export type Offer = { trial: OfferPlan; standard: OfferPlan; premium: OfferPlan };
export const PLANS: Offer; // secours : trial 3 analyses, 4 photos, icônes ; standard 299/2900, 150, 1 photo, sans icônes ; premium 699/6900, 300, 4 photos, icônes
export function parseOffer(body: unknown): Offer | null; // null si la forme ne correspond pas
export async function fetchOffer(fetchImpl?: typeof fetch): Promise<Offer | null>; // null sur erreur réseau, statut ≠ 200 ou forme inattendue
export function renderPricing(doc: Document, root: HTMLElement, locale: Locale, offer?: Offer): void; // offer = PLANS par défaut
```

- `pricing.ts` rend tout de suite avec `PLANS`, puis rend à nouveau avec l'offre de l'API si `fetchOffer` réussit.
- **Lignes de chaque carte** (les trois plans ont la même structure ; `features` du type `PlanText` devient ces clés) :

| Clé | FR | NL |
|---|---|---|
| `scansTotal` (essai) | `{scans} analyses offertes au total` | `{scans} gratis analyses in totaal` |
| `scansMonth` (Standard, Premium) | `{scans} analyses par mois` | `{scans} analyses per maand` |
| `photosNone` | `Pas de photo analysée` | `Geen foto's geanalyseerd` |
| `photosOne` | `1 photo analysée par annonce` | `1 foto geanalyseerd per advertentie` |
| `photosMany` | `Jusqu'à {photos} photos analysées par annonce` | `Tot {photos} foto's geanalyseerd per advertentie` |
| `button` | (texte actuel) | (texte actuel) |
| `icons` | (texte actuel), seulement si `cardIcons` | (texte actuel), seulement si `cardIcons` |

  L'ancien `all` (« Toutes les fonctionnalités ») et les textes `texts` et `photos` disparaissent.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `PLANS` reprend l'offre de secours exacte ;
  - `parseOffer` refuse un JSON incomplet, un nombre négatif ou un type faux ;
  - `fetchOffer` renvoie `null` sur rejet réseau, 500 et corps invalide (point 4 de Review Focus) ;
  - `renderPricing` avec une offre de l'API (quota Premium 400) affiche « 400 analyses par mois » ; sans icônes sur Premium, la ligne disparaît ; 0 photo → « Pas de photo analysée » ; 1 → « 1 photo… » ; 4 → « Jusqu'à 4 photos… » ;
  - aucun texte « analyses de texte », « analyses avec photos », « tekstanalyses » ni « met foto's per maand » dans `PRICING` ;
  - les dictionnaires FR et NL ont toujours le même arbre de clés.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier.** Commandes du site et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(site): page /pricing sur l'offre actuelle, lue par GET /api/offer avec valeurs de secours`.

### Tâche 6 : admin, socle d'interface de la partie 2

**Fichiers :**
- Créer :
  - `apps/admin/src/components/ui.tsx` (`Section`, `Term`, `ErrorLine`, classes `primaryButton`, `secondaryButton`, `dangerButton`, `field`, `actionMessage`) ;
  - `apps/admin/src/components/Link.tsx` ;
  - `apps/admin/src/plans.ts` (`usePlans`) ;
  - `apps/admin/test/ui.test.tsx`.
- Modifier :
  - `apps/admin/src/router.ts` (nouvelles routes), `src/App.tsx` (barre latérale à cinq entrées, titres) ;
  - `src/components/ConfirmDialog.tsx` (vraie modale) ;
  - `src/components/ActionLog.tsx` (libellés `offer.*`) ;
  - `src/format.ts` (`formatUsd`) ;
  - `src/pages/UserCard.tsx`, `src/pages/Users.tsx`, `src/pages/ai/*.tsx` (passent aux composants partagés, `Link`, `usePlans`, et `actionMessage` lit `details.reason`) ;
  - `apps/admin/test/router.test.ts` et les tests existants touchés.

**Interfaces :**
- Utilise : `details.reason` des 409 (tâche 1), `GET /api/admin/offer` (tâche 2) pour la liste des plans.
- Fournit :

```ts
export type Route =
	| { name: "dashboard" }            // /admin/ et /admin (écran d'accueil)
	| { name: "users" } | { name: "user"; id: string }
	| { name: "offer" }                // /admin/offre
	| { name: "ai"; promptId?: number } // /admin/ia, /admin/ia/prompts/{id}
	| { name: "analyses" } | { name: "analysis"; id: number } // /admin/analyses, /admin/analyses/{id}
	| { name: "notFound" };
export function Link(props: { route: Route; className?: string; children: ReactNode }): JSX.Element; // href + clic simple → navigate
export function usePlans(): string[] | null; // codes des plans depuis GET /api/admin/offer, null pendant le chargement
export function formatUsd(value: number | null, decimals?: 2 | 4): string; // "—" pour null
export function actionMessage(error: unknown): string;
// 409 reason "last_admin" → « Impossible : c'est le dernier admin. » ; "self" → « Impossible sur votre propre compte. » ;
// "stripe" → « Géré dans Stripe. » ; 429 → « Trop de demandes, réessayez plus tard. » ; autre → message de l'API ou « L'action a échoué, réessayez. »
```

- **Barre latérale :** « Tableau de bord », « Utilisateurs », « Offre », « IA », « Analyses ». Les routes `dashboard`, `offer`, `analyses`, `analysis` affichent un contenu vide jusqu'aux tâches 7 à 9.
- **`navigate`** ne pousse pas d'entrée d'historique si l'URL est déjà la courante.
- **`ConfirmDialog` :** à l'ouverture, le focus va au champ de saisie s'il existe, sinon au bouton « Annuler » ; Échap ferme (écouté sur `document`) ; Tab et Maj+Tab restent dans la boîte ; à la fermeture, le focus revient à l'élément qui l'avait. La branche d'échec interne inutilisée est retirée.
- `ai/Prompts.tsx` ouvre la consultation de la version `promptId` quand la route le donne.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `parseRoute`/`hrefOf` pour chaque nouvelle route, aller-retour stable ; `/admin/ia/prompts/abc` → `notFound` ;
  - `navigate to the current route does not push history` ;
  - `confirm dialog focuses cancel, closes on Escape and restores focus` ; `tab stays inside the dialog` ;
  - `actionMessage reads details.reason` (les trois raisons et le 429) ;
  - `user card plan menu comes from the API plans` ;
  - `ai screen opens the prompt given by the route` ;
  - les tests existants de Users, UserCard et IA passent sans changement de comportement.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.** Aucune duplication de `Section`, `secondaryButton` ni `actionMessage` ne doit rester.
- [ ] **Étape 4 : vérifier.** Commandes de l'admin et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `refactor(admin): composants partagés, boîte de confirmation modale, routes et navigation de la partie 2`.

### Tâche 7 : écran Tableau de bord

**Fichiers :**
- Créer : `apps/admin/src/pages/Dashboard.tsx`, `src/components/DailyChart.tsx`, `apps/admin/test/dashboard.test.tsx`.
- Modifier : `src/App.tsx` (route `dashboard`).

**Interfaces :**
- Utilise : `GET /api/admin/dashboard`, `GET /api/admin/dashboard/daily?days=30` (tâche 3), `formatUsd`, `Section`.
- Fournit : `DailyChart(props: { points: DailyPointOut[] }): JSX.Element` — SVG fait main, sans dépendance : une barre empilée par jour (depuis le cache, avec appel, en échec), le coût du jour en ligne sur un axe à droite, une légende, un `<title>` par barre (« 21/10 : 12 cache, 4 appels, 1 échec, 0,42 $ »).
- **Contenu (spec §2) :**
  - cartes « Analyses », « Appels au modèle », « Servies depuis le cache », « Échecs » (avec les trois codes), « Coût IA », « Coût moyen par appel », « Recherches web » : valeur du jour et des 7 jours ; `null` → « — » ;
  - abonnés actifs par plan et nouveaux comptes sur 7 jours ;
  - mois en cours : coût et projection (« — » si `null`) ;
  - santé : modèle actif, moteur (`ok` vert « Recherche disponible », `down` orange « Recherche indisponible », `disabled` gris « Recherche désactivée »), dernière purge (date et nombre d'événements, « Aucune purge » sinon).
- Chargement à l'ouverture, bouton « Actualiser » (désactivé pendant le chargement), pas d'actualisation automatique. Une erreur de chargement affiche « Impossible de charger le tableau de bord. » avec un bouton « Réessayer ».

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `cards show today and 7 days` (dont `$` à 2 décimales et le coût moyen à 4) ;
  - `empty values show a dash` (point 1 de Review Focus) ;
  - `chart has one bar per day with its title` ;
  - `search down is orange and not an error` ;
  - `refresh reloads both endpoints` ; `load error shows retry`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier.** Commandes de l'admin et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(admin): écran Tableau de bord (cartes, graphique 30 jours, mois, santé)`.

### Tâche 8 : écran Offre

**Fichiers :**
- Créer : `apps/admin/src/pages/Offer.tsx`, `apps/admin/test/offer.test.tsx`.
- Modifier : `src/App.tsx` (route `offer`).

**Interfaces :**
- Utilise : `GET /api/admin/offer`, `PATCH /api/admin/offer/plans/{plan}` (tâche 2), `ConfirmDialog`, `ActionLog`, `actionMessage`.
- **Contenu (spec §2 et §3) :**
  - un formulaire par plan (essai, Standard, Premium) : prix mensuel et annuel en euros (saisis en euros, envoyés en centimes ; absents pour l'essai), quota, période (lecture seule), plafond total (vide = aucun), photos par analyse (0 à 4), case « Icônes sur les cartes », identifiant de prix Stripe (lecture seule) ;
  - « Enregistrer » envoie seulement les champs modifiés, après une confirmation qui les résume (« Quota Premium : 300 → 400 ») ;
  - avertissement si un prix change sur un plan qui a un `stripePriceId` : « Créez aussi le nouveau prix dans Stripe. » ;
  - avertissement si les photos changent : « Pensez à mettre à jour la page /privacy, qui annonce 1 photo en Standard et jusqu'à 4 en Premium et pendant l'essai. » ;
  - après l'enregistrement, l'écran affiche l'offre renvoyée par l'API et les brouillons sont remis à zéro ;
  - sous les formulaires, l'historique (`ActionLog`, 20 dernières `offer.*`).

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `forms show the offer and no price for trial` ;
  - `save sends only changed fields in cents` (2,99 € → `299`) ;
  - `confirmation lists the changes` ; `stripe warning on price change` ; `privacy warning on photos change` ;
  - `out of bounds value cannot be saved` (photos 5, quota négatif) ;
  - `after save the screen shows the API offer and clears drafts` ;
  - `history lists offer actions`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier.** Commandes de l'admin et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(admin): écran Offre (prix, quotas, photos, icônes, plafond, historique)`.

### Tâche 9 : écran Analyses

**Fichiers :**
- Créer : `apps/admin/src/pages/Analyses.tsx` (liste), `src/pages/AnalysisCard.tsx` (détail), `apps/admin/test/analyses.test.tsx`.
- Modifier : `src/App.tsx` (routes `analyses`, `analysis`).

**Interfaces :**
- Utilise : `GET /api/admin/analyses`, `GET /api/admin/analyses/{id}` (tâche 4) ; `GET /api/admin/ai` pour les listes des filtres modèle et version de prompt ; `Link` vers `{ name: "ai", promptId }`.
- **Liste :** colonnes du spec §2 ; filtres site, niveau, modèle, version de prompt, période (de / à), « avec recherche web », « partielle » ; recherche dans le titre à partir de 3 caractères, 300 ms après la dernière frappe ; « Page suivante » ; une réponse ancienne n'écrase jamais une plus récente ; après une erreur, la liste et le curseur sont vidés. `from` postérieur à `to` : le formulaire le signale et n'envoie rien.
- **Détail :** sections du spec §3 ; le lien vers l'annonce (nouvel onglet, `rel="noopener noreferrer"`) seulement si `url` existe ; prix et photos omis s'ils sont absents (point 5 de Review Focus) ; lien vers le texte du prompt dans l'écran IA ; aucun email ni identifiant de compte.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `filters build the query` ; `search waits for 3 characters and debounces` ; `stale response does not overwrite` ; `next page` ; `from after to is refused`;
  - `detail shows texts, reasons and searches in order` ; `detail without url, price or images` (point 5) ; `prompt link opens the ai screen on that version`.
- [ ] **Étape 2 : lancer les tests.** Ils doivent échouer.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier.** Commandes de l'admin et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(admin): écran Analyses (liste filtrée, détail, lien vers le prompt)`.

### Tâche 10 : documentation et suivi

**Fichiers :**
- Modifier :
  - la spécification principale : §6.3 (`listings.url`), §7.1 (routes de la partie 2 et `GET /api/offer`), §8 (écrans livrés), §13 (phase 4b terminée) ;
  - `docs/etat-du-projet.md` ;
  - `README.md` (écrans de l'admin, `GET /api/offer`, page des prix) ;
  - `docs/superpowers/plans/2026-10-21-phase-4b-partie-1-suivi.md` (« Reste pour la partie 2 » renvoie au nouveau suivi).
- Créer : `docs/superpowers/plans/2026-10-21-phase-4b-partie-2-suivi.md`.

- **Contenu du suivi :**
  - vérifications en vrai : Tableau de bord sur la base de dev (cohérence des cartes avec quelques scans faits à la main, jour du 25 octobre), graphique dans le navigateur, modifications de l'offre puis `/api/me` et un scan depuis une carte, page `/pricing` en FR et NL avec l'API puis API arrêtée, en-tête de cache de `GET /api/offer` derrière Caddy, détail d'une analyse avec et sans URL, boîte de confirmation au clavier ;
  - limites connues : projection linéaire du mois ; les analyses d'avant la migration 0008 n'ont pas de lien ; la page `/privacy` reste en texte fixe pour les photos et les recherches ; `GET /api/offer` peut être en retard de 5 min sur une modification ;
  - partie 1 : les vérifications de son suivi restent à faire.

- [ ] **Étape 1 : mettre à jour les docs,** dans le style de `docs/etat-du-projet.md`.
- [ ] **Étape 2 : vérifier.** Commandes : `pnpm lint && pnpm test:all && pnpm check:api`. Résultat attendu : PASS.
- [ ] **Étape 3 : commiter.** Message : `docs: phase 4b partie 2 (tableau de bord, offre, analyses) et suivi`.
