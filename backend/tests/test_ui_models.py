"""1C 三表（ui_module / ui_element / ui_case）的模型与迁移守卫（计划 T2）。

这里测的是**列的存在与默认值**，不是业务规则（业务规则在 T5/T6 的服务面测）。
三类断言各有意图：
- 唯一键：`uq_ui_element_project_name` 撞名要拦、跨项目同名要放行——元素是扁平命名空间，
  引用检测按名字找人，同名跨模块是灾难（计划 R106 的前提）。
- 默认值：`project_public=True` 尤其关键。`shared/visibility.py` 读的是
  `getattr(row, "project_public", True)`——**漏建这一列不报错，直接把每一行当成公开**，
  那是静默失效，只能在这里钉住。
- 迁移链：`down_revision == "0017"` 且全库只有一个头（多头时 alembic 各升各的，
  表现为「演示库里莫名其妙少一张表」）。
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app.modules.ui_test.models import UiCase, UiElement, UiModule


@pytest_asyncio.fixture()
async def two_projects(session):
    from app.modules.iam.models import Project

    a = Project(name="项目A")
    b = Project(name="项目B")
    session.add_all([a, b])
    await session.commit()
    return a.id, b.id


async def test_three_tables_roundtrip(session, two_projects) -> None:
    pid, _other = two_projects
    mod = UiModule(project_id=pid, name="登录模块")
    session.add(mod)
    await session.commit()

    el = UiElement(project_id=pid, module_id=mod.id, name="账号框",
                   locator_type="id", locator="account", comment="登录页账号输入框")
    session.add(el)
    await session.commit()

    case = UiCase(project_id=pid, module_id=mod.id, name="演示登录",
                  steps=[{"id": "u1", "type": "open", "value": "${base_url}/ui/login"}])
    session.add(case)
    await session.commit()

    got = await session.get(UiElement, el.id)
    assert got is not None and got.name == "账号框" and got.locator_type == "id"
    assert (await session.get(UiCase, case.id)).steps[0]["type"] == "open"


async def test_element_name_is_unique_per_project_not_globally(session, two_projects) -> None:
    """同项目撞名必须拦（引用检测按名字找人）；跨项目同名必须放行（项目是隔离边界）。"""
    pid, other = two_projects
    session.add(UiElement(project_id=pid, name="账号框", locator_type="id", locator="account"))
    await session.commit()

    session.add(UiElement(project_id=pid, name="账号框", locator_type="css", locator="#a"))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()

    session.add(UiElement(project_id=other, name="账号框", locator_type="id", locator="account"))
    await session.commit()  # 不抛 = 跨项目同名可行


async def test_defaults_are_the_honest_ones(session, two_projects) -> None:
    """漏建 project_public 不报错而等于「全公开」，所以每个默认值都点名断言。"""
    pid, _ = two_projects
    el = UiElement(project_id=pid, name="e1", locator_type="id", locator="x")
    case = UiCase(project_id=pid, name="c1", steps=[])
    session.add_all([el, case])
    await session.commit()

    assert el.project_public is True, "缺省即公开——visibility.py 的 getattr 默认也是 True，两处必须一致"
    assert el.status == "normal"
    assert case.status == "normal"
    assert case.priority == "P2"
    assert case.enabled == 1, "§11.5.4 列表有「启用」列"
    assert case.step_count == 0, "冗余计数默认 0，列表不 N+1"
    assert case.last_run_at is None and case.last_run_status is None, "没跑过就是没跑过，不是失败"


async def test_ui_case_has_no_version_column() -> None:
    """R104：UI 用例不做乐观锁，与 ApiCase 对齐（两个人同时编辑同一份命令列表的概率
    远低于场景画布，而多一列 version 就多一处「前端忘了带」的静默覆盖）。
    这一条钉的是**决定**：哪天要给 ui_case 加 version，得先改掉这条测试并说明理由。"""
    cols = {c.key for c in UiCase.__table__.columns}
    assert "version" not in cols, "加 version 要走批次决定，不能顺手加"
    assert {"owner_id", "project_public", "steps", "env_id", "module_id"} <= cols


async def test_migration_0018_is_on_the_head_of_the_chain() -> None:
    """迁移链头唯一 + 0018 的父是 0017。多头时 alembic 不报错、各升各的，
    表象是「演示库莫名其妙少一张表」——那是最难归因的一类。"""
    import pathlib
    import re

    versions = pathlib.Path(__file__).resolve().parents[1] / "migrations" / "versions"
    revs, parents = {}, {}
    # versions/__init__.py 是包标记不是迁移，别把它算进链里（glob *.py 会捞到它）
    for f in sorted(p for p in versions.glob("*.py") if p.name != "__init__.py"):
        src = f.read_text(encoding="utf-8")
        # 形如 `revision: str = "0018"` / `down_revision: str | None = "0017"`（也兼容无注解写法）
        m = re.search(r'^revision\b[^=]*=\s*["\']([^"\']+)', src, re.M)
        d = re.search(r'^down_revision\b[^=]*=\s*(?:["\']([^"\']+)["\']|(None))', src, re.M)
        assert m, f"{f.name} 没有 revision 声明"
        assert d, f"{f.name} 没有 down_revision 声明（孤立迁移会让 alembic 静默漏跑）"
        revs[m.group(1)] = f.name
        parents[m.group(1)] = d.group(1) if d.group(1) else None

    assert "0018" in revs, "0018 未建"
    assert parents["0018"] == "0017", f"0018 的父是 {parents['0018']}，应是 0017"
    # 0019（org/workspace 建表）接棒链头时照 0018 的先例更新钉：单多头判定逻辑不变
    assert parents["0019"] == "0018", f"0019 的父是 {parents['0019']}，应是 0018"
    # 0020（adb 三表）接棒链头时同例：改期望值不改判定逻辑
    assert parents["0020"] == "0019", f"0020 的父是 {parents['0020']}，应是 0019"
    # 0021（1E schedule_task/notify_channel/kv_setting）接棒链头时同例：改期望值不改判定逻辑
    assert parents["0021"] == "0020", f"0021 的父是 {parents['0021']}，应是 0020"
    # 0022（D37 custom_role）接棒链头时同例：改期望值不改判定逻辑
    assert parents["0022"] == "0021", f"0022 的父是 {parents['0022']}，应是 0021"
    # 0023（D47-a saved_view）接棒链头时同例：改期望值不改判定逻辑
    assert parents["0023"] == "0022", f"0023 的父是 {parents['0023']}，应是 0022"
    # 0024（D183 plan_record）接棒链头时同例：改期望值不改判定逻辑
    assert parents["0024"] == "0023", f"0024 的父是 {parents['0024']}，应是 0023"
    # 0025（D183 plan_case_link）接棒链头：同款先例，改期望值不改判定逻辑
    assert parents["0025"] == "0024", f"0025 的父是 {parents['0025']}，应是 0024"
    # 0026（D183 plan_report 两表）接棒链头：同款先例，改期望值不改判定逻辑
    assert parents["0026"] == "0025", f"0026 的父是 {parents['0026']}，应是 0025"
    # 0027（D187 defect 两表）→ 0028（D191 缺陷服务面）接棒链头：同款先例，改期望值不改判定逻辑
    assert parents["0027"] == "0026"
    assert parents["0028"] == "0027"
    assert parents["0029"] == "0028"
    assert parents["0030"] == "0029"
    assert parents["0031"] == "0030"
    assert parents["0032"] == "0031"
    assert parents["0033"] == "0032"
    assert parents["0034"] == "0033"
    assert parents["0035"] == "0034"
    assert parents["0036"] == "0035"
    assert parents["0037"] == "0036"
    assert parents["0038"] == "0037"
    # D203/D204/D206 接棒链头：同款先例，改期望值不改判定逻辑
    assert parents["0039"] == "0038"
    assert parents["0040"] == "0039"
    assert parents["0041"] == "0040"
    assert parents["0042"] == "0041"
    assert parents["0044"] == "0043"
    # D262→D269 接棒链头：同款先例，改期望值不改判定逻辑
    assert parents["0045"] == "0044"
    assert parents["0046"] == "0045"
    assert parents["0047"] == "0046"
    assert parents["0048"] == "0047"
    assert parents["0049"] == "0048"
    assert parents["0050"] == "0049"
    assert parents["0051"] == "0050"
    assert parents["0052"] == "0051"
    assert parents["0053"] == "0052"
    assert parents["0054"] == "0053"
    assert parents["0055"] == "0054"
    assert parents["0056"] == "0055"
    assert parents["0059"] == "0058"
    assert parents["0060"] == "0059"
    chain = set(parents.values()) - {None}
    heads = set(revs) - chain
    assert heads == {"0060"}, f"链头应为唯一 0060，实际 {sorted(heads)}（多头 = 各升各的）"


async def test_tables_actually_exist_in_the_migrated_db(conn) -> None:
    """模型声明了不等于库里有——alembic 漏跑时模型测试照样绿（模型测试不碰 DDL）。
    这一条走真 connection 查 information_schema，是「迁移真的执行过」的证据。

    Inspector 的反射是**惰性 IO**，必须在 run_sync 的 greenlet 里取完：
    `insp = await conn.run_sync(inspect)` 再在外面调 get_table_names() 会炸
    MissingGreenlet（我踩过，写法留在这里当反例）。
    """
    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "element_cols": {c["name"] for c in insp.get_columns("ui_element")},
            "case_idx": {i["name"] for i in insp.get_indexes("ui_case")},
            "element_uq": {c["name"] for c in insp.get_unique_constraints("ui_element")},
        }

    got = await conn.run_sync(_read)
    for t in ("ui_module", "ui_element", "ui_case"):
        assert t in got["tables"], f"库里没有 {t}（alembic 没升到 0018？）"
    assert {"owner_id", "project_public", "locator_type", "locator", "comment"} <= got["element_cols"]
    assert got["case_idx"], "ui_case 一个索引都没有 = 列表查询全表扫"
    assert "uq_ui_element_project_name" in got["element_uq"]
    await conn.execute(text("SELECT 1"))
