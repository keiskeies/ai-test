"""缺陷域（D187 步 1 = 表 + 状态词表；D191 = 24 个 @service 的服务面 + 关注/评论两张子表）。

命名边界：上游产品的活表叫 `bug` / `bug_relation_case`（取证
`backend/.tmp/d187-forensics/ms-bug-survey.md` §A–§D），license 边界禁止照抄它的
表名/类名/目录约定 ⇒ 本域自拟 `defect` / `defect_case_link`，走本仓自己的命名族
（`run_record` → `plan_record` → `defect`）。`defect:` 前缀是权限点字符串，不是表名。

零横向 import：与 testplan/api_test 等同族（pyproject 契约 1「modules 之间只经
service/事件总线互调」），跨模块取数据走 REGISTRY，不 import 领域模块。
"""
