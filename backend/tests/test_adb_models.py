"""1D 三表（adb_device / adb_module / adb_case）的模型与迁移守卫（计划 T2）。

与 1C 的 test_ui_models.py 同构——测**列的存在与默认值**，不是业务规则（业务规则在
T4/T5 的服务面测）。四条钉各有意图：
- 唯一键：adb_case/adb_device project 内（name）同名唯一、跨项目同名放行（项目是隔离
  边界，引用检测按名字找人）。adb_module 的根层重名 DB 管不住（MySQL 唯一键不判等
  NULL），归服务层自查，这里不断言（照 0016/0018 原话）。
- 默认值：project_public=True 关键——visibility.py 读 getattr(row, "project_public", True)，
  漏建不报错而等于「全公开」，静默失效只能在这里钉住（计划 T2 点名）。
- connect_type 默认 wifi：D14 说 USB 写入口一期 422，收敛到服务层；模型的缺省必须诚实。
- 迁移链：链条唯一 + 0020 的父是 0019（多头时 alembic 各升各的，表象是「演示库莫名其
  妙少一张表」）。
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app.modules.adb_test.models import AdbCase, AdbDevice, AdbModule


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
    dev = AdbDevice(project_id=pid, name="真机一号", serial="192.168.1.50:5555",
                    connect_type="wifi", wifi_addr="192.168.1.50", enabled=1)
    session.add(dev)
    await session.commit()

    mod = AdbModule(project_id=pid, name="手机核心链路")
    session.add(mod)
    await session.commit()

    case = AdbCase(project_id=pid, module_id=mod.id, name="登录下单",
                   default_device="192.168.1.50:5555",
                   steps=[{"id": "a1", "type": "home", "pre_wait_ms": 0}])
    session.add(case)
    await session.commit()

    got = await session.get(AdbDevice, dev.id)
    assert got is not None and got.name == "真机一号" and got.serial == "192.168.1.50:5555"
    assert (await session.get(AdbCase, case.id)).default_device == "192.168.1.50:5555"
    assert (await session.get(AdbCase, case.id)).steps[0]["type"] == "home"


async def test_case_name_is_unique_per_project_not_globally(session, two_projects) -> None:
    """同项目撞名必须拦（引用检测按名字找人）；跨项目同名必须放行。"""
    pid, other = two_projects
    session.add(AdbCase(project_id=pid, name="下单", steps=[]))
    await session.commit()

    session.add(AdbCase(project_id=pid, name="下单", steps=[]))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()

    session.add(AdbCase(project_id=other, name="下单", steps=[]))
    await session.commit()  # 不抛 = 跨项目同名可行


async def test_defaults_are_the_honest_ones(session, two_projects) -> None:
    """每个默认值都点名断言——尤其 project_public。"""
    pid, _ = two_projects
    dev = AdbDevice(project_id=pid, name="d1", serial="10.0.0.1:5555")
    case = AdbCase(project_id=pid, name="c1", steps=[])
    session.add_all([dev, case])
    await session.commit()

    assert dev.project_public is True, "缺省即公开——visibility.py 的 getattr 默认也是 True"
    assert dev.status == "normal"
    assert dev.enabled == 1
    assert dev.connect_type == "wifi", "D14：USB 写入口一期 422，模型缺省必须诚实落在 wifi"
    assert case.status == "normal"
    assert case.priority == "P2"
    assert case.enabled == 1
    assert case.step_count == 0
    assert case.last_run_at is None and case.last_run_status is None, "没跑过就是没跑过"
    assert case.default_device is None, "default_device 留空 = 空闲即可（§4.5）"


async def test_device_has_no_version_column() -> None:
    """R104 同款：adb 用例/设备都不做乐观锁。多一列 version 就多一处「前端忘了带」的静默
    覆盖；这条钉的是**决定**，谁要加得先改掉它再说理由。"""
    device_cols = {c.key for c in AdbDevice.__table__.columns}
    case_cols = {c.key for c in AdbCase.__table__.columns}
    assert "version" not in device_cols and "version" not in case_cols
    assert {"owner_id", "project_public", "serial", "connect_type", "last_state"} <= device_cols
    assert {"owner_id", "project_public", "default_device", "steps", "module_id"} <= case_cols


async def test_migration_0020_is_on_the_head_of_the_chain() -> None:
    """迁移链头唯一 + 0020 的父是 0019（多头 = 各升各的）。"""
    import pathlib
    import re

    versions = pathlib.Path(__file__).resolve().parents[1] / "migrations" / "versions"
    revs, parents = {}, {}
    for f in sorted(p for p in versions.glob("*.py") if p.name != "__init__.py"):
        src = f.read_text(encoding="utf-8")
        m = re.search(r'^revision\b[^=]*=\s*["\']([^"\']+)', src, re.M)
        d = re.search(r'^down_revision\b[^=]*=\s*(?:["\']([^"\']+)["\']|(None))', src, re.M)
        assert m, f"{f.name} 没有 revision 声明"
        assert d, f"{f.name} 没有 down_revision 声明（孤立迁移会让 alembic 静默漏跑）"
        revs[m.group(1)] = f.name
        parents[m.group(1)] = d.group(1) if d.group(1) else None

    assert parents["0020"] == "0019", f"0020 的父是 {parents['0020']}，应是 0019"
    # 0021（1E 三表）接棒链头：同 test_ui_models 的先例，只改期望值不改判定逻辑
    assert parents["0021"] == "0020", f"0021 的父是 {parents['0021']}，应是 0020"
    # 0022（D37 custom_role）接棒链头：同款先例
    assert parents["0022"] == "0021", f"0022 的父是 {parents['0022']}，应是 0021"
    # 0023（D47-a saved_view）接棒链头：同款先例，改期望值不改判定逻辑
    assert parents["0023"] == "0022", f"0023 的父是 {parents['0023']}，应是 0022"
    # 0024（D183 plan_record）接棒链头：同款先例，改期望值不改判定逻辑
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
    """模型声明了不等于库里有——alembic 漏跑时模型测试照样绿。真 connection 查
    information_schema，是「迁移真的执行过」的证据。"""

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "device_cols": {c["name"] for c in insp.get_columns("adb_device")},
            "case_uq": {c["name"] for c in insp.get_unique_constraints("adb_case")},
        }

    got = await conn.run_sync(_read)
    for t in ("adb_device", "adb_module", "adb_case"):
        assert t in got["tables"], f"库里没有 {t}（alembic 没升到 0020？）"
    assert {"owner_id", "project_public", "serial", "connect_type", "wifi_addr",
            "last_state"} <= got["device_cols"]
    assert "uq_adb_case_project_name" in got["case_uq"]
    await conn.execute(text("SELECT 1"))
