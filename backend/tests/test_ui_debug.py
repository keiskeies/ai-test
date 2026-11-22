"""1C T9：`ui_case_resolve` + 独立用例调试/执行端点（计划 T9 Step 1 的 ①–⑨ + 并发闸）。

手法与判据：
- 真浏览器判据照 `test_ui_core.py`：真的起一次 chromium，起不来整文件 skip 并打印原因
  （`-rs` 可见），绝不静默绿。UI 靶子跑真靶场（`scripts/target_app.py`，8322 起顺延——
  9999/8321/5173 是前端车道，不碰）。
- resolve 走注册表直调（它 `http=None`，不出 HTTP 面）；debug/run 走 HTTP 面。
- inline 执行的等待手法照 `test_scenario_run.py`：每轮先 `session.rollback()` 再看库
  （REPEATABLE-READ 的事务快照会拿旧值骗过轮询，T11 实测钉过）。

并发闸回归（本文件的 `TestGate` 组）钉的是计划 Interfaces 那句话说错的实测事实：
进程级 `asyncio.Semaphore` 在「waiter 还在排队时 loop 关闭」之后会被永久绑死在旧 loop 上，
下一次 `asyncio.run`（solo 池的下一个任务 / pytest 的下一个用例）直接 RuntimeError。
所以闸必须住在**每事件循环一个**的 `WeakKeyDictionary` 里。`test_gate_survives_loop换代`
是那条防「简化回模块级信号量」的回归钉。
"""
from __future__ import annotations

import asyncio
import socket
import threading
import time
import weakref
from contextlib import asynccontextmanager

import pytest
from fakeredis import FakeAsyncRedis
from httpx import AsyncClient

DEFAULT_UI_TARGET_PORT = 8322  # 与 test_ui_core 同段；前端车道端口绝不占用


def _pick_port() -> int:
    import os

    base = int(os.environ.get("TP_UI_TARGET_PORT", str(DEFAULT_UI_TARGET_PORT)))
    for p in range(base, base + 8):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
            except OSError:
                continue
            return p
    raise RuntimeError(f"{base}..{base + 7} 全被占用，起不了 UI 靶场")


@pytest.fixture(scope="module")
def base_url():
    """靶场 uvicorn 线程，module 级复用（起停一次），teardown 必关。"""
    import uvicorn

    from scripts.target_app import app

    port = _pick_port()
    cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(cfg)
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    deadline = time.time() + 15
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("靶场 uvicorn 15s 没起来")
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    th.join(timeout=8)
    assert not th.is_alive(), "靶场线程没收尾，会拖住后续测试"


@pytest.fixture(scope="module")
def browser_version():
    """真浏览器判据：起得来才跑，起不来整文件 skip（打印原因，绝不静默）。"""
    async def probe() -> str:
        from playwright.async_api import async_playwright

        async with async_playwright() as pw:
            b = await pw.chromium.launch(headless=True)
            v = b.version
            await b.close()
            return v

    try:
        return asyncio.run(probe())
    except Exception as e:  # noqa: BLE001 skip 判据就是一切启动失败
        pytest.skip(f"真实 chromium 启动失败，本文件全部跳过（这不是通过）："
                    f"{type(e).__name__}: {str(e)[:300]}")


@pytest.fixture
def fake_bus():
    from app.core.eventbus import init_bus

    return init_bus(client=FakeAsyncRedis(decode_responses=True))


@asynccontextmanager
async def _concurrency(limit: int):
    """临时改 `ui_concurrency`（Settings 实例就在 lru_cache 里，setattr+还原即可）。"""
    from app.core.config import get_settings

    s = get_settings()
    old = s.ui_concurrency
    s.ui_concurrency = limit
    try:
        yield
    finally:
        s.ui_concurrency = old


# —— 资产构造小工具 ————————————————————————————————————————————————


async def _setup(client: AsyncClient, make_user, tag: str):
    boss, hb = await make_user("uidbg" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "uidbg" + tag},
                             headers=hb)).json()["id"]
    return boss, hb, pid


async def _env(client: AsyncClient, h, pid, base: str, name: str = "靶场") -> str:
    """环境 = base_url 的载体（R105/D3：URL 走环境变量，Environment 没有 base_url 列）。"""
    r = await client.post("/api/v1/envs", json={
        "project_id": pid, "name": name + str(time.time_ns() % 10**6),
        "config": {"vars": [["base_url", base]]}}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _el(client: AsyncClient, h, pid, name, locator_type, locator) -> str:
    r = await client.post("/api/v1/ui-elements", json={
        "project_id": pid, "name": name, "locator_type": locator_type, "locator": locator},
        headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def login_steps(eaccount: str, epassword: str, esubmit: str) -> list[dict]:
    """真通过的登录序列（靶场 /ui/login，demo/demo123 正确口令落 /ui/home）。"""
    return [
        {"id": "u1", "type": "open", "input": "${base_url}/ui/login"},
        {"id": "u2", "type": "input", "element_id": eaccount, "input": "demo"},
        {"id": "u3", "type": "input", "element_id": epassword, "input": "demo123"},
        {"id": "u4", "type": "click", "element_id": esubmit},
        {"id": "u5", "type": "assert_title", "input": "工作台"},
    ]


async def _login_assets(client, h, pid, base):
    ea = await _el(client, h, pid, "账号框", "id", "account")
    ep = await _el(client, h, pid, "口令框", "css", "#password")
    es = await _el(client, h, pid, "登录按钮", "id", "submit")
    env_id = await _env(client, h, pid, base)
    r = await client.post("/api/v1/ui-cases", json={
        "project_id": pid, "name": "登录成功" + str(time.time_ns() % 10**6),
        "steps": login_steps(ea, ep, es), "env_id": env_id}, headers=h)
    assert r.status_code == 201, r.text
    return ea, ep, es, env_id, r.json()["id"]


def _steps_with_dangling(eid: str) -> list[dict]:
    """一条协议合法、但元素引用悬空（直插库里回收元素后必然的形状）的序列。"""
    return [
        {"id": "u1", "type": "open", "input": "${base_url}/ui/login"},
        {"id": "u2", "type": "click", "element_id": eid},
    ]


async def _resolve(client, session, pid, cid, uid=None, uname="", perms=None):
    """注册表直调（http=None 的内部件没有 HTTP 面）。"""
    from app.core.registry import REGISTRY
    from app.core.service import ServiceCtx

    spec = REGISTRY.get("ui_case_resolve")
    assert spec is not None, "ui_case_resolve 未注册（debug_services 没 import 进 create_app？）"
    ctx = ServiceCtx(entry="http", user_id=uid or "u", user_name=uname,
                     is_system_admin=True, perms=perms if perms is not None else {"*"},
                     db=session)
    out = await spec.handler(spec.model.model_validate({"project_id": pid, "case_id": cid}), ctx)
    return out.model_dump()


async def _wait_terminal(session, run_id, timeout=40.0):
    """终态 + run_end 事件都到位才算完（inline 协程在跑，库轮询法照 test_scenario_run）。"""
    from sqlalchemy import func, select

    from app.modules.execution.models import RunEvent, RunRecord

    t0 = time.perf_counter()
    while True:
        await session.rollback()  # REPEATABLE-READ：不结束事务，refresh 会被旧快照骗
        rec = await session.get(RunRecord, run_id)
        await session.refresh(rec)
        if rec.status in ("passed", "failed", "error", "cancelled"):
            n = await session.scalar(select(func.count()).select_from(RunEvent)
                                     .where(RunEvent.run_id == run_id,
                                            RunEvent.type == "run_end"))
            if n:
                return rec
        if time.perf_counter() - t0 > timeout:
            raise AssertionError("run 未在 " + str(timeout) + "s 内进入终态+run_end："
                                 + rec.status)
        await asyncio.sleep(0.05)


# ══════════════════════ 计划 Step 1 ①–⑨ ══════════════════════


async def test_resolve_normal_case(client, session, make_user, base_url) -> None:
    """① resolve 正常用例：executable=True、elements 带定位器、base_url 来自环境变量。

    `Environment` 没有 base_url 列（实测）——resolve 从**解析后的变量**里读 `${base_url}`
    （R105/D3），这是本条测试存在的核心理由：base_url 不是列，是环境变量的约定键。
    """
    _, h, pid = await _setup(client, make_user, "A")
    ea, ep, es, env_id, cid = await _login_assets(client, h, pid, base_url)
    out = await _resolve(client, session, pid, cid)
    assert out["executable"] is True and out["reason"] is None
    assert out["case_id"] == cid and out["priority"] == "P2"
    assert out["env_id"] == env_id and out["env_name"]
    assert len(out["commands"]) == 5 and out["commands"][0]["id"] == "u1"
    assert out["elements"][ea] == {"name": "账号框", "locator_type": "id", "locator": "account"}
    assert out["elements"][ep]["locator_type"] == "css"
    assert out["variables"]["base_url"] == base_url
    assert out["base_url"] == base_url, "base_url 从解析后的环境变量里读出（R105/D3）"


async def test_resolve_recycled_case_404(client, session, make_user, base_url) -> None:
    """② 用例被回收 → resolve 404（回收就是看不见，与不存在同码）。"""
    _, h, pid = await _setup(client, make_user, "B")
    *_, cid = await _login_assets(client, h, pid, base_url)
    assert (await client.post("/api/v1/ui-cases/" + cid + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    from app.core.errors import ApiError

    with pytest.raises(ApiError) as ei:
        await _resolve(client, session, pid, cid)
    assert ei.value.http_status == 404


async def test_resolve_recycled_element_not_executable(client, session, make_user, base_url) -> None:
    """③ 元素被回收 → executable=False + reason **点名是哪个元素**，不是 422、不是静默忽略。

    活用例引用的元素回收被 R106 拦住（上面第一段先钉住这条门），所以「用例活着 + 元素
    回收」的悬空引用靠直插复现——当年正常、元素后来回收，正是 resolve 必须能面对的形状。
    「跑不了」是数据事实不是请求非法（api_test/schemas.py:303-305 的既有口径）。
    """
    from app.modules.ui_test.models import UiCase, UiElement

    _, h, pid = await _setup(client, make_user, "C")
    ea = await _el(client, h, pid, "账号框", "id", "account")
    # 门的事实：活用例引用的元素删不掉（R106）——先用一条引用它的用例钉住
    r0 = await client.post("/api/v1/ui-cases", json={
        "project_id": pid, "name": "钉门用例", "steps": _steps_with_dangling(ea)}, headers=h)
    assert r0.status_code == 201, r0.text
    assert (await client.post("/api/v1/ui-elements/" + ea + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 409
    # 回收元素（绕过引用门直改状态，模拟引用关系被外力解除后的时间差），直插悬空引用用例
    el = await session.get(UiElement, ea)
    el.status = "recycled"
    row = UiCase(project_id=pid, name="直插悬空引用", priority="P2", enabled=1,
                 steps=_steps_with_dangling(ea), step_count=2, project_public=True)
    session.add(row)
    await session.commit()
    out = await _resolve(client, session, pid, row.id)
    assert out["executable"] is False, "元素指不到还报 executable=True 就是让执行去炸"
    assert out["reason"] and "账号框" in out["reason"], "reason 必须点名是哪个元素：" + str(out["reason"])
    assert "回收" in out["reason"], "回收要单独说（恢复它或换元素），与「不存在」是两句话"
    assert out["commands"], "不可执行也要把命令带回去，报告/调试面板要知道差在哪一步"


async def test_resolve_direct_insert_dangling_element(client, session, make_user, base_url) -> None:
    """③ 补：直插的悬空引用（元素被彻底删除的形状）同样 executable=False 且点名 id。"""
    from app.modules.ui_test.models import UiCase

    _, h, pid = await _setup(client, make_user, "C2")
    row = UiCase(project_id=pid, name="幽灵元素引用", priority="P2", enabled=1,
                 steps=_steps_with_dangling("el-ghost"), step_count=2, project_public=True)
    session.add(row)
    await session.commit()
    out = await _resolve(client, session, pid, row.id)
    assert out["executable"] is False
    assert "el-ghost" in out["reason"], "reason 要点名查不到的元素 id：" + str(out["reason"])
    # resolve 绝不 422（上面 assert 的就是返回本身）；但 debug 是「人点按钮」，
    # 跑不了必须当场说（api_debug 对不可执行用例回 422 同口径）——不许点开一个必炸的跑
    d = await client.post("/api/v1/ui-cases/" + row.id + "/debug",
                          json={"project_id": pid}, headers=h)
    assert d.status_code == 422 and "el-ghost" in d.json()["message"], d.text


async def test_resolve_cross_project_404(client, session, make_user, base_url) -> None:
    """④ 跨项目 case_id → 404（不向别的项目探测者确认存在性）。"""
    _, h1, pid1 = await _setup(client, make_user, "D")
    _, _h2, pid2 = await _setup(client, make_user, "D2")
    *_, cid = await _login_assets(client, h1, pid1, base_url)
    from app.core.errors import ApiError

    with pytest.raises(ApiError) as ei:
        await _resolve(client, session, pid2, cid)  # 系统管理员 ctx：404 必须来自资产归属查询
    assert ei.value.http_status == 404


async def test_debug_pass_writes_run_steps_artifacts(client, session, make_user, base_url,
                                                     fake_bus, browser_version) -> None:
    """⑤ debug 跑通 → run_record.status=passed、run_step_result 行数==命令数、制品入库。

    真靶场真 chromium，不是 mock：绿是跑出来的。绿案制品=1 张终态截图（D5），
    「SCREENSHOT 失败用例才有」的说法只对**失败截图**成立，终态截图绿案也有——
    库里有没有行是唯一真相，这里两条都数。
    """
    _, h, pid = await _setup(client, make_user, "E")
    *_, cid = await _login_assets(client, h, pid, base_url)
    r = await client.post(f"/api/v1/ui-cases/{cid}/debug", json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True and body["passed"] is True, body
    assert body["run_id"] and body["error"] is None
    assert body["env_name"], "调试载荷要带环境名（面板头部）"
    assert len(body["commands"]) == 5
    a_rows = [a for c in body["commands"] for a in (c.get("assertions") or [])]
    assert len(a_rows) == 1 and a_rows[0]["passed"] is True, \
        "R108 断言行在 commands[] 里逐键原样（{type,passed,expected,actual,error,path}）"
    assert set(a_rows[0]) == {"type", "passed", "expected", "actual", "error", "path"}
    assert body["elapsed_ms"] >= 0

    from sqlalchemy import select

    from app.modules.execution.models import RunArtifact, RunRecord, RunStepResult

    rec = await session.get(RunRecord, body["run_id"])
    assert rec.subject_type == "ui_case" and rec.status == "passed"
    assert rec.trigger == "debug" and rec.subject_id == cid
    rows = (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == body["run_id"])
        .order_by(RunStepResult.step_key))).scalars().all()
    assert len(rows) == 6, "R102：一个命令一行（5 行）+ 汇总节点一行"
    assert all(r.kind in ("open", "input", "click", "assert_title") for r in rows if r.step_key != "case")
    assert all(r.parent_step_key == "case" for r in rows if r.step_key != "case"), \
        "R102：命令行挂在汇总节点下"
    arts = (await session.execute(
        select(RunArtifact).where(RunArtifact.run_id == body["run_id"]))).scalars().all()
    assert len(arts) >= 1 and arts[0].kind == "SCREENSHOT" and arts[0].bytes > 1000
    # 汇总节点（R102 单节点图）也在步骤表里：顶层节点承载整案结论
    assert any(r.step_key == "case" and r.kind == "ui_case" for r in rows)


async def test_debug_fail_writes_case_row_fail(client, session, make_user, base_url,
                                               fake_bus, browser_version) -> None:
    """⑤ 补：断言没过的 debug → run failed（橙）、case 汇总行 fail、失败截图入库。"""
    _, h, pid = await _setup(client, make_user, "E2")
    ea, ep, es, env_id, _ = await _login_assets(client, h, pid, base_url)
    steps = login_steps(ea, ep, es)
    steps[2]["input"] = "wrong-password"      # 错口令 → 停在登录页 → 标题断言不过
    steps[4] = {"id": "u5", "type": "assert_text",
                "inline_locator": {"type": "id", "value": "login-tip"}, "input": "登录成功"}
    r = await client.post("/api/v1/ui-cases", json={
        "project_id": pid, "name": "断言必挂" + str(time.time_ns() % 10**6),
        "steps": steps, "env_id": env_id}, headers=h)
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    resp = await client.post(f"/api/v1/ui-cases/{cid}/debug", json={"project_id": pid}, headers=h)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True and body["passed"] is False
    assert body["status"] == "failed" and isinstance(body["status"], str), \
        "status 是 run 终态词表，不是 DebugOut 的 HTTP 状态码"
    assert "headers" not in body and "body_text" not in body and "truncated" not in body, \
        "UI 没有 HTTP 语义，DebugOut 的 HTTP 载荷字段一个都不许塞假值（载荷按 UI 真相设计）"

    from sqlalchemy import select

    from app.modules.execution.models import RunArtifact, RunRecord, RunStepResult

    rec = await session.get(RunRecord, body["run_id"])
    assert rec.status == "failed"
    rows = {r.step_key: r for r in (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == body["run_id"]))).scalars().all()}
    assert rows["case"].status == "fail" and rows["u5"].status == "fail"
    arts = (await session.execute(
        select(RunArtifact).where(RunArtifact.run_id == body["run_id"]))).scalars().all()
    kinds = [a.kind for a in arts]
    assert "SCREENSHOT" in kinds and "DOM" in kinds and kinds.count("SCREENSHOT") == 2, \
        "失败当场 1 图 + 1 DOM，终态 1 图（D5），全部入库"


async def test_debug_run_visible_in_runs_absent_in_reports(client, session, make_user, base_url,
                                                           fake_bus, browser_version) -> None:
    """⑥ trigger=debug 不进报告中心（默认过滤），但进运行记录；且不回写 last_run_*。"""
    _, h, pid = await _setup(client, make_user, "F")
    *_, cid = await _login_assets(client, h, pid, base_url)
    body = (await client.post(f"/api/v1/ui-cases/{cid}/debug", json={"project_id": pid},
                              headers=h)).json()
    runs = (await client.get("/api/v1/runs", params={"project_id": pid,
                                                     "subject_type": "ui_case"}, headers=h)).json()
    assert [i["id"] for i in runs["items"]] == [body["run_id"]], "运行记录页必须看得见 debug"
    reports = (await client.get("/api/v1/reports", params={"project_id": pid}, headers=h)).json()
    assert reports["items"] == [], "报告中心默认过滤 trigger=debug（Review Focus 11）"
    with_debug = (await client.get("/api/v1/reports", params={
        "project_id": pid, "include_debug": "true"}, headers=h)).json()
    assert [i["id"] for i in with_debug["items"]] == [body["run_id"]]
    got = (await client.get("/api/v1/ui-cases/" + cid, params={"project_id": pid}, headers=h)).json()
    assert got["last_run_at"] is None and got["last_run_status"] is None, \
        "调试是过程不是结论：debug 绝不回写用例的「最近结果」"
    # 报告详情仍完整可读（⑨）：单节点 summary_graph + 制品引用
    rep = await client.get("/api/v1/reports/" + body["run_id"],
                           params={"project_id": pid}, headers=h)
    assert rep.status_code == 200, rep.text
    rd = rep.json()
    assert rd["subject_type"] == "ui_case"
    nodes = (rd["summary_graph"] or {}).get("nodes") or []
    assert len(nodes) == 1 and nodes[0]["kind"] == "ui_case", "R102：单节点图"
    assert rd["steps"] and any(s["kind"] == "ui_case" for s in rd["steps"])
    assert len(rd["artifacts"]) >= 1


async def test_run_endpoint_enqueues_and_completes(client, session, make_user, base_url,
                                                   fake_bus, browser_version) -> None:
    """⑦+worker 路径：run 端点投 worker（celery 档探 broker）/ inline 档跑完终态。

    - celery 档 + 不可达 broker → 503，且**不留下 queued 孤儿行**（R42，同 enqueue）。
    - inline 档（conftest 默认）→ 轮询到 passed；trigger=manual；回写 last_run_*；
      报告中心可见（非 debug）；run_step_result 与制品齐。
    """
    from app.core.config import get_settings

    _, h, pid = await _setup(client, make_user, "G")
    *_, cid = await _login_assets(client, h, pid, base_url)

    s = get_settings()
    old = s.exec_mode
    s.exec_mode = "celery"
    old_url = s.redis_url
    try:
        s.redis_url = "redis://127.0.0.1:1/0"  # 必然连不上的端口：探针必死
        r = await client.post(f"/api/v1/ui-cases/{cid}/run", json={"project_id": pid}, headers=h)
        assert r.status_code == 503, r.text
        assert r.json()["code"] == "executor_unavailable"
    finally:
        s.redis_url = old_url
        s.exec_mode = old
    from sqlalchemy import func, select

    from app.modules.execution.models import RunRecord

    n = await session.scalar(select(func.count()).select_from(RunRecord)
                             .where(RunRecord.subject_type == "ui_case",
                                    RunRecord.project_id == pid))
    assert n == 0, "broker 投不出去就 503，库里不许躺 queued 孤儿（R42）"

    r2 = await client.post(f"/api/v1/ui-cases/{cid}/run", json={"project_id": pid}, headers=h)
    assert r2.status_code == 200, r2.text
    run_id = r2.json()["run_id"]
    assert r2.json()["status"] == "queued"
    rec = await _wait_terminal(session, run_id)
    assert rec.status == "passed" and rec.trigger == "manual" and rec.subject_type == "ui_case"
    # 冗余列回写排在 run_end 之后（与 _run_claimed 同款顺序），每轮先 rollback 再看
    t0 = time.perf_counter()
    while True:
        await session.rollback()
        got = (await client.get("/api/v1/ui-cases/" + cid, params={"project_id": pid},
                                headers=h)).json()
        if got["last_run_status"] is not None or time.perf_counter() - t0 > 10:
            break
        await asyncio.sleep(0.05)
    assert got["last_run_status"] == "passed" and got["last_run_at"], "真执行回写最近结果"
    reports = (await client.get("/api/v1/reports", params={
        "project_id": pid, "subject_type": "ui_case"}, headers=h)).json()
    assert [i["id"] for i in reports["items"]] == [run_id], "manual 运行进报告中心"


async def test_run_and_resolve_absent_from_tool_surface(client, make_user) -> None:
    """⑦（计划编号）resolve/run 等内部件不进工具箱（tool=False 漏进 = 权限绕过面）。"""
    _, h, pid = await _setup(client, make_user, "H")
    tools = (await client.get("/api/v1/agent/tools", params={"project_id": pid},
                              headers=h)).json()["items"]
    names = {t["name"] for t in tools}
    for absent in ("ui_case_resolve", "ui_case_refs", "ui_element_refs", "ui_case_purge"):
        assert absent not in names, absent + " 不该在工具面"


async def test_readonly_debug_and_run_403(client, session, make_user, base_url) -> None:
    """⑧ 只读成员 debug/run → 403（路由在、门在）。"""
    _, hb, pid = await _setup(client, make_user, "I")
    ro, hro = await make_user("uidbro" + pid[:6])
    assert (await client.put(f"/api/v1/projects/{pid}/members/{ro.id}",
                             json={"role_code": "READONLY"}, headers=hb)).status_code == 200
    *_, cid = await _login_assets(client, hb, pid, base_url)
    assert (await client.post(f"/api/v1/ui-cases/{cid}/debug", json={"project_id": pid},
                              headers=hro)).status_code == 403
    assert (await client.post(f"/api/v1/ui-cases/{cid}/run", json={"project_id": pid},
                              headers=hro)).status_code == 403
    # 读侧不受影响
    assert (await client.get("/api/v1/ui-cases/" + cid, params={"project_id": pid},
                             headers=hro)).status_code == 200


async def test_report_detail_complete_for_ui_run(client, session, make_user, base_url,
                                                 fake_bus, browser_version) -> None:
    """⑨ subject_type=ui_case 的报告仍完整可读：步骤明细带命令时间线与制品。"""
    _, h, pid = await _setup(client, make_user, "J")
    *_, cid = await _login_assets(client, h, pid, base_url)
    body = (await client.post(f"/api/v1/ui-cases/{cid}/debug", json={"project_id": pid},
                              headers=h)).json()
    rep = (await client.get("/api/v1/reports/" + body["run_id"],
                            params={"project_id": pid}, headers=h)).json()
    keys = {s["step_key"] for s in rep["steps"]}
    assert {"u1", "u2", "u3", "u4", "u5", "case"} <= keys, "每命令一行 + 汇总节点"
    d = await client.get("/api/v1/reports/" + body["run_id"] + "/steps",
                         params={"project_id": pid, "step_key": "case"}, headers=h)
    assert d.status_code == 200, d.text
    det = d.json()["detail"]
    assert det["commands"], "汇总节点明细带逐命令时间线（报告右栏数据源，R102 的代价条款）"
    assert det["vars"], "save_var 之后的变量快照"
    u2 = next(s for s in rep["steps"] if s["step_key"] == "u2")
    assert u2["status"] == "pass" and u2["kind"] == "input", "命令行的 kind = 命令 type（R102）"
    arts = rep["artifacts"]
    assert arts and all(a["kind"] == "SCREENSHOT" for a in arts)
    assert all(a["step_key"] in keys for a in arts), "制品 step_key 必须对得上步骤"
    # 制品下载端点照常工作（kind=SCREENSHOT 走魔数嗅探内联）
    name = arts[0]["ref"].split("/")[-1]
    dl = await client.get(f"/api/v1/artifacts/{body['run_id']}/{name}",
                          params={"project_id": pid}, headers=h)
    assert dl.status_code == 200 and dl.headers["content-type"] == "image/png"


# ══════════════════════ 并发闸（含回归钉） ══════════════════════


async def test_gate_caps_concurrency_within_one_loop() -> None:
    """并发闸在**同一 loop 内**真限流：8 个任务、闸 4 → 峰值恰好 ≤4 且能到 4。

    只断言「没崩」不算钉住——直接 `Semaphore(10**6)` 也永不崩。计数器自证峰值。
    """
    from app.modules.ui_test.debug_services import ui_run_gate

    seen = {"now": 0, "peak": 0}

    async def job():
        async with ui_run_gate():
            seen["now"] += 1
            seen["peak"] = max(seen["peak"], seen["now"])
            await asyncio.sleep(0.05)
            seen["now"] -= 1

    async def main():
        async with _concurrency(4):
            await asyncio.gather(*(job() for _ in range(8)))

    await main()
    assert seen["peak"] <= 4, f"闸没限住：峰值 {seen['peak']} > 4"
    assert seen["peak"] == 4, f"闸形同虚设（峰值只到 {seen['peak']}），限流器必须真在干活"


def test_gate_survives_loop_era_change() -> None:
    """回归钉：**闸本体**跨两个 asyncio.run（solo 池每任务一个 loop 的真实形状）。

    复现的正是实测失败形状：第一批次收尾时闸上还挂着排队的 waiter（持锁任务被 cancel
    前 loop 已关闭），naive 模块级 `asyncio.Semaphore` 会被那次 acquire 永久绑死在旧
    loop 上，下一个 `asyncio.run` 里任何一次 `async with` 直接
    `RuntimeError: ... is bound to a different event loop`。
    所以本测试**必须是同步 def**：loop 完全由测试自己 `asyncio.run` 开合（async def 会
    被 pytest 的 loop 圈走，闸就绑在 pytest loop 上，回归失去意义）。
    闸必须每 loop 一个（WeakKeyDictionary 按 loop 弱引用缓存）。这条测试存在的唯一目的
    就是拦住把闸「简化」回模块级信号量的人——没有它，这个 bug 只在满载的 solo 池上炸，
    本地单跑永远绿。
    """
    from app.modules.ui_test.debug_services import ui_run_gate

    async def holder():
        async with ui_run_gate():          # 抢闸；抢到的睡到被 cancel，抢不到的在排队
            await asyncio.sleep(30)

    async def quick():
        async with ui_run_gate():
            await asyncio.sleep(0)

    async def batch(n: int) -> None:
        async with _concurrency(1):        # 闸 1：1 个持锁 + 3 个排队 waiter
            ts = [asyncio.ensure_future(holder()) for _ in range(n)]
            await asyncio.sleep(0.05)      # 让锁被拿到、waiter 确实挂上
            for t in ts:
                if not t.done():
                    t.cancel()
            await asyncio.gather(*ts, return_exceptions=True)

    # 第一批：故意让闸「关 loop 时仍被锁着且有 waiter」
    asyncio.run(batch(4))
    # 第二批：全新 loop。模块级信号量在这里必抛 RuntimeError（实测复核的形状）
    async def batch2() -> None:
        async with _concurrency(2):
            await asyncio.gather(*(quick() for _ in range(6)))

    asyncio.run(batch2())


def test_gate_cache_is_weakkeydict_per_loop() -> None:
    """闸缓存必须是 WeakKeyDictionary（普通 dict 会把每个 loop 的闸泄漏到进程终老）。"""
    from app.modules.ui_test import debug_services

    cache = getattr(debug_services, "_GATES", None)
    assert isinstance(cache, weakref.WeakKeyDictionary), \
        "并发闸缓存必须按 loop 弱引用（WeakKeyDictionary），否则 solo 池长跑必漏"


def test_worker_registers_ui_task() -> None:
    """worker 必须注册 ui_case.run 任务名（按名字投递的另一端；R42 不许 web 侧 import）。"""
    import app.worker as worker_mod

    assert "ui_case.run" in worker_mod.celery_app.tasks, \
        "ui_case_run 投的是这个名字，worker 没接 = run 永远 queued"
    src = open(worker_mod.__file__, encoding="utf-8").read()
    top = [ln for ln in src.splitlines() if ln.startswith(("import ", "from "))]
    assert not any("ui_test" in ln for ln in top), \
        "worker 模块级不许 import ui_test（引擎/模块 import 必须在任务体内）"
