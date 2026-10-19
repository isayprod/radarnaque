# Phase 3d — Points de suivi

Remarques relevées pendant les relectures de la phase 3d : recherche web, photos obligatoires, un seul type d'analyse, réflexion et flux en direct. Elles sont triées par échéance ; les points déjà corrigés n'y figurent pas.

## Corrections prévues avant fusion

Ces points ont été relevés en relecture de tâche et laissés pour une vague de corrections, après la relecture finale de la branche. Ceux que la vague finale a corrigés n'y figurent plus.

- **Annulation reconnue par un code partagé (T11) :** le code « cancelled » est aussi celui des codes du port. Piste : un indicateur local plus robuste.
- **Cohérence de la branche (T10) :** vérifier à la relecture finale que `tsc` est vert et qu'il ne reste ni `scanKind` ni `entries[kind]` côté extension.

## Déjà vérifié en direct (19 octobre 2026)

- **`openai-oauth` et `gpt-6-luna`, SearXNG réel, API et base de dev :** `pnpm e2e:scan` en flux donne `E2E SCAN OK` (score 62). Premier scan : 7 événements (un `analyzing`, une recherche `price` avec 5 résultats, deux titres de réflexion, `writing`, `result`) en 8,9 s ; second scan servi du cache : 2 événements (`cache`, `result`).
- **iPhone 18 Pro, via le client LLM de la branche** (contrôleur, `openai-oauth` et `gpt-6-luna`, prompt `full` v1, **faux moteur de recherche** renvoyant apple.com et tweakers.net) : l'annonce « iPhone 18 Pro 256 Go neuf scellé » à 450 € (envoi uniquement, virement, compte de moins d'un mois, 0 photo) a été essayée deux fois, avec le même faux moteur (apple.com, tweakers.net, « à partir de 1 329 € »). Essai 1, après la tâche 5 : une recherche `price`, 2 résultats, réflexion, rédaction, 2 tours, 7,7 s, score 85, résumé « l'iPhone récent est annoncé neuf et scellé à un prix très inférieur au prix neuf ». Essai 2, après la tâche 6 : 2 tours, 10,6 s, score 90, résumé « l'iPhone 18 Pro neuf scellé est proposé à 450 €, très loin des prix neufs observés ». Le modèle est reconnu dans les deux cas.
- **Reste à faire :** la même annonce sur la vraie pile (SearXNG réel, pastille dans le navigateur). L'annonce du script `e2e:scan` est un vélo de course (le script n'accepte pas d'annonce). Les titres de réflexion sont de nouveau arrivés en anglais (« Assessing bike listing »).

## À vérifier en direct avant la mise en ligne

Rien de ceci n'a pu être essayé : `infra/.env` n'a ni clé Groq ni clé OpenRouter, et les fournisseurs concernés ne tournent pas en local.

- **OpenRouter et Gemini (`google/gemini-3.1-flash-lite`) :**
  - `json_schema` strict **et** `tools` dans la même requête : le modèle l'accepte-t-il ?
  - `parameters()` brut de l'outil (`additionalProperties`, `maxLength`) : Gemini rejette-t-il ces mots-clés ?
  - `reasoning_details` recopiés d'un tour à l'autre : le tour 2 les accepte-t-il ?
  - résumés de réflexion (`delta.reasoning`) bien reçus en flux ;
  - coût relevé (`usage.cost`) en flux.
- **Groq :** `json_object` avec le flux et les `tools` ; au plus 3 photos ; réponse finale valide.
- **Ollama :** `stream_options` (`include_usage`) accepté par la version installée.
- **Derrière Caddy :** le flux arrive-t-il événement par événement (`flush_interval -1` sur `/api/scans/stream`) ? Les pings de 15 s tiennent-ils jusqu'à 180 s ?
- **SearXNG :**
  - la substitution de `${SEARXNG_SECRET}` dans `infra/searxng/settings.yml` n'est pas vérifiée (SearXNG lit aussi la variable d'environnement, qui prime) ;
  - les moteurs (Brave, DuckDuckGo, Bing, Qwant, Startpage, Wikipédia) répondent-ils depuis le serveur de production, sans blocage ni captcha ? Une recherche vide n'est pas mise en cache (R5).
- **Langue des titres de réflexion :** avec `gpt-6-luna`, les titres de réflexion sont arrivés **en anglais** malgré « Réfléchis en français » dans le prompt (constat du contrôleur à la tâche 5). À vérifier avec les autres modèles. Si cela persiste, deux pistes : traduire côté extension, ou accepter l'anglais du modèle (le texte reste celui du modèle, spec §10.2).
- **Sur les vrais sites :** la pastille en direct, les cartes et le déroulé n'ont été essayés qu'en tests. Vérifier sur 2ememain, 2dehands et Facebook :
  - le bouton « Analyser avec l'IA » dans la pastille ;
  - la ligne d'état (texte, fondu, points de suspension après 4 s, `aria-live`) ;
  - l'icône qui tourne sur une carte ;
  - la navigation vers une autre annonce pendant l'analyse (Facebook, sans rechargement) ;
  - le service worker tué en cours d'analyse (« Analyse interrompue »).
- **Version d'uvicorn et de Starlette :** aucune borne nécessaire. Le rendu d'un scan jamais servi ne dépend plus de la version d'ASGI annoncée par le serveur (sous-classe de `StreamingResponse` avec `try/finally` sous `shield`, testée en 2.3 et 2.4). À revoir seulement si Starlette change `StreamingResponse.__call__`.
- **Prompt `full` v1 sur 10 à 20 annonces réelles :** les scores, l'usage des recherches (pas de recherche inutile, pas d'invention du prix), le comportement sans photo et avec 1 photo (Standard).

## Plus tard

- **Prompt `full` v1 :** deux sections « Photos » (celle d'`IMAGE_V2` et celle ajoutée par `SEARCH_V1`). Cosmétique ; à fusionner dans un `full` v2.
- **Migration 0005 :**
  - pas de test d'insertion ni de cascade sur `analysis_web_searches` ;
  - pas de test de la branche « une analyse référence le prompt `full` » du retour arrière ;
  - le retour arrière remet les valeurs de la 0001 (non documenté dans la docstring).
- **Tests de l'API :**
  - pas de test direct de `plan_max_images` (superuser avec un abonnement réel, plan absent, admin avec Standard) ;
  - pas de test de libération du verrou après déconnexion ou délai, ni de 403 et 429 sur le flux ;
  - `search=None` par défaut est silencieux, et `_scan_args` est un `dict[str, Any]` ;
  - finitions de la tâche 3 : docstring de `LLMResult`, assertion dupliquée, comparaison de `input_hash` (1 et 0), introspection par `co_varnames` dans `test_hashing.py`, docstring de `Privileges.all_features` (« photos ») ;
  - `test_prompt_v2.py` : virgules finales disgracieuses.
- **Flux et boucle d'outils :**
  - la clé d'une partie de réflexion est `(item_id, summary_index)`, sans numéro de tour ;
  - un `Writing` peut partir sur un préambule avant un `function_call` ;
  - appels d'outils sans `index` : appels parallèles fusionnés (pas le cas d'OpenRouter) ; pas de test d'appels entrelacés ;
  - le coût OmniRoute vaut 0 en flux ;
  - `asyncio.timeout` d'un tour englobe les `await` du récepteur : il doit rester non bloquant (`put_nowait`) ;
  - le `__all__` de `llm/client.py` ne sert qu'à taire F401 (réexport de `SearchRecord`), et `tools.py` garde un `type: ignore[arg-type]` sur `aspect` ;
  - pour un appel d'outil, `id` et `name` gardent la dernière valeur non vide reçue (voie Chat).
- **SearXNG et Docker :**
  - le `SEARXNG_SECRET` d'exemple est accepté en production ;
  - le port 8888 n'est pas vérifié par `check-ports`, et `up -d` n'attend pas la santé (`--wait`) ;
  - durcissement du conteneur : `cap_drop`, `read_only`, `mem_limit` ;
  - délai de 8 s par phase `httpx`, pas total, et corps non borné (SearXNG est interne) ; le délai total de l'analyse couvre le reste ;
  - éviction FIFO du cache de recherches (conforme au spec) ; tests manquants pour une entité coupée et pour « & » dans un titre.
- **Extension :**
  - `ApiClient.scan` est gardé mais n'est plus utilisé ;
  - les codes de refus avant le flux n'ont pas de regex `ERROR_CODE` ; une `error` du flux au code invalide donne `stream_interrupted` ;
  - tests manquants : popup acceptée, déconnexion avant le départ, port sans message qui finit en `timeout`, `defaultConnect` ;
  - `lastError` n'est pas lu dans `onDisconnect` ;
  - un `data:` vide est rendu comme un événement ; `scan-port.ts` écrit `void debug.group(…)` dans la minuterie, et le commentaire du délai est séparé de son `setTimeout` ;
  - un `*` isolé (italique) n'est pas traité dans `thinkingTitle`, et `Intl.PluralRules` est recréé à chaque appel ;
  - le lien « noSubscription » s'appelle « Analyser avec l'IA » sans mention des formules ;
  - `useLaunch` repose sur l'identité d'objet (`loadAccess` en promesse serait plus sûr) et une course clic et adoption du magasin reste possible ;
  - le déroulé n'a pas de défilement automatique (voulu) ; la fin d'une analyse n'est pas annoncée aux lecteurs d'écran, et il n'y a pas d'`aria-busy`.
- **Reprise d'un résultat 24 h après un changement de prompt :** comme en 3c, un résultat gardé dans le navigateur reste affiché même si le prompt a changé.
- **Hors de la phase (spec §13) :** Brave Search et Tavily (l'interface `SearchBackend` est prête), recherche par image inversée, texte de réflexion gardé en base, analyse IA automatique.

## Décisions prises pendant l'exécution

- **R1. Champ `count` de l'événement `stage` :** il porte toujours `count` (photos à télécharger pour `photos`, photos envoyées pour `analyzing`). Le spec écrivait `images` pour `analyzing` ; il est corrigé. Un seul nom de champ côté API et côté extension. Coût si c'est faux : renommer un champ.
- **R2. Trailer des commits :** les commits des sous-agents portent le trailer de leur modèle réel (Sonnet 5.5, Opus 5.5…), pas toujours « Opus 5.5 ». Attribution exacte, pas de réécriture d'historique. Coût si c'est faux : un `amend` des messages avant tout envoi.
- **R3. `today` en date d'Europe/Brussels :** pas en UTC. Le spec vise un acheteur belge, et la veille entre 0 h et 2 h fausserait « récent ». Coût si c'est faux : une ligne.
- **R4. Anciens scans `text` et `image` :** ceux de la période en cours ne comptent pas dans le quota `full`. Rien n'est publié, seuls des comptes de dev existent. Coût si c'est faux : un abonné réel repartirait à plein quota au déploiement.
- **R5. Recherches sans résultat :** une recherche qui ne donne aucun résultat n'est pas mise en cache. SearXNG renvoie `[]` quand l'amont est bloqué : ne pas figer cela 24 h. Coût si c'est faux : quelques appels SearXNG de plus.
- **R6. URL de résultats :** celles qui contiennent une espace ou un caractère de contrôle, ou de plus de 300 caractères, sont écartées. Le bloc reste homogène et non forgeable. Coût si c'est faux : quelques résultats légitimes perdus.
- **R7. Identifiants des éléments recopiés sous `store=false` :** ils sont gardés (API Responses). L'essai réel via `openai-oauth` et `gpt-6-luna` a réussi en 2 tours avec eux. Coût si c'est faux : un 4xx au tour 2 sur un autre fournisseur Responses ; retirer `id` est alors une ligne.
- **R8. `try` de `_responses_round` :** il est restreint à la lecture du flux. Une erreur du récepteur n'est pas une réponse invalide. Coût si c'est faux : aucun.
- **R9. Une seule reprise par analyse :** pour toute l'analyse, pas par tour. Borne : `max_searches + 3` requêtes et budget de 180 s. Coût si c'est faux : une réponse finale invalide non reprise après une reprise de transport déjà consommée.
- **R10. Recherches gardées :** `searches` et `analysis_web_searches` ne gardent que les recherches réussies. L'utilisateur voit les échecs en direct ; seules les recherches utiles sont rappelées depuis le cache. Coût si c'est faux : une recherche en échec absente du déroulé d'un résultat servi depuis le cache.
- **R11. `Thinking.part` :** c'est un compteur croissant par analyse (une partie neuve par appel), pas « le numéro du tour ». Cohérent avec `events.py` et la voie Responses. Coût si c'est faux : aucun côté extension, la partie ne sert qu'à regrouper.
- **R12. Annulation après `cancel()` :** `done` se résout avec le code « cancelled », ignoré par la tâche 11. Sans cela, la promesse restait en attente pour toujours. Coût si c'est faux : un code à renommer.
- **R13. Finitions de la pastille (T10) :** requêtes resserrées, « 0 résultat » au singulier, « overig » en néerlandais, gabarits testés. Coût si c'est faux : aucun.
- **R14. Texte du bouton grisé :** « Plus d'analyses IA disponibles », sans « ce mois-ci » : l'essai a un plafond total, pas mensuel. Coût si c'est faux : un texte.
- **R15. Quota épuisé et accessibilité :** `quota_exhausted` s'affiche sans « de ce type » ; le bouton épuisé est en `aria-disabled` avec `aria-describedby` (focusable) ; le déroulé ne répète pas son titre ; `BadgeActions.tsx` est extrait. Coût si c'est faux : aucun.
- **R16. Session expirée :** le bouton de lancement reste (son clic ouvre la connexion, spec §10.2) au lieu de disparaître. Coût si c'est faux : une condition.
- **R17. Superuser en Premium, hors production :** plan `premium`, fonctionnalités du plan, 4 photos, sans quota. En production, ce traitement ne s'applique pas. Coût si c'est faux : un test de dev à ajuster.
