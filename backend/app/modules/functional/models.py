"""功能用例域（D193）：`functional_case` + 第 5 份模块树 + 自定义值。

D185 计划的最小闭环在 D192 之后才成立：模板/取号已是全项目共用的地基。
本域**只做用例本体**（评审在 D194）；附件/需求关联仍是后续域。
脑图（D268）只加一张便签表 `functional_minder_note`，用例/模块树不动。

主动口径（与 D185 §五 的三条 MS 教训一致）：
- 状态只有 normal/recycled 一个轴（回收站），没有 MS 的 ARCHIVED/多版本族。
- 每张表每列都答得出谁写谁读；`ref_id`/`version_id`/`public_case` 一律不建。
- 编号 `num` 项目内唯一（DB 唯一键），id 是机器标识、num 是人读编号，不混用。
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, UtcDateTime, new_id

PRIORITIES: tuple[str, ...] = ("P0", "P1", "P2", "P3")
STATUS_NORMAL = "normal"
STATUS_RECYCLED = "recycled"


class FunctionalModule(ProjectScopedMixin, TimestampMixin, Base):
    """功能用例专用模块树（第 5 份，与 api/scenario/ui/adb 四棵同形但不合并）。"""

    __tablename__ = "functional_module"
    __table_args__ = (
        UniqueConstraint("project_id", "parent_id", "name", name="uq_functional_module_parent_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)


class FunctionalCase(ProjectScopedMixin, TimestampMixin, Base):
    """用例本体。`template_id` NOT NULL（与 MS 同形；D192 模板地基）。"""

    __tablename__ = "functional_case"
    __table_args__ = (
        UniqueConstraint("project_id", "num", name="uq_functional_case_project_num"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    num: Mapped[int] = mapped_column(Integer, nullable=False)
    module_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    template_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    priority: Mapped[str] = mapped_column(String(4), nullable=False, default="P2")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL, index=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class FunctionalCaseCustomField(Base):
    """用例自定义字段值（EAV，JSON 文本；同缺陷值表）。"""

    __tablename__ = "functional_case_custom_field"

    case_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    field_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


class FunctionalCaseComment(TimestampMixin, Base):
    """功能用例评论（两层嵌套；父删连子删）。"""

    __tablename__ = "functional_case_comment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    case_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    reply_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_by: Mapped[str] = mapped_column(String(36), nullable=False)


class FunctionalCaseFollower(Base):
    """用例关注人（D234）：真相是「这一行在不在」，不建 followed 冗余列。

    复合主键 (case_id, user_id)：同一人对同一条用例只有一行；`project_id` 冗余是为了
    「我关注的」列表能直接按项目过滤，与 D231 的 plan_follower 同形。用例删除时同事务删净。
    """

    __tablename__ = "functional_case_follower"

    case_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        UtcDateTime(), nullable=False, default=lambda: datetime.now(UTC))


class FunctionalMinderNote(ProjectScopedMixin, Base):
    """脑图便签节点（D268，对齐 MS 的「空白节点」/`minder_extra_node`）。

    只挂在模块（`functional_module`）或其他便签之下，用来在脑图里写字组织思路；
    **用例仍只属于模块**（`functional_case.module_id` 指模块），便签不承载用例——
    这与 MS 的边界一致（MS 的用例也只挂模块，空白节点是并列的笔记层）。
    便签没有回收站：删便签连子便签一起删；它下面若还有模块/用例，服务层 409 拒绝。
    """

    __tablename__ = "functional_minder_note"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class FunctionalCaseRelation(Base):
    """用例前后置关系边（有向；relation_type ∈ predecessor/successor）。

    `from_case_id` 的前置/后置是 `to_case_id`。同一个有向边只存一条；反向边由查询时按
    relation_type 解释，不双写（MS 用 graph_id 做图合并，我们没有图合并需求，不建那层）。
    """

    __tablename__ = "functional_case_relation"
    __table_args__ = (
        UniqueConstraint("project_id", "from_case_id", "to_case_id", name="uq_functional_case_relation"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    from_case_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    to_case_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    relation_type: Mapped[str] = mapped_column(String(16), nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)
