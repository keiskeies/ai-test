/**
 * @atest/adapter-web —— Web 端的执行侧（docs/04 M3、docs/06）。
 *
 * 分包边界的硬约束（由 tooling/lint-layers.mjs 强制）：
 *  - 与 adapter-http 同层：**只有这一层**允许碰 node 内置模块与浏览器进程。
 *  - **不得依赖 adapter-http**：跨 adapter 共用 HTTP 客户端会让 Web 端的请求
 *    绕过引擎侧那套 SSRF / 密钥纪律（docs/05 §4）。要发请求就走引擎的 http 步骤。
 *
 * 零第三方依赖是有意的：npm registry 在本机不可达，而 CDP 用 Node 22 自带的
 * WebSocket + fetch 就够了（这条推翻了"装不上 driver 所以 Web 端做不了"，
 * 证据与那次误诊断都记在 docs/14 §4.11）。加依赖之前先确认它装得上。
 *
 * 当前进度：传输层（cdp.ts）+ 会话机制（session.ts）+ 定位翻译（locator.ts）
 * + UiExec 端口（ui.ts）。**能跑通"导航 → 定位 → 点击/输入 → 断言/截图"这条主链**，
 * 但下面这些**没有**，别当成已经存在：
 *  - iframe / shadow 作用域（定位器 scope 非 page 时明确报错，不在 page 里瞎查）
 *  - nth / anchor / 模板匹配 / 视觉定位（locator.ts 里逐个点名拒实现）
 *  - ariaYaml、attribute 两档断言（前者缺 YAML 解析，后者缺 IR 侧收 LocatorSpec）
 *  - **expectResponse 已经能用**（本 adapter 供响应流，判据在引擎）：
 *    观测口是 `Session.responsesSince` -> `WebAdapter.responsesSince` -> `adapters.network`，
 *    `network.test.ts` 在真 Chrome 上确认过**真的有条目进流**（这条不是可选的：
 *    引擎侧那 19 条全用假流，假流证明不了"有人供数"，见那份文件的头注释）。
 *  - **expectNewPage / wait{newPage} 已经能用**（同样是"观测在 adapter、判据在引擎"）：
 *    `Session.newPageCount` -> `WebAdapter.newPage` -> `adapters.newPage`，
 *    一个**只增整数**，刻意不给新页面的 URL（它会进 trace 与报告，
 *    而 `?token=` 查询串脱敏规则判不出来）。真 Chrome 上有 8 条测试，
 *    其中"别的浏览器上下文开的窗口不算在本页头上"那条的**噪声来自 Chrome 而不是夹具**。
 *    仍然**没有**的是 hitTargetCheck=false（IR 有字段、没人读；Web 端恒做命中测试，
 *    所以在这里"关掉它"无效但不危险 —— 危险的是别的端，登记在 docs/14 §5）。
 *  - **hoverThen 也不在本包，而且本包也不该读它**：拦它的位置在引擎
 *    （`lint.ts` 的 HOVER_THEN_NOT_IMPLEMENTED + interpreter 里 perform **之前**的运行时拦），
 *    不是在 adapter —— 因为"能不能原子做完两件事"是**场景语义**问题（IR 的 act
 *    只有一个 locator，装不下"hover A 才出现 B、再点 B"那两个元素），
 *    在 adapter 里补一个 hover+click 反而会把语义不符的实现坐实（见 docs/06 §2）。
 *    本轮只堵住了"hover 完就停、步骤 pass"这条假绿；**功能本身仍未实现**。
 *  - storageState 复用与登录态（docs/06 §5，P2 的硬骨头）
 */
export {
  launchBrowser, parseDevtoolsUrl, BrowserHandle, CdpConnection,
  type LaunchOptions, type CdpResponse, type CdpEvent,
} from './cdp.js';
export { createSession, FN, KEY_MAP, type Session, type SessionOptions, type AxNode } from './session.js';
export {
  translate, ladder, rungOf, confidenceOf, xpathStr, cssAttrValue,
  UnsupportedLocator, BadLocator, WEB_LOCATOR_BY, LADDER_GRADUATABLE, type Located,
} from './locator.js';
export { createWebAdapter, type WebAdapter, type WebAdapterOptions } from './ui.js';

