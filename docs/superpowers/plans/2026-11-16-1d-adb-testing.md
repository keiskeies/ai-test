# 1D ADB 测试（WiFi 设备 + 心跳 + 设备锁 + 步骤编辑器 + uiautomator2 + 混合场景 DoD）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development 或 executing-plans 逐任务实现，checkbox 跟踪。
> 实现前若与本文件冲突，**先改本文件再改代码**，冲突不可静默吞掉（1A/1B/1C 同规）。
> 蓝图验收底线原文：`docs/2026-11-13-ai-test-platform-design.md:1597`
> 「**1D(3~5 周)** ADB:WiFi 设备管理 + 心跳 + 设备锁 + 步骤编辑器 + uiautomator2 控件操作 + 截图制品。**1D 末达成混合场景端到端 DoD。**」

**Goal:** 一期 1D 落地——**WiFi 设备管理**（§4.5 三表 + §11.4.14 卡片墙 + 先 `adb connect` 验证再入库 + 15s 心跳入库）、**设备锁**（§6.4/§8.7：SETNX `adb:dev:{id}`、同设备串行跨设备并行、排队显位次）、**ADB 用例**（§7.3 二十六步型 + §11.4.12 **与 UI 用例共用**的步骤编辑器）、**执行核 `adb_core`**（CLI 覆盖 shell 类、uiautomator2 覆盖控件树类、§6.4 预设降级线 `uiautomator dump`、失败自动截屏、整案录屏、push/pull 走制品）、以及 1D 末的硬验收：**混合场景（API + 等待 + 判断 + ADB）执行 → 报告 端到端**（§13；1C 明确把这条 handed 给 1D：`2026-11-16-1c-ui-testing.md:19`）。R111 那套「七处一起摘」的 `adb_case` 插槽本轮全部翻开。

**Architecture:** 照搬 1B/1C 已验证的分层，不发明新的：
1. **领域模块 `app/modules/adb_test/`**——设备/模块树/用例三类资产 + §7.3 步骤协议与保存期校验（纯函数 `commands.py`，前端有孪生表）+ 调试端点。不认识 api_test/scenario/agent（契约 1 + 3）。
2. **执行核 `app/modules/execution/adb_core.py`**——与 `ui_core.py` 同层：不懂资产、不懂 step_graph，只吃「步骤列表 + 设备解析结果 + 选项」吐结构化结果。**契约 4：零 `app.modules.*` import**；`subprocess` 全 list-form（见前置取证 ④）。uiautomator2 **函数体内惰性 import**（同 playwright 的 R95 教训）。
3. **跨模块取数走注册表**：`adb_case_resolve`（`http=None, tool=False`），与 `api_case_resolve`/`ui_case_resolve` 一对一镜像；引擎侧 `h_adb_case` 经 `ctx_from_actor` 重建身份（1C+ 已收敛成一处）。
4. **设备 I/O 全部藏在 DeviceService 薄接口后**（D2 原话：「两者都藏在 DeviceService 后面」）——`adb_core` 与设备服务只经 `execution/adb_cli.py`（stdlib subprocess 的薄壳）和 u2 包装函数碰真二进制，假设备 fixture 替换的正是这一层。

**Tech Stack:** 后端新增 **`uiautomator2>=3.0`**（蓝图 §5.4 点名，唯一新依赖；已装进 venv 实测可用）+ adb CLI（二进制路径进 `settings.adb_path`，**不假设在 PATH 上**——本机实测 adb 不在 PATH，在 `%LOCALAPPDATA%\Android\Sdk\platform-tools\`）。前端**零新依赖**（编辑器参数化是重构不是新增）。

**Spec 覆盖:** §4.5（adb_device/adb_module/adb_case + owner_id/project_public）、§6.4 全部一期条目、§7.3（26 步型）、§7.4 `adb_case` kind、§8.1/§8.7（设备锁与排队位次、取消在步边界生效）、§8.8（制品复用，SCREENSHOT/VIDEO kind 已预留）、§11.4.12/11.4.14（编辑器共用 + 卡片墙）、§10.1（`adb:*` 三段式权限位；唯一蓝图字面例子是 `adb:device:update`）、§9.2（全部 adb 服务进 agent 工具面，覆盖率 100% 标注）、§12（复用 run 事件通道）、§14（假设备 fixture 进 CI；真设备不进）。

**不在 1D:** scrcpy 实时投屏（§6.4 明写 [三期]）、`device_status` agent 卡片（协议预留了 kind，无批次归属→D19）、排队「预计 3m」估算（公式无出处→D17，只显位次）、「异常」红色状态过滤器（§11.4.14 mock 只有 全部/空闲/占用/离线→D18）、定时/通知（1E）、混合场景 DoD 里的「定时→通知」延伸（§13:1601 的 1E 部分；1D 末验收止于「执行 → 报告」，见 D20）。

---

## 前置取证（写计划之前已经跑通的事实，全部今天实测）

结论是硬前提；每条都可复跑。环境：本机 **无物理设备**，用 Android Studio SDK 的 AVD。

1. **WiFi/TCP ADB 这条路是真的能走通的产品路径（D2 的实体证据）。**
   `adb connect 127.0.0.1:5555` → `connected`；`adb devices` 同时列 `emulator-5554` 与 `127.0.0.1:5555`。
   getprop/`dumpsys battery`/`am force-stop`/`monkey 启动` 全通。
2. **uiautomator2 在 TCP ADB 上开箱可用**：`u2.connect("127.0.0.1:5555")` →
   `info` 有机型、`dump_hierarchy()` 28,989 字符、`press('home')`/`app_current()` 生效、
   `d(text=...).exists` 命中与未命中都正确（**返回 bool，不抛**——断言步骤的语义基础）、
   `screenshot()` 1080×2220，转存 PNG 505,454 字节。→ 「控件级走 u2、其余走 shell」不悬空。
3. **§6.4 的「预设降级线」有一个蓝图不可能知道的硬冲突（本批次最重要的实测）：**
   `adb shell uiautomator dump` 与 uiautomator2(atx-agent) **互斥**——u2 instrumentation 在跑时
   dump 一律 `rc=137`（SIGKILL），u2 不在时 6/6 成功（6 连测，`codes=[137×6]` vs `[0×6]`；
   与 atx-agent 进程在不在无关，杀 atx 后仍 137，是 **uiautomator instrumentation 服务被 u2 占着**）。
   → 降级线的**正确语义**是：**建连阶段** u2 起不来（atx 部署失败）→ 整次执行走 dump 轮询模式；
   不是「执行中每步二选一」。混用会当场杀进程，这不是假设，是上面那 12 次采样。
4. **二进制不能从文本通道读**：`exec-out screencap -p` 经 `text=True` 直接 `UnicodeDecodeError`
   ——`adb_cli.py` 必须 bytes 模式透传，制品/截图路径禁止 `text=True`。
5. **git-bash 会把设备路径改写到宿主路径**：裸 `… shell wc -c /sdcard/r.mp4` 里的
   `/sdcard/r.mp4` 被 MSYS 改写成 `/Files/Git/sdcard/r.mp4`。→ **argv 一律 list-form、
   不经 shell 字符串**；e2e/手工脚本同理。这条坑同样骗过我的探针（第一次 push/pull 全错在传参）。
6. **录屏与文件往返是真的**：`screenrecord --time-limit 2 /sdcard/r.mp4` → 远端 46,582B，
   `pull` 后本地 **46,582B 字节一致**；`push` + `cat` 内容一致。整案录屏 = 起 `screenrecord`
   （长时限、`shell` 分离执行）+ 收尾 `pkill -2 screenrecord`（SIGINT 才会 finalize mp4）+ pull。
7. **心跳预算**：`adb devices` 23ms、`getprop` 24–30ms、`dumpsys battery` 26ms → 每设备一次心跳
   3 个子进程 ≈ 80–100ms；15s 周期 × 个位数设备完全够（solo worker 也够）。`screencap` 545ms——
   所以截图只在**失败时**拍，不进心跳。
8. **CI 不需要真设备**（蓝图 §14 原文就是口径）：「内置沙盒靶场…**假设备 fixture** 供 CI」、
   「Playwright E2E 覆盖三条金路径(… / **ADB 挂 mock 设备**)」。→ T1 的假 adb 二进制 fixture
   是产品级测试地基，emulator 只做手工演示与 nightly，不进 PR 门禁（门禁里它也不该出现：
   本机 emulator 是给**演示与取证**的，红/绿不得依赖它在不在——1C golden 的「响亮 skip」同款）。
9. **WHPX 可用**（`emulator -accel-check` → 0），AVD `Pixel_3a_API_35…` 能 headless 起——
   演示手册的手持路径用 `-no-window -no-audio -no-boot-anim`。
10. **依赖面**：`uiautomator2` 未入库（本轮装入 venv）→ `requirements.txt` 钉 `>=3.0`；
    mypy 口径预计要给它加缺 stub 豁免（同 celery，只豁免这一家，附实测条数）。
11. **`assert_toast` 在 uiautomator2 3.7.1 上没有可用 API（实测，写计划的人必须知道）：**
    `d.toast` 存在但 `show(...)` 打到设备端 RPC 直接 `-32601 method not found`
    （u2 3.x 移除了 toast 服务），`get_message(wait_timeout=…, default=None)` 签名在、
    永远返回 None。→ **`assert_toast` 不许按 u2 toast API 实现**（那是界面能配、执行恒假的
    假功能形状）。可选实现 = 在超时窗口内轮询控件树找 `android.widget.Toast` 节点
    （dump 里 Toast 是独立窗口）——但我本机连发两次系统级 toast 现场（无处理程序 intent）
    **都没能在 dump 里抓到 Toast 节点**（Android 12+ 后台 toast 限制 + 存活窗口极短），
    即这条路**未证实**。裁决前进路：先实现成「轮询控件树找 Toast 节点，抓不到 = 断言失败
    并如实写 `toast capture unverified on this platform`」，假设备 fixture 里注入 Toast
    节点把**解析逻辑**测透；真机行为留给业主设备验证。列 **D21**。
12. **`open_url` 有现成可用路径**：`am start -a android.intent.action.VIEW -d <url>` 实测
    `Starting: Intent { act=…VIEW dat=https://example.com/… }`。与 ⑪ 的 intent 是同一族
    shell 调用，走 CLI 不走 u2。

## 批次决定记录（承 1C+ 的 R 序，实现时逐条补全）

**号段公告（与并行 session 的撞号记录）**：R138 已被 04de217 用于「R118 队列分道根治」
（内容属实，那正是本计划 T0 的落地）。本文件原预留的 R138/R139 相应后移：
- **R139 ·（T6 已回填形状；锁的 TTL/泄漏部分待 T5 尾注复核）** u2 与 `uiautomator dump` 的互斥与降级线落地形状（前置取证 ③/⑪）：
  **建连阶段一次定模式**（`run_adb` 里 `adb_u2.connect_session(serial)` 连得上 = `u2`，连不上/没装 u2 = `dump`），
  整案不再逐步二选一——取证 ③ 的互斥意味着「这步用 u2、下步用 dump」本身就是不可能同时成立的两种现场。
  降级**不写 error**（「慢但可用」不是故障），可见性走 `AdbRunResult.mode`；execution 包不打日志（ui_core/api_core
  同样零 logger），所以「进日志与 run 详情」由 T7 的 `_execute_adb_run` 落，代码内已就地写明责任归属。
  两模式**共享同一份判定代码**：控件树语义只在 `_Tree`（ElementTree）上实现一次，u2 与 dump 只差「怎么取树」
  （一次 RPC vs `uiautomator dump` 落盘 + `cat` 读回），所以「同案两模式两种结论」在结构上不可能，
  `test_click_by_text_same_verdict_in_both_modes` 另把 message 逐字同形钉住。dump 失败时 rc=137 的
  message 会点名「dump 与 uiautomator2 互斥」——设备被别的 u2 会话占着是真实故障，说清才有排错路。
- **R140 ·（T5 已落地，此处按落地形状回填）** 设备锁的崩溃泄漏语义（D16 假设）：`SETNX adb:dev:{id}` + TTL +
  持有者 token 心跳续期 + **WATCH/MULTI/EXEC 的 token 校验释放**（原写 Lua，fakeredis 无 lupa → 落码裁定为事务，
  events.py 已为同一理由记过账）；队列位次用 `lpos` 如实展示（fakeredis 2.40 无 `RPOS`，token 队内唯一时两者等价），不做估算。
  落码位置 `execution/adb_lock.py`（契约 4：真消费者是执行核）；强制释放 = 删锁 + 清队 + 审计。
  证据：commit `1b2f233`（`tests/test_adb_lock.py` 10 例 + `test_adb_device.py` 3 例）。
- **R141 · D11 立专项并修掉（1C 遗留，业主 1C+ 裁「立专项」的那条）** 首帧 `running` 可丢，两处窗口各自闭合：
  ① **`EventBus.subscribe` 曾经是 async generator**——`agen = bus.subscribe(ch)` 那一行什么都没订阅（函数体
  要到第一次 `__anext__` 才跑），于是 `core/sse.py` 那句「先订阅，消除重放完-再订阅的窗口」的注释在说谎。
  改成 `await subscribe()` 返回 `_Subscription`：**await 到返回时 SUBSCRIBE 已在服务端生效**，窗口才真的关上。
  ② **重放读的是路由早期钉下的旧快照**——MySQL 实测 `@@transaction_isolation=REPEATABLE-READ`，SSE 路由在
  鉴权与「运行存在性」两处已经发过 SELECT，快照即钉在那一刻，其后 commit 的事件查不到。
  **换快照点放 `build_run_sse`/`build_agent_sse`（建流处），不放 `replay_events`/`store.replay`**——这条是修
  程中量出来的教训：那两条函数也服务 REST 路，在它们内部 `rollback` 会把调用方尚未提交的写一起丢掉
  （第一版正是这么写的，`test_agent_timezones` 当场变红：flush 之后取消息取不到了）。
  取证：`tests/test_sse.py` 三条新钉（返回即已加入 / 重放进行中发布的首帧不丢 / 建流换快照且重放绝不 rollback）
  ——前两条在旧形状下实测红，第三条在摘掉 `rollback` 后实测红；`sceneRun.spec.mjs` 连续 **9 次全绿**
  （基线是 1C 量的「9 次里 3 次红」，README ⑦ 同口径复核）。
  **顺带修的两处同坑**（都在 D11 修复暴露出来的路上，不是顺手清理）：`verify_worker.py` 的靶场探活用
  裸 `httpx.AsyncClient()`，本机 `no_proxy` 含 `[::1]` 让 httpx 抛 `InvalidURL: Invalid port: ':1]'`，
  异常被 `except: pass` 吞掉 → 靶场明明 200 在跑（urllib 实测）而它报「20s 没起来」，
  `test_golden_1b` 的 celery 端到端就此长红；加 `trust_env=False`（执行核 `execution/core.py` 早就钉过同一条）
  并把最后一次探活错误打进 FAIL 行。`model_cfg` 的探活同坑，但它把错误如实回显（不装死），
  且「出站请求是否该被宿主代理左右」属 1E 通知渠道同一裁决面 → 记进 1E 的 R142，不在本批偷改。
- **R145 ·（T8 落地裁定）引擎的 adb_case 步骤经 T7 的执行体跑，不在 handler 里另起炉灶。**
  形状裁定三条：
  ① **R102 的第三种触发**：`h_adb_case` 不 import adb_test（契约 1 同 ui_case 口径——handler 只经
  `REGISTRY` 取 `adb_case_resolve`），执行本身经 `_execute_adb_run` 的既有公共入口
  （`amain_adb_run` 的协程本体）跑：场景步骤 = 造一条 `subject_type=adb_case` 的 queued run 行
  （trigger 沿用 manual：场景步骤不是 debug，人在等的语义只有调试按钮有）→ 进程内 await 执行体 →
  读这条 run 的结论折成 StepOutcome。**执行体一份**这条线由 `test_engine_handlers.py` 的
  「handler 与 worker 走同一协程」钉住（h_ui_case 是 monkeypatch run_ui 的单元档；adb 这侧真挂
  假 adb fixture 全链跑，因为执行体的设备锁/租约层没有第二个可替换缝）。
  ② **场景内设备策略（§11.4/plan D17）**：后台/场景步骤**可以排队**（execution body 的
  background 档：FIFO + `device_queued` 事件真位次），debug 永不排队的旧钉不动——差别只在
  run 行的 trigger，执行体已经按它分流，引擎一个字不碰。取消/deadline 在步边界生效由执行体
  自带（取消键就是场景总线上的 `cancel.<run_id>`，键名逐字相等是 T7 docstring 已认账的契约），
  引擎的职责钉在「把正确的 bus 与 run 身份递下去」。
  ③ **`BLOCKED_1B`/`PENDING_KINDS` 摘空但机制保留**：常量、dispatch 的 PENDING 闸、graph 的
  `kind_not_available` 分支原样留着（未来批次还要用），清空的是内容；`adb_case_references` 的
  「恒回空」叙事随本批作废——引用通道改钉真检出（直插与真保存两条都钉）。
  ④ **画布的设备策略必须真生效（本轮实测补的洞）**：T9 的前端先把 `device_policy`/`device_serial`
  两个控件做出来了，后端却只读 `ref`——「界面能配、执行悄悄忽略」正是 §13 纪律 1 禁的假旋钮。
  补齐的管子只有一条：`h_adb_case` 把节点 config 递给 `adb_case_resolve` 与 `adb_case_engine_run`
  → 两者共用 `_step_device` 归一 + `_resolve_parts` 一处判定（**一把尺子**：预检与执行不同尺，
  就是面板说「能跑」、执行到第 7 步才红）→ 覆盖只改「跑哪台」，排队/422 仍按 trigger 分流。
  残缺（specified 无 serial / 认不出的策略词）不静默回退到「任一空闲」——回退会让用户以为跑在
  他点的那台上，比报错危险；保存期由 `graph._required_config` 的 adb_case 分支先拦（前端孪生
  `graphOps.requiredConfig` 同尺）。红能力实证：把 `_adb_engine_run(ctx, case_id, config)` 的
  config 参数摘掉 → `test_step_device_policy_overrides_case_default` 立刻红（跑回默认机）。
  ⑤ **顺带修的两处真缺陷（测试证明，非设计改动）**：`adb_case_engine_run` 终态读要
  `populate_existing`（identity map 的旧值会把跑通的步骤折成 error）；`web/src/api/schema.d.ts`
  在 HEAD 上是**陈旧的**（缺 adb-modules/adb-cases 两组路由，1D T4/T7 之后没人重跑 `gen:api`）
  ——本轮 `pnpm gen:api` 重生（1691 增 / 979 删）后 `tsc --noEmit` 0 错。教训：**新增 @service 的那一批
  要顺手重跑 `gen:api`**，否则前端类型看不到新面，手写的 client 与真合同悄悄分叉。
  ⑥ **写规格要照 §7.3 的规范形状抄，不许凭手感（本轮 ⑦ 门禁量出来的）**：T9/T10 的三份新规格
  （`adbCase.spec.mjs`/`mixedScene.spec.mjs`/`sceneCanvas.spec.mjs`）把步骤参数写成行顶层
  `{id, type, addr}`，而 §7.3/`commands.CFG_SCHEMA` 要的是 `{id, type, device, config:{addr}}`——
  后端 `missing_config: connect 缺少必填参数 addr` 当场 422，7 条 e2e 连带变红。同一个坑的第二处是
  `palette.spec.mjs` 用 `click()` 选中「设备」导航项**之后**再按 Enter：click 当场导航、浮层卸载，
  Enter 落在已经不存在的输入框上（120s 超时）——键盘通路要用 `hover()`（只挪高亮、焦点留在输入框）
  才真的被测到。两处都是**规格错**而不是产品错，所以修的是规格：把参数收进 `config`、把 click 换 hover，
  断言一条没放松。教训：**「写而未跑」的规格等于没有**——标了「未跑」就要在同批次内至少跑一次门禁，
  否则它只是在给下一轮攒红。

## 待业主裁决（1D 新增；先按假设实现，全部显式可回退）

- **D12 · 录屏是不是一期。** §6.4:315 把「支持整案录屏(起止命令包裹)」列在一期条目里（无 [三期] 标记），§7.3 有 start/stop 两步，`run_artifact.kind` 有 VIDEO；但 §13:1597 的 1D 行只写「截图制品」。**假设：做**（成对步骤包裹，成本≈两个 shell 步骤+一次 pull），业主裁「不做」就删两个 step type，一步可回退。
- **D13 · 哪些步型走 u2。** §6.4:314 只点名 `click_by_text/click_by_xpath/assert_text`；`assert_element/assert_toast/extract_ui_text` 同样需要控件树，字面却落进「其余走 adb shell」。**假设：凡需控件树者走 u2（含 dump 降级）**，纯坐标/输入类走 `adb shell input`。
- **D14 · `connect_type=USB` 的写入口。** 枚举预留 + 「UI 不露出」+ D2「USB 不作产品承诺」，三句没说 API 收不收。**假设：显式 422 拒绝**（不静默改写成 WIFI——静默改值是 §13 纪律 1 的镜像违例）。
- **D15 · 心跳间隔**：§6.4「每 15s」是死的，§11.4.x 系统参数页又有「ADB心跳间隔[15]s」。**假设：系统参数默认 15s**，参数页本身（管理诊断页）不属 1D；beat 任务读参数，无参数行用默认。
- **D16 · 设备锁的 TTL/泄漏**（§8.7 只给了 SETNX→执行→释放）：worker 被 kill 时锁归谁。**假设见 R139**（TTL + 续期 + token 释放 + 管理位强制释放，`adb:device:update` 即钥匙——§10.1 唯一字面例子就是它；§11.5.5「admin 强制释放」与角色树「管理(连接/释放)」在此口径下是同一权限位）。
- **D17 · 排队「预计 3m」**（§11.5 卡片 mock）无估算公式出处。**假设：只显示真实位次**，估算不做——编一个数字就是假数据。
- **D18 · 「异常」红态**：§11.5.5 提了红，§11.4.14 mock 的过滤器只有 全部/空闲/占用/离线。**假设：按 mock 做三态**，红不造。
- **D19 · `device_status` agent 卡**：§9.7/卡片协议预留、无批次归属。**假设：不做**，协议 kind 不预先注册空实现。
- **D20 · 混合场景 DoD 的边界**：§13:1601 的一期 DoD 含「定时→通知」，但那两个属 1E:1598。**假设：1D 末验收 = 混合场景执行 → 报告**（与 §13:1597「1D 末达成混合场景端到端 DoD」原文一致），1E 再接上定时/通知才算闭合。
- **D21 · `assert_toast` 的实现路线**（前置取证 ⑪ 实测：u2 3.7.1 的 toast RPC 已被移除，`-32601`；控件树轮询抓 Toast 节点在本机两次现场都**没抓到**，路未证实）。**假设：按「超时窗口内轮询控件树找 Toast 节点，抓不到=断言失败并如实写 `toast capture unverified on this platform`」实现**——绝不按 u2 toast API 实现（界面能配、执行恒假 = §13 纪律 1 的假功能形状）；假设备 fixture 注入 Toast 节点把解析逻辑测透，真机行为留业主设备验证。业主裁「一期不做」则 step type 保留、执行核返回带原因的 `error`（不是 skip 装绿）。

- **（待编号 · T11 收尾时新量到的开放项）** **步骤级 `device` 语义到哪一层为止**。本轮把「画布节点的 `device_policy`/`device_serial` 真接进执行」（R145 ④）之后，还剩一层没定：用例内每条步骤自己的 `device` 字段仍是一律响亮拒绝（`debug_services.py:19-22` + `_resolve_parts` 的 problem，理由写得很实——执行核一次 `run_adb` 只吃一个 serial，u2 会话与录屏配对都是单设备状态，换机要把用例切段执行，那是独立批次的形状）。**现在的口径是「一条案一台机；画布节点覆盖用例默认机」**，业主若要的是「同案跨机」，那是新一批的活（切段 + 各段独立锁 + 制品归属重排），不要在本批偷偷扩。
  **本条不占 D 号**：D22–D30 是 1E 的、D31–D36 是 1F 的（两份计划各自「号段公告」自陈），1D 尾插新号必然撞；请业主/下一批起号时顺手给它一个。

---

## 任务（checkbox = 状态；每任务尾部 = 门禁与自证）

### T0 · D10 队列按 `TP_ENV` 分开（台账明写「放在 1D 开头」） ✅
- [x] `orchestration.py` / `debug_services.py` 投递处带 `-Q tp.{env}`；`worker.py` 启动按 `TP_ENV` 绑队列；`.env.example`、手册 §4.2b 同步。
- [x] 测试：e2e/golden 投的 task name+queue 断言；常驻 dev worker 抢不到测试任务的形状钉住（R118 根治）。
      **落地证据（commit 2849b1e）**：`Settings.task_queue = "tp." + env`（config 一条纯函数，投递现算/消费烘焙，
      注释写明两种故意不对称）；两条真投递路（scenario enqueue + ui_case run）都显式 `queue=`；worker
      `task_default_queue` 锁接；verify_worker 每次独占 `tp.verify{ts}` lane；pytest=`tp.test`、e2e=`tp.e2e`、
      演示=`tp.dev`。`tests/test_queue_split.py` 五条四层（纯函数推导+单射 / worker 烘焙 / 两条投递 spy /
      memory 传输复现「tp.test 的消息 tp.dev 领不到」）。52 条相关回归全绿，mypy 4 文件 0 错，ruff 全过。

### T1 · 依赖与假设备 fixture（CI 的地基，蓝图 §14） ✅
- [x] `requirements.txt` + `pyproject` dev：`uiautomator2>=3.0`；mypy 豁免只加 `uiautomator2.*`（附实测报错条数，同 celery 口径）。
- [x] `settings.adb_path`（空 = 找 PATH，再退 SDK 常见路径；找不到 → 设备服务返**人话错误**，不装死、不假在线）。
- [x] `backend/scripts/fake_device/`：**假 adb 可执行**（argv 协议、可控状态机：devices/connect/getprop/shell/input/pull/push/screencap(真 PNG)/screenrecord(真字节)/dump(可注入 XML)/am/monkey/pkill）+ 假 u2 注入缝。**它替的是 adb_cli/u2 包装这一层，不改任何产品分支逻辑。**
- [x] `tests/test_adb_deps.py`：依赖在场 + 钉版本口径 + adb 缺位时的诚实报错（R97 同款地基守卫，无设备也应全绿）。
      **落地证据**：`uiautomator2` 实测 3.7.1 入 venv，`>=3.0` 钉进 requirements + pyproject（惰性 import，
      同 playwright R95，契约 4 无 app.modules）；mypy 实测 1 条缺 stub 报错，豁免只加 `uiautomator2.*`
      一块（`test_mypy_exemption_scoped_to_u2` 守门）。`settings.adb_path` 显式指错 → `FileNotFoundError`
      带 `TP_ADB_PATH` 指引（响亮不静默）；留空按 PATH → SDK 候选，全无 → `None`+`ADB_INSTALL_HINT`。
      `FakeDeviceManager`：Windows 生成 `.cmd`（CreateProcess 走 cmd.exe）、POSIX 生成 shebang 可执行；
      `install_env` 只设 `FAKE_ADB_STATE`，状态文件原子写且**每次钉 file_root**（文件往返不落共享 temp）。
      fake adb 是纯 stdlib 状态机：devices/connect(getprop 回显)/getprop/shell 派发（dumpsys battery/
      uiautomator dump 可注入 XML 与 rc/screenrecord 真字节/cat/pkill/input/am/monkey/…）/push/pull
      真字节往返/screencap 走 `sys.stdout.buffer` bytes 通道（取证 ④）/connect_fail 真非 0。
      fake u2 注入缝：`connect` 看状态、`FakeSession.dump_hierarchy/screenshot/press/click/d/text.exists`
      语义与真 atx 一致，产品经薄包装换驱动。门禁：`test_adb_deps.py` 9 例 + `test_ui_deps.py` 9 例全绿、
      ruff 全过、mypy `app` 96 文件 0 错、import-linter 4 kept 0 broken。**注：pyproject 的 uiautomator2
      依赖与豁免是 T1 的 hunk；adb_test 进契约清单等 T4/T7 服务面一起落。**

### T2 · 三表 + 迁移 0020 + 模型钉 ✅
- [x] `adb_test/models.py`：`adb_device`（§4.5 字段 + last_state JSON + **owner_id+project_public 两列齐**——visibility 的静默失效坑 1C 已量过）、`adb_module`（照 ui_module 的根层重名服务层自查）、`adb_case`（module_id/name/priority/steps JSON/default_device）。
- [x] `migrations/versions/0020_adb.py`：能跑的 down（upgrade→downgrade→upgrade 实跑，三张表真去真回）。
- [x] `tests/test_ui_models.py` 链头钉 `{"0019"}` → `{"0020"}`（照 0019 先例，改期望值不改判定逻辑）+ `test_adb_models.py`。
      **落地证据**：三表字段只来自 §4.5 清单（connect_type 小写入库 "wifi"/"usb"，D14 的 USB 422 收敛到
      服务层；adb_case 无 env_id——§4.5 没列，不顺手抄 ui_case；default_device 留空=空闲即可）。
      迁移 0020 的 **upgrade→downgrade(0019)→upgrade→downgrade(base)** 在临时库实跑：三表真去真回。
      `tests/test_adb_models.py` 6 例（roundtrip / project 内同名唯一跨项目放行 / 默认值逐一点名 /
      R104 无 version 钉 / 链头唯一 0020 / information_schema 真表在），`test_ui_models.py` 链头钉改
      0020 不判定逻辑（6 例全绿）。`migrations/env.py` 补 `adb_test` 进 autogenerate 感知清单。
      门禁：模型+迁移相关 30 例全绿、ruff 过、mypy app 97 文件 0 错、import-linter 4 kept 0 broken。

### T3 · §7.3 步骤协议（纯函数孪生对）
- [x] `adb_test/commands.py`：26 个 type 全集 + 每型参数校验（表单形状见 §11.5.5「参数表单随类型切换」）+ `optional`/`pre_wait_ms`/per-step `device` 字段；保存期拒绝不可执行组合，**校验函数永不抛**。
- [x] 前端孪生 `web/src/adb/commands.ts` + 双向表驱动测试（`test_adb_commands.py` / `commands.test.ts`，同 1C 的成对表）。
      **落地证据**：参数表是**声明式** `CFG_SCHEMA`（type→{key:kind}，`!`=必填），表改一处，表单/校验/
      摘要同时跟上；孪生对的防漂锚点 = 两份测试的 SUMMARY_CASES/坏值表逐字同串 + it 名对齐 test_* 名。
      后端 25 例 / 前端 33 例全绿；变异自证两次（摘掉录屏配对检查→后端 3 红）。vitest include glob
      补 `src/adb/**`（1C 建 map 时预警的坑应验：不点名就一根不跑）。`assert_toast` 只管形状、
      执行可行性不装懂（取证 ⑪/D21）。注意：adb_test 进 import-linter 契约清单随 T4/T7 的服务面
      一起落（u2 依赖与 mypy 豁免已随 T1 的 b97ffcd 入库）；commands.py 纯 stdlib 现状不被任何
      契约约束——「4 kept」此刻对它既不算真绿也不算漏网。

### T4 · 设备服务面（§11.4.14 + D2） ✅
- [x] `device_services.py`：CRUD（**先 connect 验证再入库**：`adb connect` + `getprop` 原样回显，失败给排错提示、成功才 201）、断开/重连、测试即拍（读设备信息；**截屏缩略 = exec-out screencap bytes**）、删除前占用检测、强制释放（R139/D16）。
      （占用检测落成两半、「强制释放」端点随 T5 的锁一起接：见落地证据第 ③ 条。）
- [x] 权限面：`adb:device:read/create/update/delete`（读类全 `:read` 结尾，READONLY glob 的坑）；工具面全标注；connect/update = write、delete = destructive。
- [x] `module_services.py`：第四棵模块树（照抄 R99 三件：BFS 后代/环检查/根层重名自查；purge 的 detached_* 回执键进 `shared/moduleTree.ts` + 测试条款，**别让用户看到 0**）。
      （**原文「进 shared/moduleTree.ts + 测试条款」，落码改**：本批先落「后端出真数字 + 后端测试条款」，前端加宽裁定随 T9 复用组件时做——`module_services.py` 模块 docstring 与 purge docstring 双处点名，见落地证据第 ④ 条。）
- [x] 心跳任务：`adb.heartbeat`（celery task）+ beat_schedule 默认 15s（D15）；last_state 写 机型/系统/电量/在线；**无 adb 二进制/无设备 = 静默跳过本轮 + 一次性 warning 日志**（CI 形状，不炸）。
      **落地证据（commit c1aeafe；占用读数/强制释放两枚钩子随 T5 的 1b2f233 接上）**：
      ① **先 connect 验证再入库**：`_connect_verify`（`device_services.py:69-87`）= `adb_executable()` 缺位
      也 422 响亮（带安装指引，绝不装死/不假在线）+ `adb connect` 失败把 stderr/stdout **原样回显**再拼排错
      提示（§4.5 原话兑现）；成功才 201 且 `last_state` 落首帧——帧形状 `_state_frame`（机型/系统/电量/在线+
      时间戳）由心跳 import 复用，**建连首帧与心跳帧一字同形**。`test_create_connect_fail_is_loud_422` 另钉
      失败后零脏行。D14 的 USB 写入口显式 422（静默改写成 wifi 是纪律 1 镜像违例）；改 serial 拒 PATCH
      （`device_services.py:214-217` 422「重验」）——连不上的对象不该静默入库。
      ② **测试即拍**：`/test` 是 POST 但权限 `adb:device:read`（READONLY glob 是 `*:read`，`iam/roles.py:12`——
      读类动作不挂 `:read` 后缀就是这个 glob 的坑），截图走 `adb_cli.py:112-114` 的 `exec-out screencap`
      **bytes 通道**（取证 ④），`\x89PNG` 魔数校验过了才 base64（`test_test_connection_returns_screenshot`
      解回字节再钉一次 PNG 头）。重连 = `adb disconnect` 后重验并刷新首帧。
      ③ **删除前占用检测/强制释放**：落码分两半——delete 是软删放行，**purge 拦 `adb_case.default_device`
      引用**（409 `in_use`，勾选 detach 才放行且清空引用，`device_services.py:339-346` +
      `test_purge_requires_detach_for_referencing_case`）；设备锁的占用读数 `/occupation` 与强制释放
      `/force-release`（删锁+清队+审计落库+原持有者 renew/release 双 False）随 T5 的 1b2f233 接上，复用
      `adb:device:update` 钥匙（D16），未加新权限点。
      ④ **第四棵树**：R99 三件齐——`_descendants` 一次查全量+内存 BFS 防 N+1（`module_services.py:52-65`）、
      成环/自挂 400（`_ensure_parent_ok`）、根层重名服务层自查（第四次：MySQL 唯一键不判等 NULL）；purge
      资产不陪葬、回执 `detached_cases` 真数字（`test_purge_detaches_cases_with_real_count` 钉 ==1 且用例
      存活 module_id 置 None）。**前端条款如实记**：`shared/moduleTree.ts` 本批未动（`purgeDetachedClauses`
      对 `detached_cases` 仍说「UI 用例」，R122 形状），ADB 前端页 T9 才存在、此刻无用户可见路径，加宽连同
      测试条款挂在 T9 复用组件时点名（`module_services.py:8-10` 与 purge docstring 两处留了警告）——「别让
      用户看到裸 0」以「后端永远出真数字 + 前端点名加宽」兑现，不是已进组件。
      ⑤ **心跳**：`@celery_app.task(name="adb.heartbeat")`（`worker.py:119`）+ `_beat_schedule()` 默认
      15.0s（D15），队列走 `tp.{env}` 分道；缺 adb = 静默返回 0 + **一次性** warning（`heartbeat.py:55-63`，
      测跑两轮钉 `warns==1`，adb 回来后旗标复位可再提醒）；无设备只有 info 无 warning；disabled 设备不碰；
      离线帧保留末帧机型/电量、online=False（卡片墙灰态数据基础）。结构钉：worker 模块级不 import adb_test
      （任务体内 import，web 进程不加载执行模块的前提不反噬）。`adb_test` 随 c1aeafe 进 import-linter
      契约 1/3 清单（pyproject diff）——T3 尾注「4 kept 此刻对它不算真绿」就此闭合。
      **门禁数字（本次实测）**：T4 三文件 `test_adb_device` 16 + `test_adb_module` 6 + `test_adb_heartbeat` 7
      = **29 passed**；`-k adb` 全家 **112 passed, 619 deselected**；`mypy app` 105 文件 0 错；
      `ruff check .` 全过；`lint-imports` 逐字 **`Contracts: 4 kept, 0 broken.`**。前端零改动，故本轮无 pnpm 门禁。

### T5 · 设备锁 + 队列（§6.4/§8.7） ✅
- [x] `adb_test/device_lock.py`（**落码定位于 `/execution/adb_lock.py`**，同 adb_cli.py 理由：真消费者是 T6 的 adb_core，而契约 4 禁 execution import app.modules）：`SETNX` + TTL + 持有者 token 续期 + **WATCH/MULTI/EXEC token-校验释放**（R140 的 Lua 因 fakeredis 无 lupa 落码裁定为事务——events.py 已为同一理由记过账）+ 队首晋升；排队位次 = `lpos`（T5 原文 RPOS：fakeredis 2.40 无 rpos，token 在队内唯一时 lpos 与 RPOS 等价，真 Redis 两者语义一致）；强制释放 = 删锁 + 清队 + 审计（service 写入口自动落 audit_log）。
- [x] 表驱动测试：同设备串行（两个 run 抢一台，第二个位次 1→0）、跨设备并行、崩溃模拟（持锁者 TTL 到期可再抢）、强制释放后原持有者**不能**再续期；另有 WATCH 冲突两例（重复释放不双晋升 / 释放 vs 强制释放交错最终态空闲）。
      **落地证据**：`tests/test_adb_lock.py` 10 例 + `test_adb_device.py` 新增 3 例（占用读数 / 强制释放 + 审计落库 / READONLY 只见读）：SETNX 占锁、release 晋升队首、非持有者释放 noop、force_release 后原 token renew/release 双 False。EventBus 增 set_nx/expire_key/rpush/lrange/lpos/client 原语（注释写明 lpos↔RPOS 裁定）。门禁：ADB 全家 69 例全绿、mypy 4 文件 0 错、ruff 全过、import-linter 4 kept 0 broken（本次新增的 force-released 端点复用 adb:device:update，不加新权限点）。

### T6 · 执行核 `execution/adb_core.py`（本批次最硬的一块）
- [x] `adb_cli.py`：stdlib subprocess **list-form**（取证 ⑤）、bytes 透传（取证 ④）、超时（单步硬超时 + `should_cancel` 边界，形状照 ui_core 的 500ms 切片与 deadline）。
- [x] 26 步型执行：shell 类直发；控件树类经 `u2_wrap`（惰性 import）；**建连阶段决定模式**（u2 or dump 轮询，R138/取证 ③），模式进日志与 run 详情（**降级要看得见**——「慢但可用」不是「悄悄换」）；失败自动截屏（进制品，D5 同款每案配额）；录屏成对包裹（取证 ⑥ 的 SIGINT finalize）；push/pull 走制品目录 + `assert_file`（存在/内容包含）。
- [x] 契约 4 保住：零 `app.modules.*`；测试全挂假设备 fixture（T1），断言形状 `{id,type,status(pass|fail|error|skip|cancelled),message,elapsed_ms,assertions[],detail{}}` 与 ui_core 同构（R102 报告归位依赖它）。
      **落地证据**：`execution/adb_core.py`（`run_adb` + `AdbRunResult.mode`）+ `execution/adb_u2.py`（薄包装，`import uiautomator2` 只在函数体内，R95 同款）+ `adb_cli.py` 补 `adb_install`/`adb_shell_spawn`（录屏起点必须 DEVNULL 管道，否则没人读的管道把录屏自己堵死）。
      三块各自的钉：`tests/test_adb_core.py` **29 例全绿**（假设备，零真机）。
      ① **模式**：`test_connect_phase_picks_dump_mode` / `_u2_mode` 钉「建连一次定终身」，降级 `error is None` 而可见性走 `result.mode`；execution 包**一处 logger 都没有**（ui_core/api_core 同样没有），所以「进日志与 run 详情」的落点是 T7 的 `_execute_adb_run`（包外），代码里已就地留了这条注释与责任归属。
      ② **26 型全实现**：`test_every_step_type_is_executed_not_staged` 按 `commands.STEP_TYPES` 全集驱动一遍**绿案**（参数表与 STEP_TYPES 双向核集合相等），断言零「未知步骤类型」+ 制品出现 SCREENSHOT/VIDEO/LOG 三种 + save_var 有真值。
      ③ **两模式同判定**：控件树语义只在 `_Tree`（XML）上实现一次，u2 与 dump 只差「怎么取树」；`test_click_by_text_same_verdict_in_both_modes` 钉两模式 message 逐字同形 + u2 落点真是 bounds 中心（540,1080）。
      ④ **fail⟹assertions 不变量**（从 DebugPanel 的渲染约束推出，ui_core 为同一坑写过注释）：只有判定类能发 fail，操作类没做完一律 error；主循环末尾还有一道「fail 却无断言行 → 降级 error 并写明「执行核缺陷」」的兜底。shell 非 0 / 装不上 / 点不着 / 推不上 全是 error 且 `assertions == []`。
      ⑤ **四条纪律线各自变异证伪**（做 mutants → 看红，再还原）：swipe 分支改「未实现」→ 全类型例红；给 adb_core 加一行 `from app.modules.adb_test...` → 契约 4 扫描例红（正则 `app\.modules\.(?!execution)`，execution 包内互引按 artifacts.py 先例放行）；install 只认 rc 不认 `Success` → install 例红（为此给假 adb 加了 `install_no_success` 状态键：rc=0 且无成功标志）；screenshot 截不到却说「已截图」→ 新增的配额耗尽例红（并钉 `save_var` 不许塞指不到东西的序号）。
      ⑥ **跨案不串宿主机临时文件**（评审自查发现、当场修 + 加钉 + 变异证伪）：录屏 mp4 与 `file_pull` 的临时落点原先只按步骤 id 命名（`tp_record_r1.mp4`），两条用例都叫 `r1` 是常态——同一 worker 上并行跑两台设备就会**把别人的录屏当本案制品**挂上报告页。改成每案一个 `uuid4` 短标；`test_two_runs_same_step_ids_do_not_share_host_temp` 用 `asyncio.gather` 真并行跑两条同形状用例，钉临时路径互不相同 + 字节互不污染（把 run_tag 换成常量后该例转红，证其可红）。
      **门禁数字（本次实测）**：ADB 全家 **108 passed**（test_adb_core 29 + deps/device/heartbeat/lock/models/module/commands）、`mypy app` 105 文件 0 错、`ruff check .` 全过、`lint-imports` **4 kept 0 broken**。
      **共享 fixture 改动（T1 归并行 session）**：`scripts/fake_device/fake_adb.py` 加顶层 `install`（认 -r、包字节落 `file_root/data/app/`、打 `Success`）+ 两个状态键 `install_fail` / `install_no_success`；`git diff` 实测**零删除行**（纯增量、既有分支未动），挂在 fixture 上的三家测试（deps/device/heartbeat）全绿。
      **通报状态（如实）**：写这条时并行 session **不在可达列表**（`ListAgents` 只有另一个项目的会话），所以「已通报」没做到——先落在提交里，下一轮搭档会话上线时补通报。该文件自 `b97ffcd` 起就是已提交且无改动的状态（不是对方的 in-flight 文件），故按「增量 + 全绿 + 留痕」处理，不等人工放行。

### T7 · 用例服务 + 调试端点 + worker 任务 ✅
- [x] `case_services.py`（CRUD/回收站/引用检测复用 `scenario_case_refs`）+ `debug_services.py`（同步调试 + enqueue，**共用 `_execute_adb_run` 的一份执行体**——R102 同源）+ worker `@celery_app.task(name="adb_case.run")`。
- [x] `SUBJECT_TYPE_PATTERN` += `adb_case`；runVocab 孪生 + 对齐测试（R112 词表）。
      **落地证据**：`case_services.py`（325 行，8 个 service：list/get/create/update/delete/restore/purge/references
      —— purge 与内部批量 refs `tool=False`，delete 是 destructive）+ `debug_services.py`（740 行：
      `adb_case_resolve` 内部件 + `adb_case_debug` 同步调试 + `adb_case_run` enqueue + `amain_adb_run`/
      `_execute_adb_run`）+ worker `adb_case.run`（`worker.py:119`，任务体内 import adb_test，模块级不碰——
      worker 结构钉不反噬）。设备锁的 `dequeue` 随本轮补进 `execution/adb_lock.py`：`acquire` 抢不到即入队是
      默认承诺，而调试档不许排队，抢占竞态输了要能干净退出，否则没人认领的 token 会在 release 时被晋升成
      持有者、白占设备到 TTL 到期。
      ① **R102 同源钉成测试**（这条是 T7 的全部命题，此前一字未测）：
      `test_debug_and_worker_share_one_execution_body` 拿同一用例分别走 debug 与 `amain_adb_run`，逐键比
      status / 每步判定 / R108 断言行 / case 汇总行 detail（mode + 设备）/ summary_graph 节点 config / run_end
      （只剥 `elapsed_ms`）——变异自证：让 debug 路少写断言行 → **只有这一条红**，说明钉的分辨率正好。
      ② **设备是执行槽位**（§6.4/§8.7）：`test_debug_specified_device_occupied_422_never_queues` 钉调试档被占
      当场 422 `device_occupied` 且队列长度仍为 0（人在等一句答复，排队等于把人挂住还说不清在等什么）；
      `test_device_lock_held_for_run_lifetime` 钉持有者 token 真形 `run:<rid>:` 且跑完释放；background 档
      FIFO 排队 + `device_queued` 位次由 `test_adb_debug.py::test_manual_run_waits_for_device_then_finishes` 钉。
      取消与 deadline 各一条（`test_cancel_at_step_boundary` / `test_deadline_fires_at_step_boundary`），
      入队后资产腐坏（用例被回收/设备被删）→ **error run 而非静默空跑**（`test_asset_rot_after_enqueue_becomes_error_run`）。
      ③ **resolve 的响亮拒绝**：per-step `device` 非 `auto` → `executable=False` + 点名步骤 id（执行核一次
      `run_adb` 只吃一个 serial：u2 会话模式与录屏配对都是单设备状态，逐步骤换设备要把用例切段——
      独立批次的形状；界面能配而执行悄悄忽略 = §13 纪律 1 的假功能）。
      ④ **R112 词表的真代价（计划没写、实测撞出来的两处陈旧钉）**：`adb_case` 进 `SUBJECT_TYPE_PATTERN`
      之前，`tests/test_run_record_v2.py` 与 `web/e2e/runs.spec.mjs` **拿 `adb_case` 当「词表外的非法示例」**
      钉 422——插槽期那是对的（worker 写不出这行），T7 之后它成了合法值，两条钉同时到期变红
      （e2e 那条是本次全量跑红的，不是预判）。翻钉改成真·词表外值（`db_case` / `bogus_type`）继续钉
      「闭集不收野值」，并各补一条正向：`subject_type=adb_case` 必须 200 放行——不收就是
      「ADB 运行出现在列表里却筛不出来」。这条教训与 R112 同源：**插槽被写进断言的否定面时，
      翻开它的那一批必须同时翻掉两处**。
      **门禁数字（本次实测）**：ADB 全家 **137 passed / 622 deselected**（test_adb_run 11 + test_adb_debug 6 +
      test_adb_case 7 + core/deps/device/heartbeat/lock/models/module/commands）；`mypy app` **107 文件 0 错**；
      `ruff check app tests migrations scripts` **All checks passed**；`lint-imports` 逐字 **`Contracts: 4 kept, 0 broken.`**；
      全量 pytest 与全量 e2e 的数字记在 T11/README 收尾条（本轮同树实跑，见那条）。
      **未测的（不装绿）**：真 Redis 的 WATCH 争用下队首晋升（T5 用 fakeredis 钉，同一限制在那条已记）；
      真 worker 进程（`--pool=solo` 跨进程的租约持有者格式）——钉的是 celery 任务体桥接的那个协程
      `amain_adb_run`，也就是共用的那份执行体本身；「真起一个 worker 领 adb_case.run」由
      `scripts/verify_worker.py` 的形态覆盖到 scenario 那条路，adb 这条的进程级验证留给演示手册。

### T8 · 引擎 `h_adb_case` + 七处翻开（R111 的 adb 轮） ✅
- [x] `graph.py BLOCKED_1B` 摘、`handlers.py PENDING_KINDS` 摘 + `HANDLERS["adb_case"]`（h_ui_case 的形状：ref/actor/resolve 三段防御 + 状态折叠 + 制品 blob 免存详情）+ 两处 docstring 同批改（别留旧叙事）。
      **落地证据**：两张表清空为 `{}` 但机制留着（`kind_not_available`/PENDING 闸原样），测试用
      monkeypatch 塞假条目把机制钉活（`test_scenario_graph.py`、`test_engine_handlers.py` 的
      「假 entry 仍 error」）；`test_scenario_run_adb.py` 8 例真挂假 adb 全链跑，其中执行体 spy
      （带 `step_device` 形参）**恰好调一次**——R102 一份执行体由计数钉，不是由注释钉。
- [x] `web/src/scene/stepTypes.ts BLOCKED_1B` 摘、`AssetTree` 可拖、`store.ts adbCases`、`PropsPanel` 设备策略（任一空闲/指定设备 + 占用可选排队）。
      **落地证据（假旋钮补管）**：前端控件先做出来时后端只读 `ref`——R145 ④ 记的那条。补齐的一条管：
      节点 config → `adb_case_resolve`/`adb_case_engine_run` 共用 `_step_device` 归一（一把尺子）→
      `_resolve_parts` 预检与 `_execute_adb_run` 执行同一判定；残缺不静默回退。保存期孪生
      `graph._required_config` + `graphOps.requiredConfig` 各加 adb_case 分支（`graphOps.test.ts` 4 条新钉）。
- [x] 翻钉测试从「钉住被拦」改「钉住可跑」：`test_engine_handlers.py:252-261`、`test_scenario_graph.py:75-79`、`graphOps.test.ts:387-402`、`sceneCanvas.spec.mjs`。
      **落地证据**：15/15 handler 注册、`PENDING_KINDS == {}`、画布 adb 节点保存合法；`sceneCanvas.spec.mjs`
      的 adb 拖拽/连线随 ⑦ 门禁实跑（本轮 ⑦ 修复：种子步骤参数按 §7.3 收进 `config`，不是把断言改松）。
- [x] 导航诚实：`shell.tsx:66-67` / `workbench.tsx:71` 的「1D 开放」在**同一次提交**换成真路由；`nav.spec.mjs` 的失效哨兵翻转。Ctrl+K 设备/ADB 用例组（R109 四处同改）；搜索 kind 表 + 工作台计数 + seed_demo adb 例。
      **落地证据**：路由 `adb/cases`、`adb/cases/:id` 进 `app.tsx`，nav 文案与哨兵同批改；
      `search/services.py` 第 6 个 kind `adb_case`（`test_search.py` 钉）、`AssetCounts.adb_case` 计数
      （`my_recent_edits_types` 仍 `["scenario","ui_case"]` 是**钉住现状**不是漏改，测试注明）、
      `seed_demo.py` 的 `DEMO_ADB_CASE` 经真 service 落库且**故意不登记设备**（无 adb 的机器上演示不假绿）。
      顺带：`schema.d.ts` 在 HEAD 上是陈旧的 → `pnpm gen:api` 重生（R145 ⑤）。

### T9 · 前端：编辑器共用（§11.4.12 的「共用一个组件」是蓝图原话） ✅
- [x] 参数化重构：把 `ui/commands.ts` 的词表（TYPES/LABELS/BLOCKED/校验规则/参数分块/行 id 前缀）抽成 descriptor，`StepListEditor` 吃 descriptor；`ElementPicker` 分支可替换（ADB 无元素库）；**UI 用例现有 vitest+e2e 一根不许松**（uiCase.spec.mjs 全绿是重构门禁）。
      **落地证据（骨架轮）**：共用件其实是**两层**——`shared/stepList.ts`（列表 reducer：
      insert/remove/move/duplicate/update/nextId，两家的 commands.ts 委托它，签名一字不改、
      孪生表一行不动）+ `shared/StepListEditor.tsx`（列表骨架 JSX：工具条/预检与 422 展示/
      行摘要/展开参数/拖拽/行菜单，testid 原样从 uiCaseDetail 搬出）。差异全走 descriptor
      （labels/insertable/makeRow/idPrefix/cloneRow/summary/validate/renderParams）。
      ElementPicker 分支的「替换」落成 renderParams：UI 侧仍是 CommandParams，ADB 侧新写
      `adb/StepParams.tsx`——**表单不是手写 if 分支，是 CFG_SCHEMA 生成控件**（text→单行、
      shell→Monaco（蓝图原话，懒载不进主 chunk）、ms/int/coord→数字、bool→开关、enum→下拉、
      var/pkg/addr/url→带格式提示），加 per-step device/pre_wait_ms/optional（optional 对
      操作类直接 disabled 并说原因）。门禁：vitest 203/14（新增 stepList.test.ts 6 例钉内核
      本身——两家都委托它，接线错了它先红）、uiCase.spec.mjs **10/10**（重构门禁原话兑现）、
      tsc 0 错、eslint 0 err。adbCaseDetail 页与调试面板接线随 T7 端点落地（下一轮）。
- [x] `pages/adbDevices.tsx`（卡片墙：型号/系统/电量徽标/WiFi 地址/最后心跳/占用「排队#n」；添加弹窗带 [测试连接] 原样回显）、`adbCases.tsx` + `adbCaseDetail.tsx`（调试面板复用 DebugPanel/R108 断言行/截图内联 R107 三件套）。
      **落地证据**：三页齐（`adbDevices.tsx`/`adbCases.tsx`/`adbCaseDetail.tsx` + `AdbDebugPanel.tsx`/
      `StepParams.tsx`），各带 vitest（卡片墙 1 文件、用例列表 4 例、详情 7 例）；排队徽标只显
      `/occupation` 真读数 queued 且 tooltip 说清「队列里有几个人」≠「你排第几」（D17 不编 ETA）；
      [测试连接]=验证并添加（后端 422 的 adb 原话整段回显，失败零脏行由 T4 服务端钉、页面只回显）；
      调试面板三态：422 时「调试没有发起」+ 原话，绝不出半截时间线。

### T10 · e2e（挂假设备 fixture）+ 混合场景 DoD + 演示 ✅
- [x] `adbDevice.spec.mjs`（卡片墙真增删改查挂假 adb；添加设备失败回显排错提示）、`adbCase.spec.mjs`（步骤编辑器参数切换 + 调试面板）、**混合场景 e2e**：API 步骤 + sleep + if + adb_case 一景跑通 → 报告页三主体着色/截图内联（这条就是 §13:1597 的 DoD 证据）。
      **落地证据**：`adbDevice.spec.mjs` 3 例 / `adbCase.spec.mjs` 4 例 / `mixedScene.spec.mjs` 3 例。
      混合场景的两条通路是**分开的**：① 默认形状（CI 即此，零 adb 依赖）api+sleep+if 三步照常绿、
      adb 步 error 且点名「没有设备可跑 + serial」、未命中分支不落行、`artifacts==[]` 且页面上
      `report-artifact-img` 计数 0（没跑成设备就没图）；②③ opt-in 全绿通路要求显式注入
      `TP_ADB_PATH`/`FAKE_ADB_STATE`（`playwright.config.ts` 本轮把这两个变量透传进后端 webServer），
      未注入时**如实 skip 并说明原因**，不装绿。截图内联钉在真有 `run_artifact` 的两页
      （独立 adb 运行报告 + 调试面板，`naturalWidth>0` 真解码）；场景报告页渲染不出子 run 的图
      这一现状边界在规格与手册里各留一行 file:line，不靠改断言掩盖。
- [x] `README-1d-demo.md`：emulator 手持路径（AVD 起法、connect 序列）+ 「门禁不依赖 emulator」的显式声明。
      **落地证据**：`docs/superpowers/plans/README-1d-demo.md`（AVD/真机拨号 + 假 adb 注入法 +
      已知限制清单）；§5.0 与 §末两处都写明「写手册的机器无真 AVD，该节未实测」——门禁 ⑦ 的
      CI 形状不碰 emulator，靠 `backend/scripts/fake_device/` 的假 adb 可执行吃满。

### T11 · 收尾 ✅
- [x] 八道门禁全绿并把数字写进 README（含新模块进两个契约清单的逐字核对——R64 假绿坑）；`migrate_dev.py` 对齐；台账 R138+ 回填；`docs/superpowers/plans/` 与本文件冲突处回写；提交。
      **八道门禁（2026-11-16 收尾轮，全部本轮实跑，逐字数字见 README「1D 收尾轮实跑」）**：
      ① 775 passed（413.92s）② All checks passed ③ no issues in 107 source files
      ④ `Contracts: 4 kept, 0 broken.`（并逐字核到 `app.modules.adb_test` 在两枚清单里各占一行：
      `pyproject.toml:93`、`:123`——契约绿≠登记在案，R64 就是这个坑）⑤ 0 errors / 7 baseline warnings
      ⑥ vitest 243 passed / 18 files（`tsc --noEmit` 0 错）⑦ e2e 两种形状：CI 形状 79 passed / 2 skipped、
      注入假 adb 后 81 passed / 0 skipped ⑧ `0020 -> 0020 (head = 0020)` OK（开发库本就在 head）。
      **台账**：本批次 R139（T6 形状）、R140（T5 锁）、R141（D11 专项）、R145（T8 引擎 adb 同源 +
      ④设备策略真生效 + ⑤`populate_existing`/`gen:api` + ⑥规格照 §7.3）都已按落地形状回填；
      R142–R144 归 1E、R146+ 归 1F，本批未占。**冲突回写**：三份「写而未跑」的规格头注与演示手册
      §6.3/§7 的陈旧口径改成实测数字；T9/T10 的页面与 e2e 条目补落地证据；「待裁」新增一条
      步骤级 `device` 语义边界（**不占 D 号**，D22+ 已被 1E/1F 预告占用，占号必撞）。
