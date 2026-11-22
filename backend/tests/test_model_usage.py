"""模型用量统计端点（D39 · §6.8）服务端测试。

钉死的口径（每个断言都要「能红」）：
  ① 空数据（只有模型、没有会话/事件）→ 零行 + tokens 全 null + models 恒出全池行
  ② 单用户多会话：users 聚到一行、sessions 分行；tokens Σ 只认 USAGE 事件里真实有的数
  ③ 网关没回 usage 的会话：turns 照计、tokens=null（「—」），绝不冒充 0；
     混在一个用户里时该会话不进 Σ 但 sessions/turns 照计
  ④ days 窗口：窗口外的 USAGE 与 run 都不进聚合（两把尺同窗）
  ⑤ 跨项目隔离：带 project_id 只数该项目；B 项目的会话/tokens 不冒进 A
  ⑥ 权限面：不带 project_id = 平台级（仅系统管理员）；带 project_id 项目成员四角色可读
     （平台级形状由 test_permission_matrix 的 model_usage_stats 行 ×4 格钉死）
  ⑦ 参数校验：days<1 → 422（后端参数与前端控件同尺，非法值不放行）
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.core.db import new_id


def _utc_naive(offset_days: float = 0.0) -> datetime:
    return datetime.now(UTC).replace(tzinfo=None) - timedelta(days=offset_days)


async def _proj(client, h, name: str) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _model(session, name: str, *, mid: str | None = None) -> str:
    from app.modules.model_cfg.models import ModelConfig

    cfg = ModelConfig(id=mid or new_id(), name=name, model_type="CHAT",
                      protocol="OPENAI_COMPAT", base_url="http://x/v1", model_name=name,
                      enabled=True)
    session.add(cfg)
    await session.commit()
    return cfg.id


async def _session_row(session, *, pid: str, uid: str, model_id: str | None,
                       title: str = "会话") -> str:
    from app.modules.agent.models import AgentSession

    s = AgentSession(id=new_id(), project_id=pid, user_id=uid, title=title, model_id=model_id)
    session.add(s)
    await session.commit()
    return s.id


async def _run_row(session, sid: str, *, at: datetime | None = None, seq: int = 1) -> str:
    from app.modules.agent.models import AgentRun

    r = AgentRun(id=new_id(), session_id=sid, seq=seq, status="DONE", created_at=at or _utc_naive())
    session.add(r)
    await session.commit()
    return r.id


async def _usage_row(session, sid: str, run_id: str | None, *, tin: object, tout: object,
                     at: datetime | None = None, seq: int = 1) -> None:
    """直接写 agent_message 的 USAGE 行（与 runner 落的形状一致；payload 少键=网关没给）。"""
    from app.modules.agent.models import AgentMessage

    payload: dict = {}
    if tin is not None:
        payload["input_tokens"] = tin
    if tout is not None:
        payload["output_tokens"] = tout
    session.add(AgentMessage(id=new_id(), session_id=sid, run_id=run_id, seq=seq,
                             type="USAGE", payload=payload, created_at=at or _utc_naive()))
    await session.commit()


async def _usage(client, h, **params) -> tuple[int, dict]:
    r = await client.get("/api/v1/model-usage", params=params, headers=h)
    return r.status_code, r.json()


# ---------- ① 空数据 ----------


async def test_empty_pool_zero_rows_and_null_tokens(client, session, make_user) -> None:
    _, h = await make_user("mu0", admin=True)
    m1 = await _model(session, "池内模型")
    code, body = await _usage(client, h)
    assert code == 200
    assert body["users"] == [] and body["sessions"] == []
    # models 恒出全池行（模型卡逐枚查表）：没用量 = 0 会话 + tokens null
    assert [(m["model_id"], m["usage_sessions"], m["total_tokens"]) for m in body["models"]] == \
        [(m1, 0, None)]
    assert body["totals"] == {"sessions": 0, "usage_sessions": 0, "turns": 0,
                              "input_tokens": None, "output_tokens": None, "total_tokens": None}
    assert body["scope"] == {"project_id": None}, "全池共享：无项目作用域是口径的一部分"


# ---------- ② 单用户多会话 ----------


async def test_single_user_multi_sessions_aggregates_one_user_row(client, session, make_user) -> None:
    u, h = await make_user("mu1", admin=True)
    pid = await _proj(client, h, "用量主项目")
    mid = await _model(session, "gpt-主")
    s1 = await _session_row(session, pid=pid, uid=u.id, model_id=mid, title="会话一")
    s2 = await _session_row(session, pid=pid, uid=u.id, model_id=mid, title="会话二")
    r1 = await _run_row(session, s1)
    r2 = await _run_row(session, s2)
    r3 = await _run_row(session, s2, seq=2)  # 第二会话两轮
    await _usage_row(session, s1, r1, tin=100, tout=10)
    await _usage_row(session, s2, r2, tin=50, tout=5, seq=1)
    await _usage_row(session, s2, r3, tin=30, tout=3, seq=2)

    _, body = await _usage(client, h)
    srows = {s["session_id"]: s for s in body["sessions"]}
    assert srows[s1]["turns"] == 1 and srows[s1]["total_tokens"] == 110
    assert srows[s2]["turns"] == 2 and srows[s2]["total_tokens"] == 88
    assert srows[s2]["model_name"] == "gpt-主"
    urows = [x for x in body["users"] if x["user_id"] == u.id]
    assert len(urows) == 1, "一个用户一行"
    assert urows[0]["sessions"] == 2 and urows[0]["turns"] == 3
    assert urows[0]["input_tokens"] == 180 and urows[0]["output_tokens"] == 18
    mrows = {m["model_id"]: m for m in body["models"]}
    assert mrows[mid]["usage_sessions"] == 2 and mrows[mid]["total_tokens"] == 198
    assert body["totals"]["usage_sessions"] == 2 and body["totals"]["turns"] == 3


# ---------- ③ 无 usage 回执：null 不冒充 0 ----------


async def test_missing_usage_receipt_is_null_not_zero(client, session, make_user) -> None:
    u, h = await make_user("mu2", admin=True)
    pid = await _proj(client, h, "用量缺回执")
    mid = await _model(session, "gpt-哑")
    s1 = await _session_row(session, pid=pid, uid=u.id, model_id=mid, title="有回执")
    s2 = await _session_row(session, pid=pid, uid=u.id, model_id=mid, title="网关没回")
    r1 = await _run_row(session, s1)
    await _run_row(session, s2)
    await _usage_row(session, s1, r1, tin=40, tout=6)
    await _usage_row(session, s2, None, tin=None, tout=None)  # USAGE 行在、payload 空

    _, body = await _usage(client, h)
    srows = {s["title"]: s for s in body["sessions"]}
    assert srows["网关没回"]["turns"] == 1, "run 是真实执行，轮次照计"
    assert srows["网关没回"]["total_tokens"] is None, "没回执 → null（「—」），0 就是冒充已统计"
    assert srows["有回执"]["total_tokens"] == 46
    urow = body["users"][0]
    assert urow["sessions"] == 2 and urow["turns"] == 2
    assert urow["total_tokens"] == 46, "可聚合的部分照常进 Σ"
    assert body["totals"]["usage_sessions"] == 1, "usage_sessions 只数真有回执的会话"


async def test_zero_tokens_is_zero_not_null(client, session, make_user) -> None:
    """回执真实存在且 Σ=0 → 报 0（「记了账，账上是 0」），与 null（没记账）两种形状。"""
    u, h = await make_user("mu2b", admin=True)
    pid = await _proj(client, h, "用量零回执")
    mid = await _model(session, "gpt-零")
    s1 = await _session_row(session, pid=pid, uid=u.id, model_id=mid)
    r1 = await _run_row(session, s1)
    await _usage_row(session, s1, r1, tin=0, tout=0)
    _, body = await _usage(client, h)
    assert body["sessions"][0]["total_tokens"] == 0
    assert body["totals"]["total_tokens"] == 0


# ---------- ④ days 窗口 ----------


async def test_days_window_cuts_usage_and_turns_together(client, session, make_user) -> None:
    u, h = await make_user("mu3", admin=True)
    pid = await _proj(client, h, "用量窗口")
    mid = await _model(session, "gpt-窗")
    s1 = await _session_row(session, pid=pid, uid=u.id, model_id=mid)
    old_run = await _run_row(session, s1, at=_utc_naive(3))
    new_run = await _run_row(session, s1, at=_utc_naive(0), seq=2)
    await _usage_row(session, s1, old_run, tin=1000, tout=100, at=_utc_naive(3), seq=1)
    await _usage_row(session, s1, new_run, tin=7, tout=1, at=_utc_naive(0), seq=2)

    _, full = await _usage(client, h)
    assert full["sessions"][0]["total_tokens"] == 1108 and full["sessions"][0]["turns"] == 2
    _, win = await _usage(client, h, days=1)
    assert win["sessions"][0]["total_tokens"] == 8, "窗口外的 USAGE 不进 Σ"
    assert win["sessions"][0]["turns"] == 1, "token 按窗裁而轮次不裁 = 同一页面两把尺"
    assert win["totals"]["turns"] == 1
    _, win7 = await _usage(client, h, days=7)
    assert win7["sessions"][0]["total_tokens"] == 1108


# ---------- ⑤ 跨项目隔离 ----------


async def test_project_filter_isolates_sessions(client, session, make_user) -> None:
    u, h = await make_user("mu4", admin=True)
    pid_a = await _proj(client, h, "隔离A用量")
    pid_b = await _proj(client, h, "隔离B用量")
    mid = await _model(session, "gpt-隔")
    sa = await _session_row(session, pid=pid_a, uid=u.id, model_id=mid, title="A会话")
    sb = await _session_row(session, pid=pid_b, uid=u.id, model_id=mid, title="B会话")
    ra = await _run_row(session, sa)
    rb = await _run_row(session, sb)
    await _usage_row(session, sa, ra, tin=10, tout=1)
    await _usage_row(session, sb, rb, tin=999, tout=99)

    _, a = await _usage(client, h, project_id=pid_a)
    assert [s["session_id"] for s in a["sessions"]] == [sa]
    assert a["totals"]["total_tokens"] == 11, "B 项目的 token 不许冒进 A"
    assert a["filters"]["project_id"] == pid_a
    # 过滤后模型行也跟窗口走：models 的 Σ 只含可见窗口
    assert {m["model_id"]: m["total_tokens"] for m in a["models"]} == {mid: 11}


# ---------- ⑥ 权限 ----------


async def test_platform_level_without_project_and_member_with_project(client, session, make_user) -> None:
    boss, hb = await make_user("mu5boss")
    pid = await _proj(client, hb, "用量权限项目")
    other, ho = await make_user("mu5other")
    mid = await _model(session, "gpt-权")

    # 不带 project_id：平台级，R30 下非管理员连门都进不来
    code, body = await _usage(client, ho)
    assert code == 403 and body["code"] in ("insufficient_permission", "forbidden")

    # 带 project_id：非成员 403（forbidden，不泄露存在性）
    code, body = await _usage(client, ho, project_id=pid)
    assert code == 403 and body["code"] == "forbidden"

    # READONLY 成员：*:read 罩得住 model:usage:read（位以 :read 结尾就是为这个）
    ro, hro = await make_user("mu5ro")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                             json={"role_code": "READONLY"}, headers=hb)).status_code == 200
    code, body = await _usage(client, hro, project_id=pid)
    assert code == 200, "READONLY 必须读得到用量统计"
    assert {m["model_id"] for m in body["models"]} == {mid}, "全池模型行恒在"

    # 系统管理员不带 project_id：全池放行
    _, hs = await make_user("mu5sys", admin=True)
    assert (await _usage(client, hs))[0] == 200


# ---------- ⑦ 参数校验 ----------


async def test_invalid_days_is_422(client, make_user) -> None:
    _, hs = await make_user("mu6", admin=True)
    code, body = await _usage(client, hs, days=0)
    assert code == 422 and body["code"] == "validation_failed", \
        "days<1 放行 = 后端参数比前端控件松，UI 筛选就成了摆设"
