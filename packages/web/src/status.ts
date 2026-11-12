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

/*
 * 这里**曾经有一份 `CAUSE_HINT`（归因 → 一句"该查哪儿"）加一个 `causeHint()`**，
 * 本轮删掉 —— 它不是"暂时没接上"，是**一份过期了的第二份真相**：
 *  ① 零消费者（全仓除声明处外零提及，测试也没提过），页面用的是 report.html 那条路；
 *  ② 它的键与 `FAILURE_CAUSE` 已经对不上：枚举里是 `locator-stale`，这里写着
 *     `locator-unstable`，另外 `data-conflict` / `untriaged` 两格压根没有。
 *     于是 `causeHint('locator-stale')` 会**安静地返回 undefined** ——
 *     而 `causeHint` 的注释自己写着"取不到时返回 undefined，由调用方决定怎么显示 ——
 *     不编一句"，所以症状是那一格凭空少一行，不是报错。
 *     **一份没人读的过期词表，比没有词表更坏**：下一个人会以为归因文案已经统一了。
 *
 * 活的那一份在 `engine/src/html.ts` 的 `CAUSE_LABEL`（7 格齐全），载体是
 * `engine/test/error-cause.test.ts` 里那条**逐个枚举值渲染一遍**的测试 ——
 * 它判的是"渲染出来的那一格文本"，不是"表里有没有这个键"，所以词表与枚举对不上时它会红。
 * docs/12 §4.2 要的"每个 fail 必须带归因"由 report.html 满足；页面运行记录那一行
 * 直接链到报告。**如果将来要在页面上自己渲染归因，去复用 CAUSE_LABEL（导出它），
 * 别再抄一份。**
 */

export interface StatusView {
  status: StepStatus;
  icon: string;
  label: string;
}

export function describeStatus(status: StepStatus): StatusView {
  return { status, icon: STATUS_ICON[status], label: STATUS_LABEL[status] };
}

/** 导出给页面用：让页面能遍历"全部六态"而不必自己写那六个字（同一格判据不留第二份） */
export { STATUS_ICON, STATUS_LABEL };
