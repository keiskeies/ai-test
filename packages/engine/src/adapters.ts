/**
 * 执行器抽象 + 时钟/随机数注入（docs/09 §4.2）。
 *
 * 为什么 StepExecutor 是接口而不是解释器里的 if 分支：
 *   压测形态必须**整体绕开解释器**（预编译表达式、复用请求对象、跳过 per-step 证据落盘），
 *   否则测出来的是自己 IO 的天花板（docs/09 §4.2）。在解释器里加 `if (perfMode)`
 *   是这类系统最常见的架构腐化点。
 */
import type { Scenario, StepStatus, TraceEventKindT } from '@atest/ir';

/** 传输层失败的种类。与 adapter 侧的 SendResult.error.kind 同一套词，刻意不另起名字。 */
export type TransportKind = 'timeout' | 'network' | 'aborted';

/**
 * adapter 抛给引擎的**传输层**错误（连不上 / 超时 / 取消），带得上分类。
 *
 * **为什么要有这个类，而不是让引擎去看 error.message**：
 * 重试配置里的 `retryOn: ['network','timeout']` 以前**从来没生效过** ——
 * 引擎侧的判据是 `cause === 'network'`，而没有任何代码把 cause 设成 network
 * （实测：`retry:{count:3}` 配默认 retryOn，一次都不重发）。
 * 最省事的"修法"是 `if (/ECONN|ETIMEDOUT/.test(msg))`，那是**盾牌不是修复**：
 * undici 的措辞变了、换个 fetch 实现、本地化过的错误文本，
 * 都会让它静默退回"不重试"，而症状与"根本没配重试"一模一样。
 * 所以分类由**知道得最多的那一层**（adapter，它本来就在
 * `AbortSignal` 与 fetch 抛出物之间分好了 timeout/network）显式带上来。
 *
 * 只有 error 用这个类；被测算出 500 不是传输错误（那是答案，不是抖动）。
 */
export class TransportError extends Error {
  constructor(readonly kind: TransportKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/** 引擎对外的唯一副作用出口。所有网络/设备/DB 访问都经这里。 */
export interface ExecContext {
  target: 'api' | 'web' | 'android' | 'ios' | 'harmony';
  runId: string;
  /**
   * 当前正在跑的步骤 id。**由引擎在 execCtx() 那一刻填，adapter 只读。**
   *
   * 为什么要有这一格：`saveArtifact(kind, data, stepId)` 要求调用方给 stepId，
   * 而 UI/设备 adapter 是唯一会**自己**产证据的（截图、hierarchy、AX 快照）——
   * 它们手里压根没有步骤坐标，只能自己编一个。编出来的 id 会进
   * `artifact.saved` 事件与 `StepResult.artifactIds`，于是证据包把 A 步的截图
   * 记在 B 步名下。**这正是 evidence.ts 里"按 stepId 反查存储"那个缺陷的另一半**：
   * 那边是引擎猜归属，这边是 adapter 猜，两个都表现为"包里的东西看着都在"。
   *
   * 可选（`undefined`）而不是必填：`runWatchers` 那两处不在任何步骤里
   * （守望规则在步骤之间跑），它们沿用 'watcher' 这个合成坐标。
   * 留空时 adapter **不许自己编** —— 见 web adapter 里 capture 的处置。
   */
  stepId?: string;
  /** 环境（已解析到具体修订） */
  env: Record<string, unknown>;
  /** 密钥解析。只有 adapter 拿得到；Agent 上下文永远拿不到（docs/02 §5） */
  secret(ref: string): string;
  clock: Clock;
  /** 事件发射。引擎同时镜像到 trace.jsonl（crash 后仍可分析） */
  emit(e: EmitInput): void;
  /** 证据存储。返回 artifact id，绝不把大对象塞进变量空间 */
  saveArtifact(kind: string, data: Uint8Array | string, stepId: string): Promise<string>;
  /** 能力探测结果。Agent 生成期与静态闸都读它（docs/09 §1.1 约束 3） */
  capabilities(target: string): { snapshotKind: string; locatorBy: string[]; templateMatch: boolean } | undefined;
}

export interface EmitInput {
  /**
   * 事件类型。**是封闭枚举，不是 string**。
   *
   * 原先这里写 `kind: string`，而引擎侧 `emit` 里有一句
   * `kind: e.kind as TraceEvent['kind']` 把类型擦掉了。后果不是"风格不好"：
   * adapter 发了一条 `kind: 'http'`（不在 TraceEventKind 里），
   * `toTraceJsonl` 照常把它写进 trace.jsonl，而 `parseTraceJsonl` 用 schema 读回时
   * **静默丢掉这一行** —— 于是 trace 里看不见请求什么时候发的、耗时多少，
   * 而文件看起来是完整的、行数也对得上。写侧不校验、读侧才校验，
   * 坏数据就永远到不了写它的人眼前。
   *
   * 改成枚举后这类问题在 **adapter 里编译期就报**，
   * 而不是在三天后有人问"trace 里怎么没有 http 事件"时才发现。
   */
  kind: TraceEventKindT;
  stepId?: string;
  /** 步骤/断言的六态。**别把 HTTP 状态码塞这里**（那是 data.statusCode 的活）。
   *  之前 adapter 传的 `status: String(res.status)` 会因为不是合法状态被整行丢弃 */
  status?: StepStatus;
  durMs?: number;
  data?: Record<string, unknown>;
}

/** HTTP 能力（api adapter 实现） */
export interface HttpExec {
  send(req: {
    method: string; url: string; headers: Record<string, string>;
    body?: unknown; form?: Record<string, string>; timeoutMs: number; maxBytes: number; followRedirects: boolean;
    /**
     * 鉴权**意图**。引擎只说"这一步要用鉴权"，不说怎么用。
     *
     * 为什么引擎不自己写 Authorization：原先它是
     * `headers.authorization = 'Bearer ' + secret(ref)`，三个后果 ——
     *  1. 引擎认识了"方案"（bearer/basic/apiKey-in-query/cookie 是网关语义），
     *     而"引擎能在浏览器里跑只读校验"要求它不知道这些；
     *  2. apiKey 放 query/cookie、basic、oauth2 全写不出来（只有一条 Bearer 硬编码）；
     *  3. **真值进了引擎内存**，于是它能顺着任何一次 keyContext 流到磁盘。
     * 现在引擎只传不透明引用与身份名，值只在 adapter 的一层里被取出。
     *
     * 三个字段都是**可选**且各自独立：
     *  - `ref` —— 步骤上明写的 `secret:<ref>`（IR 里看得见、审校过，优先级最高）
     *  - `identity` —— 多身份场景（权限矩阵用例依赖它）
     *  - `docRef` + `operationId`/`method`/`path` —— 让 adapter 去 spec 里查
     *     这个 operation 声明了哪个 securityScheme。传这些是为了**不传**
     *     解析结果：spec 内容进引擎等于把网关语义带进引擎。
     */
    auth?: { ref?: string; identity?: string; docRef?: string; operationId?: string; method?: string; path?: string };
  }, ctx: ExecContext): Promise<{
    status: number; headers: Record<string, string>; body: unknown; bodyText: string;
    durationMs: number; bytes: number; truncated: boolean;
  }>;
  /** OpenAPI 参数具象化 + 请求侧 schema 校验 */
  resolveOperation(ref: { docRef: string; operationId?: string; method?: string; path?: string }): Promise<{
    /** 解析到的 operationId。缺失时的稳定别名算法见 docs/05 §1（必须是纯函数） */
    operationId?: string;
    method: string; urlTemplate: string; requiredBodyFields: string[]; deprecated: boolean; strategyHint?: string;
  }>;
  /**
   * 请求侧 schema 校验（IR 的 `validateRequest`，M2 的"双向校验"里的请求向）。
   *
   * 为什么在**发出去之前**校验：请求体不符合 spec 时后端的行为是不可预期的 ——
   * 可能 400、可能静默丢弃未知字段、可能 200 但存了半条数据。
   * 用例于是拿到一个"看起来通过"的结果，而它测的根本不是那个接口。
   * 本地挡下来还有一条好处：报错是"你的请求少了 amount 字段"，
   * 而不是"后端回了个 400，原因未知"。
   *
   * 不实现（返回 undefined）时引擎跳过并留一条事件，**不当成通过**。
   */
  validateRequest?(ref: { docRef: string; operationId?: string }, body: unknown): Promise<{ ok: boolean; violations: string[] }>;
  /**
   * 响应侧 schema 校验（docs/05 §1.1 的「符合性检查」）。
   *
   * 语义与请求侧**完全不同**，两条都不能弄反：
   *  1. 只在 `env.specAuthoritative === true` 时调用。默认关 —— docs/00 §6.2 的教训是
   *     "默认开"会让 schema 与实现的小出入刷红几千次，然后团队关掉整个门禁。
   *  2. 结果**只上报不判失败**（引擎侧走 emit，不改 step.status）。
   *     响应不符 spec 的含义是"文档与实现谁错了"，不是"功能坏了"，
   *     混进业务回归的红灯里会让人把所有红灯都当成"又是文档不准"，从而漏掉真 bug。
   */
  validateResponse?(ref: { docRef: string; operationId?: string }, status: number, body: unknown): Promise<{ ok: boolean; violations: string[] }>;
}

/**
 * perform 的返回值。
 *
 * **为什么要有这一格**（原先是 `Promise<void>`）：UI/设备 adapter 在一次动作里
 * 自己产证据（capture 步骤的截图、hierarchy 快照），而 `saveArtifact` 只把 id
 * 还给 adapter —— 没有任何通道把它带回 `StepResult.artifactIds`。
 * 后果实测过（Web 端 capture 步骤真跑一次）：evidence 包清单里写着
 * `stepId: "未归属:shot"`。那个前缀是**兜底机制**给"忘了带 id 的 adapter"留的，
 * 结果成了正常路径的唯一标签 —— 也就是说每一张 Web 截图都被标成"归属不明"，
 * 而它是明确知道属于自己的那一步的。兜底成了默认，就等于兜底在替一个缺失的接口背书。
 *
 * 返回 `void`（不返回东西）仍然合法：那是"这个动作没产证据"，与"产了但没说"
 * 在类型上分不开，但**分不开这件事由证据侧的 `未归属` 前缀说出来**，
 * 而不是靠这里加一个必填字段逼所有 adapter 每次都构造一个空对象。
 */
export interface PerformResult {
  /** 本次动作落进证据存储的 id（`saveArtifact` 的返回值）。**只放自己这次产的** */
  artifactIds?: string[];
}

/**
 * resolve 的返回形状（UiExec 与 DeviceExec 共用，**刻意不各写一份**：
 * 两份字段一样的匿名类型会各自漂移，而 costUsd 这种"只在其中一边被读"的字段
 * 恰好就是本仓那个缺陷类的形态）。
 */
export interface ResolveResult {
  resolvedBy: string;
  rung: number;
  confidence: number;
  nonReplayable: boolean;
  handle: string;
  /**
   * 这次定位的**实际**成本（美元）。见 {@link UiExec.resolve} 那段：
   * 由 adapter 报（它才知道价格表），由引擎审（它才知道人写的上限）。
   * 免费档位返回 0 或省略；**不要返回一个假装非零的小数来"看起来更真"**。
   */
  costUsd?: number;
}

/**
 * Web 端的执行端口。
 *
 * **这里原先还声明着 `navigate(url, waitUntil, ctx)`，本轮删掉了**。
 * 理由不是整理风格：解释器把 navigate 走的是 `perform({op:'navigate', url, waitUntil})`
 * （见 interpreter.ts 的 opOf），所以那个方法**零调用方** ——
 * 而接口上摆着一个引擎从不调用的方法，下一个写 adapter 的人一定会去实现它，
 * 然后疑惑"我写了 navigate 为什么没被调"。docs/14 §4.7 对这种东
 * 的处理是删，不是加一句注释留着。
 * 与 DeviceExec 对齐也是同一个方向：那边从来只有 perform。
 *
 * 反方向的改法（让解释器改调 navigate）也想过，不选：那会让 web 与 device 两侧
 * 各有一套派发方式，而 hitTargetCheck / expectResponse 这些前置检查就得写两遍。
 * 现在这套是"所有动作一个入口，op 里带参数"。
 */
export interface UiExec {
  perform(op: unknown, target: unknown, ctx: ExecContext): Promise<PerformResult | void>;
  snapshot(ctx: ExecContext): Promise<{ kind: string; data: string; sha: string }>;
  /**
   * 返回实际使用的定位策略与级别，供 flaky 治理统计（docs/00 §5.11）。
   *
   * `costUsd`（本轮加）：这一次定位**实际**花了多少钱（美元）。
   * 只有调模型的档位（视觉兜底、模板分类）会有值；
   * testid/role/label 这些查询档位要么返回 0 要么不返回 ——
   * **不要为了"字段齐"编一个小数**，那会让预算审计变成一个装饰。
   *
   * 为什么由 adapter 报而不是引擎自己算：阶梯是 adapter 的（哪些档位存在、
   * 各自用什么模型都在它那边），引擎重算一遍价格表就是第二份会漂的真相。
   * 但**判定仍在引擎**：`maxCostUsdPerResolve` 由引擎读并审（resolve.ts 的 `chargeResolve`，
   * 步骤与等待循环两条路共用它）。
   * 反过来的写法（adapter 自己判"我超预算了所以降级"并只回一个布尔）
   * 会把价格表与上限的**对账**也一起藏进 adapter ——
   * 那正是本仓那个缺陷类（人在 IR 里写了个值，执行侧没人拿它判过）。
   *
   * **⚠️ 今天还没有实现报这个数**（`adapter-web/src/ui.ts` 的 `resolve()` 返回里没有它）。
   * 于是引擎侧那套审计**一次都不会触发**。补的时候请照实报，
   * 别为了让闸门"看起来在工作"而填一个小数 —— 见 docs/14 §4.3 的第三个子类。
   */
  resolve(locator: unknown, ctx: ExecContext): Promise<ResolveResult>;
  assertUi(payload: unknown, ctx: ExecContext): Promise<{ passed: boolean; actual: unknown; expected: unknown }>;
}

export interface DeviceExec {
  lease(req: unknown, ctx: ExecContext): Promise<{ id: string; deviceRef: string; expiresAt: number }>;
  renew(lease: { id: string }, ctx: ExecContext): Promise<{ expiresAt: number }>;
  release(lease: { id: string }, ctx: ExecContext): Promise<void>;
  app(action: string, args: Record<string, unknown>, ctx: ExecContext): Promise<unknown>;
  snapshot(ctx: ExecContext): Promise<{ kind: string; data: string; sha: string }>;
  /** 同 UiExec.perform：设备端 tap/app 也会自己产证据（截图、hierarchy），
   *  没有这个返回值就只能让证据归属落到 `未归属:` 兜底上 */
  perform(op: unknown, target: unknown, ctx: ExecContext): Promise<PerformResult | void>;
  /** 同 UiExec.resolve（含 costUsd 的语义） */
  resolve(locator: unknown, ctx: ExecContext): Promise<ResolveResult>;
  /** DB 行等待条件也归到 adapter 侧（引擎不碰网络） */
  query?(sql: string, vars: Record<string, unknown>, ctx: ExecContext): Promise<unknown[]>;
}

/**
 * 证据存储端口（M6）。
 *
 * **id 由存储侧算，不由引擎编**。早先引擎自己拼 `art_<哈希>_<kind>` 然后返回，
 * 而那个哈希是把 32 位 FNV-1a 重复四遍凑成 64 个十六进制字符的**伪 sha256** ——
 * 看着像 sha256，实际只有 2^32 空间；更要命的是**压根没存任何东西就返回了 id**，
 * 于是 `StepResult.artifactIds` 里躺着一串永远取不到内容的哈希，
 * 而 evidence 包看起来是完整的。内容寻址的"址"必须由真正落地那一方给出：
 * 两边各算一遍迟早不同（一边按 UTF-16 码元、一边按 UTF-8 字节）。
 *
 * 引擎不 import node:fs / node:crypto，所以真实现来自 adapter 或 CLI。
 */
export interface ArtifactStore {
  /** 落一份证据，返回**可用于取回**的 id（约定为内容寻址，同内容同 id） */
  save(kind: string, data: Uint8Array | string, stepId: string): Promise<string>;
  /** 取回。找不到返回 undefined（不抛）——"证据被清理了"是合法状态，不是程序异常 */
  load(id: string): Promise<{ kind: string; bytes: Uint8Array; sha256: string } | undefined>;
}

/**
 * 一次页面内请求的**观测记录**。
 *
 * 为什么形状这么瘦（只有 url 与 status）：
 *  - **不带响应体**：那要落证据、要走脱敏闸，属另一条路（响应体断言归 http 步骤与
 *    assert 步骤，docs/06 §4）。把 body 塞进这里，就会有人拿它当"接口的答案"用，
 *    而它压根没经过脱敏 —— 而这一族数据是要进 trace 的。
 *  - **不带时间戳**。我一开始加了 `at`，随即撤掉：谁来盖这个数是个真问题 ——
 *    adapter 报 `Date.now()` 在冻结时钟下与引擎的 `clock.now()` 不同源
 *    （两边各记一份迟早对不上，同一个缺陷类），而引擎在**拉取那一刻**盖的数
 *    又不等于观测时刻（一批内的多条会拿到同一个时间，反而更假）。
 *    "谁先谁后"这件事由**数组下标**（游标）答，它天然全序且与任何时钟无关。
 *    一个没人读的字段就是本仓那个缺陷类的标准形状，所以不留。
 */
export interface ObservedResponse {
  /**
   * adapter 侧的**绝对下标**（从 1 起、只增不减）。
   *
   * 为什么要把这个数交给引擎而不是让引擎"按条数推进游标"（我第一版就是按条数）：
   * 按条数推进**默认了返回的切片是连续的**，而 adapter 有内存上限、会淘汰旧条目。
   * 淘汰之后引擎的账会比真实的流慢，慢出来的那段会被**再报一次**
   * —— 也就是"上一步消费过的响应又被算作本步的新响应"，正是这个模块存在的理由
   * 要防的那个假绿，只是换了个触发条件（跑够 5000 条响应才现形，比直接写错更难查）。
   * 带上下标之后，游标 = **看过的最大下标**，与"这次给了几条"无关，淘汰与否都成立。
   *
   * 这不是"第二个数源"（那条理由撤掉了 `responseCount()`）：它是**每条自带的属性**，
   * 游标由它派生，而不是另外问一次"一共几条"。
   */
  idx: number;
  url: string;
  status: number;
}

/**
 * 页面内请求的**观测**端口（docs/06 §3 的 `expectResponse` / `wait{response}`）。
 *
 * **为什么必须有这一层，而不是引擎自己记账**：引擎不许碰网络（lint-layers 硬约束），
 * 而页面里 XHR/fetch 发出的请求**只有浏览器看得见**。以前 `wait{response}` 读的是一个
 * 叫 `__responses` 的变量，而**全仓没有任何地方往里写**（grep 只命中读它的那一行），
 * 于是这个"Web 侧最有价值的等待"永远超时。
 *
 * **为什么是 pull 而不是 push**：`since` 让 adapter 只保留一个递增数组、
 * 引擎按游标取新条目。push（adapter 持回调）会把"谁在听"变成 adapter 的责任，
 * 而等待循环之外没人听 —— 回调泄漏与"回调指向上一轮的等待"都是这类接口的常客。
 * pull 的另一条好处：**同一轮里两次 wait 各拿自己的游标，互不消费**
 * （push + 队列的话，第二个 wait 会看不见被第一个 wait 吃掉的那条）。
 *
 * 缺省（没这个端口）时 `wait{response}` **明确报错**，不再静默超时。
 */
export interface NetworkObserver {
  /**
   * 返回下标**严格大于** `since` 的所有响应，按观测顺序升序。首次传 0。
   *
   * **切片可以有空洞**：adapter 有内存上限，淘汰旧条目后中间会缺号。
   * 调用方靠每条自带的 `idx` 定位，不靠条数，所以空洞无害。
   * （反过来说，实现方**不能**为了"看起来连续"而把下标重排 ——
   *  那会让引擎把旧响应当成新的，是假绿。宁可留空洞。）
   *
   * **只有一个方法，刻意不加 `responseCount()`**：那样就有两个数要同源
   * （"总数"与"从某处起的切片"各算一遍迟早对不上，而错的方式是漏几条或重复几条 ——
   *  与 §4.3 那一族同形）。
   *
   * 实现方只需保证"下标单调追加、不回退"，不必持久化。
   */
  responsesSince(since: number): Promise<ObservedResponse[]>;
}

/** 注册表。引擎只认这个，不认 Playwright/Appium。 */
export interface AdapterRegistry {
  /** 证据存储。缺省时**任何 saveArtifact 调用都会失败**（而不是返回一个假 id）：
   *  拿不到存储就把 id 记进 artifactIds，等于让证据包看起来完整而实际取不到东西 */
  artifactStore?: ArtifactStore;
  http?: HttpExec;
  ui?: UiExec;
  device?: DeviceExec;
  /** 页面内请求观测（Web 端）。没有它，`wait{response}` 与 `expectResponse` 都报"环境缺失" */
  network?: NetworkObserver;
  /**
   * "由当前页面新打开的标签页/窗口"的**计数**观测（IR 的 `act{expectNewPage:true}` 靠它）。
   *
   * **为什么单独一个端口而不塞进 `NetworkObserver`**：那一族回答的是
   * "页面发过哪些请求"，这一族回答的是"页面开过几个窗口"，两者生命周期完全不同
   * （响应流要窗口化、要有淘汰；这个只是一个单调整数）。合成一个端口的话，
   * 实现方被迫为"我只要数个数"这件事再维护一份响应缓冲。
   *
   * **只给计数、不给 URL，是刻意的**：URL 会进 keyContext/摘要/trace，
   * 而 `?token=` 这种查询串 `redactForDisk` 判不出来（值形态规则只认
   * JWT/AKIA/sk-/Bearer 形状）。计数足够判"有没有开新窗口"这个断言。
   *
   * 缺省（没这个端口）时 `expectNewPage: true` **报 error + env-unavailable**，
   * 不判 fail：判 fail 会说成"被测产品没弹窗"，而真实原因是这个 adapter
   * 没法观测窗口事件 —— 前者让人查产品，后者让人查平台。
   */
  newPage?: { count(): number };
  db?: { query(datasource: string, sql: string, vars: Record<string, unknown>, ctx: ExecContext): Promise<unknown[]> };
  llm?: { judge(req: unknown, ctx: ExecContext): Promise<{ passed: boolean; evidence?: unknown; costUsd: number }> };
  /**
   * `call` 步骤的子场景解析器：把 `scenarioRef`（`id@version`）换回一份 IR。
   *
   * **它以前不在本类型上** —— 引擎里靠
   * `(adapters as unknown as { callScenario: ... }).callScenario(ref)` 取用。
   * 后果实测过：测试里把它拼错/漏掉，`tsc` 一声不响（`as never` 全覆盖），
   * 运行时才拿到 `adapters.callScenario is not a function`，
   * 于是"子场景没跑"这件事以 error 形态出现在**被测产品**的结论里，
   * 而它其实是接线错误。端口进了类型之后，少注入是编译错误，不是环境错误。
   *
   * 返回 `undefined` 表示"这个 ref 解析不到"（版本不存在 / 没权限看）——
   * 引擎按 env-unavailable 报，不猜、不静默跳过。
   */
  callScenario?(ref: string): Promise<Scenario | undefined>;
  capabilities?(target: string): { snapshotKind: string; locatorBy: string[]; templateMatch: boolean } | undefined;
}

/**
 * 时钟与随机数注入点。
 * 金样测试与压测要冻结它们，否则「回放」只是一段视频而不是证据（docs/00 §5.9）。
 */
export interface Clock {
  now(): number;
  /** 单调时钟（毫秒，非负、单调不减）。时长计算一律用它，不用墙上时间 */
  mono(): number;
  /** 可控睡眠。测试里是立即返回 */
  sleep(ms: number): Promise<void>;
  random(): number;
  mode: 'live' | 'frozen' | 'recorded';
}

/** 真实时钟。Node 侧由 adapter/CLI 注入，engine 自身不调任何 node API。 */
export function liveClock(): Clock {
  const start = Date.now();
  return {
    now: () => Date.now(),
    mono: () => Date.now() - start,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: () => Math.random(),
    mode: 'live',
  };
}

/** 确定性时钟：mono 按 sleep 累加、random 用可复现 LCG。测试与压测预编译形态用。 */
export function deterministicClock(seed = 1): Clock {
  let s = seed >>> 0;
  let t = 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return {
    now: () => 1_700_000_000_000 + t,
    mono: () => t,
    sleep: async (ms) => { t += ms; },
    random: rnd,
    mode: 'frozen',
  };
}
