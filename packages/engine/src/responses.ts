/**
 * 页面内请求的**观测窗口**（docs/06 §3 的 `expectResponse` / `wait{response}`）。
 *
 * ## 这个文件存在的理由：一条永远绿的等待
 *
 * `wait{response}` 以前长这样（`wait.ts` 改动前）：
 *
 * ```ts
 * return d.evalExpr(`__responses != null && count(filter(__responses, "url =~ '${c.urlPattern}'")) > 0`);
 * ```
 *
 * 两层都是坏的，而且**第二层把第一层藏住了**：
 *  1. `__responses` **全仓没有任何地方往里写**（grep 只命中这一行读它的代码）。
 *     于是这个条件恒为假。实测：`wait{response}` 无论怎么配都超时 fail，
 *     摘要写"等待接口 /api/query"—— 一句把**接线缺失**说成**被测产品没发请求**的诊断。
 *  2. 就算手工把 `__responses` 塞进变量空间，那条表达式**自己也跑不通**：
 *     本仓表达式语言的字符串字面量不用单引号（`expr.ts`），实测每 poll 都抛
 *     `引用必须以 $ 开头（路径：url =~ '/api/query'）`。
 *     这个异常被 `waitUntil` 的 catch 收成"求值报错"继续干等，最后仍是超时。
 *
 * **所以这条"Web 侧最有价值的等待"从落地那天起一次都没有工作过**，
 * 而它的失败方式与"被测页面确实没发那个请求"**逐字节相同**（同一条超时、同一个 cause）。
 * 这是 §4.3 那一族最纯的一例：字段有、schema 有、`describePredicate` 里连人话描述都有
 * （"等待接口 X"），**只有生产者和判据没有**。
 *
 * ## 为什么判据在引擎、观测在 adapter
 *
 * adapter 只回答"页面里发生过哪些请求响应"（只有浏览器看得见，引擎不许碰网络）；
 * **"哪个算命中"由引擎判**（`matchResponseUrl`）。让 adapter 自己按 pattern 过滤，
 * 就把匹配语义分散到了每个 adapter 里 —— 而 `wait{response}` 与 `expectResponse`
 * 两处要用**同一个**匹配口径，分两处写迟早不一样（本仓那一族的标准成因）。
 *
 * ## 窗口的起点为什么是"上一个步骤开始时的条数"
 *
 * 两个方向的错都要挡：
 *  - 窗口从**会话开头**算 => 前几步就发过的同名接口会让等待**立刻通过**（假绿）。
 *  - 窗口从**本步开始**算 => `act` 触发、在"上一步返回"与"本步开始"之间落地的响应
 *    会被漏掉，等待干到超时（假红 + flake）。
 * 取"上一步开始时的条数"同时避开两者：上一步的动作算数，更早的不算数。
 * 拿不到（第一个步骤 / 没有网络观测）时退化为"本步开始"，方向是**保守**的：
 * 宁可多等到超时（红，看得见）也不悄悄绿 —— 与本文件 `wait.ts` 里 gone 方向同一条立场。
 */
import type { NetworkObserver, ObservedResponse } from './adapters.js';

/**
 * pattern 与 url 的匹配口径：**子串包含**，区分大小写。
 *
 * 刻意不是正则、不是 glob：
 *  - **正则**：pattern 是人写在 IR 里的，`new RegExp(pattern)` 让一条 `(a+)+$`
 *    把整个 run 钉死（ReDoS 不必修，少一个入口就行）；而 URL 是**页面产出的不可信数据**，
 *    拿它去喂一个由 IR 决定的正则在性能上也是不可控的。
 *  - **glob**：要自己实现一套通配语义，而 `*` 在 URL 里本来就是合法字符，
 *    歧义比省下的字符多。
 * 子串是 Playwright `waitForResponse(str)` 的口径（文档明写 "string => substring"），
 * 也是国内用例里最常用的写法（等 `/api/order/query`），够用且**没有 surprises**。
 * 要精确匹配整段的作者可以写更长的子串（带 host 或带 `.json` 后缀）。
 */
export function matchResponseUrl(pattern: string, url: string): boolean {
  return url.includes(pattern);
}

/** IR 里声明的筛选：url 子串 + 可选状态码白名单。**两个条件都要成立** */
export function responseMatches(
  r: ObservedResponse,
  pattern: string,
  statuses?: readonly number[],
): boolean {
  if (!matchResponseUrl(pattern, r.url)) return false;
  return statuses === undefined || statuses.length === 0 || statuses.includes(r.status);
}

/**
 * 一次 run 共享的"已经读到第几条响应"的账。
 *
 * ## 为什么需要它（而不是每次开窗都从 0 开始）
 *
 * 开窗起点 = 会话开头的话，第 3 步发过的接口会让第 9 步的 `wait{response}`
 * **立刻通过**（假绿）—— 而这条等待承诺的正是"我刚做的那个动作真的触发了这个接口"。
 * 所以每一步开始时要把起点定在"此刻"，而"此刻是第几条"只有 adapter 知道。
 *
 * ## 为什么账在引擎（而不是问 adapter 要一个 count）
 *
 * 问 `adapter.count()` 会引入**第二个数源**：游标与"从某处起的切片"各算一遍迟早对不上，
 * 而错的方式是漏几条或重复几条（`NetworkObserver` 只留一个方法就是这条理由）。
 * 引擎侧记一本自己的账，唯一依赖是 adapter 那个"返回第 since 条之后"的契约。
 *
 * ## 为什么是 max 而不是 +=（并发那一条）
 *
 * `parallel` 的两个分支可能在同一轮里各 poll 一次**同一条流**：
 * 支 A 读到 [5,6]、支 B 也读到 [5,6]（它起点也是 5）。用 `+= items.length`
 * 会把同两条记成 4 条，账跑到流的前面 => 下一步开窗的起点比真实位置更靠后 =>
 * **真的响应被跳过**（假红 + flake）。`observe` 收的是"本窗口读到的绝对下标"，
 * 取 max 是**幂等**的：两条分支报同一个数，账就是那个数。
 *
 * 这与 `addCost` 用求和是对的：钱是**各支各花**的（两条分支各自付费），
 * 而响应是**同一条流**（两条分支看到的是同一批条目）。
 * 看起来都能用 sum 的两个量，一个是可加的、一个不是。
 */
export class ResponseLedger {
  private last = 0;
  /** 某个窗口读到了绝对下标 `cursorAfter` 之前的全部条目 */
  observe(cursorAfter: number): void {
    if (cursorAfter > this.last) this.last = cursorAfter;
  }
  /** 当前账位 = 新窗口的起点。"这一步开始时还没读到任何新响应"时它等于上一步的终点 */
  snapshot(): number {
    return this.last;
  }
}

/**
 * 一次等待 / 一次动作共用的观测窗口。
 *
 * **游标只在 poll 时前进，读取不消费**：一次 poll 把新条目累进 `seen`，
 * 之后同一次求值里的**所有**分支（`allOf`/`anyOf`/`noneOf`）都看**同一份累计列表**。
 * 这一点是刻意的：如果每个 `response` 分支自己拉一次并推进游标，
 * `anyOf[接口A, 接口B]` 里的 A 会把条目吃掉、B 永远看不见 ——
 * 症状是"复合条件里只写一个接口能过、写两个反而过不了"，
 * 而这类"两个各自对、合起来错"的 bug 单测分支是测不出来的。
 */
export class ResponseWindow {
  private seen: ObservedResponse[] = [];

  /**
   * @param since 窗口起点：该下标**之前**观测到的响应一律不算命中。
   *   （写成 `private cursor = since` 而不是构造体里赋值：我第一版写了个
   *    `private cursor: number` 却**忘了在构造函数里赋 since** —— tsc 的
   *    `strictPropertyInitialization` 报了它，否则它会一直是 `undefined`，
   *    于是每次开窗都等于"从会话开头算"，也就是这个类要防的那个假绿照旧存在，
   *    而且连"没人传起点"的痕迹都不留。**参数有、类有、没人接** —— 本仓那一族。）
   * @param onConsumed 每次拉到新数据后回调，参数是**本窗口已读到的绝对下标**。
   *   解释器用它记 run 级账。**必填**：可选的话"忘了接"编译得过，
   *   而漏接的症状是下一次开窗的起点是旧值 —— 上一步已经消费过的响应会
   *   **再次**算命中，也就是那个假绿换了个地方活着。
   */
  constructor(private cursor: number, private readonly onConsumed: (cursorAfter: number) => void) {}

  /**
   * 拉一次新数据。等待循环每 poll 调一次；动作步骤只调一次。
   *
   * 游标推进到**本批里最大的绝对下标**，不是 `+= items.length`
   * （我第一版是后者）。差别在 adapter 淘汰旧条目之后才显形：切片出现空洞时，
   * 按条数推进会让游标**落后于真实的流**，落后的那几条会在下一次 poll 被**再报一次**
   * —— 于是"上一步已经消费过的响应又被算作本步新响应"，也就是这个模块要防的那个假绿，
   * 只是改成"跑够 5000 条响应才现形"。按最大下标走则与淘汰与否无关。
   */
  async poll(observer: NetworkObserver): Promise<void> {
    const items = await observer.responsesSince(this.cursor);
    if (items.length === 0) return;
    this.seen.push(...items);
    for (const it of items) if (it.idx > this.cursor) this.cursor = it.idx;
    this.onConsumed(this.cursor);
  }

  /** 窗口内是否有命中该条件的响应 */
  any(pattern: string, statuses?: readonly number[]): boolean {
    return this.seen.some((r) => responseMatches(r, pattern, statuses));
  }

  /**
   * 窗口内命中该条件的响应（用于报告的命中数）。
   *
   * 为什么只给**条数与首个状态**、不给整段 URL：URL 会进 summary/trace/报告，
   * 而它可能带 token / 手机号 / 订单号（`?token=`、`?phone=`）。
   * 一条"方便调试"的摘要正是最容易被加进报告、又最不容易被脱敏的那一处 ——
   * 所以**这里根本不产 URL**，而不是产了再指望调用方记得过脱敏。
   * （`redactForDisk` 按字段名与值形态判，`?token=abc` 这种塞在自由文本里的
   *  查询串它判不出来 —— 值形态规则只认 JWT/AKIA/sk-/Bearer 这几种形状。）
   */
  matchCount(pattern: string, statuses?: readonly number[]): number {
    return this.seen.filter((r) => responseMatches(r, pattern, statuses)).length;
  }

  /** 窗口内看到过的响应总条数（"没命中"的摘要要说清窗口是空的还是有别的东西） */
  get seenCount(): number {
    return this.seen.length;
  }

  /** 命中项的状态码（升序去重），用于摘要 —— 状态码不是敏感值，URL 是 */
  matchedStatuses(pattern: string, statuses?: readonly number[]): number[] {
    return [...new Set(this.seen.filter((r) => responseMatches(r, pattern, statuses)).map((r) => r.status))].sort((a, b) => a - b);
  }
}

/**
 * 缺网络观测口。在**条件求值时**抛（而不是在等待开始前预检谓词树），
 * 并由 `waitUntil` 的 catch **原样往外抛**而不是收成"求值报错继续等"。
 *
 * 归因：落到 `runStep` 的 catch => `error` + `env-unavailable`，
 * 也就是"平台侧没接上"而不是"被测产品坏了"（不是 fail，不是 product-bug）。
 * 这与"超时 => fail"的区别就是这条报错的全部价值：
 * 前者让人去查接线，后者让人去查一个可能确实发了请求的接口。
 *
 * **为什么不预检谓词树**（我一开始写的是"等待开始前扫一遍有没有 response 条件"）：
 * 那要求"哪些条件需要网络"这件事在第二个地方也保持正确，
 * 而新增一种需要网络的条件时没人会记得回来加一项 —— 漏加的那一种
 * 恰好退回本轮修掉的那个形态（被吞成超时）。求值时判一次，
 * 覆盖的是真实走到的分支，且只有一份判据。
 */
export class NoNetworkObserver extends Error {
  constructor() {
    super('等待条件里有 response（等某个接口回来），但没配 adapters.network —— '
      + '页面内请求只有浏览器看得见，引擎不碰网络，所以没有任何东西能提供这个数据。'
      + '（Web 端由 adapter-web 提供；没起浏览器时这条等待无法工作）');
    this.name = 'NoNetworkObserver';
  }
}
