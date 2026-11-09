/**
 * Dry-run（编辑器常驻面板 + Agent 的第三道闸）。
 * 不求值网络、不碰设备：只检查「结构上能不能跑起来」。
 */
import type { Scenario } from '@atest/ir';
import { lintScenario, toReport, type LintIssue, type LintReport, type LintContext } from './lint.js';
import { VarSpace } from './vars.js';
import { validateExpr } from './expr.js';

export interface DryRunResult extends LintReport {
  /** 输入参数的解析结果（缺哪个必填项） */
  missingInputs: string[];
  /** 表达式合法但引用了运行时才有的东西 —— 只列出，不算错 */
  exprSummaries: { stepId: string; expr: string; refs: string[] }[];
  /** 预估步骤数与最坏耗时（用于 UI 提示「这条场景大概要跑多久」） */
  estimate: { steps: number; minMs: number; needsDevice: boolean; targets: string[] };
}

/**
 * 干跑：静态闸 + 输入完备性 + 表达式引用摘要。
 * 与真执行共用 lint 规则，所以「dry-run 过了但真跑炸了」的情况应当被视为 bug。
 */
export function dryRun(scenario: Scenario, inputs: Record<string, unknown> = {}, ctx: LintContext = {}): DryRunResult {
  const issues: LintIssue[] = lintScenario(scenario, ctx);
  const missingInputs = scenario.inputs.filter((p) => p.required && !(p.name in inputs) && p.default === undefined).map((p) => p.name);
  if (missingInputs.length) {
    issues.push({ code: 'VAR_UNDEFINED', level: 'error', message: `缺少必填输入：${missingInputs.join(', ')}`, fix: '在运行参数里提供，或在场景里给 default' });
  }

  const exprSummaries: DryRunResult['exprSummaries'] = [];
  const scanExpr = (o: Record<string, unknown>, stepId: string): void => {
    for (const key of ['condition', 'when', 'value', 'items']) {
      const v = o[key];
      if (typeof v === 'string' && v.includes('$')) {
        const err = validateExpr(v);
        if (err) issues.push({ code: 'EXPR_SYNTAX', level: 'error', stepId, message: `${key} 表达式错误：${err}` });
      }
    }
  };
  const visit = (steps: unknown[]): void => {
    for (const raw of steps) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.id === 'string') scanExpr(s, s.id);
      for (const key of ['steps', 'then', 'else', 'default']) { const v = s[key]; if (Array.isArray(v)) visit(v as unknown[]); }
      const cases = s.cases;
      if (Array.isArray(cases)) for (const c of cases as { steps?: unknown[] }[]) if (c.steps) visit(c.steps);
    }
  };
  visit([...scenario.setup, ...scenario.body, ...scenario.teardown]);

  // 变量空间只做结构初始化，确认 inputs/env 能建起来（构造期报错说明 IR 有问题）。
  // 带上 inputs 声明，好让 VAR_UNDEFINED 不把"有 default 的输入"报成未定义
  new VarSpace({ inputs, inputDefs: scenario.inputs, env: scenario.env });

  let steps = 0;
  const count = (arr: unknown[]): void => {
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      steps++;
      const s = raw as Record<string, unknown>;
      for (const key of ['steps', 'then', 'else', 'default']) { const v = s[key]; if (Array.isArray(v)) count(v as unknown[]); }
      const cases = s.cases;
      if (Array.isArray(cases)) for (const c of cases as { steps?: unknown[] }[]) if (c.steps) count(c.steps);
    }
  };
  count([...scenario.setup, ...scenario.body, ...scenario.teardown]);

  const needsDevice = scenario.targets.some((t) => ['android', 'ios', 'harmony'].includes(t));
  return {
    ...toReport(issues), missingInputs, exprSummaries,
    estimate: { steps, minMs: steps * 50, needsDevice, targets: scenario.targets },
  };
}

export { lintScenario, toReport };
export type { LintIssue, LintReport, LintContext };
