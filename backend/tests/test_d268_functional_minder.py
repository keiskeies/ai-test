"""D268 判据刀：功能用例脑图（C11）。

钉的契约（每条都能在 `functional/services.py` 的 `functional_minder_*` 指到实现）：

1. **树是模块 + 便签 + 用例叶的合成**：模块按父子嵌套，用例只挂模块（`cases`），
   未分类用例单列 `unfiled_cases`；`case_count` 与 `cases` 条数一致；`total_cases`
   只算正常用例（回收站不进脑图）。
2. **便签可以挂模块或便签**（MS 的「空白节点」）；改名/移动按 PATCH 语义，
   `parent_set=true` 才能把便签挪到根层（`parent_id=null` 不是「不改」）。
3. **护栏**：父节点不存在 404；把便签移到自己的子树里 422 `cycle`；便签下还有模块时
   删除 409 `note_not_empty`（不静默丢模块）；删便签连子便签一起删。
4. **跨项目隔离**：别项目的模块/便签/用例不进树，也不能当父节点。
5. **权限**：READONLY 可读；写便签要 `functional:case:update`（不借 read 位）；
   非成员 403。
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


async def _module(client, h, pid: str, name: str, parent: str | None = None) -> str:
    body = {"project_id": pid, "name": name}
    if parent:
        body["parent_id"] = parent
    r = await client.post(_BASE + "/functional-modules", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _case(client, h, pid: str, name: str, module_id: str | None = None) -> dict:
    body = {"project_id": pid, "name": name}
    if module_id:
        body["module_id"] = module_id
    r = await client.post(_BASE + "/functional-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _tree(client, h, pid: str):
    return await client.get(_BASE + "/functional-minder",
                            params={"project_id": pid}, headers=h)


async def _note(client, h, pid: str, name: str, parent: str | None = None):
    body = {"project_id": pid, "name": name}
    if parent:
        body["parent_id"] = parent
    return await client.post(_BASE + "/functional-minder/notes", json=body, headers=h)


async def test_tree_merges_modules_notes_cases(client, make_user) -> None:
    _, h = await make_user("d268a", admin=True)
    pid = await _proj(client, h, "D268树")
    root = await _module(client, h, pid, "登录")
    child = await _module(client, h, pid, "短信", parent=root)
    await _case(client, h, pid, "验证码登录", module_id=child)
    await _case(client, h, pid, "密码登录", module_id=root)
    await _case(client, h, pid, "未归类")
    gone = await _case(client, h, pid, "要删的", module_id=root)
    r = await client.post(_BASE + f"/functional-cases/{gone['id']}/delete",
                          json={"project_id": pid, "case_id": gone["id"]}, headers=h)
    assert r.status_code == 200, r.text
    note = await _note(client, h, pid, "待确认", parent=root)
    assert note.status_code == 201, note.text

    r = await _tree(client, h, pid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_cases"] == 3  # 回收站那条不算
    assert [c["name"] for c in body["unfiled_cases"]] == ["未归类"]
    assert len(body["nodes"]) == 1
    top = body["nodes"][0]
    assert top["kind"] == "module" and top["name"] == "登录"
    assert top["case_count"] == 1
    assert [c["name"] for c in top["cases"]] == ["密码登录"]
    kinds = {n["kind"]: n for n in top["children"]}
    assert set(kinds) == {"module", "note"}
    assert kinds["module"]["case_count"] == 1
    assert kinds["module"]["cases"][0]["name"] == "验证码登录"
    assert kinds["module"]["cases"][0]["num"] != top["cases"][0]["num"]
    assert kinds["note"]["name"] == "待确认" and kinds["note"]["cases"] == []


async def test_note_rename_move_and_cascade_delete(client, make_user) -> None:
    _, h = await make_user("d268b", admin=True)
    pid = await _proj(client, h, "D268便签")
    mod = await _module(client, h, pid, "支付")
    a = (await _note(client, h, pid, "甲", parent=mod)).json()
    b = (await _note(client, h, pid, "乙", parent=a["id"])).json()

    r = await client.patch(_BASE + f"/functional-minder/notes/{a['id']}",
                           json={"project_id": pid, "name": "甲改"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "甲改"

    # 挪到根层必须带声明位，否则 parent_id=null 会被当成「不改」
    r = await client.patch(_BASE + f"/functional-minder/notes/{b['id']}",
                           json={"project_id": pid, "parent_id": None,
                                 "parent_set": True}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["parent_id"] is None

    # 删甲：子便签已经挪走，只删一条
    r = await client.post(_BASE + f"/functional-minder/notes/{a['id']}/delete",
                          json={"project_id": pid, "note_id": a["id"]}, headers=h)
    assert r.status_code == 200, r.text
    tree = (await _tree(client, h, pid)).json()
    assert [n["name"] for n in tree["nodes"] if n["kind"] == "note"] == ["乙"]

    # 再挂一个子便签，删父时连子一起删
    child = (await _note(client, h, pid, "子", parent=b["id"])).json()
    assert child["parent_id"] == b["id"]
    r = await client.post(_BASE + f"/functional-minder/notes/{b['id']}/delete",
                          json={"project_id": pid, "note_id": b["id"]}, headers=h)
    assert r.status_code == 200, r.text
    tree = (await _tree(client, h, pid)).json()
    assert [n for n in tree["nodes"] if n["kind"] == "note"] == []


async def test_note_guards(client, conn, make_user) -> None:
    _, h = await make_user("d268c", admin=True)
    pid = await _proj(client, h, "D268护栏")
    mod = await _module(client, h, pid, "订单")
    a = (await _note(client, h, pid, "甲", parent=mod)).json()

    r = await _note(client, h, pid, "孤儿", parent="nope")
    assert r.status_code == 404, r.text

    # 便签不能移到自己的子树里
    await _note(client, h, pid, "子", parent=a["id"])
    r = await client.patch(_BASE + f"/functional-minder/notes/{a['id']}",
                           json={"project_id": pid, "parent_id": a["id"],
                                 "parent_set": True}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "cycle", r.text

    # 便签下有模块时删便签 → 409，模块不被静默丢。
    # 模块写路径不允许「父=便签」，这里用 SQL 造一条脏数据（护栏正是给脏数据留的）。
    from sqlalchemy import text

    await conn.execute(text("UPDATE functional_module SET parent_id = :nid WHERE id = :mid"),
                       {"nid": a["id"], "mid": mod})
    await conn.commit()
    r = await client.post(_BASE + f"/functional-minder/notes/{a['id']}/delete",
                          json={"project_id": pid, "note_id": a["id"]}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "note_not_empty", r.text
    tree = (await _tree(client, h, pid)).json()
    # 脏数据（订单↔甲 互为父子）下照样画得出来：DFS 有 visited 兜底，不吞节点也不死循环
    flat: list[dict] = []

    def walk(nodes: list[dict]) -> None:
        for n in nodes:
            flat.append(n)
            walk(n["children"])

    walk(tree["nodes"])
    names = sorted(n["name"] for n in flat)
    # 环上三个节点各出现恰好一次（环被 visited 切断，不重复画、不丢）
    assert names == ["子", "甲", "订单"]

    # 回收站里的模块不能当父节点（脑图只画正常模块）
    dead = await _module(client, h, pid, "待删模块")
    r = await client.post(_BASE + f"/functional-modules/{dead}/delete",
                          json={"project_id": pid, "module_id": dead}, headers=h)
    assert r.status_code == 200, r.text
    assert (await _note(client, h, pid, "挂废模块", parent=dead)).status_code == 404


async def test_cross_project_isolation(client, make_user) -> None:
    _, h = await make_user("d268d", admin=True)
    p1 = await _proj(client, h, "D268甲项目")
    p2 = await _proj(client, h, "D268乙项目")
    m1 = await _module(client, h, p1, "甲的模块")
    await _case(client, h, p1, "甲的用例", module_id=m1)
    await _module(client, h, p2, "乙的模块")

    body = (await _tree(client, h, p2)).json()
    names = [n["name"] for n in body["nodes"]]
    assert names == ["乙的模块"] and body["total_cases"] == 0
    assert (await _note(client, h, p2, "挂别家", parent=m1)).status_code == 404


async def test_case_under_recycled_module_goes_unfiled(client, conn, make_user) -> None:
    """脏数据兜底：正常用例指向回收站模块时归「未分类」，不从脑图里消失。

    正常路径走不到（`functional_module_delete` 有 409「模块下还有用例」），
    但历史数据/手工改库可能留下这种行——脑图的承诺是「不吞用例」。
    """
    from sqlalchemy import text

    _, h = await make_user("d268f", admin=True)
    pid = await _proj(client, h, "D268脏数据")
    mod = await _module(client, h, pid, "将回收的模块")
    case = await _case(client, h, pid, "还挂着的用例", module_id=mod)
    await conn.execute(text("UPDATE functional_module SET status = 'recycled' WHERE id = :id"),
                       {"id": mod})
    await conn.commit()
    body = (await _tree(client, h, pid)).json()
    assert body["nodes"] == []
    assert [c["id"] for c in body["unfiled_cases"]] == [case["id"]]
    assert body["total_cases"] == 1


async def test_permissions(client, make_user) -> None:
    _, h = await make_user("d268e", admin=True)
    pid = await _proj(client, h, "D268权限")
    await _module(client, h, pid, "模块")

    ro, roh = await make_user("d268e_ro")
    await _member(client, h, pid, ro.id, "READONLY")
    assert (await _tree(client, roh, pid)).status_code == 200
    r = await _note(client, roh, pid, "只读也写")
    assert r.status_code == 403, r.text
    assert r.json()["details"]["perm"] == "functional:case:update"

    mem, memh = await make_user("d268e_mem")
    await _member(client, h, pid, mem.id, "MEMBER")
    assert (await _note(client, memh, pid, "成员可写")).status_code == 201

    _, out_h = await make_user("d268e_out")
    assert (await _tree(client, out_h, pid)).status_code == 403
