"""环境 CRUD：金线上第一个真实 @service（HTTP 路由与 Agent 工具同源）。"""
from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel
from sqlalchemy import select, text

from app.core.errors import ApiError, OkOut, Page, paginate
from app.core.permissions import match_perm
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.env import schemas
from app.modules.env.models import Environment, GlobalConfig

# 删环境前要数引用的三张表：(表名, 读该域的权限位, 给人看的域名)。
# adb_case 不在此列——§4.5 明确没有 env_id（ui_case 那个 env_id 是 §4.4 的，不同表不同契约）。
_ENV_REF_DOMAINS: tuple[tuple[str, str, str], ...] = (
    ("scenario", "scenario:read", "场景"),
    ("ui_case", "ui:case:read", "UI 用例"),
    ("schedule_task", "schedule:read", "定时任务"),
)
# 明细上限照 notify 的 REF_DETAIL_CAP（同一条 in_use 语义不该有两把尺）。
REF_DETAIL_CAP = 20


@dataclass
class EnvRef:
    """一个域对某环境的引用。表名兼作 details 的键；perm 决定明细给不给看。

    三个数是三件事，不许互相合并（notify 的 details_hidden / details_truncated 分开同尺）：
    count = 全部引用（含本项目之外的）；own = 本项目内的（明细只从这里取）；
    foreign = 本项目之外的条数（拦得住这次删除，但不在这屏点名）。
    """
    table: str
    perm: str
    label: str
    count: int
    own: int
    foreign: int
    items: list[dict[str, str]]


async def _env_refs(db, project_id: str, env_id: str) -> list[EnvRef]:
    """谁在引用这个环境，逐域一条。

    四条这里特有的口径，前三条都照 notify 删除引用检测（notify/service.py:_schedule_refs）：
    - **表名 SQL 而非 import scenario/ui_test/schedule.models**：契约 1「modules 之间只经
      service/事件总线互调」由 lint-imports 守着，env import 领域模块会直接红（R28 先例）。
    - **回收站里的行也数**：scenario/ui_case 的 status=recycled 能恢复，放过它等于给
      复活的行留一个悬空 env_id——那正是 D139 要拦的形状。
    - **run_record.env_id 故意不数**：那是出生快照（execution/services.py 落 run 时同时
      写 env_name），报告页自包含、不靠环境行活着。把它算进来的后果是「任何跑过的环境
      永远删不掉」，那是比 D139 更糟的可用性倒退。
    - **count 数全域，明细只列本项目**：跨项目的引用行今天经 API 就造得出来——
      scenario_update 落 env_id 前不校验归属（scenario/services.py 的 `s.env_id = payload.env_id`
      只跟着 payload 走，ensure_project_access 认的是场景自己的项目），执行期才 404。
      这种行删门必须照数：看不见 ≠ 没有。明细按删除动作所在项目取，跨项目的行计入
      count、以 foreign 报条数、永不点名（这屏是本项目视角，列个够不着的名字只会让人
      在本项目里找它）。跨项目改绑本身是另一条缺陷，已单独报主线，不在本门里顺手修。
    """
    out: list[EnvRef] = []
    for table, perm, label in _ENV_REF_DOMAINS:
        # SUM(project_id=:p)：MySQL 布尔即 1/0，一条查询同时拿回总数与本项目数
        total, own_cnt = (await db.execute(
            text("SELECT COUNT(*), COALESCE(SUM(project_id=:p),0) FROM " + table +
                 " WHERE env_id=:e"),
            {"e": env_id, "p": project_id})).one()
        total, own_cnt = int(total), int(own_cnt)
        if not total:
            out.append(EnvRef(table, perm, label, 0, 0, 0, []))
            continue
        items = [{"id": r[0], "name": r[1]} for r in (await db.execute(
            text("SELECT id, name FROM " + table + " WHERE env_id=:e AND project_id=:p "
                 "ORDER BY id LIMIT :lim"),
            {"e": env_id, "p": project_id, "lim": REF_DETAIL_CAP})).all()]
        out.append(EnvRef(table, perm, label, total, own_cnt, total - own_cnt, items))
    return out


def _out(e: Environment) -> schemas.EnvOut:
    return schemas.EnvOut(id=e.id, project_id=e.project_id, name=e.name, position=e.position, config=e.config)


@service(
    perm="env:config:create",
    effect="write",
    name="env_create",
    description="在项目中创建测试环境（含 base_url 等变量，S0 仅存储）",
    http={"method": "POST", "path": "/envs", "tags": ["env"], "status": 201},
    resident=False,
)
async def env_create(payload: schemas.EnvCreateIn, ctx) -> schemas.EnvOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:config:create")
    assert ctx.db is not None
    dup = (
        await ctx.db.execute(select(Environment).where(Environment.project_id == payload.project_id, Environment.name == payload.name))
    ).scalar_one_or_none()
    if dup is not None:
        raise ApiError("conflict", "环境名已存在", 409, {"name": payload.name})
    e = Environment(project_id=payload.project_id, name=payload.name, position=payload.position, config=payload.config)
    ctx.db.add(e)
    await ctx.db.commit()
    return _out(e)


@service(
    perm="env:config:read",
    effect="read",
    name="env_list",
    description="列出项目下的测试环境",
    http={"method": "GET", "path": "/envs", "tags": ["env"], "status": 200},
)
async def env_list(payload: schemas.EnvListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:config:read")
    assert ctx.db is not None
    stmt = (
        select(Environment)
        .where(Environment.project_id == payload.project_id)
        .order_by(Environment.id)  # 游标列单键；position 由前端排序
    )
    page = await paginate(ctx.db, stmt, cursor_col=Environment.id, row_key=lambda r: r.id,
                          cursor=payload.cursor, size=payload.size)
    return Page(items=[_out(e) for e in page.items], next_cursor=page.next_cursor)


@service(
    perm="env:config:update",
    effect="write",
    name="env_update",
    description="修改测试环境（名称/顺序/变量）",
    http={"method": "PATCH", "path": "/envs/{env_id}", "tags": ["env"], "status": 200},
)
async def env_update(payload: schemas.EnvUpdateIn, ctx) -> schemas.EnvOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:config:update")
    assert ctx.db is not None
    e = (
        await ctx.db.execute(select(Environment).where(Environment.id == payload.env_id, Environment.project_id == payload.project_id))
    ).scalar_one_or_none()
    if e is None:
        raise ApiError("not_found", "环境不存在", 404, {"env_id": payload.env_id})
    if payload.name is not None:
        e.name = payload.name
    if payload.position is not None:
        e.position = payload.position
    if payload.config is not None:
        e.config = payload.config
    await ctx.db.commit()
    return _out(e)


@service(
    perm="env:config:delete",
    effect="destructive",
    name="env_delete",
    description="删除测试环境（不可逆；被场景/UI 用例/定时任务引用时 409 列出引用）",
    http={"method": "DELETE", "path": "/envs/{env_id}", "tags": ["env"], "status": 200},
)
async def env_delete(payload: schemas.EnvDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:config:delete")
    assert ctx.db is not None
    e = (
        await ctx.db.execute(select(Environment).where(Environment.id == payload.env_id, Environment.project_id == payload.project_id))
    ).scalar_one_or_none()
    if e is None:
        raise ApiError("not_found", "环境不存在", 404, {"env_id": payload.env_id})
    # D139：硬删此前不留任何引用检测，被引用的环境删掉后只在**执行时**以 404 现形——
    # 报错的现场离病因隔了几小时（一次定时触发），排查方向还被 env_name 的出生快照带偏。
    # 拦在删除这一刻：count 由数据决定，不由权限决定（缺读权限的人不该能绕开保护直接删），
    # 明细按各自域的 :read 隐藏，且「查不到是谁」要说出口（details_hidden/truncated 分开）。
    refs = await _env_refs(ctx.db, payload.project_id, payload.env_id)
    hit = [r for r in refs if r.count > 0]
    if hit:
        total = sum(r.count for r in hit)
        named = "、".join(r.label + " " + str(r.count) + " 条" for r in hit)
        details: dict[str, object] = {"env_id": payload.env_id, "count": total}
        for r in hit:
            # 四个数必须能相互核对：count = own + foreign，len(items) ≤ own。
            # 三个旗标各说一件事，不许互相裹（notify 的 details_hidden/details_truncated 同尺）：
            # details_hidden=权限拦了明细；details_truncated=CAP 截了明细；foreign=本项目之外
            # 还有几条（计入拦截、永不点名，与权限无关——跨项目报名字是另一道门的事）。
            may_see = match_perm(ctx.perms, r.perm)
            shown = r.items if may_see else []
            details[r.table] = {"label": r.label, "count": r.count, "own": r.own,
                                "foreign": r.foreign, "items": shown,
                                "details_hidden": not may_see,
                                "details_truncated": r.own > len(shown)}
        raise ApiError("in_use", "该环境被 " + named + " 引用，先解绑再删", 409, details)
    await ctx.db.delete(e)
    await ctx.db.commit()
    return OkOut(ok=True)


SCOPES = ("VAR", "HEADER", "ASSERT", "EXTRACT")


@service(
    perm="env:config:read", effect="read", name="global_config_get",
    description="读取项目级全局配置（变量/请求头/断言/提取四类作用域）",
    http={"method": "GET", "path": "/envs/global-config", "tags": ["env"]},
    resident=False,
)
async def global_config_get(payload: schemas.GlobalConfigGetIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:config:read")
    assert ctx.db is not None
    rows = (
        await ctx.db.execute(select(GlobalConfig).where(GlobalConfig.project_id == payload.project_id))
    ).scalars().all()
    found = {r.scope_type: (r.items or []) for r in rows}
    return schemas.GlobalConfigOut(scopes={sc: found.get(sc, []) for sc in SCOPES})


@service(
    perm="env:config:update", effect="write", name="global_config_update",
    description="覆盖式保存某一作用域的全局配置（整段提交，不做增量合并）",
    http={"method": "POST", "path": "/envs/global-config", "tags": ["env"]},
    resident=False,
)
async def global_config_update(payload: schemas.GlobalConfigUpdateIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:config:update")
    assert ctx.db is not None
    for pair in payload.items:
        if len(pair) != 2 or not all(isinstance(x, str) for x in pair):
            raise ApiError("validation_error", "配置项必须是 [key, value] 二元组", 422)
    row = (
        await ctx.db.execute(select(GlobalConfig).where(
            GlobalConfig.project_id == payload.project_id, GlobalConfig.scope_type == payload.scope_type))
    ).scalar_one_or_none()
    if row is None:
        ctx.db.add(GlobalConfig(project_id=payload.project_id, scope_type=payload.scope_type,
                               items=[list(p) for p in payload.items]))
    else:
        row.items = [list(p) for p in payload.items]
    await ctx.db.commit()
    return OkOut(ok=True)


async def resolve_env(db, *, project_id: str, env_id: str | None) -> tuple[dict, list, int | None]:
    """分层合并（§7.5 优先级链的全局/环境两层）：返回 (vars, headers, timeout_ms)。

    vars = 全局 VAR ∪ 环境 vars（环境覆盖同名）；headers 同理且大小写不敏感去重；
    env_id 指定但不在本项目 → 404（与不存在同码，不泄露存在性）。
    """
    assert db is not None, "resolve_env 需要 session"
    g = (
        await db.execute(select(GlobalConfig).where(GlobalConfig.project_id == project_id))
    ).scalars().all()
    by_scope = {r.scope_type: (r.items or []) for r in g}
    pairs: dict[str, str] = {}
    for k, v in by_scope.get("VAR", []):
        pairs[str(k)] = str(v)
    headers: list[list[str]] = []
    for k, v in by_scope.get("HEADER", []):
        headers.append([str(k), str(v)])
    timeout_ms: int | None = None
    if env_id:
        env = (
            await db.execute(select(Environment).where(
                Environment.id == env_id, Environment.project_id == project_id))
        ).scalar_one_or_none()
        if env is None:
            raise ApiError("not_found", "环境不存在", 404, {"env_id": env_id})
        cfg = env.config or {}
        for k, v in cfg.get("vars") or []:
            pairs[str(k)] = str(v)
        env_hdrs = [[str(k), str(v)] for k, v in cfg.get("headers") or []]
        env_keys = {k.lower() for k, _v in env_hdrs}
        headers = [h for h in headers if h[0].lower() not in env_keys] + env_hdrs
        t = cfg.get("timeout_ms")
        if isinstance(t, int) and t > 0:
            timeout_ms = t
    return pairs, headers, timeout_ms


@service(
    perm="env:config:read", effect="read", name="env_resolve",
    description="解析生效的变量/请求头/超时（全局⊕环境合并结果；供执行链路内部调用）",
    http=None, tool=False, resident=False,
)
async def env_resolve(payload: schemas.EnvResolveIn, ctx) -> BaseModel:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("env:config:read")
    assert ctx.db is not None
    vars_, headers_, timeout_ = await resolve_env(ctx.db, project_id=payload.project_id, env_id=payload.env_id)
    env_name = None
    if payload.env_id:
        e = await ctx.db.get(Environment, payload.env_id)
        env_name = e.name if e else None
    return schemas.EnvResolveOut(vars=[[k, v] for k, v in vars_.items()],
                                 headers=headers_, timeout_ms=timeout_, env_name=env_name)
