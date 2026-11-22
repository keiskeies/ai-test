"""D47-b 步 5c（后端半边）：/ui-elements 筛选下推到 SQL + 挂页码分页。

照两条已落地的模式：下推照 5894bc2（`api_definition_list` 的 module_ids/keyword），页码照
26ace02 + 姊妹刀 9698a14（`ui_case_list`）。**口径差异只有一处**：UI 树徽标至今是直属计数
（module_services._counts 的 docstring 明写「count=直属未回收元素+用例」），前端
`ownModuleIds` 也只返回选中节点自己——所以 module_ids 的语义 = 「前端把直属那一个 id 发来」，
IN 一个元素，与浏览器内存过滤**逐字等价**，徽标一行没动。子树口径是另一刀、要业主先裁。

钉的契约（编号对齐任务书）：
1. **下推等价性**（零行为改变的唯一证据）：同一份种子上，旧的浏览器本地过滤口径
   （`module_id ?? "__none"` 直属哨兵 + `name.toLowerCase().includes(kw)`，测试里用 Python
   现算）与服务端新参数逐个 id 相等。种子里放了「名字大小写不同」「名字含 % 与 _ 字面量」
   「未分类元素」三种行；「兄弟模块同名」被全项目唯一约束（uq_ui_element_project_name）
   物理禁止，钉的是最近的现实形态——**兄弟模块同关键词**（模块筛选必须把隔壁那颗踢出去），
   这是「原以为能做、实测被唯一约束改写」的一条，如实记。
2. keyword 转义：敲 % 与 _ 是字面量（复用 filters._like + ESCAPE），不许全表命中。
3. module_ids：None / [x] / [] 三种各一个绝对数字；选中模块时未分类不进来（不靠 SQL 巧合）。
4. used_by 与 total 不打架：页码模式下 used_by 仍是「本页每个元素被多少条未回收 UI 用例引用」
   （_scan_element_refs 吃的是 page.items——本页独有的风险）。
5. 页码判据：响应键恰好 {items,next_cursor} vs {items,next_cursor,total}（完整 set 相等）；
   cursor+current → 400；total 是筛完全集；total=0 键在场为 0；越界页 = 空 + 真 total；
   size=201 → 422。
6. 判据 5：绝对期望序，先自证「id 序 / 插入序 / created_at 序互不相同」的区分度
   （姊妹刀首版死在自己的种子上：插入序倒序恰好等于 id 升序——本文件的排列动手前先手核过，
   三条互异性断言仍在位，防止后人换种子时把区分度换没了）。
7. keyword 与 module_ids AND 进同一条查询，total 在两者之后算（命中 5 条只 2 条在模块里 → 2）。
8. transport pin：module_ids 是序列型 GET query 参数——用真实 HTTP 验它真到了 handler
   （5894bc2 在 core/service.py 修过这个坑，对全体 GET 端点生效；这里声明即得，不改 core）。

**为什么直插 ORM 行**（与 test_d47b_case_page.py 同款取舍）：id 由服务端 uuid4() 生成，走 HTTP
就拿不到可控 id 序，而判据 5 需要的正是「id 序 ≠ 插入序 ≠ created_at 序」这个确定的事实。
项目 / 模块 / UI 用例（used_by 的引用方）/ 回收操作全部仍走 HTTP 真建，读全部走 HTTP。
`module_ids=[]` 是唯一的 service 层读取：空列表在 query string 上表达不出来（httpx 编码成空串、
参数整个消失 → 落到 None），而 [] 与 None 的区分恰恰要钉——归属地与理由照
test_d47b_api_pushdown._svc_names（[] 只有 JSON 入参的 agent 工具入口真发得出来）。
每用例 conftest 已 TRUNCATE 全表，绝对计数才成立。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from app.core.service import build_ctx
from app.modules.ui_test import schemas
from app.modules.ui_test.element_services import ui_element_list
from app.modules.ui_test.models import STATUS_RECYCLED, UiElement

_BASE = "/api/v1"
_NOW = datetime.now(UTC).replace(microsecond=0)


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _mod(client, h, pid: str, name: str) -> str:
    r = await client.post(_BASE + "/ui-modules", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _el(session, pid: str, *, eid: str, name: str, module_id: str | None = None,
              status: str = "normal", created_at: datetime | None = None) -> str:
    """直种一行元素：id / 状态 / created_at 全由用例给定（理由见模块 docstring）。"""
    session.add(UiElement(id=eid, project_id=pid, module_id=module_id, name=name,
                          locator_type="css", locator="#x-" + eid, status=status,
                          project_public=True,
                          created_at=created_at or _NOW, updated_at=created_at or _NOW))
    await session.commit()
    return eid


async def _case_ref(client, h, pid: str, name: str, element_id: str) -> str:
    """HTTP 建一条引用 element_id 的 UI 用例（一步 click；保存门要求元素存在且未回收）。"""
    r = await client.post(_BASE + "/ui-cases", json={
        "project_id": pid, "name": name,
        "steps": [{"id": "clk1", "type": "click", "element_id": element_id}]}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _body(client, h, pid: str, **params: Any) -> dict[str, Any]:
    """HTTP 列表（200 前提断言在这里；list 值摊成重复键，走 GET 投影的 Query() 承载）。"""
    qs: list[tuple[str, str]] = []
    for k, v in params.items():
        if isinstance(v, list):
            qs += [(k, str(x)) for x in v]
        elif isinstance(v, bool):
            qs.append((k, "true" if v else "false"))
        else:
            qs.append((k, str(v)))
    r = await client.get(_BASE + "/ui-elements", params=[("project_id", pid), *qs], headers=h)
    assert r.status_code == 200, "HTTP 面预期 200：" + str(r.status_code) + r.text
    return r.json()


def _old_browser_filter(rows: list[dict[str, Any]], *, sub: set[str] | None = None,
                        kw: str | None = None) -> list[str]:
    """旧浏览器口径的**现算复刻**（web/src/pages/uiElements.tsx:108-112 那两行 filter）：
    模块 = `module_id ?? "__none"` 落进 sub（UI 树口径：ownModuleIds 只含选中节点自己）；
    关键词 = `name.toLowerCase().includes(kw)`（kw 传调用方已 trim 的词，全空白在外层判）。
    选「未分类」在旧页是 sub={"__none"}（树侧栏把哨兵当节点 id），等价于新参数
    unfiled_only=true——这一路本来就在 SQL 里，这里进矩阵只为钉「两路组合仍等价」。"""
    out = []
    for r in rows:
        sentinel = r["module_id"] if r["module_id"] is not None else "__none"
        if sub is not None and sentinel not in sub:
            continue
        if kw is not None and kw not in r["name"].lower():
            continue
        out.append(r["id"])
    return sorted(out)


# ══════════ 1. 下推等价性：旧本地口径 vs 新服务端参数，逐 id 相等 ══════════

async def test_pushdown_matches_the_old_browser_filter(client, session, make_user) -> None:
    """矩阵里每一格：Python 现算的旧口径 id 列表 == 新参数走 HTTP 的 id 列表。

    四种行都在种子里（用例先自证）：大小写不同（登录Button / button登录2）、含 % 字面量
    （50%折扣）、含 _ 字面量（a_b提交 + 大小写变体 A_B + 通配符陷阱 axb提交）、未分类
    （孤儿元素）；「兄弟模块同关键词」（兄弟关键字 在 mB 与 mC 各一行）。
    新参数任何一路多捞/少捞（摘转义 → axb 混进 a_b；摘 IN → mB 格多出 mC 的行；
    摘 keyword → button 格变全量）都会让对应格子红。
    """
    _, h = await make_user("d475celqe", admin=True)
    pid = await _proj(client, h, "D475c等价")
    ma = await _mod(client, h, pid, "mA")
    mb = await _mod(client, h, pid, "mB")
    mc = await _mod(client, h, pid, "mC")
    await _el(session, pid, eid="eq-a", name="登录Button", module_id=ma)
    await _el(session, pid, eid="eq-b", name="button登录2", module_id=ma)
    await _el(session, pid, eid="eq-i", name="A_B", module_id=ma)
    await _el(session, pid, eid="eq-c", name="50%折扣", module_id=mb)
    await _el(session, pid, eid="eq-d", name="a_b提交", module_id=mb)
    await _el(session, pid, eid="eq-g", name="兄弟关键字", module_id=mb)
    await _el(session, pid, eid="eq-e", name="axb提交", module_id=mc)
    await _el(session, pid, eid="eq-f", name="兄弟关键字2", module_id=mc)
    await _el(session, pid, eid="eq-h", name="孤儿元素")  # module_id IS NULL（未分类）
    await _el(session, pid, eid="eq-j", name="button回收", status=STATUS_RECYCLED)

    base = (await _body(client, h, pid, size=200))["items"]
    # 种子区分度自证：四类行缺一种，等价矩阵就少一类靶子
    assert any("%" in r["name"] for r in base) and any("_" in r["name"] for r in base)
    assert any(r["module_id"] is None for r in base)
    assert [r["module_id"] for r in base if r["name"].startswith("兄弟")].count(mb) == 1
    assert any(r["name"] == "axb提交" for r in base), "通配符陷阱行没进种子，转义那格白测"
    assert len(base) == 9, "基础行集不是 9（回收行不该出现）：" + str(len(base))

    matrix: list[tuple[str, dict[str, Any], set[str] | None, str | None]] = [
        ("模块mA", {"module_ids": [ma]}, {ma}, None),
        ("模块mB", {"module_ids": [mb]}, {mb}, None),
        ("关键词button小写", {"keyword": "button"}, None, "button"),
        ("关键词BUTTON大写", {"keyword": "BUTTON"}, None, "button"),
        ("模块mA×关键词button", {"module_ids": [ma], "keyword": "button"}, {ma}, "button"),
        ("模块mB×关键词button（交集空）", {"module_ids": [mb], "keyword": "button"}, {mb}, "button"),
        ("关键词a_b字面量", {"keyword": "a_b"}, None, "a_b"),
        ("关键词%字面量", {"keyword": "%"}, None, "%"),
        ("模块mB×关键词%", {"module_ids": [mb], "keyword": "%"}, {mb}, "%"),
        ("关键词兄弟跨模块", {"keyword": "兄弟"}, None, "兄弟"),
        ("模块mB×关键词兄弟踢掉mC", {"module_ids": [mb], "keyword": "兄弟"}, {mb}, "兄弟"),
        ("未分类哨兵", {"unfiled_only": True}, {"__none"}, None),
        ("两端空白被trim", {"keyword": "  button  "}, None, "button"),
        ("什么都没筛", {}, None, None),
    ]
    for label, params, sub, kw in matrix:
        old = _old_browser_filter(base, sub=sub, kw=kw)
        new = sorted(x["id"] for x in (await _body(client, h, pid, size=200, **params))["items"])
        assert new == old, "「" + label + "」旧口径=" + str(old) + " 服务端=" + str(new)
    # 非退化自证：矩阵不是全空格子（button/a_b/兄弟 格必须有行，否则「相等」是巧合）
    assert _old_browser_filter(base, kw="button") == ["eq-a", "eq-b"]
    assert _old_browser_filter(base, kw="a_b") == ["eq-d", "eq-i"]
    assert _old_browser_filter(base, kw="兄弟") == ["eq-f", "eq-g"]


# ══════════ 2. 转义专例 ══════════

async def test_keyword_escapes_percent_and_underscore(client, session, make_user) -> None:
    """敲 % 只中名字真含 % 的那条；a_b 不许捞 axb（摘 _like 转义这两条必红）。"""
    _, h = await make_user("d475cesc", admin=True)
    pid = await _proj(client, h, "D475c转义")
    await _el(session, pid, eid="es-1", name="50%折扣")
    await _el(session, pid, eid="es-2", name="a_b提交")
    await _el(session, pid, eid="es-3", name="axb提交")
    await _el(session, pid, eid="es-4", name="plain")

    async def _ids(**p: Any) -> list[str]:
        return sorted(x["id"] for x in (await _body(client, h, pid, size=200, **p))["items"])

    assert await _ids(keyword="%") == ["es-1"], "% 当通配符就是全表命中"
    assert await _ids(keyword="a_b") == ["es-2"], "_ 当通配符就会把 axb 也捞进来"
    assert await _ids(keyword="a\\b") == [], "反斜杠也是字面量（库里没人叫这个）"
    assert await _ids(keyword="   ") == await _ids(), "全空白 = 没筛选（清空框和敲空格同一件事）"


# ══════════ 3. module_ids 三态 ══════════

async def test_module_ids_none_single_empty_are_distinguishable(client, session, make_user) -> None:
    """None / [x] / [] 各钉一个绝对数：4 / 2 / 0；选中模块时未分类不进来（专例钉，不靠巧合）。"""
    u, h = await make_user("d475cmid", admin=True)
    pid = await _proj(client, h, "D475c三态")
    mx = await _mod(client, h, pid, "选中模块")
    await _el(session, pid, eid="ms-1", name="甲", module_id=mx)
    await _el(session, pid, eid="ms-2", name="乙", module_id=mx)
    await _el(session, pid, eid="ms-3", name="丙")  # 未分类
    await _el(session, pid, eid="ms-4", name="丁")  # 未分类

    none_ids = sorted(x["id"] for x in (await _body(client, h, pid, size=200))["items"])
    assert none_ids == ["ms-1", "ms-2", "ms-3", "ms-4"], "None 必须等于不加这一路"

    one = await _body(client, h, pid, size=200, module_ids=[mx])
    assert sorted(x["id"] for x in one["items"]) == ["ms-1", "ms-2"]
    # 「选中某模块时未分类元素不进来」——任务书点名的那条，单独钉死：
    # 未分类在树上叫 "__none"，它永不是真模块 id，IN 之下 NULL 行必须缺席。
    assert not any(x["module_id"] is None for x in one["items"]), \
        "未分类元素混进了选中模块的列表：" + str(one["items"])

    # [] 只能从 service 层钉：空列表在 query string 上表达不出来（模块 docstring）。
    ctx = await build_ctx(session, u, {"project_id": pid}, entry="http")
    empty = await ui_element_list(schemas.UiElementListIn(project_id=pid, module_ids=[]), ctx)
    assert [x.id for x in empty.items] == [], "[] 被当成了没筛选（含未分类行也不许漏）：" + str(
        [x.id for x in empty.items])
    full = await ui_element_list(schemas.UiElementListIn(project_id=pid), ctx)
    assert len(full.items) == 4, "None 与 [] 不可区分 = 两态混同"


# ══════════ 4. used_by 与 total 不打架（页码模式，本页独有） ══════════

async def test_used_by_is_per_page_under_pagination(client, session, make_user) -> None:
    """used_by 必须仍是「本页每个元素被多少条未回收用例引用」，不是全集口径。

    种子：p1..p5 五个元素；两条未回收用例引用 p2、一条引用 p4、再一条引用 p4 但**已回收**
    （回收不算引用，既有纪律原地复验在页码模式下仍成立）。size=2 翻两页：
    页1 = p1(0), p2(2)；页2 = p3(0), p4(1)——p4 的回收引用者不许出现，p1/p3 的 0 不许
    被全项目合计顶掉。total 恒 5，与任何一格 used_by 都不同。
    变异（.tmp-mut/mut5c.py M10 一族）：① used_by 换成全项目引用合计 → 本例页1 起就错位；
    ② items 换成全集（不 OFFSET）→ id/used_by 配对全错（与 M6 同手）。
    任务书单列的「_scan_element_refs 改吃全集」（把入参换成全项目元素 id）**按字面跑是等价
    变异**：出参只读 used.get(本页行.id)，字典多出的键不可观察——如实记等价，不硬凑 KILLED。
    """
    _, h = await make_user("d475cub", admin=True)
    pid = await _proj(client, h, "D475c引用列")
    for i in range(1, 6):
        await _el(session, pid, eid=f"pg-{i}", name=f"元素{i}")
    await _case_ref(client, h, pid, "引用甲", "pg-2")
    await _case_ref(client, h, pid, "引用乙", "pg-2")
    await _case_ref(client, h, pid, "引用丙", "pg-4")
    recycled_ref = await _case_ref(client, h, pid, "引用丁回收", "pg-4")
    d = await client.post(_BASE + "/ui-cases/" + recycled_ref + "/delete",
                          json={"project_id": pid}, headers=h)
    assert d.status_code == 200, d.text

    p1 = await _body(client, h, pid, current=1, size=2)
    p2 = await _body(client, h, pid, current=2, size=2)
    assert p1["total"] == 5 and p2["total"] == 5
    assert [(x["id"], x["used_by"]) for x in p1["items"]] == [("pg-1", 0), ("pg-2", 2)], \
        "页1 的 used_by 配对错了：" + str(p1["items"])
    assert [(x["id"], x["used_by"]) for x in p2["items"]] == [("pg-3", 0), ("pg-4", 1)], \
        "页2 的 used_by 配对错了（回收引用者不许计数）：" + str(p2["items"])
    assert p1["total"] not in {0, 1, 2}, "total 与 used_by 撞数，本例失去区分度"


# ══════════ 5. 页码判据：形状 / 互斥 / total 绝对数 / 越界 / 422 ══════════

async def test_page_mode_wire_shape_and_dual_param_400(client, session, make_user) -> None:
    """键集恰好 {items,next_cursor}（首页+续页各钉一次）；页码恰好 {items,next_cursor,total}
    且 next_cursor is None；cursor+current → 400 bad_request；size=201 → 422 不钳位。"""
    _, h = await make_user("d475cwire", admin=True)
    pid = await _proj(client, h, "D475c形状")
    for i in range(3):
        await _el(session, pid, eid=f"wr-{i}", name=f"形状{i}")

    body = await _body(client, h, pid, size=2)
    assert set(body) == {"items", "next_cursor"}, "首页多了/少了键就是改契约：" + str(sorted(body))
    assert body["next_cursor"], "3 行 / size=2 应有下一页"
    nxt = await _body(client, h, pid, size=2, cursor=body["next_cursor"])
    assert set(nxt) == {"items", "next_cursor"}, "游标续页形状变了：" + str(sorted(nxt))

    paged = await _body(client, h, pid, size=10, current=1)
    assert set(paged) == {"items", "next_cursor", "total"}, \
        "页码模式必须带 total（页脚的唯一真相来源）：" + str(sorted(paged))
    assert paged["next_cursor"] is None, "页码模式不产游标，否则就是两套真相并存"

    both = await client.get(_BASE + "/ui-elements", params={
        "project_id": pid, "size": 2, "cursor": body["next_cursor"], "current": 2}, headers=h)
    assert both.status_code == 400, "cursor 与 current 同时到场必须大声报错：" + both.text
    assert both.json()["code"] == "bad_request"

    over = await client.get(_BASE + "/ui-elements",
                            params={"project_id": pid, "size": 201, "current": 1}, headers=h)
    assert over.status_code == 422, "size 越界是 422，不是悄悄钳到 200：" + over.text


async def test_total_counts_filtered_set_across_three_filters(client, session, make_user) -> None:
    """total 数 WHERE 筛完全集：模块=3 / 关键词=4 / 回收站=5 / 不筛=6 / 表里 11 行，
    五个数互不相等，「本页 len=2」也咬不进任何一个空子。total=0 键在场为 0。"""
    _, h = await make_user("d475ctot", admin=True)
    pid = await _proj(client, h, "D475c计数")
    mx = await _mod(client, h, pid, "计数模块")
    my = await _mod(client, h, pid, "旁支模块")
    for i, nm in enumerate(["计数一X", "计数二X", "计数三X"]):
        await _el(session, pid, eid=f"tc-x{i}", name=nm, module_id=mx)
    await _el(session, pid, eid="tc-y0", name="计数四Y", module_id=my)
    await _el(session, pid, eid="tc-u0", name="孤立甲")
    await _el(session, pid, eid="tc-u1", name="孤立乙")
    for i in range(5):
        await _el(session, pid, eid=f"tc-r{i}", name=f"回收{i}", status=STATUS_RECYCLED)

    allp = await _body(client, h, pid, current=1, size=2)
    assert allp["total"] == 6, "不筛（normal 视图）total 应为 6：" + str(allp["total"])
    assert len(allp["items"]) == 2, "本页仍是 size=2（total 不是本页行数）"
    modp = await _body(client, h, pid, current=1, size=2, module_ids=[mx])
    assert modp["total"] == 3, "module_ids 筛选 total 应为 3：" + str(modp["total"])
    kwp = await _body(client, h, pid, current=1, size=2, keyword="计数")
    assert kwp["total"] == 4, "keyword 筛选 total 应为 4（回收站里的同名不许混进来）：" + str(kwp["total"])
    binp = await _body(client, h, pid, current=1, size=2, recycled=True)
    assert binp["total"] == 5, "回收站视图 total 应为 5：" + str(binp["total"])
    assert allp["total"] != modp["total"] != kwp["total"] != binp["total"]
    zero = await _body(client, h, pid, current=1, size=2, module_ids=["不存在"])
    assert "total" in zero, "total=0 不许被 falsy 判断吞成没有这个键"
    assert zero["total"] == 0 and zero["items"] == []
    past = await _body(client, h, pid, current=9, size=2)
    assert past["items"] == [] and past["total"] == 6, "越过末页 = 空 items + 真 total，不是 500"


# ══════════ 6. 判据 5：绝对期望序 ══════════

async def test_page_walks_the_absolute_id_order(client, session, make_user) -> None:
    """页码逐页拼接必须逐位 = id 升序。先自证三种「答案」互不相同再钉。

    id 字典序 a<b<k<m<q<z；插入序 z,m,q,a,k,b；created_at（老→新）m,a,z,k,q,b。
    三条互异性断言逐条在位（姊妹刀的教训：自证红在自己的种子上=自证有效；这里先手核过）。
    """
    _, h = await make_user("d475cord", admin=True)
    pid = await _proj(client, h, "D475c时序")
    plan = [("el-z", 4), ("el-m", 1), ("el-q", 8), ("el-a", 3), ("el-k", 5), ("el-b", 9)]
    inserted = [d for d, _ in plan]
    for cid, back in plan:
        await _el(session, pid, eid=cid, name="序" + cid, created_at=_NOW - timedelta(days=back))

    expected = sorted(inserted)
    by_time_asc = [d for d, _ in sorted(plan, key=lambda x: x[1])]
    assert expected != inserted, "种子没有区分度（id 序 == 插入序），本例白测"
    assert expected != list(reversed(inserted)), "种子没有区分度（id 序 == 插入序倒序），本例白测"
    assert expected != by_time_asc, "种子没有区分度（id 序 == created_at 升序），本例白测"

    paged: list[str] = []
    for current in (1, 2, 3):
        body = await _body(client, h, pid, size=2, current=current)
        assert body["total"] == 6, "每一页的 total 都恒等于全集条数"
        paged.extend(x["id"] for x in body["items"])
    assert len(paged) == len(set(paged)) == 6, "页与页重叠或漏行 = OFFSET 没生效：" + str(paged)
    assert paged == expected, "页码走出的序必须就是 id 升序：" + str(paged)

    walked: list[str] = []
    cursor: str | None = None
    for _ in range(8):
        b = await _body(client, h, pid, size=2) if cursor is None else \
            await _body(client, h, pid, size=2, cursor=cursor)
        walked.extend(x["id"] for x in b["items"])
        cursor = b["next_cursor"]
        if cursor is None:
            break
    assert walked == expected, "游标走出的序与绝对期望序不同：" + str(walked)


# ══════════ 7. keyword × module_ids 的 AND 与 total 次序 ══════════

async def test_keyword_and_module_and_together_total_after_both(client, session, make_user) -> None:
    """关键词命中 5 条、其中 2 条在选中模块 → 组合筛选 total==2、items 就是那 2 条。

    抓什么：keyword 分支写成 elif module_ids（两路只走一路 → total 变 5 或 3）、
    total 在 keyword 之前数（→ 3）、摘掉任一路谓词（→ 3 或 5）。三个数互不相同。
    """
    _, h = await make_user("d475cand", admin=True)
    pid = await _proj(client, h, "D475c三路")
    mx = await _mod(client, h, pid, "甲模块")
    my = await _mod(client, h, pid, "乙模块")
    await _el(session, pid, eid="an-1", name="kw在甲一", module_id=mx)
    await _el(session, pid, eid="an-2", name="kw在甲二", module_id=mx)
    await _el(session, pid, eid="an-3", name="不中在甲", module_id=mx)
    await _el(session, pid, eid="an-4", name="kw在乙一", module_id=my)
    await _el(session, pid, eid="an-5", name="kw在乙二", module_id=my)
    await _el(session, pid, eid="an-6", name="kw在乙三", module_id=my)

    kwp = await _body(client, h, pid, current=1, size=10, keyword="kw")
    assert kwp["total"] == 5, "只筛关键词 total 应为 5：" + str(kwp["total"])
    modp = await _body(client, h, pid, current=1, size=10, module_ids=[mx])
    assert modp["total"] == 3, "只筛模块 total 应为 3：" + str(modp["total"])
    both = await _body(client, h, pid, current=1, size=10, module_ids=[mx], keyword="kw")
    assert both["total"] == 2, "两路 AND 之后 total 应为 2（total 在两者之后数）：" + str(both["total"])
    assert sorted(x["id"] for x in both["items"]) == ["an-1", "an-2"]


# ══════════ 8. transport pin：序列参数真到 handler ══════════

async def test_get_projection_carries_new_query_params(app, client, session, make_user) -> None:
    """[transport pin] keyword/module_ids/current 三个新参数必须真到 handler（真实 HTTP）。

    module_ids 是序列型 GET query——5894bc2 修掉的坑在这里同款复验：FastAPI 见
    「序列注解 + 裸默认值」按请求体处理，GET 没有体就既不登记 query 参数也不报错。
    修复住在 core/service.py 的 GET 分支（对全体 GET 端点生效），本刀只声明字段；
    这条用例防的是「声明写了、传输层哪天回退，参数静默停在 None」——直调 handler 验不出来，
    必须走真实 HTTP。
    """
    _, h = await make_user("d475cxfer", admin=True)
    pid = await _proj(client, h, "D475c传输")
    mx = await _mod(client, h, pid, "甲模块")
    await _el(session, pid, eid="tr-1", name="甲行", module_id=mx)
    await _el(session, pid, eid="tr-2", name="乙行")

    op = app.openapi()["paths"]["/api/v1/ui-elements"]["get"]
    param_names = {p["name"] for p in op.get("parameters", [])}
    for name in ("keyword", "module_ids", "current"):
        assert name in param_names, name + " 没进 GET 参数表：序列字段的 Query() 包装或声明被摘了"
    assert "requestBody" not in op, "GET 上凭空出现请求体 = 序列字段又被当成 body 了"

    r = await client.get(_BASE + "/ui-elements",
                         params=[("project_id", pid), ("module_ids", mx)], headers=h)
    assert r.status_code == 200, r.text
    assert [x["id"] for x in r.json()["items"]] == ["tr-1"], \
        "重复键没到 handler：返回了全量（参数静默停在 None 的那张脸）"
    r2 = await client.get(_BASE + "/ui-elements",
                          params=[("project_id", pid), ("keyword", "甲")], headers=h)
    assert [x["id"] for x in r2.json()["items"]] == ["tr-1"], "keyword 没到 handler"
