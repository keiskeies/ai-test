"""cron 校验与「未来 N 次」预览（1E T1，§6.7「cron 表达式校验入库前」）。

纯助手模块：service（入库闸 + 预览端点）与 beat.DbScheduler（读表现算）共用同一把尺，
校验只写一处。不 import 领域模块——beat 进程 import 本模块不许把服务注册面拖进来。

三条 2026-11-16 实测（计划 T1「实测」补记，覆盖早前「ValueError → 422」口径）：

1. **段数必须自己数**：celery 对 4 段输入静默补齐成 5 段照收
   （`crontab("0","2","*","*")` 实测通过）——用户少写一段会入库成一个「没打算要」的
   排期；6 段（带秒）抛的是 TypeError 不是 ValueError，只 `except ValueError` 会变 500。
   所以：先 `len(parts) != 5 → 422`，再 `except (ValueError, TypeError) → 422` 带原话。
2. **段序映射不许吃 positional**：celery `crontab()` 的位置参数序是
   (minute, hour, **day_of_week, day_of_month**, month_of_year)，而标准 5 段是
   分 时 **日** 月 **周**——`crontab(*cron.split())` 把「每周一 02:00」(`0 2 * * 1`)
   错解成「每年 1 号 02:00」（crontab 打印 `<crontab: 0 2 * 1 *>` 实测为证，静默错排），
   把「每月 15 号」(`0 2 15 * *`) 直接 ValueError 拒掉（15 被当 day_of_week 上限 6）。
   必须按关键字 minute/hour/day_of_month/month_of_year/day_of_week 逐段命名。
3. **预览的累加坑**：`remaining_estimate(ref)` 返回的是「下次触发 − **真实 now**」
   （celery remaining() 内部拿 now 做减法），把它累加到参考点上会锚点漂移——实测
   `*/5` 在整 5 分边界得 12:10/12:20/12:40（非单调/跳发）。正解取 celery 三元组
   `remaining_delta(ref) = (start, ffwd, now)` 的 **start + ffwd**（celery 自己的
   「ref 之后第一次触发」算法，负值问题随构造消失），再以 fire+1s 推进参考点。
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from celery import Celery
from celery.schedules import crontab

from app.core.errors import ApiError

# 展示日历与 workbench/services.py:46 的 DISPLAY_TZ 同一把尺（§3.4-6）——但不 import 它：
# workbench 是 composition 模块，契约 1 禁止领域模块横向依赖。同值就地重述，测试钉同值。
DISPLAY_TZ = ZoneInfo("Asia/Shanghai")

# crontab 的 tz 解析需要一个 app 上下文；显式桩（不接 broker），口径同 orchestration._celery_client。
_APP = Celery("testpilot-cron")
_APP.conf.timezone = "UTC"  # 库存 UTC-naive（core/db 口径），worker/beat 的 timezone 也是 UTC


def crontab_of(cron: str, *, nowfun: Callable[[], datetime] | None = None) -> crontab:
    """5 段式 cron → celery crontab；任何不合格式 → 422 带原话（§6.7 入库前置校验）。

    段数闸在前（坑 1），关键字映射兜段序（坑 2）。抛 ApiError（HTTP 面要的就是它）；
    beat 读表侧按 Exception 吞掉跳行。
    """
    parts = cron.split()
    if len(parts) != 5:
        raise ApiError(
            "validation_failed",
            "cron 必须是 5 段式「分 时 日 月 周」，收到 " + str(len(parts)) + " 段：" + cron,
            422, {"cron": cron, "segments": len(parts)},
        )
    minute, hour, day_of_month, month_of_year, day_of_week = parts
    try:
        kw: dict = {
            "minute": minute, "hour": hour,
            "day_of_month": day_of_month, "month_of_year": month_of_year,
            "day_of_week": day_of_week, "app": _APP,
        }
        if nowfun is not None:
            kw["nowfun"] = nowfun
        return crontab(**kw)
    except (ValueError, TypeError) as e:  # 字段级坏值抛 ValueError；TypeError 防御性保留（坑 1）
        raise ApiError("validation_failed", "cron 非法：" + str(e), 422, {"cron": cron}) from e


def next_fire_times(cron: str, base: datetime, n: int = 5) -> list[datetime]:
    """base 起算的接下来 n 次触发时刻（aware，严格递增）；cron 不合格 → 422（复用闸）。

    算法与坑 3 的来龙去脉见模块 docstring：start+ffwd 直取 celery 的「下一次」，
    fire+1s 推进参考点杜绝同边界重复产出——单调性由构造保证，不需要负值补丁。
    """
    c = crontab_of(cron)
    ref = base if base.tzinfo is not None else base.replace(tzinfo=UTC)
    out: list[datetime] = []
    for _ in range(n):
        _start, ends_in, _now = c.remaining_delta(ref)
        fire = _start + ends_in  # ffwd 的 __radd__：celery 自己的「ref 之后第一次」
        out.append(fire)
        ref = fire + timedelta(seconds=1)
    return out
