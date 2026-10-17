# Phase 3b — Analyses IA dans l'extension — Plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans, tâche par tâche. Les étapes sont des cases à cocher (`- [ ]`).

**Objectif :** depuis l'extension, lancer une analyse IA par un clic, en deux endroits :
- sur la page d'une annonce : texte, ou photos si le plan le permet ;
- sur les cartes des résultats de recherche, pour les plans `card_icons`.

Le résultat est affiché en FR ou en NL.

**Architecture :**
- **Service worker :** il reste le seul à parler à l'API. Il accepte trois messages des content scripts, filtrés par une liste blanche : `content/access`, `scan/run` et `ui/open-popup`. Il retire l'identité du vendeur et applique les bornes d'entrée avant `POST /api/scans`.
- **Page d'annonce :** le panneau de la pastille gagne une section IA, un composant React dans le Shadow DOM existant.
- **Pages de recherche :** un second contrôleur pose une icône par carte. Au clic, il récupère la page de l'annonce, la parse, évalue les règles, puis lance le scan avec `trigger = "card"`.

**Stack :** WXT 0.21, React, TypeScript strict, Tailwind 4 dans le Shadow DOM, Vitest et happy-dom, Testing Library, Biome. Les types de l'API viennent de `@radarnaque/shared`, générés par `pnpm gen:api`.

**Spec :** `docs/superpowers/specs/2026-10-16-radarnaque-v4-design.md` : §2.1, §4.2, §4.3, §4.5, §4.6, §4.7, §5.2, §7.2 et §7.5. Notes à reprendre : `docs/superpowers/plans/2026-10-17-phase-3a-suivi.md` (section « À intégrer au brief de la phase 3b ») et `docs/superpowers/plans/2026-10-17-phase-2-suivi.md`.

## Contraintes globales

- **Analyse au clic uniquement.** Toute analyse IA est déclenchée par un clic : aucun scan automatique, ni sur la page d'annonce, ni sur les cartes.
- **Le service worker est seul face à l'API.** Il est le seul à détenir le jeton de session et le JWT, et le seul à appeler `/auth/*` et `/api/*`. Les content scripts n'appellent jamais l'API.
- **Liste blanche des content scripts.** Ils n'ont droit qu'à `content/access`, `scan/run` et `ui/open-popup`. Un message `auth/*` venant d'un onglet répond `forbidden_sender`.
- **Identité du vendeur.** `seller.id`, `seller.name` et `seller.profileUrl` ne quittent jamais le navigateur. Ils sont retirés dans le service worker, dans `toScanIn`, qui est le point de passage unique.
- **Bornes d'entrée, à tronquer côté client** pour que le serveur ne réponde pas `422 invalid_listing` :

  | Champ | Limite |
  |---|---|
  | `title` | 300 |
  | `description` | 5 000 |
  | `images` | 10 |
  | `category` | 200 |
  | `condition` | 100 |
  | `postedAt` | 64 |
  | `location.city`, `location.region`, `location.country` | 100 chacun |
  | `rules.signals` | 20 |
  | `params` de chaque signal | 10 entrées, clés de 1 à 40 caractères, chaînes de 200 au plus, nombres entiers |

  Un titre vide après troncature n'est jamais envoyé : le scan échoue localement avec le code `invalid_listing`.
- **Droits.**
  - Analyse texte : pour tout abonnement actif.
  - « Analyse avec photos » : avec `image_scan` et au moins une photo sur l'annonce. Le serveur refuse `image` sans photo.
  - Icônes de cartes : avec `card_icons`.
  - Admin (`unlimited`) : tout, sans quota affiché.
- **Réponses de l'API.**
  - `remaining.*` vaut `null` pour un admin : afficher « illimité » ou ne rien afficher, jamais « 0 ».
  - Toutes les erreurs suivent `{ error: { code, message, details } }` : on s'appuie sur `code` (§7.5), jamais sur `message`.
- **Textes.** FR et NL pour chaque texte, dans `lib/content-i18n.ts`, avec une parité de clés testée. Les résultats de l'IA s'affichent dans la langue active, `summary[locale]`.
- **Shadow DOM uniquement.** Pas de `innerHTML`. La passe de design viendra à la fin : il faut une UI lisible et accessible, sans plus.
  - Le niveau est écrit en toutes lettres, la couleur ne porte jamais seule l'information.
  - Les boutons sont de vrais `<button type="button">`.
- **Fixtures.** Toute nouvelle fixture suit `apps/extension/test/fixtures/README.md` : minimisée, anonymisée, contrôlée par `fixtures-hygiene.test.ts` avec la liste locale `web-pages/.denylist.txt`. Ne jamais afficher ni copier les valeurs de cette liste, et ne jamais committer une page brute.
- **TDD.** Chaque commit se termine par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Interdits.**
  - Ne jamais pousser.
  - Ne jamais toucher à `video/`, `web-pages/` (sauf pour lire la page source d'une fixture, et ajouter des lignes à `.denylist.txt`), `.DS_Store`, `services/api/tests/.conftest.py.swp` ni `docs/superpowers/plans/.Rhistory`.
- **Vérifications par tâche :** `pnpm --filter extension test`, `pnpm -r typecheck` et `pnpm lint`.

## Points de vigilance (Review Focus)

1. **Double clic sur « Lancer une analyse IA », ou panneau fermé puis rouvert.** Une seule requête part. Le résultat reste affiché à la réouverture du panneau. *Tâche 4.*
2. **Navigation Facebook vers une autre fiche pendant un scan.** Le résultat ne s'affiche jamais sur la nouvelle fiche, puisqu'il appartient à l'ancienne. *Tâche 4.*
3. **Session expirée pendant un scan** (`session_expired`, ou `unauthenticated` après le renouvellement unique). Le panneau affiche « Session expirée, reconnectez-vous » et un bouton « Se connecter », sans planter, et l'accès est relu. *Tâches 2 et 3.*
4. **Clic sur l'icône d'une carte dont tout le bloc est un lien.** Le clic ne navigue pas vers l'annonce. Avec le défilement infini, l'icône n'est posée qu'une fois par carte, et une carte retirée puis remise par le site retrouve son icône. *Tâche 7.*
5. **Quota épuisé, pas d'abonnement, fonctionnalité absente du plan.** Un message clair s'affiche, avec un lien vers `/pricing/?lang=<locale>`. Le bouton photos reste caché sans `image_scan` ou sans photo. Rien ne s'affiche sur les cartes sans `card_icons`. *Tâches 3 et 7.*

---

### Tâche 1 : accès de la page et liste blanche des messages

**Fichiers :**
- Créer : `apps/extension/lib/access.ts`, `apps/extension/test/access.test.ts`
- Modifier : `apps/extension/lib/messages.ts`, `apps/extension/lib/background-handlers.ts`, `apps/extension/entrypoints/background.ts`, `apps/extension/test/background-handlers.test.ts`

**Interfaces :**
- Produit, dans `lib/messages.ts` :
  ```ts
  export type ScanKind = "text" | "image";
  export type ScanTrigger = "button" | "card";
  export interface ScanRequest {           // envoyé par le content script
    listing: Listing;                      // complet, identité du vendeur comprise (retirée par le SW)
    signals: Signal[];
    rulesVersion: number;
    scanKind: ScanKind;
    trigger: ScanTrigger;
    partial: boolean;
  }
  export type ContentAccess =
    | { status: "signedOut" }
    | { status: "noSubscription" }
    | { status: "active"; features: string[]; unlimited: boolean;
        remaining: { text: number | null; image: number | null; total: number | null } };
  export type BgRequest = … existant … | { type: "content/access" }
    | { type: "scan/run"; scan: ScanRequest } | { type: "ui/open-popup" };
  export const CONTENT_SCRIPT_MESSAGES: ReadonlySet<BgRequest["type"]>; // les 3 ci-dessus
  ```
- Produit, dans `lib/access.ts` : `accessOf(me: Me): ContentAccess` et `canUse(access: ContentAccess, feature: "text" | "image" | "cards"): boolean`.
- Produit, dans `lib/background-handlers.ts` :
  - `guardSender(handle, self, isSupportedPage: (url: URL) => boolean)` remplace `guardInternalSender`.
    - Une page de l'extension a droit à tout.
    - Un content script a droit uniquement à `CONTENT_SCRIPT_MESSAGES`, à trois conditions : `sender.id === self.id`, `sender.tab` présent, et `sender.url` sur un site pris en charge (`adapterFor(url) !== null`).
    - Tout autre cas répond `forbidden_sender`.
  - Le handler `content/access` répond `ok(ContentAccess)` :
    - sans jeton : `signedOut` ;
    - `session_expired` : `signedOut` ;
    - sinon : `accessOf(await api.getMe())`.

- [ ] **Étape 1 : tests**, dans `access.test.ts` et `background-handlers.test.ts`.
  - `accessOf` d'un essai :
    - `{ plan: "trial", features: ["card_icons","image_scan"], unlimited: false, quotas: [{scanKind:"text",remaining:3,…},{scanKind:"image",remaining:3,…}], totalCap: {remaining:3,…} }` donne `{ status: "active", features, unlimited: false, remaining: { text: 3, image: 3, total: 3 } }`.
  - `accessOf` avec `plan: null` donne `{ status: "noSubscription" }`.
  - `accessOf` d'un admin (`unlimited: true`) donne `remaining: { text: null, image: null, total: null }`.
  - `canUse` :
    - standard (`features: []`) : `"text"` vrai, `"image"` et `"cards"` faux ;
    - `noSubscription` et `signedOut` : tout faux ;
    - admin : tout vrai, même avec `features: []`.
  - `guardSender`, accès refusé (`forbidden_sender`) :
    - content script sur `https://www.2ememain.be/v/x/m1` qui envoie `auth/state` ;
    - même chose avec `auth/sign-out` ;
    - content script sur `https://evil.example/` qui envoie `content/access` ;
    - `sender.id` différent.
  - `guardSender`, accès accepté :
    - content script de ce même site qui envoie `content/access` ;
    - popup (sans `tab`, URL sous `chrome-extension://<id>/`) qui envoie `auth/state`.
  - Handler `content/access` :
    - sans jeton : `ok({status:"signedOut"})`, sans appel à `getMe` ;
    - `getMe` rejette `AuthError("session_expired")` : `ok({status:"signedOut"})` ;
    - `getMe` rejette `ApiRequestError(503, auth_unavailable)` : `fail("auth_unavailable")`.
- [ ] **Étape 2 :** les tests échouent.
- [ ] **Étape 3 : implémentation.** Brancher `guardSender` dans `entrypoints/background.ts`, avec `isSupportedPage = (url) => adapterFor(url) !== null`.
- [ ] **Étape 4 :** les tests passent, ainsi que typecheck et lint.
- [ ] **Étape 5 : commit.** `feat(extension): accès de la page et liste blanche des messages des content scripts`.

---

### Tâche 2 : requête de scan dans le service worker

**Fichiers :**
- Créer : `apps/extension/lib/scan-payload.ts`, `apps/extension/test/scan-payload.test.ts`
- Modifier : `apps/extension/lib/api-client.ts`, `apps/extension/lib/background-handlers.ts`, `apps/extension/entrypoints/background.ts`, `apps/extension/test/api-client.test.ts`, `apps/extension/test/background-handlers.test.ts`

**Interfaces :**
- Consomme : `ScanRequest` (tâche 1), et `ScanIn` et `AnalysisResult` de `@radarnaque/shared`.
- Produit, dans `lib/scan-payload.ts` :
  - `export const BOUNDS`, qui reprend les valeurs des contraintes globales ;
  - `toScanIn(req: ScanRequest): ScanIn`, qui retire l'identité du vendeur et tronque aux bornes ;
  - le titre vide après `trim()` lève `new ScanPayloadError("invalid_listing")`.
- Produit, dans `lib/api-client.ts` : `ApiClient.scan(body: ScanIn): Promise<AnalysisResult>`.
  - Il fait `POST /api/scans` avec `content-type: application/json`.
  - Il applique la même règle 401 que `getMe` : un renouvellement, puis la déconnexion.
- Produit, dans le service worker :
  - Le handler `scan/run` répond `ok(AnalysisResult)`, ou `fail(code)` :
    - le code de l'API (§7.5) pour une erreur de l'API ;
    - `session_expired` après un second 401 ;
    - `invalid_listing` pour `ScanPayloadError` ;
    - `network` en cas d'échec réseau.
  - Le handler `ui/open-popup` appelle `deps.openPopup()` (`browser.action.openPopup()` en production) et répond `ok(null)`, ou `fail("popup_unavailable")` si l'ouverture rejette.
  - `HandlerDeps` s'agrandit en conséquence : `api.scan` et `openPopup`.

- [ ] **Étape 1 : tests.**
  - `toScanIn` d'une annonce avec `seller: { id: "1", name: "X", profileUrl: "/u/x", reviewCount: 4 }` donne `seller: { reviewCount: 4 }`. Le JSON du corps ne contient ni `"X"` ni `"/u/x"`.
  - `toScanIn` tronque à exactement 300, 5 000, 200, 100, 64 et 100 caractères. Il garde les 10 premières images et les 20 premiers signaux.
  - Une chaîne de `params` de 250 caractères est coupée à 200. Un paramètre décimal (`1.5`) est retiré. Les clés au-delà de la dixième sont retirées.
  - `toScanIn` avec le titre `"   "` lève `ScanPayloadError` avec le code `invalid_listing`.
  - Le corps contient `rules: { version, signals: [{ id, weight, severity, params }] }`, ainsi que `scanKind`, `trigger` et `partial` repris de la requête.
  - Un champ facultatif absent reste absent ou `null`, jamais `""`.
  - `api.scan` :
    - fait un `POST` avec la bonne URL, le corps JSON et `authorization: Bearer <jwt>` ;
    - sur un 401 puis un 200, renouvelle le JWT une seule fois ;
    - sur deux 401, appelle `onUnauthenticated` et lève `AuthError("session_expired")` ;
    - sur un 402 `quota_exhausted`, lève `ApiRequestError` avec `body.error.details` intact.
  - Handler `scan/run` :
    - un succès répond `ok(result)` ;
    - un 502 `analysis_failed` répond `fail("analysis_failed")` ;
    - `ScanPayloadError` répond `fail("invalid_listing")`, sans appel réseau.
  - Handler `ui/open-popup` : `openPopup` qui rejette donne `fail("popup_unavailable")`.
- [ ] **Étape 2 :** les tests échouent.
- [ ] **Étape 3 : implémentation.**
- [ ] **Étape 4 :** les tests passent, ainsi que typecheck et lint.
- [ ] **Étape 5 : commit.** `feat(extension): scan IA envoyé par le service worker, identité du vendeur retirée et bornes appliquées`.

---

### Tâche 3 : section IA du panneau

**Fichiers :**
- Créer : `apps/extension/components/AiSection.tsx`, `apps/extension/lib/content/ai-client.ts`, `apps/extension/test/ai-section.test.tsx`
- Modifier : `apps/extension/lib/content-i18n.ts`, `apps/extension/test/content-i18n.test.ts`

**Interfaces :**
- Consomme : `ContentAccess`, `canUse` et `ScanRequest` (tâche 1), `AnalysisResult`, `BgResponse` et `sendToBackground`.
- Produit, dans `lib/content/ai-client.ts` :
  ```ts
  export interface AiClient {
    access(): Promise<BgResponse<ContentAccess>>;
    scan(req: ScanRequest): Promise<BgResponse<AnalysisResult>>;
    openLogin(): Promise<BgResponse<null>>;
  }
  export function createAiClient(send = sendToBackground): AiClient;
  export type ScanState =
    | { status: "idle" } | { status: "loading" }
    | { status: "done"; result: AnalysisResult } | { status: "error"; code: string };
  ```
- Produit, dans `components/AiSection.tsx` : le composant contrôlé, sans état réseau propre.
  ```ts
  AiSection(props: {
    locale: Locale;
    access: ContentAccess | "loading" | { error: string };
    hasPhotos: boolean;
    text: ScanState; image: ScanState;
    onScan(kind: ScanKind): void; onLogin(): void; loginUnavailable: boolean;
    pricingUrl: string;
  })
  ```
- Produit, dans `lib/content-i18n.ts` : les clés `ai.*` en FR et en NL. Valeurs FR exactes :

  | Clé | Texte FR |
  |---|---|
  | `ai.title` | « Analyse IA » |
  | `ai.run` | « Lancer une analyse IA » |
  | `ai.runPhotos` | « Analyse avec photos » |
  | `ai.loading` | « Analyse en cours… » |
  | `ai.login` | « Se connecter » |
  | `ai.loginHint` | « Connectez-vous pour lancer une analyse IA. » |
  | `ai.loginFallback` | « Cliquez sur l'icône Radarnaque dans la barre d'outils du navigateur pour vous connecter. » |
  | `ai.pricing` | « Voir les formules » |
  | `ai.fromCache` | « Résultat déjà disponible : servi depuis le cache. » |
  | `ai.partial` | « Analyse partielle : seules les informations de la carte étaient disponibles. » |
  | `ai.remaining` | « Analyses restantes : {count} » |
  | `ai.advice` | « Conseil » |
  | `ai.reasons` | « Pourquoi » |

  Codes d'erreur (`ai.error.<code>`) :

  | Clé | Texte FR |
  |---|---|
  | `ai.error.session_expired` et `ai.error.unauthenticated` | « Session expirée, reconnectez-vous. » |
  | `ai.error.no_active_subscription` | « Un abonnement est nécessaire pour lancer une analyse IA. » |
  | `ai.error.quota_exhausted` | « Vous avez utilisé toutes vos analyses de ce type pour cette période. » |
  | `ai.error.feature_not_in_plan` | « Cette analyse n'est pas comprise dans votre formule. » |
  | `ai.error.invalid_listing` | « Cette annonce ne peut pas être analysée (données illisibles). » |
  | `ai.error.rate_limited` | « Trop d'analyses en peu de temps. Réessayez dans une minute. » |
  | `ai.error.analysis_failed` | « L'analyse a échoué. Elle ne vous a pas été décomptée. Réessayez plus tard. » |
  | `ai.error.network` et `ai.error.background_unavailable` | « Connexion impossible. Vérifiez votre réseau. » |
  | `ai.error.default` | « Une erreur est survenue. Réessayez plus tard. » |

  Écrire les équivalents NL en néerlandais de Belgique.
- **Affichage :**
  - `signedOut`, ou erreur `session_expired`/`unauthenticated` : `ai.loginHint` et le bouton `ai.login`. Si `loginUnavailable` est vrai, afficher en plus `ai.loginFallback`.
  - `noSubscription`, `quota_exhausted` ou `feature_not_in_plan` : le message, puis un lien `ai.pricing` vers `pricingUrl`, avec `target="_blank"` et `rel="noopener"`.
  - Abonnement actif : bouton `ai.run`, puis bouton `ai.runPhotos` si `canUse(access, "image")` et `hasPhotos`.
  - Pendant l'analyse (`loading`) : le bouton est désactivé et affiche `ai.loading`.
  - Analyse terminée (`done`), dans cet ordre :
    - le niveau en toutes lettres, réutilisant `level.*`, et `score/100` ;
    - `summary[locale]` ;
    - `ai.advice` suivi de `advice[locale]` ;
    - `ai.reasons` suivi de la liste `reasons[].text[locale]` avec la gravité (`severity.*`) ;
    - `ai.fromCache` si `fromCache`, et `ai.partial` si `partial` ;
    - `ai.remaining` avec `remaining.total ?? remaining[kind]`, seulement si la valeur n'est pas `null`.

- [ ] **Étape 1 : tests** (Testing Library), dans `ai-section.test.tsx` et `content-i18n.test.ts`.
  - Parité exacte des clés `ai.*` entre FR et NL.
  - `signedOut` affiche le bouton « Se connecter », et le clic appelle `onLogin`.
  - `loginUnavailable` affiche en plus le texte de repli.
  - Plan standard actif (`features: []`) avec photos : « Lancer une analyse IA » est affiché, « Analyse avec photos » ne l'est pas.
  - Essai avec photos : les deux boutons sont affichés. Essai sans photo (`hasPhotos: false`) : seul le bouton texte est affiché.
  - `text: loading` : le bouton est désactivé et le texte « Analyse en cours… » est affiché.
  - `done`, en `nl` : `summary.nl`, `advice.nl` et les raisons NL sont affichés, sans aucun texte FR de l'IA. « Hoog risico » apparaît pour `level: "high"`.
  - `done` avec `remaining: { text: null, image: null, total: null }` : aucun texte « restantes ».
  - `fromCache: true` affiche `ai.fromCache`.
  - Erreur `quota_exhausted` : le message s'affiche, avec un lien dont le `href` vaut `pricingUrl`.
  - Erreur `analysis_failed` : le message s'affiche et le bouton est de nouveau actif.
  - Code inconnu : `ai.error.default` s'affiche.
  - `createAiClient(send)` envoie `{type:"content/access"}`, `{type:"scan/run", scan}` et `{type:"ui/open-popup"}`.
- [ ] **Étape 2 :** les tests échouent.
- [ ] **Étape 3 : implémentation.**
- [ ] **Étape 4 :** les tests passent, ainsi que typecheck et lint.
- [ ] **Étape 5 : commit.** `feat(extension): section IA du panneau (accès, boutons, résultat, erreurs FR/NL)`.

---

### Tâche 4 : analyse IA depuis la page d'une annonce

**Fichiers :**
- Créer : `apps/extension/lib/content/use-ai-scan.ts`, `apps/extension/test/use-ai-scan.test.tsx`
- Modifier :
  - `apps/extension/components/RiskBadge.tsx` (insérer `AiSection` dans le panneau ; le pied de panneau devient « Analyse locale, sans IA. Pour une analyse IA, utilisez le bouton ci-dessus. » en FR, et son équivalent NL) ;
  - `apps/extension/lib/content/controller.ts` ;
  - `apps/extension/lib/content/badge-mounter.ts` ;
  - `apps/extension/entrypoints/content.ts` ;
  - les tests existants concernés.

**Interfaces :**
- Consomme : tâche 3 (`AiClient`, `AiSection`, `ScanState`).
- Produit :
  - `Mounter.mount(anchor, view: BadgeView, locale)` et `Mounter.update(view, locale)`, avec `BadgeView = { report: RiskReport; listing: Listing }`. Le contrôleur passe désormais l'annonce extraite. La clé de mise à jour (`mountedKey`) comprend en plus `listing.title` et `listing.description` : une annonce modifiée entraîne `update`.
  - `useAiScan(client: AiClient, view: BadgeView, locale)`, qui renvoie `{ access, text, image, scan(kind), login(), loginUnavailable }`.
    - L'accès est chargé à la première ouverture du panneau, puis relu après chaque scan, réussi ou non.
    - Un scan en cours pour un type n'en lance pas un second.
    - Les états sont liés à l'annonce par la clé `listing.site + listing.externalId`. Si la clé change, les états reviennent à `idle`, et une réponse arrivée pour l'ancienne clé est ignorée.
- `RiskBadge({ report, listing, locale, ai })` : le paramètre `ai` est l'`AiClient` injecté par `content.ts`, avec `createAiClient()`.
- `pricingUrl` vaut `${PUBLIC_URL}/pricing/?lang=${locale}`.

- [ ] **Étape 1 : tests.**
  - `useAiScan`, double appel à `scan("text")` pendant que le premier est en cours : un seul `client.scan`.
  - `useAiScan`, la clé change (nouvelle annonce) pendant un scan en cours : quand la réponse arrive, `text.status` reste `idle` pour la nouvelle annonce.
  - `useAiScan`, la réponse `fail("session_expired")` donne `text = { status: "error", code: "session_expired" }`, et `client.access` est rappelé.
  - `useAiScan`, `login()` sur `fail("popup_unavailable")` donne `loginUnavailable` vrai.
  - `RiskBadge` : ouvrir le panneau, lancer une analyse, fermer puis rouvrir le panneau. Le résultat est toujours affiché et `client.scan` n'a été appelé qu'une fois. Le composant reste monté : seul le panneau se ferme.
  - `RiskBadge` : la requête envoyée contient `listing` (complet), `signals` et `rulesVersion` du rapport, avec `scanKind: "text"`, `trigger: "button"` et `partial: false`.
  - Contrôleur et mounter : les tests existants sont adaptés pour passer `BadgeView`. Un changement de description entraîne `update`, sans remontage.
- [ ] **Étape 2 :** les tests échouent.
- [ ] **Étape 3 : implémentation.**
- [ ] **Étape 4 :** les tests passent, ainsi que typecheck et lint, et `pnpm --filter extension build` réussit.
- [ ] **Étape 5 : commit.** `feat(extension): analyse IA depuis la page d'une annonce`.

---

### Tâche 5 : cartes Facebook Marketplace

**Fichiers :**
- Modifier : `apps/extension/lib/adapters/types.ts`, `apps/extension/lib/adapters/facebook.ts`, `apps/extension/lib/adapters/twh.ts` (implémentation vide pour l'instant), `apps/extension/test/facebook-adapter.test.ts`

**Interfaces :**
- Produit, dans `MarketplaceAdapter` :
  ```ts
  export interface CardRef { element: Element; externalId: string; url: string } // url absolue de la fiche
  findCards(root: ParentNode, pageUrl: URL): CardRef[];  // [] hors page de recherche
  cardAnchor(card: Element): Element | null;               // l'icône est insérée APRÈS cet élément
  listingFromCard?(card: Element, pageUrl: URL): Listing | null; // repli `partial` (Facebook)
  ```
- **Facebook :**
  - Une carte est un `a[href*="/marketplace/item/"]` hors `[role="dialog"]`. Son id vient de l'URL ; les doublons sont dédupliqués par id.
  - `url` vaut `https://www.facebook.com/marketplace/item/<id>/`, sans paramètres de suivi.
  - `cardAnchor` : le dernier élément de texte du titre dans la carte, ou la carte elle-même.
  - `listingFromCard` reprend titre, prix (avec la même lecture que la fiche), première image et lieu.
    - `description` vaut `""`, `seller` vaut `{}` et `priceType` est déduit comme pour la fiche.
    - Si aucun titre n'est trouvé, la fonction rend `null`.
- **2ememain** (`twhAdapter`) : `findCards` rend `[]` et `cardAnchor` rend `null` jusqu'à la tâche 6.

- [ ] **Étape 1 : tests**, sur `test/fixtures/facebook/grid.html` et `item-modal.html`.
  - `findCards` sur la grille (URL `https://www.facebook.com/marketplace/brussels/`) renvoie les 6 cartes avec les ids `9000000000000001` à `9000000000000006`, dans l'ordre du document.
  - `findCards` sur `item-modal.html` (URL de la fiche) n'inclut aucune carte située sous `[role="dialog"]`.
  - Chaque `url` est absolue et se termine par `/marketplace/item/<id>/`.
  - `listingFromCard` de la carte `GRATUIT` donne `priceType: "free"`. Celle à `€ 1 234` donne `price.amountCents === 123400`.
  - Toutes donnent `description: ""` et `seller: {}`.
  - `cardAnchor` ne renvoie jamais `null` pour les 6 cartes.
- [ ] **Étape 2 :** les tests échouent.
- [ ] **Étape 3 : implémentation.** S'appuyer uniquement sur les sélecteurs autorisés au §4.3 : liens `/marketplace/item/`, ARIA, libellés. Aucune classe CSS.
- [ ] **Étape 4 :** les tests passent, ainsi que typecheck et lint.
- [ ] **Étape 5 : commit.** `feat(extension): cartes des résultats Facebook Marketplace`.

---

### Tâche 6 : cartes 2ememain et 2dehands (nouvelle fixture)

**Prérequis, bloquant :** une page de résultats de recherche 2ememain enregistrée par l'utilisateur dans `web-pages/`, avec « Enregistrer sous… → Page Web complète ». Une page 2dehands est utile mais facultative. Sans cette page, s'arrêter et répondre `BLOCKED`.

**Fichiers :**
- Créer : `apps/extension/test/fixtures/twh/search.html`
- Modifier : `apps/extension/test/fixtures/README.md` (ligne du tableau et valeurs fictives), `apps/extension/lib/adapters/twh.ts`, `apps/extension/test/twh-adapter.test.ts`, et la liste locale `web-pages/.denylist.txt` (ajouts seulement, jamais affichés)

**Interfaces :**
- Consomme : `CardRef`, `findCards` et `cardAnchor` (tâche 5).
- **2ememain :**
  - `pageType` vaut `"search"` si l'URL commence par `/l/` ou `/q/` et que la page contient au moins une carte. `"listing"` est inchangé.
  - Une carte est un élément de liste de résultats qui contient un lien vers `/v/…/m<chiffres>-…`. L'id est `m<chiffres>`, et `url` est absolue sur le même hôte. Les annonces sponsorisées hors site (lien sans `/v/`) sont ignorées.
  - `cardAnchor` : le titre de la carte.

- [ ] **Étape 1 : fixture.** Suivre la procédure du README :
  - garder au plus 8 cartes, dont une sponsorisée si la page en contient ;
  - ids fictifs `m1000000101` à `m1000000108` ;
  - vendeurs `TestVendeur` ;
  - photos `//images.example/twh/<n>` ;
  - ajouter les vraies valeurs à `web-pages/.denylist.txt`, sans les afficher.

  Lancer `pnpm --filter extension test -- fixtures-hygiene`. Résultat attendu : PASS.
- [ ] **Étape 2 : tests.**
  - `pageType` de `https://www.2ememain.be/q/iphone/` sur la fixture vaut `"search"`. Celui de `https://www.2ememain.be/` vaut `"other"`.
  - `findCards` renvoie les cartes non sponsorisées, avec leurs ids fictifs dans l'ordre et une URL absolue en `https://www.2ememain.be/v/…`.
  - Sur `2dehands.be`, l'hôte de l'URL des cartes suit l'hôte de la page.
  - `cardAnchor` n'est jamais `null`.
- [ ] **Étape 3 :** les tests échouent, puis implémentation.
- [ ] **Étape 4 :** les tests passent, ainsi que typecheck et lint.
- [ ] **Étape 5 : commit.** `feat(extension): cartes des résultats 2ememain et 2dehands`. La fixture et le README sont dans le commit ; `web-pages/` n'y est jamais.

---

### Tâche 7 : icônes sur les cartes et analyse depuis une carte

**Fichiers :**
- Créer :
  - `apps/extension/lib/content/card-scan.ts` ;
  - `apps/extension/lib/content/card-controller.ts` ;
  - `apps/extension/components/CardBadge.tsx` ;
  - `apps/extension/test/card-scan.test.ts` ;
  - `apps/extension/test/card-controller.test.ts` ;
  - `apps/extension/test/card-badge.test.tsx`.
- Modifier : `apps/extension/entrypoints/content.ts`, `apps/extension/lib/content-i18n.ts` (clés `card.*`)

**Interfaces :**
- Consomme : tâches 1 à 6.
- Produit, dans `card-scan.ts` :
  ```ts
  scanCard(card: CardRef, deps: {
    pageUrl: URL; adapter: MarketplaceAdapter; ai: AiClient;
    fetchPage(url: string): Promise<string>;
  }): Promise<BgResponse<AnalysisResult>>
  export function defaultFetchPage(url: string): Promise<string>; // fetch(url, { credentials: "include", signal: AbortSignal.timeout(10_000) }) ; rejette si !res.ok
  ```
  - `card.url` n'a pas la même origine que `pageUrl` : `fail("invalid_listing")`, sans requête.
  - Sinon :
    - `fetchPage`, puis `DOMParser`, puis `adapter.extractListing(doc, new URL(card.url))` ;
    - les règles sont évaluées avec `evaluate`, en marquant comme inconnus les champs de `missing` ;
    - puis `ai.scan({ …, scanKind: "text", trigger: "card", partial: false })`.
  - Si l'extraction échoue ou que la page est illisible, et que `adapter.listingFromCard` existe :
    - l'annonce de la carte est utilisée avec `partial: true` ;
    - `description` et `images` sont marqués inconnus pour les règles.
  - Si l'extraction échoue et qu'il n'y a pas de repli : `fail("invalid_listing")`.
- Produit, dans `card-controller.ts` : `createCardController(deps)` renvoie `{ refresh(): Promise<void>; dispose(): void }`.
  - `deps` contient `doc`, `getUrl`, `ai`, `mountCard(anchor, card, adapter)`, `unmountAll()` et `getLocale`.
  - Sur une page `"search"`, il lit l'accès une fois par page (relu à chaque `wxt:locationchange`).
  - Il ne fait rien sans `canUse(access, "cards")`.
  - Il pose une icône par carte non encore marquée (`data-radarnaque-card="<externalId>"`).
  - Il retire les icônes quand la page n'est plus une page de recherche.
  - `MutationObserver` limité à 250 ms, comme `controller.ts`, en ignorant ses propres insertions (balise `radarnaque-card`).
- Produit, dans `CardBadge.tsx` :
  - inactif : un bouton rond avec la lettre « R », `aria-label` = `card.aria` (« Analyser cette annonce avec Radarnaque » / « Deze advertentie analyseren met Radarnaque ») ;
  - au clic : `preventDefault()` et `stopPropagation()`, pour que la carte-lien ne navigue pas, puis `loading` (« … », `aria-busy`) ;
  - `done` : le niveau en toutes lettres (`level.*`) avec le point de couleur. Au survol ou au focus, une infobulle `role="tooltip"` montre `summary[locale]`, plus `ai.partial` si `partial` ;
  - `error` : le message `ai.error.<code>`, abrégé dans l'infobulle. Un nouveau clic relance.

- [ ] **Étape 1 : tests.**
  - `scanCard`, extraction réussie : `fetchPage` est appelé avec `card.url` et `ai.scan` reçoit `trigger: "card"`, `partial: false`, ainsi que les signaux évalués sur l'annonce récupérée.
    - Le HTML à extraire est celui de la fixture `twh/listing-fixed.html`, avec `pageUrl` `https://www.2ememain.be/q/iphone/`.
  - `scanCard`, Facebook, HTML sans fiche lisible (`<html><body></body></html>`) : `listingFromCard` est utilisé et `partial: true` est envoyé.
  - `scanCard`, carte d'une autre origine : `fail("invalid_listing")`, sans appel à `fetchPage`.
  - `scanCard`, `fetchPage` qui rejette, sur un adaptateur sans repli : `fail("invalid_listing")`.
  - `card-controller`, page de recherche avec accès `card_icons` : 6 icônes sur `grid.html`, et un second `refresh` n'en ajoute aucune.
  - `card-controller`, accès standard (`features: []`) ou `signedOut` : aucune icône.
  - `card-controller` : une carte ajoutée au DOM (défilement infini) reçoit son icône après le délai de 250 ms.
  - `card-controller` : passage à une URL de fiche, aucune icône ne reste.
  - `CardBadge` : dans un `<a href="https://www.facebook.com/marketplace/item/1/">`, le clic sur le bouton a un événement `defaultPrevented` et ne remonte pas au lien. L'état `done` avec `level: "medium"` affiche « Risque moyen », et l'infobulle contient `summary.fr`.
- [ ] **Étape 2 :** les tests échouent.
- [ ] **Étape 3 : implémentation.**
  - Dans `content.ts`, créer le contrôleur de cartes à côté du contrôleur de fiche, avec le même `ctx`.
  - L'icône est montée par `createShadowRootUi` avec `name: "radarnaque-card"`, `position: "inline"`, `append: "after"`.
- [ ] **Étape 4 :** les tests passent, ainsi que typecheck et lint, et `pnpm --filter extension build` réussit.
- [ ] **Étape 5 : commit.** `feat(extension): icônes Radarnaque sur les cartes et analyse IA au clic`.

---

### Tâche 8 : documentation et essai manuel

**Fichiers :**
- Modifier : `README.md` (nouvelle section « Tester les analyses IA dans l'extension »), `docs/superpowers/plans/2026-10-17-phase-3a-suivi.md` (retirer ce qui est fait, ajouter ce qui reste), `docs/superpowers/plans/2026-10-17-phase-2-suivi.md` (messagerie : fait)

- [ ] **Étape 1 :** README.
  - Prérequis : stack lancée, compte connecté dans la popup, et fournisseur LLM actif (Groq ou openai-oauth).
  - Sur une annonce 2ememain : pastille, puis « Lancer une analyse IA ».
  - Sur une recherche 2ememain ou Facebook : icône « R », puis clic.
  - Ce qu'il faut voir : niveau, résumé, quota restant qui baisse, « servi depuis le cache » au second clic.
  - Rappel : sur Facebook, l'analyse depuis une carte est souvent partielle, parce que la fiche récupérée sans JavaScript ne contient pas les données complètes.
- [ ] **Étape 2 :** mettre à jour les deux documents de suivi.
- [ ] **Étape 3 : commit.** `docs: tester les analyses IA dans l'extension`.
