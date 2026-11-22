# 1E 定时 + 通知渠道 + 工作台 + 审计查询 + 导入导出 + 模型配置中心实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development 或 executing-plans 逐任务实现，checkbox 跟踪。
> 实现前若与本文件冲突，**先改本文件再改代码**，冲突不可静默吞掉（1A/1B/1C/1D 同规）。
> 蓝图验收底线原文：`docs/2026-11-13-ai-test-platform-design.md:1598`
> 「**1E(2~3 周)** 定时 + 通知渠道 + 工作台 + 审计查询 + 导入(OpenAPI/Swagger/Postman)+ 导出备份 + 模型配置中心(含出厂种子 §6.8)。」
> 一期 DoD（`:1600`）：「混合场景(API+UI+ADB)执行→报告→**定时→通知**全链路」——前四拍 1B–1D 已敲，
> 1E 接的就是最后两拍。1D 计划 D20 白纸黑字把定时/通知 handed 给了本批次
> （`2026-11-16-1d-adb-testing.md:103`：「1E 再接上定时/通知才算闭合」）。

**Goal:** 一期收口批次 1E——**定时任务**（§4 `schedule_task` 表 + §6.7 自研 Beat Scheduler 读表、cron 入库前校验、§11.4.17 列表 + 编辑抽屉「每天/每周/自定义 cron + 预览未来 5 次」）、**通知渠道**（§11.4.26 五类渠道 Webhook/钉钉/企微/飞书/SMTP，config 密文存储 + 测试发送原样回显）、**执行结果通知模板**（§6.7 Markdown 摘要）、**工作台**（§11.4.1——后端 `workbench_stats` 已在，补 ADB 资产计数与前端缺块）、**审计查询增量**（§6.9/§11.4.27——`audit_list` 已在，补时间区间与 [diff] 双栏对照）、**导入**（§11.4.6 三步向导：OpenAPI3/Swagger2/Postman 解析 + 预览 + 逐条冲突策略 + 回滚整批）、**导出备份**（资产导出，与导入成往返自证）、**模型配置中心**（§6.8 逐能力探测 + EMBEDDING 维度探测 + 出厂种子——CRUD/打码/默认位已在，补的是「能力位逐项探测回填 probe_result」与 §11.4.23 卡片墙）。以及本批次的硬验收：**混合场景经定时触发执行 → 报告落库 → 通知真实送达**——§13:1600 一期 DoD 的最后两拍。

**Architecture:** 照搬已验证的分层，不发明新的：
1. **新领域模块 `app/modules/schedule/`**（调度 + 通知同族，一张表一个服务面的薄模块）——`schedule_task` CRUD 是普通 `@service`（契约 1：不认识 scenario/execution，到点触发经 send_task 按名字投递，R42 同款）；`notify_channel` 独立成 `app/modules/notify/`（渠道发送器是纯出站 I/O，与调度解耦——§6.10 告警也复用它，不该 import schedule）。
2. **自研读表调度器住在 `app/beat.py`**（§4:252 点名「自研 Beat Scheduler 读 schedule_task 表；不引 django-celery-beat」）：Celery 只给了单例静态 `beat_schedule`（前置取证 ⑥），用户定义的定时任务必须走 `Scheduler.get_schedule()` 覆写——**每秒轮询 sleep 间隔 = 1s 的周期任务**也放不进 solo 池的现实（取证 ⑦），所以调度器是**独立 beat 进程**里的独立 Scheduler 子类，不挂 worker。到点动作 = 投一条 `scenario.run`（带 `trigger="schedule"` 的 actor 语义），调度器本身零执行逻辑。
3. **通知是执行链的尾巴不是头**：`_execute_*_run` 收尾处经事件总线/直投发「run 终态」事件，通知组装住在 `notify/`（读 run_record + 模板渲染 + 按渠道发送），execution 核零通知 import（契约 4）；渠道 config 密文走 `core/security` 的 Fernet（与 `model_cfg.api_key` 同一把 `TP_FERNET_KEY`，§10-3 原话「渠道配置 Fernet 加密」）。
4. **导入/导出住 `api_test`**（导入的对象只有 API 资产，§11.4.6 的预览表列头就是接口）：解析器是纯函数（`importers.py`：三源 JSON → 统一 `ImportItem` 列表，永不抛），冲突比对/落库在 service 层；导出 = 同结构的逆映射——**「导出再导入 = 幂等」是这两个任务的自证测试**，不是口号。
5. **工作台/审计/模型配置是「补 delta」不是重建**：三块的服务面都已存在且各有口径注释（前置取证 ②③④），本批只做各自缺的那几条，防止把跑过的东西再排一遍。

**Tech Stack:** 后端**零新依赖**（这是口径不是愿望：cron 校验/下次触发计算用 `celery.schedules.crontab`——5 段式、非法即抛 ValueError，前置取证 ⑥ 实测；「预览未来 5 次」= 循环 `remaining_estimate`，不需要 croniter——本机 venv 实测 `ModuleNotFoundError: croniter`，引它要过 §5.4 点名关）。前端零新依赖（卡片墙/抽屉/Steps 全是 antd 已有件）。**不引** `django-celery-beat`（§4:252 原文排除）、不引 APScheduler（同一句排除的是同一类东西：调度真相必须在自己的表里）。

**Spec 覆盖:** §6.7 全部（读表调度 + cron 前置校验 + Markdown 模板 + 五渠道）、§6.8 全部（逐能力探测 / EMBEDDING 维度探测回填 / Fernet + 打码 + 仅重置 / 出厂种子网关 `127.0.0.1:9000/v1` + `fundgpt-coder-next` + medium 档 + key 不落仓库 + 首启探测回填）、§6.9（中间件写审计已在——查询页时间/操作人/入口/权限位过滤 + diff 双栏）、§6.10 的一期相关条（**告警复用 notify_channel**：定时连续失败→通知管理员，§11.4.17 抽屉「连续失败[3]次后通知」就是它的 UI；队列深度/备份演练等诊断页本体不做，见「不在 1E」）、§4:210-211（schedule_task/notify_channel 两表字段按蓝图清单，不顺手抄列——1D T2 同款纪律）、§11.4.1（工作台四块）、§11.4.6（三步导入向导 + 逐条冲突策略 + 回滚整批）、§11.4.17（列表 + 抽屉 + 预览 5 次 + 告警阈值）、§11.4.23（模型卡片墙 + 逐能力探测 + 维度探测按钮）、§11.4.26（渠道行内测试 ✓/✗ + 原始响应）、§11.4.27（入口含「定时」——`Entry` 词表的 `schedule` 从 S0 起就预留着，前置取证 ③）、§11.4.28（系统参数页 → **D25 裁决后才做，默认只做 ADB 心跳间隔一项覆盖**）、§10-1（`schedule:task:*`、`notify:channel:*`、`model:cfg:*` 三段式权限位；读类全 `:read` 结尾——READONLY glob 的坑 1D 已量过）、§10-3（密钥安全：渠道 config 密文 + 回显打码 + 审计不落密钥字段）、§9.2（**查询/创建/更新/删除/执行类 service 100% 标注**——但 §6.8 治理线「模型配置权仅系统管理员」与 §9.2 的「写工具对 Agent 可见」冲突 → D29：模型/渠道**写类**沿用现状 `tool=False`，读类开放；§9.2 的「覆盖率 100%」按「UI 展示专用可标 tool=False」的豁免条款解释）。

**不在 1E:** MCP 服务页 / Skills 页 / Agent 写工具与三档权限模式（二期，§13:1602；`shell.tsx` 已标「二期开放」）；`/hook/run/{token}` webhook 触发端点（§6.5 属场景域、§10-6 的一次性 token 设计无批次点名，一期 DoD 未列 → **D27 裁决，默认 1E 不做**）；PDF 导出、深色模式、scrcpy（三期，§13:1604 原文点名）；MeterSphere 互导与存量迁移（三期，业主原话「后期再做」——**1E 的导入只做三个标准格式，不做 MS 私有格式**）；§6.10 的管理诊断页本体（队列深度/Redis 内存/Qdrant 状态/登录失败 TOP——「为单人运维设计」的整页总览无一期批次归属，告警先发、页后补）；备份的**运维侧**（夜间 mysqldump/qdrant snapshot 是部署手册的事，1E 只做**平台内资产导出**，§11.4.28 保留天数等参数页 → D25）；RAG 重建资产索引按钮（§11.4.28 内嵌于系统参数页，随 D25 走）；跨项目复制、版本历史 UI（§6.5/§13 二期条款）。

**1D 在飞（写进计划，防止误读）：** 截至本文件写成之日，**1D 的 T7–T11 未完成**（计划文件里 T7/T8/T10/T11 复选框未勾、T9 只勾了骨架轮；git 最新提交 `268eae1` 是 T9 的 adbDevices 卡片墙）。**1E 的 T0 在 1D 收尾前不许开工**，理由不是流程洁癖：① 1E T1 的定时触发投的是 `scenario.run`，而 1D T8 正在改 scenario 引擎的 handler 注册表（`PENDING_KINDS`/`BLOCKED_1B` 七处翻开）——两边同时动 `handlers.py`/`graph.py` 必撞；② 1D T11 要回填 README 门禁数字并跑 `migrate_dev.py`，1E T0 的 0021 若先落，链头钉（`test_ui_models.py` 钉 `{"0020"}`）会在 1D 的 CI 里变红——链头钉一次只容一个人改；③ 混合场景 DoD e2e（1D T10）与 1E T9 的「定时→通知」e2e 共用同一批场景夹具，夹具所有者未定就并行 = 互相覆写 `seed_demo.py`。

---

## 前置取证（写计划之前已经跑通的事实，全部今天实测）

结论是硬前提；每条都可复跑。环境：本机 Windows、MySQL/Redis 在 db.internal.test、`backend/.venv/Scripts/python.exe`。**【复跑勘误 2026-11-19】这里的 db.internal.test 是 2026-11-16 当轮取证的实际环境，照原文读、不改写；自 2026-11-19 起业主口径改为「各种测试都在本机启动的软件上跑」，复跑请连 `127.0.0.1:3306`（服务 `MySQL84`）与 `127.0.0.1:6379`，不再要求 Docker——见 `docs/2026-11-19-metersphere-source-and-local-testing.md` §4。**
标「README 记录」的是引账不改；标「未实测」的就是没量过，不许当量过用。

1. **1E 的一半 scope 已经存在，计划只排 delta（逐文件读过，非猜测）：**
   - `app/modules/audit/`：`audit_log` 表（models.py，含 `diff JSON`/`entry`/`ip`）+ `audit_list`
     @service（perm `system:audit:read`，GET /audit）已在，筛选有 entry/action/user_id/ok/游标，
     **没有时间区间筛选**（AuditListIn 字段实测）；写入侧 `record()` 唯一写入口 + core.service 的
     `_http_audit` 已接。→ §6.9 的 delta = 时间过滤 + 前端 [diff] 双栏 + `schedule` 入口真的有写入者。
   - `app/modules/model_cfg/`：CRUD + Fernet 打码 + 默认位互斥 + 删除仅超管 + `model_cfg_probe`
     已在；**probe 实测只打 `GET {base_url}/models` 计延迟，capabilities 是把库里存的开关原样回显**
     （services.py:166 `caps = {…存储值}`）——「按能力位逐项探测」未发生。`embed_dimensions` 列在、
     **全仓无任何写入代码**（grep 实测）。`seed.py` 出厂种子幂等存在、`main.py:18,27` 已接进启动，
     `.env:7-8` 就是蓝图 §6.8 的网关与型号（`http://127.0.0.1:9000/v1` / `fundgpt-coder-next`）；
     但**启动不探测**（seed 只落行）、seed 不写 thinking 档（medium 无落点）。
   - `app/modules/workbench/`：`workbench_stats`（perm `workbench:read`，GET /workbench-stats）已在，
     口径注释齐全（Shanghai 日历日窗口/Σ口径/诚实的 `my_recent_edits_types`）；
     `AssetCounts` 实测只有 api_definition/api_case/scenario/ui_case **四类——没有 adb_case**，
     而 §11.4.1 统计卡是「资产 128」一个总数（1D 落地后口径过期）。前端 `workbench.tsx` 已消费该端点。
   - `api_test` **没有任何导入/导出代码**（grep `import_api|export|postman|openapi` 空手而归）——T4/T5 是全新增量，不是改造。
2. **worker 的 beat 现状是单例静态表**：`_beat_schedule()`（worker.py:25-38）只注册
   `tp.adb.heartbeat` 一条 15.0s；注释自陈「只起 worker 不启 beat 时该表静默」。用户自定义 cron
   放不进这张启动期烘焙的单例表——**§4:252「自研 Beat Scheduler 读 schedule_task 表」在本仓是零实现**，
   且 `celery.beat` 模块实测**没有 `DatabaseScheduler`**（`hasattr(celery.beat,'DatabaseScheduler')` → False，
   celery 5.7.0），「不引 django-celery-beat」这条排除令把现成捷径也堵死了：读表调度器得自己写。
3. **cron 语义的地基今天量过**：`celery.schedules.crontab` 5 段式可用——
   `crontab(minute=0, hour=2).remaining_estimate(datetime(2026,11,16,3,0))` → `8:59:18`
   （「预览未来 5 次」= 循环 remaining_estimate，不需要新依赖）；非法串抛 ValueError
   （`crontab(minute='*/5x')` 实测）；`croniter` 未安装（`ModuleNotFoundError` 实测）→ 不引。
   **注意 celery crontab 只吃 5 段**，UI 的「自定义 cron」输入框按 5 段校验，6 段（带秒）一律 422——
   秒级定时不是产品承诺（solo 池也兑现不了，见 ⑦）。
4. **审计入口词表从 S0 就预留了 `schedule`**：`core/service.py:19-23` 的 `Entry` Literal 含
   `("http","agent","schedule")`，注释原话「schedule 二期定时任务才会写入」——**这条注释过期了**：
   定时是 1E（一期）的活，T1 落地时注释同批改（1D 教训：docstring 旧叙事要同批摘）。
   `run_record.trigger` 注释也早有 `schedule`（execution/models.py:25）。词表比写入者宽是安全的，
   1E 干的就是让 `schedule` 真的有写入者。
5. **出网可达性实测（通知渠道的生死题）**：真发请求三发——
   ① `GET https://example.com`（trust_env=False）→ **HTTP 200，769ms**：本机 443 出站 TLS 通；
   ② `POST https://webhook.site/<fresh-uuid>` → **HTTP 404，875ms**；③ 固定 UUID 再发 → **HTTP 429，1487ms**
   （webhook.site 对这个路径的应答本身在限流/拒绝，不是我们的栈断了——TCP+TLS 握手成功、拿到了真 HTTP 状态码）。
   → **结论：出网 HTTP 是通的，「渠道不可达」不能作为 1E 的挡箭牌；但「一条通知真的被第三方收到」
   未实测**（没有一个业主控制的真钉钉群/webhook），送达语义只能在 T9 用本机假接收端钉。
   附带复现 1D 同款坑：**对回环关闭端口发请求 `127.0.0.1:9` 实测不是瞬时拒绝而是
   ConnectTimeout 2094ms**（trust_env=False）——渠道「测试发送」必须带超时并吸收一切异常，
   把 `type(e).__name__` 原样回显（model_cfg_probe 的 `except Exception` 形状直接照抄，那里已经为同一件事记过账）。
6. **httpx 客户端必须 `trust_env=False`**：`scripts/verify_worker.py:291-299` 已写明宿主 `no_proxy`
   含 `[::1]` 导致 httpx 解析炸；`execution/core.py:77` 与 `shared/sandbox.py:201` 两处产品代码都钉了
   `trust_env=False`。→ 通知发送器（`notify/senders.py`）的 httpx 客户端**同款钉死**，R143 记账，
   这是第三次踩同一坑，写进契约测试不许再退。
7. **solo 池的现实约束**（1D 取证 ⑦ 引账：ADB 心跳一轮 ≈80–100ms，3 个子进程；worker.py docstring：
   Windows 必须 `--pool=solo`）：一个 worker 进程一次只跑一条任务。→ 定时触发**绝不落在 worker 进程内做
   记账/比对**（会把通知组装塞进执行关键路径）；调度器 tick 与通知发送都住独立 beat 进程/独立任务；
   「场景执行并发[4]」这类参数在 solo 下是队列语义不是并行度——参数页文案照实写（D25）。
8. **角色 glob 与审计可见性的实测冲突**：`iam/roles.py` READONLY 的 perms 是 `["*:read"]`，
   而审计查询的权限位是 `system:audit:read`——glob 字面命中；`project_services.py:23` 的注释已经为同型坑
   记过账（「盖住 system:user:read / system:audit:read」）。但 §6.9 原话是「查询页(**管理员**)」。
   前端 settings.tsx 用 `canReadAudit` 藏了 Tab——藏 UI 不是门。→ **D23**。
9. **门禁基线（今天实跑）**：`pnpm test` → **231 passed / 16 files**（7.96s）；`pnpm lint` →
   **0 errors / 7 warnings**（全是 react-hooks/exhaustive-deps warn 档）。后端不重跑（≈7 分钟，引账）：
   README 记录 ① **618 passed（308.92s）**、③ mypy 93 文件 0 错、④ **Contracts: 4 kept, 0 broken**、
   ⑦ e2e 诚实口径「70 条里稳定 69 条，第 70 条撞 D11/R136」、⑧ head=0019 时对齐 OK——**alembic 链头
   现为 0020**（`migrations/versions/0020_adb.py`，README 的 0019 数字是 1C+ 时点的账）。
   **基线更新（2026-11-16 T4/T7 提交后领导实测，覆盖上面 ⑥ 的 231/16）**：`pnpm test` →
   **260 passed / 20 files**、`pnpm lint` → **0 errors / 7 warnings**（还是那七条 exhaustive-deps）、
   `npx tsc --noEmit` → 0 错、`lint-imports.exe` → `Contracts: 4 kept, 0 broken.`。
   后文任何「231 → 只增不减」按此新基线读（231 是 1E 起草时点的账，别拿它当今天的地板）。
10. **1D 在飞**：`git log -1` = `268eae1 feat(1d/t9)`（adbDevices 卡片墙）；1D 计划里 T7/T8/T10/T11
    未勾、T9 参数化骨架已勾但 adbCaseDetail 接线未做。**1E 不得先动** `handlers.py`/`graph.py`/
    `test_ui_models.py` 链头钉/`seed_demo.py`（撞车点清单见「不在 1E」尾注）。
11. **未实测清单（对天发誓没量过的）**：钉钉/企微/飞书/SMTP 四类协议的真实握手与送达（本机无任何
    真渠道凭据）；`celery beat` 自定义 Scheduler 子类在多进程下的抢锁行为（单 beat 假设写死，见 D22）；
    demo 库上跑 `migrate_dev.py`（**明令禁跑**，只做只读探测）；Qdrant 是否在线（1E 不碰它）。

## 批次决定记录（承 1D 的 R 序，实现时逐条补全）

**号段公告（与并行 session 的撞号记录）**：`docs/` + `README.md` 全文扫过，R 号最高用到 **R140**
（1D 计划设备锁条目）。1E 从 **R141** 起号；D 号最高 **D21**（1D 的 assert_toast），1E 从 **D22** 起号。
本仓已吃过一次并行撞号（1D 计划头注：R138 被 04de217 抢先占用，只能整体后移）——**动笔前先
`grep -rn "R14[0-9]\|D2[0-9]" docs/ README.md` 复核一遍号段**，撞了就后移并在本文件留一行改号记录，
不许悄悄复用别人的号。
**→ 复核结果（写成之日）**：**R141 已被 1D 计划占用**（D11 首帧丢失专项修复：`EventBus.subscribe`
改 await 到已加入 + 建流处换读快照，见 `2026-11-16-1d-adb-testing.md` 的批次决定记录）。这正是上面
那条警告要防的事，按规矩处理：**1E 的 R 号整体后移一位，从 R142 起号**，下面的条目已按新号改写。
D 号复核无冲突（1D 止于 D21），1E 仍从 **D22** 起。

- **R142 ·（落地回填，`c0dd8ac`）** 用户定时任务走自研读表 Scheduler，不叠在单例 `beat_schedule` 上：
  取证 ② 实测 `_beat_schedule()` 是启动期烘焙的静态 dict + celery 5.7.0 无 `DatabaseScheduler`——
  「往 dict 里塞用户任务」在进程不重启的前提下根本做不到，而重启 worker 会让执行中的 run 挂在
  solo 池上（取证 ⑦）。形状：`app/beat.py` 内 `Scheduler` 子类，`get_schedule()` 每次读
  `schedule_task`（enabled 行）现算 `crontab`，`add/remove` 为 no-op 覆写；beat 进程独立起
  （`celery -A app.beat beat`），**不进 verify/门禁路径**（同 emulator 条款：红绿不依赖它在不在）。
  <sub>**落地**（`c0dd8ac`；2026-11-17 收尾回填，下列 file:line 本轮逐个打开核过）：预决三点全兑现——
  `app/beat.py:129 class DbScheduler(Scheduler)`、`:144 get_schedule()` 每次现读库（`_load_entries :54`
  读 enabled 行、经 `crontab_of` 共用服务面同一把尺算 `crontab`）、`:180/:183/:186` add/remove/sync
  全 no-op；`:50 beat_scheduler="app.beat.DbScheduler"` 钉死调度类——不写它 `celery -A app.beat beat`
  起的是原生 Scheduler（读不到表、静默排空班）。实现补出、预决未写的四处形状：
  ① `max_interval=5.0`（`:133`；默认 300s 让新建任务等半分钟）；② DB 读失败吃**上次快照**不炸
  （`:152-160`，断供期只吼第一次）且返回的必须仍是 Entry dict——裸 dict 过不了基类
  `populate_heap` 的 `entry.is_due()`，症状是「beat 活着但永不投任务」（`:137-139` 注释；同本文件 T1 回填 ③）；
  ③ 增量合并复用在场 Entry（`:164-173`），否则同名同 cron 行每轮重建堆、触发计数归零；
  ④ `setup_schedule()`（`:189-198`）顺带装 ADB 心跳静态表——这个 beat 是 app 唯一 beat，不装心跳
  就静默停摆，故 `get_schedule` 对非 `schedule:` 前缀条目原样保留（`:174-176`）。
  诚实降级两径都有形状：坏 cron 行（绕过服务面直写库）跳过并 warning、其余照常排期（`:84-89`）。
  **「不进门禁」逐字成立**：`.github/workflows/ci.yml` grep beat 零命中（本轮实测）；
  `tests/test_schedule_beat.py` 直调 `get_schedule()` 走真库往返（--collect-only 实测 7 例），
  真 beat 进程本身同 emulator 条款不进 CI。</sub>
- **R143 ·（落地回填，`1efaf08` + `4eea663`）** 通知发送器 httpx 一律 `trust_env=False`：取证 ⑥——同一个宿主
  `no_proxy=[::1]` 坑第三次出现（execution/core.py、shared/sandbox.py、通知发送器），进契约测试钉住
  「senders.py 里每个 AsyncClient 构造都带这个参数」（正则扫源码，同 test_worker 扫 import 的先例）。
  **本批顺手补一处已知的漏网**：`model_cfg/services.py:180` 的 `model_cfg_probe` 也裸用
  `httpx.AsyncClient(timeout=5.0)`（2026-11-16 复核 `grep -rn "trust_env" app/` 只有 core.py:77 与
  sandbox.py:201 两处），本机环境下探活本地网关 `127.0.0.1:9000` 会撞上解析炸——它把错误如实回显
  （不装死），所以不是撒谎，但 §6.8「出厂种子首启探测」在 localhost 上恒假失败，T8 一并跟上并纳入扫描。
  <sub>**落地**（渠道侧 `1efaf08`，probe 侧 `4eea663`；2026-11-17 收尾回填，file:line 本轮逐个打开核过，
  两条扫描例本轮实跑绿）：
  **扫描真正覆盖的面**（正则 `httpx\.AsyncClient\(([^)]*)\)` 逐文件扫源码，摘参必红）——
  ① `notify/senders.py`：发送器钉在 `:184 AsyncClient(timeout=TIMEOUT_S, trust_env=False)`，扫描例
  `tests/test_notify.py:143`（SENDERS_SRC 只指 senders.py，:24）；② `model_cfg/probe.py:212
  AsyncClient(timeout=5.0, trust_env=False)`，扫描例 `tests/test_model_cfg_probe.py:414` 还多钉一条
  `timeout=5.0`。**与预决的形状偏差一处（如实）**：预决点名 `model_cfg/services.py:180`——该行号现已不存在，
  T8 把探测核整体抽进 `probe.py`（`4eea663`，234 行新文件），services.py 本轮 grep `httpx` 零命中；
  钉还在、文件搬家了。
  **当年的三个缺口（③④⑤）已全部闭合（2026-11-17 后到者回填，统一扫描器落地 + 五处变异实测）**：
  新增 `tests/test_r143_trust_env_scan.py`（2 例）——全 `app/` 递归扫 `httpx.(AsyncClient|Client|request|get|post|…)(` 构造，
  括号配平截参数（比旧 `[^)]*` 稳，跨行/嵌套不瞎），每个站点必须逐字 `trust_env=False`；
  ④ 的同步形状（`shared/sandbox.py:201` `kw.setdefault("trust_env", False)` + `:203 httpx.request(..., **kw)`）
  认「`**kw` 展开 + 同文件 setdefault 钉死」为合法形状，摘掉 setdefault 即红。
  ⑤ `import_services.py:34-35` 从此真有扫描例钉（此前 test_api_import.py:239 只是 docstring 提到，摘参不红——
  现在摘参必红，注释已同步改成指向统一扫描器）；③ `execution/core.py:77` 同罩。
  原 ①② 两条本地扫描例（test_notify.py:143、test_model_cfg_probe.py:414 含 timeout=5.0 细节钉）保留不动，
  统一扫描器是并行的全后端网，不替代它们。
  **变异实测（本轮逐一摘参→跑→复原→跑，摘要原样粘贴）**：
  import_services.py 摘参 → `1 failed, 1 passed`（`FAILED ...test_r143_every_httpx_ctor_in_app_has_trust_env_false`）→ 复原绿；
  execution/core.py 摘参 → `1 failed, 1 passed` → 复原绿；notify/senders.py 摘参 → `1 failed, 1 passed` → 复原绿；
  model_cfg/probe.py 摘参 → `1 failed, 1 passed` → 复原绿；sandbox.py 摘 setdefault → `1 failed, 1 passed` → 复原绿。
  **反假绿钉**：`test_r143_scan_actually_finds_known_sites` 断言站点数 ≥5 且已知 5 文件清单缺一不可
  （把 APP_ROOT 指空目录实测护栏红：「扫描只找到 0 个……被架空」）。
  诚实条款（写进测试 docstring）：只钉 app/ 内直接构造这五处（grep httpx 亲验无其他）；
  运行期经第三方库间接建客户端的面**不在覆盖内、也不声称覆盖**。
  实测（本轮收尾复跑）：`pytest tests/test_r143_trust_env_scan.py tests/test_api_import.py
  tests/test_notify.py tests/test_model_cfg_probe.py -q` → **41 passed**；
  历史留档（本条早先轮次）：两条 R143 扫描例 + readyz 四条合跑 6 passed；`--collect-only` 实测
  test_notify.py 12 例、probe -k r143 命中 1/10。</sub>
- **R144 ·（落地回填，`c0dd8ac`）** `entry="schedule"` 的审计语义：定时触发的 run 由调度器投任务、
  **没有人格化操作者**——`audit_log.user_id` 留 NULL、entry 落 `schedule`、action 落 `schedule_task.run`；
  取证 ④ 点名 core/service.py 那条「schedule 二期才写入」的过期注释在 T1 同批摘除。
  通知发送本身不逐条落审计（渠道测试发送是用户动作、落；定时自动发送是机器动作、结果落
  `notify_channel.last_send` 而非审计流水——审计记人，流水记机器）。
  <sub>**落地**（`c0dd8ac`，通知半边在 `48d8ae1` 的 run 终态钩子；2026-11-17 收尾回填，file:line 本轮核过）：
  写入者在 `schedule/service.py` 的 fire 触发体（语义注释 :236-239），三个终点全落同一形状
  `write_audit(user_id=None, action="schedule_task.run", entry="schedule")`——成功 :379-382（diff 带
  run_id/cron）、场景缺失 :342-345、投递失败 :369-372（两条 ok=False 都带人话 error）；
  行已删/已停用早退**不落审计**（没发生任何机器动作，审计不记虚账，`test_schedule_service.py:343-344`
  把这个计数钉成「恰一条」）。取证 ④ 点名的过期注释已摘：`core/service.py:20` 现读作
  「"schedule" 自 1E T1 起有真写入者（worker 的 schedule.fire：entry=schedule、user_id NULL，R144）」——
  「二期才写入」字样全文件只剩 :21 记录摘除这件事的历史注里被引着，撒谎的旧叙事不残。
  「审计记人，流水记机器」两面各有形状：测试发送是 @service HTTP POST，走 core 的 `_http_audit`
  默认通道（用户身份、action=notify_channel_test），结果另写 `last_send`（`notify/service.py:189`
  注释即 D28 口径）；自动通知在 `notify/hooks.py`——该文件 grep `write_audit` **零命中**，
  发送结果逐渠道落 `last_send`（:55）、失败明细合并进 `last_run` 回执（`_merged_receipt` :38）。
  actor 语义按落地形状比预决多说一层：审计行 user_id 恒 NULL，但 run 行 `created_by`=任务创建者、
  投递 actor=创建者快照（`service.py:351-359`）——engine 过权限门要有人格身份，审计面没人格、执行面有，
  两层不混。测试钉：`test_schedule_service.py:256`（全链断 entry=schedule/user_id NULL/action/actor，:295）
  与 :314（两条失败回执路径，:344 断 entry/user_id）。run 侧 `trigger="schedule"` 同批（:355，
  报告中心着色即吃它）。</sub>
- **（不占号 · 计划后补记）** Ctrl+K 定时/渠道落点从「到页」升成「到行」（`201015a`，反转本文件 T9
  加 kind 时的「落点只到页」口径）：`ac150ab` 按 T9 收尾条（「Ctrl+K 搜索 kind 表 += 定时任务/渠道」）
  加两类 kind 时，`paletteNav.ts` 故意只映射到页并留话「当时两页不读 ?q=<id>，不编页面不认的查询串」
  （该来由注释现仍在 `web/src/ui/paletteNav.ts:26-29`）。`201015a` 撤掉这个 stub：`:36-37` 现拼
  `#/schedules?q=<id>` / `#/notify/channels?q=<id>`，两页各消费 `useSearchParams` 并把「哪条是用户搜的」
  抽成导出的 `pickDeepLinkHit` 纯函数钉测（`schedules.tsx:78,371`、`notifyChannels.tsx:137,294`，
  形状逐字抄 1C R121 修出来的元素库，三条来由——同一 q 只认一次 / 记「上一个认过的 id」非一次性
  latch / 等 rows 加载完再认——一条没丢）。**刻意没做**：不为落点自动翻页、不按 id 单条回查，
  行不在已加载集就老实什么都不标（两函数各钉一例）。
  登记不占号的原因：R145 归 1D（T8 引擎 adb 同源）、R146–R150 归 1F、R151+ 归 1G，1E 的 R142–R144
  段已满，本条挂名 1E 不另立号。另一候选 D43 `/readyz` 查过**已有账家**：1G 计划 R156
  （`2026-11-17-1g-perm-gaps-closeout.md:187-196`，含「1E `:668` 只记生成物账，不算重复登记」的自查），
  此处不重复登记。

## 待业主裁决（1E 新增；先按假设实现，全部显式可回退）

- **D22 · beat 单实例与漏跑补偿**。§6.7 只说「自研 Beat Scheduler 读表」，没说两个 beat 进程同时跑
  怎么办（Celery 官方答案是 shelve 锁文件，多机部署必炸）、也没说 worker 停摆错过一次触发要不要补跑。
  **假设：手册写死单 beat 实例；错过不补**——到点没投出去就留 `last_run` 不动 + 下次照常，
  补跑策略需要「应然触发历史」表，蓝图无此表，编一张就是顺手加 scope。业主裁「要补」→ 加
  `next_fire_at` 列 + 启动对账一次，一处可回退。
- **D23 · 谁能看审计日志**。§6.9 原话「查询页(**管理员**)」，但实测（取证 ⑧）READONLY 角色的
  `["*:read"]` glob 字面命中权限位 `system:audit:read`——只读角色在 API 层真的能拉到全平台审计流水
  （含 action/target/diff 元数据）。这是蓝图两条陈述的正面冲突（权限位命名规范 vs 管理员限定）。
  **假设：在 `audit_list` 内加 `ctx.is_system_admin` 硬门**（与 `model_cfg_delete` 的「先门后查」同形），
  权限位名不动——一步回退：删两行硬门即回到纯 glob 语义。改权限位名为 `system:audit:manage`
  反而破坏「读类全 `:read`」的全局规范，不取。
- **D24 · notify_channel 的「config(JSON 密文)」到底怎么密**。§4:211 字段注写「config(JSON 密文)」
  （整坨加密），§11.4.26 列表页却要显示「关键配置(打码)」（access_token••••）——整坨密文没法打码回显，
  两句话隔着 700 行打架。且 §10-3「主密钥只存 env」，而 `core/security.py:90` 实测允许从
  `secret_key` 派生 Fernet 密钥（开发便捷路径）。**假设：JSON 按字段存——敏感键（token/secret/password/
  api_key/webhook url 的 query 段）值 Fernet 加密、其余明文，整包再不做二次加密**（回显打码走解密后
  mask，model_cfg `_mask` 同形）；渠道发送器解密失败回 `****(无法解密)` 不 500。业主裁「整坨密文」
  → 列表页退化为只显示渠道类型 + 「已配置」，一处渲染改动。TP_FERNET_KEY 未显式注入的派生路径
  **沿用现状不动**（`.env` 实测未设该变量——换密钥=旧密文全废，这正是打码占位符存在的理由）。
- **D25 · §11.4.28 系统参数页整页 vs 1E 只带一行**。§6.4/D15 已开了「beat 读系统参数」的先例，
  §11.4.28 却画了整页五件事（制品保留天数/并发/ADB 心跳/Agent 总开关/RAG 组）——整页没有任何一行
  有批次归属，而 §6.10 的 kv_setting 消费方（保留期任务、RAG）大多在二期。**假设：1E 只做
  `kv_setting` 薄表 + ADB 心跳间隔一行**（D15 注释里预定的「留给管理诊断页加宽度的一处入口」兑现），
  参数页 UI 只渲染这一行；其余四组不做「能填不能生效」的假表单（§13 纪律 1）。一步回退：删参数页
  tab，心跳回到写死 15s。并发[4] 文案在 solo 下如实写「队列语义，solo 池串行」不吹并行（取证 ⑦）。
- **D26 · 导入冲突策略里的「新版本」跟版本历史二期打架**。§11.4.6 预览表冲突下拉给了
  「跳过/覆盖」，策略组里却多了个「**新版本**」；§6.5 原话「其余资产 last-write-wins + 变更历史表兜底
  (**历史 UI 二期**)」——接口定义没有一期可用的版本容器，「新版本」要么造一个蓝图没画的
  api_definition 版本表，要么就是把覆盖改个名。**假设：一期做「跳过/覆盖」两策略，逐条 + 全量两档；
  「新版本」按钮不出现**——放个下拉选了报「二期」就是界面能配执行恒假。回退：加一个禁用项一行的事。
  覆盖= last-write-wins 直写 + `diff` 进审计（before/after），这就是「历史表兜底」在一期的全部兜底。
- **D27 · `/hook/run/{token}` webhook 触发端点归不归 1E**。§6.5 把它写在场景级能力清单里、
  §10-6 认真设计了「一次性 token、可吊销、限次」，但 §13:1598 的 1E 行没点它的名，一期 DoD 也不含。
  **假设：不做**——定时是平台内自触发，webhook 是外部拉爆入口，安全面（限次/吊销）值得单独一个批次做透，
  塞进 1E 尾巴上必然做成没闸的裸端点。业主裁「做」→ 新任务 T3.5（token 表 + 端点 + 审计 entry=hook）。
- **D28 · 通知失败重不重试**。§6.7/§11.4.26 只定义了「测试发送」的行内 ✓/✗，对**自动通知**（run 终态
  摘要）发送失败只字未提；§6.10 的告警链路（定时连续失败→通知管理员）恰恰走的就是这条会失败的通道。
  **假设：每次 run 终态一发、不重试、不去重**，结果如实落 `notify_channel.last_send`
  （ok/error/latency/checked_at，`probe_result` 同形）——重试队列要持久化重试计划，蓝图无表；
  去重（同 run 同渠道只发一次）天然成立（一发）。回退：加 `attempt` 计数一列即可升重试。
  「连续失败 3 次告警」按 §11.4.17 抽屉做**每任务阈值**，告警对象=渠道（不发「管理员」私信，
  平台无站内信——§11.4.17 mock 里告警行的语义就是选渠道）。
- **D29 · §9.2「查询/创建/更新/删除/执行类 service 100% 标注」vs §9.2 治理行「模型配置权仅系统管理员」**。
  同一份蓝图：§9.2 覆盖率段要求写类 service 全进 Agent 工具面，§6.8/§9.2 治理段又说模型配置是管理员
  专属——而 Agent 以会话用户身份执行（§10-4），把 `model_cfg_create` 挂进工具面等于给任意用户的
  Pilot 递了改全网关地址的钥匙（Pilot 被注入提示词时最脆的一条路径）。现状实测：model_cfg 写类
  全部 `tool=False`、`audit_list` 反而是 tool=True（默认值漏标）。**假设：写类维持 tool=False**
  （用 §9.2 自己的豁免条款「仅 UI 展示专用接口可标 tool=False」从宽解释为「管理员治理面」），
  `audit_list` 补 `tool=False`（审计查询给 Pilot 读全平台流水没有一期收益）；`schedule`/`notify` 的
  读类 tool=True 正常标注、写类 tool=False。回退：删四处 `tool=False` 即回到字面 100%。
- **D30 · 定时任务能挂什么对象**。§4:210 `schedule_task.subject_type/subject_id` 是复数语义，
  §11.4.17 抽屉里却只有「场景[选择器▾]」一个框；一期 DoD 也只要求「定时→通知」闭环。
  **假设：一期 subject_type 只放 `scenario`**（表列留着，服务面 422 拒其余——1D D14 同款「显式拒绝
  不静默改值」）；ui_case/adb_case 直挂定时 = 各自的 run 编排入口要另开，不属本批。回退：
  白名单加一个字符串。

---

## 任务（checkbox = 状态；每任务尾部 = 门禁与自证）

### T0 · 0021 迁移：schedule_task + notify_channel 两表 + 链头钉 ✅
- [x] `app/modules/schedule/models.py`：`schedule_task` 字段**只来自 §4:210 清单**（subject_type/subject_id/cron/env_id/enabled/notify_channel_ids JSON/last_run JSON）+ 服务面必需要的最小补充（name、project_id、created_by/updated_*、consecutive_failures——§11.4.17「连续失败[3]次」的账总要有人记）；**不顺手抄** next_fire_at（D22 裁决前不加）。`app/modules/notify/models.py`：`notify_channel`（type 枚举 WEBHOOK/DINGTALK/WECOM/FEISHU/EMAIL + config JSON[D24 形状] + last_send JSON）。owner_id/project_public 两列齐不齐看 §4 表——**蓝图这两行没列就不加**（1D T2「清单没列的不抄」同款纪律，schedule/notify 是平台级配置不是项目资产，project_id 为权限过滤加的例外并在 docstring 写明理由）。
      **落地证据**：`test_blueprint_silence_means_no_columns` 把「不该有的列」正向钉住——
      next_fire_at / schedule 的 owner_id+project_public / notify_channel 的 project_id 出现即红。
      docstring 另记一条 T1 必须遵守的坑：`shared/visibility.py` 读 `getattr(row,"project_public",True)`，
      喂它一张没这列的表 = 每行都公开（0018 静默失效的旧账），所以 T1 按 project_id 显式过滤。
- [x] `kv_setting` 表（§4:237 清单里的键值表，D25 假设的地基：心跳间隔一行的落点；表先进 0021，
  消费方只有 `_beat_schedule()`/DbScheduler 读「ADB心跳间隔」一行——D25 业主裁「不做参数」则行不插、表留着）。
      **落地证据**：归属定在 schedule 域（消费方住调度域），key 上真唯一约束由
      `test_kv_setting_key_is_unique` 钉（重复行 = 心跳读侧静默歧义）。
- [x] `migrations/versions/0021_schedule_notify.py`：upgrade→downgrade→upgrade **在临时库实跑**（0020 先例：真去真回，`scripts/check_migration_down.py` 在列）；**不在 demo 库跑**（禁令）。
      **实测**（一次性 schema `testpilot_downchk`，用完即删）：
      `1) ['0021'] 新表 [kv_setting, notify_channel, schedule_task]` →
      `2) ['0020'] 新表 []` → `3) ['0021'] 新表 三张回来` → OK。
      **顺带修掉一处会让「已验证」变成假话的脚本缺陷**（这条不是顺手清理，是 0021 的凭证本身）：
      `check_migration_down.py` 查表写死 `LIKE 'ui_%'`，而它的注释说「扩到 0019+ 加一行 EXPECT 即可」——
      加一行也查不到东西，新迁移跑它必得「表齐全 / down 删干净」两个空集合绿。改成按 EXPECT 点名 IN 查询；
      另加「只认链尾」的拒跑（脚本走 `downgrade -1`，拿它验非链尾会得到一条说不清的红）；
      再把 EXPECT 必须含链尾钉进 `test_down_check_script_knows_the_head`（含「不许改回前缀模糊查」），
      下一个批次忘了登记就是测试红，而不是脚本悄悄放行。
- [x] 链头钉 `test_ui_models.py` 的 `{"0020"}` → `{"0021"}`——**必须在 1D T11 合入后改**（撞车点 ②，文件顶注写明）。
      **顺带同批改**：`test_adb_models.py` 的链头钉也断言 `heads == {"0020"}`，不改就与新链头矛盾——
      两处都只改期望值，判定逻辑一行未动。
- [x] `tests/test_schedule_models.py`：roundtrip / 默认值逐一点名 / 链头唯一 0021 / information_schema 真表在（`test_adb_models.py` 六例形状照抄）；`migrations/env.py` autogenerate 感知清单 += 两模块。
      **落地证据**：7 例（六例 + 上面那条脚本守卫）；`schedule`/`notify` 同时进 `pyproject.toml` 的
      **两枚**契约清单（R64：漏登记 = 契约静默不扫，本轮逐字核过两处各占一行）。
- **门禁与自证**：`pytest tests/test_schedule_models.py tests/test_ui_models.py -q` 全绿；`ruff check app tests migrations scripts` 过；`mypy app` 0 错；`lint-imports.exe` 逐字 **`Contracts: 4 kept, 0 broken`**；⑧ `migrate_dev.py` 只在业主放行时对**开发库**跑（demo 库禁）。
      **实测**：`12 passed`（+test_adb_models 共 18 passed）｜`All checks passed!`｜
      `Success: no issues found in 111 source files`｜`Contracts: 4 kept, 0 broken.`。
      ⑧ 本轮**未跑**（0021 尚未合入，升开发库等于把未评审的迁移推进业主环境——留给批次收尾）。

### T1 · 自研读表调度核 + schedule_task 服务面（§6.7 + §11.4.17）
- [x] `app/modules/schedule/service.py`：CRUD @service（perm `schedule:task:read/create/update/delete`；
  **cron 入库前校验**：`crontab(*cron.split())` 现算、ValueError → 422 带原话——取证 ③ 实测非法串必抛，
  校验器不需要自己写解析）；`next_5` 预览端点（读**未落库**的草稿 cron 也算——抽屉里「预览未来 5 次」
  发生在保存前）：循环 `remaining_estimate` 五次，UTC 进 Shanghai 日历出（workbench 的 DISPLAY_TZ 同尺）。
  删除被通知引用的渠道？不——方向反过来：schedule 引用 channel_ids，渠道删除时**引用检测**（T2 的门）。
- [x] `app/beat.py`：`DbScheduler(Scheduler)` 覆写 `get_schedule()`（R142 形状）——每次从库读
  enabled 行现算 `{name: {"task": "schedule.fire", "schedule": crontab(...)}}`；DB 读失败返回上次快照
  （beat 不许炸，同心跳「静默跳过」哲学）。`@celery_app.task(name="schedule.fire")` 住 worker.py：
  任务体 = 建 run 行（trigger="schedule"，actor=任务创建者语义见 R144）+ send_task `scenario.run`，
  **零执行逻辑**；`update_last_run` 回执。**worker 模块级不 import schedule**（结构钉沿用：任务体内 import）。
- [x] 审计：schedule.fire 落 entry="schedule"（R144）；`core/service.py:19-23` 的过期注释「schedule 二期」同批摘。
- [x] 测试（fakeredis + 内存/临时库，真 beat 不进 CI）：cron 422 表驱动（6 段带秒必拒——取证 ③）/
  next_5 单调递增且落上海日历 / get_schedule 增删改即时可见（改行→下次 get_schedule 反映）/
  DB 挂了吃旧快照不抛 / schedule.fire 投出带 schedule 语义的 run 行 + 审计行 user_id NULL。
- **门禁与自证**：schedule 全家 + 模型 + 回归 `-k "schedule or beat"` 全绿；ruff / mypy 0 错 /
  `lint-imports` **4 kept 0 broken**（`schedule` 进契约 1/3 清单——1D T4 的 pyproject diff 形状）；
  变异自证一次：把 cron 校验摘掉 → 422 表驱动红。
- **演示口径**：起 `celery -A app.beat beat -l info`，建一个 `* * * * *` 任务，看日志里下一分钟真的投出
  `schedule.fire`——beat 进程不在时门禁不红（同 emulator 条款）。
- [x] **前端 §11.4.17 定时任务页（计划补记 2026-11-16：Goal 点名了这页，但 T0–T9 没有任何一条实现它）**：
  `web/src/pages/schedules.tsx` 列表（名称/主体/cron/启用开关/最近一次/连续失败）+ 编辑抽屉
  （场景选择器、环境、cron 三种输入形「每天/每周/自定义」+ 预览未来 5 次、挂渠道多选、
  「连续失败[3]次后通知」）+ `src/api/schedule.ts` + 路由接真 + 把 `shell.tsx:79` 的 `note: "1E 开放"`
  在同一次提交里摘掉（导航诚实条款：入口与页面不许分两次提交）。**没有这页，一期 DoD 的
  「定时」这一拍业主没有入口可点**——e2e（T9）自己造数据不算界面证据。
  <sub>**已交付（commit `b6f93df`，本条 2026-11-17 只读核对后补勾）**：`web/src/pages/schedules.tsx`
  列表六列齐（名称/主体/Cron/启用/最近一次/连续失败，实测 `:391-412`）+ 抽屉（场景选择器、环境、
  cron、[预览未来 5 次] 打 `/schedule-tasks/next-5` 且发的是**未落库草稿**、挂渠道多选取平台级
  `GET /notify-channels` 且 403 时降级只读不编名字）；`shell.tsx` 的 `note: "1E 开放"` 同笔摘除。
  **两处与原文不符，如实记**：① `src/api/schedule.ts` **没建**——页面直接用统一 `api/client` 打路径，
  少一层封装（不是功能缺口，是形状偏离，别再照计划去找这个文件）；② cron 是**两个快捷按钮**
  （`每天 02:00` / `每周一 02:00`，`:259-260`）+ 自由输入框，不是「每天/每周/自定义」三种输入形；
  ③「连续失败[3]次后通知」的**阈值可配未做**（后端 `notify/hooks.py` 写死常量 3，无列无入口），
  同 T3 台账那条口径。</sub>
- [x] **cron 校验的形状修正（2026-11-16 实测，覆盖本任务上文「ValueError → 422」「6 段必拒」两处口径）**：
  `crontab(*cron.split())` 单独用不够——① **段数必须自己数**：`"0 2 * *"`（4 段）被 celery 静默补齐成
  `0 2 * * *` 照收，用户写错段数会入库成一个「没打算要」的排期；② **异常是 TypeError 不是 ValueError**：
  6 段带秒抛 `TypeError: crontab.__init__() takes from 1 to 6 positional arguments`，只 `except ValueError`
  会让它变成 500（蓝图 §6.7 要的是 422 人话）。所以校验器 = 先 `len(parts) != 5 → 422`，再
  `except (ValueError, TypeError)` 落 422 带原话；测试表驱动必须含 4 段与 6 段两行。
- [x] **`next_5` 的第二个坑（同批实测）**：`remaining_estimate(now)` 对 `*/5 * * * *` 在整 5 分时刻返回
  **负值**（`-1 day, 7:25:53`），直接累加会得到非单调序列——抽屉里「预览未来 5 次」必须单调递增。
  口径：以 `now + remaining` 为第 1 次，之后每轮把参考点推进到上一次算出的时刻再估，
  负值按 0 处理（那一分钟就是现在）；测试钉「5 个时刻严格递增 + 落上海日历」。


<sub>✅ **T1 落地证据（2026-11-17 实跑，两个并行 agent 收敛成一套实现 + 领导逐条复核，commit `c0dd8ac`）**：
`schedule/cron.py`（校验与预览的唯一一把尺）+ `schedule/service.py`（CRUD + next-5）+
`app/beat.py`（DbScheduler）+ `worker.py` 的 `schedule.fire` + 三份测试（`test_schedule_1e.py` 14 例
/ `test_schedule_service.py` 30 例 / `test_schedule_beat.py`）。领导复核实测：schedule 全家 +
元工具回归 **82 passed**、`mypy app` **Success: no issues found in 127 source files**、
`lint-imports` 逐字 **`Contracts: 4 kept, 0 broken.`**（schedule 早已进契约 1/3 清单，R64 不假绿）。

三处**实测覆盖计划原文口径**（计划按 celery 文档写的做法在真库里不成立）：
① 上文「循环 `remaining_estimate` 五次 + 负值按 0 处理」的组合做法实测**会非单调**——
`remaining_estimate(ref)` 返回的是 `end(ref) − 真实 now`，累加到参考点上会锚点漂移
（`0 2 * * *` 连算两次得到同一时刻）。实现改用三元组 `remaining_delta(ref)` 的
`start + ffwd`（celery 自己的「下一次」算法），单调性由构造保证，`max(rem, 0)` 补丁不再需要。
② 段数与异常类型两条按「cron 校验的形状修正」落地，另发现**第三个坑**（计划未列）：
celery `crontab()` 位置参序是 分/时/**周/日/月**，标准 5 段是 分/时/**日/月/周**——
`crontab(*parts)` 把「每周一 02:00」(`0 2 * * 1`) 静默错排成每年 1 月 1 日、
把「每月 15 号」(`0 2 15 * *`) 直接 ValueError 拒掉。校验核因此必须按关键字逐段命名。
③ `get_schedule()` 读库失败**不能返回裸 dict**：基类 `populate_heap` 会对每个条目调
`entry.is_due()`，裸 dict 的症状是「beat 活着但永不触发」——必须返回 Entry 并复用在场对象，
否则同名同 cron 的行每轮重建堆、`total_run_count` 归零。

两条**如实未完成**（别当已完成）：
- 「前端 §11.4.17」那条 checkbox **没打勾**：页面本体已落地（`schedules.tsx` + 10 例，
  commit `b6f93df`，nav-cron 的 `note: "1E 开放"` 同笔摘除），但计划点名的
  **「连续失败[3]次后通知」编辑项没有做，且后端没有对应字段**——`TaskCreateIn`/`TaskUpdateIn`
  里没有失败阈值列，做一个界面能填、后端不理的输入框就是 §13 纪律 1 的假门，所以页面只把
  `consecutive_failures` 当只读计数展示（`schedules.tsx:410` 并写了人话说明）。
  **且这不是「待裁」**：本文件 D28 假设（:177）已裁定「连续失败 3 次告警」按 §11.4.17 抽屉做
  **每任务阈值**、告警对象=渠道。真正的缺口是**计划自己跟自己对不齐**——D28 要「每任务可配阈值」，
  而 T0 落 `schedule_task` 时按蓝图 §4:210 字段清单「一列不多」（models.py:5 原话），表上只有
  `consecutive_failures`（账）而**没有存阈值的列**。所以要么补一列（改 T0 的「不多抄列」纪律，需业主点头），
  要么把 3 当常量。T3 的告警按**常量 3** 实现并如实记账，界面不做填了没人理的输入框。
- 计划要求另建 `src/api/schedule.ts`：未建，页面直接用 `api/client` 的 get/post/patch
  （与 `notifyChannels.tsx` 同款，上一批 notify 也没建独立模块）——属形状偏差，不影响功能。
- `test_schedule_1e.py` 与 `test_schedule_service.py` 是两个并行实现的**双份证据**
  （合跑全绿、零冲突），去重另开一笔，本提交不悄悄删任何一方的用例。
</sub>

### T2 · notify_channel 服务面 + 五类渠道发送器（§11.4.26）
- [x] `app/modules/notify/service.py`：CRUD（perm `notify:channel:*`；type 枚举外 422；config 敏感键
  按 D24 加密落库、回显逐键打码 `[已配置]`/`token••••`）；**删除前引用检测**：被任何 schedule_task
  引用 → 409 列引用（复用 scenario_case_refs 的「警告并列出引用」语义）；`测试发送` 端点（POST 但
  perm `notify:channel:read`——1D 的 READONLY glob 坑第三次预警，读类动作必须 `:read` 后缀结尾）。
- [x] `app/modules/notify/senders.py`：五型纯函数 `send(channel, markdown) -> SendResult(ok, latency_ms, error, raw)`；
  **httpx 全部 `trust_env=False`**（R143 契约测试扫源码）；超时 5s（对齐 model_cfg_probe）；
  `except Exception` 吸收一切网络异常回 `type(e).__name__ + str(e)[:180]`（取证 ⑤ 的回环 2094ms 挂起
  现场就是这个 except 存在的理由）。钉钉/企微/飞书 = 各自的 webhook JSON 形状（三家 payload 差异写进
  表驱动测试）；EMAIL = stdlib `smtplib`/`aiosmtplib`？**不引新依赖**——std smtplib 经 `asyncio.to_thread`，
  超时靠 socket timeout（取证 ⑤ 的挂起同理）。
- [x] 测试：本机**假接收端**（aiohttp? 不——stdlib `http.server` 起线程即可）钉 webhook 渠道真发送
  真收到 + 非 2xx 回 ok=False + 连接拒绝回显错误类名；EMAIL 用 stdlib 假 SMTP 收信断言主题/正文；
  加密往返（存进去的 token 在库里 grep 不到明文——**这条是 §10-3 的自证**）。
- **门禁与自证**：notify 全家绿 + `-k "notify or schedule"` 全绿；mypy/ruff/`lint-imports` 同上；
  变异自证：拿掉 `trust_env=False` → R143 扫描例红。出网真探针（取证 ⑤）只做手册里的手工步骤，
  **不进 CI**（429 限流会把门禁变成随机数，取证 ⑤ 现场为证）。

<sub>✅ **T2 落地证据（2026-11-16 实跑，agent 实现 + 领导逐条复核，commit `1efaf08`）**：
`notify/{service,senders,schemas}.py` + `tests/test_notify.py`（12 例）+ `main.py` 注册 1 行。
五型 payload 各表驱动；senders 纯函数永不抛（异常吸收成 `type(e).__name__ + ": " + str(e)[:180]`）；
httpx 全 `trust_env=False` + 5s 超时；EMAIL 走 stdlib `smtplib` 经 `asyncio.to_thread` + socket 超时
——**零新依赖兑现**。D24 逐键 Fernet、回显逐键打码；§10-3 的自证是去 grep 库里原始列字节看不到明文
（token 与 webhook query 段各一条）；PATCH 重放打码回显保留旧密文（否则一存就把密钥洗成掩码）。
删除引用检测跨不到 schedule（契约 1）→ 按 R28 先例走 `JSON_CONTAINS` 表名 SQL，409 计数必报、
明细按 `schedule:read` 门控。测试发送 POST 但 perm `notify:channel:read` + `effect="read"`，
glob 命中有测试钉住。实测：`pytest tests/test_notify.py -q` → **12 passed**；
`-k "notify or schedule"` → **21 passed**；ruff（notify + 测试）All checks passed；
`mypy app/modules/notify` → 5 source files 无问题；`lint-imports.exe` 逐字 `Contracts: 4 kept, 0 broken.`。
变异自证（R143）：摘掉 `trust_env=False` → `test_r143_every_async_client_has_trust_env_false` 红
（`assert 'trust_env=False' in 'timeout=TIMEOUT_S'`）→ 复原回绿。
**如实报的三处**：① 首轮我复核时 8 绿 4 红（`merge_config_for_update` 未写、SMTP 主题断言只认
`?q?` 编码不认 `?b?`、update 走 500），是 agent 未跑完的中间态，非产品缺陷，最终 12 绿由我重跑确认；
② 「全仓 mypy 0 错」本轮**未实测**——并发中 1E T4 的 `api_test/import*.py` 有 7 条，notify 自身 0 条
（grep 亲验），全仓绿留批次收尾；③ 出网真探针**未跑**（按本条口径只进演示手册）。</sub>

- [x] **前端 §11.4.26 通知渠道页（计划补记 2026-11-16，与 T1 的定时页同因：Goal 点名了页面，
  T0–T9 没有一条实现它）**：`web/src/pages/notifyChannels.tsx`（名称/类型/关键配置打码/最近发送
  行内 ✓/✗ + 原始响应展开）+ 新建·编辑抽屉（按 type 切配置表单）+ [测试发送] + `src/api/notify.ts`
  + 路由接真 + 同一次提交摘掉 `shell.tsx:90` 的 `note: "1E 开放"`。
  打码回显在前端**只显示后端给的掩码串**，前端自己截 `••••` 就是第二条假门（后端没给就不显）。

<sub>✅ **落地证据（2026-11-16 实跑，commit `df99402`）**：`pages/notifyChannels.tsx` +
`notifyChannels.test.tsx`（8 例）+ `app.tsx:23/88` 路由 + `shell.tsx:90` 摘 note 挂真路由 +
`e2e/nav.spec.mjs:73-78` 同次提交把 `expectNote("nav-notify","1E")` 换成真页面跳转断言（导航诚实条款）。
掩码列零前端加工；编辑抽屉逐字预填并原样 PATCH，`buildConfig` 纯函数钉逐字相等（对齐
`merge_config_for_update` 的「等值=没改」，否则一存就把密钥洗成掩码）；[测试发送] 跟
`notify:channel:read` 走（后端 perm 就是 `:read`，不按「POST 即写」猜）；删除 409 在 `details_hidden`
时只报计数不编明细。实测：vitest 8 passed、`tsc --noEmit` 0 错、`pnpm lint` 0 errors / 7 warnings（持平）。
**与本页 checkbox 原文的两处口径分歧（按现状为准）**：① 原写「`src/api/notify.ts`」——实际**未建**，
API 走 `client` 的 get/post/patch + 就近局部 interface（与 adbDevices 同法，且并发期禁跑 gen-api，
建一个引用未生成类型的 api 文件只会把 T9 的债提前埋进来）；② 任务书里要的「启用态」列后端**没有该列**
（`notify_channel` 无 `enabled`），前端不造假开关，页面无此列——要启停得先加列，属后端增量。
另三处后端形状限制如实记：PATCH 不收 `type`（换类型只能新建后删旧，抽屉置灰说明）、
平台级资源无创建人（页面标「全项目共用」）、config 必填键后端只在发送时裁决（前端做预检但裁决权在后端）。
**未跑**：`scheduleNotify` 之外的 e2e 全套（含本条 nav 断言）需起后端 + `build:e2e`，按批次口径留 T9。</sub>

### T3 · 定时执行接线 + 通知模板：**「定时→通知」DoD 闭环就关在这一个任务**
- [x] run 终态 → 通知的接线走 **core 钩子注册表**（`set_audit_writer` 的既有形状：core 定义
  `set_run_finalized_hook(fn)`，`main.create_app` 装配时把 notify 的实现注进去）——
  **execution/scenario 零 `app.modules.notify` import**（契约 1/4 双双保住；事件总线跨模块是备选，
  但 solo worker 每任务一个新 loop，常驻订阅者的 loop 绑定问题 1D 注释里翻过车，钩子同进程同步调最钝最稳）。
- [x] `notify/template.py`：§6.7「执行结果摘要(Markdown)」——纯函数 `render(summary) -> str`：
  场景名/触发方式/结果/通过率/耗时/环境/执行人 + 「打开报告」链接（前端相对路径，不拼绝对 URL——
  平台无外部 base_url 配置，拼了就是假链接）；run_record 里没有的字段不显示（workbench docstring
  的诚实口径同尺）。
- [x] 触发语义：`schedule.fire` 只投 run；**通知住在终态钩子里**（trigger=schedule 的 run 终态 →
  按该 schedule 的 notify_channel_ids 逐个发 + `last_run` 更新 + `consecutive_failures` 累计/清零；
  达阈值 3（每任务可配，§11.4.17）→ 再发一条告警摘要到同渠道）。手动 run 终态不通知（一期只有定时挂渠道，
  没有「所有执行都通知」的全局开关——别造）。
- [x] 测试：全链路 FakeClock——定时投出→run passed→假 webhook 收到 Markdown→逐字段钉（通过率口径
  Σpass/Σ(total−skip) 与 workbench/report 同一把尺）；连续失败计数 2→3 触发告警行；发送失败
  `last_send.ok=False` 且**不碰** consecutive 计数（通知坏了 ≠ 执行坏了）；钩子异常吞掉并落 last_send
  （通知炸不许把 run 收尾带崩——run 行已 commit 在钩子之前）。
- **门禁与自证**：`-k "notify or schedule or run"` 相关全家绿；mypy/ruff/`lint-imports` 4 kept 0 broken
  （钩子注册在 core，**core 不许 import notify**——契约 2 由 lint-imports 白纸黑字守着）；
  变异自证：把钩子调用挪到 run commit 之前 → 「通知炸不崩 run」例红。
- **演示口径（业主亲眼看 DoD 后两拍）**：建 `* * * * *` 定时挂本机假接收端渠道 → 下一分钟
  报告中心出现 trigger=定时 的 run + 接收端日志出现 Markdown 摘要。

<sub>**落地（`48d8ae1`）**：`core/service.py:153-186` 加 `set_run_finalized_hook`/`run_finalized`，
`main.py` 装配期注册 `notify.hooks.on_run_finalized`，唯一挂载点 `scenario/engine/runner.py:545`
（`run_graph` 终态 commit **之后**；摘要在 commit 前取齐标量，避开 expire_on_commit 的 MissingGreenlet）。
`notify/hooks.py`（trigger 闸 + 逐渠道发送 + last_run/last_send + consecutive_failures 唯一写入点）、
`notify/template.py`（白名单键控 Markdown 渲染，无密钥）。</sub>

<sub>**主线独立复跑（不引 agent 数字）**：`test_schedule_notify_hook` 8 passed；
`+test_notify+test_schedule_service` 44 passed；`-k "notify or run_graph or orchestration or engine"` 
130 passed；`test_schedule_beat` 单跑 7 passed；ruff All checks passed；mypy Success（130 files）；
`lint-imports` 逐字 `Contracts: 4 kept, 0 broken.`。四文件合跑曾见 40 errors，是同批去重 agent 正在改
`test_schedule_service.py` 的采集期并发，单跑即绿——记为环境噪声，不记为缺陷。</sub>

<sub>**与计划的分歧（照实记，不顺着计划写）**：①本条要求的「全链路 FakeClock」**没做**，改用
真 `fire_task` + 真发送器 + 假接收端（不 mock 执行链，比 FakeClock 强，但**时钟是真的**，
跨月/夏令时类边界不在覆盖内）；②计划写「达阈值 3（**每任务可配**，§11.4.17）」——
`schedule_task` 表只有 `consecutive_failures`（账）没有阈值列，按 T1 补记裁定**按常量 3 实现**，
「可配」这一格实际未交付，要么补列要么改 §11.4.17 文案，属业主口径；③计划要求的变异自证是
「把钩子调用挪到 commit 之前 → 例红」，实测改做两条等价更强的：摘掉 `set_run_finalized_hook` 行 →
「渠道必须真收到且只收到一次」红（`assert 0 == 1`）；摘掉 core 的 try/except → 「通知炸 run 仍 passed」
红（`assert 'error' == 'passed'`，异常回灌 `_run_claimed` 把 passed 改判 error）。已复原转绿；
④**演示口径未实测**：真 `celery beat` + 真接收端的业主动线本轮**没跑**（共享库禁写 + beat 进程不在门禁内），
门禁 ⑧ 还有一处硬阻塞——demo 库停在 0020、head 0022，`schedule_task`/`notify_channel` 两张表
在业主环境**不存在**（详见 1G 计划同名小节）。所以「定时→通知闭环」目前的诚实边界是：
**测试与临时库已证，业主环境点击不可用**。</sub>

### T4 · 导入解析三源（OpenAPI3 / Swagger2 / Postman）+ 三步向导（§11.4.6）
- [x] `api_test/importers.py` **纯函数**（stdlib json + 手写映射，不引 openapi 解析库——§5.4 没点名它）：
  三源 → 统一 `ImportItem(name/method/path/request §7.1 形状/source_ref)`，**永不抛**：每源一个
  `parse_*(text) -> ParseOutcome(items, errors[])`，坏 JSON/缺 paths/Postman v2.0 与 v1 的 `items` 递归
  全进 errors 人话列表。`$ref` 展开做一层本地引用（`#/components/schemas/…` 的 example 取值），
  递归/外部 ref 如实报「不支持的外部引用」不猜。
- [x] 冲突比对在 service（`api_import_preview`，perm `api:def:create`——导入就是建接口，别造第四个权限位）：
  按 **method+path 归一路径**（`/order/{id}` 与 `/order/:id` 归一 Postman/OpenAPI 两种占位语法）比对现有
  接口 → 新增/冲突计数 + 逐条策略（跳过/覆盖，**D26：无「新版本」**）。
- [x] `api_import_commit`：逐条 create/overwrite，**整批一事务**（回滚整批 = 不 commit，§11.4.6 步骤③
  「回滚整批」的实现就是它）；覆盖走 update + diff 进审计（D26 兜底）；结果回执 成功n·失败n +
  失败逐条原因（「下载错误报告」= 前端把 errors[] 存 blob，无后端端点）。URL 来源（步骤① 的 URL 框）：
  **httpx 拉取带 `trust_env=False` + 5s 超时 + 大小上限 2MB**（R143 的第四次踩坑预防）。
- [x] 前端 `ImportWizard.tsx`（antd Modal 960 三步 Steps，§11.4.6 逐块对照）+ 两处入口接真：
  `workbench.tsx:68` 的快捷卡「导入 [1E 开放]」与 api.tsx 列表页 [导入][导出] 钮（§11.4.2 标准形），
  导航/入口的「1E 开放」哨兵在同一次提交换成真路由（1D T8 的导航诚实条款）。
- [x] 测试：三源各一份**真样本**夹具（官方 petstore/openapi3 示例 + Postman 官方 echo 集）表驱动；
  坏 JSON/空 paths/嵌套 folder/外部 $ref 全走 errors；冲突表驱动（同 path 不同 method、参数占位异构归一）；
  回滚 = 半途失败后现有接口一行未动。
- **门禁与自证**：`-k import` 全家 + api_test 回归绿；vitest 向导状态机例（三步流转/策略切换计数联动）；
  ruff/mypy/`lint-imports`（importers 是 api_test 内部纯函数，不新增跨模块边——新增边就违契约 1）。

<sub>✅ **T4 落地证据（2026-11-16 实跑，agent 实现 + 领导逐条复核，commit `5032cc1`）**：
`api_test/{importers,import_services,schemas}.py` + `tests/test_api_import.py`（11 例）+ 三份真样本夹具
（`fixtures/import/{petstore_openapi3,order_swagger2,echo_postman_v2}.json`）+ `main.py` 注册 1 行 +
`web/src/api/ImportWizard{,.test}.tsx`（6 例）+ `web/src/pages/api.tsx` 入口接真。
importers 纯函数三源 → `ImportItem(§7.1 形状)`，永不抛（坏 JSON/缺 paths/Postman 嵌套 folder/
两级本地 $ref 全进 errors 人话列表）；冲突按 method+path 归一路径（`{id}`/`:id` 同归一）表驱动；
commit 整批一事务（半途失败现有接口一行未动）+ 覆盖走 update + diff 进审计（D26 无「新版本」）。
URL 来源 `trust_env=False` + 5s + 2MB 上限（`import_services.py:27/34-44`，R143 第四次预防）。
`core/service.py` 开公开口 `write_audit(...)`：批量导入逐条 before/after 只在 service 体内凑齐，
装饰器层 produced 摘要装不下；仍走 `set_audit_writer` 同一钩子，core 不认识 audit（契约 1 保住）。
入口两处哨兵换真：api.tsx 顶栏 [导入]（canCreate 且非回收站才显，本次 `5032cc1`）；
workbench.tsx:72 快捷卡「导入」不再是 disabled 占位——那半在 T6 `ac6135f` 已先落（导航诚实条款，
两笔合起来才是本条完整兑现，故本 checkbox 记 T4 但 workbench 那一格归 T6）。实测：`pytest tests/test_api_import.py -q` → **17 passed**（领导重跑）；
`npx vitest run src/api/ImportWizard.test.tsx` → **6 passed**（隔离）；`ruff check app tests` 本任务文件干净；
`lint-imports.exe`（cwd=backend）逐字 `Contracts: 4 kept, 0 broken.`。
**如实报的两处**：① 全仓 mypy/ruff 本轮**未全绿**——并发中 1F T1 的 `agent/metatools/read_tools.py`（7 mypy）
与一期权限矩阵 agent 的 `tests/test_permission_matrix.py`（1 ruff F821）是别的在飞产物，本任务文件 0 错由 grep 亲验；
② `schema.d.ts` 未重生成（并发禁跑 gen-api，已记 T9 台账）。
**计划与实现的口径分歧**：D26「无新版本」按计划落地（覆盖 = update + diff 兜底），无偏离需回填。</sub>

### T5 · 导出备份：资产导出与导入往返自证
- [x] `api_export`（perm `api:def:read`，POST 动作 `:read` 后缀——glob 坑）：勾选/全量的接口集 →
  **OpenAPI3 文档**（§7.1 request 逆映射回 paths/components；选 OpenAPI3 而不是私有 JSON：
  「导出备份」的文件要能被 T4 的解析器吃回去，私有格式 = 自证无门）。
- [x] **往返自证测试（本任务的命门）**：导出 → 导入（全跳过策略）→ 冲突计数 == 导出条数、零新增；
  导出 → 换 project 导入 → 条数一致且 request 逐字段等值（`§7.1` 对象 `==` 深比对）。
  **未覆盖场景如实报**：Postman 导出**不做**（蓝图只说「导出备份」未定格式，单格式 + 往返自证 >
  两格式都没自证）。
- [x] 前端 api.tsx 批量条接 [导出]（blob 下载，复用导入错误报告的 blob 工具）。
  **口径分歧（2026-11-16 落地时如实记，别当已完成）**：后端 `api_export` 收 `definition_ids`（缺省=全量），
  但 api 列表页**没有行勾选**，所以前端只做了「全量导出」，本条的「批量条」半边没做。
  要补的是列表行选择 + 选中时把 ids 传进去（后端零改动）；不补就在 README 把导出口径写成「全量备份」。
  **✅ 已补齐（2026-11-17，commit `39b2e88`）**：`api.tsx` 挂 `rowSelection` + 批量条
  「已选 N 项 / [导出选中]」，顶栏钮改名 `[全量导出]`（testid `api-export` 不变）。两个动词把两种
  口径写在 UI 文案上，所以「勾了 3 条点导出悄悄变全量」这种 §13 纪律 1 的假门在结构上不存在；
  全量那条**请求体永不带** `definition_ids`。回收站视图不挂 rowSelection、`load()` 后清空勾选。
  blob 落盘抽成 `ImportWizard` 的 `downloadBlob`（`downloadErrorReport` 改为调它，行为不变）。
  实测：vitest `src/pages` → 10 files / 81 passed（新增 3 例：选中 2 行 ids 恰为这 2 个 / 勾选后点
  全量 body 无该键 / 未选中全量 body 无该键）。**变异自证**：摘掉 `...(ids ? {definition_ids: ids} : {})`
  后只有「ids 恰好是这 2 个」那条红，其余 9 条仍绿。
- **门禁与自证**：往返测试红 = 任务没做完；vitest 下载触达例；三道后端门禁 + `lint-imports` 逐字。

<sub>✅ **T5 落地证据（2026-11-16 实跑，agent 实现 + 领导逐条复核，commit `893eba7` + `665e9ed`）**：
`api_test/export_services.py`（`build_openapi_doc` 纯逆映射 + `api_export` @service，perm `api:def:read`、
POST 但 `:read` 后缀走 glob 规则）+ `tests/test_api_export.py`（7 例）+ `schemas.py` 两枚模型 +
`importers.py` 两行镜像 + `api.tsx` [导出] + `api.test.tsx`（3 例）。
**命门（往返自证）三条都真跑了**：① 导出→同项目 preview/commit 全跳过 → `conflict_count==4`、`created==0`、
现有行 `version` 仍是 1（一行没动）；② 导出→**另一个项目**（新用户新库）→ 条数一致且每条 `request` 深比对等值；
③ 四类刁钻形状逐字段（`/order/{id}` 路径参数 + query/header example + `timeout_ms=15000` + 断言 /
json body / form `k=v&k=v` / 正文含 `&`）。
**导出↔导入的咬合点**（本任务真正难的地方）：§7.1 的 `timeout_ms`/`assertions` 在 OpenAPI 没有概念位，
导出端用 `x-tp-timeout-ms`/`x-tp-assertions` 扩展携带、导入端 `_openapi_op` 逐字读回——
没有这两行镜像，深比对**可证地**丢字段。读回仍过 `RequestObject` 校验（`schemas.py:53-62`：
`timeout_ms` 有 `ge=1/le=120000`、`assertions: list[Assertion]`），不绕过 schema 塞脏数据。
如实报（不静默、不放宽比对）：form 值含 `&` 或重复键（example 对象装不下）→ 该条**不导出** + note；
base 不合 `servers[0]` 大流 → 改写 + note；json 空白规范化 → note；草稿无 request → note。
变异自证：删掉 `schema_out[skey] = schema`（components 不注册）→ **4 例红**
（`AssertionError: assert ['PATCH /orde...d__text（已忽略）'] == []`、`KeyError: 'content'`）→ 复原 7 绿。
实测：`pytest tests/test_api_export.py tests/test_api_import.py -q` → **24 passed**（领导重跑）；
mypy → `Success: no issues found in 123 source files`；ruff（api_test + 测试）全绿；
`lint-imports` 逐字 `Contracts: 4 kept, 0 broken.`；vitest `api.test.tsx` **3 passed**、`tsc --noEmit` **全局 0 错**。
**领导补的两刀**：① `api.test.tsx:88` 塞 `my_role: null` 把门禁 ⑥ 弄红（store 里是 `string`），
该例本意是「显式 `my_perms` 覆盖内置角色表」（`perms.ts:45` 服务端优先），填 `READONLY` 即可；
② 第一次提交时该行改动没进索引（`git add` 在编辑之前），HEAD 自己过不了 tsc——
故补 `665e9ed`，**门禁必须对提交态成立，不是对工作树成立**。</sub>

### T6 · 工作台收尾（§11.4.1 补齐 + 导航诚实）
- [x] 后端 delta 一条：`AssetCounts` += `adb_case`（取证 ①：1D 落地后统计卡口径过期；1D 计划 T8 把
  「工作台计数」写给了 1D，**若 1D T8 已改此项则本条作废只做核对**——两批计划在此有一处交叠，
  先到先得、后者只钉测试，改前先改本文件）。
- [x] 前端 `workbench.tsx` 对 §11.4.1 逐块核对：统计卡四枚（资产总数=四+一类求和/近7天执行/通过率/
  失败TOP）、趋势折线（已有 workbenchTrend.tsx）、最近执行 10 条、我最近编辑 10 条——**实测缺口再补，
  不缺不硬做**（本任务最可能只剩 adb_case 的展示位与「待我处理→最近执行」的文案核对）。
- [x] 统计卡资产总数加 adb_case 后，`my_recent_edits_types` 诚实标注机制不动（adb_case 有 updated_by
  列**但 1D 已把编辑者语义写死了吗——读 1D 落地码再定，没把握就维持 scenario/ui_case 两类，宁缺毋伪）。
  **✅ 核对完（2026-11-17，只读取证，零代码改动）**：诚实机制原样在位三处——
  后端默认值 `workbench/services.py:107` `["scenario","ui_case"]`、榜单查询只查这两张表、
  前端 `workbench.tsx:180` 把 `覆盖：…` 直接打在分节上；测试钉了两头
  （`test_workbench_stats.py:239` 与 `:283` 断言集合恰为这两类，加一类不改前端就红）。
  统计卡那条也已吃进 adb_case：`services.py:170` 计数 + 前端 `workbench.tsx:107/109`
  总数求和与明细都带 ADB。**裁定=维持两类**（本条给的「没把握就维持」分支）：
  1D 写路径确实全写了 `updated_by`（`adb_test/case_services.py:126/180/229/255` 建/改/删/恢复），
  所以「有编辑者语义」成立、加宽是**可行**的；但加宽要连前端分节与 `editTypeLabel` 同批改，
  属于口径变更而不是本条要求的「机制不动」，按宁缺毋伪留着，谁要做就连带把两处测试期望一起改。
- **门禁与自证**：`workbench.test.tsx` 改期望值不改判定（0020 链头钉同款纪律）；vitest 全绿基线
  **231 → 只增不减**（今天实测基线，取证 ⑨）；后端 workbench 测试 + `-k adb` 交叉回归绿；四道后端门禁。

### T7 · 审计查询增量（§11.4.27）
- [x] `AuditListIn` += `ts_from/ts_to`（ISO 输入，Shanghai 日历日语义与 workbench 窗口同尺——
  取证 ①：现在只有游标没有区间）+ 索引核对（ts 有 index，实测 models.py:16）。操作人筛选走 user_id
  已有；**入口枚举前端露出「定时」**（词表早备好了，取证 ④，T1 后真有数据）。
- [x] D23 硬门：`audit_list` 加 `ctx.is_system_admin` 检查 + **权限位回归测试**（READONLY 角色
  调 /audit 必 403——取证 ⑧ 的 glob 命中当场钉死）；`tool=False` 补标（D29）。
- [x] 前端 settings.tsx AuditTab：时间区间控件 + 入口加「定时」+ 行 [diff] → 双栏 JSON 对照模态
  （before/after 高亮：不引 diff 库，双栏并排 + 不同 key 标色即可——§11.4.27 画的就是双栏对照不是行内 diff）。
- **门禁与自证**：审计 403 例（READONLY/MEMBER/PROJECT_ADMIN/SYSTEM_ADMIN 四角色矩阵——一期 DoD
  「权限矩阵测试」在审计页的具体化）；vitest diff 模态例；`pnpm lint` **0 errors 基线不破**、
  vitest 231 基线只增不减；四道后端门禁 + `lint-imports` 逐字。

<sub>✅ **T7 落地证据（2026-11-16 实跑，agent 实现 + 领导逐条复核，commit `4a0fc28`）**：
`audit/services.py`（区间解析 + 两道门）+ `tests/test_audit_query_1e.py`（7 例）+
`web/src/settings/{AuditTab.tsx,AuditDiffModal.tsx,AuditTab.test.tsx}`。
`ts_from/ts_to` 形状修正：纯日期 `YYYY-MM-DD` 走 Shanghai 日历日边界（含起、**到日画一整天用
次日 00:00 开区间**——MySQL DATETIME 秒级，减 1 微秒会撞边界）；完整 ISO aware 按自身偏移、
naive 视为东八区本地（与 workbench 窗口同尺的那句原话落地）；**认不出直接 400**——
静默忽略筛选 = 假装查了整段历史。游标与区间叠加有例（`test_audit_ts_range_with_cursor`）。
D23 用身份检查而非只靠权限位：角色模板可编辑、glob 会漂移，`ctx.is_system_admin` 不会；
`test_audit_d23_gate_load_bearing` 把这道门钉成「摘掉必红」。D29 `tool=False` 退出工具面 +
`test_audit_list_not_agent_tool` 钉住（审计是业主核查 Pilot 的镜子，不该出现在 Pilot 自己的工具箱）。
入口枚举「定时」已露出（`test_audit_entry_schedule_enum_exposed`）——T1 落地前无真数据，
例内自造行验证枚举通路，不假装库里有。实测：`pytest tests/test_audit_query.py
tests/test_audit_query_1e.py tests/test_golden_1a.py -q` → **13 passed**（旧审计例一条没改期望值）；
`npx vitest run src/settings/AuditTab.test.tsx` → **6 passed**（隔离）；
`lint-imports.exe`（cwd=backend）逐字 `Contracts: 4 kept, 0 broken.`；ruff 本任务文件干净。
**如实报的两处**：① 四角色矩阵在此只落了「审计页」那一格（403 矩阵例在 test 内），
一期 DoD 第 3 条要求的**全站 4 角色 × 主要接口**矩阵另有人在做（未落地，别把这条当已交）；
② `pnpm lint` 与全量 vitest 基线本轮**未实测**（并发中只跑隔离文件），留批次收尾。
**同批补测（2026-11-16，领导在全树提交后跑）**：② 已补平——`pnpm lint` **0 errors / 7 warnings**
（AuditTab.tsx:49 那条 exhaustive-deps 属既有 warning 形状，未新增 error）、全量 vitest
**260 passed / 20 files**、`tsc --noEmit` 0 错。另：T7 的 agent 复核口径修正——READONLY 的
`*:read` glob **确实**命中 `system:audit:read`，挡住它的是 `_project_scoped` 追加的 `-system:*`（R30）；
所以 D23 的身份门不是冗余保险，是「perms 泄漏成 `{"*"}` 时最后一道」的承重墙，
`test_audit_d23_gate_load_bearing` 摘门必红即为此证。</sub>

### T8 · 模型配置中心（§6.8 补探测增量 + §11.4.23 卡片墙）
- [x] **逐能力探测**（现状实测=回显存储位，取证 ①）：`model_cfg_probe` 升级为逐项真探——
  tools：发一条带 `tools[]` 的最小请求看是否 400/tool 字段被吞；thinking：带思考档参数看响应里
  思考块在不在；vision：带 1px 图 base64 看拒否。**每型探测的判定表写进 `probe.py` 纯函数**
  （假网关脚本夹具逐型喂好/坏/含糊响应）；含糊/超时 → 该能力位**不改存储值**并在 probe_result
  标 `unknown`（探测不许把「没测出来」写成「不支持」——假阴性比缺值更害人）。
  EMBEDDING：`embed("ping")` 回填 `embed_dimensions`（取证 ①：列在、零写入代码——§6.8 原话兑现点）。
- [x] 出厂种子增量：seed 后**首启异步跑一次探测**回填能力位（§6.8 原话「首次启动跑能力探测」）；
  网关不可达时静默跳过同心跳哲学（一次性 warning）；thinking 档 medium 落 `temperature_default`
  旁边新开 `thinking_levels` 含 medium 的默认（§6.8「默认思考档 medium」的唯一落点）。
  `.env` 的 key 注入路径现状已对（不落仓库，`.env` 实测只有 URL/NAME 两行）。
- [x] 前端 `settings.tsx` 加「模型」tab：§11.4.23 卡片墙（能力 ✓/✗ 徽标、探测延迟、[连通性测试]
  逐能力展开、[设为默认]、向量模型隐藏思考/视觉位 + [维度探测] 钮）。
- [x] **D29 落地**：写类维持 tool=False 并在注册覆盖率测试里显式豁免点名（1D「豁免守门例」同形——
  豁免要可数、有名字，不许靠 glob 漏网）。
- **门禁与自证**：假网关夹具表驱动（三能力 × 支持/不支持/含糊 = 9 形状 + EMBEDDING 维度回填）；
  首启探测幂等（跑两次不多行）；vitest 卡片墙渲染例（能力徽标/默认★/向量隐藏位）；四道后端门禁 +
  lint-imports（model_cfg 不新增跨模块边）。
- **诚实条款**：真网关（127.0.0.1:9000）探测**未实测**（本机网关在否不赌，取证 ⑪）——e2e/演示走
  假网关脚本（`shared/fakeuri` 的既有约定），真网关只在演示手册里作为业主手持步骤。
  <sub>**T8 四条 2026-11-17 补勾（commit `4eea663` 早已落地，四条 checkbox 一直没回填）**：
  逐条对过代码——`model_cfg/probe.py` 三判定纯函数齐（`judge_tools`/`judge_thinking`/`judge_vision`
  + `CAPS` 三态，含糊→`None` 不改存储位）、`seed.py:59 probe_backfill` 只回填 unknown 空位且
  「第二次同果 = 零写入」、`seed.py:52` 出厂 `thinking_levels=["low","medium","high"]`、
  `settings/ModelTab.tsx` 卡片墙（✓/✗/**? 三态**、默认★、向量隐藏思考/视觉 + [维度探测]）、
  D29 豁免名单在 `tests/test_model_cfg_probe.py:386` 起（名单变了例必红，`set(by_name)` 逐名比）。
  **本轮实测**：`pytest tests/test_model_cfg_probe.py tests/test_model_cfg.py -q` → **16 passed**；
  `vitest run src/settings/ModelTab.test.tsx` → **10 passed**；`lint-imports`（cwd=backend）
  逐字 `Contracts: 4 kept, 0 broken.`。**仍未实测**：真网关探测（本机 9000 在否不赌，口径同上条）。</sub>

### T9 · e2e + 演示手册 + 收尾（**一期 DoD 证据 e2e 在这条**）
- [x] **`scheduleNotify.spec.mjs` = §13:1600「混合场景执行→报告→定时→通知」的 DoD 证据**：
  建混合场景（API+等待+UI(mock 驱动)+adb(mock 设备)——夹具复用 1D T10 的）→ 挂 `* * * * *` 定时 +
  本机假 webhook 渠道（e2e 后端起 stdlib 接收端，端口进 `playwright.config.ts` 的 env 面，
  db.internal.test 的 Redis/MySQL  creds 沿用现有配置）→ 等触发 → 报告中心 trigger=定时 着色 →
  接收端收到 Markdown（主题含场景名、正文含通过率）→ 审计页入口=定时 有行。**这条红 = 一期 DoD 没闭合**。
  <sub>✅ **落地证据（2026-11-17，commit `387b165`）**：`web/e2e/scheduleNotify.spec.mjs` 两条 test，
  实测 **2 passed / 0 skipped（11.1s）**、eslint 0 错。三处与原文的口径差异按实回填，不假装照抄：
  ① **「等触发」被换成调 `fire_task` 本体**——原文设想的「e2e 后端起接收端 + 等 cron」在现行装配下
  不成立：8321 是 `uvicorn` + `TP_EXEC_MODE=inline`，进程内没有 beat（`DbScheduler` 只活在
  `celery -A app.beat beat` 里）。规格因此调 worker 任务体同款的 fire_task 真实入口（建 run + 投 broker
  + entry=schedule 审计 + last_run 回执全在里面），并**自起真 celery worker 子进程**（`tp.e2e` 队列、
  afterAll `taskkill /T` 必杀）消费执行——被人工替代的只有「到点」那一拍，不是触发逻辑；
  且规格绝不自起 beat（追加式共享库会把历轮 enabled 行全触发一遍）。业主手动步骤写进头注。
  ② **接收端在 spec 文件内起 `node:http` 临时端口**，没动 `playwright.config.ts` 的 env 面——
  那是三个 webServer 共享的文件，并发改它会踩别人在飞的规格。
  ③ **定时那条挂的场景是 `http_direct`+`sleep` 两步全绿**（通过率 100.0% 与钩子模板同尺），
  不是原文的「API+等待+UI+adb」四主体——UI/adb 主体由 `mixedScene.spec.mjs` 专钉，本条要证的是
  「定时→执行→通知→报告→审计」这一串，把 mock 设备再拖进来只会让它更慢更脆，不增证据力。
  导入腿（判据第 1 条）另在 `importWizard.spec.mjs` 用例 ⑥，见下一条。
  **⚠️ 上面 ③ 的这条裁定已被 `5eba59d` 反转（2026-11-17 回填，理由记下别当无事发生）**：
  「更慢更脆不增证据力」错在**它省掉的正是 DoD 原话的前两拍**——§13:1600 是
  「混合场景执行→报告落库→定时触发→通知真实送达」四拍，原形状只证了后两拍，前两拍由
  `mixedScene` 另证，于是**这条号称 DoD 证据的规格里从没跑过一次混合场景**。现在 ② 是独立的
  「四主体 manual run → 报告」，③ 的定时 run 通过 chain 挂到同一个真混合场景上，四拍一条串通。
  顺带按尺纠数：四主体 fail_fast=false、uin 恒挂 → 3/(4−0)=**75.0%**（不是 100.0%，也不是
  fail_fast=true 会造出的 2/3=66.7% 假数）；报告环 `data-percent=75` 与 ③ 通知正文「通过率：
  75.0%」同一把尺两处对账。**实测连跑三轮均 3 passed**（36.9s / 35.8s / 主线复跑 43.3s）。
  本条仍是**代理证据**：被人工替代的只有「cron 到点」那一拍，业主手动 30 分钟走查仍是交付步骤。</sub>

- [x] **§1.5 判据第 1 条的「导入腿」补进闭环（计划补记 2026-11-16，只读审计查出来的半认领）**：
  判据原文（蓝图 `:50`）是「新人 30 分钟内走通：建项目 → **导入 20 接口** → 建混合场景 → 执行 →
  看报告」，而现有金线（`test_golden_1c.py:181`、`web/e2e/mixedScene.spec.mjs`）**都不含导入腿**——
  T9 原文只串了「定时→通知」，等于判据第 1 条一直没被任何批次真正测过。本条要求：
  要么在 `importWizard.spec.mjs` 里把「导入 20 条真样本 → 用导入的接口建场景 → 执行 → 报告出现」
  串成一条 DoD 级用例，要么显式写明判据第 1 条仍只有代理证据（自动化不等于「新人 30 分钟」）。
  **不许默默当作已完成**——「30 分钟走通」本质是人工验收口径，任何自动化都只是代理，
  诚实做法是两条腿都有 e2e 代理 + 手册里写清业主手动步骤。
  <sub>✅ **落地证据（2026-11-17，commit `8375dab`）**：`importWizard.spec.mjs` 新增用例 ⑥ 走的是
  原文的第一条路（真点向导三步 × 三份真夹具 → 用导入的接口建用例/场景 → 执行 → 报告中心 +
  详情页断言），实测 **6 passed（19.5s）**。**量级如实打折**：三份官方夹具可解析条目只有
  5+3+4=**12** 条，Postman 有 2 条与 Swagger2 撞 method+归一路径键（冲突），勾跳 1 条后**真落库 10 行**，
  用例按 `CHAIN_DEFS` 逐名对账。所以「导入 20 接口」的**量级没被证到**——没有 ≥20 条真样本就不演 20 条，
  这条勾只结「链条走得通」，判据第 1 条整体仍是**代理证据**，业主手测 30 分钟仍是交付步骤。
  补样后可加强本用例（后端/业主侧的事，不在本批）。</sub>

- [x] **一期 DoD 第 3 条「权限矩阵测试」补上归属（计划补记 2026-11-16，只读审计查出来的第二条无主需求）**：
  判据要的是 4 角色 × 主要页面/接口，而 1A–1F 六份计划里**没有任何一条实现它**（`perms.spec.ts` 只测
  角色 CRUD 本身，`AuditTab` 只钉审计页那一格）。已落地 `backend/tests/test_permission_matrix.py`
  （commit `5508097`，116 格 = 29 行 × 4 角色 + 6 跨项目隔离 + 覆盖率钉 + 角色表快照钉，实测 119 passed）。
  **判定不是同义反复**：perm 点从 REGISTRY 运行时取，期望值来自 §4.1 角色表字面快照 + 独立实现的
  §10-1 glob（故意不用 `app.core.permissions.match_perm`）——否则「实现自己验自己」必绿。
  T9 收尾要做的两件：① 前端角色用例现状只有 adb 三页（模块 docstring 已如实写明「只测后端接口面」），
  要么补 2–3 个关键页的按钮隐藏例，要么在 README 把判据第 3 条标成「接口面已证、UI 面抽样」；
  ② `KNOWN_PREFIX_FAMILIES` 里 `schedule`/`notify` 注着「1E 在飞」，T1 落地后把注摘掉。
  **② 已结（2026-11-17 回填）**：`ROWS` 补了 `schedule_task_list`（GET `/schedule-tasks`）与
  `schedule_task_create`（POST，subject 用角色自备场景）两行——写行不是凑数：`schedule:task:create`
  位只有这一个命中面，MEMBER 的 `-*:delete` 豁免差异只在写面上可见。矩阵从 35 行/140 格长成
  **37 行/148 格**，`--collect-only` 实测 **151 collected**（= 37×4 + 3 条非矩阵钉），docstring 按实测改；
  `KNOWN_PREFIX_FAMILIES` 上方「在途豁免」旧注重写为「如实登记已认族」，集合本身一字未动
  （摘掉任何一项都会让前缀覆盖钉红，那才是它真正的用处）。8 格新格按 §4.1 角色表推导全绿，
  未登记新 KNOWN_HOLES。
- [x] `notifyChannel.spec.mjs`（渠道 CRUD + 测试发送行内 ✓/✗ + 打码回显）、`importWizard.spec.mjs`

  （三步走真样本 + 冲突逐条跳过 + 回滚整批后列表行数不变）、`settingsTabs.spec.mjs`（模型卡墙 +
  审计双栏 diff + READONLY 看不到审计 Tab 且 API 403）。
  <sub>✅ **三份都在仓（2026-11-17 回填）**：`notifyChannel.spec.mjs` 228 行 + `importWizard.spec.mjs`
  同批 `c7c4ff9`；`settingsTabs.spec.mjs` 174 行 = `a0a25f5`。
  **2026-11-17 主线实跑补齐（两份同一次合跑，机器上只有 8320/9999 被并发规格占着，
  `reuseExistingServer` 吃得住 9999）**：`npx playwright test e2e/notifyChannel.spec.mjs
  e2e/settingsTabs.spec.mjs` → **7 passed (24.3s)**；`scheduleNotify` 单跑 **2 passed (11.3s)**、
  `importWizard` 6 passed / 19.5s。
  **数字更新（`5eba59d` 之后）**：`scheduleNotify` 现为 **3 passed**（多了第②条混合场景腿，
  实测 36.9s / 35.8s / 43.3s 三轮），上面那句 2 passed 是它当时的真实数字、留着不改史。
  本条只结「三份规格存在且**各自实跑过**」——单跑绿不等于全量合跑绿（e2e 库是追加式共享库，
  跨规格污染就是在全量合跑那一步才暴露），全量 ⑦ 的数字仍属下面的收尾条。</sub>

- [x] **`node scripts/gen-api.mjs` 重生成 `src/api/schema.d.ts`（计划补记 2026-11-16：本批新增十几个
  @service 端点，但 T0–T9 没有任何一条认领这笔账）**：本批会新增 `notify-channels`（CRUD + delete +
  test）、`api-import-preview/commit`、`schedule-tasks`（CRUD + next-5）、`api-export`、model-cfg 探测
  增量——`schema.d.ts` 是**提交态的生成物**，不重生成就是「前端类型落后于后端」的静默漂移
  （D9 早就记过：仓里没有 gen-api 新鲜度门禁，所以它只能靠人记得做）。两条纪律：
  ① **只在树干净时跑**——并发期跑会把别的在飞端点一起烘进生成物（本轮实测一次：+482 行里
  一半是别人未提交的 notify/schedule 漂移，只能整份回退）；
  ② 跑完 `git diff --stat src/api/schema.d.ts` 逐条核对新增路径都属于本批，不属于的回退。
  **收尾判据**：`grep -c "notify-channels\|api-import\|schedule-task" src/api/schema.d.ts > 0`
  且 diff 里没有别批的路径。
  **✅ 已还（2026-11-17，commit `e9c3253`）**：树干净 + 8321 空闲时跑。收尾判据实测 `grep -c` = **10**；
  diff **+50/-1** 逐条核对全属本批与本轮（`readyz` 路由 + `SearchAssetsOut` 的 `schedules`/
  `notify_channels` 两键 + `search_assets` 的 @service description），无别批路径混入。
  为什么只差 50 行：notify/import/export/schedule 的端点在 1E T1–T8 各自落地时已被零散跑进去，
  真正缺的是本轮新加的两键与 readyz——**别把「+50」读成「本批只加 50 行」**。
  生成物真实在场后顺手把 `CommandPalette` 的 `(r as {...}).xxx` 兜底摘成直读字段（留着它就是
  后端改键名 → 前端静默演「无匹配」）；渲染侧 `?? []` 保留，它兜运行时缺键而不是类型缺失。
  `schedules.tsx` 仍用本地 `TaskRow`（字段与生成物逐字段一致，但 `schedules.test.tsx` 从这里 import）：
  换引 `components["schemas"]` 是纯类型重构，不混进本批。实测 tsc 0 错、vitest 36 files/**368 passed**。</sub>
  <sub>**第九道差集勘误（2026-11-18）**：本条标题写的 `node scripts/gen-api.mjs` 无处可跑——
  **仓库根没有 `scripts/`**（`ls D:/item/ai-test/scripts` ⇒ No such file or directory），脚本真身在
  `web/scripts/gen-api.mjs`，正当调用是 cwd=`web/` 下的 `pnpm gen:api`（`web/package.json` 的 scripts 项）。
  已交付的 `e9c3253` 那次跑的是正确入口，本条只是文档命令写错，不改史。</sub>
- [x] `README-1e-demo.md`：定时演示手持路径（beat 起法、`* * * * *` 任务、假接收端一行命令）+
  真钉钉/飞书渠道配置法 + **「门禁不依赖 beat 进程/真渠道/真网关」显式声明**（1D emulator 条款同款）。
  **✅ 已交付（2026-11-17，commit `f3fb7bd`，370 行）**：§8 的「不依赖」声明是真取证的——
  `test_schedule_1e.py` 直调 `get_schedule()`/`fire_task()`、`.github/workflows/ci.yml` 全文 0 条
  `celery beat`、notify 收端是进程内 stdlib `http.server`、e2e 模型种子 `fake://`（`playwright.config.ts:37`）
  + `TP_EXEC_MODE=inline`（`:42`）。手册另写死两条本批特有的诚实：演示库停 0020 而链头 0022
  （四张表在业主点的库里不存在，升库命令给出但标明**等业主授权、撰写机器未跑**）、
  worker 没起时「到点/回执 ok/run 永远排队/通知不来」是必然不是 bug。
  假接收端端口 9998 与 `seed_demo.py` 的 `DEMO_HOOK_URL` 默认值对齐，不是手册另编。**门禁数字留占位**
  （并发在飞时写数必编），随 :632 收尾条统一回填。</sub>
- [ ] 收尾：八道门禁全绿并把数字写进 README（④ 逐字核对 `schedule`/`notify` 进契约清单——R64 假绿坑）；
  `migrate_dev.py` 对开发库（0020→0021，**demo 库禁**）；台账 R142+ 按落地形状回填本文件；
  与 1D T11 的 README 数字冲突**后到者改**；导航「1E 开放」两处哨兵翻真（`nav.spec.mjs` 失效哨兵同批改）；
  Ctrl+K 搜索 kind 表 += 定时任务/渠道（R109 四处同改）；`seed_demo.py` += 一个演示定时 + 假渠道
  （**1D 收线后才动**，撞车点 ③）；提交。
  <sub>**2026-11-17 收线核对（1G 尾轮，逐格开文件实测，不凭回忆）**：这一格**仍保持未勾**，
  但它**不等于「还剩一堆活」**——下面六项子事实测五项已落地，只剩一项是业主门禁：
  ①「1E 开放」哨兵翻真 = 已做，且比删哨兵更硬（`web/e2e/sceneList.spec.mjs:151` 现在
  **反向断言** `scene-cron-bind` 不含「1E 开放」）；②Ctrl+K kind 表 += 定时/渠道 = 已做
  （`components/CommandPalette.tsx:29` `kind:"schedule"`，且 `:2` 的九组注释与 `:140` 占位文案
  一起改了，R109「四处同改」没漏）；③`seed_demo.py` += 演示定时 + 假渠道 = 已做
  （`_seed_schedule_notify_via_services` 走 service 而非插表，重跑幂等）；④台账 R142+ 回填 = 已做；
  ⑤README 数字 = 写了，但**数字按 1G 台账口径会过期**，只认 README 顶部那组「本轮实测」，
  不要引本文件的快照；⑥**唯一真未做 = `migrate_dev.py` 0020→0021**，业主门禁（禁改共享库），
  所以「定时/通知在业主点的那份库里存在」这句话**到今天仍不成立**，别写成人人可点。
  ④ 那句「逐字核对契约清单」的实测证据长这样：`Contracts: 4 kept, 0 broken`，命令是
  `.venv/Scripts/lint-imports.exe`（cwd=backend；**不在 `backend/scripts/`**，
  而 `-m importlinter.cli lint` 是静默空跑，拿它当证据就是 R64 假绿本身）。</sub>
- **门禁与自证**：①pytest ②ruff ③mypy ④lint-imports 逐字 4 kept 0 broken ⑤eslint ⑥vitest ⑦e2e
  （诚实口径：稳定通过条数如实报，D11/R136 那条已知flake 不背锅也不掩盖）⑧migrate_dev 全跑一遍，
  数字进 README。
