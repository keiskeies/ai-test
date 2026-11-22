"""D187 步 1：defect + defect_case_link（缺陷本体 + 关联用例）。

**两张表，不是四张**（计划 §四 同日勘误）：状态词表与转移边表是
`app/modules/defect/models.py` 的常量（`DEFECT_STATUSES` / `DEFECT_TRANSITIONS`），
理由与将来要「每项目自定义状态」时的升级路径都写在那份文件头部。本文件因此**没有任何
状态相关表**——写一条 INSERT 进去的都没有（全仓 27 个迁移零 DML 的先例继续保持）。

时刻列走 DateTime（模型侧 UtcDateTime 存 UTC naive），与 0020–0026 同型。
无外键（全库纪律）：级联两条链在应用层同事务兑现，逐列「谁写/谁读」见 models.py 各类 docstring。
非空列带库级默认（0014 注的全仓惯例）：`status`/`priority` 的默认值由模型给出，
库级默认只是形状约束 —— 但 `recycled` 必须带，因为它是每处列表谓词都要比的列，
库级 0 让「历史行」与「新行」在 SQL 侧同形。
两列口径在本文件额外点名：
- `defect.recycled`（不是 `status`）= 回收站轴：缺陷有「工作流 + 回收站」两个轴，
  一列装不下，`status` 让给工作流（models.py 的 `status` 列有完整理由，含
  `api_definition.status` 装业务态的先例）。这是对计划 §三 第 4 条的**已裁偏离**。
- `defect` **没有** `uq(project_id, title)`：标题不是标识符，同项目同名是真实场景
  （models.py `title` 列处）。关联表的唯一键反过来**必须有**，MS 缺它导致重复插（取证 §D）。
down 序列从链尾往回（0026 先例）：本条 down 先 drop 明细、再 drop 头。
down 在临时库真跑 upgrade → downgrade -1 → upgrade（`scripts/check_migration_down.py 0027`，
真去真回）；demo 库禁跑（禁令）。

Revision ID: 0027
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = ("defect", "defect_case_link")


def upgrade() -> None:
    op.create_table(
        "defect",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("title", sa.String(200), nullable=False),
        # 纯文本描述（富文本需要文件库，本仓没有；见 models.Defect.description）
        sa.Column("description", sa.Text(), nullable=True),
        # 工作流状态（词表 = models.DEFECT_STATUSES 常量，不在库里建行）
        sa.Column("status", sa.String(24), nullable=False, server_default="new", index=True),
        sa.Column("priority", sa.String(4), nullable=False, server_default="P2"),
        # 处理人可空：新建时还没决定谁来处理是真实状态（见 models.Defect.handle_user_id）
        sa.Column("handle_user_id", sa.String(36), nullable=True, index=True),
        # 回收站轴，与工作流状态分列（文件头点名项）
        sa.Column("recycled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "defect_case_link",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("defect_id", sa.String(36), nullable=False, index=True),
        sa.Column("case_id", sa.String(36), nullable=False, index=True),
        # 词表 = models.DEFECT_CASE_TYPES（只收已有主体的用例类型；功能用例等 D185 落地再加）
        sa.Column("case_type", sa.String(24), nullable=False),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        # DDL 层去重：MS 靠代码去重且两套口径不同 ⇒ 同一对可重复插（取证 §D），我们不许
        sa.UniqueConstraint("defect_id", "case_id", "case_type", name="uq_defect_case_link_defect_case"),
    )


def downgrade() -> None:
    # 无外键（全库纪律），drop 即回退。先脱明细再脱头（链尾顺序），互不悬空。
    for t in reversed(_NEW):
        op.drop_table(t)
