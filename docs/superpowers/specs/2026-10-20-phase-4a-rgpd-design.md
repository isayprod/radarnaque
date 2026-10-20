# Phase 4a — RGPD : suppression du compte, purge à 12 mois, page de confidentialité

*Spec du 20 octobre 2026.* Ce document complète la [spécification principale](2026-10-16-radarnaque-v4-design.md). Il en précise les §7.1 (`DELETE /api/me`), §10 (vie privée) et §4.6 (messagerie). La phase 4 est découpée en deux parties : 4a (RGPD, ce document), puis 4b (administration).

Branche : `feat/phase-4a`, au-dessus de `feat/phase-3d`.

## 1. Objectifs

1. **Effacement par l'utilisateur.** Un utilisateur connecté supprime lui-même son compte et toutes ses données personnelles, depuis la popup de l'extension.
2. **Conservation limitée.** L'historique des scans est purgé après 12 mois, automatiquement.
3. **Page `/privacy` publiable.** Elle décrit fidèlement ce que fait le produit après la phase 3d.

Hors de cette phase :
- l'action « supprimer un compte » de l'admin (4b) ;
- les déclarations du Chrome Web Store (seulement listées dans le suivi).

## 2. Suppression du compte : `DELETE /api/me`

- **Accès :** utilisateur authentifié par JWT, quel que soit son rôle (user, admin, superuser). Pas d'abonnement requis. Pas de limite de requêtes dédiée : la route exige un JWT valide et la suppression est idempotente (décision R1 du suivi).
- **Effet :** dans une seule transaction, l'API supprime la ligne `auth."user"` de l'utilisateur (`sub` du JWT). Les clés étrangères en `ON DELETE CASCADE` effacent :
  - `auth.session` et `auth.account` ;
  - `app.subscriptions` ;
  - `app.scan_events`, puis `app.scan_results` et `app.scan_failures`.
- **Ce qui reste :** `app.analyses`, leurs textes, raisons et recherches, et les snapshots d'annonces. Ce ne sont pas des données personnelles (§6.4 de la spécification principale). Un code de connexion en attente (`auth.verification`) pour cet email expire de lui-même.
- **Réponse :** `204` sans corps. Un utilisateur déjà absent donne `401 unauthenticated`, comme toute requête dont le `sub` n'existe pas.
- **Après :** la session de l'extension n'existe plus ; un JWT encore valide (15 min au plus) donne `401`, puisque l'utilisateur est introuvable.
- **Journal :** une ligne `INFO` « compte supprimé », sans identifiant ni email.

## 3. Bouton dans la popup

- **Section « Supprimer mon compte »**, en bas de la popup quand l'utilisateur est connecté, repliée par défaut.
- **Ouverte, elle affiche :**
  - ce qui est effacé (compte, abonnement, historique des analyses) et ce qui reste (les analyses d'annonces, anonymes) ;
  - un champ où taper `SUPPRIMER` en FR ou `VERWIJDEREN` en NL. La casse et les espaces autour sont ignorés ;
  - un bouton rouge « Supprimer définitivement », actif seulement quand le mot est exact.
- **Message :** `account/delete`, accepté **uniquement** depuis une page de l'extension (popup), jamais depuis un content script. Il ne fait pas partie de `CONTENT_SCRIPT_MESSAGES`.
- **Service worker :**
  1. appelle `DELETE /api/me` ;
  2. sur `204` (ou `401` de l'API, compte déjà absent), efface le jeton de session, invalide le JWT et vide les résultats IA gardés (`clearAiResults`) ;
  3. si le JWT ne peut être obtenu avant tout envoi (`session_expired`), aucune requête n'est partie : la session est effacée comme une session expirée et le code est renvoyé, sans succès ;
  4. sur une autre erreur, ne touche à rien et renvoie le code.
- **Popup :** pendant l'appel, le bouton affiche « Suppression… ». Après la suppression : le message « Votre compte a été supprimé. » et l'écran de connexion. En cas d'erreur : « La suppression a échoué, votre compte n'a pas été modifié. Réessayez. » ; si le serveur est injoignable (`network`, `background_unavailable`) : « Impossible de joindre le serveur. Si votre compte a été supprimé, vous serez déconnecté. » ; sur `session_expired`, l'écran de connexion avec « Votre session a expiré. Reconnectez-vous. ». Pendant une suppression, « Se déconnecter » est désactivé, et inversement.
- **Lien « Confidentialité »** dans le pied de la popup, vers `/privacy/?lang=<langue>`.

## 4. Purge à 12 mois

- **Règle :** les `scan_events` dont `created_at` est antérieur à maintenant moins 12 mois sont supprimés, avec leurs `scan_results` et `scan_failures` (cascade). La durée est une constante, `SCAN_RETENTION_MONTHS = 12`, la même que celle affichée par la page `/privacy`.
- **Quota de l'essai :** l'essai a un quota « à vie » compté sur les `scan_events`. Avant de supprimer, la purge ajoute à chaque abonnement à période `lifetime` le nombre de ses scans réussis purgés (événements de l'utilisateur, sans `scan_failures`, depuis `period_start`). Ce nombre va dans une nouvelle colonne, `subscriptions.purged_scans INTEGER NOT NULL DEFAULT 0`. Le calcul de la consommation (`compute_usage`) l'ajoute au nombre de scans utilisés de la période et au plafond total. Les périodes mensuelles ne sont pas concernées : un événement de plus de 12 mois est hors de toute période en cours.
- **Lots :** la suppression se fait par lots de 5 000 événements, chacun dans sa transaction, jusqu'à ce qu'il n'en reste plus.
- **Planification :** une tâche de fond de l'API, lancée au démarrage (après 60 s), puis toutes les 24 h. Elle prend `pg_try_advisory_lock` sur une clé fixe : si un autre processus purge déjà, elle passe son tour (ligne `INFO` « purge déjà en cours ailleurs, passe sautée »). Un index `ix_scan_events_created_at` (migration 0006) sert la recherche par date. Une erreur est journalisée et n'arrête pas l'API ; la purge suivante réessaie.
- **Commande manuelle :** `uv run radarnaque-purge`, qui fait une passe et affiche le nombre d'événements supprimés.
- **Journal :** une ligne `INFO` avec le nombre d'événements supprimés, jamais d'identifiant.
- **Désactivation en test :** `PURGE_ENABLED=false` empêche la tâche de fond, valeur par défaut des tests.

## 5. Page `/privacy`

Textes FR et NL mis à jour dans `apps/site/src/pages-i18n.ts` :

- **Photos :** toute analyse IA envoie les photos de l'annonce (1 en Standard, jusqu'à 4 en Premium et pendant l'essai), téléchargées par notre serveur puis envoyées à l'IA.
- **Recherche web (nouvelle section) :** pendant une analyse, l'IA peut faire jusqu'à 3 recherches sur le web, sur l'objet (modèle, prix du marché). Les requêtes ne contiennent ni l'identité du vendeur ni vos données ; les numéros de téléphone et les emails en sont masqués. Elles partent de notre serveur vers des moteurs de recherche, par notre propre service de recherche.
- **Navigateur :** le résultat d'une analyse est gardé 24 h dans votre navigateur ; il est effacé à la déconnexion.
- **Conservation :** l'historique des analyses est supprimé après 12 mois. On garde seulement, pour l'essai, le nombre d'analyses déjà utilisées. Le temps d'une session de connexion, l'adresse IP et le navigateur utilisés sont aussi gardés, effacés à la fin de la session et à la suppression du compte.
- **Effacement :** depuis la popup de l'extension, « Supprimer mon compte ». Contact : `privacy@mostconsult.be` (adresse confirmée par l'utilisateur).
- **Publication :** le commentaire « Ne pas publier avant la phase 4 » est retiré.

## 6. Erreurs

| Cas | Comportement |
|---|---|
| `DELETE /api/me` échoue en base | `500`, rien n'est supprimé (transaction annulée), la popup affiche l'erreur |
| Réseau coupé pendant la suppression | la popup affiche l'erreur ; si le serveur a supprimé le compte, la prochaine requête donne `401` et la session est effacée comme une session expirée |
| Content script qui envoie `account/delete` | `forbidden_sender`, sans appel réseau |
| Purge en échec sur un lot | lots précédents conservés supprimés, erreur journalisée, reprise à la passe suivante |
| Deux processus de l'API | un seul purge (verrou consultatif) |

## 7. Tests

- **API :**
  - `DELETE /api/me` : 204, cascade vérifiée table par table, analyses conservées, 401 ensuite, 401 sans JWT ;
  - purge : bornée à 12 mois (un événement de 11 mois reste), par lots, avec `scan_results` et `scan_failures` ;
  - compteur de l'essai : un essai qui a fait 3 scans il y a 13 mois a toujours 0 analyse restante après la purge ;
  - verrou : une seconde purge simultanée passe son tour ;
  - la tâche de fond ne démarre pas avec `PURGE_ENABLED=false` ;
  - migration 0006 (`purged_scans`), montée et descente.
- **Extension :**
  - `account/delete` refusé depuis un content script ;
  - nettoyage local après 204 et après 401, rien après une autre erreur ;
  - popup : bouton inactif tant que le mot n'est pas tapé, en FR et en NL ; messages de succès et d'erreur ; lien « Confidentialité ».
- **Site :** sections FR et NL complètes et dans l'ordre, `{months}` et `{email}` remplis.
