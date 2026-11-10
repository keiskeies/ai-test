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
 *  - expectResponse / expectNewPage / hitTargetCheck=false
 *    （IR 有字段，本 adapter 还没读它们 —— 登记在 docs/14 §5，不是"忘了写测试"）
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

