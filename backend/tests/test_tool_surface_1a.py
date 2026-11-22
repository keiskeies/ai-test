"""T11 工具面回归钉：1A 新工具必须同时出现在注册表/HTTP 面/权限表（§9 一鱼四吃不再漂）。"""
from __future__ import annotations

NEW_TOOLS = [
    "api_definition_list", "api_definition_get", "api_debug",
    "api_module_tree", "api_module_create", "api_module_update",
    "api_module_delete", "api_module_restore",
    "api_case_list", "api_case_get", "api_case_create",
    "api_case_update", "api_case_delete",
    "data_set_list", "data_set_create", "data_set_update", "data_set_delete",
    "run_record_list", "run_get",
    "global_config_get", "global_config_update",
    "user_list", "user_create", "user_update", "user_status",
    "password_change_self", "role_template_list",
]


async def _setup(client, make_user, tag, *, admin=False):
    boss, hb = await make_user(("ts11sys" if admin else "ts11boss") + tag, admin=admin)
    r = await client.post("/api/v1/projects", json={"name": "pt11" + tag}, headers=hb)
    return boss, hb, r.json()["id"]


async def test_registry_surface_complete(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "A", admin=True)  # 系统管理员见全量工具面
    r = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    by_name = {t["name"]: t for t in r.json()["items"]}
    for n in NEW_TOOLS:
        assert n in by_name, "工具面缺失: " + n
    assert by_name["api_debug"]["effect"] == "write"
    assert by_name["api_case_delete"]["effect"] == "destructive"
    assert "env_resolve" not in by_name  # 跨模块内部件不外露


async def test_plan_gate_on_debug(client, session, make_user) -> None:
    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import ToolDispatcher

    boss, h, pid = await _setup(client, make_user, "B")
    disp = ToolDispatcher(session)
    ctx = ServiceCtx(entry="agent", user_id=boss.id, perms={"*"}, db=session)
    r = await disp.call("api_debug", {"project_id": pid,
                           "request": {"method": "GET", "url": "http://t/x"}},
                        ctx, mode="PLAN", grants=set())
    assert r.ok is False and "只读" in (r.error or "")
    # 只读工具在 PLAN 下可用（证明门按 effect 而非一刀切）
    r2 = await disp.call("api_module_tree", {"project_id": pid}, ctx, mode="PLAN", grants=set())
    assert r2.ok is True, r2.error


async def test_project_admin_surface_excludes_system(client, make_user) -> None:
    # 项目管理员显式拒 system:* → 项目工具面不含平台级工具（§9.4）
    _, h, pid = await _setup(client, make_user, "E")
    r = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=h)
    names = {t["name"] for t in r.json()["items"]}
    assert "api_debug" in names and "user_list" not in names and "user_create" not in names


async def test_readonly_member_tool_view(client, make_user) -> None:
    _, h, pid = await _setup(client, make_user, "C")
    ro, ho = await make_user("ts11ro")
    await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                     json={"role_code": "READONLY"}, headers=h)
    r = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=ho)
    items = r.json()["items"]
    names = {t["name"] for t in items}
    assert "run_record_list" in names and "api_definition_list" in names
    assert all(t["effect"] == "read" for t in items), [t for t in items if t["effect"] != "read"]
    assert "api_debug" not in names and "user_create" not in names
    # R30 第二半：项目角色里的 `*:read` 后缀通配不得盖住平台级读位（system:user:read /
    # system:audit:read）——工具声明与 runner 的执行 ctx 同源，这里挡住就是执行也挡住。
    assert "user_list" not in names, "只读成员能让 Pilot 列出全平台账号"
    assert "audit_list" not in names, "只读成员能翻审计"
    leaked = [x["name"] for x in items if x["perm"].startswith("system:")]
    assert not leaked, "项目角色漏出了平台级工具：" + str(leaked)


async def test_perm_points_synced(session) -> None:
    from sqlalchemy import select

    from app.core.registry import REGISTRY
    from app.modules.iam.models import PermPoint
    from app.modules.iam.registry_sync import sync_perm_points

    n = await sync_perm_points(session)
    assert n > 0
    codes = {r for (r,) in (await session.execute(select(PermPoint.code))).all()}
    for p in ("api:case:create", "api:dataset:read", "api:module:delete",
              "api:debug:run", "api:run:read", "system:user:create", "auth:password:self"):
        assert p in codes, "权限点未入库: " + p
    assert REGISTRY.perm_points() <= codes
    # 幂等：再同步一次零新增
    assert await sync_perm_points(session) == 0


async def test_seed_script_shape() -> None:
    # seed 面向开发库（不在测试库断言数据），这里钉脚本形态与幂等设计
    import importlib.util
    from pathlib import Path

    p = Path(__file__).resolve().parents[1] / "scripts" / "seed_demo.py"
    spec = importlib.util.spec_from_file_location("seed_demo", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert callable(mod.main) and len(mod.DEMO_APIS) == 3
    assert mod.DATASET and mod.MODULE_TOP and mod.MODULE_SUB
    # 定义 URL 必须走变量层（演示"环境切换不改用例"）
    assert all("${base_url}" in mod._req(x[2])["url"] for x in mod.DEMO_APIS)