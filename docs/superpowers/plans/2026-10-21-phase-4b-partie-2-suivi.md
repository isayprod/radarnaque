# Phase 4b, partie 2 — Points de suivi

Remarques relevées pendant la partie 2 de la phase 4b : écrans Tableau de bord, Offre et Analyses de l'administration, route publique `GET /api/offer` et page `/pricing` du site. Elles sont triées par échéance ; les points déjà corrigés n'y figurent pas. La spécification est dans le [Tableau de bord](../specs/2026-10-21-phase-4b-admin-tableau-de-bord-design.md), l'[Offre](../specs/2026-10-21-phase-4b-admin-offre-design.md) et les [Analyses](../specs/2026-10-21-phase-4b-admin-analyses-design.md), sur le [socle](../specs/2026-10-21-phase-4b-admin-socle-design.md) de la partie 1. Le plan est dans [`2026-10-21-phase-4b-partie-2-tableau-offre-analyses.md`](2026-10-21-phase-4b-partie-2-tableau-offre-analyses.md).

## Corrections prévues avant fusion

Aucune pour l'instant. La relecture finale de la branche peut en ajouter.

## Décisions prises pendant l'exécution

À garder en tête en relisant ou en faisant évoluer les écrans.

- **Curseur des analyses :** `before` est un jeton opaque `"<date ISO>~<id>"`, pas un identifiant. La liste est triée par date du dernier appel au modèle, et une analyse rafraîchie remonte en tête : un simple identifiant ne suffisait pas à paginer sans trou ni doublon.
- **URL de l'annonce (`listings.url`, migration 0008) :** sans query ni fragment, acceptée seulement si l'hôte est le domaine du site ou un sous-domaine. Sinon elle reste à `NULL`.
- **Affichage des nombres :** les pourcentages du Tableau de bord sont arrondis à l'entier ; le coût moyen par appel est affiché à 4 décimales, ainsi que les coûts de l'écran Analyses.
- **Avertissement Stripe :** il s'affiche quand change le prix d'un intervalle qui a un identifiant Stripe, pas à chaque enregistrement.
- **Photos des analyses :** ce sont des liens, pas des images (la politique de sécurité de contenu de l'admin les bloquerait).
- **Filtre Site des analyses :** il est codé en dur (2ememain.be, 2dehands.be, facebook.com), pas lu en base.

## À vérifier en direct avant la mise en ligne

Rien de ceci n'a été essayé hors des tests.

- **Tableau de bord sur la base de dev :** `http://localhost:8080/admin/`.
  - faire quelques scans à la main (un du cache, un avec appel au modèle, un en échec), puis comparer les cartes « Analyses », « Appels au modèle », « Servies depuis le cache » et « Échecs » avec ce qui a été fait, et le coût avec `llm_calls` (`select sum(cost_usd_micros) / 1000000 from app.llm_calls`) ;
  - sur une base vide, ou juste après minuit : cartes à 0, parts affichées « — », graphique à zéro, sans erreur ;
  - **le 25 octobre 2026** (jour de 25 h à Bruxelles) : un scan fait entre minuit et 1 h compte pour le 25, et le graphique a des jours contigus, sans doublon ni trou, autour du 25 et du 26 ;
  - le bouton « Actualiser » ;
  - la projection du mois est « — » pendant les 24 premières heures du mois.
- **Graphique dans le navigateur :** couleurs des trois séries et de la ligne de coût en clair et en sombre, survol, étiquettes des axes, largeur étroite, « Voir les données » (le tableau donne les mêmes valeurs), lecture au clavier.
- **Modifications de l'offre, puis `/api/me` et un scan :**
  - changer le quota Premium dans l'écran Offre, puis `GET /api/me` d'un abonné Premium : le quota restant suit ;
  - baisser un quota sous la consommation actuelle : 0 restant, sans rien effacer ;
  - retirer les icônes sur les cartes à un plan, puis lancer un scan depuis une carte : refus `403 feature_not_in_plan` ;
  - enregistrer les mêmes valeurs : aucune ligne d'historique ;
  - le nombre de photos à 0 : « Pas de photo analysée » sur `/pricing` ;
  - l'avertissement `/privacy` quand les photos changent, et l'avertissement Stripe quand un prix avec identifiant Stripe change (à essayer avec un `stripe_price_id` posé à la main sur une copie de la base de dev) ;
  - une ligne par champ dans l'historique et dans `admin_actions`.
- **Page `/pricing` en FR et en NL :** `http://localhost:8080/pricing/?lang=fr` puis `?lang=nl`, avec l'API, puis **l'API arrêtée** : les valeurs de secours s'affichent sans erreur visible. Aucun texte « analyses de texte » ni « analyses avec photos » ; la ligne des icônes suit `card_icons`.
- **En-tête de cache de `GET /api/offer` derrière Caddy :** `curl -sI http://localhost:8080/api/offer` donne `Cache-Control: public, max-age=300` et aucun cookie ; puis la même chose derrière le Caddy de production (TLS). Vérifier que Caddy ne le remplace pas.
- **Détail d'une analyse :** `/admin/analyses/{id}`.
  - avec URL (annonce scannée après la migration 0008) : le lien mène à l'annonce, s'ouvre dans un nouvel onglet sans `Referer` ;
  - sans URL (annonce d'avant la migration) : pas de lien ni de ligne vide ;
  - une analyse sans prix et sans photo : rien de cassé ;
  - le lien vers le prompt ouvre `/admin/ia/prompts/{id}` sur le bon texte ;
  - les photos sont des liens qui s'ouvrent, et la console du navigateur ne montre aucune erreur de politique de sécurité de contenu.
- **Liste des analyses :** chaque filtre seul puis combinés, la pagination (le jeton `before` mène à la page suivante sans trou), la recherche dans le titre (2 caractères refusés, 3 acceptés, casse ignorée), `from` postérieur à `to` (message d'erreur).
- **Boîte de confirmation au clavier :** dans l'écran Offre et dans l'écran Utilisateurs : le focus entre dans la boîte, Tab et Maj+Tab restent dedans, Échap ferme, le focus revient sur le bouton d'origine ; un lecteur d'écran annonce le titre.
- **Barre latérale et routes :** les cinq entrées, l'entrée active, l'accueil sur le Tableau de bord, `/admin/ia/prompts/{id}` rechargé à la main, une route inconnue (`/admin/zzz`) qui affiche la page « introuvable ».
- **Aucune donnée personnelle :** les réponses de `/api/admin/dashboard` et de `/api/admin/analyses` ne contiennent ni email ni identifiant d'utilisateur (relire une réponse brute).
- **Migration 0008 sur une base réelle :** la montée (`listings.url` vide pour les annonces existantes) et la descente (`alembic downgrade 0007`) sur une copie de la base de dev.

## Limites connues

- **Projection du mois linéaire :** `coût du mois × (durée du mois / durée écoulée)`. Elle ne tient compte ni des jours de la semaine ni d'un pic récent, et reste « — » pendant les 24 premières heures du mois. C'est une indication, pas une prévision.
- **Analyses d'avant la migration 0008 :** elles n'ont pas de lien vers l'annonce. Le lien apparaît au prochain scan de l'annonce.
- **`/privacy` en texte fixe :** la page annonce « 1 photo en Standard, jusqu'à 4 en Premium et pendant l'essai » et « jusqu'à 3 recherches ». L'écran Offre avertit quand les photos changent, l'écran IA quand les recherches changent, mais rien ne met la page à jour toute seule.
- **`GET /api/offer` en retard de 5 minutes :** après une modification de l'offre, la page `/pricing` peut garder l'ancienne valeur jusqu'à 5 minutes (cache HTTP).
- **`GET /api/offer` et le plafond de l'essai :** il donne le quota de l'essai (3) sans tenir compte de son plafond total (`total_scan_cap`). Si l'admin règle un plafond inférieur au quota, la page l'ignore.
- **`DataError` sans log serveur :** le gestionnaire qui répond `422 invalid_request` (caractère NUL, etc.) n'écrit rien dans les logs du serveur. Un problème de données venu d'un client est invisible côté serveur.
- **Scan sans issue :** un scan encore en cours, sans résultat ni échec, compte dans la carte « Analyses » mais dans aucune barre du graphique. Les barres de la journée ne s'additionnent donc pas toujours à la carte tant qu'un scan est en cours.
- **Filtre Site en dur :** l'écran Analyses propose les trois domaines connus ; un nouveau site demande de modifier l'écran.
- **Photos en liens :** les photos d'une analyse ne s'affichent pas dans l'écran (politique de sécurité de contenu stricte) ; on les ouvre dans un nouvel onglet.

## Partie 1

Les vérifications de son [suivi](2026-10-21-phase-4b-partie-1-suivi.md) restent à faire (connexion de l'admin, `admin:grant`, écrans Utilisateurs et IA, en-têtes de Caddy, purge étendue, migration 0007).
