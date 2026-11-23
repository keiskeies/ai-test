"""R158 跨语言词表防漂钉：后端新增写动词，前端只读判定必须跟着改，否则本例先红。

背景（§11.5.1 只读横幅）：`web/src/auth/perms.ts` 的 `isReadOnlyPatterns` 靠一条正则
`WRITE_TAIL` 判断「这个权限位写得起吗」，词表是**手抄**后端 registry 的动名词尾。手抄 =
等着漂：后端哪天加个 `xxx:archive`，前端会把挂着它的角色判成「只读」并弹出只读横幅——
一个能改东西的人被告知自己只能看，这是 §13 纪律 1 禁止的撒谎 UI，而前端单测永远看不见
后端词表的变化，所以钉必须在后端、对着运行时 REGISTRY 量。

判定口径：
- 后端真值：REGISTRY.all() 里 `effect != "read"` 的 perm 的条尾（比手写的词表权威）。
- 前端词表：正则读出 `WRITE_TAIL` 的 `(a|b|c)` 组，不 import TS、不起 node。
- 方向性：**漏**（后端有、前端没）= 危险，硬红；**多**（前端有、后端没有）= 只会宽判成
  「非只读」，不撒谎，允许但必须在这条断言里看见（改名/删位时它会把陈旧词摆出来）。

反假绿：REGISTRY 没 import 起来 → 写动词集为空 → 主案先红（空集谁都过得去，故锚点单列）。
"""
from __future__ import annotations

import importlib
import re
from pathlib import Path

_WEB_PERMS = Path(__file__).resolve().parents[2] / "web" / "src" / "auth" / "perms.ts"

# 已知写动词锚点（2026-11-17 实测：写/破坏类 effect 的条尾全集）
_KNOWN_WRITE_TAILS = {"create", "update", "delete", "run", "debug", "disable"}

# 个人账户类 perm：`auth:self`（读自己）/ `auth:password:self`（改自己密码）都不进项目写判定。
# 理由：只读横幅说的是「这个人在本项目里能不能改东西」，而改自己密码跟项目角色无关——
# 把它算成「可写」会让任何带 auth 位的角色永远不弹横幅，反而把横幅废掉。
# 只认 `auth:` 域：别处再长出 `:self`，这条豁免不认，主案先红。
_PERSONAL = re.compile(r"^auth:[a-z_:]*self$")


def _backend_write_tails() -> set[str]:
    import app.main as main_mod
    from app.core.registry import REGISTRY

    for mod_name in main_mod._SERVICE_MODULES:
        importlib.import_module(mod_name)
    specs = [t for t in REGISTRY.all() if getattr(t.handler, "__module__", "").startswith("app.")]
    write_perms = {t.perm for t in specs if t.effect != "read"}
    personal = {p for p in write_perms if _PERSONAL.match(p)}
    assert personal <= {"auth:password:self", "auth:self"}, (
        "`:self` 个人账户豁免面长出了新成员 "
        + str(sorted(personal - {"auth:password:self", "auth:self"}))
        + "——确认它真的与项目角色无关，再来扩 _PERSONAL")
    return {p.split(":")[-1] for p in write_perms if not _PERSONAL.match(p)}


def _frontend_write_tails() -> set[str]:
    src = _WEB_PERMS.read_text(encoding="utf-8")
    m = re.search(r"const WRITE_TAIL = /:\(([^)]*)\)\$/", src)
    assert m, "web/src/auth/perms.ts 里找不到 `const WRITE_TAIL = /:(a|b)$/` —— 判定口径被改了，本例得同步改"
    return set(m.group(1).split("|"))


def test_r158_frontend_write_verb_list_covers_backend() -> None:
    tails = _backend_write_tails()
    assert tails >= _KNOWN_WRITE_TAILS, (
        f"后端写动词集只剩 {sorted(tails)}，锚点 {_KNOWN_WRITE_TAILS - tails} 没了——"
        "REGISTRY 没 import 起来或 effect 语义变了，本例正在盯空气")

    declared = _frontend_write_tails()
    missing = tails - declared
    assert not missing, (
        "后端存在这些写动词权限，但前端 isReadOnlyPatterns 的 WRITE_TAIL 不认识它们："
        + str(sorted(missing))
        + "。后果：挂着这些位的自定义角色会被判成「只读」并弹出只读横幅（能改东西的人被告知"
        "只能看）。去 web/src/auth/perms.ts 的 WRITE_TAIL 加进去。")
    # 反向不硬红：前端多认一个动词只会「少弹一条横幅」，不撒谎。但陈旧词得被看见。
    stale = declared - tails
    assert stale <= {"manage", "write"}, (
        "前端词表里这些动词后端一个都没有（写动词被改名/删除后没同步）：" + str(sorted(stale))
        + "；确认它们确实不再出现就从 WRITE_TAIL 摘掉。"
        "（manage/write 是已知保留：project:member:manage 与 agent:plan:write 现在恰好是读，"
        "但名字本身是写语义，留着比删掉安全。）")
