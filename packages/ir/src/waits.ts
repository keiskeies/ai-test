/**
 * 等待策略（docs/02 §3）—— 「等待」是条件，不是时长。
 *
 * 这是调研认定的第二个空白点（docs/00 §4.2）：**没有任何现有平台有「等待策略」节点，
 * 全都是固定时长 sleep**。Apifox 的「等待」就是延时。而每个 delay:3000 都是一颗
 * 未来的 flake + 一次套件变慢。所以 IR 里**没有 wait.duration 字段**，
 * 需要干等只能显式写 sleep 节点，且被 lint 警告。
 */
import { z } from 'zod';
import { ExprSchema, RefSchema, ValueSchema } from './values.js';
import { LocatorSpecSchema } from './locator.js';

/** 单个条件 */
export const WaitConditionSchema = z.discriminatedUnion('type', [
  /** 某步骤的 HTTP 状态命中 */
  z.object({ type: z.literal('httpStatus'), ref: RefSchema, in: z.array(z.int()).min(1) }).strict(),
  /** 纯表达式（变量间比较、聚合） */
  z.object({ type: z.literal('expr'), expr: ExprSchema }).strict(),
  /**
   * 数据库某行出现/消失。**MySQL 已在栈里，这是白送的差异化能力**，
   * 且解决「API 下单 → 异步落库 → UI 验证」这条最常见跨端链路的等待问题。
   */
  z
    .object({
      type: z.literal('dbRow'),
      /** 只读 SQL；$var 占位由引擎绑定（禁止字符串拼接） */
      sql: z.string().min(1),
      datasource: z.string().default('default'),
      expect: z.enum(['row', 'noRow', 'scalarTruth']).default('row'),
    })
    .strict(),
  /** 界面谓词（要求目标是 aria/hierarchy 世界） */
  z
    .object({
      type: z.literal('uiPredicate'),
      target: LocatorSpecSchema,
      state: z.enum(['visible', 'attached', 'enabled', 'gone']).default('visible'),
    })
    .strict(),
  /** 模板命中/未命中（像素世界的等价物，docs/10 §4） */
  z
    .object({
      type: z.literal('template'),
      target: LocatorSpecSchema,
      expect: z.enum(['hit', 'miss']).default('hit'),
      minConfidence: z.number().min(0).max(1).default(0.8),
    })
    .strict(),
  /** Detox 式「app 空闲」门控。安卓端动画未结束就 dump 是 flake 主因之一 */
  z.object({ type: z.literal('uiIdle'), quietMs: z.int().min(0).max(5000).default(400) }).strict(),
  /** 等某个接口回来（docs/06 §3：Web 侧最有价值的等待） */
  z
    .object({
      type: z.literal('response'),
      urlPattern: z.string().min(1),
      status: z.array(z.int()).optional(),
    })
    .strict(),
]);
export type WaitCondition = z.infer<typeof WaitConditionSchema>;

/** 复合条件：至少保留一层 anyOf/allOf/noneOf，便于 Agent 生成与人类阅读 */
export const WaitPredicateSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    WaitConditionSchema,
    z.object({ allOf: z.array(WaitPredicateSchema).min(1) }).strict(),
    z.object({ anyOf: z.array(WaitPredicateSchema).min(1) }).strict(),
    z.object({ noneOf: z.array(WaitPredicateSchema).min(1) }).strict(),
  ]),
);
export type WaitPredicate = z.infer<typeof WaitPredicateSchema>;

/** 等待的通用参数。poll 有下限，避免把被测系统打死。 */
export const WaitOptionsSchema = z
  .object({
    timeoutMs: z.int().min(100).max(600_000).default(10_000),
    pollMs: z.int().min(50).max(30_000).default(500),
    backoff: z.enum(['none', 'linear', 'exponential']).default('exponential'),
    onTimeout: z.enum(['fail', 'continue', 'error']).default('fail'),
  })
  .strict();
export type WaitOptions = z.infer<typeof WaitOptionsSchema>;

/** 供 UI 文案与 lint 提示复用的元信息 */
export function describePredicate(p: WaitPredicate): string {
  if (!p || typeof p !== 'object') return String(p);
  const o = p as Record<string, unknown>;
  if ('allOf' in o) return `(所有条件成立) ${o.allOf as unknown[]}`.slice(0, 80);
  if ('anyOf' in o) return `(任一条件成立) ${o.anyOf as unknown[]}`.slice(0, 80);
  if ('noneOf' in o) return `(所有条件都不成立) ${o.noneOf as unknown[]}`.slice(0, 80);
  const t = o.type as string;
  if (t === 'dbRow') return `数据库出现匹配行（${(o.datasource as string) ?? 'default'}）`;
  if (t === 'uiPredicate') return `界面元素${o.state === 'gone' ? '消失' : '可见'}`;
  if (t === 'uiIdle') return '界面空闲（动画结束）';
  if (t === 'template') return `图像模板${o.expect === 'miss' ? '未命中' : '命中'}`;
  if (t === 'response') return `等待接口 ${o.urlPattern}`;
  if (t === 'httpStatus') return `接口状态 ∈ ${JSON.stringify(o.in)}`;
  if (t === 'expr') return `表达式为真：${String(o.expr).slice(0, 40)}`;
  return t ?? '条件';
}

/** 供 ValueSchema 之外的地方复用：断言里也可能要比较 Value */
export { ValueSchema };
