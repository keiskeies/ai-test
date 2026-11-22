"""FakeDeviceManager —— 测试/e2e 装配假设备的一站式入口（1D T1）。

生产代码只认 `settings.adb_path` 指向的一个**可执行**。Windows 不能把 .py 直接当
subprocess 二进制（实测 WinError 193），CI 是 Ubuntu（POSIX shebang 本体可执行），
所以管理器按平台生成一致的可执行入口：

  - POSIX（CI/本地）：写一个 `fake-adb` 可执行（无扩展名，chmod +x），内容 = 指向
    本文件的 shebang。可直接当 adb 二进制喂给 subprocess。
  - Windows（业主机器）：写 `fake-adb.cmd`（`@py -3 fake_adb.py %*`）。subprocess 调
    .cmd 会经 CreateProcess 走 cmd.exe，argv 能过。

两者共用一个状态文件（`FAKE_ADB_STATE` → 默认 `fake_device.state_path()`）。管理器
每次 `install()` 返回可执行路径 + 状态文件路径 + 文件根；测试自选想要的设备形状写进
状态文件，fake 每次调用实时读——e2e 里后端 webServer 进程跑着产品代码，spec 改状态
文件就能改它看到的设备，跨进程可控。
"""
from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path

_THIS = (Path(__file__).resolve().parent / "fake_adb.py")
_WINDOWS = os.name == "nt"

# 路径插 f-string 是安全的：_THIS 是 Windows/Linux 绝对路径，不含可疑字符。
POSIX_WRAPPER = f"#!/usr/bin/env python3\nimport sys, runpy\nrunpy.run_path(r\"{_THIS}\", run_name=\"__main__\")\n"
# .cmd 里的 %* 表示「透传全部调用参数」，原样转义地活在生成的 wrapper 里。
WINDOWS_WRAPPER_CMD = f'@py -3 "{_THIS}" %*\r\n'


class FakeDeviceManager:
    """一个假「adb 可执行 + 状态」对。默认布到 temp 下；测试可用 fixture_dir 指定。"""

    def __init__(self, workdir: Path | None = None) -> None:
        self.root = (workdir or Path(tempfile.mkdtemp(prefix="tp_fake_adb_"))).resolve()
        self.state_path = self.root / "state.json"
        self.file_root = self.root / "files"
        self.file_root.mkdir(parents=True, exist_ok=True)
        self._install_launchers()

    def _install_launchers(self) -> None:
        if _WINDOWS:
            cmd = self.root / "fake-adb.cmd"
            cmd.write_text(WINDOWS_WRAPPER_CMD, encoding="utf-8")
            self.executable = cmd
        else:
            exe = self.root / "fake-adb"
            exe.write_text(POSIX_WRAPPER, encoding="utf-8")
            exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            self.executable = exe

    def install_env(self, env: dict | None = None) -> dict:
        """把 FAKE_ADB_STATE 与文件根塞进进程环境，返回（副本）。"""
        out = dict(env or {})
        out["FAKE_ADB_STATE"] = str(self.state_path)
        return out

    def with_device(self, serial: str = "192.168.1.50:5555", state: dict | None = None) -> FakeDeviceManager:
        """开箱即用的默认设备形状（一台 online 的 WiFi 真控设备）。"""
        base = {
            "devices": [{"serial": serial, "state": "device"}],
            # 文件往返不落在共享 temp：一律进本管理器的 sandbox，pull/push 可预测。
            "file_root": str(self.file_root),
        }
        if state:
            base.update(state)
        self.set_state(base)
        return self

    def set_state(self, data: dict) -> FakeDeviceManager:
        # 每次写入都钉上 file_root：fake 的「设备文件系统」永远是这个 sandbox，
        # 即便调用方 set_state 时忘了带（文件往返的路径契约不能靠记忆）。
        data = dict(data)
        data.setdefault("file_root", str(self.file_root))
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, self.state_path)  # 原子写：fake 进程读到的一定是完整形状
        self._last = data
        return self

    # —— 便捷：喂给 product 的 adb_cli/DeviceService 的路径 ——
    def adb(self) -> str:
        return str(self.executable)
