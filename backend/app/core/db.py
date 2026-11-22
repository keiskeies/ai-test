"""数据库底座：Base / UtcDateTime / UUIDPk / get_db。

时刻约定（§3.4-6）：一律 UTC 存储，读取回来带 tzinfo=UTC。
"""
from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DateTime, String, TypeDecorator, func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


class UtcDateTime(TypeDecorator):
    """存 UTC naive（MySQL DATETIME 无时区），读回 attach UTC tzinfo。"""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC)


class UUIDPk(TypeDecorator):
    """CHAR(36) 承载 UUID 主键（ledger R5）。"""

    impl = String
    cache_ok = True

    def __init__(self, length: int = 36, **kw: Any) -> None:
        super().__init__(length=length, **kw)


def new_id() -> str:
    return str(uuid.uuid4())


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False, default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime(), nullable=False, default=lambda: datetime.now(UTC), onupdate=lambda: datetime.now(UTC)
    )


class ProjectScopedMixin(TimestampMixin):
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)


_engine = None
_maker: async_sessionmaker[AsyncSession] | None = None


def get_engine():
    global _engine, _maker
    if _engine is None:
        _engine = create_async_engine(get_settings().db_url, pool_pre_ping=True, pool_size=10, max_overflow=10)
        _maker = async_sessionmaker(bind=_engine, expire_on_commit=False, autoflush=False)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _maker is not None
    return _maker


async def get_db() -> AsyncIterator[AsyncSession]:
    assert _maker is not None
    async with _maker() as session:
        yield session


__all__ = ["Base", "UtcDateTime", "UUIDPk", "new_id", "TimestampMixin", "ProjectScopedMixin", "func", "get_db", "get_engine", "get_sessionmaker"]
