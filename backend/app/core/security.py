"""安全底座：bcrypt 口令、JWT、Fernet 密钥加密（无任何模块层依赖）。"""
from __future__ import annotations

import base64
import hashlib
import uuid

import bcrypt
import jwt
from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings
from app.core.errors import ApiError


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("ascii"))
    except ValueError:
        return False


def create_access_token(user_id: str) -> str:
    s = get_settings()
    import datetime as dt

    now = dt.datetime.now(dt.UTC)
    payload = {
        "sub": str(user_id),
        "typ": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + dt.timedelta(hours=s.jwt_ttl_hours)).timestamp()),
    }
    return jwt.encode(payload, s.secret_key, algorithm="HS256")


def create_refresh_token(user_id: str) -> str:
    """刷新令牌：独立签名 JWT，`typ=refresh` 把它与 access 硬性区分——
    两侧 decode 都验 typ，access 永远过不了刷新端点，refresh 永远过不了 Bearer 认证。

    # 无状态设计的明说限制（裁决记录，勿再翻案）：刷新令牌不落库、无 jti 拒绝名单，
    # 因此**签发后到过期前无法撤销**。logout 只是清浏览器 Cookie，拿到过这枚令牌的人
    # （如 XSS 读不到 HttpOnly Cookie，但日志/中间人泄露的场景存在）在 7 天内仍可换 access。
    # 这是刻意与蓝图 §3.4 文案对齐的范围裁决：加拒绝名单表超出蓝图，属 scope creep。
    """
    s = get_settings()
    import datetime as dt

    now = dt.datetime.now(dt.UTC)
    payload = {
        "sub": str(user_id),
        "typ": "refresh",
        "iat": int(now.timestamp()),
        "exp": int((now + dt.timedelta(days=s.refresh_ttl_days)).timestamp()),
    }
    return jwt.encode(payload, s.secret_key, algorithm="HS256")


def _decode_token(token: str, expected_typ: str) -> uuid.UUID:
    s = get_settings()
    try:
        payload = jwt.decode(token, s.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError as e:
        raise ApiError("unauthorized", "登录状态无效或已过期", 401) from e
    # typ 缺失按 access 处理（兼容无状态升级前签发的旧 access 令牌）；typ 不符一律 401。
    if payload.get("typ", "access") != expected_typ:
        raise ApiError("unauthorized", "登录状态无效或已过期", 401)
    try:
        return uuid.UUID(payload["sub"])
    except (KeyError, ValueError, TypeError) as e:
        raise ApiError("unauthorized", "登录状态无效或已过期", 401) from e


def decode_access_token(token: str) -> uuid.UUID:
    return _decode_token(token, "access")


def decode_refresh_token(token: str) -> uuid.UUID:
    return _decode_token(token, "refresh")


def _fernet() -> Fernet:
    s = get_settings()
    if s.fernet_key:
        return Fernet(s.fernet_key.encode("ascii"))
    # 开发便捷：由 secret_key 派生稳定密钥（生产请显式注入 TP_FERNET_KEY）
    digest = hashlib.sha256(s.secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def enc_key(plain: str) -> str:
    return _fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def dec_key(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as e:
        raise ApiError("internal", "密钥解密失败（主密钥是否变更？）", 500) from e


def mask_key(plain: str) -> str:
    """回显打码：仅露末 4 位。"""
    if not plain:
        return ""
    return "****" + plain[-4:] if len(plain) > 4 else "****"
