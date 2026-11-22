"""`app/shared/localenv.py` 的守卫。

**为什么值得单独立一个文件**：口令从代码里拿掉之后，这一小段解析就是**全套 pytest 的
第一道门**（conftest 在 import 期就调 `require_env("TP_DB_URL")`）。它坏了不是「一个函数挂」，
是整套件红，而且红相是「没配」——恰好和它要区分的那个真问题（真的没配）长得一模一样。
所以错误形状也要钉：**没配必须报「没配」，不能报成解析失败。**

第四组不是自说自话：拿 python-dotenv 对**开发者机器上那份真 `.env`** 逐项比对。
自造解析器最容易坏在「我以为的 .env 形状」和「实际那份的形状」不一致上，
而那只有拿真文件比才看得见。
"""
from __future__ import annotations

import pytest

from app.shared import localenv
from app.shared.localenv import ENV_PATH, parse_env_text, require_env

# ══════════ 1. 解析器：四种形状 ══════════


def test_plain_and_comment_and_blank_lines():
    got = parse_env_text("A=1\n# 整行注释\n\nB=2\n")
    assert got == {"A": "1", "B": "2"}


def test_export_prefix_and_quotes_are_stripped():
    got = parse_env_text('export C="3"\nD=\'4\'\nE="unbalanced\n')
    assert got["C"] == "3"
    assert got["D"] == "4"
    # 只有一头有引号 ⇒ 不是「带引号的值」，原样保留（含那半个引号），别猜
    assert got["E"] == '"unbalanced'


def test_hash_inside_quotes_survives_but_bare_hash_is_comment():
    got = parse_env_text('PW="a#b"\nTAIL=raw # 行尾注释\nSOLO=a#b\n')
    assert got["PW"] == "a#b"          # 引号内：口令里真能有 #
    assert got["TAIL"] == "raw"        # 引号外带空格：行尾注释
    assert got["SOLO"] == "a#b"        # 紧贴的 # 不算注释（python-dotenv 同口径）


def test_line_without_equals_and_empty_key_are_skipped():
    assert parse_env_text("NOEQUALS\n=onlyvalue\nF=6\n") == {"F": "6"}


def test_value_with_spaces_and_equals_sign_is_kept_whole():
    # 连接串里 `?charset=utf8mb4` 这种带 = 的值不能被第二个 = 截断。
    # 口令位写 `<pw>` 而不是 `p`：守卫的形状规则认 `://u:pw@h` 这类**占位符**，
    # 而单词 `p` 不在它的占位词表里 ⇒ 这个夹具当年被自己的守卫判成"带口令的 URI"。
    # （那是 `git add` 之后才红起来的 —— `git ls-files` 不含未跟踪文件，
    #   所以「守卫绿」那次它根本看不见这个文件。见 docs §四 的同款告诫。）
    assert parse_env_text("TP_DB_URL=mysql+asyncmy://u:<pw>@h:3306/db?charset=utf8mb4") == {
        "TP_DB_URL": "mysql+asyncmy://u:<pw>@h:3306/db?charset=utf8mb4"
    }


# ══════════ 2. require_env 的三条分支 ══════════


def test_process_env_wins_over_the_file(tmp_path, monkeypatch):
    f = tmp_path / ".env"
    f.write_text("TP_DB_URL=from_file\n", encoding="utf-8")
    monkeypatch.setenv("TP_DB_URL", "from_process")
    assert require_env("TP_DB_URL", path=f) == "from_process"


def test_file_is_used_when_env_is_absent(tmp_path, monkeypatch):
    f = tmp_path / ".env"
    f.write_text("TP_DB_URL=from_file\n", encoding="utf-8")
    monkeypatch.delenv("TP_DB_URL", raising=False)
    assert require_env("TP_DB_URL", path=f) == "from_file"


def test_missing_key_names_the_key_and_says_missing_not_parse_error(tmp_path, monkeypatch):
    f = tmp_path / ".env"
    f.write_text("OTHER=1\n", encoding="utf-8")
    monkeypatch.delenv("TP_DB_URL", raising=False)
    with pytest.raises(RuntimeError) as exc:
        require_env("TP_DB_URL", path=f)
    msg = str(exc.value)
    assert "TP_DB_URL" in msg and "没配" in msg
    # 错误里要能看见去哪儿配（两条路都给），否则报错把人送去查代码
    assert ".env.example" in msg


@pytest.mark.parametrize("placeholder", ["", "CHANGE_ME", "CHANGE_ME_random_32b", "   "])
def test_copying_env_example_verbatim_is_treated_as_unconfigured(tmp_path, monkeypatch, placeholder):
    """照抄 `.env.example` 没改 = 没配。这条必须报「没配」，不能带着 CHANGE_ME 去连库。"""
    f = tmp_path / ".env"
    f.write_text(f"TP_DB_URL={placeholder}\n", encoding="utf-8")
    monkeypatch.delenv("TP_DB_URL", raising=False)
    with pytest.raises(RuntimeError, match="没配"):
        require_env("TP_DB_URL", path=f)


def test_missing_file_is_not_a_crash_before_the_message(tmp_path, monkeypatch):
    monkeypatch.delenv("TP_DB_URL", raising=False)
    with pytest.raises(RuntimeError, match="没配"):
        require_env("TP_DB_URL", path=tmp_path / "does-not-exist.env")


# ══════════ 3. 全套件的那道门：真 `.env` 能被解析出可连的串 ══════════


def test_real_env_file_parses_and_agrees_with_python_dotenv(monkeypatch):
    """对开发者机器上那份真 .env 比对（文件不存在就跳过，CI 上没有它）。

    ⚠ 第一版这里读 `os.environ` 判断「有没有注入」，于是**它在真实套件里永远跳过** ——
    `tests/conftest.py` 在 import 期就写 `os.environ["TP_DB_URL"] = ...`（把库名换成
    本轮 schema），等本测试跑到时那个键恒在。一条永远不会执行的比对，和没有这条比对
    等价，却更糟：它让「真 .env 的解析被钉住了」这句话听起来成立。（本仓第 5 次
    「仪器读起来正常所以没人看它」。）现在改成显式 `delenv` + 传 `path=ENV_PATH`，
    走的是 conftest 用的同一条代码路径，与被注入的进程环境无关。
    """
    if not ENV_PATH.is_file():
        pytest.skip(f"{ENV_PATH} 不存在（CI 用进程环境注入，不走 .env）")
    from dotenv import dotenv_values as third_party

    mine = localenv.dotenv_values(ENV_PATH)
    theirs = {k: v for k, v in third_party(str(ENV_PATH)).items() if v is not None}
    assert mine == theirs
    # 真文件里至少要有 conftest 依赖的那个键，否则上面两条「都解析成空 dict」也会相等
    assert "TP_DB_URL" in mine and "TP_REDIS_URL" in mine

    monkeypatch.delenv("TP_DB_URL", raising=False)
    url = require_env("TP_DB_URL", path=ENV_PATH)
    assert url.startswith(("mysql+asyncmy://", "mysql+pymysql://")) and "@" in url
