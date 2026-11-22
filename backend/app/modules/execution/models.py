"""运行记录 run_record（§4.6）。1A 承载单接口调试；1B 起作为报告主体：

started_at/finished_at 是执行真实窗口，stats 是统计口径，summary_graph 是「步骤树 +
每步结果」快照——报告页因此不依赖场景/用例是否仍存在（§14 自包含条款）。
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, Integer, SmallInteger, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id


class RunRecord(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "run_record"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    subject_type: Mapped[str] = mapped_column(String(24), nullable=False)  # api_definition/api_case/scenario(1B)/ui_case(1C)
    subject_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    subject_name: Mapped[str] = mapped_column(String(200), nullable=False)  # 快照名：对象删除后仍可读
    env_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    env_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    trigger: Mapped[str] = mapped_column(String(16), nullable=False)  # debug/manual/schedule/agent/webhook
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # passed/failed/error
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    request_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    response_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    assertions: Mapped[list | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # ---- 1B（迁移 0014）：报告主体与执行编排字段；全部可空，1A 老记录读出来是 None ----
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    stats: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # {total,pass,fail,skip,rows_total}
    summary_graph: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # step_graph + 每 key 结果
    lease_owner: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 领取该 run 的 worker
    cancel_requested: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0, server_default="0")
    max_runtime_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)  # §8.2；空=用全局默认
# ---- 1B T2：一次执行的三张明细表（§4.6 + 计划 R47）----


class RunStepResult(TimestampMixin, Base):
    """步骤结果：报告详情的数据源，也是失败单步重跑的重建依据（§8.3）。

    (run_id, step_key, row_no) 唯一 —— row_no 用 0 表示「非数据集展开的那一行」，
    而不是 NULL：MySQL 唯一键不判等 NULL，用 NULL 会让「重跑覆盖同一行」退化成
    「每次重跑多一行脏数据」（1A 已在 api_module 根层同名上踩过同一坑）。
    parent_step_key 表达容器 → 子步骤，让报告页脱离 step_graph 也能重建步骤树。
    """

    __tablename__ = "run_step_result"
    __table_args__ = (UniqueConstraint("run_id", "step_key", "row_no", name="uq_step_run_key_row"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    step_key: Mapped[str] = mapped_column(String(64), nullable=False)  # step_graph 的 node.key
    row_no: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")  # 0=非数据集行
    kind: Mapped[str] = mapped_column(String(24), nullable=False)  # §7.4 的 kind
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # running/pass/fail/skip/error/cancelled
    parent_step_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    subject_name: Mapped[str | None] = mapped_column(String(200), nullable=True)  # 用例/接口名快照
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    elapsed_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    row_total: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 数据集总行数（报告节点显示 3/10）
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # {request,response,assertions,logs}，超限外置（§8.8）
    vars_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # §8.3 单步重跑重建 ctx


class RunEvent(Base):
    """进度事件真相（R47）：重放与直播共用同一信封，断线重连不丢步。

    publish 顺序固定为「先写本表 commit → 再 Redis 广播」：Web 侧一旦收到事件，
    就一定能在库里重放到它，不存在「收到了但重放不出来」的窗口。
    """

    __tablename__ = "run_event"
    __table_args__ = (UniqueConstraint("run_id", "seq", name="uq_event_run_seq"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)  # run 内单调递增，即 SSE 的 Last-Event-ID
    type: Mapped[str] = mapped_column(String(24), nullable=False)  # step/run_end/log…
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=lambda: datetime.now(UTC))


class RunArtifact(Base):
    """制品（§4.6/§8.8）：DB 只存相对 ref，字节落 data/artifacts/{run_id}/。"""

    __tablename__ = "run_artifact"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    step_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)  # SCREENSHOT/VIDEO/HAR/LOG/RESPONSE
    ref: Mapped[str] = mapped_column(String(500), nullable=False)  # artifacts 根下相对路径（禁 ..）
    bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=lambda: datetime.now(UTC))
