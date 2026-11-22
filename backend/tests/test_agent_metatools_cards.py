"""1F T2 卡片协议后端：ui 透传 + 五个卡片/列表型元工具。

钉的行为（1F 计划 T2 checkbox 逐条对账）：
① 五个工具的 payload 形状（ui="card"、card.kind/form、自包含字段）；
② kind 值域常量与 §12.2 `:1570` 逐字对齐（枚举集合相等，防手滑改名）；
   ui 值域出口断言：_card() 越界直接抛（协议违反回注模型救不了）；
③ propose_scenario_plans 的 graph 非法 → ok=False 且 error 是人话（不是 traceback、
   不是野 JSON 递给画布）；ref 指向不可见资产同样拒；
④ suggest_open_page route 白名单外拒绝（白名单值与 shell.tsx 现行导航对账）；
⑤ update_plan_item 的推进/缺槽位/缺 id 三条路；
⑥ 审计行 entry="agent"（dispatcher `_audit` 现成，五件全过一遍）；
⑦ ui 透传端到端（取证 ③ 的正向钉）：FakeGateway 喂 propose_scenario_plans 调用 →
   SSE 事件与 GET messages 历史重放里 TOOL_RESULT.payload.ui == "card" 且字节一致
   （R148：同一事件，REST 重放免费带卡）。
"""
from __future__ import annotations

import json
from typing import Any

import pytest
import pytest_asyncio

from app.core.service import ServiceCtx
from app.modules.agent.dispatcher import ToolDispatcher
from app.modules.agent.metatools import card_tools
from app.modules.agent.metatools.card_tools import CARD_KINDS, OPEN_PAGE_ROUTES, UI_KINDS

FIXTURE = "fake://card_plans"


@pytest_asyncio.fixture()
async def bus():
    import fakeredis.aioredis

    from app.core.eventbus import init_bus

    r = fakeredis.aioredis.FakeRedis(decode_responses=True)
    b = init_bus(client=r)
    yield b
    await b.aclose()


async def _setup(client, make_user, tag):
    boss, h = await make_user("mt2" + tag)
    r = await client.post("/api/v1/projects", json={"name": "mt2p" + tag}, headers=h)
    assert r.status_code == 201, r.text
    return boss, h, r.json()["id"]


def _ctx(user, session, session_id: str | None = None) -> ServiceCtx:
    # 位集给 "*"（同 read 测法）：dispatcher 的权限门先于 handler 看 ctx.perms；
    # 带 project_id 的工具在 handler 内再走 ensure_project_access 真解析（creator 是 PROJECT_ADMIN）
    return ServiceCtx(entry="agent", user_id=user.id, perms={"*"}, db=session, session_id=session_id)


def _plan(name: str, graph: dict, **kw: Any) -> dict:
    base = {"name": name, "intent": "覆盖主链路", "est_steps": ["第一步", "第二步"], "graph": graph}
    base.update(kw)
    return base


def _ok_graph(ref: str) -> dict:
    return {"version": 1, "nodes": [{"key": "s1", "kind": "api_case", "ref": ref, "name": "登录"}]}


async def _mk_case(client, h, pid, name="登录成功用例"):
    d = await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "登录接口", "method": "POST", "path": "/login",
        "request": {"method": "POST", "url": "http://t/login"}})
    assert d.status_code == 201, d.text
    c = await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": d.json()["id"], "name": name})
    assert c.status_code == 201, c.text
    return c.json()["id"]


# —— ② 值域常量（与 §12.2 :1570 逐字对齐） ——

def test_card_kind_enum_exactly_matches_blueprint() -> None:
    assert set(CARD_KINDS) == {"scenario_plans", "report_summary", "device_status", "generic"}
    assert set(UI_KINDS) == {None, "card", "approval", "diff"}


def test_card_exit_rejects_protocol_violation() -> None:
    """出口断言：kind/ui 越界 = 编程错误直接抛（回注模型救不了协议违反）。"""
    with pytest.raises(RuntimeError, match="kind 越界"):
        card_tools._card({"kind": "not_a_kind"})
    with pytest.raises(RuntimeError, match="ui 值域越界"):
        card_tools._card({"kind": "generic"}, ui="popup")


def test_open_page_whitelist_matches_shell_nav() -> None:
    """白名单与 shell.tsx 现行导航真值对账（钉住值本身，防手滑改坏）。

    shell.tsx 的 MENU 带 to 路径 = 这 14 条（web 侧改动必须同批改这里——
    「界面能配、跳了 404」是纪律 1 的假功能形状）。
    """
    assert set(OPEN_PAGE_ROUTES) == {
        "/", "/bench", "/api", "/scene", "/datasets", "/ui/elements", "/ui/cases",
        "/adb/devices", "/adb/cases", "/runs", "/reports", "/settings", "/notify/channels",
        "/schedules",
    }


# —— ① 形状 + ③ graph 门 + ④ route 门 + ⑤ 计划推进（经 dispatcher 全链路） ——

async def test_propose_scenario_plans_shape_and_selfcontained(client, make_user, session) -> None:
    boss, h, pid = await _setup(client, make_user, "P1")
    cid = await _mk_case(client, h, pid)
    disp = ToolDispatcher(session)
    plans = [
        _plan("冒烟", _ok_graph(cid), env_hint="本地", risks=["依赖造数"]),
        _plan("重试", {"version": 1, "nodes": [
            {"key": "l1", "kind": "loop", "name": "重试",
             "config": {"mode": "while", "cond": "ctx.vars.get('ok') != '1'", "max_iter": 3},
             "children": [{"key": "l1.1", "kind": "api_case", "ref": cid, "name": "登录"}]}]}),
    ]
    r = await disp.call("propose_scenario_plans", {"project_id": pid, "plans": plans},
                        _ctx(boss, session), mode="PLAN", grants=set())
    assert r.ok is True, r.error
    assert r.ui == "card"
    card = r.content["card"]
    assert card["kind"] == "scenario_plans" and len(card["plans"]) == 2
    p0 = card["plans"][0]
    # 自包含：步骤预览 + env_hint/risks + graph 内联且 ref 解析出资产名（前端零二次查询）
    assert p0["est_steps"] == ["第一步", "第二步"] and p0["env_hint"] == "本地"
    assert p0["risks"] == ["依赖造数"]
    assert p0["graph"]["nodes"][0]["ref_name"] == "登录成功用例"
    # 嵌套容器里的 ref 也解析（iter_nodes 覆盖 children）
    assert card["plans"][1]["graph"]["nodes"][0]["children"][0]["ref_name"] == "登录成功用例"
    # 入参图不许被原地污染（出卡的是深拷贝）
    assert "ref_name" not in plans[0]["graph"]["nodes"][0]


async def test_propose_scenario_plans_rejects_bad_graph_in_human_words(client, make_user, session) -> None:
    """③ 非法 graph → ok=False + 人话 error（graph.py validate 现成文案），不是野 JSON 出卡。"""
    boss, h, pid = await _setup(client, make_user, "P2")
    cid = await _mk_case(client, h, pid)
    disp = ToolDispatcher(session)
    bad = {"version": 2, "nodes": [{"key": "", "kind": "teleport", "children": []}]}
    r = await disp.call("propose_scenario_plans",
                        {"project_id": pid, "plans": [_plan("坏图", bad), _plan("好图", _ok_graph(cid))]},
                        _ctx(boss, session), mode="PLAN", grants=set())
    assert r.ok is False
    err = r.error or ""
    assert "结构校验" in err and "version" in err and "teleport" in err, err
    assert "Traceback" not in err and "NotImplementedError" not in err


async def test_propose_scenario_plans_rejects_single_and_invisible_ref(client, make_user, session) -> None:
    boss, h, pid = await _setup(client, make_user, "P3")
    await _mk_case(client, h, pid)
    disp = ToolDispatcher(session)
    # 单候选：卡片协议要 ≥2（§9.7）
    r1 = await disp.call("propose_scenario_plans",
                         {"project_id": pid, "plans": [_plan("独苗", _ok_graph("x"))]},
                         _ctx(boss, session), mode="PLAN", grants=set())
    assert r1.ok is False and "≥2" in (r1.error or "")
    # ref 指向不存在资产：拒（画布拿到的每个 ref 都是本项目可见资产）
    r2 = await disp.call("propose_scenario_plans",
                         {"project_id": pid, "plans": [_plan("A", _ok_graph("ghost-id")),
                                                       _plan("B", _ok_graph("ghost-id2"))]},
                         _ctx(boss, session), mode="PLAN", grants=set())
    assert r2.ok is False and "ghost-id" in (r2.error or "") and "不可见" in (r2.error or "")


async def test_ask_user_card_and_plan_lifecycle(client, make_user, session) -> None:
    """① ask_user 形状（D32：调用即返回，不挂起）+ ⑤ propose_plan/update_plan_item 推进。"""
    boss, h, pid = await _setup(client, make_user, "A1")
    disp = ToolDispatcher(session)
    ctx = _ctx(boss, session, session_id="s-ask")
    r = await disp.call("ask_user", {"question": "跑哪个环境？", "options": ["本地", "日常"]},
                        ctx, mode="PLAN", grants=set())
    assert r.ok is True and r.ui == "card"
    card = r.content["card"]
    assert card == {"kind": "generic", "form": "question", "question": "跑哪个环境？",
                    "options": ["本地", "日常"]}
    # 选项校验：空白/重复都拒
    rb = await disp.call("ask_user", {"question": "q", "options": ["a", " "]}, ctx, mode="PLAN", grants=set())
    assert rb.ok is False and "空白" in (rb.error or "")

    rp = await disp.call("propose_plan",
                         {"items": [{"id": "1", "text": "盘点资产"}, {"id": "2", "text": "出候选"}]},
                         ctx, mode="PLAN", grants=set())
    assert rp.ok is True and rp.content["card"]["form"] == "plan_list"
    assert [it["state"] for it in rp.content["card"]["items"]] == ["pending", "pending"]
    ru = await disp.call("update_plan_item", {"id": "1", "state": "done"}, ctx, mode="PLAN", grants=set())
    assert ru.ok is True and ru.content["card"]["form"] == "plan_list"
    # 全量回带：最新一条覆盖渲染 = 原地更新（前端合流层的地形）
    assert [(it["id"], it["state"]) for it in ru.content["card"]["items"]] == [("1", "done"), ("2", "pending")]
    # 缺 id / 缺槽位两条拒路
    rn = await disp.call("update_plan_item", {"id": "99", "state": "done"}, ctx, mode="PLAN", grants=set())
    assert rn.ok is False and "不存在" in (rn.error or "")
    cold = _ctx(boss, session, session_id="s-cold-session")
    rc = await disp.call("update_plan_item", {"id": "1", "state": "done"}, cold, mode="PLAN", grants=set())
    assert rc.ok is False and "propose_plan" in (rc.error or "")


async def test_suggest_open_page_whitelist_gate(client, make_user, session) -> None:
    boss, h, pid = await _setup(client, make_user, "O1")
    disp = ToolDispatcher(session)
    ctx = _ctx(boss, session)
    r = await disp.call("suggest_open_page", {"route": "/bench", "params": {"project_id": pid}},
                        ctx, mode="PLAN", grants=set())
    assert r.ok is True and r.ui == "card"
    assert r.content["card"] == {"kind": "generic", "form": "open_page",
                                 "route": "/bench", "params": {"project_id": pid}}
    # 白名单外（含带路径段的伪详情路由）→ ok=False + 说清可选项
    rb = await disp.call("suggest_open_page", {"route": "/scene/123"}, ctx, mode="PLAN", grants=set())
    assert rb.ok is False and "白名单" in (rb.error or "") and "/bench" in (rb.error or "")


async def test_five_tools_audited_as_agent(client, make_user, session) -> None:
    """⑥ 审计行：五件每调用一次落一条 entry="agent"（dispatcher 现成 `_audit`）。"""
    from sqlalchemy import select

    from app.modules.audit.models import AuditLog

    boss, h, pid = await _setup(client, make_user, "AU")
    cid = await _mk_case(client, h, pid)
    disp = ToolDispatcher(session)
    ctx = _ctx(boss, session, session_id="s-audit")
    calls = [
        ("ask_user", {"question": "q1"}),
        ("propose_plan", {"items": [{"id": "1", "text": "t"}]}),
        ("update_plan_item", {"id": "1", "state": "doing"}),
        ("suggest_open_page", {"route": "/runs"}),
        ("propose_scenario_plans", {"project_id": pid,
                                    "plans": [_plan("A", _ok_graph(cid)), _plan("B", _ok_graph(cid))]}),
        # 拒绝路径也要落审计（ok=False 有 error diff）
        ("suggest_open_page", {"route": "/nope"}),
    ]
    for name, args in calls:
        r = await disp.call(name, args, ctx, mode="PLAN", grants=set())
        assert r.ok is (args.get("route") != "/nope"), (name, r.error)
    rows = (await session.execute(select(AuditLog))).scalars().all()
    mine = [a for a in rows if a.entry == "agent"]
    assert len(mine) == 6
    by_action: dict[str, list[bool]] = {}
    for a in sorted(mine, key=lambda x: x.ts):
        by_action.setdefault(a.action, []).append(a.ok)
    for tool in ("ask_user", "propose_plan", "update_plan_item", "suggest_open_page",
                 "propose_scenario_plans"):
        assert tool in by_action, tool
    assert sorted(by_action["suggest_open_page"]) == [False, True]
    denied = [a for a in mine if a.action == "suggest_open_page" and not a.ok]
    assert "白名单" in (denied[0].diff or {}).get("error", "")


# —— ⑦ ui 透传端到端（R148：SSE 与 REST 重放读同一事件，字节一致） ——

async def test_ui_passthrough_end_to_end(client, make_user, session, engine, bus, tmp_path) -> None:
    """FakeGateway 喂 propose_scenario_plans → TOOL_RESULT.payload.ui=="card"。

    变异自证钉（取证 ③ 断管的反向钉）：删掉 runner 的 `"ui": res.ui` 一行，
    本例两条 ui 断言必红。REST GET messages 与 SSE 帧里的 ui/卡片必须字节一致。
    """
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.modules.agent import store
    from app.modules.agent.gateway import FakeGateway
    from app.modules.agent.models import AgentRun, AgentSession
    from app.modules.agent.runner import AgentRunner

    boss, h, pid = await _setup(client, make_user, "E2E")
    await _mk_case(client, h, pid)
    s2 = AsyncSession(bind=engine, expire_on_commit=False)
    try:
        me = (await client.get("/api/v1/auth/me", headers=h)).json()
        sess = AgentSession(project_id=pid, user_id=me["id"], title="ui", mode="PLAN")
        s2.add(sess)
        await s2.commit()
        await store.append_event(s2, sess.id, None, "USER", {"text": "给我两个登录场景候选"})
        runner = AgentRunner(gateway=FakeGateway(FIXTURE, project_id=pid), dispatcher=ToolDispatcher(s2))
        await runner.run_turn(sess.id)
        run = (await s2.execute(select(AgentRun).where(AgentRun.session_id == sess.id))).scalars().one()
        assert run.status == "DONE", run.error

        # 请求级夹具会话的 REPEATABLE-READ 快照停在 auth/me 那次查询（早于 s2 建的
        # 会话行）：先放快照，REST 重放才看得见新事件（与 build_agent_sse 内部同款处理）。
        await session.rollback()
        g = await client.get("/api/v1/agent/sessions/" + sess.id + "/messages", params={"cursor": 0}, headers=h)
        assert g.status_code == 200, g.text
        items = g.json()["items"]
        trs = [e for e in items if e["type"] == "TOOL_RESULT"]
        plans_tr = next(e for e in trs if e["payload"]["tool_name"] == "propose_scenario_plans")
        # 透传正钉：事件载荷带 ui，卡片整坨在 content.card（§12.2 :1570 信封）
        assert plans_tr["payload"]["ui"] == "card"
        assert plans_tr["payload"]["ok"] is True
        card = plans_tr["payload"]["content"]["card"]
        assert card["kind"] == "scenario_plans" and len(card["plans"]) == 2
        # 非卡片工具的 ui 是 None（值域里的合法值，不是缺键）
        search_tr = next(e for e in trs if e["payload"]["tool_name"] == "search_test_assets")
        assert search_tr["payload"]["ui"] is None and "ui" in search_tr["payload"]
        # 自包含端到端：ref 由 {{TR:...}} 从上一工具结果解析，卡片里带回来的资产名内联
        assert card["plans"][0]["graph"]["nodes"][0].get("ref_name")
        plan_seq = plans_tr["seq"]
        rest_payloads = {e["seq"]: e["payload"] for e in items}
    finally:
        # s2 的未决锁会卡住 conn 夹具的 TRUNCATE（失败路径也须放锁，否则挂 teardown）
        await s2.close()

    # SSE 帧与 REST 重放读同一事件 → ui 字节一致（R148 的「免费重放」承诺）
    from starlette.requests import Request

    from app.modules.agent.routes import build_agent_sse

    def req() -> Request:
        scope = {"type": "http", "method": "GET", "path": "/x", "query_string": b"",
                 "headers": [], "client": ("127.0.0.1", 1), "scheme": "http",
                 "server": ("t", 80), "root_path": ""}

        async def receive() -> dict:
            return {"type": "http.request", "body": b"", "more_body": False}

        return Request(scope, receive)

    async with AsyncSession(bind=engine, expire_on_commit=False) as s3:
        resp = await build_agent_sse(s3, req(), sess.id, cursor=0)
        buf = ""
        async for chunk in resp.body_iterator:
            buf += chunk
            if buf.count("\n\n") >= len(items):
                break
    frames = {}
    for blk in buf.strip().split("\n\n"):
        if not blk.strip():
            continue
        data_line = next(ln for ln in blk.split("\n") if ln.startswith("data: "))
        ev = json.loads(data_line[len("data: "):])
        frames[ev["seq"]] = ev
    for seq, rest_payload in rest_payloads.items():
        sse_ev = frames[seq]
        # 逐事件字节一致（payload 里含 ui 与整张卡）
        assert json.dumps(sse_ev["payload"], ensure_ascii=False, sort_keys=True) == \
            json.dumps(rest_payload, ensure_ascii=False, sort_keys=True)
    assert frames[plan_seq]["payload"]["ui"] == "card"
