/**
 * 响应流的**缓冲**（绝对下标 + 有上限）。
 *
 * ## 为什么要单独成一个模块，而不是留在 session.ts 里的那三十行
 *
 * 因为**淘汰只在第 5001 条响应到来时才发生**，而真浏览器的测试跑到不了那里
 * （一次 navigate 只有几条响应，要跑一千次导航）。
 * 我一开始就是这么写的，然后做了变异检查：把"丢最旧"改成 `pop()`（丢最新）、
 * 把 `idx: ++respSeq` 改成 `idx: rows.length + 1`（下标随数组走）——
 * **六条真浏览器测试全绿**。也就是说这两个 mutation 抓不到，
 * 而它们恰好是这个缓冲唯一真正难的地方。
 *
 * 抓不到的原因不是测试写得松，是**那段逻辑根本没有能被观察到的路径**：
 * 只有纯逻辑层能观察淘汰，所以逻辑要在纯逻辑层。（同一份判断见
 * docs/14 §4.3 的第三个子类："读了、判了，但没有生产者"。）
 *
 * ## 为什么 `status <= 0` 的过滤留在那边、不在这里
 *
 * 那条过滤判的是 **CDP 送来的数据长什么样**（`responseReceived` 之前有
 * `requestWillBeSent`，某些取消路径上还会补 status 0）。它的正确性只能由
 * 真浏览器回答，放这儿只会诱使用户拿我自己编的假事件"证明"它 —— 那是自证。
 * 这里管的是**我们自己的两条不变量**：下标单调、淘汰丢旧。
 * 这两条不需要浏览器，也因此**必须**能在不起浏览器的情况下被证。
 */

/**
 * 上限。一个 200 步、每步 20 个请求的页面会产上万条，每条两个字段；
 * 5000 条足够覆盖"最长的单个等待窗口"，再多就是纯粹的内存浪费。
 */
export const RESPONSE_CAP = 5_000;

/**
 * 有上限的响应缓冲。
 *
 * **两条不变量**（各对应一个抓不到的 mutation，所以下面各有一条测试）：
 *  1. `idx` 与数组长度**无关**：淘汰发生后，新条目的下标继续往前走。
 *     破了这条 => 引擎把旧响应当成本次动作触发的（假绿）。
 *  2. 淘汰**丢最旧**。反了 => 最新那条永远看不到，等待必然超时（假红 + flake）。
 *
 * 淘汰方向之所以是安全的方向：引擎只问"第 N 条之后"，被丢的都是更旧的，
 * 于是最多**少给**候选（超时 = 红，看得见），不可能凭空多给（绿，看不见）。
 * 下一个想"优化内存"的人会考虑清空数组 —— 清空可以，
 * **顺手把序号也归零不行**，那正是第 1 条不变量。
 *
 * ## 为什么"新开的标签页"不共用这个类（我一开始写成了泛型，随后改回来）
 *
 * 因为那一侧要的量是**一个计数**：判据是"这一步期间有没有多出一个由本页打开的页面"，
 * 不是"哪些页面、各自什么地址"。用不上淘汰（整数不会涨），也用不上 items。
 * 而**刻意不存新页面的 URL**：它会进 keyContext/摘要/trace，
 * 而 `?token=` 这种查询串 `redactForDisk` 判不出来（同 responses.ts 那条理由）。
 * 为了"共用一个类"而给一个计数器装上 items + 上限 + 淘汰，是拿抽象当目标；
 * 那个抽象一被写出来，下一个加字段的人会顺手把 url 塞进去 —— 而那正是要防的泄漏面。
 */
export class ResponseBuffer {
  private readonly rows: Array<{ idx: number; url: string; status: number }> = [];
  private seq = 0;

  /** @param cap 上限。**可注入**不是为了通用性：不注入的话，
   *   淘汰路径只能靠推 5001 条来触发，那条测试既慢又没人会写。 */
  constructor(private readonly cap: number = RESPONSE_CAP) {
    if (!Number.isInteger(cap) || cap < 1) throw new Error(`响应缓冲上限必须是 >=1 的整数，收到 ${cap}`);
  }

  /** 追加一条。返回它的绝对下标（调用方不需要，但返回值让"下标是几"这件事可断言） */
  push(url: string, status: number): number {
    const idx = ++this.seq;
    this.rows.push({ idx, url, status });
    if (this.rows.length > this.cap) this.rows.splice(0, this.rows.length - this.cap);
    return idx;
  }

  /** 下标**严格大于** s 的条目。等号不取：s 是"已经消费到的那一条" */
  since(s: number): Array<{ idx: number; url: string; status: number }> {
    return this.rows.filter((r) => r.idx > s);
  }
}
