"""uiautomator2 薄包装（1D T6，计划「控件树类经 u2_wrap（惰性 import）」）。

这是 R95 教训的 adb 版复刻：`uiautomator2` 只在 `connect_session` 函数体内 import——
「这台机器没装 u2 / atx 起不来」绝不能表现为「整个后端起不来」，更不能表现为
「执行核 import 就炸」。契约 4：零 `app.modules.*` import。

假设备注入缝（T1 的 `scripts/fake_device/fake_u2.py` 就是照着这个形状写的）：
测试把 `connect_session` 换成 `fake_u2.connect_session`，返回的假会话只需实现
`dump_hierarchy()` / `click(x, y)` / `close()`——adb_core 只经这一层碰 u2，
打真设备与打假设备走同一行代码。

**为什么会话只暴露 hierarchy + click 两件事**（计划 D13 的落码裁定）：
控件树类步骤（click_by_text/assert_text/…）的**语义**由 adb_core 在 hierarchy XML 上
单点实现，u2 模式与 dump 降级模式共享同一份判定代码——两种模式跑出两种结论是
「独立调试与场景执行不可能得出两种结论」（ui_core 模块头）的同款事故。u2 的价值在
「取树快、不用往设备写临时文件」；点击统一落到坐标 tap（u2 内部做的也是同一件事）。
"""
from __future__ import annotations


class U2Session:
    """真机 uiautomator2 会话的薄壳：只透出执行核要用的三个动作，异常照抛（调用方吸收）。"""

    __slots__ = ("_d",)

    def __init__(self, device: object) -> None:
        self._d = device  # uiautomator2.Device，惰性 import 来的，类型豁免见 pyproject

    def dump_hierarchy(self) -> str:
        return str(self._d.dump_hierarchy())  # type: ignore[attr-defined]

    def click(self, x: int, y: int) -> None:
        self._d.click(x, y)  # type: ignore[attr-defined]

    def close(self) -> None:
        # atx-agent 是无守护 RPC，没有正式 close；显式留一口，真机泄漏 uiautomation 实例
        # 时（多次建连不释放 instrumentation）由这里统一收口。
        try:
            self._d.close()  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 收尾失败不该改写已得的执行结论
            pass


def connect_session(address: str, *, timeout: float = 10.0) -> U2Session | None:
    """建连阶段决定模式的那次尝试：连得上返回会话，连不上/没装 u2 返回 None（→ dump 轮询）。

    返回 None 不是失败——R139/取证③：u2 起不来时整次执行改走 `uiautomator dump` 轮询，
    「慢但可用」；但**必须进日志与 run 详情**，悄悄降级就是 §13 纪律 1 的违例。
    timeout 与 fake_u2.connect_session 同签名（注入缝两侧必须同形）；真 u2 自带
    HTTP 超时，这里不重复设一层。
    """
    try:
        import uiautomator2 as u2  # 惰性 import（R95 同款）：没装 u2 的机器照样起后端
    except ImportError:
        return None
    try:
        d = u2.connect(address)
        _ = d.info  # 探一次活：connect 是惰性的（只存地址），真探活在这一次 RPC
    except Exception:  # noqa: BLE001 atx 起不来/设备被别的 instrumentation 占着 = 走降级
        return None
    return U2Session(d)


__all__ = ["U2Session", "connect_session"]
