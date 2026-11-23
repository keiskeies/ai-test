"""用户管理 + 自助改密 + 角色目录（1A §4.1；权限体系外的自助动作见 ledger R30）。"""
from __future__ import annotations

from pydantic import BaseModel
from sqlalchemy import select

from app.core.errors import ApiError, OkOut, Page, paginate
from app.core.security import hash_password, verify_password
from app.core.service import ServiceResult, service
from app.modules.iam import schemas, user_importers
from app.modules.iam.models import User
from app.shared.filter_registry import FieldDecl, ListViewFilter, register

# D244：平台用户页高级搜索（D47-a 三件套铺到本页）。白名单只收页面上看得见的
# 标量列：账号 / 姓名 / 邮箱 / 类型（是否平台管理员）/ 状态 / 创建时间。
# - `password_hash` 是凭据材料，连「按哈希子串筛」的入口都不该存在（等于给口令
#   哈希一个可探测的比对面）；`prefs` 是用户偏好 JSON；`id` 是定位键。
# - 平台用户表没有 project_id，filter-meta 的 project_id 只做作用域校验，
#   不参与数据过滤——各项目看到的平台用户集合相同是设计。
USER_LIST_FILTER = ListViewFilter(
    view_type="user",
    label="平台用户",
    fields={
        "account": FieldDecl(User.account, "text", "账号", nullable=False),
        "name": FieldDecl(User.name, "text", "姓名", nullable=False),
        "email": FieldDecl(User.email, "text", "邮箱"),
        "is_system_admin": FieldDecl(User.is_system_admin, "bool", "平台管理员", nullable=False),
        "status": FieldDecl(User.status, "enum", "状态", nullable=False),
        "created_at": FieldDecl(User.created_at, "time", "创建时间", nullable=False),
    },
)
register(USER_LIST_FILTER)


def _out(u: User) -> schemas.UserOut:
    return schemas.UserOut.model_validate(u)


async def _get_user(db, user_id: str) -> User:
    u = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if u is None:
        raise ApiError("not_found", "用户不存在", 404, {"user_id": user_id})
    return u


@service(
    perm="system:user:read", effect="read", name="user_list",
    description="分页列出平台用户（仅系统管理员可见）",
    http={"method": "GET", "path": "/system/users", "tags": ["system"]},
    resident=False,
)
async def user_list(payload: schemas.UserListIn, ctx) -> ServiceResult:
    ctx.require("system:user:read")
    assert ctx.db is not None
    stmt = select(User).order_by(User.id)
    # D244：条件进 SQL，在游标分页之前；空条件 = 没传。
    stmt = stmt.where(USER_LIST_FILTER.parse(payload.filter))
    page = await paginate(ctx.db, stmt, cursor_col=User.id, row_key=lambda r: r.id,
                          cursor=payload.cursor, size=payload.size)
    return Page(items=[_out(u) for u in page.items], next_cursor=page.next_cursor)


@service(
    perm="system:user:create", effect="write", name="user_create",
    description="创建平台用户（仅系统管理员；密码只存哈希）",
    http={"method": "POST", "path": "/system/users", "tags": ["system"], "status": 201},
    resident=False,
)
async def user_create(payload: schemas.UserCreateIn, ctx) -> schemas.UserOut:
    ctx.require("system:user:create")
    assert ctx.db is not None
    dup = (await ctx.db.execute(select(User).where(User.account == payload.account))).scalar_one_or_none()
    if dup is not None:
        raise ApiError("conflict", "账号已存在", 409, {"account": payload.account})
    u = User(account=payload.account, name=payload.name, email=payload.email,
             password_hash=hash_password(payload.password),
             is_system_admin=payload.is_system_admin, status="active")
    ctx.db.add(u)
    await ctx.db.commit()
    return _out(u)


@service(
    perm="system:user:update", effect="write", name="user_update",
    description="修改用户资料或重置密码（仅系统管理员；审计不落密码）",
    http={"method": "PATCH", "path": "/system/users/{user_id}", "tags": ["system"]},
    resident=False,
)
async def user_update(payload: schemas.UserUpdateIn, ctx) -> schemas.UserOut:
    ctx.require("system:user:update")
    assert ctx.db is not None
    u = await _get_user(ctx.db, payload.user_id)
    if payload.name is not None:
        u.name = payload.name
    if payload.email is not None:
        u.email = payload.email
    if payload.password is not None:
        u.password_hash = hash_password(payload.password)
    await ctx.db.commit()
    return _out(u)


@service(
    perm="system:user:disable", effect="write", name="user_status",
    description="启用/禁用平台用户（禁用即刻生效：登录拒绝且旧 token 失效）",
    http={"method": "POST", "path": "/system/users/{user_id}/status", "tags": ["system"]},
    resident=False,
)
async def user_status(payload: schemas.UserStatusIn, ctx) -> schemas.UserOut:
    ctx.require("system:user:disable")
    assert ctx.db is not None
    if payload.user_id == ctx.user_id:
        raise ApiError("invalid_input", "不能禁用自己的账号", 400)
    u = await _get_user(ctx.db, payload.user_id)
    if payload.status == "disabled" and u.is_system_admin:
        # 最后一个可用系统管理员保护：禁用唯一的管理员 = 全平台失去管理入口
        others = (await ctx.db.execute(
            select(User.id).where(User.is_system_admin.is_(True), User.status == "active", User.id != u.id)
        )).scalars().all()
        if not others:
            raise ApiError("invalid_input", "这是最后一个可用的系统管理员", 400)
    u.status = payload.status
    await ctx.db.commit()
    return _out(u)


@service(
    perm="auth:password:self", effect="write", name="password_change_self",
    description="修改自己的登录密码（任何认证用户；需提供旧密码）",
    http={"method": "POST", "path": "/auth/password", "tags": ["auth"]},
    resident=False,  # R30：自助改密不进 agent 工具——会话被劫持时这是攻击面，零收益
)
async def password_change_self(payload: schemas.PasswordChangeIn, ctx) -> OkOut:
    ctx.require("auth:password:self")
    assert ctx.db is not None
    u = await _get_user(ctx.db, ctx.user_id)
    if not verify_password(payload.old_password, u.password_hash):
        raise ApiError("bad_credentials", "旧密码不正确", 403)
    u.password_hash = hash_password(payload.new_password)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="auth:self", effect="read", name="role_template_list",
    description="列出内置角色模板（成员管理下拉数据源；任何认证用户可见）",
    http={"method": "GET", "path": "/role-templates", "tags": ["iam"]},
    resident=False,
)
async def role_template_list(payload: schemas.RoleTemplateListIn, ctx) -> ServiceResult:
    from app.modules.iam.roles import BUILTIN_ROLES

    items = [schemas.RoleTemplateOut(code=r["code"], name=r["name"], perms=list(r["perms"]))
             for r in BUILTIN_ROLES]
    return Page(items=items, next_cursor=None)


@service(
    perm="system:user:create", effect="read", name="user_import_preview",
    description="D40 批量导入步骤①：解析粘贴的 CSV/TSV（账号/姓名/邮箱，制表符优先逗号兜底）"
                "并与现有账号做冲突比对；格式错误收成带行号的人话进 errors，不抛",
    http={"method": "POST", "path": "/system/users/import-preview", "tags": ["system"], "status": 200},
    tool=False,  # R30 同 user_create 的密码考量：导入面不进 agent 工具
    resident=False,
)
async def user_import_preview(payload: schemas.UserImportPreviewIn, ctx) -> schemas.UserImportPreviewOut:
    ctx.require("system:user:create")
    assert ctx.db is not None
    outcome = user_importers.parse_user_csv(payload.text)
    accounts = [r.account for r in outcome.rows]
    existed: set[str] = set()
    if accounts:
        rows = (await ctx.db.execute(select(User.account).where(User.account.in_(accounts)))).scalars().all()
        existed = set(rows)
    items = [schemas.UserImportPreviewItem(
        line=r.line, account=r.account, name=r.name, email=r.email, exists=r.account in existed,
    ) for r in outcome.rows]
    return schemas.UserImportPreviewOut(
        new_count=sum(1 for i in items if not i.exists),
        conflict_count=sum(1 for i in items if i.exists),
        items=items, errors=outcome.errors,
    )


@service(
    perm="system:user:create", effect="write", name="user_import_commit",
    description="D40 批量导入步骤②：逐行建用户（1E T4 口径的冲突逐条跳过 + 报告）——"
                "冲突/非法行逐条跳过并给「第几行为什么」，有效行照建；只有落库层故障才整批回滚。"
                "审计记产出行（复用 T4 的 produced 形状），绝不记初始密码",
    http={"method": "POST", "path": "/system/users/import-commit", "tags": ["system"], "status": 200},
    tool=False,
    resident=False,
)
async def user_import_commit(payload: schemas.UserImportCommitIn, ctx) -> schemas.UserImportCommitOut:
    ctx.require("system:user:create")
    assert ctx.db is not None
    existing = set((await ctx.db.execute(select(User.account))).scalars().all())

    failures: list[schemas.UserImportRowOutcome] = []
    skipped: list[schemas.UserImportRowOutcome] = []
    planned: list[schemas.UserImportCommitItem] = []
    batch_seen: set[str] = set()  # 库外新账号：预览与提交之间同批撞车也要逐条报，不许撞唯一约束 500
    for item in payload.items:
        # skip 就是 skip——哪怕这一行其实能建也不建：界面勾了「跳过」还落库 = 骗人（T4 原话）
        if item.strategy == "skip":
            why = ("账号已存在，跳过并保留现有用户" if item.account in existing
                   else "已勾选本次不导入（未改动任何数据）")
            skipped.append(schemas.UserImportRowOutcome(line=item.line, account=item.account, reason=why))
            continue
        reason = user_importers.row_problem(item.account, item.name, item.email)
        if reason is not None:
            failures.append(schemas.UserImportRowOutcome(line=item.line, account=item.account,
                                                         reason=reason + "，该行已跳过"))
            continue
        if item.account in existing or item.account in batch_seen:
            failures.append(schemas.UserImportRowOutcome(
                line=item.line, account=item.account,
                reason=f"账号「{item.account}」已存在（库内或本批更早行），该行已跳过"))
            continue
        batch_seen.add(item.account)
        planned.append(item)

    created = 0
    produced: list[dict[str, str]] = []
    try:
        for item in planned:
            u = User(account=item.account, name=item.name, email=item.email,
                     password_hash=hash_password(payload.initial_password),
                     is_system_admin=payload.is_system_admin, status="active")
            ctx.db.add(u)
            await ctx.db.flush()
            created += 1
            produced.append({"kind": "user", "id": u.id, "name": f"第 {item.line} 行 {u.account}"})
        await ctx.db.commit()  # 唯一的 commit 点：落库层炸了才走到下面的整批回滚
    except Exception as e:  # noqa: BLE001 —— 落库层故障（如唯一约束竞争）= 整批回滚，人话回报
        await ctx.db.rollback()
        return schemas.UserImportCommitOut(
            ok=False, created=0, skipped=len(skipped), failed=len(planned),
            failures=[schemas.UserImportRowOutcome(line=i.line, account=i.account,
                    reason="落库失败，整批已回滚，一个用户都没建：" + str(e)[:200]) for i in planned],
            skipped_detail=skipped,
        )
    # 产出行随回执带出（T4 的 produced 形状）：路由层的写入口全审计把它收进 diff——
    # 只含行号/账号/user_id，初始密码零踪迹（user_update 的「审计不落密码」同一条线）。
    return schemas.UserImportCommitOut(
        ok=True, created=created, skipped=len(skipped), failed=len(failures),
        failures=failures, skipped_detail=skipped, produced=produced,
    )


class RoleTemplateListIn(BaseModel):
    pass