"""D47-b 步 5b：场景列表（/scenarios）筛选下推到 SQL + 挂页码分页（后端半边）。

照抄两条已落地模式：`5894bc2`（module_ids/keyword 下推）+ `26ace02`（current 页码模式），
语义逐字对齐前端现状（web/src/pages/scenes.tsx 的浏览器内过滤，另有代理在改那份文件）：

- 模块 = **直属**（ownModuleIds 只返回选中节点自己；徽标本来就是直属计数，口径已一致，
  本刀不碰徽标、不碰子树——子树是另一刀，要业主先裁）。
- keyword = **只打 name 一列**、`toLowerCase().includes()` 口径；转义复用 shared.filters._like。
- 未分类行（module_id IS NULL）在「选中某模块」时必须不进结果：前端拿 `module_id ?? "__none"`
  与真模块 id 比较永不相等，SQL 侧 `NULL IN (...)` 不为真——两边同构，本文件把它钉成
  可观察行为而不是 SQL 巧合。

钉的契约（各钉各的失效方式）：

1. **下推等价性**（「零行为改变」的唯一证据）：同一份种子上，旧本地口径在测试里用 Python
   现算，与新服务端结果逐个 id 相等，keyword×模块全组合遍历。
2. keyword 转义：搜 "%" 只中名字真含 "%" 的行，不许全表命中。
3. module_ids 三态：None / [x] / [] 各钉绝对数字；`[]` 与 `None` 可区分。
4. 页码三判据：响应键**完整 dict 相等**（不用 in）；cursor+current → 400；total 是筛完全集
   （三种筛选各一个绝对数，且都与表总行数不同）；越界页 = 空 items + 真 total；size=201 → 422。
5. 判据 5：绝对期望序（种子的 id 序 / 插入序 / created_at 序互不相同，先自证区分度），
   **不写**「页码序 == 游标序」那种两制同时换键照样绿的套套逻辑。
6. keyword 与 module_ids AND 进同一条查询、total 在两者之后算（关键词命中 5 条、其中只有
   2 条在选中模块里 → total==2）。

**`module_ids=[]` 走 service 层的例外**（与 test_d47b_api_pushdown 同款，不是偷懒）：
空列表在 query string 上表达不出来——httpx 把 `module_ids=[]` 编码成空串、参数整个消失，
服务端只能看到 None；而 `[]` 与 None 的区分恰恰要钉，只能从 JSON 入参（agent 工具入口）
那一侧钉。其余读取（含非空 module_ids）全部走真实 HTTP——GET 投影对序列字段的 Query()
包装由本文件的 transport pin 用例专门钉住。

种子的一条实况（写用例时才发现，记下来别再踩）：scenario 表有
`UniqueConstraint(project_id, name)` 且列是 utf8mb4_0900_ai_ci——**同项目内字面同名、
甚至只差大小写的两行都种不进去**（ci collation 判等）。所以「兄弟模块同名」这行种子落不成
字面同名，改钉它真正要防的东西：兄弟模块里**名字同样命中关键词**的行，必须被模块过滤挡在门外；
大小写不敏感则用「关键词与行名大小写不同」钉（"ALPHA" 命中 "Alpha下单"），与本地
`toLowerCase()` 口径仍可逐行对照。

变异自证见 D:/item/ai-test/.tmp-mut/mut5b.py（不提交）：摘 keyword / 摘 _like 转义 /
摘 escape= 参数（等价变异：MySQL LIKE 默认转义符就是反斜杠）/ 摘 module_ids / [] 与 None
混同 / 双参 400 摘掉 / 不数 total / total 无视 WHERE / 换排序键 / 不做 OFFSET / 越界钳回首页。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.core.service import build_ctx
from app.modules.scenario import schemas
from app.modules.scenario.models import Scenario
from app.modules.scenario.services import scenario_list


async def _proj(client, h, name) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _mod(client, h, pid, name) -> dict:
    r = await client.post("/api/v1/scenario-modules", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _scen(client, h, pid, name, *, module_id: str | None = None,
                public: bool = True) -> dict:
    body: dict = {"project_id": pid, "name": name, "project_public": public}
    if module_id:
        body["module_id"] = module_id
    r = await client.post("/api/v1/scenarios", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _list(client, h, pid, *, module_ids: list[str] | None = None,
                keyword: str | None = None, **params) -> dict:
    """真实 HTTP 一页。module_ids 用重复键上线（GET 投影的 Query() 承载，见 transport pin）。"""
    qs: list[tuple[str, str]] = [("project_id", pid)]
    qs += [("module_ids", m) for m in (module_ids or [])]
    if keyword is not None:
        qs.append(("keyword", keyword))
    for k, v in params.items():
        if v is not None:
            qs.append((k, str(v)))
    r = await client.get("/api/v1/scenarios", params=qs, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _svc_list(session, user, pid: str, **kw) -> list[dict]:
    """service 层直调——**只用于 `module_ids=[]` 这一条**（query string 装不下空列表，见模块 docstring）。"""
    ctx = await build_ctx(session, user, {"project_id": pid}, entry="http")
    page = await scenario_list(schemas.ScenarioListIn(project_id=pid, **kw), ctx)
    return [{"id": x.id, "name": x.name, "module_id": x.module_id} for x in page.items]


async def _seed_eq(client, h, pid) -> dict:
    """等价性种子：大小写差异行 / %与_字面量行 / 未分类行 / 兄弟模块同关键词行。

    布局（直属）：M1 = Alpha下单 / beta场景 / a_b场景；M2 = a%b场景 / Alpha副本；未分类 = gamma场景。
    直属计数 3/2/1——与徽标口径（直属）一致，本刀徽标一行不动。
    """
    m1 = await _mod(client, h, pid, "M1")
    m2 = await _mod(client, h, pid, "M2")
    rows = [("Alpha下单", m1["id"]), ("beta场景", m1["id"]), ("a_b场景", m1["id"]),
            ("a%b场景", m2["id"]), ("Alpha副本", m2["id"]), ("gamma场景", None)]
    out = {"m1": m1["id"], "m2": m2["id"]}
    for name, mid in rows:
        s = await _scen(client, h, pid, name, module_id=mid)
        out[name] = s["id"]
    return out


def _local_filter(rows: list[dict], kw: str, mid: str | None) -> list[str]:
    """**旧本地口径逐字重算**（scenes.tsx 141-146）：模块 = 直属含 __none 哨兵比较，
    关键词 = trim+toLowerCase 后对 name 的子串包含。全空白 = 不筛。"""
    sub = {mid} if mid else None
    low = kw.strip().lower()
    out = []
    for r in rows:
        if sub and (r["module_id"] if r["module_id"] is not None else "__none") not in sub:
            continue
        if low and low not in r["name"].lower():
            continue
        out.append(r["id"])
    return out


async def test_pushdown_equals_old_browser_filter_id_by_id(client, make_user) -> None:
    """零行为改变的唯一证据：旧口径在测试里用 Python 现算，与新服务端结果逐个 id 相等。

    keyword×模块全组合（含全空白、大小写、%与_字面量、查无此词 × 不选/选M1/选M2）：
    任何一格不等都说明下推写的不是浏览器那件事。组合里刻意含「兄弟模块同关键词」的靶
    （Alpha副本 ∈ M2）：选 M1 + kw=alpha 时它不许进来。
    """
    _, h = await make_user("d47b5beq")
    pid = await _proj(client, h, "D47B5B等价")
    ids = await _seed_eq(client, h, pid)
    full = (await _list(client, h, pid, size=200))["items"]
    assert len(full) == 6, "种子没种全，等价性无从对照"

    for kw in ("", "   ", "alpha", "ALPHA", "Beta", "%", "a_", "场景", "查无此词"):
        for mid in (None, ids["m1"], ids["m2"]):
            server = await _list(client, h, pid,
                                 module_ids=[mid] if mid else None,
                                 keyword=kw or None)
            assert [x["id"] for x in server["items"]] == _local_filter(full, kw, mid), \
                f"kw={kw!r} mid={mid} 新旧口径不等"
    # 哨兵口径的钉子显式重述一遍：未分类行在「选中任何真模块」时都不在（不靠 SQL 巧合）
    sel = [x["id"] for x in (await _list(client, h, pid, module_ids=[ids["m1"]]))["items"]]
    assert ids["gamma场景"] not in sel and len(sel) == 3


async def test_keyword_treats_percent_and_underscore_as_literals(client, make_user) -> None:
    """用户敲的 % 与 _ 是字面量（复用 filters._like + ESCAPE），不是通配符。

    变异自证：摘 _like 转义 → keyword="%" 命中全表、"a_" 连 "a%b" 一起捞，红；
    只摘 escape= 参数 → **等价变异**（MySQL LIKE 默认转义符本就是反斜杠），杀不掉是正确结果。
    """
    _, h = await make_user("d47b5bsc")
    pid = await _proj(client, h, "D47B5B转义")
    ids = await _seed_eq(client, h, pid)

    got = [x["name"] for x in (await _list(client, h, pid, keyword="%"))["items"]]
    assert got == ["a%b场景"], "% 当通配符就是全表命中：" + str(got)
    got = [x["name"] for x in (await _list(client, h, pid, keyword="a_b"))["items"]]
    assert got == ["a_b场景"], "_ 当通配符会把 a%b场景 也按 a?b 捞进来：" + str(got)
    # % 与 _ 同敲、转义叠加不许互相拆台
    assert [x["id"] for x in (await _list(client, h, pid, keyword="a%b"))["items"]] == [ids["a%b场景"]]


async def test_module_ids_none_single_empty_absolute_numbers(client, session, make_user) -> None:
    """module_ids 三态各一个绝对数：None=6、[M1]=3（未分类不进来）、[]=0；[M2]=2。

    [] 与 None 的区分必须可观察（[] = 对任何行都不成立，**含 module_id IS NULL 的行**）。
    变异自证：`is not None` → 真值判断 → [] 变全量 6 行，红（这条只有 service 层钉得住，
    理由见模块 docstring）。
    """
    u, h = await make_user("d47b5bmid")
    pid = await _proj(client, h, "D47B5B三态")
    ids = await _seed_eq(client, h, pid)

    assert len((await _list(client, h, pid))["items"]) == 6, "None = 不过滤"
    one = (await _list(client, h, pid, module_ids=[ids["m1"]]))["items"]
    assert len(one) == 3 and ids["gamma场景"] not in {x["id"] for x in one}, \
        "选中模块时未分类场景不许进来"
    assert len((await _list(client, h, pid, module_ids=[ids["m2"]]))["items"]) == 2
    got = await _svc_list(session, u, pid, module_ids=[])
    assert got == [], "[] 被当成了没筛选：" + str(got)
    assert len(await _svc_list(session, u, pid)) == 6, "同一条 service 路径上 None 仍是 6（[]≠None）"


async def test_wire_contract_keys_dual_param_and_size_cap(client, session, make_user) -> None:
    """游标键集恰好 {items,next_cursor}（完整 dict 键集相等）、页码恰好 {items,next_cursor,total}、
    双参 400、size=201 → 422。

    键集路径形状不许变：scenario_list 同时是 agent 工具入口（test_tool_surface_1b 在 disp.call），
    凭空多出 "total": null 就是单方面改契约。变异自证：摘互斥检查 → 双参 400 红；
    _dump 无条件写 total → 第一条红。
    """
    u, h = await make_user("d47b5bwire", admin=True)
    pid = await _proj(client, h, "D47B5B契约")
    for i in range(3):
        await _scen(client, h, pid, "契约" + str(i))

    body = await _list(client, h, pid, size=2)  # 3 行 / size=2 → 首页必有游标
    assert set(body) == {"items", "next_cursor"}, "游标首页键集变了：" + str(sorted(body))
    assert body["next_cursor"] is not None, "种子给不出续页，下面两条白测"
    nxt = await client.get("/api/v1/scenarios",
                           params={"project_id": pid, "size": 2, "cursor": body["next_cursor"]},
                           headers=h)
    assert nxt.status_code == 200, nxt.text
    assert set(nxt.json()) == {"items", "next_cursor"}, "游标续页键集变了：" + str(sorted(nxt.json()))

    paged = await _list(client, h, pid, size=10, current=1)
    assert set(paged) == {"items", "next_cursor", "total"}, \
        "页码模式必须带 total：" + str(sorted(paged))
    assert paged["next_cursor"] is None, "页码模式不产游标，否则两套真相并存"

    both = await client.get("/api/v1/scenarios",
                            params={"project_id": pid, "size": 10, "current": 1,
                                    "cursor": body["next_cursor"]}, headers=h)
    assert both.status_code == 400, "cursor 与 current 同时到场必须大声报错：" + both.text
    assert both.json()["code"] == "bad_request"

    over = await client.get("/api/v1/scenarios",
                            params={"project_id": pid, "size": 201, "current": 1}, headers=h)
    assert over.status_code == 422, "size 越界是 422 不是钳到 200：" + over.text
    assert u.id


async def test_total_is_filtered_set_and_page_order_is_id(client, session, make_user) -> None:
    """total = 筛完全集的三种绝对数（2/4/3，两两不同且都不等于表总行数 6）；越界页空 + 真 total；
    keyword 与 module_ids AND 进同一条查询（关键词命中 5 条、模块内只有 2 条 → total==2）。

    变异自证：total 无视 WHERE（数整表）→ 三条全对不上 6；不数 total → 键缺 total 键红。
    """
    u, h = await make_user("d47b5btot", admin=True)
    pid = await _proj(client, h, "D47B5B总数")
    m1 = await _mod(client, h, pid, "M1")
    m2 = await _mod(client, h, pid, "M2")
    rows = [("Kw场景一", m1["id"]), ("Kw场景二", m1["id"]), ("别的", m1["id"]),
            ("Kw场景三", m2["id"]), ("Kw场景四", m2["id"]), ("Kw场景五", None)]
    for name, mid in rows:
        await _scen(client, h, pid, name, module_id=mid)

    none = await _list(client, h, pid, size=2, current=1)
    assert none["total"] == 6, "不加筛选 total = 全量 6：" + str(none["total"])
    kw = await _list(client, h, pid, size=2, current=1, keyword="Kw")
    assert kw["total"] == 5, "keyword 要进 total 的同一份条件：" + str(kw["total"])
    mod = await _list(client, h, pid, size=2, current=1, module_ids=[m1["id"]])
    assert mod["total"] == 3, "module_ids 同理：" + str(mod["total"])
    both = await _list(client, h, pid, size=2, current=1, module_ids=[m1["id"]], keyword="Kw")
    assert both["total"] == 2, "两路 AND 之后数数：命中关键词 5 条里只有 2 条在 M1，实得 " + str(both["total"])
    assert len(both["items"]) == 2, "本页仍按 size 切（total 不是本页行数）"
    assert len({none["total"], kw["total"], mod["total"]}) == 3, "种子没有区分度，total 三数撞脸"

    past = await _list(client, h, pid, size=2, current=9, keyword="Kw")
    assert past["items"] == [] and past["total"] == 5, "越过末页 = 空 items + 真 total，不是 500"
    zero = await _list(client, h, pid, size=2, current=1, module_ids=["不存在"])
    assert zero["total"] == 0 and zero["items"] == [], "空结果大方说 0，不许被 falsy 吞掉"
    assert u.id


async def test_page_and_cursor_share_the_id_order_absolute(client, session, make_user) -> None:
    """判据 5：本端点排序键是 `ORDER BY id`，先自证种子三种序互不相同，再钉绝对期望序。

    不写「页码序 == 游标序」那种套套逻辑（两制同时换键照样绿，步 2 踩过）。id 与 created_at
    直种（HTTP 拿不到可控 id 序，同款取舍见 test_d47b_api_page）。
    """
    u, h = await make_user("d47b5border", admin=True)
    pid = await _proj(client, h, "D47B5B时序")
    now = datetime.now(UTC).replace(microsecond=0)
    # (id, 创建偏移天数)：插入序 = created_at 偏移序 = z, m, a, q, b, k
    plan = [("z-1", 9), ("m-2", 5), ("a-3", 7), ("q-4", 1), ("b-5", 8), ("k-6", 2)]
    inserted = []
    for sid, back in plan:
        session.add(Scenario(id=sid, project_id=pid, name="场景" + sid,
                             step_graph={"version": 1, "nodes": []},
                             created_at=now - timedelta(days=back),
                             updated_at=now - timedelta(days=back)))
        await session.commit()
        inserted.append(sid)

    expected = sorted(inserted)  # 服务端那条 ORDER BY Scenario.id
    by_time = [sid for sid, _ in sorted(plan, key=lambda x: x[1])]
    assert expected != inserted, "种子没有区分度（id 序 == 插入序），本例白测"
    assert expected != list(reversed(inserted)), "种子没有区分度（id 序 == 插入序倒序），本例白测"
    assert expected != by_time, "种子没有区分度（id 序 == created_at 升序），本例白测"

    paged: list[str] = []
    for current in (1, 2, 3):
        body = await _list(client, h, pid, size=2, current=current)
        assert body["total"] == 6
        paged.extend(x["id"] for x in body["items"])
    assert len(paged) == len(set(paged)) == 6, "页与页重叠或漏行 = OFFSET 没生效：" + str(paged)
    assert paged == expected, "页码走出的序必须就是 id 升序：" + str(paged)

    walked: list[str] = []
    cursor: str | None = None
    for _ in range(10):
        body = await _list(client, h, pid, size=2, cursor=cursor)
        walked.extend(x["id"] for x in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert walked == expected, "游标走出的序偏离 id 升序 = 两制排序表达式分叉：" + str(walked)
    assert u.id


async def test_keyword_does_not_leak_invisible_rows(client, make_user) -> None:
    """新谓词不许从可见性缝里漏行（§4.1）：别人的私有场景命中 keyword 也不许现身。

    公开对照行同关键词命中，证明筛选在工作、「结果为空」不是筛选失效的假绿。
    变异自证：摘 visible_clause → 「撞名-私有」出现，红。
    """
    _, h_pa = await make_user("d47b5bkwpapa")
    pid = await _proj(client, h_pa, "D47B5B越权")
    u_view, h_view = await make_user("d47b5bkwview")
    u_priv, h_priv = await make_user("d47b5bkwwner")
    for uid in (u_view.id, u_priv.id):
        r = await client.put(f"/api/v1/projects/{pid}/members/{uid}",
                             json={"role_code": "MEMBER"}, headers=h_pa)
        assert r.status_code == 200, r.text

    m = await _mod(client, h_priv, pid, "M")
    await _scen(client, h_priv, pid, "撞名-私有", public=False)
    await _scen(client, h_priv, pid, "撞名-公开", public=True)
    await _scen(client, h_priv, pid, "撞名-私有入模块", public=False, module_id=m["id"])

    assert [x["name"] for x in (await _list(client, h_view, pid))["items"]] == ["撞名-公开"]  # 控制组
    got = [x["name"] for x in (await _list(client, h_view, pid, keyword="撞名"))["items"]]
    assert got == ["撞名-公开"], f"私有行从新谓词泄露：{got}"
    assert [x["name"] for x in (await _list(client, h_view, pid, keyword="私有"))["items"]] == []
    assert [x["name"] for x in (await _list(client, h_view, pid, module_ids=[m["id"]],
                                            keyword="撞名"))["items"]] == [], \
        "私有行藏在被选中的模块里也不许现身"


async def test_get_projection_carries_list_query_params(app, client, make_user) -> None:
    """[transport pin] GET /scenarios 投影必须把 list 型 query 字段带到线上（复用步 4a 的修复）。

    core/service.py 的 GET 分支给序列型字段包 Query() 后对全体 GET 端点生效；本用例钉
    「这条端点真的吃到了修复」：参数表里有 module_ids/keyword、GET 上不许有幽灵 requestBody、
    重复键真到 handler（返回直属那 3 行而不是全量 6 行）。
    """
    _, h = await make_user("d47b5bxfer")
    pid = await _proj(client, h, "D47B5B传输层")
    ids = await _seed_eq(client, h, pid)

    op = app.openapi()["paths"]["/api/v1/scenarios"]["get"]
    param_names = {p["name"] for p in op.get("parameters", [])}
    assert "keyword" in param_names and "current" in param_names
    assert "module_ids" in param_names, \
        "list 查询参数掉出参数表：core/service.py GET 分支的 Query() 包装被摘掉了"
    assert "requestBody" not in op, "GET 上凭空出现请求体 = 序列字段又被当成 body 了"

    r = await _list(client, h, pid, module_ids=[ids["m1"]])
    # 名字按 set 比：id 是 uuid4，ORDER BY id 与插入序无关（绝对序在时序用例里直种 id 钉）
    assert {x["name"] for x in r["items"]} == {"Alpha下单", "beta场景", "a_b场景"}, \
        "重复键没到 handler：投影返回了全量"
