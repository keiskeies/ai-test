/**
 * 等待执行（docs/02 §3）。**等待是条件，不是时长** —— 这是调研认定的第二空白点：
 * 现有平台的「等待」全都是固定延时，每个 delay:3000 都是一颗未来的 flake。
 */
import type { WaitPredicate, WaitCondition } from '@atest/ir';
import { describePredicate } from '@atest/ir';
import { queryOne } from './jsonpath.js';
import { locatorGate, chargeResolve } from './resolve.js';
import { NoNetworkObserver, ResponseWindow } from './responses.js';
import { NotWiredError, causeOfError, AmbiguousWaitWorld } from './errors.js';
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

/**
 * 界面类等待条件**问的是哪一世界的界面**（`web` = 浏览器里的页面，
 * `mobile` = 真机/模拟器上的 app 界面）。取值与 IR 的 `WAIT_WORLD` 逐字一致，
 * 两边各写一份的话，加一档（比如将来的 `desktop`）会出现"schema 收而引擎不认"
 * 或反之 —— 所以 {@link WAIT_WORLD} 是唯一词表，这里是它在引擎侧的投影。
 */
export type WaitWorld = 'web' | 'mobile';

/**
 * 「说不清该问哪一世界」这个错本身叫 {@link AmbiguousWaitWorld}，定义在 `errors.ts`
 * 而不是这里。理由不是风格：那张 `ERROR_CAUSE_RULES` 表要用 `instanceof` 认它，
 * 而表所在的文件**不能反过来 import 本文件**（本文件已经 import 它，反向就是循环，
 * 而 ES module 循环里的 class 处于 TDZ —— 症状是"引擎一 import 就 ReferenceError"，
 * 而不是一个可控的错）。同一族先例：`NotWiredError` / `EnvMissing` 也住在那里，
 * 尽管它们唯一的消费者是 adapter 那一侧。
 * 归因是 `case-stale`：两个 adapter 都在场、接线好好的，缺的是用例作者那一句没写 ——
 * 判成"环境不可用"会让人去配一个**已经配好的东西**。
 */

/** 把"这次等待问过哪些世界"记下来。{@link onceWorlds} 是它的实现。 */
export type WorldSink = (world: WaitWorld) => void;

/**
 * 一次等待**实际问过**的世界（去重、按出现顺序）。
 *
 * 形状照 {@link onceSqlVars}：生命周期 = 一次 `waitUntil`，而 {@link EvalDeps} 上
 * 是**必填**字段。那条理由在这里同样成立 —— 可选字段让"忘了接"编译得过，
 * 而忘了接的症状是"这一整段判据都在跑、而没人说得出它问的是谁"，
 * 恰好退回本轮要修的那个状态。
 *
 * **是数组而不是一个 `let`**：一棵 `allOf` 树里可以有多个界面条件、各写各的 `world`
 *（混合场景里"页面上有 toast **且** app 里那个弹窗出现"是合法写法）。
 * 收成单个值就会丢掉"这一条等待问了两个世界"这件事 —— 而那正是需要看见的形状。
 */
export function onceWorlds(): { note: WorldSink; asked: () => WaitWorld[] } {
  const seen: WaitWorld[] = [];
  return {
    note: (w) => { if (!seen.includes(w)) seen.push(w); },
    asked: () => [...seen],
  };
}

/**
 * 这一件条件选中的那一世界，**该转述给 adapter 的那一份 ctx**。
 *
 * 为什么要有：`ExecContext.target` 是解释器按 `targetOf(step)` 算的，而
 * `STEP_TARGET.wait` 是 `'any'` —— 所以**即使条件里写了 `world: "web"`，
 * adapter 收到的 ctx 仍然是 `'any'`**（纯 Web 场景）或**租约上那个平台**
 * （混合场景：一句"问的是浏览器"的探针，转述给 adapter 的却是 `'ios'`）。
 * 那是本轮刚修完的那件事的**下一格**：IR 有了这个事实、引擎也用对了探针，
 * 但面向 adapter 的那个载体没跟上 —— 缺陷类 (d)「有字段、有判据、没有载体」
 * 的 adapter-facing 版本，与已修掉的 assertPage P3 同形（docs/15 §3.4）。
 *
 * **只有 `web` 这一档改写 ctx**，`mobile` 原样透传，这个不对称是有答案的：
 *  `web` 在 `ExecTarget` 里就是一个确定值，说了"问浏览器"就能精确转述；
 *  `mobile` 对应 `android`/`ios`/`harmony` 三个真实端，**只有租约知道是哪个**，
 *  由这里填任何一个都是编。没有租约时它是 `'any'`，那是诚实的"算不出"
 *  （`ExecTarget` 那个成员存在的理由，见 adapters.ts 上面对 P3 的整段记述）。
 */
function ctxForWorld(w: WaitWorld, ctx: ExecContext): ExecContext {
  return w === 'web' ? { ...ctx, target: 'web' } : ctx;
}

/**
 * **这一件界面条件该由哪一路探针来问**，以及顺手把答案记进 `note`。
 * 三条判据（缺一条就有一种坏法过关）：
 *  1. 作者写了 `world` ⇒ **只认那一档**，另一档顶不上。沿用 `assertPage`/`assertUi`
 *     已立过的判据（`ui-assert-world.test.ts`）：那里的报错从前写 `ui/device`，
 *     等于告诉排查人"另一个也行"，而这一整段修复的全部内容正是"另一个不行"。
 *     所以缺的时候 {@link NoConditionAdapter} **只点名作者要的那一个**。
 *  2. 没写而两档都在场 ⇒ 抛 {@link AmbiguousWaitWorld}。不挑"稳定的那一个" ——
 *     任何固定顺序都是把装配顺序写进用例结论，而两个世界查的是不同的树。
 *  3. 只有一档在场 ⇒ 用它（纯 Web / 纯设备场景不必写 `world`，行为与改动前逐字相同）。
 *
 * `note` 与 `return` 在同一个函数里、`return` 前必然执行 ——
 * **"选对了而没人说"这件事在结构上不可能**，比"记得调用记录函数"强一档。
 *
 * 返回的是 **`{ adapter, ctx }` 一对**而不是单个 adapter，同一族理由强一档：
 * "选中的世界"这件事有**两个**下游（记进摘要、转述给 adapter），
 * 让函数只交出一个，就意味着"另一个记得吗"重新变成自觉。
 * 交出一对之后，"用 web 那一路探针、而 ctx 里写着 ios"这个组合**写不出来**。
 *
 * 泛型是**两个**而不是一个：`UiExec` 与 `DeviceExec` 是两个不同类型，
 * 硬套一个 `T` 会让 TS 从两个候选里挑一个、另一个静默不匹配（或干脆推成 union，
 * 于是调用处拿到 `UiExec | DeviceExec` 而**丧失了"我知道是哪一路"这件事**）。
 * 两个参数 + 返回 `T | U` 里的 `adapter` 是本函数的真实形状：它返回"这两路中的某一路"。
 */
export function resolveWaitWorld<T, U>(
  conditionType: string,
  declared: WaitWorld | undefined,
  slots: { ui?: T; device?: U },
  note: WorldSink,
  ctx: ExecContext,
): { adapter: T | U; ctx: ExecContext } {
  if (declared !== undefined) {
    const wanted = declared === 'web' ? 'ui' : 'device';
    const other = declared === 'web' ? 'device' : 'ui';
    const hit = declared === 'web' ? slots.ui : slots.device;
    if (!hit) {
      /*
       * 两种缺法**各有各的下一步**，所以给两句不同的话：
       *  - 另一档在 ⇒ 「你要的那档没有，另一档顶不上」（{@link MissingWaitWorldAdapter}）
       *  - 两档都不在 ⇒ 「一个都没有」（{@link NoConditionAdapter}，它这句话仍是真话）
       */
      if (slots.ui !== undefined || slots.device !== undefined) {
        throw new MissingWaitWorldAdapter(conditionType, declared, wanted, other);
      }
      throw new NoConditionAdapter(conditionType, [wanted]);
    }
    note(declared);
    return { adapter: hit, ctx: ctxForWorld(declared, ctx) };
  }
  const both = slots.ui !== undefined && slots.device !== undefined;
  if (both) throw new AmbiguousWaitWorld(conditionType);
  const hit = slots.ui ?? slots.device;
  if (!hit) throw new NoConditionAdapter(conditionType, ['ui', 'device']);
  const inferred: WaitWorld = slots.ui !== undefined ? 'web' : 'mobile';
  note(inferred);
  return { adapter: hit, ctx: ctxForWorld(inferred, ctx) };
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
 * 界面类等待条件**要不到 adapter** 这一族的共同祖先。
 *
 * 存在的理由与 `NotWiredError` 一模一样，只是矮一层：解释器要把"缺哪个槽位、
 * 哪一件条件、作者声明了哪一世界"搬进 keyContext 给看板分组用
 *（`interpreter.ts` 里那一句 `e instanceof NoConditionAdapter`）。
 * 本轮新加的 {@link MissingWaitWorldAdapter} 有**同样三个字段**，
 * 而"新加一个错时记得回来解释器加一句 `||`"正是本文件上面刚干掉的那种自觉 ——
 * 挂在这个基类之下，`extends` 就是那道登记动作，漏写在结构上不可能。
 *
 * 三个字段都是 IR 里的字面词，**没有敏感值**，所以可以进磁盘上那份 keyContext。
 */
export abstract class WaitAdapterGap extends NotWiredError {
  /** 哪一种等待条件要不到东西（`dbRow` / `uiPredicate` / `template` / `uiIdle`）。 */
  readonly conditionType: string;
  /** 这件事**需要**哪些槽位（都不在场的那些）。给 CI 摘要与看板分组用，不让它只活在文案里。 */
  readonly triedAdapters: readonly string[];
  /** 作者声明的那一世界。没写 `world` 时没有这个键（不是 `undefined` 占位，见 docs/08 那一族）。 */
  readonly world?: WaitWorld;
  protected constructor(conditionType: string, message: string, triedAdapters: string[], world?: WaitWorld) {
    super(message);
    this.conditionType = conditionType;
    this.triedAdapters = triedAdapters;
    if (world !== undefined) this.world = world;
  }
}

/**
 * 作者**声明了 `world`** 而那一档的 adapter 不在场（另一档在，而它顶不上）。
 *
 * ## 为什么不复用 {@link NoConditionAdapter}
 * 那个类的文案写的是「而本场景**一个都没有**」，这是它对所有现存调用点的**真话**。
 * 而这一支的事实是「你要的那一个没有，**另一个在**」—— 复用它的症状不是崩溃，
 * 是一句**会说谎的报错**：排查人拿到"一个 adapter 都没配"，于是去配浏览器，
 * 而浏览器早就配好了（`ui` 在场），真相是那条 IR 声明了 `world: "mobile"`。
 * 本仓给这一族起过一个名字：**报错里的每一句都要能被当场核对**。
 * 所以宁可多一个类，也不把两种事实挤进一句会被两种情形共用的人话。
 *
 * 挂 `NotWiredError` 之下 ⇒ 自动继承 {@link ERROR_CAUSE_RULES} 里那一档
 * `env-unavailable`（下一步动作确实是"去接线"，与"没接 baseUrl"同一处置）。
 */
export class MissingWaitWorldAdapter extends WaitAdapterGap {
  /** 在场的**另一档**槽位名（它会顶不上，而这句话就是要说明这一点）。 */
  readonly presentOther: string;
  constructor(conditionType: string, world: WaitWorld, wanted: string, presentOther: string) {
    super(conditionType,
      `等待条件 ${conditionType} 声明了 world: "${world}"，需要 ${wanted} adapter，而本场景没有它；`
      + `${presentOther} adapter 在场而它**顶不上** —— 两个世界查的是不同的树，`
      + `拿 ${presentOther} 的结果回答一个问 ${wanted} 世界的问题，`
      + '比报错更难查（它会给出一条**来自另一世界的结论**，而报告上看不出区别）。'
      + `修法二选一：把这一路的 ${wanted} adapter 接上，或把这个条件的 world 改成另一档。`,
      [wanted], world);
    this.name = 'MissingWaitWorldAdapter';
    this.presentOther = presentOther;
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
export class NoConditionAdapter extends WaitAdapterGap {
  constructor(conditionType: string, triedAdapters: string[]) {
    super(conditionType,
      `等待条件 ${conditionType} 需要 adapters.${triedAdapters.join(' 或 adapters.')}，`
      + '而本场景一个都没有 —— 这是平台没接线，不是「条件没满足」，'
      + '也不是超时（一次都没查成，等满超时是假的）。',
      triedAdapters);
    this.name = 'NoConditionAdapter';
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
  /**
   * 记下"这一件界面条件**实际问的是哪一世界**"。必填，理由与 `sqlVars` 逐字相同：
   * 可选字段让"忘了接"编译得过，而忘了接的症状是这一整段判据都在跑、
   * 而报告里没人说得出它问的是谁 —— 那正是本轮要修的那一格
   *（一个事实有字段、有判据、没有面向人的载体）。
   * 只能由 {@link onceWorlds} 造，或由调用方实现同样的"一次等待一份"语义。
   */
  noteWorld: WorldSink;
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
  const worlds = onceWorlds();
  const edeps: EvalDeps = { ...d, sqlVars: onceSqlVars(d.resolveSqlVars), noteWorld: worlds.note };
  /*
   * **「这一条等待问的是哪一世界」要跟着那句摘要走**，pass 与超时两条路都带。
   *
   * 载体选 `describe` 不是顺手：它是这一步**唯一两条路都会带上**的那句话
   *（`interpreter.ts` 里 pass 摘要、三支持续走的摘要、JUnit 的 `condition=` 全是它），
   * 而"我查的是浏览器还是手机"恰恰是查错方向时唯一能救人的那句 ——
   * 超时摘要「等待超时（2000ms）：界面元素可见（web）」让人去查页面，
   * 「（mobile）」让人去查设备，**没有这个词时两条都像是真的**。
   * 一个事实有字段、有判据、而没有面向人的载体，正是 `docs/08` §3 那一格。
   *
   * **没问过任何界面时逐字不变**（纯 `expr` / `response` / `dbRow` 那些等待），
   * 所以这不是给所有摘要加噪音，只在"确实问了一世界"时才多说一个词。
   * 问了两个（混合场景里合法）就都列出来 —— "这条等待问了两个世界"本身
   * 就是需要看见的形状，收成一格会把它抹平。
   */
  const withWorld = (): string => {
    const asked = worlds.asked();
    return asked.length === 0 ? describe : `${describe}（问的是 ${asked.join(' + ')}）`;
  };
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
      /*
       * **"这个 adapter 看不见窗口事件"也不是"条件还没成立"**，同理必须往外抛。
       * 让它被吞成"再等一轮"的话，最后是一次普通超时 + fail + product-bug，
       * 也就是把"平台没接线"说成"被测产品没弹窗"。
       *
       * ## 这一条取代了原来的四条 `if`（NoNetworkObserver / NoNewPageObserver /
       * ## NoConditionAdapter ×2），而这四条本来各自写着"等出现第四个错名时再合并"
       * 合并的条件就是本轮凑齐的那两件事：
       *  1. **出现了第四个、第五个错名**（`MissingWaitWorldAdapter` 是本轮新加的，
       *     而且就长在这个文件里）；
       *  2. 当年不合并的理由是"基类要跨文件放" —— 而基类 `NotWiredError` **早就**
       *     在 `errors.ts` 里、本文件本来就 import 了它。那个理由今天不成立。
       *
       * **不合并会发生什么，是量出来的不是推的**：本轮加 `MissingWaitWorldAdapter` 时，
       * 按旧形状我得回来再加一行 `if`。而"新增一个 NotWiredError 子类时记得回来加一行"
       * 正是这一族注释里反复否决的那种自觉 —— 漏加的那一个恰好退回"被吞成超时"，
       * 而它的表现是**一次普通超时**（fail + product-bug，"去查产品"），
       * 比崩溃难查一个数量级。合成一句 `instanceof NotWiredError` 之后，
       * "继承这个基类"本身就是那道登记动作（`extends` 写不出来的话编译不过），
       * 于是**漏加在结构上不可能**。
       *
       * 反过来核对一句：这么合会不会**多抛**一些本该被吞的错？不会 ——
       * `NotWiredError` 这一族的全部含义是"这件事今天压根跑不起来"，
       * 一个都不该被"再等一轮"吞掉。真正该照旧吞的那些（adapter 内部错、
       * 数据库拒了这条 SQL）不是它的子类，走下面那条 `case-stale` 判据与最后的兜底。
       */
      if (e instanceof NotWiredError) throw e;
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
        describe: `${withWorld()}（求值报错：${(e as Error).message}）`,
        // 原始报错单独给一份，别让调用点去解析 describe（理由见 WaitResult.evalError）
        evalError: (e as Error).message,
      };
    }
    /*
     * 摘要里"问过哪些世界"是**这一次等待从头到尾问过的全部**（去重），
     * 不是"最后一轮那一支问的"。这个差别只在 `anyOf` 上看得见：某一轮第一支
     * 不成立所以第二支也被问了，下一轮第一支成立就短路 —— 于是"这一等待问过两个世界"
     * 成立而"最后一轮问了两个"不成立。取前者：它**每次 poll 都真**，
     * 而摘要说的是"这条等待"这件事，不是说的是"第 N 轮"。
     * （与上面 dbRow 那句"一条等待从头到尾问的必须是同一个问题"是同一条诚实标准的两面：
     *  判据不许一轮一个样，而**问过什么**可以累积。）
     */
    if (ok) return { satisfied: true, waitedMs: d.clock.mono() - t0, polls, describe: withWorld() };

    const elapsed = d.clock.mono() - t0;
    if (elapsed >= timeout) return { satisfied: false, waitedMs: elapsed, polls, describe: withWorld() };
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
      const { adapter: a, ctx } = resolveWaitWorld('uiPredicate', c.world, d.adapters, d.noteWorld, d.ctx);
      /*
       * `!('resolve' in a)` 也走同一个错，而那时消息会说"没有 ui adapter"——
       * 措辞不准（槽位在场，只是这一个口没有）。**刻意不把它拆成第二个错名**：
       * 两条路的下一步是同一句话（去看接线），拆开后新增一种缺口的条件时
       * 就多一处"记得区分"，而漏分的那一处恰好退回"被吞成超时"（NoNetworkObserver 那条理由）。
       */
      if (!('resolve' in a)) throw new NoConditionAdapter('uiPredicate', ['ui', 'device']);
      const r = await (a as unknown as { resolve: (l: unknown, c: ExecContext) => Promise<ResolveResult> }).resolve(c.target, ctx);
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
      /*
       * 这一处从前是 `device ?? ui`，与相邻两支的 `ui ?? device` **反着来**。
       * **改前实测**（`.scratch/probe-which.mts`）：两个槽位都在场时，同一棵 `allOf` 树里
       * `uiPredicate` 落到浏览器而这一支落到手机 —— 一次等待问了两个世界，
       * 而摘要里看不出区别。不是风格问题：另一世界的"没找到"会被当成这一世界的结论。
       * 现在与另两支走同一个 {@link resolveWaitWorld}，不再各写各的顺序
       *（永久形态：`engine/test/wait-world.test.ts` 里「template 不再"优先设备"」那条）。
       */
      const { adapter: a, ctx } = resolveWaitWorld('template', c.world, d.adapters, d.noteWorld, d.ctx);
      if (!('resolve' in a)) throw new NoConditionAdapter('template', ['ui', 'device']);
      const r = await (a as unknown as { resolve: (l: unknown, c: ExecContext) => Promise<ResolveResult> }).resolve(c.target, ctx);
      /*
       * 模板匹配同样按次计费（图像比对/视觉模型都在这一档），
       * 所以同样记账 + 审预算，理由同 uiPredicate 那一处。
       */
      chargeResolve(r.costUsd ?? 0, c.target, d.addCost, { resolvedBy: r.resolvedBy, rung: r.rung });
      return c.expect === 'hit' ? r.confidence >= c.minConfidence : r.confidence < c.minConfidence;
    }
    case 'uiIdle': {
      // 「空闲」判定要连续两次快照一致 —— 单次相同可能只是恰好落在两帧之间
      const { adapter: a, ctx } = resolveWaitWorld('uiIdle', c.world, d.adapters, d.noteWorld, d.ctx);
      if (!('snapshot' in a)) throw new NoConditionAdapter('uiIdle', ['ui', 'device']);
      const first = await (a as unknown as { snapshot: (c: ExecContext) => Promise<{ sha: string }> }).snapshot(ctx);
      await d.clock.sleep(c.quietMs);
      const second = await (a as unknown as { snapshot: (c: ExecContext) => Promise<{ sha: string }> }).snapshot(ctx);
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
