"""计划域模型（D183 §四；列风格照 run_record——execution/models.py:16）。

plan_record 这一张表是整个计划的「形状示范」：每一个列都要能回答「谁写、谁读」
（计划 §三 6、§六 1），MS 有四列设计了没人写（实际结束时间、关联行三件套、报告明细结果、
死表列——取证 §三 1/2/3、§三 6），这一刀的存在意义就是不重犯。逐列口径：

- **只有 `archived` 一个状态真相**。MS 的 DDL 注释写四态、实际只写两值，中间态
  「未开始/进行中/已完成」是查询时拿关联行的最近结果现算的（取证 §二 1）。我们照这个
  形状：存一列没人维护的枚举 = 给未来的自己埋一个说谎的列。实时状态现算归步 3，
  步 1 不提供（那一刀连关联表都没有，没有可现算的输入——与其供一个恒为「未开始」的
  假状态，不如不提供）。
- **没有「实际结束时间」**：MS 有 set/clear 两条 update 语句但全仓没有任何 service 调
  set（取证 §三 1）。没有写入方的列不建，直到「计划的结束」由哪个事件说得清。
- **没有 owner_id / project_public**——这一条最容易被「顺手补上」，别补。本仓没有任何
  表单/端点能把计划的 project_public 置 false（计划新建就是项目级共享），MS 的计划也
  没有行级私有语义；列永远只有 true 一个值 = 谓词恒真 = 白建的索引 + 会骗人的 WHERE，
  而且 `shared/visibility.py` 读的是 `getattr(row, "project_public", True)`——喂给它
  一张没这列的表 = 每行都公开且不报错，这个静默失效在 0018 记过账，
  `app/modules/schedule/models.py:10-13` 的注释就是为它写的。
  **所以可见性 = 按 project_id 显式过滤**（schedule_task 这一族的落法）：跨项目访问与
  不存在同码同文案 404，不喂 visibility 助手。判据用例钉两面：跨项目不可见 +
  同项目成员**都能**看见彼此的共享计划（正向断言——它守的是「我们没有行级私有」这个
  决定本身；将来有人给列表喂 visible_clause 会红在那里）。
- `created_by` 建行的服务写（plan_create）；`updated_by` 每一次改名/改描述/归档都写，
  「谁建的/最后谁动的」是计划列表的展示列（步 6 前端接），审计语义与 schedule_task
  的同名两列一致。
- `name` 同项目唯一（uq_plan_record_project_name）：计划按名引用（报告标题、任务中心），
  同名同项目会让「说的是哪一个」无法回答。environment 同型先例。

plan_case_link（步 2）与 plan_report / plan_report_item（步 4）的逐列口径写在各类
自己的 docstring 里。
"""
from __future__ import annotations

from sqlalchemy import Boolean, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, ProjectScopedMixin, TimestampMixin, new_id


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
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


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
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


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
    - `name`：报告名。生成时写入（payload 给名，没给则抄计划名）；此后**不可改**
      （没有 update 服务——重命名是 MS 报告端点，本刀不做，§四 表格外）。读方 = 列表/详情。
    - `status`：生成时刻 _plan_display 的快照值。写入方 = plan_report_create（就是唯一
      写入方，没有第二条路改它）；读方 = 详情/列表。**读取路径现算它是被禁的**：
      快照用例（判据 2）+ 变异 M-读路径现算 一起守这一点。
    - `total/passed/failed/executed/executing`：生成时刻 plan_status 同款聚合的**副本**
      （同一份 _link_results/_link_result 算出来的，口径与步 3 逐字相同 = 判据 3）。
      整数组由生成路径一次写入；读方 = 详情/列表的汇总区。**不存 pass_rate/execute_rate/
      not_executed**：它们是这五个计数上的纯函数（除法无独立信息），存两份 = 两份会各自
      漂移的真相——判据 3 要钉的是**口径逐字相同**，不是**列数相同**。
    - `created_by/created_at/updated_at`：语义与 plan_record 同族。updated_at 有写入方吗？
      **没有列外路径**——本刀之后若加「改报告名」服务它才有第二个值；现在它与 created_at
      同值来自 TimestampMixin 的 default。诚实条款：这一列在场的原因是**行不可变 ⇒
      updated_at ≡ created_at 是快照语义的断言本身**（用例
      test_generated_rows_are_immutable_stamp 从库侧逐行钉 `updated_at == created_at`，
      正拿它俩相等钉「没有任何路径动过这行」），不是「最后修改时间」的展示语义。
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
    __table_args__ = (
        UniqueConstraint("report_id", "link_id", name="uq_plan_report_item_report_link"),
    )

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
