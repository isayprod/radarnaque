# Identification du produit, partie 2 (extension) — Points de suivi

Remarques relevées pendant la partie 2 de l'identification du produit : pilule « Identifier »,
panneau Identification, file d'attente de l'analyse, infobulle des cartes, galerie. La
spécification est dans [`2026-10-23-identification-produit-design.md`](../specs/2026-10-23-identification-produit-design.md)
(§13) et le plan dans [`2026-10-23-identification-partie-2-extension.md`](2026-10-23-identification-partie-2-extension.md).

## Ce qui est livré

- **Messages et flux :** événements d'identification validés et bornés par le service worker, délai
  du flux à 310 s.
- **Magasin des résultats :** identification et analyse gardées 24 h à côté l'une de l'autre.
- **Pilule « Identifier »** et panneau Identification séparés de « Analyser » ; « Analyser » en
  attente pendant une identification, « Inclus » quand l'identification vient d'être faite.
- **Panneau Identification :** critères, candidats, question au vendeur (avec les critères non
  visibles sur les photos), accessoires, pages de référence, analyses restantes.
- **Cartes :** l'infobulle ajoute « référence · niveau » avant le résumé ; une analyse de carte
  garde son identification dans le magasin.
- **Galerie :** pilule au repos, en cours, Sûr, Incertain, non identifié, erreur ; « Analyser » en
  attente et « Inclus » ; panneau Sûr et Incertain ; infobulle de carte avec la ligne produit.
  Captures de la galerie (FR, et NL pour les panneaux et la carte) gardées hors du dépôt.

## À vérifier sur les vrais sites

Aucune de ces vérifications n'a encore été faite ; l'API et l'extension doivent tourner (voir le
README, « Tester les analyses IA dans l'extension »). À faire en FR et en NL, sur 2ememain,
2dehands et Facebook Marketplace :

1. La pilule « Identifier » apparaît avant « Analyser », juste après le titre, une seule fois, et
   reste lisible sur les trois sites (hauteur 28 px, pas de style du site qui déborde).
2. Un clic sur « Identifier » : ligne d'état en direct, puis référence, niveau et pourcentage ;
   le panneau Identification s'ouvre et se ferme avec la pilule, le focus lui revient.
3. Un résultat incertain : « A ou B ? » dans la pilule ; le panneau liste les critères non visibles
   sur les photos, puis la question au vendeur ; « Copier » met la question dans le presse-papiers.
4. « Analyser » après « Identifier » : la mention « Inclus » apparaît et rien n'est décompté ;
   « Analyser » cliqué pendant l'identification attend la fin, puis part.
5. Un compte sans analyse restante : « Identifier » est grisé, « Analyser » reste actif après une
   identification.
6. Une page de résultats (grille 2ememain, 2dehands, Facebook) : analyser une carte ; l'infobulle
   montre « référence · niveau » avant le résumé ; recharger la page garde le résultat 24 h.
7. Un lien de page de référence s'ouvre dans un nouvel onglet ; les adresses autres que `https://`
   restent du texte.
8. Une identification longue ne dépasse pas les 310 s du flux et finit par un message d'erreur
   clair si elle est coupée.

## Décisions à connaître

- **Budgets de l'API : 190 s dont 80 s d'identification, inchangés.** Tant que d'anciennes versions
  de l'extension (qui coupent à 200 s) existent, le scan reste borné à 190 s. Une fois ces versions
  disparues, l'API peut rendre au parcours d'analyse les budgets de la spécification : 120 s pour
  l'identification puis 180 s pour l'analyse. L'extension le permet déjà (flux à 310 s).
- **« Identifié à la demande de l'utilisateur » gardé pour la même version de l'annonce.** Tant que
  l'empreinte de l'annonce est la même, une analyse ou une relecture du magasin ne fait pas perdre
  la mention « Inclus » ; elle tombe quand l'annonce change ou expire.
- **Modifier une annonce pendant une requête n'annule pas la requête.** Le changement d'empreinte
  remet les deux états à zéro et vide la file, mais la requête en cours va à son terme et son
  résultat est gardé avec l'empreinte du moment du clic. Seul un changement d'annonce annule.
  « Analyser » cliqué après la modification, pendant l'identification, est mis en file pour la
  version affichée au clic ; il n'est oublié que si l'annonce change encore avant la fin.
- **Critère manquant : pas de champ dédié dans l'API.** Pour un résultat incertain, l'encadré « À
  demander au vendeur » liste les critères de l'objet principal marqués « non visible » sous la
  forme « Non visible sur les photos : … », au-dessus de la question. Les « analyses restantes »
  du panneau viennent du résultat ; l'accès lu ne sert de repli qu'à une identification sans
  `remaining` (celle embarquée dans une analyse). Un résultat repris du magasin porte
  `{ scans: null }` et, comme un décompte nul (illimité), n'affiche rien, comme la section
  d'analyse.
- **« Inclus » possible à zéro analyse restante.** Conformément au §7 de la spécification,
  l'analyse qui suit une identification est incluse : la pilule « Analyser » reste active à quota 0
  tant que l'identification est récente. Si le serveur refuse quand même cette analyse
  (`quota_exhausted`), l'identification n'est plus marquée comme celle de l'utilisateur (dans la
  pastille et dans le magasin) : « Inclus » disparaît et « Analyser » redevient grisé.
- **L'API se déploie avant l'extension**, comme pour la partie 1.

## Points mineurs reportés

- Une identification dont un seul élément est mal formé est rejetée en entier ; le bloc `debug`
  passe sans borne (réservé au superuser).
- Le test du chemin « risqué » du magasin utilise la même identification pour l'utilisateur et pour
  l'analyse : la source n'est pas distinguée.
- « Analyser » cliqué après un changement d'annonce pendant une identification est ignoré en
  silence ; la file devrait garder l'empreinte du clic.
- Les événements de recherche et de réflexion de la phase d'identification arrivent dans le
  déroulé de l'analyse (les titres de réflexion peuvent se mélanger) ; pas de test d'une relance
  qui reçoit des événements d'identification ; une fermeture périmée dans la fin d'une
  identification ; `use-ai-scan.ts` fait près de 800 lignes et le routage de l'identification
  pourrait en sortir.
- Pas de test négatif « quota à 0 et identification faite sans demande de l'utilisateur » ; une
  analyse incluse refusée (quota épuisé) garde « Inclus » et peut boucler sur le refus.
- Deux régions `role="status"` pendant une analyse : un peu bavard pour un lecteur d'écran ; le nom
  de la pilule de résultat ne dit pas « Identification » ; le lien vers les formules n'a pas
  `noreferrer` (déjà le cas avant).
- Le contrôle d'adresse des liens accepte aussi des formes normalisées de `https` (majuscules,
  espaces) : sans danger ; la liste des candidats répète les deux du titre ; pas de test qui cache
  les candidats hors du cas incertain ; le presse-papiers dans le Shadow DOM n'est pas testé.
