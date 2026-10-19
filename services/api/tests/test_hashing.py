import hashlib
import json
from datetime import date

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
        "trigger": "button",
    }
    scan.update(overrides)
    return scan


TODAY = date(2026, 10, 19)
IMAGE_B64 = "QUJD"
IMAGES_REQUESTED = 2


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
    assert input_hash(a, 2) == input_hash(ScanIn.model_validate(reordered), 2)


def test_input_hash_ignores_listing_content_and_trigger():
    a = ScanIn.model_validate(_scan())
    b = _scan(trigger="card")
    b["listing"]["description"] = "autre chose"
    assert input_hash(a, 2) == input_hash(ScanIn.model_validate(b), 2)


def test_input_hash_changes_with_signals_seller_rules_version_and_partial():
    base = input_hash(ScanIn.model_validate(_scan()), 2)
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
    hashes = [input_hash(ScanIn.model_validate(v), 2) for v in variants]
    assert base not in hashes
    assert len(set(hashes)) == len(hashes)


def test_input_hash_covers_the_listing_facts_sent_to_the_llm():
    base = input_hash(ScanIn.model_validate(_scan()), 2)
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
        hashes.append(input_hash(ScanIn.model_validate(body), 2))
    assert base not in hashes and len(set(hashes)) == len(hashes)


def _facts_sent(scan: ScanIn) -> dict:
    """Faits réellement envoyés au LLM : le bloc JSON `<annonce>` du message utilisateur."""
    sent = [IMAGE_B64] * IMAGES_REQUESTED
    text = build_messages(scan.listing, scan.rules, sent, today=TODAY)[0]["content"][0]["text"]
    return json.loads(text.split("<annonce>\n", 1)[1].split("\n</annonce>", 1)[0])


# Pour chaque fait envoyé au LLM : l'empreinte qui le couvre, et une modification du corps qui
# change sa valeur. Les faits vendeur sont détaillés un par un (`seller.<clé>`). `site` est
# couvert par la clé du cache elle-même (snapshot → listings(site_id, external_id)).
CONTENT = "content_hash"
INPUT = "input_hash"
FACT_MUTATIONS = {
    "site": ("cache_key", None),
    # Nombre de photos demandées : paramètre d'`input_hash`, vérifié par un test dédié.
    "imagesSent": ("images_requested", None),
    # Seule exception à R12 : la date du jour change chaque jour sans changer l'annonce ; elle
    # n'entre dans aucune empreinte (la durée du cache, en heures, borne l'écart).
    "today": ("excluded", None),
    "title": (CONTENT, lambda b: b["listing"].update(title="Fiets kapot")),
    "description": (CONTENT, lambda b: b["listing"].update(description="Slechte staat")),
    "maskedContacts": (
        CONTENT,
        lambda b: b["listing"].update(description="Bel 0472 12 34 56 of jan@voorbeeld.be"),
    ),
    "price": (CONTENT, lambda b: b["listing"]["price"].update(amountCents=2000)),
    "priceType": (CONTENT, lambda b: b["listing"].update(priceType="on_request")),
    "category": (INPUT, lambda b: b["listing"].update(category="Fietsen")),
    "condition": (INPUT, lambda b: b["listing"].update(condition="Gebruikt")),
    "postedAt": (INPUT, lambda b: b["listing"].update(postedAt="2026-10-01")),
    "location": (INPUT, lambda b: b["listing"]["location"].update(city="Brugge")),
    "imageCount": (
        CONTENT,
        lambda b: b["listing"]["images"].append("https://images.2dehands.com/c.jpg"),
    ),
    "seller.accountAgeMonths": (
        INPUT,
        lambda b: b["listing"]["seller"].update(accountAgeMonths={"min": 12, "max": 24}),
    ),
    "seller.reviewCount": (INPUT, lambda b: b["listing"]["seller"].update(reviewCount=9)),
    "seller.rating": (INPUT, lambda b: b["listing"]["seller"].update(rating=4.5)),
    "seller.otherListingsCount": (
        INPUT,
        lambda b: b["listing"]["seller"].update(otherListingsCount=7),
    ),
    "seller.verified": (INPUT, lambda b: b["listing"]["seller"].update(verified=True)),
    "seller.sellerKind": (
        INPUT,
        lambda b: b["listing"]["seller"].update(sellerKind="professional"),
    ),
    "signals": (INPUT, lambda b: b["rules"]["signals"][0].update(weight=99)),
}


def _fact_paths(facts: dict) -> set[str]:
    """Faits envoyés, ceux du vendeur détaillés en `seller.<clé>`."""
    paths = {key for key in facts if key != "seller"}
    return paths | {f"seller.{key}" for key in facts["seller"]}


def _fact(facts: dict, path: str):
    head, _, sub = path.partition(".")
    return facts[head][sub] if sub else facts[head]


def test_every_fact_sent_to_the_llm_has_a_declared_coverage():
    # Un champ ajouté plus tard au message du LLM fait échouer ce test (règle R12) : il faut
    # alors le couvrir par content_hash ou input_hash, puis l'ajouter à FACT_MUTATIONS.
    assert _fact_paths(_facts_sent(ScanIn.model_validate(_scan()))) == set(FACT_MUTATIONS)


@pytest.mark.parametrize("field", [k for k, (_, mutate) in FACT_MUTATIONS.items() if mutate])
def test_changing_a_fact_sent_to_the_llm_changes_its_declared_hash(field):
    coverage, mutate = FACT_MUTATIONS[field]
    base = ScanIn.model_validate(_scan())
    body = _scan()
    mutate(body)
    changed = ScanIn.model_validate(body)
    assert _fact(_facts_sent(changed), field) != _fact(_facts_sent(base), field)
    if coverage == CONTENT:
        assert _content(changed) != _content(base)
    else:
        assert input_hash(changed, IMAGES_REQUESTED) != input_hash(base, IMAGES_REQUESTED)


def test_images_sent_is_covered_by_the_requested_photo_count():
    scan = ScanIn.model_validate(_scan())
    assert input_hash(scan, 1) != input_hash(scan, 2) != input_hash(scan, 0)
    assert input_hash(scan, 2) == input_hash(scan, 2)
    facts = _facts_sent(scan)
    assert facts["imagesSent"] == IMAGES_REQUESTED


def test_today_is_in_the_message_but_in_no_hash():
    scan = ScanIn.model_validate(_scan())
    sent = [IMAGE_B64] * IMAGES_REQUESTED
    other_day = build_messages(scan.listing, scan.rules, sent, today=date(2026, 10, 20))
    assert '"today":"2026-10-20"' in other_day[0]["content"][0]["text"]
    assert _facts_sent(scan)["today"] == "2026-10-19"
    # `input_hash` n'a aucun paramètre de date : deux jours donnent la même empreinte.
    assert "today" not in input_hash.__code__.co_varnames
