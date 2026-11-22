# 1E 演示手册（业主版 · 25 分钟）

> 目标：亲眼看一遍 1E 新增的那条链——**通知渠道页建一条渠道 → 定时任务页建一个
> `* * * * *` 任务挂上它 → beat 进程读表到点投出 `schedule.fire` → worker 接走跑场景 →
> 报告中心出现「◷ 定时」触发的 run → 本机假接收端收到一条 Markdown 摘要**。
>
> **与 1D 手册的关系**：装环境那套（§0.1、§1-§4）与 1D 完全通用，跑过 1D 的机器直接从
> §0.2 补两件（升级演示库、起假接收端），然后进 §5。1C/1D 的「必须起 Celery worker」
> 在 1E 同样必须——定时到点只投一条 `scenario.run`，没 worker 没人执行。
>
> **一句话诚实承诺（本批最重要的一句）**：本手册撰写时，演示库 `db.internal.test:3306/testpilot`
> 停在 **0020**，而迁移链头是 **0022**——`schedule_task` / `notify_channel` / `kv_setting` /
> `custom_role` 四张表在业主点的演示库里**根本不存在**（本轮实查：`SELECT version_num FROM
> alembic_version` 回 `0020`，四张 `SHOW TABLES` 全空）。**要演示 1E，先由业主授权把 demo
> 库升到 head**（§2），谁都不许擅自对共享库跑迁移——本手册的撰写机器就没有跑。
>
> **第二条要提前说的（不是 bug，是必然）**：定时到点 = 建一条 queued 的 run + 投一条
> `scenario.run` 进队列。**worker 没起时你会看到「任务到点了、last_run 回执 ok、run 永远
> 停在排队中、通知一条不来」**——这不是调度坏了，是没人领活（§4.3）。

## 0. 前置

### 0.1 与 1A–1D 相同的部分

MySQL 8.x + Redis 7.x、Python 3.12（`backend/.venv` 已就绪）、Node 22 + pnpm 10（`web/`）、
`backend/.env` 配置——**逐条照 1C 手册 §0.1 做，一字不改**（Redis 既是 broker，
`schedule.fire` 的投递与 `scenario.run` 的领取都走它）。

### 0.2 1E 多出来的两件

1. **演示库必须升到 head**（§2，等业主授权，本手册撰写机器**未执行**）；
2. **一个假接收端**：一行命令起一个本机 HTTP 收端（§3，命令本轮实测过——起来、
   收到过一发 POST、日志落字后关掉）。真钉钉/飞书群里演示也可以，但配置法与
   「本批未做加签」的边界先看 §6。

## 1. 端口：先避开 Windows 的保留段（30 秒，Windows 用户必读）

照 1B/1C §1 执行。结论没变：**演示后端 8320**，e2e 8321 / 靶场 9999 / 前端 5173。
1E 新增一个演示端口：**9998（假接收端）**——不在 8320/8321/5173/9999 任何一个上，
与 seed 的默认值对齐（`seed_demo.py` 的 `DEMO_HOOK_URL` 默认
`http://127.0.0.1:9998/hook`，env `TP_DEMO_HOOK_URL` 可覆盖）。演示完请关掉它。

## 2. 建表：演示库 0020 → 0022（**这一步等业主授权，谁都不许擅自跑**）

1E 的迁移是 **0021**（`0021_schedule_notify.py`：`schedule_task` / `notify_channel` /
`kv_setting`），链头 0022（1G `custom_role`）。演示库现在停在 0020：定时任务页与通知
渠道页会直接报错（表不存在），这是「测试全绿但演示库没表」的老病根（1C §2 同一条）。

**升库命令（由业主授权并执行/点头后代跑，cwd=backend）**：

```powershell
cd backend
.venv\Scripts\python.exe scripts\migrate_dev.py    # 读 backend/.env 的 TP_DB_URL——当前指向 demo 库
```

- `migrate_dev.py` 幂等，打印 `version : 0020 -> 0022 (head = 0022)` 即成。
- **谁有权执行**：这是对**共享演示库**写结构，按计划纪律必须业主授权（手册撰写与
  批次执行的任何 agent 都不许擅自跑；本轮取证全程只读）。
- 升完库再跑一次种子（§4.1）：种子已带 1E 段——一条「演示接收端（本机假 hook）」
  渠道（WEBHOOK，指 `http://127.0.0.1:9998/hook`）+ 一条 `*/5 * * * *` 的演示定时
  （挂演示场景）。真钉钉/飞书凭据**绝不进种子**（那是业主的敏感配置）。

## 3. 假接收端：一行命令（本轮实测）

新开一个 PowerShell 窗口，一行起一个 stdlib 收端（零依赖、`http.server`，与
`backend/tests/test_notify.py` 进程内收端同一族形状；端口 9998，用完 Ctrl+C）：

```powershell
backend\.venv\Scripts\python.exe -c "import http.server as h; H=type('H',(h.BaseHTTPRequestHandler,),{'do_POST':lambda s:(print('GOT POST',s.path,':',s.rfile.read(int(s.headers.get('content-length') or 0)).decode('utf-8','replace'),flush=True),s.send_response(200),s.end_headers(),s.wfile.write(b'ok'))}); print('fake receiver on http://127.0.0.1:9998/hook (Ctrl+C to stop)',flush=True);h.HTTPServer(('127.0.0.1',9998),H).serve_forever()"
```

**实测记录（2026-11-17，撰写机器实跑）**：命令敲下去打印
`fake receiver on http://127.0.0.1:9998/hook (Ctrl+C to stop)`；随后
`curl -X POST http://127.0.0.1:9998/hook -d '{"text":"direct ps1 test"}'` 回 `ok`，
收端窗口逐字滚出 `GOT POST /hook : {"text":"direct ps1 test"}` 与访问行；Ctrl+C 关掉。
注意：整行必须**原样单行**贴进 PowerShell——把它拆进 `-Command` 参数会被 PowerShell
的引号规则吃掉（本手册撰写时这样炸过两次，故以「直接在提示符敲这一行」为准）。

## 4. 起平台（演示动线要四个进程，约 4 分钟）

前提：§2 的升库已获业主授权并执行完（否则 4.1 种子与定时/渠道两页都会炸在缺表上）。

```powershell
# 4.1 种子（可反复执行；1E 段自带「演示接收端（本机假 hook）」渠道 + 「演示：每 5 分钟
#     跑一次演示场景」定时（*/5 * * * *），渠道 URL 指 http://127.0.0.1:9998/hook）
backend\.venv\Scripts\python.exe backend\scripts\seed_demo.py

# 4.2 后端（cwd=backend）
cd backend; .venv\Scripts\python.exe -m uvicorn app.server:app --port 8320

# 4.2b 执行 worker（另开终端，cwd=backend）——**不要带 -B**，理由见下
cd backend; .venv\Scripts\python.exe -m celery -A app.worker:celery_app worker --pool=solo -l info

# 4.2c 独立 beat（另开终端，cwd=backend）——1E 的新进程，用户的定时全靠它
cd backend; .venv\Scripts\python.exe -m celery -A app.beat beat -l info

# 4.3 前端（另开终端，cwd=web）
cd web; pnpm install; pnpm build; $env:TP_BACKEND="http://127.0.0.1:8320"; npx vite preview --host 127.0.0.1 --port 5173 --strictPort
```

外加 §3 的假接收端窗口，演示机上一共五个窗口。演示账号不变
（`admin`/你 §0 设的 `TP_BOOTSTRAP_PASSWORD`、`demo_pm`/`Demo@12345`、`demo_ro`/`Demo@12345`），顶栏选「演示商城」。

**beat 到底怎么起——`celery -A app.beat beat` 与 `-B` 的差别（以代码为准）**：

- **正确起法就是 4.2c 这条**：`app/beat.py` 里的 `celery_app` 显式配了
  `beat_scheduler="app.beat.DbScheduler"`（`beat.py:50`）——用户的定时任务住在
  `schedule_task` 表里，只有这个自研读表调度器每次 tick 现读 enabled 行才算得出排期。
  本轮实测该命令能起（打印 `beat: Starting...`）。
- **worker 侧的 `-B`（1D 手册 §4.2b 那条 `worker --pool=solo -B`）不带用户定时**：
  `-B` 是把 beat 内嵌进 worker 进程，用的是 **worker 那个 celery app** 的调度器——
  `app.worker` 没配 `beat_scheduler`，起的是原生 `PersistentScheduler`，排期只有启动期
  烘焙的静态 `beat_schedule`（ADB 15s 心跳，`worker.py:25` 的 `_beat_schedule()`）。
  本轮用 `find_app('app.worker')` 核对过：其 `beat_scheduler` 是
  `celery.beat:PersistentScheduler`——**它根本不看 `schedule_task` 表**。演示 1E 时
  只给 worker 加 `-B`，用户的 `* * * * *` 任务永远不会到点。
- **`-B` 也不该和独立 beat 同时开**：`app.beat` 的 `setup_schedule()` 会把同一份
  ADB 心跳静态表装进独立 beat（`beat.py:189`，注释明写「本 beat 是 app 唯一的 beat」），
  两边同开 = 心跳双份。口径：**演示 1E 起独立 beat，worker 不带 `-B`**。
- 计划与文档的口径核对：1E 计划 R142/T1 写的就是 `celery -A app.beat beat`（独立进程）；
  仓库里出现 `-B` 的只有 1D 手册（那是给 ADB 心跳用的折叠写法，1E 之前没有用户定时）。
  两条不冲突，但**语义不同**：`-B` 管心跳，独立 beat 管用户定时。
- **队列对得上**：beat 投 `schedule.fire`、fire 投 `scenario.run` 都显式带
  `queue=settings.task_queue`（`beat.py:94`、`schedule/service.py:363-364`），dev 环境即
  `tp.dev`（D10/R118 分道），与 4.2b 的演示 worker 同队列；`--pool=solo` 是 Windows 必需。
- **没有 worker 时会发生什么（必然现象，提前说，不是 bug）**：`schedule.fire` 的触发体
  （`schedule/service.py:fire_task`）只做四件事——建一条 `trigger="schedule"` 的 run 行、
  按名字投 `scenario.run` 进队列、回执落 `last_run`、写一条 `schedule_task.run` 审计
  （`:383-386`，投递失败分支同样落一条 `ok=false`，`:373-376`）。**执行本身全靠 worker 领走**。
  Redis 起着、worker 没起时：到点了、`last_run` 回执 `ok=true` 带 run_id、报告中心多一行
  永远「排队中」的 run、通知一条不发（通知挂在 run **落终态**之后）。界面不会骗你说跑了。
- **beat 没起**：什么都不到点（表没人读），页面照常。DB 读失败（比如演示库没升到 0021）
  时按代码口径吃上次快照 + 打一条 warning（`testpilot.beat` 日志），beat 自己不炸。

## 5. 演示路径 · 手持（20 分钟，照着点）

### 5.1 通知渠道页：先让一条渠道「测试发送」变 ✓（4 分钟）

左侧「系统设置」→「通知渠道」（`/#/notify/channels`）。若 §4.1 跑过种子，
列表里已有「演示接收端（本机假 hook）」（类型标 `通用 Webhook WEBHOOK`，
配置列 `url: http://127.0.0.1:9998/hook` 明文可见——URL 无 query 段所以不打码，
就是让业主在页面上认出它）。

1. 确认 §3 的假接收端窗口开着 → 点这条行的「发送测试」。
2. 你会看到：弹窗绿字「发送成功（Nms）」+ 对端原始响应 `ok` 原样直出；
   行内「最近发送」变绿 ✓；刷新后 ✓ 仍在（回执落在库 `last_send`，不是内存动画）。
3. 故意把 URL 改成 `http://127.0.0.1:1/hook` 再测一次：行内如实 ✗，
   弹窗报连接错误原话，且**没有编造的对端响应块**（网络层失败没有 raw，UI 不编）。
4. 点「新建渠道」把类型下拉点开：**只有五类**（通用 Webhook / 钉钉 / 企业微信 /
   飞书 / 邮箱），每类表单字段就是后端真实消费的键（§6）。编辑抽屉里密钥字段显示的是
   **后端打码回显**（前 5 位 `••••` / URL query 段 `[已配置]`），原样保存不会把掩码
   再加密一层（后端识别「等值 = 没改」，D24）。
5. 顺手演引用硬拦：删一条被定时任务引用的渠道 → 弹窗「删除被拦截：该渠道被定时任务
   引用」并点名任务名，拦下不是失败、行还在。

### 5.2 定时任务页：建一个 `* * * * *`（4 分钟）

左侧「任务中心」→「定时任务」（`/#/schedules`）。点「新建任务」：

1. 名称随意；主体类型只有一个选项（**场景 scenario**，D30 一期白名单，其余 422）；
   场景选「演示：登录-取token-轮询查单-断言」（种子里那条）；环境可选可不选。
2. cron 填 `* * * * *`（5 段「分 时 日 月 周」）。界面上没有 cron 快捷按钮，只有
   **「计划三选」单选**：每天 / 每周 / 自定义 cron（`schedules.tsx:456-461`）——每天配
   时、分下拉（`:462-471`），每周是「星期多选 + 时分下拉」（`:472-483`），
   所以**三态拼不出 `* * * * *`**，只能点「自定义 cron」在输入框里手输（`schedule-field-cron`，
   `:492`）。选完三态之一，下面永远同屏一行「将写入：{cron}」（`:503`），
   点「保存」前先认这行串。**前端零校验**（`:494`「合法与否唯一裁判是后端」）——把 cron 改成 6 段
   `0 0 * * * 1` 点保存，红框「后端拒绝（原话回显）」回的是**自研段数闸**的原话
   「cron 必须是 5 段式「分 时 日 月 周」，收到 6 段：…」（`cron.py:51-56`，段数闸**先于** crontab 跑）；
   要看 crontab 自己的原话得给一个**段数对但字段坏**的，例如 `*/5x * * * *` →
   「cron 非法：…invalid…」（`cron.py:67-68`，只有这一支才是第三方措辞，测试钉的就是它）。
3. 点「预览未来 5 次」：列表打出未来 5 个时刻（上海日历），**发的是未保存的草稿 cron**，
   每秒一个。
4. 「通知渠道」多选勾上「演示接收端（本机假 hook）」；「启用」打开；保存。
   列表新行「最近结果」画「**从未触发**」（`LastRunCell` 无回执时的三态之一，
   `schedules.tsx:116`；还没跑过，不画假回执）。

### 5.3 到点：下一分钟看三处齐动（6 分钟，本场压轴）

等下一分钟整点（`* * * * *` 每分钟一次；beat 轮询上限 5s，`max_interval=5.0`）：

1. **beat 窗口**：日志投出 `schedule.fire`；
2. **worker 窗口**：接走 `schedule.fire`（建 run + 投 `scenario.run`）又接走
   `scenario.run` 真跑场景；
3. **假接收端窗口**：`GOT POST /hook : {"text": "### TestPilot 执行结果摘要 ..."}`
   ——正文就是 §7 那份 Markdown（run 落终态后由终态钩子同步真发）；
4. **界面**：定时任务页该行「最近结果」变绿——绿 `Tag`（措辞取 run 词表，如「通过」）
   + 下一行「完成 {finished_at}」+ 末行 `run {run_id}`（`LastRunCell` 的 run_final 段，
   `schedules.tsx:129-156`；配色只由 `run_final.ok` 决定，没落终态时是灰态而非绿；
   终态回执里若带 `reason`/失败渠道，会以灰字副行与行内 ✗ 一并画出，见 §FAQ D163）：
   「连续失败」按结果走动（通过归零 / 未通过 +1）；报告中心多一行触发列
   **「◷ 定时」**（geekblue 徽标）的 run；审计页入口列出现「定时」行
   （操作人列画「未知」——定时没有人格化操作者，`AuditTab.tsx:83` `v ?? "未知"`，
   R144，界面不编一个）。

再演一次「停用即停排」：列表上关掉那行的启用开关 → 下一分钟 beat 日志不再投它
（表是唯一真相，beat 下个 tick 读不到 enabled 行就没了；删除任务同理，beat 里
add/remove 都是 no-op）。

### 5.4 工程侧证据（不用手点，给评审看）

`schedule.fire` 的投递形状（按名字 `send_task`、R42）由
`backend/tests/test_schedule_1e.py` 钉；渠道五类的载荷信封、打码/加密、删除引用检测由
`backend/tests/test_notify.py` 钉（其假接收端 = stdlib `http.server` 线程，与 §3 同一族）；
「定时→通知」的端到端 DoD 证据归 `web/e2e/scheduleNotify.spec.mjs`（**定稿时在飞**，
T9 并行批次正在落这条 spec，本手册不替它宣称已通过）；e2e 后端不起 worker，
用 `TP_EXEC_MODE=inline` 同引擎跑通（见 §8）。

> **未实测声明（照实说）**：§5.3 的完整业主动线（真 beat 进程 + 真 worker + 真接收端
> 四进程同场）在**本手册撰写机器上没有跑过**——撰写环境被禁写演示库（0020 缺表，§2），
> 计划 T1 台账也记录了同款「演示口径未实测」。逐个部件是实测过的：假接收端一行命令
> 真起来并收到 POST（§3）、`celery -A app.beat beat` 真能起（§4）、投递/回执/模板的
> 每条形状都有单测钉。拼装动作留给业主在升库后的演示机上跑第一遍。

## 6. 真钉钉/飞书渠道配置法（业主手持，10 分钟）

渠道是**平台级配置**（表无 project_id，全项目共用），入口「系统设置 → 通知渠道」，
写完点「发送测试」当场验。以下字段就是前端表单 = `senders.py` 真实消费的键，
**一个不多一个不少**（`notifyChannels.tsx` 的 `CONFIG_FIELDS`，注释原话「零假字段」）。

### 6.1 钉钉（类型选「钉钉 DINGTALK」）

| 表单字段 | 填什么 |
|----------|--------|
| 机器人 Webhook URL（必填） | 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义机器人，复制 Webhook（`https://oapi.dingtalk.com/robot/send?...`） |
| access_token（密码框） | URL query 里已带 `access_token` 就**留空**；只给了 token 值就填这里（发送器会在 URL 没有该参数时拼进去，`senders.py:179`） |

**加签条款（照实说）**：本批**没有加签字段**——表单没有 secret/加签开关，发送器也不做
HMAC 签名。建机器人时安全设置请选**自定义关键词**（如「TestPilot」，摘要首行就带它）
或 **IP 段白名单**；选了「加签」的机器人这条链发不出去（钉钉侧回 errcode，界面如实 ✗
并把钉钉原文回显在「原始响应」里）。这不是 bug，是 1E 交付边界。

### 6.2 飞书（类型选「飞书 FEISHU」）

| 表单字段 | 填什么 |
|----------|--------|
| 机器人 Webhook URL（必填） | 飞书群 → 群设置 → 群机器人 → 自定义机器人，复制 Webhook（`https://open.feishu.cn/open-apis/bot/v2/hook/...`） |

飞书这条只有一个字段。同理**没有签名密钥字段**：飞书机器人的「签名校验」安全设置本批
不支持，自定义机器人安全设置请留空或走关键词/IP 白名单（飞书自定义机器人默认即可发）。
发出的是 interactive 卡片（标题 = 摘要首行，正文 = Markdown 全文，`senders.py:165`）。

### 6.3 落库与回显（给评审讲的口径，D24）

- 密钥**值**逐键 Fernet 加密落库（敏感键名 = 含 token/secret/password/api_key/apikey
  这五个片段的键，`apikey` 无下划线那一档也算，所以键名写成 `apikey` 一样会被加密；
  URL 的 query 段值同样打码；`senders.py:39`），列表/编辑抽屉只显示后端打码回显
  （前 5 位 `••••`、query 段 `[已配置]`），主密钥换过解不开就回 `****(无法解密)`——
  发送也如实回这句，不 500。
- 「发送测试」真打真回：对端 ≥400 如实 ✗ 且原始响应直出；网络层失败 ✗ 且**不编 raw**。
- 企业微信（只有 URL 一个字段）、通用 Webhook（URL；POST `{"text": ...}`）、邮箱
  （smtp_host/smtp_port/from_addr/to_addr/username/password，465 自动 SSL）同页可配，
  本手册不展开。

## 7. 通知内容长什么样（`notify/template.py` 的真实字段清单）

定时 run 落终态后，绑定的每个渠道各收到一条 Markdown。字段是**键控渲染**——
`run_record` 里有什么显什么，缺的行整行消失，不画「未知」也不造假：

```
### TestPilot 执行结果摘要 · 通过        ← 状态标：通过/未通过/异常/已取消
- 定时任务：<任务名>                     ← 仅定时触发有（hooks 注入 task_name）
- 场景：<场景名>
- 触发方式：定时                          ← schedule/manual/debug/Pilot/Webhook 的中文标
- 结果：通过
- 通过率：100.0%                          ← pass/(total−skip)；分母≤0 显示「算不出（无有效步骤）」，不画 0%
- 耗时：4200ms（≥1s 显示为 x.xs）
- 环境：<环境名>                          ← 任务没绑环境就没有这行
- 执行人：<创建者显示名>                  ← 查得到 app_user 才有这行
[打开报告](/reports/<run_id>)             ← 前端相对路径——平台没有外部 base_url 配置，拼绝对 URL 就是假链接
```

未通过/异常/已取消时多一行「- 失败原因：…（截 200 字）」。
「连续失败告警」是另一条独立消息（**阈值 = `notify/hooks.py` 写死的常量 3**，
§9.2）：`### TestPilot 告警 · 定时任务连续失败 3 次` + 任务名 + 检查提示，发同一批渠道。

## 8. 八道门禁与「不依赖 beat / 真渠道 / 真网关」显式声明

**先说结论（1D emulator 条款同款口径）：八道门禁的绿红，不依赖 ① beat 进程在不在、
② 任何真钉钉/飞书/企微渠道可达、③ 任何真模型网关可达。** 取证：

- **beat 不在任何门禁路径**：conftest 起的是 fakeredis + 临时库，**真 beat 进程不进 CI**（R142）。
  读表那一侧的钉分散在两个文件，别只认一个：`get_schedule` 每次现读 / DB 挂吃旧快照 /
  add-remove no-op 在 `test_schedule_beat.py`（真库往返、线程内新 loop），
  422 带 crontab 原话 / `next_fire_times` 纯函数边界 / 双实例同构在 `test_schedule_1e.py`
  （文件头自己写了这条去重口径）。投递侧 monkeypatch `_celery_client` 验 `send_task` 形状，
  落点在 `test_schedule_service.py`（`:247` 的 `_SpyCelery`）与 `test_schedule_notify_hook.py`
  （`:105` 的 `_fire_and_run` 直接 `await svc.fire_task`）——不需要活的 broker 消费者。
  `.github/workflows/ci.yml` 全文没有一条 `celery beat` 命令，worker 也不起
  （CI 裁定：pytest 走 `TP_EXEC_MODE=inline`，conftest 默认）。
- **真渠道不在任何门禁路径**：`test_notify.py` 的接收端是**进程内 stdlib
  `http.server` 线程**（零新依赖口径）；e2e（`notifyChannel.spec.mjs`）的三个真目标全在
  本机——靶场 `:9999/ui/login`（302 → ✓）、`:9999/login`（401 → ✗ + 原文）、
  `127.0.0.1:1`（端口必拒 → ✗ 无 raw）。没有一条测试打 `oapi.dingtalk.com` 或
  `open.feishu.cn`。
- **真模型网关不在任何门禁路径**：e2e 的模型种子是
  `TP_MODEL_SEED_BASE_URL=fake://basic_two_tools`（`web/playwright.config.ts:37`，
  回放 JSONL 的假模型），CI 不设任何真网关；`TP_EXEC_MODE=inline`（同文件 `:42`，
  注释明写「e2e 后端没有 Celery worker……inline 跑的是同一份引擎（R42）」）。

**八道门禁命令与 README.md「提交前必跑」逐字同源，本手册不抄死数字**（抄了就会过期）：

| 门禁 | 跑什么 | 与 1E 的关系 |
|------|--------|--------------|
| ① `.venv/Scripts/python.exe -m pytest -q`（backend） | 单测/集成（需 MySQL+Redis，临时库） | schedule/notify 全家 + 权限矩阵都在这条 |
| ② `.venv/Scripts/python.exe -m ruff check app tests migrations scripts` | lint | — |
| ③ `.venv/Scripts/python.exe -m mypy app` | 类型 | — |
| ④ `.venv/Scripts/lint-imports.exe`（cwd=backend） | 模块边界四契约（逐字认 `Contracts: 4 kept, 0 broken`） | `schedule`/`notify` 进契约清单（R64 假绿坑要逐字核） |
| ⑤ `pnpm lint`（web） | eslint | — |
| ⑥ `pnpm test`（web） | vitest + tsc | — |
| ⑦ `pnpm build:e2e && pnpm exec playwright test` | e2e（自带 8321 后端 + 靶场 + 5173，`inline` 执行、fake 模型） | `scheduleNotify.spec.mjs` / `notifyChannel.spec.mjs` 在这条 |
| ⑧ `.venv/Scripts/python.exe scripts/migrate_dev.py` | **开发库**对齐 head | 1E 迁移 0021；对 demo 共享库照 §2 的授权纪律 |

> 这张表的命令列本轮（第九道差集）改成与 README「提交前必跑（八道门禁）」一节 **一字不差**——旧文本写的是
> `python -m pytest` / `python -m mypy` / `python scripts/migrate_dev.py`，与 README 并不同源，
> 而本机系统 Python（3.11.9）**装不出这套依赖**：`python -m pytest` 在导入 `tests/conftest.py:14`
> 的 `pytest_asyncio` 时就 `ModuleNotFoundError`、退出码 4（实测），`python -m mypy` 干脆
> `No module named mypy`。好消息是它们**响着失败**，不是 `python -m importlinter` 那种静默 exit 0；
> 坏消息是照着抄的新人第一次一定撞墙。cwd 一律 `backend/`，所以是 `.venv/Scripts/…` 而不是 `backend/.venv/…`。

**本轮（1E T9）各门禁实跑数字：（待领导在全树收敛后实测回填）**——并发批次在飞
（e2e/seed/search 多文件同日在改），手册定稿时任何数字都可能是编的，一律留占位。
> 对账轮补充（2026-11-17，主线实测，覆盖的是**当前树**而非 1E T9 当轮）：① 1118 passed / 1 failed
> （唯一失败为负载抖动单跑绿）｜② 过｜③ 131 files｜④ 4 kept 0 broken｜⑤ 0/8｜⑥ 378 passed / 36 files｜
> ⑦ **未全量实测**（上次全量基线 91 passed / 2 skipped，其后两份规格各加了一条，重跑前不作数）｜
> ⑧ 未执行（demo 共享库禁跑，0020→0022 等业主授权，§2）。

## 9. 三个「为什么长这样」

**9.1 为什么 beat 是独立进程而不是 worker 的 `-B`？**
`-B` 内嵌的是 worker app 的原生调度器 + 启动期烘焙的静态 dict，「往 dict 里塞用户任务」
不重启进程做不到，而重启 worker 会把执行中的 run 挂在 solo 池上（R142 取证）；
celery 5.7.0 实测没有 `DatabaseScheduler`，所以读表调度器只能自己写、只能独立起。
细节全部写在 `app/beat.py` 的模块 docstring 里。

**9.2 为什么「连续失败 3 次」改不了？**
`notify/hooks.py:35` 的 `ALERT_THRESHOLD = 3` 是**写死的常量**：计划原文（§11.4.17
「连续失败[3]次后通知」）要求每任务可配，但 `schedule_task` 表按计划 T0「一列不多」
纪律只落了 `consecutive_failures`（账）**没有阈值列**——计划补记裁定按常量 3 实现并
如实记账。**要改阈值目前只能改代码重发**；要做成界面可配，先由业主点头补列（改 T0 纪律）。
界面对此诚实：定时页脚注写「告警由后端投递，本页只如实展示计数」，没有假装可配的输入框。

**9.3 为什么通知只在定时 run 上发、手动 run 一条不发？**
`hooks.on_run_finalized` 第一行就 `if trigger != "schedule": return`——一期只有
「定时任务挂渠道」这一种通知语义，没有「所有执行都通知」的全局开关，不造。
计数口径也钉死：run 通过归零、未通过 +1，**发送失败不碰计数**（通知坏了 ≠ 执行坏了）。

## 10. 常见问题

**Q：定时任务页/通知渠道页打开就报错。**
A：多半是演示库还没升 0021（§2）。表不在，页面如实报错，不会演空表糊弄你。

**Q：到点了，报告中心那条 run 永远「排队中」。**
A：worker（§4.2b）没起——`schedule.fire` 只投递不执行（§4 那条「必然现象」）。
把 worker 起来它自己会被领走；**这类 run 在界面上没有撤销入口**（唯一的取消端点只挂在
场景编辑器那颗「取消」钮上，且只管这轮在跑的场景 run——定时投的 run 报告中心/运行记录页都撤不了，
D164 记着这笔账），别等，去起进程。

**Q：worker 起了，还是一直 queued。**
A：核对 worker 是不是**演示环境**起的（`backend/.env` 的 `TP_ENV=dev` → 队列 `tp.dev`）。
e2e/test 队列的任务演示 worker 物理上领不到（D10/R118，这是设计）；同一台机器上
别把 `TP_ENV` 改成 test 后常驻。

**Q：run 跑完了，假接收端没收到通知。**
A：按链查三件——任务有没有勾渠道（回执 `run_final.reason="未绑定通知渠道"`，
`notify/hooks.py:108`）；渠道行是不是被删了（回执 `channels[].error="渠道不存在"`，`:117`）；
接收端进程还开没开（发送失败会落 `last_send.ok=false` + 错误原话，行内 ✗ 看得见）。
**前两条现在页面上也看得见**（D163 已修）：终态分支里 `run_final.reason` 画成灰字副行
（`data-testid="schedule-final-reason"`），`channels[].ok===false` 的渠道逐个画
「✗ 渠道名：error」+ Tooltip（`data-testid="schedule-channel-error"`，`schedules.tsx:129-156`）。
通知是 run 落终态时**同步**发的，没有重试队列——坏了就如实坏，补发是脑补。

**Q：`celery -A app.beat beat` 起来了但什么都不投。**
A：演示库缺 `schedule_task` 表时它按「吃快照 + 一条 warning」静默活着（beat 不许炸是
设计，§4 末条）——看日志里那条 `schedule_task 读库失败` warning，回到 §2。

**Q：钉钉测试发送 ✗，原始响应里有 errcode。**
A：看 errcode 文案：310000 家族 = 机器人安全设置没过（关键词不匹配/开了加签/IP 不在
白名单）。**加签本批不支持**（§6.1），改关键词或 IP 白名单再测。

**Q：编辑渠道时密钥框里是 `abc12••••`，保存会不会把掩码存成真值？**
A：不会——「值 == 打码回显 = 没改」是后端 merge 的契约（D24），e2e 还钉了
「掩码回环保存后测试发送仍 ✓」。要换密钥就整段替换成新值。

**Q：预览未来 5 次和实际到点时刻差几秒。**
A：beat 轮询上限 5s（`max_interval=5.0`），cron 精度是分钟级，差一拍在演示口径内。

## 11. 1E 交付边界（诚实清单）

**已可用**：通知渠道五类（CRUD + 测试发送行内 ✓/✗ + 原始响应直出 + D24 打码/加密 +
删除引用硬拦点名引用方——**HTTP 面只有系统管理员使得动**，见下面 D165 那条，
本手册全程用 `admin` 登录就是在绕这个坑）、定时任务页（列表六列 + 抽屉：场景/环境/cron 预览 5 次 +
挂渠道 + 启停）、自研读表 beat（改行 ≤5s 生效、DB 断了吃快照）、`schedule.fire` →
`scenario.run` 全链（trigger=定时 进报告、entry=schedule 进审计、R144 无人格操作者）、
Markdown 摘要模板（缺行不显 + 相对链接）、连续失败计数与达阈告警、
工作台统计页（§11.5.2 一期简化版——蓝图 §11.4.1 是同页的旧布局图，页头注释引的是 §11.5.2，
以它为准：统计卡 ×4 | 近 7 天趋势 | 最近执行 10 条 | 我最近编辑 10 条 | 快捷入口）。

**等业主裁（本手册不擅自演）**：演示库升 head（§2，**演示 1E 的前置**）、
告警阈值每任务可配（§9.2，先补列）、D22 漏跑补偿（表上没有 `next_fire_at`，
错过不补是现状口径）。~~D165 通知渠道页的前后端门禁分叉~~ **D165 已修**：
前端与后端同尺——通知渠道页对非系统管理员不再画「新建/编辑/删除」假钮，而是
诚实空态 `data-testid="notify-channel-admin-only"`（「通知渠道是平台级配置，
仅系统管理员可管理」，不发列表 GET；`notifyChannels.tsx:525` 的
`is_system_admin && can(...)` 双闸，与 ModelTab 同款），侧栏「通知」入口对
非系统管理员也隐藏（`shell.tsx:183`）。但结论不变：1E 这条
「定时 → 挂渠道 → 到点通知」的主链**只有 admin 账号演得通**——`demo_pm` 现在
连入口都看不到（以前是看得到、点了 403），定时任务抽屉里的渠道下拉对
demo_pm 仍恒降级成「无渠道读取权限」。

**1E 明确不做**（不是漏了）：钉钉/飞书**加签**（§6，机器人安全设置走关键词/IP 白名单）、
通知重试队列/送达回执去重、「所有执行都通知」全局开关、告警发「管理员私信」（告警对象
= 渠道，D28）、测试计划页（三期）、队列深度/备份演练诊断页、
`kv_setting` 其余四组系统参数。这一条要说到字面上：**整张 `kv_setting` 表今天零读取方**
（`grep -rn "KvSetting" backend/app --include=*.py` 只有模型定义那一处），
连「ADB 心跳间隔」也只是 `worker.py:32-37` 里写死的 `15.0`——它的 docstring 明写
「无系统参数行用默认」「将来系统参数『ADB心跳间隔』**落库后**，在这里按参数行覆盖」，
即那张表是**留给后续批次的空位**，别在演示里说成「心跳间隔已可按参数配置」。
