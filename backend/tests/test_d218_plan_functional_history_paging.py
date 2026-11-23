"""D218 判据刀：计划内功能用例结论历史的分页（append-only 流水的页脚口径）。

D204 交付时历史是一次全量；一条用例反复改判后响应没有上限。本刀补页码分页，
钉的契约：

1. **默认 20 条/页**，`current` 从 1 起；`size` 夹在 1..200，越界 422。
2. **newest-first**：`seq` 倒序（同秒两次改判靠 seq 定先后，D204 已踩过 DATETIME 秒精度）。
3. **total 与 items 同一份 WHERE**：页脚数的是这条 link 的历史，不是全表/全计划。
4. **翻页不重不漏**：size=2 时第 1 页 2 条、第 2 页 1 条，seq 集合无交集。
"""
from __future__ import annotations

from app.modules.functional.models import FunctionalCase

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _plan(client, h, pid: str) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": "D218计划"}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _seed_case(session, pid: str) -> None:
    session.add(FunctionalCase(id="fc-d218", project_id=pid, num=1, name="登录用例",
                               template_id="tpl-seed"))
    await session.commit()


async def _link(client, h, pid: str, plan_id: str) -> str:
    r = await client.post(_BASE + f"/plans/{plan_id}/case-links",
                          json={"project_id": pid, "subject_type": "functional_case",
                                "subject_id": "fc-d218"}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _execute(client, h, pid: str, plan_id: str, link_id: str, result: str, comment: str) -> None:
    r = await client.post(_BASE + f"/plans/{plan_id}/functional-cases/execute",
                          json={"project_id": pid, "link_ids": [link_id],
                                "result": result, "comment": comment}, headers=h)
    assert r.status_code == 200, r.text


async def _history(client, h, pid: str, plan_id: str, link_id: str, **params):
    return await client.get(
        _BASE + f"/plans/{plan_id}/functional-cases/{link_id}/history",
        params=[("project_id", pid)] + [(k, str(v)) for k, v in params.items()],
        headers=h,
    )


async def test_history_is_paged_newest_first(client, session, make_user) -> None:
    _, h = await make_user("d218a", admin=True)
    pid = await _proj(client, h, "D218分页")
    plan = await _plan(client, h, pid)
    await _seed_case(session, pid)
    link_id = await _link(client, h, pid, plan["id"])
    await _execute(client, h, pid, plan["id"], link_id, "fail", "第一次：登录 500")
    await _execute(client, h, pid, plan["id"], link_id, "blocked", "第二次：依赖环境挂了")
    await _execute(client, h, pid, plan["id"], link_id, "pass", "第三次：修复后通过")

    r = await _history(client, h, pid, plan["id"], link_id, size=2, current=1)
    assert r.status_code == 200, r.text
    p1 = r.json()
    assert p1["total"] == 3, "total 必须数这条 link 的历史（3 次改判）"
    assert [x["seq"] for x in p1["items"]] == [3, 2], "newest-first：seq 倒序"
    assert p1["items"][0]["result"] == "pass"
    assert p1["items"][0]["comment"] == "第三次：修复后通过"

    r2 = await _history(client, h, pid, plan["id"], link_id, size=2, current=2)
    assert r2.status_code == 200, r2.text
    p2 = r2.json()
    assert p2["total"] == 3, "翻页时 total 不随页变化"
    assert [x["seq"] for x in p2["items"]] == [1]
    assert set(x["seq"] for x in p1["items"]) & set(x["seq"] for x in p2["items"]) == set(), \
        "两页不许重复同一行"


async def test_history_page_bounds(client, session, make_user) -> None:
    _, h = await make_user("d218b", admin=True)
    pid = await _proj(client, h, "D218边界")
    plan = await _plan(client, h, pid)
    await _seed_case(session, pid)
    link_id = await _link(client, h, pid, plan["id"])
    await _execute(client, h, pid, plan["id"], link_id, "pass", "只有一次")

    # 默认值：不传 current/size 也能拿到第 1 页 + total（老前端不传参不会 500）
    r = await _history(client, h, pid, plan["id"], link_id)
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 1
    assert [x["seq"] for x in r.json()["items"]] == [1]

    # 越界由 pydantic 拦：size=0 / size=201 / current=0 都是 422，不落到 SQL 的 OFFSET
    for bad in ({"size": 0}, {"size": 201}, {"current": 0}):
        rb = await _history(client, h, pid, plan["id"], link_id, **bad)
        assert rb.status_code == 422, (bad, rb.text)

    # 超过末页 = 空 items，但 total 仍是 1（「没有更多」与「没有历史」是两句话）
    re = await _history(client, h, pid, plan["id"], link_id, current=9)
    assert re.status_code == 200, re.text
    assert re.json()["items"] == []
    assert re.json()["total"] == 1
