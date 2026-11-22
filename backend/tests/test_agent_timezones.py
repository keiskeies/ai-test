"""Agent 域时间列的口径钉：读回必须 tz-aware，序列化必须带偏移。

为什么单独钉这一条（mypy 首轮扫出来，87 个错误里唯一一个「绿的但是错的」）：
`agent/models.py` 四张表原先用裸 `DateTime` + `Mapped[str]`，是全仓唯一不走
`UtcDateTime`/`TimestampMixin` 的家族。列里存的是 UTC naive 没错，但 ORM 读回来是
**naive datetime**，`isoformat()` 就出 `2026-11-15T05:19:49`（无偏移），而别的表出
`...+00:00`。前端 `shared/timefmt.ts` 有个「无偏移按 UTC 解释」的兜底才没显示成早 8 小时
（R68 就是那类错），于是**后端一处列类型的正确性压在另一个仓库的一个正则上**——
谁改了那个兜底、或谁拿这些串去喂不认裸串的解析器，就是静默的 8 小时。

修法是把四列换成 `UtcDateTime()`（`impl` 就是 `DateTime`，**DB 类型与数据都不变**，
所以本文件不测迁移，只测读回形状）。标注同步从 `Mapped[str]` 改成真 `Mapped[datetime]`
——原标注是假的，mypy 因此把 `created_at.isoformat()` 报成 `"str" has no attribute`。
"""
from __future__ import annotations

import re

OFFSET = re.compile(r"(?:Z|[+-]\d{2}:?\d{2})$")


async def test_agent_timestamps_read_back_as_aware(session) -> None:
    """四张 agent 表写一遍读回来都必须是 tz-aware（attach UTC）。"""
    from app.modules.agent.models import AgentApproval, AgentMessage, AgentRun, AgentSession

    s = AgentSession(project_id="p-tz", user_id="u-tz")
    db = session
    db.add(s)
    await db.flush()  # id 由列 default=new_id 在 INSERT 时才生成，逐级落一次才有各级 id
    r = AgentRun(session_id=s.id, seq=1)
    db.add(r)
    await db.flush()
    m = AgentMessage(session_id=s.id, run_id=r.id, seq=1, type="TEXT", payload={"x": 1})
    a = AgentApproval(run_id=r.id, tool_call_id="tc-1", tool_name="scenario_run", args={})
    db.add_all([m, a])
    await db.flush()

    for label, obj in (("AgentSession", s), ("AgentRun", r), ("AgentMessage", m)):
        # 必须 refresh 走真 SELECT：default=_now 给的是 tz-aware 的内存值，
        # 不刷新直接断言读的是「Python 侧刚赋的值」，裸 DateTime 也照样绿（假证明）。
        await db.refresh(obj)
        value = obj.created_at
        assert value.tzinfo is not None, label + ".created_at 读回是 naive——裸 DateTime 又回来了"
        assert value.utcoffset() is not None and value.utcoffset().total_seconds() == 0, label

    await db.refresh(a)
    assert a.decided_at is None  # 未决审批本来就是 NULL，不混进 aware 断言


async def test_agent_serialized_timestamps_carry_offset(session) -> None:
    """ routes._sess_out / store.replay 吐给前端的串必须带偏移，不能是裸串。"""
    from app.modules.agent import store
    from app.modules.agent.models import AgentMessage, AgentRun, AgentSession
    from app.modules.agent.routes import _sess_out

    s = AgentSession(project_id="p-tz2", user_id="u-tz2")
    session.add(s)
    await session.flush()
    r = AgentRun(session_id=s.id, seq=1)
    session.add(r)
    await session.flush()
    session.add(AgentMessage(session_id=s.id, run_id=r.id, seq=1, type="TEXT", payload={}))
    await session.flush()

    await session.refresh(s)  # 同上：不刷新就是读内存里赋的值，测不到读路径
    out = _sess_out(s)
    assert out["created_at"] is not None and OFFSET.search(out["created_at"]), out["created_at"]

    envs = await store.replay(session, s.id, 0)
    assert envs, "replay 应能取回那条消息"
    assert OFFSET.search(envs[0]["ts"]), "事件 ts 是裸串：" + str(envs[0]["ts"])
