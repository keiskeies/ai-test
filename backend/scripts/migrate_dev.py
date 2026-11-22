"""升级开发库到 head 并打印版本（scripts/migrate_dev.py）。

为什么需要它：alembic 的 head 前进后，开发库 testpilot 不会自己跟上。1B T2 建了
0014/0015 两张表，而演示库一直停在 0013 —— pytest 用的是每轮新建的临时库，全绿
也照不出这个滞后，直到手工连演示库查表才撞见。测试绿不等于演示库可用，得有一条
命令专门把它们对齐。

用法（在 backend 目录下）：
    .venv/Scripts/python.exe scripts/migrate_dev.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def main() -> int:
    from alembic import command
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    os.chdir(BACKEND)
    from app.core.config import get_settings

    async_url = get_settings().db_url
    sync_url = async_url.replace("+asyncmy", "+pymysql")
    schema = urlsplit(async_url).path.lstrip("/")

    cfg = Config("alembic.ini")
    cfg.set_main_option("script_location", "migrations")
    cfg.set_main_option("sqlalchemy.url", sync_url)

    before = _current(sync_url)
    command.upgrade(cfg, "head")
    head = ScriptDirectory.from_config(cfg).get_current_head()
    after = _current(sync_url)

    print("schema  :", schema)
    print("version :", before, "->", after, "(head =", head + ")")
    if after != head:
        print("FAIL: 升级后仍不等于 head", file=sys.stderr)
        return 1
    print("OK: 开发库已在 head")
    return 0


def _current(url: str) -> str | None:
    """直接查 alembic_version：不依赖 alembic 的日志输出，也便于脚本自己判成败。"""
    import pymysql

    u = urlsplit(url)
    conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username, password=u.password,
                           database=u.path.lstrip("/"), autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT table_name FROM information_schema.tables "
                        "WHERE table_schema = DATABASE() AND table_name = 'alembic_version'")
            if not cur.fetchall():
                return None
            cur.execute("SELECT version_num FROM alembic_version")
            row = cur.fetchone()
            return row[0] if row else None
    except pymysql.err.MySQLError:
        return None
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
