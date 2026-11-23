"""D266：read_skill 元工具实现——原则 5「渐进披露」。

系统提示只带启用 Skill 的 name+description；模型判断相关时才读全文（body 落库，
不会因为工作区文件变动而答非所问）。frontmatter 的 allowed-tools 随结果返回，
runner 读到后把本轮后续工具集限缩到白名单（read_skill 自身保留）。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.core.errors import ApiError
from app.core.service import ServiceCtx
from app.modules.agent.metatools.spec import REAL_HANDLERS, ReadSkillIn
from app.modules.skill.models import Skill


async def read_skill(payload: ReadSkillIn, ctx: ServiceCtx) -> dict[str, Any]:
    assert ctx.db is not None
    row = (await ctx.db.execute(select(Skill).where(Skill.name == payload.name))).scalar_one_or_none()
    if row is None or not row.enabled:
        names = (await ctx.db.execute(
            select(Skill.name).where(Skill.enabled.is_(True)).order_by(Skill.name)
        )).scalars().all()
        hint = "、".join(names[:20]) or "无"
        raise ApiError("not_found", f"Skill 不存在或未启用；可用：{hint}", 404,
                       {"name": payload.name, "available": list(names)})
    return {
        "name": row.name,
        "description": row.description,
        "allowed_tools": [str(x) for x in (row.allowed_tools or [])],
        "content": row.body,
    }


def register_skill_handlers() -> None:
    REAL_HANDLERS.setdefault("read_skill", read_skill)


register_skill_handlers()
