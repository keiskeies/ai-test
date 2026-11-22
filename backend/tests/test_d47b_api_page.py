"""D47-b 步 4b：/api-definitions 接页码分页（批次 A 第二刀里最后一条列表端点）。

为什么这条要单独一个文件：它的页码模式**必须与已下推的筛选一起看**才算数。
报告中心（步 2）的每个筛选项本来就是服务端参数；接口页不是——它一度是「拉 200 条回浏览器
内存过滤」，在那种状态下挂页脚只会得到一个说谎的页脚（第 3 页画 2 行、脚注说共 300 条）。
所以本文件的每条 total 断言都带着筛选条件，钉的是「total 数的是筛选后的全集」。

钉的契约：
- **游标路径逐字节不变**：不传 current 时响应键恰好 {items, next_cursor}。这条端点的消费方
  除接口页外还有 agent 工具入口（同一 handler 的 JSON 入参），形状变了没人会来报警。
- **cursor 与 current 互斥**，同时到场大声 400（判据 2）。
- **判据 5**：本端点排序键是 `ORDER BY id`（与 /schedule-tasks 同型，与报告页的 COALESCE 不同
  型）。两制必须共用这一条，所以先钉**绝对期望序**，再钉两制一致——只钉后者会在
  「两制同时换键」时假绿（步 2 的教训，那条用例的 fixture 当时让两种口径给出同一张脸）。
- **total 与 items 同源**：同一份 clauses，筛选在前、数数在后（MS 的 PageHelper 同构）。
- 越界页 = 200 + 空 items + 真 total（判据 4），不是 500、不是返回首页。
- size=201 → pydantic 422，不钳到 200（后端上限是硬约束，档位表因此只有 20/50/100）。

**为什么这里用 session 直接种子（本仓读侧用例的一般口径是「写走 HTTP」）**：
id 由服务端 `uuid4()` 生成，走 HTTP 就拿不到可控 id 序，而本文件判据 5 那条需要的正是
「id 序 ≠ 创建序」这个**确定的**事实——靠随机数撞出来的是运气，不是 fixture。
同款取舍见 test_d47b_page_three.py（它为了 created_at 与 id 错开也是直接入库）。
筛选与可见性仍按真服务口径跑：项目、模块走 HTTP 真建，读全部走 HTTP。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.modules.api_test.models import ApiDefinition


async def _proj(client, h, name) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _mod(client, h, pid, name, parent=None) -> dict:
    body = {"project_id": pid, "name": name}
    if parent:
        body["parent_id"] = parent
    r = await client.post("/api/v1/api-modules", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _seed_def(session, pid: str, *, did: str, name: str, module_id: str | None = None,
                    created_at: datetime | None = None) -> str:
    """直种一行接口：id 与 created_at 都由用例给定（理由见模块 docstring）。"""
    session.add(ApiDefinition(
        id=did, project_id=pid, module_id=module_id, name=name, method="GET", path="/p/" + did,
        request={"method": "GET", "url": "http://t/x"}, status="draft", version=1,
        project_public=True, created_at=created_at, updated_at=created_at))
    await session.commit()
    return did


async def _get(client, h, pid, *, module_ids: list[str] | None = None, **params):
    """一页的 (id 序, 响应本体)。module_ids 用重复键上线（GET 投影的 Query() 承载）。"""
    qs: list[tuple[str, str]] = [("project_id", pid)]
    qs += [("module_ids", m) for m in (module_ids or [])]
    qs += [(k, str(v)) for k, v in params.items()]
    r = await client.get("/api/v1/api-definitions", params=qs, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    return [x["id"] for x in body["items"]], body


async def _walk_cursor(client, h, pid, size: int, **params) -> list[str]:
    """游标模式从头走到尾，返回按走出顺序的 id。"""
    out: list[str] = []
    cursor: str | None = None
    for _ in range(50):  # 上限只防死循环；真死循环应由断言红掉而不是这里
        q = {"project_id": pid, "size": size, **params}
        if cursor:
            q["cursor"] = cursor
        r = await client.get("/api/v1/api-definitions", params=q, headers=h)
        assert r.status_code == 200, r.text
        body = r.json()
        out.extend(x["id"] for x in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            return out
    raise AssertionError("游标没走完，size=" + str(size))


async def test_wire_contract_keys_dual_param_and_size_cap(client, session, make_user) -> None:
    """键集形状（首页 + 续页）、页码形状、双参 400、size 越界 422。

    变异自证：`_dump` 改成无条件写 total 键 → 第一条红（游标响应多出 "total": null）；
    摘掉 handler 的互斥检查 → 第三条红（两个都给时静默走了页码那一支）。
    """
    u, h = await make_user("d47b4bwire", admin=True)
    pid = await _proj(client, h, "D47B4B契约")
    for i in range(3):
        await _seed_def(session, pid, did=f"w-{i}", name="契约" + str(i))

    _, body = await _get(client, h, pid, size=10)
    assert set(body) == {"items", "next_cursor"}, "首页多了/少了键就是改契约：" + str(sorted(body))
    # 续页同样不带 total：游标一路的形状是消费方（agent 工具入口）在依赖的
    nxt = await client.get("/api/v1/api-definitions",
                           params={"project_id": pid, "size": 2, "cursor": body["next_cursor"]},
                           headers=h)
    assert nxt.status_code == 200, nxt.text
    assert set(nxt.json()) == {"items", "next_cursor"}, "游标页形状变了：" + str(sorted(nxt.json()))

    _, paged = await _get(client, h, pid, size=10, current=1)
    assert set(paged) == {"items", "next_cursor", "total"}, \
        "页码模式必须带 total（页脚的唯一真相来源）：" + str(sorted(paged))
    assert paged["next_cursor"] is None, "页码模式不产游标，否则就是两套真相并存"

    r = await client.get("/api/v1/api-definitions",
                         params={"project_id": pid, "size": 10, "current": 1, "cursor": "w-0"},
                         headers=h)
    assert r.status_code == 400, "cursor 与 current 同时到场必须大声报错：" + r.text
    assert r.json()["code"] == "bad_request"

    over = await client.get("/api/v1/api-definitions",
                            params={"project_id": pid, "size": 201, "current": 1}, headers=h)
    assert over.status_code == 422, "size 越界是 422，不是悄悄钳到 200：" + over.text
    assert u.id


async def test_total_counts_after_filters_not_table_or_page_len(client, session, make_user) -> None:
    """total 数的是**筛选后的全集**：不是表里行数，也不是本页行数。

    种子（子树故意与直属不等，与步 4a 同口径）：
      A(直属1) > A1(直属2)  → 子树 3；B(直属2)；未分类 1 ⇒ 表里 6 行。
    变异自证：total 改成整表 count（不带 clauses）→ 选 A 那次拿到 6，红；
    改成 len(items) → size=2 时拿到 2，红。
    """
    u, h = await make_user("d47b4btotal", admin=True)
    pid = await _proj(client, h, "D47B4B总数")
    a = await _mod(client, h, pid, "A")
    a1 = await _mod(client, h, pid, "A1", a["id"])
    b = await _mod(client, h, pid, "B")
    for did, name, mod in (("t-a", "A根", a["id"]), ("t-a1", "A1子", a1["id"]),
                           ("t-a2", "A1孙", a1["id"]), ("t-b1", "B一", b["id"]),
                           ("t-b2", "B二", b["id"])):
        await _seed_def(session, pid, did=did, name=name, module_id=mod)
    await _seed_def(session, pid, did="t-none", name="未分类的一条")

    # 子树 A = A根 + A1子 + A1孙 = 3；表里 6 行；本页 size=2
    _, sub = await _get(client, h, pid, size=2, current=1, module_ids=[a["id"], a1["id"]])
    assert sub["total"] == 3, "total 必须是子树筛选后的 3，实得 " + str(sub["total"])
    assert len(sub["items"]) == 2, "本页仍是 size=2（total 不是本页行数）"

    _, kw = await _get(client, h, pid, size=2, current=1,
                       module_ids=[a["id"], a1["id"]], keyword="A1")
    assert kw["total"] == 2, "keyword 也要进 total 的同一份条件：" + str(kw["total"])

    _, allp = await _get(client, h, pid, size=2, current=1)
    assert allp["total"] == 6, "不加筛选时 total = 全量 6：" + str(allp["total"])

    _, none = await _get(client, h, pid, size=2, current=1, module_ids=["不存在"])
    assert none["total"] == 0 and none["items"] == [], "空结果要大方说 0，不许被 falsy 吞掉"
    assert u.id


async def test_page_and_cursor_walk_the_same_id_order(client, session, make_user) -> None:
    """判据 5：两制共用 `ORDER BY id`；页与页不重叠不遗漏；越界页不报错。

    种子的 id 刻意按「z-, m-, a-」这种与创建序相反/打乱的顺序给，created_at 也另给一套
    ——于是「按 id 排」「按 created_at↑」「按 created_at↓」给出三种不同答案，
    换排序键的变异才抓得住。先断言 fixture 真有这个区分度（步 2 翻过「种子两种口径同脸」
    的车，那次整份文件对排序键的更换完全无感），再断言两制都走 id 升序。
    """
    u, h = await make_user("d47b4border", admin=True)
    pid = await _proj(client, h, "D47B4B时序")
    now = datetime.now(UTC).replace(microsecond=0)
    # (id, 创建时间偏移天数)：插入序 = created_at 序 = z, m, a, q, b, k
    plan = [("z-1", 9), ("m-2", 5), ("a-3", 7), ("q-4", 1), ("b-5", 8), ("k-6", 2)]
    inserted = []
    for did, back in plan:
        await _seed_def(session, pid, did=did, name="接口" + did,
                        created_at=now - timedelta(days=back))
        inserted.append(did)

    expected = sorted(inserted)  # 服务端那条 ORDER BY ApiDefinition.id
    by_time_asc = [d for d, _ in sorted(plan, key=lambda x: x[1])]
    assert expected != inserted, "种子没有区分度（id 序 == 创建序），本例白测"
    assert expected != list(reversed(inserted)), "种子没有区分度（id 序 == 创建序倒序），本例白测"
    assert expected != by_time_asc, "种子没有区分度（id 序 == created_at 升序），本例白测"

    paged: list[str] = []
    for current in (1, 2, 3):
        got, body = await _get(client, h, pid, size=2, current=current)
        assert body["total"] == 6
        paged.extend(got)
    assert len(paged) == len(set(paged)) == 6, "页与页重叠或漏行 = OFFSET 没生效：" + str(paged)
    assert paged == expected, "页码走出的序必须就是 id 升序：" + str(paged)

    walked = await _walk_cursor(client, h, pid, 2)
    assert walked == expected, "游标走出的序与页码不同 = 两制各排各的：" + str(walked)

    past, pbody = await _get(client, h, pid, size=2, current=9)
    assert past == [] and pbody["total"] == 6, "越过末页 = 空 items + 真 total，不是 500"
    assert u.id
