# Identification du produit, partie 2 (extension) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sur la fiche d'une annonce, une seconde pilule « Identifier » lance l'identification en direct et ouvre son propre panneau (référence, confiance, critères vérifiés, question au vendeur, pages) ; « Analyser » passe par l'identification et remplit les deux pilules ; l'infobulle des cartes cite la référence ; le délai du flux suit les nouveaux budgets de l'API.

**Architecture:** le service worker relaie `POST /api/identify/stream` par le même port `scan/stream`, choisi par un champ `purpose` de la demande, et valide les nouveaux événements. Côté content script, `useAiScan` garde deux états (identification et analyse) dans la même portée d'annonce, avec la mise en file d'« Analyser ». Le magasin des résultats garde l'identification à côté de l'analyse. `RiskBadge` affiche deux pilules côte à côte, chacune avec son panneau.

**Tech Stack:** WXT, React 19, TypeScript, Tailwind (tokens du design), Vitest + Testing Library, `@radarnaque/shared` (types générés de l'API et miroir du flux).

**Spec:** `docs/superpowers/specs/2026-10-23-identification-produit-design.md` (§13 surtout, §6 pour les événements, §11 pour la livraison). La partie 1 (API) est fusionnée (PR #15) ; son suivi : `docs/superpowers/plans/2026-10-23-identification-partie-1-suivi.md`.

## Global Constraints

- Branche `feat/identification-2`, au-dessus de `main` (partie 1 fusionnée). Aucun changement de l'API sauf mention explicite.
- Textes de l'interface en FR et NL, clés dans `apps/extension/lib/content-i18n.ts` ; le test de parité FR/NL reste vert. Commentaires et docstrings en français.
- Design : `DESIGN.md` (fichier de l'utilisateur, non suivi : le lire, ne jamais le modifier ni le commiter) et la spec de la pastille (`docs/superpowers/specs/2026-10-22-design-pastille-design.md` §2 à §4) : pilule 28 px, verre sombre, Inter 13 px poids 500, panneau 340 px (90 % au plus de la fenêtre), `z-index` 2147483000, polices en px, Shadow DOM.
- Confiance : glyphes ● Sûr, ◐ Probable, ○ Incertain ; **aucune couleur sémantique du risque** sur la pilule ou le badge d'identification. Le niveau est toujours écrit.
- Accessibilité : nom accessible de la pilule au repos « Identifier le produit » (NL : « Product identificeren ») ; ligne d'état dans un `aria-live` mis à jour au plus toutes les 2 s ; focus rendu à la pilule comme pour « Analyser ».
- Liens des pages de référence : `target="_blank"` et `rel="noopener noreferrer"`, rendus seulement si l'URL commence par `https://`.
- Délai du flux dans le service worker : `SCAN_TIMEOUT_MS = 310_000`.
- Le service worker reste le seul à parler à l'API ; le content script n'envoie que les messages de la liste blanche et le port `scan/stream`.
- Résultats gardés 24 h dans le navigateur, une place par annonce, effacés à la déconnexion, caducs si l'annonce change (`listingFingerprint`).

## Review Focus

1. **Annonce modifiée pendant une identification ou une analyse en file** : le changement d'annonce (même clé, autre empreinte, ou autre clé) annule la file et ne laisse ni l'ancienne référence ni un « Analyser » qui se lance seul sur la nouvelle annonce (test en tâche 3).
2. **Identification en échec pendant « Analyser »** (`identification_error`) : la pilule « Identifier » passe en erreur, l'analyse continue et se termine normalement, et aucune erreur n'apparaît sur la pilule « Analyser » (tests en tâches 3 et 4).
3. **Entrées du magasin écrites par la version précédente** (v2, analyse seule) : relues sans erreur, l'identification absente ; une entrée illisible est ignorée (test en tâche 2).
4. **Données du réseau dans le panneau** : un texte d'identification contenant du HTML ou une URL non HTTPS ne produit ni balise ni lien (tests en tâches 1 et 5).
5. **Résultat repris du magasin sans quota connu** : « Inclus avec l'identification » ne s'affiche que si l'identification vient d'un « Identifier » de cet utilisateur sur cette annonce, jamais pour une identification apportée par « Analyser » (test en tâche 3).

---

### Task 1: Flux de l'identification dans le service worker

**Files:**
- Modify: `packages/shared/src/stream.ts`, `apps/extension/lib/messages.ts`, `apps/extension/lib/api-client.ts`, `apps/extension/lib/scan-events.ts`, `apps/extension/lib/scan-port.ts`, `apps/extension/lib/scan-payload.ts` (si `purpose` doit être retiré du corps), `apps/extension/lib/content/scan-progress.ts`, `apps/extension/lib/content-i18n.ts`
- Test: `apps/extension/test/scan-events.test.ts`, `scan-port.test.ts`, `api-client.test.ts`, `scan-progress.test.ts`, `content-i18n.test.ts`

**Interfaces:**
- Produces, dans `packages/shared/src/stream.ts` :
  - `ScanProgressEvent` étendu : `stage` accepte `StreamStage` entier (`cache`, `photos`, `analyzing`, `reading_photos`, `criteria`, `identifying`, `retrying`, `writing`) ; nouveaux membres `PageReadEvent`, `CriteriaCachedEvent`, `IdentificationErrorEvent`, `IdentificationEvent` (déjà définis, à intégrer à l'union).
  - `export type IdentificationResult = components["schemas"]["IdentificationOut"]`.
- Produces, dans `lib/messages.ts` : `ScanRequest.purpose?: "identify" | "analyze"` (absent = `analyze`).
- Produces, dans `lib/api-client.ts` : `identifyStream(body: ScanIn, signal: AbortSignal): Promise<AsyncIterable<SseMessage>>` sur `/api/identify/stream`.
- Produces, dans `lib/scan-events.ts` :
  - `isIdentificationResult(value: unknown): value is IdentificationResult` (forme minimale : `identificationId` nombre, `status` dans `identified|uncertain|none`, `confidence` entier 0–100, `level` dans `sure|probable|uncertain`, `objects` tableau de 4 au plus, chaque objet avec `role`, `label` chaîne, `reference` chaîne ou null, `checks` et `pages` tableaux) ;
  - `parseStreamMessage(m, purpose: "identify" | "analyze" = "analyze")` : pour `purpose = "identify"`, le `result` est validé par `isIdentificationResult` ; les événements `page_read`, `criteria_cached`, `identification` (validé par `isIdentificationResult`) et `identification_error` (`code` qui respecte `ERROR_CODE`) sont reconnus, les chaînes bornées par `EVENT_BOUNDS` (domaine 100, requête 200) ; les nouvelles étapes sont acceptées ;
  - `StreamOutcome` : `{ type: "result"; result: AnalysisResult | IdentificationResult }` (l'appelant sait lequel par `purpose`).
- Produces, dans `lib/scan-port.ts` : `SCAN_TIMEOUT_MS = 310_000` ; le relais lit `purpose` dans le message de départ (`"identify"` → `api.identifyStream`, sinon `api.scanStream`) et le passe à `parseStreamMessage` ; `PortMessage` `result` porte l'un ou l'autre résultat.
- Produces, dans `lib/content/scan-progress.ts` : `stageLine` et `eventLine` couvrent les nouvelles étapes et événements. Textes (FR / NL) :
  - `reading_photos` : « Lecture des photos… » / « Foto's lezen… » ;
  - `criteria` : « Recherche des critères… » / « Criteria zoeken… » ;
  - `criteria_cached` : « Critères connus de Radarnaque » / « Criteria al bekend bij Radarnaque » ;
  - `page_read` (ok) : « Lecture : {domaine} » / « Lezen: {domein} » ; (en échec) rien ;
  - `identifying` : « Vérification des critères… » / « Criteria controleren… » ;
  - `retrying` : « Vérification complémentaire… » / « Extra controle… » ;
  - `identification` : « Produit identifié » / « Product geïdentificeerd » ;
  - `identification_error` : « Identification impossible » / « Identificatie mislukt ».

- [ ] **Step 1: Tests**
  - `scan-events.test.ts` : `parses identification events and bounds their strings` ; `accepts the identification stages` ; `rejects an identification with an unknown level or more than 4 objects` (→ `null` pour l'événement, `invalid_response` pour un `result` en `purpose = "identify"`) ; `an identify stream result must be an IdentificationOut` ; le test existant « ignores identification events » de la partie 1 est remplacé par ces cas.
  - `scan-port.test.ts` : `routes purpose identify to identifyStream` ; `routes a request without purpose to scanStream` ; `times out after SCAN_TIMEOUT_MS = 310 000`.
  - `api-client.test.ts` : `identifyStream posts to /api/identify/stream`.
  - `scan-progress.test.ts` : une ligne par nouvelle étape et événement, en FR et NL ; `page_read` en échec ne change pas la ligne.
- [ ] **Step 2: Lancer** `pnpm --filter extension test -- scan-events scan-port api-client scan-progress` — attendu : FAIL.
- [ ] **Step 3: Implémenter**, puis adapter les `switch` exhaustifs (TypeScript) touchés par l'union élargie.
- [ ] **Step 4: Lancer** `pnpm --filter extension test && pnpm -r typecheck` — attendu : vert.
- [ ] **Step 5: Commit** `feat(extension): flux de l'identification relayé par le service worker`.

### Task 2: Identification dans le magasin des résultats

**Files:**
- Modify: `apps/extension/lib/content/ai-results.ts`, `apps/extension/lib/content/card-controller.ts` (écritures du magasin, si besoin)
- Test: `apps/extension/test/ai-results.test.ts`

**Interfaces:**
- Produces :
  - `StoredAiResult` : `result: AnalysisResult | null`, `identification: IdentificationResult | null`, `identifiedByUser: boolean` (vrai seulement si l'identification vient d'un « Identifier » de cet utilisateur), `fingerprint`, `storedAt`. Au moins l'un de `result` et `identification` est non nul.
  - Version d'entrée `v: 3`. Une entrée `v: 2` (ancienne) est relue comme `{ result, identification: result.identification ?? null, identifiedByUser: false }`.
  - Expiration (M4) : 24 h après `analyzedAt` ou `identifiedAt` (le plus ancien des deux présents), ou 24 h après l'écriture.
  - `AiResultStore.put` fusionne : écrire une identification garde l'analyse déjà présente pour la même empreinte, et l'inverse ; une empreinte différente remplace l'entrée.
  - `withoutRemaining` s'applique aussi à `identification.remaining`.

- [ ] **Step 1: Tests** : `reads a v2 entry as an analysis with its embedded identification` ; `identification-only entry round-trips` ; `put merges identification and analysis for the same fingerprint` ; `put replaces the entry when the fingerprint changed` ; `expires 24 h after the oldest of analyzedAt and identifiedAt` ; `an entry with neither result nor identification is dropped` ; `identification remaining is never restored`.
- [ ] **Step 2: Lancer** `pnpm --filter extension test -- ai-results` — attendu : FAIL.
- [ ] **Step 3: Implémenter**.
- [ ] **Step 4: Lancer** `pnpm --filter extension test` — attendu : vert.
- [ ] **Step 5: Commit** `feat(extension): identification gardée 24 h à côté de l'analyse`.

### Task 3: Deux analyses dans la même portée (`useAiScan`)

**Files:**
- Modify: `apps/extension/lib/content/ai-client.ts`, `apps/extension/lib/content/use-ai-scan.ts`
- Test: `apps/extension/test/ai-client.test.ts`, `apps/extension/test/use-ai-scan.test.tsx`

**Interfaces:**
- Consumes: `ScanRequest.purpose`, nouveaux événements et `IdentificationResult` (tâche 1) ; `StoredAiResult` v3 (tâche 2).
- Produces, dans `ai-client.ts` :
  - `IdentifyState = { status: "idle" } | { status: "loading"; progress: ScanProgress } | { status: "done"; result: IdentificationResult; progress: ScanProgress | null } | { status: "error"; code: string }` ;
  - `AiClient.identify(req: ScanRequest, onEvent: (e: ScanProgressEvent) => void): IdentifyHandle`, `IdentifyHandle.done: Promise<BgResponse<IdentificationResult>>` (même port, `purpose: "identify"`).
- Produces, dans `use-ai-scan.ts`, `AiScan` gagne :
  - `identification: IdentifyState` ;
  - `identify(): void` — lance l'identification (pas de second lancement si une identification ou une analyse est en cours) ;
  - `queued: boolean` — « Analyser » demandé pendant une identification ;
  - `analysisIncluded: boolean` — vrai si l'identification affichée est `done`, vient d'un « Identifier » de l'utilisateur (`identifiedByUser`), et qu'aucune analyse n'est faite.
- Règles :
  - `scan()` pendant une identification en cours : `queued = true`, sans requête ; à la fin de l'identification (réussie ou non), l'analyse part si la portée est la même et l'empreinte inchangée ; sinon la file est oubliée.
  - Pendant `scan()`, les événements d'identification (`reading_photos`, `criteria`, `criteria_cached`, `page_read`, `identifying`, `retrying`) font passer `identification` à `loading` (si elle n'est pas déjà `done`) et alimentent sa progression ; `identification` → `done` ; `identification_error` → `error` avec son code ; les autres événements alimentent l'analyse. Le `result.identification` de l'analyse, s'il existe, devient l'identification `done`.
  - Écritures du magasin : une identification réussie écrit `{ identification, identifiedByUser: true }` ; une analyse réussie écrit `{ result, identification: result.identification }` sans changer `identifiedByUser`.
  - Lecture du magasin à l'arrivée : identification et analyse reprises séparément (même règle d'empreinte et de résultat partiel qu'aujourd'hui pour l'analyse).
  - Un changement d'annonce ou d'empreinte remet les deux états à `idle`, annule la requête en cours et oublie la file.
  - La relecture de l'accès suit chaque identification comme chaque analyse (quota consommé).

- [ ] **Step 1: Tests** (`use-ai-scan.test.tsx`, doublure de `AiClient` comme les tests actuels) :
  - `identify goes loading then done and stores identifiedByUser` ;
  - `scan during identify is queued then starts when identify finishes` ; `queued scan still starts after an identify error` ;
  - `queued scan is dropped when the listing changes` (Review Focus 1) ;
  - `scan without identification fills both states from the stream` ; `identification_error during scan sets identification error and the scan completes` (Review Focus 2) ;
  - `analysisIncluded only after the user's own identify` (Review Focus 5) ; `restored identification from an analysis does not mark analysisIncluded` ;
  - `restores identification and analysis separately from the store` ;
  - `no second identify while one runs (double click)`.
  - `ai-client.test.ts` : `identify sends purpose identify on the scan port and resolves with the identification`.
- [ ] **Step 2: Lancer** `pnpm --filter extension test -- use-ai-scan ai-client` — attendu : FAIL.
- [ ] **Step 3: Implémenter**.
- [ ] **Step 4: Lancer** `pnpm --filter extension test && pnpm -r typecheck` — attendu : vert.
- [ ] **Step 5: Commit** `feat(extension): identification et file d'attente de l'analyse dans la pastille`.

### Task 4: Pilule « Identifier » et deux panneaux

**Files:**
- Create: `apps/extension/components/IdentifyPill.tsx`
- Modify: `apps/extension/components/RiskBadge.tsx`, `apps/extension/components/BadgePill.tsx` (partage de `PILL_CLASS`, `useLaunch` paramétré), `apps/extension/lib/content-i18n.ts`
- Test: `apps/extension/test/identify-pill.test.tsx`, `apps/extension/test/risk-badge.test.tsx`

**Interfaces:**
- Consumes: `AiScan.identification`, `identify`, `queued`, `analysisIncluded` (tâche 3).
- Produces :
  - `useLaunch(scan, key, openPanel, start: () => void)` : même logique d'accès qu'aujourd'hui, l'action finale est `start` (`scan.scan` ou `scan.identify`) ;
  - `IdentifyPill({ scan, locale, open, onToggle, onLaunch, pillRef })`, placée avant `BadgePill` dans la même ligne ;
  - `RiskBadge` : `open: null | "identify" | "analyze"` ; chaque pilule ouvre ou ferme son panneau ; ouvrir l'un ferme l'autre ; Escape et clic extérieur ferment le panneau ouvert, le focus revient à la pilule qui l'a ouvert.
- États de la pilule (spec §13.1) : repos (logo, « Identifier », nom accessible « Identifier le produit ») ; en cours (logo animé, `statusLine`, `aria-live` au plus toutes les 2 s) ; résultat (glyphe, référence courte, « · », niveau, pourcentage en chiffres tabulaires ; incertain : « {candidat 1} ou {candidat 2} ? · Incertain {n} % » ; `none` : « Produit non identifié ») ; erreur (même rendu que l'erreur d'analyse) ; déconnecté, sans abonnement, quota épuisé : mêmes règles que `BadgePill`. Référence tronquée à 32 caractères avec « … », nom accessible complet.
- « Analyser » : description `aria-describedby` « Inclus avec l'identification » (NL : « Inbegrepen bij de identificatie ») quand `analysisIncluded` ; pendant `queued`, la ligne d'état de la pilule « Analyser » dit « En attente de l'identification… » (NL : « Wacht op de identificatie… »).
- Pendant une analyse sans identification préalable, les deux pilules s'animent (l'identification d'abord, puis l'analyse).

- [ ] **Step 1: Tests** : chaque état de la pilule en FR et NL ; troncature et nom accessible complet ; glyphes et absence de classe de couleur sémantique (`text-danger`, `bg-success`…) ; `opens its own panel and closes the other` ; Escape rend le focus à la pilule ouvrante ; `analysisIncluded` rend la description ; `queued` rend la ligne d'attente ; identification en erreur pendant une analyse : aucune erreur sur la pilule « Analyser » (Review Focus 2) ; `useLaunch` avec `start = identify` (déconnecté → connexion, quota épuisé → aria-disabled).
- [ ] **Step 2: Lancer** `pnpm --filter extension test -- identify-pill risk-badge` — attendu : FAIL.
- [ ] **Step 3: Implémenter** ; clés FR et NL ajoutées, parité verte.
- [ ] **Step 4: Lancer** `pnpm --filter extension test && pnpm -r typecheck && pnpm exec biome check apps/extension` — attendu : vert.
- [ ] **Step 5: Commit** `feat(extension): pilule Identifier et panneaux séparés`.

### Task 5: Panneau « Identification » et ligne produit de l'analyse

**Files:**
- Create: `apps/extension/components/IdentificationSection.tsx`
- Modify: `apps/extension/components/RiskBadge.tsx` (contenu du panneau d'identification), `apps/extension/components/AiSection.tsx` (ligne « Produit »), `apps/extension/components/ScanProgressView.tsx` (déroulé de l'identification), `apps/extension/lib/content-i18n.ts`
- Test: `apps/extension/test/identification-section.test.tsx`, `apps/extension/test/ai-section.test.tsx`

**Interfaces:**
- Produces `IdentificationSection({ locale, identification: IdentifyState, access, onIdentify, onLogin, loginUnavailable, pricingUrl })` — états accès/erreur comme `AiSection` ; résultat :
  - en-tête « IDENTIFICATION » (style `label`) ;
  - objet principal : référence en Instrument Serif 22 px, badge de niveau (glyphe + niveau + pourcentage, sans couleur sémantique), barre de 4 px remplie à hauteur de la confiance (couleur `--text-1` à 60 %) ;
  - « Critères vérifiés par Radarnaque » si `verifiedCriteria` ; « Critères non confirmés par une source » si `unsourced` ;
  - critères : ✓ vu, ✗ contraire, ? non visible (texte dans la langue, numéro de photo « photo 2 » s'il existe, domaine de chaque source en lien) ;
  - incertain : candidats restants, encadré « À demander au vendeur » avec la question et un bouton « Copier » (`navigator.clipboard.writeText`, retour « Copié » 2 s, repli silencieux si refusé) ;
  - accessoires : une ligne chacun (libellé, référence ou « — », niveau) ; libellé vide → « Objet » (NL « Object ») ;
  - pages de référence : titre et domaine, liens `https://` seulement ;
  - pied : « Analyses restantes : N » (même règle qu'`AiSection`) et « Déroulé de l'identification » repliable (`ScanProgressView`, recherches et pages lues, aussi pour un résultat repris du cache ou du magasin, à partir de `searches`).
- `AiSection` : en tête du résultat, « Produit : {référence} ({niveau}) » quand `result.identification` est `identified` ou `uncertain`.
- Tout texte venu du réseau est rendu comme texte (jamais `dangerouslySetInnerHTML`).

- [ ] **Step 1: Tests** : rendu Sûr, Incertain (candidats, question, Copier → `writeText` appelé, « Copié »), `none`, accessoires, libellé vide ; liens : `https://` → `<a target="_blank" rel="noopener noreferrer">`, `http://` ou `javascript:` → texte seul (Review Focus 4) ; un texte contenant `<img onerror>` reste du texte ; FR et NL ; la ligne « Produit » de `AiSection`.
- [ ] **Step 2: Lancer** `pnpm --filter extension test -- identification-section ai-section` — attendu : FAIL.
- [ ] **Step 3: Implémenter**.
- [ ] **Step 4: Lancer** `pnpm --filter extension test && pnpm -r typecheck` — attendu : vert.
- [ ] **Step 5: Commit** `feat(extension): panneau Identification et ligne produit de l'analyse`.

### Task 6: Infobulle des cartes, galerie et documentation

**Files:**
- Modify: `apps/extension/components/CardBadge.tsx`, `apps/extension/lib/content/card-controller.ts` (écriture du magasin avec l'identification de l'analyse), `apps/extension/dev/gallery.tsx`, `README.md`, `docs/etat-du-projet.md`
- Create: `docs/superpowers/plans/2026-10-23-identification-partie-2-suivi.md`
- Test: `apps/extension/test/card-badge.test.tsx`, `apps/extension/test/card-controller.test.ts`

**Interfaces:**
- `tooltipOf` : pour un résultat qui porte `identification` `identified` ou `uncertain`, une ligne de plus « {référence courte} · {niveau} » avant le résumé (« ? » à la place de la référence si elle est nulle).
- Le magasin reçoit, depuis une carte, `{ result, identification: result.identification ?? null }` (résultat partiel : la pastille ne le reprend pas, comme aujourd'hui).
- Galerie (`pnpm --filter extension gallery`) : nouveaux états — pilule Identifier au repos, en cours, Sûr, Incertain, non identifié, erreur ; « Analyser » en attente et « Inclus » ; panneau Identification Sûr et Incertain ; infobulle de carte avec la ligne produit.
- Documentation : README (pilule Identifier, délai du flux 310 s) ; `etat-du-projet.md` (section Identification, partie 2) ; suivi : vérifications sur les vrais sites (2ememain, 2dehands, Facebook), en FR et NL, captures de la galerie, et le rappel que l'API peut désormais rendre au parcours d'analyse ses budgets du spec (120 s puis 180 s) une fois les anciennes versions de l'extension disparues.

- [ ] **Step 1: Tests** : `card tooltip shows the product line before the summary` (FR, NL, référence nulle) ; `card scan stores the identification with the analysis`.
- [ ] **Step 2: Lancer** `pnpm --filter extension test -- card-badge card-controller` — attendu : FAIL.
- [ ] **Step 3: Implémenter**, compléter la galerie et la documentation.
- [ ] **Step 4: Lancer** toutes les suites : `pnpm --filter extension test && pnpm --filter admin test && pnpm --filter site test && pnpm --filter auth test && pnpm test:scripts && pnpm -r typecheck && pnpm exec biome check .` puis `cd services/api && uv run pytest -q` — attendu : vert.
- [ ] **Step 5: Commit** `feat(extension): ligne produit des cartes, galerie et documentation de l'identification`.
