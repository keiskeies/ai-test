"""个人视图（§11.5.1「视图选择器：系统视图/个人视图/保存当前筛选为视图」，D47-a）。

形状照 MeterSphere v3 的 `user_view` 语义（读语义不抄码，见
docs/2026-11-20-metersphere-parity-audit.md §2.1.1）：一条视图 = 某人在某项目某页面上
存下来的一份筛选条件。MS 侧字段 `{id, userId, name, viewType, internal, scopeId, searchMode, pos}`
在本平台的对应：

- `view_type` —— **每个列表页一个值**（`api` / `scenario` / `report`…），不是全局一张视图池。
  没有它，接口页存的视图会出现在报告页下拉里，而那份条件在报告页根本没有可筛的字段。
- `internal` —— 区分内置视图与个人视图。**内置视图不落这张表**：系统的「默认视图」就是
  「一条条件都没存」，落库反而会让用户删不掉（内置视图不可删是 MS 的行为，我们照做）。
  本表因此只存个人视图，`internal` 不建列——没有第二值的列就是死列（D179 那条轴的口径）。
- `pos` —— 手动排序位（MS 允许拖拽排序）。一期只做「新建排最后」，列先留着：
  蓝图 §11.5.1 明写视图可选，排序是它的一部分，缺列会让「拖拽排序」变成二次迁移。

归属：`owner_id` 是视图的**主人**，不是 `project_public/owner_id` 那套私有资源可见性
——视图是个人偏好，同项目的别人**不该**看到我的筛选组合（MS 同此：个人视图按 userId 隔离）。
所以查询谓词是 `owner_id == 我`，不复用 `shared/visibility.visible_clause`。
"""
from __future__ import annotations

from sqlalchemy import JSON, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id


class SavedView(ProjectScopedMixin, TimestampMixin, Base):
    """个人保存视图（D47-a）。"""

    __tablename__ = "saved_view"
    __table_args__ = (
        # 同一页面上视图名不得重复（MS 同此）；跨页面重名允许——它们是两份不同东西。
        UniqueConstraint("project_id", "view_type", "owner_id", "name",
                         name="uq_saved_view_scope_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    view_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    owner_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # 存的是 shared.filters 认识的那份条件 JSON（search_mode + conditions），原样回吐：
    # 视图的语义是「把当时那份筛选原样装回去」，在这里做规范化就会改变它筛出来的东西。
    conditions: Mapped[dict] = mapped_column(JSON, nullable=False)
    pos: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
