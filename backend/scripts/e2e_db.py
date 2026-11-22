"""e2e 前置：确保 TP_DB_URL 指向的库存在且已迁移到 head。幂等。"""
from __future__ import annotations

import os
import subprocess
import sys
from urllib.parse import urlsplit

import pymysql


def main() -> int:
    url = os.environ["TP_DB_URL"]
    u = urlsplit(url)
    db = u.path.lstrip("/").split("?")[0]
    conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username, password=u.password, autocommit=True)
    with conn.cursor() as cur:
        cur.execute("CREATE DATABASE IF NOT EXISTS `" + db + "` CHARACTER SET utf8mb4")
    conn.close()
    print("[e2e_db] database ready:", db)
    r = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], capture_output=True, text=True)
    print(r.stdout[-300:], r.stderr[-300:])
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
