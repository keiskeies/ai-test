"""首次启动引导（§6.1）：系统管理员 + 内置角色模板；幂等。"""
from __future__ import annotations

import secrets
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import hash_password
from app.modules.iam.models import RoleTemplate, User
from app.modules.iam.roles import BUILTIN_ROLES


async def run_bootstrap(db: AsyncSession) -> dict:
    """幂等：已存在的账号/角色跳过；返回 {created_admin, printed_password}。"""
    s = get_settings()
    # 显式 Any：不写的话这里推断成 dict[str, bool|None]，下面塞 generated（str）
    # 就是一次「类型不符但没人拦」的赋值——返回值本来就是个混合袋（docstring 已言明）。
    result: dict[str, Any] = {"created_admin": False, "printed_password": None}

    # 1) 系统管理员
    account = s.bootstrap_account or "admin"
    exists = (await db.execute(select(User).where(User.account == account))).scalar_one_or_none()
    if exists is None:
        pw = s.bootstrap_password
        generated = None
        if not pw:
            pw = generated = "Tp@" + secrets.token_urlsafe(9)
        db.add(
            User(
                account=account,
                name="系统管理员",
                password_hash=hash_password(pw),
                is_system_admin=True,
                status="active",
            )
        )
        result["created_admin"] = True
        result["printed_password"] = generated
    # 2) 内置角色模板
    have = {r.code for r in (await db.execute(select(RoleTemplate))).scalars().all()}
    for r in BUILTIN_ROLES:
        if r["code"] not in have:
            db.add(RoleTemplate(code=r["code"], name=r["name"], perms=list(r["perms"]), builtin=True))
        else:
            row = (await db.execute(select(RoleTemplate).where(RoleTemplate.code == r["code"]))).scalar_one()
            row.perms = list(r["perms"])
            row.name = r["name"]
    await db.commit()
    return result
