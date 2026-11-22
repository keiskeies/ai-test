"""真 worker 冒烟（T9 判据⑤）：spike 转正为仓库内自检脚本（§13 纪律 1 的业主演示）。

它真的做了什么（不是自检报告，是真链路）：
  1. 建一次性 schema（alembic head）+ 起靶场子进程（TP_TARGET_PORT 自选端口，
     不碰 e2e lane 的 9999）+ 起 Celery worker 子进程（--pool=solo）；
  2. enqueue 一个真场景（登录 → 提取 token → 循环查单 ×2 → 断言）走 send_task 投真 Redis；
  3. 本进程以 SSE 桥的姿态订阅 run.<id>（把 worker 经 Redis pub/sub 发来的事件打印出来，
     这就是「L2 执行 → Redis → L1」的现场直播）；
  4. 轮询 run 到终态；核验：终态 passed、步骤行齐全、事件序列合法（seq 单调连续、
     run_end 收尾、每个执行过的步骤都有 running→终态对）；
  5. 自杀退出：worker / 靶场进程树终止，临时库删除；成功 exit 0，失败打印真实原因 exit≠0。

用法（backend 目录下）：
    .venv/Scripts/python.exe scripts/verify_worker.py
失败排查：worker 的完整日志在输出末尾（stdout+stderr 捕获），scratch 目录路径在开头打印。
"""
from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.shared.localenv import require_env  # noqa: E402  （app 不在 sys.path 上，上面刚插）

SCRATCH_ROOT = Path("D:/tmp")  # ledger 踩坑：scratch 一律硬编码 D:/tmp，不用 os.tmpdir
PASSWORD = "Verifier@12345"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = int(s.getsockname()[1])
    s.close()
    return p


def _prepare_env() -> tuple[dict, str]:
    """一次性 schema + 全套 TP_ 环境（子进程继承）。返回 (env, schema)。"""
    ts = datetime.now(UTC).strftime("%H%M%S")
    scratch = SCRATCH_ROOT / ("tp_verify_" + ts)
    scratch.mkdir(parents=True, exist_ok=True)
    schema = "testpilot_verify_" + ts
    base = require_env("TP_DB_URL")
    u = urlsplit(base)
    db_url = urlunsplit(u._replace(path="/" + schema))
    env = dict(os.environ)
    env.update({
        "TP_DB_URL": db_url,
        "TP_REDIS_URL": require_env("TP_REDIS_URL"),
        "TP_SECRET_KEY": "verify-worker-secret-0123456789ab",
        "TP_BOOTSTRAP_ACCOUNT": "admin",
        "TP_BOOTSTRAP_PASSWORD": PASSWORD,
        # D10/R118：本脚本占**自己的 lane**，队列名 tp.verify{ts} 与 schema 同一个时间戳。
        # 两层隔离各挡一种事故：与演示常驻 worker（tp.dev）分开 = R118 原事故；
        # 每次运行各一条 = 两个 verify_worker 并行时互不偷任务（pytest 的并行安全
        # 靠 per-session schema，broker 这一侧以前没跟上）。父进程 enqueue 与
        # worker 子进程都吃这份 env，两侧从 settings.task_queue 推出同一个名字。
        "TP_ENV": "verify" + ts,
        "TP_EXEC_MODE": "celery",  # 本脚本存在的意义就是验 celery 档，不许 inline 兜底
        "TP_ARTIFACTS_DIR": str(scratch / "artifacts"),
    })
    # 本进程也要吃到同一份环境：get_settings() 读的是 os.environ（外加 backend/.env），
    # 只给子进程传等于父进程继续连 backend/.env 里的开发库——第一版就这么差点把 admin
    # 种进 testpilot 演示库（撞唯一键才停住，零写入）。
    os.environ.update(env)
    import pymysql
    from alembic import command
    from alembic.config import Config

    conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                           password=u.password, autocommit=True)
    with conn.cursor() as cur:
        cur.execute("CREATE DATABASE IF NOT EXISTS " + chr(96) + schema +
                    chr(96) + " CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci")
    conn.close()
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))
    cfg.set_main_option("sqlalchemy.url", db_url.replace("+asyncmy", "+pymysql"))
    command.upgrade(cfg, "head")
    print("[verify] scratch schema:", schema, "| scratch dir:", scratch)
    return env, schema


def _spawn(cmd: list[str], env: dict, log_path: Path, label: str) -> subprocess.Popen:
    log = open(log_path, "wb")
    p = subprocess.Popen(cmd, cwd=str(BACKEND), env=env, stdout=log, stderr=subprocess.STDOUT)
    print("[verify] " + label + " 子进程 pid=" + str(p.pid) + "，日志 " + str(log_path))
    return p


def _terminate(p: subprocess.Popen | None, label: str) -> None:
    if p is None or p.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)],
                       capture_output=True, check=False)
    else:
        p.terminate()
    try:
        p.wait(timeout=15)
    except subprocess.TimeoutExpired:
        p.kill()
    print("[verify] " + label + " 已终止")


STEP_GRAPH = {
    "version": 1,
    "nodes": [
        {"key": "login", "kind": "http_direct", "name": "登录", "ref": None,
         "config": {"url": "${base}/login", "method": "POST",
                    "body": {"type": "json", "content": {"username": "demo",
                                                         "password": "demo123"}}},
         "children": []},
        {"key": "tok", "kind": "extract", "name": "提取 token", "ref": None,
         "config": {"rules": [{"var": "token", "expr": "$.token"}]}, "children": []},
        {"key": "wait", "kind": "sleep", "name": "等待", "ref": None,
         "config": {"ms": 600}, "children": []},
        {"key": "loop", "kind": "loop", "name": "查单两遍", "ref": None,
         "config": {"mode": "count", "max_iter": 2},
         "children": [
             {"key": "loop.q", "kind": "http_direct", "name": "查订单", "ref": None,
              "config": {"url": "${base}/order/1", "method": "GET",
                         "headers": [["Authorization", "Bearer ${token}"]],
                         "assertions": [{"type": "status_code", "expected": 200},
                                        {"type": "json_path_equals", "path": "$.status",
                                         "expected": "PAID"}]},
              "children": []}]},
        {"key": "fin", "kind": "assert", "name": "终局断言", "ref": None,
         "config": {"assertions": [{"type": "status_code", "expected": 200}]},
         "children": []},
    ],
}


async def _seed_data(base_url: str) -> tuple[str, str, str, dict]:
    """直插 admin + 项目 + 场景（脚本不是 API 消费者，直插 ORM 最诚实）。返回
    (project_id, scenario_id, user_id, actor)。"""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.core.config import get_settings
    from app.core.security import hash_password
    from app.modules.iam.models import Project, User
    from app.modules.scenario.models import Scenario

    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    try:
        maker = async_sessionmaker(bind=eng, expire_on_commit=False, class_=AsyncSession)
        async with maker() as db:
            u = User(account="admin", name="verify", password_hash=hash_password(PASSWORD),
                     is_system_admin=True, status="active")
            db.add(u)
            await db.flush()
            proj = Project(name="worker 冒烟", created_by=u.id)
            db.add(proj)
            await db.flush()
            sc = Scenario(project_id=proj.id, name="登录-查单冒烟", step_graph=STEP_GRAPH,
                          variables={"base": base_url}, fail_fast=True, version=1,
                          step_count=5, owner_id=u.id, updated_by=u.id)
            db.add(sc)
            await db.commit()
            actor = {"user_id": u.id, "user_name": u.name, "is_system_admin": True,
                     "perms": {"*"}, "entry": "http"}
            return proj.id, sc.id, u.id, actor
    finally:
        await eng.dispose()


async def _subscribe_and_print(run_id: str, seen: list[dict]) -> None:
    from app.core.eventbus import get_bus

    # await 是语义的一部分（D11）：subscribe 到返回时频道才真的加入，此前 `async for
    # in bus.subscribe(...)` 拿到的是 coroutine，D11 修复后类型变了、这里跟着变。
    async for ev in await get_bus().subscribe("run." + run_id):
        seen.append(ev)
        print("[sse-bridge] seq=" + str(ev.get("seq")) + " " + str(ev.get("type")) +
              " " + str((ev.get("payload") or {}).get("key", "")))


async def _poll_terminal(run_id: str, timeout_s: float) -> dict:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.core.config import get_settings
    from app.modules.execution.models import RunRecord

    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    try:
        maker = async_sessionmaker(bind=eng, expire_on_commit=False, class_=AsyncSession)
        t0 = time.perf_counter()
        while True:
            async with maker() as db:
                rec = await db.get(RunRecord, run_id)
                status = rec.status if rec else "missing"
                err = rec.error if rec else None
            if status in ("passed", "failed", "error", "cancelled"):
                return {"status": status, "error": err}
            if time.perf_counter() - t0 > timeout_s:
                return {"status": "timeout", "error": "last=" + status}
            await asyncio.sleep(0.5)
    finally:
        await eng.dispose()


async def _verify_db(run_id: str) -> list[str]:
    """跑完后核验步骤行与事件序列，返回问题列表（空 = 通过）。"""
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.core.config import get_settings
    from app.modules.execution.models import RunEvent, RunStepResult

    eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
    problems: list[str] = []
    try:
        maker = async_sessionmaker(bind=eng, expire_on_commit=False, class_=AsyncSession)
        async with maker() as db:
            steps = {s.step_key: s for s in (await db.execute(
                select(RunStepResult).where(RunStepResult.run_id == run_id))).scalars()}
            for key in ("login", "tok", "wait", "loop", "loop.q", "fin"):
                row = steps.get(key)
                if row is None:
                    problems.append("缺步骤行 " + key)
                elif row.status != "pass":
                    problems.append("步骤 " + key + " 状态 " + row.status)
            loop_q = steps.get("loop.q")
            if loop_q is not None and loop_q.attempts != 2:
                problems.append("loop.q attempts=" + str(loop_q.attempts) + "（循环 2 次应覆盖写）")
            evs = (await db.execute(select(RunEvent).where(RunEvent.run_id == run_id)
                                    .order_by(RunEvent.seq))).scalars().all()
        seqs = [e.seq for e in evs]
        if seqs != list(range(1, len(seqs) + 1)):
            problems.append("事件 seq 不连续：" + str(seqs))
        types = [e.type for e in evs]
        if types[-1:] != ["run_end"]:
            problems.append("run_end 不是最后一个事件：" + str(types[-3:]))
        for key in ("login", "tok", "wait", "loop", "loop.q", "fin"):
            ran = [e for e in evs if e.type == "step/running"
                   and (e.payload or {}).get("key") == key]
            done = [e for e in evs if e.type.startswith("step/") and e.type != "step/running"
                    and (e.payload or {}).get("key") == key]
            if not ran:
                problems.append("步骤 " + key + " 没有 step/running")
            elif not done:
                problems.append("步骤 " + key + " 有 running 无终态事件")
            elif ran[0].seq > done[-1].seq:
                problems.append("步骤 " + key + " 的 running 在终态之后")
        return problems
    finally:
        await eng.dispose()


def _tail(path: Path, n: int = 60) -> str:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as e:
        return "(读不到日志：" + str(e) + ")"
    return "\n".join(lines[-n:])


async def _main() -> int:
    env, schema = _prepare_env()
    target_port = _free_port()
    scratch = Path(env["TP_ARTIFACTS_DIR"]).parent
    target_env = dict(env)
    target_env["TP_TARGET_PORT"] = str(target_port)
    base = "http://127.0.0.1:" + str(target_port)

    target = _spawn([sys.executable, "scripts/target_app.py"], target_env,
                    scratch / "target.log", "靶场")
    worker = _spawn([sys.executable, "-m", "celery", "-A", "app.worker:celery_app",
                     "worker", "--pool=solo", "-l", "info"], env,
                    scratch / "worker.log", "worker")
    seen: list[dict] = []
    run_id = "?"
    try:
        # 等靶场起来（真 HTTP 探活，最多 20s）
        import httpx

        # trust_env=False 不是可选项：本机环境把 no_proxy 写成含 `[::1]` 的清单，httpx 解析
        # 这一条时直接 InvalidURL("Invalid port: ':1]'")——每次探活都抛异常、被 except 吞掉，
        # 于是靶场明明 200 在跑（urllib 实测）而这里报「20s 没起来」。执行核早就吃过同一课
        # （execution/core.py 的 AsyncClient 也钉 trust_env=False：环回探活不该被宿主代理左右）。
        t0 = time.perf_counter()
        last_err = ""
        while True:
            try:
                async with httpx.AsyncClient(trust_env=False) as probe:
                    if (await probe.get(base + "/healthz", timeout=1.0)).status_code == 200:
                        break
                last_err = "探活返回非 200"
            except Exception as exc:
                last_err = type(exc).__name__ + ": " + str(exc)[:200]
            if time.perf_counter() - t0 > 20:
                print("FAIL: 靶场 20s 没起来；最后一次探活 " + last_err + "\n"
                      + _tail(scratch / "target.log"))
                return 2
            await asyncio.sleep(0.3)

        from app.core.db import get_engine  # noqa: F401  # 先装配 core 单例引用路径
        from app.core.eventbus import init_bus
        from app.main import create_app

        create_app()
        init_bus()
        _project_id, scenario_id, _uid, actor = await _seed_data(base)

        # enqueue 走独立 NullPool session（与 web 进程同款：只投递不执行）
        from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
        from sqlalchemy.pool import NullPool

        from app.core.config import get_settings
        from app.modules.scenario.orchestration import enqueue

        eng = create_async_engine(get_settings().db_url, poolclass=NullPool)
        try:
            maker = async_sessionmaker(bind=eng, expire_on_commit=False, class_=AsyncSession)
            async with maker() as db:
                rec = await enqueue(db, project_id=_project_id, subject_id=scenario_id,
                                    subject_name="登录-查单冒烟", trigger="manual",
                                    created_by=_uid, actor=actor)
                run_id = rec.id
        finally:
            await eng.dispose()
        print("[verify] 已投递 run_id=" + run_id + "，等 worker 领取执行…")

        sub_task = asyncio.create_task(_subscribe_and_print(run_id, seen))
        result = await _poll_terminal(run_id, timeout_s=120)
        await asyncio.sleep(0.5)  # 给最后一帧 pub/sub 一点落地时间
        sub_task.cancel()
        print("[verify] run 终态：" + str(result))

        problems = await _verify_db(run_id)
        if result["status"] != "passed":
            problems.insert(0, "run 终态不是 passed：" + str(result))
        if not seen:
            problems.append("本进程没从 Redis pub/sub 收到任何事件（跨进程广播没通）")
        if problems:
            print("FAIL: worker 冒烟未通过")
            for p in problems:
                print("  - " + p)
            print("--- worker.log (tail) ---\n" + _tail(scratch / "worker.log"))
            return 1
        print("OK: celery worker 端到端通过 —— run passed；6 步骤行全 pass；事件 " +
              str(len(seen)) + " 帧经 Redis pub/sub 跨进程收到且 seq 连续；" +
              "循环步覆盖写 attempts=2")
        return 0
    finally:
        _terminate(worker, "worker")
        _terminate(target, "靶场")
        import pymysql

        u = urlsplit(env["TP_DB_URL"])
        try:
            conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username,
                                   password=u.password, autocommit=True)
            with conn.cursor() as cur:
                cur.execute("DROP DATABASE IF EXISTS " + chr(96) + schema + chr(96))
            conn.close()
            print("[verify] 临时库已删除：" + schema)
        except Exception as e:
            print("[verify] 临时库删除失败（不影响结论）：" + str(e))


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
