/**
 * 引擎可用的**通用 API 白名单**（Node 与浏览器都有的那部分）。
 *
 * 为什么不用 `@types/node`：`tsconfig.base.json` 里 `types: []` 让 node 内置类型
 * 在引擎包里不可见 —— 于是 `setTimeout`/`fs`/`crypto` 一律编译不过。
 * 这不是省事，是把「引擎无副作用」从运行期约定变成**编译期强制**：
 * 只要有人想在引擎里 `require('fs')`，IDE 与 CI 立刻报错，
 * 而不是等到浏览器端炸掉才发现（docs/01 §8.2、docs/00 §6.6）。
 *
 * 需要真 IO 的东西一律从外部注入（Clock / AdapterRegistry / saveArtifact）。
 */
export {};

declare global {
  // 计时：只能通过注入的 Clock 拿，见 adapters.ts。这里声明是为了让
  // liveClock() 这个**唯一**的适配点在类型上合法。
  function setTimeout(handler: () => void, ms?: number): unknown;

  // Web 基础库（Node 18+ 与浏览器都有）
  class URLSearchParams {
    constructor(init?: Iterable<[string, string]> | string);
    append(name: string, value: string): void;
    toString(): string;
  }
}
