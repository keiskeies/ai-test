/**
 * Dry-run（编辑器常驻面板 + Agent 的第三道闸）。
 * 不求值网络、不碰设备：只检查「结构上能不能跑起来」。
 */
import { deriveNeedsDevice, type Scenario } from '@atest/ir';

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

  /*
   * 只**结构自检**，不求值 default。
   *
   * `new VarSpace(...)` 的返回值在这一行就丢了，所以它唯一能做的事是**抛** ——
   * 而它的 `inputs` 是调用方（编辑器面板 / Agent 那道闸）**已经填好的实参**：
   * 面板按 IR 的 `default` 预填表单之后才调 dry-run，于是"补 default"这一查在这里
   * 本来就是空转。真正的 default 求值发生在两个真入口（interpreter / executor），
   * default 里写坏的东西由 `lint.ts` 那条值形态语法查负责报（`eachValuePosition` 那一块）。
   *
   * 改前两件事顺带修掉：
   *  1. `env: scenario.env` 是**类型对错而形状错**的对象 —— `ScenarioSchema.env` 是
   *     `{environmentRef, pinRevision?}`（环境引用），而 interpreter / executor 传的是
   *     **环境变量表**（`process.env` 那一类）。于是 `$env.baseUrl` 在 dry-run 这一侧
   *     永远查不到，在真跑那一侧能查到。形状不同的两侧给相反答案，正是本轮删掉
   *     dry-run 自己那套表达式校验时处理的同一个毛病（见上面第 40 行那段）。
   *     干跑拿不到真实环境（那要靠真环境 + 版本锁定），所以这里给**空表**，
   *     而不是继续挂着那个形状不对的东西。
   *  2. `inputDefs` 一并去掉：自 `VarSpaceInit` 起，带声明就**必须**带求值器
   *     （类型上强制，漏接一个入口会编译不过），而这里既不求值、也不读它。
   */
  new VarSpace({ inputs, env: {} });

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

  /*
   * `needsDevice` 从前读的是 `scenario.targets.some(是移动端)`，两个方向都坏，本轮都修：
   *  1. **它读的是那个冗余字段**，而那个字段只从 `body` 推（`ir/index.ts` 的
   *     `withDerivedTargets`）。所以「setup 里 `device` + body 里 `tap`」这种**最常见**的
   *     移动端写法推出来是空集 → 面板上写"不要设备"，而它要两台。
   *     `lint.ts` 那条同类判据早就改成现算三层了，这一处是漏掉的那个消费者
   *     （docs/08 §3：「每个消费者都各自正确，而它们对同一件事的假设互不相容」）。
   *  2. **判据本身来自端集合**，而本轮 `targetsOfStep` 改对之后，端集合里只剩 `device`
   *     会发言 —— 一份漏写 `device` 步的裸 `tap` 场景会答"不要设备"，
   *     而它其实跑不起来。改用 `deriveNeedsDevice`（读档位不读平台），理由与
   *     `lint.ts` 那道过滤同一份，写在 `ir/src/scenario.ts` 那个函数头上。
   *
   * 同一格里的 `targets` 仍回显 `scenario.targets`，但**那个字段本轮在根上修好了**：
   * `withDerivedTargets` 从前只走 `body`（同一句"只知道自己那一段"的病，根因只有一行），
   * 现在走三层。所以这里不必自己再推一遍 —— 而自己推一遍还有第二个坏处：
   * **作者显式写了 `targets` 的场景会被推导覆盖**，屏幕上那一栏于是与 IR 文件不一致，
   * 而显式写下的值是**声明能力**（"这条还要一台 iOS 机做对照"），比推导强。
   *
   * `needsDevice` 与 `targets` 现在同源不同问：前者问步骤（"有没有移动端步骤要机器"），
   * 后者读声明（"这条场景说自己要哪些端"）。两者可以合法地不同 ——
   * 例如显式写了 `targets:['ios']` 而一个移动步骤都还没写，那正是"先声明、待补步骤"的形态。
   *
   * 改前那份纯 iOS 场景这里会多列一个 android（替 mobile 步骤猜出来的那一端），
   * 前端 `app.ts` 直接把它画成「端 ios / android」，于是那条从没要过安卓机的用例
   * 看起来要在两台机器上跑。
   */
  const three = [...scenario.setup, ...scenario.body, ...scenario.teardown];
  const needsDevice = deriveNeedsDevice(three);
  return {
    ...toReport(issues), missingInputs, exprSummaries,
    estimate: { steps, minMs: steps * 50, needsDevice, targets: scenario.targets },
  };
}

export { lintScenario, toReport };
export type { LintIssue, LintReport, LintContext };
