# Phase 3c — Points de suivi

Remarques relevées pendant les relectures de la phase 3c : l'IA prioritaire dans l'extension, le prompt v2 et les annonces professionnelles. Aucune ne bloque la fusion. Elles sont triées par échéance ; les points déjà corrigés n'y figurent pas.

## À vérifier sur les vrais sites (rien ne l'a encore été)

- **`sellerType` de 2ememain :** relever la valeur réelle de `sellerType` chez un professionnel et l'ajouter à la liste fermée (R7). Aujourd'hui, une valeur hors liste donne un vendeur indéterminé : pas de bandeau, sauf si le lien « Visiter le site internet » est présent.
- **Libellés de prix :** relever les libellés réels affichés à la place du prix (« Sur demande », « Voir la description », « À échanger », « Réservé », et leurs équivalents néerlandais) et la valeur réelle de `N.o.t.k.`. Vérifier qu'aucun ne retombe en `unknown`.
- **Faux positifs des mots-clés (règles v4) :** chercher sur de vraies annonces honnêtes les phrases « acompte » (hors négation), « paiement par carte cadeau », « eigenaar in het buitenland », et un transporteur accompagné de « étranger », « buitenland » ou « intermédiaire ». Les ajuster si elles se déclenchent à tort.
- **Prompt v2 sur 10 à 20 annonces réelles :**
  - les scores ;
  - le drapeau `professional` ;
  - la pertinence des conseils ;
  - la calibration par catégorie (voiture, immobilier, animaux, billets, petits objets, etc.).

## Plus tard

- **Mots-clés des règles locales :** noter par un `TODO` le cast de `on_request` dans la règle des prix.
- **Adaptateur 2ememain :** vérifier sur la vraie page les libellés de prix et `N.o.t.k.` (voir plus haut).
- **Tests de l'extension :**
  - le validateur de réponse : une assertion sur l'erreur de littéral de `sellerKind` ;
  - une frontière d'erreur avec un résultat adopté ;
  - cibler le nœud de la mention « IA » dans les tests de la pastille ;
  - un test combiné bandeau professionnel et résultat IA.
- **Pas de nouvelle analyse pendant 24 h après un changement de prompt :** un résultat gardé dans le navigateur reste affiché même si le prompt a changé. À documenter, ou à lier à la version du prompt si cela gêne.
- **Empreinte de l'annonce :** elle contient le texte brut. Stocker une empreinte SHA-256 à la place, pour ne pas garder le texte de l'annonce dans le navigateur.
- **Angle mort de l'empreinte : les photos.** Un vendeur qui change les photos d'une annonce sans toucher au titre, à la description ni au prix garde son résultat IA pendant 24 h. Les URL des images de Facebook tournent, ce qui interdit de les mettre dans l'empreinte telle quelle.
- **Données d'entrée proposées par la recherche et non implémentées** (partie B de `docs/superpowers/research/2026-10-18-arnaques-acheteurs.md`) :
  - `platformPaymentAvailable` : la protection acheteur de la plateforme baisse le risque d'un envoi ;
  - `shippingOptions` (`pickup`, `shipping_platform`, `shipping_unspecified`) : distinguer l'envoi officiel de « envoi seulement » hors plateforme ;
  - numéros HK (agrément des animaux) et BCE/KBO (entreprise), détectés par expression régulière dans la description ;
  - une table locale de prix de référence pour 20 à 50 modèles phares (iPhone, PS5, Switch 2, vélos électriques), pour activer `price_anomaly` et `new_sealed_cheap`.

## Décisions prises pendant l'exécution

- **R1. Règles de travail :** trailer de commit « Claude Opus 5.5 », aucun push, `video/`, `.DS_Store`, `.conftest.py.swp` et `.Rhistory` jamais touchés, `web-pages/` jamais lu ; l'utilisateur avait approuvé la spec et le plan à l'avance.
- **R2. Migration 0004 :** le retour arrière réactive le prompt v1 et ne supprime le prompt v2 que si aucune analyse ne l'utilise ; la montée l'insère sans doublon. Coût si c'est faux : le retour arrière est bloqué en production dès qu'il existe des analyses v2.
- **R3. `sellerType` contre lien de site internet :** le `sellerType` donné par 2ememain l'emporte sur le lien, que le vendeur peut ajouter lui-même ; un escroc ne peut donc pas acheter le traitement « professionnel ». Coût si c'est faux : un professionnel pris pour un particulier.
- **R4. Stockage local des résultats :** une entrée par annonce, avec une place pour le texte et une pour les photos, adoptées chacune de leur côté ; les cartes préfèrent les photos, puis le texte. Coût si c'est faux : un peu plus de stockage.
- **R5. Déconnexion :** elle vide aussi les résultats IA gardés dans le navigateur, pour un ordinateur partagé. Coût si c'est faux : l'utilisateur perd ses résultats locaux en se déconnectant.
- **R6. Prompt v2 amendé sur place :** la v2 n'étant pas publiée, ses corrections de relecture finale sont faites dans 0004 au lieu d'une v3. La montée refuse une ligne (`kind`, 2) existante au texte différent. Coût si c'est faux : une base de dev qui a joué l'ancienne 0004 doit être réinitialisée.
- **R7. `sellerType` en liste fermée :** `CONSUMER` (sans casse) donne un particulier ; `PROFESSIONAL`, `TRADER`, `BUSINESS`, `DEALER`, `COMPANY` ou `PRO`, un professionnel ; toute autre valeur, un vendeur indéterminé (puis le repli du lien de site, R3). Coût si c'est faux : un vrai professionnel n'a pas de bandeau tant que sa valeur n'est pas ajoutée.
