"""全局快捷查找（§11.4.19 Ctrl+K / R51）：接口定义 / 用例 / 场景 + 元素 / UI 用例 / ADB 用例
+ 定时任务 / 通知渠道八路关键词检索。

落点为什么是独立模块 `app/modules/search/`：多路搜索要同时读 api_test、scenario、
ui_test、adb_test 的模型——从任何一边 import 另一边都破契约 1（领域模块互相独立）。composition 层
（agent / main 装配层同类）才允许正向读领域模块，所以新模块住在这里：只 import
core/shared + 各领域模块的 models（1E 起 += schedule/notify），不 import iam，
被契约 3 钉住不得反依赖 agent。

一期口径（§9.10）：MySQL LIKE 关键词，不上向量/FULLTEXT——向量路只服务
search_test_assets 与未来的语义检索，UI 快捷查找明写「关键词」。LIKE 的通配符
（% _ \\）转义为字面量：Ctrl+K 输入 "100%" 的用户要的是名字里真有 100% 的东西，
不是全表。

权限 perm=search:read：内置角色 READONLY 的 `*:read`、MEMBER/项目管理员的 `*`
都命中它，自定义角色不含即 403——「全局查找」是读能力，不给它任何跨项目的宽容：
先过 ensure_project_access（非成员 403），逐行再过 1A 的可见性谓词
（visible_clause / assert_row_visible 同一口径；回收资产不可见；定义回收则其用例
整体不可达，与 assert_def_alive 同尺）。1C T12/R109 扩 ui_element / ui_case 两路，
1D T8 扩 adb_case 一路，回收（status=recycled）与私有可见性同一把尺。
1E T9/R109 扩 schedule / notify_channel 两路：这两张表没有 status/可见性列，
各自按自己服务面（schedule_task_list / notify_channel_list）的同一把尺过滤——
定时按 project_id 显式过滤（项目级）、渠道平台级不过滤，两者再以
schedule:task:read / notify:channel:read 权限位整组开关（缺位 = 空组不是 403，
Ctrl+K 一组无权不许把其余组一起带走）。
"""
from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from app.core.permissions import match_perm
from app.core.service import ensure_project_access, service
from app.modules.adb_test.models import AdbCase
from app.modules.api_test.models import ApiCase, ApiDefinition
from app.modules.notify.models import NotifyChannel
from app.modules.scenario.models import Scenario
from app.modules.schedule.models import ScheduleTask
from app.modules.ui_test.models import UiCase, UiElement
from app.shared.visibility import visible_clause

PER_GROUP_LIMIT = 20


class SearchAssetItem(BaseModel):
    id: str
    name: str
    # 定义带 method+path；用例带所属定义名（结果分组里要能认出是哪条用例）；场景/UI 用例带优先级
    method: str | None = None
    path: str | None = None
    definition_id: str | None = None
    definition_name: str | None = None
    priority: str | None = None


class SearchAssetsIn(BaseModel):
    project_id: str
    q: str = Field(min_length=1, max_length=100)
    # 可选收窄（画布资产树等场景只搜一类）；缺省=八类全搜（1C T12 扩 ui_element/ui_case，
    # 1D T8 扩 adb_case，1E T9 扩 schedule/notify_channel——R109 四处同改之一）
    kind: str | None = Field(
        default=None,
        pattern="^(definition|case|scenario|ui_element|ui_case|adb_case|schedule|notify_channel)$")

    @field_validator("q")
    @classmethod
    def _blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("搜索关键词不能为空白")
        return v.strip()


class SearchAssetsOut(BaseModel):
    definitions: list[SearchAssetItem] = []
    cases: list[SearchAssetItem] = []
    scenarios: list[SearchAssetItem] = []
    # 1C T12（R109）：空组也必须在场——「这一组无匹配」是前端分节的契约，缺键就是整屏空白
    ui_elements: list[SearchAssetItem] = []
    ui_cases: list[SearchAssetItem] = []
    # 1D T8：同款契约，adb_case 空组也必须在场
    adb_cases: list[SearchAssetItem] = []
    # 1E T9（R109 四处同改）：1E 新两路同款契约——空组也必须在场，缺键 = 前端整屏空白。
    # notify_channels 的条目只有 id/name/priority：渠道的 config（D24 密文/掩码载体）
    # 根本不在 SearchAssetItem 的形状里，搜索结果天然零泄漏（不是靠打码，是压根不读该列）。
    schedules: list[SearchAssetItem] = []
    notify_channels: list[SearchAssetItem] = []


def _like(q: str):
    """LIKE 通配符转义（配合 escape="\\"）："100%" / "a_b" 按字面匹配。"""
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return lambda col: col.like("%" + esc + "%", escape="\\")


@service(
    perm="search:read", effect="read", name="search_assets",
    description="全局快捷查找：按名称/路径关键词搜接口定义、用例、场景、元素、UI 用例、ADB 用例、定时任务、通知渠道（Ctrl+K，§11.4.19；一期 MySQL LIKE，§9.10）",
    http={"method": "GET", "path": "/search-assets", "tags": ["search"]},
)
async def search_assets(payload: SearchAssetsIn, ctx) -> SearchAssetsOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("search:read")
    assert ctx.db is not None
    from sqlalchemy import select

    q = payload.q
    like = _like(q)
    want = ({"definition", "case", "scenario", "ui_element", "ui_case", "adb_case",
             "schedule", "notify_channel"}
            if payload.kind is None else {payload.kind})
    out = SearchAssetsOut()

    if "definition" in want:
        rows = (await ctx.db.execute(
            select(ApiDefinition)
            .where(ApiDefinition.project_id == payload.project_id,
                   ApiDefinition.status != "recycled",
                   visible_clause(ApiDefinition, ctx),
                   like(ApiDefinition.name) | like(ApiDefinition.path))
            .order_by(ApiDefinition.id).limit(PER_GROUP_LIMIT)
        )).scalars().all()
        out.definitions = [SearchAssetItem(id=r.id, name=r.name, method=r.method, path=r.path)
                           for r in rows]

    if "case" in want:
        # 可达性跟着定义走（assert_def_alive 同口径）：定义回收 = 用例整体不可见，
        # 用例行自己的 status 还是 normal 也不能搜出来。inner join + status 过滤。
        rows = (await ctx.db.execute(
            select(ApiCase, ApiDefinition.name)
            .join(ApiDefinition, ApiDefinition.id == ApiCase.definition_id)
            .where(ApiCase.project_id == payload.project_id,
                   ApiCase.status == "normal",
                   ApiDefinition.status != "recycled",
                   visible_clause(ApiCase, ctx),
                   like(ApiCase.name))
            .order_by(ApiCase.id).limit(PER_GROUP_LIMIT)
        )).all()
        out.cases = [SearchAssetItem(id=c.id, name=c.name, definition_id=c.definition_id,
                                     definition_name=dname)
                     for c, dname in rows]

    if "scenario" in want:
        rows = (await ctx.db.execute(
            select(Scenario)
            .where(Scenario.project_id == payload.project_id,
                   Scenario.status == "normal",
                   visible_clause(Scenario, ctx),
                   like(Scenario.name))
            .order_by(Scenario.id).limit(PER_GROUP_LIMIT)
        )).scalars().all()
        out.scenarios = [SearchAssetItem(id=s.id, name=s.name, priority=s.priority)
                         for s in rows]

    if "ui_element" in want:
        # 1C T12（R109）：元素是扁平命名空间，没有「父行回收拖死子行」的可达性问题，
        # 回收（status=recycled）不可搜即完整口径；可见性沿用 1A 谓词（两列都在，见 models 注释）。
        rows = (await ctx.db.execute(
            select(UiElement)
            .where(UiElement.project_id == payload.project_id,
                   UiElement.status != "recycled",
                   visible_clause(UiElement, ctx),
                   like(UiElement.name))
            .order_by(UiElement.id).limit(PER_GROUP_LIMIT)
        )).scalars().all()
        out.ui_elements = [SearchAssetItem(id=r.id, name=r.name) for r in rows]

    if "ui_case" in want:
        # UI 用例带优先级（与场景同形，结果行右侧的 Tag）；同样回收不可搜 + 1A 可见性。
        rows = (await ctx.db.execute(
            select(UiCase)
            .where(UiCase.project_id == payload.project_id,
                   UiCase.status != "recycled",
                   visible_clause(UiCase, ctx),
                   like(UiCase.name))
            .order_by(UiCase.id).limit(PER_GROUP_LIMIT)
        )).scalars().all()
        out.ui_cases = [SearchAssetItem(id=r.id, name=r.name, priority=r.priority)
                        for r in rows]

    if "adb_case" in want:
        # 1D T8：ADB 用例与 UI 用例同形（带优先级的 Tag）；回收不可搜 + 1A 可见性同一把尺。
        rows = (await ctx.db.execute(
            select(AdbCase)
            .where(AdbCase.project_id == payload.project_id,
                   AdbCase.status != "recycled",
                   visible_clause(AdbCase, ctx),
                   like(AdbCase.name))
            .order_by(AdbCase.id).limit(PER_GROUP_LIMIT)
        )).scalars().all()
        out.adb_cases = [SearchAssetItem(id=r.id, name=r.name, priority=r.priority)
                         for r in rows]

    if "schedule" in want:
        # 1E T9（R109）：定时任务是项目级（schedule_task 有 project_id），但表上
        # 没有 status/owner/project_public 列（models.py docstring 点名的教训：
        # 喂 visibility 助手 = 「每行公开」的静默失效）——可见性口径就是
        # schedule_task_list 同一把尺：显式 project_id 过滤，过了 ensure_project_access
        # 的项目成员都可见。权限位另设一把闸：角色不含 schedule:task:read 时
        # 该组如实空（返回空组而不是 403——Ctrl+K 一路 403 会把其余七组一起带走）。
        # priority：表上没有优先级概念，如实 None（ui_element 同形先例），不硬编。
        if match_perm(ctx.perms, "schedule:task:read"):
            rows = (await ctx.db.execute(
                select(ScheduleTask)
                .where(ScheduleTask.project_id == payload.project_id,
                       like(ScheduleTask.name))
                .order_by(ScheduleTask.id).limit(PER_GROUP_LIMIT)
            )).scalars().all()
            out.schedules = [SearchAssetItem(id=r.id, name=r.name) for r in rows]

    if "notify_channel" in want:
        # 渠道是平台级配置不是项目资产（notify/models.py docstring 原话，§4 无
        # project_id 列）——不按项目过滤，闸门是 notify:channel:read 权限位：
        # 不含该位 → 空组（同上，不 403）。
        # 泄密面核对：SearchAssetItem 只有 id/name/priority(+method/path/definition_*)，
        # 查询根本不 SELECT config/last_send 列——URL/token/secret 住在 config（D24），
        # 结构上就进不了搜索结果，不依赖运行时打码。
        # priority：渠道没有优先级概念，如实 None，不拿 type 冒充 priority。
        if match_perm(ctx.perms, "notify:channel:read"):
            rows = (await ctx.db.execute(
                select(NotifyChannel)
                .where(like(NotifyChannel.name))
                .order_by(NotifyChannel.id).limit(PER_GROUP_LIMIT)
            )).scalars().all()
            out.notify_channels = [SearchAssetItem(id=r.id, name=r.name) for r in rows]

    return out


def search_perm_granted(perms: set[str]) -> bool:
    """供装配层/工具面判断「这个角色能不能用全局查找」（测试与前端镜像位用）。"""
    return match_perm(perms, "search:read")


__all__ = ["SearchAssetItem", "SearchAssetsIn", "SearchAssetsOut",
           "search_assets", "search_perm_granted"]
