# Phase 3a — Points de suivi

Remarques relevées pendant les relectures de la phase 3a (serveur des analyses IA). Aucune ne bloque la fusion. Elles sont triées par échéance. Les points déjà corrigés n'y figurent pas.

## À intégrer au brief de la phase 3b (extension)

Les points sur les bornes d'entrée, le scan photos, `remaining.*`, l'enveloppe d'erreur et l'identité du vendeur sont traités par la phase 3b (voir « Décisions prises pendant l'exécution »). Reste ouvert :

- **Historique** : `score`, `level`, `site` et `title` valent `null` pour un scan sans résultat. Un scan sans score et sans `failed` est « en cours ou inconnu ». C'est aussi le cas, pour toujours, d'un scan dont le serveur est mort en pleine analyse. La phase 3b n'affiche pas l'historique : à prendre en compte quand une page ou la popup le montrera.
- **OpenAPI** : les 422 sont encore décrits avec le schéma FastAPI par défaut, `HTTPValidationError`, alors que le serveur répond avec l'enveloppe `ApiErrorBody`. Ne pas s'y fier tant que ce n'est pas corrigé.

## Avant la mise en ligne

- **Test réel contre OpenRouter** : `E2E_PROVIDER=openrouter E2E_MODEL=google/gemini-2.5-flash-lite pnpm e2e:scan`. Ce test n'a tourné qu'avec le faux fournisseur, et plusieurs paramètres n'ont donc jamais été envoyés à un vrai fournisseur :
  - le schéma strict (`minimum`, `maximum`, `maxItems`) ;
  - `reasoning.enabled = false` ;
  - `usage.include`.

  Si OpenRouter les refuse, il répond 400, et toutes les analyses échouent en 502.
- **OmniRoute** : vérifier en vrai la commande Docker, le chemin Dashboard → Endpoints et l'en-tête de coût `X-OmniRoute-Response-Cost`.
- **Page `/privacy`** : ne pas la publier, ni la citer dans le Chrome Web Store, avant la phase 4. `DELETE /api/me` et la purge à 12 mois n'existent pas encore.
- **Textes FR/NL de `/privacy`** : ce sont des reformulations du spec §10, pas un avis juridique. Il manque le responsable du traitement et la base légale.
- **Contact de confidentialité** : faire confirmer l'adresse `privacy@mostconsult.be` par l'utilisateur (constante `PRIVACY_EMAIL` dans `apps/site/src/pages-i18n.ts`).

## Phase 4

- **Réconciliation des scans orphelins** : un `scan_event` de plus de N minutes sans `scan_results` ni `scan_failures` doit recevoir `scan_failures('orphaned')`, dans la tâche planifiée quotidienne du §10. Trois cas laissent un tel scan aujourd'hui :
  - l'enregistrement du remboursement échoue lui-même (base saturée ou indisponible). Il est seulement signalé par une ligne ERROR `remboursement impossible pour scan_event_id=…` ;
  - une annulation survient entre la réservation du quota et le début de l'analyse ;
  - `_result` échoue après l'enregistrement du résultat. Le scan est alors compté, et l'analyse est conservée.
- **Pillow** : le traitement tourne sur la boucle d'événements, jusqu'à 4 images de 24 Mpx. Le passer en `asyncio.to_thread`, sans `catch_warnings`, qui n'est pas sûr entre threads.
- **Index** `(user_id, id DESC)` sur `scan_events` pour la pagination de l'historique.
- **CLI `radarnaque-llm`** :
  - `create_engine` est hors du `try` : une URL mal formée affiche une trace complète ;
  - aucune commande pour supprimer un modèle. La ligne `stub/stub-model` reste en base, et l'API refuse de démarrer si `stub` est retiré de `providers.toml` alors que cette ligne existe.
- **Prompts** : `prompt_versions` n'est immuable que par convention, et `active_prompt_version_id` peut viser une version de l'autre type de scan. L'admin devra l'empêcher.
- **Paramètres entiers des signaux** : aucune borne de grandeur. Ajouter `ge`/`le`.
- **Commentaire d'en-tête de `scripts/llm-stub.mjs`** : il annonce encore `pnpm llm:stub [port]`, alors que le port 20199 est imposé.

## Phase 5 (Stripe)

- Vérifier la signature du webhook. Le corps brut est déjà conservé et plafonné à 1 Mio.
- Déclarer les réponses 501 / `billing_unavailable` dans l'OpenAPI.

## Peut attendre

- **Comptage du coût** : seuls les tokens et le coût de la tentative réussie sont comptés. Après une nouvelle tentative, le coût est légèrement sous-estimé.
- **Erreurs 404 d'un fournisseur** (modèle inconnu) : elles sont classées `transport`. `configuration` aiderait le diagnostic.
- **Regex des emails** : elle est quadratique sur une longue suite sans `@`. C'est borné par les 5 000 caractères, et l'extension a la même regex.
- **Téléchargement des photos** : il se fait une image après l'autre, soit 20 s dans le pire cas. Les formats AVIF et HEIC sont refusés.
- **Rafraîchissement d'un cache expiré** : il se fait sur place. Les anciens scans de l'historique affichent alors l'analyse rafraîchie et perdent leur mention « servi depuis le cache ». Lors d'une course, le scan qui attend peut recevoir la mauvaise mention.
- **Annulation pendant le commit final** : elle peut laisser à la fois un résultat et un échec. C'est favorable à l'utilisateur, et l'historique le gère.
- **Ordre des contrôles** : un corps qui n'est pas du JSON, envoyé sans JWT, reçoit 422 avant 401.
- **Limites de taille du corps** : Caddy limite à 1 MB (1 000 000 octets) et l'API à 1 Mio. `/auth/*` n'a aucune limite de taille, mais il a des limites de débit.
- **Liste des sites** : `ListingIn.site` est un `Literal` qui reprend la table `sites`. Ajouter un site demande donc de modifier le code et de régénérer les types.
- **DNS rebinding** : entre notre résolution et la connexion httpx, l'adresse peut changer. C'est documenté. La liste blanche des CDN reste la première défense.

## Décisions prises pendant l'exécution

- **Schémas d'entrée** : `ListingIn`, `SellerFactsIn`, `SignalIn`, `RulesIn` et `ScanIn` ont été créés avec le client LLM (tâche 3), parce que `build_messages` en dépend.
- **Erreur de paiement** : le paiement lève l'`ApiError(501, "billing_unavailable")` existant.
- **Cache expiré** : il est rafraîchi sur place, sous le verrou consultatif. Les anciens `scan_results` gardent leur pointeur.
- **Bloc de données** : les faits de l'annonce sont envoyés au LLM dans un bloc `<annonce>…</annonce>` présenté comme données non fiables, avec `<` et `>` échappés.
- **Client des photos** : il est dédié, avec `trust_env=False`, `follow_redirects=False`, et ne partage ni en-tête, ni cookie, ni authentification. Ce n'est jamais le client LLM.
- **Date d'une analyse et mention du cache** :
  - `analyses.created_at` vaut la date du `scan_event` qui l'a produite.
  - « Servi depuis le cache » se calcule : c'est vrai s'il existe un `scan_result` antérieur sur la même analyse, dont l'événement date d'après la création de l'analyse.
- **Masquage** : le titre et la description sont masqués avant le calcul de l'empreinte et l'enregistrement du snapshot, comme dans les données envoyées au LLM.
- **Remboursement** : toute erreur, y compris un bogue ou une annulation, rend le scan via `scan_failures`. Les codes enregistrés :
  - le code de `LLMError` ;
  - `image_<raison>` ;
  - `configuration` ;
  - `internal`.
- **Clé du cache** : tout fait envoyé au LLM est couvert par `content_hash` ou `input_hash`. `category`, `condition`, `postedAt` et `location` sont dans `input_hash`. Un test de garde l'impose.
- **Historique, `failed`** : un scan est en échec s'il a un `scan_failures` et aucun `scan_results`.
- **Pool de connexions** : il est dimensionné pour des transactions verrouillées d'environ 80 s (`pool_size` 10, `max_overflow` 10).
- **Bornes d'entrée** : bornes des champs envoyés au LLM et corps plafonné à 1 MB sur `/api/*` dans Caddy. Au-delà, le serveur répond `422 invalid_listing`.

  | Champ | Limite |
  |---|---|
  | `title` | 300 |
  | `description` | 5 000 |
  | `images` | 10 |
  | `category` | 200 |
  | `condition` | 100 |
  | `postedAt` | 64 |
  | `location.city`, `location.region`, `location.country` | 100 chacun |
  | `signals` | 20 |
  | `params` de chaque signal | 10 entrées, clés de 1 à 40 caractères, chaînes de 200 au plus, entiers stricts |
- **Extension, phase 3b** (faits dans `apps/extension`) :
  - **Bornes d'entrée** : `lib/scan-payload.ts` (`toScanIn`) tronque tous les champs aux limites du tableau ci-dessus, en points de code, y compris `condition` lu dans le DOM, et écarte les `params` invalides. Un titre vide donne `invalid_listing` sans appel réseau. Le client ne filtre pas encore les URL des photos (http(s), 2 083 caractères au plus) : une seule URL invalide ferait refuser tout le scan en `422`.
  - **Scan photos** : le bouton « Analyse avec photos » n'est proposé que si l'annonce a des photos et que le plan le permet (`image_scan`, ou admin).
  - **Quotas** : `remaining.* = null` (admin, ou quota absent du plan) n'affiche aucun compteur, jamais « 0 ».
  - **Erreurs** : le client API lit l'enveloppe `ApiErrorBody` ; un corps illisible donne le code `http_<statut>`. Chaque code a un message FR et NL.
  - **Identité du vendeur** : `seller.id`, `seller.name` et `seller.profileUrl` sont retirés dans `toScanIn`, le seul point de passage vers l'API.
