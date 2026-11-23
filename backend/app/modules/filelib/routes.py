"""文件库上传/下载（D195）：multipart 与流式返回走不了注册表投影，住独立 router。

依赖由装配层注入（同 scenario SSE 的 R26 手法）：契约 1 不允许 filelib import iam 的
get_current_user。鉴权复用 `core.build_ctx`（含项目数据权限门），再 require 权限位。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.core.service import build_ctx
from app.modules.filelib.models import FileBlob
from app.modules.filelib.services import create_blob, create_uploaded_entry, entry_detail
from app.modules.filelib.storage import MAX_FILE_BYTES, open_path


def build_file_router(*, get_db_dep: Any, get_user_dep: Any, user_model: Any) -> APIRouter:
    router = APIRouter(tags=["file"])

    @router.post("/files/upload")
    async def upload_file(
        project_id: str = Form(...),
        folder_id: str | None = Form(default=None),
        name: str | None = Form(default=None),
        description: str | None = Form(default=None),
        tags: str | None = Form(default=None),
        file: UploadFile = File(...),
        db: AsyncSession = Depends(get_db_dep),
        user: user_model = Depends(get_user_dep),
    ):
        ctx = await build_ctx(db, user, {"project_id": project_id}, entry="http")
        ctx.require("file:file:create")
        data = bytearray()
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_FILE_BYTES:
                raise ApiError("file_too_large",
                               "文件超过 " + str(MAX_FILE_BYTES // (1024 * 1024)) + "MB 上限",
                               413, {"max_bytes": MAX_FILE_BYTES})
        if not data:
            raise ApiError("empty_file", "空文件不能上传", 422, {})
        entry = await create_uploaded_entry(
            db, project_id=project_id, folder_id=folder_id or None, name=name or "",
            description=description, tags=[t for t in (tags or "").split(",") if t.strip()],
            data=bytes(data), filename=file.filename or "file", created_by=ctx.user_id)
        await db.commit()
        return await entry_detail(db, project_id, entry)

    @router.post("/files/blobs")
    async def upload_blob(
        project_id: str = Form(...),
        file: UploadFile = File(...),
        db: AsyncSession = Depends(get_db_dep),
        user: user_model = Depends(get_user_dep),
    ):
        # 附件/富文本专用：只建 blob，不建仓库条目（对应 MS 的 local attachment）
        ctx = await build_ctx(db, user, {"project_id": project_id}, entry="http")
        ctx.require("file:attachment:create")
        data = bytearray()
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_FILE_BYTES:
                raise ApiError("file_too_large",
                               "文件超过 " + str(MAX_FILE_BYTES // (1024 * 1024)) + "MB 上限",
                               413, {"max_bytes": MAX_FILE_BYTES})
        if not data:
            raise ApiError("empty_file", "空文件不能上传", 422, {})
        blob = await create_blob(db, project_id=project_id, data=bytes(data),
                                 filename=file.filename or "file", created_by=ctx.user_id)
        await db.commit()
        return {"blob": {
            "id": blob.id, "sha256": blob.sha256, "size": blob.size, "mime": blob.mime,
            "original_name": blob.original_name,
        }}

    @router.get("/files/{blob_id}/content")
    async def file_content(
        blob_id: str,
        project_id: str = Query(...),
        disposition: str = Query(default="inline", pattern="^(inline|attachment)$"),
        db: AsyncSession = Depends(get_db_dep),
        user: user_model = Depends(get_user_dep),
    ):
        ctx = await build_ctx(db, user, {"project_id": project_id}, entry="http")
        ctx.require("file:file:read")
        blob = (await db.execute(select(FileBlob).where(
            FileBlob.id == blob_id, FileBlob.project_id == project_id))).scalar_one_or_none()
        if blob is None:
            raise ApiError("not_found", "文件内容不存在", 404, {"blob_id": blob_id})
        try:
            path = open_path(blob.storage_key)
        except FileNotFoundError as e:
            raise ApiError("file_missing", "文件内容在存储中缺失", 410, {"blob_id": blob_id}) from e
        return FileResponse(path, media_type=blob.mime, filename=blob.original_name,
                            content_disposition_type=disposition)

    return router


__all__ = ["build_file_router"]
