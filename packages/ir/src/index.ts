/**
 * @atest/ir —— 用例的唯一真相源。
 *
 * 本包必须是**纯数据 + 纯函数**：不得 import 任何 node 内置模块，
 * 因为它要同时在 Node（引擎/CLI/CI）、浏览器（编辑器实时校验）、
 * Worker（执行器）三处运行且行为必然一致。该约束由 tooling/lint-layers.mjs 在 CI 强制。
 */
export * from './status.js';
export * from './values.js';
export * from './targets.js';
export * from './locator.js';
export * from './asserts.js';
export * from './waits.js';
export * from './steps.js';
export * from './scenario.js';
export * from './trace.js';
export * from './baseline.js';

import { ScenarioSchema, deriveTargets, type Scenario } from './scenario.js';
import type { Step } from './steps.js';
import type { ZodError } from 'zod';

/**
 * 步骤与场景的**书写形态**：省略所有有默认值的字段。
 *
 * 为什么不直接用 `Step`：`Step` 是**校验后**的形状 —— zod 会把 onError/tags/exprExpected
 * 填上默认值，于是手写一个步骤要带上五个跟语义无关的字段。真正需要人（或 Agent、
 * 或 SDK builder）写的只有 id/kind 加各自的必填项。
 *
 * 类型上是松的（Record<string, unknown>），这是有意的：**合法性由 schema 判定，
 * 不由 TS 判定**。理由是这条链路的入口本来就是 JSON —— Agent 生成的、Excel 迁来的、
 * 前端表保存的，TS 一律看不见，只能靠 schema。想让 TS 也帮忙挡一层，
 * 请用 P2 的 SDK builder（它按 kind 收窄参数类型），而不是给裸字面量硬套 Step。
 */
export type StepDraft = Record<string, unknown>;
export type ScenarioDraft = Record<string, unknown>;

/** 书写形态里缺 targets 时按步骤推导；写了就以写的为准（显式优先，可标注额外能力） */
export function withDerivedTargets(draft: ScenarioDraft): ScenarioDraft {
  if (draft.targets !== undefined) return draft;
  return { ...draft, targets: deriveTargets((draft.body as Step[] | undefined) ?? []) };
}

export class IrValidationError extends Error {
  constructor(message: string, public readonly errors: { path: string; message: string }[]) {
    super(message);
    this.name = 'IrValidationError';
  }
}

export interface ParseResult {
  ok: boolean;
  scenario?: Scenario;
  /** 面向人的错误（含路径），Agent 的 repair 重试也喂这份 */
  errors: { path: string; message: string }[];
}

/**
 * 解析并校验 IR。zod 错误转成人可读路径（docs/03 §3 输出契约的基础）。
 *
 * 返回 `{ok, scenario?, errors}` 而非抛错：Agent 的 repair 重试要把 errors
 * 原样塞回 prompt，抛异常会让那条链路多一层 try/catch 且容易漏。
 * 需要「不合法就炸」的场合用 {@link defineScenario}。
 */
export function parseScenario(input: unknown): ParseResult {
  // 没写 targets 就按步骤补上。IR 里 targets 是**冗余字段**（唯一权威来源是
  // deriveTargets），让每个作者自己算一遍只会制造 targets 与步骤不一致的场景 ——
  // 那种不一致会让能力校验（这台设备能不能跑）给出错误答案。
  const prepared = isScenarioLike(input) ? withDerivedTargets(input) : input;
  const r = ScenarioSchema.safeParse(prepared);
  if (r.success) return { ok: true, scenario: r.data, errors: [] };
  return { ok: false, errors: humanize(r.error) };
}

function isScenarioLike(v: unknown): v is ScenarioDraft {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'body' in v && 'schemaVersion' in v;
}

/**
 * 定义一个场景，不合法就抛 IrValidationError。
 *
 * 与 parseScenario 的分工：**人在写**的东西用这个（SDK builder、CLI、单测夹具 ——
 * 写错了当场炸在作者手上），**机器产出的**东西用 parseScenario（Agent 生成、Excel 迁移 ——
 * 不合法是预期内的事，要拿 errors 去驱动修复重试而不是让流程崩掉）。
 */
export function defineScenario(draft: ScenarioDraft): Scenario {
  const r = parseScenario(draft);
  if (!r.ok || !r.scenario) {
    const where = r.errors[0] ? `（首个问题：${r.errors[0].path} → ${r.errors[0].message}）` : '';
    throw new IrValidationError(`场景不合法，共 ${r.errors.length} 处问题${where}`, r.errors);
  }
  return r.scenario;
}

export function humanize(err: ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({
    path: i.path.length ? i.path.join('.') : '(root)',
    message: i.message,
  }));
}
