"""通知渠道模型（§4.6 notify_channel + §11.4.26，1E 计划 T0）。

字段只来自 §4:211 清单（type / config JSON）+ 计划点名的补充：
- last_send JSON：D28 的落点——每次发送结果如实回写（ok/error/latency_ms/checked_at，
  model_cfg probe_result 同形）；自动发送失败不进审计流水（R144「审计记人，流水记机器」）。
- name：§11.4.26 列表页第一列就是「名称」（mock 里「钉钉群A」），§11.4.17 抽屉的
  「通知: ☑钉钉群A」也按名字认渠道——服务面无 name 就没法把行认出来，属
  「服务面必需要的最小补充」（计划 T0 口径），不是顺手抄列。
- config 是 D24 形状的载体：**模型只存 JSON**，敏感键（token/secret/password/api_key/
  webhook url 的 query 段）的「值」由服务层 Fernet 加密后放进去（与 model_cfg.api_key
  同一把 TP_FERNET_KEY，§10-3）；回显解密后逐键打码。模型不做加密——加密是服务面
  语义（打码/解密失败回 `****(无法解密)`），混进模型会把 T2 的自证测试架空。
- type 存大写五元枚举字面（§4:211 原文 WEBHOOK/DINGTALK/WECOM/FEISHU/EMAIL），
  枚外值由服务层 422 拒（取证 ③ 同款「显式拒绝不静默改值」）。
- **没有 project_id / owner_id / project_public**：§4 没列就不加——渠道是平台级配置
  不是项目资产（计划 T0 原话），project_id 例外只点名的 schedule_task 一张表；
  `notify:channel:*` 与 `system:audit:read` 同族走平台权限面。操作人追溯归审计流水，
  所以也不建 created_by/updated_by（蓝图与计划都没点到，谁要加先改计划）。
"""
from __future__ import annotations

from sqlalchemy import JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, new_id

# §4:211 原文的五类渠道，大写入库（model_cfg.model_type 同族口径）；枚外 422 归服务层。
CHANNEL_TYPES = ("WEBHOOK", "DINGTALK", "WECOM", "FEISHU", "EMAIL")


class NotifyChannel(TimestampMixin, Base):
    """通知渠道（§4.6 + §11.4.26）：config 按 D24 逐键密文，last_send 记最近一次发送。"""

    __tablename__ = "notify_channel"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)  # §11.4.26 列表「名称」列
    type: Mapped[str] = mapped_column(String(16), nullable=False)  # CHANNEL_TYPES 之一
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)  # D24：敏感键值 Fernet，其余明文
    last_send: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # ok/error/latency_ms/checked_at（D28）
