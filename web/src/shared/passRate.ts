// 「小数 → 百分数」这一条算式的全仓唯一副本。
//
// 为什么要有这个文件：同一条 `Math.round(rate * 100)` 在四个文件里各写了一遍
// （PassRing 内部、reportDetail 概览卡外壳、同页的「通过率」描述项、两个计划详情页的
// ratePct）。副本本身不是 bug —— **两份算法可以各自都对**；bug 是第 6b 轮变异测试抓到的
// 那种：外壳算一份、环里算一份，断言钉在其中一份上，于是 mutate 另一份**全绿**。
// 「都从同一个函数取值」之后，那种分歧在源码层就不存在了，剩下的副本只是同一个值的
// 两次展示，改它必然同时改到另一处。
//
// 口径（业主裁定，勿改）：
// · 分母**已经在后端扣掉跳步**（判据 3：通过率 = passed ÷ total，total 不含 skip），
//   所以这里只做展示换算，**绝不拿 stats 的计数现攒一个率** —— 那是判据 2 禁止的重算。
// · null（分母 ≤0，全跳步/空集）不是 0%：0% 是结论，「-」是没结论。空值表达由调用方决定
//   （环画「-」、描述项画「—」、e2e 契约的 data-percent 画空串），故这里对 null 返回 ""，
//   把「怎么画空」留给界面，把「怎么算数」留在这里。
// · 四舍五入而非截断：0.666 → 67。这条是**能翻脸的**（截断给 66），故有测试钉。

/** 小数量成整数百分数（四舍五入）。传入前请确认非 null —— null 是「没结论」，不是 0。 */
export function ratePctNum(rate: number): number {
  return Math.round(rate * 100);
}

/** 带百分号的文案（`60%`）。null 不许进来：那一路该画「—」而不是「0%」。 */
export function ratePct(rate: number): string {
  return String(ratePctNum(rate)) + "%";
}

/**
 * data-percent 属性值：null → 空串（e2e 契约：`web/e2e/reports.spec.mjs` 在
 * `getByTestId("report-overview-pass-rate")` 上断言 data-percent，空值画空串是它钉的形状）。
 * 环与外壳两处都用它，两处才可能「逐字相等」—— 测试钉的是这个**相等关系**，
 * 比各钉一个字面量强：谁将来只改一处就会红。
 */
export function pctAttr(rate: number | null): string {
  return rate == null ? "" : String(ratePctNum(rate));
}
