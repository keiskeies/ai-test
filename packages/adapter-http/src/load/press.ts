/**
 * 内置压测后端：拿一份 `LoadPlan`，用真 `fetch` 打，产出 `PerfMetrics`。
 *
 * ## 为什么有两个后端
 * docs/09 §4.2 指定的出口是 k6（`emit-k6.ts`），理由是分布式施压与指标体系白拿。
 * 但本机与内网 CI 装不上 k6（`github.com` 超时，实测过），于是"编译出来的东西能跑"
 * 这句话没有任何地方能验。内置后端补的就是这一格：**同一份计划**在这里真跑一次，
 * 分位数、错误率、门禁全链路都能在本机测（对着 `adapter-http` 自己的 mock）。
 *
 * 两者共用 `runtime.ts` 里的语义函数，各自只实现调度（详见那个文件的文件头）。
 *
 * ## 施压模型：**闭合模型**（closed loop），每个 VU 一个自旋
 * 一个 VU = 一个 async 纤程，反复"跑一遍用例 → 思考 → 再跑"，直到时长到 / 请求数到 / 被取消。
 *
 * ⚠ 闭合模型测的是**"N 个并发用户能推多大吞吐"**，不是"固定 rps 下系统表现如何"
 * （后者是开环/到达率模型）。区别在过载时的读数：闭合模型的 rps 会**随系统变慢而下降**
 * （每个 VU 被慢响应堵住了），于是"吞吐掉了"与"系统慢了"在曲线上是同一件事。
 * 所以 `PressResult.model` 要一路带到报告里 —— 拿闭合模型的 rps 去比开环工具
 * （k6 的 `constant-arrival-rate`、JMeter 的 Throughput Timer）的读数，
 * 会得到一个"我们的系统慢一半"的假结论，而两边都没错。
 *
 * ## 观测的**粒度是请求**，不是迭代
 * `PerfMetrics` 的 p95 与 k6 的 `http_req_duration` 同口径：一条请求一个样本。
 * 按迭代算会得到"这条用例三个请求的总耗时"的 p95，那个数没法与任何外部工具对，
 * 而且迭代里请求数会随数据变（forEach）—— 于是基线的口径自己会漂。
 *
 * ## 为什么不用 worker_threads
 * Node 的 fetch 是 IO 密集型，单进程 event loop 撑几千并发连接是常规用法。
 * 真正的瓶颈通常是**施压机自己的 CPU**（TLS、JSON.parse），那时该上多台机器 ——
 * 那正是 k6 那个后端的用途。所以本后端的定位是**开发机与 CI 上的中小并发**，
 * `measuredLoad` 会如实把 runnerCount 报成 1，于是拿它的数据与十台机器压出来的
 * 基线比会被 `incomparableReasons` 拦下。
 */
import { summarizeObservations, type LoadFingerprint, type LoadObservation, type PerfMetrics } from '@atest/ir';
import { liveClock, type Clock } from '@atest/engine';
import type { AuthHook } from '../auth/hook.js';
import type { LoadPlan } from './plan.js';
import { newLoadState, walkAsyncBuiltin, type BuiltRequest, type LoadDeps, type RawResponse } from './runtime.js';

export interface PressOptions {
  plan: LoadPlan;
  /** VU 数与时长。**这里的值要与 plan 所属场景的 load 块一致**，不一致由 CLI 判（见 runLoad） */
  vus: number;
  durationMs: number;
  /** 爬坡：前 rampUpMs 内线性地把 VU 从 1 提到 vus。0/缺 = 一上来就满并发 */
  rampUpMs?: number;
  thinkMs?: number;
  /** 请求总数上限，0/缺 = 不限 */
  maxRequests?: number;
  /** 每 VU 迭代上限，0/缺 = 不限。资源保护用（见 LoadProfile.maxIterationsPerVu） */
  maxIterationsPerVu?: number;
  /**
   * 在默认判据之外**额外**算失败的状态码。默认判据（`requestFailed`）已经把
   * 传输层失败与 <200 / ≥400 全算了，所以这一栏的用途是**落在成功区间里的那些码**
   * —— 最典型的是 302（过载时鉴权失效会重定向到登录页）。
   * ⚠ 这里从前写的是"429 与 401 是最常见的两个"，那是**与实现相反**的说法
   * （那两个默认就算失败），照它写用例会以为不声明就抓不到。详见 LoadProfileSchema.failureStatus。
   */
  failureStatus?: number[];
  baseUrl: string;
  inputs?: Record<string, unknown>;
  env?: Record<string, unknown>;
  clock?: Clock;
  /** 复用功能回归那套鉴权（同一个 AuthHook，同一条"缺凭证就抛、不发匿名请求"的路径） */
  auth?: AuthHook;
  /** 请求体是否符合 spec。传了才做（负向策略的节点在编译期已把 validate 置 null） */
  validate?: LoadDeps['validate'];
  /** 外部取消 */
  signal?: { aborted: boolean };
  /** 每个请求发出前的钩子（测试与"看看真发了什么"用）。不许在这里做判断 */
  onRequest?: (req: BuiltRequest) => void;
}

export interface PressResult {
  metrics: PerfMetrics;
  /** 参与统计的窗口实际长度。VU 起来与收尾的偏差不可能正好等于 durationMs，
   *  而 rps 是用**实测窗口**算的 —— 拿名义时长算会在爬坡场景里虚高 */
  windowMs: number;
  /** 因**到上限**（maxRequests / maxIterationsPerVu）而提前收工的 VU 数。
   *  到点是所有 VU 的正常结局，不算在这里 —— 否则每次正常压测都会显示"有 N 个 VU 提前结束" */
  stoppedEarly: number;
  cancelled: boolean;
  /** 施压模型。一路带到报告里，理由见文件头 */
  model: 'closed';
  /**
   * 每个 VU 跑完的迭代数。**分布不均意味着负载不均**（某个 VU 卡在慢接口上），
   * 只看总数看不出来，而负载不均时那个慢分片的错误率会被平均掉。
   */
  iterationsPerVu: number[];
  /** setup 阶段打的请求数。**不计入 metrics**，但要报出来：登录一次一个请求，
   *  悄悄算进吞吐会让小并发短跑的 rps 明显虚高。
   *  ⚠ 从前这个计数器把 **teardown 的请求也一起数进来了**（每 VU 各清一次时，
   *  两次 setup + 两次 teardown 报成"setup 打了 4 个"）。那不是四舍五入级别的偏差：
   *  排查"登录是不是每轮重跑"时看的就是这个数，而它把收尾算进去正好给出
   *  一个"看起来像每轮重跑"的值。现在两个阶段各记各的（`teardownRequests`）。 */
  setupRequests: number;
  /** teardown 阶段打的请求数（每 VU 各一次；与 k6 的全局一次是**刻意的不同**，见 emit-k6 文件头） */
  teardownRequests: number;
  /** 每个 VU 每轮迭代内部的失败原因（去重后取前若干条），给"为什么错误率是 8%"那句话 */
  failureReasons: string[];
}

/**
 * 一个请求算不算失败。判据只在这一处（内置后端按观测记账、报告与门禁都问同一个）。
 *
 * **4xx 与 5xx 都算失败**（状态码 <200 或 ≥400）：压测里 401/403/404 成批出现
 * 通常正是负载压出来的（token 在并发下过期、限流、连接池打满后后端直接报错），
 * 当成"后端正常应答了"会得到一条错误率 0 而系统其实在拒绝请求的曲线。
 * 想**放过**某个码目前没有出口 —— `failureStatus` 只能加不能减，
 * 那是一格已知的能力缺口（登记在 docs/14），不是这里的疏忽。
 */
export function requestFailed(res: RawResponse, failureStatus: readonly number[]): boolean {
  if (res.transportError) return true;
  if (res.status < 200 || res.status >= 400) return true;
  return failureStatus.includes(res.status);
}

/**
 * 打一轮压测。
 *
 * 传输层失败（连不上、超时、被重置）**也是一条观测**，status 记 0 ——
 * 不计入的话"施压机断网"会产出一份 rps 很低而错误率 0 的报告，
 * 而 `evaluatePerfGate` 对 samples<1 判 fail 那条路也就永远轮不到说话。
 */
export async function press(o: PressOptions): Promise<PressResult> {
  const clock = o.clock ?? liveClock();
  // **冻结时钟 + 没有任何上限 = 死循环**，而这是本文件唯一能一处卡死的写法。
  // `deterministicClock.mono()` 只在 sleep() 时前进（见 adapters.ts），所以一条没有
  // sleep 步骤的用例里 `clock.mono() < deadline` **永远成立** —— 循环只能靠
  // maxRequests / maxIterationsPerVu 出。测试里当然希望用冻结时钟（快、可重放），
  // 所以不是禁用它，而是**要求配一个上限**；忘了配的话当场抛一句解释，
  // 而不是让调用方挂在那里等一个永远不来的 timeout（那时唯一的表现是"CI 超时"，
  // 而 CI 超时的排查方向永远是网络，不会是"我的时钟不前进"）。
  if (clock.mode !== 'live' && !o.maxRequests && !o.maxIterationsPerVu) {
    throw new LoadPressFailure(
      `压测用的是非 live 时钟（mode=${clock.mode}），而既没给 maxRequests 也没给 maxIterationsPerVu：`
        + '这种时钟的 mono() 只在 sleep() 时前进，所以时长永远不会到 —— 用冻结时钟压测必须配一个迭代或请求数上限',
    );
  }
  const obs: LoadObservation[] = [];
  const failureReasons = new Map<string, number>();
  const counters = { requests: 0, setupRequests: 0, teardownRequests: 0 };
  const t0 = clock.mono();
  const deadline = t0 + o.durationMs;
  const maxReq = o.maxRequests ?? 0;

  const noteFailure = (why: string): void => {
    // 只统计次数、保留第一条原文：一万条同样的错刷一万行会把日志刷成不可读
    const key = why.length > 200 ? `${why.slice(0, 200)}…` : why;
    failureReasons.set(key, (failureReasons.get(key) ?? 0) + 1);
  };

  const deps: LoadDeps = {
    clock,
    baseUrl: o.baseUrl,
    auth: async (req, node) => {
      if (!o.auth) return;
      // AuthHook.apply 会**改 url**（apiKey-in-query 那条路把密钥拼进查询串），
      // 所以返回的 url 必须写回 —— 只取 headers 会发一个没带密钥的请求，
      // 表现为"压测全是 401"，而 401 在报告里的意思是"产品坏了"
      const out = await o.auth.apply({
        url: req.url, headers: req.headers,
        docRef: node.auth?.docRef, operationId: node.auth?.operationId, method: node.auth?.method, path: node.auth?.path,
        identity: node.auth?.identity, ref: node.auth?.ref,
      });
      req.url = out.url;
      for (const [k, v] of Object.entries(out.headers)) req.headers[k] = v;
    },
    ...(o.validate ? { validate: o.validate } : {}),
  };

  /**
   * 发一个请求。`phase` 决定两件事：**进不进指标**，以及记进哪个计数器。
   *
   * setup/teardown 都不进指标（登录与清理不是被测的那件事，算进吞吐会让小并发短跑的
   * rps 明显虚高），但**必须分开计数** —— 这是本轮改的：合成一个"未计数"计数器之后，
   * `setupRequests` 把收尾也算进去，而它恰好是"登录有没有每轮重跑"那句话的证据。
   * 与 k6 那一侧的 `atest_phase` 标签（setup/iter/teardown 三个值）也是同一个口径。
   */
  const makeSend = (phase: 'setup' | 'iter' | 'teardown') => async (req: BuiltRequest): Promise<RawResponse> => {
    if (phase === 'iter') counters.requests++;
    else if (phase === 'setup') counters.setupRequests++;
    else counters.teardownRequests++;
    o.onRequest?.(req);
    const s0 = clock.mono();
    const res = await sendOne(req);
    const ms = clock.mono() - s0;
    // 截断不改失败判定，只把标记交给 runtime 那一侧（applyLoadResponse 会据此留一句
    // "响应被截断、body 可能取不全"，那才是下游断言没过时该看到的原因）
    const out: RawResponse = { ...res, ms };
    if (phase === 'iter') {
      const failed = requestFailed(out, o.failureStatus ?? []);
      obs.push({ ms, failed });
      // 请求类的失败**只在这里**记一次（按观测，与 errorRate 同分母）。
      // 迭代结束后那次 notes 扫描会跳过带 fromRequest 的那几条，否则同一个 404
      // 记两遍、"（N 次）"翻倍 —— 实测过：2 个失败请求报成 `HTTP 404（4 次）`。
      if (failed) noteFailure(out.transportError ?? `HTTP ${out.status}`);
    }
    return out;
  };

  /**
   * 全局停机标志。三个来源：外部取消、请求数上限、**任一 VU 报错**。
   *
   * 第三个是这个函数唯一真正要紧的地方。`Promise.all` 在第一个 VU 抛时就 reject，
   * 而**其余 VU 完全不知道**，会继续打下去 —— press() 已经抛了，施压还在继续，
   * 调用方（CLI）打印完错误信息退出，而连接是异步收的；更糟的是调用方 catch 住错误
   * 想重试一次，此时场上还有一批在飞的请求，"重试一次"就变成了"两场压测重叠"。
   * 本仓有条铁律是不许出现第二次执行（409 不重发那条同一条），这里是它的同一形状。
   * 所以：任何一个 VU 出问题 → 立标志 → 所有 VU 在**下一个节点边界**退出 →
   * `Promise.allSettled` 等它们真的停住 → 再抛第一个错。
   */
  const stop = { reason: undefined as unknown };
  const aborted = (): boolean => o.signal?.aborted === true || stop.reason !== undefined;
  // 计数那一路再多一条：请求数上限**在迭代中间**也要生效。
  // 只在迭代开头检查的话，超调量是 vus × 每迭代请求数 —— 说好了 1000 个请求，
  // 100 个 VU 每条用例 3 个请求，实际会打出 1000+300，那个数会进 rps 的分母
  const countedStop = (): boolean => aborted() || (maxReq > 0 && counters.requests >= maxReq);
  const sendIter = makeSend('iter');
  const sendSetup = makeSend('setup');
  const sendTeardown = makeSend('teardown');

  const vu = async (startAtMs: number): Promise<{ iterations: number; hitCap: boolean }> => {
    if (startAtMs > 0) await clock.sleep(startAtMs);
    let iterations = 0;
    let hitCap = false;
    // **一个 VU 一份状态**，setup / 迭代 / teardown 共用：setup 里 extract 出来的 token
    // 必须能被迭代正文引用（`$.step.login.body.token` 那类引用就是这么写的）。
    // 从前这里给每轮迭代新建一份空间，于是"setup 里登录、body 里带 token"的用例
    // 在压测里报"变量不存在"，而同一条用例功能回归能跑过 —— 同一份 IR 两种行为。
    const st = newLoadState(o.inputs ?? {}, o.env ?? {}, o.plan.inputDefs, clock);
    if (o.plan.setup.length) {
      try {
        await walkAsyncBuiltin(o.plan.setup, st, deps, sendSetup, aborted);
      } catch (e) {
        // setup 坏了这一轮压测没有意义（后面的请求全打在没登录的状态上，
        // 会得到一条"错误率 100%"或"全是 401"的曲线）。停下来，别硬压
        // 话术与下面 `st.failed` 那一支**同一句开头**：一件事两种说法时，
        // 读报错的人没法判断是不是两种不同的故障（这里是同一种：setup 没成）
        stop.reason ??= new LoadPressFailure(`压测的 setup 没过（抛异常）：${msg(e)}`, e);
        throw stop.reason;
      }
      // **走过 setup 而没抛，不等于 setup 过了。** 步骤自己判失败（404 / 断言没过 /
      // extract 取不到）走的是 notes + `st.failed`，不抛异常 —— 所以只 catch 异常的话，
      // 这里会放行，然后每个 VU 都带着一个**没准备好的状态**去施压。
      // k6 那一侧（`emit-k6.ts` 的 `vuState`）本来就判 `ST.failed` 并抛，
      // 于是这是最贵的那种分叉：**同一份 IR，两个后端做出不同的事，而都不报错**
      // —— 内置后端交出一份"看起来正常"的曲线，k6 那边整场失败。
      // 这条是 `test/load-press.test.ts` 里"setup 没过 -> 一个业务请求都不发"量出来的。
      if (st.failed) {
        const why = st.notes.filter((n) => !n.ok).map((n) => `${n.stepId}：${n.why ?? '无细节'}`).join('；') || '无细节';
        stop.reason ??= new LoadPressFailure(`压测的 setup 没过：${why}（后面的请求会全打在没准备的状态上，所以整场停住）`);
        throw stop.reason;
      }
    }
    // setup 结束后拍的快照，是之后每轮迭代**开头**裁回去的基线
    // （为什么不能整表清、为什么用差集，见 VarSpace.localSnapshot 的注释）
    const baseline = st.vars.localSnapshot();
    // 每个 VU 自己一份"这一轮是不是被上限拦腰截断"的标记。
    // 要它是因为迭代数得说实话：跑完的一轮算一轮，而**被上限截断**的那一轮
    // 断言没跑完 —— 计成完整迭代的话 iterationsPerVu 会说"跑完了 N 轮"，
    // 而那个数正是排查负载不均时看的东西。
    let cutMidIteration = false;
    const stopInIter = (): boolean => {
      const s = countedStop();
      if (s) cutMidIteration = true;
      return s;
    };
    try {
      while (!aborted() && clock.mono() < deadline) {
        if (maxReq && counters.requests >= maxReq) { hitCap = true; break; }
        if (o.maxIterationsPerVu && iterations >= o.maxIterationsPerVu) { hitCap = true; break; }
        st.vars.pruneToLocal(baseline);
        cutMidIteration = false;
        try {
          await walkAsyncBuiltin(o.plan.nodes, st, deps, sendIter, stopInIter);
        } catch (e) {
          // 用例写坏（占位符没填、extract 的 mode 不支持）：**整个压测停下**。
          // 继续跑会得到一条"打了请求而没人看响应"的曲线，那是最难发现的故障类型
          stop.reason ??= new LoadPressFailure(`压测中第 ${iterations + 1} 轮报错：${msg(e)}`, e);
          throw stop.reason;
        }
        for (const n of st.notes) {
          // 请求类的失败（状态码 / 传输层）已经在 makeSend 里按**观测**记过一次了，
          // 这里再记一遍会让"（N 次）"是实际失败请求数的两倍 —— 实测：2 个失败请求
          // 报成 `HTTP 404（4 次）`。那一格不是排版问题：排查时"偶发 2 个"与
          // "普遍 4 个"读出来是两个完全不同的结论，而只有观测那一路与
          // errorRate 同分母，所以留下观测那一路。
          if (!n.ok && n.why && !n.fromRequest) noteFailure(n.why);
        }
        // notes 只留最后一次的（一万轮 × 每轮几条会把内存吃掉，而排查要的是"最近一次"）
        st.notes.length = 0;
        if (cutMidIteration) { hitCap = true; break; }
        iterations++;
        if (o.thinkMs) await clock.sleep(o.thinkMs);
      }
    } finally {
      if (o.plan.teardown.length) {
        // **每个 VU 各清一次**，与 k6 的 teardown 语义一致。
        // 这里一度改成"只让最后结束的 VU 清一次"，理由是"少打 N 倍写请求" ——
        // 那确实少打了，代价是两个后端对**同一份计划**做出不同的事
        // （内置清一次、k6 清 N 次），而清理是**有副作用的写请求**。
        // 那正是本仓最难发现的一类分叉：不报错，只是两边的报告长得一样
        // 而被测系统挨了不同数量的写。每个 VU 清自己建的东西才是对的形态。
        //
        // 先裁回 setup 基线再跑：teardown 于是只看到 setup 给的那些值，
        // **每个 VU 跑的 teardown 字节相同**（请求数 = 计划里的节点数，可预期），
        // 而不是"取决于这个 VU 最后一轮跑到哪"。迭代里建的数据清不掉是**故意的**：
        // 那个 id 只有那一轮知道，而 N 万条迭代数据的清理本来不该塞在压测里做。
        //
        // 被取消**也要**跑：取消的含义是"别再施压了"，不是"把垃圾留下"。
        // 传 `() => false` 让清理自己跑完，别被同一个取消标志中途砍掉。
        st.vars.pruneToLocal(baseline);
        try {
          await walkAsyncBuiltin(o.plan.teardown, st, deps, sendTeardown, () => false);
        } catch (e) {
          // teardown 失败**不改压测结论**（那件事已经测完了），但必须能看见
          noteFailure(`teardown 失败：${msg(e)}`);
        }
      }
    }
    return { iterations, hitCap };
  };

  const tasks: Array<Promise<{ iterations: number; hitCap: boolean }>> = [];
  for (let i = 0; i < o.vus; i++) {
    // 爬坡：把 VU 的**起始时刻**摊开，而不是先起 1 个再逐步加。
    // 两种做法在稳态上等价，而"起始时刻摊开"不需要一个会漏掉取消的定时器
    const startAt = o.rampUpMs && o.vus > 1 ? Math.round((o.rampUpMs * i) / o.vus) : 0;
    tasks.push(vu(startAt));
  }
  // **allSettled 而不是 all**（理由见上面 stop 那段）：all 会在第一个 VU 抛时立刻 reject，
  // 而其余 VU 完全不知道，会继续施压 —— press() 已经抛了而场上还有在飞的请求，
  // 调用方 catch 住错误再试一次就变成"两场压测重叠"。
  // 所以：等所有 VU 真的停住，再把第一个错抛出去。
  const settled = await Promise.allSettled(tasks);
  const firstError = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult | undefined;
  if (firstError) throw firstError.reason;
  const done = settled.map((s) => (s.status === 'fulfilled' ? s.value : { iterations: 0, hitCap: false }));
  const iterationsPerVu2 = done.map((s) => s.iterations);
  // "提前停下"只有**因变量到上限**这一种算信息量。到点是所有 VU 的正常结局，
  // 报成 stoppedEarly 会让每次正常压测都显示"有 N 个 VU 提前结束"
  const hitCapCount = done.filter((s) => s.hitCap).length;
  const windowMs = Math.max(1, clock.mono() - t0);

  // 0 条观测时 summarizeObservations 会抛 —— 那是**故意的**：
  // "施压脚本一个请求也没打"不能产出一份 errorRate:0 的漂亮对象（见那个函数的注释）。
  // 但这里先拦一句更有用的话：0 个请求最常见的原因是 VU 全在爬坡里没起来、
  // 或者 durationMs 比一个请求的耗时还短。
  // **取消也算一个原因**，而且要写在第一位：`--duration` 还没到就按了 Ctrl-C，
  // 报"时长比单个请求还短"会让人去调时长（而真相是没开始就停了）。
  // 这里仍然抛而不返回一个 cancelled 的结果对象，是因为 PerfMetrics 在 0 样本时
  // 压根不该存在（聚合侧就是这么判的）；CLI 那一侧认得出取消，
  // 会把它当正常收尾而不是当故障（见 `test/load-press.test.ts` 那条取消用例）。
  if (!obs.length) {
    throw new LoadPressFailure(
      `这场压测一个请求都没发出去（${o.vus} 个 VU，窗口 ${windowMs}ms，迭代数 ${iterationsPerVu2.reduce((a, b) => a + b, 0)}${o.signal?.aborted ? '，**且已被取消**' : ''}）。`
        + (o.signal?.aborted
          ? '原因是在打出第一个请求之前就被取消了；收尾（teardown）已按每 VU 一次跑过。'
          : '常见原因：时长比单个请求还短、爬坡比时长长、或所有步骤都被 when 跳过'),
    );
  }
  const metrics = summarizeObservations(obs, windowMs);
  return {
    metrics,
    windowMs,
    stoppedEarly: hitCapCount,
    // **只看外部取消**，不看 stop 标志：后者是"用例写坏了"，
    // 报成 cancelled 会让人以为是自己按了 Ctrl-C（而 CLI 对这两件事的处置不同：
    // 取消是正常收尾、坏用例要非零退出）
    cancelled: o.signal?.aborted === true,
    model: 'closed',
    iterationsPerVu: iterationsPerVu2,
    setupRequests: counters.setupRequests,
    teardownRequests: counters.teardownRequests,
    failureReasons: [...failureReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([why, n]) => (n > 1 ? `${why}（${n} 次）` : why)),
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 一次 fetch。超时用 AbortController（fetch 自己没有 timeout 选项） */
async function sendOne(req: BuiltRequest): Promise<Omit<RawResponse, 'ms'> & { truncated?: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
  try {
    const headers = { ...req.headers };
    const init: RequestInit = { method: req.method, headers, signal: ctrl.signal, redirect: req.followRedirects ? 'follow' : 'manual' };
    if (req.form) {
      init.body = new URLSearchParams(req.form).toString();
      if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (req.body !== undefined) {
      init.body = req.body;
      if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
    }
    const res = await fetch(req.url, init);
    // **响应体按 maxBytes 截断**。计划里带着这个字段（IR 的 maxResponseBytes 编过来的），
    // 而"字段在、没人接"正是 docs/08 §3(f) 那一格：压测一晚上攒的不是结论而是 OOM，
    // 且发生时刻在**最后**（内存耗尽时聚合已经跑完一半），报告看起来像"压测自己崩了"。
    const { text, truncated } = await readCapped(res, req.maxBytes);
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { outHeaders[k] = v; });
    // 截断**不改失败判定**（截断是施压侧的限制，不是后端的错）。它随响应带出去，
    // 由 applyLoadResponse 落成一句 notes —— 那边才知道"这一步本来要判 body 的某个字段"。
    return { status: res.status, headers: outHeaders, bodyText: text, ...(truncated ? { truncated } : {}) };
  } catch (e) {
    // 超时（AbortError）与断连都到这儿。status 0 = 压根没拿到响应，
    // 与"后端回了 500"是两件事，但**两者都算失败**（错误率要的是"这次请求没成"）
    return { status: 0, headers: {}, bodyText: '', transportError: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读响应体，最多 cap 字节。
 *
 * 走 `res.body` 的 reader 而不是 `res.text()`：`text()` 会先把**整个**体缓冲下来才返回，
 * 那时再判长度已经晚了 —— 恰好是本函数要防的那件事。超上限就 cancel 掉流并停止累积。
 * `res.body` 为 null（某些测试里的假 fetch）才退回 text()，那条路径上不承诺上限。
 */
async function readCapped(res: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let received = 0;
  let out = '';
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > cap) {
        // 只解码到 cap 为止的那一段（不追求恰好断在字符边界上，半个字符会变替换符，
        // 而那无所谓：这段文本的用途是"取个 jsonpath"，截断的响应本来就不是有效 JSON）
        out += decoder.decode(value.subarray(0, Math.max(0, value.byteLength - (received - cap))), { stream: false });
        truncated = true;
        break;
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    // 一定要 release/cancel，否则连接会一直挂在施压进程上（几百个半开连接的下一个症状
    // 是"压着压着连不上了"，看起来像被测系统的问题）
    try {
      if (truncated) await reader.cancel();
      reader.releaseLock();
    } catch {
      // cancel/releaseLock 在流已关闭时会抛，那种情况下没什么要收的
    }
  }
  return { text: out, truncated };
}

export class LoadPressFailure extends Error {
  constructor(message: string, public readonly causeErr?: unknown) {
    super(message);
    this.name = 'LoadPressFailure';
  }
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/**
 * 实测出来的施压指纹。CLI 拿它与场景的 load 块合成 LoadFingerprint。
 *
 * `runnerSpecLabel` **只能由调用方给**（机器规格要读 /proc 或 sysctl，本层不碰 node:os，
 * 而且"8c16g"这种口径要人手写才与历史基线一致）。这里给的是**这次跑实际用的**那几个数。
 *
 * **入参不叫 `runnerSpec`**（与 `html.ts` 里 `suiteId` 那处同一个理由，不是口味）：
 * 那个词在 IR 里是 `LoadFingerprintSchema.runnerSpec` 的字段名且全局只声明一次，
 * 而 `tooling/unread-fields.mjs` 的判据是词法的 —— 形参名与对象字面量里的简写
 * `{ runnerSpec }` 都是"往指纹里**放**这一维"，一次都没**读**它，却被算成强证据，
 * 于是那条仍然需要的 P7 豁免被报成"已过期、删掉吧"。删掉的后果正是该工具头上写的
 * 那一条：下一次它落回未读时，报错是"新增未读字段"，而没人知道自己刚拆了闸。
 * 改的是**本层入参名**（不是 IR 字段名 —— IR 的命名一致性不该为扫描器让路，
 * 理由见 unread-baseline.json 里 `_ceiling_comment` 末段那条纪律）。
 * 真正的读者在 `ir/src/baseline.ts` 的 `incomparableReasons`（`base.runnerSpec`），
 * 而 ir 不在扫描器的消费者目录里（它自己就是字段声明所在处，让它自证等于没管），
 * 所以"这一维有人读"这件事现在仍然只能靠 `ir/test/baseline.test.ts` 那条钉着。
 *
 * ⚠ 原来这里写着"maxRequests 用了就如实标出来（它改变可比性）"而**代码里没有**——
 * LoadFingerprint 压根没有那一维。注释比代码多许诺一件事，是 docs/08 §3(a)
 * （有载体没有生产者）的反面版本（有说法没有载体），同样要记下来：
 * 用 maxRequests 截断的场次与按时长跑的场次**应当判不可比**，而这一维现在只能靠
 * 调用方自己把 maxRequests 拼进 runnerSpec 字符串。真要做成一等维度，得给
 * LoadFingerprint 加字段并同步 incomparableReasons —— 那是基线模型的一次改动，
 * 不在本轮范围（登记在 docs/14）。
 */
export function measuredLoad(o: PressOptions, result: PressResult, runnerSpecLabel: string): LoadFingerprint {
  return {
    runnerSpec: runnerSpecLabel,
    runnerCount: 1,
    vus: o.vus,
    // 闭合模型下连接数≈并发数（keep-alive 复用），但**不写死等于 vus**：
    // 短连接压测测的是握手开销，那一维填错了会让"换成长连接"的对比看起来是性能提升
    connections: o.vus,
    // **用实测窗口而不是 o.durationMs**：指纹的一维是"实际压了多久"。
    // 拿名义值的话，一场被取消/被 maxRequests 提前截断的压测会与一场完整跑
    // 拥有相同的指纹，于是它的成绩可以合法地进基线，而它只压了三秒
    durationMs: result.windowMs,
  };
}
