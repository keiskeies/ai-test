"""1D T5 设备锁 + 队列（§6.4/§8.7 + D16/R140）：同设备串行、跨设备并行、崩溃可再抢。

四条钉对计划 T5 逐条来（全部表驱动/成对断言，不依赖真设备）：
- ① **同设备串行**：两个 run 抢一台，第一个占锁，第二个排队位次 1 → 释放后晋升为
  持有者（位次归 0）。排队数字是**真位次**（D17：不做估算，编数字就是假数据）。
- ② **跨设备并行**：两台不同的设备，两把锁互不相扰（不同键）。
- ③ **崩溃模拟**：持锁者进程消失 → TTL 自然到期 → 下一位 SETNX 可再抢
  （D16「worker 被 kill 时锁归谁」的答案：到期即释，不永久霸占）。
- ④ **强制释放**：管理员删锁+清队后，原持有者**不能**再续期、也不能再释放
  （token 校验没了键，天然拒绝）——R140 的「token 校验释放」反向钉。

落码裁定（对照计划 R140 的 Lua 字面）：fakeredis 2.40 无 Lua（lupa 没装，events.py
的租约早就为同一理由记过账）。释放的原子性（删锁+队首晋升不许留「锁没主」窗口）由
WATCH/MULTI/EXEC 事务承担，本文件有两处**真实并发冲突**用例专门钉：两释放者同时放、
释放与强制释放交错 → 都验证不会误删别人的锁。测试全部走 fakeredis 独立 server。
"""
from __future__ import annotations

import asyncio

import fakeredis
import pytest
from fakeredis import FakeAsyncRedis

from app.core.eventbus import init_bus
from app.modules.execution.adb_lock import (
    acquire,
    force_release,
    occupied,
    release,
    renew,
)


@pytest.fixture()
def fake_bus():
    """每用例独立 fakeredis server：跨 client 共享，才能演并发冲突。"""
    server = fakeredis.FakeServer()
    bus = init_bus(client=FakeAsyncRedis(server=server, decode_responses=True))
    yield bus
    # 清空全局 bus，避免污染同进程其他用例（init_bus 是全局单例）
    init_bus(client=FakeAsyncRedis(server=fakeredis.FakeServer(), decode_responses=True))


def _tok(run_id: str) -> str:
    return "run:" + run_id + ":1:host"


# —— ① 同设备串行：占锁 → 排队位次 → 释放晋升（位次 1→0） —————————————————


async def test_same_device_serial_second_run_queues_then_promotes(fake_bus) -> None:
    """两个 run 抢同一台：第二个位次 1 → 第一个释放后，第二个直接晋升为持有者。"""
    d = "192.168.1.50:5555"
    first = await acquire(d, _tok("R1"))
    assert first == {"acquired": True, "position": 0, "holder": _tok("R1"), "queued": 0}
    second = await acquire(d, _tok("R2"))
    assert second["acquired"] is False, "抢不到就必须排队"
    assert second["position"] == 1, "第二位次 1（=下一个上机），计划 T5 原文"
    assert second["holder"] == _tok("R1")
    assert second["queued"] == 1, "排队=持有者后 1 人，徽标给真数字"

    # 释放 → 队首晋升为持有者，位次归 0
    assert await release(d, _tok("R1")) is True
    snap = await occupied(d)
    assert snap["holder"] == _tok("R2"), "R2 由队首晋升，无需重新 acquire"
    assert snap["queued"] == 0

    third = await acquire(d, _tok("R3"))
    assert third["acquired"] is False and third["position"] == 1 and third["holder"] == _tok("R2")


async def test_release_by_non_holder_noop_and_hold_on(fake_bus) -> None:
    """持有者 R1 在位时，R2 去 release 必须返回 False 且锁不动（token 校验）。"""
    d = "dev-serial-2"
    await acquire(d, _tok("R1"))
    assert await release(d, _tok("R2")) is False, "非持有者不许释放"
    assert await release(d, "run:R9:1:host") is False
    assert (await occupied(d))["holder"] == _tok("R1"), "误删 R1 的锁 = 事故"


async def test_release_with_queue_promotes_one_and_only_one(fake_bus) -> None:
    """释放时队里多人：只晋升队首一个，其余位次前移（不丢队、不跳队）。"""
    d = "dev-serial-3"
    await acquire(d, _tok("R1"))
    assert (await acquire(d, _tok("R2")))["position"] == 1
    assert (await acquire(d, _tok("R3")))["position"] == 2
    assert await release(d, _tok("R1")) is True
    snap = await occupied(d)
    assert snap["holder"] == _tok("R2")
    assert snap["queued"] == 1, "R3 还在队里，数量 1 不是 0"


# —— ② 跨设备并行：不同键，互不相扰 ——————————————————————————————


async def test_cross_device_parallel_locks_are_independent(fake_bus) -> None:
    """两台设备不同键：A 占着 d1，d2 照样能立即占上（同设备串行≠全局串行）。"""
    d1, d2 = "dev-a", "dev-b"
    r1 = await acquire(d1, _tok("RA"))
    r2 = await acquire(d2, _tok("RB"))
    assert r1["acquired"] is True and r1["position"] == 0
    assert r2["acquired"] is True and r2["position"] == 0, "跨设备必须并行，不排队"

    # 各自独立释放互不干扰
    assert await release(d1, _tok("RA")) is True
    assert await release(d2, _tok("RB")) is True
    assert (await occupied(d1))["holder"] is None
    assert (await occupied(d2))["holder"] is None


# —— ③ 崩溃模拟：TTL 到期可再抢 ——————————————————————————————————————


async def test_crash_holder_ttl_expiry_allows_reacquire(fake_bus) -> None:
    """持锁者崩溃（不复续期）→ TTL 到期 → 下一位 SETNX 可再抢。
    真实崩溃里 fixture 直接给短 TTL + 等到期，模拟"进程消失后锁自然释放"。"""
    d = "crash-dev"
    await acquire(d, _tok("dead"), ttl=1)
    assert (await occupied(d))["holder"] == _tok("dead")
    await asyncio.sleep(1.2)
    # 到期后键消失，下一位直接占上
    r = await acquire(d, _tok("alive"))
    assert r["acquired"] is True and r["position"] == 0
    assert (await occupied(d))["holder"] == _tok("alive")


async def test_crash_holder_lease_does_not_block_new_acquire(fake_bus) -> None:
    """崩溃者的 token 过期后，旧 token 续期返回 False（键没了），不占坑不霸锁。"""
    d = "crash-dev-2"
    await acquire(d, _tok("dead"), ttl=1)
    await asyncio.sleep(1.2)
    assert await renew(d, _tok("dead")) is False, "键已过期，原持有者不能续缘"
    assert await release(d, _tok("dead")) is False, "崩溃者也不能释放一台不属于它的锁"


# —— ④ 强制释放：删锁清队 + 原持有者失效 —————————————————————————————


async def test_force_release_clears_lock_and_queue(fake_bus) -> None:
    """强制释放 = 删锁 + 清队（管理员动作）；原持有者此后 renew/release 都 False。"""
    d = "forced-dev"
    await acquire(d, _tok("R1"))
    await acquire(d, _tok("R2"))
    assert (await occupied(d))["queued"] == 1

    assert await force_release(d) is True
    assert (await occupied(d))["holder"] is None, "锁被强制删掉"
    assert (await occupied(d))["queued"] == 0, "排队也清空"

    # 原持有者不能再续期/释放
    assert await renew(d, _tok("R1")) is False, "强制释放后原持有者不许再续期（T5 原文）"
    assert await release(d, _tok("R1")) is False


async def test_watch_conflict_duplicate_release_promotes_once(fake_bus) -> None:
    """并发二次释放（同一 token 的重放/误操作）：WATCH 保证队首只晋升一次。

    两个 release 都带着**同一个**持有者 token R1 并发跑（例如 worker 重放释放、
    或旧请求超时重试）。若没有原子守护，两个都删锁 + 两个都晋升队首 = 丢一个队列
    元素。WATCH 让第二个在执行前看到键已被改 → WatchError → 重读发现 cur != token
    → False。最终 R2 晋升且只晋升一次，队列不丢元素。
    """
    d = "contended-dev"
    r1 = await acquire(d, _tok("R1"))
    assert r1["acquired"] is True
    await acquire(d, _tok("R2"))
    await acquire(d, _tok("R3"))

    results = sorted(await asyncio.gather(
        release(d, _tok("R1")),
        release(d, _tok("R1")),  # 重放同一个释放
    ))
    assert results == [False, True], "一次晋升成功，另一次因键已变而被拒"
    snap = await occupied(d)
    assert snap["holder"] == _tok("R2"), "队首 R2 升为持有者"
    assert snap["queued"] == 1, "R3 仍在队里，R2 晋升不丢它（双重释放不能吞队列元素）"


async def test_watch_conflict_release_vs_force_release(fake_bus) -> None:
    """释放与强制释放交错：两个写者并发都碰到同一把锁，最终态锁定且不出现「复辟」。

    - 若 R1 释放先完成：队首（无人）→ 空闲，强制释放再清一遍 = 幂等空闲；
    - 若强制释放先完成：锁已清 → R1 释放看到 cur != token → False（不误删）。
    两种时序都不可能让「已清掉的锁又冒出新持有者」。
    """
    d = "forced-race-dev"
    await acquire(d, _tok("R1"))
    r1_release, force = await asyncio.gather(
        release(d, _tok("R1")),
        force_release(d),
    )
    snap = await occupied(d)
    assert snap["holder"] is None, "无论谁先谁后，最终锁都必须处于空闲（无人占用）"
    # R1 释放可能 True（它执行时键还在）或 False（已经被强制释放清掉）
    assert r1_release in (True, False)
    assert force is True


async def test_positions_are_1_based_for_queue_display(fake_bus) -> None:
    """D17：排队位次 1-based 且是**真实位次**，不是估算。三 run 依次排队 = 位次 1,2,3。"""
    d = "positioning-dev"
    await acquire(d, _tok("P1"))
    assert (await acquire(d, _tok("P2")))["position"] == 1
    assert (await acquire(d, _tok("P3")))["position"] == 2
    assert (await acquire(d, _tok("P4")))["position"] == 3
    assert (await acquire(d, "run:UNIQUE:1:host"))["position"] == 4
    snap = await occupied(d)
    assert snap["queued"] == 4, "持有者外 4 人排队，徽标如实显示数字"
