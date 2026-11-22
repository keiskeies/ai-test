"""1E T7 审计查询增量（§11.4.27）：ts_from/ts_to 区间 + D23 硬门四角色矩阵 + D29 tool=False。

时间口径与 workbench 窗口同尺（Asia/Shanghai 日历日，§3.4-6）：
Shanghai 2025-03-11 全天 = UTC [2025-03-10T16:00, 2025-03-11T16:00)。
夹具用 2025 年的远过去日期：真实写入落在「现在」，与 2026 的边界夹具不撞（时间旅行安全）。
"""
from __future__ import annotations

from datetime import datetime

from tests.conftest import ADMIN_PASSWORD

# Shanghai 日历日夹具：a=03-10 23:59:59 / b=03-11 00:00 / c=03-11 23:59:59 / d=03-12 00:00（均 UTC 存储值）
_ROWS: list[tuple[str, datetime]] = [
    ("t7_a", datetime(2025, 3, 10, 15, 59, 59)),  # Shanghai 03-10 23:59:59
    ("t7_b", datetime(2025, 3, 10, 16, 0, 0)),    # Shanghai 03-11 00:00:00（03-11 起点，含）
    ("t7_c", datetime(2025, 3, 11, 15, 59, 59)),  # Shanghai 03-11 23:59:59（03-11 终点，含）
    ("t7_d", datetime(2025, 3, 11, 16, 0, 0)),    # Shanghai 03-12 00:00:00（03-12，出 03-11）
]


async def _admin_h(client, session):
    from app.modules.iam.bootstrap import run_bootstrap

    await run_bootstrap(session)
    r = await client.post("/api/v1/auth/login", json={"account": "admin", "password": ADMIN_PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": "Bearer " + r.json()["token"]}


async def _project(client, h, name):
    r = await client.post("/api/v1/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _seed(session, pid):
    """直插 4 行 UTC naive 审计（绕开 record 的 now()，边界必须可控）。"""
    from app.modules.audit.models import AuditLog

    for action, ts in _ROWS:
        session.add(AuditLog(ts=ts, user_id=None, entry="http", action=action, target=pid, ok=True))
    await session.commit()


def _t7(items: list[dict]) -> list[str]:
    """只留夹具行（真实写入也在同一项目里留痕，按 action 前缀筛）。"""
    return sorted(x["action"] for x in items if x["action"].startswith("t7_"))


async def _q(client, h, pid, **params):
    r = await client.get("/api/v1/audit", params={"project_id": pid, "size": 50, **params}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def test_audit_ts_range_shanghai_calendar_day(client, session) -> None:
    """表驱动：纯日期端点 = Shanghai 日历日边界（from 含当日 00:00，to 含当日整天）。"""
    h = await _admin_h(client, session)
    pid = await _project(client, h, "审计区间")
    await _seed(session, pid)

    cases: list[tuple[str, dict, list[str]]] = [
        # (用例, query, 期望的 t7 行)
        ("from=03-11 → 03-11 起全含", {"ts_from": "2025-03-11"}, ["t7_b", "t7_c", "t7_d"]),
        ("to=03-11 → 03-11 整天含", {"ts_to": "2025-03-11"}, ["t7_a", "t7_b", "t7_c"]),
        ("from=to=03-11 → 恰一整天", {"ts_from": "2025-03-11", "ts_to": "2025-03-11"}, ["t7_b", "t7_c"]),
        ("from=03-11,to=03-12 → 跨到 03-12 整天", {"ts_from": "2025-03-11", "ts_to": "2025-03-12"},
         ["t7_b", "t7_c", "t7_d"]),
        ("from=03-10 → 全含", {"ts_from": "2025-03-10"}, ["t7_a", "t7_b", "t7_c", "t7_d"]),
        ("to=03-10 → 只剩 03-10 尾巴", {"ts_to": "2025-03-10"}, ["t7_a"]),
        ("倒挂区间 → 诚实空集，不静默放宽", {"ts_from": "2025-03-12", "ts_to": "2025-03-10"}, []),
    ]
    for label, params, want in cases:
        assert _t7((await _q(client, h, pid, **params))["items"]) == want, label

    # 无区间 = 原游标行为不破：全量 4 行都在
    assert _t7((await _q(client, h, pid))["items"]) == ["t7_a", "t7_b", "t7_c", "t7_d"]


async def test_audit_ts_range_iso_forms(client, session) -> None:
    """完整 ISO：aware 按其偏移；naive 视为 Shanghai 本地（与展示口径同尺，不是当 UTC）。"""
    h = await _admin_h(client, session)
    pid = await _project(client, h, "审计区间ISO")
    await _seed(session, pid)

    # aware：2025-03-10T16:00Z 正是 Shanghai 03-11 零点 → b 起
    assert _t7((await _q(client, h, pid, ts_from="2025-03-10T16:00:00+00:00"))["items"]) == \
        ["t7_b", "t7_c", "t7_d"]
    # naive 03-11T00:00 = Shanghai 本地零点 = UTC 03-10T16:00 → 与上一条同果（同尺的钉）
    assert _t7((await _q(client, h, pid, ts_from="2025-03-11T00:00:00"))["items"]) == \
        ["t7_b", "t7_c", "t7_d"]
    # aware +08:00 偏移：2025-03-11T00:00+08:00 = UTC 03-10T16:00 → 还是同一条边界
    assert _t7((await _q(client, h, pid, ts_from="2025-03-11T00:00:00+08:00"))["items"]) == \
        ["t7_b", "t7_c", "t7_d"]

    # 坏格式 → 400 bad_request：静默忽略筛选 = 假装查了整段历史
    r = await client.get("/api/v1/audit", params={"project_id": pid, "ts_from": "16/03/2025"}, headers=h)
    assert r.status_code == 400 and r.json()["code"] == "bad_request", r.text


async def test_audit_ts_range_with_cursor(client, session) -> None:
    """区间 + 游标合用：翻页只翻区间内的行，不重不漏。"""
    h = await _admin_h(client, session)
    pid = await _project(client, h, "审计区间翻页")
    await _seed(session, pid)

    r1 = await client.get("/api/v1/audit",
                          params={"project_id": pid, "size": 1, "ts_from": "2025-03-11", "ts_to": "2025-03-11"},
                          headers=h)
    assert r1.status_code == 200, r1.text
    page1 = r1.json()
    assert page1["next_cursor"]
    r2 = await client.get("/api/v1/audit",
                          params={"project_id": pid, "size": 1, "ts_from": "2025-03-11", "ts_to": "2025-03-11",
                                  "cursor": page1["next_cursor"]},
                          headers=h)
    page2 = r2.json()
    got = sorted([page1["items"][0]["action"], page2["items"][0]["action"]])
    assert got == ["t7_b", "t7_c"], "区间+游标翻页越界或重复：" + str(got)
    assert not page2["next_cursor"], "03-11 只有两行，第二页不该还有游标"


async def test_audit_403_role_matrix(client, session, make_user) -> None:
    """D23 权限位回归四角色矩阵：只有 SYSTEM_ADMIN 可读，其余三角色一律 403。

    READONLY 的 `*:read` 后缀 glob 能命中 system:audit:read（`system:audit:read`.endswith(":read")）——
    挡住它的是两道闸：iam 解析出口的 -system:* 显式拒绝（R30）+ audit_list 体内的
    is_system_admin 身份门（D23）。矩阵钉的是「合起来必须 403」。
    """
    from app.modules.iam.models import ProjectMember

    h = await _admin_h(client, session)
    pid = await _project(client, h, "矩阵项目")
    assert (await client.get("/api/v1/audit", params={"project_id": pid}, headers=h)).status_code == 200

    for role in ("READONLY", "MEMBER", "PROJECT_ADMIN"):
        u, hu = await make_user("t7_" + role.lower())
        session.add(ProjectMember(project_id=pid, user_id=u.id, role_code=role))
        await session.commit()
        r = await client.get("/api/v1/audit", params={"project_id": pid}, headers=hu)
        assert r.status_code == 403, role + " 必须 403，实得 " + str(r.status_code) + " " + r.text
        # 平台级（不带 project_id）同样进不来
        r2 = await client.get("/api/v1/audit", headers=hu)
        assert r2.status_code == 403, role + " 平台级审计必须 403"


async def test_audit_d23_gate_load_bearing(session) -> None:
    """D23 身份门的单独证据：即使 perms 泄漏成 {"*"}（glob/解析器漂移的极端形状），
    is_system_admin=False 也必须 403——权限位集合挡不住的，身份门挡。

    这条是变异自证的靶子：把 audit_list 里的 is_system_admin 检查删掉，它就红。
    """
    import pytest

    from app.core.errors import ApiError
    from app.core.service import ServiceCtx
    from app.modules.audit.services import AuditListIn, audit_list

    ctx = ServiceCtx(entry="http", user_id="u-x", db=session,
                     is_system_admin=False, perms={"*"})
    with pytest.raises(ApiError) as ei:
        await audit_list(AuditListIn(), ctx)
    assert ei.value.http_status == 403


async def test_audit_list_not_agent_tool() -> None:
    """D29：audit_list tool=False——业主核查 Pilot 的镜子不进 Pilot 自己的工具面。"""
    from app.core.registry import REGISTRY

    spec = REGISTRY.get("audit_list")
    assert spec is not None
    assert spec.tool is False, "审计查询暴露为 Agent 工具（D29 违例）"
    assert REGISTRY.list_tools({"*"}) is not None
    assert "audit_list" not in {t.name for t in REGISTRY.list_tools({"*"})}


async def test_audit_entry_schedule_enum_exposed(client, session) -> None:
    """入口枚举对前端可筛：entry=schedule 是合法入参（T1 前空集，但词表必须通）。"""
    h = await _admin_h(client, session)
    pid = await _project(client, h, "入口枚举")
    r = await client.get("/api/v1/audit", params={"project_id": pid, "entry": "schedule"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []
    # 词表外的入口仍是 422 校验错（枚举没有放宽成大字符串）
    r2 = await client.get("/api/v1/audit", params={"project_id": pid, "entry": "cron"}, headers=h)
    assert r2.status_code == 422
