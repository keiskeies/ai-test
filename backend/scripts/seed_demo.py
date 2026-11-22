"""演示种子（幂等）：演示项目 + 全局配置 + 模块树 + 3 接口 + 2 用例 + 数据集 + 靶场环境 + 出厂假模型 + 只读账号
+ UI 演示段（1C）+ ADB 演示段（1D T8：1 模块 + 1 用例，执行需真机，种子不登记/不假装设备）
+ 通知/定时演示段（1E：本机假接收端渠道 + 挂演示场景的每 5 分钟定时；真钉钉/飞书不进种子）。

前置：backend/.venv/Scripts/python.exe -m alembic upgrade head
用法：backend/.venv/Scripts/python.exe scripts/seed_demo.py
可反复执行：已存在的数据跳过，不覆盖手工修改。
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

if str(Path(__file__).resolve().parents[1]) not in sys.path:  # 直接 python scripts/seed_demo.py 时可导入 app 包
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

TARGET = "http://127.0.0.1:9999"

# 1E 演示通知渠道的本机假接收端（一条 `python -m http.server` 级的临时收端即可，
# 手册 README-1e-demo.md 给了命令）。URL 由 env 覆盖（TP_DEMO_HOOK_URL）：
# 换机器/换端口演示不必改代码。真钉钉/飞书 webhook
# 绝不进种子——那是业主自己的敏感配置，种子替不了也不该替（§13 纪律 1）。
DEMO_HOOK_URL = os.environ.get("TP_DEMO_HOOK_URL", "http://127.0.0.1:9998/hook")

DEMO_PROJECT = "演示商城"
DEMO_ENV = "本地靶场"
MODULE_TOP = "交易链路"
MODULE_SUB = "下单"
DATASET = "订单参数集"
DEMO_MEMBER_PASSWORD = "Demo@12345"  # 演示账号口令，写进手册，便于任何人复跑同一段


def _req(path: str, method: str = "GET", auth: bool = True, body: dict | None = None) -> dict:
    """按靶场接口生成 api_definition 的 request 快照（§4.4 结构；base_url 走全局变量层）。"""
    return {
        "method": method,
        "url": "${base_url}" + path,
        "headers": [["Authorization", "Bearer ${token}"]] if auth else [],
        "params": [],
        "body": body or {"type": "none"},
        "timeout_ms": 5000,
        "assertions": [{"type": "status_code", "expected": 200}],
    }


def _is_legacy_request(req: dict | None) -> bool:
    """旧版种子的形状：url 写死了靶场主机，且头里带字面量 "{{"（渲染前没做模板化）。"""
    if not req:
        return False
    url = str(req.get("url") or "")
    if "${base_url}" in url:
        return False
    if not url.startswith(TARGET):
        return False
    flat = str(req.get("headers") or "") + str(req.get("params") or "")
    return "{{" in flat or "${" not in url


# name, method, path, auth, body
DEMO_APIS = [
    ("登录获取令牌", "POST", "/login", False,
     {"type": "json", "content": {"username": "demo", "password": "demo123"}}),
    ("查询订单", "GET", "/order/{id}", True, None),
    ("查询订单-1号单", "GET", "/order/1", True, None),
]

# 1B 演示场景（T23）：登录 → 提取 token → 轮询查单（while，条件不再成立即停）→ 断言。
# 步骤 ref 指向下面种下的用例 id（seed 时解析回填）；graph 必须零 issue 过 T4 校验。
DEMO_SCENARIO = "演示：登录-取token-轮询查单-断言"

# 1F 演示前提（README-1f-demo.md §2，D161）：候选卡夹具 two_candidate_plans 检索「登录」
# 硬引用 items.0/items.1 两条（search_test_assets 只 LIKE 用例名，定义名检索不到），
# 所以同一定义下种两条名字不同的全继承用例——手册里「手动新建第二条」自此取消。
DEMO_LOGIN_CASE = "登录冒烟"
DEMO_LOGIN_RETRY_CASE = "登录冒烟（重试）"


def demo_scenario_graph(login_case_id: str, query_case_id: str) -> dict:
    """4 步演示场景（§7.4 协议；计划 T23 判据：登录→提取→循环查单 while→断言）。

    loop 的 cond 用 extract 出来的 order_status 判「还没到 PAID 就再查」：
    靶场第一次就返回 PAID，所以恰好跑 1 轮——轮询语义在图上诚实可见，
    而不是把 count 硬写成 1 假装是轮询。
    """
    return {"version": 1, "nodes": [
        {"key": "login", "kind": "api_case", "name": "登录获取令牌", "ref": login_case_id,
         "config": {}, "children": []},
        {"key": "tok", "kind": "extract", "name": "提取 token", "ref": None,
         "config": {"rules": [{"var": "token", "expr": "$.token"}]}, "children": []},
        {"key": "poll", "kind": "loop", "name": "轮询查单（while 未到 PAID）", "ref": None,
         "config": {"mode": "while", "cond": "ctx.vars.get('order_status','') != 'PAID'",
                    "max_iter": 3},
         "children": [
             {"key": "poll.q", "kind": "api_case", "name": "查询订单", "ref": query_case_id,
              "config": {"headers": [["Authorization", "Bearer ${token}"]]}, "children": []},
             {"key": "poll.st", "kind": "extract", "name": "记录订单状态", "ref": None,
              "config": {"rules": [{"var": "order_status", "expr": "$.status"}]},
              "children": []}]},
        {"key": "fin", "kind": "assert", "name": "终局断言：已到 PAID", "ref": None,
         "config": {"assertions": [
             {"type": "status_code", "expected": 200},
             {"type": "json_path_equals", "path": "$.status", "expected": "PAID"}]},
         "children": []},
    ]}


# 1C 演示元素（T20）：定位器逐条对过靶场 HTML（scripts/target_app.py 的 /ui/login 与
# /ui/home），不是猜的——
#   account/password/submit ← <input id="account"…>、<input id="password"…>、<button id="submit"…>
#   title ← <h1 id="title">订单工作台</h1>
# 慢元素 #late-row（3s 后定时器插入）**不**立元素：wait_element 用 inline_locator 就地定位，
# 元素保持计划点名的 4 个。
UI_MODULE_DEMO = "UI 演示"
DEMO_UI_CASE = "演示：登录工作台"
DEMO_UI_ELEMENTS = [
    # name, locator_type, locator
    ("登录页账号框", "id", "account"),
    ("登录页口令框", "id", "password"),
    ("登录按钮", "id", "submit"),
    ("工作台标题", "id", "title"),
]


def demo_ui_steps(eids: dict[str, str]) -> list[dict]:
    """演示 UI 用例的命令序列（§7.2）：打开 → 输入×2 → 点击 → 断言文本「工作台」→
    wait_element 演示慢元素（#late-row 由靶场 3s 定时器插入，时间窗是真的）。

    eids：元素名 → 元素 id（seed 建完元素后回填）。base_url 走全局变量层（R105/D3）。
    """
    return [
        {"id": "d1", "type": "open", "input": "${base_url}/ui/login"},
        {"id": "d2", "type": "input", "element_id": eids["登录页账号框"], "input": "demo"},
        {"id": "d3", "type": "input", "element_id": eids["登录页口令框"], "input": "demo123"},
        {"id": "d4", "type": "click", "element_id": eids["登录按钮"]},
        {"id": "d5", "type": "assert_text", "element_id": eids["工作台标题"], "input": "工作台"},
        {"id": "d6", "type": "wait_element",
         "inline_locator": {"type": "css", "value": "#late-row"}, "timeout_ms": 10000},
    ]


# 1D 演示（T8）：一条 ADB 用例，让新开出来的 ADB 页面不空。
# 步骤零 issue 过 §7.3 协议门（纯 shell/sleep；真跑要设备——见 _seed_adb_via_services 的诚实口径）。
ADB_MODULE_DEMO = "ADB 演示"
DEMO_ADB_CASE = "演示：设备体检两拍"


def demo_adb_steps() -> list[dict]:
    """演示 ADB 用例（§7.3 协议）：设备属性探测 + 等待——**没有真机就只是一份合法资产**，
    调试/执行会明确报设备不可用，种子不假装跑过。"""
    return [
        {"id": "t1", "type": "shell", "config": {"cmd": "getprop ro.product.model"}},
        {"id": "t2", "type": "sleep", "config": {"ms": 500}},
    ]


async def _seed_ui_via_services(db, proj_id: str, admin, env_id: str) -> None:
    """1C 段**必须走公开服务**（与上面 1A/1B 的直插不同，且是刻意的）：
    种子和人点出来走同一条路，两道保存门（协议 + 元素引用）才一起被验证。

    调用形状照 case_services._scenario_refs：REGISTRY.get → model_validate → handler。

    **ctx 用 demo_pm（项目管理员），不用 bootstrap admin**（真走查时量出来的）：
    owner_id 是「负责人」列要显示的人，而前端那列拿**项目成员表**换名字。
    bootstrap admin 是系统管理员、不是这个项目的成员行，于是元素库/UI 用例列表的
    「负责人」整列渲染成一串 36 位 uuid——演示数据自己在演示页面上难看。
    demo_pm 是成员（PROJECT_ADMIN），名字换得出来。
    权限集合也不硬写 `{"*"}`：走 `perms_for` 取这个人在这个项目里**真实**的那套
    （PROJECT_ADMIN = `*` 减 `system:*`）。种子既然要和人走同一条路，权限档位也得一致——
    拿超集跑通的种子，不等于人在界面上跑得通。
    成员还没建出来时（单独跑本函数）退回 admin，只是不好看，不影响能不能建。
    """
    import app.modules.ui_test.case_services  # noqa: F401  触发 @service 注册
    import app.modules.ui_test.element_services  # noqa: F401
    import app.modules.ui_test.module_services  # noqa: F401
    from app.core.registry import REGISTRY
    from app.core.service import ServiceCtx
    from app.modules.iam.models import User
    from app.modules.iam.project_services import perms_for
    from app.modules.ui_test.models import UiCase, UiElement, UiModule

    # 先 flush 再取权限：首跑时 ProjectMember 是这一轮 db.add 出来的，而会话 autoflush=False
    # （core/db.py:75）——不 flush 的话 perms_for 查不到成员行，返回空集，
    # 种子会在自己的第一道权限门上摔死（tests/test_tool_surface_1b.py 的 seed 幂等用例
    # 跑的就是这个全新库路径，它比任何手工演示都更早发现这件事）。
    await db.flush()
    owner = (await db.execute(select(User).where(User.account == "demo_pm"))).scalar_one_or_none() or admin
    ctx = ServiceCtx(entry="http", user_id=owner.id, user_name=owner.name,
                     is_system_admin=owner.is_system_admin,
                     perms=await perms_for(db, owner, proj_id), db=db)

    async def _call(name: str, payload: dict):
        spec = REGISTRY.get(name)
        assert spec is not None, name + " 未注册（ui_test services 没 import 全？）"
        return await spec.handler(spec.model.model_validate(payload), ctx)

    # 模块：树根下的「UI 演示」（select-then-skip，同 seed 其余段）
    mod = (await db.execute(select(UiModule).where(
        UiModule.project_id == proj_id, UiModule.parent_id.is_(None),
        UiModule.name == UI_MODULE_DEMO, UiModule.status == "normal"))).scalar_one_or_none()
    if mod is None:
        out = await _call("ui_module_create", {"project_id": proj_id, "name": UI_MODULE_DEMO})
        mod_id = out.id
        print("[seed] UI 模块已建:", UI_MODULE_DEMO)
    else:
        mod_id = mod.id
        print("[seed] UI 模块已存在:", UI_MODULE_DEMO)

    eids: dict[str, str] = {}
    for name, ltype, loc in DEMO_UI_ELEMENTS:
        ex = (await db.execute(select(UiElement).where(
            UiElement.project_id == proj_id, UiElement.name == name))).scalar_one_or_none()
        if ex is None:
            out = await _call("ui_element_create", {
                "project_id": proj_id, "module_id": mod_id, "name": name,
                "locator_type": ltype, "locator": loc,
                "comment": "种子演示元素（靶场 /ui/login、/ui/home）"})
            eids[name] = out.id
            print("[seed] 元素已建:", name)
        else:
            eids[name] = ex.id
            print("[seed] 元素已存在:", name)
            # 自愈只动 owner：旧版种子用 bootstrap admin 建（前端换不出名字 → 负责人列
            # 显示 uuid）。其余字段（定位器/备注）可能被人改过，一个字都不碰。
            if ex.owner_id != owner.id:
                ex.owner_id = owner.id
                print("[seed] 元素负责人已自愈: " + name)

    ex = (await db.execute(select(UiCase).where(
        UiCase.project_id == proj_id, UiCase.name == DEMO_UI_CASE))).scalar_one_or_none()
    if ex is None:
        await _call("ui_case_create", {
            "project_id": proj_id, "module_id": mod_id, "name": DEMO_UI_CASE,
            "priority": "P1", "steps": demo_ui_steps(eids), "env_id": env_id})
        print("[seed] UI 用例已建:", DEMO_UI_CASE)
    else:
        print("[seed] UI 用例已存在:", DEMO_UI_CASE)
        if ex.owner_id != owner.id:
            ex.owner_id = owner.id
            print("[seed] UI 用例负责人已自愈: " + DEMO_UI_CASE)


async def _seed_adb_via_services(db, proj_id: str, admin) -> None:
    """1D T8 演示段：ADB 模块 + 1 条 ADB 用例（走公开服务，与 _seed_ui_via_services 同族）。

    **诚实口径**：这里**不**登记演示设备——`adb_device_create` 会真发 `adb connect`
    验证，连不上直接 422（D14/§4.5「原样回显」），种子伪造不了也不该伪造一台「在线设备」。
    用例的 default_device 留空 =「空闲即可」（§4.5 原话，存期不校验设备存在性），
    所以没有真机也能建、能在 ADB 页面上看到资产；但**调试/执行这条用例需要一台真机**，
    本种子不演示、也不声称演示了 ADB 执行（§13 纪律 1）。
    """
    import app.modules.adb_test.case_services  # noqa: F401  触发 @service 注册
    import app.modules.adb_test.module_services  # noqa: F401
    from app.core.registry import REGISTRY
    from app.core.service import ServiceCtx
    from app.modules.adb_test.models import AdbCase, AdbModule
    from app.modules.iam.models import User
    from app.modules.iam.project_services import perms_for

    await db.flush()  # autoflush=False：成员行未 flush 则 perms_for 拿到空集（UI 段同款坑）
    owner = (await db.execute(select(User).where(User.account == "demo_pm"))).scalar_one_or_none() or admin
    ctx = ServiceCtx(entry="http", user_id=owner.id, user_name=owner.name,
                     is_system_admin=owner.is_system_admin,
                     perms=await perms_for(db, owner, proj_id), db=db)

    async def _call(name: str, payload: dict):
        spec = REGISTRY.get(name)
        assert spec is not None, name + " 未注册（adb_test services 没 import 全？）"
        return await spec.handler(spec.model.model_validate(payload), ctx)

    mod = (await db.execute(select(AdbModule).where(
        AdbModule.project_id == proj_id, AdbModule.parent_id.is_(None),
        AdbModule.name == ADB_MODULE_DEMO, AdbModule.status == "normal"))).scalar_one_or_none()
    if mod is None:
        mod_id = (await _call("adb_module_create",
                              {"project_id": proj_id, "name": ADB_MODULE_DEMO})).id
        print("[seed] ADB 模块已建:", ADB_MODULE_DEMO)
    else:
        mod_id = mod.id
        print("[seed] ADB 模块已存在:", ADB_MODULE_DEMO)

    ex = (await db.execute(select(AdbCase).where(
        AdbCase.project_id == proj_id, AdbCase.name == DEMO_ADB_CASE))).scalar_one_or_none()
    if ex is None:
        await _call("adb_case_create", {
            "project_id": proj_id, "module_id": mod_id, "name": DEMO_ADB_CASE,
            "priority": "P1", "steps": demo_adb_steps()})
        print("[seed] ADB 用例已建:", DEMO_ADB_CASE, "（执行需真机，见函数 docstring）")
    else:
        print("[seed] ADB 用例已存在:", DEMO_ADB_CASE)
        if ex.owner_id != owner.id:
            ex.owner_id = owner.id
            print("[seed] ADB 用例负责人已自愈: " + DEMO_ADB_CASE)


# 1E 演示（手册 README-1e-demo.md）：1 个通知渠道 + 1 个能跑的定时任务。
# 手册的判据是「打开定时任务页就能看到一条会到点的演示定时」——库里没有就是空话。
DEMO_NOTIFY_CHANNEL = "演示接收端（本机假 hook）"
DEMO_SCHEDULE_TASK = "演示：每 5 分钟跑一次演示场景"
DEMO_SCHEDULE_CRON = "*/5 * * * *"  # 可读的 5 段式：每 5 分钟一次，演示现场不用等整点


async def _seed_schedule_notify_via_services(db, proj_id: str, admin) -> None:
    """1E 演示段：通知渠道 + 定时任务（走公开服务，与 UI/ADB 段同族形状）。

    渠道指本机假接收端（DEMO_HOOK_URL，默认 :9998/hook，env TP_DEMO_HOOK_URL 可覆盖）：
    - 类型用 WEBHOOK——真钉钉/飞书 webhook 不进种子（那是业主的敏感配置，且会向外发真流量）。
    - 渠道是平台级表（notify_channel 无 project_id，见 models docstring），全局按 name 幂等；
      `notify_channel_create` 重名会 409，所以这里 select-then-skip。
    - url 过 senders.encrypt_config（D24）：url 键只有 query 段加密，本机路径无 query，
      落库即明文、回显原样可见——手册要在列表页认出这条渠道。
    - 定时挂 DEMO_SCENARIO 场景（subject_type 一期只有 scenario，D30 白名单），
      notify_channel_ids 挂上面那条渠道；cron 过 service 的 5 段校验闸。
    - schedule_task 有 project_id：幂等按 (project_id, name) select-then-skip。
    """
    import app.modules.notify.service  # noqa: F401  触发 @service 注册
    import app.modules.schedule.service  # noqa: F401
    from app.core.registry import REGISTRY
    from app.core.service import ServiceCtx
    from app.modules.iam.models import User
    from app.modules.iam.project_services import perms_for
    from app.modules.notify.models import NotifyChannel
    from app.modules.scenario.models import Scenario
    from app.modules.schedule.models import ScheduleTask

    await db.flush()  # autoflush=False：成员行未 flush 则 perms_for 拿到空集（UI 段同款坑）
    owner = (await db.execute(select(User).where(User.account == "demo_pm"))).scalar_one_or_none() or admin
    ctx = ServiceCtx(entry="http", user_id=owner.id, user_name=owner.name,
                     is_system_admin=owner.is_system_admin,
                     perms=await perms_for(db, owner, proj_id), db=db)

    async def _call(name: str, payload: dict):
        spec = REGISTRY.get(name)
        assert spec is not None, name + " 未注册（schedule/notify services 没 import 全？）"
        return await spec.handler(spec.model.model_validate(payload), ctx)

    # 渠道：平台级、全局按 name 幂等（create 侧重名 409，先查后建绕开）
    ch = (await db.execute(select(NotifyChannel).where(
        NotifyChannel.name == DEMO_NOTIFY_CHANNEL))).scalar_one_or_none()
    if ch is None:
        ch_id = (await _call("notify_channel_create", {
            "name": DEMO_NOTIFY_CHANNEL, "type": "WEBHOOK",
            "config": {"url": DEMO_HOOK_URL}})).id
        print("[seed] 通知渠道已建:", DEMO_NOTIFY_CHANNEL, "->", DEMO_HOOK_URL)
    else:
        ch_id = ch.id
        print("[seed] 通知渠道已存在:", DEMO_NOTIFY_CHANNEL)

    # 定时：挂到种子里已有的演示场景上（场景段在前，这里必能查到）
    sc = (await db.execute(select(Scenario).where(
        Scenario.project_id == proj_id, Scenario.name == DEMO_SCENARIO))).scalar_one()
    ex = (await db.execute(select(ScheduleTask).where(
        ScheduleTask.project_id == proj_id, ScheduleTask.name == DEMO_SCHEDULE_TASK))).scalar_one_or_none()
    if ex is None:
        await _call("schedule_task_create", {
            "project_id": proj_id, "name": DEMO_SCHEDULE_TASK,
            "subject_type": "scenario", "subject_id": sc.id,
            "cron": DEMO_SCHEDULE_CRON, "enabled": 1, "notify_channel_ids": [ch_id]})
        print("[seed] 定时任务已建:", DEMO_SCHEDULE_TASK, "（", DEMO_SCHEDULE_CRON, "）")
    else:
        print("[seed] 定时任务已存在:", DEMO_SCHEDULE_TASK)
        # 自愈只补「场景/渠道重建后失联的引用」；cron/enabled 可能被人改过，不碰
        # （同场景段 ref 自愈的口径）。
        fixed = False
        if ex.subject_id != sc.id:
            ex.subject_id = sc.id
            fixed = True
        if ch_id not in (ex.notify_channel_ids or []):
            ex.notify_channel_ids = [ch_id]
            fixed = True
        if fixed:
            await db.flush()
            print("[seed] 定时任务引用已自愈:", DEMO_SCHEDULE_TASK)



async def _ensure_login_case(db, proj_id: str, definition_id: str, name: str):
    """登录用例的 select-then-create（按 项目+定义+name 幂等，与全文件同族形状）。

    1F 演示前提（README-1f-demo.md §2）：候选卡夹具 two_candidate_plans 检索「登录」
    要 2 条用例（search_test_assets 只 LIKE ApiCase.name），所以 seed 建两条同名不同、
    定义全继承的：「登录冒烟」与「登录冒烟（重试）」——手册里「手动新建第二条」自此取消。
    """
    from app.modules.api_test.models import ApiCase

    ex = (await db.execute(select(ApiCase).where(
        ApiCase.project_id == proj_id, ApiCase.definition_id == definition_id,
        ApiCase.name == name))).scalar_one_or_none()
    if ex is not None:
        return ex
    case = ApiCase(project_id=proj_id, definition_id=definition_id, name=name, priority="P1")
    db.add(case)
    await db.flush()
    print("[seed] 用例已建: " + name)
    return case


async def main() -> int:
    from app.core.config import get_settings
    from app.core.db import get_sessionmaker
    from app.modules.api_test.models import ApiCase, ApiDefinition, ApiModule, DataSet
    from app.modules.env.models import Environment, GlobalConfig
    from app.modules.iam.bootstrap import run_bootstrap
    from app.modules.iam.models import Project, User
    from app.modules.model_cfg.models import ModelConfig

    async with get_sessionmaker()() as db:
        r = await run_bootstrap(db)
        if r["printed_password"]:
            print("[seed] 已创建管理员 admin，初始密码（仅打印一次）：" + r["printed_password"])

        proj = (await db.execute(select(Project).where(Project.name == DEMO_PROJECT))).scalar_one_or_none()
        if proj is None:
            proj = Project(name=DEMO_PROJECT, description="演示项目：靶场 mock 系统（:9999）")
            db.add(proj)
            await db.flush()
            print("[seed] 项目已建:", proj.name)
        else:
            print("[seed] 项目已存在:", proj.name)

        # 全局配置：base_url/token（§7.5 全局变量层，调试/执行都吃它）
        gcfg = (await db.execute(select(GlobalConfig).where(
            GlobalConfig.project_id == proj.id, GlobalConfig.scope_type == "VAR"))).scalar_one_or_none()
        if gcfg is None:
            db.add(GlobalConfig(project_id=proj.id, scope_type="VAR",
                              items=[["base_url", TARGET], ["token", "tk-demo"]]))
            print("[seed] 全局变量已建 -> ", TARGET)

        env = (await db.execute(select(Environment).where(
            Environment.project_id == proj.id, Environment.name == DEMO_ENV))).scalar_one_or_none()
        if env is None:
            env = Environment(project_id=proj.id, name=DEMO_ENV, config={"vars": []})
            db.add(env)
            print("[seed] 环境已建:", env.name)
        elif (env.config or {}).get("vars"):
            # 旧版种子把 base_url/token 放在环境层——迁移到全局层（环境=纯净切换位）
            env.config = {"vars": []}
            print("[seed] 环境变量已迁至全局层:", env.name)

        # 模块树两层
        top = (await db.execute(select(ApiModule).where(
            ApiModule.project_id == proj.id, ApiModule.parent_id.is_(None),
            ApiModule.name == MODULE_TOP))).scalar_one_or_none()
        if top is None:
            top = ApiModule(project_id=proj.id, name=MODULE_TOP)
            db.add(top)
            await db.flush()
            print("[seed] 模块已建:", top.name)
        sub = (await db.execute(select(ApiModule).where(
            ApiModule.project_id == proj.id, ApiModule.parent_id == top.id,
            ApiModule.name == MODULE_SUB))).scalar_one_or_none()
        if sub is None:
            sub = ApiModule(project_id=proj.id, parent_id=top.id, name=MODULE_SUB)
            db.add(sub)
            await db.flush()
            print("[seed] 模块已建:", top.name + "/" + sub.name)

        defs: dict[str, ApiDefinition] = {}
        for name, method, p, auth, body in DEMO_APIS:
            ex = (await db.execute(select(ApiDefinition).where(
                ApiDefinition.project_id == proj.id, ApiDefinition.name == name))).scalar_one_or_none()
            if ex is None:
                ex = ApiDefinition(project_id=proj.id, module_id=sub.id, name=name, method=method, path=p,
                                      request=_req(p, method, auth, body), status="complete")
                db.add(ex)
                await db.flush()
                print("[seed] 接口已建:", method, p)
            elif ex.module_id is None:
                ex.module_id = sub.id  # 旧版种子没挂模块——补挂，不碰其他字段
                print("[seed] 接口归位模块:", name)
            elif _is_legacy_request(ex.request):
                # 旧版种子把变量渲染后才落库（url 写死主机、头里留着字面量 "{{token}}"），
                # 那样 §7.5 的分层合并就无从演示：全局配置一改，接口纹丝不动。
                # 只认这一种已知坏形状，用户手改过的请求不碰。
                ex.request = _req(p, method, auth, body)
                print("[seed] 接口请求已迁回模板形态:", name)
            defs[name] = ex

        # 数据集：订单 id 列
        ds = (await db.execute(select(DataSet).where(
            DataSet.project_id == proj.id, DataSet.name == DATASET))).scalar_one_or_none()
        if ds is None:
            ds = DataSet(project_id=proj.id, name=DATASET, columns=["oid"],
                           rows=[["1"], ["2"], ["3"]])
            db.add(ds)
            await db.flush()
            print("[seed] 数据集已建:", ds.name)

        # 用例 2 条：一条纯继承，一条数据驱动覆盖 url
        c1 = defs["查询订单-1号单"]
        ex = (await db.execute(select(ApiCase).where(ApiCase.project_id == proj.id,
                                                 ApiCase.definition_id == c1.id,
                                                 ApiCase.name == "默认用例"))).scalar_one_or_none()
        if ex is None:
            db.add(ApiCase(project_id=proj.id, definition_id=c1.id, name="默认用例",
                           priority="P1", assertions=[{"type": "body_contains", "expected": "order"}]))
            print("[seed] 用例已建: 默认用例")
        c2 = defs["查询订单"]
        ex2 = (await db.execute(select(ApiCase).where(ApiCase.project_id == proj.id,
                                                  ApiCase.definition_id == c2.id,
                                                  ApiCase.name == "数据驱动"))).scalar_one_or_none()
        if ex2 is None:
            db.add(ApiCase(project_id=proj.id, definition_id=c2.id, name="数据驱动",
                           priority="P2", request={"url": "${base_url}/order/${oid}"},
                           dataset_id=ds.id))
            print("[seed] 用例已建: 数据驱动（绑 " + ds.name + "）")

        # 1B 演示场景：登录 → 提取 token → 轮询查单（while）→ 断言（幂等）
        from app.modules.scenario.graph import iter_nodes
        from app.modules.scenario.models import Scenario

        # 1F 前提自动化：两条登录用例（同定义、全继承、名字不同），对齐夹具 items.0/items.1。
        login_case = await _ensure_login_case(db, proj.id, defs["登录获取令牌"].id, DEMO_LOGIN_CASE)
        await _ensure_login_case(db, proj.id, defs["登录获取令牌"].id, DEMO_LOGIN_RETRY_CASE)
        query_case = ex2 if ex2 is not None else (await db.execute(select(ApiCase).where(
            ApiCase.project_id == proj.id, ApiCase.name == "数据驱动"))).scalar_one_or_none()
        if query_case is None:
            qc = ApiCase(project_id=proj.id, definition_id=c2.id, name="数据驱动",
                         priority="P2", request={"url": "${base_url}/order/${oid}"},
                         dataset_id=ds.id)
            db.add(qc)
            await db.flush()
            query_case = qc
            print("[seed] 用例已建: 数据驱动（补建）")
        sc = (await db.execute(select(Scenario).where(
            Scenario.project_id == proj.id, Scenario.name == DEMO_SCENARIO))).scalar_one_or_none()
        if sc is None:
            sg = demo_scenario_graph(login_case.id, query_case.id)
            db.add(Scenario(project_id=proj.id, module_id=None, name=DEMO_SCENARIO,
                            priority="P1", step_graph=sg,
                            variables={}, fail_fast=True,
                            owner_id=None, project_public=True,
                            step_count=sum(1 for _ in iter_nodes(sg)),
                            updated_by=None))
            print("[seed] 演示场景已建:", DEMO_SCENARIO)
        else:
            # 幂等：只把 ref 修到当前用例 id（演示库重建过用例时自愈），不碰用户改过的别的字段
            g = sc.step_graph or {}
            fixed = False
            for n in g.get("nodes", []):
                if n.get("key") == "login" and n.get("ref") != login_case.id:
                    n["ref"] = login_case.id
                    fixed = True
                if n.get("key") == "poll.q" and n.get("ref") != query_case.id:
                    n["ref"] = query_case.id
                    fixed = True
            if fixed:
                sc.step_graph = g
                print("[seed] 演示场景 ref 已自愈:", DEMO_SCENARIO)

        # 演示成员：只读 + 一名项目管理员。
        # 「只读成员视角」是演示的最后一段（§10.1 写按钮消失），密码固定并写进手册：
        # 台上不手打新密码（打错字很难看），台下任何人都能复跑同一段。
        from app.core.security import hash_password
        from app.modules.iam.models import ProjectMember, User

        for account, nm, role in (("demo_ro", "演示只读", "READONLY"),
                                  ("demo_pm", "演示项目管理员", "PROJECT_ADMIN")):
            u = (await db.execute(select(User).where(User.account == account))).scalar_one_or_none()
            if u is None:
                u = User(account=account, name=nm, password_hash=hash_password(DEMO_MEMBER_PASSWORD),
                         is_system_admin=False, status="active")
                db.add(u)
                await db.flush()
                print("[seed] 演示账号已建: " + account + "（密码 " + DEMO_MEMBER_PASSWORD + "）")
            m = (await db.execute(select(ProjectMember).where(
                ProjectMember.project_id == proj.id,
                ProjectMember.user_id == u.id))).scalar_one_or_none()
            if m is None:
                db.add(ProjectMember(project_id=proj.id, user_id=u.id, role_code=role))
                print("[seed] 成员已加入: " + account + " -> " + role)
        # 出厂假模型：base_url=fake://<fixture> → tests/fixtures/fake_model/<fixture>.jsonl 回放。
        # 三个脚本对应演示的三段：S0 五路同生 / 1A 建接口+用例+调试 / PLAN 模式拒绝调试（§9.4）。
        FAKE_MODELS = [
            ("演示假模型（离线回放）", "basic_two_tools", "fake-basic"),
            ("演示假模型（建接口→用例→调试）", "onea_build_and_debug", "fake-build-debug"),
            ("演示假模型（只读被拒）", "plan_debug_denied", "fake-plan-denied"),
        ]
        for nm, fixture, mname in FAKE_MODELS:
            url = "fake://" + fixture
            has = (await db.execute(select(ModelConfig).where(
                ModelConfig.base_url == url))).scalar_one_or_none()
            if has is None:
                first = (await db.execute(select(ModelConfig).where(
                    ModelConfig.model_type == "CHAT", ModelConfig.is_default.is_(True)))).scalar_one_or_none()
                db.add(ModelConfig(name=nm, model_type="CHAT", protocol="OPENAI_COMPAT",
                                   base_url=url, model_name=mname,
                                   supports_tools=True, is_default=first is None, enabled=True))
                print("[seed] 假模型已建: " + nm + "（无需真 API Key 即可演示 Pilot）")
        # 1C 演示段：UI 模块 + 4 元素 + 1 条 UI 用例（走公开服务，见 _seed_ui_via_services）
        admin = (await db.execute(select(User).where(
            User.account == (get_settings().bootstrap_account or "admin")))).scalar_one()
        await _seed_ui_via_services(db, proj.id, admin, env.id)
        # 1D 演示段：ADB 模块 + 1 条 ADB 用例（走公开服务；执行需真机，种子不演示执行）
        await _seed_adb_via_services(db, proj.id, admin)
        # 1E 演示段：通知渠道（本机假 hook）+ 挂演示场景的定时任务（走公开服务）
        await _seed_schedule_notify_via_services(db, proj.id, admin)
        await db.commit()
    print("[seed] 完成。下一步：python scripts/target_app.py 起靶场，python -m app.server 起平台")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
