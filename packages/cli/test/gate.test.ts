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

test('零个叶子步骤不能判通过（空场景是最危险的假绿）', () => {
  const d = gateAfterRun({
    scenario: scen(), report: rep([{ stepId: 'loop', status: 'pass', kind: 'sequence' }]),
    ci: true, allowUnfrozen: false,
  });
  assert.notEqual(d.code, EXIT.OK, '只有容器、没有任何断言的场景必须被拦');
  assert.match(d.reasons.join('\n'), /没测|0 个叶子/);
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
