"""分享链接 @service（D202）：创建/列表/吊销 + 公开解析（供 routes.py）。"""
from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import column, select, table

from app.core.errors import ApiError, OkOut
from app.core.security import hash_password, verify_password
from app.core.service import ensure_project_access, service
from app.modules.share import schemas
from app.modules.share.models import ShareLink

RUN_RECORD = table(
    "run_record",
    column("id"), column("project_id"), column("subject_type"), column("subject_name"),
    column("status"), column("stats"), column("summary_graph"), column("started_at"),
    column("finished_at"), column("elapsed_ms"), column("error"),
)
PLAN_REPORT = table(
    "plan_report",
    column("id"), column("project_id"), column("plan_id"), column("name"), column("status"),
    column("total"), column("passed"), column("failed"), column("executed"), column("executing"),
    column("created_at"),
)
PLAN_REPORT_ITEM = table(
    "plan_report_item",
    column("id"), column("project_id"), column("report_id"), column("subject_type"),
    column("subject_id"), column("subject_name"), column("env_id"), column("executed"),
    column("executing"), column("result"),
)
API_DEF = table(
    "api_definition",
    column("id"), column("project_id"), column("name"), column("method"), column("path"),
    column("request"), column("status"), column("version"),
)


def _json_val(v: Any) -> Any:
    if isinstance(v, (str, bytes)):
        try:
            return json.loads(v)
        except (TypeError, ValueError):
            return v
    return v


def _iso(dt: Any) -> str | None:
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return schemas.iso(dt)
    return str(dt)


async def _target(db, project_id: str, target_type: str, target_id: str) -> tuple[str, Any]:
    """返回 (标题, 行)；目标不存在/跨项目同 404。"""
    tbl = {"report": RUN_RECORD, "plan_report": PLAN_REPORT, "api_doc": API_DEF}[target_type]
    row = (await db.execute(select(tbl).where(
        tbl.c.id == target_id, tbl.c.project_id == project_id))).first()
    if row is None:
        raise ApiError("not_found", "分享目标不存在", 404,
                       {"target_type": target_type, "target_id": target_id})
    title = row.subject_name if target_type == "report" else row.name
    return title, row


def _out(link: ShareLink) -> schemas.ShareOut:
    return schemas.ShareOut(
        id=link.id, token=link.token, share_path="/share/" + link.token,
        target_type=link.target_type, target_id=link.target_id, title=link.title,
        has_password=bool(link.password_hash), expires_at=schemas.iso(link.expires_at),
        revoked_at=schemas.iso(link.revoked_at), view_count=link.view_count,
        last_viewed_at=schemas.iso(link.last_viewed_at),
        created_at=schemas.iso(link.created_at))


@service(
    perm="share:link:create", effect="write", name="share_link_create",
    description="创建分享链接（报告/计划报告/接口文档；可选密码与过期）",
    http={"method": "POST", "path": "/share-links", "tags": ["share"], "status": 201},
)
async def share_link_create(payload: schemas.ShareCreateIn, ctx) -> schemas.ShareOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("share:link:create")
    assert ctx.db is not None
    title, _ = await _target(ctx.db, payload.project_id, payload.target_type, payload.target_id)
    if payload.expires_at is not None and payload.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC):
        raise ApiError("bad_expiry", "过期时间必须晚于现在", 422, {})
    link = ShareLink(
        project_id=payload.project_id, token=secrets.token_urlsafe(24),
        target_type=payload.target_type, target_id=payload.target_id,
        title=payload.title or title,
        password_hash=hash_password(payload.password) if payload.password else None,
        expires_at=payload.expires_at, view_count=0, created_by=ctx.user_id,
    )
    ctx.db.add(link)
    await ctx.db.commit()
    return _out(link)


@service(
    perm="share:link:read", effect="read", name="share_link_list",
    description="分享链接列表（可按目标过滤）",
    http={"method": "GET", "path": "/share-links", "tags": ["share"]},
)
async def share_link_list(payload: schemas.ShareListIn, ctx) -> schemas.ShareListOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("share:link:read")
    assert ctx.db is not None
    stmt = select(ShareLink).where(ShareLink.project_id == payload.project_id)
    if payload.target_type:
        stmt = stmt.where(ShareLink.target_type == payload.target_type)
    if payload.target_id:
        stmt = stmt.where(ShareLink.target_id == payload.target_id)
    rows = (await ctx.db.execute(stmt.order_by(ShareLink.created_at.desc()))).scalars().all()
    return schemas.ShareListOut(items=[_out(x) for x in rows])


@service(
    perm="share:link:read", effect="read", name="share_link_get",
    description="分享链接详情（元数据）",
    http={"method": "GET", "path": "/share-links/{share_id}", "tags": ["share"]},
)
async def share_link_get(payload: schemas.ShareGetIn, ctx) -> schemas.ShareOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("share:link:read")
    assert ctx.db is not None
    link = (await ctx.db.execute(select(ShareLink).where(
        ShareLink.id == payload.share_id,
        ShareLink.project_id == payload.project_id))).scalar_one_or_none()
    if link is None:
        raise ApiError("not_found", "分享链接不存在", 404, {"share_id": payload.share_id})
    return _out(link)


@service(
    perm="share:link:delete", effect="destructive", name="share_link_revoke",
    description="吊销分享链接（幂等）",
    http={"method": "POST", "path": "/share-links/{share_id}/revoke", "tags": ["share"]},
)
async def share_link_revoke(payload: schemas.ShareRevokeIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("share:link:delete")
    assert ctx.db is not None
    link = (await ctx.db.execute(select(ShareLink).where(
        ShareLink.id == payload.share_id,
        ShareLink.project_id == payload.project_id))).scalar_one_or_none()
    if link is None:
        raise ApiError("not_found", "分享链接不存在", 404, {"share_id": payload.share_id})
    if link.revoked_at is None:
        link.revoked_at = datetime.now(UTC)
        await ctx.db.commit()
    return OkOut(ok=True)


# ══════════ 公开解析 ══════════
async def resolve_share(db, token: str, password: str | None) -> dict[str, Any]:
    link = (await db.execute(select(ShareLink).where(ShareLink.token == token))).scalar_one_or_none()
    if link is None or link.revoked_at is not None:
        raise ApiError("not_found", "分享不存在或已失效", 404)
    if link.expires_at is not None and link.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC):
        raise ApiError("expired", "分享已过期", 410)
    if link.password_hash:
        if not password or not verify_password(password, link.password_hash):
            raise ApiError("password_required", "该分享需要访问密码", 401,
                           {"password_required": True})
    title, row = await _target(db, link.project_id, link.target_type, link.target_id)
    payload: dict[str, Any] = {"type": link.target_type, "title": title}
    if link.target_type == "report":
        payload["report"] = {
            "id": row.id, "subject_type": row.subject_type, "subject_name": row.subject_name,
            "status": row.status, "stats": _json_val(row.stats),
            "summary_graph": _json_val(row.summary_graph),
            "started_at": _iso(row.started_at), "finished_at": _iso(row.finished_at),
            "elapsed_ms": row.elapsed_ms, "error": row.error,
        }
    elif link.target_type == "plan_report":
        items = (await db.execute(select(PLAN_REPORT_ITEM).where(
            PLAN_REPORT_ITEM.c.report_id == row.id))).all()
        payload["report"] = {
            "id": row.id, "plan_id": row.plan_id, "name": row.name, "status": row.status,
            "total": row.total, "passed": row.passed, "failed": row.failed,
            "executed": row.executed, "executing": row.executing,
            "created_at": _iso(row.created_at),
            "items": [{
                "subject_type": x.subject_type, "subject_id": x.subject_id,
                "subject_name": x.subject_name, "env_id": x.env_id,
                "executed": x.executed, "executing": x.executing, "result": x.result,
            } for x in items],
        }
    else:
        payload["definition"] = {
            "id": row.id, "name": row.name, "method": row.method, "path": row.path,
            "request": _json_val(row.request), "status": row.status, "version": row.version,
        }
    link.view_count += 1
    link.last_viewed_at = datetime.now(UTC)
    await db.commit()
    return payload
