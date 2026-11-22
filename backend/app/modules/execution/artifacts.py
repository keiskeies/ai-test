"""大响应体外置制品（§8.8 的 64KB 线）：save / 越界防护 / 下载端点 / detail 裁剪。

为什么裁剪逻辑在 execution 侧而不是 scenario/engine/events.py（计划原文写在 events.py，
此处偏离已报备）：契约 4 要求 execution 依赖闭包最小、可被一切复用；「detail 超阈值
→ 落文件、DB 存 ref」是**执行数据生命周期**的规矩，不是场景引擎的私有知识。放 execution
侧、由 scenario 侧（runner/handler）调用，依赖方向才是对的——反过来 events.py 长出
文件 IO 后，execution 的读写两侧就分家了。

purge 策略（判据⑥）：**保留**。取舍是真实的——
- 报告自包含（Review Focus 10）钉的是「资产删了报告还得能读」；制品是磁盘文件不是
  DB 快照，删了文件，报告里就只剩 2KB head 残骸，等于在 purge 那一刻撕掉
  「完整响应可下载」的承诺；
- 但保留就是无限堆积。兜底是 §8.8 的夜间保留期任务（kv_setting 默认 90 天，按 run
  龄期整体清理冷表与制品，备份先于清理）——那是唯一该删制品的地方，按时间删而不是
  按资产删。
- 所以 scenario_purge 不碰制品，也**不提供**任何「purge 时顺带删制品」的入口：
  保留期任务（T16+）没交付前，删除入口就是 owner 铁律禁止的假入口。

路径安全（判据④，安全线）：报告页绝不能变成任意文件读取器。实测事实（Starlette 当前
版本）：`../`、`..%2f`、绝对路径在 URL 规范化后根本路由不到 handler；真正到达 handler
的是 `..%5c`（→ `..\\.env`）、`%2e%2e`（→ `..`）这类编码变体。所以防护重心不在路由匹配
而在解析后的校验：artifact_path 用「unquote → 字符白名单 → 段检查 → resolve 后必须
仍在根内」四道，任何一道不过 → 400 bad_ref。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote
from uuid import uuid4

from pydantic import BaseModel
from sqlalchemy import select
from starlette.responses import Response

from app.core.config import get_settings, resolve_repo_path
from app.core.errors import ApiError
from app.core.service import ensure_project_access, service
from app.modules.execution.models import RunArtifact, RunRecord

# 白名单：仅字母数字下划线点连字符，分段 '/'。这一条就排除了反斜杠、冒号、%、NUL、
# 绝对路径与前导 '/'。'..' 只含点能过字符关，由段检查兜掉。
_SEG_RE = re.compile(r"[A-Za-z0-9_.\-]+")
HEAD_CHARS = 2048  # head 预览：计划 Interfaces 钉死「前 2KB 预览」


def _ref_error(ref: Any) -> ApiError:
    return ApiError("bad_ref", "制品路径非法", 400, {"ref": str(ref)[:200]})


def _norm_parts(raw: Any) -> list[str]:
    """ref/参数 → 段列表。先 unquote（挡 %2e%2e 残留形态），再过字符白名单与段检查。"""
    # 解码**两趟**：单次解码后仍留 %25xx 的形态（%252e%252e → %2e%2e）在某些代理/
    # 客户端组合下会二次还原，白名单只看解码后的样子不足以挡住。第二趟只可能让
    # 输入更短更难看，不会放过任何合法名字（真名字里没有 %）。
    s = unquote(unquote(str(raw or "")))
    if "\x00" in s or len(s) > 500:
        raise _ref_error(raw)
    # 绝对路径（POSIX / UNC / Windows 盘符，含 C:file 这种盘符相对形态）一律拒绝——
    # 不剥前导 '/' 当相对路径处理，那是「看起来挡住了其实换了个根」的假绿。
    if s.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", s):
        raise _ref_error(raw)
    parts = [p for p in s.split("/") if p not in ("", ".")]
    if not parts:
        raise _ref_error(raw)
    for p in parts:
        if not _SEG_RE.fullmatch(p) or p.strip(".") == "":
            # 白名单挡反斜杠/盘符/UNC；strip('.') 挡 '..'、'...'（点全是合法字符，段检查兜）
            raise _ref_error(raw)
    return parts


def artifact_root() -> Path:
    # 走 config 的唯一锚点：相对配置按仓库根解析。曾经这里是 Path(...).resolve()，
    # 于是 `cd backend` 启动（三份手册的写法）会把制品写进 backend/backend/data/，
    # 而库里存的 ref 不变——换启动目录就跑不出去（见 config.py 顶部与 test_config_paths.py）。
    return resolve_repo_path(get_settings().artifacts_dir)


def artifact_path(ref: str) -> Path:
    """ref → 根内绝对路径；越界一律 400 bad_ref（判据④的落点，越界不 403：与权限无关）。

    resolve(strict=False) 会把符号链接指到真实目标再比对前缀——链接指向根外同样拒绝。
    """
    root = artifact_root()
    p = root.joinpath(*_norm_parts(ref)).resolve()
    if p != root and root not in p.parents:
        raise _ref_error(ref)
    return p


# 1C：图片魔数 → (content-type, 扩展名)。**按前缀魔数判，不按关键字**：
# 一段以 "PNG 截图失败" 开头的日志必须仍是文本，否则一段日志会以 image/png 出货，
# 报告里显示成碎图标（tests/test_artifacts.py 钉着这条）。
# webp 要 RIFF + WEBP 双判：只判 RIFF 会把 WAV/AVI 冒充成 webp。
_MAGIC: tuple[tuple[bytes, str, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png", ".png"),
    (b"\xff\xd8\xff", "image/jpeg", ".jpg"),
    (b"GIF8", "image/gif", ".gif"),
)


def _sniff_image(blob: bytes) -> tuple[str, str] | None:
    for magic, ctype, ext in _MAGIC:
        if blob.startswith(magic):
            return ctype, ext
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None


def _sniff_type(blob: bytes) -> str:
    """落盘与下载共用的 content-type 推断：图片按魔数，UTF-8 文本按 JSON/纯文本分，其余二进制。

    blob 若是合法 UTF-8 且以 {/[ 开头按 JSON——比严格 parse 宽容：截断的日志尾部
    也是文本，下载端点要能用浏览器直接看。
    图片必须在**解码之前**判：PNG 字节多半不是合法 UTF-8，走文本分支只会拿到
    octet-stream，浏览器就不内联渲染（1C 的失败截图原先就卡在这一步）。
    """
    img = _sniff_image(blob)
    if img is not None:
        return img[0]
    try:
        text = blob.decode("utf-8")
    except UnicodeDecodeError:
        return "application/octet-stream"
    head = text.lstrip()
    if head.startswith(("{", "[")):
        return "application/json"
    return "text/plain; charset=utf-8"


def _write(root: Path, rel: str, blob: bytes) -> Path:
    p = artifact_path(rel)  # 写面同样过校验：run_id 调用方给错也不能逃逸
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(blob)
    return p


async def save_artifact(db: Any, *, project_id: str, run_id: str, kind: str,
                        blob: str | bytes, step_key: str | None = None) -> str:
    """字节落 {artifacts_dir}/{run_id}/{uuid}.{ext}，run_artifact 记 ref（相对路径）。

    commit 由调用方负责（与 write_step/save_run 同一事务口径）；run 归属 project 的
    强校验在读侧（下载）做——写侧在 worker 热路径上，run_id 是 runner 自己生成的。
    """
    data = blob.encode("utf-8") if isinstance(blob, str) else bytes(blob)
    # 扩展名跟着 content-type 走：截图存成 .bin 的话，光看文件名就分不出是图还是日志。
    img = _sniff_image(data)
    if img is not None:
        ext = img[1]
    else:
        ext = ".json" if _sniff_type(data) == "application/json" else ".bin"
    rel = run_id + "/" + uuid4().hex + ext
    _write(artifact_root(), rel, data)
    db.add(RunArtifact(run_id=run_id, step_key=step_key, kind=kind, ref=rel, bytes=len(data)))
    await db.flush()
    return rel


def _encoded(value: Any) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        return len(str(value).encode("utf-8"))


def _marker(ref: str, blob: bytes, head: str) -> dict[str, Any]:
    # DB 侧的替身（计划 Interfaces 钉死的形状）：报告页据此渲染「已外置 + 下载入口」
    return {"_ref": ref, "truncated": True, "bytes": len(blob), "head": head}


async def offload_detail(db: Any, *, project_id: str, run_id: str, step_key: str,
                         detail: dict | None) -> dict | None:
    """落库前的裁剪（§8.8）：response.body / logs 超阈值 → 外置，detail 内只留替身。

    由 scenario 侧执行链在 write_step 之前调用；execution 不认识 runner，方向是正的。
    阈值是「单条 detail 落库总大小 ≤ artifact_max_bytes」的手段而不是目的：先按字段
    裁，裁完仍超就把最大的那个候选裁掉（head 只有 2KB，正常 detail 裁一轮就达标；
    headers 这类病态大字段真超就随它去——裁它等于毁报告的可读性）。
    """
    if not detail:
        return detail
    limit = get_settings().artifact_max_bytes
    if _encoded(detail) <= limit:
        return detail  # 判据②：阈值内原样返回，绝不产生文件

    out = json.loads(json.dumps(detail, ensure_ascii=False))  # 深拷贝，不改调用方的对象
    resp = out.get("response")
    candidates: list[tuple[list[Any] | dict, str, str]] = []  # (容器, 键, 全文)
    if isinstance(resp, dict) and isinstance(resp.get("body"), str):
        candidates.append((resp, "body", resp["body"]))
    logs = out.get("logs")
    if isinstance(logs, list):
        candidates.append((out, "logs", "\n".join(str(x) for x in logs)))
    elif isinstance(logs, str):
        candidates.append((out, "logs", logs))

    def _offload(container: Any, key: str, text: str) -> None:
        blob = text.encode("utf-8")
        ext = ".json" if key == "body" and _sniff_type(blob) == "application/json" else ".txt"
        rel = run_id + "/" + step_key + "-" + key + ext
        _write(artifact_root(), rel, blob)
        db.add(RunArtifact(run_id=run_id, step_key=step_key, kind="LOG" if key == "logs" else "RESPONSE",
                           ref=rel, bytes=len(blob)))
        container[key] = _marker(rel, blob, text[:HEAD_CHARS])

    over = [c for c in candidates if len(c[2].encode("utf-8")) > limit]
    for c in over:
        _offload(c[0], c[1], c[2])
    if _encoded(out) > limit and candidates:
        biggest = max(candidates, key=lambda c: len(c[2].encode("utf-8")))
        if biggest not in over:
            _offload(biggest[0], biggest[1], biggest[2])
    await db.flush()
    return out


class ArtifactDownloadIn(BaseModel):
    # project_id 必填（query）：数据权限门走 build_ctx/ensure_project_access 的既有通道，
    # 与 report_get 同尺——跨项目 run_id 一律 404，不泄露存在性。
    project_id: str
    run_id: str
    name: str


@service(
    perm="api:run:read", effect="read", name="artifact_download",
    description="下载运行制品原始字节（响应体快照/日志/截图；报告页制品入口）",
    http={"method": "GET", "path": "/artifacts/{run_id}/{name}", "tags": ["execution"]},
    resident=False,
)
async def artifact_download(payload: ArtifactDownloadIn, ctx) -> Response:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:run:read")
    assert ctx.db is not None
    # 先过路径校验再看库：越界是 400，与「run 不存在」的 404 分开——400 说的是
    # 「这个路径根本不该出现」，404 说的是「资源不在」，混起来安全审计时读不出信息。
    ref = payload.run_id + "/" + payload.name
    path = artifact_path(ref)
    run = (await ctx.db.execute(
        select(RunRecord.id).where(RunRecord.id == payload.run_id,
                                   RunRecord.project_id == payload.project_id)
    )).first()
    if run is None:
        raise ApiError("not_found", "制品不存在", 404, {"run_id": payload.run_id})
    if not path.is_file():
        raise ApiError("not_found", "制品不存在", 404, {"ref": ref})
    blob = path.read_bytes()
    # 无 Cache-Control：制品内容按 run_id+uuid 不可变，但可见性跟着项目成员关系走，
    # 中间缓存会把「已移出成员」的人继续喂好文件。
    return Response(content=blob, media_type=_sniff_type(blob))


__all__ = ["artifact_download", "artifact_path", "artifact_root", "offload_detail", "save_artifact"]
