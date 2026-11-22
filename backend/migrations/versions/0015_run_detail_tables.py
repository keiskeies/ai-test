"""run_step_result + run_artifact + run_event（§4.6 + 计划 R47）。

row_no 必须 NOT NULL DEFAULT 0：MySQL 唯一键不判等 NULL，用 NULL 表达「非数据集
行」会让 uq(run_id, step_key, row_no) 形同虚设，重跑一次多一行脏数据。
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES = ("run_step_result", "run_artifact", "run_event")


def upgrade() -> None:
    op.create_table(
        "run_step_result",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), nullable=False, index=True),
        sa.Column("step_key", sa.String(64), nullable=False),
        sa.Column("row_no", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("parent_step_key", sa.String(64), nullable=True),
        sa.Column("subject_name", sa.String(200), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("elapsed_ms", sa.Integer(), nullable=True),
        sa.Column("row_total", sa.Integer(), nullable=True),
        sa.Column("detail", sa.JSON(), nullable=True),
        sa.Column("vars_snapshot", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("run_id", "step_key", "row_no", name="uq_step_run_key_row"),
    )
    op.create_table(
        "run_artifact",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), nullable=False, index=True),
        sa.Column("step_key", sa.String(64), nullable=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("ref", sa.String(500), nullable=False),
        sa.Column("bytes", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "run_event",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), nullable=False, index=True),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(24), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("ts", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("run_id", "seq", name="uq_event_run_seq"),
    )


def downgrade() -> None:
    # 逆序 drop；只动这三张表，不碰 run_record（测试专门钉了这条）
    for t in reversed(_TABLES):
        op.drop_table(t)
