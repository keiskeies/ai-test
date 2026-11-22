"""计划域 @service（D183 步 1 本体 CRUD/归档 + 步 2 关联 CRUD/级联 + 步 3 实时状态现算）。

步 1 的四条判断，都各有一条测试钉着（tests/test_d183_plan_crud.py）：

**1. 可见性 = 按 project_id 显式过滤，不喂 `shared/visibility`。** plan_record 没有
owner_id/project_public 两列（理由逐字写在 models.py docstring：没有表单能把计划置为
行级私有，visibility 助手对缺列的表会静默「每行都公开」——schedule_task 同款落法）。
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

from sqlalchemy import Select, and_, case, column, func, or_, select, table
from sqlalchemy import delete as sa_delete

from app.core.db import new_id
from app.core.errors import ApiError, OkOut, Page, paginate_page
from app.core.service import ServiceResult, ensure_project_access, service
from app.modules.testplan import schemas
from app.modules.testplan.models import PlanCaseLink, PlanRecord, PlanReport, PlanReportItem

# 关联 subject 的归属校验用**表名反射**而非 import api_test/scenario/ui_test/adb_test——
# 领域模块之间零横向 import 是 import-linter 契约 1 的红线，scenario/services.py 的
# ENVIRONMENT/API_CASE 两份反射与 execution 的 ledger R28 同理由。每份只带本文件用到的列。
SUBJECT_LABELS = {"api_case": "接口用例", "scenario": "场景", "ui_case": "UI 用例", "adb_case": "ADB 用例"}
# env_id **只出现在 scenario/ui_case 两份反射里**——api_case/adb_case 没有这一列
# （§四 末段的现查结论：api 的环境在执行时由请求体带、adb 的 §4.5 刻意不列）。
# 反射列抄多了就是对不存在的列写 SQL；给那两个域补 env 列更是往别人的契约里塞列。
SUBJECT_TABLES = {
    "api_case": table("api_case", column("id"), column("project_id"), column("name"), column("status")),
    "scenario": table("scenario", column("id"), column("project_id"), column("name"),
                      column("status"), column("env_id")),
    "ui_case": table("ui_case", column("id"), column("project_id"), column("name"),
                     column("status"), column("env_id")),
    "adb_case": table("adb_case", column("id"), column("project_id"), column("name"), column("status")),
}
# 环境归属校验（D181 同款，scenario/services.py 的 _env 形状）。
ENVIRONMENT = table("environment", column("id"), column("project_id"))
# 步 3 现算的 run 侧：同样**表名反射**不 import execution（import-linter 契约：execution
# 与各领域模块零横向依赖，反向同样不许）。列逐个对 app/modules/execution/models.py 现核
# （RunRecord，:16-41）：id/subject_type/subject_id/project_id/status 五列都在、名同。
# 刻意**不带** started_at/finished_at/created_at——本刀的状态口径与顺序无关（步 3 判断 1
# 走 (b) 路），带时间列就会诱惑后人加 ORDER BY 假装有秩序。cancelled/skip 属
# run_step_result.status，不在这张表上（判断 3），词表也不认它们。
RUN_RECORD = table("run_record", column("id"), column("project_id"),
                   column("subject_type"), column("subject_id"), column("status"))
# 词表（schemas，写入口校验与测试读的同一份）与反射表不许分叉：长出一边忘另一边 =
# 校验放行后查表 KeyError 500，或表反射在的词被 422 冤杀。在 import 时大声炸，
# 不留一条任何用例都走不到的运行期兜底分支（判据 1 的同一条纪律用在代码上）。
assert frozenset(SUBJECT_TABLES) == frozenset(schemas.PLAN_LINK_SUBJECT_TYPES), \
    "SUBJECT_TABLES 与 PLAN_LINK_SUBJECT_TYPES 分叉了：" + str(sorted(SUBJECT_TABLES))


def _out(p: PlanRecord) -> schemas.PlanOut:
    return schemas.PlanOut(
        id=p.id, project_id=p.project_id, name=p.name, description=p.description,
        archived=p.archived, created_by=p.created_by, updated_by=p.updated_by,
        created_at=schemas.iso(p.created_at), updated_at=schemas.iso(p.updated_at),
    )


async def _plan(db, project_id: str, plan_id: str) -> PlanRecord:
    """按 (id, project_id) 取行；别项目的计划与不存在同码同文案（不泄露存在性）。

    project_id 谓词是本表可见性的**全部**实现（判断 1）：没有第二层行级过滤，
    列表谓词与这里的谓词同尺——「列表里看得见」与「详情取得到」是同一个条件。
    """
    p = (await db.execute(
        select(PlanRecord).where(PlanRecord.id == plan_id, PlanRecord.project_id == project_id)
    )).scalar_one_or_none()
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


@service(
    perm="testplan:plan:create", effect="write", name="plan_create",
    description="在项目中创建测试计划（同项目重名 409；新建即未归档的项目级共享计划）",
    http={"method": "POST", "path": "/plans", "tags": ["testplan"], "status": 201},
)
async def plan_create(payload: schemas.PlanCreateIn, ctx) -> schemas.PlanOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:create")
    assert ctx.db is not None
    await _name_dup(ctx.db, payload.project_id, payload.name)
    p = PlanRecord(project_id=payload.project_id, name=payload.name, description=payload.description,
                   created_by=ctx.user_id, updated_by=ctx.user_id)
    ctx.db.add(p)
    await ctx.db.commit()
    return _out(p)


@service(
    perm="testplan:plan:read", effect="read", name="plan_list",
    description="列出本项目的测试计划（页码分页；未归档与已归档都在列表里，archived 是列不是筛选）",
    http={"method": "GET", "path": "/plans", "tags": ["testplan"], "status": 200},
)
async def plan_list(payload: schemas.PlanListIn, ctx) -> ServiceResult:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:read")
    assert ctx.db is not None
    # project_id 单谓词 = 判断 1 的列表侧；归档件不藏：MS 的计划列表是含归档的（归档件
    # 在执行编排里被跳过，但列得出来），藏起来会让「归档去哪了」变成失踪案。
    stmt = (
        select(PlanRecord)
        .where(PlanRecord.project_id == payload.project_id)
        .order_by(PlanRecord.id)  # 绝对期望序 = id 升序（D47-b 判据 5 同尺，单键）
    )
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    return Page(items=[_out(p) for p in page.items], next_cursor=None, total=page.total)


@service(
    perm="testplan:plan:read", effect="read", name="plan_get",
    description="获取计划详情（跨项目与不存在同码同文案）",
    http={"method": "GET", "path": "/plans/{plan_id}", "tags": ["testplan"], "status": 200},
)
async def plan_get(payload: schemas.PlanGetIn, ctx) -> schemas.PlanOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:read")
    assert ctx.db is not None
    return _out(await _plan(ctx.db, payload.project_id, payload.plan_id))


@service(
    perm="testplan:plan:update", effect="write", name="plan_update",
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
    # 每一次普通更新也落 updated_by：列语义是「最后谁动的」，归档那次同样动它（判断 2）。
    p.updated_by = ctx.user_id
    await ctx.db.commit()
    return _out(p)


@service(
    perm="testplan:plan:delete", effect="destructive", name="plan_delete",
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
    #
    # 级联（步 2 还的债，判断 3；步 4 把报告两表接进同一条链）：全仓零外键，级联只能在应用层做。
    # 谓词**只有 plan_id**——按 (id, project_id) 取到计划已经证明了项目归属，关联行/报告与
    # 计划同 project_id 是写入方的不变式，多带一个 project_id 谓词只会把「不变式哪天被写歪」
    # 伪装成「孤儿行合法地留在了库里」。报告明细**不在这儿删**——它按 report_id 级联，
    # 先删报告头之前把该计划的报告明细一起按「本计划的报告 id」删净（否则孤儿明细）。
    # 删完不 commit 就继续删计划：**一次 commit 同事务落所有刀**，
    # 任何一步抛错都会把它们一起回滚（不会留下「计划没了、关联/报告还在」的半截现场）。
    report_ids = select(PlanReport.id).where(PlanReport.plan_id == p.id)
    await ctx.db.execute(sa_delete(PlanReportItem).where(PlanReportItem.report_id.in_(report_ids)))
    await ctx.db.execute(sa_delete(PlanReport).where(PlanReport.plan_id == p.id))
    await ctx.db.execute(sa_delete(PlanCaseLink).where(PlanCaseLink.plan_id == p.id))
    await ctx.db.delete(p)
    await ctx.db.commit()
    return OkOut(ok=True)


@service(
    perm="testplan:plan:manage", effect="write", name="plan_archive",
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
        raise ApiError("already_archived", "计划已归档（归档是终态，无反归档路径）", 409,
                       {"plan_id": p.id})
    p.archived = True
    p.updated_by = ctx.user_id
    await ctx.db.commit()
    return _out(p)


# ══════════════════ 步 2：plan_case_link 关联 CRUD ══════════════════


def _link_out(lk: PlanCaseLink) -> schemas.PlanLinkOut:
    return schemas.PlanLinkOut(
        id=lk.id, project_id=lk.project_id, plan_id=lk.plan_id,
        subject_type=lk.subject_type, subject_id=lk.subject_id, subject_name=lk.subject_name,
        env_id=lk.env_id, created_by=lk.created_by,
        created_at=schemas.iso(lk.created_at), updated_at=schemas.iso(lk.updated_at),
    )


async def _env(db, project_id: str, env_id: str) -> None:
    """环境归属校验（D181 形状，scenario/services.py:_env 逐字同款码文）。

    按 (id, project_id) 双条件取行，查不到（不存在、或在别的项目）都是同一句
    404「环境不存在」——跨项目 env 与不存在同码同文案，不泄露存在性。病因同款：
    不在写入口拦，到点运行才在执行链路炸。
    """
    hit = (await db.execute(select(ENVIRONMENT.c.id).where(
        ENVIRONMENT.c.id == env_id, ENVIRONMENT.c.project_id == project_id))).first()
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
        raise ApiError("validation_failed",
                       "subject_type 只支持 " + "/".join(schemas.PLAN_LINK_SUBJECT_TYPES)
                       + "（inline 的 subject_id 是常量、api_definition 不是用例层对象）",
                       422, {"subject_type": subject_type})
    t = SUBJECT_TABLES[subject_type]
    has_env = "env_id" in t.c
    cols = [t.c.id, t.c.name, t.c.status] + ([t.c.env_id] if has_env else [])
    row = (await db.execute(
        select(*cols).where(t.c.id == subject_id, t.c.project_id == project_id).limit(1)
    )).first()
    if row is None:
        raise ApiError("not_found", SUBJECT_LABELS[subject_type] + "不存在", 404, {"subject_id": subject_id})
    if row[2] != "normal":
        raise ApiError("not_found", SUBJECT_LABELS[subject_type] + "不存在（在回收站）", 404,
                       {"subject_id": subject_id})
    return str(row[1]), (str(row[3]) if has_env and row[3] is not None else None)


async def _link(db, project_id: str, plan_id: str, link_id: str) -> PlanCaseLink:
    """取关联行：(id, project_id, plan_id) 三条件，任何一种错位都是同一句 404。

    挂别的计划的 link_id 与不存在的 link_id 逐字同文——与 _plan 同纪律，
    嵌套路径 /plans/{plan_id}/case-links/{link_id} 不泄露「这条 link 存在于别的计划」。
    """
    lk = (await db.execute(
        select(PlanCaseLink).where(PlanCaseLink.id == link_id,
                                   PlanCaseLink.project_id == project_id,
                                   PlanCaseLink.plan_id == plan_id)
    )).scalar_one_or_none()
    if lk is None:
        raise ApiError("not_found", "关联不存在", 404, {"link_id": link_id})
    return lk


@service(
    perm="testplan:link:create", effect="write", name="plan_link_create",
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
    dup = (await ctx.db.execute(
        select(PlanCaseLink.id).where(PlanCaseLink.plan_id == payload.plan_id,
                                      PlanCaseLink.subject_type == payload.subject_type,
                                      PlanCaseLink.subject_id == payload.subject_id).limit(1)
    )).first()
    if dup is not None:
        # 预检与 uq_plan_case_link_plan_subject 同尺：409 说清撞的是哪条（IntegrityError
        # 兜底同样是 409 但只剩「数据唯一性冲突」，说不清撞了什么——plan_create 同款裁决）。
        raise ApiError("conflict", "该对象已在此计划中", 409,
                       {"plan_id": payload.plan_id, "subject_type": payload.subject_type,
                        "subject_id": payload.subject_id})
    lk = PlanCaseLink(project_id=payload.project_id, plan_id=payload.plan_id,
                       subject_type=payload.subject_type, subject_id=payload.subject_id,
                       subject_name=name, env_id=env_id, created_by=ctx.user_id)
    ctx.db.add(lk)
    await ctx.db.commit()
    return _link_out(lk)


@service(
    perm="testplan:link:read", effect="read", name="plan_link_list",
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
        .order_by(PlanCaseLink.id)  # 绝对期望序 = id 升序（plan_list 同尺，单键）
    )
    page = await paginate_page(ctx.db, stmt, current=payload.current, size=payload.size)
    return Page(items=[_link_out(lk) for lk in page.items], next_cursor=None, total=page.total)


@service(
    perm="testplan:link:update", effect="write", name="plan_link_update",
    description="改关联行的执行环境（**只改 env**：换 subject 是删了重挂；clear_env 显式清空）",
    http={"method": "PATCH", "path": "/plans/{plan_id}/case-links/{link_id}", "tags": ["testplan"], "status": 200},
)
async def plan_link_update(payload: schemas.PlanLinkUpdateIn, ctx) -> schemas.PlanLinkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:update")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    lk = await _link(ctx.db, payload.project_id, payload.plan_id, payload.link_id)
    if payload.env_id is not None and payload.clear_env:
        # 「换成 A」与「清空」同时说 = 说不清的一句话，422 让调用方自己选（不猜）。
        raise ApiError("validation_failed", "env_id 与 clear_env 不能同时给", 422,
                       {"link_id": payload.link_id})
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
    perm="testplan:link:delete", effect="destructive", name="plan_link_delete",
    description="把用例从计划里摘除（只删关联行，对象本身毫发无损——摘挂不是删用例）",
    http={"method": "DELETE", "path": "/plans/{plan_id}/case-links/{link_id}", "tags": ["testplan"], "status": 200},
)
async def plan_link_delete(payload: schemas.PlanLinkDeleteIn, ctx) -> OkOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:link:delete")
    assert ctx.db is not None
    await _plan(ctx.db, payload.project_id, payload.plan_id)
    lk = await _link(ctx.db, payload.project_id, payload.plan_id, payload.link_id)
    await ctx.db.delete(lk)
    await ctx.db.commit()
    return OkOut(ok=True)


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
assert set(TERMINAL_STATUSES) | set(INFLIGHT_STATUSES) == {"passed", "failed", "error", "queued", "running"}, \
    "run_record.status 词表漂移：先现查 execution 的写入点再改这里"


async def _link_results(db, links: list[PlanCaseLink], project_id: str) -> dict[tuple[str, str], tuple[int, int, int]]:
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
    stmt = (
        select(RUN_RECORD.c.subject_type, RUN_RECORD.c.subject_id,
               func.count(case((RUN_RECORD.c.status.in_(TERMINAL_STATUSES), 1))),
               func.count(case((RUN_RECORD.c.status.in_(FAILING_STATUSES), 1))),
               func.count(case((RUN_RECORD.c.status.in_(INFLIGHT_STATUSES), 1))))
        .where(RUN_RECORD.c.project_id == project_id,
               or_(*[and_(RUN_RECORD.c.subject_type == st, RUN_RECORD.c.subject_id == sid)
                     for st, sid in pairs]))
        .group_by(RUN_RECORD.c.subject_type, RUN_RECORD.c.subject_id)
    )
    out: dict[tuple[str, str], tuple[int, int, int]] = {}
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
    return list((await db.execute(
        select(PlanCaseLink)
        .where(PlanCaseLink.plan_id == plan_id, PlanCaseLink.project_id == project_id)
        .order_by(PlanCaseLink.id)
    )).scalars().all())


async def _aggregate_links(db, project_id: str, plan_id: str) -> list[tuple[PlanCaseLink, tuple[bool, bool, str]]]:
    """关联行 + 各自现算结论（与顺序无关的三问）。

    步 3 的 plan_status 与步 4 的 plan_report_create **共用这一个折叠**：实时态与报告
    的每个数字都出自同一个函数（判据 3「口径逐字相同」的实现形态 = 共用代码，
    不是两份长得像的实现）。没有 run 的 key 按 (0,0,0) 补——「没跑过」是数据形状。
    """
    links = await _plan_links(db, project_id, plan_id)
    buckets = await _link_results(db, links, project_id)
    return [(lk, _link_result(*buckets.get((lk.subject_type, lk.subject_id), (0, 0, 0))))
            for lk in links]


@service(
    perm="testplan:plan:read", effect="read", name="plan_status",
    description="计划实时状态现算（未开始/进行中/已完成/归档 + 通过率/执行率；"
                "queued/running 算执行中不算已执行，两个率的分母都是用例总数；不落库）",
    http={"method": "GET", "path": "/plans/{plan_id}/status", "tags": ["testplan"], "status": 200},
)
async def plan_status(payload: schemas.PlanStatusIn, ctx) -> schemas.PlanStatusOut:
    await ensure_project_access(ctx, payload.project_id)
    ctx.require("testplan:plan:read")
    assert ctx.db is not None
    p = await _plan(ctx.db, payload.project_id, payload.plan_id)  # 跨项目与不存在同码同文案（判断 4 复用判断 1 的门）
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
        items.append(schemas.PlanLinkStatusOut(
            link_id=lk.id, subject_type=lk.subject_type, subject_id=lk.subject_id,
            subject_name=lk.subject_name, env_id=lk.env_id,
            executed=ex, executing=ing, result=result))
    total = len(agg)
    # 分母恒为 total（§六 3）：未执行拉低通过率，「跑一半」拉低执行率。空计划 0.0 不是
    # 1.0——口径在 _rates（步 4 的报告读路径共用那一个函数，两处不可能漂移）。
    pass_rate, execute_rate = _rates(total, passed, executed)
    return schemas.PlanStatusOut(
        plan_id=p.id, project_id=p.project_id, name=p.name, archived=p.archived,
        status=_plan_display(p.archived, total, executed, passed),
        total=total, passed=passed, failed=failed, executed=executed, executing=executing,
        not_executed=total - executed,
        pass_rate=pass_rate,
        execute_rate=execute_rate,
        links=items,
    )


# ══════════════════ 步 4：plan_report + plan_report_item（生成 = 一次性快照） ══════════════════


def _report_row(r: PlanReport) -> schemas.PlanReportListRowOut:
    """报告头 → 行投影。三个派生数（not_executed/两率）在**存量计数**上现算——
    纯函数不漂移（存两份会各自漂移的真相才是病，见 PlanReport docstring）。"""
    pass_rate, execute_rate = _rates(r.total, r.passed, r.executed)
    return schemas.PlanReportListRowOut(
        id=r.id, project_id=r.project_id, plan_id=r.plan_id, name=r.name, status=r.status,
        total=r.total, passed=r.passed, failed=r.failed, executed=r.executed, executing=r.executing,
        not_executed=r.total - r.executed, pass_rate=pass_rate, execute_rate=execute_rate,
        created_by=r.created_by, created_at=schemas.iso(r.created_at), updated_at=schemas.iso(r.updated_at),
    )


def _item_out(it: PlanReportItem) -> schemas.PlanReportItemOut:
    return schemas.PlanReportItemOut(
        id=it.id, report_id=it.report_id, link_id=it.link_id,
        subject_type=it.subject_type, subject_id=it.subject_id, subject_name=it.subject_name,
        env_id=it.env_id, executed=it.executed, executing=it.executing, result=it.result,
        created_at=schemas.iso(it.created_at), updated_at=schemas.iso(it.updated_at),
    )


async def _report(db, project_id: str, report_id: str) -> PlanReport:
    """按 (id, project_id) 取报告行；别项目的报告与不存在同码同文案（_plan 同纪律）。"""
    r = (await db.execute(
        select(PlanReport).where(PlanReport.id == report_id, PlanReport.project_id == project_id)
    )).scalar_one_or_none()
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
    perm="testplan:report:create", effect="write", name="plan_report_create",
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
        rows.append(PlanReportItem(
            project_id=p.project_id, report_id="",  # 下面回填（同对象同事务，不 flush 不半截落库）
            link_id=lk.id, subject_type=lk.subject_type, subject_id=lk.subject_id,
            subject_name=lk.subject_name, env_id=lk.env_id,
            executed=ex, executing=ing, result=result))
    total = len(agg)
    rep = PlanReport(project_id=p.project_id, plan_id=p.id,
                     name=payload.name or p.name + " 报告",
                     status=_plan_display(p.archived, total, executed, passed),
                     total=total, passed=passed, failed=failed, executed=executed, executing=executing,
                     created_by=ctx.user_id)
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
        id=r.id, project_id=r.project_id, plan_id=r.plan_id, name=r.name, status=r.status,
        total=r.total, passed=r.passed, failed=r.failed, executed=r.executed, executing=r.executing,
        not_executed=r.total - r.executed, pass_rate=pass_rate, execute_rate=execute_rate,
        created_by=r.created_by, created_at=schemas.iso(r.created_at), updated_at=schemas.iso(r.updated_at),
        items=[_item_out(it) for it in items],
    )


@service(
    perm="testplan:report:read", effect="read", name="plan_report_get",
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


@service(
    perm="testplan:report:read", effect="read", name="plan_report_item_list",
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
    perm="testplan:report:read", effect="read", name="plan_report_list",
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
    perm="testplan:report:delete", effect="destructive", name="plan_report_delete",
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
