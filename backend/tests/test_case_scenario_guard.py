"""1B Review Focus 9（勘误后口径）：删除被未回收场景引用的资产要分级拦。

原计划写的是「数据集 used_by 把场景引用一起算」，复核数据模型后按字面做是空操作：
数据集只被用例绑（ApiCase.dataset_id），场景步骤的 ref 是 **case_id**，scenario 与
step_graph 里根本没有 dataset 字段——加进去数的还是同一批用例。所以本文件钉的是
计划勘误后的两条真缺口（§6.5「删除被场景引用的用例 → 警告并列出引用」）：

① 软删可逆 → force 两段式（默认 409 列引用，force=true 才真回收）；
② 硬删不可逆 → 一律硬拦（api_case_purge、以及「绑定它的活用例正被场景引用」的
   data_set_delete）。
还有一条取证过的权限事实：删除者可能没有 scenario:read（role_template 可自定义），
此时**照拦，但明细留空并说明原因**——「查不到所以说不清被谁引用」比「假装没人引用」诚实。
"""
from __future__ import annotations


async def _setup(client, make_user, tag):
    boss, hb = await make_user("rf9boss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "prf9" + tag},
                             headers=hb)).json()["id"]
    return boss, hb, pid


async def _mk_case(client, h, pid, name="下单成功"):
    d = (await client.post("/api/v1/api-definitions", json={
        "project_id": pid, "name": "下单", "method": "POST", "path": "/order",
        "request": {"method": "POST", "url": "http://t/order"}}, headers=h)).json()
    c = (await client.post("/api/v1/api-cases", json={
        "project_id": pid, "definition_id": d["id"], "name": name}, headers=h)).json()
    return d, c


async def _mk_scene(client, h, pid, case_id, name="下单场景"):
    graph = {"version": 1, "nodes": [{"key": "a.login", "kind": "api_case", "ref": case_id}]}
    r = await client.post("/api/v1/scenarios", json={
        "project_id": pid, "name": name, "step_graph": graph}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


# ---------- ① 软删：force 两段式 ----------

async def test_delete_case_referenced_by_scenario_needs_force(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "A")
    _, case = await _mk_case(client, h, pid)
    scene = await _mk_scene(client, h, pid, case["id"])

    r = await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["code"] == "referenced_by_scenario", body
    # 引用方要能点名：光说「被引用」用户不知道该去哪儿解绑（§11.4.18 引用检测弹窗）
    assert body["details"]["count"] == 1
    got = body["details"]["scenarios"][0]
    assert got["scenario_id"] == scene["id"]
    assert got["scenario_name"] == "下单场景"
    assert got["step_keys"] == ["a.login"]

    # 被拦下来之后用例必须还是 normal（409 不能顺手把状态改了）
    got2 = await client.get("/api/v1/api-cases/" + case["id"], params={"project_id": pid}, headers=h)
    assert got2.json()["status"] == "normal", "409 之后用例不该已经被回收"

    # force=true 才真回收
    f = await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                          json={"project_id": pid, "force": True}, headers=h)
    assert f.status_code == 200, f.text
    got3 = await client.get("/api/v1/api-cases/" + case["id"], params={"project_id": pid}, headers=h)
    assert got3.json()["status"] == "recycled"


async def test_delete_case_referenced_only_by_recycled_scenario_is_free(client, make_user) -> None:
    """场景自己进了回收站就不该继续拦着用例：与 scenario_references 的口径同一套。"""
    _, h, pid = await _setup(client, make_user, "B")
    _, case = await _mk_case(client, h, pid)
    scene = await _mk_scene(client, h, pid, case["id"])
    assert (await client.post("/api/v1/scenarios/" + scene["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    r = await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text


# ---------- ② 硬删：一律硬拦 ----------

async def test_purge_case_still_referenced_is_blocked(client, make_user) -> None:
    """回收不等于解绑：场景还指着它，purge 掉就是让场景步骤永久悬空。"""
    _, h, pid = await _setup(client, make_user, "C")
    _, case = await _mk_case(client, h, pid)
    await _mk_scene(client, h, pid, case["id"])
    assert (await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                              json={"project_id": pid, "force": True}, headers=h)).status_code == 200
    r = await client.post("/api/v1/api-cases/" + case["id"] + "/purge", json={
        "project_id": pid, "confirm_name": case["name"]}, headers=h)
    assert r.status_code == 409, r.text
    assert r.json()["code"] == "referenced_by_scenario", r.json()
    # 用例还活着（没被物理删）
    assert (await client.get("/api/v1/api-cases/" + case["id"],
                             params={"project_id": pid}, headers=h)).status_code == 200


async def test_purge_case_after_scenario_purged_succeeds(client, make_user) -> None:
    """引用消失后 purge 必须放行——否则「每个软删资产都有出口」这条口碑就破了。"""
    _, h, pid = await _setup(client, make_user, "D")
    _, case = await _mk_case(client, h, pid)
    scene = await _mk_scene(client, h, pid, case["id"])
    await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                      json={"project_id": pid, "force": True}, headers=h)
    assert (await client.post("/api/v1/scenarios/" + scene["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    p = await client.post("/api/v1/scenarios/" + scene["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "下单场景"}, headers=h)
    assert p.status_code == 200, p.text
    r = await client.post("/api/v1/api-cases/" + case["id"] + "/purge", json={
        "project_id": pid, "confirm_name": case["name"]}, headers=h)
    assert r.status_code == 200, r.text


async def test_dataset_delete_blocked_through_bound_case(client, make_user) -> None:
    """活用例绑着数据集 → 本来就被 used_by 拦（这条先钉住：新加的口子不能把老规矩顶掉）。

    但只说「被 1 条用例引用」在这个场景里是**半个答案**：那条用例还被场景引用着，
    用户照着提示去回收用例，会一头撞上另一道 409。所以提示必须把场景一起说出来。
    """
    _, h, pid = await _setup(client, make_user, "E")
    _, case = await _mk_case(client, h, pid)
    ds = (await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "账号", "columns": ["u"], "rows": [["a"], ["b"]]},
        headers=h)).json()
    assert (await client.patch("/api/v1/api-cases/" + case["id"], json={
        "project_id": pid, "dataset_id": ds["id"], "dataset_set": True}, headers=h)).status_code == 200
    await _mk_scene(client, h, pid, case["id"])

    lst = (await client.get("/api/v1/datasets", params={"project_id": pid}, headers=h)).json()["items"]
    assert lst[0]["used_by"] == 1, "徽标仍是用例口径（场景不直接绑数据集，见计划 RF9 勘误）"
    r = await client.post("/api/v1/datasets/" + ds["id"] + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 409, r.text
    assert r.json()["code"] == "conflict", r.json()
    assert "场景" in r.json()["message"], "提示漏了「那些用例还被场景引用」这半个原因"


async def test_dataset_delete_blocked_by_recycled_case_still_referenced(client, make_user) -> None:
    """真漏洞：used_by 只数未回收用例，所以「回收站里的用例绑着它、而该用例被场景引用」
    时数据集能删掉。之后用例一旦被恢复，api_case_resolve 会 404「数据集不存在」——
    那正是 resolve 里注释说的「走到这里说明数据被外力破坏」。这条必须拦。"""
    _, h, pid = await _setup(client, make_user, "E2")
    _, case = await _mk_case(client, h, pid, name="回收后仍被引用")
    ds = (await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "回收绑集", "columns": ["u"], "rows": [["a"]]}, headers=h)).json()
    assert (await client.patch("/api/v1/api-cases/" + case["id"], json={
        "project_id": pid, "dataset_id": ds["id"], "dataset_set": True}, headers=h)).status_code == 200
    await _mk_scene(client, h, pid, case["id"], name="引用回收用例")
    assert (await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                              json={"project_id": pid, "force": True}, headers=h)).status_code == 200
    # used_by 现在数不到它（口径是未回收用例）——正因如此才需要第二道
    lst = (await client.get("/api/v1/datasets", params={"project_id": pid}, headers=h)).json()["items"]
    assert lst[0]["used_by"] == 0
    r = await client.post("/api/v1/datasets/" + ds["id"] + "/delete",
                          json={"project_id": pid}, headers=h)
    assert r.status_code == 409, r.text
    assert r.json()["code"] == "referenced_by_scenario", r.json()
    assert r.json()["details"]["scenarios"][0]["step_keys"] == ["a.login"]


async def test_blocked_dataset_message_admits_it_lists_only_a_prefix(client, make_user) -> None:
    """count 是全量、括号只点名前 5 个（case_services.py 的 [:5]）：6 个引用时必须带
    「等 6 个场景」尾巴——否则文案把 5 个名字包装成全部名单，用户照单解绑还剩 1 个撞 409。
    尾巴口径与同文件 _blocked（case_services.py:123）一致，同域 notify/dataset 前几轮已统一。
    scenario_case_refs 不设明细上限（scenario/services.py:493，count=len(items)），
    所以这里走真实 6 场景链路，count=6 与 5 个点名同时成立、无人为拼缝。
    """
    _, h, pid = await _setup(client, make_user, "E3")
    _, case = await _mk_case(client, h, pid, name="回收后绑集")
    ds = (await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "六个场景", "columns": ["u"], "rows": [["a"]]}, headers=h)).json()
    assert (await client.patch("/api/v1/api-cases/" + case["id"], json={
        "project_id": pid, "dataset_id": ds["id"], "dataset_set": True}, headers=h)).status_code == 200
    for i in range(6):
        await _mk_scene(client, h, pid, case["id"], name="扣住场景" + str(i))
    assert (await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                              json={"project_id": pid, "force": True}, headers=h)).status_code == 200

    r = await client.post("/api/v1/datasets/" + ds["id"] + "/delete", json={"project_id": pid}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "referenced_by_scenario", r.text
    body = r.json()
    assert body["details"]["count"] == 6
    msg = body["message"]
    assert "等 6 个场景" in msg, "只列 5 个名字却不承认是前缀 = 把 5 当 6 报给用户"
    assert msg.count("「") == 5, "点名只许 5 个（[:5] 上限），剩下的名额由尾巴交代"
    assert "等 6 个场景）" in msg, "尾巴要在括号内贴着名单，别落到括号外变成另一句话"


async def test_blocked_dataset_message_has_no_tail_within_five(client, make_user) -> None:
    """≤5 个引用时名单本来就是全量——「等 N 个场景」是句假话，不许出现。

    这条与上一条对钉尾巴的边界（count > 5）：只删 more 会让上一条红，只把边界改成
    count > 4 会让这一条红（4 个名字后凭空多出「等 5 个场景」）。
    """
    _, h, pid = await _setup(client, make_user, "E4")
    _, case = await _mk_case(client, h, pid, name="回收绑集小")
    ds = (await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "五个场景", "columns": ["u"], "rows": [["a"]]}, headers=h)).json()
    assert (await client.patch("/api/v1/api-cases/" + case["id"], json={
        "project_id": pid, "dataset_id": ds["id"], "dataset_set": True}, headers=h)).status_code == 200
    for i in range(5):
        await _mk_scene(client, h, pid, case["id"], name="引用场景" + str(i))
    assert (await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                              json={"project_id": pid, "force": True}, headers=h)).status_code == 200
    r = await client.post("/api/v1/datasets/" + ds["id"] + "/delete", json={"project_id": pid}, headers=h)
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["details"]["count"] == 5
    msg = body["message"]
    assert "等 5 个场景" not in msg, "全量名单不需要尾巴，硬加就是谎报还有没列出的场景"
    assert msg.count("「") == 5


# ---------- 权限：无 scenario:read 的人照拦，但说不清明细 ----------

async def test_delete_blocked_without_scenario_read(client, make_user) -> None:
    """role_template 可自定义，所以「删除者有没有 scenario:read」是真会分叉的配置。

    拦不拦由**数据**决定，不由查看引用所需的权限决定；没有权限时报「被 N 个场景引用
    （明细需 scenario:read）」而不是「没人引用」。
    """
    from app.core.db import get_sessionmaker
    from app.modules.iam.models import RoleTemplate

    boss, h, pid = await _setup(client, make_user, "F")
    outsider, ho = await make_user("rf9outsider")
    # 自定义角色：能读写用例，但没有任何 scenario:* —— 内置角色做不到，必须造 role_template
    async with get_sessionmaker()() as s:
        s.add(RoleTemplate(code="CASE_ONLY", name="只碰用例", builtin=False,
                           perms=["api:*", "project:read"]))
        await s.commit()
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + outsider.id,
                             json={"role_code": "CASE_ONLY"}, headers=h)).status_code == 200, "先要成为成员"

    _, case = await _mk_case(client, h, pid)
    scene = await _mk_scene(client, h, pid, case["id"])
    assert scene["id"]

    r = await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                          json={"project_id": pid}, headers=ho)
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["code"] == "referenced_by_scenario", body
    assert body["details"]["count"] == 1
    assert body["details"]["scenarios"] == [], "无 scenario:read 时明细必须为空，不能泄露场景名"
    assert "scenario:read" in body["message"]


async def test_scenario_case_refs_is_internal_only(client, make_user) -> None:
    """引擎/删除保护用的内部件不得进模型视野（与 env_resolve / api_case_resolve 同族）。"""
    from app.core.registry import REGISTRY

    _, h, pid = await _setup(client, make_user, "G")
    _, case = await _mk_case(client, h, pid)
    await _mk_scene(client, h, pid, case["id"])
    spec = REGISTRY.get("scenario_case_refs")
    assert spec is not None, "内部引用查询必须注册"
    assert spec.tool is False, "内部件对模型不可见（§9.2 裁量 10）"
    assert spec.http is None, "不暴露 HTTP 路由：跨模块只经注册表调用"
    assert pid  # 夹具真建了数据


async def test_reference_walk_covers_nested_containers(client, make_user) -> None:
    """引用藏在 loop > if 分支里也必须算引用：否则删掉用例后画布第 6 步才炸。"""
    _, h, pid = await _setup(client, make_user, "H")
    _, case = await _mk_case(client, h, pid)
    graph = {"version": 1, "nodes": [{
        "key": "loop1", "kind": "loop",
        "config": {"mode": "count", "max_iter": 3},
        "children": [{
            "key": "loop1.if1", "kind": "if",
            "config": {"branches": [
                {"cond": "ctx.vars.get('ok') == '1'", "children": [
                    {"key": "loop1.if1.hit", "kind": "api_case", "ref": case["id"]},
                ]},
                {"cond": "else", "children": []},
            ]},
        }],
    }]}
    r = await client.post("/api/v1/scenarios", json={
        "project_id": pid, "name": "嵌套引用", "step_graph": graph}, headers=h)
    assert r.status_code == 201, r.text
    del2 = await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                             json={"project_id": pid}, headers=h)
    assert del2.status_code == 409, del2.text
    assert del2.json()["details"]["scenarios"][0]["step_keys"] == ["loop1.if1.hit"]

async def test_dataset_list_admits_it_is_scenario_held(client, make_user) -> None:
    """Review Focus 9 点名的矛盾：徽标说 0 引用、删除却 409。

    我加的第二道拦截让徽标**必然**会说谎（used_by 只数未回收用例），所以列表必须
    自己承认「被场景扣住了」——否则用户照着徽标去删，只在 409 上白撞一下。
    used_by 的语义不许改（test_dataset.py 与 e2e 钉的是「未回收用例数」；把两个数
    糊成一个，谁也读不懂）。scenario_held 的定义就取「删除会不会被场景这道拦下」，
    使徽标与 409 由构造保证一致，而不是靠两处各自记得同步。
    """
    _, h, pid = await _setup(client, make_user, "I")
    _, case = await _mk_case(client, h, pid, name="徽标会说谎")
    ds = (await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "徽标集", "columns": ["u"], "rows": [["a"]]}, headers=h)).json()
    assert (await client.patch("/api/v1/api-cases/" + case["id"], json={
        "project_id": pid, "dataset_id": ds["id"], "dataset_set": True}, headers=h)).status_code == 200
    scene = await _mk_scene(client, h, pid, case["id"], name="扣住数据集")

    async def row():
        return (await client.get("/api/v1/datasets", params={"project_id": pid},
                                 headers=h)).json()["items"][0]

    # ① 用例活着：used_by=1 说话，但徽标也得说「光回收用例不够，还被场景扣着」——
    #    这正是第一道 409 提示里补的那半句话，列表里同样得看得见。
    r0 = await row()
    assert r0["used_by"] == 1 and r0["scenario_held"] is True, r0

    # ② 用例回收：徽标归零，第二道还拦着 → 这条就是徽标说谎的确切时刻
    assert (await client.post("/api/v1/api-cases/" + case["id"] + "/delete",
                              json={"project_id": pid, "force": True}, headers=h)).status_code == 200
    r1 = await row()
    assert r1["used_by"] == 0, "used_by 口径不许被我改坏"
    assert r1["scenario_held"] is True, "徽标显示 0 的同时必须承认被场景扣住"
    assert (await client.post("/api/v1/datasets/" + ds["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 409

    # ③ 场景回收 → 扣住解除、删除放行；徽标若继续亮着就是另一种说谎
    assert (await client.post("/api/v1/scenarios/" + scene["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    r2 = await row()
    assert r2["scenario_held"] is False, "引用已消失还亮着警示 = 制造查无此症的顾虑"
    assert (await client.post("/api/v1/datasets/" + ds["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200


async def test_dataset_list_does_not_overflag_scenario_held(client, make_user) -> None:
    """反向一致：没有场景引用时不得亮灯，否则警示很快就没人信了。

    钉三种「都不该亮」的形态：没绑用例、绑了活用例但没场景、绑的用例已解绑。
    """
    _, h, pid = await _setup(client, make_user, "J")
    _, case = await _mk_case(client, h, pid, name="无主用例")
    await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "没人用", "columns": ["u"], "rows": [["a"]]}, headers=h)
    bound = (await client.post("/api/v1/datasets", json={
        "project_id": pid, "name": "用例在用", "columns": ["u"], "rows": [["b"]]}, headers=h)).json()
    assert (await client.patch("/api/v1/api-cases/" + case["id"], json={
        "project_id": pid, "dataset_id": bound["id"], "dataset_set": True}, headers=h)).status_code == 200

    rows = {d["name"]: d for d in (await client.get("/api/v1/datasets", params={
        "project_id": pid}, headers=h)).json()["items"]}
    assert rows["没人用"]["used_by"] == 0 and rows["没人用"]["scenario_held"] is False
    assert rows["用例在用"]["used_by"] == 1 and rows["用例在用"]["scenario_held"] is False

    # 解绑后连 used_by 一起归零，警示不能残留
    assert (await client.patch("/api/v1/api-cases/" + case["id"], json={
        "project_id": pid, "dataset_id": None, "dataset_set": True}, headers=h)).status_code == 200
    rows2 = {d["name"]: d for d in (await client.get("/api/v1/datasets", params={
        "project_id": pid}, headers=h)).json()["items"]}
    assert rows2["用例在用"]["used_by"] == 0 and rows2["用例在用"]["scenario_held"] is False
