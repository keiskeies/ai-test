"""自定义字段词表与纯校验（跨域共享：模板管理、缺陷、后续功能用例都走这里）。

**为什么在 shared 而不是某个 modules 里**：模板/字段是缺陷与用例的共同前置，而 import-linter
契约 1 禁止领域模块互相 import。词表与校验放 shared，领域模块各自持有值表（`defect_custom_field`
等），定义表归 `app.modules.project_meta`。shared 不 import 任何 modules。

**值一律 JSON 存**（`value TEXT`）：单值存 `"3"`、多值存 `["a","b"]`。MS 的 EAV 用
`VARCHAR(1000)` 原样存字符串，多值的编码散落在各调用方；JSON 一种编码让读侧永远知道怎么解。
代价是旧数据（如果将来导入 MS 数据）要过一次转换——本仓没有 MS 数据导入，先不做。"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

SCENES: tuple[str, ...] = ("functional", "bug", "api", "ui", "test_plan", "case_review")
SCENE_LABELS: dict[str, str] = {
    "functional": "功能用例",
    "bug": "缺陷",
    "api": "接口",
    "ui": "UI",
    "test_plan": "测试计划",
    "case_review": "用例评审",
}

FIELD_TYPES: tuple[str, ...] = (
    "input", "textarea", "select", "multiple_select", "radio", "checkbox",
    "member", "multiple_member", "date", "datetime", "int", "float", "multiple_input",
)
OPTION_TYPES: frozenset[str] = frozenset({"select", "multiple_select", "radio", "checkbox"})
MULTI_TYPES: frozenset[str] = frozenset({"multiple_select", "checkbox", "multiple_member", "multiple_input"})
FIELD_TYPE_LABELS: dict[str, str] = {
    "input": "单行文本",
    "textarea": "多行文本",
    "select": "下拉单选",
    "multiple_select": "下拉多选",
    "radio": "单选",
    "checkbox": "多选",
    "member": "成员单选",
    "multiple_member": "成员多选",
    "date": "日期",
    "datetime": "日期时间",
    "int": "整数",
    "float": "小数",
    "multiple_input": "多值文本",
}


class CustomFieldError(ValueError):
    """字段值校验失败；details 给前端定位到具体 field_id。"""

    def __init__(self, message: str, *, field_id: str | None = None, missing: list[str] | None = None):
        super().__init__(message)
        self.field_id = field_id
        self.missing = missing or []


def is_empty(v: Any) -> bool:
    return v is None or v == "" or v == [] or v == {}


def _as_list(v: Any, name: str) -> list[Any]:
    if not isinstance(v, list):
        raise CustomFieldError("字段「" + name + "」要求多值", field_id=name)
    return v


def _check_options(field: dict[str, Any], v: Any) -> Any:
    name = field.get("name") or field.get("id") or ""
    opts = {o["value"] for o in (field.get("options") or [])}
    if field["type"] in ("select", "radio"):
        if not isinstance(v, str) or v not in opts:
            raise CustomFieldError("字段「" + name + "」的值不在可选项里", field_id=field["id"])
        return v
    vals = [str(x) for x in _as_list(v, name)]
    bad = [x for x in vals if x not in opts]
    if bad:
        raise CustomFieldError("字段「" + name + "」含不可选值：" + "、".join(bad), field_id=field["id"])
    return list(dict.fromkeys(vals))


def normalize_value(field: dict[str, Any], v: Any) -> Any:
    """按字段类型校验并归一化一个非空值。失败抛 CustomFieldError。"""
    t = field["type"]
    name = field.get("name") or field.get("id") or ""
    if t in ("input", "textarea"):
        if not isinstance(v, str):
            raise CustomFieldError("字段「" + name + "」要求文本", field_id=field["id"])
        if len(v) > 5000:
            raise CustomFieldError("字段「" + name + "」最长 5000 字符", field_id=field["id"])
        return v
    if t in OPTION_TYPES:
        return _check_options(field, v)
    if t == "member":
        if not isinstance(v, str) or not v:
            raise CustomFieldError("字段「" + name + "」要求一个成员 id", field_id=field["id"])
        return v
    if t == "multiple_member":
        vals = [str(x) for x in _as_list(v, name)]
        if any(not x for x in vals):
            raise CustomFieldError("字段「" + name + "」含空成员", field_id=field["id"])
        return list(dict.fromkeys(vals))
    if t == "date":
        if not isinstance(v, str):
            raise CustomFieldError("字段「" + name + "」要求 YYYY-MM-DD", field_id=field["id"])
        try:
            datetime.strptime(v, "%Y-%m-%d")
        except ValueError as e:
            raise CustomFieldError("字段「" + name + "」日期格式应为 YYYY-MM-DD", field_id=field["id"]) from e
        return v
    if t == "datetime":
        if not isinstance(v, str):
            raise CustomFieldError("字段「" + name + "」要求 ISO 时间", field_id=field["id"])
        try:
            return datetime.fromisoformat(v).isoformat()
        except ValueError as e:
            raise CustomFieldError("字段「" + name + "」时间格式非法", field_id=field["id"]) from e
    if t == "int":
        try:
            return int(v)
        except (TypeError, ValueError) as e:
            raise CustomFieldError("字段「" + name + "」要求整数", field_id=field["id"]) from e
    if t == "float":
        try:
            return float(v)
        except (TypeError, ValueError) as e:
            raise CustomFieldError("字段「" + name + "」要求数字", field_id=field["id"]) from e
    if t == "multiple_input":
        vals = [str(x) for x in _as_list(v, name)]
        vals = [x for x in vals if x != ""]
        if len(vals) > 50:
            raise CustomFieldError("字段「" + name + "」最多 50 项", field_id=field["id"])
        return vals
    raise CustomFieldError("未知字段类型：" + t, field_id=field.get("id"))


def validate_custom_values(fields: list[dict[str, Any]], values: dict[str, Any] | None, *,
                           require_all: bool) -> dict[str, Any]:
    """校验并返回「只含非空值」的规范化字典（键 = field_id）。

    fields 的形状 = project_template_resolve 的 fields（含 required / default_value / options）。
    require_all=True 时模板里的 required 字段必须有非空值（创建与换模板时）；更新普通字段时
    传 False，由调用方把已有值和本次输入合并后再判。
    """
    values = values or {}
    by_id = {f["id"]: f for f in fields}
    unknown = [k for k in values if k not in by_id]
    if unknown:
        raise CustomFieldError("有 " + str(len(unknown)) + " 个字段不属于当前模板",
                               missing=unknown)
    out: dict[str, Any] = {}
    missing: list[str] = []
    for f in fields:
        raw = values.get(f["id"])
        if is_empty(raw) and not is_empty(f.get("default_value")):
            raw = f["default_value"]
        if is_empty(raw):
            if require_all and f.get("required"):
                missing.append(f["id"])
            continue
        out[f["id"]] = normalize_value(f, raw)
    if missing:
        names = "、".join(by_id[i].get("name") or i for i in missing)
        raise CustomFieldError("必填自定义字段未填：" + names, missing=missing)
    return out


def dump_value(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def load_value(raw: str | None) -> Any:
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        # 旧数据/手改数据：原样返回，前端按原文渲染（R112：陌生码不翻译）
        return raw
