"""T20b 场景级公共断言（common_assertions）专项测试（计划 R85 落地 + **R88 语义修正**）。

**R88（业主 2026-11-15 裁定）**：公共断言**作用于每一个发出请求的步骤**，不是
「拓扑跑完后对末步响应判一次」。原话：「公共断言一般不挂在最后一步，一般挂在每个步骤上，
所有步骤通过才算过。」所以求值点在 handlers._send（http_direct 与 api_case 的唯一咽喉），
求值行**并入该步自己的断言行**并打 scope="common"，pass/fail / optional / fail_fast
全部沿用该步既有语义——不另开第二套判定。

钉住的口径（缺一即是回归）：
  ① 每个请求步骤都判：两个请求步骤全过 → run passed，**两步各自**都有 common 行；
  ② 任一步的公共断言不过 → **那一步 fail** → run 判 **failed**（不是 error，§8.6），
     话术点名是「场景公共断言」没过（与步骤自己的断言可分辨）；
     只命中的那一步红，其它步骤不受牵连（fail_fast=False 时后面的照跑）；
  ③ **没有请求步骤**的图 → 一步都不判、不报错、不产 common 行（假红禁令）；
  ④ 请求本身失败（网络不通 = error）的步骤**不叠加**公共断言：error 是更高事实层，
     也不产 common 行（不能把「靶场没起」演成「质量门没过」）；
  ⑤ 判定用的**配置**随该步 detail 落库（detail.common_assertions）：结果行只有
     type/path/expected/actual，script 断言的 code 正文不在里面，光靠结果行无法重建；
     单步重跑据此按**当时那份门**复现，场景 purge 后仍成立（RF10 自包含）；
  ⑥ 资产往返：保存 → GET 原样；UpdateIn 用 common_assertions_set 显式声明位
     （None=不改，set+[]=清空，不许一值两义——与 max_runtime_set 同款）；
  ⑦ debug 也生效：公共断言随入队快照走（裁定①同源），且 debug 仍不回写 last_run_*。

手法沿用 test_scenario_run：inline 档 + fakeredis 全局 bus + set_debug_transport 注内存靶。
"""
from __future__ import annotations

import asyncio
import time

import pytest
from fakeredis import FakeAsyncRedis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import ASGITransport
from sqlalchemy import func, select

from app.core.eventbus import init_bus
from app.modules.execution.models import RunEvent, RunRecord, RunStepResult

target = FastAPI()
_hits: list[str] = []


@target.get("/ping")
async def ping():
    _hits.append("ping")
    return JSONResponse({"pong": True})


@target.get("/ping2")
async def ping2():
    _hits.append("ping2")
    return JSONResponse({"pong": True, "second": True})


@target.get("/boom")
async def boom():
    # 真·网络层失败：ASGITransport 会把路由异常抛穿出来，run_api 吸收成 ok=False。
    # 用例 ④ 要的就是「请求根本没跑成」，不是「跑成了但断言没过」。
    _hits.append("boom")
    raise RuntimeError("靶场炸了")


TR = ASGITransport(app=target)
BASE = "http://tp-target"

PASS_CA = [{"type": "status_code", "expected": 200}, {"type": "body_contains", "expected": "pong"}]
FAIL_CA = [{"type": "status_code", "expected": 599}]


@pytest.fixture(autouse=True)
def _reset_hits():
    _hits.clear()
    yield
    _hits.clear()


@pytest.fixture(autouse=True)
def _boot_registry():
    from app.main import create_app

    create_app()


@pytest.fixture()
def fake_bus():
    return init_bus(client=FakeAsyncRedis(decode_responses=True))


@pytest.fixture(autouse=True)
def _transport_hook():
    from app.modules.scenario.services import set_debug_transport

    set_debug_transport(lambda: TR)
    yield
    set_debug_transport(None)


def _graph(*nodes):
    return {"version": 1, "nodes": list(nodes)}


def _node(key, kind, *, config=None, children=None, **extra):
    n = {"key": key, "kind": kind, "name": key, "ref": None,
         "config": config or {}, "children": children or []}
    n.update(extra)
    return n


async def _setup(client, make_user, tag, *, graph=None, **scen_kw):
    _u, h = await make_user("t20b" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "t20bp" + tag},
                             headers=h)).json()["id"]
    g = graph if graph is not None else _graph(
        _node("s1", "set_var", config={"vars": {"a": "1"}}),
        _node("s2", "http_direct", config={"url": BASE + "/ping", "method": "GET"}))
    sid = (await client.post("/api/v1/scenarios", headers=h,
                             json={"project_id": pid, "name": "场景" + tag,
                                   "step_graph": g, **scen_kw})).json()["id"]
    return h, pid, sid


async def _wait_terminal(session, run_id, timeout=20.0):
    """与 T9/T11 同法：终态 + run_end 事件都到位才算完。
    每轮先 rollback：库是 REPEATABLE-READ，事务快照在首次 SELECT 就冻结，
    不 rollback 的轮询永远读旧值（见 test_scenario_run._wait_terminal 的教训）。"""
    t0 = time.perf_counter()
    while True:
        await session.rollback()
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


# —— ① 每个请求步骤都判：全过 → passed，两步各有 common 行 ——————


async def _step_rows(session, run_id):
    """按 step_key 取该 run 的步骤行（含 detail）——R88 后公共断言的归宿在步骤明细里。"""
    rows = (await session.execute(
        select(RunStepResult).where(RunStepResult.run_id == run_id))).scalars().all()
    return {r.step_key: r for r in rows}


def _common_rows(step):
    det = step.detail if isinstance(step.detail, dict) else {}
    return [a for a in (det.get("assertions") or []) if a.get("scope") == "common"]


def _step_msg(rec, key):
    """步骤话术的真相位置：RunStepResult **没有** message 列，
    每步的 message 在 run_record.summary_graph 的节点 result 里（报告页也读这里）。"""
    sg = rec.summary_graph if isinstance(rec.summary_graph, dict) else {}
    for n in sg.get("nodes") or []:
        if str(n.get("key") or "") == key:
            return str(((n.get("result") or {}).get("message")) or "")
    return ""


async def test_common_assertions_apply_to_every_request_step(
        session, client, make_user, fake_bus) -> None:
    """R88 的核心：门挂在**每一步**上，不是末步判一次。

    两个请求步骤 + 全过的门 → 两步都必须各自留下 common 求值行。
    旧语义（末步判一次）下 s1 不会有 common 行，这条直接红。
    """
    g = _graph(_node("s1", "http_direct", config={"url": BASE + "/ping", "method": "GET"}),
               _node("s2", "http_direct", config={"url": BASE + "/ping2", "method": "GET"}))
    h, pid, sid = await _setup(client, make_user, "pass", graph=g, common_assertions=PASS_CA)
    run_id = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                                json={"project_id": pid})).json()["run_id"]
    done = await _wait_terminal(session, run_id)
    assert done.status == "passed", (done.status, done.error)
    steps = await _step_rows(session, run_id)
    for key in ("s1", "s2"):
        rows = _common_rows(steps[key])
        assert rows and all(r["passed"] for r in rows), \
            key + " 这一步没有留下公共断言行——说明门只在末步判过（R85 旧语义复发）"
    assert steps["s1"].status == "pass" and steps["s2"].status == "pass"
    # 判定用的配置随步骤自包含落库（⑤ 的前半，重跑靠它）
    assert steps["s1"].detail.get("common_assertions") == PASS_CA, \
        "detail 要存**判定用的配置**，不是只存结果行"


# —— ② 某一步的门没过 → 那一步 fail → run failed ——————————————


async def test_common_assertions_failure_fails_that_step(session, client, make_user,
                                                         fake_bus) -> None:
    """R88：败因挂在**命中的那一步**上，不是 run 层另记一笔。

    两个请求步骤 + 一条必败的门（fail_fast=False）→ 两步都红、run=failed、
    通过率掉到 0（R86 那个「环 100% + 徽标断言失败」的观感矛盾在新语义下不存在）。
    """
    g = _graph(_node("s1", "http_direct", config={"url": BASE + "/ping", "method": "GET"}),
               _node("s2", "http_direct", config={"url": BASE + "/ping2", "method": "GET"}))
    h, pid, sid = await _setup(client, make_user, "fail", graph=g,
                               common_assertions=FAIL_CA, fail_fast=False)
    run_id = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                                json={"project_id": pid})).json()["run_id"]
    done = await _wait_terminal(session, run_id)
    # failed 不是 error：请求都跑成了，只是质量门没过（§8.6 两个世界）
    assert done.status == "failed", (done.status, done.error)
    steps = await _step_rows(session, run_id)
    assert steps["s1"].status == "fail" and steps["s2"].status == "fail", \
        "每一步都要被这道门判红：" + str({k: v.status for k, v in steps.items()})
    for key in ("s1", "s2"):
        rows = _common_rows(steps[key])
        assert rows and rows[0]["passed"] is False and rows[0]["expected"] == 599
        # 话术要能分辨「场景级门没过」和「这步自己的断言没过」——处置动作不同
        assert "场景公共断言" in _step_msg(done, key), _step_msg(done, key)
    assert done.stats["fail"] == 2 and done.stats["pass"] == 0, \
        "步骤计数必须反映门的判决（通过率环才会与状态一致）：" + str(done.stats)


# —— ③ 没有请求步骤 → 一步都不判（假红禁令）————————————————


async def test_common_assertions_no_response_not_judged(session, client, make_user,
                                                        fake_bus) -> None:
    """纯 set_var 场景：一个请求都没发，没有东西可判。
    拿「没响应」冒充「断言失败」是假红——必须不判、不报错、不产 common 行。"""
    g = _graph(_node("s1", "set_var", config={"vars": {"a": "1"}}))
    h, pid, sid = await _setup(client, make_user, "noresp", graph=g,
                               common_assertions=FAIL_CA)
    run_id = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                                json={"project_id": pid})).json()["run_id"]
    done = await _wait_terminal(session, run_id)
    assert done.status == "passed", \
        "没请求 ≠ 断言失败：" + str((done.status, done.error))
    steps = await _step_rows(session, run_id)
    assert not _common_rows(steps["s1"]), "没发请求就不许产生公共断言行"
    assert not _hits


# —— ④ 请求本身失败 = error，不叠加公共断言 ————————————————


async def test_common_assertions_not_judged_on_request_error(
        session, client, make_user, fake_bus) -> None:
    """网络不通是 error，比「断言没过」更高的事实层。

    这时再叠一道公共断言判定，会把「靶场没起」演成「质量门没过」——
    报告上一个本该是「请求失败」的红变成「断言失败」，排查方向直接被带偏。
    """
    g = _graph(_node("s1", "http_direct", config={"url": BASE + "/boom", "method": "GET"}))
    h, pid, sid = await _setup(client, make_user, "err", graph=g,
                               common_assertions=FAIL_CA)
    run_id = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                                json={"project_id": pid})).json()["run_id"]
    done = await _wait_terminal(session, run_id)
    steps = await _step_rows(session, run_id)
    assert steps["s1"].status == "error", \
        "请求失败是 error，不是被公共断言改写的 fail：" + str(steps["s1"].status)
    assert "请求失败" in _step_msg(done, "s1"), _step_msg(done, "s1")
    assert not _common_rows(steps["s1"]), "error 的步骤不叠加公共断言判定"
    assert done.status == "error", (done.status, done.error)


# —— ⑤ 单步重跑按**当时那份门**复现（自包含，不读场景行）————————


async def test_common_assertions_survive_single_step_rerun(
        session, client, make_user, fake_bus) -> None:
    """重跑这一步必须得出**与原 run 同一个**结论。

    原 run 里 s1 被场景级门判红，若重跑时不重建那道门，同一条响应会重跑出「通过」——
    报告里同一行既有红又有绿，用户无从判断哪个是真的。
    门配置取自该步 detail（不是 scenario 行），所以场景被 purge 后依然成立（RF10）。
    """
    g = _graph(_node("s1", "http_direct", config={"url": BASE + "/ping", "method": "GET"}),
               _node("s2", "http_direct", config={"url": BASE + "/ping2", "method": "GET"}))
    h, pid, sid = await _setup(client, make_user, "rr", graph=g,
                               common_assertions=FAIL_CA)
    src = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                             json={"project_id": pid})).json()["run_id"]
    await _wait_terminal(session, src)

    r = await client.post(f"/api/v1/runs/{src}/rerun-step", headers=h,
                          json={"project_id": pid, "step_key": "s1"})
    assert r.status_code == 200, r.text
    new = await _wait_terminal(session, r.json()["run_id"])
    assert new.status == "failed", \
        "重跑把原来红的步骤跑成了绿——门没跟着重建：" + str((new.status, new.error))
    steps = await _step_rows(session, r.json()["run_id"])
    rows = _common_rows(steps["s1"])
    assert rows and rows[0]["passed"] is False and rows[0]["expected"] == 599, \
        "重跑的步骤要重新留下公共断言行（同一份门、同一个结论）"
    assert steps["s1"].detail.get("common_assertions") == FAIL_CA, \
        "新 run 的这一步也要自包含带着门配置，否则再重跑一次就退化了"


# —— ⑤b 场景 purge 后重跑仍按当时的门判（自包含承诺）———————————


async def test_common_assertions_rerun_after_scenario_purge(
        session, client, make_user, fake_bus) -> None:
    """门配置若回头读 scenario 行，purge 之后就静默不判了（红变绿）。

    这里把场景彻底删掉再重跑：detail 里那份门必须还在。
    """
    g = _graph(_node("s1", "http_direct", config={"url": BASE + "/ping", "method": "GET"}))
    h, pid, sid = await _setup(client, make_user, "rrpurge", graph=g,
                               common_assertions=FAIL_CA)
    src = (await client.post(f"/api/v1/scenarios/{sid}/run", headers=h,
                             json={"project_id": pid})).json()["run_id"]
    await _wait_terminal(session, src)
    # 回收 → 彻底删除（软删的行还在库里，读得到；物理删除才算真断了后路）
    d = await client.post("/api/v1/scenarios/" + sid + "/delete", headers=h,
                          json={"project_id": pid})
    assert d.status_code == 200, d.text
    p = await client.post(f"/api/v1/scenarios/{sid}/purge", headers=h,
                          json={"project_id": pid, "confirm_name": "场景rrpurge"})
    assert p.status_code == 200, p.text

    r = await client.post(f"/api/v1/runs/{src}/rerun-step", headers=h,
                          json={"project_id": pid, "step_key": "s1"})
    assert r.status_code == 200, r.text
    new = await _wait_terminal(session, r.json()["run_id"])
    assert new.status == "failed", \
        "场景删掉后门就消失了？重跑结论必须与资产生死无关：" + str((new.status, new.error))
    steps = await _step_rows(session, r.json()["run_id"])
    assert _common_rows(steps["s1"]), "purge 后仍要按当时那份门判"


# —— ⑥ 资产往返 + UpdateIn 显式声明位 ——————————————————


async def test_common_assertions_asset_roundtrip(client, make_user) -> None:
    h, pid, sid = await _setup(client, make_user, "rt")

    async def _get():
        r = await client.get(f"/api/v1/scenarios/{sid}", params={"project_id": pid},
                             headers=h)
        assert r.status_code == 200, r.text
        return r.json()

    async def _patch(**kw):
        cur = await _get()
        r = await client.patch(f"/api/v1/scenarios/{sid}", headers=h,
                               json={"project_id": pid, "scenario_id": sid,
                                     "version": cur["version"], **kw})
        assert r.status_code == 200, r.text
        return r.json()

    assert (await _get())["common_assertions"] == [], "未配置 = 空列表语义"
    out = await _patch(common_assertions=PASS_CA, common_assertions_set=True)
    assert out["common_assertions"] == PASS_CA, "保存 → 响应原样"
    assert (await _get())["common_assertions"] == PASS_CA, "保存 → GET 原样（资产往返）"
    # 不带声明位的 PATCH 不许把它悄悄清掉（None 只表示「不改」）
    out = await _patch(name="改名后的场景")
    assert out["common_assertions"] == PASS_CA, "缺省 = 不改"
    out = await _patch(common_assertions=[], common_assertions_set=True)
    assert out["common_assertions"] == [], "set=True + [] = 清空并停用"
    assert (await _get())["common_assertions"] == []


# —— ⑥ debug 同路：读入队快照 ——————————————————————————


async def test_common_assertions_applies_to_debug(session, client, make_user,
                                                  fake_bus) -> None:
    h, pid, sid = await _setup(client, make_user, "dbg", common_assertions=FAIL_CA)
    dbg = _graph(_node("dbg", "http_direct",
                       config={"url": BASE + "/ping", "method": "GET"}))
    r = await client.post(f"/api/v1/scenarios/{sid}/debug", headers=h,
                          json={"project_id": pid, "graph": dbg, "variables": {}})
    assert r.status_code == 200, r.text
    done = await _wait_terminal(session, r.json()["run_id"])
    assert done.status == "failed", "debug 与 manual 同路：公共断言必须生效"
    assert "场景公共断言" in _step_msg(done, "dbg"), _step_msg(done, "dbg")
    steps = await _step_rows(session, r.json()["run_id"])
    assert _common_rows(steps["dbg"]), "debug 跑的每一步同样要吃这道门"
    assert done.request_snapshot.get("common_assertions") == FAIL_CA, \
        "裁定①同源：公共断言随入队快照走，执行以快照为准"
    assert done.trigger == "debug"
    from app.modules.scenario.models import Scenario

    sc = await session.get(Scenario, sid)
    await session.refresh(sc)
    assert sc.last_run_status is None, "debug 不回写「最近结果」（既有裁定不许动）"


async def test_common_assertions_storage_shape(client, make_user) -> None:
    """入库口径：编辑器发来的 null 占位键不许存进资产行（门禁⑦ e2e 撞出来的漂移）。

    复现的是真实用户动作，不是构造的理想字典：在场景级面板里选一条断言、再切成别的
    类型，编辑器会把上一类型的载荷键显式清成 null（PropsPanel 的「切类型载荷归零」，
    防旧 code 跟着 status_code 混进数组）。api_case 侧由 exclude_none 兜住（
    api_test/case_services.py:48），场景侧以前原样落 JSON → 同一条断言在两张表里两个
    形状，「保存 → GET 原样」当场对不上，前端还会一直亮「未保存」。
    `enabled: False` 必须活着回去：那是 D78 唯一有语义的关闭位。
    """
    h, pid, sid = await _setup(client, make_user, "shape")
    sent = [
        {"type": "json_path_equals", "path": "$.pong", "expected": True,
         "timeout_ms": None, "code": None},
        {"type": "status_code", "expected": 200, "path": None, "enabled": False},
    ]
    r = await client.patch(f"/api/v1/scenarios/{sid}", headers=h,
                           json={"project_id": pid, "scenario_id": sid, "version": 1,
                                 "common_assertions": sent, "common_assertions_set": True})
    assert r.status_code == 200, r.text
    want = [
        {"type": "json_path_equals", "path": "$.pong", "expected": True},
        {"type": "status_code", "expected": 200, "enabled": False},
    ]
    assert r.json()["common_assertions"] == want, "响应回显 = 存进去的那份"
    g = await client.get(f"/api/v1/scenarios/{sid}", params={"project_id": pid}, headers=h)
    assert g.json()["common_assertions"] == want, \
        "保存 → GET 原样：null 占位键不许在库里长出来"
