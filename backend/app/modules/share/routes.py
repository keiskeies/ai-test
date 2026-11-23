"""公开分享路由（D202）：GET /api/v1/share/{token}，不鉴权。

密码可走 `?password=` 或 `X-Share-Password` 头；缺/错密码 401（details.password_required）。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.share.services import resolve_share


def build_share_router(*, get_db_dep: Any) -> APIRouter:
    router = APIRouter(tags=["share"])

    @router.get("/share/{token}")
    async def public_share(token: str, request: Request,
                           password: str | None = Query(default=None),
                           x_share_password: str | None = Header(default=None),
                           db: AsyncSession = Depends(get_db_dep)):
        payload = await resolve_share(db, token, password or x_share_password)
        return JSONResponse(payload)

    return router


__all__ = ["build_share_router"]
