"""D216 判据刀：缺陷列表高级搜索（D47-a 三件套铺到缺陷页）。

钉的契约：

1. **字段白名单 = DEFECT_LIST_FILTER**，meta 里的 fields 与它同源；白名单外 400。
2. **条件是 WHERE**：与 `recycled`、`keyword`、`tag`、`followed_by_me`、`status`/`priority`
   这些顶层轴**并行 AND**；OR 组自带括号，不吃掉 project_id 与回收站谓词。
3. **回收站轴不可被 filter 绕过**：正常视图 + `title CONTAINS` 不会把已回收缺陷带回来。
4. **可空列**：`handle_user_id EMPTY` 留下未指派的缺陷，`NOT_EMPTY` 一行不给。
5. **enum 的操作符集合来自控件型**：status 没有 GT；非空列没有 EMPTY 假选项。
6. **条件进 COUNT 同一份**：页码模式的 total 也必须吃 filter。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _create(client, h, pid: str, title: str, **kw) -> dict:
    r = await client.post(_BASE + "/defects", json={"project_id": pid, "title": title, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _titles(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/defects", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return {x["title"] for x in r.json()["items"]}


async def test_filter_meta_registers_defect(client, make_user) -> None:
    _, h = await make_user("d216a", admin=True)
    pid = await _proj(client, h, "D216元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "defect"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "defect" in body["supported_view_types"]
    assert body["view_label"] == "缺陷管理"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {
        "num", "title", "status", "priority", "handle_user_id", "template_id",
        "created_by", "updated_by", "created_at", "updated_at",
    }
    # 视图轴/快捷筛选轴不是业务字段：recycled 进条件组会造出自我矛盾的视图
    assert not ({"project_id", "recycled", "keyword", "tag", "followed_by_me",
                 "delete_user", "delete_time", "current", "size"} & fields), \
        "视图/快捷筛选/回收站轴不是业务字段，不许进条件组"
    st = next(f for f in body["fields"] if f["field"] == "status")
    assert st["kind"] == "enum" and "GT" not in st["ops"]
    title = next(f for f in body["fields"] if f["field"] == "title")
    assert "CONTAINS" in title["ops"] and "BETWEEN" not in title["ops"]
    num = next(f for f in body["fields"] if f["field"] == "num")
    assert {"GT", "LT", "BETWEEN"} <= set(num["ops"]), "数值列必须给区间能力"
    created = next(f for f in body["fields"] if f["field"] == "created_at")
    assert "EMPTY" not in created["ops"], "非空时间列不给「为空」假选项"


async def test_conditions_apply_as_where(client, make_user) -> None:
    u, h = await make_user("d216b", admin=True)
    pid = await _proj(client, h, "D216条件")
    reg = await _create(client, h, pid, "登录页 500", priority="P0", handle_user_id=u.id)
    await _create(client, h, pid, "下单按钮错位", priority="P1", handle_user_id=u.id)
    await _create(client, h, pid, "登录超时", priority="P1")

    assert await _titles(client, h, pid, filter=_f(
        {"field": "title", "operator": "CONTAINS", "value": "登录"})) == {"登录页 500", "登录超时"}
    assert await _titles(client, h, pid, filter=_f(
        {"field": "priority", "operator": "EQUALS", "value": "P0"})) == {"登录页 500"}
    # 状态由工作流转移写入（new→in_process 合法边），不是 create 直接塞
    up = await client.patch(_BASE + f"/defects/{reg['id']}",
                            json={"project_id": pid, "status": "in_process"}, headers=h)
    assert up.status_code == 200, up.text
    assert await _titles(client, h, pid, filter=_f(
        {"field": "status", "operator": "EQUALS", "value": "in_process"})) == {"登录页 500"}
    # OR：标题含「下单」或优先级 P0 → 两行
    assert await _titles(client, h, pid, filter=_f(
        {"field": "title", "operator": "CONTAINS", "value": "下单"},
        {"field": "priority", "operator": "EQUALS", "value": "P0"}, mode="OR")) == {
        "下单按钮错位", "登录页 500"}
    # 谓词写在 LIMIT 之前：两行都匹配，size=1 只回一行但 total 是 2（COUNT 吃同一份条件）
    r = await client.get(_BASE + "/defects", params={
        "project_id": pid, "size": 1, "current": 1,
        "filter": _f({"field": "title", "operator": "CONTAINS", "value": "登录"}),
    }, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    assert r.json()["total"] == 2


async def test_filter_cannot_bypass_recycled_axis(client, make_user) -> None:
    _, h = await make_user("d216c", admin=True)
    pid = await _proj(client, h, "D216回收轴")
    await _create(client, h, pid, "登录-正常")
    dead = await _create(client, h, pid, "登录-已回收")
    rm = await client.post(_BASE + f"/defects/{dead['id']}/delete",
                           json={"project_id": pid, "defect_id": dead["id"]}, headers=h)
    assert rm.status_code == 200, rm.text

    # 正常视图 + 条件：回收行不许因条件出现
    assert await _titles(client, h, pid, filter=_f(
        {"field": "title", "operator": "CONTAINS", "value": "登录"})) == {"登录-正常"}
    # 回收站视图 + 同一条件：只剩回收行（recycled 是顶层轴，与 filter 并行）
    assert await _titles(client, h, pid, recycled="true", filter=_f(
        {"field": "title", "operator": "CONTAINS", "value": "登录"})) == {"登录-已回收"}
    # 条件里点名回收行也不行：正常视图里它不存在（轴先于条件）
    assert await _titles(client, h, pid, filter=_f(
        {"field": "num", "operator": "EQUALS", "value": dead["num"]})) == set()


async def test_nullable_handle_user_and_updated_by(client, make_user) -> None:
    u, h = await make_user("d216d", admin=True)
    pid = await _proj(client, h, "D216空值")
    await _create(client, h, pid, "已指派", handle_user_id=u.id)
    await _create(client, h, pid, "未指派")

    assert await _titles(client, h, pid, filter=_f(
        {"field": "handle_user_id", "operator": "EMPTY", "value": None})) == {"未指派"}
    assert await _titles(client, h, pid, filter=_f(
        {"field": "handle_user_id", "operator": "NOT_EMPTY", "value": None})) == {"已指派"}
    # updated_by 在 create 时即写入当前用户：NOT_EMPTY 必须两行都留下（反向对照）
    assert await _titles(client, h, pid, filter=_f(
        {"field": "updated_by", "operator": "NOT_EMPTY", "value": None})) == {"已指派", "未指派"}


async def test_bad_filter_is_400(client, make_user) -> None:
    _, h = await make_user("d216e", admin=True)
    pid = await _proj(client, h, "D216坏条件")
    r = await client.get(_BASE + "/defects", params={
        "project_id": pid,
        "filter": _f({"field": "recycled", "operator": "EQUALS", "value": "true"}),
    }, headers=h)
    assert r.status_code == 400, r.text
    assert r.json()["code"] == "bad_filter"
    assert r.json()["details"]["view_type"] == "defect"
    assert "本页可筛" in r.json()["message"]
    assert "标题" in r.json()["message"], "400 要告诉用户这一页到底能按什么筛"
