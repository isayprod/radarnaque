# Phase 3b — Points de suivi

Remarques relevées pendant les relectures de la phase 3b, les analyses IA dans l'extension. Aucune ne bloque la fusion. Elles sont triées par échéance ; les points déjà corrigés n'y figurent pas.

## À vérifier sur les vrais sites (rien ne l'a encore été)

- **Grille Facebook :**
  - nombre d'icônes et fluidité du défilement ;
  - les icônes restent quand une fiche s'ouvre en modale, et reviennent si Facebook change l'URL avant de remplir le dialogue ;
  - icône ou infobulle coupées par le `line-clamp` du titre ;
  - carte-lien `aria-hidden` ;
  - aucun clic sur l'icône ne navigue : gauche, molette, Entrée, glisser. Tester sous Chrome, et sous Firefox si l'extension y est publiée un jour.
- **Facebook, analyse depuis une carte :** vérifier que la fiche récupérée sans JavaScript est bien illisible, d'où l'analyse `partial`. Noter son poids. Si elle est toujours illisible, ne plus la récupérer du tout (un indicateur dans l'adaptateur Facebook).
- **2ememain :**
  - la récupération de la fiche est acceptée (pas de blocage anti-robot) ;
  - les hôtes réels des images sont couverts par `site_image_hosts` ;
  - les cartes sans lien reçoivent leur icône dès que leur lien apparaît ;
  - après un redimensionnement, l'icône suit la variante affichée, même sans mutation du DOM.
- **Parcours :**
  - connexion depuis la popup, puis retour sur l'onglet : vérifier que `focus` se déclenche à la fermeture de la popup Chrome ;
  - essai à 3 scans → `402` → lien vers les formules ;
  - formule standard : ni bouton photos ni icônes ;
  - admin sans abonnement ;
  - session expirée en plein scan ;
  - `chrome.action.openPopup()` appelé depuis un message, hors geste direct de l'utilisateur.
- **Styles :** la pastille et les icônes ont toutes leurs bordures, ombres et anneaux de focus, maintenant que leur CSS est injecté à la main sans `@property`.

## Passe de design

- Double trait de séparation entre la section IA et le pied du panneau.
- Deux boutons « Se connecter » si les deux scans expirent ensemble.
- `aria-busy` inutile sur le bouton.
- `role="alert"` sur l'état statique `noSubscription`.
- Infobulle des cartes : la placer en `position: fixed`, calculée depuis le bouton.
- Retouches du néerlandais :

  | Clé | Texte proposé |
  |---|---|
  | `ai.loading` | « Bezig met analyseren… » |
  | `ai.partial` | « … alleen de gegevens uit de zoekresultaten … » |
  | `feature_not_in_plan` | « niet inbegrepen in je formule » |
  | `network` | « Controleer je internetverbinding » |
  | `analysis_failed` | « telt niet mee voor je resterende analyses » |

- Sans `@property`, les variables `--tw-*` deviennent héritées. Si un composant utilise un jour `text-xs`, `text-sm`, `text-base` ou `text-lg` sous un `leading-*`, redéfinir `--tw-leading` sur `:host`.

## Plus tard

- **Annonces professionnelles 2ememain (`a…`) :** lire leur fiche, puis leur ajouter une icône.
- **Cartes Facebook :** l'heuristique de lecture se trompe sur une carte de 3 lignes au prix illisible, ou dont le titre est exactement `GRATUIT`.
- **Charge par passage** sur des grilles de plusieurs centaines de cartes : à surveiller.
- **Session expirée sur une carte :** si le site retire l'hôte de la carte épinglée, son message « Session expirée » disparaît.
- **Cache d'accès :** l'invalider aussi sur `quota_exhausted`, `no_active_subscription` et `feature_not_in_plan` reçus depuis une carte. Aujourd'hui les icônes restent jusqu'à 5 min.
- **`toScanIn` :** une annonce de forme inattendue donne `internal_error` au lieu de `invalid_listing`.
- **Détails des erreurs :** `fail(code)` perd les `details` des erreurs, par exemple `scanKind` et `limit` de `quota_exhausted`.
- **Garde des émetteurs :** elle ne vérifie pas `frameId`. Sans risque tant que le content script n'est pas `allFrames`.
- **Commentaire de `components/badge.css` :** il cite encore `cssInjectionMode "ui"`.
- **Taille du content script :** `content.js` fait 284 Ko, avec React chargé sur toutes les pages Facebook (voir le suivi de la phase 2).

## Décisions prises pendant l'exécution

- **R1. Règles de travail :** trailer de commit, aucun push, et `web-pages/` jamais lu ni copié. La seule exception : ajouter des lignes à `.denylist.txt`, sans jamais en afficher le contenu.
- **R2. Pas d'icône dans un sous-arbre `aria-hidden` :** l'icône est posée après l'ancêtre `aria-hidden` le plus haut de la carte.
- **R3. Scan en `session_expired` ou `unauthenticated` :** l'accès est relu. Le panneau ne montre plus alors que la connexion.
- **R4. Suivi des cartes :** le contrôleur des cartes réagit aux changements de `href` (liens remplis tard) et remonte une icône si son hôte a disparu ou si son ancre a changé. L'état du scan est gardé par carte.
- **R5 puis R8. Politique d'accès partagée** par le panneau et les cartes :
  - `signedOut` : relu tout de suite ;
  - `noSubscription` ou erreur : relu au plus toutes les 30 s ;
  - `active` : gardé 5 min, même en changeant d'URL ;
  - `session_expired` vide le cache. La carte cliquée garde alors son icône, avec le message « Session expirée ».
- **R6. Mise à jour de la pastille :** la clé couvre toute l'annonce extraite. Des photos arrivées tard font donc apparaître le bouton photos.
- **R7. CSS des interfaces :**
  - chargé une seule fois, injecté à la main (`:root` → `:host`, sans `@property`) ;
  - sur Facebook, une fiche ouverte en modale par-dessus la grille garde les icônes ;
  - contexte WXT détaché (`ui-context.ts`), pour éviter la fuite `onInvalidated` de `createShadowRootUi`. `wxt` est épinglé en 0.21.4.
- **Admin sans abonnement :** il garde tous les droits dans la page (`plan: null` avec `unlimited: true`).
- **Clic sur une icône de carte :** il n'ouvre jamais l'annonce. C'est le cas pour un clic, un clic du milieu ou un glisser, et l'appui est annulé.
