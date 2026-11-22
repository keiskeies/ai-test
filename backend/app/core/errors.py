"""统一错误信封与游标分页（§12.1）。

错误包 {code, message, details}；游标分页 {items, next_cursor}。
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    """业务错误：由全局 handler 输出统一信封。"""

    def __init__(self, code: str, message: str, http_status: int = 400, details: dict[str, Any] | None = None) -> None:
        self.code = code
        self.message = message
        self.http_status = http_status
        self.details = details or {}
        super().__init__(f"{code}: {message}")


_JSON_NATIVE = (str, int, float, bool, type(None))


def _jsonable(v: Any) -> Any:
    """深度转 JSON 原生：剔除 Pydantic v2 错误里的 ctx（含不可序列化异常对象）。"""
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items() if k != "ctx"}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, _JSON_NATIVE):
        return v
    return str(v)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content={"code": exc.code, "message": exc.message, "details": exc.details},
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return JSONResponse(
            status_code=exc.status_code,
            content={"code": code, "message": str(exc.detail), "details": {}},
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"code": "validation_failed", "message": "参数校验失败", "details": {"errors": _jsonable(exc.errors())}},
        )

    # 带路径参数的路由用 create_model 重建 body 模型，@field_validator 不跟着继承，
    # 于是校验只在 service.py 的 model_validate 里炸——不接住就是 500「服务内部错误」，
    # 用户看不到自己哪个字段写错了。与 RequestValidationError 同信封，前端只认一种形状。
    @app.exception_handler(ValidationError)
    async def _pydantic(_: Request, exc: ValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"code": "validation_failed", "message": "参数校验失败",
                     "details": {"errors": _jsonable(exc.errors())}},
        )

    @app.exception_handler(IntegrityError)
    async def _integrity(_: Request, exc: IntegrityError) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content={"code": "conflict", "message": "数据唯一性冲突", "details": {"detail": str(exc.orig)}},
        )

    @app.exception_handler(Exception)
    async def _internal(request: Request, exc: Exception) -> JSONResponse:
        logging.getLogger("testpilot").exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={"code": "internal", "message": "服务内部错误", "details": {}})


class OkOut(BaseModel):
    """通用无害返回（删除/ack）：响应模型必须是具体类，不能是裸 BaseModel。"""

    ok: bool = True


@dataclass
class Page[T]:
    items: list[T] = field(default_factory=list)
    next_cursor: str | None = None
    # total（D47-b）：只有页码分页才填，键集路径一律 None——数全表是 COUNT(*)，
    # 没人付这笔钱就不该为它出现。_dump 见 None 就整个摘掉这个键，所以现有
    # 21 处构造点与 20+ 个列表接口的响应一个字节都没变（契约变更需要评审，这是底线）。
    total: int | None = None


def encode_cursor(key: str) -> str:
    return base64.urlsafe_b64encode(key.encode("utf-8")).decode("ascii")


def decode_cursor(cursor: str) -> str:
    try:
        return base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError) as e:
        raise ApiError("bad_cursor", "游标非法", 400, {"cursor": cursor}) from e


async def paginate(
    session: AsyncSession,
    stmt: Select,
    *,
    cursor_col: Any,
    row_key: Any,
    cursor: str | None,
    size: int = 20,
) -> Page:
    """键集分页：stmt 需按 cursor_col 升序；row_key(row) -> 游标值字符串。"""
    size = max(1, min(int(size or 20), 200))
    if cursor:
        stmt = stmt.where(cursor_col > decode_cursor(cursor))
    stmt = stmt.limit(size + 1)
    res = await session.execute(stmt)
    single = len(stmt.column_descriptions) == 1 and stmt.column_descriptions[0].get("entity") is not None
    rows = list(res.scalars().unique().all()) if single else list(res.all())
    has_more = len(rows) > size
    rows = rows[:size]
    nxt = encode_cursor(str(row_key(rows[-1]))) if has_more and rows else None
    return Page(items=rows, next_cursor=nxt)

def _desc_conds(key_cols: list, vals: list):
    """(a<v) 或 (a=v 且 b<w) 或 (a=v 且 b=w 且 c<…)：倒序复合游标的谓词。"""
    conds = []
    for i in range(len(key_cols)):
        parts = [key_cols[j] == vals[j] for j in range(i)] + [key_cols[i] < vals[i]]
        conds.append(and_(*parts))
    return or_(*conds)


async def paginate_desc(
    session: AsyncSession,
    stmt: Select,
    *,
    key_cols: list,
    row_key: Any,
    decode_key: Any,
    cursor: str | None,
    size: int = 20,
) -> Page:
    """倒序键集分页（时间↓ + id↓ 这类复合游标；表主键为 UUID 时升序无时间含义）。

    stmt 需按 key_cols 全列降序；row_key(row) -> 可 JSON 化列表；decode_key(list) -> 可比值列表。
    游标非法 → bad_cursor 400：不静默返回首页，否则用户以为数据丢了。
    """
    size = max(1, min(int(size or 20), 200))
    if cursor:
        try:
            parts = json.loads(decode_cursor(cursor))
            if not isinstance(parts, list) or len(parts) != len(key_cols):
                raise ValueError("游标长度与排序键不符")
            vals = decode_key(list(parts))
        except ApiError:
            raise
        except (ValueError, TypeError) as e:
            raise ApiError("bad_cursor", "游标非法", 400, {"cursor": cursor}) from e
        stmt = stmt.where(_desc_conds(key_cols, vals))
    stmt = stmt.limit(size + 1)
    res = await session.execute(stmt)
    single = len(stmt.column_descriptions) == 1 and stmt.column_descriptions[0].get("entity") is not None
    rows = list(res.scalars().unique().all()) if single else list(res.all())
    has_more = len(rows) > size
    rows = rows[:size]
    nxt = encode_cursor(json.dumps(row_key(rows[-1]), ensure_ascii=False)) if has_more and rows else None
    return Page(items=rows, next_cursor=nxt)


async def count_of(session: AsyncSession, stmt: Select) -> int:
    """按 stmt 的 WHERE 数总行数（页码分页的 total 来源，D47-b）。

    先摘 ORDER BY / LIMIT / OFFSET 再数：排序在计数子查询里纯属白跑；LIMIT 留着会把
    「全表有多少」数成「这页有几条」——total 给页脚看，数错比不数更糟（页脚说谎）。
    用 select_from(子查询) 而不是 with_only_columns(count())：stmt 带 DISTINCT/GROUP BY
    时换列会悄悄改变计数语义，套一层子查询对任意形状都成立。
    """
    sub = stmt.order_by(None).limit(None).offset(None).subquery()
    res = await session.execute(select(func.count()).select_from(sub))
    return int(res.scalar_one())


async def paginate_page(
    session: AsyncSession,
    stmt: Select,
    *,
    current: int,
    size: int = 20,
) -> Page:
    """页码分页（MS 的 {current, pageSize, total} 口径，D47-b）：LIMIT/OFFSET + 真 total。

    为什么页码要 OFFSET：键集只能往前走——下一批的前提是「已知上一批的末位游标」，
    而「跳到第 5 页」没有这个前提。代价是深页变慢 + 并发插入会让页与页之间重叠/漏行，
    所以两种并存、各按场景选，不是把键集改掉。
    next_cursor 刻意置 None：同时回游标和页码 = 对「我在哪」给两套真相，前端接哪个都会
    在另一套失效时出错。total 在这里必给（页码 UI 的页脚就是它），键集路径维持不数。
    current 越过末页不是错误：items 为空但 total 照实——用户跳到空页，页脚仍要说清库里有多少。
    """
    size = max(1, min(int(size or 20), 200))
    current = max(1, int(current or 1))
    total = await count_of(session, stmt)
    res = await session.execute(stmt.limit(size).offset((current - 1) * size))
    single = len(stmt.column_descriptions) == 1 and stmt.column_descriptions[0].get("entity") is not None
    rows = list(res.scalars().unique().all()) if single else list(res.all())
    return Page(items=rows, next_cursor=None, total=total)
