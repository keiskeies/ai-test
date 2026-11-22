"""1C T6 UI 用例服务面（§7.2 / §11.4.12 / §11.5.4）：CRUD + 两道保存门。

两条门分开是有理由的，这个文件一半的测试都在钉这条分界：
- 协议门（validate_commands）→ 422 `validation_error`：命令本身不合法；
- 引用门（本模块）→ 422 `unknown_element`：命令合法但 element_id 指不到东西。
两者都带 `details.issues[{index,code,message}]`，因为 §11.4.12 的编辑器要**逐行标红**。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import event


@pytest.fixture
def sql_log(engine):
    """记录本用例执行过的全部 SQL 文本（⑦ 用它证明列表没查 run_record）。

    挂在 AsyncEngine 的底层 sync engine 上：`before_cursor_execute` 在真发语句前触发，
    比开 echo 再抓日志可靠（echo 走 logging，测试里既难抓又受 -s 影响）。
    """
    seen: list[str] = []

    def _catch(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", _catch)
    yield seen
    event.remove(engine.sync_engine, "before_cursor_execute", _catch)


async def _setup(client: AsyncClient, make_user, tag: str):
    boss, hb = await make_user("uicboss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "uic" + tag}, headers=hb)).json()["id"]
    return boss, hb, pid


async def _el(client: AsyncClient, h, pid, name="登录按钮", **kw) -> dict[str, Any]:
    body: dict[str, Any] = {"project_id": pid, "name": name, "locator_type": "css",
                            "locator": "#submit", **kw}
    r = await client.post("/api/v1/ui-elements", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _steps(eid: str | None = None) -> list[dict[str, Any]]:
    """合法最小序列：打开 + 一次点击（点击的目标二选一：元素库元素 / 就地定位）。"""
    out: list[dict[str, Any]] = [{"id": "open1", "type": "open", "input": "/ui/login"}]
    out.append({"id": "clk1", "type": "click",
                **({"element_id": eid} if eid else {"inline_locator": {"type": "css", "value": "#go"}})})
    return out


async def _mk(client: AsyncClient, h, pid, name="登录成功", steps=None, **kw) -> dict[str, Any]:
    body: dict[str, Any] = {"project_id": pid, "name": name,
                            "steps": _steps() if steps is None else steps, **kw}
    r = await client.post("/api/v1/ui-cases", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _get(client: AsyncClient, h, pid, cid):
    return await client.get("/api/v1/ui-cases/" + cid, params={"project_id": pid}, headers=h)


async def _patch(client: AsyncClient, h, pid, cid, **body):
    return await client.patch("/api/v1/ui-cases/" + cid, json={"project_id": pid, **body}, headers=h)


async def test_steps_roundtrip_exactly(client: AsyncClient, make_user) -> None:
    """① CRUD + steps 原样往返：`inline_locator` 这种嵌套结构不许被吃掉。

    画布把整条命令序列当草稿存，服务端做任何「规范化」（补默认键、丢未知键、改键序）
    都会让保存后的 diff 看起来像用户改了东西。
    """
    _, h, pid = await _setup(client, make_user, "A")
    e = await _el(client, h, pid)
    steps = [
        {"id": "open1", "type": "open", "input": "http://x/ui/login"},
        {"id": "in1", "type": "input", "element_id": e["id"], "input": "admin", "timeout_ms": 8000},
        {"id": "in2", "type": "input", "inline_locator": {"type": "xpath", "value": "//input[@name='p']"},
         "input": "secret"},
        {"id": "get1", "type": "get_text", "element_id": e["id"], "save_var": "txt"},
        {"id": "as1", "type": "assert_text", "element_id": e["id"], "input": "欢迎", "optional": True},
    ]
    c = await _mk(client, h, pid, "往返用例", steps, priority="P1", enabled=True)
    assert c["step_count"] == 5, "step_count 是保存时算的冗余列，列表不 N+1"
    assert c["priority"] == "P1" and c["enabled"] is True and c["issues"] == []

    got = (await _get(client, h, pid, c["id"])).json()
    assert got["steps"] == steps, "steps 必须逐字段往返（嵌套 inline_locator / 可选键都在）"
    assert got["steps"][2]["inline_locator"] == {"type": "xpath", "value": "//input[@name='p']"}
    assert got["steps"][4]["optional"] is True, "§7.2 的 optional 键不许被过滤掉"
    r = await _patch(client, h, pid, c["id"], steps_set=True, steps=steps[:2])
    assert r.status_code == 200 and r.json()["step_count"] == 2, r.text


async def test_empty_steps_is_blocked_at_save(client: AsyncClient, make_user) -> None:
    """② 空 steps → 422。空用例跑起来「零步全绿」是假绿，保存期就拦（§13 纪律 1）。"""
    _, h, pid = await _setup(client, make_user, "B")
    for n, body in enumerate(({}, {"steps": []}, {"steps": None})):
        r = await client.post("/api/v1/ui-cases",
                              json={"project_id": pid, "name": "空" + str(n), **body}, headers=h)
        assert r.status_code == 422, f"{body} 应 422：{r.text}"
        j = r.json()
        assert j["code"] == "validation_error"
        assert j["details"]["issues"][0]["code"] == "empty_steps"
        assert "假绿" in j["details"]["issues"][0]["message"]
    # 已存在的用例也不能被清空
    c = await _mk(client, h, pid, "先有内容")
    r2 = await _patch(client, h, pid, c["id"], steps_set=True, steps=[])
    assert r2.status_code == 422 and r2.json()["code"] == "validation_error", r2.text
    assert (await _get(client, h, pid, c["id"])).json()["step_count"] == 2, "失败的 PATCH 不许改库"


async def test_steps_set_absent_does_not_wipe(client: AsyncClient, make_user) -> None:
    """PATCH 不带 steps_set → steps 一个字都不动。

    画布改个优先级就整包回传的情况太常见；把「没传」当「清空」会静默毁掉命令序列。
    """
    _, h, pid = await _setup(client, make_user, "B2")
    c = await _mk(client, h, pid, "改优先级不该动命令")
    r = await _patch(client, h, pid, c["id"], priority="P0", name="改了名")
    assert r.status_code == 200, r.text
    assert r.json()["step_count"] == 2 and [s["id"] for s in r.json()["steps"]] == ["open1", "clk1"]
    # 连 steps=None 一起传（不带 steps_set）也一样不动
    r2 = await _patch(client, h, pid, c["id"], steps=None, priority="P3")
    assert r2.json()["step_count"] == 2, "steps=None 且 steps_set 缺省 = 「没传」，不是「清空」"


async def test_unknown_and_recycled_element_blocked(client: AsyncClient, make_user) -> None:
    """③ element_id 指向不存在 / 已回收的元素 → 422 unknown_element，且指到具体第几步。

    协议门只管「给没给 element_id」，管不了「这个 id 存不存在」；不在这里拦，
    就等于让用户存下一条保存成功、列表正常、只在执行那一刻炸的用例（1B R48 同判断）。
    """
    _, h, pid = await _setup(client, make_user, "C")
    e = await _el(client, h, pid, "将被回收的元素")
    ok_steps = _steps(e["id"])

    r = await client.post("/api/v1/ui-cases", json={
        "project_id": pid, "name": "幽灵引用",
        "steps": [ok_steps[0], {"id": "clk1", "type": "click", "element_id": "no-such-el"}]}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "unknown_element", r.text
    iss = r.json()["details"]["issues"]
    assert len(iss) == 1 and iss[0]["index"] == 1, "必须指到第 2 步，编辑器才知道标红哪一行"
    assert iss[0]["code"] == "unknown_element"

    # 已回收的元素：另一句话（恢复它 / 换别的），不是同一句「不存在」
    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    r2 = await client.post("/api/v1/ui-cases", json={"project_id": pid, "name": "回收引用", "steps": ok_steps},
                           headers=h)
    assert r2.status_code == 422 and r2.json()["code"] == "unknown_element", r2.text
    msg = r2.json()["details"]["issues"][0]["message"]
    assert "回收站" in msg and "将被回收的元素" in msg

    # 跨项目的元素与不存在同文案（不向别的项目确认「这个 id 在别处存在」）
    _, h2, pid2 = await _setup(client, make_user, "C2")
    e1 = await _el(client, h, pid, "本项目元素")
    r3 = await client.post("/api/v1/ui-cases", json={
        "project_id": pid2, "name": "跨项目引用", "steps": _steps(e1["id"])}, headers=h2)
    assert r3.status_code == 422, r3.text
    assert "不存在" in r3.json()["details"]["issues"][0]["message"]


async def test_blocked_command_message_names_the_batch(client: AsyncClient, make_user) -> None:
    """④ `upload` 这类未开放命令 → 422 且 message 带批次（R101，不是静默忽略）。"""
    _, h, pid = await _setup(client, make_user, "D")
    r = await client.post("/api/v1/ui-cases", json={"project_id": pid, "name": "带上传", "steps": [
        {"id": "open1", "type": "open", "input": "/ui/home"},
        {"id": "up1", "type": "upload", "inline_locator": {"type": "css", "value": "#file"}, "input": "a.txt"},
    ]}, headers=h)
    assert r.status_code == 422, r.text
    j = r.json()
    assert j["code"] == "validation_error"
    iss = j["details"]["issues"][0]
    assert iss["index"] == 1 and iss["code"] == "command_not_available"
    assert "1C+" in iss["message"], "未开放必须说清哪个批次开放，否则用户以为是 bug"


async def test_existing_case_shows_live_issues(client: AsyncClient, make_user, session) -> None:
    """存量脏数据（协议收紧前存的）打开就带 live issues，而不是保存时才炸。

    直插库绕过保存门，模拟「当年合法、今天非法」的用例——这正是 live issues 存在的
    唯一理由（scenario_get 同一手感）。
    """
    from app.modules.ui_test.models import UiCase

    _, h, pid = await _setup(client, make_user, "F")
    row = UiCase(project_id=pid, name="老用例", priority="P2", enabled=1,
                 steps=[{"id": "dl1", "type": "download",
                         "inline_locator": {"type": "css", "value": "#a"}}],
                 step_count=1, project_public=True)
    session.add(row)
    await session.commit()

    got = (await _get(client, h, pid, row.id)).json()
    codes = [i["code"] for i in got["issues"]]
    assert "command_not_available" in codes, "老问题必须打开就看见"
    assert got["issues"][0]["index"] == 0
    # 列表页不跑校验（每条都跑 validate 会让列表随命令数变慢），回空数组
    lst = (await client.get("/api/v1/ui-cases", params={"project_id": pid}, headers=h)).json()["items"]
    assert [i for i in lst if i["name"] == "老用例"][0]["issues"] == []
    # 看得见 + 改不动：原样存回去会被门拦住
    r = await _patch(client, h, pid, row.id, steps_set=True,
                     steps=[{"id": "dl1", "type": "download",
                             "inline_locator": {"type": "css", "value": "#a"}}])
    assert r.status_code == 422, r.text


async def test_list_does_not_touch_run_record(client: AsyncClient, make_user, session, sql_log) -> None:
    """⑦ 列表的 `last_run_*` 读冗余列，一条 run_record 的 SELECT 都不发。

    「最近结果」去查运行表 = 列表页随历史运行数线性变慢；冗余列就是为这一列建的
    （与 scenario_list 同做法）。
    """
    from app.modules.ui_test.models import UiCase

    _, h, pid = await _setup(client, make_user, "G")
    c = await _mk(client, h, pid, "跑过的用例")
    # 执行链回写是 T9 的事，这里先手工摆好冗余列，测的是读侧不 N+1
    row = await session.get(UiCase, c["id"])
    row.last_run_at = datetime(2026, 11, 16, 3, 4, 5)
    row.last_run_status = "failed"
    await session.commit()

    sql_log.clear()
    lst = await client.get("/api/v1/ui-cases", params={"project_id": pid}, headers=h)
    assert lst.status_code == 200, lst.text
    item = lst.json()["items"][0]
    assert item["last_run_status"] == "failed"
    assert item["last_run_at"].startswith("2026-11-16T03:04:05")
    assert item["last_run_at"][-6:] in ("+00:00", "Z") or "+00:00" in item["last_run_at"], \
        "带时区标记：裸 naive 字符串到前端会按本地时区解析，整页差 8 小时"
    hits = [s for s in sql_log if "run_record" in s.lower()]
    assert hits == [], "列表不该查运行表：" + str(hits[:2])


async def test_recycled_case_not_counted_in_refs_service(client: AsyncClient, make_user, session) -> None:
    """⑧ 回收的用例不进 `ui_element_refs` 的计数（与删除保护同一口径）。"""
    from app.core.registry import REGISTRY
    from app.core.service import ServiceCtx

    boss, h, pid = await _setup(client, make_user, "H")
    e = await _el(client, h, pid, "被两条用例引用")
    c1 = await _mk(client, h, pid, "在用例一", _steps(e["id"]))
    c2 = await _mk(client, h, pid, "在用例二", _steps(e["id"]))

    spec = REGISTRY.get("ui_element_refs")
    ctx = ServiceCtx(entry="http", user_id=boss.id, user_name=boss.name, is_system_admin=False, db=session)

    async def _count():
        out = await spec.handler(spec.model.model_validate({"project_id": pid, "element_ids": [e["id"]]}), ctx)
        return out.groups[0].count if out.groups else 0

    assert await _count() == 2
    assert (await client.post("/api/v1/ui-cases/" + c1["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert await _count() == 1, "回收的用例不再算引用"
    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 409, "还剩 1 条就还删不掉"
    assert (await client.post("/api/v1/ui-cases/" + c2["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert await _count() == 0
    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200


async def test_recycled_case_list_shows_deleter_name(client: AsyncClient, make_user) -> None:
    """§11.4.18 回收站「删除人」列（UI 用例侧，与 test_ui_element 同名测试同一条判断）。

    回收必须把 updated_by 落成回收者：不写的话列上是上一个编辑人，「删除人」就是说谎。
    updated_by_name 是 app_user 解析出的人名；updated_at 只断带偏移的 ISO 串
    （DATETIME 同秒会飘，钉精确值或比 created_at 都是赌运气）。
    """
    boss, hb, pid = await _setup(client, make_user, "RB")
    editor, he = await make_user("uiceditor" + pid[:6], name="王小明")
    assert (await client.put(f"/api/v1/projects/{pid}/members/{editor.id}",
                             json={"role_code": "PROJECT_ADMIN"}, headers=hb)).status_code == 200
    c = await _mk(client, he, pid, "将被回收的用例")
    patched = await _patch(client, he, pid, c["id"], priority="P1")
    assert patched.status_code == 200 and patched.json()["updated_by"] == editor.id
    assert patched.json()["updated_by_name"] is None, "单行出口不回填人名（列表侧才补名字）"

    assert (await client.post("/api/v1/ui-cases/" + c["id"] + "/delete",
                              json={"project_id": pid}, headers=hb)).status_code == 200

    r = await client.get("/api/v1/ui-cases", params={"project_id": pid, "recycled": True}, headers=hb)
    assert r.status_code == 200, r.text
    row = r.json()["items"][0]
    assert row["updated_by"] == boss.id, "回收那次写操作才是删除人，不能停在编辑人身上"
    assert row["updated_by_name"] == boss.name, "删除人列必须是人名（前端直接摊这一格）"
    assert row["updated_by_name"] != boss.id, "拿 id 冒充人名就是这条断言要拦的"
    assert row["updated_at"] and row["updated_at"].endswith("+00:00"), \
        "删除时间给带偏移的 ISO 串（前端 fmtTime 的入参口径）"


async def test_case_recycle_restore_and_purge(client: AsyncClient, make_user) -> None:
    """回收站三件套 + 逐字输名（R53）。"""
    _, h, pid = await _setup(client, make_user, "I")
    c = await _mk(client, h, pid, "待回收用例")
    r0 = await client.post("/api/v1/ui-cases/" + c["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "待回收用例"}, headers=h)
    assert r0.status_code == 409 and r0.json()["code"] == "not_recycled", r0.text
    assert (await client.post("/api/v1/ui-cases/" + c["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert (await _get(client, h, pid, c["id"])).status_code == 404
    assert [i["name"] for i in (await client.get("/api/v1/ui-cases", params={
        "project_id": pid, "recycled": True}, headers=h)).json()["items"]] == ["待回收用例"]

    bad = await client.post("/api/v1/ui-cases/" + c["id"] + "/purge",
                            json={"project_id": pid, "confirm_name": "待回收用"}, headers=h)
    assert bad.status_code == 409 and bad.json()["code"] == "name_mismatch", bad.text
    dup = await client.post("/api/v1/ui-cases", json={
        "project_id": pid, "name": "待回收用例", "steps": _steps()}, headers=h)
    assert dup.status_code == 409 and "回收站" in dup.json()["message"], dup.text

    assert (await client.post("/api/v1/ui-cases/" + c["id"] + "/restore",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert (await client.post("/api/v1/ui-cases/" + c["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    ok = await client.post("/api/v1/ui-cases/" + c["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "待回收用例"}, headers=h)
    assert ok.status_code == 200, ok.text
    assert (await client.get("/api/v1/ui-cases", params={"project_id": pid, "recycled": True},
                             headers=h)).json()["items"] == []


async def test_readonly_and_tool_surface(client: AsyncClient, make_user) -> None:
    """只读成员读 200 / 写 403；purge 与内部件不在工具面。"""
    _, hb, pid = await _setup(client, make_user, "J")
    ro, hro = await make_user("uicro" + pid[:6])
    assert (await client.put(f"/api/v1/projects/{pid}/members/{ro.id}",
                             json={"role_code": "READONLY"}, headers=hb)).status_code == 200
    c = await _mk(client, hb, pid, "老板的用例")
    assert (await client.get("/api/v1/ui-cases", params={"project_id": pid}, headers=hro)).status_code == 200
    assert (await _get(client, hro, pid, c["id"])).status_code == 200
    assert (await client.get("/api/v1/ui-case-references", params={
        "project_id": pid, "case_id": c["id"]}, headers=hro)).status_code == 200
    assert (await client.post("/api/v1/ui-cases", json={"project_id": pid, "name": "只读建不了",
                                                        "steps": _steps()}, headers=hro)).status_code == 403
    assert (await _patch(client, hro, pid, c["id"], name="改不了")).status_code == 403

    tools = (await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=hb)).json()["items"]
    names = {t["name"] for t in tools}
    for absent in ("ui_case_purge", "ui_element_refs", "ui_case_refs"):
        assert absent not in names, absent + " 不该在工具面（tool=False 漏进工具面=权限绕过）"
    assert {"ui_case_list", "ui_case_create", "ui_case_update", "ui_case_delete",
            "ui_element_list", "ui_module_tree"} <= {n for n in names if n.startswith("ui_")}
    by_name = {t["name"]: t for t in tools}
    assert by_name["ui_case_delete"]["effect"] == "destructive"
    assert by_name["ui_case_create"]["effect"] == "write"


async def test_references_endpoint_shape_today(client: AsyncClient, make_user) -> None:
    """`ui_case_references` 的形状：没被引用就是空。

    1C T10 摘掉 `graph.BLOCKED_1B` 的 ui_case 插槽后场景存得下 `ui_case` 节点，
    本端点随之真出数（被引用时报引用者的形状见下一条与 test_referenced_case_delete_blocked_and_forced）。
    """
    _, h, pid = await _setup(client, make_user, "K")
    c = await _mk(client, h, pid, "被查引用的用例")
    r = await client.get("/api/v1/ui-case-references", params={"project_id": pid, "case_id": c["id"]},
                         headers=h)
    assert r.status_code == 200, r.text
    assert r.json() == {"items": [], "details_hidden": False}
    # 单条查询必须给 id：静默回空列表会让人以为「没被引用」然后去删（§13 纪律 1）
    assert (await client.get("/api/v1/ui-case-references", params={"project_id": pid},
                             headers=h)).status_code == 422


async def test_references_sees_scenario_step_graph_direct_insert(client: AsyncClient, make_user,
                                                                 session) -> None:
    """场景 step_graph 里的 `ui_case` 步骤能被查到（直插形状：插槽摘除前钉下的通道耦合）。

    `scenario_case_refs` 把非 api_case 步骤的 ref 当 definition_ids 匹配
    （scenario/services.py `_scan_refs`），而 `ui_case` 步骤的 ref 就是 UI 用例 id——
    这个耦合读代码看不出来，所以钉成测试：scenario 那侧改匹配通道的话这里会红。
    （HTTP 保存出数的形状由 test_referenced_case_delete_blocked_and_forced 补钉，
    与 test_adb_case.py 的「直插钉耦合 + HTTP 钉出数」双钉同构。）
    """
    from app.modules.scenario.models import Scenario

    _, h, pid = await _setup(client, make_user, "L")
    c = await _mk(client, h, pid, "被场景当一步的用例")
    session.add(Scenario(project_id=pid, name="混排场景", priority="P2", step_graph={
        "version": 1, "nodes": [
            {"key": "s1", "kind": "ui_case", "ref": c["id"], "name": "跑 UI"},
            {"key": "s2", "kind": "api_case", "ref": "other-case", "name": "跑接口"},
        ], "edges": []}, variables={}, fail_fast=1, step_count=2, project_public=True))
    await session.commit()

    r = await client.get("/api/v1/ui-case-references", params={"project_id": pid, "case_id": c["id"]},
                         headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["items"]) == 1, \
        "step_graph 里的 ui_case.ref 必须被算成引用（没算到 = ui_case_references 走错通道）"
    assert [i["scenario_name"] for i in body["items"]] == ["混排场景"]
    assert body["items"][0]["step_keys"] == ["s1"], "只算命中那条步骤，不把整张图报出来"
    assert body["details_hidden"] is False


async def test_referenced_case_delete_blocked_and_forced(client: AsyncClient, make_user) -> None:
    """被未回收场景引用的 UI 用例：回收 409 点名引用者；force 是看见清单后的第二段。

    1C T10 起 BLOCKED_1B 为空，HTTP 保存就能把 ui_case 节点存进场景——保护欠一天，
    场景坏一天。形状与 test_adb_case.py:196-210 一对一镜像（同码、同 details、同两段式）。
    """
    _, h, pid = await _setup(client, make_user, "SC")
    c = await _mk(client, h, pid, "被场景当一步的用例")
    g = {"version": 1, "nodes": [
        {"key": "k1", "kind": "ui_case", "ref": c["id"], "name": "跑 UI"},
        {"key": "k2", "kind": "api_case", "ref": "other", "name": "跑接口"}]}
    sid = (await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "混排场景", "step_graph": g})).json()["id"]

    d = await client.post("/api/v1/ui-cases/" + c["id"] + "/delete",
                          json={"project_id": pid}, headers=h)
    assert d.status_code == 409 and d.json()["code"] == "referenced_by_scenario", d.text
    assert d.json()["details"]["count"] == 1
    assert d.json()["details"]["scenarios"][0]["scenario_id"] == sid
    assert "混排场景" in d.json()["message"], "必须点名引用者，用户才有的可解"
    # 先查引用再改状态：409 必须是一条什么都没改的失败（重试看到的必须还是未回收）
    assert (await _get(client, h, pid, c["id"])).json()["status"] == "normal"
    # force = 已经看见引用清单的人的第二段
    assert (await client.post("/api/v1/ui-cases/" + c["id"] + "/delete",
                              json={"project_id": pid, "force": True},
                              headers=h)).status_code == 200
    assert (await _get(client, h, pid, c["id"])).status_code == 404, "force 段必须真回收"


async def test_hidden_reference_details_blocks_force(client: AsyncClient, make_user,
                                                     monkeypatch) -> None:
    """明细被隐瞒（缺 scenario:read）时 force 同样拦：不知道断的是谁的步骤就不许硬断。

    四个内置角色都带 scenario:read（test_ui_element.py:349 的实测），这一半经 HTTP
    内置角色走不到，所以走 core.service._perms_resolver 的生产注入点（test_ui_element.py:383
    同款手法）：只留 ui:case:delete、不给 scenario:read——保护拦人，明细看不看得到是另一把尺。
    """
    import app.core.service as core_service

    boss, hb, pid = await _setup(client, make_user, "HD")
    c = await _mk(client, hb, pid, "被隐瞒引用的用例")
    g = {"version": 1, "nodes": [{"key": "k1", "kind": "ui_case", "ref": c["id"], "name": "跑 UI"}]}
    assert (await client.post("/api/v1/scenarios", headers=hb, json={
        "project_id": pid, "name": "说不出名字的场景", "step_graph": g})).status_code == 201

    real = core_service._perms_resolver

    async def _no_scenario_read(db, user_id, is_admin, project_id):
        # 仍是项目成员（数据门放行），只是没有 scenario:read——数量照报、名字不说
        return {"ui:case:delete"} if user_id == boss.id else await real(db, user_id, is_admin, project_id)

    monkeypatch.setattr(core_service, "_perms_resolver", _no_scenario_read)
    d = await client.post("/api/v1/ui-cases/" + c["id"] + "/delete",
                          json={"project_id": pid, "force": True}, headers=hb)
    assert d.status_code == 409 and d.json()["code"] == "referenced_by_scenario", d.text
    det = d.json()["details"]
    assert det["count"] == 1, "数量照报：查不到是谁不等于没人引用"
    assert det["scenarios"] == [], "说不出是谁就不许顺手把名字漏出去"
    assert det["reason"] == "missing_scenario_read"
    assert "scenario:read" in d.json()["message"]
    monkeypatch.undo()
    assert (await _get(client, hb, pid, c["id"])).json()["status"] == "normal", \
        "被拦的 force 也必须是一条什么都没改的失败"
    # 权限恢复（看清了是谁）→ force 放行：hidden 是权限镜片，不是数据事实
    assert (await client.post("/api/v1/ui-cases/" + c["id"] + "/delete",
                              json={"project_id": pid, "force": True},
                              headers=hb)).status_code == 200


async def test_id_mentioned_in_unrelated_field_is_not_a_reference(client: AsyncClient,
                                                                  make_user) -> None:
    """只在无关字段里提到 id 的场景不算引用（误拦比漏拦更难解：用户无处「解绑」）。

    `scenario_case_refs` 只匹配节点的 `ref` 字段（scenario/services.py `_scan_refs`）：
    id 出现在步骤名 / 脚本文本里都不能让删除变 409——引用是结构事实，不是文本巧合。
    """
    _, h, pid = await _setup(client, make_user, "FP")
    c = await _mk(client, h, pid, "只是名字里撞了 id")
    g = {"version": 1, "nodes": [
        {"key": "k1", "kind": "sleep", "config": {"ms": 10}, "name": "撞名巧合 " + c["id"]},
        {"key": "k2", "kind": "script", "config": {"code": "// 注释里提到 " + c["id"]}}]}
    assert (await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "巧合场景", "step_graph": g})).status_code == 201
    r = (await client.get("/api/v1/ui-case-references",
                          params={"project_id": pid, "case_id": c["id"]}, headers=h)).json()
    assert r == {"items": [], "details_hidden": False}, "无关字段里的 id 不许进引用表"
    assert (await client.post("/api/v1/ui-cases/" + c["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200


async def test_priority_and_enabled_are_closed_sets(client: AsyncClient, make_user) -> None:
    """priority 限 P0-P3、enabled 是布尔（§11.5.4 的「启用」列直接读它）。"""
    _, h, pid = await _setup(client, make_user, "M")
    for p in ("P0", "P1", "P2", "P3"):
        assert (await client.post("/api/v1/ui-cases", json={
            "project_id": pid, "name": "p" + p, "steps": _steps(), "priority": p},
            headers=h)).status_code == 201
    for p in ("P4", "p0", ""):
        assert (await client.post("/api/v1/ui-cases", json={
            "project_id": pid, "name": "bad" + (p or "empty"), "steps": _steps(), "priority": p},
            headers=h)).status_code == 422
    c = await _mk(client, h, pid, "停用用例", enabled=False)
    assert c["enabled"] is False
    assert (await _patch(client, h, pid, c["id"], enabled=True)).json()["enabled"] is True


async def test_env_is_not_validated_at_save(client: AsyncClient, make_user) -> None:
    """env_id 存期不校验（跑的时候才解析）——「先存草稿、环境还没建」是正常顺序。"""
    _, h, pid = await _setup(client, make_user, "N")
    c = await _mk(client, h, pid, "选了个不存在的环境", env_id="no-such-env")
    assert c["env_id"] == "no-such-env"
    r = await _patch(client, h, pid, c["id"], env_set=True, env_id=None)
    assert r.status_code == 200 and r.json()["env_id"] is None, r.text


async def test_cross_project_case_is_404(client: AsyncClient, make_user) -> None:
    """跨项目 case_id 一律 404（读/改/回收/恢复/彻底删除五条路一样）。"""
    _, h1, pid1 = await _setup(client, make_user, "O")
    _, h2, pid2 = await _setup(client, make_user, "P")
    c = await _mk(client, h1, pid1, "别项目的用例")
    base = "/api/v1/ui-cases/" + c["id"]
    rs = [await client.get(base, params={"project_id": pid2}, headers=h2),
          await client.post(base + "/delete", json={"project_id": pid2}, headers=h2),
          await client.post(base + "/restore", json={"project_id": pid2}, headers=h2),
          await client.post(base + "/purge", json={"project_id": pid2, "confirm_name": "别项目的用例"},
                            headers=h2),
          await client.patch(base, json={"project_id": pid2, "name": "改走"}, headers=h2)]
    for r in rs:
        assert r.status_code == 404, r.text
        assert r.json()["code"] == "not_found"
