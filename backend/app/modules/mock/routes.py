"""公开 Mock 路由（D201）：/mock/{service_id}/{path:path}。

Mock 的用途就是被外部调用，所以**不鉴权**；服务关闭/不存在/无匹配规则一律 404。
依赖只注入 get_db（不需要用户）；规则匹配逻辑与 @service 共用 `match_rule`。
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.mock.models import MockRule, MockService
from app.modules.mock.services import match_rule

_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]


def build_mock_router(*, get_db_dep: Any) -> APIRouter:
    router = APIRouter(tags=["mock"])

    @router.api_route("/mock/{service_id}/{path:path}", methods=_METHODS)
    async def serve_mock(service_id: str, path: str, request: Request,
                         db: AsyncSession = Depends(get_db_dep)):
        service = (await db.execute(select(MockService).where(
            MockService.id == service_id, MockService.enabled.is_(True)))).scalar_one_or_none()
        if service is None:
            return JSONResponse({"code": "mock_not_found", "message": "Mock 服务不存在或未启用"},
                                status_code=404)
        rules = (await db.execute(select(MockRule).where(
            MockRule.service_id == service_id))).scalars().all()
        full_path = "/" + path if path else "/"
        hit = match_rule(list(rules), request.method, full_path)
        if hit is None:
            return JSONResponse({"code": "mock_rule_not_found",
                                 "message": "没有匹配的 Mock 规则：" + request.method + " " + full_path},
                                status_code=404)
        if hit.delay_ms:
            await asyncio.sleep(min(hit.delay_ms, 5000) / 1000.0)
        headers = dict(hit.headers or {})
        media_type = headers.pop("Content-Type", None) or headers.pop("content-type", None)
        return Response(content=hit.body or "", status_code=hit.status_code,
                        headers=headers, media_type=media_type or "text/plain")

    return router


__all__ = ["build_mock_router"]
