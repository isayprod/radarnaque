# Identification — pastille unique (révision de la §13)

*Spec du 23 octobre 2026.* Révise `2026-10-23-identification-produit-design.md` : la décision « deux pilules côte à côte, chacune avec son panneau » (§2) et les §13.1 à §13.4 sont remplacées par ce document. Le reste (API, quota, service worker, magasin, cartes) ne change pas. Branche `feat/identification-pastille`, au-dessus de `feat/identification-2` (PR #16).

## 1. Pourquoi

- Deux pilules côte à côte chargent trop la fiche ; pendant l'identification, les points de suspension animés changent la largeur de la première et font sauter la seconde.
- Choix validé (option B) : **un clic identifie** (1 analyse décomptée) ; l'analyse du risque se lance ensuite **à la demande** et elle est incluse. Ceux qui ne veulent que l'identification ne paient pas l'analyse du risque. Si le clic de plus gêne à l'usage, on passera à l'option A (un clic fait tout).
- Côté serveur, rien ne change : deux appels au modèle restent préférables (cache partagé de l'identification, modèle adapté à chaque étape) ; le coût réel par étape se lit dans le tableau de bord.

## 2. La pilule unique

| État | Rendu | Clic |
|---|---|---|
| Repos | logo, « Identifier » ; nom accessible « Identifier le produit » | lance l'identification (accès, connexion, quota : règles actuelles de `useLaunch`) |
| Identification en cours | logo animé, ligne d'état | ouvre ou ferme le panneau |
| Produit identifié | glyphe, référence courte, « · », niveau et pourcentage, séparateur, action « Analyser le risque » | partie produit : ouvre ou ferme le panneau ; action : lance l'analyse du risque |
| Incertain | « {A} ou {B} ? · Incertain {n} % », séparateur, « Analyser le risque » | idem |
| Non identifié | « Produit non identifié », séparateur, « Analyser le risque » | idem |
| Analyse du risque en cours | logo animé, « {référence courte} · {ligne d'état} » (ligne d'état seule si pas de référence) | ouvre ou ferme le panneau |
| Résultat | point de couleur, « Risque faible », séparateur, « 12/100 » (inchangé) | ouvre ou ferme le panneau |
| Erreur | pilule d'erreur actuelle ; « Relancer » relance l'étape qui a échoué (identification ou analyse du risque) | — |

- **Action « Analyser le risque »** (NL « Risico analyseren ») : description « Inclus avec l'identification » quand l'analyse est incluse ; possible à quota 0 dans ce cas (spec §7) ; sans inclusion et sans analyse restante, grisée (`aria-disabled`, raison lue) ; sans abonnement : lien vers les formules.
- **Retour sur une fiche** (magasin des résultats) : une analyse gardée affiche directement le résultat du risque ; une identification seule affiche l'état « Produit identifié » avec l'action.
- **Une analyse du risque lancée depuis la pilule repasse par l'identification côté serveur** (servie par le cache) : la pilule ne revient jamais à « Identifier » pendant ce temps ; les événements d'identification alimentent le déroulé de la section Produit.
- **Largeur stable** : pendant le chargement, la ligne d'état a une largeur bornée (texte coupé avec « … ») et les points de suspension occupent une place fixe dont seule l'opacité s'anime ; rien à droite de la pilule ne bouge.
- **Accessibilité** : une seule région `aria-live` (au plus une annonce toutes les 2 s) ; le focus reste sur la pilule quand son élément change (repos → en cours → produit → action), comme aujourd'hui.

## 3. Le panneau unique

- Titre : « Analyse Radarnaque » (inchangé).
- **Avant l'analyse du risque** : la section **Produit** (contenu actuel de `IdentificationSection` : référence, confiance, critères, critères non visibles, question au vendeur et « Copier », accessoires, pages de référence, déroulé), puis en bas un bouton **« Analyser le risque »** (mêmes règles que l'action de la pilule).
- **Après l'analyse du risque** : la section **Risque** en premier (contenu actuel de `AiSection` : score, résumé, conseil, raisons, avec la ligne « Produit : … »), puis la section Produit repliée sous **« Détail du produit »** (NL « Productdetails »), ouvrable au clic.
- Pendant une identification ou une analyse en cours, le panneau montre le déroulé de l'étape en cours.
- Accès (déconnecté, sans abonnement, erreur) : les écrans actuels de la section IA.

## 4. Ce qui change dans le code

- **Retiré** : la pilule `IdentifyPill` comme élément séparé, le second panneau, la file d'attente d'« Analyser » (`queued` et sa logique dans `useAiScan`), devenue inutile puisque l'analyse du risque ne se lance qu'après l'identification.
- **Gardé** : `useAiScan` (deux états, `identify()`, `scan()`, `analysisIncluded`), le relais du service worker, le magasin v3, `IdentificationSection` (devient une section du panneau), la ligne produit d'`AiSection` et des cartes, les icônes des cartes (analyse complète, inchangées).
- **Modifié** : `BadgePill` (états du §2), `RiskBadge` (une pilule, un panneau, §3), textes FR et NL, galerie, tests, documentation.
- **API** : aucun changement.

## 5. Tests

- Chaque état de la pilule (FR et NL) ; la largeur de la pilule ne dépend pas du nombre de points de suspension affichés (même classe de largeur bornée, points dans un élément de largeur fixe).
- Parcours : Identifier → produit → « Analyser le risque » → résultat ; reprise du magasin (analyse gardée → résultat ; identification seule → produit et action).
- « Analyser le risque » : inclus à quota 0 ; grisé sans inclusion à quota 0 ; lien vers les formules sans abonnement.
- Erreur d'identification → « Relancer » relance l'identification ; erreur d'analyse → « Relancer » relance l'analyse.
- Panneau : section Produit et bouton avant ; Risque puis « Détail du produit » replié après.
- Focus et annonces : une seule région `aria-live` ; focus gardé sur la pilule à chaque changement d'état.
