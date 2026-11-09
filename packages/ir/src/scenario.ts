/**
 * 场景（Scenario）—— 用例的唯一真相源（docs/02 §1）。
 */
import { z } from 'zod';
import { OutputDefSchema, ParamDefSchema, RetrySchema } from './values.js';
import { StepSchema, type Step } from './steps.js';
import { TargetKindSchema } from './targets.js';
import type { TargetKind } from './values.js';
import { STEP_TARGET, walk } from './steps.js';

export const SCHEMA_VERSION = '1';

/**
 * 确定性边界。CI 触发时若 frozen=false，引擎**拒绝执行**
 * （docs/00 §4.3：这条把 Agent 对话入口与 CI 门禁安全隔开）。
 */
export const ProvenanceSchema = z
  .object({
    origin: z.enum(['human', 'agent', 'imported', 'distilled']),
    /** 蒸馏/生成用的 prompt 版本 hash（docs/03 §4：prompt 变更影响可重现性，必须可见） */
    promptHash: z.string().optional(),
    modelId: z.string().optional(),
    seed: z.number().int().optional(),
    /** 生成时依据的 spec 版本（OpenAPI 文档 hash / 页面画像 hash），用于 spec 漂移检测 */
    specHash: z.string().optional(),
    generatedAt: z.string().optional(),
    /** 迁移来源（docs/11 §3 双向链接） */
    sourceCaseId: z.string().optional(),
    sourceSystem: z.enum(['zentao', 'jira-xray', 'jira-zephyr', 'testrail', 'excel', 'doc']).optional(),
    /** AI 充实的置信度（docs/11 §4） */
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ScenarioConfigSchema = z
  .object({
    timeoutMs: z.int().min(1000).max(7_200_000).default(600_000),
    /** 成本上限（美元）。超出即中断 run 并落盘证据，不是事后台账（docs/03 §2） */
    maxCostUsd: z.number().min(0).max(1000).default(0.5),
    /**
     * 场景级默认重试策略。步骤级 retry 覆盖它。
     *
     * 这里**必须**复用 RetrySchema：早先它是一个手写的精简版（只有
     * count/backoff/baseMs），于是同一个概念有两种形状 —— 步骤上能写 retryOn
     * 「只在 5xx 重试」，写在场景级就被 strict 直接拒绝，用户只能一步步重复写。
     * 精简的收益（少两个字段）远小于「同一语义两套语法」的长期税。
     */
    retries: RetrySchema.default({ count: 0, backoff: 'exponential', baseMs: 2000, maxMs: 10_000, retryOn: ['network', 'timeout'] }),
    /** 同组内互斥（共享 fixture 时） */
    parallelGroup: z.string().optional(),
    /** 数据驱动迭代间能否并行。有写操作且无 teardown 时 lint 会要求 false */
    concurrencySafe: z.boolean().default(true),
    /** 是否会产生脏数据（docs/05 §5） */
    dirty: z.boolean().default(false),
  })
  .strict();
export type ScenarioConfig = z.infer<typeof ScenarioConfigSchema>;

export const ScenarioSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    tags: z.array(z.string().max(40)).default([]),
    /**
     * 由步骤推导后冗余存储，供检索与能力校验（docs/02 §1）。
     *
     * 允许为空：纯逻辑场景（只做 set/assert，或专供 call 复用的数据准备）确实
     * 不触碰任何被测端，写个 `['api']` 去满足 min(1) 是在撒谎 —— 能力校验会因此
     * 以为它要打接口。「必须声明目标端」是 lint 提示（TARGETS_EMPTY），
     * 不是 schema 硬约束：硬约束会让合法场景根本解析不过。
     */
    targets: z.array(TargetKindSchema).default([]),
    /** 显式切换（已确认决策）：脚本模式确定性回放 / Agent 模式自主探索 */
    mode: z.enum(['script', 'agent']).default('script'),
    /** 冻结后才可进 CI */
    frozen: z.boolean().default(false),
    inputs: z.array(ParamDefSchema).default([]),
    outputs: z.array(OutputDefSchema).default([]),
    env: z
      .object({
        environmentRef: z.string().min(1),
        /** 固定到某个环境修订（极少用；默认运行时解析并记进 run） */
        pinRevision: z.int().optional(),
      })
      .strict(),
    identity: z.string().optional(),
    setup: z.array(StepSchema).default([]),
    body: z.array(StepSchema).min(1),
    teardown: z.array(StepSchema).default([]),
    config: ScenarioConfigSchema.default({
      timeoutMs: 600_000,
      maxCostUsd: 0.5,
      retries: { count: 0, backoff: 'exponential', baseMs: 2000, maxMs: 10_000, retryOn: ['network', 'timeout'] },
      concurrencySafe: true,
      dirty: false,
    }),
    provenance: ProvenanceSchema.optional(),
  })
  .strict();
export type Scenario = z.infer<typeof ScenarioSchema>;

/** 从步骤推导目标端集合（IR 里 targets 是冗余字段，推导函数是它的唯一权威来源）。 */
export function deriveTargets(steps: Step[]): TargetKind[] {
  const set = new Set<TargetKind>();
  walk(steps, (s) => {
    const t = STEP_TARGET[s.kind];
    if (t === 'api') set.add('api');
    else if (t === 'web') set.add('web');
    else if (t === 'mobile') {
      const kind = (s as { target?: unknown }).target;
      set.add(kind === 'ios' ? 'ios' : kind === 'harmony' ? 'harmony' : 'android');
    }
  });
  return [...set];
}

export const ScenarioVersionMetaSchema = z
  .object({
    ver: z.int().min(1),
    irSha: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
    origin: ProvenanceSchema.shape.origin,
    /** 由自愈回写产生的版本会带上 diff 摘要，供审校队列展示（docs/00 §5.6） */
    healedFromVersion: z.int().optional(),
  })
  .strict();
export type ScenarioVersionMeta = z.infer<typeof ScenarioVersionMetaSchema>;

/**
 * 场景的**规范投影**：同一份 IR 语义，无论从哪个文件读、键顺序如何，都得到同一个字符串。
 *
 * `irSha`（证据清单里的"这条证据由哪一版 IR 产出"）与 `ScenarioVersionMeta.irSha`
 * 都从这里算，因为**它们必须是同一个值才有用**：P1 的版本表按 irSha 去重，
 * 证据包也按 irSha 回答"这次跑的是哪一版"。两处各写一套规范化（一边排序、一边不排），
 * 版本表就会给同一份 IR 建两个版本，而证据包说"它们是一版的"。
 *
 * 三条规则，每条都有它防的事故：
 *  0. **入参必须是 `parseScenario`/`defineScenario` 出来的 Scenario**。
 *     这个函数**不做校验**（它接收的类型已经是校验过的），因此也不防 NaN ——
 *     它对"两个语义相同的场景给出同一个串"的保证，前提是场景真的过 schema。
 *     直接把外部 JSON 塞进来算哈希是错的：那种哈希会把不合法的内容也编成一个稳定值，
 *     于是"这份证据出自哪一版"会得到一个**看起来能回答**的答案。
 *  1. **对象键排序，数组顺序保留**。键顺序无语义（重排文件不该产生新版本号），
 *     数组顺序全是语义（步骤顺序换了就是另一条用例）。
 *  2. **丢掉 undefined 的键，不丢 null**。`{a: undefined}` 与 `{}` 是同一份 IR；
 *     而 `null` 是显式值（`{token: null}` 表示"就是要传空"），丢了它会让
 *     "把某个字段改成 null"这件事不改变哈希 —— 那正是最该触发新版本的一类改动。
 *  3. **不做任何默认值补全**。zod 的 `.default()` 已经在 parse 期跑过了，
 *     这里再补一遍等于把默认值焊死在两个地方：日后改默认值，
 *     所有历史 irSha 会集体漂移，版本表里就会出现"同一份内容两个哈希"。
 *  4. **`frozen` 被排除**（唯一被排除的正式字段，规则本身有测试钉着）。
 *     它是**生命周期状态，不是内容**：「冻结」的含义是"人确认这一版可以当门禁依据"，
 *     内容一个字没改。把它算进哈希，冻结就给同一条用例造出第二个 irSha，
 *     而 P1 版本表按 irSha 去重 → 冻结动作凭空产生一个"新版本"。
 *     ⚠ **代价要写明白**：`frozen` 是 `EvidenceManifest` 与 `ScenarioVersionMeta`
 *     两边共用的字段，排除它意味着 **run 证据里的 frozen 不再等于那一版版本的 frozen**
 *     （`--allow-unfrozen` 跑出的证据会写着 `frozen:false`，而它指向的版本是冻结的）。
 *     那个不一致是真的，不做统一：证据要记的是**运行时的实际状态**
 *     （决定这份证据能不能当门禁依据），版本表要记的是**生命周期动作**。
 *     读证据的人需要的是前者，所以 manifest 保留 frozen 原样。
 *
 * 注意它**不是**内容签名（不是密码学意义上的防篡改）：目的是**稳定性**，
 * 让"改了一个空格"与"改了一个断言"在哈希上可比。真要防篡改得用签名，那是 P1 权限层的事。
 */
export function canonicalScenario(scenario: Scenario): string {
  const { frozen: _frozen, ...rest } = scenario;
  void _frozen;
  return JSON.stringify(stable(rest));
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      // 键顺序在这里定了；undefined 在这里丢
      if (val !== undefined) out[k] = stable(val);
    }
    return out;
  }
  // 非有限数必须单独编码，**不能让它走 JSON 的默认处理**。
  // JSON.stringify(NaN) 与 JSON.stringify(Infinity) 都产出 `null`，
  // 于是「生成器参数写了 NaN」的场景与「同一处写了 null」的场景会算出**同一个 irSha**，
  // 版本表会认为它们是同一版（探针确认：`{gen:'int', with:{min:NaN}}` 与
  // `{gen:'int', with:{min:null}}` 的规范串逐字相同）。
  //
  // 这条路是活的：数字字段本身过不了 zod（v4 的 number/int 拒 NaN/±Infinity，
  // 已确认），但 `GenValue.with`、`trace.data`、`keyContext` 这些
  // **逃生舱字段是 `z.record(z.string(), z.unknown())`，而 unknown 接受一切**。
  // 逃生舱正是该防的地方 —— 严格 schema 覆盖不到的角落才是碰撞会藏身的地方。
  if (typeof v === 'number' && !Number.isFinite(v)) return `«nonfinite:${String(v)}»`;
  return v;
}
