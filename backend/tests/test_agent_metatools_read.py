"""1F T1 读类元工具三件：get_project_outline / search_test_assets / search_tools。

钉的行为（1F 计划 T1 checkbox 逐条对账）：
① outline 计数与 workbench 端点交叉断言（同一批种子数据，五类交集逐键相等——
   一把尺两份实现的「数字会不会打架」就钉在这一条上）；
② 回收资产经 search_test_assets 不可见（visible_clause 回归，search 同尺）+
   定义回收拖死其 normal 用例（assert_def_alive 同口径）；
③ 越权/非成员项目 → ApiError forbidden/403（与 search 的 ensure_project_access 同码）；
④ LIKE 转义判别行：q="100%" 不许匹配「报告 1000」，q="a_b" 不许匹配「流程 axb 编号」
   （test_search.py:150-169 同款判别行，这里走元工具面）；
⑤ search_tools 命中/空命中形状 + 权限过滤（READONLY 权限位吃不到的声明不外泄）；
⑥ 卡片五件已是真 handler（T2 落地批的同批反向钉，见 test_card_tools_no_longer_skeleton）；
⑦ 截断可观测（outline 超预算 → meta.truncated/modules_cut，不静默）；
⑧ PLAN 模式可用（D31：三件 effect=read，dispatcher 模式门放行）。
"""
from __future__ import annotations

import pytest

from app.core.errors import ApiError
from app.core.registry import REGISTRY
from app.core.service import ServiceCtx
from app.modules.agent.dispatcher import ToolDispatcher
from app.modules.agent.metatools.read_tools import (
    GetProjectOutlineIn,
    SearchTestAssetsIn,
    SearchToolsIn,
    get_project_outline,
    search_test_assets,
    search_tools,
)


async def test_card_tools_no_longer_skeleton(client, make_user, session) -> None:
    """⑥ 反向钉（T2 落地批）：卡片五件从骨架换成真 handler。

    同批翻钉（T1 留的 test_card_tools_still_skeleton 到此作废）：
    - handler.__module__ 落在 card_tools（装配真的取了真件，不是骨架闭包）；
    - 四件常规件经 dispatcher 真调用 ok=True 且 ui=="card"（D31：PLAN 档可用）；
    - propose_scenario_plans 用骨架期的糊弄参数（单方案无 graph）→ 拿到的是
      校验拒绝的人话 error，不是 NotImplementedError（真件在工作）。
    """
    from app.modules.agent.metatools import card_tools as _ct

    boss, h, pid = await _setup(client, make_user, "K1")
    ctx = ServiceCtx(entry="agent", user_id=boss.id, perms={"*"}, db=session, session_id="k1-sess")
    disp = ToolDispatcher(session)
    cases = {
        "ask_user": {"question": "跑哪个环境？", "options": ["本地", "日常"]},
        "propose_plan": {"items": [{"id": "1", "text": "盘点资产"}]},
        "update_plan_item": {"id": "1", "state": "done"},
        "suggest_open_page": {"route": "/bench"},
    }
    for name, args in cases.items():
        spec = REGISTRY.get(name)
        assert spec is not None
        assert spec.handler.__module__ == _ct.__name__, f"{name} 还挂在骨架 handler 上"
        r = await disp.call(name, args, ctx, mode="PLAN", grants=set())
        assert r.ok is True, f"{name}: {r.error}"
        assert r.ui == "card"
    r = await disp.call("propose_scenario_plans",
                        {"project_id": pid, "plans": [{"name": "x"}]}, ctx, mode="PLAN", grants=set())
    assert r.ok is False and "NotImplementedError" not in (r.error or "")
    assert "候选方案" in (r.error or ""), "骨架参数要拿到校验人话，不是未实现异常"


async def _setup(client, make_user, tag):
    boss, hb = await make_user("mt1boss" + tag)
    r = await client.post("/api/v1/projects", json={"name": "mt1p" + tag}, headers=hb)
    assert r.status_code == 201, r.text
    return boss, hb, r.json()["id"]


async def _mk_login_trio(client, h, pid):
    """一套「登录」资产：定义 + 用例 + 场景（test_search 同款夹具形状）。"""
    d = await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "登录接口", "method": "POST", "path": "/login",
        "request": {"method": "POST", "url": "http://t/login"}})
    assert d.status_code == 201, d.text
    did = d.json()["id"]
    c = await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": did, "name": "登录成功用例"})
    assert c.status_code == 201, c.text
    g = {"version": 1, "nodes": [{"key": "s1", "kind": "set_var", "name": "s1",
                                  "config": {"vars": {"a": "1"}}}]}
    s = await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "登录冒烟场景", "step_graph": g})
    assert s.status_code == 201, s.text
    return did, c.json()["id"], s.json()["id"]


def _ctx(user, session) -> ServiceCtx:
    return ServiceCtx(entry="agent", user_id=user.id, perms={"*"}, db=session)


async def test_outline_counts_match_workbench(client, make_user, session) -> None:
    """① 交叉断言（计划点名的一次）：同一批种子数据，outline 与 workbench 端点逐键相等。

    五类交集（workbench AssetCounts 不数 ui_element，outline 多数的一类不参与对账）。
    走 dispatcher 的 PLAN 档顺带钉⑧（D31：effect=read 的元工具 PLAN 可用）。
    """
    boss, h, pid = await _setup(client, make_user, "X1")
    await _mk_login_trio(client, h, pid)
    d2 = await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "登出接口", "method": "POST", "path": "/logout",
        "request": {"method": "POST", "url": "http://t/logout"}})
    assert d2.status_code == 201, d2.text
    # ui_case / adb_case 直插（与 test_search._mk_ui_rows 同法：读侧只读表，测侧造表行）
    from app.modules.adb_test.models import AdbCase
    from app.modules.ui_test.models import UiCase

    session.add_all([
        UiCase(project_id=pid, name="登录页UI用例", priority="P1",
               steps=[{"id": "c1", "type": "open", "input": "http://t"}]),
        AdbCase(project_id=pid, name="登录页ADB用例", priority="P2", step_count=0,
                steps=[{"id": "a1", "type": "shell", "config": {"cmd": "echo ok"}}]),
    ])
    await session.commit()

    wb = await client.get("/api/v1/workbench-stats", params={"project_id": pid}, headers=h)
    assert wb.status_code == 200, wb.text
    wb_assets = wb.json()["assets"]

    disp = ToolDispatcher(session)
    r = await disp.call("get_project_outline", {"project_id": pid}, _ctx(boss, session),
                        mode="PLAN", grants=set())
    assert r.ok is True, r.error  # ⑧ PLAN 可用（D31）
    outline_assets = r.content["assets"]
    for kind in ("api_definition", "api_case", "scenario", "ui_case", "adb_case"):
        assert outline_assets[kind] == wb_assets[kind], (
            f"{kind}: outline={outline_assets[kind]} vs workbench={wb_assets[kind]} 口径打架")
    assert outline_assets["api_definition"] == 2 and outline_assets["api_case"] == 1
    assert outline_assets["scenario"] == 1 and outline_assets["ui_case"] == 1
    assert outline_assets["adb_case"] == 1
    # 计数承诺完整：聚合值永不截断
    assert r.content["meta"]["assets_complete"] is True


async def test_outline_sees_module_tree(client, make_user, session) -> None:
    """outline 的模块树：四棵树各归各的 tree，路径含祖先名。"""
    from app.modules.api_test.models import ApiModule
    from app.modules.scenario.models import ScenarioModule

    boss, h, pid = await _setup(client, make_user, "X2")
    top = ApiModule(project_id=pid, name="交易域")
    session.add(top)
    await session.flush()
    session.add(ApiModule(project_id=pid, parent_id=top.id, name="下单"))
    session.add(ScenarioModule(project_id=pid, name="回归"))
    await session.commit()

    r = await get_project_outline(GetProjectOutlineIn(project_id=pid), _ctx(boss, session))
    by_name = {n.name: n for n in r.modules}
    assert by_name["交易域"].tree == "api" and by_name["下单"].tree == "api"
    assert by_name["回归"].tree == "scenario"
    assert by_name["下单"].path == "交易域/下单"
    assert by_name["下单"].parent_id == by_name["交易域"].id


async def test_outline_truncation_is_observable(client, make_user, session) -> None:
    """⑦ 截断可观测：塞 40 个长名模块 → meta.truncated=True 且 cut 数与总数对账得上。"""
    from app.modules.api_test.models import ApiModule

    boss, h, pid = await _setup(client, make_user, "X3")
    long_name = "很长的模块名字用来撑爆预算" * 6  # ~96 字符/节点，40 个 >> 4000 字符预算
    for i in range(40):
        session.add(ApiModule(project_id=pid, name=f"{long_name}{i:02d}"))
    await session.commit()

    r = await get_project_outline(GetProjectOutlineIn(project_id=pid), _ctx(boss, session))
    meta = r.meta
    assert meta.truncated is True, "超预算必须报截断，静默截断=骗模型"
    assert meta.modules_total == 40 and meta.modules_returned < 40
    assert meta.modules_cut == meta.modules_total - meta.modules_returned > 0
    assert meta.chars_used <= meta.char_budget
    # 计数不受截断影响（承诺：聚合值永不截断）
    assert meta.assets_complete is True


async def test_search_respects_recycled(client, make_user, session) -> None:
    """② 回收不可见（visible_clause/status 回归）+ 回收前「本来在」的回归前提。"""
    boss, h, pid = await _setup(client, make_user, "S1")
    did, cid, sid = await _mk_login_trio(client, h, pid)
    ok = await search_test_assets(SearchTestAssetsIn(project_id=pid, keyword="登录"),
                                  _ctx(boss, session))
    assert {x.id for x in ok.items} == {did, cid, sid}
    # 用例回收端点按 definition_id 定位（定义回收后连回收都做不动），故先收用例再收定义
    for path, ident in (("/api-cases/", cid), ("/scenarios/", sid), ("/api-definitions/", did)):
        rr = await client.post("/api/v1" + path + ident + "/delete",
                               json={"project_id": pid}, headers=h)
        assert rr.status_code == 200, rr.text
    out = await search_test_assets(SearchTestAssetsIn(project_id=pid, keyword="登录"),
                                   _ctx(boss, session))
    assert out.items == [], "回收资产不得出现在元工具搜索结果（visible_clause 回归）"
    assert out.meta.mode == "keyword"


async def test_search_case_under_recycled_definition(client, make_user, session) -> None:
    """② 半件：用例本身 normal，定义回收 → 整体不可达（search/assert_def_alive 同尺）。"""
    boss, h, pid = await _setup(client, make_user, "S2")
    did, cid, _ = await _mk_login_trio(client, h, pid)
    rr = await client.post("/api/v1/api-definitions/" + did + "/delete",
                           json={"project_id": pid}, headers=h)
    assert rr.status_code == 200, rr.text
    out = await search_test_assets(SearchTestAssetsIn(project_id=pid, keyword="登录成功"),
                                   _ctx(boss, session))
    assert out.items == [], "回收定义下的 normal 用例不得出现在元工具搜索结果"
    assert cid  # 判别对象就是用例本身（行状态没变，被定义拖死）


async def test_search_d34_meta_and_kind_narrowing(client, make_user, session) -> None:
    """D34 诚实标注：meta.mode 恒为 keyword（只有一路，不装双路）；kind 收窄生效。"""
    boss, h, pid = await _setup(client, make_user, "S3")
    await _mk_login_trio(client, h, pid)
    out = await search_test_assets(SearchTestAssetsIn(project_id=pid, keyword="登录"),
                                   _ctx(boss, session))
    assert out.meta.mode == "keyword"
    out2 = await search_test_assets(
        SearchTestAssetsIn(project_id=pid, keyword="登录", kind="scenario"),
        _ctx(boss, session))
    assert [x.kind for x in out2.items] == ["scenario"]
    assert out2.meta.mode == "keyword"


async def test_search_private_visibility_same_ruler(client, make_user, session) -> None:
    """可见性同把尺（visible_clause 直接回归）：别人的私有行不可见，owner 自己可见。

    MEMBER（非项目管理员，谓词真实生效）搜 boss 的私有定义 → 空；boss 自己 → 命中。
    """
    boss, h, pid = await _setup(client, make_user, "S6")
    d = await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "私有登录口", "method": "POST", "path": "/plogin",
        "request": {"method": "POST", "url": "http://t/p"}, "project_public": False})
    assert d.status_code == 201, d.text
    mem, hm = await make_user("mt1memS6")
    rr = await client.put("/api/v1/projects/" + pid + "/members/" + mem.id,
                          json={"role_code": "MEMBER"}, headers=h)
    assert rr.status_code == 200, rr.text
    # 走 HTTP 把 MEMBER 的 perms 解析进 ctx 的路径由 ensure_project_access 做；
    # 这里直接构造 ctx 复刻同款：MEMBER 的 perms（无 delete 位 → 非项目管理员 → 谓词生效）
    mem_ctx = ServiceCtx(entry="agent", user_id=mem.id, db=session,
                         perms={"*", "-*:delete", "-*:manage", "-system:*"})
    out = await search_test_assets(SearchTestAssetsIn(project_id=pid, keyword="私有登录"),
                                   mem_ctx)
    assert out.items == [], "别人的私有定义在元工具面同样不可见"
    boss_out = await search_test_assets(SearchTestAssetsIn(project_id=pid, keyword="私有登录"),
                                        _ctx(boss, session))
    assert [x.id for x in boss_out.items] == [d.json()["id"]]


async def test_module_narrowing_and_honest_miss(client, make_user, session) -> None:
    """module 收窄：命中模块只回其下资产；不存在的模块 id → 空 + module_matched=False。"""
    from app.modules.api_test.models import ApiModule

    boss, h, pid = await _setup(client, make_user, "S5")
    did, _, _ = await _mk_login_trio(client, h, pid)
    m = ApiModule(project_id=pid, name="交易域")
    session.add(m)
    await session.flush()
    d2 = await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "登录接口V2", "method": "POST", "path": "/login2",
        "request": {"method": "POST", "url": "http://t/l2"}, "module_id": m.id})
    assert d2.status_code == 201, d2.text
    await session.commit()

    out = await search_test_assets(
        SearchTestAssetsIn(project_id=pid, keyword="登录", module=m.id), _ctx(boss, session))
    assert [x.id for x in out.items] == [d2.json()["id"]], "module 收窄只回该模块下的资产"
    assert out.meta.module_matched is True
    miss = await search_test_assets(
        SearchTestAssetsIn(project_id=pid, keyword="登录", module="no-such-module"),
        _ctx(boss, session))
    assert miss.items == [] and miss.meta.module_matched is False, \
        "模块不存在要说「模块没找到」，不能装作项目里没有资产"
    assert did


async def test_project_denial_matches_search_code(client, make_user, session) -> None:
    """③ 越权 = 与 search 同码：ensure_project_access 的 forbidden/403（非成员与不存在同码）。"""
    _, h, pid = await _setup(client, make_user, "S4")
    outsider, _ = await make_user("mt1outS4")
    with pytest.raises(ApiError) as ei:
        await search_test_assets(SearchTestAssetsIn(project_id=pid, keyword="x"),
                                 _ctx(outsider, session))
    assert ei.value.code == "forbidden" and ei.value.http_status == 403
    with pytest.raises(ApiError) as ei2:
        await get_project_outline(GetProjectOutlineIn(project_id=pid), _ctx(outsider, session))
    assert ei2.value.code == "forbidden" and ei2.value.http_status == 403
    # 不存在的项目与越权同码（不泄露存在性）
    with pytest.raises(ApiError) as ei3:
        await get_project_outline(GetProjectOutlineIn(project_id="no-such-project"),
                                  _ctx(outsider, session))
    assert ei3.value.code == "forbidden" and ei3.value.http_status == 403


async def test_like_escaping_with_discriminator_rows(client, make_user, session) -> None:
    """④ 判别行同款钉法：含「100」不含「100%」的行必须不命中 q="100%"；
    「axb」必须不命中 q="a_b"——未转义时 % 匹配一切、_ 通配顶替任意单字符。"""
    boss, h, pid = await _setup(client, make_user, "L1")
    d = await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "覆盖率 100% 报告", "method": "GET", "path": "/cov",
        "request": {"method": "GET", "url": "http://t/cov"}})
    did = d.json()["id"]
    # 判别行 A：含 "100" 不含 "100%"——未转义 "%100%%" 会把它也捞进来
    await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "报告 1000", "method": "GET", "path": "/rep",
        "request": {"method": "GET", "url": "http://t/rep"}})
    # 判别行 B：字面 a_b 行 + 近似 axb 行——未转义时 "_b" 的单字符通配会把 axb 顶进来
    d2 = await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "流程 a_b 编号", "method": "GET", "path": "/ab",
        "request": {"method": "GET", "url": "http://t/ab"}})
    ab_id = d2.json()["id"]
    await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "流程 axb 编号", "method": "GET", "path": "/axb",
        "request": {"method": "GET", "url": "http://t/axb"}})

    r1 = await search_test_assets(SearchTestAssetsIn(project_id=pid, keyword="100%"),
                                  _ctx(boss, session))
    assert [x.id for x in r1.items] == [did], "LIKE 通配符必须转义，否则 % 匹配一切"
    r2 = await search_test_assets(SearchTestAssetsIn(project_id=pid, keyword="a_b"),
                                  _ctx(boss, session))
    assert [x.id for x in r2.items] == [ab_id], \
        "下划线必须按字面匹配：只中 a_b，不许把 axb 顶替进来"


async def test_search_tools_hit_and_empty_shapes(client, make_user, session) -> None:
    """⑤ search_tools：命中回声明 JSON（当轮载入的形状），空命中 items=[] 且 meta 对账。"""
    boss, h, pid = await _setup(client, make_user, "T1")
    out = await search_tools(SearchToolsIn(keyword="workbench"), _ctx(boss, session))
    names = {x.name for x in out.items}
    assert "workbench_stats" in names
    decl = next(x for x in out.items if x.name == "workbench_stats")
    assert decl.json_schema and decl.perm == "workbench:read" and decl.effect == "read"
    assert out.meta.total_matched >= 1 and out.meta.returned == len(out.items)
    assert out.meta.mode == "keyword"
    empty = await search_tools(SearchToolsIn(keyword="zzz_不存在的工具词"), _ctx(boss, session))
    assert empty.items == [] and empty.meta.total_matched == 0
    assert empty.meta.returned == 0 and empty.meta.truncated is False
    # 空白关键词 → 422（撑爆上下文的入口要挡：min_length 挡不住全空白）
    with pytest.raises(ApiError) as ei:
        await search_tools(SearchToolsIn(keyword="   "), _ctx(boss, session))
    assert ei.value.http_status == 422


async def test_search_tools_respects_perms(client, make_user, session) -> None:
    """⑤ 权限过滤（list_tools 语义）：READONLY 位集下写工具声明不外泄，读工具声明在场。"""
    boss, h, pid = await _setup(client, make_user, "T2")
    ro_ctx = ServiceCtx(entry="agent", user_id=boss.id, db=session,
                        perms={"agent:meta:read", "*:read"})
    out = await search_tools(SearchToolsIn(keyword="api_definition_create"), ro_ctx)
    assert out.items == [], "写工具声明不得出现在只读权限位的检索结果里（§9.4）"
    out2 = await search_tools(SearchToolsIn(keyword="api_definition_list"), ro_ctx)
    assert any(x.name == "api_definition_list" for x in out2.items)
    # 连 agent:meta:read 都没有 → 403（本工具自己的权限位）
    with pytest.raises(ApiError) as ei:
        await search_tools(SearchToolsIn(keyword="workbench"),
                           ServiceCtx(entry="agent", user_id=boss.id, db=session, perms=set()))
    assert ei.value.http_status == 403
