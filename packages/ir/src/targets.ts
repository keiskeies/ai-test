/**
 * M0.5 · 平台中立契约（docs/09 §1）
 *
 * 「只定义不实现」。iOS / 鸿蒙 / pixels 世界的实现可以很晚才来，
 * 但三个契约必须 P0 定死：晚定一次的代价是把 IR 重写一遍。
 */
import { z } from 'zod';
import { LocatorSpecSchema, type LocatorSpec } from './locator.js';
import { SecretRefSchema, TargetRefSchema, VarNameSchema, TargetKindSchema } from './values.js';

/** 被测目标端。开放枚举：新增平台 = 新增 adapter 包，不改引擎（docs/09 §1）。
 *  值 TargetKindSchema 从 values.ts 再导出；**类型 TargetKind 只在 values.ts 导出**，
 *  否则 index.ts 的 `export *` 会产生 TS2308 歧义。 */
export { TargetKindSchema };
type TargetKind = z.infer<typeof TargetKindSchema>;

/**
 * ★ 四种快照世界观（docs/09 §1.2）—— 被低估的一处。
 * docs/02/06 假设了「一份快照同时当模型世界观 + 断言对象 + 自愈指纹」，
 * 但不同平台的快照能力天差地别，必须在类型层就区分，否则对 pixels 目标
 * 写层级谓词只能在运行时爆炸 —— 而它其实是类型错误，静态闸就该拦（docs/10 §5）。
 */
export const SNAPSHOT_KINDS = ['aria', 'hierarchy', 'pixels', 'none'] as const;
export const SnapshotKindSchema = z.enum(SNAPSHOT_KINDS);
export type SnapshotKind = z.infer<typeof SnapshotKindSchema>;

export const CapabilitiesSchema = z
  .object({
    /** 是否需要设备租约（api/web=false，移动端=true） */
    lease: z.boolean(),
    snapshotKind: SnapshotKindSchema,
    hierarchySource: z.enum(['aria', 'uiautomator', 'xcuitest', 'arkui', 'flutter']).optional(),
    injection: z.array(z.enum(['w3c-actions', 'scrcpy', 'wda', 'hdc-uitest', 'adb-input', 'cdp', 'http'])),
    streaming: z.enum(['scrcpy', 'wda-mjpeg', 'hdc-snapshot', 'cdp-screencast', 'none']).default('none'),
    /** 图像模板匹配可用 —— pixels 世界可回放化的基础（docs/10 §2） */
    templateMatch: z.boolean().default(false),
    /** context 切换（Appium 的 NATIVE_APP / WEBVIEW_xxx，WebView/H5 必需） */
    contextSwitch: z.boolean().default(false),
    /** 该 adapter 支持的定位词表。IR 用它做 per-target 校验，
     *  而不是把 Android 的 resource-id 写成全局枚举（否则 iOS 进来改 schema，鸿蒙进来再改一次）。 */
    locatorBy: z.array(z.string()),
  })
  .strict();
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** 设备需求（docs/02 §2 的 device 节点用它声明） */
export const DeviceRequirementSchema = z
  .object({
    udid: z.string().optional(),
    model: z.string().optional(),
    /** 语义化区间，如 ">=12"、"13 - 15" */
    osVersion: z.string().optional(),
    oem: z.string().optional(),
    /** 需要的能力（例如要求支持 scrcpy 投屏） */
    requires: z.array(z.string()).default([]),
  })
  .strict();
export type DeviceRequirement = z.infer<typeof DeviceRequirementSchema>;

/**
 * 设备租约。每个平台都有「只能人点一下」的弹窗（iOS 首次信任 / 安卓 unauthorized /
 * 鸿蒙未授权），也都需要「人工介入时锁自动化」—— 所以这些是**共享抽象而非平台细节**。
 * 晚定一次就要在三个平台各踩一遍（docs/09 §1.3、docs/07 §4）。
 */
export const LEASE_STATES = [
  'leased',
  /** 人在投屏里操作，自动化必须停 */
  'manual',
  /** 需要人到设备前处理（授权弹窗/重启/插线） */
  'needs_human',
  'unhealthy',
  'released',
] as const;
export const LeaseStateSchema = z.enum(LEASE_STATES);
export type LeaseState = z.infer<typeof LeaseStateSchema>;

export const LeaseSchema = z
  .object({
    id: z.string(),
    target: TargetKindSchema,
    deviceRef: z.string(),
    state: LeaseStateSchema,
    acquiredAt: z.string(),
    expiresAt: z.string(),
    holder: z.string(),
    /** 租约中途丢失时，adapter 尝试重获；失败则运行转 error（不是 fail） */
    renewable: z.boolean().default(true),
  })
  .strict();
export type Lease = z.infer<typeof LeaseSchema>;

/** 快照：一份产物三个职责（模型世界观 / 断言对象 / 自愈指纹）的载体 */
export const SnapshotSchema = z
  .object({
    kind: SnapshotKindSchema,
    /** 序列化后的文本（aria yaml / hierarchy xml / 其它）。pixels 时为空，只有 imageRef */
    data: z.string().optional(),
    imageRef: z.string().optional(),
    sha: z.string(),
    capturedAt: z.string(),
    /** 快照时生效的 context（NATIVE_APP / WEBVIEW_x） */
    context: z.string().optional(),
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** 定位结果。resolvedBy 记录「实际用了阶梯的第几级」—— flaky 治理与成本归因的数据源 */
export const ResolvedTargetSchema = z
  .object({
    handle: z.string(),
    /** 实际命中的策略描述，如 "testid" / "fingerprint:0.93" / "template:0.88" / "vision" */
    resolvedBy: z.string(),
    /** 阶梯级别（1..9），数字越小越便宜越可信 */
    rung: z.int().min(1).max(9),
    confidence: z.number().min(0).max(1).default(1),
    /** 是否不可回放（纯视觉坐标 → true，永不进 CI，docs/10 §5） */
    nonReplayable: z.boolean().default(false),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    /** 同图多实例警告（docs/10 §2） */
    occurrences: z.int().min(0).optional(),
  })
  .strict();
export type ResolvedTarget = z.infer<typeof ResolvedTargetSchema>;

/**
 * 操作。adapter 只需实现自己 target 相关的子集，引擎按 IR 节点类型分发。
 * 保持「数据」而非「闭包」，以便 Agent 模式可以把操作序列蒸馏成 IR（docs/01 §3）。
 */
export const OperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('navigate'), url: z.string(), waitUntil: z.enum(['load', 'dom', 'idle']).default('load') }).strict(),
  z.object({ op: z.literal('click'), value: z.string().optional() }).strict(),
  z.object({ op: z.literal('fill'), value: z.string(), keepKeyboard: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('select'), value: z.string() }).strict(),
  z.object({ op: z.literal('press'), key: z.string() }).strict(),
  z.object({ op: z.literal('hover') }).strict(),
  z.object({ op: z.literal('scroll'), dir: z.enum(['up', 'down', 'left', 'right']), amount: z.number().optional() }).strict(),
  z.object({ op: z.literal('swipe'), to: z.tuple([z.number(), z.number()]) }).strict(),
  z.object({ op: z.literal('drag'), to: z.tuple([z.number(), z.number()]) }).strict(),
  z.object({ op: z.literal('snapshot') }).strict(),
]);
export type Operation = z.infer<typeof OperationSchema>;

/**
 * TargetAdapter 的静态契约。执行侧唯一扩展点。
 *
 * 三条约束（docs/09 §1.1）：
 *  1. IR 与引擎只认 TargetAdapter，不认 ADB/Appium/Playwright。
 *  2. resolve() 在 adapter 内实现，但阶梯的**形状**由 LocatorSpec 约定。
 *  3. capabilities() 结果进 DB，**Agent 生成 IR 时先查能力、静态闸据此报错** ——
 *     本平台已真实踩过「模型不支持 tool call 导致运行时全瘫」的坑，
 *     同样的错误不该在设计层重犯。
 *
 * 用接口而非 zod 定义（函数无法 zod 化）。实现方是 engine/adapter，故此处不 import 它们。
 */
export interface TargetAdapter<Ctx = unknown> {
  target: TargetKind;
  capabilities(): Capabilities;
  /** 只有 lease=true 的平台需要实现 */
  lease?(req: DeviceRequirement, ctx: Ctx): Promise<Lease>;
  renew?(lease: Lease, ctx: Ctx): Promise<Lease>;
  release?(lease: Lease, ctx: Ctx): Promise<void>;
  snapshot(scope: unknown, ctx: Ctx): Promise<Snapshot>;
  resolve(loc: LocatorSpec, ctx: Ctx): Promise<ResolvedTarget>;
  perform(op: Operation, target: ResolvedTarget, ctx: Ctx): Promise<void>;
}

/** 会话/context 声明（WebView 切换、身份切换等横切概念统一建模） */
export const SessionSchema = z
  .object({
    identity: z.string().default('default'),
    target: TargetRefSchema.default('any'),
    /** storageState / app 会话保持的引用（docs/06 §5、docs/07 §5） */
    stateRef: z.string().optional(),
    /** 是否复用登录态。与 clearData 互斥，引擎在 dry-run 时检查冲突 */
    preserveSession: z.boolean().default(true),
    secrets: z.array(SecretRefSchema).default([]),
  })
  .strict();
export type Session = z.infer<typeof SessionSchema>;

export const IdentitySchema = z
  .object({
    name: VarNameSchema,
    description: z.string().max(200).optional(),
  })
  .strict();
export type Identity = z.infer<typeof IdentitySchema>;
