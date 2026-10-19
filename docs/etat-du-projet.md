# Radarnaque v4 — État du projet

*Au 19 octobre 2026.* Ce document résume ce qui a été construit, où le trouver, et ce qu'il reste à faire.

Les autres documents :
- le démarrage pas à pas est dans le [README](../README.md) ;
- la conception complète est dans le [spec](superpowers/specs/2026-10-16-radarnaque-v4-design.md) ;
- chaque phase a son plan et sa liste de points de suivi dans [`superpowers/plans/`](superpowers/plans/).

## En une phrase

Radarnaque est une extension Chrome, Edge et Brave qui signale les annonces suspectes sur 2ememain.be, 2dehands.be et Facebook Marketplace :
- un score local gratuit, sans compte et illimité, pour tout le monde ;
- une analyse IA, au clic, pour les comptes connectés : essai de 3 scans, puis abonnement Standard ou Premium.

## Où en sont les branches

| Phase | Contenu | Branche | État |
|---|---|---|---|
| 1 | Fondations et connexion (lien magique et code à 6 chiffres) | `main` | fusionnée |
| 2 | Adaptateurs des sites et règles locales | `main` | fusionnée |
| 3a | Serveur des analyses IA (fournisseurs LLM, quotas, cache, photos) | `main` | fusionnée |
| 3b | Analyses IA dans l'extension (panneau, icônes sur les cartes) | `feat/phase-3b` | terminée, non poussée |
| 3c | L'IA remplace l'analyse locale, prompt v2, annonces professionnelles | `feat/phase-3c` (au-dessus de 3b) | terminée, non poussée |
| — | Superuser de développement (logs de debug, relance sans cache) | `feat/superuser-debug` (au-dessus de 3c) | terminée, non poussée |
| 4 | Administration, suppression du compte, purge à 12 mois | — | à faire |
| 5 | Paiement Stripe | — | à faire (les routes répondent 501) |
| — | Passe de design (identité visuelle, maquettes) | — | à faire en dernier |

Les phases 3b et 3c n'ont pas encore été essayées sur les vrais sites. Les vérifications à faire sont listées dans les suivis [3b](superpowers/plans/2026-10-18-phase-3b-suivi.md) et [3c](superpowers/plans/2026-10-18-phase-3c-suivi.md).

## Architecture

```
Extension (WXT, React)  ──►  Caddy (une seule origine)  ──►  auth  (Better Auth, Node/Hono, :3000)
   content scripts                /auth/*                         sessions, JWT EdDSA, admin
   service worker                 /api/*        ──►  api   (FastAPI, Python 3.13, :8000)
   popup                          /auth/callback ─►  site  (Vite statique)
                                                         │
                                                  PostgreSQL (schéma auth + schéma app en 3NF)
                                                         │
                                                  Fournisseur LLM (OpenRouter en prod)
```

- **Dépôt public :** https://github.com/isayprod/radarnaque. Le monorepo utilise pnpm (`apps/extension`, `apps/site`, `services/auth`, `packages/shared`) et uv (`services/api`).
- **Hébergement prévu :** un serveur en Allemagne, avec le domaine `radarnaque.mostconsult.be`. Les emails partent par Resend.
- **En dev :** Caddy écoute sur `http://localhost:8080`, Postgres sur le port 5433, l'auth sur 3000, l'API sur 8000 et le serveur WXT sur 3100. `pnpm dev` lance tout.

## Ce qui fonctionne

### Comptes et connexion (phase 1)
- **Connexion sans mot de passe :** l'email envoyé contient à la fois un lien magique et un code à 6 chiffres, utile si l'email est ouvert sur un autre appareil. Une seule route envoie l'email : `/auth/start`.
- **Limites :** 20 demandes par IP, puis 5 par email, toutes les 15 minutes.
- **JWT :** l'auth émet des JWT EdDSA de 15 minutes. L'API les vérifie avec la clé publique (JWKS) et répond 503 si celle-ci est indisponible.
- **Essai :** à la première connexion, l'utilisateur reçoit un essai de 3 scans.
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

### Analyses IA, côté serveur (phases 3a et 3c)
- **Routes :** `POST /api/scans`, `GET /api/scans/history` et `GET /api/me`. Les routes `/api/billing/*` répondent 501.
- **Déroulé d'un scan :**
  1. limite de requêtes ;
  2. vérification des droits du plan ;
  3. validation de l'annonce ;
  4. réservation du quota (verrou `FOR UPDATE`) ;
  5. cache partagé de 24 h, avec un verrou pour qu'une même annonce ne déclenche qu'un seul appel au LLM ;
  6. en cas d'échec, le scan est rendu à l'utilisateur.
- **Vie privée :** l'identité du vendeur est refusée à l'entrée. Les téléphones et les emails sont masqués avant l'envoi au LLM.
- **Photos :** elles ne sont téléchargées que depuis les CDN des sites, jamais depuis une adresse interne. Au plus 4 photos, de 5 Mo et 768 px.
- **Fournisseurs LLM :** ils sont décrits dans `services/api/providers.toml` (OpenRouter, Groq, openai-oauth, OmniRoute, Ollama et un faux fournisseur). La commande `radarnaque-llm use …` change de fournisseur ou de modèle.
- **Prompt v2 (phase 3c) :** il est fondé sur la [recherche sur les arnaques](superpowers/research/2026-10-18-arnaques-acheteurs.md). Il tient compte :
  - du taux de base, faible ;
  - du risque par catégorie ;
  - de l'écart avec le prix du marché ;
  - des signaux forts et des non-signaux ;
  - des annonces de professionnels (champ `professional`) ;
  - d'un conseil adapté à la catégorie.

### Analyses IA, dans l'extension (phases 3b et 3c)
- **Sur une annonce :** le panneau propose « Lancer une analyse IA » et, si le plan le permet, « Analyse avec photos ». Le résultat, en FR ou NL, **remplace** l'analyse locale : la pastille affiche alors le score IA avec la mention « IA ».
- **Sur une page de résultats :** une icône « R » apparaît sur chaque carte pour les comptes essai, Premium et admin. Au clic, la carte est analysée sans ouvrir l'annonce.
- **Conservation :** le résultat est gardé 24 h dans le navigateur. La déconnexion l'efface, et un changement de l'annonce le rend caduc.
- **Bandeau « annonce professionnelle » :** il signale un magasin qui utilise l'annonce comme vitrine. Il ne cache jamais le score.
- **Sécurité :**
  - les content scripts ne peuvent envoyer que trois messages au service worker ;
  - le service worker est le seul à détenir la session et le JWT.

### Superuser de développement
- **Rôle `superuser`, réservé au développement :** aucun quota ni limite de requêtes, toutes les fonctionnalités. Il s'attribue avec `DEV_SUPERUSER_EMAIL` (`infra/.env`) ou `pnpm dev:superuser <email>`. L'API l'ignore en production.
- **Logs de debug :** console de l'API (`[debug superuser]`), console de la page et du service worker (« Radarnaque debug »), section « Debug (superuser) » du panneau.
- **« Relancer sans cache » :** force un nouvel appel au modèle et rafraîchit l'analyse partagée.
- Voir le [README](../README.md#superuser-de-développement).

### Site
- La page `/auth/callback` reçoit la connexion par lien magique.
- Les pages `/pricing` et `/privacy` existent en FR et NL. `/privacy` ne doit pas être publiée avant la phase 4.

## Offre

| Plan | Prix | Analyses texte | Analyses photos | Icônes sur les cartes |
|---|---|---|---|---|
| Essai | gratuit | 3 au total, texte et photos confondus | incluses | oui |
| Standard | 2,99 €/mois ou 29 €/an | 150 par mois | non | non |
| Premium | 6,99 €/mois ou 69 €/an | 1 000 par mois | 100 par mois | oui |

## Tests

| Partie | Tests | Commande |
|---|---|---|
| API | 528 | `pnpm test:api` |
| Extension | 852 | `pnpm --filter extension test` |
| Site | 39 | `pnpm --filter site test` |
| Scripts | 14 | `pnpm test:scripts` |
| Bout en bout | connexion et scan | `pnpm e2e:login`, `pnpm e2e:scan` |

À chaque phase :
- une relecture par tâche ;
- une relecture complète de la branche ;
- un contrôle de l'historique Git contre une liste locale de données personnelles, avant tout envoi.

## Pour développer

- **Démarrer :** `pnpm dev` lance Postgres, Caddy, l'auth, l'API, le site et l'extension (voir le [README](../README.md)).
- **IA gratuite en dev :**
  - **Groq**, avec une clé gratuite à mettre dans `GROQ_API_KEY` ;
  - **ton abonnement ChatGPT**, via `npx openai-oauth`, avec le modèle `gpt-6-luna`.
- **Base de dev :** l'API applique les migrations au démarrage (`pnpm dev:api`).

## Points ouverts avant une mise en ligne

1. Essayer les phases 3b et 3c sur les vrais sites, avec les listes des suivis.
2. Relever la valeur réelle de `sellerType` pour un professionnel sur 2ememain.
3. Lancer `pnpm e2e:scan` contre OpenRouter (le fournisseur de production).
4. Faire la phase 4 : `DELETE /api/me`, la purge à 12 mois et l'admin. C'est la condition pour publier `/privacy`.
5. Confirmer l'adresse `privacy@mostconsult.be`.
6. Faire la passe de design.
