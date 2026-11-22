"""adb 二进制定位（1D T1，settings.adb_path 的落地解析）。

口径（config.py 的 adb_path 注释 + 计划 T1）：
  - `settings.adb_path` 非空 → 用它（绝对路径原样；相对路径按仓库根解析，同行 resolve_repo_path）。
    找不到这个路径 = 显式配置失效 → **响亮报错**，绝不静默回落到 PATH「好像能用」。
  - 留空 → 依次找：PATH 里的 `adb`（事实上的标准）/ Android SDK 常见路径。
  - 都找不到 → 返回 None。调用方（设备服务）必须给**人话错误**（含安装指引），
    不许装死、不许假在线、不许悄悄当成功。

契约 4：execution 是执行核，零 app.modules.* import；本模块只碰 stdlib。
假设备 fixture 注入就发生在 resolver 这一层：测试把 `settings.adb_path` 指向
`FakeDeviceManager().adb()`，产品其余代码零改动地打到假设备。
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from app.core.config import get_settings, resolve_repo_path

# Android SDK 的常见落点（Windows / macOS / Linux）。RLOCALAPPDATA\Android\Sdk
# 是本机实测路径（前置取证 4：真实 adb 不在 PATH）。
_SDK_PLATFORM_TOOLS = [
    "platform-tools/adb",
    "platform-tools/adb.exe",
]


def _find_on_path() -> str | None:
    exe = shutil.which("adb")
    return exe if exe else None


def _find_sdk() -> Path | None:
    env_candidates = []
    for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.environ.get(var):
            env_candidates.append(Path(os.environ[var]))
    roots: list[Path] = list(env_candidates)
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        if local:
            roots.append(Path(local) / "Android" / "Sdk")
        program_files = os.environ.get("ProgramFiles")
        if program_files:
            roots.append(Path(program_files) / "Android" / "Sdk")
    roots.append(Path.home() / "Android" / "Sdk")
    for root in roots:
        if not root.is_dir():
            continue
        for rel in _SDK_PLATFORM_TOOLS:
            p = root / rel
            if p.is_file():
                return p
    return None


def _explicit_path(value: str) -> Path:
    p = resolve_repo_path(value)
    if not p.is_file():
        # D158：抛 RuntimeError 而不是 FileNotFoundError——「adb 不在」是同一个错误面，
        # 只许一种异常：没配置时 adb_executable() 抛的就是 RuntimeError，设备服务与心跳
        # 两个调用方也只 catch 它；指错路径若是 FileNotFoundError 就穿门变全局 500。
        raise RuntimeError(
            f"settings.adb_path 指向的 adb 不存在：{p}\n"
            "把 TP_ADB_PATH 改到真实 adb，或清空它用 PATH/SDK 自动查找。")
    return p


def resolve_adb_path() -> str | None:
    """返回可执行的 adb 路径；找不到返回 None（调用方负责说人话）。"""
    s = get_settings()
    if s.adb_path:
        return str(_explicit_path(s.adb_path))
    on_path = _find_on_path()
    if on_path:
        return on_path
    sdk = _find_sdk()
    if sdk is not None:
        return str(sdk)
    return None


ADB_INSTALL_HINT = (
    "没找到 adb 可执行。安装：Android SDK Platform-Tools（或用 Android Studio 的 SDK），"
    "然后把路径填进 settings.adb_path（TP_ADB_PATH）——平台桌面版 adb 通常不在 PATH。"
)
