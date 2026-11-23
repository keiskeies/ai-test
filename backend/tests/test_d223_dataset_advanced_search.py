"""D223 判据刀：数据集列表高级搜索（D47-a 三件套铺到数据集页）。

钉的契约：

1. **字段白名单 = DATASET_LIST_FILTER**（name / created_at / updated_at），meta 与它同源；
   白名单外 400 且带本页清单。
2. **条件是 WHERE**：与项目轴并行 AND；OR 组自带括号；跨项目行不会因条件命中而现身。
3. **现算量不是列**：`row_count`（len(rows)）/ `used_by`（引用计数）/ `scenario_held`
   （拦截标记）/ `columns`、`rows`（表格内容）都不进白名单——条件里点名它们必须 400，
   而不是悄悄按某个近似含义筛。
4. **条件进游标分页**：`size=1` 带条件翻页时，第二页接着**筛出来的集合**走，
   既不漏回未命中行，也不重复第一页那一行。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _dataset(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/datasets", json={
        "project_id": pid, "name": name,
        "columns": ["k"], "rows": [["1"], ["2"]],
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _page(client, h, pid: str, **params):
    r = await client.get(_BASE + "/datasets", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _names(client, h, pid: str, **params) -> set[str]:
    return {d["name"] for d in (await _page(client, h, pid, **params))["items"]}


async def test_filter_meta_registers_dataset(client, make_user) -> None:
    _, h = await make_user("d223a", admin=True)
    pid = await _proj(client, h, "D223元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "dataset"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "dataset" in body["supported_view_types"]
    assert body["view_label"] == "数据集"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {"name", "created_at", "updated_at"}
    # 现算量 / 表格内容 / 取数轴都不是可筛字段
    assert not ({"row_count", "used_by", "scenario_held", "columns", "rows",
                 "project_id", "cursor", "size"} & fields), \
        "现算量与取数参数不是列，不许进条件组"
    name = next(f for f in body["fields"] if f["field"] == "name")
    assert "EMPTY" not in name["ops"], "非空列不给「为空」假筛选项"
    created = next(f for f in body["fields"] if f["field"] == "created_at")
    assert created["kind"] == "time" and "BETWEEN" in created["ops"]


async def test_conditions_apply_as_where(client, make_user) -> None:
    _, h = await make_user("d223b", admin=True)
    pid = await _proj(client, h, "D223条件")
    await _dataset(client, h, pid, "登录参数")
    await _dataset(client, h, pid, "支付参数")
    await _dataset(client, h, pid, "库存基线")

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "参数"})) == {"登录参数", "支付参数"}
    # 项目内唯一名 → EQUALS 恰好一行
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "EQUALS", "value": "库存基线"})) == {"库存基线"}
    # OR：名字含「支付」或「库存」→ 两行
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "支付"},
        {"field": "name", "operator": "CONTAINS", "value": "库存"}, mode="OR")) == {
        "支付参数", "库存基线"}
    # 时间条件真参与比较：全量在未来区间内、在远古区间外
    assert await _names(client, h, pid, filter=_f(
        {"field": "created_at", "operator": "BETWEEN",
         "value": ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]})) == {
        "登录参数", "支付参数", "库存基线"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "created_at", "operator": "BETWEEN",
         "value": ["1990-01-01T00:00:00Z", "1991-01-01T00:00:00Z"]})) == set()


async def test_filter_composes_with_cursor_pagination(client, make_user) -> None:
    """条件在游标分页之前生效：翻页接着「筛出来的集合」走，不漏回未命中行也不重复。"""
    _, h = await make_user("d223c", admin=True)
    pid = await _proj(client, h, "D223翻页")
    for n in ("不相关一", "登录参数", "支付参数", "库存参数", "不相关二"):
        await _dataset(client, h, pid, n)
    flt = _f({"field": "name", "operator": "CONTAINS", "value": "参数"})

    seen: list[str] = []
    cursor = None
    for _ in range(5):
        params = {"size": 1, "filter": flt}
        if cursor:
            params["cursor"] = cursor
        body = await _page(client, h, pid, **params)
        seen += [d["name"] for d in body["items"]]
        cursor = body["next_cursor"]
        if not cursor:
            break
    # 游标列是随机 id（不是创建序），所以只钉「集合恰好是这三条、且不重不漏」
    assert sorted(seen) == sorted(["登录参数", "支付参数", "库存参数"]), \
        f"翻页把未命中行带回来了或漏了行：{seen}"
    assert len(seen) == 3, f"翻页出现重复行：{seen}"


async def test_computed_values_are_not_filterable(client, make_user) -> None:
    """现算量与表格内容不是列：点名它们必须 400 带本页清单，不许按近似含义筛。"""
    _, h = await make_user("d223d", admin=True)
    pid = await _proj(client, h, "D223现算")
    await _dataset(client, h, pid, "登录参数")

    for field, value in (("row_count", 2), ("used_by", 0), ("columns", "k"),
                         ("project_id", pid)):
        bad = await client.get(_BASE + "/datasets", params={
            "project_id": pid,
            "filter": _f({"field": field, "operator": "EQUALS", "value": value}),
        }, headers=h)
        assert bad.status_code == 400, f"{field} 竟然可筛：{bad.text}"
        assert bad.json()["code"] == "bad_filter"
        assert bad.json()["details"]["view_type"] == "dataset"
    # 400 要带本页清单：字段名是后端定的，只说「不合法」等于让人猜
    err = await client.get(_BASE + "/datasets", params={
        "project_id": pid,
        "filter": _f({"field": "row_count", "operator": "GT", "value": 0}),
    }, headers=h)
    assert "本页可筛" in err.json()["message"]
    assert "数据集名称" in err.json()["message"]


async def test_filter_does_not_cross_projects(client, make_user) -> None:
    """条件命中别的项目的行也不会越项目现身：项目轴先于条件组。"""
    _, h = await make_user("d223e", admin=True)
    pa = await _proj(client, h, "D223甲")
    pb = await _proj(client, h, "D223乙")
    await _dataset(client, h, pa, "登录参数-甲")
    await _dataset(client, h, pb, "登录参数-乙")

    assert await _names(client, h, pa) == {"登录参数-甲"}
    assert await _names(client, h, pa, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录参数"})) == {"登录参数-甲"}
    # 点名另一项目的名字也不行：它在这个项目里不存在
    assert await _names(client, h, pa, filter=_f(
        {"field": "name", "operator": "EQUALS", "value": "登录参数-乙"})) == set()
