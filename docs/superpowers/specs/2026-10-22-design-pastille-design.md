# Design — Pastille et icône des cartes

*Spec du 22 octobre 2026*, partie de la passe design (voir le [socle](2026-10-22-design-socle-design.md)). Livrée dans la première partie, avec le socle.

Le travail se fait en deux temps, dans cet ordre : d'abord le **comportement** (§1), puis le **design** (§2 à §5).

## 1. Nouveau comportement : seule l'IA donne un résultat

### 1.1 Constat

Aujourd'hui, la pastille de la fiche (`RiskBadge`) affiche d'office le niveau et le score de l'analyse locale (règles), et un bouton séparé « Analyser avec l'IA » (`BadgeActions`). Un résultat IA remplace ensuite l'analyse locale. Le panneau liste les signaux locaux et finit par un pied de page sur l'analyse locale.

L'icône des cartes (`CardBadge`) fonctionne déjà sans résultat local : « R » au repos, puis clic pour analyser.

### 1.2 Changement

- **Une seule pilule.** Au repos, la pastille affiche « Analyser » (`ai.launchShort`) avec le logo, et son nom accessible est « Analyser avec l'IA » (`ai.launch`). Le bouton séparé disparaît.
- **Clic au repos ou après une erreur :** même logique qu'aujourd'hui (`useLaunch`) :
  - analyse lancée si le compte en a encore ;
  - connexion si le compte est déconnecté ;
  - panneau ouvert, qui dit pourquoi, si l'accès est en erreur ou sans abonnement, ou si la connexion ne peut pas s'ouvrir.
- **Sans abonnement (accès connu) :** la pilule est un lien vers les formules, comme le bouton actuel.
- **Plus d'analyse restante (accès connu) :** la pilule reste focusable, `aria-disabled`, avec la raison (`ai.noScansLeft`) en description et en `title`, comme le bouton actuel.
- **Pendant l'analyse :** logo animé et ligne d'état en direct. Le clic ouvre ou ferme le panneau, qui montre le déroulé.
- **Résultat IA :** niveau et score de l'IA. Le clic ouvre ou ferme le panneau.
- **Erreur :** message court et, pour une analyse coupée en route (`RELAUNCH_CODES`), « Relancer ». Sinon le clic relance comme au repos.
- **Les règles locales restent calculées** (`evaluate`) et partent avec la demande comme contexte pour l'IA (`signals`, `rulesVersion` dans `use-ai-scan.ts` et `card-scan.ts`). Elles ne sont plus affichées nulle part.
- **Panneau :** plus de liste des signaux locaux (`LocalSignals`) ni de pied de page `panel.footer`. Son titre est toujours `panel.title` (« Analyse Radarnaque »).
- **Textes :** les clés devenues inutiles sont retirées des deux langues (`panel.none`, `panel.footer`, `panel.titleAi`, `ai.badgeTag`, et toute autre clé sans usage après le changement). Le test de parité FR/NL reste vert.
- **Résultat repris du magasin (24 h) :** inchangé. Une fiche déjà analysée affiche directement son résultat IA.

### 1.3 Tests du comportement

- Au repos, aucune trace du niveau ni du score locaux : ni texte, ni couleur, ni nom accessible.
- Une seule pilule : plus de bouton « Analyser avec l'IA » séparé.
- Les cas de `useLaunch` restent couverts : quota, déconnecté, sans abonnement (lien), quota épuisé (`aria-disabled` et raison), accès en erreur.
- La demande d'analyse contient toujours les signaux locaux et `rulesVersion`.
- Le panneau ne liste plus de signaux locaux et n'a plus de pied de page local.
- Les tests de `risk-badge.test.tsx`, `controller.test.ts` et `content-i18n.test.ts` sont adaptés.

## 2. Pilule de la fiche

Validée sur maquette.

- **Forme :** hauteur 28 px, `--r-pill`, verre sombre (`--glass-bg-strong` ; flou `backdrop-filter` si disponible), bordure 1 px blanche à 12 %, ombre de la pilule primaire (`DESIGN.md` §2.5). Texte Inter 13 px, poids 500, blanc.
- **Au repos :** logo (16 px) et « Analyser ».
- **Analyse en cours :** logo animé (socle §2.4) et ligne d'état avec le reflet. La ligne est celle d'aujourd'hui (`statusLine`), y compris les points de suspension après 4 s sans événement. Les annonces au lecteur d'écran restent limitées à une toutes les 2 s.
- **Résultat :** point de couleur sémantique (8 px), niveau en toutes lettres (« Risque élevé »), séparateur vertical, score `82/100` en `--text-3` et chiffres tabulaires. La couleur n'est jamais seule : le niveau est toujours écrit.
- **Erreur :** logo à 60 % d'opacité, message court en `--text-2`, séparateur, « Relancer » souligné.
- **Focus :** `--focus-ring` visible au clavier.
- **Position :** inchangée, en ligne après le titre de l'annonce. Elle ne doit pas casser la mise en page de l'hôte.

## 3. Panneau

Validé sur maquette.

- **Carte :** 340 px de large (au plus 90 % de la largeur de la fenêtre), verre sombre (`--glass-bg-strong`), bordure `--border-default`, `--r-m`, ombre des couches flottantes. Filet `--gradient-hairline` de 2 px en haut. `z-index` 2 147 483 000.
- **En-tête :** logo 14 px et « Analyse Radarnaque » en style `label` (majuscules, 11 px), bouton de fermeture (icône Lucide, nom accessible) à droite.
- **Score :** nombre en Instrument Serif 44 px, « /100 » en `--text-3`, badge de verdict (fond sémantique doux, texte sémantique, point et niveau) aligné à droite, puis une barre de 4 px remplie à hauteur du score dans la couleur du niveau.
- **Contenu :** résumé en `--text-1` ; « Conseil » et « Pourquoi » en style `label`, puis le texte. Les raisons gardent leur badge de gravité (Grave, Attention, Info) en badges doux sémantiques.
- **Pied :** séparateur `--border-subtle`, « Analyses restantes : N » à gauche, « Déroulé de l'analyse » (repliable, `ScanProgressView`) à droite. Les mentions « servi depuis le cache », « résultat partiel » et « aucune photo » restent, en `text-xs` `--text-3`.
- **Annonce d'un professionnel :** encadré `--info-soft` en tête du panneau, texte `pro.notice`.
- **Déconnecté, sans abonnement, erreur :** titre Instrument Serif 22 px, une phrase, et une pilule blanche (« Se connecter », lien vers les formules, ou « Relancer »). Les textes sont ceux d'aujourd'hui.
- **Section debug** (superuser, dev seulement) : mêmes tokens, sans travail de mise en page au-delà.
- **Comportement inchangé :** Échap et clic à l'extérieur ferment le panneau ; Échap est consommé avant la modale Facebook.

## 4. Icône des cartes de résultats

Validée sur maquette.

- **Forme :** mini-pilule de 22 px de haut, même verre sombre, texte Inter 11 px poids 500.
- **Repos :** le logo seul (13 px), dans une pilule carrée de 22 × 22. Son nom accessible reste `card.aria`. Le « R » disparaît.
- **Analyse en cours :** logo animé seul ; le texte d'attente reste le nom du bouton.
- **Résultat :** point de couleur et niveau court. Nouvelles clés `card.level.low|medium|high` : « Faible », « Moyen », « Élevé » ; « Laag », « Gemiddeld », « Hoog ». Le nom accessible garde le niveau complet (« Risque élevé »).
- **Erreur :** logo à 60 % et « ! » en `--danger`, comme aujourd'hui.
- **Infobulle :** verre sombre, `--r-s`, 260 px de large, texte 12 px. Mêmes contenus qu'aujourd'hui (ligne d'état, résumé, erreur, mention professionnelle). `z-index` 2 147 483 000.
- **Événements :** inchangés (la carte-lien ne navigue pas, ne glisse pas).

## 5. Intégration

- `badge.css` importe `tokens.css` et `motion.css`. Les tokens sont déclarés sur `:host` (socle §2.1).
- Les polices sont chargées une seule fois par content script (socle §2.2), avant le premier montage, sans le bloquer.
- `risk-styles.ts` passe des classes Tailwind brutes aux utilités reliées aux tokens (`bg-danger`, `text-success`, etc.).
- Les animations actuelles (`radarnaque-spin`, `radarnaque-fade`) sont remplacées par celles de `motion.css`. Les points de suspension d'attente restent.

## 6. Tests du design

- **Pilule :** chaque état rend ce qu'il faut (repos : logo et « Analyser » ; en cours : logo animé et ligne d'état ; résultat : point, niveau, score ; erreur : message et « Relancer »).
- **Cartes :** les niveaux courts FR et NL ; le nom accessible garde le niveau complet.
- **Logo animé :** présent pendant l'analyse seulement. Sous `prefers-reduced-motion`, aucune classe d'animation n'agit (test sur le CSS, socle §5).
- **`z-index` :** plus aucune valeur 2147483647 dans les composants.
- **Vérification visuelle** (captures) : chaque état de la pilule, le panneau (faible, moyen, élevé, professionnel, déconnecté) et les icônes de cartes, sur les captures locales de 2ememain et de Facebook Marketplace, en FR et en NL. Contraste des textes du panneau d'au moins 4,5:1 sur le verre sombre.
