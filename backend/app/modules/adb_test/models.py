"""ADB 测试资产模型（§4.5 + 计划 T2）：AdbDevice + AdbModule + AdbCase。

三表同族于 scenario/api_test/ui_test：软删两态（R53）、project 内同名唯一、无外键（全库
无外键，级联显式编码）。adb_module 是 R99 的第四棵树——独立于 api_module / scenario_module
/ ui_module，因为权限点与引用完整性不共享。

字段只来自 §4.5 两个字段清单，一列不多（照 0019 的取舍纪律）：
- connect_type 枚举预留 WIFI/USB 两值。**D14：USB 写入口一期显式 422 拒绝**，不静默改写成
  WIFI（静默改值是 §13 纪律 1 的镜像违例）；所以枚举收 "wifi"/"usb" 两个字面，服务层把关。
  wifi_addr 是收「WiFi 地址」的列（connect 的对象），connect_type 归联它。
- owner_id + project_public 两列必须建：shared/visibility.py 读的是 getattr(row,
  "project_public", True)，漏建不报错而等于「每一行都公开」——静默失效（计划 T2 点名）。
- adb_case 的 default_device：指定设备 serial，或留空 =「空闲即可」（§4.5 原话）。
  **没有 env_id / version**：§4.5 没列 env_id（ui_case 的 env_id 是 §4.4 的，不同表不同契约）；
  version 与 ApiCase/UiCase 同样不做乐观锁（R104），多一列 version 就多一处「前端忘了带」
  的静默覆盖。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Integer, SmallInteger, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id

# 软删两态，与场景/接口/UI 同族（R53）
STATUS_NORMAL = "normal"
STATUS_RECYCLED = "recycled"

# §4.5 只能说 connect_type 是「WIFI;USB 枚举预留」的枚举。小写入库，UI 层映射显示名。
# D14：USB 的写入口一期 422 拒绝（服务层把关），枚举先留两值等业主点名启用。
CONNECT_TYPES = ("wifi", "usb")


class AdbDevice(ProjectScopedMixin, TimestampMixin, Base):
    """ADB 设备（§4.5）：服务器直连（D2），wireless 优先。

    serial 是「连接对象」（WiFi 是 host:port，USB 是设备串号），name 是给人起的别名。
    唯一键只押 (name)：同一台物理设备（serial 相同）可以进多个项目——§4.5 没有说 serial
    全库唯一，提前禁就替蓝图做了语义决定。
    """

    __tablename__ = "adb_device"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_adb_device_project_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    serial: Mapped[str] = mapped_column(String(64), nullable=False, index=True)  # 192.168.1.50:5555 / USB 串号
    connect_type: Mapped[str] = mapped_column(String(16), nullable=False, default="wifi")  # wifi/usb
    wifi_addr: Mapped[str | None] = mapped_column(String(64), nullable=True)
    enabled: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    last_state: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # 机型/电量/在线（T4 心跳写）
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    project_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class AdbModule(ProjectScopedMixin, TimestampMixin, Base):
    """ADB 模块树节点（§4.5：同 api_module）——无限级、软删=回收站。"""

    __tablename__ = "adb_module"
    __table_args__ = (UniqueConstraint("project_id", "parent_id", "name", name="uq_adb_module_parent_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)
    # 根层（parent_id IS NULL）重名 DB 管不住：MySQL 唯一键不判等 NULL，服务层自查
    # （照 0016 的原话，别在这里假称约束覆盖了根层）。


class AdbCase(ProjectScopedMixin, TimestampMixin, Base):
    """ADB 用例（§4.5 + §7.3 协议）：一条扁平步骤列表 + 默认设备策略。

    steps 的协议由 T3 的 commands.py 定义并校验（26 型），模型只管「JSON 载体」；
    default_device 留空 =「空闲即可」，填 serial = 指定设备（执行时按 R139 排队/占用）。
    """

    __tablename__ = "adb_case"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_adb_case_project_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    module_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    priority: Mapped[str] = mapped_column(String(4), nullable=False, default="P2")
    enabled: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    steps: Mapped[list] = mapped_column(JSON, nullable=False)  # §7.3 命令数组
    default_device: Mapped[str | None] = mapped_column(String(64), nullable=True)  # serial；空 = 空闲即可
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    project_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=STATUS_NORMAL)
    step_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # 冗余计数，列表不 N+1
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_run_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
