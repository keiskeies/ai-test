"""§7.1 auth 子集（1A 欠账补齐）：request_auth 纯函数 + 执行核线上行为 + 写路径 schema。

诚实纪律钉两处：①apikey/未知类型必须是点名报错，不许静默裸奔（「撒谎的绿」）；
②auth 真的挂上线（ASGITransport 内存靶回读 Authorization 头），不是只在 kwargs 里自嗨。
"""
import base64
import json

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from pydantic import ValidationError

from app.modules.api_test.schemas import RequestObject
from app.modules.execution.core import _build_kwargs, run_api
from app.shared.request_auth import RequestAuthError, build_auth_kwargs

B64_UP = base64.b64encode(b"u:p").decode()


# —— 纯函数层：none/basic/bearer/malformed/unsupported ——————————————

def test_none_and_empty_produce_no_kwargs():
    assert build_auth_kwargs(None) == {}
    assert build_auth_kwargs({}) == {}
    assert build_auth_kwargs({"type": "none"}) == {}
    assert build_auth_kwargs({"type": "none", "config": {"token": "t"}}) == {}


def test_basic_yields_httpx_basicauth_with_credentials():
    import httpx

    kw = build_auth_kwargs({"type": "basic", "config": {"username": "u", "password": "p"}})
    assert isinstance(kw["auth"], httpx.BasicAuth)


def test_bearer_yields_httpx_auth():
    import httpx

    kw = build_auth_kwargs({"type": "bearer", "config": {"token": "tk"}})
    assert isinstance(kw["auth"], httpx.Auth)


def test_unsupported_type_names_the_value():
    # apikey 在 §7.1 有、一期没实现：必须是点名拒绝，不是悄悄不发认证头
    with pytest.raises(RequestAuthError) as ei:
        build_auth_kwargs({"type": "apikey", "config": {"key": "x"}})
    assert "apikey" in str(ei.value)
    assert "none/basic/bearer" in str(ei.value)
    with pytest.raises(RequestAuthError) as ei:
        build_auth_kwargs({"type": "digest", "config": {}})
    assert "digest" in str(ei.value)


@pytest.mark.parametrize("bad", [
    "Bearer tk",                       # 字符串不是对象
    ["basic"],                          # 列表不是对象
    {"config": {"token": "t"}},         # 缺 type 字段按 none 处理？——否：无 type 视为 none 会静默丢 token
    {"type": "basic"},                  # basic 缺 config
    {"type": "basic", "config": {}},     # basic 缺 username/password
    {"type": "basic", "config": {"username": "u"}},  # 缺 password
    {"type": "basic", "config": {"username": "", "password": "p"}},  # 空串
    {"type": "bearer"},                 # bearer 缺 token
    {"type": "bearer", "config": {"token": "   "}},  # 纯空白 token
    {"type": "bearer", "config": "tk"},  # config 不是对象
])
def test_malformed_auth_raises(bad):
    with pytest.raises(RequestAuthError):
        build_auth_kwargs(bad)


def test_missing_type_with_config_is_not_silently_none():
    # {"config": {...}} 没有 type：若按 none 处理，token 就被静默吞掉——同 apikey 一个性质
    with pytest.raises(RequestAuthError):
        build_auth_kwargs({"type": None, "config": {"token": "t"}})


# —— _build_kwargs 接线层：auth 真的进了 httpx kwargs ——————————————————

def test_build_kwargs_none_auth_adds_nothing():
    kw = _build_kwargs({"method": "GET", "url": "http://x/"})
    assert "auth" not in kw
    assert _build_kwargs({"auth": {"type": "none"}}).get("auth") is None


def test_build_kwargs_basic_sets_auth_kwarg():
    import httpx

    kw = _build_kwargs({"auth": {"type": "basic", "config": {"username": "u", "password": "p"}}})
    assert isinstance(kw["auth"], httpx.BasicAuth)


def test_build_kwargs_apikey_raises_not_drops():
    with pytest.raises(RequestAuthError):
        _build_kwargs({"auth": {"type": "apikey", "config": {"key": "x", "value": "v"}}})


# —— 线上层：ASGITransport 内存靶回读真实收到的头 ————————————————

_app = FastAPI()


@_app.get("/whoami")
async def whoami(request: Request):
    return JSONResponse({"auth": request.headers.get("authorization")})


TR = ASGITransport(app=_app)


async def test_basic_header_reaches_the_wire():
    r = await run_api({"method": "GET", "url": "http://t/whoami",
                       "auth": {"type": "basic", "config": {"username": "u", "password": "p"}}},
                      transport=TR)
    assert r.ok and r.status == 200
    assert json.loads(r.body_text)["auth"] == "Basic " + B64_UP


async def test_bearer_header_reaches_the_wire():
    r = await run_api({"method": "GET", "url": "http://t/whoami",
                       "auth": {"type": "bearer", "config": {"token": "tk"}}},
                      transport=TR)
    assert json.loads(r.body_text)["auth"] == "Bearer tk"


async def test_bearer_auth_beats_stale_manual_header():
    # 用户先手敲过 Authorization 再切 Auth 页签：库里可能两个都留着，
    # 生效的必须是 Auth 配置的那个，且不能出现 "Bearer old, Bearer tk" 拼接头
    r = await run_api({"method": "GET", "url": "http://t/whoami",
                       "headers": [["Authorization", "Bearer old"]],
                       "auth": {"type": "bearer", "config": {"token": "tk"}}},
                      transport=TR)
    assert json.loads(r.body_text)["auth"] == "Bearer tk"


async def test_apikey_run_raises_named_error():
    # 执行入口的诚实性：run_api 对存量 apikey 请求当场抛点名错误（引擎/调试层负责转文案）
    with pytest.raises(RequestAuthError, match="apikey"):
        await run_api({"method": "GET", "url": "http://t/whoami",
                       "auth": {"type": "apikey", "config": {"key": "X-Key", "value": "v"}}},
                      transport=TR)


# —— 写路径 schema：结构合法的形状能存，结构错误 422 在门口 ————————

def test_schema_accepts_auth_shapes_and_drops_none():
    r = RequestObject(method="GET", url="/x", auth={"type": "bearer", "config": {"token": "t"}})
    assert r.auth is not None and r.auth.type == "bearer"
    # 键必须能存进 JSON 列（api_debug 的 model_dump(exclude_none=True) 靠它存活）
    assert r.model_dump(exclude_none=True)["auth"] == {"type": "bearer", "config": {"token": "t"}}
    assert "auth" not in RequestObject(method="GET", url="/x").model_dump(exclude_none=True)


def test_schema_rejects_apikey_at_write_time():
    # 写入层收紧成 none/basic/bearer：apikey 存不进来，422 当场可见；
    # 存量/自由 JSON 通道（http_direct）带进来的 apikey 由执行层点名拒绝（上方专测）。
    with pytest.raises(ValidationError, match="apikey"):
        RequestObject(method="GET", url="/x", auth={"type": "apikey", "config": {}})


@pytest.mark.parametrize("bad", [
    "Bearer tk",                                   # auth 不是对象
    {"config": {"token": "t"}},                     # 缺 type
    {"type": ""},                                   # 空 type
    {"type": "basic", "config": ["u", "p"]},        # config 不是对象
])
def test_schema_rejects_malformed_auth(bad):
    with pytest.raises(ValidationError):
        RequestObject(method="GET", url="/x", auth=bad)
