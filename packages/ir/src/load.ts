/**
 * `load` 块（docs/09 §4.2/§4.3、docs/08 C3）—— 场景**自己**声明它被压时的形状。
 *
 * ## 为什么这一段在 IR 里，而不是只在 `atest load --vus 100` 的命令行上
 *
 * 命令行传参也能跑，但它撑不起门禁：**基线要能回答"这次和上次是同一个压法吗"**。
 * 那个答案就是 LoadFingerprint 里的 vus/durationMs 几维，而指纹必须有个**权威出处**。
 * 出处是命令行参数的话，任何一次手滑改参数都会悄悄换掉压法，
 * 于是"每次发布都报退化 40%"——docs/09 §4.3 点名这正是性能门禁最常见的死法，
 * 结局是"三周后有人把门禁关了"。摆在 IR 里之后，改压法是一次**改了用例**的变更：
 * 有版本、有 diff、有评审。命令行只作**临时覆盖**，覆盖值照样如实进指纹。
 *
 * ## 为什么不复用 LoadFingerprint
 *
 * 那个是**一次运行的观测**（还包含只有跑了才知道的 runnerSpec/runnerCount），
 * 这个是**作者意图**（"我想用 100 VU 压 60 秒"）。合成一个之后，
 * 每次跑之前都得先伪造出 runnerSpec 才能构造对象 —— 伪造出来的指纹就不是指纹了。
 * 两者的交集由 `packages/cli` 在开跑那一刻填（见 `adapter-load` 的 `fingerprintOf`）。
 */
import { z } from 'zod';
import type { Step } from './steps.js';
// **运行时** import：本文件的判据要知道"复合谓词有哪三种键"。
// 方向是 load -> waits，而 waits 只依赖 values/locator，所以没有环。
// （早先这里写着"本文件不引入运行时依赖"，那时复合键是就地手抄的三个字面量 ——
// 手抄成了 `not`，见 LOAD_WAIT_SUPPORT 那段。改成从 waits.ts 读之后，
// 那句"不引入运行时依赖"就不再成立，也不该成立。）
import { WAIT_COMBINATORS } from './waits.js';

export const LoadProfileSchema = z
  .object({
    /** 并发虚拟用户数。进 LoadFingerprint.vus；改它 = 换压法 = 基线不可比 */
    vus: z.int().min(1).max(10_000),
    /**
     * 施压时长。低于 `MIN_SAMPLES_MS` 的运行不参与判退化（那是**统计**下限，
     * 不是这里的上限）：短跑的 p95 由个位数样本决定，抖动就能"退化 30%"。
     * 这里**不设下限**而是让门禁去判 —— 开发时想拿 5 秒跑一把看曲线是正当需求，
     * 平台不该拦，拦的姿态是让门禁说"这次不算"。
     */
    durationMs: z.int().min(1),
    /** 爬坡时长。0 = 一上来就满并发（打的是"冷启动瞬时冲击"，不是稳态） */
    rampUpMs: z.int().min(0).default(0),
    /**
     * 每个虚拟用户每次迭代后的思考时间。
     *
     * ⚠ **0 测的是"零间隔 hammer"**，那是最不像真实流量的负载：
     * 没有思考时间时连接永远繁忙，连接池耗尽这一类问题会被**过度**暴露，
     * 而"1000 个用户里同一秒只有 5% 在点"这种真实形态会被**漏掉**。
     * 所以它不是调优旋钮，是**压测对象的假设**，改它同样让基线不可比。
     */
    thinkMs: z.int().min(0).default(0),
    /**
     * 请求总数上限，0 = 不限（只按时长跑）。
     * 存在的理由是 CI：门禁那一侧要一个**确定量**（同样 30 秒，快机器能打 3 倍请求，
     * 于是 rps 与样本量随施压机浮动，见 incomparableReasons），
     * 而"固定请求数"是唯一不依赖机器速度的口径。
     */
    maxRequests: z.int().min(0).default(0),
    /**
     * 在默认判据**之外**还算作失败的状态码。
     *
     * ## 默认判据先说清楚（这一段之前写反过，所以整段重写）
     * 实现里唯一的判据在 `adapter-http/src/load/press.ts` 的 `requestFailed`：
     * 传输层失败、以及**状态码 <200 或 ≥400**，都算失败。也就是
     * **4xx 与 5xx 默认就算失败**，不需要在这里声明。
     * ⚠ 这一栏原本写的是"压测的错误率判据默认把 4xx 算成功（后端正常应答了），
     * 而 429 与 401 恰恰是最想抓的两类" —— 那句**与实现相反**（实测：默认口径下
     * 一条 404 的 errorRate 就是 1）。它危险的地方不是措辞，是**推论**：
     * 照着它写用例的人会以为"不声明 failureStatus 就抓不到 429"，于是给每条场景
     * 都加一栏，或者更坏 —— 以为默认口径漏了什么而去调默认值。
     * 判据只有一处，注释必须以它为准，而不是以"这类问题值得抓"为准。
     *
     * ## 那这一栏还剩什么用
     * 加**默认落在成功区间**的那些码，即 2xx/3xx。最常见也最值钱的一条是
     * `302`：过载时鉴权失效会把请求重定向到登录页，而 3xx 在默认口径里是
     * "后端正常应答了" —— docs/05 §4 点名的"302 到登录页被误判成功"那类假绿，
     * 在压测形态里就藏在这条缝上。1xx 进不来（min 100 而它们不是最终响应）。
     * 默认空数组（不猜），要抓哪个码由作者显式声明。
     */
    failureStatus: z.array(z.int().min(100).max(599)).default([]),
    /**
     * 每个虚拟用户的迭代数上限，0 = 不限。**这是资源保护，不是压测参数**：
     * 一条用了 `forEach` 展开上千条数据的场景，在 100 VU 下每个 VU 都会完整跑一遍，
     * 总请求量 = vus × 迭代数，很容易在 60 秒里打爆被测环境。
     */
    maxIterationsPerVu: z.int().min(0).default(0),
  })
  .strict();
export type LoadProfile = z.infer<typeof LoadProfileSchema>;

/**
 * 意图 -> 指纹里**作者已经定了**的那几维。
 *
 * 返回的是 Partial：runnerSpec/runnerCount/sutInstances 这些只有**跑起来**才知道，
 * 由 CLI 现场采集。刻意不在这函数里伪造它们（伪造的指纹就不是指纹），
 * 补全与校验由 `assertLoadFingerprint`（`adapter-load`）负责。
 */
export function loadFingerprintIntent(p: LoadProfile): { vus: number; durationMs: number } {
  return { vus: p.vus, durationMs: p.durationMs };
}

/**
 * `wait` 的**谓词**级判据 —— kind 表说 wait 可以降级演化，但那只是说"不轮询"，
 * 而真正决定"能不能演化"的是这一格里的条件**要不要问外部系统**。
 *
 * ## 为什么 kind 一张表不够
 *
 * `wait{expr}` 判一次就是本地求值，压测里完全成立；
 * `wait{dbRow}` 要连数据库、`wait{uiPredicate}` 要开浏览器 —— 那两个能力
 * 在压测那条路上**压根不存在**（k6 里没有 DB 连接、也没有 Playwright）。
 * 只按 kind 分档会得到"静态闸放行、编译器只能演化成'条件恒假'"，
 * 而那正是这一族最贵的形状：wait 恒假 ⇒ 要么整场失败（还能发现），
 * 要么 `onTimeout:'continue'` 下**静默当成没等**，压测照跑照出曲线。
 *
 * 名单从 `waits.ts` 的谓词判别键取，判据与 `LOAD_STEP_SUPPORT` 同处一地、
 * 同一条理由：**静态闸与编译器问同一张表**，两处各写一份就会漂移。
 */
export const LOAD_WAIT_SUPPORT: Readonly<Record<string, { support: 'once' } | { support: 'refuse'; why: string }>> = {
  expr: { support: 'once' },
  httpStatus: { support: 'once' },
  dbRow: {
    support: 'refuse',
    why: '这条等待要连数据库，而压测那条路上没有数据库连接（每 VU 一条连接打的是数据库的连接数，不是被测接口）',
  },
  uiPredicate: { support: 'refuse', why: '这条等待要开浏览器，浏览器不在 API 压测路径上' },
  uiIdle: { support: 'refuse', why: '同上' },
  template: { support: 'refuse', why: '模板匹配要图像能力，压测形态没有' },
  response: {
    support: 'refuse',
    why: '这条等的是"上一个请求的响应"，而压测里请求是并发交错的 —— '
      + '"哪一个响应算上一个"没有确定答案，于是这条等待判的是竞态而不是被测系统',
  },
  newPage: { support: 'refuse', why: '没有浏览器' },
  // 三种复合键。名字**必须与 waits.ts 的 WaitPredicateSchema 逐字一致** ——
  // 本表最早写的是 allOf/anyOf/**not**，而 schema 里根本没有 `not` 这一支
  // （第三种是 `noneOf`，实测 `WaitPredicateSchema.safeParse({not:…})` 直接被拒）。
  // 后果有两层，都在"复合键"这一层而不是某个谓词：
  //  1. `noneOf:[{type:'dbRow'}]` 走过一遍遍历后**没人看见**那个 dbRow
  //     （探针量出来 `waitNeedsExternalAdapter` 返回 undefined），于是静态闸放行；
  //  2. 运行时对整棵 noneOf 树落到"判不了 -> 当假"那句兜底，
  //     `onTimeout:'continue'` 下就是**静默当成没等**，压测照跑照出曲线。
  // 守住这一格的是 `ir/test/load-wait-keys.test.ts`：本表的键集与 schema 现取的
  // 类型清单对撞，多一个少一个都红（同 `wait-worlds.test.ts` 那条的做法）。
  allOf: { support: 'once' },
  anyOf: { support: 'once' },
  noneOf: { support: 'once' },
};

/**
 * 一棵条件树里**有没有**压测形态判不了的节点（要外部能力的谓词，或不支持的复合键）。
 * 返回第一个那样的类型/键名（没有则 undefined）。
 *
 * ## 为什么要走整棵树而不是只看顶层
 * `{allOf:[{type:'expr'…},{type:'dbRow'…}]}` 是最常见的写法，只看顶层会得到
 * "这条件本地可判"。
 *
 * ## 这份遍历为什么这次可以自己写（而从前那份是缺陷）
 * 前版本函数自己走树，把复合键抄成了 `['allOf','anyOf','not']`：`not` 在 schema 里
 * 不存在，真实存在的 `noneOf` 没人走 —— `{noneOf:[{type:'dbRow'}]}` 一路静默通过
 * 静态闸（探针量出来的）。**成因是那份键名单是手抄的第二份。**
 * 现在键名单只有一个出处（`waits.ts` 的 `WAIT_COMBINATORS`，本文件从它读），
 * 所以这里的递归不再抄第三个名字表：加第四种复合键只需要动 waits.ts，
 * 而那一加会让 `ir/test/load-wait-keys.test.ts` 因为本表少一行而红。
 *
 * 没有直接复用 `waits.ts` 的 `iterConditions` 是因为它把复合节点**摊平掉**了 ——
 * 那种形态答得出"叶子里有没有 dbRow"，答不出"这棵树用的复合键我们支不支持"。
 * 而复合键这一格恰恰是本次踩的坑，必须让它有一个真的消费者
 * （否则 LOAD_WAIT_SUPPORT 里那三行就是**有载体没有生产者**，docs/08 §3(f) 那一格）。
 */
export function waitNeedsExternalAdapter(cond: unknown): string | undefined {
  if (!cond || typeof cond !== 'object') return undefined;
  const o = cond as Record<string, unknown>;
  for (const k of WAIT_COMBINATORS) {
    if (!Array.isArray(o[k])) continue;
    // 复合键自己也要过表（这三行因此真的有人读）
    if (LOAD_WAIT_SUPPORT[k]?.support !== 'once') return k;
    for (const kid of o[k] as unknown[]) {
      const hit = waitNeedsExternalAdapter(kid);
      if (hit) return hit;
    }
    // 三种复合键互斥（WaitPredicateSchema 是三选一），命中一个就不必看别的键
    return undefined;
  }
  const t = typeof o.type === 'string' ? o.type : undefined;
  if (!t) return undefined;
  // 表里明说 refuse 的，以及**表里压根没有的**，都算"判不了"。
  // 后者是有意的：判不准时宁可少报支持，也不要把一条"其实判不了"的等待
  // 演化成恒假（那种演化的两种下场都坏：'fail' 整场失败还能发现，
  // 'continue' 则静默当成没等）
  return LOAD_WAIT_SUPPORT[t]?.support === 'once' ? undefined : t;
}

/**
 * 每个步骤 kind 在压测那条路上**能演化成什么**。
 *
 * ## 为什么这是一张表而不是编译器里的一串 if
 *
 * 判据有两个读者：跑之前的静态闸（`engine/src/lint.ts` 的 LOAD_* 那一组）与
 * 跑之前的编译器（`adapter-http/src/load/plan.ts`）。两处各写一遍"哪些 kind 能压"，
 * 坏法不是编译不过，是**静态闸放行、编译器当场拒绝**（用户被一句"这一步不支持"
 * 挡在跑之后），或者更坏的反方向：**编译器演化了、静态闸不知道，于是压测跑的
 * 其实是另一条用例**。后者正是 docs/08 §3(e) 那一族。
 *
 * 用 `Record<Step['kind'], …>` 而不是 `Partial<Record<…>>`：
 * **新增一个 kind 会让本表编译不过**。这一条是这张表存在的主要理由 ——
 * 默认值（"没列到的 kind 按不支持处理"）看着安全，实际是把"新 kind 能不能压"
 * 这个语义决定推给了编译器的 default 分支，而那是一个不会有人评审的位置。
 *
 * ## 四档的判据
 *
 *  - `press` —— 真的往被测系统打请求，**进吞吐与分位数**。只有这两个 kind。
 *  - `flow` —— 本地控制流/求值，不产生负载。可以照原样演化（语义与功能形态相同）。
 *  - `once` —— **语义降级**：能演演化但做的事和功能形态不一样。这一档必须单独有，
 *    因为它对应的坏法是"两种形态测的不是同一件事而报告长得一样"。
 *    `wait` 是唯一的住户，理由见 docs/04 那两条"刻意的不一致"表。
 *  - `refuse` —— 不演演化。`why` 要说清**为什么不能**，因为它会直接出现在
 *    用户的第一句报错里（"这一步压根不支持，请删掉"与"这一步有副作用所以不能压"
 *    是完全不同的两种修法）。
 */
export type LoadStepSupport =
  | { readonly support: 'press' }
  | { readonly support: 'flow' }
  | { readonly support: 'once'; readonly why: string }
  | { readonly support: 'refuse'; readonly why: string };

export const LOAD_STEP_SUPPORT: Readonly<Record<Step['kind'], LoadStepSupport>> = {
  // ── press：负载就是它俩 ─────────────────────────────────────────
  http: { support: 'press' },
  openapiCall: { support: 'press' },

  // ── flow：与功能形态同语义 ─────────────────────────────────────
  sequence: { support: 'flow' },
  if: { support: 'flow' },
  switch: { support: 'flow' },
  forEach: { support: 'flow' },
  repeat: { support: 'flow' },
  set: { support: 'flow' },
  extract: { support: 'flow' },
  log: { support: 'flow' },
  fail: { support: 'flow' },
  noop: { support: 'flow' },
  /**
   * 结构化断言（status / jsonPath / expr / durationMs）在压测里不但可以演，
   * 而且**必须**演：不演就是"打了一堆请求而没人看响应"，那种曲线谁都能画。
   * 断言不成立计入错误率（判据在 `adapter-load` 的 `observationOf`）。
   *
   * ⚠ 只有 `assert` 这一档。**另外四种断言在上面是 refuse**，
   * 这个区分不是随手分的：`assertLlm` 测的是模型延时、`assertPerf` 读的数还不存在、
   * `assertPage`/`assertUi` 压根不在 API 路径上。
   */
  assert: { support: 'flow' },
  /** 固定的思考时间。功能形态里它是 flake 源，压测形态里它**就是那个参数本身**
   *  （load.thinkMs 的同类），所以这里不套用 SLEEP_USED 的那句劝阻。 */
  sleep: { support: 'flow' },

  // ── once：能演化，但测的件事不一样，必须说出来 ───────────────────
  wait: {
    support: 'once',
    why: '压测形态里 wait 只判一次、不轮询（热路径不许 await，且"等外部条件"测的是我们自己的调度）。'
      + '用之前先确保数据已预置、谓词在负载下结果稳定；不满足就别用 wait',
  },

  // ── refuse ────────────────────────────────────────────────────
  while: {
    support: 'refuse',
    why: 'while 的次数由响应内容决定，而压测下响应内容会变（超时、限流、缓存命中）。'
      + '同一个 VU 在不同时刻跑不同步数，分位数就不再是"这条用例的耗时"。改用 repeat',
  },
  parallel: {
    support: 'refuse',
    why: 'VU 之间已经是并发的，VU 内部再开一层并发会把总并发变成 vus × maxConcurrency，'
      + '而这个数既不在 load.vus 里也不进指纹 —— 于是"用的哪种压法"这件事没人知道',
  },
  call: {
    support: 'refuse',
    why: '子场景要先把调用图展开才能编译，而"图没看全"在压测里表现为'
      + '压了一条比 IR 短的用例（还是绿的）。把子场景的步骤抄进来，或者等调用图展开接好',
  },
  table: {
    support: 'refuse',
    why: 'table 要读数据集文件，而 k6 侧只有 SharedArray、内置侧要选行不重复。'
      + '两边的"第几行"语义不同（功能形态按迭代序，压测按 VU×迭代）。数据预置好再压',
  },
  dataSource: {
    support: 'refuse',
    why: '数据库连接不能在 VU 之间共享，而每 VU 一条连接打的是**数据库的连接数**而不是被测接口。'
      + '要压数据访问路径请单独给它做一次数据库压测',
  },
  db: {
    support: 'refuse',
    why: '同 dataSource：一条 SQL 的耗时与接口的耗时不是同一个分位数，'
      + '混在一份指标里会得出一个谁也解释不了的 p95',
  },
  script: {
    support: 'refuse',
    why: 'script 是不透明块：静态闸看不见里面做了什么，压测报告也就说不出"这 100 rps 在打什么"。'
      + '（它在功能形态也是 P0 禁用的逃生舱口）',
  },
  useIdentity: {
    support: 'refuse',
    why: '切身份要重新取 token，而取 token 本身要打请求 —— 计入吞吐就是虚高，'
      + '不计入就是漏计。多身份的压法请拆成几条各带一个 identity 的场景',
  },
  manualHandoff: { support: 'refuse', why: '压测里没有人。这条出现在 load 场景里一定是写错了' },
  navigate: { support: 'refuse', why: '浏览器不在压测路径上（一个 Chromium 占一整个核，测的是渲染不是服务端）' },
  act: { support: 'refuse', why: '同上：Web 交互不进 API 压测的指标' },
  capture: { support: 'refuse', why: '同上' },
  assertPage: { support: 'refuse', why: '同上' },
  device: { support: 'refuse', why: '真机/模拟器不在压测路径上（一台一次只能跑一个 VU）' },
  app: { support: 'refuse', why: '同上' },
  tap: { support: 'refuse', why: '同上' },
  input: { support: 'refuse', why: '同上' },
  swipe: { support: 'refuse', why: '同上' },
  key: { support: 'refuse', why: '同上' },
  watcher: { support: 'refuse', why: '同上' },
  logcat: { support: 'refuse', why: '同上' },
  assertUi: { support: 'refuse', why: '同上' },
  assertLlm: {
    support: 'refuse',
    why: '语义断言要调模型：秒级延时会把分位数测成"模型的延时"，而它每次跑的结论还可能不同。'
      + '压测场景里只留结构化断言',
  },
  assertPerf: {
    support: 'refuse',
    why: 'assertPerf 读的是**一次压测跑完之后**的分位数，而它自己在被压的那段里 —— '
      + '每次迭代去判一次"整场压测的 p95"，那个数还不存在。把 assertPerf 放在压测之后的门禁场景里',
  },
};

