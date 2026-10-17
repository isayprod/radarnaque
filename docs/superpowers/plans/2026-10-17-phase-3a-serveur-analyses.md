# Phase 3a — Serveur : analyses IA, quotas, cache et fournisseurs LLM

> **Pour les agents :** sous-skill OBLIGATOIRE : utiliser superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans pour exécuter ce plan tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`) pour le suivi.

**Objectif :** `POST /api/scans` reçoit une annonce extraite par l'extension. L'API vérifie les droits et le quota, sert le cache ou appelle le LLM du fournisseur actif (OpenRouter en production, OmniRoute ou Ollama en dev), puis renvoie une analyse en FR et en NL. Le tout est testable sans l'extension, avec `curl` et un script de bout en bout.

**Architecture :**
- Le service FastAPI existant (`services/api`) reçoit une migration 0002, avec le reste du schéma 3NF.
- Les fournisseurs sont décrits dans `services/api/providers.toml` : pas de table, et aucune clé dans le fichier.
- Un seul client compatible OpenAI est paramétré par fournisseur.
- Le service de scan suit le déroulé du spec §7.2 : réservation du quota en transaction, cache par `(snapshot, modèle, version du prompt, input_hash)`, verrou consultatif pendant l'appel LLM.

**Pile technique :** Python 3.13, FastAPI, SQLAlchemy 2.1 async, Alembic, SDK `openai` 3.x (client async), Pillow 13, httpx, `tomllib` (bibliothèque standard), pytest, respx 0.23 (simulation des appels HTTP).

**Spec :** `docs/superpowers/specs/2026-10-16-radarnaque-v4-design.md`, §6.1, §6.4, §6.5, §7.1 à §7.5, §9 et §10. Le §7.3 a été mis à jour (fournisseurs dans `providers.toml`). La phase 3b (extension : bouton IA, résultat, icônes sur les cartes) fera l'objet d'un plan séparé.

## Contraintes globales

- **3NF.** Seules les tables du spec §6 sont ajoutées. Le niveau de risque, la validité du cache et la mention « servi depuis le cache » **se calculent**, ils ne sont jamais stockés.
- **Fournisseurs :** ils sont définis dans `services/api/providers.toml`. **Aucune clé** n'apparaît dans le fichier, en base, dans les logs ou dans une réponse. Le fichier ne donne que le **nom** de la variable d'environnement.
- **`models.provider`** est un code défini dans `providers.toml`, vérifié au démarrage de l'API. Un code inconnu fait échouer le démarrage avec un message qui le nomme.
- **Paramètres d'appel LLM :**
  - `temperature = 0.2`, `max_tokens = 800` ;
  - délai de 30 s ;
  - **une seule** nouvelle tentative, en cas d'erreur de transport ou de JSON invalide ;
  - la réponse est toujours validée par Pydantic.
- **Champs vendeur interdits :** `seller.id`, `seller.name` et `seller.profileUrl` sont refusés à l'entrée (`422 invalid_listing`) et ne sont jamais envoyés au LLM.
- **Masquage des contacts :** téléphones et emails de la description sont remplacés par `[téléphone]` et `[email]` **avant** l'envoi au LLM **et** avant l'enregistrement du snapshot.
- **Codes d'erreur (spec §7.5) :**

| HTTP | code |
|---|---|
| 401 | `unauthenticated` |
| 402 | `no_active_subscription`, `quota_exhausted` |
| 403 | `feature_not_in_plan` |
| 422 | `invalid_listing` |
| 429 | `rate_limited` |
| 501 | `billing_unavailable` |
| 502 | `analysis_failed` |
| 503 | `auth_unavailable` (existant) |

- **Limites d'entrée :** titre de 300 caractères au plus, description de 5 000 au plus, 10 images au plus. **Photos :** 4 au plus, 768 px au plus sur le plus grand côté, JPEG qualité 80, 5 s et 5 Mo au plus par image.
- **Valeurs initiales de `settings` :** `cache_ttl_hours = 24`, `rate_limit_per_minute = 30`.
- **Forme canonique JSON pour les empreintes :** `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`, puis SHA-256 en hexadécimal.
- **Champs JSON en camelCase** (`CamelModel`). Les types partagés sont régénérés avec `pnpm gen:api`, et `pnpm check:api` doit passer.
- TDD. Les commits se terminent par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Ne jamais toucher à `video/`, `web-pages/`, `.DS_Store`, `services/api/tests/.conftest.py.swp`. Ne jamais pousser.

## Points de vigilance

1. **Même annonce analysée en même temps par deux utilisateurs :** **un seul** appel LLM (verrou consultatif), les deux scans comptent, et les deux reçoivent le même résultat. Tâche 5.
2. **Un seul scan restant et deux requêtes simultanées :** exactement une réussit, l'autre reçoit `402 quota_exhausted`. Tâche 5.
3. **Réponse LLM invalide** (JSON cassé, texte NL manquant, score hors de 0 à 100) : une nouvelle tentative, puis `502 analysis_failed`, et le scan est rendu (`scan_failures`). Jamais de 500. Tâches 3 et 5.
4. **URL d'image vers une IP privée, une redirection vers un hôte interne, ou une image énorme :** refus sans aucun accès réseau interne, et le scan photos échoue proprement (`502`, scan rendu). Tâche 4.
5. **Fournisseur indisponible ou clé invalide :** `502 analysis_failed`, scan rendu, et ni la clé ni le corps de la réponse du fournisseur dans les logs ou dans la réponse. Tâches 3 et 5.

---

## Structure des fichiers (`services/api/`)

```
providers.toml                                   fournisseurs (versionné, sans secret)
alembic/versions/0002_scans.py                   tables restantes + données initiales
src/radarnaque_api/
  models/listings.py                             listings, listing_snapshots, snapshot_images
  models/analyses.py                             analyses, analysis_texts, analysis_reasons, analysis_reason_texts
  models/reference.py (modifié)                  marketplaces, locales, sites, severities, site_image_hosts, settings, prompt_versions
  models/scans.py (modifié)                      scan_results
  llm/providers.py                               ProviderConfig, load_providers()
  llm/client.py                                  LLMClient, OpenAICompatibleClient, LLMAnalysis
  llm/payload.py                                 mask_contacts(), build_messages()
  llm/cli.py                                     radarnaque-llm (list, use)
  images.py                                      fetch_images() anti-SSRF + redimensionnement
  services/hashing.py                            content_hash(), input_hash()
  services/scans.py                              run_scan() — déroulé du §7.2
  routes/scans.py                                POST /api/scans, GET /api/scans/history
  routes/billing.py                              /api/billing/* (501) + BillingProvider
  schemas.py (modifié)                           ListingIn, RulesIn, ScanIn, AnalysisResultOut, ScanHistoryOut
tests/…                                          un fichier de test par module
apps/site/pricing/index.html, apps/site/privacy/index.html, apps/site/src/{pricing,privacy}.ts
scripts/llm-stub.mjs, scripts/e2e-scan.ts
```

---

### Tâche 1 : migration 0002, schéma restant et données initiales

**Fichiers :**
- Créer : `alembic/versions/0002_scans.py`, `models/listings.py` et `models/analyses.py`
- Modifier : `models/reference.py`, `models/scans.py`, `models/__init__.py` et `tests/conftest.py` (le nettoyage vide aussi les nouvelles tables de données, jamais les référentiels)
- Test : `tests/test_migration_0002.py`, et le test existant de comparaison ORM/migration qui doit rester vert

**Interfaces :**
- Produit des modèles ORM conformes au spec §6.1 (`marketplaces`, `locales`, `sites`, `severities`, `site_image_hosts`, `settings`, `prompt_versions`, plus `scan_kinds.active_prompt_version_id` avec une clé étrangère différée), §6.4 (`listings`, `listing_snapshots` (description enregistrée déjà masquée), `snapshot_images`, `analyses`, `analysis_texts`, `analysis_reasons`, `analysis_reason_texts`) et §6.5 (`scan_results`). Contraintes uniques et clés étrangères exactement comme dans le spec.
- **Données initiales :**
  - `marketplaces` : `twh`, `facebook` ;
  - `locales` : `fr`, `nl` ;
  - `sites` : `2ememain.be` (`twh`, `fr`), `2dehands.be` (`twh`, `nl`), `facebook.com` (`facebook`, `fr`) ;
  - `severities` : `info`, `warning`, `danger` ;
  - `site_image_hosts` : `images.2dehands.com` pour les deux sites twh, `fbcdn.net` pour facebook ;
  - `settings` : une seule ligne (24, 30) ;
  - `prompt_versions` : `text` v1 et `image` v1. Les deux sont actifs (`scan_kinds.active_prompt_version_id`).
- **Contenu des prompts v1**, en français, rédigé par l'implémenteur. Exigences :
  - rôle : un expert anti-arnaque des petites annonces belges (2ememain/2dehands, Facebook Marketplace) ;
  - n'utiliser **que** les faits fournis, ne jamais inventer ;
  - tenir compte des signaux des règles locales sans les répéter mot pour mot ;
  - score de 0 (aucun risque) à 100 (arnaque quasi certaine) ;
  - répondre **uniquement** par un JSON `{ "score": int, "summary": {"fr","nl"}, "advice": {"fr","nl"}, "reasons": [{"severity": "info|warning|danger", "fr", "nl"}] }`, avec au plus 5 raisons, un `summary` de 2 phrases au plus et un `advice` d'une phrase ;
  - pour `image` : examiner en plus la cohérence des photos (photo de catalogue, filigrane d'un autre site, incohérence avec le titre).

- [ ] **Étape 1 : écrire les tests.**
  - Après `upgrade head`, les données initiales ci-dessus sont présentes : `settings` vaut (24, 30), et les deux types de scan ont une version de prompt active.
  - `UNIQUE(listing_id, content_hash)` est garantie.
  - `UNIQUE(snapshot_id, model_id, prompt_version_id, input_hash)` est garantie.
  - `settings` refuse une seconde ligne (`CHECK id = 1`).
  - Supprimer un utilisateur supprime ses `scan_events`, `scan_results` et `scan_failures`, mais **pas** les `analyses` ni les `listing_snapshots`.
  - `downgrade` vers 0001, puis `upgrade` à nouveau, sans erreur.
  - Le test de comparaison ORM/migration passe.
- [ ] **Étape 2 : lancer `cd services/api && uv run pytest tests/test_migration_0002.py -v`.** Résultat attendu : ÉCHEC.
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : relancer `uv run pytest -v`.** Résultat attendu : tous les tests passent. Commit : `feat(api): schéma des annonces, analyses et prompts (migration 0002)`.

---

### Tâche 2 : `providers.toml`, chargement et commande `radarnaque-llm`

**Fichiers :**
- Créer : `providers.toml`, `src/radarnaque_api/llm/__init__.py`, `llm/providers.py`, `llm/cli.py`, `tests/test_providers.py` et `tests/test_llm_cli.py`
- Modifier :
  - `config.py` : `providers_file: Path`, avec pour défaut le chemin de `providers.toml` à côté de `pyproject.toml` ;
  - `main.py` : chargement au démarrage, puis vérification de `models.provider` dans le lifespan ;
  - `pyproject.toml` : `[project.scripts] radarnaque-llm = "radarnaque_api.llm.cli:main"`, et les dépendances `openai>=3.33`, `pillow>=13` ; `respx>=0.23` en dev.

**Interfaces :**
- Produit :
  ```python
  StructuredOutput = Literal["json_schema", "json_object"]
  CostSource = Literal["usage_cost", "omniroute_headers", "none"]
  @dataclass(frozen=True)
  class ProviderConfig:
      code: str; base_url: str; api_key_env: str | None; base_url_env: str | None
      structured_output: StructuredOutput; cost_source: CostSource; extra_body: dict
      def resolved_base_url(self, env: Mapping[str, str]) -> str      # base_url_env l'emporte s'il est défini
      def api_key(self, env: Mapping[str, str]) -> str                 # "" si api_key_env est None ; ProviderError si la variable manque
  class ProviderError(Exception): ...
  def load_providers(path: Path) -> dict[str, ProviderConfig]          # ProviderError (fichier, clé ou valeur invalide nommée)
  async def ensure_models_use_known_providers(session, providers) -> None   # ProviderError si un models.provider est inconnu
  ```
- **Contenu de `providers.toml` :**
  ```toml
  [providers.openrouter]
  base_url = "https://openrouter.ai/api/v1"
  api_key_env = "OPENROUTER_API_KEY"
  structured_output = "json_schema"
  cost_source = "usage_cost"
  [providers.openrouter.extra_body]
  provider = { data_collection = "deny" }
  usage = { include = true }
  reasoning = { enabled = false }

  [providers.omniroute]
  base_url = "http://localhost:20128/v1"
  base_url_env = "OMNIROUTE_BASE_URL"
  api_key_env = "OMNIROUTE_API_KEY"
  structured_output = "json_object"
  cost_source = "omniroute_headers"

  [providers.ollama]
  base_url = "http://localhost:11434/v1"
  base_url_env = "OLLAMA_BASE_URL"
  structured_output = "json_object"
  cost_source = "none"

  [providers.stub]          # faux fournisseur local pour les tests de bout en bout (tâche 9)
  base_url = "http://localhost:20199/v1"
  structured_output = "json_schema"
  cost_source = "none"
  ```
- **CLI `radarnaque-llm`** (lit `DATABASE_URL` et `PROVIDERS_FILE` dans l'environnement) :
  - `list` : affiche les fournisseurs du fichier et indique pour chacun si la clé est présente (oui/non, jamais la valeur), puis les modèles en base et le modèle actif de chaque type ;
  - `use <provider> <slug> --kind text|image` : crée si besoin la ligne `models` correspondante et met à jour `scan_kinds.active_model_id`. Un fournisseur absent du fichier donne un code de sortie 2 et un message.

- [ ] **Étape 1 : écrire les tests.**
  - Le `providers.toml` du dépôt se charge et contient exactement les 4 fournisseurs.
  - Cas invalides : `structured_output` inconnu, `base_url` absent, fichier TOML mal formé → `ProviderError` qui nomme la clé.
  - `api_key()` lève une erreur si la variable manque, et ne fait jamais apparaître sa valeur dans le message.
  - `resolved_base_url` : la variable d'environnement l'emporte sur la valeur du fichier.
  - Démarrage avec un modèle en base dont le fournisseur est inconnu → échec avec un message qui nomme ce fournisseur.
  - CLI : `use omniroute auto --kind text` crée le modèle et l'active ; `use nope x --kind text` → code de sortie 2 ; `list` n'affiche jamais une valeur de clé (test avec `OPENROUTER_API_KEY=sk-test-secret`, la sortie ne contient pas `sk-test-secret`).
- [ ] **Étapes 2 à 4 : ÉCHEC, implémentation, SUCCÈS** (`uv run pytest tests/test_providers.py tests/test_llm_cli.py -v`, puis toute la suite). Commit : `feat(api): fournisseurs LLM décrits dans providers.toml et commande radarnaque-llm`.

---

### Tâche 3 : client LLM compatible OpenAI et construction des messages

**Fichiers :**
- Créer : `llm/client.py`, `llm/payload.py`, `tests/test_llm_client.py` et `tests/test_payload.py`

**Interfaces :**
- Consomme : `ProviderConfig` (tâche 2).
- Produit :
  ```python
  class LLMReason(BaseModel): severity: Literal["info","warning","danger"]; fr: str; nl: str   # fr et nl non vides
  class LLMAnalysis(BaseModel): score: int (0..100); summary: Bilingual; advice: Bilingual; reasons: list[LLMReason] (≤ 5)
  @dataclass class LLMResult: analysis: LLMAnalysis; tokens_in: int; tokens_out: int; cost_usd_micros: int
  class LLMError(Exception): code: Literal["transport", "invalid_response", "configuration"]   # message sans secret ni corps de réponse
  class LLMClient(Protocol):
      async def analyze(self, *, model: str, system_prompt: str, messages: list[dict]) -> LLMResult
  class OpenAICompatibleClient:   # implémente LLMClient
      def __init__(self, provider: ProviderConfig, env: Mapping[str, str], http_client: httpx.AsyncClient | None = None)
  def mask_contacts(text: str) -> str            # téléphones (mêmes formats que les règles de l'extension, belges et internationaux) → "[téléphone]", emails → "[email]"
  def build_messages(listing: ListingIn, rules: RulesIn, images_b64: list[str]) -> list[dict]   # contenu "user" : JSON canonique des faits (description masquée, vendeur sans identité, signaux) + images en parts image_url data:image/jpeg;base64
  ```
- **Comportement :**
  - `AsyncOpenAI(base_url=…, api_key=… or "unused", timeout=30, max_retries=0, http_client=…)`.
  - `response_format` : `{"type": "json_schema", "json_schema": {"name": "radarnaque_analysis", "strict": True, "schema": <schéma de LLMAnalysis>}}` ou `{"type": "json_object"}`. Dans ce second cas, le schéma attendu est ajouté à la fin du prompt système.
  - `extra_body` = `provider.extra_body`.
  - **Une** nouvelle tentative si l'erreur est de transport (délai dépassé, connexion, 5xx) ou si la réponse n'est pas valide (JSON ou Pydantic). Erreur 401/403 du fournisseur → `LLMError("configuration")`, sans nouvelle tentative.
  - **Coût :**
    - `usage_cost` : `usage.cost` (en dollars) × 1 000 000, arrondi ;
    - `omniroute_headers` : en-tête de coût d'OmniRoute lu via `with_raw_response`. Le nom exact est à vérifier dans la documentation d'OmniRoute et à documenter dans le code ; s'il est absent, 0 ;
    - `none` : 0.
  - Les tokens viennent de `usage.prompt_tokens` et `usage.completion_tokens` (0 si absents).

- [ ] **Étape 1 : écrire les tests** (respx simule `POST {base_url}/chat/completions`).
  - Le mode `json_schema` envoie le `response_format` strict et l'`extra_body` OpenRouter (`provider.data_collection == "deny"`, `usage.include == True`).
  - Le mode `json_object` ajoute le schéma au prompt système.
  - Une réponse invalide puis une réponse valide → succès, avec exactement 2 appels.
  - Deux réponses invalides → `LLMError("invalid_response")`.
  - Un 401 → `LLMError("configuration")` avec un seul appel, et le message ne contient ni la clé (`sk-test-secret`) ni le corps renvoyé par le fournisseur.
  - Délai dépassé deux fois → `LLMError("transport")`.
  - Coût OpenRouter : `usage.cost = 0.000412` → 412.
  - Score de 101 ou `nl` vide → réponse invalide.
  - `mask_contacts` : « appelez le 0472 12 34 56 ou ecrire a jean@exemple.be » → « appelez le [téléphone] ou ecrire a [email] ». « iPhone 14 PRO 128GB » et « 1 234 € » restent inchangés.
  - `build_messages` : `seller.id`, `seller.name` et `seller.profileUrl` sont absents du contenu (même si l'objet est construit à la main), la description est masquée, et les images deviennent des parts `image_url` en `data:image/jpeg;base64,…`.
- [ ] **Étapes 2 à 4 : ÉCHEC, implémentation, SUCCÈS.** Commit : `feat(api): client LLM compatible OpenAI multi-fournisseurs`.

---

### Tâche 4 : téléchargement des photos, sûr contre les attaques SSRF

**Fichiers :**
- Créer : `src/radarnaque_api/images.py` et `tests/test_images.py`

**Interfaces :**
- Produit :
  ```python
  class ImageFetchError(Exception): reason: Literal["host_not_allowed", "private_address", "too_large", "timeout", "bad_image", "http_error"]
  async def fetch_images(urls: list[str], allowed_suffixes: list[str], *, http: httpx.AsyncClient,
                         resolve: Callable[[str], Awaitable[list[str]]] = default_resolve, limit: int = 4) -> list[str]   # base64 JPEG
  ```
- **Règles :**
  - Seuls `https` et `http` sont acceptés.
  - Hôte autorisé si `host == suffix` ou si `host` se termine par `"." + suffix`.
  - **Toutes** les adresses résolues doivent être publiques (`ipaddress` : ni `is_private`, ni `is_loopback`, ni `is_link_local`, ni `is_reserved`, ni `is_multicast`, ni non spécifiée).
  - Pas de redirection automatique : on suit au plus 2 redirections à la main, en revérifiant l'hôte **et** les adresses à chaque fois.
  - Lecture en flux, coupée au-delà de 5 Mo ; délai de 5 s par image.
  - Pillow : `Image.open`, `verify`, puis réouverture, `ImageOps.exif_transpose`, conversion en RGB, `thumbnail((768, 768))`, JPEG qualité 80.
  - Les `limit` premières URL seulement. **Une seule** image en échec fait échouer tout l'appel (`ImageFetchError`).

- [ ] **Étape 1 : écrire les tests** (respx, et un `resolve` simulé).
  - Hôte hors liste → `host_not_allowed`, sans requête envoyée.
  - `evil-fbcdn.net` et `fbcdn.net.evil.com` → refusés.
  - Résolution vers `10.0.0.5`, `127.0.0.1` ou `169.254.169.254` → `private_address`, sans requête.
  - Redirection 302 vers `http://169.254.169.254/` → `private_address`.
  - 3 redirections → `http_error`.
  - Image de 6 Mo → `too_large`.
  - Contenu qui n'est pas une image → `bad_image`.
  - Une image PNG de 2000×1000 → un JPEG base64 de 768×384.
  - 6 URL → 4 images téléchargées, et 4 requêtes seulement.
- [ ] **Étapes 2 à 4.** Commit : `feat(api): téléchargement des photos sûr contre les attaques SSRF`.

---

### Tâche 5 : service de scan (déroulé du spec §7.2)

**Fichiers :**
- Créer : `services/hashing.py`, `services/scans.py`, `tests/test_hashing.py` et `tests/test_scan_service.py`
- Modifier : `schemas.py` (`ListingIn`, `RulesIn`, `SignalIn`, `ScanIn` et `AnalysisResultOut`)

**Interfaces :**
- Consomme : les tâches 1 à 4 ; `compute_usage`, `get_active_subscription` et `current_period_start` de la phase 1 ; `AuthUser` (`role`).
- Produit :
  ```python
  # schemas (camelCase, extra="forbid" partout → un champ vendeur interdit = 422 invalid_listing)
  class SellerFactsIn: accountAgeMonths: {min:int≥0,max:int≥min} | None; reviewCount: int≥0 | None; rating: float 0..5 | None;
                       otherListingsCount: int≥0 | None; verified: bool | None
  class ListingIn: site: Literal["2ememain.be","2dehands.be","facebook.com"]; externalId: str (1..64); url: HttpUrl; title (1..300);
                   description (0..5000); price: {amountCents:int≥0, currency:"EUR"} | None; priceType: Literal["fixed","bidding","free","unknown"];
                   category, condition, postedAt: str | None; location: {city, region, country: str | None}; images: list[HttpUrl] (≤10); seller: SellerFactsIn
  class SignalIn: id: str (1..40); weight: int 0..100; severity: Literal[...]; params: dict[str, str|int] | None
  class RulesIn: version: int ≥1; signals: list[SignalIn] (≤20)
  class ScanIn: listing: ListingIn; rules: RulesIn; scanKind: Literal["text","image"]; trigger: Literal["button","card"]; partial: bool = False
  class AnalysisResultOut: analysisId: int; score; level: Literal["low","medium","high"]; partial; fromCache; summary; advice;
                           reasons: list[{severity, text:{fr,nl}}]; analyzedAt: datetime; remaining: {text: int|None, image: int|None, total: int|None}
  # hashing
  def content_hash(listing: ListingIn, masked_description: str) -> str   # {title, description masquée, price, priceType, images}
  def input_hash(scan: ScanIn) -> str                                   # {seller facts, rules.version, signaux triés par id (avec params), partial}
  # service
  class ScanError(Exception): status: int; code: str; details: dict
  async def run_scan(*, engine: AsyncEngine, user: AuthUser, scan: ScanIn, llm_for: Callable[[str], LLMClient],
                     http: httpx.AsyncClient, now: Callable[[], datetime]) -> AnalysisResultOut
  ```
- **Déroulé, dans cet ordre exact :**
  1. **Limite de requêtes** : si les `scan_events` de l'utilisateur sur les 60 dernières secondes atteignent `settings.rate_limit_per_minute` → `429 rate_limited`. S'applique aussi aux admins.
  2. **Droits**, sauf pour un admin :
     - pas d'abonnement actif → `402 no_active_subscription` ;
     - `image` sans `image_scan`, ou `card` sans `card_icons` → `403 feature_not_in_plan`.
  3. **Le site existe** et chaque image a un hôte de `site_image_hosts` du site, sinon `422 invalid_listing` (`details.field`).
  4. **Masquage** de la description, `content_hash`, puis upsert de `listings`, `listing_snapshots` et `snapshot_images` (`INSERT … ON CONFLICT DO NOTHING`, puis relecture).
  5. **Réservation du quota**, en transaction :
     - `SELECT … FOR UPDATE` sur l'abonnement actif ;
     - comptage via `compute_usage` (quota du type **et** `total_scan_cap`) ;
     - quota atteint → `402 quota_exhausted` (`details: {plan, scanKind}`) ;
     - sinon insertion du `scan_event`, puis commit.
     - Un admin passe sans verrou, mais l'événement est bien enregistré.
  6. **Cache** : `analyses` de `(snapshot, scan_kinds.active_model_id, active_prompt_version_id, input_hash)` avec `created_at + ttl > now`. S'il y en a une → `scan_results`, puis réponse avec `fromCache = true`.
  7. **Sinon**, une nouvelle connexion ouvre une transaction et prend `pg_advisory_xact_lock(hashtextextended(<clé du cache>, 0))`, puis :
     - revérifie le cache ;
     - pour `image`, appelle `fetch_images` ;
     - appelle `llm_for(provider).analyze(model=slug, system_prompt=<version active>, messages=build_messages(...))` ;
     - insère `analyses` + `analysis_texts` (fr, nl) + `analysis_reasons` + `analysis_reason_texts`, puis `scan_results` ;
     - et fait le commit, qui libère le verrou.
  8. **Toute erreur à l'étape 7** (`LLMError`, `ImageFetchError` ou erreur de configuration du fournisseur) → `scan_failures(error_code)` dans une nouvelle transaction, puis `502 analysis_failed` avec `details: {reason}` (le code, jamais de message brut).
  - **`fromCache`** est vrai s'il existe un `scan_results` antérieur qui pointe vers la même analyse. On le calcule.
  - **`level`** : 0 à 29 → low, 30 à 59 → medium, 60 et plus → high.
  - **`remaining`** est recalculé après le scan.

- [ ] **Étape 1 : écrire les tests** (Postgres réel, et un faux `LLMClient` qui compte ses appels).
  - **Essai :** un scan texte réussit, et `remaining.total` passe de 3 à 2.
  - **Même annonce scannée deux fois :** le second scan a `fromCache = true` et **un seul** appel LLM a lieu, mais le quota baisse deux fois.
  - **Annonce modifiée** (autre description) → nouveau snapshot et nouvel appel.
  - **Signaux différents** (autre `input_hash`) → nouvel appel, et l'analyse en cache ne change pas (pas d'empoisonnement).
  - **Cache expiré** (`now` avancé de 25 h) → nouvel appel.
  - **Concurrence :** 2 utilisateurs, même annonce, `asyncio.gather` → un seul appel LLM et 2 `scan_results` vers la même analyse.
  - **Concurrence sur le quota :** un seul scan restant, 2 requêtes en parallèle → une réussite et une `402 quota_exhausted`, sans exception.
  - **Échec LLM** → 502 `analysis_failed`, un `scan_failures` est créé, et `remaining` est inchangé par rapport à avant.
  - **Droits :** standard + `image` → 403 ; standard + `card` → 403 ; sans abonnement → 402 ; admin sans abonnement → réussite.
  - **Limite de requêtes :** la 31ᵉ requête dans la minute → 429.
  - **Hôte d'image non autorisé** → 422, sans réservation de quota.
  - **Snapshot :** il ne contient ni téléphone ni email (description masquée).
  - **Hashing :** l'ordre des clés et des signaux ne change pas l'empreinte, et un caractère de description différent la change.
- [ ] **Étapes 2 à 4.** Commit : `feat(api): service de scan (droits, quotas, cache, verrou, relais LLM)`.

---

### Tâche 6 : routes `/api/scans`, historique et types partagés

**Fichiers :**
- Créer : `routes/scans.py` et `tests/test_scans_routes.py`
- Modifier :
  - `main.py` : enregistrement des routes, plus `app.state.http`, un `httpx.AsyncClient` créé dans le lifespan ;
  - `app.state.llm_for` : une fabrique `provider_code -> OpenAICompatibleClient`, mise en cache ;
  - `schemas.py` : `ScanHistoryItemOut` et `ScanHistoryOut` ;
  - `packages/shared/openapi.json` et `src/api.ts`, régénérés ;
  - `packages/shared/src/index.ts` : exporte `ScanIn`, `AnalysisResult` et `ScanHistory`.

**Interfaces :**
- Produit :
  - `POST /api/scans` (`ScanIn`) → `200 AnalysisResultOut`, avec les codes d'erreur du spec ;
  - `GET /api/scans/history?limit=20&before=<scanEventId>` → `{ items: [{ scanEventId, createdAt, scanKind, trigger, site, title, score|null, level|null, fromCache, failed }], nextBefore|null }`. Les éléments sont triés du plus récent au plus ancien, avec 1 ≤ `limit` ≤ 50.
  - Les dépendances de test peuvent remplacer `app.state.llm_for` par un faux client.

- [ ] **Étape 1 : écrire les tests** (client HTTP, JWT de test, faux LLM).
  - `POST` valide → 200, avec des clés camelCase (`fromCache`, `analysisId`, `remaining`).
  - `seller.name` présent dans le corps → `422 invalid_listing`.
  - Sans JWT → 401.
  - Plus de 10 images → 422.
  - `GET /api/scans/history` après 3 scans dont un échec → 3 éléments du plus récent au plus ancien, `failed` vrai pour l'échec, et pagination avec `before`.
  - Un utilisateur ne voit jamais l'historique d'un autre.
- [ ] **Étape 2 : implémenter, puis `pnpm gen:api && pnpm check:api`.** Résultat attendu : code de sortie 0.
- [ ] **Étape 3 : relancer toute la suite.** Commit : `feat(api): routes /api/scans et historique, types partagés régénérés`.

---

### Tâche 7 : routes de paiement (structure Stripe, réponse 501)

**Fichiers :**
- Créer : `routes/billing.py`, `billing.py` et `tests/test_billing.py`

**Interfaces :**
- Produit :
  - `class BillingProvider(Protocol)` avec `create_checkout(user, plan, interval) -> str`, `create_portal(user) -> str` et `handle_webhook(payload: bytes, signature: str | None) -> None` ;
  - `class ManualBillingProvider`, qui lève `ScanError(501, "billing_unavailable")` (ou un `ApiError` équivalent) ;
  - `POST /api/billing/checkout` (`{ plan: "standard" | "premium", interval: "month" | "year" }`, authentifié), `POST /api/billing/portal` (authentifié) et `POST /api/billing/webhooks/stripe` (non authentifié) → **501** `billing_unavailable`.
- [ ] **Étapes TDD :**
  - checkout valide et authentifié → 501 `billing_unavailable` ;
  - checkout avec `plan: "trial"` → 422 ;
  - checkout sans JWT → 401 ;
  - webhook → 501.
  Commit : `feat(api): structure de paiement (routes 501, BillingProvider manuel)`.

---

### Tâche 8 : pages `/pricing` et `/privacy` (site statique)

**Fichiers :**
- Créer : `apps/site/pricing/index.html`, `apps/site/privacy/index.html`, `apps/site/src/pages-i18n.ts`, `apps/site/src/pricing.ts`, `apps/site/src/privacy.ts` et `apps/site/test/pages-i18n.test.ts`
- Modifier : `apps/site/vite.config.ts` (deux nouvelles entrées)

**Interfaces :**
- Les pages sont en FR et NL, avec la même détection de langue que la page `/auth/callback` et un lien pour changer de langue.
- **`/pricing`** :
  - 3 cartes : Essai (3 scans offerts, toutes les fonctionnalités), Standard (2,99 €/mois ou 29 €/an, 150 analyses texte par mois, bouton sur la page d'annonce) et Premium (6,99 €/mois ou 69 €/an, 1 000 analyses texte et 100 analyses avec photos par mois, icônes sur les résultats de recherche) ;
  - mention « Paiement bientôt disponible ».
- **`/privacy`** : le contenu du spec §10 en langage clair :
  - données collectées : email, abonnement, historique des scans pendant 12 mois ;
  - le contenu des annonces est envoyé pour analyse, sans l'identité du vendeur, avec téléphones et emails masqués ;
  - les fournisseurs IA sont configurés pour ne pas conserver les données ;
  - hébergement dans l'UE (Allemagne) ;
  - droit à l'effacement, avec un contact par email (`privacy@mostconsult.be`, à faire confirmer par l'utilisateur dans le rapport).
- Pas de styles sophistiqués : la passe de design viendra plus tard. Une mise en page lisible suffit.
- [ ] **Étapes TDD :** parité exacte des clés FR et NL ; les prix affichés correspondent aux valeurs du spec §2.2 ; puis `pnpm --filter site build` produit `dist/pricing/index.html` et `dist/privacy/index.html`. Commit : `feat(site): pages tarifs et confidentialité FR/NL`.

---

### Tâche 9 : faux fournisseur local, test de bout en bout et documentation OmniRoute

**Fichiers :**
- Créer : `scripts/llm-stub.mjs`, `scripts/llm-stub.test.mjs` et `scripts/e2e-scan.ts`
- Modifier :
  - le `package.json` racine : `llm:stub`, `e2e:scan`, et le nouveau test inclus dans `test:scripts` ;
  - `infra/.env.example` : `OMNIROUTE_API_KEY`, `OMNIROUTE_BASE_URL`, `OLLAMA_BASE_URL` et `PROVIDERS_FILE`, commentés ;
  - `infra/docker-compose.yml` : variables du fournisseur passées à `api` ;
  - `README.md` : sections « Analyses IA en dev (OmniRoute, Ollama ou faux fournisseur) » et « Changer de fournisseur ».

**Interfaces :**
- **`scripts/llm-stub.mjs [port=20199]`** : un serveur HTTP Node qui répond à `POST /v1/chat/completions`.
  - Il renvoie une réponse au format OpenAI dont le contenu est un JSON `LLMAnalysis` valide : score 42, textes FR/NL fixes, 1 raison.
  - `usage` vaut `{ prompt_tokens: 100, completion_tokens: 50 }`.
  - Il affiche une ligne de log par requête : modèle, nombre de messages, présence d'images. **Jamais** le contenu.
- **`scripts/e2e-scan.ts`** :
  - même connexion que `e2e-login.ts`, en réutilisant ses fonctions (les extraire dans `scripts/e2e-lib.ts` si besoin) ;
  - puis `POST /api/scans` avec une annonce fixe et des signaux fixes : premier scan → `fromCache: false`, second scan identique → `fromCache: true`, et `remaining.total` qui baisse de 1 à chaque fois ;
  - affiche `E2E SCAN OK (provider=<p>, model=<m>, score=<n>)` et sort avec le code 0, sinon nomme l'étape en échec et sort avec le code 1.
- **README** :
  - lancer OmniRoute en local (`npx omniroute` ou l'image Docker `diegosouzapw/omniroute`, port 20128) et récupérer sa clé dans Dashboard → Endpoints ;
  - `uv run radarnaque-llm use omniroute auto --kind text` (et `--kind image`) ;
  - Ollama : `ollama serve`, puis `radarnaque-llm use ollama <modèle> --kind text` ;
  - production : `radarnaque-llm use openrouter google/gemini-2.5-flash-lite --kind text` et `google/gemini-3.1-flash-lite --kind image` ;
  - ajouter un fournisseur compatible OpenAI : une entrée dans `providers.toml` et une variable d'environnement.

- [ ] **Étape 1 : écrire `llm-stub.test.mjs`** (`node --test`) : la réponse est un JSON OpenAI valide, son contenu se lit comme une `LLMAnalysis`, et le contenu des messages n'apparaît pas dans les logs.
- [ ] **Étape 2 : implémenter**, puis vérifier en vrai :
  - lancer `pnpm llm:stub` ;
  - `cd services/api && uv run --env-file ../../infra/.env radarnaque-llm use stub stub-model --kind text` ;
  - `pnpm dev` (en arrière-plan) ;
  - `pnpm e2e:scan`. Résultat attendu : `E2E SCAN OK (provider=stub, …)`.
  - Puis remettre le modèle actif d'origine (`radarnaque-llm use openrouter google/gemini-2.5-flash-lite --kind text`) et tout arrêter proprement.
  - Le test réel avec OmniRoute est fait par l'utilisateur : les étapes sont dans le README.
- [ ] **Étape 3 : commit** : `chore(dev): faux fournisseur LLM, test e2e des scans et documentation OmniRoute`.

---

## Couverture du spec

| Spec | Tâche |
|---|---|
| §6.1 référentiels restants, `prompt_versions`, `settings`, `site_image_hosts` | 1 |
| §6.4 annonces, snapshots, analyses, textes et raisons | 1 |
| §6.5 `scan_results`, calcul de `fromCache` | 1, 5 |
| §7.1 `/api/scans`, `/api/scans/history`, `/api/billing/*` | 6, 7 |
| §7.2 déroulé complet | 5 |
| §7.3 fournisseurs `providers.toml`, client compatible OpenAI, coût, sortie structurée | 2, 3 |
| §7.4 photos (anti-SSRF, 768 px, JPEG 80) | 4 |
| §7.5 codes d'erreur | 5, 6, 7 |
| §9 structure Stripe (501) | 7 |
| §10 masquage, aucune identité vendeur, `data_collection: deny`, page `/privacy` | 3, 5, 8 |
| demande utilisateur : OmniRoute en dev, OpenRouter en prod, fournisseurs interchangeables | 2, 3, 9 |

**Hors 3a :**
- l'extension (bouton IA, affichage du résultat, icônes sur les cartes, messagerie avec liste blanche) : phase 3b ;
- `DELETE /api/me`, la purge à 12 mois, l'admin et les vues SQL : phase 4 ;
- le branchement réel de Stripe : phase 5.
