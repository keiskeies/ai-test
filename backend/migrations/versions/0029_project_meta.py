"""D192：项目级元数据（模板 / 自定义字段 / 跨域取号）+ 缺陷回填。

这是本仓**第一条带 DML 的迁移**（前 28 条零 INSERT）。理由不是偏好：`defect` 在 0027 已经
有行，而 D192 把 `template_id` / `num` 变成 NOT NULL —— 不给存量行回填默认模板与编号，
`ALTER ... NOT NULL` 直接失败。回填规则：

- 每个存量项目补 **5 个场景的系统默认模板**（functional/bug/api/ui/test_plan），
  只有 bug 场景会被立刻用到；其余场景等第一个写入方出现时已有默认模板可解析。
- 每个存量缺陷按 `(created_at, id)` 顺序取号，从 100001 起（与 MS 的 INIT 一致），
  同一项目的 `num_sequence.next_num` 记到「下一个可用」。
- 编号**不回收**：回收/恢复保持原号；彻底删除后号作废（MS 同语义）。

新项目不靠迁移：`project_template_list` / `project_template_resolve` 首次访问时惰性补默认模板，
`project_num_next` 的 upsert 首次调用即建号段行。所以迁移只处理「建表那一刻已经存在的数据」。

Revision ID: 0029
"""
from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision: str = "0029"
down_revision: str | None = "0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW = (
    "num_sequence",
    "project_template",
    "project_custom_field",
    "project_custom_field_option",
    "project_template_field",
    "defect_custom_field",
)
SCENES = (
    ("functional", "系统默认（功能用例）"),
    ("bug", "系统默认（缺陷）"),
    ("api", "系统默认（接口）"),
    ("ui", "系统默认（UI）"),
    ("test_plan", "系统默认（测试计划）"),
)
NUM_INIT = 100001


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def upgrade() -> None:
    op.create_table(
        "num_sequence",
        sa.Column("project_id", sa.String(36), primary_key=True),
        sa.Column("scene", sa.String(24), primary_key=True),
        sa.Column("next_num", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "project_template",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("scene", sa.String(24), nullable=False, index=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("internal", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false(), index=True),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "scene", "name", name="uq_project_template_scene_name"),
    )
    op.create_table(
        "project_custom_field",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("scene", sa.String(24), nullable=False, index=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("field_key", sa.String(64), nullable=False),
        sa.Column("type", sa.String(24), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("internal", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("project_id", "scene", "field_key", name="uq_project_custom_field_key"),
        sa.UniqueConstraint("project_id", "scene", "name", name="uq_project_custom_field_scene_name"),
    )
    op.create_table(
        "project_custom_field_option",
        sa.Column("field_id", sa.String(36), primary_key=True),
        sa.Column("value", sa.String(64), primary_key=True),
        sa.Column("label", sa.String(255), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "project_template_field",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("template_id", sa.String(36), nullable=False, index=True),
        sa.Column("field_id", sa.String(36), nullable=False, index=True),
        sa.Column("required", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("sort", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("default_value", sa.String(1500), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("template_id", "field_id", name="uq_project_template_field_pair"),
    )
    op.create_table(
        "defect_custom_field",
        sa.Column("defect_id", sa.String(36), primary_key=True),
        sa.Column("field_id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(36), nullable=False, index=True),
        sa.Column("value", sa.Text(), nullable=False),
    )

    op.add_column("defect", sa.Column("num", sa.Integer(), nullable=True))
    op.add_column("defect", sa.Column("template_id", sa.String(36), nullable=True))

    # —— 回填（本仓第一条迁移 DML；理由见文件头）——
    bind = op.get_bind()
    now = _now()
    project_ids = [r[0] for r in bind.execute(sa.text("SELECT id FROM project")).all()]
    bug_template: dict[str, str] = {}
    for pid in project_ids:
        for scene, name in SCENES:
            tid = str(uuid.uuid4())
            bind.execute(sa.text(
                "INSERT INTO project_template (id, project_id, scene, name, description, internal,"
                " is_default, sort, created_by, updated_by, created_at, updated_at)"
                " VALUES (:id, :p, :s, :n, :d, 1, 1, 0, NULL, NULL, :now, :now)"
            ), {"id": tid, "p": pid, "s": scene, "n": name,
                "d": "系统创建；字段与默认值可改，不可删除/改名", "now": now})
            if scene == "bug":
                bug_template[pid] = tid
        bind.execute(sa.text(
            "INSERT INTO num_sequence (project_id, scene, next_num, created_at, updated_at)"
            " VALUES (:p, 'bug', :n, :now, :now)"
        ), {"p": pid, "n": NUM_INIT, "now": now})

    defects = bind.execute(sa.text(
        "SELECT id, project_id FROM defect ORDER BY project_id, created_at, id"
    )).all()
    counters: dict[str, int] = {}
    for defect_id, pid in defects:
        n = counters.get(pid, NUM_INIT)
        counters[pid] = n + 1
        bind.execute(sa.text(
            "UPDATE defect SET num = :n, template_id = :t WHERE id = :id"
        ), {"n": n, "t": bug_template[pid], "id": defect_id})
    for pid, next_num in counters.items():
        bind.execute(sa.text(
            "UPDATE num_sequence SET next_num = :n WHERE project_id = :p AND scene = 'bug'"
        ), {"n": next_num, "p": pid})

    op.alter_column("defect", "num", existing_type=sa.Integer(), nullable=False)
    op.alter_column("defect", "template_id", existing_type=sa.String(36), nullable=False)
    op.create_unique_constraint("uq_defect_project_num", "defect", ["project_id", "num"])
    op.create_index("ix_defect_template_id", "defect", ["template_id"])


def downgrade() -> None:
    op.drop_index("ix_defect_template_id", table_name="defect")
    op.drop_constraint("uq_defect_project_num", "defect", type_="unique")
    op.drop_column("defect", "template_id")
    op.drop_column("defect", "num")
    for t in reversed(_NEW):
        op.drop_table(t)
