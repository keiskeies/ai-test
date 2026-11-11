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

/**
 * **单一步骤自己**需要哪些端 —— `deriveTargets` 与 `targetSources` 共用的那一格判据。
 *
 * 抽出来不是为了好看，是因为"逐步"与"整段"两个问法都要问同一个问题，
 * 而两处各写一遍 `STEP_TARGET[s.kind]` 再各写一遍 mobile 那一支的细分，
 * 迟早只更新一处。
 *
 * 返回数组而不是单个值：`targetsOfStep` 的判据是"这一步自己需要什么"，
 * 而一个步骤需要什么**由表说**，表今天是单值的**不代表判据是单值的** ——
 * 写死返回一个 `TargetKind` 会让"某个 kind 需要两个端"变成改签名而不是加一个元素
 * （而改签名的那一轮会波及所有调用点，正是没人愿意改、于是随手 if 一下的形状）。
 *
 * ⚠ mobile 那一支**只有 `device` 报平台**（本轮改的；改前的行为与实测读数见
 * `ir/test/target-sources.test.ts` 里「mobile 那一支只读 device.target」那条）。
 * 改前的写法是"读任何叫 `target` 的字段，读不出平台就落 android"，而 mobile 那一档里
 * 叫 `target` 的字段有**三种互不相干的含义**（本轮逐个量过，不是推的）：
 *  - `device.target` 是**平台枚举** —— 唯一真正的平台来源；
 *  - `tap`/`input`/`key`/`swipe` 的是 **LocatorSpec**（点哪个元素，是个对象，
 *    永远不等于 `'ios'`）→ 无条件落 android，于是纯 iOS 场景凭空多出一个 android；
 *  - `assertUi.target` 是**字符串引用**（指向哪一步的输出，schema 是 `z.string()`）
 *    → `assertUi{target:'ios'}`（"那个叫 ios 的元素"）被读成"这条场景要 iOS 设备"。
 *
 * 所以"其余 mobile 步骤报什么"这一格的正确答案是**什么都不报**：它们确实要设备，
 * 但**说不出要哪一端**，而替它们猜一个 android 是把"我不知道"写成"我知道"。
 * **"这一步要不要设备"是另一个问题**，由 `deriveNeedsDevice` 答（它读 `STEP_TARGET`
 * 的档位、不读平台），两者刻意分开 —— 合成一个的时候，就是这个函数同时答错两件事的时候。
 */
export function targetsOfStep(s: Step): TargetKind[] {
  const t = STEP_TARGET[s.kind];
  if (t === 'api') return ['api'];
  if (t === 'web') return ['web'];
  if (t === 'mobile') {
    // 只有 device 那一步真的带平台。其余 mobile 步骤返回空：**不是漏**，
    // 是"这件事不由这一步说"。要"要不要设备"去问 deriveNeedsDevice。
    if (s.kind !== 'device') return [];
    const kind = (s as { target?: unknown }).target;
    return [kind === 'ios' ? 'ios' : kind === 'harmony' ? 'harmony' : 'android'];
  }
  // 'any' 那一档（sequence / if / forEach …）自己不需要任何端，所以返回空。
  // **容器的子步骤不算在这里** —— 整段的端是 deriveTargets 靠 walk 累出来的。
  // 这一格必须返回空，否则"这一步为什么需要浏览器"会把一个 sequence 也点名列出，
  // 而 sequence 自己什么都不要。本轮第一版就是让它去调 deriveTargets([s])
  // （那个函数会 walk 进子步骤），实测报错文案报出
  // 「Web 需求来自这些步骤：sequence（seq1）、navigate（n2）」——
  // **我要修的错归因，被我的修法复制了一份**：容器被指认为需求来源，
  // 而真正需要浏览器的只有它里面那条 navigate。改成共用这一格判据之后，
  // 容器天然不在名单里，而整段那份清单一个字没变（walk 照旧累加子步骤）。
  return [];
}

/**
 * 从步骤推导目标端集合（IR 里 targets 是冗余字段，推导函数是它的唯一权威来源）。
 *
 * ## 它只回答"哪一端"，不回答"要不要设备"
 *
 * 只有 `device` 那一步会往这里贡献 android/ios/harmony（理由见 `targetsOfStep`）。
 * 所以一份「setup 里 `device{target:'ios'}` + body 里 `tap`」的场景推出来是
 * `["ios"]` —— 改前是 `["ios","android"]`（多的那个来自 `tap` 替它猜的那一端），
 * 而 `assertUi{target:'ios'}` 那种"一个元素名让全场景声称要 iOS 设备"也不再可能。
 *
 * ⚠ **由此得到的一个重要推论**：`deriveTargets(...).some(是移动端)` **不再**
 * 等价于"这个场景需要设备" —— 一份只有裸 `tap`（作者漏写了 `device` 那一步）的场景
 * 现在推出来是**空集**，而它是本文件 `LEASE_REQUIRED` 意义上的"需要设备"。
 * 需要后者请用 `deriveNeedsDevice`。这不是理论顾虑：本轮第一版就是顺手把
 * `lint.ts` 那道 `needsDevice` 前置过滤留在这里、只改这一支，结果
 * `RESOURCE_LEASE_MISSING` 对"裸 tap"整个**不响了**（`.scratch/probe-lint-naked-tap.mts`，
 * 永久落点 `engine/test/lease-scope.test.ts`「前置过滤不许来自端集合」那条）——
 * 把一条报 error 的静态闸修成静默，比那个多余的 android 严重得多。
 *
 * 仍然要说一句：它的输出进了 `canonicalScenario`，所以**这一版的输出本身就是一份
 * 磁盘契约**（改前的历史证据里那些 mobile 步多的 android 属于旧版算法，不回填 ——
 * 理由见 `store/src/ir-hash.ts` 的"算法只有两个自由度"那段与本文件 `canonicalScenario`
 * 规则 3：不补默认值、不做事后规范化）。
 *
 * 需要"因为哪一步"的时候用 `targetSources`：它说得出是谁，但**共用同一格判据**，
 * 所以判据本身错时它会忠实复述那个错（这是刻意的 —— 分叉的话报错点名的步骤里
 * 没有一个需要那个端，而两个函数各自看都自洽）。
 */
export function deriveTargets(steps: Step[]): TargetKind[] {
  const set = new Set<TargetKind>();
  walk(steps, (s) => { for (const t of targetsOfStep(s)) set.add(t); });
  return [...set];
}

/**
 * 这个场景**要不要设备**（不问哪一端）。
 *
 * ## 为什么它不能由 `deriveTargets` 推出来
 *
 * 判据是 `STEP_TARGET[kind] === 'mobile'`，也就是**档位**，不是平台。这件事本来可以由
 * `deriveTargets(...).some(是移动端)` 代替，而那一版本轮实测过、坏了：`deriveTargets`
 * 的移动端那一格里今天只有 `device` 会发言（平台只有它说得出），所以"作者漏写 device 步"
 * 这种**最需要报警**的形状会让那个派生判据变成 false，于是整条租约静态闸静默跳过。
 * **一个只能让守卫变哑的派生判据，不是优化，是守卫的漏洞**（docs/08 §3：
 * 守卫自己漏报比没有守卫更坏，它让人以为数过了）。
 *
 * 反过来也不许用它代替 `deriveTargets`："要设备"里不含"要哪一端"，
 * 按端申请设备的那一侧读它会拿不到平台。两问两答，各一张判据，这才是分开的理由。
 *
 * 与 `LEASE_REQUIRED` 的关系要说准（两者**不是一张表**，本轮逐个 kind 对过）：
 * 本函数按 `STEP_TARGET` 的档位算，覆盖 mobile 那一档的**全部 10 个 kind**；
 * `LEASE_REQUIRED` 只有 8 个，不含 `device` 自己（它不是"要用别人的租约"，它是租约的来源）
 * 与 `watcher`（它没有独立租约语义，跑在别的步骤挣来的那台上）。所以：
 *  - 本函数答"这台机器要被用"，`LEASE_REQUIRED` 答"这一步手上得有租约"；
 *  - 拿前者当后者的前置过滤是**安全的方向**（前者是后者的超集，漏报不可能由它引入），
 *    反过来用不行；`walkLease` 里真正报错的那一格读的一直是后者。
 */
export function deriveNeedsDevice(steps: Step[]): boolean {
  let needs = false;
  walk(steps, (s) => { if (STEP_TARGET[s.kind] === 'mobile') needs = true; });
  return needs;
}

/**
 * 是哪**几步**让这个场景需要 `target` 那个端。给报错文案用（`cli/wiring.ts` 里
 * "没配浏览器"那一句要点名来源），不参与任何门禁判据。
 *
 * ## 为什么要有它（它不是"再做一个遍历"）
 *
 * `deriveTargets` 只回答"要不要"，答不了"因为谁"。缺了"因为谁"，报错只能说
 * "本次场景用到 Web 步骤" —— 那句话**字面没错，而它是 IR 写错时最误导人的一句归因**。
 * 实测（docs/15 §3.3 那条五步链的第 3 步，本轮第一次量到）：一份只有
 * `app` 步骤 + 一条**误写的** `assertPage` 的纯移动端场景，`targets` 推出来是
 * `["android","web"]`，装配期抛「本次场景用到 Web 步骤，但没配浏览器」。
 * 人于是去装 Chrome，不会去想"我这个纯 app 场景里哪来的 Web 步骤"。
 * 点名之后那句话能自己说明白：`assertPage` 是 Web 世界的能力，
 * 而作者要的大概是 `assertUi`。
 *
 * ## 为什么逐步判据走 `targetsOfStep` 而不是自己查 `STEP_TARGET`
 *
 * 这一条**必须**与 `deriveTargets` 同判据，而判据里有一处**不是查表**的：
 * `mobile` 那一档要再读 `s.target` 才细分成 android/ios/harmony
 * （`STEP_TARGET` 只有 `'mobile'` 这一档，不区分平台）。
 * 所以这里若自己写 `STEP_TARGET[s.kind] === 'web'`，今天对（web 那一档确实不细分），
 * **而任何测试都抓不到它哪天不再对** —— 与权威表分叉的表现是
 * "报错说这些步骤是 Web 需求来源，而 `needsWeb` 判的是另一套"，
 * 也就是把一条错归因换成两条互相打脸的错归因。两步共用 `targetsOfStep`
 * 让这件事在结构上不可能发生。
 *
 * ⚠ 但**不能**图省事写成 `deriveTargets([s])`：那个函数会 `walk` 进子步骤，
 * 于是容器也算"需要 web"，报错就把 `sequence` 一起点名列出 —— 本轮第一版正是这样，
 * 详见 `targetsOfStep` 里那段。
 *
 * **不返回整个 Step**：调用方要的是"说得出是谁"，给对象会把 IR 内容整份带进报错文案，
 * 而报错是要进 CI 日志的。
 */
export interface TargetSource {
  /** 步骤 id */
  at: string;
  /** 步骤 kind（就是作者写的那个词，报错要点名它） */
  what: string;
  /** 从顶层到这一步的 id 链，用于容器里的步骤（"sequence s1 > navigate n2"） */
  chain: string[];
}

export function targetSources(steps: Step[], target: TargetKind): TargetSource[] {
  const out: TargetSource[] = [];
  walk(steps, (s, path) => {
    // 逐步判据与 deriveTargets 共用一格：判据不许有第二份，理由见函数头
    if (targetsOfStep(s).includes(target)) out.push({ at: s.id, what: s.kind, chain: path });
  });
  return out;
}

/**
 * `scenarioRef`（`id@version`）里的 **id** 部分。
 *
 * 为什么要占一个导出函数而不让调用方各写一遍 `ref.split('@')[0]`：
 * 这个切分是"**环按 id 判还是按 ref 判**"那条判据的唯一支点 ——
 * `interpreter.ts` 里那段环检测的注释写着「判据按场景 id 而不是 ref：
 * `A@1 → B@1 → A@2` 也是环」，而**这句话在两个地方要成立**（运行时的 callStack、
 * 静态闸的调用图）。两处各写一遍 split，其中一处忘了切分时的表现是
 * "`A@1 → B@1 → A@2` 这种环静态看不出来、运行时才发现" —— 而那正是这条规则存在的理由被绕过去。
 *
 * ⚠ `@version` 今天**不参与解析**（`cli/commands.ts` 的 makeCallResolver 只按 id 找文件，
 * 那里记着原因：平台还没有版本表）。所以"切出 id"目前也就是"实际用哪份 IR"。
 */
export function scenarioIdOfRef(ref: string): string {
  return ref.split('@')[0]!;
}

/**
 * `scenarioRef`（`id@version`）里的 **version** 部分；没写就是 `undefined`。
 *
 * 与 {@link scenarioIdOfRef} 住在同一个文件、同一个理由：**ref 的切分不许有第二份**。
 * 这里返回的是"**作者有没有提出版本这个要求**"，而**不是**"用的是哪个版本"——
 * 后者今天没有答案（没有版本表）。
 *
 * 为什么单独成一个函数而不是让调用方 `ref.includes('@')`：
 * 那个写法会把 `id@`（写了 @ 而没写版本）也算成"提出了要求"，而后面什么都没有。
 * 判据集中在一处，将来要放宽或收紧只有一个地方要改。
 *
 * **刻意不限制成"纯数字"**：`sub.login@v3` 同样是提出了一个版本要求，
 * 把它排除在外就等于**又给那一种写法留下静默** —— 而这一条存在的全部理由
 * 就是终结静默。宁可把 `@draft` 这种非数字版本也一并吼一声（那句话本身
 * 没断言版本长什么样，只说"这一句没生效"），也不要漏掉任何一种写法。
 */
export function scenarioVersionOfRef(ref: string): string | undefined {
  const at = ref.indexOf('@');
  if (at < 0) return undefined;
  const v = ref.slice(at + 1);
  return v.length > 0 ? v : undefined;
}

/** 一条 `call` 步骤：在**哪一步**、call 的**哪个 ref** */
export interface CallSite {
  at: string;
  ref: string;
  /** `scenarioIdOfRef(ref)` —— 图要按它键（理由见那个函数） */
  id: string;
}

/**
 * 这个场景**直接** call 了哪些子场景（含 setup/teardown 与所有容器里的 call）。
 *
 * 只走一层、不递归进子场景 —— 调用图是"每个节点记自己的出边"，
 * 递归由消费方（`cli/commands.ts` 的 buildScenarioGraph）沿边走。
 * 这里若替消费方做闭包，就把"环"这个概念抄进了 IR，而环检测恰恰是它要防的东西。
 */
export function callSites(scenario: Scenario): CallSite[] {
  const out: CallSite[] = [];
  walk([...scenario.setup, ...scenario.body, ...scenario.teardown], (s) => {
    if (s.kind !== 'call') return;
    const ref = s.scenarioRef;
    out.push({ at: s.id, ref, id: scenarioIdOfRef(ref) });
  });
  return out;
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
