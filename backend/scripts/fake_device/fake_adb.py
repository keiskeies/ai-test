#!/usr/bin/env python3
"""假 adb 可执行（1D T1，蓝图 §14「假设备 fixture 供 CI」，plan 2026-11-16-1d T1）。

给 CI / 单测 / e2e 一台**没有真设备也能跑通全链**的设备：它替的是 `execution/adb_cli.py`
那一层 subprocess 真二进制，不改产品分支逻辑（fixture 是白盒替身，不是产品里藏测试分支）。

用法：把这个脚本（Windows 上是 `fake_adb.cmd`；POSIX 上是它自己，带 shebang）作为
`settings.adb_path` 喂给产品代码。产品代码永远用 list-form 调它（取证 ⑤ MSYS 路径坑），
fake 也是 list-form 解析，两边夹好再也不碰 shell 字符串。

跨进程可控：每次调用读**状态文件**（JSON，`FAKE_ADB_STATE` 环境变量指定；未设则用
`fake_device.state_path()` 的默认值）。test/e2e 往状态文件写想要的形状（哪个设备上线、
`connect` 要不要失败、`uiautomator dump` 输出哪棵 XML、文件系统落在哪个目录），fake
每次都读最新——所以后端 webServer 进程里跑着产品代码，e2e spec 却能实时改它看到的设备。

状态文件 JSON 形状（全部可选，缺省即默认行为）：
    devices:  [{serial, state: "device"|"offline"}]   「adb devices」的列（默认: 无）
    connect_fail: [serial...]   connect 这些串行必须失败（默认: 全成功）
    getprops: {prop: value}     getprop / shell getprop 的返回值（默认给机型/系统/序列号）
    dump_xml:  <hierarchy>      uiautomator dump 写入的 XML（默认内置一棵可命中文本的树）
    dump_rc:   0 | 137          模拟 u2 占用时的 137（取证 ③ 的互斥）
    file_root: 目录             push 落地的「设备文件系统」根（默认 <temp>/fake_adb_files）
    screenrecord_size: int      screenrecord 产出的字节数（默认 46650，取证 ⑥ 量到的量级）
    battery:   {level, status}  dumpsys battery 的返回（默认 level=87 status=2）
    shell_rc:  dict             {"cmd": rc} 覆盖特定 shell 命令的退出码（默认全 0）
    install_fail: [apk名...]    这些包名的 `adb install` 退出码 1 + 失败文案（默认全 Success）
    install_no_success: [apk名..] 退出码 0 但**不打 Success**（测「只认 rc 就报成功」的假绿）
"""
from __future__ import annotations

import json
import os
import shutil
import struct
import sys
import tempfile
import zlib
from pathlib import Path

DEFAULT_DUMP_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<hierarchy rotation="0">'
    '  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" '
    'package="com.example.demo" content-desc="" checkable="false" checked="false" '
    'clickable="false" enabled="true" focusable="false" focused="false" '
    'scrollable="false" long-clickable="false" password="false" selected="false" '
    'bounds="[0,0][1080,2220]">'
    '    <node index="1" text="登录" resource-id="com.example.demo:id/btn_login" '
    'class="android.widget.Button" package="com.example.demo" content-desc="" '
    'checkable="false" checked="false" clickable="true" enabled="true" '
    'focusable="true" focused="false" scrollable="false" long-clickable="false" '
    'password="false" selected="false" bounds="[400,1000][680,1160]"/>'
    '    <node index="2" text="订单工作台" resource-id="com.example.demo:id/title" '
    'class="android.widget.TextView" package="com.example.demo" content-desc="" '
    'checkable="false" checked="false" clickable="false" enabled="true" '
    'focusable="false" focused="false" scrollable="false" long-clickable="false" '
    'password="false" selected="false" bounds="[300,300][780,420]"/>'
    '  </node>'
    '</hierarchy>'
)


def _png_bytes(w: int = 320, h: int = 180, rgb: tuple[int, int, int] = (76, 175, 80)) -> bytes:
    """纯 stdlib 的真 PNG（不是文本）：给截图/缩略图做字节往返，PIL/浏览器都能打开。"""
    def _chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    row = b"\x00" + bytes(rgb) * w
    idat = _chunk(b"IDAT", zlib.compress(row * h))
    return b"\x89PNG\r\n\x1a\n" + ihdr + idat + _chunk(b"IEND", b"")


def _state_path() -> Path:
    p = os.environ.get("FAKE_ADB_STATE")
    if p:
        return Path(p)
    return Path(tempfile.gettempdir()) / "tp_fake_adb_state.json"


def state_path() -> Path:
    """给测试/夹具用的公开入口：同一个解析，Windows .cmd 也是这枚。"""
    return _state_path()


def write_state(data: dict) -> Path:
    """测试把想要的设备形状写进状态文件（原子写，避免与读竞争）。"""
    p = _state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, p)
    return p


def _load_state() -> dict:
    try:
        raw = _state_path().read_bytes()
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _file_root(state: dict) -> Path:
    r = Path(state.get("file_root") or (Path(tempfile.gettempdir()) / "tp_fake_adb_files"))
    r.mkdir(parents=True, exist_ok=True)
    return r


def _device_path(state: dict, remote: str) -> Path:
    """远端路径 /sdcard/x.mp4 → 设备文件系统的宿主等价路径（fake 的「设备侧存储」）。"""
    clean = remote.replace("\\", "/").lstrip("/")
    p = _file_root(state) / clean
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _print(s: str) -> None:
    # 所有文本输出走 stdout（adb_cli 收了 text 的走 text，收了 bytes 的走 bytes）；stderr 留空
    sys.stdout.write(s + "\n")


def _devices(state: dict) -> None:
    _print("List of devices attached")
    for d in state.get("devices", []):
        _print(f"{d['serial']}\t{d.get('state', 'device')}")
    _print("")


def _connect(state: dict, serial: str) -> None:
    if serial in state.get("connect_fail", []):
        _print(f"failed to connect to '{serial}': cannot connect to {serial}: 设备不存在")
        sys.exit(1)
    _print(f"connected to {serial}")


def _getprop(state: dict, prop: str) -> None:
    props = {
        "ro.product.model": "Pixel 3a (fake)",
        "ro.build.version.release": "12",
        "ro.serialno": "FAKEADB001",
        "ro.product.manufacturer": "Google (fake)",
    }
    props.update(state.get("getprops", {}))
    _print(props.get(prop, ""))


def _dumpsys_battery(state: dict) -> None:
    b = state.get("battery", {"level": 87, "status": 2})
    _print("Current Battery Service state:")
    _print(f"  level: {b.get('level', 87)}")
    _print(f"  status: {b.get('status', 2)}")


def _dump_command(state: dict, out_path: str) -> None:
    """uiautomator dump：写 XML 到设备路径 + Android 那行人话。dump_rc=137 模拟取证 ③。"""
    if int(state.get("dump_rc", 0)) != 0:
        _print("")
        sys.exit(int(state["dump_rc"]))
    xml = state.get("dump_xml")
    if isinstance(xml, str):
        payload = xml.encode("utf-8")
    elif isinstance(xml, bytes):
        payload = xml
    else:
        payload = DEFAULT_DUMP_XML.encode("utf-8")
    _device_path(state, out_path).write_bytes(payload)
    raw_path = ("/sdcard/" + out_path.split("/")[-1]) if not out_path.startswith("/sdcard") else out_path
    _print(f"UI hierchary dumped to: {raw_path}")


def _push(state: dict, local_src: str, remote_dst: str) -> None:
    p = _device_path(state, remote_dst)
    p.write_bytes(Path(local_src).read_bytes())
    _print(f"{local_src}: 1 file pushed. 14.0 MB/s")


def _pull(state: dict, remote_src: str, local_dst: str) -> None:
    shutil.copyfile(_device_path(state, remote_src), local_dst)
    _print(f"{local_dst}: 1 file pulled. 14.0 MB/s")


def _screenrecord(state: dict, remote_path: str) -> None:
    # 取证 ⑥：录屏 = 起 screenrecord + 收尾 pkill -2 + pull。fake 立即产出定长字节。
    n = int(state.get("screenrecord_size", 46650))
    _device_path(state, remote_path).write_bytes(b"\x00\x00\x00\x18ftypmp42" + (b"R" * (n - 8)))
    _print("")


def _shell(state: dict, args: list[str]) -> None:
    """shell 子命令派发。args = shell 之后的词。"""
    if not args:
        return
    cmd = args[0]
    joined = " ".join(args)
    rc = state.get("shell_rc", {}).get(joined, 0)
    if cmd == "dumpsys" and len(args) >= 2 and args[1] == "battery":
        _dumpsys_battery(state)
    elif cmd == "getprop" and len(args) >= 2:
        _getprop(state, args[1])
    elif cmd == "uiautomator" and len(args) >= 3 and args[1] == "dump" and len(args) >= 3:
        _dump_command(state, args[2])
    elif cmd == "screenrecord":
        if "--time-limit" in args and len(args) >= 3:
            _screenrecord(state, args[-1])
        # 不带 time-limit 的长录屏：http 分离执行的那个形态，fake 也立即产字节
        else:
            _screenrecord(state, args[-1])
    elif cmd == "pkill":
        pass  # 收尾杀 screenrecord：无事发生（fake 早已产完字节）
    elif cmd == "cat" and len(args) >= 2:
        p = _device_path(state, args[1])
        if p.exists():
            blob = p.read_bytes()
            # 文本内容走文本，字节内容原样落 stdout.buffer（cat 语义就是透传）
            try:
                _print(blob.decode("utf-8"))
            except UnicodeDecodeError:
                sys.stdout.buffer.write(blob)
        else:
            sys.exit(1)
    elif cmd in ("input", "am", "monkey", "pm", "sleep", "cmd"):
        pass
    else:
        # 未知 shell 命令：rc 由 shell_rc 决定（默认 0），stdout 空——不许瞎编输出
        pass
    if rc:
        sys.exit(int(rc))


def _exec_screencap() -> None:
    # 字节通道：绝不走文本（取证 ④）。用 sys.stdout.buffer 写原生字节。
    try:
        sys.stdout.buffer.write(_png_bytes())
        sys.stdout.buffer.flush()
    except AttributeError:  # stdout 被测试替换成 StringIO 时的退路（正常路径不触发）
        sys.stdout.write("<binary-sc-byte-stream>")


def _install(state: dict, args: list[str]) -> None:
    """`adb install [-r] <apk>`：认 -r、把包字节落进设备侧（T6 的 install 步骤要能跑通）。

    真 adb 的成功标志就是 stdout 那行 `Success`——执行核按它判安装成没成，fake 必须给
    同一行，否则「装成功了却报失败」会是一个假红。两种坏形状分开造：
      - `install_fail: [包名]` 退出码 1 + 失败文案（设备明确拒装）；
      - `install_no_success: [包名]` **退出码 0 却不打 Success**：真机上什么成因没在这台
        假设备上取证，但这一型必须能造出来——产品若只认退出码，就会在「没成功标志」时
        报「已安装」的假绿。
    """
    apk = Path(args[-1]) if args else Path("")
    if not apk.is_file():
        _print("adb: failed to stat " + str(apk) + ": No such file or directory")
        sys.exit(1)
    if apk.name in state.get("install_fail", []):
        _print("adb: failed to install " + str(apk) + ": INSTALL_FAILED_INVALID_APK")
        sys.exit(1)
    if apk.name in state.get("install_no_success", []):
        _print("")  # rc=0、无 Success、也没落包：产品不许说「已安装」
        return
    _device_path(state, "/data/app/" + apk.name).write_bytes(apk.read_bytes())
    _print("Success")


def _main(argv: list[str]) -> int:
    state = _load_state()
    # 解析可变前缀 [-s SERIAL] + 可选 [exec-out|shell]，剩下的交给具体子命令。
    # adb_cli 一定用 list-form（取证 ⑤），fake 同样只认 argv，两边夹好不碰 shell 字符串。
    rest: list[str] = list(argv)
    while rest and rest[0] in ("-s", "-d", "-e"):
        if rest[0] == "-s" and len(rest) >= 2:
            rest = rest[2:]  # 消费 -s SERIAL（fake 的机器形状与串行无关，各命令自行读状态）
        else:
            rest = rest[1:]
    if rest and rest[0] == "exec-out":
        rest = rest[1:]
        mode = "exec-out"
    elif rest and rest[0] == "shell":
        rest = rest[1:]
        mode = "shell"
    else:
        mode = "direct"
    cmd = rest[0] if rest else ""

    if mode == "exec-out" and cmd == "screencap":
        _exec_screencap()
        return 0
    if mode == "shell":
        _shell(state, rest)
        return 0

    if cmd == "devices":
        _devices(state)
    elif cmd == "connect":
        _connect(state, rest[1] if len(rest) > 1 else "")
    elif cmd == "disconnect":
        _print("disconnected " + (rest[1] if len(rest) > 1 else ""))
    elif cmd == "getprop":
        _getprop(state, rest[1] if len(rest) > 1 else "")
    elif cmd == "push":
        _push(state, rest[1], rest[2])
    elif cmd == "pull":
        _pull(state, rest[1], rest[2])
    elif cmd == "install":
        _install(state, rest[1:])
    elif cmd == "version":
        _print("Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458")
    elif cmd:
        bool_cmds = ("kill-server", "start-server", "wait-for-device", "reverse", "forward")
        if cmd in bool_cmds:
            pass
        else:
            # 未知顶层命令：让人看见「fake 不认识它」，不要静默当成功
            _print(f"adb: unknown command {cmd}")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
