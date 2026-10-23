# Identification — pastille unique, plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** remplacer les deux pilules (« Identifier » et « Analyser ») par une seule pilule qui identifie au premier clic puis propose « Analyser le risque » dans la même capsule, avec un seul panneau (section Produit, puis Risque), sans décalage de largeur pendant le chargement.

**Architecture:** l'état reste dans `useAiScan` (identification et analyse), allégé de la file d'attente. `BadgePill` devient la seule pilule et choisit son rendu d'après les deux états ; `RiskBadge` revient à une pilule et un panneau qui compose `IdentificationSection` et `AiSection`. Aucun changement de l'API ni du service worker.

**Tech Stack:** WXT, React 19, TypeScript, Tailwind (tokens du design), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-23-identification-pastille-unique-design.md` (révise la §13 de `docs/superpowers/specs/2026-10-23-identification-produit-design.md`).

## Global Constraints

- Branche `feat/identification-pastille`, au-dessus de `feat/identification-2`. Aucun changement de l'API, du service worker (`lib/scan-*.ts`) ni du magasin (`lib/content/ai-results.ts`).
- Textes FR et NL dans `lib/content-i18n.ts`, parité verte ; nouveaux libellés exacts : « Analyser le risque » / « Risico analyseren », « Détail du produit » / « Productdetails » ; les clés devenues inutiles sont retirées des deux langues.
- Design : `docs/superpowers/specs/2026-10-22-design-pastille-design.md` §2–§3 et `DESIGN.md` (lecture seule, jamais modifié ni commité) ; aucune couleur sémantique du risque sur l'état produit ; la pilule de résultat du risque reste celle d'aujourd'hui.
- Une seule région `aria-live` par pastille, au plus une annonce toutes les 2 s ; le focus reste sur la pilule à chaque changement d'élément.
- Largeur stable pendant le chargement : ligne d'état de largeur bornée, coupée avec « … », points de suspension dans un élément de largeur fixe dont seule l'opacité s'anime.
- « Analyser le risque » : inclus à quota 0 (spec §7) ; grisé sans inclusion et sans analyse restante ; lien vers les formules sans abonnement.

## Review Focus

1. **Fiche reprise du magasin** : une analyse gardée affiche le résultat du risque, une identification seule affiche « Produit identifié » avec l'action ; une entrée v2 (analyse seule, ancienne version) affiche le résultat comme avant (tests en tâches 2 et 3).
2. **Analyse du risque en cours** : la pilule ne revient jamais à « Identifier » quand le serveur rejoue l'identification (cache) ; la référence reste affichée devant la ligne d'état (test en tâche 2).
3. **Erreur pendant l'analyse du risque** : « Relancer » relance l'analyse, pas l'identification, et l'identification affichée n'est pas perdue après la relance réussie (test en tâche 2).
4. **Changement d'annonce** (navigation sans rechargement) pendant l'une ou l'autre étape : retour au repos « Identifier », sans résultat de l'ancienne annonce (test en tâche 2).
5. **Largeur** : la pilule garde la même classe de largeur bornée quel que soit le nombre de points de suspension, et l'élément des points a une largeur fixe (test en tâche 1).

---

### Task 1: Ligne d'état de largeur stable

**Files:**
- Modify: `apps/extension/components/LiveStatus.tsx` (rendu de la ligne et des points), `apps/extension/components/BadgePill.tsx` (`PillFrame` s'il porte la ligne), `apps/extension/components/badge.css` ou `apps/extension/lib/motion.css` (animation d'opacité)
- Test: `apps/extension/test/live-status.test.tsx`

**Interfaces:**
- Produces: `LiveLine` rend la ligne dans un élément de largeur bornée (`max-w-[220px]`, `truncate`) et les points dans un `span` de largeur fixe (`inline-block w-[1.2em]`, `aria-hidden`), toujours présent ; l'attente (`useWaiting`) n'anime que l'opacité des trois points (pas d'ajout ni de retrait de caractère). Sous `prefers-reduced-motion`, les points sont statiques.

- [ ] **Step 1: Tests** : `dots keep a fixed-width element whether waiting or not` ; `status line is truncated within a bounded width` ; `waiting animates opacity only (same text content)` ; `reduced motion: no animation class`.
- [ ] **Step 2: Lancer** `pnpm --filter extension test -- live-status` — attendu : FAIL.
- [ ] **Step 3: Implémenter**.
- [ ] **Step 4: Lancer** `pnpm --filter extension test && pnpm -r typecheck` — attendu : vert.
- [ ] **Step 5: Commit** `fix(extension): ligne d'état de largeur stable pendant l'analyse`.

### Task 2: Une seule pilule (identification puis risque)

**Files:**
- Modify: `apps/extension/components/BadgePill.tsx`, `apps/extension/components/RiskBadge.tsx`, `apps/extension/lib/content/use-ai-scan.ts`, `apps/extension/lib/content-i18n.ts`
- Delete: `apps/extension/components/IdentifyPill.tsx` (ses états passent dans `BadgePill`)
- Test: `apps/extension/test/risk-badge.test.tsx`, `apps/extension/test/use-ai-scan.test.tsx`, `apps/extension/test/identify-pill.test.tsx` (supprimé ou fondu dans `risk-badge.test.tsx`)

**Interfaces:**
- Consumes: `AiScan` (`identification`, `ai`, `identify`, `scan`, `analysisIncluded`, `access`, `restoring`, `login`, `loadAccess`) et `useLaunch(scan, key, openPanel, start, included?)`.
- Produces :
  - `useAiScan` sans file d'attente : `queued`, `queuedFingerprint`, `Scope.queued` et leur logique sont retirés ; `scan()` appelé pendant une identification en cours ne fait rien (pas de file).
  - `BadgePill({ scan, locale, open, onToggle, onIdentify, onAnalyze, pillRef })` choisit son rendu dans cet ordre :
    1. `restoring` : rien (comme aujourd'hui) ;
    2. analyse du risque `done` : pilule de résultat actuelle ;
    3. analyse du risque `loading` : logo animé, « {référence courte} · {ligne d'état} » (ligne seule sans référence) ;
    4. analyse du risque `error` : pilule d'erreur ; « Relancer » → `onAnalyze` ;
    5. identification `done` : glyphe, titre (`identificationHeadline` : référence courte ou « A ou B ? », niveau, pourcentage ; « Produit non identifié » pour `none`), séparateur, action « Analyser le risque » (bouton `INLINE_ACTION_CLASS`, `aria-describedby` « Inclus avec l'identification » si inclus ; `aria-disabled` + raison si quota 0 sans inclusion ; lien vers les formules sans abonnement) ; la partie produit est un bouton qui ouvre ou ferme le panneau ;
    6. identification `loading` : logo animé, ligne d'état de l'identification ;
    7. identification `error` : pilule d'erreur ; « Relancer » → `onIdentify` ;
    8. repos : logo, « Identifier » (nom accessible « Identifier le produit »), ou lien vers les formules sans abonnement, ou grisé sans analyse restante (règles actuelles).
  - `RiskBadge` : une seule pilule (`data-pill` retiré ou unique), `open: boolean`, un seul panneau (contenu en tâche 3 ; dans cette tâche, le panneau garde le contenu actuel adapté : section Identification puis section IA).
  - Clés retirées : celles devenues sans usage (`identify.queued`, textes du second panneau, etc.) ; ajoutée : `ai.analyzeRisk` « Analyser le risque » / « Risico analyseren ».

- [ ] **Step 1: Tests** (FR et NL) : chaque état de la liste ci-dessus ; parcours complet repos → identification → produit → « Analyser le risque » → résultat ; `the pill never shows Identifier while the risk analysis replays the identification` (Review Focus 2) ; `Relancer after a risk error relaunches the risk analysis and keeps the identification` (Review Focus 3) ; `restored analysis shows the risk result; restored identification shows the product and the action; v2 entry shows the risk result` (Review Focus 1) ; `navigation to another listing returns to Identifier` (Review Focus 4) ; action incluse à quota 0, grisée sans inclusion, lien sans abonnement ; focus gardé sur la pilule à chaque changement ; une seule région `aria-live`.
- [ ] **Step 2: Lancer** `pnpm --filter extension test -- risk-badge use-ai-scan` — attendu : FAIL.
- [ ] **Step 3: Implémenter** (retirer la file du hook, fusionner les états, supprimer `IdentifyPill`, adapter les tests existants qui ciblaient deux pilules).
- [ ] **Step 4: Lancer** `pnpm --filter extension test && pnpm -r typecheck && pnpm exec biome check apps/extension` — attendu : vert.
- [ ] **Step 5: Commit** `feat(extension): une seule pilule, identification puis analyse du risque`.

### Task 3: Un seul panneau (Produit, puis Risque)

**Files:**
- Modify: `apps/extension/components/RiskBadge.tsx`, `apps/extension/components/IdentificationSection.tsx`, `apps/extension/components/AiSection.tsx`, `apps/extension/lib/content-i18n.ts`
- Test: `apps/extension/test/risk-badge.test.tsx`, `apps/extension/test/identification-section.test.tsx`, `apps/extension/test/ai-section.test.tsx`

**Interfaces:**
- Produces, dans le panneau « Analyse Radarnaque » :
  - accès déconnecté, sans abonnement, en erreur : écrans actuels de la section IA, une seule fois ;
  - avant l'analyse du risque : `IdentificationSection` (sans son propre en-tête « IDENTIFICATION » si le panneau en a déjà un ; en-tête de section en style `label` « Produit » / « Product »), puis un bouton pleine largeur « Analyser le risque » (mêmes règles que l'action de la pilule, pas de bouton tant que l'identification n'est pas `done`) ;
  - après l'analyse du risque : `AiSection` (avec la ligne « Produit : … »), puis un `<details>` « Détail du produit » / « Productdetails » fermé par défaut qui contient `IdentificationSection` ;
  - pendant une étape en cours : le déroulé de l'étape (`ScanProgressView`).
- Le pied « Analyses restantes : N » n'apparaît qu'une fois dans le panneau.

- [ ] **Step 1: Tests** : panneau avant l'analyse (section Produit puis bouton) ; après (Risque, puis « Détail du produit » fermé, qui s'ouvre au clic et montre la section Produit) ; un seul pied « Analyses restantes » ; accès déconnecté affiché une seule fois ; FR et NL.
- [ ] **Step 2: Lancer** `pnpm --filter extension test -- risk-badge identification-section ai-section` — attendu : FAIL.
- [ ] **Step 3: Implémenter**.
- [ ] **Step 4: Lancer** `pnpm --filter extension test && pnpm -r typecheck` — attendu : vert.
- [ ] **Step 5: Commit** `feat(extension): un seul panneau, produit puis risque`.

### Task 4: Galerie et documentation

**Files:**
- Modify: `apps/extension/dev/gallery.tsx`, `README.md`, `docs/etat-du-projet.md`, `docs/superpowers/plans/2026-10-23-identification-partie-2-suivi.md` (section pilule)
- Create: `docs/superpowers/plans/2026-10-23-identification-pastille-unique-suivi.md`

**Interfaces:**
- Galerie : états de la pilule unique (repos, identification en cours, produit Sûr, Incertain, non identifié, action incluse, action grisée, analyse du risque en cours, résultat, erreur d'identification, erreur d'analyse) et du panneau (avant, après avec « Détail du produit » ouvert) ; captures Playwright gardées hors du dépôt (`.superpowers/shots/identification-pastille/`).
- Documentation : README (parcours en deux temps), état du projet, suivi (vérifications sur les vrais sites, rappel de la régression « Vespa 946 Cheval » à traiter ensuite : `docs/superpowers/plans/2026-10-23-identification-regression-vespa.md`).

- [ ] **Step 1: Implémenter** la galerie et la documentation.
- [ ] **Step 2: Vérifier** la galerie (`pnpm --filter extension gallery`) et prendre les captures.
- [ ] **Step 3: Lancer** toutes les suites : `pnpm --filter extension test && pnpm --filter admin test && pnpm --filter site test && pnpm --filter auth test && pnpm test:scripts && pnpm -r typecheck && pnpm exec biome check .` puis `cd services/api && uv run pytest -q` — attendu : vert.
- [ ] **Step 4: Commit** `docs: pastille unique de l'identification (galerie, README, suivi)`.
