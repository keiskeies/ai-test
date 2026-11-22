"""1C T6 UI 模块树（R99 第三棵树）：无限级、环检测、软删后代、根层重名、资产不陪葬。

这棵树与前两棵（api_module / scenario_module）的**唯一**实质差异：它一棵树服务两类资产
（元素 + UI 用例），所以节点上除了共用的 `count` 还有 `element_count` / `case_count`。
`test_tree_counts_split_by_asset_type` 钉这条——共用 count 会让元素库徽标把用例数也算进去。
"""
from __future__ import annotations

from typing import Any

from httpx import AsyncClient


async def _setup(client: AsyncClient, make_user, tag: str):
    boss, hb = await make_user("uimboss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "uim" + tag}, headers=hb)).json()["id"]
    return boss, hb, pid


async def _mk(client: AsyncClient, h, pid, name, parent=None) -> dict[str, Any]:
    body: dict[str, Any] = {"project_id": pid, "name": name}
    if parent:
        body["parent_id"] = parent
    r = await client.post("/api/v1/ui-modules", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _tree(client: AsyncClient, h, pid, **params):
    r = await client.get("/api/v1/ui-modules", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _el(client: AsyncClient, h, pid, name, module_id=None) -> dict[str, Any]:
    body: dict[str, Any] = {"project_id": pid, "name": name, "locator_type": "css", "locator": "#" + name}
    if module_id:
        body["module_id"] = module_id
    r = await client.post("/api/v1/ui-elements", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _case(client: AsyncClient, h, pid, name, module_id=None) -> dict[str, Any]:
    body: dict[str, Any] = {"project_id": pid, "name": name, "steps": [
        {"id": "open1", "type": "open", "input": "/ui/home"}]}
    if module_id:
        body["module_id"] = module_id
    r = await client.post("/api/v1/ui-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _names(nodes):
    out = set()
    for n in nodes:
        out.add(n["name"])
        out |= _names(n["children"])
    return out


async def test_tree_is_unbounded_depth_with_direct_counts(client: AsyncClient, make_user) -> None:
    """⑤ 无限级 + 直属计数（不算子孙）。"""
    _, h, pid = await _setup(client, make_user, "A")
    root = await _mk(client, h, pid, "交易链路")
    mid = await _mk(client, h, pid, "下单", root["id"])
    leaf = await _mk(client, h, pid, "批量", mid["id"])
    deep = await _mk(client, h, pid, "第四层", leaf["id"])
    await _el(client, h, pid, "e1", mid["id"])
    await _case(client, h, pid, "c1", mid["id"])
    await _case(client, h, pid, "c2", deep["id"])

    tree = (await _tree(client, h, pid))["tree"]
    assert len(tree) == 1 and tree[0]["name"] == "交易链路"
    # 根的 count 只算直属：子孙的 3 项资产一个都不许冒上来
    assert tree[0]["count"] == 0 and tree[0]["element_count"] == 0 and tree[0]["case_count"] == 0
    n1 = tree[0]["children"][0]
    assert n1["name"] == "下单" and n1["count"] == 2
    n2 = n1["children"][0]
    assert n2["name"] == "批量" and n2["count"] == 0
    assert n2["children"][0]["name"] == "第四层" and n2["children"][0]["count"] == 1
    assert _names(tree) == {"交易链路", "下单", "批量", "第四层"}


async def test_tree_counts_split_by_asset_type(client: AsyncClient, make_user) -> None:
    """第三棵树的特有形状：count 是两者之和，分列给 element_count / case_count。

    元素库页读 count 会把用例数算进徽标（1 元素 + 2 用例 → 徽标 3、列表 1 行），
    那是「界面说错话」，所以后端一开始就把三个数都给出，页面各读各的。
    """
    _, h, pid = await _setup(client, make_user, "B")
    m = await _mk(client, h, pid, "登录页")
    await _el(client, h, pid, "账号框", m["id"])
    await _case(client, h, pid, "登录成功", m["id"])
    await _case(client, h, pid, "登录失败", m["id"])
    node = (await _tree(client, h, pid))["tree"][0]
    assert (node["element_count"], node["case_count"], node["count"]) == (1, 2, 3)
    # 回收的用例不计数（与列表口径一致）：多建一条再扔进回收站，三个数都不许动
    tmp = await _case(client, h, pid, "临时", m["id"])
    assert (await client.post("/api/v1/ui-cases/" + tmp["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    node2 = (await _tree(client, h, pid))["tree"][0]
    assert (node2["element_count"], node2["case_count"], node2["count"]) == (1, 2, 3)


async def test_root_level_duplicate_is_blocked_by_service(client: AsyncClient, make_user) -> None:
    """⑤ 根层同名被**服务层**拦住：MySQL 唯一键不判等 NULL，DB 约束管不到根层。

    这条测试是 1A 在 api_module、1B 在 scenario_module 各踩一次之后立下的第三次。
    """
    _, h, pid = await _setup(client, make_user, "C")
    a = await _mk(client, h, pid, "登录页")
    r = await client.post("/api/v1/ui-modules", json={"project_id": pid, "name": "登录页"}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "conflict", r.text
    # 同父重名也拦（这条 DB 管得住，但服务层先给出可读文案）
    b = await _mk(client, h, pid, "子页", a["id"])
    r2 = await client.post("/api/v1/ui-modules", json={"project_id": pid, "name": "子页", "parent_id": a["id"]},
                           headers=h)
    assert r2.status_code == 409, r2.text
    # 不同父可同名（树的手感）
    assert (await client.post("/api/v1/ui-modules", json={"project_id": pid, "name": "子页"},
                              headers=h)).status_code == 201
    # 回收站里的同名同样占位
    await client.post("/api/v1/ui-modules/" + b["id"] + "/delete", json={"project_id": pid}, headers=h)
    r3 = await client.post("/api/v1/ui-modules", json={"project_id": pid, "name": "子页", "parent_id": a["id"]},
                           headers=h)
    assert r3.status_code == 409 and "回收站" in r3.json()["message"], r3.text


async def test_cycle_and_self_parent_rejected(client: AsyncClient, make_user) -> None:
    """移动成环 / 挂到自己下面 → 400。"""
    _, h, pid = await _setup(client, make_user, "D")
    a = await _mk(client, h, pid, "A")
    b = await _mk(client, h, pid, "B", a["id"])
    c = await _mk(client, h, pid, "C", b["id"])
    r = await client.patch("/api/v1/ui-modules/" + a["id"],
                           json={"project_id": pid, "parent_id": c["id"]}, headers=h)
    assert r.status_code == 400 and r.json()["code"] == "invalid_input", r.text
    assert (await client.patch("/api/v1/ui-modules/" + a["id"],
                               json={"project_id": pid, "parent_id": a["id"]}, headers=h)).status_code == 400
    # 正常移动：B 提到根
    ok = await client.patch("/api/v1/ui-modules/" + b["id"], json={"project_id": pid, "parent_id": None},
                            headers=h)
    assert ok.status_code == 200 and ok.json()["parent_id"] is None, ok.text
    tree = (await _tree(client, h, pid))["tree"]
    assert {n["name"] for n in tree} == {"A", "B"}


async def test_delete_hides_whole_subtree_and_restore_brings_it_back(client: AsyncClient, make_user) -> None:
    """删中间节点 → 整枝从正常树消失；回收站只列回收根；恢复后原样回归。"""
    _, h, pid = await _setup(client, make_user, "E")
    root = await _mk(client, h, pid, "根")
    mid = await _mk(client, h, pid, "中", root["id"])
    await _mk(client, h, pid, "叶", mid["id"])
    e = await _el(client, h, pid, "枝上的元素", mid["id"])

    await client.post("/api/v1/ui-modules/" + mid["id"] + "/delete", json={"project_id": pid}, headers=h)
    tree = (await _tree(client, h, pid))["tree"]
    assert _names(tree) == {"根"}, "子孙得跟着藏，不然树里会出现挂在隐藏节点下的孤儿枝"
    rec = (await _tree(client, h, pid, include_recycled=True))["recycled"]
    assert [n["name"] for n in rec] == ["中"], "回收站列回收根，子孙挂在它下面"
    assert rec[0]["children"][0]["name"] == "叶"
    # 元素没被删，只是父模块看不见了 → 列表仍看得见它（模块是收纳方式）
    rows = (await client.get("/api/v1/ui-elements", params={"project_id": pid}, headers=h)).json()["items"]
    assert [i["id"] for i in rows] == [e["id"]]

    await client.post("/api/v1/ui-modules/" + mid["id"] + "/restore", json={"project_id": pid}, headers=h)
    assert _names((await _tree(client, h, pid))["tree"]) == {"根", "中", "叶"}
    # 元素一直没被碰过：模块回收只动树的可见性，不动资产
    assert (await client.get("/api/v1/ui-elements/" + e["id"], params={"project_id": pid},
                             headers=h)).status_code == 200


async def test_restore_of_child_under_recycled_parent_rescues_ancestors(client: AsyncClient, make_user) -> None:
    """恢复一个父级仍在回收站的孩子 → 祖先链一起回归。

    只把自己拨回 normal 会产出一枝挂在隐藏节点下的孤儿：树里看不见、又确实存在，
    是最难排查的那种状态。
    """
    _, h, pid = await _setup(client, make_user, "F")
    g = await _mk(client, h, pid, "爷爷")
    f = await _mk(client, h, pid, "父亲", g["id"])  # noqa: E741
    s = await _mk(client, h, pid, "孩子", f["id"])
    await client.post("/api/v1/ui-modules/" + f["id"] + "/delete", json={"project_id": pid}, headers=h)
    assert _names((await _tree(client, h, pid))["tree"]) == {"爷爷"}

    r = await client.post("/api/v1/ui-modules/" + s["id"] + "/restore", json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    assert _names((await _tree(client, h, pid))["tree"]) == {"爷爷", "父亲", "孩子"}


async def test_purge_detaches_assets_but_never_deletes_them(client: AsyncClient, make_user) -> None:
    """⑥ 彻底删除模块 → 元素与用例都还在，只是 module_id 变 None（模块是收纳方式）。"""
    _, h, pid = await _setup(client, make_user, "G")
    root = await _mk(client, h, pid, "要被删的模块")
    kid = await _mk(client, h, pid, "它的子模块", root["id"])
    e = await _el(client, h, pid, "元素在子模块里", kid["id"])
    c = await _case(client, h, pid, "用例在根模块里", root["id"])

    for m in (kid, root):
        assert (await client.post("/api/v1/ui-modules/" + m["id"] + "/delete",
                                  json={"project_id": pid}, headers=h)).status_code == 200
    # 输名确认（R53）
    bad = await client.post("/api/v1/ui-modules/" + root["id"] + "/purge",
                            json={"project_id": pid, "confirm_name": "要被删的模块 "}, headers=h)
    assert bad.status_code == 409 and bad.json()["code"] == "name_mismatch", bad.text
    ok = await client.post("/api/v1/ui-modules/" + root["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "要被删的模块"}, headers=h)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["purged_modules"] == 2 and body["detached_elements"] == 1 and body["detached_cases"] == 1

    # 资产活着且归未分类
    got_e = await client.get("/api/v1/ui-elements/" + e["id"], params={"project_id": pid}, headers=h)
    assert got_e.status_code == 200 and got_e.json()["module_id"] is None
    got_c = await client.get("/api/v1/ui-cases/" + c["id"], params={"project_id": pid}, headers=h)
    assert got_c.status_code == 200 and got_c.json()["module_id"] is None
    # 未分类筛选项立刻能查到它们
    assert [i["id"] for i in (await client.get("/api/v1/ui-elements", params={
        "project_id": pid, "unfiled_only": True}, headers=h)).json()["items"]] == [e["id"]]
    assert (await _tree(client, h, pid))["tree"] == []


async def test_purge_refuses_subtree_with_normal_child(client: AsyncClient, make_user) -> None:
    """族谱状态不一致时宁可不动手（防历史脏库）：子树里还有正常节点就不许 purge。

    照搬 `test_api_module.py::test_module_purge_refuses_mixed_family` 的造脏手法：
    正常操作到不了这个状态（delete 会把子孙一起回收），所以不能用「先回收再单独恢复孩子」
    来造——那条路会把祖先链也救回来（见 ui_module_restore），父子又同归于 normal。
    真状态只能直接写库。
    """
    from app.core.db import get_sessionmaker
    from app.modules.ui_test.models import UiModule

    _, h, pid = await _setup(client, make_user, "H")
    root = await _mk(client, h, pid, "父")
    kid = await _mk(client, h, pid, "还活着的子", root["id"])
    assert (await client.post("/api/v1/ui-modules/" + root["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    async with get_sessionmaker()() as s:
        row = await s.get(UiModule, kid["id"])
        row.status = "normal"
        await s.commit()

    r = await client.post("/api/v1/ui-modules/" + root["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "父"}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "state_conflict", r.text
    assert "还活着的子" in str(r.json()["details"]["normal_children"])
    # 一个都没删：父还在回收站里
    assert [n["name"] for n in (await _tree(client, h, pid, include_recycled=True))["recycled"]] == ["父"]


async def test_module_id_is_validated_and_cross_project_rejected(client: AsyncClient, make_user) -> None:
    """挂模块要同项目存在：跨项目 module_id 与不存在同 404，不静默变成未分类。"""
    _, h1, pid1 = await _setup(client, make_user, "I")
    _, h2, pid2 = await _setup(client, make_user, "J")
    m = await _mk(client, h1, pid1, "别的项目的模块")
    r = await client.post("/api/v1/ui-elements", json={
        "project_id": pid2, "name": "e", "locator_type": "css", "locator": "#e", "module_id": m["id"]},
        headers=h2)
    assert r.status_code == 404, r.text
    r2 = await client.post("/api/v1/ui-cases", json={
        "project_id": pid2, "name": "c", "steps": [{"id": "o", "type": "open", "input": "/"}],
        "module_id": m["id"]}, headers=h2)
    assert r2.status_code == 404, r2.text
    # parent_id 同样校验
    assert (await client.post("/api/v1/ui-modules", json={
        "project_id": pid2, "name": "挂错爹", "parent_id": m["id"]}, headers=h2)).status_code == 404


async def test_readonly_can_read_tree_not_write(client: AsyncClient, make_user) -> None:
    _, hb, pid = await _setup(client, make_user, "K")
    ro, hro = await make_user("uimro" + pid[:6])
    assert (await client.put(f"/api/v1/projects/{pid}/members/{ro.id}",
                             json={"role_code": "READONLY"}, headers=hb)).status_code == 200
    assert (await client.get("/api/v1/ui-modules", params={"project_id": pid}, headers=hro)).status_code == 200
    for path, body in (("", {"project_id": pid, "name": "建不了"}),
                       ("/" + (await _mk(client, hb, pid, "老板的模块"))["id"] + "/delete", {"project_id": pid})):
        r = await client.post("/api/v1/ui-modules" + path, json=body, headers=hro)
        assert r.status_code == 403, r.text
    tools = (await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=hb)).json()["items"]
    names = {t["name"] for t in tools}
    assert "ui_module_purge" not in names and "ui_module_tree" in names
