# Design — Landing et pages du site

*Spec du 22 octobre 2026*, partie de la passe design (voir le [socle](2026-10-22-design-socle-design.md)). Livrée dans la deuxième partie, avec la popup.

## 1. Objectifs

- Une page d'accueil qui fait comprendre Radarnaque en un écran, montre le produit en situation, explique la mécanique et le prix, et mène à l'installation.
- Une page lisible par les moteurs et les aperçus de liens : le texte est dans le HTML, pas construit en JavaScript.
- Une page vivante au scroll : le dégradé change de couleur du haut au bas de la page, et les éléments apparaissent en douceur.
- `/pricing`, `/privacy` et `/auth/callback` reprennent le même langage visuel, sans changement de logique.

## 2. Construction

- **Pages :** `index.html` (FR, `/`) et `nl/index.html` (NL, `/nl/`), deux nouvelles entrées du build Vite de `apps/site`. Caddy les sert déjà (`file_server` sur `/srv/site`).
- **Rendu au build :** une fonction pure `renderLanding(locale, offer)` (`src/landing/render.ts`) produit le HTML du corps à partir du dictionnaire `src/landing/i18n.ts`. Un petit plugin Vite (`transformIndexHtml`) remplace un marqueur des deux fichiers par ce rendu, avec l'offre de secours (`PLANS` de `pages-i18n.ts`). Tout texte est échappé.
- **Script de la page** (`src/landing/main.ts`, module, sans dépendance) :
  - remplit les formules depuis `GET /api/offer` (même analyse que `offer.ts`, réutilisée) et garde les valeurs du HTML si la route ne répond pas ;
  - pilote le dégradé au scroll (§5.1) et les apparitions (§5.2).
- **En-tête HTML :**
  - `<title>` de 65 caractères au plus et meta description, par langue ;
  - `link rel="canonical"`, et `hreflang` `fr`, `nl` et `x-default` (FR) ;
  - Open Graph et Twitter Card avec l'image du socle (§2.5), par langue ;
  - favicon du socle.
- **Lien d'installation :** variable `VITE_CHROME_STORE_URL`, lue au build (`infra/.env` en dev, `ARG` du Dockerfile de Caddy en production). Vide : la pilule affiche « Bientôt disponible », n'est pas un lien et porte `aria-disabled="true"`.
- **Pas de redirection automatique selon la langue du navigateur :** FR sur `/`, NL sur `/nl/`, le lien de langue dans la navigation.

## 3. Structure

Validée sur maquette. Textes FR ci-dessous ; NL dans le dictionnaire, même structure.

1. **Navigation** (absolue, sur le dégradé) : logo et « Radarnaque » en Instrument Serif 20 px à gauche ; à droite « Comment ça marche » (ancre), « Formules » (ancre), « Confidentialité » (`/privacy/?lang=`) et le lien de langue (« NL » ou « FR », pilule à bordure). Texte blanc à 78 %. Sous 768 px, seuls le logo et le lien de langue restent.
2. **Hero :** « Repérez l'arnaque avant de payer. » en `display-xl` ; accroche en `text-l` blanc (« Radarnaque lit l'annonce et ses photos sur 2ememain, 2dehands et Facebook Marketplace, et vous dit en quelques secondes si quelque chose cloche. ») ; ligne discrète (« Extension pour Chrome · essai gratuit, sans carte bancaire ») ; pilule blanche avec le logo, « Ajouter à Chrome, c'est gratuit ». Les textes du hero restent dans la moitié haute, sur le cobalt et le bleu ciel : contraste d'au moins 3:1 pour le titre, 4,5:1 pour l'accroche et la ligne discrète. Si le bleu ciel ne le permet pas, l'arrêt cobalt du dégradé descend plus bas, sans changer les couleurs.
3. **Maquette du produit** (§4), à cheval sur le bas du hero.
4. **Bénéfices :** une ligne centrée de quatre éléments séparés par des points de 4 px : « Analyse du texte et des photos », « Comparaison avec le prix du marché », « Verdict en quelques secondes », « En français et en néerlandais ». En 2 × 2 sur mobile.
5. **Comment ça marche** (`id="comment"`) : étiquette, titre `display-l` (« Trois gestes, avant d'envoyer le moindre euro. »), trois colonnes séparées par un filet haut, chacune avec un chiffre Instrument Serif 44 px, un titre et une phrase. L'étape 2 montre la pilule « Analyser », l'étape 3 la pilule « Risque faible · 12/100 ». En une colonne sur mobile.
6. **Formules** (`id="formules"`) : étiquette, titre (« Commencez gratuitement. »), une phrase, trois panneaux (`--bg-2`, opaques) Essai, Standard (mis en avant : bordure `--accent` à 45 % et léger voile bleu), Premium. Chaque panneau : nom, badge « Gratuit » pour l'essai, prix en Instrument Serif 48 px (« / mois » en `--text-3`), accroche, lignes du plan (mêmes règles que `/pricing` : quota, photos, icônes sur les résultats si `cardIcons`). Sous les panneaux : « Paiement bientôt disponible. » et un lien « Détail des formules » vers `/pricing/`. Cette phrase disparaîtra avec Stripe.
7. **Installation :** fond `--bg-0` opaque, titre `display-l` (« Le bon réflexe avant chaque achat d'occasion. »), la même pilule, puis une ligne `text-s` : navigateurs pris en charge (Chrome, Edge, Brave et autres navigateurs Chromium), « Politique de confidentialité », « Code source » (dépôt GitHub public).
8. **Pied de page :** à gauche, ce que l'extension lit et garde (« Radarnaque ne lit que la page de l'annonce que vous analysez, au moment où vous cliquez. Les analyses sont conservées 12 mois puis effacées ; vous pouvez supprimer votre compte à tout moment depuis l'extension. ») ; à droite, « Formules », « Confidentialité », « Code source », « Contact » (`mailto:` de l'adresse de confidentialité existante). `text-xs`, `--text-3`.

## 4. Maquette du produit

- **Fenêtre de navigateur** large (980 px au plus), `--r-l`, barre sombre avec trois points, champ d'adresse (« www.2ememain.be/v/telephonie-mobile/… ») et, à droite, l'icône de l'extension. Ombre de la maquette (`DESIGN.md` §2.5) ; flottement lent (6 s, 4 px), coupé sous `prefers-reduced-motion`.
- **Page fidèle à une fiche 2ememain :** la mise en page réelle d'une fiche (barre du haut avec recherche et boutons, fil d'Ariane, galerie avec vignettes, titre, prix, bloc de description, bloc vendeur, couleurs et typographie du site) est refaite à la main en HTML et CSS, d'après la capture locale d'une fiche iPhone dans `web-pages/`.
  - **Contenu fictif** : un iPhone 14 Pro, un prix, un vendeur inscrit depuis 3 jours, une description qui demande un paiement par lien.
  - **Pas de logo officiel, ni image ou fichier repris du site :** le nom « 2ememain » n'apparaît qu'en texte (adresse, fil d'Ariane). La photo du produit est une illustration SVG dessinée.
  - **Les captures de `web-pages/`** servent seulement de référence visuelle. Elles ne sont jamais copiées, citées ni commitées : elles contiennent des données de session.
  - Les couleurs de la maquette imitent un site tiers : ce sont les seules valeurs brutes permises hors de `tokens.css`, regroupées dans un bloc de variables commenté.
- **Produit en situation :** la pastille « Risque élevé · 82/100 » après le titre, et son panneau ouvert (spec Pastille §3) : score, verdict, barre, résumé, trois raisons. Ce sont les vrais styles de la pastille (tokens et `motion.css` communs), recopiés en HTML statique.
- **Mobile (sous 768 px) :** la maquette se réduit au titre de l'annonce, à la pastille et au panneau ouvert, à plat, sans fenêtre de navigateur.

## 5. Animations au scroll

### 5.1 Dégradé qui suit le scroll

- **Principe :** un calque fixe (`position: fixed; inset: 0; z-index: -1`) porte un dégradé vertical à cinq arrêts (`--s1` à `--s5`). Les couleurs changent avec la progression du scroll, de 0 (haut de la page) à 1 (bas), en douceur et sans saut.
- **Récit des couleurs :**
  - **0 (hero)** : le dégradé du hero, cobalt, bleu ciel, lilas, pêche et orange (`--gradient-hero`) ;
  - **vers 0,25** : le jour tombe, du navy en haut, le cobalt et le bleu ciel descendent vers le bas ;
  - **vers 0,6** : la nuit, navy profond, avec un reste de lilas tout en bas ;
  - **1 (pied de page)** : une lueur d'horizon orange sourde qui remonte du bas, sous le navy.
- **Calcul :** `src/landing/gradient.ts` exporte une fonction pure `paletteAt(p)` qui interpole les cinq couleurs entre ces palettes clés, dans l'espace OKLab, avec un lissage `smoothstep` entre deux clés. Le script lit `scrollY` sur un écouteur passif, une fois par image au plus (`requestAnimationFrame`), et écrit les cinq variables sur le calque. La hauteur de la page est relue au redimensionnement, pas à chaque image.
- **Contraste :** à partir de la fin du hero (p ≥ 0,15), chaque couleur de la palette laisse au `--text-2` un contraste d'au moins 4,5:1. Les palettes clés sont choisies pour ça, et un test le vérifie sur une grille de valeurs de `p`. Les formules restent sur des panneaux opaques.
- **Sans JavaScript :** le calque garde la palette 0 en haut de page et les sections suivantes ont un fond `--bg-0` (classe `js` absente).
- **`prefers-reduced-motion` :** le dégradé suit toujours le scroll : il ne bouge que quand l'utilisateur fait défiler, rien n'avance tout seul.

### 5.2 Apparition des éléments

- Les blocs marqués `data-reveal` (titres, colonnes, panneaux, bénéfices, pilules) apparaissent en entrant dans la fenêtre : fondu et montée de 8 px, 320 ms, courbe d'entrée de `DESIGN.md` §2.6. Les éléments voisins se suivent avec 60 ms d'écart (`--i`).
- Un `IntersectionObserver` (seuil 0,15) ajoute `is-visible` une seule fois par élément.
- **Sans JavaScript :** tout est visible ; l'état caché ne s'applique que sous la classe `js` posée sur `<html>`.
- **`prefers-reduced-motion` :** apparition instantanée, sans montée.
- Le hero est visible dès le chargement (aucune apparition au-dessus de la ligne de flottaison).

## 6. Pages existantes

- **`/pricing` et `/privacy` :** même logique (rendu JS, `?lang=`, lecture de l'offre). Elles reçoivent `tokens.css`, `fonts.css`, la navigation et le pied de page de la landing (rendus par les mêmes fonctions), fond `--bg-0`, titres Instrument Serif. Les cartes de `/pricing` prennent le style des panneaux du §3.6. `/privacy` garde une largeur de lecture de 45 à 70 caractères.
- **`/auth/callback` :** tokens, polices et logo ; panneau centré sur `--gradient-compact`. Logique inchangée.
- **`pages.css`** est réécrit sur les tokens ; plus de couleurs brutes.

## 7. Tests

- **Rendu :** `renderLanding("fr")` et `renderLanding("nl")` contiennent les textes de leur langue, les ancres, `hreflang`, canonical, Open Graph et un `<title>` de 65 caractères au plus. Aucun texte de l'autre langue.
- **Formules :** valeurs de secours dans le HTML ; remplacées par celles de `GET /api/offer` ; gardées si la route échoue ou renvoie une réponse invalide ; ligne des icônes selon `cardIcons`.
- **Installation :** lien vers le Chrome Web Store si `VITE_CHROME_STORE_URL` est rempli ; sinon « Bientôt disponible », sans lien, avec `aria-disabled`.
- **Dégradé :** `paletteAt(0)` égale le dégradé du hero ; `paletteAt` est continue (écart borné entre deux `p` voisins) ; contraste d'au moins 4,5:1 avec `--text-2` pour p ≥ 0,15.
- **Apparitions :** `is-visible` ajouté une fois à l'entrée ; tout visible sans la classe `js`.
- **`/pricing`, `/privacy`, `/auth/callback` :** tests actuels verts.
- **Vérification visuelle :** landing à 1440, 1024, 768 et 390 px, en FR et en NL ; scroll complet filmé ou capturé à plusieurs hauteurs pour le dégradé ; aucun défilement horizontal ; focus visible ; contraste vérifié sur le dégradé ; `/pricing` et `/privacy` à 1440 et 390 px.
