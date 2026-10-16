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
