"""内置角色模板（§4.1）。匹配逻辑在 core.permissions（唯一真相）。"""
from __future__ import annotations

from app.core.permissions import match_perm

__all__ = ["BUILTIN_ROLES", "role_by_code", "match_perm", "ROLE_NAMES"]

BUILTIN_ROLES: list[dict] = [
    {"code": "SYSTEM_ADMIN", "name": "系统管理员", "perms": ["*"]},
    {"code": "PROJECT_ADMIN", "name": "项目管理员", "perms": ["*", "-system:*"]},
    # D102：`-*:delete/-*:manage` 两把 deny 罩不住 `agent:full:use`（尾词不在其列），
    # `*` 会让 MEMBER 默认拿到 FULL 模式——而 FULL 是唯一真能干活的档（PLAN 挡写、
    # ASK 无审批出口恒挂起），即写能力位。补一条域内 deny 收回，default-deny 的落点就在这。
    {"code": "MEMBER", "name": "测试工程师", "perms": ["*", "-*:delete", "-*:manage", "-system:*", "-agent:full:*"]},
    {"code": "READONLY", "name": "只读", "perms": ["*:read"]},
]

ROLE_NAMES = {r["code"]: r["name"] for r in BUILTIN_ROLES}


def role_by_code(code: str) -> dict | None:
    for r in BUILTIN_ROLES:
        if r["code"] == code:
            return r
    return None
