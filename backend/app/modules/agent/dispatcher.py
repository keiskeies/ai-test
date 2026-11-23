"""工具分发器：Agent 入口的统一执行门（§9.2/§9.3）。

顺序：存在性 → 权限位（与不存在字节一致，不泄露）→ 模式门 → Pydantic 校验 → 执行 → 审计。
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.registry import REGISTRY
from app.core.service import ServiceCtx, _dump
from app.modules.audit import services as audit
from app.modules.mcp import client as mcp_client

TOOL_DENIED = "工具不存在或无权限"

Mode = Literal["PLAN", "ASK", "FULL"]
_MODES: tuple[str, ...] = ("PLAN", "ASK", "FULL")


def norm_mode(value: object) -> Mode:
    """把 DB 里读到的 mode 串收敛回 Literal；认不出一律按 ASK。

    agent_session.mode 是 String(8)，读回来只是 str，直接喂给 call(mode=...) 会让
    类型检查器报「str 不是 Literal」——而**兜底方向**更要紧：认不出按 ASK（要审批）
    而不是 FULL（直通），坏数据落在安全侧。兜底原本就写在 runner 里，这里只是让它
    有了类型。
    """
    return value if isinstance(value, str) and value in _MODES else "ASK"  # type: ignore[return-value]


class ToolResult(BaseModel):
    ok: bool
    content: Any = None
    error: str | None = None
    ui: str | None = None
    produced: list[dict] = []


class NeedApproval(Exception):
    """ASK 模式命中写类工具且未获本会话授权 → runner 落 APPROVAL_REQ 挂起。"""

    def __init__(self, tool_call_id: str, tool_name: str, args: dict) -> None:
        self.tool_call_id = tool_call_id
        self.tool_name = tool_name
        # 属性名不能是 args：BaseException.__init__ 会把自己收到的参数元组写进
        # self.args，下一行的 super().__init__(msg) 就把刚赋的入参字典覆盖成
        # ('awaiting approval for xxx',)。那条消息随后被当 tool_args 落进
        # agent_approval.args 与 APPROVAL_REQ 事件，审批卡上的「将要执行的参数」
        # 显示的是一句话而不是参数——正是审批这个动作最该看清的那一块。
        self.tool_args = args
        super().__init__(f"awaiting approval for {tool_name}")


class ToolDispatcher:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def call(
        self,
        tool_name: str,
        args: dict,
        ctx: ServiceCtx,
        *,
        mode: Literal["PLAN", "ASK", "FULL"],
        grants: set[str],
        tool_call_id: str | None = None,
    ) -> ToolResult:
        # D265：MCP 工具不在 @service 注册表里（工具清单是运行期从各 server 发现的），
        # 命名以 mcp__ 开头；治理位与模式门仍走同一套顺序。
        if tool_name.startswith("mcp__"):
            return await self._call_mcp(tool_name, args, ctx, mode=mode, grants=grants,
                                        tool_call_id=tool_call_id)
        spec = REGISTRY.get(tool_name)
        # D164：dynamic_perm 服务（run_cancel）静态门跳过，鉴权在 handler 内按 run 的域 require
        if spec is None or (not spec.dynamic_perm and not _has_perm(ctx, spec.perm)):
            return await self._audit(ctx, tool_name, args, ToolResult(ok=False, error=TOOL_DENIED))
        # 模式门
        if mode == "PLAN" and spec.effect != "read":
            return await self._audit(ctx, tool_name, args, ToolResult(
                ok=False, error="当前为只读（PLAN）模式，写类工具被拒绝。请改用只读工具完成任务或提示用户切换模式。"))
        if mode == "ASK" and spec.effect in ("write", "destructive") and tool_name not in grants:
            raise NeedApproval(tool_call_id or "-", tool_name, args)
        # 参数校验（失败回注给模型自纠 → Review Focus 3）
        try:
            payload = spec.model.model_validate(args)
        except ValidationError as e:
            errs = "; ".join(" -> ".join(str(x) for x in err["loc"]) + ": " + err["msg"] for err in e.errors()[:8])
            return await self._audit(ctx, tool_name, args, ToolResult(ok=False, error="参数校验失败: " + errs))
        # 执行
        try:
            result = await spec.handler(payload, ctx)
        except Exception as exc:  # noqa: BLE001 —— 工具异常必须回注而非炸掉 run
            return await self._audit(ctx, tool_name, args, ToolResult(ok=False, error=f"{type(exc).__name__}: {exc}"))
        content = _dump(result)  # Page/BaseModel → JSON 原生（与 HTTP 路同形）
        produced: list[dict] = []
        ui = None
        if isinstance(content, dict):
            produced = content.get("produced") or []
            ui = content.get("ui")
        return await self._audit(ctx, tool_name, args, ToolResult(ok=True, content=content, ui=ui, produced=produced))

    async def _call_mcp(self, tool_name: str, args: dict, ctx: ServiceCtx, *,
                        mode: Literal["PLAN", "ASK", "FULL"], grants: set[str],
                        tool_call_id: str | None) -> ToolResult:
        """mcp__<server>__<tool>：不存在与无权限同一句话（不泄露 server 清单）。"""
        if not _has_perm(ctx, mcp_client.TOOL_PERM):
            return await self._audit(ctx, tool_name, args, ToolResult(ok=False, error=TOOL_DENIED))
        ref = await mcp_client.resolve_tool(ctx.db, tool_name)
        if ref is None:
            return await self._audit(ctx, tool_name, args, ToolResult(ok=False, error=TOOL_DENIED))
        cfg, _raw, effect = ref
        if mode == "PLAN" and effect != "read":
            return await self._audit(ctx, tool_name, args, ToolResult(
                ok=False, error="当前为只读（PLAN）模式，写类工具被拒绝。请改用只读工具完成任务或提示用户切换模式。"))
        if mode == "ASK" and effect in ("write", "destructive") and tool_name not in grants:
            raise NeedApproval(tool_call_id or "-", tool_name, args)
        res = await mcp_client.call_exposed(ctx.db, tool_name, args)
        if res.get("ok"):
            content = res.get("content")
            # 与 @service 的工具结果同形：MCP 返回也允许透出 produced/ui（当前协议只给文本/结构化值）
            produced = content.get("produced") or [] if isinstance(content, dict) else []
            ui = content.get("ui") if isinstance(content, dict) else None
            return await self._audit(ctx, tool_name, args,
                                      ToolResult(ok=True, content=content, ui=ui, produced=produced),
                                      target="mcp:" + cfg.name)
        return await self._audit(ctx, tool_name, args,
                                  ToolResult(ok=False, error=str(res.get("error") or "MCP 调用失败")),
                                  target="mcp:" + cfg.name)

    async def _audit(self, ctx: ServiceCtx, tool_name: str, args: dict, res: ToolResult,
                     *, target: str | None = None) -> ToolResult:
        diff: dict[str, Any] | None = None
        if not res.ok:
            diff = {"error": res.error}
        elif res.produced:
            diff = {"produced": res.produced}
        await audit.record(self.db, user_id=ctx.user_id, entry="agent", action=tool_name,
                           target=target if target is not None else str(args.get("project_id") or ""),
                           ok=res.ok, diff=diff)
        await self.db.commit()
        return res


def _has_perm(ctx: ServiceCtx, perm: str) -> bool:
    from app.core.permissions import match_perm

    return match_perm(ctx.perms, perm)
