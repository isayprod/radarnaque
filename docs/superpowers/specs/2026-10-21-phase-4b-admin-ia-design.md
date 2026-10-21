# Admin — IA

*Spec du 21 octobre 2026*, partie de la phase 4b (voir le [socle](2026-10-21-phase-4b-admin-socle-design.md)).

## 1. Rôle

Piloter l'IA sans ligne de commande. On change le modèle actif, on ajoute un modèle, on crée et active une version du prompt, et on règle le cache, la limite de requêtes et la recherche web. Aujourd'hui, ces réglages demandent `radarnaque-llm` ou une migration.

## 2. Modèles

- **Liste des modèles** (`app.models`) : fournisseur, slug et nombre d'analyses produites.
- **Fournisseurs :** ce sont les entrées de `services/api/providers.toml`, en lecture seule. On affiche pour chacun :
  - l'API (`chat` ou `responses`) ;
  - le mode de sortie (`json_schema` ou `json_object`) ;
  - `reasoning_effort` et `max_images` ;
  - la présence de la clé dans l'environnement (« clé présente » ou « clé absente »), jamais sa valeur.
- **Ajouter un modèle :** un fournisseur choisi dans la liste de `providers.toml` et un slug (1 à 200 caractères, sans espace). Le couple est unique (`409` sinon). Action journalisée `ai.model_added`.
- **Modèle actif** du type `full` (`scan_kinds.active_model_id`) : un menu, puis une confirmation. Le cache des analyses est lié au modèle : changer de modèle relance des analyses neuves, et les résultats de l'ancien modèle restent en base. Action journalisée `ai.model_activated`.
- **Essai du modèle :** le bouton « Tester » envoie une petite annonce fictive fixe au modèle choisi, avec le prompt actif, sans recherche web ni photo, hors quota et hors cache. Il affiche le score, la durée, les tokens et la réponse brute. Le but est de vérifier un modèle avant de l'activer. Un fournisseur sans clé donne l'erreur `configuration` sans appel réseau.

## 3. Prompts

- **Liste des versions du type `full`** : numéro, date, version active, nombre d'analyses produites.
- **Consultation :** le texte complet, en lecture seule.
- **Nouvelle version :** elle part du texte de la version active, dans un éditeur de texte brut. Elle prend le numéro suivant et n'est pas active à sa création. Le texte fait entre 200 et 20 000 caractères. Action journalisée `ai.prompt_created`, avec le numéro seulement.
- **Activation :** confirmation, puis `scan_kinds.active_prompt_version_id`. Comme pour le modèle, le cache repart, puisqu'il est lié à la version. Action journalisée `ai.prompt_activated`.
- **Immuabilité :** une version existante ne se modifie jamais (règle des phases 3c et 3d). Pour corriger, on crée une nouvelle version.
- **Rappel affiché sous l'éditeur :** la réponse doit rester au format JSON attendu, car le schéma est ajouté par le serveur en mode `json_object`.

## 4. Réglages (`app.settings`)

| Réglage | Bornes | Effet |
|---|---|---|
| `cache_ttl_hours` | de 1 à 168 | durée du cache partagé des analyses |
| `rate_limit_per_minute` | de 1 à 600 | limite de scans par utilisateur et par minute |
| `max_web_searches` | de 0 à 5 (CHECK) | recherches web par analyse ; 0 désactive la recherche |

- Un formulaire, une confirmation, puis l'action journalisée `ai.settings_set` avec `{ field, from, to }`.
- La page `/privacy` affiche « jusqu'à 3 recherches » : quand `max_web_searches` change, un avertissement rappelle de mettre la page à jour (décision R9 de la phase 4a).

## 5. Recherche web

- **État du moteur :** `SEARCH_BACKEND`, l'URL de SearXNG (sans identifiants), sa disponibilité (même vérification que le tableau de bord) et la taille du cache des recherches.
- **Essai :** le bouton « Tester une recherche » envoie une requête libre au moteur et affiche les résultats tels qu'ils sont renvoyés au modèle (`format_hits`), contacts masqués. La requête n'est pas journalisée.

## 6. API

- `GET /api/admin/ai` : modèles, fournisseurs, modèle et prompt actifs, versions de prompt (sans leur texte), réglages, état du moteur, 20 dernières actions IA.
- `POST /api/admin/ai/models` `{ provider, slug }` : ajoute un modèle.
- `POST /api/admin/ai/active-model` `{ modelId }` : active un modèle.
- `POST /api/admin/ai/models/{id}/test` : teste un modèle. Limité à 10 par heure et par admin.
- `GET /api/admin/ai/prompts/{id}` : le texte d'une version.
- `POST /api/admin/ai/prompts` `{ systemPrompt }` : crée une version.
- `POST /api/admin/ai/prompts/{id}/activate` : active une version.
- `PATCH /api/admin/ai/settings` `{ cacheTtlHours?, rateLimitPerMinute?, maxWebSearches? }` : modifie les réglages.
- `POST /api/admin/ai/search-test` `{ query }` : teste une recherche. Limité à 30 par heure et par admin.

## 7. Tests

- **Ajout de modèle :**
  - fournisseur inconnu de `providers.toml` donne `422` ;
  - doublon donne `409` ;
  - journal écrit.
- **Activation :**
  - le scan suivant utilise le nouveau modèle ;
  - le cache n'est pas servi pour l'ancien modèle ;
  - journal écrit.
- **Essai du modèle :**
  - faux client LLM appelé avec l'annonce fixe ;
  - pas de `scan_events` ;
  - limite de 10 par heure ;
  - fournisseur sans clé donne `configuration`.
- **Prompts :**
  - le numéro suit ;
  - la version créée n'est pas active ;
  - activation journalisée ;
  - texte hors bornes donne `422` ;
  - aucune route ne modifie une version existante.
- **Réglages :** bornes, effet sur le scan suivant (`max_web_searches = 0` : aucun outil proposé), journal.
- **Fournisseurs :** la valeur de la clé n'apparaît jamais dans la réponse, seulement sa présence.
- **Essai de recherche :** contacts masqués, limite de 30 par heure, moteur désactivé donne un message clair.
- **Interface :** confirmations, éditeur de prompt, résultats des essais.
