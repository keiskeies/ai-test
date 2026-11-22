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


class PlanListIn(BaseModel):
    project_id: str
    # 页码制（D47-b 口径，MS 页脚 {current, pageSize, total}）。本端点**只做页码**，
    # 不挂 cursor：新页没有键集的历史包袱，摆两种模式 = 给前端「我在哪」两套真相
    # （core/errors.paginate_page docstring 同一判断）。
    current: int = Field(default=1, ge=1)
    size: int = Field(default=50, ge=1, le=200)


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

    @field_validator("archived")
    @classmethod
    def _reject_archived(cls, v: bool | None) -> None:
        if v is not None:
            raise ValueError(
                "archived 不能从更新路径修改：归档走 POST /plans/{plan_id}/archive"
                "（testplan:plan:manage，且无反归档路径）")
        return None


class PlanDeleteIn(BaseModel):
    project_id: str
    plan_id: str


class PlanArchiveIn(BaseModel):
    project_id: str
    plan_id: str


class PlanOut(BaseModel):
    id: str
    project_id: str
    name: str
    description: str | None = None
    archived: bool
    created_by: str | None = None
    updated_by: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


# ══════════ 步 2：plan_case_link 关联行 ══════════

# 关联可收的 subject 词表（models.PlanCaseLink docstring 有拒收 inline/api_definition 的理由）。
# 放在 schemas 顶层：写入口校验与单测读同一份，两处不可能分叉。
PLAN_LINK_SUBJECT_TYPES = ("api_case", "scenario", "ui_case", "adb_case")


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
    created_by: str | None = None
    created_at: str | None = None
    # updated_at 在场因为**有写入方**：TimestampMixin 的 onupdate 在 env 改绑时刷新
    # （services.plan_link_update 是唯一动列的更新路径），读方 = plan_link_list 自己
    # （plan_record 的 updated_at 同款「列表展示列」口径）。挂名不写/不读的列不进（§六 1）。
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
