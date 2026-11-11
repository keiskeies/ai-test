/**
 * IR 的**值求值**（字面量 / 引用 / 表达式 / 生成器）—— 唯一一份实现。
 * 文件名刻意不叫 values.ts：`@atest/ir` 里已经有个 values.ts 定义值的**形状**，
 * 本文件管的是值的**求值**，重名会让人在 import 时拿错包。
 *
 * 为什么单独成文件：这段逻辑原先长在 interpreter 的闭包里。
 * M0.6 要加第二种执行形态（压测的预编译路径，docs/09 §4.2），
 * 如果把它**抄一份**过去，两条路径就会各自演化 ——
 * 于是出现"功能回归全绿、压测报退化 25%"这种查三天查不出来的东西。
 * 唯一可靠的做法是**共用同一份代码**，而不是"两份写得很像的代码"。
 *
 * 所以：解释器与预编译计划都调本文件的 resolveValue；
 * 谁想优化（比如预编译期把字面量固化），请在**本文件之上**加缓存层，
 * 而不是另起一条求值路径。
 */
import { compileExpr } from './expr.js';
import { VarError, type VarSpace } from './vars.js';
import type { Step } from '@atest/ir';
import type { Clock } from './adapters.js';

export interface ValueScope {
  vars: Pick<VarSpace, 'resolveRef' | 'asExprRoot' | 'visible'>;
  clock: Pick<Clock, 'now' | 'random'>;
}

/**
 * 把一个 IR 值解析成 JS 值。四种形态互斥，按 IR 的约定判定：
 * `{path}` / `{expr}` / `{gen}` 且**只有一个键**才算引用/表达式
 * （否则 `{"path": "src/a.ts"}` 这种普通对象会被误判成引用）。
 */
export function resolveValue(v: unknown, scope: ValueScope): unknown {
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (typeof o.path === 'string' && Object.keys(o).length === 1) {
    const r = scope.vars.resolveRef(o.path);
    // 未定义引用要抛：返回 undefined 会让它一路静默传下去，
    // 最后表现为"某字段是空的"，而真正的错在三步之前。
    if (!r.found) throw new VarError('引用未定义', o.path);
    return r.value;
  }
  if (typeof o.expr === 'string' && Object.keys(o).length === 1) {
    return compileExpr(o.expr).eval({ root: scope.vars.asExprRoot(), vars: scope.vars.visible(), now: scope.clock.now });
  }
  if (typeof o.gen === 'string') return generate(o.gen, (o.with as Record<string, unknown>) ?? {}, scope.clock);
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, scope));
  return Object.fromEntries(Object.entries(o).map(([k, vv]) => [k, resolveValue(vv, scope)]));
}

/**
 * 简易生成器。真实现应接 faker 并由 adapter 注入（引擎不许有 IO 依赖）。
 *
 * 时间类生成器一律走注入的 clock —— 早先它们直接读 Date.now()，
 * 于是"冻结时钟后回放结果逐字一致"在用到 email/oid 的场景上并不成立。
 */
export function generate(kind: string, w: Record<string, unknown>, clock: Pick<Clock, 'now' | 'random'>): unknown {
  const rnd = clock.random;
  switch (kind) {
    case 'int': { const min = Number(w.min ?? 0), max = Number(w.max ?? 1_000_000); return Math.floor(min + rnd() * (max - min + 1)); }
    case 'float': { const min = Number(w.min ?? 0), max = Number(w.max ?? 1); return +(min + rnd() * (max - min)).toFixed(Number(w.precision ?? 2)); }
    case 'string': { const len = Number(w.length ?? 8); const cs = 'abcdefghijklmnopqrstuvwxyz0123456789'; return Array.from({ length: len }, () => cs[Math.floor(rnd() * cs.length)]).join(''); }
    case 'bool': return rnd() > 0.5;
    case 'uuid': return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (rnd() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
    case 'email': return `test${clock.now().toString(36)}@example.com`;
    case 'phone': return `13${String(Math.floor(rnd() * 1e9)).padStart(9, '0')}`;
    case 'idcard': return `110101${1900 + Math.floor(rnd() * 100)}0101${String(Math.floor(rnd() * 10000)).padStart(4, '0')}`;
    case 'oid': return clock.now().toString(16).padStart(12, '0');
    case 'timestamp': return clock.now();
    case 'date': return new Date(clock.now()).toISOString().slice(0, 10);
    case 'datetime': return new Date(clock.now()).toISOString();
    case 'oneOf': { const arr = (w.values as unknown[]) ?? []; return arr[Math.floor(rnd() * arr.length)]; }
    case 'password': return `P@ss${String(Math.floor(rnd() * 1e6)).padStart(6, '0')}`;
    default: return undefined;
  }
}

// ── 两条执行路径共用的三个小语义 ───────────────────────────────────────────
// 放在这里是刻意的：预编译形态（executor.ts）要与解释器**逐字节同语义**，
// 而 toIterable "对象取 values"、looseEq "数字与数字字符串相等"这类细节
// 正是最容易在两份实现之间悄悄分叉的地方 —— 分叉的后果是
// "功能回归全绿、压测报退化"，极难查。

/** 迭代对象的取集合：数组原样，对象取 values，标量包成单元素（null 是空集） */
export function toIterable(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>);
  return v === undefined || v === null ? [] : [v];
}

/**
 * `items` 解析不出来时**抛错**而不是当成空表。
 *
 * 为什么单开一个函数而不是改 toIterable：toIterable 的"null/undefined 是空集"在
 * **别处**是对的（比如把响应里的可选数组喂给它），而 `forEach.items` 这里要的语义不一样 ——
 * 拆开两个函数比给一个函数加 flag 诚实，因为这两处语义**本来就该不同**。
 *
 * 为什么这里要抛：`items: 'missingList'`（变量名拼错）求值出 `undefined`，
 * 与"真的是空数组"在 toIterable 里**撞成同一个结果**（实测：两者都是 0 次迭代、
 * 场景整体绿）。于是数据驱动用例最典型的失效方式完全静默：
 * 变量名拼错 → 循环体一条都没跑 → 退出码 0。
 * 而 undefined 与 [] 在**调用点**是可区分的（实测 evalExpr 对未定义名字给 undefined，
 * 对声明过的空数组给 []），所以这个区分不需要新信息，只是此前没人看。
 *
 * 只管 undefined，**不管 null**：`set x = null` 之后 items 是运行时的真实值，
 * 那可能确实表示"没数据"；而 undefined 的含义窄得多 —— **那个名字压根不存在**。
 *
 * 抛错落点是 `forEach` 这个**容器步骤自己**的 error。这条能被看见的前提是
 * gate.ts 那侧刚修的"容器自己记的结论要进退出码"：在那之前，这个 error
 * 会被 leaves 过滤掉，等于把一种假绿换成另一种。
 */
export function iterItems(v: unknown): unknown[] {
  if (v === undefined) {
    // 抛 VarError 而不是 Error：解释器按异常类型定 cause（runStep 的 catch：
    // VarError -> case-stale，其它 -> env-unavailable）。用 Error 会把"用例里变量名拼错"
    // 报成"环境有问题"，值班人去查一个好好的环境 —— 这正是 cause 这个字段存在要防的事。
    throw new VarError(
      'forEach 的 items 求值为 undefined：这个变量不存在（拼写？还没 set/extract？声明在别的分支里？）',
      'forEach.items',
    );
  }
  return toIterable(v);
}

/**
 * 把一张 IR 值表求值成 `Record<string, string>`。**全仓一份**（原先长在
 * interpreter 的闭包里，与本文件的 resolveValue 隔一层闭包，`wait.ts` 用不到，
 * 于是三处 `db.query` 里有一处自己传了 `{}` —— 就是 docs/15 §3.2 那个洞）。
 *
 * **null/undefined 直接不落键**，而不是落成字符串 "null"/"undefined"：
 * 那两个字面量进 SQL 是 `WHERE x = 'null'`，一个查不到任何行的合法查询，
 * 症状是"条件永远不满足"，与本轮修掉的那个假超时只差一句话。
 * 非字符串值 JSON.stringify 是为了数组/对象参数在 JSON 列上还能比（`IN` 那类）。
 */
export function strMap(o: Record<string, unknown> | undefined, resolve: (v: unknown) => unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    const r = resolve(v);
    if (r !== undefined && r !== null) out[k] = typeof r === 'string' ? r : JSON.stringify(r);
  }
  return out;
}

/** repeat 的展开。id 加 `#i` 后缀，让 extract/引用能区分是第几轮。 */
export function flattenTimes(times: number, steps: Step[]): Step[] {
  const out: Step[] = [];
  for (let i = 0; i < times; i++) for (const s of steps) out.push({ ...s, id: `${s.id}#${i}` });
  return out;
}

/**
 * 取定位器**自己声明的**置信度门（`LocatorSpec.confidenceGate`）。
 *
 * 为什么要有这个函数而不是各调用点自己 `locator.confidenceGate ?? 0.85`：
 * 这个字段的失效方式正是"两处各抄一个常数、抄还抄得不一样"——
 * 实测改动前解释器用写死的 `0.99`、`wait.ts` 的 uiPredicate 用写死的 `0.5`
 * （恰好是 schema 的下限，也就是最宽松的那个值），而人在 IR 里写的值没人读。
 * 抄第三份 `0.85` 也一样会漂：schema 改默认值时它不会跟着改。
 *
 * **取不到时的兜底是 1 而不是 0.85**：只有 `app`/`logcat` 这类**根本没有 locator**
 * 的步骤会走到这里（它们的 target 是可选的），那种情况下 resolve 返回的是引擎
 * 自己合成的 `{confidence: 1, rung: 0}`，用 1 判得到 pass，与"无定位器可言"一致。
 * 反过来说，**真带 locator 的步骤永远读得到数**（schema 有 `.default(0.85)`，
 * `defineScenario` 时就填上了），所以这个兜底不会悄悄把某个 strict 门限放宽。
 */
export function locatorGate(locator: unknown): number {
  const g = (locator as { confidenceGate?: unknown } | null | undefined)?.confidenceGate;
  return typeof g === 'number' ? g : 1;
}

/**
 * 取定位器**自己声明的**单次定位成本上限（`LocatorSpec.maxCostUsdPerResolve`）。
 *
 * 与 {@link locatorGate} 同一条理由：这个字段以前**全仓没有任何地方读它**
 * （grep 只命中 schema 定义），而执行侧连一个顶替的常数都没有 ——
 * 那比 `confidenceGate` 的情形更彻底：那条至少有个 0.99 顶着、行为"看起来像按门限判"，
 * 这条是"配了预算，花多少都不管"。docs/03 §2 把 step 级预算列为
 * 引擎的**一等运行时能力**（"超 step → 该步降级到更便宜档位"），
 * 而实现上那一层从来没接通过。
 *
 * 读不到时返回 **Infinity 而不是 schema 默认的 0.02**（同 locatorGate 的取向）：
 * 只有 `app`/`logcat` 这类**根本没有 locator** 的步骤会走到这里，
 * 那种步骤压根不产定位成本，任何上限都是无中生有。
 * 真带 locator 的步骤永远读得到数（schema 有 `.default(0.02)`，
 * `defineScenario` 时就补上了），所以这个兜底不会把某个严格上限放宽。
 */
export function locatorBudget(locator: unknown): number {
  const v = (locator as { maxCostUsdPerResolve?: unknown } | null | undefined)?.maxCostUsdPerResolve;
  return typeof v === 'number' ? v : Number.POSITIVE_INFINITY;
}

/**
 * 一次定位的实际花费**超过**了那一步声明的预算。
 *
 * 为什么要做成异常而不是返回值：超预算这件事有两个完全不同的地方要知道，
 * 而它们的处置方式不一样（见下面 chargeResolve 那条长注释）——
 *  1. **等待循环里**：`waitUntil` 必须**立刻停止轮询**。返回 false 会被当成
 *     "还没满足"，于是它接着轮询、每轮再花一次同样的钱 —— 一个 10s/500ms 的等待
 *     会把单次超支变成 20 次超支。**用异常跳出轮询，正是"返回值会被误读成条件不成立"
 *     这个形状逼出来的**，不是为了好看。
 *  2. **解释器里**：要变成 `fail` + `case-stale`，不能变成 `error`
 *     （`error` 走退出码 5，而 CI_HINT 教 CI"5 → 重试一次" —— 那会把这笔钱再花一遍，
 *     正是这个上限要防的事）。
 *
 * 与 `TransportError` 同一条纪律：**消息里不许带任何可能敏感的值**。
 * 这里只带两个美元数与档位名 —— 都是人自己在 IR 里写的数或 adapter 自己报的数。
 */
export class LocatorBudgetError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
    readonly resolvedBy?: string,
    readonly rung?: number,
  ) {
    super(`单次定位花了 $${spentUsd.toFixed(4)}，超过步骤声明的 maxCostUsdPerResolve $${budgetUsd.toFixed(4)}`);
    this.name = 'LocatorBudgetError';
  }
}

/**
 * 定位成本**记账 + 审预算**的唯一一份实现（解释器与等待循环都调它）。
 *
 * 顺序很要紧：**先 addCost 再判超限**。钱在 resolve 返回的那一刻已经花掉了，
 * 所以"超预算"绝不能变成"这笔不算了" —— 不算会让场景总账 `costUsd` 比真实花费少，
 * 而总账少的表现是"场景级 maxCostUsd 永远不触发"，也就是**熔断跟着失效**。
 *
 * 判的是 `spent > budget` 而不是 `spent >= budget`：
 * 预算 0 是 schema 允许的合法取值（意思是"这一步一分钱都不许花在定位上"），
 * 而"恰好等于上限"是人自己声明可以接受的价，不该报红灯。
 *
 * 为什么审在引擎而不在 adapter（`ResolveResult.costUsd` 的注释里也记了这条）：
 * 价格表只有 adapter 知道，**人写的上限只有引擎知道**。让 adapter 自己判超限就顺手降级，
 * 等于把"这张价格表与那份 IR 对不对得上"也藏进 adapter ——
 * 那就是本仓反复出现的那个缺陷类（有字段、有比较逻辑、没有生产者 / 有生产者、没人判）。
 * 引擎这一层的价值是**兜住 adapter 没兜住的情况**，并把超支变成看得见的红灯，
 * 而不是静默接受一份超出声明的账单。
 */
export function chargeResolve(
  spent: number,
  locator: unknown,
  addCost: (n: number) => void,
  meta: { resolvedBy?: string; rung?: number } = {},
): void {
  // 只加正数：adapter 报个负数（漏了取绝对值、或把退款记成成本）会把总账往下扣，
  // 表现同样是"熔断永不触发"。这里不报错，因为**报什么**都不如让它加不进去显眼。
  if (spent > 0) addCost(spent);
  const budget = locatorBudget(locator);
  if (spent > budget) throw new LocatorBudgetError(spent, budget, meta.resolvedBy, meta.rung);
}

/** switch 的比较。数字与数字字符串视为相等（spec 里 status 有时是 "200" 有时是 200）。 */
export function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof a === 'string' && typeof b === 'number') return a === String(b);
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
