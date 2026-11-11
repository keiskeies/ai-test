/**
 * Dry-run（编辑器常驻面板 + Agent 的第三道闸）。
 * 不求值网络、不碰设备：只检查「结构上能不能跑起来」。
 */
import type { Scenario } from '@atest/ir';
import { lintScenario, toReport, type LintIssue, type LintReport, type LintContext } from './lint.js';
import { VarSpace } from './vars.js';

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
  /*
   * **这里从前有一份自己的表达式扫描**（`scanExpr` + 一个手抄的字段名清单
   * `['condition','when','value','items']`），本轮删掉了。三个理由，从重到轻：
   *
   *  1. **它是 `lintScenario` 里那一查的重复实现**，而重复实现的坏法本仓已经数过很多轮：
   *     两份清单**同时**坏、方向相反 —— 漏抄 `items` 与 `switch.value`（真表达式，
   *     于是没有任何生产可达的闸管它们：lint 不查，而 dryRun 查 items 但它**零生产调用方**），
   *     多抄一个 `value`（`act.value` / `input.value` 是 `ValueSchema`，
   *     那是**要填进输入框的字面量**）。实测改前填 `价格 3$` 会得
   *     「value 表达式错误：尾部有多余内容 "3"」，`EXPR_SYNTAX` 是 error 级。
   *  2. **它自己还多加了一个前置条件** `v.includes('$')`，于是 `nopefn(1)` / `1 +`
   *     这类不含 `$` 的坏表达式在这一侧**看不见**，而在 lint 那一侧看得见 ——
   *     同一个场景、同一个字段，两道闸给出不同答案。
   *  3. 删掉之后**覆盖面一点没少**：上面第 24 行那句 `lintScenario(...)` 的返回值
   *     直接进 `issues`，而 lint 那一查走的是 `walk([...setup, ...body, ...teardown])`
   *     —— 与这份被删的 `visit` 完全同样的三层遍历（`CHILD_KEYS` 也含
   *     `steps/then/else/default` 与 `cases[].steps`）。
   *
   * 顺带修掉一个**改前就存在**的双报：`when` / `condition` 两边都查，所以同一条
   * 错误在 dry-run 的 issues 里出现**两次**（实测：`when: '$.n['` → lint 1 条、
   * dry-run 2 条）。编辑器面板把它渲染成两行同样的红字，用户会以为有两个问题。
   *
   * ⚠ **"dry-run 与 lint 结论一致"这件事现在是结构性的**（同一次调用），不再需要测试钉
   *    —— 而**这正是删掉重复实现的收益**，不是测试变少了。有牙的那几条仍然在：
   *    `expr-strict.test.ts` 里那三条同名的：
   *      · 「dry-run 与 lint 管的字段**现在一致**（从前 dryRun 多管 items、错管 value）」
   *      · 「**反方向**：往输入框里填的字面量里带 `$` 也不许被当表达式校验」
   *      · 「同一步骤的同一条表达式在 dry-run 里**只出现一次**（改前是两次）」
   *    外加 `ir/test/expr-fields.test.ts` 对着源码正则独立核对派生表那一组。
   *    （**引用测试名要照抄原名**：这三处我原先写的是自己简化的说法，
   *     照着去找会以为少了测试 —— 与"注释里写一个不存在的函数名"是同一种错。）
   *
   * ⚠ `exprSummaries` **至今恒为空数组**（"表达式合法但引用了运行时才有的东西"
   *    这一栏从来没有生产者，全仓也没有消费方 —— `grep -rn exprSummaries` 只剩
   *    类型声明、这里的声明与返回那一行）。本轮**没删它**：它是 dryrun 设计里的
   *    一栏，删除要连着 `DryRunResult` 这个对外类型一起做，而前端还没接。
   *    但它现在这个形状**看着像有内容**，属于 docs/08 §3 那一族（"少一件东西看起来
   *    像什么都没少"），已登记 docs/14 §5。
   */

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
