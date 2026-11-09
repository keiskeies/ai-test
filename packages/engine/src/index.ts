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
export * from './wait.js';
export * from './assertions.js';
export * from './interpreter.js';
export * from './lint.js';
export * from './dryrun.js';
export * from './resolve.js';
export * from './executor.js';
