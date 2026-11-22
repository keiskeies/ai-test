"""模型网关：ModelEvent 流 + OpenAI 兼容实现 + fake:// 回放（测试/演示共用）。"""
from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Protocol

# ModelEvent（dict 判别联合）：
#   {"type":"thinking_delta","text"} | {"type":"text_delta","text"}
#   | {"type":"tool_call","id","name","args"} | {"type":"usage","input_tokens","output_tokens"}
#   | {"type":"done","stop_reason"}
from app.shared.fakeuri import fixture_path as _fixture_path


class ModelGateway(Protocol):
    def stream(self, *, messages: list[dict], tools: list[dict], model: Any,
               thinking: str, api_key: str) -> AsyncIterator[dict]: ...


_TR_RE = re.compile(r"\{\{TR:([^:}]+):([^}]+)\}\}")


def _tool_result_lookup(messages: list[dict]) -> dict[str, Any]:
    """role=tool 消息 → {tool_name: payload}，后出现的覆盖先出现的。"""
    out: dict[str, Any] = {}
    for m in messages:
        if m.get("role") != "tool":
            continue
        try:
            p = json.loads(m.get("content") or "{}")
        except (TypeError, ValueError):
            continue
        if isinstance(p, dict) and p.get("tool_name"):
            out[str(p["tool_name"])] = p
    return out


def _walk(obj: Any, path: str) -> Any:
    for seg in path.split("."):
        if isinstance(obj, list):
            try:
                obj = obj[int(seg)]
            except (IndexError, ValueError):
                # 0 行工具结果按下标 / 段根本不是数字：原来只抛裸 "list index out of range" /
                # "invalid literal..."，而 ERROR 卡片取的是 str(e)，用户看到的就只剩这半句——
                # 复用标量中断路径那句人话。ValueError 而不是 KeyError：卡片直接 str()，
                # KeyError 会给句子套一层引号（build_gateway 的「未知协议」是文件里现成的无引号人话型）。
                raise ValueError("TR 路径不可达: " + path + "（段: " + seg + "）") from None
        elif isinstance(obj, dict):
            try:
                obj = obj[seg]
            except KeyError:
                # 缺键原来只抛 KeyError(段名)：卡片上就剩一串带引号的 'missing_key'，
                # 连是哪条路径没走到都不知道——和上面 list 越界同一种病，同治。
                raise ValueError("TR 路径不可达: " + path + "（段: " + seg + "）") from None
        else:
            raise ValueError("TR 路径不可达: " + path + "（段: " + seg + "）")
    return obj


def _apply_tool_refs(line: str, messages: list[dict]) -> str:
    """{{TR:工具名:点分路径}} → 该工具最近一次结果里的值（路径相对 TOOL_RESULT payload）。

    演示与金线用：模型脚本里 "{{TR:api_definition_create:content.id}}" 链接上一步创建的 id，
    无需预知真实主键。找不到源工具结果 → 抛错（run 落 ERROR，问题立刻可见而不是带占位符继续）。
    """
    if "{{TR:" not in line:
        return line
    idx = _tool_result_lookup(messages)

    def _sub(m: re.Match) -> str:
        src = idx.get(m.group(1))
        if src is None:
            # ValueError 而非 KeyError：卡片 str(e) 会把 KeyError 的句子 repr 成带引号的一串
            raise ValueError("TR 引用了尚无结果的工具: " + m.group(1))
        return str(_walk(src, m.group(2)))

    return _TR_RE.sub(_sub, line)


class FakeGateway:
    """JSONL 逐行回放。script_path 可为 Path，或 fake://<fixture 名>。

    {{PID}} 占位符在回放前替换为会话 project_id（演示/测试脚本无需预知项目 id）。
    """

    def __init__(self, script_path: str | Path, project_id: str | None = None) -> None:
        s = str(script_path)
        if s.startswith("fake://"):
            s = str(_fixture_path(s))
        self._lines = [ln for ln in Path(s).read_text(encoding="utf-8").splitlines() if ln.strip()]
        self._project_id = project_id
        self._pos = 0

    async def stream(self, *, messages: list[dict], tools: list[dict], model: Any,
                     thinking: str, api_key: str) -> AsyncIterator[dict]:
        # 一次性消费：ReAct 循环二次进入返回空流（脚本已播完 → 收敛到 DONE）
        while self._pos < len(self._lines):
            line = self._lines[self._pos]
            self._pos += 1
            if self._project_id:
                line = line.replace("{{PID}}", self._project_id)
            line = _apply_tool_refs(line, messages)
            yield json.loads(line)

class OpenAICompatGateway:
    """openai SDK 流式；tool_calls 增量聚合后一次性产出；thinking 字段缺失则降级跳过。"""

    async def stream(self, *, messages: list[dict], tools: list[dict], model: Any,
                     thinking: str, api_key: str) -> AsyncIterator[dict]:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(base_url=model.base_url, api_key=api_key or "EMPTY")
        kwargs: dict[str, Any] = {
            "model": model.model_name,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
            "max_tokens": model.max_output,
        }
        if tools and model.supports_tools:
            kwargs["tools"] = [{"type": "function", "function": {
                "name": t["name"], "description": t["description"], "parameters": t["parameters"]}} for t in tools]
        if model.supports_thinking and thinking != "off":
            kwargs["extra_body"] = {"thinking": {"type": "enabled"}}
        if model.temperature_default is not None:
            kwargs["temperature"] = float(model.temperature_default)

        acc: dict[int, dict] = {}  # tool_call 增量聚合：index -> {id,name,args_str}
        stop_reason = "stop"
        usage: dict | None = None
        async with await client.chat.completions.create(**kwargs) as stream:
            async for chunk in stream:
                if getattr(chunk, "usage", None):
                    usage = {"type": "usage",
                             "input_tokens": chunk.usage.prompt_tokens,
                             "output_tokens": chunk.usage.completion_tokens}
                if not chunk.choices:
                    continue
                ch = chunk.choices[0]
                # Any：openai SDK 的 delta 既像对象（.content）又可能给 dict，本文件
                # 通篇用 getattr 防御性取值；给个具体类型反而是骗类型检查器。
                delta: Any = ch.delta or {}
                rc = getattr(delta, "reasoning_content", None)
                if rc:
                    yield {"type": "thinking_delta", "text": rc}
                if getattr(delta, "content", None):
                    yield {"type": "text_delta", "text": delta.content}
                for tc in getattr(delta, "tool_calls", None) or []:
                    slot = acc.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function and tc.function.name:
                        slot["name"] += tc.function.name
                    if tc.function and tc.function.arguments:
                        slot["args"] += tc.function.arguments
                if ch.finish_reason:
                    stop_reason = ch.finish_reason
        for idx in sorted(acc):
            slot = acc[idx]
            try:
                args = json.loads(slot["args"] or "{}")
            except json.JSONDecodeError:
                args = {"__invalid_json__": slot["args"]}
            yield {"type": "tool_call", "id": slot["id"] or ("call_" + str(idx)),
                   "name": slot["name"], "args": args}
        if usage:
            yield usage
        yield {"type": "done", "stop_reason": stop_reason}


class AnthropicGateway:
    async def stream(self, **_: Any) -> AsyncIterator[dict]:  # pragma: no cover
        raise NotImplementedError("ANTHROPIC 协议在 1B 实现")


def build_gateway(cfg: Any) -> Any:
    """按 model_config 选网关；base_url=fake://xxx → FakeGateway（演示与测试）。"""
    if (cfg.base_url or "").startswith("fake://"):
        return FakeGateway(cfg.base_url)
    if cfg.protocol == "OPENAI_COMPAT":
        return OpenAICompatGateway()
    if cfg.protocol == "ANTHROPIC":
        return AnthropicGateway()
    raise ValueError("未知协议: " + str(cfg.protocol))
