"""D47-b 步 5a（后端半边）：/ui-cases 与 /adb-cases 接页码分页。

照抄步 4b（26ace02）的接线形状：`current` 缺席走键集老路（形状逐字节不变）、双参 400、
页码在同一条 `ORDER BY id` 上 OFFSET、出参 total=page.total。这两条端点比接口页更省事——
筛选（project / module / unfiled / recycled）本来就全在 SQL WHERE 里，没有本地过滤要下推。

两节（UI / ADB）刻意**各写各的 helper、各钉各的绝对期望序、一行不共用**：一个端点挂掉
不该波及另一个，变异自证时「只红本端点」就是这条独立性的直接证据。

钉的契约（D47-b 计划 §四 原文口径，一条不落）：
1. 游标老路响应键**恰好** {items, next_cursor}（首页与续页各钉一次，完整 dict 相等口径的
   set 比较，不是 `in`）；页码模式恰好 {items, next_cursor, total} 且 next_cursor is None。
2. cursor 与 current 同时到场 → 400 bad_request，不许静默择一。
3. total 数的是 WHERE 筛完全集：回收站视图 / 模块（或 unfiled）/ 不筛三个绝对数字，
   且表里的总行数与它们都不同；total=0 如实回 0，不被 falsy 吞键。
4. 越过末页 = 200 + 空 items + 真 total。
5. 判据 5：页码与游标共用同一条 `ORDER BY id`。种子先自证「id 序 / 插入序 / created_at 序
   三者互不相同」的区分度，再断言页码拼出的序列就是那个**绝对期望序**——不写
   「页码序 == 游标序」的套套逻辑（两制同时换键时它照样绿，步 2 踩过）。
6. size=201 → 422 不钳位。

**为什么直插 ORM 行**（本仓读侧用例的一般口径是「写走 HTTP」）：id 由服务端 `uuid4()`
生成，走 HTTP 就拿不到可控 id 序，而判据 5 需要的正是「id 序 ≠ 插入序 ≠ created_at 序」
这个确定的事实——靠随机数撞出来的是运气，不是 fixture。同款取舍见 test_d47b_api_page.py。
项目与模块仍走 HTTP 真建，读全部走 HTTP；每用例 conftest 已 TRUNCATE 全表，绝对计数才成立。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.modules.adb_test.models import STATUS_RECYCLED as ADB_RECYCLED
from app.modules.adb_test.models import AdbCase
from app.modules.ui_test.models import STATUS_RECYCLED as UI_RECYCLED
from app.modules.ui_test.models import UiCase

_BASE = "/api/v1"
_NOW = datetime.now(UTC).replace(microsecond=0)


# ── UI 用例（/ui-cases，ui_case_list：id asc；module/unfiled/recycled 过滤） ─────
# 本节 helper 全部 _ui_ 前缀、自成一套，刻意不与 ADB 节共用（独立性口径见模块 docstring）。


async def _ui_proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _ui_mod(client, h, pid: str, name: str) -> str:
    r = await client.post(_BASE + "/ui-modules", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _ui_seed(session, pid: str, *, cid: str, module_id: str | None = None,
                   status: str = "normal", created_at: datetime | None = None) -> str:
    """直种一行 UI 用例：id / 状态 / created_at 全由用例给定（理由见模块 docstring）。"""
    session.add(UiCase(id=cid, project_id=pid, module_id=module_id, name="UI用例-" + cid,
                       steps=[{"action": "click", "target": "登录按钮"}], status=status,
                       step_count=1, project_public=True,
                       created_at=created_at or _NOW, updated_at=created_at or _NOW))
    await session.commit()
    return cid


async def _ui_body(client, h, pid: str, **params) -> dict:
    r = await client.get(_BASE + "/ui-cases", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, "HTTP 面预期 200：" + str(r.status_code) + r.text
    return r.json()


async def _ui_walk(client, h, pid: str, size: int) -> list[str]:
    """游标模式从头走到尾（本端点自带一份，不与 ADB 节共用）。"""
    out: list[str] = []
    cursor: str | None = None
    for _ in range(32):
        q = {"project_id": pid, "size": size}
        if cursor:
            q["cursor"] = cursor
        r = await client.get(_BASE + "/ui-cases", params=q, headers=h)
        assert r.status_code == 200, "游标翻页中途报错：" + str(r.status_code) + r.text
        body = r.json()
        out.extend(x["id"] for x in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            return out
    raise AssertionError("游标没走完，size=" + str(size))


async def test_ui_wire_contract_keys_dual_param_and_size_cap(client, session, make_user) -> None:
    """UI：键集形状（首页 + 续页）、页码形状、双参 400、size 越界 422。

    变异自证：`_dump` 改成无条件写 total 键 → 游标两条断言红（多出 "total"）；
    摘掉 handler 互斥检查 → 双参那条红（静默走了页码支）。
    """
    u, h = await make_user("d475auiwire", admin=True)
    pid = await _ui_proj(client, h, "D475aUI契约")
    for i in range(3):
        await _ui_seed(session, pid, cid=f"ui-w-{i}")

    body = await _ui_body(client, h, pid, size=2)
    assert set(body) == {"items", "next_cursor"}, "首页多了/少了键就是改契约：" + str(sorted(body))
    assert body["next_cursor"], "3 行 / size=2 应有下一页"
    nxt = await _ui_body(client, h, pid, size=2, cursor=body["next_cursor"])
    assert set(nxt) == {"items", "next_cursor"}, "游标续页形状变了：" + str(sorted(nxt))

    paged = await _ui_body(client, h, pid, size=10, current=1)
    assert set(paged) == {"items", "next_cursor", "total"}, \
        "页码模式必须带 total（页脚的唯一真相来源）：" + str(sorted(paged))
    assert paged["next_cursor"] is None, "页码模式不产游标，否则就是两套真相并存"

    both = await client.get(_BASE + "/ui-cases", params={
        "project_id": pid, "size": 2, "cursor": body["next_cursor"], "current": 2}, headers=h)
    assert both.status_code == 400, "cursor 与 current 同时到场必须大声报错：" + both.text
    assert both.json()["code"] == "bad_request"

    over = await client.get(_BASE + "/ui-cases",
                            params={"project_id": pid, "size": 201, "current": 1}, headers=h)
    assert over.status_code == 422, "size 越界是 422，不是悄悄钳到 200：" + over.text
    assert u.id


async def test_ui_total_counts_filtered_set_not_page_or_table(client, session, make_user) -> None:
    """UI：total 数的是 WHERE 筛完全集——2（模块）/ 3（unfiled）/ 5（不筛）/ 4（回收站）/
    表里 9 行，五个数互不相等，「本页 len=2」也咬不进任何一个空子。

    另钉 total=0：module_id 命中 0 条时 total 键仍在场且为 0（falsy 判断一上页脚就整个消失）。
    """
    u, h = await make_user("d475auitotal", admin=True)
    pid = await _ui_proj(client, h, "D475aUI计数")
    mod = await _ui_mod(client, h, pid, "登录模块")
    for cid in ("ui-t-m0", "ui-t-m1"):
        await _ui_seed(session, pid, cid=cid, module_id=mod)
    for cid in ("ui-t-u0", "ui-t-u1", "ui-t-u2"):
        await _ui_seed(session, pid, cid=cid)
    for cid in ("ui-t-r0", "ui-t-r1", "ui-t-r2", "ui-t-r3"):
        await _ui_seed(session, pid, cid=cid, status=UI_RECYCLED)

    allp = await _ui_body(client, h, pid, current=1, size=2)
    assert allp["total"] == 5, "不筛（normal 视图）total 应为 5（回收站 4 行不许混进来）：" + str(allp["total"])
    assert len(allp["items"]) == 2, "本页仍是 size=2（total 不是本页行数）"

    modp = await _ui_body(client, h, pid, current=1, size=2, module_id=mod)
    assert modp["total"] == 2, "模块筛选 total 应为 2：" + str(modp["total"])

    unf = await _ui_body(client, h, pid, current=1, size=2, unfiled_only="true")
    assert unf["total"] == 3, "unfiled_only total 应为 3：" + str(unf["total"])

    binp = await _ui_body(client, h, pid, current=1, size=2, recycled="true")
    assert binp["total"] == 4, "回收站视图 total 应为 4（normal 行不许混进来）：" + str(binp["total"])

    zero = await _ui_body(client, h, pid, current=1, size=2, module_id="不存在")
    assert "total" in zero, "total=0 不许被 falsy 判断吞成没有这个键"
    assert zero["total"] == 0 and zero["items"] == []
    assert u.id


async def test_ui_page_walks_the_absolute_id_order(client, session, make_user) -> None:
    """UI 判据 5：绝对期望序 = id 升序；页码逐页拼接必须逐位命中它。

    种子（与 ADB 节刻意用不同的一套错位）：id 字典序 a < b < k < m < q < z；
    插入序 z, m, q, a, k, b；created_at 序（老→新）m, a, z, k, q, b。
    三种答案互不相同 → 「按 id」「按插入序」「按 created_at」当场可分。
    先自证区分度，再钉页码走出的就是 id 升序；游标走出的同序、页与页不重叠、越界页 200 + 空。
    """
    u, h = await make_user("d475auiorder", admin=True)
    pid = await _ui_proj(client, h, "D475aUI时序")
    plan = [("z-1", 4), ("m-2", 1), ("q-4", 8), ("a-3", 3), ("k-6", 5), ("b-5", 9)]
    inserted = [d for d, _ in plan]
    for cid, back in plan:
        await _ui_seed(session, pid, cid=cid, created_at=_NOW - timedelta(days=back))

    expected = sorted(inserted)
    by_time_asc = [d for d, _ in sorted(plan, key=lambda x: x[1])]
    assert expected != inserted, "种子没有区分度（id 序 == 插入序），本例白测"
    assert expected != list(reversed(inserted)), "种子没有区分度（id 序 == 插入序倒序），本例白测"
    assert expected != by_time_asc, "种子没有区分度（id 序 == created_at 升序），本例白测"

    paged: list[str] = []
    for current in (1, 2, 3):
        body = await _ui_body(client, h, pid, size=2, current=current)
        assert body["total"] == 6, "每一页的 total 都恒等于全集条数"
        paged.extend(x["id"] for x in body["items"])
    assert len(paged) == len(set(paged)) == 6, "页与页重叠或漏行 = OFFSET 没生效：" + str(paged)
    assert paged == expected, "页码走出的序必须就是 id 升序：" + str(paged)

    walked = await _ui_walk(client, h, pid, 2)
    assert walked == expected, "游标走出的序与绝对期望序不同：" + str(walked)

    past = await _ui_body(client, h, pid, size=2, current=9)
    assert past["items"] == [] and past["total"] == 6, "越过末页 = 空 items + 真 total，不是 500"
    assert u.id


# ── ADB 用例（/adb-cases，adb_case_list：id asc；module/unfiled/recycled 过滤） ──
# 与 UI 节同判据、不同实现：helper 与期望序各钉一套，一行不共用。


async def _adb_proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _adb_mod(client, h, pid: str, name: str) -> str:
    r = await client.post(_BASE + "/adb-modules", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _adb_seed(session, pid: str, *, cid: str, module_id: str | None = None,
                    status: str = "normal", created_at: datetime | None = None) -> str:
    session.add(AdbCase(id=cid, project_id=pid, module_id=module_id, name="ADB用例-" + cid,
                        steps=[{"action": "tap", "x": 1, "y": 2}], status=status,
                        step_count=1, project_public=True,
                        created_at=created_at or _NOW, updated_at=created_at or _NOW))
    await session.commit()
    return cid


async def _adb_body(client, h, pid: str, **params) -> dict:
    r = await client.get(_BASE + "/adb-cases", params={"project_id": pid, **params}, headers=h)
    assert r.status_code == 200, "HTTP 面预期 200：" + str(r.status_code) + r.text
    return r.json()


async def _adb_walk(client, h, pid: str, size: int) -> list[str]:
    out: list[str] = []
    cursor: str | None = None
    for _ in range(32):
        q = {"project_id": pid, "size": size}
        if cursor:
            q["cursor"] = cursor
        r = await client.get(_BASE + "/adb-cases", params=q, headers=h)
        assert r.status_code == 200, "游标翻页中途报错：" + str(r.status_code) + r.text
        body = r.json()
        out.extend(x["id"] for x in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            return out
    raise AssertionError("游标没走完，size=" + str(size))


async def test_adb_wire_contract_keys_dual_param_and_size_cap(client, session, make_user) -> None:
    """ADB：键集形状（首页 + 续页）、页码形状、双参 400、size 越界 422。

    与 UI 节同判据但各拿各的断言：摘掉 adb handler 的互斥检查只红本用例，
    ui handler 的同款摘除红不到这里（独立性口径）。
    """
    u, h = await make_user("d475aadbwire", admin=True)
    pid = await _adb_proj(client, h, "D475aADB契约")
    for i in range(3):
        await _adb_seed(session, pid, cid=f"adb-w-{i}")

    body = await _adb_body(client, h, pid, size=2)
    assert set(body) == {"items", "next_cursor"}, "首页多了/少了键就是改契约：" + str(sorted(body))
    assert body["next_cursor"], "3 行 / size=2 应有下一页"
    nxt = await _adb_body(client, h, pid, size=2, cursor=body["next_cursor"])
    assert set(nxt) == {"items", "next_cursor"}, "游标续页形状变了：" + str(sorted(nxt))

    paged = await _adb_body(client, h, pid, size=10, current=1)
    assert set(paged) == {"items", "next_cursor", "total"}, \
        "页码模式必须带 total：" + str(sorted(paged))
    assert paged["next_cursor"] is None, "页码模式不产游标"

    both = await client.get(_BASE + "/adb-cases", params={
        "project_id": pid, "size": 2, "cursor": body["next_cursor"], "current": 2}, headers=h)
    assert both.status_code == 400, "cursor 与 current 同时到场必须大声报错：" + both.text
    assert both.json()["code"] == "bad_request"

    over = await client.get(_BASE + "/adb-cases",
                            params={"project_id": pid, "size": 201, "current": 1}, headers=h)
    assert over.status_code == 422, "size 越界是 422：" + over.text
    assert u.id


async def test_adb_total_counts_filtered_set_not_page_or_table(client, session, make_user) -> None:
    """ADB：total 数 WHERE 筛完全集——3（模块）/ 2（unfiled）/ 5（不筛）/ 6（回收站）/
    表里 11 行，五个数互不相等（与 UI 节刻意错开，防「一个数恰与本页行数相同」的钝化）。

    另钉 total=0（unfiled_only 命中 0 条）：total 键在场且为 0。
    """
    u, h = await make_user("d475aadbtot", admin=True)
    pid = await _adb_proj(client, h, "D475aADB计数")
    mod = await _adb_mod(client, h, pid, "支付模块")
    pid_empty = await _adb_proj(client, h, "D475aADB空计数")
    for cid in ("adb-t-m0", "adb-t-m1", "adb-t-m2"):
        await _adb_seed(session, pid, cid=cid, module_id=mod)
    for cid in ("adb-t-u0", "adb-t-u1"):
        await _adb_seed(session, pid, cid=cid)
    for cid in ("adb-t-r0", "adb-t-r1", "adb-t-r2", "adb-t-r3", "adb-t-r4", "adb-t-r5"):
        await _adb_seed(session, pid, cid=cid, status=ADB_RECYCLED)

    allp = await _adb_body(client, h, pid, current=1, size=4)
    assert allp["total"] == 5, "不筛（normal 视图）total 应为 5（回收站 6 行不许混进来）：" + str(allp["total"])
    assert len(allp["items"]) == 4, "本页仍是 size=4（total 不是本页行数）"

    modp = await _adb_body(client, h, pid, current=1, size=4, module_id=mod)
    assert modp["total"] == 3, "模块筛选 total 应为 3：" + str(modp["total"])

    unf = await _adb_body(client, h, pid, current=1, size=4, unfiled_only="true")
    assert unf["total"] == 2, "unfiled_only total 应为 2：" + str(unf["total"])

    binp = await _adb_body(client, h, pid, current=1, size=4, recycled="true")
    assert binp["total"] == 6, "回收站视图 total 应为 6：" + str(binp["total"])

    zero = await _adb_body(client, h, pid_empty, current=1, size=4, unfiled_only="true")
    assert "total" in zero, "total=0 不许被 falsy 判断吞成没有这个键"
    assert zero["total"] == 0 and zero["items"] == []
    assert u.id


async def test_adb_page_walks_the_absolute_id_order(client, session, make_user) -> None:
    """ADB 判据 5：绝对期望序 = id 升序（错位方案与 UI 节不同的一套，各钉各的）。

    id 字典序 a < b < k < m < q < z；插入序 q, a, z, b, m, k；
    created_at 序（老→新）k, q, b, z, m, a。三种答案互不相同。
    先自证区分度，再钉页码拼接逐位 = id 升序；游标同序、页不重叠、越界页 200 + 空 items + 真 total。
    """
    u, h = await make_user("d475aadbord", admin=True)
    pid = await _adb_proj(client, h, "D475aADB时序")
    plan = [("q-4", 5), ("a-3", 8), ("z-1", 2), ("b-5", 7), ("m-2", 9), ("k-6", 1)]
    inserted = [d for d, _ in plan]
    for cid, back in plan:
        await _adb_seed(session, pid, cid=cid, created_at=_NOW - timedelta(days=back))

    expected = sorted(inserted)
    by_time_asc = [d for d, _ in sorted(plan, key=lambda x: x[1])]
    assert expected != inserted, "种子没有区分度（id 序 == 插入序），本例白测"
    assert expected != list(reversed(inserted)), "种子没有区分度（id 序 == 插入序倒序），本例白测"
    assert expected != by_time_asc, "种子没有区分度（id 序 == created_at 升序），本例白测"

    paged: list[str] = []
    for current in (1, 2, 3):
        body = await _adb_body(client, h, pid, size=2, current=current)
        assert body["total"] == 6, "每一页的 total 都恒等于全集条数"
        paged.extend(x["id"] for x in body["items"])
    assert len(paged) == len(set(paged)) == 6, "页与页重叠或漏行 = OFFSET 没生效：" + str(paged)
    assert paged == expected, "页码走出的序必须就是 id 升序：" + str(paged)

    walked = await _adb_walk(client, h, pid, 2)
    assert walked == expected, "游标走出的序与绝对期望序不同：" + str(walked)

    past = await _adb_body(client, h, pid, size=2, current=9)
    assert past["items"] == [] and past["total"] == 6, "越过末页 = 空 items + 真 total"
    assert u.id
