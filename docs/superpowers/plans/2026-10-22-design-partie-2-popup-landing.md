# Passe design, partie 2 — Popup et landing : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** la popup de l'extension habillée dans le langage de `DESIGN.md` (sans nouvelle fonction), et le site : une landing créée de zéro (HTML statique FR/NL généré au build, maquette fidèle à 2ememain, dégradé qui suit le scroll, apparitions), avec `/pricing`, `/privacy` et `/auth/callback` réalignées.

**Architecture :**
- **Popup :** même logique (`App.tsx`), nouveau rendu sur les tokens, le thème Tailwind et les polices de `@radarnaque/design` (partie 1).
- **Site :** une petite représentation d'arbre (`h()`) avec deux sorties, HTML échappé (au build) et DOM (`textContent`, à l'exécution), pour partager la navigation et le pied de page entre la landing et les pages existantes. La landing est rendue au build par un plugin Vite ; un module sans dépendance remplit les formules, pilote le dégradé et les apparitions.

**Tech Stack :** WXT 0.21.4, React 19, Tailwind 4 (popup) ; Vite 8 et TypeScript sans framework (site) ; Vitest 5 (happy-dom) ; `@resvg/resvg-js` (images générées).

**Spec :**
- `docs/superpowers/specs/2026-10-22-design-popup-design.md` ;
- `docs/superpowers/specs/2026-10-22-design-landing-design.md` ;
- le [socle](../specs/2026-10-22-design-socle-design.md) (§2.5 : favicon et image Open Graph) ;
- `DESIGN.md`.

La partie 1 (`docs/superpowers/plans/2026-10-22-design-partie-1-socle-pastille.md`) est livrée : paquet `@radarnaque/design` (exports `./tokens.css`, `./theme.css`, `./motion.css`, `./fonts.css`, `./fonts/*`, `./fonts`, `./logo`, `./icons`), composants `Logo`, `Icon`, `PILL_CLASS`, `LEVEL_STYLE`, `SEVERITY_STYLE`, token `--glass-bg-host`, rayons `rounded-xs|sm|md|lg|pill`, garde-fou `apps/extension/test/design-tokens.test.ts`, galerie `pnpm --filter extension gallery`.

## Global Constraints

**Git et fichiers locaux :**
- Branche `feat/design-2`, au-dessus de `feat/design` (PR ouverte). Après la fusion de la partie 1 dans `main` (par rebase), la branche est rebasée sur `origin/main` avant d'être poussée. Pas de push sans demande.
- Chaque commit porte le trailer `Co-Authored-By` de la session du modèle qui l'écrit.
- Ne jamais toucher : `video/`, `.DS_Store`, `services/api/tests/.conftest.py.swp`, `docs/superpowers/plans/.Rhistory`. `infra/.env` n'est jamais affiché.
- `web-pages/` : seule la tâche 5 l'ouvre, et seulement pour **regarder** la capture de la fiche iPhone de 2ememain dans un navigateur (capture d'écran gardée hors du dépôt, sous `.playwright-mcp/` supprimé avant tout commit). Rien n'en est copié, cité ni commité : ni balisage, ni texte, ni image, ni nom, ni identifiant. Les données de session qu'elle contient ne sont jamais affichées.
- Aucune donnée réelle : annonces fictives, emails en `@radarnaque.test`.

**Langue :** code, commentaires, messages et docs en français. Textes de l'interface en FR et en NL, parité vérifiée ; le néerlandais est celui de Flandre (« je », 2dehands avant 2ememain).

**Valeurs fixées par le spec :**

| Élément | Valeur |
|---|---|
| Popup | 380 px de large ; hauteur selon le contenu, 600 px au plus ; seule la zone de contenu défile |
| En-tête de la popup | 60 px, `--gradient-compact`, logo blanc 22 px, « Radarnaque » en serif 22 px ; FR/NL en contrôle segmenté pilule (`aria-pressed`) ; filet `--gradient-hairline` de 1 px dessous |
| Champs | 36 px, `--bg-1`, bordure `--border-default`, `--focus-ring` au focus, étiquette au-dessus |
| Pilule blanche | 44 px pleine largeur (déconnecté, injoignable) ; `bg-white text-text-on-light`, ombre `--shadow-pill` |
| Code | 6 cases 44 × 52 px, chiffres en serif 28 px, case courante entourée de `--focus-ring` ; **un seul** `<input>` derrière (`inputMode="numeric"`, `autocomplete="one-time-code"`), cases `aria-hidden` |
| Quota | panneau `--bg-2` `--r-m`, étiquette `account.scansLabel`, badge de formule `--accent-soft`, nombre serif 48 px tabulaire |
| Bouton de suppression | plein `--danger`, 36 px, 40 % d'opacité tant que le mot n'est pas tapé |
| Nouvelles clés de la popup | tableau du spec popup §4 (FR et NL, valeurs exactes) |
| Landing | `/` (FR) et `/nl/` (NL) ; `<title>` ≤ 65 caractères ; `canonical`, `hreflang` `fr`, `nl`, `x-default` (FR) ; Open Graph et Twitter Card par langue |
| Lien d'installation | `VITE_CHROME_STORE_URL` ; vide : « Bientôt disponible » / « Binnenkort beschikbaar », pas de lien, `aria-disabled="true"` |
| Origine publique | `VITE_PUBLIC_URL` (repli `https://radarnaque.mostconsult.be`), pour `canonical`, `hreflang` et `og:url`/`og:image` absolus |
| Textes FR de la landing | ceux du spec landing §3, mot pour mot |
| Dégradé | 5 arrêts `--s1..--s5` sur un calque fixe ; palettes clés ci-dessous ; interpolation OKLab, lissage `smoothstep` entre deux clés |
| Palettes clés | p = 0 : `#0649b8`, `#4e8fe8`, `#c7b9ec`, `#ffd4ad`, `#e16c3f` ; p = 0,15 : `#020b2d`, `#031033`, `#06215f`, `#0b3a8c`, `#2a2f6e` ; p = 0,6 : `#020b2d`, `#020b2d`, `#031033`, `#08174a`, `#1e1a4a` ; p = 1 : `#020b2d`, `#031033`, `#08174a`, `#2a1838`, `#5a2a2a`. Une clé après 0 peut être assombrie si le test de contraste l'exige, jamais éclaircie |
| Contraste du dégradé | pour p ≥ 0,15, `--text-2` (`rgba(226, 232, 255, 0.74)` composé sur l'arrêt) ≥ 4,5:1 sur chaque arrêt |
| Apparitions | `data-reveal`, fondu + montée de 8 px, 320 ms, `cubic-bezier(0.2, 0.8, 0.2, 1)`, 60 ms d'écart (`--i`), `IntersectionObserver` seuil 0,15, une fois ; état caché seulement sous `html.js` ; instantané sous `prefers-reduced-motion` ; hero jamais caché |
| Maquette | fenêtre 980 px au plus, `--r-l`, ombre `--shadow-mockup`, flottement 6 s / 4 px coupé sous mouvement réduit ; sous 768 px : titre + pastille + panneau seuls, à plat |
| Images générées | `apps/site/public/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (180 px), `og-fr.png` et `og-nl.png` (1200 × 630) |

**Commandes :**
- extension : `pnpm --filter extension test && pnpm --filter extension typecheck && pnpm --filter extension build` ;
- site : `pnpm --filter site test && pnpm --filter site typecheck && pnpm --filter site build` ;
- design : `pnpm --filter @radarnaque/design test && pnpm --filter @radarnaque/design typecheck` ;
- racine : `rtk bypass npx biome check .` (le `pnpm lint` passé par rtk peut afficher un faux « out of memory »), puis `pnpm test:all` à la fin.

## Review Focus

1. **Le code collé** (« 123 456 », « 123-456 », 7 chiffres, lettres) et le remplissage automatique iOS/Chrome : la vérification part une seule fois avec les 6 chiffres, les cases reflètent le champ, l'étiquette reste celle du champ. Test en tâche 1.
2. **`GET /api/offer` lent, en panne ou invalide sur la landing** : le HTML garde les valeurs de secours lisibles, sans saut de mise en page ni texte « undefined » ; un plan à 0 photo affiche « Pas de photo analysée ». Test en tâche 6.
3. **La landing sans JavaScript** (aperçus de liens, robots, bloqueurs) : tout le texte et les formules de secours sont visibles, rien n'est caché par les apparitions, le dégradé reste celui du hero en haut et les sections suivantes sur `--bg-0`. Test en tâche 4 (HTML) et tâche 6 (classe `js`).
4. **Un écran étroit (320 à 390 px) et un zoom à 200 %** : ni la popup (380 px fixe) ni la landing ne défilent horizontalement ; la maquette passe en version à plat. Vérifié en tâche 7.
5. **Un texte d'interface qui contient `<`, `&` ou des guillemets** (traductions futures) : le rendu au build l'échappe, le rendu DOM le passe en `textContent`. Test en tâche 3.

---

### Tâche 1 : popup — cadre et écrans d'accès

**Fichiers :**
- Modifier :
  - `apps/extension/entrypoints/popup/style.css` (imports de `@radarnaque/design` : `tokens.css`, `theme.css`, `motion.css`, `fonts.css` ; `body` 380 px, fond `--bg-0`, police `--font-sans`) ;
  - `apps/extension/entrypoints/popup/App.tsx` (cadre, chargement, déconnecté, code envoyé, injoignable, zone de messages) ;
  - `apps/extension/lib/i18n.ts` (nouvelles clés du spec popup §4 sauf `account.*`, `action.pricing`) ;
  - `apps/extension/test/popup.test.tsx`.
- Créer : `apps/extension/entrypoints/popup/CodeInput.tsx`.

**Interfaces :**
- Consomme : `Logo` (`apps/extension/components/Logo.tsx`), utilités de `theme.css`.
- Fournit :
  - `CodeInput({ id, value, busy, onChange, inputRef }: { id: string; value: string; busy: boolean; onChange(event: ChangeEvent<HTMLInputElement>): void; inputRef: RefObject<HTMLInputElement | null> })` : le champ unique (mêmes attributs qu'aujourd'hui) posé au-dessus de 6 cases `aria-hidden` qui affichent `value[i]` ; la case courante (`value.length`, bornée à 5) porte la classe du focus quand le champ a le focus ;
  - `PopupHeader({ locale, onLocale })` et `PopupFooter({ links })` exportés depuis `App.tsx` (réutilisés en tâche 2) ;
  - classes `WHITE_PILL_CLASS`, `INPUT_CLASS`, `LINK_CLASS` exportées depuis `App.tsx`.

- [ ] **Étape 1 : écrire les tests qui échouent** (`popup.test.tsx`) :
  - `en-tête : logo, « Radarnaque », FR/NL en aria-pressed` ;
  - `chargement : squelette visible, « Chargement… » lisible par les lecteurs d'écran seulement` ;
  - `déconnecté : titre signin.title, phrase signin.lead, note signin.note, pilule « Recevoir mon lien de connexion », liens Confidentialité et Formules` ;
  - `code envoyé : titre code.title, un seul champ de saisie, six cases aria-hidden qui reflètent « 482 »` ;
  - `code collé « 123 456 » : une seule vérification avec « 123456 »` et `7 chiffres collés : les 6 premiers` (Review Focus 1) ;
  - `injoignable : titre app.unavailableTitle, phrase app.unavailableText, pilule « Réessayer »` ;
  - parité FR/NL des nouvelles clés ;
  - les parcours existants (envoi, renvoi, changement d'adresse, session expirée) restent verts.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : FAIL.
- [ ] **Étape 3 : implémenter.** La logique de `App.tsx` ne change pas (états, messages au service worker, gardes). Le collage passe déjà par `onChangeCode` (chiffres extraits, tronqués à 6) : le garder. Zone de messages : erreurs sur `bg-danger-soft`, confirmations sur `bg-success-soft`, région `aria-live` inchangée. Squelette : `bg-bg-3` avec le scintillement lent de `DESIGN.md` §3 (ajouter la classe `rq-skeleton` à `motion.css`, coupée sous mouvement réduit).
- [ ] **Étape 4 : vérifier.** Commandes de l'extension et biome. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(extension): popup, cadre et écrans d'accès (chargement, connexion, code, injoignable)`.

### Tâche 2 : popup — compte, suppression, formules

**Fichiers :**
- Modifier :
  - `apps/extension/entrypoints/popup/App.tsx` (écran connecté, suppression, barre d'actions) ;
  - `apps/extension/lib/i18n.ts` (`account.how`, `account.scansLabel`, `action.pricing`, `footer.pricing`) ;
  - `apps/extension/test/popup.test.tsx`, `apps/extension/test/design-tokens.test.ts` (le parcours inclut `entrypoints/popup/*`).
- Supprimer : `apps/extension/public/icon-with-shadow.svg`.

**Interfaces :**
- Consomme : `PopupHeader`, `PopupFooter`, `WHITE_PILL_CLASS`, `LINK_CLASS` (tâche 1) ; `PUBLIC_URL` (`lib/config.ts`).
- Fournit : rien de nouveau pour la suite.

- [ ] **Étape 1 : écrire les tests qui échouent :**
  - `connecté (essai, 3) : email, étiquette account.scansLabel, badge « Essai », nombre « 3 »` ;
  - `connecté illimité : badge plan.unlimited sans nombre` ; `sans abonnement : badge plan.none sans nombre` ;
  - `aide : account.how avec la pastille miniature (logo et « Analyser ») rendue en nœuds, pas en HTML` ;
  - `« Voir les formules » pointe vers {PUBLIC_URL}/pricing/?lang=fr (puis nl après bascule) et s'ouvre dans un nouvel onglet (target _blank, rel noopener noreferrer)` ;
  - `suppression dépliée : bouton plein danger, désactivé tant que le mot n'est pas tapé` ;
  - le garde-fou des tokens couvre `entrypoints/popup/*.tsx` et `style.css`, sans exception ;
  - `icon-with-shadow.svg` n'existe plus et n'est plus référencé.
  - Les parcours existants (déconnexion, suppression réussie ou en échec, session expirée pendant la suppression) restent verts.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : FAIL.
- [ ] **Étape 3 : implémenter.** `{badge}` de `account.how` remplacé par un nœud React (découpe de la chaîne sur `{badge}`). Barre d'actions fixe en bas (pilule blanche « Voir les formules » + lien « Se déconnecter »), seule la zone de contenu défile, hauteur max 600 px.
- [ ] **Étape 4 : vérifier.** Commandes de l'extension et biome. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(extension): popup, écran du compte, suppression et lien vers les formules`.

### Tâche 3 : site — socle, mise en page partagée et pages existantes

**Fichiers :**
- Créer :
  - `apps/site/src/h.ts` ;
  - `apps/site/src/layout.ts` (navigation, pied de page, textes partagés FR/NL) ;
  - `apps/site/test/h.test.ts`, `apps/site/test/layout.test.ts`.
- Modifier :
  - `apps/site/package.json` (dépendance `@radarnaque/design: workspace:*`) ;
  - `apps/site/src/pages.css` (réécrit sur les tokens) ;
  - `apps/site/src/pages-render.ts` (navigation et pied de page partagés, cartes de formules en panneaux) ;
  - `apps/site/auth/callback/index.html` (style en ligne retiré, CSS et logo) et `src/callback.ts` ;
  - `apps/site/pricing/index.html`, `apps/site/privacy/index.html` (favicon) ;
  - `packages/design/scripts/icons.ts` (favicon et icône Apple) ; `apps/site/public/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (générés).

**Interfaces :**
- Fournit :
  - `type VNode = string | { tag: string; attrs: Record<string, string | true>; children: VNode[] }` ; `h(tag, attrs?, ...children): VNode` ; `toHtml(node: VNode): string` (texte et attributs échappés : `&`, `<`, `>`, `"`, `'`) ; `toDom(doc: Document, node: VNode): Node` (texte en `textContent`, jamais `innerHTML` ; un sous-arbre `svg` est créé avec `createElementNS` dans l'espace de noms SVG). Aucune fonction n'insère de HTML brut ;
  - `logoNode(options?: { animated?: boolean; size?: number }): VNode` : le logo construit avec `h` depuis `LOGO` (`@radarnaque/design/logo`), même structure et mêmes classes que `logoSvg()` (test d'égalité de `toHtml(logoNode())` avec `logoSvg()` à l'ordre des attributs près) ;
  - `navNode(locale: Locale, page: "home" | "pricing" | "privacy"): VNode` : logo, « Radarnaque », liens « Comment ça marche » et « Formules » (ancres sur l'accueil, `/` + ancre ailleurs), « Confidentialité », lien de langue (pilule) vers la même page dans l'autre langue ;
  - `footerNode(locale: Locale): VNode` : phrase sur les données (spec landing §3.8), liens « Formules », « Confidentialité », « Code source » (`https://github.com/isayprod/radarnaque`), « Contact » (`mailto:` de `PRIVACY_EMAIL`) ;
  - `LAYOUT_TEXT: Record<Locale, {...}>`.
- `/pricing` et `/privacy` gardent leur logique ; leur rendu ajoute `navNode` et `footerNode` par `toDom`.

- [ ] **Étape 1 : écrire les tests qui échouent :**
  - `toHtml échappe < & " ' dans le texte et les attributs ; toDom passe le texte en textContent` (Review Focus 5) ;
  - `toHtml et toDom donnent le même arbre` (comparaison par `toDom(...).outerHTML` sur happy-dom) ;
  - `navNode("nl", "pricing") : lien de langue vers /pricing/?lang=fr, ancres vers /#comment et /#formules` ; `navNode("fr", "home") : ancres #comment et #formules, lien de langue vers /nl/` ;
  - `footerNode : quatre liens, mailto de PRIVACY_EMAIL, dépôt GitHub` ;
  - `/pricing` et `/privacy` rendues : navigation et pied de page présents, tests actuels verts ;
  - `/auth/callback` : plus de `<style>` en ligne, logo présent, messages inchangés.
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : FAIL.
- [ ] **Étape 3 : implémenter.** `pages.css` : fond `--bg-0`, textes `--text-2`, titres serif, largeur de lecture 45 à 70 caractères pour `/privacy`, cartes de `/pricing` en panneaux `--bg-2` (essai, Standard mis en avant, Premium) ; aucune valeur brute hors tokens. `/auth/callback` : panneau centré sur `--gradient-compact`, logo, message en serif ; logique inchangée. Favicon : `iconTileSvg` en SVG pour `favicon.svg`, PNG 32 et 180 par resvg ; `<link rel="icon">` et `apple-touch-icon` dans les trois pages.
- [ ] **Étape 4 : vérifier.** Commandes du site et du paquet design, biome. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(site): socle du site (arbre partagé, navigation, pied de page) et pages existantes réalignées`.

### Tâche 4 : landing — rendu au build, textes, en-tête HTML

**Fichiers :**
- Créer :
  - `apps/site/src/landing/i18n.ts` (dictionnaire FR/NL de la landing) ;
  - `apps/site/src/landing/render.ts` ;
  - `apps/site/src/landing/head.ts` ;
  - `apps/site/src/landing/plugin.ts` (plugin Vite) ;
  - `apps/site/src/landing/landing.css` ;
  - `apps/site/nl/index.html` ;
  - `apps/site/test/landing-render.test.ts`.
- Modifier :
  - `apps/site/index.html` (marqueurs `<!--landing:head-->` et `<!--landing:body-->`, `lang`) ;
  - `apps/site/vite.config.ts` (entrée `nl`, plugin) ;
  - `apps/site/src/env.d.ts` (`VITE_CHROME_STORE_URL?`, `VITE_PUBLIC_URL?`) ;
  - `infra/.env.example` (`VITE_CHROME_STORE_URL` et `VITE_PUBLIC_URL` pour le dev, `CHROME_STORE_URL` pour la production, commentés) ; `infra/caddy/Dockerfile` (`ARG`/`ENV` des deux) ; `infra/docker-compose.yml` (`args` : `VITE_CHROME_STORE_URL: ${CHROME_STORE_URL:-}`, `VITE_PUBLIC_URL: ${PUBLIC_URL}`) ;
  - `packages/design/scripts/icons.ts` (images Open Graph) ; `apps/site/public/og-fr.png`, `og-nl.png` (générées).

**Interfaces :**
- Consomme : `h`, `toHtml`, `navNode`, `footerNode` (tâche 3) ; `PLANS`, `PRICING` et les règles de lignes de `/pricing` (`featureLines` à exporter de `pages-render.ts` ou à déplacer dans un module partagé) ; `logoSvg`.
- Fournit :
  - `renderLanding(locale: Locale, options: { offer: Offer; storeUrl: string | null }): string` : le corps (navigation, hero, emplacement de la maquette `<div data-mockup>` rempli en tâche 5, bénéfices, « Comment ça marche » `id="comment"`, formules `id="formules"` avec `data-plan="trial|standard|premium"` sur chaque panneau et `data-field` sur chaque valeur, installation, pied de page), avec `data-reveal` et `style="--i:n"` sur les blocs du spec ;
  - `renderHead(locale: Locale, publicUrl: string): string` : `<title>`, description, canonical, hreflang (`fr` → `/`, `nl` → `/nl/`, `x-default` → `/`), Open Graph (`og:title`, `og:description`, `og:url`, `og:image` → `/og-<locale>.png`, `og:locale` `fr_BE`/`nl_BE`), Twitter Card `summary_large_image`, favicon ;
  - `landingPlugin(): Plugin` : remplace les deux marqueurs selon la langue de la page (`/` → FR, `/nl/` → NL), avec `PLANS` comme offre et `VITE_CHROME_STORE_URL` lu dans l'environnement du build ;
  - `LANDING_TEXT: Record<Locale, {...}>` : textes FR du spec landing §3 mot pour mot ; NL de même structure.
- `landing.css` : sections, typographie, pilules, panneaux ; il importe `tokens.css` et `fonts.css` ; pas encore de dégradé animé (tâche 6) : le hero porte `--gradient-hero`, le reste `--bg-0`.

- [ ] **Étape 1 : écrire les tests qui échouent** (`landing-render.test.ts`) :
  - `FR : textes du spec (titre du hero, accroche, ligne discrète, bouton, titres des sections, phrase du pied de page), aucun texte NL` ; `NL : textes NL, aucun texte FR` ;
  - `head : title ≤ 65 caractères par langue, canonical, trois hreflang absolus, og:image absolue par langue` ;
  - `formules de secours : prix et lignes de PLANS (ligne des icônes selon cardIcons), « Pas de photo analysée » pour 0 photo` ;
  - `installation : storeUrl → lien ; null → « Bientôt disponible », sans href, aria-disabled="true"` ;
  - `data-reveal présent sur les blocs, absent du hero` ;
  - `le build produit dist/index.html et dist/nl/index.html avec le texte dans le HTML` (test qui lance `vite build` dans un dossier temporaire ou vérifie le plugin sur les deux gabarits avec `transformIndexHtml`).
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : FAIL.
- [ ] **Étape 3 : implémenter.** Mise en page selon le spec landing §3 (navigation réduite au logo et à la langue sous 768 px, bénéfices en 2 × 2 et étapes en une colonne sur mobile, textes du hero dans la moitié haute : contraste ≥ 3:1 pour le titre, 4,5:1 pour l'accroche). Images Open Graph : la tuile du hero (dégradé), le logo, « Radarnaque » et l'accroche de la langue, rendus par resvg avec `font: { loadSystemFonts: true, defaultFontFamily: "Georgia" }` (resvg ne lit pas le WOFF2 ; ruling de la tâche). Lancer `pnpm --filter @radarnaque/design icons`.
- [ ] **Étape 4 : vérifier.** Commandes du site et biome ; `ls apps/site/dist apps/site/dist/nl` ; le HTML construit contient le titre du hero. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(site): landing rendue au build en FR et NL (textes, formules de secours, en-tête HTML, images Open Graph)`.

### Tâche 5 : landing — maquette du produit

**Fichiers :**
- Créer : `apps/site/src/landing/mockup.ts`, `apps/site/src/landing/mockup.css`, `apps/site/test/landing-mockup.test.ts`.
- Modifier : `apps/site/src/landing/render.ts` (insère la maquette), `landing.css` (chevauchement du hero).

**Interfaces :**
- Consomme : `h`, `logoSvg`, les styles de la pastille de la partie 1 (classes et tokens recopiés en CSS statique : pilule, panneau, badges de gravité, barre).
- Fournit : `mockupNode(locale: Locale): VNode` : fenêtre de navigateur (barre sombre, trois points, adresse `www.2ememain.be/v/telephonie-mobile/…`, icône de l'extension), page fidèle à une fiche 2ememain (barre du haut avec recherche et boutons, fil d'Ariane, galerie et vignettes, titre « iPhone 14 Pro 128 Go, comme neuf » / NL équivalent, prix, description fictive avec paiement par lien, bloc vendeur « membre depuis 3 jours »), la pastille « Risque élevé · 82/100 » après le titre et son panneau ouvert (score, verdict, barre, résumé, trois raisons) ; version mobile (titre + pastille + panneau).

- [ ] **Étape 1 : regarder la référence.** Ouvrir la capture locale de la fiche iPhone de 2ememain (`web-pages/`) dans le navigateur de Playwright, en capture d'écran seulement (sous `.playwright-mcp/`), pour relever la structure et les couleurs. Ne rien copier : la mise en page est refaite à la main.
- [ ] **Étape 2 : écrire les tests qui échouent :**
  - `maquette : adresse en texte, aucun <img> ni URL vers 2ememain.be hors du texte de l'adresse, aucune image distante` ;
  - `photo du produit : illustration SVG en ligne` ;
  - `pastille et panneau : « Risque élevé », « 82 », trois raisons avec leurs badges de gravité` ;
  - `NL : textes de la maquette en néerlandais` ;
  - `couleurs imitant le site tiers regroupées dans un seul bloc de variables commenté de mockup.css` (seule exception au garde-fou des tokens, test qui le vérifie).
- [ ] **Étape 3 : lancer les tests.** Résultat attendu : FAIL.
- [ ] **Étape 4 : implémenter.** Flottement 6 s / 4 px, coupé sous mouvement réduit. Sous 768 px, la fenêtre de navigateur disparaît (CSS), titre + pastille + panneau restent à plat.
- [ ] **Étape 5 : vérifier.** Commandes du site et biome ; supprimer `.playwright-mcp/`. Résultat attendu : PASS.
- [ ] **Étape 6 : commiter.** Message : `feat(site): maquette de la landing, fiche fidèle à 2ememain avec la pastille ouverte`.

### Tâche 6 : landing — formules en direct, dégradé au scroll, apparitions

**Fichiers :**
- Créer :
  - `apps/site/src/landing/gradient.ts` ;
  - `apps/site/src/landing/main.ts` ;
  - `apps/site/test/landing-gradient.test.ts`, `apps/site/test/landing-main.test.ts`.
- Modifier :
  - `apps/site/src/landing/render.ts` (calque `<div class="sky" aria-hidden="true">`, script de la page) ;
  - `apps/site/src/landing/landing.css` (calque fixe, fonds par défaut sans JS, apparitions) ;
  - `apps/site/src/offer.ts` (réutilisé tel quel si possible).

**Interfaces :**
- Consomme : `fetchOffer` (`offer.ts`), règles de lignes des formules (tâche 4), attributs `data-plan`/`data-field` et `data-reveal`.
- Fournit :
  - `PALETTE_KEYS: readonly { p: number; colors: readonly [string, string, string, string, string] }[]` (valeurs du tableau) ;
  - `paletteAt(p: number): [string, string, string, string, string]` (couleurs `rgb()` ou hex ; `p` borné à [0, 1]) ;
  - `contrastRatio(foreground: string, background: string): number` (avec composition de l'alpha du premier plan sur le fond) ;
  - `startSky(win: Window, layer: HTMLElement): () => void` : écouteur `scroll` passif, au plus une écriture par image (`requestAnimationFrame`), hauteur relue au `resize`, renvoie l'arrêt ;
  - `startReveal(doc: Document): () => void` ;
  - `fillOffer(doc: Document, locale: Locale, offer: Offer): void`.
- `main.ts` pose `html.js` en premier, lance les trois.

- [ ] **Étape 1 : écrire les tests qui échouent :**
  - `paletteAt(0)` égale la palette du hero ; `paletteAt(1)` la dernière ; `paletteAt(-1)` = `paletteAt(0)` ;
  - continuité : pour p de 0 à 1 par pas de 0,001, l'écart de chaque canal entre deux pas voisins reste sous 3 (sur 255) ;
  - contraste : pour p de 0,15 à 1 par pas de 0,01, `contrastRatio("rgba(226, 232, 255, 0.74)", arrêt) >= 4.5` pour chaque arrêt ;
  - `startSky` : une seule écriture des cinq variables par image même avec dix événements `scroll` ; arrêt propre (écouteurs retirés) ;
  - `startReveal` : `is-visible` ajouté une seule fois à l'entrée ; sans `html.js`, aucun élément caché (test sur le CSS : la règle cachée est sous `.js`) ; sous mouvement réduit, aucune transition (CSS) ;
  - `fillOffer` : valeurs de l'API écrites dans les `data-field` ; réponse invalide ou `null` → HTML inchangé (Review Focus 2) ; 0 photo → « Pas de photo analysée ».
- [ ] **Étape 2 : lancer les tests.** Résultat attendu : FAIL.
- [ ] **Étape 3 : implémenter.** Interpolation OKLab (conversions sRGB ↔ OKLab dans `gradient.ts`, sans dépendance), lissage `smoothstep` entre deux clés. Si le test de contraste échoue sur une clé après 0, l'assombrir (consigner la valeur retenue dans le rapport). Sans JS (`html:not(.js)`) : calque à la palette 0, sections après le hero sur `--bg-0`.
- [ ] **Étape 4 : vérifier.** Commandes du site et biome. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `feat(site): landing vivante (dégradé au scroll, apparitions, formules en direct)`.

### Tâche 7 : vérification visuelle et suivi

**Fichiers :**
- Créer : `docs/superpowers/plans/2026-10-22-design-partie-2-suivi.md`.
- Créer aussi : `apps/extension/dev/popup.html`, `apps/extension/dev/popup.tsx`, doublures sous `apps/extension/dev/doubles/`.
- Modifier : `apps/extension/vite.gallery.config.ts` (entrée et alias) ; selon les écarts trouvés (correctifs dans leur propre commit).

- [ ] **Étape 1 : captures.** Avec le navigateur de Playwright (captures sous `.playwright-mcp/`, copiées dans le dossier temporaire de la session puis supprimées du dépôt) :
  - landing construite (`pnpm --filter site build`, servie par `vite preview` sur un port libre hors 3000, 3100, 3101, 8000, 8080) à 1440, 1024, 768, 390 et 320 px, en FR et en NL, à plusieurs hauteurs de scroll pour le dégradé ; avec JavaScript désactivé ; à 200 % de zoom ;
  - `/pricing`, `/privacy` à 1440 et 390 px ;
  - popup : ajouter à la galerie de l'extension une page `dev/popup.html` qui rend `App` à 380 px, avec `resolve.alias` dans `vite.gallery.config.ts` vers des doublures de `lib/messages` (réponses de `sendToBackground` choisies par `?state=loading|signedOut|codeSent|signedIn|unlimited|unavailable`), de `lib/storage` et de `wxt/browser` ; captures de chaque écran (et de la suppression dépliée) en FR et en NL.
- [ ] **Étape 2 : contrôler** : écarts au tableau des valeurs, aucun défilement horizontal (`scrollWidth <= clientWidth`), focus visible au clavier, contraste ≥ 4,5:1 des textes (relevés dans le rapport), dégradé sans saut. Corriger avant de continuer.
- [ ] **Étape 3 : écrire le suivi** sur le modèle de `2026-10-22-design-partie-1-suivi.md` : livré ; décisions ; vérifications à faire par l'utilisateur (`CHROME_STORE_URL` à remplir à la publication, aperçu de lien Open Graph, Lighthouse, popup dans Chrome réel, mouvement réduit) ; limites connues.
- [ ] **Étape 4 : vérifier.** `rtk bypass npx biome check .`, puis `pnpm test:all`. Résultat attendu : PASS.
- [ ] **Étape 5 : commiter.** Message : `docs: suivi de la passe design, partie 2`.
