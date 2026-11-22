"""1D T4 心跳（§6.4 每 15s + D15 默认 15s）：adb.heartbeat 任务体 + last_state 帧。

三条钉（计划 T4 原文点名）：
- ① **帧形状**：机型/系统/电量/在线+last_check_at，与建连首帧同一（device_services._state_frame）。
- ② **在线判定**：adb devices 的 `device` 行在 → 在线 + 拉电量；不在 → 离线帧（保留机型/电量）。
- ③ **无 adb / 无设备 = 静默跳过 + 一次性 warning 日志**：CI 形状，不炸、不刷屏；
  默认周期钉 15s（worker._beat_schedule）。

只走假设备 fixture，不接触真设备/emulator。心跳走真 subprocess（adb_cli → fake），
所以它测的是 **产品代码** 跨进程对一台可控假设备的完整回路。
"""
from __future__ import annotations

import logging
import os

import pytest

from app.core.config import get_settings


@pytest.fixture()
def fake_adb():
    from scripts.fake_device import FakeDeviceManager

    mgr = FakeDeviceManager()
    mgr.with_device(serial="192.168.1.50:5555")
    s = get_settings()
    s.adb_path = str(mgr.adb())
    os.environ["FAKE_ADB_STATE"] = str(mgr.state_path)
    from app.modules.adb_test import heartbeat

    heartbeat.reset_warning_flags()
    return mgr


async def _device(session, serial="192.168.1.50:5555", *, enabled=True, last_state=None):
    from app.modules.adb_test.models import AdbDevice

    d = AdbDevice(project_id="p-heart", name="心跳设备" + serial[:6], serial=serial,
                  enabled=1 if enabled else 0, last_state=last_state)
    session.add(d)
    await session.commit()
    return d.id


async def test_heartbeat_writes_online_frame(session, fake_adb) -> None:
    """在线设备 → last_state 落 机型/系统/电量/在线：True + 时间戳。"""
    from app.modules.adb_test import heartbeat

    await _device(session, "192.168.1.50:5555")
    n = await heartbeat.heartbeat_once()
    assert n == 1
    await session.rollback()
    from sqlalchemy import select

    from app.modules.adb_test.models import AdbDevice

    d = (await session.execute(select(AdbDevice).where(
        AdbDevice.serial == "192.168.1.50:5555"))).scalar_one()
    st = d.last_state
    assert st["online"] is True
    assert st["model"] == "Pixel 3a (fake)"
    assert st["os"] == "12"
    assert st["battery_level"] == 87, "fake 默认 dumpsys battery level=87"
    assert st["last_check_at"]


async def test_heartbeat_marks_offline_device(session, fake_adb) -> None:
    """adb devices 里没有的 serial → 离线帧：online=False，保留最后一帧的机型/电量。"""
    from app.modules.adb_test import heartbeat

    await _device(session, "10.0.0.1:5555", last_state={"model": "旧机型", "os": "11",
                                                        "battery_level": 50, "online": True})
    n = await heartbeat.heartbeat_once()
    assert n == 1
    await session.rollback()
    from sqlalchemy import select

    from app.modules.adb_test.models import AdbDevice

    d = (await session.execute(select(AdbDevice).where(
        AdbDevice.serial == "10.0.0.1:5555"))).scalar_one()
    st = d.last_state
    assert st["online"] is False
    assert st["model"] == "旧机型" and st["battery_level"] == 50, "离线帧保留旧帧的机型/电量"


async def test_heartbeat_no_adb_is_silent_skip_with_warning(session, monkeypatch, caplog) -> None:
    """没有 adb 二进制 → 本轮静默跳过 + 一次性 warning（CI 形状，不炸、不刷屏）。"""
    from app.core.config import get_settings
    from app.modules.adb_test import heartbeat

    await _device(session, "192.168.1.50:5555")
    s = get_settings()
    monkeypatch.setattr(s, "adb_path", "")
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("ANDROID_SDK_ROOT", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("ProgramFiles", raising=False)
    monkeypatch.delenv("FAKE_ADB_STATE", raising=False)
    import shutil

    monkeypatch.setattr(shutil, "which", lambda name: None)

    with caplog.at_level(logging.WARNING, logger="testpilot"):
        assert await heartbeat.heartbeat_once() == 0, "缺 adb 时心跳必须静默返回 0"
        assert await heartbeat.heartbeat_once() == 0  # 第二遍不能再刷 warning
    warns = [r for r in caplog.records if "心跳跳过" in r.getMessage()]
    assert len(warns) == 1, "缺 adb 的 warning 必须一次性：实际 " + str(len(warns))


async def test_heartbeat_bad_adb_path_is_silent_skip_with_warning(session, monkeypatch, caplog) -> None:
    """D158：TP_ADB_PATH 指到不存在的路径 → 心跳同样静默返回 0 + 一次性 warning，绝不外抛。

    这条腿盯 heartbeat_once 的 except RuntimeError：resolver 在这条路上若抛别的类型
    就穿过 catch → beat 每 15s 炸一轮，破本模块「周期任务永不向外抛」的纪律。
    warning 必须带指引原文（TP_ADB_PATH），不是只报「有错」。
    """
    from app.core.config import get_settings
    from app.modules.adb_test import heartbeat

    await _device(session, "192.168.1.50:5555")  # 库里有一台启用设备：跳过只可能是 adb 缺位所致
    heartbeat.reset_warning_flags()  # 上一测拨过的旗标不许串到这里
    s = get_settings()
    monkeypatch.setattr(s, "adb_path", "C:/definitely/not/a/real/adb.exe")
    monkeypatch.delenv("FAKE_ADB_STATE", raising=False)

    with caplog.at_level(logging.WARNING, logger="testpilot"):
        assert await heartbeat.heartbeat_once() == 0, "adb 指错时心跳必须静默返回 0，不外抛"
        assert await heartbeat.heartbeat_once() == 0  # 第二遍不能再刷 warning
    warns = [r for r in caplog.records if "心跳跳过" in r.getMessage()]
    assert len(warns) == 1, "adb 指错的 warning 必须一次性：实际 " + str(len(warns))
    assert "TP_ADB_PATH" in warns[0].getMessage(), "跳过原因要带指引原文：" + warns[0].getMessage()


async def test_heartbeat_no_devices_is_silent(session, fake_adb, caplog) -> None:
    """库里没有启用的设备 → 跳过本轮，不炸也不刷一行错。"""
    from app.modules.adb_test import heartbeat

    with caplog.at_level(logging.WARNING, logger="testpilot"):
        assert await heartbeat.heartbeat_once() == 0
    warns = [r for r in caplog.records if r.name == "testpilot" and r.levelno >= logging.WARNING]
    assert warns == [], "无设备不该有 testpilot warning（最多一条 info）"


async def test_heartbeat_disabled_device_skipped(session, fake_adb) -> None:
    """disabled 的设备心跳不碰（enabled==0 不参与轮询）。"""
    from app.modules.adb_test import heartbeat

    # 假设备在 adb devices 里在线，但 DB 里 disabled
    dcur = await _device(session, "192.168.1.50:5555", enabled=False)
    n = await heartbeat.heartbeat_once()
    assert n == 0
    await session.rollback()

    from app.modules.adb_test.models import AdbDevice

    d = (await session.get(AdbDevice, dcur))
    assert d.enabled == 0 and d.last_state is None


def test_beat_schedule_defaults_to_15s() -> None:
    """D15：beat 周期默认 15s（§6.4「每 15s」是死的），队列按 env 分道。"""
    import app.worker as worker_mod

    conf = worker_mod.celery_app.conf
    bs = conf.beat_schedule
    assert "tp.adb.heartbeat" in bs, "beat_schedule 里要有 adb.heartbeat"
    entry = bs["tp.adb.heartbeat"]
    assert entry["task"] == "adb.heartbeat"
    assert entry["schedule"] == 15.0
    assert entry["options"]["queue"].startswith("tp."), "心跳走 env 分道队列"


def test_worker_registers_adb_heartbeat_without_module_import() -> None:
    """worker 模块级不 import adb_test（引擎/资产类的 import 全在任务体内）。

    与 test_execution_worker 的结构钉同款：web 进程不加载执行模块的前提不能因
    心跳任务反向蔓延。
    """
    import app.worker as worker_mod

    assert "adb.heartbeat" in worker_mod.celery_app.tasks
    src = open(worker_mod.__file__, encoding="utf-8").read()
    top = [ln for ln in src.splitlines() if ln.startswith(("import ", "from "))]
    assert not any("adb_test" in ln or "heartbeat" in ln for ln in top), \
        "worker 模块级不许 import adb_test（心跳 import 在任务体内）"
    # 任务体确实引了执行体（防止结构钉把任务写死成空壳）
    assert "heartbeat_once" in src
