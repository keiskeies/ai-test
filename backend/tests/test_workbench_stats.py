"""工作台统计端点（§11.5.2 一期简化版）的服务端测试。

钉死的口径（数字会被团队当事实读）：
  ① 空项目 → 全零 + 7 个点的全 null 趋势（空态是正当返回，不是错误）
  ② 通过率 = Σpass / Σ(total−skip)，stats 缺行的运行不进分母（§8.6 聚合版）
  ③ 7 天窗口与 UTC/Asia-Shanghai 日界的换算（R68 的坑不能在这里复发第二遍）：
     - 窗口起点 = 上海日历的「今天−6」00:00 = UTC 的「昨天 16:00」
     - 东八区 00:00~08:00 的运行必须落进**今天**的桶（UTC 切日会把它划给昨天）
  ④ 项目隔离：B 项目的运行/资产/编辑不进 A 的统计（本仓库对 project_id 过滤零容忍）
  ⑤ 失败 TOP1 只数 scenario 的 failed/error，取次数最多者
  ⑥ 我最近编辑只覆盖 scenario/ui_case（updated_by），api_* 无编辑者列（纪律 1）；
     adb_case 有 updated_by 也刻意不进榜（1D T8 口径，与前端分节同批改），
     但资产计数 assets.adb_case 正常计入、回收除外
  ⑦ 非项目成员 403；READONLY 成员可读
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.core.db import new_id
from app.modules.api_test.models import ApiCase, ApiDefinition
from app.modules.execution.models import RunRecord
from app.modules.scenario.models import Scenario
from app.modules.ui_test.models import UiCase
from app.modules.workbench.services import window_start_utc

TZ_OFFSET = timedelta(hours=8)


def _utc(*args) -> datetime:
    return datetime(*args, tzinfo=UTC).replace(tzinfo=None)


def _sh(*args) -> datetime:
    """Asia/Shanghai 本地时刻 → 库内 UTC naive（= 上海时刻减 8 小时，无夏令时）。"""
    return datetime(*args) - TZ_OFFSET


# ---------- 纯函数：窗口起点的时区换算（不碰库，先把最危险的算术钉死） ----------


def test_window_start_is_shanghai_midnight_of_six_days_ago() -> None:
    # 上海 2026-11-16 10:00（= UTC 02:00）→ 窗口起点 = 上海 11-10 00:00 = UTC 11-09 16:00
    now = _utc(2026, 11, 16, 2, 0, 0)
    assert window_start_utc(now) == _utc(2026, 11, 9, 16, 0, 0)
    # 上海 2026-11-16 01:00（= UTC 前一日 17:00）：UTC 日期还在 15 日，上海已是 16 日——
    # 按 UTC 切「今天」的实现会把窗口整体错一天，这个用例就是钉它的
    now2 = _utc(2026, 11, 15, 17, 0, 0)
    assert window_start_utc(now2) == _utc(2026, 11, 9, 16, 0, 0)


# ---------- 夹具 ----------


async def _proj(client, headers: dict, name: str) -> str:
    r = await client.post("/api/v1/projects", json={"name": name}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _run(session, pid: str, *, subject_id: str = "sc-1", subject_name: str = "登录场景",
               subject_type: str = "scenario", trigger: str = "manual", status: str = "passed",
               at: datetime | None = None, stats: dict | None = None,
               created_by: str | None = None, elapsed_ms: int | None = None) -> str:
    r = RunRecord(project_id=pid, subject_type=subject_type, subject_id=subject_id,
                  subject_name=subject_name, trigger=trigger, status=status,
                  created_by=created_by or new_id(), started_at=at, finished_at=at,
                  elapsed_ms=elapsed_ms, stats=stats)
    session.add(r)
    await session.commit()
    return r.id


async def _stats(client, headers: dict, pid: str) -> dict:
    r = await client.get("/api/v1/workbench-stats", params={"project_id": pid}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


# ---------- ① 空项目 ----------


async def test_empty_project_returns_zeros_and_wellformed_series(client, session, make_user) -> None:
    u, h = await make_user("wb0")
    pid = await _proj(client, h, "工作台空项目")
    body = await _stats(client, h, pid)

    assert body["assets"] == {"api_definition": 0, "api_case": 0, "scenario": 0,
                              "ui_case": 0, "adb_case": 0}
    assert body["runs_7d"] == 0
    assert body["pass_rate"] is None, "没有分母 → null（画「-」），不许是 0 或 NaN"
    assert body["top_fail"] is None
    assert len(body["daily"]) == 7, "空项目也要给 7 个点，否则趋势图轴都画不出来"
    assert [d["runs"] for d in body["daily"]] == [0] * 7
    assert [d["pass_rate"] for d in body["daily"]] == [None] * 7
    assert body["recent_runs"] == [] and body["my_recent_edits"] == []


# ---------- ② 通过率算术 ----------


async def test_pass_rate_sums_and_skips_denominator_zero(client, session, make_user) -> None:
    u, h = await make_user("wb1")
    pid = await _proj(client, h, "工作台通过率")
    now = datetime.now(UTC).replace(tzinfo=None)
    # run1: 8/10 → 分母 10 ；run2: 3/5 但 skip 2 → 分母 3 ；run3: 无 stats → 不进分母
    await _run(session, pid, subject_name="A", at=now, stats={"total": 10, "pass": 8, "fail": 2})
    await _run(session, pid, subject_name="B", at=now, stats={"total": 5, "pass": 3, "fail": 0, "skip": 2})
    await _run(session, pid, subject_name="C", at=now, stats=None)

    body = await _stats(client, h, pid)
    assert body["runs_7d"] == 3, "无 stats 的运行也是「一次执行」，只是不进通过率分母"
    assert abs(body["pass_rate"] - 11 / 13) < 1e-9, "Σpass/Σ(total−skip) = 11/13"
    assert body["recent_runs"] and len(body["recent_runs"]) == 3


async def test_all_skipped_window_pass_rate_is_none_not_zero(client, session, make_user) -> None:
    u, h = await make_user("wb1b")
    pid = await _proj(client, h, "工作台全跳过")
    await _run(session, pid, at=datetime.now(UTC).replace(tzinfo=None),
               stats={"total": 4, "pass": 0, "fail": 0, "skip": 4})
    body = await _stats(client, h, pid)
    assert body["runs_7d"] == 1 and body["pass_rate"] is None
    assert all(d["pass_rate"] is None for d in body["daily"])


# ---------- ③ 7 天窗口 + UTC/上海日界 ----------


async def test_window_boundary_and_day_buckets_across_utc_midnight(client, session, make_user) -> None:
    """把运行钉在上海日界（=UTC 16:00）两侧 + 窗口边界（第 7 天）上，逐桶验收。"""
    u, h = await make_user("wb2")
    pid = await _proj(client, h, "工作台日界")
    now = datetime.now(UTC).replace(tzinfo=None)
    today_sh = now + TZ_OFFSET  # 上海侧的 datetime（只用它的 date）

    def day_str(delta_days: int) -> str:
        return (today_sh.date() - timedelta(days=delta_days)).isoformat()

    since = window_start_utc(now)
    ok = {"total": 2, "pass": 2, "fail": 0}
    ko = {"total": 2, "pass": 1, "fail": 1}

    # a) 窗口起点前 1 秒（上海 (今天−6) 00:00:00−1s）→ 整体出局
    await _run(session, pid, subject_name="窗外", at=since - timedelta(seconds=1), stats=ko)
    # b) 恰好窗口起点（上海 今天−6 的 00:00 = UTC 昨天 16:00）→ 进第 1 桶（闭区间）
    await _run(session, pid, subject_id="b", subject_name="窗内首日", at=since, stats=ko)
    # c) 东八区凌晨：上海 今天 01:00 = UTC 昨天 17:00。UTC 切日的实现会把它划给「昨天」
    await _run(session, pid, subject_id="c", subject_name="东八区凌晨",
               at=_sh(today_sh.year, today_sh.month, today_sh.day, 1, 0, 0), stats=ok)
    # d) now 本身 = 上海今天的某个时刻（now 永远落进「上海今天」桶，任何钟点跑都不抖）
    await _run(session, pid, subject_id="d", subject_name="此刻", at=now, stats=ok)

    body = await _stats(client, h, pid)
    assert body["runs_7d"] == 3, "窗外那条必须被窗口排除"
    daily = {d["date"]: d for d in body["daily"]}
    assert list(daily) == sorted(daily) and len(daily) == 7
    assert daily[day_str(6)]["runs"] == 1, "窗口起点当秒闭区间计入第 1 天"
    assert daily[day_str(0)]["runs"] == 2, "上海凌晨 + UTC 白天都要落进「上海今天」这一桶"
    assert daily[day_str(1)]["runs"] == 0, "UTC 昨天 17:00 不是上海的昨天"
    # 今天的通过率 = (2+2)/(4) = 1.0；首日 = 1/2
    assert daily[day_str(0)]["pass_rate"] == 1.0
    assert daily[day_str(6)]["pass_rate"] == 0.5
    # 全局：Σpass=5, Σ(total−skip)=6
    assert abs(body["pass_rate"] - 5 / 6) < 1e-9


# ---------- ④ 项目隔离 ----------


async def test_project_isolation(client, session, make_user) -> None:
    u, h = await make_user("wb3")
    pid_a = await _proj(client, h, "隔离A")
    pid_b = await _proj(client, h, "隔离B")
    now = datetime.now(UTC).replace(tzinfo=None)

    await _run(session, pid_a, subject_id="a1", subject_name="A场景", at=now,
               stats={"total": 2, "pass": 2}, created_by=u.id)
    await _run(session, pid_b, subject_id="b1", subject_name="B场景", at=now,
               status="failed", stats={"total": 2, "pass": 0, "fail": 2}, created_by=u.id)
    session.add(Scenario(project_id=pid_a, name="A场景", step_graph={"nodes": []},
                         updated_by=u.id))
    session.add(Scenario(project_id=pid_b, name="B场景", step_graph={"nodes": []},
                         updated_by=u.id))
    await session.commit()

    a = await _stats(client, h, pid_a)
    assert a["runs_7d"] == 1 and a["assets"]["scenario"] == 1
    assert a["top_fail"] is None, "B 项目的失败不许冒进 A"
    assert [x["subject_name"] for x in a["recent_runs"]] == ["A场景"]
    assert [x["name"] for x in a["my_recent_edits"]] == ["A场景"]
    b = await _stats(client, h, pid_b)
    assert b["runs_7d"] == 1 and b["assets"]["scenario"] == 1
    assert b["top_fail"]["subject_name"] == "B场景"


# ---------- ⑤ 失败 TOP1 场景 ----------


async def test_top_fail_counts_only_failed_scenarios(client, session, make_user) -> None:
    u, h = await make_user("wb4")
    pid = await _proj(client, h, "工作台TOP失败")
    now = datetime.now(UTC).replace(tzinfo=None)
    for _ in range(2):
        await _run(session, pid, subject_id="s2", subject_name="支付场景", status="failed", at=now)
    await _run(session, pid, subject_id="s2", subject_name="支付场景", status="error", at=now)
    await _run(session, pid, subject_id="s1", subject_name="登录场景", status="failed", at=now)
    # 干扰项：UI 用例的失败不算「场景 TOP1」；通过的也不算
    await _run(session, pid, subject_id="u1", subject_name="UI首页", subject_type="ui_case",
               status="failed", at=now)
    await _run(session, pid, subject_id="s3", subject_name="通过场景", status="passed", at=now)

    body = await _stats(client, h, pid)
    assert body["top_fail"] == {"subject_id": "s2", "subject_name": "支付场景", "fail_count": 3}, \
        "failed+error 都计失败；只数 scenario"


# ---------- ⑥ 我最近编辑（updated_by 列的诚实覆盖面） ----------


async def test_my_recent_edits_only_types_with_editor_column(client, session, make_user) -> None:
    u, me = await make_user("wb5")
    other, _ = await make_user("wb5other")
    pid = await _proj(client, me, "工作台编辑")
    session.add(Scenario(project_id=pid, name="我改的场景", step_graph={"nodes": []}, updated_by=u.id))
    session.add(UiCase(project_id=pid, name="我改的UI", steps=[], updated_by=u.id))
    session.add(Scenario(project_id=pid, name="别人改的场景", step_graph={"nodes": []},
                         updated_by=other.id))
    # api_definition / api_case 没有 updated_by 列——建了也不该出现在结果里
    d = ApiDefinition(project_id=pid, name="接口X", method="GET", path="/x", owner_id=u.id)
    session.add(d)
    await session.flush()  # definition_id 取的是 d.id，主键 default 在 flush 时才有值
    session.add(ApiCase(project_id=pid, definition_id=d.id, name="用例X", owner_id=u.id))
    await session.commit()

    body = await _stats(client, me, pid)
    types = {x["type"] for x in body["my_recent_edits"]}
    assert types <= {"scenario", "ui_case"}, "覆盖面只许是有 updated_by 列的两类"
    assert set(body["my_recent_edits_types"]) == {"scenario", "ui_case"}
    names = {x["name"] for x in body["my_recent_edits"]}
    assert names == {"我改的场景", "我改的UI"}, "只认 updated_by=我，别人的编辑不算我的"
    assert all(x["updated_at"] for x in body["my_recent_edits"])


async def test_my_recent_edits_recycled_excluded(client, session, make_user) -> None:
    u, me = await make_user("wb5b")
    pid = await _proj(client, me, "工作台编辑回收")
    session.add(Scenario(project_id=pid, name="回收的场景", step_graph={"nodes": []},
                         status="recycled", updated_by=u.id))
    await session.commit()
    body = await _stats(client, me, pid)
    assert body["my_recent_edits"] == [] and body["assets"]["scenario"] == 0


# ---------- ⑥b adb_case 计数（1D T8）+ 「我最近编辑」刻意不收 adb_case ----------


async def test_adb_case_counted_but_excluded_from_recent_edits(client, session, make_user) -> None:
    """adb_case 进资产计数（回收除外），但**不进**「我最近编辑」——

    adb_case 有 updated_by 列（models 注释写明 1D T8），docstring :19-22 刻意把它留在
    榜外：前端分节在 T9 之后按 my_recent_edits_types 加宽，与其悄悄多一类让口径与前端
    对不上，不如留到加宽同批改。这条测试把该决定钉成契约，不只是注释。

    1E T6 补强（核对条款）：adb_case **从 0 → 1 的计数移动**单独钉一次——
    「payload 里资产总数吃进了 adb_case」是统计卡口径的契约，不是注释里的期望。
    """
    from app.modules.adb_test.models import AdbCase

    u, me = await make_user("wb7")
    pid = await _proj(client, me, "工作台ADB计数")
    steps = [{"id": "a1", "type": "shell", "config": {"cmd": "echo ok"}}]
    # 先钉 0（计数还没动）
    body0 = await _stats(client, me, pid)
    assert body0["assets"]["adb_case"] == 0
    session.add(AdbCase(project_id=pid, name="正常ADB", steps=steps, updated_by=u.id))
    session.add(AdbCase(project_id=pid, name="回收ADB", steps=steps, updated_by=u.id,
                        status="recycled"))
    await session.commit()

    body = await _stats(client, me, pid)
    assert body["assets"]["adb_case"] == 1, "adb_case 计数只数 normal，回收站不进数"
    assert list(body["my_recent_edits_types"]) == ["scenario", "ui_case"], \
        "adb_case 有 updated_by 也刻意不进榜单——加宽须与前端同批改（docstring 口径）"
    assert "adb_case" not in {x["type"] for x in body["my_recent_edits"]}, \
        "自己改过的 ADB 用例也不许悄悄冒进「我最近编辑」"


# ---------- ⑥c 最近执行的耗时（§11.4.1 行的「耗时」位；1E T6 补后端供给） ----------


async def test_recent_runs_carry_elapsed_ms_and_none_for_legacy(client, session, make_user) -> None:
    """elapsed_ms 原样透传（与运行记录/报告中心同一列同一把尺）；老行没写 → None。"""
    u, h = await make_user("wb8")
    pid = await _proj(client, h, "工作台耗时")
    now = datetime.now(UTC).replace(tzinfo=None)
    await _run(session, pid, subject_id="e1", subject_name="有耗时", at=now, elapsed_ms=1234)
    await _run(session, pid, subject_id="e2", subject_name="老记录", at=now, elapsed_ms=None)

    body = await _stats(client, h, pid)
    by_name = {r["subject_name"]: r for r in body["recent_runs"]}
    assert by_name["有耗时"]["elapsed_ms"] == 1234
    assert by_name["老记录"]["elapsed_ms"] is None, "缺耗时 → null（前端画「—」），不许伪造 0"


# ---------- ⑦ 权限 ----------


async def test_non_member_forbidden_and_readonly_can_read(client, session, make_user) -> None:
    u, h = await make_user("wb6")
    pid = await _proj(client, h, "工作台权限")
    other, ho = await make_user("wb6other")
    r = await client.get("/api/v1/workbench-stats", params={"project_id": pid}, headers=ho)
    assert r.status_code == 403, "非成员连统计都不给"

    ro, hro = await make_user("wb6ro")
    assert (await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                             json={"role_code": "READONLY"}, headers=h)).status_code == 200
    r2 = await client.get("/api/v1/workbench-stats", params={"project_id": pid}, headers=hro)
    assert r2.status_code == 200, "READONLY 的 *:read 必须罩得住 workbench:read"
