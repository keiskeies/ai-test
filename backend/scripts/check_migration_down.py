"""一次性校验迁移的 down 真能跑（计划 T2 Step 4，§13 纪律 3）。

为什么不进测试套件：pytest 每轮新建临时库并升到 head，**从不跑 downgrade**——
「down 里写了 drop_table」与「down 真能跑」是两件事（漏一张表、顺序反了、
带了 down 里取不到的东西，全套件都是绿的）。所以要单独跑一次，并把输出留档。

自建一次性 schema、用完即删，不碰演示库。

用法（cwd=backend；只能验链尾那一条——脚本走 head → downgrade -1，传非链尾会当场拒跑）：
    .venv/Scripts/python.exe scripts/check_migration_down.py 0021
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pymysql
from alembic import command
from alembic.config import Config

# migrations/env.py 里 `from app.core.db import Base`，所以 app 包要在 import 路径上；
# alembic.ini 与 migrations/ 按相对路径找，所以 cwd 必须是 backend。照 migrate_dev.py 的做法。
BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)

from app.shared.localenv import require_env  # noqa: E402  （上一行 chdir 之前 app 不在路径上）

# 每条迁移新增的表在这里点名，查表按这份清单点名查，不按名字前缀猜。
# 为什么连查询一起改：原来查的是写死的 `LIKE 'ui_%'`，注释却说「扩到 0019+ 加一行即可」——
# 加了也白加，0020/0021 自查会得到一张空清单然后「通过」。假绿比没测更糟。
EXPECT: dict[str, list[str]] = {
    "0018": ["ui_case", "ui_element", "ui_module"],
    "0020": ["adb_case", "adb_device", "adb_module"],
    "0021": ["kv_setting", "notify_channel", "schedule_task"],
    "0022": ["custom_role"],
    "0023": ["saved_view"],
    "0024": ["plan_record"],
    "0025": ["plan_case_link"],
    "0026": ["plan_report", "plan_report_item"],
    "0027": ["defect", "defect_case_link"],
    "0028": ["defect_follower", "defect_comment"],
    "0029": ["num_sequence", "project_template", "project_custom_field",
             "project_custom_field_option", "project_template_field", "defect_custom_field"],
    "0030": ["functional_module", "functional_case", "functional_case_custom_field"],
    "0031": ["case_review_module", "case_review", "case_review_case",
             "case_review_reviewer", "case_review_result"],
    "0032": ["file_blob", "file_folder", "file_entry", "file_link"],
    "0033": ["functional_case_comment", "functional_case_relation"],
    "0034": ["user_api_key"],
    "0035": ["project_application", "fake_error"],
    "0036": ["environment_group", "environment_group_item", "public_script"],
    "0037": ["mock_service", "mock_rule"],
    "0038": ["share_link"],
    "0039": ["service_integration", "resource_pool", "plugin"],
    "0040": ["plan_functional_exec", "plan_functional_exec_history"],
    # 0041 是纯加列（plan_case_link 的 executor_id/sort_order）+ 组合索引，没有新表；
    # 空清单不是漏登记——脚本会跳过「查表」这一步，只验 up→down→up 版本链能重放。
    "0041": [],
    # 0042 建 plan_module 一张表 + 给 plan_record 加 module_id 一列 + 索引；
    # down 必须把表与列一起脱掉（脚本查表清单只列新表，列由 up→down→up 能重放兜底）。
    "0042": ["plan_module"],
    "0043": ["plan_follower"],
    "0044": ["functional_case_follower"],
    "0045": ["scenario_revision"],
    "0046": ["mcp_server"],
    "0047": ["skill"],
    "0048": ["defect_status", "defect_status_transition"],
    "0049": ["functional_minder_note"],
    # 0050 是 org 扩列 + 新建 org_member + project.organization_id；
    # 查表只列新表，列由 up→down→up 重放兜底。
    "0050": ["org_member"],
    # 0051 建 org_user_group + org_user_group_member 两张表（D270 组织用户组）。
    "0051": ["org_user_group", "org_user_group_member"],
    # 0052 建 org_defect_status + org_defect_status_transition 两张表（D271 组织级状态流模板）。
    "0052": ["org_defect_status", "org_defect_status_transition"],
    # 0053 是 plan_record 纯加列（D279 阶段/计划与实际起止/责任人）；0054 是 defect 纯加列
    # （D280 来源/严重程度）；0055 是 functional_case 纯加列（D281 责任人）；0056 是
    # api_definition 纯加列（D282 描述/标签）；0057 是 functional_case 纯加列（D283 标签）；
    # 0058 是 scenario 纯加列（D284 标签）；0059 是 plan_record 纯加列（D285 标签）；
    # 0060 是 functional_case 纯加列（D289 前置条件/步骤/备注/用例状态）。
    # 都没有新表，空清单不是漏登记——只验 up→down→up 能重放。
    "0053": [],
    "0054": [],
    "0055": [],
    "0056": [],
    "0057": [],
    "0058": [],
    "0059": [],
    "0060": [],
}


def main(rev: str) -> int:
    if rev not in EXPECT:
        print(f"FAIL: 脚本没有 {rev} 的期望表清单（EXPECT 加一行）")
        return 2
    expected = EXPECT[rev]
    # 脚本走的是 upgrade head → downgrade -1 → upgrade head，能脱的只有链尾那一条。
    # 不钉这一句就拿 0020 来跑会得到「down 没删干净」——那不是 0020 的 down 坏了，是跑法不
    # 对（头是 0021，-1 脱的是 0021）。宁可当场拒跑，也不给一条说不清的红。
    from alembic.script import ScriptDirectory

    head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
    if rev != head:
        print(f"FAIL: 本脚本只能验链尾（downgrade -1 脱的就是链尾）；当前 head={head}，传 {rev} 验不到它")
        return 2
    base = require_env("TP_DB_URL")
    hostport = base.split("@")[1].split("/")[0]
    host, _, port = hostport.partition(":")
    user, _, pw = base.split("@")[0].split("//")[1].partition(":")
    schema = "testpilot_downchk"
    # 不能用 str(urlsplit(...))：3.9 起它把密码显示成 ***，拼出来的 URL 连不上（真实踩过）
    head, _, tail = base.partition("/testpilot?")
    sync_url = (head + "/" + schema + "?" + tail).replace("+asyncmy", "+pymysql")
    assert schema in sync_url and "***" not in sync_url

    def admin_conn() -> pymysql.connections.Connection:
        return pymysql.connect(host=host, port=int(port or 3306), user=user, password=pw, autocommit=True)

    ad = admin_conn()
    with ad.cursor() as c:
        c.execute(f"DROP DATABASE IF EXISTS `{schema}`")
        c.execute(f"CREATE DATABASE `{schema}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci")
    ad.close()

    conn = pymysql.connect(host=host, port=int(port or 3306), user=user, password=pw,
                           database=schema, autocommit=True)

    def ui_tables() -> list[str]:
        """按 EXPECT 点名的表查在场情况（名字沿用 ui_tables 是历史包袱，它早就不只装 ui_*）。

        空清单 = 这条迁移只加列/索引、没有新表：直接回 []，不拼非法的 `IN ()`。
        """
        if not expected:
            return []
        with conn.cursor() as c:
            c.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema=%s AND table_name IN (" + ",".join(["%s"] * len(expected)) + ")",
                (schema, *expected),
            )
            return sorted(r[0] for r in c.fetchall())

    def version() -> list[str]:
        with conn.cursor() as c:
            try:
                c.execute("SELECT version_num FROM alembic_version")
                return [r[0] for r in c.fetchall()]
            except pymysql.err.ProgrammingError:
                return ["<alembic_version 不存在>"]

    cfg = Config("alembic.ini")
    cfg.set_main_option("script_location", "migrations")
    cfg.set_main_option("sqlalchemy.url", sync_url)

    fails: list[str] = []
    want = sorted(expected)
    try:
        command.upgrade(cfg, "head")
        got = ui_tables()
        print(f"1) upgrade head  → 版本 {version()}，新表 {got}")
        if got != want:
            fails.append(f"upgrade 后新表不齐：{got}（期望 {want}）")

        command.downgrade(cfg, "-1")
        got = ui_tables()
        print(f"2) downgrade -1  → 版本 {version()}，新表 {got}")
        if got:
            fails.append(f"down 没删干净：{got}")

        command.upgrade(cfg, "head")
        got = ui_tables()
        print(f"3) 再 upgrade    → 版本 {version()}，新表 {got}")
        if got != want:
            fails.append(f"down 之后升不回来（不可重放）：{got}")
    finally:
        conn.close()
        ad = admin_conn()
        with ad.cursor() as c:
            c.execute(f"DROP DATABASE IF EXISTS `{schema}`")
        ad.close()
        print(f"临时库已删：{schema}")

    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print(f"OK: {rev} 的 up/down/up 真能跑（表真消失、真回来）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "0018"))
