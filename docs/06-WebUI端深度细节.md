# 06 · Web UI 端深度细节

**核心判断（与我最初预估不同）**：Web 端最难的不是 AI 元素定位（`docs/02` §6 的阶梯已把它收敛成"一次性编译器"问题），而是**会话隔离与并发**。多 worker 共享浏览器上下文会互踩 cookie、localStorage、service worker，导致"单跑通过、并发跑挂"——这是 Web 自动化平台被放弃的头号原因，且它和 AI 毫无关系。工程量应该按 **隔离 40% / 定位与自愈 30% / 证据 20% / 其他 10%** 分配。

排在 P2（`docs/01` §7）。

---

## 1. 执行上下文与隔离（P2 的第一件事）

```
Run ──▶ Browser（或 connectOverCDP 到共享 browser 池）
          └─ BrowserContext  ← 隔离单位。cookie / localStorage /IndexedDB /
          │                     service worker / 权限 / 下载目录 / HTTP 认证
          │                     全在这里隔离。一个 run 独占一个 context
          └─ Page（可多 tab；一个 context 内多 page 共享存储 → 同 run 内多标签页可用）
```

| 要点 | 做法 | 不做的后果 |
|---|---|---|
| 隔离粒度 | **一个 run 一个 `BrowserContext`，绝不共享** | 用例 A 登录、用例 B 意外继承了 A 的会话 → 假绿；或 A 退出登录把 B 干掉 → 假红。这是最难查的一类问题，因为它是时序相关的 |
| 浏览器复用 | **共享 browser 进程 + 独立 context**（Playwright 的正确姿势，context 创建 ~50–100ms） | 每 run 起新 browser：启动 1–2s，且 20 并发时内存炸 |
| 连接模式 | 本地 `launch()`；远程 `connectOverCDP()` / Playwright Browser Service 自建池 | 每个 worker 起 chromium，worker 数一多直接 OOM |
| 并发上限对齐 | BullMQ 并发分组上限 = 浏览器实例上限 × 每实例 context 上限，**同一个配置源** | 两边各调各的 → 要么 OOM 要么退化成串行（`docs/01` §8.5） |
| 视口/DPR/locale/tz | 全部来自环境配置并**记进 run 的环境指纹** | 响应式断点相关的用例今天过明天挂，且查不出来 |
| Service Worker | 默认**每次清**（`context.addInitScript` + 清 storage）；若被测 app 强依赖 SW，则加 `warmup` 步骤显式等 SW 就绪 | 拿到旧版本缓存的页面 → 测的是上一版前端 |
| 时区/时间 | `contextOptions.timezoneId/locale`；需要"跨天/月末"场景时用 `clock` API（Playwright 已有 `page.clock`）`[未核实]` | 依赖真实日期的用例不可回放 |
| 权限 | clipboard / notifications / camera / geolocation 显式授予并记录 | 复制类用例在 CI 里必挂 |
| 下载 | `acceptDownloads: 'accept'` + 存进 run 证据目录 + 断言文件名/大小/内容 hash | 下载类场景完全没法测 |
| 弹窗（`alert/confirm/prompt`） | **注册默认 handler 并记录**，IR 里可声明期望文案 | Playwright 默认自动 dismiss → 静默改变被测行为，用例假绿 |
| 新窗口 / `target=_blank` | ✅ **`expectNewPage` 与 `wait{newPage}` 已实现**（判据在引擎、观测在 adapter：`Target.setDiscoverTargets` + `targetCreated` 且 `openerId === 本页 targetId` 且 `type === 'page'`）。**只有"有没有新开一个由本页打开的窗口"这一档**：观测口是一个**递增整数**，刻意不给 URL/列表（URL 会进 trace 与报告，而 `?token=` 查询串脱敏规则判不出来，同 §3 那一行）。**这一行的原始动机没有被解决**："点完之后步骤作用在已关闭的 page 上"要靠一个显式的 switch-target 动作，而它**不存在** —— 所以本字段只能证明"弹了"，不能接着断言新页面里有什么 | 点了"打开新窗口"之后步骤作用在已关闭的 page 上。**另外两条实测到的、会让人误判产品的方向**：① **下载不算开窗**（`<a download>` 一个 target 都不产生），所以"点导出"要断接口不断窗口；② 弹窗被拦截时确实算"没开窗"，那正是这条断言的价值，但**同页跳转**（`window.open(u,'_self')`）**不能**算，判据靠两道闸分开（写在 `session.ts`） |
| iframe | 定位阶梯要能跨 frame；ARIA 快照必须**把 frame 边界显式呈现给模型**（否则模型以为是一个平面 DOM） | 第三方登录/支付/富文本框一律定位失败 |

---

## 2. 元素定位：`docs/02` §6 阶梯的 Web 具体化

模型输入用 **ARIA 快照**（`[ref=e12]` 形式），不是 `outerHTML`：省 10–20× token，且 role/name 不受 class 名抖动影响。**一份快照同时是模型世界观、断言对象、自愈指纹**（`docs/00` §5.2）。

| `by` | 说明 | 可靠性 | 备注 |
|---|---|---|---|
| `testid` | `data-testid`（可配属性名，兼容 `data-qa`/`data-test`） | 最高 | 最便宜也最被忽视的一招：**能推动被测前端加 testid，定位成本降一个数量级** |
| `role+name` | ARIA 语义 | 高 | 首选默认。注意 accessible name 的计算顺序（`aria-labelledby` > `aria-label` > `<label for>` > `alt` > 文本）——**模型算出来的 name 和 Playwright 算出来的可能不同**，要允许 `nameMatch: exact\|contains\|regex` |
| `label` / `placeholder` / `text` | 面向用户可见文案 | 中 | **有 i18n 的项目一律失败** → 见 §5 本地化 |
| `css` / `xpath` | 手写或 AI 生成 | 中→低 | 只作为 fallback；**AI 生成的 CSS 会"当场通过然后腐烂"**，所以必须同时记录 a11y 路径 + 文本指纹 |
| `anchor` | "「合计」右边那个" | 中 | 抗 DOM 重构，重排版会失效 |
| `nth` + 容器 | 列表内定位 | 低 | **必须有唯一性校验 + 打分差值**，否则每行都 0.97 分静默选错（`docs/00` §8 定位器 flakiness） |
| SoM 视觉 | 编号框，答"点 17" | 中 | 兜底，用于 canvas/复杂 widget |
| 纯坐标 | 原始 x/y | 不可回放 | **标记 `nonReplayable`，永不进 CI** |

三个必须实现的细节：
- **可交互性检查**：`visible` 不等于 `可点`。被遮挡（`pointer-events`、遮罩层、sticky header 盖住）、`disabled`、`readonly`、被 virtual scroll 渲染但高度 0 —— 这些情况 Playwright 会重试到超时。定位器解析成功后要跑一次 `hitTarget` 校验，失败直接进自愈阶梯而不是干等 30s。
- **陈旧命中校验**（比 miss 更危险）：用前验 exists + visible + 文本/嵌入相似度；`ariaSubtreeSha` 变了立即失效缓存。否则改版后"成功"点了错的元素（`docs/00` §8）。
- **hover 才能出现的元素**（下拉菜单、tooltip）：`hover` 与被悬停元素的生命周期绑定，一旦触发 navigation 就丢失。IR 里需要 `hoverThen` 原子组合节点，否则用户会写出必然 flaky 的两步。
  - **`hoverThen` 今天未实现，而且它的 schema 表达不了本条要的语义**（本轮读代码时发现，记下来免得下一个人照着实现一遍）：
    `act` 只有**一个** `locator`，而本条的场景是「hover **A** 才出现 **B**，再点 **B**」——
    两个元素。所以 `hoverThen:'click'` 最多只能做成「对**同一个**元素 hover 完再点它自己」，
    那**恰好覆盖不了下拉菜单**（菜单不是被悬停的那个元素）。
    实现之前要先定：给 `act` 加第二个 locator（schema 改动，牵动所有端），
    还是把这一档**改名并收窄**成"同元素 hover+动作"、另外用别的形式表达跨元素那一种。
    **本轮把假绿堵住了，但功能仍未实现**（这两件事必须分开说，否则容易读成"修好了"）：
    今天 `act{action:'hover', hoverThen:'click'}` 第二件事**依然一件都不做**，
    只是不再判 pass 了 —— `lint.ts` 的 `HOVER_THEN_NOT_IMPLEMENTED`（error 级）
    加解释器里一道同名运行时拦（error + env-unavailable，判在 perform **之前**，
    所以被拦的那一步连页面都不会动）。
    语义定了之后这一格要改成真实现，登记行见 `docs/14` §5 与 `docs/08` §3。

---

## 3. 等待与稳定性

**平台内只允许一种等待**：`docs/02` §3 的 `wait{condition,timeout,poll}`。这里补 Web 侧的条件类型与被禁用的能力。

| 需要的等待 | 实现 |
|---|---|
| 元素可见/可交互 | `uiPredicate{state: visible\|attached\|enabled}` |
| 网络空闲 | ⚠ **提供但 lint 警告** —— `waitForLoadState('networkidle')` 在有轮询/长连接的页面上永远不空闲，是 flake 制造机。推荐 `document.readyState` + 特定接口完成 |
| 某个 API 完成 | ✅ **已实现**。`wait{condition: response, urlPattern, status?}` 与 `navigate`/`act` 上的 `expectResponse` 走**同一个判据**（`engine/src/responses.ts`），观测口是 `adapters.network`（Web 端由 CDP 的 `Network.responseReceived` 供）。**匹配口径 = URL 子串 + 可选状态白名单**，两点与直觉不同且都写在代码注释里：① **不是正则**（pattern 是人写在 IR 里的，`new RegExp` 等于开一个 ReDoS 入口；而 URL 是页面产出的不可信数据）；② **窗口从"上一步开始"算而不是从会话开头算**（否则第 3 步发过的接口会让第 9 步的等待立刻通过 —— 而这条等待承诺的正是"我刚做的那个动作真的触发了这个接口"）。命中项**只给条数与状态码，不给 URL**：URL 会进 trace 与报告，而 `?token=` 这种查询串**脱敏规则判不出来** |
| 动画结束 | CSS transition/animation 完成检测 + `requestAnimationFrame` 双帧稳定判定（安卓侧对应 `uiIdle`） |
| 虚拟滚动里的目标 | `scrollIntoView` + 分页扫描上限（有界，`maxScrolls`），找不到才失败 |
| SPA 路由变化 | 监听 URL 变化 + 关键容器重渲染，不用固定 sleep |

**明确不提供**：`page.waitForTimeout(ms)`（只有 lint 警告的 `sleep` 节点）、`force: true` 点击、`trial`/自动重试兜底。**理由**：这三个都是"当场通过、埋雷在后"的典型，而平台的卖点是可回放与可信证据 —— 允许 force click 就等于允许用例点穿遮罩层然后报绿。

**重试策略**：Web 步骤默认 `retry: 0`，**只在 step 级显式开启**，且重试次数记进 run（retry 是 flake 信号，`locator_stats` 要聚合它）。全局自动重试是 flaky 测试的温床。

---

## 4. 断言

| 类型 | 实现 | 备注 |
|---|---|---|
| **ARIA 快照结构断言** | `toMatchAriaSnapshot` 式（YAML 结构，可 `*` 通配） | **主推**：文本、可 diff、便宜、模型可读，且同一份产物兼任自愈指纹 |
| 文本/数量/可见性 | `getByText`/`getByRole` + count | 结构化，首选 |
| URL/标题/参数 | 直接读 | |
| 局部截图（元素级） | 存证 + 可选像素比对 | ⚠ **不做全页像素比对当断言** —— 字体渲染/动画/时间戳/广告位导致误报成灾。要做就用 **applitools/percy 式"人审基线 + 忽略区"治理流程**，那是独立产品线，明确不承诺 |
| 接口响应断言 | **只做到"那个接口回来了 + 状态码在白名单里"**（`expectResponse`）。**响应体断言没有**：`ObservedResponse` 刻意只有 `{idx,url,status}`，没有 body。理由是 body 要落证据、要过脱敏闸，而这一族数据是要进 trace 的 | ⚠ 本行原先写的是"复用 API 端 matcher（跨端复用点）"—— 那是**设计意图不是现状**，照它用例会以为能断响应字段。要断 body 就走独立的 `http` 步骤 |
| console error / 未捕获异常 | 默认收集，**可选**当断言 | 默认不开（第三方脚本的报错会淹没报告），但要在报告里可见 |
| `assertLlm` | `docs/02` §4 的降权规则 | 视觉模型倾向过度报告"存在" → 否定断言必须走结构化路径 |

---

## 5. 认证与 i18n：Web 端两个隐性大头

**登录**（P2 必须解决，否则每个场景第一步就卡住）：
- **storageState 复用**：`setup` 里跑一次登录 → `context.storageState()` 存成加密 artifact → 后续场景直接注入。Playwright 原生支持，能把登录成本从"每条用例 8 步"降到 0。⚠ 但**存储的 state 会过期**，需要有效性探测 + 自动重新登录，且 token 属于 secret 体系（不能明文落盘、不进 Agent 上下文）。
- **SSO / 验证码 / 2FA**：不提供自动绕过。三条路：① 环境提供测试专用后门（推荐，需协调被测团队）；② 人工在**实时会话**里完成一次登录，平台抓取 storageState（**这个功能价值极高** —— 用平台内置浏览器手动登录一次，之后所有场景复用，建议列 P2 必做）；③ TOTP 生成器（可配 secret，本地算）。
- **多身份切换**：storageState 按 `identity` 分份存。

**i18n / 本地化**：
- 若被测系统有多语言，**所有基于 `text`/`label`/`placeholder` 的定位器都是语言相关的**。解决：环境里固定 `locale`（记进 run 指纹）；用例里断言的文案走**项目级文案字典**（`@text.login_submit` → 按 locale 解析）—— 这样同一条用例能跑多语言，且字典缺失时报错清晰。这是中文项目里非常现实的痛点，值得早做（成本是 MySQL 一张表 + 表达式解析时一次查表）。

---

## 6. 页面画像与 Qdrant 元素索引

用途有两个，且都不参与执行关键路径（只是"一句话定位元素"的加速器）：

```
爬取（受控 crawl）: 同 origin + depth ≤ 3 + 排除模式 + 需环境授权
   每页存: ARIA 快照 + 可交互元素清单 + 每元素的 {role, name, bbox, 所在容器, 文本上下文}
   向量化: 元素的语义描述（role + accessible name + 父级文本 + URL 路径语义）
   → Qdrant payload: {project_id, page_id, url_pattern, element_hash, role, name, kind:'locator'}
```

于是 Agent 能做到：*"在订单列表页找到导出按钮并点击"* → 先向量检索（0 LLM 成本）→ 命中已有元素指纹 → 直接产出 `LocatorSpec`；检索不到才走 `observe()`。这把"一句话完成页面元素分析"的**单次调用成本降到接近零**，同时给出一份可读的元素清单供人审。

⚠ 三条边界：① 爬取会产生真实写操作风险 → **默认只 GET/只点导航类元素，`method != GET` 的元素列入黑名单**，用户显式授权后才放开；② 画像会过期 → 记 `recordedAt`，与 `ariaSubtreeSha` 一起判定失效；③ 多租户隔离靠 payload 过滤（`docs/01` §6）。

---

## 7. 证据与"会话回放"

P2 就该做到（这是 Web 端最能打动人的部分，Playwright 已经把样板摆在那）：
- **trace 优先**：单目录一 run，`trace.jsonl` 追加式事件流（带 `seq` + 单调时钟），MySQL 只存计数与哈希（`docs/01` §6 的目录布局）。
- **步骤级 before/after 快照 + 时间旅行拖条**：把"回放会话排障"变成查看器功能，而不是要求重跑（重跑正是客户凌晨 2 点做不到的事）。
- **HAR 全程录制** + 失败保留。
- **视频 + 字幕轨由 `trace.jsonl` 生成**（不要独立录字幕，否则必然错位）。
- **失败时的"当时可见性包"**：截图 + ARIA 快照 + DOM 剪枝 + console + 最后 N 个请求，一个包内齐。
- **rrweb 式行为回放**（可选）：录 DOM mutation + 用 `routeFromHAR` 回放网络 + 冻结 clock/random → 得到**不需要任何被测环境**就能重放的 DOM 会话。这个能力用于"给开发复现一个偶发问题"，价值很高但工程量不小 → **P4 再评估**，P2 先靠 ARIA diff + trace 覆盖。

---

## 8. 需要用户拍板的 Web 端细节问题

| # | 问题 | 为什么影响大 | 我的默认 |
|---|---|---|---|
| W1 | 被测前端的 **`data-testid` 能否落地**？（能否推动前端加，或有没有历史遗留属性） | 阶梯第 1 级；能落地则定位器成本与 flake 双双降一个数量级 | 按"没有"设计，`by` 属性名可配 |
| W2 | 前端技术栈：SPA 框架？有没有 **canvas/Flutter Web/富文本/大屏** 这类 a11y 树为空的东西？ | a11y 阶梯对 canvas 完全失效，需要模板匹配/视觉兜底，是独立工作量 | 假设 90% 常规 DOM |
| W3 | **并发规模**：峰值需要多少条 Web 场景同时跑？ | 决定 browser 池形态（本地 launch vs CDP 远程池 vs 独立 browser service），架构级分歧 | 按 20 并发 context 设计 |
| W4 | 登录方式清单（账密 / SSO / OAuth / 短信 / 扫码）？有无测试后门？ | 决定 §5 走哪条路；无后门且无 TOTP → 只能靠人工 storageState 抓取 | 必做"人工登录一次抓 storageState" |
| W5 | 是否**多语言/多时区**被测？ | 决定文案字典要不要提到 P2 | 若多语言 → 文案字典进 P2 |
| W6 | 是否需要**视觉回归**（像素级）？ | 这是独立产品线量级的承诺，误报治理极重；早期承诺会烧掉信任 | **明确不做**，只做人审基线的截图存档 |
| W7 | 被测站点是否需要**代理/VPN/内网 hosts/自签证书**？ | 决定浏览器启动参数与网络出口架构（worker 网络位位置） | 环境配置支持 proxy + `ignoreHTTPSErrors` |
| W8 | 有无 **iframe 内的关键流程**（第三方登录、支付、客服、富文本）？ | iframe 定位与 ARIA 快照边界处理要提前做 | P2 支持，快照显式标 frame 边界 |
| W9 | 文件上传/下载类场景多吗？ | 需要 fixture 文件池 + 下载目录治理 | P2 支持基础上传下载 |
| W10 | 是否需要在**同一浏览器里跨 tab**（比如"后台审核后前台状态变化"）？ | 跨 tab 变量与等待语义要额外设计（同 context 内多 page） | P3 |
