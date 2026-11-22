"""D183 步 1 判据刀：plan_record 本体 CRUD（计划 §六 应用到步 1）。

钉的契约（一条判断一条用例，命名即判据）：
1. **表形状 = 迁移形状**：列集恰好九列，没有 owner_id/project_public/软删列/状态枚举列
   （§六 1「没有任何一列是有 schema 没写入方」的反面清单）；project_id 有索引、
   项目内重名有唯一约束。走真 information_schema（模型声明了不等于库里有）。
2. **CRUD 往返 + 每列有写入方**：created_by/updated_by 由两个不同的人分别写出来并被读出
   （§六 1 的正面清单）；DELETE 物理删（raw SQL 数行）；步 2 起删除**级联删关联行**
   （test_delete_cascades_case_links 在本刀视角钉最小集成，完整判据在 test_d183_plan_links.py）。
3. **可见性 = project_id 显式过滤**（没有 visibility 助手！）：跨项目 404 且与
   「不存在」**同码同文案**（不泄露存在性）；同项目成员**都能**看见彼此的共享计划
   ——正向断言，守「我们没有行级私有」这个决定本身。
4. **归档三钉**：(a) `:manage` 门禁（MEMBER 拿 update 拿不到 manage，D159 同款），
   (b) 普通更新路径改不了 archived 且**不静默丢弃**（422 指向 /archive，
   不是靠 FastAPI 丢未知键的 200），(c) 没有反归档端点（405/404 + OpenAPI 路径表点名）。
5. **页码判据**（D47-b 全套）：形状键恰好 {items,next_cursor,total}；total 数 WHERE
   筛完全集（另一项目的计划不许进来、也不许被本页 len 顶掉）；total=0 键在场；
   越界页 = 空 items + 真 total；绝对期望序 + 种子区分度自证。
6. **写路径落审计**：成败都落（403 的归档尝试也在场），target=project_id。
7. **行级可见性永不接线**（静态 AST 扫描）：assert_row_visible 用
   `getattr(row, "project_public", True)`——喂给一张没这两列的表 = 每行公开且**不报错**
   （0018 静默失效）。这种「加了但说是查了」的代码正向用例照不出（行为不变！），
   所以正向断言（用例 3）之外必须再静态钉一道，另一半在 DDL 用例里（列不许加）。

**为什么部分行直插 ORM**（test_d47b_element_page 同款取舍）：id 由服务端 uuid4() 生成，
走 HTTP 就拿不到可控 id 序，而页码绝对期望序需要的正是「插入序 ≠ id 序」这个确定的事实；
项目/成员/读/归档仍全走 HTTP。每用例 conftest 已 TRUNCATE 全表，绝对计数才成立。
"""
from __future__ import annotations

import ast
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.modules.testplan.models import PlanRecord

_BASE = "/api/v1"
_NOW = datetime.now(UTC).replace(microsecond=0)
_MODULE_DIR = Path(__file__).resolve().parents[1] / "app" / "modules" / "testplan"


async def _proj(client, h, name: str) -> str:
    r = await client.post(_BASE + "/projects", json={"name": name}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _member(client, h, pid: str, uid: str, role: str) -> None:
    r = await client.put(_BASE + f"/projects/{pid}/members/{uid}",
                         json={"role_code": role}, headers=h)
    assert r.status_code == 200, r.text


async def _create(client, h, pid: str, name: str, **kw) -> dict:
    r = await client.post(_BASE + "/plans", json={"project_id": pid, "name": name, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def _list(client, h, pid: str, **params) -> dict:
    r = await client.get(_BASE + "/plans",
                         params=[("project_id", pid)] + [(k, str(v)) for k, v in params.items()],
                         headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _get(client, h, pid: str, plan_id: str):
    return await client.get(_BASE + f"/plans/{plan_id}", params={"project_id": pid}, headers=h)


async def _seed(session, pid: str, *, row_id: str, name: str, archived: bool = False,
                back: int = 0) -> None:
    """直插一行：id 与 created_at 由用例给定（理由见模块 docstring）。"""
    ts = _NOW - timedelta(days=back)
    session.add(PlanRecord(id=row_id, project_id=pid, name=name, archived=archived,
                           created_at=ts, updated_at=ts))
    await session.commit()


# ══════════ 1. 表形状（迁移真跑出来的形状 + 反面清单） ══════════

async def test_plan_record_shape_is_exactly_the_migration(conn) -> None:
    """列集恰好九列；索引/唯一键在场；三族「MS 式死列」都**不许**在。

    反面清单逐族点名（都对应计划里骂过的形状）：
    - owner_id/project_public：没有表单能把计划置成行级私有，列永远只有 true 一个值；
      而且它们一旦出现，`shared/visibility` 就从「不该接」变成「看着能接」——列不许加，
      助手不接线（另一半钉在用例 7 的源码扫描）。0018 的静默失效教训（schedule/models:10-13）。
    - deleted_at/软删列：删除是物理删（§四 末段）。
    - status/state/phase：状态只有 archived 一个持久值（§二 1），其余现算（步 3）。
    """
    from sqlalchemy import inspect

    def _read(sync_conn) -> dict:
        insp = inspect(sync_conn)
        return {
            "tables": set(insp.get_table_names()),
            "cols": {c["name"]: c for c in insp.get_columns("plan_record")},
            "idx": {i["name"] for i in insp.get_indexes("plan_record")},
            "uq": {(u["name"], tuple(sorted(u["column_names"])))
                   for u in insp.get_unique_constraints("plan_record")},
        }

    got = await conn.run_sync(_read)
    assert "plan_record" in got["tables"], "迁移没建表（alembic 没跑到 0024）"
    assert set(got["cols"]) == {"id", "project_id", "name", "description", "archived",
                                "created_by", "updated_by", "created_at", "updated_at"}, \
        "列集变了 = 有人加了没写方/没读方的列（§六 1）：" + str(sorted(got["cols"]))
    assert not ({"owner_id", "project_public"} & set(got["cols"])), "可见性两列被「顺手补上」了"
    assert not ({"deleted_at", "deleted", "recycled_at"} & set(got["cols"])), "物理删不许有软删列"
    assert not ({"status", "state", "phase"} & set(got["cols"])), "状态枚举列 = 说谎的列（§二 1）"
    assert "ix_plan_record_project_id" in got["idx"], "所有查询都按 project_id 走，缺索引就是全表扫"
    assert ("uq_plan_record_project_name", ("name", "project_id")) in got["uq"]
    assert got["cols"]["archived"]["nullable"] is False


# ══════════ 2. CRUD 往返 + 每列写入方点名 ══════════

async def test_crud_roundtrip_writes_every_column(client, session, make_user) -> None:
    """create 写 created_by/updated_by，update 换 updated_by 而 created_by 不动。

    两列各自有**不同的**写入者、读侧拿得到、且值互不相同——「谁写这列谁读它」的
    用例形态就是让两个人分别写一次，再证明读出来的值属于对的人（§六 1）。
    删除是 MEMBER 不能碰的（*:delete 拒绝），admin 删后原地消失。
    """
    boss, hb = await make_user("d183boss", admin=True)
    boss_id = boss.id  # 先取标量：端点 rollback 会过期同 session 的 ORM 实例（core/service:349 同课）
    pid = await _proj(client, hb, "D183本体")
    p = await _create(client, hb, pid, "回归计划", description="第一段描述")
    assert p["archived"] is False
    assert p["created_by"] == boss_id and p["updated_by"] == boss_id
    assert p["project_id"] == pid and p["name"] == "回归计划"
    assert p["description"] == "第一段描述"
    assert p["created_at"] and p["updated_at"]
    g = await _get(client, hb, pid, p["id"])
    # 除时刻外逐字段相等。时刻不比：create 回执带 Python 微秒（内存对象直接吐出），
    # DATETIME 列无小数秒、读回截到秒——全仓同款存储事实（ui/api 各表同型），不是本刀的形状。
    assert g.status_code == 200, g.text
    assert {k: v for k, v in g.json().items() if "at" not in k} == \
           {k: v for k, v in p.items() if "at" not in k}, "详情必须与创建回执逐字段相等（时刻除外）"

    mem, hm = await make_user("d183mem")
    mem_id = mem.id
    await _member(client, hb, pid, mem_id, "MEMBER")
    u = await client.patch(_BASE + f"/plans/{p['id']}",
                           json={"project_id": pid, "name": "回归计划改名"}, headers=hm)
    assert u.status_code == 200, u.text
    assert u.json()["name"] == "回归计划改名"
    assert u.json()["updated_by"] == mem_id, "updated_by 没跟着更新写 = 列会说谎"
    assert u.json()["created_by"] == boss_id, "update 不许碰 created_by"
    assert u.json()["archived"] is False

    den = await client.request("DELETE", _BASE + f"/plans/{p['id']}", json={"project_id": pid}, headers=hm)
    assert den.status_code == 403, "MEMBER 的 -*:delete 拒绝没生效"
    assert den.json()["details"]["perm"] == "testplan:plan:delete"
    dl = await client.request("DELETE", _BASE + f"/plans/{p['id']}", json={"project_id": pid}, headers=hb)
    assert dl.status_code == 200 and dl.json() == {"ok": True}
    gone = await _get(client, hb, pid, p["id"])
    assert gone.status_code == 404 and gone.json()["message"] == "计划不存在"
    lst = await _list(client, hb, pid, current=1, size=50)
    assert lst["total"] == 0 and lst["items"] == []


# ══════════ 3. 可见性：跨项目逐字同 404；同项目全员共享 ══════════

async def test_cross_project_is_verbatim_not_found(client, session, make_user) -> None:
    """乙项目的管理员拿着甲项目计划的真 id：读/改/删/归档全部 404，
    且 code+message 与「随机不存在 id」**逐字相同**（不泄露存在性）。

    注意受害者是另一个项目的**项目管理员**——本表没有行级私有，跨项目是唯一那道行外门，
    它对管理员也不放行（管理员管的是**自己项目**）。
    """
    boss, hb = await make_user("d183xa", admin=True)
    other, ho = await make_user("d183xb", admin=True)
    p1 = await _proj(client, hb, "D183甲项目")
    p2 = await _proj(client, ho, "D183乙项目")
    pl = await _create(client, hb, p1, "只属于甲")

    absent = await _get(client, ho, p2, "这条一定不存在")
    inv = await _get(client, ho, p2, pl["id"])
    assert absent.status_code == 404 and inv.status_code == 404
    assert inv.json()["code"] == absent.json()["code"] == "not_found"
    assert inv.json()["message"] == absent.json()["message"], "文案有别 = 泄露存在性"
    assert set(inv.json()["details"]) == set(absent.json()["details"])

    li = await _list(client, ho, p2, size=50)
    assert li["items"] == [] and li["total"] == 0, "列表漏了 project_id 谓词就是跨项目渗漏"

    up = await client.patch(_BASE + f"/plans/{pl['id']}",
                            json={"project_id": p2, "name": "抢注"}, headers=ho)
    assert up.status_code == 404 and up.json()["message"] == absent.json()["message"]
    de = await client.request("DELETE", _BASE + f"/plans/{pl['id']}", json={"project_id": p2}, headers=ho)
    assert de.status_code == 404 and de.json()["message"] == absent.json()["message"]
    ar = await client.post(_BASE + f"/plans/{pl['id']}/archive",
                           json={"project_id": p2}, headers=ho)
    assert ar.status_code == 404 and ar.json()["message"] == absent.json()["message"]

    # 计划原地未动（跨项目的写全被挡在 _plan 门前，没有任何一路摸到行）
    keep = await _get(client, hb, p1, pl["id"])
    assert keep.status_code == 200 and keep.json()["name"] == "只属于甲"

    # 非成员连项目门都进不来：403「无此项目权限」，与项目内 404 是两道不同的门
    out, how = await make_user("d183out")
    o = await client.get(_BASE + "/plans", params={"project_id": p1}, headers=how)
    assert o.status_code == 403 and o.json()["message"] == "无此项目权限"


async def test_same_project_members_all_see_shared_plans(client, session, make_user) -> None:
    """正向断言：同项目内 MEMBER 能看到/打开**别人**建的计划。

    这条守的是「计划没有行级私有」这个决定本身——将来有人给列表或详情加 visible_clause
    /assert_row_visible，本用例先红（配合用例 7 的源码扫描，两道闸夹死同一个决定）。
    """
    boss, hb = await make_user("d183sh", admin=True)
    boss_id = boss.id
    pid = await _proj(client, hb, "D183共享")
    p1 = await _create(client, hb, pid, "老板建的")
    p2 = await _create(client, hb, pid, "老板建的二")
    mem, hm = await make_user("d183sh2")
    mem_id = mem.id
    await _member(client, hb, pid, mem_id, "MEMBER")

    ids = [x["id"] for x in (await _list(client, hm, pid, size=50))["items"]]
    assert sorted(ids) == sorted([p1["id"], p2["id"]]), \
        "同项目成员看不见别人的计划 = 偷偷长出了行级私有"
    g = await _get(client, hm, pid, p1["id"])
    assert g.status_code == 200, "详情按主人收 = 行级私有混进来了"
    u = await client.patch(_BASE + f"/plans/{p1['id']}",
                           json={"project_id": pid, "description": "成员补的描述"}, headers=hm)
    assert u.status_code == 200 and u.json()["created_by"] == boss_id

    # READONLY（位集 ["*:read"]）：读得到共享计划（读位命中 :read 结尾的位），
    # 建不了（不持 create——这不是「MEMBER 拒绝」的重复，钉的是读位声明：
    # 读端点哪天把位写成不以 :read 结尾，只读角色的列表当场变 403）。
    ro, hr = await make_user("d183sh3")
    await _member(client, hb, pid, ro.id, "READONLY")
    rl = await _list(client, hr, pid, size=50)
    assert sorted(x["id"] for x in rl["items"]) == sorted([p1["id"], p2["id"]])
    rg = await _get(client, hr, pid, p2["id"])
    assert rg.status_code == 200
    rc = await client.post(_BASE + "/plans", json={"project_id": pid, "name": "只读想建"}, headers=hr)
    assert rc.status_code == 403 and rc.json()["details"]["perm"] == "testplan:plan:create"


# ══════════ 4. 归档三钉 ══════════

async def test_archive_gate_is_manage_not_update(client, session, make_user) -> None:
    """(a) 归档要 `:manage`：MEMBER 改名能过、归档 403，且 403 不落库；
    admin 归档 200 + updated_by 落到归档人；重复归档 409（终态大声说）。"""
    boss, hb = await make_user("d183ag", admin=True)
    boss_id = boss.id
    pid = await _proj(client, hb, "D183归档")
    p = await _create(client, hb, pid, "要归档的")
    mem, hm = await make_user("d183ag2")
    mem_id = mem.id
    await _member(client, hb, pid, mem_id, "MEMBER")

    ok_up = await client.patch(_BASE + f"/plans/{p['id']}",
                               json={"project_id": pid, "name": "member可改"}, headers=hm)
    assert ok_up.status_code == 200, "前置：MEMBER 必须仍持 update，否则本例测不到靶位"
    den = await client.post(_BASE + f"/plans/{p['id']}/archive",
                            json={"project_id": pid}, headers=hm)
    assert den.status_code == 403, "归档位不是 :manage（MEMBER 的 -*:manage 没拦住）：" + den.text
    assert den.json()["details"]["perm"] == "testplan:plan:manage"
    after = await _get(client, hb, pid, p["id"])
    assert after.json()["archived"] is False, "被 403 拒绝的归档偷偷写了库"

    ar = await client.post(_BASE + f"/plans/{p['id']}/archive", json={"project_id": pid}, headers=hb)
    assert ar.status_code == 200 and ar.json()["archived"] is True
    assert ar.json()["updated_by"] == boss_id, "归档没写 updated_by：列会说谎（ui_element_delete 同课）"

    again = await client.post(_BASE + f"/plans/{p['id']}/archive", json={"project_id": pid}, headers=hb)
    assert again.status_code == 409 and again.json()["code"] == "already_archived"
    # 归档封「继续用它」，不封改名与清理（§四：删除无回收站；步 2/3 才轮到执行编排跳过归档件）
    up = await client.patch(_BASE + f"/plans/{p['id']}",
                            json={"project_id": pid, "name": "归档后改名"}, headers=hb)
    assert up.status_code == 200


async def test_update_path_cannot_set_archived(app, client, session, make_user) -> None:
    """(b) 普通更新路径改不了 archived，而且**到不了的方式要说得出话**。

    三种错法各有靶：①把 archived 当成可编辑列 → DB 变 True；②模型干脆不声明该字段 →
    未知键在校验那一步被丢掉（pydantic `extra` 默认 ignore，全仓无一模型声明 forbid；
    带路径参数的路由还经 create_model 重建，core/service.py:374-387，但**不改变**这个后果）
    → 200 骗人（计划 §三 4 的「开关说允许实现偷偷去重」病型）；③声明了但 OpenAPI 里没有 →
    重建 schema 漂移，前端看不见这道拒绝。钉 422 + 指路文案 + 重建后 body schema 里有
    这个字段三件。「显式 null = 没打算改」必须放行（200），不然 PATCH 回显式对象就炸。
    """
    boss, hb = await make_user("d183ua", admin=True)
    pid = await _proj(client, hb, "D183更新门")
    p = await _create(client, hb, pid, "门")

    bad = await client.patch(_BASE + f"/plans/{p['id']}",
                             json={"project_id": pid, "archived": True}, headers=hb)
    assert bad.status_code == 422, "archived 被静默接受/丢弃（200）：" + bad.text
    assert bad.json()["code"] == "validation_failed"
    assert "archive" in str(bad.json()["details"]), "422 没说去哪归档"
    g = await _get(client, hb, pid, p["id"])
    assert g.json()["archived"] is False, "更新路径写进了 archived"

    nul = await client.patch(_BASE + f"/plans/{p['id']}",
                             json={"project_id": pid, "archived": None}, headers=hb)
    assert nul.status_code == 200 and nul.json()["archived"] is False

    # 哨兵字段在**重建后的 body schema** 里（不是只在源码里）：丢键版在这里就是没这个属性。
    # 形状：路径参数路由的 body 模型是 Optional[重建模型]（core/service.py:385），
    # OpenAPI 投影成 anyOf[$ref, null]——取 $ref 那个分支。
    spec = app.openapi()
    rb = spec["paths"]["/api/v1/plans/{plan_id}"]["patch"]["requestBody"] \
        ["content"]["application/json"]["schema"]
    ref = next(b["$ref"] for b in rb["anyOf"] if "$ref" in b)
    body_schema = spec["components"]["schemas"][ref.rsplit("/", 1)[-1]]
    assert "archived" in body_schema.get("properties", {}), \
        "archived 没进重建后的 body schema：422 会在传输层被丢，上面那条 422 假绿"
    from app.modules.testplan import schemas as ts
    with pytest.raises(ValidationError):
        ts.PlanUpdateIn(project_id=pid, plan_id=p["id"], archived=True)


async def test_no_unarchive_path_exists(app, client, session, make_user) -> None:
    """(c) 反归档不存在：unarchive/restore 各种拼法 404；/archive 只收 POST（反归档
    连方法面都没有——DELETE /archive 是 405，不是能撤）；OpenAPI 路径表点名。"""
    boss, hb = await make_user("d183na", admin=True)
    pid = await _proj(client, hb, "D183无反归档")
    p = await _create(client, hb, pid, "单向门")

    for method, url in (("GET", f"/plans/{p['id']}/unarchive"),
                        ("POST", f"/plans/{p['id']}/unarchive"),
                        ("POST", f"/plans/{p['id']}/restore"),
                        ("DELETE", f"/plans/{p['id']}/unarchive")):
        kw = {"params": {"project_id": pid}} if method == "GET" else {"json": {"project_id": pid}}
        r = await client.request(method, _BASE + url, headers=hb, **kw)
        assert r.status_code in (404, 405), url + " 竟然存在：" + str(r.status_code)
        assert r.json()["code"] in ("not_found", "method_not_allowed")

    # 归档端点在场、且只有 POST 一个方法：想撤销只能走一个不存在的端点
    r2 = await client.request("DELETE", _BASE + f"/plans/{p['id']}/archive", json={"project_id": pid}, headers=hb)
    assert r2.status_code == 405 and r2.json()["code"] == "method_not_allowed"

    paths = app.openapi()["paths"]
    plan_paths = [x for x in paths if x.startswith("/api/v1/plans")]
    assert "/api/v1/plans/{plan_id}/archive" in plan_paths
    assert not [x for x in plan_paths if "unarchive" in x or "restore" in x], \
        "OpenAPI 里冒出了反归档路径：§六 4 要业主裁才能加"


# ══════════ 5. 页码判据（D47-b 全套） ══════════

async def test_page_number_semantics(app, client, session, make_user) -> None:
    """形状键恰好三键 / 绝对期望序（先自证区分度）/ total 是 WHERE 后全集 /
    total=0 键在场 / 越界页 = 空 items + 真 total / size·current 越界 422 / 归档件不藏。

    种子：id 插入序 c,a,e,b,d ≠ id 升序（自证在跑）；**另一个项目塞 3 条计划**——
    total 若从 5 变 8，就是列表摘了 project_id 谓词的现行犯。
    """
    boss, hb = await make_user("d183pg", admin=True)
    pid = await _proj(client, hb, "D183页码")
    p_other = await _proj(client, hb, "D183隔壁项目")
    seed_ids = ["pl-c", "pl-a", "pl-e", "pl-b", "pl-d"]
    assert sorted(seed_ids) != seed_ids, "种子没有区分度（插入序==id 序），本例白测"
    for i, sid in enumerate(seed_ids):
        await _seed(session, pid, row_id=sid, name="页" + sid, back=i)
    for sid in ("px-1", "px-2", "px-3"):
        await _seed(session, p_other, row_id=sid, name="隔壁" + sid)

    page1 = await _list(client, hb, pid, current=1, size=2)
    assert set(page1) == {"items", "next_cursor", "total"}, \
        "页码响应键恰好这三个，多一个少一个都是改契约：" + str(sorted(page1))
    assert page1["next_cursor"] is None, "页码模式不产游标（两套真相并存）"
    assert [x["id"] for x in page1["items"]] == ["pl-a", "pl-b"], "第一页不是 id 升序前两条"
    assert page1["total"] == 5, "total 数了隔壁项目或只数本页：" + str(page1["total"])

    walk: list[str] = []
    for cur in (1, 2, 3):
        b = await _list(client, hb, pid, current=cur, size=2)
        assert b["total"] == 5, "每一页 total 恒等于全集条数"
        walk += [x["id"] for x in b["items"]]
    assert walk == sorted(seed_ids) and len(walk) == 5, "页码走出的序必须逐位=id 升序：" + str(walk)

    p3 = await _list(client, hb, pid, current=3, size=2)
    assert [x["id"] for x in p3["items"]] == ["pl-e"]
    past = await _list(client, hb, pid, current=9, size=2)
    assert past["items"] == [] and past["total"] == 5, "越界页 = 空 items + 真 total，不是 500 不是弹回首页"

    z = await _list(client, hb, p_other, current=1, size=10)
    assert "total" in z and z["total"] == 3 and len(z["items"]) == 3
    empty_pid = await _proj(client, hb, "D183空列表")
    e = await _list(client, hb, empty_pid, current=1, size=10)
    assert "total" in e and e["total"] == 0 and e["items"] == [], \
        "total=0 不许被 falsy 判断吞成没有这个键"

    ar = await client.post(_BASE + "/plans/pl-e/archive", json={"project_id": pid}, headers=hb)
    assert ar.status_code == 200
    li = await _list(client, hb, pid, size=50)
    assert li["total"] == 5 and "pl-e" in [x["id"] for x in li["items"]], \
        "归档件从列表消失 = 「归档去哪了」失踪案"

    s1 = await client.get(_BASE + "/plans", params={"project_id": pid, "size": 201}, headers=hb)
    assert s1.status_code == 422, "size 越界是 422，不是悄悄钳位"
    c0 = await client.get(_BASE + "/plans", params={"project_id": pid, "current": 0}, headers=hb)
    assert c0.status_code == 422


# ══════════ 6. 物理删 ══════════

async def test_delete_physically_removes_the_row(client, session, conn, make_user) -> None:
    """删完 raw SQL 数行 = 0（软删伪装物理删在这里现形）；同名可重建（无墓碑）。"""
    from sqlalchemy import text

    boss, hb = await make_user("d183del", admin=True)
    pid = await _proj(client, hb, "D183物理删")
    p = await _create(client, hb, pid, "删我")
    dl = await client.request("DELETE", _BASE + f"/plans/{p['id']}", json={"project_id": pid}, headers=hb)
    assert dl.status_code == 200
    g = await _get(client, hb, pid, p["id"])
    assert g.status_code == 404 and g.json()["message"] == "计划不存在"
    cnt = (await conn.execute(text("SELECT COUNT(*) FROM plan_record WHERE id=:i"),
                              {"i": p["id"]})).scalar_one()
    assert int(cnt) == 0, "行还在库里 = 软删伪装物理删"
    again = await _create(client, hb, pid, "删我")
    assert again["id"] != p["id"], "物理删不留墓碑，同名重建必须放行"


async def test_delete_cascades_case_links(client, session, conn, make_user) -> None:
    """§四 记的级联债在**记账处**验收：步 2 之后删计划必须带走该计划的关联行。

    完整判据（3+2+2 种子、逐计划点数、403 不落库）在 test_d183_plan_links.py 的
    test_plan_delete_cascades_links_by_plan_id_only；本例是步 1 视角的最小集成：
    本刀的文件里删一条**带关联**的计划，孤儿行必须为零、隔壁计划的关联不许被波及。
    关联行直插 ORM（HTTP 造关联归步 2 的文件，这里只消费行形状）。
    """
    from sqlalchemy import text

    from app.modules.testplan.models import PlanCaseLink

    boss, hb = await make_user("d183cas", admin=True)
    pid = await _proj(client, hb, "D183级联账")
    victim = await _create(client, hb, pid, "带关联的")
    neighbor = await _create(client, hb, pid, "隔壁的")
    for sid, pl, subj in (("cas-a", victim["id"], "cas-subj-1"), ("cas-b", victim["id"], "cas-subj-2"),
                          ("cas-c", neighbor["id"], "cas-subj-3")):
        # subject_id 互不相同：同计划同对象会被 uq_plan_case_link_plan_subject 拦（步 2 判断 2）
        session.add(PlanCaseLink(id=sid, project_id=pid, plan_id=pl, subject_type="scenario",
                                 subject_id=subj, subject_name="级联对象"))
    await session.commit()

    dl = await client.request("DELETE", _BASE + f"/plans/{victim['id']}", json={"project_id": pid}, headers=hb)
    assert dl.status_code == 200
    left = (await conn.execute(text("SELECT COUNT(*) FROM plan_case_link WHERE plan_id=:p"),
                               {"p": victim["id"]})).scalar_one()
    assert int(left) == 0, "计划删了、关联行成孤儿（§四 的债）"
    kept = (await conn.execute(text("SELECT COUNT(*) FROM plan_case_link WHERE plan_id=:p"),
                               {"p": neighbor["id"]})).scalar_one()
    assert int(kept) == 1, "级联按 plan_id 之外的东西删了（隔壁计划被波及）"


# ══════════ 7. 审计：写路径成败都落，target=project_id ══════════

async def test_mutating_services_write_audit_rows(client, session, make_user) -> None:
    """create/update/archive(先被拒后成功)/delete 四条写路径都在 audit_log 留痕。

    审计行由 core 路由投影统一写（成败都落），本用例点名的是**这一族的 service 名**
    真出现在业主的审计屏里、user_id 分得清谁干的——「审计接上了」这件事不替 core 复测
    机制，只钉本域四端点真的走的是那条统一通路（蓝图 :142）。
    """
    boss, hb = await make_user("d183ad", admin=True)
    boss_id = boss.id
    pid = await _proj(client, hb, "D183审计")
    mem, hm = await make_user("d183ad2")
    mem_id = mem.id
    await _member(client, hb, pid, mem_id, "MEMBER")

    p = await _create(client, hb, pid, "审计对象")
    await client.patch(_BASE + f"/plans/{p['id']}", json={"project_id": pid, "name": "审计改名"}, headers=hm)
    den = await client.post(_BASE + f"/plans/{p['id']}/archive", json={"project_id": pid}, headers=hm)
    assert den.status_code == 403
    ar = await client.post(_BASE + f"/plans/{p['id']}/archive", json={"project_id": pid}, headers=hb)
    assert ar.status_code == 200
    dl = await client.request("DELETE", _BASE + f"/plans/{p['id']}", json={"project_id": pid}, headers=hb)
    assert dl.status_code == 200

    r = await client.get(_BASE + "/audit", params={"project_id": pid, "size": 100}, headers=hb)
    assert r.status_code == 200, r.text
    rows = r.json()["items"]
    by: dict[str, list[dict]] = {}
    for row in rows:
        by.setdefault(row["action"], []).append(row)
    for act in ("plan_create", "plan_update", "plan_archive", "plan_delete"):
        assert by.get(act), "写路径没落审计（蓝图 :142）：" + str(sorted(by))
    assert by["plan_create"][0]["user_id"] == boss_id
    assert by["plan_update"][0]["user_id"] == mem_id, "审计里说不清是谁改的"
    assert any(x["ok"] is True for x in by["plan_archive"]) \
        and any(x["ok"] is False for x in by["plan_archive"]), \
        "被 403 拒掉的归档没留痕 = 拒绝不可见"
    assert all(x["target"] == pid for x in rows)


# ══════════ 8. 名称唯一（预检与约束同尺） ══════════

async def test_plan_name_unique_per_project(client, session, make_user) -> None:
    """同项目重名 409；跨项目同名放行；**改成自己现在的名字**不是重名（exclude 生效）。"""
    boss, hb = await make_user("d183nm", admin=True)
    p1 = await _proj(client, hb, "D183重名甲")
    p2 = await _proj(client, hb, "D183重名乙")
    a = await _create(client, hb, p1, "重名测试")
    dup = await client.post(_BASE + "/plans", json={"project_id": p1, "name": "重名测试"}, headers=hb)
    assert dup.status_code == 409 and dup.json()["code"] == "conflict"
    # 文案钉「计划名已存在」：摘掉预检后 IntegrityError 全局处理器同样回 409/conflict，
    # 但 message 是「数据唯一性冲突」——只比 code 照不出「预检被摘、全靠约束兜底」这刀
    # （兜底能拦但说不清是谁撞了谁，details 形状也不同）。
    assert dup.json()["message"] == "计划名已存在"
    b = await _create(client, hb, p2, "重名测试")
    assert b["id"] != a["id"], "跨项目同名是两份不同的东西，不许拦"
    same = await client.patch(_BASE + f"/plans/{a['id']}",
                              json={"project_id": p1, "name": "重名测试"}, headers=hb)
    assert same.status_code == 200, "把「原地改名」当重名拦 = 预检漏了排除自身"


# ══════════ 9. 行级可见性永不接线（静态） ══════════

def test_row_level_visibility_is_never_wired_in() -> None:
    """testplan 包的任何 import 不许指向 app.shared.visibility；模型不许长出那两列。

    为什么正向用例（test_same_project_members_all_see_shared_plans）不够：
    assert_row_visible 读 `getattr(row, "project_public", True)`——喂给它一张没这两列的
    表，**每行都公开、且不报错**（0018 静默失效；schedule/models.py:10-13 的注释就是为它
    写的）。行为不变的东西行为测试照不出，只能静态钉。visible_clause 更直接：
    它按属性建谓词，接上线当天列表就 AttributeError——但「没接线」这件事本身要有人钉，
    不然哪天「顺手统一一下」的人两边都看不见红。DDL 侧另一半在
    test_plan_record_shape_is_exactly_the_migration（列集恰好九列）。
    """
    assert not hasattr(PlanRecord, "project_public") and not hasattr(PlanRecord, "owner_id"), \
        "模型长出可见性两列 = 把「不该接的助手」变成「看着能接」，先摘列再谈"
    files = sorted(_MODULE_DIR.glob("*.py"))
    assert files, "扫描目录错了：" + str(_MODULE_DIR)
    for f in files:
        tree = ast.parse(f.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            mods: list[str] = []
            if isinstance(node, ast.ImportFrom) and node.module:
                mods.append(node.module)
            elif isinstance(node, ast.Import):
                mods += [a.name for a in node.names]
            for m in mods:
                assert "visibility" not in m, \
                    f.name + " import 了 " + m + "：plan_record 没有那两列，喂进去=每行公开且不报错"
