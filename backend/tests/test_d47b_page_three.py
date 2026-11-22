"""D47-b 步 3b 续：run_record_list / schedule_task_list / notify_channel_list 的页码分页。

三个端点、三套互不相干的实现，所以每个端点各钉三条——一条端点挂掉不应波及其他两个
（变异自证时「只红本端点」就是这条独立性的直接证据）。钉的契约（失效方式各不同）：

- **键集路径逐字节不变**：不传 current 时响应键必须恰好是 {items, next_cursor}——按
  完整键集断言而不是 `in`，首页与游标续页都要钉；凭空多出 `"total": null` 就是单方面
  改 20+ 个列表接口的契约（/runs 的 size=1 徽标消费方首当其冲）。
- **total 数的是筛选后的全集**：post-WHERE 条数、全表条数、本页行数三个数必须互不相等
  （种数据时刻意错开，另加跨项目行钉 project 过滤也进了 WHERE）；筛选命中 0 条时
  total 键仍在场且为 0——被 falsy 判断吞掉 = 页脚整个消失。
- **判据 5：两制共用一条排序键**。种的数据让候选排序键给出**不同**序列（/runs 让
  created_at 序与 id 序打架并埋同秒对钉死 id 兜底键；schedule/notify 让 id 序与
  created_at 序打架），页码拼出的序列必须逐位等于游标走出的序列。fixture 数据若让
  候选键给出同一序列，换排序键的变异会整文件存活——report 文件踩过这个坑。
- **cursor 与 current 同时给 → 400 bad_request**；**size 越 le → 422**（pydantic 现成
  行为，不钳位）。三个端点各自持有这两个判据（互不共用代码），所以三个都钉。

建数 / 翻页约定抄 tests/test_d47b_report_page.py：直插 ORM 行，client + make_user + _proj。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.modules.execution.models import RunRecord
from app.modules.notify.models import NotifyChannel
from app.modules.schedule.models import ScheduleTask

_BASE = "/api/v1"


async def _proj(client, headers: dict, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _walk_cursor(client, path: str, params: dict, headers: dict, size: int) -> list[str]:
    """游标模式走到尽头，返回 id 序列；钳住死循环（游标不推进时最多 (总数/size)+2 次）。"""
    walked: list[str] = []
    cursor = None
    for _ in range(64):
        q = dict(params, size=size)
        if cursor:
            q["cursor"] = cursor
        r = await client.get(path, params=q, headers=headers)
        assert r.status_code == 200, "游标翻页中途报错：" + str(r.status_code) + r.text
        body = r.json()
        walked.extend(x["id"] for x in body["items"])
        cursor = body["next_cursor"]
        if not cursor:
            break
        assert "total" not in body, "游标续页凭空多出 total 键 = 契约变更：" + str(sorted(body))
    return walked


# ── /runs（execution：created_at desc, id desc） ────────────────────────────────


async def _run(session, pid: str, *, rid: str, status: str = "passed",
               created_at: datetime | None = None) -> str:
    r = RunRecord(id=rid, project_id=pid, subject_type="scenario", subject_id="subj-" + rid,
                  subject_name="r" + rid, env_name="测试环境", trigger="manual",
                  status=status, created_at=created_at)
    session.add(r)
    await session.commit()
    return rid


async def test_run_wire_contract(client, session, make_user) -> None:
    """/runs 的加法式契约：键集形状（首页 + 续页）、页码形状、双参 400、size 越界 422。

    徽标消费方（api.tsx 逐行 size=1）不带 current——首页与游标续页都必须恰好
    {items, next_cursor}；页码页必须带 total 且 next_cursor 为 null；两制同请求 400；
    size=201 是 pydantic 422 不是钳到 200。
    """
    u, h = await make_user("d473runwire")
    pid = await _proj(client, h, "D473运行键集形状")
    base = datetime.now(UTC).replace(microsecond=0)
    for i in range(3):
        await _run(session, pid, rid=f"w-0{i}", created_at=base - timedelta(minutes=i))

    body = (await client.get(_BASE + "/runs",
                             params={"project_id": pid, "size": 2}, headers=h)).json()
    assert set(body) == {"items", "next_cursor"}, "首页多了/少了键就是改契约：" + str(sorted(body))
    assert body["next_cursor"], "3 行 / size=2 应有下一页"
    nxt = (await client.get(_BASE + "/runs", params={
        "project_id": pid, "size": 2, "cursor": body["next_cursor"]}, headers=h)).json()
    assert set(nxt) == {"items", "next_cursor"}, "游标页形状变了：" + str(sorted(nxt))

    paged = (await client.get(_BASE + "/runs",
                              params={"project_id": pid, "current": 1}, headers=h)).json()
    assert set(paged) == {"items", "next_cursor", "total"}, \
        "页码页必须带 total（页脚就靠它）：" + str(sorted(paged))
    assert paged["total"] == 3 and paged["next_cursor"] is None

    both = await client.get(_BASE + "/runs", params={
        "project_id": pid, "size": 2, "cursor": body["next_cursor"], "current": 2}, headers=h)
    assert both.status_code == 400 and both.json()["code"] == "bad_request", \
        "cursor+current 同时给必须 400 bad_request：" + both.text

    over = await client.get(_BASE + "/runs",
                            params={"project_id": pid, "size": 201, "current": 1}, headers=h)
    assert over.status_code == 422 and over.json()["code"] == "validation_failed", \
        "size>200 是 schema 拒绝（422），不是钳位放行"


async def test_run_page_total_is_filtered_not_table_or_page_len(client, session, make_user) -> None:
    """/runs：项目内 7 条 + 别项目 1 条、status 筛完剩 5、size=2 一页 2 行——
    5 / 7 / 8 / 2 四个数互不相等，total 只能等于 5。

    同时钉 total=0 不被 falsy 吞掉：status=error 命中 0 条时 total 键必须在场且为 0
    （`if total:` 一上，页脚会在「筛完为空」时整个消失而不是画「共 0 条」）。
    """
    u, h = await make_user("d473runtotal")
    pid = await _proj(client, h, "D473运行筛选计数")
    pid2 = await _proj(client, h, "D473运行别项目")
    for i in range(5):
        await _run(session, pid, rid=f"t-p{i}", status="passed")
    for i in range(2):
        await _run(session, pid, rid=f"t-f{i}", status="failed")
    await _run(session, pid2, rid="t-x", status="passed")

    full = (await client.get(_BASE + "/runs",
                             params={"project_id": pid, "current": 1}, headers=h)).json()
    assert full["total"] == 7, "项目内无筛选 total 应为 7（别项目 1 条不许混进来）"
    other = (await client.get(_BASE + "/runs",
                              params={"project_id": pid2, "current": 1}, headers=h)).json()
    assert other["total"] == 1, "跨项目行必须留在别的计数里"

    f = (await client.get(_BASE + "/runs", params={
        "project_id": pid, "status": "passed", "current": 1, "size": 2}, headers=h)).json()
    assert f["total"] == 5, f"total 必须是筛选后的 5，实得 {f['total']}（7=全表、8=含跨项目、2=本页）"
    assert len(f["items"]) == 2 and all(x["status"] == "passed" for x in f["items"])

    zero = (await client.get(_BASE + "/runs", params={
        "project_id": pid, "status": "error", "current": 1}, headers=h)).json()
    assert "total" in zero, "total=0 不许被 falsy 判断吞成没有这个键"
    assert zero["total"] == 0 and zero["items"] == []


async def test_run_pages_match_cursor_walk_when_the_keys_disagree(client, session,
                                                                  make_user) -> None:
    """判据 5（/runs）：三个候选排序键给出三种序列，页码与游标必须都走 created_at↓, id↓。

    种三条：同秒对 w-20/w-10（created_at 相同，id desc 决出先后）+ 一条更早但 id 最大
    的 w-90。期望序 [w-20, w-10, w-90]；纯 id↓ 会给 [w-90, w-20, w-10]，纯 id↑ 会给
    [w-10, w-20, w-90]，created_at↑ 会把 w-90 提到最前——谁换/翻排序键都当场红。
    逐页 size=2 拼接必须逐位等于游标 size=2 走出的序列；越界页 200 + 空 items + 真 total。
    """
    u, h = await make_user("d473runtimeline")
    pid = await _proj(client, h, "D473运行两制同序")
    near = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=5)
    far = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=1)
    await _run(session, pid, rid="w-20", created_at=near)
    await _run(session, pid, rid="w-10", created_at=near)
    await _run(session, pid, rid="w-90", created_at=far)
    expected = ["w-20", "w-10", "w-90"]

    p1 = (await client.get(_BASE + "/runs", params={
        "project_id": pid, "size": 2, "current": 1}, headers=h)).json()
    assert [x["id"] for x in p1["items"]] == expected[:2], \
        "页码第 1 页序不对（换排序键的变异靠这条抓）：" + str([x["id"] for x in p1["items"]])

    walked = await _walk_cursor(client, _BASE + "/runs", {"project_id": pid}, h, 2)
    assert walked == expected, "游标走出的序与期望序不同：" + str(walked)

    paged: list[str] = []
    for current in (1, 2):
        body = (await client.get(_BASE + "/runs", params={
            "project_id": pid, "size": 2, "current": current}, headers=h)).json()
        assert body["total"] == 3, "每一页的 total 都恒等于全集条数"
        paged.extend(x["id"] for x in body["items"])
    assert len(paged) == len(set(paged)), "页与页重叠 = OFFSET 没生效"
    assert paged == walked == expected, "两制拼接必须逐位相等：" + str(paged)

    past = await client.get(_BASE + "/runs", params={
        "project_id": pid, "size": 2, "current": 3}, headers=h)
    assert past.status_code == 200, "跳到空页不许报错：" + past.text
    assert past.json()["items"] == [] and past.json()["total"] == 3


# ── /schedule-tasks（schedule：id asc；enabled 可选过滤） ───────────────────────


async def _task(session, pid: str, *, tid: str, name: str, enabled: int = 1,
                created_at: datetime | None = None) -> str:
    row = ScheduleTask(id=tid, project_id=pid, name=name, subject_type="scenario",
                       subject_id="sc-" + tid, cron="0 2 * * *", enabled=enabled,
                       notify_channel_ids=[], created_at=created_at, updated_at=created_at)
    session.add(row)
    await session.commit()
    return tid


async def test_schedule_wire_contract(client, session, make_user) -> None:
    """/schedule-tasks 的加法式契约：键集形状（首页 + 续页）、页码形状、双参 400、422。

    schedule 与 execution/notify 各自独立实现这两个判据（不共用 helper）——本端点的
    400 被拆掉只有本文件的本端点用例该红，这是三模块互不相干的直接证据。
    """
    u, h = await make_user("d473schwire", admin=True)
    pid = await _proj(client, h, "D473调度键集形状")
    base = datetime.now(UTC).replace(microsecond=0)
    for i in range(3):
        await _task(session, pid, tid=f"s-0{i}", name="k" + str(i), created_at=base)

    body = (await client.get(_BASE + "/schedule-tasks",
                             params={"project_id": pid, "size": 2}, headers=h)).json()
    assert set(body) == {"items", "next_cursor"}, "首页多了/少了键就是改契约：" + str(sorted(body))
    assert body["next_cursor"], "3 行 / size=2 应有下一页"
    nxt = (await client.get(_BASE + "/schedule-tasks", params={
        "project_id": pid, "size": 2, "cursor": body["next_cursor"]}, headers=h)).json()
    assert set(nxt) == {"items", "next_cursor"}, "游标页形状变了：" + str(sorted(nxt))

    paged = (await client.get(_BASE + "/schedule-tasks",
                              params={"project_id": pid, "current": 1}, headers=h)).json()
    assert set(paged) == {"items", "next_cursor", "total"}, \
        "页码页必须带 total：" + str(sorted(paged))
    assert paged["total"] == 3 and paged["next_cursor"] is None

    both = await client.get(_BASE + "/schedule-tasks", params={
        "project_id": pid, "size": 2, "cursor": body["next_cursor"], "current": 2}, headers=h)
    assert both.status_code == 400 and both.json()["code"] == "bad_request", \
        "cursor+current 同时给必须 400：" + both.text

    over = await client.get(_BASE + "/schedule-tasks",
                            params={"project_id": pid, "size": 201, "current": 1}, headers=h)
    assert over.status_code == 422 and over.json()["code"] == "validation_failed"


async def test_schedule_page_total_is_filtered_not_table_or_page_len(client, session,
                                                                     make_user) -> None:
    """/schedule-tasks：项目内 7 条（4 启用 + 3 停用）+ 别项目 2 条，enabled=1 且 size=2：
    total 只能是 4——4 / 7 / 9 / 2 四个数互不相等，一个都不许对得上号。

    另钉 total=0：空项目里 enabled=1 命中 0 条，total 键必须在场且为 0。
    """
    u, h = await make_user("d473schtotal", admin=True)
    pid = await _proj(client, h, "D473调度筛选计数")
    pid2 = await _proj(client, h, "D473调度别项目")
    pid3 = await _proj(client, h, "D473调度空项目")
    for i in range(4):
        await _task(session, pid, tid=f"e-1{i}", name="开" + str(i), enabled=1)
    for i in range(3):
        await _task(session, pid, tid=f"e-0{i}", name="关" + str(i), enabled=0)
    for i in range(2):
        await _task(session, pid2, tid=f"x-{i}", name="别" + str(i))

    full = (await client.get(_BASE + "/schedule-tasks",
                             params={"project_id": pid, "current": 1}, headers=h)).json()
    assert full["total"] == 7, "项目内无筛选 total 应为 7"

    f = (await client.get(_BASE + "/schedule-tasks", params={
        "project_id": pid, "enabled": 1, "current": 1, "size": 2}, headers=h)).json()
    assert f["total"] == 4, f"total 必须是筛选后的 4，实得 {f['total']}（7=全项目、9=全表、2=本页）"
    assert len(f["items"]) == 2 and all(x["enabled"] == 1 for x in f["items"])

    zero = (await client.get(_BASE + "/schedule-tasks", params={
        "project_id": pid3, "enabled": 1, "current": 1}, headers=h)).json()
    assert "total" in zero, "total=0 不许被 falsy 判断吞成没有这个键"
    assert zero["total"] == 0 and zero["items"] == []


async def test_schedule_pages_match_cursor_walk_when_the_keys_disagree(client, session,
                                                                       make_user) -> None:
    """判据 5（/schedule-tasks）：id 升序 ≠ created_at 升序/降序，两制都必须走 id 升序。

    s-01 最老、s-02 最新、s-03 居中：id↑=[s-01,s-02,s-03]，created_at↑=[s-01,s-03,s-02]，
    created_at↓=[s-02,s-03,s-01]，id↓=[s-03,s-02,s-01]——四种答案互不相同。页码 size=2
    拼接必须逐位等于游标 size=2 走出的序列；越界页 200 + 空 items + 真 total。
    """
    u, h = await make_user("d473schtimeline", admin=True)
    pid = await _proj(client, h, "D473调度两制同序")
    now = datetime.now(UTC).replace(microsecond=0)
    await _task(session, pid, tid="s-01", name="最早", created_at=now - timedelta(days=2))
    await _task(session, pid, tid="s-02", name="最新", created_at=now)
    await _task(session, pid, tid="s-03", name="居中", created_at=now - timedelta(hours=5))
    expected = ["s-01", "s-02", "s-03"]

    p1 = (await client.get(_BASE + "/schedule-tasks", params={
        "project_id": pid, "size": 2, "current": 1}, headers=h)).json()
    assert [x["id"] for x in p1["items"]] == expected[:2], \
        "页码第 1 页序不对（换排序键的变异靠这条抓）：" + str([x["id"] for x in p1["items"]])

    walked = await _walk_cursor(client, _BASE + "/schedule-tasks", {"project_id": pid}, h, 2)
    assert walked == expected, "游标走出的序与期望序不同：" + str(walked)

    paged: list[str] = []
    for current in (1, 2):
        body = (await client.get(_BASE + "/schedule-tasks", params={
            "project_id": pid, "size": 2, "current": current}, headers=h)).json()
        assert body["total"] == 3
        paged.extend(x["id"] for x in body["items"])
    assert len(paged) == len(set(paged)), "页与页重叠 = OFFSET 没生效"
    assert paged == walked == expected, "两制拼接必须逐位相等：" + str(paged)

    past = await client.get(_BASE + "/schedule-tasks", params={
        "project_id": pid, "size": 2, "current": 3}, headers=h)
    assert past.status_code == 200, "跳到空页不许报错：" + past.text
    assert past.json()["items"] == [] and past.json()["total"] == 3


# ── /notify-channels（notify：id asc；type 可选过滤；无项目过滤是既定口径） ──────


async def _chan(session, *, cid: str, name: str, type_: str,
                created_at: datetime | None = None) -> str:
    row = NotifyChannel(id=cid, name=name, type=type_, config={},
                        created_at=created_at, updated_at=created_at)
    session.add(row)
    await session.commit()
    return cid


async def test_notify_wire_contract(client, session, make_user) -> None:
    """/notify-channels 的加法式契约：键集形状（首页 + 续页）、页码形状、双参 400、422。

    本端点没有 project_id（既定口径，别顺手加）；notify 的互斥 400 是独立实现的一份，
    拆掉它只有本用例红。
    """
    u, h = await make_user("d473ntwire", admin=True)
    base = datetime.now(UTC).replace(microsecond=0)
    for i in range(3):
        await _chan(session, cid=f"n-0{i}", name="nt-w" + str(i), type_="WEBHOOK",
                    created_at=base)

    body = (await client.get(_BASE + "/notify-channels", params={"size": 2}, headers=h)).json()
    assert set(body) == {"items", "next_cursor"}, "首页多了/少了键就是改契约：" + str(sorted(body))
    assert body["next_cursor"], "3 行 / size=2 应有下一页"
    nxt = (await client.get(_BASE + "/notify-channels",
                            params={"size": 2, "cursor": body["next_cursor"]}, headers=h)).json()
    assert set(nxt) == {"items", "next_cursor"}, "游标页形状变了：" + str(sorted(nxt))

    paged = (await client.get(_BASE + "/notify-channels", params={"current": 1}, headers=h)).json()
    assert set(paged) == {"items", "next_cursor", "total"}, \
        "页码页必须带 total：" + str(sorted(paged))
    assert paged["total"] == 3 and paged["next_cursor"] is None

    both = await client.get(_BASE + "/notify-channels",
                            params={"size": 2, "cursor": body["next_cursor"], "current": 2},
                            headers=h)
    assert both.status_code == 400 and both.json()["code"] == "bad_request", \
        "cursor+current 同时给必须 400：" + both.text

    over = await client.get(_BASE + "/notify-channels", params={"size": 201, "current": 1},
                            headers=h)
    assert over.status_code == 422 and over.json()["code"] == "validation_failed"


async def test_notify_page_total_is_filtered_not_table_or_page_len(client, session,
                                                                   make_user) -> None:
    """/notify-channels：5 条（3 WEBHOOK + 2 DINGTALK）、type=WEBHOOK 且 size=2：
    total 只能是 3——3 / 5 / 2 三个数互不相等。

    另钉 total=0：type=EMAIL 命中 0 条，total 键必须在场且为 0（type 枚外按「查不到」
    处理的既定口径下，空结果同样不许把 total 键弄丢）。
    """
    u, h = await make_user("d473nttotal", admin=True)
    for i in range(3):
        await _chan(session, cid=f"c-w{i}", name="nt-t-w" + str(i), type_="WEBHOOK")
    for i in range(2):
        await _chan(session, cid=f"c-d{i}", name="nt-t-d" + str(i), type_="DINGTALK")

    full = (await client.get(_BASE + "/notify-channels", params={"current": 1},
                             headers=h)).json()
    assert full["total"] == 5, "无筛选 total 应为全表 5"

    f = (await client.get(_BASE + "/notify-channels", params={
        "type": "WEBHOOK", "current": 1, "size": 2}, headers=h)).json()
    assert f["total"] == 3, f"total 必须是筛选后的 3，实得 {f['total']}（5=全表、2=本页）"
    assert len(f["items"]) == 2 and all(x["type"] == "WEBHOOK" for x in f["items"])

    zero = (await client.get(_BASE + "/notify-channels",
                             params={"type": "EMAIL", "current": 1}, headers=h)).json()
    assert "total" in zero, "total=0 不许被 falsy 判断吞成没有这个键"
    assert zero["total"] == 0 and zero["items"] == []


async def test_notify_pages_match_cursor_walk_when_the_keys_disagree(client, session,
                                                                     make_user) -> None:
    """判据 5（/notify-channels）：id 升序 ≠ created_at 升/降序，两制都必须走 id 升序。

    c-01 最老、c-02 最新、c-03 居中（与 schedule 用例同款错位）：候选排序键给出四种
    互不相同的答案。页码 size=2 拼接必须逐位等于游标 size=2 走出的序列；
    越界页 200 + 空 items + 真 total。
    """
    u, h = await make_user("d473nttimeline", admin=True)
    now = datetime.now(UTC).replace(microsecond=0)
    await _chan(session, cid="c-01", name="nt-l-earliest", type_="WEBHOOK",
                created_at=now - timedelta(days=2))
    await _chan(session, cid="c-02", name="nt-l-latest", type_="DINGTALK", created_at=now)
    await _chan(session, cid="c-03", name="nt-l-mid", type_="WEBHOOK",
                created_at=now - timedelta(hours=5))
    expected = ["c-01", "c-02", "c-03"]

    p1 = (await client.get(_BASE + "/notify-channels",
                           params={"size": 2, "current": 1}, headers=h)).json()
    assert [x["id"] for x in p1["items"]] == expected[:2], \
        "页码第 1 页序不对（换排序键的变异靠这条抓）：" + str([x["id"] for x in p1["items"]])

    walked = await _walk_cursor(client, _BASE + "/notify-channels", {}, h, 2)
    assert walked == expected, "游标走出的序与期望序不同：" + str(walked)

    paged: list[str] = []
    for current in (1, 2):
        body = (await client.get(_BASE + "/notify-channels",
                                 params={"size": 2, "current": current}, headers=h)).json()
        assert body["total"] == 3
        paged.extend(x["id"] for x in body["items"])
    assert len(paged) == len(set(paged)), "页与页重叠 = OFFSET 没生效"
    assert paged == walked == expected, "两制拼接必须逐位相等：" + str(paged)

    past = await client.get(_BASE + "/notify-channels", params={"size": 2, "current": 3},
                            headers=h)
    assert past.status_code == 200, "跳到空页不许报错：" + past.text
    assert past.json()["items"] == [] and past.json()["total"] == 3
