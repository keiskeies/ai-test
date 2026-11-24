"""ui_test schemas（§11.4.11 / §11.4.12 / §11.5.4）：模块树 + 元素库 + UI 用例。

一条贯穿本模块的口径：**`used_by` 是安全数字，不是浏览清单**。
列表列「关联用例数」与删除拦截必须来自同一次扫描——徽标说 0 而删除弹 409，
是 §11.5.4 那个界面能造成的最坏误导（`api_test/schemas.py:413-415` 为同样的
两个数写过注释，这里是同一道判断题）。差异只允许出现在**能不能说出名字**上
（见 `element_services._guard_delete` 的明细可见性），不允许出现在数量上。
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field

from app.modules.ui_test.models import LOCATOR_TYPES, PRIORITIES

# 定位器类型词表的唯一来源是 models.LOCATOR_TYPES（R100/D2 的 5 种）。
# 这里用 join 生成 pattern 而不是再抄一遍字面量：加了第 6 种类型时只有模型文件
# 一个地方要改，改漏一侧的「模式校验通过但落库词表不认识」是查半天的坑。
_LOCATOR_PATTERN = "^(" + "|".join(LOCATOR_TYPES) + ")$"
_PRIORITY_PATTERN = "^(" + "|".join(PRIORITIES) + ")$"


def iso(dt: datetime | None) -> str | None:
    """datetime → 带时区偏移的 ISO；None 透传（前端画「—」）。

    裸 naive 字符串到了前端 `new Date()` 会**按本地时区**解析，整页时间差 8 小时
    （scenario/services.py:46 的同一件事，ledger 记过）。留第二份的原因是消重要动
    已交付面，本批不动它；两处口径一致，合并留到有第三处需求时一起做。
    """
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class OkOut(BaseModel):
    ok: bool = True


# ══════════════════════════════ 模块树（R99 第三棵树）══════════════════════════════
class UiModuleNode(BaseModel):
    id: str
    parent_id: str | None = None
    name: str
    sort: int = 0
    status: str = "normal"
    # 一棵树服务两类资产（元素 + UI 用例），所以三个数都给：
    # count = 两者之和（共用组件 ModuleTree.tsx 的徽标语义「这个模块里有 N 项资产」），
    # 但元素库页只该看见 element_count、用例页只该看见 case_count——
    # 让两个页面都读 count 会各自说出一个错数字（模块里 1 个元素 + 2 条用例，
    # 元素库徽标说 3、列表只有 1 行）。分页各自读自己的那一列，别共用 count。
    count: int = 0
    element_count: int = 0
    case_count: int = 0
    children: list[UiModuleNode] = []


class UiModuleTreeIn(BaseModel):
    project_id: str
    include_recycled: bool = False


class UiModuleTreeOut(BaseModel):
    tree: list[UiModuleNode] = []
    recycled: list[UiModuleNode] = []


class UiModuleCreateIn(BaseModel):
    project_id: str
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    sort: int = 0


class UiModuleUpdateIn(BaseModel):
    project_id: str
    module_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort: int | None = None
    parent_id: str | None = None  # 显式传入（含 null）即移动；缺省=不动父级


class UiModuleDeleteIn(BaseModel):
    project_id: str
    module_id: str


class UiModulePurgeIn(BaseModel):
    project_id: str
    module_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class UiModulePurgeOut(BaseModel):
    ok: bool = True
    purged_modules: int = 0
    detached_elements: int = 0
    detached_cases: int = 0


# ══════════════════════════════════ 元素库 ══════════════════════════════════════
class UiElementCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    locator_type: str = Field(pattern=_LOCATOR_PATTERN)
    locator: str = Field(min_length=1, max_length=500)
    module_id: str | None = None
    comment: str | None = Field(default=None, max_length=500)
    project_public: bool = True


class UiElementUpdateIn(BaseModel):
    """PATCH 语义：None = 不改。`module_set` 是「显式传了 module_id（含 null）」的声明位——
    与 scenario 的 module_set 同一手法：`module_id: null` 必须能移到未分类，
    而缺省字段不能 accidentally 把元素挪走。
    """

    project_id: str
    element_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    locator_type: str | None = Field(default=None, pattern=_LOCATOR_PATTERN)
    locator: str | None = Field(default=None, min_length=1, max_length=500)
    comment: str | None = Field(default=None, max_length=500)
    module_id: str | None = None
    module_set: bool = False
    project_public: bool | None = None


class UiElementGetIn(BaseModel):
    project_id: str
    element_id: str


class UiElementListIn(BaseModel):
    project_id: str
    module_id: str | None = None
    # 单独的「只看未分类」开关：module_id=null 在 Pydantic 里与「没传」无法区分，
    # 树侧栏的「未分类」筛选项必须有显式开关，否则点了没反应 = 假入口。
    unfiled_only: bool = False
    # D47-b 步 5c：模块集合与关键字搜索下推到 SQL（此前是前端拉一页回浏览器内存过滤：
    # 模块 = 选中节点那一枚**直属** id + 未分类哨兵 "__none"，关键词只打 name）。谓词语义
    # 与接口页（步 4a）同款，但**口径是直属**——UI 树徽标至今是直属计数
    # （module_services._counts 的 docstring 明写「count=直属未回收元素+用例」），前端
    # ownModuleIds 也只返回选中节点自己；module_ids 就是「把那一个直属 id 发来」，IN 单
    # 元素，与现状逐字等价，徽标一行没动。子树口径要列表与徽标同刀翻、先要业主裁定
    # （接口页那次裁定的边界只覆盖接口树），单边改列表就是「徽标写 3、列表出 7」那个谎。
    # None = 不加这一路；**空列表 = 谁都不匹配**（含 module_id IS NULL 的未分类行）——
    # [] 与 None 必须可区分，否则「清空选择」和「选了个恰好没有元素的模块」两种意图分不开。
    # 前端「未分类」哨兵 "__none" 永不是真模块 id，IN 之下 NULL 行天然不中；这条等价不靠
    # SQL 三值逻辑的巧合，tests/test_d47b_element_page 有专例钉「选中模块时未分类不进来」。
    module_ids: list[str] | None = Field(
        default=None, description="模块 id 集（UI 树口径=直属，前端算好发来）；[]=不匹配任何行"
    )
    # 关键字 = **只打 name 一列**：现状浏览器本地框就只搜 name，不顺手扩到 locator（那是
    # 行为改变）。全空白 = 没筛选（清空输入框和敲了空格是同一件事）。大小写不敏感由列的
    # utf8mb4_0900_ai_ci 提供（步 4 已取证；它同时重音不敏感，口径同 ApiDefListIn.keyword）。
    keyword: str | None = Field(default=None, description="元素名关键字（大小写不敏感）；全空白=不过滤")
    # D220：高级搜索条件组（JSON 串，形状见 shared/filter_registry）。与 keyword / module_ids /
    # recycled 这些顶层轴并行 AND；None 或空串 = 没筛选。字段白名单在 element_services 登记。
    filter: str | None = None
    recycled: bool = False
    cursor: str | None = None
    # current（D47-b 步 5c）：页码分页入口，MS 页脚的 {current, pageSize, total} 口径。
    # None = 键集/游标路径（形状逐字节不变）；与 cursor 互斥，两者同时到场在 handler 里 400。
    # 前提天然满足：筛选（project/module/module_ids/unfiled/recycled/keyword）本来就全在
    # SQL WHERE 里，total 与 items 吃同一份条件（姊妹刀 ui_case_list 步 5a 同款注释）。
    current: int | None = None
    size: int = Field(default=50, ge=1, le=200)


class UiElementPurgeIn(BaseModel):
    """彻底删除元素（R53）：confirm_name 逐字相等 + 仅回收站 + **引用硬拦**（R106，
    与场景 purge 的分歧见 element_services.ui_element_purge 的 docstring）。"""

    project_id: str
    element_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class UiElementOut(BaseModel):
    id: str
    project_id: str
    module_id: str | None = None
    name: str
    locator_type: str
    locator: str
    comment: str | None = None
    owner_id: str | None = None
    project_public: bool = True
    status: str = "normal"
    updated_by: str | None = None
    # §11.4.18 回收站「删除人」列：updated_by 的人名形态，列表侧批量回填（element_services._user_names）。
    # 查不到 → None（前端画「—」，**不许**拿 user id 冒充人名）。正常列表该字段语义是
    # 「最后编辑人」——列只在回收站视图出现，前端注释里有这条纪律。
    updated_by_name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    # §11.5.4 的「关联用例数」列：未回收 UI 用例数，与删除拦截同源（模块 docstring）
    used_by: int = 0


# —— 内部引用查询（R106 删除保护；不暴露 HTTP，照 scenario_case_refs）——
class UiElementRefsIn(BaseModel):
    project_id: str
    element_ids: list[str] = Field(default_factory=list)


class UiCaseRefItem(BaseModel):
    case_id: str
    case_name: str
    step_indexes: list[int] = Field(default_factory=list)
    sort: str = Field(default="P2", exclude=True)  # 服务内部排序键，不进响应 JSON


class UiElementRefGroup(BaseModel):
    element_id: str
    # 引用数**永远照报**：拦不拦由数据决定，不由「有没有权限看是谁」决定
    count: int = 0
    items: list[UiCaseRefItem] = Field(default_factory=list)


class UiElementRefsOut(BaseModel):
    groups: list[UiElementRefGroup] = Field(default_factory=list)
    # True = 有引用但明细被隐瞒（调用方缺 ui:case:read）；UI 据此说明「为什么列表是空的」
    details_hidden: bool = False


# ══════════════════════════════════ UI 用例 ══════════════════════════════════════
class UiCaseCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    module_id: str | None = None
    priority: str = Field(default="P2", pattern=_PRIORITY_PATTERN)
    enabled: bool = True
    # §7.2 命令数组（扁平、无树）。默认 None 而不是 []：空用例是 `empty_steps` 那条
    # 422 的主角，默认给个空数组等于把「忘了传 steps」和「传了空序列」混成一件事。
    steps: list[dict[str, Any]] | None = None
    env_id: str | None = None
    project_public: bool = True


class UiCaseUpdateIn(BaseModel):
    project_id: str
    case_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    priority: str | None = Field(default=None, pattern=_PRIORITY_PATTERN)
    enabled: bool | None = None
    steps: list[dict[str, Any]] | None = None
    # 与 scenario 的 max_runtime_set 同款声明位：steps 传 null 与不传是两件事
    # （PATCH 里 None 已经是「不改」，所以清空命令序列靠这个位）。
    steps_set: bool = False
    module_id: str | None = None
    module_set: bool = False
    env_id: str | None = None
    env_set: bool = False
    project_public: bool | None = None


class UiCaseGetIn(BaseModel):
    project_id: str
    case_id: str


class UiCaseDeleteIn(BaseModel):
    """回收用例。force 与 adb_case_delete / api_case_delete 同款两段式：第一段不带
    force 只 409 并把引用者列出来；第二段给「已经看见引用清单、确认要连带断掉
    场景步骤」的人——明细被隐瞒时后端连 force 一起拦（case_services.ui_case_delete）。"""

    project_id: str
    case_id: str
    force: bool = False


class UiCaseListIn(BaseModel):
    project_id: str
    module_id: str | None = None
    unfiled_only: bool = False
    recycled: bool = False
    cursor: str | None = None
    # current（D47-b 步 5a）：页码分页入口，MS 页脚的 {current, pageSize, total} 口径。
    # None = 键集/游标路径（形状逐字节不变）；与 cursor 互斥，两者同时到场在 handler 里 400。
    # 前提天然满足：这两页的筛选（project/module/unfiled/recycled）本来就全在 SQL WHERE 里，
    # 没有本地过滤要下推，total 与 items 吃同一份条件（步 4b 对接口页的前置要求在这里免费成立）。
    current: int | None = None
    size: int = Field(default=50, ge=1, le=200)
    # D213：高级搜索条件（JSON 串，字段白名单在 case_services.UI_CASE_LIST_FILTER）。
    filter: str | None = None


class UiCasePurgeIn(BaseModel):
    project_id: str
    case_id: str
    confirm_name: str = Field(min_length=1, max_length=200)


class UiCaseBatchDeleteIn(BaseModel):
    """批量回收（D273，对齐 api_case_batch_delete）：全有或全无，不提供批量 force。"""

    project_id: str
    case_ids: list[str] = Field(min_length=1, max_length=200)


class UiCaseBatchRestoreIn(BaseModel):
    """批量恢复（D273）：全有或全无；任一名被占 → 409 整批不动（单条 restore 同口径）。"""

    project_id: str
    case_ids: list[str] = Field(min_length=1, max_length=200)


class UiCaseOut(BaseModel):
    id: str
    project_id: str
    module_id: str | None = None
    name: str
    priority: str = "P2"
    enabled: bool = True
    steps: list[dict[str, Any]] = Field(default_factory=list)
    env_id: str | None = None
    owner_id: str | None = None
    project_public: bool = True
    status: str = "normal"
    step_count: int = 0
    last_run_at: str | None = None
    last_run_status: str | None = None
    updated_by: str | None = None
    # §11.4.18 回收站「删除人」列（与 UiElementOut 同口径：列表侧批量回填，查不到 → None）
    updated_by_name: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    # 打开老用例就看见问题，不必等保存 422（scenario_get 的 live issues 同手感）
    issues: list[dict[str, Any]] = Field(default_factory=list)


class UiCaseReferencesIn(BaseModel):
    """HTTP 面单条查询（§11.4.12 用例详情的「场景引用」）。

    刻意不是 `case_ids: list`：路由由注册表投影而来，`core/service.py:262-270` 把 GET
    的字段摊成 query 参数，而 FastAPI 把 required 的 list 当 **body** ——写成 list
    会得到一条「存在但永远 422」的路由（本轮实测踩过）。批量口径住在内部件
    `ui_case_refs`，与 1B 的 `scenario_references`（GET 单查）/ `scenario_case_refs`
    （内部批量）同构。
    """

    project_id: str
    case_id: str


class ScenarioRefItem(BaseModel):
    scenario_id: str
    scenario_name: str
    step_keys: list[str] = Field(default_factory=list)
    sort: str = Field(default="P2", exclude=True)


class UiCaseReferencesOut(BaseModel):
    items: list[ScenarioRefItem] = Field(default_factory=list)
    details_hidden: bool = False


# —— 内部批量件（T10 删除保护；不暴露 HTTP）——
class UiCaseRefsIn(BaseModel):
    project_id: str
    case_ids: list[str] = Field(default_factory=list)


class UiCaseRefGroup(BaseModel):
    case_id: str
    count: int = 0
    items: list[ScenarioRefItem] = Field(default_factory=list)


class UiCaseRefsOut(BaseModel):
    groups: list[UiCaseRefGroup] = Field(default_factory=list)
    details_hidden: bool = False
