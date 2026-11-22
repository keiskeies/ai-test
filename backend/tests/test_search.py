"""1B T22 后端半边 + 1C T12 扩组 + 1D T8 扩 adb_case + 1E T9 扩 schedule/notify_channel：
search_assets 八路关键词检索
（接口定义/用例/场景 + 元素/UI 用例/ADB 用例 + 定时任务/通知渠道，§11.4.19/§9.10/R109）。

钉的行为（Ctrl+K 命令面板按类型分组消费这份契约）：
  ① 名称与路径关键词都能命中：定义按 name+path，用例/场景/元素/UI 用例按 name；
     分组返回、组内有序；出参恒有五组（空组是前端「这一组无匹配」的契约的一部分）；
  ② 软删不可见：回收的定义/用例/场景/元素/UI 用例搜不到；**定义回收后其用例整体不可达**
     （assert_def_alive 同口径）——用例行还是 normal 也不许出现在结果里；
  ③ 私有可见性沿用 1A 谓词（visible_clause）：别人的私有行不可见，自己的可见
     （UI 两表同尺，ui_element/ui_case 都有 project_public + owner_id 两列）；
  ④ 权限：READONLY（*:read）可用；自定义角色不含 search:read → 403；非成员 403；
  ⑤ LIKE 元字符按字面匹配（q="100%" 不得匹配一切）；q 全空白 422；
  ⑥ 注册表面：tool=True / effect=read / perm=search:read / GET /search-assets；
  ⑦ kind 收窄（1C 扩到五类，1D T8 扩到六类，1E T9 扩到八类）：kind=ui_element 只回 ui_elements 组，
     kind=adb_case 只回 adb_cases 组（空组键也必须在场）；非法 kind 422。
  ⑧ 1E T9：schedule 按 project_id 显式过滤（项目级，schedule_task_list 同尺——表无可见性列，
     不许喂 visibility 助手）；notify_channel 平台级不过滤；两组各吃
     schedule:task:read / notify:channel:read 整组开关（缺位 = 空组不是 403）；
     渠道 config（URL/token，D24）结构性进不了出参（SearchAssetItem 无该字段，查询不 SELECT）。
"""
from __future__ import annotations

import json


async def _setup(client, make_user, tag):
    boss, hb = await make_user("srchboss" + tag)
    r = await client.post("/api/v1/projects", json={"name": "ps" + tag}, headers=hb)
    return boss, hb, r.json()["id"]


async def _mk_login_trio(client, h, pid):
    """造一套「登录」资产：定义(/login) + 用例 + 场景，返回三 id。"""
    d = await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "登录接口", "method": "POST", "path": "/login",
        "request": {"method": "POST", "url": "http://t/login"}})
    assert d.status_code == 201, d.text
    did = d.json()["id"]
    c = await client.post("/api/v1/api-cases", headers=h, json={
        "project_id": pid, "definition_id": did, "name": "登录成功用例"})
    assert c.status_code == 201, c.text
    cid = c.json()["id"]
    g = {"version": 1, "nodes": [{"key": "s1", "kind": "set_var", "name": "s1",
                                  "config": {"vars": {"a": "1"}}}]}
    s = await client.post("/api/v1/scenarios", headers=h, json={
        "project_id": pid, "name": "登录冒烟场景", "step_graph": g})
    assert s.status_code == 201, s.text
    return did, cid, s.json()["id"]


async def test_search_three_way_hit(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "A")
    did, cid, sid = await _mk_login_trio(client, h, pid)
    # 名称关键词：三路都命中
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["id"] for x in body["definitions"]] == [did]
    assert [x["id"] for x in body["cases"]] == [cid]
    assert [x["id"] for x in body["scenarios"]] == [sid]
    assert body["definitions"][0]["name"] == "登录接口"
    # 路径关键词：只有定义按 path 命中（用例/场景名里没有 /login）
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "/login"}, headers=h)
    assert r2.status_code == 200, r2.text
    b2 = r2.json()
    assert [x["id"] for x in b2["definitions"]] == [did]
    assert b2["cases"] == [] and b2["scenarios"] == []
    # 不相关词：三组皆空（空结果分节是前端契约的一部分）
    r3 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "不存在的词"}, headers=h)
    b3 = r3.json()
    assert b3["definitions"] == [] and b3["cases"] == [] and b3["scenarios"] == []


async def test_search_respects_soft_delete(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "B")
    did, cid, sid = await _mk_login_trio(client, h, pid)
    await client.post("/api/v1/api-definitions/" + did + "/delete",
                      json={"project_id": pid}, headers=h)
    await client.post("/api/v1/api-cases/" + cid + "/delete",
                      json={"project_id": pid}, headers=h)
    await client.post("/api/v1/scenarios/" + sid + "/delete",
                      json={"project_id": pid}, headers=h)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=h)
    body = r.json()
    assert body["definitions"] == [] and body["cases"] == [] and body["scenarios"] == []


async def test_search_case_under_recycled_definition_hidden(client, make_user) -> None:
    """用例行还是 normal，但定义回收了 → 整体不可达（assert_def_alive 同口径），搜不到。"""
    _, h, pid = await _setup(client, make_user, "B2")
    did, cid, _ = await _mk_login_trio(client, h, pid)
    await client.post("/api/v1/api-definitions/" + did + "/delete",
                      json={"project_id": pid}, headers=h)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录成功"}, headers=h)
    assert r.json()["cases"] == [], "回收定义下的 normal 用例不得出现在搜索结果"


async def test_search_private_visibility(client, make_user) -> None:
    boss, h, pid = await _setup(client, make_user, "C")
    # 私有定义 + 私有场景（owner=boss），另一个 MEMBER 搜不到、boss 自己能搜到
    d = await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "私有登录口", "method": "POST", "path": "/plogin",
        "request": {"method": "POST", "url": "http://t/p"}, "project_public": False})
    assert d.status_code == 201, d.text
    mem, hm = await make_user("srchmem")
    await client.put("/api/v1/projects/" + pid + "/members/" + mem.id,
                     json={"role_code": "MEMBER"}, headers=h)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "私有登录"}, headers=hm)
    assert r.json()["definitions"] == [], "别人的私有定义不可见"
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "私有登录"}, headers=h)
    assert [x["id"] for x in r2.json()["definitions"]] == [d.json()["id"]]


async def test_search_perms(client, make_user, session) -> None:
    from app.core.db import get_sessionmaker
    from app.modules.iam.models import RoleTemplate

    _, h, pid = await _setup(client, make_user, "D")
    await _mk_login_trio(client, h, pid)
    # READONLY：*:read 命中 search:read → 200
    ro, ho = await make_user("srchro")
    await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                     json={"role_code": "READONLY"}, headers=h)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=ho)
    assert r.status_code == 200, r.text
    assert r.json()["definitions"], "只读成员应能全局查找"
    # 自定义角色不含 search:read → 403（内置角色都是通配，必须造模板才能钉这条）
    async with get_sessionmaker()() as s:
        s.add(RoleTemplate(code="NOCASE_NORCH", name="无搜索位", builtin=False,
                           perms=["api:*", "project:read"]))
        await s.commit()
    nc, hn = await make_user("srchnc")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + nc.id,
                             json={"role_code": "NOCASE_NORCH"}, headers=h)).status_code == 200
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录"}, headers=hn)
    assert r2.status_code == 403, r2.text
    # 非成员 → 403（数据权限门在 require 之前）
    out, ho2 = await make_user("srchout")
    r3 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录"}, headers=ho2)
    assert r3.status_code == 403, r3.text


async def test_search_like_metacharacters_and_blank(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "E")
    d = await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "覆盖率 100% 报告", "method": "GET", "path": "/cov",
        "request": {"method": "GET", "url": "http://t/cov"}})
    did = d.json()["id"]
    # 判别行：含 "100" 但不含 "100%"——未转义时 "%100%%" 会把它也捞进来
    await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "报告 1000", "method": "GET", "path": "/rep",
        "request": {"method": "GET", "url": "http://t/rep"}})
    # 判别行：a?b 形态——未转义时 "_ " 通配会把 axb 也捞进来
    await client.post("/api/v1/api-definitions", headers=h, json={
        "project_id": pid, "name": "axb流程", "method": "GET", "path": "/axb",
        "request": {"method": "GET", "url": "http://t/axb"}})
    # 元字符按字面：q="100%" 只命中名字里真有「100%」的那条
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "100%"}, headers=h)
    assert [x["id"] for x in r.json()["definitions"]] == [did], \
        "LIKE 通配符必须转义，否则 % 匹配一切"
    # 下划线同理：q="a_b" 谁都不该命中（axb 里的 x 不该被 ? 顶替）
    r1 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "a_b"}, headers=h)
    assert r1.json()["definitions"] == [], "下划线必须按字面匹配，axb流程 不该命中"
    # 空白 q → 422（pydantic min_length/校验）
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "   "}, headers=h)
    assert r2.status_code == 422, r2.text


async def _mk_ui_rows(session, pid, *, name_tag="登录", public=True, owner_id=None,
                      element_status="normal", case_status="normal"):
    """直插 ui_element / ui_case 行（1C T12 时点还没有 UI CRUD API——T5/T6 才落，
    搜索只读这两张表，测试从表这一侧造数据，与读侧口径完全对齐）。"""
    from app.modules.ui_test.models import UiCase, UiElement

    el = UiElement(project_id=pid, name=name_tag + "页提交按钮", locator_type="css",
                   locator="button.submit", project_public=public, owner_id=owner_id,
                   status=element_status)
    uc = UiCase(project_id=pid, name=name_tag + "页冒烟UI用例", priority="P1",
                steps=[{"id": "c1", "type": "open", "input": "http://t/login"}],
                project_public=public, owner_id=owner_id, status=case_status)
    session.add_all([el, uc])
    await session.commit()
    return el.id, uc.id


async def test_search_ui_groups_hit(client, make_user, session) -> None:
    """1C T12①：元素名 / UI 用例名可搜，进各自分组；其余三组不受影响。"""
    _, h, pid = await _setup(client, make_user, "F")
    did, cid, sid = await _mk_login_trio(client, h, pid)
    eid, uid = await _mk_ui_rows(session, pid)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["id"] for x in body["ui_elements"]] == [eid]
    assert [x["id"] for x in body["ui_cases"]] == [uid]
    assert body["ui_elements"][0]["name"] == "登录页提交按钮"
    assert body["ui_cases"][0]["priority"] == "P1"
    # 原有三组不受影响（扩组不许动旧口径）
    assert [x["id"] for x in body["definitions"]] == [did]
    assert [x["id"] for x in body["cases"]] == [cid]
    assert [x["id"] for x in body["scenarios"]] == [sid]
    # 无关词：八组皆空——「恒有各组、空组也是键」是前端分组说「无匹配」的前提
    # （1D T8 扩 adb_cases、1E T9 扩 schedules/notify_channels：缺键 = 前端那一节
    # 整屏空白，不是「无匹配」）
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "不存在的词"}, headers=h)
    b2 = r2.json()
    assert set(b2) == {"definitions", "cases", "scenarios", "ui_elements", "ui_cases",
                       "adb_cases", "schedules", "notify_channels"}
    assert b2["ui_elements"] == [] and b2["ui_cases"] == [] and b2["adb_cases"] == []


async def test_search_ui_respects_soft_delete(client, make_user, session) -> None:
    """1C T12②：回收的元素 / UI 用例（status=recycled）搜不到（R53 两态，同族口径）。"""
    _, h, pid = await _setup(client, make_user, "G")
    eid, uid = await _mk_ui_rows(session, pid)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=h)
    assert [x["id"] for x in r.json()["ui_elements"]] == [eid]
    assert [x["id"] for x in r.json()["ui_cases"]] == [uid]
    from sqlalchemy import update

    from app.modules.ui_test.models import UiCase, UiElement

    await session.execute(update(UiElement).where(UiElement.id == eid)
                          .values(status="recycled"))
    await session.execute(update(UiCase).where(UiCase.id == uid)
                          .values(status="recycled"))
    await session.commit()
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录"}, headers=h)
    assert r2.json()["ui_elements"] == [], "回收元素不得出现在搜索结果"
    assert r2.json()["ui_cases"] == [], "回收 UI 用例不得出现在搜索结果"


async def test_search_ui_private_visibility(client, make_user, session) -> None:
    """1C T12③：UI 行走 1A 可见性谓词——别人的私有元素/UI 用例不可见，owner 自己可见。"""
    boss, h, pid = await _setup(client, make_user, "H")
    await _mk_ui_rows(session, pid, public=False, owner_id=boss.id)
    mem, hm = await make_user("srchmem_ui")
    await client.put("/api/v1/projects/" + pid + "/members/" + mem.id,
                     json={"role_code": "MEMBER"}, headers=h)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=hm)
    assert r.json()["ui_elements"] == [], "别人的私有元素不可见"
    assert r.json()["ui_cases"] == [], "别人的私有 UI 用例不可见"
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录"}, headers=h)
    assert len(r2.json()["ui_elements"]) == 1 and len(r2.json()["ui_cases"]) == 1


async def test_search_kind_narrowing_ui(client, make_user, session) -> None:
    """1C T12⑦：kind 收窄扩到五类；非法 kind 仍 422（pattern 是白名单不是摆设）。"""
    _, h, pid = await _setup(client, make_user, "I")
    await _mk_login_trio(client, h, pid)
    eid, uid = await _mk_ui_rows(session, pid)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录", "kind": "ui_element"},
                         headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["id"] for x in body["ui_elements"]] == [eid]
    assert body["ui_cases"] == [] and body["definitions"] == [] \
        and body["cases"] == [] and body["scenarios"] == []
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录", "kind": "ui_case"},
                          headers=h)
    assert [x["id"] for x in r2.json()["ui_cases"]] == [uid]
    assert r2.json()["ui_elements"] == []
    r3 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录", "kind": "not_a_kind"},
                          headers=h)
    assert r3.status_code == 422, "非法 kind 必须 422，pattern 收窄是白名单语义"


async def _mk_adb_rows(session, pid, *, name_tag="登录", public=True, owner_id=None,
                       case_status="normal"):
    """直插 adb_case 行（与 _mk_ui_rows 同族：搜索只读这张表，测试从表这一侧造数据，
    与读侧口径完全对齐；1D T8）。"""
    from app.modules.adb_test.models import AdbCase

    ac = AdbCase(project_id=pid, name=name_tag + "页ADB用例", priority="P1",
                 steps=[{"id": "a1", "type": "shell", "config": {"cmd": "echo ok"}}],
                 project_public=public, owner_id=owner_id, status=case_status, step_count=1)
    session.add(ac)
    await session.commit()
    return ac.id


async def test_search_adb_group_hit_and_empty_group_contract(client, make_user, session) -> None:
    """1D T8①：ADB 用例名可搜、带优先级；无匹配时 adb_cases 空组也必须在场
    （「空组也必须在场」契约：缺键 = 前端那一节整屏空白，不是「无匹配」）。"""
    _, h, pid = await _setup(client, make_user, "J")
    aid = await _mk_adb_rows(session, pid)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["id"] for x in body["adb_cases"]] == [aid]
    assert body["adb_cases"][0]["name"] == "登录页ADB用例"
    assert body["adb_cases"][0]["priority"] == "P1"
    # 无关词：adb_cases 键在场且为空——前端分节靠这个键说「这一组无匹配」
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "不存在的词"}, headers=h)
    assert r2.status_code == 200, r2.text
    b2 = r2.json()
    assert "adb_cases" in b2, "空组也必须在场：缺 adb_cases 键 = 前端整屏空白"
    assert b2["adb_cases"] == []


async def test_search_adb_respects_soft_delete(client, make_user, session) -> None:
    """1D T8②：回收（status=recycled）的 ADB 用例搜不到（R53 两态，UI 同族口径）。"""
    _, h, pid = await _setup(client, make_user, "K")
    aid = await _mk_adb_rows(session, pid)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=h)
    assert [x["id"] for x in r.json()["adb_cases"]] == [aid]
    from sqlalchemy import update

    from app.modules.adb_test.models import AdbCase

    await session.execute(update(AdbCase).where(AdbCase.id == aid).values(status="recycled"))
    await session.commit()
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录"}, headers=h)
    assert r2.json()["adb_cases"] == [], "回收 ADB 用例不得出现在搜索结果"


async def test_search_adb_private_visibility(client, make_user, session) -> None:
    """1D T8③：ADB 行走 1A 可见性谓词——别人的私有用例不可见，owner 自己可见。"""
    boss, h, pid = await _setup(client, make_user, "L")
    await _mk_adb_rows(session, pid, public=False, owner_id=boss.id)
    mem, hm = await make_user("srchmem_adb")
    await client.put("/api/v1/projects/" + pid + "/members/" + mem.id,
                     json={"role_code": "MEMBER"}, headers=h)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=hm)
    assert r.json()["adb_cases"] == [], "别人的私有 ADB 用例不可见"
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录"}, headers=h)
    assert len(r2.json()["adb_cases"]) == 1, "owner 自己的私有用例可见"


async def test_search_kind_narrowing_adb(client, make_user, session) -> None:
    """1D T8⑦：kind=adb_case 只回 adb_cases 组；曾「非法」的 adb_case 现在 200，
    bogus kind 仍 422（pattern 白名单跟着扩）。"""
    _, h, pid = await _setup(client, make_user, "M")
    await _mk_login_trio(client, h, pid)
    aid = await _mk_adb_rows(session, pid)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录", "kind": "adb_case"},
                         headers=h)
    assert r.status_code == 200, "1D T8 后 adb_case 是合法 kind，必须 200 而不是 422：" + r.text
    body = r.json()
    assert [x["id"] for x in body["adb_cases"]] == [aid]
    assert body["ui_cases"] == [] and body["ui_elements"] == [] \
        and body["definitions"] == [] and body["cases"] == [] and body["scenarios"] == []
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录", "kind": "not_a_kind"},
                          headers=h)
    assert r2.status_code == 422, "非法 kind 必须 422，pattern 收窄是白名单语义"


async def test_search_registry_surface() -> None:
    import app.modules.search.services  # noqa: F401
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("search_assets")
    assert spec is not None
    assert spec.tool is True, "Ctrl+K 是读工具，必须进工具面"
    assert spec.effect == "read"
    assert spec.perm == "search:read"
    assert spec.http is not None and spec.http["method"] == "GET"


# —— 1E T9（R109 四处同改）：定时任务 / 通知渠道两路 ————————————————


async def _mk_1e_rows(session, pid, *, name_tag="登录", creator_id=None):
    """直插 schedule_task / notify_channel 行（与 _mk_ui_rows 同族：搜索只读这两张表，
    测试从表这一侧造数据；渠道 config 塞一个假密钥串，用来反向钉「绝不回显」）。"""
    from app.modules.notify.models import NotifyChannel
    from app.modules.schedule.models import ScheduleTask

    task = ScheduleTask(project_id=pid, name=name_tag + "定时任务",
                        subject_type="scenario", subject_id="scn-x",
                        cron="0 2 * * *", enabled=1, created_by=creator_id)
    chan = NotifyChannel(name=name_tag + "渠道", type="WEBHOOK",
                         config={"url": "https://x/hook?token=SECRETTOKEN"})
    session.add_all([task, chan])
    await session.commit()
    return task.id, chan.id


async def test_search_1e_groups_hit_and_none_priority_is_honest(client, make_user,
                                                                session) -> None:
    """1E T9①：定时任务（按项目过滤）与渠道（平台级）可按名搜到；两张表都没有
    优先级概念——priority 如实 None（ui_element 同形先例），不许拿 cron/type 冒充。"""
    _, h, pid = await _setup(client, make_user, "N")
    tid, chid = await _mk_1e_rows(session, pid)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["id"] for x in body["schedules"]] == [tid]
    assert [x["id"] for x in body["notify_channels"]] == [chid]
    assert body["schedules"][0]["priority"] is None
    assert body["notify_channels"][0]["priority"] is None
    # 泄密反向钉：条目键集仍是 SearchAssetItem 的字段——config 里的 token 串
    # 既不在键里也不在值里（结构上进不来：查询根本不 SELECT config 列）
    blob = json.dumps(body, ensure_ascii=False)
    assert "SECRETTOKEN" not in blob and "https://x/hook" not in blob


async def test_search_1e_schedule_is_project_scoped(client, make_user, session) -> None:
    """1E T9②：定时任务是项目级——B 项目的成员搜不到 A 项目的任务（schedule_task_list
    同款 project_id 显式过滤；渠道是平台级，两边都能看到同一条）。"""
    _, h, pid_a = await _setup(client, make_user, "O")
    chid = (await _mk_1e_rows(session, pid_a))[1]
    _, hb, pid_b = await _setup(client, make_user, "P")
    assert pid_b != pid_a
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid_b, "q": "登录"}, headers=hb)
    body = r.json()
    assert body["schedules"] == [], "别的项目的定时任务不可见（project_id 显式过滤）"
    assert [x["id"] for x in body["notify_channels"]] == [chid], \
        "渠道是平台级配置（§4 无 project_id），跨项目可见是设计口径"


async def test_search_1e_missing_read_perm_yields_empty_group_not_403(client, make_user,
                                                                      session) -> None:
    """1E T9③：角色有 search:read 但没有 schedule:task:read / notify:channel:read →
    整体 200，新两组如实空（其余六组不受影响）——一组无权不许把整次 Ctrl+K 打成 403。"""
    boss, h, pid = await _setup(client, make_user, "Q")
    await _mk_1e_rows(session, pid)
    await _mk_login_trio(client, h, pid)
    from app.core.db import get_sessionmaker
    from app.modules.iam.models import RoleTemplate

    async with get_sessionmaker()() as s:
        s.add(RoleTemplate(code="SRCH_NO_SCHNOTIFY", name="搜索无调度渠道位", builtin=False,
                           perms=["search:read", "api:*", "project:read"]))
        await s.commit()
    nu, hn = await make_user("srchnosn")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + nu.id,
                             json={"role_code": "SRCH_NO_SCHNOTIFY"},
                             headers=h)).status_code == 200
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录"}, headers=hn)
    assert r.status_code == 200, "缺调度/渠道读位只空那两组，不许 403：" + r.text
    body = r.json()
    assert body["schedules"] == [] and body["notify_channels"] == []
    assert body["definitions"], "其余组不许被新两组的权限闸牵连"


async def test_search_kind_narrowing_1e(client, make_user, session) -> None:
    """1E T9⑦：kind 白名单 += schedule/notify_channel（工具契约成员，逐条钉）；
    收窄时只回对应组；bogus kind 仍 422。"""
    _, h, pid = await _setup(client, make_user, "R")
    await _mk_login_trio(client, h, pid)
    tid, chid = await _mk_1e_rows(session, pid)
    r = await client.get("/api/v1/search-assets",
                         params={"project_id": pid, "q": "登录", "kind": "schedule"},
                         headers=h)
    assert r.status_code == 200, "1E T9 后 schedule 是合法 kind：" + r.text
    body = r.json()
    assert [x["id"] for x in body["schedules"]] == [tid]
    assert body["notify_channels"] == [] and body["definitions"] == [] \
        and body["cases"] == [] and body["scenarios"] == []
    r2 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录", "kind": "notify_channel"},
                          headers=h)
    assert r2.status_code == 200, "1E T9 后 notify_channel 是合法 kind：" + r2.text
    assert [x["id"] for x in r2.json()["notify_channels"]] == [chid]
    assert r2.json()["schedules"] == []
    r3 = await client.get("/api/v1/search-assets",
                          params={"project_id": pid, "q": "登录", "kind": "not_a_kind"},
                          headers=h)
    assert r3.status_code == 422, "非法 kind 必须 422，pattern 收窄是白名单语义"
