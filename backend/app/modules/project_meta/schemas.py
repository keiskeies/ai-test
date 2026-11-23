"""project_meta schemas（D192）：模板 / 自定义字段 / 取号。"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.shared.custom_fields import FIELD_TYPES, SCENES

_SCENE_PATTERN = "^(" + "|".join(SCENES) + ")$"
_TYPE_PATTERN = "^(" + "|".join(FIELD_TYPES) + ")$"
_KEY_PATTERN = r"^[a-z][a-z0-9_]{0,63}$"


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class FieldOptionIn(BaseModel):
    value: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=255)
    sort: int = 0


class FieldOptionOut(BaseModel):
    value: str
    label: str
    sort: int = 0


class TemplateFieldIn(BaseModel):
    field_id: str
    required: bool = False
    sort: int = 0
    # 模板级默认值：native JSON（字符串/数组/数字）；服务层按字段类型校验后 JSON 落库。
    default_value: Any | None = None


class TemplateFieldOut(BaseModel):
    field_id: str
    name: str
    field_key: str
    type: str
    required: bool = False
    sort: int = 0
    default_value: Any | None = None
    options: list[FieldOptionOut] = []


class TemplateOut(BaseModel):
    id: str
    project_id: str
    scene: str
    name: str
    description: str | None = None
    internal: bool = False
    is_default: bool = False
    sort: int = 0
    field_count: int = 0
    created_at: str | None = None
    updated_at: str | None = None


class TemplateDetailOut(TemplateOut):
    fields: list[TemplateFieldOut] = []


class TemplateListOut(BaseModel):
    items: list[TemplateOut] = []


class TemplateListIn(BaseModel):
    project_id: str
    scene: str = Field(pattern=_SCENE_PATTERN)
    # D247：高级搜索条件（JSON 串，形状同 shared/filters.py）；空/缺省 = 不额外收窄。
    filter: str | None = None


class TemplateGetIn(BaseModel):
    project_id: str
    template_id: str


class TemplateCreateIn(BaseModel):
    project_id: str
    scene: str = Field(pattern=_SCENE_PATTERN)
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    sort: int = 0
    fields: list[TemplateFieldIn] = []


class TemplateUpdateIn(BaseModel):
    project_id: str
    template_id: str
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    sort: int | None = None
    # None = 不改字段；[] = 清空字段；非空 = 整体替换（顺序即 sort 缺省序）
    fields: list[TemplateFieldIn] | None = None


class TemplateDeleteIn(BaseModel):
    project_id: str
    template_id: str


class TemplateSetDefaultIn(BaseModel):
    project_id: str
    template_id: str


class TemplateEnableConfigOut(BaseModel):
    # 我们只有项目一级；值恒为 "project"（MS 的 organization 开关属三级组织模型）
    scenes: dict[str, str] = {}


class CustomFieldListIn(BaseModel):
    project_id: str
    scene: str = Field(pattern=_SCENE_PATTERN)
    # D247：高级搜索条件（JSON 串）；与 scene 取数轴并行 AND。
    filter: str | None = None


class CustomFieldGetIn(BaseModel):
    project_id: str
    field_id: str


class CustomFieldCreateIn(BaseModel):
    project_id: str
    scene: str = Field(pattern=_SCENE_PATTERN)
    name: str = Field(min_length=1, max_length=120)
    field_key: str = Field(pattern=_KEY_PATTERN)
    type: str = Field(pattern=_TYPE_PATTERN)
    description: str | None = None
    sort: int = 0
    options: list[FieldOptionIn] = []

    @field_validator("options")
    @classmethod
    def _opts_unique(cls, v: list[FieldOptionIn]) -> list[FieldOptionIn]:
        values = [o.value for o in v]
        if len(values) != len(set(values)):
            raise ValueError("选项 value 不能重复")
        return v


class CustomFieldUpdateIn(BaseModel):
    project_id: str
    field_id: str
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    sort: int | None = None
    # 显式声明 type 只做拒收：传了且与现值不同 → 422；不传 = 不改。不允许静默丢弃。
    type: str | None = Field(default=None, pattern=_TYPE_PATTERN)
    # None = 不改；[] = 清空；非空 = 整体替换
    options: list[FieldOptionIn] | None = None

    @field_validator("options")
    @classmethod
    def _opts_unique(cls, v: list[FieldOptionIn] | None) -> list[FieldOptionIn] | None:
        if v is None:
            return None
        values = [o.value for o in v]
        if len(values) != len(set(values)):
            raise ValueError("选项 value 不能重复")
        return v


class CustomFieldDeleteIn(BaseModel):
    project_id: str
    field_id: str


class CustomFieldOut(BaseModel):
    id: str
    project_id: str
    scene: str
    name: str
    field_key: str
    type: str
    description: str | None = None
    sort: int = 0
    internal: bool = False
    options: list[FieldOptionOut] = []
    template_count: int = 0
    created_at: str | None = None
    updated_at: str | None = None


class CustomFieldListOut(BaseModel):
    items: list[CustomFieldOut] = []


class TemplateResolveIn(BaseModel):
    project_id: str
    scene: str = Field(pattern=_SCENE_PATTERN)
    template_id: str | None = None


class TemplateResolveOut(BaseModel):
    template_id: str
    scene: str
    name: str
    fields: list[TemplateFieldOut] = []


class NumNextIn(BaseModel):
    project_id: str
    scene: str = Field(pattern=_SCENE_PATTERN)


class NumNextOut(BaseModel):
    num: int
