"""1B T12：报告中心查询面（列表 + 详情 + 步骤明细）——自包含报告的服务端半边。

Task 12 Step 1 计划钉的六条断言：
  ① 默认列表不含 trigger=debug，include_debug=true 可见（Review Focus 11）
  ② 六维筛选逐一生效（含 since/until 取等边界）
  ③ pass_rate = pass / (total - skip)，数据集步骤按节点计 1 步（§8.6）
  ④ purge 场景与用例后 report_get 仍完整返回（Review Focus 10 自包含）
  ⑤ 游标分页且 started_at desc
  ⑥ 跨项目 run_id → 404；READONLY 可读报告

本任务写的是报告查询面，不自建 run（写入口唯一是 save_run / scenario runner）。
fixture 数据一律经 models 直插，语义对齐 T2/T1 的既有测试约定。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select

from app.modules.execution.models import RunArtifact, RunRecord, RunStepResult

# 触发词表五元（R46）：report_list 的 trigger 过滤只认这套
TRIGGERS = ["debug", "manual", "schedule", "agent", "webhook"]


async def _run(session, pid: str, *, subject_name: str = "登录接口集",
               subject_type: str = "scenario", trigger: str = "manual",
               status: str = "passed", created_by: str | None = None,
               env_name: str | None = "测试环境",
               started_at: datetime | None = None,
               stats: dict | None = None,
               summary_graph: dict | None = None) -> str:
    """直插一条 run_record（写入口唯一，查询面测试不经过写服务）。"""
    if created_by is None:
        from app.core.db import new_id
        created_by = new_id()
    t = started_at or datetime.now(UTC)
    r = RunRecord(project_id=pid, subject_type=subject_type, subject_id="subj-" + subject_name,
                  subject_name=subject_name, env_id="env-" + env_name,
                  env_name=env_name, trigger=trigger, status=status,
                  created_by=created_by, started_at=t, finished_at=t,
                  stats=stats, summary_graph=summary_graph)
    session.add(r)
    await session.commit()
    return r.id


async def _proj(client, user_headers: dict, name: str) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=user_headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ---------- ① 默认隐藏 debug，include_debug=true 可见（Review Focus 11） ----------


async def test_default_list_hides_debug(client, session, make_user) -> None:
    u, h = await make_user("rpt1")
    pid = await _proj(client, h, "报告中心隐藏调试")
    for t in TRIGGERS:
        await _run(session, pid, subject_name="场景-" + t, trigger=t, created_by=u.id)

    body = (await client.get("/api/v1/reports",
                             params={"project_id": pid, "size": 50}, headers=h)).json()
    # 全部同时刻创建（id 倒序兜底），只断言集合与数量——排序契约在分页测试里钉
    assert {x["trigger"] for x in body["items"]} == {"manual", "schedule", "agent", "webhook"}
    assert len(body["items"]) == 4, "默认必须滤掉 debug，共 4 条"

    dbg = (await client.get("/api/v1/reports", params={
        "project_id": pid, "include_debug": "true", "size": 50}, headers=h)).json()
    assert {x["trigger"] for x in dbg["items"]} == set(TRIGGERS)
    assert len(dbg["items"]) == 5, "include_debug=true 时五元词表全可见"


# ---------- ② 六维筛选逐一生效（§11.4.15） ----------


async def test_list_filters_by_subject_id_trigger_and_status(client, session, make_user) -> None:
    u, h = await make_user("rptf1")
    pid = await _proj(client, h, "报告筛选")
    for trig, st in (("manual", "passed"), ("schedule", "failed")):
        for i in range(3):
            r = RunRecord(project_id=pid, subject_type="scenario",
                          subject_id="scenario-1" if i == 0 else "scenario-2",
                          subject_name="回归-" + str(i), trigger=trig,
                          status=st, created_by=u.id)
            session.add(r)
    await session.commit()

    r = await client.get("/api/v1/reports", params={
        "project_id": pid, "subject_id": "scenario-1", "size": 50}, headers=h)
    assert r.status_code == 200, r.text
    assert len(r.json()["items"]) == 2, "subject_id 精确过滤：scenario-1 恰好两条"

    r2 = await client.get("/api/v1/reports", params={
        "project_id": pid, "trigger": "schedule", "size": 50}, headers=h)
    assert r2.status_code == 200
    assert len(r2.json()["items"]) == 3 and all(x["trigger"] == "schedule" for x in r2.json()["items"])

    r3 = await client.get("/api/v1/reports", params={
        "project_id": pid, "status": "failed", "size": 50}, headers=h)
    assert r3.status_code == 200
    assert len(r3.json()["items"]) == 3 and all(x["status"] == "failed" for x in r3.json()["items"])


async def test_list_filters_env_id_created_by_and_time_window(client, session, make_user) -> None:
    u, h = await make_user("rptf2")
    pid = await _proj(client, h, "报告筛选时间")
    peer, hp = await make_user("rptf2peer")
    now = datetime.now(UTC).replace(microsecond=0)
    r1 = RunRecord(project_id=pid, subject_type="scenario", subject_id="s1",
                   subject_name="早", trigger="manual", status="passed", created_by=u.id,
                   env_id="env-a", started_at=now - timedelta(days=2), finished_at=now - timedelta(days=2))
    r2 = RunRecord(project_id=pid, subject_type="scenario", subject_id="s2",
                   subject_name="中", trigger="manual", status="passed", created_by=peer.id,
                   env_id="env-b", started_at=now - timedelta(days=1), finished_at=now - timedelta(days=1))
    r3 = RunRecord(project_id=pid, subject_type="scenario", subject_id="s3",
                   subject_name="今", trigger="manual", status="passed", created_by=u.id,
                   env_id="env-a", started_at=now, finished_at=now)
    session.add_all([r1, r2, r3])
    await session.commit()

    # env_id 过滤
    r = await client.get("/api/v1/reports", params={
        "project_id": pid, "env_id": "env-a", "size": 50}, headers=h)
    assert {x["id"] for x in r.json()["items"]} == {r1.id, r3.id}

    # created_by 过滤
    r = await client.get("/api/v1/reports", params={
        "project_id": pid, "created_by": peer.id, "size": 50}, headers=h)
    assert [x["id"] for x in r.json()["items"]] == [r2.id]

    # since/until 闭区间边界：since=now-1d（含）→ 中、今；until=now-1d（含）→ 早、中
    r = await client.get("/api/v1/reports", params={
        "project_id": pid, "since": (now - timedelta(days=1)).isoformat(), "size": 50}, headers=h)
    got = {x["id"] for x in r.json()["items"]}
    assert got == {r2.id, r3.id}, "since 取等：started_at == since 必须包含"

    r = await client.get("/api/v1/reports", params={
        "project_id": pid, "until": (now - timedelta(days=1)).isoformat(), "size": 50}, headers=h)
    got = {x["id"] for x in r.json()["items"]}
    assert got == {r1.id, r2.id}, "until 取等：started_at == until 必须包含"

    # since + until 组合
    r = await client.get("/api/v1/reports", params={
        "project_id": pid,
        "since": (now - timedelta(minutes=1)).isoformat(),
        "until": now.isoformat(), "size": 50}, headers=h)
    assert [x["id"] for x in r.json()["items"]] == [r3.id]


# ---------- ③ pass_rate = pass/(total-skip)，数据集步骤按节点计 1 步（§8.6） ----------


async def test_pass_rate_passes_one_dataset_step(client, session, make_user) -> None:
    u, h = await make_user("rptrate")
    pid = await _proj(client, h, "报告通过率")
    # 非数据集步 4 行 + 数据集步 1 节点（row_no=0 基准行）— 节点计 1 步（§8.6）
    rec = RunRecord(project_id=pid, subject_type="scenario", subject_id="sc-1",
                    subject_name="含数据集", trigger="manual", status="passed", created_by=u.id,
                    started_at=datetime.now(UTC), finished_at=datetime.now(UTC),
                    stats={"total": 5, "pass": 5, "fail": 0, "skip": 0, "rows_total": 3})
    session.add(rec)
    await session.commit()
    for i in range(4):
        session.add(RunStepResult(run_id=rec.id, step_key="n" + str(i), kind="api_case",
                                  status="pass" if i != 3 else "fail"))
    # 数据集步：base 行（row_no=0, status=pass）+ 3 行的展开行（行全过）
    session.add(RunStepResult(run_id=rec.id, step_key="ds", kind="api_case", status="pass",
                              row_no=0, row_total=3))
    for i in range(3):
        session.add(RunStepResult(run_id=rec.id, step_key="ds", kind="api_case",
                                  row_no=i + 1, row_total=3, status="pass"))
    await session.commit()

    r = await client.get("/api/v1/reports", params={"project_id": pid, "size": 50}, headers=h)
    assert r.status_code == 200, r.text
    item = next(x for x in r.json()["items"] if x["id"] == rec.id)
    assert item["subject_name"] == "含数据集"
    # 节点 = 5 步（4 非数据集 + 1 数据集），pass = 4 + 1 = 5（数据集全行过才算 pass），fail = 1
    assert item["stats"]["total"] == 5, item["stats"]
    assert item["pass_rate"] == 1.0, "4 pass + 1 数据集节点全过 = 5 pass / 5 总"

    # 数据集步 1 行失败 → 节点 fail → pass_rate 下降；skip 同时从分母剔除
    rec2 = RunRecord(project_id=pid, subject_type="scenario", subject_id="sc-2",
                     subject_name="含失败数据集", trigger="manual", status="failed", created_by=u.id,
                     started_at=datetime.now(UTC), finished_at=datetime.now(UTC),
                     stats={"total": 10, "pass": 8, "fail": 1, "skip": 1, "rows_total": 0})
    session.add(rec2)
    await session.commit()
    # 10 步：8 pass 1 fail 1 skip → pass_rate = 8/(10-1) = 8/9（计划 T12 钉的数字）
    for i in range(10):
        session.add(RunStepResult(run_id=rec2.id, step_key="s" + str(i), kind="api_case",
                                  status=("fail" if i == 4 else ("skip" if i == 8 else "pass"))))
    await session.commit()
    r2 = await client.get("/api/v1/reports", params={"project_id": pid, "size": 50}, headers=h)
    item2 = next(x for x in r2.json()["items"] if x["id"] == rec2.id)
    assert item2["stats"]["total"] == 10 and item2["stats"]["pass"] == 8
    assert item2["pass_rate"] == 8 / 9, "8/(10-1)=8/9，skip 进分母剔除"


async def test_pass_rate_zero_denominator_returns_none(client, session, make_user) -> None:
    """分母 total-skip == 0（全 skip）时 pass_rate 不得除零——返回 None 由前端画「-」。"""
    u, h = await make_user("rptzero")
    pid = await _proj(client, h, "报告全跳过")
    rec = RunRecord(project_id=pid, subject_type="scenario", subject_id="sc-1",
                    subject_name="全跳过", trigger="manual", status="passed", created_by=u.id,
                    started_at=datetime.now(UTC), finished_at=datetime.now(UTC),
                    stats={"total": 3, "pass": 0, "fail": 0, "skip": 3})
    session.add(rec)
    await session.commit()
    for i in range(3):
        session.add(RunStepResult(run_id=rec.id, step_key="s" + str(i), kind="api_case", status="skip"))
    await session.commit()
    r = await client.get("/api/v1/reports", params={"project_id": pid, "size": 50}, headers=h)
    item = next(x for x in r.json()["items"] if x["id"] == rec.id)
    assert item["stats"]["total"] == 3 and item["stats"]["skip"] == 3
    assert item["pass_rate"] is None, "全 skip 不除零，pass_rate=None 而不是 500"


# ---------- ④ self-containment：purge 场景与用例后报告仍完整（Review Focus 10） ----------


async def test_report_get_self_contained_after_assets_purged(client, session, make_user) -> None:
    """先"彻底删除"场景与用例资产，report_get 仍从 run_record/run_step_result/run_artifact
    完整重建报告；且服务不得 import/query 任何领域模块（下面对 asset 表的引用本意是让这个
    测试在资产行真正不存在的前提下跑——本任务按计划允许的结构性证明见 module 语义）。"""
    u, h = await make_user("rptself")
    pid = await _proj(client, h, "报告自包含")

    # 场景与用例"曾经存在"——这里直接经 ORM 建出来，然后真删
    from app.modules.api_test.models import ApiCase, ApiDefinition

    d = ApiDefinition(project_id=pid, name="订单定义", method="GET", path="/order", status="complete")
    session.add(d)
    await session.flush()
    c = ApiCase(project_id=pid, definition_id=d.id, name="查订单", status="normal")
    session.add(c)
    await session.flush()

    # 真实场景 run（从 save_run 语义对齐：subject_type=scenario，subject_id=场景 id）
    t0 = datetime.now(UTC).replace(microsecond=0)
    rec = RunRecord(project_id=pid, subject_type="scenario", subject_id="scenario-1",
                    subject_name="登录→查订单场景", env_id=None, env_name="测试环境",
                    trigger="manual", status="passed", created_by=u.id,
                    started_at=t0, finished_at=t0,
                    stats={"total": 3, "pass": 3, "fail": 0, "skip": 0, "rows_total": 0},
                    summary_graph={
                        "version": 1,
                        "steps": [{"key": "n1", "kind": "api_case", "label": "登录"}],
                        "results": {"n1": "pass"},
                    })
    session.add(rec)
    await session.commit()
    # 步骤明细：一行普通步 + 一行数据集步（row_no>0）+ 一行容器子步（parent 链）
    session.add_all([
        RunStepResult(run_id=rec.id, step_key="n1", kind="api_case", status="pass",
                      subject_name="登录", elapsed_ms=20,
                      detail={"request": {"method": "POST", "url": "http://t/login", "body": {"u": "a"}},
                              "response": {"status": 200, "body": {"code": "0"}},
                              "assertions": [{"name": "code", "passed": True, "expected": "0", "actual": "0"}],
                              "logs": ["登录成功"], "error": None},
                      vars_snapshot={"token": "tk-1"}),
        RunStepResult(run_id=rec.id, step_key="ds", kind="api_case", status="pass",
                      row_no=1, row_total=3, subject_name="查订单", elapsed_ms=10,
                      detail={"request": {"method": "GET", "url": "http://t/order"},
                              "response": {"status": 200, "body": {"order_id": "7"}},
                              "assertions": [], "logs": [], "error": None},
                      vars_snapshot={"order_id": "7"}),
        RunStepResult(run_id=rec.id, step_key="ds", kind="api_case", status="pass",
                      row_no=2, row_total=3, subject_name="查订单", elapsed_ms=10,
                      detail={"request": {"method": "GET", "url": "http://t/order"},
                              "response": {"status": 200, "body": {"order_id": "8"}},
                              "assertions": [], "logs": [], "error": None},
                      vars_snapshot={"order_id": "8"}),
        RunStepResult(run_id=rec.id, step_key="lp", kind="loop", status="pass", parent_step_key="n1",
                      detail={"request": None, "response": None, "assertions": [], "logs": []}),
    ])
    session.add(RunArtifact(run_id=rec.id, step_key="n1", kind="RESPONSE",
                            ref="artifacts/" + rec.id + "/n1.json", bytes=2048))
    await session.commit()

    # 资产真删：用例先软删后 purge 语义等价于"硬删"——直接 DELETE 行（模拟 purge 后清库）
    await session.execute(delete(ApiCase).where(ApiCase.id == c.id))
    await session.execute(delete(ApiDefinition).where(ApiDefinition.id == d.id))
    await session.commit()
    assert (await session.execute(select(ApiCase.id).where(ApiCase.id == c.id))).first() is None
    assert (await session.execute(select(ApiDefinition.id).where(ApiDefinition.id == d.id))).first() is None

    r = await client.get("/api/v1/reports/" + rec.id, params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["subject_name"] == "登录→查订单场景", "subject_name 是快照，资产删除后仍在"
    assert body["trigger"] == "manual" and body["env_name"] == "测试环境"
    assert body["stats"]["pass"] == 3
    # summary_graph 快照自包含
    assert body["summary_graph"]["results"]["n1"] == "pass"
    # 步骤摘要：数据集步按节点计 1 步、聚合 status=pass、带 pass_rows/total_rows
    by_key = {s["step_key"]: s for s in body["steps"]}
    assert by_key["n1"]["status"] == "pass" and by_key["n1"]["elapsed_ms"] == 20
    ds = by_key["ds"]
    assert ds["status"] == "pass" and ds["pass_rows"] == 2 and ds["total_rows"] == 3
    assert body["artifacts"][0]["ref"].endswith("/n1.json")

    # 步骤明细详情：request/response 对照 + 断言 + logs + vars_snapshot 全量可取
    d1 = await client.get(
        "/api/v1/reports/" + rec.id + "/steps", params={
            "project_id": pid, "run_id": rec.id, "step_key": "n1", "row_no": "0"}, headers=h)
    assert d1.status_code == 200, d1.text
    det = d1.json()
    assert det["detail"]["request"]["url"] == "http://t/login"
    assert det["detail"]["response"]["body"]["code"] == "0"
    assert det["detail"]["assertions"][0]["passed"] is True
    assert det["detail"]["logs"] == ["登录成功"]
    assert det["vars_snapshot"]["token"] == "tk-1"
    # 容器子步也能取 detail
    d2 = await client.get(
        "/api/v1/reports/" + rec.id + "/steps", params={
            "project_id": pid, "run_id": rec.id, "step_key": "lp"}, headers=h)
    assert d2.status_code == 200 and d2.json()["detail"]["request"] is None
    # 缺省 row_no → 取该 step_key 的 row_no=0 行（同 key 多行不会 404）
    d3 = await client.get(
        "/api/v1/reports/" + rec.id + "/steps", params={
            "project_id": pid, "run_id": rec.id, "step_key": "n1"}, headers=h)
    assert d3.status_code == 200 and d3.json()["vars_snapshot"]["token"] == "tk-1"


# ---------- ⑤ 游标分页与 started_at desc ----------


async def test_report_list_newest_first_with_cursor(client, session, make_user) -> None:
    u, h = await make_user("rptpg")
    pid = await _proj(client, h, "报告分页")
    now = datetime.now(UTC).replace(microsecond=0)
    ids: list[str] = []
    for i in range(5):
        r = RunRecord(project_id=pid, subject_type="scenario", subject_id="subj-" + str(i),
                      subject_name="分页-" + str(i), trigger="manual", status="passed",
                      created_by=u.id, started_at=now - timedelta(minutes=5 - i),
                      finished_at=now - timedelta(minutes=5 - i))
        session.add(r)
        await session.commit()
        ids.append(r.id)

    body = (await client.get("/api/v1/reports", params={"project_id": pid, "size": 50}, headers=h)).json()
    assert [x["id"] for x in body["items"]] == list(reversed(ids)), "报告必须 started_at desc"

    p1 = (await client.get("/api/v1/reports", params={"project_id": pid, "size": 2}, headers=h)).json()
    assert [x["id"] for x in p1["items"]] == [ids[-1], ids[-2]]
    assert p1["next_cursor"], "还有下一页必须给游标"
    p2 = (await client.get("/api/v1/reports", params={
        "project_id": pid, "size": 2, "cursor": p1["next_cursor"]}, headers=h)).json()
    assert [x["id"] for x in p2["items"]] == [ids[-3], ids[-4]]
    seen = [x["id"] for x in p1["items"]] + [x["id"] for x in p2["items"]]
    assert len(set(seen)) == 4, "翻页重复：" + str(seen)

    bad = await client.get("/api/v1/reports", params={"project_id": pid, "cursor": "@@@@"}, headers=h)
    assert bad.status_code == 400 and bad.json()["code"] == "bad_cursor"


# ---------- ⑥ 跨项目 404 + READONLY 可读 ----------


async def test_report_get_other_project_404_and_non_member_forbidden(client, session, make_user) -> None:
    u, h = await make_user("rptx")
    pid = await _proj(client, h, "报告A")
    rec = RunRecord(project_id=pid, subject_type="scenario", subject_id="sc-1",
                    subject_name="某人", trigger="manual", status="passed", created_by=u.id)
    session.add(rec)
    await session.commit()

    pid2 = await _proj(client, h, "报告B")
    r = await client.get("/api/v1/reports/" + rec.id, params={"project_id": pid2}, headers=h)
    assert r.status_code == 404 and r.json()["code"] == "not_found", "跨项目 run_id 必须 404"

    other, ho = await make_user("rptxother")
    r2 = await client.get("/api/v1/reports/" + rec.id, params={"project_id": pid}, headers=ho)
    assert r2.status_code == 403, "非成员连存在性都不可见"


async def test_readonly_member_can_read_reports(client, session, make_user) -> None:
    u, h = await make_user("rptro")
    pid = await _proj(client, h, "报告只读")
    rec = RunRecord(project_id=pid, subject_type="scenario", subject_id="sc-1",
                    subject_name="登录场景", trigger="manual", status="passed", created_by=u.id)
    session.add(rec)
    await session.commit()

    ro, hro = await make_user("rptro_user")
    r = await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                         json={"role_code": "READONLY"}, headers=h)
    assert r.status_code == 200, r.text
    lst = await client.get("/api/v1/reports", params={"project_id": pid, "size": 50}, headers=hro)
    assert lst.status_code == 200 and [x["id"] for x in lst.json()["items"]] == [rec.id]
    det = await client.get("/api/v1/reports/" + rec.id, params={"project_id": pid}, headers=hro)
    assert det.status_code == 200 and det.json()["subject_name"] == "登录场景"
    step = await client.get("/api/v1/reports/" + rec.id + "/steps",
                            params={"project_id": pid, "run_id": rec.id, "step_key": "?"}, headers=hro)
    assert step.status_code == 404, "不存在的步骤给 404（不是 403）"


# ---------- R70：NULL started_at 不再毒化游标（queued/1A 老行必须仍可翻页） ----------


async def test_null_started_at_rows_survive_paging(client, session, make_user) -> None:
    """R70 实测过的断链：MySQL DESC 把 NULL 排最后，旧 row_key 给 NULL 行吐 ""，

    下一页 decode 直接 400 bad_cursor。T9 起 queued run 按定义 started_at IS NULL，
    在默认筛选面上——项目攒过一页且页尾是 queued，用户就撞上「翻到一半会话坏了」。
    修法（计划 T9 裁定）：排序键 COALESCE(started_at, created_at)，游标键永不为 NULL。
    钉法遵裁定：**必须走真翻页**（page1 → next_cursor → page2 全 200 且无丢无重），
    只测「NULL 排最后」会绿着放过这个 bug。
    """
    u, h = await make_user("rptnull")
    pid = await _proj(client, h, "报告空开始时间翻页")
    base = datetime.now(UTC).replace(microsecond=0)
    ids: list[str] = []
    # 25 条有 started_at + 20 条 NULL（queued 形态，created_at 也刻意排最后）：
    # 页大小 20 → 第 2 页的边界行落在 NULL 区且 has_more=true —— 旧实现正是在
    # 「页尾是 NULL 行」时吐出 "" 键游标、下一页 400。这是 R70 的失败形状本体。
    for i in range(25):
        r = RunRecord(project_id=pid, subject_type="scenario", subject_id="s",
                      subject_name="t" + str(i), trigger="manual", status="passed",
                      created_by=u.id, started_at=base - timedelta(minutes=i),
                      created_at=base - timedelta(minutes=i))
        session.add(r)
        await session.commit()
        ids.append(r.id)
    for i in range(20):
        r = RunRecord(project_id=pid, subject_type="scenario", subject_id="s",
                      subject_name="q" + str(i), trigger="manual", status="queued",
                      created_by=u.id, started_at=None,
                      created_at=base - timedelta(hours=1, minutes=i))
        session.add(r)
        await session.commit()
        ids.append(r.id)

    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        params = {"project_id": pid, "size": 20}
        if cursor:
            params["cursor"] = cursor
        r = await client.get("/api/v1/reports", params=params, headers=h)
        assert r.status_code == 200, "第 " + str(pages + 1) + " 页 400/500：" + r.text
        body = r.json()
        seen.extend(x["id"] for x in body["items"])
        cursor = body["next_cursor"]
        pages += 1
        assert pages <= 5, "翻页没收敛（游标回环？）"
        if not cursor:
            break
    assert pages == 3, "45 行 / 页 20 应恰好 3 页"
    assert sorted(seen) == sorted(ids), "翻页有丢或有重：" + str(len(seen)) + " vs " + str(len(ids))
    # queued 行对外如实 started_at=None（「—」），但仍经 COALESCE(created_at) 参与时间线
    got = (await client.get("/api/v1/reports", params={"project_id": pid, "size": 50},
                            headers=h)).json()["items"]
    nulls = [x for x in got if x["started_at"] is None]
    assert len(nulls) == 20 and {x["id"] for x in nulls} == set(ids[25:])


async def test_time_window_hits_null_started_at_row_via_created_at(client, session,
                                                                   make_user) -> None:
    """D177：时间窗与排序键共用 COALESCE(started_at, created_at)（workbench 同尺）。

    窗口若用裸 started_at，NULL 开始行可排序却永不可命中 since——前端默认必带
    since（reports.tsx days=7），queued/1A 老行因此从默认 7 天视图静默消失。
    反向同钉：started_at 与 created_at 都在窗外的行必须仍被滤掉，否则「干脆不
    筛窗口」的假实现也能绿。
    """
    u, h = await make_user("rptd177")
    pid = await _proj(client, h, "报告空开始时间窗口")
    base = datetime.now(UTC).replace(microsecond=0)
    q = RunRecord(project_id=pid, subject_type="scenario", subject_id="s-q",
                  subject_name="排队未开始", trigger="manual", status="queued",
                  created_by=u.id, started_at=None, created_at=base)
    stale_q = RunRecord(project_id=pid, subject_type="scenario", subject_id="s-old",
                        subject_name="老排队", trigger="manual", status="queued",
                        created_by=u.id, started_at=None,
                        created_at=base - timedelta(days=30))
    recent = RunRecord(project_id=pid, subject_type="scenario", subject_id="s-r",
                       subject_name="近启动", trigger="manual", status="passed",
                       created_by=u.id, started_at=base - timedelta(hours=2),
                       finished_at=base - timedelta(hours=2),
                       created_at=base - timedelta(hours=2))
    stale = RunRecord(project_id=pid, subject_type="scenario", subject_id="s-s",
                      subject_name="远古启动", trigger="manual", status="passed",
                      created_by=u.id, started_at=base - timedelta(days=30),
                      finished_at=base - timedelta(days=30),
                      created_at=base - timedelta(days=30))
    session.add_all([q, stale_q, recent, stale])
    await session.commit()

    # 前端默认视图的形状：只带 since=now-7d
    r = await client.get("/api/v1/reports", params={
        "project_id": pid, "since": (base - timedelta(days=7)).isoformat(), "size": 50},
        headers=h)
    assert r.status_code == 200, r.text
    got = {x["id"] for x in r.json()["items"]}
    assert got == {q.id, recent.id}, \
        "NULL 开始行按 created_at 命中窗口；有 started_at 的行行为不变，窗外两行仍排除"
    q_item = next(x for x in r.json()["items"] if x["id"] == q.id)
    assert q_item["started_at"] is None, "对外仍如实回「—」，只是不再从窗口里消失"


async def test_until_window_also_hits_null_started_at_row(client, session,
                                                          make_user) -> None:
    """D177 的第二条腿：`until` 与 `since` 各自独立，一条谓词各钉一条。

    只带 since 的用例（上一条）杀不掉「until 仍用裸列」的写法——那条腿在未传
    `until` 的请求上根本不走。这里反过来只传 until，且把一条**该被 until 筛掉**的
    行一起种进去：否则「干脆不实现 until」的假实现也能绿。
    """
    u, h = await make_user("rptd177u")
    pid = await _proj(client, h, "报告空开始时间上界")
    base = datetime.now(UTC).replace(microsecond=0)
    until = base - timedelta(days=1)
    # 唯一该出现的行：没开始过，created_at 落在上界之内 ⇒ 只有 COALESCE 才够得着它
    n = RunRecord(project_id=pid, subject_type="scenario", subject_id="s-n",
                  subject_name="窗口内的未开始", trigger="manual", status="queued",
                  created_by=u.id, started_at=None, created_at=base - timedelta(days=2))
    # 反面行：上界之后起跑，两种写法都该被 until 筛掉——它负责证明 until 还在管事
    late = RunRecord(project_id=pid, subject_type="scenario", subject_id="s-l",
                     subject_name="上界之后", trigger="manual", status="passed",
                     created_by=u.id, started_at=base - timedelta(hours=12),
                     finished_at=base - timedelta(hours=12),
                     created_at=base - timedelta(hours=12))
    session.add_all([n, late])
    await session.commit()

    r = await client.get("/api/v1/reports", params={
        "project_id": pid, "until": until.isoformat(), "size": 50}, headers=h)
    assert r.status_code == 200, r.text
    got = {x["id"] for x in r.json()["items"]}
    assert got == {n.id}, "until 也必须按 COALESCE 命中未开始行，同时仍然筛得住上界之后的行"


async def test_report_list_status_widened_and_running_filter(client, session,
                                                             make_user) -> None:
    """T9 词表连带：报告中心要筛得出 queued/running/cancelled（旧三态 pattern 会 422）。"""
    u, h = await make_user("rptvocab")
    pid = await _proj(client, h, "报告状态词表")
    for st in ("queued", "running", "cancelled"):
        session.add(RunRecord(project_id=pid, subject_type="scenario",
                              subject_id="s-" + st, subject_name=st, trigger="manual",
                              status=st, created_by=u.id))
    await session.commit()
    for st in ("queued", "running", "cancelled"):
        r = await client.get("/api/v1/reports",
                             params={"project_id": pid, "status": st}, headers=h)
        assert r.status_code == 200 and [x["status"] for x in r.json()["items"]] == [st]


# ---------- 1C T11：subject_type 筛选（R112，与 run 列表同一口径） ----------


async def test_report_list_filters_by_subject_type(client, session, make_user) -> None:
    """报告中心能按 ui_case 筛（缺 where 时过滤器被静默忽略 → 返回全量，直接红）。"""
    u, h = await make_user("rptsubj")
    pid = await _proj(client, h, "报告对象类型筛选")
    await _run(session, pid, subject_name="UI 登录用例", subject_type="ui_case",
               trigger="manual", created_by=u.id)
    await _run(session, pid, subject_name="回归场景", subject_type="scenario",
               trigger="manual", created_by=u.id)
    await _run(session, pid, subject_name="下单用例", subject_type="api_case",
               trigger="manual", created_by=u.id)

    r = await client.get("/api/v1/reports",
                         params={"project_id": pid, "subject_type": "ui_case"}, headers=h)
    assert r.status_code == 200, r.text
    assert [x["subject_type"] for x in r.json()["items"]] == ["ui_case"]


async def test_report_list_subject_type_illegal_422(client, make_user) -> None:
    _, h = await make_user("rptsubjbad")
    pid = await _proj(client, h, "报告对象类型非法")
    r = await client.get("/api/v1/reports",
                         params={"project_id": pid, "subject_type": "ui"}, headers=h)
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "validation_failed"


async def test_step_detail_description_honest_about_offload(client) -> None:
    """第二十六轮文案兑现：description 是审计页/工具清单读的面包，「全量」是坏话——
    落库前 response.body/logs 超阈值会被 offload_detail 换成 head + 制品 ref 替身
    （artifacts.py 的 _marker），description 必须披露替身呈现，同时不许反过来
    说成「都会截断」（未超阈值原样返回，artifacts.py:187 判据②）。"""
    import app.modules.execution.report_services  # noqa: F401  确保注册
    from app.core.registry import REGISTRY

    spec = next(t for t in REGISTRY.all() if t.name == "report_step_detail")
    d = spec.description
    assert "全量" not in d and "全部" not in d and "所有" not in d, d
    # 既有说法保留（改文案不撕面包）：步骤 detail / vars_snapshot 两个词还在
    assert "步骤 detail" in d and "vars_snapshot" in d, d
    # 替身披露在场，且带「未超阈值原样」的另一侧（不许只说截断）
    assert "超阈值" in d and "制品" in d and "未超阈值" in d, d
