# Phase 1 — Points de suivi

Remarques mineures relevées pendant les relectures de la phase 1, non bloquantes pour la fusion. Elles sont triées par la relecture finale de la branche. Les points déjà corrigés dans la vague finale ne figurent pas ici.

## Avant la phase 2 (scripts de contenu sur les marketplaces)

- **Extension, `handleExternal`** : exiger le chemin `/auth/callback` et la frame principale. Aujourd'hui, seule l'origine est vérifiée.
- **Extension** : la messagerie des scripts de contenu est refusée par le filtre d'expéditeur (`forbidden_sender`). Il faudra une liste blanche dédiée, sans jamais exposer les messages `auth/*` aux pages web.
- **Extension, `onUnauthenticated`** : n'effacer le jeton que s'il n'a pas changé entre-temps (compare-and-clear), pour ne pas écraser une session plus récente.
- **Extension** : ajouter des délais (`AbortSignal.timeout`) aux appels réseau. La déconnexion attend la réponse distante avant d'effacer la session locale.

## Avant le premier déploiement en production

- **Sauvegardes** :
  - un envoi `rclone` qui échoue n'est jamais retenté ;
  - les fichiers `.partial` ne sont purgés qu'après un envoi réussi ;
  - aucune alerte n'existe, les échecs ne sont visibles que dans `docker compose logs backup`.
- **Restauration (README)** : l'étape (a) suppose que le service `backup` tourne. Ajouter `set -e` ou un `|| exit` après la vérification du fichier déchiffré.
- **Chrome Web Store** : vérifier si la clé `key` du manifeste doit être retirée du paquet envoyé.
- **Rotation de `BETTER_AUTH_SECRET`** : ce secret chiffre aussi la clé privée JWKS stockée. Le changer casse `/auth/token` tant que la ligne `auth.jwks` n'est pas régénérée. À documenter.

## Avant la phase 3 (limites de requêtes côté API)

- Utiliser l'IP client transmise par Caddy. `FORWARDED_ALLOW_IPS=*` est déjà en place.
- Harmoniser les réponses 404, 405 et 500 de FastAPI, qui gardent le format `{"detail"}` au lieu de l'enveloppe `{"error"}`.

## Peut attendre

- **API** :
  - `async_sessionmaker` est recréé à chaque requête ;
  - le mode Alembic hors ligne (`--sql`) ne fonctionne pas ;
  - le schéma `app.` est écrit en dur dans les clés étrangères de l'ORM ;
  - les dates sans fuseau horaire sont acceptées par `current_period_start` ;
  - le contrôle du rôle compare la valeur exacte `'admin'` ;
  - un INSERT sans effet est lancé à chaque `/api/me` pour les utilisateurs sans abonnement actif ;
  - il manque une marge pour les décalages d'horloge sur `exp`/`iat`, et les clés JWKS ne sont pas filtrées sur Ed25519.
- **Auth** :
  - un faux message d'erreur « schema mismatch » s'affiche au premier démarrage ;
  - le helper de test utilise l'API interne `auth.$context.checkSchema` ;
  - `parseSignInEmail` est dupliqué ;
  - l'arrêt du serveur n'a pas de sortie forcée ;
  - `import.meta.main` exige Node ≥ 24.2 ;
  - il manque des tests pour `Origin: null` ;
  - `/send-verification-email` et `/request-password-reset` pourraient être ajoutés à `disabledPaths`, par précaution.
- **Site** :
  - le code qui relie la page à `chrome.runtime` n'est pas testé ;
  - pas de `<noscript>` ;
  - le texte français s'affiche brièvement pour les utilisateurs NL ;
  - une erreur réseau affiche le message « lien expiré ».
- **Popup** :
  - `<html lang>` est figé ;
  - il manque `aria-describedby`/`aria-invalid` sur les champs ;
  - la langue clignote au chargement ;
  - `auth/state` est appelé deux fois après la vérification du code ;
  - le quota photos à 0 est affiché pour le plan Standard (décision produit) ;
  - certains tests manquent (`auth_unavailable`, jeton effacé, démontage).
- **Outillage** :
  - avertissement de dépendance pair entre `openapi-typescript` et TypeScript 6 ;
  - `gen-api.sh` écrit directement dans `openapi.json` sans fichier temporaire ;
  - `uv run` est lancé sans `--locked` ;
  - pas de script `typecheck` racine ;
  - le script e2e n'a pas de délais et affiche les corps de réponse en cas d'échec ;
  - `VITE_EXTENSION_ID` duplique `EXTENSION_ID`.
- **Infra** :
  - images de base en tags flottants ;
  - les images sont construites deux fois (`migrate`/`auth`, `migrate-api`/`api`) ;
  - le cache de couches de l'image Caddy est mal ordonné ;
  - le dossier `test/` est inclus dans l'image auth ;
  - les chemins Linux (`host-gateway`, `--host 0.0.0.0`) ne sont pas testés ;
  - le spec §11 liste encore `BETTER_AUTH_URL`.

## Décisions prises pendant l'exécution

- **Erreur `503 auth_unavailable`** : l'API la renvoie quand le JWKS est injoignable, et l'extension ne déconnecte jamais l'utilisateur sur une erreur 5xx.
- **Envoi d'emails** : `/auth/start` est la seule route qui en envoie. Les routes d'envoi de Better Auth sont désactivées.
- **Limites de `/auth/start`** : 20 requêtes par IP et par 15 minutes, puis 5 par email et par 15 minutes.
- **Popup** : la demande de connexion en cours est conservée dans `storage.session` pendant 10 minutes.
- **Route `/api/internal/*`** : Caddy la bloque (404). Elle n'est accessible que depuis le réseau Docker.
- **Secrets `change-me…`** : ils sont refusés en production par les deux services.
