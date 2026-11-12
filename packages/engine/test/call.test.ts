/**
 * `call` 子场景的**可见性**：它跑没跑、跑成什么样、产的证据去哪了。
 *
 * 判据分两条，缺一不可，而且方向相反：
 *  1. **计数不双算** —— 子场景的结论不进 JUnit 的 tests、不进 tally、不进门禁
 *     第二遍（一次子场景失败数出两条，与容器步骤被数进去是同一类错误，
 *     见 CONTAINER_KINDS 的注释）。
 *  2. **事实不丢失** —— 子场景里那一步真的失败了，父侧那条 failure 的正文必须
 *     点名是哪一步；子场景落的证据必须进包里（包侧见 store/test/call-evidence.test.ts）。
 *
 * 只做 1 不做 2，报告会变成"子场景挂了：挂了"——CI 绿不绿说得清，查什么说不清，
 * 人只能去翻 trace.jsonl；只做 2 不做 1，用例数被 call 的嵌套深度虚增，
 * "覆盖率"这种数字全废。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run, scen, b, getStep, stubComposeUrl, type StepDraft } from './helpers.js';
import { toJUnitXml, deterministicClock, runScenario, type AdapterRegistry, type HttpExec } from '../src/index.js';
import { defineScenario, type Scenario, type ScenarioDraft } from '@atest/ir';

const sub = (id: string, body: StepDraft[]): Scenario =>
  defineScenario({
    schemaVersion: '1', id, name: `子 ${id}`, tags: [],
    env: { environmentRef: 'unit' }, frozen: true, provenance: { origin: 'human' }, body,
  } as unknown as ScenarioDraft) as Scenario;

/** 内存版证据存储。engine 不能 import store（分层规则），这里自备一份最小实现 */
function memStore(): { store: AdapterRegistry['artifactStore']; saved: string[] } {
  const map = new Map<string, string>();
  const saved: string[] = [];
  return {
    saved,
    store: {
      async save(kind: string, data: Uint8Array | string, stepId: string): Promise<string> {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        // 内容寻址的最小替身：同内容同 id（真实现是 sha256）
        const id = `${Buffer.from(`${kind}|${text}`).toString('base64url').padEnd(64, '0').slice(0, 64)}`;
        map.set(id, text);
        saved.push(`${stepId}:${id.slice(0, 8)}`);
        return id;
      },
      async load(id: string) {
        const t = map.get(id);
        return t === undefined ? undefined : { kind: 'resp', bytes: new TextEncoder().encode(t), sha256: id };
      },
    },
  };
}

/**
 * http 夹具**写成 HttpExec 而不是 `as never`**（与 parallel.test.ts 同一条理由）：
 * 接口加必选方法时这里必须编译不过，否则夹具会一直"少一个方法也能跑"。
 * resolveOperation 本文件用不到，但它是必选项，所以老实返回形状正确的空解析结果。
 */
function fakeHttp(send: HttpExec['send']): HttpExec {
  return {
    send,
    composeUrl: stubComposeUrl(),
    resolveOperation: async (ref) => ({
      method: ref.method ?? 'GET', urlTemplate: ref.path ?? '/x', requiredBodyFields: [], deprecated: false,
    }),
  };
}
const httpOk = (tag = 'AAA') => fakeHttp(async (req) => {
    // 响应体**带上 URL**：内容寻址的存储里同内容同 id，
    // 而"两个步骤各产一份证据"的测试需要两份不同的字节，否则测不出串档
    const body = `{"tag":"${tag}","url":"${req.url}"}`;
    return { status: 200, headers: {}, body: { tag }, bodyText: body, bytes: body.length, truncated: false, durationMs: 2 };
});

test('子里的断言失败：JUnit 仍是 1 条（call 自己），但正文点名是哪一步', async () => {
  const child = sub('sub.login', [
    getStep('ca1'),
    { ...b('ca2'), kind: 'assert', against: '$.step.ca1', status: 418 } as StepDraft, // 实际 200，该 fail
  ]);
  const report = await run(scen([{ ...b('c1'), kind: 'call', scenarioRef: 'sub.login@1' } as StepDraft]), {
    adapters: { http: httpOk(), callScenario: async (ref: string) => (ref.startsWith('sub.login') ? child : undefined) },
  });
  assert.equal(report.status, 'fail', '子里失败必须把父 run 拖成 fail');
  const xml = toJUnitXml(report);
  const parsed = parseCounts(xml);
  assert.equal(parsed.tests, 1, '子场景的两步不进 tests：一次子场景失败只能数出一条结论');
  assert.equal(parsed.failures, 1);
  // 正文里必须出现子场景那一步的坐标。以前这里只有
  // `子场景 下单：fail · 3 步计入通过率 · 67% 通过` —— 说得清红不红，说不清查什么
  assert.match(xml, /根因在子场景步骤：sub\.login\/ca2=fail/, `实际 XML：\n${xml}`);
});

test('嵌套两层的 call：根因报的是最深层那一步，不是中间层的 call', async () => {
  const leaf = sub('sub.leaf', [
    getStep('la1'),
    // 期望 418、实际 200 => 确定性断言 fail（不是变量取不到的 error：
    // 子场景看不见父场景的变量，用 $n 会先炸在 VarError 上，测不到想测的那条路）
    { ...b('la'), kind: 'assert', against: '$.step.la1', status: 418 } as StepDraft,
  ]);
  const mid = sub('sub.mid', [{ ...b('m1'), kind: 'call', scenarioRef: 'sub.leaf@1' } as StepDraft]);
  const report = await run(
    scen([{ ...b('c1'), kind: 'call', scenarioRef: 'sub.mid@1' } as StepDraft]),
    {
      adapters: {
        http: httpOk(),
        callScenario: async (ref: string) =>
          ref.startsWith('sub.mid') ? mid : ref.startsWith('sub.leaf') ? leaf : undefined,
      },
    },
  );
  const xml = toJUnitXml(report);
  assert.equal(parseCounts(xml).tests, 1, '两层嵌套也只出 1 条 testcase');
  assert.match(xml, /根因在子场景步骤：sub\.leaf\/la=fail/,
    `只报直接子层会停在"sub.mid 这个子场景挂了"（那是个 call，不是坏掉的地方）。实际：\n${xml}`);
});

test('call 通过时不写根因行（只有真坏了才需要指路）', async () => {
  const child = sub('sub.ok', [getStep('ca1')]);
  const report = await run(
    scen([getStep('p1'), { ...b('c1'), kind: 'call', scenarioRef: 'sub.ok@1' } as StepDraft]),
    { adapters: { http: httpOk(), callScenario: async () => child } },
  );
  assert.equal(report.status, 'pass', `实际：${report.summary}`);
  assert.doesNotMatch(toJUnitXml(report), /根因在子场景步骤/);
});

test('子场景自己落的证据带 artifactIds（包侧靠它枚举，不再按 stepId 反查存储）', async () => {
  const { store, saved } = memStore();
  const child = sub('sub.login', [getStep('ca1')]);
  const report = await run(scen([{ ...b('c1'), kind: 'call', scenarioRef: 'sub.login@1' } as StepDraft]), {
    adapters: { http: httpOk('BBB'), artifactStore: store, callScenario: async () => child },
  });
  assert.equal(report.results[0]!.artifactIds.length, 0, 'call 步骤自己不产证据');
  const childRes = report.childRuns?.[0]?.results.find((r) => r.stepId === 'ca1');
  assert.equal(childRes?.artifactIds.length, 1,
    '子里 http 步骤的响应体必须把 id 带在自己的 StepResult 上 —— 存储的按-stepId 索引是进程级且跨场景的，'
    + '靠它反查会把别的场景/别的 run 的同名步骤捞进本包');
  assert.equal(saved.length, 1);
});

test('跨场景同名步骤：各自的 artifactIds 互不染指', async () => {
  const { store } = memStore();
  // 父和子都有一步叫 c1 —— 步骤 id 只在自己的场景里唯一，这完全合法
  const child = sub('sub.dup', [getStep('c1', 'http://x/child')]);
  const report = await run(scen([getStep('c1', 'http://x/parent'), { ...b('k'), kind: 'call', scenarioRef: 'sub.dup@1' } as StepDraft]), {
    adapters: { http: httpOk(), artifactStore: store, callScenario: async () => child },
  });
  const parentIds = report.results.find((r) => r.stepId === 'c1')!.artifactIds;
  const childIds = report.childRuns![0]!.results.find((r) => r.stepId === 'c1')!.artifactIds;
  assert.equal(parentIds.length, 1);
  assert.equal(childIds.length, 1);
  assert.notEqual(parentIds[0], childIds[0], '两份不同响应体必须是两个 id');
});

test('解析器没注入时报"没接线"，而不是抛 TypeError 被当成产品/环境问题', async () => {
  // 修之前：守卫是 `!adapters.http && !('callScenario' in adapters)` —— `&&` 让
  // "只注册了 http"这种情况跳过检查，于是走到方法调用上炸成
  // `adapters.callScenario is not a function`。那句会作为被测产品的 env-unavailable
  // 结论进报告与门禁（下一步：查环境），而真相是平台没接线（下一步：改接线）。
  const report = await run(scen([{ ...b('c1'), kind: 'call', scenarioRef: 'sub.x@1' } as StepDraft]), {
    adapters: { http: httpOk() },
  });
  const r = report.results[0]!;
  assert.equal(r.status, 'error');
  assert.match(r.assertionSummary ?? '', /callScenario/,
    `报错要点名缺哪个端口。实际：${r.assertionSummary}`);
  assert.doesNotMatch(r.assertionSummary ?? '', /is not a function|Cannot read properties/,
    '接线错误不能以 TypeError 形态出现：它会顺着 keyContext 进磁盘，让人以为产品挂了');
});

test('解析器返回 undefined（版本不存在）→ error 且带 ref，不是 skipped', async () => {
  // skipped 会让这步从通过率分母里消失，于是"引用一个不存在的版本"能一路全绿，
  // 而它压根没测任何东西 —— 那正是门禁最恨的假绿形态
  const report = await run(scen([{ ...b('c1'), kind: 'call', scenarioRef: 'sub.ghost@9' } as StepDraft]), {
    adapters: { callScenario: async () => undefined },
  });
  const r = report.results[0]!;
  assert.equal(r.status, 'error', `解析不到不能算跳过。实际：${r.status} / ${r.assertionSummary}`);
  assert.match(r.assertionSummary ?? '', /sub\.ghost@9/, '要让人看到是哪个 ref 解析不到');
});

test('子场景里的 $secret 引用解析到真值（以前拿到的是占位符，而步骤照样 pass）', async () => {
  // 实测的旧行为：`runScenarioIn` 硬编码 `secretResolver: undefined`，
  // 于是子场景发出去的 body 是 {"pw":"«secret:未暴露»"}，状态 pass。
  // 真值取不到 + 绿灯 + 一句说不清的失败，正是"字段在、没人接"的标准形态。
  const sent: unknown[] = [];
  const child = sub('sub.login', [
    { ...b('h1'), kind: 'http', request: { method: 'POST', url: 'http://x/login', body: { pw: { path: '$.secret.pw' } } } } as StepDraft,
  ]);
  const report = await run(scen([{ ...b('c1'), kind: 'call', scenarioRef: 'sub.login@1' } as StepDraft]), {
    adapters: {
      artifactStore: undefined,
      callScenario: async () => child,
      http: fakeHttp(async (req) => {
        sent.push(req.body);
        return { status: 200, headers: {}, body: {}, bodyText: '{}', bytes: 2, truncated: false, durationMs: 1 };
      }),
    },
    secretResolver: (ref) => `REAL<${ref}>`,
  });
  assert.equal(report.status, 'pass', report.summary);
  assert.deepEqual(sent, [{ pw: 'REAL<secret:pw>' }],
    `子场景必须解析到真值。实际发出去：${JSON.stringify(sent)}`);
});

test('真值不渗进磁盘形态：结果与事件里搜不到它', async () => {
  // 与上一条成对。透传的是**解析能力**，不是值 —— 这条守着另一半：
  // 解析出的真值只能出现在"发出去的那一跳"，不能出现在会落盘的任何一个字段里
  const child = sub('sub.login', [
    { ...b('h1'), kind: 'http', request: { method: 'POST', url: 'http://x/login', body: { pw: { path: '$.secret.pw' } } } } as StepDraft,
  ]);
  const report = await run(scen([{ ...b('c1'), kind: 'call', scenarioRef: 'sub.login@1' } as StepDraft]), {
    adapters: {
      callScenario: async () => child,
      http: fakeHttp(async () => ({ status: 200, headers: {}, body: { ok: 1 }, bodyText: '{"ok":1}', bytes: 7, truncated: false, durationMs: 1 })),
    },
    secretResolver: () => 'SUPER-SECRET-VALUE',
  });
  const disk = JSON.stringify({ results: [...report.results, ...(report.childRuns ?? []).flatMap((c) => c.results)], events: report.events, outputs: report.outputs });
  assert.ok(!disk.includes('SUPER-SECRET-VALUE'), `密钥渗进落盘形态：\n${disk.slice(0, 800)}`);
});

test('call 成环立刻报错，而不是永远转下去', async () => {
  // 这条测的是"会不会挂住"，所以断言的重点是**这个 await 会返回**。
  // 修之前实测：A→B→A 时每一层都在 await 下一层，既不栈溢出也不报错，
  // 我那次是把它 background 掉才发现的 —— CI 里就是"用例卡死到被 kill、日志零异常"。
  const a = sub('A', [{ ...b('c'), kind: 'call', scenarioRef: 'B@1' } as StepDraft]);
  const bb = sub('B', [{ ...b('c'), kind: 'call', scenarioRef: 'A@1' } as StepDraft]);
  const resolver = boundedResolver((ref) => (ref.startsWith('B') ? bb : a));
  const report = await run(a, { adapters: { callScenario: resolver } });
  assert.equal(report.status, 'error', '环必须让 run 红，不能静默');
  assert.equal(report.results[0]!.status, 'error', '父侧 call 步骤要带上来（不在这里数第二遍，见 gate.ts）');
  // 报错落在**发现环的那一层**（B 里那个 call 步骤），父侧只是把它带上来。
  // 整条链必须原样说得出：只说"成环"人会去查一个不在环上的地方
  // 解析器只该被问**两次**（A 问 B、B 问 A，第二次就被引擎挡下）。
  // 光看"报了错"不够：兜底闸也会报错，两种情况下一步动作完全不同
  // （前者是平台正常，后者是平台的环检测坏了）。
  assert.equal(resolver.calls(), 2, `解析器被问了 ${resolver.calls()} 次 => 环检测没生效，是兜底闸在兜`);
  const all = [...report.results, ...(report.childRuns ?? []).flatMap((c) => c.results)];
  const msg = all.map((x) => x.assertionSummary ?? '').find((m) => m.includes('成环'));
  assert.ok(msg, `找不到成环那条。实际：${JSON.stringify(all.map((x) => x.assertionSummary))}`);
  assert.match(msg, /A → B → A/, `实际：${msg}`);
});

test('场景 call 自身也报环（不是只挡跨场景）', async () => {
  const self = sub('Self', [{ ...b('c'), kind: 'call', scenarioRef: 'Self@1' } as StepDraft]);
  const report = await run(self, { adapters: { callScenario: boundedResolver(() => self) } });
  // 自引用在**本层**就发现（callStack 含自己），所以消息直接落在父侧这一行
  assert.match(report.results[0]!.assertionSummary ?? '', /成环/,
    `实际：${report.results[0]!.assertionSummary}`);
});

test('合法复用（同一子场景被 call 两次）不是环', async () => {
  // 反向对照。判据写成"这个 id 有没有出现过"会误伤这种写法 ——
  // 公共步骤抽成一个场景被反复 call 恰恰是 call 的主要用法，
  // 误伤等于逼作者把同一段用例复制三份
  const leaf = sub('leaf', [getStep('l1')]);
  const report = await run(scen([
    { ...b('c1'), kind: 'call', scenarioRef: 'leaf@1' } as StepDraft,
    { ...b('c2'), kind: 'call', scenarioRef: 'leaf@1' } as StepDraft,
  ] as StepDraft[]), { adapters: { http: httpOk(), callScenario: async () => leaf } });
  assert.equal(report.status, 'pass', `合法复用被判成环：${report.summary}`);
  assert.equal(report.childRuns?.length, 2, '两次调用都该真跑过');
});

/**
 * 解析次数上限。**这条是给测试自己兜底的，不是被测行为**。
 *
 * 环检测一旦被改坏，`runScenario` 就永远不返回：每一层都在 await 下一层，
 * 全是微任务，所以 setTimeout 那种"给它 2 秒"的兜底**压根不会触发**
 * （微任务链饿死事件循环，计时器永远轮不到）—— 我第一版就是这么写的，
 * 结果是把整条测试线挂 300 秒等 harness 超时。
 * 唯一可靠的闸是**不让它无限递归下去**：解析器被问到第 N 次就直接抛。
 * 抛出来的是普通 Error，引擎会把它记成一步 error，测试照样能断言"跑了、返回了"。
 */
function boundedResolver(pick: (ref: string) => Scenario, max = 20): AdapterRegistry['callScenario'] & { calls(): number } {
  let n = 0;
  const f = async (ref: string) => {
    if (++n > max) throw new Error(`递归解析超过 ${max} 次：环没被挡住（引擎应当自己发现 ${ref} 在调用链上）`);
    return pick(ref);
  };
  return Object.assign(f, { calls: () => n });
}

/** 用正则从 testsuite 行取四个计数（不引 python：这里只数数，不做"外部解析器认不认"的判据） */
function parseCounts(xml: string): { tests: number; failures: number; errors: number } {
  const m = xml.match(/<testsuite [^>]*tests="(\d+)" failures="(\d+)" errors="(\d+)"/);
  assert.ok(m, `没有 testsuite 行：\n${xml}`);
  return { tests: Number(m![1]), failures: Number(m![2]), errors: Number(m![3]) };
}

test('父子两层用**同名** call 步骤：根因要钻到最里层，不能停在中层的 call 上', async () => {
  /*
   * 步骤 id 只在**自己的场景里**唯一 —— 父用 `k1` 调 B、B 再用 `k1` 调 D
   * 是完全合法的 IR（与上面那条"跨场景同名步骤"是同一件事，只不过发生在 call 上）。
   *
   * 而 childRuns 是**扁平**的，于是 `chain.find(c => c.callStepId === stepId)`
   * 会永远命中第一个（父→B 那条）。更糟的是防环用的是**裸 stepId**：
   * 第二轮拿到同一个 'k1' 时 visited 已经把它记下了，于是循环**提前停**，
   * 报出来的是中层那个 call 步骤自己（`sub.mid/k1=fail`）——
   * 那正是这个文件上面一条测试专门写注释警告过的症状：
   * "只报一层会停在'下单流程这个子场景挂了'"。
   * 区别在于那次是设计意图未达成，这次是**同名把作用域搅了**：
   * 单看父侧那条测试（父子用不同 id）永远发现不了。
   *
   * 判据是最里层那一步的 id（`la`），不是中层的 call id（`k1`）。
   */
  const leaf = sub('sub.leaf', [
    getStep('la1'),
    { ...b('la'), kind: 'assert', against: '$.step.la1', status: 418 } as StepDraft, // 实际 200 => fail
  ]);
  // 中层的 call 步骤刻意也叫 k1，与父侧那个同名
  const mid = sub('sub.mid', [{ ...b('k1'), kind: 'call', scenarioRef: 'sub.leaf@1' } as StepDraft]);
  const report = await run(
    scen([{ ...b('k1'), kind: 'call', scenarioRef: 'sub.mid@1' } as StepDraft]),
    {
      adapters: {
        http: httpOk(),
        callScenario: async (ref: string) => (ref.startsWith('sub.mid') ? mid : leaf),
      },
    },
  );
  // 前提：扁平列表里确实有**两条 callStepId='k1'** 的记录，否则这条测的是空气
  const k1s = (report.childRuns ?? []).filter((c) => c.callStepId === 'k1');
  assert.equal(k1s.length, 2, `夹具前提：两条同名 call 记录。实际 ${(report.childRuns ?? []).map((c) => `${c.calledById}/${c.callStepId}`).join(', ')}`);
  assert.equal(new Set(k1s.map((c) => c.calledById)).size, 2, '两条的**发起方**必须不同（否则作用域信息本身就没记对）');

  const xml = toJUnitXml(report);
  assert.match(xml, /根因在子场景步骤：sub\.leaf\/la=fail/,
    `必须钻到最里层那一步。停在 sub.mid/k1 就是拿错了作用域。实际：\n${xml}`);
});

test('refs 里没写 @版本 时，**不许**出现 CALL_VERSION_IGNORED（这条管的是误报）', async () => {
  /*
   * `advisories.test.ts` 那张表只证明"写了 @9 会吼"，**它证不出"没写就不吼"** ——
   * 一个无条件 emit 的实现能让那张表全绿。那是本仓反复记的那一族的又一格：
   * 提醒一旦在合法写法上响，人学会的是跳过提醒，而不是修用例
   *（`SLEEP_USED` 与 `hintOnTimeout` 那两处都为这件事写过"只在必要时说"）。
   *
   * 这条同时管住另一种坏法：把判据写成 `ref.includes('@')` 之外再放宽到
   * "只要 ref 里有版本号字样"，那会让 `scn.v1login`（id 里带 v1）也中枪。
   */
  const child = defineScenario({
    schemaVersion: '1', id: 'scn.plain', name: '子', env: { environmentRef: 'unit' },
    body: [{ ...b('n'), kind: 'noop' }],
  } as unknown as ScenarioDraft);
  const report = await run(
    scen([{ ...b('c1'), kind: 'call', scenarioRef: 'scn.plain' } as StepDraft]),
    { adapters: { callScenario: async () => child } as never },
  );
  // 夹具自检：call 真跑到了，否则"没有这条提醒"只是因为压根没跑到那一步
  assert.ok((report.childRuns ?? []).length >= 1, '夹具前提：子场景没跑起来，那"没报提醒"是空测试');
  const fired = report.events.filter(
    (e) => e.kind === 'lint.reported' && (e.data as { code?: string })?.code === 'CALL_VERSION_IGNORED');
  assert.deepEqual(fired, [], `没写 @版本 就不该说版本被忽略：${JSON.stringify(fired)}`);
});

test('两个不同步骤 call 同一个带版本的 ref 时，提醒里**两个步骤都在**', async () => {
  /*
   * 这条是**我自己犯过的那个错的回归测试**：第一版为了"一次 run 只吼一声"
   * 在解释器里记了一张按 ref 去重的 Set，于是第二个 call 步骤的那条 emit
   * 被压掉，提醒里的 stepIds 只剩第一个步骤 —— 报告说的比发生过的少，
   * 而那正是本仓最贵的那一族。
   *
   * 正确做法是不在 emit 侧去重，交给 `collectAdvisories` 按 (code, detail) 合并：
   * 它合并的是**展示**，`stepIds` 与 `count` 都留着。
   */
  const child = defineScenario({
    schemaVersion: '1', id: 'scn.twice', name: '子', env: { environmentRef: 'unit' },
    body: [{ ...b('n'), kind: 'noop' }],
  } as unknown as ScenarioDraft);
  const report = await run(
    scen([
      { ...b('ca'), kind: 'call', scenarioRef: 'scn.twice@2' } as StepDraft,
      { ...b('cb'), kind: 'call', scenarioRef: 'scn.twice@2' } as StepDraft,
    ]),
    { adapters: { callScenario: async () => child } as never },
  );
  const fired = report.events.filter(
    (e) => e.kind === 'lint.reported' && (e.data as { code?: string })?.code === 'CALL_VERSION_IGNORED');
  assert.equal(fired.length, 2, `两处 call 各发一条（合并是展示侧的事）。实际 ${fired.length} 条`);
  assert.deepEqual([...new Set(fired.map((e) => e.stepId))].sort(), ['ca', 'cb'],
    '两个发起步骤都要在，否则"谁在跑这份没版本语义的 IR"只说了一半');
});
