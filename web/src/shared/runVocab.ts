// 运行记录的展示词表（触发来源 / 状态）。
//
// 为什么单独一个文件而不是留在 runs.tsx 里：这两张表必须与后端的 Field(pattern=...)
// **逐字相等**，而 runs.tsx 拉了一堆 antd，node 环境的 vitest 导不动。抽成纯数据后
// vocab.test.ts 能直接从后端源码把 pattern 抠出来对一遍——这个漂移是实测出来的：
// 老 TRIGGERS 里有 `case`，后端 pattern（R46 起）根本不收，用户一选「用例」列表就 422，
// 页面演成「运行记录没取到」；反过来后端 T9 已经会写 queued/running/cancelled
// （enqueue / runner 写的），老 STATUSES 只有三终态，「运行中」既显示成生码也筛不出来。
import type { TagProps } from "antd";

export interface TriggerMeta {
  icon: string;
  label: string;
  color: TagProps["color"];
  /**
   * 词表认得、后端 Field(pattern=...) 也合法收，但当前**没有任何写入方**的预留值。
   * 带 reserved 的值只裁**筛选项**（页面查 SELECTABLE_TRIGGERS）——UI 不能承诺本系统里
   * 不会发生的事（§13 纪律 1 假门）。**徽标不裁**：徽标报的是已经发生的事，库里存了
   * 就得照实画（口径见 reports.tsx 的 TriggerTag 注释）。
   */
  reserved?: boolean;
}

/** 触发来源：一眼分清「人点的」还是「Pilot 干的」（§11.4.34）。 */
export const TRIGGERS: Record<string, TriggerMeta> = {
  debug: { icon: "✎", label: "调试", color: "blue" },
  manual: { icon: "▶", label: "手动", color: "cyan" },
  schedule: { icon: "◷", label: "定时", color: "geekblue" },
  agent: { icon: "✦", label: "Pilot", color: "purple" },
  // reserved 的 WHY（D82）：后端 /runs 筛选的 pattern 合法收 webhook（数据契约，不动），
  // 但全仓零写入方——触发端点 /hook/run/{token} 还不存在，写入方是 §12.4 一期 run-hook，
  // 待业主裁 D82。在那之前 UI 摆出「⇢ Webhook」筛选项就是假门：点它必是空表。
  // **D82 批准且 run-hook 真落地那天：删掉这里的 reserved: true 即可**——下拉自动回来，
  // 页面代码不用改；届时本注释按那天的事实重写，不许留着骗下一个读代码的人。
  webhook: { icon: "⇢", label: "Webhook", color: "gold", reserved: true },
};

/**
 * 「可承诺」子集：筛选项与徽标只从这里取（reports.tsx）。TRIGGERS 本体必须与后端
 * pattern 逐字相等（runVocab.test.ts 钉的是数据契约），这里只裁 UI 的承诺面；
 * reserved/未知值落到各页徽标既有的 `?? { icon: "?", label: v }` 降级——渲染原文，
 * 不编友好标签（口径同 SUBJECT_TYPES 对 inline 的处理：宁可生码，不可撒谎）。
 * 各页徽标的降级都带 label=原文：runs/reports/reportDetail 连 icon 一起降级成 "?"，
 * workbench 的触发徽标本来就不画 icon，只降 label（第 26 轮补：它此前对未知值整个
 * 不渲染 Tag，把库里存着的触发方式静默吞掉，注释与实现不符已修平）。
 */
export const SELECTABLE_TRIGGERS: Record<string, TriggerMeta> = Object.fromEntries(
  Object.entries(TRIGGERS).filter(([, m]) => !m.reserved),
);

/**
 * 运行状态。六态是 T9 的事实：queued/running 由 enqueue 写入，cancelled 由 runner 写入，
 * 三终态是 1A 就有的。**别按后端 pattern 的字母序排**——筛选项按生命周期排更好读。
 */
export const STATUSES: Record<string, { label: string; color: TagProps["color"] }> = {
  queued: { label: "排队中", color: "default" },
  running: { label: "运行中", color: "processing" },
  passed: { label: "通过", color: "green" },
  failed: { label: "断言失败", color: "orange" },
  error: { label: "请求失败", color: "red" },
  cancelled: { label: "已取消", color: "default" },
};

/**
 * 步骤状态：与运行状态是**两套词表**（引擎给 run 写 passed/failed，给 step 发
 * pass/fail，见 engine/events.py），别把 STATUSES 复用过来。数据源是 SSE step/*
 * 事件的类型名与 report 步骤行 status。
 */
export const STEP_STATUSES: Record<string, { label: string; color: TagProps["color"] }> = {
  running: { label: "执行中", color: "processing" },
  pass: { label: "通过", color: "green" },
  fail: { label: "断言失败", color: "orange" },
  skip: { label: "跳过", color: "default" },
  error: { label: "请求失败", color: "red" },
  cancelled: { label: "已取消", color: "default" },
};

/**
 * 运行对象类型（R112）。1A 时代 runs.tsx 写的是二值三元
 * `subject_type === "api_case" ? "用例" : "接口"`——一条 ui_case 运行会被贴成「接口」，
 * 那是**主动说错**，不是没说。查不到这个词表时**渲染原文**（比如 api_debug 裸请求
 * 写的 inline），绝不回落成「接口」：宁可生码，不可撒谎。
 * 五个词表值与后端 SUBJECT_TYPE_PATTERN（execution/services.py）同源，
 * runVocab.test.ts 从后端源码抠 pattern 对表。
 */
export const SUBJECT_TYPES: Record<string, { label: string; color: TagProps["color"] }> = {
  api_definition: { label: "接口", color: "blue" },
  api_case: { label: "用例", color: "cyan" },
  scenario: { label: "场景", color: "purple" },
  ui_case: { label: "UI 用例", color: "green" },
  adb_case: { label: "ADB 用例", color: "volcano" },
};

/**
 * 计划关联词表（D204）：在运行态词表上多一个 functional_case。
 *
 * **不并进 SUBJECT_TYPES**：那份词表与执行域 `subject_type` pattern 逐字对表
 * （runVocab.test.ts 从后端源码抠值），功能用例是人工执行、不写 run_record，
 * 后端 pattern 里没有它；并进去会让那条对表测试红，也会让运行列表「筛选对象类型」
 * 多出一个永远筛不出东西的选项。计划侧用自己的叠加词表，两处各自诚实。
 */
export const PLAN_SUBJECT_TYPES: Record<string, { label: string; color: TagProps["color"] }> = {
  ...SUBJECT_TYPES,
  functional_case: { label: "功能用例", color: "magenta" },
};

/**
 * 测试计划展示态（D183 步 6a）。四态与后端 testplan/schemas.py 的 PLAN_DISPLAY_STATUSES
 * 元组**逐字同源**（runVocab.test.ts 从后端源码抠出来对表）；产出口是 services._plan_display
 * ——库里没有这一列，每次查询现算。两个口径要记着：
 * ① total=0 的计划是 not_started：空计划「全部通过」是空真，报 completed 就是说谎；
 * ② **列表端点（PlanOut）没有这个字段**——只有 GET /plans/{id}/status（现算）与
 *    计划报告（生成时刻定格）携带它。列表页只许画 archived 这个真实布尔，不许逐行拉状态。
 */
export const PLAN_DISPLAY: Record<string, { label: string; color: TagProps["color"] }> = {
  archived: { label: "已归档", color: "default" },
  not_started: { label: "未开始", color: "default" },
  completed: { label: "已完成", color: "green" },
  in_progress: { label: "进行中", color: "processing" },
};

/**
 * 计划关联（plan case link）的现算结果：三值与后端 LINK_RESULTS 同源。
 * 保守口径（services._link_result）：终态里出现过 failed/error 即 failed；
 * queued/running **不进这个枚举**——把非 passed 当失败才是撒谎。
 */
export const LINK_RESULTS: Record<string, { label: string; color: TagProps["color"] }> = {
  none: { label: "未执行", color: "default" },
  passed: { label: "通过", color: "green" },
  failed: { label: "未通过", color: "red" },
};

/**
 * 查表的统一兜底（R112）：后端从没发过的值**渲染原文**，绝不回落成友好标签——
 * 把没见过的东西演成「认识的话」是说谎，渲染生码才诚实且可诊断（各表注释里记的
 * 都是实际发生过的谎）。此前各调用点手写 `?? { label: v, … }`（徽标 9 处 +
 * `.label`-only 与并行的 `?? { color: "default" }` 成对 4+4 处），同一条纪律抄了
 * 十几遍，改口径时要人肉找齐——收敛到这里一处。
 *
 * 签名只承诺 `{ label; color }`，两类调用点共同决定它：
 * ① 徽标点消费 label+color（`<Tag color={m.color}>{m.label}</Tag>`）；
 * ② `.label`-only 点（右侧详情/命令行 Tag）的 color 由并行的
 *    `?? { color: "default" }` 查表供——兜底值与这里逐字相同，合成一次查表
 *    后渲染逐字节不变。
 * 入参接受更宽的表：TRIGGERS（TriggerMeta 带 icon/reserved）结构上可传，但返回
 * 收口成 label+color，调用方拿不到 icon——带 `icon: "?"` 的触发徽标降级走的是
 * 「陌生触发要看得出陌生」另一套纪律（见 SELECTABLE_TRIGGERS 注释），不归这里。
 * `color: "default"` 不需要 `as const`：声明的返回类型 TagProps["color"] 就是
 * 上下文类型，字面量被它收窄——原调用点上那些 `as const` 全是这份声明的重复。
 */
export function vocabMeta(
  table: Record<string, { label: string; color: TagProps["color"] }>,
  v: string,
): { label: string; color: TagProps["color"] } {
  return table[v] ?? { label: v, color: "default" };
}
