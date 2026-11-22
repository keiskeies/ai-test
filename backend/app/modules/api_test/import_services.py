"""1E T4 导入向导的服务面：预览（冲突比对）+ 提交（整批一事务）。

解析在 importers.py（纯函数）；这里只做「归一路径撞键 → 新增/冲突」的比对与落库。
权限走 api:def:create（导入就是建接口——计划明文：别造第四个权限位）；
覆盖走 update 语义 + 逐条 before/after diff 进审计（D26 的兜底）。
"""
from __future__ import annotations

from typing import Any

import httpx
from sqlalchemy import select

from app.core.errors import ApiError
from app.core.service import ServiceResult, ensure_project_access, service, write_audit
from app.modules.api_test import importers, schemas
from app.modules.api_test.models import ApiDefinition

_PARSERS = {
    "openapi3": importers.parse_openapi3,
    "swagger2": importers.parse_swagger2,
    "postman": importers.parse_postman,
}

# URL 来源（步骤① 的 URL 框）：R143 第四次踩坑预防——代理环境不许悄悄改写请求。
# 本处 trust_env=False 由 tests/test_r143_trust_env_scan.py 全后端扫描钉住（摘参即红，变异实测）。
_FETCH_TIMEOUT_S = 5.0
_FETCH_MAX_BYTES = 2 * 1024 * 1024


async def _fetch_url(url: str) -> str:
    if not url.startswith(("http://", "https://")):
        raise ApiError("validation_failed", "URL 只支持 http/https", 422, {"url": url})
    try:
        async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT_S, follow_redirects=False,
                                     trust_env=False) as client:
            async with client.stream("GET", url) as resp:
                if resp.status_code != 200:
                    raise ApiError("validation_failed", f"URL 拉取失败：HTTP {resp.status_code}", 422)
                chunks: list[bytes] = []
                size = 0
                async for chunk in resp.aiter_bytes():
                    size += len(chunk)
                    if size > _FETCH_MAX_BYTES:
                        raise ApiError("validation_failed", "URL 内容超过 2MB 上限", 422)
                    chunks.append(chunk)
    except httpx.HTTPError as e:
        raise ApiError("validation_failed", "URL 拉取失败：" + type(e).__name__, 422) from e
    return b"".join(chunks).decode("utf-8", errors="replace")


def _key(method: str, path: str) -> tuple[str, str]:
    """冲突比对键：method + 归一路径（`/order/:id` 与 `/order/{id}` 是同一个键）。"""
    return (method.upper(), importers.normalize_path(path))


@service(
    perm="api:def:create",
    effect="read",
    name="api_import_preview",
    description="导入向导步骤②：解析 OpenAPI3/Swagger2/Postman 并与现有接口做冲突比对"
                "（method+归一路径；解析错误进 errors 人话列表，不抛）",
    http={"method": "POST", "path": "/api-import-preview", "tags": ["api_test"], "status": 200},
    tool=False,
)
async def api_import_preview(payload: schemas.ImportPreviewIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:def:create")
    assert ctx.db is not None
    text = payload.text if payload.text is not None else await _fetch_url(payload.url or "")
    outcome = _PARSERS[payload.source](text)
    rows = (
        await ctx.db.execute(select(ApiDefinition).where(ApiDefinition.project_id == payload.project_id,
                                                          ApiDefinition.status != "recycled"))
    ).scalars().all()
    existing = {_key(d.method, d.path): d.id for d in rows}
    items: list[schemas.ImportPreviewItem] = []
    for it in outcome.items:
        did = existing.get(_key(it.method, it.path))
        items.append(schemas.ImportPreviewItem(
            name=it.name, method=it.method, path=it.path, request=it.request,
            source_ref=it.source_ref, exists=did is not None, definition_id=did,
        ))
    return schemas.ImportPreviewOut(
        new_count=sum(1 for i in items if not i.exists),
        conflict_count=sum(1 for i in items if i.exists),
        items=items, errors=outcome.errors,
    )


def _validate_request(raw: dict[str, Any]) -> dict[str, Any]:
    """§7.1 校验：不合法不在这抛，由调用方收成失败原因（回执「失败逐条原因」）。"""
    req = schemas.RequestObject.model_validate(raw)
    return req.model_dump(exclude_none=True)


@service(
    perm="api:def:create",
    effect="write",
    name="api_import_commit",
    description="导入向导步骤③：整批一事务落库（任一失败 = 不 commit，整批回滚）；"
                "冲突按逐条策略 跳过/覆盖（D26 无「新版本」），覆盖 diff 进审计",
    http={"method": "POST", "path": "/api-import-commit", "tags": ["api_test"], "status": 200},
    tool=False,
)
async def api_import_commit(payload: schemas.ImportCommitIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("api:def:create")
    assert ctx.db is not None
    rows = (
        await ctx.db.execute(select(ApiDefinition).where(ApiDefinition.project_id == payload.project_id))
    ).scalars().all()
    by_key = {_key(d.method, d.path): d for d in rows if d.status != "recycled"}
    by_id = {d.id: d for d in rows}
    name_taken = {d.name for d in rows}  # 唯一约束含回收站行，占名一并算

    failures: list[schemas.ImportFailure] = []
    planned: list[tuple[schemas.ImportCommitItem, ApiDefinition | None, bool]] = []  # (条目, 覆盖目标, 是否跳过)
    batch_names: set[str] = set()
    for item in payload.items:
        # skip 就是 skip——哪怕条目其实是新增也不建它：界面勾了「跳过」还落库 = 骗人
        if item.strategy == "skip":
            planned.append((item, None, True))
            continue
        target = by_id.get(item.definition_id) if item.definition_id else by_key.get(_key(item.method, item.path))
        try:
            req = _validate_request(item.request)
        except Exception as e:  # noqa: BLE001 —— 逐条人话原因，绝不 500
            failures.append(schemas.ImportFailure(name=item.name, reason="请求对象不合法：" + str(e)[:200]))
            continue
        if target is None and (item.name in name_taken or item.name in batch_names):
            failures.append(schemas.ImportFailure(name=item.name, reason="接口名已存在（导入批次内或库内重名）"))
            continue
        if target is None:
            batch_names.add(item.name)
        planned.append((item.model_copy(update={"request": req}), target, False))

    if failures:
        # 整批一事务：有任何失败 → 什么都不 commit（步骤③「回滚整批」的全部实现）。
        await ctx.db.rollback()
        return schemas.ImportCommitOut(
            ok=False, created=0, updated=0, skipped=0, failed=len(failures), failures=failures,
        )

    created = updated = skipped = 0
    produced: list[schemas.ProducedRef] = []
    try:
        for item, target, is_skip in planned:
            if is_skip:
                skipped += 1
                continue
            if target is None:
                new_def = ApiDefinition(project_id=payload.project_id, name=item.name,
                                        method=item.method.upper(), path=item.path, request=item.request,
                                        status="complete", owner_id=ctx.user_id, project_public=True)
                ctx.db.add(new_def)
                await ctx.db.flush()
                created += 1
                produced.append(schemas.ProducedRef(kind="api_definition", id=new_def.id, name=new_def.name,
                                                    link="/api/definition/" + new_def.id))
            else:
                before = {"request": target.request, "method": target.method, "path": target.path,
                          "version": target.version}
                target.request = item.request
                target.method = item.request["method"]
                target.path = item.path
                target.status = "complete"
                target.version += 1
                await ctx.db.flush()
                updated += 1
                # D26 兜底：覆盖 = last-write-wins，变更历史靠这条 diff（before/after）
                await write_audit(ctx.db, user_id=ctx.user_id, action="api_import_commit",
                                  target=payload.project_id, ok=True,
                                  diff={"overwrite": target.id, "name": target.name, "before": before,
                                        "after": {"request": target.request, "method": target.method,
                                                  "path": target.path, "version": target.version}})
                produced.append(schemas.ProducedRef(kind="api_definition", id=target.id, name=target.name,
                                                    link="/api/definition/" + target.id))
        await ctx.db.commit()  # 唯一的 commit 点：没走到这里 = 整批未落库
    except Exception as e:  # noqa: BLE001 —— 半途炸 = 整批回滚，现有接口一行不动
        await ctx.db.rollback()
        return schemas.ImportCommitOut(
            ok=False, created=0, updated=0, skipped=0, failed=1,
            failures=[schemas.ImportFailure(name="整批", reason="落库失败，整批已回滚：" + str(e)[:200])],
        )
    return schemas.ImportCommitOut(ok=True, created=created, updated=updated, skipped=skipped,
                                   failed=0, failures=[], produced=produced)
