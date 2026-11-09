# 07 · ADB / 安卓端深度细节

**核心判断（与我最初预估不同）**：ADB 端最难的**不是自动化技术，而是设备运维**。真机跑一晚上之后你会发现 90% 的红灯来自设备与 ROM，而不是被测 app：设备掉线、adb server 僵死、MIUI 弹"是否允许 USB 安装"、OEM 后台杀 uiautomator、磁盘满、电量过低降频、屏幕锁定、系统更新后行为变化。**没有设备健康治理的平台，会在第一周内被红灯淹没**。所以这份文档把 §1（运维）放在最前，且我认为它必须是 P4 的第一里程碑，而不是"以后再说"。

排在 P4，但**架构前置约束在 P0 就生效**（执行器可独立进程 + 无状态依赖注入，`docs/01` §5）。

---

## 1. 设备运维治理（P4 第一里程碑）

### 1.1 设备代理的自恢复

```
device-agent（贴着手机的 Node 进程，systemd/launchd 守护）
  ├─ supervisor：adb server 独立子进程，探活失败 → 重启 adb server（会瞬断所有设备，所以要有退避与重连）
  ├─ 每设备 worker：uiautomator2 session / scrcpy session / logcat ring buffer
  └─ 健康探针（每 30s）：adb state / 电量 / 存储 / 屏幕状态 / 是否 rooted /
                          dumpHierarchy 延迟 / scrcpy 能否启动
```

| 故障 | 症状 | 自动处置 |
|---|---|---|
| `adb device offline` / `unauthorized` | 任务全挂 | `adb kill-server` + `start-server`（**注意这会影响该机所有设备**，需要全局锁 + 退避）；`unauthorized` 只能人工点弹窗 → 标 `needs_human` |
| uiautomator session 僵死 | `dumpHierarchy` 超时 | 重启 instrumentation（`uiautomator dump` 反复失败是常态）；session 级重建 |
| 屏幕锁定 / 息屏 | 所有 UI 步骤失败 | `adb shell input keyevent KEYCODE_WAKEUP` + `wm dismiss-keyguard`；并在场景 `setup` 里显式声明 `unlock` 步骤（**显式优于隐式**） |
| 磁盘写满 | 安装失败、录屏失败、logcat 爆 | 探针阈值告警 + 自动清 `/data/local/tmp` 与缓存 |
| 电量 < 20% 降频/自动关机 | 慢、掉线 | 租约调度里排除低电设备（这是"充电架运维"的软件侧兜底） |
| **弹"是否允许 USB 调试"** | 插上线就卡住 | 只能靠**预置设备**：`adb shell settings put global development_settings_enabled 1` + `adb_enabled 1`（部分 ROM 禁止远程开），MIUI 需小米账号 + 模拟点击。要承认这条路走不通并写进文档 |
| OEM 后台杀进程 / 省电策略杀 app | app 被杀、崩溃率异常 | 白名单化：`dumpsys deviceidle whitelist +<pkg>`、关闭电池优化 intent、锁后台。**这必须是 device profile 的标配动作** |
| atx-agent / iproxy 类端口转发丢失 | 连不上 | `adb forward` 幂等重建 |
| 设备被他人占用（手动调试） | 行为诡异 | **文件锁 + 租约表 + 设备屏幕显示当前占用者**（web 端投屏页水印；物理设备上用 `adb shell settings put system` 或装一个小 overlay app 显示"此设备由平台占用中"）——**没有这个，共享设备必然被互相抢**，运维类投诉第一位 |

### 1.2 Device Profile（每 ROM 一份 YAML）

这是消掉 OEM 类 flake 的唯一可持续手段，也是**平台的知识资产**（竞品没有）：

```yaml
# profiles/MIUI14-redmi.yml
oem: Xiaomi
android: 13
quirks:
  install:
    requires_manual_confirm: true         # "允许安装"弹窗
    workaround: adb_install_plus_adbkit   # 或需开启"USB 安装"开关
  permissions:
    battery_optimization_intent: "com.android.settings/.SubSettings"
    autostart_settings: "com.miui.securitycenter/..."
  dialogs:                                # 喂给 watcher 节点（docs/02 §2）
    - {text: "允许", action: click}
    - {textContains: "以后再说", action: click}
    - {text: "取消", matches: "不同意|取消"}
  uiautomator:
    dump_hierarchy_timeout_ms: 12000      # MIUI 上默认值经常不够
```
平台随版本内置一批 profile + 允许客户自定义覆盖。**新机型接入流程 = 跑一次 profile 探测向导，自动生成草案**。

### 1.3 设备分配与租约

- 租约 = Redis 锁 + MySQL 租约表（`device_id, run_id, agent_id, acquired_at, expires_at, holder`）。
- **租约要能续期**（长任务）+ **超时强制回收**（worker 崩了不能永久占着设备，这是设备池最常见的死锁）。
- 调度匹配：`require{udid|model|androidVersion|oem}` → 候选集排序（优先"上次跑这个场景成功的同型号"，同型号历史通过率是可学习信号）。
- **无设备可用时的语义**：`skipped`（环境问题）而不是 `failed`（功能问题）。这条和 `docs/05` §5 的 precondition 原则一致。

---

## 2. 元素定位与层级抓取

安卓侧的 a11y 树类比物是 **uiautomator hierarchy**：`resource-id` + `content-desc` + `text` + `class` + `bounds` + 父子链。指纹用**子树 sha**（`docs/02` §6 的 `ariaSubtreeSha` 在安卓的对应物）。

| 抓取方式 | 延迟 | 说明 |
|---|---|---|
| Appium `GET /window/tree` / `mobile: getPageSource` | 数百 ms～数 s | 首选（结构化、可控）。**大页面（长列表）会到秒级** → 必须支持**区域抓取**（给定锚点只取子树），否则一次快照就吃掉整个步骤的时间预算 |
| `adb exec-out uiautomator dump /dev/tty` | 1～3 s | 无 Appium 时的兜底；**不支持并发**、会阻塞 UI 线程、有已知失败模式 |
| `adb shell content` / atx-agent | 快 | openatx 路线的优化点，值得参考 |
| 截图 | 100～400 ms | `exec-out screencap -p`（原始，不经 PNG 压缩更快）；scrcpy 单帧更快 |

**定位阶梯（`by` 支持项）**：

| 优先级 | `by` | 说明 |
|---|---|---|
| 1 | `id`（`resource-id`） | **前提是 app 可改**（见 Q-A1）。第三方/线上包拿不到有意义的 id |
| 2 | `content-desc` | 无障碍描述，通常稳定但经常被省略 |
| 3 | `text` + `textContains` + `instance` | 最常用也最脆：文案变、i18n、动态数字 |
| 4 | 属性指纹加权打分（class + bounds 相对位置 + 父子链 + 兄弟文本） | Testim 式，抗改版 |
| 5 | `anchor`（"「合计」右边"） | |
| 6 | 缓存的 LLM 定位（校验后用） | |
| 7 | **hierarchy + 截图融合 grounding**：给模型 hierarchy 节点清单 + 截图，**要求返回节点 id 而非像素**（Google mobile-vision / M3A 模式） | **主推的 AI 路径**：拿到节点就还能回放 |
| 8 | SoM 视觉 → 纯坐标 | 标 `nonReplayable` |

**a11y 树为空的场景**（这是安卓端特有的硬问题，Web 端少见）：Flutter（默认无 semantics）、Unity/Cocos 游戏、canvas 自绘控件、部分 RN 版本、WebView（需切 context）。对策分层：
- WebView：**Appium context 切换**（`NATIVE_APP` ↔ `WEBVIEW_xxx`）→ 切过去后复用 Web 端整套定位与证据能力（**统一引擎的第二个复用点**）。⚠ 需要 `webviewDebuggingEnabled`，release 包默认关 → 测不了，要提前和被测团队约定。
- Flutter：`appium-flutter-driver` + `ValueKey`（同样需要 app 侧配合）。
- 游戏/canvas：模板匹配（Airtest 式）+ 视觉 grounding。**明确这是另一条产品线量级的能力**，需要用户确认是否有此需求（见 Q-A3）。

**Flutter/RN/WebView 三者的存在与否，直接决定 P4 的工作量是 1 倍还是 3 倍** —— 这是安卓端最重要的未知项。

---

## 3. 交互注入与输入

| 通道 | 延迟 | 优劣 |
|---|---|---|
| Appium W3C Actions（推荐） | 中 | 跨平台、可控 pointer/序列、支持拖拽轨迹；`mobile: doubleClick`/`mobile: swipe`/`mobile: pinchClose` 等 vendor 扩展好用 |
| `adb shell input tap/swipe/text` | 30–80 ms/次 | 简单可靠但**慢、`input text` 打不出 Unicode/中文、keyevent 边缘情况缺** |
| **scrcpy `INJECT_TOUCH_EVENT`/`INJECT_TEXT`** | 低 | 人在投屏里操作的通道；`INJECT_TEXT` 能输 Unicode（**替代 ADBKeyBoard**） |
| `adb shell am instrument` / Espresso | 最低最快 | 需要 app 侧配合插桩（白盒）→ **理论最优但要求改 app**，若客户能配合，这是"编译产物该瞄准的目标" |

三条实践约束：
- **平台内只允许 Appium/scrcpy 通道**，`adb input` 只用于设备管理（唤醒、锁屏、清数据），不做 UI 操作 —— 否则中文输入和拖拽都会坏。
- **等待动画结束再断言**：`waitForAnimationToEnd` 式条件（`docs/02` §3 的 `uiIdle`）。安卓动画没结束就 dump 是 flake 主因之一。
- **软键盘会遮挡目标**：`act` 后要处理 IME 状态（收起/保持），列表底部元素被键盘盖住是高频问题；`hitTarget` 校验（同 Web 端）能直接发现。

---

## 4. 投屏（细节见 `docs/01` §5，这里补人交互语义）

`@yume-chan/scrcpy` + `scrcpy-decoder-webcodecs`，LAN ~30–120ms `[未核实]`。补充三条**执行语义**上的关键决定：

1. **"人工介入"必须是一等公民，而不是绕过平台**：自动化步骤失败 → 用户点开投屏手动接管 3 步（登录、过滑块、选地址）→ 交还自动。IR 里需要 `manualHandoff{reason, timeout, resumeOn}` 节点，**且接管的动作要能被录制进轨迹用于蒸馏成 IR**（这是 Agent 模式与人工共创的关键闭环，也是"云真机远程调试"体验的平替）。竞品（Testin/WeTest/AWS Remote Access）都有交互式远程真机，但**没有"人工介入后回归自动化并沉淀成用例"**，这是可占的位置。
2. **人在操作时必须锁自动化**（租约状态 `manual`），否则自动步骤和人手会打架 —— 这个 bug 表现是"点错地方"，非常难查。
3. **失败时的画面留证**：保留失败前 N 秒的帧环形缓冲（`docs/01` §6 的 `screen.frames/`），事后可回看崩溃瞬间。**这比截图有用得多**，实现代价是一个 30s ring buffer。

---

## 5. 安装 / app 生命周期 / 数据前置

| 事项 | 细节 |
|---|---|
| 安装 | `adb install -r -g -t`（授予全部运行时权限、允许测试包）。**大 APK（>200MB）走 `cmd package install-commit` 流式**，否则超时。闪退包要检测 `pm install` 退出码而不是只看输出文本 |
| 权限 | 运行时权限 `pm grant`（多数可预授权，前提是签名匹配）；**特殊权限**（通知、悬浮窗、精确定位、所有文件）走 watcher 点弹窗 |
| 数据前置 | `pm clear` + 预置：`adb push` 到 app 私有目录（需 debuggable 或 run-as）/ deep link 灌参 / **API 造数后用 app 验证**（`docs/02` §9，本平台终局验收）/ app 自带测试后门接口 |
| 环境切换 | 多数国内 app 有隐藏环境切换（摇一摇/长按版本号/广播/`am broadcast`）→ 需要客户告知并沉淀进 **device/app profile**，否则每个场景都要人肉切环境 |
| **账号与会话** | 安卓侧最痛：验证码/滑块/设备指纹风控。**唯一现实方案是"登录一次，持久化会话，跨 run 复用，失效才要求人工重登"**（与 Web 端 §5 的 storageState 同构，但安卓是 app 自己管会话，只能靠"不 clear data"保住）。→ **`pm clear` 与"复用登录态"互斥**：IR 里要显式区分 `app.clearData`（干净环境用例）与 `app.preserveLogin`（复用会话用例）。这条设计不做好，用户会被登录问题淹死 |
| 崩溃/ANR 捕获 | `logcat` 常驻 ring buffer + 过滤 `AndroidRuntime`/`FATAL`/`am_anr` + `dumpsys dropbox` + `bugreport`（重，失败时才拉）。**崩溃时自动落盘 logcat + 截图 + hierarchy + 投屏帧**，这是安卓端最硬的证据包 |
| 系统弹窗 | 升级提示、隐私合规弹窗（工信部要求首启同意）、厂商安全中心弹窗 → 全靠 watcher + profile |
| 时间/网络 | `adb shell date` 需要 root（多数拿不到）→ 时间相关场景只能靠被测 app 支持；弱网用 `svc wifi disable` / `tc`（需 root）/ **代理 + Charles/mitmproxy 抓 HAR**（这个可行且价值高：安卓端网络证据） |

---

## 6. 网络抓包与跨端证据

安卓端要拿到"这次点击触发了哪个接口"，只靠 UI 断言是不够的（很多 bug 是"UI 显示对但接口传错"）。方案：设备配代理 → mitmproxy 按 run 分文件 → 存 HAR → 复用 API 端 matcher 断言（第三个复用点）。⚠ HTTPS 需要装 CA，**Android 7+ 默认不信任用户 CA，需要 app 声明 `networkSecurityConfig` 或 root** —— 又是一个"要不要改被测 app"的分歧点（`docs/05` A 类问题的镜像）。

---

## 7. 需要用户拍板的 ADB 端细节问题

| # | 问题 | 为什么影响大 | 我的默认 |
|---|---|---|---|
| A-1 | **被测 app 能否配合改动**？（加 `resource-id`/`ValueKey`、开 webview debug、装测试 CA、提供环境切换与造数后门） | **这是安卓端最大的单一变量**。能配合 → 工作量约 1×；完全不能（测线上包）→ 定位只能靠 text+视觉，WebView 测不了，环境切换靠人肉，约 3× 工作量且 flake 显著更高 | 按"部分能配合"设计 |
| A-2 | 技术栈：**原生 / RN / Flutter / Unity-Cocos / 含 WebView（小程序？H5？）** | 决定 §2 的空 a11y 树问题严重度；小程序/H5 需要 context 切换与另一套定位 | 假设原生 + RN + 含 H5 |
| A-3 | 是否需要测**小游戏/canvas 类**界面？ | 是 → 模板匹配 + 视觉 grounding 独立线，另计工作量 | 不做 |
| A-4 | 设备现状：**自有手机数量、型号分布、有无 USB hub/充电架、能否固定一台机器长期插着**？ | 决定 device-agent 部署形态与是否需要 emulator（`redroid`/`cuttlefish` 可大规模并行且免运维，但**没有厂商 ROM 特性、无 GPU 编码器时 scrcpy 黑屏、部分 app 拒绝模拟器**） | 先支持自有真机 + 提示需固定主机 |
| A-5 | 是否要测**鸿蒙 / HarmonyOS NEXT**？（国内极常见） | NEXT 不用 ADB/Android 运行时，**是另一个平台的量级**（DevEco/ hdc / uitest），完全不能复用 ADB 层 | 不做，但架构上 `target` 留扩展位 |
| A-6 | 是否需要**微信小程序**（而非原生 app）测试？ | 小程序在微信内跑，登录依赖微信账号 + 扫码，风控极强；自动化难度和原生完全不同 | 待确认 |
| A-7 | **iOS 在不在范围内**？ | 若是，WDA + macOS 池 + 签名 = 再一个平台量级（`docs/01` §5 说得很清楚：iOS 是竞品的护城河也是自托管最贵的坑） | 明确不做，但 `LocatorSpec`/IR 保持平台中立（`by` 支持 iOS 的 `name`/`predicate`/`classChain`） |
| A-8 | 投屏是否需要**多人同时观看同一设备**？ | 决定扇出层（一设备一编码器 + 多 viewer）的实现优先级；不需要则可先做单 viewer 简化版 | 支持多 viewer（一次做对便宜） |
| A-9 | 设备是否可能被**人在物理层面同时操作**（共用实验室）？ | 若是 → 占用者显示（§1.1）与租约冲突提示是 P4 必做，不是可选项 | 按"共享实验室"设计，必做 |
| A-10 | 是否接受**平台在设备上装一个小 agent app**（overlay 显示占用者、辅助输入、免登）？ | 能装则 §1.1 占用显示、§3 文本输入、§5 会话保持三个问题一次性变简单；不能装则全部走旁路方案 | 默认不装 |
| A-11 | 目标机 **Android 版本下限**？ | <8 的设备 hierarchy/权限模型/scrcpy 支持都差一截；<7 基本只能模板匹配 | 假设 ≥10 |
| A-12 | 失败时是否允许**自动抓取 `bugreport`**（含敏感系统日志）？ | 证据价值高但有合规问题（客户数据/内部信息），国内甲方敏感 | 默认关，需环境级授权 |
