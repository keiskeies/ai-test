"""D239 判据刀：任务中心高级搜索（D47-a 三件套铺到任务列表）。

钉的契约（对应 services.py TASK_LIST_FILTER 的注释）：

1. **字段白名单 = run_record 的真实列**：任务名/类型/触发/状态/环境/耗时/错误/触发人/
   三个时刻列。`queue_position`/`can_stop`/`can_rerun`（读时算的展示量）、
   `cancel_requested`（worker 协作旗）、`id`（keyword 已覆盖）、`project_id`（机制参数）
   都不进白名单，点名即 400。
2. **条件是 WHERE**：与 state（运行中/已结束）、subject_type、trigger、keyword 这些快捷
   筛选并行 AND；分页在条件之后，total 是筛出来的集合大小。
3. **OR 不泄漏**：OR 组只在条件组自己的括号里，跨项目行一行都不出现。
4. **空 filter = 没传**；非法字段/非法操作符 400 且在 message 里点名本页可筛清单。
"""
from __future__ import annotations

import json
from datetime import datetime

from app.modules.execution.models import RunRecord

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _run(session, pid: str, uid: str, *, rid: str, name: str, subject_type: str = "scenario",
         trigger: str = "manual", status: str = "passed", env_name: str | None = None,
         elapsed_ms: int | None = 1200, error: str | None = None,
         created_at: datetime | None = None) -> None:
    session.add(RunRecord(
        id=rid, project_id=pid, subject_type=subject_type, subject_id="s-" + rid,
        subject_name=name, env_name=env_name, trigger=trigger, status=status,
        elapsed_ms=elapsed_ms, error=error, created_by=uid,
        created_at=created_at or datetime(2026, 11, 20, 10, 0, 0),
    ))


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _list(client, h, pid: str, **params):
    qs: list[tuple[str, str]] = [("project_id", pid)]
    for k, v in params.items():
        qs.append((k, str(v)))
    return await client.get(_BASE + "/task-center/tasks", params=qs, headers=h)


def _ids(body: dict) -> set[str]:
    return {x["id"] for x in body["items"]}


async def _seed(client, session, h, uid: str, name: str = "D239任务") -> str:
    pid = await _proj(client, h, name)
    _run(session, pid, uid, rid="r-login", name="登录场景",
         created_at=datetime(2026, 11, 20, 10, 0, 0))
    _run(session, pid, uid, rid="r-pay", name="支付场景", subject_type="ui_case",
         trigger="schedule", status="failed", elapsed_ms=8000,
         created_at=datetime(2026, 11, 21, 10, 0, 0))
    _run(session, pid, uid, rid="r-login2", name="登录备用", subject_type="adb_case",
         status="running", env_name="灰度", elapsed_ms=None, error="设备离线",
         created_at=datetime(2026, 11, 22, 10, 0, 0))
    await session.commit()
    return pid


async def test_filter_meta_registers_task_center(client, make_user) -> None:
    _, h = await make_user("d239a", admin=True)
    pid = await _proj(client, h, "D239元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "task_center"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "task_center" in body["supported_view_types"]
    assert body["view_label"] == "任务中心"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"subject_name", "subject_type", "trigger", "status", "env_name",
                      "elapsed_ms", "error", "created_by", "created_at", "started_at",
                      "finished_at"}
    # 展示量 / 协作旗 / 机制参数 / keyword 已覆盖的 id 都不是可筛字段
    assert not ({"queue_position", "can_stop", "can_rerun", "cancel_requested", "id",
                 "project_id", "subject_id"} & fields)
    by_field = {f["field"]: f for f in body["fields"]}
    assert by_field["status"]["kind"] == "enum"
    assert by_field["elapsed_ms"]["kind"] == "number"
    assert by_field["created_at"]["kind"] == "time"
    assert by_field["created_by"]["kind"] == "id"
    # 非空列没有「为空」——摆了也永远筛不出行
    assert "EMPTY" not in by_field["subject_name"]["ops"]
    assert "EMPTY" in by_field["error"]["ops"]


async def test_conditions_apply_as_where(client, session, make_user) -> None:
    u, h = await make_user("d239b", admin=True)
    pid = await _seed(client, session, h, u.id)

    async def ids(cond: str) -> set[str]:
        r = await _list(client, h, pid, filter=cond)
        assert r.status_code == 200, r.text
        return _ids(r.json())

    assert await ids(_f({"field": "subject_name", "operator": "CONTAINS", "value": "登录"})) \
        == {"r-login", "r-login2"}
    assert await ids(_f({"field": "status", "operator": "EQUALS", "value": "failed"})) \
        == {"r-pay"}
    assert await ids(_f({"field": "status", "operator": "IN", "value": ["passed", "failed"]})) \
        == {"r-login", "r-pay"}
    assert await ids(_f({"field": "subject_type", "operator": "EQUALS", "value": "adb_case"})) \
        == {"r-login2"}
    assert await ids(_f({"field": "trigger", "operator": "EQUALS", "value": "schedule"})) \
        == {"r-pay"}
    assert await ids(_f({"field": "env_name", "operator": "CONTAINS", "value": "灰"})) \
        == {"r-login2"}
    assert await ids(_f({"field": "elapsed_ms", "operator": "GT", "value": 2000})) == {"r-pay"}
    # 可空列「为空」真的按 NULL 走（耗时没落库的 running 行）
    assert await ids(_f({"field": "elapsed_ms", "operator": "EMPTY"})) == {"r-login2"}
    # 时间区间：UTC naive 字面量，闭区间
    assert await ids(_f({"field": "created_at", "operator": "BETWEEN",
                         "value": ["2026-11-20T00:00:00", "2026-11-21T23:59:59"]})) \
        == {"r-login", "r-pay"}
    # OR 是「或」不是「且」
    assert await ids(_f({"field": "subject_name", "operator": "CONTAINS", "value": "支付"},
                        {"field": "status", "operator": "EQUALS", "value": "running"},
                        mode="OR")) == {"r-pay", "r-login2"}


async def test_filter_ands_with_quick_filters_and_paging(client, session, make_user) -> None:
    u, h = await make_user("d239c", admin=True)
    pid = await _seed(client, session, h, u.id, "D239并存")

    # 已结束 + 条件：queued/running 不在 state=finished 这一轴里
    r = await _list(client, h, pid, state="finished",
                    filter=_f({"field": "subject_name", "operator": "CONTAINS", "value": "登录"}))
    assert _ids(r.json()) == {"r-login"}
    # 类型快捷筛选 + 条件：两者同时满足才有
    r = await _list(client, h, pid, subject_type="scenario",
                    filter=_f({"field": "status", "operator": "EQUALS", "value": "failed"}))
    assert _ids(r.json()) == set()
    # keyword 与条件同一层 AND
    r = await _list(client, h, pid, keyword="登录",
                    filter=_f({"field": "subject_type", "operator": "EQUALS", "value": "scenario"}))
    assert _ids(r.json()) == {"r-login"}
    # 分页在条件之后：total 是筛出来的 2 条，第 2 页是剩下的那 1 条
    r = await _list(client, h, pid, size=1, current=1,
                    filter=_f({"field": "subject_name", "operator": "CONTAINS", "value": "登录"}))
    body = r.json()
    assert body["total"] == 2 and len(body["items"]) == 1
    r2 = await _list(client, h, pid, size=1, current=2,
                     filter=_f({"field": "subject_name", "operator": "CONTAINS", "value": "登录"}))
    b2 = r2.json()
    assert b2["total"] == 2 and len(b2["items"]) == 1
    assert {body["items"][0]["id"], b2["items"][0]["id"]} == {"r-login", "r-login2"}


async def test_filter_does_not_cross_projects(client, session, make_user) -> None:
    u, h = await make_user("d239d", admin=True)
    pid = await _seed(client, session, h, u.id, "D239甲")
    other = await _proj(client, h, "D239乙")
    _run(session, other, u.id, rid="r-other", name="登录跨项目")
    await session.commit()

    r = await _list(client, h, pid,
                    filter=_f({"field": "subject_name", "operator": "CONTAINS", "value": "跨项目"}))
    assert r.status_code == 200, r.text
    assert _ids(r.json()) == set()


async def test_bad_filter_is_400_with_page_field_list(client, session, make_user) -> None:
    u, h = await make_user("d239e", admin=True)
    pid = await _seed(client, session, h, u.id, "D239非法")

    r = await _list(client, h, pid,
                    filter=_f({"field": "queue_position", "operator": "EQUALS", "value": 1}))
    assert r.status_code == 400, r.text
    detail = r.json()
    assert detail["code"] == "bad_filter"
    assert "任务名称（subject_name）" in detail["message"]
    assert detail["details"]["view_type"] == "task_center"

    # 操作符对该类型无意义同样 400（枚举列没有包含语义）
    r = await _list(client, h, pid,
                    filter=_f({"field": "status", "operator": "CONTAINS", "value": "pass"}))
    assert r.status_code == 400
    assert r.json()["code"] == "bad_filter"

    # 非法 JSON 不许降级成「没筛」
    r = await client.get(_BASE + "/task-center/tasks",
                         params=[("project_id", pid), ("filter", "{not json")], headers=h)
    assert r.status_code == 400
    assert r.json()["code"] == "bad_filter"


async def test_empty_filter_is_all_rows(client, session, make_user) -> None:
    u, h = await make_user("d239f", admin=True)
    pid = await _seed(client, session, h, u.id, "D239空条件")
    r = await _list(client, h, pid, filter="")
    assert r.status_code == 200
    assert _ids(r.json()) == {"r-login", "r-pay", "r-login2"}
