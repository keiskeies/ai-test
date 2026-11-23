"""D211 判据刀：计划模块树（MS TestPlanModule* 的等价面，但删模块不递归删计划）。

钉的契约：

1. **树 + 计数**：每个节点的 plan_count 是**直属**计划数（子模块的计划不并进父节点），
   未分组计划单独计数、不伪装成树里的假节点；归档计划的 module_id 不变，所以计入。
2. **同父重名 409**（含根层）：DB 约束在 parent_id NULL 时不拦，服务层是真正生效的门。
3. **防环 422**：把节点挂到自己或自己的后代 → cycle，不动库。
4. **删非空 409**：有子模块 / 有计划的模块拒绝删，且**一个计划都不删**（与 MS 的递归
   删计划相反——那是本仓明确拒绝的隐含级联）。
5. **跨项目与不存在同码同文案**：父模块/计划所属模块/删除目标都走同一句 404。
6. **列表过滤**：module_id = 该模块整棵子树；unassigned=true = 未分组；两者同传 422。
7. **权限**：READONLY 能读树、不能建/改/删；MEMBER 能建（`*`）不能删（`-*:delete`）。
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


async def _module(client, h, pid: str, name: str, parent_id: str | None = None, sort: int = 0) -> dict:
    r = await client.post(_BASE + "/plan-modules",
                          json={"project_id": pid, "parent_id": parent_id,
                                "name": name, "sort": sort}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _plan(client, h, pid: str, name: str, module_id: str | None = None) -> dict:
    body = {"project_id": pid, "name": name}
    if module_id is not None:
        body["module_id"] = module_id
    r = await client.post(_BASE + "/plans", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _tree(client, h, pid: str):
    return await client.get(_BASE + "/plan-modules/tree", params={"project_id": pid}, headers=h)


async def _count(conn, sql: str, **params) -> int:
    from sqlalchemy import text

    return int((await conn.execute(text(sql), params)).scalar_one())


async def test_tree_counts_are_direct_and_unassigned_is_separate(client, make_user) -> None:
    _, h = await make_user("d211a", admin=True)
    pid = await _proj(client, h, "D211树")
    root = await _module(client, h, pid, "根甲", sort=1)
    child = await _module(client, h, pid, "子甲", parent_id=root["id"])
    other = await _module(client, h, pid, "根乙", sort=2)
    await _plan(client, h, pid, "直属甲", root["id"])
    direct = await _plan(client, h, pid, "直属乙", root["id"])
    await _plan(client, h, pid, "子在子模块", child["id"])
    await _plan(client, h, pid, "在另一根", other["id"])
    await _plan(client, h, pid, "未分组一号")
    await _plan(client, h, pid, "未分组二号")

    r = await _tree(client, h, pid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["unassigned_count"] == 2
    nodes = body["nodes"]
    # 根按 (sort, name, id)：根甲(1) 在前、根乙(2) 在后。
    assert [n["name"] for n in nodes] == ["根甲", "根乙"]
    assert nodes[0]["plan_count"] == 2, "父节点的计数不并入子模块的计划"
    assert nodes[1]["plan_count"] == 1
    assert len(nodes[0]["children"]) == 1
    assert nodes[0]["children"][0]["name"] == "子甲"
    assert nodes[0]["children"][0]["plan_count"] == 1

    # 归档不改 module_id：归档后计数照旧（归档是列表过滤的事，不是树的事）。
    r = await client.post(_BASE + f"/plans/{direct['id']}/archive",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    r = await _tree(client, h, pid)
    assert r.json()["nodes"][0]["plan_count"] == 2


async def test_sibling_and_root_name_conflict(client, conn, make_user) -> None:
    _, h = await make_user("d211b", admin=True)
    pid = await _proj(client, h, "D211重名")
    root = await _module(client, h, pid, "同名")
    a = await _module(client, h, pid, "父")
    await _module(client, h, pid, "子", parent_id=a["id"])
    before = await _count(conn, "SELECT COUNT(*) FROM plan_module WHERE project_id=:p", p=pid)

    # 根层重名（DB 约束拦不住 parent_id NULL，靠服务层）
    r = await client.post(_BASE + "/plan-modules",
                          json={"project_id": pid, "name": "同名"}, headers=h)
    assert r.status_code == 409
    assert r.json()["details"]["name"] == "同名"
    # 同父重名
    r = await client.post(_BASE + "/plan-modules",
                          json={"project_id": pid, "parent_id": a["id"], "name": "子"}, headers=h)
    assert r.status_code == 409
    # 不同父同名允许（那是两个不同的节点）
    r = await client.post(_BASE + "/plan-modules",
                          json={"project_id": pid, "parent_id": root["id"], "name": "子"}, headers=h)
    assert r.status_code == 201, r.text
    assert await _count(conn, "SELECT COUNT(*) FROM plan_module WHERE project_id=:p",
                        p=pid) == before + 1


async def test_cycle_is_rejected(client, conn, make_user) -> None:
    _, h = await make_user("d211c", admin=True)
    pid = await _proj(client, h, "D211环")
    a = await _module(client, h, pid, "甲")
    b = await _module(client, h, pid, "乙", parent_id=a["id"])
    c = await _module(client, h, pid, "丙", parent_id=b["id"])

    # 挂到自己
    r = await client.patch(_BASE + f"/plan-modules/{a['id']}",
                           json={"project_id": pid, "parent_set": True, "parent_id": a["id"]},
                           headers=h)
    assert r.status_code == 422 and r.json()["code"] == "cycle"
    # 挂到自己的孙节点（甲 → 丙）会成环
    r = await client.patch(_BASE + f"/plan-modules/{a['id']}",
                           json={"project_id": pid, "parent_set": True, "parent_id": c["id"]},
                           headers=h)
    assert r.status_code == 422 and r.json()["code"] == "cycle"
    assert await _count(conn, "SELECT COUNT(*) FROM plan_module WHERE id=:m AND parent_id IS NULL",
                        m=a["id"]) == 1, "拒绝后父链一动不动"


async def test_delete_non_empty_refuses_and_spares_plans(client, conn, make_user) -> None:
    _, h = await make_user("d211d", admin=True)
    pid = await _proj(client, h, "D211非空")
    parent = await _module(client, h, pid, "父")
    await _module(client, h, pid, "子", parent_id=parent["id"])
    holder = await _module(client, h, pid, "有计划的")
    p = await _plan(client, h, pid, "别删我", holder["id"])

    r = await client.post(_BASE + f"/plan-modules/{parent['id']}/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 409
    assert r.json()["code"] == "module_not_empty"
    assert r.json()["details"]["children"] == 1

    r = await client.post(_BASE + f"/plan-modules/{holder['id']}/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 409
    assert r.json()["details"]["plans"] == 1
    # 计划一根毫毛没动（我们不做 MS 的递归删计划）
    assert await _count(conn, "SELECT COUNT(*) FROM plan_record WHERE id=:p", p=p["id"]) == 1

    # 腾空后可以删
    r = await client.patch(_BASE + f"/plans/{p['id']}",
                           json={"project_id": pid, "module_set": True, "module_id": None},
                           headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["module_id"] is None
    r = await client.post(_BASE + f"/plan-modules/{holder['id']}/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert await _count(conn, "SELECT COUNT(*) FROM plan_module WHERE id=:m", m=holder["id"]) == 0


async def test_cross_project_same_as_missing(client, make_user) -> None:
    _, h = await make_user("d211e", admin=True)
    pid_a = await _proj(client, h, "D211甲")
    pid_b = await _proj(client, h, "D211乙")
    mb = await _module(client, h, pid_b, "乙模块")
    plan_b = await _plan(client, h, pid_b, "乙计划", mb["id"])

    # 在甲项目里把乙的模块当父模块
    r = await client.post(_BASE + "/plan-modules",
                          json={"project_id": pid_a, "parent_id": mb["id"], "name": "越界"},
                          headers=h)
    assert r.status_code == 404 and r.json()["message"] == "模块不存在"
    # 在甲项目里把计划的模块设成乙的模块
    p = await _plan(client, h, pid_a, "甲计划")
    r = await client.patch(_BASE + f"/plans/{p['id']}",
                           json={"project_id": pid_a, "module_set": True, "module_id": mb["id"]},
                           headers=h)
    assert r.status_code == 404 and r.json()["message"] == "模块不存在"
    # 在甲项目里删乙的模块
    r = await client.post(_BASE + f"/plan-modules/{mb['id']}/delete",
                          json={"project_id": pid_a}, headers=h)
    assert r.status_code == 404 and r.json()["message"] == "模块不存在"
    # 乙的数据原样（模块在、计划的 module_id 还是它）
    r = await client.get(_BASE + f"/plans/{plan_b['id']}", params={"project_id": pid_b}, headers=h)
    assert r.status_code == 200 and r.json()["module_id"] == mb["id"]


async def test_list_filters_by_subtree_and_unassigned(client, make_user) -> None:
    _, h = await make_user("d211f", admin=True)
    pid = await _proj(client, h, "D211过滤")
    parent = await _module(client, h, pid, "父")
    child = await _module(client, h, pid, "子", parent_id=parent["id"])
    await _plan(client, h, pid, "父直属", parent["id"])
    await _plan(client, h, pid, "子里的", child["id"])
    loose = await _plan(client, h, pid, "未分组")

    async def names(**params):
        r = await client.get(_BASE + "/plans", params={"project_id": pid, **params}, headers=h)
        assert r.status_code == 200, r.text
        return {x["name"] for x in r.json()["items"]}

    assert await names(module_id=parent["id"]) == {"父直属", "子里的"}, "点父节点看整棵子树"
    assert await names(module_id=child["id"]) == {"子里的"}
    assert await names(unassigned=True) == {"未分组"}
    # 两者互斥
    r = await client.get(_BASE + "/plans",
                         params={"project_id": pid, "module_id": parent["id"], "unassigned": True},
                         headers=h)
    assert r.status_code == 422
    # 空模块返回空列表而不是 404
    empty = await _module(client, h, pid, "空模块")
    assert await names(module_id=empty["id"]) == set()
    # 移动计划到别的模块后，过滤结果跟着变
    r = await client.patch(_BASE + f"/plans/{loose['id']}",
                           json={"project_id": pid, "module_set": True, "module_id": child["id"]},
                           headers=h)
    assert r.status_code == 200, r.text
    assert await names(unassigned=True) == set()
    assert await names(module_id=child["id"]) == {"子里的", "未分组"}


async def test_gates(client, conn, make_user) -> None:
    _, h = await make_user("d211g", admin=True)
    pid = await _proj(client, h, "D211门")
    await _module(client, h, pid, "门模块")

    ro, roh = await make_user("d211ro")
    await _member(client, h, pid, ro.id, "READONLY")
    r = await _tree(client, roh, pid)
    assert r.status_code == 200, r.text
    r = await client.post(_BASE + "/plan-modules",
                          json={"project_id": pid, "name": "越权"}, headers=roh)
    assert r.status_code == 403
    assert r.json()["details"]["perm"] == "testplan:plan:create"

    mem, mh = await make_user("d211me")
    await _member(client, h, pid, mem.id, "MEMBER")
    r = await client.post(_BASE + "/plan-modules",
                          json={"project_id": pid, "name": "成员能建"}, headers=mh)
    assert r.status_code == 201, r.text
    mb = r.json()
    r = await client.patch(_BASE + f"/plan-modules/{mb['id']}",
                           json={"project_id": pid, "name": "改名"}, headers=mh)
    assert r.status_code == 200, r.text
    r = await client.post(_BASE + f"/plan-modules/{mb['id']}/delete",
                          json={"project_id": pid}, headers=mh)
    assert r.status_code == 403  # MEMBER 的 -*:delete
    assert r.json()["details"]["perm"] == "testplan:plan:delete"
    assert await _count(conn, "SELECT COUNT(*) FROM plan_module WHERE id=:m", m=mb["id"]) == 1

    pa, pah = await make_user("d211pa")
    await _member(client, h, pid, pa.id, "PROJECT_ADMIN")
    r = await client.post(_BASE + f"/plan-modules/{mb['id']}/delete",
                          json={"project_id": pid}, headers=pah)
    assert r.status_code == 200, r.text
