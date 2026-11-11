/**
 * 等待执行（docs/02 §3）。**等待是条件，不是时长** —— 这是调研认定的第二空白点：
 * 现有平台的「等待」全都是固定延时，每个 delay:3000 都是一颗未来的 flake。
 */
import type { WaitPredicate, WaitCondition } from '@atest/ir';
import { describePredicate } from '@atest/ir';
import { queryOne } from './jsonpath.js';
import { locatorGate, chargeResolve } from './resolve.js';
import { NoNetworkObserver, ResponseWindow } from './responses.js';
import { NotWiredError, causeOfError } from './errors.js';
import type { AdapterRegistry, Clock, ExecContext, NetworkObserver, ResolveResult } from './adapters.js';

export interface WaitDeps {
  predicate: WaitPredicate;
  timeoutMs?: number;
  pollMs?: number;
  backoff?: 'none' | 'linear' | 'exponential';
  clock: Clock;
  evalExpr: (e: string) => boolean;
  resolveRef: (ref: string) => unknown;
  adapters: AdapterRegistry;
  ctx: ExecContext;
  /**
   * 成本入账口（解释器的 addCost）。**必填**：给了默认值（` () => {}`），
   * "忘了接"就编译得过，于是一次 10s/500ms 的 uiPredicate 等待把
   * `maxCostUsdPerResolve` 那次 resolve 的钱重复花 20 次而**总账上一个数都不变** ——
   * 场景级 `maxCostUsd` 熔断读的就是这本账，账不动熔断就永不触发，
   * 而报告照样写"成本 $0.0000"。缺失时宁可编译不过。
   */
  addCost: (n: number) => void;
  /** 页面内请求观测口（透传自 adapters.network）。**必填**，同理：
   *  可选的话"忘了接"编译得过，`wait{response}` 就退回本轮修掉的那个洞。
   *  没网络观测时传 `undefined` 是合法的 —— 但谓词里有 response 条件就会报错。 */
  network: NetworkObserver | undefined;
  /**
   * 响应观测窗口。**必填**。
   *
   * 为什么由调用方造而不是本函数内部 `new`：窗口的**起点**决定哪些响应算命中
   * （"会话开头"会让上一步之前发过的接口假绿，见 responses.ts 顶部），
   * 而只有解释器知道"上一步是什么时候开始的"。
   * 内部造 = 每次都从 0 开始 = 那个假绿照旧存在，且这次连"没人传起点"的痕迹都没有。
   */
  window: ResponseWindow;
  /**
   * 新窗口观测口（透传自 `adapters.newPage`）。**必填**，与 `network` 同理：
   * 可选的话"忘了接"编译得过，而漏接的症状是 `expectNewPage` 恒判"没开新窗口"。
   * 没接时传 `undefined` 是合法的 —— 但谓词里有 newPage 条件就会抛
   * {@link NoNewPageObserver}（归因到接线，而不是"被测产品没弹窗"）。
   */
  newPage: NewPageObserver | undefined;
  /**
   * 计数基线：`newPage.count()` **大于**这个值才算"这一步开了新窗口"。
   *
   * **由调用方算并传进来**，不在 waitUntil 内部取，理由是两条路的起点不一样：
   *  - `wait{newPage}` 步骤：起点 = 等待开始的那一刻。
   *  - 动作步骤上的 `expectNewPage`：起点必须 = **perform 之前**，
   *    否则"点击当场就把窗口开好了"这种最快的情形会被漏掉（等满超时 = 假红），
   *    而那正是这条断言最常碰到的形态 —— 同步 `window.open()` 就是这么工作的。
   * 如果这里给个默认 0，等价于"会话里开过任何窗口都算过"，
   * 也就是这个字段要防的那个假绿。所以**必填**，且解释器里只有一处计算它。
   */
  newPageBaseline: number;
  /**
   * SQL 具名占位的绑定值求值（`wait{dbRow}.vars`）。**必填**，理由同 `addCost`：
   * 给个默认值（`() => ({})`）就编译得过，而漏接的症状恰好是本轮修的那个洞复活 ——
   * SQL 带着没绑定的占位发给数据库，被拒之后看起来像"条件还没满足"。
   *
   * 由调用方实现而不是本文件里自己求值，是因为**引擎不许碰变量表之外的东西**，
   * 而作用域（parallel 分支那一层）只有解释器知道。这里透传的是求值**能力**。
   */
  resolveSqlVars: (vars: Record<string, unknown> | undefined) => Record<string, string>;
}

/**
 * "页面新开了一个标签页/窗口"的观测口（只有浏览器看得见，引擎不碰窗口生命周期）。
 *
 * 只有一个 `count()`，返回**自会话开始以来由本页打开的新页面数**。
 * 刻意不是"给我页面列表"：列表里的 URL 会进 keyContext/摘要/trace，
 * 而 `?token=` 这种查询串 `redactForDisk` 判不出来（同 responses.ts 那条理由）。
 */
export interface NewPageObserver {
  count(): number;
}

/** 缺新窗口观测口。抛的时机与理由同 `NoNetworkObserver`（见 responses.ts）。 */
export class NoNewPageObserver extends NotWiredError {
  constructor() {
    super('等待条件里有 newPage（等页面新开标签页/窗口），但没配 adapters.newPage —— '
      + '新窗口只有浏览器看得见，引擎不碰窗口生命周期，所以没有任何东西能提供这个数据。'
      + '（Web 端由 adapter-web 提供；没起浏览器时这条等待无法工作）');
    this.name = 'NoNewPageObserver';
  }
}

/**
 * **等待条件需要的那个 adapter 压根不在场**（`dbRow` 缺 db、`uiPredicate`/`template`/
 * `uiIdle` 缺 ui 与 device）。与 `NoNetworkObserver` / `NoNewPageObserver` 同族同理由。
 *
 * 前三处原先抛的是**裸 `Error`**，于是被 `waitUntil` 那句"求值报错就当成还没满足"
 * 吞掉。而那句话**本身是对的**（docs/02 §3：等待是条件不是时长，一次数据抖动
 * 不该让整步红），坏在它对"这条条件今天压根跑不起来"也照用。实测四种 `onTimeout`：
 *
 * | onTimeout | 改前 | 应该 |
 * |---|---|---|
 * | `fail` | fail + env-unavailable，摘要**「等待超时（1000ms）」** | 说"没接线"，且别说超时 |
 * | `continue` | **pass**（整场 `pass`） | error |
 * | `error` | error + env-unavailable（**这一档反而是对的**，因为它不看原因） | —— |
 *
 * `continue` 那一档是本文件里目前最贵的一个假绿：**一个没有任何 db adapter 的
 * `wait{dbRow}`，整场报 pass**，而它一次数据库查询都没发出去过。
 * `onTimeout` 的语义是"**等不到**怎么办"，不是"**没法等**怎么办" ——
 * 前者是产品事实（可以继续往下走），后者是平台事实（往下走只会拿到更多假的结论）。
 *
 * **为什么用异常而不是"求值前预检谓词树"**：`NoNetworkObserver` 那条注释已经否决过
 * 预检 —— 新增一种需要 adapter 的条件时没人会记得回来加一项，漏加的那种恰好退回
 * "被吞成超时"。求值时判一次，覆盖的是**真实走到的**分支。
 */
export class NoConditionAdapter extends NotWiredError {
  /** 哪一种等待条件要不到东西（`dbRow` / `uiPredicate` / `template` / `uiIdle`）。 */
  readonly conditionType: string;
  /** 试过哪些 adapter 槽位都没有。给 CI 摘要与测试用，不让它只活在文案里。 */
  readonly triedAdapters: readonly string[];
  constructor(conditionType: string, triedAdapters: string[]) {
    super(`等待条件 ${conditionType} 需要 adapters.${triedAdapters.join(' 或 adapters.')}，`
      + '而本场景一个都没有 —— 这是平台没接线，不是「条件没满足」，'
      + '也不是超时（一次都没查成，等满超时是假的）。');
    this.name = 'NoConditionAdapter';
    this.conditionType = conditionType;
    this.triedAdapters = triedAdapters;
  }
}

export interface WaitResult {
  satisfied: boolean;
  waitedMs: number;
  polls: number;
  describe: string;
  /**
   * **有值 = 这条等待是被一次求值异常中止的，不是等满超时的。**
   * 值是那句原始报错。
   *
   * 为什么单独立一个字段而不是"看 describe 里有没有『求值报错』"：
   * describe 是**给人看的摘要**，把它当判据就是给摘要文本编程 ——
   * 改一句文案（本仓常做）会让调用点的分支静默换边。
   * 而调用点要它，是因为它自己**分不清**这两件事：`satisfied: false` +
   * 一个 waitedMs，既可能是"等满了确实没满足"，也可能是"第一轮就炸了、
   * 一次都没等"。改前解释器统一说成后者，实测（`.scratch/probe-dbrow2.mts`）：
   *   真·超时   → 摘要「等待超时（2000ms）」，waitedMs=2000，轮询多次
   *   求值报错  → 摘要**同样**「等待超时（2000ms）」，waitedMs=0，polls=1
   * 值班人拿到"等满了 2 秒"这句，会去查"为什么 2 秒内没出现"（查产品、查异步落库），
   * 而真相是那条 SQL 压根没被数据库接受 —— **两条路指向完全不同的下一步**。
   * 这也是 docs/08 §3 那一族（"少一件东西看起来像什么都没少"）在报告侧的形状。
   */
  evalError?: string;
}

/**
 * 求值时用的依赖 = 作者的依赖 + **一份"每条条件的绑定值只算一次"的记忆**。
 *
 * 分成两个类型而不是往 WaitDeps 里塞一个可选字段，理由是这个仓一直在用的那条：
 * 可选字段让"忘了接"编译得过，而这里忘了接的症状是本轮刚修的那个洞复活。
 * 所以 `sqlVars` 在 EvalDeps 上是**必填**的，只能由 {@link onceSqlVars} 造
 *（或由调用方自己实现同样的"一次性的"语义）。
 */
export type EvalDeps = WaitDeps & {
  /** 同步是有意的：绑定值只是一个字符串表，IO 在 adapter 那侧（下一行的 query）。 */
  sqlVars(c: WaitCondition): Record<string, string>;
};

/**
 * 把"求值绑定值"包成"**每条条件在这次等待里只求值一次**"。
 *
 * 生命周期是**一次 waitUntil**：缓存建在那个函数顶部、随它一起回收。
 * 两个方向都会坏，所以两头都写清楚：
 *  - 每轮 poll 重算 = 一次 20 轮的等待拿 20 个不同的 `{gen}` 值去查，
 *    而摘要说"数据库出现匹配行"，它从没查过那一个；
 *  - 跨 run 复用（模块级缓存）= 第二场跑起 `{gen}` 永远是第一场那个值，
 *    "这次用新生成的订单号"只在第一场成立。
 * 所以键是条件对象、生命周期是这次调用，两头各挡一种。
 */
export function onceSqlVars(resolve: WaitDeps['resolveSqlVars']): EvalDeps['sqlVars'] {
  const seen = new WeakMap<object, Record<string, string>>();
  return (c) => {
    const cond = c as { vars?: Record<string, unknown> };
    if (!cond.vars || Object.keys(cond.vars).length === 0) return {};
    const hit = seen.get(c);
    if (hit) return hit;
    const v = resolve(cond.vars);
    seen.set(c, v);
    return v;
  };
}

export async function waitUntil(d: WaitDeps): Promise<WaitResult> {
  const timeout = d.timeoutMs ?? 10_000;
  const basePoll = d.pollMs ?? 500;
  const t0 = d.clock.mono();
  const describe = describePredicate(d.predicate);
  /*
   * 绑定值的记忆**建在这里**（一次等待一份），所以 `onceSqlVars` 只调这一次。
   * 建在循环里 = 每轮一个空缓存 = 与"每轮重算"完全等价，那正是这一层要防的事。
   *
   * 名字刻意不叫 `e`：下面 catch 的参数就叫 `e`，同名会让"这里到底拿的谁"
   * 变成一次人工确认。变量遮蔽在 TS 里不报错，而本文件那个 catch 很长。
   */
  const edeps: EvalDeps = { ...d, sqlVars: onceSqlVars(d.resolveSqlVars) };
  let polls = 0;
  let interval = basePoll;

  for (;;) {
    polls++;
    let ok = false;
    try {
      ok = await evalPredicate(d.predicate, edeps);
    } catch (e) {
      /*
       * **"没接网络观测口"也不是"条件还没成立"**，同理必须往外抛。
       *
       * 本轮修的就是这个：`wait{response}` 以前恒为假（读一个没人写的变量），
       * 而"恒为假"被这条**本身正确**的纪律收成"再等一轮"，最后变成一次普通超时。
       * 于是"平台侧压根没接数据"与"被测页面确实没发这个请求"给出**逐字节相同**的结论。
       * 抛出去之后由 runStep 收成 error + env-unavailable（"去查接线"），
       * 而不是 fail + env-unavailable 的超时（"去查接口"）。
       *
       * 为什么不在等待开始前做一次"谓词里有没有 response 条件"的预检：
       * 那要遍历谓词树，而**新增一种需要网络的条件时没人会记得回来加一项** ——
       * 漏加的那一种就又回到"被吞成超时"。求值时判一次，覆盖的是**真实走到的**分支。
       */
      if (e instanceof NoNetworkObserver) throw e;
      /*
       * 同 NoNetworkObserver：**"这个 adapter 看不见窗口事件"不是"条件还没成立"**。
       * 让它被吞成"再等一轮"的话，最后是一次普通超时 + fail + product-bug，
       * 也就是把"平台没接线"说成"被测产品没弹窗"。
       */
      if (e instanceof NoNewPageObserver) throw e;
      /*
       * 同 NoNetworkObserver / NoNewPageObserver，但这一族**数量最多**（四种条件、
       * 四处判定点），而且它是本文件里唯一会**造出假绿**的一族：
       * 被吞掉之后 `onTimeout: 'continue'` 会把"一次数据库都没查过"报成 pass。
       * 四条 `if` 而不是一个共同基类，是因为三个错名分属两个文件（NoNetworkObserver
       * 在 responses.ts），基类要跨文件放；等出现第四个错名时再合并不迟。
       */
      if (e instanceof NoConditionAdapter) throw e;
      /*
       * **用例自己写错了（引用/路径/表达式/生成器种类/定位超预算），要让 runStep
       * 那一份 cause 判据去定归因**，不能在这里把它降级成一句 evalError 字符串。
       *
       * 改动前这一行是 `if (e instanceof VarError) throw e;` —— 只放 VarError 出去。
       * 于是**同一条写坏的 `$.` 路径**（PathError）在 `set` 步与在 `wait` 条件里
       * 得到不同的归因：前者走到 runStep 的 catch，后者被下面那个 return 吞成
       * 字符串，再由解释器那两句**无条件** `cause: 'env-unavailable'` 定案。
       * 改前实测（`.scratch/probe-cause-default.mts`，改前的两种写法都是
       * `error + env-unavailable`；永久落点是
       * `packages/engine/test/error-cause.test.ts` 里「同一个错换位置」那组）：
       * `wait` 条件里的 PathError/ExprError 与 `assign` 里的**同一条**，
       * 在改前**都**归错（都成"环境不可用"），而 `docs/14` §5 登记这一条时
       * 只记了 `assign` 那一行，**没记 wait 这条路**。
       *
       * **判据用 `causeOfError(e) === 'case-stale'`，而不是在这里再列三个类名**：
       * 列类名等于把"哪些错属于用例自己写错"抄第二遍，而本文件下面那段注释
       * （"我在下面那个 return 里再写一遍 `r.evalErrorName === 'VarError' ? …`
       * 就等于同一件事两处各写一份"）说的正是这件事 —— 那段注释本身是对的，
       * 只是它下面那行代码违反了它。
       *
       * ⚠ **这一行同时守着"钱"**（原来由上面那句独立的
       * `if (e instanceof LocatorBudgetError) throw e;` 守，本轮删了它，
       * 因为把 LocatorBudgetError 登记进表之后那一行就成了这句的**重复**：
       * 删掉它，行为逐字节相同 —— 变异检查实测到"删了照样全绿"，
       * 那正是 docs/14 §4.7 说的"到不了 / 多余的分支"）。
       * 超支在语义上长得像"条件没成立"（都是"这一步还没成"），一旦被下面那句
       * 当成普通求值错误 -> 继续轮询 -> **每轮再花一次同样的钱**：
       * 一个 10s / pollMs=500 的 uiPredicate 等待 = 20 次付费定位，
       * 本来只超预算 $0.001 的等待变成超 $0.02。
       * 所以**"给 LocatorBudgetError 登记什么归因"是一个花钱问题，不只是报表问题**：
       * 把它从表里删掉（或改判成别的值）=> 这里不再外抛 => 单次超支变成 20 次。
       * 这条跨文件耦合由 `tooling/mutate/locator-budget.json` 盯着
       * （它的锚点本轮就搬到了表那一行），永久落点是
       * `locator.test.ts` 里「等待里超预算 => 第一次 poll 就停」那条（它数次数，不只看状态
       * —— 状态在这种情况下照样是 fail，只看状态就是假绿）。
       *
       * 反过来，**不满足这条的一律照旧吞**（adapter 抛的错、数据库拒了这条 SQL）：
       * 那些可能是瞬时故障，"求值报错就再等一轮"对它们是**对的**，
       * 外抛会把一次抖动变成红灯。这条界线是本轮量出来的，不是我推的。
       */
      if (causeOfError(e) === 'case-stale') throw e;
      // 条件求值本身报错（变量未定义等）不能当成「还没满足」干等到超时 ——
      // 那会把一个配置错误伪装成一次超时，是最难查的一类 flake
      return {
        satisfied: false,
        waitedMs: d.clock.mono() - t0,
        polls,
        describe: `${describe}（求值报错：${(e as Error).message}）`,
        // 原始报错单独给一份，别让调用点去解析 describe（理由见 WaitResult.evalError）
        evalError: (e as Error).message,
      };
    }
    if (ok) return { satisfied: true, waitedMs: d.clock.mono() - t0, polls, describe };

    const elapsed = d.clock.mono() - t0;
    if (elapsed >= timeout) return { satisfied: false, waitedMs: elapsed, polls, describe };
    // 不睡过超时点：否则 10s 超时会睡到 10.5s，慢套件就是这么变慢的
    const sleepMs = Math.min(interval, timeout - elapsed);
    await d.clock.sleep(sleepMs);
    interval = d.backoff === 'exponential' ? Math.min(interval * 1.6, 5_000) : d.backoff === 'linear' ? Math.min(interval + basePoll, 5_000) : basePoll;
  }
}

async function evalPredicate(p: WaitPredicate, d: EvalDeps): Promise<boolean> {
  const o = p as Record<string, unknown>;
  if ('allOf' in o) for (const c of o.allOf as WaitPredicate[]) if (!(await evalPredicate(c, d))) return false;
  if ('allOf' in o) return true;
  if ('anyOf' in o) { for (const c of o.anyOf as WaitPredicate[]) if (await evalPredicate(c, d)) return true; return false; }
  if ('noneOf' in o) { for (const c of o.noneOf as WaitPredicate[]) if (await evalPredicate(c, d)) return false; return true; }
  return evalCondition(p as WaitCondition, d);
}

export async function evalCondition(c: WaitCondition, d: EvalDeps): Promise<boolean> {
  switch (c.type) {
    case 'expr':
      return d.evalExpr(c.expr);
    case 'httpStatus': {
      const v = d.resolveRef(c.ref) as { status?: number } | number | undefined;
      const status = typeof v === 'object' && v !== null ? v.status : v;
      return typeof status === 'number' && c.in.includes(status);
    }
    case 'dbRow': {
      if (!d.adapters.db) throw new NoConditionAdapter('dbRow', ['db']);
      /*
       * 绑定值**每条条件只算一次**（不是每轮 poll 都算），缓存见 onceSqlVars
       *（那份记忆建在 waitUntil 顶部，一份等待一份）。
       *
       * 这件事看起来是优化，其实是**判据**：`vars` 里可以有 `{gen}`，
       * 而生成器的定义就是"每次求值给一个新值"。每轮重算的话，
       * 一次 10s / pollMs=500 的等待会拿**二十个不同的 id** 去查数据库，
       * 最后摘要说"数据库出现匹配行（default）"—— 它从没查过那一个。
       * 与 `describePredicate` 只在等待开始时算一次是同一件事：
       * **一条等待从头到尾问的必须是同一个问题**。
       *
       * 缓存的键用**条件对象本身**而不是类型名：一棵 `allOf` 树里可以有多个
       * dbRow 条件，各有各的 SQL 与 vars，按类型名缓存会让它们共用一份绑定，
       * 症状是"两个条件各查各的、结果互相看着不对"。
       */
      const vars = d.sqlVars(c);
      const rows = await d.adapters.db.query(c.datasource, c.sql, vars, d.ctx);
      if (c.expect === 'noRow') return rows.length === 0;
      if (c.expect === 'scalarTruth') {
        const first = rows[0] ? Object.values(rows[0] as Record<string, unknown>)[0] : undefined;
        return Boolean(first);
      }
      return rows.length > 0;
    }
    case 'uiPredicate': {
      const a = d.adapters.ui ?? d.adapters.device;
      /*
       * `!('resolve' in a)` 也走同一个错，而那时消息会说"没有 ui adapter"——
       * 措辞不准（槽位在场，只是这一个口没有）。**刻意不把它拆成第二个错名**：
       * 两条路的下一步是同一句话（去看接线），拆开后新增一种缺口的条件时
       * 就多一处"记得区分"，而漏分的那一处恰好退回"被吞成超时"（NoNetworkObserver 那条理由）。
       */
      if (!a || !('resolve' in a)) throw new NoConditionAdapter('uiPredicate', ['ui', 'device']);
      const r = await (a as unknown as { resolve: (l: unknown, c: ExecContext) => Promise<ResolveResult> }).resolve(c.target, d.ctx);
      /*
       * **每轮都记一次账、每轮都审一次预算**。
       *
       * 这两句是本轮真正要接的那条线：等待循环是 `maxCostUsdPerResolve`
       * 唯一能被**重复触发**的地方 —— 一个走视觉档的 uiPredicate，
       * 每次 poll 都是一次完整定位。以前这里既不记账也不审，
       * 于是"单次定位上限"这个闸门在最容易烧钱的路径上恰好不存在。
       * （判据本身在 resolve.ts 的 chargeResolve，与解释器同一个函数 ——
       *  两条路径各自实现一份判断，就是本仓反复出现的"两边数不一样"。）
       */
      chargeResolve(r.costUsd ?? 0, c.target, d.addCost, { resolvedBy: r.resolvedBy, rung: r.rung });
      /*
       * **「在不在」有两个方向，阈值不能共用一个数**（这里原先两边都用写死的 0.5）。
       *
       * 0.5 恰好是 `confidenceGate` 的 schema **下限**，也就是最宽松的那个值 ——
       * 而 `c.target` 就是整份 `LocatorSpec`（steps.ts 里 uiPredicate 的 target 字段），
       * 人写的门限一路传到这里，然后被丢掉。
       *
       * 分方向不是因为麻烦，是因为**两个方向上"宽松"的含义相反**：
       *  - 问"在不在"（visible/attached/enabled）：按人声明的门限判，与解释器同一判据。
       *    收紧只会让等待更久或超时，方向安全。
       *  - 问"走了没"（gone）：如果也按门限判"在"，0.6 的弱匹配会被判成"已经不在了"
       *    => **等待提前成功**。toast/Loading 消失这类用例最要的正是这种假绿，
       *    所以这里反过来取最保守的一档：**adapter 报了任何匹配就算还在**。
       *    代价是最坏情况多等到超时（红，看得见），比悄悄绿了便宜。
       */
      const matched = Boolean(r.handle);
      return c.state === 'gone' ? !matched : matched && r.confidence >= locatorGate(c.target);
    }
    case 'template': {
      const a = d.adapters.device ?? d.adapters.ui;
      if (!a || !('resolve' in a)) throw new NoConditionAdapter('template', ['device', 'ui']);
      const r = await (a as unknown as { resolve: (l: unknown, c: ExecContext) => Promise<ResolveResult> }).resolve(c.target, d.ctx);
      /*
       * 模板匹配同样按次计费（图像比对/视觉模型都在这一档），
       * 所以同样记账 + 审预算，理由同 uiPredicate 那一处。
       */
      chargeResolve(r.costUsd ?? 0, c.target, d.addCost, { resolvedBy: r.resolvedBy, rung: r.rung });
      return c.expect === 'hit' ? r.confidence >= c.minConfidence : r.confidence < c.minConfidence;
    }
    case 'uiIdle': {
      // 「空闲」判定要连续两次快照一致 —— 单次相同可能只是恰好落在两帧之间
      const a = d.adapters.ui ?? d.adapters.device;
      if (!a || !('snapshot' in a)) throw new NoConditionAdapter('uiIdle', ['ui', 'device']);
      const first = await (a as unknown as { snapshot: (c: ExecContext) => Promise<{ sha: string }> }).snapshot(d.ctx);
      await d.clock.sleep(c.quietMs);
      const second = await (a as unknown as { snapshot: (c: ExecContext) => Promise<{ sha: string }> }).snapshot(d.ctx);
      return first.sha === second.sha;
    }
    case 'response': {
      /*
       * 真数据来自 `adapters.network`（见 responses.ts 顶部：这一支以前读的是一个
       * **没有任何生产者**的 `__responses` 变量，于是恒为假）。
       *
       * **拉取发生在每一次 poll**（`evalCondition` 每轮都会被调到），
       * 而**判据在引擎**：pattern 怎么算命中由 `ResponseWindow.any` 定，
       * 与 `expectResponse` 共用同一个函数 —— 两处各写一份匹配口径，
       * 迟早出现"同一个 pattern 在等待里算命中、在动作步骤里不算"。
       */
      if (!d.network) throw new NoNetworkObserver();
      await d.window.poll(d.network);
      return d.window.any(c.urlPattern, c.status);
    }
    case 'newPage': {
      /*
       * 与 response 那一支同构：**判据在引擎，观测在 adapter**。
       * 但**不需要窗口对象**：新窗口是"一个自会话开始起的单调整数"，
       * 起点由 `newPageBaseline` 一次给清，没有"消费到哪一条"这件事要记。
       * （少了 ResponseLedger 那样的第二本账，也就少了它对不齐的方式。）
       */
      if (!d.newPage) throw new NoNewPageObserver();
      return d.newPage.count() > d.newPageBaseline;
    }
    default:
      throw new Error(`未知等待条件类型 ${(c as { type: string }).type}`);
  }
}

/*
 * `evalCondition` 现在直接 export 在定义处（上面）。
 * 从前它是"定义成私有、文件末尾再 export 一次"，那种写法下
 * 类型改签名时容易只改到定义处而漏掉导出，而这里要的正是"签名与 EvalDeps 一起改"
 *（复用这套求值的外部调用方必须自己接上 onceSqlVars，否则本轮那个洞会在使用方复活）。
 */
export const _unusedQueryOne = queryOne;
