"""D240 判据刀：定时任务页高级搜索（D47-a 三件套铺到 schedules）。

钉的契约（对应 service.py SCHEDULE_LIST_FILTER 的注释）：

1. **字段白名单 = schedule_task 的真实标量列**：名称/主体类型/cron/启用/环境/
   连续失败/创建人/更新人/两个时刻列。`subject_id`（页面画的是对象名不是 id）、
   `last_run`/`notify_channel_ids`（JSON，无稳定标量比较语义）、`id`（Ctrl+K 已覆盖）、
   `project_id`（机制参数）都不进白名单，点名即 400。
2. **条件是 WHERE**：与 enabled 快捷筛选并行 AND；分页在条件之后，total 是筛出来的集合大小。
3. **OR 不泄漏、不跨项目**：OR 组只在条件组自己的括号里，跨项目行一行都不出现。
4. **空 filter = 没传**；非法字段/非法操作符/非法 JSON 400 且 message 点名本页可筛清单。
"""
from __future__ import annotations

import json
from datetime import datetime

from app.modules.schedule.models import ScheduleTask

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _task(session, pid: str, uid: str, *, tid: str, name: str, subject_type: str = "scenario",
          cron: str = "0 2 * * *", enabled: int = 1, env_id: str | None = None,
          failures: int = 0, created_at: datetime | None = None) -> None:
    session.add(ScheduleTask(
        id=tid, project_id=pid, name=name, subject_type=subject_type,
        subject_id="s-" + tid, cron=cron, env_id=env_id, enabled=enabled,
        notify_channel_ids=[], consecutive_failures=failures,
        created_by=uid, updated_by=uid,
        created_at=created_at or datetime(2026, 11, 20, 10, 0, 0),
    ))


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _list(client, h, pid: str, **params):
    qs: list[tuple[str, str]] = [("project_id", pid)]
    for k, v in params.items():
        qs.append((k, str(v)))
    return await client.get(_BASE + "/schedule-tasks", params=qs, headers=h)


def _ids(body: dict) -> set[str]:
    return {x["id"] for x in body["items"]}


async def _seed(client, session, h, uid: str, name: str = "D240任务") -> str:
    pid = await _proj(client, h, name)
    _task(session, pid, uid, tid="t-night", name="夜间回归",
          created_at=datetime(2026, 11, 20, 10, 0, 0))
    _task(session, pid, uid, tid="t-pay", name="支付巡检", subject_type="plan",
          cron="30 3 * * 1", enabled=0, env_id="env-1", failures=3,
          created_at=datetime(2026, 11, 21, 10, 0, 0))
    _task(session, pid, uid, tid="t-night2", name="夜间冒烟", subject_type="plan_report",
          cron="0 4 * * *", failures=1, created_at=datetime(2026, 11, 22, 10, 0, 0))
    await session.commit()
    return pid


async def test_filter_meta_registers_schedule(client, make_user) -> None:
    _, h = await make_user("d240a", admin=True)
    pid = await _proj(client, h, "D240元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "schedule"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "schedule" in body["supported_view_types"]
    assert body["view_label"] == "定时任务"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"name", "subject_type", "cron", "enabled", "env_id",
                      "consecutive_failures", "created_by", "updated_by",
                      "created_at", "updated_at"}
    # JSON 列 / 机制参数 / 页面已用名字表示的 subject_id / Ctrl+K 已覆盖的 id 都不是可筛字段
    assert not ({"subject_id", "last_run", "notify_channel_ids", "id", "project_id"} & fields)
    by_field = {f["field"]: f for f in body["fields"]}
    assert by_field["subject_type"]["kind"] == "enum"
    assert by_field["enabled"]["kind"] == "number"
    assert by_field["env_id"]["kind"] == "id"
    assert by_field["created_at"]["kind"] == "time"
    # 非空列没有「为空」——摆了也永远筛不出行
    assert "EMPTY" not in by_field["name"]["ops"]
    assert "EMPTY" in by_field["env_id"]["ops"]


async def test_conditions_apply_as_where(client, session, make_user) -> None:
    u, h = await make_user("d240b", admin=True)
    pid = await _seed(client, session, h, u.id)

    async def ids(cond: str) -> set[str]:
        r = await _list(client, h, pid, filter=cond)
        assert r.status_code == 200, r.text
        return _ids(r.json())

    assert await ids(_f({"field": "name", "operator": "CONTAINS", "value": "夜间"})) \
        == {"t-night", "t-night2"}
    assert await ids(_f({"field": "subject_type", "operator": "EQUALS", "value": "plan"})) \
        == {"t-pay"}
    assert await ids(_f({"field": "cron", "operator": "CONTAINS", "value": "30 3"})) \
        == {"t-pay"}
    # enabled 是整数 0/1 列：number 语义（EQUALS 0 = 只看停用）
    assert await ids(_f({"field": "enabled", "operator": "EQUALS", "value": 0})) == {"t-pay"}
    assert await ids(_f({"field": "env_id", "operator": "EMPTY"})) == {"t-night", "t-night2"}
    assert await ids(_f({"field": "env_id", "operator": "NOT_EMPTY"})) == {"t-pay"}
    assert await ids(_f({"field": "consecutive_failures", "operator": "GT", "value": 1})) \
        == {"t-pay"}
    assert await ids(_f({"field": "created_by", "operator": "EQUALS", "value": u.id})) \
        == {"t-night", "t-pay", "t-night2"}
    # 时间区间：UTC naive 字面量，闭区间
    assert await ids(_f({"field": "created_at", "operator": "BETWEEN",
                         "value": ["2026-11-20T00:00:00", "2026-11-21T23:59:59"]})) \
        == {"t-night", "t-pay"}
    # OR 是「或」不是「且」
    assert await ids(_f({"field": "name", "operator": "CONTAINS", "value": "支付"},
                        {"field": "enabled", "operator": "EQUALS", "value": 1},
                        mode="OR")) == {"t-night", "t-pay", "t-night2"}


async def test_filter_ands_with_enabled_and_paging(client, session, make_user) -> None:
    u, h = await make_user("d240c", admin=True)
    pid = await _seed(client, session, h, u.id, "D240并存")

    # enabled 快捷轴 + 条件同时满足才有（名字含「夜间」且停用 → 只有 t-pay? 不，t-pay 名字不含夜间）
    r = await _list(client, h, pid, enabled=0,
                    filter=_f({"field": "name", "operator": "CONTAINS", "value": "夜间"}))
    assert _ids(r.json()) == set()
    r = await _list(client, h, pid, enabled=1,
                    filter=_f({"field": "name", "operator": "CONTAINS", "value": "夜间"}))
    assert _ids(r.json()) == {"t-night", "t-night2"}
    # 分页在条件之后：total 是筛出来的 2 条，两页各 1 条
    r = await _list(client, h, pid, size=1, current=1,
                    filter=_f({"field": "name", "operator": "CONTAINS", "value": "夜间"}))
    body = r.json()
    assert body["total"] == 2 and len(body["items"]) == 1
    r2 = await _list(client, h, pid, size=1, current=2,
                     filter=_f({"field": "name", "operator": "CONTAINS", "value": "夜间"}))
    b2 = r2.json()
    assert b2["total"] == 2 and len(b2["items"]) == 1
    assert {body["items"][0]["id"], b2["items"][0]["id"]} == {"t-night", "t-night2"}


async def test_filter_does_not_cross_projects(client, session, make_user) -> None:
    u, h = await make_user("d240d", admin=True)
    pid = await _seed(client, session, h, u.id, "D240甲")
    other = await _proj(client, h, "D240乙")
    _task(session, other, u.id, tid="t-other", name="夜间跨项目")
    await session.commit()

    r = await _list(client, h, pid,
                    filter=_f({"field": "name", "operator": "CONTAINS", "value": "跨项目"}))
    assert r.status_code == 200, r.text
    assert _ids(r.json()) == set()


async def test_bad_filter_is_400_with_page_field_list(client, session, make_user) -> None:
    u, h = await make_user("d240e", admin=True)
    pid = await _seed(client, session, h, u.id, "D240非法")

    r = await _list(client, h, pid,
                    filter=_f({"field": "subject_id", "operator": "EQUALS", "value": "x"}))
    assert r.status_code == 400, r.text
    detail = r.json()
    assert detail["code"] == "bad_filter"
    assert "任务名称（name）" in detail["message"]
    assert detail["details"]["view_type"] == "schedule"

    # 操作符对该类型无意义同样 400（枚举列没有包含语义）
    r = await _list(client, h, pid,
                    filter=_f({"field": "subject_type", "operator": "CONTAINS", "value": "plan"}))
    assert r.status_code == 400
    assert r.json()["code"] == "bad_filter"

    # 非法 JSON 不许降级成「没筛」
    r = await client.get(_BASE + "/schedule-tasks",
                         params=[("project_id", pid), ("filter", "{not json")], headers=h)
    assert r.status_code == 400
    assert r.json()["code"] == "bad_filter"


async def test_empty_filter_is_all_rows(client, session, make_user) -> None:
    u, h = await make_user("d240f", admin=True)
    pid = await _seed(client, session, h, u.id, "D240空条件")
    r = await _list(client, h, pid, filter="")
    assert r.status_code == 200
    assert _ids(r.json()) == {"t-night", "t-pay", "t-night2"}
