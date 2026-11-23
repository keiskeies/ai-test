"""计划域 schemas（D183 步 1）。"""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field, field_validator


def iso(dt: datetime | None) -> str | None:
    """datetime → 带时区偏移的 ISO；None 透传。

    第三处同款（scenario/services.py:46、ui_test/schemas.iso:25 各有一份）——合并要动
    已交付面，本刀不合并；两处口径一致，出现第四个消费者时一起做（ui_test 同款注释的口径）。
    """
    if dt is None:
        return None
    return (dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt).isoformat()


class PlanCreateIn(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=200)
    # 描述不设 max_length：列是 Text，MS 的计划描述能写整页；长度上限卡多少没有业务依据，
    # 拍一个数字只会让「写到一半保存失败」变成玄学 bug。
    description: str | None = None
    # D211：所属模块（可空 = 未分组）。服务层验「同项目存在」，不在 schema 里验。
    module_id: str | None = None


class PlanListIn(BaseModel):
    project_id: str
    # 页码制（D47-b 口径，MS 页脚 {current, pageSize, total}）。本端点**只做页码**，
    # 不挂 cursor：新页没有键集的历史包袱，摆两种模式 = 给前端「我在哪」两套真相
    # （core/errors.paginate_page docstring 同一判断）。
    current: int = Field(default=1, ge=1)
    size: int = Field(default=50, ge=1, le=200)
    # D211：按模块过滤。给 module_id = 该模块**及其整棵子树**（MS 左树点父节点看全子树）；
    # unassigned=True = 只看未分组（module_id 为空的计划）。两者互斥（服务层 422）。
    module_id: str | None = None
    unassigned: bool = False
    # D212：高级搜索（§11.5.1 / D47-a 铺到计划列表）。JSON 串——GET query 装不下嵌套对象
    # （filter_registry.parse_filter_json 的注释）。能筛哪些字段由 services.PLAN_LIST_FILTER
    # 登记，入参模型只负责「收下一个条件」，不在这里抄字段名。
    filter: str | None = None
    # D231：只看我关注的计划（plan_follower 里当前用户的行）。与模块/未分组/条件组并行 AND；
    # 不作为高级搜索字段（「关注」是视图轴，不是计划表上的列——同缺陷 followed_by_me 的口径）。
    followed_by_me: bool = False


class PlanGetIn(BaseModel):
    project_id: str
    plan_id: str


class PlanUpdateIn(BaseModel):
    """普通更新路径改不了归档，且**不静默丢弃** `archived`。

    为什么不是「模型里干脆没有 archived 字段」就完事：**未知键被默默丢掉是全仓的默认行为，
    不是哪条路由的特殊构造**——pydantic 的 `extra` 默认就是 `ignore`，而全仓没有任何一个模型
    声明过 `forbid`（`grep -rn 'extra=' app/ --include=*.py | grep -c forbid` = 0，实测）。
    于是 `{"archived": true}` 在校验那一层就被丢掉、调用方拿到 200，以为归档成功了，实际
    什么都没发生。带路径参数的路由还有一层 `create_model` 重建（core/service.py:374-387），
    它**不改变**这个后果：不带路径参数的 `plan_create` 同样吞未知键（本轮对照实测过，
    台账第六十轮勘误记的就是我先前把它当成了病因）。这正是计划 §三 4 骂过的病（开关说允许、
    实现偷偷去重），单向门更不能这么骗。所以这里**显式声明** archived 一枚只做拒收的哨兵字段：
    声明过的字段才会被校验，值一到就 422 说清去哪。显式传 null = 没打算改，放行（返回 None）。
    """

    project_id: str
    plan_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    archived: bool | None = None
    # D211：移动/移出模块用 `module_set` 显式哨兵（parent_set 同款）——否则「不传」与
    # 「传 null」在 pydantic 里分不出来，移出模块（module_id=null）就成了做不到的事。
    module_set: bool = False
    module_id: str | None = None

    @field_validator("archived")
    @classmethod
    def _reject_archived(cls, v: bool | None) -> None:
        if v is not None:
            raise ValueError(
                "archived 不能从更新路径修改：归档走 POST /plans/{plan_id}/archive"
                "（testplan:plan:manage，且无反归档路径）"
            )
        return None


class PlanDeleteIn(BaseModel):
    project_id: str
    plan_id: str


class PlanBatchDeleteIn(BaseModel):
    """D209：批量删除计划（MS `/delete/batch`）。全有或全无：任一 id 不在本项目 → 404 整批不动。"""

    project_id: str
    plan_ids: list[str] = Field(min_length=1, max_length=200)


class PlanArchiveIn(BaseModel):
    project_id: str
    plan_id: str


# ══════════ D211：计划模块树 ══════════
class PlanModuleTreeIn(BaseModel):
    project_id: str


class PlanModuleNode(BaseModel):
    id: str
    parent_id: str | None = None
    name: str
    sort: int
    # 本模块直属计划数（不含子模块；含归档计划——archive 不改 module_id，见 models.PlanModule）
    plan_count: int = 0
    children: list[PlanModuleNode] = Field(default_factory=list)


class PlanModuleTreeOut(BaseModel):
    nodes: list[PlanModuleNode]
    # 未分组的计划数（module_id 为空）。树里没有「未分组」这个假节点——它不是模块，
    # 是一类没有模块的计划；前端把它渲染成树旁边的一条入口，而不是混进树数据。
    unassigned_count: int = 0


class PlanModuleCreateIn(BaseModel):
    project_id: str
    parent_id: str | None = None
    name: str = Field(min_length=1, max_length=200)
    sort: int = 0


class PlanModuleGetIn(BaseModel):
    project_id: str
    module_id: str


class PlanModuleUpdateIn(BaseModel):
    """改名 / 移动（parent_set 哨兵）/ 排序。防环与同父重名在服务层。"""

    project_id: str
    module_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)
    parent_set: bool = False
    parent_id: str | None = None
    sort: int | None = None


class PlanCopyIn(BaseModel):
    """D208：复制计划。只有 `name` 可选，其余全从源计划抄。

    - 不给 `name` → 抄 MS 的命名形状 `<源名>_<5 位随机>_COPY`（截断到 200，后缀先保）；
      给了就按给的来（先过同项目重名 409 与 200 上限）。
    - **不抄执行结论**：MS 复制计划时把功能用例行重置为 Prepare，我们对应地不复制
      plan_functional_exec / history 与 plan_report——复制出来的是「同一批用例、全新的
      一轮执行」，而不是把上一轮的通过率一起搬过去（搬过去 = 新计划一开始就声称跑过）。
    - 归档位不抄：复制件是**可用的新计划**（archived=False），MS 同样把 status 复位 Prepare。
    """

    project_id: str
    plan_id: str
    name: str | None = Field(default=None, min_length=1, max_length=200)


class PlanOut(BaseModel):
    id: str
    project_id: str
    name: str
    description: str | None = None
    archived: bool
    module_id: str | None = None
    created_by: str | None = None
    updated_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class PlanListRowOut(PlanOut):
    """D231 列表行 = PlanOut + 「我是否关注」。

    只回答「我」这一位，不塞 follower_count：列表若带关注总数，就得为每页再做一次
    GROUP BY（本页用不上，纯为凑列），而「有多少人关注」是详情页的问题
    （PlanDetailOut 给，plan_get 单独一次 count）。写路径（create/update/archive/copy）
    仍返回 PlanOut——新建/改名不改变关注关系，凭空补两位「不是从库里读的」才是谎。
    """

    followed: bool = False


class PlanDetailOut(PlanOut):
    """D231 详情 = PlanOut + 我是否关注 + 关注总数（现查 plan_follower 两问，不存冗余列）。"""

    followed: bool = False
    follower_count: int = 0


class PlanFollowIn(BaseModel):
    """关注/取消关注入参（路径带 plan_id，service 的 create_model 合并）。"""

    project_id: str
    plan_id: str


class PlanFollowOut(BaseModel):
    """关注态回执：following = 操作后的真相（幂等：重复关注仍 True，重复取关仍 False）；
    follower_count 是操作后现查的行数，不返回「本次影响了多少」。"""

    following: bool
    follower_count: int = 0


# ══════════ 步 2：plan_case_link 关联行 ══════════

# 关联可收的 subject 词表（models.PlanCaseLink docstring 有拒收 inline/api_definition 的理由）。
# 放在 schemas 顶层：写入口校验与单测读同一份，两处不可能分叉。
# D204 加入 functional_case：功能用例在计划里是**人工执行**（没有 run_record），
# 结论落 plan_functional_exec，见 models.PlanFunctionalExec 的 docstring。
PLAN_LINK_SUBJECT_TYPES = ("api_case", "scenario", "ui_case", "adb_case", "functional_case")


class PlanLinkCreateIn(BaseModel):
    project_id: str
    plan_id: str
    subject_type: str
    subject_id: str = Field(min_length=1, max_length=36)
    # 可选覆盖：传了就用它（先过归属校验），没传则能抄就抄（scenario/ui_case 的 env_id）。
    # 抄不到留空 = 执行时沿用该 subject 自己的默认口径（§四 末段，三种 subject 不同源）。
    env_id: str | None = None


class PlanLinkListIn(BaseModel):
    project_id: str
    plan_id: str
    # 页码制（D47-b 口径 + plan_list 同款判断）：只做页码、不挂 cursor，
    # 两种模式并存 = 对「我在哪」给两套真相。
    current: int = Field(default=1, ge=1)
    size: int = Field(default=50, ge=1, le=200)


class PlanLinkDeleteIn(BaseModel):
    project_id: str
    plan_id: str
    link_id: str


class PlanLinkAssignIn(BaseModel):
    """D206：批量指派执行人。`executor_id=None` = 取消指派（不是「不改」）。"""

    project_id: str
    plan_id: str
    link_ids: list[str] = Field(min_length=1, max_length=200)
    executor_id: str | None = None


class PlanLinkAssignOut(BaseModel):
    updated: int


class PlanLinkSortIn(BaseModel):
    """D206：拖拽排序。`link_ids` 的先后就是新顺序（列表下标 → sort_order）。"""

    project_id: str
    plan_id: str
    link_ids: list[str] = Field(min_length=1, max_length=500)


class PlanLinkSortOut(BaseModel):
    updated: int


class PlanLinkBatchDeleteIn(BaseModel):
    """D206：批量取消关联（全有或全无：任一 link 不在本计划 → 404，一行都不删）。"""

    project_id: str
    plan_id: str
    link_ids: list[str] = Field(min_length=1, max_length=200)


class PlanLinkBatchDeleteOut(BaseModel):
    updated: int


class PlanLinkUpdateIn(BaseModel):
    """关联行**只改 env**——subject 改不了（那是另一条关联，删了重挂）。

    为什么不学步 1 给 subject 摆拒收哨兵：**未知键被默默丢掉是全仓默认行为**（pydantic
    `extra` 默认 ignore，全仓没有一个模型声明过 forbid——`grep -c forbid` 实测 0），
    带路径参数的路由再经 `create_model` 按声明字段重建 body 模型（core/service.py:374-395），
    两条路都通向同一后果：本模型不声明 subject_*，`{"subject_id": ...}` 就在校验那一步静默
    丢弃。PlanUpdateIn 那颗哨兵之所以有效，靠的是「服务**声明过**这个字段」（声明过才会被
    校验），不是靠 create_model 做了什么特别的事。接受这一处丢键的代价，是因为「悄悄忽略
    没用的键」≠「假装归档成功」：调用方拿到的 200 只回执 env，没有任何一列声称 subject 动了。
    归档那种**单向门**才必须 422 指路。

    env 的三态用显式哨兵，不靠 None 猜：不带 env_id = 不动（plan_update 对 None 的同款
    口径）；env_id 给字符串 = 换绑（先过归属校验）；clear_env=true = 清空。**两个同时给
    是 422**——「换成 A 同时清空」是说不清的一句话，别替调用方猜。
    """

    project_id: str
    plan_id: str
    link_id: str
    env_id: str | None = None
    clear_env: bool = False


class PlanLinkOut(BaseModel):
    id: str
    project_id: str
    plan_id: str
    subject_type: str
    subject_id: str
    subject_name: str
    env_id: str | None = None
    # D206：指派执行人与手工排序位（见 models.PlanCaseLink 的逐列口径）
    executor_id: str | None = None
    sort_order: int = 0
    created_by: str | None = None
    created_at: str | None = None
    # updated_at 在场因为**有写入方**：TimestampMixin 的 onupdate 在 env 改绑时刷新
    # （services.plan_link_update 是唯一动列的更新路径），读方 = plan_link_list 自己
    # （plan_record 的 updated_at 同款「列表展示列」口径）。挂名不写/不读的列不进（§六 1）。
    updated_at: str | None = None


# ══════════ D204：计划内功能用例（人工执行） ══════════


class PlanFunctionalListIn(BaseModel):
    """功能用例列表：页码制（与 plan_link_list 同尺），支持模块/关键字/结论筛选。"""

    project_id: str
    plan_id: str
    current: int = Field(default=1, ge=1)
    size: int = Field(default=50, ge=1, le=200)
    keyword: str | None = Field(default=None, max_length=100)
    module_id: str | None = None
    # none = 尚未给结论（含从未执行）；四值见 models.PLAN_FUNCTIONAL_RESULTS。
    result: str | None = None


class PlanFunctionalExecuteIn(BaseModel):
    """给一批关联写执行结论（单条 = 列表里传一个 link_id）。

    结论词表由 services 对 models.PLAN_FUNCTIONAL_RESULTS 校验（一处定义，不在这里
    再抄一份字面量——两份词表会各自漂移）。comment 是给人看的备注，Text 不限长。
    """

    project_id: str
    plan_id: str
    link_ids: list[str] = Field(min_length=1, max_length=200)
    result: str
    comment: str | None = None


class PlanFunctionalHistoryIn(BaseModel):
    project_id: str
    plan_id: str
    link_id: str
    # D218：页码分页（MS 页脚口径）。历史是 append-only 流水，一条用例反复改判后能长得
    # 很长；一次全量返回在「执行 200 次」的用例上就是一次没有上限的响应。默认 20 与
    # 其余列表页同尺；current/size 的边界由 pydantic 拦，负数不落到 OFFSET。
    current: int = Field(default=1, ge=1)
    size: int = Field(default=20, ge=1, le=200)


class PlanFunctionalCaseOut(BaseModel):
    """计划内功能用例行：关联 + 用例快照字段 + 当前结论（无结论时 result = none）。"""

    link_id: str
    case_id: str
    num: int
    name: str
    priority: str
    module_id: str | None = None
    result: str = "none"
    comment: str | None = None
    executed: bool = False
    executed_by: str | None = None
    executed_at: str | None = None
    # D206：指派执行人与手工排序位（executed_by 是「谁真跑了」，executor_id 是「指派给谁」）
    executor_id: str | None = None
    sort_order: int = 0


class PlanFunctionalDetailOut(PlanFunctionalCaseOut):
    """详情 = 列表行 + 用例描述/自定义字段（人工执行前要看到的东西）。"""

    description: str | None = None
    custom_fields: dict[str, str] = {}


class PlanFunctionalHistoryOut(BaseModel):
    id: str
    seq: int
    result: str
    comment: str | None = None
    executed_by: str | None = None
    created_at: str | None = None


# ══════════ D207：计划缺陷清单（只读聚合） ══════════


class PlanBugListIn(BaseModel):
    """计划内缺陷清单：页码制（plan_link_list 同尺），只读、去重。

    口径 = MS 的 `ExtTestCaseMapper.getTestPlanBug`（取证：计划内用例关联的缺陷，
    distinct）：一条缺陷可被多条计划内用例指向，这里只出一道。
    """

    project_id: str
    plan_id: str
    current: int = Field(default=1, ge=1)
    size: int = Field(default=50, ge=1, le=200)
    # 只筛不搜：状态/优先级由缺陷词表约束，关键字搜标题（与缺陷列表同字段）。
    status: str | None = None
    priority: str | None = None
    keyword: str | None = Field(default=None, max_length=255)


class PlanBugOut(BaseModel):
    """计划缺陷行 = 缺陷本体字段的只读投影（**不存快照**，读时现取）。"""

    id: str
    num: int
    title: str
    status: str
    priority: str
    handle_user_id: str | None = None
    handle_user_name: str | None = None
    tags: list[str] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None


# ══════════ 步 3：实时状态现算（只读投影，不落库） ══════════

# 计划展示态的词表（services._plan_display 是唯一的产出口）。四值里三个是现算的、
# archived 是库里唯一的真相——它优先于一切现算值（归档件照实报数，但 status 取归档）。
PLAN_DISPLAY_STATUSES = ("not_started", "in_progress", "completed", "archived")
# 关联行的「终态结论」词表：none = 没有任何终态 run（含从未跑与跑在中两种情形，
# 区分它们的是 executing 布尔，不塞进这个枚举——「执行中」不是「结论」）。
LINK_RESULTS = ("none", "passed", "failed")


class PlanStatusIn(BaseModel):
    project_id: str
    plan_id: str


class PlanLinkStatusOut(BaseModel):
    """一条关联的现算结论。三问全是**与顺序无关**的「有没有过…」（services._link_result）：

    - executed：该关联存在至少一条**终态**（passed/failed/error）run（§六 3 的「已执行」定义）；
    - executing：存在 queued/running 的 run——界面据此显示「执行中」而不是「没跑过」；
      它与 executed 可以同时为真（跑完过、此刻又在跑），两个布尔各答各的，不互相吞；
    - result：有终态时取 passed/failed（终态里出现过 failed/error 即 failed，保守口径，
      见 services 的步 3 判断 2），没终态恒 none。**queued/running 不进这个枚举**——
      把非 passed 当失败 = 照 execution/models.py:26 那句错注释写代码（步 3 判断 1）。
    """

    link_id: str
    subject_type: str
    subject_id: str
    subject_name: str
    env_id: str | None = None
    executed: bool
    executing: bool
    result: str


class PlanStatusOut(BaseModel):
    """计划实时状态：**每次查询现算，库里一个展示态列都没有**（§二 1）。

    分母口径（§六 3，业主裁死）：pass_rate = passed ÷ **total**；execute_rate =
    executed ÷ **total**。**未执行（含执行中）拉低通过率**——「跑一半」不算跑完，
    执行率不许在还有一堆用例在机器上跑着的时候先走到 1.0。空计划两个率都是 0.0，
    不是 1.0：「空集合全部已执行」在逻辑上是空真，在界面上是说谎。
    """

    plan_id: str
    project_id: str
    name: str
    archived: bool
    status: str
    total: int
    passed: int
    failed: int
    executed: int
    executing: int
    # 口径里的「未执行」= total − executed，**含执行中的那部分**（§六 3：queued/running
    # 在执行率里算未执行）。per-link 的 none/executing 两布尔负责把「没跑过」与「跑着」
    # 在明细里分开，汇总不混。
    not_executed: int
    pass_rate: float
    execute_rate: float
    links: list[PlanLinkStatusOut]


# ══════════ 步 4：plan_report / plan_report_item（生成 = 一次性快照） ══════════


class PlanReportCreateIn(BaseModel):
    project_id: str
    plan_id: str
    # 报告名可选：不给就在生成时刻抄计划名（「<计划名> 报告」）。留空不是「没写」——
    # name 列非空，写入方 = plan_report_create，读方 = 列表/详情（判据 1）。
    name: str | None = Field(default=None, min_length=1, max_length=200)


class PlanReportListIn(BaseModel):
    project_id: str
    plan_id: str
    # 页码制（plan_list / plan_link_list 同款裁决：只做页码、不挂 cursor）。
    current: int = Field(default=1, ge=1)
    size: int = Field(default=50, ge=1, le=200)


class PlanReportGetIn(BaseModel):
    project_id: str
    report_id: str


class PlanReportItemListIn(BaseModel):
    """报告明细分页入参（步 5）。

    页码制（plan_report_list / plan_link_list 同款裁决：只做页码、不挂 cursor，
    两种模式并存 = 对「我在哪」给两套真相）；size 上限 200 与 paginate_page 的夹取同尺。
    报告详情端点（GET /plan-reports/{report_id}）**不带**这两个字段——它的形状是
    头 + 全量 items，快照逐字节用例钉的就是它，分页只走这一条新路径。
    """

    project_id: str
    report_id: str
    current: int = Field(default=1, ge=1)
    size: int = Field(default=50, ge=1, le=200)


class PlanReportDeleteIn(BaseModel):
    project_id: str
    report_id: str


class PlanReportRenameIn(BaseModel):
    """D210：报告改名（MS `/reName` 的同位）。只改 `name` 一个字段。

    报告是**内容快照**（计数/明细/生成时状态全部冻结），`name` 是元数据——MS 允许改名，
    我们此前把「没有 update 服务」当成不可改的整行，改名的需求只能删了重生成（丢快照），
    那是把「内容不可改」错读成「标题也不能改」。本服务只写 name 一列，不碰任何计数/明细，
    updated_at 会随之变（改名是一次真写），快照内容仍逐字节可对。
    """

    project_id: str
    report_id: str
    name: str = Field(min_length=1, max_length=200)


class PlanReportItemOut(BaseModel):
    """报告明细行 = 生成时刻的副本。每个键都是抄下来的值，读取路径零重算、零 join。"""

    id: str
    report_id: str
    link_id: str
    subject_type: str
    subject_id: str
    subject_name: str  # 生成时刻的快照名（此后改用例不动这里）
    env_id: str | None = None  # 生成时刻关联行环境值的副本（此后改绑不动这里）
    executed: bool
    executing: bool
    # 词表与步 3 的 LINK_RESULTS 同一份（none/passed/failed）：结论由生成路径从 run_record
    # 现算后**抄进来**（§三 3 那个环在这一刀闭合）——存的是结论与计数，不是 run 指针
    # （run_record 同秒无全序，「最近一次 run」这条路不承诺，步 3 判断 1 的 (b) 路）。
    result: str
    # created_at/updated_at 进 payload 不是为了「显示修改时间」（行不可变，二者恒等），
    # 是为了让**快照逐字节断言**读到它们：任何路径碰过某行明细，updated_at 一跳，
    # 前后两次读报告的 payload 就不相等——时间列成了「谁都没动过这行」的证人（判据 2 的
    # 形状本身就消费这两列；判据 1 的读侧由此成立）。
    created_at: str | None = None
    updated_at: str | None = None


class PlanReportOut(BaseModel):
    """报告头 + 明细。数字 = 生成时刻的一份副本（§二 2）：

    pass_rate / execute_rate / not_executed 是**读时从存量计数派生**的纯函数
    （口径逐字 = 步 3 的 PlanStatusOut：分母 = total、空计划 0.0 不是 1.0），
    不是独立存列——存两份会各自漂移的数 = §三 2 那类病。status 是生成时刻
    _plan_display 的快照**列**：之后归档/新 run 都不动它，读取路径不许现算
    （「读取路径改成现算」正是本刀变异自证点名要杀的形状）。
    """

    id: str
    project_id: str
    plan_id: str
    name: str
    status: str
    total: int
    passed: int
    failed: int
    executed: int
    executing: int
    not_executed: int
    pass_rate: float
    execute_rate: float
    created_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    items: list[PlanReportItemOut]


class PlanReportListRowOut(BaseModel):
    """列表行 = 报告头，**不带 items**（列表不为每行明细付一次查询；明细归详情）。"""

    id: str
    project_id: str
    plan_id: str
    name: str
    status: str
    total: int
    passed: int
    failed: int
    executed: int
    executing: int
    not_executed: int
    pass_rate: float
    execute_rate: float
    created_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


class PlanReportExportOut(BaseModel):
    """D230：报告导出的 JSON 载体（content 是自包含 HTML 文本，前端落地为 .html 文件）。

    为什么不是 FileResponse：本仓所有端点都经 @service 注册表（权限矩阵/审计/OpenAPI
    同一张网），raw 路由会漏一张；defect_export 的 CSV 文本载体是同一条先例。
    media_type 由后端给死（text/html; charset=utf-8）：前端只负责 Blob 落地，不猜类型。
    item_count 是**本次实际导出的明细行数**（= 快照明细数，不是计划当下关联数）。
    """

    filename: str
    media_type: str
    content: str
    item_count: int


class PlanExecuteIn(BaseModel):
    """D225：执行计划（把计划里全部可运行关联对象各投一次 worker）。

    只带定位，不带「只跑某几条」这类子集条件——选择子集是列表勾选批量操作的活，
    与「执行整个计划」是两种意图；混进一个入参会变成两套语义共用一条路径。
    """

    project_id: str
    plan_id: str


class PlanExecuteItemOut(BaseModel):
    """逐关联对象的结果：投递成功给 run_id，没投出去给 reason（人话，可直接上屏）。

    成功与跳过共用一条形状而不是两个数组：页面按关联顺序一排到底，
    「第 3 条为什么没跑」不需要用户在两份列表里对 id。
    """

    link_id: str
    subject_type: str
    subject_id: str
    subject_name: str
    run_id: str | None = None
    reason: str | None = None


class PlanExecuteOut(BaseModel):
    plan_id: str
    submitted: int
    skipped: int
    items: list[PlanExecuteItemOut]
