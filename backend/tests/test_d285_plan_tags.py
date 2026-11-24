"""D285 判据刀：测试计划「标签」。

钉的契约：
1. 创建可写标签：去空白/去重保序，回执/列表/详情都是数组（库里是逗号串）。
2. 顶层 `tag` 是**精确**匹配（FIND_IN_SET）：存在「bug1」时按「bug」筛不到它；
   与 module/unassigned/关注轴并行 AND（不是互斥的 elif 分支）。
3. 更新三态：不带 tags = 不改、[] = 清空、带值 = 改（清空发得出去）。
4. 复制计划随抄标签（复制的是同一套计划安排）。
"""
from __future__ import annotations

_BASE = "/api/v1"


async def _setup(client, make_user, name="d285"):
    _, h = await make_user(name)
    r = await client.post(_BASE + "/projects", json={"name": name + "_proj"}, headers=h)
    assert r.status_code == 201, r.text
    return h, r.json()["id"]


async def _plan(client, h, pid, name, **kw):
    return await client.post(_BASE + "/plans",
                            json={"project_id": pid, "name": name, **kw}, headers=h)


async def _list(client, h, pid, **params):
    return await client.get(_BASE + "/plans",
                            params={"project_id": pid, "current": 1, "size": 50, **params},
                            headers=h)


async def test_tags_roundtrip_and_exact_filter(client, make_user) -> None:
    h, pid = await _setup(client, make_user)
    r = await _plan(client, h, pid, "带标签计划", tags=[" 回归 ", "核心", "回归", ""])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["tags"] == ["回归", "核心"]

    rows = (await _list(client, h, pid)).json()["items"]
    row = next(x for x in rows if x["id"] == body["id"])
    assert row["tags"] == ["回归", "核心"], "列表行也要出标签（不靠前端逐行再查）"

    detail = await client.get(_BASE + "/plans/" + body["id"],
                              params={"project_id": pid}, headers=h)
    assert detail.status_code == 200 and detail.json()["tags"] == ["回归", "核心"]

    assert [x["id"] for x in (await _list(client, h, pid, tag="回归")).json()["items"]] == [body["id"]]
    assert (await _list(client, h, pid, tag="回")).json()["items"] == [], "必须是精确匹配，不是包含"

    await _plan(client, h, pid, "带 bug 标签计划", tags=["bug1"])
    assert (await _list(client, h, pid, tag="bug")).json()["items"] == []
    assert [x["name"] for x in (await _list(client, h, pid, tag="bug1")).json()["items"]] == ["带 bug 标签计划"]

    # 全空白 = 不过滤（与 keyword 同尺）
    assert len((await _list(client, h, pid, tag="   ")).json()["items"]) == 2
    # 标签与「未分组」视图轴并行 AND：两行都未分组 → 两行都在
    assert len((await _list(client, h, pid, tag="回归", unassigned=True)).json()["items"]) == 1


async def test_update_three_state_and_copy(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "d285b")
    created = await _plan(client, h, pid, "三态计划", tags=["旧标签"])
    plid = created.json()["id"]

    keep = await client.patch(_BASE + "/plans/" + plid, json={
        "project_id": pid, "plan_id": plid, "name": "改名计划",
    }, headers=h)
    assert keep.status_code == 200 and keep.json()["tags"] == ["旧标签"]

    cleared = await client.patch(_BASE + "/plans/" + plid, json={
        "project_id": pid, "plan_id": plid, "tags": [],
    }, headers=h)
    assert cleared.status_code == 200 and cleared.json()["tags"] == []

    again = await client.patch(_BASE + "/plans/" + plid, json={
        "project_id": pid, "plan_id": plid, "tags": ["新标签", "新标签"],
    }, headers=h)
    assert again.status_code == 200 and again.json()["tags"] == ["新标签"]

    dup = await client.post(_BASE + f"/plans/{plid}/copy", json={
        "project_id": pid, "plan_id": plid,
    }, headers=h)
    assert dup.status_code == 201, dup.text
    assert dup.json()["tags"] == ["新标签"]
    assert dup.json()["archived"] is False
