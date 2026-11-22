"""ExecutionContext：一次场景执行的变量、日志与渲染入口（§7.5 §8.3）。

设计约束（都是会咬人的坑）：
- base_vars 传进来先拷一份：runner 逐步写 vars，绝不能回头污染调用方的字典
  （环境快照、数据集行都握在调用方手里）。
- 变量值一律 str：§7.5 的分层合并就是字符串层，${port} 渲染进 path/query 也必须是 str，
  否则同一变量在断言里是 8080、在 URL 里是 "8080"，会出现难查的比较失败。
- render 对 str 走 render、对其余走 render_deep：handler 要渲染的是整个请求对象
  （headers/query/body），逐字段渲染会把调用方逼成模板字符串工人。
- vars_snapshot 是深拷贝：它是 §8.3 单步重跑的重建依据，落库后还要 JSON 序列化，
  与实时 vars 共享引用的话，后续步骤会改掉已落库的快照。
"""
from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

from app.shared.vars import MissingVar, render, render_deep

DEFAULT_TIMEOUT_MS = 10_000
# actor 里只搬这几样：ServiceCtx 需要的最小身份集合。多余的键（比如顺手传进来的
# db 或 session）搬进快照只会让人误以为它们也是快照语义。
ACTOR_KEYS = ("user_id", "user_name", "is_system_admin", "perms", "entry")


def _copy_actor(actor: Mapping | None) -> dict[str, Any] | None:
    """把发起人身份拷成脱离副本：一次执行的权限在一次运行内保持一致。

    执行可能跑几十分钟，期间发起人被降权、退出登录都是常态。刻意不回查数据库：
    否则跑到一半会突然从 pass 变成 insufficient_permission，报告无法解释自己。
    """
    if actor is None:
        return None
    out: dict[str, Any] = {}
    for k in ACTOR_KEYS:
        v = actor.get(k)
        if k == "perms":
            # perms 要交给 ServiceCtx.require 读，必须是 set；tuple/list 也接受
            out[k] = set(v) if isinstance(v, (list, tuple, set, frozenset)) else set()
        elif k == "user_id":
            out[k] = str(v) if v is not None else ""
        elif k == "user_name":
            out[k] = str(v or "")
        elif k == "is_system_admin":
            out[k] = bool(v)
        else:
            # 兜底字面量必须是词表成员（http/agent/schedule）。这里原先写的是 "web"——
            # 一个从来不在词表里的词，唯一读它的地方是 ServiceCtx 构造时的 normalize_entry，
            # 而它把词表外的一切一律折算成 http，所以 "web" 活着只等于「多一个同义词等着
            # 下一个人误当分支条件」。快照本身不查库（见本函数 docstring），但**写进快照的
            # 默认值**该由写的一方负责说清楚，不该留给读的一方猜。
            out[k] = str(v) if v is not None else "http"
    return out


class ExecutionContext:
    """一次执行的上下文。db/bus 供 handler 取数与发事件，本类只管变量、日志与渲染。"""

    def __init__(
        self,
        db: Any,
        bus: Any,
        run_id: str,
        project_id: str,
        base_vars: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        actor: Mapping | None = None,
        transport: Any = None,
    ) -> None:
        self.db = db
        self.bus = bus
        self.run_id = run_id
        self.project_id = project_id
        self.vars: dict[str, str] = {str(k): str(v) for k, v in (base_vars or {}).items()}
        self.headers: dict[str, str] = dict(headers or {})
        self.timeout_ms = int(timeout_ms)
        self.last_response: dict[str, Any] | None = None
        # T20b 公共断言（R88 语义：作用于**每一个真正发出请求的步骤**，不是收尾判一次）。
        # 挂在 ctx 上而不是当参数层层往下传：handler 的签名是 T7 钉死的契约
        # （node, ctx, *, run_children, in_loop, run_lists），为一个场景级配置改所有
        # handler 签名不划算；而且「这一次运行的公共门」本来就是运行期上下文的一部分。
        self.common_assertions: list[dict] = []
        self._logs: dict[str, list[str]] = {}
        # 发起人身份快照（T7 勘误③）：api_case 步骤要经 api_case_resolve，
        # 那个服务有 ensure_project_access + ctx.require，没有身份就寸步难行。
        # None 表示系统触发（定时/webhook）：没有发起人可用，与「有身份但没权限」
        # 是两回事，报错文案必须能区分这两种情况。
        self.actor = _copy_actor(actor)
        # 传输注入：None = 真实网络；测试传 httpx.ASGITransport(app=...) 内存靶。
        # 每次执行各带一份，不用 api_debug 那种模块级全局钩子（并发会互踩）。
        self.transport = transport

    def render(self, tpl: Any) -> Any:
        """渲染模板；缺变量抛 MissingVar（消息点名是哪个变量，Review Focus 8）。"""
        if isinstance(tpl, str):
            return render(tpl, self.vars)
        return render_deep(tpl, self.vars)

    def log(self, step_key: str, msg: str) -> None:
        """按步骤归集的日志，随 detail 一起落库；报告页与调试抽屉都读它。"""
        self._logs.setdefault(step_key, []).append(str(msg))

    def logs_for(self, step_key: str) -> list[str]:
        return list(self._logs.get(step_key, []))

    def vars_snapshot(self) -> dict[str, str]:
        """落库用的脱离副本（§8.3 单步重跑据此重建上下文）。"""
        return copy.deepcopy(self.vars)


__all__ = ["ACTOR_KEYS", "DEFAULT_TIMEOUT_MS", "ExecutionContext", "MissingVar"]
