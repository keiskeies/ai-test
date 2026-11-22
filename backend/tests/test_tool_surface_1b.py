"""T23 工具面回归钉：1B 新工具/权限点/PLAN 门/契约登记/seed 场景，一次钉死。

计划 Task 23 的六项断言（⑥ 是重点，「4 kept」必须是被数出来的 4，不是漏数漏出来的 4）：
  ① 1B 新工具出现在 admin 工具面（注册表→HTTP→工具声明一鱼三吃不再漂）；
  ② scenario_run 的 effect=write → PLAN 模式被拒（§9.4 效果门按 effect 不按名字）；
  ③ scenario_purge / api_case_resolve / scenario_case_refs 不在任何角色的工具面；
  ④ perm_point 表同步出 scenario:* 全集（sync 幂等）；
  ⑤ READONLY 能 report_list、不能 scenario_run（工具面 + HTTP 双层都钉）；
  ⑥ lint-imports 契约清单**真的包含** scenario 与 search——契约「kept」的前提是
     模块被登记；漏登记时 lint 全绿但那个模块根本没被扫（假绿，计划风险 #7）。
     本测试直接解析 pyproject：不跑 lint 子进程（门禁跑它），只钉登记事实。

外加 seed_demo 的 1B 场景：4 步演示场景（登录 → 提取 token → 循环查单 while → 断言）
预置幂等——跑两遍不重复（seed 对演示库的既定承诺，测试库上验证形状与幂等）。
"""
from __future__ import annotations

NEW_TOOLS = [
    "scenario_create", "scenario_update", "scenario_list", "scenario_get",
    "scenario_delete", "scenario_run", "scenario_debug", "run_rerun_step",
    "scenario_references", "report_list", "report_get", "run_cancel", "search_assets",
]
NOT_TOOLS = ["scenario_purge", "api_case_resolve", "scenario_case_refs",
             "api_case_purge", "api_definition_purge"]


async def _setup(client, make_user, tag, *, admin=False):
    boss, hb = await make_user(("ts1bsys" if admin else "ts1bboss") + tag, admin=admin)
    r = await client.post("/api/v1/projects", json={"name": "pt1b" + tag}, headers=hb)
    return boss, hb, r.json()["id"]


async def test_1b_tool_surface(client, make_user) -> None:
    """① 1B 新工具在 admin 工具面；effect 口径钉死。"""
    _, h, pid = await _setup(client, make_user, "A", admin=True)
    r = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    by_name = {t["name"]: t for t in r.json()["items"]}
    for n in NEW_TOOLS:
        assert n in by_name, "工具面缺失: " + n
    assert by_name["scenario_run"]["effect"] == "write"
    assert by_name["scenario_debug"]["effect"] == "write"
    assert by_name["scenario_delete"]["effect"] == "destructive"
    assert by_name["search_assets"]["effect"] == "read"
    # ③ 同场钉：内部件与 purge 类不许出现在工具面
    for n in NOT_TOOLS:
        assert n not in by_name, "tool=False 的工具漏进了工具面: " + n


async def test_1b_plan_mode_rejects_run(client, session, make_user) -> None:
    """② PLAN 拒 scenario_run、放行 scenario_list（门按 effect，不一刀切）。"""
    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import ToolDispatcher

    boss, _h, pid = await _setup(client, make_user, "B")
    disp = ToolDispatcher(session)
    ctx = ServiceCtx(entry="agent", user_id=boss.id, perms={"*"}, db=session)
    r = await disp.call("scenario_run", {"project_id": pid, "scenario_id": "x"},
                        ctx, mode="PLAN", grants=set())
    assert r.ok is False and "只读" in (r.error or "")
    r2 = await disp.call("scenario_list", {"project_id": pid}, ctx,
                         mode="PLAN", grants=set())
    assert r2.ok is True, r2.error


async def test_1b_perm_points_synced(session) -> None:
    """④ sync_perm_points 把 scenario:*（含 module 树与 run）全落 perm_point，且幂等。"""
    from sqlalchemy import select

    from app.core.registry import REGISTRY
    from app.modules.iam.models import PermPoint
    from app.modules.iam.registry_sync import sync_perm_points

    n = await sync_perm_points(session)
    assert n > 0
    codes = {r for (r,) in (await session.execute(select(PermPoint.code))).all()}
    for p in ("scenario:read", "scenario:create", "scenario:update",
              "scenario:delete", "scenario:run", "search:read"):
        assert p in codes, "权限点未入库: " + p
    scen = {c for c in codes if c.startswith("scenario:")}
    assert {"scenario:module:create", "scenario:module:update",
            "scenario:module:delete", "scenario:module:read"} <= scen, scen
    assert REGISTRY.perm_points() <= codes
    assert await sync_perm_points(session) == 0  # 幂等


async def test_1b_readonly_can_report_cannot_run(client, make_user) -> None:
    """⑤ READONLY：report_list 可见可呼，scenario_run 不可见（HTTP 层 403 兜底）。"""
    _, h, pid = await _setup(client, make_user, "C")
    ro, ho = await make_user("ts1bro")
    await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                     json={"role_code": "READONLY"}, headers=h)
    r = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=ho)
    names = {t["name"] for t in r.json()["items"]}
    assert "report_list" in names and "search_assets" in names
    assert "scenario_run" not in names and "scenario_create" not in names
    # 工具面只是声明；执行面必须同样拦住
    rr = await client.post("/api/v1/scenarios/nope/run", headers=ho,
                           json={"project_id": pid})
    assert rr.status_code == 403, rr.text
    rl = await client.get("/api/v1/reports", params={"project_id": pid}, headers=ho)
    assert rl.status_code == 200, rl.text


# —— ⑥ 契约登记：被数出来的 4 kept，不是漏数漏出来的 4 kept ——————————————

def _pyproject_contracts() -> dict:
    import tomllib
    from pathlib import Path

    p = Path(__file__).resolve().parents[1] / "pyproject.toml"
    data = tomllib.loads(p.read_text(encoding="utf-8"))
    out = {}
    for c in data["tool"]["importlinter"]["contracts"]:
        out[c["name"]] = c
    return out


def test_1b_contract_membership_not_undercounted() -> None:
    """⑥ scenario/search 的登记事实：契约清单少一个名字，「4 kept」就是假绿。

    本测试不跑 lint 子进程（CI/门禁跑真 lint-imports，R80：要的是它打印的
    「Contracts: 4 kept, 0 broken」，不是 exit code）——它钉的是**登记**：
    - 契约 1（模块独立性）清单必须含 app.modules.scenario：漏了它，scenario
      与 api_test/iam 的横向 import 无人看守，「independence kept」在漏数；
    - 契约 3（领域模块不得反依赖 agent）清单必须含 scenario 与 search；
    - search 是 composition 模块（与 agent 同类，R26），**不许**进契约 1
      （它按设计 import api_test/scenario 的 models，进了契约 1 就是自炸）。
    """
    cs = _pyproject_contracts()
    ind = next(c for c in cs.values() if c["type"] == "independence")
    forbidden = [c for c in cs.values() if c["type"] == "forbidden"]
    ind_mods = set(ind["modules"])
    assert "app.modules.scenario" in ind_mods, \
        "契约 1 漏登记 scenario：独立性契约没扫它，kept 是漏数撑的假绿"
    agent_c3 = next(c for c in forbidden if c["forbidden_modules"] == ["app.modules.agent"])
    assert "app.modules.scenario" in agent_c3["source_modules"], "契约 3 漏登记 scenario"
    assert "app.modules.search" in agent_c3["source_modules"], "契约 3 漏登记 search"
    assert "app.modules.search" not in ind_mods, \
        "search 是 composition 层（正向读领域模型），进契约 1 必假炸"


# —— seed_demo：4 步演示场景 + 幂等 —————————————————————————

def test_seed_demo_scenario_shape() -> None:
    import importlib.util
    from pathlib import Path

    from app.modules.scenario.graph import validate

    p = Path(__file__).resolve().parents[1] / "scripts" / "seed_demo.py"
    spec = importlib.util.spec_from_file_location("seed_demo_t23", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert callable(mod.main)
    assert callable(mod.demo_scenario_graph)
    g = mod.demo_scenario_graph("case-login", "case-query")
    assert validate(g) == [], "演示场景必须过 T4 校验零 issue：" + str(validate(g))
    kinds = [n["kind"] for n in g["nodes"]]
    assert kinds == ["api_case", "extract", "loop", "assert"], kinds
    assert g["nodes"][2]["children"][0]["kind"] == "api_case"
    assert g["nodes"][2]["config"]["mode"] == "while"
    assert mod.DEMO_SCENARIO


async def test_seed_demo_scenario_idempotent(client, make_user, session) -> None:
    """seed 跑两遍：演示场景恰好一条，且不重复建任何资产。

    跑在测试库（conftest 已把 TP_DB_URL 指到本轮 schema；seed 用全局 maker，
    pool_pre_ping 会替我们丢弃跨 loop 的死连接——既有测试同法用 get_sessionmaker）。

    **第二遍读之前必须 rollback（T23 裁定收紧，原型的读法是假证明）**：seed 跑在
    **另一条连接**上并自己 commit，而本 session 第一次 select 之后就一直待在同一个
    只读事务里；MySQL 默认 REPEATABLE READ 下它看不到那条连接新提交的行。
    实测（一次性探针，跑完即删）：另一条连接插一行并提交后，本 session 不 rollback
    读到 4、rollback 之后读到 5，隔离级别打印为 REPEATABLE-READ。
    也就是说改之前那句 `len(second) == 1` 只证明了「第一遍的形状」，
    「第二遍没重复建」根本没被执行到——**它不可能红**。
    1C 的种子测试（`test_tool_surface_1c.py::test_seed_demo_ui_idempotent`）先撞出这条并
    用 rollback-before-reread 修好；同一条理由回到原型这里（计划 T20 那条遗留，T23 裁）。
    """
    import importlib.util
    from pathlib import Path

    from sqlalchemy import func, select

    from app.modules.api_test.models import ApiDefinition
    from app.modules.scenario.graph import validate
    from app.modules.scenario.models import Scenario

    p = Path(__file__).resolve().parents[1] / "scripts" / "seed_demo.py"
    spec = importlib.util.spec_from_file_location("seed_demo_t23b", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    assert await mod.main() == 0
    first = (await session.execute(
        select(Scenario).where(Scenario.name == mod.DEMO_SCENARIO))).scalars().all()
    assert len(first) == 1, "seed 第一遍应建且仅建一条演示场景"
    s = first[0]
    s_id = s.id  # 标量先取：下面 rollback 会过期 ORM 实例，再碰属性就是 greenlet 外的惰性刷新
    kinds = [n["kind"] for n in s.step_graph["nodes"]]
    assert kinds == ["api_case", "extract", "loop", "assert"]
    assert validate(s.step_graph) == []
    n_defs = await session.scalar(select(func.count()).select_from(ApiDefinition))

    await session.rollback()  # 结束读事务，让第二遍的读看到新快照
    assert await mod.main() == 0
    await session.rollback()
    # 只回 id 标量：identity map 会把命中行返回成已过期的旧实例，碰它就是 MissingGreenlet
    ids = (await session.execute(select(Scenario.id).where(
        Scenario.name == mod.DEMO_SCENARIO))).scalars().all()
    assert len(ids) == 1, "seed 第二遍不许重复建场景（幂等承诺）"
    assert ids[0] == s_id
    n_defs2 = await session.scalar(select(func.count()).select_from(
        __import__("app.modules.api_test.models", fromlist=["ApiDefinition"]).ApiDefinition))
    assert n_defs2 == n_defs, "第二遍也不许重复建接口"
