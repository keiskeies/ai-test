from httpx import ASGITransport, AsyncClient


async def test_healthz_ok() -> None:
    from app.main import create_app

    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/v1/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
