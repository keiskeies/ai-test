"""本机连接串的唯一读取处：进程环境 → `backend/.env` → 响亮报错。

**为什么要有这个文件**：conftest、`scripts/check_migration_down.py`、`scripts/verify_worker.py`
以前各写了一份 `mysql+asyncmy://root:<真口令>@<内网机>:3306/...` 的**字面量兜底**，
web 侧（playwright 配置 + 4 个 spec + gen-api）又把同一串抄了第 3~7 份。
`.env` 本身一直是 gitignore 的、`.env.example` 一直写 `CHANGE_ME` —— 也就是说
**这个仓早就定了「口令不进代码」的规矩，只有这七处默认值没执行它**。现在值只从这里读。

口径与 `app/core/config.py` 的 `env_file` 保持一致（那边是 pydantic-settings + python-dotenv）：
**已导出的环境变量优先于 .env**，两边都没有就报错，**绝不回落一个「看起来能连」的假地址**。
理由：本机 3306 确实在听，但它的 root 口令不是任何人能猜的那个值 ——
写个 `127.0.0.1` 的默认值只会把「你没配」变成一串 `Access denied`，比响亮报错难查得多。

自己写了 20 行解析而不用 python-dotenv：那包是 pydantic-settings 的**传递依赖**，
本仓没在 pyproject 里声明它（§13 纪律 2「新增第三方库要过取证」的同一口径）。
`.env` 是我们自己的文件，形状就四种（注释 / 空行 / `KEY=值` / 可选 `export` 与前引号），
`tests/test_localenv.py` 把这四种与真 `.env` 一起钉住了。
"""
from __future__ import annotations

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
ENV_PATH = BACKEND_DIR / ".env"

# `.env.example` 教的占位值。照抄过去没改 = 等于没配，必须和「没配」同等对待，
# 否则报错会指向一个「配了但连不上」的方向，白查一轮。
_PLACEHOLDERS = frozenset({"", "CHANGE_ME", "CHANGE_ME_random_32b"})


def parse_env_text(text: str) -> dict[str, str]:
    """把 .env 文本解析成 dict。四种形状：注释/空行跳过、`KEY=值`、`export KEY=值`、成对引号剥离。

    引号内的 `#` 不是注释；引号外的 ` #...` 是行尾注释 —— 与 python-dotenv 对本仓实际用法的
    行为一致（等价性由 tests/test_localenv.py 对真 .env 逐项比对钉住，不靠这段话说服）。
    """
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        else:
            head, hash_sep, _ = value.partition(" #")
            if hash_sep:
                value = head.rstrip()
        out[key] = value
    return out


def dotenv_values(path: Path = ENV_PATH) -> dict[str, str]:
    if not path.is_file():
        return {}
    return parse_env_text(path.read_text(encoding="utf-8"))


def require_env(key: str, *, path: Path = ENV_PATH, _loaded: dict[str, str] | None = None) -> str:
    """取一个必须配好的键（如 `TP_DB_URL`）。没配 / 还是占位值 ⇒ 说人话报错，不猜默认值。"""
    value = os.environ.get(key)
    if value is None:
        file_values = dotenv_values(path) if _loaded is None else _loaded
        value = file_values.get(key, "")
    if value.strip() in _PLACEHOLDERS:
        raise RuntimeError(
            f"{key} 没配（或还是占位值）。二选一："
            f"① 在 {path} 里写真实值（照 {path.parent / '.env.example'} 的键名，"
            f"该文件在仓库根，复制过来即可）；"
            f"② 或导出环境变量 $env:{key} / export {key}=... 。"
            f"代码里不留默认值是**有意的**——历史上那些默认值把真口令写进了公开仓库。"
        )
    return value
