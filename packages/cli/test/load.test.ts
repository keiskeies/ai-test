/**
 * `atest load` 的判据 + 一次真通电。
 *
 * ## 为什么分两半，而且两半都不能省
 * 前半是**纯函数**（门禁为什么红、这次能不能当基线、两次跑能不能比）。
 * 后半是**一次真命令**：`main(['load', …])` 打真 mock、看真退出码、读真磁盘。
 * 只写前半会漏掉本仓反复出现的那一族 —— 判据全对而**没人把它们接上**：
 * `press` / `measuredLoad` / `compileLoadPlan` / `renderK6Script` 四个导出
 * 在被这条命令接上之前就是 dead export（`npm run lint` 的 dead-exports 当场点名），
 * 而它们的单测**早就全绿**。绿的是函数，不是那条链路。
 *
 * ## 断言的偏好：优先断"没做的那件事"
 * "能打出一堆观测"只要 fetch 通就成立，证明不了这条命令做过事。
 * 只有它能给出的证据是**它没做的那件**：
 *  - 有请求失败而门禁判不了时，退出码是 1（产品结论）**不是** 11（去建基线）。
 *    这条是实测出来的：先前这里只看门禁，一场 100% 404 的跑报 11，
 *    而 CI 读 11 的动作是"先建基线" —— 把"产品坏了"读成"缺历史数据"。
 *  - `--runner-spec` 没给就**不压**（退出码 2，一个请求都没发）。猜规格会让两次
 *    不同机器上的压测看起来可比，那正是性能门禁最常见的死法。
 *  - `--clock deterministic` 直接拒。那条路产出的 p50/p95 是 0，而 0 是合法值。
 *  - 覆盖 IR 里的并发数要**大声说出来**（stderr 里必须有那一行）。
 *
 * ## **没有**的一条（写在这里而不是等下一个人去猜）
 * 没有任何一条测"退化 20% 判红"。原因是硬的：`promoteRefused` 与
 * `incomparableReasons` 都看实测窗口，而 `MIN_SAMPLES_MS` 是 30 秒 ——
 * 造一个合格基线要么真压 30 秒（CI 里不划算），要么手写 JSONL 绕开 schema
 * 的口径（那测的是我的抄写能力）。所以 unknown/不可比那两格由**前半的纯函数**覆盖，
 * 端到端只测"没有基线时是 unknown 而不是 pass"。这个缺口登记在 docs/14。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { incomparableReasons, STEP_STATUS, type BaselineSample, type EnvFingerprint, type LoadFingerprint, type LoadProfile } from '@atest/ir';
import { EVIDENCE_FILES, liveClock } from '@atest/engine';
import { readRunMember } from '@atest/store';

import { main } from '../src/main.js';
import { EXIT } from '../src/exit.js';
import { buildEnvFingerprint } from '../src/fingerprint.js';
import { createAbortFlag } from '../src/signals.js';
import {
  LOAD_BACKENDS, loadClockOrRefuse, loadGate, loadOutcome, loadRunStatus, overrideNotice,
  pickLoadBaseline, promoteLoadRefused, runnerSpecHint, runnerSpecOrRefuse, toBaselineSample, withSutDims,
  type LoadRunOutcome,
} from '../src/load.js';
import type { Io } from '../src/commands.js';

// ── 前半：判据 ────────────────────────────────────────────────────────────

const env: EnvFingerprint = buildEnvFingerprint({
  environmentRef: 'unit', env: {}, envRevision: undefined, clock: liveClock(),
});

/** 实测指纹。**故意**与下面 INTENT 的 vus 不同：那是 `--vus` 覆盖后的样子，
 *  任何"从意图里抄值"的实现都会在这一格当场红掉（前版本的 fingerprintOf 就是这么错的） */
const MEASURED: LoadFingerprint = { runnerSpec: '8c16g', runnerCount: 1, vus: 10, connections: 10, durationMs: 45 };

const INTENT: LoadProfile = {
  vus: 100, durationMs: 60_000, rampUpMs: 0, thinkMs: 0, maxRequests: 0, failureStatus: [], maxIterationsPerVu: 0,
};

function outcome(over: Partial<LoadRunOutcome> = {}): LoadRunOutcome {
  return {
    scenarioId: 'scn.g', runId: 'load_1', backend: 'builtin',
    metrics: { p50Ms: 10, p95Ms: 30, p99Ms: 40, rps: 100, errorRate: 0, samples: 500 },
    load: MEASURED, env, runStatus: 'pass', aborted: false, takenAt: 1000,
    modelNote: 'note', iterationsPerVu: [3, 3], failureReasons: [],
    ...over,
  };
}

test('--runner-spec 没给就拒绝，且拒绝的理由里不许有"我帮你探测了一个值"', () => {
  for (const given of [undefined, '', '   ']) {
    const r = runnerSpecOrRefuse(given);
    assert.ok('why' in r, `给了 ${JSON.stringify(given)} 竟然放行了`);
    // 关键不是"有没有报错"，是**报的是什么**：一个 unknown 占位值与报错的差别是
    // "两次都没填的跑互相判为可比"（那是放行，不是拒绝）
    assert.match(r.why, /--runner-spec/);
  }
  assert.deepEqual(runnerSpecOrRefuse(' 8c16g '), { spec: '8c16g' });
  // 提示里给的是"参考形状"，不是能直接抄进 CI 的值 —— 流水线机器是换的
  assert.match(runnerSpecHint(), /不是实时读数/);
});

test('压测只认 live 时钟：deterministic 量出来的是 0，而 0 是合法值', () => {
  assert.deepEqual(loadClockOrRefuse(undefined), { clock: 'live' });
  assert.deepEqual(loadClockOrRefuse('live'), { clock: 'live' });
  for (const bad of ['deterministic', 'D', 'wall']) {
    const r = loadClockOrRefuse(bad);
    assert.ok('why' in r, `${bad} 竟然放行了`);
    // 报错必须把"为什么危险"说清（0 是合法值 -> 门禁一直绿），
    // 只说"不支持"的话，下一个人会当成能力缺口来"顺手补上"
    assert.match(r.why, /合法值|一直绿/);
  }
});

/*
 * 被取消的那一场要说**两件**事，而这两件必须分开。
 *
 * 这一条是**量出来的**，不是想出来的：前版本这里返回单个 `'aborted'`，
 * 于是它进 `manifest.status`、进而进不了前端徽章的白名单（`STEP_OK` 只有 IR 那六态），
 * 落进兜底那一格 => 屏幕上是一个**红色的"执行异常"**。
 * 一场"人按 Ctrl-C 停下来"的压测与"引擎崩了"在运行记录列表里长得一模一样，
 * 而功能那条路上同样被取消的 run 画的是 `pass 已中断`（status 不变、aborted 另有一栏）。
 * 所以两维各归各位：结论照实说（那几百个请求的 8% 失败率是真的），完整与否在 aborted。
 */
test('loadRunStatus：结论与"这一场完整吗"是**两个**字段，取消不许盖过结论', () => {
  const f = { cancelled: false, threw: false, errorRate: 0, failureReasons: [] as string[] };
  assert.deepEqual(loadRunStatus(f), { product: 'pass', aborted: false });
  assert.equal(loadRunStatus({ ...f, errorRate: 0.001 }).product, 'fail', '错误率大于 0 就是失败（断言没过=该次请求失败）');
  assert.equal(loadRunStatus({ ...f, failureReasons: ['HTTP 404'] }).product, 'fail', '错误率被别处吞掉时，失败原因也要能把结论翻红');
  assert.equal(loadRunStatus({ ...f, threw: true }).product, 'error', '施压本身没过 = 前置不成立，被测根本没被压到');
  // threw 排在 errorRate 之前：setup 没过时被测没被压到，报"失败率 100%"是假归因
  assert.equal(loadRunStatus({ ...f, threw: true, errorRate: 1 }).product, 'error');

  // 取消的那一场：**两维同时成立**，谁也不盖谁
  const half = loadRunStatus({ cancelled: true, threw: false, errorRate: 0.08, failureReasons: [] });
  assert.equal(half.aborted, true, '取消没记进 aborted —— 那一场的数字会被当完整压测用');
  assert.equal(half.product, 'fail', '那 8% 的失败是真的产品结论，取消不抹掉它');

  /*
   * **这一条是那次改动的全部理由**，所以它单独断言而不是顺手夹在上面几条里：
   * `product` 必须永远落在 IR 的六态里 —— `manifest.status` 直接写它，
   * 而徽章白名单外的词一律画成红色 error。名单取 `@atest/ir` 的 `STEP_STATUS`
   * 本体（前端徽章用的就是它的副本 `STEP_OK`），不在测试里重述一遍。
   */
  for (const o of [f, { ...f, threw: true }, { cancelled: true, threw: true, errorRate: 0.5, failureReasons: ['x'] }]) {
    const { product } = loadRunStatus(o);
    assert.ok((STEP_STATUS as readonly string[]).includes(product), `${product} 不在 IR 的六态里 —— 徽章会把它画成 error`);
    assert.notEqual(product, 'aborted', 'aborted 又回到结论里了');
  }
});

test('换后端 = 换压法：靠 runnerSpec 那一维走**已有**的可比性判据', () => {
  // 两个后端各自拼出的标签必须不同，否则 incomparableReasons 看不出差别
  const a = withSutDims({ ...MEASURED, runnerSpec: '8c16g (builtin)' }, {});
  const b = withSutDims({ ...MEASURED, runnerSpec: '8c16g (k6)' }, {});
  const why = incomparableReasons(a, b);
  assert.ok(why.some((x) => /施压机规格/.test(x)), `换后端竟然判为可比：${why.join('; ') || '无原因'}`);
  // 名单只有一处（命令侧校验、指纹、报告都读它）
  assert.deepEqual([...LOAD_BACKENDS], ['builtin', 'k6']);
});

test('withSutDims 只追加，绝不重写实测的那几维', () => {
  const out = withSutDims(MEASURED, { dataVolume: 1_000_000, sutInstances: 3, sutSpec: '4c8g' });
  assert.equal(out.vus, 10, '并发被改写了 —— 那就是"第二个指纹合成点"，覆盖并发时门禁会放行');
  assert.equal(out.durationMs, 45, '实测窗口被改写成名义值，被截断的一场就能合法进基线');
  assert.equal(out.dataVolume, 1_000_000);
  assert.equal(out.sutInstances, 3);
  // **没给的键不许写进去**（写 undefined 与不写在 JSON 里等价，但在 incomparableReasons
  // 那一侧不等价：数据量那一维判的是"一边填了一边没填"）
  const bare = withSutDims(MEASURED, {});
  for (const k of ['dataVolume', 'sutInstances', 'sutSpec'] as const) {
    assert.ok(!(k in bare), `${k} 不该出现在没给的指纹里：${JSON.stringify(bare)}`);
  }
});

test('覆盖 IR 里的压法要报警，而且报警的名单跟着 IR 那张表走', () => {
  assert.deepEqual(overrideNotice(INTENT, { vus: 100, durationMs: 60_000 }), [], '没覆盖就不该报警');
  const both = overrideNotice(INTENT, { vus: 10, durationMs: 5000 });
  assert.equal(both.length, 2, both.join('; '));
  assert.ok(both.some((x) => /并发数被覆盖.*100.*10/.test(x)));
  assert.ok(both.some((x) => /时长被覆盖.*60000.*5000/.test(x)));
  // 只覆盖一维时只报一维（两条都报会让人以为命令行传了两个值）
  assert.equal(overrideNotice(INTENT, { vus: 10, durationMs: 60_000 }).length, 1);
});

test('基线**先按场景筛池**：隔壁那条用例的基线不许拿来判这一条', () => {
  const mine = (id: string, scenarioId: string, takenAt: number, pinned = false): BaselineSample => ({
    id, projectId: 'default', scenarioId, targetKey: '', sourceRunId: `run_${id}`,
    metrics: { errorRate: 0, samples: 500, p95Ms: 30 }, runStatus: 'pass',
    env, load: { ...MEASURED, durationMs: 60_000 }, takenAt, pinned,
  });
  const pool = [
    mine('a-new', 'scn.other', 3000),
    mine('b-mine', 'scn.g', 2000),
    mine('c-old', 'scn.g', 1000),
  ];
  const hit = pickLoadBaseline(pool, { scenarioId: 'scn.g', targetKey: '' });
  // 最新的那条属于**别的场景**。不筛池的话 pickBaseline 会挑中它（它的判据与场景无关），
  // 于是"退化 40%"的成因是隔壁那条用例
  assert.equal(hit?.id, 'b-mine', `挑中了 ${hit?.id ?? '无'}`);
  assert.equal(pickLoadBaseline(pool, { scenarioId: 'scn.nope', targetKey: '' }), undefined);
  // 不合格的（短跑）不参与：promoteRefused 看的是样本自己那格的 durationMs
  const short = { ...mine('d-short', 'scn.g', 9000), load: { ...MEASURED, durationMs: 45 } };
  assert.equal(pickLoadBaseline([...pool, short], { scenarioId: 'scn.g', targetKey: '' })?.id, 'b-mine',
    '一场 45ms 的跑当上了基线 —— 筛池那一步没把不合格的筛掉');
});

test('promoteLoadRefused：aborted 补一条，其余判据**不重复**（一个事实一个答案）', () => {
  /*
   * 被取消的**那一场**在这里写成 `runStatus: 'fail' + aborted: true`，
   * 而不是从前那个 `runStatus: 'aborted'`。这一格正好是分开之后最难读的地方：
   * 结论照实（错误率 > 0 是真的），而"不许当基线"这件事由 aborted 那一条补上 ——
   * 注意 `promoteRefused` 本体现在仍然会因为 `runStatus !== 'pass'` 报一句，
   * 那一句的措辞是给 healed/fail 写的（"路径变了""耗时不是正常路径的耗时"），
   * 对被取消的那场只是**碰巧也对**；真正说中下一步动作的是下面补的那条
   * （"重跑一场"，不是"改用例"）。所以两条都在屏幕上，是有意的。
   */
  const o = outcome({ runStatus: 'fail', aborted: true, metrics: { errorRate: 0.08, samples: 500, p95Ms: 30 } });
  const why = promoteLoadRefused(o, toBaselineSample(o));
  // 短跑那一条只能出现**一次**。前版本这里抄了 promoteRefused 已有的两条，
  // 实测打出过"2 条理由"里两句话讲同一件事、其中一个口径还是错的
  const shortLines = why.filter((x) => /30000/.test(x));
  assert.equal(shortLines.length, 1, `短跑那条重复了：${why.join(' | ')}`);
  assert.ok(why.some((x) => /被取消/.test(x)), '被取消这一条必须补上（本体只会拿"只有 pass 能当基线"搪塞）');

  const clean = outcome({ runStatus: 'pass', load: { ...MEASURED, durationMs: 60_000 }, metrics: { errorRate: 0, samples: 500, p95Ms: 30 } });
  assert.deepEqual(promoteLoadRefused(clean, toBaselineSample(clean)), [], `干净的长跑不该被拒：${JSON.stringify(clean.metrics)}`);

  /*
   * **一场"取消了 45 秒"而结论是 pass 的跑**：本体三条判据一条都不响
   * （pass、60_000ms 的实测窗口、有样本），只有这里补的那条拦得住。
   * 这就是"这一条只能由这里补"的全部含义 —— 没有它，被砍断的一场
   * 会直接当上基线，而下一次判退化的基准是"半场的耗时"。
   */
  const halfClean = outcome({ runStatus: 'pass', aborted: true, load: { ...MEASURED, durationMs: 45_000 } });
  assert.ok(promoteLoadRefused(halfClean, toBaselineSample(halfClean)).some((x) => /被取消/.test(x)),
    'pass + 被取消的长跑没被拒 —— 本体看不见"这不是一次完整施压"');

  // healed 永远到不了压测形态，但判据**不许删**（哪天压测接上自愈它就立刻起作用）
  const healed = outcome({ runStatus: 'healed', load: { ...MEASURED, durationMs: 60_000 } });
  assert.ok(promoteLoadRefused(healed, toBaselineSample(healed)).some((x) => /healed/.test(x)),
    'healed 不许当基线那条判据空转了 —— 别删它');
});

test('基线样本的 id 稳定：同一场压测重算两次是覆盖而不是追加', () => {
  const o = outcome();
  assert.equal(toBaselineSample(o).id, toBaselineSample(o).id);
  assert.equal(toBaselineSample(o).pinned, false, '自动产的样本不许自带 pinned（pinned 绕开自动入选条件）');
  assert.equal(toBaselineSample(o, 'GET /orders').targetKey, 'GET /orders');
});

test('没有基线时门禁是 unknown，不是 pass（把没基线判成通过 = 头三个月没有门禁而没人知道）', () => {
  const g = loadGate(outcome(), undefined);
  assert.equal(g.verdict, 'unknown');
  assert.ok(g.unknownWhy, 'unknown 必须带原因，否则 CI 只能看到一个不明的黄灯');
});

test('指纹不同则不可比，且**不许硬算一个退化比例**', () => {
  const base = {
    id: 'b', projectId: 'default', scenarioId: 'scn.g', targetKey: '', sourceRunId: 'run_b',
    metrics: { errorRate: 0, samples: 900, p50Ms: 10, p95Ms: 30, p99Ms: 40, rps: 100 },
    runStatus: 'pass', env, load: { ...MEASURED, vus: 100, durationMs: 60_000 }, takenAt: 1, pinned: true,
  } satisfies BaselineSample;
  const g = loadGate(outcome(), base);
  assert.equal(g.verdict, 'unknown', `并发不同竟然给出了结论：${g.verdict}`);
  assert.deepEqual(g.regressions, {}, '不可比时不许给退化比例 —— 那是"看板说 8%、门禁说 24%"的起点');
  assert.ok(g.reasons.some((x) => /并发数不同/.test(x)), g.reasons.join(' | '));
});

test('loadOutcome 的 vus 来自**实测**那份，不是 IR 意图（覆盖并发时门禁必须看得见）', () => {
  const o = loadOutcome({
    identity: { scenarioId: 'scn.g', runId: 'load_1', env, runnerSpec: '8c16g', now: () => 7 },
    backend: 'builtin', metrics: outcome().metrics, load: MEASURED,
    status: { product: 'pass', aborted: false }, iterationsPerVu: [1], failureReasons: [],
  });
  assert.equal(o.load.vus, 10, '指纹里的并发不是实测值');
  assert.equal(o.load.runnerSpec, '8c16g (builtin)', '后端名没拼进规格 -> 换后端时门禁不响');
  assert.equal(o.takenAt, 7, '时间戳必须由注入的时钟给（测试要能冻结）');
  /*
   * 两维**各归各位**地从同一个入参来。这里单独钉一下形状：
   * `status` 是一个对象而不是 `runStatus` + `aborted` 两个入参，
   * 拆成两个参数就能各取一半，于是同一场压测的"结论"与"完整吗"来自两处。
   */
  const half = loadOutcome({
    identity: { scenarioId: 'scn.g', runId: 'load_1', env, runnerSpec: '8c16g', now: () => 7 },
    backend: 'builtin', metrics: outcome().metrics, load: MEASURED,
    status: { product: 'fail', aborted: true }, iterationsPerVu: [1], failureReasons: ['HTTP 500'],
  });
  assert.equal(half.runStatus, 'fail', '结论被"取消"盖掉了 —— manifest.status 只能写六态，写 aborted 会画成红色 error');
  assert.equal(half.aborted, true, '取消这件事丢了 —— 那半场的读数会被当完整压测用');
});

// ── 后半：一次真通电 ──────────────────────────────────────────────────────

const SPEC = {
  openapi: '3.0.0', info: { title: 'shop', version: '1' },
  paths: {
    '/orders/{id}': {
      get: {
        operationId: 'getOrdersId',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
          },
        },
      },
    },
  },
};

/** 收 stdout/stderr 的 Io（与 e2e.test.ts 同一形状）。
 *  **不给 abortSignal**：那条路是服务端宿主用的（`Io.abortSignal` 的注释），
 *  压测这条命令在 CLI 里只认信号。给了它反而会让 `installCommandSignals`
 *  走"注入那份"的分支，测的就不是人敲的这条路了 */
function ioCapture(): Io & { stdout: string[]; stderr: string[] } {
  const out = { stdout: [] as string[], stderr: [] as string[] };
  return {
    ...out,
    out: (s: string) => { out.stdout.push(s); },
    err: (s: string) => { out.stderr.push(s); },
    get cwd() { return process.cwd(); },
    env: {},
  } as Io & { stdout: string[]; stderr: string[] };
}

async function fixture(): Promise<{ dir: string; specPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'atest-load-'));
  const specPath = join(dir, 'openapi.json');
  await writeFile(specPath, JSON.stringify(SPEC), 'utf8');
  return { dir, specPath };
}

/** 一条压测场景。body 打的是 mock 里**存在**的那个接口 */
async function writeCase(dir: string, name: string, body: unknown[], load: Record<string, unknown>): Promise<string> {
  const p = join(dir, `${name}.json`);
  await writeFile(p, JSON.stringify({
    schemaVersion: '1', id: `scn.${name}`, name, env: { environmentRef: 'unit' },
    load, body,
  }), 'utf8');
  return p;
}

const FAST = { vus: 2, durationMs: 800, maxIterationsPerVu: 1 };

/**
 * 一条打 mock 里那个接口的步骤，**外加**看着它的断言。
 *
 * 断言不是凑数的：`atest load` 开跑前先过静态闸（与 `run` 同一个顺序），
 * 而 `ASSERT_FREE_STEP` / `ASSERT_FREE_SCENARIO` 会把"打个请求什么都不看"
 * 判成 error —— 屏幕上先打出"静态闸没过（2 个 error）"，**根本没走到**这一条
 * 要测的那件事。这是实测出来的（第一批负向用例全挂在 3 上而不是它们各自的码上）。
 * 负向用例因此也得带断言，否则测的是 lint、不是那条负向路径。
 */
function hitOrders(id: string): unknown[] {
  return [
    { id: 'hit', kind: 'http', request: { method: 'GET', url: `/orders/${id}` } },
    { id: 'chk', kind: 'assert', against: '$.step.hit.resp', status: 200 },
  ];
}

test('load 真打一次：只写 manifest + summary 两份，退出码是 VERDICT_UNKNOWN（没基线，不是通过）', async () => {
  const f = await fixture();
  const casePath = await writeCase(f.dir, 'ok', [
    { id: 'call', kind: 'openapiCall', docRef: 'shop', operationId: 'getOrdersId', pathParams: { id: 'A1' }, saveAs: 'called' },
    { id: 'ok', kind: 'assert', against: '$.step.call.resp', status: 200 },
  ], FAST);
  const io = ioCapture();
  const code = await main(['load', casePath, '--doc', `shop=${f.specPath}`, '--local',
    '--runner-spec', 'local-1x', '--evidence-dir', join(f.dir, 'evidence')], io);
  const err = io.stderr.join('\n');
  assert.equal(code, EXIT.VERDICT_UNKNOWN, `没有基线不该是绿。stderr: ${err}`);

  const root = join(f.dir, 'evidence');
  const dirs = (await readdir(root)).filter((x) => x !== 'artifacts');
  assert.equal(dirs.length, 1, `evidence 下应只有一个 run 目录：${(await readdir(root)).join(',')}`);
  const runDir = join(root, dirs[0]!);
  const files = await readdir(runDir);
  for (const want of [EVIDENCE_FILES.manifest, EVIDENCE_FILES.summary]) {
    assert.ok(files.includes(want), `${want} 没写盘：${files.join(', ')}`);
  }
  /*
   * **写完就删掉那一份**：从前这里有第三样 `load.json`。删它的判据量在
   * `writeLoadProducts` 的文件头上（逐键比对后只有一个独有键，其余与清单逐字节相同），
   * 这里钉的是它的**后果**：那个名字不在 `EVIDENCE_MEMBERS` 里，
   * 所以 `/evidence/<run>/load.json` 走 store 的白名单时**直接 404** ——
   * 磁盘上有、屏幕上"产物："里也有，就是取不回来。
   * 断"它不存在"而不是断"它现在能被取出"，因为前者才是这次修的东西。
   */
  assert.ok(!files.includes('load.json'), 'load.json 又回来了：那份是清单的副本，且取不回来（不在成员白名单里）');
  assert.equal(await readRunMember(runDir, 'load.json'), undefined, '白名单居然放行了 load.json');
  /*
   * `manifest.json` 这个名字**不是随便起的**：服务端 `GET /api/runs` 逐目录找的就是它，
   * 读不到就 continue —— 名字起错的那一格在运行记录页面上**根本不存在**。
   * 所以这里不只看磁盘，还走 store 那条**读侧**路径（它带成员白名单）。
   */
  const manifestBuf = await readRunMember(runDir, EVIDENCE_FILES.manifest);
  assert.ok(manifestBuf, 'store 的读侧取不到 manifest（运行记录列表会漏掉这一格）');
  const manifest = JSON.parse(new TextDecoder().decode(manifestBuf)) as Record<string, unknown>;
  /*
   * `kind` 这一格**有消费者了**：前端 `run-lines.ts` 的 `runRow()` 读它，
   * 据此决定那一行挂「压测」标签、并且**不链** report.html（压测不产那一份，链了就是 404）。
   * 从前它是"有生产者、没有消费者"的那一格（docs/08 §3 的反向版）。
   * 值的口径由那边一份、这里一份各钉一次（web 不许依赖 cli，抄不成同一份）。
   */
  assert.equal(manifest.kind, 'load', '清单里要能看出这不是功能 run（它们混在同一份列表里，而前端靠这一格分情形画）');
  assert.equal(manifest.status, 'pass');
  // 被中断这件事**不进 status**（那是六态之一的位置），只在 aborted 那一栏，且没中断时整格不写
  assert.ok(!('aborted' in manifest), '没被取消的清单里出现了 aborted —— 前端会画出"已中断"');
  assert.ok(manifest.envFingerprint, '压测的清单也必须带环境指纹 —— 可比性判据缺这一格就没前提');
  /*
   * tally **只有一个桶**。六个 0 加一个 1 的那一份已经改掉了：那六个 0
   * 会让人以为"这条用例有六个步骤、五个没跑"，而压测形态没有步骤级 tally。
   * 这一条判据读的是磁盘上那份，不是代码里的字面量 —— 改回六个 0 会当场红。
   */
  const tally = manifest.tally as Record<string, number>;
  assert.deepEqual(Object.entries(tally), [['pass', 1]], `压测的 tally 该只有一个桶：${JSON.stringify(tally)}`);
  const load = manifest.load as Record<string, unknown>;
  assert.equal(load.backend, 'builtin');
  assert.equal(load.setupRequests, 0);
  assert.ok(typeof load.windowMs === 'number');
  // 原来只活在 load.json 里的那个时间戳，现在得在清单里，否则"基线是哪天定的"没人答得上
  assert.equal(typeof load.takenAt, 'number', 'load.takenAt 丢了（基线样本的采样时刻）');
  /*
   * 门禁结论在清单里也有一份。**这不是副本**：`gate` 那份在内存对象里，
   * 只有 `--json` 会把它打到 stdout；落盘的这一份是它唯一的磁盘载体。
   */
  const gate = manifest.perfGate as { verdict: string };
  assert.equal(gate.verdict, 'unknown', '没有基线时清单里写的不该是 pass');

  /*
   * 屏幕上那句「产物：」与磁盘**一一对应**（双向）。
   * 这行是给人看的，因而**没有任何断言看过它**的历史 —— 手抄的产物清单漂过两次，
   * 报出磁盘上没有的东西比漏报更坏（人会去 cd 找）。
   * 删掉 load.json 时这一条是唯一能抓住"只删写盘、忘了删清单"的断言。
   */
  const printed = io.stdout.join('\n').split('\n').map((l) => l.trim()).filter((l) => l.startsWith(runDir + '/'));
  assert.deepEqual([...printed].sort(), files.map((x) => join(runDir, x)).sort(),
    `「产物：」那行与磁盘不对应：报出 ${printed.length} 条、磁盘 ${files.length} 个`);
  // 施压模型与后端不可比那两句话**必须出现在报告里**，缺一句就等着第一次跨工具对比中一次
  const out = io.stdout.join('\n');
  assert.match(out, /闭合模型/);
  assert.match(out, /施压后端不同/);
  // 结论是**推出来的**这件事必须自己说，否则读的人会以为这条基线保证过功能回归
  assert.match(out, /不是另跑一次功能回归/);
  /*
   * 同一两句话也得在**落盘的那一份**里。理由与终端那份不同：summary.txt 是
   * 会被下载、贴进工单、给别人看的唯一那份文字，而拿到它的人看不到终端。
   * 一份写着 p95 与 rps 而**没说施压模型**的摘要，本身就是一条错误读法的邀请函。
   */
  const summaryDoc = await readRunMember(runDir, EVIDENCE_FILES.summary);
  assert.ok(summaryDoc, 'summary.txt 取不到（store 的白名单里该有它）');
  const summaryText = new TextDecoder().decode(summaryDoc);
  assert.match(summaryText, /闭合模型/);
  assert.match(summaryText, /施压后端不同/);
});

test('有请求失败而门禁判不了时，退出码是 1（产品结论）而不是 11（去建基线）', async () => {
  const f = await fixture();
  const casePath = await writeCase(f.dir, 'bad', [
    { id: 'hit', kind: 'http', request: { method: 'GET', url: '/definitely-not-here' } },
    { id: 'ok', kind: 'assert', against: '$.step.hit.resp', status: 200 },
  ], FAST);
  const io = ioCapture();
  const code = await main(['load', casePath, '--doc', `shop=${f.specPath}`, '--local',
    '--runner-spec', 'local-1x', '--evidence-dir', join(f.dir, 'evidence')], io);
  assert.equal(code, EXIT.TEST_FAILED, `产品结论（有请求失败）被门禁那一格盖掉了。stderr: ${io.stderr.join('\n')}`);
  assert.match(io.stderr.join('\n'), /退出码取的是\*\*产品结论\*\*/, '两件事各出一个码时要把取哪个、为什么说出来');
});

test('--runner-spec 没给：一个请求都不发，退出码 2', async () => {
  const f = await fixture();
  const casePath = await writeCase(f.dir, 'nospec', hitOrders('A1'), FAST);
  const io = ioCapture();
  const code = await main(['load', casePath, '--doc', `shop=${f.specPath}`, '--local',
    '--evidence-dir', join(f.dir, 'evidence')], io);
  assert.equal(code, EXIT.USAGE);
  // **不许留下 run 目录**：拒绝开跑却产出一份空产物，读的人会以为"跑了但没数据"
  await assert.rejects(readdir(join(f.dir, 'evidence')), '被拒绝的压测不该留下任何产物目录');
});

test('--clock deterministic：拒绝，并且报错里带着"0 是合法值"那句', async () => {
  const f = await fixture();
  const casePath = await writeCase(f.dir, 'clock', hitOrders('A1'), FAST);
  const io = ioCapture();
  const code = await main(['load', casePath, '--doc', `shop=${f.specPath}`, '--local', '--runner-spec', 'x',
    '--clock', 'deterministic', '--evidence-dir', join(f.dir, 'evidence')], io);
  assert.equal(code, EXIT.USAGE);
  assert.match(io.stderr.join('\n'), /合法值/);
});

test('--backend k6 配 --local 会被拒：mock 跟着命令一起退，脚本届时打的是空地址', async () => {
  const f = await fixture();
  const casePath = await writeCase(f.dir, 'k6local', hitOrders('A1'), FAST);
  const io = ioCapture();
  const code = await main(['load', casePath, '--doc', `shop=${f.specPath}`, '--local', '--runner-spec', 'x',
    '--backend', 'k6', '--evidence-dir', join(f.dir, 'evidence')], io);
  assert.equal(code, EXIT.USAGE);
  assert.match(io.stderr.join('\n'), /没人监听/);
});

test('--backend k6 --out 真把脚本写到那个路径（说了路径就得有文件）', async () => {
  const f = await fixture();
  const casePath = await writeCase(f.dir, 'k6', hitOrders('A1'), FAST);
  const out = join(f.dir, 'gen', 'case.k6.mjs');
  const io = ioCapture();
  const code = await main(['load', casePath, '--doc', `shop=${f.specPath}`,
    '--env-var', 'baseUrl=http://api.internal.test', '--backend', 'k6', '--runner-spec', 'x',
    '--out', out, '--evidence-dir', join(f.dir, 'evidence')], io);
  assert.equal(code, EXIT.OK, io.stderr.join('\n'));
  const script = await readFile(out, 'utf8');
  assert.match(script, /atest-load-prelude/, '脚本要 import 那个预lude，否则 k6 起不来');
  assert.match(io.stderr.join('\n'), new RegExp(`复制过来`), '写盘了就要给"还要把预lude 放同一目录"那句话');
  // 绝对路径**不许**出现在生成的字节里（脚本会被人复制来复制去，路径泄漏且不可移植）
  assert.ok(!script.includes(f.dir), '生成的脚本里出现了绝对路径');
  // 没给 --out 时只打 stdout，不写盘
  const io2 = ioCapture();
  await main(['load', casePath, '--doc', `shop=${f.specPath}`,
    '--env-var', 'baseUrl=http://api.internal.test', '--backend', 'k6', '--runner-spec', 'x',
    '--evidence-dir', join(f.dir, 'evidence2')], io2);
  assert.match(io2.stdout.join('\n'), /export default/, '没给 --out 时脚本要打到 stdout');
  await assert.rejects(readdir(join(f.dir, 'evidence2')), 'k6 那条路不施压，不该产出 run 目录');
});

test('--vus 覆盖 IR 里的并发：报警 + 指纹里是覆盖后的值', async () => {
  const f = await fixture();
  const casePath = await writeCase(f.dir, 'ovr', hitOrders('A1'), FAST);
  const io = ioCapture();
  await main(['load', casePath, '--doc', `shop=${f.specPath}`, '--local', '--runner-spec', 'local-1x',
    '--vus', '1', '--evidence-dir', join(f.dir, 'evidence')], io);
  assert.match(io.stderr.join('\n'), /并发数被覆盖/, '覆盖了却不报警 = 拿 1 VU 的数与 2 VU 的基线比');
  const dirs = (await readdir(join(f.dir, 'evidence'))).filter((x) => x !== 'artifacts');
  /*
   * 读的键路径与从前那份 `load.json` **不同**：这里读清单上的
   * `load.fingerprint`（那是同一份内存对象的磁盘载体，`outcome.load` 原样搬过去），
   * 而不是 `outcome.load`。改文件的同时必须改这条读法 ——
   * 只改写侧的话这里会去读一个已经不存在的文件而当场炸，那正是想要的反应。
   */
  const doc = JSON.parse(await readFile(join(f.dir, 'evidence', dirs[0]!, EVIDENCE_FILES.manifest), 'utf8')) as
    { load: { fingerprint: { vus: number; runnerSpec: string } } };
  assert.equal(doc.load.fingerprint.vus, 1, '指纹里的并发必须是实打的那个');
  assert.match(doc.load.fingerprint.runnerSpec, /\(builtin\)$/, '后端名要拼进规格（换后端靠它才判不可比）');
});

/**
 * 中途取消一场真压测，看落到磁盘上的那两份**怎么写**。
 *
 * ## 为什么这一条走 `io.abortSignal`，而别的条都不走
 * `ioCapture` 的注释写着"不给 abortSignal"，那是对的：给了就走
 * `installCommandSignals` 的"注入那份"分支，测的就不是人敲 Ctrl-C 那条路。
 * 但**取消这件事本身**在进程内只有这一条注入路可走 —— 另一条是真发 SIGINT，
 * 那会把正在跑测试的 node 进程一起涉及（`installSignalHandlers` 会对信号免疫，
 * 后果是整个测试文件的行为被改写）。所以这条测的是**宿主取消**（服务端
 * `POST /api/cancel`）那一支，而它恰好是这一格最需要正确的一份：
 * 平台上下发的取消，就是压测真正会被用的地方。Ctrl-C 那两支的判据同源
 * （`installCommandSignals`），措辞不同，由 signals 自己的测试钉。
 */
test('中途取消：status 仍是六态之一，"不完整"记在 aborted 那一栏，退出码 10', async () => {
  const f = await fixture();
  // 不给 maxIterationsPerVu：VU 要一直施压到被取消为止，否则跑完一轮就自然结束，测不到取消
  const casePath = await writeCase(f.dir, 'cancel', hitOrders('A1'), { vus: 2, durationMs: 10_000 });
  const cancel = createAbortFlag();
  const io = ioCapture();
  io.abortSignal = cancel.flag;
  const timer = setTimeout(() => { cancel.cancel(); }, 250);
  let code: number;
  try {
    code = await main(['load', casePath, '--doc', `shop=${f.specPath}`, '--local',
      '--runner-spec', 'local-1x', '--evidence-dir', join(f.dir, 'evidence')], io);
  } finally {
    clearTimeout(timer);
  }
  // 10 = 被取消。它盖过产品结论与门禁那一格（WORSE_ORDER 里排最后）
  assert.equal(code, EXIT.ABORTED, `取消的场次要给 CI 一个明确的 10。stderr: ${io.stderr.join('\n')}`);

  const dirs = (await readdir(join(f.dir, 'evidence'))).filter((x) => x !== 'artifacts');
  assert.equal(dirs.length, 1, '被取消的一场也要留下产物（按了 Ctrl-C 却什么都不留是最坏的一种）');
  const runDir = join(f.dir, 'evidence', dirs[0]!);
  const manifest = JSON.parse(new TextDecoder().decode(
    await readRunMember(runDir, EVIDENCE_FILES.manifest),
  )!) as { status: string; aborted?: { kind: string }; tally: Record<string, number> };

  /*
   * **这一条是这一整轮改动的落点。** 改前这一格写的是 `status: 'aborted'`，
   * 而 `'aborted'` 不在前端徽章的白名单里 -> 落进兜底 -> 画成**红色的"执行异常"**。
   * 一场"人主动停下来"的压测与"引擎崩了"在运行记录列表里长得一模一样，
   * 而功能那条路上同一件事画的是 `pass 已中断`。
   */
  assert.ok((STEP_STATUS as readonly string[]).includes(manifest.status),
    `manifest.status 写的是 ${JSON.stringify(manifest.status)}，前端徽章认不出来 -> 画成红色 error`);
  assert.ok(manifest.aborted, '取消没进 manifest —— 那半场的读数会被当一次完整压测用');
  assert.equal(manifest.aborted!.kind, 'cancelled');
  /*
   * 计数那一栏只能有一个桶，而且**它跟着 status 走**：
   * 六桶版本会把这一格画成 `pass:0 fail:0 error:0 …`，看着像"六个步骤五个没跑"。
   */
  assert.deepEqual(Object.entries(manifest.tally), [[manifest.status, 1]],
    `tally 与 status 对不上或不止一个桶：${JSON.stringify(manifest.tally)}`);
  // 取消那句话必须在**落盘的摘要**里说，而不只在终端上（下载给别人看的那份只有文字）
  const summary = new TextDecoder().decode(await readRunMember(runDir, EVIDENCE_FILES.summary)!);
  assert.match(summary, /被中断/);
});

test('没有 load 块的场景：用法错，不是内部术语', async () => {
  const f = await fixture();
  const p = join(f.dir, 'plain.json');
  await writeFile(p, JSON.stringify({
    schemaVersion: '1', id: 'scn.plain', name: 'plain', env: { environmentRef: 'unit' },
    // 带断言：不然静态闸先按"这条用例永远绿"拦下（退出码 3），走不到"没有 load 块"那一格
    body: hitOrders('A1'),
  }), 'utf8');
  const io = ioCapture();
  const code = await main(['load', p, '--doc', `shop=${f.specPath}`, '--local', '--runner-spec', 'x'], io);
  assert.equal(code, EXIT.USAGE);
  // 报错要指向**该改的地方**（IR 的 load 块），而不是让人去翻命令行开关
  assert.match(io.stderr.join('\n'), /load 块/);
});
