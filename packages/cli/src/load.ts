/**
 * `atest load` 的判据部分：压测产物 -> 门禁结论 -> 基线样本（docs/09 §4.2/§4.3）。
 *
 * ## 为什么单独一个文件，而不是写在 `commands.ts` 里
 * `commands.ts` 已经一千多行，而这里这几条判据是**要被人逐条测**的东西：
 * 门禁为什么红、这次能不能当基线、两个后端的读数能不能放一起比 —— 都是纯函数能答的题，
 * 混在命令实现里就得每条测试起一次真进程、打一次真 mock 才问得出口。
 * 同一形状的先例是 `gate.ts`（run 的门禁）与 `coverage.ts`。
 *
 * ## 这一层唯一真正要紧的判断：**不可比要说不可比，不许硬算一个数**
 * docs/09 §4.3 点名性能门禁最常见的死法不是判错，而是"拿一次不可比的跑当基线"：
 * 换施压机、改并发、清了数据，于是每次发布都报退化 40%，三周后有人把门禁关了。
 * 所以判退化之前先过 `incomparableReasons`（判据本体在 `ir/src/baseline.ts`，这里不重述），
 * 而**换后端**这一维那张表里没有 —— 见 `BACKEND_INCOMPARABLE` 那条。
 */
import { cpus, totalmem } from 'node:os';
import {
  BaselineSampleSchema, evaluatePerfGate, loadFingerprintIntent, pickBaseline, promoteRefused,
  type BaselineSample, type EnvFingerprint, type LoadFingerprint, type LoadProfile, type PerfGateResult, type PerfMetrics, type StepStatus,
} from '@atest/ir';

/**
 * 压测产物。`press()` 的结果 + 这一次压测的身份，够门禁与基线用，不多带。
 *
 * **`runnerSpec` 只能由调用方给**（机器规格要读 `/proc` 或 `sysctl`，
 * 而 `"8c16g"` 这种口径要与历史基线手写一致）。CLI 那侧的开关是 `--runner-spec`，
 * 没给就写 `unknown`：宁可让所有历史基线都判"规格不同"，也不猜一个 ——
 * 猜错的规格会让两次不同的压测**看起来可比**，那正是上面那句"三周后有人关掉门禁"的起点。
 */
export interface LoadRunOutcome {
  scenarioId: string;
  runId: string;
  /** 施压后端。两个后端对同一份计划**故意**做得不完全相同，所以它进指纹、也进报告 */
  backend: 'builtin' | 'k6';
  metrics: PerfMetrics;
  load: LoadFingerprint;
  env: EnvFingerprint;
  /**
   * 功能侧结论。**类型取 IR 的 StepStatus 而不是自己列一个 `'pass' | 'fail' | 'error'`**：
   * 我第一版就是自己列的那三个，而它**漏了 `healed`** —— 那正是这条链上最不能漏的一格
   * （`promoteRefused` 拒绝 healed 当基线的整条理由：自愈意味着路径已经变了，
   * 拿它的耗时当基线等于把门禁悄悄下调）。漏了的话要么编译不过，要么被逼着
   * 把 healed 折成 pass/fail 其中之一 —— 前者是修一个不存在的问题，后者是伪造结论。
   * 引擎在 run 级只会给 pass/fail/error/healed（skipped/triaged 是步骤级的），
   * 但**那张名单是引擎的**，不在这里重述一遍（重述的份会跟着状态机漂移）。
   *
   * ⚠ **'aborted' 不在这里，它在下面那个独立字段**，理由全写在 `loadRunStatus` 的头上：
   * 把它并进这个联合类型，代价是 `manifest.status` 只能写一个前端徽章不认的词
   * （画成红色 error），而功能那条路上同一次取消写的是 `pass` + `已中断`。
   */
  runStatus: StepStatus;
  /**
   * 这一场**是不是被取消的**（= 不是一次完整施压）。与 `runStatus` 正交：
   * 一场取消了 30 秒的压测，那 30 秒里 8% 的请求 500 是真的产品结论（`fail`），
   * 同时"这半场不算一次完整压测"也是真的（`aborted`）。
   * 与 `RunReport.aborted` 是独立字段同一条理由。
   */
  aborted: boolean;
  takenAt: number;
  /** 闭合模型那句话。报告里必须出现，理由见 `PRESS_MODEL_NOTE` */
  modelNote: string;
  /** 每 VU 迭代数。负载不均时只有它看得出来（总数会被平均掉） */
  iterationsPerVu: number[];
  failureReasons: string[];
}

/**
 * 闭合模型的固定说明。
 *
 * 拿闭合模型（每个 VU 跑完一轮再跑下一轮）的 rps 去比开环工具
 * （k6 的 `constant-arrival-rate`、JMeter 的 Throughput Timer）的读数，
 * 会得到"我们的系统慢一半"的假结论，而两边都没错 —— 过载时闭合模型的 rps
 * 随系统变慢而**下降**，开环的不降。这句话不进报告的话，第一次跨工具对比就中一次。
 */
export const PRESS_MODEL_NOTE =
  '施压模型 = 闭合模型（closed loop）：过载时 rps 会随系统变慢而下降。'
  + '不要与开环工具（arrival-rate 那类）的读数直接对比，也不要在系统过载时把 rps 下降读成"负载减小了"。';

/**
 * **换后端 = 换压法**。`incomparableReasons` 那张表里没有"后端"这一维
 * （它比的是施压机/并发/连接数/时长/数据量），而两个后端有三处实测过的不同：
 *  1. **teardown 次数**：内置后端每 VU 一次，k6 整个压测一次（那边没有每 VU 收尾钩子）
 *     —— 被测系统挨的**写请求数量**不同，这直接改变被测状态；
 *  2. **maxResponseBytes**：内置后端按它截断，k6 侧压根没有出口（`emit-k6.ts` 文件头第 2 条）
 *     —— 超大响应时两边读到的 body 不同，于是断言过与不过也可能不同；
 *  3. **指标口径**：内置后端的 setup/teardown 不进观测数组，k6 靠 `atest_phase` 标签的
 *     阈值子集 —— 而那个子集语法本机没有 k6 可验（登记在 docs/14）。
 *
 * ## 这一维**怎么**变得可比（以及为什么这里不再写一个判据）
 * 做法是把后端名拼进 `LoadFingerprint.runnerSpec`（`local-1x (builtin)` 那种形态），
 * 于是 `incomparableReasons` 的第一维"施压机规格不同"当场就响 —— **复用那一处判据**。
 * 这一层刻意**不再写第二个"可不可比"的判断**：本仓反复记的"看板说退化 8%、门禁说
 * 退化 24%"全部来自同一个事实有两个答案。这句话因此只做两件事：
 *  - 报告里复述"换后端不可比"，让人知道那一格为什么响；
 *  - CLI 在**没给** `--runner-spec` 时拒绝猜规格（见 `commands.ts` 那句报错），
 *    因为猜出来的规格会让两次不同的压测**看起来可比**。
 *
 * 后端名没有自己那一维仍是**真实缺口**（要加字段 + 同步那张表 + 迁移历史样本），
 * 登记在 docs/14；那句"读 runnerSpec 里有没有 `(builtin)`"这种字符串约定
 * **不写成判据**，只写在报错与报告文案里。
 */
export const BACKEND_INCOMPARABLE =
  '施压后端不同 = 换压法：内置后端与 k6 在 teardown 次数（每 VU 一次 vs 全场一次）、'
  + '响应体上限（后者没有该参数）两处**故意**不同，被测系统挨的写请求数量也不同。两边读数不可比。';

/**
 * 后端名进指纹的方式。**只由 CLI 与测试用**，别处不许自己拼 ——
 * 拼错一个括号就让"同后端"的两场跑判成不可比，而那种误报的结局是有人去掉 runnerSpec。
 */
export function runnerSpecWithBackend(spec: string, backend: 'builtin' | 'k6'): string {
  return `${spec} (${backend})`;
}

/**
 * `--runner-spec` 的闸：**没给就拒绝开跑**。返回值而不是抛 —— 这一层是判据，
 * 命令侧负责把它变成 CliError（判据模块里不放 IO 也不放退出码，与 gate.ts 同形状）。
 *
 * `LoadFingerprint.runnerSpec` 是 `incomparableReasons` 的第一维，而它要的是
 * "8c16g" 那种**人手写、与历史基线同口径**的标签。猜一个的话（`cpus()`+`totalmem()`
 * 拼出来的那个）危险不在于值不准，而在于**它会与历史上手写的标签不一样**，
 * 于是每次换机器都"不可比"，人学会忽略那一格 —— 那一格被忽略之后，
 * "拿一次别的机器上的跑当基线"就再没人拦了，那正是 docs/09 §4.3 点名的死法。
 *
 * 反过来也一样糟：允许"没给就写 `unknown`"的话，**两次都没给的跑**就会互相判为可比，
 * 而它们可能在完全不同的机器上。所以这一格没有宽容档：要么人给，要么不压。
 */
export function runnerSpecOrRefuse(given: string | undefined): { spec: string } | { why: string } {
  const v = given?.trim();
  if (v) return { spec: v };
  return {
    why: '压测必须显式给 --runner-spec（施压机规格，如 "8c16g"）。它进环境指纹，'
      + '而指纹的第一维就是它：没有它，两次不同机器上的压测会被判成"可比"，'
      + '性能门禁从此拦不住任何东西。工具不自动探测：机器规格要与历史基线**同口径**才有意义，'
      + '而口径是人定的。',
  };
}

/**
 * 机器规格的**提示**（不是值，永远不参与判据）。
 *
 * 只出现在"你没给 --runner-spec"那句报错后面，作用是让人知道该写成什么形状。
 * 刻意不说"就用这个吧"：CI 上那一行会读出流水线机器的规格，而流水线机器是换的 ——
 * 把它抄进 CI 配置得到的是一条**每次换 runner 就不可比**的基线。
 */
export function runnerSpecHint(): string {
  const n = cpus().length;
  const gb = Math.ceil(totalmem() / 1024 / 1024 / 1024);
  return `参考形状：本机此刻是 ${n} 核 / ${gb}GB。要写的是**这一台施压机的固定口径**，不是实时读数`;
}

/** 两个后端的标签值。名单只在这一处（命令侧的校验、指纹、报告都读它） */
export const LOAD_BACKENDS = ['builtin', 'k6'] as const;
export type LoadBackend = (typeof LOAD_BACKENDS)[number];

/**
 * 压测能用的时钟：**只有 live**。返回而不是抛，理由与 `runnerSpecOrRefuse` 同一条
 * （这一层是判据，退出码归命令侧）。
 *
 * ## 为什么 `--clock deterministic` 在压测里是**错的数**而不只是"没意义"
 * `deterministicClock.mono()` 只在 `sleep()` 时前进（`adapters.ts`）。于是：
 *  - 一条没有 sleep 步骤的用例里，每个请求的 `ms` 恒为 0 → **p50/p95/p99 全是 0**，
 *    而 0 是 `PerfMetricsSchema` 的合法值（`min(0)`），门禁看不出这是假的；
 *  - 有了 sleep 就前进，前进的量是**作者写的那个数**，不是墙上时间 →
 *    曲线随用例文本走，看起来"稳定得惊人"，比随机噪声更难识破。
 *
 * 这两种读数都会**通过**基线判据（`durationMs` 也是实测窗口，同样由那个时钟给出），
 * 所以这不是"结果不准"，是"一条永远绿的假门禁"。而它比没门禁更坏。
 *
 * ## 为什么不是"只用冻结时钟跑语义测试"那条路
 * 那条路是对的，但它不需要命令行开关 —— `load-press.test.ts` / `load-parity.test.ts`
 * 直接给 `press()` 传冻结时钟，那才是它的用途。**人敲的这条命令要的是真数字**。
 * 把开关留在这里、运行时告警一次，是不够的：告警在 CI 日志里，而那份日志的读者
 * 只看红绿。所以是拒。
 */
export function loadClockOrRefuse(given: string | undefined): { clock: 'live' } | { why: string } {
  if (given === undefined || given === 'live') return { clock: 'live' };
  return {
    why: `压测只能用 --clock live（实际是 "${given}"）。`
      + '确定性时钟的 mono() 只在 sleep() 时前进，用它量出来的 p50/p95 要么是 0、要么是"用例里写的那个 sleep 秒数"，'
      + '而 0 是 PerfMetrics 的合法值 —— 门禁不会报，只会一直绿。',
  };
}

/** 这次压测的身份。`LoadRunOutcome` 里那份是"跑完之后"的，这一份是开跑前就定好的 */
export interface LoadIdentity {
  scenarioId: string;
  runId: string;
  env: EnvFingerprint;
  /** 人给的施压机规格标签（已经过 `runnerSpecOrRefuse`） */
  runnerSpec: string;
  /** 取 `takenAt` 的时钟。CLI 给 liveClock，测试给冻结时钟 */
  now: () => number;
}

/**
 * 把一次压测的合成事实拼成产物。**门禁判据一条都不在这里**（在 `ir/baseline.ts`），
 * 施压语义也不在这里（在 `adapter-http/load/press.ts`）。这一层只合成三件事：
 * 后端那一维的指纹、时间戳、以及"这次是谁、哪场跑"的身份。
 *
 * `status` 由调用方给，而且**接成一整个对象**而不是 `runStatus` + `aborted` 两个入参：
 * 那两维由同一次判断给出（`loadRunStatus`），拆成两个参数就能各取一半，
 * 于是同一场压测的"结论"与"完整吗"来自两处 —— 与本文件从头到尾在防的形状同形。
 * ⚠ 这**不等于**"取消这件事全仓只有一个读点"：`commands.ts` 的退出码那里另外读了一次
 * `signal.aborted`，因为按在 press 返回之后才落下的那一下不会让
 * `result.cancelled` 变 true。那一段自己记着理由，两处读的是**不同**的问题
 * （"这一场完整吗" vs "要不要给 CI 报 10"），不是同一个事实的两个答案。
 * **teardown 的失败不进这里** —— 与解释器同一条口径：teardown 失败不改"被测对不对"的结论。
 * 把它的失败并进来的话，一场"压测全过、清理没干净"会被读成"这份性能数据不可信"，
 * 而清理留了脏数据与分位数是两件事（前者该修清理，后者该看曲线）。
 */
export function loadOutcome(i: {
  identity: LoadIdentity;
  backend: LoadBackend;
  metrics: PerfMetrics;
  /** 实测指纹（`measuredLoad` 给的），**不含**后端名 —— 这里拼，见下 */
  load: LoadFingerprint;
  status: { product: StepStatus; aborted: boolean };
  iterationsPerVu: number[];
  failureReasons: string[];
}): LoadRunOutcome {
  return {
    scenarioId: i.identity.scenarioId,
    runId: i.identity.runId,
    backend: i.backend,
    metrics: i.metrics,
    // 后端名拼进 runnerSpec，于是"换后端"走 incomparableReasons 已有的那一维。
    // 拼这一处的只有这里（`runnerSpecWithBackend` 的注释）。
    load: { ...i.load, runnerSpec: runnerSpecWithBackend(i.load.runnerSpec, i.backend) },
    env: i.identity.env,
    runStatus: i.status.product,
    aborted: i.status.aborted,
    takenAt: i.identity.now(),
    modelNote: PRESS_MODEL_NOTE,
    iterationsPerVu: i.iterationsPerVu,
    failureReasons: i.failureReasons,
  };
}

/**
 * 压测形态的"功能侧结论"。**是推出来的，不是另跑一次功能回归**，所以这句话必须随产物一起打印。
 *
 * 为什么不另跑一次功能回归再压（这看着更像"完整流程"）：那会**把 setup/teardown 的副作用
 * 做两遍**（压测里每个 VU 还要各做一遍），而 docs/02 §5 的不可逆动作纪律管的正是这个。
 * 压测形态自己的断言是有的（`assert` 在 LOAD_STEP_SUPPORT 里是 flow，"必须演"），
 * 所以结论可以从它推：**断言没过 = 该次请求失败 = 进错误率**。
 *
 * ## 返回的是**两个**事实，不是一个状态
 * `{ product, aborted }` —— 前者是"被测对不对"（IR 的 StepStatus），后者是"这一场完整吗"。
 * 我前版本让它返回单个 `StepStatus | 'aborted'`，把两件事压成一个词，
 * 于是"被取消"只能靠**盖过**产品结论来表达，而压下去之后那个词在 UI 里无处落：
 * `manifest.status` 要写它，而前端徽章的白名单只有 IR 那六个状态，
 * `aborted` 不在其中 -> **落进兜底那一格 -> 画成红色的 error**。
 * 一场"人按 Ctrl-C 停下来的压测"因此与"引擎崩了"在运行记录列表里长得一模一样，
 * 而功能那条路上同样是取消的 run 画的是 `pass 已中断`（status 不变、aborted 另有一栏）。
 * 同一件事在两条路上一条说"中断"、一条说"崩了"，就是本仓记过多次的"一个事实两个答案"。
 *
 * 所以这里把两维分开，与功能那条路同形：
 *  - `aborted`：被取消。这一场不是一次完整施压，实测窗口由取消时刻决定。
 *  - `product`：`error` = 施压本身没过（setup 没过 / 迭代里抛错 / 一个请求都没发出去），
 *    对齐 run 那条路的"setup 失败一律升级为 error"—— 前置不成立时被测系统根本没被压到；
 *    `fail` = 打出去了而有失败（错误率 > 0，或有非请求类的断言没过）；
 *    `pass` = 一场干净的压测。
 *
 * ⚠ **这一档永远不可能出 `healed`**（压测形态没有自愈），所以"healed 不许当基线"那条
 * 判据在这里是**空转**而不是被绕过 —— 但 `promoteRefused` 仍然照判，别把它当冗余删掉：
 * 哪天压测形态接上自愈（没排期），那条判据会立刻开始起作用。
 */
export function loadRunStatus(o: {
  cancelled: boolean;
  threw: boolean;
  errorRate: number;
  failureReasons: readonly string[];
}): { product: StepStatus; aborted: boolean } {
  // 两维分开之后，"取消排第一"这件事**不再靠改返回值**表达 —— 它改的是
  // 上面那条"这一场算不算完整"，而"被测对不对"照实说（那几百个请求的失败率是真的）
  const aborted = o.cancelled;
  if (o.threw) return { product: 'error', aborted };
  if (o.errorRate > 0 || o.failureReasons.length) return { product: 'fail', aborted };
  return { product: 'pass', aborted };
}

/** 这次压测的**作者意图**那两维（vus / durationMs）有没有被命令行覆盖。
 *
 * 覆盖是合法的（开发时想 5 秒跑一把），但覆盖值必须进指纹，而且要**说出来**：
 * 悄悄用 10 VU 压了一条写着 100 VU 的场景，与历史基线一比就是"退化 80%"。
 *
 * ## 为什么这里调 `loadFingerprintIntent` 而不直接读 `load.vus`
 * 要比较的那一对**正是**"指纹里由作者定了的那两维"，而那两维的名单只有一处定义
 * （`ir/src/load.ts`）。直接写 `load.vus` / `load.durationMs` 就是把那份名单抄第二份：
 * 以后给 LoadProfile 加第三个"作者定的压法维度"（例如显式的连接数），
 * 那张表跟得上、这句比较跟不上，于是新那一维被覆盖时**没人报警** ——
 * 而没报警正是这一整层要避免的结局。名单跟着表走，加一维就自动比一维。
 */
export function overrideNotice(load: LoadProfile, actual: { vus: number; durationMs: number }): string[] {
  const intent = loadFingerprintIntent(load);
  const out: string[] = [];
  if (actual.vus !== intent.vus) out.push(`并发数被覆盖：IR 写 ${intent.vus}，本次实打 ${actual.vus}`);
  if (actual.durationMs !== intent.durationMs) out.push(`时长被覆盖：IR 写 ${intent.durationMs}ms，本次实打 ${actual.durationMs}ms`);
  return out;
}

/**
 * 把一次压测变成一个基线候选。**字段全过 schema**，不合法就抛而不是发出去：
 * 一条坏样本躺在基线文件里，下一次读它会整批失败，而报错指向的是"读基线"那一步。
 */
export function toBaselineSample(o: LoadRunOutcome, targetKey = ''): BaselineSample {
  return BaselineSampleSchema.parse({
    // id 的稳定形态：同一场压测重算两次得到同一个 id，覆盖而不是追加
    id: `${o.scenarioId}|${targetKey}|${o.runId}`,
    // projectId：本仓还没有项目表（docs/01 §表结构 那张图里 P1 才有）。
    // 用场景 id 的首段兜一个"看起来像项目"的值是**故意不用**的 ——
    // 那会让两条不同项目的场景在跨项目查询里混成一池。这里填常量并在报告里说明。
    projectId: 'default',
    scenarioId: o.scenarioId,
    targetKey,
    sourceRunId: o.runId,
    metrics: o.metrics,
    runStatus: o.runStatus,
    env: o.env,
    load: o.load,
    takenAt: o.takenAt,
    pinned: false,
  });
}

/** 门禁阈值。字段名与 `PerfGateThresholds` 对齐，取值全有默认（不逼用户先配一份阈值表） */
export interface LoadGateOptions {
  maxP95Regression?: number;
  maxErrorRate?: number;
  minRpsRatio?: number;
  maxP50Regression?: number;
}

/**
 * 压测后的门禁。**判据一条都不在这里** —— 全在 `ir/src/baseline.ts` 的
 * `evaluatePerfGate`（含 `incomparableReasons` 与 `envDiffForPerf`）。
 * 这一层只做一件事：把阈值默认值补齐。
 *
 * 为什么不再补一条"后端不同"的判据：那等于给"这两次能不能比"第二个答案，
 * 而本仓记过的每一次"两个数对不上"都来自一个事实有两处判断。
 * 后端那一维靠 `runnerSpecWithBackend` 走已有那一维（见常量注释）。
 */
export function loadGate(outcome: LoadRunOutcome, baseline: BaselineSample | undefined, o: LoadGateOptions = {}): PerfGateResult {
  return evaluatePerfGate(outcome.metrics, baseline, outcome.load, outcome.env, {
    maxP95Regression: o.maxP95Regression ?? 0.2,
    maxErrorRate: o.maxErrorRate ?? 0.001,
    minRpsRatio: o.minRpsRatio ?? 0.9,
    maxP50Regression: o.maxP50Regression ?? 0.1,
  });
}

/**
 * 这次能不能当基线。判据本体是 `promoteRefused`（healed/fail/短跑/0 样本），
 * 这里**只补一条**它看不见的：**被取消**的场次。
 *
 * ## 只补一条是本轮量出来的（从前这里补三条，其中两条是重复的）
 * 从前还带着 `samples < 1` 与 `load.durationMs < MIN_SAMPLES_MS`，而 `promoteRefused`
 * 看的是**同一个 sample 的同一个字段** —— `toBaselineSample(outcome)` 把
 * `outcome.metrics` 与 `outcome.load` **原样搬过去**，所以两边永远同时成立。
 * 实测过一次屏幕输出：
 *
 * ```
 * 不写基线（2 条理由）：
 *   · 施压时长 45ms < 30000ms，样本量不足，分位数是抛硬币
 *   · 实测窗口 45ms < 30000ms：分位数由个位数样本决定，拿它判退化就是抛硬币
 * ```
 *
 * 那不是"信息更全"，而是一个事实两个答案，**其中一个口径还是错的**：第一句把
 * **实测窗口**（45ms）叫成"施压时长"，而 IR 里写的施压时长是 1200ms，同一屏上两个数。
 * 读的人会以为有两个不同的量各自没过线 —— 与本仓记过多次的"看板说退化 8%、
 * 门禁说退化 24%"是同一形状，只是这里两个数恰好相同，所以只表现为罗嗦。
 *
 * ## aborted 那一条留着，它给的判断本体给不出
 * 本体只会说"结论是 aborted，只有 pass 能当基线"，而那句话括号里的解释是
 * healed/fail 的理由（"路径变了""耗时不是正常路径的耗时"）。被取消的真相是
 * "这不是一次完整施压，实测窗口由取消时刻决定"，下一步动作也完全不同
 * （前者改用例，后者**重跑一场**）。
 *
 * 还有一条本体**永远追不上**的：一场"取消了 45 秒"的跑躲得过短跑判据（45s > 30s），
 * 而它压根不是一次完整压测 —— 这一条只能由这里补。
 *
 * ⚠ 压测形态出不了 `healed`（压测没有自愈），所以"healed 不许当基线"那条在这里是
 * **空转**而不是被绕过。别因此删它：哪天压测形态接上自愈，它立刻开始起作用。
 * ⚠ k6 后端的产物压根到不了这里 —— CLI 只在 builtin 分支写基线，那一格是**结构性**的，
 * 不靠这里的判据。
 */
export function promoteLoadRefused(outcome: LoadRunOutcome, sample: BaselineSample): string[] {
  const out = promoteRefused(sample);
  if (outcome.aborted) out.push('这场压测被取消了：它不是一次完整的施压，实测窗口由取消时刻决定');
  return out;
}

/**
 * 从一堆样本里挑基线，**先按场景 + 目标接口筛**。
 * `pickBaseline` 自己不筛场景 —— 直接把整个文件交给它，会让场景 A 的基线
 * 拿来判场景 B（它的判据是 pinned 优先 + 最新合格，与场景无关），
 * 于是"退化 40%"的成因是隔壁那条用例。筛池这一刀必须在调用侧。
 */
export function pickLoadBaseline(samples: readonly BaselineSample[], key: { scenarioId: string; targetKey: string }): BaselineSample | undefined {
  const mine = samples.filter((s) => s.scenarioId === key.scenarioId && s.targetKey === key.targetKey);
  return pickBaseline(mine.map((s) => s));
}
/**
 * 给实测指纹**补上施压那一侧结构上不知道的那几维**（数据量 / 被测实例数与规格）。
 *
 * ## 为什么这不是"第二个指纹合成点"
 * 施压侧的实测维（runnerCount / vus / connections / **实测** durationMs）只有一个生产者：
 * `adapter-http` 的 `measuredLoad`。这一处**不重新构造**那个对象，只在它的返回值上
 * 追加字段 —— 我前版本写的是一个自己拼整份 `LoadFingerprint` 的 `fingerprintOf`，
 * 那是彻头彻尾的第二个合成点，而且它当场就错了：它把 `vus` 取成**作者意图值**
 * （`loadFingerprintIntent`）而不是实测值，于是"IR 写 100 VU、这次 `--vus 10` 覆盖"
 * 与"上次真压了 100 VU"拥有同一个指纹，`incomparableReasons` 那一路全都放行 ——
 * 而那一路正是这一整层存在的理由。删掉它，只留"追加"这一件事。
 *
 * ## 为什么不干脆不加这几维
 * `incomparableReasons` 对"一边填了一边没填"的数据量**会报不可比**
 * （那条的理由：填报缺失不等于环境差异）。所以只要某次填了，另一次没填的跑
 * 就全被判不可比 —— 这看着烦，但方向是对的（宁可不判，不要错判可比）。
 * 反过来说：如果永远没人填，这几维永远 undefined，判据永远沉默 —— 那是
 * "同一份 SQL 在 1 万行与 1 亿行上 p95 差两个数量级"那一格没人管。
 * 所以给它一个**显式**的入口，而不是让每个调用点自己决定要不要塞。
 */
export function withSutDims(
  measured: LoadFingerprint,
  extra: { dataVolume?: number; sutInstances?: number; sutSpec?: string },
): LoadFingerprint {
  return {
    ...measured,
    ...(extra.dataVolume !== undefined ? { dataVolume: extra.dataVolume } : {}),
    ...(extra.sutInstances !== undefined ? { sutInstances: extra.sutInstances } : {}),
    ...(extra.sutSpec !== undefined ? { sutSpec: extra.sutSpec } : {}),
  };
}
