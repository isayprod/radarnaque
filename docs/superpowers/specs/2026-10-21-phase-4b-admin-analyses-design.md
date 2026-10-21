# Admin — Analyses

*Spec du 21 octobre 2026*, partie de la phase 4b (voir le [socle](2026-10-21-phase-4b-admin-socle-design.md)).

## 1. Rôle

Relire les analyses produites par l'IA pour juger leur qualité, comprendre un score contesté et suivre les coûts. Lecture seule.

## 2. Liste

- **Analyses récentes** (`app.analyses`), de la plus récente à la plus ancienne, avec une pagination par curseur (50 par page).
- **Colonnes :**
  - date ;
  - site ;
  - titre de l'annonce (snapshot) ;
  - score et niveau ;
  - professionnel ;
  - modèle et version du prompt ;
  - photos analysées et recherches web ;
  - coût total (somme de ses `llm_calls`) et nombre d'appels au modèle ;
  - nombre de fois servie (nombre de `scan_results` qui pointent vers l'analyse, y compris les scans qui ont appelé le modèle).
- **Date :** celle du dernier appel au modèle (`analyses.created_at`). Une analyse rafraîchie sur place remonte donc en tête de liste ; son contenu est celui du dernier appel (socle §5 bis).
- **Filtres :**
  - site ;
  - niveau de risque ;
  - modèle ;
  - version du prompt ;
  - période (de / à) ;
  - « avec recherche web » ;
  - « partielle ».
- **Recherche dans le titre :** au moins 3 caractères, casse ignorée.

## 3. Détail d'une analyse

- **L'annonce :**
  - site, identifiant externe et lien vers l'annonce ;
  - titre, description (déjà masquée) et prix ;
  - URL des photos du snapshot ;
  - date du snapshot.
- **Le résultat :**
  - score, niveau, professionnel ;
  - résumé et conseil en FR et en NL ;
  - raisons avec leur gravité.
- **Les recherches web :** les requêtes et leur aspect, dans l'ordre.
- **Le contexte technique :**
  - modèle, version du prompt (avec un lien vers son texte dans l'écran IA) ;
  - tokens en entrée et en sortie, coût, du dernier appel ;
  - les appels au modèle (`llm_calls`), du plus récent au plus ancien : date, tokens, coût, photos, recherches ;
  - photos analysées ;
  - empreinte d'entrée (`input_hash`) ;
  - date du dernier appel.
- **L'usage :** nombre de fois servie, et date du premier et du dernier service. L'écran ne dit pas qui l'a demandée.

## 4. Données personnelles

- **Une analyse n'est pas une donnée personnelle** (§6.4 de la spécification principale). L'écran ne relie jamais une analyse à un utilisateur : pas d'email, pas d'identifiant de compte.
- **Pour retrouver les analyses d'un utilisateur,** on passe par sa fiche (écran Utilisateurs, « Activité »), qui montre ses scans.
- **La description affichée** est celle du snapshot, où les téléphones et les emails sont déjà masqués.

## 5. API

- `GET /api/admin/analyses?site=&level=&modelId=&promptVersionId=&from=&to=&withSearch=&partial=&q=&before=&limit=` : la liste.
- `GET /api/admin/analyses/{id}` : le détail.

Les deux routes sont en lecture seule. Elles n'écrivent rien dans `admin_actions`.

## 6. Tests

- **Liste :** chaque filtre seul et combinés ; pagination ; titre de moins de 3 caractères donne `422`.
- **« Nombre de fois servie » :** égal au nombre de `scan_results` de l'analyse.
- **Analyse rafraîchie :** deux appels listés, coût total égal à leur somme.
- **Détail :**
  - textes FR et NL ;
  - raisons dans l'ordre ;
  - recherches dans l'ordre ;
  - coût et tokens.
- **Aucune donnée de compte** dans les réponses : ni email, ni identifiant d'utilisateur.
- **Analyse inconnue** donne `404`.
- **Interface :** filtres, pagination, détail, lien vers le prompt.
