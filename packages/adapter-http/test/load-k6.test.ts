/**
 * 生成的 k6 脚本：**真跑一遍**，而不是只看它长得像不像。
 *
 * ## 这份测试存在之前，那条路上"没人验得住"的范围比想象中大
 *
 * `emit-k6.ts` 的本机限制是真的（`github.com` 超时装不上 k6，实测），但"装不上 k6"
 * 被不恰当地推广成了"生成的脚本什么都验不了"。实际能验的范围是：
 *  - 脚本的**文法**（`node --check` 就够，不需要 k6）；
 *  - 脚本 import 的那几个符号**在真预lude 里存在**（最便宜的一条，而它对不上的
 *    坏法是"k6 起不来" —— 用户那边才响）；
 *  - **脚本 + 真预lude 端到端跑通，发出的请求与内置后端逐字节相同** ——
 *    这一格靠一个 `k6` 的 node 垫片（下面 `installK6Shim`），不需要 k6。
 *
 * 第三格是这一份的重点。它把 `emit-k6.ts` 头上那句"生成的文件里几乎没有逻辑"
 * 从**设计意图**变成**被测性质**：脚本自己的那几段（`toRaw` / `sendFor` / `encodeForm` /
 * `vuState` / `oneIteration` / 那个懒门闩 / `teardown`）——"数据 + 一个适配器"里的
 * 那个适配器 —— **第一次被执行到**。写这份测试之前它们一次都没跑过，
 * 而 `takeSync` 那个缺陷（同步调度器一个请求都发不出去，见 `load-parity.test.ts` 文件头）
 * 正好就在这几段的下游：只比 `walkSyncK6` 的测试看不见**脚本自身**那几段的错，
 * 只比文法的测试也看不见。
 *
 * ## 垫片**不**冒充 k6：能验到的与验不到的
 *  - 能：请求怎么构造（方法 / 完整 URL / 头 / 体 / 参数个数与顺序）、setup 与迭代的关系、
 *    `options` 的内容、teardown 跑几次、缺密钥时不发无鉴权请求、密钥不进文件。
 *  - 不能：k6 自己的分位数聚合、`params.tags` 的阈值子集**语义**、`__ENV` 的真实注入时机、
 *    VU 调度与 `stages` 爬坡。**这些仍然是纸上的**，登记在 docs/14，
 *    本文件不写"已验证 k6 那条路"。垫片只证明"我们发出去的东西是对的"。
 *  - 还有一条属于**实现选择**而非 k6 行为：runtime 会把 `form` 与 `timeoutMs`/`maxBytes`
 *    一起带出来，而 `sendFor` 只把 `form` 编码进 payload、把 timeout 放进 params，
 *    所以 `maxBytes` 在 k6 侧没有出口（`emit-k6.ts` 文件头第 2 条就是这件事）。
 *    本文件因此**不断言** maxBytes 两边一致 —— 断言一个已知没接的字段为"一致"，
 *    就是把 docs/08 §3(f)（有载体、没有生产者）用测试固化成"看起来有生产者"。
 *
 * ## 与 `load-parity.test.ts` 的分工
 * 那份比**两个调度器**（函数层）：同一份计划下它们各自构造出的请求。
 * 这份比**两个后端**（产物层）：中间隔着序列化成一整份文件的这段文本、
 * 一次真实的 ESM import、以及脚本自己那几段适配器代码。
 * "非空自检先行"那条守法在这里照用，理由见 `load-parity.test.ts` 文件头
 * （"两边相同"在两边都是空数组时成立）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { defineScenario, secretEnvKey, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';
import { deterministicClock } from '@atest/engine';
import { compileLoadPlan, type LoadDocLookup, type LoadPlan } from '../src/load/plan.js';
import { renderK6Script } from '../src/load/emit-k6.js';
import { PRELUDE_FILE } from '../src/load/prelude.js';
import { newLoadState, walkAsyncBuiltin, type RawResponse } from '../src/load/runtime.js';
import * as loadEntry from '../src/load-entry.js';
// @ts-expect-error 这个工具没有 .d.ts —— allowJs 开着，所以只缺声明而用法本身是查过的
import { buildK6Prelude } from '../../../tooling/build-k6-prelude.mjs';

const b = (id: string) => ({ id });
const LOAD = { vus: 3, durationMs: 60_000 };
const OPTS = { baseUrl: 'http://sut.test', ...LOAD };

const scen = (body: StepDraft[], extra: Record<string, unknown> = {}): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.k6', name: 'k6 emit', env: { environmentRef: 'unit' },
    load: LOAD, body, ...extra,
  } as unknown as ScenarioDraft);

const lookup: LoadDocLookup = { operation: async () => undefined };

/** 两个后端共用的响应夹具：喂同一个，比对才只反映请求侧的差异 */
const RESP_BODY = '{"id":"X1"}';

const tmp = await mkdtemp(join(tmpdir(), 'atest-k6-'));
after(async () => { await rm(tmp, { recursive: true, force: true }); });

/**
 * 在临时目录里摆一个能解析 `k6` / `k6/http` / `k6/execution` 的最小环境，
 * 并把**现打的**预lude 放进同目录（脚本 import 的是 `./${PRELUDE_FILE}`）。
 *
 * 垫片记录请求而不是发请求：本文件要比的是"脚本让我们发什么"。
 * `globalThis.__ENV__` 是 `k6/execution` 那个垫片读的 `__ENV` 的来源 —— 真实 k6 里
 * 它由进程环境注入，这里由测试给。**这是垫片与真 k6 的已知差异**，所以本文件只用它
 * 验"密钥从环境读、不进文件"，不验 k6 的注入时机。
 *
 * 放进去的那份记了 hash，`runEmitted` 每次跑之前重读磁盘比一次 ——
 * 否则本文件验的是"上一次 npm run build 留下的那份预lude"而不是"当前 src 编出来的那份"，
 * 而"dist 是旧的而 CI 照绿"正是本仓那一族缺陷（.gitignore 里讲 dist 的那段）。
 */
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

let runnerRoot: string;
let preludeSha: string;
before(async () => {
  const root = join(tmp, 'runner');
  const pkg = join(root, 'node_modules', 'k6');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), '{"name":"k6","type":"module","exports":{".":"./index.js","./http":"./http.js","./execution":"./execution.js"}}');
  // 参数**个数**也要记：sendFor 多传一个第 5 个参数、或者把 payload 与 params 传反，
  // 只看前四个字段是看不出来的。用 rest 参数而不是 `arguments` —— ESM 模块顶层
  // 压根没有 `arguments` 绑定，箭头函数里一读就 ReferenceError
  // （本文件第一版就是写 `arguments.length`，症状是"setup 一次都没跑"，
  // 看着像被测代码坏了，而坏的是垫片自己 —— 所以这一句写在这里）。
  await writeFile(join(pkg, 'http.js'), [
    'export default {',
    '  request: (...args) => {',
    '    const [method, url, payload, params] = args;',
    '    (globalThis.__k6Reqs ||= []).push({',
    '      method, url, payload, params, argc: args.length,',
    '      headerNames: Object.keys((params && params.headers) || {}).map((s) => String(s).toLowerCase()),',
    '    });',
    '    const st = Number(globalThis.__k6Status ?? 200);',
    '    return { status: st, headers: { \'content-type\': \'application/json\' }, body: globalThis.__k6Body ?? ' + JSON.stringify(RESP_BODY) + ' };',
    '  },',
    '};',
  ].join('\n'));
  await writeFile(join(pkg, 'index.js'), 'export function sleep(s) { (globalThis.__k6Sleeps ||= []).push(s); }\n');
  await writeFile(join(pkg, 'execution.js'), 'export const __ENV = globalThis.__ENV__ ?? {};\n');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  // 真预lude：**现打、且不落盘**（`write:false`），直接写进垫片目录。
  // 不写 dist 有两个理由：(1) 测试不该改仓库里的构建产物；(2) 若写了，
  // `tooling/test/k6-prelude.test.mjs` 那条"先读 dist 再现打"的判据就会在本文件
  // 与它并发时被本文件覆盖掉 —— 两条测试抢同一个文件是假绿的来源。
  const built = await buildK6Prelude({ write: false });
  const bytes = built.code.toString('utf8');
  await writeFile(join(root, PRELUDE_FILE), bytes);
  preludeSha = hash(bytes);
  runnerRoot = root;
});

interface EmittedReq {
  method: string; url: string; payload: string | null; argc: number;
  headerNames: string[];
  params?: { headers?: Record<string, string>; tags?: Record<string, string>; timeout?: number; redirects?: number; retries?: number };
}

/**
 * 内置侧的 `BuiltRequest` -> 与垫片那一边同一个"payload"形状。
 *
 * runtime 把表单留在 `form` 这个**字段**里（两个后端各自决定怎么编码：内置侧交给
 * `HttpExec`，k6 侧是 `encodeForm`），所以"payload"这一列要由每个后端各自的编码结果来填，
 * 不能在比对前把它统一成 `body` —— 统一成 `body` 会让表单那一格恒为 `null vs null`，
 * 看着像"两边都不发体"而其实一边发了编码后的表单。表单的**内容**一致性由
 * `load-parity.test.ts` 直接比 `form` 字段（那里比的是构造，不需要编码）。
 */
function payloadOf(r: { body?: string; form?: Record<string, string> }): string | null {
  if (r.form) return Object.keys(r.form).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(r.form?.[k] ?? '')}`).join('&');
  return r.body ?? null;
}

/** 把脚本落到垫片目录里跑一次（默认导出 + teardown，若有），返回记录下来的请求与副作用 */
async function runEmitted(
  script: string, tag: string, env: Record<string, string> = {}, opts: { status?: number } = {},
): Promise<{ reqs: EmittedReq[]; sleeps: number[]; options: Record<string, unknown>; threw: boolean }> {
  assert.equal(hash(readFileSync(join(runnerRoot, PRELUDE_FILE), 'utf8')), preludeSha,
    '垫片目录里那份预lude 在本次运行中被换掉了（并发跑坏了？先怀疑测试自己）');
  const file = join(runnerRoot, `${tag}.mjs`);
  await writeFile(file, script);
  const code = [
    'globalThis.__k6Reqs = []; globalThis.__k6Sleeps = [];',
    `globalThis.__ENV__ = ${JSON.stringify(env)};`,
    opts.status !== undefined ? `globalThis.__k6Status = ${opts.status};` : '',
    `const m = await import(${JSON.stringify(pathToFileURL(file).href)});`,
    'globalThis.__r = { threw: false };',
    'try { await m.default(); } catch (e) { globalThis.__r.threw = true; globalThis.__r.msg = String((e && e.message) || e); }',
    // 抛了就不跑 teardown：真实 k6 里压测失败也会跑 teardown，但那些用例只关心
    // "抛没抛"，把 teardown 也跑进去会让"发出去的请求"那一列混进收尾的请求，
    // 而那一列同时被逐字节比对用着（teardown 自己的处置见它自己那条测试）
    'if (!globalThis.__r.threw && m.teardown) { await m.teardown(); }',
    'globalThis.__r.reqs = globalThis.__k6Reqs; globalThis.__r.sleeps = globalThis.__k6Sleeps; globalThis.__r.options = m.options;',
    'process.stdout.write("\\u0000" + JSON.stringify(globalThis.__r));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: runnerRoot });
  const at = r.stdout.indexOf('\x00');
  if (at < 0) {
    // 把子进程 stderr 带进断言消息：脚本里的错在父进程这边只剩"退出码 1"，
    // 而这一族的整个痛点就是"脚本文本错了而没人看得见"
    assert.fail(`生成的 k6 脚本跑失败了（${tag}）：\n${(r.stderr || r.stdout).slice(-2500)}`);
  }
  return JSON.parse(r.stdout.slice(at + 1)) as { reqs: EmittedReq[]; sleeps: number[]; options: Record<string, unknown>; threw: boolean };
}

/**
 * 在**同一个** VU 进程里连跑 N 轮默认导出，返回每轮发出的 URL。
 *
 * 为什么单独一个跑多轮的入口：`runEmitted` 每次是一个新进程，那验的是"单轮自洽"；
 * 而"上一轮的状态漏没漏到下一轮"这个性质**只在同一进程的第二轮**才存在。
 * 任何一轮抛了就当作红（那些处置各有自己的测试），这里只关心跑完之后的 URL 序列。
 */
async function runRounds(script: string, tag: string, rounds: number): Promise<string[]> {
  const file = join(runnerRoot, `${tag}.mjs`);
  await writeFile(file, script);
  const code = [
    'globalThis.__k6Reqs = [];',
    `const m = await import(${JSON.stringify(pathToFileURL(file).href)});`,
    'const per = [];',
    `for (let i = 0; i < ${rounds}; i++) { const n0 = globalThis.__k6Reqs.length; await m.default(); per.push(globalThis.__k6Reqs.slice(n0).map((r) => r.url)); }`,
    'process.stdout.write("\\u0000" + JSON.stringify(per));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: runnerRoot });
  const at = r.stdout.indexOf('\x00');
  assert.ok(at >= 0, `${tag}：跑不到 ${rounds} 轮（某一轮抛了）：${r.stderr.slice(0, 900)}`);
  const per = JSON.parse(r.stdout.slice(at + 1)) as string[][];
  assert.equal(per.length, rounds, `只跑了 ${per.length} 轮`);
  return per.flat();
}

/** 内置后端那一边：同一份计划走 walkAsyncBuiltin，记录成与垫片**同一个形状** */
async function runBuiltin(plan: LoadPlan): Promise<Array<{ stepId: string; method: string; url: string; payload: string | null; headerNames: string[]; argc: number }>> {
  const clock = deterministicClock(7);
  const st = newLoadState({}, { baseUrl: OPTS.baseUrl }, plan.inputDefs, clock);
  const out: Array<{ stepId: string; method: string; url: string; payload: string | null; headerNames: string[]; argc: number }> = [];
  await walkAsyncBuiltin(plan.nodes, st, { clock, baseUrl: OPTS.baseUrl, auth: () => {} }, async (r) => {
    out.push({ stepId: r.stepId, method: r.method, url: r.url, payload: payloadOf(r), headerNames: Object.keys(r.headers).map((s) => String(s).toLowerCase()), argc: 4 });
    return { status: 200, headers: { 'content-type': 'application/json' }, bodyText: RESP_BODY, ms: 1 } satisfies RawResponse;
  });
  return out;
}

const BODY: StepDraft[] = [
  { ...b('s'), kind: 'set', assign: { mode: 'a' } },
  { ...b('q'), kind: 'http', request: { method: 'GET', url: '/orders', query: { tag: { expr: '"t"' } } } },
  { ...b('a'), kind: 'assert', against: '$.step.q.resp', status: 200, jsonPath: { '$.id': { notNull: true } } },
];

describe('生成的脚本：import 的符号必须在真预lude 里存在（不需要 k6）', () => {
  test('脚本里从预lude import 的每一个符号都是 load-entry 的真导出', async () => {
    const script = renderK6Script(await compileLoadPlan(scen(BODY), lookup), OPTS);
    const m = /import \{([^}]+)\} from '\.\/([^']+)';/.exec(script);
    assert.ok(m, '找不到那行 import —— emitter 改句式了？那就把这里的取法一起改（别放宽判据）');
    const names = (m[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    assert.equal(m[2], PRELUDE_FILE, '脚本 import 的文件名与 prelude.ts 里那个常量不一致 —— 坏法是 k6 起不来');
    assert.ok(names.length >= 3, `只取出 ${names.length} 个符号，先怀疑取法`);
    for (const n of names) {
      assert.ok(n in loadEntry, `脚本 import 了 ${n}，而 load-entry 没有这个导出`);
    }
  });

  test('反向：load-entry 也没有**多余的**导出（多余 = 看起来接好了而没人用）', () => {
    assert.deepEqual(Object.keys(loadEntry).sort(), ['newLoadState', 'secretFromEnv', 'walkSyncK6']);
  });

  test('k6 自己的三个 import 句式正确（k6 / k6/http / k6/execution）', () => {
    const script = renderK6Script({ scenarioId: 's', nodes: [], setup: [], teardown: [], inputDefs: [], dynamicIterations: false, staticOps: 0 }, { baseUrl: 'http://x' });
    assert.match(script, /import k6http from 'k6\/http';/);
    assert.match(script, /import \{ sleep \} from 'k6';/);
    assert.match(script, /import \{ __ENV \} from 'k6\/execution';/);
  });

  test('脚本里**只** import 这四家（多一家就是多一个 k6 运行时里没有的依赖）', () => {
    const script = renderK6Script({ scenarioId: 's', nodes: [], setup: [], teardown: [], inputDefs: [], dynamicIterations: false, staticOps: 0 }, { baseUrl: 'http://x' });
    const specs = [...script.matchAll(/from\s+'([^']+)'/g)].map((x) => x[1] ?? '').sort();
    assert.deepEqual(specs, [`./${PRELUDE_FILE}`, 'k6', 'k6/execution', 'k6/http']);
  });
});

describe('生成的脚本：文法与内容', () => {
  test('node --check 过（文法合法），且注释行里没有反引号', async () => {
    // 反引号那一格是真红过的：emitter 用模板字符串生成文本，注释里写反引号
    // 会**提前终止**那个模板串，症状是 tsc 报一串看不懂的语法错。
    const plan = await compileLoadPlan(scen(BODY, { setup: [{ ...b('login'), kind: 'http', request: { method: 'POST', url: '/login' } }] }), lookup);
    const script = renderK6Script(plan, OPTS);
    const f = join(tmp, 'syntax-check.mjs');
    await writeFile(f, script);
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `文法不过：\n${r.stderr.slice(0, 1500)}`);
    for (const line of script.split('\n').filter((l) => l.trimStart().startsWith('//'))) {
      assert.ok(!line.includes('`'), `注释行里有反引号（会终止生成器那个模板串）：${line}`);
    }
  });

  test('输出是确定性的（同样的计划 + 选项 => 同样的字节）', async () => {
    const plan = await compileLoadPlan(scen(BODY), lookup);
    assert.equal(renderK6Script(plan, OPTS), renderK6Script(plan, OPTS),
      '不确定性的产物每次都产生一次 diff，没法进版本库也没法比对');
  });

  test('options 里有 vus/duration，throw 为 false（跑一遍脚本才拿得到）', async () => {
    const { options } = await runEmitted(
      renderK6Script(await compileLoadPlan(scen(BODY), lookup), { baseUrl: 'http://x', vus: 7, durationMs: 30_000 }),
      'opts',
    );
    assert.equal(options.vus, 7);
    assert.equal(options.duration, '30s');
    assert.equal(options.throw, false, 'throw:true 会让 k6 在第一个非 2xx 就中止整场压测，而 5xx 是错误率本身');
  });

  test('给了基线阈值时，阈值只打在 **iter** 那一子集上（setup 的登录不该决定 p95）', async () => {
    const script = renderK6Script(await compileLoadPlan(scen(BODY), lookup), {
      ...OPTS, thresholds: { maxP95Ms: 400, maxFailRate: 0.02 },
    });
    // 从**跑出来的 options** 里取，而不是拿正则扫文本：文本里键与值分行写，
    // 逐行扫会得到"值那一行没有 atest_phase"这种假红（本文件第一版就是这么红的）。
    const { options } = await runEmitted(script, 'thresholds');
    const th = options.thresholds as Record<string, string[]>;
    assert.deepEqual(Object.keys(th).sort(), ['http_req_duration{atest_phase:iter}', 'http_req_failed{atest_phase:iter}'],
      `阈值没有限定在 iter 子集上：${JSON.stringify(th)}`);
    assert.deepEqual(th['http_req_duration{atest_phase:iter}'], ['p(95)<400']);
    assert.deepEqual(th['http_req_failed{atest_phase:iter}'], ['rate<0.02']);
  });

  test('没给阈值时**不写** thresholds（凭空造一条没人批准的判据比不判更坏）', async () => {
    const { options } = await runEmitted(
      renderK6Script({ scenarioId: 's', nodes: [], setup: [], teardown: [], inputDefs: [], dynamicIterations: false, staticOps: 0 }, { baseUrl: 'http://x' }),
      'no-thresholds',
    );
    // `options.thresholds` 而不是"文本里搜 thresholds"：文本里有注释提到这个词，
    // 搜文本的那条会在**没写阈值**时假红（第一版就红在这儿）。
    assert.equal(options.thresholds, undefined, `没给基线也在 options 里写了阈值：${JSON.stringify(options.thresholds)}`);
  });

  test('施压模型那句话在头部（闭合模型的 rps 会随系统变慢而下降，报告口径不同）', () => {
    assert.match(renderK6Script({ scenarioId: 's', nodes: [], setup: [], teardown: [], inputDefs: [], dynamicIterations: false, staticOps: 0 }, { baseUrl: 'http://x' }), /闭合模型/);
  });
});

describe('生成的脚本：真跑一遍（垫片 + 现打的预lude）', () => {
  test('跑一遍默认导出，发出的请求与内置后端逐个相同（非空自检先行）', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('s'), kind: 'set', assign: { mode: 'a', rows: ['x', 'y'] } },
      { ...b('q'), kind: 'http', request: { method: 'POST', url: '/orders?keep=1', query: { tag: { expr: '"t" + 1' }, ids: [1, 2] }, headers: { 'x-m': { path: '$mode' } }, body: { n: { expr: '2 * 3' } } } },
      { ...b('formy'), kind: 'http', request: { method: 'POST', url: '/login', formData: { user: 'a b&c', pass: { expr: '"p" + (2 + 3)' }, n: { expr: '2 * 3' } } } },
      { ...b('fe'), kind: 'forEach', items: '$rows', as: 'r', steps: [{ ...b('fq'), kind: 'http', request: { method: 'GET', url: '/row', query: { r: { path: '$r' } } } }] },
    ]), lookup);
    const { reqs, threw } = await runEmitted(renderK6Script(plan, OPTS), 'parity-e2e');
    assert.equal(threw, false);
    assert.ok(reqs.length >= 4, `脚本只发出了 ${reqs.length} 个请求（非空自检）`);
    const builtin = await runBuiltin(plan);
    assert.ok(builtin.length >= 4, `内置侧只发了 ${builtin.length} 个请求`);
    // 比的是**步骤顺序 + 方法 + 完整 URL + 体 + 头名集合 + 调用形状**
    assert.deepEqual(
      reqs.map((r) => ({ method: r.method, url: r.url, payload: r.payload, headerNames: r.headerNames, argc: r.argc })),
      builtin.map(({ stepId: _s, ...rest }) => rest),
      'k6 脚本与内置后端对同一份计划发出了不同的请求（换后端 = 换用例）',
    );
    // 再钉几个**具体**结论：两边一致而都错也是一种通过
    const q = reqs.find((r) => r.url.includes('/orders'));
    assert.match(q?.url ?? '', /ids=1/);
    assert.match(q?.url ?? '', /ids=2/);
    assert.ok(!(q?.url ?? '').includes('%5B'), `数组被压成一个文本了：${q?.url}`);
    assert.equal(q?.payload, '{"n":6}');
    // 表单编码两边同一个口径，且**逐字段转义**（空格与 `&` 不转义会把一个字段拆成两个）
    assert.equal(reqs.find((r) => r.url.includes('/login'))?.payload, 'user=a%20b%26c&pass=p5&n=6',
      '表单没按 x-www-form-urlencoded 逐字段转义');
    assert.deepEqual(reqs.filter((r) => r.url.includes('/row')).map((r) => r.url), ['http://sut.test/row?r=x', 'http://sut.test/row?r=y']);
    assert.ok(reqs.every((r) => r.argc === 4), `调用 k6http.request 的形状变了：${reqs.map((r) => r.argc)}`);
  });

  test('每个请求带 retries: 0（压测里重试会把一次故障算成两次负载）', async () => {
    const { reqs } = await runEmitted(renderK6Script(await compileLoadPlan(scen(BODY), lookup), OPTS), 'no-retry');
    assert.ok(reqs.length >= 1);
    for (const r of reqs) {
      assert.equal(r.params?.retries, 0, `${r.url} 的重试次数不是 0`);
    }
  });

  test('setup 只跑一次，而 setup 的请求带着 setup 标签（不进 iter 的指标）', async () => {
    const plan = await compileLoadPlan(scen(BODY, { setup: [{ ...b('login'), kind: 'http', request: { method: 'POST', url: '/login' } }] }), lookup);
    const { reqs } = await runEmitted(renderK6Script(plan, OPTS), 'setup-once');
    const logins = reqs.filter((r) => r.url.includes('/login'));
    assert.equal(logins.length, 1, '默认导出跑一次时 setup 应只跑一次');
    assert.equal(logins[0]?.params?.tags?.atest_phase, 'setup');
    assert.equal(reqs.find((r) => r.url.includes('/orders'))?.params?.tags?.atest_phase, 'iter');
  });

  test('第二次调默认导出**不**重跑 setup（懒门闩；重跑会把登录打进压测曲线里）', async () => {
    const plan = await compileLoadPlan(scen(BODY, { setup: [{ ...b('login'), kind: 'http', request: { method: 'POST', url: '/login' } }] }), lookup);
    const urls = await runRounds(renderK6Script(plan, OPTS), 'latch', 3);
    const logins = urls.filter((u) => u.includes('/login'));
    assert.equal(logins.length, 1, `三轮迭代跑了 ${logins.length} 次 setup：${logins.join(' | ')}`);
    // 反向：迭代正文确实跑了三轮（否则"只跑一次 setup"可以靠"只跑了一轮"通过）
    assert.equal(urls.filter((u) => u.includes('/orders')).length, 3, '迭代正文没跑满三轮');
  });

  test('setup 定下的变量**不被**每轮的裁剪吃掉（差集裁剪而不是清表）', async () => {
    // 判据走 `{path:'$token'}`：未定义引用会抛（resolveValue 那一句），
    // 于是"清表"那种实现的后果是**第一轮就抛** —— 正是可观察的形状。
    const plan = await compileLoadPlan(scen(
      [{ ...b('q'), kind: 'http', request: { method: 'GET', url: '/x', query: { tok: { path: '$token' } } } }],
      { setup: [{ ...b('st'), kind: 'set', assign: { token: 'T7' } }] },
    ), lookup);
    const urls = await runRounds(renderK6Script(plan, OPTS), 'prune-setup', 2);
    assert.deepEqual(urls, ['http://sut.test/x?tok=T7', 'http://sut.test/x?tok=T7'],
      'setup 定下的变量被每轮开头的裁剪吃掉了（那等于每轮重新登录一次）');
  });

  test('迭代里 set 出来的名字**会被**下一轮裁掉（真实用户每轮都是新会话）', async () => {
    /*
     * 形状是"分支在前、set 在后"：第一轮那个名字还不存在 => 走 clean 那一支，
     * 第二轮如果上一轮的状态漏进来 => 走 leaked 那一支。
     * 用**分支**而不是把值拼进 query，是因为这条测试的两种结局必须都是"跑完了"：
     * 拿 `{path}` 读一个还不存在的名字会抛，那样第一轮的失败会把我想看的第二轮盖掉
     * （`.scratch/probe-prune2.mts` 量的：这个形状两种结局都能编出来也都能跑完）。
     */
    const plan = await compileLoadPlan(scen([
      { ...b('g'), kind: 'if', condition: '$leak', then: [{ ...b('lk'), kind: 'http', request: { method: 'GET', url: '/leaked' } }], else: [{ ...b('cl'), kind: 'http', request: { method: 'GET', url: '/clean' } }] },
      { ...b('s'), kind: 'set', assign: { leak: 'STALE' } },
    ]), lookup);
    const urls = await runRounds(renderK6Script(plan, OPTS), 'prune-local', 3);
    assert.deepEqual(urls, Array(3).fill('http://sut.test/clean'),
      '上一轮 set 出来的名字漏进了下一轮（下一轮于是跑在上一轮的状态上）');
  });

  test('迭代里的步骤没过时默认导出**抛**（k6 靠这个记 http_req_failed），而 setup 没过也抛', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('q'), kind: 'http', request: { method: 'GET', url: '/x' } },
      { ...b('a'), kind: 'assert', against: '$.step.q.resp', status: 200 },
    ]), lookup);
    const { threw, reqs } = await runEmitted(renderK6Script(plan, OPTS), 'iter-fail', {}, { status: 503 });
    assert.equal(threw, true, '503 时脚本该抛（否则错误率漏计）');
    assert.equal(reqs.length, 1, '抛之前那一个请求该已经发出去了');

    const withSetup = await compileLoadPlan(scen(BODY, { setup: [{ ...b('login'), kind: 'http', request: { method: 'POST', url: '/login' } }] }), lookup);
    const s = await runEmitted(renderK6Script(withSetup, OPTS), 'setup-fail', {}, { status: 503 });
    assert.equal(s.threw, true, 'setup 没过时必须抛，否则后面的迭代全打在没登录的状态上');
    assert.ok(!s.reqs.some((r) => r.url.includes('/orders')), 'setup 没过就不该继续跑迭代正文');
  });

  test('上一轮抛过不影响这一轮（failed 每轮清一次；不清会让一个 VU 从此全抛）', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('q'), kind: 'http', request: { method: 'GET', url: '/x' } },
      { ...b('a'), kind: 'assert', against: '$.step.q.resp', status: 200 },
    ]), lookup);
    const script = renderK6Script(plan, OPTS);
    const f = join(runnerRoot, 'failed-reset.mjs');
    await writeFile(f, script);
    const code = [
      'globalThis.__k6Reqs = []; globalThis.__k6Status = 503;',
      `const m = await import(${JSON.stringify(pathToFileURL(f).href)});`,
      'const run = async () => { try { await m.default(); return "ok"; } catch { return "threw"; } };',
      'const first = await run();',
      'globalThis.__k6Status = 200;',
      'const second = await run();',
      'process.stdout.write("\\u0000" + JSON.stringify([first, second, globalThis.__k6Reqs.length]));',
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: runnerRoot });
    const at = r.stdout.indexOf('\x00');
    assert.ok(at >= 0, `跑失败了：${r.stderr.slice(0, 800)}`);
    const [first, second, n] = JSON.parse(r.stdout.slice(at + 1)) as [string, string, number];
    assert.deepEqual([first, second, n], ['threw', 'ok', 2], '上一轮的 failed 漏到了这一轮（或这一轮压根没发请求）');
  });

  test('teardown 重跑 setup 再清（k6 的全局 teardown 手上没有状态），且只跑一次', async () => {
    const plan = await compileLoadPlan(scen(
      [{ ...b('q'), kind: 'http', request: { method: 'GET', url: '/orders' } }],
      {
        setup: [{ ...b('login'), kind: 'http', request: { method: 'POST', url: '/login' } }],
        teardown: [{ ...b('del'), kind: 'http', request: { method: 'DELETE', url: '/orders/A1' } }],
      },
    ), lookup);
    const { reqs } = await runEmitted(renderK6Script(plan, OPTS), 'teardown-once');
    const dels = reqs.filter((r) => r.url.includes('/orders/A1'));
    assert.equal(dels.length, 1);
    assert.equal(dels[0]?.params?.tags?.atest_phase, 'teardown');
    // 那句 ⚠ 必须在（两个后端的清理次数不同，不许悄悄发生）
    assert.match(renderK6Script(plan, OPTS), /内置后端是每个 VU 一次/);
  });

  test('没有 teardown 的场景**不导出** teardown，也不带那句 ⚠', async () => {
    const script = renderK6Script(await compileLoadPlan(scen(BODY), lookup), OPTS);
    assert.ok(!script.includes('export function teardown'), '没有 teardown 步骤却导出了 teardown');
    assert.ok(!script.includes('内置后端是每个 VU 一次'), '没有 teardown 却带了那句警告（噪音会让人开始跳过文件头）');
  });

  test('thinkMs > 0 时调 k6 的 sleep（单位是秒），为 0 时**不**睡', async () => {
    const withThink = await runEmitted(renderK6Script(await compileLoadPlan(scen(BODY), lookup), { ...OPTS, thinkMs: 250 }), 'think');
    assert.deepEqual(withThink.sleeps, [0.25], `thinkMs=250 应 sleep 0.25 秒（k6 的 sleep 单位是秒）`);
    const noThink = await runEmitted(renderK6Script(await compileLoadPlan(scen(BODY), lookup), OPTS), 'no-think');
    assert.deepEqual(noThink.sleeps, [], '没写 thinkMs 也睡了（每轮白等一次会压低 rps 读数）');
  });

  test('密钥：文件里只有引用名；缺环境变量时**不发**无鉴权请求以外的东西', async () => {
    const SECRET = 'sk-SECRET-DO-NOT-LEAK-9137';
    const ref = 'api_token';
    const plan = await compileLoadPlan(scen([
      { ...b('q'), kind: 'http', request: { method: 'GET', url: '/me' }, auth: `secret:${ref}` },
    ]), lookup);
    const script = renderK6Script(plan, OPTS);
    // 1) 生成的字节里没有真值
    assert.ok(!script.includes(SECRET), '真密钥出现在生成的脚本里');
    // 注：这里**不**断言"脚本里没有 Bearer 这句话"。`Bearer ` 那段是 k6 侧鉴权
    // 回调的实现本身（k6 里没有 applyAuth，它必须自己把 ref 变成头），
    // 把它当成"硬编码鉴权方案"报红是我第一版的误判 —— 真正要钉的是"真值不进文件"
    // 与"缺密钥时不发带鉴权头的请求"，两条都在下面，且都是可观察的。
    // 2) 没给环境变量：请求照发，但**不带** authorization 头（发一个 `Bearer undefined`
    //    比不发更难查 —— 后端看到的是格式错的凭据，报 401 而不是"没配密钥"）
    const noEnv = await runEmitted(script, 'secret-missing', {});
    assert.equal(noEnv.reqs.length, 1, '缺密钥这一格不能靠"一个请求都不发"通过（那与 takeSync 那种全绿同形）');
    assert.ok(!noEnv.reqs[0]?.headerNames.includes('authorization'), `缺密钥时发出了带鉴权头的请求：${JSON.stringify(noEnv.reqs[0]?.params?.headers)}`);
    // 3) 给了环境变量：真值进请求头 —— 证明"从环境读"这条路是通的
    const key = secretEnvKey(`secret:${ref}`);
    assert.equal(key, 'ATEST_SECRET_API_TOKEN', '环境变量名与 IR 侧那份规矩不一致（报错会让人去设一个设了也不生效的变量）');
    const withEnv = await runEmitted(script, 'secret-present', { [key]: SECRET });
    assert.equal(withEnv.reqs[0]?.params?.headers?.authorization, `Bearer ${SECRET}`);
    // 4) 跑完再看一遍文件：执行不会把真值写回文件
    assert.ok(!readFileSync(join(runnerRoot, 'secret-present.mjs'), 'utf8').includes(SECRET));
  });

  test('传输层失败也记一条观测（status 0）并让这一轮抛，而不是让错误率漏计', async () => {
    const plan = await compileLoadPlan(scen([
      { ...b('q'), kind: 'http', request: { method: 'GET', url: '/x' } },
      { ...b('after'), kind: 'http', request: { method: 'GET', url: '/after' } },
    ]), lookup);
    const script = renderK6Script(plan, OPTS);
    const f = join(runnerRoot, 'transport.mjs');
    await writeFile(f, script);
    const code = [
      'globalThis.__k6Reqs = [];',
      `const m = await import(${JSON.stringify(pathToFileURL(f).href)});`,
      'const mod = await import(' + JSON.stringify(pathToFileURL(join(runnerRoot, 'node_modules', 'k6', 'http.js')).href) + ');',
      // 让第一个请求抛（连不上），第二个照旧
      'const orig = mod.default.request; let n = 0;',
      'mod.default.request = (...a) => { n++; if (n === 1) throw new Error("connect ECONNREFUSED"); return orig(...a); };',
      'globalThis.__r = { threw: false };',
      'try { await m.default(); } catch { globalThis.__r.threw = true; }',
      'process.stdout.write("\\u0000" + JSON.stringify(globalThis.__r));',
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: runnerRoot });
    const at = r.stdout.indexOf('\x00');
    assert.ok(at >= 0, `跑失败了：${r.stderr.slice(0, 800)}`);
    const out = JSON.parse(r.stdout.slice(at + 1)) as { threw: boolean };
    assert.equal(out.threw, true, '连不上时这一轮该抛（否则错误率漏计 = 曲线看起来比真相好）');
  });

  test('脚本里不出现绝对路径（生成物可能进 CI 日志或被贴进工单）', () => {
    const script = renderK6Script({ scenarioId: 's', nodes: [], setup: [], teardown: [], inputDefs: [], dynamicIterations: false, staticOps: 0 }, { baseUrl: 'http://x' });
    assert.ok(!script.includes(tmp), '生成的脚本里出现了本次运行的临时目录绝对路径');
    assert.ok(!/\/Users\/|\/home\/[a-z]/.test(script), '脚本里出现了疑似本机绝对路径');
  });
});

describe('垫片脚下那份预lude 能用', () => {
  test('它确实导出脚本 import 的那三个符号（打包配置漏一个也是"k6 起不来"）', async () => {
    // 从**垫片目录里那份**（本文件 before 里现打的、不落 dist 的那份）import。
    // 与 `tooling/test/k6-prelude.test.mjs` 的分工：那边管"dist 里那份是不是旧的"，
    // 这里只管"我脚下这份能不能用"。两条都从 dist import 的话，dist 是旧的时
    // 两条一起绿，而"旧产物能用"不是这一条要问的问题。
    // 本文件**不**再验 dist 的新鲜度：那需要往 dist 写，而测试改仓库构建产物
    // 会把上面那条分工里的判据自己冲掉（两条测试抢同一个文件 = 假绿的新来源）。
    const mod = await import(pathToFileURL(join(runnerRoot, PRELUDE_FILE)).href);
    const names = Object.keys(mod).sort();
    assert.deepEqual(names, Object.keys(loadEntry).sort(),
      `预lude 的导出与 load-entry 不一致：${JSON.stringify({ inBundle: names, inEntry: Object.keys(loadEntry).sort() })}`);
  });
});
