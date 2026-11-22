"""D183 步 5 判据刀：报告明细分页（页码制）+ 快照在新读路上的重钉（§五 步 5 / §六 1·2·3·8）。

**开工前的两条裁决**（复核项，出处写死在这里）：

(a) **既有 GET /plan-reports/{report_id} 形状不动，新端点管分页。**
    步 4 的中心用例 `test_snapshot_payload_is_byte_identical_after_everything` 断言两次
    HTTP body 逐字节相等、多条用例在 create/get 回执上索引 items[0]/[1]——给旧端点塞
    current/size 是拿判据 2 的中心证据换便利。`test_..._endpoint_shape_is_the_ruling`
    把「详情入参恰好 project_id/report_id 两键（无 current/size）」钉成静态断言，
    行为面由步 4 的逐字节用例继续守。
(b) **通过率口径不新增任何东西**：`_rates` 是步 3 唯一算式、步 4 报告逐字复用，
    「未执行拉低 / 执行率不早到 1.0 / 空计划 0.0」已钉在 test_d183_plan_status.py 与
    test_d183_plan_reports.py。本文件对率的唯一新贡献 = 分页行与详情行、详情与实时态
    全部出自同一份算式与同一份谓词（第 2 条用例），不开第二份算式。

钉的契约（一条判断一条用例）：

1. **页码语义 = plan_report_list 同尺的 D47-b 全套**（page...）：先自证种子有区分度、
   绝对期望序（link_id 升序，走页拼出的序逐位 = sorted 种子）、total 恒全集、
   越界页空 items、size/current 越界 422、报告不存在 404、next_cursor 恒 None。
2. **窗口与全量同源**（windows_equal_detail...）：逐页走出的明细与详情 payload 的 items
   逐行逐键相等——序的同源由 services._report_item_stmt 一份语句兑现，这条是它的行为面
   （两份 where/order_by = 「同一条明细在两个端点顺序不同」的产房）。
3. **快照语义跟着新读路走**（rows_are_snapshot...）：分页读的是存量副本——生成后再执行
   N 次，分页 payload 逐字节不动；前置同时钉实时态确实动了（否则「不动」是假证据）。
   「分页读路径改成现算」是变异自证点名要杀的形状。
4. **project_id 谓词的现行犯在分页路上同样在场**（own_project...）：毒行（同 report_id
   异 project_id）不进窗口、不进 total，且库里原样在场（读路只排除，不删除）。
5. **跨项目与不存在逐字同 404**（cross_project...）。
6. **位名守护不走矩阵走自建角色**（perm_gate...）：把角色限在 env:config:read 上，
   403 的 details.perm 自己报出 testplan:report:read（矩阵行只守通过/拒绝形状，
   第六十轮 §二）；READONLY 放行 = 复用 :read 位的正面证明。
7. **形状裁决静态面**（shape...）：PlanReportGetIn 无分页字段；新服务的位是**复用**的
   testplan:report:read（不注册没人实现的位，判据 1 用在权限面）；报告族五个服务的
   位名映射逐条钉死。

**DB 断言走 _db_*（另开连接）**：conftest 把 get_db 绑在共享连接上、GET 端点无
commit/rollback，悬挂只读事务会让后续 4xx/5xx 的 db.rollback() 抹掉已返回 201 的写
（步 4 文件 _db_scalar docstring 实测在案，此处同纪律）。
"""
from __future__ import annotations

from app.modules.api_test.models import ApiCase
from app.modules.execution.models import RunRecord
from app.modules.testplan.models import PlanCaseLink

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _create_plan(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _seed_subject(session, pid: str, *, row_id: str) -> None:
    session.add(ApiCase(id=row_id, project_id=pid, definition_id="seed-def", name="用例" + row_id))
    await session.commit()


async def _seed_link(session, pid: str, plan_id: str, *, row_id: str, subject_id: str) -> None:
    session.add(PlanCaseLink(id=row_id, project_id=pid, plan_id=plan_id, subject_type="api_case",
                             subject_id=subject_id, subject_name="名" + subject_id))
    await session.commit()


async def _seed_run(session, pid: str, subject_id: str, status: str) -> None:
    session.add(RunRecord(project_id=pid, subject_type="api_case", subject_id=subject_id,
                          subject_name="r", trigger="manual", status=status))
    await session.commit()


async def _gen(client, h, pid: str, plan_id: str):
    return await client.post(_BASE + f"/plans/{plan_id}/reports", json={"project_id": pid}, headers=h)


async def _get(client, h, pid: str, report_id: str):
    return await client.get(_BASE + f"/plan-reports/{report_id}", params={"project_id": pid}, headers=h)


async def _page(client, h, pid: str, report_id: str, **params):
    q = {"project_id": pid, **params}
    return await client.get(_BASE + f"/plan-reports/{report_id}/items", params=q, headers=h)


async def _status(client, h, pid: str, plan_id: str):
    return await client.get(_BASE + f"/plans/{plan_id}/status", params={"project_id": pid}, headers=h)


async def _db_scalar(sql: str, **params):
    """从**另一条连接**读已提交状态——理由逐字同 test_d183_plan_reports._db_scalar
    （悬挂只读事务 × 4xx/5xx 回滚会抹掉测试自己的写；判据要的本来就是跨连接可见状态）。"""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    from app.core.config import get_settings

    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    try:
        async with eng.connect() as c:
            return (await c.execute(text(sql), params)).scalar_one()
    finally:
        await eng.dispose()


async def _count(tbl: str, where: str, **params) -> int:
    return int(await _db_scalar("SELECT COUNT(*) FROM " + tbl + " WHERE " + where, **params))


# ══════════ 1. 页码语义（D47-b 全套，plan_report_list 同尺） ══════════

async def test_item_page_walks_link_id_order_and_total_is_whole_set(client, session, make_user) -> None:
    """五种越界/边界形状一条钉死：keys / next_cursor / 走页序 / total 恒全集 /
    越界页 / 422 / 不存在 404。明细 id 是 uuid4（生成服务写的），所以**序的靶 = 可控的
    link_id**：这正是明细的绝对期望序键（_report_item_stmt），报告与实时态对齐的同一个序。"""
    boss, hb = await make_user("d183s5o", admin=True)
    pid = await _proj(client, hb, "D183明细分页")
    pl = await _create_plan(client, hb, pid, "分页计划")
    link_ids = ["s5-ec", "s5-ea", "s5-ee", "s5-eb", "s5-ed"]
    assert sorted(link_ids) != link_ids, "种子没有区分度（插入序==期望序），排序断言是假的"
    for lid in link_ids:
        sid = "s5-sub-" + lid
        await _seed_subject(session, pid, row_id=sid)
        await _seed_link(session, pid, pl["id"], row_id=lid, subject_id=sid)
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]

    r = await _page(client, hb, pid, rid, current=1, size=2)
    assert r.status_code == 200, r.text
    b = r.json()
    assert set(b) == {"items", "next_cursor", "total"}
    assert b["next_cursor"] is None, "页码制端点回游标 = 对「我在哪」给两套真相（D47-b 裁决）"
    assert b["total"] == 5
    assert [x["link_id"] for x in b["items"]] == ["s5-ea", "s5-eb"], "第一页不是 link_id 升序前两条"
    walk: list[str] = []
    for cur in (1, 2, 3):
        bb = (await _page(client, hb, pid, rid, current=cur, size=2)).json()
        assert bb["total"] == 5, "total 数了本页或数漏了：" + str(bb["total"])
        walk += [x["link_id"] for x in bb["items"]]
    assert walk == sorted(link_ids), "逐页走出的序必须逐位 = link_id 升序：" + str(walk)
    past = (await _page(client, hb, pid, rid, current=9, size=2)).json()
    assert past["items"] == [] and past["total"] == 5, "越界页要空 items 但 total 照实"
    s1 = await _page(client, hb, pid, rid, size=201)
    assert s1.status_code == 422, "size 越界必须 422（夹取在 paginate_page，入参先闸）"
    c0 = await _page(client, hb, pid, rid, current=0)
    assert c0.status_code == 422
    nf = await _page(client, hb, pid, "查无此报告")
    assert nf.status_code == 404 and nf.json()["message"] == "报告不存在"


# ══════════ 2. 窗口与全量同源（一份语句 = 同一个序的行为面） ══════════

async def test_item_page_windows_equal_detail_items(client, session, make_user) -> None:
    """逐页拼出的 items 与详情 payload 的 items **逐行逐键相等**（含默认页与 size=1）。

    这条红 = 有人给两条读路各写了一份 where/order_by（谓词/序分叉），或详情端点被改了
    形状。「同源」的实现是 services._report_item_stmt 一份语句被 _report_items 与
    plan_report_item_list 共用——行为面在这，不在 docstring 里。
    """
    boss, hb = await make_user("d183s5w", admin=True)
    pid = await _proj(client, hb, "D183窗口同源")
    pl = await _create_plan(client, hb, pid, "同源计划")
    for lid in ("s5w-a", "s5w-b", "s5w-c", "s5w-d"):
        sid = "s5w-sub-" + lid
        await _seed_subject(session, pid, row_id=sid)
        await _seed_link(session, pid, pl["id"], row_id=lid, subject_id=sid)
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]
    detail = (await _get(client, hb, pid, rid)).json()["items"]

    for size in (1, 2, 3, 4, 8):
        walk: list[dict] = []
        cur = 1
        while True:
            bb = (await _page(client, hb, pid, rid, current=cur, size=size)).json()
            if not bb["items"]:
                break
            walk += bb["items"]
            cur += 1
        assert walk == detail, f"size={size} 走页拼出的明细 != 详情 items（谓词/序分叉）"
    # 默认参数（不带 current/size）= 第一页全量：与详情 items 同样相等
    default_page = (await _page(client, hb, pid, rid)).json()
    assert default_page["total"] == 4 and default_page["items"] == detail


# ══════════ 3. 分页路上快照语义同样成立（读路径零现算） ══════════

async def test_item_page_rows_are_snapshot_too(client, session, make_user) -> None:
    """生成后再执行 N 次：**分页 payload 逐字节不动**，实时态确实动了（前置反假证据）。

    判据 2 钉的是「快照」这个语义，不是某个端点形状——新读路若 join run_record 现算，
    窗口里的 result/executed 会跟着新世界漂，这条当场红（变异 M-S3 就是改成现算）。
    """
    boss, hb = await make_user("d183s5s", admin=True)
    pid = await _proj(client, hb, "D183分页快照")
    pl = await _create_plan(client, hb, pid, "快照分页")
    for lid, run in (("s5s-la", "passed"), ("s5s-lb", None)):
        sid = "s5s-sub-" + lid
        await _seed_subject(session, pid, row_id=sid)
        await _seed_link(session, pid, pl["id"], row_id=lid, subject_id=sid)
        if run is not None:
            await _seed_run(session, pid, sid, run)
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]
    p1 = await _page(client, hb, pid, rid)
    assert p1.status_code == 200
    assert [(x["link_id"], x["result"]) for x in p1.json()["items"]] == [("s5s-la", "passed"), ("s5s-lb", "none")]

    # 新世界：b 跑出 failed、a 追加 error（终态混合 → 保守 failed）
    await _seed_run(session, pid, "s5s-sub-s5s-lb", "failed")
    await _seed_run(session, pid, "s5s-sub-s5s-la", "error")
    now = (await _status(client, hb, pid, pl["id"])).json()
    assert (now["failed"], now["pass_rate"]) == (2, 0.0), \
        "前置：实时态必须确实动了，否则『分页没动』是假证据：" + str(now)

    p2 = await _page(client, hb, pid, rid)
    assert p2.content == p1.content, \
        "分页读路径跟着新世界漂了——窗口读的是存量副本，不是现算（判据 2）"


# ══════════ 4. project_id 谓词的现行犯在分页路上 ══════════

async def test_item_page_reads_only_own_project_items(client, session, make_user) -> None:
    """毒行（同 report_id、异 project_id）不进窗口、**也不进 total**，库里原样在场。

    total 是页脚数字——谓词漏了它比漏 items 更会说谎（页脚说 2、窗口只有 1 条，
    翻到第二页发现是空页）。共用语句 ⇒ 一处谓词两路都守住，这条钉的就是「两路」。
    """
    boss, hb = await make_user("d183s5p", admin=True)
    pid = await _proj(client, hb, "D183分页谓词甲")
    p2 = await _proj(client, hb, "D183分页谓词乙")
    pl = await _create_plan(client, hb, pid, "谓词计划")
    await _seed_subject(session, pid, row_id="s5p-sub")
    await _seed_link(session, pid, pl["id"], row_id="s5p-l1", subject_id="s5p-sub")
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]
    from app.modules.testplan.models import PlanReportItem

    session.add(PlanReportItem(id="s5p-poison", project_id=p2, report_id=rid,
                               link_id="s5-poison-link", subject_type="api_case",
                               subject_id="s5p-sub", subject_name="毒行",
                               executed=True, executing=False, result="passed"))
    await session.commit()

    b = (await _page(client, hb, pid, rid, size=200)).json()
    assert [x["link_id"] for x in b["items"]] == ["s5p-l1"], \
        "毒行进窗口（=_report_item_stmt 没按 project_id 排除）：" + str(b["items"])
    assert b["total"] == 1, "毒行进 total = 页脚说谎：" + str(b["total"])
    assert await _count("plan_report_item", "report_id=:r", r=rid) == 2, \
        "读路径只做排除，毒行必须原样在场"


# ══════════ 5. 跨项目与不存在逐字同 404 ══════════

async def test_item_page_cross_project_verbatim(client, session, make_user) -> None:
    boss, hb = await make_user("d183s5x", admin=True)
    pid = await _proj(client, hb, "D183分页甲")
    p2 = await _proj(client, hb, "D183分页乙")
    pl = await _create_plan(client, hb, pid, "甲的报告")
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]
    _, ho = await make_user("d183s5xb", admin=True)
    absent = await _page(client, ho, p2, "查无此报告")
    invade = await _page(client, ho, p2, rid)
    assert absent.status_code == 404 and invade.status_code == 404
    assert invade.json()["code"] == absent.json()["code"] == "not_found"
    assert invade.json()["message"] == absent.json()["message"] == "报告不存在"
    assert set(invade.json()["details"]) == set(absent.json()["details"]) == {"report_id"}


# ══════════ 6. 位名守护：自建角色让 details.perm 自己报名 ══════════

async def test_item_page_perm_gate_names_the_bit_itself(client, session, make_user) -> None:
    """矩阵行证不了位名（期望从服务自己声明的位推出来，改声明四格照绿——第六十轮 §二，
    同款守护在 links/status/reports 各演一次，这是第四次）：自建角色限在 env:config:read，
    403 的 details.perm 必须**自己报出** testplan:report:read。
    READONLY 放行 = 复用 :read 位的正面证明（注册新位没人实现是判据 1 的权限面对偶病）。
    """
    boss, hb = await make_user("d183s5g", admin=True)
    pid = await _proj(client, hb, "D183分页门禁")
    pl = await _create_plan(client, hb, pid, "门禁计划")
    await _seed_subject(session, pid, row_id="s5g-sub")
    await _seed_link(session, pid, pl["id"], row_id="s5g-l1", subject_id="s5g-sub")
    rid = (await _gen(client, hb, pid, pl["id"])).json()["id"]

    rr = await client.post(_BASE + "/custom-roles",
                           json={"project_id": pid, "name": "只读环境-r5", "template_code": "READONLY"},
                           headers=hb)
    assert rr.status_code in (200, 201), rr.text
    code = rr.json()["code"]
    pr = await client.patch(_BASE + "/custom-roles/" + code,
                            json={"project_id": pid, "perms": ["env:config:read"]}, headers=hb)
    assert pr.status_code == 200, pr.text
    cu, hc = await make_user("d183s5gcu")
    await _member(client, hb, pid, cu.id, code)
    d = await _page(client, hc, pid, rid)
    assert d.status_code == 403 and d.json()["code"] == "insufficient_permission"
    assert d.json()["details"]["perm"] == "testplan:report:read", \
        "read 位被改名时这一条必须红（矩阵四格照绿，它才是守护）"

    ro, hr = await make_user("d183s5gro")
    await _member(client, hb, pid, ro.id, "READONLY")
    g = await _page(client, hr, pid, rid)
    assert g.status_code == 200 and g.json()["total"] == 1, "READONLY 该读得到分页（:read 复用位命中）"


# ══════════ 7. 形状裁决的静态面 ══════════

def test_item_page_endpoint_shape_is_the_ruling() -> None:
    """(a) 的静态半边：详情入参**没有**分页字段；分页服务复用 read 位、报告族位映射钉死。

    行为面（旧端点逐字节不变）在步 4 快照用例；这里钉「别把 current/size 塞进旧入参、
    别注册没人实现的位」这两个最容易被顺手改掉的声明面。
    """
    from app.core.registry import REGISTRY
    from app.modules.testplan import schemas

    assert set(schemas.PlanReportGetIn.model_fields) == {"project_id", "report_id"}, \
        "详情入参长出分页字段 = 旧端点形状被改（步 4 逐字节用例的契约面）：" + \
        str(sorted(schemas.PlanReportGetIn.model_fields))
    assert set(schemas.PlanReportItemListIn.model_fields) == {"project_id", "report_id", "current", "size"}
    spec = REGISTRY.get("plan_report_item_list")
    assert spec is not None, "注册表没有 plan_report_item_list"
    assert spec.perm == "testplan:report:read", \
        "分页端点必须复用 :read 位——注册一个只有读路没有实现的位是判据 1 的权限面对偶病"
    assert spec.effect == "read"
    assert spec.http is not None and spec.http["method"] == "GET" \
        and spec.http["path"] == "/plan-reports/{report_id}/items"
    bits = {n: REGISTRY.get(n).perm
            for n in ("plan_report_list", "plan_report_get", "plan_report_item_list",
                      "plan_report_create", "plan_report_delete")}
    assert bits == {"plan_report_list": "testplan:report:read",
                    "plan_report_get": "testplan:report:read",
                    "plan_report_item_list": "testplan:report:read",
                    "plan_report_create": "testplan:report:create",
                    "plan_report_delete": "testplan:report:delete"}, \
        "报告族位映射漂移（新增位/改位名要过 §5 评审与位名守护用例）：" + str(bits)
