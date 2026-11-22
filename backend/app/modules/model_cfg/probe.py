"""1E T8 逐能力探测（§6.8）：请求构造 + 判定表全在纯函数，I/O 只有一个 run_probe。

三能力判定表（假网关表驱动 tests/test_model_cfg_probe.py 逐格钉死）：
- tools：带 tools[] + 强制 tool_choice 的最小 chat。2xx 带回 tool_calls → 支持；
  2xx 没带回（tools 字段被网关吞掉）或 4xx 点名 tool → 不支持；其余（5xx/坏
  JSON/超时/连接失败）→ 含糊。
- thinking：带思考档参数（与 agent/gateway 的 extra_body 同款 thinking 对象）。
  2xx 且响应有 reasoning_content → 支持；2xx 没有思考块 → 不支持；其余含糊。
- vision：content 里塞 1px PNG base64，看拒否。2xx 正常完成 → 支持；
  4xx 点名 image/vision → 不支持；其余含糊。

含糊用 None（三态）表达：探测不许把「没测出来」写成「不支持」——假阴性比缺值更
害人。存储位保持原值、probe_result 标 unknown 是调用方（services/seed 回填）的
责任，probe.py 只如实汇报三态。
EMBEDDING：embed("ping") 一条短文本，回填向量长度（§6.8 embed_dimensions 兑现点）。
R143：httpx 一律 trust_env=False + 5s 超时——宿主代理环境变量会劫持回环请求。
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

CAPS = ("tools", "thinking", "vision")

# 1x1 透明 PNG：vision 探测载荷。base64 常量本身就是形状的一部分，别抽成运行时生成。
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


@dataclass
class ProbeTarget:
    """探测目标：由 ModelConfig 折算的纯数据（probe.py 不 import ORM）。"""

    base_url: str
    api_key: str
    model_name: str
    model_type: str = "CHAT"


@dataclass
class ProbeOutcome:
    """一次探测的结果。caps 是三态表：True/False/None(=unknown)；连接失败全 None。"""

    ok: bool
    latency_ms: int
    caps: dict[str, bool | None] = field(default_factory=dict)
    dimensions: int | None = None
    error: str | None = None


# ── 纯判定函数（表驱动的判定表本体；假网关逐格喂响应） ──


def parse_body(raw: bytes) -> Any | None:
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _mentions(body: Any, words: tuple[str, ...]) -> bool:
    low = json.dumps(body, ensure_ascii=False).lower() if isinstance(body, (dict, list)) else str(body).lower()
    return any(w in low for w in words)


def _message(body: Any) -> dict | None:
    """chat 响应 → choices[0].message（非 chat 形状 = None，判定方据此报含糊）。"""
    if not isinstance(body, dict):
        return None
    try:
        ch = body["choices"][0]
        msg = ch.get("message") or ch.get("delta")
    except (KeyError, IndexError, TypeError, AttributeError):
        return None
    return msg if isinstance(msg, dict) else None


def judge_tools(status: int, body: Any) -> bool | None:
    if 200 <= status < 300:
        msg = _message(body)
        if msg is None:
            return None  # 2xx 但不是可判定的 chat 形状 → 含糊，不猜
        return bool(msg.get("tool_calls"))
    if 400 <= status < 500 and _mentions(body, ("tool",)):
        return False
    return None


def judge_thinking(status: int, body: Any) -> bool | None:
    if 200 <= status < 300:
        msg = _message(body)
        if msg is None:
            return None
        return bool(msg.get("reasoning_content") or msg.get("reasoning"))
    if 400 <= status < 500 and _mentions(body, ("thinking", "reason")):
        return False
    return None


def judge_vision(status: int, body: Any) -> bool | None:
    if 200 <= status < 300:
        return True if _message(body) is not None else None
    if 400 <= status < 500 and _mentions(body, ("image", "vision")):
        return False
    return None


def judge_dimensions(status: int, body: Any) -> int | None:
    """embeddings 响应 → 向量长度；形状不对/非 2xx 一律 None（不许猜维度）。"""
    if not 200 <= status < 300 or not isinstance(body, dict):
        return None
    try:
        emb = body["data"][0]["embedding"]
    except (KeyError, IndexError, TypeError):
        return None
    return len(emb) if isinstance(emb, list) else None


_JUDGES = {"tools": judge_tools, "thinking": judge_thinking, "vision": judge_vision}


# ── 纯请求构造（探测的形状 = 请求体；假网关按这些标记分发） ──


def chat_body(t: ProbeTarget, *, tools: bool = False, thinking: bool = False,
              vision: bool = False) -> dict:
    if vision:
        content: Any = [
            {"type": "text", "text": "ping"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + TINY_PNG_B64}},
        ]
    else:
        content = "ping"
    body: dict = {"model": t.model_name, "messages": [{"role": "user", "content": content}],
                  "max_tokens": 8}
    if tools:
        # 强制 tool_choice：2xx 仍不返回 tool_calls 才是「tools 被吞」，
        # 不带强制就无法区分「不支持 tools」与「模型选择不调工具」。
        body["tools"] = [{"type": "function", "function": {
            "name": "__tp_probe__", "description": "capability probe",
            "parameters": {"type": "object", "properties": {}}}}]
        body["tool_choice"] = {"type": "function", "function": {"name": "__tp_probe__"}}
    if thinking:
        body["thinking"] = {"type": "enabled"}  # 与 agent/gateway 的 extra_body 同款
    return body


def embeddings_body(t: ProbeTarget) -> dict:
    return {"model": t.model_name, "input": "ping"}


# ── 三态合并（含糊不许把存储位写成不支持） ──


def stored_caps(probe_result: dict | None) -> dict[str, bool | None]:
    """存量 probe_result.capabilities → 三态表（缺键/非布尔 = None）。"""
    tri = (probe_result or {}).get("capabilities")
    if not isinstance(tri, dict):
        return {k: None for k in CAPS}
    return {k: (tri[k] if isinstance(tri.get(k), bool) else None) for k in CAPS}


def merge_caps(old: dict[str, Any], new: dict[str, Any], *, only_missing: bool) -> dict[str, bool | None]:
    """逐能力合并三态表。
    - 新值 None（含糊）→ 沿用 old（存储位不改，unknown 由调用方写进 probe_result）；
    - only_missing（首启回填）：old 已有确定值 = 人工/已测值，新值不许覆盖；
    - 其余情形新值（True/False）胜出。
    """
    out: dict[str, bool | None] = {}
    for k in CAPS:
        nv = new.get(k) if isinstance(new.get(k), bool) else None
        ov = old.get(k) if isinstance(old.get(k), bool) else None
        if ov is not None and only_missing:
            out[k] = ov
        elif nv is not None:
            out[k] = nv
        else:
            out[k] = ov
    return out


# ── 唯一的 I/O 出口 ──


def _headers(t: ProbeTarget) -> dict[str, str]:
    return {"Authorization": "Bearer " + (t.api_key or "EMPTY")}


async def _post(client: httpx.AsyncClient, url: str, t: ProbeTarget,
                body: dict) -> tuple[int, Any | None]:
    """POST 吸收一切网络异常 → (0, None)，判定函数对 0 状态报含糊。探测不许抛。"""
    try:
        r = await client.post(url, json=body, headers=_headers(t))
    except Exception:  # noqa: BLE001  含超时：超时=没测出来，不是不支持
        return 0, None
    return r.status_code, parse_body(r.content)


async def run_probe(t: ProbeTarget) -> ProbeOutcome:
    """一次真探：GET /models 定连通与延迟；CHAT 逐能力 POST；EMBEDDING 测维度。

    不可达 → ok=False 且全能力 None（调用方不许把连接失败落成一堆 ✗）。
    """
    base = t.base_url.rstrip("/")
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
            try:
                r = await client.get(base + "/models", headers=_headers(t))
                ok = r.status_code < 400
                err = None if ok else "HTTP " + str(r.status_code)
            except Exception as e:  # noqa: BLE001
                ok, err = False, type(e).__name__ + ": " + str(e)[:120]
            latency = int((time.perf_counter() - t0) * 1000)
            if not ok:
                return ProbeOutcome(False, latency,
                                    {k: None for k in CAPS} if t.model_type == "CHAT" else {},
                                    None, err)
            if t.model_type == "EMBEDDING":
                s, b = await _post(client, base + "/embeddings", t, embeddings_body(t))
                return ProbeOutcome(True, latency, {}, judge_dimensions(s, b), None)
            caps: dict[str, bool | None] = {}
            for kind in CAPS:
                s, b = await _post(client, base + "/chat/completions", t, chat_body(t, **{kind: True}))
                caps[kind] = _JUDGES[kind](s, b)
            return ProbeOutcome(True, latency, caps, None, None)
    except Exception as e:  # noqa: BLE001  client 构造层兜底：探测永不炸调用方
        return ProbeOutcome(False, int((time.perf_counter() - t0) * 1000),
                            {k: None for k in CAPS}, None, type(e).__name__)
