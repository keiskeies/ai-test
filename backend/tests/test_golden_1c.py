"""1C 金线（计划 Task 22）：元素库 → UI 用例 → 调试/执行 → 报告 → 场景混合 → purge 自包含，一条链跑到底。

与分件测试的分工同 1B 金线（test_golden_1b）：每个件都有自己的专项测试，金线钉的是
**接线**——全走 HTTP 面 + inline 执行档（与 worker 同一份执行体），挂载路由进出，
断言的全是消费方视角的事实。

本文件不复刻 celery / worker：conftest 默认 inline（R72），UI 执行体走
`debug_services.amain_ui_run` 的 inline 协程，与真 worker 同一份 `_execute_ui_run`。

真浏览器判据照 test_scenario_run / test_ui_debug：chromium 起不来整条链 skip 并
**打印响亮原因**（1B 金线的口径：静默跳过的绿在本仓等于撒谎），绝不静默通过。
UI 腿走真靶场（scripts/target_app.py，8322 起顺延——9999/8321/5173 是前端车道，绝不占）；
HTTP 腿走 ASGITransport 内存靶（transport 只注给 HTTP，UI 腿不认识 transport——
真网络真渲染，这正是「混合」要证明的分层）。
"""
from __future__ import annotations

import asyncio
import socket
import threading
import time

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from sqlalchemy import func, select

from app.core.db import get_sessionmaker
from app.core.eventbus import init_bus
from app.modules.execution.models import RunEvent, RunRecord

# —— 内存靶：回显 + 按标题查单（UI 步 save_var 抓到的标题会出现在 order 路径上）——
target = FastAPI()
_hits: list[str] = []


@target.get("/echo")
async def echo(who: str = "?"):
    _hits.append("echo:" + who)
    return JSONResponse({"who": who, "ok": True})


@target.get("/order/{oid}")
async def order(oid: str):
    _hits.append("order:" + oid)
    return JSONResponse({"ok": True})


TR = ASGITransport(app=target)
BASE = "http://tp-target"

UI_TARGET_PORT_BASE = 8322  # 与 test_ui_debug / test_scenario_run 同段，前端车道绝不占


def _pick_ui_port() -> int:
    import os

    base = int(os.environ.get("TP_UI_TARGET_PORT", str(UI_TARGET_PORT_BASE)))
    for p in range(base, base + 8):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
            except OSError:
                continue
            return p
    raise RuntimeError(str(base) + ".." + str(base + 7) + " 全被占用，起不了 UI 靶场")


@pytest.fixture(scope="module")
def ui_base_url():
    """靶场 uvicorn 线程（module 级复用），teardown 必关——同 test_scenario_run 的手法。"""
    import uvicorn

    from scripts.target_app import app

    port = _pick_ui_port()
    cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(cfg)
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    deadline = time.time() + 15
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("靶场 uvicorn 15s 没起来")
        time.sleep(0.05)
    yield "http://127.0.0.1:" + str(port)
    server.should_exit = True
    th.join(timeout=8)
    assert not th.is_alive(), "靶场线程没收尾，会拖住后续测试"


@pytest.fixture(scope="module")
def ui_browser():
    """真浏览器判据：起得来才跑，起不来整条金线 skip（打印原因，绝不静默）。"""
    async def probe() -> str:
        from playwright.async_api import async_playwright

        async with async_playwright() as pw:
            b = await pw.chromium.launch(headless=True)
            v = b.version
            await b.close()
            return v

    try:
        v = asyncio.run(probe())
    except Exception as e:  # noqa: BLE001 skip 判据就是一切启动失败
        print("\n[GOLDEN-1C][SKIP] 真实 chromium 启动失败，1C 金线整条未验证（这不是通过）："
              + type(e).__name__ + ": " + str(e)[:300])
        pytest.skip("真实 chromium 启动失败：1C 金线未验证（见打印）")
    print("\n[GOLDEN-1C] 真浏览器就位 chromium " + v + "，金线走真靶场真渲染。")
    return v


@pytest.fixture(autouse=True)
def _boot_registry():
    from app.main import create_app

    create_app()


@pytest.fixture()
def fake_bus():
    return init_bus(client=FakeAsyncRedis(decode_responses=True))


@pytest.fixture(autouse=True)
def _transport_hook():
    """场景 HTTP 腿注内存靶（UI 腿不吃 transport——混合链的分层就是这条钩子的边界）。"""
    from app.modules.scenario.services import set_debug_transport

    set_debug_transport(lambda: TR)
    yield
    set_debug_transport(None)


async def _wait_terminal(run_id: str, timeout: float = 120.0):
    """终态 + run_end 都落库才算完（1B 金线同法；inline 协程用独立连接 commit，
    这里每轮开新 session，天然绕过测试 session 的 REPEATABLE-READ 快照）。"""
    t0 = time.perf_counter()
    while True:
        async with get_sessionmaker()() as s:
            rec = await s.get(RunRecord, run_id)
            n = await s.scalar(select(func.count()).select_from(RunEvent)
                               .where(RunEvent.run_id == run_id,
                                      RunEvent.type == "run_end"))
            if rec is not None and rec.status in ("passed", "failed", "error", "cancelled") and n:
                return rec
        if time.perf_counter() - t0 > timeout:
            raise AssertionError("金线 run 未在 " + str(timeout) + "s 内收尾")
        await asyncio.sleep(0.05)


def _node(key, kind, *, config=None, children=None, **extra):
    n = {"key": key, "kind": kind, "name": key, "ref": None,
         "config": config or {}, "children": children or []}
    n.update(extra)
    return n


# 金线 UI 用例（对齐 T20 种子演示的形状 + save_var 接头）：4 元素全部用上，
# get_text 抓工作台标题存 ui_title（场景 a2 步 ${ui_title} 的原料），
# wait_element 真等靶场 3s 定时器插进 DOM 的 #late-row。
UI_STEPS = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"]


def _ui_steps(eids: dict[str, str]) -> list[dict]:
    return [
        {"id": "u1", "type": "open", "input": "${base_url}/ui/login"},
        {"id": "u2", "type": "input", "element_id": eids["acc"], "input": "demo"},
        {"id": "u3", "type": "input", "element_id": eids["pwd"], "input": "demo123"},
        {"id": "u4", "type": "click", "element_id": eids["btn"]},
        {"id": "u5", "type": "assert_text", "element_id": eids["title"], "input": "工作台"},
        {"id": "u6", "type": "get_text", "element_id": eids["title"], "save_var": "ui_title"},
        {"id": "u7", "type": "wait_element",
         "inline_locator": {"type": "css", "value": "#late-row"}, "timeout_ms": 10000},
    ]


async def test_golden_1c_element_library_to_mixed_scenario(client, make_user, fake_bus,
                                                           ui_base_url, ui_browser) -> None:
    # ══ 建资产：模块 → 4 元素（挂模块下）→ 环境 → UI 用例（引用元素）══
    _boss, h = await make_user("g1cboss")
    pid = (await client.post("/api/v1/projects", json={"name": "金线1C"},
                             headers=h)).json()["id"]
    mod = await client.post("/api/v1/ui-modules", headers=h,
                            json={"project_id": pid, "name": "金线UI模块"})
    assert mod.status_code == 201, mod.text
    mid = mod.json()["id"]
    tree = (await client.get("/api/v1/ui-modules", params={"project_id": pid},
                             headers=h)).json()["tree"]
    assert [n["name"] for n in tree] == ["金线UI模块"], "模块树根层要看得见刚建的模块"

    eids: dict[str, str] = {}
    for key, name, lt, loc in (("acc", "账号框", "id", "account"),
                               ("pwd", "口令框", "css", "#password"),
                               ("btn", "登录按钮", "id", "submit"),
                               ("title", "工作台标题", "id", "title")):
        r = await client.post("/api/v1/ui-elements", headers=h, json={
            "project_id": pid, "module_id": mid, "name": name,
            "locator_type": lt, "locator": loc})
        assert r.status_code == 201, r.text
        eids[key] = r.json()["id"]
    els = (await client.get("/api/v1/ui-elements", params={"project_id": pid},
                            headers=h)).json()["items"]
    assert len(els) == 4 and all(e["module_id"] == mid for e in els)
    assert all(e["used_by"] == 0 for e in els), "还没建用例，引用数必须是 0"

    env_id = (await client.post("/api/v1/envs", headers=h, json={
        "project_id": pid, "name": "靶场环境",
        "config": {"vars": [["base_url", ui_base_url]]}})).json()["id"]
    case_name = "金线：登录工作台"
    rc = await client.post("/api/v1/ui-cases", headers=h, json={
        "project_id": pid, "module_id": mid, "name": case_name, "priority": "P1",
        "steps": _ui_steps(eids), "env_id": env_id})
    assert rc.status_code == 201, rc.text
    ui_cid = rc.json()["id"]
    got = (await client.get("/api/v1/ui-cases/" + ui_cid, params={"project_id": pid},
                            headers=h)).json()
    assert got["step_count"] == 7 and got["issues"] == [], "两道保存门都要过"
    els = (await client.get("/api/v1/ui-elements", params={"project_id": pid},
                            headers=h)).json()["items"]
    used = {e["name"]: e["used_by"] for e in els}
    assert used["登录按钮"] == 1, "用例引用元素，徽标数字要立刻说话（与 409 同源）"

    # ══ 调试：trigger=debug —— 运行记录看得见、报告中心看不到、不回写「最近结果」══
    d = await client.post("/api/v1/ui-cases/" + ui_cid + "/debug",
                          json={"project_id": pid}, headers=h)
    assert d.status_code == 200, d.text
    dbg = d.json()
    assert dbg["status"] == "passed" and dbg["ok"] is True and dbg["passed"] is True, dbg
    assert len(dbg["commands"]) == 7, "调试载荷逐命令回看（R108）"
    async with get_sessionmaker()() as s:
        dbg_run = await s.get(RunRecord, dbg["run_id"])
    assert dbg_run is not None and dbg_run.trigger == "debug"
    assert dbg_run.subject_type == "ui_case" and dbg_run.subject_id == ui_cid
    runs = (await client.get("/api/v1/runs", params={"project_id": pid,
                                                     "subject_type": "ui_case"},
                             headers=h)).json()["items"]
    assert [i["id"] for i in runs] == [dbg["run_id"]], "运行记录页看得见调试"
    reps = (await client.get("/api/v1/reports", params={"project_id": pid},
                             headers=h)).json()["items"]
    assert reps == [], "报告中心默认过滤 debug：调试是过程不是结论"
    with_dbg = (await client.get("/api/v1/reports", params={
        "project_id": pid, "include_debug": "true"}, headers=h)).json()["items"]
    assert [i["id"] for i in with_dbg] == [dbg["run_id"]]
    got = (await client.get("/api/v1/ui-cases/" + ui_cid, params={"project_id": pid},
                            headers=h)).json()
    assert got["last_run_at"] is None and got["last_run_status"] is None, \
        "debug 绝不回写「最近结果」"

    # ══ 执行：trigger=manual —— 报告中心看到，详情有命令行 + 可下载制品 ══
    r = await client.post("/api/v1/ui-cases/" + ui_cid + "/run", headers=h,
                          json={"project_id": pid})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "queued", "投递语义：返回时还没跑完"
    run_id = r.json()["run_id"]
    done = await _wait_terminal(run_id)
    assert done.status == "passed", (done.status, done.error)
    assert done.trigger == "manual" and done.subject_type == "ui_case"
    # 「最近结果」的回写在 run_end 之后补（_execute_ui_run 的刻意顺序），HTTP 轮询等它
    t0 = time.perf_counter()
    while True:
        got = (await client.get("/api/v1/ui-cases/" + ui_cid, params={"project_id": pid},
                                headers=h)).json()
        if got["last_run_status"] == "passed" or time.perf_counter() - t0 > 10:
            break
        await asyncio.sleep(0.05)
    assert got["last_run_status"] == "passed", "真执行必须回写「最近结果」"

    reps = (await client.get("/api/v1/reports", params={"project_id": pid},
                             headers=h)).json()["items"]
    assert run_id in [i["id"] for i in reps], "trigger=manual 必须进报告中心"
    assert dbg["run_id"] not in [i["id"] for i in reps], "同场对照：debug 仍不进报告中心"
    rep = (await client.get("/api/v1/reports/" + run_id, params={"project_id": pid},
                            headers=h)).json()
    assert rep["subject_type"] == "ui_case" and rep["subject_name"] == case_name
    assert rep["status"] == "passed" and rep["pass_rate"] == 1.0, rep["stats"]
    # R102 形状：单节点 summary_graph + 步骤表 = 7 命令行 + case 汇总行
    nodes = rep["summary_graph"]["nodes"]
    assert len(nodes) == 1 and nodes[0]["kind"] == "ui_case"
    by_key = {s["step_key"]: s for s in rep["steps"]}
    assert set(by_key) == set(UI_STEPS) | {"case"}
    assert by_key["case"]["kind"] == "ui_case" and by_key["case"]["status"] == "pass"
    assert all(by_key[k]["parent_step_key"] == "case" for k in UI_STEPS), \
        "R102：命令行挂在汇总节点下"
    detail = (await client.get("/api/v1/reports/" + run_id + "/steps", params={
        "project_id": pid, "step_key": "case"}, headers=h)).json()
    assert len(detail["detail"]["commands"]) == 7
    assert all(c["status"] == "pass" for c in detail["detail"]["commands"])
    assert detail["vars_snapshot"].get("ui_title") == "订单工作台", \
        "get_text save_var 要留在步骤快照里（重跑与审计的依据）"
    arts = rep["artifacts"]
    # 独立 UI 运行的制品按**命令 id** 归位（_execute_ui_run 存 step_key=step_id；
    # 场景内则由 h_ui_case 按画布步骤 key 归位）——绿案至少留整案终态截图（D5）
    assert arts and all(a["step_key"] in UI_STEPS for a in arts), str(arts)
    shot = next(a for a in arts if a["kind"] == "SCREENSHOT")
    dl = await client.get("/api/v1/artifacts/" + run_id + "/" + shot["ref"].split("/")[-1],
                          params={"project_id": pid}, headers=h)
    assert dl.status_code == 200 and dl.headers["content-type"] == "image/png"
    assert dl.content.startswith(b"\x89PNG") and len(dl.content) > 1000, "真截图字节，不是占位"

    # ══ 把用例加进场景当一个 ui_case 步骤 → 跑场景 → 混合报告同场 ══
    d1 = (await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "回显", "method": "GET", "path": "/echo",
        "request": {"method": "GET", "url": "${base}/echo?who=golden-1c",
                    "assertions": [{"type": "json_path_equals", "path": "$.who",
                                    "expected": "golden-1c"}]}})).json()["id"]
    c1 = (await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": d1, "name": "回显用例"})).json()["id"]
    d2 = (await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "按标题查单", "method": "GET", "path": "/order/x",
        "request": {"method": "GET", "url": "${base}/order/${ui_title}",
                    "assertions": [{"type": "json_path_equals", "path": "$.ok",
                                    "expected": True}]}})).json()["id"]
    c2 = (await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": d2, "name": "订单用例"})).json()["id"]
    graph = {"version": 1, "nodes": [
        _node("a1", "api_case", ref=c1, name="登录前先回显"),
        _node("ui", "ui_case", ref=ui_cid, name="UI 登录取标题"),
        _node("a2", "api_case", ref=c2, name="用 UI 变量查订单")]}
    sid = (await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "金线混合场景", "step_graph": graph,
        "variables": {"base": BASE}, "env_id": env_id})).json()["id"]
    r = await client.post("/api/v1/scenarios/" + sid + "/run", headers=h,
                          json={"project_id": pid})
    assert r.status_code == 200, r.text
    mix_id = r.json()["run_id"]
    mix = await _wait_terminal(mix_id)
    assert mix.status == "passed", (mix.status, mix.error)
    states = {n["key"]: n["result"]["status"] for n in mix.summary_graph["nodes"]
              if isinstance(n.get("result"), dict)}
    assert states == {"a1": "pass", "ui": "pass", "a2": "pass"}, states
    assert "order:订单工作台" in _hits, \
        "UI 步 save_var 抓到的标题必须原样流进后续 API 步（混合链的接头）：" + str(_hits)
    mrep = (await client.get("/api/v1/reports/" + mix_id, params={"project_id": pid},
                             headers=h)).json()
    kinds = {s["step_key"]: s["kind"] for s in mrep["steps"]}
    assert kinds == {"a1": "api_case", "ui": "ui_case", "a2": "api_case"}, \
        "混合报告：api_case 与 ui_case 同场、同一种报告形状"
    assert all(s["status"] == "pass" for s in mrep["steps"])
    mars = mrep["artifacts"]
    assert mars and all(a["step_key"] == "ui" for a in mars), "UI 制品按画布步骤归位"
    mshot = next(a for a in mars if a["kind"] == "SCREENSHOT")
    mdl = await client.get("/api/v1/artifacts/" + mix_id + "/" + mshot["ref"].split("/")[-1],
                           params={"project_id": pid}, headers=h)
    assert mdl.status_code == 200 and mdl.content.startswith(b"\x89PNG")

    # ══ 彻底删除用例：逐字输名门 → purge → 两份报告仍完整（§5.8 自包含对 UI 兑现）══
    # 用例此时已是「金线混合场景」的 ui_case 步骤：回收先 409 点名引用者（T10 接上的
    # 引用保护），force = 看见清单后的第二段（test_scenario_run_adb.py:350 的同款两段式）。
    blocked = await client.post("/api/v1/ui-cases/" + ui_cid + "/delete",
                                json={"project_id": pid}, headers=h)
    assert blocked.status_code == 409 and blocked.json()["code"] == "referenced_by_scenario", \
        blocked.text
    forced = await client.post("/api/v1/ui-cases/" + ui_cid + "/delete",
                               json={"project_id": pid, "force": True}, headers=h)
    assert forced.status_code == 200, forced.text
    bad = await client.post("/api/v1/ui-cases/" + ui_cid + "/purge", headers=h, json={
        "project_id": pid, "confirm_name": case_name[:-1]})
    assert bad.status_code == 409 and bad.json()["code"] == "name_mismatch", \
        "彻底删除要逐字输名，差一个字符都不许删"
    ok = await client.post("/api/v1/ui-cases/" + ui_cid + "/purge", headers=h, json={
        "project_id": pid, "confirm_name": case_name})
    assert ok.status_code == 200, ok.text
    rep2 = (await client.get("/api/v1/reports/" + run_id, params={"project_id": pid},
                             headers=h))
    assert rep2.status_code == 200, rep2.text
    j = rep2.json()
    assert j["subject_name"] == case_name and j["summary_graph"], "资产 purge 后报告自包含"
    assert set(s["step_key"] for s in j["steps"]) == set(UI_STEPS) | {"case"}
    assert j["artifacts"], "连制品引用都不能随资产消失"
    mrep2 = (await client.get("/api/v1/reports/" + mix_id, params={"project_id": pid},
                              headers=h)).json()
    assert mrep2["status"] == "passed" and len(mrep2["steps"]) == 3
    assert mrep2["artifacts"], "混合报告在 UI 用例被彻底删除后仍完整可读"

    # ══ 元素引用检测拦住删除 → 解引用后能删（用例已 purge，所以用新用例钉这扇门）══
    mini = await client.post("/api/v1/ui-cases", headers=h, json={
        "project_id": pid, "name": "引用钉子用例",
        "steps": [{"id": "m1", "type": "open", "input": "${base_url}/ui/login"},
                  {"id": "m2", "type": "click", "element_id": eids["btn"]}]})
    assert mini.status_code == 201, mini.text
    mini_id = mini.json()["id"]
    blocked = await client.post("/api/v1/ui-elements/" + eids["btn"] + "/delete",
                                json={"project_id": pid}, headers=h)
    assert blocked.status_code == 409 and blocked.json()["code"] == "referenced_by_case", \
        "被活用例引用的元素必须删不掉（R106）"
    names = [c["name"] for c in blocked.json()["details"]["cases"]]
    assert names == ["引用钉子用例"], "409 必须点名是谁在引用：" + str(blocked.json())
    deref = await client.patch("/api/v1/ui-cases/" + mini_id, headers=h, json={
        "project_id": pid, "steps": [
            {"id": "m1", "type": "open", "input": "${base_url}/ui/login"},
            {"id": "m2", "type": "click",
             "inline_locator": {"type": "css", "value": "#submit"}}],
        "steps_set": True})
    assert deref.status_code == 200, deref.text
    freed = await client.post("/api/v1/ui-elements/" + eids["btn"] + "/delete",
                              json={"project_id": pid}, headers=h)
    assert freed.status_code == 200, "解引用后必须能删：" + freed.text
    wrong = await client.post("/api/v1/ui-elements/" + eids["btn"] + "/purge", headers=h, json={
        "project_id": pid, "element_id": eids["btn"], "confirm_name": "错的"})
    assert wrong.status_code == 409 and wrong.json()["code"] == "name_mismatch"
    gone = await client.post("/api/v1/ui-elements/" + eids["btn"] + "/purge", headers=h, json={
        "project_id": pid, "element_id": eids["btn"], "confirm_name": "登录按钮"})
    assert gone.status_code == 200, gone.text
