"""1D T4 第四棵模块树（R99）：无限级、环检测、软删后代、根层重名、资产不陪葬。

与前三种树（api/scenario/ui）的唯一实质差异：**单资产**——树服务的资产只有 ADB 用例，
所以节点只有 `count`（直属未回收用例数），没有 ui 树的 element_count/case_count 分列。
`test_tree_direct_case_count` 钉这条。

其余形状照 1C 的 test_ui_module.py 镜像：根层重名服务层自查（第四次）、成环 400、
删后代整枝藏、回收站列回收根、恢复救祖先、purge 出 detached_cases 真数字。
"""
from __future__ import annotations

from typing import Any

from httpx import AsyncClient


async def _setup(client: AsyncClient, make_user, tag: str):
    boss, hb = await make_user("admboss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "adm" + tag}, headers=hb)).json()["id"]
    return boss, hb, pid


async def _mk(client: AsyncClient, h, pid, name, parent=None) -> dict[str, Any]:
    body: dict[str, Any] = {"project_id": pid, "name": name}
    if parent:
        body["parent_id"] = parent
    r = await client.post("/api/v1/adb-modules", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _tree(client: AsyncClient, h, pid, **params):
    r = await client.get("/api/v1/adb-modules", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _case_in(client: AsyncClient, h, pid, name, module_id) -> dict[str, Any]:
    """造一条挂在模块下的 ADB 用例（T7 服务没落地前直接写库，模块树 count 读库）。"""

    from app.core.db import get_sessionmaker
    from app.modules.adb_test.models import AdbCase

    async with get_sessionmaker()() as s:
        c = AdbCase(project_id=pid, module_id=module_id, name=name,
                    steps=[{"id": "k1", "type": "home"}])
        s.add(c)
        await s.commit()
        cid = c.id
    return {"id": cid}


def _names(nodes):
    out = set()
    for n in nodes:
        out.add(n["name"])
        out |= _names(n["children"])
    return out


async def test_tree_is_unbounded_depth_with_direct_count(client: AsyncClient, make_user) -> None:
    """无限级 + 直属计数（不算子孙）；单资产所以只有 count。"""
    _, h, pid = await _setup(client, make_user, "A")
    root = await _mk(client, h, pid, "交易链路")
    mid = await _mk(client, h, pid, "下单", root["id"])
    leaf = await _mk(client, h, pid, "批量", mid["id"])
    deep = await _mk(client, h, pid, "第四层", leaf["id"])
    await _case_in(client, h, pid, "c1", mid["id"])
    await _case_in(client, h, pid, "c2", deep["id"])

    tree = (await _tree(client, h, pid))["tree"]
    assert len(tree) == 1 and tree[0]["name"] == "交易链路"
    # 根的 count 只算直属：子孙的 2 条用例一个都不许冒上来
    assert tree[0]["count"] == 0
    n1 = tree[0]["children"][0]
    assert n1["name"] == "下单" and n1["count"] == 1
    n2 = n1["children"][0]
    assert n2["name"] == "批量" and n2["count"] == 0
    assert n2["children"][0]["name"] == "第四层" and n2["children"][0]["count"] == 1
    assert _names(tree) == {"交易链路", "下单", "批量", "第四层"}


async def test_root_level_duplicate_is_blocked_by_service(client: AsyncClient, make_user) -> None:
    """根层同名被服务层拦住（第四次：MySQL 唯一键不判等 NULL，DB 管不到根层）。"""
    _, h, pid = await _setup(client, make_user, "C")
    a = await _mk(client, h, pid, "登录页")
    r = await client.post("/api/v1/adb-modules", json={"project_id": pid, "name": "登录页"}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "conflict", r.text
    # 同父重名也拦
    b = await _mk(client, h, pid, "子页", a["id"])
    r2 = await client.post("/api/v1/adb-modules",
                           json={"project_id": pid, "name": "子页", "parent_id": a["id"]}, headers=h)
    assert r2.status_code == 409, r2.text
    # 不同父可同名
    assert (await client.post("/api/v1/adb-modules", json={"project_id": pid, "name": "子页"},
                              headers=h)).status_code == 201
    # 回收站里的同名同样占位
    await client.post("/api/v1/adb-modules/" + b["id"] + "/delete", json={"project_id": pid}, headers=h)
    r3 = await client.post("/api/v1/adb-modules",
                           json={"project_id": pid, "name": "子页", "parent_id": a["id"]}, headers=h)
    assert r3.status_code == 409 and "回收站" in r3.json()["message"], r3.text


async def test_cycle_and_self_parent_rejected(client: AsyncClient, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "D")
    a = await _mk(client, h, pid, "A")
    b = await _mk(client, h, pid, "B", a["id"])
    c = await _mk(client, h, pid, "C", b["id"])
    r = await client.patch("/api/v1/adb-modules/" + a["id"],
                           json={"project_id": pid, "parent_id": c["id"]}, headers=h)
    assert r.status_code == 400 and r.json()["code"] == "invalid_input", r.text
    assert (await client.patch("/api/v1/adb-modules/" + a["id"],
                               json={"project_id": pid, "parent_id": a["id"]}, headers=h)).status_code == 400
    ok = await client.patch("/api/v1/adb-modules/" + b["id"],
                            json={"project_id": pid, "parent_id": None}, headers=h)
    assert ok.status_code == 200 and ok.json()["parent_id"] is None, ok.text


async def test_delete_hides_subtree_restore_rescues_ancestors(client: AsyncClient, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "E")
    root = await _mk(client, h, pid, "根")
    mid = await _mk(client, h, pid, "中", root["id"])
    await _mk(client, h, pid, "叶", mid["id"])
    await client.post("/api/v1/adb-modules/" + mid["id"] + "/delete", json={"project_id": pid}, headers=h)
    assert _names((await _tree(client, h, pid))["tree"]) == {"根"}
    rec = (await _tree(client, h, pid, include_recycled=True))["recycled"]
    assert [n["name"] for n in rec] == ["中"]
    assert rec[0]["children"][0]["name"] == "叶"
    # 恢复孩子（父级仍在回收站）→ 祖先链一起回归
    kid = rec[0]["children"][0]
    r = await client.post("/api/v1/adb-modules/" + kid["id"] + "/restore",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    assert _names((await _tree(client, h, pid))["tree"]) == {"根", "中", "叶"}


async def test_purge_detaches_cases_with_real_count(client: AsyncClient, make_user) -> None:
    """⑥ 彻底删除模块 → 用例不陪葬（module_id 置 None），回执给真数字 detached_cases。"""
    from sqlalchemy import select

    from app.core.db import get_sessionmaker
    from app.modules.adb_test.models import AdbCase

    _, h, pid = await _setup(client, make_user, "G")
    root = await _mk(client, h, pid, "要被删的模块")
    kid = await _mk(client, h, pid, "它的子模块", root["id"])
    c = await _case_in(client, h, pid, "用例在根模块里", root["id"])

    for m in (kid, root):
        assert (await client.post("/api/v1/adb-modules/" + m["id"] + "/delete",
                                  json={"project_id": pid}, headers=h)).status_code == 200
    bad = await client.post("/api/v1/adb-modules/" + root["id"] + "/purge",
                            json={"project_id": pid, "confirm_name": "要被删的模块 "}, headers=h)
    assert bad.status_code == 409 and bad.json()["code"] == "name_mismatch", bad.text
    ok = await client.post("/api/v1/adb-modules/" + root["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "要被删的模块"}, headers=h)
    assert ok.status_code == 200, ok.text
    assert ok.json()["purged_modules"] == 2 and ok.json()["detached_cases"] == 1, ok.json()
    # 用例还活着，module_id 变 None（未分类）
    async with get_sessionmaker()() as s:
        row = (await s.execute(select(AdbCase).where(AdbCase.id == c["id"]))).scalar_one()
        assert row.module_id is None
    assert (await _tree(client, h, pid))["tree"] == []


async def test_readonly_can_read_tree_not_write(client: AsyncClient, make_user) -> None:
    _, hb, pid = await _setup(client, make_user, "K")
    ro, hro = await make_user("admr" + pid[:4])
    await client.put(f"/api/v1/projects/{pid}/members/{ro.id}", json={"role_code": "READONLY"},
                     headers=hb)
    assert (await client.get("/api/v1/adb-modules", params={"project_id": pid},
                             headers=hro)).status_code == 200
    r = await client.post("/api/v1/adb-modules", json={"project_id": pid, "name": "建不了"},
                          headers=hro)
    assert r.status_code == 403, r.text
    tools = (await client.get("/api/v1/agent/tools", params={"project_id": pid},
                              headers=hb)).json()["items"]
    by_name = {t["name"]: t for t in tools}
    assert by_name["adb_module_tree"]["effect"] == "read"
    assert by_name["adb_module_delete"]["effect"] == "destructive"
    assert "adb_module_purge" not in by_name, "purge 是 tool=False 内部件，不许进工具面"
