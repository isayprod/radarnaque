# Radarnaque v4 — Spécification de conception

- **Date :** 2026-10-16
- **Statut :** validé en discussion, en attente de relecture du document
- **Auteur :** Ismail (avec Claude)

## 1. Contexte et objectifs

Radarnaque est une extension de navigateur qui aide les acheteurs à détecter les arnaques sur les marketplaces de petites annonces.

### 1.1 Pourquoi une v4

Les versions 1 à 3 souffraient de deux problèmes :

1. **Le modèle d'IA local (WebLLM) était trop lent**, et surtout il fallait le télécharger avant de pouvoir utiliser l'extension.
2. **L'architecture était brouillonne.** Pas de comptes, pas de backend clair, et une hésitation permanente sur la technologie serveur.

### 1.2 Objectifs de la v4

- Une extension **rapide et minimale** (React + Vite), qui s'intègre **discrètement** dans les sites ciblés grâce à l'icône Radarnaque.
- **Des comptes utilisateurs**, la priorité numéro un : connexion sans mot de passe, rôles et abonnements.
- **Une analyse de risque à deux niveaux :**
  - des **règles locales** gratuites, illimitées, sans compte ;
  - une **analyse IA côté serveur**, avec quotas et réservée aux comptes payants ou en essai.
- **Une architecture ouverte à toutes les marketplaces**, grâce à des adaptateurs qui transforment chaque annonce en un objet universel.
- **Aucune dépendance à une plateforme** (pas de Supabase ni d'Appwrite) : un hébergement sur ton propre serveur, en Allemagne.
- **Des coûts d'IA maîtrisés**, avec un fournisseur interchangeable (API compatible OpenAI, OpenRouter par défaut) et un cache partagé entre utilisateurs.
- **Une structure prête pour Stripe**, sans le branchement réel pour l'instant.

### 1.3 Marketplaces ciblées par le MVP

| Site | Langue | Adaptateur |
|---|---|---|
| 2ememain.be | FR | `adevinta-2dehands` (plateforme commune) |
| 2dehands.be | NL | `adevinta-2dehands` |
| facebook.com/marketplace | langue du navigateur | `facebook-marketplace` |

### 1.4 Hors du MVP, mais prévu dans l'architecture

- **La base de prix des objets connus.** Elle sera alimentée petit à petit, en partie à partir des `listing_snapshots`. La règle « prix anormal » existe déjà, mais reste désactivée.
- **L'IA locale**, pour une éventuelle future offre gratuite.
- **Le branchement réel de Stripe** (phase 5).
- **Firefox.** WXT génère déjà le manifeste Firefox, mais la cible du MVP est Chromium : Chrome, Edge et Brave.

## 2. Offre et droits

### 2.1 Niveaux

Il n'y a pas de freemium. Sans compte, l'extension affiche uniquement le score des règles locales. Avec un compte, l'utilisateur démarre en **essai** : 3 scans IA, toutes fonctionnalités Premium comprises. Il doit ensuite s'abonner.

| Fonctionnalité | Sans compte | Essai | Standard | Premium |
|---|---|---|---|---|
| Score par règles locales, automatique sur la page d'une annonce, illimité | ✅ | ✅ | ✅ | ✅ |
| Analyse IA texte via le bouton de la page d'une annonce | ❌ | ✅ | ✅ | ✅ |
| Icône sur les cartes des résultats de recherche, avec analyse IA au clic | ❌ | ✅ | ❌ | ✅ |
| Analyse IA automatique à l'ouverture d'une annonce | ❌ | ✅ | ❌ | ✅ |
| Analyse IA avec photos | ❌ | ✅ | ❌ | ✅ |

- L'analyse IA « texte » reçoit le texte de l'annonce, les informations du vendeur (sans son identité) et les signaux calculés par les règles locales.
- Les quotas **texte** et **photos** sont **indépendants**.
- L'essai offre **3 scans au total**, texte ou photos confondus, sans limite de durée.
- **Un scan servi depuis le cache compte dans le quota.**
- Un scan automatique à l'ouverture d'une annonce compte comme un scan texte.

### 2.2 Prix et quotas de départ

Ces valeurs sont stockées en base et modifiables depuis l'admin.

| Plan | Mensuel TTC | Annuel TTC | Scans texte | Scans photos | Période |
|---|---|---|---|---|---|
| Essai | — | — | 3 au total (plafond commun) | (inclus dans les 3) | à vie |
| Standard | 2,99 € | 29 € | 150 | 0 | mois d'abonnement |
| Premium | 6,99 € | 69 € | 1 000 | 100 | mois d'abonnement |

### 2.3 Hypothèses de coût

Les prix ci-dessous ont été relevés sur OpenRouter le 2026-10-15.

- **Taille d'un scan :**
  - texte : environ 2 500 tokens en entrée et 400 en sortie ;
  - photos : environ 6 500 tokens en entrée (jusqu'à 4 images de 768 px).
- **Modèles de départ :**
  - texte : `google/gemini-2.5-flash-lite` (0,10 / 0,40 $ par million de tokens), soit environ 0,04 ¢ par scan ;
  - photos : `google/gemini-3.1-flash-lite` (0,25 / 1,50 $ par million de tokens), soit environ 0,22 ¢ par scan.
- **Marge de sécurité** pour le dimensionnement : 5×, soit 0,6 ¢ par scan texte et 1,2 ¢ par scan photos.
- **Marge par abonné** après TVA belge (21 %) et frais Stripe : environ 1,30 € par mois en Standard et environ 4 € par mois en Premium, dans un usage réaliste.
- Le choix définitif des modèles se fera avec le banc d'essai (voir §12, ligne « Qualité IA »).

## 3. Architecture globale

```
┌──────────────────────── Navigateur (Chrome / Edge / Brave) ────────────────────────┐
│  Extension Radarnaque (WXT + React + TS, Manifest V3)                               │
│  content script (par site)          service worker                     popup        │
│  ├─ Adaptateurs → Listing           ├─ session + JWT                   ├─ connexion │
│  ├─ Moteur de règles (local)        ├─ seul client HTTP de l'API       ├─ compte    │
│  └─ UI injectée (Shadow DOM)        └─ reçoit la session (callback)    └─ quotas    │
└───────────────────────────────────────────┬─────────────────────────────────────────┘
                                            │ HTTPS
                     radarnaque.mostconsult.be  (Caddy, TLS auto)
      /auth/*            /api/*              /admin            / (pricing, privacy, auth/callback)
   ┌────────────┐   ┌────────────────┐   ┌──────────────┐   ┌─────────────────┐
   │ auth       │   │ api            │   │ admin        │   │ site            │
   │ Node +     │──▶│ FastAPI (uv)   │◀──│ SPA React    │   │ pages statiques │
   │ Better Auth│JWKS│ droits, quotas │   └──────────────┘   └─────────────────┘
   │ → Resend   │   │ cache, LLM ────┼──▶ OpenRouter
   └─────┬──────┘   └───────┬────────┘
         └──── PostgreSQL 17 ┘   schéma `auth` (Better Auth) · schéma `app` (FastAPI/Alembic)
```

### 3.1 Principes structurants

1. **Les règles locales tournent entièrement dans l'extension**, sans réseau et sans compte.
2. **Tout ce qui coûte de l'argent ou donne des droits est décidé par le serveur.** L'extension se contente de masquer l'interface à laquelle l'utilisateur n'a pas accès. FastAPI fait foi.
3. **Une base, deux schémas, un seul propriétaire par table.**
   - Better Auth possède le schéma `auth`.
   - FastAPI possède le schéma `app`, et ne fait que lire `auth.user`.
4. **Les modèles Pydantic de FastAPI sont la source de vérité du contrat.** Les types TypeScript (extension et admin) sont générés à partir de l'OpenAPI.
5. **Les fournisseurs sont interchangeables**, derrière une interface :
   - `LLMClient` pour l'IA ;
   - `BillingProvider` pour le paiement ;
   - `MarketplaceAdapter` pour les sites.

### 3.2 Organisation du dépôt (monorepo pnpm + uv)

```
radarnaque-v4/
  apps/
    extension/        WXT + React + TS + Tailwind
    admin/            Vite + React + TS + Tailwind (SPA servie sur /admin)
    site/             pages statiques : /pricing, /privacy, /auth/callback
  services/
    auth/             Node + Hono + Better Auth
    api/              FastAPI, géré avec uv (SQLAlchemy 2, Alembic, Pydantic v2)
  packages/
    shared/           types TS générés depuis l'OpenAPI, constantes, textes FR/NL partagés
  infra/
    docker-compose.yml, docker-compose.dev.yml, Caddyfile, .env.example, backup/
  docs/superpowers/specs/
```

## 4. Extension

### 4.1 Outillage

- **WXT** (basé sur Vite) avec React 18, TypeScript et Tailwind 4.
- Une clé `key` est fixée dans le manifeste pour que **l'identifiant de l'extension reste le même** en développement et en production. `externally_connectable` en dépend.
- **Permissions :**
  - `storage` ;
  - hôtes `*://*.2ememain.be/*`, `*://*.2dehands.be/*`, `*://*.facebook.com/*` et `https://radarnaque.mostconsult.be/*` ;
  - `externally_connectable.matches` limité à `https://radarnaque.mostconsult.be/*`.
- Pas d'`offscreen`, de `scripting` ni d'`activeTab`.

### 4.2 Objet universel `Listing`

```ts
type Listing = {
  site: "2ememain.be" | "2dehands.be" | "facebook.com";
  externalId: string;
  url: string;
  title: string;
  description: string;
  price: { amountCents: number; currency: "EUR" } | null;
  priceType: "fixed" | "bidding" | "free" | "unknown";
  category?: string;
  condition?: string;
  postedAt?: string;            // ISO 8601
  location: { city?: string; postalCode?: string; country?: string };
  images: string[];             // URLs absolues, dans l'ordre d'affichage
  seller: {
    id?: string; name?: string; profileUrl?: string;  // utilisés côté client uniquement
    memberSince?: string; reviewCount?: number; rating?: number;
    otherListingsCount?: number; verified?: boolean;
  };
};
```

- Un champ absent vaut `undefined`. **« Inconnu » n'est jamais un signal de risque.**
- `seller.id`, `seller.name` et `seller.profileUrl` ne quittent **jamais** le navigateur. Le client les retire avant tout envoi à l'API.

### 4.3 Adaptateurs

```ts
interface MarketplaceAdapter {
  id: string;
  sites: Listing["site"][];
  pageType(url: URL, doc: Document): "search" | "listing" | "other";
  findCards(root: ParentNode): { element: Element; externalId: string; url: string }[];
  extractListing(doc: Document, url: URL): Listing;
  anchors: { card(el: Element): Element; listing(doc: Document): Element | null };
}
```

- **Ordre d'extraction :** d'abord les données structurées (JSON-LD, JSON embarqué), puis le DOM, en s'appuyant sur des repères stables : attributs, ARIA, motifs d'URL, libellés.
- **Facebook :** on n'utilise jamais ses classes CSS obfusquées. On s'appuie sur `a[href*="/marketplace/item/"]`, les rôles ARIA et les libellés textuels.
- **Ajouter une marketplace** consiste à écrire un nouvel adaptateur et à l'enregistrer dans le registre. Rien d'autre ne change.

### 4.4 Moteur de règles

- Une règle est une fonction pure : `(listing: Listing) => Signal | null`.
- `Signal = { id, weight, severity: "info" | "warning" | "danger", params? }`. Les messages FR/NL sont dans les fichiers i18n, indexés par `id`.
- **Score :** somme des poids, plafonnée à 100.
- **Niveaux :** `faible` de 0 à 29, `moyen` de 30 à 59, `élevé` à partir de 60. Ces seuils sont des constantes partagées.
- **`RULES_VERSION`** : un entier incrémenté à chaque modification d'une règle ou d'un poids.

**Règles du MVP :**

| id | Condition |
|---|---|
| `few_photos` | 0 ou 1 photo |
| `new_account` | `memberSince` date de moins de 3 mois |
| `no_reviews` | `reviewCount === 0` |
| `foreign_location` | pays connu et différent de BE |
| `short_description` | moins de 30 caractères |
| `contact_outside` | téléphone, email, WhatsApp ou Telegram dans le texte |
| `shipping_only` | « envoi uniquement », « verzending enkel », etc. |
| `offsite_payment` | lien de paiement, Western Union, « paiement à l'avance », etc. (FR/NL) |
| `symbolic_price` | prix entre 0 et 1 € alors que le type n'est pas « gratuit » |
| `price_anomaly` | **désactivée**, en attente de la base de prix |

Les poids initiaux sont fixés à l'implémentation, puis ajustés en testant sur des annonces réelles.

### 4.5 Intégration dans les pages

- **Toute l'interface est injectée dans un Shadow DOM** (`createShadowRootUi` de WXT). Ainsi, nos styles et ceux du site restent isolés dans les deux sens.
- **Page d'une annonce (tout le monde) :**
  - une pastille colorée près du prix, qui affiche le score des règles ;
  - au clic, un panneau qui liste les signaux et propose :
    - « Lancer une analyse IA » ;
    - « Analyse avec photos », si le plan le permet ;
    - « Se connecter », si l'utilisateur n'a pas de compte.
  - Si le plan inclut `auto_scan`, l'analyse IA texte démarre automatiquement.
- **Cartes des résultats de recherche (plans avec `card_icons`) :**
  - la petite icône Radarnaque dans un coin de chaque carte ;
  - au clic, une analyse IA, puis la pastille du niveau de risque, avec un résumé au survol.
  - **Pour obtenir les données complètes**, le content script récupère la page de l'annonce (même origine), la parse avec `DOMParser` et applique `extractListing`.
  - **Sur Facebook**, si les données complètes sont introuvables dans le HTML récupéré, l'analyse porte sur les données de la carte et le résultat est marqué `partial`.
- **Détection du contenu dynamique :** un `MutationObserver`, limité à une exécution toutes les 250 ms, combiné à `wxt:locationchange`. Les éléments déjà traités sont marqués avec l'attribut `data-radarnaque`, ce qui rend l'injection idempotente.

### 4.6 Messagerie interne

- Le **content script** et la **popup** envoient des messages typés au **service worker** : `getMe`, `scan`, `signOut`, `getSessionState`.
- Le **service worker** est le **seul** à détenir le jeton de session et le JWT, et le seul à appeler `/auth/*` et `/api/*`.
- Il reçoit aussi `onMessageExternal` depuis la page `/auth/callback`, en vérifiant l'origine de l'expéditeur.

### 4.7 Langue

- La langue de l'interface suit le site : 2ememain → `fr`, 2dehands → `nl`, Facebook → langue du navigateur (`fr` ou `nl`, sinon `fr`).
- La popup permet de choisir une autre langue. Ce choix est enregistré dans `chrome.storage.local`.
- Les résultats de l'IA sont toujours fournis dans les deux langues. L'extension affiche celle qui est active.

## 5. Authentification

### 5.1 Service `auth`

- Node avec Hono et Better Auth, monté sur `/auth`.
- **Plugins Better Auth :**
  - `magicLink` et `emailOTP` : un seul email contient à la fois le lien et un code à 6 chiffres ;
  - `bearer` : jeton de session pour l'extension ;
  - `jwt` : JWT EdDSA de 15 minutes, et JWKS publié sur `/auth/jwks` ;
  - `admin` : rôle `user` ou `admin`.
- **Emails** envoyés via Resend, depuis `radarnaque.mostconsult.be` (enregistrements DNS SPF et DKIM à ajouter). Les modèles d'email existent en FR et en NL. En développement, ils sont affichés dans la console.
- Un **hook à la création d'un utilisateur** demande à l'API de créer l'abonnement `trial`. Cet appel passe par une route interne `POST /api/internal/users/{id}/bootstrap`, protégée par un secret partagé et accessible seulement depuis le réseau Docker. L'API reste ainsi seule propriétaire du schéma `app`. Cette opération est idempotente : si l'appel échoue (API indisponible), `GET /api/me` crée l'abonnement d'essai manquant au premier appel.
- `trustedOrigins` contient l'origine `chrome-extension://<ID>` et `https://radarnaque.mostconsult.be`.
- Le service n'expose aucune logique métier.

### 5.2 Flux de connexion dans l'extension

```
1. Popup : saisie de l'email → service worker → POST /auth/sign-in/magic-link
   (callbackURL = /auth/callback, langue = langue active)
2. Email : lien magique + code à 6 chiffres
3a. Lien cliqué dans le même navigateur :
    /auth/magic-link/verify → session (cookie) → /auth/callback
    → la page récupère le jeton de session (plugin bearer)
    → chrome.runtime.sendMessage(EXTENSION_ID, { type: "session", token })
    → affiche « Connecté ✓ »
3b. Email ouvert sur un autre appareil : l'utilisateur saisit le code dans la popup
    → POST /auth/sign-in/email-otp → jeton de session
4. Service worker : enregistre le jeton (chrome.storage.local)
   → GET /auth/token (Authorization: Bearer <jeton>) → JWT, gardé en mémoire
   et renouvelé 1 minute avant son expiration
```

- Déconnexion : appel à `POST /auth/sign-out`, puis effacement du stockage local.
- Une réponse `401` de l'API déclenche **un seul** renouvellement du JWT. En cas de nouvel échec, l'utilisateur est déconnecté.

### 5.3 Identité dans l'API

- FastAPI vérifie la signature, l'émetteur, l'audience et l'expiration du JWT grâce au JWKS. Le JWKS est mis en cache, et rechargé dès qu'un `kid` inconnu apparaît.
- Le JWT ne sert **qu'à identifier** l'utilisateur (`sub`).
- Le **rôle** (`auth.user.role`) et le **plan** (abonnement actif) sont relus en base à chaque requête qui dépend des droits. Un changement fait dans l'admin s'applique donc immédiatement.

### 5.4 Page d'administration

L'admin se connecte par lien magique ou code, sur la même origine (session cookie), puis échange sa session contre un JWT via `/auth/token`.

## 6. Données — schéma `app` en 3NF

Le schéma `auth` appartient à Better Auth et n'est pas modifié, à l'exception des valeurs de `user.role`, limitées à `user` et `admin`. Le **niveau** de l'utilisateur (essai, standard, premium) n'est stocké qu'à un seul endroit : son abonnement actif.

### 6.1 Référentiels

```
marketplaces(id PK, code UNIQUE)
locales(code PK)                         -- 'fr', 'nl'
sites(id PK, marketplace_id FK, domain UNIQUE, default_locale FK→locales)
currencies(code PK)                      -- 'EUR'
features(code PK)                        -- 'card_icons', 'auto_scan', 'image_scan'
billing_intervals(code PK)               -- 'month', 'year'
quota_periods(code PK)                   -- 'subscription_month', 'lifetime'
scan_triggers(code PK)                   -- 'button', 'card', 'auto'
severities(code PK)                      -- 'info', 'warning', 'danger'
subscription_statuses(code PK)           -- 'active', 'canceled', 'past_due', 'expired'
billing_providers(code PK)               -- 'manual', 'stripe'
models(id PK, provider, slug, UNIQUE(provider, slug))
scan_kinds(code PK,                      -- 'text', 'image'
           active_model_id FK→models,
           active_prompt_version_id FK→prompt_versions NULL)   -- FK différée
prompt_versions(id PK, scan_kind FK→scan_kinds, version, system_prompt, created_at,
                UNIQUE(scan_kind, version))                    -- non modifiable une fois créée
site_image_hosts(site_id FK, host_suffix, PK(site_id, host_suffix))  -- liste blanche anti-SSRF
settings(id PK CHECK (id = 1), cache_ttl_hours, rate_limit_per_minute)
```

### 6.2 Offre

```
plans(code PK, quota_period FK→quota_periods, total_scan_cap NULL)
plan_prices(plan FK, interval FK, currency FK, amount_cents, stripe_price_id NULL,
            PK(plan, interval, currency))
plan_quotas(plan FK, scan_kind FK, quota, PK(plan, scan_kind))
plan_features(plan FK, feature FK, PK(plan, feature))
```

### 6.3 Clients

```
subscriptions(id PK, user_id FK→auth.user ON DELETE CASCADE, plan FK, status FK,
              provider FK, provider_ref NULL, period_start, period_end NULL, created_at)
  UNIQUE INDEX (user_id) WHERE status = 'active'
admin_actions(id PK, admin_user_id FK→auth.user, action, target_user_id NULL, created_at)
```

- **Pourquoi garder `period_end`** alors qu'il pourrait sembler dérivable : avec Stripe, la fin de période est un fait fourni par Stripe (prorata, date d'ancrage), pas un calcul.
- **Pourquoi `admin_actions.target_user_id` n'a pas de clé étrangère** : cela permet de conserver la trace d'une suppression de compte.

### 6.4 Annonces et cache

```
listings(id PK, site_id FK, external_id, UNIQUE(site_id, external_id))
listing_snapshots(id PK, listing_id FK, content_hash, title, description,
                  price_cents NULL, currency FK NULL, captured_at,
                  UNIQUE(listing_id, content_hash))
snapshot_images(snapshot_id FK, position, url, PK(snapshot_id, position))
analyses(id PK, snapshot_id FK, model_id FK, prompt_version_id FK, rules_version,
         input_hash, score CHECK (0..100), partial BOOL,
         tokens_in, tokens_out, cost_usd_micros, created_at,
         UNIQUE(snapshot_id, model_id, prompt_version_id, input_hash))   -- clé du cache
analysis_texts(analysis_id FK, locale FK, summary, advice, PK(analysis_id, locale))
analysis_reasons(id PK, analysis_id FK, position, severity FK, UNIQUE(analysis_id, position))
analysis_reason_texts(reason_id FK, locale FK, text, PK(reason_id, locale))
```

- **`content_hash`** = SHA-256 de la forme canonique de `{ title, description, price, priceType, images }`. Il est **toujours recalculé par le serveur**.
- **`input_hash`** = SHA-256 de la forme canonique de `{ sellerFacts sans identité, rules.version, rules.signals triés, partial }`. Ces données ne sont pas stockées. Ce hash empêche d'empoisonner le cache avec de faux signaux : des données différentes donnent une autre clé de cache.
- **Le type de scan** d'une analyse se déduit via `prompt_version_id → scan_kind`. Il n'est pas dupliqué.
- **Le niveau de risque** se calcule à partir de `score`, avec les mêmes seuils que §4.4. Il n'est pas stocké.
- **La validité d'une entrée de cache** se calcule : `created_at + settings.cache_ttl_hours > now()`. Elle n'est pas stockée.

### 6.5 Scans et quotas

```
scan_events(id PK, user_id FK→auth.user ON DELETE CASCADE, scan_kind FK, trigger FK, created_at)
  INDEX (user_id, scan_kind, created_at)
scan_results(scan_event_id PK FK, analysis_id FK)
scan_failures(scan_event_id PK FK, error_code, created_at)
```

- **Quota consommé** pour une période = nombre de `scan_events` de l'utilisateur pour ce type dans la période, en excluant ceux qui ont un `scan_failures`.
  - Avec `subscription_month`, la période court du dernier anniversaire mensuel de `period_start` jusqu'à maintenant.
  - Avec `lifetime`, elle couvre tout l'historique de l'abonnement.
  - `total_scan_cap` limite la somme de tous les types.
- **Servi depuis le cache** : vrai s'il existe un `scan_results` antérieur pointant vers la même analyse. C'est calculé.
- **Vues SQL** prévues pour l'admin et `/api/me` : `v_usage_current_period`, `v_scan_history`, `v_daily_costs`.

## 7. API (FastAPI)

### 7.1 Routes

| Méthode | Route | Accès | Rôle |
|---|---|---|---|
| GET | `/api/me` | utilisateur | plan, fonctionnalités, quotas restants par type, rôle |
| POST | `/api/scans` | utilisateur | lancer une analyse IA (voir §7.2) |
| GET | `/api/scans/history` | utilisateur | historique paginé de ses scans |
| DELETE | `/api/me` | utilisateur | suppression du compte et des données (RGPD) |
| POST | `/api/billing/checkout` | utilisateur | `{ plan, interval }`. MVP : `501 billing_unavailable` |
| POST | `/api/billing/portal` | utilisateur | MVP : `501 billing_unavailable` |
| POST | `/api/billing/webhooks/stripe` | Stripe | MVP : `501`, implémenté en phase 5 |
| POST | `/api/internal/users/{id}/bootstrap` | service auth | création de l'abonnement d'essai (secret partagé) |
| GET/PATCH | `/api/admin/*` | admin | voir §8 |

### 7.2 Déroulé de `POST /api/scans`

Corps de la requête : `{ listing: ListingIn, rules: { version, signals: SignalIn[] }, scanKind, trigger, partial }`.

1. **Authentification** du JWT, puis **limite de requêtes** par utilisateur (`settings.rate_limit_per_minute`, admins compris). Sinon → `429 rate_limited`.
2. **Droits** : l'abonnement actif doit exister, sinon → `402 no_active_subscription`. Le rôle `admin` est dispensé de cette vérification et dispose de toutes les fonctionnalités.
   - `scanKind = image` exige `image_scan` ;
   - `trigger = card` exige `card_icons` ;
   - `trigger = auto` exige `auto_scan`.
   - Sinon → `403 feature_not_in_plan`.
3. **Validation** :
   - description de 5 000 caractères au plus, titre de 300 au plus ;
   - 10 images au plus, et chaque hôte d'image doit correspondre à `site_image_hosts` ;
   - le site doit être connu.
   - Sinon → `422 invalid_listing`.
4. **Snapshot** : calcul de `content_hash`, puis upsert de `listings`, `listing_snapshots` et `snapshot_images`.
5. **Réservation du quota**, en une transaction :
   - `SELECT … FOR UPDATE` sur l'abonnement actif ;
   - comptage selon §6.5, avec vérification du quota du type et de `total_scan_cap` ;
   - insertion du `scan_event`, puis commit.
   - Si le quota est atteint → `402 quota_exhausted`, avec `{ plan, scanKind }`.
   - Le rôle `admin` saute la vérification, mais l'événement est quand même enregistré.
6. **Recherche dans le cache** par `(snapshot, modèle actif, version de prompt active, input_hash)`, en vérifiant que l'entrée est encore valide. Si elle l'est : insertion du `scan_result` et réponse.
7. **Si le cache ne répond pas :**
   - `pg_advisory_xact_lock(hash de la clé de cache)` ;
   - nouvelle vérification du cache ;
   - pour un scan photos, téléchargement des images (§7.4) ;
   - appel au LLM (§7.3), validation de la réponse, insertion de l'analyse avec ses textes et ses raisons, puis du `scan_result`.
8. **En cas d'échec** (LLM, réponse invalide, images inaccessibles) : insertion d'un `scan_failures`, ce qui rend le scan à l'utilisateur, et réponse `502 analysis_failed`.

**Réponse `AnalysisResult` :**
```json
{ "analysisId": "…", "score": 72, "level": "high", "partial": false, "fromCache": true,
  "summary": { "fr": "…", "nl": "…" }, "advice": { "fr": "…", "nl": "…" },
  "reasons": [{ "severity": "danger", "text": { "fr": "…", "nl": "…" } }],
  "analyzedAt": "2026-10-16T10:00:00Z",
  "remaining": { "text": 148, "image": 0 } }
```

### 7.3 Relais LLM

- **Interface :** `LLMClient.analyze(prompt: PromptVersion, payload, images) -> LLMAnalysis`.
- **Implémentation :** `OpenAICompatibleClient`, avec le SDK `openai`, `base_url = https://openrouter.ai/api/v1` et la clé `OPENROUTER_API_KEY`.
- **Paramètres d'appel :**
  - `response_format` de type `json_schema` en mode strict ;
  - `temperature = 0.2` ;
  - raisonnement désactivé ;
  - `max_tokens = 800` ;
  - délai de 30 s et **une** nouvelle tentative ;
  - `provider: { data_collection: "deny" }` ;
  - `usage: { include: true }`.
- **Contenu envoyé :** le prompt système de la version active, puis l'annonce, où les téléphones et emails de la description sont **masqués** (`[téléphone]`, `[email]`). S'y ajoutent les informations du vendeur **sans son identité**, les signaux des règles et les images éventuelles.
- **Sortie attendue :** `{ score, summary{fr, nl}, advice{fr, nl}, reasons[{severity, fr, nl}] }`, validée par Pydantic.
- **Le coût réel** est relevé dans `usage.cost`, puis converti en micro-dollars.

### 7.4 Photos

- Le serveur télécharge **au plus 4 images**, avec `httpx` :
  - délai de 5 s par image, 5 Mo maximum ;
  - redirections suivies uniquement vers des hôtes de la liste blanche ;
  - adresses IP privées refusées.
- Chaque image est réduite à 768 px maximum sur son plus grand côté, convertie en JPEG de qualité 80 avec Pillow, puis envoyée en base64.

### 7.5 Codes d'erreur stables

Le format est `{ "error": { "code": "...", "message": "...", "details": {} } }`. L'extension s'appuie sur `code` pour afficher le bon message en FR ou en NL.

| HTTP | code |
|---|---|
| 401 | `unauthenticated` |
| 402 | `no_active_subscription`, `quota_exhausted` |
| 403 | `feature_not_in_plan`, `admin_required` |
| 422 | `invalid_listing` |
| 429 | `rate_limited` |
| 501 | `billing_unavailable` |
| 502 | `analysis_failed` |

## 8. Administration

- **Technique :** une SPA Vite + React + Tailwind servie sur `/admin`. Toutes les routes `/api/admin/*` exigent `auth.user.role = 'admin'`.
- **Chaque modification** est enregistrée dans `admin_actions`.

| Écran | Contenu |
|---|---|
| Tableau de bord | Scans par jour et par type ; taux de réponses servies depuis le cache ; coût IA du jour et du mois ; abonnés actifs par plan ; taux d'échec des analyses |
| Utilisateurs | Recherche par email ; plan, statut et consommation de la période. Actions : attribuer un plan (`provider = manual`), nommer ou retirer un admin, supprimer un compte |
| Offre | Pour chaque plan : prix, quotas par type, fonctionnalités, `total_scan_cap` |
| IA | Modèles (ajout d'un slug) ; modèle actif par type de scan ; versions du prompt (création, consultation, activation) ; durée du cache ; limite de requêtes |
| Analyses | Liste paginée des analyses récentes : annonce, score, textes, modèle, coût, nombre de scans servis |

## 9. Paiement (structure Stripe)

- **Interface :** `BillingProvider.create_checkout(user, plan, interval) -> url`, `create_portal(user) -> url` et `handle_webhook(payload, signature) -> None`.
- **MVP :** `ManualBillingProvider`.
  - Le checkout et le portail renvoient `501 billing_unavailable`.
  - L'extension renvoie alors vers `/pricing`, qui affiche les offres et la mention « bientôt disponible ».
  - C'est l'admin qui attribue les plans.
- **Déjà en place :** `plan_prices.stripe_price_id`, `subscriptions.provider` et `subscriptions.provider_ref`.
- **Phase 5 :**
  - écriture de `StripeBillingProvider` ;
  - ajout de la table `billing_events(provider FK, event_id, received_at, PK(provider, event_id))`, qui garantit qu'un même webhook n'est traité qu'une fois ;
  - synchronisation du statut et des périodes d'abonnement.

## 10. Vie privée (RGPD)

- **Hébergement :** serveur en Allemagne (UE).
- **Données du vendeur :** son identité (nom, identifiant, profil) n'est jamais envoyée au serveur ni au LLM. Les snapshots ne contiennent aucune donnée personnelle du vendeur. Les numéros de téléphone et les emails sont masqués avant l'envoi au LLM.
- **OpenRouter** est configuré avec `data_collection: "deny"`.
- **Conservation :**
  - `scan_events` et les tables associées sont supprimés après **12 mois**, par une tâche planifiée quotidienne dans l'API ;
  - les analyses et les snapshots, qui ne sont pas des données personnelles, sont conservés.
- **Droit à l'effacement :** `DELETE /api/me` et l'action correspondante dans l'admin suppriment l'utilisateur dans Better Auth, ce qui supprime en cascade ses abonnements et ses scans.
- **Page `/privacy`** en FR et en NL, et déclarations correspondantes dans le Chrome Web Store.

## 11. Infrastructure et déploiement

- **`docker-compose.yml` (production) :**
  - `caddy` : TLS automatique, routage `/auth`, `/api`, `/admin` et `/` ;
  - `auth` ;
  - `api` (uvicorn) ;
  - `postgres:17`, avec un volume ;
  - `migrate`, exécuté une seule fois : migrations Better Auth, puis `alembic upgrade head` ;
  - `backup` : `pg_dump` quotidien et chiffré vers un stockage externe, avec une rétention de 14 jours.
- **Secrets** dans `.env`, jamais versionné, avec un `.env.example` documenté : `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `RESEND_API_KEY`, `OPENROUTER_API_KEY`, `INTERNAL_API_SECRET`, `EXTENSION_ID`, `JWT_ISSUER`, `JWT_AUDIENCE`.
- **Développement :**
  - `docker compose -f docker-compose.dev.yml up` lance Postgres, auth et api avec rechargement automatique ;
  - `pnpm --filter extension dev` lance WXT ;
  - les emails sont affichés dans la console.
- **Domaine :** `radarnaque.mostconsult.be`. Les enregistrements DNS Resend (SPF, DKIM) sont à ajouter sur ce sous-domaine.
- **Journaux** au format JSON structuré. Un contrôle de disponibilité externe surveille `/api/health` et `/auth/health`.

## 12. Stratégie de tests

Le développement se fait en **TDD**.

| Partie | Outils | Points critiques |
|---|---|---|
| Règles | Vitest | Chaque règle, cas positifs et négatifs, en FR et en NL |
| Adaptateurs | Vitest + happy-dom | Pages HTML **réelles** enregistrées dans `fixtures/` (recherche et annonce, pour chaque site) |
| UI de l'extension | Testing Library | Affichage selon le plan, états de chargement et d'erreur |
| Extension de bout en bout | Playwright (extension chargée) | 1 ou 2 parcours sur des fixtures servies localement |
| API | pytest + PostgreSQL réel (base de test Docker) | **Requêtes concurrentes sur le quota** ; empoisonnement du cache ; droits par plan et par déclencheur ; remboursement en cas d'échec ; liste blanche SSRF ; JWT invalide ou expiré |
| LLM | Implémentation factice de `LLMClient` | Réponse invalide, délai dépassé, nouvelle tentative |
| Auth | Tests d'intégration | Lien magique et OTP de bout en bout, avec capture des emails |
| Contrat | Génération OpenAPI → TS | La CI échoue si les types générés divergent |
| Qualité IA | `uv run radarnaque-bench` | Une vingtaine d'annonces étiquetées (arnaque ou honnête) ; comparaison des modèles : précision, coût, latence. Hors CI |

## 13. Phases de livraison

Chaque phase fait l'objet de son propre plan d'implémentation, et se livre et se teste indépendamment.

1. **Fondations et connexion** : monorepo, Docker Compose, Postgres, service auth (lien magique + OTP, bearer, JWT, admin), vérification du JWT dans FastAPI, `/api/me`, abonnement d'essai à l'inscription, popup de connexion, page `/auth/callback`.
2. **Adaptateurs et règles locales** : `Listing`, adaptateurs 2ememain/2dehands et Facebook, moteur de règles, pastille et panneau sur la page d'une annonce, fonctionnement sans compte.
3. **Analyse IA** : référentiels, offre et schéma des scans, `POST /api/scans` (droits, quotas, cache, relais LLM, photos), panneau de résultat, icônes sur les cartes et scan automatique.
4. **Administration** : SPA admin, routes `/api/admin/*`, `admin_actions`.
5. **Stripe** : `StripeBillingProvider`, webhooks, `billing_events`, pages de paiement.

## 14. Risques connus

| Risque | Mesure |
|---|---|
| Changements du DOM de Facebook ou de 2dehands | Données structurées en priorité ; fixtures réelles ; tests qui localisent précisément la panne ; adaptateurs isolés |
| Données complètes introuvables depuis une carte Facebook | Analyse marquée `partial` |
| Variation des prix ou disparition d'un modèle | Modèle choisi dans la configuration ; coût réel relevé ; tableau de bord des coûts |
| Lien magique ouvert sur un autre appareil | Code OTP à 6 chiffres dans le même email |
| Abus des quotas ou de l'API | Quotas gérés côté serveur, limite de requêtes, JWT court |
| Empoisonnement du cache | `content_hash` recalculé par le serveur et `input_hash` dans la clé de cache |
| SSRF par les URL d'images | Liste blanche d'hôtes par site, IP privées refusées |
