/**
 * 门禁判定与退出码的契约测试。
 *
 * **判据是"退出码"，因为那是 CI 唯一读得到的东西。**
 * 一次 `atest run` 在流水线里的全部对外接口就是：一个整数、一些日志、一个 zip。
 * 整数错了，红/绿就错了，日志写得再好也没用。
 *
 * 这里刻意**不起子进程**。走 spawn 测到的是 argv 拼接、PATH、编码、超时，
 * 而不是"error 为什么优先于 fail"。判定逻辑必须是纯函数才能这样直接调 ——
 * 这也是 gate.ts 与 exit.ts 不 import node 内置模块的原因。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunReport } from '@atest/engine';
import type { StepResult } from '@atest/ir';
import type { Scenario } from '@atest/ir';

import { EXIT, RESERVED_EXIT } from '../src/exit.js';
import { gateAfterRun, gateBeforeRun, isTriage } from '../src/gate.js';

function scen(over: Partial<Scenario> = {}): Scenario {
  return {
    schemaVersion: '1', id: 'scn.g', name: 'g', tags: [], mode: 'script', frozen: true,
    inputs: [], outputs: [], env: { environmentRef: 'unit' }, setup: [], body: [], teardown: [],
    provenance: { origin: 'human' },
    config: { timeoutMs: 60_000, maxCostUsd: 0.5, retries: { count: 0, backoff: 'exponential', baseMs: 2000, maxMs: 10_000, retryOn: [] }, concurrencySafe: true, dirty: false },
    ...over,
  } as Scenario;
}

function rep(rows: Array<{ stepId: string; status: StepResult['status']; kind?: StepResult['kind']; cause?: string }>): RunReport {
  const tally = { pass: 0, fail: 0, error: 0, healed: 0, skipped: 0, triaged: 0 };
  for (const r of rows) tally[r.status as keyof typeof tally]++;
  return {
    runId: 'run_g', status: 'fail', startedAt: 1, durMs: 10,
    results: rows.map((r) => ({ kind: 'assert', durMs: 1, healed: r.status === 'healed', ...r })) as unknown as RunReport['results'],
    events: [], outputs: {}, costUsd: 0, tally, summary: 'x',
  };
}

// ── 退出码表本身 ──────────────────────────────────────────────────────────

test('退出码不落在保留段（npm/shell 会用 126/127/128+signum，撞上了"Ctrl-C"会被读成业务结论）', () => {
  const used = Object.values(EXIT) as number[];
  for (const code of used) {
    assert.ok(!RESERVED_EXIT.includes(code), `退出码 ${code} 与保留段冲突`);
    assert.ok(code >= 0 && code <= 125, `退出码 ${code} 超出可用范围`);
  }
  // 0 必须只表示"全绿"。曾有 CLI 用 0 表示"跳过"，于是"什么都没跑"是绿的
  assert.equal(EXIT.OK, 0);
  // 每个码只出现一次：两个含义共用一个码时，CI 分支无法区分
  assert.equal(new Set(used).size, used.length, `退出码有重复：${used.join(',')}`);
});

test('TEST_FAILED 与 RUNTIME 必须分开：一个是"测出产品坏了"，一个是"没测成"', () => {
  assert.notEqual(EXIT.TEST_FAILED, EXIT.RUNTIME);
  // 而且二者都要与 INVALID 分开：配置写错时让人去查产品代码是纯浪费
  assert.notEqual(EXIT.TEST_FAILED, EXIT.INVALID);
  assert.notEqual(EXIT.RUNTIME, EXIT.INVALID);
});

// ── 执行前的闸 ────────────────────────────────────────────────────────────

test('--ci 且 frozen=false：拒绝，且 refused=true（一个请求都不发）', () => {
  const d = gateBeforeRun({ scenario: scen({ frozen: false }), ci: true, allowUnfrozen: false });
  assert.equal(d.refused, true, '必须是"拒绝执行"而不是"跑完再说"：场景里可能有 POST/下单/删除');
  assert.equal(d.code, EXIT.INVALID);
  assert.match(d.reasons.join('\n'), /frozen/);
});

test('非 --ci 时 frozen=false 照样放行（本地写用例时默认未冻结，拦它等于拦日常工作）', () => {
  const d = gateBeforeRun({ scenario: scen({ frozen: false }), ci: false, allowUnfrozen: false });
  assert.equal(d.refused, false);
  assert.equal(d.code, EXIT.OK);
});

test('--ci + --allow-unfrozen：放行但必须留话（结果不能当门禁依据）', () => {
  const d = gateBeforeRun({ scenario: scen({ frozen: false }), ci: true, allowUnfrozen: true });
  assert.equal(d.refused, false, '显式开关就该放行');
  assert.ok(d.reasons.length > 0, '放行也得说明白，否则下次有人拿这次结果当质量结论');
  assert.match(d.reasons.join('\n'), /不能当|门禁/);
});

test('--ci 且缺 provenance：拒绝。frozen 与 provenance 都缺时先报 frozen', () => {
  const noProv = gateBeforeRun({ scenario: scen({ provenance: undefined }), ci: true, allowUnfrozen: false });
  assert.equal(noProv.refused, true);
  assert.match(noProv.reasons.join('\n'), /provenance/);

  const both = gateBeforeRun({ scenario: scen({ frozen: false, provenance: undefined }), ci: true, allowUnfrozen: false });
  assert.match(both.reasons.join('\n'), /frozen/, '未冻结是更前置的状态。先报 provenance 会让人去补错的东西');
});

test('非 CI 模式对缺 provenance 完全沉默（本地调试不该被来源记录挡住）', () => {
  const d = gateBeforeRun({ scenario: scen({ provenance: undefined }), ci: false, allowUnfrozen: false });
  assert.deepEqual(d.reasons, []);
});

// ── 执行后的判定 ──────────────────────────────────────────────────────────

test('全绿 -> 0', () => {
  const d = gateAfterRun({ scenario: scen(), report: rep([{ stepId: 'a', status: 'pass' }]), ci: true, allowUnfrozen: false });
  assert.equal(d.code, EXIT.OK);
});

test('断言失败 -> TEST_FAILED，error -> RUNTIME（两者不能同码）', () => {
  const f = gateAfterRun({ scenario: scen(), report: rep([{ stepId: 'a', status: 'fail', cause: 'product-bug' }]), ci: true, allowUnfrozen: false });
  assert.equal(f.code, EXIT.TEST_FAILED);
  const e = gateAfterRun({ scenario: scen(), report: rep([{ stepId: 'a', status: 'error', cause: 'env-unavailable' }]), ci: true, allowUnfrozen: false });
  assert.equal(e.code, EXIT.RUNTIME);
});

test('同时有 error 与 fail 时报 error 优先：环境没通时 fail 的结论本身不可信', () => {
  const d = gateAfterRun({
    scenario: scen(), report: rep([{ stepId: 'a', status: 'error' }, { stepId: 'b', status: 'fail' }]),
    ci: true, allowUnfrozen: false,
  });
  assert.equal(d.code, EXIT.RUNTIME);
  assert.match(d.reasons.join('\n'), /不可信/);
});

test('容器步骤不算结论：一次 forEach 里一个失败只是 1 个失败，不是 N 个', () => {
  const d = gateAfterRun({
    scenario: scen(),
    report: rep([
      { stepId: 'loop', status: 'fail', kind: 'forEach' },
      { stepId: 'a', status: 'pass' }, { stepId: 'b', status: 'fail' },
    ]),
    ci: true, allowUnfrozen: false,
  });
  assert.equal(d.code, EXIT.TEST_FAILED);
  assert.match(d.reasons.join('\n'), /1 个断言失败/, `实际理由：${d.reasons.join(' / ')}`);
});

test('容器 error 且叶子也有 error 时只数一次（orphan 判据反过来就会数成 2 个）', () => {
  // 这条钉的是 orphan 判据的**另一半**：不能只看"容器报了 error"就算一条，
  // 还要看**有没有叶子替它背书**。上一条测试钉的是 fail 那半（1 个断言失败），
  // 但 error 那半此前没人钉 —— 变异「叶子有同状态结论时也算容器那份」就是靠这个空档
  // 活下来的（它改的是 orphanErrors 那行，而当时全仓没有一条 fixture 让
  // 容器与叶子**同时**是 error）。
  const d = gateAfterRun({
    scenario: scen(),
    report: rep([
      { stepId: 'loop', status: 'error', kind: 'forEach', cause: 'env-unavailable' },
      { stepId: 'body', status: 'error', kind: 'http', cause: 'env-unavailable' },
    ]),
    ci: true, allowUnfrozen: false,
  });
  assert.equal(d.code, EXIT.RUNTIME);
  assert.match(d.reasons.join('\n'), /1 个步骤\*\*出错\*\*/, `容器那条是传递上来的，不该再数一遍。实际理由：${d.reasons.join(' / ')}`);
});

test('容器自己报 fail 且没有叶子替它背 => TEST_FAILED（引擎目前造不出这个形状，所以手写 fixture）', () => {
  // **为什么这条用手工 fixture 而不是跑真引擎**（不是偷懒，要说清）：
  // 逐个查过容器的 fail 是从哪儿来的 —— runChildren 把子步骤的 fail 原样往上递
  // （interpreter.ts:320-324），forEach/while 转递 runChildren 的状态，parallel 的
  // fail 只从某一条**已被记录的分支结果**里取（:502-505），RunAborted 那条路径则会在
  // 外层 catch 里再追一条 `__run__` 的 **error** 叶子。所以**每一处容器 fail 旁边
  // 都有一条替它背书的叶子 fail** —— orphanFails 在现在的引擎下是**空集**。
  // 那这个分支是不是白写？不是：它是"以后加了新容器 kind / 改了递送方式"时的兜底，
  // 而 gate 是纯函数，判据该对**所有能进来的输入**成立，不该只对"今天恰好能产出的那些"成立。
  // 但**必须写明白它当前不可达**，否则下一个人会拿它当"引擎真会这样"的证据。
  const d = gateAfterRun({
    scenario: scen(),
    report: rep([
      { stepId: 'ok1', status: 'pass', kind: 'assert' },
      { stepId: 'p0', status: 'fail', kind: 'parallel' },
    ]),
    ci: true, allowUnfrozen: false,
  });
  assert.equal(d.code, EXIT.TEST_FAILED, `容器自己报 fail 必须让 CI 红。实际理由：${d.reasons.join(' / ')}`);
  assert.match(d.reasons.join('\n'), /p0/);
});

test('容器自己报的 fail 不因 triage 降级（否则带个标签就能什么都没验还拿 0）', () => {
  // triage 降级的对象是"生成的断言第一轮过严"。而"控制流压根没把子步骤跑出来"
  // 不是过严，是没测 —— 跟着降级就等于给假绿开了个标签开关。
  const s = scen({ tags: ['triage'] });
  const d = gateAfterRun({
    scenario: s,
    report: rep([
      { stepId: 'ok1', status: 'pass', kind: 'assert' },
      { stepId: 'p0', status: 'fail', kind: 'parallel' },
    ]),
    ci: true, allowUnfrozen: false,
  });
  assert.notEqual(d.code, EXIT.OK, 'triage 不能把"没测"洗成"测过且没问题"');
  assert.match(d.reasons.join('\n'), /不因 triage 降级|压根没断言到/, `要说清为什么不降级。实际理由：${d.reasons.join(' / ')}`);
});

test('零个叶子步骤不能判通过（空场景是最危险的假绿）', () => {
  const d = gateAfterRun({
    scenario: scen(), report: rep([{ stepId: 'loop', status: 'pass', kind: 'sequence' }]),
    ci: true, allowUnfrozen: false,
  });
  assert.notEqual(d.code, EXIT.OK, '只有容器、没有任何断言的场景必须被拦');
  assert.match(d.reasons.join('\n'), /没有一条断言|没测/, '要说清是"一条断言都没有"，而不是含糊的"没测"');
});

test('只有一条 set 步骤的场景不算"1 个断言全部通过"（这句话此前是假的，而且是绿的）', () => {
  // 这条是从 gate-real.test.ts 那个真实 IR 版本反推回手写 fixture 的：
  // 那边要跑引擎，快不起来；这边把**计数口径**单独钉住，改坏立刻红。
  // 旧行为：leaves = 非容器步骤，于是 set 被算进"通过的断言数"，
  // 退出码 0 + 一句"1 个断言全部通过"。set 步骤不产出任何断言结论。
  const d = gateAfterRun({
    scenario: scen(), report: rep([{ stepId: 'seed', status: 'pass', kind: 'set' }]),
    ci: true, allowUnfrozen: false,
  });
  assert.equal(d.code, EXIT.INVALID, `只有 set 的场景没有断言结论，不能是 0。实际理由：${d.reasons.join(' / ')}`);
  assert.match(d.reasons.join('\n'), /1 个步骤里没有一条断言/, '总数要说叶子数，断言数要单说，两者不能混');
});

test('绿灯理由里的数字只能数断言：一条 set + 一条 assert 要说"1 条断言全部通过"，不是 2', () => {
  // 这条钉的是**那句话的数字**，与上一条（能不能是 0）是两件事。
  // CI 日志里人只看这一句；数字把 set 算进去，"我们这次验了 2 条"就是假话，
  // 而它是绿的，所以没人会去核。
  const d = gateAfterRun({
    scenario: scen(),
    report: rep([{ stepId: 'seed', status: 'pass', kind: 'set' }, { stepId: 'a', status: 'pass', kind: 'assert' }]),
    ci: true, allowUnfrozen: false,
  });
  assert.equal(d.code, EXIT.OK, '有一条通过的断言，场景该放行');
  assert.match(d.reasons.join('\n'), /1 条断言全部通过/, `数字只能数断言。实际理由：${d.reasons.join(' / ')}`);
});

test('healed 不是通过：跑通了但没人审过定位器改动', () => {
  const d = gateAfterRun({ scenario: scen(), report: rep([{ stepId: 'a', status: 'healed' }]), ci: true, allowUnfrozen: false });
  assert.equal(d.code, EXIT.TEST_FAILED, '自愈默认可疑：否则用例会慢慢被自愈改成"永远通过"');
  assert.equal(d.attention.length, 1);
  assert.match(d.attention[0]!, /自愈/);
});

// ── triage 降级 ───────────────────────────────────────────────────────────

test('triage 场景：失败降级为清单，但必须把降级数说出来', () => {
  const s = scen({ tags: ['generated', 'requiredMissing', 'triage'] });
  assert.equal(isTriage(s), true);
  const d = gateAfterRun({ scenario: s, report: rep([{ stepId: 'a', status: 'fail' }, { stepId: 'b', status: 'fail' }]), ci: true, allowUnfrozen: false });
  assert.equal(d.code, EXIT.OK, '首轮一片红会让人直接关掉整个门禁（docs/05 §3 要点 1）');
  assert.equal(d.suppressedFails, 2, '降级了多少必须可数，否则这就是偷偷涂绿');
  assert.equal(d.attention.length, 2);
  assert.match(d.reasons.join('\n'), /2 个失败降级/);
  // 实际文案是"把 triage 标签去掉它们就进门禁"。断言按**意图**（出现"去掉"+标签名）
  // 而不是抄整句，否则改一个字就红，而改文案不该红
  assert.match(d.reasons.join('\n'), /triage 标签去掉/, '要给出下一步动作，否则清单永远没人处理');
});

test('triage 只降级 fail，不降级 error（环境没通就是没通，跟策略首轮无关）', () => {
  const s = scen({ tags: ['triage'] });
  const d = gateAfterRun({ scenario: s, report: rep([{ stepId: 'a', status: 'error' }]), ci: true, allowUnfrozen: false });
  assert.equal(d.code, EXIT.RUNTIME);
});

test('triage 场景里的 healed 仍然要人审（降级不是免审）', () => {
  const s = scen({ tags: ['triage'] });
  const d = gateAfterRun({ scenario: s, report: rep([{ stepId: 'h', status: 'healed' }]), ci: true, allowUnfrozen: false });
  assert.equal(d.attention.length, 1, 'healed 出现在 attention 里，与是否 triage 无关');
});

test('非 triage 场景即使带 generated 标签也正常判失败（标签只有 triage 有语义）', () => {
  const d = gateAfterRun({
    scenario: scen({ tags: ['generated'] }), report: rep([{ stepId: 'a', status: 'fail' }]),
    ci: true, allowUnfrozen: false,
  });
  assert.equal(d.code, EXIT.TEST_FAILED);
});

// ── 执行前拒绝时，执行后的判定不得"改判" ──────────────────────────────────

test('执行前已拒绝时，gateAfterRun 原样返回拒绝而不是看结果', () => {
  const scenario = scen({ frozen: false });
  const after = gateAfterRun({ scenario, report: rep([{ stepId: 'a', status: 'pass' }]), ci: true, allowUnfrozen: false });
  assert.equal(after.refused, true);
  assert.equal(after.code, EXIT.INVALID, '全绿的结果不能把"不该跑的运行"变成通过');
});
