"""本地磁盘内容存储（D195）。

键布局：`{files_dir}/{project_id}/{sha[:2]}/{sha}`。内容寻址 = 同项目同字节只落一次盘；
`storage_key` 只存相对路径，根目录按仓库根解析（`resolve_repo_path`，同 artifacts 的启动目录坑）。

**不建 MinIO 依赖**：当前部署没有对象存储；换 S3 时只换 put/open/delete 三个函数，
表结构不变（`storage_key` 是抽象键）。
"""
from __future__ import annotations

import hashlib
import mimetypes
import os
import re
from pathlib import Path

from app.core.config import get_settings, resolve_repo_path

MAX_FILE_BYTES = 50 * 1024 * 1024
_SEG_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def file_root() -> Path:
    return resolve_repo_path(get_settings().files_dir)


def safe_storage_key(key: str) -> Path:
    parts = [p for p in key.split("/") if p not in ("", ".")]
    if not parts or any(p in ("..",) or not _SEG_RE.fullmatch(p) for p in parts):
        raise ValueError("bad storage key")
    root = file_root()
    p = root.joinpath(*parts).resolve()
    if p != root and root not in p.parents:
        raise ValueError("storage key escapes root")
    return p


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def storage_key_for(project_id: str, sha: str) -> str:
    return "files/" + project_id + "/" + sha[:2] + "/" + sha


def save_bytes(project_id: str, data: bytes) -> tuple[str, str]:
    sha = sha256_of(data)
    key = storage_key_for(project_id, sha)
    path = safe_storage_key(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)
    return sha, key


def open_path(storage_key: str) -> Path:
    p = safe_storage_key(storage_key)
    if not p.is_file():
        raise FileNotFoundError(storage_key)
    return p


def delete_key(storage_key: str) -> None:
    try:
        p = safe_storage_key(storage_key)
    except ValueError:
        return
    try:
        p.unlink(missing_ok=True)
    except OSError:
        pass


def guess_mime(filename: str, fallback: str = "application/octet-stream") -> str:
    return mimetypes.guess_type(filename)[0] or fallback


def safe_filename(name: str) -> str:
    base = Path(name.replace("\\", "/")).name.strip()
    base = re.sub(r"[\x00-\x1f]", "", base)
    return (base or "file")[:255]
