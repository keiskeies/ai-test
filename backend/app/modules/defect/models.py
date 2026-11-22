"""缺陷模型（D187 步 1）：`defect` + `defect_case_link` 两张表。

**只建两张表**（计划 §四 同日勘误）：状态词表与转移边表是**本文件的常量**，不是表。
理由不是偏好，是三条现查事实——① 本仓词表一直是源码常量（`testplan/schemas.py` 的
`PLAN_DISPLAY_STATUSES`、`ui_test/models.py` 的 `PRIORITIES`）；② 全局表由启动期同步填
（`main.py` 的 `sync_perm_points` 一族）；③ **全仓 27 个迁移没有一次 INSERT**。
于是「`defect_status` 每项目建行」立刻要回答「存量项目的行谁来插」，而三个答案
（迁移里插 / 再造一个同步器 / 改 iam 的项目创建钩子）都是为一张「一期没人能编辑」的表
付的机械成本。**将来要每项目自定义状态 = 另一刀**（两张表 + seed + 编辑端点
+ 「删状态项先查谁引用」，MS 正是缺最后一步才留下悬空状态，取证 §G 第 7 条）。

⚠ **本表偏离了计划 §三 第 4 条那句「跟自己的先例：回收站用 `status` 两态」**，理由写在
下面 `status` / `recycled` 两列处。这条偏离是**我裁的**，业主若要收回，改的是这两列 + 两条用例。

零外键（全库纪律）：级联在应用层同事务兑现，两张表各自 docstring 点名由谁清。
"""
from __future__ import annotations

from sqlalchemy import Boolean, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id

# ══════════════ 状态词表与转移边（**常量，不是表**）══════════════
#
# 为什么在 models.py 而计划 §四 写的是 schemas.py：**导入方向**。列默认值要拿
# `DEFECT_STATUSES[0]`，而 schemas 必须能 import models（`ui_test/schemas.py:16` 正是
# `from ...models import PRIORITIES`），反过来让 models 依赖 schemas 会成环。
# 步 2 的 schemas 照 ui_test 那句的写法从这里取，两边不可能分叉。
#
# 词表与边照 MS 的默认图（取证 §A：5 态 + 默认边），但 §三 第 1 条是**主动改良**：
# 这张图在 MS 只用来渲染下拉框、写入时从不比对；我们**写路径真校验**，非法转移 409。
# 所以这里写的每一条边都是**运行时约束**，不是展示配置 —— 改它等于改接口契约。
DEFECT_STATUSES: tuple[str, ...] = ("new", "in_process", "resolved", "rejected", "closed")

# 新建缺陷的起始态（MS 用 status_definition 的 START 行表达；一张没人编辑的表不需要行）。
DEFECT_START_STATUS: str = DEFECT_STATUSES[0]

# 终态集合（MS 的 END）：读侧「还开着几个缺陷」= status 不在此集合内。
# ⚠ `rejected` 同时是终态、又能被 `DEFECT_TRANSITIONS` 转回 in_process（见 Q4）——
#   「终态」在这里的语义是**不活跃**，不是**不可重开**。这两件事在 MS 混用同一标记，
#   因为它从不校验转移所以从没暴露；我们校验，所以这里把话说清。
DEFECT_END_STATUSES: frozenset[str] = frozenset({"closed", "rejected"})

# from → 允许的 to。**同态不算转移**：`from == to` 直接放行、不查本表 ——
# 否则「只改标题不改状态」的编辑会要求每个状态都有一条指向自己的边，
# 而那条自环在 UI 上没有任何含义。步 2 的校验器以此为准（用例
# test_transitions_have_no_self_loops 钉住「自环不存在的理由是规则的例外，不是漏配」）。
DEFECT_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "new": ("in_process", "rejected"),
    "in_process": ("rejected", "resolved", "closed"),
    "resolved": ("in_process", "closed"),
    "rejected": ("in_process",),   # ← §七 Q4 待业主确认的唯一一条重开边
    "closed": ("in_process",),
}

# 关联可收的用例类型 = **我们已经真有主体的那几类**。
# 计划 §二：照抄 MS 的 `functional` 会让这条关联一上线就是「有表没写入方」——
# 功能用例还不存在（D185 只有计划文档）。等它落地再加，加时连带前端词表（R112：陌生码渲染原文）。
# 与 `testplan/schemas.py:98` 的 PLAN_LINK_SUBJECT_TYPES 同值但是**两份**：契约 1
# 「modules 之间只经 service/事件总线互调」禁止 defect import testplan。两份语义本来也不同
# （那边是「可排进计划的对象」，这边是「缺陷可指向的对象」），今天重合是巧合，不是同一个概念。
DEFECT_CASE_TYPES: tuple[str, ...] = ("api_case", "scenario", "ui_case", "adb_case")

# 优先级：本仓已有两份同款元组（`scenario/models.py:11`、`ui_test/models.py:19`），这是第三份。
# 收进 app/shared/ 是**另一次重构**（要动四个模块 + 它们的 schemas 校验），不属于本刀；
# 在这里另立第四种词表才是真错。
PRIORITIES: tuple[str, ...] = ("P0", "P1", "P2", "P3")


class Defect(ProjectScopedMixin, TimestampMixin, Base):
    """缺陷本体 `defect`。逐列口径（判据 1 的正面清单：每列点名写入方与读取方 + 它的步号）。

    **有意不建的列**（每条都是 §一/§三 的决定，写在这里防「顺手补列」；用例
    `test_no_columns_without_a_writer` 把这份清单钉成可执行的）：

    - `pos`（手工拖拽位，MS 列表默认 `pos desc`）：本仓**没有任何列表有拖拽位**，
      建了就是「有列没写入方」。默认排序 `created_at desc`（§七 Q2 建议 = 不做）。
    - `handle_users`（复数，MS 那列写两次全仓无一处读，取证 §G 第 1 条）：死列，判据 1 直接毙。
      要「处理人」就只有一个 —— 下面的 `handle_user_id`。
    - `platform` / `platform_bug_id`：不做第三方同步就没人写（§一）。
    - `template_id`：没有模板系统。MS 那边它是 NOT NULL 硬前置（取证 §B），
      **我们的表没有这一列正是「我们不抄模板」的形状本身**，不是漏了。
    - `num`（人读的短编号）：MS 显示每项目递增号。要做需要一条并发安全的取号路径，
      本仓零先例；`id` 足够定位，列表先用创建时间排序（§四）。
    - `delete_user` / `delete_time`（MS 回收站的两列展示位）：**读取方是一张还不存在的列表**，
      比 `recycled`（每一处读路径都要用的谓词）弱一档，留给步 4 与它的读取方同一个提交。
      顺带：MS 恢复时不清这两列 ⇒ 行上永久留着上一次删除的「谁、何时」（取证 §C），
      我们晚点加的时候要么一起处理恢复语义，要么就是不复制那个 bug。
    - `version`（乐观锁）：与 ApiCase/UiCase/Scenario 同口径不做（R104）。
    - `title` 上**没有唯一键**：见下面的 `title` 列。
    """

    __tablename__ = "defect"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    # 缺陷标题。**与 ui_case/adb_case/api_module 相反，这里刻意不加 uq(project_id, title)**：
    # 那些表的名字是「按名字找人」的标识符（引用检测靠它），缺陷标题不是 ——
    # 同一个项目里两个「登录失败」是真实且常见的，DB 拦下来只会让用户给标题加编号，
    # 那是把我们的编号缺失转嫁给用户。用例 test_same_title_allowed_in_one_project 钉住这个决定。
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # 纯文本。MS 的 description 是富文本 longtext —— 富文本要接文件库才放得了图，
    # 文件库没有（§一 附件那一行）；收 HTML 串再原样吐给前端渲染 = 前端 XSS 面。
    # 同 plan_record.description 的取舍（testplan/models.py:47-49 原话）。
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 工作流状态。写入方 = defect_create 置 `DEFECT_START_STATUS`（步 2）+ 步 2 的改状态/编辑
    # 路径（**必须过 DEFECT_TRANSITIONS**，§三 第 1 条）；读取方 = 列表筛选、详情、看板/待办
    # 过滤（按 DEFECT_END_STATUSES）。
    #
    # ⚠ **这一列与 adb/ui/api/scenario 四张表的 `status` 不是同一个含义**，这是本表对
    #   计划 §三 第 4 条「跟自己的先例（回收站 = status 两态）」的**主动偏离**：
    #   那四张表的 `status` 只装回收站这一个轴（normal/recycled），缺陷有**两个轴** ——
    #   工作流状态 + 是否在回收站。一列装不下两个轴，只能选一边：
    #   把回收站放 `status` 就得把工作流塞进第二名字，而「状态」是缺陷列表每一列、
    #   每一个筛选、每一条权限语义所指的那个词，不能让它改名。
    #   「`status` 未被回收站专用」也有先例：`api_test/models.py:20` 的
    #   `api_definition.status` 装的是 draft/complete（业务态），回收站在它的兄弟表上。
    #   全仓无按列名泛读 `status` 的助手（`shared/visibility.py` 只读 project_public/owner_id），
    #   所以改名不牵连任何通用逻辑 —— 已现查。
    status: Mapped[str] = mapped_column(
        String(24), nullable=False, default=DEFECT_START_STATUS, index=True
    )
    priority: Mapped[str] = mapped_column(String(4), nullable=False, default="P2")
    # 处理人（单数）。**可空**：MS 缺 handleUser 直接抛错（取证 §B 末），那是替业主定的政策；
    # 「新建时还没决定谁来处理」是真实状态，收空比伪造一个「默认指派创建人」诚实。
    # 写入方 = 步 2 的 create/update；读取方 = 列表与详情的「处理人」列。
    handle_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # 回收站轴（唯一一轴）。谓词形状照 `adb_test/case_services.py:120` 的
    # `status == (RECYCLED if payload.recycled else "normal")`，只是这里两轴分开之后
    # 直接写 `Defect.recycled.is_(payload.recycled)`。列名沿用**已有请求参数名** `recycled`
    # （`payload.recycled` 在本仓已经就是「列回收站」的意思），不新造 `deleted`/`trashed`——
    # 那两个词全仓零命中（§三 第 4 条现查）。
    # 恢复 = 把这列翻回 False，**工作流状态天然不受影响**（两个轴分列的红利；
    # MS 恢复时只翻 `deleted`、把旧的 delete_user/delete_time 留在行上，取证 §C）。
    recycled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class DefectCaseLink(ProjectScopedMixin, TimestampMixin, Base):
    """缺陷↔用例关联 `defect_case_link`：一条「这个缺陷关联了这个用例」的事实。

    通用指针 `(case_type, case_id)` 与 `run_record`（`execution/models.py:20-21`）、
    `plan_case_link`（`testplan/models.py`）同族 —— 一张表装多类对象，不给每类建一张。

    - **不存用例名快照**：`plan_case_link` 存 `subject_name` 是因为它要在计划列表里独立成行
      展示「挂的是什么」。这里的读取场景是「某缺陷关联了哪些用例」，行本身不独立成列表面，
      名称由调用方按类型去对应域取（走 REGISTRY，不横向 import）。存快照 = 多一份会腐烂的副本。
    - **关联行自己不带软删位**（计划 §二）：取消关联是硬删。MS 关联表也无 `deleted` 列，
      但它**删用例不级联**，靠查询里 `join ... and fc.deleted=false` 遮丑，于是关联行永久堆积、
      用例恢复后旧关联「复活」（取证 §D）。我们零外键，所以两条清理都是**应用层显式**、
      且必须被用例钉住：
        · 彻底删除缺陷（步 4）→ 同事务按 `defect_id` 删净本表行；
        · 删除用例（各域）→ 目前**没有**跨模块级联可依赖，靠读侧按 `case_id` 查不到即不显示。
          这一条是已知债，登记在 D187 台账，不假装解决了 —— 我们**不做**的是「用软删遮出来」，
          要做的是步 5 给关联列表加「对象已不存在」的诚实渲染。
    - `UNIQUE(defect_id, case_id, case_type)`：**DDL 层唯一键是本表与 MS 的第二处主动差异**。
      MS 无唯一约束、去重在代码里且两套写入口径不同（直连按 `(bugId, caseId)`、计划侧按
      `(testPlanCaseId, testPlanId, bugId)`，取证 §D）⇒ 同一对可重复插。
      键里带 `case_type`：`case_id` 是 uuid，跨类型撞值实际不可能，但「同一对象」的身份
      本来就是 `(类型, id)` 二元组，键跟着语义走。
    """

    __tablename__ = "defect_case_link"
    __table_args__ = (
        UniqueConstraint("defect_id", "case_id", "case_type", name="uq_defect_case_link_defect_case"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    # 指向 defect.id。无外键 ⇒ 级联由删除路径显式做（类 docstring）。index=True 同时服务
    # 「这个缺陷关联了哪些用例」（详情徽标 + 列表列）。
    defect_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    # 指向各域用例表的 id。这个方向的索引服务反查（「这条用例被几个缺陷关联」），
    # 也是步 5 徽标计数的谓词落点。
    case_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    case_type: Mapped[str] = mapped_column(String(24), nullable=False)
    # 谁关联的。列名沿用本仓 `created_by`（`plan_case_link` 同款），不用 MS 的 `create_user`。
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
