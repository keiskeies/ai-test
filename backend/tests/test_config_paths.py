"""配置里的路径必须与启动目录无关（1C 实测缺陷，非假想敌）。

缺陷现场：`artifacts_dir` 默认写的是 `backend/data/artifacts`（仓库根相对），
`env_file` 默认写的是 `.env`（同样是相对）。而三份 demo 手册教的起法都是
`cd backend; uvicorn app.server:app`（README-1a-demo.md:68 / README-1b-demo.md:74 /
README-s0-demo.md:51），于是同一个配置在两种 CWD 下指向两个地方：

- CWD=backend → 制品落到 `backend/backend/data/artifacts`（实测本机 46 个文件就是这么来的，
  `backend/data/artifacts` 从来就没存在过）；
- CWD=仓库根 → `.env` 根本读不到，TP_SECRET_KEY 之类**静默回落到代码默认值**。

两种都是「看起来在跑、其实读的是另一份东西」，而且制品 ref 是相对根存的
（`{run_id}/{uuid}.png`），server 与 worker 只要 CWD 不一致，就是 worker 写字节、
server 读不到。修法：配置里相对的路径一律按**仓库根**锚定，绝对路径原样尊重。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.core.config import (
    BACKEND_DIR,
    REPO_ROOT,
    Settings,
    get_settings,
    resolve_repo_path,
)


@pytest.fixture()
def clean_settings():
    """进出都清 lru_cache：get_settings 是缓存的，不清会把脏配置漏给后面的用例。"""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_anchor_constants_point_at_the_right_dirs() -> None:
    """BACKEND_DIR/REPO_ROOT 由 __file__ 反推，先钉住它们各自指向哪。"""
    assert BACKEND_DIR.name == "backend"
    assert (BACKEND_DIR / "app" / "core" / "config.py").is_file()
    assert REPO_ROOT == BACKEND_DIR.parent
    assert (REPO_ROOT / "web").is_dir()


def test_default_artifacts_dir_is_repo_root_relative(clean_settings) -> None:
    """默认值照旧写 `backend/data/artifacts`（文档与 .env 都这么写），语义改为「相对仓库根」。"""
    assert get_settings().artifacts_dir == "backend/data/artifacts"
    root = resolve_repo_path(get_settings().artifacts_dir)
    assert root == REPO_ROOT / "backend" / "data" / "artifacts"


def test_relative_artifacts_dir_does_not_drift_with_cwd(tmp_path, monkeypatch, clean_settings) -> None:
    """本缺陷的正身：从任何目录启动，相对配置都必须解析到同一个绝对路径。"""
    expected = REPO_ROOT / "backend" / "data" / "artifacts"
    for cwd in (tmp_path, BACKEND_DIR, REPO_ROOT):
        monkeypatch.chdir(cwd)
        get_settings.cache_clear()
        assert resolve_repo_path(get_settings().artifacts_dir) == expected, f"CWD={cwd} 漂了"
    # 反向钉：绝不允许解析到 CWD 下面去（`backend/backend/data` 就是这么长出来的）
    assert not str(expected).startswith(str(tmp_path))


def test_absolute_artifacts_dir_is_respected_verbatim(tmp_path, clean_settings) -> None:
    """给了绝对路径就别再前缀仓库根——生产用环境变量指到数据盘是正路。"""
    target = tmp_path / "srv" / "artifacts"
    assert resolve_repo_path(str(target)) == target.resolve()


def test_env_file_is_absolute_so_cwd_cannot_silently_drop_it() -> None:
    """`.env` 写相对路径的后果比制品更阴：读不到不报错，只是所有键静默回落默认值。

    钉结构不钉内容：`.env` 不入库（.gitignore:13），每台机器内容不同，
    断言「它被读到」会把测试绑到某个人的开发机上。
    """
    env_file = Settings.model_config["env_file"]
    assert env_file, "env_file 不能清空，否则等于放弃本地配置"
    p = Path(env_file)
    assert p.is_absolute(), f"env_file 必须是绝对路径，现在是相对的：{env_file}"
    assert p == BACKEND_DIR / ".env"
