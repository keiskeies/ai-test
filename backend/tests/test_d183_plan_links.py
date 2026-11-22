"""D183 步 2 判据刀：plan_case_link 关联 CRUD + 计划删除级联（计划 §五 步 2 / §六）。

钉的契约（一条判断一条用例，命名即判据；步 2 三条业主裁的判断逐条有靶）：

1. **表形状 = 迁移形状**（test_plan_case_link_shape...）：列集恰好十字，反面清单点名
   「执行结论摘要」一族（last_result/latest_run/pass_count…——§三 2 的 MS 三件套不许在）；
   三个索引 + uq(plan_id, subject_type, subject_id) 在场；表名族不许冒出 MS 的 `test_plan*`
   （license 边界）。走真 information_schema（模型声明了不等于库里有）。
2. **四种 subject 各走一遍写入路径**（four_subjects...）：subject_name 从各域**抄**出来
   （四种各断言一次抄对名字）、env「能抄就抄」分域断言（scenario/ui_case 有值抄、
   api_case/adb_case 恒 None——两域没有 env 列，§四 末段）、created_by 是挂链人、
   **对象删了列表仍可读**（快照名的存在意义）。列表行键恰好十字——每列都被读方
   （plan_link_list 自己）带出来（判据 1 的读侧）。
3. **词表外 422**（word_list...）：inline / nonsense / api_definition 三个都拒、
   拒了库里零行、词表元组本身钉死。
4. **uq 正反两面**（duplicate...）：同计划重复挂 409（文案钉预检，IntegrityError 兜底
   说不清撞了谁——步 1 重名同款裁决）；**不同计划挂同一对象放行**、两条关联的 env 各是各的
   （判据 5 的存储侧：同一用例挂两个计划可以用不同环境跑）。跨计划借 link_id、跨项目挂
   subject、跨项目开计划——三种错位全部逐字同 404（不泄露存在性）。
5. **env 归属与改绑**（env...）：传 env 先验归属，跨项目 env 与不存在**同码同文案**
   （D181 形状）；update 只动 env：换绑 / clear_env 清空 / 两个都给 422 / 都不给 200 原样。
6. **级联真发生**（cascade...）：造 1 计划 + 3 关联 + 隔壁计划 2 关联 + 别项目计划 2 关联，
   删计划 → 本计划关联 raw SQL 数 0，**别的计划一根毫毛没动**（只按 plan_id 删）。
   被 MEMBER 403 拒绝的删除不许先删了关联（门拒绝不落库）。
7. **权限位的真守护**（gates...）：矩阵杀不掉「改声明位名」（第六十轮 §二——期望从声明位
   查表推），所以每个新位都有一条**真实角色跑真实拒绝**：link:read 用自定义角色（内置四角
   照不出 read 位被改——全员都命中 :read），link:create/update 用 READONLY，link:delete 用
   MEMBER 的 -*:delete；断 403 且 details.perm 等于那位名、拒绝不落库。另钉「关联没有
   :manage 位」的业主口径（REGISTRY 现读）。
8. **页码判据**（page...，D47-b 全套）：键恰好 {items,next_cursor,total}、绝对期望序 +
   种子区分度自证、total 是全集、越界页空 items + 真 total、size 越界 422、
   计划不存在 404（列表不泄「它有没有关联」）。

**为什么部分行直插 ORM**（步 1 / test_d47b 同款取舍）：页码绝对期望序需要「插入序 ≠ id 序」
的确定事实，HTTP 拿不到可控 id；被挂的四种 subject 与各环境也直插（它们不是本刀的写入方，
本刀的写入方是四个 link 服务，全部走真 HTTP）。每用例 conftest 已 TRUNCATE 全表。
"""
from __future__ import annotations

from app.modules.adb_test.models import AdbCase
from app.modules.api_test.models import ApiCase
from app.modules.env.models import Environment
from app.modules.scenario.models import Scenario
from app.modules.testplan.models import PlanCaseLink, PlanRecord
from app.modules.testplan.schemas import PLAN_LINK_SUBJECT_TYPES
from app.modules.ui_test.models import UiCase

_BASE = "/api/v1"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _create_plan(client, h, pid: str, name: str) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _link(client, h, pid: str, plan_id: str, subject_type: str, subject_id: str, **kw):
    return await client.post(_BASE + f"/plans/{plan_id}/case-links",
                             json={"project_id": pid, "subject_type": subject_type,
                                   "subject_id": subject_id, **kw}, headers=h)


async def _links(client, h, pid: str, plan_id: str, **params) -> dict:
    r = await client.get(_BASE + f"/plans/{plan_id}/case-links",
                         params=[("project_id", pid)] + [(k, str(v)) for k, v in params.items()],
                         headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _seed_plan(session, pid: str, *, row_id: str, name: str) -> None:
    session.add(PlanRecord(id=row_id, project_id=pid, name=name))
    await session.commit()


async def _seed_subject(session, subject_type: str, pid: str, *, row_id: str, name: str,
                        env_id: str | None = None) -> None:
    """直插一行被挂对象（四种 subject 的最小合法形状；它们不是本刀的写入方）。"""
    if subject_type == "api_case":
        s = ApiCase(id=row_id, project_id=pid, definition_id="seed-def", name=name)
    elif subject_type == "scenario":
        s = Scenario(id=row_id, project_id=pid, name=name,
                     step_graph={"version": 1, "nodes": []}, env_id=env_id)
    elif subject_type == "ui_case":
        s = UiCase(id=row_id, project_id=pid, name=name, steps=[], env_id=env_id)
    else:
        s = AdbCase(id=row_id, project_id=pid, name=name, steps=[])
    session.add(s)
    await session.commit()


async def _seed_env(session, pid: str, *, row_id: str, name: str) -> None:
    session.add(Environment(id=row_id, project_id=pid, name=name))
    await session.commit()


async def _count_links(conn, where: str, **params) -> int:
    from sqlalchemy import text

    r = await conn.execute(text("SELECT COUNT(*) FROM plan_case_link WHERE " + where), params)
    return int(r.scalar_one())


# ══════════ 1. 表形状（迁移真跑出来的形状 + 反面清单） ══════════

async def test_plan_case_link_shape_is_exactly_the_migration(conn) -> None:
    """列集恰好十列；uq 与索引在场；「执行结论摘要」一族与 MS 表名都不许在。

    反面清单逐族点名（都对应计划里骂过的形状）：
    - last_result/latest_run_at/report_id/pass_count/execute_status：§三 2——MS 的关联行
      三件套全仓无写入方，结论 join run_record 现算（步 3），存下来就是会腐烂的谎。
    - status/owner_id/project_public：物理删无状态位（步 1 同纪律）；关联行不是行级私有对象。
    - 表名 test_plan*：MS 的活表名是禁区（取证文档开头边界），冒出即 license 事故。
    """
    from sqlalchemy import inspect

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "cols": {c["name"]: c for c in insp.get_columns("plan_case_link")},
            "idx": {i["name"] for i in insp.get_indexes("plan_case_link")},
            "uq": {(u["name"], tuple(sorted(u["column_names"])))
                   for u in insp.get_unique_constraints("plan_case_link")},
        }

    got = await conn.run_sync(_read)
    assert "plan_case_link" in got["tables"], "迁移没建表（alembic 没跑到 0025）"
    assert set(got["cols"]) == {"id", "project_id", "plan_id", "subject_type", "subject_id",
                                "subject_name", "env_id", "created_by", "created_at", "updated_at"}, \
        "列集变了 = 有人加了没写方/没读方的列（§六 1）：" + str(sorted(got["cols"]))
    assert not ({"last_result", "latest_run_id", "last_run_at", "report_id", "pass_count",
                 "status", "owner_id", "project_public"} & set(got["cols"])), \
        "执行结论摘要/软删/行级私有列冒出来了（§三 2 / §四）"
    assert not [t for t in got["tables"] if t.startswith("test_plan")], \
        "MS 的活表名进来了（license 边界）"
    assert ("uq_plan_case_link_plan_subject", ("plan_id", "subject_id", "subject_type")) in got["uq"], \
        "同计划重复挂没有唯一键兜底（步 3 执行率分母会重复计数）"
    for i in ("ix_plan_case_link_project_id", "ix_plan_case_link_plan_id", "ix_plan_case_link_subject_id"):
        assert i in got["idx"], "缺索引 " + i + "：级联按 plan_id、subject 反查按 subject_id"
    assert got["cols"]["subject_name"]["nullable"] is False
    assert got["cols"]["env_id"]["nullable"] is True, "api/adb 抄不到环境，env_id 必须可空"


# ══════════ 2. 四种 subject + 每列写入方点名（判据 1 的正面清单） ══════════

async def test_four_subject_types_written_and_read(client, session, make_user) -> None:
    """四种可执行 subject 各挂一次：名字从各域抄对、env 分域「能抄就抄」、created_by 是挂链人；
    被挂对象删掉后列表仍可读（快照名）。

    判据 5 的**存储侧**在四种上分别断言：scenario/ui_case 用例 env 有值 → 关联行抄到；
    api_case/adb_case 没有 env 列（§四 末段：api 环境在执行时由请求体带、adb 的 §4.5
    刻意不列）→ 恒 None，不许为「统一」去碰那两个域的契约。
    执行侧「各用各的环境」归步 3（本刀还没有执行接线）。
    """
    boss, hb = await make_user("d183lk4", admin=True)
    boss_id = boss.id
    pid = await _proj(client, hb, "D183四subject")
    pl = await _create_plan(client, hb, pid, "四subject计划")
    await _seed_env(session, pid, row_id="env-copy", name="被抄的环境")

    expected_env = {"scenario": "env-copy", "ui_case": "env-copy", "api_case": None, "adb_case": None}
    link_ids: dict[str, str] = {}
    for st in ("api_case", "scenario", "ui_case", "adb_case"):
        await _seed_subject(session, st, pid, row_id="subj-" + st, name="名字" + st,
                            env_id="env-copy")
        r = await _link(client, hb, pid, pl["id"], st, "subj-" + st)
        assert r.status_code == 201, st + " 应被词表收下：" + r.text
        body = r.json()
        link_ids[st] = body["id"]
        assert body["subject_name"] == "名字" + st, st + " 的 subject_name 不是从域里抄的"
        assert body["env_id"] == expected_env[st], st + " 的环境抄错（抄口径分域，见 §四 末段）"
        assert body["created_by"] == boss_id
        assert body["subject_type"] == st and body["subject_id"] == "subj-" + st
        assert body["project_id"] == pid and body["plan_id"] == pl["id"]
        assert body["created_at"] and body["updated_at"]

    lst = await _links(client, hb, pid, pl["id"], size=50)
    assert lst["total"] == 4
    assert set(lst["items"][0]) == {"id", "project_id", "plan_id", "subject_type", "subject_id",
                                    "subject_name", "env_id", "created_by", "created_at", "updated_at"}, \
        "列表行键恰好十字——多出来的键没有读方，缺的键说明有列没被读（判据 1 读侧）"

    # 快照名的存在意义：对象被删（这里直接删行，模拟对象生命周期终点），关联行仍可读。
    gone = await session.get(Scenario, "subj-scenario")
    assert gone is not None
    await session.delete(gone)
    await session.commit()
    lst2 = await _links(client, hb, pid, pl["id"], size=50)
    assert lst2["total"] == 4, "删 subject 不许动关联行（摘挂走 link_delete，删对象是别的事）"
    names = {x["subject_id"]: x["subject_name"] for x in lst2["items"]}
    assert names["subj-scenario"] == "名字scenario", "快照名没存住：删了对象列表就说不出话"


# ══════════ 3. 词表：四值收、其余 422（判断 1） ══════════

async def test_word_list_rejects_everything_else(client, session, conn, make_user) -> None:
    """inline / nonsense / api_definition 三个都 422，且**库里零行**（不许默默收下）。

    inline 挂进计划会匹配到所有 inline run（它的 subject_id 是常量 "inline"，
    api_test/services.py:476）——那条关联永远说不清自己指的是谁；默默收下 = 造一条
    永远显示「未执行」的关联行（判据 1 一类病的对偶）。词表元组本身钉死：
    四种合法值的收口由用例 2 逐个证明，这里钉「不多不少」。
    """
    assert set(PLAN_LINK_SUBJECT_TYPES) == {"api_case", "scenario", "ui_case", "adb_case"}, \
        "词表长了少了都要过业主裁（run_record 的六个 subject_type 里只有这四个是『用例』）"
    boss, hb = await make_user("d183lk3", admin=True)
    pid = await _proj(client, hb, "D183词表")
    pl = await _create_plan(client, hb, pid, "词表计划")
    for bad in ("inline", "nonsense", "api_definition"):
        r = await _link(client, hb, pid, pl["id"], bad, "subj-api_case" if bad == "inline" else "whatever")
        assert r.status_code == 422, bad + " 竟然被收下：" + str(r.status_code)
        assert r.json()["code"] == "validation_failed"
        assert r.json()["details"]["subject_type"] == bad
    assert await _count_links(conn, "plan_id=:p", p=pl["id"]) == 0, "422 的关联落库了"


# ══════════ 4. uq 正反两面 + 三种错位逐字同 404（判断 2 + 不泄露存在性） ══════════

async def test_duplicate_409_same_plan_cross_plan_allowed(client, session, make_user) -> None:
    """同计划重复挂 409（预检文案在场）；**不同计划挂同一对象放行**、env 各是各的。

    放行那一半是 §二 3 能力的全部意义：同一条场景挂进两个计划、两个计划给两个环境，
    关联行各自持有自己的 env_id——执行率分母去重（uq）与「各用各的环境」是同一张表的
    正反两面，把跨计划重复也禁了就把能力禁掉了。
    三种错位（跨项目开计划 / 跨项目挂 subject / 跨计划借 link_id）必须与「不存在」
    **逐字同文案**（_plan/_subject/_link 的同一纪律）。
    """
    boss, hb = await make_user("d183lk2", admin=True)
    pid = await _proj(client, hb, "D183uq")
    p2 = await _proj(client, hb, "D183uq隔壁")
    pa = await _create_plan(client, hb, pid, "甲计划")
    pb = await _create_plan(client, hb, pid, "乙计划")
    p_other = await _create_plan(client, hb, p2, "别项目的计划")
    await _seed_subject(session, "scenario", pid, row_id="sc-shared", name="共用场景")
    await _seed_env(session, pid, row_id="env-a", name="环境A")
    await _seed_env(session, pid, row_id="env-b", name="环境B")

    la = await _link(client, hb, pid, pa["id"], "scenario", "sc-shared", env_id="env-a")
    assert la.status_code == 201, la.text
    dup = await _link(client, hb, pid, pa["id"], "scenario", "sc-shared")
    assert dup.status_code == 409 and dup.json()["code"] == "conflict"
    # 文案钉预检本身：摘掉预检后 uq 的 IntegrityError 兜底同样 409/conflict，
    # 但 message 是「数据唯一性冲突」——只比 code 照不出「预检被摘、全靠约束兜底」（步 1 同款）。
    assert dup.json()["message"] == "该对象已在此计划中"

    lb = await _link(client, hb, pid, pb["id"], "scenario", "sc-shared", env_id="env-b")
    assert lb.status_code == 201, "跨计划挂同一对象被拦 = 「同一用例两个计划两个环境」的能力没了"
    assert la.json()["env_id"] == "env-a" and lb.json()["env_id"] == "env-b", \
        "两条关联的 env 必须各是各的（判据 5 存储侧）"
    assert la.json()["id"] != lb.json()["id"]

    # 三种错位：逐字同 404，不泄露存在性
    absent_plan = await client.get(_BASE + "/plans/不存在的计划/case-links",
                                   params={"project_id": pid}, headers=hb)
    cross_plan = await client.get(_BASE + f"/plans/{p_other['id']}/case-links",
                                  params={"project_id": pid}, headers=hb)
    assert absent_plan.status_code == 404 and cross_plan.status_code == 404
    assert cross_plan.json()["message"] == absent_plan.json()["message"] == "计划不存在"
    assert set(cross_plan.json()["details"]) == set(absent_plan.json()["details"])

    await _seed_subject(session, "scenario", pid, row_id="sc-home", name="甲项目场景")
    absent_subj = await _link(client, hb, pid, pa["id"], "scenario", "一定不存在")
    cross_subj = await _link(client, hb, p2, p_other["id"], "scenario", "sc-home")
    assert absent_subj.status_code == 404 and cross_subj.status_code == 404
    assert cross_subj.json()["message"] == absent_subj.json()["message"] == "场景不存在", \
        "跨项目 subject 与不存在文案有别 = 泄露存在性"

    # 跨计划借 link_id：la 属于甲计划，拿乙计划的路径去改它 = 与不存在同文案
    borrow = await client.patch(_BASE + f"/plans/{pb['id']}/case-links/{la.json()['id']}",
                                json={"project_id": pid, "clear_env": True}, headers=hb)
    assert borrow.status_code == 404 and borrow.json()["message"] == "关联不存在"
    still = await _links(client, hb, pid, pa["id"], size=50)
    assert still["items"][0]["env_id"] == "env-a", "被 404 拒掉的借道 PATCH 动库了"


# ══════════ 5. env：传值验归属（D181 形状）+ update 三态 ══════════

async def test_env_override_validated_and_update_only_touches_env(client, session, make_user) -> None:
    """create 传 env 先验归属：跨项目 env 与不存在**同码同文案**；update 只动 env。

    update 的三态各有断言：换绑 / clear_env 清空 / env_id+clear_env 同时给 422 /
    都不给 200 原样回执。subject 改不动（投影丢键，代价与理由写在 schemas.PlanLinkUpdateIn
    的 docstring——这里钉「回执里 subject 原样」这一半可见行为）。
    """
    boss, hb = await make_user("d183lk5", admin=True)
    pid = await _proj(client, hb, "D183环境")
    p2 = await _proj(client, hb, "D183环境隔壁")
    pl = await _create_plan(client, hb, pid, "环境计划")
    await _seed_subject(session, "api_case", pid, row_id="ap-x", name="接口用例")
    await _seed_env(session, pid, row_id="env-mine", name="我的环境")
    await _seed_env(session, p2, row_id="env-theirs", name="别项目环境")

    bad = await _link(client, hb, pid, pl["id"], "api_case", "ap-x", env_id="env-theirs")
    absent = await _link(client, hb, pid, pl["id"], "api_case", "ap-x", env_id="env-不存在")
    assert bad.status_code == 404 and absent.status_code == 404
    assert bad.json()["message"] == absent.json()["message"] == "环境不存在", \
        "跨项目 env 与不存在文案有别（D181 修的就是这个）"
    # details 里的 env_id 是回显值、天然互异——不泄露存在性钉的是码+文案+键形（步 1 同款口径）
    assert set(bad.json()["details"]) == set(absent.json()["details"]) == {"env_id"}

    ok = await _link(client, hb, pid, pl["id"], "api_case", "ap-x", env_id="env-mine")
    assert ok.status_code == 201 and ok.json()["env_id"] == "env-mine", "传了合法 env 就该用它"
    lid = ok.json()["id"]

    up = await client.patch(_BASE + f"/plans/{pl['id']}/case-links/{lid}",
                            json={"project_id": pid, "env_id": "env-mine2"}, headers=hb)
    # 先试不存在的环境 → 404 且不落库，再真换绑
    assert up.status_code == 404 and up.json()["message"] == "环境不存在"
    g = await _links(client, hb, pid, pl["id"], size=50)
    assert g["items"][0]["env_id"] == "env-mine", "被拒的换绑动库了"

    await _seed_env(session, pid, row_id="env-mine2", name="换绑后的环境")
    up2 = await client.patch(_BASE + f"/plans/{pl['id']}/case-links/{lid}",
                             json={"project_id": pid, "env_id": "env-mine2",
                                   "subject_id": "劫持不了的键"}, headers=hb)
    assert up2.status_code == 200 and up2.json()["env_id"] == "env-mine2"
    assert up2.json()["subject_id"] == "ap-x" and up2.json()["subject_type"] == "api_case", \
        "update 动了 subject（只改 env 的契约作废）"

    both = await client.patch(_BASE + f"/plans/{pl['id']}/case-links/{lid}",
                              json={"project_id": pid, "env_id": "env-mine", "clear_env": True},
                              headers=hb)
    assert both.status_code == 422 and both.json()["code"] == "validation_failed"
    noop = await client.patch(_BASE + f"/plans/{pl['id']}/case-links/{lid}",
                              json={"project_id": pid}, headers=hb)
    assert noop.status_code == 200 and noop.json()["env_id"] == "env-mine2", "空补丁不许改库"

    cleared = await client.patch(_BASE + f"/plans/{pl['id']}/case-links/{lid}",
                                 json={"project_id": pid, "clear_env": True}, headers=hb)
    assert cleared.status_code == 200 and cleared.json()["env_id"] is None, "clear_env 没清空"


async def test_updated_at_tracks_real_writes_not_requests(client, session, make_user) -> None:
    """env 真改绑 → updated_at 刷新；**空 PATCH 不刷新**。

    为什么值得单独一条：schemas.PlanLinkOut 的 docstring 拿「onupdate 在 env 改绑时刷新」
    担保 `updated_at` **有写入方**，而 §六 1 的纪律是「挂名不写/不读的列不进」——那句担保
    目前没有用例撑着：上面几条只断言了字段**在场**（非空），把 TimestampMixin 那个
    `onupdate` 摘掉、或在更新路径上提前 return，它们照样绿。本例两头都钉：
    - 真改一律要动（不刷新 = 这列没人写，§六 1 该删列）；
    - 空 PATCH 一律不许动（每次都盖 = 这列说的是「来过请求」而不是「被改过」，
      列表拿它当「最后修改时间」就是在撒谎——判据 1 的另一头）。

    时刻不钉精确值：列是裸 DATETIME（秒级精度），同秒写完再读必然相等，直读会飘 ——
    口径同 test_scenario_crud.py:166。改成把 updated_at **倒拨一小时**再打一次请求：
    该刷新时必然从「1 小时前」跳走，不该刷新时必然还停在「1 小时前」，两种错都只能红。
    """
    from datetime import UTC, datetime, timedelta

    boss, hb = await make_user("d183lk9", admin=True)
    pid = await _proj(client, hb, "D183时间戳")
    pl = await _create_plan(client, hb, pid, "时间戳计划")
    await _seed_subject(session, "api_case", pid, row_id="ts-sub", name="时间用例")
    await _seed_env(session, pid, row_id="ts-env-a", name="环境甲")
    await _seed_env(session, pid, row_id="ts-env-b", name="环境乙")
    created = await _link(client, hb, pid, pl["id"], "api_case", "ts-sub", env_id="ts-env-a")
    assert created.status_code == 201
    lid = created.json()["id"]

    async def _backdate(minutes: int) -> str:
        """倒拨落库的 updated_at，返回**接口读回**的值作为对照基准。

        必须 `refresh` 之后再读。列是 DATETIME(**0** 秒精度)——information_schema 实测
        `('datetime', 0)`——MySQL 写入会把微秒**四舍五入**（`…:40.628649` 落成 `:41`），
        而 commit 后 ORM 身份映射里躺着的仍是我手里那个带微秒的 Python 对象：不刷新就读，
        接口那侧从库里拿到的是 `:41`、基准却是 `…40.628649`，两侧根本不可比，舍入方向一变
        就假红（本轮第一次跑正是这样红的，红的还是「不该动的那条腿」——行为没错、测量错了）。
        """
        row = await session.get(PlanCaseLink, lid)
        assert row is not None
        row.updated_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=minutes)
        await session.commit()
        await session.refresh(row)   # 关键：把身份映射刷成落库值，否则基准是内存里的微秒值
        assert row.updated_at == row.updated_at.replace(microsecond=0), \
            "refresh 后仍带微秒 = 读的不是库里的值，本用例的对照基准不可信"
        body = await _links(client, hb, pid, pl["id"], size=50)
        assert body["total"] == 1 and body["items"][0]["id"] == lid
        return body["items"][0]["updated_at"]

    # ── ① 真改绑：倒拨 → PATCH → 必须跳离倒拨后的那个时刻
    was = await _backdate(60)
    moved = await client.patch(_BASE + f"/plans/{pl['id']}/case-links/{lid}",
                               json={"project_id": pid, "env_id": "ts-env-b"}, headers=hb)
    assert moved.status_code == 200 and moved.json()["env_id"] == "ts-env-b"
    now = moved.json()["updated_at"]
    assert now != was and datetime.fromisoformat(now) > datetime.fromisoformat(was), \
        "env 改绑没刷新 updated_at——PlanLinkOut 说的「有写入方」不成立，该按 §六 1 删列：" + str(now)

    # ── ② 空 PATCH：再倒拨 → 什么都不改地 PATCH → 必须原地不动
    was2 = await _backdate(60)
    noop = await client.patch(_BASE + f"/plans/{pl['id']}/case-links/{lid}",
                              json={"project_id": pid}, headers=hb)
    assert noop.status_code == 200 and noop.json()["env_id"] == "ts-env-b", "空补丁动库了"
    assert noop.json()["updated_at"] == was2, \
        "空 PATCH 也盖时间戳：这列说的是「来过请求」不是「被改过」，列表再拿它当「最后修改" \
        "时间」就是说谎（判据 1 另一头）：" + str(noop.json()["updated_at"])


# ══════════ 6. 级联真发生（判断 3，还 §四 的债） ══════════

async def test_plan_delete_cascades_links_by_plan_id_only(client, session, conn, make_user) -> None:
    """删计划 → 该计划关联清零；**同项目别的计划与别项目的计划一根毫毛没动**。

    断言形状（级联用例到底证明了什么）：
    - 前置计数钉死 3+2+2（种子自证），删后按 plan_id 分组 raw SQL 点数——
      本计划 3→0，隔壁计划 2→2（逐个 id 还在），别项目 2→2。
      「别的计划的关联没动」只按 plan_id 谓词成立才给过——级联写成全表删会红在这里。
    - MEMBER 的删除 403 之后关联行全在场（门拒绝不落库，级联不许抢跑在权限门前面）。
    """
    from sqlalchemy import text

    boss, hb = await make_user("d183lk6", admin=True)
    pid = await _proj(client, hb, "D183级联")
    p2 = await _proj(client, hb, "D183级联隔壁")
    victim = await _create_plan(client, hb, pid, "被删的")
    neighbor = await _create_plan(client, hb, pid, "同项目幸存")
    foreign = await _create_plan(client, hb, p2, "别项目幸存")
    for st in ("api_case", "scenario", "ui_case"):
        await _seed_subject(session, st, pid, row_id="casc-" + st, name="级联" + st)
    for st in ("api_case", "scenario"):
        r = await _link(client, hb, pid, victim["id"], st, "casc-" + st)
        assert r.status_code == 201, r.text
    # 第三条用 adb：第三种 subject 的关联同样要被级联带走
    await _seed_subject(session, "adb_case", pid, row_id="casc-adb", name="级联adb")
    r = await _link(client, hb, pid, victim["id"], "adb_case", "casc-adb")
    assert r.status_code == 201, r.text
    for st in ("api_case", "scenario"):
        assert (await _link(client, hb, pid, neighbor["id"], st, "casc-" + st)).status_code == 201
    for st in ("api_case", "scenario"):
        await _seed_subject(session, st, p2, row_id="fgn-" + st, name="外来" + st)
        assert (await _link(client, hb, p2, foreign["id"], st, "fgn-" + st)).status_code == 201
    assert await _count_links(conn, "plan_id=:p", p=victim["id"]) == 3
    assert await _count_links(conn, "plan_id=:p", p=neighbor["id"]) == 2
    assert await _count_links(conn, "plan_id=:p", p=foreign["id"]) == 2, "种子没铺够，本例白测"

    mem, hm = await make_user("d183lk6m")
    await _member(client, hb, pid, mem.id, "MEMBER")
    den = await client.request("DELETE", _BASE + f"/plans/{victim['id']}",
                               json={"project_id": pid}, headers=hm)
    assert den.status_code == 403, "前置：MEMBER 必须被挡，否则级联抢跑测不到"
    assert await _count_links(conn, "plan_id=:p", p=victim["id"]) == 3, "403 的删除把关联先删了"

    dl = await client.request("DELETE", _BASE + f"/plans/{victim['id']}",
                              json={"project_id": pid}, headers=hb)
    assert dl.status_code == 200 and dl.json() == {"ok": True}
    assert await _count_links(conn, "plan_id=:p", p=victim["id"]) == 0, \
        "计划没了、关联行还在——§四 记的孤儿行债没还"
    keep = (await conn.execute(text(
        "SELECT plan_id, COUNT(*) FROM plan_case_link GROUP BY plan_id"))).all()
    by = {r[0]: int(r[1]) for r in keep}
    assert by.get(neighbor["id"]) == 2 and by.get(foreign["id"]) == 2, \
        "级联删多了行（只许按 plan_id 删）：" + str(by)
    assert victim["id"] not in by
    assert (await conn.execute(text("SELECT COUNT(*) FROM plan_record WHERE id=:i"),
                               {"i": victim["id"]})).scalar_one() == 0


# ══════════ 7. 权限位的真守护（第六十轮 §二：矩阵证不了位名，这里才是守护） ══════════

async def test_link_perm_gates_deny_real_roles(client, session, make_user) -> None:
    """四个新位各有「真实角色 × 真实拒绝 × details.perm == 位名」：
    link:read 用自定义角色（内置四角全员命中 :read，改位名矩阵照绿——只有自定义角色
    的拒绝能指名这一位）；create/update 用 READONLY；delete 用 MEMBER 的 -*:delete。
    放行面同时钉：READONLY 读得到、MEMBER 建得成也改得动。拒绝一律不落库。
    """
    boss, hb = await make_user("d183lk7", admin=True)
    pid = await _proj(client, hb, "D183门禁")
    pl = await _create_plan(client, hb, pid, "门禁计划")
    await _seed_subject(session, "scenario", pid, row_id="gate-sc", name="门禁场景")
    await _seed_env(session, pid, row_id="gate-env", name="门禁环境")

    ro, hr = await make_user("d183lk7ro")
    await _member(client, hb, pid, ro.id, "READONLY")
    rl = await _links(client, hr, pid, pl["id"], size=50)
    assert rl["total"] == 0, "前置：READONLY 必须读得到列表（:read 位命中）"
    rc = await _link(client, hr, pid, pl["id"], "scenario", "gate-sc")
    assert rc.status_code == 403 and rc.json()["details"]["perm"] == "testplan:link:create"

    created = await _link(client, hb, pid, pl["id"], "scenario", "gate-sc", env_id="gate-env")
    assert created.status_code == 201
    lid = created.json()["id"]
    ru = await client.patch(_BASE + f"/plans/{pl['id']}/case-links/{lid}",
                            json={"project_id": pid, "clear_env": True}, headers=hr)
    assert ru.status_code == 403 and ru.json()["details"]["perm"] == "testplan:link:update"
    g = await _links(client, hb, pid, pl["id"], size=50)
    assert g["items"][0]["env_id"] == "gate-env", "被 403 拒掉的 update 动库了"

    mem, hm = await make_user("d183lk7me")
    await _member(client, hb, pid, mem.id, "MEMBER")
    mc = await _link(client, hm, pid, pl["id"], "scenario", "gate-sc")
    assert mc.status_code == 409, "前置：MEMBER 必须能走到 uq 预检（持 create，撞的是键不是门）"
    mu = await client.patch(_BASE + f"/plans/{pl['id']}/case-links/{lid}",
                            json={"project_id": pid, "env_id": "gate-env"}, headers=hm)
    assert mu.status_code == 200, "MEMBER 该拿得到 link:update（-*:manage 不该波及 :update）"
    md = await client.request("DELETE", _BASE + f"/plans/{pl['id']}/case-links/{lid}",
                              json={"project_id": pid}, headers=hm)
    assert md.status_code == 403, "MEMBER 的 -*:delete 没拦住 link:delete：" + md.text
    assert md.json()["details"]["perm"] == "testplan:link:delete"
    assert (await _links(client, hb, pid, pl["id"], size=50))["total"] == 1, "被拒的删除落库了"

    # link:read 的真守护：内置四角对任何 *:read 位都放行，改位名矩阵照绿（第六十轮 §二），
    # 只有限定了别的位的自定义角色能让这一位开口。
    rr = await client.post(_BASE + "/custom-roles",
                           json={"project_id": pid, "name": "只读环境", "template_code": "READONLY"},
                           headers=hb)
    assert rr.status_code in (200, 201), rr.text
    code = rr.json()["code"]
    pr = await client.patch(_BASE + "/custom-roles/" + code,
                            json={"project_id": pid, "perms": ["env:config:read"]}, headers=hb)
    assert pr.status_code == 200, pr.text
    cu, hc = await make_user("d183lk7cu")
    await _member(client, hb, pid, cu.id, code)
    dl = await client.get(_BASE + f"/plans/{pl['id']}/case-links", params={"project_id": pid}, headers=hc)
    assert dl.status_code == 403 and dl.json()["code"] == "insufficient_permission"
    assert dl.json()["details"]["perm"] == "testplan:link:read", \
        "read 位被改名时这一条必须红（矩阵四格照绿，它才是守护）"

    # 写路径落审计（步 1 同款：只钉本域服务名真进统一通路）
    a = await client.get(_BASE + "/audit", params={"project_id": pid, "size": 100}, headers=hb)
    acts = {x["action"] for x in a.json()["items"]}
    assert {"plan_link_create", "plan_link_update", "plan_link_delete"} <= acts, str(sorted(acts))
    assert any(x["action"] == "plan_link_delete" and x["ok"] is False for x in a.json()["items"]), \
        "被拒的删除没留痕 = 拒绝不可见"


def test_link_services_declare_no_manage_bit() -> None:
    """业主口径「别给关联发明 :manage」的静态钉 + REGISTRY 在场钉。

    诚实条款（第六十轮 §二）：本例读的是 REGISTRY 声明本身——它是**镜像**不是守护，
    「装饰器 + ctx.require 成对改位名」在这里照样绿，真守护是上面那条真实拒绝。
    本例杀的变异是「单点漂移」：只改装饰器位、或位退成 :manage（MEMBER 就摸到删门）。
    """
    from app.core.registry import REGISTRY

    for name, verb in (("plan_link_list", "read"), ("plan_link_create", "create"),
                       ("plan_link_update", "update"), ("plan_link_delete", "delete")):
        spec = REGISTRY.get(name)
        assert spec is not None, "注册表没有 " + name
        assert spec.perm == "testplan:link:" + verb, name + " 的位不是 testplan:link:" + verb
    assert all(REGISTRY.get(n).perm.find("manage") < 0
               for n in ("plan_link_list", "plan_link_create", "plan_link_update", "plan_link_delete")), \
        "关联段不许长出 :manage（业主口径：delete 走 :delete、update 走 :update）"


# ══════════ 8. 页码判据（D47-b 全套，plan_list 同尺） ══════════

async def test_link_list_page_number_semantics(client, session, make_user) -> None:
    """形状键恰好三键 / 绝对期望序（先自证区分度）/ total 恒全集 / 越界页空 items /
    size·current 越界 422 / 计划不存在 404（列表不泄它有无关联）。

    种子：id 插入序 c,a,e,b,d ≠ id 升序（直插 ORM 的理由见模块 docstring）；
    **隔壁计划另挂 3 条**——total 从 5 变 8 就是列表摘了 plan_id 谓词的现行犯。
    """
    boss, hb = await make_user("d183lk8", admin=True)
    pid = await _proj(client, hb, "D183关联页码")
    pl = await _create_plan(client, hb, pid, "页码计划")
    pl_other = await _create_plan(client, hb, pid, "页码隔壁")
    await _seed_subject(session, "api_case", pid, row_id="pg-subj", name="页码用例")
    seed_ids = ["lk-c", "lk-a", "lk-e", "lk-b", "lk-d"]
    assert sorted(seed_ids) != seed_ids, "种子没有区分度（插入序==id 序），本例白测"
    for sid in seed_ids:
        session.add(PlanCaseLink(id=sid, project_id=pid, plan_id=pl["id"], subject_type="api_case",
                                 subject_id="pg-subj-" + sid, subject_name="页" + sid))
    for sid in ("lk-x", "lk-y", "lk-z"):
        session.add(PlanCaseLink(id=sid, project_id=pid, plan_id=pl_other["id"], subject_type="api_case",
                                 subject_id="pg-subj-" + sid, subject_name="隔壁" + sid))
    await session.commit()

    p1 = await _links(client, hb, pid, pl["id"], current=1, size=2)
    assert set(p1) == {"items", "next_cursor", "total"}, "页码响应键恰好这三个：" + str(sorted(p1))
    assert p1["next_cursor"] is None
    assert [x["id"] for x in p1["items"]] == ["lk-a", "lk-b"], "第一页不是 id 升序前两条"
    assert p1["total"] == 5, "total 数了隔壁计划或只数本页：" + str(p1["total"])

    walk: list[str] = []
    for cur in (1, 2, 3):
        b = await _links(client, hb, pid, pl["id"], current=cur, size=2)
        assert b["total"] == 5, "每一页 total 恒等于全集条数"
        walk += [x["id"] for x in b["items"]]
    assert walk == sorted(seed_ids) and len(walk) == 5, "页码走出的序必须逐位=id 升序：" + str(walk)

    past = await _links(client, hb, pid, pl["id"], current=9, size=2)
    assert past["items"] == [] and past["total"] == 5, "越界页 = 空 items + 真 total"

    e = await _links(client, hb, pid, pl_other["id"], current=1, size=10)
    assert e["total"] == 3
    empty = await _proj(client, hb, "D183空计划")
    pe = await _create_plan(client, hb, empty, "空空如也")
    z = await _links(client, hb, empty, pe["id"], size=10)
    assert z["total"] == 0 and z["items"] == [], "total=0 不许被 falsy 判断吞键"

    s1 = await client.get(_BASE + f"/plans/{pl['id']}/case-links",
                          params={"project_id": pid, "size": 201}, headers=hb)
    assert s1.status_code == 422, "size 越界是 422，不是钳位"
    c0 = await client.get(_BASE + f"/plans/{pl['id']}/case-links",
                          params={"project_id": pid, "current": 0}, headers=hb)
    assert c0.status_code == 422

    nf = await client.get(_BASE + "/plans/查无此计划/case-links", params={"project_id": pid}, headers=hb)
    assert nf.status_code == 404 and nf.json()["message"] == "计划不存在", \
        "列表先过 _plan 门：不存在与「没关联」不是同一句话（空列表是 200+total=0，见上）"


# ══════════ 9. 回收站的 subject 挂不进来（写入口三种拒绝的第三种） ══════════

async def test_recycled_subject_cannot_be_linked(client, session, conn, make_user) -> None:
    """status != normal 的 subject → 404「（在回收站）」，库里零行。

    回收站的行不是可执行对象：挂进来就是一条 run_record 永远配不上的关联——
    各域 debug/run 路径对回收站行说「不存在（在回收站，请先恢复）」的同手感（不另造码）。
    词表内、id 存在、就是状态不对——前两关都拦不住的第三种拒绝。
    """
    boss, hb = await make_user("d183lk9", admin=True)
    pid = await _proj(client, hb, "D183回收站")
    pl = await _create_plan(client, hb, pid, "回收站计划")
    await _seed_subject(session, "scenario", pid, row_id="sc-bin", name="回收站场景")
    row = await session.get(Scenario, "sc-bin")
    assert row is not None
    row.status = "recycled"
    await session.commit()
    r = await _link(client, hb, pid, pl["id"], "scenario", "sc-bin")
    assert r.status_code == 404 and r.json()["message"] == "场景不存在（在回收站）"
    assert await _count_links(conn, "plan_id=:p", p=pl["id"]) == 0
