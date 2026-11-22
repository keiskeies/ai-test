"""R143 统一扫描器：全后端 httpx 出网构造必须 trust_env=False。

口径（1E 计划 R143 回填里点名的三个缺口，本例一并罩住）：
- ③ execution/core.py、⑤ api_test/import_services.py 的 AsyncClient 此前没有扫描例；
- ④ shared/sandbox.py 走 `kw.setdefault("trust_env", False)` 喂**同步** httpx.request，
  AsyncClient 正则对它天然失明——本例认 `**kw` 展开 + 同文件 setdefault 的组合作合法形状。
- 先例：test_notify.py:143 / test_model_cfg_probe.py:414 的源码扫描（同 test_worker 扫
  import 的口径）；那两个例继续各自钉 senders.py / probe.py 的本地细节（probe 还钉
  timeout=5.0），本例是并行的全后端统一网，不替代它们。

反假绿：扫描若匹配零站点（文件搬家/构造改名）必须红，故断言站点数与已知文件清单。
诚实条款：本例只钉「源码里构造 httpx 客户端处带 trust_env=False」；运行期经第三方库
间接建客户端的面不在覆盖内（全 app/ 直接构造即上述五处，grep httpx 亲验）。
"""
from __future__ import annotations

import re
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1] / "app"

# 会被宿主代理环境变量（no_proxy=[::1] 解析炸，R143 三次现场）劫持的出网构造入口
_CALL_RE = re.compile(
    r"httpx\.(AsyncClient|Client|request|get|post|put|patch|delete|head|options|stream)\("
)
# 合法形状二选一：构造参数里逐字 trust_env=False；或 **kw 展开且同文件把 setdefault 钉死
_TRUST_ENV_FALSE_RE = re.compile(r"trust_env\s*=\s*False")
_SETDEFAULT_RE = re.compile(r"""setdefault\(\s*["']trust_env["']\s*,\s*False""")

# 已知站点清单（防「扫描被架空还绿」：删文件/改构造名 → 站点数掉 → 本断言红）
_KNOWN_FILES = {
    "modules/api_test/import_services.py",
    "modules/execution/core.py",
    "modules/model_cfg/probe.py",
    "modules/notify/senders.py",
    "shared/sandbox.py",
}


def _args_slice(src: str, open_paren_idx: int) -> tuple[str, int]:
    """从 '(' 处按括号配平截出参数文本——比 [^)]* 稳，嵌套括号/跨行都不瞎。"""
    depth = 0
    for i in range(open_paren_idx, len(src)):
        c = src[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return src[open_paren_idx + 1:i], i
    return src[open_paren_idx + 1:], len(src)


def _scan_sites() -> list[dict]:
    sites = []
    for py in sorted(APP_ROOT.rglob("*.py")):
        src = py.read_text(encoding="utf-8")
        if "httpx" not in src:
            continue
        has_setdefault = bool(_SETDEFAULT_RE.search(src))
        for m in _CALL_RE.finditer(src):
            args, _ = _args_slice(src, m.end() - 1)
            lineno = src.count("\n", 0, m.start()) + 1
            sites.append({
                "file": py.relative_to(APP_ROOT).as_posix(),
                "line": lineno,
                "ctor": m.group(1),
                "ok": (bool(_TRUST_ENV_FALSE_RE.search(args))
                       or ("**" in args and has_setdefault)),
            })
    return sites


def test_r143_scan_actually_finds_known_sites() -> None:
    """反假绿：扫描必须真的扫到已知站点——匹配零/文件搬家 = 扫描被架空 = 红。"""
    sites = _scan_sites()
    assert len(sites) >= 5, (
        "R143 扫描只找到 " + str(len(sites)) + " 个 httpx 出网构造——构造被改名/搬家，"
        "扫描形状罩不住了，本例被架空（已知应有 " + str(len(_KNOWN_FILES)) + " 处）")
    found = {s["file"] for s in sites}
    missing = _KNOWN_FILES - found
    assert not missing, "R143 已知站点文件消失（搬家要同步改清单，不许静默脱扫）：" + str(missing)


def test_r143_every_httpx_ctor_in_app_has_trust_env_false() -> None:
    """全 app/ 每个 httpx 出网构造必须 trust_env=False（或 setdefault 钉死的 **kw 形状）。

    变异自证（2026-11-17 实测，摘参→本例红→复原→绿）：
    import_services.py / execution/core.py / notify/senders.py / model_cfg/probe.py /
    shared/sandbox.py 五处逐一验过。
    """
    bad = [s for s in _scan_sites() if not s["ok"]]
    assert not bad, ("httpx 构造缺 trust_env=False（R143：宿主 no_proxy=[::1] 会劫持出网）："
                     + "; ".join(s["file"] + ":" + str(s["line"]) + " httpx." + s["ctor"]
                                 for s in bad))
