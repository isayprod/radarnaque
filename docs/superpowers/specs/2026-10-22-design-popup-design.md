# Design — Popup de l'extension

*Spec du 22 octobre 2026*, partie de la passe design (voir le [socle](2026-10-22-design-socle-design.md)). Livrée dans la deuxième partie, avec la landing.

## 1. Périmètre

- La popup reste une **popup de compte** : connexion par email et code, formule, quota restant, langue, déconnexion, suppression du compte. Elle n'affiche aucun résultat d'analyse ; ce sera une phase à part (popup avec résultat, puis avec lancement).
- **Aucune nouvelle permission.** La popup ne sait pas quelle page est ouverte.
- **La logique de `App.tsx` ne change pas** (états, messages au service worker, garde de vérification, suppression). Seuls le rendu, quelques textes et un lien changent.

## 2. Cadre

- **Taille :** 380 px de large (360 aujourd'hui). La hauteur suit le contenu, 600 px au plus ; seule la zone de contenu défile, l'en-tête et la barre d'actions restent fixes.
- **Fond :** `--bg-0`. Polices Inter et Instrument Serif embarquées (`fonts.css`).
- **En-tête (60 px) :** fond `--gradient-compact`, logo blanc (22 px) et « Radarnaque » en Instrument Serif 22 px à gauche. À droite, le choix FR/NL en contrôle segmenté pilule : fond navy translucide, option active en blanc avec texte `--text-on-light`, `aria-pressed` comme aujourd'hui. Un filet `--gradient-hairline` de 1 px sépare l'en-tête du contenu.
- **Contenu :** marges de 16 px, espacement vertical de 14 px.
- **Barre d'actions** (écran connecté) : bordure haute `--border-subtle`, pilule blanche à gauche, lien souligné à droite.
- **Pied :** liens soulignés en `text-xs` `--text-3`.
- **Zone de messages :** la région `aria-live` actuelle reste. Erreurs sur fond `--danger-soft` ; confirmations (email renvoyé, compte supprimé) sur fond `--success-soft`.

## 3. Écrans

Validés sur maquette.

### 3.1 Chargement

Squelette : une ligne courte, un panneau de 96 px, une ligne longue, en `--bg-3` avec le scintillement lent de `DESIGN.md` §3. Le texte « Chargement… » reste lisible par les lecteurs d'écran.

### 3.2 Déconnecté

- Titre Instrument Serif 22 px et une phrase (nouveaux textes, §4).
- Champ email (36 px, `--bg-1`, bordure `--border-default`, `--focus-ring` au focus), étiquette au-dessus.
- Pilule blanche pleine largeur (44 px) : « Recevoir mon lien de connexion ».
- Une ligne en `text-xs` `--text-3` : un lien et un code sont envoyés, pas de mot de passe (nouveau texte).
- Pied : « Confidentialité » et « Formules ».

### 3.3 Code envoyé

- Titre « Vérifiez vos emails » et la consigne actuelle (`code.instructions`).
- « Email envoyé à » et l'adresse en `--text-1`.
- **Code en six cases** (44 × 52 px, chiffres en Instrument Serif 28 px, case courante entourée de `--focus-ring`). C'est un habillage : derrière, il reste **un seul** `<input>` (`inputMode="numeric"`, `autocomplete="one-time-code"`, longueur 6). Le collage, le remplissage automatique et la vérification à 6 chiffres ne changent pas. Les cases sont décoratives (`aria-hidden`) ; le champ garde son étiquette.
- « Vérification… » pendant l'envoi.
- Liens « Renvoyer l'email » et « Changer d'adresse ».

### 3.4 Connecté

- Email en `text-xs` `--text-3`, tronqué avec points de suspension.
- **Panneau du quota** (`--bg-2`, `--r-m`) : étiquette « Analyses IA restantes », badge de formule à droite (`planName`, fond `--accent-soft`), nombre en Instrument Serif 48 px, chiffres tabulaires. Compte illimité ou sans abonnement : pas de nombre, le badge seul (`plan.unlimited`, `plan.none`, textes actuels).
- **Aide fixe :** « Ouvrez une annonce sur 2ememain, 2dehands ou Marketplace, puis cliquez sur [Analyser] à côté du titre. » La pastille y est dessinée en miniature, avec le logo statique.
- **« Supprimer mon compte »** replié (`<details>`), comme aujourd'hui.
- **Barre d'actions :** pilule blanche « Voir les formules » (nouveau lien vers `${PUBLIC_URL}/pricing/?lang=${locale}`, nouvel onglet) et lien « Se déconnecter ».
- Pied : « Confidentialité ».

### 3.5 Suppression dépliée

- Résumé « Supprimer mon compte » en `--danger`.
- Explication, étiquette « Tapez SUPPRIMER pour confirmer », champ.
- Bouton plein `--danger`, pleine largeur, 36 px, à 40 % d'opacité tant que le mot n'est pas tapé. C'est le seul bouton plein rouge de la popup (`DESIGN.md` §3).
- Comportement inchangé (garde, attente de la déconnexion, messages d'échec).

### 3.6 Service injoignable

Titre « Service injoignable », une phrase, pilule blanche pleine largeur « Réessayer » (nouveaux textes du titre et de la phrase ; `app.retry` pour le bouton).

## 4. Nouveaux textes

| Clé | FR | NL |
|---|---|---|
| `signin.title` | Repérez les arnaques avant de payer | Herken oplichting vóór je betaalt |
| `signin.lead` | Connectez-vous pour analyser les annonces de 2ememain, 2dehands et Marketplace. | Meld je aan om advertenties op 2dehands, 2ememain en Marketplace te analyseren. |
| `signin.note` | Un lien et un code vous sont envoyés par email. Pas de mot de passe. | Je krijgt een link en een code per e-mail. Geen wachtwoord. |
| `code.title` | Vérifiez vos emails | Controleer je e-mail |
| `account.how` | Ouvrez une annonce sur 2ememain, 2dehands ou Marketplace, puis cliquez sur {badge} à côté du titre. | Open een advertentie op 2dehands, 2ememain of Marketplace en klik op {badge} naast de titel. |
| `account.scansLabel` | Analyses IA restantes | Resterende AI-analyses |
| `action.pricing` | Voir les formules | Formules bekijken |
| `footer.pricing` | Formules | Formules |
| `app.unavailableTitle` | Service injoignable | Dienst onbereikbaar |
| `app.unavailableText` | Impossible de joindre Radarnaque. Vérifiez votre connexion, puis réessayez. | Radarnaque is niet bereikbaar. Controleer je verbinding en probeer opnieuw. |

`{badge}` est remplacé par la pastille miniature (nœud React), jamais par du HTML.

## 5. Tests

- `popup.test.tsx` adapté : les parcours actuels restent couverts (envoi, code, collage, renvoi, changement d'adresse, déconnexion, suppression, session expirée, service injoignable).
- **Code :** un seul champ de saisie ; six cases `aria-hidden` qui reflètent les chiffres tapés.
- **Formules :** le lien « Voir les formules » pointe vers `/pricing/?lang=fr` ou `?lang=nl` et s'ouvre dans un nouvel onglet.
- **Quota :** nombre affiché pour un compte limité ; badge seul pour un compte illimité ou sans abonnement.
- **Textes :** parité FR/NL des nouvelles clés.
- **Vérification visuelle :** chaque écran à 380 px de large, en FR et en NL, sans défilement horizontal, focus visible partout, contraste d'au moins 4,5:1.
