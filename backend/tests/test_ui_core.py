"""1C 执行核（计划 T7）：真浏览器驱动 `execution/ui_core.run_ui` 的行为钉。

这一档是「Playwright 执行是真的」这句话的可执行版本，跑的是靶场 T1 那四张 HTML 页
（/ui/login、/ui/home、/ui/frame），靶子不靠 mock：
- 靶场以**真 http 服务**起在 8322（Playwright 只认 http:// URL；9999 是 e2e 车道、
  8320/8321 是手工/e2e 后端，都不许碰），端口被占就顺延，用完必关。
- 判 skip 还是判失败的依据是**真的起一次 chromium**：起不来就整文件 skip 并打印原因
  （`-rs` 可见）。静默跳过等于假绿，本项目把这当缺陷（R97 同款口径）。

覆盖计划 Step 1 的 ①–⑩，外加 D5 制品配额与运行超时两条批次决定。
"""
from __future__ import annotations

import ast
import asyncio
import socket
import threading
import time
from pathlib import Path

import pytest

# —— 靶场真服务（8322 起顺延；TP_UI_TARGET_PORT 可显式指定）——————————————————

DEFAULT_UI_TARGET_PORT = 8322  # 9999=e2e 车道、8320/8321=手工/e2e 后端，本文件都不占


def _pick_port() -> int:
    import os

    base = int(os.environ.get("TP_UI_TARGET_PORT", str(DEFAULT_UI_TARGET_PORT)))
    for p in range(base, base + 8):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
            except OSError:
                continue
            return p
    raise RuntimeError(f"{base}..{base + 7} 全被占用，起不了 UI 靶场")


@pytest.fixture(scope="module")
def base_url():
    """靶场 uvicorn 线程，module 级复用（起停一次），teardown 必关。"""
    import uvicorn

    from scripts.target_app import app

    port = _pick_port()
    cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(cfg)
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    deadline = time.time() + 15
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("靶场 uvicorn 15s 没起来")
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    th.join(timeout=8)
    assert not th.is_alive(), "靶场线程没收尾，会拖住后续测试"


# —— 真浏览器判据：起得来才跑，起不来整文件 skip（打印原因，绝不静默）——————


@pytest.fixture(scope="module")
def browser_version():
    async def probe() -> str:
        from playwright.async_api import async_playwright

        async with async_playwright() as pw:
            b = await pw.chromium.launch(headless=True)
            v = b.version
            await b.close()
            return v

    try:
        return asyncio.run(probe())
    except Exception as e:  # noqa: BLE001 skip 判据就是一切启动失败
        pytest.skip(f"真实 chromium 启动失败，本文件全部跳过（这不是通过）："
                    f"{type(e).__name__}: {str(e)[:300]}")


# —— 命令与元素构造小工具 ————————————————————————————————————————————


def cmd(id_: str, type_: str, **kw) -> dict:
    d: dict = {"id": id_, "type": type_}
    d.update(kw)
    return d


ELEMENTS = {
    "el_account": {"name": "账号框", "locator_type": "id", "locator": "account"},
    "el_password": {"name": "口令框", "locator_type": "id", "locator": "password"},
    "el_submit": {"name": "登录按钮", "locator_type": "id", "locator": "submit"},
    "el_tip": {"name": "登录页提示", "locator_type": "id", "locator": "login-tip"},
    "el_title": {"name": "工作台标题", "locator_type": "css", "locator": "#title"},
    "el_err": {"name": "错误提示", "locator_type": "xpath", "locator": "//p[@id='err']"},
    "el_late": {"name": "迟到行", "locator_type": "id", "locator": "late-row"},
    "el_name_password": {"name": "口令框(name)", "locator_type": "name", "locator": "password"},
}


def login_cmds(wrong: bool = False) -> list[dict]:
    """打开登录页 → 填账号口令 → 点提交。对口令落在 /ui/home，错口令停在 ?err=bad。"""
    pw = "wrong" if wrong else "demo123"
    return [
        cmd("u1", "open", input="/ui/login"),
        cmd("u2", "input", element_id="el_account", input="demo"),
        cmd("u3", "input", element_id="el_name_password", input=pw),  # name→[name=…] 映射也在这钉
        cmd("u4", "click", element_id="el_submit"),
    ]


def by_id(res, id_: str) -> dict:
    return next(c for c in res.commands if c["id"] == id_)


# —— ① open + assert_title 绿 ————————————————————————————————————————


async def test_open_and_assert_title_green(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    res = await run_ui(
        [cmd("u1", "open", input="${page}"),
         cmd("u2", "assert_title", input="演示商城 · 登录"),
         cmd("u3", "assert_element", element_id="el_tip")],
        elements=ELEMENTS, variables={"page": base_url + "/ui/login"}, base_url=base_url)
    assert res.ok and res.passed and res.error is None, (res.error, res.commands)
    assert [c["status"] for c in res.commands] == ["pass", "pass", "pass"]
    assert all(c["elapsed_ms"] >= 0 for c in res.commands)
    # D5：绿案也有一张终态截图
    assert [a["kind"] for a in res.artifacts] == ["SCREENSHOT"]
    assert len(res.artifacts[0]["blob"]) > 1000


# —— ② input 后 get_text/get_attr/js + save_var 进 vars ——————————————————


async def test_get_and_save_vars(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    res = await run_ui(
        [cmd("u1", "open", input="/ui/login"),
         cmd("u2", "input", element_id="el_account", input="${acct}"),
         cmd("u3", "get_text", element_id="el_tip", save_var="tip"),
         cmd("u4", "get_attr", element_id="el_account", input="id", save_var="aid"),
         cmd("u5", "js", input="document.getElementById('account').value", save_var="typed"),
         cmd("u6", "js", input="2+2", save_var="sum")],
        elements=ELEMENTS, variables={"acct": "demo"}, base_url=base_url)
    assert res.ok and res.passed and res.error is None, (res.error, res.commands)
    assert isinstance(res.vars["tip"], str) and "demo123" in res.vars["tip"]
    assert res.vars["aid"] == "account"
    assert res.vars["typed"] == "demo", "${var} 渲染后要真填进页面"
    assert res.vars["sum"] == "4" and isinstance(res.vars["sum"], str), "save_var 一律 str（1B _stringify 口径）"


# —— ③ 断言不成立 = fail（橙），绝不是 error（红）；⑥ 失败自动制品 ——————————————


async def test_failed_assertion_is_fail_not_error_with_artifacts(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    # 错口令登录后停在登录页；断言「登录成功」文本——断言跑成了、结论是不成立 → fail
    res = await run_ui(
        login_cmds(wrong=True)
        + [cmd("u5", "assert_text", element_id="el_tip", input="登录成功")],
        elements=ELEMENTS, base_url=base_url)
    assert res.ok is True, "断言失败不叫没跑成"
    assert res.error is None and res.passed is False
    row = by_id(res, "u5")
    assert row["status"] == "fail", "断言没过必须是 fail，不能升级成 error"
    # R108：断言行逐键同 shared/assertions.py:_row / DebugPanel.tsx 读取的形状
    a = row["assertions"][0]
    assert set(a) == {"type", "passed", "expected", "actual", "error", "path"}
    assert a["type"] == "assert_text" and a["passed"] is False
    assert a["expected"] == "登录成功" and "演示账号" in str(a["actual"])
    assert a["error"] is None and a["path"], "path 对 UI 是定位器描述（R108）"
    # ⑥/D5：fail 当场 1 图 + 1 DOM，终态再 1 图
    shots = [x for x in res.artifacts if x["kind"] == "SCREENSHOT"]
    doms = [x for x in res.artifacts if x["kind"] == "DOM"]
    assert len(shots) == 2 and len(doms) == 1
    assert len(shots[0]["blob"]) > 1000, "截图得是真截图（>1000B），不是占位"
    assert b"login-form" in doms[0]["blob"]
    assert shots[0]["step_id"] == "u5"


# —— ④ wait_element 对 #late-row：5s 绿 / 500ms 红（error 且文案含「超时」）————


async def test_wait_element_green_within_5s(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    res = await run_ui(login_cmds() + [
        cmd("u5", "wait_element", element_id="el_late", timeout_ms=5000),
        cmd("u6", "assert_text", element_id="el_title", input="订单工作台")],
        elements=ELEMENTS, base_url=base_url)
    assert res.ok and res.passed and res.error is None, (res.error, res.commands)
    assert by_id(res, "u5")["status"] == "pass"
    assert by_id(res, "u5")["elapsed_ms"] >= 1000, "#late-row 是 3s 定时器插的，秒过=靶子失效"


async def test_wait_element_red_timeout_says_timeout(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    res = await run_ui(login_cmds() + [
        cmd("u5", "wait_element", element_id="el_late", timeout_ms=500)],
        elements=ELEMENTS, base_url=base_url)
    assert res.ok is True and res.passed is False
    row = by_id(res, "u5")
    assert row["status"] == "error", "等不到=没跑成，是 error 不是 fail"
    assert "超时" in row["message"] and "late-row" in row["message"]
    assert "Traceback" not in row["message"] and "Call log" not in row["message"], \
        "报告里不许甩 Playwright 堆栈/调用日志"


# —— ⑤/⑦ 缺元素、未知元素、畸形输入：error 且不抛 ————————————————————————


async def test_missing_element_is_error_not_raise(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    res = await run_ui(
        [cmd("u1", "open", input="/ui/login"),
         cmd("u2", "click", element_id="el_ghost", optional=True),                   # elements 里没这个 id
         cmd("u3", "click", inline_locator={"type": "css", "value": "#ghost"},
             optional=True, timeout_ms=800),  # 页面上没有（800ms 就判，别拖满 10s）
         cmd("u4", "input")],                                              # 连定位目标都没有
        elements=ELEMENTS, base_url=base_url)
    assert res.ok is True, "驱动对畸形输入只产 error 行，绝不抛穿"
    assert by_id(res, "u2")["status"] == "error" and "el_ghost" in by_id(res, "u2")["message"]
    r3 = by_id(res, "u3")
    assert r3["status"] == "error" and "定位器" in r3["message"] and "没找到" in r3["message"]
    assert by_id(res, "u4")["status"] == "error"


# —— ⑧ should_cancel：sleep 在 1s 内停下 ————————————————————————————————


async def test_cancel_stops_sleep_within_1s_of_flag(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    # 翻转阈值 1.2s：登录几步跑完约 0.5~1s，旗标在 sleep 的**第一片中途**才翻转——
    # 不切片的实现会在入口处查一次然后睡满 30s（必红）；切片实现下一片边界即停。
    t0 = time.perf_counter()

    async def flip_after_start() -> bool:
        return time.perf_counter() - t0 > 1.2

    res = await run_ui(
        [cmd("u1", "open", input="/ui/login"),
         cmd("u2", "sleep", input=30000),
         cmd("u3", "assert_title", input="不该跑到这")],
        elements=ELEMENTS, base_url=base_url, should_cancel=flip_after_start)
    spent = time.perf_counter() - t0
    slept = by_id(res, "u2")["elapsed_ms"]
    assert 500 <= slept < 2500, f"取消要落在 sleep 的切片轮询里，实际睡了 {slept}ms"
    assert spent < 4.0, f"取消后整案必须很快收，实际 {spent:.2f}s"
    assert by_id(res, "u2")["status"] == "cancelled"
    assert by_id(res, "u3")["status"] == "skip"
    assert res.passed is False


async def test_sleep_passes_normally(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    res = await run_ui([cmd("u1", "sleep", input=300)], elements=ELEMENTS, base_url=base_url)
    assert by_id(res, "u1")["status"] == "pass"
    assert by_id(res, "u1")["elapsed_ms"] >= 250


# —— ⑨ 未开放 type：error 且文案点名批次（R101 防御纵深） —————————————————


async def test_blocked_command_types_error_with_batch(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    res = await run_ui(
        [cmd("u1", "upload", element_id="el_account", optional=True),
         cmd("u2", "switch_frame", element_id="el_account", optional=True),
         cmd("u3", "teleport", optional=True)],  # 连 §7.2 枚举都不在
        elements=ELEMENTS, base_url=base_url)
    for id_ in ("u1", "u2"):
        row = by_id(res, id_)
        assert row["status"] == "error" and "1C" in row["message"], row
    assert by_id(res, "u3")["status"] == "error" and "未知" in by_id(res, "u3")["message"]


# —— max_runtime_ms：到点剩余 skip + 整案 error 运行超时 ——————————————————


async def test_max_runtime_expires_to_skips(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    res = await run_ui(
        [cmd("u1", "open", input="/ui/login"),
         cmd("u2", "sleep", input=8000),
         cmd("u3", "assert_title", input="不该跑到这")],
        elements=ELEMENTS, base_url=base_url, max_runtime_ms=800)
    assert res.ok is True
    assert res.error and "运行超时" in res.error
    assert by_id(res, "u3")["status"] == "skip" and "运行超时" in by_id(res, "u3")["message"]
    assert res.passed is False


# —— D5 配额：2 图 + 1 DOM 硬上限，超了说出口不静默 ———————————————————————


async def test_artifact_cap_is_two_shots_one_dom_and_says_so(base_url, browser_version) -> None:
    from app.modules.execution.ui_core import run_ui

    res = await run_ui(
        [cmd("u1", "open", input="/ui/login"),
         cmd("u2", "assert_text", element_id="el_tip", input="绝不存在的文本A", optional=True),
         cmd("u3", "assert_text", element_id="el_tip", input="绝不存在的文本B", optional=True)],
        elements=ELEMENTS, base_url=base_url)
    shots = [a for a in res.artifacts if a["kind"] == "SCREENSHOT"]
    doms = [a for a in res.artifacts if a["kind"] == "DOM"]
    assert len(shots) == 2 and len(doms) == 1, "每案硬上限 2 图 + 1 DOM（D5）"
    joined = "；".join(str(c["message"]) for c in res.commands)
    assert "配额" in joined or "上限" in joined, "被配额裁掉的截图必须在 message 里说出口"


# —— ⑩ 契约 4 源码扫描：零 app.modules import + playwright 不在模块顶层 ————


def test_ui_core_is_contract4_clean() -> None:
    import app.modules.execution.ui_core as ui_core

    src = Path(ui_core.__file__).read_text(encoding="utf-8")
    # 文本扫描（照 test_engine_runner.py:433-439 的手法）：任何位置都不许出现跨模块 import
    assert "from app.modules" not in src and "import app.modules" not in src, \
        "执行核不得 import 任何领域模块（契约 4）"
    # AST 扫描：playwright 必须存在、且只许在函数体（延迟 import，R95——
    # 没装浏览器的机器必须照样能 import 后端）
    tree = ast.parse(src)
    top_imports = {n.module or "" for n in tree.body if isinstance(n, ast.ImportFrom)}
    top_imports |= {a.name for n in tree.body if isinstance(n, ast.Import) for a in n.names}
    assert not any("playwright" in m for m in top_imports), \
        "playwright 必须在 run_ui 函数体内 import（R95），模块顶层 import 会把没装浏览器的机器拖下水"
    nested = [n for f in ast.walk(tree) if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef))
              for n in ast.walk(f) if isinstance(n, (ast.Import, ast.ImportFrom))]
    assert any("playwright" in (getattr(n, "module", None) or "")
               or any("playwright" in a.name for a in getattr(n, "names", [])) for n in nested), \
        "run_ui 里必须真的 import playwright，否则驱动器是空壳"
