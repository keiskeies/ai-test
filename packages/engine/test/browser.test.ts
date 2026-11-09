/**
 * M1 判据：**引擎在浏览器里也能跑**（docs/01 §8.2、docs/00 §6.6）。
 *
 * lint-layers 只查 `import` 语句，查不到两类东西：
 *   1. 隐藏全局 —— `process.env` / `Buffer` / `__dirname` / `globalThis.require`
 *      一行 import 都不需要，却能安静地把引擎绑死在 Node 上；
 *   2. 依赖的**传递**闭包 —— zod 之类第三方包里藏了 node 专用 API 一样会炸。
 *
 * 所以这里真的把引擎打成一个浏览器包，在一个**没有 Node 全局**的虚拟机里
 * 加载并跑一个场景。用 vm + esbuild 而不是 jsdom：本机无外网装不了 jsdom，
 * 而且 vm 的断言更强 —— jsdom 会补一堆 Node 兼容层，反而把违例遮掉。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let bundle = '';

before(async () => {
  const r = await build({
    // 虚拟入口：引擎本身不 re-export @atest/ir（那是它自己的依赖），
    // 但浏览器侧的编辑器同时要**用** IR 解析，所以这里按真实使用面打在一起。
    stdin: {
      contents: `export * from '@atest/engine';\nexport * from '@atest/ir';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    // 必须指向 **src**：包 exports 指向 dist，直接打包会测到「上次构建的产物」——
    // 忘记 build 时测试仍然绿，但它验的已经不是当前代码了。
    alias: {
      '@atest/engine': resolve('packages/engine/src/index.ts'),
      '@atest/ir': resolve('packages/ir/src/index.ts'),
    },
    bundle: true,
    // iife + globalName：产出 `var __engine = (()=>{...})()`。
    // 先前用 format:'esm' 再手写「把 export 语句改成挂 globalThis」的转换器 ——
    // 它对 esbuild 的真实产物匹配到 **0 个** export，于是 __mod 是空对象，
    // 而「加载成功」这条用例照样通过：一个只会假绿的测试。
    format: 'iife',
    globalName: '__engine',
    // browser：让 esbuild 替我们踩一遍「浏览器打包会踩的坑」（例如 process.env 替换）
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
  });
  bundle = r.outputFiles[0]?.text ?? '';
  assert.ok(bundle.length > 1000, '打包结果异常小，可能什么都没打进来');
});

/**
 * 造一个「像浏览器而不像 Node」的全局环境。
 * 关键在于**被禁的那些名字一律设成会抛错的 getter**：
 * 只要引擎（含它打进来的第三方依赖）碰一下 `process`，就是当场报错，
 * 而不是安静地拿到 undefined 再走出奇怪分支。
 */
const FORBIDDEN = ['process', 'require', 'Buffer', '__dirname', '__filename', 'module', 'global'];

function makeBrowserContext() {
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    Date, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, RangeError,
    Map, Set, WeakMap, Promise, Symbol, Proxy, Reflect, isNaN, parseInt, parseFloat,
    URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Infinity, NaN, undefined: undefined,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, Math.min(ms ?? 0, 5)),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
    structuredClone: (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown,
  };
  for (const name of FORBIDDEN) {
    // enumerable 必须是 true：vm 只把 sandbox 的**可枚举**属性搬到 context 全局上，
    // 少了它这些 getter 根本不会生效，测试就变成「什么都没拦到」的假绿。
    Object.defineProperty(sandbox, name, {
      get() { throw new Error(`引擎触碰了 Node 专属全局 "${name}" —— 它在浏览器里不存在`); },
      enumerable: true,
      configurable: false,
    });
  }
  // sandbox 上的 getter 会被 vm 映射到 context 的 globalThis 上，所以
  // `globalThis.process` 这种绕法同样会抛 —— 下面 selfTestTrapIsLive 专门验这件事，
  // 不验的话整个测试可能只是「getter 没生效所以什么都没拦到」的假绿。
  return createContext(sandbox, { name: 'browser-like' });
}

describe('引擎不依赖任何 Node 运行时（浏览器可用性）', () => {
  test('先验证陷阱本身是活的（否则本文件可能全程假绿）', () => {
    const ctx = makeBrowserContext();
    for (const name of FORBIDDEN) {
      // 裸标识符访问必须炸（ReferenceError 或我们的 getter 都算）。
      // `globalThis.x` 则应当拿到 **undefined** —— 这正是浏览器的真实形状：
      // 属性压根不存在。断言它「也抛」是错的断言，会漏掉唯一危险的那种情况：
      // 代码写 `if (typeof process !== 'undefined')` 时靠 undefined 走对分支。
      assert.throws(() => runInContext(name, ctx), /Node 专属全局|is not defined/, `${name} 没被拦住`);
      assert.equal(runInContext(`typeof globalThis.${name}`, ctx), 'undefined', `globalThis.${name} 竟然存在`);
    }
    // 而正常全局必须可用，否则「加载成功」只是因为根本没执行到
    // 正常全局必须真的可用：否则「加载成功」可能只是因为什么都没执行到
    assert.equal(runInContext(`typeof URL + typeof Promise + JSON.stringify({a:1})`, ctx), 'functionfunction{"a":1}');
  });

  test('打包产物能在无 Node 全局的环境里加载', () => {
    const ctx = makeBrowserContext();
    // 加载就会执行模块体：任何顶层的 process/Buffer 访问都在这里炸
    runInContext(bundle, ctx, { filename: 'engine.bundle.js' });
    const mod = (ctx as { __engine?: Record<string, unknown> }).__engine ?? {};
    for (const name of ['runScenario', 'lintScenario', 'deterministicClock', 'compileExpr', 'parseScenario', 'VarSpace']) {
      assert.equal(typeof mod[name], 'function', `${name} 没导出到`);
    }
  });

  test('在里面真跑一个场景，结果与 Node 里一致', async () => {
    const ctx = makeBrowserContext();
    runInContext(bundle, ctx, { filename: 'engine.bundle.js' });
    const script = `
      (async () => {
        const m = globalThis.__engine;
        const body = [
          { id: 'mk', kind: 'set', assign: { resp: { status: 200, body: { id: 'ORD-1', list: [1, 2] } } } },
          { id: 'a1', kind: 'assert', against: '$.step.mk.resp', status: 200,
            // 注意路径是 $.id 而不是 $.body.id：断言对象是响应时会自动拆掉一层 body
            // （assertions.ts 里的 value?.body ?? value）。这个行为记在 docs/08 的欠账里 ——
            // 响应体自己就有 body 字段时它无法区分，但拆一层确实让 90% 的断言更短。
            jsonPath: { '$.id': { matches: '^ORD-[0-9]+$' }, '$.list': { isArray: true, minLength: 2 } } },
          { id: 'w', kind: 'wait', condition: { type: 'expr', expr: '$.step.mk.resp.status == 200' }, timeoutMs: 1000, pollMs: 50, onTimeout: 'fail' },
          { id: 'a2', kind: 'assert', against: '$.step.mk.resp.body.id', jsonPath: { $: { exact: 'ORD-1' } } },
        ];
        const s = m.parseScenario({ schemaVersion: '1', id: 'scn.browser', name: 'b', env: { environmentRef: 'u' }, body });
        if (!s.ok) return { irErrors: s.errors };
        const r = await m.runScenario({ scenario: s.scenario, adapters: {}, clock: m.deterministicClock(7) });
        return { status: r.status, summary: r.summary,
          steps: r.results.map((x) => x.stepId + ':' + x.status + (x.status === 'pass' ? '' : '|' + (x.assertionSummary || ''))).join(' ') };
      })()
    `;
    const out = (await runInContext(script, ctx, { filename: 'scenario.js' })) as { status?: string; summary?: string; steps?: string; irErrors?: unknown };
    assert.equal(out.irErrors, undefined, `IR 不合法：${JSON.stringify(out.irErrors)}`);
    // 失败时把每一步的状态与摘要一起打出来，否则只看到 'fail' !== 'pass' 无从下手
    assert.equal(out.status, 'pass', `${out.summary} :: ${out.steps}`);
    assert.equal(out.steps, 'mk:pass a1:pass w:pass a2:pass');
  });

  test('静态闸同样能在浏览器里跑（前端编辑器实时校验的前提）', () => {
    const ctx = makeBrowserContext();
    runInContext(bundle, ctx, { filename: 'engine.bundle.js' });
    const out = runInContext(`(() => {
      const m = globalThis.__engine;
      const s = m.parseScenario({ schemaVersion: '1', id: 's', name: 'n', env: { environmentRef: 'u' },
        body: [{ id: 'h', kind: 'http', request: { method: 'GET', url: 'http://x' } }] });
      if (!s.ok) return { irErrors: s.errors };
      return { codes: m.lintScenario(s.scenario).map((i) => i.code) };
    })()`, ctx) as { codes?: string[]; irErrors?: unknown };
    assert.equal(out.irErrors, undefined, JSON.stringify(out.irErrors));
    assert.ok(out.codes!.includes('ASSERT_FREE_STEP'), '静态闸在浏览器里必须给出与 Node 相同的结果');
  });

  test('表达式与 JSONPath 也在同一环境里可用（VarChip/实时预览要的就是这个）', () => {
    const ctx = makeBrowserContext();
    runInContext(bundle, ctx, { filename: 'engine.bundle.js' });
    const out = runInContext(`(() => {
      const m = globalThis.__engine;
      return {
        expr: m.compileExpr('\\$a + count($b)').eval({ root: { a: 1, b: [1,2,3] } }),
        path: m.queryOne({ data: { list: [{ id: 9 } ] } }, '$.data.list[0].id'),
        ref: m.parseRef('$.step.mk.resp').stepId,
      };
    })()`, ctx) as { expr: number; path: number; ref: string };
    // 跨 realm 比较只能比内容不能比原型（node:assert/strict 的 deepEqual 会比原型，
    // 于是内容完全相同也判不等）。序列化一层再比。
    assert.equal(JSON.stringify(out), JSON.stringify({ expr: 4, path: 9, ref: 'mk' }));
  });
});
