"""run_record 升级为报告主体（§4.6）+ trigger 词表归一（计划 R46）。

新增 7 列全部可空：1A 的调试记录不回填，读出来就是 None/0，因此不需要数据
回填脚本，也就不存在「升级即损坏老数据」的风险窗口。

trigger 归一：库里从不写 'case'（api_debug 只写 debug/agent），但 RunListIn 曾
允许它、同时拒绝模型自己声明的 manual/webhook。把历史残留的 'case' 归到
'manual'，让「写入」与「过滤」共用同一张词表。

down 逐列 drop，顺序与 up 相反（§13 纪律 3）。
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (列名, 类型, server_default)：非空列一律带库级默认，与全仓惯例一致；down 按逆序 drop
_COLUMNS: list[tuple[str, sa.types.TypeEngine, str | None]] = [
    ("started_at", sa.DateTime(), None),
    ("finished_at", sa.DateTime(), None),
    ("stats", sa.JSON(), None),
    ("summary_graph", sa.JSON(), None),
    ("lease_owner", sa.String(64), None),
    ("cancel_requested", sa.SmallInteger(), "0"),
    ("max_runtime_ms", sa.Integer(), None),
]


def upgrade() -> None:
    for name, typ, default in _COLUMNS:
        op.add_column("run_record", sa.Column(name, typ, nullable=True, server_default=default))
    # 注意：**不**清掉 server_default。全仓 20+ 处非空列都保留库级默认（见 0008/0012/0013），
    # 清掉会让任何绕过 ORM 的裸 SQL 插入报 1364（T2 的迁移往返测试当场抓到踩过一次）。
    # trigger 是 MySQL 保留字，裸 SQL 必须加反引号
    op.execute("UPDATE run_record SET `trigger` = 'manual' WHERE `trigger` = 'case'")


def downgrade() -> None:
    for name, _, _ in reversed(_COLUMNS):
        op.drop_column("run_record", name)
