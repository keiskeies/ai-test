"""D110 权限位语义哨兵：`:read` 结尾的位不许干写的事（注册表全量投影）。

为什么门禁①里已有的权限矩阵照不出这类问题：`test_permission_matrix` 钉的是
「**声明的**权限位 × 角色表 → 该不该放行」，声明是它的**输入**。声明本身错了
（该写类的端点把位声明成 `:read`），矩阵只会忠实地按错声明判绿。
R157 那类哨兵也照不出：它查的是「有没有项目门」，不是「权限位与副作用对不对得上」。

为什么这件事必须有个闸（不是洁癖）：READONLY 的角色位集是 `["*:read"]`
（test_permission_matrix.ROLE_TABLE，与生产 `iam/roles.BUILTIN_ROLES` 由
test_role_table_snapshot 逐字钉死），它的语义是**不许改状态**，不是「不许用 POST」。
把带副作用的端点声明成 `:read`，等于亲手取消这条不变量：
- 只读用户可触发外部副作用（D109：真发一条出站 webhook 并落库 last_send）；
- `agent/runner.tool_schemas` → `REGISTRY.list_tools(perms)` 只按 `tool` 与权限位过滤，
  **不看 effect**，而 `agent/dispatcher.py:73` 的模式门是 `mode == "PLAN" and effect != "read"`
  ——一个 effect 撒谎的写类工具因此可以绕过 PLAN 的只读承诺。

判定口径（与 R157 同一套纪律：先只报告、名单逐条裁决后才封盘）：
- 总体：`REGISTRY.all()` 运行时投影，按 `handler.__module__` 以 `app.` 开头剔掉测试专用
  service（`sample:*` 一 import 就永久在场，给空气盖章不如不盖）。
- 可疑形状：HTTP 动词是 POST/PATCH/DELETE，或路径含 `/delete` `/purge` `/restore`
  `/force`，**且** `perm` 以 `:read` 结尾。
- **可疑 ≠ 违规**：本轮 6 条可疑里 4 条正当（导出只读、cron 纯算、连设备不落库）。
  所以本例不判形状有罪，只钉「**名单不许悄悄变长**」：新增一条就必须进来写理由，
  或改成正确的写类权限位。判真伪仍然要读函数体——这一步脚本代不了。

腐烂双向钉：白名单里的服务若已消失/已改对权限位，`test_..._whitelist_does_not_rot`
反向变红，逼人来摘条目（一份只增不减的白名单三个月后就是另一层假绿）。
"""

from __future__ import annotations

from typing import Any

# 写语义的 HTTP 形状。PUT 全仓无使用，仍列上以防有人开始用。
_WRITE_VERBS = frozenset({"POST", "PATCH", "PUT", "DELETE"})
_WRITE_PATH_HINTS = ("/delete", "/purge", "/restore", "/force")

# 逐条裁决过的名单（key = service name）。理由必须能被人打开核对，不是形容词。
ADJUDICATED_READ_PERM_WRITES: dict[str, str] = {
    # —— 正当：POST 只是装得下筛选条件，函数体零副作用 ——
    "api_export": "只读导出，函数体不写库不发外部请求（POST 承载筛选条件）。",
    "scenario_export": "同上，形状逐字照抄 api_export。",
    "schedule_task_next_5": "纯算 cron，入参是**未落库草稿**，无副作用。",
    # D191/D201：POST 只为承载筛选/试探参数，函数体只读不写、不发外部请求。
    "defect_export": "只读导出 CSV（筛选条件走 POST body）；函数体不写库、不发外呼。",
    "mock_rule_test": "只用方法与路径在本项目规则表里试匹配顺序；返回命中规则，不落库、不记命中。",
    # D236：POST 只承载 recycled 开关；函数体两次 count/group by，不写库不发外呼。
    "functional_case_stats": "功能用例分组计数（只为承载项目+视图参数用 POST）；只读聚合。",
    # D269：组织读接口用 POST 承载 org_id/q；函数体只 select，授权在体内按组织成员/管理员判定。
    # 平台面上非管理员只有 auth:*，READONLY 的项目位集又被 `-system:*` 裁掉，触发不到这些口。
    "org_list": "组织列表：只读 select；POST 仅为承载 q/status 筛选，零副作用。",
    "org_get": "组织详情：只读 select + count；授权按系统管理员/组织成员在现场判定。",
    "org_member_list": "组织成员列表：只读 join；要求系统管理员或该组织 ORG_ADMIN，不写库。",
    "org_project_list": "组织项目列表：只读 select；要求系统管理员或该组织成员，不写库。",
    # D270：用户组读接口同样用 POST 承载 org_id/group_id；只 select，不写库。
    "org_group_list": "用户组列表：只读 select + count；要求组织管理位持有者，零副作用。",
    "org_group_member_list": "用户组成员列表：只读 join；要求组织管理位持有者，不写库。",
    # D271：组织级缺陷状态流模板的读口同样用 POST 承载 org_id；只 select，不写库。
    # 写口（save/reset）声明的是 system:org:update，不在这份名单里。
    "defect_org_flow_get": "组织状态流模板读取：只 select 两张模板表；授权经 org_cap_check，零副作用。",
    # D271：跨模块能力核验口（缺陷等模块经 REGISTRY 调用）。只查成员/组权限并投影，
    # 不写库、不发外呼——POST 只是为了让请求体能装下 org_id + cap。
    "org_cap_check": "组织管理位核验：只查 org_member/组并集后返回投影，零副作用。",
    # —— 边界：有外部动作但不改平台状态。D109 已按同一把尺子量过，业主裁决前留在名单里 ——
    "adb_device_test": "连设备取型号 + screencap，不写库（docstring 自述）；无密钥回显。",
    # —— D109：已知违规，业主裁决前如实登记，不在本轮自决修 ——
    # 摘这两条的唯一合法方式是把权限位改成写类（或去掉落库/外呼），然后它们自动离开名单。
    "notify_channel_test": (
        "D109 待裁：真发一条出站 webhook 且 row.last_send 落库 commit，却声明 "
        "notify:channel:read。渠道是平台级（表无 project_id），该位四角色全命中 ⇒ "
        "READONLY 可产生外部副作用。**不要靠把它移出名单来让它消失。**"
    ),
    "model_cfg_probe": (
        "D109 待裁：cfg.probe_result 落库 commit + 拿密钥真打模型，却声明 model:cfg:read。"
        "tool=False 不进 agent 面，HTTP 面仍敞。"
    ),
}


def _prod_services() -> list[Any]:
    """注册表里的生产 service（剔掉测试专用：handler 源头模块不以 `app.` 开头）。"""
    from app.core.registry import REGISTRY

    return [s for s in REGISTRY.all() if getattr(s.handler, "__module__", "").startswith("app.")]


def _write_verb_read_perm(services: list[Any]) -> set[str]:
    out = set()
    for s in services:
        http = getattr(s, "http", None)
        if not http or not str(s.perm).endswith(":read"):
            continue
        if http["method"] in _WRITE_VERBS or any(h in http["path"] for h in _WRITE_PATH_HINTS):
            out.add(s.name)
    return out


def test_read_perm_writes_are_all_adjudicated(client) -> None:
    """闸门：出现**没裁决过**的「写形状 + :read 位」服务即红。

    client 夹具顺带完成 create_app（注册表是进程级单例，见 conftest 与矩阵同款说明）。
    """
    services = _prod_services()
    # 先确认探针确实量到了东西：注册表在 create_app 里才填充，
    # 曾经没有这条断言时，探针报过「HTTP 服务 0 个」这种一脸正经的假绿。
    assert services, "注册表为空：应用未装配，本测试失去意义"
    suspicious = _write_verb_read_perm(services)
    new = suspicious - set(ADJUDICATED_READ_PERM_WRITES)
    assert not new, (
        "新增的端点把写语义声明成了 :read 权限位，READONLY 角色因此能触发它的副作用"
        "（READONLY 的位集是 [\"*:read\"]，语义是「不许改状态」而不是「不许用 POST」）。"
        f"请改用写类权限位；若确认无副作用，把它连同**可核对的理由**加进 "
        f"ADJUDICATED_READ_PERM_WRITES：{sorted(new)}"
    )


def test_d109_entries_still_are_what_we_thought(client) -> None:
    """名单里那两条 D109 的现状不许悄悄变好或变坏——任何一边变了都要有人重新读一遍。"""
    from app.core.registry import REGISTRY

    for name in ("notify_channel_test", "model_cfg_probe"):
        spec = REGISTRY.get(name)
        assert spec is not None, f"{name} 已不存在：D109 该随它一起结案，请删名单条目"
        assert str(spec.perm).endswith(":read"), (
            f"{name} 的权限位已改成写类 ⇒ D109 那条已修，请把名单里的 D109 条目摘掉并重跑门禁"
        )
        assert spec.effect == "read", (
            f"{name} 的 effect 改了：dispatcher 的 PLAN 模式门（effect != \"read\"）"
            "从此对它生效，D110 的论证前提变了，请回台账改口径"
        )


def test_adjudicated_whitelist_does_not_rot(client) -> None:
    """反向腐烂：名单里的服务消失、或已不再可疑 ⇒ 红，逼人来摘。"""
    suspicious = _write_verb_read_perm(_prod_services())
    from app.core.registry import REGISTRY

    for name in sorted(ADJUDICATED_READ_PERM_WRITES):
        assert REGISTRY.get(name) is not None, f"名单里的 {name} 已不存在，请摘掉条目"
        assert name in suspicious, (
            f"{name} 已不再是「写形状 + :read 位」（权限位或路由改了），"
            "名单条目该随现状摘掉——留着就是把一份会腐烂的台账当事实"
        )


# —————————————————————————— 第二道闸：写副作用能不能被审计看到 ——————————————————————————
# 蓝图 :142「全写操作 + 全部 Agent 工具调用落 audit_log」、:284「所有写接口走权限位依赖 + 审计」。
# 审计只有三个落点，都在**调用侧**而非 service 自身：HTTP body 方法的路由投影
# （core/service.py:339-347，成败都落）、agent dispatcher（dispatcher.py:98-104）、
# 定时入口显式 write_audit（schedule/service.py:342/369/379）。
# 所以「effect 声明为写，但三条通路一条都不沾」= 一个静默的审计盲区。
# 本轮实测（写/破坏性 94 条）：93 条走 HTTP body 方法落审计，0 条靠工具面，1 条不沾。
# 顺带记录一条本轮量出来的**假阳**：GET 路由投影确实不落审计（service.py:368-373 零审计调用），
# 但全仓没有 GET + 真改动静形的 service —— 首个候选 scenario_references 的 `.add(`
# 是 `set.add`（services.py:419）。判定「有无写」必须读函数体，形状匹配只能圈出待读清单。
ADJUDICATED_UNREACHABLE_WRITES: dict[str, str] = {
    "adb_case_engine_run": (
        "http=None + tool=False：既不进 HTTP 面也不进 agent 面，只被场景引擎进程内直调"
        "（engine/handlers.py:510-518 spec.handler(...)），因此它自身不落审计行。"
        "这不是漏审：它的每一次执行都发生在一个 scenario_run 内部，而 scenario_run 是 "
        "POST service、由路由投影落审计——审计粒度是「一次场景运行」，不是「一次设备交互」，"
        "逐步明细在 run_step 表而非 audit_log（§4.9 两表分工）。"
    ),
    # 以下三条同为 `http=None + tool=False` 的内部件，只在已带门的写服务同一事务内被调用；
    # 审计由外层那次 HTTP body 写调用承载（audit_log 记 action=外层服务名），
    # 本条自身没有独立入口，因此也不该要求它单独落行。
    "project_num_next": "内部取号：由创建缺陷/功能用例的 POST 服务同事务调用，审计落外层那次创建。",
    "file_target_purge": "内部附件清理：由删除缺陷/用例的 POST 服务同事务调用，审计落外层那次删除。",
    "review_case_auto_re_review": (
        "内部重提审：由更新功能用例的 POST/PATCH 服务在同事务内触发（受项目开关控制），"
        "审计落外层那次更新。"
    ),
}


def test_write_services_are_auditable(client) -> None:
    """闸门：出现**没裁决过**的「写副作用但三条审计通路一条都不沾」的 service 即红。

    为什么权限矩阵与 R157 都照不出：它们查的是「能不能调用」「有没有项目门」，
    调用之后**留不留痕**不在它们的口径里。
    """
    services = _prod_services()
    assert services, "注册表为空：应用未装配，本测试失去意义"
    from app.core.service import _BODY_METHODS

    def auditable(s: Any) -> bool:
        if s.tool:  # dispatcher 每次工具调用都落 entry=agent
            return True
        http = getattr(s, "http", None)
        return bool(http) and str(http["method"]).upper() in _BODY_METHODS

    loose = {s.name for s in services if s.effect in ("write", "destructive") and not auditable(s)}
    new = loose - set(ADJUDICATED_UNREACHABLE_WRITES)
    assert not new, (
        "新增的写类 service 既没有 HTTP body 方法路由、也没进 agent 工具面 ⇒ 它的执行不落 "
        "audit_log，业主在 §11.4.27 查不到它（蓝图 :142「全写操作落审计」）。"
        "给它一条 HTTP body 方法路由或 tool=True；若它确实只被内部直调、"
        "审计由外层那次调用承载，把它连同**可核对的理由**加进 "
        f"ADJUDICATED_UNREACHABLE_WRITES：{sorted(new)}"
    )


def test_get_routed_services_declare_read_effect(client) -> None:
    """GET 路由投影不落审计（`core/service.py:368-373` 一条审计调用都没有），所以它必须真是只读。

    为什么单独钉：上面两道闸都从 `effect` 出发，而 `effect` 是**声明**——把写服务声明成
    GET，它就同时离开审计（GET 不落）与「写可达性」判定（effect 声明成 read 就不被查）。
    这一条把「GET ⇒ effect=read」变成硬约束：想走 GET 就只能老实声明只读。
    本轮实测 GET 路由服务里的写声明数 = 0（所以名单是空的，不需要白名单）。
    """
    services = _prod_services()
    assert services, "注册表为空：应用未装配，本测试失去意义"
    from app.core.service import _BODY_METHODS

    bad = {
        s.name
        for s in services
        if s.http
        and str(s.http["method"]).upper() not in _BODY_METHODS
        and s.effect not in ("read",)
    }
    assert not bad, (
        "这些服务挂的是 GET 路由，但 effect 声明成写类：GET 的路由投影不落 audit_log，"
        f"它们要么改成 body 方法路由（从而被审计），要么 effect 如实改成 read：{sorted(bad)}"
    )


def test_unreachable_write_whitelist_does_not_rot(client) -> None:
    """同上腐烂双向钉：盲区条目若已补上路由或工具面，就该从名单里摘掉。"""
    from app.core.registry import REGISTRY
    from app.core.service import _BODY_METHODS

    for name in sorted(ADJUDICATED_UNREACHABLE_WRITES):
        spec = REGISTRY.get(name)
        assert spec is not None, f"名单里的 {name} 已不存在，请摘掉条目"
        http = getattr(spec, "http", None)
        on_body = bool(http) and str(http["method"]).upper() in _BODY_METHODS
        assert spec.effect in ("write", "destructive"), (
            f"{name} 已不再是写 effect，名单条目请摘掉"
        )
        assert not (spec.tool or on_body), (
            f"{name} 已落进审计通路（tool={spec.tool} http={http}），"
            "盲区条目该随现状摘掉"
        )
