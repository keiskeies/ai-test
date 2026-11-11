/**
 * 状态 → 人话与图标。**状态的枚举本身不在这里** —— 它 import 自 `@atest/ir`。
 *
 * ## 为什么这个文件必须存在，而且必须 import 而不是照抄
 *
 * docs/13 §6 最后一条把这件事写成硬约束：
 * 「状态机色板进 IR/引擎 —— 六态与引擎 trace.jsonl 的 status 枚举**同一个 TS 常量**，
 * 放 `packages/ir`；**本文件禁止被前端复制粘贴，只能被 import**」。
 * 后果说得很直白：前端叫 healed、引擎叫 auto-fixed，报表就对不上，
 * 而「healed 不算绿」正是整个平台红绿可信的支点。
 *
 * 这个约束在本仓**有载体**（`packages/ir/src/status.ts` 的 `STEP_STATUS`），
 * 而"载体存在"不等于"前端真的读了它" —— 那正是 docs/08 §3 那一族缺陷的
 * 前端版（有字段、有测试、没有载体 / 有生产者没有消费者）。
 * 所以下面 `STATUS_ICON` 的键**由 STEP_STATUS 反推**：
 * 少一个状态，`Record<StepStatus, …>` 在编译期就不通过；
 * 多抄一个引擎没有的状态，同样编译不过。**两个方向都是编译错误，不是 review 意见。**
 *
 * ## 三重编码（色 + 图标 + 文字）在这里凑齐
 *
 * 颜色在 `styles.ts`（且只走 token 变量），图标与文字在这一格。
 * 三条中任意一条单独失效都不该丢信息：色盲看图标、灰度打印看文字、
 * 截图转发三者都在。所以 `describeStatus()` 是这一格唯一的出口，
 * 页面不许自己拼"通过"/"失败"这种字符串 —— 那就是第二份真相。
 */
import type { StepStatus } from '@atest/ir';

/**
 * 图标。**只用这几个字符，不引图标库**：
 * 前端不经打包器（本机无外网，装不上 @ant-design/icons），
 * 而自绘一套图标在 docs/13 §7.1 的"明确不做"名单上（没有设计师时它必然显廉价）。
 * 这几个符号在等宽字体里宽度一致，灰度打印也分得开 —— 这是它们被选中的实际原因。
 */
const STATUS_ICON: Record<StepStatus, string> = {
  pass: '✓',
  fail: '✗',
  error: '!',
  healed: '⚕',
  skipped: '⊘',
  triaged: '◐',
};

/** 每个状态旁边那句人话。写的是"下一步该查哪儿"，不是状态的近义词 */
const STATUS_LABEL: Record<StepStatus, string> = {
  pass: '通过',
  fail: '失败',
  error: '执行异常',
  healed: '自愈待审',
  skipped: '跳过',
  triaged: '待人工确认',
};

/**
 * 归因（`RunReport` 里的 `cause`）→ 一句"该查哪儿"。
 *
 * 为什么单列：docs/12 §4.2 要求"每个 fail 必须带归因"，而 `fail` 与 `error`
 * 的区别**只有归因说出来了才有用** —— 否则人会去查产品，而真相是环境。
 * 这一格不做任何判定，只做查表：判定在引擎，这里说什么都不该反过来影响结论。
 */
const CAUSE_HINT: Record<string, string> = {
  'product-bug': '被测产品的问题',
  'env-unavailable': '环境问题（服务/设备/密钥），不是用例失败',
  'case-stale': '用例可能过期（IR 与被测系统对不上），改用例',
  'locator-unstable': '定位器不稳，看自愈记录',
  'flaky': '结论不稳定，看这个场景的历史 run',
};

export interface StatusView {
  status: StepStatus;
  icon: string;
  label: string;
}

export function describeStatus(status: StepStatus): StatusView {
  return { status, icon: STATUS_ICON[status], label: STATUS_LABEL[status] };
}

/** 归因那句提示。取不到时返回 undefined，由调用方决定"不知道"怎么显示 —— 不编一句 */
export function causeHint(cause: string | undefined): string | undefined {
  return cause === undefined ? undefined : CAUSE_HINT[cause];
}

/** 导出给页面用：让页面能遍历"全部六态"而不必自己写那六个字（同一格判据不留第二份） */
export { STATUS_ICON, STATUS_LABEL };
