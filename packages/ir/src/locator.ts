/**
 * 定位器规格（docs/02 §6 + docs/10 §2）—— 「LLM 是一次性定位器编译器」的落地物。
 *
 * 核心取舍：运行时**不依赖模型**。设计期付一次钱把定位器编译出来（primary/fallbacks/
 * compiledTo + fingerprint），运行期只跑编译产物；失败才走自愈阶梯并回写成人审 diff。
 * 已知未变的元素，testid/CSS 是 99.9% 可靠且零成本的 —— AI 只在「没为它写过定位器」
 * 的元素上有价值（docs/00 §2 决定性结论）。
 *
 * 注意：本文件刻意不 import targets.ts（避免循环）。`by` 在这里是开放字符串，
 * 具体每个 target 支持哪些词由 Capabilities.locatorBy 校验（docs/09 §1.1 约束 2）。
 */
import { z } from 'zod';

export const LocatorBySchema = z.enum([
  // A 级（有层级结构）
  'testid',
  'role+name',
  'label',
  'placeholder',
  'text',
  'textContains',
  'css',
  'xpath',
  'anchor',
  'nth',
  // 移动端
  'id',
  'content-desc',
  'class',
  'resource-id',
  // iOS / 鸿蒙（docs/09 §2/§3）
  'name',
  'predicate',
  'classChain',
  'key',
  // 编译产物类（运行时唯一实际使用的两类）
  'compiled-selector',
  'template',
]);
export type LocatorBy = z.infer<typeof LocatorBySchema>;

export const MatcherSchema = z.enum(['exact', 'contains', 'regex', 'starts', 'ends']).default('exact');

export const LocatorRuleSchema = z
  .object({
    by: LocatorBySchema,
    value: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    nameMatch: MatcherSchema,
    /** 限定容器，解决列表内近重复（docs/00 §8 定位器 flakiness） */
    within: z.string().optional(),
    index: z.int().min(0).optional(),
    /** anchor：在某个稳定文本的哪一侧 */
    side: z.enum(['left', 'right', 'above', 'below', 'inside']).optional(),
    /** 显式作用域，用于跨 frame / 列表分页扫描（docs/06 §1 iframe、§3 虚拟滚动） */
    scope: z.enum(['page', 'frame', 'shadow']).default('page'),
    frameName: z.string().optional(),
  })
  .strict();
export type LocatorRule = z.infer<typeof LocatorRuleSchema>;

/** 指纹：决定「什么时候才允许触发自愈」。陈旧命中比 miss 更危险（docs/00 §8）。 */
export const FingerprintSchema = z
  .object({
    /** 子树 sha256。变了才失效 —— 避免每次微小重绘都触发自愈风暴 */
    subtreeSha: z.string().optional(),
    textExpected: z.string().optional(),
    /** 归一化 bbox，仅作提示，永不做断言 */
    bboxHint: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    /** 记录时所在的 a11y/hierarchy 路径，抗同级重排 */
    a11yPath: z.string().optional(),
    recordedAt: z.string(),
    /** 记录时用的快照种类：跨种类比较指纹无意义 */
    snapshotKind: z.enum(['aria', 'hierarchy', 'pixels', 'none']),
  })
  .strict();
export type Fingerprint = z.infer<typeof FingerprintSchema>;

/**
 * 像素世界的编译产物：图像模板指纹（docs/10 §2）。
 *
 * 关键设计：**缓存模板图而非缓存坐标**。视觉坐标是 nonReplayable 的
 * （视口/分辨率/DPR 一变就废），会直接动摇「可回放」这个核心卖点。
 * 编译成模板后，视觉定位也变成确定性、可 diff、可人审的产物。
 */
export const TemplateCompiledSchema = z
  .object({
    kind: z.literal('template'),
    /** 内容寻址存储的模板图（art://tpl/sha256:…） */
    imageRef: z.string(),
    /** 首次匹配得分，人审时展示 */
    confidence: z.number().min(0).max(1),
    /** 搜索区域（归一化）。缺省=全帧搜索 → lint 警告（性能） */
    roi: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    scaleRange: z.tuple([z.number(), z.number()]).default([0.9, 1.1]),
    /** 邻近文本锚点：occurrences>1 时的消歧手段 */
    nearText: z.string().optional(),
    /** ★ 编译期全帧唯一性检查。>1 且无 nearText/index → lint error */
    occurrences: z.int().min(0),
    /** 主题/皮肤维度：换肤 app 需按主题各存一套（docs/10 Q4） */
    theme: z.string().default('default'),
    recordedAt: z.string(),
  })
  .strict();
export type TemplateCompiled = z.infer<typeof TemplateCompiledSchema>;

/** 视觉 grounding 兜底：允许出现在 fallbacks，但**不允许成为唯一路径**（lint 拦截） */
export const VisionCompiledSchema = z
  .object({
    kind: z.literal('vision'),
    strategy: z.enum(['set-of-mark', 'grounding-model', 'pure-coordinate']),
    /** 纯坐标一定不可回放；SoM/grounding 若拿到节点句柄则可回放 */
    nonReplayable: z.boolean(),
  })
  .strict();
export type VisionCompiled = z.infer<typeof VisionCompiledSchema>;

export const CompiledLocatorSchema = z.discriminatedUnion('kind', [TemplateCompiledSchema, VisionCompiledSchema]);
export type CompiledLocator = z.infer<typeof CompiledLocatorSchema>;

export const LocatorSpecSchema = z
  .object({
    /** 设计期自然语言意图。运行时不使用，仅供重编译与人阅读 */
    intent: z.string().min(1).max(500),
    /** 首选规则（最便宜可信的一级） */
    primary: LocatorRuleSchema.optional(),
    /** 阶梯降级序列，按「便宜→贵」排序 */
    fallbacks: z.array(LocatorRuleSchema).default([]),
    /** 编译产物：模板指纹或视觉兜底声明 */
    compiledTo: CompiledLocatorSchema.optional(),
    fingerprint: FingerprintSchema.optional(),
    /** 置信度门：低于此值不算命中，继续降级 */
    confidenceGate: z.number().min(0.5).max(1).default(0.85),
    /** 单步定位成本上限（美元）。超了降级到更便宜档位（docs/03 §2） */
    maxCostUsdPerResolve: z.number().min(0).max(1).default(0.02),
    /** 该定位器是否有任何可回放路径。false 时不得出现在 frozen 场景（lint） */
    replayable: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.primary || v.fallbacks.length > 0 || v.compiledTo, {
    message: '定位器必须至少有 primary / fallbacks / compiledTo 之一',
  });
export type LocatorSpec = z.infer<typeof LocatorSpecSchema>;

/**
 * 从任意字符串里提取变量引用，供 UI 渲染 VarChip（docs/12 §6）与静态闸扫描。
 * 集中一处实现 —— 引擎的未定义变量检查与前端的高亮必须是同一套匹配规则，
 * 否则会出现「前端显示成引用、lint 却不认」的分裂。
 *
 * `\$\.?` 是必要的：`$.step.x` 的 $ 后面跟着点号，只写 `\$[A-Za-z_]` 会
 * **一个都匹配不上**，所有步骤引用在静态闸眼里等于不存在。
 */
export const VarRefPattern = /\$\.?[A-Za-z_][\w.[\]-]*/g;
