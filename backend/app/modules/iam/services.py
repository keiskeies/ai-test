"""IAM service 函数（S0：登录、用户查询）。"""
from __future__ import annotations

from sqlalchemy import select

from app.core.db import AsyncSession
from app.core.errors import ApiError
from app.core.security import create_access_token, verify_password
from app.modules.iam import schemas
from app.modules.iam.models import User


async def login(db: AsyncSession, payload: schemas.LoginIn) -> schemas.LoginOut:
    user = (await db.execute(select(User).where(User.account == payload.account))).scalar_one_or_none()
    # 账号不存在与口令错误同码同文案（不泄露存在性）
    if user is None or user.status != "active" or not verify_password(payload.password, user.password_hash):
        raise ApiError("bad_credentials", "账号或密码错误", 401)
    return schemas.LoginOut(token=create_access_token(user.id), user=schemas.UserOut.model_validate(user))


async def get_user(db: AsyncSession, user_id: str) -> User:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise ApiError("not_found", "用户不存在", 404)
    return user
