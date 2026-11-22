"""模型配置（§4.8 S0 子集）：api_key Fernet 加密，CHAT 唯一默认。"""
from __future__ import annotations

from sqlalchemy import JSON, Boolean, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, new_id


class ModelConfig(TimestampMixin, Base):
    __tablename__ = "model_config"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    model_type: Mapped[str] = mapped_column(String(16), nullable=False, default="CHAT")  # CHAT/EMBEDDING
    protocol: Mapped[str] = mapped_column(String(24), nullable=False, default="OPENAI_COMPAT")
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    model_name: Mapped[str] = mapped_column(String(200), nullable=False)
    api_key_enc: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    context_window: Mapped[int] = mapped_column(Integer, nullable=False, default=32768)
    max_output: Mapped[int] = mapped_column(Integer, nullable=False, default=4096)
    supports_thinking: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    thinking_levels: Mapped[list | None] = mapped_column(JSON, nullable=True)
    supports_vision: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    supports_tools: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    temperature_default: Mapped[float | None] = mapped_column(Float, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    embed_dimensions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    probe_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
