"""R157 项目数据权限覆盖率钉：入参带 project_id 的 @service 必须带 ensure_project_access 门。

蓝图承诺（docs/2026-11-13-ai-test-platform-design.md §10-2）：「所有列表 SQL 强制 project_id
过滤（基类查询封装，漏写=测试红）」。实现与蓝图不同：仓里没有基类查询封装，真实机制是服务
函数体里手调 `await ensure_project_access(ctx, project_id)`（app/core/service.py:255）。而
「漏写=测试红」此前只兑现了一半——test_permission_matrix 的跨项目隔离只罩矩阵 37 行主要接口，
全仓 160+ 个 @service 里**新增一个忘调门的 service 不会有任何测试变红**。本例补上这个洞：
注册表全量投影，逐个查门，漏写即红。

判定口径（先跑过只报告版，名单逐条裁决后才封盘白名单）：
- 总体：REGISTRY.all() 运行时投影（同 R152 权限树口径），剔掉非 `app.` 源头的测试专用
  service（test_registry 的 sample:* 一 import 就永久在场，同 test_permission_matrix
  ._production_perm_points 的筛法——给空气盖章不如不盖）。
- 义务：入参模型（spec.model）**顶层字段**含 project_id 才要求带门。嵌套子模型里的
  project_id 不在本例视野内（诚实条款；现状扫描未见此形状）。
- 带门判定：`inspect.getsource(spec.handler)` 里出现调用形状 `ensure_project_access(`。
  用 getsource 而不是扫全文件：邻居函数的调用会被算到它头上，那是假绿；认调用形状而不是
  裸词：docstring 提一嘴不算带门。

白名单（每条必须有理由；腐烂由 test_r157_whitelist_does_not_rot 反向钉死）：
四个 *_refs / *_references 都是「经注册表委托」形状——本体只一行转发给 scenario_case_refs
（契约 1：跨模块只经注册表问引用），该内部件体内 `ensure_project_access(ctx,
payload.project_id)` 用的就是同一个 project_id（scenario/services.py 里逐字可查），
门在半途真实落下，跨项目一样 403，不是假绿。

反假绿（test_r143 同款双钉）：
① 带 project_id 的 service 数必须 ≥ 下限且已知带门锚点缺一不可——REGISTRY 没 import 起来 /
   判定被架空，本例必须先红；② 白名单里每个名字必须在 REGISTRY 里、必须真的带 project_id、
   且必须**真的没带门**——写了个不存在的名字、或哪天它补上了门还挂在白名单，都算腐烂。

号段说明：R152–R156 已被 1G 计划落地回填占用（各自对应 main 上真实提交 3f0daa7 / 8bf11de /
8f30503 / b01e653 / ff6cbb3，grep 实测），本钉顺延取 R157。
"""
from __future__ import annotations

import importlib
import inspect
import re

_GATE_CALL_RE = re.compile(r"ensure_project_access\s*\(")


def _own_source(handler) -> str:
    """取「确实是这个 handler 自己」的源码；解析串到邻居就当场红。

    本例口径写的是「不许把邻居函数的调用算到它头上，那是假绿」，但 `getsource` 自己就会串位。
    2026-11-17 全量 ① 实测过一发：跑测试的那 15 分钟里 `ui_test/case_services.py` 被保存
    （16:32:37 出数，D106 于 16:55:25 提交），新字节码 `ui_case_delete.co_firstlineno` 仍是
    旧位置 267，磁盘上函数已被新加的 `_blocked` 推到 285，`getblock` 从 267 反向扫到的就是
    `_blocked` 整块 ⇒ 两条 r157 一起假红（隔离重跑 2 passed）。
    串位是双向的：邻居**带**门 ⇒ 漏门的服务被判绿（比假红严重得多），邻居**不带**门 ⇒ 假红。
    所以认源码之前先验这份源码确实是它自己。
    """
    src = inspect.getsource(handler)
    own_def = re.compile(r"\b(?:async\s+)?def\s+" + re.escape(handler.__name__) + r"\s*\(")
    if not own_def.search(src):
        raise AssertionError(
            f"inspect.getsource({handler.__name__}) 拿到的源码里没有它自己的 def 行——"
            "解析串到了邻居函数，本例的「带门」判定此刻不可信。"
            "先确认没有测试在跑期间改过该文件（行号错位是唯一已知成因），"
            "若是真包装器（handler 不是 def 本体）则本例口径需要改，别放开这条断言。")
    return src


# —— 白名单：该面合法不带门，逐条理由（新条必须写理由，理由不成立就不许进） ——
_WHITELIST: dict[str, str] = {
    # 以下四个同构：HTTP/内部批量引用查询，本体只把 (ctx, payload.project_id) 原样转发给
    # `scenario_case_refs`，该被委托方体内第一句就是 ensure_project_access(ctx, 同一 id)。
    "ui_case_references": "单条引用查询：委托 scenario_case_refs（同 project_id 带门），本体无独立数据访问",
    "ui_case_refs": "批量引用查询（T10 删除保护内部件）：委托链路同上，无独立数据访问",
    "adb_case_references": "单条引用查询：委托 scenario_case_refs（同 project_id 带门），本体无独立数据访问",
    "adb_case_refs": "批量引用查询（T8 删除保护内部件）：委托链路同上，无独立数据访问",
}

# 已知带门锚点（反假绿①：这些必然存在且带门——REGISTRY 空了/判定被架空/锚点改名，本例先红）
_KNOWN_GATED = ("env_resolve", "scenario_case_refs", "ui_case_delete")

# 带 project_id 的 service 数下限（2026-11-17 实测 138，留整改余量取 120）
_MIN_PROJECT_SCOPED = 120


def _project_scoped_services() -> list:
    """运行时 REGISTRY 里「入参模型顶层带 project_id」的生产 service 全集。

    进程级单例：先 import app.main._SERVICE_MODULES（create_app 的同一清单）保证注册表
    非空——与 test_perm_prefix_coverage 借 client 夹具达成的是同一件事，但不起库。
    """
    import app.main as main_mod
    from app.core.registry import REGISTRY

    for mod_name in main_mod._SERVICE_MODULES:
        importlib.import_module(mod_name)
    specs = [t for t in REGISTRY.all()
             if getattr(t.handler, "__module__", "").startswith("app.")]
    return [t for t in specs if "project_id" in t.model.model_fields]


def _ungated(specs: list) -> list[str]:
    return [t.name for t in specs
            if not _GATE_CALL_RE.search(_own_source(t.handler))]


def test_r157_every_project_scoped_service_is_gated() -> None:
    """覆盖率钉主案：带 project_id 的 @service，源码必须调过 ensure_project_access 或进白名单。

    变异自证（2026-11-17 实测）：临时摘掉 app/modules/env/services.py env_resolve 体内
    `await ensure_project_access(ctx, payload.project_id)` 一行 → 本例红（点名 env_resolve）→
    复原 → 绿。
    """
    specs = _project_scoped_services()
    ungated = _ungated(specs)
    violations = [n for n in ungated if n not in _WHITELIST]
    assert not violations, (
        "以下 @service 入参带 project_id 却没调 ensure_project_access，也不在白名单——"
        "跨项目数据越权风险（蓝图 §10-2「漏写=测试红」）：" + str(sorted(violations))
        + "。确属合法（委托带门/天然无项目）就进 _WHITELIST 并写明理由。")


def test_r157_whitelist_does_not_rot() -> None:
    """反假绿：主案盯的集合必须真实存在，且白名单每条都必须还成立。"""
    specs = _project_scoped_services()
    by_name = {t.name: t for t in specs}

    assert len(specs) >= _MIN_PROJECT_SCOPED, (
        f"带 project_id 的 service 只剩 {len(specs)} 个（下限 {_MIN_PROJECT_SCOPED}）——"
        "注册表没 import 起来或判定口径被架空，主案正在盯空气")
    for anchor in _KNOWN_GATED:
        assert anchor in by_name, f"已知带门锚点 {anchor} 不在注册表——本例的扫描面塌了"
        assert _GATE_CALL_RE.search(_own_source(by_name[anchor].handler)), (
            f"锚点 {anchor} 竟然不带门了——先查它是不是真被摘了门，再动本清单")

    ghost = [n for n in _WHITELIST if n not in by_name]
    assert not ghost, (
        "白名单里出现了不在「带 project_id 的 service」集合里的名字（改名/删服务/字段没了 = "
        "白名单腐烂，主案一旦拿它当豁免就会错放真实越权面）：" + str(sorted(ghost)))
    # 哪天白名单成员补上了门，必须摘条——豁免一个已带门的服务 = 门被再摘掉时本例照样绿
    stale = sorted(n for n in _WHITELIST if n not in _ungated(list(by_name.values())))
    assert not stale, (
        "白名单成员其实已经自己带门了，豁免已过期，从 _WHITELIST 摘除：" + str(stale))
