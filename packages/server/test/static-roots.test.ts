/**
 * `defaultStaticRoots()` 装配出来的那几棵根，**够不够让页面真的打开**。
 *
 * ## 为什么单独一个文件，而不是并进 files.test.ts
 *
 * `files.test.ts` 测的是解析函数（给一批根，判一个 URL），那里的根是**夹具**。
 * 这一条测的是**生产装配**：根由 `defaultStaticRoots()` 给，URL 由
 * `packages/web/static/index.html` 里那份 import map 给，两边都要对得上真实磁盘。
 * 少了这一条，就会出现第一版真实发生过的缺口：函数全绿、单元测试全绿，
 * 而 `/` 没有根 → `index.html` 一个 URL 都到不了 → 这套前端压根打不开。
 *
 * ## 判据为什么是"import map 里每个目标都能解析到真实文件"
 *
 * 因为那正是"页面打不开"的**充要**形状，而且它同时钉住三件事：
 *  - 有人在 import map 里加了一个裸名（比如 `'@atest/store'`）却忘了配根 → 红；
 *  - 有人改了 dist 目录名或把某个根的发文件扩展名收窄 → 红；
 *  - import map 指向的路径拼错（`/pkg/ir/index.js` 少写一层）→ 红。
 *
 * 反过来说它**不**测"浏览器里跑得通"（那是
 * `packages/web/test/browser-modules.test.ts` 的活，那条要起 Chrome）。
 * 这条不起浏览器，所以没装 Chrome 的机器也能挡住"装配缺一格"这一类。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultStaticRoots } from '../src/index.js';
import { resolveStatic } from '../src/files.js';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const INDEX_HTML = join(ROOT, 'packages/web/static/index.html');

/** 从 index.html 里抠出 import map。取的是**生产那份**，不是测试里手抄的副本 ——
    手抄的夹具只能证明"我跟自己一致"，那是 docs/08 §3 说的断言同义反复。 */
function importMap(): Record<string, string> {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'index.html 里没有 import map —— 裸名（@atest/ir、zod）在浏览器里解析不了');
  const parsed = JSON.parse(m[1]!) as { imports?: Record<string, string> };
  assert.ok(parsed.imports, 'import map 里没有 imports 这一栏');
  return parsed.imports;
}

test('生产的静态根装配能让入口页与它 import 的每个模块都落到真实文件', () => {
  const roots = defaultStaticRoots(ROOT, join(ROOT, 'packages/web/dist'));

  // ① 入口文档可达。这是第一版缺的那一格：`/` 没有根时，
  //    index.html 在磁盘上躺着，但没有任何 URL 能读到它。
  const entry = resolveStatic('/', roots);
  assert.ok(entry, 'URL "/" 解析不出文件 —— 页面打不开，而所有单元测试都是绿的');
  assert.equal(entry.absolute, join(ROOT, 'packages/web/static/index.html'));
  assert.ok(existsSync(entry.absolute), `解析出来的入口文件不在磁盘上：${entry.absolute}`);

  // ② import map 的每一个目标都能解析，而且**文件真的在**。
  //    只判"能解析出路径"不够：解析得出来但文件不存在，浏览器里的表现是
  //    一条 module 404，页面白屏且不报错 —— 本平台最反感的那类失效。
  const map = importMap();
  for (const [spec, url] of Object.entries(map)) {
    // 尾斜杠的键是**前缀映射**（'@atest/web/' → '/app/'），不是具体文件，跳过存在性
    if (spec.endsWith('/')) {
      assert.ok(url.endsWith('/'), `前缀映射 ${spec} 的目标也要以 / 结尾，实际 ${url}`);
      continue;
    }
    const hit = resolveStatic(url, roots);
    assert.ok(hit, `import map 里 ${spec} → ${url} 没有任何静态根能接住它`);
    assert.ok(existsSync(hit.absolute), `${spec} → ${url} 解析到 ${hit.absolute}，但那个文件不在磁盘上`);
  }

  // ③ 三个运行时依赖**都在**（这条是 ② 的显式重述，因为它红了要一眼看出是哪一族）
  for (const spec of ['zod', '@atest/ir', '@atest/engine']) {
    assert.ok(map[spec], `import map 少了 ${spec}`);
  }
});

test('入口页那一格只发 .html —— 前缀挂在仓库根附近，集合必须收到最窄', () => {
  const roots = defaultStaticRoots(ROOT, join(ROOT, 'packages/web/dist'));
  const entryRoot = roots.find((r) => r.urlPrefix === '/');
  assert.ok(entryRoot, '没有 "/" 这一棵根');
  assert.deepEqual([...entryRoot.extensions], ['.html'],
    '"/" 这棵根的扩展名集合不止 .html：它是唯一一棵前缀能匹配任意的根，宽一格就等于全盘可达');

  // 这一格之外的东西**一个都读不到**。这些 URL 在开发机上真实存在，
  // 而它们中的几个含密钥 ref 或真实响应体。
  for (const p of ['/package.json', '/atest.json', '/env/dev.json', '/.git/config', '/.env',
                   '/packages/server/dist/index.js', '/docs/README.md']) {
    assert.equal(resolveStatic(p, roots), undefined, `${p} 不该被 "/" 那棵根发出去`);
  }
});

test('前缀之间不互相借文件（每棵根的扩展名白名单各自成立）', () => {
  const roots = defaultStaticRoots(ROOT, join(ROOT, 'packages/web/dist'));
  // ir 那格只发 .js。它拒了之后**不许**掉到 "/" 那格去 web/static 里借同名文件
  assert.equal(resolveStatic('/pkg/ir/package.json', roots), undefined);
  assert.equal(resolveStatic('/pkg/zod/package.json', roots), undefined);
  // 而 .js 正常给（防"为了防止而把根判死"）
  assert.ok(resolveStatic('/pkg/ir/index.js', roots), 'ir 的 index.js 本该能发');
  // /app/ 那格发 .html（生产集合里有），所以它不该被 "/" 抢走
  const app = resolveStatic('/app/app.js', roots);
  assert.ok(app && app.root.urlPrefix === '/app/', `该由 /app/ 接住，实际 ${app?.root.urlPrefix}`);
});
