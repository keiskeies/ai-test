"""UI 测试资产模型（§4.4 + 计划 T2）：UiModule + UiElement + UiCase。

三表同族于 scenario/api_test：软删两态（R53）、project 内同名唯一、无外键（全库无外键，
级联显式编码）。ui_module 是 R99 的第三棵树——独立于 api_module / scenario_module，
因为权限点与引用完整性不共享（接口的模块回收不该动到元素）。

元素是**扁平命名空间**（uq_ui_element_project_name 不含 module_id）：§11.5.4 的列表没有
「同模块可同名」的迹象，而引用检测要按名字找人——同名跨模块会让 409 的引用清单变成谜题。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Integer, SmallInteger, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id

PRIORITIES = ("P0", "P1", "P2", "P3")

# 软删两态，与场景/接口同族（R53）
STATUS_NORMAL = "normal"
STATUS_RECYCLED = "recycled"

# 定位器一期词表（R100 / 业主裁决 D2）。**小写入库**，与全站 status 词表一致；
# §4.4 表里写的是大写枚举名（ID/CSS/XPATH/TEXT/NAME），映射就是这一行。
# 蓝图 §4.4 说 5 种、§6.3 说「六类型」——这是蓝图自相矛盾，已在计划 D2 提请裁决；
# 一期实现表的 5 种，第 6 种（候选 placeholder）等业主点名，不偷偷加。
LOCATOR_TYPES = ("id", "css", "xpath", "text", "name")


class UiModule(ProjectScopedMixin, TimestampMixin, Base):
    """元素/用例的模块树（R99 第三棵树，权限与引用完整性独立）。"""

    __tablename__ = "ui_module"
    __table_args__ = (UniqueConstraint("project_id", "parent_id", "name", name="uq_ui_module_parent_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)
    # 根层（parent_id IS NULL）重名 DB 管不住：MySQL 唯一键不判等 NULL，服务层自查
    # （照 0016 的原话，别在这里假称约束覆盖了根层）。


class UiElement(ProjectScopedMixin, TimestampMixin, Base):
    """页面元素（§4.4）：一个定位器 + 一个人类可读名，被 UI 用例按 id 引用。"""

    __tablename__ = "ui_element"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_ui_element_project_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    # 不设外键（全库无外键）：模块回收不删元素，模块彻底删除后 module_id 置 None
    module_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    locator_type: Mapped[str] = mapped_column(String(16), nullable=False)  # LOCATOR_TYPES 之一
    locator: Mapped[str] = mapped_column(String(500), nullable=False)
    comment: Mapped[str | None] = mapped_column(String(500), nullable=True)
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # 两列都必须建：visibility.py 读的是 getattr(row, "project_public", True)，
    # 漏建不报错而等于「每一行都公开」——那是静默失效，test_ui_models 钉着。
    project_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class UiCase(ProjectScopedMixin, TimestampMixin, Base):
    """UI 用例（§4.4 + §11.5.4）：一条扁平的命令列表（§7.2 协议）+ 执行元信息。"""

    __tablename__ = "ui_case"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_ui_case_project_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    module_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    priority: Mapped[str] = mapped_column(String(4), nullable=False, default="P2")
    # §11.5.4 列表有「启用」列：停用的用例在场景里跳过执行（与 1B 的 disable 同语义）
    enabled: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    steps: Mapped[list] = mapped_column(JSON, nullable=False)  # §7.2 命令数组（扁平，无树）
    env_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    project_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)
    step_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # 冗余计数，列表不 N+1
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_run_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # R104：**没有 version**（不做乐观锁，与 ApiCase 对齐）。加它要走批次决定，
    # tests/test_ui_models.py::test_ui_case_has_no_version_column 钉着这条决定。
