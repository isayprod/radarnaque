import pytest
from pydantic import ValidationError

from radarnaque_api.schemas import ListingIn, RulesIn, ScanIn, SellerFactsIn, SignalIn


def _listing() -> dict:
    return {
        "site": "2dehands.be",
        "externalId": "m1",
        "url": "https://www.2dehands.be/v/a/m1",
        "title": "Fiets",
        "description": "",
        "price": None,
        "priceType": "unknown",
        "category": None,
        "condition": None,
        "postedAt": None,
        "location": {"city": None, "region": None, "country": None},
        "images": [],
        "seller": {},
    }


def _scan(**listing_overrides) -> dict:
    return {
        "listing": {**_listing(), **listing_overrides},
        "rules": {"version": 1, "signals": []},
        "trigger": "button",
    }


def test_valid_scan_parses_camel_case():
    scan = ScanIn.model_validate(_scan())
    assert scan.partial is False
    assert scan.listing.external_id == "m1"
    assert scan.listing.seller == SellerFactsIn()
    assert scan.rules.version == 1


@pytest.mark.parametrize("field", ["name", "id", "profileUrl"])
def test_seller_identity_fields_are_rejected(field):
    scan = _scan(seller={"reviewCount": 3, field: "x"})
    with pytest.raises(ValidationError) as info:
        ScanIn.model_validate(scan)
    assert info.value.errors()[0]["type"] == "extra_forbidden"
    assert info.value.errors()[0]["loc"] == ("listing", "seller", field)


def test_unknown_fields_are_rejected_everywhere():
    with pytest.raises(ValidationError):
        ScanIn.model_validate({**_scan(), "extra": 1})
    with pytest.raises(ValidationError):
        ScanIn.model_validate(_scan(sellerName="Jean"))
    with pytest.raises(ValidationError):
        RulesIn.model_validate({"version": 1, "signals": [], "x": 1})


def test_limits_on_title_description_and_images():
    ListingIn.model_validate({**_listing(), "title": "t" * 300, "description": "d" * 5000})
    ListingIn.model_validate({**_listing(), "images": [f"https://i.be/{i}.jpg" for i in range(10)]})
    with pytest.raises(ValidationError):
        ListingIn.model_validate({**_listing(), "title": "t" * 301})
    with pytest.raises(ValidationError):
        ListingIn.model_validate({**_listing(), "title": ""})
    with pytest.raises(ValidationError):
        ListingIn.model_validate({**_listing(), "description": "d" * 5001})
    with pytest.raises(ValidationError):
        ListingIn.model_validate(
            {**_listing(), "images": [f"https://i.be/{i}.jpg" for i in range(11)]}
        )


def test_attributes_are_accepted_in_order_and_default_to_empty():
    attributes = [
        {"label": "Kilométrage", "value": "155.562 km"},
        {"label": "Année", "value": "2004"},
    ]
    listing = ListingIn.model_validate({**_listing(), "attributes": attributes})
    assert [(a.label, a.value) for a in listing.attributes] == [
        ("Kilométrage", "155.562 km"),
        ("Année", "2004"),
    ]
    assert ListingIn.model_validate(_listing()).attributes == []
    ListingIn.model_validate(
        {**_listing(), "attributes": [{"label": "l" * 60, "value": "v" * 200}] * 30}
    )


@pytest.mark.parametrize(
    "attributes",
    [
        [{"label": "Année", "value": "2004"}] * 31,
        [{"label": "l" * 61, "value": "2004"}],
        [{"label": "Année", "value": "v" * 201}],
        [{"label": "", "value": "2004"}],
        [{"label": "Année", "value": ""}],
        [{"label": "Année", "value": "2004", "key": "constructionYear"}],
    ],
)
def test_invalid_attributes_are_rejected(attributes):
    with pytest.raises(ValidationError):
        ListingIn.model_validate({**_listing(), "attributes": attributes})


@pytest.mark.parametrize(
    "override",
    [
        {"site": "ebay.be"},
        {"externalId": ""},
        {"externalId": "x" * 65},
        {"url": "pas une url"},
        {"price": {"amountCents": -1, "currency": "EUR"}},
        {"price": {"amountCents": 100, "currency": "USD"}},
        {"priceType": "auction"},
        {"images": ["pas une url"]},
        {"seller": {"accountAgeMonths": {"min": 5, "max": 2}}},
        {"seller": {"accountAgeMonths": {"min": -1, "max": 2}}},
        {"seller": {"reviewCount": -1}},
        {"seller": {"rating": 5.5}},
        {"seller": {"otherListingsCount": -1}},
        {"seller": {"sellerKind": "shop"}},
    ],
)
def test_invalid_listing_values_are_rejected(override):
    with pytest.raises(ValidationError):
        ListingIn.model_validate({**_listing(), **override})


@pytest.mark.parametrize(
    "price_type",
    [
        "fixed",
        "bidding",
        "free",
        "on_request",
        "see_description",
        "exchange",
        "reserved",
        "unknown",
    ],
)
def test_every_price_type_is_accepted(price_type):
    listing = ListingIn.model_validate({**_listing(), "priceType": price_type})
    assert listing.price_type == price_type


@pytest.mark.parametrize("kind", ["private", "professional"])
def test_seller_kind_is_accepted(kind):
    listing = ListingIn.model_validate({**_listing(), "seller": {"sellerKind": kind}})
    assert listing.seller.seller_kind == kind


def test_seller_kind_is_optional():
    assert ListingIn.model_validate(_listing()).seller.seller_kind is None


def test_signal_and_rules_limits():
    SignalIn.model_validate({"id": "s" * 40, "weight": 100, "severity": "info"})
    for bad in (
        {"id": "", "weight": 1, "severity": "info"},
        {"id": "s" * 41, "weight": 1, "severity": "info"},
        {"id": "s", "weight": 101, "severity": "info"},
        {"id": "s", "weight": -1, "severity": "info"},
        {"id": "s", "weight": 1, "severity": "critical"},
        {"id": "s", "weight": 1, "severity": "info", "params": {"k": [1]}},
    ):
        with pytest.raises(ValidationError):
            SignalIn.model_validate(bad)
    signal = {"id": "s", "weight": 1, "severity": "info"}
    RulesIn.model_validate({"version": 1, "signals": [signal] * 20})
    with pytest.raises(ValidationError):
        RulesIn.model_validate({"version": 1, "signals": [signal] * 21})
    with pytest.raises(ValidationError):
        RulesIn.model_validate({"version": 0, "signals": []})


def test_scan_in_rejects_scan_kind():
    # Le type de scan n'est plus un choix du client (`extra="forbid"`).
    for kind in ("text", "image", "full"):
        with pytest.raises(ValidationError) as info:
            ScanIn.model_validate({**_scan(), "scanKind": kind})
        assert info.value.errors()[0]["type"] == "extra_forbidden"


def test_trigger_is_a_closed_list():
    with pytest.raises(ValidationError):
        ScanIn.model_validate({**_scan(), "trigger": "auto"})


def test_no_cache_is_optional_and_false_by_default():
    assert ScanIn.model_validate(_scan()).no_cache is False
    assert ScanIn.model_validate({**_scan(), "noCache": True}).no_cache is True


def test_no_cache_is_optional_in_the_openapi_contract():
    # Sans `default` ni `required` : le type TypeScript généré est `noCache?: boolean`.
    schema = ScanIn.model_json_schema()
    assert "noCache" not in schema["required"]
    assert schema["properties"]["noCache"] == {"title": "Nocache", "type": "boolean"}
