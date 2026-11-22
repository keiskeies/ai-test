"""假 u2 注入缝（1D T1，plan T1：「+ 假 u2 注入缝」）。

uiautomator2 通过 TCP ADB 连 atx-agent，CI 没有真设备/真 atx，但 T6 的**控件树类步骤**
（click_by_text / assert_text / 等）要能全链跑。注入缝的作用：产品执行核经一个薄包装
调用 u2，测试把包装换成这里的 fake；fake 读同一份 fake_adb 状态文件，对
`d(text=...).exists` / `dump_hierarchy` / `screenshot` / `click` 给出语义一致的假响应——
**不是产品分支逻辑里藏测试**，是产品把「u2 驱动」抽象成可替换的包装函数，测试换驱动。

产品侧（execution/adb_core.py）的形态：
    from execution import adb_u2  # 薄包装：connect / exists / dump / screenshot
在 CI/测试里 monkeypatch 挂 `scripts.fake_device.fake_u2` 即可。真/假两边接口一致，
adb_core 不知道自己在打真设备还是假设备。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from scripts.fake_device.fake_adb import DEFAULT_DUMP_XML


def _state() -> dict:
    p = os.environ.get("FAKE_ADB_STATE")
    if not p:
        return {}
    try:
        data = json.loads(Path(p).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def connect(address: str, *, timeout: float = 10.0) -> bool:
    """假 connect：状态文件里有对应的在线设备才真成功，否则失败（语义与真 atx 一致）。"""
    data = _state()
    serial = address.split(":")[0] + ":" + address.split(":")[1] if ":" in address else address
    for d in data.get("devices", []):
        if d.get("serial") == serial and d.get("state", "device") == "device":
            return True
    return False


class FakeSession:
    """假 u2 会话：d(text=...)/d(resourceId=...) 等返回可断言的可点物件。"""

    def __init__(self, state: dict) -> None:
        self._state = state

    def dump_hierarchy(self) -> str:
        xml = self._state.get("dump_xml")
        if isinstance(xml, bytes):
            return xml.decode("utf-8")
        if isinstance(xml, str):
            return xml
        return DEFAULT_DUMP_XML

    def screenshot(self, path: str | None = None) -> bytes:
        from scripts.fake_device.fake_adb import _png_bytes

        png = _png_bytes()
        if path:
            Path(path).write_bytes(png)
        return png

    def press(self, key: str) -> None:
        self._state.setdefault("_log", []).append(("press", key))

    def click(self, x: float, y: float) -> None:
        self._state.setdefault("_log", []).append(("click", x, y))

    def text(self, value: str) -> None:
        self._state.setdefault("_log", []).append(("type", value))

    def exists(self, selector: str) -> bool:
        """对 d(text=...)/d(desc=...)/d(resourceId=...) 的通用存在判断：从状态里
        「控件表」射中才算 exists；无表时默认命中（假设备开箱即有登录/标题节点）。"""
        table = self._state.get("ui_nodes", [])
        if not table:
            return True
        target = selector.strip("'\"")
        for n in table:
            if target in (n.get("text", ""), n.get("content_desc", ""),
                          n.get("resource_id", "")):
                return True
        return False


def connect_session(address: str, *, timeout: float = 10.0) -> FakeSession | None:
    if not connect(address, timeout=timeout):
        return None
    return FakeSession(_state())


def dump_hierarchy(address: str, *, timeout: float = 10.0) -> str | None:
    if not connect(address, timeout=timeout):
        return None
    return FakeSession(_state()).dump_hierarchy()
