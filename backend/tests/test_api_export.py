"""1E T5 导出备份：OpenAPI3 逆映射 + **导入往返自证**（本任务的命门）。

三个方向都钉：
① 导出→同项目导入（全跳过）：冲突计数 == 导出条数、零新增；
② 导出→换 project 导入：条数一致且每条 §7.1 request 逐字段 `==` 深比对；
③ 刁钻形状（路径参数 /order/{id}、query/header 示例、json/form/text 体、非默认 timeout、
   断言）逐形状存活。
**未覆盖场景如实报**：Postman 导出不做（计划明文）；notes 的诚实分支（草稿未导出、
form 值含 & 不硬编）各钉一例——报得出来的才算如实，报不出就是假绿。
"""
from __future__ import annotations

import json
from typing import Any

from app.modules.api_test.export_services import build_openapi_doc
from app.modules.api_test.importers import normalize_path, parse_openapi3

BASE = "https://api.roundtrip.example.com"


def _req(method: str, url: str, **kw: Any) -> dict[str, Any]:
    req: dict[str, Any] = {"method": method, "url": url, "params": [], "headers": [],
                           "body": {"type": "none"}, "timeout_ms": 10000, "assertions": []}
    req.update(kw)
    return req


# 三种（以上）刁钻形状：路径参数+query+header+非默认 timeout+断言 / json 体 / form 体 / text 体（含 &）
DEFS: list[dict[str, Any]] = [
    {"name": "查询订单", "method": "GET", "path": "/order/{id}", "request": _req(
        "GET", BASE + "/order/{id}",
        params=[["trace", "on"], ["lang", "zh"]], headers=[["X-Tenant", "t1"]],
        timeout_ms=15000, assertions=[{"type": "status_code", "expected": 200}])},
    {"name": "创建订单", "method": "POST", "path": "/order", "request": _req(
        "POST", BASE + "/order", headers=[["Content-Type", "application/json"]],
        body={"type": "json", "content": json.dumps({"sku": "A-1", "count": 2}, ensure_ascii=False)})},
    {"name": "表单改单", "method": "PATCH", "path": "/order", "request": _req(
        "PATCH", BASE + "/order", body={"type": "form", "content": "status=paid&note=ok"})},
    {"name": "文本回传", "method": "PUT", "path": "/order/{id}/text", "request": _req(
        "PUT", BASE + "/order/{id}/text", body={"type": "text", "content": "hello & world"})},
]


async def _setup(client, make_user, name: str):
    _, h = await make_user(name)
    r = await client.post("/api/v1/projects", json={"name": name + "_proj"}, headers=h)
    return h, r.json()["id"]


async def _mkdef(client, h, pid, d):
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": d["name"], "method": d["method"],
        "path": d["path"], "request": d["request"]}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _export(client, h, pid, ids=None):
    body: dict[str, Any] = {"project_id": pid}
    if ids is not None:
        body["definition_ids"] = ids
    r = await client.post("/api/v1/api-export", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _preview(client, h, pid, text):
    r = await client.post("/api/v1/api-import-preview", json={
        "project_id": pid, "source": "openapi3", "text": text}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _defs(client, h, pid):
    r = await client.get("/api/v1/api-definitions", params={"project_id": pid, "size": 200}, headers=h)
    return {x["name"]: x for x in r.json()["items"]}


# —————————————————————— 纯函数：build_openapi_doc 是 importers 的逆 ——————————————————————

def test_build_doc_is_eatable_and_lossless() -> None:
    doc, notes = build_openapi_doc([(d["name"], d["method"], d["path"], d["request"]) for d in DEFS])
    assert doc["openapi"].startswith("3") and doc["servers"] == [{"url": BASE}]
    assert notes == [], notes
    # 导出的文档必须能被 T4 解析器吃回（私有格式 = 自证无门——这就是「不是私有 JSON」的证明）
    out = parse_openapi3(json.dumps(doc, ensure_ascii=False))
    assert out.errors == []
    assert {(i.method, normalize_path(i.path)) for i in out.items} == \
           {(d["method"], normalize_path(d["path"])) for d in DEFS}
    by = {(i.method, normalize_path(i.path)): i for i in out.items}
    for d in DEFS:
        it = by[(d["method"], normalize_path(d["path"]))]
        assert it.request == d["request"], d["name"]  # §7.1 深比对，逐字段
        assert it.name == d["name"]


def test_build_doc_honest_notes() -> None:
    # 外来单基址：它就是多数派基址，servers 用它、url 无损（不硬造 ${base_url} 场景）
    doc, notes = build_openapi_doc([("外来户", "GET", "/x", _req("GET", "https://elsewhere.test/x"))])
    assert doc["servers"] == [{"url": "https://elsewhere.test"}] and notes == []
    # ① 真·接不进基址：两条接口各挂一个域名（无 servers[1] 可放），少数派改写并如实报
    doc2, notes2 = build_openapi_doc([
        ("甲站", "GET", "/a", _req("GET", "https://a.test/a")),
        ("乙站", "GET", "/b", _req("GET", "https://b.test/b")),
    ])
    assert doc2["servers"][0]["url"] in ("https://a.test", "https://b.test")
    assert any("接不进导出基址" in n and "改写" in n for n in notes2)
    lost = parse_openapi3(json.dumps(doc2, ensure_ascii=False)).items
    assert [i.request["url"] for i in lost if i.name == "乙站"] == [doc2["servers"][0]["url"] + "/b"]
    # ② form 值含 & 拆不回去：整条不导出，报人话
    _doc2, notes2 = build_openapi_doc([("坏表单", "POST", "/f", _req(
        "POST", BASE + "/f", body={"type": "form", "content": "a=x&y"}))])
    assert any("form 体含无法拆回" in n and "坏表单" in n for n in notes2)
    # ③ form 重复键：example 对象合并即有损，同样宁可不导
    _doc3, notes3 = build_openapi_doc([("重键表单", "POST", "/f2", _req(
        "POST", BASE + "/f2", body={"type": "form", "content": "a=1&a=2"}))])
    assert any("未导出" in n for n in notes3)


# —————————————————————— 往返①：导出→同项目全跳过导入 = 全冲突、零新增 ——————————————————————

async def test_roundtrip_same_project_all_skip(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "exp1")
    for d in DEFS:
        await _mkdef(client, h, pid, d)
    exported = await _export(client, h, pid)
    assert exported["exported"] == len(DEFS) and exported["notes"] == []
    text = json.dumps(exported["openapi"], ensure_ascii=False)
    prev = await _preview(client, h, pid, text)
    assert prev["errors"] == []
    # 命门口径①：冲突计数 == 导出条数，新增为 0
    assert prev["conflict_count"] == len(DEFS) and prev["new_count"] == 0, prev
    r = await client.post("/api/v1/api-import-commit", json={"project_id": pid, "items": [
        {"name": i["name"], "method": i["method"], "path": i["path"], "request": i["request"],
         "strategy": "skip", "definition_id": i["definition_id"]} for i in prev["items"]]}, headers=h)
    body = r.json()
    assert (body["ok"], body["created"], body["updated"], body["skipped"], body["failed"]) == \
           (True, 0, 0, len(DEFS), 0), body
    after = await _defs(client, h, pid)
    assert set(after) == {d["name"] for d in DEFS}
    for d in DEFS:  # 全跳过后一行没动（version 仍是 1）
        assert after[d["name"]]["version"] == 1 and after[d["name"]]["request"] == d["request"]


# —————————————————————— 往返②：换 project 导入 = 条数一致 + request 逐字段等值 ——————————————————————

async def test_roundtrip_into_other_project_deepequal(client, make_user) -> None:
    # 双用户双项目：「换 project」只换资产容器——B 是新用户的新项目，从零建起
    h, pid_a = await _setup(client, make_user, "exp2")
    h2, pid_b = await _setup(client, make_user, "exp2b")
    for d in DEFS:
        await _mkdef(client, h, pid_a, d)
    exported = await _export(client, h, pid_a)
    text = json.dumps(exported["openapi"], ensure_ascii=False)
    prev = await _preview(client, h2, pid_b, text)
    assert prev["errors"] == []
    assert (prev["new_count"], prev["conflict_count"]) == (len(DEFS), 0), prev
    r = await client.post("/api/v1/api-import-commit", json={"project_id": pid_b, "items": [
        {"name": i["name"], "method": i["method"], "path": i["path"], "request": i["request"],
         "strategy": "overwrite"} for i in prev["items"]]}, headers=h2)
    body = r.json()
    assert (body["ok"], body["created"]) == (True, len(DEFS)), body
    src, dst = await _defs(client, h, pid_a), await _defs(client, h2, pid_b)
    assert set(dst) == set(src)  # 条数一致 + 名称不漂移
    for name in src:
        assert dst[name]["request"] == src[name]["request"], name  # §7.1 对象 == 深比对
        assert dst[name]["method"] == src[name]["method"] and dst[name]["path"] == src[name]["path"]


async def test_roundtrip_tricky_fields_field_by_field(client, make_user) -> None:
    """③ 逐形状点名钉：不是「整体碰巧相等」，是每类字段各钉一刀。"""
    h, pid_a = await _setup(client, make_user, "exp3")
    h2, pid_b = await _setup(client, make_user, "exp3b")
    for d in DEFS:
        await _mkdef(client, h, pid_a, d)
    exported = await _export(client, h, pid_a)
    prev = await _preview(client, h2, pid_b, json.dumps(exported["openapi"], ensure_ascii=False))
    await client.post("/api/v1/api-import-commit", json={"project_id": pid_b, "items": [
        {"name": i["name"], "method": i["method"], "path": i["path"], "request": i["request"],
         "strategy": "overwrite"} for i in prev["items"]]}, headers=h2)
    dst = await _defs(client, h2, pid_b)
    q = dst["查询订单"]["request"]
    assert q["url"] == BASE + "/order/{id}"          # 路径占位 {} 原样存活
    assert ["trace", "on"] in q["params"] and ["lang", "zh"] in q["params"]  # query 示例值
    assert ["X-Tenant", "t1"] in q["headers"]        # header 示例值
    assert q["timeout_ms"] == 15000                  # 非默认超时经 x-tp-timeout-ms 回来
    assert q["assertions"] == [{"type": "status_code", "expected": 200}]  # 断言经 x-tp-assertions
    c = dst["创建订单"]["request"]
    assert c["body"]["type"] == "json" and json.loads(c["body"]["content"]) == {"sku": "A-1", "count": 2}
    f = dst["表单改单"]["request"]
    assert f["body"] == {"type": "form", "content": "status=paid&note=ok"}  # k=v&k=v 原样
    t = dst["文本回传"]["request"]
    assert t["body"] == {"type": "text", "content": "hello & world"}  # text 里的 & 不受 form 拆分牵连


# —————————————————————— 服务面：勾选导出 / 草稿如实报 / 权限 / 校验 ——————————————————————

async def test_export_selected_ids_and_draft_note(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "exp4")
    did = await _mkdef(client, h, pid, DEFS[1])
    # 草稿（无 request）：不进文档、notes 点名
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "草稿接口", "method": "GET", "path": "/draft"}, headers=h)
    assert r.status_code == 201
    full = await _export(client, h, pid)
    assert full["exported"] == 1
    assert any("草稿接口" in n and "未导出" in n for n in full["notes"])
    one = await _export(client, h, pid, [did])  # 勾选：只导这一条
    assert one["exported"] == 1 and one["notes"] == []
    assert list(one["openapi"]["paths"]) == ["/order"]
    miss = await client.post("/api/v1/api-export", json={
        "project_id": pid, "definition_ids": ["不存在"]}, headers=h)
    assert miss.status_code == 404


async def test_export_perm_is_read_and_enforced(client, make_user) -> None:
    """READONLY glob 坑：POST 动作 perm 必须 :read 结尾（api_export 就是 api:def:read）。"""
    from app.core.permissions import match_perm

    h, pid = await _setup(client, make_user, "exp5")
    # 未加成员的普通用户：ensure_project_access 就该拦（403/404），有 api:def:read 也进不来
    _, h_outsider = await make_user("exp5_outsider")
    r = await client.post("/api/v1/api-export", json={"project_id": pid}, headers=h_outsider)
    assert r.status_code in (403, 404), r.text
    # glob 面：READONLY 的 ["*:read"] 必须盖住 api:def:read——直接查权限位命中
    assert match_perm({"*:read"}, "api:def:read")
