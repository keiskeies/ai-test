"""D232 判据刀：功能用例批量编辑（优先级 / 模块）。

钉的契约（逐条对应 services.functional_case_batch_update 的 docstring）：

1. **至少给一个字段**：两个都不给 → 422 `empty_update`（不演「空更新却回 affected=N」）。
2. **module_set 哨兵**：`module_set=true+module_id=null` = 移到未分组；`module_set=false`
   时 priority-only 不动模块。
3. **模块须在本项目**：跨项目/不存在的模块 404，整批不动。
4. **重复 id → 422 整批不动**；空 case_ids 由 schema 422。
5. **只改正常态**：回收站行与跨项目 id 不参与，affected 只数真正改到的行；改到的行
   updated_by 落账，name/description/模板不变（批量编辑不是覆盖内容）。
6. **权限**：READONLY（只有 *:read）→ 403，库里的值一动不动。
"""
from __future__ import annotations

from sqlalchemy import text

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _module(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/functional-modules",
                          json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _case(client, h, pid: str, name: str, **kw) -> dict:
    r = await client.post(_BASE + "/functional-cases",
                          json={"project_id": pid, "name": name, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _batch(client, h, pid: str, ids: list[str], **kw):
    return await client.post(_BASE + "/functional-cases/batch-update",
                             json={"project_id": pid, "case_ids": ids, **kw}, headers=h)


async def _get(client, h, pid: str, cid: str) -> dict:
    r = await client.get(_BASE + f"/functional-cases/{cid}",
                         params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def test_priority_only_keeps_module_and_content(client, make_user) -> None:
    _, h = await make_user("d232a", admin=True)
    pid = await _proj(client, h, "D232优先级")
    mod = await _module(client, h, pid, "登录")
    c1 = await _case(client, h, pid, "用例甲", priority="P0", module_id=mod["id"],
                     description="原始描述")
    c2 = await _case(client, h, pid, "用例乙", priority="P2")

    r = await _batch(client, h, pid, [c1["id"]], priority="P1")
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "affected": 1}

    a = await _get(client, h, pid, c1["id"])
    assert a["priority"] == "P1"
    # 只改指定列：模块/名称/描述都没动。
    assert a["module_id"] == mod["id"] and a["name"] == "用例甲"
    assert a["description"] == "原始描述"
    # 未选中的用例一根毫毛不动。
    b = await _get(client, h, pid, c2["id"])
    assert b["priority"] == "P2" and b["module_id"] is None


async def test_module_set_sentinel(client, make_user) -> None:
    _, h = await make_user("d232b", admin=True)
    pid = await _proj(client, h, "D232模块")
    m1 = await _module(client, h, pid, "模块一")
    m2 = await _module(client, h, pid, "模块二")
    c1 = await _case(client, h, pid, "甲", module_id=m1["id"], priority="P0")
    c2 = await _case(client, h, pid, "乙", module_id=m1["id"], priority="P0")

    r = await _batch(client, h, pid, [c1["id"], c2["id"]],
                     module_set=True, module_id=m2["id"])
    assert r.status_code == 200 and r.json()["affected"] == 2, r.text
    assert (await _get(client, h, pid, c1["id"]))["module_id"] == m2["id"]
    assert (await _get(client, h, pid, c2["id"]))["module_id"] == m2["id"]
    # 优先级不在本请求里 → 保持 P0（module_set 不顺手清别的列）。
    assert (await _get(client, h, pid, c1["id"]))["priority"] == "P0"

    # module_set=true + module_id=null = 移到未分组（与「不改模块」的 false 是两件事）。
    r = await _batch(client, h, pid, [c1["id"]], module_set=True, module_id=None)
    assert r.status_code == 200, r.text
    assert (await _get(client, h, pid, c1["id"]))["module_id"] is None
    assert (await _get(client, h, pid, c2["id"]))["module_id"] == m2["id"]

    # priority-only（module_set=false）不动模块。
    r = await _batch(client, h, pid, [c2["id"]], priority="P3")
    assert r.status_code == 200, r.text
    assert (await _get(client, h, pid, c2["id"]))["module_id"] == m2["id"]
    assert (await _get(client, h, pid, c2["id"]))["priority"] == "P3"


async def test_empty_duplicate_and_bad_module_rejected(client, conn, make_user) -> None:
    _, h = await make_user("d232c", admin=True)
    pid = await _proj(client, h, "D232拒绝")
    c = await _case(client, h, pid, "甲", priority="P0")

    r = await _batch(client, h, pid, [c["id"]])
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "empty_update"

    r = await _batch(client, h, pid, [c["id"], c["id"]], priority="P1")
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "duplicate_case_ids"

    r = await _batch(client, h, pid, [], priority="P1")
    assert r.status_code == 422, r.text

    r = await _batch(client, h, pid, [c["id"]], module_set=True, module_id="no-such-module")
    assert r.status_code == 404, r.text

    # 两次拒绝之后库里的值仍是 P0、未分组（整批不动不是「部分改完再报错」）。
    got = await _get(client, h, pid, c["id"])
    assert got["priority"] == "P0" and got["module_id"] is None


async def test_only_normal_rows_in_this_project(client, conn, make_user) -> None:
    u, h = await make_user("d232d", admin=True)
    pid = await _proj(client, h, "D232范围甲")
    pid_b = await _proj(client, h, "D232范围乙")
    alive = await _case(client, h, pid, "正常")
    trashed = await _case(client, h, pid, "回收站")
    other = await _case(client, h, pid_b, "别项目")

    r = await client.post(_BASE + f"/functional-cases/{trashed['id']}/delete",
                          json={"project_id": pid, "case_id": trashed["id"]}, headers=h)
    assert r.status_code == 200, r.text

    r = await _batch(client, h, pid, [alive["id"], trashed["id"], other["id"]], priority="P3")
    assert r.status_code == 200, r.text
    assert r.json()["affected"] == 1  # 只改到本项目正常态那一行

    trashed_row = await conn.execute(
        text("SELECT status, priority FROM functional_case WHERE id=:i"), {"i": trashed["id"]}
    )
    status, priority = trashed_row.one()
    assert status == "recycled" and priority == "P2"

    other_row = await conn.execute(
        text("SELECT priority FROM functional_case WHERE id=:i"), {"i": other["id"]}
    )
    assert other_row.scalar_one() == "P2"

    alive_row = await conn.execute(
        text("SELECT priority, updated_by FROM functional_case WHERE id=:i"), {"i": alive["id"]}
    )
    got_priority, updated_by = alive_row.one()
    assert got_priority == "P3"
    assert updated_by == u.id  # 更新人落账（不是「没人改过」）


async def test_readonly_cannot_batch_update(client, conn, make_user) -> None:
    _, h = await make_user("d232e", admin=True)
    pid = await _proj(client, h, "D232只读")
    c = await _case(client, h, pid, "甲", priority="P0")

    ro, roh = await make_user("d232e_ro")
    r = await client.put(_BASE + f"/projects/{pid}/members/{ro.id}",
                         json={"role_code": "READONLY"}, headers=h)
    assert r.status_code == 200, r.text

    r = await _batch(client, roh, pid, [c["id"]], priority="P1")
    assert r.status_code == 403, r.text
    assert r.json()["details"]["perm"] == "functional:case:update"

    row = await conn.execute(
        text("SELECT priority FROM functional_case WHERE id=:i"), {"i": c["id"]}
    )
    assert row.scalar_one() == "P0"
