"""一期 DoD 第 3 条：权限矩阵测试（4 角色 × 主要接口）——后端侧。

对应 docs/2026-11-13-ai-test-platform-design.md:1601 的「权限矩阵测试(4 角色×主要页面/接口)」。
此前 403 断言散落在 test_adb_device / test_projects / test_model_cfg / test_audit_query 里，
没有一张可读的总表；本文件把它钉成矩阵。

范围诚实声明：本文件是**后端接口面**矩阵。主要**页面**的角色可见性另有 UI 面抽样搭档
（前端实测 grep web/src/pages/*.test.tsx 的角色字面量）：adb 三页（adbCases / adbCaseDetail /
adbDevices）、api、scenes、settings（含 READONLY 审计 Tab 可见性）、schedules、notifyChannels、
reportDetail、datasets、uiElements、uiCaseDetail（后四页为 DoD 第 3 条补洞新增）
共 12 页各有角色按钮/Tab 门控用例（workbench.test.tsx 里的 `my_role` 只是 fixture，不算断言）；
其余页面（uiCases / runs / reports / bench 等）仍无页面级角色断言。
本段曾长期写「6 页」而 1E 起 schedules/notifyChannels 两页早已各自带门控用例——**和下面
ROWS 行数一样会漂**，改 UI 面时记得同步这里。

矩阵形状：74 行（实测 `len(ROWS)`，主要接口，覆盖 iam/project、env、api_test 定义+用例、
scenario（含 run_rerun_step 单步重跑与 D164 的 run_cancel 三域行）、schedule、ui_test、adb_test、执行/报告、工作台、search（含 D47-a 的 filter_meta 与 saved_view 四件）、testplan（D183 步 1 计划本体六行：list/create/get/update/archive/delete；步 2 关联四行：link list/create/update/delete；步 3 实时状态一行：status；D225 执行计划一行：execute；步 4 报告四行：report list/create/get/delete；步 5 明细分页一行：report item list）、audit、model_cfg（含 D39 用量统计）、
notify、用户批量导入）× 4 列
（READONLY / MEMBER / PROJECT_ADMIN / SYSTEM_ADMIN）= 296 格。
计数口径按 `--collect-only` 实测定（299 例 = 74×4 + 3 条非矩阵钉。此处曾长期手写 29 行/116 格
而实测 ROWS 早已是 32——**docstring 漂了 3 行没人发现**，因为 parametrize 用 `len(ROWS)` 生成、
永远跟着代码走。所以别手写这个数：加行后跑 `pytest tests/test_permission_matrix.py --collect-only`
再改本段。
⚠ 行**守的是通过/拒绝形状，不守位名**：期望从服务自己声明的位查表推（_expected →
_match(ROLE_TABLE[role], _perm_of(row))），「把声明位改掉」这类变异在矩阵内永远杀不掉——
位名的真守护永远在域内的「真实角色跑真实拒绝」用例（D183 的写在 test_d183_plan_links.py，
台账第六十轮 §二实测在案）。
每格 = 一次真实 HTTP 调用（真实 JWT、真实项目成员角色）对照「声明的权限位 × 角色权限表」
推导出的 预期允许(2xx) / 预期拒绝(403)。

期望值从哪来（为什么不是同义反复）：
- 行→位：@service 行的权限位在**测试运行时**从 REGISTRY.get(name).perm 取
  （路由就是注册表的投影，这是架构事实，不是被测对象）；手写 iam 路由
  （PATCH /projects、成员管理）在行上显式写死位。
- 列→位集：ROLE_TABLE 是设计文档 §4.1 内置角色权限表的**字面量快照**，
  不 import app.modules.iam.roles——角色语义漂移由 test_role_table_snapshot 专门报警。
- 判定：_match 按 §10-1 文档口径（* / mod:* / *:action / -拒绝优先）在本文件**独立实现**，
  不调用 app.core.permissions.match_perm；执行路径用那份，断言用这份，二者独立演化。
- 平台级行（请求不带 project_id）：build_ctx 的 R30 契约——非系统管理员只有 {"auth:*"}、
  系统管理员 {"*"}——快照进 PLATFORM_PATTERNS。
- 项目作用域行：非系统管理员一律叠加 -system:*（_project_scoped 的数据权限契约）。

什么漂移会把这张表打红（这是本测试的价值）：
1) 某接口不再 require 它的位 / 位被改掉 → 预期拒绝格收到 2xx；
2) 内置角色权限表被改（MEMBER 的 -*:delete 被删、READONLY 的 glob 被换…）→ 格翻转 + 快照红；
3) 平台级/项目级权限渗漏（不带 project_id 却拿到项目位）→ 平台行拒绝格翻 2xx；
4) 跨项目隔离失效 → test_cross_project_isolation 红；
5) 注册表冒出新的权限位前缀族 → test_perm_prefix_coverage 红（见 KNOWN_PREFIX_FAMILIES）。

测试库：conftest 每次新建临时 schema（TP_TEST_SCHEMA，会话结束 DROP）+ alembic upgrade，
不触碰共享 dev/demo 库。
"""
from __future__ import annotations

from typing import Any

import pytest


@pytest.fixture()
def fake_bus():
    """run_rerun_step 行的放行格会真进引擎：引擎每步 publish 走全局 bus。

    必须**在 client 之后**实例化（测试签名里排最后）：app 夹具里的 create_app() 会
    init_bus() 指回 settings 里的真 Redis，先装 fakeredis 再跑 create_app 等于没装
    （test_scenario_run 的 fake_bus 同为「最后一参」不是巧合）。
    """
    from fakeredis import FakeAsyncRedis

    from app.core.eventbus import init_bus

    return init_bus(client=FakeAsyncRedis(decode_responses=True))

# —— 列：设计文档 §4.1 内置角色权限表快照（勿 import 生产角色表，见模块 docstring） ——
ROLE_TABLE: dict[str, list[str]] = {
    "SYSTEM_ADMIN": ["*"],
    "PROJECT_ADMIN": ["*", "-system:*"],
    # D102（第五十轮裁「做」后同步）：MEMBER 新增 -agent:full:* —— FULL 档=写能力，
    # 不再被 "*"-glob 静默放行。语义裁决记录在台账 D102 条，快照跟随生产。
    "MEMBER": ["*", "-*:delete", "-*:manage", "-system:*", "-agent:full:*"],
    "READONLY": ["*:read"],
}
ROLE_ORDER = ("READONLY", "MEMBER", "PROJECT_ADMIN", "SYSTEM_ADMIN")

# 平台级（请求不带 project_id）权限集合：build_ctx R30 契约的快照。
PLATFORM_PATTERNS: dict[str, list[str]] = {
    "READONLY": ["auth:*"],
    "MEMBER": ["auth:*"],
    "PROJECT_ADMIN": ["auth:*"],
    "SYSTEM_ADMIN": ["*"],
}

# —— 覆盖率钉：注册表里每个权限位的首段前缀必须落在此族内 ——
# 有人新增 `schedule:task:*`、`notify:channel:*` 之类的位而矩阵没考虑过 → 本测试红，逼人进表。
# 特别说明：schedule:task:* 与 notify:channel:* 曾是 1E 在途前缀，现均已合入并进了本矩阵的
# ROWS（notify_list / schedule_task_list / schedule_task_create）——留在此集合是如实登记
# 已认族，不是在途豁免；删掉任何一项都会让前缀覆盖测试红。
KNOWN_PREFIX_FAMILIES = {
    "adb", "agent", "api", "auth", "defect", "env", "file", "functional", "iam", "integration",
    "mcp", "mock", "model", "notify", "plugin", "project", "resource", "review", "share", "skill",
    "task", "scenario", "schedule", "search", "system", "ui", "workbench", "testplan",
}

# KNOWN_HOLES：按权限表应当拒绝、实测却放行的格（真实越权）。
# 规则：发现即登记（endpoint / role / observed_status），断言改钉**实测行为**，
# 不弱化矩阵其它格、不改生产码，并在汇报里开待裁。本次实测：空。
KNOWN_HOLES: list[dict[str, Any]] = []


def _match_one(pattern: str, perm: str) -> bool:
    """§10-1 通配语义的独立实现（* / mod:* / *:action / 全等）。"""
    if pattern == "*":
        return True
    if pattern.endswith(":*"):
        return perm.startswith(pattern[:-1])
    if pattern.startswith("*:"):
        return perm.endswith(pattern[1:])
    return pattern == perm


def _match(patterns: list[str], perm: str) -> bool:
    """显式拒绝优先于任何放行。"""
    for p in patterns:
        if p.startswith("-") and _match_one(p[1:], perm):
            return False
    return any(_match_one(p, perm) for p in patterns if not p.startswith("-"))


def _expected(row: dict[str, Any], role: str) -> bool:
    """该格是否预期 2xx。纯查表推导，不看任何响应。"""
    if row.get("always_allow"):  # 成员制门槛类接口：四种角色都是成员 → 读一律放行
        return True
    perm = _perm_of(row)
    if row.get("platform"):
        return _match(PLATFORM_PATTERNS[role], perm)
    patterns = list(ROLE_TABLE[role])
    if role != "SYSTEM_ADMIN":
        patterns.append("-system:*")  # _project_scoped：项目角色一律不含 system:*
    return _match(patterns, perm)


def _perm_of(row: dict[str, Any]) -> str:
    if "manual_perm" in row:  # 手写 iam 路由：位写在行上（见行注释）
        return row["manual_perm"]
    from app.core.registry import REGISTRY

    spec = REGISTRY.get(row["svc"])
    assert spec is not None, f"注册表没有服务 {row['svc']}：行已过期，删行或改名"
    return spec.perm


def _fmt(v: Any, m: dict[str, str]) -> Any:
    if isinstance(v, str):
        return v.format(**m)
    if isinstance(v, dict):
        return {k: _fmt(x, m) for k, x in v.items()}
    if isinstance(v, list):
        return [_fmt(x, m) for x in v]
    return v


def _ids(ctx: dict[str, Any], role: str) -> dict[str, str]:
    """每格资源按角色取（PA/SYS 都有 2xx 格，各吃自己的一份；拒绝格随便指一份）。"""
    res = ctx["res"].get(role) or ctx["res"]["PROJECT_ADMIN"]
    return {
        "project": ctx["project"],
        "env": res["env"], "scenario": res["scenario"], "definition": res["definition"],
        "version": str(res["scenario_version"]), "role": role,
        # D183 步 2：link_create 行的第二场景 / link_update 行的第二环境（见各行的行注释）
        "scenario2": res["scenario2"], "env2": res["env2"],
        "rerun_src": res["rerun_src"],
        "cancel_src_scenario": res["cancel_src_scenario"],
        "cancel_src_ui": res["cancel_src_ui"],
        "cancel_src_adb": res["cancel_src_adb"],
        # D47-a：saved_view_update/delete 两行的靶子（每角色自己的一条视图，见 _build_ctx）
        "view_id": res["view"],
        # D183 步 1：testplan 段的靶子（六行里 get/update/archive/delete 四行按 {plan} 定位；
        # list/create 不带 id，见 _rows 的 plan_create 行用行内 name）。每角色一条自己的计划。
        "plan": res["plan"],
        # D183 步 2：关联段的靶子（update/delete 两行按 {link} 定位；list/create 挂在
        # {plan} 路径下）。每角色一条自己的关联（挂自己的场景）。
        "link": res["link"],
        # D183 步 4：报告段的靶子（get/delete 两行按 {report} 定位；list/create 挂在
        # {plan} 路径下）。每角色一份自己的报告（在自己计划上生成）。
        "report": res["report"],
        # D211：模块段 update/delete 两行的靶子（每角色一个自己的模块，见 _build_ctx）
        "module": res["module"],
        # D225：plan_execute 行的靶子 = 每角色一条**空计划**（零关联）。执行空计划
        # 不派发任何 run（submitted=0），矩阵格不会把执行引擎拖进来；放行格要的是 2xx。
        "empty_plan": res["empty_plan"],
        "victim": ctx["victims"].get(role, ctx["victims"]["spare"]),
    }


def _mk(method: str, url_tpl: str, *, body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None):
    async def req(ctx: dict[str, Any], role: str):
        m = _ids(ctx, role)
        return await ctx["client"].request(
            method, _fmt(url_tpl, m), params=_fmt(params, m), json=_fmt(body, m), headers=ctx[role])
    return req


_P = {"project_id": "{project}"}


def _rows() -> list[dict[str, Any]]:
    # svc=... 的行：权限位运行时取自注册表；manual_perm 的行：手写路由，位写死在行上。
    return [
        # —— iam / project（手写路由，注册表里查不到位，行上写死）——
        {"id": "project_patch", "svc": None, "manual_perm": "project:update",
         "desc": "改项目名（project:update，手写路由 require_perm）",
         "request": _mk("PATCH", "/api/v1/projects/{project}", body={"name": "矩阵改名"})},
        {"id": "project_get", "svc": None, "manual_perm": "(成员制)", "always_allow": True,
         "desc": "项目详情：成员制可读，无位门槛",
         "request": _mk("GET", "/api/v1/projects/{project}")},
        {"id": "members_list", "svc": None, "manual_perm": "(成员制)", "always_allow": True,
         "desc": "成员列表：成员制可读",
         "request": _mk("GET", "/api/v1/projects/{project}/members")},
        {"id": "member_delete", "svc": None, "manual_perm": "project:member:manage",
         "desc": "移除他人成员（project:member:manage；目标恒为别人，排除自助退出豁免）",
         "request": _mk("DELETE", "/api/v1/projects/{project}/members/{victim}")},
        # —— iam / 自定义角色（D37 §11.4.21：iam:role:* 前缀族）——
        {"id": "role_custom_list", "svc": "role_custom_list", "desc": "自定义角色列表（iam:role:read）",
         "request": _mk("GET", "/api/v1/custom-roles", params=dict(_P))},
        {"id": "role_perm_tree", "svc": "role_perm_tree", "desc": "两级权限菜单树（iam:role:read；REGISTRY 投影）",
         "request": _mk("GET", "/api/v1/role-perm-tree", params=dict(_P))},
        {"id": "role_create", "svc": "role_create", "desc": "从模板复制建自定义角色（iam:role:create）",
         "request": _mk("POST", "/api/v1/custom-roles",
                        body={"project_id": "{project}", "name": "矩阵角色-{role}",
                              "template_code": "READONLY"})},
        # —— env ——
        {"id": "env_list", "svc": "env_list", "desc": "环境列表",
         "request": _mk("GET", "/api/v1/envs", params=dict(_P))},
        {"id": "env_create", "svc": "env_create", "desc": "建环境",
         "request": _mk("POST", "/api/v1/envs",
                        body={"project_id": "{project}", "name": "矩阵环境-{role}"})},
        {"id": "env_delete", "svc": "env_delete", "desc": "删环境",
         "request": _mk("DELETE", "/api/v1/envs/{env}", body={"project_id": "{project}"})},
        # —— api_test：定义 + 用例 + 模块树 ——
        {"id": "api_module_tree", "svc": "api_module_tree", "desc": "接口模块树",
         "request": _mk("GET", "/api/v1/api-modules", params=dict(_P))},
        {"id": "api_def_list", "svc": "api_definition_list", "desc": "接口定义列表",
         "request": _mk("GET", "/api/v1/api-definitions", params=dict(_P))},
        {"id": "api_def_create", "svc": "api_definition_create", "desc": "建接口定义",
         "request": _mk("POST", "/api/v1/api-definitions",
                        body={"project_id": "{project}", "name": "矩阵接口-{role}", "method": "GET",
                              "path": "/x-{role}",
                              "request": {"method": "GET", "url": "http://127.0.0.1:9/x"}})},
        {"id": "api_def_delete", "svc": "api_definition_delete", "desc": "删接口定义",
         "request": _mk("POST", "/api/v1/api-definitions/{definition}/delete",
                        body=dict(_P))},
        {"id": "api_case_list", "svc": "api_case_list", "desc": "用例列表",
         "request": _mk("GET", "/api/v1/api-cases", params=dict(_P))},
        # —— scenario ——
        {"id": "scenario_list", "svc": "scenario_list", "desc": "场景列表",
         "request": _mk("GET", "/api/v1/scenarios", params=dict(_P))},
        {"id": "scenario_get", "svc": "scenario_get", "desc": "场景详情",
         "request": _mk("GET", "/api/v1/scenarios/{scenario}", params=dict(_P))},
        {"id": "scenario_create", "svc": "scenario_create", "desc": "建场景",
         "request": _mk("POST", "/api/v1/scenarios",
                        body={"project_id": "{project}", "name": "矩阵场景-{role}"})},
        {"id": "scenario_update", "svc": "scenario_update", "desc": "改场景（乐观锁 version 随行取）",
         "request": _mk("PATCH", "/api/v1/scenarios/{scenario}",
                        body={"project_id": "{project}", "scenario_id": "{scenario}",
                              "version": "{version}", "priority": "P1"})},
        # —— scenario：单步重跑（1B T13 §8.3；此前唯一漏网的 scenario 族写端点）——
        # 源 run 由 _build_ctx 每角色各造一个「可重建」的形状（summary_graph 里有 set_var
        # 节点 + 该步 vars_snapshot 非 NULL 的失败明细行），放行格真跑到 passed（set_var
        # 不发请求，秒级）；拒绝格在 ctx.require("scenario:run") 就 403，碰不到引擎。
        {"id": "run_rerun_step", "svc": "run_rerun_step",
         "desc": "单步重跑（scenario:run；对角色自备的可重建源 run 发起）",
         "request": _mk("POST", "/api/v1/runs/{rerun_src}/rerun-step",
                        body={"project_id": "{project}", "step_key": "mxv"})},
        # —— D164：唯一取消出口的域×钥匙（此前三行全缺 = 共享出口正是逐域矩阵从不生成的形状）——
        # svc 行为什么不行：REGISTRY 里 run_cancel.perm=scenario:run 只是投影占位（dynamic_perm），
        # 真钥匙按 run 行的 subject_type 在执行时才定，所以位写在行上（manual_perm 同款形状），
        # 每行指向对应域的 queued 源 run（_build_ctx 直造，取消只落旗不改 status，格间可复跑）。
        # 自定义角色 × 域钥匙的完整对表在 test_d164_run_cancel_domain_perm.py（内置角色三个域位
        # 全有，照不出跨域面；这里钉的是「每域一行 + details.perm 指名域钥匙」）。
        {"id": "run_cancel_scenario", "svc": None, "manual_perm": "scenario:run",
         "desc": "取消 scenario 域 run（钥匙=scenario:run，D164 域定钥匙）",
         "request": _mk("POST", "/api/v1/runs/{cancel_src_scenario}/cancel", body=dict(_P))},
        {"id": "run_cancel_ui", "svc": None, "manual_perm": "ui:case:run",
         "desc": "取消 ui_case 域 run（钥匙=ui:case:run；固定 scenario:run 的旧行为在此翻案）",
         "request": _mk("POST", "/api/v1/runs/{cancel_src_ui}/cancel", body=dict(_P))},
        {"id": "run_cancel_adb", "svc": None, "manual_perm": "adb:case:run",
         "desc": "取消 adb_case 域 run（钥匙=adb:case:run）",
         "request": _mk("POST", "/api/v1/runs/{cancel_src_adb}/cancel", body=dict(_P))},
        # —— schedule（1E §11.4.17；路由已合入，行从 KNOWN_PREFIX_FAMILIES 的在途账收编）——
        {"id": "schedule_task_list", "svc": "schedule_task_list",
         "desc": "定时任务列表（schedule:task:read；表无 project_public 列，显式 project_id 过滤的项目级读）",
         "request": _mk("GET", "/api/v1/schedule-tasks", params=dict(_P))},
        {"id": "schedule_task_create", "svc": "schedule_task_create",
         "desc": "建定时任务（schedule:task:create；subject 恒为角色自备场景）",
         "request": _mk("POST", "/api/v1/schedule-tasks",
                        body={"project_id": "{project}", "name": "矩阵任务-{role}",
                              "subject_type": "scenario", "subject_id": "{scenario}",
                              "cron": "0 2 * * *"})},
        # —— ui_test ——
        {"id": "ui_module_tree", "svc": "ui_module_tree", "desc": "UI 模块树",
         "request": _mk("GET", "/api/v1/ui-modules", params=dict(_P))},
        {"id": "ui_case_list", "svc": "ui_case_list", "desc": "UI 用例列表",
         "request": _mk("GET", "/api/v1/ui-cases", params=dict(_P))},
        # —— adb_test ——
        {"id": "adb_module_tree", "svc": "adb_module_tree", "desc": "ADB 模块树",
         "request": _mk("GET", "/api/v1/adb-modules", params=dict(_P))},
        {"id": "adb_device_list", "svc": "adb_device_list", "desc": "设备列表",
         "request": _mk("GET", "/api/v1/adb-devices", params=dict(_P))},
        {"id": "adb_case_list", "svc": "adb_case_list", "desc": "ADB 用例列表",
         "request": _mk("GET", "/api/v1/adb-cases", params=dict(_P))},
        # —— 执行 / 报告 ——
        {"id": "report_list", "svc": "report_list", "desc": "报告中心",
         "request": _mk("GET", "/api/v1/reports", params=dict(_P))},
        {"id": "run_record_list", "svc": "run_record_list", "desc": "执行记录",
         "request": _mk("GET", "/api/v1/runs", params=dict(_P))},
        # —— 工作台 / 搜索 ——
        {"id": "workbench_stats", "svc": "workbench_stats", "desc": "工作台统计",
         "request": _mk("GET", "/api/v1/workbench-stats", params=dict(_P))},
        {"id": "search_assets", "svc": "search_assets", "desc": "全局搜索",
         "request": _mk("GET", "/api/v1/search-assets", params={"project_id": "{project}", "q": "x"})},
        # —— D47-a §11.5.1 列表工具栏后端半边（search:view:* 前缀族；视图 CRUD 全走 ctx.require）——
        # update/delete 两行的 {view_id} 是**该角色自己**的一条视图（_build_ctx 每角色建一条，
        # READONLY 落 PA 的）：拒绝格要用「权限门就该挡住」的形状，不能借归属缺失混成 404，
        # 那会让门失效时恰好被 404 掩盖掉。放行格因此真跑到 200/201。
        {"id": "filter_meta", "svc": "filter_meta", "desc": "高级搜索能力清单（search:read）",
         "request": _mk("GET", "/api/v1/filter-meta", params=dict(_P))},
        {"id": "saved_view_list", "svc": "saved_view_list", "desc": "个人视图列表（search:read）",
         "request": _mk("GET", "/api/v1/saved-views",
                        params={"project_id": "{project}", "view_type": "api"})},
        {"id": "saved_view_create", "svc": "saved_view_create",
         "desc": "保存个人视图（search:view:create；名称随行带 role 防四角色撞名）",
         "request": _mk("POST", "/api/v1/saved-views",
                        body={"project_id": "{project}", "view_type": "api",
                              "name": "矩阵视图-{role}",
                              "conditions": {"search_mode": "AND", "conditions": []}})},
        {"id": "saved_view_update", "svc": "saved_view_update", "desc": "改个人视图（search:view:update）",
         "request": _mk("PATCH", "/api/v1/saved-views/{view_id}",
                        body={"project_id": "{project}", "view_type": "api",
                              "view_id": "{view_id}", "name": "矩阵视图改-{role}"})},
        {"id": "saved_view_delete", "svc": "saved_view_delete", "desc": "删个人视图（search:view:delete；MEMBER 的 -*:delete 在此生效）",
         "request": _mk("DELETE", "/api/v1/saved-views/{view_id}",
                        body={"project_id": "{project}", "view_type": "api",
                              "view_id": "{view_id}"})},
        # —— D183 步 1 §四 计划本体（testplan:plan:* 前缀族；六个端点各一行）——
        # {plan} 是该角色自己的一条计划（_build_ctx 每角色建一条，READONLY 落 PA 的）——
        # 与 saved_view 两行同一纪律：拒绝格必须是「权限门该挡住」的形状，不许借归属缺失混 404。
        # archive 行钉的是 D159 那条位选择：MEMBER 持 update 却因 -*:manage 拿不到 manage，
        # delete 行钉 MEMBER 的 -*:delete；两格都是「位名进 details.perm」的契约现场。
        {"id": "plan_list", "svc": "plan_list", "desc": "计划列表（testplan:plan:read）",
         "request": _mk("GET", "/api/v1/plans", params=dict(_P))},
        {"id": "plan_create", "svc": "plan_create", "desc": "建计划（testplan:plan:create；名随行带 role 防四角色撞名）",
         "request": _mk("POST", "/api/v1/plans",
                        body={"project_id": "{project}", "name": "矩阵计划-{role}"})},
        {"id": "plan_copy", "svc": "plan_copy", "desc": "复制计划（testplan:plan:create；默认名随机后缀防撞名）",
         "request": _mk("POST", "/api/v1/plans/{plan}/copy", body=dict(_P))},
        {"id": "plan_get", "svc": "plan_get", "desc": "计划详情（testplan:plan:read）",
         "request": _mk("GET", "/api/v1/plans/{plan}", params=dict(_P))},
        # —— D231 计划关注（写副作用走 testplan:plan:update，不借 read；READONLY 403）——
        {"id": "plan_follow", "svc": "plan_follow",
         "desc": "关注计划（testplan:plan:update；幂等，重复关注仍 200）",
         "request": _mk("POST", "/api/v1/plans/{plan}/follow", body=dict(_P))},
        {"id": "plan_unfollow", "svc": "plan_unfollow",
         "desc": "取消关注计划（testplan:plan:update；幂等，未关注也 200）",
         "request": _mk("POST", "/api/v1/plans/{plan}/unfollow", body=dict(_P))},
        {"id": "plan_update", "svc": "plan_update", "desc": "改计划名（testplan:plan:update）",
         "request": _mk("PATCH", "/api/v1/plans/{plan}",
                        body={"project_id": "{project}", "name": "矩阵计划改-{role}"})},
        {"id": "plan_archive", "svc": "plan_archive", "desc": "归档计划（testplan:plan:manage；MEMBER 的 -*:manage 在此生效，D159 同款）",
         "request": _mk("POST", "/api/v1/plans/{plan}/archive", body=dict(_P))},
        {"id": "plan_delete", "svc": "plan_delete", "desc": "删计划（testplan:plan:delete；MEMBER 的 -*:delete 在此生效）",
         "request": _mk("DELETE", "/api/v1/plans/{plan}", body=dict(_P))},
        {"id": "plan_batch_delete", "svc": "plan_batch_delete", "desc": "批量删计划（testplan:plan:delete；与单删同一位，MEMBER 的 -*:delete 在此生效）",
         "request": _mk("POST", "/api/v1/plans/batch-delete",
                        body={"project_id": "{project}", "plan_ids": ["{plan}"]})},
        # —— D211 计划模块树（复用 testplan:plan:* 位，不新造权限；四行各一格）——
        # {module} 是该角色自己的模块（_build_ctx 每角色建一个）。delete 行放最后：
        # 它腾空的是自己的靶子，后面的行不再引用它。
        {"id": "plan_module_tree", "svc": "plan_module_tree", "desc": "计划模块树（testplan:plan:read）",
         "request": _mk("GET", "/api/v1/plan-modules/tree", params=dict(_P))},
        {"id": "plan_module_create", "svc": "plan_module_create",
         "desc": "建计划模块（testplan:plan:create；名随行带 role 防四角色撞名）",
         "request": _mk("POST", "/api/v1/plan-modules",
                        body={"project_id": "{project}", "name": "矩阵新模块-{role}"})},
        {"id": "plan_module_update", "svc": "plan_module_update",
         "desc": "改计划模块（testplan:plan:update）",
         "request": _mk("PATCH", "/api/v1/plan-modules/{module}",
                        body={"project_id": "{project}", "name": "矩阵模块改-{role}"})},
        {"id": "plan_module_delete", "svc": "plan_module_delete",
         "desc": "删计划模块（testplan:plan:delete；MEMBER 的 -*:delete 在此生效）",
         "request": _mk("POST", "/api/v1/plan-modules/{module}/delete", body=dict(_P))},
        # —— D183 步 3 §五：实时状态现算（复用 testplan:plan:read，不新造位；单行钉通过形状，
        # 位名守护在 test_d183_plan_status 的 gates 用例——第六十轮 §二口径）——
        {"id": "plan_status", "svc": "plan_status", "desc": "计划实时状态现算（testplan:plan:read；只读零落库）",
         "request": _mk("GET", "/api/v1/plans/{plan}/status", params=dict(_P))},
        # —— D225：执行计划（testplan:plan:execute，新位；**空计划**当靶 → submitted=0，
        # 不把执行引擎拖进矩阵）——位名守护在 test_d225_plan_execute 的权限用例。
        {"id": "plan_execute", "svc": "plan_execute",
         "desc": "执行计划（testplan:plan:execute；空计划零派发，只钉权限门形状）",
         "request": _mk("POST", "/api/v1/plans/{empty_plan}/execute",
                        body={"project_id": "{project}", "plan_id": "{empty_plan}"})},
        # —— D183 步 2 §五：计划关联（testplan:link:* 前缀；四端点各一行）——
        # {link} 是该角色自己计划上挂自己场景的关联行（_build_ctx 每角色建一条）——
        # 与 plan/saved_view 段同一纪律：拒绝格必须让权限门自己开口，不许借归属缺失混 404。
        # 注意 create 行挂的是**第二个**场景（mx-sc2）：ctx 建靶时已把第一场景挂进同一计划，
        # 再挂同一个会被 uq 预检 409 拒掉——放行格要的是 2xx，不是撞唯一键。
        # link 段的位名守护**不在这里**（第六十轮 §二：矩阵期望从声明位查表推，改声明=改期望、
        # 四格照绿）；真守护在 test_d183_plan_links 的 gate 用例（真实 MEMBER 跑真实 403）。
        {"id": "plan_link_list", "svc": "plan_link_list", "desc": "计划关联列表（testplan:link:read）",
         "request": _mk("GET", "/api/v1/plans/{plan}/case-links", params=dict(_P))},
        {"id": "plan_link_create", "svc": "plan_link_create", "desc": "把用例挂进计划（testplan:link:create；挂第二场景防撞 uq）",
         "request": _mk("POST", "/api/v1/plans/{plan}/case-links",
                        body={"project_id": "{project}", "subject_type": "scenario", "subject_id": "{scenario2}"})},
        {"id": "plan_link_update", "svc": "plan_link_update",
         "desc": "改关联行环境（testplan:link:update；换成角色自己的第二个环境）",
         "request": _mk("PATCH", "/api/v1/plans/{plan}/case-links/{link}",
                        body={"project_id": "{project}", "env_id": "{env2}"})},
        {"id": "plan_link_delete", "svc": "plan_link_delete", "desc": "摘除关联（testplan:link:delete；MEMBER 的 -*:delete 在此生效）",
         "request": _mk("DELETE", "/api/v1/plans/{plan}/case-links/{link}", body=dict(_P))},
        # —— D183 步 4 §五：计划报告（testplan:report:* 前缀；四端点各一行）——
        # {report} 是该角色自己计划上生成的一份报告（_build_ctx 每角色生成一条）——
        # 与 plan/link 段同一纪律：拒绝格必须让权限门自己开口，不许借归属缺失混 404。
        # get 行四格全放行（read 位四角色都命中）；create 行钉 READONLY 拒、delete 行钉
        # MEMBER 的 -*:delete。报告面**没有** :manage/:update（位名守护在
        # test_d183_plan_reports 的 gates 用例——第六十轮 §二口径，这里只钉通过/拒绝形状）。
        {"id": "plan_report_list", "svc": "plan_report_list", "desc": "计划报告列表（testplan:report:read）",
         "request": _mk("GET", "/api/v1/plans/{plan}/reports", params=dict(_P))},
        {"id": "plan_report_create", "svc": "plan_report_create",
         "desc": "生成计划报告（testplan:report:create；MEMBER 放行——生成不是删除不是管理）",
         "request": _mk("POST", "/api/v1/plans/{plan}/reports", body={"project_id": "{project}"})},
        {"id": "plan_report_get", "svc": "plan_report_get", "desc": "报告详情（testplan:report:read；头+全量明细）",
         "request": _mk("GET", "/api/v1/plan-reports/{report}", params=dict(_P))},
        # —— D183 步 5：报告明细分页（testplan:report:read **复用位**，不新造位；单行钉通过
        # 形状，位名守护在 test_d183_report_item_page 的 perm_gate 用例——第六十轮 §二口径，
        # 与步 3 status 行同款：复用位的新读面，矩阵只守通过/拒绝形状）——
        {"id": "plan_report_item_list", "svc": "plan_report_item_list",
         "desc": "报告明细分页（testplan:report:read；页码制、零现算）",
         "request": _mk("GET", "/api/v1/plan-reports/{report}/items", params=dict(_P))},
        {"id": "plan_report_delete", "svc": "plan_report_delete",
         "desc": "删报告（testplan:report:delete；MEMBER 的 -*:delete 在此生效，物理删+明细级联）",
         "request": _mk("DELETE", "/api/v1/plan-reports/{report}", body=dict(_P))},
        {"id": "plan_report_rename", "svc": "plan_report_rename",
         "desc": "报告改名（testplan:report:update；只写 name 一列，内容快照不动；MEMBER 放行）",
         "request": _mk("PATCH", "/api/v1/plan-reports/{report}",
                        body={"project_id": "{project}", "name": "矩阵报告改名-{role}"})},
        # —— 平台级（system / model / notify；auth 自助类无矩阵意义）——
        {"id": "audit_list", "svc": "audit_list", "desc": "审计查询（D23：仅系统管理员，带 project_id 也拒）",
         "request": _mk("GET", "/api/v1/audit", params=dict(_P))},
        {"id": "user_list", "svc": "user_list", "desc": "平台用户列表（payload 无 project_id → 平台级）",
         "platform": True, "request": _mk("GET", "/api/v1/system/users")},
        # —— D40 §11.4.22 用户批量导入（system:user:create；平台级，与 user_create 同族）——
        {"id": "user_import_preview", "svc": "user_import_preview",
         "desc": "用户批量导入·解析预览（system:user:create；平台级）",
         "platform": True, "request": _mk("POST", "/api/v1/system/users/import-preview",
                                          body={"text": "账号,姓名\nmx_imp_{role},矩阵导入"})},
        {"id": "user_import_commit", "svc": "user_import_commit",
         "desc": "用户批量导入·提交（system:user:create；平台级；账号随行带 role 防重）",
         "platform": True, "request": _mk("POST", "/api/v1/system/users/import-commit",
                                          body={"initial_password": "Import@123", "items": [
                                              {"line": 2, "account": "mx_imp_c_{role}",
                                               "name": "矩阵导入-{role}", "strategy": "create"}]})},
        {"id": "model_cfg_list", "svc": "model_cfg_list", "desc": "模型配置列表（平台级：R30 下非管理员只有 auth:*）",
         "platform": True, "request": _mk("GET", "/api/v1/model-cfgs")},
        {"id": "model_usage_stats", "svc": "model_usage_stats",
         "desc": "模型用量统计（D39 §6.8：model:usage:read；全池共享 → 平台级行，同 model_cfg_list）",
         "platform": True, "request": _mk("GET", "/api/v1/model-usage")},
        {"id": "notify_list", "svc": "notify_channel_list", "desc": "通知渠道列表（平台级；已进表，见 KNOWN_PREFIX_FAMILIES 注释）",
         "platform": True, "request": _mk("GET", "/api/v1/notify-channels")},
        # —— D265/D266 的 mcp / skill 平台治理位（此前只落在模块测试里，前缀覆盖逮到）——
        {"id": "mcp_server_list", "svc": "mcp_server_list",
         "desc": "MCP 服务登记列表（mcp:server:read；平台级，非管理员只有 auth:*）",
         "platform": True, "request": _mk("GET", "/api/v1/mcp-servers")},
        {"id": "skill_list", "svc": "skill_list",
         "desc": "Skills 列表（skill:manage；平台级目录，读取也需治理位）",
         "platform": True, "request": _mk("GET", "/api/v1/skills")},
        # —— D203 平台运维：三块登记面各取列表行（读位），外加平台级 system_info ——
        # 新建行不进来：四角色同项目创建会同名撞 uq，矩阵行的 body 无法按角色取名；
        # 写位的 403 由 tests/test_d203_platform_ops.py 直接钉。
        {"id": "integration_list", "svc": "integration_list",
         "desc": "服务集成列表（D203；项目级 integration:integration:read）",
         "request": _mk("GET", "/api/v1/service-integrations", params=_P)},
        {"id": "resource_pool_list", "svc": "resource_pool_list",
         "desc": "资源池列表（D203；项目级 resource:pool:read）",
         "request": _mk("GET", "/api/v1/resource-pools", params=_P)},
        {"id": "plugin_list", "svc": "plugin_list",
         "desc": "插件登记列表（D203；项目级 plugin:plugin:read）",
         "request": _mk("GET", "/api/v1/plugins", params=_P)},
        {"id": "system_info", "svc": "system_info",
         "desc": "系统版本（D203；平台级 system:info:read）",
         "platform": True, "request": _mk("GET", "/api/v1/system/info")},
    ]


ROWS = _rows()
MATRIX_IDS = [f"{r['id']}__{role}" for r in ROWS for role in ROLE_ORDER]


async def _build_ctx(client, make_user, session) -> dict[str, Any]:
    """一个项目 × 四个真角色用户 + 每角色可写资源（拒绝格复用 PA 的资源 id）。"""
    boss, h_pa = await make_user("mx_pa")  # 创建者即 PROJECT_ADMIN
    pid = (await _mk_project(client, h_pa, "矩阵项目"))["id"]
    _, h_sy = await make_user("mx_sy", admin=True)
    # 真实加成员路径挂 MEMBER / READONLY（顺带验 set_member 本身可用）
    u_me, h_me = await make_user("mx_me")
    u_ro, h_ro = await make_user("mx_ro")
    for u, code in ((u_me, "MEMBER"), (u_ro, "READONLY")):
        r = await client.put(f"/api/v1/projects/{pid}/members/{u.id}",
                             json={"role_code": code}, headers=h_pa)
        assert r.status_code == 200, r.text
    # 被移除的受害者：每个「可删」角色各配一个，避免两格删同一行撞 404
    victims: dict[str, str] = {}
    for tag, role in (("mx_victim_pa", "PROJECT_ADMIN"), ("mx_victim_sy", "SYSTEM_ADMIN"),
                      ("mx_victim_me", "MEMBER"), ("mx_victim_ro", "READONLY")):
        v, _ = await make_user(tag)
        r = await client.put(f"/api/v1/projects/{pid}/members/{v.id}",
                             json={"role_code": "MEMBER"}, headers=h_pa)
        assert r.status_code == 200, r.text
        victims[role] = v.id
    victims["spare"] = victims["PROJECT_ADMIN"]

    ctx: dict[str, Any] = {"client": client, "project": pid, "victims": victims, "res": {},
                           "READONLY": h_ro, "MEMBER": h_me, "PROJECT_ADMIN": h_pa,
                           "SYSTEM_ADMIN": h_sy}
    # 每个角色各备一套可写资源（只给「预期可写」的建；拒绝格拿 PA 的 id 也无所谓）
    for role, h in ((r_, ctx[r_]) for r_ in ROLE_ORDER):
        if role == "READONLY":
            continue
        env = await client.post("/api/v1/envs", params={"project_id": pid},
                                json={"project_id": pid, "name": f"mx-env-{role}"}, headers=h)
        assert env.status_code in (200, 201), env.text
        d = await client.post("/api/v1/api-definitions",
                              json={"project_id": pid, "name": f"mx-def-{role}", "method": "GET",
                                    "path": f"/{role}",
                                    "request": {"method": "GET", "url": "http://127.0.0.1:9/x"}}, headers=h)
        assert d.status_code in (200, 201), d.text
        s = await client.post("/api/v1/scenarios",
                              json={"project_id": pid, "name": f"mx-sc-{role}"}, headers=h)
        assert s.status_code in (200, 201), s.text
        # D47-a：每人一条自己的视图，供 saved_view_update/delete 两行当靶子。
        # 名字带 role：同页面同主人唯一（uq_saved_view_scope_name），四角色在同项目里不撞名。
        v = await client.post("/api/v1/saved-views",
                              json={"project_id": pid, "view_type": "api",
                                    "name": f"mx-view-{role}",
                                    "conditions": {"search_mode": "AND", "conditions": []}},
                              headers=h)
        assert v.status_code in (200, 201), v.text
        # D183 步 1：每角色一条自己的计划，供 testplan 段当靶子（同款「拒绝格用权限门
        # 该挡住的形状」纪律——借归属缺失混 404 会掩盖门失效）。名字带 role：同项目唯一。
        # READONLY 走不到这里（上面 continue），它的 {plan} 由 _ids 落到 PA 那份——
        # 拒绝格本来就要吃「别人有权、它无权」的真实 id。
        pl = await client.post("/api/v1/plans",
                               json={"project_id": pid, "name": f"mx-plan-{role}"}, headers=h)
        assert pl.status_code in (200, 201), pl.text
        # D225：每角色再一条**空计划**，只给 plan_execute 行当靶（零关联 → 不派发 run）。
        ep = await client.post("/api/v1/plans",
                               json={"project_id": pid, "name": f"mx-plan-empty-{role}"}, headers=h)
        assert ep.status_code in (200, 201), ep.text
        # D211：每角色一个自己的计划模块，供模块段 update/delete 两行当靶（{module}）。
        # tree/create 两行不带 id；update 行改名、delete 行腾空后删（都只在自己那份上）。
        mod = await client.post("/api/v1/plan-modules",
                                json={"project_id": pid, "name": f"mx-module-{role}"}, headers=h)
        assert mod.status_code in (200, 201), mod.text
        # D183 步 2：每角色第二个环境 + 第二个场景 + 计划里一条真关联，供 link 四行当靶。
        # 第二个环境给 link_update（换成「角色自己的 env」才是权限门形状——第一环境已被
        # 挂链时抄成 link 的 env，换成同一个值改不动任何东西）；第二个场景给 link_create
        # （同计划同对象撞 uq → 409，放行格要 2xx）。READONLY 走不到这里，_ids 落 PA 的。
        env2 = await client.post("/api/v1/envs", params={"project_id": pid},
                                 json={"project_id": pid, "name": f"mx-env2-{role}"}, headers=h)
        assert env2.status_code in (200, 201), env2.text
        s2 = await client.post("/api/v1/scenarios",
                               json={"project_id": pid, "name": f"mx-sc2-{role}"}, headers=h)
        assert s2.status_code in (200, 201), s2.text
        lk = await client.post(f"/api/v1/plans/{pl.json()['id']}/case-links",
                               json={"project_id": pid, "subject_type": "scenario",
                                     "subject_id": s.json()["id"]}, headers=h)
        assert lk.status_code in (200, 201), lk.text
        # D183 步 4：每角色一份自己的报告，供 report 四行当靶（同款「拒绝格用权限门
        # 该挡住的形状」纪律——借归属缺失混 404 会掩盖门失效）。
        rep = await client.post(f"/api/v1/plans/{pl.json()['id']}/reports",
                                json={"project_id": pid}, headers=h)
        assert rep.status_code in (200, 201), rep.text
        ctx["res"][role] = {"env": env.json()["id"], "definition": d.json()["id"],
                            "scenario": s.json()["id"], "scenario_version": s.json()["version"],
                            "view": v.json()["id"], "plan": pl.json()["id"],
                            "empty_plan": ep.json()["id"],
                            "env2": env2.json()["id"], "scenario2": s2.json()["id"],
                            "link": lk.json()["id"], "report": rep.json()["id"],
                            "module": mod.json()["id"],
                            # 可重建的单步重跑源（run_rerun_step 行的靶，见行注释）
                            "rerun_src": await _mk_rerun_src(
                                session, project_id=pid, scenario_id=s.json()["id"], role=role),
                            # D164 取消三行的靶：每角色 × 每域一条 queued run（行注释见 ROWS）
                            "cancel_src_scenario": await _mk_cancel_src(
                                session, project_id=pid, subject_type="scenario", role=role),
                            "cancel_src_ui": await _mk_cancel_src(
                                session, project_id=pid, subject_type="ui_case", role=role),
                            "cancel_src_adb": await _mk_cancel_src(
                                session, project_id=pid, subject_type="adb_case", role=role)}
    return ctx


async def _mk_cancel_src(session, *, project_id: str, subject_type: str, role: str) -> str:
    """直造一条对应域的 queued run 供 run_cancel_* 三行打靶（口径同 _mk_rerun_src：
    矩阵每格都建 ctx，真跑执行链会把 152 格拖成执行套件）。取消只落旗不改 status，
    同一条源被多格复用也不会第二格吃到 409。"""
    from app.modules.execution.models import RunRecord

    rec = RunRecord(project_id=project_id, subject_type=subject_type,
                    subject_id="mx-cancel", subject_name="矩阵取消源-" + subject_type + "-" + role,
                    trigger="manual", status="queued")
    session.add(rec)
    await session.commit()
    return rec.id


async def _mk_rerun_src(session, *, project_id: str, scenario_id: str, role: str) -> str:
    """直造一个「可重建」的源 run：summary_graph 里有 set_var 节点 + 该步 vars_snapshot
    非 NULL 的失败明细行。放行格于是真跑到 passed（set_var 不发请求，零外部依赖），
    钉的是整条 rerun-step 链路（权限门→快照重建→引擎→终态回写），不是只看门 403。
    走 ORM 直造而非真跑一遍：矩阵每格都建 ctx，真跑会把 148 格拖成执行套件。"""
    from app.modules.execution.models import RunRecord, RunStepResult

    node = {"key": "mxv", "kind": "set_var", "name": "矩阵重跑源", "ref": None,
            "config": {"vars": {"mx": role}}, "children": []}
    rec = RunRecord(project_id=project_id, subject_type="scenario", subject_id=scenario_id,
                    subject_name="矩阵重跑源-" + role, trigger="manual", status="failed",
                    summary_graph={"version": 1, "nodes": [node]})
    session.add(rec)
    await session.flush()
    session.add(RunStepResult(run_id=rec.id, step_key="mxv", row_no=0, kind="set_var",
                              status="fail", vars_snapshot={"mx": role}))
    await session.commit()
    return rec.id


async def _mk_project(client, h, name):
    r = await client.post("/api/v1/projects", json={"name": name, "description": "d"}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.parametrize("row,role", [(ROWS[i], ROLE_ORDER[j])
                                      for i in range(len(ROWS)) for j in range(4)],
                         ids=MATRIX_IDS)
async def test_permission_matrix(client, make_user, session, row, role, fake_bus) -> None:
    """一格 = 一次真调用：真实 JWT、真实角色成员、真路由；预期由权限表推导。"""
    ctx = await _build_ctx(client, make_user, session)
    expected_allow = _expected(row, role)
    r = await row["request"](ctx, role)

    hole = next((h for h in KNOWN_HOLES if h["row"] == row["id"] and h["role"] == role), None)
    if hole is not None:  # 已登记的越权：钉实测行为，让洞可见且可数，不假装绿
        assert r.status_code == hole["observed_status"], \
            f"KNOWN_HOLE {row['id']}×{role} 实测漂移：" + r.text
        return

    if expected_allow:
        assert 200 <= r.status_code < 300, (
            f"预期放行被拒：{row['desc']}（{row['id']}）×{role} → {r.status_code} {r.text}")
    else:
        assert r.status_code == 403, (
            f"预期拒绝却放行（越权！）：{row['desc']}（{row['id']}）×{role} → "
            f"{r.status_code} {r.text[:200]}")
        body = r.json()
        assert body["code"] in ("insufficient_permission", "forbidden")
        # D38 还债：位缺失型拒绝（insufficient_permission）必须指名缺的位（details.perm == 本行位）；
        # 成员制门（forbidden，与「不存在」同体）不指名，details 恒裸 {}。摘掉抛错处的
        # {"perm": ...} 实现，本格子断言立刻红。
        if body["code"] == "insufficient_permission":
            assert body["details"] == {"perm": _perm_of(row)}, (
                f"403 details.perm 契约破坏：{row['id']}×{role} 期望位 "
                f"{_perm_of(row)}，实得 {body['details']}")
        else:
            assert body["details"] == {}, (
                f"forbidden 泄漏了 details（与不存在的同体契约作废）：{row['id']}×{role}："
                + str(body["details"]))


async def test_cross_project_isolation(client, make_user) -> None:
    """项目 A 的成员读项目 B 的资源：必须 403 forbidden（与不存在同响应，不泄露存在性）。"""
    _, h_a = await make_user("iso_bossA")
    pid_a = (await _mk_project(client, h_a, "A项目"))["id"]
    _, h_b = await make_user("iso_bossB")
    pid_b = (await _mk_project(client, h_b, "B项目"))["id"]
    u_me, h_me = await make_user("iso_member")
    r = await client.put(f"/api/v1/projects/{pid_a}/members/{u_me.id}",
                         json={"role_code": "MEMBER"}, headers=h_a)
    assert r.status_code == 200
    # 再拉一个只属于 B 的资源，A 成员按 id 也读不到
    env_b = await client.post("/api/v1/envs", params={"project_id": pid_b},
                              json={"project_id": pid_b, "name": "B环境"}, headers=h_b)
    assert env_b.status_code in (200, 201), env_b.text
    b_env_id = env_b.json()["id"]

    cases = [
        ("GET", f"/api/v1/envs?project_id={pid_b}", None),
        ("GET", f"/api/v1/reports?project_id={pid_b}", None),
        ("POST", f"/api/v1/envs?project_id={pid_b}", {"project_id": pid_b, "name": "蹭一个"}),
        ("GET", f"/api/v1/scenarios?project_id={pid_b}", None),
        ("GET", f"/api/v1/projects/{pid_b}", None),
        ("PATCH", f"/api/v1/envs/{b_env_id}", {"project_id": pid_b}),
    ]
    for method, url, body in cases:
        r = await client.request(method, url, json=body, headers=h_me)
        assert r.status_code == 403, f"{method} {url} → {r.status_code}，跨项目隔离失效：" + r.text
        assert r.json()["code"] == "forbidden"


def _production_perm_points() -> set[str]:
    """注册表里的权限位，但剔掉**测试专用**服务的位。

    REGISTRY 是进程级单例：test_registry.py 的 `sample:thing:*`、test_dispatcher.py 的
    `demosample:*` 一旦被 import 就永久在场，与跑测顺序无关。它们不是产品权限位，收进
    KNOWN_PREFIX_FAMILIES 等于让矩阵给空气盖章，所以按 handler 的源头模块筛掉——
    生产位永远来自 `app.`，测试位来自 `tests.`。
    """
    from app.core.registry import REGISTRY

    return {
        t.perm
        for t in REGISTRY.all()
        if getattr(t.handler, "__module__", "").startswith("app.")
    }


async def test_perm_prefix_coverage(client) -> None:
    """覆盖率钉：注册表里每个权限位的首段必须落在已认前缀族，新位必须进矩阵。

    client 夹具顺带完成 create_app（import 全部 service 模块）——注册表是进程级单例，
    本文件跑在最前也不会空。
    """
    from app.core.registry import REGISTRY

    perms = _production_perm_points()
    assert perms, "注册表为空：客户端未组装应用，本测试失去意义"
    unknown = {p for p in perms if p.split(":")[0] not in KNOWN_PREFIX_FAMILIES}
    assert not unknown, (
        "出现矩阵未考虑过的权限位前缀族，请评估并加进矩阵行（或确认属于新批次在途）："
        + str(sorted(unknown)))
    # 每行 svc 必须在注册表且路由投影存在——行不会悄悄对着已删除的服务测空气
    for row in ROWS:
        if row["svc"] is not None:
            spec = REGISTRY.get(row["svc"])
            assert spec is not None, f"矩阵行 {row['id']} 指向不存在的 service：{row['svc']}"
            assert spec.http is not None, f"矩阵行 {row['id']} 的服务没有 HTTP 路由"
    prefixes = {_perm_of(r).split(":")[0] for r in ROWS if "manual_perm" not in r}
    assert len(prefixes) >= 10, "矩阵必须覆盖 ≥10 个域前缀，当前只有：" + str(sorted(prefixes))


def test_role_table_snapshot() -> None:
    """快照钉：本文件的角色位集与生产内置角色表逐字相等。

    矩阵用快照推导期望、执行路径用生产实现——两处的**独立**正是测试的价值；
    但如果生产角色表被改而这里没跟上，必须有人先知道（此测试红 → 人裁决后才允许同步快照）。
    """
    from app.modules.iam.roles import BUILTIN_ROLES

    live = {r["code"]: list(r["perms"]) for r in BUILTIN_ROLES}
    assert live == ROLE_TABLE, (
        "内置角色权限表漂移：矩阵快照与生产不一致。先裁决语义，再同步 ROLE_TABLE 快照："
        + f"\n生产={live}\n快照={ROLE_TABLE}")
