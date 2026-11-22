"""D47-b 步 4a：接口管理页的模块筛选与关键字搜索下推到 SQL + 徽标改子树计数。

钉的契约（各钉各的失效方式）：

- **子树语义成对生效**（owner 裁定推翻 T23/R120 直属旧口径）：列表按调用方发来的
  「节点+全部子孙」id 集过滤，徽标按同一棵树做子树累加。**两边必须同时翻**，只翻一边
  就是「徽标写 3 的模块点开出 7 行」那个谎换了方向——所以本文件把「badge == 子树列表
  条数」钉成显式断言（test_badge_matches_subtree_list_length）。
- **种子必须区分直属与子树**：本 change 早期翻过「fixture 里两种口径数值相等，测试白测」
  的车。这里 root 直属 1 条、子树 6 条，两种口径给不出同一张脸（各用例 docstring 点明）。
- **[] = 谁都不匹配**（含未分类行），None = 不过滤。
- **keyword = name/path 的 OR**，% 与 _ 是字面量（复用 shared.filters._like + ESCAPE），
  空白串 = 没筛选；大小写与重音不敏感是 utf8mb4_0900_ai_ci 的 shipped 语义——它**比**被
  替代的浏览器 `.toLowerCase().includes()` **更宽**（é 命中 e），钉的是这个新宽度本身。
- **可见性不许从新的 OR 里漏**：私有行刻意同时命中 name 与 path 两侧，是本轮最重要的一条。

**module_ids 走 HTTP**（本轮改线）：本仓 GET 路由投影原先把 list 型 query 字段整个丢掉
（`module_ids` 在 OpenAPI 里不存在、重复键传进来变 None）。根因不在我们的投影写错，
是 FastAPI 的规矩：序列注解 + 裸默认值 = 按请求体处理，GET 没有体就静默不落参数
（手写 `async def f(ids: list[str] | None = None)` 同样如此，实测 fastapi 0.162.7）。
core/service.py 的 GET 分支现在给序列型字段包 `Query()`，只包序列型；全仓 47 个 GET 服务里
带序列字段的只有这一条端点，**整份 OpenAPI 前后对比只有这一处差异**（另有一条本就不该存在的
幽灵 requestBody 随之消失），所以其余端点逐字节不变。
唯一仍走 service 层的是 `module_ids=[]`：空列表在 query string 上**表达不出来**
（httpx 把 `module_ids=[]` 编码成空串，参数整个消失 → 落到 None），而 `[]` 与 None 的区分
恰恰是要钉的东西，只能从 JSON 入参那一侧（agent 工具路径）钉。
前端选中的子树永远含节点自身、长度 ≥1，所以这条线上路径 UI 走不到 —— 不是绕路，是它本来就
只属于工具入口。

变异自证（本轮逐条真跑过，restore 后与原件逐字节 cmp 一致）：
- 摘掉徽标 roll-up 整段 → test_badges_are_subtree_counts_and_leaf_keeps_direct 红
- roll-up 改按深度**升序**（只归并一层的效果）→ 同用例红（root 少算孙辈，得 3 不得 6）
- 摘掉 roll-up 的回收边界守卫 → test_recycled_subtree_is_not_counted_into_visible_parent 红
- keyword 的 or_ 拆成两个并列 where（括号没了）→ test_keyword_matches_name_and_path 红
- 只摘掉两处 like 的 `escape=` 参数 → **等价变异，杀不掉**（MySQL 的 LIKE 默认转义符本来就是
  反斜杠，编译出的 SQL 少了 ESCAPE 子句而结果逐行不变；本轮实测 1 passed）。
  生效的守卫是 `_like` 本身 → 改成原样传 kw → test_keyword_treats_percent_and_underscore_as_literals 红
- `module_ids is not None` 改成真值判断（[] 当没筛选）→ test_empty_module_ids_matches_nothing 红
- 摘掉 module_ids 的 IN 谓词 → test_subtree_ids_return_parent_child_grandchild_and_exclude_sibling 红
- keyword 守卫不判 strip、原串进 LIKE（空白串变 ' % % ' 匹配不到任何行）→ test_whitespace_keyword_is_no_filter 红
- 摘掉 visible_clause（与 D47-a 同款变异）→ test_keyword_does_not_leak_invisible_rows 红
- 已知**惰性变异**（不作判据）：去掉 keyword OR 的 self_group()——先跑了全文件（全绿），
  再核了「这条变异真的到得了生效代码路径」：带/不带 self_group 编译出的 WHERE 逐字节相同
  （SQLAlchemy 拼进 where 时自己补括号，filters.py `self_group()` 注释同款结论），
  因此它是改不动任何结果的无效变异，不是守卫有效。OR 的整体性由「拆并列即红」那条间接钉住。

约定抄 tests/test_d47a_list_filters.py 与 test_d47b_report_page.py：client + make_user + _proj；
写路径全部走 HTTP 真服务，不绕库。
"""
from __future__ import annotations

import json

from app.core.service import build_ctx
from app.modules.api_test import schemas
from app.modules.api_test.services import api_definition_list

REQ = {"method": "GET", "url": "http://127.0.0.1:9999/x", "body": {"type": "none"}}


async def _proj(client, h: dict, name: str) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _mod(client, h: dict, pid: str, name: str, parent: str | None = None) -> dict:
    body: dict = {"project_id": pid, "name": name}
    if parent:
        body["parent_id"] = parent
    r = await client.post("/api/v1/api-modules", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _def(client, h: dict, pid: str, name: str, *, module_id: str | None = None,
               path: str = "/p", public: bool = True, with_request: bool = False) -> str:
    body: dict = {"project_id": pid, "name": name, "method": "GET", "path": path,
                  "project_public": public}
    if module_id:
        body["module_id"] = module_id
    if with_request:
        body["request"] = REQ  # 带请求 → status=complete；不带 → draft（status 高级搜索的靶子）
    r = await client.post("/api/v1/api-definitions", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _tree(client, h: dict, pid: str, include_recycled: bool = False) -> dict:
    params: dict = {"project_id": pid}
    if include_recycled:
        params["include_recycled"] = "true"
    r = await client.get("/api/v1/api-modules", params=params, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _names(client, h: dict, pid: str, *, keyword: str | None = None,
                 recycled: bool = False, flt: dict | None = None,
                 module_ids: list[str] | None = None) -> set[str]:
    """HTTP 列表。module_ids 用重复键上线（`module_ids=a&module_ids=b`），
    非空列表由 GET 投影的 Query() 承载；空列表编码后参数整个消失，见 _svc_names。"""
    qs: list[tuple[str, str]] = [("project_id", pid)]
    qs += [("module_ids", mid) for mid in (module_ids or [])]
    if keyword is not None:
        qs.append(("keyword", keyword))
    if recycled:
        qs.append(("recycled", "true"))
    if flt is not None:
        qs.append(("filter", json.dumps(flt, ensure_ascii=False)))
    r = await client.get("/api/v1/api-definitions", params=qs, headers=h)
    assert r.status_code == 200, r.text
    return {x["name"] for x in r.json()["items"]}


async def _svc_names(session, user, pid: str, *, module_ids: list[str] | None = None,
                     keyword: str | None = None, recycled: bool = False,
                     flt: dict | None = None) -> set[str]:
    """service 层列表——**只用于 `module_ids=[]` 这一条**。

    空列表在 query string 上不存在：httpx 把 `module_ids=[]` 编码成空串（参数整个消失），
    服务端只能看到 None，于是 `[]` 与 None 的区分没法从 HTTP 钉。而 `[]` 是 JSON 入参
    的 agent 工具路径真能发出来的值，所以这一条留在 service 层，是它唯一的归属地。

    build_ctx 用 make_user 的真 User 对象解析项目权限——与 HTTP 请求同一条 resolver，
    可见性/权限门不在这里打折。
    """
    ctx = await build_ctx(session, user, {"project_id": pid}, entry="http")
    page = await api_definition_list(schemas.ApiDefListIn(
        project_id=pid, module_ids=module_ids, keyword=keyword, recycled=recycled,
        filter=json.dumps(flt, ensure_ascii=False) if flt is not None else None), ctx)
    return {x.name for x in page.items}


async def _seed_tree(client, h: dict, pid: str) -> dict:
    """root(直属1) → child(直属2) → grandchild(直属3) + 旁支 sibling(直属1)。

    直属口径与子树口径**故意不等**：root 直属 1 / 子树 6，child 直属 2 / 子树 5，
    leaf 直属 3 = 子树 3（叶子天然相等，这正是要单独钉「叶子不变」的原因）。
    """
    root = await _mod(client, h, pid, "交易")
    child = await _mod(client, h, pid, "下单", root["id"])
    leaf = await _mod(client, h, pid, "批量", child["id"])
    sib = await _mod(client, h, pid, "库存")
    ids = {"root": root["id"], "child": child["id"], "leaf": leaf["id"], "sib": sib["id"]}
    direct = {"root": ["r1"], "child": ["c1", "c2"], "leaf": ["g1", "g2", "g3"], "sib": ["k1"]}
    for mid, ns in direct.items():
        for n in ns:
            await _def(client, h, pid, n, module_id=ids[mid], path="/t/" + n)
    ids["all_but_sib"] = [ids["root"], ids["child"], ids["leaf"]]  # 前端算好的「选中+全部子孙」
    return ids


async def test_subtree_ids_return_parent_child_grandchild_and_exclude_sibling(
    client, make_user
) -> None:
    """module_ids = 节点+全部子孙 → 父/子/孙的行全在、旁支与未分类一行不许有。

    抓什么：把 IN 写成 `module_id == 单选节点`（只回直属）→ c1/g1 缺失即红；
    把子树展开算错（顺带吃了旁支）→ k1 出现即红；摘掉 IN 谓词 → 7 行全回即红。
    未分类行（module_id IS NULL）在 IN 之下必须缺席——SQL 三值逻辑里 `NULL IN (...)`
    不是真，这条把它钉成可观察行为而不是 SQL 巧合。
    """
    _u, h = await make_user("d47bsub")  # 只要 h；_u 不再进 service 层调用（module_ids 已走 HTTP）
    pid = await _proj(client, h, "D47B子树筛选")
    ids = await _seed_tree(client, h, pid)
    await _def(client, h, pid, "未分类", path="/t/none")  # module_id IS NULL

    got = await _names(client, h, pid, module_ids=ids["all_but_sib"])
    assert got == {"r1", "c1", "c2", "g1", "g2", "g3"}, "子树筛选结果不对：" + str(sorted(got))
    # 只发节点自身 → 只回直属那一行。与上一条一起把「过滤 = IN(调用方给的集合)」钉死：
    # 服务端既不自己展开，也不无视入参。
    assert await _names(client, h, pid, module_ids=[ids["root"]]) == {"r1"}
    assert await _names(client, h, pid) == {"r1", "c1", "c2", "g1", "g2", "g3", "k1", "未分类"}, \
        "None 必须等于不加这一路"


async def test_badges_are_subtree_counts_and_leaf_keeps_direct(client, make_user) -> None:
    """徽标改子树计数：root=6、child=5、leaf=3；leaf 的 3 与直属相同是「叶子天然不变」的钉。

    种子区分度（判据 5 教训）：root 直属只有 1 条而徽标必须 6——
    若 fixture 让两种口径数值相等，本例证明不了任何事。断言里同时给出两种口径的证据：
    `module_ids=[root]` 的列表（=直属条数）是 1，徽标是 6。
    变异自证：摘掉 roll-up → root 徽标 1 红；roll-up 按深度升序（只归并一层）→ root=3 红。
    """
    _u, h = await make_user("d47bbadge")  # 只要 h；_u 不再进 service 层调用（module_ids 已走 HTTP）
    pid = await _proj(client, h, "D47B徽标子树")
    ids = await _seed_tree(client, h, pid)

    tree = (await _tree(client, h, pid))["tree"]
    root = next(n for n in tree if n["id"] == ids["root"])
    child = root["children"][0]
    leaf = child["children"][0]
    assert leaf["count"] == 3, f"叶子徽标必须保持直属值 3，实得 {leaf['count']}"
    assert child["count"] == 5, f"child 徽标必须是子树 2+3=5，实得 {child['count']}"
    assert root["count"] == 6, f"root 徽标必须是子树 1+2+3=6，实得 {root['count']}"
    sib = next(n for n in tree if n["id"] == ids["sib"])
    assert sib["count"] == 1, "旁支徽标不许被隔壁子树污染"

    direct = await _names(client, h, pid, module_ids=[ids["root"]])
    assert len(direct) == 1 and root["count"] == 6, "直属 1 / 子树 6 的种子区分度丢了，本文件白测"


async def test_badge_matches_subtree_list_length(client, make_user) -> None:
    """徽标与子树列表必须报同一个数——owner 裁定「两边必须一起翻」的直接钉法。

    单独看徽标或单独看列表都可能各对各的（roll-up 改了、列表 IN 忘了改，或反之），
    页面上「点 6 出 5」依旧说谎。对 root 与 child 两档各钉一次 badge == |列表|。
    """
    _u, h = await make_user("d47bsame")  # 只要 h；_u 不再进 service 层调用（module_ids 已走 HTTP）
    pid = await _proj(client, h, "D47B徽标等列表")
    ids = await _seed_tree(client, h, pid)

    tree = (await _tree(client, h, pid))["tree"]
    root = next(n for n in tree if n["id"] == ids["root"])
    child = root["children"][0]
    assert root["count"] == len(await _names(client, h, pid,
                                             module_ids=ids["all_but_sib"])) == 6
    assert child["count"] == len(await _names(client, h, pid,
                                              module_ids=[ids["child"], ids["leaf"]])) == 5


async def test_recycled_subtree_is_not_counted_into_visible_parent(client, make_user) -> None:
    """回收模块的接口不许流入正常父节点徽标；回收集群内部照样子树累加。

    抓什么：把 roll-up 的回收边界守卫摘掉 → root 徽标把回收掉的 2 条也数进去（5≠3）红。
    这不是洁癖：回收子树在默认视图里不可见、前端拿不到其 id、列表查询永远不带它们——
    让它们的接口计入可见父亲，等于把刚消灭的「徽标与列表对不上」原样请回来。
    """
    _, h = await make_user("d47brecbadge")
    pid = await _proj(client, h, "D47B回收徽标")
    root = await _mod(client, h, pid, "R")
    keep = await _mod(client, h, pid, "C1", root["id"])
    gone = await _mod(client, h, pid, "C2", root["id"])
    await _def(client, h, pid, "r1", module_id=root["id"])
    await _def(client, h, pid, "c1", module_id=keep["id"])
    await _def(client, h, pid, "c2", module_id=keep["id"])
    await _def(client, h, pid, "c3", module_id=gone["id"])
    await _def(client, h, pid, "c4", module_id=gone["id"])
    d = await client.post(f"/api/v1/api-modules/{gone['id']}/delete",
                          json={"project_id": pid}, headers=h)
    assert d.status_code == 200, d.text

    tree = (await _tree(client, h, pid))["tree"]
    assert tree[0]["count"] == 3, f"回收模块的 2 条不许流入 root，实得 {tree[0]['count']}"
    assert tree[0]["children"][0]["count"] == 2

    both = await _tree(client, h, pid, include_recycled=True)
    assert [n["name"] for n in both["recycled"]] == ["C2"]
    assert both["recycled"][0]["count"] == 2, "回收集群根的徽标要能对上它自己的子树列表"


async def test_empty_module_ids_matches_nothing(client, session, make_user) -> None:
    """[] = 谁都不匹配（**含 module_id IS NULL 的未分类行**）；None = 不过滤。

    [] 与 None 在模型层必须可区分——把 [] 读成「没筛选」，「清空选择」和「选了个空子树」
    两种意图就永远分不开。[] 还必须是**严格**空集：未分类行不得从 `NULL IN ()` 的三值
    逻辑缝里漏进结果。变异自证：`is not None` → 真值判断，[] 变全量 2 行，红。
    """
    u, h = await make_user("d47bempty")
    pid = await _proj(client, h, "D47B空列表")
    m = await _mod(client, h, pid, "M")
    await _def(client, h, pid, "在模块", module_id=m["id"])
    await _def(client, h, pid, "未分类")

    got = await _svc_names(session, u, pid, module_ids=[])
    assert got == set(), "[] 被当成了没筛选：" + str(sorted(got))
    assert await _svc_names(session, u, pid) == {"在模块", "未分类"}


async def test_keyword_matches_name_and_path_case_insensitive(client, make_user) -> None:
    """keyword 是 name OR path：只命中路径的行也必须在，都不命中的必须不在。

    变异自证：把 or_ 拆成两个并列 where（括号没了→被 AND 拼接吃掉）→ 只命中 path 的
    「库存查询」掉出结果，本例红。大小写不敏感一并钉（ORDER 命中 order）。
    """
    _, h = await make_user("d47bkw")
    pid = await _proj(client, h, "D47B关键字")
    await _def(client, h, pid, "订单创建", path="/order/create")
    await _def(client, h, pid, "库存查询", path="/order/query")  # 名字不含关键词，只有路径中
    await _def(client, h, pid, "无关接口", path="/x")

    assert await _names(client, h, pid, keyword="订单") == {"订单创建"}
    assert await _names(client, h, pid, keyword="order") == {"订单创建", "库存查询"}
    assert await _names(client, h, pid, keyword="ORDER") == {"订单创建", "库存查询"}, \
        "大小写不敏感是 utf8mb4_0900_ai_ci 的免费午餐，掉了说明 LIKE 两侧有一侧没走对列"
    assert await _names(client, h, pid, keyword="查无此词") == set()


async def test_keyword_treats_percent_and_underscore_as_literals(client, make_user) -> None:
    """用户敲的 % 与 _ 是字面量（复用 filters._like + ESCAPE '\\\\'），不是通配符。

    变异自证（两条别混，实测过）：
    - **摘掉 `_like` 转义**（原样把 kw 塞进 LIKE）→ 本例红：`keyword="a_b"` 连 "aXb" 一起命中、
      `keyword="%"` 命中全表。生效的守卫是 `_like` 本身。
    - 只摘掉 `escape=` 参数 → **杀不掉，等价变异**：MySQL 的 LIKE 默认转义符本来就是反斜杠，
      编译出的 SQL 少了 ESCAPE 子句而结果逐行不变（本轮实测 1 passed）。
      这句写在这里是为了拦下下一个人：他跑第二条看见全绿，容易反过来怀疑本例太弱——
      不是本例弱，是那条变异没有可观察差异。等价变异长得和「没测到」一模一样，只能记下来。
    本例走的是 keyword 自己的代码路径（不经 CONTAINS 编译器），所以转义必须由这里自己接上，
    与 filters.test_like_escapes_wildcards 的靶形同型不同路。
    """
    _, h = await make_user("d47bscape")
    pid = await _proj(client, h, "D47B转义")
    await _def(client, h, pid, "a%b", path="/p1")
    await _def(client, h, pid, "aXb", path="/p2")
    await _def(client, h, pid, "a_b", path="/p3")
    await _def(client, h, pid, "plain", path="/p4")

    assert await _names(client, h, pid, keyword="a%b") == {"a%b"}
    assert await _names(client, h, pid, keyword="a_b") == {"a_b"}, "_ 当通配符就会把 aXb 也捞进来"
    assert await _names(client, h, pid, keyword="%") == {"a%b"}, "% 当通配符就是全表命中"
    assert await _names(client, h, pid, keyword="a\\b") == set(), "反斜杠也是字面量（库里没人叫这个）"


async def test_keyword_does_not_leak_invisible_rows(client, make_user) -> None:
    """**本文件最重要的一条**：别人的私有行不许从新的 OR 里漏出来（§4.1）。

    靶子按 d47a 同款挑最坏的：私有行的 name 与 path **两侧都命中** keyword——可见性
    谓词只要没和 OR 组 AND 上，它立刻现身。公开对照行同关键词命中，证明筛选在工作、
    「结果为空」不是筛选失效的假绿。module_ids 一路同款复验（service 层，见 transport pin）。
    变异自证：摘掉 api_definition_list 的 visible_clause(...) → 「撞名-私有」出现，红。
    """
    u_pa, h_pa = await make_user("d47bkwpapa")
    pid = await _proj(client, h_pa, "D47B关键字越权")
    u_view, h_view = await make_user("d47bkwview")
    u_priv, h_priv = await make_user("d47bkwwner")
    for uid in (u_view.id, u_priv.id):
        r = await client.put(f"/api/v1/projects/{pid}/members/{uid}",
                             json={"role_code": "MEMBER"}, headers=h_pa)
        assert r.status_code == 200, r.text

    m = await _mod(client, h_pa, pid, "M")
    await _def(client, h_priv, pid, "撞名-私有", path="/kwpriv/kw", public=False)
    await _def(client, h_priv, pid, "撞名-公开", path="/kwpub/kw", public=True)
    await _def(client, h_priv, pid, "撞名-私有入模块", path="/kwpriv/m", public=False, module_id=m["id"])

    # 控制组：不带筛选就看不到（否则下面的断言可能只是巧合）
    assert await _names(client, h_view, pid) == {"撞名-公开"}

    got = await _names(client, h_view, pid, keyword="kw")
    assert "撞名-私有" not in got and "撞名-私有入模块" not in got, f"私有行从 keyword OR 泄露：{got}"
    assert "撞名-公开" in got, "对照行不在场说明筛选没在工作，上面那条没筛到东西是假绿"
    # 只命中私有行 path 一侧的关键词：结果必须是空（它只是不存在，不是 403）
    assert await _names(client, h_view, pid, keyword="kwpriv") == set()
    # module_ids 一路同款：私有行藏在被选中的模块里也不许现身（公开对照行不在该模块）
    assert await _names(client, h_view, pid, module_ids=[m["id"]], keyword="撞名") == set()


async def test_whitespace_keyword_is_no_filter(client, make_user) -> None:
    """全空白 keyword = 没筛选，且与「不带 keyword」的行集**逐名相等**。

    抓什么：守卫若不判 strip 而把 "   " 当有效词（strip 前原样进 LIKE），用户「清空输入
    框」和「敲了空格」会拿到不同结果——两边必须都回到全量。strip 后拿原串拼 LIKE 的
    变体同样被这条抓住（两侧空白进入匹配串就没有行能中，行集变空 ≠ 全量）。
    """
    _, h = await make_user("d47bws")
    pid = await _proj(client, h, "D47B空白关键字")
    await _def(client, h, pid, "甲")
    await _def(client, h, pid, "乙")
    assert await _names(client, h, pid, keyword="   ") == await _names(client, h, pid) == {"甲", "乙"}


async def test_accent_insensitive_ci_is_the_shipped_semantics(client, make_user) -> None:
    """utf8mb4_0900_ai_ci 同时**重音不敏感**：搜 "cafe" 命中 "Café"——这是 shipped 语义。

    它**比**被替代的浏览器端 `.toLowerCase().includes()` **更宽**（JS 精确匹配 é≠e）。
    本例刻意钉「新宽度」而不是旧行为：哪天库排序规则被换成 _bin/_cs，本例红，逼来一场
    关于「搜索宽窄」的讨论，而不是让页面悄悄换一套匹配语义。
    """
    _, h = await make_user("d47bacc")
    pid = await _proj(client, h, "D47B重音")
    await _def(client, h, pid, "Café下单", path="/cafe")
    assert await _names(client, h, pid, keyword="cafe") == {"Café下单"}, \
        "ai_ci 的重音不敏感丢了（或被换成精确匹配）——搜索语义变了，该有人知道"


async def test_keyword_module_and_status_and_together(client, make_user) -> None:
    """keyword、module_ids、高级搜索（status）三路必须 AND 成一体。

    四个靶子各缺一路就进结果：跨模块的、状态不对的、关键词不中的、什么都不缺的。
    只回「模块内 ∧ 关键词 ∧ draft」那一条。抓的是谓词漏拼进 where（比如 keyword 分支
    写成 elif）——那会静默放宽结果，界面上一切正常。
    """
    _u, h = await make_user("d47band")  # 只要 h；_u 不再进 service 层调用（module_ids 已走 HTTP）
    pid = await _proj(client, h, "D47B三路AND")
    m = await _mod(client, h, pid, "M")
    other = await _mod(client, h, pid, "O")
    await _def(client, h, pid, "kw草稿中", module_id=m["id"])                     # draft ✓
    await _def(client, h, pid, "kw完成中", module_id=m["id"], with_request=True)  # ✗状态
    await _def(client, h, pid, "kw草稿外", module_id=other["id"])                 # ✗模块
    await _def(client, h, pid, "别的草稿", module_id=m["id"])                     # ✗关键词
    flt = {"conditions": [{"field": "status", "operator": "EQUALS", "value": "draft"}]}
    got = await _names(client, h, pid, module_ids=[m["id"]], keyword="kw", flt=flt)
    assert got == {"kw草稿中"}, got
    # 对照：同一 flt+keyword 过 HTTP（标量参数投影装得下），结果必须一致——
    # service 直调不许绕开 HTTP 也有的谓词（filter 解析在 API_LIST_FILTER，两边同码）。
    assert await _names(client, h, pid, keyword="kw", flt=flt) == {"kw草稿中", "kw草稿外"}


async def test_recycled_view_with_keyword_still_excludes_normal_rows(client, make_user) -> None:
    """回收站视图 + keyword：回收的只看回收的，正常行一条不许漏进来。

    两条行都刻意命中 keyword——漏了 recycled 谓词（或被 keyword 的 AND 组合覆盖）
    就会让正常视图混进回收行、或回收视图变全量。既有保证在新增谓词后原地复验。
    """
    _, h = await make_user("d47bkwrec")
    pid = await _proj(client, h, "D47B回收关键字")
    did = await _def(client, h, pid, "回收目标", with_request=True)
    await _def(client, h, pid, "回收留下")
    d = await client.post(f"/api/v1/api-definitions/{did}/delete",
                          json={"project_id": pid}, headers=h)
    assert d.status_code == 200, d.text

    assert await _names(client, h, pid, keyword="回收") == {"回收留下"}
    assert await _names(client, h, pid, keyword="回收", recycled=True) == {"回收目标"}


async def test_get_projection_carries_list_query_params(app, client, make_user) -> None:
    """[transport pin] GET 投影必须把 list 型 query 字段带到线上（本轮修好的那一条）。

    本例是**反向 pin**：上一轮它钉的是「装不下」的现状，投影修好后按约定变红，
    于是改钉「必须装得下」——两个方向都留了断言，谁退回哪边都会红。

    根因记在这儿，别再当成我们投影写错：FastAPI 见「序列注解 + 裸默认值」按**请求体**
    处理，GET 没有体，于是既不登记 query 参数也不报错，值静默停在 None。
    手写端点 `async def f(ids: list[str] | None = None)` 一模一样（实测 fastapi 0.162.7，
    且 openapi 里会凭空多出一个 requestBody）。修法 = core/service.py GET 分支给序列型
    字段包 Query()；**只包序列型**，其余 46 条 GET 端点的整份 OpenAPI 前后逐字节相同。

    要防的失效：把 `Query()` 摘掉 → module_ids 掉出参数表（第一条红），
    且重复键不再过滤（第三条红：全量 7 行照回）。
    """
    _, h = await make_user("d47btransport")
    pid = await _proj(client, h, "D47B传输层")
    ids = await _seed_tree(client, h, pid)

    op = app.openapi()["paths"]["/api/v1/api-definitions"]["get"]
    param_names = {p["name"] for p in op.get("parameters", [])}
    assert "keyword" in param_names, "keyword 是标量，历来装得下——它不在才是新坏的消息"
    assert "module_ids" in param_names, \
        "list 查询参数又掉出参数表了：core/service.py GET 分支的 Query() 包装被摘掉了"
    # 幽灵请求体：序列字段没包 Query 时 FastAPI 会给 GET 凭空挂一个 requestBody（GET 带体
    # 在很多代理/客户端上根本发不出去），它回来就是同一个 bug 的另一张脸。
    assert "requestBody" not in op, "GET 上凭空出现请求体 = 序列字段又被当成 body 了"

    r = await client.get("/api/v1/api-definitions",
                         params=[("project_id", pid), ("module_ids", ids["root"])], headers=h)
    assert r.status_code == 200, r.text
    assert {x["name"] for x in r.json()["items"]} == {"r1"}, \
        "重复键没到 handler：投影返回了全量"
