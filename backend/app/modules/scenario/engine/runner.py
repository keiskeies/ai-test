"""顺序解释执行 + 数据集行展开（§8.6 + §8.2 + Review Focus 2/8/10）。

分工按 handlers.py 模块 docstring 的原文：handler 只管「每种 kind 做什么」，
本模块管「按顺序取节点、落库、发事件、展开数据集行」。run_children 的兄弟循环
语义（取消边界 / fail_fast / optional / break|continue 消化 / BranchResult 聚合）
与 handlers.make_runner 逐条对齐——那里没有可注入的持久化接缝（它直接调模块级
dispatch），计划勘误⑤ 因此写明「T8 的 runner 实现同一契约」：容器递归用的
run_children 就是我们这份（dispatch 把它交回容器），所以一棵树只有一层兄弟循环，
不存在第二套语义。跨模块取数只走 REGISTRY（契约 4），本文件不 import 领域模块。

runner 这层独有的三件事，handlers 里都不该有：
① 两层状态词的唯一映射点：步骤层 pass/fail/error/skip/cancelled → run 层
   passed/failed/error/cancelled。optional 节点的 fail/error 不参与 run 判定
   （「这步挂了不影响后面」是画布上的真实承诺，run 色必须兑现它）。
② 数据集行展开（§8.6）：api_case 且 resolve 出行 → 逐行执行，行级变量最优先
   （merge_vars(全局⊕环境, 场景) 打底、行覆盖，Review Focus 8）；落 (step_key,
   row_no) 明细，节点终态=全行通过才 pass；行事件带 row_progress="3/10"。
   行变量的作用域只到本步骤：跑完恢复场景层，下一行/下一步都不继承上一行
   extract 的残留——数据集的每一步都从同一份四层变量出发，报告才可复现。
③ 展开上限（Review Focus 2 执行期半边）：保存期算不出 while/foreach 的实际次数，
   执行期每展开一批行就**整批**记账，超 limit 立即终止。终止用 BaseException：
   dispatch 对 handler 的设计是「吸收一切 Exception 保 run 不炸穿」，而超限必须
   炸穿出整棵树——只有 BaseException 能穿过那道 except Exception。这不是疏漏，
   是「运行级熔断」与「单步异常」本来就不同的类型学。

超时与取消都只在步骤边界生效（§8.2；长等待内部的取消切片是 sleep handler 的事）。
超时/fail_fast 之后剩余顶层步骤写 skip 行——「没跑」必须在报告里可见且说明原因，
静默消失等于把 12 步的场景报成 3 步。取消则不补写：§8.2 只承诺已完成步骤保留可读。

每步落 vars_snapshot（§8.3 重跑依据）；终态把 graph ⊕ 每 key 结果写进
summary_graph（Review Focus 10：purge 掉场景后报告仍自包含）。
"""
from __future__ import annotations

import copy
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select

from app.core.errors import ApiError
from app.core.eventbus import get_bus
from app.core.registry import REGISTRY
from app.core.service import ctx_from_actor
from app.modules.execution.artifacts import offload_detail, save_artifact
from app.modules.execution.models import RunEvent, RunRecord, RunStepResult
from app.modules.execution.services import new_run
from app.modules.scenario.engine.context import DEFAULT_TIMEOUT_MS, ExecutionContext
from app.modules.scenario.engine.events import is_cancelled, publish, write_step
from app.modules.scenario.engine.handlers import (
    BranchResult,
    StepOutcome,
    _is_true,
    _resolve_case,
    _worst,
    dispatch,
)
from app.modules.scenario.graph import iter_nodes
from app.shared.vars import merge_vars


class _Stop(BaseException):
    """运行级熔断（超时/展开超限）。BaseException：dispatch 刻意吸收一切
    Exception 兜单步异常，运行级终止必须穿过它（见模块 docstring ③）。"""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class _Timeout(_Stop):
    pass


class _Overflow(_Stop):
    pass


def _now() -> datetime:
    """与 events._now 同口径：naive UTC，aware 值会被 asyncmy 静默裁掉。"""
    return datetime.now(UTC).replace(tzinfo=None)


def _key_kind(node: Any) -> tuple[str, str]:
    if not isinstance(node, Mapping):
        return "?", ""
    return str(node.get("key") or "?"), str(node.get("kind") or "")


def _nodes_of(graph: Any) -> list:
    if isinstance(graph, Mapping) and isinstance(graph.get("nodes"), list):
        return [n for n in graph["nodes"] if isinstance(n, Mapping)]
    return []


async def _env_layers(db: Any, project_id: str, env_id: str | None,
                      actor: Mapping | None) -> tuple[dict, dict, int]:
    """全局⊕环境两层经 REGISTRY 的 env_resolve 取（契约 4，与 handlers 取用例同族）。

    没有发起人身份（系统触发未配归属人）时返回空层：这不是「查了没有」，
    是「没资格查」，不能共用一句错话；但执行也不在这里崩——api_case 步骤自己的
    身份防御会把真正的问题暴露在该暴露的那一步上。
    """
    if not actor or not actor.get("user_id"):
        return {}, {}, DEFAULT_TIMEOUT_MS
    spec = REGISTRY.get("env_resolve")
    if spec is None:
        raise ApiError("internal_error", "env_resolve 未注册（服务尚未初始化完成）", 500)
    # user_id 非空由上面的守卫保证；构造口径与 handlers 共用 ctx_from_actor
    sctx = ctx_from_actor(actor, db)
    out = await spec.handler(spec.model.model_validate({"project_id": project_id,
                                                        "env_id": env_id}), sctx)
    data = out.model_dump()
    timeout = data.get("timeout_ms")
    return ({str(k): str(v) for k, v in (data.get("vars") or [])},
            {str(k): str(v) for k, v in (data.get("headers") or [])},
            int(timeout) if isinstance(timeout, int) and timeout > 0 else DEFAULT_TIMEOUT_MS)


class _RunState:
    """一次 run_graph 调用的全部可变态：步骤循环 + 记账 + 落库。"""

    def __init__(self, ctx: ExecutionContext, *, fail_fast: bool, expansion_limit: int,
                 deadline: float | None, dataset_rows: dict | None = None) -> None:
        self.ctx = ctx
        self.db = ctx.db
        self.bus = ctx.bus
        self.run_id = ctx.run_id
        self.fail_fast = fail_fast
        self.expansion_limit = expansion_limit
        self.expansions = 0
        self.rows_total = 0
        self.deadline = deadline
        # 单步重跑（T13）指定的数据集行：{"step_key","columns","rows":[[行号,值...]],"case_name"}。
        # 不为 None 且命中该 step_key 时 api_case 步骤不再自行展开数据集——行号用调用方给的
        # **源行号**，报告里 step_key#rN 的展示键与源 run 对得齐（落点裁定④）。
        self.dataset_rows = dataset_rows
        # key → 该节点最近一次执行的结果快照（summary_graph 与 run 判定的数据源）。
        # 循环里的同名节点反复执行：报告快照取最后一次，逐次痕迹在 run_step_result
        # 的 attempts 里，两处各有各的口径。
        self.results: dict[str, dict] = {}
        self.optional: dict[str, bool] = {}
        self.done: set[str] = set()

    # —— 记账 ——————————————————————————————————

    def add_expansion(self, n: int, key: str) -> None:
        """展开一批行前先整批记账：跑一半才发现超限 = 半个数据集打在目标系统上。"""
        if self.expansions + n > self.expansion_limit:
            raise _Overflow("expansion_overflow：数据集展开总数 " + str(self.expansions + n)
                            + " 超过上限 " + str(self.expansion_limit) + "（§8.6），步骤 "
                            + key + " 起未执行，运行已立即终止")
        self.expansions += n

    def check_timeout(self) -> None:
        if self.deadline is not None and time.perf_counter() >= self.deadline:
            raise _Timeout("运行超时：已达 max_runtime_ms 上限，剩余步骤已跳过")

    # —— 落库与事件：write_step 只 flush，publish 提交（events 模块的事务边界） ——

    async def persist(self, out: StepOutcome, parent_key: str | None, *, row_no: int = 0,
                      row_total: int | None = None, subject_name: str | None = None,
                      vars_snapshot: dict | None = None, extra: dict | None = None) -> None:
        # 1C T10：UI 步骤的制品 blob 只在这里落盘（handler 只交 StepOutcome.artifacts）。
        # detail 里那份是无 blob 的摘要——bytes 进 JSON 列会在绑参时炸 json.dumps，
        # offload_detail 也不认这个形状。run_artifact 行才是报告页看得见截图的东西，
        # save_artifact 只 flush，commit 归下面的 publish（与 write_step 同一事务边界）。
        for a in out.artifacts:
            await save_artifact(self.db, project_id=self.ctx.project_id, run_id=self.run_id,
                                kind=str(a.get("kind") or "SCREENSHOT"),
                                blob=a.get("blob") or b"", step_key=out.key or "?")
        # §8.8 的 64KB 线：唯一落库通道上裁一次，容器/数据集行/http_direct 都跑不掉。
        # 不能放在 handler 里——那只管 http 类步骤，sleep/assert/脚本的 logs 一样能撑爆 JSON 列。
        detail = await offload_detail(self.db, project_id=self.ctx.project_id,
                                      run_id=self.run_id, step_key=out.key or "?",
                                      detail=out.detail)
        await write_step(self.db, self.run_id, out.key or "?", status=out.status,
                         kind=out.kind or "?", parent_step_key=parent_key,
                         subject_name=subject_name, elapsed_ms=out.elapsed_ms,
                         detail=detail, row_no=row_no, row_total=row_total,
                         vars_snapshot=vars_snapshot if vars_snapshot is not None
                         else self.ctx.vars_snapshot())
        payload: dict[str, Any] = {"key": out.key or "?", "kind": out.kind,
                                   "status": out.status, "message": out.message,
                                   "elapsed_ms": out.elapsed_ms}
        if row_no:
            payload["row_no"] = row_no
        if row_total is not None:
            payload["row_total"] = row_total
        if extra:
            payload.update(extra)
        await publish(self.db, self.run_id, "step/" + out.status, payload, bus=self.bus)

    def note(self, node: Any, out: StepOutcome, *, row_total: int | None = None,
             pass_rows: int | None = None) -> None:
        key, kind = _key_kind(node)
        self.done.add(key)
        self.optional[key] = _is_true(node.get("optional")) if isinstance(node, Mapping) else False
        entry: dict[str, Any] = {"status": out.status, "message": out.message, "kind": kind}
        if row_total is not None:
            entry["row_total"] = row_total
            entry["pass_rows"] = pass_rows or 0
        self.results[key] = entry

    # —— 兄弟循环（与 handlers.make_runner 同一契约，见模块 docstring） ————

    async def run_children(self, nodes: list, parent_key: str | None = None, *,
                           in_loop: bool = False, run_lists: Mapping | None = None,
                           fail_fast: bool | None = None) -> BranchResult:
        stop_fast = self.fail_fast if fail_fast is None else fail_fast
        outcomes: list[StepOutcome] = []
        for child in nodes or []:
            if await is_cancelled(self.bus, self.run_id):
                key, kind = _key_kind(child)
                out = StepOutcome("cancelled", "运行已被取消，后续步骤未执行", None,
                                  key=key, kind=kind)
                await self.persist(out, parent_key)
                # note 必须在 return 之前：run 状态映射读的是 results，不记这一笔
                # 的话「取消后一步没跑」会被映射成「没有失败步骤」→ passed。
                self.note(child, out)
                outcomes.append(out)
                return BranchResult("cancelled", True, outcomes, None)
            out = await self.step(child, parent_key, in_loop=in_loop, run_lists=run_lists)
            outcomes.append(out)
            optional = _is_true(child.get("optional")) if isinstance(child, Mapping) else False
            if out.status == "cancelled":
                return BranchResult("cancelled", True, outcomes, None)
            if out.control in ("break", "continue"):
                return BranchResult(out.status, True, outcomes, out.control)
            if stop_fast and not optional and out.status not in ("pass", "skip"):
                return BranchResult(out.status, True, outcomes, None)
        return BranchResult(_worst(outcomes), False, outcomes, None)

    # —— 单步执行：running → （数据集展开 | dispatch）→ 落库 → 终态事件 ————

    async def step(self, node: Any, parent_key: str | None, *, in_loop: bool = False,
                   run_lists: Mapping | None = None) -> StepOutcome:
        key, kind = _key_kind(node)
        self.check_timeout()
        rows: tuple[int, int] | None = None
        if kind == "api_case":
            out, rows = await self._api_case_step(node, parent_key, key, in_loop=in_loop,
                                                  run_lists=run_lists)
        else:
            await publish(self.db, self.run_id, "step/running", {"key": key, "kind": kind},
                          bus=self.bus)
            out = await dispatch(node, self.ctx, run_children=self.run_children,
                                 in_loop=in_loop, run_lists=run_lists)
            await self.persist(out, parent_key)
        if rows is not None:
            self.note(node, out, row_total=rows[0], pass_rows=rows[1])
        else:
            self.note(node, out)
        return out

    async def _api_case_step(self, node: Any, parent_key: str | None, key: str, *,
                             in_loop: bool,
                             run_lists: Mapping | None) -> tuple[StepOutcome, tuple[int, int] | None]:
        """api_case 步骤的数据集分支。无行可展时回落普通 dispatch：多 resolve 一次，
        换「无数据集的路径与 handler 完全一致」——少一处会漂移的复制粘贴。"""
        ctx = self.ctx
        case_id = str(node.get("ref") or "")
        if self.dataset_rows is not None and key == str(self.dataset_rows.get("step_key") or ""):
            # T13 单步重跑的行级重建：行内容与行号都是调用方给的（源行号），不再 resolve
            # 出全部行——但请求模板仍走 dispatch → api_case_resolve，身份/权限照旧过，
            # 「重跑一行」与「跑整个用例集」在资格判定上没有第二套口径。
            ov = self.dataset_rows
            columns = [str(c) for c in (ov.get("columns") or [])]
            pairs = [(int(i), list(v)) for i, v in (ov.get("rows") or [])]
            # total 是数据集总行数（展示 row_progress 用），rows 只装被重跑的那一行。
            # 单步重跑不做 add_expansion 记账：一次就一行，恒低于任何合理上限。
            total = int(ov.get("total") or len(pairs))
            name = str(ov.get("case_name") or node.get("name") or "用例")
            await publish(self.db, self.run_id, "step/running", {"key": key,
                                                                 "kind": "api_case",
                                                                 "row_total": total},
                          bus=self.bus)
            out, head_rows = await self._expand_rows(node, parent_key, key, columns, pairs,
                                                     total, name,
                                                     in_loop=in_loop, run_lists=run_lists)
            return out, head_rows
        resolved: dict | None = None
        if case_id and (ctx.actor or {}).get("user_id"):
            try:
                resolved = await _resolve_case(ctx, case_id)
            except ApiError:
                resolved = None  # 缺身份/坏引用：交给 dispatch 走 handler 的文案防御
        rows = ((resolved or {}).get("dataset") or {}).get("rows") or []
        if not resolved or not resolved.get("executable") or not rows:
            await publish(self.db, self.run_id, "step/running", {"key": key,
                                                                 "kind": "api_case"},
                          bus=self.bus)
            out = await dispatch(node, ctx, run_children=self.run_children,
                                 in_loop=in_loop, run_lists=run_lists)
            await self.persist(out, parent_key)
            return out, None
        assert resolved is not None
        columns = [str(c) for c in (resolved["dataset"].get("columns") or [])]
        name = str(resolved.get("case_name") or node.get("name") or "用例")
        rows_list = list(rows)
        total = len(rows_list)
        # 整批预算：超了就在发出第一个请求之前停下（Review Focus 2 的「立即」）。
        # error 行先落库再抛熔断：报告里必须能指认是哪一步把运行熔断的。
        try:
            self.add_expansion(total, key)
        except _Overflow as e:
            out = StepOutcome("error", e.message,
                              {"request": None, "response": None, "assertions": [],
                               "logs": ctx.logs_for(key), "error": e.message},
                              key=key, kind="api_case")
            await self.persist(out, parent_key, row_total=total, subject_name=name)
            raise
        await publish(self.db, self.run_id, "step/running", {"key": key, "kind": "api_case",
                                                             "row_total": total}, bus=self.bus)
        return await self._expand_rows(node, parent_key, key, columns,
                                       [(j, list(v)) for j, v in enumerate(rows_list, 1)],
                                       total, name, in_loop=in_loop, run_lists=run_lists)

    async def _expand_rows(self, node: Any, parent_key: str | None, key: str,
                           columns: list[str], pairs: list[tuple[int, list]],
                           total: int, name: str, *, in_loop: bool,
                           run_lists: Mapping | None
                           ) -> tuple[StepOutcome, tuple[int, int]]:
        """数据集行循环的唯一实现：普通展开（1..N）与单步重跑（指定源行号）共用。

        pairs 是 (row_no, values)：普通展开 row_no=1..N；T13 重跑传源行号，
        明细落在 (step_key, 源行号)，报告展示键跨 run 对得齐。
        """
        ctx = self.ctx
        scene_vars = ctx.vars
        last_detail: dict | None = None
        statuses: list[str] = []
        pass_rows = 0
        for i, row in pairs:
            self.check_timeout()
            if await is_cancelled(self.bus, self.run_id):
                out = StepOutcome("cancelled", "运行已被取消，第 " + str(i) + " 行起未执行",
                                  None, key=key, kind="api_case")
                await self.persist(out, parent_key, row_no=i, row_total=total,
                                   subject_name=name)
                statuses.append("cancelled")
                break
            # 行级合并：四层里行最高（RF8）。每行都从场景层重新出发，行内 extract
            # 的增量不回灌场景层——第 2 行读到第 1 行提取的 token 是最难查的脏数据。
            ctx.vars = merge_vars(scene_vars, dict(zip(columns, list(row)[:len(columns)],
                                                       strict=False)))
            ctx.last_response = None  # 行与行不共享响应：提取错行比漏行更难查
            out = await dispatch(node, ctx, run_children=self.run_children,
                                 in_loop=in_loop, run_lists=run_lists)
            self.rows_total += 1
            statuses.append(out.status)
            if out.status == "pass":
                pass_rows += 1
            last_detail = out.detail
            await self.persist(out, parent_key, row_no=i, row_total=total, subject_name=name,
                               extra={"row_progress": str(i) + "/" + str(total)})
            if out.status in ("fail", "error") and self.fail_fast:
                break  # §8.6：行失败 + 场景 fail_fast → 终止后续行（run 判定交回节点结论）
        ctx.vars = scene_vars  # 行级作用域到此为止；last_response 留末行（供下游提取）
        status = ("cancelled" if "cancelled" in statuses
                  else "error" if "error" in statuses
                  else "fail" if "fail" in statuses else "pass")
        message = ("数据集 " + str(len(statuses)) + "/" + str(total) + " 行已执行，通过 "
                   + str(pass_rows) + " 行" + ("" if status == "pass" else "，结论 " + status))
        head = StepOutcome(status, message,
                           {**(last_detail or {}), "rows": [
                               {"row_no": p[0], "status": s}
                               for p, s in zip(pairs, statuses, strict=False)]},
                           key=key, kind="api_case")
        # 节点行 row_no=0：报告节点显示 pass_rows/total_rows（§8.6），快照是场景层
        await self.persist(head, parent_key, row_total=total, subject_name=name,
                           vars_snapshot=copy.deepcopy(scene_vars))
        return head, (total, pass_rows)


def _summary(graph: Any, results: dict[str, dict]) -> dict:
    """graph ⊕ 每 key 结果（Review Focus 10）：报告页不 join 场景表也能整树上色。"""
    # Any：graph 是 JSON 树（本模块所有 graph 参数都是 Any）；deepcopy 的返回类型
    # 跟着入参走成 Mapping，而本函数只往**节点对象**上写 result，不动顶层键。
    sg: Any = copy.deepcopy(graph) if isinstance(graph, Mapping) else {"nodes": []}
    for n, _parent, _depth in iter_nodes(sg):
        r = results.get(str(n.get("key") or ""))
        if r is not None:
            n["result"] = dict(r)
    return sg


def _top_status(state: _RunState, top: list) -> tuple[str, str]:
    """两层词表的唯一映射点。optional 的 fail/error 不参与 run 判定（docstring ①）。"""
    considered = [(state.results[k], state.optional.get(k, False))
                  for k, _ in (_key_kind(n) for n in top) if k in state.results]
    if any(r["status"] == "cancelled" for r, _o in considered):
        return "cancelled", "运行已被取消"
    hard = [r for r, o in considered if not o]
    bad = next((r for r in hard if r["status"] == "error"), None) or \
        next((r for r in hard if r["status"] not in ("pass", "skip")), None)
    if bad is not None:
        word = "error" if bad["status"] == "error" else "failed"
        return word, str(bad["message"] or "存在未通过步骤")[:280]
    return "passed", ""


async def run_graph(db: Any, *, project_id: str, run_id: str, graph: Any,
                    env_id: str | None = None, fail_fast: bool = True,
                    max_runtime_ms: int = 1_800_000, expansion_limit: int = 500,
                    transport: Any = None, variables: Mapping | None = None,
                    actor: Mapping | None = None, bus: Any = None,
                    dataset_rows: Mapping | None = None,
                    last_response: Any = None,
                    common_assertions: list | None = None,
                    replace_vars: bool = False) -> dict:
    """顺序执行 step_graph，返回 stats（含 run 层 status 与 message）。

    变量四层：env_resolve 出的「全局⊕环境」打底，调用方给的场景 variables 次之，
    api_case 数据集行在本步骤内覆盖一切（Review Focus 8）。

    T13 单步重跑的两个入口（普通执行都不传，行为与此前完全一致）：
    - dataset_rows：给定 api_case 步骤的行集 {"columns","rows":[[行号,值...]],"case_name"}，
      覆盖 resolve 出的行集——行号是**源 run 的行号**，明细落在同一 (step_key, row_no)，
      报告的 #rN 展示键跨 run 对得齐；
    - last_response：重建的「上一步响应」，让 assert/extract 这类不自己发请求的步骤
      在没有前置步骤的同 run 上下文里也能重跑（§8.3）；
    - replace_vars：True 时 variables 整层替换「全局⊕环境」——单步重跑的变量基底是
      当时的 vars_snapshot（已含全部层），运行之后新加的全局变量不该偷渡进重跑；
      env 仍供 headers/timeout。

    T20b 公共断言（普通执行按需传入，不传行为与此前完全一致）：
    - common_assertions：**场景级质量门，作用于每一个真正发出请求的步骤**（R88 业主裁定，
      推翻 405647b 的「拓扑跑完对末步响应判一次」）。求值点在 handlers._send，语义与该步
      自己的断言完全一致（optional / fail_fast / pass-fail 一视同仁），任一步不过 → 该步
      fail → run 判 failed（不是 error，§8.6）。没有请求步骤的图自然一步都不判，不报错。
    """
    t0 = time.perf_counter()
    if bus is None:
        bus = get_bus()
    started = _now()
    state_error: str | None = None
    try:
        env_vars, headers, timeout_ms = await _env_layers(db, project_id, env_id, actor)
    except ApiError as e:
        state_error = "环境不可用：" + e.message
        env_vars, headers, timeout_ms = {}, {}, DEFAULT_TIMEOUT_MS
    # `or {}`：replace_vars 档的调用方（单步重跑）确实必给 variables，但 None 走到
    # 这里 dict(None) 是 TypeError——换不成「空基底」，只是把崩换成能解释的空变量集。
    base = dict(variables or {}) if replace_vars else merge_vars(env_vars, variables)
    ctx = ExecutionContext(db, bus, run_id, project_id, base,
                           headers, timeout_ms, actor=actor, transport=transport)
    # T20b（R88）：公共断言是**运行期上下文**，由 handlers._send 在每一次真正发出请求
    # 并拿到响应后求值（与该步自己的断言同一轮判定）。空列表 = 不启用。
    ctx.common_assertions = [dict(a) for a in (common_assertions or [])]
    if last_response is not None:
        ctx.last_response = last_response  # 重建的「上一步响应」（T13 assert/extract 重跑）
    deadline = t0 + max_runtime_ms / 1000.0 if max_runtime_ms and max_runtime_ms > 0 else None
    state = _RunState(ctx, fail_fast=fail_fast, expansion_limit=expansion_limit,
                      deadline=deadline,
                      dataset_rows=dict(dataset_rows) if dataset_rows else None)
    top = _nodes_of(graph)
    timed_out = False
    overflow_msg: str | None = None
    br = BranchResult("pass")
    if state_error is None and not top:
        state_error = "step_graph 没有可执行的节点：nodes 需为非空数组"
    if state_error is not None:
        br = BranchResult("error", True, [StepOutcome("error", state_error, None)], None)
    else:
        try:
            br = await state.run_children(top, None)
        except _Timeout as e:
            timed_out = True
            state_error = e.message
        except _Overflow as e:
            overflow_msg = e.message
        except Exception as e:  # noqa: BLE001 run 级兜底：循环自身出了 bug 也要出完整报告
            state_error = "运行异常：" + type(e).__name__ + ": " + str(e)[:200]

    skip_reason: str | None = None
    if timed_out:
        skip_reason = "运行超时（max_runtime_ms），未执行"
    elif overflow_msg is None and state_error is None and fail_fast \
            and br.stopped and br.status not in ("cancelled",) and br.control is None:
        skip_reason = "因 fail_fast 在上一个未通过步骤后终止，未执行"
    if skip_reason:
        for n in top:
            key, kind = _key_kind(n)
            if key in state.done:
                continue
            out = StepOutcome("skip", skip_reason, {"request": None, "response": None,
                                                    "assertions": [], "logs": [],
                                                    "error": skip_reason},
                              key=key, kind=kind)
            await state.persist(out, None, vars_snapshot=ctx.vars_snapshot())
            state.note(n, out)

    status, message = _top_status(state, top)
    if timed_out:
        status, message = "error", state_error or "运行超时"
    elif overflow_msg is not None:
        status, message = "error", overflow_msg
    elif state_error is not None and status == "passed":
        status, message = "error", state_error

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    counts = {"pass": 0, "fail": 0, "skip": 0, "error": 0, "cancelled": 0}
    for key, _ in (_key_kind(n) for n in top):
        r = state.results.get(key)
        if r is not None and r["status"] in counts:
            counts[r["status"]] += 1
    stats: dict[str, Any] = {"total": len(top), **counts, "elapsed_ms": elapsed_ms,
                             "rows_total": state.rows_total, "status": status,
                             "message": message}
    # T20b（R88 语义修正）：公共断言的求值行**落在各步骤自己的明细里**（detail.assertions
    # 带 scope="common"），不再有 run 级 stats.common_assertions——逐行结果本来就在
    # 「它命中的那一步」上，报告右栏天然显示，比在 run 层再攒一份更对（也不会两处漂移）。
    summary = _summary(graph, state.results)

    rec = await db.get(RunRecord, run_id)
    finalized: dict[str, Any] | None = None
    if rec is not None:
        rec.status = status
        rec.stats = {k: v for k, v in stats.items() if k != "message"}
        rec.summary_graph = summary
        rec.elapsed_ms = elapsed_ms
        rec.started_at = rec.started_at or started
        rec.finished_at = _now()
        if status in ("failed", "error", "cancelled"):
            rec.error = (message or status)[:300]
        if status in ("passed", "failed", "error", "cancelled"):
            # 摘要在 commit **前**取齐标量：commit 会过期实例（expire_on_commit=True 的
            # 会话里 commit 后再触 ORM 属性 = MissingGreenlet，本仓踩过多次的坑）。
            finalized = {
                "run_id": run_id, "status": status, "message": message, "error": rec.error,
                "stats": dict(rec.stats or {}), "trigger": rec.trigger,
                "subject_type": rec.subject_type, "subject_id": rec.subject_id,
                "subject_name": rec.subject_name, "env_name": rec.env_name,
                "created_by": rec.created_by, "elapsed_ms": elapsed_ms,
                "finished_at": rec.finished_at.isoformat() if rec.finished_at else None,
            }
        await db.commit()
    # 1E T3 · run 终态钩子的**唯一**挂载点（core.set_run_finalized_hook 注册表形状）：
    # 必须排在 commit 之后——run 行是真相且已落库，notify 侧炸了也只坏旁路（钩子异常
    # 由 core.run_finalized 唯一一处吞掉）。orchestration._run_claimed 与 run_single_step
    # 都汇流到这里，故不许在调用点各挂一遍。
    if finalized is not None:
        from app.core.service import run_finalized

        await run_finalized(db, run_id=run_id, project_id=project_id,
                            trigger=finalized["trigger"], ok=(status == "passed"),
                            summary=finalized)
    return stats


async def run_single_step(db: Any, *, project_id: str, source_run_id: str, step_key: str,
                          row_no: int | None = None, env_id: str | None = None,
                          transport: Any = None, bus: Any = None, actor: Mapping | None = None,
                          trigger: str = "manual", created_by: str | None = None) -> str:
    """单步重跑（§8.3 完整版）：从源 run 的落库快照重建上下文，只跑那一步（或其子树）。

    重建三件套（计划 T13 裁定 ①-⑥，此处不重复理由）：
    - 图：源 run 的 summary_graph 里摘出该节点（含 children）——不读 scenario.step_graph，
      场景 purge 后重跑仍可重建（RF10 的自包含承诺延伸到重跑）；
    - vars：该步（数据集行则是该行）的 vars_snapshot 整层替换场景层——快照本就含
      全局⊕环境⊕场景三层合并结果，重跑时 env_resolve 仍要跑，但只为拿 headers/timeout；
      数据集行重跑时把**新** resolve 的行值再合并上去（行最高，与 §8.6 同口径——
      数据集里已删除的列在快照里留旧值，是可解释的残留）；
    - last_response：该步 detail.response；没有则按 run_event.seq 倒序找同 run 内最近
      一条有响应的步骤（seq 是执行顺序唯一真相，run_step_result 没有顺序列）。
      被制品化外置的 body 只有 2KB head——如实带着 head 跑，不静默造假全文。

    缺任何一件都是 409 snapshot_missing（诚实口径：空上下文跑出来的绿比红糟糕）；
    行号越界是 400 validation_error 且发生在新 run 行出生**之前**（T9 立的规矩：不留孤儿 run）。
    新 run 经 execution.services.new_run 出生（构造点唯一），终态由 run_graph 回写。
    """
    if bus is None:
        bus = get_bus()
    src = await db.get(RunRecord, source_run_id)
    if src is None or src.project_id != project_id:
        raise ApiError("not_found", "来源运行不存在", 404, {"run_id": source_run_id})
    sg = src.summary_graph if isinstance(src.summary_graph, Mapping) else None
    node: Mapping | None = None
    if sg is not None:
        for n, _p, _d in iter_nodes(sg):
            if str(n.get("key") or "") == step_key:
                node = n
                break
    if node is None:
        raise ApiError("snapshot_missing",
                       "缺步骤图快照：来源运行没有 summary_graph 或其中找不到步骤 "
                       + step_key + "，无法重建该步", 409, {"step_key": step_key})

    # —— 行号参数与边界：先于任何建行与回表判定（裁定④：越界是 400，不是静默跑空）——
    dataset_rows: dict | None = None
    if row_no is not None:
        if row_no < 1:
            raise ApiError("validation_error", "row_no 需为 ≥1 的数据集行号", 400,
                           {"row_no": row_no})
        if str(node.get("kind") or "") != "api_case":
            raise ApiError("validation_error",
                           "只有数据集用例步骤有行号，该步骤 kind="
                           + str(node.get("kind") or "?"), 400, {"step_key": step_key})
        if not actor or not actor.get("user_id"):
            # 行边界只能在建行前判，判边界要 resolve，resolve 要身份——
            # 这是参数可满足性问题，不是权限判决（400 而非 403，裁定④）。
            raise ApiError("validation_error", "按行重跑必须带发起人身份（需先解析数据集）",
                           400, {"row_no": row_no})
        resolved = await _resolve_case(_resolve_ctx(db, project_id, actor),
                                       str(node.get("ref") or ""))
        ds = (resolved or {}).get("dataset") or {}
        fresh_rows = ds.get("rows") or []
        if not (resolved or {}).get("executable") or not fresh_rows:
            raise ApiError("validation_error",
                           "该用例当前没有可执行的数据集行（定义草稿或用例/数据集已变）",
                           400, {"row_no": row_no})
        if row_no > len(fresh_rows):
            raise ApiError("validation_error",
                           "行号越界：数据集当前只有 " + str(len(fresh_rows)) + " 行，请求第 "
                           + str(row_no) + " 行", 400, {"row_no": row_no})
        dataset_rows = {"step_key": step_key, "columns": list(ds.get("columns") or []),
                        "rows": [[row_no, list(fresh_rows[row_no - 1])]],
                        "case_name": resolved.get("case_name"), "total": len(fresh_rows)}

    want_row = int(row_no) if row_no is not None else 0
    srow = (await db.execute(
        select(RunStepResult).where(RunStepResult.run_id == source_run_id,
                                    RunStepResult.step_key == step_key,
                                    RunStepResult.row_no == want_row)
    )).scalars().first()
    if srow is None:
        raise ApiError("snapshot_missing",
                       "查不到该步骤的执行明细" + ("" if row_no is None
                                                   else "的第 " + str(row_no) + " 行")
                       + "，无法重建该步", 409, {"step_key": step_key, "row_no": want_row})
    if srow.vars_snapshot is None:
        # 空 dict 是合法快照（场景确实没有变量）；NULL 才是「没写过」——旧数据/写入缺失。
        raise ApiError("snapshot_missing", "该步骤没有变量快照（旧数据或写入缺失），"
                                           "无法重建执行上下文", 409, {"step_key": step_key})
    detail = srow.detail if isinstance(srow.detail, Mapping) else {}
    resp = (detail.get("response")
            if isinstance(detail.get("response"), Mapping) else None)
    if resp is None:
        resp = await _fallback_response(db, source_run_id, step_key)

    # env 默认沿用源 run（可覆写）——headers/timeout 来自 env_resolve；vars 整层用快照，
    # 不再混 env vars（快照已含它们；再混会把「运行之后被人改过的全局变量」偷渡进重跑）。
    eff_env = env_id or src.env_id
    _env_vars, headers, timeout_ms = await _env_layers(db, project_id, eff_env, actor)
    new = await new_run(db, project_id=project_id, subject_type=src.subject_type,
                        subject_id=src.subject_id,
                        subject_name=(src.subject_name + "（单步重跑 " + step_key + "）")[:200],
                        env_id=eff_env, env_name=src.env_name, trigger=trigger,
                        created_by=created_by, max_runtime_ms=src.max_runtime_ms)
    run_id = new.id  # 先取标量：后续 commit 会过期实例（MissingGreenlet 的坑）
    await db.commit()

    single = _single_graph(node, source_run_id, step_key, row_no)
    # T20b（R88）：重跑必须带上**当时那一步生效过的**公共断言，否则「重跑这一步」会得出
    # 与原 run 不同的结论（原来被场景级门判红的步骤，重跑反而绿——同一份响应两个说法）。
    # 取该步 detail 里落库的那份（见 handlers._send 的注释：结果行不含配置，必须存配置），
    # 不读 scenario 行——场景 purge 后重跑仍要可复现（RF10 自包含承诺）。
    # 0017 之前的旧 run 没有这个键 → 空 → 不判，与「当时根本没有这道门」一致。
    rerun_cas = detail.get("common_assertions")
    if not isinstance(rerun_cas, list):
        rerun_cas = []
    try:
        stats = await run_graph(db, project_id=project_id, run_id=run_id, graph=single,
                                env_id=eff_env, fail_fast=True,
                                max_runtime_ms=int(src.max_runtime_ms or 1_800_000),
                                transport=transport, variables=srow.vars_snapshot,
                                replace_vars=True,
                                actor=actor, bus=bus, dataset_rows=dataset_rows,
                                last_response=resp, common_assertions=rerun_cas)
    except Exception as e:  # noqa: BLE001 引擎炸穿也必须落终态：重跑不许永远 queued（裁定⑤）
        rec0 = await db.get(RunRecord, run_id)
        if rec0 is not None and rec0.status == "queued":
            rec0.status = "error"
            rec0.error = ("重跑异常：" + type(e).__name__ + ": " + str(e))[:300]
            rec0.finished_at = _now()
            await db.commit()
        stats = {"status": "error", "message": str(e)[:280]}
    # 标注写进终态之后的回写：stats 里 rerun_of/rerun_step、图上 rerun_of/rerun_step，
    # 运行记录页与报告页跳转都从这两处读（裁定⑤）。
    rec = await db.get(RunRecord, run_id)
    if rec is not None:
        rerun: dict[str, Any] = {"rerun_of": source_run_id, "rerun_step": step_key}
        if row_no is not None:
            rerun["rerun_row_no"] = int(row_no)  # 混合类型：不声明 dict[str, Any] 就装不下 int
        rec.stats = {**(rec.stats or {}), **rerun}
        if isinstance(rec.summary_graph, dict):
            rec.summary_graph = {**rec.summary_graph, **rerun}
        await db.commit()
    status = str(stats.get("status") or "error")
    await publish(db, run_id, "run_end", {"status": status,
                                          "stats": {k: v for k, v in stats.items()
                                                    if k != "message"}}, bus=bus)
    # 场景冗余列回写（与 orchestration._amain 同一口径）：重跑也是这个场景的一次执行。
    if status in ("passed", "failed", "error", "cancelled") and src.subject_type == "scenario":
        from app.modules.scenario.models import Scenario  # 同域 import，延迟到用时（与 T9 同法）

        s2 = await db.get(Scenario, src.subject_id)
        if s2 is not None:
            s2.last_run_at = _now()
            s2.last_run_status = status
            await db.commit()
    return run_id


def _single_graph(node: Mapping, source_run_id: str, step_key: str,
                  row_no: int | None) -> dict:
    """新 run 的图：只有源节点（children 原样带上 → 容器重跑整棵子树，裁定⑤的形状）。"""
    g: dict[str, Any] = {"version": 1, "nodes": [copy.deepcopy(dict(node))],
                         "rerun_of": source_run_id, "rerun_step": step_key}
    if row_no is not None:
        g["rerun_row_no"] = int(row_no)
    return g


def _resolve_ctx(db: Any, project_id: str, actor: Mapping) -> ExecutionContext:
    """只为边界检查临时造一个带身份的壳（_resolve_case 只读 db/project_id/actor）。"""
    ctx = ExecutionContext(db, None, "", project_id, None, None, DEFAULT_TIMEOUT_MS,
                           actor=actor)
    return ctx


async def _fallback_response(db: Any, source_run_id: str, step_key: str) -> dict | None:
    """目标步没有响应明细时，按事件 seq 倒序找同 run 最近一条「有响应的终态事件」。

    run_step_result 无顺序列、created_at 只有秒精度——seq 是唯一可信的执行顺序
    （裁定③）。事件 payload 不含响应体，所以拿到 key 后要回表取 detail.response。
    """
    evs = (await db.execute(
        select(RunEvent).where(RunEvent.run_id == source_run_id,
                               RunEvent.type.like("step/%"),
                               RunEvent.type != "step/running")
        .order_by(RunEvent.seq.desc())
    )).scalars().all()
    seen: set[str] = set()
    for ev in evs:
        key = str((ev.payload or {}).get("key") or "")
        if not key or key == step_key or key in seen:
            continue
        seen.add(key)
        row = (await db.execute(
            select(RunStepResult).where(RunStepResult.run_id == source_run_id,
                                        RunStepResult.step_key == key,
                                        RunStepResult.row_no == 0)
        )).scalars().first()
        det = row.detail if row is not None and isinstance(row.detail, Mapping) else None
        r = det.get("response") if det else None
        if isinstance(r, Mapping) and r:
            return dict(r)
    return None


__all__ = ["run_graph", "run_single_step"]
