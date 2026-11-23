"""通知渠道 schema（§11.4.26，1E T2）。

config 是自由 dict（五类渠道键不同：url/access_token、smtp_host/…），字段口径校验在
service 体（type 枚外 422 走 CHANNEL_TYPES，schema 层不收窄——枚举加一类只改 models
一处，schema 不跟着抄一份，防「两处枚举漂移」）。
"""
from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field


def iso(dt: datetime | None) -> str | None:
    """datetime → 带时区偏移的 ISO；None 透传（adb_test/ui_test schemas 同款）。"""
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class ChannelCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: str = Field(min_length=1, max_length=16)
    config: dict = Field(default_factory=dict)


class ChannelListIn(BaseModel):
    type: str | None = None  # 过滤：五型之一；枚外值按「查不到」处理（读类不设 422）
    # D243：高级搜索条件（JSON 串，形状同 shared/filters.py）。与 type 快捷轴并行
    # AND；空串 = 没筛选，坏条件 400 且 message 带本页可筛清单。
    filter: str | None = None
    cursor: str | None = None
    # current（D47-b）：页码分页入口，MS 页脚的 {current, pageSize, total} 口径。
    # None = 键集/游标路径；与 cursor 互斥，两者同时到场在 handler 里 400（判据同 report_list）。
    current: int | None = None
    size: int = Field(default=50, ge=1, le=200)


class ChannelGetIn(BaseModel):
    channel_id: str


class ChannelUpdateIn(BaseModel):
    channel_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    # 改 config = 整体重加密入库；值等于当前打码回显的键视为「没改」，保留旧密文
    config: dict | None = None


class ChannelOut(BaseModel):
    id: str
    name: str
    type: str
    config: dict  # 逐键打码后的回显（D24），永不含明文或密文原值
    last_send: dict | None = None
    created_at: str | None = None
    updated_at: str | None = None


class ChannelTestOut(BaseModel):
    ok: bool
    latency_ms: int = 0
    error: str | None = None
    raw: str | None = None  # §11.4.26「原始响应」列
    last_send: dict | None = None
