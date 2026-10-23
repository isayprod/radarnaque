# Identification, pastille unique — Points de suivi

Remarques relevées pendant la refonte « une seule pilule, identification puis analyse du risque » :
une pilule, un panneau, deux temps. La spécification est dans
[`2026-10-23-identification-pastille-unique-design.md`](../specs/2026-10-23-identification-pastille-unique-design.md)
et le plan dans [`2026-10-23-identification-pastille-unique.md`](2026-10-23-identification-pastille-unique.md).

## Ce qui est livré

- **Ligne d'état de largeur stable :** texte borné et coupé avec « … », points de suspension dans un
  élément de largeur fixe dont seule l'opacité s'anime ; la pilule ne change plus de largeur
  pendant le chargement.
- **Une seule pilule :** « Identifier » au repos, puis le produit (glyphe, référence, niveau),
  puis « Analyser le risque » dans la même pilule, puis le résultat du risque (inchangé).
- **Un seul panneau, « Analyse Radarnaque » :** section Identification avant l'identification ;
  « Produit » puis « Analyser le risque » une fois identifié ; le risque puis « Détail du produit »
  (replié) une fois analysé.
- **Un seul chemin pour lancer le risque :** pilule et panneau passent par le même lancement
  (règles d'accès, inclusion, grisé) ; l'ancien bouton « Lancer une analyse IA » est supprimé.
  Le bouton reste focalisable pendant l'analyse (`aria-disabled`, clic ignoré).
- **Galerie :** repos, identification en cours, produit Sûr, Incertain, non identifié, action
  incluse, action grisée, analyse du risque en cours, résultat faible, moyen et élevé, erreurs
  d'identification et d'analyse ; panneau avant, après (« Détail du produit » ouvert),
  annonce professionnelle, déconnecté, erreurs avec formules ou reconnexion. Captures (FR, et NL
  pour la pilule produit et le panneau) gardées hors du dépôt, dans
  `.superpowers/shots/identification-pastille/` (dossier ignoré par Git).

## À vérifier sur les vrais sites

Aucune de ces vérifications n'a encore été faite ; l'API et l'extension doivent tourner (voir le
README, « Tester les analyses IA dans l'extension »). À faire en FR et en NL, sur 2ememain,
2dehands et Facebook Marketplace :

1. Une seule pilule « Identifier » apparaît juste après le titre, une seule fois, lisible sur les
   trois sites, sans style du site qui déborde.
2. Un clic sur « Identifier » : la ligne d'état avance sans que la pilule change de largeur ni
   que le focus quitte la pilule ; la pilule finit sur la référence et le niveau, sans pourcentage.
3. Un résultat incertain (« A ou B ? ») et un produit non identifié s'affichent sans couleur de
   risque.
4. « Analyser le risque », dans la pilule puis dans le panneau : même comportement, même
   résultat ; avec un compte sans analyse restante, il reste actif juste après une identification
   (« Inclus avec l'identification ») et grisé sinon.
5. Le panneau : « Produit » puis « Analyser le risque » avant l'analyse ; le risque puis
   « Détail du produit » replié après ; Escape et « Fermer » rendent le focus à la pilule.
6. Compte déconnecté, abonnement absent, session expirée en cours d'analyse : un seul écran
   d'accès, jamais répété.
7. Changer d'annonce (grille, modale Facebook) remet la pilule au repos, sans reste de l'ancienne.
8. Lecteur d'écran : une seule annonce vocale à la fois, au plus toutes les 2 s.

## Décisions à connaître

- **Pas de pourcentage dans la pilule du produit.** La référence est ce qui compte dans cet état,
  et elle était coupée avec le pourcentage ; le pourcentage reste dans le panneau, à un clic. La
  pilule du produit peut aller jusqu'à 400 px.
- **Une seule ellipse.** La ligne d'état retire un « … » final de son texte, puisque les points
  animés à largeur fixe le remplacent ; plus de double « … … » pendant le chargement.
- **« Analyser le risque » inclus à quota 0** (§7 de la spécification) : actif juste après une
  identification demandée par l'utilisateur, grisé quand l'identification vient du magasin sans
  analyse restante.
- **Aucun changement de l'API, du service worker ni du magasin des résultats.**

## À traiter ensuite

La régression « Vespa 946 Cheval » (produit mal identifié : « cheval » n'est pas retraduit en
« Horse », donc aucune page de référence et un résultat « Incertain 59 % ») est décrite dans
[`2026-10-23-identification-regression-vespa.md`](2026-10-23-identification-regression-vespa.md) ;
c'est le sujet suivant.

## Points mineurs reportés

La relecture finale de la branche et sa vague de corrections ont réglé : le bouton « Identifier le
produit » du panneau passe par les mêmes règles que la pilule, la pilule d'erreur ouvre le panneau
(le produit reste accessible), les régions annoncées du panneau, les titres en double, la largeur
de la pilule pendant l'analyse. Restent :

- Pendant l'analyse du risque, si l'identification n'est pas servie par le cache (annonce modifiée,
  cache expiré), la ligne d'état reste sur « Démarrage de l'analyse… » le temps que le serveur refait
  l'identification ; à observer sur les vrais sites.
- Une analyse relancée après un changement de version de l'annonce n'affiche pas la progression de
  l'identification refaite (cas rare).
- Pendant l'analyse, la référence est bornée à 140 px (« Gazelle Orange C7 … ») ; environ 165 px
  l'afficherait en entier, à ajuster après essai.
- Un espace de 1,2 em reste à droite du texte quand la pilule est au repos sans « … » à la fin.
- Le test du mouvement réduit de la ligne d'état est presque tautologique (le vrai garde-fou est le
  test sur `badge.css`) ; le test « même texte » passe même sans attente.
- Une partie des tests de la pilule ont été adaptés après coup, sans passage par l'échec.
