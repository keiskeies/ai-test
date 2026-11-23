"""D205：功能用例 Excel 导入/导出/模板下载（multipart 与文件流走独立 router）。

同 filelib 的 R26 手法：契约 1 禁止 functional import iam，依赖由装配层注入；鉴权复用
`core.build_ctx`（含项目数据权限门）再 require 权限位。

写入口径：
- 导出 = 只读（functional:case:read），按「模块递归 + 关键字 + 优先级 + 高级搜索条件组 +
  我关注的 + 指定 id 集」筛选；与列表同一把尺（D235），筛选后导出不再「所见非所得」；
- 模板 = 只读（能看用例的人就能拿模板）；
- 导入 = functional:case:create，**全有或全无**：任何一行错 → 整批 422 带行号，零落库。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.core.service import build_ctx
from app.modules.functional import exchange
from app.modules.functional.models import (
    STATUS_NORMAL,
    STATUS_RECYCLED,
    FunctionalCase,
    FunctionalCaseCustomField,
    FunctionalCaseFollower,
    FunctionalModule,
)
from app.modules.functional.services import (
    FUNCTIONAL_CASE_LIST_FILTER,
    _load_custom_values,
    _next_num,
    _resolve_template,
)
from app.shared.custom_fields import CustomFieldError, dump_value, normalize_value

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _module_paths(rows) -> dict[str, str]:
    """id → 全路径（父/子）；父链断了（数据异常）就以能拼到的部分为准。"""
    by_id = {str(r.id): (r.parent_id, r.name) for r in rows}

    def path(mid: str) -> str:
        parts: list[str] = []
        seen: set[str] = set()
        cur: str | None = mid
        while cur and cur in by_id and cur not in seen:
            seen.add(cur)
            parent, name = by_id[cur]
            parts.append(str(name))
            cur = str(parent) if parent else None
        return "/".join(reversed(parts))

    return {mid: path(mid) for mid in by_id}


def _subtree(rows, root_id: str) -> set[str]:
    children: dict[str, list[str]] = {}
    for r in rows:
        if r.parent_id:
            children.setdefault(str(r.parent_id), []).append(str(r.id))
    out: set[str] = set()
    stack = [root_id]
    while stack:
        cur = stack.pop()
        if cur in out:
            continue
        out.add(cur)
        stack.extend(children.get(cur, []))
    return out


def _export_cell(field, v: Any) -> Any:
    if isinstance(v, bool):
        return "是" if v else "否"
    return exchange.export_option_cell(field, v)


def build_functional_router(*, get_db_dep: Any, get_user_dep: Any, user_model: Any) -> APIRouter:
    router = APIRouter(tags=["functional"])

    @router.get("/functional-cases/import-template")
    async def import_template(
        project_id: str = Query(...),
        template_id: str | None = Query(default=None),
        db: AsyncSession = Depends(get_db_dep),
        user: user_model = Depends(get_user_dep),
    ):
        ctx = await build_ctx(db, user, {"project_id": project_id}, entry="http")
        ctx.require("functional:case:read")
        tpl = await _resolve_template(ctx, project_id, template_id)
        return Response(
            content=exchange.template_bytes(tpl.fields),
            media_type=_XLSX,
            headers={"Content-Disposition": 'attachment; filename="functional-cases-template.xlsx"'},
        )

    @router.get("/functional-cases/export")
    async def export_cases(
        project_id: str = Query(...),
        module_id: str | None = Query(default=None),
        keyword: str | None = Query(default=None, max_length=100),
        priority: str | None = Query(default=None, pattern="^P[0-3]$"),
        template_id: str | None = Query(default=None),
        include_recycled: bool = Query(default=False),
        # D235：与列表同一把尺的三条轴（所见即所得导出）。
        filter: str | None = Query(default=None),
        followed_by_me: bool = Query(default=False),
        ids: str | None = Query(default=None, max_length=16000),
        db: AsyncSession = Depends(get_db_dep),
        user: user_model = Depends(get_user_dep),
    ):
        ctx = await build_ctx(db, user, {"project_id": project_id}, entry="http")
        ctx.require("functional:case:read")
        tpl = await _resolve_template(ctx, project_id, template_id)
        mods = (
            (await db.execute(select(FunctionalModule).where(FunctionalModule.project_id == project_id)))
            .scalars()
            .all()
        )
        allowed: set[str] | None = None
        if module_id:
            if module_id not in {str(m.id) for m in mods}:
                raise ApiError("not_found", "模块不存在", 404, {"module_id": module_id})
            allowed = _subtree(mods, module_id)
        stmt = select(FunctionalCase).where(FunctionalCase.project_id == project_id)
        if not include_recycled:
            stmt = stmt.where(FunctionalCase.status != STATUS_RECYCLED)
        if ids is not None:
            wanted = [i.strip() for i in ids.split(",") if i.strip()]
            if not wanted:
                raise ApiError("empty_ids", "ids 为空", 422, {})
            if len(wanted) > 500:
                raise ApiError("too_many_ids", "一次最多导出 500 条", 422, {"limit": 500})
            stmt = stmt.where(FunctionalCase.id.in_(wanted))
        if allowed is not None:
            stmt = stmt.where(FunctionalCase.module_id.in_(allowed))
        if keyword:
            stmt = stmt.where(FunctionalCase.name.like("%" + keyword + "%"))
        if priority:
            stmt = stmt.where(FunctionalCase.priority == priority)
        if followed_by_me:
            stmt = stmt.where(FunctionalCase.id.in_(select(FunctionalCaseFollower.case_id).where(
                FunctionalCaseFollower.user_id == ctx.user_id,
                FunctionalCaseFollower.project_id == project_id)))
        stmt = stmt.where(FUNCTIONAL_CASE_LIST_FILTER.parse(filter))
        cases = (await db.execute(stmt.order_by(FunctionalCase.num))).scalars().all()
        paths = _module_paths(mods)
        custom = await _load_custom_values(db, [c.id for c in cases])
        rows: list[list[Any]] = []
        for c in cases:
            vals = custom.get(c.id, {})
            rows.append(
                [
                    c.num,
                    c.name,
                    c.priority,
                    paths.get(c.module_id or "", "未分类"),
                    c.description or "",
                    *[_export_cell(f, vals.get(f.field_id)) for f in tpl.fields],
                ]
            )
        return Response(
            content=exchange.export_bytes(rows, tpl.fields),
            media_type=_XLSX,
            headers={"Content-Disposition": 'attachment; filename="functional-cases.xlsx"'},
        )

    @router.post("/functional-cases/import")
    async def import_cases(
        project_id: str = Form(...),
        module_id: str | None = Form(default=None),
        template_id: str | None = Form(default=None),
        file: UploadFile = File(...),
        db: AsyncSession = Depends(get_db_dep),
        user: user_model = Depends(get_user_dep),
    ):
        ctx = await build_ctx(db, user, {"project_id": project_id}, entry="http")
        ctx.require("functional:case:create")
        tpl = await _resolve_template(ctx, project_id, template_id)
        data = bytearray()
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > exchange.MAX_UPLOAD_BYTES:
                raise ApiError(
                    "file_too_large", "导入文件不能超过 10MB", 413, {"max_bytes": exchange.MAX_UPLOAD_BYTES}
                )
        if not data:
            raise ApiError("empty_file", "空文件不能导入", 422, {})
        try:
            rows = exchange.parse_workbook(bytes(data), tpl.fields)
        except exchange.ImportError_ as e:
            raise ApiError(
                "import_invalid", e.message, 422, {"errors": [{"row": e.row, "message": e.message}]}
            ) from e

        mods = (
            (await db.execute(select(FunctionalModule).where(FunctionalModule.project_id == project_id)))
            .scalars()
            .all()
        )
        paths = _module_paths(mods)
        path_to_id = {v.strip(): k for k, v in paths.items()}
        default_module = module_id or None
        if default_module is not None and default_module not in {str(m.id) for m in mods}:
            raise ApiError("not_found", "目标模块不存在", 404, {"module_id": default_module})

        errors: list[dict[str, Any]] = []
        prepared: list[dict[str, Any]] = []
        for row in rows:
            target = default_module
            if row["module_path"]:
                target = path_to_id.get(row["module_path"].strip())
                if target is None:
                    errors.append({"row": row["row"], "message": "模块路径不存在：" + row["module_path"]})
                    continue
            try:
                clean = _validate_row(tpl.fields, row["custom"])
            except ValueError as e:
                errors.append({"row": row["row"], "message": str(e)})
                continue
            prepared.append({**row, "module_id": target, "custom": clean})
        if errors:
            raise ApiError(
                "import_invalid",
                "导入校验未通过，共 " + str(len(errors)) + " 行有问题",
                422,
                {"errors": errors, "rows": len(rows)},
            )

        for row in prepared:
            num = await _next_num(ctx, project_id)
            case = FunctionalCase(
                project_id=project_id,
                num=num,
                name=row["name"],
                priority=row["priority"],
                module_id=row["module_id"],
                description=row["description"],
                template_id=tpl.template_id,
                status=STATUS_NORMAL,
                created_by=ctx.user_id,
                updated_by=ctx.user_id,
            )
            db.add(case)
            await db.flush()
            for fid, v in row["custom"].items():
                db.add(
                    FunctionalCaseCustomField(
                        case_id=case.id, field_id=fid, project_id=project_id, value=dump_value(v)
                    )
                )
        await db.commit()
        return {"created": len(prepared), "rows": len(rows)}

    return router


def _validate_row(fields: list, raw: dict[str, Any]) -> dict[str, Any]:
    """逐字段校验（复用 shared 的 normalize），错误压成一句人话（带字段名）。"""
    by_id = {f.field_id: f for f in fields}
    out: dict[str, Any] = {}
    missing: list[str] = []
    for f in fields:
        v = raw.get(f.field_id)
        if v is None or v == "" or v == []:
            if f.required:
                missing.append(f.name)
            continue
        spec = {
            "id": f.field_id,
            "name": f.name,
            "type": f.type,
            "options": [o.model_dump() for o in (f.options or [])],
        }
        try:
            out[f.field_id] = normalize_value(spec, v)
        except CustomFieldError as e:
            raise ValueError(str(e)) from e
    if missing:
        raise ValueError("必填自定义字段未填：" + "、".join(missing))
    return {k: v for k, v in out.items() if k in by_id}


__all__ = ["build_functional_router"]
