"""个人中心 / API Key（D198）：自助资料、最近项目、我的资产、密钥签发/吊销。

个人面**不按项目角色门控**：任何登录用户都能管自己的资料与密钥；服务用 dynamic_perm
只做投影占位，鉴权边界是「只能操作 ctx.user_id 自己的行」。API Key 只存 sha256，
明文只在创建响应出现一次。
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime

from sqlalchemy import column, func, select, table, update

from app.core.errors import ApiError
from app.core.service import service
from app.modules.iam import personal_schemas as schemas
from app.modules.iam.models import Project, ProjectMember, User, UserApiKey

# 五张「资产」表用 owner_id，用例/缺陷用 created_by；统一投影成 owner 便于一次循环。
# 五张「资产」表用 owner_id，用例/缺陷用 created_by；值为 (反射表, 归属列名)。
ASSET_TABLES = {
    "api_definitions": (table("api_definition", column("project_id"), column("owner_id")), "owner_id"),
    "api_cases": (table("api_case", column("project_id"), column("owner_id")), "owner_id"),
    "scenarios": (table("scenario", column("project_id"), column("owner_id")), "owner_id"),
    "ui_cases": (table("ui_case", column("project_id"), column("owner_id")), "owner_id"),
    "adb_cases": (table("adb_case", column("project_id"), column("owner_id")), "owner_id"),
    "functional_cases": (table("functional_case", column("project_id"), column("created_by")), "created_by"),
    "defects": (table("defect", column("project_id"), column("created_by")), "created_by"),
}


def _hash_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def resolve_api_key(db, token: str) -> User | None:
    """Bearer `tp_...` → 用户；吊销/过期/账号停用一律 None（调用方统一 401）。"""
    row = (await db.execute(select(UserApiKey).where(
        UserApiKey.key_hash == _hash_key(token),
        UserApiKey.revoked_at.is_(None)))).scalar_one_or_none()
    if row is None:
        return None
    now = datetime.now(UTC)
    if row.expires_at is not None and row.expires_at.replace(tzinfo=UTC) <= now:
        return None
    user = (await db.execute(select(User).where(User.id == row.user_id))).scalar_one_or_none()
    if user is None or user.status != "active":
        return None
    await db.execute(update(UserApiKey).where(UserApiKey.id == row.id).values(last_used_at=now))
    await db.commit()
    return user


def _profile(user: User) -> schemas.ProfileOut:
    return schemas.ProfileOut(
        id=user.id, account=user.account, name=user.name, email=user.email,
        is_system_admin=user.is_system_admin, prefs=user.prefs or {},
        created_at=schemas.iso(user.created_at),
    )


def _key_out(k: UserApiKey) -> schemas.ApiKeyOut:
    return schemas.ApiKeyOut(
        id=k.id, name=k.name, prefix=k.prefix, created_at=schemas.iso(k.created_at),
        last_used_at=schemas.iso(k.last_used_at), expires_at=schemas.iso(k.expires_at),
        revoked_at=schemas.iso(k.revoked_at),
    )


@service(
    perm="auth:self", effect="read", name="personal_profile_get",
    description="个人资料（当前登录人）",
    http={"method": "GET", "path": "/personal/profile", "tags": ["personal"]},
    dynamic_perm=True, tool=False,
)
async def personal_profile_get(payload: schemas.ProfileGetIn, ctx) -> schemas.ProfileOut:
    assert ctx.db is not None
    user = await ctx.db.get(User, ctx.user_id)
    if user is None:
        raise ApiError("not_found", "用户不存在", 404)
    return _profile(user)


@service(
    perm="auth:self", effect="write", name="personal_profile_update",
    description="更新个人资料（名称/邮箱/prefs 合并）",
    http={"method": "PATCH", "path": "/personal/profile", "tags": ["personal"]},
    dynamic_perm=True, tool=False,
)
async def personal_profile_update(payload: schemas.ProfileUpdateIn, ctx) -> schemas.ProfileOut:
    assert ctx.db is not None
    user = await ctx.db.get(User, ctx.user_id)
    if user is None:
        raise ApiError("not_found", "用户不存在", 404)
    if payload.name is not None:
        user.name = payload.name
    if payload.email is not None:
        user.email = payload.email
    if payload.prefs is not None:
        user.prefs = {**(user.prefs or {}), **payload.prefs}
    await ctx.db.commit()
    return _profile(user)


@service(
    perm="auth:self", effect="read", name="personal_recent_projects",
    description="最近参与的项目（按项目更新时间倒序，最多 10 个）",
    http={"method": "GET", "path": "/personal/recent-projects", "tags": ["personal"]},
    dynamic_perm=True, tool=False,
)
async def personal_recent_projects(payload: schemas.ProfileGetIn,
                                   ctx) -> schemas.RecentProjectsOut:
    assert ctx.db is not None
    rows = (await ctx.db.execute(
        select(Project, ProjectMember.role_code)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(ProjectMember.user_id == ctx.user_id, Project.status == "normal")
        .order_by(Project.updated_at.desc())
        .limit(10))).all()
    return schemas.RecentProjectsOut(items=[schemas.RecentProjectOut(
        id=p.id, name=p.name, role_code=role,
        updated_at=schemas.iso(p.updated_at)) for p, role in rows])


@service(
    perm="auth:self", effect="read", name="personal_my_assets",
    description="我创建的资产计数（接口/接口用例/场景/UI/ADB/功能用例/缺陷）",
    http={"method": "GET", "path": "/personal/my-assets", "tags": ["personal"]},
    dynamic_perm=True, tool=False,
)
async def personal_my_assets(payload: schemas.MyAssetsIn, ctx) -> schemas.MyAssetsOut:
    assert ctx.db is not None
    pids = (await ctx.db.execute(select(ProjectMember.project_id).where(
        ProjectMember.user_id == ctx.user_id))).scalars().all()
    counts: dict[str, int] = {}
    for key, (tbl, owner_col) in ASSET_TABLES.items():
        if not pids:
            counts[key] = 0
            continue
        counts[key] = int((await ctx.db.execute(select(func.count()).select_from(tbl).where(
            getattr(tbl.c, owner_col) == ctx.user_id, tbl.c.project_id.in_(pids)))).scalar_one())
    return schemas.MyAssetsOut(counts=counts)


@service(
    perm="auth:self", effect="read", name="personal_api_key_list",
    description="我的 API Key（只回 prefix，不回明文/哈希）",
    http={"method": "GET", "path": "/personal/api-keys", "tags": ["personal"]},
    dynamic_perm=True, tool=False,
)
async def personal_api_key_list(payload: schemas.ApiKeyListIn,
                                ctx) -> schemas.ApiKeyListOut:
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(UserApiKey).where(
        UserApiKey.user_id == ctx.user_id).order_by(UserApiKey.created_at.desc()))).scalars().all()
    return schemas.ApiKeyListOut(items=[_key_out(k) for k in rows])


@service(
    perm="auth:self", effect="write", name="personal_api_key_create",
    description="签发 API Key（明文只返回一次；之后只存 sha256）",
    http={"method": "POST", "path": "/personal/api-keys", "tags": ["personal"], "status": 201},
    dynamic_perm=True, tool=False,
)
async def personal_api_key_create(payload: schemas.ApiKeyCreateIn,
                                  ctx) -> schemas.ApiKeyCreateOut:
    assert ctx.db is not None
    if payload.expires_at is not None and payload.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC):
        raise ApiError("bad_expiry", "过期时间必须晚于现在", 422, {})
    token = "tp_" + secrets.token_urlsafe(32)
    row = UserApiKey(
        user_id=ctx.user_id, name=payload.name, prefix=token[:12],
        key_hash=_hash_key(token), created_at=datetime.now(UTC),
        expires_at=payload.expires_at,
    )
    ctx.db.add(row)
    await ctx.db.commit()
    return schemas.ApiKeyCreateOut(**_key_out(row).model_dump(), key=token)


@service(
    perm="auth:self", effect="write", name="personal_api_key_revoke",
    description="吊销 API Key（幂等；只能吊销自己的）",
    http={"method": "POST", "path": "/personal/api-keys/{key_id}/revoke", "tags": ["personal"]},
    dynamic_perm=True, tool=False,
)
async def personal_api_key_revoke(payload: schemas.ApiKeyRevokeIn,
                                  ctx) -> schemas.ApiKeyRevokeOut:
    assert ctx.db is not None
    row = (await ctx.db.execute(select(UserApiKey).where(
        UserApiKey.id == payload.key_id, UserApiKey.user_id == ctx.user_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "API Key 不存在", 404, {"key_id": payload.key_id})
    if row.revoked_at is None:
        row.revoked_at = datetime.now(UTC)
        await ctx.db.commit()
    return schemas.ApiKeyRevokeOut(ok=True)
