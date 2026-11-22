# 1D 演示手册（业主版 · 30 分钟）

> 目标：亲眼看一遍 1D 新增的那条链——**登记 ADB 设备 → 拼一条 ADB 用例（命令列表）→
> 真机/假设备调试 → 正式执行进报告中心 → 报告里逐步看回执与截图 → 把这条用例当一步拖进
> 场景混着跑（api + sleep + if + adb_case 一景）**。
>
> **与 1C 手册的关系**：装环境那套（§0.1、§1-§4）与 1C 完全通用，跑过 1C 的机器直接从
> §0.2 补一件「adb 可执行」，然后进 §5。1C 的「必须起 Celery worker」在 1D 同样必须，
> 1D 还多一个建议：worker 带 `-B` 起心跳（§4.2b，不带也能演示，设备卡会写「尚无心跳」）。
>
> **一句话诚实承诺**：ADB 这条链的真跑必须有一个「adb 可执行」看得见的东西——真机、
> 模拟器、或仓库自带的假设备（§6）。没有它，所有页面照常能看、资产照常能建，
> 但执行会**如实报错**（「没找到 adb 可执行」/「设备不在本项目可用设备里」），
> 不假装跑过（§13 纪律 1）。

## 0. 前置

### 0.1 与 1A/1B/1C 相同的部分

MySQL 8.x + Redis 7.x、Python 3.12（`backend/.venv` 已就绪）、Node 22 + pnpm 10（`web/`）、
`backend/.env` 配置——**逐条照 1C 手册 §0.1 做，一字不改**（Redis 仍是硬依赖：
ADB 的**正式执行**走 worker 队列，调试同步跑但也吃 Redis 锁做设备占用）。

### 0.2 1D 多出来的那一件：adb 可执行（三选一，先想好演示哪条路）

产品代码只认一个东西：`settings.adb_path`（配置项 `TP_ADB_PATH`）指向的 adb 可执行，
找不到时按 `PATH` → Android SDK 常见目录兜底（`adb_path.py` 的 `resolve_adb_path`）。
全仓库**只有这一个入口**，所以三条演示路就是「喂给它什么」：

| 路 | 喂什么 | 演示什么 | 章节 |
|----|--------|----------|------|
| A 手持真机/模拟器 | 真 adb（Android SDK platform-tools） | 真机连接、真截图、真控件树（u2） | §5 |
| B 免模拟器（假设备） | 仓库自带的 `backend/scripts/fake_device/` | 全链路绿：建设备→跑用例→报告→混合场景（判定同一份，UI 是 dump 轮询降级） | §6 |
| C 什么都不喂 | —— | 页面、资产、权限照常演；执行如实红（报错原文是 adb 安装指引） | §5.3 的失败形状 |

- **B 路的假 adb 是产品级替身不是界面动画**：它顶替的是 adb 子进程这一层
  （`FakeDeviceManager` 生成一个 `fake-adb.cmd` + 一个状态文件，产品代码照常
  spawn 它、解析它的 stdout），执行核、判定、报告、制品全部走真实代码路径。
  细节见 §6.1。
- Windows 上假 adb 的 wrapper 是 `@py -3 fake_adb.py %*`（`manager.py`），
  所以 B 路还要求机器上有 **`py` 启动器**（装 Python 3.12 时默认勾选，
  `py -3 -V` 能回版本号即可）。

## 1. 端口：先避开 Windows 的保留段（30 秒，Windows 用户必读）

照 1B/1C §1 执行。结论没变：**演示用 8320**，e2e 用 8321 / 靶场 9999 / 前端 5173。
1D 不新增端口——设备、用例、报告都从 5173 出。**模拟器也不占用后端端口**：
`adb connect` 是平台主动向外连（ emulator 的 5555 是被连的一方），5555/5557 这类
模拟器端口与 8320/9999/5173 互不相干，但同样可能落进 Hyper-V 保留段，
`netsh interface ipv4 show excludedportrange protocol=tcp` 顺手看一眼。

## 2. 建表（约 1 分钟）

```powershell
cd backend
.venv\Scripts\python.exe scripts\migrate_dev.py     # 幂等，把开发库推到最新 head
```

1D 的迁移是 **0020**（`0020_adb.py`：设备 / 模块 / 用例等 ADB 表）。演示库滞后时
ADB 两个页面会直接 500——1C 手册 §2 那句话在 1D 一字不改地成立。

## 3. 起靶场（被测系统，约 30 秒）

命令与 1B/1C §3 完全相同（仓库根目录跑 `backend\scripts\target_app.py`）。
**ADB 用例本身不打靶场**（它打的是设备），但混合场景里的 api 步骤仍打它——
§5.9 那一景的 `/healthz` 断言靠的就是这个进程。自检：`http://127.0.0.1:9999/healthz` 回 200。

## 4. 起平台（三个进程，约 3 分钟）

```powershell
# 4.1 种子（可反复执行，只补缺不覆盖手工改动）
backend\.venv\Scripts\python.exe backend\scripts\seed_demo.py

# 4.2 后端（cwd=backend；路 A/B 都要带 TP_ADB_PATH，见 §0.2 / §6.2）
cd backend; $env:TP_ADB_PATH="<adb 可执行路径>"; .venv\Scripts\python.exe -m uvicorn app.server:app --port 8320

# 4.2b 执行 worker + 心跳（另开终端，cwd=backend）
cd backend; $env:TP_ADB_PATH="<同上>"; .venv\Scripts\python.exe -m celery -A app.worker:celery_app worker --pool=solo -B -l info

# 4.3 前端（另开终端，cwd=web）
cd web; pnpm install; pnpm build; $env:TP_BACKEND="http://127.0.0.1:8320"; npx vite preview --host 127.0.0.1 --port 5173 --strictPort
```

- `--host 127.0.0.1` 不能省（同 1C §4），`--pool=solo` 是 Windows 必需。
- **`-B` 是 1D 新口径**：设备卡片的「最后心跳」和在线/离线帧来自 celery beat 的
  15 秒心跳任务（`worker.py` 的 `_beat_schedule`），**beat 不跑就没有心跳帧**——
  页面不会坏，但每张卡都写「尚无心跳」，状态带的「离线」也画不出来。
  演示设备活着的样子（绿帧在走）需要这个 `-B`。
- **`TP_ADB_PATH` 为什么要设两处**：建设备的 `adb connect` 发生在 HTTP 进程，
  真跑用例发生在 worker 进程——哪个进程没带上它，哪一段就报「没找到 adb 可执行」。
  worker 报这个错时全部命令标 **「adb 不可用，全部步骤未执行」**，不是静默跳过。
  这句和「设备未连接，未执行」是**两种病**（2026-11-18 复核，原文写串过）：
  `adb_core.py:586` 是 adb 本体缺失（`adb_connect` 压根没被调用，设备连没连过都还没测），
  `adb_core.py:593` 才是真·连接失败——「设备未连接」这一句只有那里挣得起。别把配置故障
  讲成设备故障，演示时被问「是没装 adb 还是设备掉了」要答得上来。
- **种子在 1D 多了什么**：一个 `ADB 演示` 模块 + **1 条 ADB 用例**
  「演示：设备体检两拍」（两条命令：`shell getprop ro.product.model` + `sleep 500ms`）。
  **种子不登记设备**——`adb_device_create` 会真发 `adb connect` 验证，种子伪造不了
  也不该伪造一台「在线设备」（`seed_demo.py` 的 docstring 把这件事写在了代码旁边）。
  设备的登记是演示动作本身（§5.2 / §6.3）。
- **演示账号**不变：`admin` / 你 §0 设的 `TP_BOOTSTRAP_PASSWORD`、`demo_pm` / `Demo@12345`、`demo_ro` / `Demo@12345`。
- 前端：http://127.0.0.1:5173 → 顶栏选「演示商城」。左侧 **ADB 测试** 那一组
  （`设备管理` / `ADB 用例`）从 1C 的「1D 开放」占位变成真页面。

## 5. 演示路径 · 路 A：手持设备 / 模拟器（15 分钟）

> 本节假设你手上有一台 Android 12+ 设备或一个 AVD，并已按 §4 把真 adb 喂给了
> 后端与 worker 两个进程。对不上就跳 §7 排查。

### 5.0 让设备进入「host:port 可连」的形状（3 分钟，命令逐条可抄）

一期设备登记只认 **WiFi 地址**（`host:port` 的 serial；USB 写入口 422，D14，
界面文案直说「请用 WiFi 地址创建」）。所以无论真机还是模拟器，都先拨到 TCP 形状：

```powershell
# 三条都是 Android SDK platform-tools 的标准命令（adb / emulator 本体），
# 不是本仓库造的指令——仓库代码只负责在产品侧对 host:port 发 adb connect（§5.2）。
emulator -avd <你的AVD名>                    # 起模拟器（或手动：Android Studio → Device Manager → Start）
adb devices                                  # 应看到 emulator-5554  device
adb -s emulator-5554 tcpip 5555              # 让设备端 adbd 切到 TCP 5555 监听
adb connect 127.0.0.1:5555                   # 平台稍后做的事，先手动验一遍：回 connected to 127.0.0.1:5555
```

- 真机同理：先 USB 连上执行一次 `adb -s <串号> tcpip 5555`，拔掉线，
  用 `adb connect <手机WLAN IP>:5555` 验通。Android 11+ 也支持无线调试配对，
  但产品只吃「已能 `adb connect` 的地址」这一种前提——配对过程属 Android 侧操作，不在本仓库。
- **未实测声明**：本节命令在写手册的机器上没有真 AVD 实跑过（命令本身是 SDK 标准用法）；
  假设备通路（§6）对 `connect` 的回执形状做了端到端验证。

### 5.1 设备管理：卡片墙长什么样（2 分钟）

左侧「ADB 测试」→「设备管理」。

你会看到：顶部状态带四挡 **全部 / 空闲 / 占用 / 离线**（离线是**灰且安静**的，
不是故障红——心跳把 `online=False` 的帧原样落库、卡片如实画灰）；每张卡左侧一条 4px
状态色条（空闲绿 / 占用蓝 / 离线灰），卡面有机型、系统、电量（**新建设备首帧电量
明写「电量未知」**，不画 0% 假数）、心跳按 `agoLabel` 说人话——**60 秒内是「刚刚」，
再往后是 `Nm前` / `Nh前` / `Nd前`，没有 `Ns前` 这一档**（beat 没跑写「尚无心跳」）。
占用徽标**只显真实排队人数，没有「预计 3m」**——那数字没有公式出处，编它就是假数据（D17）。

### 5.2 登记设备：真 connect 验证，失败原样回显（3 分钟）

1. 右上角「添加设备」→ 名称填 `演示机`，WiFi 地址填 `127.0.0.1:5555`（或你的真机地址）。
2. 按钮不叫「保存」，叫 **「测试连接并添加」**——它就是 `POST /adb-devices`：
   后端先真发 `adb connect <serial>` + `getprop` 拉机型/系统，**连不上 422 零脏行，
   成功才 201**（`device_services.py` 的 `_connect_verify`）。

你会看到（**两个弹窗不要混**，2026-11-18 复核，原文把它们的回执并成了一句）：
添加成功只有**一句 toast**「连接验证通过，设备已入库（首帧已落）」+ 新卡片入墙——
机型/系统/设备屏截图（base64 PNG 内联）**不在这里**，它们属于卡片上的「测试连接」：
那条走 `TestResultModal`，才有「连接原话 + 机型 … 系统 …」与截图（`adbDevices.tsx:152`）。
失败时弹窗把 adb 的 stderr/stdout **原样回显**——拼错端口你会看到
`failed to connect` 本话，而不是「添加失败」这种废话。
3. 故意填一个死地址再来一次，看清失败形状；关掉，卡片墙没多出脏行。
4. 点新卡的「测试连接」随时重验（**机型/系统/截图在这一步的弹窗里**）；设备被跑着的
   用例占着时，占用详情是**队列徽标上的 Tooltip**（真实排队人数 + 持有者），
   卡片本身不可点、没有「进卡」这回事；死锁了有「强制释放」。

### 5.3 ADB 用例：命令列表 + 默认设备策略（3 分钟）

左侧「ADB 用例」→ 种子里那条「演示：设备体检两拍」已在（`shell getprop` + `sleep`）。

你会看到：列表列与 UI 用例同款，多一列 **「默认设备」**——值要么是某台设备的 serial，
要么是 **「任一空闲」**（执行时锁一台空闲机；存期不校验设备存在性）。
详情页顶栏是 `名称 | 优先级 | 设备策略 | 保存 | 调试 | 执行`——**没有环境选择器**
（2026-11-18 复核：ADB 用例打的是设备，不是 base_url，`adbCaseDetail.tsx` 全文 0 处「环境」；
1C 那条「环境▾」只属于接口/UI/场景那几页）。设备策略选择器就是
（指定设备▾ / 任一空闲）；选了库里没有的 serial 会挂一枚橙色「设备未登记」标，
tooltip 写明「能存，但执行时会如实报默认设备不在可用设备里」。
命令编辑器与 1C 的 UI 命令列表同族，类型换成设备侧——**清单就是 `web/src/adb/commands.ts:27`
的 26 种**（`connect / shell / install / uninstall / start_app / kill_app / click_xy /
long_click / swipe / input_text / click_by_text / click_by_xpath / assert_text /
assert_element / assert_toast / screenshot / screen_record_start / screen_record_stop /
sleep / file_push / file_pull / assert_file / back / home / open_url / extract_ui_text`）。
**没有 `tap` / `launch` / `logcat`** 这三种（原文列过，是编的：点击叫 `click_xy`、
启动叫 `start_app`、抓日志压根没做）。完整清单以页面「+ 添加命令」下拉为准，
做不了的照旧不进清单。

**没喂 adb 时的失败形状（路 C 演这里）**：执行这条用例 → run 落终态 error，
报告里每条命令标 **「adb 不可用，全部步骤未执行」**（不是「设备未连接，未执行」——
那句只属于 adb 在、但 `adb connect` 真失败的情况，见 §4 的两种病）；
建设备则 422，报错原文是 adb 安装指引。页面不假装跑过任何东西。

> 这一路只演到**红本身**：那行 skip 的原因文字在 ADB 报告页上今天**读不出来**——
> 命令行（`kind` = 步骤类型、parent 是 `adb_case` 汇总）在 `reportDetail.tsx:586` 要
> `hideHttp` 才渲染回执，而 `hideHttp` 只在 parent 是 `ui_case` 时为真（`:360`/`:438`）。
> 所以现场能说的是「run 红 + 每条命令一行 skip」，那句原因请看接口响应
> （`GET /reports/{id}/steps` 的 `detail.message`）或 API 侧断言。别在页面上找它。

### 5.4 调试 vs 执行：一颗同步、一颗进报告（3 分钟）

- **调试**（`adb-case-debug`）：同步真跑一遍，**默认不在报告中心**（不是"不进"——
  它照样落一条 `trigger=debug` 的 RunRecord，报告中心右上角「含调试」默认关着，
  打开就能看到；用例页调试钮的 tooltip 也是这么写的），**设备占用不排队**，
  结果落在底部面板：逐命令状态与耗时，`screenshot` 步有 `adb-debug-shot-<id>` 真图内联，
  面板顶部徽标写清这次走的哪条 UI 通路——有 atx/控件树会话时是会话模式，
  否则明写 **「降级：dump 轮询（慢但判定同一份）」**。降级不是失败，是如实标注。
- **执行**（`adb-case-run`）：`POST /adb-cases/{case_id}/run` 投 worker（`trigger=manual`），
  回 `{"run_id":"…","status":"queued"}`；设备被占**不拦**——但**排队只发生在「指定设备」策略**：
  后台 run 按 FIFO 排队，位次只报真实读数。**「任一空闲」不入队**——
  抢不到就 `dequeue` 退队再试下一台候选（`debug_services.py` 原话「轮询策略不占队」），
  所以那条路上根本没有位次读数，不是「排队排在别人后面」。
  broker/worker 没起回 503 且**不留 queued 孤儿**（比 1C 时期
  UI 那条「queued 挂死」的坑处理得更前，但 worker 仍是必起项，§4.2b）。

### 5.5 报告详情：一条 ADB 运行长什么样（2 分钟）

报告中心 → 点开那条运行。

你会看到：概览卡挂 **「ADB 用例」类型标**（火山色系，与「接口 / 用例 / UI 用例 / 场景」并排；
词表在 `web/src/shared/runVocab.ts:91`，`api_case` 的标签是 **「用例」** 不是「API 用例」——
「API 用例」是场景编排里步骤节点的标签，两张表别念串）；
左树第一行是用例本身（`case`），下面每个命令一行；点 `screenshot` 行，右栏制品
`SCREENSHOT · <名字>.png` **直接当图片看**（真解码，e2e 钉 `naturalWidth > 0`）；
点 `assert_text` 行，断言明细按**预期 / 实际**两列渲染（报告详情的列头就是这两个字；
「期望」是接口调试面板的措辞，别在报告页找）。用例列表「最近结果」跟着变绿——仍只有正式执行回写这一列。

> **ADB 报告右栏的两处现状要说在前面**（2026-11-18 复核，别照着旧文案演）：
> ① 逐命令的**回执文字**（`detail.message`，如 `skip` 的原因）在 ADB 行上不渲染——
> 那条渲染挂在 `reportDetail.tsx:586` 的 `hideHttp` 判据下，而 `hideHttp` 只认
> parent 是 `ui_case`（`:360`/`:438`）；② 于是同一块位置反而落上「请求 / 响应」两个
> **空 JSON 编辑器**（ADB 步的 detail 里没有这两样，编辑器就是 `{}` 和 `null`）。
> 这正是本页给 UI 步写下的纪律想避免的形状（`:676-677` 原话：「摆一个空 JSON 编辑器就是装样子
> （纪律 1），分流后整块不渲染」），ADB 这条没吃到分流。**已按 PRODUCTION DEFECT CANDIDATE
> 上报（D154），等裁，不在手册里顺手改代码。**
> 演示时能讲的是：状态色、耗时、制品图、断言表——回执那句话请从 API 读。

### 5.6 混合场景压轴：api + sleep + if + adb_case 一景（4 分钟）

「场景编排」→ 新建/复制一个场景 → 左栏资产树依次拖入：
**HTTP 直连**（`GET http://127.0.0.1:9999/healthz`，断言 200）→ **等待**（sleep 100ms）→
**判断**（`if` 节点的标签就是「判断」，`web/src/scene/stepTypes.ts:82`；没有叫「分支」的节点，
留一条走得到的 else 分支）→ **ADB 用例**（选「演示：设备体检两拍」，
设备策略指定 §5.2 那台）→ 保存 → 执行。

你会看到（判据与 `web/e2e/mixedScene.spec.mjs` 钉的同一套）：
- 画布四个节点按结果着色（通过绿 / 错红 / 跳灰）；
- 报告左树**四种步骤同场**：接口步、等待步、判断容器（未走的分支子步**不出现**——
  没跑过的步不落库，树不撒谎）、ADB 用例步；
- 概览统计卡的「步骤」项是**顶层四步的口径**，原文形状是「4 顶层 过 4 败 0 跳 0 错 0」
  （`reportDetail.tsx:504`）。「共 4 · 过 4」那句是**场景调试抽屉**的话术
  （`scene/DebugDrawer.tsx:166`，还多带「取消」一档），别在报告页找它；
- 主题着色的类型标（「场景」）与「ADB 用例」独立运行报告同源同色。

> **ADB 步的「在哪台设备、什么 mode」今天在报告页读不出来**（2026-11-18 复核）。
> 数据是真的：`handlers.py:606-612` 把 `mode` / `device` / `artifacts`（带 ref 的摘要）
> 都落进了步骤 detail，e2e 也从**接口**钉着它们（`mixedScene.spec.mjs:202-206`）；
> 但 `StepDetailExtra`（`reportDetail.tsx:43-53`）没这两个字段，页面一处都不渲染。
> 要看：`GET /reports/{id}/steps`，或在调试面板看 mode 徽标（§5.4）。
> 同样读不出来的还有制品摘要——**场景报告页对 adb 步既没有图、也没有"制品摘要"这行字**：
> 场景 run 自己的 `run_artifact` 不含 adb 子 run 的截图（`handlers.py:562-564` 的注释
> 记录了这个边界，原文把它记在 `debug_services.py` 名下是记错了），而右栏制品区读的是
> `report.artifacts`（`:364`）——所以 e2e 直接钉 `sceneShots == []`
> （`mixedScene.spec.mjs:217`）。要看图：点进那次 ADB 子运行、看独立 ADB 运行报告
> （§5.5，那张是真解码 `naturalWidth > 0`）或调试面板（§5.4）。

## 6. 演示路径 · 路 B：免模拟器的全绿通路（假设备，10 分钟）

### 6.1 先说清八道门禁与模拟器**毫无关系**

**八道门禁（§7）不需要 emulator、不需要真机、不需要任何 Android SDK。**
1D 的测试证据全部跑在仓库自带的假设备夹具上（`backend/scripts/fake_device/`），
它的替身位置是这样的：

- 产品代码里每一条 adb 命令都经过 `adb_cli.py` 的 `adb_executable()` →
  `settings.adb_path`（`TP_ADB_PATH`）这一**唯一入口**；
- `FakeDeviceManager`（`manager.py`）生成一个假可执行（Windows 是 `fake-adb.cmd`，
  内容是 `@py -3 fake_adb.py %*`）+ 一个 JSON 状态文件，把假可执行的路径喂给
  `TP_ADB_PATH` 即完成注入——**产品侧一行代码都不改，spawn/解析/超时的真实代码路径全部照走**；
- 假 adb（`fake_adb.py`）是个小状态机：`connect` 回 `connected to`、`devices` 按状态文件
  回表、`shell getprop` 回机型、`exec-out screencap` 回一张真 PNG、`uiautomator dump`
  回一份含「登录」字样的控件树 XML——所以 `assert_text` 有真断言可断、`screenshot`
  有真图可存制品；状态文件每次调用实时读，e2e 进程改文件就能改「设备形状」；
- **u2/控件树会话模式是内核内 monkeypatch**（`fake_u2`，只在 pytest 进程内生效），
  跨进程的 e2e/演示通路吃不到它——所以免模拟器的一切绿色证据都是 **dump 轮询模式**，
  界面上如实显示「降级：dump 轮询（慢但判定同一份）」。判定逻辑两者是同一份，UI 采集通路不同。

生成一对「假 adb 可执行 + 状态文件」路径（cwd 必须是 `backend`，之后填进 §4 的两个
`$env:TP_ADB_PATH`，后端进程还要多设 `$env:FAKE_ADB_STATE`）：

```powershell
cd backend
.venv\Scripts\python.exe -c "import json,os,sys; sys.path.insert(0, os.getcwd()); from scripts.fake_device import FakeDeviceManager; mgr=FakeDeviceManager().with_device(serial='127.0.0.1:5555'); print(json.dumps({'TP_ADB_PATH': mgr.adb(), 'FAKE_ADB_STATE': str(mgr.state_path)}))"
```

### 6.2 免模拟器跑通 §5 全部演示动作

把上面打印的两个路径分别填进后端与 worker 的 `TP_ADB_PATH`（后端再加 `FAKE_ADB_STATE`），
然后 §5.2 到 §5.6 的每一步**原样可做**：

- 「测试连接并添加」`127.0.0.1:5555` → **201**（入库 + 首帧），机型/系统/截图来自假设备，
  在卡片「测试连接」的弹窗里看（同 §5.2 的两个弹窗区分）；
- 调试面板全绿，`screenshot` 步骤内联的 PNG 就是假 adb 吐的那张（真解码显示）；
  模式徽标显示 dump 降级字样——**这条降级在免模拟器通路是永久形状，如实留着**；
- 正式执行进报告中心、「ADB 用例」标、断言行、制品，全部同 §5.5；
- 混合场景（§5.6）四步全绿。
- 想让设备「离线」给状态带看：改状态文件里那台的 `state` 为 `offline` 即可
  （心跳下一帧落灰卡）——这是假设备独有的演示自由度，真机你得拔网线。

### 6.3 e2e 侧的同一对路径

`web/e2e/mixedScene.spec.mjs`（1D T10 的 DoD 证据，**两条路都实跑过：不设变量 79 passed / 2 skipped，
设了变量 81 passed / 0 skipped**，T11 门禁轮）
与 §6.1 同一对接法：跑 e2e 前设 `TP_ADB_PATH` + `FAKE_ADB_STATE` 两个环境变量，
`web/playwright.config.ts` 会把它们直通给 8321 后端；不设则混合场景的 adb 腿按
「无设备可跑」的确定性红形状断言（两种形状都有测试钉，不设环境变量不会假绿）。

## 7. 八道门禁（命令与 README.md 逐字同源）

> **再钉一遍：这一段没有一条命令需要模拟器或真机。** ①–④ ⑧ 跑 `backend/`，⑤–⑦ 跑 `web/`，
> 所有 adb 相关测试走 §6.1 的假设备夹具（CI 连 Windows 都不是——POSIX 下
> `FakeDeviceManager` 生成的是 shebang 版假可执行）。

```bash
cd backend
.venv/Scripts/python.exe -m pytest -q                        # ① 单测/集成（需 MySQL + Redis）
.venv/Scripts/python.exe -m ruff check app tests migrations scripts   # ② lint
.venv/Scripts/python.exe -m mypy app                         # ③ 类型（§14 写了很久，1C+ 起才真的跑）
.venv/Scripts/lint-imports.exe                               # ④ 模块边界四契约（只认打印文字，别用 -m importlinter）
cd ../web
pnpm lint && pnpm test                                       # ⑤ eslint + ⑥ vitest（秒级，先挡便宜问题）
pnpm build:e2e && pnpm exec playwright test                  # ⑦ e2e 构建 + e2e（生产包另跑 pnpm build）
cd ../backend
.venv/Scripts/python.exe scripts/migrate_dev.py              # ⑧ 开发库对齐 head
```

- ④ 只认打印文字，过线证据是字面一行：**`Contracts: 4 kept, 0 broken`**。
- ⑦ 用的是 `build:e2e` 而不是 `pnpm build`（`probe.html` 夹具页只在 e2e 档进包，
  拿生产产物跑会被 `web/e2e/globalSetup.mjs` 当场拦下）；`pnpm e2e` 已串好。
- **本轮各门禁实跑数字：见 README 本轮实跑**（README.md「提交前必跑」一节按批次滚动记录，
  1D 的最终数字就是那条「1D 收尾轮实跑（T8–T11）」）——手册不抄死数字，抄了就会过期。
- 跑 ①⑦ 前照旧确认没有手工起的 5173 preview（`reuseExistingServer` 会假绿）；
  手工起的演示 worker 自 1D T0 队列分道后不用再停（R118 根治）。

## 8. 三个「为什么长这样」

**8.1 为什么 USB 设备登记不了（D14）**
`adb_device_create` 对 `connect_type=usb` 直接 422：「USB 连接设备一期暂不支持写入口」。
USB 串号的稳定标识、掉线重连、多线并发锁与 WiFi 地址是两套生命周期，半做等于做假。
列表里 USB 读得到（历史/后续批次数据），写入口不开。

**8.2 为什么占用徽标上没有「预计 3m」**
sketch 里那行预估时长没有公式出处——设备跑多快取决于用例和真机，编一个数就是假数据（D17）。
所以队列徽标只显**真实排队人数**，个人位次在发起执行那一刻起才有真实读数。

**8.3 为什么调试默认不在报告中心、执行才进**
与 1B/1C 同一条口径：调试是过程不是结论，通过率不能被试出来的东西污染。
落地形状要说准（§5.4）：调试**照样落一条 `trigger=debug` 的 RunRecord**，
是报告中心默认用「含调试」开关把它挡在筛选项之外——不是没写库。
ADB 调试还多一层语义：**不排队**（同步占用一台空闲机），所以它连「排队位次」都不产生。

## 9. 常见问题

**Q：点「测试连接并添加」报「没找到 adb 可执行」。**
A：后端进程没带 `TP_ADB_PATH`（§4.2）。报错原文就是安装指引（`adb_path.py` 的 `ADB_INSTALL_HINT`），照它修。
**注意另一种形状**：`TP_ADB_PATH` **设了但指不到文件**（路 B 的 wrapper 没生成 / 路径打错）时，
`adb_path._explicit_path` 抛的是 `FileNotFoundError`，而 `_connect_verify` 只接 `RuntimeError`
（`device_services.py`）→ 一路冒到全局兜底，回 **500「服务内部错误」**，既不是 422 也没有安装指引。
看到 500 别去查 adb 装没装，先 `ls` 一遍 `TP_ADB_PATH` 那个路径存不存在。
（已按 PRODUCTION DEFECT CANDIDATE 上报，见 1G 台账「第二十七轮续」的 D158。）

**Q：设备卡全在，但「最后心跳」一直停在很久以前，离线永远画不出来。**
A：beat 没跑——worker 少了 `-B`（§4.2b）。心跳任务在 beat 调度表里，进程不在就没人发新帧。
**别去找「尚无心跳」这四个字**：登记与重连都会当场落一帧带 `last_check_at` 的状态
（`device_services.py` 的 `_state_frame`），所以 beat 缺席时卡片显示的是「最后心跳 刚刚」
然后一路老成 `Nm前 / Nh前 / Nd前`；「尚无心跳」只在 `last_state` 整体为空的行才出现，
而产品代码不造这种行——它是页面挂着的一个真实数据下读不到的标。

**Q：执行 ADB 用例回 503 executor_unavailable。**
A：worker/broker 没起（1C §7 同款）。这条比 1C 的好处是不留 queued 孤儿行。

**Q：调试面板模式徽标一直写「降级：dump 轮询」。**
A：免模拟器通路（假设备）和没装 atx 的设备都是这个形状，**判定是同一份**，
只是 UI 采集走 dump 轮询。徽标写「降级」是如实标注，不是报错。

**Q：混合场景报告里 ADB 步没有截图缩略图，也没有「制品摘要」那行字。**
A：当前边界（§5.6 末尾）：截图字节挂在 ADB 子运行名下，场景 run 自己的 `run_artifact`
不含它们（`handlers.py:562-564`），而右栏制品区只读 `report.artifacts`——所以**图和摘要都不出现**
（e2e 就钉着 `sceneShots == []`）。要看图点进 ADB 子运行或看独立 ADB 运行报告。

**Q：ADB 报告的右栏为什么没有逐命令回执 / 还多了两个空的「请求」「响应」？**
A：ADB 步没吃到 UI 步的右栏分流（判据只认 `ui_case`，见 §5.5 的框）。回执与 mode/device
都在步骤 detail 里，从 `GET /reports/{id}/steps` 读；页面侧已按缺陷候选上报，等裁。

**Q：跑 e2e 时 mixedScene 的 ②③ 两条 skip 了。**
A：没设 `TP_ADB_PATH`/`FAKE_ADB_STATE`（§6.3）——skip 并写明原因正是设计，不装绿。

## 10. 1D 交付边界（诚实清单）

**已可用**：设备管理（真 connect 验证登记、原样回显失败、三态状态带、15s 心跳帧、
占用/强制释放/真实排队读数）、ADB 用例（命令列表编辑器、默认设备策略、存期不校验+
执行期如实报不在清单）、调试（同步真跑、dump 降级如实标注、截图内联）、
正式执行（worker 队列、FIFO 排队、503 不投孤儿）、ADB 运行报告（「ADB 用例」着色 +
逐命令**状态/耗时行** + 制品图 + 断言表。注意：逐命令**回执文字**在页面上不渲染，
见 §5.5 的框——原文把这两件事写成一件，2026-11-18 改口）、
混合场景（adb_case 作场景步骤与 api/sleep/if 同场，
计划 DoD「api+登录→建单→while→数据驱动→UI→ADB 一景」的 adb 半边）、
免模拟器全套证据（假设备夹具吃到八道门禁与 e2e）。

**需要真机才能演的**：u2/控件树会话模式（假设备吃不到跨进程的 atx 会话，见 §6.1）、
Android 12+ 真机上的安装/启动/弹窗类命令、心跳对真实电量的读取、§5.0 的 AVD/真机拨号。

**待业主裁 / 后续批次**：USB 写入口（D14，一期 422 是口径不是缺陷）、
列表「启用」是否拦执行（D7，与 1C 同一件事）、场景报告页内联 adb 子运行截图
（制品路由边界，§5.6）、队列时长预估（D17，明确不做）、
通知与定时跑 ADB（1E）、视觉回归/截图比对（蓝图没有，一句都不承诺）。
