"""定时任务 schema（§11.4.17，1E T1）。

形状口径：
- cron 是自由字符串进、422 出——形状校验（先数段数、再 crontab()）住在 service
  （`_check_cron`，2026-11-16 实测的形状修正：4 段被 celery 静默补位、6 段抛 TypeError，
  两头都不许进库）；schema 层不重复解析，防止两处校验漂移。
- subject_type 一期只放 scenario（D30）：白名单在 service 把守（显式拒绝不静默改值）。
- next_5 预览读**未落库**的草稿 cron（抽屉里预览发生在保存前），base 可选：
  缺省=当前时刻；传 ISO 串供测试钉确定性。
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class TaskCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    subject_type: str = Field(min_length=1, max_length=24)
    subject_id: str = Field(min_length=1, max_length=36)
    cron: str = Field(min_length=1, max_length=64)
    env_id: str | None = None
    enabled: int = Field(default=1, ge=0, le=1)
    notify_channel_ids: list[str] = Field(default_factory=list)


class TaskListIn(BaseModel):
    project_id: str
    enabled: int | None = Field(default=None, ge=0, le=1)  # 过滤：1 只看启用 / 0 只看停用
    cursor: str | None = None
    # current（D47-b）：页码分页入口，MS 页脚的 {current, pageSize, total} 口径。
    # None = 键集/游标路径；与 cursor 互斥，两者同时到场在 handler 里 400（判据同 report_list）。
    current: int | None = None
    size: int = Field(default=50, ge=1, le=200)


class TaskGetIn(BaseModel):
    project_id: str
    task_id: str


class TaskUpdateIn(BaseModel):
    project_id: str
    task_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    subject_type: str | None = Field(default=None, min_length=1, max_length=24)
    subject_id: str | None = Field(default=None, min_length=1, max_length=36)
    cron: str | None = Field(default=None, min_length=1, max_length=64)
    env_id: str | None = None
    enabled: int | None = Field(default=None, ge=0, le=1)
    notify_channel_ids: list[str] | None = None


class TaskOut(BaseModel):
    id: str
    project_id: str
    name: str
    subject_type: str
    subject_id: str
    cron: str
    env_id: str | None = None
    enabled: int
    notify_channel_ids: list[str] = Field(default_factory=list)
    last_run: dict | None = None
    consecutive_failures: int = 0
    created_at: str | None = None
    updated_at: str | None = None


class Next5In(BaseModel):
    project_id: str
    cron: str = Field(min_length=1, max_length=64)
    base: str | None = None  # ISO 8601（naive 视为 UTC）；缺省 = 当前时刻。预览未保存草稿用


class Next5Out(BaseModel):
    cron: str
    times: list[str]  # 5 个严格递增的触发时刻，ISO 带 +08:00 偏移（Shanghai 日历，§3.4-6）
