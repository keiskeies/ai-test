"""D195：文件库 / 附件（上传/下载/目录/条目/链接/去重/回收站/权限）。"""
from __future__ import annotations

from sqlalchemy import text

from app.core.config import get_settings

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, hb, pid: str, uid: str, role: str = "MEMBER") -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}", json={"role_code": role}, headers=hb)
    assert r.status_code == 200, r.text


async def _upload(client, h, pid: str, name: str, content: bytes,
                  folder: str | None = None, desc: str | None = None):
    data = {"project_id": pid, "name": name}
    if folder:
        data["folder_id"] = folder
    if desc:
        data["description"] = desc
    return await client.post(_BASE + "/files/upload", data=data,
                             files={"file": (name, content, "text/plain")}, headers=h)


async def _upload_blob(client, h, pid: str, name: str, content: bytes):
    return await client.post(_BASE + "/files/blobs", data={"project_id": pid},
                             files={"file": (name, content, "text/plain")}, headers=h)


async def _content(client, h, pid: str, blob_id: str):
    return await client.get(_BASE + f"/files/{blob_id}/content",
                            params={"project_id": pid}, headers=h)


# ══════════ 1. 迁移形状 ══════════
async def test_file_tables_shape(conn) -> None:
    from sqlalchemy import inspect

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "buq": {u["name"] for u in insp.get_unique_constraints("file_blob")},
            "fuq": {u["name"] for u in insp.get_unique_constraints("file_folder")},
            "luq": {u["name"] for u in insp.get_unique_constraints("file_link")},
        }

    got = await conn.run_sync(_read)
    assert {"file_blob", "file_folder", "file_entry", "file_link"} <= got["tables"]
    assert "uq_file_blob_project_sha" in got["buq"]
    assert "uq_file_folder_parent_name" in got["fuq"]
    assert "uq_file_link_target_blob_role" in got["luq"]


# ══════════ 2. 目录树 ══════════
async def test_folder_tree_crud_and_guards(client, make_user) -> None:
    _, h = await make_user("d195m", admin=True)
    pid = await _proj(client, h, "D195目录")
    root = await client.post(_BASE + "/file-folders", json={"project_id": pid, "name": "文档"}, headers=h)
    assert root.status_code == 201, root.text
    child = await client.post(_BASE + "/file-folders",
                              json={"project_id": pid, "name": "设计稿", "parent_id": root.json()["id"]},
                              headers=h)
    assert child.status_code == 201
    dup = await client.post(_BASE + "/file-folders", json={"project_id": pid, "name": "文档"}, headers=h)
    assert dup.status_code == 409
    tree = await client.get(_BASE + "/file-folders/tree", params={"project_id": pid}, headers=h)
    assert tree.json()["tree"][0]["children"][0]["name"] == "设计稿"
    cyc = await client.patch(_BASE + f"/file-folders/{root.json()['id']}", json={
        "project_id": pid, "parent_id": child.json()["id"], "parent_set": True,
    }, headers=h)
    assert cyc.status_code == 422 and cyc.json()["code"] == "cycle"
    dele = await client.post(_BASE + f"/file-folders/{root.json()['id']}/delete",
                             json={"project_id": pid, "folder_id": root.json()["id"]}, headers=h)
    assert dele.status_code == 409 and dele.json()["code"] == "folder_not_empty"
    # 放一个文件进去，删子目录也要被拒
    up = await _upload(client, h, pid, "a.txt", b"hello", folder=child.json()["id"])
    assert up.status_code == 200, up.text
    dele2 = await client.post(_BASE + f"/file-folders/{child.json()['id']}/delete",
                              json={"project_id": pid, "folder_id": child.json()["id"]}, headers=h)
    assert dele2.status_code == 409 and dele2.json()["details"]["files"] == 1


# ══════════ 3. 上传/去重/下载/回收站 ══════════
async def test_upload_dedupe_download_and_trash(client, make_user, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(get_settings(), "files_dir", str(tmp_path / "files"))
    _, h = await make_user("d195f", admin=True)
    pid = await _proj(client, h, "D195文件")
    root = await client.post(_BASE + "/file-folders", json={"project_id": pid, "name": "根"}, headers=h)
    fid = root.json()["id"]

    up1 = await _upload(client, h, pid, "a.txt", b"hello world", folder=fid, desc="第一份")
    assert up1.status_code == 200, up1.text
    e1 = up1.json()
    assert e1["name"] == "a.txt" and e1["blob"]["size"] == 11
    # 同字节不同目录：blob 复用
    up2 = await _upload(client, h, pid, "b.txt", b"hello world")
    assert up2.status_code == 200, up2.text
    assert up2.json()["blob"]["id"] == e1["blob"]["id"], "同项目同字节必须复用 blob"

    body = await _content(client, h, pid, e1["blob"]["id"])
    assert body.status_code == 200 and body.content == b"hello world"
    # 非成员读文件内容 → 403
    out, ho = await make_user("d195out")
    deny = await _content(client, ho, pid, e1["blob"]["id"])
    assert deny.status_code == 403

    # 重名冲突
    dup = await _upload(client, h, pid, "a.txt", b"other", folder=fid)
    assert dup.status_code == 409
    # 改名/移动
    upd = await client.patch(_BASE + f"/files/{e1['id']}", json={
        "project_id": pid, "name": "a-renamed.txt", "folder_id": None, "folder_set": True,
        "tags": ["文档", "v1"],
    }, headers=h)
    assert upd.status_code == 200, upd.text
    assert upd.json()["name"] == "a-renamed.txt" and upd.json()["folder_id"] is None
    assert upd.json()["tags"] == ["文档", "v1"]

    # 回收站 + 恢复 + 彻底删除（另一条引用还在 → 内容不删）
    await client.post(_BASE + f"/files/{e1['id']}/delete", json={"project_id": pid, "file_id": e1["id"]}, headers=h)
    gone = await client.get(_BASE + f"/files/{e1['id']}", params={"project_id": pid}, headers=h)
    assert gone.status_code == 404
    rs = await client.post(_BASE + f"/files/{e1['id']}/restore", json={"project_id": pid, "file_id": e1["id"]},
                           headers=h)
    assert rs.status_code == 200 and rs.json()["recycled"] is False
    await client.post(_BASE + f"/files/{e1['id']}/delete", json={"project_id": pid, "file_id": e1["id"]}, headers=h)
    wrong = await client.post(_BASE + f"/files/{e1['id']}/purge",
                              json={"project_id": pid, "file_id": e1["id"], "confirm_name": "错"}, headers=h)
    assert wrong.status_code == 409 and wrong.json()["code"] == "name_mismatch"
    pg = await client.post(_BASE + f"/files/{e1['id']}/purge",
                           json={"project_id": pid, "file_id": e1["id"], "confirm_name": "a-renamed.txt"},
                           headers=h)
    assert pg.status_code == 200
    assert (await _content(client, h, pid, e1["blob"]["id"])).status_code == 200, "另一条引用还在，blob 不能删"


# ══════════ 4. 附件链接（缺陷/用例）+ 零引用 GC ══════════
async def test_attachments_for_defect_and_case(client, make_user, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(get_settings(), "files_dir", str(tmp_path / "files"))
    _, h = await make_user("d195a", admin=True)
    pid = await _proj(client, h, "D195附件")
    up = await _upload_blob(client, h, pid, "shot.png", b"\x89PNG\r\n\x1a\nfake")
    assert up.status_code == 200, up.text
    blob = up.json()["blob"]["id"]

    d = await client.post(_BASE + "/defects", json={"project_id": pid, "title": "附件缺陷"}, headers=h)
    assert d.status_code == 201, d.text
    c = await client.post(_BASE + "/functional-cases", json={"project_id": pid, "name": "附件用例"}, headers=h)
    assert c.status_code == 201, c.text
    did, cid = d.json()["id"], c.json()["id"]

    link1 = await client.post(_BASE + "/attachments", json={
        "project_id": pid, "target_type": "bug", "target_id": did,
        "blob_ids": [blob, blob], "role": "attachment",
    }, headers=h)
    assert link1.status_code == 201 and link1.json() == {"created": 1, "skipped": 1}
    link2 = await client.post(_BASE + "/attachments", json={
        "project_id": pid, "target_type": "functional_case", "target_id": cid,
        "blob_ids": [blob], "role": "attachment",
    }, headers=h)
    assert link2.status_code == 201 and link2.json()["created"] == 1

    lst = await client.get(_BASE + "/attachments", params={
        "project_id": pid, "target_type": "bug", "target_id": did}, headers=h)
    assert lst.status_code == 200 and lst.json()["items"][0]["blob"]["id"] == blob
    assert lst.json()["items"][0]["display_name"] == "shot.png"
    # 重复关联跳过
    dup = await client.post(_BASE + "/attachments", json={
        "project_id": pid, "target_type": "bug", "target_id": did,
        "blob_ids": [blob], "role": "attachment",
    }, headers=h)
    assert dup.json()["skipped"] == 1
    # 目标不存在
    bad = await client.post(_BASE + "/attachments", json={
        "project_id": pid, "target_type": "bug", "target_id": "nope",
        "blob_ids": [blob], "role": "attachment",
    }, headers=h)
    assert bad.status_code == 404

    # 删 bug 链接：用例链接还在 → blob 保留；再删用例链接 → blob 与盘上字节删除
    link_id = lst.json()["items"][0]["id"]
    assert (await client.post(_BASE + f"/attachments/{link_id}/delete",
                              json={"project_id": pid, "link_id": link_id}, headers=h)).status_code == 200
    assert (await _content(client, h, pid, blob)).status_code == 200
    c_lst = await client.get(_BASE + "/attachments", params={
        "project_id": pid, "target_type": "functional_case", "target_id": cid}, headers=h)
    clink = c_lst.json()["items"][0]["id"]
    await client.post(_BASE + f"/attachments/{clink}/delete", json={"project_id": pid, "link_id": clink}, headers=h)
    assert (await _content(client, h, pid, blob)).status_code == 404, "零引用后 blob 必须删除"


# ══════════ 5. 权限 ══════════
async def test_file_permissions(client, make_user, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(get_settings(), "files_dir", str(tmp_path / "files"))
    boss, hb = await make_user("d195p", admin=True)
    ro, hr = await make_user("d195p2")
    pid = await _proj(client, hb, "D195权限")
    await _member(client, hb, pid, ro.id, "READONLY")
    deny_up = await _upload(client, hr, pid, "x.txt", b"x")
    assert deny_up.status_code == 403 and deny_up.json()["details"]["perm"] == "file:file:create"
    up = await _upload(client, hb, pid, "x.txt", b"x")
    assert up.status_code == 200
    blob = up.json()["blob"]["id"]
    assert (await _content(client, hr, pid, blob)).status_code == 200
    # 跨项目：同 blob id 换项目 = 404
    pid2 = await _proj(client, hb, "D195权限B")
    assert (await _content(client, hb, pid2, blob)).status_code == 404


async def test_purge_defect_cascades_attachment_links(client, conn, make_user, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(get_settings(), "files_dir", str(tmp_path / "files"))
    _, h = await make_user("d195g", admin=True)
    pid = await _proj(client, h, "D195级联")
    up = await _upload_blob(client, h, pid, "a.txt", b"attachment")
    blob = up.json()["blob"]["id"]
    d = await client.post(_BASE + "/defects", json={"project_id": pid, "title": "带附件"}, headers=h)
    did = d.json()["id"]
    link = await client.post(_BASE + "/attachments", json={
        "project_id": pid, "target_type": "bug", "target_id": did,
        "blob_ids": [blob], "role": "attachment",
    }, headers=h)
    assert link.status_code == 201
    await client.post(_BASE + f"/defects/{did}/delete", json={"project_id": pid, "defect_id": did}, headers=h)
    pg = await client.post(_BASE + f"/defects/{did}/purge",
                           json={"project_id": pid, "defect_id": did, "confirm_title": "带附件"}, headers=h)
    assert pg.status_code == 200
    n = (await conn.execute(text("SELECT COUNT(*) FROM file_link WHERE target_id=:t"), {"t": did})).scalar_one()
    assert n == 0
    assert (await _content(client, h, pid, blob)).status_code == 404
