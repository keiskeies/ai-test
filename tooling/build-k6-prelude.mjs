#!/usr/bin/env node
/**
 * 打 k6 预lude：`packages/adapter-http/src/load-entry.ts` ──esbuild──▶ `dist/atest-load-prelude.mjs`。
 *
 * ## 为什么需要这一步（而不是让生成的脚本直接 import dist 里那些模块）
 *
 * k6 拿到的是一段**独立的 JS 文件**，它跑在自己的运行时里（goja），没有 node 的
 * `node_modules` 解析、没有 tsc、也不认 `@atest/*` 这些包名。所以"两个后端共用同一份
 * 语义"这句话要在 k6 那侧成立，只有一条路：**把那份语义打进一个文件里带过去**。
 * 重写一遍是绝对不行的（`load-entry.ts` 头上记的就是"照语义再写一遍"付过三次代价）。
 *
 * ## 为什么这一步必须在 `npm run build` 里（而不是"要用时再手动打"）
 *
 * 这个产物是 **dist 里的文件**，而 dist 是 gitignored 的构建产物。手动打的结局是
 * 本仓最熟的那一格：**改了 src 而产物是旧的，CI 照绿**（.gitignore 里那段话就是
 * 讲 dist 的这件事）。所以：
 *  - `npm run build` 里带上这一步（与 tsc 同一次）；
 *  - `tooling/k6-prelude.test.mjs` **现打一份比 hash**，谁改了 load-entry.ts
 *    而忘了重打，那条测试直接红（不是"提醒一下"，是红）。
 *
 * ## 参数选择
 *  - `--format=esm`：生成的 k6 脚本用 `import`，必须是 ESM。
 *  - `--platform=neutral`：不假设 node，也不假设浏览器。k6 的运行时两者都不是。
 *    （选 `node` 时 esbuild 会把 `node:*` 当成外部依赖留着不解析，看着没事，
 *     实际是把"运行时里有没有 node 内置模块"这件事推到了跑的那一刻 —— 而那一刻
 *     在用户机上。neutral 下真有用不到的内置模块会在打包时就报出来。）
 *  - **不 minify**：这个文件要能在 k6 报错时被人读懂（k6 报的是栈里的行号与符号名）。
 *    `load-entry.ts` 头上那句"压缩后约 5×10⁵ 字节"说的是压缩口径；不压约 8.9×10⁵，
 *    换可读性。要压可以加 `--minify`，但那条 hash 与 staleness 判据会跟着换。
 *  - `--bundle` 把 zod 也带进来了（`isValueForm` 那条判据在 ir 里，而 ir 用 zod 定义
 *    schema）。砍它是 IR 侧的重构（把判据搬到一个不 import zod 的叶子模块），
 *    登记在 docs/14 而不在这里做。
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 预lude 的文件名。**从 src 那个常量读**，不在这里再写一遍字面量。
 *
 * 这里是 node 脚本而 `prelude.ts` 是 TS，直接 import 要过 tsx。用正则取而不是引 tsx：
 * 这个脚本要在 `npm run build`（纯 tsc 产物）里跑，拖一个 TS loader 进来会让构建
 * 依赖变重。取不到就抛 —— **静默回退到一个硬编码的文件名**才是这一族缺陷的形状
 * （两边各写一份文件名，改一处漏一处，坏法是"k6 起不来"而本机没有 k6）。
 */
function preludeFileName() {
  const src = readFileSync(join(REPO, 'packages/adapter-http/src/load/prelude.ts'), 'utf8');
  const m = src.match(/export const PRELUDE_FILE = '([^']+)'/);
  if (!m?.[1]) throw new Error('prelude.ts 里找不到 export const PRELUDE_FILE = \'…\'，去把命名定在那儿并在这里读');
  return m[1];
}

/**
 * 打包并落盘。返回写入路径、字节数与**内容本身**。
 *
 * `write: false` 时**一个字节都不写磁盘**，只把内容还给调用方。这个开关是给
 * `test/k6-prelude.test.mjs` 的 staleness 判据用的，而它不是可有可无的便利参数：
 * 判据的形状是"先读磁盘上那份旧的，再现打一份比"。如果现打这一步会**覆盖**磁盘上
 * 那份，读到的就已经是刚打出来的，比的是同一个文件 —— **恒绿的 staleness 判据**，
 * 而恒绿的守卫比没有守卫更坏（docs/08 §3(f) 那一族的"看起来接好了"）。
 * `src/load-entry.ts` 头上那句"忘了重打的后果由 k6-prelude.test.mjs 拦住"要成立，
 * 靠的就是这一个参数。
 */
export async function buildK6Prelude({ write = true } = {}) {
  const entry = join(REPO, 'packages/adapter-http/src/load-entry.ts');
  const outFile = join(REPO, 'packages/adapter-http/dist', preludeFileName());
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    outfile: outFile,
    write: false,
    logLevel: 'warning',
  });
  if (r.outputFiles?.[0] === undefined) throw new Error('esbuild 没产出任何文件');
  const bytes = r.outputFiles[0].contents;
  if (write) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, bytes);
  }
  return { outFile, bytes: bytes.length, code: Buffer.from(bytes) };
}

// 只有直接执行时才打包（被测试 import 时不要有副作用）
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { outFile, bytes } = await buildK6Prelude();
  console.log(`k6 预lude → ${outFile.replace(`${REPO}/`, '')}（${bytes} 字节）`);
}
