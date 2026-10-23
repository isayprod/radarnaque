# Identification du produit

*Spec du 23 octobre 2026.* Branche `feat/identification`. Livrée en trois parties (§11).

## 1. But

Radarnaque identifie **la référence exacte** de l'objet vendu, et de ses accessoires, à partir des photos de l'annonce. Il donne un **indice de confiance** et 2-3 **pages de référence**. L'analyse d'arnaque s'appuie ensuite sur cette identification au lieu de deviner le produit.

**Ce que l'utilisateur a demandé :**
- une seconde pastille, « Identifier », lancée et suivie en direct comme l'analyse d'arnaque ;
- l'identification se fonde sur les photos : 4 en Premium (et en essai), 1 en Standard (`plans.max_images`, inchangé) ;
- l'analyse d'arnaque se fait **après** l'identification et réutilise son analyse d'image ;
- les critères qui distinguent deux références viennent **du web**, pas de la mémoire du modèle (exemple de l'utilisateur : la couleur intérieure des joysticks distingue la Steam Deck OLED de la LCD) ;
- un modèle par tâche, et un coût maîtrisé ;
- la durée des caches se règle dans l'admin.

**Hors du périmètre :**
- recherche d'image inversée ;
- annonces sans objet identifiable (immobilier, emploi, animaux, services) : l'identification répond « rien d'identifiable » et s'arrête.

## 2. Décisions validées

| Sujet | Décision |
|---|---|
| Quota | « Identifier » consomme 1 analyse. « Analyser » qui suit l'identification du même utilisateur est inclus (§7). |
| Identification incertaine | Candidats restants, critère manquant et question à poser au vendeur. |
| Base de critères | Utilisée dès l'extraction, signalée « à relire » dans l'admin ; une paire relue est *vérifiée*. |
| Pastilles | Deux pilules côte à côte, chacune avec son panneau. |
| Architecture | Pipeline orchestré par l'API : étapes fixes, sans boucle d'outils pour l'identification. |
| Durée de la base de critères | 6 mois par défaut, réglable. |

## 3. Pipeline

### 3.1 Étapes

| Code | Rôle | Entrée | Modèle conseillé | Photos |
|---|---|---|---|---|
| `read_photos` | Objets, candidats, indices lus, observations utiles à l'arnaque | annonce (titre, description, caractéristiques, catégorie) et photos | vision bon marché, sans réflexion | toutes celles de l'offre |
| `criteria` | Critères de distinction sourcés entre les candidats | noms des candidats seulement, puis le texte des pages lues | texte bon marché | aucune |
| `identify` | Vérification des critères sur les photos, référence et pages | photos, candidats, critères, résultats de recherche | vision moyen, sans réflexion ou réflexion faible | toutes celles de l'offre |
| `scam` | L'analyse d'arnaque actuelle, nourrie par l'identification | annonce, identification, observations photo, résultats « prix » | modèle actif du type `full` | aucune par défaut (réglable) |

**Ordre :**
- « Identifier » : `read_photos` → `criteria` → `identify`.
- « Analyser » : l'identification (lue dans le cache si elle existe), puis `scam`.

**Photos :**
- elles sont téléchargées une seule fois par pipeline et gardées en mémoire pour `read_photos` et `identify` ;
- pour l'identification, leur plus grand côté est réglable (`identify_image_side`, 768 à 1536, défaut 1280) : à 768 px, une étiquette ou un numéro de modèle devient illisible ;
- `scam` les reçoit à 768 px si `scam_sends_photos` est vrai.

### 3.2 `read_photos`

Sortie structurée (JSON strict) :
- **`status`** : `ok` ou `nothing` (rien d'identifiable). `nothing` arrête l'identification avec le statut `none`.
- **`objects`** (au plus 4) : rôle (`main` ou `accessory`), catégorie, marque, 1 à 3 candidats (noms normalisés : marque, modèle, variante, capacité), valeur estimée relative (pour choisir l'accessoire principal).
- **`clues`** : texte lu (étiquette, plaque, boîte, écran), avec le numéro de la photo.
- **`read_reference`** : une référence lue sans ambiguïté (numéro de modèle complet), ou `null`.
- **`hint_criteria`** : critères proposés de mémoire, **à confirmer** ; ils servent seulement à orienter les recherches de `criteria`.
- **`photo_observations`** (pour `scam`) : photo de catalogue, capture d'écran, filigrane d'un autre site, photos incohérentes entre elles, objet absent des photos.
- **`title_mismatch`** : désaccord entre le titre et ce que montrent les photos, ou `null`.

### 3.3 `criteria`

Elle porte sur **l'objet principal et l'accessoire de plus grande valeur**, pas plus.

Elle est **sautée** si :
- la base connaît l'ensemble de candidats normalisé et son entrée n'a pas expiré ;
- l'objet n'a qu'un seul candidat ;
- `read_reference` désigne un seul candidat.

**Déroulé quand elle n'est pas sautée :**
1. **Requêtes, construites par l'API** à partir des candidats et des `hint_criteria` : « A vs B différence », « how to tell A from B », et une requête « prix » sur le candidat le plus probable. Au plus `criteria_max_searches` requêtes (0 à 5, défaut 2), plus celle du prix, lancées **en parallèle** sur SearXNG (`search.py`, cache de 24 h).
2. **Lecture** des `criteria_max_pages` meilleures pages (0 à 5, défaut 3) par le lecteur de pages (§8.1). Un résultat sur un domaine de petites annonces (2ememain, 2dehands, Facebook) n'est pas lu.
3. **Extraction** par le modèle texte. Chaque critère porte :
   - le texte en FR et en NL ;
   - le type : `photo` (vérifiable sur une photo), `ask_seller` (à demander au vendeur) ou `invisible` (écarté) ;
   - la valeur attendue pour chaque candidat (par exemple « anneau du joystick noir » pour l'OLED, « blanc » pour la LCD) ;
   - `decisive` : ce critère suffit seul à trancher ;
   - les sources : numéros des pages qui le donnent.
4. **Enregistrement** dans la base partagée (§5.2), sous un verrou consultatif propre à l'ensemble de candidats : dix annonces de Steam Deck simultanées ne lancent qu'une seule recherche.

**Recherches toujours faites, même quand `criteria` est sautée :**
- une requête « fiche technique » sur le candidat le plus probable de l'objet principal et de l'accessoire de plus grande valeur (au plus 2) ;
- la requête « prix » ;
- elles sont lancées en parallèle et ne coûtent aucun appel au modèle. Elles fournissent les pages de référence, la preuve de `read_reference` (§4) et les prix de `scam`. Le cache de 24 h de `search.py` les sert pour les annonces suivantes du même produit.

**Ce que `criteria` ne voit jamais :** les données de l'annonce. Les requêtes ne contiennent que des noms de produits, toujours passés par `clean_query`.

### 3.4 `identify`

**Entrée :** photos, objets et candidats de `read_photos`, critères de type `photo`, résultats de recherche numérotés (titre, domaine, extrait).

**Sortie, pour chaque objet :**
- **`checks`** : pour chaque critère, `seen_match`, `seen_contrary` ou `not_visible`, avec le numéro de la photo. Un détail flou compte comme `not_visible`.
- **`reference`** : le candidat retenu, ou `null` si plusieurs restent possibles.
- **`remaining`** : les candidats restants.
- **`pages`** : 2-3 numéros de résultats, du site du fabricant à la fiche technique puis au comparatif. **Jamais d'URL** écrite par le modèle.
- **`seller_question`** : en FR et en NL, si un critère `decisive` reste `not_visible` ; sinon `null`.
- **`retry_query`** : une requête ciblée qui trancherait un critère précis, ou `null`.

**Relance (une seule) :**
- **Condition :** la confiance de l'objet principal est sous `identify_retry_threshold` (0 à 100, défaut 60) et `retry_query` n'est pas nulle.
- **Déroulé :** l'API cherche cette requête, lit au plus une page, complète les critères, puis relance `identify`.
- **Escalade :** si `identify_escalation_model_id` est défini, cette relance passe sur ce modèle (aucun par défaut).

### 3.5 `scam`

- **Ce qui ne change pas :** le prompt `full` et son analyse ; il reçoit en plus un bloc `<identification>` :
  - référence, statut et confiance ;
  - candidats restants ;
  - observations photo ;
  - `title_mismatch` ;
  - résultats de la requête « prix ».
- **Recherche :** l'outil `web_search` reste, avec au plus 1 recherche quand l'identification existe (`max_web_searches` reste le plafond sans identification).
- **Nouveau prompt :** une migration ajoute la **version v3** du prompt `full`, qui explique le bloc `<identification>`. Elle traite `title_mismatch` comme un signal fort, et une identification incertaine comme une raison de prudence sur le prix (un prix qui ne colle qu'à l'un des candidats). La v3 n'est activée que si la version livrée en dernier (migration 0009) est encore active.
- **Sans identification** (échec, ou statut `none`) : `scam` tourne comme aujourd'hui, avec les photos.
- **Cache :** l'empreinte de l'identification entre dans `input_hash` : une identification différente donne une autre analyse.

## 4. Indice de confiance

Calculé par l'API (`services/identify_confidence.py`), jamais recopié du modèle.

**Pour chaque objet, dans l'ordre :**
1. **Un seul candidat connu** (aucune variante) : 85.
2. **`read_reference` désigne ce candidat** et apparaît telle quelle dans un résultat de recherche : plancher à 95.
3. **Sinon :**
   - confiance = 40 + 55 × (critères `decisive` en `seen_match` pour le candidat retenu / critères `decisive` de type `photo`) ;
   - un critère non décisif compte pour un tiers d'un critère décisif ;
   - un critère tiré d'**une seule source** compte pour moitié.
4. **Élimination :** un `seen_contrary` élimine le candidat. Si les critères désignent des candidats différents, la confiance est plafonnée à 50.
5. **Plafonds :**
   - un critère `decisive` en `not_visible` : 70 au plus ;
   - une seule photo et aucune référence lue : 85 au plus ;
   - des critères **non sourcés** (§9) : 70 au plus ;
   - un accessoire sans étape `criteria` : 84 au plus.
6. **Bonus :** +5 si l'ensemble de critères est *vérifié* par un admin. Plafond général : 99.

**Niveaux :**
- **Sûr :** 85 à 99.
- **Probable :** 60 à 84.
- **Incertain :** moins de 60, ou `reference` nulle.

**Résultat de l'identification :**
- **statut :** `identified` (objet principal Sûr ou Probable), `uncertain` ou `none` ;
- **confiance :** celle de l'objet principal.

**Le titre n'est pas une preuve :** « OLED » écrit par le vendeur ne change pas la confiance.

Les poids sont des constantes du module au départ, pas des réglages. Le tableau de bord (§10) et le jeu d'évaluation (§12) serviront à les ajuster.

## 5. Données

Une migration (0010) crée ou modifie :

### 5.1 Étapes et prompts
- **`pipeline_steps`** :
  - `code` (`read_photos`, `criteria`, `identify`), `active_model_id`, `active_prompt_version_id` ;
  - la migration met le modèle actif du type `full` sur chaque étape, et une version 1 de prompt par étape ;
  - `scam` reste le type `full` (`scan_kinds`, `active_setup` inchangés).
- **`prompt_versions`** :
  - `scan_kind` devient facultatif ;
  - nouvelle colonne `step` (clé vers `pipeline_steps`), et `CHECK` : exactement l'une des deux colonnes est remplie ;
  - `UNIQUE(step, version)` ;
  - mêmes règles qu'aujourd'hui : 200 à 20 000 caractères, versions jamais modifiées, numéros qui se suivent.
- **`settings`**, avec ces nouvelles colonnes :

| Colonne | Bornes | Défaut |
|---|---|---|
| `identification_cache_ttl_hours` | 1–2160 | 168 |
| `criteria_ttl_days` | 1–730 | 180 |
| `criteria_max_searches` | 0–5 | 2 |
| `criteria_max_pages` | 0–5 | 3 |
| `identify_retry_threshold` | 0–100 | 60 |
| `identify_image_side` | 768–1536 | 1280 |
| `scam_sends_photos` | booléen | faux |
| `identify_escalation_model_id` | modèle ou vide | vide |

### 5.2 Base de critères (partagée)
- **`criteria_sets`** :
  - `id`, `candidates_key` (noms normalisés, triés, joints, `UNIQUE`), `candidates` (tableau) ;
  - `status` (`auto`, `verified`), `created_at`, `refreshed_at`, `reviewed_at`.
  - **Expiration :** `refreshed_at + criteria_ttl_days`. Une entrée expirée est recherchée à nouveau ; une entrée *vérifiée* n'expire pas.
- **`criteria`** :
  - `set_id`, `position` ;
  - `kind` (`photo`, `ask_seller`), `decisive` ;
  - `text_fr`, `text_nl`, `expected` (JSON : candidat → valeur attendue en FR et NL) ;
  - `edited_by_admin`.
- **`criteria_sources`** : `criterion_id`, `url`, `title`, `domain`.

### 5.3 Identifications (cache partagé)
- **`identifications`** :
  - **clé `UNIQUE`** : `snapshot_id`, configuration des étapes (identifiants des modèles et des prompts des trois étapes), `input_hash` (photos envoyées et leur taille) ;
  - **résultat :** `status`, `confidence`, `photo_observations` (JSON), `title_mismatch` (texte ou `null`), `seller_question_fr`, `seller_question_nl` ;
  - **suivi :** `retried`, `unsourced`, `created_at` ;
  - **validité :** `created_at + identification_cache_ttl_hours` ; une identification expirée est rafraîchie sur place, comme les analyses (règle R4).
- **`identification_objects`** : `identification_id`, `position`, `role`, `label`, `reference` (ou `null`), `confidence`, `remaining` (tableau), `criteria_set_id` (ou `null`).
- **`identification_checks`** : `object_id`, `criterion_id`, `observation`, `photo_index`.
- **`identification_pages`** : `object_id`, `position`, `url`, `title`, `domain`.
- **`identification_searches`** : `identification_id`, `position`, `query`, `kind` (`criteria`, `price`, `retry`) et `pages_read` (domaines). Ils s'affichent dans le déroulé, même pour un résultat du cache.
- **`identification_results`** : `scan_event_id` → `identification_id`, l'équivalent de `scan_results`.

Ces tables ne contiennent aucune donnée personnelle : elles survivent à la suppression d'un compte, comme `analyses`.

### 5.4 Scans et coûts
- **`scan_events`** gagne :
  - `purpose` (`identify` ou `analyze`, défaut `analyze`) ;
  - `included` (booléen, défaut faux) : un `analyze` inclus ne compte pas dans le quota (§7).
- **`llm_calls`** gagne :
  - `step` (`read_photos`, `criteria`, `identify`, `scam`) ;
  - `identification_id` ou `criteria_set_id`, et `CHECK` : exactement l'une des trois cibles (`analysis_id`, `identification_id`, `criteria_set_id`).

  Un appel `criteria` n'est relié qu'à son ensemble de critères. La purge à 12 mois s'applique comme aujourd'hui.

## 6. Routes et événements

**`POST /api/identify/stream`**
- Corps : `ScanIn` (mêmes champs, même validation).
- Admission : la même que le scan (limite de requêtes, droits, validation, snapshot, réservation avec `purpose = identify`).
- Réponse :
  - `text/event-stream`, avec les mêmes `: ping` et `flush_interval -1` dans Caddy ;
  - un refus reste une réponse JSON ;
  - délai : `IDENTIFY_TIMEOUT_S` = 120 s.

**`POST /api/identify`** : la même, sans flux, pour les tests et `e2e`.

**`POST /api/scans/stream` et `POST /api/scans`**
- Si aucune identification valide n'existe pour l'annonce, ils lancent d'abord l'identification (dans la limite de 120 s), puis `scam` (180 s, inchangé).
- Le scan émet les événements de l'identification, puis les siens.

**Nouveaux événements**, en miroir dans `packages/shared/src/stream.ts` :
- `stage` : `reading_photos`, `criteria`, `reading_pages`, `identifying`, `retrying` ;
- `criteria_cached` : critères repris de la base, avec le nombre de critères ;
- `page_read` : domaine de la page, `ok` ;
- `identification` : le résultat complet (`IdentificationOut`) ;
- les événements `search`, `search_done`, `thinking`, `result` et `error` existants.

**`IdentificationOut`** :
- `identificationId`, `status`, `confidence`, `level` (`sure`, `probable`, `uncertain`) ;
- `objects` : rôle, libellé, référence, confiance, niveau, candidats restants, critères vérifiés (texte FR et NL, observation, photo, sources), pages ;
- `sellerQuestion` (FR et NL, ou `null`), `searches`, `verifiedCriteria`, `unsourced`, `fromCache`, `identifiedAt`, `remaining` ;
- `debug`, pour le superuser hors production : trois étapes, prompts, réponses brutes, durées et coûts.

**`AnalysisResultOut`** gagne `identification` (`IdentificationOut` ou `null`).

## 7. Quota

- **`identify` :** il consomme 1 analyse du quota `full`, avec les mêmes verrous (`FOR UPDATE`) et la même limite de requêtes.
- **`analyze` inclus :** pendant la réservation, sous le verrou de l'utilisateur, l'`analyze` est marqué `included` s'il existe pour **le même utilisateur et la même annonce** (`listing_snapshots.listing_id`) un `identify` qui remplit trois conditions :
  - il a réussi (une ligne `identification_results`, aucune `scan_failures`) ;
  - il date de moins de 24 h ;
  - il n'a pas déjà donné un `analyze` inclus.
- **`compute_usage` :** il ignore les événements `included`. Un `analyze` inclus est aussi accepté avec un quota à 0.
- **Échec :** il rend le scan (`scan_failures`), comme aujourd'hui. Un `analyze` inclus en échec garde son `identify` disponible pour un autre `analyze` inclus.
- **Identification d'un autre utilisateur servie par le cache :** elle ne rend pas « Analyser » gratuit. Seul son propre `identify` le fait.
- **`RemainingOut`** : inchangé.

## 8. Sécurité

### 8.1 Lecteur de pages (`pages.py`)
- **Protocoles :** HTTPS seulement, port 443.
- **Adresses :**
  - le DNS est résolu par l'API ;
  - les adresses privées, de boucle locale, de lien local, de diffusion, réservées et de métadonnées (IPv4 et IPv6) sont refusées ;
  - la connexion se fait à l'IP vérifiée, avec le nom d'hôte en SNI.
- **Redirections :** 2 au plus, chacune revérifiée.
- **Limites :**
  - 1 Mo au plus, lu en flux et coupé au-delà ;
  - 5 s par page, 12 s pour toute la lecture d'une étape ;
  - `Content-Type` `text/html` ou `text/plain` seulement.
- **Client dédié :** `trust_env=False`, ni cookies, ni authentification, ni en-têtes partagés, `User-Agent` fixe.
- **Texte :**
  - `<script>`, `<style>`, `<nav>`, `<footer>` et les commentaires sont retirés ;
  - les espaces sont réduits, et le texte coupé à 8 000 caractères ;
  - il est encadré `<page_web>` et décrit au modèle comme une donnée non fiable.
- **Échec :** une page en échec est ignorée et ne fait jamais échouer l'étape.

### 8.2 Empoisonnement de la base de critères
- **Isolement de l'annonce :** `criteria` ne reçoit jamais l'annonce, donc le vendeur ne peut pas y injecter de critère.
- **Sources :** un critère sans source est rejeté. Un critère d'une seule source pèse moitié moins (§4), et l'admin le voit.
- **Admin :** il relit, corrige, supprime ou relance (§10).

### 8.3 Liens affichés
- **Choix :** le modèle choisit des numéros de résultats.
- **Vérification par l'API :** HTTPS, 300 caractères au plus, aucun caractère de contrôle (mêmes règles que `format_hits`).
- **Dans l'extension :** les liens s'ouvrent dans un nouvel onglet avec `rel="noopener noreferrer"`.

### 8.4 Vie privée
- **Masquage :** `read_photos` reçoit l'annonce masquée, comme `scam` aujourd'hui (téléphones et emails masqués, aucune identité du vendeur).
- **Requêtes :** elles ne contiennent que des noms de produits.
- **`/privacy` (FR et NL), à mettre à jour :**
  - identification du produit ;
  - photos envoyées jusqu'à `identify_image_side` px ;
  - pages publiques consultées par notre serveur (sans donnée du compte).

## 9. Erreurs et dégradations

| Cas | Effet |
|---|---|
| `read_photos` échoue | Identification en échec (`identify_read_photos`), scan rendu. |
| `identify` échoue | Identification en échec (`identify_resolve`), scan rendu. |
| `criteria` échoue (modèle) | L'identification continue avec les `hint_criteria`, marqués **non sourcés** (`unsourced`), confiance plafonnée à 70. Rien n'est enregistré dans la base. |
| Moteur de recherche en panne, ou aucune page lisible | Extraits seuls, ou `hint_criteria` non sourcés si aucun résultat. |
| Délai de 120 s dépassé | Identification en échec (`timeout`), scan rendu. |
| Identification en échec pendant « Analyser » | Événement `error` de l'identification, puis `scam` sans identification, comme aujourd'hui. L'`analyze` n'est pas inclus. |
| Fournisseur d'une étape inconnu | `configuration`, scan rendu. |

**Verrous :** un verrou consultatif par clé d'identification (un seul pipeline par annonce et par configuration) et un par `candidates_key`.

**Superuser hors production :** `noCache` saute le cache des identifications et des analyses, mais pas la base de critères (elle se rafraîchit depuis l'admin).

## 10. Admin

**Écran IA** (partie 1) :
- une section par étape : modèle actif, versions du prompt, ajout d'une version ;
- les nouveaux réglages de `settings` ;
- l'essai d'une étape sur une annonce fictive, hors quota et hors cache, dans la même limite que l'essai actuel.

**Écran « Base de critères »** (partie 3) :
- **liste :** les ensembles de candidats, filtrés par statut (`à relire` = `auto` jamais relu, `vérifiée`) ;
- **détail :** critères, sources et usage (nombre d'identifications) ;
- **actions :**
  - corriger un critère (texte, type, décisif, valeurs attendues) ;
  - supprimer un critère ;
  - marquer l'ensemble *vérifié* ;
  - relancer la recherche ;
  - supprimer l'ensemble.
- **journal :** chaque action écrit une ligne `admin_actions`, comme les autres écrans.

**Tableau de bord** (partie 3) :
- répartition Sûr / Probable / Incertain / rien d'identifiable sur 7 et 30 jours ;
- part des critères repris de la base ;
- critères le plus souvent `not_visible` ;
- coût par étape (`llm_calls.step`).

**Analyses** (partie 3) : le détail d'une analyse montre son identification.

## 11. Livraison

1. **API :** tout le §3 à §9, plus l'écran IA de l'admin réduit aux étapes et aux réglages (§10, premier point). Elle doit être déployée avant l'extension.
2. **Extension :** les pilules, les panneaux, la file d'attente, la conservation et les cartes (§13).
3. **Admin et site :** la base de critères, le tableau de bord, les analyses et `/privacy`.

## 12. Tests

**API :**
- chaque étape avec un faux client LLM : sorties valides, JSON invalide, statut `nothing` ;
- `identify_confidence` avec un tableau de cas : un seul candidat, référence lue, critères décisifs ou non, une seule source, contradiction, non visible, une seule photo, non sourcé, vérifié, plafonds ;
- le lecteur de pages :
  - adresses refusées (IPv4, IPv6, DNS qui pointe vers une adresse interne) et redirection vers une adresse interne ;
  - taille, délai, type de contenu, extraction du texte ;
- l'orchestration :
  - `criteria` sautée (base valide, un seul candidat, référence lue) ;
  - une seule relance, escalade ;
  - chaque dégradation du §9 ;
  - verrou par `candidates_key` (deux pipelines, une seule recherche) ;
- le quota :
  - `identify` décompté ;
  - `analyze` inclus une seule fois par `identify` ;
  - `identify` en échec ;
  - identification d'un autre utilisateur ;
  - course entre « Identifier » et « Analyser » ;
- le cache : `input_hash` de `scam` qui suit l'identification, rafraîchissement sur place, expiration des critères ;
- les événements SSE et la route sans flux ;
- les migrations (activation conditionnelle de la v3) ;
- la purge (`llm_calls` aux trois cibles).

**Extension :** chaque état de la pilule « Identifier », la file d'attente d'« Analyser », les deux pilules remplies par « Analyser », le panneau (Sûr, Incertain avec question et « Copier », accessoires, liens), la conservation 24 h, l'infobulle des cartes, la parité FR/NL.

**Bout en bout :** `pnpm e2e:identify` contre le faux fournisseur, avec et sans flux.

**Jeu d'évaluation local** (`pnpm eval:identify`, données non commitées) :
- des annonces de `web-pages/`, annotées à la main avec la bonne référence (fichier gitignoré) ;
- le script donne la justesse, la répartition des niveaux et le coût moyen par étape ;
- il sert à choisir les modèles et à ajuster les poids du §4.

**Coût :** mesuré par ce script et par le tableau de bord, au lieu d'être estimé ici. L'objectif est de rester dans l'ordre de grandeur d'aujourd'hui (environ 1,1 ¢ au pire), grâce à la base partagée et à `scam` sans photos.

## 13. Extension

### 13.1 Pilule « Identifier »
- **Forme :** celle de la pilule « Analyser » (design pastille §2), placée avant elle sur la même ligne.
- **Au repos :** logo et « Identifier » ; nom accessible « Identifier le produit ».
- **En cours :** logo animé et ligne d'état en direct, avec la même mécanique que `statusLine` (points de suspension après 4 s, `aria-live` au plus toutes les 2 s) :
  - « Lecture des photos… » ;
  - « Critères connus de Radarnaque » ;
  - « Recherche : … » ;
  - « Lecture : domaine » ;
  - « Vérification des critères… » ;
  - « Vérification complémentaire… ».
- **Résultat :**
  - glyphe de confiance (● Sûr, ◐ Probable, ○ Incertain), référence courte, « · », niveau et pourcentage en chiffres tabulaires ;
  - **aucune couleur sémantique du risque** ;
  - incertain : « A ou B ? · Incertain 55 % » ;
  - rien d'identifiable : « Produit non identifié » ;
  - une référence trop longue est tronquée, et le nom accessible la donne en entier.
- **Erreur, déconnecté, sans abonnement, quota épuisé :** comme `useLaunch`.

### 13.2 Les deux pilules
- **« Analyser » cliqué sans identification :** les deux pilules s'animent. « Identifier » suit les événements de l'identification, et reçoit l'événement `identification`.
- **« Analyser » cliqué pendant une identification :** l'analyse est mise en file et lancée à la fin de l'identification, réussie ou non.
- **Après une identification réussie :** la description de « Analyser » dit « Inclus avec l'identification ».

### 13.3 Panneau « Identification »
- **Carte :** celle du panneau d'analyse (design pastille §3), avec l'en-tête « IDENTIFICATION ».
- **Objet principal :**
  - référence en Instrument Serif 22 px ;
  - badge de niveau et pourcentage, barre de 4 px ;
  - « Critères vérifiés par Radarnaque » si l'ensemble est vérifié ;
  - « Critères non confirmés par une source » si `unsourced`.
- **Critères :** ✓ vu, ✗ contraire, ? non visible, numéro de la photo, lien vers la source (domaine).
- **Incertain :** candidats restants, critère manquant, encadré « À demander au vendeur » avec la question et un bouton « Copier ».
- **Accessoires :** une ligne par accessoire (libellé, référence, niveau).
- **Pages de référence :** 2-3 liens (titre et domaine).
- **Pied :** « Analyses restantes : N » et « Déroulé de l'identification », repliable : recherches et pages lues, aussi pour un résultat du cache.

### 13.4 Panneau « Analyse »
- **En tête :** une ligne « Produit : référence (niveau) ».
- **Raisons :** `title_mismatch` y apparaît, avec sa gravité, quand `scam` le retient.

### 13.5 Plomberie
- **Port :** même port `scan/stream`, avec un champ `purpose` (`identify` ou `analyze`) et le même contrôle de l'émetteur. Le service worker valide les nouveaux événements.
- **Conservation :** l'identification est gardée 24 h dans le navigateur à côté du résultat, avec les mêmes règles (une place par annonce, effacée à la déconnexion, caduque si l'annonce change).
- **Icônes des cartes :** comportement inchangé ; elles lancent le pipeline complet. L'infobulle du résultat gagne une ligne « référence · niveau ».
- **Textes :** nouvelles clés FR et NL, et le test de parité reste vert.
