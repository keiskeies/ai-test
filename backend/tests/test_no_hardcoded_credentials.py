"""已跟踪文件里不许再有「能用的凭据」。

**这条守卫凭什么存在**：口令清退之前，同一个内网库的连接串被硬编码在 **7 处**
（conftest + 2 个脚本 + playwright 配置 + 4 个 spec + gen-api，其中 web 那几处是同一串的第 3~7 份抄本）。
清退只解决了「现在没有」，解决不了「下次又贴一份」—— 而这一次它已经进到 13 条历史提交里了。
按本仓口径（「护栏本身没人钉 = 装饰」），改动落地必须自带一条会红的守卫。

两道规则，一条比一条宽：
1. **已知串**：这次清掉的两条口令，全仓永远不许再出现（防止从旧分支/旧脚本里粘回来）。
2. **形状**：代码目录里 `scheme://user:password@` 这种带口令的 URI。口令位允许**占位符**
   （`<密码>` / `CHANGE_ME` / `user:pw@host` 这类一看就不是真值的写法），不允许真值。

⚠ **本文件自己把要禁的串拆开写了**（`"pojieni" "masiquanjia"` 这种相邻字面量拼接 /
`"".join`）。本文件在 `backend/tests/` 下，而那是被扫目录 —— 直写就是自己抓自己。
用「豁免本文件」解决会留一个真洞（以后真往这里贴一条口令就静默放过），
所以选择让**源码里不存在那段连续字节**，而运行时值仍然是真串（正对照证明这点）。

⚠ 白名单是**量出来的**：现查代码目录里所有该形状只剩两处（逐条理由见 `_ALLOWED`）。
每加一条都要写理由，与 `emoji.redline.test.ts` 的「白名单是封闭集」同口径。
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# 三条禁串，**必须拆开写**（相邻字面量拼接），理由见文件头。
# 1/2 这次清退的两条真口令（MySQL root / Redis requirepass）。写全串而不只写口令本体：
#    `123456` 单出现是测试夹具里的常见噪音（`test-secret-key-0123456789abcdef`、
#    `datetime(..., 123456, ...)` 都含它），只禁它会淹掉真信号；
#    而带冒号前缀的 `123456@` 只可能落在 URI 的口令位。
# 3 演示口令（业主 2026-11-22 裁：清退）。它曾同时躺在 conftest 默认值、
#    11 处登录断言与 6 份演示手册里 -- 禁它是防「手册抄回代码」。
# 内网主机名**不在**这张表：它是拓扑不是凭据，而且它是假 ADB 设备串号（同网段 .50，
#   36 处）的父网段子串，子串规则会在那些假设备上误报。主机名靠 2026-11-22 那次一次性
#   匿名化（统一换成 `db.internal.test`）解决，不靠这条规则长期盯。
_BANNED: tuple[str, ...] = ("pojieni" "masiquanjia", ":" "123456@", "Adm" "in@12345")

# 形状规则只扫代码目录：文档里出现的都是 `<密码>` / `db.internal.test` 这类占位形状
# （2026-11-22 业主裁：内网主机名一律匿名化，计划文档的「照原文读」旧口径同日作废）。
# 已知串规则仍然全仓生效（含 docs/），见 test_known_leaked_strings_are_gone_repo_wide。
_CODE_DIRS: tuple[str, ...] = (
    "backend/app/",
    "backend/tests/",
    "backend/scripts/",
    "backend/migrations/",
    "web/src/",
    "web/e2e/",
    "web/scripts/",
)

# 口令位 = 不含空白/引号/反引号/斜杠/@ 的一串；user 可为空（`redis://:pw@host` 正是这个形状）。
_SHAPE = re.compile(r"://[^\s/\"'`@]{0,40}:[^\s/\"'`@]{1,64}@")

# 命中了但不算违规：(文件, 该行必须同时含的串, 理由)。
_ALLOWED: tuple[tuple[str, str, str], ...] = (
    (
        "backend/app/core/config.py",
        "root:root@127.0.0.1",
        "本机开发默认值：口令位是字面量 `root`、指向 127.0.0.1，且实测本机 3306 拿它连不上"
        "（Access denied）⇒ 它是「没配」的形状，不是一条能用的凭据。"
        "`app/core/` 是护栏目录（`git status --short -- backend/app/core/` 必须为空），"
        "改它属另一刀，已登记待业主裁。",
    ),
    (
        "web/e2e/palette.spec.mjs",
        "user:pw@host",
        "注释里在讲「串长什么样」，user/pw/host 三个词本身就是占位符。",
    ),
)

# 占位符口令位：文档/示例里合法的写法。
_PLACEHOLDER_PW = re.compile(r"^(<[^>]*>|CHANGE_ME\S*|\*+|password|pw|pass|xxx+)$", re.I)


def _tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "-z"], capture_output=True, check=True
    ).stdout
    return [p.decode() for p in out.split(b"\0") if p]


def _scan(rel_list: list[str], *, shapes: bool) -> list[str]:
    bad: list[str] = []
    for rel in rel_list:
        path = REPO / rel
        if not path.is_file():
            continue
        data = path.read_bytes()
        if b"\0" in data:
            continue  # 二进制不扫：真凭据不会藏在二进制里，而误报会淹掉规则
        for no, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            for token in _BANNED:
                if token in line:
                    bad.append(f"{rel}:{no} 已知串 {token!r}: {line.strip()[:90]}")
            if not shapes:
                continue
            for m in _SHAPE.finditer(line):
                pw = m.group(0).split("://", 1)[1].split("@", 1)[0].split(":", 1)[1]
                if _PLACEHOLDER_PW.match(pw):
                    continue
                if any(rel == a and need in line for a, need, _ in _ALLOWED):
                    continue
                bad.append(f"{rel}:{no} 带口令的 URI（口令位 {pw[:3]}…）: {line.strip()[:80]}")
    return bad


def test_tracked_code_has_no_usable_credentials() -> None:
    tracked = [p for p in _tracked_files() if p.startswith(_CODE_DIRS)]
    assert tracked, "扫描范围为空 = 守卫在假绿（目录前缀写错了）"
    assert _scan(tracked, shapes=True) == []


def test_known_leaked_strings_are_gone_repo_wide() -> None:
    """已知串在**全仓**（含 docs/）都不许有 —— 比形状规则宽，因为它只认这两条确定的串。"""
    assert _scan(_tracked_files(), shapes=False) == []


# ══════════════ 正对照：守卫自己得抓得住历史上那条真串 ══════════════
# 没有这一组，上面两条「== []」有可能只是因为正则什么都匹配不到而绿。
# （本仓记过四次「仪器坏了读成自己的失败」；一条抓不住已知样本的守卫就是坏了的仪器。）
# 样本同样**拆开写**再 join —— 否则这个文件自己会被自己的规则抓住，而正对照就变成了红。


def _fixture(*parts: str) -> str:
    return "".join(parts)


def test_positive_control_catches_the_exact_historical_strings() -> None:
    real = [
        _fixture('os.environ.get("TP_DB_URL", "mysql+asyncmy://root:pojieni',
                 'masiquanjia@db.internal.test:3306/x")'),
        _fixture('os.environ.setdefault("TP_REDIS_URL", "redis://:', "123456@db.internal.test:16379/6\")"),
        _fixture('const DB = "mysql+asyncmy://root:S3cr3t', 'Really@10.0.0.2:3306/e2e";'),
    ]
    for i, line in enumerate(real):
        shape = _SHAPE.search(line)
        caught_by_token = any(t in line for t in _BANNED)
        caught_by_shape = shape is not None and not _PLACEHOLDER_PW.match(
            shape.group(0).split("://", 1)[1].split("@", 1)[0].split(":", 1)[1]
        )
        assert caught_by_token or caught_by_shape, f"正对照 {i} 漏了（仪器坏了）: {line[:60]}"
    # 第 3 条不含任何「已知串」，只能靠形状规则抓住 —— 它就是形状规则存在的全部理由
    assert not any(t in real[2] for t in _BANNED)


def test_positive_control_shape_rule_ignores_passwordless_urls() -> None:
    """反面对照：没有口令位的 URI 不许被抓，否则规则会因为噪音被人关掉。"""
    clean = [
        'redis_url: str = "redis://127.0.0.1:6379/0"',
        'model_seed_base_url: str = "http://127.0.0.1:9000/v1"',
        'const APP = "http://127.0.0.1:5173";',
        "TP_REDIS_URL=redis://<你的口令>@127.0.0.1:6379/6",
        "# mysql+asyncmy://user:pw@host:port/db → pymysql 直连",
        'TP_DB_URL=mysql+asyncmy://root:CHANGE_ME@db.internal.test:3306/testpilot?charset=utf8mb4',
    ]
    for line in clean:
        m = _SHAPE.search(line)
        if m is None:
            continue
        pw = m.group(0).split("://", 1)[1].split("@", 1)[0].split(":", 1)[1]
        assert _PLACEHOLDER_PW.match(pw), f"占位符被误判成真口令: {line}"


def test_allowlist_entries_still_exist() -> None:
    """白名单不许烂在里面：登记的条目若对应的串已不在文件里，就该删掉这条豁免。

    没有这条，白名单只会越长越像「规则其实不生效」—— 而没人会去核对哪几条还有效。
    """
    stale = [
        f"{rel} 里的 {need!r} 已不存在"
        for rel, need, _why in _ALLOWED
        if not (REPO / rel).is_file()
        or need not in (REPO / rel).read_text(encoding="utf-8", errors="replace")
    ]
    assert stale == []
