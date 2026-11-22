"""假设备 fixture（1D T1，蓝图 §14「假设备 fixture 供 CI」）。

三件：`fake_adb`（state machine 假 adb 可执行）、`fake_u2`（假 u2 注入缝）、
`manager`（FakeDeviceManager 装配入口）。见各自 docstring。
"""
from scripts.fake_device.fake_adb import state_path, write_state
from scripts.fake_device.manager import FakeDeviceManager

__all__ = ["state_path", "write_state", "FakeDeviceManager"]
