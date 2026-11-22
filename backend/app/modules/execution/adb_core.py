"""ADB 执行核（1D T6，§6.4/§7.3/§8.7）：CLI + uiautomator2 驱动，纯引擎无 DB，异常归一不抛。

与 `ui_core.py` 同层同构（R102 报告归位依赖两条命令流的行形状一致）：
`{id,type,status(pass|fail|error|skip|cancelled),message,elapsed_ms,assertions[],detail{}}`。
驱动器**不认识资产**——步骤列表与设备 serial 由调用方（T7 的 `_execute_adb_run`）解析后传入。

四条这里特有的铁律：
- **建连阶段决定模式（R139/前置取证③）**：u2 与 `uiautomator dump` 互斥（u2 instrumentation
  在跑时 dump 一律 137），所以「u2 or dump 轮询」在开始时定一次、整案不变。降级必须
  看得见：`result.mode` 进 run 详情，「慢但可用」不是「悄悄换」。
- **两种模式同一份判定**：控件树类步骤全部在 hierarchy XML 上求值（`_Tree`），u2 与 dump
  只是取树方式不同——同一棵树上不可能跑出两种结论（ui_core 模块头的同款事故）。
- **契约 4**：零领域模块 import（execution 包内互引例外，同 artifacts.py 先例）；
  uiautomator2 的 import 藏在 `adb_u2.connect_session` 函数体（R95）。
- **fail ≠ error**：断言跑成了但结论不成立 = fail；这一步没能执行完（设备断连、dump 起不来、
  超时）= error。两色在报告页是不同处置动作。
"""
from __future__ import annotations

import asyncio
import re
import shlex
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from tempfile import gettempdir
from typing import Any
from uuid import uuid4
from xml.etree import ElementTree

from app.modules.execution import adb_u2
from app.modules.execution.adb_cli import (
    adb_connect,
    adb_executable,
    adb_install,
    adb_pull,
    adb_push,
    adb_screencap,
    adb_shell,
    adb_shell_spawn,
)
from app.shared.vars import MissingVar, render

# 取消检查粒度：与 ui_core/h_sleep 同值同意（500ms 切片 + deadline）。
SLEEP_SLICE_MS = 500
# D5 同款每案截图配额（失败自动截屏 + 显式 screenshot 命令 + 终态一张，共享配额；
# 裁掉的不截但要在 message 说出口，静默不截是假绿）。
MAX_SHOTS_PER_CASE = 2
# dump 轮询的远端落点（取证③：dump 写文件 + cat 读回，两步都是 list-form）
_DUMP_REMOTE = "/sdcard/tp_window_dump.xml"
_RECORD_REMOTE = "/sdcard/tp_record.mp4"
_RECORD_DEFAULT_MAX_S = 180
_TOAST_CLASS = "android.widget.Toast"
_BOUNDS_RE = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")


@dataclass
class AdbRunResult:
    """整案结论。ok=设备连上了且执行窗口 opened；passed=断言全过——两层不能互推。

    mode：建连阶段定的执行模式（"u2" | "dump"，没连上= None）。T7 必须把它写进 run
    详情——降级不可见就是 §13 纪律 1 的违例。
    """

    ok: bool
    passed: bool
    mode: str | None = None
    commands: list[dict] = field(default_factory=list)
    vars: dict[str, str] = field(default_factory=dict)
    error: str | None = None
    artifacts: list[dict] = field(default_factory=list)  # [{kind, blob, step_id, reason}]


class _Cancelled(Exception):
    """切片轮询到取消旗标：异常穿透，主循环把该行记成 cancelled。"""


class _DeadlineHit(Exception):
    """sleep/轮询撞到 max_runtime_ms：主循环记 error + 后续 skip + 整案运行超时。"""


def _short(text: Any, limit: int = 200) -> str:
    s = text if isinstance(text, str) else str(text)
    return s if len(s) <= limit else s[:limit] + "…(截断)"


def _row(a_type: str, passed: bool, expected: Any, actual: Any,
         error: str | None, path: str) -> dict:
    """断言行逐键同 shared/assertions._row / ui_core._row（R108），禁止手搓字典。"""
    return {"type": a_type, "passed": passed, "expected": expected,
            "actual": actual, "error": error, "path": path}


def _row_cmd(step: Any, status: str, message: str | None, elapsed_ms: int) -> dict:
    sid = step.get("id") if isinstance(step, Mapping) else None
    typ = step.get("type") if isinstance(step, Mapping) else None
    return {"id": sid if isinstance(sid, str) else str(sid), "type": typ, "status": status,
            "message": message, "elapsed_ms": elapsed_ms, "assertions": [], "detail": {}}


def artifact_var(result: AdbRunResult) -> str:
    """screenshot/screen_record_stop 的 save_var 落值：`artifact#N`（N=本案制品清单里的序号，1 起）。

    T3 协议在这两步给了 save_var，忽略它就是「界面能配、执行没反应」的假字段。存**制品序号**
    而不是文件路径：字节此刻还在内存，落盘由 T7 的 persist 按同一顺序写库，变量与制品行
    天然对得上号；报告页拿 `artifact#2` 能跳第 2 件制品。
    """
    return "artifact#" + str(len(result.artifacts))


def _cfg_of(step: Mapping, variables: dict[str, str]) -> tuple[dict, str | None]:
    """config 里的字符串值逐个 ${var} 渲染；未定义变量 → (原样, 错误) 转 error 行。"""
    raw = step.get("config")
    cfg = dict(raw) if isinstance(raw, Mapping) else {}
    for k, v in cfg.items():
        if isinstance(v, str):
            try:
                cfg[k] = render(v, variables)
            except MissingVar as e:
                return cfg, str(e)
    return cfg, None


def _ms(v: Any, default: int) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else default


class _Tree:
    """一次控件树快照（u2.dump_hierarchy 与 dump 轮询共用）：节点匹配只在 XML 上做一次。

    匹配语义单点在这棵树里——两种取树模式共享同一判定，「同案两结论」在结构上不可能。
    """

    __slots__ = ("root",)

    def __init__(self, xml: str) -> None:
        self.root = ElementTree.fromstring(xml)

    def nodes(self) -> list[ElementTree.Element]:
        return list(self.root.iter("node"))

    def find(self, by: str, value: str) -> ElementTree.Element | None:
        if by == "xpath":
            try:
                hits = self.root.findall(value)
            except SyntaxError as e:
                raise ValueError("XPath 语法不被支持：" + str(e)) from e
            return hits[0] if hits else None
        exact = None
        loose = None
        for n in self.nodes():
            if by == "resource_id":
                if n.get("resource-id") == value:
                    return n
            else:  # text：先精确后包含（点「登录」不该点到「登录说明」）
                t = n.get("text") or ""
                if t == value and exact is None:
                    exact = n
                elif value in t and loose is None:
                    loose = n
        # 显式 is-not-None，不写 `exact or loose`：Element 的真值历史上按子节点数算
        # （命中的**叶子**节点一度是 falsy），命中却返回 None 是最难查的一类假失败。
        return loose if exact is None else exact

    def all_text(self) -> str:
        return "\n".join(n.get("text") or "" for n in self.nodes() if n.get("text"))

    def toasts(self) -> list[str]:
        return [n.get("text") or "" for n in self.nodes() if n.get("class") == _TOAST_CLASS]


def _center(node: ElementTree.Element) -> tuple[int, int] | None:
    m = _BOUNDS_RE.fullmatch(node.get("bounds") or "")
    if m is None:
        return None
    x1, y1, x2, y2 = (int(x) for x in m.groups())
    return ((x1 + x2) // 2, (y1 + y2) // 2)


async def run_adb(steps: list[dict], *, serial: str,
                  variables: dict[str, str] | None = None,
                  timeout_ms: int = 10_000, max_runtime_ms: int | None = None,
                  should_cancel: Callable[[], Awaitable[bool]] | None = None) -> AdbRunResult:
    """跑一条 ADB 用例（§7.3 扁平步骤列表）。一切失败归一进行结果，不抛穿（同 run_ui）。

    serial 由调用方解析（步骤级 device 覆盖也在调用方折好）；should_cancel 是异步探测，
    每条步骤前、sleep 与断言轮询的每个切片后被查询（§8.7 取消在步边界生效）。
    """
    result = AdbRunResult(ok=False, passed=False,
                          vars={str(k): str(v) for k, v in (variables or {}).items()})
    vars_: dict[str, str] = result.vars
    # 宿主临时文件必须带本案唯一号：录屏/pull 的落点若只用步骤 id（两条用例都叫 "r1" 很常见），
    # 同一台 worker 上并行跑的两个 run 会写同一个 temp 文件——**把别人的录屏当成本案制品**
    # 比崩掉糟得多（报告页挂着别的设备的现场）。设备侧不会撞（同设备由 T5 的锁串行）。
    run_tag = uuid4().hex[:10]
    deadline = None if max_runtime_ms is None else time.perf_counter() + max_runtime_ms / 1000
    budget = {"shot": MAX_SHOTS_PER_CASE}
    overflow: list[str] = []
    session: Any = None
    recording: dict[str, Any] | None = None  # {proc, opened_by}

    async def cancelled() -> bool:
        return False if should_cancel is None else await should_cancel()

    async def check_bounds() -> None:
        if deadline is not None and time.perf_counter() >= deadline:
            raise _DeadlineHit
        if await cancelled():
            raise _Cancelled

    async def capture(step_id: str, reason: str) -> str | None:
        """失败/显式截图：bytes 走 exec-out 通道（取证④），D5 配额，裁掉记账说出口。

        返回 None = 截到了；返回人话原因 = 没截到（配额用完 / 设备截不出）。screenshot
        命令据此说话，截到了才敢说「已截图」（§13 纪律 1：不许对着没截成的现场报喜）。
        配额**按尝试扣、失败不退**（ui_core 同款）：设备截不出图时退款会让每个失败步骤
        都再等一次 screencap 的超时。
        """
        if budget["shot"] <= 0:
            why = "因每案制品配额（" + str(MAX_SHOTS_PER_CASE) + " 图）未采集"
            overflow.append(step_id + ": " + reason + why)
            return "每案制品配额（" + str(MAX_SHOTS_PER_CASE) + " 图）已用尽"
        budget["shot"] -= 1
        shot = await adb_screencap(serial)
        if shot.ok and shot.out[:4] == b"\x89PNG":
            result.artifacts.append({"kind": "SCREENSHOT", "blob": shot.out,
                                     "step_id": step_id, "reason": reason})
            return None
        why = "失败（" + _short(shot.error or "返回的不是 PNG", 120) + "）"
        overflow.append(step_id + ": " + reason + why)
        return "截图" + why

    async def hierarchy() -> str:
        """取一棵控件树：u2 模式一次 RPC；dump 模式 dump 落盘 + cat 读回（取证③）。"""
        if session is not None:
            return await asyncio.to_thread(session.dump_hierarchy)
        d = await adb_shell(serial, ["uiautomator", "dump", _DUMP_REMOTE])
        if not d.ok:
            raise RuntimeError("uiautomator dump 失败（rc=" + str(d.rc) + "）："
                               + _short(d.error or d.text, 150)
                               + ("；dump 与 uiautomator2 互斥（取证③），本案已在降级模式，"
                                  "多半是有别的 u2 会话占着设备" if d.rc == 137 else ""))
        c = await adb_shell(serial, ["cat", _DUMP_REMOTE])
        if not c.ok:
            raise RuntimeError("读不回 dump 文件：" + _short(c.error or c.text, 150))
        return c.text

    async def tap(x: int, y: int) -> None:
        if session is not None:
            await asyncio.to_thread(session.click, x, y)
        else:
            r = await adb_shell(serial, ["input", "tap", str(x), str(y)])
            if not r.ok:
                raise RuntimeError("input tap 失败：" + _short(r.error or r.text, 120))

    async def tap_node(node: ElementTree.Element, label: str) -> str:
        c = _center(node)
        if c is None:
            raise RuntimeError(label + " 的 bounds 解析不出中心点（" + repr(node.get("bounds")) + "）")
        await tap(*c)
        return "点击 (" + str(c[0]) + "," + str(c[1]) + ") —— " + label

    async def poll_tree(window_ms: int, probe):
        """断言/找控件的轮询：每轮取树 → probe(tree) 真即返回；切片边界查取消/deadline。"""
        end = time.perf_counter() + max(1, window_ms) / 1000
        while True:
            await check_bounds()
            tree = _Tree(await hierarchy())
            hit = probe(tree)
            if hit is not None:
                return tree, hit
            now = time.perf_counter()
            if now >= end:
                return tree, None
            await asyncio.sleep(min(0.5, end - now))

    async def finalize_recording(step_id: str | None, reason: str) -> dict | None:
        """收尾录屏：pkill -2（SIGINT 才 finalize，取证⑥）→ 收尸 → pull 成制品字节。"""
        nonlocal recording
        if recording is None:
            return None
        proc, opener = recording["proc"], recording["opened_by"]
        recording = None
        await adb_shell(serial, ["pkill", "-2", "screenrecord"])
        try:  # 收尸不许拖死整案：SIGINT 后设备端收尾通常 <2s
            await asyncio.wait_for(proc.wait(), timeout=10)
        except TimeoutError:
            proc.kill()
        local = Path(gettempdir()) / ("tp_record_" + run_tag + ".mp4")
        p = await adb_pull(serial, _RECORD_REMOTE, str(local))
        if not p.ok or not local.is_file():
            overflow.append((step_id or opener) + ": 录屏文件拉不回（" + _short(p.error, 120) + "）")
            return None
        blob = local.read_bytes()
        local.unlink(missing_ok=True)
        art = {"kind": "VIDEO", "blob": blob, "step_id": step_id or opener, "reason": reason}
        result.artifacts.append(art)
        return art

    async def exec_one(step: Mapping, row: dict) -> str:
        nonlocal recording  # 录屏状态是「跨步骤」的：start 写、stop/中止路径读
        t = step.get("type")
        cfg, err = _cfg_of(step, vars_)
        if err is not None:
            row["status"] = "error"
            return err
        window = _ms(cfg.get("timeout_ms"), timeout_ms)

        # —— 设备/包/应用（shell 直发类）——
        if t == "connect":
            # 与 ui_core 的 open 同款：连不上 = 这步没执行完 = error（处置动作是「修设备/配置」，
            # 不是「看断言」）。操作类一律不发 fail——没有断言行可展示，红行会渲染成「期望 null」。
            addr = str(cfg.get("addr") or "")
            r = await adb_connect(addr)
            if r.timed_out:
                row["status"] = "error"
                return "连接 " + addr + " 超时"
            if not r.ok:
                row["status"] = "error"
                return "连接 " + addr + " 失败：" + _short(r.error or r.text, 150)
            return "已连接 " + addr
        if t == "shell":
            try:
                args = shlex.split(str(cfg.get("cmd") or ""))
            except ValueError as e:
                row["status"] = "error"
                return "shell 命令解析失败：" + str(e)
            if not args:
                row["status"] = "error"
                return "shell 命令是空的"
            r = await adb_shell(serial, args)
            row["detail"] = {"rc": r.rc, "stdout": _short(r.text, 500), "stderr": _short(r.error, 300)}
            if r.timed_out:
                row["status"] = "error"
                return "shell 超时（没跑完就是没跑完，不算判定）"
            if r.rc != 0:
                row["status"] = "error"  # 操作类没有断言行可展示「期望/实际」，一律 error（见模块头）
                return "shell 退出码 " + str(r.rc) + "：" + _short(r.error or r.text, 150)
            return "shell 完成（rc=0）" + (" → " + _short(r.text, 80) if r.text.strip() else "")
        if t == "install":
            local = str(cfg.get("path") or "")
            if not Path(local).is_file():
                row["status"] = "error"
                return "安装失败：执行机上没有 " + repr(local) + "（APK 路径由 worker 主机解析）"
            r = await adb_install(serial, local, reinstall=bool(cfg.get("reinstall")))
            row["detail"] = {"rc": r.rc, "stdout": _short(r.text, 300)}
            if not r.ok or "Success" not in r.text:
                row["status"] = "error"
                return "安装失败：" + _short(r.text or r.error, 150)
            return "已安装 " + local
        if t == "uninstall":
            r = await adb_shell(serial, ["pm", "uninstall", str(cfg.get("package"))])
            if r.timed_out:
                row["status"] = "error"
                return "卸载超时"
            if not r.ok:
                row["status"] = "error"
                return "卸载失败：" + _short(r.text or r.error, 150)
            return "已卸载 " + str(cfg.get("package"))
        if t in ("start_app", "kill_app"):
            pkg = str(cfg.get("package"))
            if t == "kill_app":
                args = ["am", "force-stop", pkg]
            elif cfg.get("activity"):
                args = ["am", "start", "-n", pkg + "/" + str(cfg["activity"])]
            else:
                args = ["monkey", "-p", pkg, "1"]  # 无入口 activity 时的官方冷启动路
            r = await adb_shell(serial, args)
            if not r.ok:
                row["status"] = "error"
                return ("启动" if t == "start_app" else "杀掉") + " " + pkg + " 失败：" \
                    + _short(r.text or r.error, 150)
            return ("已启动 " + pkg + ("（" + str(cfg.get("activity")) + "）" if cfg.get("activity") else "")
                    if t == "start_app" else "已杀掉 " + pkg)
        if t == "open_url":  # 取证⑫：am start VIEW intent，CLI 不走 u2
            r = await adb_shell(serial, ["am", "start", "-a", "android.intent.action.VIEW",
                                         "-d", str(cfg.get("url"))])
            if not r.ok:
                row["status"] = "error"
                return "打开链接失败：" + _short(r.text or r.error, 150)
            return "已打开 " + str(cfg.get("url"))

        # —— 坐标/输入类（D13：纯坐标走 adb shell input，两种模式同路）——
        if t == "click_xy":
            await tap(int(cfg["x"]), int(cfg["y"]))
            return "点击 (" + str(cfg["x"]) + "," + str(cfg["y"]) + ")"
        if t == "long_click":
            r = await adb_shell(serial, ["input", "swipe", str(cfg["x"]), str(cfg["y"]),
                                         str(cfg["x"]), str(cfg["y"]), "800"])
            if not r.ok:
                row["status"] = "error"
                return "长按失败：" + _short(r.error or r.text, 120)
            return "长按 (" + str(cfg["x"]) + "," + str(cfg["y"]) + ")"
        if t == "swipe":
            r = await adb_shell(serial, ["input", "swipe", str(cfg["x1"]), str(cfg["y1"]),
                                         str(cfg["x2"]), str(cfg["y2"]),
                                         str(_ms(cfg.get("duration_ms"), 300))])
            if not r.ok:
                row["status"] = "error"
                return "滑动失败：" + _short(r.error or r.text, 120)
            return "滑动 (" + str(cfg["x1"]) + "," + str(cfg["y1"]) + ")→(" \
                + str(cfg["x2"]) + "," + str(cfg["y2"]) + ")"
        if t == "input_text":
            r = await adb_shell(serial, ["input", "text",
                                         str(cfg.get("text") or "").replace(" ", "%s")])
            if not r.ok:
                row["status"] = "error"
                return "输入失败：" + _short(r.error or r.text, 120)
            return "输入 " + repr(_short(str(cfg.get("text")), 40))
        if t in ("back", "home"):
            r = await adb_shell(serial, ["input", "keyevent", "4" if t == "back" else "KEYCODE_HOME"])
            if not r.ok:
                row["status"] = "error"
                return ("返回键" if t == "back" else "Home 键") + "失败：" + _short(r.error or r.text, 120)
            return "返回键" if t == "back" else "Home 键"

        # —— 控件树类（建连阶段定的模式取树，同一份 _Tree 判定）——
        if t in ("click_by_text", "click_by_xpath"):
            by = "text" if t == "click_by_text" else "xpath"
            value = str(cfg.get("text") if t == "click_by_text" else cfg.get("xpath"))
            try:
                _, node = await poll_tree(window,
                                          lambda tr: tr.find(by, value))
            except ValueError as e:  # XPath 语法错 = 这步没跑成
                row["status"] = "error"
                return str(e)
            if node is None:
                row["status"] = "error"  # 点了没点上 = 没执行完（断言没这说，操作是操作）
                return "等 " + repr(_short(value, 40)) + " 出现并点击，超时 " \
                    + str(max(1, window // 1000)) + "s 没找到"
            return await tap_node(node, repr(_short(value, 40)))
        if t == "assert_text":
            want = str(cfg.get("text"))
            equals = cfg.get("mode") == "equals"
            tree, hit = await poll_tree(window, lambda tr: tr
                                        if (tr.all_text() == want if equals
                                            else want in tr.all_text()) else None)
            passed = hit is not None
            # actual 取**最后一次**快照：判定不成立时报告要显示「当时屏幕上到底有什么」
            row["assertions"] = [_row("assert_text", passed, want, _short(tree.all_text(), 200),
                                      None, "控件树文本")]
            row["status"] = "pass" if passed else "fail"
            return "界面文本" + ("含" if passed else "不含") + " " + repr(_short(want, 40))
        if t == "assert_element":
            by, value = str(cfg.get("by")), str(cfg.get("value"))
            try:
                _, node = await poll_tree(window, lambda tr: tr.find(by, value))
            except ValueError as e:
                row["status"] = "error"
                return str(e)
            row["assertions"] = [_row("assert_element", node is not None,
                                      value, "存在" if node is not None else "未找到", None,
                                      by + ":" + value)]
            row["status"] = "pass" if node is not None else "fail"
            return "控件 " + repr(_short(value, 40)) + (" 在" if node is not None else " 不在")
        if t == "assert_toast":  # D21：轮询控件树找 Toast 节点；u2 3.x toast RPC 已被移除，不许走
            want = str(cfg.get("text"))
            tree, hit = await poll_tree(window,
                                        lambda tr: next((x for x in tr.toasts() if want in x), None))
            passed = hit is not None
            row["assertions"] = [_row("assert_toast", passed, want,
                                      hit if passed else "；".join(tree.toasts()) or "超时窗口内无 Toast 节点",
                                      None, "控件树轮询（D21）")]
            row["status"] = "pass" if passed else "fail"
            if passed:
                return "抓到 Toast " + repr(_short(want, 40))
            return ("没抓到 Toast " + repr(_short(want, 40))
                    + "（toast capture unverified on this platform：Android 12+ 后台 toast "
                    "限制，D21 真机行为待业主设备验证）")
        if t == "extract_ui_text":
            tree = _Tree(await hierarchy())
            if cfg.get("by"):
                node = tree.find(str(cfg["by"]), str(cfg.get("value")))
                got = (node.get("text") or "") if node is not None else None
                if got is None:
                    row["assertions"] = [_row("extract_ui_text", False, str(cfg.get("value")),
                                              "未找到", None, str(cfg["by"]))]
                    row["status"] = "fail"
                    return "提取失败：没找到控件 " + repr(_short(str(cfg.get("value")), 40))
            else:
                got = tree.all_text()
            sv = str(cfg.get("save_var"))
            vars_[sv] = got
            return "提取文本 → ${" + sv + "}（" + str(len(got)) + " 字符）"

        # —— 制品类 ——
        if t == "screenshot":
            why = await capture(row["id"], "screenshot 命令")
            if why is not None:
                row["status"] = "error"  # 截到了才叫截图成功；没截成不许报喜
                return "截图未成功：" + why
            save_var = cfg.get("save_var")
            if isinstance(save_var, str) and save_var:  # T3 协议里 screenshot 有 save_var，必须给真值
                vars_[save_var] = artifact_var(result)
            return "已截图"
        if t == "screen_record_start":
            if recording is not None:
                row["status"] = "error"
                return "已经在录了（保存期应拦未配对的 start，T3；执行核仍防御）"
            try:
                proc = await adb_shell_spawn(serial, ["screenrecord", "--time-limit",
                                                      str(_ms(cfg.get("max_s"), _RECORD_DEFAULT_MAX_S)),
                                                      _RECORD_REMOTE])
            except (RuntimeError, FileNotFoundError) as e:
                row["status"] = "error"
                return "录屏起不来：" + _short(str(e), 150)
            recording = {"proc": proc, "opened_by": row["id"]}
            return "录屏已开始（收尾在「结束录屏」：pkill -2 finalize + pull，取证⑥）"
        if t == "screen_record_stop":
            if recording is None:
                row["status"] = "error"
                return "没有在录的屏（保存期应拦孤儿 stop，T3；执行核仍防御）"
            art = await finalize_recording(row["id"], "整案录屏（§6.4 起止包裹）")
            if art is None:
                row["status"] = "error"
                return "录屏收尾失败：文件没拉回来（见制品提示）"
            save_var = cfg.get("save_var")
            if isinstance(save_var, str) and save_var:
                vars_[save_var] = artifact_var(result)
            return "录屏已收尾 → 制品 VIDEO（" + str(len(art["blob"])) + " 字节）"
        if t == "file_push":
            local, remote = str(cfg.get("local")), str(cfg.get("remote"))
            if not Path(local).is_file():
                row["status"] = "error"
                return "推送失败：执行机上没有 " + repr(local)
            r = await adb_push(serial, local, remote)
            if not r.ok:
                row["status"] = "error"
                return "推送 " + remote + " 失败：" + _short(r.text or r.error, 150)
            return "已推送 " + local + " → " + remote
        if t == "file_pull":
            remote = str(cfg.get("remote"))
            local = str(cfg.get("local") or Path(gettempdir()) / ("tp_pull_" + run_tag + "_" + row["id"]))
            r = await adb_pull(serial, remote, local)
            if not r.ok or not Path(local).is_file():
                row["status"] = "error"
                return "拉取 " + remote + " 失败：" + _short(r.text or r.error, 150)
            blob = Path(local).read_bytes()
            art_kind = "VIDEO" if blob[4:8] == b"ftyp" else "LOG"
            result.artifacts.append({"kind": art_kind, "blob": blob, "step_id": row["id"],
                                     "reason": "file_pull " + remote})
            if not cfg.get("local"):
                Path(local).unlink(missing_ok=True)  # 未指名本地路径 = 走制品，不留临时文件
            return "已拉取 " + remote + "（" + str(len(blob)) + " 字节 → 制品）"
        if t == "assert_file":
            remote = str(cfg.get("remote"))
            r = await adb_shell(serial, ["cat", remote])
            if not r.ok:
                row["assertions"] = [_row("assert_file", False, "文件存在",
                                          "不存在或读不出", None, remote)]
                row["status"] = "fail"
                return "文件 " + remote + " 不存在/读不出"
            body = r.text
            contains = cfg.get("contains")
            passed = contains is None or str(contains) in body
            row["assertions"] = [_row("assert_file", bool(passed),
                                      contains if contains is not None else "文件存在",
                                      _short(body, 120), None, remote)]
            row["status"] = "pass" if passed else "fail"
            return "文件 " + remote + (" 含 " + repr(_short(str(contains), 40))
                                       if contains is not None else " 存在")
        if t == "sleep":
            left = _ms(cfg.get("ms"), 0)
            while True:
                await check_bounds()
                if left <= 0:
                    break
                piece = min(left, SLEEP_SLICE_MS)
                await asyncio.sleep(piece / 1000.0)
                left -= piece
            return "等待 " + str(_ms(cfg.get("ms"), 0)) + "ms"

        row["status"] = "error"
        return "未知步骤类型 " + repr(t) + "（§7.3 全集 26 种，本核全实现）"

    # —— 建连阶段：先验设备，再决定模式（R139），两件事都必须看得见 ——
    # 两道闸门是两种病，别共用一句病历：下面 :583 是 adb 本体缺失（adb_connect 压根没被
    # 调用，设备连没连过都还没测过），:589 才是真·连接失败。两处的 skip 行落进同一份
    # detail.commands 并排显示在 run 报告里——同一句原因等于把配置故障伪装成设备故障。
    try:
        adb_executable()
    except (RuntimeError, FileNotFoundError) as e:
        result.error = _short(str(e), 280)
        for c in steps or []:
            result.commands.append(_row_cmd(c, "skip", "adb 不可用，全部步骤未执行", 0))
        return result
    c0 = await adb_connect(serial)
    if not c0.ok:
        # 「设备未连接」这一句只有这里挣得起：adb_connect 真跑过、真失败了
        result.error = "设备 " + serial + " 连不上：" + _short(c0.error or c0.text, 200)
        for c in steps or []:
            result.commands.append(_row_cmd(c, "skip", "设备未连接，未执行", 0))
        return result
    result.ok = True  # 「跑起来了」的最小事实：adb 在、设备应得上
    session = await asyncio.to_thread(adb_u2.connect_session, serial)
    result.mode = "u2" if session is not None else "dump"
    # 降级不是错误，不写 error；它的可见性走 result.mode（T7 必须落进 run 详情与日志）——
    # 「慢但可用」要看得见，悄悄换个引擎就是 §13 纪律 1 的违例。

    # —— 主循环（红即停，optional 例外；取消/超时后剩余 skip）——
    stopped_reason: str | None = None
    has_failure = False
    try:
        for step in steps or []:
            row = _row_cmd(step, "pass", None, 0)
            t0 = time.perf_counter()
            if not isinstance(step, Mapping):
                row.update(status="error", message="步骤必须是 JSON 对象（§7.3），实际是 "
                           + type(step).__name__, elapsed_ms=0)
                result.commands.append(row)
                has_failure = True
                stopped_reason = "fail_fast"
                continue
            if stopped_reason is not None:
                row.update(status="skip", elapsed_ms=0,
                           message="运行超时（max_runtime_ms），未执行" if stopped_reason == "timeout"
                           else "运行已中止（取消或前序失败），未执行")
                result.commands.append(row)
                continue
            if deadline is not None and time.perf_counter() >= deadline:
                stopped_reason = "timeout"
                result.error = "运行超时：已达 max_runtime_ms 上限，剩余步骤已跳过"
                row.update(status="skip", message="运行超时（max_runtime_ms），未执行", elapsed_ms=0)
                result.commands.append(row)
                continue
            if await cancelled():
                stopped_reason = "cancel"
                row.update(status="cancelled", message="运行已取消，本步未执行", elapsed_ms=0)
                result.commands.append(row)
                continue
            try:
                pw = step.get("pre_wait_ms")
                if isinstance(pw, int) and not isinstance(pw, bool) and pw > 0:
                    left = pw
                    while left > 0:
                        await check_bounds()
                        piece = min(left, SLEEP_SLICE_MS)
                        await asyncio.sleep(piece / 1000.0)
                        left -= piece
                row["message"] = await exec_one(step, row)
            except _Cancelled:
                row.update(status="cancelled", message="等待被取消",
                           elapsed_ms=int((time.perf_counter() - t0) * 1000))
                result.commands.append(row)
                stopped_reason = "cancel"
                continue
            except _DeadlineHit:
                row.update(status="error", message="运行超时：已达 max_runtime_ms 上限，本步被中止",
                           elapsed_ms=int((time.perf_counter() - t0) * 1000))
                result.commands.append(row)
                result.error = "运行超时：已达 max_runtime_ms 上限，剩余步骤已跳过"
                has_failure = True
                stopped_reason = "timeout"
                continue
            except Exception as e:  # noqa: BLE001 单步一切意外 = error 行（红），不抛穿
                row.update(status="error", message=type(e).__name__ + ": " + _short(str(e), 180))
            if row["status"] == "fail" and not row["assertions"]:
                # 不变量：fail=「判定跑成了且结论不成立」，没有断言行就等于「说了不通过却拿不出
                # 期望/实际」——DebugPanel 会静默渲染「期望 null」（ui_core._row 为同一坑写过注释）。
                # 只有判定类步骤该发 fail；操作类没做完一律 error。走到这里 = 本核写错了分支。
                row.update(status="error", message="执行核缺陷：" + str(row["type"])
                           + " 判为 fail 却没有断言行（红行无处展示期望/实际），已按 error 处理；"
                           + str(row.get("message") or ""))
            row["elapsed_ms"] = int((time.perf_counter() - t0) * 1000)
            result.commands.append(row)
            if row["status"] in ("fail", "error"):
                has_failure = True
                await capture(row["id"], "步骤失败自动截图")  # D5：fail/error 当场取证
                if not step.get("optional"):
                    stopped_reason = "fail_fast"
    finally:
        # 中止/异常路径的录屏也必须 finalize（mp4 没收尾就是一堆废字节）
        if recording is not None:
            await finalize_recording(None, "运行中止，录屏强制收尾")
        if session is not None:
            # 注入缝两侧的会话形状只约定 dump_hierarchy/click；close 是可选件
            closer = getattr(session, "close", None)
            if callable(closer):
                await asyncio.to_thread(closer)

    last_id = result.commands[-1]["id"] if result.commands else "?"
    await capture(last_id, "整案终态截图")  # 绿红都留一张现场；裁掉的已记账
    result.passed = (not has_failure and result.error is None
                     and all(c["status"] in ("pass", "skip") for c in result.commands))
    if overflow:
        tail = "制品提示：" + "；".join(overflow)
        if result.commands:
            m = result.commands[-1].get("message")
            result.commands[-1]["message"] = (str(m) + "；" + tail) if m else tail
        else:
            result.error = (result.error or "") + "；" + tail
    return result


__all__ = ["AdbRunResult", "MAX_SHOTS_PER_CASE", "SLEEP_SLICE_MS", "run_adb"]
