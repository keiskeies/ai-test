"""D47-b 步 2：report_list 的页码分页模式（与 cursor 并存，两制各按场景选）。

钉的契约（失效方式各不同，所以各钉一条）：

- **键集路径逐字节不变**：不传 current 时响应键必须恰好是 {items, next_cursor}——按
  完整键集断言而不是 `in`：凭空多出 `"total": null` 就是给 20+ 个没人评审过的列表接口
  单方面改契约，本文件必须红（`_dump` 只在 total 非 None 时才写这个键）。
- **total 数的是筛选后的全集**：不是本页行数、不是全表；页脚照它画页码，数错比不数更糟。
- **两制共用一条 COALESCE 时间线（R70）**：started_at IS NULL 的行（queued / 1A 老行）
  必须按 created_at 排在正确位置出现——页码模式下丢掉或放错它们，就是本测试存在的理由。
- **cursor 与 current 同时给 → 400**：两套「我在哪」的真相一起到场是调用方的 bug，
  静默择一会把错位藏进翻页里。

翻页 / 建数约定抄 tests/test_report_center.py：直插 run_record，client + make_user + _proj。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.modules.execution.models import RunRecord


async def _run(session, pid: str, *, subject_name: str, trigger: str = "manual",
               status: str = "passed", created_by: str,
               started_at: datetime | None = None,
               created_at: datetime | None = None) -> str:
    """直插一条 run_record（写入口唯一是 save_run，查询面测试不经过写服务）。"""
    r = RunRecord(project_id=pid, subject_type="scenario", subject_id="subj-" + subject_name,
                  subject_name=subject_name, env_name="测试环境", trigger=trigger,
                  status=status, created_by=created_by,
                  started_at=started_at, finished_at=started_at, created_at=created_at)
    session.add(r)
    await session.commit()
    return r.id


async def _proj(client, user_headers: dict, name: str) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=user_headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_cursor_path_response_shape_is_byte_identical(client, session, make_user) -> None:
    """不传 current：响应键恰好 {items, next_cursor}，连 "total": null 都不许出现。

    这是 20+ 个列表接口的逐字节契约（D47-b 的底线是加法式扩展），所以按完整键集断言：
    多一个键（包括 total=null）、少一个键都红。对照组：current=1 时 total 键必须在场。
    """
    u, h = await make_user("d47bshape")
    pid = await _proj(client, h, "D47B键集形状")
    for i in range(3):
        await _run(session, pid, subject_name="k" + str(i), created_by=u.id)

    body = (await client.get("/api/v1/reports",
                             params={"project_id": pid, "size": 2}, headers=h)).json()
    assert set(body) == {"items", "next_cursor"}, "首页多了/少了键就是改契约：" + str(sorted(body))
    assert body["next_cursor"], "3 行 / size=2 应有下一页"
    # 带真游标继续走，形状同样不许变（翻页中途凭空冒出一个 total 键也算违约）
    nxt = (await client.get("/api/v1/reports", params={
        "project_id": pid, "size": 2, "cursor": body["next_cursor"]}, headers=h)).json()
    assert set(nxt) == {"items", "next_cursor"}, "游标页形状变了：" + str(sorted(nxt))

    paged = (await client.get("/api/v1/reports",
                              params={"project_id": pid, "current": 1}, headers=h)).json()
    assert set(paged) == {"items", "next_cursor", "total"}, \
        "页码页必须带 total（页脚就靠它）：" + str(sorted(paged))
    assert paged["total"] == 3 and paged["next_cursor"] is None


async def test_page_total_is_the_filtered_count_not_seeded_or_page_len(client, session,
                                                                       make_user) -> None:
    """种 7 条、status 筛完剩 5：total 必须是 5——不是 7（全表），不是本页行数。

    同时钉「items 与 total 用同一套 WHERE」：page 1 的 items 全部命中筛选，
    且 filtered total ⊂ unfiltered total，两口径不许各数各的。
    """
    u, h = await make_user("d47btotal")
    pid = await _proj(client, h, "D47B筛选计数")
    for i in range(5):
        await _run(session, pid, subject_name="过" + str(i), status="passed", created_by=u.id)
    for i in range(2):
        await _run(session, pid, subject_name="败" + str(i), status="failed", created_by=u.id)

    full = (await client.get("/api/v1/reports",
                             params={"project_id": pid, "current": 1}, headers=h)).json()
    assert full["total"] == 7, "无筛选 total 应为全量 7"

    f = (await client.get("/api/v1/reports",
                          params={"project_id": pid, "status": "passed", "current": 1},
                          headers=h)).json()
    assert f["total"] == 5, f"total 必须是筛选后的 5，实得 {f['total']}（数成 7=全表、数成本页=5 行恰好重合时用 size 拆开）"
    assert len(f["items"]) == 5 and all(x["status"] == "passed" for x in f["items"])
    assert f["total"] < full["total"], "筛选后的 total 必须严格小于全量"

    # size 小一页钉死「total ≠ 本页行数」：5 条命中、size=2 → 2 行 items、total 仍是 5
    small = (await client.get("/api/v1/reports", params={
        "project_id": pid, "status": "passed", "current": 1, "size": 2}, headers=h)).json()
    assert len(small["items"]) == 2 and small["total"] == 5


async def test_page_slices_disjoint_and_null_started_at_sorts_in_place(client, session,
                                                                       make_user) -> None:
    """R70 在页码模式的复刻：5 条有 started_at + 3 条 NULL（按 created_at 排尾）。

    逐页走 size=2：切片不重叠、拼起来恰是完整 COALESCE 倒序时间线，NULL 行落在队尾
    且对外仍如实 started_at=None——页码模式把它们丢了或放错位，本例当场红。
    第 5 页越界：200、items 空、total 照实。
    """
    u, h = await make_user("d47bslice")
    pid = await _proj(client, h, "D47B切片排序")
    base = datetime.now(UTC).replace(microsecond=0)
    head: list[str] = []
    for i in range(5):  # started_at 从新到旧（i 越大越早）
        head.append(await _run(session, pid, subject_name="p" + str(i), created_by=u.id,
                               started_at=base - timedelta(minutes=i),
                               created_at=base - timedelta(minutes=i)))
    tail: list[str] = []
    for i in range(3):  # queued 形态：started_at IS NULL，created_at 全体更旧 → 排尾
        tail.append(await _run(session, pid, subject_name="q" + str(i), status="queued",
                               created_by=u.id, started_at=None,
                               created_at=base - timedelta(hours=1, minutes=i)))
    expected = head + tail  # COALESCE(started_at, created_at) desc

    seen: list[str] = []
    for current in (1, 2, 3, 4):
        body = (await client.get("/api/v1/reports", params={
            "project_id": pid, "size": 2, "current": current}, headers=h)).json()
        assert body["total"] == 8, "每一页的 total 都恒等于全集条数"
        seen.extend(x["id"] for x in body["items"])
    assert len(seen) == len(set(seen)), "页与页重叠 = OFFSET 没生效"
    assert seen == expected, "页码切片拼起来必须逐位等于 COALESCE 时间线：" + str(seen)

    # NULL 行既在场又如实：对外 started_at=None（画「—」），但仍参与时间线排在尾部
    null_items = [x for x in (await client.get(
        "/api/v1/reports", params={"project_id": pid, "size": 50}, headers=h)).json()["items"]
        if x["started_at"] is None]
    assert [x["id"] for x in null_items] == tail, "NULL started_at 行必须按 created_at 排在尾部原位"

    # 越界页：不是错误，是空页 + 真 total
    past = await client.get("/api/v1/reports", params={
        "project_id": pid, "size": 2, "current": 5}, headers=h)
    assert past.status_code == 200, "跳到空页不许报错：" + past.text
    assert past.json()["items"] == [] and past.json()["total"] == 8


async def test_cursor_and_current_together_is_a_loud_400(client, session, make_user) -> None:
    """两套「我在哪」的真相一起到场 = 调用方 bug：必须 400，不许静默择一。

    择一（哪怕「看起来合理」的择一）会让两个口径对不上时的错位藏进翻页里，
    事后没人知道响应是哪种分页给的。code 用 bad_request：与 _parse_iso 的
    参数级 400 同族，bad_cursor 专属「游标本身坏了」，语义不许混用。
    """
    u, h = await make_user("d47bdual")
    pid = await _proj(client, h, "D47B双参互斥")
    for i in range(3):
        await _run(session, pid, subject_name="d" + str(i), created_by=u.id)
    first = (await client.get("/api/v1/reports",
                              params={"project_id": pid, "size": 2}, headers=h)).json()
    r = await client.get("/api/v1/reports", params={
        "project_id": pid, "size": 2, "cursor": first["next_cursor"], "current": 2}, headers=h)
    assert r.status_code == 400, "cursor+current 同时给必须 400，实得 " + str(r.status_code)
    assert r.json()["code"] == "bad_request", r.text


async def test_size_50_page_2_of_sixty_has_ten_items(client, session, make_user) -> None:
    """60 条命中、size=50：第 1 页 50 条、第 2 页恰好 10 条（末页不满页照实），total 恒 60。

    两页拼起来必须覆盖全部 60 条且无重——这钉的是 (current-1)*size 的偏移量，
    差一格就重叠/漏行。size 上限 le=200：越界是 pydantic 422，不是钳到 200。
    """
    u, h = await make_user("d47bsixty")
    pid = await _proj(client, h, "D47B六十条两页")
    base = datetime.now(UTC).replace(microsecond=0)
    ids: list[str] = []
    for i in range(60):
        ids.append(await _run(session, pid, subject_name="r" + str(i), created_by=u.id,
                              started_at=base - timedelta(minutes=i),
                              created_at=base - timedelta(minutes=i)))
    expected = ids  # started_at = base - i 分钟：ids[0] 最新，desc 序即插入序

    p1 = (await client.get("/api/v1/reports", params={
        "project_id": pid, "size": 50, "current": 1}, headers=h)).json()
    p2 = (await client.get("/api/v1/reports", params={
        "project_id": pid, "size": 50, "current": 2}, headers=h)).json()
    assert p1["total"] == 60 and p2["total"] == 60
    assert len(p1["items"]) == 50, "第 1 页应满 50 条"
    assert len(p2["items"]) == 10, f"60-50 末页应恰好 10 条，实得 {len(p2['items'])}"
    assert [x["id"] for x in p1["items"] + p2["items"]] == expected, "两页拼接必须等于完整时间线"

    over = await client.get("/api/v1/reports", params={
        "project_id": pid, "size": 201, "current": 1}, headers=h)
    assert over.status_code == 422 and over.json()["code"] == "validation_failed", \
        "size>200 是 schema 拒绝（422），不是钳位放行"


async def test_page_and_cursor_walk_the_same_timeline_when_the_keys_disagree(client, session,
                                                                            make_user) -> None:
    """判据 5 的真正守护：两条分页制必须走**同一条** COALESCE 时间线（R70/D177）。

    上一条切片用例证不到这件事——它的每条非空行都写成 started_at == created_at，所以
    「按 COALESCE 排」与「按 created_at 排」在那个数据上给出**逐位相同**的序列（变异自证过：
    把页码模式换成 created_at 排序，整个文件仍然全绿）。本例把两个键故意错开，让
    三种候选排序给出三种不同答案，再同时钉两头：

    - **页码 vs 游标**：同一份数据，两种方式各走一遍，id 序列必须完全相等。这是「共用一条
      时间线」最直接的表达——不猜排序键长什么样，只钉两制不许各排各的。
    - **候选键各自可区分**：期望序是 COALESCE desc = [A, C, B, D]；纯 created_at desc 会给
      [C, B, D, A]，纯 started_at desc（MySQL 把 NULL 排 DESC 末尾）会给 [A, C, D, B]。
      size=2 时三者第 1 页就不同，所以谁换排序键都当场红。
    """
    u, h = await make_user("d47btimeline")
    pid = await _proj(client, h, "D47B两制同序")
    base = datetime.now(UTC).replace(microsecond=0)
    # (名字, started_at, created_at) —— 每行的 COALESCE 序与 created_at 序互不相同
    spec = [
        ("A", base - timedelta(minutes=1), base - timedelta(days=10)),   # 老行今天重跑
        ("B", None, base - timedelta(minutes=5)),                        # queued，刚建
        ("C", base - timedelta(minutes=3), base - timedelta(minutes=2)),
        ("D", base - timedelta(minutes=30), base - timedelta(hours=1)),
    ]
    by_name = {}
    for nm, st, ct in spec:
        by_name[nm] = await _run(session, pid, subject_name="t" + nm, created_by=u.id,
                                 started_at=st, created_at=ct)
    expected = [by_name[n] for n in ("A", "C", "B", "D")]  # COALESCE(started_at, created_at) desc

    paged = (await client.get("/api/v1/reports",
                              params={"project_id": pid, "size": 2, "current": 1}, headers=h)).json()
    assert [x["id"] for x in paged["items"]] == expected[:2], \
        "页码第 1 页序不对（换排序键的变异靠这条抓）：" + str([x["id"] for x in paged["items"]])

    walked: list[str] = []
    cursor = None
    for _ in range(4):  # 至多 4 次拿完 4 行（钳住死循环：游标不推进时本例会挂在这里报出来）
        params = {"project_id": pid, "size": 2}
        if cursor:
            params["cursor"] = cursor
        body = (await client.get("/api/v1/reports", params=params, headers=h)).json()
        walked.extend(x["id"] for x in body["items"])
        cursor = body["next_cursor"]
        if not cursor:
            break
    assert walked == expected, "游标走出的序与页码走出的序不同 = 两制各排各的：" + str(walked)

    pages: list[str] = []
    for current in (1, 2):
        body = (await client.get("/api/v1/reports", params={
            "project_id": pid, "size": 2, "current": current}, headers=h)).json()
        pages.extend(x["id"] for x in body["items"])
    assert pages == walked == expected, "两制拼接必须逐位相等"
