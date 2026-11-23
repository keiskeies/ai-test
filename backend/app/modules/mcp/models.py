"""MCP 服务登记（§4.10 mcp_server）：transport 配置 + 工具发现缓存 + 在线状态。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, UtcDateTime, new_id


class McpServer(TimestampMixin, Base):
    __tablename__ = "mcp_server"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    # stdio / sse / http（streamable HTTP）
    transport: Mapped[str] = mapped_column(String(16), nullable=False, default="stdio")
    command: Mapped[str | None] = mapped_column(String(500), nullable=True)
    args: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # 环境变量整串 Fernet 加密（含值）；回显只给键名，见 services._out
    env_enc: Mapped[str | None] = mapped_column(String(4000), nullable=True)
    url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    headers_enc: Mapped[str | None] = mapped_column(String(4000), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # online / offline / disabled：disabled 由 enabled=False 推导，落库值给最近一次探测结果
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="offline")
    # [{name, description, input_schema}]：发现结果缓存，列表页免实时连接
    tool_cache: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # 逐工具 effect 覆写：{原始工具名: "read"|"write"}；缺省按 write（保守）
    tool_effects: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    last_latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
