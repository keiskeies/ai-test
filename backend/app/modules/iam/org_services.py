"""组织层服务（D269/D270 / 对齐 MS 的 Organization + OrganizationUserRole 基础面）。

口径（设计文档 §4.1 的单租户约束不破）：
- 组织是**管理与分组层**，不是租户边界。项目数据权限继续由 `project_member` 决定，
  本模块不改 `perms_for_user`，也不给组织成员任何项目数据访问。
- 组织角色只有两枚：`ORG_ADMIN`（管理本组织成员与项目归属）/ `ORG_MEMBER`（只读本组织）。
  系统管理员对所有组织等价于 ORG_ADMIN，并独占创建/删除组织。
- D270 用户组：ORG_MEMBER 可以被加进组织级用户组，按组携带的四个管理位
  （`ORG_GROUP_PERMS`）获得细分能力；能力取并集，ORG_ADMIN/系统管理员天然持全量。
- 读接口也用 POST：注册表的 GET 投影只认静态位（排除 org 管理员），
  而本模块的授权必须在体内按「是否为该组织成员/管理员/组权限」定，故 `dynamic_perm=True`。
"""
from __future__ import annotations

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import new_id
from app.core.errors import ApiError
from app.core.service import service
from app.modules.iam import org_schemas as schemas
from app.modules.iam.models import (
    DEFAULT_ORG_CODE,
    ORG_GROUP_PERMS,
    ORG_ROLES,
    Org,
    OrgMember,
    OrgUserGroup,
    OrgUserGroupMember,
    Project,
    User,
)


def _forbidden() -> ApiError:
    """不存在与不可见同一响应：组织 id 不该成为探测面。"""
    return ApiError("forbidden", "无此组织权限", 403)


def _out(org: Org, member_count: int, project_count: int, my_role: str | None,
         my_perms: list[str] | None = None) -> schemas.OrgOut:
    return schemas.OrgOut(
        id=org.id, name=org.name, code=org.code, description=org.description,
        status=org.status, member_count=member_count, project_count=project_count,
        my_role=my_role, my_perms=my_perms or [], created_at=org.created_at,
    )


def _counts():
    member_count = (
        select(func.count(OrgMember.id)).where(OrgMember.org_id == Org.id)
        .correlate(Org).scalar_subquery()
    )
    project_count = (
        select(func.count(Project.id)).where(Project.organization_id == Org.id)
        .correlate(Org).scalar_subquery()
    )
    return member_count, project_count


async def _org(db: AsyncSession, org_id: str) -> Org:
    row = (await db.execute(select(Org).where(Org.id == org_id))).scalar_one_or_none()
    if row is None:
        raise _forbidden()
    return row


async def _member(db: AsyncSession, org_id: str, user_id: str) -> OrgMember | None:
    return (
        await db.execute(
            select(OrgMember).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id)
        )
    ).scalar_one_or_none()


async def _group(db: AsyncSession, group_id: str) -> OrgUserGroup:
    row = (await db.execute(
        select(OrgUserGroup).where(OrgUserGroup.id == group_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "用户组不存在", 404)
    return row


async def _require_read(db: AsyncSession, ctx, org_id: str) -> tuple[Org, str]:
    """系统管理员或任意组织成员可读。返回 (org, my_role)。"""
    org = await _org(db, org_id)
    if ctx.is_system_admin:
        return org, "SYSTEM_ADMIN"
    m = await _member(db, org_id, ctx.user_id)
    if m is None:
        raise _forbidden()
    return org, m.role_code


async def _group_caps(db: AsyncSession, org_id: str, user_id: str) -> list[str]:
    """某人在某组织里由用户组获得的组织管理位（并集），按 ORG_GROUP_PERMS 的稳定顺序返回。"""
    rows = (await db.execute(
        select(OrgUserGroup.perms)
        .join(OrgUserGroupMember, OrgUserGroupMember.group_id == OrgUserGroup.id)
        .where(OrgUserGroup.org_id == org_id, OrgUserGroupMember.user_id == user_id)
    )).scalars().all()
    got: set[str] = set()
    for perms in rows:
        got.update(p for p in (perms or []) if p in ORG_GROUP_PERMS)
    return [p for p in ORG_GROUP_PERMS if p in got]


async def _my_group_caps(db: AsyncSession, user_id: str) -> dict[str, list[str]]:
    """一次取全「我在各组织由用户组获得的能力」，供 org_list 逐行投影。"""
    rows = (await db.execute(
        select(OrgUserGroup.org_id, OrgUserGroup.perms)
        .join(OrgUserGroupMember, OrgUserGroupMember.group_id == OrgUserGroup.id)
        .where(OrgUserGroupMember.user_id == user_id)
    )).all()
    acc: dict[str, set[str]] = {}
    for org_id, perms in rows:
        acc.setdefault(org_id, set()).update(p for p in (perms or []) if p in ORG_GROUP_PERMS)
    return {k: [p for p in ORG_GROUP_PERMS if p in v] for k, v in acc.items()}


async def _role_of(db: AsyncSession, ctx, org_id: str) -> str | None:
    """调用者在组织里的角色（系统管理员投影为 SYSTEM_ADMIN；非成员 None）。"""
    if ctx.is_system_admin:
        return "SYSTEM_ADMIN"
    m = await _member(db, org_id, ctx.user_id)
    return m.role_code if m is not None else None


async def _caps(db: AsyncSession, ctx, org_id: str) -> list[str]:
    """我在某组织实际持有的组织管理位（界面投影用；写路径另有 _require_cap 复核）。"""
    if ctx.is_system_admin:
        return list(ORG_GROUP_PERMS)
    m = await _member(db, org_id, ctx.user_id)
    if m is None:
        return []
    if m.role_code == "ORG_ADMIN":
        return list(ORG_GROUP_PERMS)
    return await _group_caps(db, org_id, ctx.user_id)


async def _require_cap(db: AsyncSession, ctx, org_id: str, cap: str) -> Org:
    """系统管理员、该组织 ORG_ADMIN，或持有该管理位的用户组成员才能做。

    `cap` 必须取自 `ORG_GROUP_PERMS`（测试钉死与 schema 的 OrgCap 一致）。
    """
    org = await _org(db, org_id)
    if ctx.is_system_admin:
        return org
    m = await _member(db, org_id, ctx.user_id)
    if m is None:
        raise _forbidden()
    if m.role_code == "ORG_ADMIN":
        return org
    if cap in await _group_caps(db, org_id, ctx.user_id):
        return org
    raise _forbidden()


# 兼容 D269 的调用名：ORG_ADMIN 级别的动作现在都落到具体管理位上。
async def _require_admin(db: AsyncSession, ctx, org_id: str,
                         cap: str = "system:org:member:manage") -> Org:
    return await _require_cap(db, ctx, org_id, cap)


async def _org_counts(db: AsyncSession, org_id: str) -> tuple[int, int]:
    mc = (await db.execute(
        select(func.count(OrgMember.id)).where(OrgMember.org_id == org_id))).scalar_one()
    pc = (await db.execute(
        select(func.count(Project.id)).where(Project.organization_id == org_id))).scalar_one()
    return int(mc), int(pc)


async def _admin_count(db: AsyncSession, org_id: str) -> int:
    n = (await db.execute(
        select(func.count(OrgMember.id)).where(
            OrgMember.org_id == org_id, OrgMember.role_code == "ORG_ADMIN"))).scalar_one()
    return int(n)


# 注册表要求 perm 是 module:action 形状；`system` 族已在权限矩阵的已知前缀里。
@service(
    perm="system:org:read", effect="read", name="org_list",
    description="列出组织（系统管理员看全部；组织成员只看自己所在的组织）",
    http={"method": "POST", "path": "/system/orgs/query", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_list(payload: schemas.OrgListIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    member_count, project_count = _counts()
    q = payload.q.strip()
    if ctx.is_system_admin:
        stmt = select(Org, member_count, project_count)
        if q:
            stmt = stmt.where(Org.name.contains(q, autoescape=True) | Org.code.contains(q, autoescape=True))
        if payload.status:
            stmt = stmt.where(Org.status == payload.status)
        rows = (await db.execute(stmt.order_by(Org.created_at.desc(), Org.id.desc()))).all()
        items = [_out(o, int(mc), int(pc), "SYSTEM_ADMIN", list(ORG_GROUP_PERMS))
                 for o, mc, pc in rows]
    else:
        stmt = (
            select(Org, member_count, project_count, OrgMember.role_code)
            .join(OrgMember, OrgMember.org_id == Org.id)
            .where(OrgMember.user_id == ctx.user_id)
        )
        if q:
            stmt = stmt.where(Org.name.contains(q, autoescape=True) | Org.code.contains(q, autoescape=True))
        if payload.status:
            stmt = stmt.where(Org.status == payload.status)
        rows = (await db.execute(stmt.order_by(Org.created_at.desc(), Org.id.desc()))).all()
        # D270：逐行投影「我在这个组织实际能做什么」——ORG_ADMIN 全量，普通成员取用户组并集。
        cap_map = await _my_group_caps(db, ctx.user_id)
        items = [
            _out(o, int(mc), int(pc), role,
                 list(ORG_GROUP_PERMS) if role == "ORG_ADMIN" else cap_map.get(o.id, []))
            for o, mc, pc, role in rows
        ]
    return {"items": [x.model_dump() for x in items]}


@service(
    perm="system:org:read", effect="read", name="org_get",
    description="组织详情（含成员数/项目数；系统管理员或该组织成员）",
    http={"method": "POST", "path": "/system/orgs/get", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_get(payload: schemas.OrgGetIn, ctx) -> dict:
    assert ctx.db is not None
    org, role = await _require_read(ctx.db, ctx, payload.org_id)
    mc, pc = await _org_counts(ctx.db, org.id)
    return _out(org, mc, pc, role, await _caps(ctx.db, ctx, org.id)).model_dump()


@service(
    perm="system:org:create", effect="write", name="org_create",
    description="创建组织（仅系统管理员；创建者自动成为该组织管理员）",
    http={"method": "POST", "path": "/system/orgs", "tags": ["system"], "status": 201},
    tool=False,
)
async def org_create(payload: schemas.OrgIn, ctx) -> dict:
    ctx.require("system:org:create")
    assert ctx.db is not None
    db = ctx.db
    dup_code = (await db.execute(select(Org.id).where(Org.code == payload.code))).scalar_one_or_none()
    if dup_code is not None:
        raise ApiError("conflict", "组织代码已存在", 409, {"code": payload.code})
    dup_name = (await db.execute(select(Org.id).where(Org.name == payload.name))).scalar_one_or_none()
    if dup_name is not None:
        raise ApiError("conflict", "组织名称已存在", 409, {"name": payload.name})
    org = Org(id=new_id(), name=payload.name, code=payload.code,
              description=payload.description, status="normal")
    db.add(org)
    db.add(OrgMember(org_id=org.id, user_id=ctx.user_id, role_code="ORG_ADMIN"))
    await db.commit()
    return _out(org, 1, 0, "SYSTEM_ADMIN", list(ORG_GROUP_PERMS)).model_dump()


@service(
    perm="system:org:update", effect="write", name="org_update",
    description="改组织名称/说明/状态（系统管理员或该组织管理员）",
    http={"method": "POST", "path": "/system/orgs/update", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_update(payload: schemas.OrgUpdateIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    org = await _require_cap(db, ctx, payload.org_id, "system:org:update")
    if payload.name is not None:
        dup = (await db.execute(select(Org.id).where(
            Org.name == payload.name, Org.id != org.id))).scalar_one_or_none()
        if dup is not None:
            raise ApiError("conflict", "组织名称已存在", 409, {"name": payload.name})
        org.name = payload.name
    if payload.description is not None:
        org.description = payload.description
    if payload.status is not None:
        org.status = payload.status
    await db.commit()
    mc, pc = await _org_counts(db, org.id)
    role = "SYSTEM_ADMIN" if ctx.is_system_admin else await _role_of(db, ctx, org.id)
    return _out(org, mc, pc, role, await _caps(db, ctx, org.id)).model_dump()


@service(
    perm="system:org:delete", effect="destructive", name="org_delete",
    description="删除组织（仅系统管理员；默认组织与仍有项目的组织不可删）",
    http={"method": "POST", "path": "/system/orgs/delete", "tags": ["system"]},
    tool=False,
)
async def org_delete(payload: schemas.OrgDeleteIn, ctx) -> dict:
    ctx.require("system:org:delete")
    assert ctx.db is not None
    db = ctx.db
    org = await _org(db, payload.org_id)
    if org.code == DEFAULT_ORG_CODE:
        raise ApiError("default_org", "默认组织不可删除", 409)
    mc, pc = await _org_counts(db, org.id)
    if pc > 0:
        raise ApiError("org_not_empty", "组织下仍有项目，先移出再删除", 409, {"project_count": pc})
    await db.execute(sa_delete(OrgMember).where(OrgMember.org_id == org.id))
    # D270：用户组是组织的附属数据，随组织一起清（组员行先删）。
    group_ids = (await db.execute(
        select(OrgUserGroup.id).where(OrgUserGroup.org_id == org.id))).scalars().all()
    if group_ids:
        await db.execute(sa_delete(OrgUserGroupMember).where(
            OrgUserGroupMember.group_id.in_(group_ids)))
        await db.execute(sa_delete(OrgUserGroup).where(OrgUserGroup.org_id == org.id))
    # D271：组织级缺陷状态流模板同样是组织附属数据；跨模块清行走只读表名（与 schedule
    # 读 scenario/environment 同款口径），不 import defect 模型。
    await db.execute(text("DELETE FROM org_defect_status_transition WHERE org_id = :o"),
                     {"o": org.id})
    await db.execute(text("DELETE FROM org_defect_status WHERE org_id = :o"), {"o": org.id})
    await db.delete(org)
    await db.commit()
    return {"ok": True}


@service(
    perm="system:org:read", effect="read", name="org_member_list",
    description="组织成员列表（系统管理员或该组织管理员）",
    http={"method": "POST", "path": "/system/orgs/members/query", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_member_list(payload: schemas.OrgMemberListIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    org = await _require_cap(db, ctx, payload.org_id, "system:org:member:manage")
    rows = (await db.execute(
        select(OrgMember, User.account, User.name)
        .join(User, User.id == OrgMember.user_id)
        .where(OrgMember.org_id == org.id)
        .order_by(OrgMember.created_at, OrgMember.id)
    )).all()
    return {"items": [schemas.OrgMemberOut(
        id=m.id, org_id=m.org_id, user_id=m.user_id, role_code=m.role_code,
        account=account, name=name).model_dump() for m, account, name in rows]}


@service(
    perm="system:org:member:manage", effect="write", name="org_member_set",
    description="添加/调整组织成员角色（系统管理员或该组织管理员）",
    http={"method": "POST", "path": "/system/orgs/members/set", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_member_set(payload: schemas.OrgMemberSetIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    org = await _require_cap(db, ctx, payload.org_id, "system:org:member:manage")
    target = (await db.execute(
        select(User).where(User.account == payload.account))).scalar_one_or_none()
    if target is None:
        raise ApiError("not_found", "用户不存在", 404, {"account": payload.account})
    if payload.role_code not in ORG_ROLES:
        raise ApiError("bad_request", "组织角色不合法", 400, {"role_code": payload.role_code})
    # 组委派的 member:manage 不能自升/升别人为 ORG_ADMIN（否则一条组权限就能拿到全量组织位）。
    if payload.role_code == "ORG_ADMIN" and not ctx.is_system_admin:
        if await _role_of(db, ctx, org.id) != "ORG_ADMIN":
            raise ApiError("forbidden", "只有组织管理员可以授予组织管理员", 403)
    m = await _member(db, org.id, target.id)
    if m is None:
        m = OrgMember(org_id=org.id, user_id=target.id, role_code=payload.role_code)
        db.add(m)
    else:
        if m.role_code == "ORG_ADMIN" and payload.role_code != "ORG_ADMIN":
            if await _admin_count(db, org.id) <= 1:
                raise ApiError("last_org_admin", "组织至少保留一名管理员", 409)
        m.role_code = payload.role_code
    await db.commit()
    return schemas.OrgMemberOut(
        id=m.id, org_id=m.org_id, user_id=m.user_id, role_code=m.role_code,
        account=target.account, name=target.name).model_dump()


@service(
    perm="system:org:member:manage", effect="destructive", name="org_member_remove",
    description="移出组织成员（系统管理员或该组织管理员；最后一名管理员不可移出）",
    http={"method": "POST", "path": "/system/orgs/members/remove", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_member_remove(payload: schemas.OrgMemberRemoveIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    org = await _require_cap(db, ctx, payload.org_id, "system:org:member:manage")
    m = await _member(db, org.id, payload.user_id)
    if m is None:
        raise ApiError("not_found", "该用户不是组织成员", 404)
    if m.role_code == "ORG_ADMIN" and not ctx.is_system_admin:
        if await _role_of(db, ctx, org.id) != "ORG_ADMIN":
            raise ApiError("forbidden", "只有组织管理员可以移出组织管理员", 403)
    if m.role_code == "ORG_ADMIN" and await _admin_count(db, org.id) <= 1:
        raise ApiError("last_org_admin", "组织至少保留一名管理员", 409)
    # 组织成员身份没了，用户组关系也必须跟着断（组不是第二套成员制）。
    group_ids = (await db.execute(
        select(OrgUserGroup.id).where(OrgUserGroup.org_id == org.id))).scalars().all()
    if group_ids:
        await db.execute(sa_delete(OrgUserGroupMember).where(
            OrgUserGroupMember.user_id == payload.user_id,
            OrgUserGroupMember.group_id.in_(group_ids)))
    await db.delete(m)
    await db.commit()
    return {"ok": True}


@service(
    perm="system:org:read", effect="read", name="org_project_list",
    description="组织下的项目列表（系统管理员或任意组织成员）",
    http={"method": "POST", "path": "/system/orgs/projects/query", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_project_list(payload: schemas.OrgProjectListIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    org, _role = await _require_read(db, ctx, payload.org_id)
    rows = (await db.execute(
        select(Project).where(Project.organization_id == org.id)
        .order_by(Project.created_at.desc(), Project.id.desc())
    )).scalars().all()
    return {"items": [schemas.OrgProjectOut(
        id=p.id, name=p.name, description=p.description, status=p.status).model_dump()
        for p in rows]}


@service(
    perm="system:org:project:manage", effect="write", name="org_project_assign",
    description="把项目归档到组织（系统管理员或该组织管理员；不改变项目成员与数据权限）",
    http={"method": "POST", "path": "/system/orgs/projects/assign", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_project_assign(payload: schemas.OrgProjectAssignIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    org = await _require_cap(db, ctx, payload.org_id, "system:org:project:manage")
    proj = (await db.execute(
        select(Project).where(Project.id == payload.target_project_id))).scalar_one_or_none()
    if proj is None:
        raise ApiError("not_found", "项目不存在", 404, {"project_id": payload.target_project_id})
    # 非系统管理员只能把「无主」或「本组织」的项目归档进来，不能从别的组织抢。
    if (proj.organization_id is not None and proj.organization_id != org.id
            and not ctx.is_system_admin):
        raise ApiError("project_in_other_org", "该项目属于其他组织，先由原组织移出", 409)
    proj.organization_id = org.id
    await db.commit()
    return schemas.OrgProjectOut(
        id=proj.id, name=proj.name, description=proj.description, status=proj.status).model_dump()


@service(
    perm="system:org:project:manage", effect="destructive", name="org_project_unassign",
    description="把项目移出组织（系统管理员或该组织管理员）",
    http={"method": "POST", "path": "/system/orgs/projects/remove", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_project_unassign(payload: schemas.OrgProjectAssignIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    org = await _require_cap(db, ctx, payload.org_id, "system:org:project:manage")
    proj = (await db.execute(
        select(Project).where(Project.id == payload.target_project_id))).scalar_one_or_none()
    if proj is None or proj.organization_id != org.id:
        raise ApiError("not_found", "项目不在该组织下", 404)
    proj.organization_id = None
    await db.commit()
    return {"ok": True}


@service(
    perm="auth:self", effect="read", name="org_mine",
    description="当前用户所在的组织（自助；不需要平台治理位）",
    http={"method": "POST", "path": "/my-orgs", "tags": ["iam"]},
    tool=False,
)
async def org_mine(payload: schemas.OrgMineIn, ctx) -> dict:
    ctx.require("auth:self")
    assert ctx.db is not None
    rows = (await ctx.db.execute(
        select(Org, OrgMember.role_code)
        .join(OrgMember, OrgMember.org_id == Org.id)
        .where(OrgMember.user_id == ctx.user_id)
        .order_by(Org.created_at.desc(), Org.id.desc())
    )).all()
    return {"items": [schemas.OrgMineOut(
        org_id=o.id, name=o.name, code=o.code, role_code=role).model_dump()
        for o, role in rows]}


@service(
    perm="system:org:read", effect="read", name="org_cap_check",
    description="核验「我在这个组织是否持有某管理位」（缺陷等模块的跨模块内部口）",
    http={"method": "POST", "path": "/system/orgs/cap-check", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_cap_check(payload: schemas.OrgCapCheckIn, ctx) -> dict:
    assert ctx.db is not None
    org = await _require_cap(ctx.db, ctx, payload.org_id, payload.cap)
    return schemas.OrgCapCheckOut(
        ok=True,
        role=await _role_of(ctx.db, ctx, org.id),
        perms=await _caps(ctx.db, ctx, org.id),
    ).model_dump()


# ── D270 组织级用户组 ────────────────────────────────────────────────────────
# 授权口径：组本身归 `system:org:group:manage` 管（系统管理员/ORG_ADMIN/持该位的组员）；
# 组能干什么由 `ORG_GROUP_PERMS` 四个位决定，已分别接到 org_update / org_member_* /
# org_project_* 的 _require_cap 上。


def _group_member_count():
    return (
        select(func.count(OrgUserGroupMember.id))
        .where(OrgUserGroupMember.group_id == OrgUserGroup.id)
        .correlate(OrgUserGroup).scalar_subquery()
    )


def _group_out(g: OrgUserGroup, member_count: int) -> schemas.OrgGroupOut:
    return schemas.OrgGroupOut(
        id=g.id, org_id=g.org_id, name=g.name, description=g.description,
        perms=[p for p in (g.perms or []) if p in ORG_GROUP_PERMS],
        member_count=member_count, created_at=g.created_at,
    )


async def _group_member(db: AsyncSession, group_id: str, user_id: str) -> OrgUserGroupMember | None:
    return (await db.execute(
        select(OrgUserGroupMember).where(
            OrgUserGroupMember.group_id == group_id,
            OrgUserGroupMember.user_id == user_id))).scalar_one_or_none()


@service(
    perm="system:org:group:read", effect="read", name="org_group_list",
    description="组织用户组列表（系统管理员、该组织管理员或持 group:manage 的组员）",
    http={"method": "POST", "path": "/system/orgs/groups/query", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_group_list(payload: schemas.OrgGroupListIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    org = await _require_cap(db, ctx, payload.org_id, "system:org:group:manage")
    cnt = _group_member_count()
    rows = (await db.execute(
        select(OrgUserGroup, cnt)
        .where(OrgUserGroup.org_id == org.id)
        .order_by(OrgUserGroup.created_at, OrgUserGroup.id)
    )).all()
    return {"items": [_group_out(g, int(n)).model_dump() for g, n in rows]}


@service(
    perm="system:org:group:manage", effect="write", name="org_group_create",
    description="新建组织用户组（系统管理员、该组织管理员或持 group:manage 的组员）",
    http={"method": "POST", "path": "/system/orgs/groups", "tags": ["system"], "status": 201},
    tool=False, dynamic_perm=True,
)
async def org_group_create(payload: schemas.OrgGroupIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    org = await _require_cap(db, ctx, payload.org_id, "system:org:group:manage")
    dup = (await db.execute(select(OrgUserGroup.id).where(
        OrgUserGroup.org_id == org.id, OrgUserGroup.name == payload.name))).scalar_one_or_none()
    if dup is not None:
        raise ApiError("conflict", "用户组名称已存在", 409, {"name": payload.name})
    g = OrgUserGroup(
        id=new_id(), org_id=org.id, name=payload.name, description=payload.description,
        perms=list(dict.fromkeys(payload.perms)), created_by=ctx.user_id,
    )
    db.add(g)
    await db.commit()
    return _group_out(g, 0).model_dump()


@service(
    perm="system:org:group:manage", effect="write", name="org_group_update",
    description="改用户组名称/说明/管理位（组管理位不扩大项目数据权限）",
    http={"method": "POST", "path": "/system/orgs/groups/update", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_group_update(payload: schemas.OrgGroupUpdateIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    g = await _group(db, payload.group_id)
    await _require_cap(db, ctx, g.org_id, "system:org:group:manage")
    if payload.name is not None:
        dup = (await db.execute(select(OrgUserGroup.id).where(
            OrgUserGroup.org_id == g.org_id, OrgUserGroup.name == payload.name,
            OrgUserGroup.id != g.id))).scalar_one_or_none()
        if dup is not None:
            raise ApiError("conflict", "用户组名称已存在", 409, {"name": payload.name})
        g.name = payload.name
    if payload.description is not None:
        g.description = payload.description
    if payload.perms is not None:
        g.perms = list(dict.fromkeys(payload.perms))
    await db.commit()
    n = (await db.execute(select(func.count(OrgUserGroupMember.id)).where(
        OrgUserGroupMember.group_id == g.id))).scalar_one()
    return _group_out(g, int(n)).model_dump()


@service(
    perm="system:org:group:manage", effect="destructive", name="org_group_delete",
    description="删除用户组（组员关系随组清理；不改组织成员身份）",
    http={"method": "POST", "path": "/system/orgs/groups/delete", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_group_delete(payload: schemas.OrgGroupDeleteIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    g = await _group(db, payload.group_id)
    await _require_cap(db, ctx, g.org_id, "system:org:group:manage")
    await db.execute(sa_delete(OrgUserGroupMember).where(
        OrgUserGroupMember.group_id == g.id))
    await db.delete(g)
    await db.commit()
    return {"ok": True}


@service(
    perm="system:org:group:read", effect="read", name="org_group_member_list",
    description="用户组成员列表（组管理位持有者）",
    http={"method": "POST", "path": "/system/orgs/groups/members/query", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_group_member_list(payload: schemas.OrgGroupMemberListIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    g = await _group(db, payload.group_id)
    await _require_cap(db, ctx, g.org_id, "system:org:group:manage")
    rows = (await db.execute(
        select(OrgUserGroupMember, User.account, User.name)
        .join(User, User.id == OrgUserGroupMember.user_id)
        .where(OrgUserGroupMember.group_id == g.id)
        .order_by(OrgUserGroupMember.created_at, OrgUserGroupMember.id)
    )).all()
    return {"items": [schemas.OrgGroupMemberOut(
        id=m.id, group_id=m.group_id, user_id=m.user_id,
        account=account, name=name).model_dump() for m, account, name in rows]}


@service(
    perm="system:org:group:manage", effect="write", name="org_group_member_set",
    description="把组织成员加入用户组（必须是本组织成员；重复加入幂等）",
    http={"method": "POST", "path": "/system/orgs/groups/members/set", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_group_member_set(payload: schemas.OrgGroupMemberSetIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    g = await _group(db, payload.group_id)
    await _require_cap(db, ctx, g.org_id, "system:org:group:manage")
    target = (await db.execute(
        select(User).where(User.account == payload.account))).scalar_one_or_none()
    if target is None:
        raise ApiError("not_found", "用户不存在", 404, {"account": payload.account})
    om = await _member(db, g.org_id, target.id)
    if om is None:
        raise ApiError("not_org_member", "请先把该用户加入组织，再放入用户组", 409,
                       {"account": payload.account})
    m = await _group_member(db, g.id, target.id)
    if m is None:
        m = OrgUserGroupMember(group_id=g.id, user_id=target.id)
        db.add(m)
        await db.commit()
    return schemas.OrgGroupMemberOut(
        id=m.id, group_id=m.group_id, user_id=m.user_id,
        account=target.account, name=target.name).model_dump()


@service(
    perm="system:org:group:manage", effect="destructive", name="org_group_member_remove",
    description="把用户移出用户组（保留其组织成员身份）",
    http={"method": "POST", "path": "/system/orgs/groups/members/remove", "tags": ["system"]},
    tool=False, dynamic_perm=True,
)
async def org_group_member_remove(payload: schemas.OrgGroupMemberRemoveIn, ctx) -> dict:
    assert ctx.db is not None
    db = ctx.db
    g = await _group(db, payload.group_id)
    await _require_cap(db, ctx, g.org_id, "system:org:group:manage")
    m = await _group_member(db, g.id, payload.user_id)
    if m is None:
        raise ApiError("not_found", "该用户不在用户组里", 404)
    await db.delete(m)
    await db.commit()
    return {"ok": True}
