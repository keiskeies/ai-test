"""自研读表调度器（§6.7 / §4:252，1E T1 / R142）：调度真相在 schedule_task 表里。

起法（独立 beat 进程，**不进 verify/门禁路径**——同 emulator 条款，红绿不依赖它在不在）：
    celery -A app.beat beat -l info

为什么不叠在 worker 的单例 `beat_schedule` 上（取证 ②）：那是启动期烘焙的静态 dict，
「往 dict 里塞用户任务」在进程不重启的前提下根本做不到，而重启 worker 会让执行中的
run 挂在 solo 池上（取证 ⑦）。celery 5.7.0 实测没有 DatabaseScheduler，
「不引 django-celery-beat」把现成捷径也堵死了——读表调度器自己写，形状 =
`Scheduler` 子类覆写 `get_schedule()`：每次访问现从库读 enabled 行算 dict。

三条实现口径：
- **每次 get_schedule() 真读库**：celery beat 的 tick/heap 每轮都经 `schedule` property
  走这里，改行/加行/删行在下一次 tick（max_interval 秒内）即时可见——这就是
  「调度真相在表里」的可观察证据（测试直接调 get_schedule 钉它）。
  max_interval 压到 5s：cron 精度是分钟级，5s 的轮询延迟对用户不可见，
  也不像默认 300s 那样让「新建任务」等半分钟。
- **DB 读失败吃上次快照，beat 不许炸**（同心跳「静默跳过」哲学）：beat 进程一死，
  所有排期全停；返回旧快照最坏是「排期晚一拍」，远好于全停。
- **add/remove no-op**（R142）：表是唯一真相，beat 本地不持有任何可增删的东西；
  基类 add/remove 若生效只会污染临时 dict，覆写成 no-op 把这件事说在明面上。
"""
from __future__ import annotations

import asyncio
import logging
import threading

from celery import Celery
from celery.beat import Scheduler

from app.core.config import get_settings
from app.modules.schedule.cron import crontab_of

logger = logging.getLogger("testpilot.beat")

FIRE_TASK_NAME = "schedule.fire"

_settings = get_settings()

celery_app = Celery("testpilot-beat", broker=_settings.redis_url, backend=_settings.redis_url)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_default_queue=_settings.task_queue,  # 与 worker/投递方同一推导（D10/R118）
    timezone="UTC",
    # beat 命令按这个配置挑调度类——不写它，`celery -A app.beat beat` 起的是原生
    # Scheduler（读不到表、静默排空班），这正是本模块要消灭的事故形状。
    beat_scheduler="app.beat.DbScheduler",
)


async def _load_entries() -> dict:
    """读 enabled 行现算 beat 条目：{"schedule:<id>": {"task": "schedule.fire", ...}}。

    NullPool 一副引擎用完即弃（同 orchestration._task_session 的理由：asyncmy 连接
    绑死首次使用的 loop，而这里每次 get_schedule 都在新的 asyncio.run 里）。
    entry 名用行 id 不用任务名：用户改名称不该触发 heap 重建，改 cron 才会
    （crontab 相等性可比，ScheduleEntry 只比 task/schedule/args/kwargs/options）。
    options.queue 必带：beat 缺省按任务名路由，会物理落进「celery」默认队列，
    worker（tp.dev）领不到（R118 的同族坑）。
    """
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    from app.modules.schedule.models import ScheduleTask

    eng = create_async_engine(_settings.db_url, poolclass=NullPool)
    try:
        maker = async_sessionmaker(bind=eng, expire_on_commit=False, autoflush=False,
                                   class_=AsyncSession)
        async with maker() as db:
            rows = (await db.execute(
                select(ScheduleTask).where(ScheduleTask.enabled == 1)
                .order_by(ScheduleTask.id)
            )).scalars().all()
        out: dict[str, dict] = {}
        for row in rows:
            try:
                # 共用 service 侧同一把尺（cron.crontab_of：段数闸 + 关键字段序——
                # 位置参数序是 分/时/周/日/月，直传会静默错排 dom/dow，见 cron.py 坑 2）
                sched = crontab_of(row.cron)
            except Exception as e:
                # 入库前已过 5 段校验，到这里还不合法 = 有人绕过服务面直写库。
                # 跳过这一行并吼一声（其余行照常排期），而不是让整个 beat 起不来。
                logger.warning("schedule_task %s 的 cron %r 非法，跳过：%s", row.id, row.cron, e)
                continue
            out["schedule:" + row.id] = {
                "task": FIRE_TASK_NAME,
                "args": [row.id],
                "schedule": sched,
                "options": {"queue": _settings.task_queue},
            }
        return out
    finally:
        await eng.dispose()


def _run_sync(coro_fn):
    """跑一个协程拿结果，两种宿主都合法：

    - beat 进程（常态）：纯同步进程，直接 asyncio.run；
    - 已在事件循环里（唯一场景：pytest/嵌入式直调 get_schedule）：asyncio.run
      不允许嵌套（RuntimeError），挪独立线程各起一个新 loop 跑——NullPool 引擎
      本就随 loop 生灭，连接绝不跨线程/loop 活命（orchestration._task_session 同理）。
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro_fn())
    box: dict = {}

    def _worker() -> None:
        try:
            box["value"] = asyncio.run(coro_fn())
        except BaseException as e:  # noqa: BLE001 - 原样搬运给调用方，线程不吞异常
            box["error"] = e

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


class DbScheduler(Scheduler):
    """读表调度器（R142 形状）：get_schedule() 每次现读，add/remove no-op。"""

    #: 轮询间隔（秒）：改行→下一次 get_schedule 反映的上界；默认 300s 太钝。
    max_interval = 5.0

    def __init__(self, *args, **kwargs) -> None:
        # 快照先于任何 get_schedule() 访问存在：DB 首次读取失败也有个 {} 可吃。
        # 快照存的是 Entry（不是原始 dict）：基类 tick/populate_heap 每轮经 schedule
        # property 调 get_schedule 并对着返回值喊 entry.is_due()——返回裸 dict 会让
        # populate_heap 逐条走 _is_due_failed，beat 「活着但永不投任务」（静默死法）。
        self._snapshot: dict = {}
        self._db_broken_logged = False
        super().__init__(*args, **kwargs)

    def get_schedule(self) -> dict:
        """每次现读；DB 挂了吃上次快照（beat 不许炸）。

        增量合并而非整表换新：同名同定义的条目**复用旧 Entry**——基类每轮 tick 都调
        这里，全新 Entry 会把 last_run_at/total_run_count 抹平（触发计数永远归零）；
        非 `schedule:` 前缀的条目（setup_schedule 装的 ADB 心跳，静态 dict）不归库管，
        原样保留——本 beat 是 app 唯一的 beat，不保它心跳就静默停摆。
        """
        try:
            fresh = _run_sync(_load_entries)
        except Exception as e:
            if not self._db_broken_logged:
                # 只吼第一次：DB 断供期间 beat 每秒 tick，条条都吼会把日志刷爆
                logger.warning("schedule_task 读库失败，吃上次快照（%s 条）：%s",
                               len(self._snapshot), type(e).__name__ + ": " + str(e)[:180])
                self._db_broken_logged = True
            return self._snapshot
        self._db_broken_logged = False
        from celery.schedules import maybe_schedule

        merged: dict = {}
        for name, spec in fresh.items():
            old = self._snapshot.get(name)
            # 比较用「Entry 会存的形态」（maybe_schedule：秒数→timedelta、crontab 原样），
            # 拿原始 spec 比会把每个静态条目都判成「变了」而白白重建。
            if (old is not None and str(old.schedule) == str(maybe_schedule(spec["schedule"], app=self.app))
                    and old.task == spec["task"] and list(old.args or []) == list(spec.get("args") or [])):
                merged[name] = old  # 计数与 last_run_at 活下来（见 docstring）
            else:
                merged[name] = self._maybe_entry(name, spec)
        for name, entry in self._snapshot.items():
            if not name.startswith("schedule:"):
                merged[name] = entry
        self._snapshot = merged
        return merged

    def add(self, **kwargs):  # noqa: ANN201 - 表是唯一真相，本地无物可加
        """no-op（R142）：新增排期 = 往 schedule_task 插行，不归 beat 进程管。"""

    def remove(self, name):  # noqa: ANN201
        """no-op（R142）：删排期 = 删行/停用行，beat 下个 tick 自然看不到。"""

    def sync(self) -> None:
        """no-op：无本地状态可持久化（基类实现也是 pass，写明以防误加）。"""

    def setup_schedule(self) -> None:
        """装静态条目（ADB 心跳 15s，worker.py `_beat_schedule()` 同一份 dict）。

        诚实说明：`celery -A app.beat beat` 一起就是这个 app 唯一的 beat——不装它
        心跳就没人跑（worker 侧的 conf.beat_schedule 只有 beat 进程消费）。心跳是
        静态秒数不是 crontab，与读表互不干扰；get_schedule 对非 `schedule:` 前缀
        条目原样保留（见其 docstring）。"""
        from app.worker import _beat_schedule  # 同一份静态表（15s 心跳的唯一出处）

        self.update_from_dict(_beat_schedule())
