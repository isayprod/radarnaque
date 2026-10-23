# Identification — régression « Vespa 946 Cheval » (à traiter après la pastille unique)

*Noté le 23 octobre 2026.* À reprendre une fois la refonte de la pastille (identification puis risque dans une seule pilule) terminée.

## Le cas

- Annonce 2ememain « Vespa 946 Cheval », 12 000 €, vendeur professionnel, 4 photos analysées.
- Résultat : « vespa 946 cheval 125 cm³ · Incertain 59 % », sans page de référence.
- Le bon produit est la **Vespa 946 Horse 125** (« cheval » est la traduction de *Horse*) ; une recherche Google sur les mots du vendeur, avec ou sans « 125 cm³ », donne en premier lien la page du fabricant (`vespa.com/be_FR/models/vespa-946-horse/`).

## Ce qui s'est passé (base de dev, identification n° 2)

- `read_photos` : un seul candidat, `vespa 946 cheval 125 cm³`, recopié du titre du vendeur. Le modèle n'a pas proposé le nom officiel.
- Un seul candidat : pas d'étape `criteria`, donc aucun critère ni aucune vérification.
- Recherches : `vespa 946 cheval 125 cm³ fiche technique` (référence) et `… prix occasion` (prix).
- **La recherche fonctionne** : interrogé avec ces requêtes exactes, notre SearXNG renvoie la page vespa.com « Vespa 946 Horse 125 : prix, consommation, couleurs », la fiche technique L'argus « 946 125 Horse » et d'autres pages « 946 Horse ».
- `identify` a vu ces résultats mais n'a retenu **ni référence ni page** : le nom officiel (« Horse ») ne correspondait à aucun candidat (« cheval »). Référence nulle → confiance plafonnée à 59 (« Incertain »). Pas de `retry_query`, donc pas de relance.
- Le libellé s'affiche en minuscules : c'est le nom normalisé (clé de la base de critères) qui sert à l'affichage.

## Cause

L'étape `identify` reste ancrée sur les candidats de `read_photos` : elle ne sait pas qu'un nom traduit ou un surnom du vendeur peut correspondre au nom officiel trouvé dans les résultats, et rien ne lui fait préférer une page du fabricant.

## Pistes (à évaluer avec `pnpm eval:identify`, ce cas ajouté au jeu)

1. **Prompt `identify` v2** (migration) : un nom officiel trouvé dans un résultat, surtout sur le site du fabricant, devient la référence quand il correspond aux photos et au titre, y compris s'il n'est pas parmi les candidats (traduction, surnom, édition récente) ; choisir alors cette page parmi les pages de référence ; `retry_query` obligatoire si la référence reste nulle.
2. **Prompt `read_photos` v2** : candidats au nom officiel du fabricant quand il est connu ; si le nom du vendeur ressemble à une traduction ou à un surnom, garder les deux formes.
3. **Preuve « site du fabricant »** : la référence retenue figure dans le titre d'un résultat dont le domaine correspond à la marque (`vespa.com` pour Vespa) → plancher de confiance (par exemple 90), comme une référence lue sur une étiquette. Sans correspondance marque ↔ domaine, la règle ne s'applique pas.
4. **Relance garantie** quand la référence est nulle : à défaut de `retry_query`, l'API en construit une (marque et famille, sans suffixe).
5. **Recherche de découverte** sur le titre du vendeur (contacts masqués, ~8 mots), résultats envoyés à `identify` seulement, jamais à `criteria` : utile si un cas montre que nos requêtes ratent la page ; ce n'est **pas** la cause ici.
6. **Affichage** : garder la casse d'origine des noms ; la forme normalisée ne sert qu'à la clé de la base de critères.
