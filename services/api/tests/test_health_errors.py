import logging

from radarnaque_api.errors import ApiError


async def test_health(client):
    r = await client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


async def test_api_error_format(app, client):
    @app.get("/api/_boom")
    async def boom():
        raise ApiError(403, "forbidden", "nope", {"x": 1})

    r = await client.get("/api/_boom")
    assert r.status_code == 403
    assert r.json() == {"error": {"code": "forbidden", "message": "nope", "details": {"x": 1}}}


async def test_validation_error_format(app, client):
    @app.get("/api/_typed")
    async def typed(n: int):
        return {"n": n}

    r = await client.get("/api/_typed", params={"n": "abc"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_request"


async def test_nul_character_is_422(client, db, bearer, make_user):
    admin = await make_user("nul@radarnaque.test", "admin")
    slug = "x\u0000secret-slug"
    bodies = []

    r = await client.post(
        "/api/admin/ai/models", json={"provider": "stub", "slug": slug}, headers=bearer(admin)
    )
    bodies.append(r)
    r2 = await client.get("/api/admin/users?q=ab%00c", headers=bearer(admin))
    bodies.append(r2)

    for response in bodies:
        assert response.status_code == 422, response.text
        assert response.json() == {
            "error": {"code": "invalid_request", "message": "Requête invalide.", "details": {}}
        }
        assert "secret-slug" not in response.text
        assert "DataError" not in response.text


async def test_data_error_is_logged_without_value(client, db, bearer, make_user, caplog):
    admin = await make_user("nul-log@radarnaque.test", "admin")
    slug = "x\u0000secret-slug"
    with caplog.at_level(logging.WARNING, logger="radarnaque"):
        r = await client.post(
            "/api/admin/ai/models",
            json={"provider": "stub", "slug": slug},
            headers=bearer(admin),
        )
    assert r.status_code == 422
    lines = [rec.getMessage() for rec in caplog.records if rec.name.startswith("radarnaque.")]
    data_lines = [line for line in lines if line.startswith("DataError ")]
    assert len(data_lines) == 1, lines
    line = data_lines[0]
    assert "sqlstate" in line
    assert "secret-slug" not in line
    assert "NUL" not in line and "0x00" not in line and "\x00" not in line
    assert "secret-slug" not in caplog.text
