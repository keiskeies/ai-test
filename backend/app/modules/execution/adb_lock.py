"""ADB 设备锁 + FIFO 队列（§6.4/§8.7「同设备串行、跨设备并行」+ D16/R140）。

一份「设备=执行槽位」的互斥：同一台设备同一时刻只允许一个 run 执行，多余的排队；
跨设备天然并行（锁按设备分开）。卡片墙的「占用/排队#n」就是读锁的实时状态。

数据形状（Redis，均走 EventBus 的 tp. 前缀）：
- `lock  adb.dev.{device_id}` = 持有者 token 字符串（软删/离线设备仍占位）；
- `queue adb.dev.q.{device_id}` = FIFO 列表，元素为等待者 token；
- token 由调用方生成（执行侧 = run_id:attempt）——锁不 smart，token 就是身份。

释放语义（R140 的落码裁定，与事件总线 1B 的租约同一断言）：
- 删锁必须 **token 校验**：只有当前持有者能删自己的锁、才能把队首晋升为持有者。
  "先 GET 比对再 DEL" 有竞态（两个释放者同时读同一 token、或持有者释放与强制释放
  交错），所以这套动作压进 **WATCH/MULTI/EXEC 事务**。Lua 脚本是教科书解，但 fakeredis
  无 lupa 跑不了（events.py 已为此记过账；R140 本计划也提了 Lua，落码裁定同前——
  原子性由事务提供，测试能真实覆盖比"脚本写得高级但 CI 不测"更符合本仓库口径）。
- renew（续期）必须 token 校验：被强制释放的原持有者**不能**再续期（T5 表驱动钉）。
- 强制释放 = 删锁 + 清队 + 审计（审计由调用方的 service 落，见 device_services 的
  force_release 端点）。

放 execution/ 而非 adb_test/，与 adb_cli.py 同理由：真正的消费者是 T6 的 adb_core
（执行时 acquire→步骤→renew→release），而契约 4 禁 execution import app.modules——
锁住这里，adb_test 与 execution 都能用，互不反向。
"""
from __future__ import annotations

import os
import socket
from typing import Any

from app.core.eventbus import get_bus

# 默认锁 TTL：与运行租约同量级（60s）。持锁者（worker）执行期间每步 renew 续期，
# 崩溃后 TTL 自然到期 → 锁释放可再抢（D16 崩溃语义）。
DEFAULT_LOCK_TTL_S = 60


def lock_key(device_id: str) -> str:
    """锁键唯一构造点：读路径（卡片墙占用检测）从 device_services 拼同一个键。"""
    return "adb.dev." + device_id


def queue_key(device_id: str) -> str:
    return "adb.dev.q." + device_id


def make_token(run_id: str, attempt: int = 1, *, actor_owner: str | None = None) -> str:
    """持锁者 token：run 的唯一身份。owner 拼接帮助崩溃排查（同租约 owner 口径）。

    形如 `run:{run_id}:{attempt}:{worker_host}:{pid}`。attempt 让同一 run 的重复入队
    （重试/失败重跑）不会撞成同一个 token——不同的执行其实是不同的"占锁者"。
    """
    host = actor_owner or (socket.gethostname() + ":" + str(os.getpid()))
    return f"run:{run_id}:{attempt}:{host}"


async def acquire(device_id: str, token: str, *, ttl: int = DEFAULT_LOCK_TTL_S) -> dict[str, Any]:
    """尝试占锁同一台设备。返回 {acquired, position, holder, queued}。

    - acquired=True：SETNX 成功，token 成为持有者，position=0（已持有=队首；
      占设备很慢，把「从头排队」的位次约定为 1 而不是 0，卡片「排队#n」直接 +0 显示）；
    - acquired=False：设备被他人持有，token 排队，position = **1-based 队内位次**
      （1 = 下一个上机；计划 T5「第二个 run 位次 1→0」，release 后它晋升为 0 即持有者）；
    - queued = 当前排队总人数（持有者后的等候长度，卡片「排队#n」徽标用——D17 只显
      真实位次，不做估算）。
    SETNX 原子性就是「同设备串行」的那条缝；跨设备是不同键，天然并行，无需额外处理。
    """
    bus = get_bus()
    lk, qk = lock_key(device_id), queue_key(device_id)
    # 已持有即已持有：release 的「队首晋升」直接把锁写成队首 token（不经它的 SETNX），
    # 轮询式等待者下一轮 acquire 若只看 SETNX 会对自己 SETNX 失败再把自己塞回队尾——
    # 晋升成了持有者却永远「排队中」。docstring 的「已持有=队首」由这两行兑现。
    if await bus.get_key(lk) == token:
        return {"acquired": True, "position": 0, "holder": token,
                "queued": len(await bus.lrange(qk, 0, -1))}
    if await bus.set_nx(lk, token, ttl):
        return {"acquired": True, "position": 0, "holder": token,
                "queued": len(await bus.lrange(qk, 0, -1))}
    pos = await bus.lpos(qk, token)
    if pos is None:
        await bus.rpush(qk, token)
    pos = await bus.lpos(qk, token)
    holder = await bus.get_key(lk)
    queue_all = await bus.lrange(qk, 0, -1)
    return {"acquired": False, "position": int(pos or 0) + 1, "holder": holder,
            "queued": len(queue_all)}


async def renew(device_id: str, token: str, *, ttl: int = DEFAULT_LOCK_TTL_S) -> bool:
    """持有者续期。只有当前持有者能续；被强制释放/已过期 → False（原持有者不许续）。"""
    bus = get_bus()
    lk = lock_key(device_id)
    if await bus.get_key(lk) != token:
        return False
    return await bus.expire_key(lk, ttl)


async def release(device_id: str, token: str, *, ttl: int = DEFAULT_LOCK_TTL_S) -> bool:
    """持有者正常释放 + 队首晋升。token 不匹配 → False（不删别人的锁）。

    删锁与晋升在同一个事务里：队首晋升的同时锁必须交给它并存留 TTL，否则“删了锁
    但没有人拿到”的窗口会让下一个 acquire 直接 SETNX 成功，插了队。事务保证两者
    同存同亡。
    """
    bus = get_bus()
    lk, qk = lock_key(device_id), queue_key(device_id)
    # 事务用底层 client（WATCH/MULTI/EXEC），键名带 tp. 前缀（与 set_nx 存的物理键一致）。
    clk, cqk = bus.channel(lk), bus.channel(qk)
    pipe = bus.client.pipeline(transaction=True)
    from redis.exceptions import WatchError

    while True:
        try:
            await pipe.watch(clk, cqk)
            cur = await pipe.get(clk)
            head = (await pipe.lrange(cqk, 0, 0) or [None])[0]
            if cur != token:
                await pipe.reset()
                return False
            pipe.multi()
            pipe.delete(clk)  # 校验通过：删锁
            if head is not None:
                # 队首晋升为新的持有者 + 出队，与删锁同一事务（不留“锁没主”的窗口）
                pipe.lpop(cqk)
                pipe.set(clk, head, ex=ttl)
            await pipe.execute()
            return True
        except WatchError:  # 期间被并发改动（他人释放/强制释放）：重读重试，不是拿来就删
            continue
        except Exception:
            await pipe.reset()
            raise


async def dequeue(device_id: str, token: str) -> int:
    """把**尚未持有锁**的 token 从队列移除，返回移除条数。

    存在的理由：`acquire` 抢不到即入队（FIFO 公平是默认承诺），但调试档
    （§11.5.5「调试必选空闲设备」）不许排队——抢占竞态输了要能干净退出，否则一个
    没人认领的 token 会在 release 时被晋升成持有者，白占设备到 TTL 到期。
    键知识留在本模块（queue_key 唯一构造点），调用方不该自己拼队列键。
    """
    bus = get_bus()
    return int(await bus.client.lrem(bus.channel(queue_key(device_id)), 0, token))


async def occupation_batch(serials: list[str]) -> dict[str, dict[str, Any]]:
    """批量占用读数（D47-b 步 5e）：一次 mget 取回一批设备的锁持有者，只对**确实被持有**
    的那几台再 lrange 排队键。返回 {serial: {holder, queued}}，不在入参里就不在出参里。
    设备列表每行的占用读数靠它顶替前端逐台 GET /occupation（那一串 N+1 的存在理由）。

    **宿主命名 serial，不叫 device_id**——锁键的真实宿主是 d.serial：occupied() 的形参叫
    device_id，但每个调用点传的都是 serial（device_services.py:179/198/292、
    debug_services.py:634/646）；这里若照形参名拿主键 id 拼 lock_key，每个键都 miss →
    所有设备一律显示「空闲」且不报错（tests/test_d47b_adb_device_page.py 有专例钉 serial
    建锁、列表按行回显 occupied）。mget 与 set_nx 同走 EventBus.channel() 的 tp. 前缀，
    读写对称——bus.mget_keys 的第一批调用方，前缀对称直测也在同一份用例文件里。
    """
    if not serials:
        return {}
    bus = get_bus()
    holders = await bus.mget_keys([lock_key(s) for s in serials])
    out: dict[str, dict[str, Any]] = {}
    # strict=True：mget 每键一值、长度必须与入参逐位对齐。客户端若交出短表，
    # 默认 zip 会**静默少配几台** → 那几台从读数表里消失、被画成空闲（说谎）。
    # 长度不符让它当场 ValueError，由调用方的降级路按「读不到」处理。
    for serial, holder in zip(serials, holders, strict=True):
        if holder is None:
            out[serial] = {"holder": None, "queued": 0}
        else:
            queue = await bus.lrange(queue_key(serial), 0, -1)
            out[serial] = {"holder": holder, "queued": len(queue)}
    return out


async def force_release(device_id: str) -> bool:
    """管理员强制释放：删锁 + 清队。审计由调用方 service 落。

    被强制释放的原持有者此后 renew/release 都返回 False（token 校验在键都不在了
    的情况下天然拒绝）——T5 表驱动钉「原持有者不能再续期」。
    """
    bus = get_bus()
    await bus.del_key(lock_key(device_id))
    await bus.del_key(queue_key(device_id))
    return True


async def occupied(device_id: str) -> dict[str, Any]:
    """占用快照：{holder, queued}（卡片墙「占用/排队」的读数来源）。

    只读路径（device_services 的占用检测与列表徽标），不参与锁语义。queued 是真实
    排队人数（D17：不编估算数字）。无锁 = holder None + queued 0（空闲状态）。
    """
    bus = get_bus()
    holder = await bus.get_key(lock_key(device_id))
    if holder is None:
        return {"holder": None, "queued": 0}
    queue = await bus.lrange(queue_key(device_id), 0, -1)
    return {"holder": holder, "queued": len(queue)}


__all__ = [
    "DEFAULT_LOCK_TTL_S", "acquire", "force_release", "lock_key", "make_token",
    "occupation_batch", "occupied", "queue_key", "release", "renew",
]
