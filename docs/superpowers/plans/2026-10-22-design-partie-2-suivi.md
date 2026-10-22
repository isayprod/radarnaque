# Passe design, partie 2 — Points de suivi

Remarques relevées pendant la partie 2 de la passe design : popup de l'extension, landing du site (`/` et `/nl/`) et pages existantes (`/pricing`, `/privacy`, `/auth/callback`). Elles sont triées par échéance ; les points déjà corrigés n'y figurent que s'ils changent la façon de relire ou de faire évoluer le code. La spécification est dans la [popup](../specs/2026-10-22-design-popup-design.md) et la [landing](../specs/2026-10-22-design-landing-design.md), avec le [socle](../specs/2026-10-22-design-socle-design.md) et [`DESIGN.md`](../../../DESIGN.md) pour la référence visuelle. Le plan est dans [`2026-10-22-design-partie-2-popup-landing.md`](2026-10-22-design-partie-2-popup-landing.md) ; la partie 1 a son propre [suivi](2026-10-22-design-partie-1-suivi.md).

## Ce qui est livré

- **Popup** (380 px, 600 px de haut au plus, seule la zone de contenu défile) : en-tête en `--gradient-compact` avec le logo, « Radarnaque » en serif et le choix FR/NL en contrôle segmenté ; écrans de chargement (squelette), déconnecté, code envoyé (six cases devant un seul champ), compte (panneau du quota, badge de formule, aide avec la pastille en miniature, suppression repliée), injoignable ; barre d'actions « Voir les formules » / « Se déconnecter » ; nouveaux textes du spec en FR et en NL. La logique de `App.tsx` n'a pas changé.
- **Garde-fou des tokens** étendu à `entrypoints/popup` (extension), et créé pour le site (`apps/site/test/design-tokens.test.ts`) avec deux exceptions nommées : le bloc commenté de `mockup.css` et `PALETTE_KEYS` de `gradient.ts`.
- **Landing rendue au build** en FR (`/`) et en NL (`/nl/`) : textes, formules de secours dans le HTML, `<title>`, `canonical`, `hreflang`, Open Graph et Twitter Card par langue, favicon et images Open Graph (`og-fr.png`, `og-nl.png`, générées par `pnpm --filter site og`).
- **Maquette du produit** : une fiche d'annonce imitée, la pastille et le panneau de Radarnaque recopiés en statique, à plat sous 768 px.
- **Landing vivante** : dégradé fixe qui suit le scroll (palettes clés interpolées en OKLab), apparitions au scroll, formules relues dans `GET /api/offer` (valeurs de secours gardées si la route échoue).
- **Pages existantes** réalignées : navigation et pied de page partagés, `pages.css` sur les tokens, cartes de `/pricing` en panneaux, `/auth/callback` sur le dégradé compact.
- **Galerie de la popup** : `pnpm --filter extension gallery`, puis `http://localhost:3101/popup.html?state=…&lang=…`. `state` vaut `loading`, `signedOut`, `codeSent`, `signedIn`, `unlimited` ou `unavailable` ; `lang` vaut `fr` ou `nl` ; `delete=open` déplie la suppression, `delete=typed` tape aussi le mot de confirmation. Le vrai `App` est rendu ; `vite.gallery.config.ts` remplace `lib/messages`, `lib/storage` et `wxt/browser` par les doublures de `dev/doubles/` (aucun réseau). La galerie reste hors du build de l'extension.

## Décisions prises pendant l'exécution

À garder en tête en relisant ou en faisant évoluer la popup et le site.

- **Gris lisibles (règle 3) :** tout texte que l'utilisateur lit est en `--text-2` ; `--text-3` ne sert qu'aux textes d'exemple des champs et aux éléments décoratifs. Le spec demandait `--text-3` à quelques endroits, mais `--text-3` n'atteint que 4,09:1 sur `--bg-0` : l'exigence de 4,5:1 l'emporte.
- **Registre néerlandais (règle 6) :** les nouveaux textes (popup, landing, navigation, pied de page) sont au « je ». Les textes existants de `/pricing`, `/privacy` et `/auth/callback` restent au « u » : la page de confidentialité (« Hier leest u… ») et la phrase d'accroche de `/pricing` (« die bij u past ») mêlent donc deux registres avec la navigation. Relecture éditoriale à prévoir.
- **Nom du site tiers dans la description de la maquette (règle 7) :** « sur 2ememain » / « op 2dehands » figure dans l'`aria-label` de l'illustration, en texte seul, sans logo ni affiliation suggérée.
- **Écran injoignable :** le message d'erreur reste annoncé par la région `aria-live`, mais n'est pas affiché une seconde fois sous le titre et la phrase.
- **Champ du code :** le curseur est ramené en fin de saisie (clic, flèches, Début), sauf si la sélection couvre tout le code : « tout sélectionner » puis taper, coller ou effacer remplace le code (vérifié dans Chromium : clic sur la première case, deux flèches à gauche et Début laissent le curseur à la fin ; Ctrl+A puis « 7 » donne « 7 »).
- **Polices de la popup :** la popup déclare ses quatre `@font-face` dans `style.css` avec les chemins absolus `/fonts/…`, ceux que le build copie pour le content script ; elle n'importe plus `fonts.css`, que Vite copiait une seconde fois dans `assets/` (166 Ko de moins). Vite l'écrit au build (« didn't resolve at build time, it will remain unchanged ») : c'est attendu. La galerie sert le même `/fonts/` (son `publicDir` est `packages/design/src`). Un test vérifie que les déclarations suivent `FONT_FACES`.
- **Contraste forcé (Windows) :** la case courante du code reçoit un contour plein (l'anneau de focus est une ombre, effacée dans ce mode, et le champ est invisible) ; la langue choisie est soulignée (son fond blanc disparaît). Les autres focus utilisent `outline-hidden` de Tailwind 4, qui redevient un contour dans ce mode.
- **Maquette :**
  - le panneau couvre le prix et le bloc vendeur sur le bureau, comme le ferait le vrai panneau ; prix et vendeur restent dans le HTML ;
  - entre 768 et 1023 px, le panneau ne couvre plus que la colonne de droite (284 px) : à 340 px, il cachait la fin de la description, celle qui cite le lien de paiement ;
  - la maquette est dans un `<aside>` : tout le contenu de la landing est dans un repère (en-tête, maquette, `main`, pied de page) ; l'illustration garde son `role="img"` et sa description ;
  - couleurs, rayons (`--mk-r-s|m|l`) et police (`--mk-font`) de la fiche imitée sont dans le seul bloc commenté de `mockup.css`.
- **Dégradé au scroll (règles 8 à 10) :** palettes plus saturées que celles du plan (clé violette à 0,35 ; `--s4` de la clé 0,15 en indigo `#3d369c`), contraste de `--text-2` d'au moins 5,05:1 pour p ≥ 0,15 ; rampe d'au moins ~200 px de scroll sur toutes les fenêtres, remplissage `--sky-below` sous le hero.
- **Image Open Graph :** le cobalt plein descend à 74 % de la hauteur et le texte remonte de 12 px : l'accroche n'est plus à cheval sur le passage au bleu ciel (test dans `apps/site/test/og.test.ts`).
- **`/privacy` :** colonne de `31rem` au lieu de `65ch` (la largeur de 65 « 0 » laissait passer jusqu'à 90 caractères par ligne) : 55 à 68 caractères par ligne mesurés à 1440 px en FR, 48 à 67 en NL.
- **Vérification visuelle (galerie de la popup et `vite preview` du site) :**
  - popup : chaque écran à 380 px en FR et en NL, sans défilement horizontal ; valeurs du spec relevées (en-tête 60 px, filet 1 px, champs 36 px, pilule 44 px, cases 44 × 52 px en serif 28 px, un seul champ, panneau du quota `--bg-2` rayon 14 px, nombre serif 48 px, badge 22 px, bouton de suppression 36 px à 40 % d'opacité) ; focus visible au clavier sur chaque arrêt ; à 200 % de zoom, aucun défilement horizontal ; le badge le plus long (« Superuser (dev) — Premium ») tient avec l'étiquette ;
  - landing : 1440, 1024, 900, 834, 768, 390 et 320 px en FR et en NL, sept hauteurs de scroll à 1440 et 390 px, sans JavaScript, à 200 % de zoom (1440 et 1280 px) : aucun défilement horizontal, focus visible, contraste d'au moins 4,5:1 sur tous les textes hors de la fiche imitée (5,44:1 au plus bas, la navigation sur le hero) ;
  - `/pricing` et `/privacy` à 1440 et 390 px en FR et en NL : contraste minimal 7,05:1.

## À vérifier en conditions réelles

Rien de ceci n'a été essayé hors des tests, de la galerie et de `vite preview`.

- **`VITE_CHROME_STORE_URL` à remplir à la publication** sur le Chrome Web Store (variable du build du site, `ARG` du Dockerfile de Caddy en production). Vide, la landing affiche « Bientôt disponible » / « Binnenkort beschikbaar » sans lien. Vérifier ensuite que les deux pilules d'installation de `/` et de `/nl/` mènent à la fiche du store.
- **Aperçu de lien Open Graph** : coller `https://radarnaque.mostconsult.be/` et `/nl/` dans un outil d'aperçu (débogueur de partage de Facebook, aperçu de LinkedIn, un message Slack ou WhatsApp) : image de la bonne langue, titre et description. `VITE_PUBLIC_URL` doit être l'origine publique, sinon `og:image` est absolue vers une mauvaise adresse.
- **Lighthouse** sur `/` et `/nl/` (mobile et bureau) : performances (polices, dégradé fixe), accessibilité, SEO (`hreflang`, `canonical`).
- **Popup dans Chrome réel** (extension construite et chargée) :
  - les polices se chargent depuis `/fonts/` (onglet Réseau de la popup inspectée) ;
  - chaque écran, la connexion par code (taper, coller « 123 456 », remplissage automatique sur Android ou iOS si l'extension y est un jour), la suppression dépliée qui fait défiler la seule zone de contenu ;
  - avec le zoom de Chrome à 200 % : la popup reste sous 800 × 600 px et défile verticalement ;
  - `pnpm dev:ext` (WXT en dev) : la copie des polices passe par le hook `build:publicAssets`, à vérifier aussi en dev.
- **Mouvement réduit** activé dans le système : squelette immobile (forme seule), maquette qui ne flotte pas, apparitions instantanées, dégradé qui suit toujours le scroll (ce n'est pas une animation).
- **Contraste forcé** (Windows, thème à contraste élevé) : la case courante du code et la langue choisie restent repérables.

## Ce qui reste à faire

- **Relecture éditoriale du néerlandais** : `/pricing`, `/privacy` et `/auth/callback` au « je » (règle 6). Au passage :
  - le titre de la landing NL écrit « voor je betaalt » et celui de la popup « vóór je betaalt » ;
  - la formule s'appelle « Standaard » dans la popup et « Standard » sur `/pricing` et la landing NL.
- **Prix des cartes de `/pricing` en 32 px** (48 px dans les panneaux de la landing) : la chaîne affichée contient la période (« 2,99 € par mois »), qui passerait à la ligne à 48 px dans trois colonnes. Aligner demande de séparer le montant et la période, comme sur la landing (`<small>`) ; laissé de côté.
- **CSP du site :** les apparitions posent leur décalage en ligne (`style="--i:n"`). Une CSP `default-src 'self'` (sans `style-src 'unsafe-inline'`) étendue à `/` bloquerait ces attributs : seul l'écart de 60 ms entre les apparitions serait perdu, rien ne resterait caché. Le script en ligne qui pose `html.js` serait bloqué lui aussi (il faudrait un hash). À reprendre si une CSP est ajoutée à la landing.
- **`pnpm dev:site`** (`vite build --watch`) ne relit pas les modules chargés avec la configuration Vite : `src/landing/plugin.ts` et ce qu'il importe (`i18n.ts`, `render.ts`, `head.ts`, `mockup.ts`, `src/pages-i18n.ts`). Après une modification de l'un d'eux, relancer `pnpm dev:site` (noté dans `apps/site/vite.config.ts`).
- **Points mineurs reportés pendant la partie 2**, à reprendre à la relecture finale :
  - `toHtml` fait confiance à un `VNode` construit à la main (noms d'éléments et d'attributs vérifiés seulement dans `h()`) ;
  - le garde-fou des tokens du site ne voit ni les tailles de police passées par des variables CSS, ni les couleurs nommées, `hsl()` ou `oklch()` ;
  - marge négative de `.tagline` sur `/pricing` ;
  - `fillOffer` remplace les enfants de chaque panneau au lieu d'écrire dans ses `data-field` (sûr, mais plus large que nécessaire) ; `measure()` lancé deux fois au démarrage ;
  - la simulation des arrêts du dégradé ne couvre pas le texte du hero pendant la rampe (mesuré au navigateur seulement) ; la rampe fait moins de 200 px si la hauteur défilable est sous 480 px ;
  - `js-ready` posé même si le calque `.sky` manque (impossible en production) ;
  - styles d'import `.ts` mêlés dans le site (avec et sans extension).

## Limites connues

- **Logotype de l'en-tête de la popup :** « Radarnaque » en blanc sur `--gradient-compact` descend à 3,92:1 là où le dégradé passe au bleu ciel. Le WCAG ne fixe aucun contraste pour un logotype ; les textes de l'en-tête qui portent une information (FR et NL) atteignent 6,78:1 au moins.
- **Anneau de focus sur le hero :** l'anneau (`--bg-0` puis `--accent`) n'a que 2,4:1 entre son bord navy et le cobalt, mais 5,8:1 entre ses deux bandes : il reste net, sans atteindre le critère AAA « Apparence du focus ».
- **Zoom à 200 % sur un téléphone de 390 px** (195 px CSS) : la navigation et les pilules dépassent. Le WCAG demande une mise en page sans défilement horizontal jusqu'à 320 px CSS (1280 px à 400 %), ce qui est vérifié ; en dessous, rien n'est garanti.
- **Galerie de la popup :** les doublures répondent sans délai réseau réaliste, et `auth/verify-otp` refuse toujours le code (l'écran du code montre son message d'erreur) ; `account/delete` échoue toujours (message « serveur injoignable »). Le parcours complet reste celui de `popup.test.tsx`.
- **Galerie et extension :** l'alias de `wxt/browser` vaut pour toute la galerie, pastille comprise ; la doublure n'expose que `i18n.getUILanguage`, `runtime.connect` (qui lève une erreur) et `runtime.getURL`, ce que les pages de la galerie utilisent.
