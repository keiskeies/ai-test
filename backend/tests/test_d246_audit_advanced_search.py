"""D246 判据刀：审计日志页高级搜索（D47-a 三件套铺到设置页「审计」Tab）。

钉的契约（对应 audit/services.py AUDIT_LIST_FILTER 的注释）：

1. **字段白名单 = 表格里看得见的标量列**：时间 / 操作人 / 入口 / 动作 / 目标 / 结果。
   `diff` 是 JSON、`id` 是定位键、`user_id` 不重复（操作人已按姓名展示且快捷轴另有
   user_id 参数），点名即 400。
2. **条件进 SQL 且在游标分页之前**：与 entry/action/user_id/ok/ts_* 五条快捷轴并行
   AND；项目级列表里仍先钉 `target == project_id`，filter 只收窄不扩权。
3. **布尔列收真布尔**：ok 只收 EQUALS/NOT_EQUALS 且 value 必须是 JSON true/false。
4. **空 filter = 没传**；非法字段/坏 JSON 400 且 code=bad_filter，message 点名本页
   可筛清单。
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from app.modules.audit.models import AuditLog

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _audit(session, *, aid: str, user_id: str | None, entry: str = "http",
                 action: str = "project_update", target: str | None = None,
                 ok: bool = True, offset_sec: int = 0,
                 diff: dict | None = None) -> str:
    session.add(AuditLog(id=aid, ts=datetime.now(UTC).replace(tzinfo=None)
                         - timedelta(seconds=offset_sec), user_id=user_id, entry=entry,
                         action=action, target=target, ok=ok, diff=diff, ip="127.0.0.1"))
    await session.commit()
    return aid


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _ids(client, h, **params) -> set[str]:
    r = await client.get(_BASE + "/audit", params=params, headers=h)
    assert r.status_code == 200, r.text
    return {x["id"] for x in r.json()["items"]}


async def test_filter_meta_registers_audit(client, make_user) -> None:
    _, h = await make_user("d246a", admin=True)
    pid = await _proj(client, h, "D246元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "audit"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "audit" in body["supported_view_types"]
    assert body["view_label"] == "审计日志"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"ts", "user_name", "entry", "action", "target", "ok"}
    assert not ({"diff", "id", "user_id"} & fields)
    by_field = {f["field"]: f for f in body["fields"]}
    assert by_field["ok"]["kind"] == "bool"
    assert set(by_field["ok"]["ops"]) == {"EQUALS", "NOT_EQUALS"}
    assert by_field["entry"]["kind"] == "enum" and "CONTAINS" not in by_field["entry"]["ops"]
    assert by_field["ts"]["kind"] == "time" and "BETWEEN" in by_field["ts"]["ops"]
    assert "EMPTY" in by_field["target"]["ops"]


async def test_conditions_apply_as_where(client, session, make_user) -> None:
    u, h = await make_user("d246b", admin=True)
    await _audit(session, aid="d246-b1", user_id=u.id, action="env_create", offset_sec=30)
    await _audit(session, aid="d246-b2", user_id=u.id, action="env_delete", ok=False,
                 entry="agent", offset_sec=20)
    await _audit(session, aid="d246-b3", user_id=None, action="project_update",
                 entry="schedule", offset_sec=10, diff={"before": {}, "after": {}})

    assert await _ids(client, h, filter=_f(
        {"field": "action", "operator": "CONTAINS", "value": "env_"})) == {"d246-b1", "d246-b2"}
    assert await _ids(client, h, filter=_f(
        {"field": "entry", "operator": "EQUALS", "value": "agent"})) == {"d246-b2"}
    assert await _ids(client, h, filter=_f(
        {"field": "ok", "operator": "EQUALS", "value": False})) == {"d246-b2"}
    assert await _ids(client, h, filter=_f(
        {"field": "user_name", "operator": "CONTAINS", "value": "d246b"})) == {
        "d246-b1", "d246-b2"}
    assert await _ids(client, h, filter=_f(
        {"field": "target", "operator": "EMPTY", "value": None})) == {
        "d246-b1", "d246-b2", "d246-b3"}
    # OR：动作含 delete 或入口是定时
    assert await _ids(client, h, filter=_f(
        {"field": "action", "operator": "CONTAINS", "value": "delete"},
        {"field": "entry", "operator": "EQUALS", "value": "schedule"}, mode="OR")) == {
        "d246-b2", "d246-b3"}


async def test_filter_composes_with_quick_axes_and_scope(client, session, make_user) -> None:
    u, h = await make_user("d246c", admin=True)
    pid = await _proj(client, h, "D246本项目")
    other = await _proj(client, h, "D246别的项目")
    await _audit(session, aid="d246-c1", user_id=u.id, action="env_create", target=pid)
    await _audit(session, aid="d246-c2", user_id=u.id, action="env_create", target=pid,
                 entry="schedule")
    await _audit(session, aid="d246-c3", user_id=u.id, action="env_create", target=other)

    # 项目作用域 + 快捷轴 entry=http + 条件「action 含 env」三层 AND
    assert await _ids(client, h, project_id=pid, entry="http", filter=_f(
        {"field": "action", "operator": "CONTAINS", "value": "env"})) == {"d246-c1"}
    # 别的项目的同类行不许被 filter 带出来
    assert await _ids(client, h, project_id=pid, filter=_f(
        {"field": "action", "operator": "CONTAINS", "value": "env_"})) == {
        "d246-c1", "d246-c2"}


async def test_filter_runs_before_cursor_pagination(client, session, make_user) -> None:
    u, h = await make_user("d246d", admin=True)
    await _audit(session, aid="d246-d1", user_id=u.id, action="d246_probe", offset_sec=2)
    await _audit(session, aid="d246-d2", user_id=u.id, action="d246_probe", offset_sec=1)
    cond = _f({"field": "action", "operator": "EQUALS", "value": "d246_probe"})
    first = await client.get(_BASE + "/audit", params={"filter": cond, "size": 1}, headers=h)
    assert first.status_code == 200, first.text
    body = first.json()
    assert len(body["items"]) == 1
    assert body["next_cursor"], "筛出两行、size=1 时必须还有下一页（过滤发生在 LIMIT 之前）"
    second = await client.get(_BASE + "/audit", params={
        "filter": cond, "size": 1, "cursor": body["next_cursor"]}, headers=h)
    assert second.status_code == 200, second.text
    assert {body["items"][0]["id"], second.json()["items"][0]["id"]} == {"d246-d1", "d246-d2"}


async def test_bad_filter_is_400_with_page_field_list(client, make_user) -> None:
    _, h = await make_user("d246e", admin=True)
    pid = await _proj(client, h, "D246坏条件")

    r = await client.get(_BASE + "/audit", params={
        "filter": _f({"field": "diff", "operator": "CONTAINS", "value": "before"})}, headers=h)
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["code"] == "bad_filter"
    assert body["details"]["view_type"] == "audit"
    assert "本页可筛" in body["message"] and "动作" in body["message"]

    # 布尔列收真布尔：字符串 "true" 不是这把尺上的值
    r2 = await client.get(_BASE + "/audit", params={
        "filter": _f({"field": "ok", "operator": "EQUALS", "value": "true"})}, headers=h)
    assert r2.status_code == 400 and r2.json()["code"] == "bad_filter"

    # 坏 JSON 不许降级成「没筛」
    r3 = await client.get(_BASE + "/audit", params=[("project_id", pid), ("filter", "{not json")],
                          headers=h)
    assert r3.status_code == 400 and r3.json()["code"] == "bad_filter"


async def test_empty_filter_returns_all(client, session, make_user) -> None:
    u, h = await make_user("d246f", admin=True)
    await _audit(session, aid="d246-f1", user_id=u.id)
    await _audit(session, aid="d246-f2", user_id=u.id)
    assert {"d246-f1", "d246-f2"} <= await _ids(client, h, filter="")
