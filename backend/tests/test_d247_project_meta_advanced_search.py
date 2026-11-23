"""D247 判据刀：设置页「模板与字段」两表高级搜索（D47-a 三件套铺到 project_meta）。

钉的契约（对应 project_meta/services.py 两张白名单的注释）：

1. **两枚 view_type 各自登记**：template / custom_field，页面名与字段面互不串门。
2. **白名单只收稳定标量列**：`scene` 被列表入参钉死，放进白名单只会筛出空集；
   `field_count` / `template_count` 是聚合展示值，不是列——两处都点名即 400。
3. **条件真的进 SQL**：文本 CONTAINS / 枚举 EQUALS / bool EQUALS 真布尔 / time BETWEEN
   各来一发，并核对「筛完剩下谁」。
4. **不越项目**：filter 只收窄既有 project_id + scene 取数轴，别的项目的同名行不会浮上来。
5. 坏条件 400 且 code=bad_filter、message 带本页可筛清单；空 filter = 没传。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _field(client, h, pid: str, name: str, key: str, ftype: str = "input",
                 options: list[dict] | None = None, description: str | None = None) -> dict:
    r = await client.post(_BASE + "/custom-fields", json={
        "project_id": pid, "scene": "bug", "name": name, "field_key": key,
        "type": ftype, "options": options or [], "description": description,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _template(client, h, pid: str, name: str, description: str | None = None) -> dict:
    r = await client.post(_BASE + "/templates", json={
        "project_id": pid, "scene": "bug", "name": name, "description": description,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _templates(client, h, pid: str, flt: str | None = None):
    params: dict[str, str] = {"project_id": pid, "scene": "bug"}
    if flt is not None:
        params["filter"] = flt
    return await client.get(_BASE + "/templates", params=params, headers=h)


async def _fields(client, h, pid: str, flt: str | None = None):
    params: dict[str, str] = {"project_id": pid, "scene": "bug"}
    if flt is not None:
        params["filter"] = flt
    return await client.get(_BASE + "/custom-fields", params=params, headers=h)


async def _template_names(client, h, pid: str, flt: str | None = None) -> set[str]:
    r = await _templates(client, h, pid, flt)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def _field_names(client, h, pid: str, flt: str | None = None) -> set[str]:
    r = await _fields(client, h, pid, flt)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


# ══════════ 1. filter_meta ══════════
async def test_filter_meta_registers_both_pages(client, make_user) -> None:
    _, h = await make_user("d247a", admin=True)
    pid = await _proj(client, h, "D247元数据")

    t = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "template"}, headers=h)
    assert t.status_code == 200, t.text
    tb = t.json()
    assert tb["view_label"] == "项目模板"
    assert {"template", "custom_field"} <= set(tb["supported_view_types"])
    tfields = {f["field"]: f for f in tb["fields"]}
    assert set(tfields) == {"name", "description", "internal", "is_default", "sort",
                            "created_at", "updated_at"}
    assert set(tfields["internal"]["ops"]) == {"EQUALS", "NOT_EQUALS"}
    assert "EMPTY" in tfields["description"]["ops"]
    assert "EMPTY" not in tfields["name"]["ops"]  # 非空列拿不到「为空」
    assert "BETWEEN" in tfields["created_at"]["ops"]
    # scene 已被列表入参钉死，聚合展示值不是列——都不能出现在筛选面里
    assert not ({"scene", "field_count"} & set(tfields))

    f = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "custom_field"}, headers=h)
    assert f.status_code == 200, f.text
    fb = f.json()
    assert fb["view_label"] == "自定义字段"
    ffields = {x["field"]: x for x in fb["fields"]}
    assert set(ffields) == {"name", "field_key", "type", "description", "internal", "sort",
                            "created_at", "updated_at"}
    assert ffields["type"]["kind"] == "enum" and "CONTAINS" not in ffields["type"]["ops"]
    assert not ({"scene", "template_count", "options"} & set(ffields))


# ══════════ 2. 模板筛选真能筛 ══════════
async def test_template_filter_actually_filters(client, make_user) -> None:
    _, h = await make_user("d247b", admin=True)
    pid = await _proj(client, h, "D247模板")
    # 首次列表会惰性建系统默认模板（internal + is_default）
    assert len(await _template_names(client, h, pid)) == 1
    await _template(client, h, pid, "缺陷模板甲", description="前端回归用")
    await _template(client, h, pid, "缺陷模板乙", description="后端冒烟用")

    assert await _template_names(client, h, pid, _f(
        {"field": "name", "operator": "CONTAINS", "value": "甲"})) == {"缺陷模板甲"}
    assert await _template_names(client, h, pid, _f(
        {"field": "description", "operator": "CONTAINS", "value": "回归"})) == {"缺陷模板甲"}
    # 系统内置 / 默认两枚布尔列各筛一次（默认模板同时命中两列）
    assert await _template_names(client, h, pid, _f(
        {"field": "internal", "operator": "EQUALS", "value": True})) == {"系统默认（缺陷）"}
    assert await _template_names(client, h, pid, _f(
        {"field": "is_default", "operator": "EQUALS", "value": False})) == {"缺陷模板甲", "缺陷模板乙"}
    # OR：名称含甲 或 描述含冒烟
    assert await _template_names(client, h, pid, _f(
        {"field": "name", "operator": "CONTAINS", "value": "甲"},
        {"field": "description", "operator": "CONTAINS", "value": "冒烟"}, mode="OR")) == {
        "缺陷模板甲", "缺陷模板乙"}
    # time BETWEEN 覆盖全部
    assert len(await _template_names(client, h, pid, _f(
        {"field": "created_at", "operator": "BETWEEN",
         "value": ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]}))) == 3
    assert await _template_names(client, h, pid, _f(
        {"field": "created_at", "operator": "BETWEEN",
         "value": ["1990-01-01T00:00:00Z", "1991-01-01T00:00:00Z"]})) == set()


# ══════════ 3. 自定义字段筛选真能筛 ══════════
async def test_custom_field_filter_actually_filters(client, make_user) -> None:
    _, h = await make_user("d247c", admin=True)
    pid = await _proj(client, h, "D247字段")
    await _field(client, h, pid, "严重程度", "severity", "select",
                 [{"value": "s1", "label": "致命"}], description="缺陷定级")
    await _field(client, h, pid, "复现步骤", "steps", "textarea")
    await _field(client, h, pid, "影响版本", "affected_version", "input", description="发版必填")

    assert await _field_names(client, h, pid, _f(
        {"field": "field_key", "operator": "CONTAINS", "value": "ver"})) == {"严重程度", "影响版本"}
    assert await _field_names(client, h, pid, _f(
        {"field": "type", "operator": "EQUALS", "value": "textarea"})) == {"复现步骤"}
    assert await _field_names(client, h, pid, _f(
        {"field": "type", "operator": "IN", "value": ["input", "select"]})) == {
        "严重程度", "影响版本"}
    # 可空列：描述为空的只有「复现步骤」
    assert await _field_names(client, h, pid, _f(
        {"field": "description", "operator": "EMPTY", "value": None})) == {"复现步骤"}
    # 否定筛选留 NULL 行（description 为空的复现步骤必须还在）
    assert await _field_names(client, h, pid, _f(
        {"field": "description", "operator": "NOT_CONTAINS", "value": "发版"})) == {
        "严重程度", "复现步骤"}
    assert await _field_names(client, h, pid, _f(
        {"field": "internal", "operator": "EQUALS", "value": False})) == {
        "严重程度", "复现步骤", "影响版本"}
    # sort 是数字列：GT/LT 走数值比较而不是字符串
    assert await _field_names(client, h, pid, _f(
        {"field": "sort", "operator": "GT", "value": -1})) == {
        "严重程度", "复现步骤", "影响版本"}


# ══════════ 4. 不越项目 / 空 filter ══════════
async def test_filter_does_not_widen_scope_and_empty_means_all(client, make_user) -> None:
    _, h = await make_user("d247d", admin=True)
    pid = await _proj(client, h, "D247本项目")
    other = await _proj(client, h, "D247别的项目")
    await _template(client, h, pid, "同名模板")
    await _template(client, h, other, "同名模板")
    await _field(client, h, pid, "同名字段", "same_key")
    await _field(client, h, other, "同名字段", "same_key")

    hit = _f({"field": "name", "operator": "CONTAINS", "value": "同名"})
    r = await _templates(client, h, pid, hit)
    assert r.status_code == 200, r.text
    assert [x["project_id"] for x in r.json()["items"]] == [pid]

    r2 = await _fields(client, h, pid, hit)
    assert r2.status_code == 200, r2.text
    assert [x["project_id"] for x in r2.json()["items"]] == [pid]

    # 空串 = 没筛选（前端清空时常发空串），不是 400 也不是空结果
    assert "同名模板" in await _template_names(client, h, pid, "")
    assert "同名字段" in await _field_names(client, h, pid, "")


# ══════════ 5. 坏条件 ══════════
async def test_bad_filter_is_400_with_page_field_list(client, make_user) -> None:
    _, h = await make_user("d247e", admin=True)
    pid = await _proj(client, h, "D247坏条件")

    # 先触发默认模板惰性创建（首次 GET /templates 会建系统默认），免得与 400 混在一起
    assert (await _templates(client, h, pid)).status_code == 200

    # 聚合展示值 / 被钉死的取数轴都不在白名单里
    r = await _templates(client, h, pid, _f(
        {"field": "field_count", "operator": "EQUALS", "value": 1}))
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["code"] == "bad_filter"
    assert body["details"]["view_type"] == "template"
    assert "本页可筛" in body["message"] and "模板名称" in body["message"]

    r_cnt = await _fields(client, h, pid, _f(
        {"field": "template_count", "operator": "EQUALS", "value": 1}))
    assert r_cnt.status_code == 400, r_cnt.text
    assert r_cnt.json()["details"]["view_type"] == "custom_field"
    assert "字段名称" in r_cnt.json()["message"]

    # scene 是取数轴，不是可筛字段
    r_scene = await _templates(client, h, pid, _f(
        {"field": "scene", "operator": "EQUALS", "value": "bug"}))
    assert r_scene.status_code == 400 and r_scene.json()["code"] == "bad_filter"

    # 布尔列收真布尔：字符串 "true" 不是这把尺上的值
    r_bool = await _templates(client, h, pid, _f(
        {"field": "internal", "operator": "EQUALS", "value": "true"}))
    assert r_bool.status_code == 400 and r_bool.json()["code"] == "bad_filter"

    # 坏 JSON 不许降级成「没筛」
    r_json = await client.get(_BASE + "/custom-fields", params=[
        ("project_id", pid), ("scene", "bug"), ("filter", "{not json")], headers=h)
    assert r_json.status_code == 400 and r_json.json()["code"] == "bad_filter"
