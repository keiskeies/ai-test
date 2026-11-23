"""文件库 / 附件 @service（D195）：目录树、仓库文件、附件链接。

**上传/下载不是 @service**（multipart/流式返回走不了注册表投影），住 `routes.py`；
本文件只做元数据与链接。blob 引用计数为 0 时删盘上字节（不留 MS 的空体死链）。
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import column, func, select, table

from app.core.errors import ApiError, OkOut, Page, paginate_page
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.filelib import schemas
from app.modules.filelib.models import (
    STATUS_NORMAL,
    STATUS_RECYCLED,
    FileBlob,
    FileEntry,
    FileFolder,
    FileLink,
)
from app.modules.filelib.storage import (
    delete_key,
    guess_mime,
    safe_filename,
    save_bytes,
    sha256_of,
)
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

APP_USER = table("app_user", column("id"), column("name"), column("account"))
BUG = table("defect", column("id"), column("project_id"))
FUNCTIONAL_CASE = table("functional_case", column("id"), column("project_id"))

# D222：文件库列表的可筛面（D47-a 三件套铺到文件管理页）。字段来自列表实际 join 的
# file_entry + file_blob 两张表，全是真实列，白名单外 400 带本页清单。这些轴刻意不进条件组：
# - `folder_id` / `unfiled_only` 是左树目录轴（与条件组并行 AND，不是互相替代）；
# - `keyword` 是快捷搜索框（它本身就同时匹配文件名与描述，再进条件组会出现两套写法）；
# - `recycled` 是视图开关（正常/回收站同一端点）；`status` 随之不可筛；
# - `current` / `size` 是分页参数（`size` 作为 blob 大小的字段名在条件 JSON 里，不与
#   查询串的 page size 混淆——两者不在同一层）。
FILE_LIST_FILTER = ListViewFilter(
    view_type="file",
    label="文件库",
    fields={
        "name": FieldDecl(FileEntry.name, "text", "文件名", nullable=False),
        "description": FieldDecl(FileEntry.description, "text", "描述"),
        "tags": FieldDecl(FileEntry.tags, "text", "标签"),
        "version": FieldDecl(FileEntry.version, "number", "版本", nullable=False),
        "size": FieldDecl(FileBlob.size, "number", "文件大小", nullable=False),
        "mime": FieldDecl(FileBlob.mime, "text", "类型", nullable=False),
        "original_name": FieldDecl(FileBlob.original_name, "text", "原始文件名", nullable=False),
        "created_by": FieldDecl(FileEntry.created_by, "id", "上传人"),
        "updated_by": FieldDecl(FileEntry.updated_by, "id", "更新人"),
        "created_at": FieldDecl(FileEntry.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(FileEntry.updated_at, "time", "更新时间", nullable=False),
    },
)
register(FILE_LIST_FILTER)


async def _user_names(db, ids: set[str | None]) -> dict[str, str]:
    real = {i for i in ids if i}
    if not real:
        return {}
    rows = (await db.execute(select(APP_USER.c.id, APP_USER.c.name).where(APP_USER.c.id.in_(real)))).all()
    return {r.id: r.name for r in rows}


async def _folder(db, project_id: str, folder_id: str, *, include_recycled: bool = False) -> FileFolder:
    row = (await db.execute(select(FileFolder).where(
        FileFolder.id == folder_id, FileFolder.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "目录不存在", 404, {"folder_id": folder_id})
    if row.status == STATUS_RECYCLED and not include_recycled:
        raise ApiError("not_found", "目录不存在（在回收站）", 404, {"folder_id": folder_id})
    return row


async def _entry(db, project_id: str, file_id: str, *, include_recycled: bool = False) -> FileEntry:
    row = (await db.execute(select(FileEntry).where(
        FileEntry.id == file_id, FileEntry.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "文件不存在", 404, {"file_id": file_id})
    if row.status == STATUS_RECYCLED and not include_recycled:
        raise ApiError("not_found", "文件不存在（在回收站）", 404, {"file_id": file_id})
    return row


def _split_tags(raw: str | None) -> list[str]:
    return [t for t in (x.strip() for x in (raw or "").split(",")) if t]


def _join_tags(tags: list[str] | None) -> str | None:
    if not tags:
        return None
    out: list[str] = []
    for t in tags:
        t = t.strip()
        if t and t not in out:
            out.append(t)
    return ",".join(out) or None


async def _blob(db, project_id: str, blob_id: str) -> FileBlob:
    row = (await db.execute(select(FileBlob).where(
        FileBlob.id == blob_id, FileBlob.project_id == project_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "文件内容不存在", 404, {"blob_id": blob_id})
    return row


async def _blob_refs(db, blob_id: str) -> int:
    entries = int((await db.execute(select(func.count()).select_from(FileEntry).where(
        FileEntry.blob_id == blob_id))).scalar_one())
    links = int((await db.execute(select(func.count()).select_from(FileLink).where(
        FileLink.blob_id == blob_id))).scalar_one())
    return entries + links


async def _gc_blob(db, blob: FileBlob) -> None:
    if await _blob_refs(db, blob.id) == 0:
        delete_key(blob.storage_key)
        await db.delete(blob)


def _blob_out(b: FileBlob) -> schemas.FileBlobOut:
    return schemas.FileBlobOut(
        id=b.id, sha256=b.sha256, size=b.size, mime=b.mime,
        original_name=b.original_name, created_at=schemas.iso(b.created_at))


def _entry_out(e: FileEntry, b: FileBlob, names: dict[str, str]) -> schemas.FileEntryOut:
    return schemas.FileEntryOut(
        id=e.id, project_id=e.project_id, folder_id=e.folder_id, name=e.name,
        description=e.description, tags=_split_tags(e.tags), version=e.version,
        is_latest=e.is_latest, recycled=e.status == STATUS_RECYCLED,
        blob=_blob_out(b), created_by=e.created_by,
        created_by_name=names.get(e.created_by or ""), updated_at=schemas.iso(e.updated_at))


async def entry_detail(db, project_id: str, entry: FileEntry) -> schemas.FileEntryOut:
    b = await _blob(db, project_id, entry.blob_id)
    names = await _user_names(db, {entry.created_by})
    return _entry_out(entry, b, names)


async def _name_taken(db, project_id: str, folder_id: str | None, name: str,
                      exclude: str | None = None) -> bool:
    stmt = select(FileEntry.id).where(
        FileEntry.project_id == project_id, FileEntry.name == name,
        FileEntry.status == STATUS_NORMAL)
    stmt = stmt.where(FileEntry.folder_id.is_(None)) if folder_id is None \
        else stmt.where(FileEntry.folder_id == folder_id)
    if exclude:
        stmt = stmt.where(FileEntry.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


async def create_blob(db, *, project_id: str, data: bytes, filename: str,
                      created_by: str) -> FileBlob:
    """内容落盘 + blob 去重（不建仓库条目）。调用方 commit。"""
    sha = sha256_of(data)
    blob = (await db.execute(select(FileBlob).where(
        FileBlob.project_id == project_id, FileBlob.sha256 == sha))).scalar_one_or_none()
    if blob is None:
        _, key = save_bytes(project_id, data)
        blob = FileBlob(project_id=project_id, sha256=sha, size=len(data),
                        mime=guess_mime(filename), original_name=safe_filename(filename),
                        storage_key=key, created_by=created_by, created_at=datetime.now(UTC))
        db.add(blob)
        await db.flush()
    return blob


async def create_uploaded_entry(db, *, project_id: str, folder_id: str | None, name: str,
                                description: str | None, tags: list[str] | None,
                                data: bytes, filename: str, created_by: str) -> FileEntry:
    """上传路由调用：内容落盘 + blob 去重 + 仓库条目。调用方 commit。"""
    if folder_id:
        await _folder(db, project_id, folder_id)
    name = safe_filename(name or filename)
    if await _name_taken(db, project_id, folder_id, name):
        raise ApiError("conflict", "同目录下文件重名", 409, {"name": name})
    blob = await create_blob(db, project_id=project_id, data=data, filename=filename,
                             created_by=created_by)
    entry = FileEntry(project_id=project_id, folder_id=folder_id, blob_id=blob.id,
                      name=name, description=description, tags=_join_tags(tags),
                      root_id="", version=1, is_latest=True, status=STATUS_NORMAL,
                      created_by=created_by, updated_by=created_by)
    db.add(entry)
    await db.flush()
    entry.root_id = entry.id
    return entry


# ══════════ 目录树 ══════════
def _tree(nodes: list[FileFolder], counts: dict[str, int]) -> list[schemas.FolderNode]:
    by_id = {n.id: schemas.FolderNode(id=n.id, parent_id=n.parent_id, name=n.name,
                                      sort=n.sort, status=n.status,
                                      file_count=counts.get(n.id, 0)) for n in nodes}
    roots: list[schemas.FolderNode] = []
    for n in sorted(nodes, key=lambda x: (x.sort, x.name, x.id)):
        node = by_id[n.id]
        if n.parent_id and n.parent_id in by_id:
            by_id[n.parent_id].children.append(node)
        else:
            roots.append(node)
    return roots


@service(
    perm="file:folder:read", effect="read", name="file_folder_tree",
    description="文件库目录树（含每个目录的直属文件数；回收站另列）",
    http={"method": "GET", "path": "/file-folders/tree", "tags": ["file"]},
)
async def file_folder_tree(payload: schemas.FolderTreeIn, ctx) -> schemas.FolderTreeOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:folder:read")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(FileFolder).where(
        FileFolder.project_id == payload.project_id))).scalars().all()
    normal = [f for f in rows if f.status == STATUS_NORMAL]
    recycled = [f for f in rows if f.status == STATUS_RECYCLED]
    counts: dict[str, int] = {}
    if normal:
        cr = (await ctx.db.execute(select(FileEntry.folder_id, func.count()).where(
            FileEntry.project_id == payload.project_id,
            FileEntry.status == STATUS_NORMAL,
            FileEntry.folder_id.is_not(None)).group_by(FileEntry.folder_id))).all()
        counts = {fid: int(n) for fid, n in cr}
    return schemas.FolderTreeOut(
        tree=_tree(normal, counts),
        recycled=[schemas.FolderNode(id=f.id, parent_id=f.parent_id, name=f.name,
                                     sort=f.sort, status=f.status) for f in recycled]
        if payload.include_recycled else [])


async def _sibling_taken(db, project_id: str, parent_id: str | None, name: str,
                         exclude: str | None = None) -> bool:
    stmt = select(FileFolder.id).where(
        FileFolder.project_id == project_id, FileFolder.name == name,
        FileFolder.status == STATUS_NORMAL)
    stmt = stmt.where(FileFolder.parent_id.is_(None)) if parent_id is None \
        else stmt.where(FileFolder.parent_id == parent_id)
    if exclude:
        stmt = stmt.where(FileFolder.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


@service(
    perm="file:folder:create", effect="write", name="file_folder_create",
    description="新建文件库目录（同父重名 409）",
    http={"method": "POST", "path": "/file-folders", "tags": ["file"], "status": 201},
)
async def file_folder_create(payload: schemas.FolderCreateIn, ctx) -> schemas.FolderNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:folder:create")
    assert ctx.db is not None
    if payload.parent_id:
        await _folder(ctx.db, payload.project_id, payload.parent_id)
    if await _sibling_taken(ctx.db, payload.project_id, payload.parent_id, payload.name):
        raise ApiError("conflict", "同一父目录下名称已存在", 409, {"name": payload.name})
    f = FileFolder(project_id=payload.project_id, parent_id=payload.parent_id,
                   name=payload.name, sort=payload.sort)
    ctx.db.add(f)
    await ctx.db.commit()
    return schemas.FolderNode(id=f.id, parent_id=f.parent_id, name=f.name, sort=f.sort, status=f.status)


async def _would_cycle(db, project_id: str, folder_id: str, new_parent: str | None) -> bool:
    cur, guard = new_parent, 0
    while cur:
        if cur == folder_id:
            return True
        row = (await db.execute(select(FileFolder.parent_id).where(
            FileFolder.id == cur, FileFolder.project_id == project_id))).first()
        cur = row[0] if row else None
        guard += 1
        if guard > 10000:
            return True
    return False


@service(
    perm="file:folder:update", effect="write", name="file_folder_update",
    description="更新/移动文件库目录（防环、同父重名 409）",
    http={"method": "PATCH", "path": "/file-folders/{folder_id}", "tags": ["file"]},
)
async def file_folder_update(payload: schemas.FolderUpdateIn, ctx) -> schemas.FolderNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:folder:update")
    assert ctx.db is not None
    f = await _folder(ctx.db, payload.project_id, payload.folder_id)
    parent_id = f.parent_id
    if payload.parent_set:
        parent_id = payload.parent_id
        if parent_id:
            await _folder(ctx.db, payload.project_id, parent_id)
            if await _would_cycle(ctx.db, payload.project_id, f.id, parent_id):
                raise ApiError("cycle", "不能把目录移动到自己的子树里", 422, {"folder_id": f.id})
    name = payload.name if payload.name is not None else f.name
    if (payload.name is not None and payload.name != f.name) or payload.parent_set:
        if await _sibling_taken(ctx.db, payload.project_id, parent_id, name, exclude=f.id):
            raise ApiError("conflict", "同一父目录下名称已存在", 409, {"name": name})
    f.name, f.parent_id = name, parent_id
    if payload.sort is not None:
        f.sort = payload.sort
    await ctx.db.commit()
    return schemas.FolderNode(id=f.id, parent_id=f.parent_id, name=f.name, sort=f.sort, status=f.status)


@service(
    perm="file:folder:delete", effect="destructive", name="file_folder_delete",
    description="目录放入回收站（有子目录或正常文件 → 409）",
    http={"method": "POST", "path": "/file-folders/{folder_id}/delete", "tags": ["file"]},
)
async def file_folder_delete(payload: schemas.FolderGetIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:folder:delete")
    assert ctx.db is not None
    f = await _folder(ctx.db, payload.project_id, payload.folder_id)
    kids = int((await ctx.db.execute(select(func.count()).select_from(FileFolder).where(
        FileFolder.parent_id == f.id, FileFolder.status == STATUS_NORMAL))).scalar_one())
    files = int((await ctx.db.execute(select(func.count()).select_from(FileEntry).where(
        FileEntry.folder_id == f.id, FileEntry.status == STATUS_NORMAL))).scalar_one())
    if kids or files:
        raise ApiError("folder_not_empty",
                       "目录下还有 " + str(kids) + " 个子目录、" + str(files) + " 个文件，不能回收",
                       409, {"folder_id": f.id, "children": kids, "files": files})
    f.status = STATUS_RECYCLED
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="file:folder:update", effect="write", name="file_folder_restore",
    description="从回收站恢复目录（父在回收站/同级重名 → 409）",
    http={"method": "POST", "path": "/file-folders/{folder_id}/restore", "tags": ["file"]},
)
async def file_folder_restore(payload: schemas.FolderGetIn, ctx) -> schemas.FolderNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:folder:update")
    assert ctx.db is not None
    f = await _folder(ctx.db, payload.project_id, payload.folder_id, include_recycled=True)
    if f.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "目录不在回收站", 404, {"folder_id": f.id})
    if f.parent_id:
        parent = await _folder(ctx.db, payload.project_id, f.parent_id, include_recycled=True)
        if parent.status == STATUS_RECYCLED:
            raise ApiError("parent_recycled", "父目录在回收站：先恢复父目录", 409, {"folder_id": f.id})
    if await _sibling_taken(ctx.db, payload.project_id, f.parent_id, f.name, exclude=f.id):
        raise ApiError("conflict", "回收期间同级出现了同名目录：先处理它再恢复", 409, {"name": f.name})
    f.status = STATUS_NORMAL
    await ctx.db.commit()
    return schemas.FolderNode(id=f.id, parent_id=f.parent_id, name=f.name, sort=f.sort, status=f.status)


@service(
    perm="file:folder:delete", effect="destructive", name="file_folder_purge",
    description="彻底删除目录（必须已回收且无子目录/文件；逐字确认名称）",
    http={"method": "POST", "path": "/file-folders/{folder_id}/purge", "tags": ["file"]},
    tool=False,
)
async def file_folder_purge(payload: schemas.FolderPurgeIn, ctx) -> schemas.FolderPurgeOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:folder:delete")
    assert ctx.db is not None
    f = await _folder(ctx.db, payload.project_id, payload.folder_id, include_recycled=True)
    if f.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的目录", 409, {"folder_id": f.id})
    if payload.confirm_name != f.name:
        raise ApiError("name_mismatch", "确认名称与目录名不一致，未删除", 409, {"folder_id": f.id})
    kids = int((await ctx.db.execute(select(func.count()).select_from(FileFolder).where(
        FileFolder.parent_id == f.id))).scalar_one())
    files = int((await ctx.db.execute(select(func.count()).select_from(FileEntry).where(
        FileEntry.folder_id == f.id))).scalar_one())
    if kids or files:
        raise ApiError("folder_not_empty", "目录下仍有子目录或文件，不能彻底删除", 409,
                       {"folder_id": f.id, "children": kids, "files": files})
    await ctx.db.delete(f)
    await ctx.db.commit()
    return schemas.FolderPurgeOut(ok=True, purged_folders=1)


# ══════════ 仓库文件 ══════════
@service(
    perm="file:file:read", effect="read", name="file_list",
    description="仓库文件列表（目录/关键词/回收站；页码分页）",
    http={"method": "GET", "path": "/files", "tags": ["file"]},
)
async def file_list(payload: schemas.FileListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:file:read")
    assert ctx.db is not None
    stmt = select(FileEntry, FileBlob).join(FileBlob, FileBlob.id == FileEntry.blob_id).where(
        FileEntry.project_id == payload.project_id,
        FileEntry.status == (STATUS_RECYCLED if payload.recycled else STATUS_NORMAL))
    if payload.unfiled_only:
        stmt = stmt.where(FileEntry.folder_id.is_(None))
    elif payload.folder_id:
        stmt = stmt.where(FileEntry.folder_id == payload.folder_id)
    if payload.keyword:
        kw = "%" + payload.keyword.replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(FileEntry.name.like(kw) | FileEntry.description.like(kw))
    # D222：高级搜索条件组进同一个 WHERE（OR 组自带括号，吃不掉项目/目录/回收站谓词）。
    # 谓词写在 order_by 与 paginate_page 之前——total 与 items 吃同一份条件。
    stmt = stmt.where(FILE_LIST_FILTER.parse(payload.filter))
    stmt = stmt.order_by(FileEntry.created_at.desc(), FileEntry.id.desc())
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    rows = page.items
    names = await _user_names(ctx.db, {e.created_by for e, _ in rows})
    return Page(items=[_entry_out(e, b, names) for e, b in rows],
                next_cursor=None, total=page.total)


@service(
    perm="file:file:read", effect="read", name="file_get",
    description="仓库文件详情（元数据）",
    http={"method": "GET", "path": "/files/{file_id}", "tags": ["file"]},
)
async def file_get(payload: schemas.FileGetIn, ctx) -> schemas.FileEntryOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:file:read")
    assert ctx.db is not None
    e = await _entry(ctx.db, payload.project_id, payload.file_id)
    b = await _blob(ctx.db, payload.project_id, e.blob_id)
    names = await _user_names(ctx.db, {e.created_by})
    return _entry_out(e, b, names)


@service(
    perm="file:file:update", effect="write", name="file_update",
    description="更新仓库文件元数据（改名/描述/标签/移动目录）",
    http={"method": "PATCH", "path": "/files/{file_id}", "tags": ["file"]},
)
async def file_update(payload: schemas.FileUpdateIn, ctx) -> schemas.FileEntryOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:file:update")
    assert ctx.db is not None
    e = await _entry(ctx.db, payload.project_id, payload.file_id)
    folder_id = e.folder_id
    if payload.folder_set:
        folder_id = payload.folder_id
        if folder_id:
            await _folder(ctx.db, payload.project_id, folder_id)
    name = payload.name if payload.name is not None else e.name
    if (payload.name is not None and payload.name != e.name) or payload.folder_set:
        if await _name_taken(ctx.db, payload.project_id, folder_id, name, exclude=e.id):
            raise ApiError("conflict", "同目录下文件重名", 409, {"name": name})
    e.name, e.folder_id = name, folder_id
    if payload.description is not None:
        e.description = payload.description
    if payload.tags is not None:
        e.tags = _join_tags(payload.tags)
    e.updated_by = ctx.user_id
    await ctx.db.commit()
    b = await _blob(ctx.db, payload.project_id, e.blob_id)
    names = await _user_names(ctx.db, {e.created_by})
    return _entry_out(e, b, names)


@service(
    perm="file:file:delete", effect="destructive", name="file_delete",
    description="仓库文件放入回收站",
    http={"method": "POST", "path": "/files/{file_id}/delete", "tags": ["file"]},
)
async def file_delete(payload: schemas.FileGetIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:file:delete")
    assert ctx.db is not None
    e = await _entry(ctx.db, payload.project_id, payload.file_id)
    e.status = STATUS_RECYCLED
    e.updated_by = ctx.user_id
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="file:file:update", effect="write", name="file_restore",
    description="从回收站恢复仓库文件（同目录重名 → 409）",
    http={"method": "POST", "path": "/files/{file_id}/restore", "tags": ["file"]},
)
async def file_restore(payload: schemas.FileGetIn, ctx) -> schemas.FileEntryOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:file:update")
    assert ctx.db is not None
    e = await _entry(ctx.db, payload.project_id, payload.file_id, include_recycled=True)
    if e.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "文件不在回收站", 404, {"file_id": e.id})
    if await _name_taken(ctx.db, payload.project_id, e.folder_id, e.name, exclude=e.id):
        raise ApiError("conflict", "回收期间同目录出现了同名文件：先处理它再恢复", 409, {"name": e.name})
    e.status = STATUS_NORMAL
    e.updated_by = ctx.user_id
    await ctx.db.commit()
    b = await _blob(ctx.db, payload.project_id, e.blob_id)
    names = await _user_names(ctx.db, {e.created_by})
    return _entry_out(e, b, names)


@service(
    perm="file:file:delete", effect="destructive", name="file_purge",
    description="彻底删除回收站文件（逐字确认名称；零引用时删盘上字节）",
    http={"method": "POST", "path": "/files/{file_id}/purge", "tags": ["file"]},
    tool=False,
)
async def file_purge(payload: schemas.FilePurgeIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:file:delete")
    assert ctx.db is not None
    e = await _entry(ctx.db, payload.project_id, payload.file_id, include_recycled=True)
    if e.status != STATUS_RECYCLED:
        raise ApiError("not_recycled", "只能彻底删除回收站里的文件", 409, {"file_id": e.id})
    if payload.confirm_name != e.name:
        raise ApiError("name_mismatch", "确认名称与文件名不一致，未删除", 409, {"file_id": e.id})
    b = await _blob(ctx.db, payload.project_id, e.blob_id)
    await ctx.db.delete(e)
    await ctx.db.flush()
    await _gc_blob(ctx.db, b)
    await ctx.db.commit()
    return OkOut(ok=True)


# ══════════ 附件链接 ══════════
async def _validate_target(db, project_id: str, target_type: str, target_id: str) -> None:
    tbl = BUG if target_type == "bug" else FUNCTIONAL_CASE
    hit = (await db.execute(select(tbl.c.id).where(
        tbl.c.id == target_id, tbl.c.project_id == project_id))).first()
    if hit is None:
        raise ApiError("not_found", "附件目标不存在或不属于本项目", 404,
                       {"target_type": target_type, "target_id": target_id})


@service(
    perm="file:attachment:create", effect="write", name="file_attachment_link",
    description="把已有文件内容挂到缺陷/用例上（重复跳过；role=attachment|richtext）",
    http={"method": "POST", "path": "/attachments", "tags": ["file"], "status": 201},
)
async def file_attachment_link(payload: schemas.AttachmentLinkIn,
                               ctx) -> schemas.AttachmentLinkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:attachment:create")
    assert ctx.db is not None
    await _validate_target(ctx.db, payload.project_id, payload.target_type, payload.target_id)
    blob_ids = list(dict.fromkeys(payload.blob_ids))
    blobs = {b.id: b for b in (await ctx.db.execute(select(FileBlob).where(
        FileBlob.project_id == payload.project_id,
        FileBlob.id.in_(blob_ids)))).scalars().all()}
    missing = [b for b in blob_ids if b not in blobs]
    if missing:
        raise ApiError("unknown_blob", "有文件内容不存在或不属于本项目", 422, {"missing": missing})
    existing = set((await ctx.db.execute(select(FileLink.blob_id).where(
        FileLink.project_id == payload.project_id,
        FileLink.target_type == payload.target_type,
        FileLink.target_id == payload.target_id,
        FileLink.role == payload.role,
        FileLink.blob_id.in_(blob_ids)))).scalars().all())
    created = 0
    for bid in blob_ids:
        if bid in existing:
            continue
        ctx.db.add(FileLink(
            project_id=payload.project_id, target_type=payload.target_type,
            target_id=payload.target_id, blob_id=bid, role=payload.role,
            display_name=(payload.display_names or {}).get(bid) or blobs[bid].original_name,
            created_by=ctx.user_id, created_at=datetime.now(UTC)))
        created += 1
    await ctx.db.commit()
    return schemas.AttachmentLinkOut(created=created, skipped=len(payload.blob_ids) - created)


@service(
    perm="file:attachment:delete", effect="destructive", name="file_target_purge",
    description="内部服务：删除某缺陷/用例的全部附件链接并回收零引用 blob（宿主彻底删除时调用）",
    http=None, tool=False, dynamic_perm=True,
)
async def file_target_purge(payload: schemas.TargetPurgeIn, ctx) -> schemas.TargetPurgeOut:
    assert ctx.db is not None
    links = (await ctx.db.execute(select(FileLink).where(
        FileLink.project_id == payload.project_id,
        FileLink.target_type == payload.target_type,
        FileLink.target_id == payload.target_id))).scalars().all()
    for lnk in links:
        b = await _blob(ctx.db, payload.project_id, lnk.blob_id)
        await ctx.db.delete(lnk)
        await ctx.db.flush()
        await _gc_blob(ctx.db, b)
    return schemas.TargetPurgeOut(ok=True, removed_links=len(links))


@service(
    perm="file:attachment:read", effect="read", name="file_attachment_list",
    description="列出缺陷/用例的附件与富文本贴图",
    http={"method": "GET", "path": "/attachments", "tags": ["file"]},
)
async def file_attachment_list(payload: schemas.AttachmentListIn,
                               ctx) -> schemas.AttachmentListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:attachment:read")
    assert ctx.db is not None
    await _validate_target(ctx.db, payload.project_id, payload.target_type, payload.target_id)
    rows = (await ctx.db.execute(
        select(FileLink, FileBlob).join(FileBlob, FileBlob.id == FileLink.blob_id).where(
            FileLink.project_id == payload.project_id,
            FileLink.target_type == payload.target_type,
            FileLink.target_id == payload.target_id,
            FileLink.role == payload.role,
        ).order_by(FileLink.created_at, FileLink.id))).all()
    names = await _user_names(ctx.db, {lnk.created_by for lnk, _ in rows})
    return schemas.AttachmentListOut(items=[schemas.AttachmentOut(
        id=lnk.id, target_type=lnk.target_type, target_id=lnk.target_id, role=lnk.role,
        display_name=lnk.display_name, blob=_blob_out(b), created_by=lnk.created_by,
        created_by_name=names.get(lnk.created_by or ""),
        created_at=schemas.iso(lnk.created_at)) for lnk, b in rows])


@service(
    perm="file:attachment:delete", effect="destructive", name="file_attachment_delete",
    description="取消附件链接（零引用时删盘上字节）",
    http={"method": "POST", "path": "/attachments/{link_id}/delete", "tags": ["file"]},
)
async def file_attachment_delete(payload: schemas.AttachmentDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("file:attachment:delete")
    assert ctx.db is not None
    lnk = (await ctx.db.execute(select(FileLink).where(
        FileLink.id == payload.link_id,
        FileLink.project_id == payload.project_id))).scalar_one_or_none()
    if lnk is None:
        raise ApiError("not_found", "附件不存在", 404, {"link_id": payload.link_id})
    b = await _blob(ctx.db, payload.project_id, lnk.blob_id)
    await ctx.db.delete(lnk)
    await ctx.db.flush()
    await _gc_blob(ctx.db, b)
    await ctx.db.commit()
    return OkOut(ok=True)
