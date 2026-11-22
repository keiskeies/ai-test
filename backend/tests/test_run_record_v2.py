"""1B T1：run_record 成为报告主体（§4.6）+ trigger 词表归一（计划 R46）。

trigger 词表此前有三套口径（模型注释 / RunListIn.pattern / 设计文档 §4.6），
其中 RunListIn 允许库里从不出现的 "case"、却拒绝模型自己声明的 "manual" 与
"webhook"——1B 一写 manual 就会被自己的列表接口 422，故本任务先把它钉死。
"""
from __future__ import annotations

import os
from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit

from app.modules.execution.core import RunResult
from app.modules.execution.models import RunRecord
from app.modules.execution.services import save_run

TRIGGERS_OK = ["debug", "manual", "schedule", "agent", "webhook"]


def _res(**kw) -> RunResult:
    base = dict(
        ok=True, status=200, headers={"content-type": "application/json"},
        body_text='{"code":"0"}', truncated=False, body_size=13, elapsed_ms=42,
        error=None, assertions=[{"name": "code", "passed": True}],
    )
    base.update(kw)
    return RunResult(**base)


def _cols(cur, schema: str, tbl: str) -> set[str]:
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema=%s AND table_name=%s", (schema, tbl))
    return {r[0] for r in cur.fetchall()}


# ---------- 终态字段：报告主体的地基 ----------

async def test_save_run_writes_terminal_report_columns(client, session, make_user) -> None:
    """save_run 能落 started_at/finished_at/stats/summary_graph 且详情读得回来（§4.6 缺的四列）。"""
    u, h = await make_user("rv2boss")
    pid = (await client.post("/api/v1/projects", json={"name": "rv2"}, headers=h)).json()["id"]
    t0 = datetime.now(UTC).replace(microsecond=0)
    rec = await save_run(
        session, project_id=pid, subject_type="api_case", subject_id="case-1",
        subject_name="下单成功", env_id=None, env_name=None, trigger="manual",
        result=_res(), request_snapshot={"method": "POST", "url": "/order"},
        created_by=u.id,
        started_at=t0, finished_at=t0,
        stats={"total": 5, "pass": 4, "fail": 1, "skip": 0, "rows_total": 3},
        summary_graph={"version": 1, "nodes": [{"key": "n1", "kind": "api_case"}], "results": {"n1": "pass"}},
    )
    await session.commit()

    r = await client.get("/api/v1/runs/" + rec.id, params={"project_id": pid}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["stats"] == {"total": 5, "pass": 4, "fail": 1, "skip": 0, "rows_total": 3}
    assert body["trigger"] == "manual"
    got = datetime.fromisoformat(body["started_at"]).replace(tzinfo=None, microsecond=0)
    assert got == t0.replace(tzinfo=None, microsecond=0)
    assert body["finished_at"]


async def test_save_run_without_terminal_fields_stays_compatible(client, session, make_user) -> None:
    """1A 的老调用（不传终态字段）必须照旧可用：终态字段一律可选。"""
    u, h = await make_user("rv2old")
    pid = (await client.post("/api/v1/projects", json={"name": "rv2old"}, headers=h)).json()["id"]
    rec = await save_run(
        session, project_id=pid, subject_type="api_definition", subject_id="d1",
        subject_name="查询订单", env_id=None, env_name=None, trigger="debug",
        result=_res(), request_snapshot={}, created_by=u.id)
    await session.commit()
    got = (await session.get(RunRecord, rec.id))
    assert got is not None and got.started_at is None and got.stats is None
    body = (await client.get("/api/v1/runs/" + rec.id, params={"project_id": pid}, headers=h)).json()
    assert body["stats"] is None and body["started_at"] is None


# ---------- trigger 词表：列表过滤与库内口径必须一致 ----------

async def test_list_filter_accepts_documented_triggers(client, session, make_user) -> None:
    """模型注释声明的五个 trigger 都能作为列表过滤条件（旧码 manual/webhook 会 422）。"""
    u, h = await make_user("rv2trig")
    pid = (await client.post("/api/v1/projects", json={"name": "rv2trig"}, headers=h)).json()["id"]
    for t in TRIGGERS_OK:
        session.add(RunRecord(project_id=pid, subject_type="api_case", subject_id="s-" + t,
                              subject_name="t-" + t, trigger=t, status="passed", created_by=u.id))
    await session.commit()

    for t in TRIGGERS_OK:
        r = await client.get("/api/v1/runs", params={"project_id": pid, "trigger": t}, headers=h)
        assert r.status_code == 200, f"trigger={t} 应可过滤，实际 {r.status_code} {r.text}"
        items = r.json()["items"]
        assert [x["trigger"] for x in items] == [t], f"trigger={t} 过滤串了：{items}"


async def test_list_filter_rejects_removed_trigger_case(client, make_user) -> None:
    """"case" 已从词表移除（库里从不写它，留着只会让人以为能筛）。"""
    _, h = await make_user("rv2case")
    pid = (await client.post("/api/v1/projects", json={"name": "rv2case"}, headers=h)).json()["id"]
    r = await client.get("/api/v1/runs", params={"project_id": pid, "trigger": "case"}, headers=h)
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "validation_failed"


async def test_write_service_accepts_manual_trigger_end_to_end(client, session, make_user) -> None:
    """写 manual 触发 → 列表按 manual 能查到（写入与过滤同一词表，不允许两侧各说各话）。"""
    u, h = await make_user("rv2e2e")
    pid = (await client.post("/api/v1/projects", json={"name": "rv2e2e"}, headers=h)).json()["id"]
    rec = await save_run(session, project_id=pid, subject_type="api_case", subject_id="c9",
                         subject_name="手动跑一次", env_id=None, env_name=None, trigger="manual",
                         result=_res(), request_snapshot={}, created_by=u.id)
    await session.commit()
    items = (await client.get("/api/v1/runs", params={"project_id": pid, "trigger": "manual"},
                              headers=h)).json()["items"]
    assert [x["id"] for x in items] == [rec.id]


# ---------- 1C T11：subject_type 筛选（R112——UI 运行不能出现在列表里却筛不出） ----------


async def test_run_list_filters_by_subject_type(client, session, make_user) -> None:
    """subject_type=ui_case 只回 UI 运行；四个词表值都能筛（缺这个 where 时
    过滤器被 pydantic 静默忽略 → 返回全量，这条直接红）。"""
    u, h = await make_user("rv2subj")
    pid = (await client.post("/api/v1/projects", json={"name": "rv2subj"}, headers=h)).json()["id"]
    for st in ("api_definition", "api_case", "scenario", "ui_case", "adb_case"):
        session.add(RunRecord(project_id=pid, subject_type=st, subject_id="s-" + st,
                              subject_name="subj-" + st, trigger="manual",
                              status="passed", created_by=u.id))
    await session.commit()
    for st in ("api_definition", "api_case", "scenario", "ui_case", "adb_case"):
        r = await client.get("/api/v1/runs",
                             params={"project_id": pid, "subject_type": st}, headers=h)
        assert r.status_code == 200, f"subject_type={st} 应可过滤：{r.status_code} {r.text}"
        items = r.json()["items"]
        assert [x["subject_type"] for x in items] == [st], f"subject_type={st} 筛串了：{items}"


async def test_run_list_subject_type_illegal_422(client, make_user) -> None:
    """词表外的值必须 422（静默忽略 = 用户以为筛过了，其实列表还是全量）。

    1D T7 翻钉：这条原来钉的是 `adb_case` 被拒——那是 1C 预写的插槽（当时 worker 写不出
    adb_case 行）。T7 后 adb_case 进词表，改用真·词表外的值继续钉「闭集不收野值」。
    """
    _, h = await make_user("rv2subjbad")
    pid = (await client.post("/api/v1/projects", json={"name": "rv2subjbad"}, headers=h)).json()["id"]
    r = await client.get("/api/v1/runs",
                         params={"project_id": pid, "subject_type": "db_case"}, headers=h)
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "validation_failed"


# ---------- 迁移纪律：每个迁移必带可用的 down（§13 纪律 3） ----------

def test_migration_0014_roundtrip_preserves_data() -> None:
    """0013→head→0013→head：新列加了能删、删了能加，老数据一行不丢，legacy trigger 归一。"""
    import pymysql
    from alembic import command
    from alembic.config import Config

    u = urlsplit(os.environ["TP_DB_URL"])
    schema = "tp_m14_" + datetime.now(UTC).strftime("%H%M%S")
    sync_url = urlunsplit(u._replace(path="/" + schema)).replace("+asyncmy", "+pymysql")
    cfg = Config("alembic.ini")
    cfg.set_main_option("script_location", "migrations")
    cfg.set_main_option("sqlalchemy.url", sync_url)

    def conn():
        return pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                               password=u.password, database=schema, autocommit=True)

    admin = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                            password=u.password, autocommit=True)
    try:
        with admin.cursor() as cur:
            cur.execute("CREATE DATABASE " + chr(96) + schema + chr(96) +
                        " CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci")
        command.upgrade(cfg, "0013")          # 0014 之前的世界
        with conn().cursor() as cur:
            assert "stats" not in _cols(cur, schema, "run_record"), "0013 不该有 stats"
            # trigger 是 MySQL 保留字：裸 SQL 一律加反引号（本任务真被绊倒两次）
            cur.execute(
                "INSERT INTO run_record (id, project_id, subject_type, subject_id, subject_name,"
                " `trigger`, status, created_at, updated_at)"
                " VALUES ('legacy-1','p1','api_case','c1','老数据','case','passed',NOW(),NOW())")

        command.upgrade(cfg, "head")          # 应用 0014
        with conn().cursor() as cur:
            added = {"started_at", "finished_at", "stats", "summary_graph",
                     "lease_owner", "cancel_requested", "max_runtime_ms"}
            assert added <= _cols(cur, schema, "run_record"), "0014 缺列"
            cur.execute("SELECT `trigger` FROM run_record WHERE id='legacy-1'")
            assert cur.fetchone()[0] == "manual", "legacy 'case' 必须归一为 manual（R46）"

        command.downgrade(cfg, "0013")        # down 必须真的可用
        with conn().cursor() as cur:
            assert not (added & _cols(cur, schema, "run_record")), "down 没删干净"
            cur.execute("SELECT id, subject_name, `trigger` FROM run_record WHERE id='legacy-1'")
            row = cur.fetchone()
            assert row == ("legacy-1", "老数据", "manual"), f"down 不该吃数据：{row}"

        command.upgrade(cfg, "head")          # 再加回来
        with conn().cursor() as cur:
            assert added <= _cols(cur, schema, "run_record")
            cur.execute("SELECT subject_name FROM run_record WHERE id='legacy-1'")
            assert cur.fetchone()[0] == "老数据"
    finally:
        with admin.cursor() as cur:
            cur.execute("DROP DATABASE IF EXISTS " + chr(96) + schema + chr(96))
        admin.close()
