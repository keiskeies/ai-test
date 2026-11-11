/**
 * @atest/engine —— 场景解释器。
 *
 * 本包**禁止 import 任何 node 内置模块**（CI 由 tooling/lint-layers.mjs 强制，
 * 编译期由 src/env.d.ts 的 API 白名单强制）。所有副作用从外部注入：
 *   Clock        —— 时钟与随机数（测试要冻结，压测要预编译）
 *   AdapterRegistry —— 网络 / UI / 设备 / DB / LLM
 *
 * 于是同一份解释器代码在 CLI、CI、服务端 worker、浏览器（只读校验）四处行为必然一致。
 * 这是 Postman↔Newman、Apifox GUI↔CLI、MeterSphere UI↔CI runner 全部踩过的分叉坑的根治法。
 */
export * from './adapters.js';
export * from './jsonpath.js';
export * from './expr.js';
export * from './vars.js';
// 归因判据。导出的理由与 redact.ts 同一条：**判据只许有一份**。
// 少了这行，调用方（CLI 的 triage 面板、store 的看板）就会自己写一份
// `instanceof` 链，于是"这一步为什么失败"在报告和看板里能有两种答案。
export * from './errors.js';
export * from './wait.js';
export * from './assertions.js';
export * from './interpreter.js';
export * from './lint.js';
export * from './dryrun.js';
export * from './resolve.js';
export * from './executor.js';
export * from './report.js';
export * from './html.js';
// 运行期提醒（lint.reported 事件）的人读出口。导出的理由与 redact.ts 同一条：
// **同一件事的出口只许有一份**。三个消费者（HTML 提示带、JUnit property、summary.txt）
// 各写一遍筛选逻辑，迟早只改一处 —— 而漏掉的那一处表现为"这份产物压根不提"。
export * from './advisories.js';
// 脱敏策略。导出给存储层用：证据写盘前要走**同一份**规则，
// 在 store 里再写一份就是"某处加了关键词、另两处照旧明文"的分叉源头。
export * from './redact.js';
