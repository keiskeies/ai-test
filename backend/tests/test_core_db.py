"""core 底座：config / UtcDateTime / ApiError / paginate。"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import Column, MetaData, String, Table, insert, select


def _probe_table():
    from app.core.db import UtcDateTime

    meta = MetaData()
    return Table(
        "_utc_probe",
        meta,
        Column("id", String(36), primary_key=True),
        Column("at", UtcDateTime()),
    )


async def test_settings_prefix_and_cache() -> None:
    from app.core.config import Settings, get_settings

    s = get_settings()
    assert isinstance(s, Settings)
    assert s.env == "test"
    assert get_settings() is s


async def test_utc_datetime_roundtrip(session) -> None:
    t = _probe_table()
    await session.run_sync(lambda sc: t.create(sc.get_bind(), checkfirst=True))
    now = datetime(2026, 11, 14, 13, 0, 0, tzinfo=UTC)
    await session.execute(insert(t).values(id="p1", at=now))
    east = (now + timedelta(hours=8)).replace(tzinfo=timezone(timedelta(hours=8)))
    await session.execute(insert(t).values(id="p2", at=east))
    await session.commit()
    rows = (await session.execute(select(t.c.id, t.c.at).order_by(t.c.id))).all()
    assert [r[0] for r in rows] == ["p1", "p2"]
    for r in rows:
        assert r[1].tzinfo is not None
        assert r[1].utcoffset().total_seconds() == 0
        assert r[1] == now
    await session.run_sync(lambda sc: t.drop(sc.get_bind(), checkfirst=True))


async def test_api_error_envelope_and_internal() -> None:
    from fastapi import FastAPI

    from app.core.errors import ApiError, install_error_handlers

    app = FastAPI()
    install_error_handlers(app)

    @app.get("/boom")
    async def boom():
        raise ApiError("bad_cursor", "游标非法", 400, {"cursor": "!!!"})

    @app.get("/internal")
    async def internal():
        raise ZeroDivisionError("nope")

    # raise_app_exceptions=False：让 Starlette ServerErrorMiddleware 的 500 信封落地可见
    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t") as c:
        r = await c.get("/boom")
        assert r.status_code == 400
        assert r.json() == {"code": "bad_cursor", "message": "游标非法", "details": {"cursor": "!!!"}}
        r2 = await c.get("/internal")
        assert r2.status_code == 500
        assert r2.json()["code"] == "internal"
        r3 = await c.get("/nothing")
        assert r3.status_code == 404


async def test_validation_error_envelope() -> None:
    from fastapi import FastAPI
    from pydantic import BaseModel

    from app.core.errors import install_error_handlers

    app = FastAPI()
    install_error_handlers(app)

    class In(BaseModel):
        n: int

    @app.post("/need")
    async def need(payload: In):
        return {"n": payload.n}

    async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t") as c:
        r = await c.post("/need", json={"n": "abc"})
        assert r.status_code == 422
        assert r.json()["code"] == "validation_failed"


async def test_paginate_and_bad_cursor(session) -> None:
    from app.core.errors import ApiError, paginate

    t = _probe_table()
    await session.run_sync(lambda sc: t.create(sc.get_bind(), checkfirst=True))
    now = datetime(2026, 1, 1, tzinfo=UTC)
    await session.execute(insert(t).values([{"id": f"i{i:02}", "at": now} for i in range(5)]))
    await session.commit()
    stmt = select(t.c.id).order_by(t.c.id)
    kw = {"cursor_col": t.c.id, "row_key": lambda r: r[0]}
    page = await paginate(session, stmt, cursor=None, size=2, **kw)
    assert [r[0] for r in page.items] == ["i00", "i01"]
    assert page.next_cursor
    page2 = await paginate(session, stmt, cursor=page.next_cursor, size=2, **kw)
    assert [r[0] for r in page2.items] == ["i02", "i03"]
    page3 = await paginate(session, stmt, cursor=page2.next_cursor, size=2, **kw)
    assert [r[0] for r in page3.items] == ["i04"] and page3.next_cursor is None
    with pytest.raises(ApiError) as ei:
        await paginate(session, stmt, cursor="%%%bad", size=2, **kw)
    assert ei.value.code == "bad_cursor"
    await session.run_sync(lambda sc: t.drop(sc.get_bind(), checkfirst=True))
