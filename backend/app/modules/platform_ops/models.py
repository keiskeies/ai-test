"""平台运维域（D203）：服务集成 / 资源池 / 插件登记（三张项目级表）。

三条边界写在这里，防止「登记表」被读成「已接上」：

- `service_integration` 只存配置（token 走 Fernet），**本刀不发任何出站请求**。
  MS 的「测试连通」要服务器主动打用户填的 URL，那是 SSRF 面；做它要另开一套
  域名白名单 + 禁内网地址的校验，不属于这张表的交付。
- `resource_pool` 只登记容量与启停；**调度器仍是一个 Celery worker**。
  有行不等于有消费者 —— 台账里明写。
- `plugin` 只登记清单（名称/类型/版本/配置 JSON）；**没有装载点**。
  协议与断言仍硬编码在 `shared/assertions.py`，这里不做动态 import（任意代码执行是独立安全题）。
"""
from __future__ import annotations

from sqlalchemy import Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id

INTEGRATION_KINDS: tuple[str, ...] = ("github", "gitlab", "gitee")
POOL_KINDS: tuple[str, ...] = ("api", "ui", "adb", "local")
PLUGIN_KINDS: tuple[str, ...] = ("protocol", "assertion")


class ServiceIntegration(ProjectScopedMixin, TimestampMixin, Base):
    """三方服务配置（C4）。名称项目内唯一；token 加密存储、回显只给末 4 位。"""

    __tablename__ = "service_integration"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_service_integration_project_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class ResourcePool(ProjectScopedMixin, TimestampMixin, Base):
    """执行资源池（C6）。容量只是登记值；调度消费者未接（模块 docstring）。"""

    __tablename__ = "resource_pool"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_resource_pool_project_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(24), nullable=False, default="local")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class Plugin(ProjectScopedMixin, TimestampMixin, Base):
    """插件清单（C7）。登记 ≠ 装载；没有 import 入口。"""

    __tablename__ = "plugin"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_plugin_project_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[str] = mapped_column(String(24), nullable=False, default="protocol")
    version: Mapped[str] = mapped_column(String(32), nullable=False, default="1.0.0")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    config: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
