"""@service 装饰器：一次标注 → HTTP 路由 / OpenAPI / 工具 schema / 权限位 / 审计。"""
from __future__ import annotations

import inspect
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, get_args, get_origin, get_type_hints

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError, Page
from app.core.registry import REGISTRY, ToolSpec

Effect = Literal["read", "write", "destructive"]

# 入口词表（§4 audit_log.entry）：写进审计表、前端按它上色与筛选。
# "schedule" 自 1E T1 起有真写入者（worker 的 schedule.fire：entry=schedule、
# user_id NULL，R144——旧注释「二期定时任务才会写入」过期，同批摘除）。词表比
# 当前写入者宽是安全的，窄了会让未来的写入变成界面上的裸字符串。
Entry = Literal["http", "agent", "schedule"]
_ENTRIES: tuple[str, ...] = ("http", "agent", "schedule")

# service 的合法返回：一个响应模型，或一页响应模型。
# 以前列表类 service 全标注成 `-> BaseModel` 然后 return Page(...)——Page 是 dataclass
# 不是 BaseModel，mypy 逮到 13 处。写 BaseModel 的人是在**照抄邻居**，不是以为 Page 是
# 模型；标错的成本比不标更低，所以这里给出一个能照抄的对的名字，而不是把 13 处各
# 自 cast 一下。_add_route 只对 isinstance(ret, type) 且是 BaseModel 子类的答案挂
# response_model，所以本联合类型进 OpenAPI 的结果与之前完全一致（列表仍是裸 dict 形状）。
ServiceResult = BaseModel | Page[Any]


@dataclass
class ServiceCtx:
    """service 执行上下文：入口、当前用户、会话、项目权限集合。"""

    # db 排在带默认值的字段之前 = 必填：全仓 14 处构造点（含 tests）一律带 db，
    # 而把它标成 AsyncSession | None 让**每一个**读 ctx.db 的 service 都要先
    # `assert ctx.db is not None`（agent/routes.py 因此 17 处报 union-attr）。
    # 没有一处依赖 db=None 这个状态，它就是被「可能没有库」的想象写出来的。
    entry: Entry
    user_id: str
    db: AsyncSession
    user_name: str = ""
    is_system_admin: bool = False
    perms: set[str] = field(default_factory=set)
    session_id: str | None = None  # agent 入口时的会话 id（审计关联）

    def require(self, perm: str) -> None:
        from app.core.permissions import match_perm

        if not match_perm(self.perms, perm):
            # D38 还债：缺的位名进 details.perm（契约字段），不许再靠正则匹配中文 message。
            # 注册表路由的权限拒绝全部汇到这一个抛错点，所以字段只在这里塞一次。
            raise ApiError("insufficient_permission", "缺少权限：" + perm, 403, {"perm": perm})


def service(
    *,
    perm: str,
    effect: Effect,
    name: str,
    description: str,
    http: dict[str, Any] | None | object = ...,
    tool: bool = True,
    resident: bool = False,
    dynamic_perm: bool = False,
) -> Callable:
    """装饰 service 函数：函数签名必须是 (payload: BaseModel, ctx: ServiceCtx) -> BaseModel。

    http 省略 → 默认 POST /{name}；http=None → 不生成 HTTP 路由（仅工具/内部）。
    dynamic_perm（D164）→ 静态 perm 仅投影占位，路由/工具派发跳过静态门，鉴权唯一体内 ctx.require。
    """
    if ":" not in perm:
        raise ValueError(f"perm 必须是 module:action 形式：{perm}")

    def deco(fn: Callable[..., Awaitable[Any]]):
        sig = inspect.signature(fn)
        params = list(sig.parameters.values())
        if len(params) < 2:
            raise ValueError(f"service 函数必须声明 (payload, ctx)：{name}")
        try:
            hints = get_type_hints(fn)
        except Exception:  # pragma: no cover
            hints = {}
        model = hints.get(params[0].name, params[0].annotation)
        if not (isinstance(model, type) and issubclass(model, BaseModel)):
            raise ValueError(f"service payload 必须是 Pydantic 模型：{name}")
        http_conf: dict[str, Any] | None
        if http is ...:
            http_conf = {"method": "POST", "path": "/" + name, "tags": [perm.split(":")[0]], "status": 200}
        else:
            http_conf = http  # type: ignore[assignment]
        schema = model.model_json_schema()
        spec = ToolSpec(
            name=name,
            description=description,
            json_schema=schema,
            perm=perm,
            effect=effect,
            handler=fn,
            model=model,
            tool=tool,
            resident=resident,
            http=http_conf,
            dynamic_perm=dynamic_perm,
        )
        REGISTRY.register(spec)
        fn.__service__ = spec  # type: ignore[attr-defined]
        return fn

    return deco


# —— 权限解析钩子：core 不 import modules（import-linter），由组装层注入 ——
PermsResolver = Callable[[AsyncSession, str, bool, str], Awaitable[set[str] | None]]
_perms_resolver: PermsResolver | None = None


def set_perms_resolver(fn: PermsResolver) -> None:
    """组装层（main/bootstrap）注入：(db, user_id, is_system_admin, project_id) -> perms|None。

    返回 None 表示「不可见」（非成员或项目不存在，调用方统一 403 forbidden）。
    """
    global _perms_resolver
    _perms_resolver = fn


_audit_writer = None


def set_audit_writer(fn) -> None:
    """审计写入口注入（core 不 import modules；组装层接 audit.services.record）。"""
    global _audit_writer
    _audit_writer = fn


async def _http_audit(db, *, user_id, action, target, ok, diff=None, entry: Entry = "http") -> None:
    if _audit_writer is None:  # pragma: no cover
        return
    await _audit_writer(db, user_id=user_id, entry=entry, action=action, target=target, ok=ok, diff=diff)


async def write_audit(db, *, user_id, action, target, ok=True, diff=None, entry: Entry = "http") -> None:
    """service 体内补记审计的公开口（1E T4 导入覆盖 diff 用）。

    为什么要有：模块间不许 import audit（契约 1 白纸黑字），而有些 diff（如批量导入
    逐条 before/after）只在 service 体内凑得齐，装饰器层的 produced 摘要装不下。
    走的仍是 set_audit_writer 注入的同一个写入口——core 不认识 audit，只调钩子。
    entry 参数（1E T1 / R144）：定时触发（schedule.fire）是机器动作，落 entry=schedule、
    user_id NULL——审计记人，机器流水另说，但「到点投了什么」必须在审计里可查。
    """
    await _http_audit(db, user_id=user_id, action=action, target=target, ok=ok, diff=diff, entry=entry)


# —— run 终态钩子（1E T3）：core 不认识 notify，形状与 set_audit_writer 完全同款 ——
_run_finalized_hook = None


def set_run_finalized_hook(fn) -> None:
    """run 终态钩子注入（1E T3；组装层 main.create_app 接 notify.hooks.on_run_finalized）。

    挂载点唯一：scenario.engine.runner.run_graph 的终态回写之后（run 行已 commit——
    「通知炸不许把 run 收尾带崩」的前提就是先后次序，不是 try 的侥幸）。
    """
    global _run_finalized_hook
    _run_finalized_hook = fn


async def run_finalized(db, *, run_id, project_id, trigger, ok, summary) -> None:
    """run 落终态后调已注册的钩子；**钩子异常一律吞掉**（记日志，不重抛）。

    通知是旁路：旁路失败不许把 run（真相已在库里 commit）或 beat/worker 带崩——
    run_graph 抛出异常时，调用方（orchestration._run_claimed）会把刚 commit 的终态
    改判成 error，那才是「旁路炸穿主路」的真实形状，所以兜底必须在调用点。
    失败明细（哪个渠道、为什么）归钩子实现自己落账（last_run/last_send），这里的日志
    是「钩子自己炸了、连账都没落成」时的最后一道可观察证据。
    """
    if _run_finalized_hook is None:
        return
    try:
        await _run_finalized_hook(db, run_id=run_id, project_id=project_id,
                                  trigger=trigger, ok=ok, summary=summary)
    except Exception:  # noqa: BLE001  旁路兜底：吞一切，重抛就是返工
        import logging

        logging.getLogger("testpilot").exception(
            "run 终态钩子异常（已吞，不影响 run 落库）：run=%s project=%s", run_id, project_id)


async def resolve_project_perms(db: AsyncSession, user_id: str, is_admin: bool, project_id: str) -> set[str] | None:
    if _perms_resolver is None:  # pragma: no cover
        raise RuntimeError("perms resolver 未注入")
    return await _perms_resolver(db, user_id, is_admin, project_id)


async def build_ctx(
    db: AsyncSession,
    user,
    payload: BaseModel | dict[str, Any],
    *,
    entry: Entry,
) -> ServiceCtx:
    """由 HTTP 请求构造 ctx；payload 带 project_id 时执行数据权限门。"""
    data = payload if isinstance(payload, dict) else payload.model_dump()
    project_id = data.get("project_id")
    if project_id:
        perms = await resolve_project_perms(db, user.id, user.is_system_admin, project_id)
        if perms is None:
            raise ApiError("forbidden", "无此项目权限", 403)
    else:
        # R30：平台级动作的基础位。任何认证用户都有 auth:*（自助改密这类"只作用于自己"的动作）；
        # 系统管理员全局 *。项目级权限位必须带 project_id 走 resolver —— 平台级与项目级不互相渗漏。
        perms = {"*"} if user.is_system_admin else {"auth:*"}
    return ServiceCtx(
        entry=entry,
        user_id=user.id,
        db=db,
        user_name=user.name,
        is_system_admin=user.is_system_admin,
        perms=perms,
    )


def normalize_entry(value: object) -> Entry:
    """把 actor 身份快照里的入口收敛回词表；认不出一律按 "http"。

    执行引擎重建 ServiceCtx 时读的是 actor.get("entry")——那是**别的进程/别的时间点**
    存的字符串（worker 档下 run_record 里的 JSON 快照），类型上只是 Any。以前这里写
    `str(actor.get("entry") or "web")`："web" 不在词表里（词表是 http/agent/schedule，
    审计筛选下拉与 run_record.trigger 都按它认），所以它永远不会命中任何分支——
    一个永远不会被读到的第三个词，读代码的人却要花时间想它在哪生效。
    认不出按 "http" 是安全侧：entry 只影响审计标注与 trigger 派生（只有 =="agent"
    才改变分支），把未知当 agent 反而会伪造"Pilot 干的"。
    """
    return value if isinstance(value, str) and value in _ENTRIES else "http"  # type: ignore[return-value]


def ctx_from_actor(actor: Mapping[str, Any] | None, db: AsyncSession) -> ServiceCtx:
    """执行引擎/驱动器由 actor 身份快照重建 ServiceCtx（T9：不回查 IAM，见 engine/context）。

    四处同款构造（handlers 两处、runner 一处、ui debug 一处）合成一处：entry 走
    normalize_entry，词表外的一致按 http 处理，不再各写各的兜底字面量。
    """
    a = actor or {}
    return ServiceCtx(
        entry=normalize_entry(a.get("entry")),
        user_id=str(a.get("user_id") or ""),
        db=db,
        user_name=str(a.get("user_name") or ""),
        is_system_admin=bool(a.get("is_system_admin")),
        perms=set(a.get("perms") or set()),
    )


async def ensure_project_access(ctx: ServiceCtx, project_id: str) -> None:
    """service 体内的数据权限门（agent 入口同样生效）；非成员与不存在同 403。"""
    if ctx.is_system_admin:
        return
    assert ctx.db is not None
    perms = await resolve_project_perms(ctx.db, ctx.user_id, ctx.is_system_admin, project_id)
    if perms is None:
        raise ApiError("forbidden", "无此项目权限", 403)
    ctx.perms = perms


def build_router(*, get_db_dep, get_user_dep, user_model) -> APIRouter:
    """由注册表生成全部 HTTP 路由（金线：路由=注册表的投影）。

    依赖（get_db / get_current_user / User 模型）由组装层注入，
    core 不 import modules（import-linter 契约）。
    """
    router = APIRouter()
    for spec in REGISTRY.all():
        if spec.http is None:
            continue
        _add_route(router, spec, get_db_dep, get_user_dep, user_model)
    return router


_BODY_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _is_sequence_annotation(annotation: Any) -> bool:
    """注解（含 `| None` 这类联合）里是否含 list/set/frozenset/tuple。

    只为 GET 投影 service 层的那一个分支服务（见 _add_route 里的 Query 说明）：
    标量字段一律返回 False，所以现有 47 个 GET 端点的参数 schema 不受影响。
    取 typing.get_origin 而不是 isinstance(list)：`list[str] | None` 的 origin 是
    types.UnionType，本体既不是 list 也不能直接比 origin，必须把联合的分支拆开逐个看。
    """
    stack = [annotation]
    while stack:
        cur = stack.pop()
        if get_origin(cur) in (list, set, frozenset, tuple):
            return True
        stack.extend(get_args(cur))
    return False


def _set_signature(fn: Any, sig: Any) -> None:
    """给动态端点函数挂 __signature__（FastAPI 靠它读参数与依赖）。

    为什么要有这个函数而不是就地 `endpoint.__signature__ = ...`：被装饰出来的 endpoint
    在类型上是 `async def (**kw: Any) -> Coroutine`，函数对象没有 __signature__ 这个
    属性，mypy 两处各报一次 attr-defined。就地 setattr 能过，但 ruff 的 B010 立刻回来
    （「常量属性名别用 setattr」）。参数标成 Any、赋值照写：把「我们确实在改函数签名」
    这件本该显眼的事集中到一个有名字的点上，两道门禁都不必被绕。
    """
    fn.__signature__ = sig


def _add_route(router: APIRouter, spec: ToolSpec, get_db_dep, get_user_dep, user_model) -> None:
    """路由 = 注册表投影：
    - body 方法（POST/PUT/PATCH/DELETE）→ payload 走 request body
    - GET → 路径参数 {xxx}（与 payload 字段同名）+ 其余标量字段走 query
    """
    import inspect as _i

    # http=None 的 service 由 build_router 在调用前挡掉；这里把它收进局部变量并断言，
    # 否则 ToolSpec.http 的 `| None` 会让下面 6 处下标/取值各报一次——那个 None 不是
    # 本函数能遇到的状态，写出来只为让类型检查器满意，但也不许它悄悄变成 None 分支。
    http = spec.http
    assert http is not None, "http=None 的 service 不该进路由投影（build_router 已过滤）"

    method = http["method"].upper()
    status = http.get("status", 200)
    hints = get_type_hints(spec.handler)
    ret = hints.get("return", inspect.signature(spec.handler).return_annotation)
    response_model = (
        ret
        if isinstance(ret, type) and issubclass(ret, BaseModel) and ret not in (BaseModel,) and ret.__name__ != "Page"
        else None
    )

    path_params = re.findall(r"\{(\w+)\}", http["path"])
    model_fields = spec.model.model_fields
    db_p = _i.Parameter("db", _i.Parameter.POSITIONAL_OR_KEYWORD, annotation=AsyncSession, default=Depends(get_db_dep))
    user_p = _i.Parameter("user", _i.Parameter.POSITIONAL_OR_KEYWORD, annotation=user_model, default=Depends(get_user_dep))

    if method in _BODY_METHODS:
        inj = [pp for pp in path_params if pp in model_fields]

        async def endpoint(**kw):
            db = kw.pop("db")
            user = kw.pop("user")
            uid = user.id  # 先取标量：commit/rollback 会过期 ORM 实例，之后再触属性 = 同步 IO
            body = kw.pop("payload", None) or {}
            merged = dict(body)
            merged.update(kw)  # 路径参数覆盖 body（path 为准）
            target = str(merged.get("project_id") or "")
            try:
                payload = spec.model.model_validate(merged)
                ctx = await build_ctx(db, user, merged, entry="http")
                # D164：dynamic_perm 服务的静态 perm 只是投影占位，门在体内按执行时定得的位。
                if not spec.dynamic_perm:
                    ctx.require(spec.perm)
                out = _dump(await spec.handler(payload, ctx))
            except Exception as exc:  # 写入口全审计：失败也落（ok=False + 原因）
                await db.rollback()
                msg = getattr(exc, "message", None) or str(exc)
                await _http_audit(db, user_id=uid, action=spec.name, target=target,
                                  ok=False, diff={"error": str(msg)[:500]})
                await db.commit()
                raise
            diff = {"produced": out["produced"]} if isinstance(out, dict) and out.get("produced") else None
            await _http_audit(db, user_id=uid, action=spec.name, target=target, ok=True, diff=diff)
            await db.commit()
            return out
        endpoint.__name__ = method.lower() + "_" + spec.name
        body_model = spec.model
        if inj:  # 路径参数注入的字段从 body schema 中剔除（path 为准）
            from pydantic import create_model

            # 显式 dict[str, Any]：create_model 的重载要求字段定义是 (类型, 默认/FieldInfo)，
            # 而 fi.annotation 的形状是 Any|None，动态推导会让重载匹配不上。字段来自
            # 真实模型的 model_fields，运行期本就满足重载，缺的只是声明。
            field_defs: dict[str, Any] = {k: (fi.annotation, fi)
                                          for k, fi in model_fields.items() if k not in inj}
            body_model = create_model(spec.name + "_body", **field_defs)
        if inj:
            params = [_i.Parameter(pp, _i.Parameter.POSITIONAL_OR_KEYWORD, annotation=str) for pp in inj]
            params.append(_i.Parameter("payload", _i.Parameter.POSITIONAL_OR_KEYWORD, annotation=body_model | None, default=None))
        else:
            params = [_i.Parameter("payload", _i.Parameter.POSITIONAL_OR_KEYWORD, annotation=body_model, default=...)]
        _set_signature(endpoint, _i.Signature(params + [db_p, user_p], return_annotation=dict))
    else:  # GET：路径参数 + query 合并为 payload
        async def endpoint(**kw):
            db = kw.pop("db")
            user = kw.pop("user")
            ctx = await build_ctx(db, user, kw, entry="http")
            ctx.require(spec.perm)
            return _dump(await spec.handler(spec.model.model_validate(kw), ctx))

        endpoint.__name__ = "get_" + spec.name
        required, optional = [], []
        for pp in path_params:
            required.append(_i.Parameter(pp, _i.Parameter.POSITIONAL_OR_KEYWORD, annotation=str))
        for qname, f_ in model_fields.items():
            if qname in path_params:
                continue
            if f_.is_required():
                required.append(_i.Parameter(qname, _i.Parameter.POSITIONAL_OR_KEYWORD, annotation=f_.annotation))
            else:
                # 序列型 query 字段必须显式包 Query()（D47-b 步 4b 的传输层前提）。
                # FastAPI 的判定规则：注解是序列且默认值不是 Query/Body 实例时，它把这一项
                # 当**请求体**处理——GET 没有体，于是既不登记 query 参数、也不报错，
                # 值静默停在默认值上。实测（fastapi 0.162.7）：手写
                # `async def f(project_id: str, ids: list[str] | None = None)` 的
                # openapi 参数表里没有 ids，且带 requestBody=true。
                # 我们的 GET 分支原来只填 pydantic 的裸默认值，因此撞同一条规则：
                # module_ids 到不了 handler（不是投影写错，是 FastAPI 的规矩）。
                # 为什么只包序列型：**不是**因为给标量包 Query 会改契约——实测两种写法
                # 的整份 OpenAPI 逐字节相同（给全部可选字段包 Query，参数表漂移仍是 1 处、
                # requestBody 差异也只是那条 GET 的幽灵体消失），标量包不包在契约上等价。
                # 选窄的那版只是理由：不需要同步改的东西就别改，47 条 GET 端点的取数路径
                # 因此一行代码都没换过，评审面与回归面都按「只动了序列字段」算。
                default: Any = f_.default
                if _is_sequence_annotation(f_.annotation):
                    default = Query(default=default)
                optional.append(_i.Parameter(qname, _i.Parameter.POSITIONAL_OR_KEYWORD,
                                             annotation=f_.annotation, default=default))
        _set_signature(endpoint, _i.Signature(required + [db_p, user_p] + optional, return_annotation=dict))

    router.add_api_route(
        http["path"],
        endpoint,
        methods=[method],
        tags=http.get("tags", [spec.domain]),
        status_code=status,
        response_model=response_model,
        summary=spec.description,
    )


def _dump(result: Any) -> Any:
    from app.core.errors import Page as _Page

    if isinstance(result, _Page):
        out: dict[str, Any] = {"items": [_dump(x) for x in result.items], "next_cursor": result.next_cursor}
        # total 只在页码分页时出现（D47-b）：None 就整个不写这个键，而不是写 null——
        # 凭空多出 "total":null 会把 20+ 个没人评审过的列表接口的响应形状改掉，
        # 前端若在用 `in` 判分页方式更会被它骗。键集一页永远不带这个键。
        if result.total is not None:
            out["total"] = result.total
        return out
    return result.model_dump() if isinstance(result, BaseModel) else result

