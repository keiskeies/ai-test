"""D205 判据刀：功能用例 Excel 模板/导入/导出。

钉的契约（一条判断一条用例）：

1. **模板列头 = 固定列 + 当前模板自定义字段**（必填带 `*`），并带「填写说明」页；
   自定义字段的必填/可选项在说明页可见。
2. **导入成功**：模块全路径解析、优先级缺省 P2、多值按逗号拆、自定义字段按类型归一化、
   编号连续取号；落库后单条详情读得到同样的值。
3. **全有或全无**：任意一行错（优先级非法/必填自定义字段缺失/模块路径不存在）→ 整批 422
   带 Excel 行号，**一行都不落库**。
4. **导出回环**：导出文件列头与模板一致，按模块递归 + 优先级筛选，多值列回写为逗号串。
5. **权限位**：READONLY 可读模板/导出，导入 403 且 details.perm 指名。
6. **坏文件**：非 xlsx 字节 → 422 人话，不是 500。
"""

from __future__ import annotations

from io import BytesIO

import openpyxl

_BASE = "/api/v1"
_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _field(
    client, h, pid: str, name: str, key: str, ftype: str = "input", options: list[dict] | None = None
) -> dict:
    r = await client.post(
        _BASE + "/custom-fields",
        json={
            "project_id": pid,
            "scene": "functional",
            "name": name,
            "field_key": key,
            "type": ftype,
            "options": options or [],
        },
        headers=h,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _template(client, h, pid: str, fields: list[dict]) -> dict:
    r = await client.post(
        _BASE + "/templates",
        json={
            "project_id": pid,
            "scene": "functional",
            "name": "导入模板",
            "fields": fields,
        },
        headers=h,
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _module(client, h, pid: str, name: str, parent_id: str | None = None) -> str:
    r = await client.post(
        _BASE + "/functional-modules",
        json={
            "project_id": pid,
            "name": name,
            "parent_id": parent_id,
        },
        headers=h,
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _workbook(headers: list[str], rows: list[list]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "用例"
    ws.append(headers)
    for r in rows:
        ws.append(r)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _load(data: bytes) -> openpyxl.Workbook:
    return openpyxl.load_workbook(BytesIO(data), data_only=True)


async def _headers(client, h, pid: str, tpl_id: str) -> list[str]:
    r = await client.get(
        _BASE + "/functional-cases/import-template",
        params={"project_id": pid, "template_id": tpl_id},
        headers=h,
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith(_XLSX)
    ws = _load(r.content)["用例"]
    return [str(c.value) for c in ws[1]]


async def _import(client, h, pid: str, tpl_id: str, data: bytes, module_id: str | None = None):
    form = {"project_id": pid, "template_id": tpl_id}
    if module_id:
        form["module_id"] = module_id
    return await client.post(
        _BASE + "/functional-cases/import", data=form, files={"file": ("cases.xlsx", data, _XLSX)}, headers=h
    )


async def _cases(client, h, pid: str, keyword: str = "") -> list[dict]:
    r = await client.get(
        _BASE + "/functional-cases",
        params={"project_id": pid, "current": 1, "size": 200, "keyword": keyword},
        headers=h,
    )
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def _seed_project(client, h, tag: str):
    pid = await _proj(client, h, "D205" + tag)
    f_req = await _field(
        client,
        h,
        pid,
        "严重级别",
        "severity",
        "select",
        [{"label": "高", "value": "high"}, {"label": "低", "value": "low"}],
    )
    f_tags = await _field(
        client,
        h,
        pid,
        "标签",
        "tags",
        "multiple_select",
        [{"label": "冒烟", "value": "smoke"}, {"label": "回归", "value": "regress"}],
    )
    tpl = await _template(
        client,
        h,
        pid,
        [
            {"field_id": f_req["id"], "required": True, "sort": 1},
            {"field_id": f_tags["id"], "required": False, "sort": 2},
        ],
    )
    parent = await _module(client, h, pid, "登录")
    child = await _module(client, h, pid, "异常", parent)
    return pid, tpl, child


async def test_template_and_import_happy_path(client, make_user) -> None:
    """模板列头 → 导入两行 → 详情里的值逐项对得上。"""
    boss, h = await make_user("d205a", admin=True)
    pid, tpl, child = await _seed_project(client, h, "A")
    headers = await _headers(client, h, pid, tpl["id"])
    assert headers == ["编号", "用例名称", "优先级", "模块", "描述", "严重级别*", "标签"], headers
    help_ws = _load(
        (
            await client.get(
                _BASE + "/functional-cases/import-template",
                params={"project_id": pid, "template_id": tpl["id"]},
                headers=h,
            )
        ).content
    )["填写说明"]
    help_rows = [[c.value for c in row] for row in help_ws.iter_rows()]
    assert any(r[0] == "严重级别*" and r[2] == "是" for r in help_rows), help_rows
    assert any(r[0] == "标签" and "多选" in str(r[1]) and "可选项" in str(r[3]) for r in help_rows), help_rows

    data = _workbook(
        headers,
        [
            ["", "用例A", "P1", "登录/异常", "描述A", "high", "冒烟,回归"],
            ["", "用例B", "", "", "", "low", ""],
        ],
    )
    r = await _import(client, h, pid, tpl["id"], data, module_id=child)
    assert r.status_code == 200, r.text
    assert r.json() == {"created": 2, "rows": 2}

    a = (await _cases(client, h, pid, "用例A"))[0]
    b = (await _cases(client, h, pid, "用例B"))[0]
    assert (a["name"], a["priority"], a["module_id"]) == ("用例A", "P1", child)
    assert (b["name"], b["priority"], b["module_id"]) == ("用例B", "P2", child), (
        "空优先级应落 P2；空模块走表单默认模块"
    )
    assert b["num"] == a["num"] + 1, "同批导入的编号要连续"

    detail = await client.get(_BASE + f"/functional-cases/{a['id']}", params={"project_id": pid}, headers=h)
    assert detail.status_code == 200, detail.text
    custom = detail.json()["custom_fields"]
    assert "high" in custom.values(), custom
    multi = [v for v in custom.values() if isinstance(v, list)]
    assert multi and sorted(multi[0]) == ["regress", "smoke"], custom


async def test_import_is_all_or_nothing(client, make_user) -> None:
    """三类坏行各自 422 带行号，且一行都不落库。"""
    boss, h = await make_user("d205b", admin=True)
    pid, tpl, child = await _seed_project(client, h, "B")
    headers = await _headers(client, h, pid, tpl["id"])

    bad_priority = _workbook(
        headers,
        [
            ["", "原子甲", "P1", "", "", "high", ""],
            ["", "原子乙", "X9", "", "", "high", ""],
        ],
    )
    r = await _import(client, h, pid, tpl["id"], bad_priority, module_id=child)
    assert r.status_code == 422 and r.json()["code"] == "import_invalid", r.text
    errs = r.json()["details"]["errors"]
    assert errs[0]["row"] == 3 and "优先级" in errs[0]["message"], errs
    assert await _cases(client, h, pid, "原子") == [], "整批 422 却写进去了半批"

    missing_required = _workbook(
        headers,
        [
            ["", "原子丙", "P1", "", "", "", ""],
        ],
    )
    r = await _import(client, h, pid, tpl["id"], missing_required, module_id=child)
    assert r.status_code == 422, r.text
    assert "必填" in r.json()["details"]["errors"][0]["message"]

    bad_module = _workbook(
        headers,
        [
            ["", "原子丁", "P1", "不存在的/模块", "", "high", ""],
        ],
    )
    r = await _import(client, h, pid, tpl["id"], bad_module, module_id=child)
    assert r.status_code == 422, r.text
    assert "模块路径不存在" in r.json()["details"]["errors"][0]["message"]
    assert await _cases(client, h, pid, "原子") == []


async def test_export_roundtrip_and_filters(client, make_user) -> None:
    """导出列头同模板；模块递归/优先级筛选生效；多值回写逗号串。"""
    boss, h = await make_user("d205c", admin=True)
    pid, tpl, child = await _seed_project(client, h, "C")
    headers = await _headers(client, h, pid, tpl["id"])
    data = _workbook(
        headers,
        [
            ["", "导出甲", "P1", "登录/异常", "说明甲", "high", "冒烟,回归"],
            ["", "导出乙", "P0", "", "", "low", ""],
        ],
    )
    ok = await _import(client, h, pid, tpl["id"], data, module_id=child)
    assert ok.status_code == 200, ok.text

    r = await client.get(
        _BASE + "/functional-cases/export",
        params={"project_id": pid, "template_id": tpl["id"], "module_id": child},
        headers=h,
    )
    assert r.status_code == 200 and r.headers["content-type"].startswith(_XLSX)
    wb = _load(r.content)
    ws = wb["用例"]
    rows = [[c.value for c in row] for row in ws.iter_rows()]
    assert rows[0] == headers, rows[0]
    assert len(rows) == 3 and rows[1][1] == "导出甲" and rows[1][3] == "登录/异常"
    assert rows[1][5] == "高" and rows[1][6] == "冒烟,回归", rows[1]
    assert wb["填写说明"] is not None

    p1 = await client.get(
        _BASE + "/functional-cases/export",
        params={"project_id": pid, "template_id": tpl["id"], "priority": "P1"},
        headers=h,
    )
    rows_p1 = [[c.value for c in row] for row in _load(p1.content)["用例"].iter_rows()]
    assert len(rows_p1) == 2 and rows_p1[1][2] == "P1", rows_p1


async def test_import_perm_and_file_errors(client, make_user) -> None:
    """READONLY：模板/导出放行，导入 403 指名权限位；非 xlsx → 422 人话。"""
    boss, h = await make_user("d205d", admin=True)
    pid, tpl, child = await _seed_project(client, h, "D")
    ro, hr = await make_user("d205dro")
    m = await client.put(
        _BASE + f"/projects/{pid}/members/{ro.id}", json={"role_code": "READONLY"}, headers=h
    )
    assert m.status_code == 200, m.text

    assert (
        await client.get(
            _BASE + "/functional-cases/import-template",
            params={"project_id": pid, "template_id": tpl["id"]},
            headers=hr,
        )
    ).status_code == 200
    assert (
        await client.get(_BASE + "/functional-cases/export", params={"project_id": pid}, headers=hr)
    ).status_code == 200

    headers = await _headers(client, h, pid, tpl["id"])
    data = _workbook(headers, [["", "无权导入", "P1", "", "", "high", ""]])
    denied = await _import(client, hr, pid, tpl["id"], data, module_id=child)
    assert denied.status_code == 403, denied.text
    assert denied.json()["details"]["perm"] == "functional:case:create"

    junk = await _import(client, h, pid, tpl["id"], b"not an xlsx", module_id=child)
    assert junk.status_code == 422, junk.text
    assert junk.json()["code"] == "import_invalid"
