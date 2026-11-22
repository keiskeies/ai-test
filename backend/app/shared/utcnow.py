"""跨模块共用的 UTC 时刻口径（D135）。

放 app/shared 的理由与 execution/timefmt.py 相反但同源：契约 1 的 independence 清单里
只有 app.modules.*，注释写明各域「只正向依赖 core/shared/execution」，所以 model_cfg 与
notify 要共用同一个「现在几点」的字符串口径，只能落在这里——落进任一域都会让另一域反向
import 它（契约 1 直接红）。

口径本身（为什么必须是 naive UTC 裸串，不是本地时间、也不是带 Z 的串）：
- 前端 `web/src/shared/timefmt.ts` 的 `parseUtc` 给**无偏移**的裸串补 `Z`，即按 UTC 解释；
  这条被 `timefmt.test.ts` 明确钉住，因为库里的 datetime 列存的就是 naive UTC
  （`app/core/db.py:UtcDateTime` 写时 astimezone(UTC) 再剥 tzinfo）。
- 所以「本地时刻 + 无偏移」这个组合会被前端当成 UTC 读，在东八区正好偏 +8h：
  发射端 `04:29:49`（CST）→ 前端显示 `12:29:49`。这就是 D135。
- 另一条修法（前端把裸串当本地）会把库里**所有正确的** naive UTC 字段一起改错，
  而钉住那条的正是前端的测试 ⇒ 诚实解只在发射端。

与 execution/timefmt.py:iso_dt 的分工：那个吃 DB 读回来的 datetime，这个吃「此刻」。
两者输出形状一致（naive UTC → 裸 ISO），因为前端的尺只有一把。
"""
from __future__ import annotations

from datetime import UTC, datetime


def utc_now_iso() -> str:
    """此刻的 naive UTC ISO 串（`2026-11-19T14:03:07`，无偏移、无本地时刻）。

    先 `now(UTC)` 拿到真正的 UTC，再剥 tzinfo —— 顺序不能反：
    `datetime.now()` 直接出的就是本地墙钟，剥不到任何时区信息，那正是 D135 的形状。
    秒以下被抹掉是刻意的：这几处都是「最近一次探测/发送」的人读时刻，
    微秒只会让 JSON 变长而不增加任何信息（旧的 time.strftime 口径也是秒）。
    """
    return datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")
