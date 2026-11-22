"""私有资源可见性（§4.1 数据权限）：谓词 + 行级校验。

规则：项目管理员（持 *:delete，与角色模板一致）全见；其余成员只见
project_public 或 自己 owner 的行。不可见 = 与不存在同码 404 同文案（不泄露存在性）。
"""
from __future__ import annotations

from sqlalchemy import or_

from app.core.errors import ApiError


def _is_project_admin(ctx) -> bool:
    if ctx.is_system_admin:
        return True
    from app.core.permissions import match_perm

    return match_perm(ctx.perms, "api:*:delete") or match_perm(ctx.perms, "*:delete")


def visible_clause(model, ctx):
    """列表/计数用 SQL 谓词；管理员恒真。要求 model 具备 project_public + owner_id 两列。"""
    if _is_project_admin(ctx):
        return True
    return or_(model.project_public.is_(True), model.owner_id == ctx.user_id)


def assert_row_visible(row, ctx, *, what: str = "资源不存在") -> None:
    """行级校验：不可见 → 404（与不存在同码同文案，Review Focus 6）。"""
    if _is_project_admin(ctx):
        return
    if getattr(row, "project_public", True) or getattr(row, "owner_id", None) == ctx.user_id:
        return
    raise ApiError("not_found", what, 404)