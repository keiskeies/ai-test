/**
 * `compileLoadPlan` 的**遍历式**测试：判据表里每一个"说能压"的 kind 都要真编出一个节点。
 *
 * ## 为什么是遍历而不是挑几个
 *
 * `LOAD_STEP_SUPPORT` 是 `Record<Step['kind'], …>`，所以"加了 kind 忘了登记表"
 * 是编译错误（有人管）。而**反方向没人管**：表里写着 `flow`、编译器的 switch 里
 * 没有对应分支时，`compileOne` 落到 default 抛一句"没处理这种步骤"。
 * 那句抛本身是对的（宁可这一步不跑），坏的是**发现时机**：
 * 静态闸已经放行了（它只问表），于是用户是在 `atest load` 跑起来之后
 * 才撞上一句"你这条用例不能压" —— docs/08 §3(e)「有载体、没有生产者」在本仓
 * 出现过多次，而这一格是它在这一层唯一的入口。
 *
 * 所以这里把表走一遍，`press`/`flow`/`once` 三档各编一次，缺分支就红。
 *
 * ## 第二件事：运行时那一层同样的洞，**parity 测试结构上抓不到**
 *
 * `runtime.ts` 的两个调度器（`walkSyncK6` / `walkAsyncBuiltin`）各自的 default 都调
 * `runLeaf`。给 `LoadNode` 加一个 `op` 而两个调度器都没加分支时，
 * 两边会**一起**把它跳过 —— 于是 `load-parity.test.ts` 逐字段比发出的请求时两边完全一致、
 * 全绿，而用例里那一步在压测里根本不存在（负载比用例描述的轻，曲线照画）。
 * "两个后端一起错"是 parity 这种方法论的盲区，只能靠"跳过 = 抛"来关。
 * `runLeaf` 的 default 现在抛，所以这里有一条**从编译产物里现取 op 清单**、
 * 逐个单独走一遍两个调度器的测试。刻意不从一份手抄的 op 名单取 ——
 * 那份名单自己就是这一族缺陷的下一个入口。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { defineScenario, LOAD_STEP_SUPPORT, type Scenario, type ScenarioDraft, type Step, type StepDraft } from '@atest/ir';
import { compileExpr, deterministicClock, liveClock } from '@atest/engine';
import { StepSchema } from '@atest/ir';
import { compileLoadPlan, LoadCompileError, type LoadDocLookup, type LoadNode, type LoadPlan } from '../src/load/plan.js';
import { newLoadState, walkAsyncBuiltin, walkSyncK6, type BuiltRequest, type RawResponse } from '../src/load/runtime.js';

const LOAD = { vus: 4, durationMs: 60_000 };

const scen = (body: StepDraft[], extra: Record<string, unknown> = {}): Scenario =>
  defineScenario({
    schemaVersion: '1', id: 'scn.load', name: 'load', env: { environmentRef: 'unit' },
    load: LOAD, body, ...extra,
  } as unknown as ScenarioDraft);

/** 一个能定位到的 operation。真实 spec 走 `load-parity.test.ts`，这里只要编译期查得到 */
const OP = {
  method: 'GET', urlTemplate: '/orders/{id}',
  params: [{ name: 'id', in: 'path' as const, style: 'simple' }],
  operationId: 'getOrder',
};
const lookup = (found = true): LoadDocLookup => ({
  operation: async ({ operationId }) => (found && operationId === 'getOrder' ? OP : undefined),
});

const b = (id: string) => ({ id });
const http = (id: string): StepDraft => ({ ...b(id), kind: 'http', request: { method: 'GET', url: '/orders' } });
const assertStep = (id: string): StepDraft => ({ ...b(id), kind: 'assert', against: '$.step.q.resp', jsonPath: { '$.id': { notNull: true } } });

/**
 * 每个"说能压"的 kind 的一份**能过 schema** 的夹具。
 * 与 `engine/test/load-lint.test.ts` 里那份是**不同用途的两份**：
 * 那份要的是"闸看得见这一步"，这份要的是"编译器编得出一个节点"，
 * 而这边每个夹具都要走真 `compileLoadPlan`（有 lookup、有 openapiCall）。
 * 两份不合并是因为合并后会有一份在验另一份的夹具而不是验判据。
 */
/** wait 夹具单独成一个常量：下面两条 onTimeout 的断言要直接引用它（map 下标拿不到非 undefined 类型） */
const WAIT_CONTINUE: StepDraft = { ...b('w'), kind: 'wait', condition: { type: 'expr', expr: '1' }, timeoutMs: 1000, onTimeout: 'continue' };

const SUPPORTED_STEP: Record<string, StepDraft> = {
  http: { ...b('q'), kind: 'http', request: { method: 'GET', url: '/orders' } },
  openapiCall: { ...b('oc'), kind: 'openapiCall', docRef: 'd.yaml', operationId: 'getOrder', pathParams: { id: 'A1' } },
  sequence: { ...b('seq'), kind: 'sequence', steps: [http('q2'), assertStep('a2')] },
  if: { ...b('if'), kind: 'if', condition: '1', then: [http('q3'), assertStep('a3')], else: [http('q4'), assertStep('a4')] },
  switch: { ...b('sw'), kind: 'switch', value: '$mode', cases: [{ is: 'a', steps: [http('q5'), assertStep('a5')] }], default: [http('q6'), assertStep('a6')] },
  forEach: { ...b('fe'), kind: 'forEach', items: '$rows', as: 'r', indexAs: 'i', steps: [http('q7'), assertStep('a7')] },
  repeat: { ...b('rp'), kind: 'repeat', times: 2, steps: [http('q8'), assertStep('a8')] },
  set: { ...b('st'), kind: 'set', assign: { mode: 'a', rows: [1, 2] } },
  extract: { ...b('ex'), kind: 'extract', from: '$.step.q.resp', rules: [{ var: 'v', path: '$.id', mode: 'jsonpath', required: false }] },
  log: { ...b('lg'), kind: 'log', level: 'info', message: 'hi' },
  noop: { ...b('np'), kind: 'noop' },
  sleep: { ...b('sl'), kind: 'sleep', ms: 5 },
  assert: assertStep('a1'),
  fail: { ...b('fl'), kind: 'fail', reason: '故意的' },
  // onTimeout 取 'continue'（三档里最静默的那一档）：编译必须把它原样带到节点上，
  // 否则"没等"会被演化成"整场失败"或反过来。下面有一条断言钉这件事。
  wait: WAIT_CONTINUE,
};

/**
 * refuse 档每一种 kind 的**合法**夹具（id 一律 `bad`）。
 *
 * 为什么不能一把梭写 `{...b('bad'), kind}`：`while` / `wait` 要 `condition`、
 * `act` 要 `locator`+`action`、`watcher` 要 `rules`……少一个字段的话 `defineScenario`
 * 先抛"场景不合法"，那条 `assert.rejects(..., LoadCompileError)` 就成了在验 zod。
 * **本文件第一版就是这么红的**（`body.1.condition → 缺少 "condition"`）。
 * 所以这里逐个给全，并由下面两条自检测试兜住：夹具不过 schema 就先红在自检上，
 * 而不是红在一条读起来像"编译器放行了"的断言上。
 */
const REFUSE_ID = 'bad';
const LOC = { intent: '下单按钮', primary: { by: 'css', value: '.submit' } };
const REFUSE_STEP: Record<string, StepDraft> = {
  while: { ...b(REFUSE_ID), kind: 'while', condition: '1', maxIterations: 3, steps: [http('wq')] },
  parallel: { ...b(REFUSE_ID), kind: 'parallel', steps: [http('pq')] },
  call: { ...b(REFUSE_ID), kind: 'call', scenarioRef: 'scn.child' },
  table: { ...b(REFUSE_ID), kind: 'table', rows: [{ a: 1 }], as: 'rows' },
  dataSource: { ...b(REFUSE_ID), kind: 'dataSource', source: { type: 'file', path: 'd.json' } },
  db: { ...b(REFUSE_ID), kind: 'db', sql: 'select 1', datasource: 'd' },
  script: { ...b(REFUSE_ID), kind: 'script', lang: 'ts', code: 'return 1' },
  useIdentity: { ...b(REFUSE_ID), kind: 'useIdentity', identity: 'admin' },
  manualHandoff: { ...b(REFUSE_ID), kind: 'manualHandoff', reason: '要人工过验证码' },
  navigate: { ...b(REFUSE_ID), kind: 'navigate', url: 'http://x/' },
  act: { ...b(REFUSE_ID), kind: 'act', locator: LOC, action: 'click' },
  capture: { ...b(REFUSE_ID), kind: 'capture', mode: 'screenshot' },
  assertPage: { ...b(REFUSE_ID), kind: 'assertPage', assertKind: 'visible', target: '下单成功' },
  device: { ...b(REFUSE_ID), kind: 'device', target: 'android' },
  app: { ...b(REFUSE_ID), kind: 'app', action: 'launch', package: 'com.x' },
  tap: { ...b(REFUSE_ID), kind: 'tap', target: LOC },
  input: { ...b(REFUSE_ID), kind: 'input', value: 'abc' },
  swipe: { ...b(REFUSE_ID), kind: 'swipe', from: [1, 1], to: [1, 9] },
  key: { ...b(REFUSE_ID), kind: 'key', key: 'enter' },
  watcher: { ...b(REFUSE_ID), kind: 'watcher', rules: [{ match: { text: '允许' }, action: 'dismiss' }] },
  logcat: { ...b(REFUSE_ID), kind: 'logcat', filter: 'x' },
  assertUi: { ...b(REFUSE_ID), kind: 'assertUi', assertKind: 'visible', target: '下单成功' },
  assertLlm: { ...b(REFUSE_ID), kind: 'assertLlm', question: '页面是否显示成功？', evidenceFrom: '$.step.q.resp' },
  assertPerf: { ...b(REFUSE_ID), kind: 'assertPerf', against: '$.step.q.resp', lte: 500 },
};

describe('夹具自检：编译器测试的红必须落在编译器上', () => {
  test('两份夹具的每一份都过 StepSchema', () => {
    for (const [where, map] of [['SUPPORTED', SUPPORTED_STEP], ['REFUSE', REFUSE_STEP]] as const) {
      for (const [kind, step] of Object.entries(map)) {
        const r = StepSchema.safeParse(step);
        assert.ok(r.success, `${where}.${kind} 的夹具不合法：${r.error?.issues.map((i) => `${i.path.join('.')} → ${i.message}`).join('; ')}`);
      }
    }
  });

  test('两份夹具的键集与 LOAD_STEP_SUPPORT 的四档分档一模一样', () => {
    // "每个 refuse 的 kind 都被拒"那条是 for + continue：表里多一个 refuse 的 kind
    // 而这里没补夹具时，循环少跑一格而全绿。所以键集要**双向对撞**，
    // 不能靠遍历时那句 assert.ok(sample) —— 那只覆盖"恰好被遍历到"的部分。
    const supported = Object.entries(LOAD_STEP_SUPPORT).filter(([, t]) => t.support !== 'refuse').map(([k]) => k).sort();
    const refused = Object.entries(LOAD_STEP_SUPPORT).filter(([, t]) => t.support === 'refuse').map(([k]) => k).sort();
    assert.deepEqual(Object.keys(SUPPORTED_STEP).sort(), supported, '能压那一档的夹具表与判据表分叉');
    assert.deepEqual(Object.keys(REFUSE_STEP).sort(), refused, 'refuse 那一档的夹具表与判据表分叉（新增 refuse 的 kind 而这里没登记）');
  });
});

/** 编一份"每种 kind 各一条"的计划（顺带覆盖 when 包装出来的那个 op） */
async function compileAllKinds(): Promise<LoadPlan> {
  const body = Object.values(SUPPORTED_STEP).map((s) => ({ ...s }));
  // 挑一条加 when 守卫，好让 `when` 这个 op 也进派生清单
  (body[0] as { when?: string }).when = '1';
  return compileLoadPlan(scen(body), lookup());
}

/** 在计划树里找一个 id 对得上的节点（结构化地找，不是"JSON 里含这个字符串"） */
function findNode(nodes: readonly LoadNode[], id: string): LoadNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const kids: LoadNode[] =
      n.op === 'if' ? [...n.then, ...n.else]
        : n.op === 'switch' ? [...n.cases.flatMap((c) => c.steps), ...n.default]
          : n.op === 'when' ? [n.inner]
            : n.op === 'forEach' || n.op === 'repeat' || n.op === 'group' ? n.steps : [];
    const hit = findNode(kids, id);
    if (hit) return hit;
  }
  return undefined;
}

function collectOps(nodes: readonly LoadNode[]): string[] {
  const out = new Set<string>();
  const go = (ns: readonly LoadNode[]) => {
    for (const n of ns) {
      out.add(n.op);
      switch (n.op) {
        case 'if': go(n.then); go(n.else); break;
        case 'switch': n.cases.forEach((c) => go(c.steps)); go(n.default); break;
        case 'forEach':
        case 'repeat':
        case 'group': go(n.steps); break;
        case 'when': go([n.inner]); break;
        default: break;
      }
    }
  };
  go(nodes);
  return [...out].sort();
}

describe('编译期：判据表说能压的 kind，编译器真能编', () => {
  test('表里每个 press/flow/once 的 kind 都编出一个节点（表与编译器不许分叉）', async () => {
    for (const [kind, t] of Object.entries(LOAD_STEP_SUPPORT)) {
      if (t.support === 'refuse') continue;
      const sample = SUPPORTED_STEP[kind];
      assert.ok(sample, `${kind} 在表里是 ${t.support} 而这里没有夹具（补一份，别跳过）`);
      const plan = await compileLoadPlan(scen([http('q'), assertStep('a'), sample]), lookup());
      // 断的是"有一个 id 对得上的**节点**"，不是"计划这段 JSON 里含这个字符串" ——
      // 后者在节点被编成别的形状而 id 恰好留在某个字段里时也会绿。
      const node = findNode([...plan.setup, ...plan.nodes, ...plan.teardown], sample.id as string);
      assert.ok(node, `${kind} 编译后在计划里没有自己的节点（被丢了？）`);
    }
  });

  test('wait 编成 waitOnce 而 onTimeout 原样带过去', async () => {
    // 丢 onTimeout 的下场不是报错：缺省是 'fail'，于是作者写的
    // `onTimeout:'continue'`（"这条等待可有可无"）在压测里变成"整场失败"。
    // 反过来把 fail 演成 continue 更坏 —— 压测照跑，而那条等待其实没等。
    const plan = await compileLoadPlan(scen([http('q'), WAIT_CONTINUE]), lookup());
    const node = findNode(plan.nodes, 'w');
    assert.equal(node?.op, 'waitOnce');
    assert.equal((node as { onTimeout?: string } | undefined)?.onTimeout, 'continue');
  });

  test('每一种 onTimeout 取值都原样带过去（三档各自钉，别只钉一个）', async () => {
    for (const onTimeout of ['fail', 'continue', 'error'] as const) {
      const plan = await compileLoadPlan(
        scen([http('q'), { ...b('w'), kind: 'wait', condition: { type: 'expr', expr: '1' }, timeoutMs: 1000, onTimeout }]),
        lookup(),
      );
      assert.equal((findNode(plan.nodes, 'w') as { onTimeout?: string }).onTimeout, onTimeout);
    }
  });

  test('这份"每种 kind 一条"的计划里，派生出的 op 清单覆盖到 14 个以上（取空自检）', async () => {
    // 下面那条"逐个走一遍两个调度器"的测试，在 op 清单为空时是恒绿的。
    // 这一条先钉住清单本身有东西 —— 与 ir 那边"从 schema 取出的清单非空"同一条守法。
    const ops = collectOps((await compileAllKinds()).nodes);
    assert.ok(ops.length >= 14, `只派生出 ${ops.length} 个 op：${ops.join(', ')}（先怀疑夹具没铺全，再怀疑编译器）`);
  });

  test('每个派生出的 op 都能被**两个**调度器各走一遍而不抛', async () => {
    // 这一条关的是"两个后端一起跳过同一个 op"那个 parity 盲区（见文件头第二件事）。
    const plan = await compileAllKinds();
    // 按 op 分组，每个 op 取一份**真编出来的**节点单独走
    const byOp = new Map<string, LoadNode>();
    const collect = (ns: readonly LoadNode[]) => {
      for (const n of ns) {
        if (!byOp.has(n.op)) byOp.set(n.op, n);
        switch (n.op) {
          case 'if': collect(n.then); collect(n.else); break;
          case 'switch': n.cases.forEach((c) => collect(c.steps)); collect(n.default); break;
          case 'forEach':
          case 'repeat':
          case 'group': collect(n.steps); break;
          case 'when': collect([n.inner]); break;
          default: break;
        }
      }
    };
    collect([...plan.setup, ...plan.nodes, ...plan.teardown]);

    for (const [op, node] of byOp) {
      // forEach 的 items 指向 set 出来的变量，单独走要先把那个变量备上
      const deps = { clock: deterministicClock(1), baseUrl: 'http://x', auth: () => {} };
      const recorded: BuiltRequest[] = [];
      const stSync = newLoadState({ rows: [1, 2] }, {}, plan.inputDefs, deps.clock);
      stSync.vars.set('mode', 'a');
      stSync.vars.set('rows', [1, 2]);
      stSync.vars.exportStep('q', { resp: { status: 200, body: { id: 'X' }, bodyText: '{}', headers: {}, durationMs: 1 }, status: 200, body: { id: 'X' } });
      walkSyncK6([node], stSync, deps, (r) => { recorded.push(r); return { status: 200, headers: {}, bodyText: '{"id":"X"}', ms: 1 }; });

      const stAsync = newLoadState({ rows: [1, 2] }, {}, plan.inputDefs, deps.clock);
      stAsync.vars.set('mode', 'a');
      stAsync.vars.set('rows', [1, 2]);
      stAsync.vars.exportStep('q', { resp: { status: 200, body: { id: 'X' }, bodyText: '{}', headers: {}, durationMs: 1 }, status: 200, body: { id: 'X' } });
      await walkAsyncBuiltin([node], stAsync, deps, async (r) => { recorded.push(r); return { status: 200, headers: {}, bodyText: '{"id":"X"}', ms: 1 }; });
      // 走到这里没抛 = 这个 op 在两个调度器里都有人接（`fail` 那一格返回 false 结束迭代，也不算抛）
    }
  });

  test('runLeaf 的 default 真的抛（跳过 = 静默少压，比不跑更坏）', async () => {
    // 手写一个不在 LoadNode 联合里的 op，直接喂给两个调度器。
    // TS 层它不合法，所以这是**故意越过类型**的一格：类型挡得住编译期，
    // 挡不住"将来有人加一个 op 而运行时没分支"那件事在运行时的样子。
    const fake = { op: 'brandNewOp', id: 'zz' } as unknown as LoadNode;
    const deps = { clock: deterministicClock(1), baseUrl: 'http://x', auth: () => {} };
    const st = newLoadState({}, {}, [], deps.clock);
    assert.throws(() => walkSyncK6([fake], st, deps, () => ({ status: 200, headers: {}, bodyText: '', ms: 1 })), /brandNewOp/);
    await assert.rejects(
      walkAsyncBuiltin([fake], st, deps, async () => ({ status: 200, headers: {}, bodyText: '', ms: 1 })),
      /brandNewOp/,
    );
  });
});

describe('编译期：该拒的必须拒', () => {
  test('没有 load 块的场景直接拒（压法是用例的一部分，不是命令行参数）', async () => {
    const noLoad = defineScenario({
      schemaVersion: '1', id: 'scn.noload', name: 'n', env: { environmentRef: 'unit' }, body: [http('q')],
    } as unknown as ScenarioDraft);
    await assert.rejects(compileLoadPlan(noLoad, lookup()), (e: unknown) => {
      assert.ok(e instanceof LoadCompileError);
      assert.match(e.message, /没有 load 块/);
      return true;
    });
  });

  test('refuse 档的每个 kind 都被拒，且报错带着表里那句 why', async () => {
    for (const [kind, t] of Object.entries(LOAD_STEP_SUPPORT)) {
      if (t.support !== 'refuse') continue;
      // 静态闸也会报这句；这里是**第二道**（`atest run` 不带 --strict 时 lint 不拦）
      const sample = REFUSE_STEP[kind];
      assert.ok(sample, `${kind} 是 refuse 而这里没有夹具（这条遍历会空转）`);
      await assert.rejects(
        compileLoadPlan(scen([http('q'), sample]), lookup()),
        (e: unknown) => {
          assert.ok(e instanceof LoadCompileError, `${kind} 拒的时候抛的不是 LoadCompileError`);
          assert.equal(e.stepId, 'bad');
          assert.match(e.message, new RegExp(t.support === 'refuse' ? t.why.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''));
          return true;
        },
        `${kind} 在表里是 refuse 而编译器放行了`,
      );
    }
  });

  test('retry.count>0 拒（压测形态完全不重试）', async () => {
    await assert.rejects(
      compileLoadPlan(scen([{ ...http('q'), retry: { count: 2, backoff: 'fixed', baseMs: 10 } }]), lookup()),
      /完全不重试/,
    );
  });

  test('openapiCall 定位不到 operation 时拒，而不是"按 IR 里的方法打个猜的地址"', async () => {
    await assert.rejects(
      compileLoadPlan(scen([{ ...b('oc'), kind: 'openapiCall', docRef: 'd', operationId: 'nope' }]), lookup(false)),
      /定位不到这个 operation/,
    );
  });

  test('wait 的谓词要外部能力时拒（三种复合键里藏的也算）', async () => {
    for (const cond of [
      { type: 'dbRow', sql: 'select 1' },
      { allOf: [{ type: 'expr', expr: '1' }, { type: 'dbRow', sql: 'select 1' }] },
      { noneOf: [{ type: 'uiPredicate', target: { intent: 'x', primary: { by: 'css', value: 'a' } } }] },
    ]) {
      await assert.rejects(
        compileLoadPlan(scen([http('q'), { ...b('w'), kind: 'wait', condition: cond, timeoutMs: 1000 }]), lookup()),
        /判不了/, `谓词 ${JSON.stringify(cond)} 该拒而没拒`,
      );
    }
  });

  test('extract 的 regex/header 模式在**运行期**抛（不在编译期），因为它是数据相关的', async () => {
    // 编译期不拒：这一格的判据与 wait 那一格不同 —— 它不影响"要不要压这条用例"，
    // 只影响"这一步能不能取值"。抛在运行期而消息点名 mode。
    const plan = await compileLoadPlan(
      scen([http('q'), { ...b('ex'), kind: 'extract', from: '$.step.q.resp', rules: [{ var: 'v', path: 'set-cookie', mode: 'header', required: false }] }]),
      lookup(),
    );
    const deps = { clock: deterministicClock(1), baseUrl: 'http://x', auth: () => {} };
    const st = newLoadState({}, {}, plan.inputDefs, deps.clock);
    assert.throws(
      () => walkSyncK6(plan.nodes, st, deps, () => ({ status: 200, headers: {}, bodyText: '{}', ms: 1 })),
      /header 模式在压测形态不支持/,
    );
  });

  test('http 带文件时拒（multipart 没实现，不能发一个少附件的请求）', async () => {
    await assert.rejects(
      compileLoadPlan(scen([{ ...b('u'), kind: 'http', request: { method: 'POST', url: '/up', files: [{ field: 'f', fixtureRef: 'a.txt' }] } }]), lookup()),
      /multipart 尚未实现/,
    );
  });
});

describe('计划本身带的东西', () => {
  test('inputDefs 原样带出来（少了它 default 值在压测里报"引用未定义"）', async () => {
    const s = scen([http('q')], { inputs: [{ name: 'q', type: 'string', default: 'DEF' }] });
    const plan = await compileLoadPlan(s, lookup());
    assert.equal(plan.inputDefs.length, 1);
    // 真走一遍：表达式 `$q` 必须得出 DEF（这是"同一份 IR 三条路同一个值"那一族的老账）。
    // ⚠ 断的是 **asExprRoot / compileExpr**，不是 `visible().q` —— 输入值挂在
    // runRoot.inputs 上（表达式根里能看到），而 visible() 只交**帧变量**。
    // 我第一版断的是后者，得到 undefined 而以为压测侧漏接了 default；
    // 探针（`.scratch/probe-inputdef.mts`）量出来 `compileExpr('$q')` 一直是 DEF。
    // 记在这是因为"断错载体"和"真缺接线"在测试输出里长得一模一样。
    const deps = { clock: deterministicClock(1), baseUrl: 'http://x', auth: () => {} };
    const st = newLoadState({}, {}, plan.inputDefs, deps.clock);
    assert.equal(compileExpr('$q').eval({ root: st.vars.asExprRoot(), vars: st.vars.visible(), now: deps.clock.now }), 'DEF');
  });

  test('setup / teardown 分开编（它们不计入分位数，见 press 的 makeSend(false)）', async () => {
    const plan = await compileLoadPlan(
      scen([http('q')], { setup: [http('login')], teardown: [http('clean')] }),
      lookup(),
    );
    assert.equal(plan.setup.length, 1);
    assert.equal(plan.teardown.length, 1);
    assert.equal(plan.nodes.length, 1);
  });

  test('dynamicIterations：有 forEach 就标出来（迭代数不可静态确定，报告要如实说）', async () => {
    const withFe = await compileLoadPlan(scen([{ ...b('fe'), kind: 'forEach', items: '$rows', as: 'r', steps: [http('q')] }]), lookup());
    assert.equal(withFe.dynamicIterations, true);
    const plain = await compileLoadPlan(scen([http('q')]), lookup());
    assert.equal(plain.dynamicIterations, false);
  });

  test('staticOps 不乘迭代次数（它答的是"每迭代成本"）', async () => {
    const plan = await compileLoadPlan(
      scen([{ ...b('fe'), kind: 'forEach', items: '$rows', as: 'r', steps: [http('q1'), http('q2')] }]),
      lookup(),
    );
    // forEach + 2 条 = 3，而不是 3 × 迭代数
    assert.equal(plan.staticOps, 3);
  });

  test('编译只走一遍：dynamicItems 不随编译次数变（从前为算 staticOps 编了两遍）', async () => {
    let calls = 0;
    const counting: LoadDocLookup = { operation: async (r) => { calls++; return OP; } };
    const body = [
      { ...b('oc'), kind: 'openapiCall', docRef: 'd', operationId: 'getOrder', pathParams: { id: '1' } },
      { ...b('fe'), kind: 'forEach', items: '$rows', as: 'r', steps: [{ ...b('oc2'), kind: 'openapiCall', docRef: 'd', operationId: 'getOrder', pathParams: { id: '2' } }] },
    ];
    await compileLoadPlan(scen(body), counting);
    assert.equal(calls, 2, `lookup 被调了 ${calls} 次（每个 openapiCall 一次），多出来的次数说明同一棵树编了不止一遍`);
  });
});

/** 让 TS 知道本文件也用得上 Step / liveClock（避免"导入了没用"的假信号） */
export type _Used = Step;
export const _clock = liveClock;
