/**
 * **错误 → 归因（cause）的唯一一份判据**，以及"平台没接线"这一族的共同祖先。
 *
 * ## 为什么单独成文件
 *
 * 这条判据改动前**抄在五处**，而且五处互相矛盾：
 *
 * | 位置 | 写法 | 同一个 `PathError` 得到 |
 * |---|---|---|
 * | `interpreter.ts` runStep 主 catch | `instanceof VarError ? 'case-stale' : 'env-unavailable'` | `env-unavailable` |
 * | `interpreter.ts` 守卫（`when`）那一句 | **无条件** `'env-unavailable'` | `env-unavailable` |
 * | `interpreter.ts` 等待求值报错那两支 | **无条件** `'env-unavailable'` | `env-unavailable` |
 * | `wait.ts` 求值那一族 | `instanceof VarError` 才外抛，其余吞成字符串 | 到不了判据 |
 * | `assertions.ts` 断言路径 | `instanceof PathError → 'case-stale'` | **`case-stale`** ← 与上面四处相反 |
 *
 * 也就是说**同一条写坏的 `$.` 路径，写在 assert 里是"用例过期"、写在 set 里是
 * "环境不可用"**（改前实测见 `docs/14` §6 第 12 条那张表）。这不是"两个类漏登记"，
 * 是"一件事没有一处定义"。所以这里给一处，其余全部调它。
 *
 * ## 兜底为什么从 `env-unavailable` 换成 `untriaged`
 *
 * 改动前那句是 `… : 'env-unavailable'` —— **枚举已知类、其余全算环境问题**。
 * 于是"新增一个错误类忘了回来登记"的后果是**编出一个像样的假答案**：值班人拿去查
 * 一个不存在的环境问题，而 CI 照 `CI_HINT` 的"5 → 标 error 重试一次"白重试一遍
 * （用例里那条路径不会因为重试而变合法）。
 * 换成 `untriaged` 之后，没登记的新类得到的是**一个明说"没人认领"的值**。
 * 这不是降低标准：`FAILURE_CAUSE` 里 `untriaged` 的定义就是"归因不明"，
 * 而上面那张表证明今天**五处各说各话**，也就是"归因"这件事本来就没有权威答案 ——
 * 那就别假装有一个。
 *
 * ## ⚠ 这里没做的两件事（都另记 docs/14 §5，不是漏看）
 *
 *  - **adapter 抛上来的裸 `Error` 现在得到 `untriaged`**（改动前是 `env-unavailable`）。
 *    想给它正确的归因，得让 adapter 改抛 `@atest/engine` 的错误类。
 *    `TokenError`（凭证问题，按 `FAILURE_CAUSE` 的定义属于 `env-unavailable`）
 *    现在就落在 `untriaged` 上 —— 宁可"没归因"，不要"归错因"。
 *  - **`ExprError` 里有两类其实是引擎自己的问题**而不是用例的：`expr.ts` 的
 *    `now()` 需要注入时间源、`未知运算符`。表里会把它们报成 `case-stale`。
 *    全仓 `src` 下**每一个**求值调用点都传了 `now`（本轮逐个数过），所以今天到不了；
 *    真要区分得给 `ExprError` 分"语法错 / 引擎接线错"两档，那是表达式引擎的改动，
 *    不在这里加一条**没人验得到**的分支（docs/14 §4.7）。
 */
import type { FailureCause } from '@atest/ir';
import { TransportError } from './adapters.js';
import { PathError } from './jsonpath.js';
import { ExprError } from './expr.js';
import { VarError } from './vars.js';
import { LocatorBudgetError } from './resolve.js';

/**
 * "平台没接线"这一族的**共同祖先**。
 *
 * 为什么用继承而不是在判据表里多列几个类名：这一族会有第四个、第五个
 * （每加一种"只有某个 adapter 才看得见的东西"就多一个 —— `network`、`newPage`、
 * 等待条件那四种已经是六个抛点了）。列类名的写法要求"加一个类记得回来加一项"，
 * 而**忘了加的那一个恰好落在兜底那格**：本文件的兜底刚从"环境问题"换成"没归因"，
 * 这一族却天生就该是环境问题，漏登记就白换了。
 * 继承把登记变成**写这个类时不得不做的事**（`extends NotWiredError`），忘了编译不过。
 *
 * ⚠ 子类各自**显式写** `this.name`，基类不用 `new.target.name` 兜。
 * 后者少写一行，但名字变成从类名推的 —— 将来过一遍压缩/改名，
 * `keyContext.errorName` 与按它分组的看板会一起变味（那是磁盘字段）。
 */
export class NotWiredError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * 环境缺配置（没配 baseUrl、没配证据存储）。
 *
 * 原先是 `interpreter.ts` 里的一个**私有**类（`class EnvMissing extends Error {}`），
 * 于是外层那个"按异常类型定归因"的判据**看不见它**（跨不到模块私有），
 * 只能靠 `errSummary` 认它的消息，归因则一路落到兜底那格。
 * 搬进来挂上 `NotWiredError` 之后，"环境里没配 baseUrl"与"没接 device adapter"
 * 得到同一个归因 —— 它们的下一步动作本来就是同一个（去改环境，不是改用例）。
 */
export class EnvMissing extends NotWiredError {
  constructor(message: string) {
    super(message);
    this.name = 'EnvMissing';
  }
}

/**
 * 界面类等待条件**说不清该问哪一世界**：作者没写 `world`，而浏览器与设备两条探针
 * 都在场。定义在这个文件而不是 `wait.ts` 有一个硬理由：下面那张表要用 `instanceof`
 * 认它，而**这张表所在的文件不能反过来 import `wait.ts`**（`wait.ts` 已经 import 这里，
 * 反向 import 就是循环）。同一族先例：`NotWiredError` / `EnvMissing` 也住在这里，
 * 尽管它们唯一的消费者是 adapter 那一侧。
 *
 * 归 `case-stale`（见下面那条登记的理由）而不是 `env-unavailable`：
 * 两个 adapter 都在场，**接线好好的**，缺的是用例作者那一句没写。
 * 判成"环境不可用"会让人去配一个已经配好的东西。
 */
export class AmbiguousWaitWorld extends Error {
  /** 哪一件条件选不出来（`uiPredicate` / `template` / `uiIdle`）。给测试与 keyContext 用，不让它只活在文案里。 */
  readonly conditionType: string;
  constructor(conditionType: string) {
    super(`等待条件 ${conditionType} 没写 world，而 ui 与 device 两个 adapter 都在场 —— `
      + '不知道该问浏览器还是手机，**不猜**（猜一个就是把"哪个 adapter 先装配"写进用例结论，'
      + '而两个世界查的是不同的树：另一世界的"没找到"会被当成这一世界的结论）。'
      + '修法：这个条件加上 `world: "web"` 或 `world: "mobile"`。');
    this.name = 'AmbiguousWaitWorld';
    this.conditionType = conditionType;
  }
}

/** 判据表的一项。`base` 用 `instanceof` 匹配，所以子类天然被父类那一条覆盖。 */
export interface ErrorCauseRule {
  readonly base: abstract new (...args: never[]) => unknown;
  readonly cause: FailureCause;
  /** 这一条为什么是这个值。**必填**：没有理由的那一条，下一个人只敢改不敢删。 */
  readonly why: string;
}

/**
 * **唯一那张表**。`causeOfError` 由它派生，`error-cause.test.ts` 也读它 ——
 * 于是"登记"这件事只有一份，而那条测试会扫 `@atest/engine` 实际导出的
 * **每一个错误类**，逐个核对它在原型链上是否撞到表里的某一条。
 * 新加一个错误类而没进表，那条测试就红：把"记得回来加一项"
 * 从人的自觉变成会响的东西（同一个理由见 `lint.test.ts` 里扫真 zod schema 的那条护栏）。
 *
 * **顺序有意义**：`instanceof` 是"是不是"，子类会被父类那条先接住。
 * 所以要把某个子类判得**不同于**它的父类，必须写在父类**前面**。
 * 今天没有这种子类；加的时候记得这一点。
 */
export const ERROR_CAUSE_RULES: readonly ErrorCauseRule[] = Object.freeze([
  {
    base: VarError,
    cause: 'case-stale',
    why: '引用未定义 / 步骤尚无输出 / 生成器种类拼错（GenKindError 是它的子类）。下一步动作是改用例。',
  },
  {
    base: PathError,
    cause: 'case-stale',
    why: '`$.` 路径写坏（不以 $ 开头、下标未闭合、命中多值）。IR 里的字面写法错了，重试不会让它变合法。',
  },
  {
    base: ExprError,
    cause: 'case-stale',
    why: '表达式语法错 / 未知函数 / 未知运算符。同上一条：错在 IR 里。（两类引擎自身的 ExprError 见文件顶部"没做的两件事"。）',
  },
  {
    base: LocatorBudgetError,
    cause: 'case-stale',
    why: '这一步用了比 IR 声明的 maxCostUsdPerResolve 更贵的定位法，是用例/定位器选型问题。报 product-bug 会让人去查一个不存在的功能 bug。',
  },
  {
    base: AmbiguousWaitWorld,
    cause: 'case-stale',
    why: '等待条件没写 world 而两条探针都在场。错在 IR 少写一个字段：重试、换机器、重启浏览器都不会让它变得可判，'
      + '下一步动作是改用例（补上 world），不是去接线（两个 adapter 都在场）。'
      + '判成 env-unavailable 会让人去配一个已经配好的东西。'
      + '**登记在这一行还有一层作用**：`waitUntil` 那句 `causeOfError(e) === "case-stale"` 靠它把这个错**外抛**，'
      + '否则会被"求值报错就再等一轮"吞成一次普通超时（那是本仓反复记的那族"平台侧的事被说成产品侧的事"）。',
  },
  {
    base: NotWiredError,
    cause: 'env-unavailable',
    why: '平台没接线 / 环境缺配置（NoNetworkObserver、NoNewPageObserver、NoConditionAdapter、EnvMissing 都是它的子类）。下一步是接线或改环境。',
  },
  {
    base: TransportError,
    cause: 'env-unavailable',
    why: '连不上 / 超时。细分种类走 keyContext 的 transport 键给**重试判据**用，不进 FAILURE_CAUSE（理由见 interpreter 那处注释）。',
  },
]);

/**
 * 异常 → 归因。**全仓唯一入口**（改动前那五处各写一份，见文件顶部那张表）。
 *
 * 落到兜底 `untriaged` 是**刻意的失败方式**：它是 FAILURE_CAUSE 里本来就有的
 * 合法值，含义就是字面意思"没人认领"，而不是一个看起来能直接行动的答案。
 *
 * 返回值恒为枚举词，**不读 message**，所以这条路径不可能把敏感值带进归因字段。
 */
export function causeOfError(e: unknown): FailureCause {
  for (const r of ERROR_CAUSE_RULES) if (e instanceof r.base) return r.cause;
  return 'untriaged';
}
