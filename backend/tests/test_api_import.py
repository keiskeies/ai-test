"""1E T4 导入：三源解析（真样本夹具）+ 冲突比对 + 整批事务。

表驱动钉三件事：解析出的 (method, 归一路径) 集合、§7.1 形状的关键字段、错误全进
errors 不抛。服务层钉冲突键（同 path 不同 method；`/order/:id` 与 `/order/{id}` 归一）
与回滚（半途失败后现有接口逐字节不变）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.modules.api_test.importers import normalize_path, parse_openapi3, parse_postman, parse_swagger2

FIX = Path(__file__).parent / "fixtures" / "import"


def _read(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


def _key(items) -> set[tuple[str, str]]:
    return {(i.method, normalize_path(i.path)) for i in items}


# —————————————————————— 三源真样本（表驱动）——————————————————————

CASES: list[dict[str, Any]] = [
    {
        "id": "openapi3_petstore", "parse": parse_openapi3, "file": "petstore_openapi3.json",
        "keys": {("GET", "/pets"), ("POST", "/pets"), ("GET", "/pets/{petId}"),
                 ("DELETE", "/pets/{petId}"), ("POST", "/pets/{petId}/photos")},
        "names": {"列出宠物", "创建宠物", "查询宠物", "删除宠物"},
        "n_errors": 1,  # 恰是那一条外部 $ref
    },
    {
        "id": "swagger2_order", "parse": parse_swagger2, "file": "order_swagger2.json",
        "keys": {("GET", "/order/{id}"), ("POST", "/order"), ("PATCH", "/order")},
        "names": {"查询订单", "创建订单", "表单改单"},
        "n_errors": 0,
    },
    {
        "id": "postman_v2", "parse": parse_postman, "file": "echo_postman_v2.json",
        "keys": {("GET", "/health"), ("POST", "/order"), ("GET", "/order/{id}"), ("PUT", "/order/1/status")},
        "names": {"健康检查", "创建订单-JSON", "查询订单", "表单提交"},
        "n_errors": 1,  # 「坏条目没有请求」
    },
]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_parse_real_samples(case: dict[str, Any]) -> None:
    out = case["parse"](_read(case["file"]))
    assert _key(out.items) == case["keys"], out.errors
    assert {i.name for i in out.items} >= case["names"]
    assert len(out.errors) == case["n_errors"], out.errors


def test_openapi3_shapes() -> None:
    """§7.1 关键字段：servers→url 前缀、query/header 参数、一层本地 $ref 展开出示例体。"""
    out = parse_openapi3(_read("petstore_openapi3.json"))
    by = {(i.method, normalize_path(i.path)): i for i in out.items}
    lst = by[("GET", "/pets")].request
    assert lst["url"] == "https://petstore.example.com/v1/pets"
    assert ["limit", "20"] in lst["params"] and ["X-Tenant", "t1"] in lst["headers"]
    # components/schemas/Pet 的一层展开：example 值进 json 体
    create = by[("POST", "/pets")].request
    assert create["body"]["type"] == "json"
    assert json.loads(create["body"]["content"]) == {"name": "小白"}
    assert create["method"] == "POST" and create["timeout_ms"] == 10000 and create["assertions"] == []
    # 外部 ref 那条：条目仍导入（接口本身有效），体类型照报 json 但内容不猜（None），错误如实报
    photo = by[("POST", "/pets/{petId}/photos")]
    assert photo.request["body"] == {"type": "json", "content": None}
    assert any("不支持的外部引用" in e and "evil.example.com" in e for e in out.errors)


def test_swagger2_base_and_body() -> None:
    out = parse_swagger2(_read("order_swagger2.json"))
    by = {(i.method, normalize_path(i.path)): i for i in out.items}
    assert by[("GET", "/order/{id}")].request["url"] == "https://api.old.example.com/api/order/{id}"
    assert ["trace", "on"] in by[("GET", "/order/{id}")].request["params"]
    body = json.loads(by[("POST", "/order")].request["body"]["content"])
    assert body == {"sku": "A-1", "count": 2}
    assert by[("PATCH", "/order")].request["body"] == {"type": "form", "content": "status=paid"}


def test_postman_nested_folders_and_query() -> None:
    """v2.0 嵌套 folder 递归展开；:id 占位、raw query、form 体、source_ref 带 folder 链。"""
    out = parse_postman(_read("echo_postman_v2.json"))
    by = {(i.method, normalize_path(i.path)): i for i in out.items}
    create = by[("POST", "/order")]
    assert ["src", "postman"] in create.request["params"]
    assert json.loads(create.request["body"]["content"]) == {"sku": "A-1", "count": 2}
    assert "订单" in create.source_ref and "创建订单-JSON" in create.source_ref
    assert by[("PUT", "/order/1/status")].request["body"] == {"type": "form", "content": "status=paid"}
    assert any("没有 request" in e for e in out.errors)


# —————————————————————— 失败模式全进 errors，永不抛 ——————————————————————

def test_failure_modes_land_in_errors() -> None:
    assert any("不是合法 JSON" in e for e in parse_openapi3("{坏json,").errors)
    assert any("内容为空" in e for e in parse_swagger2("   ").errors)
    assert any("顶层必须是 JSON 对象" in e for e in parse_postman("[1,2]").errors)  # 顶层非对象
    assert any("缺 paths" in e for e in parse_openapi3(json.dumps({"openapi": "3.0.0"})).errors)
    assert any("paths 为空" in e for e in parse_openapi3(json.dumps({"openapi": "3.0.0", "paths": {}})).errors)
    assert any("Swagger2" in e for e in parse_swagger2(json.dumps({"openapi": "3.0.0", "paths": {}})).errors)
    assert any("Postman" in e for e in parse_postman(json.dumps({"info": {"name": "x"}, "paths": {}})).errors)
    # Postman folder 的 item 不是数组 → 该层人话报错，别的层照常解析
    doc = {"info": {"name": "c", "schema": "https://schema.getpostman.com/json/collection/v2.0.0/collection.json"},
           "item": [{"name": "坏folder", "item": {"不是": "数组"}},
                    {"name": "好条目", "request": {"method": "GET", "url": "https://x/y"}}]}
    out = parse_postman(json.dumps(doc))
    assert len(out.items) == 1 and any("坏folder" in e for e in out.errors)


def test_local_ref_two_levels_reports_error() -> None:
    doc = {"openapi": "3.0.0", "servers": [{"url": "http://h"}],
           "paths": {"/a": {"post": {"summary": "双层引用", "requestBody": {"content": {
               "application/json": {"schema": {"$ref": "#/components/schemas/A"}}}}}}},
           "components": {"schemas": {"A": {"properties": {"b": {"$ref": "#/components/schemas/B"}}},
                                      "B": {"example": "不再展开"}}}}
    out = parse_openapi3(json.dumps(doc))
    assert len(out.items) == 1
    assert any("超过一层" in e for e in out.errors)


# —————————————————————— 服务层：冲突比对（表驱动）——————————————————————

REQ = {"method": "GET", "url": "http://h/p", "params": [], "headers": [],
       "body": {"type": "none"}, "timeout_ms": 10000, "assertions": []}


async def _setup(client, make_user, name: str):
    _, h = await make_user(name)
    r = await client.post("/api/v1/projects", json={"name": name + "_proj"}, headers=h)
    return h, r.json()["id"]


async def _mkdef(client, h, pid, method, path, reqname):
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": reqname, "method": method, "path": path, "request": REQ}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _preview(client, h, pid, source, text):
    r = await client.post("/api/v1/api-import-preview", json={
        "project_id": pid, "source": source, "text": text}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _snapshot(client, h, pid):
    r = await client.get("/api/v1/api-definitions", params={"project_id": pid, "size": 200}, headers=h)
    return {x["name"]: x for x in r.json()["items"]}


@pytest.mark.parametrize(("method", "path", "exists"), [
    ("GET", "/order/{id}", True),   # 逐字撞键
    ("GET", "/order/:id", True),    # 异构占位语法归一后撞键
    ("POST", "/order/{id}", False),  # 同 path 不同 method = 新增
    ("GET", "/order/2/status", False),
])
async def test_conflict_key_table(client, make_user, method, path, exists) -> None:
    h, pid = await _setup(client, make_user, "imp1" + method + path.replace("/", "_").replace("{", "").replace("}", ""))
    await _mkdef(client, h, pid, "GET", "/order/{id}", "既有查询订单")
    out = await _preview(client, h, pid, "postman", json.dumps({
        "info": {"name": "t", "schema": "https://schema.getpostman.com/json/collection/v2.0.0/collection.json"},
        "item": [{"name": "x", "request": {"method": method, "url": "http://h" + path}}]}))
    assert len(out["items"]) == 1, out
    assert out["items"][0]["exists"] is exists
    assert out["conflict_count"] == (1 if exists else 0)
    assert out["new_count"] == (0 if exists else 1)


# —————————————————————— 整批事务：半途失败 = 一行不动 ——————————————————————

async def test_commit_whole_batch_atomic(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "imp2")
    did = await _mkdef(client, h, pid, "GET", "/keep", "保留接口")
    before = await _snapshot(client, h, pid)
    bad_req = {**REQ, "body": {"type": "json", "content": "{坏JSON"}}
    r = await client.post("/api/v1/api-import-commit", json={"project_id": pid, "items": [
        {"name": "新接口A", "method": "GET", "path": "/a", "request": REQ, "strategy": "overwrite"},
        {"name": "坏接口B", "method": "GET", "path": "/b", "request": bad_req, "strategy": "overwrite"},
    ]}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False and body["failed"] == 1 and body["created"] == 0
    assert "坏接口B" in body["failures"][0]["name"] and body["failures"][0]["reason"]
    # 整批回滚：第一条没落库，既有接口逐字节不变
    after = await _snapshot(client, h, pid)
    assert set(after) == {"保留接口"}
    assert after["保留接口"] == before["保留接口"]
    assert after["保留接口"]["id"] == did


async def test_commit_overwrite_audit_and_skip(client, make_user, session) -> None:
    from sqlalchemy import select

    from app.modules.audit.models import AuditLog

    h, pid = await _setup(client, make_user, "imp3")
    did = await _mkdef(client, h, pid, "GET", "/order/{id}", "既有订单")
    new_req = {**REQ, "url": "http://h/order/9", "headers": [["X-Imp", "1"]]}
    r = await client.post("/api/v1/api-import-commit", json={"project_id": pid, "items": [
        {"name": "导入订单", "method": "GET", "path": "/order/:id", "request": new_req,
         "strategy": "overwrite", "definition_id": did},
        {"name": "跳过条目", "method": "POST", "path": "/keep2",
         "request": {**REQ, "method": "POST", "url": "http://h/keep2"}, "strategy": "skip"},
    ]}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    # 冲突目标按 definition_id 覆盖（归一路径 /order/:id 撞 /order/{id}）；skip 的无目标条目也计 skipped
    assert (body["created"], body["updated"], body["failed"]) == (0, 1, 0), body
    assert body["skipped"] == 1, body
    defs = await _snapshot(client, h, pid)
    assert defs["既有订单"]["version"] == 2
    assert defs["既有订单"]["request"]["headers"] == [["X-Imp", "1"]]
    rows = (await session.execute(select(AuditLog).where(AuditLog.action == "api_import_commit"))).scalars().all()
    ov = [a for a in rows if (a.diff or {}).get("overwrite") == did]
    assert len(ov) == 1 and ov[0].diff["before"]["version"] == 1 and ov[0].diff["after"]["version"] == 2


async def test_preview_rejects_name_collision_in_batch(client, make_user) -> None:
    h, pid = await _setup(client, make_user, "imp4")
    await _mkdef(client, h, pid, "GET", "/dup", "同名占位")
    r = await client.post("/api/v1/api-import-commit", json={"project_id": pid, "items": [
        {"name": "同名占位", "method": "GET", "path": "/other", "request": REQ, "strategy": "overwrite"},
    ]}, headers=h)
    body = r.json()
    assert body["ok"] is False and "接口名已存在" in body["failures"][0]["reason"]


async def test_preview_url_source_validated(client, make_user) -> None:
    """URL 框：非法 scheme 直接 422（httpx 代拉近端参数：trust_env=False/5s/2MB 在 _fetch_url）。"""
    h, pid = await _setup(client, make_user, "imp5")
    r = await client.post("/api/v1/api-import-preview", json={
        "project_id": pid, "source": "openapi3", "url": "ftp://x/y.json"}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "validation_failed"


async def test_normalize_path() -> None:
    assert normalize_path("/order/:id") == normalize_path("/order/{id}") == "/order/{id}"
    assert normalize_path("order/x/") == "/order/x"
    assert normalize_path("/a/b") == "/a/b"
