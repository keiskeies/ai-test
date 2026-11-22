"""ADB 设备心跳（§6.4 每 15s 入库 + D15 默认 15s）：周期任务刷新 last_state 帧。

纪律（计划 T4 点名，三条都能被测）：
- **无 adb 二进制 / 无设备 = 静默跳过本轮 + 一次性 warning 日志**（CI 形状，不炸）。
  心跳是周期任务，它不能因为「这台机器没 adb 或没设备」就在日志里持续刷错——那不是
  CI 的样子。缺位先在**首次**记一笔 warning，之后静默；什么时候好了什么时候恢复记录
  （不假设、不重置）。fake 注入点走 adb_executable()→settings.adb_path，与建连同层。
- **帧形状与建连首帧同一**（device_services._state_frame）：机型/系统/电量/在线+时间戳。
- 在线判定 = 出现在 `adb devices` 的 `device` 行；电量 = `dumpsys battery` 的 level。
- 周期任务**永不向外抛**：坏一条设备继续下一条，全局兜底只 warning。
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.modules.adb_test.device_services import _state_frame
from app.modules.adb_test.models import STATUS_NORMAL, AdbDevice
from app.modules.execution.adb_cli import adb_devices, adb_executable, adb_getprop, adb_shell

logger = logging.getLogger("testpilot")

_warned_missing_adb = False
_warned_no_devices = False


def _parse_battery(text: str) -> int | None:
    """dumpsys battery 文本 → level；取不到返回 None（额度/充电态不明时不说谎）。"""
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("level:"):
            try:
                return int(line.split(":", 1)[1].strip())
            except ValueError:
                return None
    return None


def reset_warning_flags() -> None:
    """测试夹具用：把「已 warning」旗标拨回初值（同进程多次跑心跳互不污染）。"""
    global _warned_missing_adb, _warned_no_devices
    _warned_missing_adb = False
    _warned_no_devices = False


async def heartbeat_once() -> int:
    """跑一轮心跳，返回本次处理的设备数（仅状态断言用；任务体不发异常）。

    任一步失败都不向外抛——它是周期任务，抛了也只会让 beat 下一轮再叫一次。
    缺位警告是「一次性」：消失时记一笔，恢复后旗标复位，再断再记（不假设幂等）。
    """
    global _warned_missing_adb, _warned_no_devices
    try:
        adb_executable()
        _warned_missing_adb = False  # adb 回来了，下次再缺位要重新提醒
    except RuntimeError as e:
        if not _warned_missing_adb:
            logger.warning("ADB 心跳跳过本轮：%s（首次提醒，之后静默直到 adb 可用）", e)
            _warned_missing_adb = True
        return 0

    try:
        r = await adb_devices()
        online = {
            line.split("\t")[0].strip()
            for line in r.text.splitlines() if "\t" in line and line.split("\t")[1].strip() == "device"
        }
    except Exception:  # noqa: BLE001  二进制层理念上不抛，但心跳不能因此炸
        logger.warning("ADB 心跳跳过本轮：adb devices 读取异常", exc_info=True)
        return 0
    if not r.ok:
        if not _warned_missing_adb:
            logger.warning("ADB 心跳跳过本轮：adb devices 非 0（rc=%s %s）",
                           r.rc, r.error)
            _warned_missing_adb = True
        return 0

    async with get_sessionmaker()() as db:
        devices = (await db.execute(select(AdbDevice).where(
            AdbDevice.status == STATUS_NORMAL, AdbDevice.enabled == 1))).scalars().all()
        if not devices:
            if not _warned_no_devices:
                logger.info("ADB 心跳：当前无启用的设备，跳过本轮（首次提醒）")
                _warned_no_devices = True
            return 0
        _warned_no_devices = False

        processed = 0
        for d in devices:
            if d.serial not in online:
                # 离线帧：机型/电量保留最后一帧，online=False（卡片墙灰态的数据基础）
                prev = d.last_state or {}
                d.last_state = _state_frame(
                    model=prev.get("model"), os_version=prev.get("os"),
                    online=False, battery_level=prev.get("battery_level"))
                processed += 1
                continue
            model = (await adb_getprop(d.serial, "ro.product.model")).text.strip()
            osver = (await adb_getprop(d.serial, "ro.build.version.release")).text.strip()
            bat = _parse_battery((await adb_shell(d.serial, ["dumpsys", "battery"])).text)
            d.last_state = _state_frame(model=model or None, os_version=osver or None,
                                        online=True, battery_level=bat)
            processed += 1
        await db.commit()
        return processed


def run_heartbeat() -> int:
    """celery 任务体由 asyncio.run 桥接的同款同步入口（worker 复用）。"""
    return asyncio.run(heartbeat_once())
