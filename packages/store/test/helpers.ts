/**
 * store 包测试夹具。
 *
 * 这里**不 import engine 的 helpers**，而是走 engine 的公开导出（b/scen 由 index 导出？见下）——
 * engine 的 test/helpers.ts 不在 package exports 里，`@atest/engine/test-helpers` 会解析失败。
 * 所以这里自带一份最小版本；两份都极薄（填 zod 默认值 + 冻结时钟），
 * 漂移风险可忽略，而为了能 import 去给 engine 加一个"测试专用导出面"
 * 会诱导别人往生产 exports 里塞测试代码。
 */
import { defineScenario, type Scenario, type ScenarioDraft, type StepDraft } from '@atest/ir';
import { deterministicClock, runScenario, type AdapterRegistry, type RunReport } from '@atest/engine';

export type { StepDraft } from '@atest/ir';

export const b = (id: string): { id: string } => ({ id });

export function scen(body: StepDraft[], extra: Partial<ScenarioDraft> = {}): Scenario {
  return defineScenario({
    schemaVersion: '1', id: 'scn.store', name: 'store test scenario',
    env: { environmentRef: 'unit' }, body, ...extra,
  } as ScenarioDraft);
}

export async function run(s: Scenario, over: { adapters?: AdapterRegistry } = {}): Promise<RunReport> {
  return runScenario({
    scenario: s, adapters: over.adapters ?? {}, clock: deterministicClock(42),
    env: { baseUrl: 'https://api.test' },
  });
}
