"""D139：删环境此前不查引用，被引用的环境删掉后只在**执行时**以 404 现形。

形状：三条引用路（scenario / ui_case / schedule_task）各钉一条「1 条引用 ⇒ 409 in_use +
逐域计数」，外加「解绑后可删」（证明不是一刀封死）与「不泄漏他项目 id」。
口径全部照 notify 的删除引用检测（notify/service.py:notify_channel_delete + _schedule_refs）：
count 由数据决定不由权限决定、明细按各域 :read 隐藏、details_hidden 与 details_truncated 分开。

引用行直接经 session 落库（notify 的 test_channel_delete_in_use 同法）：走 HTTP 建三条
引用要牵进场景编辑器 / UI 用例 / 定时任务三个域的校验，那是本用例的干扰项不是被测物。

run_record 不入引用清单是**裁定**不是遗漏——它是出生快照（execution/services.py 落 run 时
连 env_name 一起写），把历史 run 算进来的后果是「任何跑过的环境永远删不掉」。这里用
rt_run_does_not_block_delete 把这条裁定钉住：环境跑过、历史报告还在，环境仍可删。
"""
from __future__ import annotations

from app.modules.execution.models import RunRecord
from app.modules.scenario.models import Scenario
from app.modules.schedule.models import ScheduleTask
from app.modules.ui_test.models import UiCase

BASE = "/api/v1"


async def _env(client, h, pid, name="待删环境"):
    r = await client.post(BASE + "/envs", headers=h,
                          json={"project_id": pid, "name": name, "config": {}})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _mk(client, make_user, tag):
    _, h = await make_user("envref_" + tag)
    pid = (await client.post(BASE + "/projects", json={"name": "envrefproj_" + tag}, headers=h)).json()["id"]
    return pid, h


async def test_env_delete_blocked_by_scenario(client, make_user, session) -> None:
    pid, h = await _mk(client, make_user, "sc")
    eid = await _env(client, h, pid)
    session.add(Scenario(project_id=pid, name="绑了环境的场景", step_graph={"version": 1, "nodes": []}, env_id=eid))
    await session.commit()

    d = await client.request("DELETE", BASE + "/envs/" + eid, json={"project_id": pid}, headers=h)
    assert d.status_code == 409 and d.json()["code"] == "in_use", d.text
    det = d.json()["details"]
    assert det["count"] == 1 and det["env_id"] == eid
    sc = det["scenario"]
    assert sc["count"] == 1 and sc["details_hidden"] is False and sc["details_truncated"] is False
    assert sc["items"][0]["name"] == "绑了环境的场景"
    # 未引用的域不出现在 details 里：给前端一个「0 也带回来」等于让它自己去猜谁拦的
    assert "ui_case" not in det and "schedule_task" not in det
    # 环境还在（409 必须是一个字节都没动）
    g = await client.get(BASE + "/envs", params={"project_id": pid}, headers=h)
    assert [x["id"] for x in g.json()["items"]] == [eid]


async def test_env_delete_blocked_by_ui_case(client, make_user, session) -> None:
    pid, h = await _mk(client, make_user, "ui")
    eid = await _env(client, h, pid)
    session.add(UiCase(project_id=pid, name="绑了环境的 UI 用例", steps=[], env_id=eid))
    await session.commit()

    d = await client.request("DELETE", BASE + "/envs/" + eid, json={"project_id": pid}, headers=h)
    assert d.status_code == 409 and d.json()["code"] == "in_use", d.text
    det = d.json()["details"]
    assert det["count"] == 1 and det["ui_case"]["count"] == 1
    assert "scenario" not in det


async def test_env_delete_blocked_by_schedule_task(client, make_user, session) -> None:
    pid, h = await _mk(client, make_user, "sch")
    eid = await _env(client, h, pid)
    session.add(ScheduleTask(project_id=pid, name="夜跑", subject_type="scenario",
                             subject_id="s1", cron="0 2 * * *", env_id=eid))
    await session.commit()

    d = await client.request("DELETE", BASE + "/envs/" + eid, json={"project_id": pid}, headers=h)
    assert d.status_code == 409 and d.json()["code"] == "in_use", d.text
    assert d.json()["details"]["schedule_task"]["count"] == 1


async def test_env_delete_counts_every_domain_at_once(client, make_user, session) -> None:
    """三域各一条：总数、逐域计数、人话文案三样都得对。

    这条是「只数了一个域」那种变异的杀手——单域用例对它全绿，因为它只数一域时
    恰好也报得出那一域。故这里必须同时断言三个域**都**在 details 里。
    """
    pid, h = await _mk(client, make_user, "all")
    eid = await _env(client, h, pid)
    session.add_all([
        Scenario(project_id=pid, name="场景一条", step_graph={"version": 1, "nodes": []}, env_id=eid),
        Scenario(project_id=pid, name="场景两条", step_graph={"version": 1, "nodes": []}, env_id=eid),
        UiCase(project_id=pid, name="UI 一条", steps=[], env_id=eid),
        ScheduleTask(project_id=pid, name="定时一条", subject_type="scenario",
                     subject_id="s1", cron="0 2 * * *", env_id=eid),
    ])
    await session.commit()

    d = await client.request("DELETE", BASE + "/envs/" + eid, json={"project_id": pid}, headers=h)
    assert d.status_code == 409, d.text
    det = d.json()["details"]
    assert det["count"] == 4
    assert det["scenario"]["count"] == 2 and det["ui_case"]["count"] == 1
    assert det["schedule_task"]["count"] == 1
    body = d.json()["message"]
    assert "场景 2 条" in body and "UI 用例 1 条" in body and "定时任务 1 条" in body


async def test_env_delete_ok_after_unbind(client, make_user, session) -> None:
    """解绑后可删：门是「先解绑再删」，不是一刀封死这个环境。"""
    pid, h = await _mk(client, make_user, "unbind")
    eid = await _env(client, h, pid)
    sc = Scenario(project_id=pid, name="会解绑的场景", step_graph={"version": 1, "nodes": []}, env_id=eid)
    session.add(sc)
    await session.commit()
    sc_id = sc.id  # HTTP 端的 rollback 会过期 ORM 实例：id 提前存成标量

    d1 = await client.request("DELETE", BASE + "/envs/" + eid, json={"project_id": pid}, headers=h)
    assert d1.status_code == 409, d1.text

    fresh = await session.get(Scenario, sc_id)
    assert fresh is not None
    fresh.env_id = None
    await session.commit()

    d2 = await client.request("DELETE", BASE + "/envs/" + eid, json={"project_id": pid}, headers=h)
    assert d2.status_code == 200 and d2.json()["ok"] is True, d2.text
    g = await client.get(BASE + "/envs", params={"project_id": pid}, headers=h)
    assert g.json()["items"] == []


async def test_env_delete_ok_with_history_run(client, make_user, session) -> None:
    """裁定「run_record 不算引用」的钉子：跑过的环境仍可删，历史报告仍可读。

    如果哪天有人把 run_record 加进 _ENV_REF_DOMAINS，这条会红——那时要么改裁定并
    写明「跑过的环境永远删不掉」是有意接受的代价，要么给 run 侧补 env 改名能力。
    """
    pid, h = await _mk(client, make_user, "run")
    eid = await _env(client, h, pid, name="跑过的环境")
    session.add(RunRecord(project_id=pid, subject_type="scenario", subject_id="s1",
                          subject_name="跑过的场景", env_id=eid, env_name="跑过的环境",
                          trigger="manual", status="passed"))
    await session.commit()

    d = await client.request("DELETE", BASE + "/envs/" + eid, json={"project_id": pid}, headers=h)
    assert d.status_code == 200, d.text


async def test_env_delete_blocked_by_cross_project_reference(client, make_user, session) -> None:
    """别的项目留着的引用行也拦，但只报条数不报名字（M5 的杀手）。

    这条钉的是 D139 的**病灶本体**：环境被删后别的项目里还挂着指向它的行。跨项目改绑的
    写入洞已由 D181 关上（scenario create/update 绑 env 前按 (id, project_id) 取环境行，
    外项目 404），但**存量脏行**与直接落库的行仍在——删门必须继续 fail closed，
    「看不见」不等于「没有」。
    明细只列删除动作所在项目：这屏是本项目视角，点一个够不着的名字只会让人在本项目里找它。
    """
    pid_a, h = await _mk(client, make_user, "xa")
    pid_b = (await client.post(BASE + "/projects", json={"name": "envrefproj_xb"}, headers=h)).json()["id"]
    eid_a = await _env(client, h, pid_a, name="A 的环境")
    # B 项目的场景指向 A 环境（经 session 直造 = 模拟 D181 修门前落库的存量脏行；
    # 今天的 API 两条写路径都拒绝这种绑法，见 test_scenario_update_rejects_foreign_env）
    session.add(Scenario(project_id=pid_b, name="跨项目脏行的名字", step_graph={"version": 1, "nodes": []}, env_id=eid_a))
    await session.commit()

    d = await client.request("DELETE", BASE + "/envs/" + eid_a, json={"project_id": pid_a}, headers=h)
    assert d.status_code == 409 and d.json()["code"] == "in_use", d.text
    det = d.json()["details"]["scenario"]
    assert det["count"] == 1, "跨项目的引用必须计入——放过它就是删完接着 404"
    assert det["own"] == 0 and det["foreign"] == 1, "数得出却不点名，要说出口"
    assert det["items"] == [], "明细只列本项目，这条在 B 项目，故为空"
    # 空的原因必须说准：这条是「项目范围」空的，不是「权限」空的。把 foreign 裹进
    # details_hidden 会让一个有读权限的人看到「无权限查看」——那是谎，他会去申请权限，
    # 而申请到了也还是看不见（这三格在 M7 变异下此前全绿）。
    assert det["details_hidden"] is False, "有 :read 却不给看，理由只能是项目范围"
    assert det["details_truncated"] is False
    assert "跨项目脏行的名字" not in d.text, "本项目之外的引用一个名字都不许出现"


async def test_scenario_update_rejects_foreign_env(client, make_user) -> None:
    """D181 改口完成：跨项目改绑从「证据」翻成「守卫」。

    此前这里是现状证据测试（断言 PATCH 写外项目 env 返回 200——「将来补上归属校验这条会
    红，那时连测试一起改口」），那个时间到了：scenario_update 落 env_id 前按
    (id, project_id) 取环境行（scenario/services.py 的 _env，形状照 _mod/env_update），
    外项目环境按本仓「本项目内查不到即 404、与不存在同码不泄露存在性」的既有口径拒掉
    （env/services.py resolve_env 同款）。同项目的正常绑法必须照常 200——别把门做成封死。
    """
    pid_a, h = await _mk(client, make_user, "fxa")
    pid_b = (await client.post(BASE + "/projects", json={"name": "envrefproj_fxb"}, headers=h)).json()["id"]
    eid_a = await _env(client, h, pid_a, name="A 的环境（不该被 B 绑上）")
    eid_b = await _env(client, h, pid_b, name="B 自己的环境")
    r0 = await client.post(BASE + "/scenarios", headers=h, json={
        "project_id": pid_b, "name": "想跨项目改绑的场景", "step_graph": {"version": 1, "nodes": []}})
    assert r0.status_code == 201, r0.text
    sid = r0.json()["id"]

    v = (await client.get(BASE + "/scenarios/" + sid, params={"project_id": pid_b}, headers=h)).json()["version"]
    r = await client.patch(BASE + "/scenarios/" + sid, headers=h,
                           json={"project_id": pid_b, "env_id": eid_a, "env_set": True, "version": v})
    assert r.status_code == 404 and r.json()["code"] == "not_found", \
        "外项目环境必须与不存在同码拒掉——写进去就是 D139 删门要数的跨项目脏行：" + r.text
    assert r.json()["details"]["env_id"] == eid_a

    # 拒绝必须是**一个字节都没写**：乐观锁同样不许被拒掉的 PATCH 消耗掉
    g = await client.get(BASE + "/scenarios/" + sid, params={"project_id": pid_b}, headers=h)
    assert g.json()["env_id"] is None, "外项目 env 不许落库"
    assert g.json()["version"] == v, "被拒的 PATCH 不许推进 version"

    # 同项目环境照常可绑（门不是封死绑定）
    r2 = await client.patch(BASE + "/scenarios/" + sid, headers=h,
                            json={"project_id": pid_b, "env_id": eid_b, "env_set": True, "version": v})
    assert r2.status_code == 200 and r2.json()["env_id"] == eid_b, r2.text

    # 解绑（env_set=True + env_id=None）不校验、照常工作——解开脏指向不该要求指向有效
    v2 = r2.json()["version"]
    r3 = await client.patch(BASE + "/scenarios/" + sid, headers=h,
                            json={"project_id": pid_b, "env_id": None, "env_set": True, "version": v2})
    assert r3.status_code == 200 and r3.json()["env_id"] is None, r3.text

    # A 环境没删掉，B 环境不受牵连
    ga = await client.get(BASE + "/envs", params={"project_id": pid_a}, headers=h)
    assert [x["id"] for x in ga.json()["items"]] == [eid_a]


async def test_scenario_create_rejects_foreign_env(client, make_user) -> None:
    """D181 的同一道洞在 create 路径（scenario_create 也直接写 payload.env_id）。

    改绑被拒、创建放行 = 门形同虚设（先建后改绕不过去，但「新建即绑外项目环境」照样
    生产 D139 的脏行）。口径与 PATCH 腿完全一致：(id, project_id) 取不到 → 404 not_found。
    创建带**本项目**环境必须照常 201——同一条校验别把正路堵死。
    """
    pid_a, h = await _mk(client, make_user, "cfa")
    pid_b = (await client.post(BASE + "/projects", json={"name": "envrefproj_cfb"}, headers=h)).json()["id"]
    eid_a = await _env(client, h, pid_a, name="A 的环境")
    eid_b = await _env(client, h, pid_b, name="B 自己的环境")

    bad = await client.post(BASE + "/scenarios", headers=h, json={
        "project_id": pid_b, "name": "创建即绑外项目环境",
        "step_graph": {"version": 1, "nodes": []}, "env_id": eid_a})
    assert bad.status_code == 404 and bad.json()["code"] == "not_found", bad.text

    good = await client.post(BASE + "/scenarios", headers=h, json={
        "project_id": pid_b, "name": "创建绑本项目环境",
        "step_graph": {"version": 1, "nodes": []}, "env_id": eid_b})
    assert good.status_code == 201 and good.json()["env_id"] == eid_b, good.text


async def test_env_delete_details_keep_own_project_names(client, make_user, session) -> None:
    """本项目内的引用照常给名字，且 foreign=0（防反向过度：别把明细一律咽掉）。"""
    pid, h = await _mk(client, make_user, "own")
    eid = await _env(client, h, pid, name="本项目引用的环境")
    session.add(Scenario(project_id=pid, name="本项目的场景", step_graph={"version": 1, "nodes": []}, env_id=eid))
    await session.commit()

    d = await client.request("DELETE", BASE + "/envs/" + eid, json={"project_id": pid}, headers=h)
    det = d.json()["details"]["scenario"]
    assert det["count"] == 1 and det["foreign"] == 0
    assert det["details_hidden"] is False and det["details_truncated"] is False
    assert [i["name"] for i in det["items"]] == ["本项目的场景"]


async def test_env_delete_blocked_without_domain_read(client, make_user, session) -> None:
    """缺 scenario:read 也照样拦，但明细隐瞒：拦不拦由数据决定，不由权限决定。

    反过来的形状才是危险的——「没读权限的人能绕开引用检测直接删」。自定义角色
    （D37 起为真）是这里唯一的尺：内置四枚里能删的三枚都同时持三个域的 :read
    （MEMBER=["*","-*:delete","-*:manage","-system:*"] 只收回 delete/manage），
    内置角色照不出这一格。
    """
    _, h_boss = await make_user("envref_boss")
    pid = (await client.post(BASE + "/projects", json={"name": "envrefproj_blind"}, headers=h_boss)).json()["id"]
    r = await client.post(BASE + "/custom-roles", headers=h_boss, json={
        "project_id": pid, "name": "能删环境的瞎子", "template_code": "READONLY",
        "perms": ["env:config:delete"]})
    assert r.status_code == 201, r.text
    code = r.json()["code"]
    _, h_blind = await make_user("envref_blind")
    me = (await client.get(BASE + "/auth/me", headers=h_blind)).json()
    assert (await client.put(f"{BASE}/projects/{pid}/members/{me['id']}",
                             json={"role_code": code}, headers=h_boss)).status_code in (200, 201)

    eid = await _env(client, h_boss, pid, name="被引用的环境")
    session.add(Scenario(project_id=pid, name="不该被看见的场景名", step_graph={"version": 1, "nodes": []}, env_id=eid))
    await session.commit()

    d = await client.request("DELETE", BASE + "/envs/" + eid, json={"project_id": pid}, headers=h_blind)
    assert d.status_code == 409 and d.json()["code"] == "in_use", d.text
    det = d.json()["details"]["scenario"]
    assert det["count"] == 1, "count 必须由数据决定——权限不足不该把引用数抹成 0"
    assert det["details_hidden"] is True and det["items"] == []
    assert "不该被看见的场景名" not in d.text, "无 :read 时明细里一个名字都不许出现"


async def test_env_delete_details_truncate_at_cap(client, make_user, session) -> None:
    """引用多于 REF_DETAIL_CAP：count 报全数，items 只给前 20，truncated 必须说出口。

    此前所有用例只断言过 details_truncated is False——一条从没红过的旗标等于没这条轴：
    把 CAP 抬到 1000、或把 truncated 写死 False，旧用例全绿。这条是那两个变异的杀手。
    count 与 items 数不一致时必须能看出「是被截的」而不是「只有这些」，否则前端会拿
    items.length 当总数用（notify 的 REF_DETAIL_CAP 同尺，那边也是这么判的）。
    """
    from app.modules.env.services import REF_DETAIL_CAP

    pid, h = await _mk(client, make_user, "cap")
    eid = await _env(client, h, pid, name="被大量引用的环境")
    session.add_all([
        Scenario(project_id=pid, name=f"引用场景 {i:02d}", step_graph={"version": 1, "nodes": []}, env_id=eid)
        for i in range(REF_DETAIL_CAP + 1)
    ])
    await session.commit()

    d = await client.request("DELETE", BASE + "/envs/" + eid, json={"project_id": pid}, headers=h)
    assert d.status_code == 409, d.text
    det = d.json()["details"]["scenario"]
    assert det["count"] == REF_DETAIL_CAP + 1, "总数不许被明细上限截掉"
    assert det["own"] == REF_DETAIL_CAP + 1 and det["foreign"] == 0
    assert len(det["items"]) == REF_DETAIL_CAP
    assert det["details_truncated"] is True
    assert det["details_hidden"] is False, "截断与权限是两件事，不许互相裹"
    # 数不一致要说出口：items 少一条的唯一理由是截断，前端不许拿 items.length 当总数
    assert det["count"] == det["own"] + det["foreign"]
    assert len(det["items"]) <= det["own"]


async def test_ref_detail_cap_is_one_ruler_across_modules(client) -> None:
    """四份 REF_DETAIL_CAP 必须同值：同一条 in_use 语义不该有四把尺。

    这四个常量是各自 copy 出来的（无公共常量模块，契约 1 也不许 env 去 import 别域），
    所以漂移只能这样守：把 20 写死在这，并列出全部四家。谁单独改成 50/1000，这条红——
    后果是同一个「引用超限」错误在四个页面上给出长短不一的明细，前端没法统一渲染，
    而 details_truncated 的含义（「被 20 截了」）也跟着变味。
    加第五个引用检测时，把它一并加进下面的清单，别让它悄悄飘。
    """
    from app.modules.adb_test.device_services import REF_DETAIL_CAP as ADB_CAP
    from app.modules.env.services import REF_DETAIL_CAP as ENV_CAP
    from app.modules.iam.role_services import REF_DETAIL_CAP as ROLE_CAP
    from app.modules.notify.service import REF_DETAIL_CAP as NOTIFY_CAP

    assert ENV_CAP == NOTIFY_CAP == ROLE_CAP == ADB_CAP == 20, (
        f"env={ENV_CAP} notify={NOTIFY_CAP} role={ROLE_CAP} adb={ADB_CAP}")


async def test_env_delete_still_404_for_unknown_id(client, make_user) -> None:
    """引用检测排在存在性之后：不存在的 id 仍是 404，不被 409 的形状污染。"""
    pid, h = await _mk(client, make_user, "nf")
    d = await client.request("DELETE", BASE + "/envs/不存在的id", json={"project_id": pid}, headers=h)
    assert d.status_code == 404 and d.json()["code"] == "not_found", d.text
    assert "count" not in (d.json().get("details") or {})
