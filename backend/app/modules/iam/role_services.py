"""自定义角色服务面（§11.4.21 / D37）：从内置模板复制 + 权限菜单树裁剪 + 引用检测删除。

四条这里特有的口径：
- **内置角色不可改不可删**：改内置位会让 test_permission_matrix 那张 116 格的表失去意义
  （D37 假设 3）。内置 code 撞名 / PATCH / DELETE 一律显式 403 带原因，不静默忽略。
- **role_perm_tree 的数据源是 REGISTRY.perm_points() 的运行时投影**（两级：权限位前缀族
  做一级、完整权限位做二级）。绝不前端硬编码一棵树——硬编码 = 后端加了位、界面上永远
  选不到的第二道假门（§13 纪律 1）；本服务与 REGISTRY 逐字相等由测试钉死。
- **读类动作 perm 以 :read 结尾**（READONLY 的 glob 尺是 `*:read`，1D 踩过的坑）；
  delete 是 destructive + POST（notify_channel_delete 同款：破坏性动作不用裸 DELETE）。
- **删除被引用 → 409 带引用计数**：notify/service.py 渠道删除的 in_use 形状——count 全量、
  明细按 project:member:manage 可见性隐瞒（拦不拦由数据决定，缺权限的人不该绕开保护）。

作用域（D37 假设 1）：自定义角色是项目内资产，全部服务带 project_id 走 ensure_project_access；
内置四枚继续留在 BUILTIN_ROLES 常量（搬进表 = 重裁权限矩阵，另一笔账）。
裁剪口径按计划假设 4 的「先实现任意裁剪 + 任意勾选」——不改内置模板语义，
`_project_scoped` 的 -system:* 硬拒绝仍由解析出口统一补。
"""
from __future__ import annotations

import re
import secrets

from sqlalchemy import func, select

from app.core.errors import ApiError, OkOut, Page, paginate
from app.core.registry import REGISTRY
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.iam import schemas
from app.modules.iam.models import CustomRole, ProjectMember
from app.modules.iam.roles import BUILTIN_ROLES, role_by_code

# 引用明细最多列这几条（409 弹窗读得完；计数永远是全量）——notify/service.py 同款。
REF_DETAIL_CAP = 20

# code 是 project_member.role_code 的指向键，字符集收紧（防注入 LIKE/路径分隔符），
# 且不许长得像内置 code（内置族 = 全大写下划线）。
_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{1,62}$")


def _out(row: CustomRole) -> schemas.CustomRoleOut:
    return schemas.CustomRoleOut(code=row.code, project_id=row.project_id, name=row.name,
                                 perms=list(row.perms or []), template_code=row.template_code)


async def _role(db, project_id: str, code: str) -> CustomRole:
    row = (await db.execute(select(CustomRole).where(CustomRole.code == code))).scalar_one_or_none()
    # D148：不存在与跨项目逐字同体 403（此前不存在是 404——注释说不泄露存在性，
    # 状态码却在泄露）。与 agent 路由不存在 project_id ⇒ 403、非成员 403 同纪律。
    if row is None or row.project_id != project_id:
        raise ApiError("forbidden", "无此项目权限", 403)
    return row


async def _member_refs(db, code: str) -> tuple[int, list[dict[str, str]]]:
    """被哪些项目成员挂着（count 全量 + 明细前 REF_DETAIL_CAP 条）。"""
    cnt = (await db.execute(
        select(func.count()).select_from(ProjectMember).where(ProjectMember.role_code == code)
    )).scalar_one()
    rows = (await db.execute(
        select(ProjectMember.id, ProjectMember.user_id)
        .where(ProjectMember.role_code == code).order_by(ProjectMember.id).limit(REF_DETAIL_CAP)
    )).all()
    return int(cnt), [{"member_id": r[0], "user_id": r[1]} for r in rows]


@service(
    perm="iam:role:read", effect="read", name="role_custom_list",
    description="列出自定义角色（项目内；内置四枚模板走 /role-templates 目录，不在此列）",
    http={"method": "GET", "path": "/custom-roles", "tags": ["iam"]},
    resident=False,
)
async def role_custom_list(payload: schemas.CustomRoleListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("iam:role:read")
    assert ctx.db is not None
    stmt = select(CustomRole).where(CustomRole.project_id == payload.project_id).order_by(CustomRole.code)
    page = await paginate(ctx.db, stmt, cursor_col=CustomRole.code, row_key=lambda r: r.code,
                          cursor=payload.cursor, size=payload.size)
    return Page(items=[_out(r) for r in page.items], next_cursor=page.next_cursor)


@service(
    perm="iam:role:create", effect="write", name="role_create",
    description="从内置模板复制创建自定义角色（perms 省略 = 模板位原样快照；"
                "传了 perms = 在权限菜单树上裁剪后的完整位集，任意裁剪任意勾选按计划假设 4）",
    http={"method": "POST", "path": "/custom-roles", "tags": ["iam"], "status": 201},
    tool=False, resident=False,
)
async def role_create(payload: schemas.RoleCreateIn, ctx) -> schemas.CustomRoleOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("iam:role:create")
    assert ctx.db is not None
    code = payload.code or "role_" + secrets.token_hex(8)
    # 撞内置名先于格式校验报 409：内置 code 全大写，正则会先以「格式不对」挡掉，
    # 但那是在告诉用户一个错误的原因——他撞的其实是权限矩阵的地基。
    if role_by_code(code) is not None:
        raise ApiError("conflict", "该 code 是内置角色，不可占用", 409, {"code": code})
    if not _CODE_RE.match(code):
        raise ApiError("validation_failed", "角色 code 只允许小写字母/数字/下划线且以字母开头", 422,
                       {"code": code})
    tpl = role_by_code(payload.template_code)
    if tpl is None:
        raise ApiError("not_found", "模板不存在（模板 = 内置四枚：SYSTEM_ADMIN/PROJECT_ADMIN/MEMBER/READONLY）",
                       404, {"template_code": payload.template_code})
    perms = list(tpl["perms"]) if payload.perms is None else _check_perms(payload.perms)
    dup = (await ctx.db.execute(select(CustomRole).where(
        CustomRole.project_id == payload.project_id, CustomRole.name == payload.name))).scalar_one_or_none()
    if dup is not None:
        raise ApiError("conflict", "本项目内该角色名已存在", 409, {"name": payload.name})
    row = CustomRole(code=code, project_id=payload.project_id, name=payload.name,
                     perms=perms, template_code=payload.template_code)
    ctx.db.add(row)
    await ctx.db.flush()
    await ctx.db.commit()
    return _out(row)


@service(
    perm="iam:role:update", effect="write", name="role_update",
    description="修改自定义角色（名称/权限位整体替换）。内置角色 403：内置位动了，"
                "权限矩阵那张 116 格表就失去意义（D37 假设 3）",
    http={"method": "PATCH", "path": "/custom-roles/{code}", "tags": ["iam"]},
    tool=False, resident=False,
)
async def role_update(payload: schemas.RoleUpdateIn, ctx) -> schemas.CustomRoleOut:
    assert ctx.db is not None
    # 内置 code 的 PATCH 也会命中这个端点（路径参数撞同一族）——先于成员门禁挡掉，
    # 让「内置不可改」的 403 原因说清楚，而不是先吃一个语焉不详的 forbidden。
    if role_by_code(payload.code) is not None:
        raise ApiError("forbidden", "内置角色不可修改（改内置位会让权限矩阵失去意义）", 403,
                       {"code": payload.code, "reason": "builtin"})
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("iam:role:update")
    row = await _role(ctx.db, payload.project_id, payload.code)
    if payload.name is not None and payload.name != row.name:
        dup = (await ctx.db.execute(select(CustomRole).where(
            CustomRole.project_id == row.project_id, CustomRole.name == payload.name,
            CustomRole.code != row.code))).scalars().first()
        if dup is not None:
            raise ApiError("conflict", "本项目内该角色名已存在", 409, {"name": payload.name})
        row.name = payload.name
    if payload.perms is not None:
        row.perms = _check_perms(payload.perms)
    await ctx.db.commit()
    return _out(row)


@service(
    perm="iam:role:delete", effect="destructive", name="role_delete",
    description="删除自定义角色（被任何项目成员引用时 409 带引用计数；内置角色 403）",
    http={"method": "POST", "path": "/custom-roles/{code}/delete", "tags": ["iam"]},
    tool=False, resident=False,
)
async def role_delete(payload: schemas.RoleDeleteIn, ctx) -> OkOut:
    assert ctx.db is not None
    if role_by_code(payload.code) is not None:
        raise ApiError("forbidden", "内置角色不可删除（四枚内置模板是权限矩阵的地基）", 403,
                       {"code": payload.code, "reason": "builtin"})
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("iam:role:delete")
    row = await _role(ctx.db, payload.project_id, payload.code)
    count, items = await _member_refs(ctx.db, row.code)
    if count:
        # notify_channel_delete 语义：count 照报（拦不拦由数据决定），明细按成员可见性隐瞒。
        from app.core.permissions import match_perm

        may_see = match_perm(ctx.perms, "project:member:manage")
        # details_truncated 与 details_hidden 分开（notify/service.py:164 口径）：
        # count 全量、明细被 REF_DETAIL_CAP 截到 20 条时，不告知截断前端会把 20 条当全量。
        raise ApiError("in_use", "该角色被 " + str(count) + " 名项目成员引用，先改挂其他角色再删", 409,
                       {"code": row.code, "count": count,
                        "members": items if may_see else [],
                        "details_hidden": not may_see,
                        "details_truncated": count > len(items)})
    await ctx.db.delete(row)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="iam:role:read", effect="read", name="role_perm_tree",
    description="两级权限菜单树：REGISTRY.perm_points() 的运行时投影（前缀族一级、完整权限位"
                "二级）+ 内置模板位快照。新增权限位自动出现——前端硬编码一棵树就是第二道假门",
    http={"method": "GET", "path": "/role-perm-tree", "tags": ["iam"]},
    resident=False,
)
async def role_perm_tree(payload: schemas.RolePermTreeIn, ctx) -> schemas.RolePermTreeOut:
    # 带 project_id 走项目作用域：READONLY（`*:read`）也命中 iam:role:read → 200；
    # 未认证/非成员在 build_ctx 的数据权限门就 403。树是**只读元数据**，
    # 裁剪的门禁在写侧（role_create/update 各自 require 写位）。
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("iam:role:read")
    points = sorted(REGISTRY.perm_points())
    families: dict[str, list[str]] = {}
    for p in points:
        families.setdefault(p.split(":")[0], []).append(p)
    nodes = [schemas.PermTreeNode(key=fam, title=fam, children=[
        schemas.PermTreeNode(key=perm, title=perm) for perm in sorted(perms)])
        for fam, perms in sorted(families.items())]
    # 内置模板同样来自运行时常量（前端不许猜内置位）
    tpls = [schemas.RoleTemplateOut(code=r["code"], name=r["name"], perms=list(r["perms"]))
            for r in BUILTIN_ROLES]
    return schemas.RolePermTreeOut(nodes=nodes, templates=tpls)


def _check_perms(perms: list[str]) -> list[str]:
    """形状校验：非空字符串、去重保序。位是否存在于注册表**不校验**——
    模式串（`*`、`api:*`、`-system:*`）是合法值，合法集由 glob 语义定义而不是位清单。"""
    out: list[str] = []
    seen: set[str] = set()
    for p in perms:
        if not isinstance(p, str) or not p.strip():
            raise ApiError("validation_failed", "权限位必须是非空字符串", 422, {"perms": perms})
        if p not in seen:
            seen.add(p)
            out.append(p)
    if not out:
        raise ApiError("validation_failed", "权限位集合不能为空（一个位都没有的角色没意义）", 422)
    return out
