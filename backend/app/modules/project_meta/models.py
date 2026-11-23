"""项目级元数据（D192）：模板 / 自定义字段 / 跨域取号。

**为什么单独开一个域**：模板与自定义字段同时服务缺陷、功能用例、接口、UI、测试计划
（MS 的 TemplateScene 五值），放进任何一个业务模块都会让其余模块跨域 import；取号器
同样被缺陷/用例/计划共用（MS 的 NumGenerator 在 system-setting）。所以定义表与取号表
归 `project_meta`，值表留在各自领域（`defect_custom_field` 等）——定义是共享的，值是
域内事实。

**与 MS 的主动差异**（D192 计划逐条登记）：
- DDL 层加唯一键：`(project_id, scene, name)`、`(project_id, field_key)`、
  `(template_id, field_id)`。MS 全靠 Java 查重，并发下能插重复（取证 §4c）。
- 删除有引用检查：默认模板 / 被缺陷引用的模板 / 被模板引用或被值引用的字段一律 409。
  MS 删模板留悬空 `template_id`、删字段留孤儿值行（取证 §4a/§4b）。
- 取号走 DB 单行原子 upsert，不是 Redis-only；Redis flush 会导致重号（取证 §5）。
"""
from __future__ import annotations

from sqlalchemy import Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id


class ProjectTemplate(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "project_template"
    __table_args__ = (
        UniqueConstraint("project_id", "scene", "name", name="uq_project_template_scene_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    scene: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # internal = 系统默认模板：名字不可改、不可删；is_default = 当前场景的默认选择（可切换）。
    # 两者分开：默认模板可以换成用户自建的，但系统模板仍留作「恢复默认」的锚点。
    internal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class ProjectCustomField(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "project_custom_field"
    __table_args__ = (
        UniqueConstraint("project_id", "scene", "field_key", name="uq_project_custom_field_key"),
        UniqueConstraint("project_id", "scene", "name", name="uq_project_custom_field_scene_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    scene: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # 稳定键：给 API/导入导出用；创建后不可改（值表里存的是 field id，键只影响人读与外部对接）。
    field_key: Mapped[str] = mapped_column(String(64), nullable=False)
    # 词表 = shared.custom_fields.FIELD_TYPES；**创建后不可改类型**（MS 允许改，旧值会静默失效）。
    type: Mapped[str] = mapped_column(String(24), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    internal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class ProjectCustomFieldOption(Base):
    """选项（下拉/单选/多选）。复合主键与 MS 同形；没有自己的 id/时间戳。"""

    __tablename__ = "project_custom_field_option"

    field_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    value: Mapped[str] = mapped_column(String(64), primary_key=True)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class ProjectTemplateField(ProjectScopedMixin, TimestampMixin, Base):
    """模板 ↔ 字段。`required` 与 `default_value` 是**模板级**属性（MS 同形）：同一字段在
    一个模板必填、在另一个模板可选。"""

    __tablename__ = "project_template_field"
    __table_args__ = (
        UniqueConstraint("template_id", "field_id", name="uq_project_template_field_pair"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    template_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    field_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    default_value: Mapped[str | None] = mapped_column(String(1500), nullable=True)


class NumSequence(TimestampMixin, Base):
    """项目内人读编号 `num` 的取号行（`(project_id, scene)` 一行）。

    分配走 `INSERT ... ON DUPLICATE KEY UPDATE next_num = LAST_INSERT_ID(next_num + 1)`
    （见 services.project_num_next）：单语句原子、与调用方同事务，失败回滚不会留下重号。
    `next_num` = **下一个将分配的值**；初始 100001（与 MS 的 INIT 一致）。
    """

    __tablename__ = "num_sequence"

    project_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scene: Mapped[str] = mapped_column(String(24), primary_key=True)
    next_num: Mapped[int] = mapped_column(Integer, nullable=False)
