"""项目 / 成员 / 角色服务 + 数据权限（§4.1、§10-2）。

约定：
- 非成员访问项目内资源 → 403 forbidden，且与"项目不存在"响应体完全一致（不泄露存在性）。
- 系统管理员可见全部项目（my_role=SYSTEM_ADMIN）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError, Page, paginate_desc
from app.core.service import ensure_project_access, service
from app.modules.iam import schemas
from app.modules.iam.models import CustomRole, Project, ProjectMember, RoleTemplate, User
from app.modules.iam.roles import BUILTIN_ROLES, match_perm, role_by_code

FORBIDDEN_BODY = {"code": "forbidden", "message": "无此项目权限", "details": {}}

# R30 的第二半：平台级与项目级互不渗漏。项目角色模板里的 `*:read` 这类后缀通配会顺手
# 盖住 system:user:read / system:audit:read，于是只读成员也能让 Pilot 列出全平台账号。
# 鉴权只认 pattern 集合（拒绝优先），所以在唯一的两处解析出口补一条显式拒绝；
# agent 工具面与 runner 的执行 ctx 同源，因此工具声明与实际执行一起被堵住。
PLATFORM_DENY = "-system:*"


def _project_scoped(perms: set[str]) -> set[str]:
    """非系统管理员的项目权限集合一律不含 system:*（内置模板与将来自定义角色都适用）。"""
    return perms | {PLATFORM_DENY}


def forbidden() -> ApiError:
    return ApiError("forbidden", "无此项目权限", 403)


async def list_roles(db: AsyncSession) -> list[schemas.RoleOut]:
    rows = (await db.execute(select(RoleTemplate))).scalars().all()
    if not rows:
        return [schemas.RoleOut(code=r["code"], name=r["name"], perms=list(r["perms"])) for r in BUILTIN_ROLES]
    return [schemas.RoleOut.model_validate(r) for r in rows]
    # D37 注：自定义角色**不**并进这个无项目上下文的 /roles 目录（会把别项目的角色名漏进
    # 下拉）。带 project_id 的作用域列表走 GET /custom-roles（role_services），
    # MembersTab 两个源合并渲染。


async def _raw_perms_of(db: AsyncSession, role_code: str) -> list[str] | None:
    """按 role_code 解析原始位集：内置常量 → 自定义角色表 → 内置快照表。None = 查无此角色。

    顺序即真相来源：内置四位永远以 BUILTIN_ROLES 常量为准（权限矩阵的地基，D37 假设 3），
    自定义角色是 0022 落的 custom_role 表。
    """
    builtin = role_by_code(role_code)
    if builtin is not None:
        return list(builtin["perms"])
    row = (await db.execute(select(CustomRole).where(CustomRole.code == role_code))).scalar_one_or_none()
    if row is not None:
        return list(row.perms or [])
    tpl = (await db.execute(select(RoleTemplate).where(RoleTemplate.code == role_code))).scalar_one_or_none()
    return list(tpl.perms or []) if tpl is not None else None


async def perms_for(db: AsyncSession, user: User, project_id: str | None) -> set[str]:
    """解析用户在某项目（None=系统级）下的权限点 pattern 集合。"""
    if user.is_system_admin:
        return {"*"}
    if project_id is None:
        return set()
    m = (
        await db.execute(select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == user.id))
    ).scalar_one_or_none()
    if m is None:
        return set()
    perms = await _raw_perms_of(db, m.role_code)
    if perms is None:
        return set()
    return _project_scoped(set(perms))


def require_perm(patterns: set[str], perm: str) -> None:
    if not match_perm(patterns, perm):
        # 与 ServiceCtx.require 同形状（details.perm = 缺的位名）：手写 iam 路由的
        # 权限拒绝全部汇到这里，位名字段同样只塞这一处。
        raise ApiError("insufficient_permission", "缺少权限：" + perm, 403, {"perm": perm})


async def ensure_member(db: AsyncSession, user: User, project_id: str) -> tuple[Project, str | None, set[str]]:
    """项目可见性=成员制；返回 (project, role_code, perms)。非成员/不存在 → 同一 403。"""
    proj = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if proj is None:
        raise forbidden()
    if user.is_system_admin:
        return proj, "SYSTEM_ADMIN", {"*"}
    m = (
        await db.execute(select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == user.id))
    ).scalar_one_or_none()
    if m is None:
        raise forbidden()
    perms = await perms_for(db, user, project_id)
    return proj, m.role_code, perms


async def create_project(db: AsyncSession, user: User, payload: schemas.ProjectIn) -> schemas.ProjectOut:
    dup = (await db.execute(select(Project).where(Project.name == payload.name))).scalar_one_or_none()
    if dup is not None:
        raise ApiError("conflict", "项目名称已存在", 409, {"name": payload.name})
    proj = Project(name=payload.name, description=payload.description, created_by=user.id)
    db.add(proj)
    await db.flush()
    db.add(ProjectMember(project_id=proj.id, user_id=user.id, role_code="PROJECT_ADMIN"))
    # session 是 autoflush=False，必须显式 flush 后 perms_for 才查得到刚 add 的成员行。
    # 解析放在 commit 之前：提交后再查会在池化连接上留下悬空的可重复读快照，
    # 后续请求看不到别处新提交的行（表现为偶发 404/401）。
    await db.flush()
    my_perms = sorted(await perms_for(db, user, proj.id))
    await db.commit()
    return schemas.ProjectOut(id=proj.id, name=proj.name, description=proj.description, status=proj.status,
                              my_role="PROJECT_ADMIN", my_perms=my_perms)


async def list_projects(db: AsyncSession, user: User, *, cursor: str | None, size: int) -> Page[schemas.ProjectOut]:
    cols = (Project.id, Project.name, Project.description, Project.status, Project.created_at)
    if user.is_system_admin:
        stmt = select(*cols)
    else:
        stmt = (select(*cols)
                .join(ProjectMember, ProjectMember.project_id == Project.id)
                .where(ProjectMember.user_id == user.id))
    # **最新在前**（created_at↓ + id↓）。原先按 UUID 主键升序：主键是 UUID 时升序毫无时间
    # 含义（paginate_desc 的 docstring 早写着这句），而工作台一次拉 size=200 且不翻页
    # （paginate 的 size 硬上限也是 200，前端加不动）。项目攒多之后新建的项目有相当概率落在
    # 那一页之外，用户就「建完项目却在列表里找不到它」。倒序后最新那页必然含最新项目。
    stmt = stmt.order_by(Project.created_at.desc(), Project.id.desc())
    page = await paginate_desc(
        db, stmt, key_cols=[Project.created_at, Project.id],
        row_key=lambda r: [r[4].isoformat(), r[0]],
        decode_key=lambda parts: [datetime.fromisoformat(str(parts[0])), str(parts[1])],
        cursor=cursor, size=size,
    )
    pat = await _patterns_map(db, user, [r[0] for r in page.items])
    out: list[schemas.ProjectOut] = []
    for rid, name, desc, status, _created in page.items:
        role = "SYSTEM_ADMIN" if user.is_system_admin else None
        if role is None:
            m = (
                await db.execute(
                    select(ProjectMember.role_code).where(ProjectMember.project_id == rid, ProjectMember.user_id == user.id)
                )
            ).scalar_one_or_none()
            role = m
        out.append(schemas.ProjectOut(id=rid, name=name, description=desc, status=status, my_role=role,
                               my_perms=pat.get(rid, [])))
    return Page(items=out, next_cursor=page.next_cursor)


async def get_project(db: AsyncSession, user: User, project_id: str) -> schemas.ProjectOut:
    proj, role, perms = await ensure_member(db, user, project_id)
    return schemas.ProjectOut(id=proj.id, name=proj.name, description=proj.description, status=proj.status, my_role=role,
                               my_perms=sorted(perms))


async def update_project(db: AsyncSession, user: User, project_id: str, payload: schemas.ProjectUpdateIn) -> schemas.ProjectOut:
    proj, _, perms = await ensure_member(db, user, project_id)
    require_perm(perms, "project:update")
    if payload.name is not None:
        proj.name = payload.name
    if payload.description is not None:
        proj.description = payload.description
    await db.commit()
    return schemas.ProjectOut(id=proj.id, name=proj.name, description=proj.description, status=proj.status,
                              my_role=role_of(perms), my_perms=sorted(perms))



async def _patterns_map(db: AsyncSession, user: User, ids: list[str]) -> dict[str, list[str]]:
    """项目列表的权限模式串：一次查询解析全部项目（避免每行再打一次角色表）。"""
    if user.is_system_admin:
        return {i: sorted({"*"}) for i in ids}
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(ProjectMember.project_id, ProjectMember.role_code, RoleTemplate.perms)
            .outerjoin(RoleTemplate, RoleTemplate.code == ProjectMember.role_code)
            .where(ProjectMember.user_id == user.id, ProjectMember.project_id.in_(ids))
        )
    ).all()
    out: dict[str, list[str]] = {}
    for pid, code, perms in rows:
        raw = perms if perms else (role_by_code(code) or {}).get("perms", [])
        out[pid] = sorted(_project_scoped(set(raw or [])))
    # D37：挂着自定义角色的行覆盖上面的内置解析（一次批量查，不做 N+1）。
    custom_codes = {code for _pid, code, perms in rows if not perms and role_by_code(code) is None}
    if custom_codes:
        crows = (
            await db.execute(select(CustomRole.code, CustomRole.perms).where(CustomRole.code.in_(custom_codes)))
        ).all()
        cmap = {c: list(p or []) for c, p in crows}
        for pid, code, _perms in rows:
            if code in cmap:
                out[pid] = sorted(_project_scoped(set(cmap[code])))
    return out

def role_of(perms: set[str]) -> str | None:
    return "PROJECT_ADMIN" if "*" in perms else None


async def list_members(db: AsyncSession, user: User, project_id: str) -> list[schemas.MemberOut]:
    await ensure_member(db, user, project_id)
    rows = (
        await db.execute(
            select(ProjectMember, User.account, User.name)
            .join(User, User.id == ProjectMember.user_id)
            .where(ProjectMember.project_id == project_id)
        )
    ).all()
    return [
        schemas.MemberOut(id=m.id, project_id=m.project_id, user_id=m.user_id, role_code=m.role_code, account=acc, name=nm)
        for m, acc, nm in rows
    ]



async def _require_another_admin(db: AsyncSession, project_id: str, except_user_id: str,
                           *, exempt_system_admin: bool = False) -> None:
    """项目里至少得留一名项目管理员，否则改角色/删成员/回收站全没人能操作。

    平台管理员豁免（exempt_system_admin）：他的权限是全局 *，卸掉项目角色也不会让
    项目失去管理者；若连他都被拦住，就变成「想退出必须先找人背锅」的死锁。
    普通成员没有这个豁免——否则最后一个管理员可以一键把项目变成孤儿。
    """
    if exempt_system_admin:
        is_sa = (
            await db.execute(select(User.is_system_admin).where(User.id == except_user_id))
        ).scalar_one_or_none()
        if is_sa:
            return
    others = (
        await db.execute(
            select(ProjectMember.id).where(
                ProjectMember.project_id == project_id,
                ProjectMember.role_code == "PROJECT_ADMIN",
                ProjectMember.user_id != except_user_id,
            ).limit(1)
        )
    ).scalar_one_or_none()
    if others is None:
        raise ApiError(
            "last_project_admin",
            "项目至少需要保留一名项目管理员：先把另一位成员提为项目管理员，再改这一步",
            409,
            {"project_id": project_id, "user_id": except_user_id},
        )

async def set_member(db: AsyncSession, user: User, project_id: str, member_user_id: str,
                     payload: schemas.MemberIn) -> schemas.MemberOut:
    _, _, perms = await ensure_member(db, user, project_id)
    require_perm(perms, "project:member:manage")
    if role_by_code(payload.role_code) is None:
        rows = (await db.execute(select(RoleTemplate.code))).scalars().all()
        custom_rows = (await db.execute(select(CustomRole.code).where(
            CustomRole.project_id == project_id))).scalars().all()
        if payload.role_code not in set(rows) | set(custom_rows):
            raise ApiError("not_found", "角色不存在", 404, {"role_code": payload.role_code})
    target = (await db.execute(select(User).where(User.id == member_user_id))).scalar_one_or_none()
    if target is None:
        raise ApiError("not_found", "用户不存在", 404, {"user_id": member_user_id})
    m = (
        await db.execute(
            select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == member_user_id)
        )
    ).scalar_one_or_none()
    if m is None:
        m = ProjectMember(project_id=project_id, user_id=member_user_id, role_code=payload.role_code)
        db.add(m)
    else:
        if m.role_code == "PROJECT_ADMIN" and payload.role_code != "PROJECT_ADMIN":
            await _require_another_admin(db, project_id, member_user_id, exempt_system_admin=True)
        m.role_code = payload.role_code
    await db.commit()
    return schemas.MemberOut(id=m.id, project_id=m.project_id, user_id=m.user_id, role_code=m.role_code,
                             account=target.account, name=target.name)


async def remove_member(db: AsyncSession, user: User, project_id: str, member_user_id: str) -> None:
    """移除成员需要 project:member:manage；本人退出项目不受限。"""
    _, _, perms = await ensure_member(db, user, project_id)
    if user.id != member_user_id:
        require_perm(perms, "project:member:manage")
    m = (
        await db.execute(
            select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == member_user_id)
        )
    ).scalar_one_or_none()
    if m is None:
        raise ApiError("not_found", "该用户不是项目成员", 404)
    if m.role_code == "PROJECT_ADMIN":
        await _require_another_admin(db, project_id, member_user_id, exempt_system_admin=True)
    await db.delete(m)
    await db.commit()


async def perms_for_user(db: AsyncSession, user_id: str, is_admin: bool, project_id: str) -> set[str] | None:
    """perms resolver 实现：不可见（不存在/非成员）→ None。"""
    if is_admin:
        return {"*"}
    proj = (await db.execute(select(Project.id).where(Project.id == project_id))).scalar_one_or_none()
    if proj is None:
        return None
    m = (
        await db.execute(select(ProjectMember).where(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id))
    ).scalar_one_or_none()
    if m is None:
        return None
    perms = await _raw_perms_of(db, m.role_code)
    return _project_scoped(set(perms or []))


@service(
    perm="project:member:manage",
    effect="read",
    name="project_member_candidates",
    description="按账号/姓名在项目范围内查找可添加为用户（返回 id/account/name/is_member，不含平台字段）",
    http={"method": "GET", "path": "/project-member-candidates", "tags": ["iam"]},
    resident=False,
)
async def project_member_candidates(payload: schemas.MemberCandidateIn, ctx) -> Page[schemas.MemberCandidateOut]:
    """添加成员需要 user_id，而 /system/users 属于 system:user:read（项目角色一律被 -system:* 拒）。

    没有这个口子，项目管理员在 UI 上根本拿不到 UUID，「添加成员」就是条死路。
    因此按项目授权、只回三列、结果有界：够加人，不够拖走全平台名单。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("project:member:manage")
    assert ctx.db is not None
    q = payload.q.strip()
    stmt = select(User.id, User.account, User.name)
    if q:
        # 转义 LIKE 通配符，用 ! 做 escape 字符（避开反斜杠在 MySQL/Python 里的双重转义歧义）
        esc = q.replace("!", "!!").replace("%", "!%").replace("_", "!_")
        stmt = stmt.where(User.account.like("%" + esc + "%", escape="!") | User.name.like("%" + esc + "%", escape="!"))
    stmt = stmt.order_by(User.account).limit(payload.size)
    rows = (await ctx.db.execute(stmt)).all()
    member_ids = set(
        (await ctx.db.execute(
            select(ProjectMember.user_id).where(ProjectMember.project_id == payload.project_id)
        )).scalars().all()
    )
    return Page(
        items=[schemas.MemberCandidateOut(id=r.id, account=r.account, name=r.name,
                                          is_member=r.id in member_ids) for r in rows],
        next_cursor=None,
    )
