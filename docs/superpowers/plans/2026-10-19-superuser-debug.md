# Superuser de développement et logs de debug — Plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development, tâche par tâche.

**Objectif :** un rôle `superuser`, actif seulement hors production, qui a :
- des requêtes illimitées ;
- des logs détaillés dans la console de l'API, dans les consoles de l'extension et dans le panneau ;
- un bouton « Relancer sans cache ».

Avec `pnpm dev`, le compte de `DEV_SUPERUSER_EMAIL` devient superuser automatiquement.

**Spec :** `docs/superpowers/specs/2026-10-16-radarnaque-v4-design.md` §5.3 bis.

## Contraintes globales

- **Hors production uniquement.**
  - API : le rôle n'a d'effet que si `settings.env != "production"`. Sinon le compte est traité comme `user`, sans quota illimité ni debug, et une ligne WARNING est journalisée (sans email).
  - Auth : le rôle n'est jamais attribué si `NODE_ENV=production`.
- **Dépôt public.** Aucun email réel dans le code, les tests ou la doc : `DEV_SUPERUSER_EMAIL` vit seulement dans `infra/.env`. Les tests utilisent `superuser@radarnaque.test`.
- **Secrets.** Ni clé d'API, ni en-tête `Authorization`, ni JWT, ni jeton de session dans un log ou dans le bloc `debug`. Les images sont résumées (nombre et taille en octets), jamais leur contenu base64.
- **Le serveur est la barrière.** L'extension n'affiche le debug que si `/api/me` renvoie `role: "superuser"` et que la réponse de scan contient `debug`.
- TDD, commits avec le trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Ne jamais pousser ni utiliser `git stash`.
- Ne jamais toucher `video/`, `web-pages/`, `.DS_Store`, `services/api/tests/.conftest.py.swp` ni `docs/superpowers/plans/.Rhistory`. Ne jamais afficher `infra/.env`.

## Points de vigilance

1. **Production.** Un compte `superuser` en production n'obtient ni quota illimité ni debug, et `noCache` y est ignoré. *Tâches 2 et 3.*
2. **Fuite de secret dans le debug.** Le bloc `debug` et les logs ne contiennent ni clé, ni jeton, ni image base64. *Tâches 3 et 4.*
3. **`noCache` envoyé par un compte ordinaire.** Il est ignoré silencieusement : pas d'appel LLM en plus, quota normal. *Tâche 3.*
4. **`DEV_SUPERUSER_EMAIL` vide ou absent.** L'auth démarre normalement, sans rien faire. *Tâche 1.*
5. **Logs de l'extension pour un compte ordinaire.** Aucun log de debug n'est écrit, ni dans la page, ni dans le service worker. *Tâches 4 et 5.*

---

### Tâche 1 : auth — attribution du rôle `superuser`

**Fichiers :** `services/auth/src/env.ts`, `services/auth/src/auth.ts` (ou un nouveau `superuser.ts`), `services/auth/src/server.ts` (au démarrage), `services/auth/scripts/dev-superuser.ts`, `package.json` racine (`dev:superuser`), `infra/.env.example`, et les tests de services/auth.

- `Env.DEV_SUPERUSER_EMAIL?: string`. Il est normalisé (trim et minuscules) et validé comme email. S'il est vide, il est absent.
- `ensureDevSuperuser(db, email, nodeEnv)` :
  - si `nodeEnv === "production"`, la fonction ne fait rien et journalise un avertissement si un email est défini ;
  - sinon, elle met `role = 'superuser'` sur le compte de cet email, ou elle le crée par l'API Better Auth s'il n'existe pas (même chemin que l'inscription, `emailVerified` à vrai).
  
  Elle est appelée au démarrage du service auth.
- Un `databaseHooks.user.create.before` pose `role = 'superuser'` si l'email est `DEV_SUPERUSER_EMAIL` et que l'on n'est pas en production.
- `pnpm dev:superuser <email>` donne le rôle à un compte existant. Il refuse en production (code 2) et si le compte est introuvable (code 1).
- `.env.example` : la ligne `# DEV_SUPERUSER_EMAIL=`, commentée, avec une explication en français.
- **Tests.** Avec `superuser@radarnaque.test` :
  - un compte existant est promu ;
  - un compte absent est créé avec le rôle ;
  - en production, rien ne se passe ;
  - avec un email vide, rien ne se passe ;
  - le hook de création pose le rôle ;
  - les autres emails restent `user`.
- **Commit :** `feat(auth): superuser de développement (DEV_SUPERUSER_EMAIL, pnpm dev:superuser)`.

### Tâche 2 : API — droits du superuser

**Fichiers :**
- Créer : `services/api/src/radarnaque_api/auth/privileges.py`.
- Modifier : `routes/me.py`, `services/scans.py`, `schemas.py` (`MeOut.role` ajoute `"superuser"`) et les tests.

- `Privileges(unlimited: bool, all_features: bool, rate_limited: bool, debug: bool)`, et `privileges_of(user, settings)` :

  | Cas | unlimited | all_features | rate_limited | debug |
  |---|---|---|---|---|
  | admin | vrai | vrai | vrai | faux |
  | superuser hors production | vrai | vrai | faux | vrai |
  | superuser en production | faux | faux | vrai | faux |
  | user | faux | faux | vrai | faux |

  Le superuser en production a les mêmes droits qu'un `user`, avec une ligne WARNING « rôle superuser ignoré en production », sans l'email.
- Ces privilèges remplacent les tests `user.role == "admin"` dans `scans.py` (droits, réservation du quota, limite de requêtes, abonnement) et dans `me.py`.
- `/api/me` d'un superuser hors production renvoie `role: "superuser"`, `unlimited: true` et les mêmes `features` et `quotas` vides que l'admin.
- **Tests :**
  - le superuser fait 31 scans dans la minute sans 429 ;
  - il n'a aucun quota et aucun abonnement ;
  - il a les photos et les cartes ;
  - en production, `/api/me` le renvoie en `user`, il reçoit 402 sans abonnement, et le WARNING est journalisé ;
  - l'admin garde sa limite de requêtes.
- Régénérer les types : `pnpm gen:api`.
- **Commit :** `feat(api): rôle superuser hors production (sans quota ni limite de requêtes)`.

### Tâche 3 : API — bloc `debug`, logs et `noCache`

**Fichiers :** `llm/client.py` (`LLMResult.raw_text`), `services/scans.py`, `services/scan_store.py` (rafraîchissement R4 réutilisé pour `noCache`), `schemas.py` (`ScanIn.noCache: bool = False`, `ScanDebugOut`, `AnalysisResultOut.debug: ScanDebugOut | None = None`), `main.py` (logger), et les tests.

- **`ScanDebugOut`, en camelCase :**
  - `provider`, `model` ;
  - `promptVersion: {scanKind, version}`, `systemPrompt` (le texte réellement envoyé, schéma compris pour `json_object`) ;
  - `messages: [{role, content: str}]`, où chaque image devient `[image n : N octets]` ;
  - `rawResponse: str | None` (texte brut du modèle, `None` si le cache a répondu) ;
  - `llmCalled: bool`, `fromCache: bool` ;
  - `tokensIn`, `tokensOut`, `costUsdMicros` ;
  - `timingsMs: {images: int | None, llm: int | None, total: int}` ;
  - `contentHash`, `inputHash`, `snapshotId`, `analysisId`.
- **Quand le cache répond,** les messages sont tout de même construits (sans appel au LLM) pour montrer ce qui aurait été envoyé, avec `llmCalled: false`.
- **`noCache`.** S'il est vrai et que les privilèges ont `debug`, la recherche dans le cache est sautée et l'analyse est recalculée, puis rafraîchie en place avec la règle R4 de la phase 3a. Pour tout autre rôle, il est ignoré.
- **Logs.**
  - Logger `radarnaque.debug`, niveau INFO, un handler console seulement hors production.
  - À chaque scan d'un superuser, il écrit un bloc lisible : en-tête `[debug superuser] scan <scanKind> <site>|<externalId>`, puis le JSON indenté du bloc `debug`.
- **Tests :**
  - `debug` est présent pour un superuser, et `None` pour admin et user ;
  - aucune clé ni aucun `Authorization` dans le JSON : le faux fournisseur a une clé `sk-test-secret` ;
  - une image donne bien la forme `[image 1 : N octets]` ;
  - avec le cache, `llmCalled: false`, `rawResponse: null` et des messages présents ;
  - `noCache` d'un superuser donne un nouvel appel LLM et la même `analysisId`, rafraîchie ;
  - `noCache` d'un user est ignoré : un seul appel LLM sur deux scans ;
  - le log est émis (`caplog`) pour un superuser, pas pour un user.
- Régénérer les types.
- **Commit :** `feat(api): bloc debug et logs détaillés pour le superuser, relance sans cache`.

### Tâche 4 : extension — accès, service worker et popup

**Fichiers :** `lib/messages.ts` (`ContentAccess.active.debug: boolean`, `ScanRequest.noCache?: boolean`), `lib/access.ts`, `lib/scan-payload.ts` (passe `noCache` seulement s'il est vrai), `lib/background-handlers.ts`, `lib/debug-log.ts` (nouveau), `entrypoints/popup/App.tsx`, `lib/i18n.ts`, et les tests.

- `accessOf(me)` :
  - le rôle `superuser` donne `active`, avec `unlimited`, toutes les fonctionnalités et `debug: true` ;
  - les autres rôles ont `debug: false`.
- `lib/debug-log.ts` exporte `createDebugLog(enabled: () => boolean, sink = console)`, qui renvoie `{ group(title, data) }`. Le groupe est replié (`groupCollapsed`), préfixé `[Radarnaque debug]`, et `data` est affiché en objet. Rien n'est écrit si `enabled()` est faux.
- **Service worker.** Pour un superuser (dernier `me` lu), il journalise :
  - la requête envoyée (`ScanIn` après `toScanIn`, donc sans identité du vendeur) ;
  - la réponse, avec le bloc `debug` ;
  - le code d'erreur s'il y en a un.
  
  Jamais le JWT ni le jeton de session.
- **Popup.** Elle affiche « Superuser (dev) » en FR et en NL (« Superuser (dev) ») à la place du plan.
- **Tests :**
  - `accessOf` d'un superuser ;
  - aucun log pour `debug: false` ;
  - le log du service worker ne contient jamais le JWT : le test cherche le JWT factice dans tout ce que reçoit le faux `console` ;
  - le libellé de la popup.
- **Commit :** `feat(extension): accès superuser, logs du service worker, libellé de la popup`.

### Tâche 5 : extension — logs de la page, section Debug et « Relancer sans cache »

**Fichiers :** `lib/content/controller.ts`, `lib/content/card-scan.ts`, `lib/content/use-ai-scan.ts`, `components/DebugSection.tsx` (nouveau), `components/RiskBadge.tsx`, `lib/content-i18n.ts`, `entrypoints/content.ts`, et les tests.

- **Logs dans la console de la page, si `access.debug` :**
  - à chaque extraction : l'annonce complète et `missing` ;
  - à chaque évaluation locale : le score et les signaux ;
  - au clic sur un scan (page d'annonce ou carte) : le `ScanRequest` ;
  - à la réponse : le résultat et `debug`.
  
  Il faut l'accès déjà lu. On ne lit pas l'accès juste pour logger.
- **`DebugSection`.** C'est une section repliable « Debug (superuser) » en bas du panneau, affichée seulement si le résultat montré a un `debug`. Elle contient :
  - fournisseur, modèle et version du prompt ;
  - `llmCalled` et `fromCache` ;
  - tokens et coût ;
  - durées ;
  - des blocs `<pre>` repliables pour le prompt système, les messages et la réponse brute ;
  - un bouton « Copier » (`navigator.clipboard.writeText` du JSON) ;
  - un bouton « Relancer sans cache », qui relance le dernier type de scan avec `noCache: true`.
  
  Le texte est rendu en nœuds texte, jamais avec `innerHTML`.
- **Textes FR et NL :** « Debug (superuser) », « Copier » / « Kopiëren », « Relancer sans cache » / « Opnieuw zonder cache », « Copié » / « Gekopieerd ».
- **Tests :**
  - aucun log ni aucune section sans `debug` ;
  - avec `debug`, la section affiche le modèle et le prompt ;
  - « Relancer sans cache » envoie `noCache: true` ;
  - « Copier » appelle le presse-papiers ;
  - un log de la page est écrit à l'extraction pour un superuser, et rien pour un utilisateur standard.
- **Commit :** `feat(extension): logs de debug dans la page, section Debug du panneau et relance sans cache`.

### Tâche 6 : documentation

- **README :** une section « Superuser de développement ». Elle couvre `DEV_SUPERUSER_EMAIL` dans `infra/.env`, `pnpm dev:superuser <email>`, ce que montrent les logs (console de l'API, console de la page, console du service worker, avec la façon d'ouvrir chacune dans Chrome), la section Debug, la relance sans cache, et le fait que tout cela est inactif en production.
- **`docs/etat-du-projet.md` :** une ligne dans « Ce qui fonctionne ».
- **Commit :** `docs: superuser de développement et logs de debug`.
