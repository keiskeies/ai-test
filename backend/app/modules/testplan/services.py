"""计划域 @service（D183 步 1 本体 CRUD/归档 + 步 2 关联 CRUD/级联 + 步 3 实时状态现算）。

步 1 的四条判断，都各有一条测试钉着（tests/test_d183_plan_crud.py）：

**1. 可见性 = 按 project_id 显式过滤，不喂 `shared/visibility`。** plan_record 没有
project_public 列（理由逐字写在 models.py docstring：没有表单能把计划置为行级私有，
visibility 助手对缺列的表会静默「每行都公开」——schedule_task 同款落法）。D279 加的
owner_id 只是责任人展示/筛选位，**不参与可见性**（不按 owner 收窄）。
跨项目访问与不存在同码同文案（不泄露存在性，`_plan` 的 404 是唯一出口）。
两面都有用例：跨项目 404 且与「不存在」逐字同文；同项目内成员**都能**看见彼此的
共享计划——正向断言，守的是「我们没有行级私有」这个决定本身，将来有人给列表加
visible_clause 会红在这里。

**2. 归档走 `testplan:plan:manage`，不走 `:update`。** 照 D159 在
adb_test/device_services.py:193-194 的同款理由：MEMBER 的 `-*:manage` 显式拒绝把这一位
收窄到项目管理员及以上。归档是单向门（§六 4，无反归档路径），操作面必须比改名窄。
正常更新路径也到不了 archived，而且**到不了的方式是说得出话的**：`PlanUpdateIn` 用一枚
只拒不存的哨兵字段把 `archived` 挡在校验门外（422 + 指向 /archive），不是靠 FastAPI
丢未知键的 200——机制与理由写在 schemas.PlanUpdateIn 的 docstring。

**3. 删除是物理删**（§四 末段，照 MS，无回收站）。步 1 没有关联表，硬删没有孤儿行；
步 2 建了 plan_case_link 并**兑现级联**：plan_delete 与删关联同事务一次 commit
（判断见下面的步 2 第 3 条），用例在 test_d183_plan_links.py 里证明级联真发生。

**4. 状态只有 archived 一个持久值。** 列表/详情不回「未开始/进行中/已完成」——那是
步 3 拿关联行现算的展示态（本刀只有关联表与关联 CRUD，现算与执行率仍归步 3）。

步 2 的三条判断（各由 tests/test_d183_plan_links.py 的用例钉着；口径是业主在派活时
裁定的，业主若改口径回头改这里）：

**1. 词表四值，词表外 422。** `plan_case_link` 只收 api_case / scenario / ui_case /
adb_case（schemas.PLAN_LINK_SUBJECT_TYPES 单份词表，写入口与测试读同一份）。拒收
`inline`：它的 subject_id 是常量 "inline"（api_test/services.py:476），挂进计划会匹配到
所有 inline run，是一条永远说不清的关联；拒收 `api_definition`：不是「用例」这一层的
东西。**默默收下词表外的值 = 一条永远显示「未执行」的关联行**——判据 1 那一类病的对偶
（有写入方、没有真相）。用例各断言一次：四种合法值收、`inline` 与 `"nonsense"` 拒。

**2. uq(plan_id, subject_type, subject_id)，同计划重复挂 409；不同计划挂同一对象放行。**
重复挂会让步 3 的执行率分母重复计数（MS 的关联表同尺）。而「同一用例挂两个计划可以用
不同环境跑」是 §二 3 那条能力的全部意义——把跨计划重复也一起禁了就把这条能力禁掉了，
用例钉正反两面。

**3. 级联 = 应用层，与 plan_delete 同事务。** 全仓零 ForeignKey（grep 实测），不引入
全仓第一个外键（那是 §5 架构评审的事）：删计划前按 plan_id 删干净关联行、再删计划，
**一次 commit**。谓词只按 plan_id——不许全表删，用例断言别的计划的关联行一根毫毛没动。

步 3 的四条判断（各由 tests/test_d183_plan_status.py 的用例钉着）：

**1. 「最近一次执行」这条路走 (b)：干脆不承诺「最近」。** run_record 的
created_at/updated_at/started_at/finished_at 全是 MySQL DATETIME 精度 0（information_schema
实测），而主键是 uuid4（core/db.py:52）——同一秒内的两条 run 之间没有确定全序，任何
「取最近一条」的 ORDER BY 都是假装有秩序。本刀的状态口径本来就不需要「最近那一条的具体
身份」：每条关联只问三件**与顺序无关**的事——「有没有过终态」「终态里有没有 failed/
error」「有没有 queued/running」。代码里没有一处 run_record 的 ORDER BY，tie-break 这个
问题因此不存在，而不是被一个任意的定义掩盖掉。

**2. 有终态但混着失败 → 结论记 failed（保守口径）。** 顺序不可用 ⇒ 「最近一次的结论」
不可严格判定；一条关联若既有 passed 又有 failed 终态，报 passed 可能把最后跑挂的用例
洗成绿的——谎的方向必须是「宁可显坏」。口径写进 _link_result，用例钉「先 passed 后
failed 的乱序造行也报 failed」。

**3. 终态词表三值写死，非 passed ≠ 失败。** run_record.status 实际五值（execution/
models.py:26 的注释「passed/failed/error」是错的，实测 new_run 出生即 queued、worker
领取置 running）：已执行 = 存在 ≥1 条终态（passed/failed/error）；queued/running 算
「执行中」，不算已执行、也不算任何结论，但拉低通过率的分母（§六 3）。cancelled/skip 是
run_step_result 层的状态，不在本映射内（词表里没有它们，出现也不识别——未知状态既不
计已执行也不计执行中，保守到「什么都不算」，将来加词要过用例）。

**4. 状态一个列都不存，读面 = GET /plans/{plan_id}/status 一个端点。** 库里仍只有
archived 一个真相（步 1 的 DDL 用例继续钉列集）；本刀**不**给计划列表端点挂状态——
列表行内嵌状态要把 N 次聚合折成批查询、页内排序键也要重新定，那是另一刀的活
（§五 步 6 前端接入时再裁）。本刀无「两种排序/取数模式的列表端点」（判据 7 前提不成立：
status 端点是单计划详情形状，plan_list/plan_link_list 的页码单键 id 序原样未动）。

步 4 的四条判断（各由 tests/test_d183_plan_reports.py 的用例钉着）：

**1. 报告的「执行结论」走步 3 的 (b) 路，不写「最近一次 run」。** run_record 的四个时刻列
全是 DATETIME 精度 0、主键 uuid4——同秒两条 run 没有确定全序（步 3 判断 1 实测），
「取最近一条再抄进报告」在我们这儿做不到诚实地成立；MS 报告明细那个 last_exec_report_id
指针在开源仓永远为空（取证 §6 第 2 条），照抄 = 抄一个说谎的指针。落法：明细存
**与顺序无关的结论与计数**（executed/executing/result + 头行五个计数），判定复用步 3 的
_link_result 与三组词表、取数复用 _plan_links、算式复用 _rates/_plan_display——
**一个函数，不是两份长得像的实现**（两套判定 = 两份会各自漂移的真相，§六 3「口径逐字
相同」的实现形态就是共用代码本身）。不建 run_id/last_run_id 指针列。

**2. 没有 pass_threshold 列，「通过/未通过」轴整轴不做。** 计划 §四 表格那句「生成时抄
通过阈值进报告」落不了地的原因 = **源列不存在**（plan_record 恰好九列，步 1 DDL 用例钉着；
MS 的阈值来自它的计划表单，我们没有那一栏）。凭空造列 = 判据 1 禁的「有 schema 没写入方」，
本刀的存在意义就是不重犯它。偏差记在 PlanReport 模型 docstring；要阈值先给 plan_record
加可写源列（另一刀、另一个 §5 评审）。status 列因此装步 3 四态词表的**定格**，不是第五态。

**3. §三 3 的环闭合：明细结果的写入方 = plan_report_create 本身，与建表同刀。**
生成服务逐行现算后插入，没有「以后接」的注释；用例证明「明细里的结果由生成路径写进去、
不是默认值」。同时**大声失败**（判据 6，MS 取证 §6 第 10 条的反面）：头行 + 明细一次
commit，任何异常由路由层统一 rollback（core/service.py:361-367）——失败 = 可见的
4xx/5xx + 库里零半成品，不是被吞的日志。

**4. 级联两条链同刀接进 plan_delete：** 删计划 → 按 plan_id 删净关联、报告头，报告明细
按「本计划的报告 id 子查询」删净，**一次 commit 同事务**（全仓零外键纪律，步 2 判断 3
同款：只按自有谓词删，别的计划的行必须逐根点名没动）。摘挂（plan_link_delete）**不**动
已生成的报告明细——证据链（link_id）允许悬空引用：MS 对「删了关联、报告仍要自证当时
结论」的同款处理，明细行带快照副本，对象/关联消失后报告照读。
"""

from __future__ import annotations

from datetime import UTC, datetime
from html import escape

from sqlalchemy import Select, and_, case, column, func, or_, select, table
from sqlalchemy import delete as sa_delete

from app.core.db import new_id
from app.core.errors import ApiError, OkOut, Page, paginate_page
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.testplan import schemas
from app.modules.testplan.models import (
    PLAN_FUNCTIONAL_RESULTS,
    PlanCaseLink,
    PlanFollower,
    PlanFunctionalExec,
    PlanFunctionalExecHistory,
    PlanModule,
    PlanRecord,
    PlanReport,
    PlanReportItem,
)
from app.shared.filter_registry import FieldDecl, ListViewFilter, register
from app.shared.tags import join_tags, split_tags

# 关联 subject 的归属校验用**表名反射**而非 import api_test/scenario/ui_test/adb_test——
# 领域模块之间零横向 import 是 import-linter 契约 1 的红线，scenario/services.py 的
# ENVIRONMENT/API_CASE 两份反射与 execution 的 ledger R28 同理由。每份只带本文件用到的列。
SUBJECT_LABELS = {
    "api_case": "接口用例",
    "scenario": "场景",
    "ui_case": "UI 用例",
    "adb_case": "ADB 用例",
    "functional_case": "功能用例",
}
# env_id **只出现在 scenario/ui_case 两份反射里**——api_case/adb_case/functional_case
# 没有这一列（§四 末段的现查结论：api 的环境在执行时由请求体带、adb 的 §4.5 刻意不列；
# 功能用例是人工执行，不绑环境）。反射列抄多了就是对不存在的列写 SQL。
SUBJECT_TABLES = {
    "api_case": table("api_case", column("id"), column("project_id"), column("name"), column("status")),
    "scenario": table(
        "scenario", column("id"), column("project_id"), column("name"), column("status"), column("env_id")
    ),
    "ui_case": table(
        "ui_case", column("id"), column("project_id"), column("name"), column("status"), column("env_id")
    ),
    "adb_case": table("adb_case", column("id"), column("project_id"), column("name"), column("status")),
    "functional_case": table(
        "functional_case", column("id"), column("project_id"), column("name"), column("status")
    ),
}
# 功能用例详情/自定义字段读取用（跨域反射，不 import functional——import-linter 契约 1）。
FUNCTIONAL_CASE = table(
    "functional_case",
    column("id"),
    column("project_id"),
    column("name"),
    column("num"),
    column("priority"),
    column("module_id"),
    column("description"),
    column("status"),
)
FUNCTIONAL_CASE_FIELD = table(
    "functional_case_custom_field",
    column("case_id"),
    column("field_id"),
    column("project_id"),
    column("value"),
)
# 环境归属校验（D181 同款，scenario/services.py 的 _env 形状）。
ENVIRONMENT = table("environment", column("id"), column("project_id"))
# 步 3 现算的 run 侧：同样**表名反射**不 import execution（import-linter 契约：execution
# 与各领域模块零横向依赖，反向同样不许）。列逐个对 app/modules/execution/models.py 现核
# （RunRecord，:16-41）：id/subject_type/subject_id/project_id/status 五列都在、名同。
# 刻意**不带** started_at/finished_at/created_at——本刀的状态口径与顺序无关（步 3 判断 1
# 走 (b) 路），带时间列就会诱惑后人加 ORDER BY 假装有秩序。cancelled/skip 属
# run_step_result.status，不在这张表上（判断 3），词表也不认它们。
RUN_RECORD = table(
    "run_record",
    column("id"),
    column("project_id"),
    column("subject_type"),
    column("subject_id"),
    column("status"),
)
# D207：计划缺陷清单跨域反射（defect 域已落地，但契约 1 禁止 import；与服务侧口径逐列现核）。
# 只带列表投影 + 谓词用到的列：recycled 是回收站轴（回收站里的缺陷不该出现在计划清单里），
# updated_at 是默认排序键之一。**不**带 description/template_id 等详情列。
DEFECT = table(
    "defect",
    column("id"),
    column("project_id"),
    column("num"),
    column("title"),
    column("status"),
    column("priority"),
    column("handle_user_id"),
    column("tags"),
    column("recycled"),
    column("created_at"),
    column("updated_at"),
)
# 缺陷↔用例关联：本项目内 `(case_type, case_id)` 指向计划内关联行。
DEFECT_CASE_LINK = table(
    "defect_case_link",
    column("id"),
    column("project_id"),
    column("defect_id"),
    column("case_id"),
    column("case_type"),
)
APP_USER = table("app_user", column("id"), column("name"))
# D206 执行人归属校验：只读 project_member 是否存在 (project_id, user_id)。
# **表名反射而非 import iam.models**——领域模块之间零横向 import 是 import-linter 契约 1
# 的红线（本文件顶部 SUBJECT_TABLES 同款理由）；这里只需要证明「是不是本项目成员」，
# 不读角色、不读用户资料，带三列都嫌多，两列谓词就够。
PROJECT_MEMBER = table(
    "project_member", column("id"), column("project_id"), column("user_id")
)
# 词表（schemas，写入口校验与测试读的同一份）与反射表不许分叉：长出一边忘另一边 =
# 校验放行后查表 KeyError 500，或表反射在的词被 422 冤杀。在 import 时大声炸，
# 不留一条任何用例都走不到的运行期兜底分支（判据 1 的同一条纪律用在代码上）。
assert frozenset(SUBJECT_TABLES) == frozenset(schemas.PLAN_LINK_SUBJECT_TYPES), (
    "SUBJECT_TABLES 与 PLAN_LINK_SUBJECT_TYPES 分叉了：" + str(sorted(SUBJECT_TABLES))
)

# D212：计划列表的可筛面（§11.5.1 / D47-a 从「接口」页铺到计划页）。字段全是 plan_record
# 上真实存在的列，白名单外的字段 → 400 带本页清单，不静默忽略。project_id 刻意不可筛
# （越权正门，由 ensure_project_access 管）；module_id **可筛**，因为它是业务属性，
# 与左树的「整棵子树」过滤是两个入口（后者走 PlanListIn.module_id，不进条件组）。
PLAN_LIST_FILTER = ListViewFilter(
    view_type="plan",
    label="测试计划",
    fields={
        "name": FieldDecl(PlanRecord.name, "text", "计划名称"),
        "description": FieldDecl(PlanRecord.description, "text", "描述"),
        # archived 在库里 NOT NULL：FieldDecl 自动拿不到「为空/不为空」。
        "archived": FieldDecl(PlanRecord.archived, "bool", "是否归档", nullable=False),
        "module_id": FieldDecl(PlanRecord.module_id, "id", "所属模块"),
        # D279：阶段/计划与实际起止/责任人（六列都是真实列，白名单外字段照旧 400）。
        "stage": FieldDecl(PlanRecord.stage, "text", "测试阶段"),
        "planned_start": FieldDecl(PlanRecord.planned_start, "time", "计划开始"),
        "planned_end": FieldDecl(PlanRecord.planned_end, "time", "计划结束"),
        "actual_start": FieldDecl(PlanRecord.actual_start, "time", "实际开始"),
        "actual_end": FieldDecl(PlanRecord.actual_end, "time", "实际结束"),
        "owner_id": FieldDecl(PlanRecord.owner_id, "id", "责任人"),
        "created_by": FieldDecl(PlanRecord.created_by, "id", "创建人"),
        "updated_by": FieldDecl(PlanRecord.updated_by, "id", "更新人"),
        "created_at": FieldDecl(PlanRecord.created_at, "time", "创建时间", nullable=False),
        "updated_at": FieldDecl(PlanRecord.updated_at, "time", "更新时间", nullable=False),
    },
)
register(PLAN_LIST_FILTER)


def _out(p: PlanRecord, owner_name: str | None = None) -> schemas.PlanOut:
    """行 → 出参。owner_name 由读路批量解析后传入（列表一次 IN 查询，避免 N+1）；
    没有可解析的名字时如实给 None，前端画「—」，不画裸 UUID。"""
    return schemas.PlanOut(
        id=p.id,
        project_id=p.project_id,
        name=p.name,
        description=p.description,
        archived=p.archived,
        module_id=p.module_id,
        stage=p.stage,
        planned_start=schemas.iso(p.planned_start),
        planned_end=schemas.iso(p.planned_end),
        actual_start=schemas.iso(p.actual_start),
        actual_end=schemas.iso(p.actual_end),
        owner_id=p.owner_id,
        owner_name=owner_name,
        # D285：标签出数组（库里是逗号串；空 = 无标签）
        tags=split_tags(p.tags),
        created_by=p.created_by,
        updated_by=p.updated_by,
        created_at=schemas.iso(p.created_at),
        updated_at=schemas.iso(p.updated_at),
    )


async def _user_names(db, ids: set[str | None]) -> dict[str, str]:
    """负责人姓名一次批量解析（APP_USER 反射，跨域零 import；defect.services 同款）。"""
    real = {i for i in ids if i}
    if not real:
        return {}
    rows = (
        await db.execute(select(APP_USER.c.id, APP_USER.c.name).where(APP_USER.c.id.in_(real)))
    ).all()
    return {r.id: r.name for r in rows}


async def _out_named(db, p: PlanRecord) -> schemas.PlanOut:
    """写路径（create/update/archive/copy）的回执也要带 owner_name：前端用回执原地
    替换行，缺名字会把「责任人」列洗成「—」。"""
    names = await _user_names(db, {p.owner_id})
    return _out(p, names.get(p.owner_id) if p.owner_id else None)


def _as_naive_utc(dt: datetime | None) -> datetime | None:
    if dt is None or dt.tzinfo is None:
        return dt
    return dt.astimezone(UTC).replace(tzinfo=None)


def _check_span(start: datetime | None, end: datetime | None, label: str) -> None:
    """结束早于开始 → 422。比较前统一成 naive UTC（带 Z 与不带 Z 的输入混比会 TypeError）。"""
    s, e = _as_naive_utc(start), _as_naive_utc(end)
    if s is not None and e is not None and e < s:
        raise ApiError(
            "invalid_time_range", label + "结束时间早于开始时间", 422,
            {"start": schemas.iso(start), "end": schemas.iso(end)},
        )


# ── D231：关注（plan_follower）的两次现查 ──────────────────────────────────────
# 关注态**不存进 PlanOut**：真相在 plan_follower 的行在不在，读取路径每次现查——
# 存一列 followed 就是第二份会漂移的真相（缺陷关注同款：defect/services._followed_ids）。

async def _followed_ids(db, plan_ids: list[str], user_id: str) -> set[str]:
    """本页里「我关注了哪些」——一条 IN 查询批量取，绝不逐行查（N+1）。"""
    if not plan_ids:
        return set()
    rows = (
        await db.execute(
            select(PlanFollower.plan_id).where(
                PlanFollower.plan_id.in_(plan_ids), PlanFollower.user_id == user_id
            )
        )
    ).scalars().all()
    return set(rows)


async def _follower_count(db, plan_id: str) -> int:
    return int(
        (
            await db.execute(
                select(func.count()).select_from(PlanFollower).where(
                    PlanFollower.plan_id == plan_id
                )
            )
        ).scalar_one()
    )


async def _plan(db, project_id: str, plan_id: str) -> PlanRecord:
    """按 (id, project_id) 取行；别项目的计划与不存在同码同文案（不泄露存在性）。

    project_id 谓词是本表可见性的**全部**实现（判断 1）：没有第二层行级过滤，
    列表谓词与这里的谓词同尺——「列表里看得见」与「详情取得到」是同一个条件。
    """
    p = (
        await db.execute(
            select(PlanRecord).where(PlanRecord.id == plan_id, PlanRecord.project_id == project_id)
        )
    ).scalar_one_or_none()
    if p is None:
        raise ApiError("not_found", "计划不存在", 404, {"plan_id": plan_id})
    return p


async def _name_dup(db, project_id: str, name: str) -> None:
    """同项目重名 → 409（uq_plan_record_project_name 的预检，env_create 同款）。

    没有 `exclude` 参数：改名的调用方只在「名字真的变了」时才走到这里（plan_update），
    而名字变了的匹配行必然是另一条——排除自己那行是个永不生效的分支。
    saved_view_update 的同款裁决（view_services._assert_name_free docstring），照抄结论。
    """
    stmt = select(PlanRecord.id).where(PlanRecord.project_id == project_id, PlanRecord.name == name)
    if (await db.execute(stmt.limit(1))).first() is not None:
        raise ApiError("conflict", "计划名已存在", 409, {"name": name})


async def _module(db, project_id: str, module_id: str) -> PlanModule:
    """按 (id, project_id) 取模块；别项目与不存在同码同文案（计划模块树没有回收站，
    所以只有一种「取不到」，不像 functional 还要区分在回收站）。"""
    m = (
        await db.execute(
            select(PlanModule).where(PlanModule.id == module_id, PlanModule.project_id == project_id)
        )
    ).scalar_one_or_none()
    if m is None:
        raise ApiError("not_found", "模块不存在", 404, {"module_id": module_id})
    return m


async def _sibling_name_taken(
    db, project_id: str, parent_id: str | None, name: str, exclude: str | None = None
) -> bool:
    """同父下重名预检（DB 约束在 parent_id NULL 时不拦重复，服务层才是真正生效的门）。"""
    stmt = select(PlanModule.id).where(
        PlanModule.project_id == project_id, PlanModule.name == name
    )
    stmt = (
        stmt.where(PlanModule.parent_id.is_(None))
        if parent_id is None
        else stmt.where(PlanModule.parent_id == parent_id)
    )
    if exclude is not None:
        stmt = stmt.where(PlanModule.id != exclude)
    return (await db.execute(stmt.limit(1))).first() is not None


async def _would_cycle(db, project_id: str, module_id: str, new_parent: str | None) -> bool:
    """沿新父链上溯，撞到自己 = 成环。guard 兜住「库里已有环」的脏数据（不死循环）。"""
    cur = new_parent
    guard = 0
    while cur:
        if cur == module_id:
            return True
        row = (
            await db.execute(
                select(PlanModule.parent_id).where(
                    PlanModule.id == cur, PlanModule.project_id == project_id
                )
            )
        ).first()
        cur = row[0] if row else None
        guard += 1
        if guard > 10000:
            return True
    return False


def _module_children_map(rows: list[PlanModule]) -> dict[str | None, list[PlanModule]]:
    kids: dict[str | None, list[PlanModule]] = {}
    for m in rows:
        kids.setdefault(m.parent_id, []).append(m)
    for v in kids.values():
        v.sort(key=lambda x: (x.sort, x.name, x.id))
    return kids


def _module_subtree_ids(rows: list[PlanModule], root_id: str) -> set[str]:
    """root 及其整棵子树的 id 集合（内存里走一遍，模块树规模是几十上百个节点，
    不值当为一条列表过滤发递归 CTE）。rows 是本项目的全部模块行。"""
    kids = _module_children_map(rows)
    out = {root_id}
    stack = [root_id]
    while stack:
        cur = stack.pop()
        for child in kids.get(cur, ()):
            if child.id not in out:  # 脏数据成环时不死循环
                out.add(child.id)
                stack.append(child.id)
    return out


def _build_module_tree(
    rows: list[PlanModule], counts: dict[str, int]
) -> list[schemas.PlanModuleNode]:
    by_id = {
        m.id: schemas.PlanModuleNode(
            id=m.id,
            parent_id=m.parent_id,
            name=m.name,
            sort=m.sort,
            plan_count=counts.get(m.id, 0),
        )
        for m in rows
    }
    roots: list[schemas.PlanModuleNode] = []
    for m in sorted(rows, key=lambda x: (x.sort, x.name, x.id)):
        node = by_id[m.id]
        if m.parent_id and m.parent_id in by_id:
            by_id[m.parent_id].children.append(node)
        else:
            roots.append(node)
    return roots


@service(
    perm="testplan:plan:read",
    effect="read",
    name="plan_module_tree",
    description="计划模块树（每个模块的直属计划数 + 未分组计划数；计数含归档计划）",
    http={"method": "GET", "path": "/plan-modules/tree", "tags": ["testplan"], "status": 200},
)
async def plan_module_tree(payload: schemas.PlanModuleTreeIn, ctx) -> schemas.PlanModuleTreeOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:read")
    assert ctx.db is not None
    rows = (
        await ctx.db.execute(select(PlanModule).where(PlanModule.project_id == payload.project_id))
    ).scalars().all()
    counts: dict[str, int] = {}
    if rows:
        cr = (
            await ctx.db.execute(
                select(PlanRecord.module_id, func.count())
                .where(
                    PlanRecord.project_id == payload.project_id,
                    PlanRecord.module_id.is_not(None),
                )
                .group_by(PlanRecord.module_id)
            )
        ).all()
        counts = {mid: int(n) for mid, n in cr if mid is not None}
    unassigned = int(
        (
            await ctx.db.execute(
                select(func.count())
                .select_from(PlanRecord)
                .where(
                    PlanRecord.project_id == payload.project_id,
                    PlanRecord.module_id.is_(None),
                )
            )
        ).scalar_one()
    )
    return schemas.PlanModuleTreeOut(
        nodes=_build_module_tree(list(rows), counts), unassigned_count=unassigned
    )


@service(
    perm="testplan:plan:create",
    effect="write",
    name="plan_module_create",
    description="新建计划模块（父模块须在本项目；同父重名 409）",
    http={"method": "POST", "path": "/plan-modules", "tags": ["testplan"], "status": 201},
)
async def plan_module_create(payload: schemas.PlanModuleCreateIn, ctx) -> schemas.PlanModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:create")
    assert ctx.db is not None
    if payload.parent_id is not None:
        await _module(ctx.db, payload.project_id, payload.parent_id)
    if await _sibling_name_taken(ctx.db, payload.project_id, payload.parent_id, payload.name):
        raise ApiError("conflict", "同一父模块下名称已存在", 409, {"name": payload.name})
    m = PlanModule(
        project_id=payload.project_id,
        parent_id=payload.parent_id,
        name=payload.name,
        sort=payload.sort,
    )
    ctx.db.add(m)
    await ctx.db.commit()
    return schemas.PlanModuleNode(
        id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort, plan_count=0
    )


@service(
    perm="testplan:plan:update",
    effect="write",
    name="plan_module_update",
    description="改名/移动/排序计划模块（防环 422、同父重名 409）",
    http={"method": "PATCH", "path": "/plan-modules/{module_id}", "tags": ["testplan"], "status": 200},
)
async def plan_module_update(payload: schemas.PlanModuleUpdateIn, ctx) -> schemas.PlanModuleNode:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:update")
    assert ctx.db is not None
    m = await _module(ctx.db, payload.project_id, payload.module_id)
    parent_id = m.parent_id
    if payload.parent_set:
        parent_id = payload.parent_id
        if parent_id is not None:
            await _module(ctx.db, payload.project_id, parent_id)
            if await _would_cycle(ctx.db, payload.project_id, m.id, parent_id):
                raise ApiError("cycle", "不能把模块移动到自己的子树里", 422, {"module_id": m.id})
    name = payload.name if payload.name is not None else m.name
    if (payload.name is not None and payload.name != m.name) or payload.parent_set:
        if await _sibling_name_taken(
            ctx.db, payload.project_id, parent_id, name, exclude=m.id
        ):
            raise ApiError("conflict", "同一父模块下名称已存在", 409, {"name": name})
    m.name = name
    m.parent_id = parent_id
    if payload.sort is not None:
        m.sort = payload.sort
    await ctx.db.commit()
    count = int(
        (
            await ctx.db.execute(
                select(func.count())
                .select_from(PlanRecord)
                .where(
                    PlanRecord.project_id == payload.project_id,
                    PlanRecord.module_id == m.id,
                )
            )
        ).scalar_one()
    )
    return schemas.PlanModuleNode(
        id=m.id, parent_id=m.parent_id, name=m.name, sort=m.sort, plan_count=count
    )


@service(
    perm="testplan:plan:delete",
    effect="destructive",
    name="plan_module_delete",
    description="删除计划模块（有子模块或计划 → 409；不递归删计划）",
    http={"method": "POST", "path": "/plan-modules/{module_id}/delete", "tags": ["testplan"], "status": 200},
)
async def plan_module_delete(payload: schemas.PlanModuleGetIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:delete")
    assert ctx.db is not None
    m = await _module(ctx.db, payload.project_id, payload.module_id)
    kids = int(
        (
            await ctx.db.execute(
                select(func.count())
                .select_from(PlanModule)
                .where(PlanModule.project_id == payload.project_id, PlanModule.parent_id == m.id)
            )
        ).scalar_one()
    )
    plans = int(
        (
            await ctx.db.execute(
                select(func.count())
                .select_from(PlanRecord)
                .where(
                    PlanRecord.project_id == payload.project_id,
                    PlanRecord.module_id == m.id,
                )
            )
        ).scalar_one()
    )
    if kids or plans:
        raise ApiError(
            "module_not_empty",
            "模块下还有 " + str(kids) + " 个子模块、" + str(plans) + " 个计划，不能删除",
            409,
            {"module_id": m.id, "children": kids, "plans": plans},
        )
    await ctx.db.delete(m)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="testplan:plan:create",
    effect="write",
    name="plan_create",
    description="在项目中创建测试计划（同项目重名 409；新建即未归档的项目级共享计划）",
    http={"method": "POST", "path": "/plans", "tags": ["testplan"], "status": 201},
)
async def plan_create(payload: schemas.PlanCreateIn, ctx) -> schemas.PlanOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:create")
    assert ctx.db is not None
    await _name_dup(ctx.db, payload.project_id, payload.name)
    if payload.module_id is not None:
        await _module(ctx.db, payload.project_id, payload.module_id)
    # D279：责任人必须是本项目成员；两对时间必须同向（结束不早于开始）。
    if payload.owner_id is not None:
        await _check_owner(ctx.db, payload.project_id, payload.owner_id)
    _check_span(payload.planned_start, payload.planned_end, "计划")
    _check_span(payload.actual_start, payload.actual_end, "实际")
    p = PlanRecord(
        project_id=payload.project_id,
        name=payload.name,
        description=payload.description,
        module_id=payload.module_id,
        stage=payload.stage,
        # 统一落 naive UTC：不落的话，create 回执是入参原偏移（+08:00），list/get 是库里
        # 读回的 UTC——同一条记录两种写法，前端按同一格式解析会看到「保存后变了」。
        planned_start=_as_naive_utc(payload.planned_start),
        planned_end=_as_naive_utc(payload.planned_end),
        actual_start=_as_naive_utc(payload.actual_start),
        actual_end=_as_naive_utc(payload.actual_end),
        owner_id=payload.owner_id,
        # D285：标签（去空白/去重保序；空 = 无标签）
        tags=join_tags(payload.tags),
        created_by=ctx.user_id,
        updated_by=ctx.user_id,
    )
    ctx.db.add(p)
    await ctx.db.commit()
    return await _out_named(ctx.db, p)


@service(
    perm="testplan:plan:read",
    effect="read",
    name="plan_list",
    description="列出本项目的测试计划（页码分页；未归档与已归档都在列表里，archived 是列不是筛选）",
    http={"method": "GET", "path": "/plans", "tags": ["testplan"], "status": 200},
)
async def plan_list(payload: schemas.PlanListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:read")
    assert ctx.db is not None
    if payload.module_id is not None and payload.unassigned:
        raise ApiError(
            "validation_failed",
            "module_id 与 unassigned 不能同时指定（一个是某模块的子树、一个是未分组）",
            422,
        )
    # project_id 单谓词 = 判断 1 的列表侧；归档件不藏：MS 的计划列表是含归档的（归档件
    # 在执行编排里被跳过，但列得出来），藏起来会让「归档去哪了」变成失踪案。
    stmt = (
        select(PlanRecord)
        .where(PlanRecord.project_id == payload.project_id,
               PLAN_LIST_FILTER.parse(payload.filter))
        .order_by(PlanRecord.id)  # 绝对期望序 = id 升序（D47-b 判据 5 同尺，单键）
    )
    if payload.unassigned:
        stmt = stmt.where(PlanRecord.module_id.is_(None))
    elif payload.module_id is not None:
        # 点父节点看整棵子树（MS 左树行为）。目标模块须在本项目，否则 404——
        # 但过滤结果为空不返回 404（空列表是合法答案）。
        await _module(ctx.db, payload.project_id, payload.module_id)
        rows = (
            await ctx.db.execute(
                select(PlanModule).where(PlanModule.project_id == payload.project_id)
            )
        ).scalars().all()
        stmt = stmt.where(
            PlanRecord.module_id.in_(_module_subtree_ids(list(rows), payload.module_id))
        )
    # D285：标签精确筛选（FIND_IN_SET，不是 LIKE——「bug1」不被「bug」命中）；
    # 全空白 = 不过滤。与模块/关注/条件组并行 AND（不是模块过滤的 elif 分支）。
    if payload.tag and payload.tag.strip():
        stmt = stmt.where(func.find_in_set(payload.tag.strip(), PlanRecord.tags) > 0)
    if payload.followed_by_me:
        # D231：视图轴与缺陷 followed_by_me 同尺——project_id 一并带上，跨项目的关注行
        # 不会把别的项目的计划勾出来（关注行本身也带 project_id，这里再钉一次同项目）。
        stmt = stmt.where(
            PlanRecord.id.in_(
                select(PlanFollower.plan_id).where(
                    PlanFollower.user_id == ctx.user_id,
                    PlanFollower.project_id == payload.project_id,
                )
            )
        )
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    followed = await _followed_ids(ctx.db, [p.id for p in page.items], ctx.user_id)
    # D279：责任人姓名一次批量解析（本页 IN 查询，绝不逐行 join/查询）。
    names = await _user_names(ctx.db, {p.owner_id for p in page.items})
    return Page(
        items=[
            schemas.PlanListRowOut(
                **_out(p, names.get(p.owner_id) if p.owner_id else None).model_dump(),
                followed=p.id in followed,
            )
            for p in page.items
        ],
        next_cursor=None,
        total=page.total,
    )


@service(
    perm="testplan:plan:read",
    effect="read",
    name="plan_get",
    description="获取计划详情（跨项目与不存在同码同文案；含我的关注态与关注总数）",
    http={"method": "GET", "path": "/plans/{plan_id}", "tags": ["testplan"], "status": 200},
)
async def plan_get(payload: schemas.PlanGetIn, ctx) -> schemas.PlanDetailOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:read")
    assert ctx.db is not None
    p = await _plan(ctx.db, payload.project_id, payload.plan_id)
    # 两个数都现查 plan_follower（本函数是唯一读路）：详情页的「关注/取消关注」与
    # 「N 人关注」不存冗余列，列表也没有给过这两个数（PlanListRowOut 只有 followed）。
    followed = p.id in await _followed_ids(ctx.db, [p.id], ctx.user_id)
    return schemas.PlanDetailOut(
        **(await _out_named(ctx.db, p)).model_dump(), followed=followed,
        follower_count=await _follower_count(ctx.db, p.id),
    )


@service(
    perm="testplan:plan:update",
    effect="write",
    name="plan_follow",
    description="关注计划（幂等；写副作用走写位，不借用 read——MS 用 READ 位，我们不用）",
    http={"method": "POST", "path": "/plans/{plan_id}/follow", "tags": ["testplan"]},
)
async def plan_follow(payload: schemas.PlanFollowIn, ctx) -> schemas.PlanFollowOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:update")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    exists = (
        await ctx.db.execute(
            select(PlanFollower).where(
                PlanFollower.plan_id == payload.plan_id, PlanFollower.user_id == ctx.user_id
            )
        )
    ).scalar_one_or_none()
    if exists is None:
        ctx.db.add(
            PlanFollower(
                plan_id=payload.plan_id, user_id=ctx.user_id,
                project_id=payload.project_id, created_at=datetime.now(UTC),
            )
        )
        await ctx.db.commit()
    return schemas.PlanFollowOut(
        following=True, follower_count=await _follower_count(ctx.db, payload.plan_id)
    )


@service(
    perm="testplan:plan:update",
    effect="write",
    name="plan_unfollow",
    description="取消关注计划（幂等；未关注时也回 following=false）",
    http={"method": "POST", "path": "/plans/{plan_id}/unfollow", "tags": ["testplan"]},
)
async def plan_unfollow(payload: schemas.PlanFollowIn, ctx) -> schemas.PlanFollowOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:update")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    row = (
        await ctx.db.execute(
            select(PlanFollower).where(
                PlanFollower.plan_id == payload.plan_id, PlanFollower.user_id == ctx.user_id
            )
        )
    ).scalar_one_or_none()
    if row is not None:
        await ctx.db.delete(row)
        await ctx.db.commit()
    return schemas.PlanFollowOut(
        following=False, follower_count=await _follower_count(ctx.db, payload.plan_id)
    )


@service(
    perm="testplan:plan:update",
    effect="write",
    name="plan_update",
    description="修改计划名称/描述（**改不了归档**——归档走 /plans/{plan_id}/archive，:manage）",
    http={"method": "PATCH", "path": "/plans/{plan_id}", "tags": ["testplan"], "status": 200},
)
async def plan_update(payload: schemas.PlanUpdateIn, ctx) -> schemas.PlanOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:update")
    assert ctx.db is not None
    p = await _plan(ctx.db, payload.project_id, payload.plan_id)
    if payload.name is not None and payload.name != p.name:
        await _name_dup(ctx.db, payload.project_id, payload.name)
        p.name = payload.name
    if payload.description is not None:
        p.description = payload.description
    if payload.module_set:
        # 显式哨兵：module_id 给 None = 移出到未分组（否则「不传」与「传 null」分不开）。
        if payload.module_id is not None:
            await _module(ctx.db, payload.project_id, payload.module_id)
        p.module_id = payload.module_id
    # D279：五个可清空位同样用显式哨兵（带 null = 清空，不带 = 不动）。
    if payload.stage_set:
        p.stage = payload.stage
    if payload.planned_start_set:
        p.planned_start = _as_naive_utc(payload.planned_start)
    if payload.planned_end_set:
        p.planned_end = _as_naive_utc(payload.planned_end)
    if payload.actual_start_set:
        p.actual_start = _as_naive_utc(payload.actual_start)
    if payload.actual_end_set:
        p.actual_end = _as_naive_utc(payload.actual_end)
    if payload.owner_set:
        if payload.owner_id is not None:
            await _check_owner(ctx.db, payload.project_id, payload.owner_id)
        p.owner_id = payload.owner_id
    # D285：标签三态（None = 不改、[] = 清空）
    if payload.tags is not None:
        p.tags = join_tags(payload.tags)
    # 先后校验用**合并后的现值**：只改一端时也要和另一端比（改完才校验才不会漏）。
    _check_span(p.planned_start, p.planned_end, "计划")
    _check_span(p.actual_start, p.actual_end, "实际")
    # 每一次普通更新也落 updated_by：列语义是「最后谁动的」，归档那次同样动它（判断 2）。
    p.updated_by = ctx.user_id
    await ctx.db.commit()
    return await _out_named(ctx.db, p)


async def _purge_plan(db, p: PlanRecord) -> None:
    """删计划的一条事务内的全部刀（plan_delete 与 plan_batch_delete 共用的唯一实现）。

    全仓零外键，级联只能在应用层做。谓词**只有 plan_id**——按 (id, project_id) 取到计划
    已经证明了项目归属，关联行/报告与计划同 project_id 是写入方的不变式，多带一个
    project_id 谓词只会把「不变式哪天被写歪」伪装成「孤儿行合法地留在了库里」。
    报告明细**不按 plan_id 删**——它按 report_id 级联，先按「本计划的报告 id」删净明细，
    再删报告头（否则孤儿明细）；功能用例结论两张表按 plan_id 删净。
    **不 commit**：调用方决定事务边界（批量删要一次 commit 落所有刀）。
    """
    report_ids = select(PlanReport.id).where(PlanReport.plan_id == p.id)
    await db.execute(sa_delete(PlanReportItem).where(PlanReportItem.report_id.in_(report_ids)))
    await db.execute(sa_delete(PlanReport).where(PlanReport.plan_id == p.id))
    # D204：功能用例结论两张表同样按 plan_id 删净（都在同一次 commit 里）。
    await db.execute(
        sa_delete(PlanFunctionalExecHistory).where(PlanFunctionalExecHistory.plan_id == p.id)
    )
    await db.execute(sa_delete(PlanFunctionalExec).where(PlanFunctionalExec.plan_id == p.id))
    # D231：关注行按 plan_id 删净——计划没了，关注关系没有指向（同事务、同一条 commit）。
    await db.execute(sa_delete(PlanFollower).where(PlanFollower.plan_id == p.id))
    await db.execute(sa_delete(PlanCaseLink).where(PlanCaseLink.plan_id == p.id))
    await db.delete(p)


@service(
    perm="testplan:plan:delete",
    effect="destructive",
    name="plan_delete",
    description="删除计划（物理删，无回收站，不可逆；同事务级联删该计划的关联行）",
    http={"method": "DELETE", "path": "/plans/{plan_id}", "tags": ["testplan"], "status": 200},
)
async def plan_delete(payload: schemas.PlanDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:delete")
    assert ctx.db is not None
    p = await _plan(ctx.db, payload.project_id, payload.plan_id)
    # 已归档也允许删：归档封的是「继续用它」（步 2/3 的执行与批量跳过归档件），
    # 不是「不能清理」。反过来说没有「先反归档才能删」这种话——根本没有反归档。
    # 级联刀见 _purge_plan（步 2/4/204 的债都收在那一处），一次 commit 同事务落所有刀，
    # 任何一步抛错都会把它们一起回滚（不会留下「计划没了、关联/报告还在」的半截现场）。
    await _purge_plan(ctx.db, p)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="testplan:plan:delete",
    effect="destructive",
    name="plan_batch_delete",
    description="批量删除计划（物理删；任一计划不在本项目 → 404 整批不动；同事务级联）",
    http={"method": "POST", "path": "/plans/batch-delete", "tags": ["testplan"], "status": 200},
)
async def plan_batch_delete(payload: schemas.PlanBatchDeleteIn, ctx) -> OkOut:
    """MS `/delete/batch` 的等价面：全有或全无（与 plan_link_batch_delete 同纪律）。

    - 重复 id → 422（同一计划删两次没有第二种语义，说明调用方拼错了列表）。
    - 任一 id 不在本项目 → 404 + 列出缺的 ids，**整批一行都不删**——「删一半再报错」
      是最坏的一种成功：调用方以为失败、数据已经少了一块。
    - 权限位沿用 `testplan:plan:delete`：MS 有独立的 BATCH_DELETE 位，本仓不为此新造位
      （原子位原则；单删与批删是同一个破坏性动作的两种传参形状）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:delete")
    assert ctx.db is not None
    uniq = list(dict.fromkeys(payload.plan_ids))
    if len(uniq) != len(payload.plan_ids):
        raise ApiError("validation_failed", "plan_ids 不能重复", 422,
                       {"plan_ids": payload.plan_ids})
    rows = (
        await ctx.db.execute(
            select(PlanRecord)
            .where(PlanRecord.project_id == payload.project_id, PlanRecord.id.in_(uniq))
            .order_by(PlanRecord.id)
        )
    ).scalars().all()
    found = {p.id for p in rows}
    missing = [i for i in uniq if i not in found]
    if missing:
        raise ApiError("not_found", "计划不存在", 404, {"plan_ids": missing})
    for p in rows:
        await _purge_plan(ctx.db, p)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="testplan:plan:manage",
    effect="write",
    name="plan_archive",
    description="归档计划（终态、单向门：MEMBER 被 -*:manage 拒绝，只剩项目管理员及以上；没有反归档端点）",
    http={"method": "POST", "path": "/plans/{plan_id}/archive", "tags": ["testplan"], "status": 200},
)
async def plan_archive(payload: schemas.PlanArchiveIn, ctx) -> schemas.PlanOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:manage")
    assert ctx.db is not None
    p = await _plan(ctx.db, payload.project_id, payload.plan_id)
    if p.archived:
        # 对已归档的计划再归档一次不是幂等假成功，是把「门已经关上」说出去：
        # 重复归档请求大概率来自没看到终态提示的调用方，409 比 ok=true 更不容易骗人。
        raise ApiError("already_archived", "计划已归档（归档是终态，无反归档路径）", 409, {"plan_id": p.id})
    p.archived = True
    p.updated_by = ctx.user_id
    await ctx.db.commit()
    return await _out_named(ctx.db, p)


def _copy_name(source_name: str) -> str:
    """复制件的默认名：抄 MS 的 `<源名>_<5 位>_COPY` 形状（plan 上限 200，先保后缀）。

    随机后缀不是装饰：同项目重名 409（uq_plan_record_project_name），没有后缀时
    「复制两次」第二次必然撞名。MS 同款（TestPlanService.copy:1191-1194）。
    """
    suffix = f"_{new_id()[:5]}_COPY"
    return source_name[: 200 - len(suffix)] + suffix


@service(
    perm="testplan:plan:create",
    effect="write",
    name="plan_copy",
    description="复制计划（头 + 全部用例关联；不复制执行结论与已生成报告，复制件未归档）",
    http={"method": "POST", "path": "/plans/{plan_id}/copy", "tags": ["testplan"], "status": 201},
)
async def plan_copy(payload: schemas.PlanCopyIn, ctx) -> schemas.PlanOut:
    """D208：复制计划 = 新计划头 + 源计划的全部 plan_case_link，一条事务。

    抄什么（MS TestPlanService.copy 取证：copyPlanPrincipal + copyPlanCase）：
    - 计划头：description 抄；archived **不抄**（MS 把 status 复位 Prepare——复制件是
      可用的新计划）；module_id 随源抄（复制件留在源计划所在模块，不掉进未分组）；
      D279 的 stage/计划与实际起止/责任人同样随源抄（复制的是「同一套计划安排」，
      新计划就该继承同一责任人；执行结论才是不能抄的部分）；
      created_by/updated_by = 复制人。
    - 关联行：subject_type/subject_id/subject_name/env_id/executor_id/sort_order 逐列抄，
      created_by = 复制人（MS 的 createUser 同为当前用户）；新行 id、新 plan_id，
      uq(plan_id, subject_type, subject_id) 因 plan_id 变了不会撞。
    - **不抄**执行结论（plan_functional_exec/history）与已生成报告：MS 复制时把功能用例
      行重置为 Prepare，等价于「用例挂进去了、还没跑」；把上一轮的通过率搬进新计划 =
      新计划出生即谎称已执行。
    - 不抄运行配置/执行人分配表：本仓没有 plan 级运行配置，指派执行人已在关联行上随行抄。

    落库形状与 plan_delete 的级联反着来：那边按 plan_id 删干净，这边按 plan_id 抄一份；
    **一次 commit**，复制件与关联行要么都在、要么都不在。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:create")
    assert ctx.db is not None
    src = await _plan(ctx.db, payload.project_id, payload.plan_id)
    name = payload.name if payload.name is not None else _copy_name(src.name)
    await _name_dup(ctx.db, payload.project_id, name)
    target = PlanRecord(
        project_id=src.project_id,
        name=name,
        description=src.description,
        archived=False,
        # 模块归属随源抄：复制件出现在源计划所在的模块里，而不是凭空掉进「未分组」。
        module_id=src.module_id,
        stage=src.stage,
        planned_start=src.planned_start,
        planned_end=src.planned_end,
        actual_start=src.actual_start,
        actual_end=src.actual_end,
        owner_id=src.owner_id,
        # D285：标签随源抄（复制的是同一套计划安排）
        tags=src.tags,
        created_by=ctx.user_id,
        updated_by=ctx.user_id,
    )
    ctx.db.add(target)
    # flush 只为拿 target.id（id 是 Python 侧 default，不 flush 还是 None）；不 commit。
    await ctx.db.flush()
    links = (
        await ctx.db.execute(
            select(PlanCaseLink)
            .where(PlanCaseLink.plan_id == src.id)
            .order_by(PlanCaseLink.id),  # 复制顺序不影响语义，定序只为可复现
        )
    ).scalars().all()
    for lk in links:
        ctx.db.add(
            PlanCaseLink(
                project_id=src.project_id,
                plan_id=target.id,
                subject_type=lk.subject_type,
                subject_id=lk.subject_id,
                subject_name=lk.subject_name,
                env_id=lk.env_id,
                executor_id=lk.executor_id,
                sort_order=lk.sort_order,
                created_by=ctx.user_id,
            )
        )
    await ctx.db.commit()
    return await _out_named(ctx.db, target)


# ══════════════════ 步 2：plan_case_link 关联 CRUD ══════════════════


def _link_out(lk: PlanCaseLink) -> schemas.PlanLinkOut:
    return schemas.PlanLinkOut(
        id=lk.id,
        project_id=lk.project_id,
        plan_id=lk.plan_id,
        subject_type=lk.subject_type,
        subject_id=lk.subject_id,
        subject_name=lk.subject_name,
        env_id=lk.env_id,
        executor_id=lk.executor_id,
        sort_order=lk.sort_order,
        created_by=lk.created_by,
        created_at=schemas.iso(lk.created_at),
        updated_at=schemas.iso(lk.updated_at),
    )


async def _env(db, project_id: str, env_id: str) -> None:
    """环境归属校验（D181 形状，scenario/services.py:_env 逐字同款码文）。

    按 (id, project_id) 双条件取行，查不到（不存在、或在别的项目）都是同一句
    404「环境不存在」——跨项目 env 与不存在同码同文案，不泄露存在性。病因同款：
    不在写入口拦，到点运行才在执行链路炸。
    """
    hit = (
        await db.execute(
            select(ENVIRONMENT.c.id).where(ENVIRONMENT.c.id == env_id, ENVIRONMENT.c.project_id == project_id)
        )
    ).first()
    if hit is None:
        raise ApiError("not_found", "环境不存在", 404, {"env_id": env_id})


async def _subject(db, project_id: str, subject_type: str, subject_id: str) -> tuple[str, str | None]:
    """按 (id, project_id) 取 subject，返回 (name, env_id)。词表内四域各查各的反射表。

    三种拒绝都开口说话（判断 1 的反面：不许默默收下）：
    - subject_type 不在四值词表 → 422 validation_failed（inline/api_definition 等）；
    - id 不存在或在别的项目 → 404，跨项目与不存在同码同文案（_plan/_env 同款纪律）；
    - 在回收站（status != normal）→ 404「（在回收站）」：回收站的行不是可执行对象，
      挂进来就是一条 run_record 永远配不上的关联——与各域 debug/run 路径对回收站
      行说「不存在（在回收站，请先恢复）」的同手感，不另造码。
    读 env_id 只发生在 scenario/ui_case 两份反射上（api/adb 没有这列，见 SUBJECT_TABLES 注释）。
    """
    if subject_type not in schemas.PLAN_LINK_SUBJECT_TYPES:
        raise ApiError(
            "validation_failed",
            "subject_type 只支持 "
            + "/".join(schemas.PLAN_LINK_SUBJECT_TYPES)
            + "（inline 的 subject_id 是常量、api_definition 不是用例层对象）",
            422,
            {"subject_type": subject_type},
        )
    t = SUBJECT_TABLES[subject_type]
    has_env = "env_id" in t.c
    cols = [t.c.id, t.c.name, t.c.status] + ([t.c.env_id] if has_env else [])
    row = (
        await db.execute(select(*cols).where(t.c.id == subject_id, t.c.project_id == project_id).limit(1))
    ).first()
    if row is None:
        raise ApiError("not_found", SUBJECT_LABELS[subject_type] + "不存在", 404, {"subject_id": subject_id})
    if row[2] != "normal":
        raise ApiError(
            "not_found", SUBJECT_LABELS[subject_type] + "不存在（在回收站）", 404, {"subject_id": subject_id}
        )
    return str(row[1]), (str(row[3]) if has_env and row[3] is not None else None)


async def _link(db, project_id: str, plan_id: str, link_id: str) -> PlanCaseLink:
    """取关联行：(id, project_id, plan_id) 三条件，任何一种错位都是同一句 404。

    挂别的计划的 link_id 与不存在的 link_id 逐字同文——与 _plan 同纪律，
    嵌套路径 /plans/{plan_id}/case-links/{link_id} 不泄露「这条 link 存在于别的计划」。
    """
    lk = (
        await db.execute(
            select(PlanCaseLink).where(
                PlanCaseLink.id == link_id,
                PlanCaseLink.project_id == project_id,
                PlanCaseLink.plan_id == plan_id,
            )
        )
    ).scalar_one_or_none()
    if lk is None:
        raise ApiError("not_found", "关联不存在", 404, {"link_id": link_id})
    return lk


@service(
    perm="testplan:link:create",
    effect="write",
    name="plan_link_create",
    description="把可执行用例挂进计划（四种 subject；同计划重复挂 409；env 能抄就抄、传了先验归属）",
    http={"method": "POST", "path": "/plans/{plan_id}/case-links", "tags": ["testplan"], "status": 201},
)
async def plan_link_create(payload: schemas.PlanLinkCreateIn, ctx) -> schemas.PlanLinkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:create")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)  # 计划不存在/跨项目 → 404
    name, subject_env = await _subject(ctx.db, payload.project_id, payload.subject_type, payload.subject_id)
    env_id: str | None
    if payload.env_id is not None:
        await _env(ctx.db, payload.project_id, payload.env_id)
        env_id = payload.env_id
    else:
        # 能抄就抄（§二 3：执行读关联行这一份）：scenario/ui_case 的 env_id 有值则抄，
        # api_case/adb_case 与「没值」都留空——空 = 执行时沿用该 subject 自己的默认口径。
        env_id = subject_env
    dup = (
        await ctx.db.execute(
            select(PlanCaseLink.id)
            .where(
                PlanCaseLink.plan_id == payload.plan_id,
                PlanCaseLink.subject_type == payload.subject_type,
                PlanCaseLink.subject_id == payload.subject_id,
            )
            .limit(1)
        )
    ).first()
    if dup is not None:
        # 预检与 uq_plan_case_link_plan_subject 同尺：409 说清撞的是哪条（IntegrityError
        # 兜底同样是 409 但只剩「数据唯一性冲突」，说不清撞了什么——plan_create 同款裁决）。
        raise ApiError(
            "conflict",
            "该对象已在此计划中",
            409,
            {
                "plan_id": payload.plan_id,
                "subject_type": payload.subject_type,
                "subject_id": payload.subject_id,
            },
        )
    lk = PlanCaseLink(
        project_id=payload.project_id,
        plan_id=payload.plan_id,
        subject_type=payload.subject_type,
        subject_id=payload.subject_id,
        subject_name=name,
        env_id=env_id,
        created_by=ctx.user_id,
    )
    ctx.db.add(lk)
    await ctx.db.commit()
    return _link_out(lk)


@service(
    perm="testplan:link:read",
    effect="read",
    name="plan_link_list",
    description="列出计划的关联行（页码分页；执行结论不在这里——join run_record 现算归步 3）",
    http={"method": "GET", "path": "/plans/{plan_id}/case-links", "tags": ["testplan"], "status": 200},
)
async def plan_link_list(payload: schemas.PlanLinkListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:read")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)  # 计划不存在/跨项目 → 404（列表不泄它有无关联）
    stmt = (
        select(PlanCaseLink)
        .where(PlanCaseLink.plan_id == payload.plan_id, PlanCaseLink.project_id == payload.project_id)
        .order_by(PlanCaseLink.sort_order, PlanCaseLink.id)  # D206：手工序优先，同值按 id 兜底
    )
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    return Page(items=[_link_out(lk) for lk in page.items], next_cursor=None, total=page.total)


@service(
    perm="testplan:link:update",
    effect="write",
    name="plan_link_update",
    description="改关联行的执行环境（**只改 env**：换 subject 是删了重挂；clear_env 显式清空）",
    http={
        "method": "PATCH",
        "path": "/plans/{plan_id}/case-links/{link_id}",
        "tags": ["testplan"],
        "status": 200,
    },
)
async def plan_link_update(payload: schemas.PlanLinkUpdateIn, ctx) -> schemas.PlanLinkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:update")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    lk = await _link(ctx.db, payload.project_id, payload.plan_id, payload.link_id)
    if payload.env_id is not None and payload.clear_env:
        # 「换成 A」与「清空」同时说 = 说不清的一句话，422 让调用方自己选（不猜）。
        raise ApiError(
            "validation_failed", "env_id 与 clear_env 不能同时给", 422, {"link_id": payload.link_id}
        )
    if payload.clear_env:
        lk.env_id = None
    elif payload.env_id is not None:
        await _env(ctx.db, payload.project_id, payload.env_id)
        lk.env_id = payload.env_id
    # 两者都没给：原样回执（幂等读回，不报错——PATCH 的「空补丁」不是攻击）。
    # 行上没有 updated_by 列：关联行的「谁挂的」是 created_by，改环境落审计（action=
    # plan_link_update），不新建一列「最后谁动的」——本刀没有任何写入路径能证明它有第二个
    # 读者（判据 1：plan_link_list 读的是 created_by，这一列步 3/6 的展示面也没有点它的名）。
    await ctx.db.commit()
    return _link_out(lk)


@service(
    perm="testplan:link:delete",
    effect="destructive",
    name="plan_link_delete",
    description="把用例从计划里摘除（只删关联行，对象本身毫发无损——摘挂不是删用例）",
    http={
        "method": "DELETE",
        "path": "/plans/{plan_id}/case-links/{link_id}",
        "tags": ["testplan"],
        "status": 200,
    },
)
async def plan_link_delete(payload: schemas.PlanLinkDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:delete")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    lk = await _link(ctx.db, payload.project_id, payload.plan_id, payload.link_id)
    # D204：摘挂带走该关联的人工执行结论与流水（关联没了，结论没有挂靠对象）。
    await ctx.db.execute(
        sa_delete(PlanFunctionalExecHistory).where(PlanFunctionalExecHistory.link_id == lk.id)
    )
    await ctx.db.execute(sa_delete(PlanFunctionalExec).where(PlanFunctionalExec.link_id == lk.id))
    await ctx.db.delete(lk)
    await ctx.db.commit()
    return OkOut(ok=True)


# ══════════════════ D206：执行人指派 / 拖拽排序 / 批量取消关联 ══════════════════


async def _links_in_plan(db, project_id: str, plan_id: str, link_ids: list[str]) -> list[PlanCaseLink]:
    """批量取本计划的关联行；去重但保序。

    - 重复 id：422 说清（同一行被排两个位置 = 说不清哪个才是新顺序）。
    - 任一 id 不在本计划/本项目的：404 + 列出缺的 ids，**整批不动**（全有或全无）。
    """
    uniq = list(dict.fromkeys(link_ids))
    if len(uniq) != len(link_ids):
        raise ApiError("validation_failed", "link_ids 不能重复", 422, {"link_ids": link_ids})
    rows = (
        await db.execute(
            select(PlanCaseLink).where(
                PlanCaseLink.project_id == project_id,
                PlanCaseLink.plan_id == plan_id,
                PlanCaseLink.id.in_(uniq),
            )
        )
    ).scalars().all()
    found = {r.id for r in rows}
    missing = [i for i in uniq if i not in found]
    if missing:
        raise ApiError("not_found", "关联不存在", 404, {"link_ids": missing})
    by_id = {r.id: r for r in rows}
    return [by_id[i] for i in uniq]


async def _check_member(db, project_id: str, user_id: str, *,
                        code: str, label: str, field: str) -> None:
    """用户必须是本项目成员：指派给项目外的人 = 一条永远没人认领的假指派。"""
    hit = (
        await db.execute(
            select(PROJECT_MEMBER.c.id).where(
                PROJECT_MEMBER.c.project_id == project_id, PROJECT_MEMBER.c.user_id == user_id
            ).limit(1)
        )
    ).first()
    if hit is None:
        raise ApiError(code, label + "不是本项目成员", 422, {field: user_id})


async def _check_executor(db, project_id: str, executor_id: str) -> None:
    await _check_member(db, project_id, executor_id,
                        code="invalid_executor", label="执行人", field="executor_id")


async def _check_owner(db, project_id: str, owner_id: str) -> None:
    await _check_member(db, project_id, owner_id,
                        code="invalid_owner", label="责任人", field="owner_id")


@service(
    perm="testplan:link:update",
    effect="write",
    name="plan_link_assign",
    description="批量指派执行人（executor_id=None = 取消指派；执行人必须是本项目成员）",
    http={"method": "POST", "path": "/plans/{plan_id}/case-links/assign", "tags": ["testplan"],
          "status": 200},
)
async def plan_link_assign(payload: schemas.PlanLinkAssignIn, ctx) -> schemas.PlanLinkAssignOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:update")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    rows = await _links_in_plan(ctx.db, payload.project_id, payload.plan_id, payload.link_ids)
    if payload.executor_id is not None:
        await _check_executor(ctx.db, payload.project_id, payload.executor_id)
    for r in rows:
        r.executor_id = payload.executor_id
    await ctx.db.commit()
    return schemas.PlanLinkAssignOut(updated=len(rows))


@service(
    perm="testplan:link:update",
    effect="write",
    name="plan_link_sort",
    description="拖拽排序（link_ids 必须覆盖计划内全部关联，先后即新顺序）",
    http={"method": "POST", "path": "/plans/{plan_id}/case-links/sort", "tags": ["testplan"],
          "status": 200},
)
async def plan_link_sort(payload: schemas.PlanLinkSortIn, ctx) -> schemas.PlanLinkSortOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:update")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    rows = await _links_in_plan(ctx.db, payload.project_id, payload.plan_id, payload.link_ids)
    total = (
        await ctx.db.execute(
            select(func.count()).select_from(PlanCaseLink).where(
                PlanCaseLink.project_id == payload.project_id,
                PlanCaseLink.plan_id == payload.plan_id,
            )
        )
    ).scalar_one()
    if int(total) != len(rows):
        # 子集排序会让「未列出的行」与「第 1 名」抢同一个 sort_order，产生不确定序——
        # 不猜，要求整批。前端拖拽本来拿的就是当前页/整组的完整 id 列表。
        raise ApiError(
            "incomplete_sort",
            "排序必须覆盖计划内全部关联",
            422,
            {"expected": int(total), "given": len(rows)},
        )
    # 从 1 起：0 是「从未排过」的默认值，让排过的行整体前移，语义上说得清。
    for idx, r in enumerate(rows, start=1):
        r.sort_order = idx
    await ctx.db.commit()
    return schemas.PlanLinkSortOut(updated=len(rows))


@service(
    perm="testplan:link:delete",
    effect="destructive",
    name="plan_link_batch_delete",
    description="批量取消关联（只删关联行与该行的人工结论，用例本体不动；全有或全无）",
    http={"method": "POST", "path": "/plans/{plan_id}/case-links/batch-delete",
          "tags": ["testplan"], "status": 200},
)
async def plan_link_batch_delete(
    payload: schemas.PlanLinkBatchDeleteIn, ctx
) -> schemas.PlanLinkBatchDeleteOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:delete")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    rows = await _links_in_plan(ctx.db, payload.project_id, payload.plan_id, payload.link_ids)
    ids = [r.id for r in rows]
    await ctx.db.execute(
        sa_delete(PlanFunctionalExecHistory).where(PlanFunctionalExecHistory.link_id.in_(ids))
    )
    await ctx.db.execute(sa_delete(PlanFunctionalExec).where(PlanFunctionalExec.link_id.in_(ids)))
    for r in rows:
        await ctx.db.delete(r)
    await ctx.db.commit()
    return schemas.PlanLinkBatchDeleteOut(updated=len(ids))


# ══════════════════ D204：计划内功能用例（人工执行） ══════════════════


def _functional_out(
    lk: PlanCaseLink, case_row, ex: PlanFunctionalExec | None
) -> schemas.PlanFunctionalCaseOut:
    """关联行 + 功能用例本体 + 当前结论 → 列表行。

    `case_row` 可能为 None（用例已被物理删）：name 退回关联行的快照名，num/priority
    退回空值——列表不因为用例没了就报错（快照名的存在意义，D183 同口径）。
    """
    return schemas.PlanFunctionalCaseOut(
        link_id=lk.id,
        case_id=lk.subject_id,
        num=int(case_row[0]) if case_row is not None else 0,
        name=str(case_row[1]) if case_row is not None else lk.subject_name,
        priority=str(case_row[2]) if case_row is not None else "P2",
        module_id=(str(case_row[3]) if case_row is not None and case_row[3] is not None else None),
        result=(ex.result if ex is not None else "none"),
        comment=(ex.comment if ex is not None else None),
        executed=ex is not None,
        executed_by=(ex.executed_by if ex is not None else None),
        executed_at=(schemas.iso(ex.executed_at) if ex is not None else None),
        executor_id=lk.executor_id,
        sort_order=lk.sort_order,
    )


async def _functional_case_rows(db, project_id: str, case_ids: list[str]) -> dict[str, tuple]:
    if not case_ids:
        return {}
    rows = (
        await db.execute(
            select(
                FUNCTIONAL_CASE.c.id,
                FUNCTIONAL_CASE.c.name,
                FUNCTIONAL_CASE.c.num,
                FUNCTIONAL_CASE.c.priority,
                FUNCTIONAL_CASE.c.module_id,
                FUNCTIONAL_CASE.c.description,
            ).where(FUNCTIONAL_CASE.c.project_id == project_id, FUNCTIONAL_CASE.c.id.in_(case_ids))
        )
    ).all()
    return {str(r[0]): (r[2], r[1], r[3], r[4], r[5]) for r in rows}


async def _functional_exec_map(db, link_ids: list[str]) -> dict[str, PlanFunctionalExec]:
    if not link_ids:
        return {}
    rows = (
        (await db.execute(select(PlanFunctionalExec).where(PlanFunctionalExec.link_id.in_(link_ids))))
        .scalars()
        .all()
    )
    return {e.link_id: e for e in rows}


@service(
    perm="testplan:link:read",
    effect="read",
    name="plan_functional_case_list",
    description="计划内功能用例列表（关联 + 用例快照 + 当前人工结论；可按模块/关键字/结论筛选）",
    http={"method": "GET", "path": "/plans/{plan_id}/functional-cases", "tags": ["testplan"], "status": 200},
)
async def plan_functional_case_list(payload: schemas.PlanFunctionalListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:read")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    if payload.result is not None and payload.result not in ("none", *PLAN_FUNCTIONAL_RESULTS):
        raise ApiError(
            "validation_failed",
            "result 只支持 none/" + "/".join(PLAN_FUNCTIONAL_RESULTS),
            422,
            {"result": payload.result},
        )
    stmt = (
        select(PlanCaseLink)
        .where(
            PlanCaseLink.plan_id == payload.plan_id,
            PlanCaseLink.project_id == payload.project_id,
            PlanCaseLink.subject_type == "functional_case",
        )
        .order_by(PlanCaseLink.sort_order, PlanCaseLink.id)
    )
    # 筛选下推 SQL（不在投影后过滤）：页码的 total 必须按同一谓词算，
    # 「投影后 continue」会让 total 数的是未筛全集，页脚直接说谎。
    if payload.keyword or payload.module_id is not None:
        stmt = stmt.join(FUNCTIONAL_CASE, FUNCTIONAL_CASE.c.id == PlanCaseLink.subject_id)
        if payload.keyword:
            stmt = stmt.where(FUNCTIONAL_CASE.c.name.like(f"%{payload.keyword}%"))
        if payload.module_id is not None:
            stmt = stmt.where(FUNCTIONAL_CASE.c.module_id == payload.module_id)
    if payload.result is not None:
        stmt = stmt.outerjoin(PlanFunctionalExec, PlanFunctionalExec.link_id == PlanCaseLink.id)
        if payload.result == "none":
            stmt = stmt.where(PlanFunctionalExec.id.is_(None))
        else:
            stmt = stmt.where(PlanFunctionalExec.result == payload.result)
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    links = list(page.items)
    cases = await _functional_case_rows(ctx.db, payload.project_id, [lk.subject_id for lk in links])
    execs = await _functional_exec_map(ctx.db, [lk.id for lk in links])
    items = [_functional_out(lk, cases.get(lk.subject_id), execs.get(lk.id)) for lk in links]
    return Page(items=items, next_cursor=None, total=page.total)


@service(
    perm="testplan:link:read",
    effect="read",
    name="plan_functional_case_detail",
    description="计划内功能用例详情（用例描述 + 自定义字段 + 当前人工结论）",
    http={
        "method": "GET",
        "path": "/plans/{plan_id}/functional-cases/{link_id}",
        "tags": ["testplan"],
        "status": 200,
    },
)
async def plan_functional_case_detail(
    payload: schemas.PlanFunctionalHistoryIn, ctx
) -> schemas.PlanFunctionalDetailOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:read")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    lk = await _link(ctx.db, payload.project_id, payload.plan_id, payload.link_id)
    if lk.subject_type != "functional_case":
        raise ApiError("not_found", "关联不存在", 404, {"link_id": payload.link_id})
    cases = await _functional_case_rows(ctx.db, payload.project_id, [lk.subject_id])
    row = cases.get(lk.subject_id)
    ex = (await _functional_exec_map(ctx.db, [lk.id])).get(lk.id)
    base = _functional_out(lk, row, ex)
    fields = (
        await ctx.db.execute(
            select(FUNCTIONAL_CASE_FIELD.c.field_id, FUNCTIONAL_CASE_FIELD.c.value).where(
                FUNCTIONAL_CASE_FIELD.c.project_id == payload.project_id,
                FUNCTIONAL_CASE_FIELD.c.case_id == lk.subject_id,
            )
        )
    ).all()
    return schemas.PlanFunctionalDetailOut(
        **base.model_dump(),
        description=(str(row[4]) if row is not None and row[4] is not None else None),
        custom_fields={str(fid): str(val) for fid, val in fields},
    )


@service(
    perm="testplan:functional:execute",
    effect="write",
    name="plan_functional_case_execute",
    description="给计划内功能用例写人工执行结论（批量；覆盖当前结论并追加一条历史；归档计划拒绝）",
    http={
        "method": "POST",
        "path": "/plans/{plan_id}/functional-cases/execute",
        "tags": ["testplan"],
        "status": 200,
    },
)
async def plan_functional_case_execute(payload: schemas.PlanFunctionalExecuteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:functional:execute")
    assert ctx.db is not None
    p = await _plan(ctx.db, payload.project_id, payload.plan_id)
    if p.archived:
        raise ApiError("already_archived", "计划已归档，不能再记录执行结论", 409, {"plan_id": p.id})
    if payload.result not in PLAN_FUNCTIONAL_RESULTS:
        raise ApiError(
            "validation_failed",
            "result 只支持 " + "/".join(PLAN_FUNCTIONAL_RESULTS),
            422,
            {"result": payload.result},
        )
    # 去重但保序：同一批里重复传同一个 link 不是两个关联，只写一条当前结论/一条历史。
    link_ids = list(dict.fromkeys(payload.link_ids))
    links = (
        (
            await ctx.db.execute(
                select(PlanCaseLink).where(
                    PlanCaseLink.plan_id == p.id,
                    PlanCaseLink.project_id == payload.project_id,
                    PlanCaseLink.id.in_(link_ids),
                )
            )
        )
        .scalars()
        .all()
    )
    found = {lk.id for lk in links}
    # 任一 link 不属于本计划 = 整批 404（不写半批，也不泄露别计划的 link 存在性）。
    missing = [lid for lid in link_ids if lid not in found]
    if missing:
        raise ApiError("not_found", "关联不存在", 404, {"link_ids": missing})
    bad_type = [lk.id for lk in links if lk.subject_type != "functional_case"]
    if bad_type:
        raise ApiError("validation_failed", "该关联不是功能用例，不能写人工结论", 422, {"link_ids": bad_type})
    existing = await _functional_exec_map(ctx.db, list(found))
    # seq 按 link 各自续号（不依赖秒级 created_at 排序）。
    seq_rows = (
        await ctx.db.execute(
            select(PlanFunctionalExecHistory.link_id, func.max(PlanFunctionalExecHistory.seq))
            .where(PlanFunctionalExecHistory.link_id.in_(list(found)))
            .group_by(PlanFunctionalExecHistory.link_id)
        )
    ).all()
    seq_map = {str(lid): int(mx) for lid, mx in seq_rows}
    now = datetime.now(UTC)
    for lk in links:
        ex = existing.get(lk.id)
        if ex is None:
            ex = PlanFunctionalExec(
                project_id=payload.project_id,
                plan_id=p.id,
                link_id=lk.id,
                case_id=lk.subject_id,
                executed_at=now,
            )
            ctx.db.add(ex)
        ex.result = payload.result
        ex.comment = payload.comment
        ex.executed_by = ctx.user_id
        ex.executed_at = now
        ctx.db.add(
            PlanFunctionalExecHistory(
                project_id=payload.project_id,
                plan_id=p.id,
                link_id=lk.id,
                case_id=lk.subject_id,
                seq=seq_map.get(lk.id, 0) + 1,
                result=payload.result,
                comment=payload.comment,
                executed_by=ctx.user_id,
            )
        )
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="testplan:link:read",
    effect="read",
    name="plan_functional_case_history",
    description="计划内功能用例结论变更历史（append-only，执行序号倒序）",
    http={
        "method": "GET",
        "path": "/plans/{plan_id}/functional-cases/{link_id}/history",
        "tags": ["testplan"],
        "status": 200,
    },
)
async def plan_functional_case_history(payload: schemas.PlanFunctionalHistoryIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:read")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    lk = await _link(ctx.db, payload.project_id, payload.plan_id, payload.link_id)
    stmt = (
        select(PlanFunctionalExecHistory)
        .where(
            PlanFunctionalExecHistory.link_id == lk.id,
            PlanFunctionalExecHistory.project_id == payload.project_id,
        )
        # seq 按 link 续号且唯一 → 单键就够定序；created_at 只做同秒兜底（MySQL DATETIME
        # 秒级精度，同秒两次改判靠时间戳分不出先后，D204 已经踩过）。
        .order_by(PlanFunctionalExecHistory.seq.desc(), PlanFunctionalExecHistory.created_at.desc())
    )
    # D218：页码分页。total 必须与 items 吃同一份 where（同一 stmt 交 paginate_page），
    # 不能另起一条不带 link/project 的 count——那会把别的计划的历史算进页脚。
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    return Page(
        items=[
            schemas.PlanFunctionalHistoryOut(
                id=h.id,
                seq=h.seq,
                result=h.result,
                comment=h.comment,
                executed_by=h.executed_by,
                created_at=schemas.iso(h.created_at),
            )
            for h in page.items
        ],
        next_cursor=None,
        total=page.total,
    )


# ══════════════════ 步 3：实时状态现算（只读，零落库） ══════════════════

# run_record.status 的三值终态词表与两个非终态（步 3 判断 3）。为什么不写成
# `status != 'queued'` 之类的否定式：execution/models.py:26 那句注释（「passed/failed/error」）
# 漏掉了出生即 queued 与 worker 领取置 running 两个非终态——否定式一旦照它写，
# 「非 passed 即失败」会把排队中的 run 判成失败（§四 ⚠ 点名的那条错法）。
TERMINAL_STATUSES = ("passed", "failed", "error")
FAILING_STATUSES = ("failed", "error")
INFLIGHT_STATUSES = ("queued", "running")
# 词表完整性钉：三组词拼起来必须恰好覆盖 run_record.status 的五个实测取值——
# 哪天 execution 加第六个值，这条 import 期断言先炸，而不是「什么都不算」地静默漂移
# （未知值保守到不计已执行也不计执行中，这是刻意的；但要让人先看见它）。
assert set(TERMINAL_STATUSES) | set(INFLIGHT_STATUSES) == {
    "passed",
    "failed",
    "error",
    "queued",
    "running",
}, "run_record.status 词表漂移：先现查 execution 的写入点再改这里"


async def _link_results(
    db, links: list[PlanCaseLink], project_id: str
) -> dict[tuple[str, str], tuple[int, int, int]]:
    """对关联行按 (subject_type, subject_id) 去重后向 run_record 问三件**与顺序无关**的事。

    返回 {(subject_type, subject_id): (终态条数, 失败终态条数, 非终态条数)}——只回答
    「有没有过」的量，不回答「最近是哪条」：三列聚合都是条件计数，没有任何 ORDER BY
    （步 3 判断 1 走 (b) 路的全部实现就在这句「没有 ORDER BY」上）。

    一条 GROUP BY (subject_type, subject_id) 的查询拿齐全部关联；project_id 谓词必须
    带上——run_record 与关联行同 project_id 是写入方常识但**不是不变式**（步 2 判断 3
    在级联处写过同一句话），少了它就是把「别项目恰好同 subject_id 的 run」算进本计划的
    通过率。没有 run 的 key 不在结果行里，取用时按 (0,0,0) 补——「没跑过」是数据形状，
    不是查询异常。
    """
    if not links:
        return {}
    pairs = sorted({(lk.subject_type, lk.subject_id) for lk in links})
    out: dict[tuple[str, str], tuple[int, int, int]] = {}
    # D275：SQLite 的绑定参数上限是 999（一对占 2 个），一页 50 个计划×多关联很容易超过。
    # 按 300 对分块，语义不变：pairs 已去重，块间无重键，按 key 合并即可。
    for i in range(0, len(pairs), 300):
        chunk = pairs[i:i + 300]
        stmt = (
            select(
                RUN_RECORD.c.subject_type,
                RUN_RECORD.c.subject_id,
                func.count(case((RUN_RECORD.c.status.in_(TERMINAL_STATUSES), 1))),
                func.count(case((RUN_RECORD.c.status.in_(FAILING_STATUSES), 1))),
                func.count(case((RUN_RECORD.c.status.in_(INFLIGHT_STATUSES), 1))),
            )
            .where(
                RUN_RECORD.c.project_id == project_id,
                or_(
                    *[and_(RUN_RECORD.c.subject_type == st, RUN_RECORD.c.subject_id == sid)
                      for st, sid in chunk]
                ),
            )
            .group_by(RUN_RECORD.c.subject_type, RUN_RECORD.c.subject_id)
        )
        for st, sid, t, f, g in (await db.execute(stmt)).all():
            out[(str(st), str(sid))] = (int(t), int(f), int(g))
    return out


def _link_result(terminal: int, failing: int, inflight: int) -> tuple[bool, bool, str]:
    """(executed, executing, result)。纯函数——单测直接喂计数向量，不经 HTTP 也测口径。"""
    executed = terminal > 0
    executing = inflight > 0
    if not executed:
        return executed, executing, "none"
    return executed, executing, "failed" if failing > 0 else "passed"


def _plan_display(archived: bool, total: int, executed: int, passed: int) -> str:
    """展示态现算（§二 1：库里没有这一列，这里就是唯一产出口）。

    归档优先于一切现算值；其余三态只看「已执行/全过」两个量级，**与执行中的那部分无关**
    ——跑着不算跑完（§六 3）。total=0 的计划是 not_started：空计划「全部通过」是空真，
    报 completed 就是说谎（没有一条用例被验证过）。

    步 4 的同一张函数还被 plan_report_create 用来**抄一份定格**进 report.status——
    同一个产出口，现算与快照共用一份判定（两套判定 = 两份会各自漂移的真相）。
    """
    if archived:
        return "archived"
    if executed == 0:
        return "not_started"
    if executed == total and passed == executed:
        return "completed"
    return "in_progress"


def _rates(total: int, passed: int, executed: int) -> tuple[float, float]:
    """两个率的唯一算式（pass_rate, execute_rate）。

    判据 3 的「与步 3 口径逐字相同」在这里的实现 = **同一个函数**，不是两份长得像的代码：
    分母恒为 total（用例总数），未执行/执行中拉低通过率、「跑一半」拉低执行率；
    空计划 0.0 不是 1.0（除法没有「0/0=全过」这种数学捷径，界面上的 0% 才是诚实的）。
    """
    return (passed / total if total else 0.0, executed / total if total else 0.0)


async def _plan_links(db, project_id: str, plan_id: str) -> list[PlanCaseLink]:
    """计划的全部关联行，id 升序（plan_list/plan_link_list 同尺的绝对期望序）。

    步 3 现算与步 4 生成快照**共用这一份谓词与序**：同一个列表 = 同一个分母（判据 3），
    两条路各写一份查询就是给「实时态与报告对不上」留活口。
    """
    return list(
        (
            await db.execute(
                select(PlanCaseLink)
                .where(PlanCaseLink.plan_id == plan_id, PlanCaseLink.project_id == project_id)
                .order_by(PlanCaseLink.id)
            )
        )
        .scalars()
        .all()
    )


def _functional_result(ex: PlanFunctionalExec | None) -> tuple[bool, bool, str]:
    """功能用例当前结论 → 与 _link_result 同形的三问。

    pass → passed；fail/blocked/skip → **failed**（已执行但未通过）。为什么不把 blocked/skip
    单列进 LINK_RESULTS：计划状态/报告的通过率只有 passed/failed 两轴口径（D183 已裁），
    把「阻塞」谎报成「通过」会抬高通过率，谎报成"未执行"会拉低执行率；算作「未通过」
    是唯一不撒谎的一种。列表行仍显示原始 result，界面能区分「阻塞」与「失败」。
    """
    if ex is None:
        return False, False, "none"
    return True, False, ("passed" if ex.result == "pass" else "failed")


async def _aggregate_links(
    db, project_id: str, plan_id: str
) -> list[tuple[PlanCaseLink, tuple[bool, bool, str]]]:
    """关联行 + 各自现算结论（与顺序无关的三问）。

    步 3 的 plan_status 与步 4 的 plan_report_create **共用这一个折叠**：实时态与报告
    的每个数字都出自同一个函数（判据 3「口径逐字相同」的实现形态 = 共用代码，
    不是两份长得像的实现）。没有 run 的 key 按 (0,0,0) 补——「没跑过」是数据形状。

    D204 起，functional_case 的结论来自人工执行表（plan_functional_exec），
    其余四类仍 join run_record；两条来源在同一个折叠里汇合，通过率分母不分裂。
    """
    links = await _plan_links(db, project_id, plan_id)
    manual = [lk for lk in links if lk.subject_type == "functional_case"]
    buckets = await _link_results(
        db, [lk for lk in links if lk.subject_type != "functional_case"], project_id
    )
    execs = await _functional_exec_map(db, [lk.id for lk in manual])
    out: list[tuple[PlanCaseLink, tuple[bool, bool, str]]] = []
    for lk in links:
        if lk.subject_type == "functional_case":
            out.append((lk, _functional_result(execs.get(lk.id))))
        else:
            out.append((lk, _link_result(*buckets.get((lk.subject_type, lk.subject_id), (0, 0, 0)))))
    return out


@service(
    perm="testplan:plan:read",
    effect="read",
    name="plan_status",
    description="计划实时状态现算（未开始/进行中/已完成/归档 + 通过率/执行率；"
    "queued/running 算执行中不算已执行，两个率的分母都是用例总数；不落库）",
    http={"method": "GET", "path": "/plans/{plan_id}/status", "tags": ["testplan"], "status": 200},
)
async def plan_status(payload: schemas.PlanStatusIn, ctx) -> schemas.PlanStatusOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:read")
    assert ctx.db is not None
    p = await _plan(
        ctx.db, payload.project_id, payload.plan_id
    )  # 跨项目与不存在同码同文案（判断 4 复用判断 1 的门）
    agg = await _aggregate_links(ctx.db, p.project_id, p.id)
    items: list[schemas.PlanLinkStatusOut] = []
    passed = failed = executed = executing = 0
    for lk, (ex, ing, result) in agg:
        if result == "passed":
            passed += 1
        elif result == "failed":
            failed += 1
        executed += int(ex)
        executing += int(ing)
        items.append(
            schemas.PlanLinkStatusOut(
                link_id=lk.id,
                subject_type=lk.subject_type,
                subject_id=lk.subject_id,
                subject_name=lk.subject_name,
                env_id=lk.env_id,
                executed=ex,
                executing=ing,
                result=result,
            )
        )
    total = len(agg)
    # 分母恒为 total（§六 3）：未执行拉低通过率，「跑一半」拉低执行率。空计划 0.0 不是
    # 1.0——口径在 _rates（步 4 的报告读路径共用那一个函数，两处不可能漂移）。
    pass_rate, execute_rate = _rates(total, passed, executed)
    return schemas.PlanStatusOut(
        plan_id=p.id,
        project_id=p.project_id,
        name=p.name,
        archived=p.archived,
        status=_plan_display(p.archived, total, executed, passed),
        total=total,
        passed=passed,
        failed=failed,
        executed=executed,
        executing=executing,
        not_executed=total - executed,
        pass_rate=pass_rate,
        execute_rate=execute_rate,
        links=items,
    )


@service(
    perm="testplan:plan:read",
    effect="read",
    name="plan_status_batch",
    description="计划列表的批量状态投影（当前页一次算完：状态/通过率/执行率/各类型用例数；"
    "判据与 /plans/{plan_id}/status 共用 _plan_display/_link_result/_rates，不另立口径；"
    "只回仍存在的计划，total 供调用方对账）",
    http={"method": "POST", "path": "/plan-status-batch", "tags": ["testplan"], "status": 200},
)
async def plan_status_batch(payload: schemas.PlanStatusBatchIn, ctx) -> schemas.PlanStatusBatchOut:
    """D275：列表页一次拿齐当前页的状态/规模，**不逐行打 /status**（50 行就是 50 份明细）。

    与 plan_status 同源的三件套：同一份关联谓词、同一个 _link_result/_functional_result、
    同一个 _rates/_plan_display。差别只有「批量取数 + 不返回 links 明细」。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:read")
    assert ctx.db is not None
    ids = list(dict.fromkeys(payload.plan_ids))
    plans = (
        (await ctx.db.execute(select(PlanRecord).where(
            PlanRecord.project_id == payload.project_id, PlanRecord.id.in_(ids))))
        .scalars().all()
    )
    if not plans:
        return schemas.PlanStatusBatchOut(items=[], total=0)
    # 一次取齐这些计划的全部关联行（id 升序 = 计划详情页的绝对期望序，口径同 _plan_links）。
    links = (
        (await ctx.db.execute(select(PlanCaseLink).where(
            PlanCaseLink.project_id == payload.project_id,
            PlanCaseLink.plan_id.in_([p.id for p in plans]),
        ).order_by(PlanCaseLink.id)))
        .scalars().all()
    )
    by_plan: dict[str, list[PlanCaseLink]] = {}
    for lk in links:
        by_plan.setdefault(lk.plan_id, []).append(lk)
    buckets = await _link_results(
        ctx.db, [lk for lk in links if lk.subject_type != "functional_case"], payload.project_id)
    execs = await _functional_exec_map(
        ctx.db, [lk.id for lk in links if lk.subject_type == "functional_case"])
    items: list[schemas.PlanStatusSummaryOut] = []
    for p in plans:
        passed = failed = executed = executing = 0
        counts = {t: 0 for t in ("functional_case", "api_case", "scenario", "ui_case", "adb_case")}
        rows = by_plan.get(p.id, [])
        for lk in rows:
            if lk.subject_type in counts:
                counts[lk.subject_type] += 1
            if lk.subject_type == "functional_case":
                ex, ing, result = _functional_result(execs.get(lk.id))
            else:
                ex, ing, result = _link_result(
                    *buckets.get((lk.subject_type, lk.subject_id), (0, 0, 0)))
            if result == "passed":
                passed += 1
            elif result == "failed":
                failed += 1
            executed += int(ex)
            executing += int(ing)
        total = len(rows)
        pass_rate, execute_rate = _rates(total, passed, executed)
        items.append(schemas.PlanStatusSummaryOut(
            plan_id=p.id,
            archived=p.archived,
            status=_plan_display(p.archived, total, executed, passed),
            total=total,
            passed=passed,
            failed=failed,
            executed=executed,
            executing=executing,
            not_executed=total - executed,
            pass_rate=pass_rate,
            execute_rate=execute_rate,
            counts=schemas.PlanSubjectCountsOut(**counts),
        ))
    return schemas.PlanStatusBatchOut(items=items, total=len(items))


# ══════════════════ 步 4：plan_report + plan_report_item（生成 = 一次性快照） ══════════════════


def _report_row(r: PlanReport) -> schemas.PlanReportListRowOut:
    """报告头 → 行投影。三个派生数（not_executed/两率）在**存量计数**上现算——
    纯函数不漂移（存两份会各自漂移的真相才是病，见 PlanReport docstring）。"""
    pass_rate, execute_rate = _rates(r.total, r.passed, r.executed)
    return schemas.PlanReportListRowOut(
        id=r.id,
        project_id=r.project_id,
        plan_id=r.plan_id,
        name=r.name,
        status=r.status,
        total=r.total,
        passed=r.passed,
        failed=r.failed,
        executed=r.executed,
        executing=r.executing,
        not_executed=r.total - r.executed,
        pass_rate=pass_rate,
        execute_rate=execute_rate,
        created_by=r.created_by,
        created_at=schemas.iso(r.created_at),
        updated_at=schemas.iso(r.updated_at),
    )


def _item_out(it: PlanReportItem) -> schemas.PlanReportItemOut:
    return schemas.PlanReportItemOut(
        id=it.id,
        report_id=it.report_id,
        link_id=it.link_id,
        subject_type=it.subject_type,
        subject_id=it.subject_id,
        subject_name=it.subject_name,
        env_id=it.env_id,
        executed=it.executed,
        executing=it.executing,
        result=it.result,
        created_at=schemas.iso(it.created_at),
        updated_at=schemas.iso(it.updated_at),
    )


async def _report(db, project_id: str, report_id: str) -> PlanReport:
    """按 (id, project_id) 取报告行；别项目的报告与不存在同码同文案（_plan 同纪律）。"""
    r = (
        await db.execute(
            select(PlanReport).where(PlanReport.id == report_id, PlanReport.project_id == project_id)
        )
    ).scalar_one_or_none()
    if r is None:
        raise ApiError("not_found", "报告不存在", 404, {"report_id": report_id})
    return r


def _report_item_stmt(report_id: str, project_id: str) -> Select:
    """明细查询的**唯一一份**谓词与序（详情内联 _report_items 与步 5 的分页端点共用）。

    明细按 link_id 升序（绝对期望序：同报告内 uq(report_id, link_id) 让它成为全序；
    按 item id 排会把 uuid 的随机序读成「明细顺序」——plan_link_list 的 link id 升序才是
    用户认识的那个序，报告与实时态的 links 对齐同一个序）。

    project_id 谓词与父报告的归属判定同尺：明细行与报告头同 project_id 是写入方的常识
    但**不是不变式**（步 2/3 在级联与 run 聚合处写过同一句话）——少了它，「别项目恰好
    同 report_id 形状的行」就会混进 payload（report_id 是 uuid 撞不上是运气，不是设计）。

    步 5 起这一份语句被两条读路共用（详情全量 + 分页窗口）：**一份语句 = 同一个序**，
    「逐页走出的 items 与详情 payload 的 items 逐字节相等」是用例（test_d183_report_item_page），
    不是约定——两处各写一份 where/order_by 就是「同一条明细在两个端点顺序不同」的产房
    （与 _rates/_aggregate_links 同一纪律：一个函数，不是两份长得像的实现）。
    """
    return (
        select(PlanReportItem)
        .where(PlanReportItem.report_id == report_id, PlanReportItem.project_id == project_id)
        .order_by(PlanReportItem.link_id)
    )


async def _report_items(db, report_id: str, project_id: str) -> list[PlanReportItem]:
    """详情用的全量明细。谓词与序的理由与「不许分叉」的口径都写在 _report_item_stmt。"""
    return list((await db.execute(_report_item_stmt(report_id, project_id))).scalars().all())


@service(
    perm="testplan:report:create",
    effect="write",
    name="plan_report_create",
    description="生成计划报告（一次性快照：抄计划名/展示态/计数/逐关联结论进 report+item，"
    "此后用例怎么改、再执行多少次都不动已生成的报告；"
    "与实时状态同一套口径与同一份取数）",
    http={"method": "POST", "path": "/plans/{plan_id}/reports", "tags": ["testplan"], "status": 201},
)
async def plan_report_create(payload: schemas.PlanReportCreateIn, ctx) -> schemas.PlanReportOut:
    """生成 = 一次性快照。三件事都在这一个函数里（§三 3 的环闭合：写入方 = 生成路径本身）：

    1. **取数与步 3 逐字同源**：_plan_links（同一份谓词+序）→ _link_results/_link_result
       （同一份词表与判定）→ _rates/_plan_display（同一份算式）。报告与实时态若对不上，
       红的是这份共用代码，不是两份长得像的实现。
    2. **大声失败（判据 6，§三 5 的反面）**：整个生成在一个隐式事务里——头行与明细行
       **一次 commit**。任何一步抛错（校验、聚合查询、插入、uq 撞键的 IntegrityError），
       路由投影层统一 rollback（core/service.py:361-367：异常先回滚再落审计 ok=False 再重抛），
       调用方看到 4xx/5xx，库里**零半成品**。没有 try/except 吞、没有「先生成头、明细以后补」
       的两截写——MS 那种「报告生成失败静默只打日志」（取证 §6 第 10 条）是我们点名不抄的。
    3. **归档件照样能生成报告**：归档封的是「继续执行它」（§六 4），不封「给它的历史出凭证」。
       报告是对**过去**的定格，对归档计划生成报告恰恰是归档后的正当动作。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:report:create")
    assert ctx.db is not None
    p = await _plan(ctx.db, payload.project_id, payload.plan_id)
    # _aggregate_links = 步 3 现算用的同一个折叠（同一份谓词/序/词表/判定）：
    # 报告的每个数字都出自实时态用的同一份代码，「口径逐字相同」不靠两处小心对齐。
    agg = await _aggregate_links(ctx.db, p.project_id, p.id)
    passed = failed = executed = executing = 0
    rows: list[PlanReportItem] = []
    for lk, (ex, ing, result) in agg:
        if result == "passed":
            passed += 1
        elif result == "failed":
            failed += 1
        executed += int(ex)
        executing += int(ing)
        rows.append(
            PlanReportItem(
                project_id=p.project_id,
                report_id="",  # 下面回填（同对象同事务，不 flush 不半截落库）
                link_id=lk.id,
                subject_type=lk.subject_type,
                subject_id=lk.subject_id,
                subject_name=lk.subject_name,
                env_id=lk.env_id,
                executed=ex,
                executing=ing,
                result=result,
            )
        )
    total = len(agg)
    rep = PlanReport(
        project_id=p.project_id,
        plan_id=p.id,
        name=payload.name or p.name + " 报告",
        status=_plan_display(p.archived, total, executed, passed),
        total=total,
        passed=passed,
        failed=failed,
        executed=executed,
        executing=executing,
        created_by=ctx.user_id,
    )
    # report_id 回填走内存对象（默认值在 flush 时才生成，而这里需要**先**知道 id 才能给
    # 明细带上 report_id）：显式 new_id() 与列默认同一个函数，id 语义不变。
    # 整批 add 之后**一次 commit**：头与明细同事务——任何异常都让两截一起回滚（判据 6 的
    # 「零半成品」由事务边界保证，不靠写序的自觉）。
    rep.id = new_id()
    for it in rows:
        it.report_id = rep.id
    ctx.db.add(rep)
    ctx.db.add_all(rows)
    await ctx.db.commit()
    return await _report_out(ctx.db, rep)


async def _report_out(db, r: PlanReport) -> schemas.PlanReportOut:
    """头 + 明细的全量投影（详情形状）。派生数在存量计数上现算（_rates 一个函数）；
    明细按 link_id 升序（_report_items 里有理由）。**这里没有任何 join run_record /
    plan_case_link**——报告读路径零现算是判据 2 的实现半边（变异「读取路径改成现算」
    必须红在快照用例上）。"""
    items = await _report_items(db, r.id, r.project_id)
    pass_rate, execute_rate = _rates(r.total, r.passed, r.executed)
    return schemas.PlanReportOut(
        id=r.id,
        project_id=r.project_id,
        plan_id=r.plan_id,
        name=r.name,
        status=r.status,
        total=r.total,
        passed=r.passed,
        failed=r.failed,
        executed=r.executed,
        executing=r.executing,
        not_executed=r.total - r.executed,
        pass_rate=pass_rate,
        execute_rate=execute_rate,
        created_by=r.created_by,
        created_at=schemas.iso(r.created_at),
        updated_at=schemas.iso(r.updated_at),
        items=[_item_out(it) for it in items],
    )


@service(
    perm="testplan:report:update",
    effect="write",
    name="plan_report_rename",
    description="报告改名（只写 name 一列；计数/明细/生成时状态仍是冻结快照，不动）",
    http={"method": "PATCH", "path": "/plan-reports/{report_id}", "tags": ["testplan"], "status": 200},
)
async def plan_report_rename(payload: schemas.PlanReportRenameIn, ctx) -> schemas.PlanReportListRowOut:
    """D210：MS `/reName` 的同位。**只**改 name。

    为什么可以给一张「快照表」开 update：快照冻结的是**内容**（total/passed/failed/
    status 与逐行明细），标题是元数据——MS 的 reName 也只改标题。把整行当不可变而逼用户
    「删了重生成」才改名，等于用一个更贵、更丢证据的动作换同一结果。
    写入面收窄到 name 一列：不碰计数、不碰 items、不碰 plan_id/status（改名不是重算）。
    `updated_at` 由 TimestampMixin 的 onupdate 写——它从此不再是「没人动过这行」的证人，
    行不可变用例的口径同步收窄为「内容列不可变」（tests/test_d210_report_rename.py 钉住）。

    没有重名预检：plan_report 没有 name 唯一约束（MS 也没有）；同名报告靠 id 区分，
    报告按「计划 + 时间 + 计数」被引用，不像计划那样按名被别处引用。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:report:update")
    assert ctx.db is not None
    r = await _report(ctx.db, payload.project_id, payload.report_id)
    r.name = payload.name
    await ctx.db.commit()
    return _report_row(r)


@service(
    perm="testplan:report:read",
    effect="read",
    name="plan_report_get",
    description="读报告（详情 = 头 + 全量明细；纯读存量副本，**零现算零 join**——"
    "「读取路径改成现算」是本刀变异自证点名要杀的形状。步 5 起本端点形状"
    "**不许改**：快照逐字节用例比的就是这里的 body 逐字节相等，"
    "明细分页走 GET /plan-reports/{report_id}/items，不是给这里塞 current）",
    http={"method": "GET", "path": "/plan-reports/{report_id}", "tags": ["testplan"], "status": 200},
)
async def plan_report_get(payload: schemas.PlanReportGetIn, ctx) -> schemas.PlanReportOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:report:read")
    assert ctx.db is not None
    r = await _report(ctx.db, payload.project_id, payload.report_id)
    return await _report_out(ctx.db, r)


# ── D230：报告导出（自包含 HTML，JSON 载体） ──────────────────────────────────
# 展示词表在这里**只做渲染**（值本身仍是快照原值）：词表外的状态/结论画原码——与
# notify/template.REPORT_STATUS_LABEL 同一条纪律（陌生值不编友好话）。两份词表暂不收成
# 一份：一份渲染 Markdown 通知、一份渲染 HTML 文件，合并要动已交付面（同 iso 的三处裁决）。
_REPORT_STATUS_LABELS = {"not_started": "未开始", "in_progress": "进行中",
                         "completed": "已完成", "archived": "已归档"}
_REPORT_RESULT_LABELS = {"passed": "通过", "failed": "未通过", "none": "未执行"}


def _pct(v: float) -> str:
    return f"{v * 100:.1f}%"


def _html_filename(name: str, created_at: str | None) -> str:
    """文件名 = 报告名-日期.html；Windows 禁用字符逐个换成 _（不截断名字，交给前端 download）。"""
    base = (name or "计划报告") + "-" + ((created_at or "")[:10] or "report")
    for ch in '\\/:*?"<>|':
        base = base.replace(ch, "_")
    return base.strip() + ".html"


def _report_html(r: schemas.PlanReportOut) -> str:
    """把一份**已冻结的报告快照**渲染成自包含 HTML（内联 CSS、零外链、零取数）。

    三件事一件都不做：不 join run_record/plan_case_link（读路径零现算，同 _report_out 的
    纪律）、不复算率（用 r.pass_rate/r.execute_rate）、不翻译词表外的值（原码上屏）。
    值一律 html.escape：用例名/环境 id 都是用户输入，导出文件会在浏览器里打开。
    """
    esc = escape
    status = _REPORT_STATUS_LABELS.get(r.status, r.status)
    rows: list[str] = []
    for idx, it in enumerate(r.items, 1):
        result = _REPORT_RESULT_LABELS.get(it.result, it.result)
        if it.executing:
            result += "（执行中）"
        rows.append(
            '<tr><td class="n">' + str(idx) + "</td>"
            + "<td>" + esc(it.subject_name or "") + "</td>"
            + "<td>" + esc(SUBJECT_LABELS.get(it.subject_type, it.subject_type)) + "</td>"
            + "<td>" + esc(it.env_id or "沿用对象默认") + "</td>"
            + "<td>" + esc(result) + "</td></tr>")
    body_rows = "\n".join(rows) if rows else \
        '<tr><td colspan="5" class="empty">（该报告没有明细行）</td></tr>'
    return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>计划报告 · {name}</title>
<style>
body{{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:32px;color:#1f2329;background:#fff}}
h1{{font-size:20px;margin:0 0 6px}}
.meta{{color:#646a73;font-size:12px;margin-bottom:18px}}
.cards{{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}}
.card{{border:1px solid #dee0e3;border-radius:8px;padding:10px 16px;min-width:96px}}
.card b{{display:block;font-size:20px}}
.card span{{color:#646a73;font-size:12px}}
table{{border-collapse:collapse;width:100%;font-size:13px}}
th,td{{border-bottom:1px solid #dee0e3;padding:8px 10px;text-align:left}}
th{{background:#f5f6f7;font-weight:600}}
td.n{{color:#646a73;width:48px}}
td.empty{{color:#646a73;text-align:center}}
footer{{margin-top:18px;color:#8f959e;font-size:12px}}
</style></head><body>
<h1>计划报告 · {name}</h1>
<div class="meta">状态：{status} ｜ 计划 ID：{plan_id} ｜ 生成时间：{created_at} ｜ 报告 ID：{id}</div>
<div class="cards">
<div class="card"><b>{total}</b><span>总数</span></div>
<div class="card"><b>{passed}</b><span>通过</span></div>
<div class="card"><b>{failed}</b><span>未通过</span></div>
<div class="card"><b>{executing}</b><span>执行中</span></div>
<div class="card"><b>{not_executed}</b><span>未执行</span></div>
<div class="card"><b>{pass_rate}</b><span>通过率</span></div>
<div class="card"><b>{execute_rate}</b><span>执行率</span></div>
</div>
<table><thead><tr><th>#</th><th>用例名称</th><th>对象类型</th><th>环境</th><th>结论</th></tr></thead>
<tbody>
{rows}
</tbody></table>
<footer>本文件由 TestPilot 计划报告导出生成：内容是生成报告时的快照副本，不是实时数据。</footer>
</body></html>
""".format(name=esc(r.name), status=esc(status), plan_id=esc(r.plan_id),
           created_at=esc(r.created_at or "—"), id=esc(r.id), total=r.total,
           passed=r.passed, failed=r.failed, executing=r.executing,
           not_executed=r.not_executed, pass_rate=_pct(r.pass_rate),
           execute_rate=_pct(r.execute_rate), rows=body_rows)


@service(
    perm="testplan:report:read",
    effect="read",
    name="plan_report_export",
    description="导出计划报告为自包含 HTML（返回 JSON 载体 {filename,media_type,content}，"
                "由前端落地为文件；内容是生成时的快照副本，零现算零 join——"
                "格式偏差：MS 导出 PDF，本仓无 PDF 依赖，HTML 可离线打开/直接打印为 PDF）",
    http={"method": "GET", "path": "/plan-reports/{report_id}/export", "tags": ["testplan"], "status": 200},
)
async def plan_report_export(payload: schemas.PlanReportGetIn, ctx) -> schemas.PlanReportExportOut:
    """报告导出（D230）：与详情同一份快照投影（`_report_out`），再渲染成 HTML 字符串。

    三处裁决：
    1. **不新建权限位**：纯读，复用 `testplan:report:read`（同 plan_report_item_list）。
    2. **载体 = JSON 文本**（`content`），不是 `FileResponse`：本仓所有端点在 @service
       注册表里（权限矩阵/审计/OpenAPI 一网打尽），绕出去做 raw 路由就漏一张网；
       defect_export 的 CSV 载体先例在，前端 `downloadBlob` 落地为 .html 文件。
    3. **不重算**：率与计数直接抄快照行（`_report_out` 只在存量计数上做除法），明细抄
       明细副本——导出是「把已冻结的东西换个壳」，不是第二条读路径。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:report:read")
    assert ctx.db is not None
    r = await _report(ctx.db, payload.project_id, payload.report_id)
    out = await _report_out(ctx.db, r)
    return schemas.PlanReportExportOut(
        filename=_html_filename(out.name, out.created_at),
        media_type="text/html; charset=utf-8",
        content=_report_html(out),
        item_count=len(out.items),
    )


@service(
    perm="testplan:report:read",
    effect="read",
    name="plan_report_item_list",
    description="报告明细分页（页码制，D47-b 口径与 plan_report_list 同尺：只做页码不挂 "
    "cursor；行 = 明细副本原样，零现算零 join，序 = link_id 升序 = 详情 items 同一个序）",
    http={"method": "GET", "path": "/plan-reports/{report_id}/items", "tags": ["testplan"], "status": 200},
)
async def plan_report_item_list(payload: schemas.PlanReportItemListIn, ctx) -> ServiceResult:
    """步 5 唯一的新端点：明细的**页码窗口**（D183 §五 步 5「报告详情/明细分页」）。

    端点形状的两条裁决（业主复核项）：

    - **既有 GET /plan-reports/{report_id} 的形状一个字不动**（头 + 全量 items）。
      步 4 的中心用例 `test_snapshot_payload_is_byte_identical_after_everything` 断言的
      是两次 HTTP body **逐字节相等**，另有多条用例在 create/get 回执上索引 items[0]/[1]——
      给旧端点塞 current/size 改形状，是拿判据 2 的中心证据换分页便利，方向错了。
      新数据走新路径，旧路径的契约由快照用例继续守着。
    - **不新建权限位**：这是纯读端点，复用 `testplan:report:read`——注册一个没人实现的
      位名正是判据 1 的病用在权限面上（plan_status 复用 plan:read 是同款先例）。

    与 plan_report_list 同尺的三点：Page(items, next_cursor=None, total)、size 由
    paginate_page 夹在 1..200、绝对期望序单键。序的**同源**由 _report_item_stmt 一份
    语句兑现（详情与分页共用），用例钉「逐页走出的 items == 详情 payload 的 items」。
    快照语义在这里同样成立：分页只是窗口，读的还是存量副本，零 join run_record/关联行
    （变异「分页读路径改成现算」必须红在快照用例上——它读详情，序同则窗口同）。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:report:read")
    assert ctx.db is not None
    r = await _report(ctx.db, payload.project_id, payload.report_id)  # 不存在/跨项目与详情同码同文案
    stmt = _report_item_stmt(r.id, r.project_id)
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    return Page(items=[_item_out(it) for it in page.items], next_cursor=None, total=page.total)


@service(
    perm="testplan:report:read",
    effect="read",
    name="plan_report_list",
    description="列计划的报告（页码分页；行 = 报告头不带明细——列表不为每行明细付查询）",
    http={"method": "GET", "path": "/plans/{plan_id}/reports", "tags": ["testplan"], "status": 200},
)
async def plan_report_list(payload: schemas.PlanReportListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:report:read")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)  # 与 link_list 同纪律：不存在与「没报告」不同句
    stmt = (
        select(PlanReport)
        .where(PlanReport.plan_id == payload.plan_id, PlanReport.project_id == payload.project_id)
        .order_by(PlanReport.id)  # 绝对期望序 = id 升序（同族同尺，单键）
    )
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    return Page(items=[_report_row(r) for r in page.items], next_cursor=None, total=page.total)


@service(
    perm="testplan:report:delete",
    effect="destructive",
    name="plan_report_delete",
    description="删除报告（物理删；同事务级联删该报告的明细行——只按 report_id 删，"
    "别的报告的明细一根毫毛不许动）",
    http={"method": "DELETE", "path": "/plan-reports/{report_id}", "tags": ["testplan"], "status": 200},
)
async def plan_report_delete(payload: schemas.PlanReportDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:report:delete")
    assert ctx.db is not None
    r = await _report(ctx.db, payload.project_id, payload.report_id)
    # 级联 = 应用层、与删头同事务（步 2 判断 3 同款：全仓零外键，谓词只有 report_id——
    # 「全表删」会让「本报告明细没了」变绿，那是假证据，用例逐行点隔壁报告）。
    await ctx.db.execute(sa_delete(PlanReportItem).where(PlanReportItem.report_id == r.id))
    await ctx.db.delete(r)
    await ctx.db.commit()
    return OkOut(ok=True)


# ══════════════════ D207：计划缺陷清单（只读聚合，零落库） ══════════════════


def _plan_bug_out(row, names: dict[str, str]) -> schemas.PlanBugOut:
    raw_tags = row.tags or ""
    return schemas.PlanBugOut(
        id=str(row.id),
        num=int(row.num),
        title=str(row.title),
        status=str(row.status),
        priority=str(row.priority),
        handle_user_id=(str(row.handle_user_id) if row.handle_user_id else None),
        handle_user_name=names.get(str(row.handle_user_id or "")),
        tags=[t for t in (x.strip() for x in raw_tags.split(",")) if t],
        created_at=schemas.iso(row.created_at),
        updated_at=schemas.iso(row.updated_at),
    )


@service(
    perm="testplan:link:read",
    effect="read",
    name="plan_bug_list",
    description="计划缺陷清单（计划内用例关联的缺陷，按缺陷去重；只读、页码分页）",
    http={"method": "GET", "path": "/plans/{plan_id}/bugs", "tags": ["testplan"], "status": 200},
)
async def plan_bug_list(payload: schemas.PlanBugListIn, ctx) -> ServiceResult:
    """口径 = MS `ExtTestCaseMapper.getTestPlanBug`：计划内用例关联的缺陷，distinct。

    链路：`plan_case_link (subject_type, subject_id)` ← `defect_case_link (case_type, case_id)`
    → `defect`。三张表都用本域 ORM / 反射表，**不 import defect 领域模块**（契约 1）。
    回收站里的缺陷不出现（`recycled = 0`）：清单读的是「这个计划暴露了哪些缺陷」，
    已回收的缺陷已经不在缺陷面上，出现在这里会变成一条点进去 404 的死行。
    """
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:read")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)  # 不存在/跨项目 → 404（与 link_list 同纪律）
    stmt = (
        select(
            DEFECT.c.id,
            DEFECT.c.num,
            DEFECT.c.title,
            DEFECT.c.status,
            DEFECT.c.priority,
            DEFECT.c.handle_user_id,
            DEFECT.c.tags,
            DEFECT.c.created_at,
            DEFECT.c.updated_at,
        )
        .select_from(
            DEFECT.join(
                DEFECT_CASE_LINK,
                and_(
                    DEFECT_CASE_LINK.c.defect_id == DEFECT.c.id,
                    DEFECT_CASE_LINK.c.project_id == DEFECT.c.project_id,
                ),
            ).join(
                PlanCaseLink,
                and_(
                    PlanCaseLink.subject_id == DEFECT_CASE_LINK.c.case_id,
                    PlanCaseLink.subject_type == DEFECT_CASE_LINK.c.case_type,
                    PlanCaseLink.plan_id == payload.plan_id,
                    PlanCaseLink.project_id == payload.project_id,
                ),
            )
        )
        .where(
            DEFECT.c.project_id == payload.project_id,
            # 反射列无 Boolean 类型 ⇒ 用 `= 0` 显式写（MySQL tinyint / SQLite 皆成立）。
            DEFECT.c.recycled == 0,
        )
        .distinct()
        # 确定性排序：updated_at 同秒（DATETIME 精度 0）时以 id 兜底，页码不重不漏。
        .order_by(DEFECT.c.updated_at.desc(), DEFECT.c.id.desc())
    )
    if payload.status:
        stmt = stmt.where(DEFECT.c.status == payload.status)
    if payload.priority:
        stmt = stmt.where(DEFECT.c.priority == payload.priority)
    if payload.keyword:
        kw = "%" + payload.keyword.replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(DEFECT.c.title.like(kw))
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    rows = list(page.items)
    names: dict[str, str] = {}
    user_ids = {str(r.handle_user_id) for r in rows if r.handle_user_id}
    if user_ids:
        user_rows = (
            await ctx.db.execute(
                select(APP_USER.c.id, APP_USER.c.name).where(APP_USER.c.id.in_(user_ids))
            )
        ).all()
        names = {str(i): str(n) for i, n in user_rows}
    return Page(
        items=[_plan_bug_out(r, names) for r in rows], next_cursor=None, total=page.total
    )


# ══════════════════════════════ D225：执行计划 ══════════════════════════════

# 四类「跑得起来」的关联对象 → 各自的投递服务名。经 REGISTRY 派发（契约 1：领域模块
# 之间零横向 import），与 api_test 问 scenario_case_refs / defect 问 project_meta 同款。
# api_case 自 D228 起有独立执行服务 api_case_run（trigger 按入口记 manual/schedule，
# 不是 debug——调试入口仍走 api_debug）。functional_case 刻意不在表里（人工执行）。
_PLAN_RUN_SERVICES = {
    "scenario": "scenario_run",
    "ui_case": "ui_case_run",
    "adb_case": "adb_case_run",
    "api_case": "api_case_run",
}


@service(
    perm="testplan:plan:execute",
    effect="write",
    name="plan_execute",
    description="执行计划：对计划内全部可运行关联对象（场景/UI 用例/ADB 用例/接口用例）"
                "各投一次 worker（trigger=manual），逐条回报 run_id 或跳过原因；归档计划 409；"
                "功能用例（人工执行）如实跳过，不静默吞",
    http={"method": "POST", "path": "/plans/{plan_id}/execute", "tags": ["testplan"]},
)
async def plan_execute(payload: schemas.PlanExecuteIn, ctx) -> schemas.PlanExecuteOut:
    """把计划里跑得起来的关联对象各投一次 worker，逐条回报结果。

    四条判断：

    **1. 投递走各自领域的既有执行服务，不在这里重写一遍引擎。** `scenario_run` /
    `ui_case_run` / `adb_case_run` / `api_case_run` 是四条唯一入口：它们各自做可见性、回收站、环境回落、
    broker 探活与 503 无孤儿回滚，还各自按本域权限位（`scenario:scenario:run` /
    `ui:case:run` / `adb:case:run` / `api:case:run`）再鉴一次。从计划里调用**不放大权限**：只有计划执行位
    而没有某域运行位的账号，那一条会记成跳过原因（域服务的 403 文案），其余照跑——
    整体 abort 会把「我压根没有场景执行权」演成「计划执行坏了」。

    **2. 逐条失败不许拖垮整批，但失败必须可见。** 每条独立 try；`ApiError` 的 message
    原样进 reason（回收站/不存在/broker 不可达都是人话），不是吞掉也不是 500。
    判据 6「大声失败」在这里的形态 = 每个没跑的对象都带一句得上屏的理由。

    **3. 只有 functional_case 如实跳过。** 功能用例是人工执行（D204 的结论表），给它们
    编一个「已投递」才是谎——跳过并写明原因，用户知道去关联行点「记录结论」。
    接口用例自 D228 起有独立执行服务 `api_case_run`，与调试共用 `_execute_case`，
    按本入口落 run（trigger=manual/schedule），已进入 `_PLAN_RUN_SERVICES`。

    **4. 归档计划 409，不执行。** 归档是终态（§六 4），封的就是「继续执行它」；
    报告生成例外（对过去的定格），执行不例外。
    """
    from app.core.registry import REGISTRY

    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:execute")
    assert ctx.db is not None
    p = await _plan(ctx.db, payload.project_id, payload.plan_id)
    if p.archived:
        raise ApiError("conflict", "计划已归档：归档是终态，不再参与执行", 409,
                       {"plan_id": p.id})

    links = await _plan_links(ctx.db, p.project_id, p.id)
    items: list[schemas.PlanExecuteItemOut] = []
    for lk in links:
        item = schemas.PlanExecuteItemOut(
            link_id=lk.id, subject_type=lk.subject_type,
            subject_id=lk.subject_id, subject_name=lk.subject_name,
        )
        svc_name = _PLAN_RUN_SERVICES.get(lk.subject_type)
        if svc_name is None:
            item.reason = ("功能用例是人工执行，请在关联行点「记录结论」"
                           if lk.subject_type == "functional_case"
                           else "未知关联类型：" + lk.subject_type)
            items.append(item)
            continue
        spec = REGISTRY.get(svc_name)
        if spec is None:
            item.reason = f"{svc_name} 未注册（服务尚未初始化完成）"
            items.append(item)
            continue
        body: dict[str, str] = {"project_id": p.project_id,
                                "scenario_id" if lk.subject_type == "scenario" else "case_id":
                                    lk.subject_id}
        # 环境覆盖只喂给认环境的那一家：ui/adb 两个执行入参没有 env_id（§四 末段），
        # 硬塞进去会在模型校验时 422，把「能跑」变成「全跳」。
        if lk.subject_type == "scenario" and lk.env_id:
            body["env_id"] = lk.env_id
        try:
            out = await spec.handler(spec.model.model_validate(body), ctx)
        except ApiError as e:
            item.reason = e.message
            items.append(item)
            continue
        item.run_id = str(out.run_id)
        items.append(item)

    submitted = sum(1 for i in items if i.run_id)
    return schemas.PlanExecuteOut(plan_id=p.id, submitted=submitted,
                                  skipped=len(items) - submitted, items=items)