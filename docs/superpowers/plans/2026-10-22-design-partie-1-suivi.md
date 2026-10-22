# Passe design, partie 1 — Points de suivi

Remarques relevées pendant la partie 1 de la passe design : paquet `@radarnaque/design` (tokens, polices, logo animé, icônes), pastille qui n'affiche plus que l'analyse IA, puis son nouveau design (pilule, panneau, icône des cartes). Elles sont triées par échéance ; les points déjà corrigés n'y figurent pas. La spécification est dans le [socle](../specs/2026-10-22-design-socle-design.md) et la [pastille](../specs/2026-10-22-design-pastille-design.md), avec [`DESIGN.md`](../../../DESIGN.md) pour la référence visuelle. Le plan est dans [`2026-10-22-design-partie-1-socle-pastille.md`](2026-10-22-design-partie-1-socle-pastille.md).

## Ce qui est livré

- **Paquet `@radarnaque/design`** : `tokens.css` (couleurs, rayons, ombres, mouvement, familles de polices), `theme.css` (utilités Tailwind 4 : `bg-glass-host`, `text-text-2`, `rounded-xs|sm|md|lg|pill`…), `motion.css` (logo de chargement, reflet du texte d'état, mouvement réduit), `fonts.css` et les quatre WOFF2 avec leurs licences OFL, la géométrie du logo (`logo.ts`), quelques icônes Lucide (`icons.ts`) et le script des PNG de l'extension (16 à 128 px).
- **Polices de la pastille** : copiées dans le build, déclarées dans `web_accessible_resources` pour les sites pris en charge, chargées par `FontFace` sans bloquer le montage ; la pile de repli prend le relais si la page les refuse.
- **Pastille IA seule** : une pilule « Analyser » au repos, la ligne d'état pendant l'analyse, puis le niveau et le score de l'IA ; l'analyse locale n'est plus affichée. Un résultat gardé 24 h s'affiche directement.
- **Nouveau design** : pilule en verre sombre avec le logo animé et le reflet de la ligne d'état, panneau (score serif, verdict, barre, raisons, mentions, fermeture), icône des cartes en mini-pilule avec niveaux courts et infobulle.
- **Garde-fou des tokens** (`apps/extension/test/design-tokens.test.ts`) : aucun hexadécimal, `rgb()`, couleur brute de Tailwind ni `z-index` 2147483647 dans `components/`. Aucune exception.
- **Galerie visuelle** : `pnpm --filter extension gallery`, puis `http://localhost:3101/gallery.html` (`?lang=fr` ou `?lang=nl` pour une seule langue). Chaque état de la pilule, du panneau et des cartes, dans son shadow root, sur une fiche fictive à fond blanc, avec des doublures des clients IA et d'accès (aucun réseau).

## Décisions prises pendant l'exécution

À garder en tête en relisant ou en faisant évoluer la pastille.

- **Verre des pages tierces :** toutes les surfaces injectées (pilule, panneau, icône des cartes, infobulle) utilisent `--glass-bg-host` (`rgba(3, 16, 51, .96)`), pas `--glass-bg-strong` : sur une page blanche, le verre à 82 % s'éclaircit trop. Les textes à lire y sont en `--text-2` ; `--text-3` reste aux marques décoratives et aux contrôles désactivés.
- **Rayons du thème :** `rounded-sm|md|lg` et non `rounded-s|m|l`, qui sont aussi des utilités logiques de Tailwind 4 (coins de début, coins gauches).
- **Restauration du magasin :** pendant la lecture des résultats gardés (quelques millisecondes), la pastille ne rend rien, pour qu'une fiche déjà analysée n'affiche jamais « Analyser » avant son résultat.
- **Bandeau professionnel** placé juste sous l'en-tête du panneau, la fermeture restant en haut à droite.
- **Contrôles de lancement :** panneau ouvert au repos, la pilule « Analyser » et le bouton de la section IA coexistent ; un seul porte le nom « Analyser avec l'IA ».
- **Vérification visuelle (galerie) :**
  - le panneau et l'infobulle des cartes sont décalés vers la gauche quand ils dépasseraient le bord droit de la fenêtre (`useKeepInView`, 8 px de marge, recalcul à chaque rendu et au redimensionnement) : une pastille au bout d'un titre près du bord faisait défiler la page hôte horizontalement ;
  - le filet en dégradé forme le bord haut du panneau (`border-t-0`) : la bordure grise du haut se voyait au-dessus ;
  - une seule pilule blanche par vue : quand l'erreur a sa propre action (connexion, formules), « Lancer une analyse IA » passe en pilule secondaire (transparente, bordure `--border-strong`) ;
  - le badge de gravité « Info » a son texte en `--text-1` sur `--info-soft` : `--info` n'y atteignait que 4,3:1 ;
  - les pilules blanches ne se soulèvent plus au survol si l'utilisateur réduit les animations ;
  - `badge.css` déclare `@source "./"` : la galerie a sa propre racine Vite (`dev/`), que Tailwind aurait été seul à parcourir ; et `@source not "../dev"`, pour que le build de l'extension ne parcoure jamais la galerie.
- **Contraste mesuré dans la galerie** (couleurs calculées, sur fond blanc) : 5,17:1 au plus bas pour les textes actifs (« Risque élevé » en `--danger` sur `--danger-soft`), 8,16:1 pour `--text-2`, 17,15:1 pour `--text-1`. Seule la pilule désactivée (« Analyser » sans analyse restante, `--text-3`) est sous 4,5:1 (3,99:1), ce qu'admet le WCAG pour un contrôle inactif.

## À vérifier en conditions réelles

Rien de ceci n'a été essayé hors des tests et de la galerie. Extension construite (`pnpm --filter extension build`) et chargée dans Chrome.

- **Une fiche 2ememain** (FR) : pastille après le titre, au repos (« Analyser »), pendant l'analyse (logo qui tourne, ligne d'état avec reflet, points de suspension après 4 s sans événement), puis le résultat ; panneau ouvert, Échap et clic à l'extérieur le ferment ; rechargement de la page : le résultat revient directement, sans « Analyser » avant.
- **Une fiche 2dehands** (NL) : mêmes étapes, textes en néerlandais partout (pilule, panneau, infobulles).
- **Facebook Marketplace, une fiche et une liste** :
  - la pastille de la fiche, dans la modale de l'annonce ; Échap ferme le panneau sans fermer la modale ;
  - les icônes des cartes de la liste : repos (logo seul), analyse en cours, niveau court, infobulle au survol ; un clic ne navigue pas vers l'annonce ;
  - **polices :** Facebook peut bloquer `chrome-extension://` (CSP). Vérifier dans l'onglet Réseau si les WOFF2 se chargent ; sinon, la pastille doit s'afficher proprement avec la pile de repli (system-ui), sans erreur dans la console.
- **Icône de l'extension** lisible dans une barre d'outils claire et dans une sombre (thème Chrome), à 16 px comme dans le menu des extensions.
- **Pastille en FR et en NL** : préférence de langue de la popup, puis sans préférence (2ememain en FR, 2dehands en NL, Facebook selon la langue du navigateur).
- **Mouvement réduit** activé dans le système (macOS : Accessibilité, Affichage, Réduire les animations) : aucun élément ne tourne ni ne clignote, la ligne d'état est lisible sans reflet, les points d'attente restent fixes.
- **Pastille près du bord droit** (fenêtre étroite) : le panneau et l'infobulle restent dans la fenêtre, sans défilement horizontal de la page.
- **Contraste sur une page hôte sombre** (Facebook en mode sombre) : le verre presque opaque garde les mêmes valeurs ; vérifier à l'œil que la bordure blanche à 12 % détache encore la pilule du fond.

## Ce qui reste pour la partie 2

- **Popup et landing** : leur passage au design (plan à écrire).
- **Socle laissé de côté** : le favicon et l'image Open Graph du site (socle §2.5), la suppression de `icon-with-shadow.svg` (la popup s'en sert encore), et l'entrée de la popup (`entrypoints/popup`) dans le garde-fou des tokens.
- **Points mineurs reportés pendant la partie 1**, à reprendre à la relecture finale ou en partie 2 :
  - focus clavier perdu quand la pilule passe en erreur (bouton remplacé par un `span`) et après « Relancer » ; Échap ne rend pas le focus à la pilule ;
  - panneau nommé par `aria-label` plutôt que par `aria-labelledby` vers son titre ;
  - `loadFonts` : une exception à la création d'une police saute les suivantes ;
  - tests de `motion.css` par recherche de sous-chaînes ; `icons.ts` sans test ; identifiant de dégradé fixe dans `iconTileSvg` ; `scripts/icons.ts` hors du `typecheck` du paquet design ;
  - garde-fou des rayons limité à `components/*.tsx`.

## Limites connues

- **Galerie :** les polices viennent de `fonts.css` chargé par le document, pas de `loadFonts` ; le chargement réel dans une page hôte reste à vérifier sur les sites. Elle ne couvre ni la section Debug du superuser, ni la popup.
- **Décalage du panneau et de l'infobulle calculé sur la fenêtre :** `useKeepInView` ne connaît que la largeur de la fenêtre, pas le conteneur qui défile ou rogne le plus proche (la modale d'une annonce Facebook, par exemple) : dans un tel conteneur, la couche peut encore être coupée. Il recalcule à chaque rendu de la pastille et au redimensionnement, pas quand la page hôte se réorganise seule.
- **Ligne d'état longue :** coupée à 60 caractères (`statusLine`, « … » compris), puis tronquée par la largeur de la pilule (340 px) ; pendant une attente, les points animés s'ajoutent juste après les points de suspension de la troncature, qui restent visibles malgré le reflet.
