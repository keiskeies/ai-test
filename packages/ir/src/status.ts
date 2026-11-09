/**
 * 运行状态机 —— **引擎与前端共用的唯一常量源**（docs/13 §6 最后一条）。
 *
 * 这条不一致会直接腐蚀平台可信度：前端叫 healed、引擎叫 auto-fixed，
 * 报表就对不上，而「healed 不算绿」正是整个平台红绿可信的支点。
 * 因此本文件禁止被前端复制粘贴，只能被 import。
 */
import { z } from 'zod';

/** 步骤/断言的终态。语义区分是设计，不是实现细节。 */
export const STEP_STATUS = [
  /** 通过 */
  'pass',
  /** 断言不成立 —— 被测系统的问题 */
  'fail',
  /** 执行异常（超时/网络/设备丢失/引擎错误）。**必须与 fail 区分**：环境问题不是产品 bug */
  'error',
  /** 自愈后通过，尚未「毕业」（要求一次未自愈重跑）。**不许显示成绿**（docs/00 §5.6） */
  'healed',
  /** 前置不满足 / 无可用设备 / 被显式跳过。**不算失败**（docs/05 §5） */
  'skipped',
  /** 首轮待人工确认的策略产物，**不计入通过率**（docs/05 §3） */
  'triaged',
] as const;
export const StepStatusSchema = z.enum(STEP_STATUS);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/** 执行中的瞬时态（不会作为终态落盘） */
export const RUNTIME_STATUS = ['pending', 'running', 'cancelling'] as const;
export const RuntimeStatusSchema = z.enum(RUNTIME_STATUS);
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

/** 运行整体的状态：步骤状态 + 运行特有的 started/cancelled */
export const RUN_STATUS = ['started', 'running', ...STEP_STATUS, 'cancelled'] as const;
export const RunStatusSchema = z.enum(RUN_STATUS);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * 失败归因（docs/12 §4.2 要求「每个 fail 必须带归因，归因不明不许关闭」）。
 * 这份分类同时决定 skipped/failed 的判据与 flaky 看板的数据质量。
 */
export const FAILURE_CAUSE = [
  /** 被测系统真有缺陷 */
  'product-bug',
  /** 用例/定位器/断言已过期（spec 变更或改版） */
  'case-stale',
  /** 环境不可用：无设备、服务未起、凭证失效 */
  'env-unavailable',
  /** 定位失效（自愈已尝试或未尝试） */
  'locator-stale',
  /** 数据冲突：共享环境被他人改动 / 唯一约束 / 迭代互踩 */
  'data-conflict',
  /** 已知不稳定（重跑即通过） */
  'flaky',
  /** 未归因 —— 只允许出现在「刚失败」的瞬间，归档前必须改掉 */
  'untriaged',
] as const;
export const FailureCauseSchema = z.enum(FAILURE_CAUSE);
export type FailureCause = z.infer<typeof FailureCauseSchema>;

/**
 * 计入通过率分母的判定。集中在一处，避免各报表各算一遍（docs/13 §6）。
 *
 * 刻意包含 `healed`：未毕业的自愈**留在分母里但不算通过**，所以会拉低通过率。
 * 若把 healed 从分母剔除，未审校的改动就会从指标里静默消失 —— 报表变好看、
 * 风险原地不动。这是「红绿必须可信」的量化形式。
 * 排除 `triaged`（首轮待确认，本身不该影响门禁）与 `skipped`（环境未具备条件）。
 */
export function countsTowardPassRate(status: StepStatus | RunStatus): boolean {
  return status === 'pass' || status === 'fail' || status === 'error' || status === 'healed';
}
export function isPassing(status: StepStatus | RunStatus): boolean {
  return status === 'pass';
}
