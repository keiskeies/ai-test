"""D192：模板 / 自定义字段 / 取号 + 缺陷接入。

覆盖：
1. 迁移形状（6 张新表、defect 的 num/template_id NOT NULL + 唯一键）。
2. 默认模板惰性创建（幂等）。
3. 自定义字段 CRUD + 选项 + 删除护栏（被模板引用/有值行 → 409）。
4. 模板 CRUD + 设默认 + 删除护栏（系统/默认/被缺陷引用 → 409）。
5. 缺陷接入：必填/类型/选项校验；值往返；换模板；num 项目内唯一、跨项目重开。
6. 彻底删除级联自定义值。
"""
from __future__ import annotations

from sqlalchemy import text

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _field(client, h, pid: str, name: str, key: str, ftype: str = "input",
                 options: list[dict] | None = None) -> dict:
    r = await client.post(_BASE + "/custom-fields", json={
        "project_id": pid, "scene": "bug", "name": name, "field_key": key,
        "type": ftype, "options": options or [],
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _template(client, h, pid: str, name: str, fields: list[dict]) -> dict:
    r = await client.post(_BASE + "/templates", json={
        "project_id": pid, "scene": "bug", "name": name, "fields": fields,
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _defect(client, h, pid: str, title: str, **kw) -> dict:
    r = await client.post(_BASE + "/defects", json={"project_id": pid, "title": title, **kw}, headers=h)
    return r


async def _templates(client, h, pid: str) -> list[dict]:
    r = await client.get(_BASE + "/templates", params={"project_id": pid, "scene": "bug"}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["items"]


# ══════════ 1. 迁移形状 ══════════
async def test_project_meta_tables_and_defect_columns(conn) -> None:
    from sqlalchemy import inspect

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "defect_cols": {c["name"]: c for c in insp.get_columns("defect")},
            "defect_uq": {u["name"] for u in insp.get_unique_constraints("defect")},
            "seq_pk": tuple(insp.get_pk_constraint("num_sequence")["constrained_columns"]),
            "tpl_uq": {u["name"] for u in insp.get_unique_constraints("project_template")},
            "tf_uq": {u["name"] for u in insp.get_unique_constraints("project_template_field")},
            "cf_uq": {u["name"] for u in insp.get_unique_constraints("project_custom_field")},
        }

    got = await conn.run_sync(_read)
    assert {"num_sequence", "project_template", "project_custom_field",
            "project_custom_field_option", "project_template_field",
            "defect_custom_field"} <= got["tables"]
    assert got["defect_cols"]["num"]["nullable"] is False
    assert got["defect_cols"]["template_id"]["nullable"] is False
    assert "uq_defect_project_num" in got["defect_uq"]
    assert got["seq_pk"] == ("project_id", "scene")
    assert "uq_project_template_scene_name" in got["tpl_uq"]
    assert "uq_project_template_field_pair" in got["tf_uq"]
    assert {"uq_project_custom_field_key", "uq_project_custom_field_scene_name"} <= got["cf_uq"]


# ══════════ 2. 默认模板 ══════════
async def test_default_template_is_lazy_and_idempotent(client, make_user) -> None:
    _, h = await make_user("d192a", admin=True)
    pid = await _proj(client, h, "D192默认")
    first = await _templates(client, h, pid)
    assert len(first) == 1 and first[0]["internal"] is True and first[0]["is_default"] is True
    again = await _templates(client, h, pid)
    assert [x["id"] for x in again] == [first[0]["id"]], "默认模板不许重复创建"
    # 五个场景都能拿默认（功能用例/接口/UI/计划先建着，等写入方）
    for scene in ("functional", "api", "ui", "test_plan"):
        r = await client.get(_BASE + "/templates", params={"project_id": pid, "scene": scene}, headers=h)
        assert r.status_code == 200 and r.json()["items"][0]["is_default"] is True


# ══════════ 3. 字段 CRUD + 护栏 ══════════
async def test_custom_field_crud_and_delete_guards(client, make_user) -> None:
    _, h = await make_user("d192f", admin=True)
    pid = await _proj(client, h, "D192字段")
    f = await _field(client, h, pid, "严重程度", "severity", "select",
                     [{"value": "s1", "label": "致命"}, {"value": "s2", "label": "一般"}])
    assert [o["value"] for o in f["options"]] == ["s1", "s2"]
    dup_key = await client.post(_BASE + "/custom-fields", json={
        "project_id": pid, "scene": "bug", "name": "另一个", "field_key": "severity", "type": "input",
    }, headers=h)
    assert dup_key.status_code == 409
    dup_name = await client.post(_BASE + "/custom-fields", json={
        "project_id": pid, "scene": "bug", "name": "严重程度", "field_key": "severity2", "type": "input",
    }, headers=h)
    assert dup_name.status_code == 409
    bad_opts = await client.post(_BASE + "/custom-fields", json={
        "project_id": pid, "scene": "bug", "name": "无选项", "field_key": "noopt", "type": "select",
    }, headers=h)
    assert bad_opts.status_code == 422, "选项型字段必须带选项"

    listing = await client.get(_BASE + "/custom-fields", params={"project_id": pid, "scene": "bug"}, headers=h)
    assert [x["field_key"] for x in listing.json()["items"]] == ["severity"]

    t = await _template(client, h, pid, "带字段模板", [{"field_id": f["id"], "required": True}])
    used = await client.post(_BASE + f"/custom-fields/{f['id']}/delete",
                             json={"project_id": pid, "field_id": f["id"]}, headers=h)
    assert used.status_code == 409 and used.json()["code"] == "field_in_use"

    # 从模板移除后可以删（没有值行）
    upd = await client.patch(_BASE + f"/templates/{t['id']}",
                             json={"project_id": pid, "fields": []}, headers=h)
    assert upd.status_code == 200
    gone = await client.post(_BASE + f"/custom-fields/{f['id']}/delete",
                             json={"project_id": pid, "field_id": f["id"]}, headers=h)
    assert gone.status_code == 200


# ══════════ 4. 模板 CRUD + 护栏 ══════════
async def test_template_crud_default_and_delete_guards(client, make_user) -> None:
    _, h = await make_user("d192t", admin=True)
    pid = await _proj(client, h, "D192模板")
    f = await _field(client, h, pid, "复现概率", "rate", "select",
                     [{"value": "high", "label": "必现"}, {"value": "low", "label": "偶现"}])
    t = await _template(client, h, pid, "缺陷模板A", [{"field_id": f["id"], "required": True, "sort": 2}])
    assert t["is_default"] is False and t["fields"][0]["required"] is True
    assert t["fields"][0]["options"][0]["value"] == "high"

    internal = (await _templates(client, h, pid))[0]
    assert internal["internal"] is True
    dele = await client.post(_BASE + f"/templates/{internal['id']}/delete",
                             json={"project_id": pid, "template_id": internal["id"]}, headers=h)
    assert dele.status_code == 409 and dele.json()["code"] == "internal_template"

    dft = await client.post(_BASE + f"/templates/{t['id']}/set-default",
                            json={"project_id": pid, "template_id": t["id"]}, headers=h)
    assert dft.status_code == 200 and dft.json()["is_default"] is True
    # 默认模板不可删
    dele2 = await client.post(_BASE + f"/templates/{t['id']}/delete",
                              json={"project_id": pid, "template_id": t["id"]}, headers=h)
    assert dele2.status_code == 409 and dele2.json()["code"] == "default_template"

    # 建缺陷后：被引用不可删（先切默认回系统模板，排除默认因素）
    await client.post(_BASE + f"/templates/{internal['id']}/set-default",
                      json={"project_id": pid, "template_id": internal["id"]}, headers=h)
    r = await _defect(client, h, pid, "用模板A", template_id=t["id"], custom_fields={f["id"]: "high"})
    assert r.status_code == 201, r.text
    dele3 = await client.post(_BASE + f"/templates/{t['id']}/delete",
                              json={"project_id": pid, "template_id": t["id"]}, headers=h)
    assert dele3.status_code == 409 and dele3.json()["code"] == "template_in_use"


# ══════════ 5. 缺陷接入：校验 + 往返 + num ══════════
async def test_defect_custom_fields_and_num(client, make_user) -> None:
    _, h = await make_user("d192d", admin=True)
    pid = await _proj(client, h, "D192缺陷")
    pid2 = await _proj(client, h, "D192缺陷B")
    severity = await _field(client, h, pid, "严重程度", "severity", "select",
                            [{"value": "s1", "label": "致命"}, {"value": "s2", "label": "一般"}])
    count = await _field(client, h, pid, "影响用户数", "users", "int")
    tags = await _field(client, h, pid, "模块", "modules", "multiple_select",
                        [{"value": "login", "label": "登录"}, {"value": "pay", "label": "支付"}])
    t = await _template(client, h, pid, "主模板", [
        {"field_id": severity["id"], "required": True},
        {"field_id": count["id"], "required": False},
        {"field_id": tags["id"], "required": False},
    ])
    await client.post(_BASE + f"/templates/{t['id']}/set-default",
                      json={"project_id": pid, "template_id": t["id"]}, headers=h)

    missing = await _defect(client, h, pid, "必填缺失")
    assert missing.status_code == 422 and missing.json()["code"] == "custom_field_invalid"
    bad_opt = await _defect(client, h, pid, "坏选项", custom_fields={severity["id"]: "s9"})
    assert bad_opt.status_code == 422
    bad_int = await _defect(client, h, pid, "坏整数", custom_fields={severity["id"]: "s1", count["id"]: "abc"})
    assert bad_int.status_code == 422
    unknown = await _defect(client, h, pid, "陌生字段", custom_fields={severity["id"]: "s1", "ghost": 1})
    assert unknown.status_code == 422

    d1 = await _defect(client, h, pid, "第一条", custom_fields={
        severity["id"]: "s1", count["id"]: 12, tags["id"]: ["login", "pay"]})
    assert d1.status_code == 201, d1.text
    body = d1.json()
    assert body["num"] == 100001 and body["template_id"] == t["id"]
    assert body["custom_fields"][severity["id"]] == "s1"
    assert body["custom_fields"][count["id"]] == 12
    assert body["custom_fields"][tags["id"]] == ["login", "pay"]

    d2 = await _defect(client, h, pid, "第二条", custom_fields={severity["id"]: "s2"})
    assert d2.status_code == 201 and d2.json()["num"] == 100002
    other = await _defect(client, h, pid2, "另一个项目")
    assert other.status_code == 201 and other.json()["num"] == 100001, "编号按项目独立"

    got = await client.get(_BASE + f"/defects/{body['id']}", params={"project_id": pid}, headers=h)
    assert got.json()["custom_fields"][count["id"]] == 12
    listed = await client.get(_BASE + "/defects", params={"project_id": pid}, headers=h)
    row = [x for x in listed.json()["items"] if x["id"] == body["id"]][0]
    assert row["custom_fields"][severity["id"]] == "s1"

    # 更新值（全量替换）
    upd = await client.patch(_BASE + f"/defects/{body['id']}", json={
        "project_id": pid, "custom_fields": {severity["id"]: "s2", tags["id"]: ["login"]},
    }, headers=h)
    assert upd.status_code == 200, upd.text
    assert upd.json()["custom_fields"] == {severity["id"]: "s2", tags["id"]: ["login"]}

    # 换到无必填字段的系统默认模板：旧值按 field_id 带不过去，但新模板无必填 → 清空
    internal = next(x for x in await _templates(client, h, pid) if x["internal"])
    sw = await client.patch(_BASE + f"/defects/{body['id']}", json={
        "project_id": pid, "template_id": internal["id"],
    }, headers=h)
    assert sw.status_code == 200, sw.text
    assert sw.json()["template_id"] == internal["id"] and sw.json()["custom_fields"] == {}


async def test_purge_cascades_custom_values(client, session, conn, make_user) -> None:
    _, h = await make_user("d192p", admin=True)
    pid = await _proj(client, h, "D192清理")
    f = await _field(client, h, pid, "备注", "note", "input")
    t = await _template(client, h, pid, "清理模板", [{"field_id": f["id"]}])
    d = await _defect(client, h, pid, "带值", template_id=t["id"], custom_fields={f["id"]: "x"})
    assert d.status_code == 201, d.text
    did = d.json()["id"]
    await client.post(_BASE + f"/defects/{did}/delete", json={"project_id": pid, "defect_id": did}, headers=h)
    purged = await client.post(_BASE + f"/defects/{did}/purge",
                               json={"project_id": pid, "defect_id": did, "confirm_title": "带值"}, headers=h)
    assert purged.status_code == 200
    n = (await conn.execute(text("SELECT COUNT(*) FROM defect_custom_field WHERE defect_id=:d"),
                            {"d": did})).scalar_one()
    assert n == 0, "彻底删除必须同事务清自定义值"


# ══════════ 6. 字段值存在时不可删 ══════════
async def test_field_with_values_cannot_be_deleted(client, make_user) -> None:
    _, h = await make_user("d192v", admin=True)
    pid = await _proj(client, h, "D192值锁")
    f = await _field(client, h, pid, "备注", "note", "input")
    t = await _template(client, h, pid, "值模板", [{"field_id": f["id"]}])
    d = await _defect(client, h, pid, "有值", template_id=t["id"], custom_fields={f["id"]: "x"})
    assert d.status_code == 201, d.text
    # 先从模板移除，再删字段：仍有值行 → 409
    await client.patch(_BASE + f"/templates/{t['id']}", json={"project_id": pid, "fields": []}, headers=h)
    r = await client.post(_BASE + f"/custom-fields/{f['id']}/delete",
                          json={"project_id": pid, "field_id": f["id"]}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "field_has_values"


async def test_option_value_in_use_cannot_be_removed(client, make_user) -> None:
    _, h = await make_user("d192o", admin=True)
    pid = await _proj(client, h, "D192选项锁")
    f = await _field(client, h, pid, "严重程度", "severity", "select",
                     [{"value": "s1", "label": "致命"}, {"value": "s2", "label": "一般"}])
    t = await _template(client, h, pid, "选项模板", [{"field_id": f["id"]}])
    d = await _defect(client, h, pid, "有值", template_id=t["id"], custom_fields={f["id"]: "s1"})
    assert d.status_code == 201, d.text
    bad = await client.patch(_BASE + f"/custom-fields/{f['id']}", json={
        "project_id": pid, "options": [{"value": "s2", "label": "一般"}],
    }, headers=h)
    assert bad.status_code == 409 and bad.json()["code"] == "option_in_use"
    ok = await client.patch(_BASE + f"/custom-fields/{f['id']}", json={
        "project_id": pid,
        "options": [{"value": "s1", "label": "致命"}, {"value": "s3", "label": "轻微"}],
    }, headers=h)
    assert ok.status_code == 200, ok.text
