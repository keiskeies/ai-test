/**
 * `baseline` 模型（docs/09 §4.3）—— P0 就建，成本是一张表。
 *
 * 为什么现在建而不是等 P7：docs/09 §4.3 的原话是
 * "**施压是商品能力，性能回归门禁才是测试平台该卖的**"。
 * 门禁的规则是
 * ```
 * p95 相对基线退化 > 20% → fail；错误率 > 0.1% → fail；吞吐低于容量目标 → warn
 * 性能结论必须带环境指纹（机器规格/连接数/数据量），否则不可比
 * ```
 * 这三行里的每一个判据都要读同一份数据。P0 不建，P7 就会发现"基线"这个词
 * 散落在十几个文件里各写一遍，而**它们的口径必然不一致** ——
 * 于是出现"看板说退化 8%、门禁说退化 24%"，没人能解释，最后门禁被关掉。
 *
 * 而且压测与 `perfSmoke`（docs/05 §3）**共用**这套模型：同一份场景既是功能用例
 * 又是压测用例，是本平台相对竞品的连贯性卖点，判据只该有一份。
 *
 * 本文件是纯数据 + 纯函数（不 import 任何 node 内置模块，由 lint-layers 强制）：
 * 判据要在 CI、看板、编辑器三处给出**同一个结论**，有任何一处自己算一遍就分叉。
 */
import { z } from 'zod';
import { EnvFingerprintSchema } from './trace.js';

/**
 * 负载维度的指纹。
 *
 * **为什么不复用 trace.ts 的 EnvFingerprint**：那个管的是"这次回放与上次回放是否等价"
 * （时钟模式、随机种子、视口、模型指纹），而性能结论要的是另一批维度 ——
 * **施压机规格、连接数、数据量**。docs/09 §4.3 明确点名这三个。
 * 硬塞进 EnvFingerprint 会有两个坏处：一是功能用例的指纹里凭空多出"施压 VU 数"
 * 这种无意义字段，二是漏掉真正要的（数据量），后者才是"不可比"的主因：
 * 同一份 SQL，1 万行和 1 亿行的 p95 差两个数量级，
 * 拿小数据量的跑当基线，扩容后每次发布都"性能退化"。
 */
export const LoadFingerprintSchema = z
  .object({
    /** 施压机规格。cpu/memory 用简短字符串即可（"8c16g"），但要**同一口径**填 */
    runnerSpec: z.string().min(1),
    /** 施压节点数。1 台打 1000 VU 和 10 台各打 100 是完全不同的负载形态 */
    runnerCount: z.int().min(1).default(1),
    /** 并发/VU 数。p95 随并发变化，并发不同的两次运行不可比 */
    vus: z.int().min(1),
    /** 保持的连接数。与 vus 分开记：短连接压测和长连接压测测的是不同的瓶颈 */
    connections: z.int().min(1).optional(),
    /** 数据集规模（行数或记录数）。数据量是"同一条 SQL 慢十倍"的头号外因 */
    dataVolume: z.int().min(0).optional(),
    /** 被测侧实例数/规格。同一份代码打 1 个 pod 和 8 个 pod 不可比 */
    sutInstances: z.int().min(1).optional(),
    sutSpec: z.string().optional(),
    /** 施压时长。低于此值时样本量通常不足，判退化就是抛硬币（见 MIN_SAMPLES_MS） */
    durationMs: z.int().min(1),
  })
  .strict();
export type LoadFingerprint = z.infer<typeof LoadFingerprintSchema>;

/**
 * 一次运行的性能观测值。
 * 全部可选：**缺哪个就说明这次没测哪个**，判据遇到缺失项跳过并报告，
 * 绝不能当 0 —— 把"没测到 p95"当成"p95=0"会让任何基线都"退化"。
 */
export const PerfMetricsSchema = z
  .object({
    p50Ms: z.number().min(0).optional(),
    p95Ms: z.number().min(0).optional(),
    p99Ms: z.number().min(0).optional(),
    /** 吞吐（req/s）。方向与延迟相反：吞吐**低于**目标才是问题 */
    rps: z.number().min(0).optional(),
    /** 失败率，0..1。注意与"用例通过率"无关：这是压测请求层面的错误比 */
    errorRate: z.number().min(0).max(1),
    /** 样本量。小于阈值的运行不参与基线（单点当基线 = 天天误报） */
    samples: z.int().min(0).default(0),
  })
  .strict();
export type PerfMetrics = z.infer<typeof PerfMetricsSchema>;

/**
 * 有资格成为基线的样本。
 * 注意 `runId` / `scenarioVersionId` 这些是**外键**，本包不知道数据库存在，
 * 只声明形状；落库由 P1 的 store 层做（docs/01 §表结构：runs 表旁加一张）。
 */
export const BaselineSampleSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    /** 基线锚在**场景 + 目标接口**上，不锚在场景版本上：
     *  版本每改一次基线就清零的话，性能门禁在活跃开发的场景上永远没有基线可用 */
    scenarioId: z.string().min(1),
    /** 哪个接口/用例的指标。空串表示整场景聚合 */
    targetKey: z.string().default(''),
    /** 采到这次数据的那次 run（用于回溯证据，docs/01 runs 表） */
    sourceRunId: z.string().min(1),
    metrics: PerfMetricsSchema,
    /** 功能侧结论：healed/fail 的 run 不能当基线，见 promoteCandidate */
    runStatus: z.string().min(1),
    env: EnvFingerprintSchema,
    load: LoadFingerprintSchema,
    takenAt: z.number().int().min(0),
    /** 人手指定的基线。手动基线绕开自动入选条件，但**不绕开可比性检查** */
    pinned: z.boolean().default(false),
  })
  .strict();
export type BaselineSample = z.infer<typeof BaselineSampleSchema>;

/** 门禁阈值。默认值直接来自 docs/09 §4.3 那三行。 */
export const PerfGateThresholdsSchema = z
  .object({
    /** p95 相对基线退化比例上限。0.2 = 退化 20% 判 fail */
    maxP95Regression: z.number().min(0).max(10).default(0.2),
    /** 错误率绝对上限。0.001 = 0.1% */
    maxErrorRate: z.number().min(0).max(1).default(0.001),
    /** 吞吐低于基线的这个比例就 warn（不是 fail：吞吐受容量规划影响，先给人看） */
    minRpsRatio: z.number().min(0).default(0.9),
    /**
     * p50 退化阈值。默认**比 p95 更严**（0.1）。
     * 理由：p50 涨说明**整条路径变慢**（多半是代码或依赖变了），
     * p95 涨而 p50 不动通常是 GC/锁/噪声。只看 p95 会把噪声当事故，
     * 只看 p50 会漏掉长尾 —— 两个都要，但报警优先级不同。
     */
    maxP50Regression: z.number().min(0).max(10).default(0.1),
  })
  .strict();
export type PerfGateThresholds = z.infer<typeof PerfGateThresholdsSchema>;

/** 判据结论的三档。**pass/warn/fail 之外必须还有一档"没法判"**，见下。 */
export const PerfVerdictSchema = z.enum(['pass', 'warn', 'fail', 'unknown']);
export type PerfVerdict = z.infer<typeof PerfVerdictSchema>;

export interface PerfGateResult {
  verdict: PerfVerdict;
  /** 每条命中/未命中的判据，人话。**必须逐条带出**：只给一个红/绿，
   *  值班人无法判断该回滚还是该改阈值，最后就是关掉门禁 */
  reasons: string[];
  /** 相对基线的各项退化比例（正值=变慢/变差）。缺失项不出现在这里 */
  regressions: Record<string, number>;
  /** verdict='unknown' 的原因。见 UNKNOWN 的设计说明 */
  unknownWhy?: string;
}

/**
 * 短于此的运行不参与判退化。
 * 30s 在 100 rps 下约 3000 样本，够算 p95；再短的话 p95 由个位数样本决定，
 * 抖动就能"退化 30%"。这个数字是**经验下限**，不是精确统计结论 ——
 * 所以宁可让人改 durationMs 也别让门禁天天误报。
 */
export const MIN_SAMPLES_MS = 30_000;

/**
 * 指纹可比性检查。返回**不可比的原因**（空数组=可比）。
 *
 * 这是整个文件最重要的一段。性能门禁最常见的死法不是判错，而是
 * "拿一次不可比的跑当基线"：换施压机、改并发、清了数据，
 * 于是每次发布都报退化 40%，三周后有人把门禁关了。
 * 所以判退化之前先证明可比，**不可比就明确说不可比**，而不是硬算一个数。
 */
export function incomparableReasons(base: LoadFingerprint, cur: LoadFingerprint): string[] {
  const out: string[] = [];
  if (base.runnerSpec !== cur.runnerSpec) out.push(`施压机规格不同（基线 ${base.runnerSpec} / 本次 ${cur.runnerSpec}）`);
  if (base.runnerCount !== cur.runnerCount) out.push(`施压节点数不同（${base.runnerCount} vs ${cur.runnerCount}）`);
  if (base.vus !== cur.vus) out.push(`并发数不同（${base.vus} vs ${cur.vus}）—— p95 随并发变化，两者不可比`);
  if ((base.connections ?? base.vus) !== (cur.connections ?? cur.vus)) out.push(`连接数不同（${base.connections ?? base.vus} vs ${cur.connections ?? cur.vus}）`);
  if (base.dataVolume !== cur.dataVolume) {
    // 数据量两边都得**填了**才谈可比：一边填一边没填，"不同"是填报缺失而不是环境差异
    if (base.dataVolume === undefined || cur.dataVolume === undefined) out.push('数据量未记录（基线与本次至少有一边没填 dataVolume）');
    else if (base.dataVolume !== cur.dataVolume) out.push(`数据量不同（${base.dataVolume} vs ${cur.dataVolume}）`);
  }
  if ((base.sutInstances ?? 1) !== (cur.sutInstances ?? 1)) out.push(`被测实例数不同（${base.sutInstances ?? 1} vs ${cur.sutInstances ?? 1}）`);
  if (base.durationMs !== cur.durationMs) out.push(`施压时长不同（${base.durationMs}ms vs ${cur.durationMs}ms）`);
  return out;
}

/**
 * 环境指纹里会影响性能结论的那几维。
 * EnvFingerprint 覆盖面更广（视口、种子…），那些与性能无关，不该拿来拦性能门禁 ——
 * 否则改个 locale 就把基线判废，同样导致门禁被关。
 */
function envDiffForPerf(a: BaselineSample['env'], b: BaselineSample['env']): string[] {
  const out: string[] = [];
  if (a.environmentRef !== b.environmentRef) out.push(`环境不同（${a.environmentRef} vs ${b.environmentRef}）`);
  if (a.platform !== b.platform) out.push(`执行平台不同（${a.platform} vs ${b.platform}）`);
  if (a.appSha && b.appSha && a.appSha === b.appSha) {
    // 同一版本之间没有"回归"这回事：没有变更可比对。
    // 判 unknown 而不是 pass —— 数字真有大幅波动时也该有人看一眼，
    // 所以原因里写清楚"该更新基线"，而不是给个绿灯把人打发走。
    out.push(`被测版本相同（appSha=${a.appSha}）：同版本之间不存在回归，应更新基线而不是判退化`);
  }
  return out;
}

/** 退化比例。正数=变慢/变差。分母为 0 或任一缺测 -> undefined（不返回 0） */
function ratio(cur: number | undefined, base: number | undefined, higherIsWorse: boolean): number | undefined {
  if (cur === undefined || base === undefined) return undefined;
  if (!Number.isFinite(cur) || !Number.isFinite(base) || base <= 0) return undefined;
  const r = (cur - base) / base;
  return higherIsWorse ? r : -r; // 吞吐：涨了是好事，取负后统一按"正数=变差"处理
}

/**
 * 性能门禁判据。
 *
 * 设计约束，逐条对应真实死法：
 *
 *  1. **没有基线 -> 'unknown'，不是 'pass'**。
 *     把"没基线"判成通过，等于新场景上线头三个月没有门禁而没人知道。
 *     'unknown' 要能被 CI 配成"阻断并要求人先建基线"。
 *  2. **不可比 -> 'unknown' 并列出原因**（见 incomparableReasons）。
 *  3. 每个指标**缺测就跳过并写明跳过**，不当 0、不当通过。
 *  4. verdict 取所有命中项里最严重的一档；warn 与 fail 分开，
 *     因为吞吐受容量规划影响，第一版只该 warn（一上来就 fail 的阈值会被立刻关掉）。
 */
export function evaluatePerfGate(
  cur: PerfMetrics,
  base: BaselineSample | undefined,
  curLoad?: LoadFingerprint,
  curEnv?: BaselineSample['env'],
  thresholds: PerfGateThresholds = PerfGateThresholdsSchema.parse({}),
): PerfGateResult {
  const reasons: string[] = [];
  const regressions: Record<string, number> = {};

  // **本次跑本身坏掉，比"能不能比"更靠前**：样本为 0 意味着压根没打出请求
  // （施压脚本启动即崩、URL 写错、压测机没网）。这类事实与基线无关，
  // 判 unknown 会把一次彻底失败的压测归进"今天没法判"，
  // 而 unknown 在多数 CI 配置里是不阻断的 —— 于是坏掉的压测流水线能连续绿一周。
  if (cur.samples < 1) {
    return { verdict: 'fail', reasons: ['本次样本量为 0：压根没打出请求，任何"通过"或"判不了"都不可信'], regressions };
  }

  if (!base) {
    return { verdict: 'unknown', reasons: ['没有可用基线：本次不做性能判定'], regressions, unknownWhy: 'no-baseline' };
  }
  if (base.metrics.samples < 1) {
    return { verdict: 'unknown', reasons: ['基线样本量为 0，任何退化比例都没有意义'], regressions, unknownWhy: 'empty-baseline' };
  }
  const why: string[] = [];
  if (curLoad) why.push(...incomparableReasons(base.load, curLoad));
  if (curEnv) why.push(...envDiffForPerf(base.env, curEnv));
  if (cur.samples * 10 < base.metrics.samples) {
    why.push(`本次样本量 ${cur.samples} 远少于基线 ${base.metrics.samples}，分位数不可比`);
  }
  if (why.length) return { verdict: 'unknown', reasons: ['基线与本次不可比：' + why.join('；'), ...reasons], regressions, unknownWhy: 'incomparable' };

  let verdict: PerfVerdict = 'pass';
  const bump = (v: 'warn' | 'fail') => { if (v === 'fail' || verdict === 'pass') verdict = v; };

  /**
   * 算一项 + 出结论 + **同一个地方决定它算不算超标**。
   *
   * 早先这里是"worse() 里判一次生成文案、bump() 外面再判一次改 verdict"，
   * 两处比较同一个阈值。那就是我自己在这个文件里批评的东西：
   * 看板说退化 8%、门禁说退化 24%，因为两处四舍五入/边界取的符号不一样。
   * 现在 verdict 只可能来自 worse() 的返回值，判据只有一份。
   */
  const check = (key: string, r: number | undefined, lim: number, level: 'warn' | 'fail', label: string) => {
    if (r === undefined) { reasons.push(`${label}：基线或本次缺测，跳过该项（缺测不等于通过）`); return; }
    regressions[key] = Number(r.toFixed(4));
    // 边界：r > lim 才算超标（等于阈值算通过）。这一句是整个门禁里唯一的比较点。
    if (r > lim) {
      reasons.push(`${label}：退化 ${(r * 100).toFixed(1)}% > 阈值 ${(lim * 100).toFixed(0)}%`);
      bump(level);
    } else {
      reasons.push(`${label}：${(r * 100).toFixed(1)}%，未超阈值`);
    }
  };

  check('p95', ratio(cur.p95Ms, base.metrics.p95Ms, true), thresholds.maxP95Regression, 'fail', 'p95');
  check('p50', ratio(cur.p50Ms, base.metrics.p50Ms, true), thresholds.maxP50Regression, 'fail', 'p50');
  // 吞吐低于目标的幅度：ratio() 已取负，所以"低于 minRpsRatio"等价于 ratio > 1 - minRpsRatio
  check('rps', ratio(cur.rps, base.metrics.rps, false), 1 - thresholds.minRpsRatio, 'warn', '吞吐');

  // 错误率是**绝对**判据，与基线无关：基线本身错误率就高的话，相对值会掩盖问题
  if (cur.errorRate > thresholds.maxErrorRate) {
    bump('fail');
    reasons.push(`错误率 ${(cur.errorRate * 100).toFixed(2)}% > 阈值 ${(thresholds.maxErrorRate * 100).toFixed(2)}%`);
  } else {
    reasons.push(`错误率 ${(cur.errorRate * 100).toFixed(2)}%，未超阈值`);
  }

  return { verdict, reasons, regressions };
}

/**
 * 这次 run 有没有资格成为基线。
 *
 * **healed 不能当基线**：自愈意味着定位/契约已经变了但仍判通过。
 * 拿它当基线，等于把"改动后的耗时"当成"本该有的耗时"，
 * 下一次真退化就落在容差里 —— 基线被悄悄下调是最隐蔽的失效，
 * 因为它让门禁看起来在工作（一片绿），实际已经不再拦任何东西。
 *
 * **fail 的 run 不能当基线**：错误路径的耗时不是正常路径的基线。
 *
 * 短跑（< MIN_SAMPLES_MS）不能当基线，理由见常量注释。
 * `pinned` 的人手基线绕开这三条 —— 人可能有意要钉一个"上线前那次"，
 * 但**不绕开可比性检查**：绕开它就会拿一台别的机器跑的数据来判本次。
 */
export function promoteRefused(sample: {
  runStatus: string; load: { durationMs: number }; metrics: { samples: number }; pinned?: boolean;
}): string[] {
  if (sample.pinned) return [];
  const out: string[] = [];
  if (sample.runStatus !== 'pass') out.push(`那次运行结论是 ${sample.runStatus}，只有 pass 的运行能做性能基线（healed 意味着路径已经变了；fail 的耗时不是正常路径的耗时）`);
  if (sample.load.durationMs < MIN_SAMPLES_MS) out.push(`施压时长 ${sample.load.durationMs}ms < ${MIN_SAMPLES_MS}ms，样本量不足，分位数是抛硬币`);
  if (sample.metrics.samples < 1) out.push('样本量为 0');
  return out;
}

/** 从若干候选里挑基线：优先 pinned，其次最近一次合格的。 */
export function pickBaseline(candidates: BaselineSample[]): BaselineSample | undefined {
  const ok = candidates.filter((c) => promoteRefused(c).length === 0);
  if (!ok.length) return undefined;
  const pinned = ok.filter((c) => c.pinned);
  // 多个 pinned 时取最近的那个。"最新的合格跑"而不是"平均值"：
  // 平均值会把一次故障摊进基线，从此再也判不出这个量级的退化。
  return [...(pinned.length ? pinned : ok)].sort((a, b) => b.takenAt - a.takenAt)[0];
}
