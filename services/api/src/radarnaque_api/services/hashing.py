"""Empreintes du cache d'analyses : forme JSON canonique, puis SHA-256 en hexadécimal."""

import hashlib
import json
from typing import Any

from radarnaque_api.schemas import ListingIn, ScanIn


def canonical_json(obj: Any) -> str:
    """Clés triées, sans espace, UTF-8 littéral : deux objets égaux ont le même texte."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _sha256(obj: Any) -> str:
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


def content_hash(listing: ListingIn, masked_title: str, masked_description: str) -> str:
    """Empreinte du contenu de l'annonce, sur le titre et la description **déjà masqués**
    (ceux du snapshot et du message envoyé au LLM). L'ordre des images compte."""
    price = listing.price
    return _sha256(
        {
            "title": masked_title,
            "description": masked_description,
            "price": None
            if price is None
            else {"amountCents": price.amount_cents, "currency": price.currency},
            "priceType": listing.price_type,
            "images": [str(url) for url in listing.images],
        }
    )


def input_hash(scan: ScanIn, images_requested: int) -> str:
    """Empreinte de ce qui, hors contenu du snapshot, change l'analyse : faits sur le vendeur (le
    schéma d'entrée refuse son identité), catégorie, état, date de publication et lieu, version
    des règles, signaux triés par identifiant (avec leurs paramètres), scan partiel et nombre de
    photos envoyées (`images_requested` : celui du plan et du fournisseur, borné par les photos de
    l'annonce ; un Standard à 1 photo et un Premium à 4 n'ont pas la même analyse).

    Invariant (règle R12) : tout champ envoyé au LLM (`llm.payload.build_messages`) est couvert
    par `content_hash` ou par cette empreinte, sinon une annonce forgée (signaux, catégorie…)
    empoisonnerait le cache de tous les utilisateurs. `imagesSent` l'est par `images_requested`.
    Seule exception : `today`, la date du jour, change chaque jour sans que l'annonce change ; la
    durée du cache (en heures) borne l'écart. Vérifié par tests/test_hashing.py."""
    listing = scan.listing
    signals = [s.model_dump(mode="json", by_alias=True) for s in scan.rules.signals]
    return _sha256(
        {
            "seller": listing.seller.model_dump(mode="json", by_alias=True),
            "category": listing.category,
            "condition": listing.condition,
            "postedAt": listing.posted_at,
            "location": listing.location.model_dump(mode="json", by_alias=True),
            "rulesVersion": scan.rules.version,
            "signals": sorted(signals, key=lambda s: (s["id"], canonical_json(s))),
            "partial": scan.partial,
            "imagesRequested": images_requested,
        }
    )
