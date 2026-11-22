"""1C 的工具面 / 权限面 / 契约回归 + 种子幂等（T3 契约段，T20 种子段，T21 补全六项）。

T21 的六项照 `test_tool_surface_1b.py:3-11` 逐条对偶：
  ① ui_element_* / ui_case_* / ui_module_* 在 admin 工具面，effect 口径钉死；
  ② purge / refs / resolve 这些 tool=False 的内部件不许漏进工具面；
  ③ PLAN 门拒 ui_case_run（effect=write）、放行 ui_case_list（门按 effect）；
  ④ perm_point 表同步出 ui:* 全集（含 module/element/case 三支与 run/debug），sync 幂等；
  ⑤ READONLY 双层：工具面不见写工具 + HTTP 层写 403、读 200；
  ⑥ 契约登记：ui_test 在契约 1 与 3，search 仍**不在**契约 1（composition 反向钉）。
"""
from __future__ import annotations

NEW_TOOLS = [
    "ui_module_tree", "ui_module_create", "ui_module_update", "ui_module_delete",
    "ui_module_restore",
    "ui_element_list", "ui_element_create", "ui_element_get", "ui_element_update",
    "ui_element_delete", "ui_element_restore",
    "ui_case_list", "ui_case_create", "ui_case_get", "ui_case_update",
    "ui_case_delete", "ui_case_restore", "ui_case_references",
    "ui_case_debug", "ui_case_run",
]
NOT_TOOLS = ["ui_element_purge", "ui_case_purge", "ui_element_refs", "ui_case_resolve",
             "ui_module_purge", "ui_case_refs"]


async def _setup(client, make_user, tag, *, admin=False):
    boss, hb = await make_user(("ts1csys" if admin else "ts1cboss") + tag, admin=admin)
    r = await client.post("/api/v1/projects", json={"name": "pt1c" + tag}, headers=hb)
    return boss, hb, r.json()["id"]


async def test_1c_tool_surface(client, make_user) -> None:
    """①+② 1C 工具在 admin 工具面、effect 口径钉死；tool=False 的内部件必须缺席。"""
    _, h, pid = await _setup(client, make_user, "A", admin=True)
    r = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    by_name = {t["name"]: t for t in r.json()["items"]}
    for n in NEW_TOOLS:
        assert n in by_name, "工具面缺失: " + n
    # effect 口径：计划点名 run/debug=write、delete=destructive；读面顺手钉 read
    assert by_name["ui_case_run"]["effect"] == "write"
    assert by_name["ui_case_debug"]["effect"] == "write"
    assert by_name["ui_case_delete"]["effect"] == "destructive"
    assert by_name["ui_element_delete"]["effect"] == "destructive"
    assert by_name["ui_module_delete"]["effect"] == "destructive"
    assert by_name["ui_case_list"]["effect"] == "read"
    for n in NOT_TOOLS:
        assert n not in by_name, "tool=False 的工具漏进了工具面: " + n


async def test_1c_plan_mode_rejects_run(client, session, make_user) -> None:
    """③ PLAN 拒 ui_case_run、放行 ui_case_list（门按 effect，不一刀切）。"""
    from app.core.service import ServiceCtx
    from app.modules.agent.dispatcher import ToolDispatcher

    boss, _h, pid = await _setup(client, make_user, "B")
    disp = ToolDispatcher(session)
    ctx = ServiceCtx(entry="agent", user_id=boss.id, perms={"*"}, db=session)
    r = await disp.call("ui_case_run", {"project_id": pid, "case_id": "x"},
                        ctx, mode="PLAN", grants=set())
    assert r.ok is False and "只读" in (r.error or "")
    r2 = await disp.call("ui_case_list", {"project_id": pid}, ctx,
                         mode="PLAN", grants=set())
    assert r2.ok is True, r2.error


async def test_1c_perm_points_synced(session) -> None:
    """④ sync_perm_points 把 ui:*（module/element/case 三支 + run/debug）全落库，且幂等。"""
    from sqlalchemy import select

    from app.core.registry import REGISTRY
    from app.modules.iam.models import PermPoint
    from app.modules.iam.registry_sync import sync_perm_points

    n = await sync_perm_points(session)
    assert n > 0
    codes = {r for (r,) in (await session.execute(select(PermPoint.code))).all()}
    for p in ("ui:module:read", "ui:module:create", "ui:module:update", "ui:module:delete",
              "ui:element:read", "ui:element:create", "ui:element:update",
              "ui:element:delete",
              "ui:case:read", "ui:case:create", "ui:case:update", "ui:case:delete",
              "ui:case:run", "ui:case:debug"):
        assert p in codes, "权限点未入库: " + p
    ui = {c for c in codes if c.startswith("ui:")}
    assert REGISTRY.perm_points() <= codes
    assert {p for p in REGISTRY.perm_points() if p.startswith("ui:")} == ui, \
        "ui:* 全集应与注册表声明一致，不许多也不许少"
    assert await sync_perm_points(session) == 0  # 幂等


async def test_1c_readonly_can_read_cannot_write(client, make_user) -> None:
    """⑤ READONLY：UI 读工具可见可呼，写工具不可见（HTTP 层 403 兜底）。"""
    _, h, pid = await _setup(client, make_user, "C")
    ro, ho = await make_user("ts1cro")
    await client.put("/api/v1/projects/" + pid + "/members/" + ro.id,
                     json={"role_code": "READONLY"}, headers=h)
    r = await client.get("/api/v1/agent/tools", params={"project_id": pid}, headers=ho)
    assert r.status_code == 200, r.text
    names = {t["name"] for t in r.json()["items"]}
    assert {"ui_case_list", "ui_element_list", "ui_module_tree"} <= names
    assert not any(n.startswith("ui_") and not n.endswith(
        ("_list", "_get", "_tree", "_references")) for n in names), names
    # 工具面只是声明；执行面必须同样拦住
    rr = await client.post("/api/v1/ui-cases/nope/run", headers=ho,
                           json={"project_id": pid})
    assert rr.status_code == 403, rr.text
    rl = await client.get("/api/v1/ui-cases", params={"project_id": pid}, headers=ho)
    assert rl.status_code == 200, rl.text
    re_ = await client.get("/api/v1/ui-elements", params={"project_id": pid}, headers=ho)
    assert re_.status_code == 200, re_.text


# —— ⑥ 契约登记：ui_test 在两个清单里，search 不许混进契约 1 ——————————————

def _pyproject_contracts() -> dict:
    import tomllib
    from pathlib import Path

    p = Path(__file__).resolve().parents[1] / "pyproject.toml"
    data = tomllib.loads(p.read_text(encoding="utf-8"))
    return {c["name"]: c for c in data["tool"]["importlinter"]["contracts"]}


def test_1c_contract_membership_not_undercounted() -> None:
    """⑥ ui_test 的登记事实：清单少一个名字，「4 kept」就是漏数撑出来的假绿。

    - 契约 1（modules 之间只经 service/事件总线互调）必须含 `app.modules.ui_test`：
      漏了它，ui_test 与 api_test/iam/scenario 的横向 import 无人看守；
    - 契约 3（领域模块不得反向依赖 agent）必须含 ui_test：ui_test 是领域模块，
      不是 composition 层，它认识 agent 就等于把业务复用能力废掉（R26）；
    - **反向钉**：ui_test 不许出现在契约 2（core 不得依赖 modules）与契约 4
      （execution 依赖闭包最小）的 source 侧——那两条是包级 glob（`app.modules` /
      `app.modules.execution`），逐名列举业务模块反而是外行做法（列了也不生效，
      只会让人以为「我登记过了」）；
    - **composition 反向钉（1b:127-128,140 同款）**：search 是 composition 层
      （与 agent 同类，R26），不许进契约 1，但必须在契约 3 的 source 侧。
    """
    cs = _pyproject_contracts()
    ind = next(c for c in cs.values() if c["type"] == "independence")
    assert "app.modules.ui_test" in set(ind["modules"]), \
        "契约 1 漏登记 ui_test：独立性契约根本不扫它，kept 是假绿"

    forbidden = [c for c in cs.values() if c["type"] == "forbidden"]
    agent_c3 = next(c for c in forbidden if c["forbidden_modules"] == ["app.modules.agent"])
    assert "app.modules.ui_test" in agent_c3["source_modules"], "契约 3 漏登记 ui_test"
    assert "app.modules.search" in agent_c3["source_modules"], "契约 3 漏登记 search"
    assert "app.modules.search" not in set(ind["modules"]), \
        "search 是 composition 层（正向读领域模型），进契约 1 必假炸"

    core_c2 = next(c for c in forbidden if c["source_modules"] == ["app.core"])
    exec_c4 = next(c for c in forbidden if c["source_modules"] == ["app.modules.execution"])
    for c in (core_c2, exec_c4):
        blob = str(c)
        assert "ui_test" not in blob, \
            f"契约「{c['name']}」是包级 glob，不该逐名列举 ui_test（写了也不生效，纯误导）"


def test_contract_count_is_still_four() -> None:
    """加登记**不改契约条数**。这条防的是「顺手开了第五个契约」：
    门禁认的是 lint-imports 打印的 `Contracts: 4 kept, 0 broken` 那句原话
    （README 立的规矩：只认打印文字，exit code 不算证据；也绝不能用
    `-m importlinter.cli lint`，那是静默空跑的陷阱）。
    真跑 lint 由门禁/CI 做，本测试钉的是 pyproject 里的条数——漂移在这里先红。
    """
    assert len(_pyproject_contracts()) == 4, "契约条数变了：门禁认的 4 kept 要连带改写"


# ══════════════════════════ T20 种子段（照 test_tool_surface_1b.py:166-202）══════════


def _load_seed():
    import importlib.util
    from pathlib import Path

    p = Path(__file__).resolve().parents[1] / "scripts" / "seed_demo.py"
    spec = importlib.util.spec_from_file_location("seed_demo_t20", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_seed_demo_ui_steps_pass_protocol_gate() -> None:
    """演示 UI 用例的命令序列必须先过 §7.2 协议门（纯函数、无 DB）。

    种子走公开服务时 `_gate` 会跑同一份 validate_commands——协议上有问题在用例
    落库之前就该在这里红，而不是到 seed 实跑才撞 422。
    """
    from app.modules.ui_test.commands import validate_commands

    mod = _load_seed()
    eids = {name: "el-" + name for name, _, _ in mod.DEMO_UI_ELEMENTS}
    steps = mod.demo_ui_steps(eids)
    assert validate_commands(steps) == [], "演示命令必须零 issue：" + str(validate_commands(steps))
    types = [s["type"] for s in steps]
    # 打开 → 输入 → 输入 → 点击 → 断言文本「工作台」→ wait_element 演示慢元素
    assert types == ["open", "input", "input", "click", "assert_text", "wait_element"], types


async def _asset_counts(session) -> dict:
    """全资产计数快照：跑第二遍前后必须逐键相等（1b:189-198 的断言形状，扩到全表）。"""
    from sqlalchemy import func, select

    from app.modules.api_test.models import ApiCase, ApiDefinition, ApiModule, DataSet
    from app.modules.env.models import Environment, GlobalConfig
    from app.modules.iam.models import Project, ProjectMember, User
    from app.modules.model_cfg.models import ModelConfig
    from app.modules.scenario.models import Scenario
    from app.modules.ui_test.models import UiCase, UiElement, UiModule

    out = {}
    for label, model in (("project", Project), ("user", User), ("member", ProjectMember),
                         ("global_cfg", GlobalConfig), ("env", Environment),
                         ("api_module", ApiModule), ("api_def", ApiDefinition),
                         ("api_case", ApiCase), ("dataset", DataSet), ("scenario", Scenario),
                         ("model_cfg", ModelConfig),
                         ("ui_module", UiModule), ("ui_element", UiElement), ("ui_case", UiCase)):
        out[label] = await session.scalar(select(func.count()).select_from(model))
    return out


async def test_seed_demo_ui_idempotent(client, make_user, session) -> None:
    """T20 种子幂等：UI 演示模块 + 恰好 4 元素 + 恰好 1 条 UI 用例，跑两遍不多不少，
    **其他任何资产计数不变**。

    跑在测试库（conftest 已把 TP_DB_URL 指到本轮 schema；seed 用全局 maker）。
    第二遍读计数前先 rollback——REPEATABLE-READ 下不结束事务，读到的是旧快照，
    「没重复建」会被假证明（这条比 1b 原型的读法更严）。
    """
    from sqlalchemy import select

    from app.modules.iam.models import Project
    from app.modules.ui_test.commands import validate_commands
    from app.modules.ui_test.models import UiCase, UiElement, UiModule

    mod = _load_seed()

    assert await mod.main() == 0
    proj = (await session.execute(select(Project).where(Project.name == mod.DEMO_PROJECT))).scalar_one()
    pid = proj.id  # 标量先取：rollback 过期 ORM 实例后再碰属性就是 MissingGreenlet
    mods = (await session.execute(select(UiModule).where(
        UiModule.project_id == pid, UiModule.name == mod.UI_MODULE_DEMO))).scalars().all()
    assert len(mods) == 1, "第一遍应建且仅建一个 UI 演示模块"
    assert mods[0].parent_id is None, "「UI 演示」必须挂在元素库树根下"
    els = (await session.execute(select(UiElement).where(
        UiElement.project_id == pid))).scalars().all()
    assert len(els) == 4, "演示元素恰好 4 个，实际 " + str(len(els))
    assert {e.name for e in els} == {n for n, _, _ in mod.DEMO_UI_ELEMENTS}
    cases = (await session.execute(select(UiCase).where(
        UiCase.project_id == pid, UiCase.name == mod.DEMO_UI_CASE))).scalars().all()
    assert len(cases) == 1
    c = cases[0]
    c_id = c.id  # 标量先取：后面 rollback 会过期 ORM 实例，再碰属性就是 MissingGreenlet
    assert validate_commands(c.steps) == [], "落库的演示用例必须过协议门"
    assert c.step_count == 6 and c.env_id is not None
    by_name = {e.name: e.id for e in els}
    for step in c.steps:
        if "element_id" in step:
            assert step["element_id"] in set(by_name.values()), "命令引用了种下之外的元素"
    before = await _asset_counts(session)
    assert before["ui_element"] == 4 and before["ui_case"] == 1

    await session.rollback()  # 结束读事务，让第二遍的读看到新快照
    assert await mod.main() == 0
    await session.rollback()
    after = await _asset_counts(session)
    assert after == before, "第二遍不许动任何资产计数：" + str(
        {k: (before[k], after[k]) for k in before if before[k] != after[k]})
    # 只回 id 标量：同一 session 的 identity map 会把命中行返回成已过期的旧实例，
    # 碰它的属性就是 greenlet 外的惰性刷新（MissingGreenlet）
    ids = (await session.execute(select(UiCase.id).where(
        UiCase.project_id == pid, UiCase.name == mod.DEMO_UI_CASE))).scalars().all()
    assert len(ids) == 1 and ids[0] == c_id, "第二遍不许重复建用例（幂等承诺）"


async def test_seed_demo_ui_owner_is_project_member(client, make_user, session) -> None:
    """种子的 UI 资产 owner 必须落在**项目成员**身上——「负责人」列靠成员表换名字。

    真走查量出来的缺陷：旧版种子拿 bootstrap admin 建（系统管理员，不是这个项目的成员行），
    前端那列查不到名字就回落 uuid，于是元素库与 UI 用例列表的「负责人」整列是 36 位串——
    演示数据在演示页面上自己难看（纪律 1 的反面：不是假数据，是难看且没法解释的数据）。
    顺带钉住「种子和人同权限档位」的连带后果：ctx 现在用 demo_pm 在项目里真实那套权限
    （`perms_for`），首跑时 ProjectMember 只 db.add 过而会话 autoflush=False，
    不先 flush 就取权限会拿到空集，种子在自己第一道权限门上摔死——本用例跑全新库，
    那个 bug 在这里就是红。
    """
    from sqlalchemy import select

    from app.modules.iam.models import Project, ProjectMember, User
    from app.modules.ui_test.models import UiCase, UiElement

    mod = _load_seed()
    assert await mod.main() == 0
    await session.rollback()

    pid = (await session.execute(select(Project.id).where(
        Project.name == mod.DEMO_PROJECT))).scalar_one()
    pm_id = (await session.execute(select(User.id).where(User.account == "demo_pm"))).scalar_one()
    member_of = set((await session.execute(
        select(ProjectMember.user_id).where(ProjectMember.project_id == pid))).scalars().all())
    assert pm_id in member_of, "demo_pm 必须是演示项目的成员（不然这测试钉的就是空话）"

    owners = set((await session.execute(
        select(UiElement.owner_id).where(UiElement.project_id == pid))).scalars().all())
    case_owner = (await session.execute(select(UiCase.owner_id).where(
        UiCase.project_id == pid, UiCase.name == mod.DEMO_UI_CASE))).scalar_one()
    assert owners and owners <= member_of, "元素负责人必须都是项目成员，实际 " + str(owners)
    assert case_owner in member_of, "UI 用例负责人必须是项目成员"
    assert owners == {case_owner} == {pm_id}, "演示 UI 资产统一挂在 demo_pm 名下（负责人列显示同一个人）"
