"""Agent API 依赖：HTTP 认证上下文（项目可见性由各端点 _load_session 把门）。"""
from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.service import ServiceCtx
from app.modules.iam.deps import get_current_user
from app.modules.iam.models import User

get_db_dep = get_db


async def get_agent_ctx(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)) -> ServiceCtx:
    return ServiceCtx(entry="http", user_id=user.id, user_name=user.name,
                      is_system_admin=bool(user.is_system_admin), perms=set(), db=db, session_id=None)
