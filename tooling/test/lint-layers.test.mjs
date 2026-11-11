/**
 * 架构分层检查的自测（M0 的完成判据：**故意 import `fs` 会被拦下来**）。
 *
 * 这条检查承担的是整个「一个执行引擎、GUI 只是它的一个视图」的论断
 * （docs/01 §8.2、docs/00 §6.6）。它自己出 bug 的方式是最坏的一种：
 * 正则写错、规则漏登记、异常被 catch 掉 —— 全部表现为「检查通过」。
 * 一条静默失效的 lint 比没有 lint 更糟，因为它让「有保护」变成错觉。
 *
 * 放在 tooling/ 而不是 packages/：本文件**允许**用 node API（它不是引擎的一部分），
 * 而且它必须能读规则表本身，否则只能靠记忆断言规则内容。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkSources, LAYER_RULES, uncoveredPackages } from '../lint-layers.mjs';

/** 造一个内存里的文件，不落盘：检查逻辑与 IO 无关，没必要碰磁盘 */
const eng = (text) => [{ pkg: 'packages/engine/src/x.ts', text }];
const irf = (text) => [{ pkg: 'packages/ir/src/x.ts', text }];
const codes = (v) => v.map((x) => x.what);

describe('M0 判据：引擎/IR 里的 node 内置模块必须被拦', () => {
  const FORMS = [
    [`import { readFileSync } from 'fs';`, '裸名 fs'],
    [`import { readFileSync } from 'node:fs';`, 'node: 前缀'],
    [`import fs from 'fs/promises';`, '子路径 fs/promises'],
    [`export * from 'node:crypto';`, 're-export'],
    [`import 'node:os';`, '副作用 import'],
    [`const m = await import('node:child_process');`, '动态 import()'],
    [`const m = require('node:net');`, 'require()'],
  ];
  for (const [line, label] of FORMS) {
    test(`engine 拦下 ${label}`, () => {
      const v = checkSources(eng(line));
      assert.equal(v.length, 1, `${label} 应被拦下，实际放行：${line}`);
      assert.match(v[0].what, /import/);
      assert.match(v[0].why, /禁止 node 内置模块/);
    });
  }
  test('ir 同样拦下', () => assert.equal(checkSources(irf(`import { existsSync } from 'node:fs';`)).length, 1));

  test('报错带行号，否则 300 个文件里没人去找那一行', () => {
    const v = checkSources(eng(`// 1\n// 2\nimport fs from 'node:fs';\n`));
    assert.match(v[0].where, /:3$/);
  });

  test('报错指向设计文档，让被拦的人知道**为什么**', () => {
    const v = checkSources(eng(`import fs from 'node:fs';`));
    assert.match(v[0].why, /docs\/01|docs\/04/);
  });

  test('干净文件零违例（误报会让人直接给规则加豁免）', () => {
    const clean = `
import { z } from 'zod';
import type { Scenario } from '@atest/ir';
import { parsePath } from './jsonpath.js';
const t = await import('./sub.js');
export * from './other.js';
class C {} export { C };
export function f(p: string) { return p.startsWith('$'); }
const s = "import fs from 'node:fs'; 这是注释里的字符串，不是 import";
export const g = s;
`;
    assert.deepEqual(checkSources(eng(clean)), []);
  });
});

describe('依赖方向必须单向向下', () => {
  test('engine 不得依赖 store/server/cli 等上层包', () => {
    const v = checkSources(eng(`import { db } from '@atest/store';`));
    assert.equal(v.length, 1);
    assert.match(v[0].why, /单向向下/);
  });
  test('ir 不得依赖 engine（IR 是引擎的下层）', () =>
    assert.equal(checkSources(irf(`import { runScenario } from '@atest/engine';`)).length, 1));
  test('engine 依赖 ir 是合法方向', () =>
    assert.deepEqual(checkSources(eng(`import { Scenario } from '@atest/ir';`)), []));
});

describe('豁免必须显式且最小', () => {
  test('测试目录可以用 node:test / node:assert', () => {
    const sources = [{ pkg: 'packages/engine/test/a.test.ts', text: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';` }];
    assert.deepEqual(checkSources(sources), []);
  });
  test('…但测试目录**仍然**不许依赖上层包（豁免只针对 node 内置模块）', () =>
    assert.equal(checkSources([{ pkg: 'packages/engine/test/a.test.ts', text: `import { db } from '@atest/store';` }]).length, 1));
  test('…测试目录也不能拿豁免当口子塞 fs 进引擎源码', () =>
    assert.equal(checkSources(eng(`import fs from 'node:fs';`)).length, 1));
});

describe('规则表本身', () => {
  test('ir 与 engine 都在受检清单里（漏登记 = 该包完全不受保护）', () => {
    const pkgs = LAYER_RULES.map((r) => r.pkg);
    assert.ok(pkgs.includes('packages/ir'), 'ir 未受保护');
    assert.ok(pkgs.includes('packages/engine'), 'engine 未受保护');
  });
  test('受禁层（ir/engine）必须禁 node 内置模块', () => {
    for (const name of ['packages/ir', 'packages/engine']) {
      const r = LAYER_RULES.find((x) => x.pkg === name);
      assert.ok(r, `${name} 不在规则表里`);
      assert.equal(r.forbidNodeBuiltins, true, `${name} 竟然允许 node 内置模块`);
    }
  });
  test('允许碰 node 的包必须**显式**声明允许，且理由里说清为什么（不能靠漏写蒙过去）', () => {
    for (const r of LAYER_RULES) {
      assert.ok(r.reason && r.reason.length > 10, `${r.pkg} 缺理由`);
      if (!r.forbidNodeBuiltins) {
        // 放行 node 内置模块的包，理由必须**点名它碰的是哪种副作用**。
        // 原来的正则是 /adapter|副作用|网络/，而 store 的理由里"adapter"这个词出现于
        // "不得依赖某个具体 adapter" —— 那句话讲的是**不**碰谁，跟"为什么能碰 fs"毫无关系，
        // 却把检查过了。这就是"测试通过的原因和它想验的东西无关"的典型形态：
        // 加一个碰磁盘的新包、理由里顺口提一句 adapter，检查就点头了。
        // 所以现在要求出现的是**副作用本身的名词**（磁盘/网络/进程/子进程），
        // 并且不再接受光秃秃的 "adapter"。
        assert.match(r.reason, /磁盘|网络|子进程|进程|副作用/, `${r.pkg} 放行了 node 内置模块但没说清依据（要点名它碰哪类副作用）`);
      }
    }
  });
  test('adapter 允许 node 内置模块，但**仍然**不得依赖上层包（放行一项不等于放行全部）', () => {
    const rule = LAYER_RULES.find((r) => r.pkg === 'packages/adapter-http');
    const src = (t) => [{ pkg: 'packages/adapter-http/src/a.ts', text: t }];
    assert.deepEqual(checkSources(src(`import { readFile } from 'node:fs';`), [rule]), []);
    const v = checkSources(src(`import { server } from '@atest/server';`), [rule]);
    assert.equal(v.length, 1, 'adapter 依赖服务端包必须被拦');
    // 但它可以依赖 ir/engine —— 那是它存在的意义
    assert.deepEqual(checkSources(src(`import { parseScenario } from '@atest/ir';`), [rule]), []);
  });
  test('新包没有规则 = 报错，而不是安静地不检查它', () => {
    // 这条的动机是真实发生过的：adapter-http 一开始只被登记为
    // 「别人不许依赖它」，没被登记为「它自己受检」，于是它 import 服务端包能溜过去。
    assert.deepEqual(uncoveredPackages(['packages/ir', 'packages/engine', 'packages/adapter-http'], LAYER_RULES), []);
    assert.deepEqual(uncoveredPackages(['packages/ir', 'packages/mystery'], LAYER_RULES), ['packages/mystery']);
  });
  test('内置模块清单覆盖常用项（漏一项 = 那个模块能溜过去）', () => {
    // **手写**清单，不从 lint-layers.mjs 导入：导入的话，规则里漏掉哪个模块，
    // 测试就正好不检查哪个 —— 自证清白等于没证。
    const EXPECTED = ['fs','path','os','crypto','child_process','net','http','https','worker_threads','vm','module','process','url','util','stream','events','zlib','dns','tls','readline','assert','buffer','timers','perf_hooks','inspector','v8','cluster'];
    const rules = LAYER_RULES.find((r) => r.pkg === 'packages/engine');
    for (const mod of EXPECTED) {
      const v = checkSources(eng(`import x from 'node:${mod}';`), [rules]);
      assert.equal(v.length, 1, `node:${mod} 竟然没被拦 —— 清单漏了它`);
    }
  });
  /*
   * server 与 web 这两条规则是随前端那一轮**新增**的。新增规则有个特有的失效方式：
   * 规则写了、包也登记了，但 forbidPackages 里的名字拼错一个字母（'adapter-htt'），
   * 于是那条规则**一条都拦不住**，而 `npm run lint` 照绿 ——
   * 因为 lint 只报违例，不报"这条规则从没命中过"。所以下面三条各钉一格。
   */
  test('web 跑在浏览器里：node 内置模块一个都不许碰，测试目录也只豁免这一条', () => {
    const rule = LAYER_RULES.find((r) => r.pkg === 'packages/web');
    assert.ok(rule, 'packages/web 没有规则');
    assert.equal(rule.forbidNodeBuiltins, true, 'web 竟然允许 node 内置模块（那它在浏览器里会炸）');
    const src = (t, pkg = 'packages/web/src/a.ts') => [{ pkg, text: t }];
    assert.equal(checkSources(src(`import { join } from 'node:path';`), [rule]).length, 1);
    // 测试目录豁免 node（node:test 是内置的），但**不**豁免依赖方向
    assert.deepEqual(checkSources(src(`import t from 'node:test';`, 'packages/web/test/a.test.ts'), [rule]), []);
    assert.equal(checkSources(src(`import { startServer } from '@atest/server';`, 'packages/web/test/a.test.ts'), [rule]).length, 1,
      '前端测试里 import 服务端 = 依赖方向反了，豁免不该管这一条');
  });
  test('web 不得依赖 server/cli/store（否则"浏览器里跑真引擎"那条当场失效）', () => {
    const rule = LAYER_RULES.find((r) => r.pkg === 'packages/web');
    for (const dep of ['server', 'cli', 'store', 'adapter-http', 'adapter-web']) {
      const v = checkSources([{ pkg: 'packages/web/src/a.ts', text: `import { x } from '@atest/${dep}';` }], [rule]);
      assert.equal(v.length, 1, `web 依赖 @atest/${dep} 必须被拦 —— 名字拼错的话这里会红`);
    }
    // 而 ir + engine 是它**该**依赖的（那正是"浏览器里是真引擎"的机制）
    for (const ok of ['ir', 'engine']) {
      assert.deepEqual(checkSources([{ pkg: 'packages/web/src/a.ts', text: `import { x } from '@atest/${ok}';` }], [rule]), [],
        `web 依赖 @atest/${ok} 是设计允许的，不该被拦`);
    }
  });
  test('server 是翻译层：放行 node，但不得认识 UI/前端，也不得自己装 adapter', () => {
    const rule = LAYER_RULES.find((r) => r.pkg === 'packages/server');
    const src = (t) => [{ pkg: 'packages/server/src/a.ts', text: t }];
    assert.deepEqual(checkSources(src(`import { createServer } from 'node:http';`), [rule]), [], '服务端必然 listen，node:http 要放行');
    for (const dep of ['web', 'adapter-http', 'adapter-web']) {
      assert.equal(checkSources(src(`import { x } from '@atest/${dep}';`), [rule]).length, 1,
        `服务端依赖 @atest/${dep} 必须被拦（装配 adapter 是 CLI 那条 run 路径的事）`);
    }
    // cli 是它**该**调的那一层（翻译到命令形态）
    assert.deepEqual(checkSources(src(`import { main } from '@atest/cli';`), [rule]), []);
  });
  test('未知包不受影响（规则按包精确匹配，不能误伤）', () =>
    assert.deepEqual(checkSources([{ pkg: 'packages/adapter-http/src/a.ts', text: `import fs from 'node:fs';` }]), []));
});
