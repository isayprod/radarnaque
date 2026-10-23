# Identification du produit, partie 1 (API) — Points de suivi

Remarques relevées pendant la partie 1 (API) de l'identification du produit : pipeline en trois
étapes, base de critères partagée, routes `/api/identify(/stream)`, quota, analyse nourrie par
l'identification, écran IA de l'admin par étape. La spécification est dans
[`2026-10-23-identification-produit-design.md`](../specs/2026-10-23-identification-produit-design.md) et
le plan dans [`2026-10-23-identification-partie-1-api.md`](2026-10-23-identification-partie-1-api.md).

## Ce qui est livré

- **Pipeline** (`services/api/src/radarnaque_api/identify/`) : lecture des photos, critères de
  distinction cherchés sur le web (en parallèle des recherches de fiche technique et de prix),
  identification, indice de confiance calculé par l'API, relance si la confiance est basse.
- **Base de critères partagée** et identifications en cache, migrations 0010 (tables, réglages) et
  0011 (prompts v1 des trois étapes, prompt `full` v3).
- **Routes** `POST /api/identify` et `POST /api/identify/stream`, et scan qui identifie d'abord
  l'annonce ; quota (« identifier » consomme 1 analyse, l'analyse qui suit est incluse).
- **Admin** : un modèle et un prompt par étape, les nouveaux réglages.
- **Outils** : faux fournisseur pour les trois étapes, `pnpm e2e:identify`, `pnpm eval:identify`.

## Décisions à connaître

- **Budget du scan : 190 s, dont 80 s pour l'identification.** L'extension déjà installée coupe le
  flux d'un scan à 200 s. Sur le chemin du scan, tout le service tient donc en 190 s :
  l'identification a 80 s au plus (au-delà, un événement `identification_error` est émis et
  l'analyse continue sans elle) et l'analyse a le reste, 180 s au plus. `POST /api/identify` garde
  ses 120 s. **La partie 2 doit relever `SCAN_TIMEOUT_MS` de l'extension à environ 310 s** avant que
  le scan puisse profiter des budgets complets de la spécification ; en attendant, une première
  identification lente retombe plus souvent sur l'analyse d'avant.
- **L'API se déploie avant l'extension.** Les nouveaux événements (`reading_photos`, `criteria`,
  `identification`…) sont ignorés par l'extension actuelle ; l'inverse ne marcherait pas.
- **`/privacy` à mettre à jour en partie 3** : l'identification, les photos envoyées au modèle
  (jusqu'à `identify_image_side` px de côté, 1280 par défaut) et les pages publiques lues par le
  serveur pour trouver les critères.
- **Essai d'une étape dans l'admin : reporté en partie 3.** Seuls les modèles, prompts et réglages
  par étape sont livrés.
- **Tableau de bord par étape.** Les coûts sont maintenant comptés par étape (`llm_calls.step`).
  Les chiffres « servi depuis le cache » et les moyennes ne comptent que l'étape d'analyse
  (`scam`), pour rester comparables à ceux d'avant ; les identifications comptent comme des scans
  dans les totaux.
- **Autres choix pris pendant l'exécution :**
  - les critères non sourcés (aucune page lue) ne sont jamais écrits dans la base : seuls ceux
    qui s'appuient sur une vraie page le sont, avec leurs sources ;
  - une identification en cache est autonome : un critère modifié ou supprimé plus tard dans la
    base ne change pas ce qu'elle a montré (textes, sources et caractère décisif sont copiés) ;
  - une analyse incluse reste gratuite même si l'identification faite pendant ce scan échoue
    ensuite (l'inclusion est décidée à l'admission, à partir de l'`identify` de l'utilisateur) ;
  - un scan gratuit ne redevient jamais payant après une purge ni la suppression du lien avec son
    identification (colonne `scan_events.included`) ;
  - les noms et textes que le modèle tire d'une annonce sont neutralisés avant d'être renvoyés dans
    un prompt : une annonce ne peut pas fabriquer de faux bloc de page pour orienter la base de
    critères partagée ;
  - les résultats de la requête « prix » ne sont pas enregistrés : pour une identification en
    cache, la requête est relancée (le moteur garde 24 h ses réponses) ;
  - l'historique et le tableau de bord comptent les identifications comme des scans ; une
    identification réussie n'est jamais rendue ensuite en échec.

## À vérifier sur la vraie pile

Rien de ceci n'a été essayé hors des tests (1247 tests de l'API, voir l'[état du projet](../../etat-du-projet.md)),
sauf une passe unique de `eval:identify` avec une annonce fictive contre le modèle actif (`openai-oauth`) : elle a
tourné jusqu'au bout et a écrit dans la base de critères et dans `llm_calls` de la base de dev.

- **`pnpm e2e:identify` et `pnpm e2e:scan` avec le faux fournisseur.** `radarnaque-llm use` ne
  règle que les types de scan (`--kind text|image|full`) : les trois étapes d'identification se
  règlent dans l'écran IA de l'admin. Pas à pas :
  1. noter les modèles actuels : `cd services/api && uv run --env-file ../../infra/.env radarnaque-llm list`
     (types de scan) et le modèle actif de chaque étape dans l'écran IA ;
  2. `pnpm llm:stub` dans un terminal à part ;
  3. `radarnaque-llm use stub stub-model --kind full` (crée aussi le modèle `stub/stub-model`),
     puis, dans l'écran IA, `stub/stub-model` comme modèle actif de `read_photos`, `criteria` et
     `identify` ;
  4. `pnpm e2e:identify` puis `pnpm e2e:scan`. Attendu : `reading_photos`, `criteria` (avec ses
     `search` et `page_read` si SearXNG répond), `identifying`, `identification`, puis `result` ;
  5. remettre les modèles notés (écran IA pour les étapes, `radarnaque-llm use <fournisseur>
     <modèle> --kind full` pour `full`).

  **Cette passe n'a pas été faite pendant la tâche** : la pile tournait avec `openai-oauth` actif et
  le faux fournisseur n'écoutait pas ; la configuration de dev n'a pas été modifiée.
- **OpenRouter et modèles vision réels** : sortie structurée stricte sur les trois schémas,
  nombre de photos accepté, lecture correcte des références sur de vraies annonces. `pnpm
  eval:identify` sur un jeu construit à la main donne la justesse, les niveaux et le coût par
  étape.
- **SearXNG en production** : les requêtes de critères, de fiche technique et de prix aboutissent
  (moteurs qui répondent, `SEARXNG_SECRET` substitué).
- **Lecture de pages derrière le pare-feu du serveur** : le lecteur ne contacte que des adresses
  publiques ; vérifier que les sorties HTTPS nécessaires sont ouvertes et que rien d'interne n'est
  joignable.
- **Coût réel par étape** : relever `llm_calls` après quelques identifications (lecture, critères,
  identification, relance) et comparer à l'estimation de la spécification.
- **Budgets** : mesurer la durée d'un scan avec une première identification (cache froid) et le
  nombre de fois où les 80 s sont dépassés.
- **Relance de l'identification** : seuil `identify_retry_threshold` et modèle de relance
  (`identify_escalation_model_id`), à régler d'après les résultats de l'évaluation.

## Ce qui reste pour les parties suivantes

- **Partie 2 (extension) :** pilules, panneaux et cartes ; relever `SCAN_TIMEOUT_MS` à environ 310 s ;
  miroir de `IdentificationOut` et des nouveaux événements dans `packages/shared/src/stream.ts`.
- **Partie 3 (admin et site) :** écran « Base de critères », tableau de bord de l'identification,
  identification dans le détail d'une analyse, essai d'une étape, mise à jour de `/privacy`.
- **Petites remarques de relecture, reportées :** liste tenue dans le journal d'avancement du plan
  (aucune n'affecte la justesse des chiffres ni la sécurité). Elles sont à traiter, ou à écarter une
  à une, lors de la relecture finale de la branche, qui en est responsable.
