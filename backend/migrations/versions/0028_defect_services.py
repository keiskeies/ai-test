"""D191：缺陷域服务接线（回收站展示位 + 标签 + 关注人 + 评论）。

D190 对账裁定「50 端点里 25 条不依赖地基」，本迁移是那 25 条的服务面所需的最小表形状：

- `defect` 加三列：`tags`（逗号分隔，MS 同形）、`delete_user`/`delete_time`
  （回收站两列展示位；恢复时**清空**，不复制 MS「永久留着上一次删除」的病）。
- `title` 200 → 255：与 MS 前端 maxLength 和 `@Size(1,255)` 对齐（D190 §2.1）。
- 新表 `defect_follower`：复合主键 (defect_id, user_id)，MS 同形；**权限用写位**（不改 MS 的 READ）。
- 新表 `defect_comment`：两层嵌套（parent_id 为空 = 顶层），不建 notifier（富文本 @ 未落地）。

无外键（全库纪律）：彻底删除的三条级联在 `defect/services.py::_purge_one` 同事务兑现。

Revision ID: 0028
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0028"
down_revision: str | None = "0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("defect_follower", "defect_comment")


def upgrade() -> None:
    op.alter_column("defect", "title", existing_type=sa.String(200), type_=sa.String(255),
                    existing_nullable=False)
    op.add_column("defect", sa.Column("tags", sa.String(1000), nullable=True))
    op.add_column("defect", sa.Column("delete_user", sa.String(36), nullable=True))
    op.add_column("defect", sa.Column("delete_time", sa.DateTime(), nullable=True))

    op.create_table(
        "defect_follower",
        sa.Column("defect_id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "defect_comment",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("defect_id", sa.String(36), nullable=False, index=True),
        sa.Column("parent_id", sa.String(36), nullable=True, index=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("reply_user_id", sa.String(36), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    for t in reversed(_NEW):
        op.drop_table(t)
    op.drop_column("defect", "delete_time")
    op.drop_column("defect", "delete_user")
    op.drop_column("defect", "tags")
    op.alter_column("defect", "title", existing_type=sa.String(255), type_=sa.String(200),
                    existing_nullable=False)
