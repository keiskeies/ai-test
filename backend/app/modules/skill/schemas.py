"""Skill schema（§11.4.25）：列表不带正文，查看单条时才拉 body。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class SkillOut(BaseModel):
    id: str
    name: str
    description: str
    source: str
    allowed_tools: list[str] = []
    enabled: bool
    synced_at: str | None = None


class SkillDetailOut(SkillOut):
    body: str


class SkillIdIn(BaseModel):
    skill_id: str


class SkillToggleIn(BaseModel):
    skill_id: str
    enabled: bool


class SkillSyncError(BaseModel):
    file: str
    error: str


class SkillSyncOut(BaseModel):
    added: list[str] = []
    updated: list[str] = []
    removed: list[str] = []
    unchanged: int = 0
    errors: list[SkillSyncError] = []
    scanned_dir: str


class SkillListIn(BaseModel):
    cursor: str | None = None
    size: int = Field(default=100, ge=1, le=200)


class SkillSyncIn(BaseModel):
    """同步无参数；service 装饰器要求 payload 是 Pydantic 模型，故留空壳。"""
