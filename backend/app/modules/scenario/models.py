"""场景资产模型（§4.6 scenario / §11.4.8）：Scenario + ScenarioModule。"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Index, Integer, SmallInteger, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id

PRIORITIES = ("P0", "P1", "P2", "P3")

# 软删只有两态（R53）：场景/模块回收站语义与接口/用例同族。
STATUS_NORMAL = "normal"
STATUS_RECYCLED = "recycled"


class Scenario(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "scenario"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_scenario_project_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    # module_id 不设外键（全库无外键，级联显式编码）：模块回收不删场景（列表仍按未分类可见），
    # 模块彻底删除后场景的 module_id 置 None（module_services 里显式写）。
    module_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)
    priority: Mapped[str] = mapped_column(String(4), nullable=False, default="P2")
    step_graph: Mapped[dict] = mapped_column(JSON, nullable=False)  # §7.4 协议快照
    variables: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # 场景变量层（四层之一）
    fail_fast: Mapped[bool] = mapped_column(SmallInteger, nullable=False, default=True)
    max_runtime_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 空=全局默认（§8.2）
    # T20b 公共断言（场景级质量门）：执行期对**每一个发出请求的步骤**逐条求值（R88 语义修正，
    # 原先做成了「拓扑跑完对末步判一次」）。列本身与语义无关，故不需要新迁移。
    # 可空：NULL 与 [] 等价 = 不启用（老场景零行为变化）。
    common_assertions: Mapped[list | None] = mapped_column(JSON, nullable=True)
    env_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    project_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)  # 乐观锁（Review Focus 5）
    step_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # 冗余计数，列表不 N+1
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_run_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class ScenarioModule(ProjectScopedMixin, TimestampMixin, Base):
    """场景模块树节点（R45：独立于 api_module 的第二棵树，权限与引用完整性不共享）。"""

    __tablename__ = "scenario_module"
    __table_args__ = (UniqueConstraint("project_id", "parent_id", "name", name="uq_scenario_module_parent_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)


class ScenarioRevision(ProjectScopedMixin, Base):
    """场景变更历史（D262）：append-only 流水，一次成功的 update 落一行。

    `version` = 变更后的版本号（与 Scenario.version 同口径）；查询按 (version, id) 倒序，
    所以历史永远是「最新在前」，且同一版本不会重复（订单号式游标）。
    `changed` = 变更字段摘要列表（[{field, before, after}]），**只记非敏感摘要**：
    variables 只留键名、step_graph 只留步骤数——节点 config 与变量值里可能有 token/密码。
    行不可变：没有 update/delete 服务，级联只随场景彻底删除（purge）显式删净。
    """

    __tablename__ = "scenario_revision"
    __table_args__ = (Index("ix_scenario_revision_scenario_version", "scenario_id", "version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    scenario_id: Mapped[str] = mapped_column(String(36), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    changed: Mapped[list | None] = mapped_column(JSON, nullable=True)


def sc_now() -> datetime:
    """naive UTC（与 run_event.ts 同一口径：MySQL DATETIME 无时区，绑定 aware 值会被驱动截片）。"""
    return datetime.now(UTC).replace(tzinfo=None)
