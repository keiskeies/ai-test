"""D37 §11.4.21 自定义角色服务面自证（1G 批次）。

六条钉各有意图（计划点名的判据）：
① 从模板复制出来的角色 perms == 模板快照——「复制」不许是复制了个名字；
② 改/删内置角色 → 4xx 且原因可读（builtin 语义：静默忽略就是假门）；
③ 自定义角色挂到成员后 **端到端读一次真实接口**（GET /projects/{pid} 的 my_perms），
   不是只测写进去——写进表但解析链不回读 = 界面上永远不生效的死人角色；
④ 删被引用的角色 → 409 且计数对（notify in_use 形状，计数全量）；
⑤ role_perm_tree 返回的位集合 == REGISTRY.perm_points()——**防硬编码的命门**：
   哪天有人把树改成常量清单，注册表新增位就会让这条红；
⑥ READONLY 调 create → 403，调 tree → 200（`:read` 后缀 glob 尺的回归钉）。

另钉迁移事实：0022 接棒链头 + custom_role 真在库里（模型声明 ≠ 库里有）。
"""
from __future__ import annotations


async def _boss_project(client, make_user, tag: str):
    boss, h = await make_user("d37boss" + tag)
    r = await client.post("/api/v1/projects", json={"name": "d37proj" + tag}, headers=h)
    assert r.status_code == 201, r.text
    return boss, h, r.json()["id"]


async def _templates(client, h) -> dict[str, dict]:
    r = await client.get("/api/v1/role-templates", headers=h)
    assert r.status_code == 200, r.text
    return {t["code"]: t for t in r.json()["items"]}


# —— ① 模板快照 ——
async def test_role_create_snapshots_template_perms(client, make_user) -> None:
    _, h, pid = await _boss_project(client, make_user, "A")
    tpls = await _templates(client, h)
    r = await client.post("/api/v1/custom-roles",
                          json={"project_id": pid, "name": "裁剪一号", "template_code": "MEMBER"}, headers=h)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["perms"] == tpls["MEMBER"]["perms"], "复制 = 模板位的逐字快照"
    assert body["template_code"] == "MEMBER" and body["code"] and body["project_id"] == pid
    # 带裁剪创建：传了 perms 就用裁剪后的完整位集（计划假设 4 的「任意裁剪 + 任意勾选」）
    r2 = await client.post("/api/v1/custom-roles",
                           json={"project_id": pid, "name": "裁剪二号", "template_code": "MEMBER",
                                 "perms": ["api:case:read", "env:config:read"]}, headers=h)
    assert r2.status_code == 201, r2.text
    assert r2.json()["perms"] == ["api:case:read", "env:config:read"]
    # 项目内重名 409
    r3 = await client.post("/api/v1/custom-roles",
                           json={"project_id": pid, "name": "裁剪一号", "template_code": "READONLY"}, headers=h)
    assert r3.status_code == 409 and r3.json()["code"] == "conflict"
    # 不存在的模板 404（模板 = 内置四枚，不是任意字符串）
    r4 = await client.post("/api/v1/custom-roles",
                           json={"project_id": pid, "name": "无源之水", "template_code": "NOPE"}, headers=h)
    assert r4.status_code == 404, r4.text
    # 空位集 422：一个位都没有的角色没有意义
    r5 = await client.post("/api/v1/custom-roles",
                           json={"project_id": pid, "name": "空壳", "template_code": "MEMBER", "perms": []},
                           headers=h)
    assert r5.status_code == 422 and r5.json()["code"] == "validation_failed"
    # 列表能看见两条（内置不在列表里）
    lst = await client.get("/api/v1/custom-roles", params={"project_id": pid}, headers=h)
    assert lst.status_code == 200, lst.text
    names = {x["name"] for x in lst.json()["items"]}
    assert {"裁剪一号", "裁剪二号"} <= names
    assert not {"SYSTEM_ADMIN", "PROJECT_ADMIN", "MEMBER", "READONLY"} & names


# —— ② 内置不可改不可删 ——
async def test_builtin_roles_are_immutable(client, make_user) -> None:
    _, h, pid = await _boss_project(client, make_user, "B")
    for code in ("SYSTEM_ADMIN", "PROJECT_ADMIN", "MEMBER", "READONLY"):
        r = await client.patch("/api/v1/custom-roles/" + code,
                               json={"project_id": pid, "perms": ["*:read"]}, headers=h)
        assert r.status_code == 403, f"改内置 {code} 应 403，实得 {r.status_code}：{r.text}"
        assert "内置" in r.json()["message"], "原因必须说人话：内置不可改"
        r2 = await client.post("/api/v1/custom-roles/" + code + "/delete",
                               json={"project_id": pid}, headers=h)
        assert r2.status_code == 403, f"删内置 {code} 应 403，实得 {r2.status_code}：{r2.text}"
        assert "内置" in r2.json()["message"]
    # 内置 code 也不许被自定义角色占用（create 撞内置名 → 409 带 code）
    r3 = await client.post("/api/v1/custom-roles",
                           json={"project_id": pid, "name": "撞名", "template_code": "READONLY",
                                 "code": "MEMBER"}, headers=h)
    assert r3.status_code == 409 and r3.json()["code"] == "conflict"


# —— ③ 端到端：挂上自定义角色的成员，my_perms 真的变成该角色的位 ——
async def test_member_with_custom_role_gets_its_perms(client, make_user) -> None:
    _, h, pid = await _boss_project(client, make_user, "C")
    r = await client.post("/api/v1/custom-roles",
                          json={"project_id": pid, "name": "只读环境", "template_code": "READONLY",
                                "perms": ["env:config:read", "api:case:read"]}, headers=h)
    assert r.status_code == 201, r.text
    code = r.json()["code"]
    u, hu = await make_user("d37custom_member")
    rm = await client.put(f"/api/v1/projects/{pid}/members/{u.id}",
                          json={"role_code": code}, headers=h)
    assert rm.status_code == 200, rm.text
    # 真实接口读回来：my_perms 就是该自定义角色的位（+ 项目作用域硬拒绝 -system:*）
    proj = await client.get(f"/api/v1/projects/{pid}", headers=hu)
    assert proj.status_code == 200, proj.text
    assert sorted(proj.json()["my_perms"]) == sorted(["env:config:read", "api:case:read", "-system:*"])
    # 项目列表（另一条解析出口 _patterns_map）也必须给同一份位
    lst = await client.get("/api/v1/projects", headers=hu)
    row = next(x for x in lst.json()["items"] if x["id"] == pid)
    assert sorted(row["my_perms"]) == sorted(["env:config:read", "api:case:read", "-system:*"])
    # 位真的生效：该成员可读环境、不可建环境
    ok = await client.get("/api/v1/envs", params={"project_id": pid}, headers=hu)
    assert ok.status_code == 200, ok.text
    no = await client.post("/api/v1/envs", json={"project_id": pid, "name": "越权环境"}, headers=hu)
    assert no.status_code == 403 and no.json()["code"] == "insufficient_permission"
    # 改位 → 成员权限实时跟着变（role_update 同一条解析链）：撤掉的位立刻失效
    rp = await client.patch("/api/v1/custom-roles/" + code,
                            json={"project_id": pid, "perms": ["env:config:read"]}, headers=h)
    assert rp.status_code == 200, rp.text
    assert rp.json()["perms"] == ["env:config:read"]
    gone = await client.get("/api/v1/api-cases", params={"project_id": pid}, headers=hu)
    assert gone.status_code == 403 and gone.json()["code"] == "insufficient_permission"
    still = await client.get("/api/v1/envs", params={"project_id": pid}, headers=hu)
    assert still.status_code == 200, still.text


async def test_updated_perms_take_effect_immediately(client, make_user) -> None:
    """③ 的第二拍：位集改窄后，被撤的位对应接口立刻 403（实时生效，不靠重登录）。"""
    _, h, pid = await _boss_project(client, make_user, "C2")
    r = await client.post("/api/v1/custom-roles",
                          json={"project_id": pid, "name": "两读", "template_code": "READONLY",
                                "perms": ["env:config:read", "api:case:read"]}, headers=h)
    code = r.json()["code"]
    u, hu = await make_user("d37c2_member")
    await client.put(f"/api/v1/projects/{pid}/members/{u.id}", json={"role_code": code}, headers=h)
    assert (await client.get("/api/v1/api-cases", params={"project_id": pid}, headers=hu)).status_code == 200
    rp = await client.patch("/api/v1/custom-roles/" + code,
                            json={"project_id": pid, "perms": ["env:config:read"]}, headers=h)
    assert rp.status_code == 200, rp.text
    gone = await client.get("/api/v1/api-cases", params={"project_id": pid}, headers=hu)
    assert gone.status_code == 403 and gone.json()["code"] == "insufficient_permission"
    still = await client.get("/api/v1/envs", params={"project_id": pid}, headers=hu)
    assert still.status_code == 200, still.text


# —— ④ 被引用删除 → 409 计数对 ——
async def test_delete_referenced_role_409_with_count(client, make_user) -> None:
    _, h, pid = await _boss_project(client, make_user, "D")
    r = await client.post("/api/v1/custom-roles",
                          json={"project_id": pid, "name": "占位角色", "template_code": "READONLY"}, headers=h)
    code = r.json()["code"]
    for i in range(2):
        u, _ = await make_user(f"d37victim{i}")
        assert (await client.put(f"/api/v1/projects/{pid}/members/{u.id}",
                                 json={"role_code": code}, headers=h)).status_code == 200
    d = await client.post("/api/v1/custom-roles/" + code + "/delete", json={"project_id": pid}, headers=h)
    assert d.status_code == 409, d.text
    body = d.json()
    assert body["code"] == "in_use"
    assert body["details"]["count"] == 2, "计数必须全量（明细有上限，计数没有）"
    assert len(body["details"]["members"]) == 2
    # ≤REF_DETAIL_CAP 时明细就是全量——truncated 标志不许恒真（恒真等于没有信息）
    assert body["details"]["details_truncated"] is False
    # 解绑后可删
    u2 = await client.get(f"/api/v1/projects/{pid}/members", headers=h)
    for m in u2.json()["items"]:
        if m["role_code"] == code:
            assert (await client.delete(f"/api/v1/projects/{pid}/members/{m['user_id']}",
                                        headers=h)).status_code == 200
    d2 = await client.post("/api/v1/custom-roles/" + code + "/delete", json={"project_id": pid}, headers=h)
    assert d2.status_code == 200, d2.text
    # 删后再删：code 已不存在 → D148 与跨项目同码同体 403（不泄露存在性，test_agent_api.py:100 同款纪律）
    d3 = await client.post("/api/v1/custom-roles/" + code + "/delete", json={"project_id": pid}, headers=h)
    assert d3.status_code == 403, d3.text
    assert d3.json() == {"code": "forbidden", "message": "无此项目权限", "details": {}}


async def test_delete_role_409_admits_member_list_truncation(client, make_user) -> None:
    """count 全量、明细被 REF_DETAIL_CAP（role_services.py:34）截到 20 条时必须说出口。

    notify/service.py:164 的口径：details_hidden 管「权限拦了明细」，details_truncated
    管「上限截了明细」。25 个成员只给 20 条却不声明截断，前端就把 20 当全量——
    这正是「文案承诺 → 兑现」sweep 要钉的假账。21 是压过上限的最小代价。
    """
    from app.modules.iam.role_services import REF_DETAIL_CAP

    _, h, pid = await _boss_project(client, make_user, "D2")
    r = await client.post("/api/v1/custom-roles",
                          json={"project_id": pid, "name": "二十一个坑", "template_code": "READONLY"}, headers=h)
    code = r.json()["code"]
    for i in range(REF_DETAIL_CAP + 1):
        u, _ = await make_user(f"d37many{i}")
        assert (await client.put(f"/api/v1/projects/{pid}/members/{u.id}",
                                 json={"role_code": code}, headers=h)).status_code == 200
    d = await client.post("/api/v1/custom-roles/" + code + "/delete", json={"project_id": pid}, headers=h)
    assert d.status_code == 409, d.text
    body = d.json()
    assert body["code"] == "in_use"
    assert body["details"]["count"] == REF_DETAIL_CAP + 1, "count 永远是全量 COUNT(*)"
    assert len(body["details"]["members"]) == REF_DETAIL_CAP, "明细被 limit 截在上限"
    assert body["details"]["details_truncated"] is True, "截了明细必须声明，否则 20 条被当前台全量"
    assert body["details"]["details_hidden"] is False, "boss 有 project:member:manage，隐瞒与截断是两回事"


# —— D148：不存在与跨项目必须不可分辨（同码 + 逐字同体） ——
async def test_unknown_role_and_cross_project_role_indistinguishable(client, make_user) -> None:
    """_role 的 not-found 曾是 404、跨项目是 403——注释写着「与不存在同响应体
    （不泄露存在性）」，代码却在用状态码泄露存在性。本钉杀「半修」：
    PATCH/DELETE × 不存在 / 真实但在别的项目，四种请求任意一格的状态码或体
    与其余不同就红；再钉唯一基准 = 403 forbidden「无此项目权限」details 裸——
    只互比不钉基准的话，「两分支一起改成 404」这种同样不可分辨的修法也能全绿。
    与 test_agent_api.py:100（不存在 project_id ⇒ 403 同码同形）、本文件非成员 403 同纪律。
    """
    _, h, pid = await _boss_project(client, make_user, "G")
    _, h_other, other_pid = await _boss_project(client, make_user, "G2")
    r = await client.post("/api/v1/custom-roles",
                          json={"project_id": other_pid, "name": "别家角色", "template_code": "READONLY"},
                          headers=h_other)
    assert r.status_code == 201, r.text
    cross = r.json()["code"]  # 真实存在，但挂在 other_pid 名下

    patch_unknown = await client.patch("/api/v1/custom-roles/no_such_role",
                                       json={"project_id": pid, "name": "碰瓷"}, headers=h)
    patch_cross = await client.patch("/api/v1/custom-roles/" + cross,
                                     json={"project_id": pid, "name": "碰瓷"}, headers=h)
    del_unknown = await client.post("/api/v1/custom-roles/no_such_role/delete",
                                    json={"project_id": pid}, headers=h)
    del_cross = await client.post("/api/v1/custom-roles/" + cross + "/delete",
                                  json={"project_id": pid}, headers=h)
    for other in (patch_cross, del_unknown, del_cross):
        assert (patch_unknown.status_code, patch_unknown.json()) == (other.status_code, other.json()), \
            "不存在与跨项目必须状态码 + 体逐字相等，否则存在性就从状态码/体里漏出去了"
    assert patch_unknown.status_code == 403
    assert patch_unknown.json() == {"code": "forbidden", "message": "无此项目权限", "details": {}}


# —— ⑤ 树 == REGISTRY.perm_points()（防硬编码命门） ——
async def test_perm_tree_is_registry_projection(client, make_user) -> None:
    from app.core.registry import REGISTRY

    _, h, pid = await _boss_project(client, make_user, "E")
    r = await client.get("/api/v1/role-perm-tree", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    leaves: set[str] = set()
    fams: set[str] = set()
    for node in body["nodes"]:
        fams.add(node["key"])
        assert node["key"] == node["children"][0]["key"].split(":")[0], "一级 = 权限位前缀族"
        for c in node["children"]:
            leaves.add(c["key"])
    points = REGISTRY.perm_points()
    assert leaves == points, "树的叶子集合必须与注册表逐字相等——不等就是有人硬编码了树"
    assert fams == {p.split(":")[0] for p in points}
    # 内置模板随树回显（前端不许猜内置位）
    assert {t["code"] for t in body["templates"]} == {"SYSTEM_ADMIN", "PROJECT_ADMIN", "MEMBER", "READONLY"}


# —— ⑥ READONLY：create 403 / tree 200（glob 尺回归） ——
async def test_readonly_can_read_tree_but_not_write(client, make_user) -> None:
    _, h, pid = await _boss_project(client, make_user, "F")
    ro, hro = await make_user("d37ro")
    assert (await client.put(f"/api/v1/projects/{pid}/members/{ro.id}",
                             json={"role_code": "READONLY"}, headers=h)).status_code == 200
    c = await client.post("/api/v1/custom-roles",
                          json={"project_id": pid, "name": "越权角色", "template_code": "READONLY"}, headers=hro)
    assert c.status_code == 403 and c.json()["code"] == "insufficient_permission"
    t = await client.get("/api/v1/role-perm-tree", params={"project_id": pid}, headers=hro)
    assert t.status_code == 200, t.text
    lst2 = await client.get("/api/v1/custom-roles", params={"project_id": pid}, headers=hro)
    assert lst2.status_code == 200, lst2.text
    # MEMBER（-*:delete）：可读可建，不可删
    me, hme = await make_user("d37me")
    assert (await client.put(f"/api/v1/projects/{pid}/members/{me.id}",
                             json={"role_code": "MEMBER"}, headers=h)).status_code == 200
    assert (await client.get("/api/v1/custom-roles", params={"project_id": pid}, headers=hme)).status_code == 200
    cr = await client.post("/api/v1/custom-roles",
                           json={"project_id": pid, "name": "成员建一个", "template_code": "READONLY"}, headers=hme)
    assert cr.status_code == 201, cr.text
    dr = await client.post("/api/v1/custom-roles/" + cr.json()["code"] + "/delete",
                           json={"project_id": pid}, headers=hme)
    assert dr.status_code == 403, dr.text
    # 非成员连树都看不到（数据权限门 403 forbidden，与不存在同码）
    out, hout = await make_user("d37outsider")
    t2 = await client.get("/api/v1/role-perm-tree", params={"project_id": pid}, headers=hout)
    assert t2.status_code == 403 and t2.json()["code"] == "forbidden"


# —— 迁移事实：0022 接棒链头 + 表真在库里 ——
async def test_migration_0022_and_table_exists(conn) -> None:
    import pathlib
    import re

    versions = pathlib.Path(__file__).resolve().parents[1] / "migrations" / "versions"
    parents, revs = {}, {}
    for f in sorted(p for p in versions.glob("*.py") if p.name != "__init__.py"):
        src = f.read_text(encoding="utf-8")
        m = re.search(r'^revision\b[^=]*=\s*["\']([^"\']+)', src, re.M)
        d = re.search(r'^down_revision\b[^=]*=\s*(?:["\']([^"\']+)["\']|(None))', src, re.M)
        assert m and d, f"{f.name} 缺 revision/down_revision"
        revs[m.group(1)] = f.name
        parents[m.group(1)] = d.group(1) if d.group(1) else None
    assert parents["0022"] == "0021"
    # 0023（D47-a saved_view）接棒链头：链头唯一性这条判定的期望值随链头走（test_ui_models 先例），
    # 判定逻辑不动——本条测的还是 0022 与 custom_role 表，只是顺带钉住「现在只有一条链」。
    assert parents["0023"] == "0022"
    # 0024（D183 plan_record）接棒链头：同款先例，改期望值不改判定逻辑
    assert parents["0024"] == "0023"
    # 0025（D183 plan_case_link）接棒链头：同款先例，改期望值不改判定逻辑
    assert parents["0025"] == "0024"
    # 0026（D183 plan_report 两表）接棒链头：同款先例，改期望值不改判定逻辑
    assert parents["0026"] == "0025"
    # 0027（D187 defect 两表）接棒链头：同款先例，改期望值不改判定逻辑
    assert parents["0027"] == "0026"
    heads = set(revs) - (set(parents.values()) - {None})
    assert heads == {"0027"}, f"链头应唯一 0027：{sorted(heads)}"

    def _read(sync_conn) -> dict:
        from sqlalchemy import inspect

        insp = inspect(sync_conn)
        return {"tables": set(insp.get_table_names()),
                "cols": {c["name"] for c in insp.get_columns("custom_role")},
                "uq": {c["name"] for c in insp.get_unique_constraints("custom_role")}}

    got = await conn.run_sync(_read)
    assert "custom_role" in got["tables"], "库里没有 custom_role（alembic 没升到 0022？）"
    assert {"code", "project_id", "name", "perms", "template_code"} <= got["cols"]
    assert "uq_custom_role_project_name" in got["uq"]
