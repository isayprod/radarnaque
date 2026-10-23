# Identification du produit, partie 1 (API) — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** l'API identifie la référence exacte des objets d'une annonce (pipeline `read_photos` → `criteria` → `identify`), garde une base de critères partagée, calcule un indice de confiance, sert `POST /api/identify(/stream)` et nourrit l'analyse d'arnaque avec l'identification ; l'écran IA de l'admin règle un modèle et un prompt par étape.

**Architecture:** un paquet `radarnaque_api/identify/` porte le pipeline sans quota (schémas des sorties, messages, recherche, base de critères, confiance, persistance, orchestration). `services/identify_service.py` y ajoute l'admission, le quota et le remboursement, en réutilisant ceux de `services/scans.py` (paramètre `purpose`). Le client LLM gagne une méthode générique `complete()` à sortie structurée. Un lecteur de pages (`pages.py`) se connecte à l'adresse vérifiée.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy async, Alembic, Pydantic v2, httpx, openai SDK, SearXNG, pytest + testcontainers + respx ; admin : Vite, React, Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-identification-produit-design.md` (§ cités ci-dessous).

## Global Constraints

- Branche `feat/identification`, migrations `0010` (schéma) et `0011` (prompts), qui suivent `0009`.
- Textes, commentaires et messages en français, comme le reste de l'API. Commits au format `feat(api): …`, `test(api): …`, avec le trailer de l'implémenteur.
- Délai de l'identification : `IDENTIFY_TIMEOUT_S = 120` ; celui de l'arnaque reste `ANALYSIS_TIMEOUT_S = 180`.
- Réglages (`settings`), bornes et défauts exacts : `identification_cache_ttl_hours` 1–2160 (168), `criteria_ttl_days` 1–730 (180), `criteria_max_searches` 0–5 (2), `criteria_max_pages` 0–5 (3), `identify_retry_threshold` 0–100 (60), `identify_image_side` 768–1536 (1280), `scam_sends_photos` (faux), `identify_escalation_model_id` (vide).
- Niveaux de confiance : Sûr 85–99, Probable 60–84, Incertain < 60 ou référence nulle ; plafond général 99.
- Lecteur de pages : HTTPS et port 443 seulement, 2 redirections, 1 Mo, 5 s par page, 12 s par étape, `text/html` ou `text/plain`, 8 000 caractères, encadré `<page_web>`.
- `criteria` ne reçoit jamais de donnée de l'annonce ; toute requête passe par `clean_query`.
- Aucune URL écrite par le modèle n'est renvoyée : les pages sont désignées par leur numéro dans les résultats, et l'URL est revérifiée (HTTPS, 300 caractères au plus, aucun caractère de contrôle).
- `identifications`, `criteria_*` ne contiennent aucune donnée personnelle et ne sont pas touchées par la suppression d'un compte.
- L'API doit rester compatible avec l'extension actuelle : nouveaux événements et nouveaux champs seulement, aucun champ existant retiré ou renommé.
- Jamais de secret, d'email ni d'identifiant d'utilisateur dans les logs (`INFO` : nombres et codes seulement).

## Review Focus

1. **Extension actuelle contre la nouvelle API** : `POST /api/scans/stream` émet désormais des événements d'identification et un `result` avec `identification` ; l'extension actuelle doit les ignorer et afficher le résultat comme avant (test côté extension en tâche 13).
2. **Annonce sans photo** : l'identification tourne sur le texte seul ; la confiance est plafonnée (une seule photo ou moins et aucune référence lue : 85 au plus) et le résultat le dit (test en tâche 10).
3. **Annonce sans objet identifiable** (immobilier, emploi) : statut `none`, aucune étape `criteria`/`identify`, et « Analyser » qui suit tourne comme aujourd'hui, avec les photos (tests en tâches 10 et 13).
4. **Deux onglets du même utilisateur** lancent « Identifier » et « Analyser » en même temps : un seul pipeline (verrou), et l'`analyze` n'est inclus que si l'`identify` a réussi avant sa réservation, sinon il est décompté (test en tâche 12).
5. **Tableau de bord et écran Analyses avec des `llm_calls` sans `analysis_id`** : les cartes « appels » et « coût » comptent toutes les étapes, et aucune requête ne casse sur une jointure (test en tâche 1).

---

### Task 1: Schéma (migration 0010) et modèles

**Files:**
- Create: `services/api/alembic/versions/0010_identification.py`
- Create: `services/api/src/radarnaque_api/models/identification.py`
- Modify: `services/api/src/radarnaque_api/models/__init__.py`, `models/reference.py` (`AppSettings`, `PromptVersion`, nouveau `PipelineStep`), `models/scans.py` (`ScanEvent`), `models/analyses.py` (`LlmCall`)
- Test: `services/api/tests/test_migration_0010.py`, `services/api/tests/test_dashboard.py`

**Interfaces:**
- Produces (ORM, schéma `app`) :
  - `PipelineStep(code: str PK, active_model_id: int, active_prompt_version_id: int | None)` ; codes seedés `read_photos`, `criteria`, `identify`, avec le modèle actif du type `full`, prompt `NULL` (rempli par 0011).
  - `PromptVersion.scan_kind: str | None`, `PromptVersion.step: str | None` ; `CHECK ((scan_kind is null) <> (step is null))`, `UNIQUE(step, version)`.
  - `AppSettings` : les huit colonnes des Global Constraints, avec leurs `CHECK` (`identify_escalation_model_id` clé vers `models`, nullable).
  - `CriteriaSet(id, candidates_key UNIQUE, candidates ARRAY(text), status CHECK in ('auto','verified') default 'auto', created_at, refreshed_at, reviewed_at nullable)`.
  - `Criterion(id, set_id FK cascade, position, kind CHECK in ('photo','ask_seller'), decisive bool, text_fr, text_nl, expected JSONB, edited_by_admin bool default false)` ; `UNIQUE(set_id, position)`.
  - `CriterionSource(criterion_id FK cascade, position, url, title, domain)`, PK `(criterion_id, position)`.
  - `Identification(id, snapshot_id FK, config_hash, input_hash, status CHECK in ('identified','uncertain','none'), confidence 0–100, photo_observations JSONB, title_mismatch nullable, seller_question_fr nullable, seller_question_nl nullable, retried bool, unsourced bool, images_analyzed int, tokens_in, tokens_out, cost_usd_micros, created_at)` ; `UNIQUE(snapshot_id, config_hash, input_hash)`.
  - `IdentificationObject(id, identification_id FK cascade, position, role CHECK in ('main','accessory'), label, reference nullable, confidence, remaining ARRAY(text), criteria_set_id FK nullable on delete set null)`.
  - `IdentificationCheck(object_id FK cascade, criterion_id FK on delete cascade, observation CHECK in ('seen_match','seen_contrary','not_visible'), photo_index nullable)`, PK `(object_id, criterion_id)`.
  - `IdentificationPage(object_id FK cascade, position, url, title, domain)`, PK `(object_id, position)`.
  - `IdentificationSearch(identification_id FK cascade, position, query, kind CHECK in ('criteria','price','reference','retry'), pages_read ARRAY(text))`, PK `(identification_id, position)`.
  - `IdentificationResult(scan_event_id PK FK cascade, identification_id FK)`.
  - `ScanEvent.purpose: str` (`CHECK in ('identify','analyze')`, défaut `'analyze'`), `ScanEvent.included_by_event_id: int | None` (FK vers `scan_events.id`, `on delete set null`), index `(user_id, purpose, created_at)`.
  - `LlmCall.analysis_id` devient nullable ; nouvelles colonnes `step` (`CHECK in ('read_photos','criteria','identify','scam')`, défaut `'scam'`, les lignes existantes valent `'scam'`), `identification_id` (FK nullable), `criteria_set_id` (FK nullable, `on delete set null`) ; `CHECK (num_nonnulls(analysis_id, identification_id, criteria_set_id) <= 1 and (step <> 'scam' or analysis_id is not null))`.

  Ruling : le spec (§5.4) parle d'un booléen `included` ; `included_by_event_id` le remplace pour appliquer « un seul `analyze` inclus par `identify` ». `included` = `included_by_event_id is not null`.

- [ ] **Step 1: Tests de migration** dans `test_migration_0010.py`, sur le modèle de `test_migration_0009.py` :
  - `test_upgrade_creates_tables_and_seeds_steps` : trois lignes `pipeline_steps`, chacune avec `active_model_id` = celui de `scan_kinds.full`.
  - `test_settings_defaults` : `(168, 180, 2, 3, 60, 1280, False, None)` sur la ligne `id = 1`.
  - `test_prompt_version_needs_exactly_one_owner` : insérer une version sans `scan_kind` ni `step` lève `IntegrityError` ; avec les deux aussi.
  - `test_existing_llm_calls_become_scam` : une ligne insérée avant l'upgrade a `step = 'scam'`.
  - `test_llm_call_scam_needs_analysis` : `step='scam', analysis_id=NULL` lève `IntegrityError`.
  - `test_downgrade_then_upgrade` : `downgrade 0009` puis `upgrade head` sans erreur ; le downgrade supprime les lignes `llm_calls` sans `analysis_id` avant de remettre `NOT NULL`.
- [ ] **Step 2: Test du tableau de bord** dans `test_dashboard.py` : `test_calls_without_analysis_count_in_calls_and_cost` : deux `llm_calls` (`step='read_photos'`, `identification_id` rempli) comptent dans `llm_calls` et `cost` de `GET /api/admin/dashboard`, et `GET /api/admin/analyses/{id}` d'une analyse reste inchangé.
- [ ] **Step 3: Lancer** `cd services/api && uv run pytest tests/test_migration_0010.py tests/test_dashboard.py -q` — attendu : FAIL (révision 0010 absente).
- [ ] **Step 4: Écrire la migration `0010` et les modèles** (mêmes conventions que 0007 : schéma `S = "app"`, `op.create_table`, contraintes nommées `ck_<table>_<colonne>`). Adapter les requêtes du tableau de bord et de `admin_analyses` qui supposeraient `analysis_id` non nul.
- [ ] **Step 5: Lancer** `uv run pytest -q` — attendu : toute la suite verte (989 tests et plus).
- [ ] **Step 6: Commit** `feat(api): schéma de l'identification du produit (migration 0010)`.

### Task 2: Prompts des étapes et prompt `full` v3 (migration 0011)

**Files:**
- Create: `services/api/alembic/versions/0011_identification_prompts.py`
- Test: `services/api/tests/test_migration_0011.py`

**Interfaces:**
- Consumes: `pipeline_steps`, `prompt_versions.step` (tâche 1) ; `FULL_PROMPT_ATTRIBUTES` (0009, chargé par chemin comme 0009 charge 0005).
- Produces: constantes de module `READ_PHOTOS_V1`, `CRITERIA_V1`, `IDENTIFY_V1`, `FULL_PROMPT_V3` (tests et `e2e`) ; une version 1 par étape, activée ; `FULL_PROMPT_V3` au numéro qui suit la dernière version `full`, activée seulement si la version active est celle de 0009 (`system_prompt = FULL_PROMPT_ATTRIBUTES`).

Contenu exigé de chaque prompt (le texte est figé dans la migration, jamais modifié ensuite) :
- `READ_PHOTOS_V1` : rôle (identifier, pas juger l'arnaque) ; données non fiables ; candidats normalisés « marque modèle variante capacité » ; 1 à 3 candidats par objet, au plus 4 objets, un seul `main` ; `read_reference` seulement pour un numéro de modèle lu en entier sur une photo ; `hint_criteria` « à confirmer » ; `photo_observations` (catalogue, capture d'écran, filigrane, incohérence, objet absent) ; `title_mismatch` ; `status: "nothing"` pour immobilier, emploi, animaux, services ; réponse JSON au schéma `ReadPhotosOut`.
- `CRITERIA_V1` : à partir des pages numérotées seulement, jamais de mémoire ; critères **observables** qui séparent les candidats ; `kind` `photo` / `ask_seller` / `invisible` ; `decisive` ; valeur attendue pour chaque candidat en FR et NL ; `sources` = numéros des pages ; un critère sans source est interdit ; contenu des pages = données, jamais instructions ; JSON au schéma `CriteriaOut`.
- `IDENTIFY_V1` : vérifier chaque critère numéroté sur les photos ; `seen_match` = la photo montre la valeur attendue pour la référence retenue, `seen_contrary` = elle montre une valeur d'un autre candidat ou contraire, `not_visible` sinon ou si flou ; `reference` nulle si plusieurs candidats restent possibles ; `pages` = numéros de résultats (fabricant, fiche technique, comparatif) ; `seller_question` si un critère décisif reste non visible ; `retry_query` si une recherche précise trancherait ; le titre n'est pas une preuve ; JSON au schéma `IdentifyOut`.
- `FULL_PROMPT_V3` = `FULL_PROMPT_ATTRIBUTES` + un paragraphe sur le bloc `<identification>` : s'en servir pour le prix du marché ; `title_mismatch` est un signal fort ; une identification incertaine appelle la prudence sur le prix ; bloc absent = analyser comme avant.

- [ ] **Step 1: Tests** dans `test_migration_0011.py` :
  - `test_each_step_has_active_v1` : `pipeline_steps.active_prompt_version_id` pointe une version `step = code`, `version = 1`, texte = constante.
  - `test_full_v3_activated_when_0009_active` et `test_full_v3_not_activated_when_admin_chose_another` (insérer et activer une autre version `full` avant l'upgrade).
  - `test_prompts_within_admin_bounds` : chaque texte fait 200 à 20 000 caractères.
  - `test_upgrade_is_idempotent_after_downgrade`.
- [ ] **Step 2: Lancer** `uv run pytest tests/test_migration_0011.py -q` — attendu : FAIL.
- [ ] **Step 3: Écrire la migration 0011** (même structure que 0009 : insertion idempotente, `_check_active_prompt_fk`, downgrade qui désactive puis supprime les versions qu'elle a créées).
- [ ] **Step 4: Lancer** `uv run pytest -q` — attendu : vert.
- [ ] **Step 5: Commit** `feat(api): prompts des étapes d'identification et prompt full v3`.

### Task 3: Client LLM, sortie structurée générique

**Files:**
- Modify: `services/api/src/radarnaque_api/llm/client.py`
- Test: `services/api/tests/test_llm_client.py`

**Interfaces:**
- Produces:
  - `ReasoningEffort = Literal["none", "low", "medium", "high"]` (réutiliser celui de `providers.py` s'il existe).
  - `@dataclass class StepResult[T: BaseModel]: output: T; tokens_in: int; tokens_out: int; cost_usd_micros: int; raw_text: str = ""; system_prompt: str = ""; reasoning_text: str = ""`.
  - `LLMClient.complete(self, *, model: str, system_prompt: str, messages: list[dict], output: type[T], schema_name: str, reasoning: ReasoningEffort | None = None, on_event: EventSink | None = None) -> StepResult[T]` (ajouté au `Protocol`).
  - `OpenAICompatibleClient.final_system_prompt(system_prompt: str, output: type[BaseModel] = LLMAnalysis) -> str`.
- `analyze()` garde sa signature et son comportement ; `complete()` et `analyze()` partagent une boucle privée paramétrée par le validateur et le schéma (`strict_json_schema(output)`, mis en cache par type). `complete()` n'a jamais d'outil : un seul tour, une nouvelle tentative (mêmes règles que `analyze`). `reasoning=None` garde le réglage du fournisseur ; une autre valeur le remplace (`"none"` retire `reasoning` des deux API).

- [ ] **Step 1: Tests** (respx, comme les tests existants de `analyze`) :
  - `test_complete_returns_validated_output_and_usage` : modèle `class Out(BaseModel): name: str`, réponse `{"name":"x"}` → `result.output.name == "x"`, tokens et coût de l'usage.
  - `test_complete_sends_schema_named_and_strict` : en `json_schema`, `response_format.json_schema.name == schema_name` et `schema == strict_json_schema(Out)`.
  - `test_complete_json_object_appends_schema_to_prompt`.
  - `test_complete_reasoning_override_none_drops_reasoning` (fournisseur à `low`, appel `reasoning="none"` → aucune clé `reasoning`) et `test_complete_reasoning_override_high`.
  - `test_complete_retries_once_on_invalid_json_then_raises_invalid_response`.
  - `test_analyze_unchanged` : les tests existants de `analyze` passent sans modification.
- [ ] **Step 2: Lancer** `uv run pytest tests/test_llm_client.py -q` — attendu : FAIL sur les nouveaux tests.
- [ ] **Step 3: Implémenter** `complete()` et la boucle commune dans `client.py` ; ajouter `complete` au `FakeLLM` de `tests/test_scan_service.py` (renvoie `self.step_outputs[schema_name]`, compte les appels dans `self.step_calls`).
- [ ] **Step 4: Lancer** `uv run pytest -q` — attendu : vert.
- [ ] **Step 5: Commit** `feat(api): appel LLM à sortie structurée générique (complete)`.

### Task 4: Photos à résolution réglable

**Files:**
- Modify: `services/api/src/radarnaque_api/images.py`
- Test: `services/api/tests/test_images.py`

**Interfaces:**
- Produces: `fetch_images(urls, allowed_suffixes, *, http, resolve=default_resolve, limit=MAX_IMAGES, max_side: int = MAX_SIDE) -> list[str]` ; `_to_jpeg(data: bytes, max_side: int = MAX_SIDE)`.

- [ ] **Step 1: Tests** : `test_fetch_images_respects_max_side` (PNG 2000×1000, `max_side=1280` → JPEG 1280×640) et `test_default_max_side_is_768`.
- [ ] **Step 2: Lancer** `uv run pytest tests/test_images.py -q` — attendu : FAIL.
- [ ] **Step 3: Implémenter** le paramètre (passé à `image.draft` et `thumbnail`) et mettre à jour la docstring du module (« 768 px par défaut »).
- [ ] **Step 4: Lancer** `uv run pytest tests/test_images.py -q` — attendu : PASS.
- [ ] **Step 5: Commit** `feat(api): taille des photos réglable`.

### Task 5: Lecteur de pages

**Files:**
- Create: `services/api/src/radarnaque_api/pages.py`
- Modify: `services/api/src/radarnaque_api/main.py` (client `app.state.http_pages = httpx.AsyncClient(trust_env=False, follow_redirects=False)`, fermé à l'arrêt)
- Test: `services/api/tests/test_pages.py`

**Interfaces:**
- Consumes: `images._is_public`, `images.default_resolve`, `images.Resolver` (rendre `_is_public` public sous le nom `is_public_address`, en gardant l'alias).
- Produces:
  - `@dataclass(frozen=True) class PageText: url: str; domain: str; title: str; text: str`.
  - `async def read_page(url: str, *, http: httpx.AsyncClient, resolve: Resolver = default_resolve) -> PageText | None` (5 s ; `None` pour tout refus ou échec, jamais d'exception sauf `CancelledError`).
  - `async def read_pages(urls: list[str], *, http, resolve=default_resolve, total_timeout_s: float = 12.0) -> list[PageText]` (en parallèle, pages réussies dans l'ordre des URL).
  - `def wrap_page(n: int, page: PageText) -> str` → `<page_web n="…" domaine="…">…</page_web>`.
- Connexion à l'adresse vérifiée : la requête vise `https://<ip>/<chemin>` avec l'en-tête `Host` et l'extension httpcore `sni_hostname` (le certificat est vérifié contre le nom d'hôte). Vérifier l'API exacte dans la doc httpx/httpcore (context7) avant d'écrire. Corps lu brut (`aiter_raw`), réponse compressée refusée comme dans `images.py`, ou décompressée à la main avec une borne de 1 Mo en sortie. Extraction du texte : `html.parser` de la bibliothèque standard, retrait de `script`, `style`, `nav`, `footer`, `noscript` et des commentaires, `<title>` gardé, espaces réduits, 8 000 caractères. Décodage : charset de l'en-tête, sinon UTF-8 avec `errors="replace"`.

- [ ] **Step 1: Tests** (respx, résolveur factice comme `FakeResolver`) :
  - `test_reads_html_and_strips_scripts` : titre et texte ; aucun contenu de `<script>`.
  - `test_refuses_http_scheme_and_other_ports` → `None`, aucune requête.
  - `test_refuses_private_addresses` : `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `::1`, `fd00::1`, et un nom qui résout vers `192.168.1.10` → `None`, aucune requête.
  - `test_redirect_to_private_address_is_refused` et `test_more_than_two_redirects_is_refused`.
  - `test_connects_to_verified_ip_with_host_and_sni` : la requête respx vise l'IP, `Host` = le nom, extension `sni_hostname` = le nom.
  - `test_body_over_1mb_is_cut_off` → `None` ; `test_gzip_response_cannot_exceed_1mb`.
  - `test_non_html_content_type_is_refused` (`application/pdf`).
  - `test_text_is_cut_to_8000_chars`.
  - `test_read_pages_keeps_order_and_skips_failures` et `test_read_pages_total_timeout` (une page lente : les autres sont rendues dans les 12 s).
  - `test_wrap_page_escapes_closing_tag` : un texte contenant `</page_web>` ne ferme pas le bloc.
- [ ] **Step 2: Lancer** `uv run pytest tests/test_pages.py -q` — attendu : FAIL.
- [ ] **Step 3: Implémenter** `pages.py` (docstring de module sur le modèle de `images.py`, y compris ce qui est couvert du DNS rebinding grâce à la connexion à l'IP vérifiée).
- [ ] **Step 4: Lancer** `uv run pytest tests/test_pages.py tests/test_images.py -q` — attendu : PASS.
- [ ] **Step 5: Commit** `feat(api): lecteur de pages web sûr contre les SSRF`.

### Task 6: Sorties des étapes et messages

**Files:**
- Create: `services/api/src/radarnaque_api/identify/__init__.py`, `identify/schemas.py`, `identify/payload.py`
- Test: `services/api/tests/test_identify_payload.py`

**Interfaces:**
- Produces, dans `identify/schemas.py` (Pydantic, tous les champs requis pour le mode strict, `None` autorisé là où c'est écrit) :
  - `ReadPhotosObject(role: Literal["main","accessory"], category: str, brand: str | None, candidates: list[NonEmptyStr] (1–3), relative_value: int (0–100))`.
  - `Clue(text: NonEmptyStr, photo: int (1–4))`.
  - `ReadPhotosOut(status: Literal["ok","nothing"], objects: list[ReadPhotosObject] (≤4), clues: list[Clue] (≤10), read_reference: str | None, hint_criteria: list[NonEmptyStr] (≤6), photo_observations: list[NonEmptyStr] (≤6), title_mismatch: str | None)` ; validateur : `status == "ok"` ⇒ exactement un objet `main`.
  - `ExpectedValue(candidate: NonEmptyStr, fr: NonEmptyStr, nl: NonEmptyStr)`.
  - `ExtractedCriterion(kind: Literal["photo","ask_seller","invisible"], decisive: bool, fr: NonEmptyStr, nl: NonEmptyStr, expected: list[ExpectedValue] (≤3), sources: list[int] (1–5 éléments))`.
  - `CriteriaOut(criteria: list[ExtractedCriterion] (≤8))`.
  - `CheckOut(criterion: int, observation: Literal["seen_match","seen_contrary","not_visible"], photo: int | None)`.
  - `IdentifiedObjectOut(object: int, checks: list[CheckOut], reference: str | None, remaining: list[NonEmptyStr] (≤3), pages: list[int] (≤3))`.
  - `IdentifyOut(objects: list[IdentifiedObjectOut], seller_question: Bilingual | None, retry_query: str | None)` (`Bilingual` de `llm/client.py`).
  - Vues de la base de critères (dataclasses, remplies par la tâche 8) : `@dataclass(frozen=True) class StoredCriterion: id: int; position: int; kind: Literal["photo","ask_seller"]; decisive: bool; fr: str; nl: str; expected: dict[str, dict[str, str]]; sources: tuple[tuple[str, str, str], ...]` (url, title, domain), propriété `single_source` ; `@dataclass(frozen=True) class CriteriaSetView: id: int; status: Literal["auto","verified"]; criteria: tuple[StoredCriterion, ...]`.
  - Noms de schéma : `SCHEMA_READ_PHOTOS = "radarnaque_read_photos"`, `SCHEMA_CRITERIA = "radarnaque_criteria"`, `SCHEMA_IDENTIFY = "radarnaque_identify"`.
- Produces, dans `identify/payload.py` :
  - `build_read_photos_messages(listing: ListingIn, images: list[str]) -> list[dict]` : mêmes faits masqués que `llm.payload.build_messages` (réutiliser ses fonctions de liste blanche, sans les signaux des règles), photos numérotées de 1 à n.
  - `build_criteria_messages(candidates: list[str], hints: list[str], pages: list[PageText], hits: list[SearchHit]) -> list[dict]` : candidats, indices « à confirmer », pages numérotées (`wrap_page`) puis extraits numérotés à la suite. **Aucun paramètre d'annonce.**
  - `build_identify_messages(listing: ListingIn, images: list[str], objects: list[ReadPhotosObject], criteria: dict[int, list[StoredCriterion]], hits: list[SearchHit]) -> list[dict]` : critères `photo` numérotés par objet, résultats numérotés (titre, domaine, extrait).
  - `format_identification_block(identification: IdentificationOut, price_hits: list[SearchHit]) -> str` → bloc `<identification>` pour `scam`.

- [ ] **Step 1: Tests** :
  - `test_read_photos_out_requires_one_main_object` (deux `main` → `ValidationError`).
  - `test_strict_schemas_build` : `strict_json_schema` accepte les trois modèles (aucun `$ref`, `additionalProperties: false`).
  - `test_read_photos_messages_mask_contacts_and_hide_seller_identity` (même assertion que `test_payload.py` pour le téléphone et l'email).
  - `test_criteria_messages_never_contain_listing_text` : la signature n'a aucun paramètre d'annonce ; avec des candidats et des pages, aucun texte d'une annonce de test n'apparaît.
  - `test_identify_messages_number_criteria_and_hits`.
  - `test_identification_block_lists_reference_confidence_mismatch_and_prices`.
- [ ] **Step 2: Lancer** `uv run pytest tests/test_identify_payload.py -q` — attendu : FAIL.
- [ ] **Step 3: Implémenter** `schemas.py` et `payload.py`.
- [ ] **Step 4: Lancer** — attendu : PASS.
- [ ] **Step 5: Commit** `feat(api): sorties et messages des étapes d'identification`.

### Task 7: Indice de confiance

**Files:**
- Create: `services/api/src/radarnaque_api/identify/confidence.py`
- Test: `services/api/tests/test_identify_confidence.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class CheckEvidence: decisive: bool; single_source: bool; observation: Literal["seen_match","seen_contrary","not_visible"]` (critères `photo` seulement).
  - `@dataclass(frozen=True) class ObjectEvidence: candidate_count: int; reference: str | None; checks: tuple[CheckEvidence, ...]; reference_read_and_found: bool; photos: int; unsourced: bool; criteria_step: bool; verified: bool`.
  - `def object_confidence(e: ObjectEvidence) -> int`.
  - `Level = Literal["sure","probable","uncertain"]` ; `def level_of(confidence: int, reference: str | None) -> Level`.
  - `def overall_status(main_level: Level | None) -> Literal["identified","uncertain","none"]` (`None` : rien d'identifiable).

Algorithme (spec §4), dans cet ordre :
```
if candidate_count == 1: c = 85
else:
    poids d'un check = (1 si decisive sinon 1/3) × (0,5 si single_source sinon 1)
    total = somme des poids ; vus = somme des poids des seen_match
    c = 40 si total == 0 sinon floor(40 + 55 × vus / total + 0,5)   # arrondi, ,5 vers le haut
if reference_read_and_found: c = max(c, 95)
if un check seen_contrary: c = min(c, 50)
if un check decisive en not_visible: c = min(c, 70)
if photos <= 1 and not reference_read_and_found: c = min(c, 85)
if unsourced: c = min(c, 70)
if not criteria_step and candidate_count > 1: c = min(c, 84)
if verified: c += 5
c = min(c, 99)
if reference is None: c = min(c, 59)
```

- [ ] **Step 1: Tests** (`pytest.mark.parametrize`, un cas par ligne) :
  - un seul candidat → 85 ; un seul candidat et une seule photo → 85 ; avec `verified` → 90 ;
  - 2 décisifs vus sur 2 → 95 ; 1 vu et 1 `not_visible` sur 2 décisifs → 68 (`floor(67,5 + 0,5)`, sous le plafond de 70) ;
  - 2 décisifs vus sur 2, l'un d'une seule source → `round(40 + 55 × 1,5/1,5)` = 95 ;
  - 1 décisif vu, 1 non décisif `not_visible` → `round(40 + 55 × 1/(4/3))` = 81 ;
  - un `seen_contrary` → 50 au plus ;
  - référence lue et trouvée, rien d'autre → 95 ; avec une seule photo → 95 (pas de plafond 85) ;
  - `unsourced` avec 2 décisifs vus → 70 ;
  - accessoire sans `criteria_step`, 2 candidats → 84 au plus ;
  - `verified` à 97 → 99 ;
  - `reference=None` → 59 au plus et `level_of` → `uncertain` ;
  - aucun critère et 2 candidats → 40.
  - `level_of` : 85 → `sure`, 84 → `probable`, 60 → `probable`, 59 → `uncertain`.
- [ ] **Step 2: Lancer** `uv run pytest tests/test_identify_confidence.py -q` — attendu : FAIL.
- [ ] **Step 3: Implémenter** `confidence.py` (constantes nommées en tête du module : `SINGLE_CANDIDATE = 85`, `FLOOR_READ_REFERENCE = 95`, etc.).
- [ ] **Step 4: Lancer** — attendu : PASS.
- [ ] **Step 5: Commit** `feat(api): indice de confiance de l'identification`.

### Task 8: Base de critères partagée

**Files:**
- Create: `services/api/src/radarnaque_api/identify/criteria_store.py`
- Test: `services/api/tests/test_criteria_store.py`

**Interfaces:**
- Produces:
  - `def candidates_key(candidates: list[str]) -> str` : chaque nom en minuscules, accents retirés (`unicodedata` NFKD), espaces réduits, triés, sans doublon, joints par `" | "`.
  - `StoredCriterion` et `CriteriaSetView` viennent de `identify/schemas.py` (tâche 6).
  - `async def valid_criteria(session, key: str, at: datetime, ttl: timedelta) -> CriteriaSetView | None` (expirée : `refreshed_at + ttl <= at`, sauf `verified`).
  - `async def lock_criteria(session, key: str) -> None` : `pg_advisory_xact_lock(hashtextextended('criteria:' || key, 0))`.
  - `async def save_criteria(session, key: str, candidates: list[str], extracted: CriteriaOut, pages: list[PageText], at: datetime) -> CriteriaSetView` : crée ou rafraîchit sur place (critères remplacés, `refreshed_at = at`, `status` gardé) ; écarte les critères `invisible`, ceux sans source valide (numéro hors des pages) et ceux dont `expected` ne cite aucun candidat ; garde au plus 8 critères.

- [ ] **Step 1: Tests** (base testcontainers, fixture `engine` comme `test_scan_service.py`) :
  - `test_candidates_key_is_order_and_accent_insensitive` (`["Steam Deck OLED", "steam deck lcd"]` et `["Steam  Deck LCD", "Steam Deck OLÉD"]` → même clé).
  - `test_save_then_valid_criteria_round_trip`.
  - `test_invisible_and_unsourced_criteria_are_dropped`.
  - `test_expired_set_is_not_valid_but_verified_never_expires`.
  - `test_refresh_replaces_criteria_and_keeps_verified_status`.
  - `test_lock_serializes_two_sessions` (la seconde attend la première).
- [ ] **Step 2: Lancer** `uv run pytest tests/test_criteria_store.py -q` — attendu : FAIL.
- [ ] **Step 3: Implémenter** `criteria_store.py`.
- [ ] **Step 4: Lancer** — attendu : PASS.
- [ ] **Step 5: Commit** `feat(api): base de critères de distinction partagée`.

### Task 9: Recherches de l'identification

**Files:**
- Create: `services/api/src/radarnaque_api/identify/research.py`
- Test: `services/api/tests/test_identify_research.py`

**Interfaces:**
- Consumes: `SearchBackend`, `clean_query`, `hit_domains` (`search.py`) ; `read_pages`, `PageText` (tâche 5) ; événements `SearchStarted`, `SearchDone` (`llm/events.py`).
- Produces (événements, utilisés par les tâches 10 et 11) : dans `llm/events.py`, `@dataclass(frozen=True) class PageRead: domain: str; ok: bool` et `class CriteriaCached: count: int`, ajoutés à `LLMEvent` ; dans `services/scan_stream.py`, `Stage.stage` étendu à `Literal["cache","photos","analyzing","reading_photos","criteria","identifying","retrying"]` et `StageEventOut.stage` (`schemas.py`) de même.
- Produces:
  - `@dataclass(frozen=True) class Query: text: str; kind: Literal["criteria","price","reference","retry"]`.
  - `def criteria_queries(candidates: list[str], hints: list[str], limit: int) -> list[Query]` : modèles fixes, dans cet ordre, tronqués à `limit` : `"{a} vs {b} différence"`, `"how to tell {a} from {b}"`, `"{a} {b} {hint}"` (hint = premier indice). Avec 3 candidats, `a`/`b` = les deux premiers.
  - `def reference_query(candidate: str) -> Query` → `"{candidate} fiche technique"` ; `def price_query(candidate: str) -> Query` → `"{candidate} prix occasion"`.
  - `@dataclass class SearchOutcome: hits: dict[Query, list[SearchHit]]; pages: list[PageText]; records: list[tuple[str, str, list[str]]]` (requête, kind, domaines lus).
  - `async def run_searches(queries: list[Query], *, backend: SearchBackend | None, http_pages: httpx.AsyncClient, max_pages: int, page_kinds: frozenset[str], on_event: EventSink | None, first_id: int = 1, resolve: Resolver = default_resolve) -> SearchOutcome` : requêtes en parallèle (`asyncio.gather`, un échec = liste vide), puis lecture des `max_pages` premières URL distinctes des requêtes dont le kind est dans `page_kinds`, hors domaines `2ememain.be`, `2dehands.be`, `facebook.com` (et sous-domaines). Événements : `SearchStarted`/`SearchDone` par requête (aspect `model` pour `criteria`/`reference`/`retry`, `price` pour `price`), `PageRead` par page tentée.

- [ ] **Step 1: Tests** (faux backend qui enregistre les requêtes) :
  - `test_criteria_queries_order_and_limit` (limite 2 → les deux premiers modèles).
  - `test_queries_are_cleaned` (un email dans un nom de candidat est masqué).
  - `test_searches_run_in_parallel` (deux requêtes à 0,2 s chacune → moins de 0,35 s au total).
  - `test_backend_none_or_failing_gives_empty_hits`.
  - `test_pages_skip_marketplace_domains_and_respect_max_pages`.
  - `test_events_emitted_in_order` (`search` puis `search_done` par requête, puis `page_read`).
- [ ] **Step 2: Lancer** `uv run pytest tests/test_identify_research.py -q` — attendu : FAIL.
- [ ] **Step 3: Implémenter** `research.py`.
- [ ] **Step 4: Lancer** — attendu : PASS.
- [ ] **Step 5: Commit** `feat(api): recherches et lecture de pages de l'identification`.

### Task 10: Pipeline d'identification et persistance

**Files:**
- Create: `services/api/src/radarnaque_api/identify/store.py`, `identify/pipeline.py`
- Modify: `services/api/src/radarnaque_api/schemas.py` (`IdentificationOut` et ses sous-modèles)
- Test: `services/api/tests/test_identify_pipeline.py`

**Interfaces:**
- Consumes: tâches 3 à 9 ; `fetch_images` ; `ActiveSetup` (`scan_store.py`) comme modèle de `StepSetup`.
- Produces, dans `schemas.py` (camelCase en sortie, comme `AnalysisResultOut`) :
  - `CriterionCheckOut(text: LocalizedTextOut, observation: str, photo: int | None, sources: list[PageLinkOut])`, `PageLinkOut(url: str, title: str, domain: str)`.
  - `IdentifiedObjectPublicOut(role, label, reference: str | None, confidence: int, level, remaining: list[str], checks: list[CriterionCheckOut], pages: list[PageLinkOut])`.
  - `IdentificationSearchOut(query: str, kind: str, pagesRead: list[str])`.
  - `IdentificationOut(identification_id, status, confidence, level, objects, seller_question: LocalizedTextOut | None, title_mismatch: str | None, searches, verified_criteria: bool, unsourced: bool, images_analyzed: int, from_cache: bool, identified_at: datetime, remaining: RemainingOut | None = None, debug: IdentifyDebugOut | None = None)` ; `IdentifyDebugOut` : par étape, modèle, prompt envoyé, réponse brute, durée, tokens, coût.
- Produces, dans `identify/store.py` :
  - `@dataclass(frozen=True) class StepSetup: step: str; model_id: int; provider: str; slug: str; prompt_version_id: int; system_prompt: str`.
  - `async def active_steps(session) -> dict[str, StepSetup] | None` (`None` si une étape n'a pas de prompt actif).
  - `def config_hash(steps: dict[str, StepSetup]) -> str` (SHA-256 de `canonical_json` des `(step, model_id, prompt_version_id)` triés).
  - `def identify_input_hash(scan: ScanIn, photos: int, image_side: int) -> str` : faits de l'annonce envoyés à `read_photos`/`identify` (les mêmes que `input_hash` sans les signaux ni `partial`), plus `photos` et `image_side`. Invariant R12 : tout champ envoyé est couvert.
  - `@dataclass(frozen=True) class IdentificationKey: snapshot_id: int; config_hash: str; input_hash: str` avec `lock_name()`.
  - `async def valid_identification_id(session, key, at, ttl) -> int | None`.
  - `async def save_identification(session, key, run: PipelineRun, at) -> int` (insertion ou rafraîchissement sur place, objets/checks/pages/recherches remplacés ; une ligne `llm_calls` par appel du `run`, avec `step` et `identification_id`, ou `criteria_set_id` pour `criteria`).
  - `async def load_identification(session, identification_id: int) -> IdentificationOut` (sans `remaining`, `from_cache` ni `debug`).
  - `def identification_digest(out: IdentificationOut) -> str` (statut, confiance, références et niveaux des objets, `title_mismatch` ; entre dans l'`input_hash` de `scam`).
- Produces, dans `identify/pipeline.py` :
  - `@dataclass class PipelineContext: steps: dict[str, StepSetup]; llm_for: Callable[[str], LLMClient]; search: SearchBackend | None; http_images: httpx.AsyncClient; http_pages: httpx.AsyncClient; resolve: Resolver; maker: async_sessionmaker[AsyncSession]; settings: IdentifySettings; image_host_suffixes: list[str]; photos: int; at: datetime; escalation: StepSetup | None`.
  - `@dataclass(frozen=True) class IdentifySettings` : les huit réglages, lus une fois dans `settings`.
  - `@dataclass class PipelineRun` : sorties des étapes, objets calculés (référence, confiance, niveau, checks, pages vérifiées), recherches, appels LLM (`step`, `model_id`, `prompt_version_id`, tokens, coût, `criteria_set_id`), `retried`, `unsourced`, `images_analyzed`, traces pour le debug.
  - `async def run_pipeline(ctx: PipelineContext, scan: ScanIn, on_event: ScanEventSink | None) -> PipelineRun`.

Déroulé de `run_pipeline` (spec §3) :
1. `Stage("photos", n)` si `n > 0`, puis `fetch_images(..., max_side=settings.identify_image_side, limit=ctx.photos)` ; les photos restent en mémoire.
2. `Stage("reading_photos")`, `complete(output=ReadPhotosOut, reasoning="none")`. `status == "nothing"` → fin, statut `none`.
3. Objets visés par `criteria` : le `main` et l'accessoire de plus grand `relative_value` (au plus 2). Pour chacun : base valide (`valid_criteria`) → `CriteriaCached(count)` ; un seul candidat, ou `read_reference` qui désigne un seul candidat (sous-chaîne normalisée) → étape sautée ; sinon, sous `lock_criteria` dans sa propre transaction, relire la base puis `Stage("criteria")`, `run_searches` (`criteria_queries` avec `criteria_max_searches`, `page_kinds={"criteria"}`, `max_pages=criteria_max_pages`), `complete(output=CriteriaOut, reasoning="none")`, `save_criteria`. Un `LLMError` de `criteria` → critères non sourcés tirés de `hint_criteria` (`kind="photo"`, `decisive=False`), `unsourced=True`, rien d'enregistré.
4. En parallèle de l'étape 3 : `run_searches` des requêtes `reference_query` (objets visés) et `price_query` (candidat le plus probable du `main`), sans lecture de pages.
5. `Stage("identifying")`, `complete(output=IdentifyOut, reasoning=None)`.
6. Calcul de la confiance de chaque objet (`object_confidence`) ; `reference_read_and_found` = `read_reference` contenue (normalisée) dans un titre ou un extrait des résultats ; pages = numéros valides des résultats, URL revérifiées.
7. Relance (une seule) : confiance du `main` < `identify_retry_threshold` et `retry_query` non nulle → `Stage("retrying")`, `run_searches([Query(retry_query, "retry")], max_pages=1, page_kinds={"retry"})`, `complete(CriteriaOut)` sur la page lue et les extraits pour compléter les critères (enregistrés dans la base comme à l'étape 3), puis `identify` sur `ctx.escalation` s'il existe, sinon le même modèle. Recalcul.
8. Statut global (`overall_status`) ; `IdentificationReady` est émis par l'appelant après l'enregistrement.

- [ ] **Step 1: Tests** (base testcontainers, `FakeLLM.complete` qui rend des sorties préparées par schéma, faux backend de recherche, respx pour les photos et les pages) :
  - `test_full_pipeline_identifies_with_criteria_from_pages` : deux candidats, pages lues, critères enregistrés, deux `seen_match` décisifs → `identified`, confiance 95, 2 pages renvoyées avec URL des résultats.
  - `test_criteria_reused_from_base_skips_searches_and_llm` (seconde annonce du même ensemble : aucun appel `criteria`, événement `criteria_cached`).
  - `test_single_candidate_skips_criteria`.
  - `test_read_reference_found_in_results_gives_95`.
  - `test_nothing_status_stops_after_read_photos` (un seul appel LLM, statut `none`).
  - `test_listing_without_photos_runs_text_only_and_caps_confidence` (Review Focus 2).
  - `test_criteria_llm_failure_falls_back_to_unsourced_hints` (confiance ≤ 70, `unsourced`, rien en base).
  - `test_search_down_still_identifies` (backend qui lève).
  - `test_retry_runs_once_with_escalation_model` (deux appels `identify`, le second sur le modèle d'escalade ; aucune troisième).
  - `test_page_numbers_out_of_range_are_dropped` et `test_model_cannot_inject_urls` (une URL dans `retry_query` ou dans les sorties n'apparaît pas dans les pages).
  - `test_save_and_load_round_trip_with_llm_calls_per_step`.
  - `test_identify_input_hash_covers_every_field_sent` (sur le modèle de `test_hashing.py`).
  - `test_two_pipelines_same_candidates_search_once` (verrou par `candidates_key`).
- [ ] **Step 2: Lancer** `uv run pytest tests/test_identify_pipeline.py -q` — attendu : FAIL.
- [ ] **Step 3: Implémenter** `schemas.py` (sous-modèles), `store.py`, puis `pipeline.py`.
- [ ] **Step 4: Lancer** `uv run pytest -q` — attendu : vert.
- [ ] **Step 5: Commit** `feat(api): pipeline d'identification et persistance`.

### Task 11: Événements du flux

**Files:**
- Modify: `services/api/src/radarnaque_api/services/scan_stream.py`, `schemas.py`, `packages/shared/src/stream.ts`
- Test: `services/api/tests/test_scan_stream.py`

**Interfaces:**
- Produces:
  - Dans `scan_stream.py` : `@dataclass(frozen=True) class IdentificationReady: identification: IdentificationOut` et `class IdentificationFailed: code: str`, ajoutés à l'union `ScanEvent` (`PageRead`, `CriteriaCached` et les nouvelles étapes viennent de la tâche 9).
  - SSE : `page_read` `{domain, ok}`, `criteria_cached` `{count}`, `identification` (`IdentificationOut` en camelCase, sans `debug` sauf superuser), `identification_error` `{code}`.
  - Ruling : l'échec de l'identification pendant un scan est un événement **`identification_error`**, pas `error` (spec §9) : l'extension actuelle traite `error` comme la fin du flux, alors que l'arnaque continue.
  - `stream_scan` généralisé : le type du résultat final est `AnalysisResultOut | IdentificationOut` (événement final `result` dans les deux cas).
  - `stream.ts` : miroir des nouveaux types (`StreamStage` étendu, `PageReadEvent`, `CriteriaCachedEvent`, `IdentificationEvent`).

- [ ] **Step 1: Tests** : `test_sse_of_new_stages`, `test_sse_of_page_read_and_criteria_cached`, `test_sse_of_identification_is_camel_case`, `test_sse_of_identification_error`, `test_stream_of_identification_ends_with_result`.
- [ ] **Step 2: Lancer** `uv run pytest tests/test_scan_stream.py -q` — attendu : FAIL.
- [ ] **Step 3: Implémenter** ; régénérer les types (`scripts/gen-api.sh`) si `IdentificationOut` entre dans le schéma OpenAPI (tâche 13).
- [ ] **Step 4: Lancer** `uv run pytest tests/test_scan_stream.py -q && pnpm --filter shared typecheck` — attendu : PASS.
- [ ] **Step 5: Commit** `feat(api): événements du flux de l'identification`.

### Task 12: Quota, `purpose` et `analyze` inclus

**Files:**
- Modify: `services/api/src/radarnaque_api/services/scans.py` (`_reserve`, `_admit`, `_Admission`), `services/usage.py`
- Test: `services/api/tests/test_identify_quota.py`

**Interfaces:**
- Produces:
  - `ScanPurpose = Literal["identify","analyze"]`.
  - `_reserve(session, user, privileges, scan, at, rate_limit, *, purpose: ScanPurpose, listing_id: int) -> tuple[int, int | None]` → `(event_id, included_by_event_id)`.
  - `_admit(..., purpose: ScanPurpose = "analyze") -> _Admission` ; `_Admission` gagne `purpose`, `listing_id`, `included: bool`, `identify: IdentifySettings` (lus avec les autres réglages).
  - `async def included_identify_event(session, user_id: str, listing_id: int, at: datetime) -> int | None` : sous le verrou de l'utilisateur, l'`identify` du même utilisateur, sur une snapshot de la même annonce, réussi (`identification_results`, aucune `scan_failures`), `created_at > at - 24 h`, sans `analyze` réussi qui le référence déjà (`included_by_event_id`, sans `scan_failures`) ; le plus récent.
  - `compute_usage` : les événements `included_by_event_id is not null` ne comptent pas.
- Règles : un `analyze` inclus passe même avec `remaining == 0` ; un compte illimité n'est jamais marqué inclus (rien à compter) ; le verrou consultatif `rate:{user}` est pris dès qu'un `analyze` cherche un `identify` à inclure, y compris pour le superuser hors production (lecture cohérente).

- [ ] **Step 1: Tests** :
  - `test_identify_consumes_one_scan`.
  - `test_analyze_after_own_identify_is_included_once` (premier `analyze` inclus, `remaining` inchangé ; second `analyze` décompté).
  - `test_analyze_included_even_with_zero_remaining`.
  - `test_failed_identify_does_not_include`.
  - `test_failed_included_analyze_frees_the_identify` (l'`analyze` inclus échoue → un nouvel `analyze` est inclus).
  - `test_identify_older_than_24h_does_not_include`.
  - `test_other_users_identify_does_not_include`.
  - `test_concurrent_identify_and_analyze` (Review Focus 4 : les deux lancés ensemble ; l'`analyze` n'est inclus que si l'`identify` a un `identification_results` au moment de sa réservation ; jamais deux pipelines, compter les appels `read_photos` = 1).
- [ ] **Step 2: Lancer** `uv run pytest tests/test_identify_quota.py -q` — attendu : FAIL.
- [ ] **Step 3: Implémenter**.
- [ ] **Step 4: Lancer** `uv run pytest -q` — attendu : vert.
- [ ] **Step 5: Commit** `feat(api): quota de l'identification et analyse incluse`.

### Task 13: Routes `/api/identify` et arnaque nourrie par l'identification

**Files:**
- Create: `services/api/src/radarnaque_api/services/identify_service.py`
- Modify: `services/api/src/radarnaque_api/routes/scans.py` (ou nouveau `routes/identify.py`, inclus dans `main.py`), `services/scans.py` (`_serve`), `services/hashing.py` (`input_hash`), `llm/payload.py`, `schemas.py` (`AnalysisResultOut.identification`), `infra/Caddyfile*` (`flush_interval -1` sur `/api/identify/stream`)
- Test: `services/api/tests/test_identify_routes.py`, `tests/test_scan_service.py`, `apps/extension/lib/scan-events.test.ts`

**Interfaces:**
- Consumes: `run_pipeline`, `store.*` (tâche 10), `_admit`/`_reserve` (tâche 12), `stream_scan` (tâche 11).
- Produces:
  - `IDENTIFY_TIMEOUT_S = 120`.
  - `async def ensure_identification(maker, admission: _Admission, scan: ScanIn, privileges, *, llm_for, http, http_pages, resolve, search, on_event) -> tuple[int, bool] | None` : `(identification_id, from_cache)`, sous le verrou consultatif de la clé ; cache lu sauf `noCache` du superuser ; `Stage("cache")` n'est pas émis pour l'identification (l'événement `identification` porte `fromCache`). `None` : étapes non configurées.
  - `admit_identify(...)`, `serve_identify(admitted, on_event, *, timeout_s=IDENTIFY_TIMEOUT_S) -> IdentificationOut` : mêmes garanties que `admit_scan`/`serve_admitted` (refus JSON, remboursement sous `shield`, codes `identify_read_photos`, `identify_resolve`, `timeout`, `configuration`) ; lie l'événement à l'identification (`identification_results`).
  - Routes `POST /api/identify` (`response_model=IdentificationOut`) et `POST /api/identify/stream`, mêmes dépendances et même `_ListingRoute` que les scans.
  - `_serve` du scan : avant le cache d'analyses, `ensure_identification` dans `IDENTIFY_TIMEOUT_S` ; succès → `IdentificationReady` émis, `input_hash(scan, photos, identification_digest)`, `build_messages(..., identification_block=...)`, photos envoyées seulement si `scam_sends_photos` (sinon `photos = 0` pour l'arnaque), `WebSearchTool(..., max_searches=min(1, max_web_searches))` ; échec (toute exception sauf annulation) → `IdentificationFailed(code)` (SSE `identification_error`), puis l'arnaque comme aujourd'hui (photos, `max_web_searches`). L'échec n'est pas enregistré en `scan_failures` (le scan, lui, continue).
  - `input_hash(scan, images_requested, identification_digest: str | None = None)`.
  - `build_messages(listing, rules, images, *, today, images_sent, identification_block: str | None = None)`.
  - `AnalysisResultOut.identification: IdentificationOut | None = None`.

- [ ] **Step 1: Tests** :
  - `test_identify_route_returns_identification_and_consumes_one`.
  - `test_identify_stream_emits_stages_then_identification_then_result`.
  - `test_identify_refusals_are_json` (402 sans abonnement, 402 quota épuisé, 422 annonce invalide, 429).
  - `test_identify_failure_gives_back_with_reason` (`identify_read_photos`).
  - `test_identify_timeout_gives_back` (`timeout_s` réduit).
  - `test_identify_served_from_cache_for_second_user` (aucun appel LLM, `fromCache` vrai, décompté).
  - `test_scan_runs_identification_first_then_scam_without_photos` (`FakeLLM` : `read_photos`, `criteria`, `identify`, puis `analyze` sans image ; `result.identification` rempli).
  - `test_scan_reuses_cached_identification`.
  - `test_scam_cache_key_follows_identification` (identification différente → nouvel appel `analyze`).
  - `test_scan_continues_without_identification_on_failure` (photos envoyées, `max_web_searches` gardé, `identification` nul, scan réussi).
  - `test_scan_for_nothing_status_runs_like_before` (Review Focus 3).
  - `test_scam_sends_photos_setting`.
  - `test_superuser_no_cache_reruns_identification_but_not_criteria`.
  - Extension, `scan-events.test.ts` : `ignores identification events and keeps parsing the result` (un flux avec `stage: reading_photos`, `page_read`, `identification`, `identification_error`, puis un `result` qui porte `identification` → seuls les événements connus sortent, le résultat est accepté par `isAnalysisResult`) — Review Focus 1.
- [ ] **Step 2: Lancer** `uv run pytest tests/test_identify_routes.py tests/test_scan_service.py -q && pnpm --filter extension test -- scan-events` — attendu : FAIL sur les nouveaux tests (le test d'extension doit passer d'emblée : s'il échoue, corriger le parseur pour ignorer ce qu'il ne connaît pas).
- [ ] **Step 3: Implémenter**, puis `scripts/gen-api.sh` pour régénérer `packages/shared/src/api.ts`.
- [ ] **Step 4: Lancer** `uv run pytest -q && pnpm --filter extension test && pnpm --filter shared typecheck` — attendu : vert.
- [ ] **Step 5: Commit** `feat(api): routes de l'identification et arnaque nourrie par l'identification`.

### Task 14: Admin IA, une configuration par étape

**Files:**
- Modify: `services/api/src/radarnaque_api/services/admin_ai.py`, `routes/admin_ai.py`, `admin_schemas.py`
- Modify: `apps/admin/src/` (écran IA : section « Étapes de l'identification » et réglages)
- Test: `services/api/tests/test_admin_ai.py`, tests Vitest de l'écran IA

**Interfaces:**
- Produces (API) :
  - `AiOverviewOut.steps: list[StepOut]`, `StepOut(code, active_model_id, active_prompt_id, prompts: list[PromptVersionOut])` ; `AiSettingsOut`/`AiSettingsIn` gagnent les huit réglages (camelCase, bornes des Global Constraints, `422` au-delà).
  - `POST /api/admin/ai/steps/{step}/active-model` `{modelId}` ; `POST /api/admin/ai/steps/{step}/prompts` `{systemPrompt}` (201, `PromptTextOut`) ; `POST /api/admin/ai/steps/{step}/prompts/{id}/activate`. Étape inconnue → `404` ; prompt d'une autre étape → `404`.
  - `admin_actions` : `ai.step_model_set`, `ai.step_prompt_created`, `ai.step_prompt_activated` (`details` = `{ step, from, to }`), et `ai.settings_set` pour les nouveaux réglages (comme les réglages existants).
  - `GET /api/admin/ai/prompts/{id}` sert aussi les prompts d'étape.
- Produces (admin) : une carte par étape (modèle actif en liste déroulante, versions du prompt, « Nouvelle version », « Activer » avec la boîte de confirmation existante) et les nouveaux champs de réglages, avec les mêmes composants que l'écran actuel.

Ruling : l'essai d'une étape (spec §10) est reporté à la partie 3 ; le spec (§11) limite la partie 1 « aux étapes et aux réglages ».

- [ ] **Step 1: Tests API** : `test_overview_lists_three_steps`, `test_set_step_model_logs_action`, `test_create_and_activate_step_prompt`, `test_step_prompt_bounds_200_20000`, `test_unknown_step_404`, `test_settings_new_fields_bounds` (`criteria_ttl_days=0` → 422, `731` → 422, `identify_image_side=767` → 422), `test_non_admin_403`.
- [ ] **Step 2: Tests admin** (Vitest) : la section affiche trois étapes ; changer le modèle appelle la bonne route ; un réglage hors bornes affiche l'erreur.
- [ ] **Step 3: Lancer** `uv run pytest tests/test_admin_ai.py -q && pnpm --filter admin test` — attendu : FAIL.
- [ ] **Step 4: Implémenter** l'API puis l'écran.
- [ ] **Step 5: Lancer** `uv run pytest -q && pnpm --filter admin test` — attendu : vert.
- [ ] **Step 6: Commit** `feat(admin): un modèle et un prompt par étape d'identification`.

### Task 15: Faux fournisseur, bout en bout, évaluation et documentation

**Files:**
- Modify: `scripts/llm-stub.mjs`, `scripts/llm-stub.test.mjs`, `scripts/e2e-lib.ts`, `package.json`
- Create: `scripts/e2e-identify.ts`, `services/api/src/radarnaque_api/identify/eval_cli.py` (commande `radarnaque-eval-identify` dans `pyproject.toml`), entrée `.gitignore` pour `services/api/evals/`
- Modify: `README.md`, `docs/etat-du-projet.md`
- Create: `docs/superpowers/plans/2026-10-23-identification-partie-1-suivi.md`

**Interfaces:**
- `llm-stub.mjs` : répond selon `response_format.json_schema.name` (ou le schéma présent dans le prompt en `json_object`) : `radarnaque_read_photos`, `radarnaque_criteria`, `radarnaque_identify` → sorties fixes valides ; `radarnaque_analysis` → inchangé.
- `pnpm e2e:identify [--no-stream]` : connexion comme `e2e:scan`, puis `POST /api/identify(/stream)`, affiche chaque événement et le résultat.
- `pnpm eval:identify` → `cd services/api && uv run radarnaque-eval-identify evals/identify.jsonl` : lit des lignes `{ "scan": <ScanIn>, "expected": "<référence>" }` (fichier non commité, construit à la main depuis `web-pages/`), lance `run_pipeline` sans quota ni cache sur la configuration active, affiche la justesse (référence attendue contenue, normalisée, dans la référence trouvée), la répartition des niveaux et le coût moyen par étape. N'écrit rien en base hors de la base de critères.

- [ ] **Step 1: Tests** : `llm-stub.test.mjs` (une réponse valide par nom de schéma), `pnpm test:scripts`.
- [ ] **Step 2: Implémenter** le faux fournisseur, `e2e-identify.ts` et `eval_cli.py`.
- [ ] **Step 3: Vérifier** `pnpm test:scripts` (vert) puis, pile de dev lancée avec le fournisseur `stub` : `pnpm e2e:identify` et `pnpm e2e:scan` — attendu : événements `reading_photos` … `identification`, puis `result`.
- [ ] **Step 4: Documenter** : README (routes, réglages, `e2e:identify`, `eval:identify`), `etat-du-projet.md` (section Identification, migrations 0010 et 0011, compte des tests), suivi avec les vérifications à faire sur la vraie pile (OpenRouter et modèles vision réels, SearXNG en prod, lecture de pages derrière le pare-feu du serveur, coût réel par étape, `/privacy` à mettre à jour en partie 3, extension à déployer après l'API).
- [ ] **Step 5: Lancer** toutes les suites : `pnpm test:api && pnpm --filter extension test && pnpm --filter admin test && pnpm --filter site test && pnpm --filter auth test && pnpm test:scripts` — attendu : vert.
- [ ] **Step 6: Commit** `docs: identification du produit, partie 1 (README, état, suivi)` (et `test(scripts): …` pour le faux fournisseur, en commit séparé).
