# Radarnaque v4 — État du projet

*Au 21 octobre 2026.* Ce document résume ce qui a été construit, où le trouver, et ce qu'il reste à faire.

Les autres documents :
- le démarrage pas à pas est dans le [README](../README.md) ;
- la conception complète est dans le [spec](superpowers/specs/2026-10-16-radarnaque-v4-design.md) ;
- chaque phase a son plan et sa liste de points de suivi dans [`superpowers/plans/`](superpowers/plans/).

## En une phrase

Radarnaque est une extension Chrome, Edge et Brave qui signale les annonces suspectes sur 2ememain.be, 2dehands.be et Facebook Marketplace :
- un score local gratuit, sans compte et illimité, pour tout le monde ;
- une analyse IA, au clic, pour les comptes connectés : essai de 3 analyses, puis abonnement Standard ou Premium. Elle regarde les photos, cherche sur le web et montre sa réflexion en direct.

## Où en sont les branches

| Phase | Contenu | Branche | État |
|---|---|---|---|
| 1 | Fondations et connexion (lien magique et code à 6 chiffres) | `main` | fusionnée |
| 2 | Adaptateurs des sites et règles locales | `main` | fusionnée |
| 3a | Serveur des analyses IA (fournisseurs LLM, quotas, cache, photos) | `main` | fusionnée |
| 3b | Analyses IA dans l'extension (panneau, icônes sur les cartes) | `feat/phase-3b` | terminée, non poussée |
| 3c | L'IA remplace l'analyse locale, prompt v2, annonces professionnelles | `feat/phase-3c` (au-dessus de 3b) | terminée, non poussée |
| — | Superuser de développement (logs de debug, relance sans cache) | `feat/superuser-debug` (au-dessus de 3c) | terminée, non poussée |
| 3d | Recherche web (SearXNG), réflexion, photos obligatoires (un seul type d'analyse), analyse en direct dans la pastille | `feat/phase-3d` (au-dessus de `feat/superuser-debug`) | terminée, non poussée |
| 4a | RGPD : suppression du compte, purge à 12 mois, page `/privacy` à jour | `feat/phase-4a` (au-dessus de `feat/phase-3d`) | terminée, non poussée |
| 4b, partie 1 | Administration : socle (SPA `apps/admin`, connexion, droits, journal), écrans Utilisateurs et IA | `feat/phase-4b` (au-dessus de `main`, où 4a est fusionnée) | terminée, non poussée |
| 4b, partie 2 | Administration : Tableau de bord, Offre (dont `/pricing`) et Analyses | — | à faire |
| 5 | Paiement Stripe | — | à faire (les routes répondent 501) |
| — | Passe de design (identité visuelle, maquettes) | — | à faire en dernier |

Les phases 3b, 3c et 3d n'ont pas encore été essayées sur les vrais sites. Les vérifications à faire sont listées dans les suivis [3b](superpowers/plans/2026-10-18-phase-3b-suivi.md), [3c](superpowers/plans/2026-10-18-phase-3c-suivi.md), [3d](superpowers/plans/2026-10-19-phase-3d-suivi.md), [4a](superpowers/plans/2026-10-20-phase-4a-suivi.md) et [4b partie 1](superpowers/plans/2026-10-21-phase-4b-partie-1-suivi.md). Les phases 3d et 4a ont aussi une liste de corrections prévues avant leur fusion.

## Architecture

```
Extension (WXT, React)  ──►  Caddy (une seule origine)  ──►  auth  (Better Auth, Node/Hono, :3000)
   content scripts                /auth/*                         sessions, JWT EdDSA, admin
   service worker                 /api/*        ──►  api   (FastAPI, Python 3.13, :8000)
   popup                          /auth/callback ─►  site  (Vite statique)
                                  /admin/*      ──►  admin (SPA Vite statique)
                                                         │
                                                  PostgreSQL (schéma auth + schéma app en 3NF)
                                                         │
                                                  Fournisseur LLM (OpenRouter en prod)
                                                  SearXNG (recherche web, réseau interne)
```

- **Dépôt public :** https://github.com/isayprod/radarnaque. Le monorepo utilise pnpm (`apps/extension`, `apps/site`, `apps/admin`, `services/auth`, `packages/shared`) et uv (`services/api`).
- **Hébergement prévu :** un serveur en Allemagne, avec le domaine `radarnaque.mostconsult.be`. Les emails partent par Resend.
- **En dev :** Caddy écoute sur `http://localhost:8080`, Postgres sur le port 5433, SearXNG sur 8888, l'auth sur 3000, l'API sur 8000 et le serveur WXT sur 3100. `pnpm dev` lance tout, y compris la compilation en continu de l'admin (`http://localhost:8080/admin/`).

## Ce qui fonctionne

### Comptes et connexion (phase 1)
- **Connexion sans mot de passe :** l'email envoyé contient à la fois un lien magique et un code à 6 chiffres, utile si l'email est ouvert sur un autre appareil. Une seule route envoie l'email : `/auth/start`.
- **Limites :** 20 demandes par IP, puis 5 par email, toutes les 15 minutes.
- **JWT :** l'auth émet des JWT EdDSA de 15 minutes. L'API les vérifie avec la clé publique (JWKS) et répond 503 si celle-ci est indisponible.
- **Essai :** à la première connexion, l'utilisateur reçoit un essai de 3 analyses.
- **Rôles :** `trial`, `standard`, `premium` et `admin`. L'admin n'a pas de quota.
- **Popup de l'extension :** connexion, état du compte, analyses restantes et choix de la langue (FR ou NL).

### Analyse locale (phase 2, règles v4 en phase 3c)
- **Adaptateurs :**
  - 2ememain et 2dehands : JSON-LD, `__CONFIG__` et DOM ;
  - Facebook : liens `/marketplace/item/`, ARIA et libellés, jamais les classes CSS.
- **Format commun :** chaque adaptateur produit un objet `Listing`. En phase 3c, il porte en plus le type de vendeur (particulier ou professionnel) et des types de prix précis (sur demande, voir description, échange, réservé).
- **Règles locales**, sans réseau :
  - peu de photos, compte récent, aucun avis ;
  - vendeur hors de Belgique ou à l'étranger ;
  - description courte, contact hors plateforme, envoi uniquement ;
  - paiement à l'avance ou hors plateforme, prix symbolique.
- **Pondération :** pour un objet à prix fixe de moins de 30 €, les signaux faibles comptent moitié moins.
- **Affichage :** une pastille et un panneau dans un Shadow DOM, isolés du site.

### Analyses IA, côté serveur (phases 3a, 3c et 3d)
- **Routes :** `POST /api/scans/stream` (l'analyse, avec ses événements en direct), `POST /api/scans` (la même, sans flux), `GET /api/scans/history` et `GET /api/me`. Les routes `/api/billing/*` répondent 501.
- **Un seul type d'analyse, `full` :** elle joint toujours les photos. Les anciens types `text` et `image` ne restent que dans l'historique.
- **Déroulé d'un scan :**
  1. limite de requêtes ;
  2. vérification des droits du plan ;
  3. validation de l'annonce ;
  4. réservation du quota (verrou `FOR UPDATE`) ;
  5. cache partagé de 24 h, avec un verrou pour qu'une même annonce ne déclenche qu'un seul appel au LLM ;
  6. en cas d'échec, ou si le client part en cours de route, le scan est rendu à l'utilisateur.
- **Flux en direct :**
  - `POST /api/scans/stream` répond en `text/event-stream` après la réservation du quota (un refus reste une réponse JSON) ;
  - événements : `stage` (cache, photos, analyzing, writing), `thinking`, `search`, `search_done`, `result` et `error` ;
  - un commentaire `: ping` toutes les 15 s garde la connexion ouverte ;
  - Caddy ne met rien en tampon sur cette route (`flush_interval -1`).
- **Recherche web :**
  - le modèle appelle l'outil `web_search(query, aspect)`, que l'API exécute sur **SearXNG** auto-hébergé : cela marche avec tous les fournisseurs ;
  - au plus 3 recherches par analyse (`settings.max_web_searches`), 5 résultats chacune, cache de 24 h ;
  - les requêtes sont masquées (téléphones, emails) et les résultats traités comme des données non fiables ;
  - un moteur en panne n'empêche pas l'analyse ;
  - les recherches réussies sont gardées en base (`analysis_web_searches`) et rappelées quand l'analyse vient du cache.
- **Réflexion :**
  - `reasoning_effort` (`none`, `low`, `medium`, `high`) se règle par fournisseur dans `providers.toml` : `high` pour `openai-oauth`, `low` pour OpenRouter ;
  - les résumés de réflexion sont relayés en direct ;
  - 90 s par tour de modèle, 180 s par analyse.
- **Vie privée :** l'identité du vendeur est refusée à l'entrée. Les téléphones et les emails sont masqués avant l'envoi au LLM.
- **Photos :** elles ne sont téléchargées que depuis les CDN des sites, jamais depuis une adresse interne. De 5 Mo et 768 px au plus. Leur nombre dépend du plan : 4 en essai et en Premium, 1 en Standard, 3 au plus avec Groq. Une annonce sans photo est analysée quand même, et le résultat le dit.
- **Fournisseurs LLM :** ils sont décrits dans `services/api/providers.toml` (OpenRouter, Groq, openai-oauth, OmniRoute, Ollama et un faux fournisseur). La commande `radarnaque-llm use …` change de fournisseur ou de modèle.
- **Prompt `full` v1 (phase 3d) :** il reprend le prompt v2 et ajoute l'usage de la recherche web, le nombre de photos reçues, la date du jour (en Europe/Brussels) et « réfléchis en français ».
- **Prompt v2 (phase 3c) :** il est fondé sur la [recherche sur les arnaques](superpowers/research/2026-10-18-arnaques-acheteurs.md). Il tient compte :
  - du taux de base, faible ;
  - du risque par catégorie ;
  - de l'écart avec le prix du marché ;
  - des signaux forts et des non-signaux ;
  - des annonces de professionnels (champ `professional`) ;
  - d'un conseil adapté à la catégorie.

### Analyses IA, dans l'extension (phases 3b, 3c et 3d)
- **Sur une annonce :** la pastille a un bouton « Analyser avec l'IA », et le panneau « Lancer une analyse IA ». Le résultat, en FR ou NL, **remplace** l'analyse locale : la pastille affiche alors le score IA avec la mention « IA ».
- **Lancement depuis la pastille :**
  - connecté, le bouton lance l'analyse tout de suite ;
  - non connecté, il ouvre la popup de connexion ;
  - quota épuisé, il est grisé, avec « Plus d'analyses IA disponibles ».
- **Analyse en direct :**
  - la pastille s'élargit : une icône qui tourne et une ligne de texte qui suit l'analyse (photos, titre de la réflexion du modèle, recherches web et domaines, rédaction du verdict) ;
  - des points de suspension animés apparaissent après 4 s sans événement ;
  - la ligne est dans un `aria-live` mis à jour au plus toutes les 2 s ;
  - une erreur, une connexion impossible ou une analyse interrompue (service worker arrêté) s'affichent dans la pastille, avec « Relancer ».
- **Panneau :** il montre le déroulé complet, replié ensuite sous « Comment l'IA a analysé » (recherches comprises, même pour un résultat du cache). Une annonce sans photo donne « Analysée sans photo ».
- **Sur une page de résultats :** une icône « R » apparaît sur chaque carte pour les comptes essai, Premium et admin. Au clic, elle tourne, l'infobulle suit l'analyse en direct, puis l'icône devient la pastille du niveau de risque.
- **Conservation :** le résultat est gardé 24 h dans le navigateur, à une seule place par annonce. La déconnexion l'efface, et un changement de l'annonce le rend caduc.
- **Messagerie :** l'analyse passe par un port `scan/stream` entre le content script et le service worker, qui relaie et valide les événements du flux. Fermer le port annule la requête.
- **Bandeau « annonce professionnelle » :** il signale un magasin qui utilise l'annonce comme vitrine. Il ne cache jamais le score.
- **Sécurité :**
  - les content scripts ne peuvent envoyer que trois messages au service worker (`content/access`, `content/debug` en dev seulement, `ui/open-popup`), plus le port `scan/stream`, soumis au même contrôle de l'émetteur ;
  - `account/delete` n'est accepté que d'une page de l'extension (la popup) ;
  - le service worker est le seul à détenir la session et le JWT.

### RGPD (phase 4a)
- **Suppression du compte :**
  - `DELETE /api/me` (`204` sans corps, `401 unauthenticated` si l'utilisateur est absent) supprime l'utilisateur dans une seule transaction ;
  - la cascade efface la session, le compte, l'abonnement, les scans et leurs résultats et échecs ;
  - les analyses d'annonces et leurs snapshots restent : ce ne sont pas des données personnelles ;
  - l'API journalise une ligne `INFO` sans identifiant ni email.
- **Dans la popup :**
  - section « Supprimer mon compte », repliée, en bas quand on est connecté ;
  - il faut taper `SUPPRIMER` (FR) ou `VERWIJDEREN` (NL), sans tenir compte de la casse ni des espaces autour ;
  - un double clic n'envoie qu'une requête ;
  - un lien « Confidentialité » dans le pied mène à `/privacy/?lang=<langue>`.
- **Messagerie :** `account/delete` n'est accepté que d'une page de l'extension. Un content script reçoit `forbidden_sender`, sans appel réseau.
- **Côté extension :**
  - sur `204` ou `401`, le service worker efface la session, le JWT et les résultats IA gardés ;
  - sur une autre erreur (500, réseau), il ne touche à rien et la popup dit que le compte n'a pas été modifié.
- **Purge à 12 mois :**
  - une tâche de fond de l'API (lancée 60 s après le démarrage, puis toutes les 24 h) supprime les `scan_events` de plus de 12 mois (`SCAN_RETENTION_MONTHS`), par lots de 5 000 (depuis la phase 4b, la même passe, `run_purge`, purge aussi `admin_actions` et `llm_calls`) ;
  - `pg_try_advisory_lock` : un seul processus purge à la fois ;
  - `PURGE_ENABLED=false` la désactive (valeur par défaut des tests) ;
  - `uv run radarnaque-purge` fait une passe à la main ;
  - le journal `INFO` ne donne que les nombres supprimés.
- **Essai préservé :** avant de supprimer, la purge ajoute les scans réussis de l'essai à `subscriptions.purged_scans` (migration 0006). Le plafond total en tient compte : un essai ne retrouve pas ses 3 analyses.
- **Page `/privacy` :** FR et NL à jour, avec les sections photos (toute analyse), recherches sur le web, résultat gardé 24 h dans le navigateur, conservation (seul le nombre d'analyses de l'essai reste après 12 mois), hébergement (sauvegardes chiffrées copiées vers un stockage externe, Resend pour les emails de connexion) et effacement.

### Administration (phase 4b, partie 1)
- **Application :** `apps/admin` (Vite, React, Tailwind), servie par Caddy sous `/admin/`, en production comme en dev (`http://localhost:8080/admin/`). Interface en français, JWT gardé en mémoire. `pnpm dev:admin` (compilation en continu) est lancé par `pnpm dev`. Caddy ajoute sur `/admin/*` une politique de sécurité de contenu stricte, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` et `Cache-Control: no-store` (sauf `/admin/assets/*`).
- **Connexion :** lien magique ou code à 6 chiffres, par `/auth/start` avec `target: "admin"` (lien vers `/admin/`, email qui parle de la « page d'administration », `400 invalid_target` pour une autre valeur). Un utilisateur sans le rôle voit « Accès réservé aux administrateurs ». Un `403 admin_required` en cours de session affiche le même écran, sans nouvelle tentative.
- **Droits :** `require_admin` (`auth.user.role = 'admin'`, relu en base à chaque requête ; superuser accepté hors production). Les routes `/auth/admin/*` de Better Auth répondent `404` : tout passe par `/api/admin/*`.
- **Premier admin :**
  - en dev : `pnpm admin:grant <email>` et `pnpm admin:revoke <email>` (le dernier admin ne se retire pas : code 3) ;
  - en production : `docker compose exec auth node --import tsx scripts/admin-role.ts grant <email>`.
- **Journal :**
  - migration 0007 : `admin_actions` (une ligne par modification, écrite dans la même transaction, `details` en `{ from, to }`, jamais d'email) et `llm_calls` (une ligne par appel au modèle, écrite par `save_analysis`, reprise des analyses existantes) ;
  - une ligne `INFO` par modification sous `radarnaque.admin`, sans email ni identifiant ;
  - uvicorn tourne avec `--no-access-log` (Dockerfile et `dev:api`).
- **Utilisateurs :**
  - recherche par email (3 caractères au moins, sous-chaîne, `%` et `_` traités comme des caractères), liste paginée par curseur ;
  - fiche : abonnement actif, consommation, historique, 20 derniers scans, journal ;
  - actions : attribuer un plan (provider `manual`, `409` si l'abonnement actif vient de Stripe), nommer ou retirer un admin (pas soi-même, pas le dernier), supprimer le compte (confirmation par la saisie de l'email, pas soi-même).
- **IA :**
  - fournisseurs de `providers.toml` en lecture seule (état de la clé, jamais sa valeur) ;
  - ajout d'un modèle (slug de 1 à 200 caractères, sans espace) ;
  - modèle actif et versions du prompt (200 à 20 000 caractères, jamais modifiées, numéros qui se suivent) ;
  - réglages : `cache_ttl_hours` 1–168, `rate_limit_per_minute` 1–600, `max_web_searches` 0–5 ;
  - essai du modèle (annonce fictive, hors quota et hors cache) : 10 par heure et par admin ;
  - état du moteur de recherche (`GET {SEARXNG_URL}/healthz`, 3 s, gardé 60 s : `ok`, `down`, `disabled`) et essai de recherche hors cache : 30 par heure et par admin.
- **Barre latérale :** seulement Utilisateurs et IA ; le Tableau de bord, l'Offre et les Analyses viennent en partie 2.
- Voir le [README](../README.md#administration-phase-4b) et le [suivi](superpowers/plans/2026-10-21-phase-4b-partie-1-suivi.md).

### Superuser de développement
- **Rôle `superuser`, réservé au développement :** aucun quota ni limite de requêtes, traité comme un compte **Premium** (plan, fonctionnalités, 4 photos). Il s'attribue avec `DEV_SUPERUSER_EMAIL` (`infra/.env`) ou `pnpm dev:superuser <email>`. L'API l'ignore en production.
- **Logs de debug :** console de l'API (`[debug superuser]`), console de la page et du service worker (« Radarnaque debug »), section « Debug (superuser) » du panneau. Depuis la phase 3d, ils contiennent aussi les tours du modèle, les recherches web et le texte de la réflexion.
- **« Relancer sans cache » :** force un nouvel appel au modèle et rafraîchit l'analyse partagée.
- Voir le [README](../README.md#superuser-de-développement).

### Site
- La page `/auth/callback` reçoit la connexion par lien magique.
- Les pages `/pricing` et `/privacy` existent en FR et NL. Depuis la phase 4a, `/privacy` décrit fidèlement le produit : elle peut être publiée une fois l'adresse `privacy@mostconsult.be` confirmée et la rétention du stockage distant des sauvegardes vérifiée (la page annonce 14 jours sur notre serveur).

## Offre

Un seul type d'analyse IA, avec photos et recherche web.

| Plan | Prix | Analyses IA | Photos par analyse | Icônes sur les cartes |
|---|---|---|---|---|
| Essai | gratuit | 3 au total | 4 | oui |
| Standard | 2,99 €/mois ou 29 €/an | 150 par mois | 1 | non |
| Premium | 6,99 €/mois ou 69 €/an | 300 par mois | 4 | oui |

Coût estimé avec `google/gemini-3.1-flash-lite` : environ 1,1 ¢ par analyse au pire (4 photos, 3 recherches), environ 0,4 ¢ sans recherche.

## Tests

| Partie | Tests | Commande |
|---|---|---|
| API | 907 | `pnpm test:api` |
| Extension | 1085 | `pnpm --filter extension test` |
| Auth | 88 | `pnpm --filter auth test` |
| Site | 50 | `pnpm --filter site test` |
| Admin | 61 | `pnpm --filter admin test` |
| Scripts | 16 | `pnpm test:scripts` |
| Bout en bout | connexion et scan (en flux) | `pnpm e2e:login`, `pnpm e2e:scan` |

À chaque phase :
- une relecture par tâche ;
- une relecture complète de la branche ;
- un contrôle de l'historique Git contre une liste locale de données personnelles, avant tout envoi.

## Pour développer

- **Démarrer :** `pnpm dev` lance Postgres, Caddy, SearXNG, l'auth, l'API, le site et l'extension (voir le [README](../README.md)). SearXNG répond sur `http://127.0.0.1:8888`.
- **IA gratuite en dev :**
  - **Groq**, avec une clé gratuite à mettre dans `GROQ_API_KEY` ;
  - **ton abonnement ChatGPT**, via `npx openai-oauth`, avec le modèle `gpt-6-luna` : c'est lui qui réfléchit et cherche le mieux en dev.
- **Réflexion :** `reasoning_effort` (`none`, `low`, `medium`, `high`) est une option de chaque fournisseur de `services/api/providers.toml`. Redémarrer l'API après l'avoir changée.
- **Sans recherche web :** `SEARCH_BACKEND=none` dans `infra/.env` retire l'outil de recherche.
- **Essayer le flux :** `pnpm e2e:scan` affiche chaque événement à son arrivée ; `--no-stream` utilise la route sans flux.
- **Base de dev :** l'API applique les migrations au démarrage (`pnpm dev:api`). La migration 0005 de la phase 3d crée le type `full`, retire les quotas `text` et `image` et ajoute `plans.max_images`. La migration 0006 de la phase 4a ajoute `subscriptions.purged_scans`. La migration 0007 de la phase 4b crée `admin_actions` et `llm_calls`.
- **Purge :** `PURGE_ENABLED=false` dans `infra/.env` coupe la tâche de fond en dev ; `radarnaque-purge` fait une passe à la main et affiche `scan_events supprimés : N, admin_actions : N, llm_calls : N` (voir le [README](../README.md)).
- **Admin :** `http://localhost:8080/admin/` ; `pnpm admin:grant <email>` donne le rôle admin à un compte existant (voir le [README](../README.md#administration-phase-4b)).

## Points ouverts avant une mise en ligne

1. Passer les corrections prévues avant la fusion des phases 3d, 4a et 4b partie 1 (voir leurs suivis), après la relecture finale de la branche.
2. Essayer les phases 3b, 3c et 3d sur les vrais sites, avec les listes des suivis.
3. Relever la valeur réelle de `sellerType` pour un professionnel sur 2ememain.
4. Lancer `pnpm e2e:scan` contre OpenRouter (le fournisseur de production), avec Gemini : sortie stricte et outils ensemble, réflexion recopiée d'un tour à l'autre, flux derrière Caddy.
5. Vérifier SearXNG sur le serveur de production (substitution de `SEARXNG_SECRET`, moteurs qui répondent).
6. Vérifier la langue des titres de réflexion : `gpt-6-luna` les donne en anglais malgré la consigne.
7. Publier `/privacy` : la phase 4a est faite (`DELETE /api/me`, purge à 12 mois, textes à jour). Reste à confirmer l'adresse `privacy@mostconsult.be` et à vérifier la rétention des sauvegardes distantes.
8. Essayer la suppression du compte et la purge sur la vraie pile (voir le [suivi 4a](superpowers/plans/2026-10-20-phase-4a-suivi.md)).
9. Préparer les déclarations du Chrome Web Store (liste dans le suivi 4a).
10. Essayer l'admin (partie 1) sur la vraie pile, avec les vérifications du [suivi 4b partie 1](superpowers/plans/2026-10-21-phase-4b-partie-1-suivi.md) : connexion par lien et par code, essais du modèle et de la recherche, en-têtes de Caddy, présence de `scripts/` dans l'image auth.
11. Faire la partie 2 de la phase 4b : Tableau de bord, Offre (dont `/pricing`) et Analyses.
12. Faire la passe de design.
