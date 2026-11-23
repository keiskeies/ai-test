"""D215 判据刀：报告中心列表高级搜索（D47-a 三件套从 api/plan/scenario/ui_case 铺到报告页）。

钉的契约：

1. **字段白名单 = REPORT_LIST_FILTER**，meta 里的 fields 与它同源；白名单外 400。
2. **条件是 WHERE**：与 include_debug、since/until、subject_type 这些顶层轴并行 AND，
   不是二选一；OR 组自带括号，不吃掉 project_id 与「默认排除 debug」的谓词。
3. **默认视图轴不可被 filter 绕过**：`trigger EQUALS debug` 在默认（include_debug=false）
   下仍返回空集——「报告是结论」的口径由页面定，不由条件组重写。
4. **可空列**：env_name / started_at 的 EMPTY 能留下未填/未开始的行，NOT_EMPTY 一行不给。
5. **enum 的操作符集合来自控件型**：trigger 没有 GT；非空列没有 EMPTY 假选项。
6. **条件进 COUNT 同一份**：current 模式下的 total 必须也吃 filter，不是「筛了但页脚报全量」。
"""
from __future__ import annotations

import json
from datetime import UTC, datetime

from app.core.db import new_id
from app.modules.execution.models import RunRecord

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _run(
    session, pid: str, name: str, *,
    trigger: str = "manual", status: str = "passed", subject_type: str = "scenario",
    env_name: str | None = "测试环境", started_at: datetime | None = None,
    created_by: str | None = None,
) -> str:
    """直插一条 run_record（写入口唯一是 runner/save_run，查询面测试不经过写服务，
    与 test_report_center.py 同一约定）。"""
    r = RunRecord(project_id=pid, subject_type=subject_type, subject_id="subj-" + name,
                  subject_name=name, env_id=None if env_name is None else "env-" + env_name,
                  env_name=env_name, trigger=trigger, status=status,
                  created_by=created_by or new_id(),
                  started_at=started_at, finished_at=started_at)
    session.add(r)
    await session.commit()
    return r.id


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _names(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/reports", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return {x["subject_name"] for x in r.json()["items"]}


async def test_filter_meta_registers_report(client, make_user) -> None:
    _, h = await make_user("d215a", admin=True)
    pid = await _proj(client, h, "D215元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "report"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "report" in body["supported_view_types"]
    assert body["view_label"] == "报告中心"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {
        "subject_name", "subject_type", "trigger", "status", "env_id", "env_name",
        "created_by", "status_code", "elapsed_ms", "started_at", "finished_at",
        "created_at", "updated_at",
    }
    # 取数/视图轴不是业务字段：project_id 若进白名单，filter 就能写「别的项目」
    assert not ({"project_id", "include_debug", "since", "until", "subject_id",
                 "cursor", "current", "size"} & fields), \
        "可见性/视图/取数轴不是业务字段，不许进条件组"
    trig = next(f for f in body["fields"] if f["field"] == "trigger")
    assert trig["kind"] == "enum" and "GT" not in trig["ops"]
    name = next(f for f in body["fields"] if f["field"] == "subject_name")
    assert "CONTAINS" in name["ops"] and "BETWEEN" not in name["ops"]
    created = next(f for f in body["fields"] if f["field"] == "created_at")
    assert "EMPTY" not in created["ops"], "非空时间列不给「为空」假选项"


async def test_conditions_apply_as_where(client, session, make_user) -> None:
    u, h = await make_user("d215b", admin=True)
    pid = await _proj(client, h, "D215条件")
    await _run(session, pid, "冒烟-登录", created_by=u.id)
    await _run(session, pid, "冒烟-下单", status="failed", created_by=u.id)
    await _run(session, pid, "回归-登录", trigger="schedule", created_by=u.id)

    assert await _names(client, h, pid, filter=_f(
        {"field": "subject_name", "operator": "CONTAINS", "value": "冒烟"})) == {
        "冒烟-登录", "冒烟-下单"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "status", "operator": "EQUALS", "value": "failed"})) == {"冒烟-下单"}
    # OR：名字含「下单」或触发是定时 → 同一行（SQL 的 AND 拼接不许把它掰回且）
    assert await _names(client, h, pid, filter=_f(
        {"field": "subject_name", "operator": "CONTAINS", "value": "下单"},
        {"field": "trigger", "operator": "EQUALS", "value": "schedule"}, mode="OR")) == {
        "冒烟-下单", "回归-登录"}
    # 谓词写在 LIMIT 之前：两行都匹配，size=1 只回一行但 total 是 2（COUNT 吃同一份条件）
    r = await client.get(_BASE + "/reports", params={
        "project_id": pid, "size": 1, "current": 1,
        "filter": _f({"field": "subject_name", "operator": "CONTAINS", "value": "登录"}),
    }, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    assert r.json()["total"] == 2


async def test_filter_cannot_bypass_default_debug_axis(client, session, make_user) -> None:
    u, h = await make_user("d215c", admin=True)
    pid = await _proj(client, h, "D215调试轴")
    await _run(session, pid, "手动-冒烟", created_by=u.id)
    await _run(session, pid, "调试-冒烟", trigger="debug", created_by=u.id)

    # 默认视图（include_debug=false）+ 条件：调试行不许因条件出现
    assert await _names(client, h, pid, filter=_f(
        {"field": "subject_name", "operator": "CONTAINS", "value": "冒烟"})) == {"手动-冒烟"}
    # 条件里点名要 debug 也不行：默认轴是 AND，不是可被条件组重写的「或」
    assert await _names(client, h, pid, filter=_f(
        {"field": "trigger", "operator": "EQUALS", "value": "debug"})) == set()
    # include_debug 是顶层轴，与 filter 并行生效
    assert await _names(client, h, pid, include_debug="true", filter=_f(
        {"field": "subject_name", "operator": "CONTAINS", "value": "冒烟"})) == {
        "手动-冒烟", "调试-冒烟"}


async def test_nullable_env_and_started_at(client, session, make_user) -> None:
    u, h = await make_user("d215d", admin=True)
    pid = await _proj(client, h, "D215空值")
    await _run(session, pid, "有环境有开始", env_name="测试环境",
               started_at=datetime.now(UTC), created_by=u.id)
    await _run(session, pid, "无环境无开始", env_name=None, started_at=None, created_by=u.id)

    assert await _names(client, h, pid, filter=_f(
        {"field": "env_name", "operator": "EMPTY", "value": None})) == {"无环境无开始"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "env_name", "operator": "NOT_EMPTY", "value": None})) == {"有环境有开始"}
    # started_at 可空（queued/running/老行）：未开始的行筛得出、也排除得掉
    assert await _names(client, h, pid, filter=_f(
        {"field": "started_at", "operator": "EMPTY", "value": None})) == {"无环境无开始"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "started_at", "operator": "NOT_EMPTY", "value": None})) == {"有环境有开始"}


async def test_bad_filter_is_400(client, make_user) -> None:
    _, h = await make_user("d215e", admin=True)
    pid = await _proj(client, h, "D215坏条件")
    r = await client.get(_BASE + "/reports", params={
        "project_id": pid,
        "filter": _f({"field": "project_id", "operator": "EQUALS", "value": pid}),
    }, headers=h)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_filter"
    assert r.json()["details"]["view_type"] == "report"
    assert "本页可筛" in r.json()["message"]
    assert "对象名称" in r.json()["message"], "400 要告诉用户这一页到底能按什么筛"
