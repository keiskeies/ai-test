/**
 * 测试夹具。四个测试文件共用，避免「同一个造场景的函数抄四遍后各自漂移」。
 *
 * 这里刻意只做一件事：**把 zod 默认值填掉的噪音从测试正文里拿掉**，
 * 让每条断言读起来就是它要验证的行为本身。
 */
import assert from 'node:assert/strict';

import { runScenario, deterministicClock, type AdapterRegistry, type RunReport } from '../src/index.js';
import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';

export type { StepDraft } from '@atest/ir';

/** 步骤基字段。id 必填且运行内唯一（$.step.<id> 引用靠它） */
export const b = (id: string): { id: string } => ({ id });

/** 造一个合法场景。IR 不合法直接让测试失败 —— 而不是把坏 IR 喂进引擎得出无意义的结论 */
export function scen(body: StepDraft[], extra: Partial<ScenarioDraft> = {}): Scenario {
  return defineScenario({
    schemaVersion: '1', id: 'scn.test', name: 'test scenario',
    env: { environmentRef: 'unit' }, body, ...extra,
  } as ScenarioDraft);
}

export interface RunOverrides {
  inputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  adapters?: AdapterRegistry;
  secretResolver?: (ref: string) => string;
  signal?: { aborted: boolean };
  maxCostUsd?: number;
  seed?: number;
}

/** 一律用冻结时钟：测试里的时间与随机数必须是可复现的 */
export async function run(s: Scenario, over: RunOverrides = {}): Promise<RunReport> {
  return runScenario({
    scenario: s,
    inputs: over.inputs, env: over.env, secretResolver: over.secretResolver,
    adapters: over.adapters ?? {}, clock: deterministicClock(over.seed ?? 42),
    signal: over.signal, maxCostUsd: over.maxCostUsd,
  });
}

/** 取某步骤结果。取不到就直接失败并列出实际有哪些 —— 否则 assert.equal(undefined,...) 很难读 */
export function res(r: RunReport, id: string): RunReport['results'][number] {
  const x = r.results.find((y) => y.stepId === id);
  assert.ok(x, `没有步骤 "${id}" 的结果（实际：${r.results.map((y) => y.stepId).join(', ') || '无'}）`);
  return x!;
}

/** 一个 GET 请求步骤的最小写法 */
export const getStep = (id: string, url = 'http://x/y'): StepDraft => ({ ...b(id), kind: 'http', request: { method: 'GET', url } });

/**
 * 合法定位器的最小写法。
 *
 * `{ intent: '登录按钮' }` 看着够用，但 schema 明确要求 primary / fallbacks /
 * compiledTo 至少之一 —— 「只有意图」的定位器运行时什么也定不到，
 * 拒绝它是对的。测试要测别的规则，就别被这条挡住，所以给个能过的最小体。
 */
export const loc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  intent: '登录按钮',
  primary: { by: 'testid', value: 'login-btn' },
  ...over,
});

/** testid 定位（最便宜的一级，用于不需要定位细节的用例） */
export const tapStep = (id: string, over: Record<string, unknown> = {}): StepDraft => ({
  ...b(id), kind: 'tap', target: loc(over),
});
