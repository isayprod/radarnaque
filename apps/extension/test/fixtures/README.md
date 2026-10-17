# Fixtures des marketplaces

Pages de test chargées par `loadFixture(relPath)` (voir `test/helpers.ts`).

## Origine

Les pages ont été enregistrées le **2026-10-17** depuis des annonces publiques
(2ememain.be et Facebook Marketplace), puis **minimisées et anonymisées** par un
script local. Le script et les pages brutes ne sont pas dans le dépôt.

| Fixture | Source | Contenu |
|---|---|---|
| `twh/listing-fixed.html` | annonce 2ememain, prix `FIXED` | JSON-LD, `window.__CONFIG__`, DOM de la fiche avec la section vendeur complète |
| `twh/listing-bidding-skeleton.html` | annonce 2ememain, prix `MIN_BID` | idem, section vendeur `#vendeur` encore en squelette, bloc `#bidding-root` |
| `facebook/grid.html` | grille Marketplace | navigation (`h1` « Marketplace »), 6 cartes : 3 avec `aria-label`, 3 sans (prix barré, `€ 0`, `€ 1 234`), dont une `GRATUIT` |
| `facebook/item-modal.html` | fiche ouverte en modale | 2 cartes de grille sous un `[role="dialog"]` contenant la fiche (5 photos, « A rejoint Facebook en 2007 ») |
| `facebook/item-page.html` | même fiche | contenu de la modale sous `[role="main"]`, sans dialogue ni bouton « Fermer » |

URL simulées à utiliser dans les tests :

- `listing-fixed.html` : `https://www.2ememain.be/v/telephonie/apple-iphone/m1000000001-iphone-14-pro-128gb` ;
- `listing-bidding-skeleton.html` : `https://www.2ememain.be/v/vetements-femmes/chapeaux-casquettes/m1000000002-bonnet-laine-rose` ;
- fiche Facebook : `https://www.facebook.com/marketplace/item/9000000000000007/`.

## Procédure

1. Enregistrer la page dans `web-pages/` (ignoré par git), **jamais** ailleurs.
2. Générer la fixture par script, sans copier la page :
   - 2ememain : garder `<html lang>`, un `<head>` réduit (titre, canonical,
     `hreflang`, `og:*`), les 3 blocs JSON-LD, `window.__CONFIG__` nettoyé et le
     DOM utile (fil d'Ariane, `#listing-root`, caractéristiques, description,
     `#seller-info-expanded-root`, `#seller-location-root`, `#report-root`,
     `#seller-sidebar-root`, en-tête de `#seller-other-items-root`) ;
   - Facebook : ne garder que la navigation (`h1` + recherche), les cartes
     retenues et la fiche ; retirer toutes les classes CSS ;
   - retirer partout : tous les scripts sauf JSON-LD et `__CONFIG__`, les styles,
     les feuilles de style, les SVG, les icônes, les iframes, les attributs
     `style`, les bannières et la publicité, l'en-tête et le pied de page du site,
     les globales du visiteur (configuration d'environnement, d'en-tête,
     analytique, bannières), les blocs JSON embarqués de Facebook, le bandeau,
     les notifications, le menu du compte, les « Recherches similaires », les
     liens légaux, les traces d'extensions du navigateur et les ids React ;
   - retirer les coordonnées GPS du vendeur et les cartes des autres annonces du
     vendeur (seul le compte « n annonces » reste).
3. Remplacer les vraies valeurs par les valeurs fictives ci-dessous.
4. Lancer `pnpm --filter extension test -- fixtures-hygiene` avec la liste
   locale `web-pages/.denylist.txt` présente (une vraie valeur par ligne :
   identité, ids, ville et code postal du visiteur, noms, ids et villes des
   vendeurs, ids réels des annonces, jetons, hôtes d'images réels).
5. Relire chaque fixture à l'œil avant de committer.

Le test `fixtures-hygiene.test.ts` échoue si une fixture contient un jeton, une
donnée du visiteur, un script externe, une valeur de la liste locale, ou dépasse
40 Ko. En CI, la liste locale est absente et seule cette partie est ignorée.

## Valeurs fictives

| Donnée | Valeur |
|---|---|
| Ids d'annonces 2ememain | `m1000000001` (iPhone), `m1000000002` (bonnet) |
| Identifiant vendeur 2ememain | `10000001` |
| Identifiant chiffré | 32 caractères `0` suivis de `1` |
| Nom du vendeur | `TestVendeur` |
| URL du profil | `/u/testvendeur/10000001/` (avis : `/experiences/user-reviews/10000001/`) |
| Ville | `Namur` |
| Date de publication | `2026-10-01T10:00:00Z` (DOM : `1 oct. '26, 12:00`) |
| Photos 2ememain | `//images.example/twh/<n>` + suffixe de taille réel (`$_86`, `$_83`, `$_#.jpg`) ; `mediaId` `00000000-0000-4000-8000-00000000000<n>` ; nombre réel conservé (2 et 9) |
| Vendeur Facebook | `/marketplace/profile/10000001/`, `aria-label="Vendeur Test"` |
| Photos Facebook | `https://images.example/fb/<n>.jpg` : `1` à `5` pour la fiche, `11` à `16` pour les cartes |
| Lieu de l'annonce Facebook | `Namur, WAL`, page de lieu `/marketplace/100000000000001/` |
| Ids d'annonces Facebook | grille : `9000000000000001` à `9000000000000006` ; fiche : `9000000000000007` |
| Villes des cartes Facebook | villes génériques (`Bruxelles, BRU`, `Liège, WAL`, `Leuven, VLG`, `Gent, VLG`, `Antwerpen, VLG`) |

Les titres, prix, descriptions, catégories, l'état, l'ancienneté (« 6 ans »,
« 10 ans », « A rejoint Facebook en 2007 »), les notes et nombres d'avis sont
conservés : c'est du contenu public, sans lien avec une personne une fois les
noms et ids retirés.

Le `biome.json` de ce dossier désactive le lint et le formatage : le balisage
reproduit celui des sites et ne doit pas être « corrigé ».

## Règle

**Ne jamais committer de page brute**, ni un extrait copié d'une page brute.
Toute nouvelle fixture passe par la procédure ci-dessus et par le test
d'hygiène.
