# Phase 4b, partie 1 — Points de suivi

Remarques relevées pendant la partie 1 de la phase 4b : socle de l'administration (SPA `apps/admin`, connexion, `require_admin`, `admin_actions`, `llm_calls`, purge étendue), écrans Utilisateurs et IA. Elles sont triées par échéance ; les points déjà corrigés n'y figurent pas. La spécification est dans le [socle](../specs/2026-10-21-phase-4b-admin-socle-design.md), les écrans [Utilisateurs](../specs/2026-10-21-phase-4b-admin-utilisateurs-design.md) et [IA](../specs/2026-10-21-phase-4b-admin-ia-design.md), et le plan dans [`2026-10-21-phase-4b-partie-1-socle-utilisateurs-ia.md`](2026-10-21-phase-4b-partie-1-socle-utilisateurs-ia.md).

## Corrections prévues avant fusion

- **Asset absent sous `/admin/assets/` :** `try_files {path} /admin/index.html` répond l'`index.html` (code 200) à un fichier de `/admin/assets/` qui n'existe pas, avec l'en-tête de cache des assets (`public, max-age=31536000, immutable`). Un navigateur peut donc garder une page HTML à la place d'un script. À corriger dans la vague finale (repli sur `index.html` hors de `/admin/assets/` seulement, `404` dans `/admin/assets/`), sinon à suivre ici. Le correctif touche `infra/Caddyfile` et `infra/Caddyfile.dev`.

## À vérifier en direct avant la mise en ligne

Rien de ceci n'a été essayé hors des tests.

- **Connexion de l'admin :** sur `http://localhost:8080/admin/`.
  - par le lien magique : le lien de l'email ramène sur `/admin/` et la session est ouverte ;
  - par le code à 6 chiffres, saisi dans la page ;
  - le lien expiré ou déjà utilisé mène à `/admin/?erreur=lien` ;
  - `/auth/sign-in/email-otp` pose bien le cookie de session sur la même origine (sans lui, `/auth/token` ne donne pas de JWT) ;
  - un compte qui n'est pas admin voit « Accès réservé aux administrateurs » et aucune donnée ;
  - la déconnexion ramène à l'écran de connexion.
- **`pnpm admin:grant` sur la base de dev :** sur un compte existant, puis `admin:revoke` ; compte inconnu (code 1) ; refus de retirer le dernier admin (code 3).
- **`/auth/admin/list-users` :** `404` avec la session d'un admin (et aussi `/auth/admin/set-role`, `remove-user`).
- **Image `auth` de production, `scripts/` présent :** la commande `docker compose -f infra/docker-compose.yml --env-file infra/.env exec auth node --import tsx scripts/admin-role.ts grant <email>` suppose que `scripts/admin-role.ts` et `tsx` sont dans l'image (`pnpm deploy --prod --legacy`). À essayer sur la composition de production en local (README, « Essayer la composition de production en local »). Sinon, ajouter le dossier à l'image ou changer la commande.
- **Écran Utilisateurs :**
  - recherche (3 caractères, casse ignorée, `a_b` ne trouve pas `axb`), filtres, pagination ;
  - attribuer un plan à un compte d'essai, puis vérifier `GET /api/me` (la consommation mensuelle repart) ;
  - nommer puis retirer un admin ; refus sur soi-même et sur le dernier admin ;
  - supprimer un compte de dev (saisie de l'email) : la cascade est celle de la phase 4a, la ligne `user.deleted` garde l'identifiant ;
  - un admin rétrogradé pendant que son onglet est ouvert voit « Accès réservé aux administrateurs » à la requête suivante, sans boucle.
- **Essai du modèle :** sur `stub` (sans réseau), puis sur OmniRoute (`pnpm dev:api` avec le fournisseur actif). Score, durée, tokens et réponse brute s'affichent ; un fournisseur sans clé donne l'erreur `configuration` ; la 11e demande de l'heure donne `429 rate_limited`.
- **Essai de recherche sur SearXNG :** résultats affichés tels qu'ils partent au modèle, contacts masqués ; la 31e demande de l'heure donne `429` ; avec `SEARCH_BACKEND=none`, un message clair.
- **Réponse réelle de `/healthz` de SearXNG :** relever le code et le corps de `GET {SEARXNG_URL}/healthz` sur l'instance de dev (`http://127.0.0.1:8888`) puis sur la production. L'API ne regarde que le code de réponse (`ok` pour un `2xx`, `down` pour le reste ou une absence de réponse en 3 s) : vérifier que `/healthz` existe bien dans la version de SearXNG utilisée et répond `2xx` quand le moteur est sain, sinon l'écran afficherait `down` à tort.
- **Rendu des écrans :** à regarder dans un navigateur, ce que les tests ne couvrent pas.
  - couleurs de l'état du moteur (`ok`, `down`, `disabled`) ;
  - fenêtres de confirmation (plan, rôle, suppression, modèle actif, prompt, réglages) : focus, fermeture au clavier, texte ;
  - éditeur de prompt, résultats des essais, largeur étroite.
- **En-têtes de Caddy :** `curl -sI http://localhost:8080/admin/` (puis `/admin/utilisateurs` et un fichier de `/admin/assets/`) : politique de sécurité de contenu `default-src 'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` sauf sous `/admin/assets/`. Même chose derrière le Caddy de production (TLS), et vérifier que la politique n'empêche pas la page de se charger (console du navigateur).
- **Journal d'accès :** `docker compose logs api` après des recherches d'utilisateurs : aucune ligne d'accès HTTP (pas de chemin ni de query string), et les lignes `radarnaque.admin` visibles en `INFO` (voir la question analogue du [suivi 4a](2026-10-20-phase-4a-suivi.md)).
- **Purge étendue :** `uv run radarnaque-purge` sur une copie de la base de dev avec des lignes de `admin_actions` et de `llm_calls` de 13 et de 11 mois : seules les premières disparaissent, la sortie est `scan_events supprimés : N, admin_actions : N, llm_calls : N`, et une ligne `system.purge` est écrite.
- **Migration 0007 sur une base réelle :** la reprise de `llm_calls` (une ligne par analyse existante) et la descente (`alembic downgrade 0006`) sur une copie de la base de dev.

## Limites connues

- **Limiteurs et cache propres à chaque processus de l'API :**
  - les limites des essais (10 par heure et par admin pour le modèle, 30 pour la recherche) et le cache des essais de recherche sont en mémoire ;
  - avec plusieurs processus ou un redémarrage, la limite se remet à zéro et la taille du cache affichée est celle du processus qui répond ;
  - sans conséquence avec un seul processus (cas prévu) et peu d'admins ; à partager (Postgres ou Redis) si l'API passe à plusieurs processus.
- **Un admin peut supprimer son compte depuis la popup, même s'il est le dernier :** `DELETE /api/me` (phase 4a) n'a pas le garde-fou de l'admin. Accepté (socle §4) : `pnpm admin:grant <email>` rétablit un admin sur un autre compte, en production par `docker compose exec auth …`.
- **Pas de double authentification, ni d'export des données d'un utilisateur :** hors de la phase (socle §8).
- **`/privacy` et `max_web_searches` :** la page dit « jusqu'à 3 recherches » (décision R9 du [suivi 4a](2026-10-20-phase-4a-suivi.md)). L'écran IA avertit quand le réglage change, mais rien ne met la page à jour toute seule.

## Reste pour la partie 2

- **Tableau de bord :** scans par jour et par type, part servie depuis le cache, coût du jour et du mois (lus sur `llm_calls`), abonnés actifs par plan, taux d'échec, dernière ligne `system.purge`, état du moteur de recherche (la vérification existe déjà).
- **Offre :** prix, quotas, fonctionnalités, photos, plafond de l'essai, avec la page `/pricing` du site ; codes d'action `offer.*`.
- **Analyses :** liste et détail des analyses récentes (nombre d'appels et coût total lus sur `llm_calls`).
- **Barre latérale :** aujourd'hui seulement Utilisateurs et IA ; les trois autres entrées s'ajoutent avec leurs écrans.
