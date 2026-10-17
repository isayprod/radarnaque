# Phase 2 — Points de suivi

Remarques mineures relevées pendant les relectures de la phase 2. Elles ne bloquent pas la fusion et sont triées par échéance. Les points déjà corrigés n'y figurent pas.

## Avant ou pendant la phase 3

- **Facebook, descriptions tronquées** : les longues descriptions coupées derrière « Voir plus » ne sont pas dépliées. Le texte caché peut contenir un contact ou un paiement hors plateforme. Il faut les déplier, ou lire les données Relay.
- **Facebook, page chargée directement** : faire une capture de `/marketplace/item/<id>/` juste après un rechargement complet (F5) pour vérifier si les données Marketplace sont présentes dans le HTML. C'est nécessaire pour les icônes sur les cartes.
- **Messagerie entre content script et service worker** : le filtre d'expéditeur refuse aujourd'hui tout message venant d'un content script. Il faudra une liste blanche dédiée pour le bouton d'analyse IA, sans jamais exposer `auth/*`.
- **Poids du bundle** : le content script pèse environ 261 Ko avec React, et il est chargé sur toutes les pages facebook.com. Charger React seulement au premier montage réduirait ce coût.
- **Charge de travail** : sur une fiche Facebook très animée, l'extraction peut tourner jusqu'à 4 fois par seconde. À surveiller.

## Après un test sur les vrais sites

- **Libellés NL de 2dehands** : `Conditie`/`Staat`, `Verificatie`, `advertenties` et `is gecontroleerd` restent à vérifier sur une vraie annonce. Un libellé faux fait seulement perdre le champ, ce qui reste sans danger.
- **Panneau rogné** : le panneau, positionné en absolu, peut être coupé par un ancêtre `overflow:hidden` ou par le bord droit de l'écran. Si c'est le cas, passer à l'API Popover.
- **Pastille retirée par le site** : le remontage est limité à une fois par URL. Si un site retire la pastille plusieurs fois, elle ne revient qu'à la navigation suivante.
- **Photos Facebook** : le dédoublonnage se fait sur l'URL complète. Si la grande image et les miniatures ont des URL signées différentes, le nombre de photos sera surestimé.

## Réglage des règles (faire évoluer `RULES_VERSION`)

- **Téléphones** :
  - les numéros fixes belges (02, 010…) ne sont pas détectés ;
  - le préfixe `4\d{2}` accepte des numéros de référence en 041x ;
  - le format `+32 (0)472…` n'est pas reconnu.
- **Mots-clés** : ils sont détectés même dans une phrase négative (« pas de paiement à l'avance »), et une expression peut chevaucher la fin du titre et le début de la description.
- **Description courte et absence d'avis** : à calibrer sur un échantillon d'annonces réelles.

## Peut attendre

- **Code** :
  - `readCondition` parcourt tout le DOM ;
  - `readOtherListingsCount` dépend du parent du titre de section ;
  - un prix `FIXED` non numérique n'est pas listé dans `missing` ;
  - `siteOf` est dupliqué dans les deux adaptateurs ;
  - `signalText` utilise un remplacement de chaîne, sensible aux motifs `$` ;
  - certains cas limites ne sont pas épinglés par un test (`count` à 0, racine Shadow fermée, absence de boucle de rafraîchissement) ;
  - si `created.mount()` lève une erreur, l'hôte peut fuir ;
  - si `createUi` ne se termine jamais, l'état reste en attente ;
  - `content.css` est rechargé à chaque montage (mis en cache par le navigateur).
- **Spec** : §4.5 dit « près du prix », alors que la pastille suit le titre (le prix est juste en dessous).
- **Outillage** : la configuration Biome imbriquée dans `test/fixtures/`, et les chemins Linux de `pnpm dev`, qui ne sont pas testés.

## Décisions prises pendant l'exécution

- **Modèles de test** : ils sont anonymisés jusqu'aux identifiants d'annonces. Un test d'hygiène les vérifie : correspondance en sous-chaîne pour les valeurs de 4 caractères ou plus, sur les formes décodées, avec une liste locale `web-pages/.denylist.txt`.
- **Champs inconnus** : une description ou des photos introuvables ne déclenchent aucune règle (`evaluate(listing, { unknown })`).
- **Détection des contacts** : elle couvre les formats `+33 6 …` et `0472 123 456`, les apostrophes typographiques, et ne compte « friends and family » que si « paypal » apparaît aussi.
- **Adaptateur 2ememain** : les avis sont lus uniquement dans la zone du vendeur et rattachés à son identifiant. Une galerie vide est une donnée réelle.
- **Adaptateur Facebook** : la fiche lue est liée à l'annonce de l'URL par `product_id`. `web.facebook.com` est accepté.
- **Pastille** : les variables Tailwind ont une valeur par défaut dans le Shadow DOM, les espacements sont en px, Échap est intercepté, et un changement de langue est appliqué à la pastille déjà affichée.
- **Stack de dev** : `pnpm dev` vérifie les ports et Docker, attend que Postgres soit prêt, puis que l'auth réponde avant de lancer l'API.

## Passe de design (à faire à la fin, avant publication)

- **Police** : la police à empattements apparaît dans le Shadow DOM, car la police de l'hôte n'est pas héritée. Fixer explicitement la famille de police sur la racine du composant.
- **Placement** : revoir la pastille et le panneau (chevauchement du titre et du bloc vendeur sur 2ememain).
- **Identité visuelle** : appliquer l'identité Radarnaque (logo, couleurs du logo) sur la pastille, le panneau et la popup.
- **Cohérence** : harmoniser la popup et la pastille.
- **Maquettes** : en proposer avant toute implémentation.
