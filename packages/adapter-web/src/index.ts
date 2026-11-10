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
 * 当前进度：**只有传输层**（cdp.ts）。UiExec 端口的实现还没写 ——
 * 之所以先交传输层，是因为它每一部分都有实测依据（起进程、端口发现、
 * flatten 会话、AX 树、事件），而 UiExec 的每个方法都还没有一条能跑的用例。
 * 先写 UiExec 会变成"照接口想象写一遍、等有了浏览器再返工"。
 */
export {
  launchBrowser, parseDevtoolsUrl, BrowserHandle, CdpConnection,
  type LaunchOptions, type CdpResponse, type CdpEvent,
} from './cdp.js';
