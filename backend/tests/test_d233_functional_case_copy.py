"""D233 判据刀：功能用例批量复制。

钉的契约（逐条对应 services.functional_case_batch_copy 的 docstring）：

1. **复制 = 新建**：副本新取 num、created_by/updated_by 是操作者；模板/名称+后缀/
   优先级/描述/自定义值随行复制，源用例一根毫毛不动。
2. **module_set 哨兵**：缺省 = 副本留在源模块；`true+module_id` = 全落到目标模块；
   `true+null` = 未分组；跨项目/不存在的模块 404 且整批不写。
3. **只复制正常态**：回收站/跨项目/不存在的 id → 404 带 `case_ids`，库里零新行
   （不复制半批，也不泄露别项目用例存在性）。
4. **重复 id 去重保序**：复制两次同一条只产出一个副本。
5. **评论与前后置关系不复制**：它们说的是「源那一条」的事。
6. **名称上限**：原名称+后缀超过 255 → 422 `name_too_long`，零新行。
7. **权限**：走 `functional:case:create`；READONLY → 403，MEMBER 可复制。
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


async def _field(client, h, pid: str, name: str, key: str) -> dict:
    r = await client.post(_BASE + "/custom-fields", json={
        "project_id": pid, "scene": "functional", "name": name, "field_key": key,
        "type": "input", "options": [],
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _template(client, h, pid: str, name: str, fields: list[dict]) -> dict:
    r = await client.post(_BASE + "/templates", json={
        "project_id": pid, "scene": "functional", "name": name, "fields": fields,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _case(client, h, pid: str, name: str, **kw) -> dict:
    r = await client.post(_BASE + "/functional-cases",
                          json={"project_id": pid, "name": name, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _copy(client, h, pid: str, ids: list[str], **kw):
    return await client.post(_BASE + "/functional-cases/batch-copy",
                             json={"project_id": pid, "case_ids": ids, **kw}, headers=h)


async def _get(client, h, pid: str, cid: str) -> dict:
    r = await client.get(_BASE + f"/functional-cases/{cid}",
                         params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _count(conn, pid: str) -> int:
    row = await conn.execute(
        text("SELECT COUNT(*) FROM functional_case WHERE project_id=:p"), {"p": pid}
    )
    return int(row.scalar_one())


async def test_copy_keeps_content_and_leaves_source_alone(client, conn, make_user) -> None:
    u, h = await make_user("d233a", admin=True)
    pid = await _proj(client, h, "D233内容")
    mod = await _module(client, h, pid, "登录")
    f = await _field(client, h, pid, "前置条件", "precondition")
    t = await _template(client, h, pid, "用例模板", [{"field_id": f["id"], "required": True}])
    await client.post(_BASE + f"/templates/{t['id']}/set-default",
                      json={"project_id": pid, "template_id": t["id"]}, headers=h)
    src = await _case(client, h, pid, "登录成功", priority="P0", module_id=mod["id"],
                      description="原始描述", custom_fields={f["id"]: "预置账号"})

    r = await _copy(client, h, pid, [src["id"]])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["affected"] == 1 and len(body["case_ids"]) == 1
    copy = await _get(client, h, pid, body["case_ids"][0])

    assert copy["id"] != src["id"]
    assert copy["num"] != src["num"]            # 副本新取号，不共享人读编号
    assert copy["name"] == "登录成功（副本）"     # 默认后缀
    assert copy["template_id"] == t["id"] and copy["priority"] == "P0"
    assert copy["module_id"] == mod["id"]        # 未指定 module_set = 留在源模块
    assert copy["description"] == "原始描述"
    assert copy["custom_fields"][f["id"]] == "预置账号"
    assert copy["recycled"] is False
    assert copy["created_by"] == u.id and copy["updated_by"] == u.id

    # 源用例不动：名称/编号/自定义值原样。
    again = await _get(client, h, pid, src["id"])
    assert again["name"] == "登录成功" and again["num"] == src["num"]
    assert again["custom_fields"][f["id"]] == "预置账号"


async def test_module_set_sentinel(client, conn, make_user) -> None:
    _, h = await make_user("d233b", admin=True)
    pid = await _proj(client, h, "D233模块")
    m1 = await _module(client, h, pid, "模块一")
    m2 = await _module(client, h, pid, "模块二")
    c1 = await _case(client, h, pid, "甲", module_id=m1["id"])
    c2 = await _case(client, h, pid, "乙", module_id=m1["id"])

    r = await _copy(client, h, pid, [c1["id"], c2["id"]], module_set=True, module_id=m2["id"])
    assert r.status_code == 200 and r.json()["affected"] == 2, r.text
    for cid in r.json()["case_ids"]:
        assert (await _get(client, h, pid, cid))["module_id"] == m2["id"]
    # 源用例还在 m1（复制不是移动）。
    assert (await _get(client, h, pid, c1["id"]))["module_id"] == m1["id"]

    # module_set=true + module_id=null = 未分组。
    r = await _copy(client, h, pid, [c1["id"]], module_set=True, module_id=None)
    assert r.status_code == 200, r.text
    assert (await _get(client, h, pid, r.json()["case_ids"][0]))["module_id"] is None

    # 坏模块 → 404 且零新行。
    before = await _count(conn, pid)
    r = await _copy(client, h, pid, [c1["id"]], module_set=True, module_id="no-such-module")
    assert r.status_code == 404, r.text
    assert await _count(conn, pid) == before


async def test_missing_recycled_cross_project_rejected_no_partial(client, conn, make_user) -> None:
    _, h = await make_user("d233c", admin=True)
    pid = await _proj(client, h, "D233范围甲")
    pid_b = await _proj(client, h, "D233范围乙")
    alive = await _case(client, h, pid, "正常")
    trashed = await _case(client, h, pid, "回收站")
    other = await _case(client, h, pid_b, "别项目")
    r = await client.post(_BASE + f"/functional-cases/{trashed['id']}/delete",
                          json={"project_id": pid, "case_id": trashed["id"]}, headers=h)
    assert r.status_code == 200, r.text

    before = await _count(conn, pid)
    r = await _copy(client, h, pid, [alive["id"], trashed["id"]])
    assert r.status_code == 404, r.text
    assert trashed["id"] in r.json()["details"]["case_ids"]

    r = await _copy(client, h, pid, [alive["id"], other["id"]])
    assert r.status_code == 404, r.text
    assert await _count(conn, pid) == before  # 整批不写：正常那条也没被复制

    r = await _copy(client, h, pid, [])
    assert r.status_code == 422, r.text


async def test_duplicate_ids_deduped(client, conn, make_user) -> None:
    _, h = await make_user("d233d", admin=True)
    pid = await _proj(client, h, "D233去重")
    c = await _case(client, h, pid, "甲")
    r = await _copy(client, h, pid, [c["id"], c["id"]])
    assert r.status_code == 200 and r.json()["affected"] == 1, r.text
    assert await _count(conn, pid) == 2  # 源 + 一个副本


async def test_comments_and_relations_not_copied(client, make_user) -> None:
    _, h = await make_user("d233e", admin=True)
    pid = await _proj(client, h, "D233关系")
    c1 = await _case(client, h, pid, "甲")
    c2 = await _case(client, h, pid, "乙")
    r = await client.post(_BASE + f"/functional-cases/{c1['id']}/comments",
                          json={"project_id": pid, "case_id": c1["id"], "content": "看看"},
                          headers=h)
    assert r.status_code == 201, r.text
    r = await client.post(_BASE + f"/functional-cases/{c1['id']}/relations",
                          json={"project_id": pid, "case_id": c1["id"],
                                "target_case_id": c2["id"], "relation_type": "predecessor"},
                          headers=h)
    assert r.status_code == 201, r.text

    r = await _copy(client, h, pid, [c1["id"]])
    assert r.status_code == 200, r.text
    cid = r.json()["case_ids"][0]
    comments = await client.get(_BASE + f"/functional-cases/{cid}/comments",
                                params={"project_id": pid}, headers=h)
    assert comments.status_code == 200 and comments.json()["total"] == 0
    rels = await client.get(_BASE + f"/functional-cases/{cid}/relations",
                            params={"project_id": pid}, headers=h)
    assert rels.status_code == 200
    assert rels.json()["predecessors"] == [] and rels.json()["successors"] == []


async def test_name_suffix_empty_and_too_long(client, conn, make_user) -> None:
    _, h = await make_user("d233f", admin=True)
    pid = await _proj(client, h, "D233名称")
    c = await _case(client, h, pid, "甲")
    r = await _copy(client, h, pid, [c["id"]], name_suffix="")
    assert r.status_code == 200, r.text
    assert (await _get(client, h, pid, r.json()["case_ids"][0]))["name"] == "甲"

    long_name = "长" * 253  # 253 + 4 字后缀 = 257 > 255
    lc = await _case(client, h, pid, long_name)
    before = await _count(conn, pid)
    r = await _copy(client, h, pid, [lc["id"]])
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "name_too_long"
    assert await _count(conn, pid) == before


async def test_readonly_forbidden_member_allowed(client, conn, make_user) -> None:
    _, h = await make_user("d233g", admin=True)
    pid = await _proj(client, h, "D233权限")
    c = await _case(client, h, pid, "甲")

    ro, roh = await make_user("d233g_ro")
    r = await client.put(_BASE + f"/projects/{pid}/members/{ro.id}",
                         json={"role_code": "READONLY"}, headers=h)
    assert r.status_code == 200, r.text
    before = await _count(conn, pid)
    r = await _copy(client, roh, pid, [c["id"]])
    assert r.status_code == 403, r.text
    assert r.json()["details"]["perm"] == "functional:case:create"
    assert await _count(conn, pid) == before

    mem, memh = await make_user("d233g_mem")
    r = await client.put(_BASE + f"/projects/{pid}/members/{mem.id}",
                         json={"role_code": "MEMBER"}, headers=h)
    assert r.status_code == 200, r.text
    r = await _copy(client, memh, pid, [c["id"]])
    assert r.status_code == 200 and r.json()["affected"] == 1, r.text
