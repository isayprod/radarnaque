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


def input_hash(scan: ScanIn) -> str:
    """Empreinte de ce qui, hors contenu, change l'analyse : faits sur le vendeur (le schéma
    d'entrée refuse son identité), version des règles, signaux triés par identifiant (avec leurs
    paramètres) et scan partiel. Des signaux forgés donnent donc une autre clé de cache."""
    signals = [s.model_dump(mode="json", by_alias=True) for s in scan.rules.signals]
    return _sha256(
        {
            "seller": scan.listing.seller.model_dump(mode="json", by_alias=True),
            "rulesVersion": scan.rules.version,
            "signals": sorted(signals, key=lambda s: (s["id"], canonical_json(s))),
            "partial": scan.partial,
        }
    )
