import hashlib
import json

import pytest

from radarnaque_api.llm.payload import build_messages, mask_contacts
from radarnaque_api.schemas import ScanIn
from radarnaque_api.services.hashing import canonical_json, content_hash, input_hash


def _scan(**overrides) -> dict:
    scan = {
        "listing": {
            "site": "2dehands.be",
            "externalId": "m1",
            "url": "https://www.2dehands.be/v/a/m1",
            "title": "Fiets",
            "description": "Bon état",
            "price": {"amountCents": 1000, "currency": "EUR"},
            "priceType": "fixed",
            "location": {"city": "Gent"},
            "images": ["https://images.2dehands.com/a.jpg", "https://images.2dehands.com/b.jpg"],
            "seller": {"accountAgeMonths": {"min": 1, "max": 3}, "reviewCount": 2},
        },
        "rules": {
            "version": 3,
            "signals": [
                {
                    "id": "b_signal",
                    "weight": 20,
                    "severity": "warning",
                    "params": {"x": 1, "y": "a"},
                },
                {"id": "a_signal", "weight": 40, "severity": "danger"},
            ],
        },
        "scanKind": "text",
        "trigger": "button",
    }
    scan.update(overrides)
    return scan


def _content(scan: ScanIn) -> str:
    listing = scan.listing
    return content_hash(listing, mask_contacts(listing.title), mask_contacts(listing.description))


def test_canonical_json_is_sorted_compact_and_utf8():
    assert canonical_json({"b": 1, "a": "é"}) == '{"a":"é","b":1}'


def test_content_hash_is_sha256_of_the_canonical_form():
    listing = ScanIn.model_validate(_scan()).listing
    expected = {
        "title": "Fiets [email]",
        "description": "Bon état [téléphone]",
        "price": {"amountCents": 1000, "currency": "EUR"},
        "priceType": "fixed",
        "images": ["https://images.2dehands.com/a.jpg", "https://images.2dehands.com/b.jpg"],
    }
    raw = json.dumps(expected, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    got = content_hash(listing, "Fiets [email]", "Bon état [téléphone]")
    assert got == hashlib.sha256(raw.encode()).hexdigest()


def test_content_hash_uses_the_masked_texts_given():
    listing = ScanIn.model_validate(_scan()).listing
    # Le texte brut de l'annonce est ignoré : seuls les textes masqués passés comptent.
    assert content_hash(listing, "A", "B") == content_hash(
        listing.model_copy(update={"title": "autre", "description": "autre"}), "A", "B"
    )


def test_content_hash_ignores_key_order_and_non_content_fields():
    base = _scan()
    reordered = _scan()
    reordered["listing"] = dict(reversed(list(base["listing"].items())))
    reordered["listing"]["price"] = {"currency": "EUR", "amountCents": 1000}
    other_seller = _scan()
    other_seller["listing"]["seller"] = {"verified": True}
    hashes = {_content(ScanIn.model_validate(s)) for s in (base, reordered, other_seller)}
    assert len(hashes) == 1


def test_content_hash_changes_with_one_description_character():
    a = _scan()
    b = _scan()
    b["listing"]["description"] = "Bon étaT"
    assert _content(ScanIn.model_validate(a)) != _content(ScanIn.model_validate(b))


def test_content_hash_depends_on_image_order():
    a = _scan()
    b = _scan()
    b["listing"]["images"] = list(reversed(a["listing"]["images"]))
    assert _content(ScanIn.model_validate(a)) != _content(ScanIn.model_validate(b))


def test_input_hash_ignores_signal_order_and_key_order():
    a = ScanIn.model_validate(_scan())
    reordered = _scan()
    reordered["rules"]["signals"] = [
        {"severity": "danger", "weight": 40, "id": "a_signal"},
        {"params": {"y": "a", "x": 1}, "severity": "warning", "weight": 20, "id": "b_signal"},
    ]
    reordered["listing"]["seller"] = {"reviewCount": 2, "accountAgeMonths": {"max": 3, "min": 1}}
    assert input_hash(a) == input_hash(ScanIn.model_validate(reordered))


def test_input_hash_ignores_listing_content_and_trigger():
    a = ScanIn.model_validate(_scan())
    b = _scan(trigger="card")
    b["listing"]["description"] = "autre chose"
    assert input_hash(a) == input_hash(ScanIn.model_validate(b))


def test_input_hash_changes_with_signals_seller_rules_version_and_partial():
    base = input_hash(ScanIn.model_validate(_scan()))
    variants = []
    weight = _scan()
    weight["rules"]["signals"][0]["weight"] = 21
    variants.append(weight)
    params = _scan()
    params["rules"]["signals"][0]["params"] = {"x": 2, "y": "a"}
    variants.append(params)
    seller = _scan()
    seller["listing"]["seller"]["reviewCount"] = 3
    variants.append(seller)
    version = _scan()
    version["rules"]["version"] = 4
    variants.append(version)
    variants.append(_scan(partial=True))
    hashes = [input_hash(ScanIn.model_validate(v)) for v in variants]
    assert base not in hashes
    assert len(set(hashes)) == len(hashes)


def test_input_hash_covers_the_listing_facts_sent_to_the_llm():
    base = input_hash(ScanIn.model_validate(_scan()))
    changes = [
        ("category", "Fietsen"),
        ("condition", "Gebruikt"),
        ("postedAt", "2026-10-01"),
        ("location", {"city": "Brugge"}),
        ("location", {"city": "Gent", "region": "Oost-Vlaanderen"}),
    ]
    hashes = []
    for key, value in changes:
        body = _scan()
        body["listing"][key] = value
        hashes.append(input_hash(ScanIn.model_validate(body)))
    assert base not in hashes and len(set(hashes)) == len(hashes)


def _facts_sent(scan: ScanIn) -> dict:
    """Faits réellement envoyés au LLM : le bloc JSON `<annonce>` du message utilisateur."""
    text = build_messages(scan.listing, scan.rules, [])[0]["content"][0]["text"]
    return json.loads(text.split("<annonce>\n", 1)[1].split("\n</annonce>", 1)[0])


# Pour chaque champ envoyé au LLM : une modification du corps qui change sa valeur. `site` est
# couvert par la clé du cache elle-même (snapshot → listings(site_id, external_id)).
FACT_MUTATIONS = {
    "site": None,
    "title": lambda b: b["listing"].update(title="Fiets kapot"),
    "description": lambda b: b["listing"].update(description="Slechte staat"),
    "price": lambda b: b["listing"]["price"].update(amountCents=2000),
    "priceType": lambda b: b["listing"].update(priceType="bidding"),
    "category": lambda b: b["listing"].update(category="Fietsen"),
    "condition": lambda b: b["listing"].update(condition="Gebruikt"),
    "postedAt": lambda b: b["listing"].update(postedAt="2026-10-01"),
    "location": lambda b: b["listing"]["location"].update(city="Brugge"),
    "imageCount": lambda b: b["listing"]["images"].append("https://images.2dehands.com/c.jpg"),
    "seller": lambda b: b["listing"]["seller"].update(reviewCount=9),
    "signals": lambda b: b["rules"]["signals"][0].update(weight=99),
}


def test_every_fact_sent_to_the_llm_has_a_declared_coverage():
    # Un champ ajouté plus tard au message du LLM fait échouer ce test (règle R12) : il faut
    # alors le couvrir par content_hash ou input_hash, puis l'ajouter à FACT_MUTATIONS.
    assert set(_facts_sent(ScanIn.model_validate(_scan()))) == set(FACT_MUTATIONS)


@pytest.mark.parametrize("field", [k for k, mutate in FACT_MUTATIONS.items() if mutate])
def test_changing_a_fact_sent_to_the_llm_changes_the_cache_key(field):
    base = ScanIn.model_validate(_scan())
    body = _scan()
    FACT_MUTATIONS[field](body)
    changed = ScanIn.model_validate(body)
    assert _facts_sent(changed)[field] != _facts_sent(base)[field]
    assert (_content(changed), input_hash(changed)) != (_content(base), input_hash(base))
