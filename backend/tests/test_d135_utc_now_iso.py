"""D135：五处 `time.strftime("%Y-%m-%dT%H:%M:%S")` 发的是**本地**墙钟裸串。

形状不是「时间差一点」，是发射端与前端的口径对不上：
`web/src/shared/timefmt.ts` 的 parseUtc 给**无偏移**串补 `Z`（按 UTC 解释），这条被
`timefmt.test.ts` 钉死，因为库里 datetime 列存的就是 naive UTC（core/db.py:UtcDateTime
写时 astimezone(UTC) 再剥 tzinfo）。本地裸串喂进这把尺 = 东八区 +8h：
实测发射 `04:29:49`(CST) → 前端显示 `12:29:49`。

为什么修发射端而不是前端：另一条路（前端把裸串当本地）会连带改错库里**所有正确的**
naive UTC 字段，而 timefmt.test.ts 正是为拦住它而存在。

五处全是 checked_at：model_cfg/seed.py、model_cfg/services.py ×2、notify/hooks.py、
notify/service.py。修法统一走 app/shared/utcnow.py（契约 1 的 independence 清单只含
app.modules.*，两个域共用口径只能落 shared）。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.shared import utcnow as utcnow_mod
from app.shared.utcnow import utc_now_iso

OLD = 'time.strftime("%Y-%m-%dT%H:%M:%S")'
APP_DIR = Path(utcnow_mod.__file__).resolve().parent.parent


def test_utc_now_iso_asks_utc_from_the_clock_not_local(monkeypatch) -> None:
    """D135 本体：必须显式向 now() 要 UTC。

    这条**与时区无关**，因此在 CI(UTC) 与本机(Asia/Shanghai) 都杀得动同一个变异体：
    本机跑法（比较本地时刻）在 UTC 机器上会让 `datetime.now()` 变异体蒙混过关，
    而这里断言的是「有没有把 UTC 传进去」——变异体在哪个时区都是红的。
    """
    seen: list[object] = []

    class FakeDT:
        @staticmethod
        def now(tz=None):  # noqa: ANN001, ANN205  替身只记录参数
            seen.append(tz)
            return datetime(2026, 11, 19, 4, 29, 49, 123456, tzinfo=tz or UTC)

    monkeypatch.setattr(utcnow_mod, "datetime", FakeDT)
    out = utc_now_iso()
    assert seen == [UTC], "now() 必须收到 UTC——裸 datetime.now() 出的是本地墙钟，正是 D135"
    assert out == "2026-11-19T04:29:49", "naive UTC + 秒精度：微秒与偏移都不该出现"


def test_utc_now_iso_shape_matches_the_frontend_ruler() -> None:
    """形状契约：无偏移裸串（前端靠「无偏移」这个信号补 Z 当 UTC 读）。

    带出 `Z` 或 `+08:00` 也照样能被前端解析，但那会把「裸串=UTC」这把尺拆成两种输入，
    下游（timefmt.parseUtc 的 OFFSET 分支）就不再是唯一路径——口径宁少一形不多一形。
    """
    s = utc_now_iso()
    assert len(s) == 19, s
    assert s[4] == "-" and s[10] == "T" and s[13] == ":", s
    assert "Z" not in s and "+" not in s, "偏移一出现，前端就不走「裸串按 UTC」那条路了"
    assert datetime.strptime(s, "%Y-%m-%dT%H:%M:%S"), "必须是可解析的 ISO 秒串"


def test_utc_now_iso_tracks_true_utc_not_wall_clock() -> None:
    """值本身：与真 UTC 相差应在数秒内（本机 CST 下若退回本地口径会差 8 小时）。

    这条是本机最容易看懂的一把尺，也是上一条的交叉验证：单看上一条只断言了传参，
    这一条断言了落出来的数确实落在 UTC 那一侧。
    """
    real = datetime.now(UTC).replace(tzinfo=None)
    emitted = datetime.strptime(utc_now_iso(), "%Y-%m-%dT%H:%M:%S")
    assert abs(emitted - real) <= timedelta(seconds=5), (
        f"发出 {emitted} 对不上真 UTC {real}——差 8 小时就是本地墙钟（D135 的形状）")


def test_no_local_wall_clock_strftime_left_in_app() -> None:
    """哨兵：全仓 app/ 下不许再出现那条本地裸串写法。

    五处是同一个病，逐条行为断言只能各管各的调用点；这条管的是「有人将来又抄了一遍」。
    刻意用静态扫（同 test_r157_project_scope_coverage.py 那一族的做法）：便宜、不碰 DB。
    扫源码文本而非 inspect.getsource——后者在测试跑动期间源码被改动会行号错位
    （台账记过的那条「假红」），这里不需要行号，只数有没有这个串。
    """
    hits = [str(p.relative_to(APP_DIR)) + ":" + str(i)
            for p in sorted(APP_DIR.rglob("*.py"))
            for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
            # 注释里允许出现（本次修复就留了「此处曾是…」的说明），代码里不许
            if OLD in line and not line.lstrip().startswith("#")]
    assert hits == [], "这些点又在发本地墙钟裸串，前端会按 UTC 读成 +8h：" + ", ".join(hits)
