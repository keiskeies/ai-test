"""IAM FastAPI 依赖：当前用户解析（Review Focus 1 钉此处）。"""
from __future__ import annotations

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.errors import ApiError
from app.core.security import decode_access_token
from app.modules.iam.models import User

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if creds is None or not creds.credentials:
        raise ApiError("unauthorized", "未认证", 401)
    token = creds.credentials
    # D198：自助 API Key（tp_ 前缀）与 JWT 同一 Bearer 头；明文只存哈希。
    if token.startswith("tp_"):
        from app.modules.iam.personal_services import resolve_api_key

        user = await resolve_api_key(db, token)
        if user is None:
            raise ApiError("unauthorized", "API Key 无效、已吊销或已过期", 401)
        request.state.user_id = user.id
        return user
    try:
        user_id = decode_access_token(token)
    except ApiError:
        raise
    except Exception:
        raise ApiError("unauthorized", "凭证无效或已过期", 401) from None
    user = (await db.execute(select(User).where(User.id == str(user_id)))).scalar_one_or_none()
    if user is None or user.status != "active":
        raise ApiError("unauthorized", "账号不可用", 401)
    request.state.user_id = user.id
    return user


def client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None
