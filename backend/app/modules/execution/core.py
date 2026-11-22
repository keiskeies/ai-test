"""API 执行核（§8.1 api_case handler 的 1A 前身）：纯引擎无 DB，网络异常归一不抛。"""
from __future__ import annotations

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl

import httpx

from app.shared.assertions import ResponseView, evaluate
from app.shared.request_auth import build_auth_kwargs
from app.shared.vars import render_deep

MAX_BODY_CHARS = 1_000_000  # Review Focus 2：超量截断 + truncated 标记
_TEXT_HINTS = ("json", "text", "xml", "html", "urlencoded", "javascript")


@dataclass
class RunResult:
    ok: bool                      # 网络层成功（发出去且收到响应）
    status: int | None
    headers: dict[str, str]
    body_text: str | None
    truncated: bool
    body_size: int
    elapsed_ms: int
    error: str | None
    assertions: list[dict] = field(default_factory=list)

    def passed(self) -> bool:
        return self.ok and all(a["passed"] for a in self.assertions)


def _is_text(content_type: str) -> bool:
    ct = (content_type or "").lower()
    return any(h in ct for h in _TEXT_HINTS)


def _is_pairs(x: Any) -> bool:
    """form body 的 pairs 列表形状：[[k, v], ...]（空列表也算，dict([]) = {}）。"""
    return isinstance(x, list) and all(isinstance(p, (list, tuple)) and len(p) == 2 for p in x)


def _build_kwargs(req: dict) -> dict:
    """渲染后的 request dict → httpx 请求参数（§7.1 body 类型子集）。"""
    kw: dict[str, Any] = {}
    pairs = req.get("params") or []
    if pairs:
        kw["params"] = [(k, v) for k, v in pairs]
    hdrs = req.get("headers") or []
    if hdrs:
        kw["headers"] = [(k, v) for k, v in hdrs]
    body = req.get("body") or {"type": "none"}
    bt = body.get("type") or "none"
    content = body.get("content")
    if bt == "json":
        kw["content"] = (content if isinstance(content, str) else json.dumps(content)).encode("utf-8")
        kw.setdefault("headers", []).append(("Content-Type", "application/json"))
    elif bt in ("text", "raw"):
        kw["content"] = str(content or "").encode("utf-8")
    elif bt == "form":
        # content=JSON 串的对象或 pairs 列表；也认导入器真实产出的 k=v&k=v 串（D172）：
        # JSON 失败或解析结果不是 Mapping/pairs → parse_qsl 退回；退回后仍无 pair 且非空白
        # → 抛人话（D157 纪律：宁抛不装绿），绝不静默 {} 把请求体清空。multipart 1A 不做。
        data: Any
        if isinstance(content, str):
            data = None
            if content.strip():
                try:
                    data = json.loads(content)
                except (ValueError, TypeError):
                    data = None
                if not isinstance(data, Mapping) and not _is_pairs(data):
                    data = dict(parse_qsl(content, keep_blank_values=True))
                    if not data:
                        raise ValueError("form body 无法解析（既不是 JSON 也不是 k=v&k=v）: " + content[:80])
            else:
                data = {}  # 空串/纯空白 → 空 data 合法
        else:
            data = content or {}  # dict/list/None 照旧
        if isinstance(data, Mapping):
            kw["data"] = dict(data)
        else:
            kw["data"] = dict((k, v) for k, v in data)
    kw.update(build_auth_kwargs(req.get("auth")))  # 认证口径唯一归一处；非法值抛 RequestAuthError 不静默丢
    kw["timeout"] = float(req.get("timeout_ms") or 10000) / 1000.0
    return kw


async def run_api(request: dict, *, variables: dict[str, str] | None = None,
                  transport: httpx.AsyncBaseTransport | None = None) -> RunResult:
    """渲染 ${var}（未定义向上抛 MissingVar，由入口转 422）→ 发送 → 断言。网络异常 → ok=False 不抛。"""
    req = render_deep(request, variables or {})
    kw = _build_kwargs(req)
    try:
        async with httpx.AsyncClient(transport=transport, follow_redirects=False, trust_env=False) as client:
            t0 = time.perf_counter()
            resp = await client.request(req.get("method") or "GET", req.get("url") or "", **kw)
            elapsed = int((time.perf_counter() - t0) * 1000)
    except Exception as e:  # noqa: BLE001 执行核必须吸收一切网络异常
        return RunResult(False, None, {}, None, False, 0, 0, type(e).__name__ + ": " + str(e)[:180])
    headers = {k.lower(): v for k, v in resp.headers.items()}
    raw = resp.content
    if _is_text(headers.get("content-type", "")):
        text = raw.decode("utf-8", errors="replace")
        truncated = len(text) > MAX_BODY_CHARS
        if truncated:
            text = text[:MAX_BODY_CHARS]
    else:
        text, truncated = None, False
    view = ResponseView(status=resp.status_code, headers=headers, body_text=text, elapsed_ms=elapsed)
    results = evaluate(req.get("assertions") or [], view, variables=variables or {})
    return RunResult(True, resp.status_code, headers, text, truncated, len(raw), elapsed, None, results)