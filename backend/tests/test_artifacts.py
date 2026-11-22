"""T14 大响应体外置制品（§8.8 的 64KB 线）。六条判据逐条一测。

# TODO(主线)：create_app() 里追加 import app.modules.execution.artifacts
# main.py 归主线并行编辑，本文件顶部的显式 import 负责在测试里触发 @service 注册。

安全线事实（本机探针实测，Starlette/FastAPI 当前版本）：`../`、`..%2f`、绝对路径
在 URL 规范化后根本路由不到 handler（拿到的 404 是路由层给的，不是本防护给的）；
真正会到达 handler 的是 `..%5c`（解码为 `..\\.env`）、`%2e%2e`（解码为 `..`）这类
编码变体。所以防护重心必须在**解码后名字**的校验（artifact_path），测试也必须打
这些能到达 handler 的变体——否则一片 404 是「看起来挡住了」的假绿。
"""
from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

# 显式注册：main.py 的 import 行由主线补（见顶部 TODO），这里不能让注册表空转
import app.modules.execution.artifacts  # noqa: F401
from app.core.config import get_settings
from app.core.errors import ApiError
from app.modules.execution.artifacts import artifact_path, offload_detail, save_artifact
from app.modules.execution.models import RunArtifact, RunRecord


@pytest.fixture()
def art_dir(tmp_path, monkeypatch):
    """每用例独立制品根；get_settings 是 lru_cache，进出都要失效缓存。"""
    d = tmp_path / "artifacts"
    d.mkdir()
    monkeypatch.setenv("TP_ARTIFACTS_DIR", str(d))
    get_settings.cache_clear()
    yield d
    get_settings.cache_clear()


async def _proj(client, h, name: str) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _run(session, pid: str, uid: str) -> str:
    t = datetime.now(UTC)
    r = RunRecord(project_id=pid, subject_type="scenario", subject_id="sc-1",
                  subject_name="大响应场景", trigger="manual", status="passed",
                  created_by=uid, started_at=t, finished_at=t)
    session.add(r)
    await session.commit()
    return r.id


def _detail(body: str) -> dict:
    return {"request": {"method": "GET", "url": "http://t/big"},
            "response": {"status": 200, "headers": {"content-type": "application/json"},
                         "elapsed_ms": 12, "body_size": len(body), "truncated": False,
                         "body": body},
            "assertions": [], "logs": ["ok"]}


# ---------- ① 200KB 响应体：DB 存 {_ref,truncated,bytes,head}，文件真实存在且字节数对 ----------


async def test_oversized_body_offloaded_to_file(session, art_dir) -> None:
    import json

    from app.core.db import new_id

    pid, rid = new_id(), new_id()
    body = "x" * 200_000
    d = await offload_detail(session, project_id=pid, run_id=rid, step_key="n1", detail=_detail(body))
    await session.commit()

    ref = d["response"]["body"]["_ref"]
    assert d["response"]["body"]["truncated"] is True
    assert d["response"]["body"]["bytes"] == 200_000
    assert d["response"]["body"]["head"] == body[:2048], "head 是前 2KB 预览（计划 Interfaces 钉死）"
    p = artifact_path(ref)
    assert p.exists() and p.stat().st_size == 200_000
    assert p.read_text(encoding="utf-8") == body
    # §8.8 的动机：整条 detail 落库体积不得超过阈值，否则大行拖垮备份
    assert len(json.dumps(d, ensure_ascii=False).encode("utf-8")) <= get_settings().artifact_max_bytes
    rows = (await session.execute(select(RunArtifact).where(RunArtifact.run_id == rid))).scalars().all()
    assert [r.ref for r in rows] == [ref] and rows[0].kind == "RESPONSE" and rows[0].bytes == 200_000


# ---------- ② 阈值内不外置：不产生文件、不写 run_artifact、detail 原样 ----------


async def test_small_body_stays_inline_no_file(session, art_dir) -> None:
    import json

    from app.core.db import new_id

    pid, rid = new_id(), new_id()
    d = await offload_detail(session, project_id=pid, run_id=rid, step_key="n1", detail=_detail("small"))
    await session.commit()
    assert d["response"]["body"] == "small", "阈值内必须原样内联"
    assert list(art_dir.rglob("*")) == [], "阈值内不得产生任何制品文件"
    rows = (await session.execute(select(RunArtifact))).scalars().all()
    assert rows == []
    assert len(json.dumps(d).encode("utf-8")) <= get_settings().artifact_max_bytes


# ---------- ③ 下载端点：原字节 + 正确 content-type ----------


async def test_download_returns_exact_bytes_and_content_type(client, session, make_user, art_dir) -> None:
    u, h = await make_user("artdl")
    pid = await _proj(client, h, "制品下载")
    rid = await _run(session, pid, u.id)
    blob = '{"order_id": 7, "pad": "' + "z" * 70000 + '"}'
    ref = await save_artifact(session, project_id=pid, run_id=rid, kind="RESPONSE", blob=blob)
    await session.commit()
    name = ref.rsplit("/", 1)[1]

    r = await client.get(f"/api/v1/artifacts/{rid}/{name}", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    assert r.content == blob.encode("utf-8"), "必须逐字节还原，不是 JSON 包装"
    assert r.headers["content-type"].startswith("application/json")


# ---------- ④ 越界防护（安全线）：报告页绝不能变成任意文件读取器 ----------


async def test_traversal_via_http_400_not_404(client, session, make_user, art_dir) -> None:
    """打到 handler 的编码变体必须 400；这是判据④的正身（见模块 docstring 的探针事实）。"""
    u, h = await make_user("arttrv")
    pid = await _proj(client, h, "制品越界")
    rid = await _run(session, pid, u.id)
    (art_dir.parent / ".env").write_text("SECRET=leak", encoding="utf-8")

    # 这三种都会真正路由进 handler（探针实测）；断言 400+bad_ref 而不是 404
    for name in ("..%5c.env", "%2e%2e%5c.env", "%2e%2e"):
        r = await client.get(f"/api/v1/artifacts/{rid}/{name}", params={"project_id": pid}, headers=h)
        assert r.status_code == 400, name + " -> " + str(r.status_code)
        assert r.json()["code"] == "bad_ref"


def test_artifact_path_rejects_every_evasion_shape(art_dir) -> None:
    """解析后路径校验的五种形状：..、绝对路径、Windows 盘符/UNC、符号链接、URL 编码残留。"""
    for bad in ("../.env", "a/../../secret", "..\\x", "/etc/passwd",
                "C:/windows/win.ini", "\\\\nas\\share\\x", "%2e%2e/x", "C:file"):
        with pytest.raises(ApiError) as e:
            artifact_path(bad)
        assert e.value.code == "bad_ref" and e.value.http_status == 400, bad

    # run_id/name 各自独立校验：run_id 藏 .. 也不行
    with pytest.raises(ApiError):
        artifact_path("../../etc/passwd")


def test_artifact_path_rejects_symlink_escape(art_dir) -> None:
    """符号链接指向根外也不放行：resolve() 后必须仍在根内（Windows 无建链权限时跳过）。"""
    import os

    target = art_dir.parent / "outside.json"
    target.write_text("leak", encoding="utf-8")
    link = art_dir / "run1"
    try:
        os.symlink(str(target.parent), str(link), target_is_directory=True)
    except OSError:
        pytest.skip("Windows 无符号链接权限")
    with pytest.raises(ApiError) as e:
        artifact_path("run1/outside.json")
    assert e.value.code == "bad_ref"


# ---------- ⑤ 鉴权：api:run:read；非成员 403、成员但无位 403 ----------


async def test_download_requires_api_run_read(client, session, make_user, art_dir) -> None:
    from app.modules.iam.models import RoleTemplate

    u, h = await make_user("artauth")
    pid = await _proj(client, h, "制品鉴权")
    rid = await _run(session, pid, u.id)
    ref = await save_artifact(session, project_id=pid, run_id=rid, kind="RESPONSE", blob="hi")
    await session.commit()
    name = ref.rsplit("/", 1)[1]

    # 非成员：与「项目不存在」同一 403（不泄露存在性，iam 既有口径）
    other, ho = await make_user("artauthx")
    r = await client.get(f"/api/v1/artifacts/{rid}/{name}", params={"project_id": pid}, headers=ho)
    assert r.status_code == 403 and r.json()["code"] == "forbidden"

    # 成员但角色无 api:run:read：ensure_project_access 过、ctx.require 拦 → 403
    session.add(RoleTemplate(code="NO_RUN", name="看不到运行", perms=["project:read"], builtin=False))
    await session.commit()
    lurker, hl = await make_user("artlurk")
    put = await client.put(f"/api/v1/projects/{pid}/members/{lurker.id}",
                           json={"role_code": "NO_RUN"}, headers=h)
    assert put.status_code == 200, put.text
    r2 = await client.get(f"/api/v1/artifacts/{rid}/{name}", params={"project_id": pid}, headers=hl)
    assert r2.status_code == 403 and r2.json()["code"] == "insufficient_permission"

    # 跨项目 run_id → 404（与 report_get 同尺）
    pid2 = await _proj(client, h, "制品鉴权B")
    r3 = await client.get(f"/api/v1/artifacts/{rid}/{name}", params={"project_id": pid2}, headers=h)
    assert r3.status_code == 404


# ---------- ⑥ purge 策略：**保留**。理由与取舍见 artifacts.py 模块 docstring。 ----------
# 一句话：报告自包含（Review Focus 10）是承诺，head 预览只有 2KB，删文件等于把
# 「完整响应可下载」的承诺在 purge 那刻撕掉；无限堆积则交给 §8.8 夜间保留期任务
# （默认 90 天）按 run 龄期统一清，那是唯一该删文件的地方。purge 场景不碰制品、
# 也不提供「purge 时顺带删制品」的入口——保留期任务没交付前留删除入口就是假入口。


async def test_scenario_purge_keeps_artifacts_downloadable(client, session, make_user, art_dir) -> None:
    u, h = await make_user("artpurge")
    pid = await _proj(client, h, "制品purge")
    rid = await _run(session, pid, u.id)
    blob = "y" * 100_000
    ref = await save_artifact(session, project_id=pid, run_id=rid, kind="RESPONSE", blob=blob)
    await session.commit()
    name = ref.rsplit("/", 1)[1]

    sc = await client.post("/api/v1/scenarios", json={"project_id": pid, "name": "被purge的场景"}, headers=h)
    assert sc.status_code == 201, sc.text
    sid = sc.json()["id"]
    assert (await client.post(f"/api/v1/scenarios/{sid}/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    pr = await client.post(f"/api/v1/scenarios/{sid}/purge",
                           json={"project_id": pid, "scenario_id": sid, "confirm_name": "被purge的场景"},
                           headers=h)
    assert pr.status_code == 200, pr.text

    # 策略 = 保留：文件与 run_artifact 行都还在，下载照常（run_record 不随场景陪葬）
    assert artifact_path(ref).read_text(encoding="utf-8") == blob
    rows = (await session.execute(select(RunArtifact).where(RunArtifact.run_id == rid))).scalars().all()
    assert [r.ref for r in rows] == [ref]
    r = await client.get(f"/api/v1/artifacts/{rid}/{name}", params={"project_id": pid}, headers=h)
    assert r.status_code == 200 and r.content == blob.encode("utf-8")


# ---------- 1C：截图要能当图片看（计划 T8）------------------------------------
# 为什么单独一档：_sniff_type 原先只分「JSON / 文本 / 二进制」三档，PNG 落进去拿到
# application/octet-stream → 浏览器不内联渲染，只能下载。UI 用例的失败截图是 1C 的
# 主要交付物之一，「有截图」和「截图看得见」是两件事。
# 同时这一档也是**回归钉**：1A/1B 的制品（JSON 响应、中文日志、随机二进制）行为必须
# 一字不变，否则这次改动是在拿老功能换新功能。

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40 + b"IEND"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 40
GIF = b"GIF89a" + b"\x00" * 40
WEBP = b"RIFF" + (30).to_bytes(4, "little") + b"WEBP" + b"\x00" * 30


async def _download(client, h, pid: str, rid: str, name: str):
    return await client.get(f"/api/v1/artifacts/{rid}/{name}", params={"project_id": pid}, headers=h)


@pytest.mark.parametrize(
    ("blob", "ext", "ctype"),
    [
        (PNG, ".png", "image/png"),
        (JPEG, ".jpg", "image/jpeg"),
        (GIF, ".gif", "image/gif"),
        (WEBP, ".webp", "image/webp"),
    ],
    ids=["png", "jpeg", "gif", "webp"],
)
async def test_image_blobs_get_image_extension_and_ctype(
    client, session, make_user, art_dir, blob: bytes, ext: str, ctype: str
) -> None:
    """魔数嗅探：图片字节要拿对扩展名 + 对 content-type，浏览器才肯内联。"""
    u, h = await make_user("img" + ext.strip("."))
    pid = await _proj(client, h, "截图内联")
    rid = await _run(session, pid, u.id)

    ref = await save_artifact(session, project_id=pid, run_id=rid, kind="SCREENSHOT", blob=blob)
    await session.commit()
    assert ref.endswith(ext), f"扩展名应是 {ext}，实际 {ref}"

    got = await _download(client, h, pid, rid, ref.rsplit("/", 1)[1])
    assert got.status_code == 200, got.text
    assert got.content == blob, "必须逐字节还原（图片被重编码就是毁了证据）"
    assert got.headers["content-type"].startswith(ctype), got.headers["content-type"]


async def test_text_and_json_artifacts_are_unchanged(client, session, make_user, art_dir) -> None:
    """回归钉：1A/1B 那三类制品（JSON / 文本 / 二进制）一档都不许因为这次改动变样。"""
    u, h = await make_user("artreg")
    pid = await _proj(client, h, "老制品回归")
    rid = await _run(session, pid, u.id)

    j = await save_artifact(session, project_id=pid, run_id=rid, kind="RESPONSE", blob='{"a": 1}')
    t = await save_artifact(session, project_id=pid, run_id=rid, kind="LOG", blob="中文日志一行\n")
    b = await save_artifact(session, project_id=pid, run_id=rid, kind="BLOB", blob=b"\x00\x01\x02\xfe")
    await session.commit()

    assert j.endswith(".json") and t.endswith(".bin") and b.endswith(".bin"), (j, t, b)
    for ref, ctype in ((j, "application/json"), (t, "text/plain"), (b, "application/octet-stream")):
        got = await _download(client, h, pid, rid, ref.rsplit("/", 1)[1])
        assert got.status_code == 200, got.text
        assert got.headers["content-type"].startswith(ctype), (ref, got.headers["content-type"])


def test_sniff_does_not_mistake_text_for_image(art_dir) -> None:
    """嗅探是**前缀魔数**判定，不是「含关键字」判定。

    一条以字符串 "PNG" 开头的日志（比如「PNG 截图失败」）绝不能被判成 image/png——
    那会让一段文本以图片 content-type 出货，报告里显示成碎图标。
    """
    from app.modules.execution.artifacts import _sniff_type

    assert _sniff_type("PNG 截图失败：浏览器没起来".encode()) == "text/plain; charset=utf-8"
    assert _sniff_type(b'\x89PNG\r\n\x1a\n{"not":"json"}') == "image/png"  # 魔数优先于内容长相
    assert _sniff_type(b"RIFFxxxx") == "text/plain; charset=utf-8", "RIFF 后必须是 WEBP 才算 webp"
