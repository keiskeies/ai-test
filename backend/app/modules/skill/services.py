"""Skill 管理（§9.8/§11.4.25）：同步 backend/skills 目录、列表、查看、启停。

治理位 skill:manage 仅系统管理员（§9.8 治理线）。同步是「显式动作」：页面点
[同步 skills 目录] 才扫描，不在启动时偷偷写库——运维 git pull 后自己决定何时生效。
解析失败只报告该文件，不碰库里同名行；只有「目录/文件真的消失了」才删行。
"""

from __future__ import annotations

import hashlib
import os
import re
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from app.core.errors import ApiError, Page
from app.core.service import service
from app.modules.skill import schemas
from app.modules.skill.models import Skill

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_MAX_BODY = 200_000


def skills_dir() -> Path:
    raw = os.environ.get("TP_SKILLS_DIR", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    # app/modules/skill/services.py → backend/skills
    return Path(__file__).resolve().parents[3] / "skills"


class ParsedSkill:
    __slots__ = ("name", "description", "allowed_tools", "body")

    def __init__(self, name: str, description: str, allowed_tools: list[str], body: str) -> None:
        self.name = name
        self.description = description
        self.allowed_tools = allowed_tools
        self.body = body


def parse_skill(text: str, dir_name: str) -> ParsedSkill:
    """frontmatter 只认 name/description/allowed-tools 三个键（其余忽略，向前兼容）。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("缺少 frontmatter（第一行必须是 ---）")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration as e:
        raise ValueError("frontmatter 没有闭合的 ---") from e
    meta: dict[str, str] = {}
    for line in lines[1:end]:
        s = line.strip()
        if not s or s.startswith("#") or ":" not in s:
            continue
        k, v = s.split(":", 1)
        meta[k.strip().lower()] = v.strip().strip('"').strip("'")
    name = (meta.get("name") or dir_name).strip()
    if name != dir_name:
        raise ValueError(f"frontmatter name（{name}）必须与目录名（{dir_name}）一致")
    if not _NAME_RE.match(name):
        raise ValueError("name 只允许小写字母/数字/下划线/连字符，且以字母或数字开头（≤64）")
    desc = (meta.get("description") or "").strip()
    if not desc:
        raise ValueError("description 必填（它决定 Agent 何时读取这个 Skill）")
    if len(desc) > 500:
        raise ValueError("description 超过 500 字")
    allowed = [x for x in re.split(r"[,\s]+", meta.get("allowed-tools", "")) if x]
    if len(allowed) > 50 or any(len(x) > 100 for x in allowed):
        raise ValueError("allowed-tools 超过 50 项或单项超过 100 字")
    body = "\n".join(lines[end + 1:]).strip()
    if not body:
        raise ValueError("正文为空")
    if len(body) > _MAX_BODY:
        raise ValueError("正文超过 200KB")
    return ParsedSkill(name, desc, allowed, body)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _out(s: Skill) -> schemas.SkillOut:
    return schemas.SkillOut(
        id=s.id, name=s.name, description=s.description, source=s.source,
        allowed_tools=[str(x) for x in (s.allowed_tools or [])],
        enabled=s.enabled, synced_at=_iso(s.synced_at),
    )


async def _get(db, skill_id: str) -> Skill:
    row = (await db.execute(select(Skill).where(Skill.id == skill_id))).scalar_one_or_none()
    if row is None:
        raise ApiError("not_found", "Skill 不存在", 404, {"skill_id": skill_id})
    return row


@service(
    perm="skill:manage", effect="read", name="skill_list",
    description="列出已登记的 Skills（含来源/启用状态/allowed-tools；不含正文）",
    http={"method": "GET", "path": "/skills", "tags": ["skill"], "status": 200},
    tool=False, resident=False,
)
async def skill_list(payload: schemas.SkillListIn, ctx) -> Page:
    ctx.require("skill:manage")
    assert ctx.db is not None
    rows = (await ctx.db.execute(select(Skill).order_by(Skill.name))).scalars().all()
    return Page(items=[_out(s) for s in rows], next_cursor=None)


@service(
    perm="skill:manage", effect="write", name="skill_sync",
    description="扫描 skills 目录并同步到库：报告新增/变更/移除与解析错误",
    http={"method": "POST", "path": "/skills/sync", "tags": ["skill"], "status": 200},
    tool=False, resident=False,
)
async def skill_sync(_payload: schemas.SkillSyncIn, ctx) -> schemas.SkillSyncOut:
    ctx.require("skill:manage")
    assert ctx.db is not None
    root = skills_dir()
    if not root.is_dir():
        raise ApiError("skills_dir_missing", "skills 目录不存在", 400, {"dir": str(root)})

    parsed: dict[str, tuple[Path, str, ParsedSkill]] = {}
    errors: list[schemas.SkillSyncError] = []
    present: set[str] = set()
    for child in sorted(root.iterdir(), key=lambda p: p.name):
        if not child.is_dir():
            continue
        md = child / "SKILL.md"
        if not md.is_file():
            continue
        present.add(str(md.resolve()))
        try:
            text = md.read_text(encoding="utf-8")
            parsed[child.name] = (md.resolve(), hashlib.sha256(text.encode("utf-8")).hexdigest(),
                                  parse_skill(text, child.name))
        except (OSError, ValueError) as e:  # noqa: PERF203 逐文件报错，继续扫下一个
            errors.append(schemas.SkillSyncError(file=str(md), error=str(e)))

    rows = (await ctx.db.execute(select(Skill))).scalars().all()
    by_name = {r.name: r for r in rows}
    now = datetime.now(UTC)
    added: list[str] = []
    updated: list[str] = []
    unchanged = 0
    for name, (path, checksum, p) in parsed.items():
        row = by_name.get(name)
        if row is None:
            ctx.db.add(Skill(name=p.name, description=p.description, source="builtin",
                             dir_path=str(path), body=p.body, allowed_tools=p.allowed_tools,
                             checksum=checksum, enabled=True, synced_at=now))
            added.append(name)
            continue
        if row.checksum == checksum and row.dir_path == str(path):
            unchanged += 1
            continue
        # 内容变更不动 enabled：管理员停用某个 skill 的意图不该被一次同步覆盖
        row.description = p.description
        row.dir_path = str(path)
        row.body = p.body
        row.allowed_tools = p.allowed_tools
        row.checksum = checksum
        row.source = "builtin"
        row.synced_at = now
        updated.append(name)

    removed: list[str] = []
    for row in rows:
        if row.source != "builtin" or row.dir_path in present:
            continue
        # 解析失败的文件仍在 present 里，绝不会走到这里——报错不等于删行
        removed.append(row.name)
        await ctx.db.delete(row)
    await ctx.db.commit()
    return schemas.SkillSyncOut(added=sorted(added), updated=sorted(updated),
                                removed=sorted(removed), unchanged=unchanged,
                                errors=errors, scanned_dir=str(root))


@service(
    perm="skill:manage", effect="read", name="skill_get",
    description="读取 Skill 全文（管理页 Markdown 渲染；Agent 的 read_skill 走同一份 body）",
    http={"method": "GET", "path": "/skills/{skill_id}", "tags": ["skill"], "status": 200},
    tool=False, resident=False,
)
async def skill_get(payload: schemas.SkillIdIn, ctx) -> schemas.SkillDetailOut:
    ctx.require("skill:manage")
    assert ctx.db is not None
    row = await _get(ctx.db, payload.skill_id)
    return schemas.SkillDetailOut(**_out(row).model_dump(), body=row.body)


@service(
    perm="skill:manage", effect="write", name="skill_toggle",
    description="启用/停用 Skill；停用后不进系统提示清单，read_skill 也拒绝读取",
    http={"method": "POST", "path": "/skills/{skill_id}/toggle", "tags": ["skill"], "status": 200},
    tool=False, resident=False,
)
async def skill_toggle(payload: schemas.SkillToggleIn, ctx) -> schemas.SkillOut:
    ctx.require("skill:manage")
    assert ctx.db is not None
    row = await _get(ctx.db, payload.skill_id)
    row.enabled = payload.enabled
    await ctx.db.commit()
    return _out(row)
