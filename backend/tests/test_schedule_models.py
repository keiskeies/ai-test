"""1E 三表（schedule_task / notify_channel / kv_setting）的模型与迁移守卫（计划 T0）。

与 1C/1D 的同名守卫同构——测**列的存在与默认值**，不是业务规则（cron 校验、引用检测、
加密回显都在 T1/T2 的服务面测）。六条钉各有意图：
- roundtrip：JSON 载体（notify_channel_ids/last_run/config/last_send/value）真的能
  写进 MySQL 再原样读回——JSON 列的坑从来不在声明而在方言。
- 默认值逐一点名：enabled=1、consecutive_failures=0、notify_channel_ids=[]、
  两个 last_* 是 None（没跑/没发过就是没跑/没发过）。
- **不顺手抄列**：next_fire_at（D22 未裁）、schedule_task 的 owner_id/project_public、
  notify_channel 的 project_id（平台级配置不是项目资产）都不许存在——谁要加先改计划。
- kv_setting 的 key 唯一：按 key 读出恰好一行是 D25 消费方（心跳间隔）的前提。
- 迁移链：链头唯一 0021 + 父是 0020（多头 = alembic 各升各的）。
- information_schema 真表在：模型声明了不等于库里有（alembic 漏跑时模型测试照样绿）。
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app.modules.notify.models import NotifyChannel
from app.modules.schedule.models import KvSetting, ScheduleTask


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
    ch = NotifyChannel(name="钉钉群A", type="DINGTALK", config={"access_token": "gcm-xxxx", "at_mobiles": ["138"]})
    session.add(ch)
    await session.commit()

    task = ScheduleTask(
        project_id=pid, name="夜间回归", subject_type="scenario", subject_id="scn-1",
        cron="0 2 * * *", notify_channel_ids=[ch.id],
    )
    session.add(task)
    await session.commit()

    kv = KvSetting(key="adb.heartbeat_interval_seconds", value=15)
    session.add(kv)
    await session.commit()

    got = await session.get(ScheduleTask, task.id)
    assert got is not None and got.name == "夜间回归" and got.cron == "0 2 * * *"
    assert got.notify_channel_ids == [ch.id], "JSON 数组原样读回"
    c = await session.get(NotifyChannel, ch.id)
    assert c.config["access_token"] == "gcm-xxxx" and c.type == "DINGTALK"
    v = await session.get(KvSetting, kv.id)
    assert v.value == 15


async def test_defaults_are_the_honest_ones(session, two_projects) -> None:
    """每个默认值都点名断言——没跑过/没发过必须是 None，不是空壳。"""
    pid, _ = two_projects
    task = ScheduleTask(project_id=pid, name="t1", subject_type="scenario", subject_id="s1", cron="* * * * *")
    ch = NotifyChannel(name="钩子一号", type="WEBHOOK", config={"url": "https://example.com/hook"})
    session.add_all([task, ch])
    await session.commit()

    assert task.enabled == 1, "新建任务默认启用（§11.4.17 的 ☑）"
    assert task.consecutive_failures == 0, "§11.4.17「连续失败[3]次」的账从 0 起"
    assert task.notify_channel_ids == [], "没挂渠道就是空列表，不是 None（遍历方免判空）"
    assert task.last_run is None and task.env_id is None and task.created_by is None and task.updated_by is None
    assert ch.last_send is None, "没发过就是没发过（D28：结果落 last_send，不编空壳）"


async def test_blueprint_silence_means_no_columns() -> None:
    """§4:210/§4:211 没列的一律不许在：next_fire_at（D22 未裁不加）、schedule 的
    owner_id/project_public（平台级配置走 project_id 权限过滤例外，visibility 助手不适用）、
    notify_channel 的 project_id（渠道是平台级不是项目资产）。谁要加先改计划再改这条。"""
    task_cols = {c.key for c in ScheduleTask.__table__.columns}
    ch_cols = {c.key for c in NotifyChannel.__table__.columns}
    kv_cols = {c.key for c in KvSetting.__table__.columns}
    assert "next_fire_at" not in task_cols, "D22 未裁决——漏跑补偿先不许顺手建列"
    assert not {"owner_id", "project_public"} & task_cols, "§4 这两行没列就不加（1D T2 纪律）"
    assert {"subject_type", "subject_id", "cron", "env_id", "enabled", "notify_channel_ids", "last_run"} <= task_cols
    assert "project_id" not in ch_cols, "notify_channel 是平台级配置（计划 T0 原话），project_id 例外只点 schedule_task"
    assert not {"owner_id", "project_public"} & ch_cols
    assert {"key", "value"} <= kv_cols and "project_id" not in kv_cols, "系统级键值，不分项目"


async def test_kv_setting_key_is_unique(session) -> None:
    """按 key 读出恰好一行是心跳间隔消费方（D25）的前提——重复行 = 消费方静默歧义。"""
    session.add(KvSetting(key="adb.heartbeat_interval_seconds", value=15))
    await session.commit()
    session.add(KvSetting(key="adb.heartbeat_interval_seconds", value=30))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()


async def test_migration_0021_is_on_the_head_of_the_chain() -> None:
    """链头唯一 0021 + 0021 的父是 0020（多头时 alembic 各升各的，表象是「库里莫名其妙
    少一张表」——同 test_ui_models/test_adb_models 的同款钉）。"""
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

    assert parents["0021"] == "0020", f"0021 的父是 {parents['0021']}，应是 0020"
    # 0022（D37 custom_role）接棒链头：同 test_ui_models 的先例，改期望值不改判定逻辑
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
    chain = set(parents.values()) - {None}
    heads = set(revs) - chain
    assert heads == {"0052"}, f"链头应为唯一 0052，实际 {sorted(heads)}（多头 = 各升各的）"


async def test_down_check_script_knows_the_head() -> None:
    """`scripts/check_migration_down.py` 的 EXPECT 清单必须认得链尾那条。

    为什么单钉这条：那个脚本是「0021 的 down 真能跑」的唯一凭证来源，而它过去两处会假绿——
    查表写死 `LIKE 'ui_%'`（新迁移加一行 EXPECT 也查不到东西，照样「通过」），以及清单落后
    于链尾时直接 FAIL 2 被当成「跟我没关系」跳过。迁移写完忘了登记 = 没人会发现 down 是坏的。
    """
    import pathlib
    import re

    src = (pathlib.Path(__file__).resolve().parents[1] / "scripts" / "check_migration_down.py"
           ).read_text(encoding="utf-8")
    block = re.search(r"^EXPECT[^=]*=\s*\{(.*?)^\}", src, re.S | re.M)
    assert block, "EXPECT 清单读不到（脚本形状变了？）"
    listed = set(re.findall(r'["\'](\d{4})["\']\s*:', block.group(1)))
    versions = pathlib.Path(__file__).resolve().parents[1] / "migrations" / "versions"
    heads = set()
    parents = set()
    for f in versions.glob("*.py"):
        if f.name == "__init__.py":
            continue
        s = f.read_text(encoding="utf-8")
        r = re.search(r'^revision\b[^=]*=\s*["\']([^"\']+)', s, re.M)
        d = re.search(r'^down_revision\b[^=]*=\s*["\']([^"\']+)', s, re.M)
        if r:
            heads.add(r.group(1))
        if d:
            parents.add(d.group(1))
    head = heads - parents
    assert head and head <= listed, f"链尾 {sorted(head)} 不在 check_migration_down 的 EXPECT 里（登记它）"
    # 顺带钉「按清单点名查」不被改回前缀模糊查：前缀查询是新迁移假绿的入口。
    # 只盯 SQL 片段——注释里出现过 LIKE 这个词不该把测试弄红（第一版就是这么红的）。
    sql = "\n".join(ln for ln in src.splitlines() if "table_name" in ln)
    assert "LIKE" not in sql, "查表又退回名字前缀模糊匹配了——新迁移会查不到东西却「通过」"
    assert "IN (" in sql, "查表没按 EXPECT 清单点名"


async def test_tables_actually_exist_in_the_migrated_db(conn) -> None:
    """模型声明了不等于库里有——alembic 漏跑时模型测试照样绿。真 connection 查
    information_schema，是「0021 真的执行过」的证据。"""

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "task_cols": {c["name"] for c in insp.get_columns("schedule_task")},
            "channel_cols": {c["name"] for c in insp.get_columns("notify_channel")},
            "kv_uq": {c["name"] for c in insp.get_unique_constraints("kv_setting")},
        }

    got = await conn.run_sync(_read)
    for t in ("schedule_task", "notify_channel", "kv_setting"):
        assert t in got["tables"], f"库里没有 {t}（alembic 没升到 0021？）"
    assert {"subject_type", "subject_id", "cron", "env_id", "notify_channel_ids", "last_run",
            "consecutive_failures", "project_id"} <= got["task_cols"]
    assert {"name", "type", "config", "last_send"} <= got["channel_cols"]
    assert "next_fire_at" not in got["task_cols"]
    assert "uq_kv_setting_key" in got["kv_uq"]
    await conn.execute(text("SELECT 1"))
