#!/usr/bin/env node
/**
 * `npm run serve` —— 把服务端起起来，让人**打开浏览器就能看**。
 *
 * ## 入口为什么在 server/bin 而不是 web/bin
 *
 * 第一版写在 `packages/web/bin/`，那是错的，而且错得能被 lint 抓到：
 * `packages/web` 的规则是 **forbidNodeBuiltins**（它跑在浏览器里），
 * 而这个脚本必须 `node:fs`/`node:path`、还要 import `@atest/server` ——
 * 两条都违例（后者更严重：前端依赖服务端，依赖方向当场反了）。
 * 放在这里成立的理由是它**只按路径引用 web 的产物**，不 `import '@atest/web/*'`：
 * 它是个装配器（assembler），装配者认识两边的路径，但谁也没依赖谁。
 *
 * ## `startServer()` 自己为什么一个文件都不发
 *
 * `staticRoots` 默认空。那不是缺功能：服务端一旦自己猜仓库布局，
 * 猜宽一格（比如把仓库根当根）就把 `atest.json`、`env/*.json`
 * （里面是真实 baseUrl 与密钥 ref）一起发出去了。
 * 所以"哪几棵子树可以给浏览器"必须在**知道布局的地方**装配 ——
 * 也就是这个脚本，它就在仓库里，路径是它自己写死的常量。
 *
 * 这份装配的判据由 `packages/server/test/static-roots.test.ts` 钉住：
 * 它拿 `defaultStaticRoots(<仓库根>, <packages/web/dist>)` 断言入口页与
 * import map 里每个模块都能解析到**磁盘上真实存在**的文件 ——
 * 也就是"这套根装配起来够不够让页面打开"这件事本身。
 *
 * ## 为什么跑 dist 而不是 tsx 直跑 src
 *
 * 与 `packages/cli/bin/atest.mjs` 同一条理由：dist 是构建产物、随包发；
 * tsx 是 devDependency，装了 devDep 的机器才跑得动。前端这边还多一条更硬的理由：
 * **浏览器 import 的就是 `packages/ir/dist` 与 `packages/engine/dist`**，
 * 所以 dist 不存在时这个页面**本来就没法工作** —— 早报错比白屏好。
 *
 * ## Ctrl-C
 *
 * 直接按 Ctrl-C：正在跑的 run 会走 `installSignalHandlers` 那条链
 * （置标志 → 引擎 checkAbort → run 目录那几份产物照写 → 租约照还），退出码 10。
 * **这里不另造"优雅关闭"** —— 那会变成第二条取消路径，
 * 而取消必须只有一个入口（一次取消绝不该产生第二遍副作用，docs/02 §5）。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// packages/web/bin -> 仓库根
const repoRoot = resolve(here, '..', '..', '..');

const need = [
  ['@atest/server', join(repoRoot, 'packages/server/dist/index.js')],
  ['前端入口', join(repoRoot, 'packages/web/static/index.html')],
  ['前端模块', join(repoRoot, 'packages/web/dist/app.js')],
  ['IR 本体', join(repoRoot, 'packages/ir/dist/index.js')],
  ['引擎本体', join(repoRoot, 'packages/engine/dist/index.js')],
  ['zod（IR 的运行时依赖）', join(repoRoot, 'node_modules/zod/index.js')],
];
const missing = need.filter(([, p]) => !existsSync(p));
if (missing.length) {
  console.error('起不来，这些还没有：');
  for (const [what, p] of missing) console.error(`  · ${what}  ${p.replace(repoRoot + '/', '')}`);
  console.error('\n在这个仓库里先跑：npm run build');
  console.error('（dist 不进 git —— 见 .gitignore：它是构建产物，且跨包测试依赖它新鲜）');
  process.exit(4);
}

const { defaultStaticRoots, startServer } = await import(join(repoRoot, 'packages/server/dist/index.js'));

// 端口：命令行第一个参数，或 8787。**绑 127.0.0.1**（服务端代码里写死的），
// 所以这一格不需要"要不要暴露到局域网"这种选项 —— 暴露与否由端口决定不了的事，
// 不该由一个开关假装能决定。
const port = Number(process.argv[2] ?? 8787);
const cwd = process.cwd();

const srv = await startServer({
  cwd,
  port,
  staticRoots: defaultStaticRoots(repoRoot, join(repoRoot, 'packages/web/dist')),
});

console.log(`atest 后台已起： ${srv.url}`);
console.log(`工作目录：       ${cwd}`);
console.log('静态根：/  (只发 index.html)、/app/、/pkg/ir|engine|zod/（只发 .js）');
console.log('Ctrl-C 结束；正在跑的 run 会落完 run 目录里那几份产物再退。');
