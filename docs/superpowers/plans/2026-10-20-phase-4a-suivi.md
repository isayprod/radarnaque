# Phase 4a — Points de suivi

Remarques relevées pendant les relectures de la phase 4a : suppression du compte (`DELETE /api/me`), purge des scans à 12 mois, page `/privacy` à jour. Elles sont triées par échéance ; les points déjà corrigés n'y figurent pas.

## Corrections prévues avant fusion

Ces points ont été relevés en relecture de tâche et laissés pour une vague de corrections, après la relecture finale de la branche. Ceux que la vague finale a corrigés n'y figurent plus.

Aucun : la vague finale les a tous corrigés.

## À vérifier en direct avant la mise en ligne

Rien de ceci n'a été essayé hors des tests.

- **Suppression d'un compte sur la vraie pile :** depuis la popup, avec un compte de dev.
  - la cascade efface bien `auth.session`, `auth.account`, `app.subscriptions`, `app.scan_events` et leurs résultats et échecs ;
  - `app.analyses` et `app.listing_snapshots` gardent leur nombre de lignes ;
  - l'écran de connexion revient avec « Votre compte a été supprimé. » ;
  - un JWT encore valide (15 min) donne `401` ;
  - la pastille d'une annonce déjà analysée n'affiche plus l'ancien résultat IA (résultats gardés vidés).
- **Suppression qui échoue :** couper l'API pendant la suppression : la session reste en place, et la popup dit que rien n'a changé (erreur du serveur) ou qu'elle n'a pas pu joindre le serveur (réseau).
- **Purge sur une base réelle :**
  - `uv run radarnaque-purge` sur une copie de la base de dev avec des événements de 13 mois et de 11 mois : seuls les premiers disparaissent ;
  - un essai qui avait fait 3 scans il y a 13 mois n'a toujours aucune analyse restante ;
  - le temps d'un lot de 5 000 sur un volume réaliste ;
  - la tâche de fond, 60 s après le démarrage, avec `PURGE_ENABLED=true`.
- **Journaux en production :** les lignes `radarnaque.*` en `INFO` sont-elles visibles dans `docker compose logs api` ? Si la racine reste en `WARNING`, elles n'apparaissent pas.
- **Lien de la popup :** le lien « Confidentialité », dans les deux langues.

## À vérifier avant la publication de `/privacy`

- **Sauvegardes :** `infra/backup/backup.sh` fait un `pg_dump` quotidien chiffré (`age`), copié par `rclone` vers `BACKUP_RCLONE_REMOTE`. Les copies locales sont gardées 14 jours (spec principale §11). Connaître la rétention et la localisation (UE ou non) du stockage distant, puis aligner la phrase de la page (`erasure` : « effacées au fil de leur renouvellement (14 jours sur notre serveur) » ; `hosting` : « copiées vers un stockage externe »). Si la rétention distante est plus longue que 14 jours, le dire.
- **Resend :** la page dit que l'adresse email est transmise à Resend et qu'il peut la traiter hors de l'UE, sans autre détail. Vérifier le contrat de traitement et la région d'envoi de Resend, puis préciser ou garder la formule.
- **Relecture :** les textes FR et NL rendus sur `/privacy/?lang=fr` et `?lang=nl`.
- **Adresse de contact :** confirmer `privacy@mostconsult.be`.
- **Sessions expirées :** Better Auth ne supprime une session expirée que si elle est présentée à nouveau ; ajouter à la purge quotidienne un balayage des `auth.session` expirées (adresse IP et navigateur), puis la page pourra dire qu'elles sont aussi effacées à l'expiration.

## Plus tard

- **Migration 0006 et tests de la suppression (T1) :**
  - les tables de test `auth.session` et `auth.account` sont en `snake_case` alors que les vraies sont en `camelCase`, sans que le test le dise ;
  - la branche de garde `401` de `delete_account` n'est pas testée ;
  - les scans purgés ne sont comptés que pour le type `full`.
- **Purge (T2) :**
  - interblocage rare entre la purge et `DELETE /api/me` (sans dégât : l'une des deux transactions est annulée et reprise à la passe suivante) ;
  - écart passager d'affichage sur `/api/me` pendant une passe (le compteur et les événements sont lus à deux instants) ;
  - `suppress(CancelledError)` à l'arrêt de l'application.
- **Popup, suppression (T4) :**
  - le test du double clic ne prouve pas la garde `useRef` ;
  - l'assertion sur `open` est peu informative ;
  - `aria-describedby` du bouton et du champ ;
  - le focus après un échec ;
  - l'état « supprimé » est gardé jusqu'au prochain envoi d'email.
- **Relecture finale (R11 et suite) :**
  - la décision R11 laisse compter « 401 puis renouvellement refusé » comme compte supprimé (rare : session révoquée sans suppression) ;
  - l'état « compte supprimé » de la popup n'est pas remis à zéro sur une session expirée ;
  - le commentaire de `account/delete` dans `apps/extension/lib/messages.ts` (~l.49) est encore long ;
  - sur le chemin « session refusée avant envoi », les résultats IA gardés ne sont pas vidés (comme pour une expiration ordinaire).
- **Hors de la phase :**
  - l'action « supprimer un compte » de l'admin (phase 4b) ;
  - une purge configurable (durée en base plutôt qu'en constante) ;
  - un export des données de l'utilisateur (droit d'accès) : non prévu, la page `/privacy` renvoie à l'adresse de contact.

## Décisions prises pendant l'exécution

R1, R2 et R5 viennent des tâches 1 à 4 ; R3, R4 et R6 à R10 ont été prises à la tâche 5. R11 vient de la vague finale.

- **R1. Pas de limite de requêtes sur `DELETE /api/me` (T1) :** l'API ne limite que les scans (comptés sur `scan_events`) ; la route exige un JWT valide et la suppression est idempotente. Le spec (§2) le dit. Une seule suppression par compte, donc aucun abus possible. Coût si c'est faux : aucun abus constaté ; ajouter une limite par IP ou par utilisateur dans la route.
- **R2. `PURGE_ENABLED` non transmis par la composition (T2) :** `docker-compose.yml` ne le passe pas, donc la purge est toujours active en production. Voulu : on ne désactive pas la conservation limitée par oubli. Coût si c'est faux : une ligne dans le service `api`.
- **R3. Nombre de scans purgés gardé dans l'abonnement (T2) :** `subscriptions.purged_scans` plutôt qu'une table d'archive. Il ne porte aucune donnée personnelle utile et la cascade l'efface avec le compte. Coût si c'est faux : une migration pour déplacer le compteur.
- **R4. Suppression du compte et nouvel essai :** après une suppression, se reconnecter avec la même adresse crée un compte neuf, donc un nouvel essai de 3 analyses, puisque `purged_scans` part avec l'abonnement. C'est déjà possible avec une autre adresse email. Coût si c'est faux : garder une empreinte de l'email supprimé, ce qui est contraire à l'effacement ; ou accepter le contournement.
- **R5. Registre du néerlandais (T4) :**
  - **popup :** les textes NL de suppression passent au tutoiement (`je`/`jouw`), comme le reste de la popup NL. Le vouvoiement venait du plan (défaut du plan) ;
  - **site :** la page `/privacy` garde `u`/`uw`, comme le reste du site.
  - Coût si c'est faux : un registre à rechanger ; vague finale.
- **R6. Termes de la page `/privacy` :** le texte cite les libellés de la popup, « Supprimer mon compte » (FR) et « Mijn account verwijderen » (NL). Si l'un change dans `apps/extension/lib/i18n.ts`, la page doit suivre (un test vérifie le texte de la page, pas celui de la popup). Coût si c'est faux : un texte.
- **R7. Photos dans `/privacy` :** la section ne dépend plus d'une formule : « 1 photo en Standard, jusqu'à 4 en Premium et pendant l'essai ». Les nombres viennent de `plans.max_images`. Si ceux-ci changent, le texte aussi. Coût si c'est faux : un texte.
- **R8. Durée de conservation :** deux constantes séparées, `SCAN_RETENTION_MONTHS` (API) et `PRIVACY_RETENTION_MONTHS` (site), toutes deux à 12. Un test du site vérifie que celle du site vaut 12 (avec un renvoi à celle de l'API) ; aucun test ne compare les deux projets. Coût si c'est faux : une page qui annonce une durée différente de la purge.
- **R9. Nombre de recherches affiché :** la page dit « jusqu'à 3 recherches », le défaut de `settings.max_web_searches`. Ce réglage est modifiable en base (de 0 à 5) : à mettre à jour dans la page si on le change en admin. Coût si c'est faux : un texte.
- **R10. Effacement et sauvegardes :** la page ne promet plus un effacement « définitif » : les copies de sauvegarde chiffrées sont renouvelées, et la rétention distante n'est pas connue. Coût si c'est faux : une phrase à ajuster une fois la rétention du stockage distant connue.
- **R11. `session_expired` pendant une suppression :** seul un `session_expired` venu d'une réponse de l'API vaut « compte supprimé ». Un `jwt.get()` refusé avant tout envoi (`SessionExpiredBeforeSendError` dans `api-client.ts`) reste une erreur : la session est effacée comme une session expirée, la popup affiche « Votre session a expiré ». Un `401` suivi d'un renouvellement refusé compte comme un succès : c'est le cas d'un compte déjà supprimé (sa session part avec lui). Coût si c'est faux : un compte supprimé dont la réponse s'est perdue, puis la popup rouverte après un redémarrage du service worker, affiche « session expirée » au lieu de « compte supprimé » ; l'utilisateur est déconnecté dans les deux cas.

## Déclarations du Chrome Web Store à préparer

À remplir à la publication de l'extension, d'après la page `/privacy` :

- **Finalité unique :** signaler les annonces suspectes sur 2ememain.be, 2dehands.be et Facebook Marketplace (score local gratuit ; analyse IA au clic pour les comptes connectés).
- **Données collectées**, seulement avec un compte :
  - informations permettant d'identifier la personne : adresse email ;
  - contenu du site web : le contenu de l'annonce analysée (titre, description, prix, photos), sans nom, identifiant ni profil du vendeur.
- **Données non collectées :** historique de navigation, position, santé, finances, communications personnelles, activité des touches. Sans compte, rien n'est envoyé.
- **Certifications à cocher :** pas de vente de données à des tiers, pas d'utilisation sans rapport avec la finalité unique, pas d'utilisation pour juger la solvabilité.
- **URL de la politique de confidentialité :** `https://radarnaque.mostconsult.be/privacy/`.
- **Justification des permissions :** `storage` (session, langue, résultats gardés 24 h) et l'accès à l'origine de Radarnaque (`host_permissions`) ; les content scripts ne s'exécutent que sur les trois sites. Relire `apps/extension/wxt.config.ts` avant de remplir le formulaire.
- **Code distant :** aucun (tout le code est dans le paquet).
- **Sous-traitants à citer dans la description :** fournisseur d'IA (peut traiter hors de l'UE, `data_collection: "deny"` demandé), SearXNG auto-hébergé pour la recherche, Resend pour les emails de connexion (peut traiter hors de l'UE), stockage externe des sauvegardes chiffrées (rclone).
- **Contact :** `privacy@mostconsult.be` (à confirmer).
