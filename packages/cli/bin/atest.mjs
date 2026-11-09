#!/usr/bin/env node
/**
 * `atest` 的可执行入口。
 *
 * 这一层薄到只有 import + main + exit，是刻意的：
 * 任何逻辑放这里都没法被单测覆盖（它需要真进程、真 argv、真退出码）。
 *
 * 用 tsx 直跑 src 还是跑 dist？—— **跑 dist**。
 * CLI 在 CI 里被调用时，机器上未必装了 devDependencies（tsx 就是 devDep），
 * 而 dist 是 `npm run build` 的产物、随包一起发。
 * 找不到 dist 时给一句能照做的报错，而不是 MODULE_NOT_FOUND 堆栈。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'main.js');
if (!existsSync(entry)) {
  console.error('找不到 atest 的构建产物 dist/main.js。');
  console.error('在这个仓库里先跑：npm run build');
  console.error('（dist 不进 git —— 见 .gitignore 的说明：它是构建产物，且跨包测试依赖它新鲜）');
  process.exit(4);
}

const { main } = await import(entry);
process.exitCode = await main(process.argv.slice(2), {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  cwd: process.cwd(),
  env: process.env,
});
