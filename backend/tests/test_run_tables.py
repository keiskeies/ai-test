"""1B T2：run_step_result / run_artifact / run_event（§4.6 + 计划 R47）。

三张表是报告详情、实时进度、单步重跑的共同地基，所以这里钉的是**约束语义**
而不是 ORM 手感：唯一键决定「重跑覆盖同一行」还是「追加一行脏数据」，
run_event 的唯一 seq 决定断线重连会不会丢步。
"""
from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit

import pytest
from sqlalchemy.exc import IntegrityError


async def _run(session, pid: str = "p-t2") -> str:
    from app.modules.execution.models import RunRecord

    r = RunRecord(project_id=pid, subject_type="scenario", subject_id="sc-1",
                  subject_name="下单场景", trigger="manual", status="running")
    session.add(r)
    await session.commit()
    return r.id


async def test_step_result_unique_per_key_and_row(session) -> None:
    """(run_id, step_key, row_no) 唯一：同键重复插必须炸，数据集多行必须并存。"""
    from app.modules.execution.models import RunStepResult

    rid = await _run(session)
    session.add(RunStepResult(run_id=rid, step_key="n1", kind="api_case", status="pass"))
    await session.commit()
    session.add(RunStepResult(run_id=rid, step_key="n1", kind="api_case", status="fail"))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()

    # 数据集步骤：同 step_key 不同 row_no 是合法的多行（§8.6 的 step_key#r{N}）
    for i in (1, 2, 3):
        session.add(RunStepResult(run_id=rid, step_key="n2", kind="api_case", status="pass",
                                  row_no=i, row_total=3))
    await session.commit()
    t = RunStepResult.__table__
    got = (await session.execute(t.select().where(t.c.run_id == rid, t.c.step_key == "n2"))).all()
    assert len(got) == 3, "数据集三行必须各自成明细"


async def test_step_result_parent_key_supports_tree(session) -> None:
    """parent_step_key 让报告页重建步骤树（容器 → 子步骤）；vars_snapshot 是单步重跑的依据。"""
    from app.modules.execution.models import RunStepResult

    rid = await _run(session)
    session.add(RunStepResult(run_id=rid, step_key="n1", kind="loop", status="pass"))
    session.add(RunStepResult(run_id=rid, step_key="n1.1", kind="api_case", status="fail",
                              parent_step_key="n1", subject_name="创建订单", attempts=2,
                              elapsed_ms=120, vars_snapshot={"uid": "77"},
                              detail={"request": {"method": "POST"}, "assertions": []}))
    await session.commit()
    t = RunStepResult.__table__
    row = (await session.execute(t.select().where(t.c.run_id == rid, t.c.step_key == "n1.1"))).first()
    assert row.parent_step_key == "n1" and row.attempts == 2
    assert row.vars_snapshot == {"uid": "77"}
    assert row.detail["request"]["method"] == "POST"


async def test_event_seq_unique_per_run(session) -> None:
    """run_event 的 (run_id, seq) 唯一：seq 是断线重连的游标，重复即丢步。"""
    from app.modules.execution.models import RunEvent

    rid = await _run(session)
    session.add(RunEvent(run_id=rid, seq=1, type="step", payload={"step_key": "n1"}))
    await session.commit()
    session.add(RunEvent(run_id=rid, seq=1, type="step", payload={"step_key": "n2"}))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()
    # 不同 run 可复用同一 seq（游标是 run 内的）
    other = await _run(session, pid="p-t2b")
    session.add(RunEvent(run_id=other, seq=1, type="run_end", payload={"status": "passed"}))
    await session.commit()


async def test_artifact_rows_are_queryable_by_run(session) -> None:
    """制品按 run 查：报告页列下载链接、purge 清目录都靠它。"""
    from app.modules.execution.models import RunArtifact

    rid = await _run(session)
    session.add(RunArtifact(run_id=rid, step_key="n1", kind="LOG",
                            ref="artifacts/" + rid + "/n1.txt", bytes=2048))
    session.add(RunArtifact(run_id=rid, step_key=None, kind="RESPONSE",
                            ref="artifacts/" + rid + "/resp-2.json", bytes=99999))
    await session.commit()
    t = RunArtifact.__table__
    rows = (await session.execute(t.select().where(t.c.run_id == rid))).all()
    assert {r.kind for r in rows} == {"LOG", "RESPONSE"}
    assert sum(r.bytes for r in rows) == 102047


async def test_run_record_new_columns_roundtrip(session) -> None:
    """T1 的列在真库里能写读（防模型加了列而迁移漏了，或反之）。"""
    from app.modules.execution.models import RunRecord

    rid = await _run(session)
    r = await session.get(RunRecord, rid)
    r.started_at = datetime.now(UTC).replace(microsecond=0)
    r.lease_owner = "celery@CJMD"
    r.cancel_requested = 1
    r.max_runtime_ms = 900_000
    r.stats = {"total": 4, "pass": 3, "fail": 1, "skip": 0, "rows_total": 6}
    r.summary_graph = {"version": 1, "nodes": [{"key": "n1", "kind": "api_case"}]}
    await session.commit()
    back = await session.get(RunRecord, rid)
    assert back.lease_owner == "celery@CJMD" and back.cancel_requested == 1
    assert back.max_runtime_ms == 900_000 and back.stats["rows_total"] == 6
    assert back.summary_graph["nodes"][0]["key"] == "n1"


def _db_admin(u):
    import pymysql

    return pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                           password=u.password, autocommit=True)


def _tables(u, schema: str) -> set[str]:
    c = _db_admin(u)
    c.select_db(schema)
    with c.cursor() as cur:
        cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema=%s"
                    " AND table_type=%s", (schema, "BASE TABLE"))
        out = {r[0] for r in cur.fetchall()}
    c.close()
    return out


def test_migration_0015_roundtrip() -> None:
    """0014→0015→0014→0015：三表能建能拆，且拆表不碰别的表的数据。"""
    import os

    from alembic import command
    from alembic.config import Config

    u = urlsplit(os.environ["TP_DB_URL"])
    schema = "tp_m15_" + datetime.now(UTC).strftime("%H%M%S")
    cfg = Config("alembic.ini")
    cfg.set_main_option("script_location", "migrations")
    cfg.set_main_option("sqlalchemy.url",
                        urlunsplit(u._replace(path="/" + schema)).replace("+asyncmy", "+pymysql"))
    new = {"run_step_result", "run_artifact", "run_event"}

    admin = _db_admin(u)
    try:
        with admin.cursor() as cur:
            cur.execute("CREATE DATABASE " + chr(96) + schema + chr(96) +
                        " CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci")
        command.upgrade(cfg, "0014")
        assert not new & _tables(u, schema), "0014 世界不该有这三张表"

        c = _db_admin(u)
        c.select_db(schema)
        with c.cursor() as cur:
            cur.execute(
                "INSERT INTO run_record (id, project_id, subject_type, subject_id, subject_name,"
                " `trigger`, status, created_at, updated_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())",
                ("keep-1", "p1", "api_case", "c1", "留着", "debug", "passed"))
        c.close()

        command.upgrade(cfg, "0015")
        assert new <= _tables(u, schema), "0015 没建表"

        command.downgrade(cfg, "0014")
        assert not new & _tables(u, schema), "down 没拆干净"
        c = _db_admin(u)
        c.select_db(schema)
        with c.cursor() as cur:
            cur.execute("SELECT subject_name FROM run_record WHERE id=%s", ("keep-1",))
            assert cur.fetchone()[0] == "留着", "down 不该碰别的表"
        c.close()

        command.upgrade(cfg, "head")
        assert new <= _tables(u, schema), "重新 upgrade 失败"
    finally:
        with admin.cursor() as cur:
            cur.execute("DROP DATABASE IF EXISTS " + chr(96) + schema + chr(96))
        admin.close()
