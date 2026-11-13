/**
 * k6 预lude 产物**不许过期**。
 *
 * ## 这一条防的是本仓最熟的那一格
 * `dist/atest-load-prelude.mjs` 是 gitignored 的构建产物。改了
 * `packages/adapter-http/src/load-entry.ts`（或它 import 的任何一个语义函数）
 * 而忘了重跑 `npm run build`，磁盘上留下的就是**旧语义**的那份 —— 于是本仓全绿，
 * 而用户那边 k6 跑出来的行为属于上一个版本。这就是 .gitignore 里讲 dist 那段的形状：
 * **产物是旧的而 CI 照绿**。
 *
 * ## 判据必须是"先读旧的 + 再不打盘地现打一份"
 * `buildK6Prelude({ write: false })` 那个参数就是为这一条存在的。若现打那一步写磁盘，
 * 读到的就是刚打出来的那份，于是比的是同一个文件 —— **恒绿的 staleness 判据**，
 * 而恒绿的守卫比没有守卫更坏（它让人以为这一格有人管）。
 * 所以下面那个 `before` 的顺序是钉死的：**先读 dist，再 `write:false` 现打，再比**。
 * （写这段的时候我第一版就是先 build 再读同一路径，那条测试当场变成了一条恒绿断言；
 * 是"它怎么也红不了"让我回去看的，而不是任何一次失败。）
 *
 * ## 顺手钉的一条（同一次打包能顺手验的）
 * 现打的那份**真的导出** `src/load-entry.ts` 那三个符号。esbuild 的
 * `format/platform/target` 任一参数改坏，产物会照样存在、照样有字节数，而 k6 起不来。
 * 只看字节数与 hash 抓不到这种形状，所以要真的 import 一次问它有什么。
 * import 的是**临时目录里那份现打的**，不是 dist 里那份 —— 拿可能过期的 dist
 * 去验"现在的 src 打出来能不能用"，验的是另一件事。
 *
 * ## 为什么在 tooling/test 而不在 packages 下面
 * 它比的是**构建脚本**与 **src** 之间的一致性，不属于任何单个包的单测。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { buildK6Prelude } from '../build-k6-prelude.mjs';

const hash = (buf) => createHash('sha256').update(buf).digest('hex');
const REPO_PRELUDE_TS = fileURLToPath(new URL('../../packages/adapter-http/src/load/prelude.ts', import.meta.url));

describe('k6 预lude 的产物与 src 不许分叉', () => {
  /** 磁盘上那份（可能是旧的 —— 它**就该**可能是旧的，那正是这一条要抓的） */
  let disk;
  /** 现打的那份 + 它本该落到的路径。全程不落盘 */
  let fresh;
  let outFile;

  before(async () => {
    // 1) 先读磁盘。**在**打包之前 —— 见文件头那条顺序说明
    const probe = await buildK6Prelude({ write: false });
    outFile = probe.outFile;
    disk = existsSync(outFile) ? await readFile(outFile) : undefined;
    // 2) 再现打一次（write:false）。第一次调只用它拿路径
    fresh = (await buildK6Prelude({ write: false })).code;
  });

  test('非空自检：磁盘上那份存在且非空（不存在时下一条会恒绿在"两个 undefined"上）', () => {
    assert.ok(disk !== undefined, `${outFile} 不存在 —— 跑过 npm run build 吗？（build 脚本末尾那一步）`);
    assert.ok(disk.length > 10_000, `dist 里那份预lude 只有 ${disk.length} 字节，先怀疑打包本身失败`);
    assert.ok(fresh.length > 10_000, `现打的预lude 只有 ${fresh.length} 字节，先怀疑打包本身失败`);
  });

  test('dist 里那份与现打的一份字节相同（改了 src 忘了重打 = 红）', () => {
    assert.equal(
      hash(disk), hash(fresh),
      `dist 里那份预lude 是旧的（dist ${hash(disk).slice(0, 12)} ≠ 现打 ${hash(fresh).slice(0, 12)}）`
      + ' —— 重跑 npm run build。这不是"提醒"：跑旧产物的话 k6 侧的行为属于上一个版本，而本仓全绿。',
    );
  });

  test('现打的那份确实导出 load-entry 那三个符号（打包参数改坏也是"k6 起不来"）', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'atest-prelude-'));
    try {
      const f = join(tmpDir, 'prelude.mjs');
      await writeFile(f, fresh);
      const mod = await import(pathToFileURL(f).href);
      assert.deepEqual(Object.keys(mod).sort(), ['newLoadState', 'secretFromEnv', 'walkSyncK6'],
        `预lude 的导出表变了：${JSON.stringify(Object.keys(mod).sort())}`);
      for (const n of ['newLoadState', 'secretFromEnv', 'walkSyncK6']) {
        assert.equal(typeof mod[n], 'function', `${n} 不是函数（打成了一个空壳？）`);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('文件名从 prelude.ts 那个常量读，两边不是各写一份字面量', async () => {
    const tsSrc = await readFile(REPO_PRELUDE_TS, 'utf8');
    const m = /export const PRELUDE_FILE = '([^']+)'/.exec(tsSrc);
    assert.ok(m?.[1], 'prelude.ts 里那个常量改写法了？同步这里的取法（别放宽判据）');
    assert.ok(outFile?.endsWith(`/${m[1]}`), `打到了 ${outFile}，而 prelude.ts 说的是 ${m[1]}`);
    // 反向（生成的脚本 import 的就是这个名字）由
    // `packages/adapter-http/test/load-k6.test.ts` 逼着，那里比较的是脚本字节本身
  });
});
