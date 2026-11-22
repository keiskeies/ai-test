"""请求认证合并（§7.1 auth 子集）：auth → httpx kwargs 的纯函数归一处。

放 shared/ 而不是内联进执行核：§11.4.4 里请求编辑器被 调试/用例/定义/HTTP直连
共用，认证口径同理只允许存在这一份实现。

诚实原则：auth 配错一律抛 RequestAuthError，绝不静默丢弃——
「看着带了认证其实裸奔」比当场报错危险得多。
"""
from __future__ import annotations

from collections.abc import Generator
from typing import Any

import httpx

SUPPORTED_AUTH_TYPES = ("none", "basic", "bearer")


class RequestAuthError(ValueError):
    """auth 配置非法/不受支持；由调用方决定转 422 还是标步骤 error。"""


class _BearerAuth(httpx.Auth):
    """httpx 不带内置 Bearer：置单值 Authorization 头（键已存在则整体替换，
    不会出现 '手动头, Bearer tk' 这种谁也没写过的拼接头）。"""

    def __init__(self, token: str) -> None:
        self._token = token

    def auth_flow(self, request: httpx.Request) -> Generator[httpx.Request, httpx.Response, None]:
        request.headers["Authorization"] = "Bearer " + self._token
        yield request


def _require_str(config: dict, key: str, auth_type: str) -> str:
    v = config.get(key)
    if not isinstance(v, str) or not v.strip():
        raise RequestAuthError(
            "auth.type=" + auth_type + " 缺 " + key + "（必须是非空字符串），收到：" + repr(v))
    return v


def build_auth_kwargs(value: Any) -> dict[str, httpx.Auth]:
    """§7.1 auth 值 → 待并入 httpx 请求的 kwargs；空值按 none，其余非法即抛。"""
    if value is None or value == {} or value == "":
        return {}
    if not isinstance(value, dict):
        raise RequestAuthError("auth 必须是对象，收到：" + repr(value))
    auth_type = value.get("type")
    if auth_type is None:
        # 缺 type 但带了 config（如 {"config": {"token": ...}}）：按 none 处理会静默吞掉
        # 整份认证配置——与 apikey 静默丢弃同性质，必须点名拒
        if value.get("config"):
            raise RequestAuthError("auth 缺 type 字段，但带了 config，收到：" + repr(value))
        return {}
    if auth_type == "none":
        return {}
    if auth_type not in SUPPORTED_AUTH_TYPES:
        # apikey 等未实现类型走显式拒绝而不是静默忽略（§14 诚实纪律）
        raise RequestAuthError(
            "auth.type 不支持：" + repr(auth_type)
            + "，一期仅支持 " + "/".join(SUPPORTED_AUTH_TYPES))
    config = value.get("config") or {}
    if not isinstance(config, dict):
        raise RequestAuthError("auth.config 必须是对象，收到：" + repr(config))
    if auth_type == "basic":
        return {"auth": httpx.BasicAuth(_require_str(config, "username", "basic"),
                                        _require_str(config, "password", "basic"))}
    return {"auth": _BearerAuth(_require_str(config, "token", "bearer"))}
