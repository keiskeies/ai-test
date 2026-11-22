"""kind handler 注册表：15 个 kind 全部能跑（1B 的 13 个 + 1C 补 ui_case + 1D T8 补 adb_case；§8.1 §7.4 §8.2 §8.5 §8.6）。

分工要说清：runner（T8）负责「按顺序取节点、落库、发事件、展开数据集行」，本模块只负责
**每种 kind 到底做什么**。所以每个 handler 都遵守同一份契约：

    Handler = async (node, ctx, *, run_children, in_loop=False, run_lists=None) -> StepOutcome

- 状态词只用 RunStepResult 那一套（pass/fail/skip/error/cancelled）。run_record 那套
  （passed/failed/error）由 T9 汇总时映射，两层混用会让报告出现「步骤全绿但运行是红的」。
- fail = 断言不成立（业务结论），error = 这一步没能执行完（网络、脚本崩、配置缺）。
  两者在报告页是不同颜色、不同处置动作，绝不能合并成「失败」。
- handler **不写 ctx.vars**：变量通过返回值的 vars 交出，由 dispatch 单点合并。这样
  「这一步改了哪些变量」是可审计的（§8.3 单步重跑要据此回滚重放）。
- detail 结构在这里钉死：{request, response, assertions, logs, error, script?}，
  报告页（T12）与单步重跑（T11）都按它取数。
- **容器是唯一的例外**：foreach 要在每一轮开始前把 item_var 写进 ctx.vars，因为子节点
  在 run_children 内部执行，等返回值合并就晚了。除这一处作用域预置，handler 一律
  通过返回值交变量。

两处刻意的产品取向，都写在测试里钉住：
- adb_case（1D T8 起注册 h_adb_case）与 ui_case 同骨架：resolve 经注册表、执行经
  adb_test 的内部件 `adb_case_engine_run`（它进程内跑 R102 那份唯一执行体，R145）——
  「保存期 BLOCKED_1B + 执行期 PENDING_KINDS + 注册表」三处成对，两表清空但机制保留
  （未来批次再拦新 kind 时三处一起写）。执行失败绝不静默跳过：一条其实什么都没测的
  场景显示绿色，比显示红色危险得多。
- loop.while 是**先判条件再跑**（标准 while，不是 do-while）：§7.4 的轮询写法
  「ctx.vars.get('state', 'Pending') == 'Pending'」首轮之前就有确定真值，先判条件
  既能正常收束也让「条件写坏」在第一步就暴露；想要「至少跑一次」请自己套一层 group。
  条件求值失败（碰红线/语法错）时 while 直接判 error 并退出，不静默当假收工——
  「循环跑了 0 轮」和「循环成功收工」在报告里必须长得不一样。
"""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from app.core.errors import ApiError
from app.core.registry import REGISTRY
from app.core.service import ctx_from_actor
from app.modules.execution.core import run_api
from app.modules.scenario.engine.context import ExecutionContext
from app.modules.scenario.engine.events import is_cancelled
from app.shared.assertions import ResponseView, evaluate
from app.shared.jsonpath import JsonPathMissing, jsonpath_get
from app.shared.sandbox import evaluate_condition, run_script
from app.shared.vars import MissingVar

# 步骤级状态词表（与 execution.models.RunStepResult.status 同一套，勿增删）
STATUS = ("pass", "fail", "error", "skip", "cancelled")
# sleep 的取消检查粒度（§8.2）：500ms 兼顾「点停止立刻生效」与「Redis 别被打爆」
SLEEP_SLICE_MS = 500
# 尚无执行器的 kind → 开放期次（R48：拒绝执行但要说清几期能用）。
# 1C T10 摘掉 ui_case、1D T8 摘掉 adb_case（handler 见 h_ui_case / h_adb_case）——表清空
# 但 dispatch 的闸保留：它是「未注册 kind 说清几期开放」的机制本体，未来批次要用。
# 这一处与 graph.BLOCKED_1B、模块底部 HANDLERS 的注释成对出现——
# dispatch 先查本表再查 HANDLERS，两边必须同时改。
PENDING_KINDS: dict[str, str] = {}


@dataclass
class StepOutcome:
    """一个步骤的执行结论。children/iterations 只对容器 kind 有意义。"""

    status: str
    message: str | None = None
    detail: dict[str, Any] | None = None
    vars: dict[str, str] | None = None
    control: str | None = None          # None | "break" | "continue"
    key: str | None = None
    kind: str | None = None
    children: list[StepOutcome] = field(default_factory=list)
    iterations: int = 0
    elapsed_ms: int | None = None
    # 1C T10：ui_case 步骤的原始制品（含 bytes blob）。**不进 detail**——
    # run_step_result.detail 是 JSON 列，bytes 会在绑参时炸 json.dumps；
    # blob 走这条通道交给 runner 的 persist 路径 save_artifact 落盘。
    artifacts: list[dict] = field(default_factory=list)


@dataclass
class BranchResult:
    """一组子节点的聚合结论（勘误⑤）。

    stopped 表示因 fail_fast / cancel / break|continue 提前中断，容器据此不再起下一轮。
    control 是穿透容器的控制信号：break 可以藏在 loop > group > if > break 的任意深度，
    聚合点是 run_children，所以控制信号必须在聚合处出现——让容器自己递归扫子树去找
    等于把语义藏进遍历里，加一层容器就漏一次。
    """

    status: str
    stopped: bool = False
    outcomes: list[StepOutcome] = field(default_factory=list)
    control: str | None = None


def _stringify(value: Any) -> str:
    """进 vars 的值一律 str（T6 口径）；dict/list 用 ensure_ascii=False 保中文（勘误⑥）。"""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _key_of(node: Mapping) -> str:
    return str(node.get("key") or "?")


def _cfg(node: Mapping) -> dict:
    cfg = node.get("config")
    return dict(cfg) if isinstance(cfg, Mapping) else {}


def _detail(ctx: ExecutionContext, *, key: str, request: Any = None, response: Any = None,
            assertions: list | None = None, error: str | None = None,
            script: str | None = None) -> dict:
    """detail 的唯一构造点：结构漂移会让报告页与重跑同时坏掉，且很难发现。"""
    d: dict[str, Any] = {
        "request": request,
        "response": response,
        "assertions": assertions or [],
        "logs": ctx.logs_for(key),
    }
    if error:
        d["error"] = error
    if script is not None:
        d["script"] = script      # 报告页要能回看脚本原文（§8.5）
    return d


def _response_view(result: Any) -> dict:
    """RunResult → last_response / detail.response 的统一形状（§7.5 供 assert/extract 速取）。

    **不截断**。这里曾按 8000 字符砍 body 并打 `body_inline_truncated`：报告页于是显示
    一份被砍剩的响应，用户以为目标系统就返回这么点——静默毁证据，比报错更糟，而且没有任何
    测试钉住它。落库体积由 runner 的 `offload_detail` 统一处理（§8.8 的 64KB 线：超阈值
    整段外置成制品、DB 只留 ref + 2KB head），阈值以内**照原样存**才是对的口径。
    唯一的上游上限是 `execution.core.MAX_BODY_CHARS`（Review Focus 2），那是防 OOM 的
    硬闸门，与「报告该不该给用户看全文」是两件事。
    """
    return {"status": result.status, "headers": result.headers,
            "elapsed_ms": result.elapsed_ms, "body_size": result.body_size,
            "truncated": bool(result.truncated), "body": result.body_text}


def _describe_assertions(rows: list) -> str:
    bad = [r for r in rows if not r.get("passed")]
    if not bad:
        return str(len(rows)) + " 条断言全部通过"
    first = bad[0]
    # 场景级门与步骤自己的断言，处置动作不同（一个改场景、一个改这一步），说清是谁在说话。
    who = "场景公共断言" if first.get("scope") == "common" else "断言"
    return (str(len(bad)) + "/" + str(len(rows)) + " 条" + who + "未通过：" + str(first.get("type"))
            + " 期望 " + repr(first.get("expected")) + " 实际 " + repr(first.get("actual")))


# —— API 类步骤：http_direct / api_case ——————————————————


def _build_request(cfg: Mapping, ctx: ExecutionContext) -> dict:
    """http_direct 的 config 自身就是请求描述（勘误①，以 T4 已提交的 graph.py 为准）。

    环境/全局超时只在请求自己没写 timeout_ms 时生效 —— 与 1A api_debug 同口径。
    否则「环境里配了 3s」会悄悄让所有单步设过长超时的请求一起超时。
    """
    req: dict[str, Any] = {}
    # auth 必须在白名单里：漏了它 = 步骤配了认证却裸奔出发（静默丢 = 撒谎的绿）
    for k in ("method", "url", "headers", "params", "body", "auth", "timeout_ms", "assertions"):
        if cfg.get(k) is not None:
            req[k] = cfg[k]
    req.setdefault("method", "GET")
    if "timeout_ms" not in req:
        req["timeout_ms"] = ctx.timeout_ms
    return req


def _apply_headers(req: dict, ctx: ExecutionContext) -> dict:
    """环境/全局头打底，步骤自带头按键覆盖（大小写不敏感，§7.5）。

    两边都是 [[k, v]] 对表（1A 口径）。必须先去重：httpx 会把重名头拼成逗号串，
    于是 Authorization 变成 "tk-a, tk-b" —— 一个谁也没写过、却像正常头的值。
    """
    own = [list(p) for p in (req.get("headers") or []) if isinstance(p, (list, tuple))]
    seen = {str(k).lower() for k, _ in own}
    merged = list(own)
    for k, v in (ctx.headers or {}).items():
        if str(k).lower() not in seen:
            merged.append([k, v])
    req["headers"] = merged
    return req


async def _send(ctx: ExecutionContext, key: str, req: dict, *, subject: str | None = None,
                extra_detail: dict | None = None) -> StepOutcome:
    """发一次请求并归一状态：网络不通 = error，断言不过 = fail，全过 = pass。

    状态判定只在这一处（照 execution.core.RunResult 的结论），T9 汇总运行状态时不再
    二次判定 —— 两层各自判定迟早对不上，出现「步骤全绿但运行是红的」。

    detail 里存的是**渲染后**的请求：报告页要说「实际发出去的到底是什么」，而不是
    「用户写的模板长什么样」（§8.3 单步重跑也按这份请求复现）。渲染单独在这里算一次
    给 detail 用，发给 run_api 的仍是原始 req —— 它内部会做同一遍单次渲染。两处都是
    「同一函数 + 同一输入」，结果必然一致；反过来若把渲染结果再喂给 run_api，
    变量值里带的 `${...}` 字面量会被展开第二遍（数据集里一个「价格 ${100}」就能触发）。
    """
    try:
        sent = ctx.render(req)
    except MissingVar as e:
        msg = "缺少变量：${" + e.name + "}"
        # 缺变量就不发请求：拿半个模板去打目标系统，坏了也算在它头上
        return StepOutcome("error", msg, _detail(ctx, key=key, request=req, error=msg))
    try:
        result = await run_api(req, variables=ctx.vars, transport=ctx.transport)
    except MissingVar as e:  # 理论上到不了（上面已渲染过一遍），留着是为了不炸穿 runner
        msg = "缺少变量：${" + e.name + "}"
        return StepOutcome("error", msg, _detail(ctx, key=key, request=req, error=msg))
    # last_response 与落库那份现在同形（都不截断）；落库前由 runner 过 offload_detail。
    # 两份各存一份：detail 会被塞进 vars_snapshot / 制品替身，共享同一个 dict 迟早串味。
    view = _response_view(result)
    ctx.last_response = view
    rows = list(result.assertions or [])
    detail = _detail(ctx, key=key, request=sent, response=view, assertions=rows,
                     error=result.error)

    if extra_detail:
        detail.update(extra_detail)
    if not result.ok:
        # 请求根本没跑成（网络不通/超时）：error 是比「断言没过」更高的事实层，
        # 这时再去判公共断言只会把一个「靶场没起」伪装成「质量门没过」。
        return StepOutcome("error", "请求失败：" + str(result.error), detail,
                           elapsed_ms=result.elapsed_ms)
    # T20b 公共断言（R88 业主裁定：作用在**每一个请求步骤**上，不是末步判一次）。
    # 三条口径：
    # ① 与这一步自己的断言**同一轮求值、同一套语义**——合并进 rows 之后 pass/fail、
    #    optional、fail_fast、通过率全部自动一致，不另开第二套判定（两套判定迟早对不上，
    #    同 §8.1 里「状态判定只在 _send 这一处」的既有纪律）；
    # ② 求值行打 scope="common" 标记随该步断言行落库，报告里能分辨「场景级门没过」
    #    还是「这步自己的断言没过」——两者原因与处置动作不同；
    # ③ run 级不再单独求值，所以通过率环与状态徽标天然一致（R86 那个观感矛盾随本次
    #    语义修正自然消失，不需要展示层补丁）。
    if ctx.common_assertions:
        # 用 result 原始字段构造 ResponseView，**不是**从 detail.response 那个 dict 反读：
        # _response_view 的键是 body / status，而 ResponseView 要 body_text / elapsed_ms，
        # 字段名对不上会让 evaluate 在每条断言里抛 AttributeError → 被 evaluate 兜底成
        # 「失败行」。那种红看着像「质量门没过」，实际是「求值器压根没跑起来」。
        # result.headers 已小写（execution.core），与 evaluate 的 header_exists 口径一致。
        # ok=True 蕴含「收到响应」→ status 必非 None（execution/core 只在网络失败时
        # 给 ok=False + status=None）。类型上看不出来，那就显式挡一道：真出现
        # ok=True 且无状态码，是执行核自相矛盾，宁可炸在这里，也不给断言喂一个
        # 假的 0——那会被渲染成「状态码断言没过」的假红。
        assert result.status is not None, "ok=True 却没有状态码：执行核自相矛盾"
        common_rows = evaluate(
            ctx.common_assertions,
            ResponseView(status=result.status, headers=dict(result.headers),
                         body_text=result.body_text, elapsed_ms=result.elapsed_ms),
            variables=ctx.vars)
        rows = rows + [{**r, "scope": "common"} for r in common_rows]
        detail["assertions"] = rows
        # 判定用的**配置**也随这一步落库（不只是求值行）：run_step_result.detail 本来就是
        # 「这一步凭什么这么判」的自包含快照（§8.3 单步重跑靠它重建请求与响应）。
        # 只存结果行不够——结果行只有 type/path/expected/actual，script 断言的 code 正文
        # 不在里面，重跑时按结果行重建会得到一条「未知断言/缺正文」的假红。
        # 场景 purge 后重跑仍要按**当时那份门**判，所以不能回头读 scenario 行。
        detail["common_assertions"] = [dict(a) for a in ctx.common_assertions]
    if all(r.get("passed") for r in rows):
        # （result.ok 已在上面判过；rows 含「这步自己的断言 + 公共断言」，一处判定）
        head = (subject + "：" if subject else "") + _describe_assertions(rows)
        return StepOutcome("pass", head, detail, elapsed_ms=result.elapsed_ms)
    return StepOutcome("fail", _describe_assertions(rows), detail,
                       elapsed_ms=result.elapsed_ms)


async def h_http_direct(node: Mapping, ctx: ExecutionContext, *, run_children,
                        in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """HTTP 直连：一次性的临时请求，不落接口资产（画布上顺手加一步校验请求）。"""
    key = _key_of(node)
    cfg = _cfg(node)
    if not cfg.get("url"):
        msg = "HTTP 直连步骤缺少 url：请在步骤配置里填写完整地址"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    req = _apply_headers(_build_request(cfg, ctx), ctx)
    return await _send(ctx, key, req)


async def _resolve_case(ctx: ExecutionContext, case_id: str) -> dict:
    """经注册表取「用例有效请求」（R44：引擎不 import 接口领域模块，也不复用 api_debug）。

    与界面共用同一个 merge_request，所以「界面看到的」与「实际跑掉的」不可能分叉。
    """
    spec = REGISTRY.get("api_case_resolve")
    if spec is None:
        raise ApiError("internal_error", "api_case_resolve 未注册（服务尚未初始化完成）", 500)
    sctx = ctx_from_actor(ctx.actor, ctx.db)
    out = await spec.handler(spec.model.model_validate({"project_id": ctx.project_id,
                                                        "case_id": case_id}), sctx)
    return dict(out.model_dump())


async def h_api_case(node: Mapping, ctx: ExecutionContext, *, run_children,
                     in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """接口用例步骤：resolve → 渲染 → 发送 → 断言 → 更新 last_response。"""
    key = _key_of(node)
    case_id = str(node.get("ref") or "")
    if not case_id:
        msg = "接口用例步骤没有引用具体用例：请在画布上选择一个用例"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    if not (ctx.actor or {}).get("user_id"):
        # 系统触发（定时/webhook）没有可用发起人：这是配置缺失，与「有身份但没权限」
        # 是两回事。合并成一句「没权限」会让定时任务全红时完全查不出原因。
        msg = ("缺少发起人身份：场景由系统触发时需要有归属人才能读取接口用例与环境配置，"
               "请检查场景归属人是否仍存在")
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    try:
        resolved = await _resolve_case(ctx, case_id)
    except ApiError as e:
        # ApiError 不许抛穿 runner：一个失效引用会毁掉整条 run，报告里还只剩一个 404
        msg = "接口用例不可用：" + e.message
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    if not resolved.get("executable") or not resolved.get("request"):
        msg = "接口用例不可执行：" + str(resolved.get("reason") or "无法确定请求地址")
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    req = dict(resolved["request"])
    # resolve 已把「定义断言 + 用例断言」追加进 request["assertions"]；顶层 assertions
    # 是同一份的副本。只交给 run_api 评估一次，重复传会得到双份断言行（报告翻倍）。
    req.setdefault("assertions", resolved.get("assertions") or [])
    if not resolved.get("timeout_explicit"):
        req["timeout_ms"] = ctx.timeout_ms
    req = _apply_headers(req, ctx)
    name = str(resolved.get("case_name") or node.get("name") or "用例")
    return await _send(ctx, key, req, subject=name,
                       extra_detail={"case_id": case_id, "case_name": name})


async def _resolve_ui_case(ctx: ExecutionContext, case_id: str) -> dict:
    """经注册表取 UI 用例的有效执行形态（与 _resolve_case 同族：引擎不 import UI 领域模块）。"""
    spec = REGISTRY.get("ui_case_resolve")
    if spec is None:
        raise ApiError("internal_error", "ui_case_resolve 未注册（服务尚未初始化完成）", 500)
    sctx = ctx_from_actor(ctx.actor, ctx.db)
    out = await spec.handler(spec.model.model_validate({"project_id": ctx.project_id,
                                                        "case_id": case_id}), sctx)
    return dict(out.model_dump())


def _ui_status(result: Any, *, started: bool) -> tuple[str, str]:
    """UiResult → 步骤层状态（pass/fail/error/cancelled）。

    判定尺子与 T9 的 debug_services._run_status 同序（cancelled > error > fail > pass），
    只是落在步骤层词表上：两层各说各的话，但顺序不一致会让「取消的 UI 步骤」在一边
    显示灰、在另一边冒成红。started=False 连浏览器都没起来 = 没跑成 = error。
    """
    rows = result.commands or []
    if any(r.get("status") == "cancelled" for r in rows):
        return "cancelled", "运行已被取消"
    if not started:
        return "error", str(result.error or "执行核异常")[:280]
    bad = next((r for r in rows if r.get("status") == "error"), None)
    if bad is not None:
        return "error", ("命令 " + str(bad.get("id")) + " 未执行完成："
                         + str(bad.get("message") or "命令异常"))[:280]
    if not result.passed:
        bad = next((r for r in rows if r.get("status") == "fail"), None)
        if bad is not None:
            return "fail", ("命令 " + str(bad.get("id")) + " 判定未通过："
                            + str(bad.get("message") or "断言不成立"))[:280]
        return "fail", "断言未通过"
    return "pass", str(len(rows)) + " 条命令全部通过"


async def h_ui_case(node: Mapping, ctx: ExecutionContext, *, run_children,
                    in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """UI 用例步骤（1C）：resolve → execution.ui_core.run_ui → 折成 StepOutcome。

    与 h_api_case 同骨架（ref/身份/不可执行的三道 error 防御同口径），差别在结论折法：
    - 断言全过 → pass，断言没过 → fail，没跑成 → error（两色纪律同 ui_core 模块头）；
    - vars 增量 = run_ui 出参里**新出现或变化**的键（驱动器把入参变量整个打底带回，
      原样交回会让 dispatch 把打底也算成「这一步改的」，审计就废了）；
    - 制品：blob 走 StepOutcome.artifacts 交 runner 的 persist 落盘，detail 里只留摘要
      （bytes 进 JSON 列 = 绑参时 TypeError，offload_detail 不会替我们剥它）。
    """
    from app.core.config import get_settings

    # 延迟 import：ui_core 顶层 import playwright（驱动器内部还有二次惰性），
    # 「后端没装浏览器」绝不能表现为「场景引擎 import 不起来」（R95）。
    from app.modules.execution.ui_core import run_ui

    key = _key_of(node)
    case_id = str(node.get("ref") or "")
    if not case_id:
        msg = "UI 用例步骤没有引用具体用例：请在画布上选择一个 UI 用例"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    if not (ctx.actor or {}).get("user_id"):
        # 与 api_case 同一句话的理由：系统触发没有可用发起人，「没身份」与「没权限」
        # 是两回事，合并成一句会让定时任务全红时完全查不出原因。
        msg = ("缺少发起人身份：场景由系统触发时需要有归属人才能读取 UI 用例与环境配置，"
               "请检查场景归属人是否仍存在")
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    try:
        resolved = await _resolve_ui_case(ctx, case_id)
    except ApiError as e:
        msg = "UI 用例不可用：" + e.message
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    if not resolved.get("executable"):
        msg = "UI 用例不可执行：" + str(resolved.get("reason") or "无法确定执行形态")
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    settings = get_settings()
    input_vars = dict(ctx.vars)
    # base_url 与命令里的 ${base_url} 必须同源（R105/D3）：命令由 run_ui 按本层变量渲染，
    # 驱动器的相对 open 前缀却吃 base_url 参数——两个来源会在「场景临时换了运行环境」时
    # 劈叉成「命令拼出来是 A 站、前缀指 B 站」。运行期变量层（ctx.vars）优先，
    # 用例自己环境里解析出的 base_url 兜底（与 resolve 的可执行判定口径兼容）。
    base_url = ctx.vars.get("base_url") or resolved.get("base_url")
    t0 = time.perf_counter()
    result = await run_ui(
        list(resolved.get("commands") or []),
        elements=dict(resolved.get("elements") or {}),
        variables=input_vars,
        base_url=base_url,
        headless=settings.ui_headless,
        browser_channel=settings.ui_browser_channel,
        timeout_ms=settings.ui_command_timeout_ms,
        should_cancel=lambda: is_cancelled(ctx.bus, ctx.run_id))
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    started = bool(result.ok)
    status, message = _ui_status(result, started=started)
    name = str(resolved.get("case_name") or node.get("name") or "UI 用例")

    # 制品：blob → StepOutcome.artifacts（runner 落盘），detail 只留摘要（无 blob）。
    # step_key 用**画布步骤 key**（report_get 的制品按 run 步骤对得上号），命令 id 留在
    # command 键里保 provenance；摘要形状（kind/step_key/bytes）与 T9 的 art_refs 同族。
    artifacts: list[dict] = []
    summaries: list[dict] = []
    for a in result.artifacts or []:
        blob = a.get("blob") or b""
        artifacts.append({"kind": str(a.get("kind") or "SCREENSHOT"), "blob": blob,
                          "step_key": key, "command": str(a.get("step_id") or ""),
                          "reason": a.get("reason")})
        summaries.append({"kind": str(a.get("kind") or "SCREENSHOT"), "step_key": key,
                          "command": str(a.get("step_id") or ""), "bytes": len(blob),
                          "reason": a.get("reason")})

    # response：UI 步没有 HTTP 响应，这里放的是**占位，不是假状态码**——
    # runner 的单步重跑（runner.py 的 detail.response 读取）靠这个键存在而不去
    # _fallback_response 找邻居步骤（邻居是 api 步，把它的响应冒充成 UI 步的更糟）。
    detail = _detail(ctx, key=key, request={"case_id": case_id, "case_name": name,
                                            "commands": len(result.commands or [])},
                     response={"status": None, "body": None},
                     assertions=[a for c in (result.commands or [])
                                 for a in (c.get("assertions") or [])],
                     error=result.error)
    detail["commands"] = result.commands or []
    detail["artifacts"] = summaries
    detail["case_id"] = case_id
    detail["case_name"] = name

    new_vars = {k: v for k, v in (result.vars or {}).items()
                if k not in input_vars or input_vars[k] != v}
    return StepOutcome(status, message, detail, vars=new_vars,
                       elapsed_ms=elapsed_ms, artifacts=artifacts)


# —— adb_case（1D T8）：执行经 adb_test 的引擎入口，不在这里另起执行体 ——————————————


async def _resolve_adb_case(ctx: ExecutionContext, case_id: str,
                            cfg: Mapping | None = None) -> dict:
    """经注册表取 ADB 用例的有效执行形态（与 _resolve_case/_resolve_ui_case 同族）。

    画布那一步的设备策略一并带下去：预检与执行必须用同一把尺（否则面板上选了台不
    存在的设备，预检说「可以跑」、执行时才红，那才是真吓人的第 7 步才报错）。
    """
    spec = REGISTRY.get("adb_case_resolve")
    if spec is None:
        raise ApiError("internal_error", "adb_case_resolve 未注册（服务尚未初始化完成）", 500)
    sctx = ctx_from_actor(ctx.actor, ctx.db)
    out = await spec.handler(spec.model.model_validate({
        "project_id": ctx.project_id, "case_id": case_id,
        "device_policy": _adb_device_policy(cfg)[0],
        "device_serial": _adb_device_policy(cfg)[1]}), sctx)
    return dict(out.model_dump())


def _adb_device_policy(cfg: Mapping | None) -> tuple[str | None, str | None]:
    """从节点 config 里取设备策略（PropsPanel 存的两个键，§11.4.12）。

    没配 = (None, None) = 不覆盖用例自己的 default_device。这里不校验取值：校验住在
    adb_test 的 `_step_device`（一把尺子），残缺会在 resolve 那道变成点名到原因的
    「这一步没有设备可跑」，而不是引擎里长出的第二套判断。
    """
    c = cfg if isinstance(cfg, Mapping) else {}
    policy = c.get("device_policy")
    serial = c.get("device_serial")
    return ((policy.strip() if isinstance(policy, str) and policy.strip() else None),
            (serial.strip() if isinstance(serial, str) and serial.strip() else None))


async def _adb_engine_run(ctx: ExecutionContext, case_id: str,
                          cfg: Mapping | None = None) -> dict:
    """经注册表跑一步 adb_case：真正执行在 adb_test 的 `adb_case_engine_run`，
    它进程内 await R102 那份唯一执行体（R145）。引擎不 import adb_test——与 ui_case
    走 `ui_case_resolve`/`ui_core.run_ui` 同一族间接层。

    engine_vars 带 ctx.vars 快照：设备策略在执行体里按 trigger=manual 分流（场景档
    可排队、debug 永不排队），取消由服务端把 cancel.<场景 run> 翻译成 cancel.<adb run>。
    """
    spec = REGISTRY.get("adb_case_engine_run")
    if spec is None:
        raise ApiError("internal_error", "adb_case_engine_run 未注册（服务尚未初始化完成）", 500)
    sctx = ctx_from_actor(ctx.actor, ctx.db)
    policy, serial = _adb_device_policy(cfg)
    out = await spec.handler(spec.model.model_validate({
        "project_id": ctx.project_id, "case_id": case_id,
        "engine_run_id": ctx.run_id, "engine_vars": dict(ctx.vars),
        "device_policy": policy, "device_serial": serial}), sctx)
    return dict(out.model_dump())


# run_record 终态词 → 步骤层词（_ui_status 同款两词表桥；adb 侧执行体已按
# cancelled > error > failed > passed 判好，这里只翻译不重判——两层各判一次迟早对不上）。
_ADB_RUN_STATUS = {"passed": "pass", "failed": "fail", "error": "error",
                   "cancelled": "cancelled"}


def _adb_step_status(outcome: dict, rows: list) -> tuple[str, str]:
    """引擎入口出参 → (步骤状态, message)。尺子与 _ui_status 同序（cancelled >
    error行 > fail > pass），只是判定在执行体做过一次，这里对逐行结论只取首因。"""
    status = _ADB_RUN_STATUS.get(str(outcome.get("status") or ""), "error")
    if status == "cancelled":
        return "cancelled", "运行已被取消"
    if status == "error":
        return "error", str(outcome.get("error") or "ADB 执行体异常")[:280]
    bad = next((r for r in rows if r.get("status") == "error"), None)
    if bad is not None:
        # run 判 pass/fail 但行里藏着 error 行：run_status 判定优先于行级——
        # 理论到不了（执行体两层同判），到了说明两层对不上，按最高事实层报
        return "error", ("命令 " + str(bad.get("id")) + " 未执行完成："
                         + str(bad.get("message") or "命令异常"))[:280]
    if status == "failed":
        bad = next((r for r in rows if r.get("status") == "fail"), None)
        if bad is not None:
            return "fail", ("命令 " + str(bad.get("id")) + " 判定未通过："
                            + str(bad.get("message") or "断言不成立"))[:280]
        return "fail", "断言未通过"
    return "pass", str(len(rows)) + " 条命令全部通过"


async def h_adb_case(node: Mapping, ctx: ExecutionContext, *, run_children,
                     in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """ADB 用例步骤（1D T8）：resolve 预检 → `adb_case_engine_run`（内部件，R102 同源）
    → 折成 StepOutcome。

    与 h_ui_case 同骨架（ref/身份/不可执行三道 error 防御同口径），差别在两处：
    - 执行不在本文件调执行核——adb 的「执行核入口」含设备锁/排队/租约，是 adb_test
      的领域知识，经 `adb_case_engine_run` 整段复用（R145：引擎里长出第二份设备策略
      等于给 R102 挖坑）；
    - vars 增量：执行体把入参变量打底带回（与 run_ui 同款语义），原样交回会把打底
      算成「这一步改的」——同样只交新值/变化值。
    制品：执行体已把 blob 落成 run_artifact（返回的是带 ref 的摘要），所以这里没有
    StepOutcome.artifacts 通道——blob 不经过引擎，detail 直接收摘要（含 ref，报告页
    按 ref 走 /artifacts 下载，与 UI 步的本地落盘殊途同归）。
    """
    key = _key_of(node)
    case_id = str(node.get("ref") or "")
    if not case_id:
        msg = "ADB 用例步骤没有引用具体用例：请在画布上选择一个 ADB 用例"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    if not (ctx.actor or {}).get("user_id"):
        # 与 api/ui 同一句话的理由：系统触发没有可用发起人，「没身份」与「没权限」
        # 是两回事，合并成一句会让定时任务全红时完全查不出原因。
        msg = ("缺少发起人身份：场景由系统触发时需要有归属人才能读取 ADB 用例与设备配置，"
               "请检查场景归属人是否仍存在")
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    try:
        resolved = await _resolve_adb_case(ctx, case_id, node.get("config"))
    except ApiError as e:
        # 腐坏引用（删除/回收/换项目）= error 且点名，绝不静默跳过（假绿比红危险）
        msg = "ADB 用例不可用：" + e.message
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    if not resolved.get("executable"):
        msg = "ADB 用例不可执行：" + str(resolved.get("reason") or "无法确定执行形态")
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    name = str(resolved.get("case_name") or node.get("name") or "ADB 用例")
    try:
        out = await _adb_engine_run(ctx, case_id, node.get("config"))
    except ApiError as e:
        msg = "ADB 步骤执行失败：" + e.message
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    rows = list(out.get("commands") or [])
    status, message = _adb_step_status(out, rows)
    input_vars = dict(ctx.vars)
    result_vars = {str(k): str(v) for k, v in (out.get("vars") or {}).items()}
    new_vars = {k: v for k, v in result_vars.items()
                if k not in input_vars or input_vars[k] != v}
    # 队列痕迹（D17 只显真实位次）：场景内设备被占是排队不是失败，位次进 detail 可见
    queued = list(out.get("queued") or [])
    # response 占位与 UI 步同理由（单步重跑不许去邻居步找响应冒充）
    detail = _detail(ctx, key=key, request={"case_id": case_id, "case_name": name,
                                            "commands": len(rows)},
                     response={"status": None, "body": None},
                     assertions=[a for c in rows for a in (c.get("assertions") or [])],
                     error=out.get("error"))
    detail["commands"] = rows
    detail["artifacts"] = list(out.get("artifacts") or [])
    detail["case_id"] = case_id
    detail["case_name"] = name
    detail["adb_run_id"] = out.get("run_id")
    detail["mode"] = out.get("mode")      # 降级看得见（T6 交接，同一把尺）
    detail["device"] = out.get("device")
    if queued:
        detail["device_queued"] = queued
    return StepOutcome(status, message, detail, vars=new_vars,
                       elapsed_ms=int(out.get("elapsed_ms") or 0))


# —— sleep：取消要落在长等待里（§8.2） ——————————————————


async def h_sleep(node: Mapping, ctx: ExecutionContext, *, run_children,
                  in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """按 SLEEP_SLICE_MS 切片睡眠，每片查一次取消旗标。

    一口气睡满 config.ms 的话，用户点「停止」要等到超时才生效，定时队列会被一个
    卡住的场景堵死。500ms 是「立刻生效」与「Redis 别被打爆」的折中。
    """
    key = _key_of(node)
    cfg = _cfg(node)
    ms = cfg.get("ms")
    if not isinstance(ms, int) or isinstance(ms, bool) or ms < 0:
        msg = "等待步骤的 ms 必须是非负整数，收到 " + repr(ms)
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    left = int(ms)
    t0 = time.perf_counter()
    while True:
        if await is_cancelled(ctx.bus, ctx.run_id):
            spent = int((time.perf_counter() - t0) * 1000)
            msg = "等待被取消：计划 " + str(ms) + "ms，实际等待 " + str(spent) + "ms"
            return StepOutcome("cancelled", msg,
                               _detail(ctx, key=key, request={"ms": ms}, error=msg),
                               elapsed_ms=spent)
        if left <= 0:
            break
        piece = min(left, SLEEP_SLICE_MS)
        await asyncio.sleep(piece / 1000.0)
        left -= piece
    spent = int((time.perf_counter() - t0) * 1000)
    return StepOutcome("pass", "等待 " + str(ms) + "ms",
                       _detail(ctx, key=key, request={"ms": ms}), elapsed_ms=spent)


# —— 变量与断言类步骤：set_var / extract / assert / script ——————————————


async def h_set_var(node: Mapping, ctx: ExecutionContext, *, run_children,
                    in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """写死若干变量（画布上的「设变量」）。值一律 str，与 T6 的 vars 口径一致。"""
    key = _key_of(node)
    cfg = _cfg(node)
    raw = cfg.get("vars")
    if not isinstance(raw, Mapping) or not raw:
        msg = "设变量步骤至少要设一个变量：config.vars 需为非空对象"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    # 值可能是 dict/list（Agent 直接生成），json.dumps 保中文，脚本里再 json.loads 回来
    new = {str(k): _stringify(v) for k, v in raw.items()}
    return StepOutcome("pass", "设了 " + str(len(new)) + " 个变量：" + "、".join(sorted(new)),
                       _detail(ctx, key=key, request={"vars": new}), vars=new)


def _as_doc(resp: Mapping) -> Any:
    """last_response 的 body → 可 jsonpath 的文档。不是 JSON 就明说，别静默给 None。"""
    body = resp.get("body")
    if body is None:
        return None
    if isinstance(body, (dict, list)):
        return body
    try:
        return json.loads(body)
    except (ValueError, TypeError):
        raise JsonPathMissing("响应体不是合法 JSON，无法按路径提取") from None


async def h_extract(node: Mapping, ctx: ExecutionContext, *, run_children,
                    in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """从上一步响应里提变量（§7.5）。取不到路径 = error 且点名是哪个表达式。

    刻意不做「取不到就当空串」的宽容：提取失败通常意味着上游接口换了字段，
    静默给空值会让后面每一步都拿着空 token 去跑，报错时报在第三步第四节。
    """
    key = _key_of(node)
    cfg = _cfg(node)
    rules = cfg.get("rules")
    if not isinstance(rules, list) or not rules:
        msg = "提取步骤至少要有一条规则：config.rules 需为含 var 与 expr 的数组"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    resp = ctx.last_response
    if resp is None:
        msg = "前面还没有任何响应：提取步骤必须排在某个接口步骤之后"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    new: dict[str, str] = {}
    rows: list[dict] = []
    for r in rules:
        if not isinstance(r, Mapping):
            msg = "提取规则必须是对象（含 var 与 expr），收到 " + repr(r)[:60]
            return StepOutcome("error", msg, _detail(ctx, key=key, assertions=rows, error=msg))
        var = str(r.get("var") or "")
        expr = r.get("expr")
        src = r.get("from")
        if not var:
            msg = "提取规则缺少 var（要写回变量表的什么名字）"
            return StepOutcome("error", msg, _detail(ctx, key=key, assertions=rows, error=msg))
        if src not in (None, "", "last_response"):
            # 只认 last_response：写了 header/cookies 就明说，别当成 jsonpath 悄悄跑
            msg = ("提取来源只支持 from=\"last_response\"，收到 " + repr(src)
                   + "：想校验响应头请用 assert 步骤的 header_exists 断言")
            return StepOutcome("error", msg, _detail(ctx, key=key, assertions=rows, error=msg))
        try:
            value = jsonpath_get(_as_doc(resp), str(expr))
        except JsonPathMissing as e:
            msg = "提取失败：变量 " + var + " 的表达式 " + str(expr) + " 取不到值（" + str(e) + "）"
            return StepOutcome("error", msg, _detail(ctx, key=key, assertions=rows, error=msg))
        new[var] = _stringify(value)
        rows.append({"var": var, "expr": str(expr), "value": new[var], "passed": True})
    return StepOutcome("pass", "提取到 " + str(len(new)) + " 个变量：" + "、".join(sorted(new)),
                       _detail(ctx, key=key, assertions=rows), vars=new)


async def h_assert(node: Mapping, ctx: ExecutionContext, *, run_children,
                   in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """对**上一步响应**补断言（§7.5）。断言引擎与 1A 调试共用同一份，不分叉。"""
    key = _key_of(node)
    cfg = _cfg(node)
    items = cfg.get("assertions")
    if not isinstance(items, list) or not items:
        msg = "断言步骤至少要有一条断言：config.assertions 需为数组"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    resp = ctx.last_response
    if resp is None:
        msg = "前面还没有任何响应：断言步骤必须排在某个接口步骤之后"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    view = ResponseView(status=int(resp.get("status") or 0),
                        headers=dict(resp.get("headers") or {}),
                        body_text=resp.get("body"),
                        elapsed_ms=int(resp.get("elapsed_ms") or 0))
    rows = evaluate(items, view, variables=ctx.vars)
    detail = _detail(ctx, key=key, response={"status": view.status, "headers": view.headers,
                                             "body": view.body_text,
                                             "elapsed_ms": view.elapsed_ms}, assertions=rows)
    if all(r.get("passed") for r in rows):
        return StepOutcome("pass", _describe_assertions(rows), detail)
    return StepOutcome("fail", _describe_assertions(rows), detail)


# 沙箱把断言失败也归一成 ok=False + "AssertionError: ..."。断言不成立是业务结论（fail），
# 脚本崩了才是执行异常（error），两者在报告页是两种红，只能靠这个前缀在这一处分开。
_ASSERT_PREFIX = "AssertionError: "


async def h_script(node: Mapping, ctx: ExecutionContext, *, run_children,
                   in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """脚本步骤（§8.5）：沙箱执行，vars 增量回写，log() 进 detail.logs。"""
    key = _key_of(node)
    cfg = _cfg(node)
    code = cfg.get("code")
    if not isinstance(code, str) or not code.strip():
        msg = "脚本步骤缺少正文：config.code 需为脚本字符串"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    res = run_script(code, ctx_vars=ctx.vars, last_response=ctx.last_response)
    for line in res.logs:
        ctx.log(key, line)
    if not res.ok:
        err = str(res.error)
        # 脚本失败时沙箱回的 vars 是干净的入参快照，所以这里**不**交回任何变量
        if err.startswith(_ASSERT_PREFIX):
            return StepOutcome("fail", "断言不成立：" + err[len(_ASSERT_PREFIX):],
                               _detail(ctx, key=key, error=err, script=code))
        return StepOutcome("error", "脚本执行失败：" + err,
                           _detail(ctx, key=key, error=err, script=code))
    new = {str(k): _stringify(v) for k, v in (res.vars or {}).items()}
    msg = "脚本执行通过" + ("（日志 " + str(len(res.logs)) + " 行）" if res.logs else "")
    if res.truncated:
        msg += "；日志超上限已截断（§8.5）"
    return StepOutcome("pass", msg, _detail(ctx, key=key, script=code), vars=new)


# —— 控制信号：break / continue ——————————————————————————


async def h_break(node: Mapping, ctx: ExecutionContext, *, run_children,
                  in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """break：只交出控制信号，本身不做任何事（真正消化它的是 loop / foreach）。"""
    return _control_outcome(node, "break", in_loop)


async def h_continue(node: Mapping, ctx: ExecutionContext, *, run_children,
                     in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    return _control_outcome(node, "continue", in_loop)


def _control_outcome(node: Mapping, signal: str, in_loop: bool) -> StepOutcome:
    word = "break（跳出循环）" if signal == "break" else "continue（进入下一轮）"
    # 控制信号本身不产生请求/响应，detail 里没有 ctx 可取的日志，故不走 _detail
    detail: dict[str, Any] = {"request": None, "response": None, "assertions": [], "logs": []}
    if not in_loop:
        # 保存期 T4 已拦一遍，这里是第二道：step_graph 也可能来自 Agent 生成或直接改库
        msg = word + " 出现在循环之外：只有 loop / foreach 的子树里才能用它"
        return StepOutcome("error", msg, {**detail, "error": msg})
    return StepOutcome("pass", word, detail, control=signal)



# —— 容器：if / loop / foreach / group ——————————————————


def _worst(outcomes: list[StepOutcome]) -> str:
    """容器状态：**容器自己没坏**的前提下，子步骤要么过、要么就是没过。

    子步骤的 error 到这里归并成 fail 是有意的：容器这一层的 error 只表示「容器自己
    跑不下去」（条件写坏、config 缺失），子步骤各自的 fail/error 原样留在自己的行里，
    报告页看细节、看汇总，两层各说各的话。把 error 直接冒上来会让「第 3 步网络不通」
    与「整个循环结构不对」在列表里长成一个样。
    """
    if any(o.status == "cancelled" for o in outcomes):
        return "cancelled"
    if any(o.status not in ("pass", "skip") for o in outcomes):
        return "fail"
    return "pass"


def _named_failure(outcomes: list[StepOutcome]) -> str:
    bad = next((o for o in outcomes if o.status not in ("pass", "skip")), None)
    if bad is None:
        return ""
    return "第 " + str(outcomes.index(bad) + 1) + " 个子步骤 " + str(bad.key or "?") + \
        " 未通过（" + bad.status + "）：" + str(bad.message or "")[:180]


def _branches_of(cfg: Mapping) -> list:
    br = cfg.get("branches")
    return [b for b in br] if isinstance(br, list) else []


def _is_else(cond: Any) -> bool:
    """画布上的「否则」存成 cond="else"（T4 的 empty_cond 校验同一口径）。"""
    return not (isinstance(cond, str) and cond.strip()) or cond.strip().lower() in ("else", "否则")


def _child_nodes(parent: Mapping) -> list:
    ch = parent.get("children")
    return [c for c in ch if isinstance(c, Mapping)] if isinstance(ch, list) else []


def _skip_child(child: Mapping, reason: str) -> StepOutcome:
    return StepOutcome("skip", reason, None, key=str(child.get("key") or "?"),
                       kind=str(child.get("kind") or ""))


async def h_if(node: Mapping, ctx: ExecutionContext, *, run_children,
               in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """if：按顺序求值分支，**命中第一个就停**；未命中分支的子节点标 skip 进结果。

    未命中也要出现在结果里是产品要求：报告页看不出「有条路没走」，就等于把分支执行
    伪装成直线执行。条件写坏按假处理（走 else）并把原因留在对应 skip 的 message 里，
    一个手滑的表达式不该毁掉已经跑完的二十步。
    """
    key = _key_of(node)
    cfg = _cfg(node)
    if _is_true(cfg.get("parallel_branches")):
        msg = "if 分支并发执行（config.parallel_branches）为二期能力（§7.4），一期不执行"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    branches = _branches_of(cfg)
    if not branches:
        msg = "if 步骤没有分支：config.branches 需为至少一个 {cond, children}"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    taken: int | None = None
    notes: dict[int, str] = {}
    for i, br in enumerate(branches):
        if not isinstance(br, Mapping):
            msg = "if 的第 " + str(i + 1) + " 个分支必须是对象，收到 " + repr(br)[:60]
            return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
        cond = br.get("cond")
        if _is_else(cond):
            taken = i
            break
        res = evaluate_condition(str(cond), ctx_vars=ctx.vars, last_response=ctx.last_response)
        if not res.ok:
            notes[i] = "分支条件求值失败，按不成立处理：" + str(res.error)[:200]
            continue
        if res.true_:
            taken = i
            break
    children: list[StepOutcome] = []
    control: str | None = None
    stopped = False
    for i, br in enumerate(branches):
        kids = _child_nodes(br) if isinstance(br, Mapping) else []
        if i == taken:
            sub = await run_children(kids, key, in_loop=in_loop)
            children.extend(sub.outcomes)
            control, stopped = sub.control, sub.stopped
        else:
            why = notes.get(i) or ("分支未命中" if taken is not None else "所有分支条件都不成立")
            children.extend(_skip_child(c, why) for c in kids)
    status = "cancelled" if any(o.status == "cancelled" for o in children) else \
        (_worst(children) if taken is not None else "pass")
    if taken is None:
        msg = "所有分支条件都不成立，未执行任何子步骤" + \
              ("（" + next(iter(notes.values())) + "）" if notes else "")
    else:
        branch_children = _child_nodes(branches[taken])
        msg = "走第 " + str(taken + 1) + " 个分支"
        if branch_children:
            msg += "，执行 " + str(len(branch_children)) + " 步"
        else:
            msg += "（该分支没有子步骤）"
        if notes:
            # 痕迹要留在**步骤**的 message 上，不能只留在 skip 行里：报告列表默认折叠子节点，
            # 用户先看到的是这一行。notes 的键是出错那个分支的下标，不是命中分支的下标，
            # 所以判「有没有」而不是「命中分支是不是它」——后者几乎永远不成立。
            msg += "；" + next(iter(notes.values()))
        bad = _named_failure([o for o in children if o.status not in ("skip",)])
        if bad and status != "pass":
            msg += "；" + bad
    return StepOutcome(status, msg, _detail(ctx, key=key), children=children,
                       control=control if stopped else None)


def _is_true(x: Any) -> bool:
    return x is True or (isinstance(x, str) and x.strip().lower() in ("1", "true", "yes"))


async def h_group(node: Mapping, ctx: ExecutionContext, *, run_children,
                  in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """group：一期只是串行容器（§7.4 明写并发是二期）。"""
    key = _key_of(node)
    cfg = _cfg(node)
    if _is_true(cfg.get("parallel")):
        # 静默按串行跑 = 用户以为并发了。宁可红着，也不给一个假的绿
        msg = "group 并发执行（config.parallel）为二期能力（§7.4），一期只作串行容器"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    kids = _child_nodes(node)
    sub = await run_children(kids, key, in_loop=in_loop)
    bad = _named_failure(sub.outcomes)
    status = _worst(sub.outcomes)
    msg = "分组内 " + str(len(kids)) + " 步串行执行"
    if bad and status != "pass":
        msg += "；" + bad
    return StepOutcome(status, msg, _detail(ctx, key=key), children=sub.outcomes,
                       control=sub.control if sub.stopped else None)


async def h_loop(node: Mapping, ctx: ExecutionContext, *, run_children,
                 in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """loop：count 跑满 max_iter；while **先判条件再跑**，max_iter 是死循环硬上限。

    子树里的 break/continue 在这里消化：break 立刻结束整个循环，continue 立刻结束本轮。
    控制信号从 run_children 的返回值里拿（它能藏在 if/group 的任意深度），容器自己不去
    递归扫子树 —— 加一层容器就漏一次的坑就是这么埋下的。
    """
    key = _key_of(node)
    cfg = _cfg(node)
    kids = _child_nodes(node)
    mode = str(cfg.get("mode") or "count")
    if mode not in ("count", "while"):
        msg = "loop 的 mode 只支持 count / while，收到 " + repr(cfg.get("mode"))
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    mx = cfg.get("max_iter")
    if not isinstance(mx, int) or isinstance(mx, bool) or mx <= 0:
        msg = "loop 必须有正整数 config.max_iter（防死循环的硬上限），收到 " + repr(mx)
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    cond = cfg.get("cond")
    if mode == "while" and not (isinstance(cond, str) and cond.strip()):
        msg = "loop 的 while 模式必须填 config.cond"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))

    outcomes: list[StepOutcome] = []
    iterations = 0
    control: str | None = None
    stopped = False
    note = ""
    for _round in range(mx):
        if mode == "while":
            res = evaluate_condition(str(cond), ctx_vars=ctx.vars, last_response=ctx.last_response)
            if not res.ok:
                # 条件本身求值失败：静默当假收工会把错误藏成「循环成功跑了 0 轮」
                msg = "循环条件求值失败：" + str(res.error)[:200]
                return StepOutcome("error", msg, _detail(ctx, key=key, error=msg),
                                   children=outcomes, iterations=iterations)
            if not res.true_:
                note = "条件不再成立，正常退出"
                break
        iterations += 1
        sub = await run_children(kids, key, in_loop=True)
        outcomes.extend(sub.outcomes)
        if sub.stopped:
            if sub.control == "break":
                control, stopped = None, False  # break 被循环消化掉了，不再向外层传
                note = "第 " + str(iterations) + " 轮遇到 break，提前结束循环"
                break
            if sub.control == "continue":
                control, stopped = None, False  # 同上：continue 只到本层循环为止
                continue
            control, stopped = sub.control, True  # cancel / fail_fast：循环管不了，交出去
            break
    else:
        if mode == "while":
            # for…else 落到这里 = 一轮都没 break ⇒ 上面 :991 的 `if not res.true_` 从未命中，
            # cond 在这 mx 轮里**每轮都成立**。旧文案「仍未等到条件成立」说的正好是反面，
            # 照它去查「条件为什么不成立」会南辕北辙——要查的是「为什么一直没停下来」。
            note = "已到 max_iter=" + str(mx) + " 上限：条件始终成立，循环被上限截停"
    status = _worst(outcomes)
    head = "循环执行 " + str(iterations) + " 轮"
    msg = head + ("；" + note if note else "")
    bad = _named_failure(outcomes)
    if bad and status != "pass":
        msg += "；" + bad
    return StepOutcome(status, msg, _detail(ctx, key=key), children=outcomes,
                       control=control if stopped else None, iterations=iterations)


def _resolve_list(cfg: Mapping, ctx: ExecutionContext, run_lists: Mapping | None) -> tuple[list | None, str | None]:
    """foreach 的数据源：先取 run_lists（真 list/dict），再回落 vars 里的 JSON 串。

    两条路都要：数据集行展开由 runner 直接喂真 list（§8.6），而 Agent 或脚本写的
    列表变量只能走 vars。两边都支持，用户不必猜「我该 JSON 化还是不该」。
    """
    name = str(cfg.get("list_var") or "")
    if not name:
        return None, "foreach 必须填 config.list_var（要遍历哪个变量）"
    if run_lists and name in run_lists:
        raw = run_lists[name]
    elif name in ctx.vars:
        raw = ctx.vars[name]
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return None, ("foreach 的列表变量 " + name + " 不是 JSON 数组，收到 "
                          + repr(ctx.vars[name])[:80])
    else:
        return None, "foreach 找不到列表变量 " + name + "：请先在上游提取或设值"
    if not isinstance(raw, list):
        # 含 dict 情形：不替它发明「按值遍历还是按键遍历」的语义。猜错的 foreach
        # 会安静地少跑几行，比一句「必须是数组」难查一个数量级。
        return None, ("foreach 的列表变量 " + name + " 必须是数组，收到 " + type(raw).__name__
                      + "：字典请先在上游转成数组（script 步骤里 list(d.values())）")
    return raw, None



async def h_foreach(node: Mapping, ctx: ExecutionContext, *, run_children,
                    in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """foreach：逐行把 item_var 写进 ctx.vars 再跑子树（§7.4 + §8.6 的数据驱动入口）。

    这是容器**唯一**直接写 ctx.vars 的地方，也是本模块「handler 不写变量表」那条规矩
    的例外：子节点在 run_children 里就要看到本行的值，等返回值合并就晚了。
    """
    key = _key_of(node)
    cfg = _cfg(node)
    item_var = str(cfg.get("item_var") or "")
    if not item_var:
        msg = "foreach 必须填 config.item_var（每行的值写进哪个变量）"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg))
    rows, err = _resolve_list(cfg, ctx, run_lists)
    if err:
        return StepOutcome("error", err, _detail(ctx, key=key, error=err))
    assert rows is not None
    outcomes: list[StepOutcome] = []
    iterations = 0
    kids = _child_nodes(node)
    for row in rows:
        ctx.vars[item_var] = _stringify(row)  # 作用域预置：本轮子树必须看得见它
        iterations += 1
        sub = await run_children(kids, key, in_loop=True)
        outcomes.extend(sub.outcomes)
        if sub.stopped and sub.control == "break":
            break
        if sub.stopped and sub.control == "continue":
            continue
        if sub.stopped:
            # cancel / fail_fast：循环管不了，原样交出去（内层循环的 break/continue
            # 在上面已经消化掉，不会走到这里）
            return StepOutcome(_worst(outcomes), "foreach 提前中断",
                               _detail(ctx, key=key), children=outcomes,
                               control=sub.control, iterations=iterations)
    msg = "遍历 " + str(iterations) + " 行" + ("" if rows else "（列表为空，未执行任何子步骤）")
    bad = _named_failure(outcomes)
    status = _worst(outcomes)
    if bad and status != "pass":
        msg += "；" + bad
    return StepOutcome(status, msg, _detail(ctx, key=key), children=outcomes, iterations=iterations)


# —— 注册表与分发 ——————————————————————————————————

HANDLERS: dict = {
    "api_case": h_api_case,
    "ui_case": h_ui_case,
    "adb_case": h_adb_case,
    "http_direct": h_http_direct,
    "sleep": h_sleep,
    "loop": h_loop,
    "if": h_if,
    "foreach": h_foreach,
    "break": h_break,
    "continue": h_continue,
    "script": h_script,
    "extract": h_extract,
    "assert": h_assert,
    "set_var": h_set_var,
    "group": h_group,
}
# 15/15 个 kind 全部注册（1B 的 13 个 + 1C 的 ui_case + 1D T8 的 adb_case）。
# PENDING_KINDS 清空但 dispatch 的闸保留——它是未来批次「未注册 kind 说清几期开放」的机制。


async def dispatch(node: Mapping, ctx: ExecutionContext, *, run_children,
                   in_loop: bool = False, run_lists: Mapping | None = None) -> StepOutcome:
    """按 kind 查表执行一个节点，并把结论归一成 StepOutcome。

    三道防御都在这一处，因为它们对每个 kind 都成立：
    ① disable=true → skip，绝不发请求（画布上灰掉的步骤不该真的打目标系统）；
    ② 未注册 kind → error 并说清几期开放，不静默跳过（假绿比红危险）；
    ③ handler 抛任何异常 → error，**绝不抛穿 runner**：一个 handler 的意外 bug
       不该把已经跑完的二十步和它们的明细全部丢掉。
    """
    if not isinstance(node, Mapping):
        return StepOutcome("error", "步骤必须是对象，收到 " + type(node).__name__, None)
    key = _key_of(node)
    kind = str(node.get("kind") or "")
    if node.get("disable") is True or _is_true(node.get("disable")):
        return StepOutcome("skip", "步骤已停用（disable=true），未执行",
                           {"request": None, "response": None, "assertions": [], "logs": []},
                           key=key, kind=kind)
    if kind in PENDING_KINDS:
        msg = ("该步骤类型 " + kind + " 要到 " + PENDING_KINDS[kind] + " 才能执行："
               "现在跑等于什么都没测，因此判为失败而不是跳过")
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg), key=key, kind=kind)
    fn = HANDLERS.get(kind)
    if fn is None:
        msg = "未知的步骤类型：" + repr(kind) + "（一期白名单见 §7.4）"
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg), key=key, kind=kind)
    try:
        out = await fn(node, ctx, run_children=run_children, in_loop=in_loop, run_lists=run_lists)
    except Exception as e:  # noqa: BLE001 执行期必须吸收一切意外，见 docstring ③
        msg = "步骤执行异常：" + type(e).__name__ + ": " + str(e)[:200]
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg), key=key, kind=kind)
    if not isinstance(out, StepOutcome):
        msg = "handler 返回类型不对（应为 StepOutcome），收到 " + type(out).__name__
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg), key=key, kind=kind)
    if out.key is None:
        out.key = key
    if out.kind is None:
        out.kind = kind
    if out.status not in STATUS:
        msg = "handler 返回了未知状态 " + repr(out.status)
        return StepOutcome("error", msg, _detail(ctx, key=key, error=msg), key=key, kind=kind)
    # vars 由 dispatch 单点合并进上下文（handler 只交出增量，可审计，见模块 docstring）
    if out.vars:
        ctx.vars.update(out.vars)
    return out


def make_runner(ctx: ExecutionContext, *, fail_fast: bool = True):
    """造一个 run_children：按顺序跑一组兄弟节点，边界检查取消，聚合出 BranchResult。

    这是 runner（T8）与本模块的接缝，也是「每步边界查取消与超时」那个检查点本身，
    所以容器与 T8 共用同一份实现，不各写一套循环（两套循环迟早对不上）。

    fail_fast=True：首个非 optional 的子步骤没过就中断（其余不再跑，由调用方标 skip）；
    optional=true 的节点失败继续往下走 —— 「这步挂了不影响后面」是画布上的真实诉求。
    """

    _default_fail_fast = fail_fast  # 工厂参数：闭包里要读它，不能被同名内层参数遮蔽

    async def run_children(nodes: list, parent_key: str | None = None, *,
                           in_loop: bool = False, run_lists: Mapping | None = None,
                           fail_fast: bool | None = None) -> BranchResult:
        stop_fast = fail_fast if fail_fast is not None else _default_fail_fast
        outcomes: list[StepOutcome] = []
        for child in nodes or []:
            if await is_cancelled(ctx.bus, ctx.run_id):
                outcomes.append(StepOutcome("cancelled", "运行已被取消，后续步骤未执行", None,
                                            key=str((child or {}).get("key") or "?")
                                            if isinstance(child, Mapping) else "?"))
                return BranchResult("cancelled", True, outcomes, None)
            out = await dispatch(child, ctx, run_children=run_children,
                                 in_loop=in_loop, run_lists=run_lists)
            outcomes.append(out)
            optional = _is_true(child.get("optional")) if isinstance(child, Mapping) else False
            if out.status == "cancelled":
                return BranchResult("cancelled", True, outcomes, None)
            if out.control in ("break", "continue"):
                return BranchResult(out.status, True, outcomes, out.control)
            if stop_fast and not optional and out.status not in ("pass", "skip"):
                return BranchResult(out.status, True, outcomes, None)
        return BranchResult(_worst(outcomes), False, outcomes, None)

    return run_children


__all__ = ["BranchResult", "HANDLERS", "PENDING_KINDS",
           "SLEEP_SLICE_MS", "STATUS", "StepOutcome", "dispatch", "make_runner"]



