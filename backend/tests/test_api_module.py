"""T9 API 模块树：无限级、环检测、回收站（§4.4）。"""
from __future__ import annotations


async def _setup(client, make_user, tag):
    boss, hb = await make_user("mod9boss" + tag)
    r = await client.post("/api/v1/projects", json={"name": "p9" + tag}, headers=hb)
    return boss, hb, r.json()["id"]


async def _mk(client, h, pid, name, parent=None):
    body = {"project_id": pid, "name": name}
    if parent:
        body["parent_id"] = parent
    r = await client.post("/api/v1/api-modules", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def test_tree_structure_and_counts(client, make_user) -> None:
    """树形状 + **徽标子树口径**（D47-b §五·1 业主裁定，推翻 T23/R120 的直属计数）。

    本用例以前钉的是旧口径（根 `count == 0` 而它子树里有 2 条），那句正是业主本轮推翻的
    东西，所以它是**按裁定被改**、不是被改坏的。种子刻意让「直属 ≠ 子树」：
    下单直属 2、批量直属 1 ⇒ 下单 3、交易 3、批量 1。
    谁把 roll-up 摘回直属，三条断言分别得 0/2/1 —— 三条全红，不靠某条碰巧。
    """
    _, h, pid = await _setup(client, make_user, "A")
    root = await _mk(client, h, pid, "交易")
    mid = await _mk(client, h, pid, "下单", root["id"])
    leaf = await _mk(client, h, pid, "批量", mid["id"])
    for name, mod in (("创建订单", mid), ("取消订单", mid), ("批量下单", leaf)):
        rr = await client.post("/api/v1/api-definitions", json={
            "project_id": pid, "name": name, "method": "GET", "path": "/o",
            "module_id": mod["id"], "request": {"method": "GET", "url": "http://t/o"}}, headers=h)
        assert rr.status_code == 201, rr.text
    r = await client.get("/api/v1/api-modules", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    tree = r.json()["tree"]
    assert len(tree) == 1
    n1 = tree[0]
    assert n1["name"] == "交易" and n1["count"] == 3, \
        "根徽标必须是子树合计 3（直属口径会给 0）：实得 " + str(n1["count"])
    n2 = n1["children"][0]
    assert n2["name"] == "下单" and n2["count"] == 3, \
        "中间层徽标必须是子树合计 3（直属口径会给 2）：实得 " + str(n2["count"])
    n3 = n2["children"][0]
    assert n3["id"] == leaf["id"], "第三层挂在下单下"  # 树形状部分原样保留
    assert n3["count"] == 1, "叶子徽标 = 直属 = 子树（它没孩子可加）：实得 " + str(n3["count"])


async def test_cycle_and_duplicate(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "B")
    a = await _mk(client, h, pid, "A")
    b = await _mk(client, h, pid, "B", a["id"])
    c = await _mk(client, h, pid, "C", b["id"])
    # A 挂到自己孙子 C 下 → 400
    r = await client.patch("/api/v1/api-modules/" + a["id"],
                           json={"project_id": pid, "parent_id": c["id"]}, headers=h)
    assert r.status_code == 400 and r.json()["code"] == "invalid_input"
    # 挂到自己下 → 400
    r2 = await client.patch("/api/v1/api-modules/" + a["id"],
                            json={"project_id": pid, "parent_id": a["id"]}, headers=h)
    assert r2.status_code == 400
    # 同父重名 → 409
    r3 = await client.post("/api/v1/api-modules", json={"project_id": pid, "name": "B",
                                "parent_id": a["id"]}, headers=h)
    assert r3.status_code == 409
    # 正常移动 B → 根：ok
    r4 = await client.patch("/api/v1/api-modules/" + b["id"],
                            json={"project_id": pid, "parent_id": None}, headers=h)
    assert r4.status_code == 200, r4.text
    r5 = await client.get("/api/v1/api-modules", params={"project_id": pid}, headers=h)
    assert {n["name"] for n in r5.json()["tree"]} == {"A", "B"}


async def test_recycle_restore(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "C")
    top = await _mk(client, h, pid, "顶层")
    mid = await _mk(client, h, pid, "中层", top["id"])
    low = await _mk(client, h, pid, "下层", mid["id"])  # noqa: F841 -> used below
    r = await client.post("/api/v1/api-modules/" + mid["id"] + "/delete",
                          json={"project_id": pid, "module_id": mid["id"]}, headers=h)
    assert r.status_code == 200, r.text
    r2 = await client.get("/api/v1/api-modules", params={"project_id": pid}, headers=h)
    names = {n["name"] for n in r2.json()["tree"]}
    assert names == {"顶层"}  # 中层+下层都不在默认视图
    r3 = await client.get("/api/v1/api-modules",
                          params={"project_id": pid, "include_recycled": True}, headers=h)
    rec = r3.json()["recycled"]
    assert [x["name"] for x in rec] == ["中层"]  # 只回收集群根，子孙挂在 children 里
    assert rec[0]["children"][0]["id"] == low["id"]  # 下层随中层一起回收
    # 恢复中层 → 下层随之回归
    r4 = await client.post("/api/v1/api-modules/" + mid["id"] + "/restore",
                           json={"project_id": pid, "module_id": mid["id"]}, headers=h)
    assert r4.status_code == 200
    r5 = await client.get("/api/v1/api-modules", params={"project_id": pid}, headers=h)
    def walk(ns):
        out = set()
        for n in ns:
            out.add(n["name"])
            out |= walk(n["children"])
        return out
    assert walk(r5.json()["tree"]) == {"顶层", "中层", "下层"}
    # 删除是 destructive：MEMBER 成员无 *:delete → 403
    other, ho = await make_user("mod9mem")
    await client.put("/api/v1/projects/" + pid + "/members/" + other.id,
                     json={"role_code": "MEMBER"}, headers=h)
    r6 = await client.post("/api/v1/api-modules/" + top["id"] + "/delete",
                           json={"project_id": pid, "module_id": top["id"]}, headers=ho)
    assert r6.status_code == 403
    # 非成员连看都不可见
    _, hg = await make_user("mod9out")
    r7 = await client.get("/api/v1/api-modules", params={"project_id": pid}, headers=hg)
    assert r7.status_code == 403


async def test_module_delete_keeps_definitions(client, make_user) -> None:
    # 模块回收不删接口；接口 module_id 保留（恢复后可见）
    _, h, pid = await _setup(client, make_user, "D")
    m = await _mk(client, h, pid, "待回收")
    rd = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "留存接口", "method": "GET", "path": "/k",
        "module_id": m["id"], "request": {"method": "GET", "url": "http://t/k"}}, headers=h)
    did = rd.json()["id"]
    await client.post("/api/v1/api-modules/" + m["id"] + "/delete",
                      json={"project_id": pid, "module_id": m["id"]}, headers=h)
    r = await client.get("/api/v1/api-definitions/" + did, params={"project_id": pid}, headers=h)
    assert r.status_code == 200 and r.json()["module_id"] == m["id"]


async def test_recycled_module_name_says_so(client, make_user) -> None:
    """回收站里的模块名仍然占着 uq_module_parent_name：报错必须说清这一点。

    查重只看 status="normal"（否则恢复出来的模块会跟自己的墓碑打架），
    于是同名新建会绕过应用层查重、撞在数据库唯一键上，
    兜底处理器只会回"数据唯一性冲突"——用户既不知道撞了谁，也不知道该恢复还是改名。
    """
    _, h, pid = await _setup(client, make_user, "E")
    m = await _mk(client, h, pid, "支付")
    r = await client.post("/api/v1/api-modules/" + m["id"] + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text

    dup = await client.post("/api/v1/api-modules", json={"project_id": pid, "name": "支付"}, headers=h)
    assert dup.status_code == 409, dup.text
    assert dup.json()["code"] == "conflict"
    assert "回收站" in dup.json()["message"], dup.json()["message"]
    assert dup.json()["details"]["name"] == "支付"

    # 恢复之后，同名照样建不出来（正常视图的查重不变）
    assert (await client.post("/api/v1/api-modules/" + m["id"] + "/restore",
                              json={"project_id": pid}, headers=h)).status_code == 200
    dup2 = await client.post("/api/v1/api-modules", json={"project_id": pid, "name": "支付"}, headers=h)
    assert dup2.status_code == 409 and "回收站" not in dup2.json()["message"], dup2.text


async def test_module_purge_detaches_definitions(client, make_user) -> None:
    """模块彻底删除：删的是模块族谱，接口搬去「未分类」，不是跟着陪葬。

    接口是资产、模块是收纳方式；§11.4 从没说过删收纳盒要烧掉里面的东西，
    而且接口自己还有回收站可以走。误删整棵模块树不该等于误删一批接口。
    """
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("api_module_purge")
    assert spec is not None and spec.effect == "destructive" and spec.perm == "api:module:delete"
    assert spec.tool is False, "彻底删除不进 Pilot 工具箱：不可逆操作只走人工 UI"

    _, h, pid = await _setup(client, make_user, "F")
    top = await _mk(client, h, pid, "交易链路")
    sub = await _mk(client, h, pid, "下单", top["id"])
    keep = await _mk(client, h, pid, "留着")
    did = (await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "查询订单", "method": "GET", "path": "/o",
        "module_id": sub["id"], "request": {"method": "GET", "url": "http://t/o"}}, headers=h)).json()["id"]

    # 先回收整棵子树
    assert (await client.post("/api/v1/api-modules/" + top["id"] + "/delete",
            json={"project_id": pid}, headers=h)).status_code == 200

    # 没回收的模块不许直接彻底删除
    live = await client.post("/api/v1/api-modules/" + keep["id"] + "/purge",
                             json={"project_id": pid, "confirm_name": "留着"}, headers=h)
    assert live.status_code == 409 and live.json()["code"] == "not_recycled", live.text

    # 名字差一个字就不删
    wrong = await client.post("/api/v1/api-modules/" + top["id"] + "/purge",
                              json={"project_id": pid, "confirm_name": "交易"}, headers=h)
    assert wrong.status_code == 409 and wrong.json()["code"] == "name_mismatch", wrong.text

    ok = await client.post("/api/v1/api-modules/" + top["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "交易链路"}, headers=h)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["purged_modules"] == 2, body
    assert body["detached_definitions"] == 1, body

    # 接口还在，只是不再有归属模块；回收站空了；同名模块重新建得出来
    r = await client.get("/api/v1/api-definitions/" + did, params={"project_id": pid}, headers=h)
    assert r.status_code == 200 and r.json()["module_id"] is None, r.text
    tree = (await client.get("/api/v1/api-modules", params={
        "project_id": pid, "include_recycled": "true"}, headers=h)).json()
    assert tree["recycled"] == [], tree["recycled"]
    assert [n["name"] for n in tree["tree"]] == ["留着"]
    again = await client.post("/api/v1/api-modules", json={"project_id": pid, "name": "交易链路"}, headers=h)
    assert again.status_code == 201, again.text

    # 模块没了，再删一次就是 404
    gone = await client.post("/api/v1/api-modules/" + top["id"] + "/purge",
                             json={"project_id": pid, "confirm_name": "交易链路"}, headers=h)
    assert gone.status_code == 404, gone.text


async def test_module_purge_refuses_mixed_family(client, make_user) -> None:
    """族谱状态不一致时宁可不动手：正常视图里看得见的模块，绝不能在后台被删掉。"""
    from app.core.db import get_sessionmaker
    from app.modules.api_test.models import ApiModule

    _, h, pid = await _setup(client, make_user, "G")
    top = await _mk(client, h, pid, "父")
    child = await _mk(client, h, pid, "子", top["id"])
    await client.post("/api/v1/api-modules/" + top["id"] + "/delete",
                      json={"project_id": pid}, headers=h)
    # 人为造脏数据：父回收了、子还正常（正常操作到不了这个状态，防的是历史脏库）
    async with get_sessionmaker()() as s:
        row = (await s.get(ApiModule, child["id"]))
        row.status = "normal"
        await s.commit()

    r = await client.post("/api/v1/api-modules/" + top["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "父"}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "state_conflict", r.text
    # 一个都没删：父和子都还在
    assert (await client.get("/api/v1/api-modules", params={
        "project_id": pid, "include_recycled": "true"}, headers=h)).json()["recycled"] != []

