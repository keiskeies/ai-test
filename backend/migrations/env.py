"""Alembic 环境：URL 优先配置项，其次 TP_ALEMBIC_URL，最后 app 配置（async 驱动换 pymysql）。"""
from __future__ import annotations

import importlib
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.core.db import Base

# 导入各模块 models 以便 autogenerate 感知（模块尚未建立时跳过）。
# 清单落后过两个批次：scenario（1B）与 search（1B 的读侧）一直没进来，autogenerate
# 对它们生成的 diff 是「这张表该删掉」——照现状补全，并把 1C 的 ui_test 加进来。
for _m in (
    "iam", "env", "api_test", "audit", "model_cfg", "agent", "scenario", "search", "ui_test", "adb_test",
    # 1E T0：schedule_task/kv_setting 与 notify_channel 进 autogenerate 感知清单——
    # 不进清单，autogenerate 对它们生成的 diff 就是「这张表该删掉」（清单落后两个批次的旧教训）。
    "schedule", "notify",
):
    try:
        importlib.import_module(f"app.modules.{_m}.models")
    except ImportError:
        pass

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

url = config.get_main_option("sqlalchemy.url") or ""
if not url or url.startswith("driver://"):
    url = os.environ.get("TP_ALEMBIC_URL", "")
if not url:
    from app.core.config import get_settings

    url = get_settings().db_url.replace("+asyncmy", "+pymysql")
config.set_main_option("sqlalchemy.url", url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True,
                      dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}), prefix="sqlalchemy.", poolclass=pool.NullPool
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
