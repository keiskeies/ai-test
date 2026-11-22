"""1F T5 · 假模型回放钉死「3 轮内 ≥2 卡」——一期 DoD 判据第 1 条（§1.5 :51）。

夹具（tests/fixtures/fake_model/two_candidate_plans.jsonl）在演示形状 seed 上走
FakeGateway 全链：单 run 内 thinking → get_project_outline → search_test_assets →
propose_plan → propose_scenario_plans（两方案，asset id 全部走 {{TR:...}} 链式引用）
→ 收敛 TEXT。TR 机制（gateway.py :64：源工具没结果就抛）让「基于项目真实资产」
机器可检——夹具编不出不存在的 id。

钉的五条（计划 T5 checkbox 逐条对账）：
① run 走到 DONE；
② TOOL_RESULT(ui="card", card.kind="scenario_plans") 事件里 plans.length ≥ 2——
   红了就是「≥2 卡」的卡片面没有兑现；
③ plans 里每个 graph ref 用与 card_tools._resolve_ref_names 同一把尺
   （project + 非回收 + visible_clause）再真查一次库——只断字段非空是假绿，
   查得到才算「基于项目真实资产」；
④ 用户消息回合数 ≤ 3（D35 从严：单 run = 1 轮）——USER 事件恰 1 条 + AgentRun 恰 1 行；
⑤ 审计里 propose_scenario_plans / get_project_outline / search_test_assets（外加
   propose_plan）各有一行 entry="agent" 且 ok=True。

六 · 回归夹具 ask_user_flow：ask_user 出卡后 run 直接 DONE、无 APPROVAL_REQ/
    审批行（D32「不挂起」的形状钉）。

变异自证（计划点名「宁抛不装绿」，两条通路各一枚可复跑的机器钉；
仓库夹具本体不动，改的是 tmp_path 里的副本）：
- 字面假 id 变异：字面 id 绕得开 gateway :64（那里只保「引用尚无结果的工具」），
  但绕不开 card_tools 的可见性硬门 → propose_scenario_plans ok=False + error 含
  「不可见」→ scenario_plans 卡不出现 → 主例断言 ②（ui=="card"/plans≥2）红；
- TR 源变异：引用指向没跑过的工具 → FakeGateway 在 yield 前抛 KeyError
  （gateway.py :64 原文「TR 引用了尚无结果的工具」）→ run 落 ERROR → 主例断言 ① 红。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest_asyncio

FIXTURE = "fake://two_candidate_plans"
ASK_FIXTURE = "fake://ask_user_flow"


def _fixture_dir() -> Path:
    from app.shared.fakeuri import FIXTURE_DIR

    return Path(FIXTURE_DIR)
GHOST = "00000000-0000-4000-8000-000000000000"
DOD_TOOLS = ("propose_scenario_plans", "get_project_outline", "search_test_assets", "propose_plan")


@pytest_asyncio.fixture()
async def bus():
    import fakeredis.aioredis

    from app.core.eventbus import init_bus

    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    b = init_bus(client=r)
    yield b
    await b.aclose()


async def _seed(client, make_user, tag) -> tuple:
    """演示形状 seed：owner + 项目 + 两条「登录」用例（DoD 判据的资产底座）。"""
    from app.modules.agent.models import AgentSession

    owner, h = await make_user("dod" + tag)
    r = await client.post("/api/v1/projects", json={"name": "dodp" + tag}, headers=h)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    case_ids: list[str] = []
    for name in ("登录成功用例", "登录失败锁定用例"):
        d = await client.post("/api/v1/api-definitions", headers=h, json={
            "project_id": pid, "name": "登录接口-" + name, "method": "POST", "path": "/login",
            "request": {"method": "POST", "url": "http://t/login"}})
        assert d.status_code == 201, d.text
        c = await client.post("/api/v1/api-cases", headers=h, json={
            "project_id": pid, "definition_id": d.json()["id"], "name": name})
        assert c.status_code == 201, c.text
        case_ids.append(c.json()["id"])

    me = (await client.get("/api/v1/auth/me", headers=h)).json()
    sess = AgentSession(project_id=pid, user_id=me["id"], title="DoD 判据回放", mode="PLAN")
    return owner, h, pid, case_ids, sess


async def _replay(engine, session, sess, fixture: str) -> dict[str, Any]:
    """FakeGateway 全链回放一次，回 {run, runs, events, session}。

    夹具会话（请求级 session）的 REPEATABLE-READ 快照停在 seed 期：先 rollback 放快照，
    之后的 REST/直查才看得见 run 期间的新行（与 test_agent_metatools_cards 同款处理）。
    s2 用完即关：未决的 FOR UPDATE 会话锁会卡住 conn 夹具 teardown 的 TRUNCATE。
    """
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.modules.agent import store
    from app.modules.agent.dispatcher import ToolDispatcher
    from app.modules.agent.gateway import FakeGateway
    from app.modules.agent.models import AgentRun
    from app.modules.agent.runner import AgentRunner

    src = _fixture_dir() / (fixture.removeprefix("fake://") + ".jsonl")
    async with AsyncSession(bind=engine, expire_on_commit=False) as s2:
        s2.add(sess)
        await s2.commit()
        await store.append_event(s2, sess.id, None, "USER", {"text": "创建一个登录功能的回归测试"})
        runner = AgentRunner(gateway=FakeGateway(src, project_id=sess.project_id),
                             dispatcher=ToolDispatcher(s2))
        await runner.run_turn(sess.id)
        runs = (await s2.execute(select(AgentRun).where(AgentRun.session_id == sess.id))).scalars().all()
        events = await store.replay(s2, sess.id, 0)
    await session.rollback()
    return {"run": runs[0], "runs": runs, "events": events, "session": sess}


def _tool_results(events: list[dict]) -> dict[str, dict]:
    return {e["payload"]["tool_name"]: e for e in events if e["type"] == "TOOL_RESULT"}


def _scenario_plans_cards(trs: dict[str, dict]) -> list[dict]:
    """事件流里成功出卡的 scenario_plans 卡（主例 ② 的取值路径原样搬来）。"""
    return [e for e in trs.values()
            if e["payload"].get("ui") == "card"
            and e["payload"].get("content", {}).get("card", {}).get("kind") == "scenario_plans"]


def _plan_refs(plans: list[dict]) -> list[tuple[str, str]]:
    """plans → [(ref, kind)]：与 card_tools 同用 scenario/graph.iter_nodes 的遍历口径。"""
    from app.modules.scenario import graph as scenario_graph

    refs: list[tuple[str, str]] = []
    for plan in plans:
        for node, _p, _d in scenario_graph.iter_nodes(plan["graph"]):
            kind = str(node.get("kind") or "")
            if kind in ("api_case", "ui_case", "adb_case"):
                refs.append((str(node.get("ref")), kind))
    return refs


def _owner_ctx(owner_id: str, session):
    from app.core.service import ServiceCtx

    # owner 建项目即 PROJECT_ADMIN（perms=["*"]）；match_perm 的 "*" 全配 → 可见性谓词恒真
    return ServiceCtx(entry="agent", user_id=owner_id, perms={"*"}, db=session)


# —— DoD 判据第 1 条主钉：①②③④⑤ ——

async def test_dod_single_run_two_plans_real_assets(client, make_user, session, engine, bus) -> None:
    from sqlalchemy import select

    from app.modules.agent.models import AgentRun
    from app.modules.api_test.models import ApiCase
    from app.modules.audit.models import AuditLog
    from app.shared.visibility import visible_clause

    owner, _h, pid, case_ids, sess = await _seed(client, make_user, "A")
    owner_id = owner.id  # _replay 末尾的 rollback 会过期 owner 行对象：id 先留在手里
    out = await _replay(engine, session, sess, FIXTURE)
    run, events = out["run"], out["events"]
    assert isinstance(run, AgentRun)

    # ① run 走到 DONE（error 一起带上，红的时候能直接看原因）
    assert run.status == "DONE", run.error

    trs = _tool_results(events)

    # ② 卡片事件：ui=card、kind=scenario_plans、plans ≥ 2 且两个候选名可区分
    plans_tr = trs["propose_scenario_plans"]
    assert plans_tr["payload"]["ok"] is True, plans_tr["payload"].get("error")
    assert plans_tr["payload"]["ui"] == "card"
    card = plans_tr["payload"]["content"]["card"]
    assert card["kind"] == "scenario_plans"
    plans = card["plans"]
    assert len(plans) >= 2, f"DoD「≥2 卡」未兑现：plans={len(plans)}"
    assert len({p["name"] for p in plans}) == len(plans)

    # 夹具的 TR 引用确从上一工具结果解析：检索回的正是 seed 的两条用例
    search_ids = [it["id"] for it in trs["search_test_assets"]["payload"]["content"]["items"]]
    assert set(search_ids) == set(case_ids)

    # ③ 每个 asset_id 回库真查：与 card_tools._resolve_ref_names 同尺
    #   （project + 非回收 + visible_clause）再查一次——不是断字段非空
    refs = _plan_refs(plans)
    assert len(refs) >= 2 and {k for _, k in refs} == {"api_case"}
    for ref in sorted({r for r, _ in refs}):
        row = (await session.execute(
            select(ApiCase.name).where(ApiCase.id == ref, ApiCase.project_id == pid,
                                       ApiCase.status != "recycled",
                                       visible_clause(ApiCase, _owner_ctx(owner_id, session)))
        )).first()
        assert row is not None, f"卡片引用的资产 {ref} 回库查不到/对本项目不可见"

    # ④ 用户消息回合数 ≤ 3（D35 从严：单 run = 1 轮）——USER 恰 1 条、AgentRun 恰 1 行
    assert len([e for e in events if e["type"] == "USER"]) == 1
    assert len(out["runs"]) == 1

    # ⑤ 审计：四个元工具各一行 entry="agent" 且 ok=True（本轮没有失败调用混进来）
    rows = (await session.execute(select(AuditLog))).scalars().all()
    mine = [a for a in rows if a.entry == "agent"]
    by_action: dict[str, list[bool]] = {}
    for a in mine:
        by_action.setdefault(a.action, []).append(a.ok)
    for tool in DOD_TOOLS:
        assert tool in by_action, f"审计缺 {tool}（entry=agent 一行都没有）"
        assert by_action[tool] == [True], f"{tool} 审计出现失败行: {by_action[tool]}"
    pa = next(a for a in mine if a.action == "propose_scenario_plans")
    assert pa.target == pid


# —— ⑥ 回归夹具：ask_user 出卡 + 不挂起 run 直接 DONE（D32 形状钉） ——

async def test_ask_user_card_does_not_suspend_run(client, make_user, session, engine, bus) -> None:
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.modules.agent.models import AgentApproval

    _owner, _h, _pid, _cids, sess = await _seed(client, make_user, "B")
    out = await _replay(engine, session, sess, ASK_FIXTURE)
    run, events = out["run"], out["events"]

    au = _tool_results(events)["ask_user"]
    assert au["payload"]["ok"] is True and au["payload"]["ui"] == "card"
    assert au["payload"]["content"]["card"] == {
        "kind": "generic", "form": "question",
        "question": "这次回归跑哪个环境？", "options": ["本地", "日常"]}

    # D32：出卡 ≠ 挂起——终态 DONE、无 APPROVAL_REQ/WAIT_USER 事件、审批表零行、仍单 run
    assert run.status == "DONE", run.error
    assert not [e for e in events if e["type"] in ("APPROVAL_REQ", "WAIT_USER")]
    async with AsyncSession(bind=engine, expire_on_commit=False) as s3:
        approvals = (await s3.execute(
            select(AgentApproval).where(AgentApproval.run_id == run.id))).scalars().all()
    assert approvals == []
    assert len(out["runs"]) == 1


# —— 变异自证的可复跑机器钉（红原文贴在交付回报；夹具本体不动，改 tmp_path 副本） ——

async def _replay_mutated(client, make_user, session, engine, tmp_path, tag, mutated: str):
    """把变异后的脚本落 tmp_path 回放（仓库夹具零改动），回 run/events。"""
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.modules.agent import store
    from app.modules.agent.dispatcher import ToolDispatcher
    from app.modules.agent.gateway import FakeGateway
    from app.modules.agent.models import AgentRun
    from app.modules.agent.runner import AgentRunner

    bad = tmp_path / ("mutation_" + tag + ".jsonl")
    bad.write_text(mutated, encoding="utf-8")
    _owner, _h, pid, _cids, sess = await _seed(client, make_user, tag)
    async with AsyncSession(bind=engine, expire_on_commit=False) as s2:
        s2.add(sess)
        await s2.commit()
        await store.append_event(s2, sess.id, None, "USER", {"text": "创建一个登录功能的回归测试"})
        await AgentRunner(gateway=FakeGateway(bad, project_id=pid),
                          dispatcher=ToolDispatcher(s2)).run_turn(sess.id)
        run = (await s2.execute(select(AgentRun).where(AgentRun.session_id == sess.id))).scalars().one()
        events = await store.replay(s2, sess.id, 0)
    await session.rollback()
    return run, events


def _mutated(raw: str, old: str, new: str) -> str:
    mutated = raw.replace(old, new)
    assert mutated != raw, "变异没有命中夹具原文——夹具形状变了，钉要跟着改"
    return mutated


async def test_mutation_literal_ghost_id_kills_the_card(client, make_user, session, engine, bus,
                                                        tmp_path) -> None:
    """变异 1：一个 {{TR:...}} 引用换成不存在的字面 id → 主例 ② 的前置事实红。

    字面 id 绕开 gateway :64（那里只保「引用尚无结果的工具」），但「宁抛不装」落在
    card_tools 可见性硬门：ok=False + error 说「不可见」→ scenario_plans 卡不出。
    主例的 `assert plans_tr["payload"]["ui"] == "card"` / plans≥2 在这里必然红。
    """
    raw = (_fixture_dir() / "two_candidate_plans.jsonl").read_text(encoding="utf-8")
    mutated = _mutated(raw, "{{TR:search_test_assets:content.items.1.id}}", GHOST)
    run, events = await _replay_mutated(client, make_user, session, engine, tmp_path, "E", mutated)
    assert run.status == "DONE"  # run 不因坏候选崩掉：错误回注模型（run 不崩、卡不出）

    ps = _tool_results(events)["propose_scenario_plans"]["payload"]
    assert ps["ok"] is False  # 「装绿」的形态就是 ok=True——这里必须 False
    assert GHOST in (ps.get("error") or "") and "不可见" in (ps.get("error") or "")
    # ② 的红（机器钉）：主例用来取卡的那条路径拿不到任何成功的 scenario_plans 卡
    assert _scenario_plans_cards(_tool_results(events)) == []


async def test_mutation_tr_source_missing_errors_run(client, make_user, session, engine, bus,
                                                      tmp_path) -> None:
    """变异 2：TR 引用指向没跑过的工具 → gateway.py :64 抛 → run ERROR → 主例 ① 红。

    计划口径「宁抛不装绿」的本尊：坏引用不许静默降级成占位符继续。
    """
    raw = (_fixture_dir() / "two_candidate_plans.jsonl").read_text(encoding="utf-8")
    mutated = _mutated(raw, "{{TR:search_test_assets:content.items.1.id}}",
                       "{{TR:search_tools:items.0.id}}")  # 本夹具从没跑过 search_tools
    run, _events = await _replay_mutated(client, make_user, session, engine, tmp_path, "F", mutated)
    assert run.status == "ERROR"  # ① 的红：期望 DONE
    assert "TR 引用了尚无结果的工具: search_tools" in (run.error or "")


# —— D161 · seed 自动补齐第二条「登录」用例（README-1f-demo.md §2 前提自动化） ——

def _load_seed_mod():
    import importlib.util

    p = Path(__file__).resolve().parents[1] / "scripts" / "seed_demo.py"
    spec = importlib.util.spec_from_file_location("seed_demo_d161", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_seed_login_case_names_match_fixture_tr_indices() -> None:
    """夹具硬引用 items.0/items.1 两条检索结果；seed 的两条用例常量恰好对上这个数。

    口径链：search_test_assets kind=api_case 只 LIKE ApiCase.name → 两条含「登录」的
    用例名就是夹具可检面的下限。常量重名 / 丢「登录」字 / 夹具多出第三个 items 下标，
    这里都先红——而不是等演示 run 落 ERROR。
    """
    import re

    raw = (_fixture_dir() / "two_candidate_plans.jsonl").read_text(encoding="utf-8")
    idxs = {int(m.group(1)) for m in
            re.finditer(r"\{\{TR:search_test_assets:content\.items\.(\d+)\.id\}\}", raw)}
    assert idxs == {0, 1}, f"夹具 items 下标集合变了（{sorted(idxs)}），seed 侧要跟着对账"

    mod = _load_seed_mod()
    names = [mod.DEMO_LOGIN_CASE, mod.DEMO_LOGIN_RETRY_CASE]
    assert len(set(names)) == 2, f"两条用例名必须互异（select-then-create 按 name 幂等）: {names}"
    assert all("登录" in n for n in names), f"检索词是「登录」，用例名不含它就检不到: {names}"


def test_seed_main_wires_both_login_cases() -> None:
    """main 真的用同一把 helper 把两条常量都种下去（helper 存在但没接线 = 假交付）。

    文本钉与 test_seed_demo_1e 的「纯函数存在性」钉同族：只读源码不碰库。
    """
    src = (Path(__file__).resolve().parents[1] / "scripts" / "seed_demo.py"
           ).read_text(encoding="utf-8")
    assert "_ensure_login_case(db, proj.id, defs[\"登录获取令牌\"].id, DEMO_LOGIN_CASE)" in src
    assert ("await _ensure_login_case(db, proj.id, defs[\"登录获取令牌\"].id, "
            "DEMO_LOGIN_RETRY_CASE)") in src


async def test_seed_login_case_helper_provisions_two_and_is_idempotent(session) -> None:
    """helper 行为钉（测试库，不碰演示库）：首跑各建 1 条、重跑零新增、名字不同同定义。

    跑在 conftest 的 per-run schema（TP_DB_URL 已指过去）；这里直插 Project/ApiDefinition
    两行做宿主，只驱动 _ensure_login_case 本体——seed 的整链（bootstrap/1C/1D/1E 段）
    不在本钉范围，那些有各自的种子幂等档（test_tool_surface_1b/1c、test_seed_demo_1e）。
    """
    from sqlalchemy import select

    from app.modules.api_test.models import ApiCase, ApiDefinition
    from app.modules.iam.models import Project

    mod = _load_seed_mod()
    proj = Project(name="d161p")
    session.add(proj)
    await session.flush()
    d = ApiDefinition(project_id=proj.id, name="登录获取令牌", method="POST", path="/login")
    session.add(d)
    await session.flush()

    got = []
    for name in (mod.DEMO_LOGIN_CASE, mod.DEMO_LOGIN_RETRY_CASE):
        got.append(await mod._ensure_login_case(session, proj.id, d.id, name))
    assert len({c.id for c in got}) == 2, "两条必须落成两个不同 id 的行"
    assert all(c.priority == "P1" and c.definition_id == d.id for c in got)

    # 重跑：select-then-create 命中已有行，按 (项目+定义+name) 零新增
    for name in (mod.DEMO_LOGIN_CASE, mod.DEMO_LOGIN_RETRY_CASE):
        again = await mod._ensure_login_case(session, proj.id, d.id, name)
        assert again.name == name
    rows = (await session.execute(select(ApiCase.id, ApiCase.name).where(
        ApiCase.project_id == proj.id))).all()
    assert len(rows) == 2, f"重跑不许重复建（幂等承诺），实际 {len(rows)} 行: {rows}"
    assert {r[1] for r in rows} == {mod.DEMO_LOGIN_CASE, mod.DEMO_LOGIN_RETRY_CASE}
