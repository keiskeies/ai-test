"""1D T6 执行核 `execution/adb_core.run_adb` 的行为钉（全部挂假设备 fixture，T1）。

计划 T6 的三块各自有钉，逐条来：
- **建连阶段决定模式**（取证③/R139）：假 u2 连得上 → mode="u2"；假 u2 连不上 →
  mode="dump"（走 `uiautomator dump` 轮询）。**降级看得见**——mode 进结果，不是悄悄换。
- **26 步型执行**：shell 类直发假 adb；控件树类经 u2 注入缝（monkeypatch adb_u2.connect_session
  为 fake_u2）。断言 fail/error 两色、失败自动截屏（D5 配额）、录屏成对包裹、push/pull 制品。
- **契约 4 + 形状同构**：AST 扫源码零 app.modules、uiautomator2 不在顶层 import；每行
  `{id,type,status,message,elapsed_ms,assertions[],detail{}}` 与 ui_core 逐键同构（R102）。

假设备替的是 adb_cli subprocess + u2 包装这一层，产品分支逻辑一根不改（T1 的白盒替身）。
"""
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture()
def fake_adb(monkeypatch):
    """一台开箱即用的假 WiFi 设备 + 钉好 adb_path/env。默认走 dump 模式（假 u2 不注入）。"""
    from app.core.config import get_settings
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager().with_device(serial="192.168.1.50:5555")
    s = get_settings()
    monkeypatch.setattr(s, "adb_path", mgr.adb())
    monkeypatch.setenv("FAKE_ADB_STATE", str(mgr.state_path))
    # dump 模式：假 u2 永不连上（真机 atx 起不来的等价形状）——控件树类走 uiautomator dump。
    from app.modules.execution import adb_u2

    monkeypatch.setattr(adb_u2, "connect_session", lambda addr, **kw: None)
    return mgr


@pytest.fixture()
def fake_adb_u2(fake_adb, monkeypatch):
    """同一台设备，但注入假 u2（连得上）→ 建连阶段定成 mode="u2"。"""
    from app.modules.execution import adb_u2
    from scripts.fake_device import fake_u2

    monkeypatch.setattr(adb_u2, "connect_session", fake_u2.connect_session)
    return fake_adb


def step(id_: str, type_: str, config: dict | None = None, **kw) -> dict:
    d: dict = {"id": id_, "type": type_}
    if config is not None:
        d["config"] = config
    d.update(kw)
    return d


def by_id(res, id_: str) -> dict:
    return next(c for c in res.commands if c["id"] == id_)


SERIAL = "192.168.1.50:5555"


# —— 建连阶段决定模式（取证③/R139：降级看得见） ————————————————————


async def test_connect_phase_picks_dump_mode(fake_adb) -> None:
    """假 u2 连不上 → mode=dump，且这不是错误（error is None），但模式必须落在结果里。"""
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([step("a", "home")], serial=SERIAL)
    assert res.ok is True, "设备应得上 = 跑起来了"
    assert res.mode == "dump", "u2 起不来 → 整案走 dump 轮询（不是每步二选一）"
    assert res.error is None, "降级不是错误，不写 error（可见性走 mode）"
    assert by_id(res, "a")["status"] == "pass"


async def test_connect_phase_picks_u2_mode(fake_adb_u2) -> None:
    """假 u2 连得上 → mode=u2。两模式是**建连一次定终身**，不是执行中切换。"""
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([step("a", "home")], serial=SERIAL)
    assert res.ok is True and res.mode == "u2"


async def test_device_unreachable_is_ok_false_all_skip(monkeypatch) -> None:
    """设备连不上（connect_fail）→ ok=False + 全部 skip + 人话 error，绝不假跑绿。"""
    from app.core.config import get_settings
    from app.modules.execution import adb_u2
    from app.modules.execution.adb_core import run_adb
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager()
    mgr.set_state({"devices": [{"serial": "9.9.9.9:5555", "state": "device"}],
                   "connect_fail": ["9.9.9.9:5555"], "file_root": str(mgr.file_root)})
    monkeypatch.setattr(get_settings(), "adb_path", mgr.adb())
    monkeypatch.setenv("FAKE_ADB_STATE", str(mgr.state_path))
    monkeypatch.setattr(adb_u2, "connect_session", lambda addr, **kw: None)

    res = await run_adb([step("a", "home"), step("b", "shell", {"cmd": "whoami"})],
                        serial="9.9.9.9:5555")
    assert res.ok is False and res.passed is False
    assert res.error and "连不上" in res.error
    assert [c["status"] for c in res.commands] == ["skip", "skip"]
    assert {c["message"] for c in res.commands} == {"设备未连接，未执行"}, \
        "只有真跑过 adb_connect 并失败，才挣得起「设备未连接」这句（:586 分支）"


async def test_missing_adb_binary_says_adb_unavailable_not_device_offline(monkeypatch) -> None:
    """adb 本体缺失（:580）≠ 设备连不上（:586）：两种病在报告里不能共用一句 skip 原因。

    上一行那条测的是挣得起「设备未连接」的分支；这里 adb_connect 根本还没被调用
    （:585 才是它），旧 skip 原因「设备未连接，未执行」断言了一个从未测过的事实。
    注入点选 adb_core 自己的 adb_executable 绑定（run_adb 在函数里查模块全局，:579），
    抛 RuntimeError 与 resolve_adb_path() 返回 None → ADB_INSTALL_HINT 的真实形状一致；
    不靠 settings.adb_path 指向不存在路径，那条会撞本机 PATH/SDK 回落、不稳。
    """
    from app.modules.execution import adb_core
    from app.modules.execution.adb_core import AdbRunResult, run_adb

    def _boom() -> str:
        raise RuntimeError("没找到 adb 可执行（测试注入：等价 resolve_adb_path() → None）")

    async def _never(serial: str, **kw):
        raise AssertionError("adb 本体缺失时不该走到 adb_connect——「设备未连接」从未被验证过")

    monkeypatch.setattr(adb_core, "adb_executable", _boom)
    monkeypatch.setattr(adb_core, "adb_connect", _never)

    res = await run_adb([step("a", "home"), step("b", "shell", {"cmd": "whoami"})], serial=SERIAL)
    assert isinstance(res, AdbRunResult) and res.ok is False and res.passed is False
    assert len(res.commands) == 2, "skip 行必须逐步骤补齐，报告不能出现空洞"
    assert {c["message"] for c in res.commands} == {"adb 不可用，全部步骤未执行"}, \
        "每行 skip 都要说真原因：adb 不可用，不是设备未连接"
    assert "adb" in (res.error or ""), "error 要带着 adb_cli 给的安装指引，用户才有的可修"


# —— shell 直发类 + 形状同构（R102） ————————————————————————————


async def test_shell_types_shape_isomorphic_with_ui_core(fake_adb) -> None:
    """shell/home/back 直发假 adb；行形状逐键同 ui_core._row_cmd（报告归位依赖它）。"""
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([
        step("s1", "shell", {"cmd": "getprop ro.product.model"}),
        step("s2", "home"),
        step("s3", "back"),
        step("s4", "kill_app", {"package": "com.example.demo"}),
        step("s5", "start_app", {"package": "com.example.demo"}),
        step("s6", "open_url", {"url": "https://example.com"}),
    ], serial=SERIAL)
    assert res.ok and res.passed, (res.error, res.commands)
    for c in res.commands:
        assert set(c) == {"id", "type", "status", "message", "elapsed_ms", "assertions", "detail"}, c
        assert c["status"] in ("pass", "fail", "error", "skip", "cancelled")
        assert isinstance(c["assertions"], list) and isinstance(c["detail"], dict)
        assert c["elapsed_ms"] >= 0
    assert by_id(res, "s1")["detail"]["rc"] == 0
    assert "Pixel" in by_id(res, "s1")["detail"]["stdout"], "getprop 的 stdout 进 detail"


async def test_shell_nonzero_exit_is_error_not_assert_fail(fake_adb) -> None:
    """shell 退出码非 0 = 没跑完（红/error），且**没有断言行**——操作类不发 fail（无期望可展示）。"""
    from app.modules.execution.adb_core import run_adb

    fake_adb.set_state({"devices": [{"serial": SERIAL, "state": "device"}],
                        "shell_rc": {"false": 1}, "file_root": str(fake_adb.file_root)})
    res = await run_adb([step("s", "shell", {"cmd": "false"})], serial=SERIAL)
    row = by_id(res, "s")
    assert row["status"] == "error", "shell 非 0 = 没执行完 = error（不是断言 fail）"
    assert row["assertions"] == [], "操作类 error 不带断言行（fail 才需要期望/实际）"


async def test_fail_fast_stops_and_skips_rest(fake_adb) -> None:
    """前一步 error → 红即停，剩余 skip（除非 optional）。"""
    from app.modules.execution.adb_core import run_adb

    fake_adb.set_state({"devices": [{"serial": SERIAL, "state": "device"}],
                        "shell_rc": {"false": 1}, "file_root": str(fake_adb.file_root)})
    res = await run_adb([step("a", "shell", {"cmd": "false"}), step("b", "home")], serial=SERIAL)
    assert by_id(res, "a")["status"] == "error"
    assert by_id(res, "b")["status"] == "skip" and "已中止" in by_id(res, "b")["message"]


# —— 控件树类：两种模式跑同一份判定（R139 的落点） ——————————————————


_TOAST_XML = (
    '<?xml version="1.0" encoding="UTF-8"?><hierarchy>'
    '<node text="已保存" resource-id="" class="android.widget.Toast" bounds="[10,10][200,80]"/>'
    '</hierarchy>'
)

# 全类型绿案要一棵树同时喂绿「常规控件」与「Toast」两族判定：拿假 adb 的默认树 + 一个 Toast
# 节点，**从默认树派生**（不是另抄一份）——默认树改了这里跟着改，不会出现「测试自己过期」。
from scripts.fake_device.fake_adb import DEFAULT_DUMP_XML  # noqa: E402

DEFAULT_XML_WITH_TOAST = DEFAULT_DUMP_XML.replace(
    "</hierarchy>",
    '<node text="已保存" resource-id="" class="android.widget.Toast" bounds="[10,10][200,80]"/>'
    "</hierarchy>",
)


async def test_click_by_text_same_verdict_in_both_modes(fake_adb_u2, monkeypatch) -> None:
    """同一棵控件树、同一步 click_by_text：u2 与 dump 两模式**结论必须一致**（共享一份判定）。

    u2 模式经注入缝的 FakeSession.click 落到坐标；dump 模式经 `uiautomator dump` + cat
    读回同一棵默认树，再从 bounds 算中心点走 input tap。两边都 pass 且 message 逐字同形
    ——「同案两结论」在结构上不可能，因为判定只有一份代码（模块头的 R139 裁定）。
    """
    from app.modules.execution import adb_u2
    from app.modules.execution.adb_core import run_adb
    from scripts.fake_device import fake_u2

    seen: list = []

    def _spy(addr, **kw):
        s = fake_u2.connect_session(addr, **kw)
        seen.append(s)
        return s

    monkeypatch.setattr(adb_u2, "connect_session", _spy)
    steps = [step("c", "click_by_text", {"text": "登录"})]

    res_u2 = await run_adb(steps, serial=SERIAL)
    assert res_u2.mode == "u2" and by_id(res_u2, "c")["status"] == "pass"
    assert seen and seen[0]._state.get("_log") == [("click", 540, 1080)], \
        "u2 模式必须点控件中心（bounds [400,1000][680,1160] → 540,1080），不是随便点一下"

    monkeypatch.setattr(adb_u2, "connect_session", lambda addr, **kw: None)  # 切 dump 模式
    res_dump = await run_adb(steps, serial=SERIAL)
    assert res_dump.mode == "dump"
    assert by_id(res_dump, "c")["status"] == "pass"
    assert by_id(res_dump, "c")["message"] == by_id(res_u2, "c")["message"]
    assert "540" in by_id(res_dump, "c")["message"]


async def test_assert_text_green_and_red_are_pass_fail(fake_adb) -> None:
    """assert_text 命中=pass、不成立=fail（橙），**不是** error；fail 带 R108 断言行。"""
    from app.modules.execution.adb_core import run_adb

    ok = await run_adb([step("t", "assert_text", {"text": "订单工作台"})], serial=SERIAL)
    assert by_id(ok, "t")["status"] == "pass" and ok.passed is True

    bad = await run_adb([step("t", "assert_text",
                              {"text": "绝不存在的文本", "timeout_ms": 600})], serial=SERIAL)
    row = by_id(bad, "t")
    assert bad.ok is True and bad.passed is False
    assert row["status"] == "fail", "断言跑成了但结论不成立 = fail，不许升级成 error"
    a = row["assertions"][0]
    assert set(a) == {"type", "passed", "expected", "actual", "error", "path"}
    assert a["type"] == "assert_text" and a["passed"] is False and a["expected"] == "绝不存在的文本"
    assert "订单工作台" in a["actual"], "actual 要显示当时屏幕上到底有什么"
    assert a["error"] is None and a["path"]


async def test_assert_element_absent_is_fail_but_bad_xpath_is_error(fake_adb) -> None:
    """控件不存在 = 判定结论 fail；XPath 语法不通 = 这步没跑成 error（两色不混）。"""
    from app.modules.execution.adb_core import run_adb

    miss = await run_adb([step("e", "assert_element",
                               {"by": "resource_id", "value": "no.such/id", "timeout_ms": 600})],
                         serial=SERIAL)
    assert by_id(miss, "e")["status"] == "fail"
    assert by_id(miss, "e")["assertions"][0]["actual"] == "未找到"

    hit = await run_adb([step("h", "assert_element", {"by": "text", "value": "登录"})],
                        serial=SERIAL)
    assert by_id(hit, "h")["status"] == "pass"

    bad = await run_adb([step("x", "assert_element",
                              {"by": "xpath", "value": "//node[[", "timeout_ms": 800})],
                        serial=SERIAL)
    assert by_id(bad, "x")["status"] == "error" and "XPath" in by_id(bad, "x")["message"]


async def test_assert_toast_reads_toast_node_and_says_unverified(fake_adb) -> None:
    """D21：注入 Toast 节点 → 解析逻辑必须抓到；抓不到时 fail 且如实写 unverified。"""
    from app.modules.execution.adb_core import run_adb

    fake_adb.set_state({"devices": [{"serial": SERIAL, "state": "device"}],
                        "dump_xml": _TOAST_XML, "file_root": str(fake_adb.file_root)})
    hit = await run_adb([step("t", "assert_toast", {"text": "已保存", "timeout_ms": 600})],
                        serial=SERIAL)
    assert by_id(hit, "t")["status"] == "pass", "fixture 注入的 Toast 节点必须被解析到"

    miss = await run_adb([step("m", "assert_toast", {"text": "别的 toast", "timeout_ms": 600})],
                         serial=SERIAL)
    row = by_id(miss, "m")
    assert row["status"] == "fail"
    assert "toast capture unverified on this platform" in row["message"], \
        "抓不到必须如实说未证实（D21），不许静默当成普通断言失败"
    assert "已保存" in row["assertions"][0]["actual"], "actual 给出当时看到的 toast 文本"


async def test_extract_ui_text_saves_var(fake_adb) -> None:
    """extract_ui_text：整树文本存进 save_var（一律 str，1B 口径）；按控件取时存该控件文本。"""
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([step("g", "extract_ui_text", {"save_var": "screen"})], serial=SERIAL)
    assert by_id(res, "g")["status"] == "pass"
    assert "订单工作台" in res.vars["screen"] and isinstance(res.vars["screen"], str)

    res2 = await run_adb([step("h", "extract_ui_text",
                               {"save_var": "title", "by": "text", "value": "登录"})], serial=SERIAL)
    assert res2.vars["title"] == "登录"


# —— 制品：失败自动截屏（D5 配额）/ 录屏成对 / push-pull-assert_file ——————


async def test_failure_auto_screenshot_and_d5_quota(fake_adb) -> None:
    """fail/error 当场取证 + 整案终态一张，共享 D5 每案 2 图硬上限；裁掉的说出口。"""
    from app.modules.execution.adb_core import run_adb

    bad = await run_adb([step("t", "assert_text", {"text": "绝无", "timeout_ms": 500})],
                        serial=SERIAL)
    shots = [a for a in bad.artifacts if a["kind"] == "SCREENSHOT"]
    assert len(shots) == 2, "失败 1 图 + 终态 1 图"
    assert shots[0]["blob"][:4] == b"\x89PNG", "bytes 通道（取证④）：必须是真 PNG"
    assert shots[0]["step_id"] == "t" and shots[0]["reason"]

    # 三处裁图点（三次可选失败各一次 + 终态）→ 超额的那张被配额裁掉，且必须在 message 说出口
    three = await run_adb([step("t1", "assert_text", {"text": "绝无A", "timeout_ms": 400}, optional=True),
                           step("t2", "assert_text", {"text": "绝无B", "timeout_ms": 400}, optional=True),
                           step("t3", "assert_text", {"text": "绝无C", "timeout_ms": 400}, optional=True)],
                          serial=SERIAL)
    assert len([a for a in three.artifacts if a["kind"] == "SCREENSHOT"]) == 2, "每案硬上限 2 图（D5）"
    joined = "；".join(str(c["message"]) for c in three.commands)
    assert "配额" in joined, "被配额裁掉的截图必须说出口，静默不截是假绿"


async def test_screen_record_pair_produces_video_artifact(fake_adb) -> None:
    """录屏成对包裹（取证⑥）：start → 动作 → stop 产出 VIDEO 制品；save_var 落制品序号。"""
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([
        step("r1", "screen_record_start", {"max_s": 5}),
        step("m", "shell", {"cmd": "getprop ro.product.model"}),
        step("r2", "screen_record_stop", {"save_var": "vid"}),
    ], serial=SERIAL)
    assert res.ok and res.passed, (res.error, res.commands)
    videos = [a for a in res.artifacts if a["kind"] == "VIDEO"]
    assert len(videos) == 1 and len(videos[0]["blob"]) > 1000, "录屏必须真字节（取证⑥）"
    assert res.vars["vid"] == "artifact#1", "save_var 存制品序号，报告页据此跳转"
    assert by_id(res, "r1")["status"] == "pass" and by_id(res, "r2")["status"] == "pass"


async def test_screen_record_pair_cleaned_up_on_fail_fast(fake_adb) -> None:
    """中途红 → 已在录的屏必须强制 finalize（不 finalize 就是一堆废 mp4 字节）。"""
    from app.modules.execution.adb_core import run_adb

    fake_adb.set_state({"devices": [{"serial": SERIAL, "state": "device"}],
                        "shell_rc": {"false": 1}, "file_root": str(fake_adb.file_root)})
    res = await run_adb([step("r1", "screen_record_start", {"max_s": 5}),
                         step("bad", "shell", {"cmd": "false"})], serial=SERIAL)
    assert by_id(res, "bad")["status"] == "error"
    assert [a for a in res.artifacts if a["kind"] == "VIDEO"], "中止路径也要收尾录屏"


async def test_file_push_pull_and_assert_file(fake_adb, tmp_path) -> None:
    """push/pull 真字节往返 + assert_file 的存在/内容包含两种判定。"""
    from app.modules.execution.adb_core import run_adb

    payload = tmp_path / "p.txt"
    payload.write_text("hello fake device 内容", encoding="utf-8")

    res = await run_adb([
        step("p", "file_push", {"local": str(payload), "remote": "/sdcard/p.txt"}),
        step("a1", "assert_file", {"remote": "/sdcard/p.txt", "contains": "fake"}),
        step("a2", "assert_file", {"remote": "/sdcard/p.txt", "contains": "绝不含此串"}, optional=True),
        step("a3", "assert_file", {"remote": "/sdcard/none.txt"}, optional=True),
        step("q", "file_pull", {"remote": "/sdcard/p.txt"}),
    ], serial=SERIAL)
    assert by_id(res, "p")["status"] == "pass", "push 必须落到假设备的文件根"
    assert by_id(res, "a1")["status"] == "pass"
    assert (fake_adb.file_root / "sdcard" / "p.txt").read_text(encoding="utf-8") == \
        "hello fake device 内容", "push 的字节要真落在设备侧"

    row = by_id(res, "a2")
    assert row["status"] == "fail" and row["assertions"][0]["passed"] is False, "内容不包含 = 判定 fail"
    absent = by_id(res, "a3")
    assert absent["status"] == "fail", "文件不存在是存在性断言的判定结论，不是 error"
    assert absent["assertions"][0]["expected"] == "文件存在"

    assert by_id(res, "q")["status"] == "pass"
    arts = [a for a in res.artifacts if str(a["reason"]).startswith("file_pull")]
    assert arts and b"hello fake device" in arts[0]["blob"], "pull 的字节走制品"


async def test_install_green_red_and_missing_apk(fake_adb, tmp_path) -> None:
    """install 的四种结局：Success=pass、拒装=error、rc=0 无成功标志=error、缺文件=error（都不是 fail）。

    假 adb 的 install 只认真字节 + 认 `Success` 那行——产品若只认退出码就报「已安装」，
    第三段会红（装失败却说成功是 §13 纪律 1 里最贵的一类假绿）。
    """
    from app.modules.execution.adb_core import run_adb

    apk = tmp_path / "demo.apk"
    apk.write_bytes(b"PK\x03\x04fake-apk-bytes")

    ok = await run_adb([step("i", "install", {"path": str(apk), "reinstall": True})], serial=SERIAL)
    assert by_id(ok, "i")["status"] == "pass", (by_id(ok, "i")["message"], by_id(ok, "i")["detail"])
    assert (fake_adb.file_root / "data" / "app" / "demo.apk").read_bytes() == apk.read_bytes(), \
        "包字节要真落到设备侧"

    fake_adb.set_state({"devices": [{"serial": SERIAL, "state": "device"}],
                        "install_fail": ["demo.apk"], "file_root": str(fake_adb.file_root)})
    bad = await run_adb([step("i", "install", {"path": str(apk)})], serial=SERIAL)
    row = by_id(bad, "i")
    assert row["status"] == "error" and "安装失败" in row["message"] and row["assertions"] == []

    # rc=0 但没有 Success 那行：只认退出码的产品会在这里假绿
    quiet = tmp_path / "quiet.apk"
    quiet.write_bytes(b"PK\x03\x04quiet")
    fake_adb.set_state({"devices": [{"serial": SERIAL, "state": "device"}],
                        "install_no_success": ["quiet.apk"], "file_root": str(fake_adb.file_root)})
    q = await run_adb([step("i", "install", {"path": str(quiet)})], serial=SERIAL)
    qrow = by_id(q, "i")
    assert qrow["detail"]["rc"] == 0, "假设备这次确实是 rc=0"
    assert qrow["status"] == "error" and "安装失败" in qrow["message"], \
        "rc=0 却无成功标志 = 不许说「已安装」"
    assert not (fake_adb.file_root / "data" / "app" / "quiet.apk").exists(), \
        "没落包却没报错，就是产品与假设备一起撒了谎"

    gone = await run_adb([step("i", "install", {"path": str(tmp_path / "nope.apk")})], serial=SERIAL)
    assert by_id(gone, "i")["status"] == "error" and "执行机上没有" in by_id(gone, "i")["message"]


async def test_screenshot_step_that_cannot_capture_says_so(fake_adb) -> None:
    """screenshot 步在配额用尽时必须是 error +「截图未成功」，不许说「已截图」。

    这是纪律 1 的那条线：截到了才叫成功。配额（D5=2 图）被前面两次可选失败吃光后，
    screenshot 步骤拿不到图——若产品把「调用过 screencap」当「截到了」，报告页就会出现
    一条没有任何现场的「已截图」（假绿，且 save_var 会指向一个不存在的制品序号）。
    """
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([
        step("f1", "assert_text", {"text": "绝无A", "timeout_ms": 300}, optional=True),
        step("f2", "assert_text", {"text": "绝无B", "timeout_ms": 300}, optional=True),
        step("s", "screenshot", {"save_var": "shot"}),
    ], serial=SERIAL)
    shots = [a for a in res.artifacts if a["kind"] == "SCREENSHOT"]
    assert len(shots) == 2, "两次失败取证已把配额用光（终态那张也会被裁掉）"
    row = by_id(res, "s")
    assert row["status"] == "error" and "截图未成功" in row["message"], \
        "没截成却报「已截图」= 对着不存在的现场报喜"
    assert "配额" in row["message"], "没截成的原因要说出口，不许只说失败"
    assert "shot" not in res.vars, "没截成就不该往 save_var 里塞一个指不到东西的序号"


async def test_two_runs_same_step_ids_do_not_share_host_temp(fake_adb, monkeypatch) -> None:
    """同一 worker 上并行跑两条用例、步骤 id 撞车（都叫 r1/q）→ 宿主临时文件不能是同一个。

    真机场景：两台设备并行，两条用例的录屏步都叫 "r1"。pull/录屏的临时路径若只用步骤 id，
    两个 run 会读写同一个 temp 文件——**把别人的录屏当成本案制品**挂进报告页，比崩掉糟得多。
    这里用 asyncio.gather 真并行跑两条同形状用例，钉两案的临时路径互不相同、字节互不污染。
    """
    import asyncio

    from app.modules.execution import adb_core
    from app.modules.execution.adb_core import run_adb

    seen: list[str] = []
    real_pull = adb_core.adb_pull

    async def spy_pull(serial, remote, local, **kw):
        seen.append(str(local))
        return await real_pull(serial, remote, local, **kw)

    monkeypatch.setattr(adb_core, "adb_pull", spy_pull)

    async def one():
        return await run_adb([
            step("r1", "screen_record_start", {"max_s": 5}),
            step("q", "file_pull", {"remote": "/sdcard/p.txt"}),
        ], serial=SERIAL)

    seed = fake_adb.file_root / "sdcard" / "p.txt"
    seed.parent.mkdir(parents=True, exist_ok=True)
    seed.write_bytes(b"share-check-bytes")
    r1, r2 = await asyncio.gather(one(), one())

    temps = [p for p in seen if "tp_pull_" in p]
    assert len(temps) == 2, "两次 pull 各要一个临时文件"
    assert temps[0] != temps[1], "同一 worker 上两个 run 不许共用一个 pull 临时文件：" + str(temps)
    v1 = [a for a in r1.artifacts if a["kind"] == "VIDEO"]
    v2 = [a for a in r2.artifacts if a["kind"] == "VIDEO"]
    assert v1 and v2, "两案都要有自己的录屏收尾（finally 的强制 finalize）"
    assert b"ftypmp42" in v1[0]["blob"] and b"ftypmp42" in v2[0]["blob"]
    assert [a for a in r1.artifacts if a["kind"] == "LOG"][0]["blob"] == b"share-check-bytes"


async def test_push_missing_local_file_is_error(fake_adb) -> None:
    """执行机上没有那个文件 = 没跑成（error），不是「推了但失败」（fail）。"""
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([step("p", "file_push",
                              {"local": "C:/no/such/file.apk", "remote": "/sdcard/x"})],
                        serial=SERIAL)
    assert by_id(res, "p")["status"] == "error" and "执行机上没有" in by_id(res, "p")["message"]


# —— 取消 / 运行超时 / 未知类型 / 变量（形状与 ui_core 同构） ————————


async def test_cancel_stops_sleep_within_one_second(fake_adb) -> None:
    """取消落在 sleep 的 500ms 切片里（§8.7 取消在步边界生效），后续步 skip。"""
    import time

    from app.modules.execution.adb_core import run_adb

    t0 = time.perf_counter()

    async def flip() -> bool:
        return time.perf_counter() - t0 > 0.6

    res = await run_adb([step("s", "sleep", {"ms": 30000}), step("n", "home")],
                        serial=SERIAL, should_cancel=flip)
    spent = time.perf_counter() - t0
    slept = by_id(res, "s")["elapsed_ms"]
    assert 300 <= slept < 2500, f"取消必须落在切片轮询里，实际睡了 {slept}ms"
    assert spent < 3.0, f"取消后整案要很快收，实际 {spent:.2f}s"
    assert by_id(res, "s")["status"] == "cancelled" and by_id(res, "n")["status"] == "skip"
    assert res.passed is False


async def test_cancel_stops_assertion_polling(fake_adb) -> None:
    """取消也必须落在断言的轮询切片里——30s 超时的断言不能把「停止」拖到超时。"""
    import time

    from app.modules.execution.adb_core import run_adb

    t0 = time.perf_counter()

    async def flip() -> bool:
        return time.perf_counter() - t0 > 0.7

    res = await run_adb([step("t", "assert_text", {"text": "绝无", "timeout_ms": 30000})],
                        serial=SERIAL, should_cancel=flip)
    assert time.perf_counter() - t0 < 3.0
    assert by_id(res, "t")["status"] == "cancelled", "轮询中被取消 = cancelled，不是 fail"


async def test_max_runtime_expires_to_skips(fake_adb) -> None:
    """撞 max_runtime_ms：本步 error + 剩余 skip + 整案 error 运行超时。"""
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([step("s", "sleep", {"ms": 8000}), step("n", "home")],
                        serial=SERIAL, max_runtime_ms=800)
    assert res.ok is True and res.error and "运行超时" in res.error
    assert by_id(res, "n")["status"] == "skip" and "运行超时" in by_id(res, "n")["message"]
    assert res.passed is False


async def test_unknown_type_and_malformed_step_are_error(fake_adb) -> None:
    """未知类型 / 非对象步骤：error 且点名，绝不 KeyError、绝不静默跳过。"""
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([step("u", "teleport"), "不是对象"], serial=SERIAL)
    assert by_id(res, "u")["status"] == "error" and "未知步骤类型" in by_id(res, "u")["message"]
    assert res.commands[1]["status"] == "error" and "JSON 对象" in res.commands[1]["message"]


async def test_missing_variable_is_error_not_crash(fake_adb) -> None:
    """${var} 未定义 = 快败转 error 行（同 run_api/run_ui 口径），不抛穿。"""
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([step("s", "shell", {"cmd": "echo ${nope}"})], serial=SERIAL)
    assert by_id(res, "s")["status"] == "error" and "未定义变量" in by_id(res, "s")["message"]


async def test_vars_render_into_shell(fake_adb) -> None:
    """变量渲染是真的：${pkg} 渲染后才进 shell argv（渲染没生效的话假 adb 会认不出命令）。"""
    from app.modules.execution.adb_core import run_adb

    fake_adb.set_state({"devices": [{"serial": SERIAL, "state": "device"}],
                        "shell_rc": {"am force-stop com.wrong.pkg": 1},
                        "file_root": str(fake_adb.file_root)})
    ok = await run_adb([step("s", "shell", {"cmd": "am force-stop ${pkg}"})],
                       serial=SERIAL, variables={"pkg": "com.example.demo"})
    assert by_id(ok, "s")["status"] == "pass", "${pkg} 要真渲染进 argv"
    bad = await run_adb([step("s", "shell", {"cmd": "am force-stop com.wrong.pkg"})],
                        serial=SERIAL)
    assert by_id(bad, "s")["status"] == "error", "假 adb 对 rc=1 的命令确实会报错（钉子不是空转）"


async def test_pre_wait_ms_runs_before_step(fake_adb) -> None:
    """pre_wait_ms（§7.3 步骤级预等待）真等，且计入本步耗时。"""
    from app.modules.execution.adb_core import run_adb

    res = await run_adb([step("s", "home", pre_wait_ms=400)], serial=SERIAL)
    assert by_id(res, "s")["status"] == "pass"
    assert by_id(res, "s")["elapsed_ms"] >= 380


async def test_every_step_type_is_executed_not_staged(fake_adb, tmp_path) -> None:
    """§7.3 的 26 种**每种都要有实现，且每种都能跑到 pass**：跑一遍全类型绿案。

    计划 T6 写的是「26 步型执行」，不是「挑几个好做的做」。按 commands.STEP_TYPES 全集驱动
    （表加一种而这里没配 → 红；执行核漏一种 → 那步 error），每型一份能跑通的最小配置。
    """
    from app.modules.adb_test.commands import STEP_TYPES  # 测试可跨模块，产品代码不行
    from app.modules.execution.adb_core import run_adb

    apk = tmp_path / "demo.apk"
    apk.write_bytes(b"PK\x03\x04fake-apk")
    payload = tmp_path / "seed.txt"
    payload.write_text("seed 内容 可断言", encoding="utf-8")
    # 一棵树同时喂绿所有控件树类判定：常规控件 + 一个 Toast 节点。
    fake_adb.set_state({"devices": [{"serial": SERIAL, "state": "device"}],
                        "file_root": str(fake_adb.file_root),
                        "dump_xml": DEFAULT_XML_WITH_TOAST})

    cfg: dict[str, dict] = {
        "connect": {"addr": SERIAL},
        "shell": {"cmd": "getprop ro.product.model"},
        "install": {"path": str(apk), "reinstall": True},
        "uninstall": {"package": "com.example.demo"},
        "start_app": {"package": "com.example.demo", "activity": ".MainActivity"},
        "kill_app": {"package": "com.example.demo"},
        "open_url": {"url": "https://example.com/x"},
        "click_xy": {"x": 100, "y": 200},
        "long_click": {"x": 100, "y": 200},
        "swipe": {"x1": 100, "y1": 1200, "x2": 100, "y2": 400, "duration_ms": 120},
        "input_text": {"text": "hello"},
        "click_by_text": {"text": "登录"},
        "click_by_xpath": {"xpath": ".//node[@resource-id='com.example.demo:id/btn_login']"},
        "assert_text": {"text": "订单工作台"},
        "assert_element": {"by": "resource_id", "value": "com.example.demo:id/title"},
        "assert_toast": {"text": "已保存", "timeout_ms": 800},
        "screenshot": {"save_var": "shot"},
        "screen_record_start": {"max_s": 5},
        "screen_record_stop": {"save_var": "vid"},
        "sleep": {"ms": 50},
        "file_push": {"local": str(payload), "remote": "/sdcard/seed.txt"},
        "file_pull": {"remote": "/sdcard/seed.txt"},
        "assert_file": {"remote": "/sdcard/seed.txt", "contains": "可断言"},
        "back": {},
        "home": {},
        "extract_ui_text": {"save_var": "title", "by": "text", "value": "登录"},
    }
    assert set(cfg) == set(STEP_TYPES) and len(STEP_TYPES) == 26, \
        "参数表与 commands.STEP_TYPES 必须一一对应（谁漏了一种都该在这里红）"

    res = await run_adb([step(t, t, cfg[t]) for t in STEP_TYPES], serial=SERIAL)

    by_type = {c["type"]: c for c in res.commands}
    assert set(by_type) == set(STEP_TYPES)
    unimplemented = {t: by_type[t]["message"] for t in STEP_TYPES
                     if by_type[t]["status"] != "pass"
                     and ("未知步骤类型" in str(by_type[t]["message"])
                          or "未实现" in str(by_type[t]["message"]))}
    assert not unimplemented, "有步骤类型没实现，只留了个壳： " + str(unimplemented)
    bad = {t: (by_type[t]["status"], by_type[t]["message"]) for t in STEP_TYPES
           if by_type[t]["status"] != "pass"}
    assert not bad, "全类型绿案里有步不绿： " + str(bad)
    assert res.ok and res.passed, (res.error, res.commands)
    # 每型都真做了事：制品/变量是「动作发生了」的物证，不是 message 里的一句话
    assert {a["kind"] for a in res.artifacts} == {"SCREENSHOT", "VIDEO", "LOG"}, \
        "截图/录屏/pull 三种制品都要真出现"
    assert res.vars["title"] == "登录" and res.vars["vid"].startswith("artifact#")
    assert res.vars["shot"].startswith("artifact#"), "screenshot 的 save_var 给制品序号"


# —— 契约 4：源码扫描（照 test_ui_core.py:331 的手法） ——————————————


def test_adb_core_is_contract4_clean() -> None:
    import ast
    import re

    import app.modules.execution.adb_core as adb_core

    src = Path(adb_core.__file__).read_text(encoding="utf-8")
    # 契约 4 禁的是「跨领域模块」：execution 包内互引（adb_cli/adb_u2）是既有先例
    # （artifacts.py 也 import app.modules.execution.models），所以逐 app.modules.<X> 看 X。
    cross = re.findall(r"app\.modules\.(?!execution\b)[A-Za-z_][A-Za-z0-9_]*", src)
    assert not cross, "执行核不得 import 其它领域模块（契约 4）：" + str(sorted(set(cross)))
    assert "from app.shared" in src, "共用件（vars.render）走 shared，不算跨模块"
    tree = ast.parse(src)
    top = {n.module or "" for n in tree.body if isinstance(n, ast.ImportFrom)}
    top |= {a.name for n in tree.body if isinstance(n, ast.Import) for a in n.names}
    assert not any("uiautomator2" in m for m in top), \
        "uiautomator2 必须惰性 import（R95）：没装它的机器要照样能起后端"

    from app.modules.execution import adb_u2

    u2_src = Path(adb_u2.__file__).read_text(encoding="utf-8")
    assert "import uiautomator2" in u2_src, "包装层必须真的用 u2，否则控件树是空壳"
    nested = [n for f in ast.walk(ast.parse(u2_src))
              if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef))
              for n in ast.walk(f) if isinstance(n, (ast.Import, ast.ImportFrom))]
    assert any("uiautomator2" in (getattr(n, "module", None) or "")
               or any("uiautomator2" in a.name for a in getattr(n, "names", [])) for n in nested), \
        "uiautomator2 必须在函数体内 import，否则「惰性」是假的"


def test_u2_absent_machine_still_downgrades(monkeypatch) -> None:
    """没装 uiautomator2 的机器：connect_session 返回 None（不抛）→ 执行核照样走 dump。"""
    import builtins

    from app.modules.execution import adb_u2

    real_import = builtins.__import__

    def _no_u2(name, *a, **kw):
        if name == "uiautomator2":
            raise ImportError("no uiautomator2 on this box")
        return real_import(name, *a, **kw)

    monkeypatch.setattr(builtins, "__import__", _no_u2)
    assert adb_u2.connect_session("127.0.0.1:5555") is None
