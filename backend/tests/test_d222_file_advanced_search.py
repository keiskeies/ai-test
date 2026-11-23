"""D222 判据刀：文件库列表高级搜索（D47-a 三件套铺到文件管理页）。

钉的契约：

1. **字段白名单 = FILE_LIST_FILTER**，meta 里的 fields 与它同源；白名单外 400。
2. **条件是 WHERE**：与 `folder_id`/`unfiled_only`（左树）、`keyword`、`recycled`（视图轴）
   并行 AND；OR 组自带括号。
3. **跨表字段可筛**：列表 join 的 `file_blob` 上 `size`/`mime`/`original_name` 是真列，
   可筛且走 SQL（不是现算）。
4. **回收站轴不可被 filter 绕过**：正常视图 + `name CONTAINS` 不会把墓碑带回来。
5. **可空列**：`description EMPTY/NOT_EMPTY`；`tags` 可空可查。
6. **条件进 COUNT 同一份**：页码模式的 total 必须也吃 filter。
"""
from __future__ import annotations

import json

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _upload(client, h, pid: str, name: str, content: bytes, *,
                  folder: str | None = None, desc: str | None = None) -> dict:
    data = {"project_id": pid, "name": name}
    if folder:
        data["folder_id"] = folder
    if desc:
        data["description"] = desc
    r = await client.post(_BASE + "/files/upload", data=data,
                          files={"file": (name, content, "text/plain")}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _tags(client, h, pid: str, file_id: str, tags: list[str]) -> None:
    r = await client.patch(_BASE + f"/files/{file_id}",
                           json={"project_id": pid, "tags": tags}, headers=h)
    assert r.status_code == 200, r.text


def _f(*conds: dict, mode: str = "AND") -> str:
    return json.dumps({"search_mode": mode, "conditions": list(conds)})


async def _names(client, h, pid: str, **params) -> set[str]:
    r = await client.get(_BASE + "/files", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def test_filter_meta_registers_file(client, make_user) -> None:
    _, h = await make_user("d222a", admin=True)
    pid = await _proj(client, h, "D222元数据")
    r = await client.get(_BASE + "/filter-meta",
                         params={"project_id": pid, "view_type": "file"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "file" in body["supported_view_types"]
    assert body["view_label"] == "文件库"
    fields = {f["field"] for f in body["fields"]}
    assert fields == {
        "name", "description", "tags", "version", "size", "mime", "original_name",
        "created_by", "updated_by", "created_at", "updated_at",
    }
    # 左树轴 / 快捷搜索 / 视图轴 / 取数参数都不是业务字段
    assert not ({"project_id", "folder_id", "unfiled_only", "keyword", "recycled",
                 "status", "current"} & fields), \
        "目录/视图/取数轴不是可筛字段，不许进条件组"
    size = next(f for f in body["fields"] if f["field"] == "size")
    assert size["kind"] == "number" and "CONTAINS" not in size["ops"]
    name = next(f for f in body["fields"] if f["field"] == "name")
    assert "EMPTY" not in name["ops"], "非空列不给「为空」假筛选项"
    desc = next(f for f in body["fields"] if f["field"] == "description")
    assert {"EMPTY", "NOT_EMPTY"} <= set(desc["ops"])


async def test_conditions_apply_as_where(client, make_user) -> None:
    _, h = await make_user("d222b", admin=True)
    pid = await _proj(client, h, "D222条件")
    small = await _upload(client, h, pid, "登录小文件", b"abc", desc="主流程")
    await _upload(client, h, pid, "登录大文件", b"0123456789")
    await _upload(client, h, pid, "支付大文件", b"0123456789x")
    await _tags(client, h, pid, small["id"], ["登录", "核心"])

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录小文件", "登录大文件"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "description", "operator": "CONTAINS", "value": "主流程"})) == {"登录小文件"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "tags", "operator": "CONTAINS", "value": "核心"})) == {"登录小文件"}
    # 跨表（file_blob）字段同样是 SQL 可筛列；无名扩展名的上传落成 octet-stream
    assert await _names(client, h, pid, filter=_f(
        {"field": "size", "operator": "GT", "value": 5})) == {"登录大文件", "支付大文件"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "mime", "operator": "EQUALS", "value": "application/octet-stream"})) == {
        "登录小文件", "登录大文件", "支付大文件"}
    assert await _names(client, h, pid, filter=_f(
        {"field": "original_name", "operator": "EQUALS", "value": "支付大文件"})) == {"支付大文件"}
    # OR：名字含「支付」或大小 < 5 → 两行
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "支付"},
        {"field": "size", "operator": "LT", "value": 5}, mode="OR")) == {
        "支付大文件", "登录小文件"}
    # 谓词在 LIMIT 之前：size=1 只回一行，total 是 2（COUNT 吃同一份条件）
    r = await client.get(_BASE + "/files", params={
        "project_id": pid, "current": 1, "size": 1,
        "filter": _f({"field": "name", "operator": "CONTAINS", "value": "登录"}),
    }, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 1
    assert r.json()["total"] == 2


async def test_filter_cannot_bypass_recycled_axis(client, make_user) -> None:
    _, h = await make_user("d222c", admin=True)
    pid = await _proj(client, h, "D222回收轴")
    await _upload(client, h, pid, "登录-正常", b"a")
    dead = await _upload(client, h, pid, "登录-已回收", b"b")
    rm = await client.post(_BASE + f"/files/{dead['id']}/delete",
                           json={"project_id": pid, "file_id": dead["id"]}, headers=h)
    assert rm.status_code == 200, rm.text

    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-正常"}
    assert await _names(client, h, pid, recycled="true", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-已回收"}
    # 条件里点名墓碑也不行：正常视图里它不存在（轴先于条件）
    assert await _names(client, h, pid, filter=_f(
        {"field": "name", "operator": "EQUALS", "value": "登录-已回收"})) == set()


async def test_folder_axis_parallel_and_bad_fields(client, make_user) -> None:
    _, h = await make_user("d222d", admin=True)
    pid = await _proj(client, h, "D222目录轴")
    r = await client.post(_BASE + "/file-folders",
                          json={"project_id": pid, "name": "登录目录"}, headers=h)
    assert r.status_code == 201, r.text
    folder = r.json()
    await _upload(client, h, pid, "登录-目录内", b"a", folder=folder["id"])
    await _upload(client, h, pid, "登录-未分类", b"b")

    # 左树 folder_id 与条件组并行 AND
    assert await _names(client, h, pid, folder_id=folder["id"], filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-目录内"}
    assert await _names(client, h, pid, unfiled_only="true", filter=_f(
        {"field": "name", "operator": "CONTAINS", "value": "登录"})) == {"登录-未分类"}
    # 目录归属不是可筛字段：条件里点 folder_id 必须 400，而不是悄悄按目录筛
    bad = await client.get(_BASE + "/files", params={
        "project_id": pid,
        "filter": _f({"field": "folder_id", "operator": "EQUALS", "value": folder["id"]}),
    }, headers=h)
    assert bad.status_code == 400, bad.text
    assert bad.json()["code"] == "bad_filter"
    assert bad.json()["details"]["view_type"] == "file"

    # 可空描述：EMPTY 留下没写描述的
    assert await _names(client, h, pid, filter=_f(
        {"field": "description", "operator": "EMPTY", "value": None})) == {
        "登录-目录内", "登录-未分类"}
    # 白名单外字段的 400 要带本页清单
    err = await client.get(_BASE + "/files", params={
        "project_id": pid,
        "filter": _f({"field": "used_by", "operator": "EQUALS", "value": 0}),
    }, headers=h)
    assert err.status_code == 400, err.text
    assert "本页可筛" in err.json()["message"]
    assert "文件名" in err.json()["message"], "400 要告诉用户这一页到底能按什么筛"
