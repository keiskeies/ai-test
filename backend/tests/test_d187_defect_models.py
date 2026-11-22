"""D187 步 1：`defect` / `defect_case_link` 的模型、迁移与状态词表守卫。

与 test_ui_models.py / test_adb_models.py 同构：测**列的存在与默认值 + 词表自洽**，
不测业务规则（转移校验、回收站三态在步 2/4 的服务面测）。

为什么本文件里那条「模型列 == 库列」是承重的一条，而不是走过场：
**全仓没有任何一条测试或脚本把 Base.metadata 与真库比对**（现查
`grep -rn "Base.metadata" --include=*.py .` 只命中 `migrations/env.py:40` 一处，
那是 autogenerate 的输入，不是断言）。所以「模型写了、迁移没写」或反过来
**没有任何自动护栏** —— 症状是页面读到 undefined 或 insert 报 Unknown column，
离真正的错处隔了几层。本文件逐列双向比对，两张表都比对。

时刻列（created_at/updated_at）不在断言范围内：它们的形状由 `UtcDateTime` 决定，
`test_d187_*` 服务面用例从 payload 侧钉（那才是 `+00:00` 那种症状会现形的地方）。
"""
from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app.modules.defect.models import (
    DEFECT_CASE_TYPES,
    DEFECT_END_STATUSES,
    DEFECT_START_STATUS,
    DEFECT_STATUSES,
    DEFECT_TRANSITIONS,
    PRIORITIES,
    Defect,
    DefectCaseLink,
)


@pytest_asyncio.fixture()
async def two_projects(session):
    from app.modules.iam.models import Project

    a = Project(name="缺陷项目A")
    b = Project(name="缺陷项目B")
    session.add_all([a, b])
    await session.commit()
    return a.id, b.id


# ══════════════ 词表自洽（纯内存，不需要库）══════════════
# 步 2 的写路径校验器直接拿这几份常量比对，所以**常量的不自洽 = 接口的错**。
# MS 那边这套拓扑是数据（三张表 + 种子 SQL），删状态项不查引用就留下悬空状态
# （取证 §G 第 7 条）；我们搬进源码，自洽性就该由测试当场钉住。


def test_transition_graph_is_closed_over_the_status_vocab() -> None:
    """边的定义域/值域都必须是词表内的状态，且每个状态都得有出边定义（哪怕是空元组）。

    「值域里有词表外的值」在运行时的表现 = 那条转移永远 409，而单测若不查，
    它是安静地活着的：只有人手点那条边才会撞到。
    """
    assert set(DEFECT_TRANSITIONS) == set(DEFECT_STATUSES), (
        f"边表定义域与词表不符：多出 {set(DEFECT_TRANSITIONS) - set(DEFECT_STATUSES)}，"
        f"少了 {set(DEFECT_STATUSES) - set(DEFECT_TRANSITIONS)}"
    )
    for src, targets in DEFECT_TRANSITIONS.items():
        unknown = set(targets) - set(DEFECT_STATUSES)
        assert not unknown, f"{src} 的出边指向词表外的状态 {unknown}：那条转移永远不可达"


def test_no_self_loops_because_same_state_is_not_a_transition() -> None:
    """自环**不该存在**，理由是规则有例外（from == to 直接放行、不查边表），不是漏配。

    这条测试钉的是那个例外的前提：哪天有人给 new 加了 `new`，
    「不查表」与「查表」两条路对同一请求会给出不一致答复。
    """
    for src, targets in DEFECT_TRANSITIONS.items():
        assert src not in targets, f"{src} 有自环——那会让「只改标题不改状态」的语义变成两条路"


def test_start_and_end_markers_are_real_statuses() -> None:
    """START/END 在 MS 是 status_definition 的两类行；我们是常量，所以「指向存在的状态」必须钉。

    MS 的 START 是 `bug_new`、END 是 `bug_closed` + `bug_rejected`（取证 §A 种子 :352-354）。
    """
    assert DEFECT_START_STATUS in DEFECT_STATUSES
    assert DEFECT_START_STATUS == DEFECT_STATUSES[0], "起始态必须是词表第一个（前端下拉按词表顺序渲染）"
    assert DEFECT_END_STATUSES <= set(DEFECT_STATUSES)
    # 起始态不该同时是终态：否则「新建」这个动作产出一条「已经开着不算」的行
    assert DEFECT_START_STATUS not in DEFECT_END_STATUSES


def test_the_reopen_edges_are_the_q4_subject() -> None:
    """终态能重开是**已知且刻意**的形状（§七 Q4 待业主裁），不是 bug。

    钉它的理由：`rejected`/`closed` 在 END 集合里，又在边表里有出边。MS 同样如此，
    但它从不校验转移所以从没暴露。我们校验 ⇒ 这两条边是**真能走的**，
    而「终态」的语义因此必须读作「不活跃」而不是「不可重开」（models.py 处原话）。
    业主若裁「终态不可重开」，改的是 DEFECT_TRANSITIONS 与这条测试，同一个提交。
    """
    reopenable = {s for s in DEFECT_END_STATUSES if DEFECT_TRANSITIONS[s]}
    assert reopenable == {"closed", "rejected"}, f"可重开的终态变了：{reopenable}（连带 Q4 要重谈）"


def test_link_vocab_excludes_functional_until_d185_lands() -> None:
    """关联词表**不含** `functional` —— 这是计划 §二 那条「有表没写入方」防线的本体。

    功能用例落地的同一刀里要连带加这里 + 前端词表（R112）。这条测试是那条决定的
    可执行版本：谁提前把 functional 加进来，它就红，逼那次改动去看一眼 §二。
    """
    assert "functional" not in DEFECT_CASE_TYPES, "功能用例还不存在（D185 只有计划文档）——见计划 §二"
    assert set(DEFECT_CASE_TYPES) <= {"api_case", "scenario", "ui_case", "adb_case"}
    assert "api_definition" not in DEFECT_CASE_TYPES, "定义不是「用例」那一层（plan_case_link 同口径）"


def test_priority_vocab_matches_the_repo_existing_three_copies() -> None:
    """本仓已有两份同款词表，这里是第三份。另立第四种取值才是真错。"""
    assert PRIORITIES == ("P0", "P1", "P2", "P3")
    assert "P2" in PRIORITIES, "默认值 P2 必须在词表内（四个模块的默认值都是它）"


# ══════════════ 模型 ↔ 迁移 ↔ 真库 ══════════════


def test_model_columns_match_the_migration_source() -> None:
    """模型声明的列名 == 0027 里 create_table 的列名，双向。

    **这一条是纯文本比对，不需要库**，所以它能进「定向单测」那一档、跑得跟内存一样快。
    与下一条（真库反射）合起来覆盖三段链路：模型 ↔ 迁移源码 ↔ 库。
    只有模型有 = insert 报 Unknown column；只有迁移有 = 模型读不到它，
    而「服务层 SQL 里手写字段名」能把它糊过去，所以两段都要比对。
    """
    import pathlib
    import re

    mig = pathlib.Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0027_defect.py"
    src = mig.read_text(encoding="utf-8")
    assert src, f"读不到迁移文件：{mig}"

    for table, model in (("defect", Defect), ("defect_case_link", DefectCaseLink)):
        # 抠 `op.create_table("table", ...)` 那一段里的 sa.Column("x"
        block = re.search(r'op\.create_table\(\s*"' + table + r'"(.*?)\n    \)', src, re.S)
        assert block, f"0027 里抠不出 op.create_table(\"{table}\") 那一段"
        in_migration = set(re.findall(r'sa\.Column\(\s*"([a-z_]+)"', block.group(1)))
        in_model = {c.key for c in model.__table__.columns}
        assert in_model - in_migration == set(), f"{table}: 模型有、迁移没有 → insert 报 Unknown column：{sorted(in_model - in_migration)}"
        assert in_migration - in_model == set(), f"{table}: 迁移有、模型没有 → 模型读不到这一列：{sorted(in_migration - in_model)}"
        assert "id" in in_model and "project_id" in in_model, f"{table} 少了主键或作用域列"


async def test_migration_0027_is_on_the_head_of_the_chain() -> None:
    """链头唯一 + 0027 的父是 0026（多头 = alembic 各升各的，表象是「库莫名其妙少一张表」）。"""
    import pathlib
    import re

    parents: dict[str, str | None] = {}
    revs: list[str] = []
    for p in sorted((pathlib.Path(__file__).resolve().parents[1] / "migrations" / "versions").glob("*.py")):
        body = p.read_text(encoding="utf-8")
        rev = re.search(r'^revision: str = "([^"]+)"', body, re.M)
        if not rev:
            continue
        down = re.search(r'^down_revision: str \| None = (None|"[^"]+")', body, re.M)
        revs.append(rev.group(1))
        raw = down.group(1) if down else "None"
        parents[rev.group(1)] = None if raw == "None" else raw.strip('"')

    assert parents["0027"] == "0026", f"0027 的父是 {parents['0027']}，应是 0026"
    chain = set(parents.values()) - {None}
    heads = set(revs) - chain
    assert heads == {"0027"}, f"链头应为唯一 0027，实际 {sorted(heads)}"


async def test_tables_actually_exist_in_the_migrated_db(conn) -> None:
    """模型声明了不等于库里有 —— alembic 漏跑时模型测试照样绿（test_ui_models 同款证据）。

    这里比 test_ui_models 多一件事：逐列比对**反射回来的列名**与模型列名。
    理由是上面 `test_model_columns_match_the_migration_source` 的注释：
    全仓没有 metadata ↔ 真库 的通用守卫，这一格只有本文件在钉。
    只比对**名字集合**，不比对类型/长度：反射拿到的类型对象与声明处不同型，
    硬比会得到假红（长度尤其如此，String(200) 反射回来是 varchar(200) 的元数据）。
    """

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "defect_cols": {c["name"] for c in insp.get_columns("defect")},
            "link_cols": {c["name"] for c in insp.get_columns("defect_case_link")},
            "link_uq": {c["name"] for c in insp.get_unique_constraints("defect_case_link")},
            "defect_idx": {i["name"] for i in insp.get_indexes("defect")},
        }

    got = await conn.run_sync(_read)
    for t in ("defect", "defect_case_link"):
        assert t in got["tables"], f"库里没有 {t}（alembic 没升到 0027？）"

    for key, model in (("defect_cols", Defect), ("link_cols", DefectCaseLink)):
        declared = {c.key for c in model.__table__.columns}
        assert got[key] == declared, (
            f"{model.__tablename__}: 模型 {sorted(declared - got[key])} 库里没有 / "
            f"库里 {sorted(got[key] - declared)} 模型没有"
        )
    assert "uq_defect_case_link_defect_case" in got["link_uq"]
    # 状态列与处理人都是列表谓词的落点，缺索引 = 每次筛选全表扫
    assert any("status" in n for n in got["defect_idx"]), f"defect 的 status 没有索引：{sorted(got['defect_idx'])}"
    await conn.execute(text("SELECT 1"))


async def test_defaults_are_the_honest_ones(session, two_projects) -> None:
    """缺省值逐个点名：`status` 必须是词表起始态、`recycled` 必须 False。

    `recycled` 的默认如果错，症状是**新建的缺陷直接躺在回收站里**（列表查不到它），
    而创建接口照样返回成功 —— 静默失效只能在这里钉。
    """
    pid, _ = two_projects
    d = Defect(project_id=pid, title="登录 500")
    session.add(d)
    await session.commit()

    got = await session.get(Defect, d.id)
    assert got is not None
    assert got.status == DEFECT_START_STATUS == "new"
    assert got.priority == "P2", "与 ui_case/adb_case/api_case/scenario 同默认"
    assert got.recycled is False
    assert got.handle_user_id is None, "「还没决定谁处理」是真实状态，不收伪造的默认处理人"
    assert got.description is None
    assert got.created_by is None
    assert got.status in DEFECT_STATUSES


async def test_same_title_is_allowed_in_one_project(session, two_projects) -> None:
    """**刻意**不加 uq(project_id, title)：标题不是标识符（models.Defect.title 处有理由）。

    与 ui_case/adb_case/api_module 相反，那几张表的名字是「按名字找人」的引用键。
    这条钉的是决定：哪天要给标题加唯一键，得先改掉它并说明「按标题找人」是谁在用。
    """
    pid, _ = two_projects
    session.add_all([Defect(project_id=pid, title="登录失败"), Defect(project_id=pid, title="登录失败")])
    await session.commit()  # 不抛 = 同项目同名可行


async def test_link_unique_key_blocks_the_exact_duplicate_only(session, two_projects) -> None:
    """UNIQUE(defect_id, case_id, case_type)：精确重复拦下，换类型放行。

    MS 无此约束 ⇒ 同一对可重复插（取证 §D），重复关联会让「关联用例数」这个徽标虚高。
    """
    pid, _ = two_projects
    d = Defect(project_id=pid, title="关联测试")
    session.add(d)
    await session.commit()
    # ⚠ **id 必须在预期失败之前抠进局部变量**：`session.rollback()` 会 expire 全部持久对象，
    #   之后再碰 `d.id` 就是「在协程里做同步 IO」⇒ MissingGreenlet，报的是 SQLAlchemy 的
    #   并发错误而不是「唯一键没拦住」——归因会指向完全错误的方向。
    #   仓里既有那几条唯一键用例（test_ui_models/test_adb_models）之所以撞不到，
    #   是因为它们回滚之后只用 fixture 返回的字符串，不碰 ORM 对象。
    did = d.id

    session.add(DefectCaseLink(project_id=pid, defect_id=did, case_id="c-1", case_type="api_case"))
    await session.commit()

    session.add(DefectCaseLink(project_id=pid, defect_id=did, case_id="c-1", case_type="api_case"))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()

    # 同一用例换个类型 = 不同对象（case_id 是 uuid，跨类型撞值本不可能，但身份是二元组）
    session.add(DefectCaseLink(project_id=pid, defect_id=did, case_id="c-1", case_type="ui_case"))
    await session.commit()

    # 不同缺陷关联同一用例必须放行
    d2 = Defect(project_id=pid, title="另一个缺陷")
    session.add(d2)
    await session.commit()
    session.add(DefectCaseLink(project_id=pid, defect_id=d2.id, case_id="c-1", case_type="api_case"))
    await session.commit()


async def test_link_has_no_soft_delete_column(session, two_projects) -> None:
    """关联行**不带**软删位（计划 §二）：取消关联是硬删，理由与 MS 的堆积教训同段。

    同时钉住「回收站只作用在缺陷本体上」：关联表没有 recycled。
    """
    cols = {c.key for c in DefectCaseLink.__table__.columns}
    assert not ({"recycled", "deleted", "is_deleted", "trashed"} & cols), f"关联表不该有软删位：{cols}"
    assert {"defect_id", "case_id", "case_type", "created_by", "project_id"} <= cols


def test_no_columns_without_a_writer() -> None:
    """不建的列点名钉住（判据 1）—— 每条理由在 models.Defect docstring，此处只钉决定。

    这条测试的价值在**将来**：半年后有人说「顺便加个 pos 吧，MS 有」，
    它会红，逼那次改动去读 §七 Q2 与 §一 的「不做」表。
    """
    cols = {c.key for c in Defect.__table__.columns}
    absent = {
        "pos",             # 拖拽位：本仓没有任何列表有拖拽位（Q2）
        "handle_users",    # MS 的死列（写两次、全仓无一处读，取证 §G1）
        "platform",        # 不做第三方同步
        "platform_bug_id",
        "template_id",     # 没有模板系统（MS 那边它是 NOT NULL 硬前置，取证 §B）
        "num",             # 短编号需要并发取号路径，本仓零先例
        "delete_user",     # 读取方是还不存在的列表页 → 留给步 4 与读取方同提交
        "delete_time",
        "version",         # R104：与 ApiCase/UiCase/Scenario 同口径不做乐观锁
        "tags",            # 本仓零先例（现查 models.py 无 tags 列）
        "status_flow_id",  # 状态在源码常量里，不在库里
    }
    assert not (cols & absent), f"这些列没有写入方，建了就是判据 1 的病：{sorted(cols & absent)}"
    # 反向：两个轴都得在场
    assert {"status", "recycled"} <= cols, "工作流轴与回收站轴分列是本表的核心决定"
