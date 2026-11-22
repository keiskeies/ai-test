"""模型用量统计（D39 · §6.8 一期「模型全池共享 + 按用户/会话用量统计」）。

落库点取证（先取证后写码；计划 D39 说「无落库聚合」——照实测收窄）：
- USAGE 事件**一直在落库**：agent/runner.py 把每轮 usage 经 store.append_event 写进
  agent_message（append-only 真相表，type="USAGE"，payload 带 input/output_tokens）。
- 缺的只是「聚合并端点化」这一步。本文件把 agent_message × agent_session × agent_run
  三表现有列聚合成端点，**零迁移、不新建表、不改 agent/runner.py**——正是计划原文
  「model_usage 表或事件表聚合视图，形状待裁」里被裁定的后一支。
- 由此获得一条比新表更强的口径纪律：**统计只认事件流里真实存在的数据**。
  网关没回 usage（第三方服务不支持 stream_options.include_usage）→ 该会话 tokens 是
  null（前端画「—」），不是 0（冒充「已统计」）——计划原文同款要求。

全池口径（§9.8 :614）：
- 模型池全局共享、用量是**平台级**数字——本端点 payload 无必填 project_id，走 R30
  平台级门（矩阵形状同 model_cfg_list：平台行，READONLY/MEMBER/PA 拒、SYS 放行）。
  三个维度（按用户/按会话/按模型）恒在响应内——每个 UI 控件
  都有后端数据支撑，没有假门。
- 会话可见性跟着 agent_session.project_id 走：非系统管理员只统计自己所在项目的会话
  （跨项目隔离同全平台一把尺）；显式 project_id 过滤另过 ensure_project_access 门。

契约边界（lint-imports 实测过再写下的话）：
- 契约 3「composition 模块不得反向依赖 agent」把 app.modules.workbench 扫在内：
  本文件**不 import app.modules.agent**，agent_session/agent_run/agent_message 走
  表名 join（execution/timefmt.APP_USER 同款理由与同款形状），JSON 列经表名反射读出
  的是原始值，_payload() 负责 str/dict 两态归一。
- app_user 同样表名 join（不 import iam.models）。project_member 用不上：R30 之下
  不带 project_id 的请求到不了非管理员手里（见端点内可达性注释），没有
  「按我的全部项目聚」这条路可修。
- 权限位 model:usage:read（族 model 已在 KNOWN_PREFIX_FAMILIES；位以 :read 结尾）。
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import column, func, select, table
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.core.service import ensure_project_access, service
from app.modules.model_cfg.models import ModelConfig

# 表名 join（不 import iam/agent 的 ORM——契约 1/3 的同款绕行，见模块 docstring）
APP_USER = table("app_user", column("id"), column("name"))
AGENT_SESSION = table("agent_session", column("id"), column("project_id"),
                      column("user_id"), column("title"), column("model_id"))
AGENT_RUN = table("agent_run", column("session_id"), column("created_at"))
AGENT_MESSAGE = table("agent_message", column("session_id"), column("run_id"),
                      column("type"), column("payload"), column("created_at"))


class ModelUsageIn(BaseModel):
    project_id: str | None = None
    model_id: str | None = None
    days: int | None = None  # 近 N 个 UTC 日历日（窗口起点 = 今天−(N−1) 日 00:00，闭区间）

    @field_validator("days")
    @classmethod
    def _days_positive(cls, v: int | None) -> int | None:
        if v is not None and v < 1:
            raise ApiError("validation_failed", "days 至少为 1", 422, {"days": v})
        return v


class UserUsageRow(BaseModel):
    user_id: str
    user_name: str
    sessions: int = 0
    turns: int = 0
    # None = 该用户（过滤窗口内）没有任何可聚合的 usage 回执 → 前端「—」，不是 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None


class SessionUsageRow(BaseModel):
    session_id: str
    title: str
    user_id: str
    user_name: str
    project_id: str
    model_id: str | None = None
    model_name: str | None = None
    turns: int = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None


class ModelUsageRow(BaseModel):
    """按模型一行——§11.4.23 模型卡「用量 N 会话」的数据源（只有真实 usage 回执计数，
    一张回执都没有的模型 usage_sessions=0 → 前端「—」）。"""

    model_id: str
    model_name: str
    sessions: int = 0
    usage_sessions: int = 0
    turns: int = 0
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None


class ModelUsageOut(BaseModel):
    # 三个维度恒在（按用户 / 按会话 / 按模型）——响应形状不随参数变形，前端切维度
    # 零额外请求，也没有「后端不认的筛选控件」这种假门。
    # 诚实条款：一期全池共享（§9.8），本端点无项目作用域；project_id 只是过滤参数。
    scope: dict = Field(default_factory=lambda: {"project_id": None})
    filters: dict = Field(default_factory=dict)
    totals: dict = Field(default_factory=lambda: {"sessions": 0, "usage_sessions": 0, "turns": 0,
                                                  "input_tokens": None, "output_tokens": None,
                                                  "total_tokens": None})
    users: list[UserUsageRow] = Field(default_factory=list)
    sessions: list[SessionUsageRow] = Field(default_factory=list)
    models: list[ModelUsageRow] = Field(default_factory=list)


def _payload(raw: Any) -> dict:
    """agent_message.payload 经表名反射读回：驱动可能给 str（JSON 列原始值）或 dict。
    解析失败按空 dict——坏载荷 = 没记到账，而不是让一整页统计 500。"""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            v = json.loads(raw)
        except ValueError:
            return {}
        return v if isinstance(v, dict) else {}
    return {}


def _tok(v: object) -> int | None:
    """JSON 读数归一：缺键/非数/布尔 → None（「没记到账」），绝不悄悄变 0。"""
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _sum_or_none(present: bool, value: int) -> int | None:
    """窗口内一条可聚合的账都没有 → None（「—」）；有账就报 Σ（Σ 真等于 0 也报 0）。"""
    return value if present else None


def _window_start(now_utc_naive: datetime, days: int) -> datetime:
    """近 N 个日历日窗口起点（含今天）：UTC 日归零（agent_message.created_at 是 UTC naive）。

    这里刻意按 UTC 切日而工作台按上海切日：用量看的是「池子烧了多少 token」，
    不是东八区运营日报；两把尺各自在 docstring 写明，不互相冒充。
    """
    d = (now_utc_naive.date() if now_utc_naive.tzinfo is None
         else now_utc_naive.astimezone(UTC).date())
    return datetime.combine(d - timedelta(days=days - 1), datetime.min.time())


async def _usage_cells(db: AsyncSession, *, since: datetime | None) -> dict[str, dict]:
    """agent_message 里真实存在过 USAGE 的会话 → {runs, in_sum, out_sum, has}。

    按模型过滤不在这里做：模型归属的唯一依据是 agent_session.model_id，
    由调用方在会话集合上裁。JSON 抽取放 Python 侧不写 MySQL JSON_EXTRACT：
    usage 载荷形状由 gateway.py 单点产出，行量级 = 会话×轮次，方言 SQL 换来的
    不可移植是真成本、性能收益可忽略。
    """
    stmt = (select(AGENT_MESSAGE.c.session_id, AGENT_MESSAGE.c.run_id, AGENT_MESSAGE.c.payload)
            .where(AGENT_MESSAGE.c.type == "USAGE"))
    if since is not None:
        stmt = stmt.where(AGENT_MESSAGE.c.created_at >= since)
    cells: dict[str, dict] = {}
    for sid, run_id, raw in (await db.execute(stmt)).all():
        c = cells.setdefault(sid, {"runs": set(), "in_sum": 0, "out_sum": 0, "has": False})
        if run_id is not None:
            c["runs"].add(run_id)
        p = _payload(raw)
        tin, tout = _tok(p.get("input_tokens")), _tok(p.get("output_tokens"))
        if tin is not None:
            c["in_sum"] += tin
            c["has"] = True
        if tout is not None:
            c["out_sum"] += tout
            c["has"] = True
    return cells


@service(
    perm="model:usage:read", effect="read", name="model_usage_stats",
    description="按用户/按会话的模型用量统计（§6.8 一期）：聚合 agent 事件流里真实落库的 "
                "USAGE 回执（tokens）与轮次（run）；网关未回 usage 的会话 tokens 为 null"
                "（前端画「—」，不冒充已统计）；响应恒含 users+sessions+models 三组；"
                "一期模型全池共享，无项目作用域（project_id 仅过滤参数）",
    http={"method": "GET", "path": "/model-usage", "tags": ["model"], "status": 200},
    tool=False, resident=False,
)
async def model_usage_stats(payload: ModelUsageIn, ctx) -> ModelUsageOut:
    ctx.require("model:usage:read")
    assert ctx.db is not None
    db = ctx.db

    since = (_window_start(datetime.now(UTC).replace(tzinfo=None), payload.days)
             if payload.days else None)

    # —— 可见会话集合 ——
    # 可达性（R30 两态，没有第三种，别写够不着的分支）：
    # - 不带 project_id = 平台级请求：build_ctx 只给非管理员 {auth:*}，上面的
    #   ctx.require 已把非管理员拦在门外——到这里必是系统管理员，全池可见。
    # - 带 project_id：项目成员（MEMBER 的 *、READONLY 的 *:read 都罩得住
    #   model:usage:read）过 ensure_project_access 后只见该项目。
    sess_where = []
    if payload.project_id:
        await ensure_project_access(ctx, payload.project_id)
        sess_where.append(AGENT_SESSION.c.project_id == payload.project_id)
    if payload.model_id:
        sess_where.append(AGENT_SESSION.c.model_id == payload.model_id)

    sess_rows = (await db.execute(
        select(AGENT_SESSION.c.id, AGENT_SESSION.c.project_id, AGENT_SESSION.c.user_id,
               AGENT_SESSION.c.title, AGENT_SESSION.c.model_id).where(*sess_where)
    )).all()
    sess_info = {r[0]: {"project_id": r[1], "user_id": r[2], "title": r[3], "model_id": r[4]}
                 for r in sess_rows}

    # 轮次 = agent_run 行数（run 是真实执行，与 USAGE 是否落账无关）；
    # days 窗口同样作用于 run——token 按窗裁而轮次不裁，就是同一页面上两把尺。
    turns: dict[str, int] = {}
    if sess_info:
        turn_stmt = select(AGENT_RUN.c.session_id, func.count()).where(
            AGENT_RUN.c.session_id.in_(sess_info.keys()))
        if since is not None:
            turn_stmt = turn_stmt.where(AGENT_RUN.c.created_at >= since)
        for sid, n in (await db.execute(turn_stmt.group_by(AGENT_RUN.c.session_id))).all():
            turns[sid] = int(n)

    cells = await _usage_cells(db, since=since)
    names = await _user_names(db, {v["user_id"] for v in sess_info.values()})
    model_names = {r[0]: r[1] for r in (await db.execute(
        select(ModelConfig.id, ModelConfig.name))).all()}

    session_rows: list[SessionUsageRow] = []
    for sid, info in sess_info.items():
        c = cells.get(sid)
        i_sum = c["in_sum"] if c else 0
        o_sum = c["out_sum"] if c else 0
        has = bool(c and c["has"])
        session_rows.append(SessionUsageRow(
            session_id=sid, title=info["title"], user_id=info["user_id"],
            user_name=names.get(info["user_id"], info["user_id"]),
            project_id=info["project_id"], model_id=info["model_id"],
            model_name=(model_names.get(info["model_id"]) if info["model_id"] else None),
            turns=turns.get(sid, 0),
            input_tokens=_sum_or_none(has, i_sum),
            output_tokens=_sum_or_none(has, o_sum),
            total_tokens=_sum_or_none(has, i_sum + o_sum),
        ))
    session_rows.sort(key=lambda s: (-(s.total_tokens or 0), -s.turns, s.session_id))

    by_user: dict[str, dict] = {}
    for s in session_rows:
        u = by_user.setdefault(s.user_id, {"sessions": 0, "turns": 0,
                                           "in_sum": 0, "out_sum": 0, "has": False})
        u["sessions"] += 1
        u["turns"] += s.turns
        if s.input_tokens is not None:  # 可聚合的会话才把 token 并进用户 Σ；轮次照计
            u["in_sum"] += s.input_tokens
            u["out_sum"] += s.output_tokens or 0
            u["has"] = True
    user_rows = [UserUsageRow(
        user_id=uid, user_name=names.get(uid, uid), sessions=u["sessions"], turns=u["turns"],
        input_tokens=_sum_or_none(u["has"], u["in_sum"]),
        output_tokens=_sum_or_none(u["has"], u["out_sum"]),
        total_tokens=_sum_or_none(u["has"], u["in_sum"] + u["out_sum"]),
    ) for uid, u in by_user.items()]
    user_rows.sort(key=lambda r: (-(r.total_tokens or 0), -r.sessions, r.user_id))

    # 按模型聚合：全池每枚模型恒出一行（哪怕 0 会话）——模型卡逐枚查表渲染，
    # 不在响应里缺席，「没用量」与「这枚模型不存在」就是两种形状了。
    by_model: dict[str, dict] = {}
    for s in session_rows:
        if not s.model_id:
            continue
        m = by_model.setdefault(s.model_id, {"sessions": 0, "usage": 0, "turns": 0,
                                             "in_sum": 0, "out_sum": 0, "has": False})
        m["sessions"] += 1
        m["turns"] += s.turns
        if s.total_tokens is not None:
            m["usage"] += 1
            m["in_sum"] += s.input_tokens or 0
            m["out_sum"] += s.output_tokens or 0
            m["has"] = True
    all_models = (await db.execute(select(ModelConfig.id, ModelConfig.name))).all()
    model_rows = []
    for mid, mname in all_models:
        m = by_model.get(mid, {"sessions": 0, "usage": 0, "turns": 0,
                               "in_sum": 0, "out_sum": 0, "has": False})
        model_rows.append(ModelUsageRow(
            model_id=mid, model_name=mname, sessions=m["sessions"], usage_sessions=m["usage"],
            turns=m["turns"],
            input_tokens=_sum_or_none(m["has"], m["in_sum"]),
            output_tokens=_sum_or_none(m["has"], m["out_sum"]),
            total_tokens=_sum_or_none(m["has"], m["in_sum"] + m["out_sum"]),
        ))
    model_rows.sort(key=lambda r: r.model_name)

    any_has = any(s.total_tokens is not None for s in session_rows)
    totals = {
        "sessions": len(session_rows),
        # usage_sessions：事件流里真有 usage 回执的会话数——模型卡「N 会话」的数据源；
        # 0 在这里的含义是「一条回执都没有」，前端渲染成「—」而不是「0 会话」。
        "usage_sessions": sum(1 for s in session_rows if s.total_tokens is not None),
        "turns": sum(s.turns for s in session_rows),
        "input_tokens": _sum_or_none(any_has, sum(s.input_tokens or 0 for s in session_rows)),
        "output_tokens": _sum_or_none(any_has, sum(s.output_tokens or 0 for s in session_rows)),
        "total_tokens": _sum_or_none(any_has, sum(s.total_tokens or 0 for s in session_rows)),
    }
    return ModelUsageOut(
        scope={"project_id": None},  # 全池共享（§9.8）：恒 None，见模块 docstring
        filters={"project_id": payload.project_id, "model_id": payload.model_id,
                 "days": payload.days},
        totals=totals, users=user_rows, sessions=session_rows, models=model_rows,
    )


async def _user_names(db: AsyncSession, user_ids: set[str]) -> dict[str, str]:
    if not user_ids:
        return {}
    return {
        r[0]: r[1] for r in (await db.execute(
            select(APP_USER.c.id, APP_USER.c.name).where(APP_USER.c.id.in_(sorted(user_ids)))
        )).all()
    }
