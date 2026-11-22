"""1C T5 元素库服务面（§11.4.11 / §11.5.4 / R106）。

这个文件里最值钱的三条不是 CRUD，是：
- `used_by` 与删除拦截**同源**：徽标说 0 而删除弹 409 是 §11.5.4 能造成的最坏误导；
- **回收的用例不算引用**（③）：否则「先把用例扔了再删元素」永远做不到；
- **明细可见性 ≠ 保护生效**：没有 ui:case:read 的人照样删不掉，只是说不出被谁引用。
"""
from __future__ import annotations

from typing import Any

from httpx import AsyncClient


async def _setup(client: AsyncClient, make_user, tag: str):
    boss, hb = await make_user("uieboss" + tag)
    pid = (await client.post("/api/v1/projects", json={"name": "uie" + tag}, headers=hb)).json()["id"]
    return boss, hb, pid


async def _el(client: AsyncClient, h, pid, name, *, t="css", loc="#submit", **kw) -> dict[str, Any]:
    body: dict[str, Any] = {"project_id": pid, "name": name, "locator_type": t, "locator": loc, **kw}
    r = await client.post("/api/v1/ui-elements", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _uicase(client: AsyncClient, h, pid, name, steps) -> dict[str, Any]:
    r = await client.post("/api/v1/ui-cases", json={"project_id": pid, "name": name, "steps": steps}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


def _steps(eid: str) -> list[dict[str, Any]]:
    """一条合法用例的最小命令序列（§7.2）：打开 → 用元素点一下。"""
    return [{"id": "open1", "type": "open", "input": "/ui/login"},
            {"id": "clk1", "type": "click", "element_id": eid}]


async def _list(client: AsyncClient, h, pid, **params):
    r = await client.get("/api/v1/ui-elements", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def test_element_crud_and_list_carries_used_by(client: AsyncClient, make_user) -> None:
    """① 建/查/改/回收/恢复五步，列表每行带 used_by。"""
    _, h, pid = await _setup(client, make_user, "A")
    e = await _el(client, h, pid, "登录按钮", t="css", loc="#submit", comment="登录页主按钮")
    assert e["used_by"] == 0 and e["status"] == "normal" and e["locator_type"] == "css"
    # 表达式与备注原样往返（§11.5.4 的「表达式」列直接读 locator）
    assert e["locator"] == "#submit" and e["comment"] == "登录页主按钮"

    g = await client.get("/api/v1/ui-elements/" + e["id"], params={"project_id": pid}, headers=h)
    assert g.status_code == 200 and g.json()["name"] == "登录按钮"

    p = await _list(client, h, pid)
    assert [i["name"] for i in p["items"]] == ["登录按钮"]
    assert p["items"][0]["used_by"] == 0

    r = await client.patch("/api/v1/ui-elements/" + e["id"],
                           json={"project_id": pid, "comment": "改过的备注"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["comment"] == "改过的备注"
    # owner_id 由服务端写（不是前端传）：可见性靠它，交给调用方等于自己声明自己拥有
    assert r.json()["owner_id"] and r.json()["updated_by"]

    d = await client.post("/api/v1/ui-elements/" + e["id"] + "/delete", json={"project_id": pid}, headers=h)
    assert d.status_code == 200, d.text
    assert (await _list(client, h, pid))["items"] == []
    # 回收站视图看得见，正常详情 404（与不存在同码，不泄露存在性）
    assert [i["name"] for i in (await _list(client, h, pid, recycled=True))["items"]] == ["登录按钮"]
    assert (await client.get("/api/v1/ui-elements/" + e["id"], params={"project_id": pid},
                             headers=h)).status_code == 404
    back = await client.post("/api/v1/ui-elements/" + e["id"] + "/restore", json={"project_id": pid}, headers=h)
    assert back.status_code == 200 and back.json()["status"] == "normal"


async def test_recycled_list_shows_deleter_name(client: AsyncClient, make_user) -> None:
    """§11.4.18 回收站「删除人」：updated_by 是回收那次写的人，updated_by_name 是人名不是 id。

    三个钉点，缺一不可：
    ① 回收落 updated_by——不写的话列上挂着的是上一个编辑人（这里让 B 建、B 改、A 删，
      少写一步 A 列就变 B，「删除人」成了「最后编辑人」的冒名顶替）；
    ② updated_by_name 走 app_user 表名 join 解析成人名（前端直接摊这一格）；
    ③ 时间只断「带 +00:00 的 ISO 串」（前端 fmtTime 的入参口径）——DATETIME 同秒会飘，
      钉精确值或与 created_at 比大小都是赌运气，这里不赌。
    """
    boss, hb, pid = await _setup(client, make_user, "RB")
    editor, he = await make_user("uiedeitor" + pid[:6], name="王小明")
    assert (await client.put(f"/api/v1/projects/{pid}/members/{editor.id}",
                             json={"role_code": "PROJECT_ADMIN"}, headers=hb)).status_code == 200
    e = await _el(client, he, pid, "订单查询旧版")
    # B 先改一笔（updated_by=B）——回收若不落库，回收站列会读出 B，而按钮的是 A
    patched = await client.patch("/api/v1/ui-elements/" + e["id"],
                                 json={"project_id": pid, "comment": "编辑人留的痕"}, headers=he)
    assert patched.status_code == 200 and patched.json()["updated_by"] == editor.id
    assert patched.json()["updated_by_name"] is None, "单行出口不回填人名（列表侧才补名字）"

    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/delete",
                              json={"project_id": pid}, headers=hb)).status_code == 200

    row = (await _list(client, hb, pid, recycled=True))["items"][0]
    assert row["updated_by"] == boss.id, "回收那次写操作才是删除人，不能停在编辑人身上"
    assert row["updated_by_name"] == boss.name, "删除人列必须是人名（前端直接摊这一格）"
    assert row["updated_by_name"] != boss.id, "拿 id 冒充人名就是这条断言要拦的"
    assert row["updated_at"] and row["updated_at"].endswith("+00:00"), \
        "删除时间给的是带偏移的 ISO 串（前端 fmtTime 换算；同秒会飘，所以不钉精确值也不比 created_at）"


async def test_recycled_name_lookup_misses_quietly_to_none(client: AsyncClient, make_user, session) -> None:
    """删除人查不到人（app_user 行没了/id 悬空）→ updated_by_name=None，不是 id、不是空串。

    「查不到」是真实状态（用户被物理删过），列必须落「—」而不是把 uuid 摊给用户看。
    经 HTTP 没有悬空路（purge 删的是元素不是人），所以回收之后直接改库造这个状态。
    """
    from sqlalchemy import text

    boss, hb, pid = await _setup(client, make_user, "RC")
    e = await _el(client, hb, pid, "删除人会消失的元素")
    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/delete",
                              json={"project_id": pid}, headers=hb)).status_code == 200
    await session.execute(text("UPDATE ui_element SET updated_by = 'ghost-user-id' WHERE id = :i"),
                          {"i": e["id"]})
    await session.commit()
    # expire_all 不是仪式：夹具的 AsyncSession 是 expire_on_commit=False，实例还躺在
    # identity map 里，不 expire 的话列表查询拿到的是缓存的旧 updated_by，这条测试会
    # 「绿着测错东西」（测成 boss 的名字而不是查不到）。
    session.expire_all()
    row = (await _list(client, hb, pid, recycled=True))["items"][0]
    assert row["updated_by"] == "ghost-user-id", "updated_by 本身不许被动过"
    assert row["updated_by_name"] is None, "查不到人 → None（前端画 —），不许回填 id"


async def test_recycled_list_backfill_keeps_other_columns(client: AsyncClient, make_user) -> None:
    """补人名不许动别列：一次回收站分页请求里 used_by/分页/其余字段口径不变。"""
    boss, hb, pid = await _setup(client, make_user, "RD")
    e = await _el(client, hb, pid, "回收后口径不变")
    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/delete",
                              json={"project_id": pid}, headers=hb)).status_code == 200
    rows = (await _list(client, hb, pid, recycled=True, size=1))["items"]
    assert len(rows) == 1 and rows[0]["id"] == e["id"]
    assert rows[0]["updated_by_name"] == boss.name and rows[0]["used_by"] == 0


async def test_used_by_counts_and_delete_is_blocked_by_name(client: AsyncClient, make_user) -> None:
    """② 造一条引用它的用例 → used_by==1 → delete 409 且 details.cases 点名（R106）。"""
    _, h, pid = await _setup(client, make_user, "B")
    e = await _el(client, h, pid, "账号输入框")
    await _uicase(client, h, pid, "登录成功", _steps(e["id"]))

    row = (await _list(client, h, pid))["items"][0]
    assert row["used_by"] == 1, "§11.5.4 的「关联用例数」列就是这一格"

    r = await client.post("/api/v1/ui-elements/" + e["id"] + "/delete", json={"project_id": pid}, headers=h)
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["code"] == "referenced_by_case"
    assert "1" in body["message"], "消息要把引用数说在人话里，别让人去数 details"
    cases = body["details"]["cases"]
    assert [c["name"] for c in cases] == ["登录成功"], "409 必须点名，否则用户无从解引用"
    assert cases[0]["id"]
    assert cases[0]["step_indexes"] == [1], "命中第 2 步（0 基），§11.4.11 弹窗要说在哪一步"
    assert body["details"]["details_hidden"] is False
    # 拦了就得真没删
    assert (await _list(client, h, pid))["items"][0]["used_by"] == 1


async def test_recycled_case_is_not_a_reference(client: AsyncClient, make_user) -> None:
    """③ 用例进回收站后再删元素 → 通过。

    回收站是「已经决定不要了」的暂存区；把它计成引用会让「先扔用例再删元素」变成
    永远做不到的事。
    """
    _, h, pid = await _setup(client, make_user, "C")
    e = await _el(client, h, pid, "订单列表")
    c = await _uicase(client, h, pid, "查订单", _steps(e["id"]))
    assert (await _list(client, h, pid))["items"][0]["used_by"] == 1

    assert (await client.post("/api/v1/ui-cases/" + c["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert (await _list(client, h, pid))["items"][0]["used_by"] == 0, "回收的用例不算引用"
    r = await client.post("/api/v1/ui-elements/" + e["id"] + "/delete", json={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text


async def test_recycled_element_blocks_new_name(client: AsyncClient, make_user) -> None:
    """④ 回收站里的同名元素挡住新建（409，文案给出口）。"""
    _, h, pid = await _setup(client, make_user, "D")
    e = await _el(client, h, pid, "支付按钮")
    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    r = await client.post("/api/v1/ui-elements", json={
        "project_id": pid, "name": "支付按钮", "locator_type": "id", "locator": "pay"}, headers=h)
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["code"] == "conflict" and body["details"]["name_exists"] is True
    # 出口要说出来：光说「已存在」，用户会以为回收站里那条还在正常列表里
    assert "回收站" in body["message"] and ("恢复" in body["message"] or "彻底删除" in body["message"])
    assert body["details"]["recycled"] is True


async def test_purge_needs_exact_name_then_frees_it(client: AsyncClient, make_user) -> None:
    """⑤ purge 未输名 409 name_mismatch；输对则物理删、同名立刻可重建。"""
    _, h, pid = await _setup(client, make_user, "E")
    e = await _el(client, h, pid, "临时元素")
    # 正常态直接 purge → not_recycled：回收站是彻底删除的唯一入口（R53）
    r_pre = await client.post("/api/v1/ui-elements/" + e["id"] + "/purge",
                              json={"project_id": pid, "confirm_name": "临时元素"}, headers=h)
    assert r_pre.status_code == 409 and r_pre.json()["code"] == "not_recycled", r_pre.text
    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    # 输错一个字都不删（差一个字符 = 没确认）
    r1 = await client.post("/api/v1/ui-elements/" + e["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "临时元"}, headers=h)
    assert r1.status_code == 409 and r1.json()["code"] == "name_mismatch", r1.text
    r2 = await client.post("/api/v1/ui-elements/" + e["id"] + "/purge",
                           json={"project_id": pid, "confirm_name": "临时元素"}, headers=h)
    assert r2.status_code == 200, r2.text
    assert (await _list(client, h, pid, recycled=True))["items"] == []
    # 物理删完名字立刻可用（墓碑也没了）
    again = await client.post("/api/v1/ui-elements", json={
        "project_id": pid, "name": "临时元素", "locator_type": "id", "locator": "again"}, headers=h)
    assert again.status_code == 201, again.text


async def test_purge_blocks_referenced_element_even_with_name(client: AsyncClient, make_user) -> None:
    """⑤b 元素 purge **也**硬拦引用——与 scenario_purge 的有意分歧。

    输对名字照样不能删：物理删掉被引用的元素 = 引用它的用例永久损坏（软删还能恢复，
    物理删不行），而作者只会看到执行期一句「元素不存在」。
    """
    _, h, pid = await _setup(client, make_user, "F")
    e = await _el(client, h, pid, "关键元素")
    await _uicase(client, h, pid, "关键流程", _steps(e["id"]))
    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 409, "回收也拦"
    # 绕过回收这一步直接 purge 也不行（而且现在它还在正常态，先撞 not_recycled）
    r = await client.post("/api/v1/ui-elements/" + e["id"] + "/purge",
                          json={"project_id": pid, "confirm_name": "关键元素"}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "not_recycled", r.text
    # 解引用之后才走得通：删掉用例 → 回收元素 → 彻底删除
    cases = (await client.get("/api/v1/ui-cases", params={"project_id": pid}, headers=h)).json()["items"]
    assert (await client.post("/api/v1/ui-cases/" + cases[0]["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/delete",
                              json={"project_id": pid}, headers=h)).status_code == 200
    assert (await client.post("/api/v1/ui-elements/" + e["id"] + "/purge",
                              json={"project_id": pid, "confirm_name": "关键元素"},
                              headers=h)).status_code == 200


async def test_cross_project_element_is_404_not_403(client: AsyncClient, make_user) -> None:
    """⑥ 跨项目 element_id → 404（不泄露存在性；403 等于承认「这东西存在但你没权限」）。"""
    _, h1, pid1 = await _setup(client, make_user, "G")
    _, h2, pid2 = await _setup(client, make_user, "H")
    e = await _el(client, h1, pid1, "只在本项目")
    base = "/api/v1/ui-elements/" + e["id"]

    r_get = await client.get(base, params={"project_id": pid2}, headers=h2)
    r_del = await client.post(base + "/delete", json={"project_id": pid2}, headers=h2)
    r_res = await client.post(base + "/restore", json={"project_id": pid2}, headers=h2)
    r_pur = await client.post(base + "/purge", json={"project_id": pid2, "confirm_name": "只在本项目"},
                              headers=h2)
    r_pat = await client.patch(base, json={"project_id": pid2, "comment": "别人项目的"}, headers=h2)
    for name, r in (("get", r_get), ("delete", r_del), ("restore", r_res),
                    ("purge", r_pur), ("patch", r_pat)):
        assert r.status_code == 404, f"{name} 跨项目应 404，实得 {r.status_code}: {r.text}"
        assert r.json()["code"] == "not_found"
    # B 项目看不见 A 的元素，也数不到它的 used_by
    assert (await _list(client, h2, pid2))["items"] == []


async def test_readonly_member_can_read_but_not_write(client: AsyncClient, make_user) -> None:
    """⑦ READONLY：list/get 200，create/update/delete 403（权限是三层里的第二层）。"""
    _, hb, pid = await _setup(client, make_user, "I")
    ro, hro = await make_user("uiero" + pid[:6])
    assert (await client.put(f"/api/v1/projects/{pid}/members/{ro.id}",
                             json={"role_code": "READONLY"}, headers=hb)).status_code == 200
    e = await _el(client, hb, pid, "老板的元素")
    assert (await client.get("/api/v1/ui-elements", params={"project_id": pid}, headers=hro)).status_code == 200
    assert (await client.get("/api/v1/ui-elements/" + e["id"], params={"project_id": pid},
                             headers=hro)).status_code == 200
    for method, path, body in (
        ("post", "", {"project_id": pid, "name": "x", "locator_type": "css", "locator": "#x"}),
        ("patch", "/" + e["id"], {"project_id": pid, "comment": "改一下"}),
        ("post", "/" + e["id"] + "/delete", {"project_id": pid}),
    ):
        url = "/api/v1/ui-elements" + path
        r = await getattr(client, method)(url, json=body, headers=hro)
        assert r.status_code == 403, f"{method.upper()} {url} 应 403，实得 {r.status_code}: {r.text}"
        assert r.json()["code"] in ("insufficient_permission", "forbidden")


async def test_purge_and_internal_refs_are_not_agent_tools(client: AsyncClient, make_user) -> None:
    """⑧ 工具面：purge 与内部件必须缺席（tool=False 漏进工具面 = 让模型能物理删资产）。"""
    _, h, pid = await _setup(client, make_user, "J")
    r = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    by_name = {t["name"]: t for t in r.json()["items"]}
    for absent in ("ui_element_purge", "ui_case_purge", "ui_module_purge", "ui_element_refs"):
        assert absent not in by_name, absent + " 是 tool=False，出现在工具面就是权限绕过"
    for present in ("ui_element_list", "ui_element_create", "ui_element_update", "ui_element_delete"):
        assert present in by_name, present + " 应该在工具面（业主可从模型侧建元素）"
    # effect 决定 PLAN 模式能不能调（写与破坏性动作在 PLAN 下被拒）
    assert by_name["ui_element_list"]["effect"] == "read"
    assert by_name["ui_element_create"]["effect"] == "write"
    assert by_name["ui_element_delete"]["effect"] == "destructive"


async def test_used_by_and_delete_guard_agree(client: AsyncClient, make_user) -> None:
    """同源钉：used_by>0 ⇔ delete 409，used_by==0 ⇔ delete 200。

    这条是 §11.5.4 那个界面最不能坏的性质：徽标与删除结论分叉，用户就会对着
    一个说「0 条引用」的行按下删除键然后吃一个 409。
    """
    _, h, pid = await _setup(client, make_user, "K")
    a = await _el(client, h, pid, "被用")
    b = await _el(client, h, pid, "没人用")
    await _uicase(client, h, pid, "用到 a 的用例", _steps(a["id"]))
    rows = {i["name"]: i for i in (await _list(client, h, pid))["items"]}
    assert rows["被用"]["used_by"] == 1 and rows["没人用"]["used_by"] == 0
    ra = await client.post("/api/v1/ui-elements/" + a["id"] + "/delete", json={"project_id": pid}, headers=h)
    rb = await client.post("/api/v1/ui-elements/" + b["id"] + "/delete", json={"project_id": pid}, headers=h)
    assert (ra.status_code == 409) == (rows["被用"]["used_by"] > 0)
    assert (rb.status_code == 200) == (rows["没人用"]["used_by"] == 0), rb.text


async def test_locator_change_on_referenced_element_is_blocked(client: AsyncClient, make_user) -> None:
    """R106 点名的第二条路：改 locator_type / locator 也要查引用。

    steps 只存 element_id、**不存定位器副本**（resolve 在执行时才解析），
    所以改定位器 = 静默改写所有引用它的用例的定位目标。
    """
    _, h, pid = await _setup(client, make_user, "L")
    e = await _el(client, h, pid, "被引用的定位器", t="css", loc="#a")
    await _uicase(client, h, pid, "引用方", _steps(e["id"]))
    for patch_body, what in (({"locator_type": "xpath"}, "换类型"), ({"locator": "#b"}, "换表达式")):
        r = await client.patch("/api/v1/ui-elements/" + e["id"],
                               json={"project_id": pid, **patch_body}, headers=h)
        assert r.status_code == 409 and r.json()["code"] == "referenced_by_case", f"{what} 应拦：{r.text}"
    # 备注/改名/可见性不受影响（拦定位器不是拦下一切写）
    ok = await client.patch("/api/v1/ui-elements/" + e["id"],
                            json={"project_id": pid, "comment": "只改备注"}, headers=h)
    assert ok.status_code == 200, ok.text
    assert ok.json()["locator"] == "#a", "被拦的那次改必须一个字都没落库"


async def test_ref_counts_visible_to_every_builtin_role(client: AsyncClient, make_user, session) -> None:
    """内部件 ui_element_refs：批量口径 + 数量永远照报。

    实测事实（写这条之前我以为 READONLY 会走到 details_hidden，测完发现不会）：
    四个内置角色的权限集合是 `*` / `*,-system:*` / `*,-*:delete,-*:manage,-system:*` /
    `*:read`，**每一个都匹配 `ui:case:read`**（`:read` 后缀 glob），而 1C 没有自定义角色
    的写入口。所以「有引用但说不出是谁」这条路今天经 HTTP 走不到——它是给自定义角色
    预留的防御层，与 1B 的 scenario_case_refs 同一处境（那里同样没测到）。
    这条测「能走到的一半」，下一条用权限 resolver 的注入点测「走不到的那一半」。
    """
    from app.core.registry import REGISTRY
    from app.core.service import ServiceCtx

    boss, hb, pid = await _setup(client, make_user, "M")
    e = await _el(client, hb, pid, "内部件查的元素")
    c = await _uicase(client, hb, pid, "内部件的引用方", _steps(e["id"]))

    spec = REGISTRY.get("ui_element_refs")
    assert spec is not None, "内部件没注册（main.py 的 import 漏了？）"
    assert spec.http is None and spec.tool is False, "内部件既不暴露 HTTP 也不进工具面"

    ctx = ServiceCtx(entry="http", user_id=boss.id, user_name=boss.name,
                     is_system_admin=False, db=session)
    # 批量：一次问两个 id（一个真元素、一个不存在）；未命中的不进 groups（不编空组）
    out = await spec.handler(spec.model.model_validate(
        {"project_id": pid, "element_ids": [e["id"], "no-such-element"]}), ctx)
    assert [g.element_id for g in out.groups] == [e["id"]]
    assert out.groups[0].count == 1
    assert [i.case_name for i in out.groups[0].items] == ["内部件的引用方"]
    assert out.groups[0].items[0].step_indexes == [1]
    assert out.details_hidden is False
    assert c["step_count"] == 2


async def test_ref_details_hidden_when_caller_lacks_case_read(client: AsyncClient, make_user, session,
                                                              monkeypatch) -> None:
    """引用数照报、明细隐瞒（「查不到是谁」必须说出口，不能退化成「没人引用」）。

    这一半今天经 HTTP 走不到（见上一条 docstring 的实测），所以走权限 resolver 的注入点
    ——`core.service.set_perms_resolver` 就是生产用的那个接缝，不是测试专用后门。
    """
    import app.core.service as core_service
    from app.core.registry import REGISTRY
    from app.core.service import ServiceCtx

    boss, hb, pid = await _setup(client, make_user, "N2")
    e = await _el(client, hb, pid, "被隐瞒的元素")
    await _uicase(client, hb, pid, "隐瞒不了的引用方", _steps(e["id"]))

    real = core_service._perms_resolver

    async def _no_case_read(db, user_id, is_admin, project_id):
        # 空集合不是 None：仍是项目成员（数据权限门放行），只是没有任何权限位
        return set() if user_id == boss.id else await real(db, user_id, is_admin, project_id)

    monkeypatch.setattr(core_service, "_perms_resolver", _no_case_read)
    spec = REGISTRY.get("ui_element_refs")
    ctx = ServiceCtx(entry="http", user_id=boss.id, user_name=boss.name,
                     is_system_admin=False, db=session)
    out = await spec.handler(spec.model.model_validate({"project_id": pid, "element_ids": [e["id"]]}), ctx)
    assert out.groups[0].count == 1, "没有 ui:case:read 也必须报出「有 1 条引用」——保护跟着数据走"
    assert out.groups[0].items == []
    assert out.details_hidden is True, "明细被隐瞒这件事本身要可见"

    monkeypatch.undo()
    r = await client.post("/api/v1/ui-elements/" + e["id"] + "/delete", json={"project_id": pid}, headers=hb)
    assert r.status_code == 409, r.text
    assert r.json()["details"]["cases"][0]["name"] == "隐瞒不了的引用方"


async def test_delete_409_discloses_recycle_bin_and_hidden_details_口径(client: AsyncClient, make_user) -> None:
    """409 文案的两处「说一半」都要补上，且只动文案不动拦截行为（R106 的文案兑现轮）。

    ① _scan_element_refs 只数 normal 用例（element_services.py:105）——照「N 条」解完绑
      删除会成功，回收站里那条一恢复就留悬空 element_id、执行期才炸。「回收 ≠ 解绑」
      必须此刻说出口（api_test/case_services.py:127 的同一条口径）；
    ② 正面对照：boss（`*` 匹配 ui:case:read）走正常路 → 名单可见、**不得**出现
      「需要 ui:case:read」的隐瞒句——补丁句只许在无权限时挂上。
    """
    _, h, pid = await _setup(client, make_user, "Honest409")
    e = await _el(client, h, pid, "解绑了也删不掉的元素")
    await _uicase(client, h, pid, "正常引用方", _steps(e["id"]))
    r = await client.post("/api/v1/ui-elements/" + e["id"] + "/delete", json={"project_id": pid}, headers=h)
    assert r.status_code == 409 and r.json()["code"] == "referenced_by_case", r.text
    msg = r.json()["message"]
    assert "回收站里的用例也一样：回收 ≠ 解绑" in msg, msg
    assert r.json()["details"]["referenced_by"] == 1 and r.json()["details"]["details_hidden"] is False
    assert "需要 ui:case:read" not in msg, "看得见名单的人不该被塞一句「去找有权限的人」"
    assert (await _list(client, h, pid))["items"], "拦了就得真没删（文案改动不许碰行为）"


async def test_delete_409_hidden_details_clause_names_the_missing_perm(client: AsyncClient, make_user,
                                                                       session, monkeypatch) -> None:
    """无 ui:case:read 时：数量照报、名单隐瞒，而且**要说名单在哪、缺什么权限**。

    details_hidden=True 只回答了「为什么 cases 是空的」，message 不点出 ui:case:read 的话，
    用户会以为系统坏了（scenario/services.py:475 与 api_test/case_services.py:119 的口径：
    隐瞒本身可见、出口可操作）。注入手法沿用 :383 那条的 resolver 接缝——生产同款注入点。
    """
    import app.core.service as core_service

    boss, hb, pid = await _setup(client, make_user, "Hid409")
    e = await _el(client, hb, pid, "只能看数量的元素")
    await _uicase(client, hb, pid, "看不见的引用方", _steps(e["id"]))

    real = core_service._perms_resolver

    async def _element_only(db, user_id, is_admin, project_id):
        # 集合非 None（成员门放行）且带删除位，但没有 ui:case:read：保护必须照常生效
        return {"ui:element:*"} if user_id == boss.id else await real(db, user_id, is_admin, project_id)

    monkeypatch.setattr(core_service, "_perms_resolver", _element_only)
    r = await client.post("/api/v1/ui-elements/" + e["id"] + "/delete", json={"project_id": pid}, headers=hb)
    assert r.status_code == 409 and r.json()["code"] == "referenced_by_case", r.text
    body = r.json()
    assert body["details"]["details_hidden"] is True and body["details"]["cases"] == []
    assert body["details"]["referenced_by"] == 1, "数量照报：隐瞒明细不等于隐瞒引用存在"
    assert "需要 ui:case:read" in body["message"], body["message"]
    assert "回收站里的用例也一样：回收 ≠ 解绑" in body["message"], "两句诚实叠加，一句都不能省"
    assert "看不见的引用方" not in r.text, "隐瞒 = 整条响应里都不出现名字，不只是 cases 置空"


async def test_locator_type_is_closed_at_five(client: AsyncClient, make_user) -> None:
    """R100/D2：一期定位器 5 种，第 6 种（placeholder）业主没点名就不加。"""
    _, h, pid = await _setup(client, make_user, "N")
    for t in ("id", "css", "xpath", "text", "name"):
        r = await client.post("/api/v1/ui-elements", json={
            "project_id": pid, "name": "e-" + t, "locator_type": t, "locator": "x"}, headers=h)
        assert r.status_code == 201, f"{t}: {r.text}"
    for t in ("placeholder", "CSS", ""):
        r = await client.post("/api/v1/ui-elements", json={
            "project_id": pid, "name": "bad-" + (t or "empty"), "locator_type": t, "locator": "x"}, headers=h)
        assert r.status_code == 422, f"{t!r} 不该被接受：{r.text}"


async def test_unfiled_only_filter_is_a_real_entry(client: AsyncClient, make_user) -> None:
    """树侧栏「未分类」必须是真筛选项，不是点了没反应的假入口（§13 纪律 1）。"""
    _, h, pid = await _setup(client, make_user, "O")
    m = (await client.post("/api/v1/ui-modules", json={"project_id": pid, "name": "登录页"}, headers=h)).json()
    await _el(client, h, pid, "有归属", module_id=m["id"])
    await _el(client, h, pid, "未分类")
    rows = (await _list(client, h, pid))["items"]
    assert {i["name"] for i in rows} == {"有归属", "未分类"}
    assert {i["name"] for i in (await _list(client, h, pid, module_id=m["id"]))["items"]} == {"有归属"}
    assert {i["name"] for i in (await _list(client, h, pid, unfiled_only=True))["items"]} == {"未分类"}
