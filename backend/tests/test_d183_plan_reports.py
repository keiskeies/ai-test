"""D183 步 4 判据刀：plan_report + plan_report_item（生成 = 一次性快照；计划 §五 步 4 / §六 1·2·3·6·8）。

钉的契约（一条判断一条用例，命名即判据；步 4 四条服务侧判断逐条有靶）：

1. **表形状 = 迁移形状 + 反面清单**（test_report_shape...）：两张表列集逐列钉死；
   反面清单点名 `pass_threshold`（§四 那句落不了地——源列不存在，凭空造 = 判据 1）、
   `run_id/last_run_id/last_exec_report_id`（run 同秒无全序 + MS 那个指针永远为空——
   定义不出「选哪条」的指针不建）、`test_plan*` 表名（license 边界）。uq + 索引在场。
2. **§三 3 的环闭合：明细里的结果是生成路径写进去的，不是默认值**（written_by_generation...）：
   造 passed/failed/没跑/running 四种处境，生成后逐列比对生成路径该算出的值——
   result=failed ≠ 库默认 none、executed=True ≠ 默认 False、头行 total=4 ≠ 默认 0。
   「先把头插进去、结果以后接」的 MS 形状在这条当场红（变异 M-结果恒默认值 也红在这）。
3. **快照逐字节（判据 2 的写死形状）**（snapshot_is_byte_identical...）：
   生成 → 读 → 改用例名 + 改关联环境 + 再执行 N 次（passed/failed/running 各造）+
   归档计划 → 再读——**两次 HTTP body 逐字节相等**（比的是 r1.text == r2.text，
   不是「数字大致没变」）。读取路径若改成现算，这一条必须红（变异专刀）。
4. **报告数字不随后续执行变动（判据 3 的后半，和第 3 条是两件事）**（numbers_do_not_move...）：
   生成后把「没跑」那条跑出 passed——实时状态从 0.5 跳到 1.0，**报告纹丝不动 0.5**。
5. **口径与步 3 逐字相同（判据 3 的前半）**（rates_match_step3...）：同一份种子下
   报告头的七个数与 GET status 逐字段相等；未执行拉低通过率（pass_rate 恰好 0.5 的
   分母指纹）；空计划两率 0.0 不是 1.0；report.status = _plan_display 的定格。
6. **大声失败（判据 6，MS 吞异常的反面）**（fails_loudly...）：把生成中段的聚合打桩成
   必然抛错 → 500 可见失败 + **两张表零行落库**（无半成品）+ 审计 ok=False 留痕。
7. **级联两条链（照 §四 物理删 + 步 2 判断 3 同纪律）**（cascade...）：删计划带走报告与
   明细、别的计划逐根点名没动、MEMBER 403 不落库；**摘挂单条关联不动已生成报告**
   （证据链：link 没了，报告明细照读——MS「删了关联报告仍自证」同款）。
8. **位的真守护（第六十轮 §二：矩阵证不了位名）**（gates...）：report:read 用自建角色
   （限在 env:config:read 上，让位名在 details.perm 自己报出来）、report:create 用
   READONLY、report:delete 用 MEMBER 的 -*:delete；每个新位都有真实拒绝。静态钉：
   四个注册服务位名逐个钉 + 「报告面没有 :manage、也没有 :update」（本刀没有任何
   update 服务——位不凭空注册，判据 1 用在权限位上）。
9. **页码判据（D47-b 全套，plan_list/plan_link_list 同尺）**（page...）：行键恰好十六键
   且**没有 items**（列表不为每行明细付查询）、绝对期望序 + 种子区分度自证、
   total 恒全集（隔壁计划的报告不许混进来）、越界页空 items、422、计划不存在 404。
10. **跨项目与不存在逐字同 404**（cross_project...）+ 同项目成员读得到别人的报告
    （正向断言，守「没有行级私有」）。
11. **时间戳即「没人动过这行」的证人**（immutability...）：两张表逐行 updated_at ≡ created_at
    （行不可变的库侧钉；诚实条款见模型 docstring——若业主判这列多余，删列与此断言同提交）。
12. **明细读路径的 project_id 谓词**（reads_only_own_project_items）：毒行（同 report_id、
    异 project_id）直插，详情 payload 必须读不到它、且它在库里原样在场（谓词是**排除**
    不是删除）——report_id 是 uuid「撞不上」是运气不是设计，判据 1 的「谁读」要有现行犯。

**为什么部分行直插 ORM**（步 1/2/3 同款取舍）：run_record 不是本刀的写入方（本刀只读它），
四种 run 处境只能直插；计划/关联/报告生成全走真 HTTP。每用例 conftest 已 TRUNCATE 全表。
"""
from __future__ import annotations

import json

from app.modules.api_test.models import ApiCase
from app.modules.execution.models import RunRecord
from app.modules.testplan.models import PlanCaseLink, PlanReport, PlanReportItem

_BASE = "/api/v1"


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


async def _seed_subject(session, pid: str, *, row_id: str, name: str = "用例") -> None:
    session.add(ApiCase(id=row_id, project_id=pid, definition_id="seed-def", name=name))
    await session.commit()


async def _seed_link(session, pid: str, plan_id: str, *, row_id: str, subject_id: str,
                     env_id: str | None = None) -> None:
    session.add(PlanCaseLink(id=row_id, project_id=pid, plan_id=plan_id, subject_type="api_case",
                             subject_id=subject_id, subject_name="名" + subject_id, env_id=env_id))
    await session.commit()


async def _seed_run(session, pid: str, subject_id: str, status: str) -> None:
    session.add(RunRecord(project_id=pid, subject_type="api_case", subject_id=subject_id,
                          subject_name="r", trigger="manual", status=status))
    await session.commit()


async def _gen(client, h, pid: str, plan_id: str, name: str | None = None):
    body: dict = {"project_id": pid}
    if name is not None:
        body["name"] = name
    return await client.post(_BASE + f"/plans/{plan_id}/reports", json=body, headers=h)


async def _get(client, h, pid: str, report_id: str):
    return await client.get(_BASE + f"/plan-reports/{report_id}", params={"project_id": pid}, headers=h)


async def _status(client, h, pid: str, plan_id: str):
    return await client.get(_BASE + f"/plans/{plan_id}/status", params={"project_id": pid}, headers=h)


async def _db_scalar(sql: str, **params):
    """从**另一条连接**读已提交状态——不碰 conn/session 夹具共用的那条连接。

    为什么必须另开连接（本轮实测踩出的夹具相互作用，值得留字）：conftest 把 get_db 覆盖到
    绑在 conn 上的 session，HTTP 与测试代码共用同一条 MySQL 连接。GET 类端点没有 commit/
    rollback 路径（core/service.py 的 GET 分支），一次 GET 就在连接上留下一个悬挂的只读事务；
    此后测试若在同一条连接上 execute/commit，要么把自己的 SELECT 挂进 HTTP 的在飞事务
    （下一次 4xx/500 的 db.rollback() 把**测试刚看到的写**一起抹掉——201 回执照样返回），
    要么把 session 正引用的 RootTransaction 提前关死（「This transaction is inactive」）。
    步 2/3 的用例只是侥幸没撞上这个三角。判据要的本来就是「库里（其他连接可见的）状态」，
    另开连接读恰好是**口径最正确**的读法，还顺手刀掉了整片雷区。
    """
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from app.core.config import get_settings

    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    try:
        async with eng.connect() as c:
            return (await c.execute(text(sql), params)).scalar_one()
    finally:
        await eng.dispose()


async def _db_all(sql: str, **params) -> list[tuple]:
    """另开连接取多行（_db_scalar 的姊妹，理由同款）。"""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from app.core.config import get_settings

    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    try:
        async with eng.connect() as c:
            return list((await c.execute(text(sql), params)).all())
    finally:
        await eng.dispose()


async def _count(tbl: str, where: str, **params) -> int:
    return int(await _db_scalar("SELECT COUNT(*) FROM " + tbl + " WHERE " + where, **params))


# 头 + 明细共用的四个汇总键（报告与实时态逐字段比的就是它们 + 两个率）
_HEAD_SCALARS = ("total", "passed", "failed", "executed", "executing", "not_executed",
                 "pass_rate", "execute_rate")


# ══════════ 1. 表形状（迁移真跑出来的形状 + 反面清单） ══════════

async def test_report_shape_is_exactly_the_migration(conn) -> None:
    """两张表列集逐列钉死；反面清单点名「阈值/指针」两族列与 MS 表名都不许在。"""
    from sqlalchemy import inspect

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "head": {c["name"] for c in insp.get_columns("plan_report")},
            "item": {c["name"] for c in insp.get_columns("plan_report_item")},
            "idx": {i["name"] for i in insp.get_indexes("plan_report_item")},
            "uq": {(u["name"], tuple(sorted(u["column_names"])))
                   for u in insp.get_unique_constraints("plan_report_item")},
        }

    got = await conn.run_sync(_read)
    assert {"plan_report", "plan_report_item"} <= got["tables"], "迁移没建表（alembic 没跑到 0026）"
    assert got["head"] == {"id", "project_id", "plan_id", "name", "status", "total", "passed",
                           "failed", "executed", "executing", "created_by", "created_at", "updated_at"}, \
        "报告头列集变了 = 有人加了没写方/没读方的列（§六 1）：" + str(sorted(got["head"]))
    assert got["item"] == {"id", "project_id", "report_id", "link_id", "subject_type", "subject_id",
                           "subject_name", "env_id", "executed", "executing", "result",
                           "created_at", "updated_at"}, \
        "报告明细列集变了：" + str(sorted(got["item"]))
    # 反面清单（两族都对应计划里骂过的形状）：
    # - pass_threshold：§四 表格那句「抄阈值」落不了地——plan_record 没有可抄的源列，
    #   凭空造 = 有 schema 没写入方（判据 1）；要阈值先加源列（另一刀）。
    # - run_id/last_run_id/last_exec_report_id：run 同秒无全序（步 3 判断 1）+ MS 那个
    #   指针字段在开源仓永远为空（取证 §6.2）——照抄 = 抄一个说谎的指针。
    bad = {"pass_threshold", "run_id", "last_run_id", "last_exec_report_id",
           "last_result", "owner_id", "project_public"}
    assert not (bad & got["head"]) and not (bad & got["item"]), \
        "阈值/指针/摘要列冒出来了（§四 偏差条款 / §三 2 / 取证 §6.2）：" + str(sorted(bad & (got["head"] | got["item"])))
    # 存的是结论与计数，不是率——率是两份会各自漂移的真相
    assert not ({"pass_rate", "execute_rate"} & got["head"]), \
        "率进了存储列：读路径与写路径各算一份 = 会漂移的数（口径只在 _rates 一个函数）"
    assert not [t for t in got["tables"] if t.startswith("test_plan")], \
        "MS 的活表名进来了（license 边界）"
    assert ("uq_plan_report_item_report_link", ("link_id", "report_id")) in got["uq"], \
        "一份报告里同一条关联没有唯一键兜底（分母重复计数）"
    for i in ("ix_plan_report_item_report_id", "ix_plan_report_item_link_id",
              "ix_plan_report_item_subject_id", "ix_plan_report_item_project_id"):
        assert i in got["idx"], "缺索引 " + i


# ══════════ 2. §三 3 的环闭合：结果由生成路径写入，不是默认值（判据 1 正面清单） ══════════

async def test_report_values_written_by_generation_path(client, session, make_user) -> None:
    """四种 run 处境（passed / failed / 没跑 / running）各一条关联，生成后逐列比对。

    判据 1 的正面清单：每一列的值都是「生成路径算出来的那个」，而不是库默认——
    result=failed ≠ 默认 none、executed=True ≠ 默认 False、total=4 ≠ 默认 0。
    「先插头、结果以后接」（MS 取证 §6.3 的形状）在这一条当场红；把写入方改成恒写
    默认值的变异也红在这一条。name 两态各有断言（给了用给的、没给抄计划名）。
    """
    boss, hb = await make_user("d183s4w", admin=True)
    pid = await _proj(client, hb, "D183报告写入")
    pl = await _create_plan(client, hb, pid, "四种处境")
    seed = {"s4-a": ("s4-sub-a", ("passed",)), "s4-b": ("s4-sub-b", ("failed",)),
            "s4-c": ("s4-sub-c", ()), "s4-d": ("s4-sub-d", ("running",))}
    for lid, (subj, states) in seed.items():
        await _seed_subject(session, pid, row_id=subj)
        await _seed_link(session, pid, pl["id"], row_id=lid, subject_id=subj)
        for st in states:
            await _seed_run(session, pid, subj, st)

    r = await _gen(client, hb, pid, pl["id"])
    assert r.status_code == 201, r.text
    b = r.json()
    assert set(b) == {"id", "project_id", "plan_id", "name", "status", "total", "passed", "failed",
                      "executed", "executing", "not_executed", "pass_rate", "execute_rate",
                      "created_by", "created_at", "updated_at", "items"}, \
        "报告详情键恰好这十七键：" + str(sorted(b))
    assert set(b["items"][0]) == {"id", "report_id", "link_id", "subject_type", "subject_id",
                                  "subject_name", "env_id", "executed", "executing", "result",
                                  "created_at", "updated_at"}, \
        "明细行键恰好十二键：" + str(sorted(b["items"][0]))
    # 头：每列 = 生成路径写的值（默认值全对不上号）
    assert b["plan_id"] == pl["id"] and b["project_id"] == pid and b["created_by"] == boss.id
    assert b["name"] == "四种处境 报告", "没给名字就该抄计划名（写入方 = 生成服务）"
    assert (b["total"], b["passed"], b["failed"], b["executed"], b["executing"]) == (4, 1, 1, 2, 1), \
        "头计数不是生成路径算出来的（默认 0 或算错）：" + str(b)
    assert b["status"] == "in_progress" and b["not_executed"] == 2
    # 明细：逐链接的结论三连都是算出来的
    by = {x["link_id"]: x for x in b["items"]}
    assert [x["link_id"] for x in b["items"]] == ["s4-a", "s4-b", "s4-c", "s4-d"], \
        "明细绝对期望序 = link id 升序（生成顺序不背锅）"
    assert (by["s4-a"]["executed"], by["s4-a"]["executing"], by["s4-a"]["result"]) == (True, False, "passed")
    assert (by["s4-b"]["executed"], by["s4-b"]["executing"], by["s4-b"]["result"]) == (True, False, "failed"), \
        "failed 抄成默认值 none = §三 3 那个环没闭合（MS 的『置 null 以后接』）"
    assert (by["s4-c"]["executed"], by["s4-c"]["executing"], by["s4-c"]["result"]) == (False, False, "none")
    assert (by["s4-d"]["executed"], by["s4-d"]["executing"], by["s4-d"]["result"]) == (False, True, "none"), \
        "queued/running 进结论或算已执行 = 词表与步 3 分叉"
    assert by["s4-b"]["subject_name"] == "名s4-sub-b" and by["s4-b"]["subject_type"] == "api_case"
    assert all(x["report_id"] == b["id"] and x["created_at"] and x["updated_at"] for x in b["items"])
    # 给了名字就用给的
    r2 = await _gen(client, hb, pid, pl["id"], name="自定义名")
    assert r2.status_code == 201 and r2.json()["name"] == "自定义名"
    # 明细 id 序 = id 升序且与生成序无关（两报告互不串）
    assert {x["report_id"] for x in r2.json()["items"]} == {r2.json()["id"]}


# ══════════ 3. 快照逐字节（判据 2 写死的断言形状） ══════════

async def test_snapshot_payload_is_byte_identical_after_everything(client, session, make_user) -> None:
    """生成 → 读 → **改用例 + 再执行 N 次 + 归档计划** → 再读：两次 HTTP body 逐字节相等。

    业主写死的形状：不是「数字大致没变」，是整个 payload 前后两次读相等。破坏动作全做一遍：
    改用例名、改关联环境、补跑 passed/failed/running、归档计划。报告读取路径只要有任何
    一处现算（join run_record / join 关联行 / 现算 status），body 就会漂一个字节，这条红。
    生成第二份报告则**必须**反映新世界——「快照」与「缓存刷新」的分界也顺手钉住了。
    """
    boss, hb = await make_user("d183s4s", admin=True)
    pid = await _proj(client, hb, "D183快照")
    pl = await _create_plan(client, hb, pid, "快照计划")
    await _seed_subject(session, pid, row_id="sn-sub-a", name="原名")
    await _seed_subject(session, pid, row_id="sn-sub-b", name="另一原名")
    await _seed_link(session, pid, pl["id"], row_id="sn-la", subject_id="sn-sub-a")
    await _seed_link(session, pid, pl["id"], row_id="sn-lb", subject_id="sn-sub-b")
    await _seed_run(session, pid, "sn-sub-a", "passed")

    gen = await _gen(client, hb, pid, pl["id"])
    assert gen.status_code == 201, gen.text
    rid = gen.json()["id"]
    r1 = await _get(client, hb, pid, rid)
    assert r1.status_code == 200

    # ── 破坏动作 ──
    row = await session.get(ApiCase, "sn-sub-a")
    assert row is not None
    row.name = "改过的名"          # 改用例
    await session.commit()
    lk = await session.get(PlanCaseLink, "sn-lb")
    assert lk is not None
    lk.env_id = "env-changed"      # 改关联环境
    await session.commit()
    await _seed_run(session, pid, "sn-sub-b", "passed")   # 再执行 N 次
    await _seed_run(session, pid, "sn-sub-b", "failed")
    await _seed_run(session, pid, "sn-sub-a", "error")
    await _seed_run(session, pid, "sn-sub-a", "running")
    ar = await client.post(_BASE + f"/plans/{pl['id']}/archive", json={"project_id": pid}, headers=hb)
    assert ar.status_code == 200

    r2 = await _get(client, hb, pid, rid)
    assert r2.status_code == 200
    assert r1.content == r2.content, \
        "生成后改用例/再执行/归档，报告 payload 动了——快照不是快照（判据 2）。差异（格式化对照）：\n" \
        "  before=" + json.dumps(r1.json(), ensure_ascii=False, sort_keys=True) + \
        "\n  after =" + json.dumps(r2.json(), ensure_ascii=False, sort_keys=True)
    # 新世界如实反映在实时态里（证明上面的「不动」不是「什么都没发生」的假证据）
    now = (await _status(client, hb, pid, pl["id"])).json()
    # 破坏后的新世界：a = passed+error（混合终态 → 保守 failed）、b = passed+failed → failed
    assert now["status"] == "archived" and now["executed"] == 2 and now["failed"] == 2
    # 此刻新生成的第二份报告必须抄到新数字（与第一份不等）——快照边界 = 生成那一刻。
    # subject_name 抄的是**关联行的快照名**（步 2 的形状：plan_link_create 写一次，改名
    # 不追关联行），不是用例活名——plan_link_list / plan_status / 报告明细三处同源，
    # 「报告与实时态一致」这条不变量比「抄活名」更值钱（口径：报告与状态显示同一个名字）。
    g2 = await _gen(client, hb, pid, pl["id"], name="后来的")
    assert g2.status_code == 201
    assert g2.json()["items"][0]["subject_name"] == "名sn-sub-a", \
        "明细名改源了：报告名 = 关联行快照名（与 plan_link_list/plan_status 同源）"
    assert g2.json()["status"] == "archived" and g2.json()["items"][1]["env_id"] == "env-changed"
    # 两条关联此刻都是混合终态（a = passed+error、b = passed+failed）→ 保守口径双双 failed
    # （步 3 判断 2 的口径在报告面同样成立——同一份 _link_result 算出来的，不意外）
    assert [x["result"] for x in g2.json()["items"]] == ["failed", "failed"]
    # 新报告与第一份的结论分布确实不同（证明「逐字节相等」不是「永远生成同一份」的假绿）
    assert (g2.json()["passed"], g2.json()["failed"]) == (0, 2)
    assert (r1.json()["passed"], r1.json()["failed"]) == (1, 0)


# ══════════ 4. 报告数字不随后续执行变动（判据 3 后半，与判据 2 是两件事） ══════════

async def test_report_numbers_do_not_move_when_executions_continue(client, session, make_user) -> None:
    """生成后把「没跑」那条跑出 passed：实时态 0.5→1.0，**报告恒 0.5**。

    判据 2 钉的是「payload 不动」，这条钉的是「报告里的数字与实时口径**分道扬镳**」——
    它同时反过来证明报告不是 status 端点的别名（若读取路径现算，两边会一起跳到 1.0）。
    """
    boss, hb = await make_user("d183s4n", admin=True)
    pid = await _proj(client, hb, "D183数字不动")
    pl = await _create_plan(client, hb, pid, "一半一半")
    await _seed_subject(session, pid, row_id="nm-sub-a")
    await _seed_subject(session, pid, row_id="nm-sub-b")
    await _seed_link(session, pid, pl["id"], row_id="nm-la", subject_id="nm-sub-a")
    await _seed_link(session, pid, pl["id"], row_id="nm-lb", subject_id="nm-sub-b")
    await _seed_run(session, pid, "nm-sub-a", "passed")
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]

    b0 = (await _get(client, hb, pid, rid)).json()
    s0 = (await _status(client, hb, pid, pl["id"])).json()
    assert b0["pass_rate"] == 0.5 == s0["pass_rate"], "前置：生成时刻两边同 0.5"

    await _seed_run(session, pid, "nm-sub-b", "passed")

    s1 = (await _status(client, hb, pid, pl["id"])).json()
    b1 = (await _get(client, hb, pid, rid)).json()
    assert (s1["pass_rate"], s1["executed"], s1["status"]) == (1.0, 2, "completed"), \
        "前置：实时态必须确实动了，否则『报告没动』是假证据"
    assert (b1["pass_rate"], b1["execute_rate"], b1["executed"], b1["not_executed"],
            b1["status"]) == (0.5, 0.5, 1, 1, "in_progress"), \
        "后续执行把报告数字带跑了（判据 3 后半：报告存的是生成时刻的副本）：" + str(b1)


# ══════════ 5. 口径与步 3 逐字相同（判据 3 前半） ══════════

async def test_report_head_matches_step3_status_field_by_field(client, session, make_user) -> None:
    """同一份种子：报告头八个数与 GET status 逐字段相等 + 未执行拉低 + 空计划 0.0。

    「逐字相同」的用例形态 = 两份 payload 的对应字段直接比相等（同一份 _aggregate_links
    / _rates / _plan_display 算出来的东西必然相等，比的是接口面，不是内部函数）。
    """
    boss, hb = await make_user("d183s4r", admin=True)
    pid = await _proj(client, hb, "D183口径")
    pl = await _create_plan(client, hb, pid, "口径对照")
    # 空计划先各生成一份：0.0 不是 1.0 的指纹在报告面同样钉一次
    empty_rid = (await _gen(client, hb, pid, pl["id"], name="空报告")).json()["id"]
    eb = (await _get(client, hb, pid, empty_rid)).json()
    assert (eb["pass_rate"], eb["execute_rate"], eb["status"], eb["items"]) == (0.0, 0.0, "not_started", []), \
        "空报告 1.0/completed = 空真在界面上说谎（步 3 同款口径没接过来）"

    # 3 条关联：1 passed + 1 没跑 + 1 running → pass_rate 恰好 1/3（分母 = 总数，不是已执行）
    await _seed_subject(session, pid, row_id="rt-sub-a")
    await _seed_subject(session, pid, row_id="rt-sub-b")
    await _seed_subject(session, pid, row_id="rt-sub-c")
    await _seed_link(session, pid, pl["id"], row_id="rt-la", subject_id="rt-sub-a")
    await _seed_link(session, pid, pl["id"], row_id="rt-lb", subject_id="rt-sub-b")
    await _seed_link(session, pid, pl["id"], row_id="rt-lc", subject_id="rt-sub-c")
    await _seed_run(session, pid, "rt-sub-a", "passed")
    await _seed_run(session, pid, "rt-sub-c", "running")

    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]
    rb = (await _get(client, hb, pid, rid)).json()
    sb = (await _status(client, hb, pid, pl["id"])).json()
    for k in _HEAD_SCALARS:
        assert rb[k] == sb[k], f"报告与实时态的 {k} 不等（{rb[k]} vs {sb[k]}）——口径分叉"
    assert rb["status"] == sb["status"] == "in_progress"
    # 分母指纹：3 条里 1 条过 = 1/3；按「已执行 2」算会给 0.5——两个都不是 1.0 才是诚实的
    assert rb["pass_rate"] == sb["pass_rate"] == 1 / 3, \
        "未执行/执行中没拉低通过率（分母不是用例总数）：" + str(rb["pass_rate"])
    assert rb["execute_rate"] == sb["execute_rate"] == 1 / 3
    assert rb["not_executed"] == 2, "running 被算成已执行 = 执行率会提前到顶"


# ══════════ 6. 大声失败 + 零半成品（判据 6） ══════════

async def test_report_create_fails_loudly_and_leaves_nothing(client, session, make_user,
                                                             monkeypatch) -> None:
    """把生成中段的聚合打桩成必然抛错 → 500 可见失败 + 两张表**零行** + 审计 ok=False 留痕。

    MS 的反例（取证 §6.10）：报告生成整个包在 try-catch 里吞异常只打日志。我们的反面：
    不吞 → 调用方看到 5xx；不半截 → 头行与明细**一次 commit**，异常路径由路由投影层
    统一 rollback（core/service.py:361-367），库里连一条头行都没有。
    打桩点选 _aggregate_links：它在「计划门已过后、落库前」，抛在这里最接近
    「生成进行到一半炸了」的真实形状（门前的 4xx 测不到半截问题）。
    """
    from app.modules.testplan import services

    boss, hb = await make_user("d183s4f", admin=True)
    pid = await _proj(client, hb, "D183大声失败")
    pl = await _create_plan(client, hb, pid, "炸在生成中")
    await _seed_subject(session, pid, row_id="fl-sub")
    await _seed_link(session, pid, pl["id"], row_id="fl-l1", subject_id="fl-sub")

    async def _boom(db, project_id: str, plan_id: str):  # noqa: ARG001
        raise RuntimeError("模拟生成中段炸掉（用例打桩）")

    monkeypatch.setattr(services, "_aggregate_links", _boom)
    r = await _gen(client, hb, pid, pl["id"])
    monkeypatch.undo()
    assert r.status_code == 500, "生成失败被吞成 2xx = MS 的静默形状（判据 6）：" + str(r.status_code)
    assert r.json()["code"] == "internal"
    assert await _count("plan_report", "plan_id=:p", p=pl["id"]) == 0, \
        "失败留下了报告头 = 半成品（一次 commit 的边界没守住）"
    assert await _count("plan_report_item", "project_id=:p", p=pid) == 0, \
        "失败留下了明细行 = 半成品"
    # 打桩撤掉后同一路请求能正常成功（证明 500 是那次炸的、不是路由坏了）
    ok = await _gen(client, hb, pid, pl["id"])
    assert ok.status_code == 201 and ok.json()["total"] == 1
    a = await client.get(_BASE + "/audit", params={"project_id": pid, "size": 50}, headers=hb)
    acts = [(x["action"], x["ok"]) for x in a.json()["items"]]
    assert ("plan_report_create", False) in acts, "失败没留审计 = 拒绝/失败不可见：" + str(acts)


# ══════════ 7. 级联两条链 + 证据链（摘挂不动报告） ══════════

async def test_plan_delete_cascades_reports_and_items_only_for_itself(client, session, make_user) -> None:
    """删计划带走「报告头 + 明细」，别的计划逐根点名没动；MEMBER 403 不落库。

    形状与 test_plan_delete_cascades_links_by_plan_id_only 同款（步 2 判断 3）：
    全表删也能让「本计划的报告没了」变绿——所以隔壁计划（同项目）与别项目计划的
    报告/明细必须**逐根**还在。
    """
    boss, hb = await make_user("d183s4c", admin=True)
    pid = await _proj(client, hb, "D183报告级联")
    p2 = await _proj(client, hb, "D183报告级联隔壁")
    victim = await _create_plan(client, hb, pid, "连报告一起删")
    neighbor = await _create_plan(client, hb, pid, "幸存计划")
    foreign = await _create_plan(client, hb, p2, "别项目计划")
    for tag, plan, npid, n in (("vic", victim, pid, 2), ("nei", neighbor, pid, 1), ("fgn", foreign, p2, 1)):
        for i in range(n):
            sid = f"{tag}-sub-{i}"
            await _seed_subject(session, npid, row_id=sid)
            await _seed_link(session, npid, plan["id"], row_id=f"{tag}-l{i}", subject_id=sid)
        rid = (await _gen(client, hb, npid, plan["id"])).json()["id"]
        assert await _count("plan_report_item", "report_id=:r", r=rid) == n, "种子没铺够，本例白测"
    vic_items = int(await _db_scalar(
        "SELECT COUNT(*) FROM plan_report_item i JOIN plan_report r ON i.report_id=r.id "
        "WHERE r.plan_id=:p", p=victim["id"]))
    assert vic_items == 2, "种子没铺够，本例白测"

    mem, hm = await make_user("d183s4cm")
    await _member(client, hb, pid, mem.id, "MEMBER")
    den = await client.request("DELETE", _BASE + f"/plans/{victim['id']}", json={"project_id": pid}, headers=hm)
    assert den.status_code == 403, "前置：MEMBER 必须被挡，否则级联抢跑测不到"
    assert await _count("plan_report", "plan_id=:p", p=victim["id"]) == 1, "403 的删除把报告先删了"

    dl = await client.request("DELETE", _BASE + f"/plans/{victim['id']}", json={"project_id": pid}, headers=hb)
    assert dl.status_code == 200 and dl.json() == {"ok": True}
    assert await _count("plan_report", "plan_id=:p", p=victim["id"]) == 0
    orphans = int(await _db_scalar(
        "SELECT COUNT(*) FROM plan_report_item i LEFT JOIN plan_report r ON i.report_id=r.id "
        "WHERE r.id IS NULL"))
    assert orphans == 0, "删计划留下了孤儿报告明细（级联第二刀没落）"
    for plan, want in ((neighbor, 1), (foreign, 1)):
        assert await _count("plan_report", "plan_id=:p", p=plan["id"]) == want, \
            "级联删多了行（只许按本计划的 plan_id 删）"


async def test_unlinking_and_report_delete_keep_evidence_chain(client, session, make_user) -> None:
    """摘挂单条关联 → 已生成报告逐字节不变（证据链：link 没了明细照读）；
    删报告 → 只带走自己的明细，隔壁报告的明细一根毫毛没动；MEMBER 删报告 403 不落库。"""
    boss, hb = await make_user("d183s4e", admin=True)
    pid = await _proj(client, hb, "D183证据链")
    pa = await _create_plan(client, hb, pid, "甲")
    pb = await _create_plan(client, hb, pid, "乙")
    await _seed_subject(session, pid, row_id="ev-sub-a")
    await _seed_subject(session, pid, row_id="ev-sub-b")
    await _seed_link(session, pid, pa["id"], row_id="ev-la", subject_id="ev-sub-a")
    await _seed_link(session, pid, pa["id"], row_id="ev-lb", subject_id="ev-sub-b")
    await _seed_link(session, pid, pb["id"], row_id="ev-lc", subject_id="ev-sub-a")
    ra = (await _gen(client, hb, pid, pa["id"])).json()["id"]
    rb = (await _gen(client, hb, pid, pb["id"])).json()["id"]
    before = (await _get(client, hb, pid, ra)).content

    # 摘挂：走真 link_delete，报告 payload 必须逐字节不动
    dl = await client.request("DELETE", _BASE + f"/plans/{pa['id']}/case-links/ev-lb",
                              json={"project_id": pid}, headers=hb)
    assert dl.status_code == 200
    after = (await _get(client, hb, pid, ra)).content
    assert before == after, "摘挂改了已生成的报告——证据链断了（报告要能自证当时的结论）"
    # 被摘的 link_id 在明细里仍可读（悬空引用合法，快照副本自证）
    assert await _count("plan_report_item", "link_id=:l", l="ev-lb") == 1

    mem, hm = await make_user("d183s4em")
    await _member(client, hb, pid, mem.id, "MEMBER")
    den = await client.request("DELETE", _BASE + f"/plan-reports/{ra}", json={"project_id": pid}, headers=hm)
    assert den.status_code == 403 and den.json()["details"]["perm"] == "testplan:report:delete"
    assert await _count("plan_report", "id=:r", r=ra) == 1, "403 的删除落库了"

    ok = await client.request("DELETE", _BASE + f"/plan-reports/{ra}", json={"project_id": pid}, headers=hb)
    assert ok.status_code == 200
    assert await _count("plan_report", "id=:r", r=ra) == 0
    assert await _count("plan_report_item", "report_id=:r", r=ra) == 0, "删报告没带走自己的明细"
    assert await _count("plan_report_item", "report_id=:r", r=rb) == 1, \
        "删报告删多了（只许按 report_id 删）——隔壁报告的明细被牵连"


# ══════════ 8. 位的真守护（每个新位都有真实拒绝） ══════════

async def test_report_perm_gates_deny_real_roles(client, session, make_user) -> None:
    """report:read 用自建角色（限在别的位上，让 details.perm 自己报出这一位——矩阵证不了
    位名，第六十轮 §二）；report:create 用 READONLY；report:delete 用 MEMBER 的 -*:delete。
    放行面同时钉：READONLY 读得到列表/详情、MEMBER 生成得成。拒绝一律不落库。"""
    boss, hb = await make_user("d183s4g", admin=True)
    pid = await _proj(client, hb, "D183报告门禁")
    pl = await _create_plan(client, hb, pid, "门禁计划")
    await _seed_subject(session, pid, row_id="gp-sub")
    await _seed_link(session, pid, pl["id"], row_id="gp-l1", subject_id="gp-sub")
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]

    ro, hr = await make_user("d183s4gro")
    await _member(client, hb, pid, ro.id, "READONLY")
    g = await _get(client, hr, pid, rid)
    assert g.status_code == 200 and g.json()["id"] == rid, "READONLY 该读得到报告（:read 命中）"
    c = await _gen(client, hr, pid, pl["id"])
    assert c.status_code == 403 and c.json()["details"]["perm"] == "testplan:report:create"
    assert await _count("plan_report", "plan_id=:p", p=pl["id"]) == 1, "被拒的生成落库了（库里只该有 boss 那一份）"

    mem, hm = await make_user("d183s4gme")
    await _member(client, hb, pid, mem.id, "MEMBER")
    mc = await _gen(client, hm, pid, pl["id"], name="成员生成的")
    assert mc.status_code == 201, "MEMBER 该拿得到 report:create（非删除非管理）"
    assert await _count("plan_report", "plan_id=:p", p=pl["id"]) == 2
    md = await client.request("DELETE", _BASE + f"/plan-reports/{mc.json()['id']}",
                              json={"project_id": pid}, headers=hm)
    assert md.status_code == 403 and md.json()["details"]["perm"] == "testplan:report:delete", \
        "MEMBER 的 -*:delete 没拦住 report:delete"
    assert await _count("plan_report", "plan_id=:p", p=pl["id"]) == 2, "被拒的删除落库了"
    assert (await _get(client, hb, pid, mc.json()["id"])).status_code == 200

    rr = await client.post(_BASE + "/custom-roles",
                           json={"project_id": pid, "name": "只读环境-r4", "template_code": "READONLY"},
                           headers=hb)
    assert rr.status_code in (200, 201), rr.text
    code = rr.json()["code"]
    pr = await client.patch(_BASE + "/custom-roles/" + code,
                            json={"project_id": pid, "perms": ["env:config:read"]}, headers=hb)
    assert pr.status_code == 200, pr.text
    cu, hc = await make_user("d183s4gcu")
    await _member(client, hb, pid, cu.id, code)
    d1 = await _get(client, hc, pid, rid)
    assert d1.status_code == 403 and d1.json()["code"] == "insufficient_permission"
    assert d1.json()["details"]["perm"] == "testplan:report:read", \
        "read 位被改名时这一条必须红（矩阵四格照绿，它才是守护）"
    d2 = await client.get(_BASE + f"/plans/{pl['id']}/reports", params={"project_id": pid}, headers=hc)
    assert d2.status_code == 403 and d2.json()["details"]["perm"] == "testplan:report:read"


def test_report_services_declare_exactly_four_bits_no_manage() -> None:
    """静态钉（镜像不是守护，诚实条款同 test_link_services_declare_no_manage_bit）：

    报告面只注册 read/create/delete/update 四位；没有 :manage（MEMBER 的 -*:manage 天然
    挡不住任何报告动作，所以**没有**任何报告门禁走 :manage——本刀没有归档类单向门）。
    :update 自 D210 起只服务**改名**（plan_report_rename，只写 name 一列，不碰内容快照）——
    这不是把「没有 update」改成「随便 update」，内容列仍没有列外写入方（D210 用例钉）。
    """
    from app.core.registry import REGISTRY

    for name, verb in (("plan_report_list", "read"), ("plan_report_get", "read"),
                       ("plan_report_create", "create"), ("plan_report_delete", "delete"),
                       ("plan_report_rename", "update")):
        spec = REGISTRY.get(name)
        assert spec is not None, "注册表没有 " + name
        assert spec.perm == "testplan:report:" + verb, name + " 的位不是 testplan:report:" + verb
    assert all("manage" not in REGISTRY.get(n).perm
               for n in ("plan_report_list", "plan_report_get", "plan_report_create",
                         "plan_report_delete", "plan_report_rename")), \
        "报告面长出了 :manage（报告没有单向门，D183 §五裁决）"


# ══════════ 9. 页码判据（D47-b 全套） ══════════

async def test_report_list_page_number_semantics(client, session, make_user) -> None:
    """行键恰好十六键且无 items / 绝对期望序（先自证区分度）/ total 恒全集 / 越界空页 /
    size·current 越界 422 / 计划不存在 404。隔壁计划的报告是 total 谓词的现行犯种子。"""
    boss, hb = await make_user("d183s4p", admin=True)
    pid = await _proj(client, hb, "D183报告页码")
    pl = await _create_plan(client, hb, pid, "页码计划")
    pl_other = await _create_plan(client, hb, pid, "页码隔壁")
    await _seed_subject(session, pid, row_id="rp-sub")
    await _seed_link(session, pid, pl["id"], row_id="rp-l1", subject_id="rp-sub")
    await _seed_link(session, pid, pl_other["id"], row_id="rp-l2", subject_id="rp-sub")
    seed_ids = ["rp-c", "rp-a", "rp-e", "rp-b", "rp-d"]
    assert sorted(seed_ids) != seed_ids, "种子没有区分度（插入序==id 序），排序断言是假的"
    for sid in seed_ids:  # 直插报告头（id 可控；生成服务写的是 uuid4，页码序断言要可控 id）
        session.add(PlanReport(id=sid, project_id=pid, plan_id=pl["id"], name="报" + sid,
                               status="not_started", total=0, passed=0, failed=0,
                               executed=0, executing=0))
    for sid in ("rp-x", "rp-y"):
        session.add(PlanReport(id=sid, project_id=pid, plan_id=pl_other["id"], name="隔" + sid,
                               status="not_started", total=0, passed=0, failed=0,
                               executed=0, executing=0))
    await session.commit()

    r = await client.get(_BASE + f"/plans/{pl['id']}/reports",
                         params={"project_id": pid, "current": 1, "size": 2}, headers=hb)
    assert r.status_code == 200, r.text
    b = r.json()
    assert set(b) == {"items", "next_cursor", "total"}
    assert b["next_cursor"] is None and b["total"] == 5, \
        "total 数了隔壁计划或只数本页：" + str(b["total"])
    assert [x["id"] for x in b["items"]] == ["rp-a", "rp-b"], "第一页不是 id 升序前两条"
    assert "items" not in b["items"][0] and len(b["items"][0]) == 16, \
        "列表行必须恰好十六键（头 + 派生数）且**不带 items**：" + str(sorted(b["items"][0]))
    walk: list[str] = []
    for cur in (1, 2, 3):
        bb = (await client.get(_BASE + f"/plans/{pl['id']}/reports",
                               params={"project_id": pid, "current": cur, "size": 2}, headers=hb)).json()
        assert bb["total"] == 5
        walk += [x["id"] for x in bb["items"]]
    assert walk == sorted(seed_ids), "页码走出的序必须逐位=id 升序：" + str(walk)
    past = (await client.get(_BASE + f"/plans/{pl['id']}/reports",
                             params={"project_id": pid, "current": 9, "size": 2}, headers=hb)).json()
    assert past["items"] == [] and past["total"] == 5
    s1 = await client.get(_BASE + f"/plans/{pl['id']}/reports",
                          params={"project_id": pid, "size": 201}, headers=hb)
    assert s1.status_code == 422
    nf = await client.get(_BASE + "/plans/查无此计划/reports", params={"project_id": pid}, headers=hb)
    assert nf.status_code == 404 and nf.json()["message"] == "计划不存在"


# ══════════ 10. 跨项目逐字同 404 + 同项目共享可读 ══════════

async def test_report_cross_project_verbatim_and_shared_readable(client, session, make_user) -> None:
    boss, hb = await make_user("d183s4x", admin=True)
    pid = await _proj(client, hb, "D183报告甲")
    p2 = await _proj(client, hb, "D183报告乙")
    pl = await _create_plan(client, hb, pid, "甲的报告")
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]
    other, ho = await make_user("d183s4xb", admin=True)
    absent = await _get(client, ho, p2, "查无此报告")
    invade = await _get(client, ho, p2, rid)
    assert absent.status_code == 404 and invade.status_code == 404
    assert invade.json()["code"] == absent.json()["code"] == "not_found"
    assert invade.json()["message"] == absent.json()["message"] == "报告不存在"
    assert set(invade.json()["details"]) == set(absent.json()["details"]) == {"report_id"}
    # 同项目成员读得到别人的报告（正向断言，守「没有行级私有」）
    mem, hm = await make_user("d183s4xm")
    await _member(client, hb, pid, mem.id, "MEMBER")
    g = await _get(client, hm, pid, rid)
    assert g.status_code == 200, "同项目成员读不到别人的报告 = 行级私有混进来"


# ══════════ 11. 时间戳即「没人动过这行」的证人（快照行不可变，库侧钉） ══════════

async def test_generated_rows_are_immutable_stamp(client, session, make_user) -> None:
    """两张新表的 updated_at 必须逐行 == created_at（行不可变 ⇒ 二者恒等）。

    PlanReport/PlanReportItem 的 docstring 里 updated_at 的诚实条款说：**未改名的行**没有
    第二个写入方，存在的意义是「没有任何路径动过这行内容」的断言载体（快照逐字节用例消费
    payload 里的时间列）。D210 起改名（plan_report_rename）会写 updated_at；本条仍钉
    「生成后未改名 ⇒ 两戳恒等」，改名只动 name/updated_at 由 D210 用例反面钉住。
    读走 _db_scalar（另开连接，理由见那个函数）。
    """
    boss, hb = await make_user("d183s4i", admin=True)
    pid = await _proj(client, hb, "D183时间戳")
    pl = await _create_plan(client, hb, pid, "戳")
    await _seed_subject(session, pid, row_id="im-sub")
    await _seed_link(session, pid, pl["id"], row_id="im-l1", subject_id="im-sub")
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]
    for tbl, col in (("plan_report", "id"), ("plan_report_item", "report_id")):
        pairs = await _db_all("SELECT created_at, updated_at FROM " + tbl + " WHERE " + col + "=:i", i=rid)
        assert pairs and all(a == b for a, b in pairs), tbl + " 里存在 updated_at != created_at 的行"


# ══════════ 12. 明细读取的 project_id 谓词：毒行不混进 payload ══════════

async def test_report_detail_reads_only_own_project_items(client, session, make_user) -> None:
    """_report_items 的 project_id 谓词有现行犯：同 report_id、异 project_id 的毒行。

    生成路径永远写 r.project_id，所以正常数据里这个谓词是恒真的——恒真的谓词也必须
    有测试，否则「谓词被删」和「谓词在场」两种世界绿得一模一样（变异 M7 就删它）。
    report_id 是 uuid，别的「真报告」撞不上是运气；但一张写脏的表（迁移回填、手工修数）
    不该让详情读出别项目的行——归属判定与明细谓词同尺，不赌 uuid。
    """
    boss, hb = await make_user("d183s4pr", admin=True)
    pid = await _proj(client, hb, "D183谓词甲")
    p2 = await _proj(client, hb, "D183谓词乙")
    pl = await _create_plan(client, hb, pid, "谓词计划")
    await _seed_subject(session, pid, row_id="px-sub")
    await _seed_link(session, pid, pl["id"], row_id="px-l1", subject_id="px-sub")
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]
    session.add(PlanReportItem(id="px-poison", project_id=p2, report_id=rid,
                               link_id="px-poison-link", subject_type="api_case",
                               subject_id="px-sub", subject_name="毒行",
                               executed=True, executing=False, result="passed"))
    await session.commit()

    b = (await _get(client, hb, pid, rid)).json()
    assert [it["link_id"] for it in b["items"]] == ["px-l1"], \
        "毒行混进了详情明细（=_report_items 没按 project_id 排除）：" + str(
            [it["link_id"] for it in b["items"]])
    assert await _count("plan_report_item", "report_id=:r", r=rid) == 2, \
        "谓词把毒行删了/没插进——读路径只做排除，库里必须原样在场"
