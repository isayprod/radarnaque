# Phase 2 — Adaptateurs et règles locales : plan d'implémentation

> **Pour les agents :** sous-skill OBLIGATOIRE : utiliser superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans pour exécuter ce plan tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`) pour le suivi.

**Objectif :** sur la page d'une annonce 2ememain, 2dehands ou Facebook Marketplace, l'extension affiche une pastille de risque calculée **localement**. Le calcul repose sur des règles, sans réseau et sans compte. Au clic, un panneau liste les signaux détectés, en FR ou en NL.

**Architecture :**
- Un content script WXT choisit l'adaptateur selon le site.
- L'adaptateur transforme la page rendue en objet universel `Listing`, en lisant les données structurées en priorité et le DOM en repli.
- Un moteur de règles pur calcule les signaux, le score et le niveau.
- Une interface React montée dans un Shadow DOM s'ancre près du titre.
- Rien ne quitte le navigateur, et le content script n'envoie aucun message au service worker.

**Pile technique :** WXT 0.21 (content script, `createShadowRootUi`), React 19, Tailwind 4, TypeScript 6.0, Vitest 5 + happy-dom + Testing Library. Tout se passe dans `apps/extension`.

**Spec :** `docs/superpowers/specs/2026-10-16-radarnaque-v4-design.md`, §4.2 à §4.5 et §4.7 (phase 2 = §13 point 2). Pour le contexte, voir aussi les points de suivi de la phase 1 dans `docs/superpowers/plans/2026-10-16-phase-1-suivi.md`.

**Recherche (locale, NON commitée) :**
- `.superpowers/phase-2-page-analysis.md` : sélecteurs, chemins JSON et pièges, établis à partir de pages réelles.
- `web-pages/` : les pages brutes enregistrées. **Elles contiennent des données personnelles et des jetons de session. Ne jamais les copier, les citer ou les commiter.**

## Contraintes globales

- **Confidentialité :**
  - le dépôt GitHub est **public** ;
  - seules des fixtures **minimisées et anonymisées** (tâche 2) entrent dans le dépôt ;
  - `web-pages/`, `video/` et `.superpowers/` restent ignorés et ne doivent jamais être modifiés.
- **Aucun réseau en phase 2 :**
  - le content script ne fait ni `fetch` ni `browser.runtime.sendMessage` ;
  - il ne lit jamais `window.__ENV_CONFIG__`, `__HEADER_CONFIG__`, `dataLayer`, `bannerParameters` ni aucune donnée du **visiteur**. Seules les données de l'annonce et du vendeur sont lues.
- **Sélecteurs autorisés :**
  - interdits : les classes CSS obfusquées de Facebook (`x1abc…`) et les classes hachées ;
  - autorisés : `id`, attributs, ARIA, `data-*`, motifs d'URL, libellés textuels FR/NL/EN.
- **Données structurées d'abord, DOM ensuite.** « Inconnu » (`undefined`) n'est jamais un signal de risque.
- **Isolation :** toute l'UI injectée vit dans un **Shadow DOM** (`createShadowRootUi`, `cssInjectionMode: "ui"`) et l'injection est **idempotente**, via l'attribut `data-radarnaque` sur l'ancre.
- **Score :** la somme des poids est plafonnée à 100. Niveaux : `low` de 0 à 29, `medium` de 30 à 59, `high` à partir de 60. `RULES_VERSION = 1`.
- **Langue :** `localePref` si elle est définie ; sinon `nl` sur 2dehands.be, `fr` sur 2ememain.be, et sur Facebook `nl` si la langue du navigateur commence par `nl`, sinon `fr`.
- **Messages :** tous les textes de règles et d'interface existent en FR **et** NL, et un test vérifie la parité des clés.
- Les commits se terminent par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. TDD pour tout le code.

### Modèle `Listing`, adapté aux données réelles (écart au spec §4.2, voir tâche 1)

Les sites donnent l'ancienneté du vendeur sous forme de durée (« 10 ans ») ou d'année (« A rejoint Facebook en 2007 »), jamais sous forme de date. Le champ `seller.memberSince?: string` du spec est donc remplacé par `seller.accountAgeMonths?: { min: number; max: number }`.

### Règles du MVP, avec leurs poids et conditions exactes

| id | Poids | Gravité | Condition (vraie ⇒ signal) |
|---|---|---|---|
| `few_photos` | 15 | warning | `images.length <= 1` |
| `new_account` | 25 | danger | `seller.accountAgeMonths` défini **et** `max < 3` |
| `no_reviews` | 10 | warning | `seller.reviewCount === 0` |
| `foreign_location` | 20 | warning | `location.country` défini **et** différent de `"BE"` |
| `short_description` | 10 | info | `description.trim().length < 30` |
| `contact_outside` | 25 | danger | titre et description contiennent un téléphone, un email, `whatsapp`, `telegram` ou `signal` (voir tâche 4) |
| `shipping_only` | 15 | warning | mots-clés « envoi uniquement », « pas de remise en main propre », « alleen verzenden », « geen ophalen », « shipping only » |
| `offsite_payment` | 35 | danger | « western union », « moneygram », « paiement à l'avance », « vooraf betalen », « lien de paiement », « betaallink », « paypal amis », « paypal vrienden », « friends and family », « payconiq vooraf » |
| `symbolic_price` | 20 | warning | `priceType` différent de `"free"` **et** `price` vaut `0` à `100` cents (0 à 1 €) |
| `price_anomaly` | — | — | **désactivée** : présente dans le registre avec `enabled: false`, jamais évaluée |

## Points de vigilance

1. **Facebook peut rendre la fiche en modale par-dessus la grille, ou en page directe.** Les deux doivent produire le même `Listing`, et la navigation interne vers une autre annonce doit remplacer la pastille, pas l'empiler. Tâches 6 et 9.
2. **Sur 2ememain, la section vendeur détaillée se charge après coup** (avis, vérification). La pastille doit se mettre à jour quand ces données arrivent, sans se dupliquer. Tâche 9.
3. **Prix aux formats variés :** `€ 60,00`, `8 500 €` (espace insécable U+00A0), `€ 23 500` (espace fine U+202F), `GRATUIT`, `Gratis`, `€ 0`, `€ 1 234`. Un prix mal lu ne doit jamais déclencher `symbolic_price` à tort. Tâche 1.
4. **Le visiteur n'est pas le vendeur :** la ville, le code postal et la date de création du compte du visiteur sont présents dans la page 2ememain, et un test doit garantir qu'ils ne fuient pas dans le `Listing`. Tâche 5.
5. **Une page dont l'extraction échoue** (structure modifiée par le site) ne doit ni planter ni afficher un faux « risque faible ». Rien ne s'affiche, et une seule ligne `console.debug` donne la raison. Tâche 9.

---

## Structure des fichiers (tout dans `apps/extension/`)

```
lib/listing/types.ts          Listing, Locale du site, PageType
lib/listing/parse.ts          parsePriceText, parseAccountAge, parseFacebookJoinYear, normalizeText
lib/adapters/types.ts         MarketplaceAdapter
lib/adapters/twh.ts           2ememain + 2dehands
lib/adapters/facebook.ts      Facebook Marketplace
lib/adapters/registry.ts      adapterFor(url)
lib/rules/keywords.ts         listes de mots-clés FR/NL/EN
lib/rules/rules.ts            règles, registre, RULES_VERSION
lib/rules/score.ts            evaluate(listing) → RiskReport
lib/content-i18n.ts           textes FR/NL des règles et de l'UI injectée, resolveContentLocale
components/RiskBadge.tsx      pastille + panneau (React)
components/badge.css          styles Tailwind de l'UI injectée
lib/content/controller.ts     cycle de vie : détecter, extraire, monter, mettre à jour, retirer
entrypoints/content.ts        defineContentScript (matches, cssInjectionMode "ui")
test/fixtures/twh/*.html, test/fixtures/facebook/*.html
test/fixtures-hygiene.test.ts, test/parse.test.ts, test/twh-adapter.test.ts,
test/facebook-adapter.test.ts, test/rules.test.ts, test/content-i18n.test.ts,
test/risk-badge.test.tsx, test/controller.test.ts
```

---

### Tâche 1 : types `Listing` et fonctions d'analyse de texte (et mise à jour du spec)

**Fichiers :**
- Créer : `lib/listing/types.ts`, `lib/listing/parse.ts` et `test/parse.test.ts`
- Modifier : le spec, §4.2 (remplacer `memberSince` par `accountAgeMonths` et ajouter `location.region`) et §4.4 (tableau des poids ci-dessus)

**Interfaces :**
- Produit :
  ```ts
  export type Site = "2ememain.be" | "2dehands.be" | "facebook.com";
  export type PageType = "listing" | "search" | "other";
  export interface Listing {
    site: Site; externalId: string; url: string; title: string; description: string;
    price: { amountCents: number; currency: "EUR" } | null;
    priceType: "fixed" | "bidding" | "free" | "unknown";
    category?: string; condition?: string; postedAt?: string;
    location: { city?: string; region?: string; country?: string };
    images: string[];
    seller: { id?: string; name?: string; profileUrl?: string;
              accountAgeMonths?: { min: number; max: number };
              reviewCount?: number; rating?: number; otherListingsCount?: number; verified?: boolean };
  }
  ```
  - `parsePriceText(text: string): { price: Listing["price"]; priceType: Listing["priceType"] } | null`
  - `parseAccountAge(text: string): { min: number; max: number } | null` (FR/NL : « 10 ans », « 1 an », « 6 mois », « 3 semaines », « 10 jaar », « 6 maanden », « 3 weken »)
  - `parseFacebookJoinYear(text: string, now: Date): { min: number; max: number } | null`
  - `normalizeText(s: string): string` (supprime les espaces en trop et normalise U+00A0 et U+202F en espace)

- [ ] **Étape 1 : écrire les tests qui échouent.**
  ```ts
  test.each([
    ["€ 60,00", { price: { amountCents: 6000, currency: "EUR" }, priceType: "fixed" }],
    ["8 500 €", { price: { amountCents: 850000, currency: "EUR" }, priceType: "fixed" }],
    ["€ 23 500", { price: { amountCents: 2350000, currency: "EUR" }, priceType: "fixed" }],
    ["50 €", { price: { amountCents: 5000, currency: "EUR" }, priceType: "fixed" }],
    ["€ 1 234", { price: { amountCents: 123400, currency: "EUR" }, priceType: "fixed" }],
    ["GRATUIT", { price: null, priceType: "free" }], ["Gratis", { price: null, priceType: "free" }],
    ["€ 0", { price: { amountCents: 0, currency: "EUR" }, priceType: "fixed" }],
  ])("parsePriceText(%j)", (input, expected) => expect(parsePriceText(input)).toEqual(expected));
  test("parsePriceText returns null for non-price text", () => {
    expect(parsePriceText("Mons, WAL")).toBeNull(); expect(parsePriceText("")).toBeNull();
  });
  test.each([
    ["10 ans", { min: 120, max: 131 }], ["1 an", { min: 12, max: 23 }], ["6 mois", { min: 6, max: 6 }],
    ["3 semaines", { min: 0, max: 0 }], ["10 jaar", { min: 120, max: 131 }], ["6 maanden", { min: 6, max: 6 }],
    ["3 weken", { min: 0, max: 0 }],
  ])("parseAccountAge(%j)", (input, expected) => expect(parseAccountAge(input)).toEqual(expected));
  test("parseFacebookJoinYear", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    expect(parseFacebookJoinYear("A rejoint Facebook en 2007", now)).toEqual({ min: 225, max: 237 });
    expect(parseFacebookJoinYear("Joined Facebook in 2026", now)).toEqual({ min: 0, max: 9 });
    expect(parseFacebookJoinYear("Lid van Facebook sinds 2026", now)).toEqual({ min: 0, max: 9 });
    expect(parseFacebookJoinYear("Membre depuis peu", now)).toBeNull();
  });
  ```
  Règle de calcul pour une année Y, avec `now` : `max` = nombre de mois complets entre le 1er janvier de Y et `now` ; `min` = nombre de mois complets entre le 31 décembre de Y et `now`, plancher 0.
- [ ] **Étape 2 : lancer `pnpm --filter extension test -- parse`.** Résultat attendu : ÉCHEC (module introuvable).
- [ ] **Étape 3 : implémenter `types.ts` et `parse.ts`.** Pour les prix :
  - le séparateur de milliers est un espace quelconque (ordinaire, U+00A0, U+202F) ou un point ;
  - le séparateur décimal est une virgule ;
  - « gratuit », « gratis » et « free » (sans tenir compte de la casse) donnent `free`.
- [ ] **Étape 4 : mettre à jour le spec**, §4.2 (`accountAgeMonths` et `location.region`) et §4.4 (tableau des poids et conditions, repris tel quel des Contraintes globales).
- [ ] **Étape 5 : relancer les tests.** Résultat attendu : ils passent. Commit : `feat(extension): modèle Listing et analyse des prix et de l'ancienneté`.

---

### Tâche 2 : fixtures minimisées et anonymisées, et test d'hygiène

**Fichiers :**
- Créer :
  - `test/fixtures/twh/listing-fixed.html` (à partir de la page iPhone) ;
  - `test/fixtures/twh/listing-bidding-skeleton.html` (à partir de la page Dior : prix `MIN_BID`, section vendeur en squelette) ;
  - `test/fixtures/facebook/grid.html` ;
  - `test/fixtures/facebook/item-modal.html` ;
  - `test/fixtures/facebook/item-page.html` (même fiche sous `[role="main"]`, sans dialogue) ;
  - `test/fixtures/README.md` (origine, procédure, règles d'anonymisation) ;
  - `test/fixtures-hygiene.test.ts`.

**Interfaces :**
- Produit : les fixtures, que les tâches 5, 6 et 9 chargent avec `loadFixture(path): Document`, à ajouter à `test/helpers.ts`. Cette fonction lit le fichier avec `readFileSync`, puis `new DOMParser().parseFromString(html, "text/html")`.
- Valeurs fictives **imposées** :

| Donnée | Valeur |
|---|---|
| Identifiant vendeur 2ememain | `10000001` |
| Identifiant chiffré | 32 caractères `0` suivis de `1` |
| Nom du vendeur | `TestVendeur` |
| URL du profil | `/u/testvendeur/10000001/` |
| Ville | `Namur` |
| Photos | `//images.example/twh/<n>$_86` (garder le **nombre réel** de photos) |
| Vendeur Facebook | `/marketplace/profile/10000001/`, `aria-label="Vendeur Test"` |
| Photos Facebook | `https://images.example/fb/<n>.jpg` |
| Lieu de l'annonce Facebook | `Namur, WAL` |
| Identifiants d'annonces Facebook de la grille | `9000000000000001` à `…006` |

- **À garder ou retirer**, selon la recherche locale §6.3 (procédure pas à pas) :
  - 2ememain : garder le JSON-LD, `window.__CONFIG__` nettoyé (**sans** `latitude`/`longitude`) et le DOM utile. Supprimer `__ENV_CONFIG__`, `__HEADER_CONFIG__`, `dataLayer`, les bannières, tous les `<script src>`, les styles, le SVG, `#header-root` et le pied de page.
  - Facebook : supprimer les 215 blocs JSON, tous les scripts, styles et `class`, le bandeau, les notifications et le menu profil. Grille : 6 cartes (3 avec `aria-label`, 3 sans, dont une avec prix barré, une `GRATUIT` et une `€ 1 234`).
  - Fixture Facebook `item-modal.html` : garder « A rejoint Facebook en 2007 », 5 photos, et 2 cartes de grille sous la modale.
- Le script de génération éventuel reste **hors dépôt**, dans `.superpowers/`. Seules les fixtures sont commitées.

- [ ] **Étape 1 : écrire `fixtures-hygiene.test.ts`.** Pour chaque fichier de `test/fixtures/**`, le test échoue si le contenu correspond (insensible à la casse) à l'un de ces motifs : `DTSGInit`, `"LSD"`, `jazoest`, `fb_dtsg`, `xsrf`, `__user=`, `"USER_ID"`, `encryptedUserId`, `fingerPrint`, `sha256_email`, `scontent`, `fbcdn.net`, `chrome-extension://`, `bis_`, `latitude`, `longitude`, `__ENV_CONFIG__`, `__HEADER_CONFIG__`, `dataLayer`, `<script src`.
  - Il échoue aussi sur toute valeur listée dans `web-pages/.denylist.txt` (une valeur par ligne), **si ce fichier existe**. Le fichier est local et non commité : le test ignore son absence (cas de la CI).
  - Il échoue enfin si un fichier dépasse 40 Ko.
- [ ] **Étape 2 : créer `web-pages/.denylist.txt`** (local, ignoré par git) avec les vraies valeurs repérées dans `.superpowers/phase-2-page-analysis.md` §6 : noms, identifiants, ville et code postal du visiteur, identifiants et noms des vendeurs, identifiants des annonces Facebook réelles. Vérifier que `git check-ignore web-pages/.denylist.txt` le confirme.
- [ ] **Étape 3 : produire les 5 fixtures**, puis lancer `pnpm --filter extension test -- fixtures-hygiene`. Résultat attendu : le test passe, avec la liste locale présente. Lancer aussi `wc -c test/fixtures/**/*.html`. Résultat attendu : chaque fichier fait moins de 40 Ko.
- [ ] **Étape 4 : relire chaque fixture à l'œil.** Le rapport de tâche doit lister les éléments retirés et les remplacements effectués. Commit : `test(extension): fixtures anonymisées des marketplaces et test d'hygiène`.

---

### Tâche 3 : contrat des adaptateurs et registre

**Fichiers :**
- Créer : `lib/adapters/types.ts`, `lib/adapters/registry.ts` et `test/registry.test.ts`

**Interfaces :**
- Consomme : `Listing`, `PageType` et `Site` (tâche 1).
- Produit :
  ```ts
  export interface ExtractResult { listing: Listing; missing: string[] }  // champs non trouvés, pour le debug
  export interface MarketplaceAdapter {
    id: "twh" | "facebook";
    sites: Site[];
    siteOf(url: URL): Site | null;
    pageType(url: URL, doc: Document): PageType;
    extractListing(doc: Document, url: URL): ExtractResult | null;   // null = pas une fiche exploitable
    listingRoot(doc: Document, url: URL): Element | null;
    badgeAnchor(root: Element): Element | null;                     // l'UI est insérée APRÈS cet élément
  }
  export function adapterFor(url: URL): MarketplaceAdapter | null;
  ```
  `findCards`, prévu par le spec, viendra en phase 3 avec les icônes sur les cartes. On ne l'implémente pas ici (YAGNI).

- [ ] **Étape 1 : écrire les tests.**
  - `adapterFor` renvoie `twh` pour `https://www.2ememain.be/v/...` et `https://www.2dehands.be/...`.
  - Il renvoie `facebook` pour `https://www.facebook.com/marketplace/item/1/`.
  - Il renvoie `null` pour `https://example.com/` et pour `https://www.2ememain.be.evil.com/`.
  - Pour ce test, `twh` et `facebook` sont des modules simulés qui exportent seulement `id`, `sites` et `siteOf`.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter.** La correspondance se fait sur le nom d'hôte **exact** ou sur le sous-domaine `www.` (`hostname === d || hostname === "www." + d`), jamais avec `includes` ou `endsWith` seuls.
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : ils passent. Commit : `feat(extension): contrat des adaptateurs et registre`.

---

### Tâche 4 : moteur de règles et score

**Fichiers :**
- Créer : `lib/rules/keywords.ts`, `lib/rules/rules.ts`, `lib/rules/score.ts` et `test/rules.test.ts`

**Interfaces :**
- Consomme : `Listing` (tâche 1).
- Produit :
  ```ts
  export const RULES_VERSION = 1;
  export type Severity = "info" | "warning" | "danger";
  export type RuleId = "few_photos" | "new_account" | "no_reviews" | "foreign_location" | "short_description"
    | "contact_outside" | "shipping_only" | "offsite_payment" | "symbolic_price" | "price_anomaly";
  export interface Signal { id: RuleId; weight: number; severity: Severity; params?: Record<string, string | number> }
  export interface Rule { id: RuleId; weight: number; severity: Severity; enabled: boolean; check(l: Listing): Signal | null }
  export const RULES: readonly Rule[];
  export type RiskLevel = "low" | "medium" | "high";
  export interface RiskReport { score: number; level: RiskLevel; signals: Signal[]; rulesVersion: number }
  export function evaluate(listing: Listing): RiskReport;   // ignore les règles enabled=false
  export function levelOf(score: number): RiskLevel;
  ```
- **Détection de `contact_outside`**, sur le titre et la description en minuscules, après `normalizeText` :
  - téléphone belge ou international : `(\+32|0032|0)\s?4\d{2}([\s./-]?\d{2}){3}` ou `\+\d{2,3}[\s./-]?\d{2,3}([\s./-]?\d{2,3}){2,4}` ;
  - email : `[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}` ;
  - applications : `whatsapp`, `whats app`, `wa.me`, `telegram`, `t.me/`, et `signal` **uniquement** dans les expressions « sur signal », « via signal », « op signal » ou « signal app ».
  - `params.kind` vaut `"phone"`, `"email"` ou `"app"`.
- **Mots-clés** de `shipping_only` et `offsite_payment` : ceux du tableau des Contraintes globales, comparés sans tenir compte des accents ni de la casse (normalisation NFD et suppression des diacritiques).

- [ ] **Étape 1 : écrire les tests.**
  - Une fabrique `makeListing(overrides)` dans le fichier de test fournit un `Listing` neutre qui ne déclenche aucune règle : 3 photos, description de 80 caractères, pays `BE`, prix de 50 € `fixed`.
  - Pour **chaque** règle : un cas positif FR, un cas positif NL quand des mots-clés existent, un cas négatif, et le cas « donnée inconnue » qui ne déclenche rien.
  - `evaluate(neutre)` renvoie `{ score: 0, level: "low", signals: [] }`.
  - Additivité : `few_photos` + `new_account` donne 40, soit `medium`.
  - Plafond : toutes les règles actives cumulées donnent 100, soit `high`.
  - `levelOf` : 29 → low, 30 → medium, 59 → medium, 60 → high.
  - `price_anomaly` n'apparaît jamais.
  - `symbolic_price` n'est pas déclenché si `priceType` vaut `free`, ni si `price` vaut `null`.
  - Les accents sont ignorés : « paiement a l'avance » déclenche la règle.
  - Faux positifs à éviter : « signal sonore OK » ne déclenche pas `contact_outside`, alors que « contactez-moi via signal » le déclenche. Un prix comme « 1 234 € » ne déclenche pas la détection de téléphone.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : ils passent. Commit : `feat(extension): moteur de règles locales et score`.

---

### Tâche 5 : adaptateur 2ememain / 2dehands (`twh`)

**Fichiers :**
- Créer : `lib/adapters/twh.ts` et `test/twh-adapter.test.ts`

**Interfaces :**
- Consomme : `MarketplaceAdapter` (tâche 3), `parsePriceText` et `parseAccountAge` (tâche 1), les fixtures `twh/*` (tâche 2).
- Produit : `export const twhAdapter: MarketplaceAdapter`.
- **Sources**, conformes à la recherche locale §1.2 :
  - `C = __CONFIG__.listing`. On la lit en **parsant le texte** du `<script>` qui commence par `window.__CONFIG__ =`, avec `JSON.parse` sur la partie entre le premier `=` et le `;` final. Un content script ne peut pas lire `window` de la page.
  - **On ignore `C`** si `C.itemId` ne correspond pas à l'identifiant `m\d+` de l'URL, ce qui arrive après une navigation interne.
  - Champs lus dans `C` : titre, prix (`priceInfo.priceCents`), `priceType` (table : `FIXED` → fixed ; `MIN_BID`, `FAST_BID` et `FREE_BID` → bidding ; `FREE` → free ; le reste → unknown), catégorie, `stats.since`, images (`gallery.imageUrls`, préfixées par `https:`), `seller.id`/`name`/`sellerProfileUrl`, `seller.location.cityName` et `countryAbbreviation`, et l'ancienneté via `parseAccountAge(seller.activeSinceDiff)`.
  - **Description : depuis le DOM** (`[data-collapsable="description"]`), jamais depuis le JSON-LD, qui est tronqué.
  - État : bloc des caractéristiques, libellé `État`, `Conditie` ou `Staat`.
  - Avis : `a[href*="/experiences/user-reviews/"]`, nombre extrait par regex. Note : regex sur le texte qui précède le lien d'avis.
  - Vérification : texte d'indicateur de confiance (« vérifié » ou « Rien n'a été vérifié », NL « gecontroleerd »).
  - Autres annonces : `#seller-other-items-root`, texte « n annonces » ou « n advertenties ».
  - **Repli** si `C` est absent : le JSON-LD `Product` (`name`, `offers.price` en euros, `image[]`), le `h1` de `#seller-sidebar-root header`, et le prix via `parsePriceText` sur `h1 + div`.
- **Page d'annonce :** chemin `^/v/[^/]+/[^/]+/m\d+` (insensible à la casse) **et** `#seller-sidebar-root` présent.
- **Racine :** `document.body`. **Ancre :** `#seller-sidebar-root header h1`, avec repli sur le premier `h1`.

- [ ] **Étape 1 : écrire les tests.**
  - Fixture `listing-fixed` :
    - `extractListing` donne `site` `2ememain.be`, l'identifiant `m1000000001`, le titre `Iphone 14 PRO 128GB`, le prix `39900`, `fixed`, pays `BE`, ville `Namur` ;
    - les images ont le nombre réel et commencent toutes par `https://images.example/` ;
    - l'ancienneté provient de `activeSinceDiff` ;
    - `reviewCount` et `rating` sont lus si la fixture les contient ;
    - la description vient du DOM (plus de 151 caractères ou contient un saut de ligne).
  - Fixture `listing-bidding-skeleton` : `priceType` vaut `bidding`, le prix vaut 6000, et `reviewCount` vaut `undefined` (section vendeur en squelette) **sans erreur**.
  - **Le visiteur ne fuit pas** : en injectant dans la fixture un `<script>window.__ENV_CONFIG__ = {"userDetails":{"location":{"city":"Visiteurville","postcode":"9999"}}};</script>`, le `Listing` ne contient ni `Visiteurville` ni `9999` (vérifié sur `JSON.stringify`).
  - **`__CONFIG__` périmé** : avec une URL dont l'identifiant diffère, le repli JSON-LD et DOM est utilisé, et le titre reste celui du `h1`.
  - `siteOf(new URL("https://www.2dehands.be/v/x/y/m1-z"))` vaut `2dehands.be`.
  - `pageType` vaut `listing` pour la fixture, et `other` pour `https://www.2ememain.be/l/telephonie/` sur un document vide.
  - `badgeAnchor` renvoie le `h1` de la sidebar.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : ils passent. Commit : `feat(extension): adaptateur 2ememain et 2dehands`.

---

### Tâche 6 : adaptateur Facebook Marketplace

**Fichiers :**
- Créer : `lib/adapters/facebook.ts` et `test/facebook-adapter.test.ts`

**Interfaces :**
- Consomme : la tâche 3, `parsePriceText` et `parseFacebookJoinYear` (tâche 1), les fixtures `facebook/*` (tâche 2).
- Produit : `export const facebookAdapter: MarketplaceAdapter`.
- **DOM uniquement**, conforme à la recherche locale §2.3 :
  - **page d'annonce** : chemin `^/marketplace/item/(\d+)` ;
  - **racine** : `[role="dialog"]` qui contient un `h1` et un `a[href*="/marketplace/profile/"]` ; sinon `[role="main"]` qui contient ces deux éléments ; sinon `null`.
  - **titre** : `h1` de la racine. **Prix** : premier `span[dir="auto"]` de l'élément frère qui suit le bloc du `h1`, qui doit être lisible par `parsePriceText`.
  - **ville et région** : lien `a[href^="https://www.facebook.com/marketplace/"]` de la ligne « Publié … dans », texte `"<Ville>, <WAL|BRU|VLG>"`. Une région belge donne `country: "BE"`, sinon le pays reste `undefined`.
  - **état** : ligne `État`, `Condition` ou `Staat`.
  - **description** : `span[dir="auto"]` qui suit la ligne de l'état dans la section « Détails » (titre `Détails`, `Details` ou `Beschrijving`).
  - **photos** : `img[alt^="Photo de produit de "]`, `img[alt^="Product photo of "]` ou `img[alt^="Productfoto van "]`, **dédoublonnées** par `src`.
  - **vendeur** : `a[href*="/marketplace/profile/"]` (identifiant via regex, nom via `aria-label`). Ancienneté : texte qui correspond à `/Facebook\D{0,20}((?:19|20)\d{2})/` passé à `parseFacebookJoinYear(text, new Date())`.
  - `priceType` vaut `free` si le prix est `GRATUIT`, `Gratis` ou `Free`, sinon `fixed`.
- **Ancre :** le `h1` de la racine.

- [ ] **Étape 1 : écrire les tests.**
  - `item-modal` : `externalId` est l'identifiant de l'URL de test (`https://www.facebook.com/marketplace/item/1234567890/`, fixé dans le test), titre `Appareil photo canon EOS 3000 avec objectif`, prix `5000`, `fixed`, 5 images distinctes, ville `Namur`, région `WAL`, pays `BE`, `seller.id` `10000001`, et ancienneté non nulle avec `max > 200`.
  - `item-page` : produit le même `Listing`, à l'URL près.
  - `grid` sur l'URL `https://www.facebook.com/marketplace/` : `pageType` vaut `search` et `extractListing` vaut `null`.
  - Sur `item-modal`, les cartes de la grille présentes sous la modale ne contaminent ni le titre ni les images.
  - Un `listingRoot` sans `a[href*="/marketplace/profile/"]` donne `null`.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : ils passent. Commit : `feat(extension): adaptateur Facebook Marketplace`.

---

### Tâche 7 : textes FR/NL de l'interface injectée et choix de la langue

**Fichiers :**
- Créer : `lib/content-i18n.ts` et `test/content-i18n.test.ts`

**Interfaces :**
- Consomme : `RuleId`, `RiskLevel` (tâche 4), `Site` (tâche 1), `Locale` (`@radarnaque/shared`).
- Produit :
  - `contentText(locale, key: ContentKey): string`
  - `signalText(locale, signal: Signal): string`
  - `resolveContentLocale(site: Site, pref: Locale | null, uiLanguage: string): Locale`
- **Textes imposés :**

| Clé | FR | NL |
|---|---|---|
| `level.low` | `Risque faible` | `Laag risico` |
| `level.medium` | `Risque moyen` | `Gemiddeld risico` |
| `level.high` | `Risque élevé` | `Hoog risico` |
| `panel.title` | `Analyse Radarnaque` | `Radarnaque-analyse` |
| `panel.none` | `Aucun signal d'alerte détecté.` | `Geen waarschuwingssignalen gevonden.` |
| `panel.footer` | `Analyse locale, sans IA. Pour une analyse approfondie, cliquez sur l'icône Radarnaque de votre navigateur.` | `Lokale analyse, zonder AI. Voor een grondige analyse klikt u op het Radarnaque-pictogram in uw browser.` |
| `badge.aria` | `Ouvrir l'analyse Radarnaque` | `Radarnaque-analyse openen` |
| `few_photos` | `Peu de photos ({count})` | `Weinig foto's ({count})` |
| `new_account` | `Compte vendeur très récent` | `Zeer recent verkopersaccount` |
| `no_reviews` | `Aucun avis sur le vendeur` | `Geen beoordelingen voor de verkoper` |
| `foreign_location` | `Vendeur situé hors de Belgique ({country})` | `Verkoper buiten België ({country})` |
| `short_description` | `Description très courte` | `Zeer korte beschrijving` |
| `contact_outside` | `Invite à continuer hors de la plateforme (téléphone, email ou messagerie)` | `Vraagt om buiten het platform verder te gaan (telefoon, e-mail of chat)` |
| `shipping_only` | `Envoi uniquement, sans remise en main propre` | `Alleen verzending, niet ophalen` |
| `offsite_payment` | `Mode de paiement à risque (paiement à l'avance ou hors plateforme)` | `Risicovolle betaalmethode (vooraf of buiten het platform)` |
| `symbolic_price` | `Prix symbolique, anormalement bas` | `Symbolische, abnormaal lage prijs` |

- [ ] **Étape 1 : écrire les tests.**
  - Parité exacte des clés FR et NL.
  - Chaque `RuleId` activée a un texte dans les deux langues.
  - `{count}` et `{country}` sont bien interpolés.
  - `resolveContentLocale` : la préférence l'emporte ; 2dehands donne `nl` ; 2ememain donne `fr` ; Facebook avec `nl-BE` donne `nl` ; Facebook avec `en-US` donne `fr`.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : ils passent. Commit : `feat(extension): textes FR/NL des signaux et de la pastille`.

---

### Tâche 8 : composant `RiskBadge` (pastille et panneau)

**Fichiers :**
- Créer : `components/RiskBadge.tsx`, `components/badge.css` et `test/risk-badge.test.tsx`

**Interfaces :**
- Consomme : `RiskReport` (tâche 4), `contentText` et `signalText` (tâche 7).
- Produit : `export function RiskBadge(props: { report: RiskReport; locale: Locale }): JSX.Element`.
- **Comportement :**
  - un bouton compact (`type="button"`, `aria-expanded`, `aria-label` = `badge.aria`) affiche un point coloré (vert, orange, rouge selon le niveau), le texte du niveau et le score `NN/100` ;
  - un clic ouvre ou ferme le panneau (`role="dialog"`, `aria-label` = `panel.title`). Le panneau contient la liste des signaux triés par gravité (danger, puis warning, puis info), ou `panel.none`, puis `panel.footer` ;
  - `Escape` ferme le panneau ;
  - les styles sont en Tailwind, avec la taille de police fixée en `px` pour ne pas hériter du site, et un `z-index` élevé. Pas de `position: fixed` sur la pastille, qui reste dans le flux après l'ancre.

- [ ] **Étape 1 : écrire les tests.**
  - Le rendu `low` à 0 affiche « Risque faible », « 0/100 », et le panneau est fermé.
  - Un clic ouvre le panneau avec `panel.none`.
  - Un rapport `high` avec 3 signaux les liste dans l'ordre danger, puis warning, puis info.
  - `Escape` ferme le panneau.
  - Avec `locale="nl"`, les libellés sont en néerlandais.
  - L'ouverture ne déclenche aucun appel réseau (`fetch` espionné) ni aucun `sendMessage`.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : relancer les tests.** Résultat attendu : ils passent. Commit : `feat(extension): pastille et panneau de risque`.

---

### Tâche 9 : contrôleur de page et content script

**Fichiers :**
- Créer : `lib/content/controller.ts`, `entrypoints/content.ts` et `test/controller.test.ts`
- Modifier : `wxt.config.ts` (rien à ajouter si WXT déduit les `matches` de l'entrypoint ; sinon les déclarer) et `README.md` (section « Tester sur les vrais sites »)

**Interfaces :**
- Consomme : `adapterFor` (tâche 3), les deux adaptateurs (tâches 5 et 6), `evaluate` (tâche 4), `resolveContentLocale` (tâche 7), `RiskBadge` (tâche 8), `localePref` (`lib/storage.ts`).
- Produit :
  ```ts
  export interface Mounter { mount(anchor: Element, report: RiskReport, locale: Locale): void; update(report: RiskReport): void; unmount(): void }
  export function createController(deps: { doc: Document; getUrl(): URL; mounter: Mounter;
    getLocale(site: Site): Promise<Locale>; log?: (msg: string) => void }): { refresh(): Promise<void>; dispose(): void };
  ```
- **Logique de `refresh()`**, déclenchée au démarrage, à chaque `wxt:locationchange` et à chaque mutation du DOM (limitée à une exécution toutes les 250 ms) :
  1. `adapterFor(url)` ; si l'URL n'est pas une page d'annonce, appeler `unmount()` et s'arrêter.
  2. Appeler `extractListing`. Si le résultat est `null` (structure inconnue), appeler `unmount()` et écrire **une seule** ligne de log `radarnaque: extraction impossible (<adapter>)`, puis s'arrêter.
  3. `evaluate(listing)` produit le rapport.
  4. Si l'ancre a changé (autre `h1`, ou `externalId` différent du précédent), appeler `unmount()` puis `mount()`. Sinon, si le score ou la liste des identifiants de signaux a changé, appeler `update()`. Sinon, ne rien faire.
  5. L'ancre reçoit `data-radarnaque="<externalId>"`. Ne jamais monter deux fois pour le même identifiant.
- **`entrypoint content.ts`** :
  - `defineContentScript({ matches: ["*://*.2ememain.be/*", "*://*.2dehands.be/*", "*://*.facebook.com/*"], cssInjectionMode: "ui", runAt: "document_idle", main(ctx) })` ;
  - le `Mounter` réel utilise `createShadowRootUi(ctx, { name: "radarnaque-badge", position: "inline", anchor, append: "after", onMount })` avec React ;
  - un `MutationObserver` observe `document.body` (`childList`, `subtree`) ;
  - le nettoyage passe par `ctx.onInvalidated`.

- [ ] **Étape 1 : écrire les tests** avec happy-dom, les fixtures et un `Mounter` simulé qui enregistre les appels.
  - Fixture 2ememain `listing-fixed` : un seul `mount`, avec un rapport et la locale `fr`. Deux `refresh()` successifs ne provoquent toujours qu'un seul `mount`.
  - Fixture `listing-bidding-skeleton` : on remplace le squelette par une section vendeur complète contenant « 0 avis », puis on appelle `refresh()` → un `update()` avec `no_reviews` présent, et pas de second `mount`.
  - Facebook `item-modal`, puis changement d'URL vers une autre annonce, avec une fixture modifiée (autre `h1`) → `unmount` puis `mount` (navigation interne).
  - Navigation vers `https://www.facebook.com/marketplace/` (grille) → `unmount`, sans nouveau `mount`.
  - Une page d'annonce dont le `h1` a été retiré donne `extractListing` à `null` → aucun `mount`, une seule ligne de log, même après 3 `refresh()`.
  - `dispose()` déconnecte l'observateur, et un `refresh` ultérieur ne fait rien.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter `controller.ts` et `content.ts`.**
- [ ] **Étape 4 : relancer les tests, puis `pnpm --filter extension build` et `pnpm --filter extension typecheck`.**
  - Résultat attendu : les tests passent.
  - Le `manifest.json` produit contient `content_scripts[0].matches` avec les 3 motifs.
  - Les `permissions` sont **inchangées** : seulement `storage`, et aucune nouvelle `host_permissions` au-delà de `PUBLIC_URL`.
- [ ] **Étape 5 : README**, section « Tester sur les vrais sites » :
  - lancer `pnpm dev:ext` ;
  - ouvrir une annonce 2ememain, une annonce 2dehands et une annonce Facebook Marketplace ;
  - vérifier la pastille, le panneau, la langue et la navigation interne sur Facebook.
  - Puis commit : `feat(extension): pastille de risque injectée sur les annonces`.

---

## Couverture du spec

| Spec | Tâche |
|---|---|
| §4.2 `Listing` (adapté : `accountAgeMonths`, `location.region`) | 1 |
| §4.3 adaptateurs (données structurées d'abord, sans classes obfusquées, un adaptateur pour 2ememain et 2dehands) | 3, 5, 6 |
| §4.4 moteur de règles, poids, niveaux, `RULES_VERSION`, `price_anomaly` désactivée | 4 |
| §4.5 Shadow DOM, pastille et panneau, idempotence, `MutationObserver` limité, `wxt:locationchange` | 8, 9 |
| §4.7 langue selon le site, préférence de la popup | 7, 9 |
| §12 adaptateurs testés sur pages réelles enregistrées | 2, 5, 6 |
| §10 vie privée : aucune donnée envoyée, identité du vendeur gardée côté client | contraintes globales, tâches 2 et 9 |

**Hors phase 2 :**
- les icônes sur les cartes et `findCards` (phase 3) ;
- le bouton d'analyse IA et la messagerie entre content script et service worker, avec sa liste blanche (phase 3) ;
- la base de prix (plus tard).
