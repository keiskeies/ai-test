"""运行记录排序契约：列表必须最新在前（列表徽标取 size=1 即最近一次），游标按同一倒序翻页。"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.modules.execution.models import RunRecord


async def _mk(session, pid: str, n: int) -> list[str]:
    ids: list[str] = []
    for i in range(n):
        r = RunRecord(project_id=pid, subject_type="api_definition", subject_id="subj-1",
                      subject_name="查询订单", trigger="debug", status="passed",
                      status_code=200, elapsed_ms=10 + i,
                      created_at=datetime.now(UTC) - timedelta(hours=n - i))
        session.add(r)
        await session.commit()
        ids.append(r.id)
    return ids


async def test_runs_newest_first_with_composite_cursor(client, session, make_user) -> None:
    _, h = await make_user("runordboss")
    pid = (await client.post("/api/v1/projects", json={"name": "runord"}, headers=h)).json()["id"]
    ids = await _mk(session, pid, 5)  # ids[0] 最早，ids[-1] 最新

    r = await client.get("/api/v1/runs", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["id"] for x in body["items"]] == list(reversed(ids)), "必须最新在前"
    # size=1 即最近一次（列表徽标依赖此契约）
    one = (await client.get("/api/v1/runs", params={"project_id": pid, "size": 1}, headers=h)).json()
    assert one["items"][0]["id"] == ids[-1] and one["next_cursor"]
    # 游标翻页：第二页是次新，且不重不漏
    p2 = (await client.get("/api/v1/runs",
                          params={"project_id": pid, "size": 1, "cursor": one["next_cursor"]}, headers=h)).json()
    assert p2["items"][0]["id"] == ids[-2]
    seen = [one["items"][0]["id"]]
    cur = p2
    while cur.get("next_cursor"):
        seen.append(cur["items"][0]["id"])
        cur = (await client.get("/api/v1/runs", params={
            "project_id": pid, "size": 1, "cursor": cur["next_cursor"]}, headers=h)).json()
    seen.append(cur["items"][0]["id"])
    assert seen == list(reversed(ids))


async def test_same_second_runs_stable_and_no_leak(client, session, make_user) -> None:
    """同一秒内的记录用 id 兜底：倒序确定、翻页不重不漏（MySQL DATETIME 秒级精度的现实）。"""
    _, h = await make_user("runord2boss")
    pid = (await client.post("/api/v1/projects", json={"name": "runord2"}, headers=h)).json()["id"]
    ts = datetime.now(UTC).replace(microsecond=0)
    ids = []
    for _i in range(6):
        r = RunRecord(project_id=pid, subject_type="api_definition", subject_id="subj-2",
                      subject_name="同秒", trigger="debug", status="failed", created_at=ts)
        session.add(r)
        await session.commit()
        ids.append(r.id)
    rg = await client.get("/api/v1/runs", params={"project_id": pid, "size": 200}, headers=h)
    assert rg.status_code == 200, rg.text
    got = rg.json()["items"]
    assert [x["id"] for x in got] == sorted(ids, reverse=True)
    # 非法游标：诚实报错而不是静默返回首页
    bad = await client.get("/api/v1/runs", params={"project_id": pid, "cursor": "!!!not-base64!!!"}, headers=h)
    assert bad.status_code == 400 and bad.json()["code"] == "bad_cursor"
    # 非成员连别人的项目列表都拿不到（项目门禁先于行过滤）
    _, ho = await make_user("runord2other")
    r4 = await client.get("/api/v1/runs", params={"project_id": pid}, headers=ho)
    assert r4.status_code == 403, r4.text
