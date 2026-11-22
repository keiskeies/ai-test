"""D40（§11.4.22）用户批量导入的解析器：纯函数，不碰库。

口径（1G 计划 D40 原文）：复用 1E T4 导入向导的「冲突逐条跳过 + 报告」范式，
不另发明私有 CSV 方言——分隔识别沿用 web/src/api/csv.ts 的既有形状（制表符优先、逗号兜底，
首行=列头）。所有格式问题收成**带行号的人话**字符串进 errors，永不抛：
「第几行为什么被跳过」必须能逐行对上用户粘贴的原文，所以行号按物理行计（空行也占号）。

字段映射真认三列：账号/account、姓名/name、邮箱/email（大小写不敏感；邮箱列可缺）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# 单批上限：超限整批拒收（截断 = 静默丢行，比报错更糟）
MAX_ROWS = 500

# 与 schemas.UserCreateIn.account 的 pattern=min_length 同一条规则（前端控件后端真认）
_ACCOUNT_RE = re.compile(r"^[a-zA-Z0-9_.-]{2,64}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_HEADER_KEYS = {
    "account": "account", "账号": "account",
    "name": "name", "姓名": "name",
    "email": "email", "邮箱": "email",
}


@dataclass
class UserRow:
    line: int  # 粘贴原文的物理行号（1 起）——回执与错误报告都靠它对行
    account: str
    name: str
    email: str | None = None


@dataclass
class UserParseOutcome:
    rows: list[UserRow] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)  # 人话 + 行号；这些行没进 rows


def row_problem(account: str, name: str, email: str | None) -> str | None:
    """一行（账号/姓名/邮箱）的规则判定：违规则返回**不带行号前缀**的人话原因，合法返回 None。

    单点规则：解析（粘贴文本）与 commit（前端已做字段映射的行）必须同一把尺子，
    否则「预览说能建、提交说格式不对」= 两个口径骗人。
    """
    if not account:
        return "缺账号"
    if not _ACCOUNT_RE.match(account):
        return f"账号「{account[:64]}」不合法——只能字母数字与 _ . -，长度 2~64"
    if not name:
        return "缺姓名"
    if len(name) > 128:
        return "姓名超过 128 字（不改写、不截断）"
    if email is not None:
        if len(email) > 255:
            return f"邮箱超过 255 字：{email[:60]}…"
        if not _EMAIL_RE.match(email):
            return f"邮箱「{email[:80]}」格式不对（不需要邮箱可留空）"
    return None


def _cell(cs: list[str], cols: dict[str, int], key: str) -> str:
    """按列映射取一格：缺列（短行）返回空串交给 row_problem 报人话；邮箱列本身可缺。"""
    i = cols.get(key)
    return cs[i] if i is not None and i < len(cs) else ""


def parse_user_csv(text: str) -> UserParseOutcome:
    out = UserParseOutcome()
    lines = (text or "").splitlines()
    non_blank = [(i + 1, ln) for i, ln in enumerate(lines) if ln.strip()]
    if not non_blank:
        out.errors.append("内容为空：粘贴 CSV/TSV，首行列头（账号,姓名,邮箱 或 account,name,email）")
        return out

    h_ln, header = non_blank[0]
    # 制表符优先：从 Excel/WPS 复制出来必然是 TSV；逗号只在没有制表符时兜底（csv.ts 同规则）
    delimiter = "\t" if "\t" in header else ","
    cells = [c.strip() for c in header.split(delimiter)]
    cols: dict[str, int] = {}
    for idx, c in enumerate(cells):
        key = _HEADER_KEYS.get(c.lower())
        if key is not None and key not in cols:
            cols[key] = idx
    if "account" not in cols or "name" not in cols:
        out.errors.append(
            f"第 {h_ln} 行是列头：必须含「账号」与「姓名」两列（可给「邮箱」；也认 account/name/email），"
            f"当前列头：{header.strip()[:80]}"
        )
        return out

    data = non_blank[1:]
    if len(data) > MAX_ROWS:
        out.errors.append(f"数据行 {len(data)} 行，超过单批上限 {MAX_ROWS} 行，请拆批后再导入（未截断、未导入任何行）")
        return out

    seen: dict[str, int] = {}  # 批内重复：保留先出现的，后来的逐条报行号
    for ln, raw in data:
        cs = [c.strip() for c in raw.split(delimiter)]
        account, name, email = _cell(cs, cols, "account"), _cell(cs, cols, "name"), _cell(cs, cols, "email") or None
        problem = row_problem(account, name, email)
        if problem is not None:
            out.errors.append(f"第 {ln} 行：{problem}，该行已跳过（不会被导入）")
            continue
        if account in seen:
            out.errors.append(f"第 {ln} 行：账号「{account}」与第 {seen[account]} 行重复——保留先出现的，本行已跳过")
            continue
        seen[account] = ln
        out.rows.append(UserRow(line=ln, account=account, name=name, email=email))
    return out
