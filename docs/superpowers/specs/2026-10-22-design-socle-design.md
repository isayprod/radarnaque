# Design — Socle commun

*Spec du 22 octobre 2026.* Passe design de Radarnaque, avant Stripe (phase 5). Elle habille trois surfaces avec un même langage visuel, celui de [`DESIGN.md`](../../../DESIGN.md). Elle est décrite en quatre documents :

| Document | Contenu |
|---|---|
| **Ce document** | paquet `packages/design` : tokens, polices, logo, animation de chargement, icônes ; mises à jour de `DESIGN.md` |
| [Pastille](2026-10-22-design-pastille-design.md) | pastille de la fiche (nouveau comportement, puis design), panneau, icône des cartes |
| [Popup](2026-10-22-design-popup-design.md) | popup de l'extension (compte), sans nouvelle fonction |
| [Landing](2026-10-22-design-landing-design.md) | page d'accueil créée de zéro, animations au scroll, `/pricing`, `/privacy` et `/auth/callback` réalignées |

**Branche :** `feat/design`, au-dessus de `feat/phase-4b-2` (la page `/pricing` y a été réécrite). Elle est rebasée sur `main` une fois la partie 2 de la phase 4b fusionnée.

**Livraison en deux parties :**

1. socle et pastille ;
2. popup et landing.

**Hors périmètre :** l'administration (`apps/admin`), la page d'options, l'affichage d'un résultat dans la popup (options B et C, phase suivante), le paiement.

## 1. Objectifs

- Une seule source pour les couleurs, les polices, les rayons, les durées et le logo, utilisée par l'extension et le site.
- Remplacer l'icône par défaut de WXT (pièce de puzzle) par le logo de Radarnaque.
- Une animation de chargement propre à Radarnaque : le logo lui-même qui s'anime.

## 2. Paquet `packages/design`

Nouveau paquet du workspace, `@radarnaque/design`, sans dépendance d'exécution :

```
packages/design/
  package.json        exports : tokens.css, motion.css, fonts.css, fonts/*, logo (TS)
  src/tokens.css      tokens de DESIGN.md §2
  src/motion.css      animations partagées (logo, reflet du texte d'état, apparition)
  src/fonts.css       @font-face des polices (pages de l'extension et site)
  src/fonts/          WOFF2 + licences OFL
  src/logo.ts         géométrie du logo, SVG en chaîne
  src/icons.ts        quelques icônes Lucide (licence ISC) : fermer, chevron, relancer
  scripts/icons.ts    génération des PNG (icônes de l'extension, favicon, image Open Graph)
```

### 2.1 Tokens

- `tokens.css` reprend tels quels les tokens de `DESIGN.md` §2.2, §2.4, §2.5 et §2.6 : couleurs, dégradés, verre, bordures, textes, sémantique, rayons, ombres, durées et courbes.
- Les variables sont déclarées sur `:root, :host` : elles s'appliquent dans une page normale comme dans le Shadow DOM de la pastille.
- **Extension (Tailwind 4) :** un fichier `@theme` relie chaque token à une utilité Tailwind (`--color-bg-0: var(--bg-0)`, `--color-danger: var(--danger)`, `--radius-m: var(--r-m)`, etc.). Plus aucune couleur Tailwind brute (`slate-*`, `red-*`, `brand-*`) dans les composants restylés.
- **Site (CSS simple) :** les pages importent `tokens.css` directement.
- **Règle :** aucune valeur brute (hex, taille de police, rayon) hors de `tokens.css`, sauf les couleurs de la maquette de 2ememain sur la landing (§4 de la spec Landing), qui imitent un site tiers.

### 2.2 Polices

- **Instrument Serif** (400, normal) et **Inter** (variable, 400 à 600), sous-ensembles `latin` et `latin-ext` (accents FR et NL), au format WOFF2. Fichiers repris des paquets Fontsource, copiés dans `src/fonts/` avec leurs licences OFL.
- **Pages de l'extension (popup) et site :** `fonts.css` les déclare par `@font-face`, avec `font-display: swap`. Les fichiers sont embarqués dans l'extension et servis par le site ; jamais de CDN.
- **Pastille (Shadow DOM) :** un `@font-face` déclaré dans un shadow root est ignoré par Chrome. Le content script charge donc les polices une seule fois avec `document.fonts.add(new FontFace("Radarnaque Inter", url))` et `"Radarnaque Serif"`. Les URL viennent de `browser.runtime.getURL`, et les fichiers sont déclarés dans `web_accessible_resources` pour les seuls sites pris en charge. Aucun `<style>` n'est ajouté à la page hôte. Si le chargement échoue, la pile de repli (`system-ui`, etc.) s'applique sans erreur visible.

### 2.3 Logo

- **Forme :** un point plein (rayon 4) au centre d'un arc de 240° (rayon 10, trait 3,2, extrémités arrondies), sur une grille de 32 × 32. L'ouverture de l'arc, 120°, est centrée en haut à droite (de 255° à 15°, sens horaire depuis 3 h).
- **Tracé :** l'arc est un cercle complet avec `pathLength="360"`, `stroke-dasharray="240 120"` et `stroke-dashoffset="-15"`. Ce tracé permet l'animation du §2.4 sans changer de forme.
- **`logo.ts`** exporte la géométrie (constantes) et `logoSvg({ animated })`, qui rend le SVG en chaîne pour le site. L'extension en tire un composant React `<Logo animated?>`. Le SVG est toujours **en ligne** : une animation CSS n'atteint pas l'intérieur d'un `<use>`.
- **Couleur :** `currentColor`. Blanc sur le dégradé et sur le verre sombre.

### 2.4 Animation de chargement

Validée sur maquette (tempo « fluide ») :

- **Mouvement :** la queue de l'arc rattrape la tête en rétrécissant jusqu'à un petit trait (24°), puis la tête repart en s'agrandissant jusqu'à 240°, pendant que l'ensemble tourne.
- **Courbes :** cycle de 1,6 s, en boucle.
  - Le trait : `stroke-dasharray` de `240 120` à `24 336` puis à `240 120`, `stroke-dashoffset` de `-15` à `-231` ; chaque moitié en `cubic-bezier(.6, 0, .4, 1)`.
  - La rotation : un groupe `<g>` tourne de 0 à 144° en linéaire. Le trait a avancé de 216° : 216 + 144 = 360°, la boucle est continue.
  - `transform-box: view-box` et `transform-origin: 16px 16px` sur le groupe tournant. Jamais d'attribut `transform` sur un élément qui reçoit aussi un `transform-origin` en CSS : les deux se combinent et décentrent l'arc.
- **Reflet du texte d'état :** à côté du logo animé, le texte d'état est balayé par un reflet (dégradé `background-clip: text`, 2,2 s, linéaire).
- **`prefers-reduced-motion: reduce` :** ni rotation, ni variation du trait, ni reflet. Le logo reste dans sa forme de repos et le texte est affiché normalement.
- Les images clés vivent dans `motion.css`, partagées par la pastille, la popup et la landing.

### 2.5 Icônes et images générées

`scripts/icons.ts` (dépendance de développement `@resvg/resvg-js`) produit des PNG versionnés :

- **Extension :** `apps/extension/public/icon/{16,32,48,96,128}.png`. Une tuile carrée à coins arrondis (22 %) remplie de `--gradient-compact`, avec le logo blanc. À 16 px, le logo occupe 75 % de la tuile. Lisibilité vérifiée sur une barre d'outils claire et une sombre. `icon-with-shadow.svg` est supprimé.
- **Site :** `favicon.svg` (la tuile en SVG), `favicon-32.png`, `apple-touch-icon.png` (180 px).
- **Image Open Graph** (1200 × 630) : le dégradé du hero, le logo, « Radarnaque » et l'accroche de la landing, en FR et en NL. Les polices du §2.2 sont passées à resvg.

Le script se lance à la main (`pnpm --filter @radarnaque/design icons`) ; les PNG sont commités, le build ne les régénère pas.

## 3. Mises à jour de `DESIGN.md`

`DESIGN.md` est versionné à la racine du dépôt avec ces ajouts :

- **§2.7 :** le logo (forme, tracé, couleur) et les icônes générées.
- **§2.6, exception :** l'animation de chargement du §2.4 est le seul élément qui tourne. Elle n'est permise que comme indicateur d'attente, jamais en décoration.
- **§4.1, exception :** sur la landing, le dégradé suit le scroll du haut au bas de la page (spec Landing §5). C'est la seule surface où le dégradé dépasse une zone.
- **§4.2 :** la popup est une popup de compte, sans résultat d'analyse. Les états « résultat » et « page non prise en charge » attendent la phase qui affichera le résultat dans la popup.
- **§4.3 :** la pastille ne montre que l'analyse IA ; `z-index` de 2 147 483 000 pour la pastille et ses panneaux.

## 4. Construction

- L'extension et le site dépendent de `@radarnaque/design` (`workspace:*`).
- **Docker (Caddy) :** `infra/caddy/Dockerfile` copie `packages/design` avant l'installation, comme `packages/shared`.
- **WXT :** les polices sont copiées dans le build de l'extension et déclarées dans `web_accessible_resources` (`fonts/*.woff2`) pour les motifs du content script.

## 5. Tests

- **Logo :** `logoSvg()` donne un SVG valide, sans `<use>`. La version animée a son groupe tournant et la classe de l'arc ; la version statique n'a aucune classe d'animation.
- **Animation :** les images clés de `motion.css` existent, et elles sont neutralisées sous `prefers-reduced-motion` (test sur le texte du CSS).
- **Tokens :** aucune couleur hexadécimale ni taille en `px` de police dans les fichiers CSS et TSX restylés de l'extension et du site, hors `tokens.css` et la maquette de la landing (test par recherche de motifs, avec une liste d'exceptions explicite).
- **Icônes :** les cinq PNG de l'extension existent aux bonnes dimensions ; le manifeste les référence.
- **Polices :** le manifeste construit déclare `fonts/*.woff2` dans `web_accessible_resources`, pour les seuls sites pris en charge.
