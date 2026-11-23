"""缺陷模型：`defect` + `defect_case_link`（D187 步 1）与 `defect_follower` + `defect_comment`（D191）。

D187 步 1 **只建两张表**（计划 §四 同日勘误）：状态词表与转移边表是**本文件的常量**，不是表。
D191 补了关注人/评论两张子表（D190 §2.2 的「新增优先级」），它们各自带类 docstring。
理由不是偏好，是三条现查事实——① 本仓词表一直是源码常量（`testplan/schemas.py` 的
`PLAN_DISPLAY_STATUSES`、`ui_test/models.py` 的 `PRIORITIES`）；② 全局表由启动期同步填
（`main.py` 的 `sync_perm_points` 一族）；③ **全仓 27 个迁移没有一次 INSERT**。
于是「`defect_status` 每项目建行」立刻要回答「存量项目的行谁来插」，而三个答案
（迁移里插 / 再造一个同步器 / 改 iam 的项目创建钩子）都是为一张「一期没人能编辑」的表
付的机械成本。**将来要每项目自定义状态 = 另一刀**（两张表 + seed + 编辑端点
+ 「删状态项先查谁引用」，MS 正是缺最后一步才留下悬空状态，取证 §G 第 7 条）。
D267 已落这一刀：下表 `defect_status` / `defect_status_transition` 是**项目级覆盖**，
上面两份常量降级为「空表时的默认图」——`seed` 那个问题用「空=默认」消掉，
迁移仍不 INSERT。

⚠ **本表偏离了计划 §三 第 4 条那句「跟自己的先例：回收站用 `status` 两态」**，理由写在
下面 `status` / `recycled` 两列处。这条偏离是**我裁的**，业主若要收回，改的是这两列 + 两条用例。

零外键（全库纪律）：级联在应用层同事务兑现；每张表各自 docstring 点名由谁清
（D191 的关联/评论/关注三张子表由 `services._purge_one` 在同一个事务里删净）。
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, UtcDateTime, new_id

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
# D207：功能用例已于 D193 落地（表 + 服务 + 前端），故这里补上 functional_case；
# 计划 §二 那条「有表没写入方」的防线随之解除（前端词表同步，R112：陌生码渲染原文）。
# 与 `testplan/schemas.py` 的 PLAN_LINK_SUBJECT_TYPES 同值但是**两份**：契约 1
# 「modules 之间只经 service/事件总线互调」禁止 defect import testplan。两份语义本来也不同
# （那边是「可排进计划的对象」，这边是「缺陷可指向的对象」），今天重合是巧合，不是同一个概念。
DEFECT_CASE_TYPES: tuple[str, ...] = (
    "api_case", "scenario", "ui_case", "adb_case", "functional_case"
)

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
    - `version`（乐观锁）：与 ApiCase/UiCase/Scenario 同口径不做（R104）。
    - `title` 上**没有唯一键**：见下面的 `title` 列。

    **D191 新增的列**（D190 §4 可执行边界）：`tags` / `delete_user` / `delete_time`。
    前者的写入方 = create/update/batch-update，读取方 = 列表标签筛选与详情；
    后两者的写入方 = 回收（delete），读取方 = 回收站列表的「删除人/删除时间」两列。
    **恢复时清空这两列**（MS 不清，取证 §C）——删除是发生过的事实，恢复后行上不该
    继续挂着一次已撤销的删除。

    **D192 翻案两列**（业主「全做」口径 / D188 §0）：`template_id` 与 `num` 不再是
    「不建」——模板地基与跨域取号器已落地（`app/modules/project_meta`）。
    `template_id` 是 MS 的 NOT NULL 硬前置；`num` 是列表 ID 列与「项目内唯一」的人读编号。
    迁移 0029 为存量行回填（每项目一个系统默认缺陷模板、按创建序取号），之后两列均 NOT NULL。
    """

    __tablename__ = "defect"
    __table_args__ = (
        UniqueConstraint("project_id", "num", name="uq_defect_project_num"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    # 项目内人读编号（100001 起）。写入方 = defect_create 经 project_num_next 同事务取号；
    # 读取方 = 列表 ID 列、详情、导出。**不复用**：回收/恢复保持原号，彻底删除后号作废。
    num: Mapped[int] = mapped_column(Integer, nullable=False)
    # 模板 id（project_meta.project_template）。写入方 = create/update；读取方 = 详情与动态字段渲染。
    template_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    # 缺陷标题。**与 ui_case/adb_case/api_module 相反，这里刻意不加 uq(project_id, title)**：
    # 那些表的名字是「按名字找人」的标识符（引用检测靠它），缺陷标题不是 ——
    # 同一个项目里两个「登录失败」是真实且常见的，DB 拦下来只会让用户给标题加编号，
    # 那是把我们的编号缺失转嫁给用户。用例 test_same_title_allowed_in_one_project 钉住这个决定。
    # 255 与 MS 前端 maxLength 对齐（D190 §2.1：原 200 是随手值，无业务依据）。
    title: Mapped[str] = mapped_column(String(255), nullable=False)
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
    # 标签：逗号分隔存储（MS 同形，String(1000)），服务层负责切分/去重/长度上限，
    # 对外一律 list[str]。空串与 NULL 都表示「无标签」；写入方 = create/update/batch-update。
    tags: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    # 回收站展示位（D191 与它的读取方同刀）：回收时写入，恢复时清空。
    delete_user: Mapped[str | None] = mapped_column(String(36), nullable=True)
    delete_time: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
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


class DefectFollower(Base):
    """缺陷关注人 `defect_follower`：复合主键 = (defect_id, user_id)。

    MS 同形（`bug_follower` 两列复合主键），但**权限不同**：MS 用 READ 位就能
    follow/unfollow（D190 §5 第 1 条），我们写副作用一律走写位。

    要点名 `created_by` 吗？不需要：关注行的身份就是「谁」，`user_id` 本身就是答案，
    再存一列等于把同一个事实写两遍。只保留 `created_at`（关注时间，MS 无此列但
    「按关注时间排序」迟早要用；不建 `updated_at`，关注关系没有更新语义）。
    """

    __tablename__ = "defect_follower"

    defect_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False,
                                                 default=lambda: datetime.now(UTC))


class DefectComment(TimestampMixin, Base):
    """缺陷评论 `defect_comment`：两层嵌套（parent_id 为空 = 顶层）。

    - `reply_user_id`：回复某条评论时冗余记录被回复者（MS 的 reply_user）。
      它不参与级联，只用于详情渲染「回复 @某人」；用户被删后悬空由前端按未知用户渲染。
    - `notifier`（MS 的 @ 提及结果）**不建**：富文本 @ 能力未落地，建了就是有列没写入方。
    - 删除父评论时应用层同事务删子评论（MS 同语义，D190 §1.5）。
    - 项目域：评论按 `project_id` 显式过滤，与缺陷本体同一道门。
    """

    __tablename__ = "defect_comment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    defect_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    reply_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_by: Mapped[str] = mapped_column(String(36), nullable=False)


class DefectCustomField(Base):
    """缺陷的自定义字段值（EAV 值表，D192）。

    - 主键 `(defect_id, field_id)`：一个缺陷对一个字段只有一条值。
    - `value` 一律 JSON 文本（shared.custom_fields：单值 `"x"` / 多值 `["a","b"]`）。
    - `field_id` 指向 project_meta.project_custom_field；删除字段有引用检查（有值行 → 409），
      所以这里不会出现「字段已删、值还在」的孤儿（MS 会，D192 取证 §4a）。
    - 彻底删除缺陷时由 `services._purge_one` 同事务清干净。
    """

    __tablename__ = "defect_custom_field"

    defect_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    field_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


# ══════════════ 项目级状态流转（D267：把上面那两份常量变成「默认值」）══════════════
#
# 上面 `DEFECT_STATUSES` / `DEFECT_TRANSITIONS` 仍是**唯一默认图**，但不再是唯一可选图：
# 每个项目可以用下面两张表覆盖它。空表 = 用默认图（**迁移不 INSERT**，全仓纪律），
# 首次编辑（PUT /defect-statuses）才把整份快照落行；`reset` 删行即回到默认。
# 这样既避开了 models.py 老 docstring 里那个「存量项目的行谁来插」的问题，
# 也保住了「删状态项先查谁引用」这条 MS 缺失的护栏（见 services.defect_flow_save）。
class DefectStatus(ProjectScopedMixin, TimestampMixin, Base):
    """项目自定义状态的一项。`(project_id, key)` 唯一；`position` 只用于展示顺序。

    `key` 一旦落库就不再改（缺陷行按 key 存 status）；改显示名改 `name` 即可。
    `is_start` 恰好一项为真（保存时校验）；`is_end` 只是语义标记（当前没有读侧
    汇总依赖它，别把它当「已关闭」的唯一判据）。
    """

    __tablename__ = "defect_status"
    __table_args__ = (
        UniqueConstraint("project_id", "key", name="uq_defect_status_project_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    key: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(32), nullable=False)
    is_start: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_end: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class DefectStatusTransition(ProjectScopedMixin, TimestampMixin, Base):
    """项目自定义转移边 `from_key → to_key`。同态转移不落行（与默认图同一条规则）。"""

    __tablename__ = "defect_status_transition"
    __table_args__ = (
        UniqueConstraint("project_id", "from_key", "to_key", name="uq_defect_transition_project_edge"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    from_key: Mapped[str] = mapped_column(String(32), nullable=False)
    to_key: Mapped[str] = mapped_column(String(32), nullable=False)


# ══════════════ 组织级状态流模板（D271 / 对齐 MS 的 OrganizationStatusFlow）══════════
#
# 优先级（`flow.load_flow` 实现）：项目自定义行 > 所属组织的模板行 > 内置默认图。
# 组织模板**不落项目行**（不复制），改模板对所有「未自定义」的项目立即生效；
# 这正是 MS 的 org template 语义。组织 id 通过 `project.organization_id` 求，
# 本模块不 import iam（独立性契约），走一条只读 SQL。
class OrgDefectStatus(TimestampMixin, Base):
    """组织状态流模板的一项。`(org_id, key)` 唯一，列与项目级同形。"""

    __tablename__ = "org_defect_status"
    __table_args__ = (
        UniqueConstraint("org_id", "key", name="uq_org_defect_status_org_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    org_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    key: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(32), nullable=False)
    is_start: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_end: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class OrgDefectStatusTransition(TimestampMixin, Base):
    """组织状态流模板的转移边；同态转移不落行。"""

    __tablename__ = "org_defect_status_transition"
    __table_args__ = (
        UniqueConstraint("org_id", "from_key", "to_key", name="uq_org_defect_transition_org_edge"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    org_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    from_key: Mapped[str] = mapped_column(String(32), nullable=False)
    to_key: Mapped[str] = mapped_column(String(32), nullable=False)
