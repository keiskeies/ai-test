"""adb 二进制薄壳（1D T4/T6）：stdlib subprocess 的 list-form 封装，执行核与设备服务共用。

契约 4：execution 零 `app.modules.*` import——本文件只碰 stdlib + app.core.config（adb_path
在 execution 内部，同包允许）。adb 是 subprocess 真二进制，所以：

- **list-form 铁律（前置取证 ⑤）**：设备路径/参数一律进 argv，绝不经 shell 字符串——
  git-bash 会把 `/sdcard/...` 改写成宿主路径，列表形式不会有这个问题。
- **bytes 通道（前置取证 ④）**：`exec-out screencap` 必须 bytes 读，`text=True` 直接炸
  UnicodeDecodeError。文本类命令（devices/shell getprop）才走文本。
- **超时**：每个 subprocess 有硬超时（默认 10s，screencap 给 15s），asyncio 桥接，
  不阻塞事件循环。超时/非 0 → 收进结果 dict，**绝不抛穿给服务**（设备服务的「先 connect
  验证」要的是人话失败提示，不是栈）。
- **adb 缺位 → 响亮**：`resolve_adb_path()` 返回 None 时抛（带 ADB_INSTALL_HINT），
  因为走到设备服务这里就意味着「这台机器要连设备」，缺 adb 是配置故障不是可跳过状态。

假设备 fixture 注入就发生在 `adb_executable()` 这一层：`settings.adb_path` 指向
FakeDeviceManager 的可执行，同一份代码打真设备与打假设备一样。
"""
from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any

from app.modules.execution.adb_path import ADB_INSTALL_HINT, resolve_adb_path

# 单次 adb 子进程硬超时（秒）。screencap 取证量到 545ms，给足余量；心跳的 getprop 目测
# 24–30ms，5s 对「本机 adb 在自己服务器上」足够宽。
_DEFAULT_TIMEOUT_S = 10
_SCREENCAP_TIMEOUT_S = 15


def adb_executable() -> str:
    """adb 路径；缺位 → RuntimeError 带安装指引（响亮，不装死不假在线）。"""
    exe = resolve_adb_path()
    if exe is None:
        raise RuntimeError(ADB_INSTALL_HINT)
    return exe


async def _run(argv: Sequence[str], *, timeout: float, binary: bool) -> dict[str, Any]:
    """跑一个 list-form adb 子进程，返回 {rc, out_bytes, err_bytes, timed_out}。绝不抛。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return {"rc": -1, "out": b"", "err": (adb_executable() + " 不存在").encode(), "timed_out": False}
    try:
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        rc = proc.returncode if proc.returncode is not None else -1
        return {"rc": rc, "out": out_b, "err": err_b, "timed_out": False}
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return {"rc": -1, "out": b"", "err": ("adb 命令超时(>" + str(timeout) + "s)").encode(), "timed_out": True}


def _text(x: bytes) -> str:
    try:
        return x.decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001 解码失败按原文退回二进制描述
        return repr(x)


class AdbResult:
    """一次 adb 调用的结构化结果（ok = 进程启动且 rc==0）。"""

    __slots__ = ("rc", "out", "err", "timed_out", "ok")

    def __init__(self, raw: dict[str, Any]) -> None:
        self.rc: int = raw["rc"]
        self.out: bytes = raw["out"]
        self.err: bytes = raw["err"]
        self.timed_out: bool = raw["timed_out"]
        self.ok: bool = self.rc == 0 and not self.timed_out

    @property
    def text(self) -> str:
        return _text(self.out)

    @property
    def error(self) -> str:
        return _text(self.err) or ("adb 命令退出码 " + str(self.rc)) if not self.ok else ""


def _base(serial: str | None) -> list[str]:
    return [adb_executable()] + (["-s", serial] if serial else [])


async def adb_devices(*, timeout: float = _DEFAULT_TIMEOUT_S) -> AdbResult:
    """`adb devices`：在线设备列表（解析由调用方做——服务层想怎么展示自己定）。"""
    return AdbResult(await _run([adb_executable(), "devices"], timeout=timeout, binary=False))


async def adb_connect(serial: str, *, timeout: float = _DEFAULT_TIMEOUT_S) -> AdbResult:
    """`adb connect <serial>`：WiFi 设备建连验证（先 connect 再入库的那一步）。"""
    return AdbResult(await _run([adb_executable(), "connect", serial], timeout=timeout, binary=False))


async def adb_disconnect(serial: str, *, timeout: float = _DEFAULT_TIMEOUT_S) -> AdbResult:
    return AdbResult(await _run([adb_executable(), "disconnect", serial], timeout=timeout, binary=False))


async def adb_getprop(serial: str, prop: str, *, timeout: float = _DEFAULT_TIMEOUT_S) -> AdbResult:
    """`adb -s <serial> shell getprop <prop>` → 机型/系统版本等（心跳 + 测试即拍）。"""
    return AdbResult(await _run(_base(serial) + ["shell", "getprop", prop], timeout=timeout, binary=False))


async def adb_screencap(serial: str, *, timeout: float = _SCREENCAP_TIMEOUT_S) -> AdbResult:
    """`adb -s <serial> exec-out screencap`：**bytes 通道**（取证 ④），返回真 PNG。"""
    return AdbResult(await _run(_base(serial) + ["exec-out", "screencap"], timeout=timeout, binary=True))


async def adb_shell(serial: str, args: list[str], *, timeout: float = _DEFAULT_TIMEOUT_S) -> AdbResult:
    """`adb -s <serial> shell <args...>`：argv list-form，绝不组 shell 字符串（取证 ⑤）。"""
    return AdbResult(await _run(_base(serial) + ["shell", *args], timeout=timeout, binary=False))


async def adb_push(serial: str, local: str, remote: str, *, timeout: float = 30) -> AdbResult:
    return AdbResult(await _run(_base(serial) + ["push", local, remote], timeout=timeout, binary=False))


async def adb_pull(serial: str, remote: str, local: str, *, timeout: float = 30) -> AdbResult:
    return AdbResult(await _run(_base(serial) + ["pull", remote, local], timeout=timeout, binary=False))


async def adb_install(serial: str, local_apk: str, *, reinstall: bool = False,
                      timeout: float = 120) -> AdbResult:
    """`adb install [-r] <apk>`：装 PC 上的包（取证⑥同款大文件超时口径，给 120s）。"""
    argv = _base(serial) + ["install"] + (["-r"] if reinstall else []) + [local_apk]
    return AdbResult(await _run(argv, timeout=timeout, binary=False))


async def adb_shell_spawn(serial: str, args: list[str]) -> asyncio.subprocess.Process:
    """分离执行（取证⑥的录屏起点）：起 `shell screenrecord …` 不等待、不收管道。

    调用方收尾三件套缺一不可：`pkill -2` 让 mp4 finalize → `proc.wait()` 收尸 →
    pull 文件。**stdout/stderr 必须 DEVNULL**：录屏进程偶尔往 stderr 吐进度行，
    开了 PIPE 又没人读，管道塞满会把录屏自己堵死——这是「起进程」不是「跑命令」。
    adb 缺位时抛 RuntimeError/FileNotFoundError（adb_executable 带安装指引），由执行核转 error 行。
    """
    return await asyncio.create_subprocess_exec(
        *_base(serial) + ["shell", *args],
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )


__all__ = [
    "adb_executable", "adb_connect", "adb_disconnect", "adb_devices", "adb_getprop",
    "adb_screencap", "adb_shell", "adb_push", "adb_pull", "adb_install", "adb_shell_spawn",
    "AdbResult",
]
