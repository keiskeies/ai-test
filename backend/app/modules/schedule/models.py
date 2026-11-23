"""定时任务模型（§4.6 schedule_task + §4.10 kv_setting，1E 计划 T0）。

字段只来自 §4:210 清单（subject_type / subject_id / cron / env_id / enabled /
notify_channel_ids JSON / last_run JSON）+ 计划点名的「服务面必需要的最小补充」
（name、project_id、created_by/updated_by、consecutive_failures），一列不多
（1D T2 同款纪律）：

- **没有 next_fire_at**：D22（漏跑补偿）未裁决——「应然触发历史」蓝图无表，编一张
  就是顺手加 scope；业主裁「要补」时加这一列是唯一回退点（计划 D22 原文）。
- **没有 owner_id / project_public**：§4 这两行没列就不加。注意这不代表它们可以走
  shared/visibility.py——该助手读 getattr(row, "project_public", True)，喂给它一张
  没这列的表等于「每行都公开」（0018 的静默失效教训）。所以 T1 服务面必须按
  project_id 显式过滤，不喂 visibility 助手。
- **project_id 是权限过滤例外**（计划 T0 点名允许，理由写明于此）：`schedule:task:*`
  是三段式权限位（§10-1），core/service.build_ctx 的项目数据权限门按 payload 里的
  project_id 解析权限——表上没有这列，列表/详情查询就无法按项目过滤，等于跨项目渗漏。
- consecutive_failures 是 §11.4.17 抽屉「连续失败[3]次后通知」的账（计划 T0：
  「总要有人记」）；达阈值后的告警发送归 T3，模型只提供计数位。
- subject_type 白名单是 scenario / plan / plan_report（D30 只放 scenario；D226 增 plan =
  计划定时执行；D229 增 plan_report = 定时生成计划报告并推渠道）：列本身是复数语义
  （§4:210），白名单在服务层 422 把关（显式拒绝不静默改值），模型不建枚举约束。

kv_setting（§4:237 系统级键值表）挂在本模块的理由（计划 T0/D25）：一期消费方只有
`_beat_schedule()`/DbScheduler 读「ADB 心跳间隔」一行——消费方住调度域，表就归调度域；
§11.4.28 其余四组参数没有批次归属，不进 1E。key 建唯一约束是「按 key 读出恰好一行」
的前提：重复行 = 消费方静默歧义，这比多建一列更必须是硬约束。
"""
from __future__ import annotations

from sqlalchemy import JSON, Integer, SmallInteger, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id


class ScheduleTask(ProjectScopedMixin, TimestampMixin, Base):
    """定时任务（§4.6 + §11.4.17）：自研 Beat Scheduler 每轮读 enabled 行现算 crontab。"""

    __tablename__ = "schedule_task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)  # §11.4.17 列表「名称」列
    subject_type: Mapped[str] = mapped_column(String(24), nullable=False)  # scenario/plan（D226，服务层把关）
    subject_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    cron: Mapped[str] = mapped_column(String(64), nullable=False)  # 5 段式；入库前 crontab() 校验（取证 ③）
    env_id: Mapped[str | None] = mapped_column(String(36), nullable=True)  # 抽屉「环境[▾]」；空 = 场景默认
    enabled: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    notify_channel_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)  # §4:210 引用列
    last_run: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # 最近一次触发回执（T1 update_last_run 写）
    consecutive_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # §11.4.17 告警阈值之账
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class KvSetting(TimestampMixin, Base):
    """系统级键值（§4:237）：1E 只落「ADB 心跳间隔」一行（D25），表留着、行不插由业主裁。"""

    __tablename__ = "kv_setting"
    __table_args__ = (UniqueConstraint("key", name="uq_kv_setting_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    key: Mapped[str] = mapped_column(String(100), nullable=False)  # MySQL 保留字，SQLAlchemy 自动加引号
    value: Mapped[dict | list | int | str | None] = mapped_column(JSON, nullable=False)
