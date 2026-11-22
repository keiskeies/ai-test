"""1B T10 场景资产 CRUD：校验拦截、乐观锁、回收站三件套、引用检测、权限（§11.4.8）。

钉的是计划 Task 10 Step 1 的断言 ①-⑦（除 Review Focus 9 的 data_set_delete 半边——
那属于 api_test，由协调者接手，不在这里写测试）。
"""
from __future__ import annotations

VALID_GRAPH = {"version": 1, "nodes": [
    {"key": "n1", "kind": "api_case", "ref": "case-login", "name": "登录"},
    {"key": "n2", "kind": "sleep", "config": {"ms": 100}, "name": "停一下"},
]}


def _graph(*nodes) -> dict:
    return {"version": 1, "nodes": list(nodes)}


async def _setup(client, make_user, tag):
    boss, hb = await make_user("scboss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "psc" + tag}, headers=hb)).json()["id"]
    return boss, hb, pid


async def _mk(client, h, pid, name="登录场景", **kw):
    body = {"project_id": pid, "name": name}
    body.update(kw)
    r = await client.post("/api/v1/scenarios", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _mkdef(client, h, pid, name="查询订单", path="/order/1"):
    r = await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": name, "method": "GET", "path": path,
        "request": {"method": "GET", "url": "http://t" + path}}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _mkcase(client, h, pid, did, name="下单用例"):
    r = await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": did, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


# ---------- ① CRUD + 乐观锁 ----------

async def test_crud_and_optimistic_lock(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "A")
    s = await _mk(client, h, pid, step_graph=VALID_GRAPH, priority="P1", fail_fast=False,
                  max_runtime_ms=60000)
    assert s["version"] == 1 and s["step_count"] == 2, s
    assert s["status"] == "normal"

    # 成功更新：version+=1, step_count 重算, updated_by 记录
    g2 = {"version": 1, "nodes": [
        {"key": "n1", "kind": "api_case", "ref": "case-login"},
        {"key": "n2", "kind": "sleep", "config": {"ms": 5}},
        {"key": "n3", "kind": "extract", "config": {"rules": [{"var": "u", "expr": "$.id"}]}},
    ]}
    ok = await client.patch("/api/v1/scenarios/" + s["id"], json={
        "project_id": pid, "version": 1, "step_graph": g2, "name": "改了", "priority": "P0"}, headers=h)
    assert ok.status_code == 200, ok.text
    b = ok.json()
    assert b["version"] == 2 and b["step_count"] == 3 and b["priority"] == "P0", b
    assert b["updated_by"]

    # 旧 version → 409 conflict + current_version（现在已是 2，带着 1 来改必被拒）
    stale = await client.patch("/api/v1/scenarios/" + s["id"], json={
        "project_id": pid, "version": 1, "name": "被覆盖?"}, headers=h)
    assert stale.status_code == 409 and stale.json()["code"] == "conflict", stale.text
    assert stale.json()["details"]["current_version"] == 2, stale.text

    got = await client.get("/api/v1/scenarios/" + s["id"], params={"project_id": pid}, headers=h)
    assert got.status_code == 200 and got.json()["version"] == 2
    assert got.json()["issues"] == [], "合法图返回已计算的 live issues"

    # 列表可见 + 模块挂载 + 最近结果两列
    lst = await client.get("/api/v1/scenarios", params={"project_id": pid}, headers=h)
    assert [x["id"] for x in lst.json()["items"]] == [s["id"]]
    assert lst.json()["items"][0]["last_run_status"] is None

    # 同项目重名 → 409（⑦）
    dup = await client.post("/api/v1/scenarios", json={"project_id": pid, "name": "改了"}, headers=h)
    assert dup.status_code == 409 and dup.json()["code"] == "conflict", dup.text

    # 拿不到（不存在 → 404）
    assert (await client.get("/api/v1/scenarios/nope", params={"project_id": pid},
                             headers=h)).status_code == 404


# ---------- ② 校验拦截：graph 过 T4 validate() ----------

async def test_create_rejects_invalid_graph(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "B")
    bad = _graph({"key": "b", "kind": "break"})  # break 在循环外（Review Focus 1）
    r = await client.post("/api/v1/scenarios", json={
        "project_id": pid, "name": "坏场景", "step_graph": bad}, headers=h)
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "validation_error", r.text
    issues = r.json()["details"]["issues"]
    assert issues and issues[0]["code"] == "break_outside_loop", issues
    assert issues[0]["node_key"] == "b", issues
    # create 失败 = 没写进去
    assert (await client.get("/api/v1/scenarios", params={"project_id": pid}, headers=h)).json()["items"] == []
    # 垃圾输入 → 422 validation_error 而不是 500
    r2 = await client.post("/api/v1/scenarios", json={
        "project_id": pid, "name": "垃圾图", "step_graph": {"nodes": "x", "version": 1}}, headers=h)
    assert r2.status_code == 422 and r2.json()["code"] == "validation_error", r2.text


async def test_update_rejects_invalid_graph_and_reports_live_issues(client, make_user, session) -> None:
    """坏图保存期就 422；直插库里的坏图由 scenario_get 的 live issues 兜底暴露。

    1D T8 改钉：坏样本原来用 adb_case（kind_not_available），adb 开放后换 break 出环
    ——这个用例钉的是「保存门 + live issues」两道，不是某个具体 kind。
    """
    _, h, pid = await _setup(client, make_user, "B2")
    s = await _mk(client, h, pid, name="好场景")
    bad = _graph({"key": "x", "kind": "break"})
    r = await client.patch("/api/v1/scenarios/" + s["id"], json={
        "project_id": pid, "version": 1, "step_graph": bad}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "validation_error", r.text
    assert r.json()["details"]["issues"][0]["code"] == "break_outside_loop", r.text
    # 图没保存，版本没动
    got = await client.get("/api/v1/scenarios/" + s["id"], params={"project_id": pid}, headers=h)
    assert got.json()["version"] == 1 and got.json()["issues"] == []

    # 手工把坏图塞进库里（绕开校验入口）→ scenario_get 的 live issues 把它暴露出来
    from app.modules.scenario.models import Scenario

    row = await session.get(Scenario, s["id"])
    row.step_graph = bad
    row.version = 2
    await session.commit()
    # 新开读事务看得到刚提交的坏图（当前会话的快照会吃到提交的结果，因为 commit 过后
    # 再查询会开启新的一致性读）
    got2 = await client.get("/api/v1/scenarios/" + s["id"], params={"project_id": pid}, headers=h)
    assert got2.status_code == 200
    codes = [i["code"] for i in got2.json()["issues"]]
    assert "break_outside_loop" in codes, got2.json()["issues"]


# ---------- ③ 回收站三件套 ----------

async def test_recycled_list_carries_deleter_and_time(client, make_user) -> None:
    """§11.4.18 回收站「删除人/删除时间」两列在后端有真相可读（仅场景域）。

    本用例操作者=创建者，所以它测不出「编辑人≠回收人」的分叉——那条由下面的
    test_recycled_deleter_is_the_recycler_not_the_last_editor 钉住。
    """
    boss, hb, pid = await _setup(client, make_user, "DELPERSON")
    s = await _mk(client, hb, pid, name="要被回收的")
    assert (await client.post("/api/v1/scenarios/" + s["id"] + "/delete",
                              json={"project_id": pid}, headers=hb)).status_code == 200

    items = (await client.get("/api/v1/scenarios", params={"project_id": pid, "recycled": True},
                              headers=hb)).json()["items"]
    assert [x["id"] for x in items] == [s["id"]]
    row = items[0]
    assert row["updated_by"] == boss.id, row
    # 人名来自分页后的 APP_USER 小查询；回填 id 冒充人名（变异 A 的注入形状）必须在这行变红
    assert row["updated_by_name"] == boss.name, row
    assert row["updated_by_name"] != row["updated_by"], row
    # 时间不钉精确时刻（DATETIME 同秒会飘；口径同文件末尾 test_scenario_out_carries_timestamps）
    assert row["updated_at"] and row["updated_at"].endswith("+00:00"), row


async def test_recycled_deleter_is_the_recycler_not_the_last_editor(client, make_user) -> None:
    """「甲编辑、乙回收」时删除人必须是乙——上面那条用例操作者=创建者，恰好测不到这个分叉。

    scenario_delete 里那行 `s.updated_by = ctx.user_id` 就是为本用例存在的：删掉它，
    回收站会把上一个编辑人（boss）报成删除人，而删除时间已经跟上了——时间与人对不上。
    """
    boss, hb, pid = await _setup(client, make_user, "TWOPPL")
    s = await _mk(client, hb, pid, name="甲建甲改乙删")
    admin, ha = await make_user("scadminDEL")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + admin.id,
                             json={"role_code": "PROJECT_ADMIN"}, headers=hb)).status_code == 200
    # 甲（PROJECT_ADMIN）先改一次：updated_by 落到 admin
    assert (await client.patch("/api/v1/scenarios/" + s["id"], json={
        "project_id": pid, "version": s["version"], "name": "甲改过的名字"}, headers=ha)).status_code == 200
    # 乙（owner）回收
    assert (await client.post("/api/v1/scenarios/" + s["id"] + "/delete",
                              json={"project_id": pid}, headers=hb)).status_code == 200

    row = (await client.get("/api/v1/scenarios", params={"project_id": pid, "recycled": True},
                            headers=hb)).json()["items"][0]
    assert row["updated_by"] == boss.id, row
    assert row["updated_by_name"] == boss.name, row

async def test_recycle_restore_purge(client, make_user) -> None:
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("scenario_purge")
    assert spec is not None and spec.effect == "destructive" and spec.perm == "scenario:delete"
    assert spec.tool is False, "彻底删除不进 Pilot 工具箱（R53 与接口/用例同手感）"

    _, h, pid = await _setup(client, make_user, "C")
    s = await _mk(client, h, pid, name="支付场景")
    got = await client.get("/api/v1/scenarios/" + s["id"], params={"project_id": pid}, headers=h)
    assert got.status_code == 200 and got.json()["status"] == "normal"

    # delete → 正常列表不可见，recycled=true 可见
    assert (await client.post("/api/v1/scenarios/" + s["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert (await client.get("/api/v1/scenarios", params={"project_id": pid}, headers=h)).json()["items"] == []
    rrec = await client.get("/api/v1/scenarios", params={"project_id": pid, "recycled": True}, headers=h)
    assert [x["id"] for x in rrec.json()["items"]] == [s["id"]]
    # get 一个回收中的场景 → 404（与接口同语义，不泄露）
    assert (await client.get("/api/v1/scenarios/" + s["id"], params={"project_id": pid},
                             headers=h)).status_code == 404
    # 重复删除 → 404
    assert (await client.post("/api/v1/scenarios/" + s["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 404
    # 未回收 purge → not_recycled
    live = await _mk(client, h, pid, name="活场景")
    bad0 = await client.post("/api/v1/scenarios/" + live["id"] + "/purge",
                             json={"project_id": pid, "confirm_name": "活场景"}, headers=h)
    assert bad0.status_code == 409 and bad0.json()["code"] == "not_recycled", bad0.text

    # 输名不符 → name_mismatch
    wrong = await client.post("/api/v1/scenarios/" + s["id"] + "/purge",
                              json={"project_id": pid, "confirm_name": "支付"}, headers=h)
    assert wrong.status_code == 409 and wrong.json()["code"] == "name_mismatch", wrong.text

    # restore 回归；名字/图/版本原样
    ok = await client.post("/api/v1/scenarios/" + s["id"] + "/restore",
                           json={"project_id": pid}, headers=h)
    assert ok.status_code == 200 and ok.json()["status"] == "normal", ok.text
    got = await client.get("/api/v1/scenarios/" + s["id"], params={"project_id": pid}, headers=h)
    assert got.status_code == 200 and got.json()["name"] == "支付场景"

    # 再回收 → purge 真删；同名解放
    assert (await client.post("/api/v1/scenarios/" + s["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    good = await client.post("/api/v1/scenarios/" + s["id"] + "/purge",
                             json={"project_id": pid, "confirm_name": "支付场景"}, headers=h)
    assert good.status_code == 200, good.text
    assert (await client.get("/api/v1/scenarios", params={"project_id": pid, "recycled": True},
                             headers=h)).json()["items"] == []
    assert (await client.post("/api/v1/scenarios", json={"project_id": pid, "name": "支付场景"},
                              headers=h)).status_code == 201


# ---------- ⑤ 引用检测 ----------

async def test_scenario_references(client, make_user) -> None:
    """用例被 2 个未回收场景 step 引用 → 两条结果含步骤 key；回收场景后不计。

    后半段（definition_id 半边）钉的是 D69 的缺陷：接口详情「场景引用」Tab 按定义 id 查，
    而 step_graph 存的是用例 ref，端点必须自己展开，否则回空列表 = 骗人放心删。
    """
    _, h, pid = await _setup(client, make_user, "E")
    did = (await _mkdef(client, h, pid))["id"]
    c = await _mkcase(client, h, pid, did, name="登录用例")

    s1 = await _mk(client, h, pid, name="场景一",
                   step_graph=_graph({"key": "login", "kind": "api_case", "ref": c["id"]}))
    s2 = await _mk(client, h, pid, name="场景二",
                   step_graph=_graph({"key": "a.login", "kind": "api_case", "ref": c["id"]},
                                     {"key": "a.again", "kind": "api_case", "ref": c["id"]}))

    # 按 case_id 查
    r = await client.get("/api/v1/scenario-references", params={
        "project_id": pid, "case_id": c["id"]}, headers=h)
    assert r.status_code == 200, r.text
    refs = r.json()["items"]
    assert len(refs) == 2, refs
    by_sid = {x["scenario_id"]: x for x in refs}
    assert set(by_sid) == {s1["id"], s2["id"]}
    assert sorted(by_sid[s1["id"]]["step_keys"]) == ["login"], by_sid[s1["id"]]
    assert sorted(by_sid[s2["id"]]["step_keys"]) == ["a.again", "a.login"], by_sid[s2["id"]]
    assert by_sid[s1["id"]]["scenario_name"] == "场景一"

    # 场景回收 → 引用不计（Review Focus 9：只有未回收场景的引用挡住资产删除）
    assert (await client.post("/api/v1/scenarios/" + s2["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    r2 = await client.get("/api/v1/scenario-references", params={
        "project_id": pid, "case_id": c["id"]}, headers=h)
    assert [x["scenario_id"] for x in r2.json()["items"]] == [s1["id"]]

    # 按 definition_id 查（接口被引用）——D69 那个 Tab 走的就是这条。
    # 曾经这里只断 200：端点拿「定义 id」去比 step_graph 里的「用例 ref」恒不命中，
    # 于是对每个接口都回空列表，页面老老实实显示「暂无引用」= 一个骗人放心删的假空态。
    # 所以这里必须断**命中**，而且要断到步骤 key（只断非空的话，命中到别的场景上也会绿）。
    r3 = await client.get("/api/v1/scenario-references", params={
        "project_id": pid, "definition_id": did}, headers=h)
    assert r3.status_code == 200, r3.text
    by_def = {x["scenario_id"]: x for x in r3.json()["items"]}
    assert set(by_def) == {s1["id"]}, by_def  # s2 已回收，不计
    assert sorted(by_def[s1["id"]]["step_keys"]) == ["login"], by_def[s1["id"]]

    # 同定义下的**另一条**用例被引用，按定义查也要命中（展开的是定义下所有未回收用例）
    c2 = await _mkcase(client, h, pid, did, name="退款用例")
    s3 = await _mk(client, h, pid, name="场景三",
                   step_graph=_graph({"key": "refund", "kind": "api_case", "ref": c2["id"]}))
    r5 = await client.get("/api/v1/scenario-references", params={
        "project_id": pid, "definition_id": did}, headers=h)
    assert {x["scenario_id"] for x in r5.json()["items"]} == {s1["id"], s3["id"]}, r5.json()

    # 用例回收后不再是引用桥（与 api_case_delete 的「未回收」口径一致）。
    # 顺带钉住第一段就是 409：被引用的用例不该让人一键删掉。
    blocked = await client.post("/api/v1/api-cases/" + c2["id"] + "/delete",
                                json={"project_id": pid}, headers=h)
    assert blocked.status_code == 409, blocked.text
    assert (await client.post("/api/v1/api-cases/" + c2["id"] + "/delete",
                              json={"project_id": pid, "force": True}, headers=h)).status_code == 200
    r6 = await client.get("/api/v1/scenario-references", params={
        "project_id": pid, "definition_id": did}, headers=h)
    assert [x["scenario_id"] for x in r6.json()["items"]] == [s1["id"]], r6.json()

    # 别的接口不算：同项目另一个定义下的用例不能冒名顶替
    other = (await _mkdef(client, h, pid, name="另一个接口"))["id"]
    r7 = await client.get("/api/v1/scenario-references", params={
        "project_id": pid, "definition_id": other}, headers=h)
    assert r7.json()["items"] == [], r7.json()
    # 找不到引用 → 空列表
    r4 = await client.get("/api/v1/scenario-references", params={
        "project_id": pid, "case_id": "nope"}, headers=h)
    assert r4.status_code == 200 and r4.json()["items"] == []


# ---------- ⑥ 权限：非成员 403、READONLY 无写、MEMBER 无 *:delete ----------

async def test_scenario_permissions(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "F")
    s = await _mk(client, h, pid, name="权限场景")
    # 非成员 403
    _, ho = await make_user("scfout")
    assert (await client.get("/api/v1/scenarios", params={"project_id": pid}, headers=ho)).status_code == 403
    # MEMBER 有写但无 delete
    member, hm = await make_user("scfmem")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + member.id,
                             json={"role_code": "MEMBER"}, headers=h)).status_code == 200
    assert (await client.post("/api/v1/scenarios", json={
        "project_id": pid, "name": "成员新建"}, headers=hm)).status_code == 201
    r = await client.post("/api/v1/scenarios/" + s["id"] + "/delete",
                          json={"project_id": pid}, headers=hm)
    assert r.status_code == 403, r.text
    # READONLY 可以读、不能写
    ro, hr = await make_user("scfro")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                             json={"role_code": "READONLY"}, headers=h)).status_code == 200
    assert (await client.get("/api/v1/scenarios/" + s["id"], params={"project_id": pid},
                             headers=hr)).status_code == 200
    assert (await client.post("/api/v1/scenarios", json={
        "project_id": pid, "name": "只读新建"}, headers=hr)).status_code == 403
    assert (await client.patch("/api/v1/scenarios/" + s["id"],
                               json={"project_id": pid, "version": 1, "name": "x"}, headers=hr)).status_code == 403


# ---------- duplicate / batch_move ----------

async def test_duplicate(client, make_user) -> None:
    """scenario_duplicate：复制图/变量/优先级并带「- 副本」后缀，可再保存。"""
    _, h, pid = await _setup(client, make_user, "G")
    s = await _mk(client, h, pid, name="登录链路", step_graph=VALID_GRAPH,
                  variables={"uid": "1"}, priority="P1", fail_fast=False)
    r = await client.post("/api/v1/scenarios/" + s["id"] + "/duplicate",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["id"] != s["id"]
    assert d["name"] == "登录链路 - 副本", d["name"]
    assert d["step_graph"] == VALID_GRAPH, d["step_graph"]
    assert d["variables"] == {"uid": "1"}
    assert d["priority"] == "P1" and d["fail_fast"] is False
    assert d["version"] == 1 and d["step_count"] == 2
    # 副本也在列表里
    names = {x["name"] for x in (await client.get("/api/v1/scenarios",
                                                  params={"project_id": pid}, headers=h)).json()["items"]}
    assert names == {"登录链路", "登录链路 - 副本"}
    # duplicate 本身不校验图：复制的是已保存过的合法场景；空名是校验问题
    bad = await client.post("/api/v1/scenarios/" + s["id"] + "/duplicate",
                            json={"project_id": pid, "name": ""}, headers=h)
    assert bad.status_code == 422, bad.text


async def test_duplicate_refuses_missing_and_bad_source(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "G2")
    assert (await client.post("/api/v1/scenarios/nope/duplicate",
                              json={"project_id": pid}, headers=h)).status_code == 404
    # 回收站里的场景不可复制
    s = await _mk(client, h, pid, name="回收场景")
    assert (await client.post("/api/v1/scenarios/" + s["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert (await client.post("/api/v1/scenarios/" + s["id"] + "/duplicate",
                              json={"project_id": pid}, headers=h)).status_code == 404


async def test_batch_move(client, make_user) -> None:
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("scenario_batch_move")
    assert spec is not None and spec.perm == "scenario:update", "batch_move 是移动=写"

    _, h, pid = await _setup(client, make_user, "H")
    m1 = (await client.post("/api/v1/scenario-modules", json={
        "project_id": pid, "name": "一区"}, headers=h)).json()
    m2 = (await client.post("/api/v1/scenario-modules", json={
        "project_id": pid, "name": "二区"}, headers=h)).json()
    s1 = await _mk(client, h, pid, name="a", module_id=m1["id"])
    s2 = await _mk(client, h, pid, name="b")
    r = await client.post("/api/v1/scenario-batch-move", json={
        "project_id": pid, "scenario_ids": [s1["id"], s2["id"]], "module_id": m2["id"]}, headers=h)
    assert r.status_code == 200, r.text
    for_ = await client.get("/api/v1/scenarios/" + s1["id"], params={"project_id": pid}, headers=h)
    assert for_.json()["module_id"] == m2["id"]
    for_ = await client.get("/api/v1/scenarios/" + s2["id"], params={"project_id": pid}, headers=h)
    assert for_.json()["module_id"] == m2["id"]
    # 移到根
    r2 = await client.post("/api/v1/scenario-batch-move", json={
        "project_id": pid, "scenario_ids": [s1["id"]], "module_id": None}, headers=h)
    assert r2.status_code == 200, r2.text
    assert (await client.get("/api/v1/scenarios/" + s1["id"], params={"project_id": pid},
                             headers=h)).json()["module_id"] is None
    # 跨项目混入被拒 / 回收站场景不能被移动
    s3 = await _mk(client, h, pid, name="c")
    assert (await client.post("/api/v1/scenarios/" + s3["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    bad = await client.post("/api/v1/scenario-batch-move", json={
        "project_id": pid, "scenario_ids": [s3["id"]], "module_id": m2["id"]}, headers=h)
    assert bad.status_code == 404, bad.text


async def test_scenario_out_carries_timestamps(client, make_user, session) -> None:
    """列表页的「更新时间」列要有真值可用（计划 Task 17 的列清单里就有这一列）。

    T17 落地时只能先显示「—」并留注释：ScenarioOut 当时一个时间字段都没有，
    前端拿不到就编不出来。时间戳在模型上（TimestampMixin）一直有，只是没暴露——
    这类「后端有数据、契约没给」的缺口最容易被两边各自绕过去，所以钉一条。
    """
    from datetime import UTC, datetime, timedelta

    from app.modules.scenario.models import Scenario

    _, h, pid = await _setup(client, make_user, "TS")
    sc = await _mk(client, h, pid, name="有时间")
    got = (await client.get("/api/v1/scenarios/" + sc["id"], params={"project_id": pid},
                            headers=h)).json()
    assert got["created_at"] and got["updated_at"], got
    # naive UTC 存储，但对外必须带时区标记：不补 Z 前端 new Date() 会按本地时区差 8 小时
    assert got["created_at"].endswith("+00:00") or got["created_at"].endswith("Z"), got["created_at"]

    row = await session.get(Scenario, sc["id"])
    row.updated_at = datetime.now(UTC).replace(tzinfo=None) + timedelta(hours=3)
    await session.commit()
    lst = (await client.get("/api/v1/scenarios", params={"project_id": pid}, headers=h)).json()["items"]
    assert lst[0]["updated_at"] != lst[0]["created_at"], "列表也得跟着变，不能只 get 有"
