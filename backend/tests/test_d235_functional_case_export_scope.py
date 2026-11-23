"""D235 判据刀：功能用例导出的「所见即所得」。

此前导出只认「模块递归 + 关键字 + 优先级」，D219 的高级搜索与 D234 的「我关注的」
在列表上生效、在导出里被静默丢掉——用户筛完再导出得到更多行，还以为筛过了。
本刀把导出的筛选轴与列表对齐，并补「导出所选」：

1. `ids`：只导出这些 id（与其它条件 AND）；回收站/跨项目 id 不串入，不报错。
2. `filter`：与列表同一个 `FUNCTIONAL_CASE_LIST_FILTER`（同一把尺）；非法条件 → 400
   `bad_filter`，**不降级为忽略**（否则导出的就是没筛过的全量）。
3. `followed_by_me`：只导出我关注的（与 D234 的列表视图轴同口径）。
4. 参数闸：`ids` 超 500 → 422 `too_many_ids`；`ids=` 空串 → 422 `empty_ids`。
5. 权限不变：导出仍是 `functional:case:read`，READONLY 可用。
"""
from __future__ import annotations

from io import BytesIO

import openpyxl

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _case(client, h, pid: str, name: str, **kw) -> dict:
    r = await client.post(_BASE + "/functional-cases",
                          json={"project_id": pid, "name": name, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _export(client, h, pid: str, **params):
    return await client.get(_BASE + "/functional-cases/export",
                            params={"project_id": pid, **params}, headers=h)


def _names(r) -> list[str]:
    assert r.status_code == 200, r.text
    ws = openpyxl.load_workbook(BytesIO(r.content))["用例"]
    rows = [[c.value for c in row] for row in ws.iter_rows()]
    return [str(row[1]) for row in rows[1:]]


async def test_ids_export_only_selected(client, make_user) -> None:
    _, h = await make_user("d235a", admin=True)
    pid = await _proj(client, h, "D235所选")
    a = await _case(client, h, pid, "甲")
    await _case(client, h, pid, "乙")
    c = await _case(client, h, pid, "丙")
    pid_b = await _proj(client, h, "D235别项目")
    other = await _case(client, h, pid_b, "别项目用例")

    assert _names(await _export(client, h, pid, ids=a["id"] + "," + c["id"])) == ["甲", "丙"]
    # 别项目的 id 混进来不会串行（project_id 是硬边界），也不报错
    assert _names(await _export(client, h, pid, ids=other["id"])) == []


async def test_advanced_filter_matches_list(client, make_user) -> None:
    _, h = await make_user("d235b", admin=True)
    pid = await _proj(client, h, "D235高级")
    await _case(client, h, pid, "高危", priority="P0")
    await _case(client, h, pid, "低危", priority="P3")

    flt = '{"search_mode":"AND","conditions":' \
          '[{"field":"priority","operator":"EQUALS","value":"P0"}]}'
    assert _names(await _export(client, h, pid, filter=flt)) == ["高危"]

    # 列表与导出同一把尺：同样的条件，列表也只给一行
    r = await client.get(_BASE + "/functional-cases",
                         params={"project_id": pid, "filter": flt}, headers=h)
    assert [i["name"] for i in r.json()["items"]] == ["高危"]

    bad = await _export(client, h, pid, filter='{"search_mode":"AND","conditions":'
                                               '[{"field":"no_such","operator":"EQUALS","value":"x"}]}')
    assert bad.status_code == 400 and bad.json()["code"] == "bad_filter"


async def test_followed_by_me_export(client, make_user) -> None:
    _, h = await make_user("d235c", admin=True)
    pid = await _proj(client, h, "D235关注")
    a = await _case(client, h, pid, "甲")
    await _case(client, h, pid, "乙")
    r = await client.post(_BASE + f"/functional-cases/{a['id']}/follow",
                          json={"project_id": pid, "case_id": a["id"]}, headers=h)
    assert r.status_code == 200, r.text
    assert _names(await _export(client, h, pid, followed_by_me="true")) == ["甲"]


async def test_ids_param_guards_and_readonly(client, make_user) -> None:
    _, h = await make_user("d235d", admin=True)
    pid = await _proj(client, h, "D235闸")
    a = await _case(client, h, pid, "甲")

    r = await _export(client, h, pid, ids="")
    assert r.status_code == 422 and r.json()["code"] == "empty_ids"
    r = await _export(client, h, pid, ids=",".join(f"x{i}" for i in range(501)))
    assert r.status_code == 422 and r.json()["code"] == "too_many_ids"

    ro, roh = await make_user("d235d_ro")
    m = await client.put(_BASE + f"/projects/{pid}/members/{ro.id}",
                         json={"role_code": "READONLY"}, headers=h)
    assert m.status_code == 200, m.text
    assert _names(await _export(client, roh, pid, ids=a["id"])) == ["甲"]
