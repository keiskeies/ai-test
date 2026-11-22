"""1D 依赖与假设备 fixture 前置（计划 T1，蓝图 §14「假设备 fixture 供 CI」）。

这一档是 1D 的地基守卫，全部**不接触真设备 / 不启动 emulator**（门禁里它根本不该依赖
设备的在不在——1C golden 的「响亮 skip」同款）：依赖在场 + adb_path 解析口径 +
假 adb 可执行的状态机能跑。出了这一档，T6 的 adb_cli / T4 的 DeviceService 才谈得上有地方落。

三条钉（R97 同源，都是「CI 绿、业主机器跑不起来」最容易脱钩的缝）：
- ① uiautomator2 必须装、版本 >=3.0（蓝图 §5.4 点名）。mypy 豁免口径见 pyproject：
  只豁免 `uiautomator2.*` 的缺失 stub（同 celery，不全局宽松）。
- ② adb 二进制**缺位必须响亮**：显式 TP_ADB_PATH 指错 → RuntimeError 带指引（D158：
  同一错误面只许一种异常——没配置时 adb_executable() 抛的也是 RuntimeError，
  两个生产调用方只 catch 它）；
  不加时按 PATH→SDK 找，找不到返回 None——设备服务说人话，不装死不假在线。
  假设备 fixture 恰恰注入这一层，所以「二进制缺位」的诚实报错必须有测试罩住。
- ③ FakeDeviceManager：Windows 生成 .cmd 可执行、POSIX 生成 shebang 可执行；
  状态文件跨进程可控，fake adb 的 devices/connect/getprop/dump/screencap 字节通道/
  push/pull 文件根是新 open 的 body，至少能跑通。
"""
from __future__ import annotations

import os
import subprocess
from importlib.metadata import version
from pathlib import Path

import pytest

REPO_BACKEND = Path(__file__).resolve().parents[1]


# —— ① 依赖 ——————————————————————————————————————————————


def test_uiautomator2_installed_and_versioned() -> None:
    assert version("uiautomator2") >= "3.0", \
        "uiautomator2 必须装且 >=3.0（蓝图 §5.4 点名的唯一新增依赖）"
    import uiautomator2  # noqa: F401  # 证明 import 得动（T6 里是惰性的，这里同步验一次）


def test_mypy_exemption_scoped_to_u2() -> None:
    """mypy 豁免只加 uiautomator2.*，不全局宽松（同 celery 口径，计划 T1「附实测条数」）。"""
    from pathlib import Path

    text = Path(REPO_BACKEND / "pyproject.toml").read_text(encoding="utf-8")
    assert "uiautomator2.*" in text, "pyproject 的 [tool.mypy.overrides] 必须豁免 uiautomator2.*"
    # 口径守门：不许顺手加 ignore_missing_imports=true 到别的 override（宽松是大门）
    overrides = text.split("[[tool.mypy.overrides]]")
    assert len(overrides) >= 3, "应有 celery + uiautomator2 两个豁免块"


# —— ② adb_path 解析 ——————————————————————————————————————————


def test_adb_path_explicit_bad_path_is_loud(monkeypatch) -> None:
    """显式配置指到不存在的 adb → RuntimeError 带「改到真实 adb」指引，不静默回落。

    D158：同一错误面只许一种异常——「没配置找不到」走 adb_executable() 抛的就是
    RuntimeError，设备服务/心跳只 catch 它；这里再抛 FileNotFoundError 就穿门变 500。
    """
    from app.core.config import get_settings
    from app.modules.execution.adb_path import resolve_adb_path

    s = get_settings()
    monkeypatch.setattr(s, "adb_path", "C:/definitely/not/a/real/adb.exe")
    with pytest.raises(RuntimeError) as ei:
        resolve_adb_path()
    assert "adb" in str(ei.value).lower() and "TP_ADB_PATH" in str(ei.value)


def test_adb_path_missing_returns_none_and_hint(monkeypatch) -> None:
    """留空 + 完全找不到（PATH 里没有、SDK 路径也没有）→ None + 人话 hint，绝不假在线。"""
    import shutil

    from app.core.config import get_settings
    from app.modules.execution.adb_path import ADB_INSTALL_HINT, resolve_adb_path

    s = get_settings()
    monkeypatch.setattr(s, "adb_path", "")
    # 清掉 env 里的 SDK 候选，并让 shutil.which 假装找不到 adb
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("ProgramFiles", raising=False)
    monkeypatch.setattr(shutil, "which", lambda name: None)

    got = resolve_adb_path()
    assert got is None, f"找不到 adb 时必须 None，拿到 {got!r}"
    assert "adb" in ADB_INSTALL_HINT and "TP_ADB_PATH" in ADB_INSTALL_HINT


def test_adb_path_fake_fixture_is_valid_executable(monkeypatch) -> None:
    """假设备 fixture 的可执行必须能让 resolve_adb_path 直接返回它——注入点在解析层。"""
    from app.core.config import get_settings
    from app.modules.execution.adb_path import resolve_adb_path
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager().with_device(serial="192.168.1.50:5555")
    s = get_settings()
    monkeypatch.setattr(s, "adb_path", mgr.adb())
    got = resolve_adb_path()
    assert got is not None
    assert os.path.isfile(got), f"resolver 返回的必须是存在的文件：{got}"


# —— ③ FakeDeviceManager 状态机（跨进程，真 subprocess）————————————————


def test_fake_adb_devices_and_connect(tmp_path, monkeypatch) -> None:
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager(workdir=tmp_path).with_device(serial="10.0.0.7:5555")
    env = mgr.install_env(dict(os.environ))
    exe = mgr.adb()

    def run(*args, text=True, binary=False):
        return subprocess.run([exe, *args], capture_output=True, timeout=20, env=env,
                              text=text, encoding="utf-8", cwd=tmp_path)

    d = run("devices")
    assert d.returncode == 0 and "10.0.0.7:5555\tdevice" in d.stdout, d.stdout
    c = run("connect", "10.0.0.7:5555")
    assert c.returncode == 0 and "connected to 10.0.0.7:5555" in c.stdout, c.stdout
    g = run("-s", "10.0.0.7:5555", "shell", "getprop", "ro.product.model")
    assert g.returncode == 0 and g.stdout.strip() != "", g.stdout or g.stderr


def test_fake_adb_dump_and_binary_channels(tmp_path, monkeypatch) -> None:
    """dump 写 XML 到拥绑定的文件根；screencap 走字节通道（取证 ④：绝不 text）。"""
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager(workdir=tmp_path).with_device(serial="10.0.0.8:5555")
    env = mgr.install_env(dict(os.environ))
    exe = mgr.adb()

    def run_bin(*args):
        return subprocess.run([exe, *args], capture_output=True, timeout=20, env=env,
                              cwd=tmp_path)

    dump = run_bin("-s", "10.0.0.8:5555", "shell", "uiautomator", "dump", "/sdcard/win.xml")
    assert dump.returncode == 0, dump.stderr
    host = mgr.file_root / "sdcard" / "win.xml"
    assert host.is_file(), "dump 必须落到 fake 的文件根（pull/push 的前提）"
    assert "登录" in host.read_text(encoding="utf-8")

    cap = run_bin("-s", "10.0.0.8:5555", "exec-out", "screencap")
    assert cap.returncode == 0 and cap.stdout[:4] == b"\x89PNG", "screencap 必须真 PNG 字节"


def test_fake_adb_push_pull_roundtrip(tmp_path, monkeypatch) -> None:
    """push 落文件根 + pull 取回字节一致（取证 ⑥ 的「文件往返是真的」在 fake 侧重演）。"""
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager(workdir=tmp_path).with_device(serial="10.0.0.9:5555")
    env = mgr.install_env(dict(os.environ))
    exe = mgr.adb()

    def run(*args):
        return subprocess.run([exe, *args], capture_output=True, timeout=20, env=env,
                              text=True, encoding="utf-8", cwd=tmp_path)

    src = tmp_path / "payload.bin"
    src.write_bytes(b"\x00\x01\x02\xff" + b"hello fake device" * 10)
    p = run("push", str(src), "/sdcard/payload.bin")
    assert p.returncode == 0, p.stderr
    assert (mgr.file_root / "sdcard" / "payload.bin").read_bytes() == src.read_bytes()

    out = tmp_path / "back.bin"
    q = run("pull", "/sdcard/payload.bin", str(out))
    assert q.returncode == 0, q.stderr
    assert out.read_bytes() == src.read_bytes(), "pull 回来的必须与 push 进去的字节一致"


def test_fake_adb_connect_fail_is_real_failure(tmp_path, monkeypatch) -> None:
    """connect_fail 必须真失败（装了 fail 的设备 connect 返回非 0）——「先 connect 验证再
    入库」那条产品逻辑全靠它演。"""
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager(workdir=tmp_path)
    mgr.set_state({
        "devices": [{"serial": "9.9.9.9:5555", "state": "device"}],
        "connect_fail": ["9.9.9.9:5555"],
        "file_root": str(mgr.file_root),
    })
    env = mgr.install_env(dict(os.environ))
    r = subprocess.run([mgr.adb(), "connect", "9.9.9.9:5555"], capture_output=True,
                       timeout=20, env=env, text=True, encoding="utf-8", cwd=tmp_path)
    assert r.returncode != 0, "配置了 connect_fail 的串行必须 connect 失败（非 0）"
    assert "cannot connect" in r.stdout.lower() or r.returncode != 0
