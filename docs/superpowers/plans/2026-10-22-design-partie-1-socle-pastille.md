# Passe design, partie 1 — Socle et pastille : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** un paquet `@radarnaque/design` (tokens, polices, logo animé, icônes), puis une pastille qui n'affiche plus que l'analyse IA (une seule pilule « Analyser ») et son nouveau design : pilule en verre sombre avec le logo animé, panneau, icône des cartes.

**Architecture :**
- **`packages/design`** : CSS partagés (`tokens.css`, `theme.css` pour Tailwind 4, `motion.css`, `fonts.css`), polices WOFF2 embarquées, géométrie du logo (`logo.ts`), quelques icônes Lucide (`icons.ts`), script de génération des PNG.
- **Extension :** WXT copie les polices dans le build et les rend accessibles aux sites pris en charge ; le content script les charge par `FontFace` ; `badge.css` importe les CSS du paquet. La pastille passe d'abord au nouveau comportement (tâche 4), puis au nouveau design (tâches 5 à 7).
- **Vérification visuelle :** une galerie de développement rend chaque état de la pastille, du panneau et des cartes dans un shadow root, pour les captures.

**Tech Stack :** pnpm workspace, WXT 0.21.4, React 19, Tailwind 4, Vitest 5 et Testing Library (happy-dom), `@resvg/resvg-js` (développement), Fontsource (développement).

**Spec :**
- `docs/superpowers/specs/2026-10-22-design-socle-design.md` ;
- `docs/superpowers/specs/2026-10-22-design-pastille-design.md` ;
- la référence visuelle `DESIGN.md` (racine).

La partie 2 (popup et landing) aura son propre plan. Elle reprend aussi trois points du socle laissés de côté ici : le favicon et l'image Open Graph du site (socle §2.5), la suppression de `icon-with-shadow.svg` (la popup s'en sert encore) et l'entrée de la popup dans le garde-fou des tokens.

## Global Constraints

**Git et fichiers locaux :**
- Branche `feat/design`, au-dessus de `feat/phase-4b-2` (PR ouverte). Après la fusion de la partie 2 de la phase 4b dans `main` (par rebase), la branche est rebasée sur `origin/main` avant d'être poussée. Pas de push sans demande.
- Chaque commit porte le trailer `Co-Authored-By` de la session du modèle qui l'écrit.
- Ne jamais toucher : `video/`, `.DS_Store`, `services/api/tests/.conftest.py.swp`, `docs/superpowers/plans/.Rhistory`.
- `web-pages/` n'est jamais lu dans cette partie ; `infra/.env` n'est jamais affiché.
- Aucune donnée réelle dans les tests ou la galerie : annonces fictives, emails en `@radarnaque.test`.

**Langue :** code, commentaires, messages et docs en français, dans le style des fichiers voisins. Textes de l'interface en FR et en NL, parité vérifiée.

**Valeurs fixées par le spec :**

| Élément | Valeur |
|---|---|
| Familles de polices | `"Radarnaque Inter"` (variable, 400 à 600) et `"Radarnaque Serif"` (Instrument Serif 400), partout (site, popup, pastille) |
| Fichiers de polices | `inter-latin-wght-normal.woff2`, `inter-latin-ext-wght-normal.woff2`, `instrument-serif-latin-400-normal.woff2`, `instrument-serif-latin-ext-400-normal.woff2` (Fontsource), plus `OFL-inter.txt` et `OFL-instrument-serif.txt` |
| Logo | grille 32 × 32 ; point plein r = 4 au centre (16, 16) ; arc : cercle r = 10, trait 3,2, `stroke-linecap: round`, `pathLength="360"`, `stroke-dasharray="240 120"`, `stroke-dashoffset="-15"` ; couleur `currentColor` ; SVG toujours en ligne, jamais `<use>` |
| Animation de chargement | 1,6 s, infinie. Trait : 0 % `240 120` / `-15` ; 50 % `24 336` / `-231` ; 100 % `240 120` / `-231` ; chaque moitié `cubic-bezier(.6, 0, .4, 1)`. Groupe : `rotate(0)` → `rotate(144deg)`, linéaire. `transform-box: view-box ; transform-origin: 16px 16px` sur le groupe ; aucun attribut `transform` sur un élément animé |
| Reflet du texte d'état | dégradé `background-clip: text`, 2,2 s, linéaire, infini |
| Mouvement réduit | `prefers-reduced-motion: reduce` : ni rotation, ni variation du trait, ni reflet (texte normal) |
| Tuile d'icône | coins arrondis 22 % ; `--gradient-compact` (160°, `#0649b8` 0 %, `#4e8fe8` 60 %, `#c7b9ec` 100 %) ; logo blanc à 75 % de la tuile à 16 px, 62 % au-delà ; PNG 16, 32, 48, 96, 128 |
| Pilule de la fiche | 28 px de haut, `--r-pill`, verre `--glass-bg-strong` + flou si disponible, bordure blanche 12 %, ombre de la pilule primaire, Inter 13 px poids 500, logo 16 px |
| Panneau | 340 px (≤ 90 vw), `--r-m`, filet `--gradient-hairline` 2 px, score Instrument Serif 44 px, barre 4 px |
| Icône des cartes | 22 px de haut ; repos 22 × 22 avec logo 13 px ; Inter 11 px poids 500 ; infobulle 260 px |
| `z-index` | 2 147 483 000 (pastille, panneau, infobulle) ; plus jamais 2147483647 |
| Niveaux courts des cartes | `card.level.low|medium|high` : « Faible », « Moyen », « Élevé » ; « Laag », « Gemiddeld », « Hoog » |

**Commandes :**
- design : `pnpm --filter @radarnaque/design test && pnpm --filter @radarnaque/design typecheck` ;
- extension : `pnpm --filter extension test && pnpm --filter extension typecheck && pnpm --filter extension build` ;
- racine : `pnpm lint`, puis `pnpm test:all` à la fin.

## Review Focus

1. **Les polices ne se chargent pas** (fichier absent, page hôte avec une CSP qui bloque `chrome-extension://`, Facebook par exemple) : la pastille s'affiche quand même avec la pile de repli, sans erreur non rattrapée ni attente du montage. Test en tâche 2.
2. **Un résultat IA repris du magasin (24 h) sur une fiche déjà analysée** : la pilule affiche directement niveau et score, sans passer par « Analyser » ni lancer d'analyse. Test en tâche 4.
3. **L'accès change pendant que le panneau est ouvert au repos** (connexion faite dans la popup, quota tombé à 0) : la pilule passe de « Analyser » au lien vers les formules ou à l'état `aria-disabled` sans rester bloquée, et n'a jamais deux contrôles « Analyser ». Test en tâche 4.
4. **Une ligne d'état très longue** (requête de recherche web de 200 caractères) : la pilule ne dépasse pas 340 px, le texte est tronqué, la page hôte ne passe pas en défilement horizontal. Test en tâche 5.
5. **Un utilisateur qui réduit les animations** : aucun élément ne tourne ni ne clignote, la ligne d'état reste lisible et les points d'attente restent fixes. Test en tâche 1 (CSS) et tâche 5 (classes).

---

### Tâche 1 : paquet `@radarnaque/design` (tokens, thème, animations, logo, icônes Lucide) et `DESIGN.md`

**Fichiers :**
- Créer :
  - `packages/design/package.json`, `tsconfig.json`, `vitest.config.ts` ;
  - `packages/design/src/tokens.css` ;
  - `packages/design/src/theme.css` ;
  - `packages/design/src/motion.css` ;
  - `packages/design/src/logo.ts` ;
  - `packages/design/src/icons.ts` ;
  - `packages/design/test/logo.test.ts`, `test/css.test.ts`.
- Modifier : `DESIGN.md` (§2.6, §2.7, §4.1, §4.2, §4.3 selon socle §3).

**Interfaces :**
- Fournit :
  - `package.json` : `"name": "@radarnaque/design"`, `"type": "module"`, `"exports"` : `"./tokens.css"`, `"./theme.css"`, `"./motion.css"`, `"./fonts.css"`, `"./fonts/*"`, `"./logo"` (→ `./src/logo.ts`), `"./icons"` (→ `./src/icons.ts`) ; scripts `test`, `typecheck` ;
  - `tokens.css` : tous les tokens de `DESIGN.md` §2.2, §2.4 à §2.6, sur `:root, :host`, plus `--font-sans: "Radarnaque Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` et `--font-serif: "Radarnaque Serif", Georgia, "Times New Roman", serif` ;
  - `theme.css` : un bloc `@theme inline` qui relie les tokens aux utilités Tailwind. Noms : `--color-bg-0..3`, `--color-text-1..3`, `--color-text-on-light`, `--color-border-subtle|default|strong`, `--color-accent`, `--color-accent-soft`, `--color-success|warning|danger|info` et leurs `-soft`, `--color-glass`, `--color-glass-strong`, `--radius-xs|s|m|l|pill`, `--font-sans`, `--font-serif`. Pas d'`@import "tailwindcss"` dedans ;
  - `motion.css` : classes `rq-logo--loading` (sur le `<svg>`), `rq-logo-spin` (le `<g>`), `rq-logo-arc` (le cercle), `rq-shimmer` (texte), images clés `rq-logo-tail`, `rq-logo-rotate`, `rq-shimmer` ;
  - `logo.ts` :
    - `LOGO` : `{ viewBox: "0 0 32 32", center: 16, dotRadius: 4, arcRadius: 10, strokeWidth: 3.2, dashArray: "240 120", dashOffset: -15 } as const` ;
    - `GRADIENT_COMPACT` : `[["#0649b8", 0], ["#4e8fe8", 0.6], ["#c7b9ec", 1]] as const` (copie des tokens pour resvg, qui ignore les variables CSS) ;
    - `logoSvg(options?: { animated?: boolean; size?: number; label?: string }): string` : sans `label`, `aria-hidden="true"` ; avec `label`, `role="img"` et `<title>` ;
    - `iconTileSvg(size: number): string` : la tuile de l'icône (valeurs du tableau) ;
  - `icons.ts` : `ICONS = { close, chevronDown, rotateCcw }`, chacun la liste des éléments SVG Lucide (`d` des `<path>`, viewBox 24, trait 1,5).

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `logo.test.ts` :
    - `logoSvg()` contient `viewBox="0 0 32 32"`, un `<circle` de rayon 4 et un `<circle` avec `pathLength="360"`, `stroke-dasharray="240 120"`, `stroke-dashoffset="-15"`, `stroke-width="3.2"` ; aucun `<use` ; aucun attribut `transform=` ; pas de `rq-logo--loading` ; `aria-hidden="true"` ;
    - `logoSvg({ animated: true })` contient `rq-logo--loading`, `rq-logo-spin` et `rq-logo-arc` ;
    - `logoSvg({ label: "Radarnaque" })` contient `role="img"` et `<title>Radarnaque</title>`, sans `aria-hidden` ; un `label` avec `<` est échappé ;
    - `iconTileSvg(16)` : largeur 16, les trois couleurs de `GRADIENT_COMPACT`, et le groupe du logo mis à l'échelle à 75 % ; `iconTileSvg(128)` à 62 % ;
    - `GRADIENT_COMPACT` a les mêmes couleurs que `--grad-1`, `--grad-2`, `--grad-3` lues dans `tokens.css`.
  - `css.test.ts` :
    - `tokens.css` déclare ses variables sur `:root, :host`, contient `--font-sans` et `--font-serif` avec les familles du tableau ;
    - chaque `var(--x)` de `theme.css` existe dans `tokens.css` ;
    - `motion.css` contient les images clés `rq-logo-tail` (les trois paires de valeurs du tableau), `rq-logo-rotate` (`144deg`), `rq-shimmer`, la durée `1.6s` et `2.2s` ;
    - `motion.css` a un bloc `@media (prefers-reduced-motion: reduce)` qui met `animation: none` sur `.rq-logo--loading .rq-logo-arc`, `.rq-logo--loading .rq-logo-spin` et `.rq-shimmer`, et rend au texte du reflet sa couleur (`color: inherit`, `background: none`).
- [ ] **Étape 2 : lancer les tests.** `pnpm install && pnpm --filter @radarnaque/design test`. Résultat attendu : FAIL (modules absents).
- [ ] **Étape 3 : implémenter.** `vitest.config.ts` en environnement `node`. `tsconfig.json` avec `allowImportingTsExtensions` et `noEmit` (le script de la tâche 3 importe `../src/logo.ts`). Échappement du `label` : `&`, `<`, `>`, `"`. Dans `motion.css`, le groupe porte `transform-box: view-box; transform-origin: 16px 16px`. Le reflet : `linear-gradient(90deg, var(--text-2) 35 %, var(--text-1) 50 %, var(--text-2) 65 %)`, `background-size: 250% 100%`, de `100% 0` à `-150% 0`.
- [ ] **Étape 4 : compléter `DESIGN.md`** avec les ajouts du socle §3 (logo, exception de l'animation de chargement, exception du dégradé de la landing, popup de compte, pastille IA seule et `z-index` 2 147 483 000).
- [ ] **Étape 5 : vérifier.** Commandes du paquet design et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 6 : commiter.** Message : `feat(design): paquet @radarnaque/design (tokens, thème Tailwind, animations, logo)`.

### Tâche 2 : polices embarquées, copiées dans l'extension et chargées par le content script

**Fichiers :**
- Créer :
  - `packages/design/src/fonts/` (les quatre WOFF2 et les deux licences du tableau) ;
  - `packages/design/src/fonts.ts`, `packages/design/src/fonts.css` ;
  - `apps/extension/lib/content/matches.ts` ;
  - `apps/extension/lib/content/fonts.ts` ;
  - `apps/extension/test/fonts.test.ts`, `packages/design/test/fonts.test.ts`.
- Modifier :
  - `packages/design/package.json` (devDependencies `@fontsource/instrument-serif`, `@fontsource-variable/inter` ; script `fonts:copy`) ;
  - `apps/extension/package.json` (dépendance `@radarnaque/design: workspace:*`) ;
  - `apps/extension/wxt.config.ts` (hook `build:publicAssets`, `web_accessible_resources`) ;
  - `apps/extension/entrypoints/content.ts` (`matches` importé, `loadFonts` au démarrage) ;
  - `infra/caddy/Dockerfile` (`COPY packages/design packages/design`).

**Interfaces :**
- Consomme : `@radarnaque/design` (tâche 1).
- Fournit :
  - `FONT_FACES: readonly FontFaceSpec[]` dans `packages/design/src/fonts.ts`, exporté par `"./fonts"`. `FontFaceSpec = { family: "Radarnaque Inter" | "Radarnaque Serif"; file: string; weight: string; unicodeRange: string }`. `weight` vaut `"400 600"` pour Inter et `"400"` pour la serif. Les `unicodeRange` sont ceux des CSS Fontsource (`latin`, `latin-ext`) ;
  - `fonts.css` : un `@font-face` par entrée de `FONT_FACES`, `src: url("./fonts/<file>") format("woff2")`, `font-display: swap` ;
  - `CONTENT_MATCHES` dans `apps/extension/lib/content/matches.ts` : les trois motifs actuels du content script ;
  - `loadFonts(fonts: FontFaceSet, url: (path: string) => string, create?: (family: string, source: string, descriptors: FontFaceDescriptors) => FontFace): Promise<void>` dans `apps/extension/lib/content/fonts.ts`. Elle ajoute une `FontFace` par entrée (`url("/fonts/<file>")`), lance son `load()` et ne rejette jamais : un échec est noté par `console.debug("radarnaque: polices indisponibles (…)")`. Un second appel ne fait rien.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `packages/design/test/fonts.test.ts` : chaque `file` de `FONT_FACES` existe dans `src/fonts/` et apparaît dans `fonts.css` avec sa famille, son `unicode-range` et `font-display: swap` ; les deux licences existent ; quatre entrées.
  - `apps/extension/test/fonts.test.ts` :
    - `loadFonts` ajoute quatre `FontFace` à l'ensemble fourni, avec les familles, les poids et des sources `url("chrome-extension://test/fonts/<file>")` ;
    - un `load()` qui rejette (CSP de la page) : la promesse se résout, un seul `console.debug`, aucune exception ;
    - deux appels n'ajoutent que quatre polices en tout ;
    - le manifeste (`(await import("../wxt.config")).default.manifest()` avec `WXT_PUBLIC_URL` défini) a une entrée `web_accessible_resources` `{ resources: ["fonts/*.woff2"], matches: CONTENT_MATCHES }`.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : FAIL.
- [ ] **Étape 3 : copier les polices.** Ajouter les deux paquets Fontsource en devDependencies du paquet design. Écrire le script `fonts:copy` (`cp` des quatre fichiers et des deux `LICENSE`, renommés comme dans le tableau). Lancer `pnpm --filter @radarnaque/design fonts:copy`. Relever les `unicode-range` dans les CSS des paquets Fontsource pour `FONT_FACES`.
- [ ] **Étape 4 : implémenter.**
  - `wxt.config.ts` : le hook `"build:publicAssets": (_, files) => files.push(...)` copie chaque fichier de `FONT_FACES` vers `fonts/<file>`. `content.ts` et le manifeste lisent `CONTENT_MATCHES`.
  - `content.ts` : `void loadFonts(document.fonts, (path) => browser.runtime.getURL(path as PublicPath))` au début de `main`, sans `await` (le montage n'attend pas les polices).
- [ ] **Étape 5 : vérifier.**
  - Commandes du paquet design et de l'extension.
  - `ls apps/extension/.output/chrome-mv3/fonts` liste les quatre WOFF2.
  - Le `manifest.json` construit contient l'entrée `web_accessible_resources` des polices.
  - Résultat attendu : PASS.
- [ ] **Étape 6 : commiter.** Message : `feat(design): polices Inter et Instrument Serif embarquées, chargées dans la pastille par FontFace`.

### Tâche 3 : icônes de l'extension générées depuis le logo

**Fichiers :**
- Créer : `packages/design/scripts/icons.ts`, `apps/extension/test/icons.test.ts`.
- Modifier :
  - `packages/design/package.json` (devDependency `@resvg/resvg-js` ; script `icons` : `node scripts/icons.ts`) ;
  - `apps/extension/public/icon/{16,32,48,96,128}.png` (régénérés).

**Interfaces :**
- Consomme : `iconTileSvg(size)` (tâche 1).
- Fournit : les cinq PNG de l'extension. `icon-with-shadow.svg` reste jusqu'à la partie 2 (la popup s'en sert encore).

- [ ] **Étape 1 : écrire le test qui échoue.** `icons.test.ts` lit l'en-tête PNG de chaque fichier (largeur et hauteur aux octets 16 à 23) : 16, 32, 48, 96 et 128 px, carrés. Il vérifie aussi que l'empreinte SHA-256 de `128.png` n'est plus `cc646465937d38c0946585b774380c122a3ddc7737e29670cb7f24352dd8b5e2` (l'icône par défaut de WXT, la pièce de puzzle).
- [ ] **Étape 2 : lancer le test.** Résultat attendu : FAIL sur l'empreinte.
- [ ] **Étape 3 : implémenter `scripts/icons.ts`.** Pour chaque taille : `new Resvg(iconTileSvg(size), { fitTo: { mode: "width", value: size } }).render().asPng()`, écrit dans `apps/extension/public/icon/<size>.png`. Lancer `pnpm --filter @radarnaque/design icons`.
- [ ] **Étape 4 : vérifier.** Commandes de l'extension. Ouvrir `16.png` et `128.png` (Read) : tuile dégradée, point et arc blancs, ouverture en haut à droite. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(extension): icônes générées depuis le logo de Radarnaque`.

### Tâche 4 : pastille, seule l'IA donne un résultat (comportement)

**Fichiers :**
- Créer : `apps/extension/components/BadgePill.tsx` (reprend `useLaunch`, `badgeError`, `noScansLeft` et le contenu de `BadgeActions.tsx`).
- Supprimer : `apps/extension/components/BadgeActions.tsx`.
- Modifier :
  - `apps/extension/components/RiskBadge.tsx` ;
  - `apps/extension/lib/content/shown-result.ts` (commentaire : plus d'analyse locale affichée) ;
  - `apps/extension/lib/content-i18n.ts` (clés retirées) ;
  - `apps/extension/components/risk-styles.ts` (`SEVERITY_STYLE` reste pour les raisons de l'IA).
- Tests : `apps/extension/test/risk-badge.test.tsx`, `test/content-i18n.test.ts`, `test/ai-error-boundary.test.tsx`.

**Interfaces :**
- Consomme : `useAiScan`, `AiScan`, `shownResult`, `statusLine`, `useWaiting`, `useThrottled`, `LiveLine` (inchangés).
- Fournit :
  - `BadgePill({ scan, locale, open, onToggle, onLaunch }: { scan: AiScan; locale: Locale; open: boolean; onToggle(): void; onLaunch(): void })`. Il rend selon l'état, dans cet ordre :
    1. résultat (`shownResult(scan.ai)`) : un `<button aria-expanded={open} aria-label={badge.aria}>`, décrit par le niveau et le score visibles ;
    2. en cours : un `<button aria-expanded aria-busy>`, avec la ligne d'état ;
    3. erreur : un conteneur avec le message (masqué si `open`), puis « Relancer » (`RELAUNCH_CODES`) ou le contrôle de lancement ; rien si l'accès relu ne laisse plus d'analyse ;
    4. repos : le contrôle de lancement ;
  - contrôle de lancement : texte `ai.launchShort`, nom `ai.launch` ; lien vers les formules sans abonnement (accès connu) ; `aria-disabled` avec la raison `ai.noScansLeft` sans analyse restante ; sinon `onLaunch` ;
  - `useLaunch`, `badgeError` et `RELAUNCH_CODES`, exportés comme avant (depuis `BadgePill.tsx` et `AiSection.tsx`).
- `RiskBadge` ne lit plus `report.level`, `report.score` ni `report.signals` pour l'affichage. Le `report` reste passé à `useAiScan`.
- Clés retirées (FR et NL) : `panel.none`, `panel.footer`, `panel.titleAi`, `badge.ariaAi`, `ai.badgeTag`, les textes des règles et `signalText`, plus toute clé que `tsc` et la recherche montrent sans usage. Les identifiants de règles (`RuleId`) restent dans `lib/rules`.

- [ ] **Étape 1 : réécrire les tests qui décrivent l'ancien comportement**, dans `risk-badge.test.tsx` :
  - supprimer ou remplacer les tests de l'analyse locale affichée (« niveau faible : texte, score… », « panel.none », « liste les signaux par gravité », « la gravité est aussi indiquée en texte », « le bouton est décrit par le niveau et le score visibles » pour le local, « le pied de panneau… », « avant le scan : pastille Risque moyen 40/100… », « I2 : … pastille locale », « scan en cours … l'analyse locale reste affichée », « sellerKind professional sans IA : … score local conservé »).
  - Nouveaux tests :
    - `au repos : une seule pilule « Analyser », aucun niveau ni score local` : rapport local `high` à 90 → aucun texte « Risque », aucun « 90/100 », un seul contrôle nommé `ai.launch` ;
    - `au repos, le clic lance l'analyse (accès actif en cache) sans ouvrir de panneau` ;
    - `résultat IA : pilule niveau et score de l'IA, décrite par eux ; un clic ouvre le panneau, un second le ferme` ;
    - `résultat repris du magasin : niveau et score affichés tout de suite, aucun scan, aucun « Analyser »` ;
    - `analyse en cours : le clic ouvre le panneau avec le déroulé` ;
    - `panneau : titre « Analyse Radarnaque », ni signaux locaux ni pied de page local` ;
    - `la demande d'analyse contient toujours signals et rulesVersion du rapport local` (le test existant reste) ;
    - `vendeur professionnel au repos : le bandeau est en tête du panneau ouvert, sans score local` ;
    - `accès relu pendant que le panneau est ouvert (signedOut → sans abonnement) : la pilule devient le lien vers les formules, un seul contrôle de lancement` (Review Focus 3) ;
    - `accès relu à 0 analyse : la pilule reste focusable, aria-disabled, décrite par ai.noScansLeft`.
  - Les tests de `useLaunch` (déconnecté, connexion impossible, quota épuisé, `analysis_failed`, `quota_exhausted`, analyse interrompue, échec panneau ouvert) restent et ciblent le nouveau contrôle.
  - `content-i18n.test.ts` : retirer les tests de `signalText` et des clés supprimées ; la parité FR/NL reste.
- [ ] **Étape 2 : lancer les tests.** `pnpm --filter extension test`. Résultat attendu : FAIL sur les nouveaux tests.
- [ ] **Étape 3 : implémenter `BadgePill` et alléger `RiskBadge`.** Garder les classes actuelles (le design vient en tâche 5). Supprimer `LocalSignals` et `Sparkle`. Retirer les clés, puis `pnpm --filter extension typecheck` pour trouver les usages restants.
- [ ] **Étape 4 : vérifier.** Commandes de l'extension et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(extension): la pastille n'affiche plus l'analyse locale, une seule pilule « Analyser »`.

### Tâche 5 : pilule de la fiche, logo animé et ligne d'état avec reflet

**Fichiers :**
- Créer : `apps/extension/components/Logo.tsx`.
- Modifier :
  - `apps/extension/components/badge.css` (imports du paquet, `--font-sans` sur `:host`, suppression de `radarnaque-spin` et `radarnaque-fade` remplacés par `motion.css`, maintien de `is-waiting`) ;
  - `apps/extension/components/BadgePill.tsx`, `LiveStatus.tsx` (`Spinner` supprimé, `LiveLine` avec `rq-shimmer`) ;
  - `apps/extension/components/risk-styles.ts` (classes reliées aux tokens).
- Tests : `apps/extension/test/risk-badge.test.tsx`, `test/live-status.test.tsx` (à créer si absent).

**Interfaces :**
- Consomme : `LOGO` (tâche 1), classes de `motion.css`, utilités de `theme.css`.
- Fournit :
  - `Logo({ size, animated, className }: { size: number; animated?: boolean; className?: string })` : SVG en ligne de `LOGO`, `aria-hidden`, `rq-logo--loading` seulement si `animated` ;
  - `LEVEL_STYLE: Record<RiskLevel, { dot: string; text: string; soft: string; bar: string }>` : `bg-success`, `bg-warning`, `bg-danger` ; textes `text-success|warning|danger` ; fonds doux `bg-success-soft…` ; barres ;
  - `SEVERITY_STYLE` : `danger` → `bg-danger-soft text-danger`, `warning` → `bg-warning-soft text-warning`, `info` → `bg-info-soft text-info` ;
  - `PILL_CLASS` (exporté de `BadgePill.tsx`, réutilisé en tâche 7) : la pilule du tableau des valeurs.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `au repos : le logo est présent, sans rq-logo--loading` ;
  - `en cours : le logo porte rq-logo--loading et la ligne d'état rq-shimmer ; plus aucun radarnaque-spin` ;
  - `résultat : point, niveau en toutes lettres, séparateur, score ; la couleur vient de LEVEL_STYLE (bg-danger pour high)` ;
  - `erreur : logo sans animation et à 60 % d'opacité, message, « Relancer »` ;
  - `ligne d'état de 200 caractères : tronquée (classe truncate) dans une pilule bornée à 340 px` (Review Focus 4) ;
  - `badge.css` : importe `@radarnaque/design/tokens.css`, `theme.css`, `motion.css` ; plus de `@keyframes radarnaque-spin` ; le bloc de mouvement réduit garde les points d'attente fixes (`content: "…"`) ;
  - le test existant « animations réduites : ni rotation, ni fondu, ni points animés » est adapté aux nouvelles classes.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : FAIL.
- [ ] **Étape 3 : implémenter.** Ordre des imports dans `badge.css` : `tailwindcss`, puis `tokens.css`, `theme.css`, `motion.css`. Garder le bloc `--tw-*` sur `:host` et `--spacing: 4px`. Verre : `bg-glass-strong` et `supports-[backdrop-filter]:backdrop-blur-[18px]`. Pilule : `max-w-[340px]`, ligne d'état `truncate min-w-0`. Focus : `focus-visible:shadow-[var(--focus-ring)]`.
- [ ] **Étape 4 : vérifier.** Commandes de l'extension et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(extension): pilule de la pastille en verre sombre, logo animé et reflet de la ligne d'état`.

### Tâche 6 : panneau de la pastille

**Fichiers :**
- Modifier :
  - `apps/extension/components/RiskBadge.tsx` (carte, en-tête, fermeture, bandeau professionnel) ;
  - `apps/extension/components/AiSection.tsx` (bloc du score, contenus, états sans résultat) ;
  - `apps/extension/components/ScanProgressView.tsx`, `DebugSection.tsx` (tokens seulement).
- Tests : `apps/extension/test/risk-badge.test.tsx`, `test/ai-section.test.tsx`, `test/debug-section.test.tsx`.

**Interfaces :**
- Consomme : `Logo`, `LEVEL_STYLE`, `SEVERITY_STYLE`, `PILL_CLASS` (tâche 5), `ICONS.close` (tâche 1).
- Fournit, dans le panneau (`role="dialog"`, `aria-label` `panel.title`) :
  - en-tête : `Logo` 14 px, `panel.title` en style `label`, bouton de fermeture (icône `close`, nom `panel.close` : « Fermer » / « Sluiten », nouvelle clé) qui ferme et rend le focus à la pilule ;
  - `ResultView` : nombre en `font-serif` 44 px et chiffres tabulaires, `/100`, badge de verdict (`LEVEL_STYLE.soft` et `text`, point et niveau), barre `role="presentation"` de largeur `score %` ; puis résumé, `ai.advice`, `ai.reasons` en style `label` ; raisons avec `SEVERITY_STYLE` ;
  - pied : `ai.remaining` à gauche, `ScanProgressView` repliable à droite ; `ai.fromCache`, `ai.partial`, `ai.noPhoto` en `text-xs text-text-3` ;
  - états sans résultat (`AccessBody`, `ErrorNotice`) : la première phrase en `font-serif` 22 px, puis l'action en pilule blanche (`bg-white text-text-on-light`, ombre primaire) ;
  - le `h3` `ai.title` devient `sr-only` (le panneau a son en-tête) ;
  - `z-[2147483000]`.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `panneau : en-tête avec le titre et un bouton « Fermer » qui ferme et rend le focus à la pilule` ;
  - `résultat high 82 : « 82 » et « /100 » dans le bloc du score, badge « Risque élevé », barre à 82 %` ;
  - `raisons : chaque badge de gravité garde son texte et prend SEVERITY_STYLE` ;
  - `déconnecté : phrase ai.loginHint en titre serif, bouton « Se connecter » en pilule blanche` ;
  - `nl : « Sluiten »` ; parité de `panel.close` ;
  - `aucune classe z-[2147483647] dans RiskBadge` ;
  - les tests existants de `ai-section.test.tsx` et `debug-section.test.tsx` restent verts.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : FAIL.
- [ ] **Étape 3 : implémenter.** Échap et le clic à l'extérieur ne changent pas (`useDismiss`).
- [ ] **Étape 4 : vérifier.** Commandes de l'extension et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(extension): panneau de la pastille (score serif, verdict, barre, raisons, fermeture)`.

### Tâche 7 : icône des cartes de résultats

**Fichiers :**
- Modifier :
  - `apps/extension/components/CardBadge.tsx` ;
  - `apps/extension/lib/content-i18n.ts` (`card.level.low|medium|high`).
- Tests : `apps/extension/test/card-badge.test.tsx`, `test/content-i18n.test.ts`.

**Interfaces :**
- Consomme : `Logo`, `LEVEL_STYLE`, `PILL_CLASS` (tâche 5).
- Fournit : `CARD_LEVEL_KEY: Record<RiskLevel, ContentKey>` dans `risk-styles.ts`.

- [ ] **Étape 1 : écrire les tests qui échouent.**
  - `repos : le logo seul, pas de « R », nom card.aria` ;
  - `en cours : logo animé, nom card.loading` ;
  - `résultat high : point et « Élevé » visibles ; nom accessible « Risque élevé »` ; idem `nl` → « Hoog » et « Hoog risico » ;
  - `erreur : « ! » en text-danger, nom card.aria` ;
  - `infobulle : aucune classe z-[2147483647]` ;
  - parité FR/NL des trois nouvelles clés.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : FAIL.
- [ ] **Étape 3 : implémenter.** Le nom accessible du bouton terminé est le niveau complet (`aria-label` = `LEVEL_KEY`) ; le texte visible est le niveau court. Les gestionnaires d'événements de la carte-lien ne changent pas.
- [ ] **Étape 4 : vérifier.** Commandes de l'extension et `pnpm lint`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(extension): icône des cartes en mini-pilule, logo et niveaux courts`.

### Tâche 8 : garde-fou des tokens, galerie visuelle et document de suivi

**Fichiers :**
- Créer :
  - `apps/extension/test/design-tokens.test.ts` ;
  - `apps/extension/dev/gallery.html`, `apps/extension/dev/gallery.tsx`, `apps/extension/vite.gallery.config.ts` ;
  - `docs/superpowers/plans/2026-10-22-design-partie-1-suivi.md`.
- Modifier : `apps/extension/package.json` (script `gallery` : `vite --config vite.gallery.config.ts --port 3101 --strictPort`).

**Interfaces :**
- Consomme : `RiskBadge`, `CardBadge`, `badge.css`, `loadFonts`.
- Fournit : une page de développement qui rend, chacun dans son shadow root et sur fond blanc (titre d'annonce fictif à côté) :
  - la pilule au repos, en cours (ligne d'état longue comprise), avec un résultat faible, moyen et élevé, et en erreur ;
  - le panneau ouvert avec un résultat élevé, une annonce professionnelle et un compte déconnecté ;
  - trois cartes (repos, en cours, résultat) ;
  - en FR et en NL.
  Les clients IA et d'accès sont des doublures locales, sans réseau.

- [ ] **Étape 1 : écrire le test qui échoue.** `design-tokens.test.ts` parcourt `components/*.tsx`, `components/*.ts` et `components/badge.css`. Il échoue s'il trouve une couleur hexadécimale, `rgb(`, une classe Tailwind de couleur brute (`slate-`, `gray-`, `red-`, `green-`, `amber-`, `emerald-`, `brand-`) ou `2147483647`. Liste d'exceptions vide pour cette partie ; la popup (`entrypoints/popup`) entre dans le parcours en partie 2.
- [ ] **Étape 2 : lancer le test.** Résultat attendu : PASS si les tâches 4 à 7 sont complètes ; sinon corriger les restes (`DebugSection`, `AiErrorBoundary`, `ScanProgressView`).
- [ ] **Étape 3 : écrire la galerie.** `vite.gallery.config.ts` : React (`@vitejs/plugin-react` en devDependency) et `@tailwindcss/vite`, racine `dev/`. `gallery.tsx` monte chaque état dans un `attachShadow({ mode: "open" })` avec le CSS de `badge.css?inline` passé par `shadowCssOf`. Il importe `@radarnaque/design/fonts.css` au niveau du document : un `@font-face` du document s'applique aussi dans les shadow roots.
- [ ] **Étape 4 : vérifier visuellement.** `pnpm --filter extension gallery`, puis captures (Playwright) à 1280 px. Contrôler, état par état :
  - les écarts avec le tableau des valeurs ;
  - l'arc qui tourne et reste centré : relevés de `getComputedStyle` à deux instants ;
  - un contraste d'au moins 4,5:1 pour les textes du panneau ;
  - l'absence de défilement horizontal.
  Corriger avant de continuer.
- [ ] **Étape 5 : écrire le suivi.** Sur le modèle de `2026-10-21-phase-4b-partie-2-suivi.md` :
  - ce qui est livré ;
  - les vérifications en conditions réelles à faire par l'utilisateur : extension chargée sur une fiche 2ememain, une fiche 2dehands, une fiche et une liste Facebook Marketplace ; polices chargées ou repli propre sur Facebook ; icône lisible dans une barre d'outils claire et une sombre ; pastille en FR et en NL ; mouvement réduit activé dans le système ;
  - ce qui reste pour la partie 2.
- [ ] **Étape 6 : vérifier.** `pnpm lint`, puis `pnpm test:all`. Résultat attendu : PASS.
- [ ] **Étape 7 : commiter.** Message : `test(extension): garde-fou des tokens, galerie visuelle de la pastille et suivi de la partie 1`.
