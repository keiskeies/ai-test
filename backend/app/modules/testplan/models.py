"""计划域模型（D183 §四；列风格照 run_record——execution/models.py:16）。

plan_record 这一张表是整个计划的「形状示范」：每一个列都要能回答「谁写、谁读」
（计划 §三 6、§六 1），MS 有四列设计了没人写（实际结束时间、关联行三件套、报告明细结果、
死表列——取证 §三 1/2/3、§三 6），这一刀的存在意义就是不重犯。逐列口径：

- **只有 `archived` 一个状态真相**。MS 的 DDL 注释写四态、实际只写两值，中间态
  「未开始/进行中/已完成」是查询时拿关联行的最近结果现算的（取证 §二 1）。我们照这个
  形状：存一列没人维护的枚举 = 给未来的自己埋一个说谎的列。实时状态现算归步 3，
  步 1 不提供（那一刀连关联表都没有，没有可现算的输入——与其供一个恒为「未开始」的
  假状态，不如不提供）。
- **没有 project_public**——这一条最容易被「顺手补上」，别补。本仓没有任何表单/端点能
  把计划置为行级私有（计划新建就是项目级共享），MS 的计划也没有行级私有语义；列永远
  只有 true 一个值 = 谓词恒真 = 白建的索引 + 会骗人的 WHERE，而且
  `shared/visibility.py` 读的是 `getattr(row, "project_public", True)`——喂给它一张没这列
  的表 = 每行都公开且不报错，这个静默失效在 0018 记过账，
  `app/modules/schedule/models.py:10-13` 的注释就是为它写的。
  **所以可见性 = 按 project_id 显式过滤**（schedule_task 这一族的落法）：跨项目访问与
  不存在同码同文案 404，不喂 visibility 助手。判据用例钉两面：跨项目不可见 +
  同项目成员**都能**看见彼此的共享计划（正向断言——它守的是「我们没有行级私有」这个
  决定本身；将来有人给列表喂 visible_clause 会红在那里）。
- **D279 补了 owner_id 与四个时刻列**（stage/planned_start/planned_end/actual_start/
  actual_end）：与「没有实际结束时间」的旧判断不冲突——旧判断针对的是 MS 那种**没有
  写入方**的列；这一版每一列都有写入口（计划表单）和读方（列表/详情/筛选），不存在
  「有 schema 没写入方」。owner_id 只是责任人展示位，**不参与可见性**（仍按 project_id
  显式过滤，见上一条）；actual_* 是手填而非事件自动写：计划的「真正开始/结束」没有
  单一事件可挂（人工执行与外部 run_record 都有），自动写就是拿一个事件冒充全部真相。
- `created_by` 建行的服务写（plan_create）；`updated_by` 每一次改名/改描述/归档都写，
  「谁建的/最后谁动的」是计划列表的展示列（步 6 前端接），审计语义与 schedule_task
  的同名两列一致。
- `name` 同项目唯一（uq_plan_record_project_name）：计划按名引用（报告标题、任务中心），
  同名同项目会让「说的是哪一个」无法回答。environment 同型先例。

plan_case_link（步 2）与 plan_report / plan_report_item（步 4）的逐列口径写在各类
自己的 docstring 里。
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import Boolean, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, UtcDateTime, new_id


class PlanRecord(ProjectScopedMixin, TimestampMixin, Base):
    __tablename__ = "plan_record"
    __table_args__ = (UniqueConstraint("project_id", "name", name="uq_plan_record_project_name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 计划描述。MS 侧计划头带富文本描述，我们一期收纯文本：富文本要接文件库才能放图，
    # 文件库没有（§一 5），收 HTML 串再原样吐给前端渲染 = 前端 XSS 面。Text 不限长。
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 归档 = 终态、单向门（§六 4）：没有反归档端点，要反归档得先请业主裁。
    # 写入方唯一：plan_archive（testplan:plan:manage）；正常更新路径改不到它——
    # PlanUpdateIn 里的 archived 是一枚只拒不存的哨兵（拒收理由见 schemas）。
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    # D211：计划所属模块（可空 = 未分组）。指向 plan_module.id，无外键（全库纪律）；
    # 归属校验由写入方做（plan_create/plan_update 用 _module 验同项目存在）。
    # 模块删除时**不**级联删计划：有计划的模块 409 拒绝删（MS 是递归连计划一起删，
    # 我们不做这种「删文件夹顺手删内容」的隐含级联；计划删除仍只走 plan_delete 显式路径）。
    module_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # D279：测试阶段（自由文本；MS 的阶段来自项目设置的下拉，本仓没有那张设置表，
    # 收自由文本比凭空造词表诚实）。空 = 未填。
    stage: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # D279：计划/实际起止时刻。两对的先后顺序由服务层校验（结束早于开始 → 422），
    # 列上不再加 DB CHECK——跨方言的 CHECK 行为不一致，服务层是唯一写入口。
    planned_start: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    planned_end: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    actual_start: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    actual_end: Mapped[datetime | None] = mapped_column(UtcDateTime(), nullable=True)
    # D279：责任人（app_user.id，无外键；写入时校验是本项目成员）。只是展示/筛选位，
    # 不是可见性列——见类 docstring 的第一条。
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    # D285：标签（逗号串，与功能用例/场景/接口定义同存法；`shared/tags.py` 统一读写）。
    # 空 = 无标签；列表顶层 `tag` 精确筛选用 FIND_IN_SET（不用 LIKE，bug1 不命中 bug10）。
    tags: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class PlanFollower(Base):
    """计划关注人 `plan_follower`（D231）：复合主键 = (plan_id, user_id)，一人一计划一行。

    形状与缺陷关注（defect/models.py:205 DefectFollower）同族，权限也同尺：MS 用 READ 位
    就能 follow/unfollow，我们**写副作用一律走写位**（`testplan:plan:update`），不借 read。

    要点名 `created_by` 吗？不需要：关注行的身份就是「谁」，`user_id` 本身就是答案。
    只保留 `created_at`（关注时间）；**不建 `updated_at`**——关注关系没有更新语义，
    建了就是一列永远等于 created_at 的假列。

    - 没有 `followed` 反向列：状态由本表「有没有这行」回答，不存第二份真相。
    - 级联在应用层（全仓零 ForeignKey）：plan_delete / plan_batch_delete 的 `_purge_plan`
      同事务按 plan_id 删净本表（与关联/报告/结论同一条事务）；删用户不级联
      （用户行被删后关注行悬空，计数仍如实——MS 同款）。
    - 可见性 = `project_id` 显式过滤（与本表族一致）：`followed_by_me` 的列表轴只在
      当前项目内取「我关注的行」，跨项目的关注行不会混进另一个项目的列表。
    """

    __tablename__ = "plan_follower"

    plan_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False,
                                                 default=lambda: datetime.now(UTC))


class PlanModule(ProjectScopedMixin, TimestampMixin, Base):
    """计划模块树节点（D211）：计划列表的左树 + 按模块过滤 + 模块计数。

    形状与 functional_module 同族（parent_id + sort + 同父重名 409 + 防环），但**不做回收站**：
    计划本身没有回收站（物理删），模块再搞一套软删会让「模块在、计划没了」与
    「模块没了、计划在哪」两种半截现场并存。删模块的规则是**非空 409**：
    有子模块或有计划（含归档计划）就拒绝，先搬走/删掉内容再删——不做 MS 的递归删计划
    （`TestPlanModuleService.deleteModule` 会递归把模块下的计划一起 batchDelete；
    那是一次误点清空一整个模块的隐含级联，与本仓 D183 步 1「删除不藏第二层动作」相反）。

    - `parent_id` 可空 = 根模块；防环在 plan_module_update（不能把节点挂到自己子树）。
    - `name` 同父唯一：DB 约束 (project_id, parent_id, name) 在 parent_id NULL 时 MySQL
      不拦重复（NULL 互不相等），所以服务层 `_sibling_name_taken` 是真正生效的那道门；
      约束只为非根节点兜底。functional_module 同款落法。
    - `sort` 升序，同值按 (name, id) 兜底——树渲染绝不出现不确定序。
    - 计数不存列：tree 端点现场按 plan_record.module_id 聚合（archive 不改 module_id，
      所以计数含归档；要排除归档是列表过滤的事，不是树的事）。
    """

    __tablename__ = "plan_module"
    __table_args__ = (
        UniqueConstraint("project_id", "parent_id", "name", name="uq_plan_module_parent_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class PlanCaseLink(ProjectScopedMixin, TimestampMixin, Base):
    """关联行 plan_case_link（D183 步 2）：一张表装四种可执行 subject，不学 MS 一类一张。

    通用指针 (subject_type, subject_id) 接 run_record（execution/models.py:20-21 已验证的
    形状）：计划的执行数据源就是 run_record，关联表**不复制**任何执行结论（§三 2——MS 的
    「最近结果/最近时间/最近报告 id」三件套全仓无写入方，纯接口计划的现算状态永远停在
    未开始，就是这三列没人维护出来的；存结论 = 存一条会随重跑腐烂的谎）。

    - **subject_type 只收四种可执行用例**：api_case / scenario / ui_case / adb_case，
      写入口 422 拒收其它值（词表 PLAN_LINK_SUBJECT_TYPES）。run_record 实际有六个取值，
      拒收 `inline` 是因为它的 subject_id 是常量 "inline"（api_test/services.py:476）——
      挂它进计划会匹配到**所有** inline run，是一条永远说不清的关联；`api_definition`
      不是「用例」这一层的东西。**不许**默默收下词表外的值：那条关联行会永远显示
      「未执行」，是判据 1 那一类病的对偶（有写入方、没有真相）。
    - **uq(plan_id, subject_type, subject_id)**：同一对象在同一计划里只能挂一条——
      重复挂会让步 3 的执行率分母重复计数（MS 的关联表同尺）。不同计划挂同一对象
      必须允许：「同一用例挂两个计划可以用不同环境跑」是 §二 3 那条能力的全部意义。
    - `executor_id`（D206）：这条关联指派给谁执行，可空（= 未指派）。写入方只有
      plan_link_assign（批量指派/取消指派，先验对方是本项目成员）；读方 = 关联列表与
      功能用例列表的「执行人」列。它只是**指派**，不是「谁真的执行了」——真实执行人
      在 run_record / plan_functional_exec.executed_by，两者不互相覆盖。
    - `sort_order`（D206）：计划内手工排序位（升序；同值按 id 兜底，绝不出现不确定序）。
      写入方只有 plan_link_sort（拖拽后整批重排）；读方 = plan_link_list 的 ORDER BY
      与前端拖拽回显。默认 0 = 从未排过，列表退化回 id 升序（D183 的绝对序不变）。
    - `env_id` 可空，**这一列是「这条关联用什么环境」的权威值**（§二 3）：执行读关联行
      这一份，而不是用例上当前的环境。建关联时能抄就抄（scenario/ui_case 有值则抄），
      抄不到留空——三种 subject 的环境来源本来就不一样（§四 末段：api_case 没有 env 列、
      环境是执行时由请求体带的；adb_case 没有且 §4.5 刻意不列），留空 = 沿用该 subject
      自己的默认口径。禁止为「统一」给那两个域补 env 列。
    - `subject_name` 是**快照名**（run_record.subject_name 同款理由）：对象被删后列表
      仍可读，不 join 别人的表就能说出「这里曾经挂过什么」。写入方 = plan_link_create
      （从对应域的表抄一次），读取方 = plan_link_list 自己。
    - `created_by`：谁把这条挂进来的（关联列表展示列，plan_create.created_by 同款语义）。
    - 级联删除在**应用层**（全仓零 ForeignKey 的纪律，plan_delete 与删关联同事务一次
      commit，services.plan_delete）；不引入全仓第一个外键——那是 §5 架构评审的事。
    """

    __tablename__ = "plan_case_link"
    __table_args__ = (
        UniqueConstraint("plan_id", "subject_type", "subject_id", name="uq_plan_case_link_plan_subject"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    # 指向 plan_record.id。无外键（全库纪律），级联由 plan_delete 应用层做（类 docstring）。
    plan_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    subject_type: Mapped[str] = mapped_column(String(24), nullable=False)  # 四值词表，见类 docstring
    subject_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    subject_name: Mapped[str] = mapped_column(String(200), nullable=False)  # 快照名，对象删除后仍可读
    env_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # D206：指派执行人（可空 = 未指派）+ 手工排序位（升序，同值按 id 兜底）。
    executor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


PLAN_FUNCTIONAL_RESULTS: tuple[str, ...] = ("pass", "fail", "blocked", "skip")


class PlanFunctionalExec(ProjectScopedMixin, TimestampMixin, Base):
    """计划内功能用例的**当前执行结论**（D204；一条关联一行，重复执行覆盖）。

    为什么不像接口/场景那样 join run_record：功能用例在计划里是**人工执行**（点通过/
    不通过/阻塞/跳过），没有 run_record 可 join。MS 把结论写在 `test_plan_functional_case`
    行上（一份单行状态），我们沿用同一语义但**不往 plan_case_link 上塞列**——关联行是
    「挂了什么」的指针，结论是「跑成什么」的事实，两条生命周期不同的东西不混表
    （D183 步 2 的 docstring 已钉过「关联行不复制执行结论」）。

    - `link_id` 唯一：一条关联只有一个当前结论；历史在 plan_functional_exec_history
      追加（append-only，谁改过看得见）。
    - `result` 四值 pass/fail/blocked/skip：blocked/skip 在通过率口径里算「未通过」
      （`_functional_result` 一处解释），但列表行显示原值，不把「阻塞」谎报成「失败」。
    - `executed_by/executed_at`：谁在什么时刻给的结论（当前结论的写入方）。updated_at
      由 TimestampMixin 的 onupdate 负责，语义 = 「这条结论最后被改的时刻」。
    - 级联：摘挂（plan_link_delete）与删计划（plan_delete）同事务删净本表与历史表；
      删用例本体**不动**计划侧的关联/结论（快照 + 证据链，D183 同口径）。
    """

    __tablename__ = "plan_functional_exec"
    __table_args__ = (UniqueConstraint("link_id", name="uq_plan_functional_exec_link"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    plan_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    link_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    case_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    result: Mapped[str] = mapped_column(String(16), nullable=False)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    executed_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    executed_at: Mapped[datetime] = mapped_column(UtcDateTime(), nullable=False)


class PlanFunctionalExecHistory(ProjectScopedMixin, TimestampMixin, Base):
    """功能用例结论变更的 append-only 流水（D204）。

    每次 execute（含同值重复提交）都追加一行——「谁在什么时候改成了什么」是计划执行
    记录的最小可追责面。行不可变（没有任何 update/delete 服务）；级联只随关联/计划删。

    排序用 `seq`（每条关联内 1,2,3…）而不是 created_at：MySQL DATETIME 默认秒级精度，
    同一秒内的两次改判用时间戳分不出先后（D204 测试当场栽过），序号才是确定事实。
    """

    __tablename__ = "plan_functional_exec_history"
    __table_args__ = (Index("ix_plan_functional_exec_history_link_seq", "link_id", "seq"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    plan_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    link_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    case_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    result: Mapped[str] = mapped_column(String(16), nullable=False)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    executed_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class PlanReport(ProjectScopedMixin, TimestampMixin, Base):
    """报告头 plan_report（D183 步 4）：一次快照的头部，此后**独立演化**。

    快照语义（§二 2，判据 2 的靶心）：plan_report_create 把「生成时刻的计划名/结论/计数」
    抄进本行与 plan_report_item，之后改用例、再执行 N 次、归档计划——**本行一个字节都不动**，
    读取路径没有任何重算（MS 同口径；MS 唯一的例外「按任务查实时进度」我们整块不做，
    §一 后置的「任务中心」那一行也说了计划侧只读进度，报告不是它的数据源）。

    与 §四 表格的**两条已裁偏差**（业主口径优先于表格措辞，记在这里防「顺手补列」）：

    1. **没有 `pass_threshold` 列**。§四 表格写「生成时抄通过阈值进报告」，但落不了地的
       原因 = **源列不存在**：`plan_record` 恰好九列（步 1 的 DDL 用例逐列钉着），没有任何
       阈值可抄；MS 的阈值来自它的计划配置表单，我们没有那一栏。凭空造一列
       `pass_threshold` = 「有 schema 没写入方」= 判据 1 白纸黑字禁的病，而本刀存在的意义
       正是不重犯它（§三 1/2/3）。要加阈值：先给 plan_record 加**可写的源列**（另一刀、
       另一个 §5 评审），再谈抄进报告。
    2. **「通过/未通过」这一展示轴整轴不做**。MS 的 pass/fail 报告态 = 通过率 ≥ 阈值，
       阈值没有 ⇒ 这一轴没有诚实的算法。存量的 `status` 列因此装的是步 3 的**四态展示态**
       词表（not_started/in_progress/completed/archived，_plan_display 现算后**抄成快照**）
       ——它是「生成那一刻计划处于什么态」的定格，不是会腐烂的第五态。

    逐列口径（判据 1 的正面清单；写入方全部 = plan_report_create 一个函数，读取方逐列点名）：
    - `plan_id`：指向 plan_record.id，生成时抄（无外键纪律同 plan_case_link）。读方 =
      详情/列表的归属谓词 + **plan_delete 的级联**（与删计划同事务按 plan_id 删净，
      同 §四 那笔债在步 2 的还法——不补这条就是「计划没了、报告还在」的孤儿报告）。
      级联只按 plan_id，别的计划一根毫毛不许动（步 2 判断 3 同款断言）。
    - `name`：报告名。生成时写入（payload 给名，没给则抄计划名）；D210 起可经
      `plan_report_rename`（PATCH /plan-reports/{id}，perm testplan:report:update）改名——
      这是 MS `/reName` 的同位，**只写 name 一列**。快照冻结的是内容（status/五个计数/明细），
      标题是元数据；改标题不是重算，也不动任何证据。读方 = 列表/详情。
    - `status`：生成时刻 _plan_display 的快照值。写入方 = plan_report_create（就是唯一
      写入方，没有第二条路改它）；读方 = 详情/列表。**读取路径现算它是被禁的**：
      快照用例（判据 2）+ 变异 M-读路径现算 一起守这一点。
    - `total/passed/failed/executed/executing`：生成时刻 plan_status 同款聚合的**副本**
      （同一份 _link_results/_link_result 算出来的，口径与步 3 逐字相同 = 判据 3）。
      整数组由生成路径一次写入；读方 = 详情/列表的汇总区。**不存 pass_rate/execute_rate/
      not_executed**：它们是这五个计数上的纯函数（除法无独立信息），存两份 = 两份会各自
      漂移的真相——判据 3 要钉的是**口径逐字相同**，不是**列数相同**。
    - `created_by/created_at/updated_at`：语义与 plan_record 同族。updated_at 的第二个写入方
      是 D210 的改名服务（只改 name）；**内容列**（status/五个计数）仍无列外路径——
      「行内容不可变 ⇒ 未改名的行 updated_at ≡ created_at」仍是快照语义的断言
      （用例 test_generated_rows_are_immutable_stamp 从库侧逐行钉；D210 起该断言的
      口径是「改名之外没有任何路径动过内容」，改名用例单独钉「改名只动 name/updated_at」）。
      若业主判这列多余，删列与删那条断言是同一个提交。
    """

    __tablename__ = "plan_report"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    plan_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 生成时刻的展示态定格（PLAN_DISPLAY_STATUSES 四值词表；「通过/未通过」轴不做，见类 docstring）
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    total: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    passed: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    executed: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    executing: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class PlanReportItem(ProjectScopedMixin, TimestampMixin, Base):
    """报告明细 plan_report_item（D183 步 4）：一条关联行在生成时刻的结论副本。

    §三 3 那个环在这里闭合：MS 的「执行生成的报告里接口/场景明细行结果无写入方」（生成时
    显式置 null、全仓无 update）是**必须自己补**的环——本表的 result/executed/executing
    与 plan_report_create **同刀落地**：生成服务逐行算好再插，不写「以后接」的注释，
    用例证明「明细里的结果确实由生成路径写进去的、不是默认值」。

    - **不存任何 run 指针**（无 run_id/last_run_id 列）：run_record 同秒无确定全序
      （DATETIME 精度 0 + uuid 主键，步 3 判断 1 实测），「最近一条 run」选不出诚实的
      定义——不建一个定义不出选哪条的指针列（判据 1）。存的是**与顺序无关的结论与计数**
      （有无终态 / 终态里有无 failed·error / 生成时刻的通过失败计数），词表与算法复用步 3
      的 _link_result 与三组词表——两套判定 = 两份会各自漂移的真相。
    - MS 报告明细那个「最近执行报告 id」指针字段在开源仓**永远为空**（取证 §6 第 2 条），
      照抄它 = 抄一个说谎的指针。
    - 逐列：`report_id`（指向 plan_report.id，生成时写；读方 = 详情按 report_id 取明细 +
      plan_report_delete 级联删明细）；`link_id`（指向 plan_case_link.id，**证据链**：
      摘挂/删关联都不许断——MS 对「删了关联、报告还要自证当时结论」的同款处理。摘挂是
      link_delete/plan_delete 的事，它们**不许**动已生成的明细，用例钉这一点）；
      `subject_type/subject_id`（从关联行抄，明细按它可追溯回对象）；
      `subject_name/env_id`（生成时刻的快照副本——之后改用例名、改绑环境都不动这里）；
      `executed/executing/result`（生成路径现算后抄入的结论，词表同 LINK_RESULTS）。
    - `created_at/updated_at`：同 PlanReport 的诚实条款——行不可变（没有任何 update 路径），
      updated_at ≡ created_at 是「快照没被动过」的断言本身。
    - 唯一键 (report_id, link_id)：一份报告里一条关联只出现一次（uq_plan_report_item_report_link）。
      不学 MS 的「允许重复关联」半实现开关（§三 4）——我们 uq 直接钉死，语义说得出话。
    """

    __tablename__ = "plan_report_item"
    __table_args__ = (UniqueConstraint("report_id", "link_id", name="uq_plan_report_item_report_link"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    report_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    # 指向 plan_case_link.id 的证据链：没有外键（全库纪律），摘挂与已生成明细的互不动
    # 由用例钉（link_delete 不动报告明细、报告明细引用已消失的 link 仍可读）。
    link_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    subject_type: Mapped[str] = mapped_column(String(24), nullable=False)
    subject_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    subject_name: Mapped[str] = mapped_column(String(200), nullable=False)
    env_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    executed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    executing: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    # LINK_RESULTS 三值词表（none/passed/failed），生成路径写入——本表的存在意义就是
    # 这一列有写入方（§三 3）。默认值 False/none 只是库级兜底，生成路径永远显式写值。
    result: Mapped[str] = mapped_column(String(16), nullable=False, default="none", server_default="none")
