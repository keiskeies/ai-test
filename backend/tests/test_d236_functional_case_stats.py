"""D236 判据刀：功能用例统计（MS `/report/test/case/count/getReport` 的 X 轴子集）。

钉的契约（每一条都能在 services.py 的 `functional_case_stats` 指到实现）：

1. **两个总数并排**：`total` 吃当前视图（`recycled` 开关），`recycled_total` 永远是
   回收站行数——删一条再问，total 减 1 而 recycled_total 加 1，不是同一个数换名字。
2. **分组之和 = total**：同一份 where 分两路取数；优先级四个值全列出（缺的记 0，
   横轴不因数据缺口变形）。
3. **模块分组**：`module_id=null` 归「未分类」（key=""），有模块的按名字出；顺序是
   计数降序，同数按名字。
4. **创建人分组**：按 `created_by` 现查 app_user 的姓名；两个作者各一份，计数如实。
5. **跨项目隔离**：别项目的同优先级/同模块用例不串入（`project_id` 是硬边界）。
6. **权限**：READONLY 可调（只读）；非成员 403；`group_by` 写错是 422（Literal），
   不静默退回默认轴。
"""
from __future__ import annotations

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _module(client, h, pid: str, name: str) -> str:
    r = await client.post(_BASE + "/functional-modules",
                          json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _case(client, h, pid: str, name: str, **kw) -> dict:
    r = await client.post(_BASE + "/functional-cases",
                          json={"project_id": pid, "name": name, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _stats(client, h, pid: str, **body):
    return await client.post(_BASE + "/functional-cases/stats",
                             json={"project_id": pid, **body}, headers=h)


async def _recycle(client, h, pid: str, case_id: str) -> None:
    r = await client.post(_BASE + f"/functional-cases/{case_id}/delete",
                          json={"project_id": pid, "case_id": case_id}, headers=h)
    assert r.status_code == 200, r.text


async def test_priority_counts_and_two_totals(client, make_user) -> None:
    _, h = await make_user("d236a", admin=True)
    pid = await _proj(client, h, "D236优先级")
    p0 = await _case(client, h, pid, "甲", priority="P0")
    await _case(client, h, pid, "乙", priority="P2")
    await _case(client, h, pid, "丙", priority="P2")

    r = await _stats(client, h, pid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["group_by"] == "priority"
    assert body["total"] == 3 and body["recycled_total"] == 0
    # 四个优先级全部列出，缺的记 0（横轴不因数据缺口变形）
    assert body["groups"] == [
        {"key": "P0", "label": "P0", "count": 1},
        {"key": "P1", "label": "P1", "count": 0},
        {"key": "P2", "label": "P2", "count": 2},
        {"key": "P3", "label": "P3", "count": 0},
    ]
    assert sum(g["count"] for g in body["groups"]) == body["total"]

    await _recycle(client, h, pid, p0["id"])
    normal = (await _stats(client, h, pid)).json()
    assert normal["total"] == 2 and normal["recycled_total"] == 1

    trash = (await _stats(client, h, pid, recycled=True)).json()
    assert trash["total"] == 1 and trash["recycled_total"] == 1
    assert {g["key"]: g["count"] for g in trash["groups"]} == {
        "P0": 1, "P1": 0, "P2": 0, "P3": 0,
    }


async def test_module_grouping_includes_unfiled(client, make_user) -> None:
    _, h = await make_user("d236b", admin=True)
    pid = await _proj(client, h, "D236模块")
    mid = await _module(client, h, pid, "登录模块")
    await _case(client, h, pid, "甲", module_id=mid)
    await _case(client, h, pid, "乙", module_id=mid)
    await _case(client, h, pid, "丙")  # 未分类

    r = await _stats(client, h, pid, group_by="module")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 3
    assert body["groups"] == [
        {"key": mid, "label": "登录模块", "count": 2},
        {"key": "", "label": "未分类", "count": 1},
    ]
    assert sum(g["count"] for g in body["groups"]) == body["total"]


async def test_creator_grouping_and_cross_project_isolation(client, make_user) -> None:
    admin, h = await make_user("d236c", admin=True)
    other, oh = await make_user("d236c2")
    pid = await _proj(client, h, "D236甲")
    pid_b = await _proj(client, h, "D236乙")
    await _member(client, h, pid, other.id, "MEMBER")

    await _case(client, h, pid, "管理员建的")
    await _case(client, oh, pid, "成员建的")
    await _case(client, h, pid_b, "别项目的同优先级")  # 不得串入

    r = await _stats(client, h, pid, group_by="creator")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 2
    by_key = {g["key"]: (g["label"], g["count"]) for g in body["groups"]}
    assert by_key[admin.id] == (admin.name, 1)
    assert by_key[other.id] == (other.name, 1)


async def test_permissions_and_bad_group_by(client, make_user) -> None:
    _, h = await make_user("d236d", admin=True)
    pid = await _proj(client, h, "D236权限")
    await _case(client, h, pid, "甲")

    ro, roh = await make_user("d236d_ro")
    await _member(client, h, pid, ro.id, "READONLY")
    assert (await _stats(client, roh, pid)).status_code == 200  # 统计是只读

    _, stranger_h = await make_user("d236d_out")
    r = await _stats(client, stranger_h, pid)
    assert r.status_code == 403, r.text

    r = await _stats(client, h, pid, group_by="status")
    assert r.status_code == 422, r.text  # 不静默退回默认轴
