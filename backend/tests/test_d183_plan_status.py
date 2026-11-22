"""D183 步 3 判据刀：计划实时状态现算（计划 §五 步 3 / §六 1·3·7·8）。

钉的契约（一条判断一条用例，命名即判据；步 3 四条服务侧判断逐条有靶）：

1. **读面形状 + 空计划诚实**（shape...）：payload 键恰好十四键、link 键恰好八键；
   total=0 时两个率是 0.0 **不是 1.0**（「空集合全部已执行」在界面上是说谎）、
   状态 not_started（没有一条用例被验证过就报「已完成」也是）。
2. **queued / running 各一条，既不算通过也不算失败**（§四 ⚠ 的点名要求）：
   executed=False、executing=True、result=none——「执行中」与「没跑过」在明细里分得开，
   但都不进通过率分子、不进执行率分子。
3. **四态各自可判**（four_display...）：未开始/进行中/已完成 + 归档四格各造各的种子；
   归档件照实报数但 status 取 archived（归档优先于一切现算值）；明细绝对期望序
   （id 升序）+ 种子区分度先自证（判据 7 的前提用例形状——种子若天然同序，
   排序断言就是假的）。
4. **未执行拉低通过率**（pull_down...）：一条 passed + 一条没跑 → pass_rate == 0.5；
   「passed ÷ 已执行」的错误口径会给 1.0，本例的 0.5 就是分母=用例总数的指纹。
5. **执行率不许在「还有一堆在跑」时先走到 1.0**（never_1...）：§六 3 业主原话的直译，
   queued+running 算未执行。
6. **结论与顺序无关**（order_independent...）：同秒两条终态 run（DATETIME 精度 0 +
   uuid 主键 ⇒ 没有确定全序，coordinator 量的事实）→ 不承诺「最近那一条」，
   混合终态一律记 failed（保守口径，谎只能往「显坏」的方向谎）；纯函数向量表也钉一张。
7. **project_id 谓词在场**（foreign_run...）：别项目同 subject_id 的 passed run 不许
   算进本计划的通过率（同 project_id 是常识不是不变式，步 2 判断 3 同话）。
7b.**同一 subject 挂两个计划 → 一次执行两边都算**（shared_subject...）：`run_record` 没有
   计划维（逐列现核），而步 2 故意放行跨计划挂同一对象，于是聚合只能按
   (subject_type, subject_id) + project_id 归组 —— 这条把那个**形状后果**钉成口径，
   不是 bug 清单。将来要做计划级隔离，改的应是这条的口径（连 §5 评审 + 迁移 + 写入方），
   不是把断言改绿。
8. **可见性与门禁**（cross_project... / gates...）：跨项目与不存在逐字同 404；
   同项目成员读得到别人计划的实时状态（正向断言，守「没有行级私有」）；
   自建角色限在别的位上 → 403 且 details.perm == testplan:plan:read（真守护，
   矩阵证不了位名——第六十轮 §二口径，test_link_perm_gates_deny_real_roles 同思路）。
9. **读面零落库**（writes_nothing...）：GET 前后三张表行数逐一相等、plan_record 列集
   仍恰好九列（谁想给状态加缓存列，先撞步 1 的 DDL 反面清单）；源码扫「时间列 +
   ORDER BY 假序」：整个 testplan 模块不许碰 run_record 的 started_at/finished_at
   （判断 1 走 (b) 路的静态半边——正向用例照不出「用了个假秩序」，只能扫）。
10. **反射核表**（reflection...）：RUN_RECORD 反射的五个列名逐个对真 information_schema
    验在场（凭印象写列名会炸在真库上——步 2 的 env_id 教训）。

**为什么部分行直插 ORM**（步 1/2 同款取舍）：run_record 不是本刀的写入方（本刀只读），
queued/running 行的可控形状只能直插；计划/关联走真 HTTP 或直插按各用例需要。
每用例 conftest 已 TRUNCATE 全表，绝对计数才成立。
"""
from __future__ import annotations

from pathlib import Path

from app.modules.api_test.models import ApiCase
from app.modules.execution.models import RunRecord
from app.modules.testplan.models import PlanCaseLink
from app.modules.testplan.schemas import LINK_RESULTS, PLAN_DISPLAY_STATUSES
from app.modules.testplan.services import _link_result, _plan_display

_BASE = "/api/v1"
_MODULE_DIR = Path(__file__).resolve().parents[1] / "app" / "modules" / "testplan"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _create_plan(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _status(client, h, pid: str, plan_id: str):
    return await client.get(_BASE + f"/plans/{plan_id}/status", params={"project_id": pid}, headers=h)


async def _seed_subject(session, pid: str, *, row_id: str, name: str = "用例") -> None:
    session.add(ApiCase(id=row_id, project_id=pid, definition_id="seed-def", name=name))
    await session.commit()


async def _seed_link(session, pid: str, plan_id: str, *, row_id: str, subject_id: str) -> None:
    session.add(PlanCaseLink(id=row_id, project_id=pid, plan_id=plan_id, subject_type="api_case",
                             subject_id=subject_id, subject_name="名" + subject_id))
    await session.commit()


async def _seed_run(session, pid: str, subject_id: str, status: str) -> None:
    """直插一条 run_record（本刀只读它，它不是本刀的写入方；subject_type 恒 api_case）。"""
    session.add(RunRecord(project_id=pid, subject_type="api_case", subject_id=subject_id,
                          subject_name="r", trigger="manual", status=status))
    await session.commit()


async def _count(conn, tbl: str) -> int:
    from sqlalchemy import text

    return int((await conn.execute(text("SELECT COUNT(*) FROM " + tbl))).scalar_one())


# ══════════ 0. 纯函数向量表（口径本体，不经 HTTP、不经库） ══════════

def test_link_result_and_display_vectors() -> None:
    """_link_result / _plan_display 的逐向量钉——§六 3 与步 3 判断 2/3 的直接化身。

    (terminal, failing, inflight) 三问没有第四个维度，「最近一次」在这张表里无处藏身。
    """
    assert _link_result(0, 0, 0) == (False, False, "none")          # 从没跑过
    assert _link_result(0, 0, 2) == (False, True, "none")           # 只有 queued/running：不算跑过也不出结论
    assert _link_result(1, 0, 1) == (True, True, "passed")          # 跑完过、此刻又在跑：两个布尔共存
    assert _link_result(1, 1, 0) == (True, False, "failed")         # 混合终态 → 保守记失败（判断 2）
    assert _link_result(2, 1, 0) == (True, False, "failed")         # 两败一胜同上
    assert _plan_display(False, 0, 0, 0) == "not_started"           # 空计划不是 completed
    assert _plan_display(False, 2, 0, 0) == "not_started"           # 一条没跑完
    assert _plan_display(False, 2, 1, 1) == "in_progress"           # 跑了一半
    assert _plan_display(False, 2, 2, 1) == "in_progress"           # 全跑完但有失败
    assert _plan_display(False, 2, 2, 2) == "completed"             # 全跑全过
    assert _plan_display(True, 0, 0, 0) == "archived"               # 归档优先于空真
    assert _plan_display(True, 2, 2, 2) == "archived"               # 归档优先于 completed


def test_display_vocabulary_is_exactly_the_ruling() -> None:
    """展示态词表四值、结论词表三值，钉「不多不少」（PLAN_LINK_SUBJECT_TYPES 同款静态钉）。

    词表长在 schemas（读端点与用例读同一份，两处不可能分叉）；第四态 archived 与三个
    现算态并列在同一个字段里，是 §二 1「库里只有 archived 一个真相」在读面的镜像。
    """
    assert PLAN_DISPLAY_STATUSES == ("not_started", "in_progress", "completed", "archived")
    assert LINK_RESULTS == ("none", "passed", "failed"), "queued/running 哪天混进结论词表 = 步 3 判断 3 作废"


# ══════════ 1. 读面形状 + 空计划诚实 ══════════

async def test_status_shape_and_empty_plan_is_zero_not_one(client, session, make_user) -> None:
    """payload 键恰好十四键 / link 键恰好八键；total=0 ⇒ 两个率 0.0、not_started、不 500。"""
    boss, hb = await make_user("d183s3shape", admin=True)
    pid = await _proj(client, hb, "D183状态形状")
    pl = await _create_plan(client, hb, pid, "空空如也")
    r = await _status(client, hb, pid, pl["id"])
    assert r.status_code == 200, r.text
    b = r.json()
    assert set(b) == {"plan_id", "project_id", "name", "archived", "status", "total", "passed",
                      "failed", "executed", "executing", "not_executed", "pass_rate",
                      "execute_rate", "links"}, "状态 payload 键恰好这十四个：" + str(sorted(b))
    assert b["plan_id"] == pl["id"] and b["project_id"] == pid and b["name"] == "空空如也"
    assert b["archived"] is False and b["status"] == "not_started"
    assert b == {**b, "total": 0, "passed": 0, "failed": 0, "executed": 0, "executing": 0,
                 "not_executed": 0, "pass_rate": 0.0, "execute_rate": 0.0, "links": []}, \
        "空计划必须 0.0 不是 1.0（空真在界面上就是说谎）：" + str({k: b[k] for k in ("pass_rate", "execute_rate", "status")})
    # 跨项目/不存在的门与 plan_get 同尺：404「计划不存在」（不泄「有没有关联」）
    nf = await _status(client, hb, pid, "查无此计划")
    assert nf.status_code == 404 and nf.json()["message"] == "计划不存在"


# ══════════ 2. queued / running 各一条：既不算通过也不算失败（§四 ⚠） ══════════

async def test_queued_and_running_neither_pass_nor_fail(client, session, make_user) -> None:
    """§四 点名的造行要求：一条 queued + 一条 running，逐链接断言三问各答各的。

    照 execution/models.py:26 那句错注释（status 只有 passed/failed/error）写
    「非 passed 即失败」，本例的 failed 计数与 result 当场红。
    """
    boss, hb = await make_user("d183s3qr", admin=True)
    pid = await _proj(client, hb, "D183在跑")
    pl = await _create_plan(client, hb, pid, "排队中")
    await _seed_subject(session, pid, row_id="qr-sub")
    await _seed_link(session, pid, pl["id"], row_id="qr-l1", subject_id="qr-sub")
    await _seed_run(session, pid, "qr-sub", "queued")
    await _seed_run(session, pid, "qr-sub", "running")
    b = (await _status(client, hb, pid, pl["id"])).json()
    assert b["total"] == 1 and b["executed"] == 0 and b["executing"] == 1
    assert b["passed"] == 0 and b["failed"] == 0, "queued/running 被判成了通过或失败"
    lk = b["links"][0]
    assert set(lk) == {"link_id", "subject_type", "subject_id", "subject_name", "env_id",
                       "executed", "executing", "result"}, "link 键恰好八键：" + str(sorted(lk))
    assert lk["link_id"] == "qr-l1" and lk["executed"] is False and lk["executing"] is True
    assert lk["result"] == "none", "非终态 run 得出了结论"
    assert b["status"] in PLAN_DISPLAY_STATUSES and lk["result"] in LINK_RESULTS, \
        "读面吐出词表外的值：词表与实现分叉"
    assert b["pass_rate"] == 0.0 and b["execute_rate"] == 0.0
    assert b["status"] == "not_started", "跑着 ≠ 开始了「跑完的流程」，未开始是诚实的"


# ══════════ 3. 四态各自可判 + 明细绝对期望序（种子自证区分度） ══════════

async def test_four_display_states_each_decidable(client, session, make_user) -> None:
    """一个四关联计划（passed/failed/没跑/running）= in_progress；另造 completed、archived。

    种子区分度自证（判据 7 的前提用例形状）：link id 插入序 ≠ id 升序，先红在种子上；
    明细顺序断言是**绝对期望序**（写死 id 序列），不是「比上一次有序」。
    """
    boss, hb = await make_user("d183s3four", admin=True)
    pid = await _proj(client, hb, "D183四态")
    main = await _create_plan(client, hb, pid, "混合体")
    done = await _create_plan(client, hb, pid, "已完成")
    arch = await _create_plan(client, hb, pid, "归档件")
    seed_ids = ["s3-c", "s3-a", "s3-d", "s3-b"]
    assert sorted(seed_ids) != seed_ids, "种子没有区分度（插入序==id 序），排序断言是假的"
    # link id 与 subject 的配对**逐对写死**：id 插入序（c,a,d,b）≠ id 升序，
    # 「link s3-x 的 run 处境」由此成为确定事实；zip 两个列表的写法配错过一次（s3-c 配上了
    # s3-sub-a），所以这里不并排两个列表，只并排一份成对字面量。
    seed = {"s3-c": ("s3-sub-a", ("passed",)), "s3-a": ("s3-sub-b", ("failed",)),
            "s3-d": ("s3-sub-c", ()), "s3-b": ("s3-sub-d", ("running",))}
    assert sorted(seed) != list(seed), "种子没有区分度（插入序==id 序），排序断言是假的"
    for sid, (subj, run_states) in seed.items():
        await _seed_subject(session, pid, row_id=subj)
        await _seed_link(session, pid, main["id"], row_id=sid, subject_id=subj)
        for st in run_states:
            await _seed_run(session, pid, subj, st)
    # 种子自证：四条链接的 run 处境互不相同（全同则下面逐条断言必然同果，白测——
    # 判据 7 前提用例的形状：先证明种子有区分度，排序/逐条断言才不是假的）
    assert len({v[1] for v in seed.values()}) == 4, "种子四链接的 run 处境出现重复，逐条断言白测"

    b = (await _status(client, hb, pid, main["id"])).json()
    assert [x["link_id"] for x in b["links"]] == ["s3-a", "s3-b", "s3-c", "s3-d"], \
        "明细必须逐位 = id 升序（plan_list/plan_link_list 同尺的绝对期望序）"
    by = {x["link_id"]: x for x in b["links"]}
    assert (by["s3-a"]["executed"], by["s3-a"]["result"]) == (True, "failed")
    assert (by["s3-b"]["executed"], by["s3-b"]["executing"], by["s3-b"]["result"]) == (False, True, "none")
    assert (by["s3-c"]["executed"], by["s3-c"]["result"]) == (True, "passed")
    assert (by["s3-d"]["executed"], by["s3-d"]["executing"], by["s3-d"]["result"]) == (False, False, "none")
    assert b["status"] == "in_progress"
    assert (b["total"], b["passed"], b["failed"], b["executed"], b["executing"], b["not_executed"]) \
        == (4, 1, 1, 2, 1, 2)
    assert b["pass_rate"] == 0.25 and b["execute_rate"] == 0.5

    await _seed_subject(session, pid, row_id="ok-sub")
    await _seed_link(session, pid, done["id"], row_id="ok-l1", subject_id="ok-sub")
    await _seed_run(session, pid, "ok-sub", "passed")
    db = (await _status(client, hb, pid, done["id"])).json()
    assert db["status"] == "completed" and db["pass_rate"] == 1.0 and db["execute_rate"] == 1.0

    await _seed_subject(session, pid, row_id="ar-sub")
    await _seed_link(session, pid, arch["id"], row_id="ar-l1", subject_id="ar-sub")
    await _seed_run(session, pid, "ar-sub", "passed")
    ar = await client.post(_BASE + f"/plans/{arch['id']}/archive", json={"project_id": pid}, headers=hb)
    assert ar.status_code == 200
    ab = (await _status(client, hb, pid, arch["id"])).json()
    assert ab["archived"] is True and ab["status"] == "archived", "归档优先于一切现算值"
    assert ab["total"] == 1 and ab["passed"] == 1 and ab["pass_rate"] == 1.0, \
        "归档件照实报数：归档改的是 status 词，不是数字"


# ══════════ 4. 未执行拉低通过率（§六 3 的业务口径，钉分母） ══════════

async def test_unexecuted_drags_pass_rate_down(client, session, make_user) -> None:
    """一条 passed + 一条没跑 → pass_rate **恰好 0.5**。

    分母若是「已执行数」（错口径），这里会是 1.0——0.5 这个数就是「分母=用例总数」的
    指纹。§六 3：这条是业务口径，不许靠读代码默认。
    """
    boss, hb = await make_user("d183s3pd", admin=True)
    pid = await _proj(client, hb, "D183拉低")
    pl = await _create_plan(client, hb, pid, "拉低通过率")
    await _seed_subject(session, pid, row_id="pd-ok")
    await _seed_subject(session, pid, row_id="pd-never")
    await _seed_link(session, pid, pl["id"], row_id="pd-l1", subject_id="pd-ok")
    await _seed_link(session, pid, pl["id"], row_id="pd-l2", subject_id="pd-never")
    await _seed_run(session, pid, "pd-ok", "passed")
    b = (await _status(client, hb, pid, pl["id"])).json()
    assert b["passed"] == 1 and b["executed"] == 1 and b["total"] == 2 and b["not_executed"] == 1
    assert b["pass_rate"] == 0.5, \
        "已执行全过就给 1.0 = 分母用了已执行数（§六 3 写死分母=用例总数）：" + str(b["pass_rate"])
    assert b["execute_rate"] == 0.5 and b["status"] == "in_progress"


# ══════════ 5. 执行率不许在「还有一堆在跑」时先走到 1.0（§六 3 原话） ══════════

async def test_execute_rate_never_reaches_one_while_running(client, session, make_user) -> None:
    """一条 passed、一条此刻 queued+running → execute_rate 0.5。

    业主原话直译：「把跑一半算进已执行，执行率就会在还有一堆用例在机器上跑着的时候
    先走到 1.0，而 1.0 用户读作都跑完了」。1.0 不可逆（run 不会从 running 退回 queued），
    所以宁可保守：跑完才 +1。
    """
    boss, hb = await make_user("d183s3er", admin=True)
    pid = await _proj(client, hb, "D183执行率")
    pl = await _create_plan(client, hb, pid, "还在跑")
    await _seed_subject(session, pid, row_id="er-done")
    await _seed_subject(session, pid, row_id="er-live")
    await _seed_link(session, pid, pl["id"], row_id="er-l1", subject_id="er-done")
    await _seed_link(session, pid, pl["id"], row_id="er-l2", subject_id="er-live")
    await _seed_run(session, pid, "er-done", "passed")
    await _seed_run(session, pid, "er-live", "queued")
    await _seed_run(session, pid, "er-live", "running")
    b = (await _status(client, hb, pid, pl["id"])).json()
    assert b["executed"] == 1 and b["executing"] == 1 and b["not_executed"] == 1
    assert b["execute_rate"] == 0.5, "跑着被算成跑完：执行率撒谎（§六 3）：" + str(b["execute_rate"])
    assert b["execute_rate"] < 1.0 and b["pass_rate"] == 0.5


# ══════════ 6. 结论与顺序无关（判断 1 走 (b) + 判断 2 保守口径） ══════════

async def test_conclusion_is_order_independent(client, session, make_user) -> None:
    """同秒一 passed 一 failed：不承诺「最近那一条」（DATETIME 精度 0 + uuid 主键），
    混合终态一律 failed。造两行后**颠倒插入序**再读一次——两次的结果必须逐字节相等。

    「先 passed 后 failed 报 failed」如果实现靠任何隐式秩序（插入序、PK 序），本例的
    两种插入序会给出两个答案；(b) 路的实现里根本没有秩序可言，两次必然同果。
    """
    boss, hb = await make_user("d183s3oi", admin=True)
    pid = await _proj(client, hb, "D183序无关")
    b_out: list[dict] = []
    for tag in ("x", "y"):  # 两种插入序：passed→failed 与 failed→passed
        p = await _create_plan(client, hb, pid, "序无关" + tag)
        await _seed_subject(session, pid, row_id="oi-sub-" + tag)
        await _seed_link(session, pid, p["id"], row_id="oi-l1-" + tag, subject_id="oi-sub-" + tag)
        seq = ["passed", "failed"] if tag == "x" else ["failed", "passed"]
        for st in seq:
            await _seed_run(session, pid, "oi-sub-" + tag, st)
        b_out.append((await _status(client, hb, pid, p["id"])).json())
    assert b_out[0]["passed"] == 0 and b_out[0]["failed"] == 1
    assert b_out[0]["links"][0]["result"] == "failed"
    # 两次比对剔掉「两个计划本来就不同」的标识位；links 比结论三连（executed/executing/result）
    ident = {"plan_id", "name", "total", "passed", "failed", "executed", "executing",
             "not_executed", "pass_rate", "execute_rate", "status"}
    scalars0 = {k: v for k, v in b_out[0].items() if k != "links"}
    scalars1 = {k: v for k, v in b_out[1].items() if k != "links"}
    assert not (ident - set(scalars0))
    assert {k: v for k, v in scalars0.items() if k not in ("plan_id", "name")} == \
           {k: v for k, v in scalars1.items() if k not in ("plan_id", "name")}, \
        "颠倒 run 插入序改变了汇总数字 = 实现里有隐式秩序，(b) 路作废"
    v0 = [(x["executed"], x["executing"], x["result"]) for x in b_out[0]["links"]]
    v1 = [(x["executed"], x["executing"], x["result"]) for x in b_out[1]["links"]]
    assert v0 == v1, "颠倒 run 插入序改变了逐链接结论 = 隐式秩序，(b) 路作废"
    assert ident and v0 == [(True, False, "failed")]


# ══════════ 7. 别项目的 run 不算进本计划（project_id 谓词在场） ══════════

async def test_foreign_project_run_never_counts(client, session, make_user) -> None:
    """同 subject_id 的 passed run 落在**别项目** → 本计划通过率必须纹丝不动。

    run_record 与关联行同 project_id 是写入方常识但**不是不变式**（步 2 判断 3 在级联
    处写过同一句话）：少一个 project_id 谓词，「别项目恰好同 uuid」的 run 就会混进分子。
    """
    boss, hb = await make_user("d183s3fg", admin=True)
    pid = await _proj(client, hb, "D183外来run")
    p2 = await _proj(client, hb, "D183外来run隔壁")
    pl = await _create_plan(client, hb, pid, "本计划")
    await _seed_subject(session, pid, row_id="fg-sub")
    await _seed_link(session, pid, pl["id"], row_id="fg-l1", subject_id="fg-sub")
    await _seed_run(session, p2, "fg-sub", "passed")  # 同 subject_id、别项目、终态 passed
    b = (await _status(client, hb, pid, pl["id"])).json()
    assert (b["passed"], b["executed"], b["pass_rate"], b["status"]) == (0, 0, 0.0, "not_started"), \
        "别项目的 passed run 被算进来了（project_id 谓词被摘）：" + str(b)
    # 同项目的同 id run 正常算数（谓词没被摘过头）
    await _seed_run(session, pid, "fg-sub", "passed")
    b2 = (await _status(client, hb, pid, pl["id"])).json()
    assert (b2["passed"], b2["executed"], b2["pass_rate"]) == (1, 1, 1.0)


# ══════════ 7b. 同一 subject 挂两个计划 → 一次执行两边都算（形状后果，钉成口径） ══════════

async def test_shared_subject_run_counts_in_every_plan_it_is_linked_to(
    client, session, make_user
) -> None:
    """一条 run 让**所有**挂着该 subject 的计划都变绿 —— 这是当前形状的必然后果，
    本用例把它从「实现碰巧这样」升成「有人钉过的口径」。

    为什么必然：`run_record` 没有 plan 维度（`execution/models.py:16-41` 逐列现核，
    没有 plan_id / plan_report_id 任何一列），而步 2 **故意**允许同一对象挂进多个计划
    （uq 是 (plan_id, subject_type, subject_id)，跨计划挂同一对象必须放行 —— 那是 §二 3
    「同一条用例在两个计划里用不同环境跑」的全部意义）。于是聚合只能按
    (subject_type, subject_id) + project_id 归组，**计划这一维在数据里不存在**，
    现算状态就不可能区分「这条 run 是为哪个计划跑的」。

    不许把这条当 bug 直接改实现：要真做计划级执行隔离，得先给 run_record 加一维
    （那是 §5 架构评审 + 一版迁移 + 一个写入方的事，判据 1），届时**本用例要连着
    改口径**、不是改断言求绿。反面也一样：将来若业主裁「计划状态只看本计划触发的执行」，
    拦在最前面的应该是这条。
    """
    boss, hb = await make_user("d183s3sh", admin=True)
    pid = await _proj(client, hb, "D183跨计划共享")
    pa = await _create_plan(client, hb, pid, "计划A")
    pb = await _create_plan(client, hb, pid, "计划B")
    await _seed_subject(session, pid, row_id="sh-sub")
    await _seed_link(session, pid, pa["id"], row_id="sh-la", subject_id="sh-sub")
    await _seed_link(session, pid, pb["id"], row_id="sh-lb", subject_id="sh-sub")

    # 关联面确实是两条独立行、两个计划各自持有（不是这里先漏了才让下面看起来对）
    la = (await _status(client, hb, pid, pa["id"])).json()
    lb = (await _status(client, hb, pid, pb["id"])).json()
    assert (la["total"], lb["total"]) == (1, 1), "两个计划各自只有一条关联，否则下面全假"
    assert (la["executed"], lb["executed"]) == (0, 0), "没 run 时两边都该未执行"

    await _seed_run(session, pid, "sh-sub", "passed")  # 一次执行，不属于任何计划

    a = (await _status(client, hb, pid, pa["id"])).json()
    b = (await _status(client, hb, pid, pb["id"])).json()
    for name, body in (("计划A", a), ("计划B", b)):
        assert (body["executed"], body["passed"], body["pass_rate"], body["status"]) == \
            (1, 1, 1.0, "completed"), f"{name} 没把共享 run 算进来（聚合维度被改了？）：" + str(body)
    assert a["links"][0]["link_id"] != b["links"][0]["link_id"], \
        "两条关联必须是各自的行 —— 否则这里比的是同一个对象，上面两组断言等于只测了一次"


# ══════════ 8. 可见性两面 + 位的真守护 ══════════

async def test_status_cross_project_verbatim_and_shared_readable(client, session, make_user) -> None:
    """跨项目读实时状态与不存在逐字同 404（含 details 键形）；
    同项目 MEMBER/READONLY 读得到**别人**计划的实时状态（正向断言：守「没有行级私有」，
    将来有人给 status 加行级过滤会红在这里）。"""
    boss, hb = await make_user("d183s3xp", admin=True)
    pid = await _proj(client, hb, "D183状态甲")
    p2 = await _proj(client, hb, "D183状态乙")
    pl = await _create_plan(client, hb, pid, "甲的计划")
    other, ho = await make_user("d183s3xpb", admin=True)
    absent = await _status(client, ho, p2, "一定不存在")
    invade = await _status(client, ho, p2, pl["id"])
    assert absent.status_code == 404 and invade.status_code == 404
    assert invade.json()["code"] == absent.json()["code"] == "not_found"
    assert invade.json()["message"] == absent.json()["message"] == "计划不存在"
    assert set(invade.json()["details"]) == set(absent.json()["details"])
    # 计划原地未动（只读面本来就无写路径，这里钉「连 404 的门都没进过写路径」的形状）
    keep = await _status(client, hb, pid, pl["id"])
    assert keep.status_code == 200 and keep.json()["status"] == "not_started"

    mem, hm = await make_user("d183s3xpm")
    await _member(client, hb, pid, mem.id, "MEMBER")
    g = await _status(client, hm, pid, pl["id"])
    assert g.status_code == 200, "同项目成员读不到别人的计划实时状态 = 行级私有混进来"
    ro, hr = await make_user("d183s3xpr")
    await _member(client, hb, pid, ro.id, "READONLY")
    assert (await _status(client, hr, pid, pl["id"])).status_code == 200


async def test_status_perm_gated_by_real_custom_role(client, session, make_user) -> None:
    """位名守护（矩阵证不了位名——第六十轮 §二）：自建角色限在 env:config:read 上，
    GET status 必须 403 且 details.perm **自己报出** testplan:plan:read。
    本端点位复用 plan:read（不新造位、不造 :manage），静态钉同步在场。"""
    boss, hb = await make_user("d183s3gate", admin=True)
    pid = await _proj(client, hb, "D183状态门禁")
    pl = await _create_plan(client, hb, pid, "门禁计划")

    rr = await client.post(_BASE + "/custom-roles",
                           json={"project_id": pid, "name": "只读环境-s3", "template_code": "READONLY"},
                           headers=hb)
    assert rr.status_code in (200, 201), rr.text
    code = rr.json()["code"]
    pr = await client.patch(_BASE + "/custom-roles/" + code,
                            json={"project_id": pid, "perms": ["env:config:read"]}, headers=hb)
    assert pr.status_code == 200, pr.text
    cu, hc = await make_user("d183s3gatecu")
    await _member(client, hb, pid, cu.id, code)
    d = await _status(client, hc, pid, pl["id"])
    assert d.status_code == 403 and d.json()["code"] == "insufficient_permission"
    assert d.json()["details"]["perm"] == "testplan:plan:read", \
        "位名被改时这一条必须红（矩阵四格照绿，它才是守护）"

    from app.core.registry import REGISTRY

    spec = REGISTRY.get("plan_status")
    assert spec is not None, "注册表没有 plan_status"
    assert spec.perm == "testplan:plan:read", "步 3 复用读位，不新造位（业主口径：不造 :manage）"
    assert "manage" not in spec.perm


# ══════════ 9. 读面零落库 + 「不许碰时间列」源码扫（判断 1/4 的静态半边） ══════════

async def test_status_reads_write_nothing(client, session, conn, make_user) -> None:
    """GET 前后 plan_record / plan_case_link / run_record 行数逐一相等；
    plan_record 列集仍恰好九列（状态要落库 = 撞步 1 DDL 反面清单）；
    整个 testplan 模块源码里不许出现 started_at/finished_at——run_record 的时间列
    精度 0 且主键 uuid4，谁碰它们谁就在假装有秩序（判断 1 (b) 路的源码级钉；
    行为用例照不出「用了假秩序但碰巧这次对」，只能扫，步 1 用例 7 同法）。
    """
    boss, hb = await make_user("d183s3nw", admin=True)
    pid = await _proj(client, hb, "D183零落库")
    pl = await _create_plan(client, hb, pid, "只读")
    await _seed_subject(session, pid, row_id="nw-sub")
    await _seed_link(session, pid, pl["id"], row_id="nw-l1", subject_id="nw-sub")
    await _seed_run(session, pid, "nw-sub", "passed")
    before = {t: await _count(conn, t) for t in ("plan_record", "plan_case_link", "run_record")}
    for _ in range(3):  # 读三次（幂等性：读面读几次都不动库，也不该动）
        r = await _status(client, hb, pid, pl["id"])
        assert r.status_code == 200
    after = {t: await _count(conn, t) for t in before}
    assert before == after, "GET 状态写了库（§二 1：状态不落库）：" + str((before, after))

    from sqlalchemy import inspect

    def _cols(sync_conn) -> set[str]:
        return {c["name"] for c in inspect(sync_conn).get_columns("plan_record")}

    cols = await conn.run_sync(_cols)
    assert cols == {"id", "project_id", "name", "description", "archived", "created_by",
                    "updated_by", "created_at", "updated_at"}, \
        "plan_record 长列了——展示态不许有持久列：" + str(sorted(cols))

    files = sorted(_MODULE_DIR.glob("*.py"))
    assert files, "扫描目录错了：" + str(_MODULE_DIR)
    import ast

    for f in files:
        tree = ast.parse(f.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            used = None
            if isinstance(node, ast.Attribute) and node.attr in ("started_at", "finished_at"):
                used = node.attr
            elif isinstance(node, ast.keyword) and node.arg in ("started_at", "finished_at"):
                used = node.arg
            assert used is None, \
                f.name + " 取了 run_record 的时间列 " + used + "（精度 0，判不了序——步 3 判断 1 走 (b)）。" \
                "扫 AST 不扫子串：判断的口径本身写在 docstring 里，提名字不等于碰列。"


# ══════════ 10. 反射列对真库核验 ══════════

async def test_reflected_run_columns_exist_in_db(conn) -> None:
    """RUN_RECORD 反射的五个列名逐个对 information_schema 验在场。

    反射表写错列名 = 在真库上跑一条炸一条 SQL（步 2 实测 api_case/adb_case 根本没有
    env_id 的教训：模型声明和印象都不可信，真库是唯一证人）。
    """
    from sqlalchemy import inspect

    from app.modules.testplan.services import RUN_RECORD

    def _run_cols(sync_conn) -> set[str]:
        return {c["name"] for c in inspect(sync_conn).get_columns("run_record")}

    cols = await conn.run_sync(_run_cols)
    for c in RUN_RECORD.columns:
        assert c.name in cols, "反射了库里不存在的列 run_record." + c.name
    # 反向也钉：反射刻意**不带**时间列（带了就有人写 ORDER BY——判断 1）
    assert not ({"started_at", "finished_at"} & {c.name for c in RUN_RECORD.columns})
