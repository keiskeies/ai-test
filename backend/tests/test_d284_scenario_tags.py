"""D284 判据刀：场景「标签」。

钉的契约：
1. 创建可写标签：去空白/去重保序，回执/列表/详情都是数组（库里是逗号串）。
2. 顶层 `tag` 是**精确**匹配（FIND_IN_SET）：存在「bug1」时按「bug」筛不到它。
3. 更新三态：不带 tags = 不改、[] = 清空、带值 = 改；变更历史里能看到标签摘要。
4. 复制（单条 duplicate）随抄标签；导出快照带 tags、导入能回灌。
"""
from __future__ import annotations

_BASE = "/api/v1"


async def _setup(client, make_user, name="d284"):
    _, h = await make_user(name)
    r = await client.post(_BASE + "/projects", json={"name": name + "_proj"}, headers=h)
    assert r.status_code == 201, r.text
    return h, r.json()["id"]


async def _scen(client, h, pid, name, **kw):
    return await client.post(_BASE + "/scenarios",
                            json={"project_id": pid, "name": name, **kw}, headers=h)


async def _list(client, h, pid, **params):
    return await client.get(_BASE + "/scenarios",
                            params={"project_id": pid, "current": 1, "size": 50, **params},
                            headers=h)


async def test_tags_roundtrip_and_exact_filter(client, make_user) -> None:
    h, pid = await _setup(client, make_user)
    r = await _scen(client, h, pid, "带标签场景", tags=[" 回归 ", "核心", "回归", ""])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["tags"] == ["回归", "核心"]

    listed = await _list(client, h, pid)
    row = next(x for x in listed.json()["items"] if x["id"] == body["id"])
    assert row["tags"] == ["回归", "核心"]

    detail = await client.get(_BASE + "/scenarios/" + body["id"],
                              params={"project_id": pid}, headers=h)
    assert detail.status_code == 200 and detail.json()["tags"] == ["回归", "核心"]

    hit = await _list(client, h, pid, tag="回归")
    assert [x["id"] for x in hit.json()["items"]] == [body["id"]]
    miss = await _list(client, h, pid, tag="回")
    assert miss.status_code == 200 and miss.json()["items"] == [], "标签筛选必须是精确匹配，不是包含"

    await _scen(client, h, pid, "带 bug 标签场景", tags=["bug1"])
    assert (await _list(client, h, pid, tag="bug")).json()["items"] == []
    got = await _list(client, h, pid, tag="bug1")
    assert [x["name"] for x in got.json()["items"]] == ["带 bug 标签场景"]

    # 全空白 = 不过滤（与 keyword 同尺）
    assert len((await _list(client, h, pid, tag="   ")).json()["items"]) == 2


async def test_update_three_state_and_duplicate_copy(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d284b")
    created = await _scen(client, h, pid, "三态场景", tags=["旧标签"])
    sid = created.json()["id"]
    version = created.json()["version"]

    keep = await client.patch(_BASE + "/scenarios/" + sid, json={
        "project_id": pid, "scenario_id": sid, "version": version, "name": "改名场景",
    }, headers=h)
    assert keep.status_code == 200 and keep.json()["tags"] == ["旧标签"]
    version = keep.json()["version"]

    cleared = await client.patch(_BASE + "/scenarios/" + sid, json={
        "project_id": pid, "scenario_id": sid, "version": version, "tags": [],
    }, headers=h)
    assert cleared.status_code == 200 and cleared.json()["tags"] == []
    version = cleared.json()["version"]

    again = await client.patch(_BASE + "/scenarios/" + sid, json={
        "project_id": pid, "scenario_id": sid, "version": version, "tags": ["新标签", "新标签"],
    }, headers=h)
    assert again.status_code == 200 and again.json()["tags"] == ["新标签"]

    # 变更历史如实记录标签差异（不是 changed=[] 的假「无变化」）
    revs = await client.get(_BASE + f"/scenarios/{sid}/revisions",
                            params={"project_id": pid}, headers=h)
    assert revs.status_code == 200
    changed = revs.json()["items"][0]["changed"]
    assert any(c["field"] == "tags" and c["after"] == ["新标签"] for c in changed), changed

    dup = await client.post(_BASE + f"/scenarios/{sid}/duplicate", json={
        "project_id": pid, "scenario_id": sid,
    }, headers=h)
    assert dup.status_code == 200, dup.text
    assert dup.json()["tags"] == ["新标签"]


async def test_export_import_roundtrip_keeps_tags(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d284c")
    created = await _scen(client, h, pid, "导出场景", tags=["回归", "冒烟"])
    sid = created.json()["id"]

    exported = await client.post(_BASE + "/scenario-export", json={
        "project_id": pid, "scenario_ids": [sid],
    }, headers=h)
    assert exported.status_code == 200, exported.text
    entry = exported.json()["scenarios"][0]
    assert entry["tags"] == ["回归", "冒烟"]

    imported = await client.post(_BASE + "/scenario-import", json={
        "project_id": pid, "scenarios": [entry],
    }, headers=h)
    assert imported.status_code == 201, imported.text
    names = imported.json()["names"]
    rows = (await _list(client, h, pid)).json()["items"]
    row = next(x for x in rows if x["name"] == names[0])
    assert row["tags"] == ["回归", "冒烟"]
