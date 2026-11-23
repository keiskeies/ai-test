"""D205：功能用例 Excel 导入/导出（纯函数层，不碰 DB / ctx）。

为什么要标准 Excel 而不是 CSV：MS 的用例导入导出就是 xlsx（多工作表、列宽、必填星号、
日期单元格），CSV 在中文 Excel 里还带 BOM/编码坑。openpyxl 是成熟库（用户口径：
能靠库就不手搓），这里只做「表格 ⇄ 行字典」的翻译，业务校验仍归 services/模板。

诚实边界：
- **一列一字段**：固定列（编号/用例名称/优先级/模块/描述）+ 当前模板的自定义字段列。
  项目里若有多套模板，导出按「指定模板或默认模板」的字段列走，别的模板字段不合并
  （合并会造出半数列、导入时又对不上模板）——这条限制写进导出说明页。
- 导入是**全有或全无**：任何一行校验失败 → 整批 422 并逐行给原因，一行都不落库。
- 模块列写**全路径**（`父/子`），导入按路径解析；解析不到该行报错，不静默丢进未分类。
"""

from __future__ import annotations

from datetime import date, datetime
from io import BytesIO
from typing import Any

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from app.shared.custom_fields import FIELD_TYPE_LABELS, MULTI_TYPES, OPTION_TYPES

FIXED_HEADERS: tuple[str, ...] = ("编号", "用例名称", "优先级", "模块", "描述")
NAME_HEADER = "用例名称"
PRIORITIES: tuple[str, ...] = ("P0", "P1", "P2", "P3")
DEFAULT_PRIORITY = "P2"
MAX_ROWS = 2000
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
_SHEET = "用例"
_HELP = "填写说明"
_HEADER_FILL = PatternFill("solid", fgColor="E8F0FE")
_HEADER_FONT = Font(bold=True)


class ImportError_(ValueError):
    """导入行级错误（带 Excel 行号，1 基）。"""

    def __init__(self, row: int, message: str):
        super().__init__(message)
        self.row = row
        self.message = message


def custom_header(name: str, required: bool) -> str:
    """自定义字段列头：必填带 `*`（导入时容忍有无星号）。"""
    return name + ("*" if required else "")


def headers_for(fields: list) -> list[str]:
    """当前模板的完整列头（固定列 + 自定义字段列）。"""
    return [*FIXED_HEADERS, *(custom_header(f.name, f.required) for f in fields)]


def _write_sheet(ws, headers: list[str], rows: list[list[Any]]) -> None:
    ws.append(headers)
    for cell in ws[1]:
        cell.fill = _HEADER_FILL
        cell.font = _HEADER_FONT
        cell.alignment = Alignment(vertical="center")
    for r in rows:
        ws.append(r)
    widths = {i: max(10, min(48, len(str(h)) + 6)) for i, h in enumerate(headers, start=1)}
    for i, w in widths.items():
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"


def _help_sheet(wb, fields: list) -> None:
    ws = wb.create_sheet(_HELP)
    ws.append(["列", "类型", "必填", "可选项/说明"])
    for cell in ws[1]:
        cell.font = _HEADER_FONT
        cell.fill = _HEADER_FILL
    ws.append([NAME_HEADER, "单行文本", "是", "最长 255 字"])
    ws.append(["优先级", "下拉", "否", "P0/P1/P2/P3，留空按 P2"])
    ws.append(["模块", "文本", "否", "模块全路径，如「登录/异常」；留空进「未分类」"])
    ws.append(["描述", "多行文本", "否", "最长 5000 字"])
    for f in fields:
        if f.options:
            opts = "、".join(
                (str(o.label) if str(o.label) == str(o.value) else f"{o.label}（{o.value}）")
                for o in f.options
            )
            extra = "可选项：" + opts
        else:
            extra = "多值用逗号分隔" if f.type in MULTI_TYPES else ""
        ws.append(
            [
                custom_header(f.name, f.required),
                FIELD_TYPE_LABELS.get(f.type, f.type),
                "是" if f.required else "否",
                extra,
            ]
        )
    for i, w in ((1, 20), (2, 12), (3, 8), (4, 60)):
        ws.column_dimensions[get_column_letter(i)].width = w


def template_bytes(fields: list) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = _SHEET
    _write_sheet(ws, headers_for(fields), [])
    _help_sheet(wb, fields)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def export_bytes(rows: list[list[Any]], fields: list) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = _SHEET
    _write_sheet(ws, headers_for(fields), rows)
    _help_sheet(wb, fields)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _norm_header(v: Any) -> str:
    return str(v).strip().replace("*", "").replace("＊", "") if v is not None else ""


def _cell_multi(v: Any) -> list[str]:
    if v is None:
        return []
    raw = str(v).replace("，", ",").replace("、", ",").replace("；", ",").replace(";", ",")
    return [x.strip() for x in raw.replace("\n", ",").split(",") if x.strip()]


def _option_maps(field) -> tuple[dict[str, str], dict[str, str]]:
    """(label→value, value→label)：导入按人填的 label 认，导出按 label 写。

    MS 的 Excel 里用户看到/填写的是选项**标签**，库里存的是 value；只认 value 会让
    「下拉单选」在 Excel 里变成猜谜。两边都收，导出统一写 label（人读友好），
    再导入时 label→value 又能回去，闭环。
    """
    to_value: dict[str, str] = {}
    to_label: dict[str, str] = {}
    for o in field.options or []:
        to_value[str(o.label).strip()] = str(o.value)
        to_value[str(o.value)] = str(o.value)
        to_label[str(o.value)] = str(o.label)
    return to_value, to_label


def export_option_cell(field, v: Any) -> Any:
    """导出单元格：选项值写回标签；多值用逗号连接。"""
    if v is None:
        return None
    if field.type not in OPTION_TYPES:
        if field.type in MULTI_TYPES and isinstance(v, list):
            return ",".join(str(x) for x in v)
        return v
    _, to_label = _option_maps(field)
    if isinstance(v, list):
        return ",".join(to_label.get(str(x), str(x)) for x in v)
    return to_label.get(str(v), str(v))


def _cell_value(field, v: Any) -> Any:
    """Excel 单元格 → 自定义字段原始值（类型归一化交给 shared.validate）。"""
    if v is None or (isinstance(v, str) and v.strip() == ""):
        return None
    if field.type in MULTI_TYPES:
        vals = _cell_multi(v)
        if field.type in OPTION_TYPES:
            to_value, _ = _option_maps(field)
            vals = [to_value.get(x, x) for x in vals]
        return vals
    if field.type in OPTION_TYPES:
        to_value, _ = _option_maps(field)
        return to_value.get(str(v).strip(), str(v).strip())
    if field.type in ("date", "datetime"):
        if isinstance(v, datetime):
            return v.isoformat() if field.type == "datetime" else v.date().isoformat()
        if isinstance(v, date):
            return v.isoformat()
        return str(v).strip()
    if field.type == "int":
        if isinstance(v, float) and v.is_integer():
            return int(v)
        return v if isinstance(v, int) else str(v).strip()
    if field.type == "float":
        return v if isinstance(v, (int, float)) else float(str(v).strip())
    return str(v).strip()


def parse_workbook(data: bytes, fields: list) -> list[dict[str, Any]]:
    """解析并做**格式级**校验；语义校验（必填自定义字段等）由调用方按行做。

    返回行字典：{row, name, priority, description, module_path, custom:{field_id: value}}。
    抛 ImportError_ 时带行号。
    """
    try:
        wb = openpyxl.load_workbook(BytesIO(data), read_only=True, data_only=True)
    except Exception as e:  # noqa: BLE001 —— 损坏文件/非 xlsx 统一转成人话
        raise ImportError_(0, "文件不是可读的 .xlsx（另存为 Excel 工作簿后重试）") from e
    ws = wb[_SHEET] if _SHEET in wb.sheetnames else wb[wb.sheetnames[0]]
    it = ws.iter_rows(values_only=True)
    try:
        header = next(it)
    except StopIteration as e:
        raise ImportError_(0, "表格是空的（第一行应为列头）") from e
    cols = {_norm_header(h): i for i, h in enumerate(header) if h is not None}
    if NAME_HEADER not in cols:
        raise ImportError_(0, "缺少必填列「" + NAME_HEADER + "」——请用「下载模板」的列头")
    field_by_header = {_norm_header(custom_header(f.name, f.required)): f for f in fields}
    out: list[dict[str, Any]] = []
    for idx, row in enumerate(it, start=2):
        if row is None or all(v is None or (isinstance(v, str) and v.strip() == "") for v in row):
            continue  # 空行跳过（Excel 常有尾随空行）
        if len(out) >= MAX_ROWS:
            raise ImportError_(idx, f"一次最多导入 {MAX_ROWS} 行，请拆成多个文件")
        name = str(row[cols[NAME_HEADER]] or "").strip()
        if not name:
            raise ImportError_(idx, "「用例名称」不能为空")
        if len(name) > 255:
            raise ImportError_(idx, "「用例名称」超过 255 字")
        pri = str(row[cols["优先级"]] or "").strip() if "优先级" in cols else ""
        if pri and pri not in PRIORITIES:
            raise ImportError_(idx, "「优先级」只支持 P0/P1/P2/P3，收到：" + pri)
        desc = str(row[cols["描述"]] or "").strip() if "描述" in cols else ""
        if len(desc) > 5000:
            raise ImportError_(idx, "「描述」超过 5000 字")
        module_path = str(row[cols["模块"]] or "").strip() if "模块" in cols else ""
        custom: dict[str, Any] = {}
        for h, f in field_by_header.items():
            if h in cols:
                v = _cell_value(f, row[cols[h]])
                if v is not None and v != []:
                    custom[f.field_id] = v
        out.append(
            {
                "row": idx,
                "name": name,
                "priority": pri or DEFAULT_PRIORITY,
                "description": desc or None,
                "module_path": module_path,
                "custom": custom,
            }
        )
    if not out:
        raise ImportError_(0, "没有解析到任何数据行（列头之外全空）")
    return out
