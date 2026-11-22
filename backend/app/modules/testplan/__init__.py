"""测试计划域（D183 批次 B 第一刀，步 1 计划本体 plan_record + 步 2 关联 plan_case_link）。

命名边界：上游产品的活表就叫 `test_plan` / `test_plan_report`（取证
docs/2026-11-20-ms-testplan-forensics.md §4），license 边界禁止照抄它的表名/类名/目录约定，
本域一律自拟，走本仓自己的命名族 `run_record` → **`plan_record`**。
`testplan:` 前缀是权限点字符串（§四），不是表名，不受这条约束。
"""
