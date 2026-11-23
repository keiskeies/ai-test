"""D242 判据刀：运行记录页高级搜索（D47-a 三件套铺到 /runs 列表）。

钉的契约（对应 services.py RUN_LIST_FILTER 的注释）：

1. **字段白名单 = run_record 的可见标量列**：对象名/对象类型/触发/状态/响应码/耗时/
   环境/错误信息/执行人/三个时刻列。`project_id`/`subject_id`/`id` 是取数定位键，
   JSON 快照与执行机制列（request_snapshot / stats / lease_owner / cancel_requested …）
   不是人能读的页面上属性，都不进；点名即 400。
2. **条件是 WHERE 且在项目作用域之内**：与 subject_type/trigger/status 三条快捷轴
   并行 AND；别的项目的同类行一行都不出现。
3. **条件进 COUNT 同一份**：current 模式下 total 也吃 filter，不是「筛了但页脚报全量」。
4. **可空列**：env_name / started_at 的 EMPTY 留下未填/未开始的行。
5. **空 filter = 没传**；非法字段/非法操作符/坏 JSON 400 且 code=bad_filter，
   message 点名本页可筛清单。
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
    status_code: int | None = 200, elapsed_ms: int | None = 100,
    env_name: str | None = "测试环境", error: str | None = None,
    started_at: datetime | None = None, created_by: str | None = None,
) -> str:
    """直插一条 run_record（写入口唯一是 runner/save_run；查询面测试不经过写服务，
    与 test_d215_report_advanced_search.py 同一约定）。"""
    r = RunRecord(project_id=pid, subject_type=subject_type, subject_id="subj-" + name,
                  subject_name=name, env_id=None if env_name is None else "env-" + env_name,
                  env_name=env_name, trigger=trigger, status=status,
                  status_code=status_code, elapsed_ms=elapsed_ms, error=error,
                  created_by=created_by or new_id(),
                  started_at=started_at, finished_at=started_at)
    session.add(r)
    await session.commit()
    return r.id


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _names(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/runs", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return {x["subject_name"] for x in r.json()["items"]}


async def test_filter_meta_registers_run(client, make_user) -> None:
    _, h = await make_user("d242a", admin=True)
    pid = await _proj(client, h, "D242元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "run"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "run" in body["supported_view_types"]
    assert body["view_label"] == "运行记录"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"subject_name", "subject_type", "trigger", "status", "status_code",
                      "elapsed_ms", "env_name", "error", "created_by", "created_at",
                      "started_at", "finished_at"}
    # 取数/定位/JSON/机制列都不是业务字段
    assert not ({"project_id", "subject_id", "id", "request_snapshot", "response_snapshot",
                 "assertions", "stats", "summary_graph", "lease_owner", "cancel_requested",
                 "max_runtime_ms", "updated_at"} & fields)
    by_field = {f["field"]: f for f in body["fields"]}
    assert by_field["trigger"]["kind"] == "enum" and "GT" not in by_field["trigger"]["ops"]
    assert by_field["created_at"]["kind"] == "time" and "BETWEEN" in by_field["created_at"]["ops"]
    # 非空列没有「为空」，可空的 env_name / error / started_at 有
    assert "EMPTY" not in by_field["subject_name"]["ops"]
    assert "EMPTY" not in by_field["status"]["ops"]
    assert "EMPTY" in by_field["env_name"]["ops"]
    assert "EMPTY" in by_field["error"]["ops"]
    assert "EMPTY" in by_field["started_at"]["ops"]


async def test_conditions_apply_as_where(client, session, make_user) -> None:
    u, h = await make_user("d242b", admin=True)
    pid = await _proj(client, h, "D242条件")
    await _run(session, pid, "冒烟-登录", created_by=u.id)
    await _run(session, pid, "冒烟-下单", status="failed", status_code=500, created_by=u.id)
    await _run(session, pid, "回归-登录", trigger="schedule", elapsed_ms=2500, created_by=u.id)

    assert await _names(client, h, pid, filter=_f(
        {"field": "subject_name", "operator": "CONTAINS", "value": "冒烟"})) == {
        "冒烟-登录", "冒烟-下单"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "status", "operator": "EQUALS", "value": "failed"})) == {"冒烟-下单"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "status_code", "operator": "GT", "value": 400})) == {"冒烟-下单"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "elapsed_ms", "operator": "GT", "value": 1000})) == {"回归-登录"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "subject_type", "operator": "EQUALS", "value": "scenario"})) == {
        "冒烟-登录", "冒烟-下单", "回归-登录"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "created_by", "operator": "EQUALS", "value": u.id})) == {
        "冒烟-登录", "冒烟-下单", "回归-登录"}
    # OR：名字含「下单」或触发是定时 → 不许被 SQL 的 AND 拼接掰回且
    assert await _names(client, h, pid, filter=_f(
        {"field": "subject_name", "operator": "CONTAINS", "value": "下单"},
        {"field": "trigger", "operator": "EQUALS", "value": "schedule"}, mode="OR")) == {
        "冒烟-下单", "回归-登录"}


async def test_filter_composes_with_quick_axes_and_counts(client, session, make_user) -> None:
    u, h = await make_user("d242c", admin=True)
    pid = await _proj(client, h, "D242叠加")
    await _run(session, pid, "手动-冒烟", trigger="manual", created_by=u.id)
    await _run(session, pid, "定时-冒烟", trigger="schedule", created_by=u.id)
    await _run(session, pid, "手动-回归", trigger="manual", created_by=u.id)

    # 快捷轴 trigger=manual 与条件「名字含冒烟」并行 AND，不是二选一
    assert await _names(client, h, pid, trigger="manual", filter=_f(
        {"field": "subject_name", "operator": "CONTAINS", "value": "冒烟"})) == {"手动-冒烟"}
    # 快捷轴 status 与条件同层
    assert await _names(client, h, pid, status="passed", filter=_f(
        {"field": "subject_name", "operator": "CONTAINS", "value": "回归"})) == {"手动-回归"}
    # 谓词写在 LIMIT 之前：两行匹配，size=1 只回一行但 total 是 2（COUNT 吃同一份条件）
    r = await client.get(_BASE + "/runs", params={
        "project_id": pid, "size": 1, "current": 1,
        "filter": _f({"field": "subject_name", "operator": "CONTAINS", "value": "冒烟"}),
    }, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    assert r.json()["total"] == 2


async def test_filter_stays_inside_project(client, session, make_user) -> None:
    u, h = await make_user("d242d", admin=True)
    pid = await _proj(client, h, "D242本项目")
    other = await _proj(client, h, "D242别的项目")
    await _run(session, pid, "本项目-冒烟", created_by=u.id)
    await _run(session, other, "别的项目-冒烟", created_by=u.id)

    assert await _names(client, h, pid, filter=_f(
        {"field": "subject_name", "operator": "CONTAINS", "value": "冒烟"})) == {"本项目-冒烟"}


async def test_nullable_columns_empty_and_not_empty(client, session, make_user) -> None:
    u, h = await make_user("d242e", admin=True)
    pid = await _proj(client, h, "D242空值")
    await _run(session, pid, "有环境有开始", env_name="测试环境",
               started_at=datetime.now(UTC), created_by=u.id)
    await _run(session, pid, "无环境无开始", env_name=None, started_at=None,
               error=None, created_by=u.id)
    await _run(session, pid, "有报错", error="断言未通过", created_by=u.id)

    assert await _names(client, h, pid, filter=_f(
        {"field": "env_name", "operator": "EMPTY", "value": None})) == {"无环境无开始"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "env_name", "operator": "NOT_EMPTY", "value": None})) == {
        "有环境有开始", "有报错"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "started_at", "operator": "EMPTY", "value": None})) == {
        "无环境无开始", "有报错"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "error", "operator": "CONTAINS", "value": "断言"})) == {"有报错"}


async def test_bad_filter_is_400_with_page_field_list(client, make_user) -> None:
    _, h = await make_user("d242f", admin=True)
    pid = await _proj(client, h, "D242坏条件")

    r = await client.get(_BASE + "/runs", params={
        "project_id": pid,
        "filter": _f({"field": "project_id", "operator": "EQUALS", "value": pid}),
    }, headers=h)
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["code"] == "bad_filter"
    assert body["details"]["view_type"] == "run"
    assert "本页可筛" in body["message"]
    assert "对象名称" in body["message"], "400 要告诉用户这一页到底能按什么筛"

    # 枚举列没有「包含」
    r2 = await client.get(_BASE + "/runs", params={
        "project_id": pid,
        "filter": _f({"field": "trigger", "operator": "CONTAINS", "value": "debug"}),
    }, headers=h)
    assert r2.status_code == 400 and r2.json()["code"] == "bad_filter"

    # 坏 JSON 不许降级成「没筛」
    r3 = await client.get(_BASE + "/runs",
                          params=[("project_id", pid), ("filter", "{not json")], headers=h)
    assert r3.status_code == 400 and r3.json()["code"] == "bad_filter"


async def test_empty_filter_returns_all(client, session, make_user) -> None:
    u, h = await make_user("d242g", admin=True)
    pid = await _proj(client, h, "D242空条件")
    await _run(session, pid, "甲", created_by=u.id)
    await _run(session, pid, "乙", created_by=u.id)
    assert await _names(client, h, pid, filter="") == {"甲", "乙"}
