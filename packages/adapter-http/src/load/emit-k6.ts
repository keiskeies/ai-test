/**
 * 压测计划 -> k6 脚本（docs/09 §4.2 里那个 `IR (子集) ──▶ 编译器 ──▶ k6 JS 脚本`）。
 *
 * ## 生成的文件里**几乎没有逻辑**
 * 生成的文本只有：常量、一份计划数据、一个把 k6 的 `http.request` 包成 `RawResponse` 的小适配器、
 * 一个"每个 VU 第一次进迭代时把 setup 跑一遍"的懒门闩，以及 `walkSyncK6(plan.nodes, …)` 一句调用。
 * 所有语义（求值、拼 URL、鉴权、断言、控制流）都在 `runtime.ts` 里，由预lude 带进来 ——
 * 与内置后端调的是**同一批函数**。
 *
 * 这不是"少写点生成器代码"的口味问题：**每多生成一行逻辑，就多一行不会被类型检查、
 * 不会被 lint、也不被本仓任何测试跑过的代码**。第一版我让生成器直接展开 if/forEach/assert
 * 的语句，当场就写出了三个不存在的符号（`vars.skipStep`、`k6Clock`、`evalWaitOnce`）——
 * tsc 全过，因为它们只是字符串里的字。把生成面缩到"数据 + 一个适配器"之后，
 * 那三个洞的形状本身就不存在了。
 *
 * ## 这段文本的**唯一用途**是给 k6 跑
 * 本机装不上 k6（`github.com` 超时，实测），但"装不上 k6"**不等于**"这段文本什么都验不了"。
 * 现在 `test/load-k6.test.ts` 做的事：在临时目录里摆一个 `k6` / `k6/http` / `k6/execution`
 * 的 node 垫片，把**现打的预lude** 与生成的字节放在一起，**真的 import 并调用默认导出与
 * teardown**，把发出去的请求与内置后端逐个比。所以"这段 k6 文本对不对"里除了下面那三样，
 * 现在多了一样：**这段文本自己那几段代码（sendFor / vuState / oneIteration / toRaw /
 * encodeForm）跑起来是对的** —— 那几段之前一次都没被执行过。
 *  仍然**验不到**的（垫片不是 k6）：
 *   - k6 自己的分位数聚合与 `stages` 爬坡、VU 调度；
 *   - `params.tags` 的**阈值子集语法**（上面 `sendFor` 那条 ⚠ 说的就是这一格）；
 *   - `__ENV` 的真实注入时机（垫片里由测试直接给）。
 *  这三样登记在 docs/14，不写成"已验证"。真要严谨只能等一台有 k6 的机器跑一次 ——
 *  那正是内置后端存在的理由：同一份计划在**这里**能真跑出分位数与门禁结论。
 *
 * ## 与内置后端**已知的两处不同**，以及它们为什么不许悄悄发生
 *  1. **teardown**：内置后端每个 VU 各跑一次（`press.ts` 里能测），**这里跑一次**。
 *     不是偷懒 —— k6 没有"每 VU 收尾"这个钩子，只有整个压测一次的 `teardown()`。
 *     差别落在**真实写请求的数量**上（N 次 vs 1 次），而 teardown 恰恰是有副作用的那一段。
 *     所以 `plan.teardown.length` 时脚本头部就写死这句话，CLI 在 `--emit k6` 的输出里
 *     也复述一遍。`load-parity.test.ts` 只比**迭代正文**发出的请求，
 *     这个范围是刻意的，写在它的名字里而不是藏在实现里。
 *  2. **maxResponseBytes**：内置后端按它截断响应体（`press.ts` 的 readCapped）。
 *     这里**没有截断**：k6 自己管响应缓冲的上限，而那条上限的参数名/默认值本机没法验
 *     （装不上 k6），于是我不写一个猜的参数名去"看起来支持了" —— 那种写法坏了以后
 *     表现为"上限没生效而没有任何地方说它没生效"。要在超大响应上控内存，用内置后端。
 *
 * ## 密钥
 * 脚本里只出现 `secret:<ref>` 的**引用名**，真值由 k6 侧从 `__ENV.ATEST_SECRET_*` 读，
 * 读的时机是发请求那一刻（与功能形态同一条边界：Agent 上下文与生成出来的文件都看不到真值）。
 * `load-k6.test.ts` 里那条"把真密钥喂进去再在生成的字节里搜它"负责逼这一条。
 */
import { PRELUDE_FILE } from './prelude.js';
import type { LoadPlan } from './plan.js';

export interface EmitOptions {
  /** 环境的 baseUrl（不是密钥，明文进文件）。脚本里所有相对地址以它为前缀 */
  baseUrl: string;
  /** 场景 inputs 的名字 -> 值。**只放能进文件的**（密钥不该是 input，见 docs/02 §5） */
  inputs?: Record<string, unknown>;
  /** 思考时间（毫秒），来自 load.thinkMs */
  thinkMs?: number;
  /** 施压时长/并发。k6 命令行也能给，写进文件是为了"压法跟着用例走"（见 LoadProfile） */
  vus?: number;
  durationMs?: number;
  rampUpMs?: number;
  /**
   * k6 的 thresholds。**只在给了基线/门禁阈值时才写**：
   * 没基线时写一个阈值等于凭空造一条没人批准的判据；不写则 k6 只出数不判，
   * 判定回到 `evaluatePerfGate`（那里才有"没基线 -> unknown"的语义）。
   *
   * **不叫 `maxErrorRate`**（与 `html.ts` 的 `suiteId`、`press.ts` 的
   * `runnerSpecLabel` 同一个理由）：那个词是 `PerfGateThresholdsSchema.maxErrorRate`
   * 的字段名且全局只声明一次，`opts.thresholds?.maxErrorRate` 是一处**成员访问**
   * 强证据，于是扫描器判"门禁阈值那个字段有人读了"、把仍然需要的 P7 豁免报成"已过期"。
   * 叫 `maxFailRate` 还更贴本层的事实：它打在 k6 的 `http_req_failed` 上，
   * 数的是"这一轮请求失败率"，而 IR 那一维数的是压测观测里的错误率 —— 两个口径
   * 相近而**不同**（k6 那一子集只含打了 iter 标签的请求），本来就不该同名。
   */
  thresholds?: { maxP95Ms?: number; maxFailRate?: number };
}

/**
 * 生成脚本。**输出是确定性的**（同样的计划 + 同样的选项 -> 同样的字节），
 * 这样 `atest load --emit k6` 的产物能进 diff、能比对，而不会每次跑都产生一次改动。
 */
export function renderK6Script(plan: LoadPlan, opts: EmitOptions): string {
  const options: Record<string, unknown> = {
    // 重试必须为 0：压测里重试会把一次故障算成两次负载（docs/04 那张"刻意的不一致"表）
    summaries: true,
    noConnectionReuse: false,
    throw: false,
  };
  if (opts.vus !== undefined) options.vus = opts.vus;
  if (opts.durationMs !== undefined) options.duration = `${Math.max(1, Math.round(opts.durationMs / 1000))}s`;
  if (opts.rampUpMs) options.stages = [{ duration: `${Math.max(1, Math.round(opts.rampUpMs / 1000))}s`, target: opts.vus ?? 1 }];
  const thresholds: Record<string, string[]> = {};
  // 阈值写在**打过 atest_phase:iter 标记的那一子集**上。k6 会把每一次 http.request
  // 都自动计进 http_req_duration / http_req_failed，setup 里那次登录也在里面 ——
  // 不区分子集的话，"登录 900ms + 业务 30ms"的用例会有一个 p95 被登录决定的读数，
  // 而内置后端那边 setup 是明确不计入的（press.ts 的 makeSend(false)）。
  // 两边必须是同一个口径，否则换后端等于换判据。
  const scope = '{atest_phase:iter}';
  if (opts.thresholds?.maxFailRate !== undefined) thresholds[`http_req_failed${scope}`] = [`rate<${opts.thresholds.maxFailRate}`];
  if (opts.thresholds?.maxP95Ms !== undefined) thresholds[`http_req_duration${scope}`] = [`p(95)<${opts.thresholds.maxP95Ms}`];
  if (Object.keys(thresholds).length) options.thresholds = thresholds;

  // 计划进文件的方式：整份 JSON。脚本自己不认识 IR，只认这份计划数据 + 预lude 的函数。
  const planJson = JSON.stringify(
    { nodes: plan.nodes, setup: plan.setup, teardown: plan.teardown, inputDefs: plan.inputDefs },
    null, 2,
  );

  return `// 由 atest 从 IR 生成 —— **不要手改**（改 IR 再重新生成）。
// 场景 ${JSON.stringify(plan.scenarioId)}。施压模型 = **闭合模型**（每个 VU 跑完一轮再跑下一轮），
// 所以过载时 rps 会随系统变慢而下降；拿这个 rps 与开环工具（arrival-rate 那类）的读数对比会得出假结论。
${plan.teardown.length ? '// ⚠ 这条场景有 teardown：k6 侧整个压测只跑**一次**（没有每 VU 收尾这个钩子），\n//    而内置后端是每个 VU 一次。清理请求的数量因此不同 —— 换后端时这一项不可比。\n' : ''}//
// 这个文件里没有业务逻辑：它把计划交给 ${PRELUDE_FILE} 里的 walkSyncK6 跑，
// 那份运行时与本地回归、内置压测后端用的是同一批函数，所以这里测的是同一条用例。
import k6http from 'k6/http';
import { sleep } from 'k6';
import { __ENV } from 'k6/execution';
import { walkSyncK6, newLoadState, secretFromEnv } from './${PRELUDE_FILE}';

const PLAN = ${planJson};

const OPTS = ${JSON.stringify({ baseUrl: opts.baseUrl, inputs: opts.inputs ?? {}, thinkMs: opts.thinkMs ?? 0 }, null, 2)};

export const options = ${JSON.stringify(options, null, 2)};

/** k6 的 response -> 运行时认的 RawResponse。**只做形状适配，不做判断** */
function toRaw(res, ms) {
  const headers = {};
  for (const k of Object.keys(res.headers || {})) headers[k] = res.headers[k];
  return { status: res.status, headers, bodyText: typeof res.body === 'string' ? res.body : String(res.body ?? ''), ms };
}

// goja 里没有 performance.now，而 runtime 只要"一个单调不减的毫秒数"。
const CLOCK = {
  now: () => Date.now(),
  mono: () => Date.now(),
  // goja 里 sleep 就是同步阻塞，所以用例 body 中间的 sleep 步骤能忠实演化
  sleep: (ms) => { sleep(ms / 1000); },
  random: Math.random,
  mode: 'live',
};

function depsFor() {
  return {
    clock: CLOCK,
    baseUrl: OPTS.baseUrl,
    // k6 侧的鉴权**必须是同步的**（异步的在 goja 里永远不 resolve，runtime 会抛而不是发一个没鉴权的请求）
    auth: (req, node) => {
      const tok = secretFromEnv(node.auth && node.auth.ref, __ENV);
      if (tok) req.headers.authorization = 'Bearer ' + tok;
    },
  };
}

/**
 * 发一个请求。phase 是 k6 的**自定义标签**（params.tags），用来把 setup/teardown
 * 的请求从指标里分出去 —— k6 把每次 http.request 都自动计进
 * http_req_duration / http_req_failed，而上面 options.thresholds 只判
 * atest_phase:iter 那一子集。这样"setup 不计入指标"这件事在两个后端是同一个口径
 * （内置后端靠 makeSend(false) 不把它 push 进观测数组）。
 *
 * ⚠ **这条依赖 k6 的自定义标签与阈值子集语法，本机没有 k6 可验**（github.com 超时装不上，
 * 实测）。语法与语义按 k6 v0.44+ 的公开行为写；登记在 docs/14，不写成"已验证"。
 * 真要严谨只能等一台有 k6 的机器跑一次 —— 那正是内置后端存在的理由：
 * 同一份计划在**这里**能真跑出分位数与门禁结论。
 */
function sendFor(phase) {
  return (req) => {
    const params = {
      headers: req.headers, timeout: req.timeoutMs,
      redirects: req.followRedirects ? 10 : 0, retries: 0,
      tags: { atest_phase: phase, atest_step: req.stepId },
    };
    const payload = req.form ? encodeForm(req.form) : (req.body === undefined ? null : req.body);
    const t0 = Date.now();
    let res;
    try {
      res = k6http.request(req.method, req.url, payload, params);
    } catch (e) {
      // 传输层失败也要变成一条观测（status 0），否则错误率会**漏计**连不上与超时
      return { status: 0, headers: {}, bodyText: '', ms: Date.now() - t0, transportError: String((e && e.message) || e) };
    }
    return toRaw(res, Date.now() - t0);
  };
}

function encodeForm(form) {
  return Object.keys(form).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k])).join('&');
}

// 每个 VU 一份状态（k6 的模块状态是每 VU 一份）。setup 在这里是**懒**跑的而不是用 k6 的
// setup() 导出：懒跑让"这个 VU 跑过 setup 没有"这件事由本文件的门闩决定，
// 于是不依赖 k6 的 setup 生命周期与它的返回值通道 —— 那两条本机没法验（没有 k6），
// 而内置后端那边 setup 明确是每 VU 一次、且状态直接留在同一个对象里。
// 两边要对齐的是"每个 VU 带着 setup 的结果进迭代"这件事，不是"调了哪个钩子"。
let ST = null;
let BASE = null;

function vuState() {
  if (ST) return ST;
  ST = newLoadState(OPTS.inputs, { baseUrl: OPTS.baseUrl }, PLAN.inputDefs, CLOCK);
  if (PLAN.setup.length) {
    walkSyncK6(PLAN.setup, ST, depsFor(), sendFor('setup'));
    // setup 没过就**当场抛**，而不是留个标记每轮重放一次：
    // 后面的迭代全打在没登录的状态上，那条曲线是最难看的故障形状（错误率 100% 或全 401）。
    // 内置后端那边是同样的处置（press.ts 里 setup 失败直接抛 LoadPressFailure）。
    if (ST.failed) throw new Error('压测的 setup 没过（' + (ST.notes[ST.notes.length - 1]?.why ?? '无细节') + '）');
  }
  // setup 之后拍基线：每轮迭代**开头**裁回这里（上一轮的 $.step.* 与 set 出来的名字
  // 不该漏到下一轮 —— 真实用户每轮都是新会话）。差集而不是清表，见 VarSpace.localSnapshot
  BASE = ST.vars.localSnapshot();
  return ST;
}

function oneIteration() {
  const st = vuState();
  st.vars.pruneToLocal(BASE);
  // failed 每轮清一次：它是"这一轮没过"的标记，上一轮的失败不该让这一轮也抛
  st.failed = false;
  st.notes.length = 0;
  walkSyncK6(PLAN.nodes, st, depsFor(), sendFor('iter'));
  if (OPTS.thinkMs > 0) sleep(OPTS.thinkMs / 1000);
  // 本轮没过就抛：k6 靠这个把这次迭代记进 http_req_failed
  if (st.failed) throw new Error('本迭代有步骤没过（计入错误率）');
}

${plan.teardown.length ? `// 整个压测一次（k6 只有这一个收尾钩子；每 VU 一次的做法见文件头那条 ⚠）。
// 这里**重跑一遍 setup** 再跑 teardown：teardown 常常要引用 setup 给的值
// （"删掉刚才建的那条"），而全局 teardown 手上什么状态都没有。
// 于是它清的是"自己这一轮 setup 建的东西" —— 各 VU 在迭代里建的数据清不掉，
// 那是压测形态固有的（N 万个 id 只有各自的 VU 知道）。
// 需要清干净的场景请在压测**之后**用一个独立的清理场景做，别指望压测自己清。
export function teardown() {
  const st = newLoadState(OPTS.inputs, { baseUrl: OPTS.baseUrl }, PLAN.inputDefs, CLOCK);
  if (PLAN.setup.length) walkSyncK6(PLAN.setup, st, depsFor(), sendFor('setup'));
  walkSyncK6(PLAN.teardown, st, depsFor(), sendFor('teardown'));
}` : '// 这条场景没有 teardown'}

export default oneIteration;
`;
}
