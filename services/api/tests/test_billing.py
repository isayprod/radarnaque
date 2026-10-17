import logging

import pytest

BILLING_MESSAGE = "Le paiement en ligne n'est pas encore disponible."


def _checkout(**over: object) -> dict:
    return {"plan": "standard", "interval": "month", **over}


async def test_checkout_authenticated_answers_501(client, make_user, bearer):
    uid = await make_user("pay@b.test")
    r = await client.post("/api/billing/checkout", json=_checkout(), headers=bearer(uid))
    assert r.status_code == 501, r.text
    error = r.json()["error"]
    assert error["code"] == "billing_unavailable"
    assert error["message"] == BILLING_MESSAGE


@pytest.mark.parametrize(
    ("plan", "interval"), [("standard", "year"), ("premium", "month"), ("premium", "year")]
)
async def test_checkout_accepts_every_plan_and_interval(client, make_user, bearer, plan, interval):
    uid = await make_user("pay@b.test")
    r = await client.post(
        "/api/billing/checkout", json=_checkout(plan=plan, interval=interval), headers=bearer(uid)
    )
    assert r.status_code == 501, r.text
    assert r.json()["error"]["code"] == "billing_unavailable"


@pytest.mark.parametrize(
    "body",
    [
        _checkout(plan="trial"),
        _checkout(interval="week"),
        {"plan": "standard"},
        {**_checkout(), "extra": 1},
    ],
)
async def test_checkout_invalid_body_is_422(client, make_user, bearer, body):
    uid = await make_user("pay@b.test")
    r = await client.post("/api/billing/checkout", json=body, headers=bearer(uid))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "invalid_request"


async def test_checkout_without_jwt_is_401(client):
    r = await client.post("/api/billing/checkout", json=_checkout())
    assert r.status_code == 401, r.text
    assert r.json()["error"]["code"] == "unauthenticated"


async def test_portal_authenticated_answers_501(client, make_user, bearer):
    uid = await make_user("pay@b.test")
    r = await client.post("/api/billing/portal", headers=bearer(uid))
    assert r.status_code == 501, r.text
    assert r.json()["error"]["code"] == "billing_unavailable"
    assert r.json()["error"]["message"] == BILLING_MESSAGE


async def test_portal_without_jwt_is_401(client):
    r = await client.post("/api/billing/portal")
    assert r.status_code == 401, r.text
    assert r.json()["error"]["code"] == "unauthenticated"


async def test_webhook_answers_501_without_auth(client):
    r = await client.post(
        "/api/billing/webhooks/stripe",
        content=b'{"type":"checkout.session.completed"}',
        headers={"Stripe-Signature": "t=1,v1=secret-signature-77"},
    )
    assert r.status_code == 501, r.text
    assert r.json()["error"]["code"] == "billing_unavailable"
    assert "secret-signature-77" not in r.text
    assert "checkout.session" not in r.text


async def test_webhook_answers_501_with_empty_body_and_no_signature(client):
    r = await client.post("/api/billing/webhooks/stripe")
    assert r.status_code == 501, r.text
    assert r.json()["error"]["code"] == "billing_unavailable"


async def test_webhook_does_not_parse_json_nor_log(client, caplog):
    caplog.set_level(logging.DEBUG)
    r = await client.post(
        "/api/billing/webhooks/stripe",
        content=b"not json at all {{{ payload-marker-31",
        headers={"Stripe-Signature": "sig-marker-52"},
    )
    assert r.status_code == 501, r.text
    assert "payload-marker-31" not in caplog.text
    assert "sig-marker-52" not in caplog.text


async def test_provider_is_taken_from_app_state(app, client, make_user, bearer):
    """Un futur fournisseur Stripe remplace `app.state.billing` sans changer les routes."""

    class Recorder:
        def __init__(self) -> None:
            self.webhooks: list[tuple[bytes, str | None]] = []

        async def create_checkout(self, user, plan, interval) -> str:
            return f"https://pay.test/{user.id}/{plan}/{interval}"

        async def create_portal(self, user) -> str:
            return "https://portal.test/x"

        async def handle_webhook(self, payload: bytes, signature: str | None) -> None:
            self.webhooks.append((payload, signature))

    app.state.billing = Recorder()
    uid = await make_user("pay@b.test")
    r = await client.post(
        "/api/billing/checkout",
        json=_checkout(plan="premium", interval="year"),
        headers=bearer(uid),
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"url": f"https://pay.test/{uid}/premium/year"}
    r = await client.post("/api/billing/portal", headers=bearer(uid))
    assert r.json() == {"url": "https://portal.test/x"}
    r = await client.post(
        "/api/billing/webhooks/stripe", content=b"raw", headers={"Stripe-Signature": "s"}
    )
    assert r.status_code == 200, r.text
    assert app.state.billing.webhooks == [(b"raw", "s")]
