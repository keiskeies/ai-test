"""把注册表里的权限点同步到 perm_point 表（bootstrap 时调用，幂等）。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.registry import REGISTRY
from app.modules.iam.models import PermPoint


async def sync_perm_points(db: AsyncSession) -> int:
    have = {r.code for r in (await db.execute(select(PermPoint))).scalars().all()}
    added = 0
    for code in sorted(REGISTRY.perm_points()):
        if code not in have:
            db.add(PermPoint(code=code, name=code, module=code.split(":")[0]))
            added += 1
    await db.commit()
    return added
