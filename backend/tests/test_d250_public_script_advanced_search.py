"""D250 判据刀：设置页「公共脚本」高级搜索（D47-a 三件套铺到 public_script）。

契约（对应 app/modules/project_settings/services.py 白名单注释）：

1. view_type `public_script`，页面名「公共脚本」，字段面只收表格看得见的五个标量列：
   脚本名 / 语言 / 版本 / 启用 / 说明。
2. `content`（大文本）、`created_by`/`updated_by`（存 id、界面按姓名）、
   `created_at`/`updated_at`（表格不显示）都不进白名单，点名即 400。
3. 条件与「关键词 / 只看启用」两条快捷轴并行 AND，不互相顶掉。
4. 不越项目；空串 = 没筛选。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _script(client, h, pid: str, name: str, language: str = "python",
                  content: str = "print(1)", enabled: bool = True,
                  description: str | None = None) -> dict:
    r = await client.post(_BASE + "/public-scripts", json={
        "project_id": pid, "name": name, "language": language,
        "content": content, "enabled": enabled, "description": description,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _list(client, h, pid: str, flt: str | None = None, **extra):
    params: dict[str, str] = {"project_id": pid, **extra}
    if flt is not None:
        params["filter"] = flt
    return await client.get(_BASE + "/public-scripts", params=params, headers=h)


async def _names(client, h, pid: str, flt: str | None = None, **extra) -> set[str]:
    r = await _list(client, h, pid, flt, **extra)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


# ══════════ 1. filter_meta ══════════
async def test_public_script_filter_meta(client, make_user) -> None:
    _, h = await make_user("d250a", admin=True)
    pid = await _proj(client, h, "D250元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "public_script"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["view_label"] == "公共脚本"
    assert "public_script" in body["supported_view_types"]
    fields = {f["field"]: f for f in body["fields"]}
    assert set(fields) == {"name", "language", "version", "enabled", "description"}
    assert set(fields["enabled"]["ops"]) == {"EQUALS", "NOT_EQUALS"}
    assert set(fields["language"]["ops"]) == {"EQUALS", "NOT_EQUALS", "IN", "NOT_IN"}
    assert "EMPTY" in fields["description"]["ops"]
    assert "CONTAINS" not in fields["language"]["ops"]
    # 正文 / 存 id 的作者键 / 表格不显示的时间列，统统不在筛选面
    assert not ({"content", "created_by", "updated_by", "created_at", "updated_at"}
                & set(fields))


# ══════════ 2. 真能筛 + 与快捷轴叠加 ══════════
async def test_public_script_filter_actually_filters(client, make_user) -> None:
    _, h = await make_user("d250b", admin=True)
    pid = await _proj(client, h, "D250筛选")
    await _script(client, h, pid, "登录函数", "python", description="登录复用")
    await _script(client, h, pid, "签名工具", "javascript", enabled=False,
                  description="签名算法")
    await _script(client, h, pid, "清理任务", "python")
    v2 = await _script(client, h, pid, "造数脚本", "python", content="print(2)",
                       description="造数用")
    # 内容变化 → version 2（用来验数字列筛的是真版本号）
    up = await client.patch(_BASE + f"/public-scripts/{v2['id']}", json={
        "project_id": pid, "script_id": v2["id"], "content": "print(3)",
    }, headers=h)
    assert up.status_code == 200 and up.json()["version"] == 2

    assert await _names(client, h, pid, _f(
        {"field": "language", "operator": "EQUALS", "value": "python"})) == {
        "登录函数", "清理任务", "造数脚本"}
    assert await _names(client, h, pid, _f(
        {"field": "enabled", "operator": "EQUALS", "value": False})) == {"签名工具"}
    assert await _names(client, h, pid, _f(
        {"field": "version", "operator": "GT", "value": 1})) == {"造数脚本"}
    assert await _names(client, h, pid, _f(
        {"field": "name", "operator": "CONTAINS", "value": "函数"})) == {"登录函数"}
    # 可空列：没写说明的「清理任务」
    assert await _names(client, h, pid, _f(
        {"field": "description", "operator": "EMPTY", "value": None})) == {"清理任务"}
    # OR：语言是 js 或 名称含造数
    assert await _names(client, h, pid, _f(
        {"field": "language", "operator": "EQUALS", "value": "javascript"},
        {"field": "name", "operator": "CONTAINS", "value": "造数"}, mode="OR")) == {
        "签名工具", "造数脚本"}

    # 快轴 + 高级条件并行：keyword=脚本（名称或说明） 且 只看启用 且 language=python
    assert await _names(
        client, h, pid,
        _f({"field": "language", "operator": "EQUALS", "value": "python"}),
        keyword="脚本", enabled_only="true") == {"造数脚本"}
    # 快轴单独作用仍按原口径（说明里含「签名」的禁用脚本）
    assert await _names(client, h, pid, keyword="签名") == {"签名工具"}


# ══════════ 3. 不越项目 / 空 filter ══════════
async def test_public_script_filter_scope_and_empty(client, make_user) -> None:
    _, h = await make_user("d250c", admin=True)
    pid = await _proj(client, h, "D250本项目")
    other = await _proj(client, h, "D250别的项目")
    await _script(client, h, pid, "同名脚本")
    await _script(client, h, other, "同名脚本")

    hit = _f({"field": "name", "operator": "CONTAINS", "value": "同名"})
    r = await _list(client, h, pid, hit)
    assert r.status_code == 200, r.text
    assert [x["project_id"] for x in r.json()["items"]] == [pid]

    assert "同名脚本" in await _names(client, h, pid, "")


# ══════════ 4. 坏条件 ══════════
async def test_public_script_bad_filter(client, make_user) -> None:
    _, h = await make_user("d250d", admin=True)
    pid = await _proj(client, h, "D250坏条件")

    for bad in ("content", "created_by", "updated_at"):
        r = await _list(client, h, pid, _f({"field": bad, "operator": "EQUALS", "value": "x"}))
        assert r.status_code == 400, r.text
        body = r.json()
        assert body["code"] == "bad_filter"
        assert body["details"]["view_type"] == "public_script"
        assert "本页可筛" in body["message"] and "脚本名" in body["message"]

    # 布尔列收真布尔：字符串 "true" 400
    r_bool = await _list(client, h, pid, _f(
        {"field": "enabled", "operator": "EQUALS", "value": "true"}))
    assert r_bool.status_code == 400 and r_bool.json()["code"] == "bad_filter"

    r_json = await client.get(_BASE + "/public-scripts",
                              params={"project_id": pid, "filter": "{oops"}, headers=h)
    assert r_json.status_code == 400 and r_json.json()["code"] == "bad_filter"
