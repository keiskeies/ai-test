"""任务中心 schemas（D196）：运行/排队观测与停止、重跑。"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

RUN_STATUSES = ("queued", "running", "passed", "failed", "error", "cancelled")
TERMINAL = ("passed", "failed", "error", "cancelled")
_STATUS_PATTERN = "^(" + "|".join(RUN_STATUSES) + ")$"


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class TaskSummaryIn(BaseModel):
    project_id: str


class TaskSummaryOut(BaseModel):
    total: int = 0
    queued: int = 0
    running: int = 0
    passed: int = 0
    failed: int = 0
    error: int = 0
    cancelled: int = 0
    active: int = 0
    pass_rate: float = 0
    avg_elapsed_ms: int | None = None


class TaskListIn(BaseModel):
    project_id: str
    state: Literal["active", "finished"] | None = None
    subject_type: str | None = Field(default=None, max_length=24)
    trigger: str | None = Field(default=None, max_length=16)
    keyword: str | None = Field(default=None, max_length=200)
    # D239：高级搜索条件组（JSON 串，形状见 shared/filters.py）。与上面各快捷筛选并行 AND；
    # 条件在分页之前生效（翻页接着筛出来的集合走），不是页内过滤。
    filter: str | None = None
    current: int = Field(default=1, ge=1)
    size: int = Field(default=20, ge=1, le=200)


class TaskOut(BaseModel):
    id: str
    project_id: str
    subject_type: str
    subject_id: str
    subject_name: str
    env_name: str | None = None
    trigger: str
    status: str
    elapsed_ms: int | None = None
    error: str | None = None
    created_by: str | None = None
    created_by_name: str | None = None
    created_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    cancel_requested: bool = False
    queue_position: int | None = None
    can_stop: bool = False
    can_rerun: bool = False


class TaskListOut(BaseModel):
    items: list[TaskOut] = []


class TaskQueueIn(BaseModel):
    project_id: str


class TaskQueueOut(BaseModel):
    available: bool = True
    queue_length: int = 0
    items: list[TaskOut] = []


class TaskGetIn(BaseModel):
    project_id: str
    run_id: str


class TaskDetailOut(TaskOut):
    stats: dict[str, Any] | None = None
    step_counts: dict[str, int] = {}


class TaskStopIn(BaseModel):
    project_id: str
    run_id: str


class TaskStopOut(BaseModel):
    ok: bool = True
    status: str


class TaskRerunIn(BaseModel):
    project_id: str
    run_id: str


class TaskRerunOut(BaseModel):
    run_id: str
    status: str = "queued"


class TaskBatchStopIn(BaseModel):
    """D237：批量停止（对齐 MS `/task/center/stop/batch`）。上限 100 与其它批处理一致。"""

    project_id: str
    run_ids: list[str] = Field(min_length=1, max_length=100)


class TaskBatchFailure(BaseModel):
    run_id: str
    code: str
    message: str


class TaskBatchStopOut(BaseModel):
    """逐条结果如实分账：stopped / skipped / failed 三桶之和 = 去重后的请求条数。

    `skipped` = 已结束或已在取消中（无事可做，不是错误）；`failed` = 该条没有域执行权限
    或 run_cancel 判了别的错（整批不因此回滚——每条 cancel 自己 commit，回滚是假承诺）。
    """

    ok: bool = True
    stopped: int = 0
    skipped: int = 0
    stopped_ids: list[str] = Field(default_factory=list)
    skipped_ids: list[str] = Field(default_factory=list)
    failed: list[TaskBatchFailure] = Field(default_factory=list)

