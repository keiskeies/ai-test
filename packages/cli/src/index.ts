/**
 * `@atest/cli` —— `atest` 命令行的实现。
 *
 * 为什么整个包是导出的（而不是一个只有 bin 的脚本）：
 * 测试要**直接调用** main() 与 gate()/gen 这些纯函数。走"起子进程跑 atest"
 * 测到的是 spawn 与 argv 拼接，而不是判定逻辑；而退出码这件事
 * 恰恰是 CLI 对 CI 的契约，必须被测。
 *
 * 分层位置（tooling/lint-layers.mjs 里有条目）：
 * 这是唯一被允许同时认识 engine / adapter-http / store 的层。
 * 装配一次运行必须与 run 命令在同一处，否则服务端/CI/GUI 各装一套适配器，
 * "本地绿 CI 红"就有了藏身处（docs/00 §6.6 那一串工具的通病）。
 */
export * from './args.js';
export * from './commands.js';
export * from './exit.js';
export * from './gate.js';
export * from './gen.js';
export * from './main.js';
export * from './paths.js';
export * from './wiring.js';
