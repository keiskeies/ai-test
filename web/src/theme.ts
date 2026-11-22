// §11.6 视觉 Token 唯一真相（浅色 + 深色两套映射；深色于 2026-11-21 设计系统改版落地）。
//
// 结构改动（相对旧版）：① 每个色组在浅/深两套里同名同形，只换值——「深色只换映射不改名」
// 从口号变成类型（tpDark 与 tp 同形）；② 新增 tag / radius / fontSize 三组，把「圆角 2/4/6/8/10
// 并存」「内联 fontSize: 12 ×292 处」「antd 预设 Tag 色 #f6ffed 撞灰绿底」三件粗糙事收进 Token；
// ③ 结构尺寸（顶栏 56 / 侧栏 208 / 页边距 24）不在这里——它们只在 styles.css 的 --tp-metric-*
// 声明一次，TS 侧不再抄第二份（漂移由 theme.drift.test.ts 对着本文件的 metrics 对表）。
//
// 手抄棘轮（theme.tokens.test.ts）的计数口径不变：本文件里的 hex 都是「已被 sanction 的值」，
// 别处再写一份就计入手抄。新增 tag 组会让此前算「野色」的几个值（如 #D6E4FF）变成 Token——
// 那些字面量随本轮改版逐处改引 Token，棘轮基线按改版后的实测值重钉（只减不增仍然成立）。
import type { ThemeMode } from "./ui/themeMode";

export const tp = {
  primary: {
    50: "#EAF6F1", 100: "#D6ECE2", 200: "#ABD9C7", 300: "#7CC3A6", 400: "#52B391",
    500: "#2BA47D", 600: "#1D7257", 700: "#175A45", 800: "#124636", 900: "#0D3427",
  },
  func: {
    success: "#1D7257", successBg: "#EAF6F1",
    processing: "#4C86E8", processingBg: "#EDF3FE",
    // warning/error 与 tag 组同值原则：浅底徽标文字要 ≥4.5，#D48806/#D3564F 在
    // 各自浅底上只有 2.6/3.5，字色一并下沉（bg 不变，色相不变）。
    warning: "#9A6404", warningBg: "#FDF4E3",
    error: "#B03A33", errorBg: "#FBEBEA",
    skip: "#8B8E94", skipBg: "#F2F3F4",
    notRun: "#C0C6CC",
  },
  // 功能域色（§11.6.3）：画布左边条/域标签都从这里取。
  // logic 与 skip 同值（#8B8E94）但**语义不同**——一个是「这是逻辑控件」，一个是「这步没跑」，
  // 所以分两个键而不是互相引用；改一个不该悄悄改掉另一个。
  domain: { api: "#5B8FF9", ui: "#9270CA", adb: "#47A861", logic: "#8B8E94", pilot: "#13A8A8" },
  code: { bg: "#151C24", border: "#2A343E", text: "#E7EBEE", subtle: "#94A2AE" },
  // text-3 两轮加深（#8A949E → #6B7680 → 现值）：表头/分组标题/描述都吃这个 token，
  // 原值在浅底只有 2.9:1。现值是按**最暗的常用底**反解的——layout #F6F8F7 与选中底
  // #EAF6F1 上分别是 4.73 / 4.56，全 surface 过 4.5（上一版 #6B7680 在 hover 底只有 4.25）。
  // text-4 保持「禁用/极弱提示」不参与正文对比。
  text: { 1: "#1F2833", 2: "#5F6B76", 3: "#667079", 4: "#B4BBC2" },
  bg: {
    layout: "#F6F8F7", container: "#FFFFFF", elevated: "#FFFFFF", tableHead: "#FAFBFB",
    hover: "#F2F6F4", selected: "#EAF6F1",
  },
  // 中性线同样按底反解：边框在**最深的容器底**（hover/selected 绿相底）上也 ≥1.3，
  // 否则卡片/输入框的边在带色区块里直接消失（实测旧值 #D8DFE4 在 selected 底 1.22）。
  split: "#DCE1E6", border: "#CDD5DB", borderHover: "#B9C2CA", mask: "rgba(31,40,51,.45)",
  /**
   * 状态徽标「浅底 + 深字 + 同相描边」（§11.6.2 的落地形态）。
   * 键名对齐 antd Tag 的预设色名：既有 35 处 `color="green"` 之类的调用点**不改**，
   * 由 styles.css 把 .ant-tag-<preset> 映射到这些值——改色相不再是全站扫一遍的机械改动。
   */
  tag: {
    green: { fg: "#1D7257", bg: "#EAF6F1", bd: "#C5DCD4" },
    cyan: { fg: "#0F7C7C", bg: "#E6F7F7", bd: "#BFDDDD" },
    blue: { fg: "#3568C9", bg: "#EDF3FE", bd: "#CAD7EF" },
    geekblue: { fg: "#3F5FD0", bg: "#EEF1FD", bd: "#CED4ED" },
    purple: { fg: "#7A55B5", bg: "#F3EEFB", bd: "#D9D0E9" },
    magenta: { fg: "#B03B8F", bg: "#FBEFF7", bd: "#E9CEE1" },
    gold: { fg: "#9A6404", bg: "#FDF4E3", bd: "#E9D6B5" },
    orange: { fg: "#9A4B00", bg: "#FDF0E3", bd: "#EBD1B9" },
    volcano: { fg: "#98362F", bg: "#FBEBEA", bd: "#EACCC9" },
    red: { fg: "#B03A33", bg: "#FBEBEA", bd: "#ECCBCA" },
    default: { fg: "#5F6B76", bg: "#F2F3F4", bd: "#D4D7D9" },
  },
  chart: ["#2BA47D", "#5B8FF9", "#9270CA", "#D48806", "#47A861", "#13A8A8", "#D3564F", "#8B8E94"],
  font: "-apple-system, PingFang SC, HarmonyOS Sans SC, Microsoft YaHei, sans-serif",
  mono: "JetBrains Mono, Consolas, monospace",
  /** 圆角角色表（§11.6.6）：2 微标 / 4 标签 / 6 控件 / 8 卡片 / 10 浮层 / 12 大面 / 999 胶囊。 */
  radius: { xs: 2, sm: 4, md: 6, lg: 8, xl: 10, xxl: 12, pill: 999 },
  /** 字号阶梯（§11.6.6）：11 角标 / 12 辅助 / 13 表格控件 / 14 正文 / 16 区块 / 20 页标题 / 24 数值。 */
  fontSize: { xs: 11, sm: 12, md: 13, base: 14, lg: 16, xl: 20, xxl: 24 },
  shadow: {
    s1: "0 1px 2px rgba(16,24,40,.05)",
    s2: "0 4px 12px rgba(16,24,40,.08)",
    s3: "0 12px 32px rgba(16,24,40,.14)",
  },
};

/**
 * 深色映射。与 tp **同形**：键一个不多一个不少（type 钉住），值按「深底浅字」重取。
 * 主色不动色相（青竹绿），只把可点击态提亮到 400/300 一档——深底上 600 号小字对比不足。
 * 状态色同相提亮，保证与浅色主题「同一个绿/橙/红」的辨识不断档。
 */
// `typeof tp` 是刻意的同形约束：漏一个键/多一个键在这里编译不过，
// 不必等两套主题各自漂（值都比 as const 宽，字面量精度在这里没有用处）。
export const tpDark: typeof tp = {
  ...tp,
  func: {
    success: "#5BC49C", successBg: "rgba(91,196,156,.14)",
    processing: "#7FA8F5", processingBg: "rgba(127,168,245,.14)",
    warning: "#E8B44A", warningBg: "rgba(232,180,74,.14)",
    error: "#F08B84", errorBg: "rgba(240,139,132,.14)",
    skip: "#9AA6AF", skipBg: "rgba(154,166,175,.12)",
    notRun: "#5A646C",
  },
  domain: { api: "#7FA8F5", ui: "#BBA3E8", adb: "#6FC98A", logic: "#9AA6AF", pilot: "#4FC9C9" },
  code: { bg: "#0A0F13", border: "#1E282F", text: "#E7EBEE", subtle: "#8A98A3" },
  text: { 1: "#E6EAED", 2: "#A7B2BA", 3: "#8C99A4", 4: "#5A646C" },
  bg: {
    layout: "#0F1418", container: "#161C21", elevated: "#1B232A", tableHead: "#1B232A",
    hover: "#1C242A", selected: "#122A23",
  },
  split: "#2C3740", border: "#39464F", borderHover: "#4C5B66", mask: "rgba(4,8,10,.62)",
  tag: {
    green: { fg: "#6FD3AC", bg: "#112A22", bd: "#1C3F33" },
    cyan: { fg: "#59D3D3", bg: "#0E2A2A", bd: "#173F3F" },
    blue: { fg: "#8AB0F2", bg: "#15233A", bd: "#253753" },
    geekblue: { fg: "#93A8F0", bg: "#1A2140", bd: "#2B3459" },
    purple: { fg: "#BBA3E8", bg: "#231B33", bd: "#382E4C" },
    magenta: { fg: "#E58FC8", bg: "#2B1626", bd: "#46283D" },
    gold: { fg: "#E8B44A", bg: "#2A2110", bd: "#423417" },
    orange: { fg: "#EE9A55", bg: "#2B1C10", bd: "#462E1A" },
    volcano: { fg: "#EF7F72", bg: "#2D1817", bd: "#4C2825" },
    red: { fg: "#F08B84", bg: "#2C1716", bd: "#492826" },
    default: { fg: "#9AA6AF", bg: "#1E262C", bd: "#30393F" },
  },
  shadow: {
    s1: "0 1px 2px rgba(0,0,0,.40)",
    s2: "0 4px 12px rgba(0,0,0,.45)",
    s3: "0 12px 32px rgba(0,0,0,.55)",
  },
};

/**
 * 结构尺寸（单数真相）。CSS 侧以 `--tp-metric-*` 声明（kebab-case），
 * theme.drift.test.ts 逐项对表——改顶栏高度只改这里，样式表跟着走。
 */
export const metrics = {
  topbarH: 56,
  siderW: 208,
  siderCollapsedW: 56,
  pageMax: 1600,
  pagePad: 24,
  pageHeadH: 56,
  controlH: 32,
};

export function tokensFor(mode: ThemeMode): typeof tp {
  return mode === "dark" ? tpDark : tp;
}

/**
 * DOM 内联样式用的**变量形态**：键与 tp 完全一致，值是 `var(--tp-…)`。
 *
 * 为什么需要两份：tp 是具体 hex，深色下不会变——组件把它写进 `style` 就永远显示
 * 浅色主题的颜色（暗底黑字、白卡片）。而 ECharts / 画布导出这类要把颜色交给
 * 第三方渲染器的地方又必须拿到**具体值**（canvas 不认 CSS 变量）。
 * 于是约定：
 *   · React 的 style/className 场景 → `tpv.*`（跟随主题切换）
 *   · 图表配置、需要算术的颜色 → `tp.*` / `tokensFor(mode).*`（具体值）
 * 代码块（tp.code）是刻意的深底，浅色主题下也深，不参与此约定。
 */
export const tpv = {
  primary: {
    50: "var(--tp-primary-50)", 100: "var(--tp-primary-100)", 200: "var(--tp-primary-200)",
    300: "var(--tp-primary-300)", 400: "var(--tp-primary-400)", 500: "var(--tp-primary-500)",
    600: "var(--tp-primary-600)", 700: "var(--tp-primary-700)", 800: "var(--tp-primary-800)",
    900: "var(--tp-primary-900)",
  },
  func: {
    success: "var(--tp-func-success)", successBg: "var(--tp-tag-green-bg)",
    processing: "var(--tp-func-processing)", processingBg: "var(--tp-tag-blue-bg)",
    warning: "var(--tp-func-warning)", warningBg: "var(--tp-tag-gold-bg)",
    error: "var(--tp-func-error)", errorBg: "var(--tp-tag-red-bg)",
    skip: "var(--tp-text-3)", skipBg: "var(--tp-bg-hover)",
    notRun: "var(--tp-text-4)",
  },
  domain: {
    api: "var(--tp-domain-api)", ui: "var(--tp-domain-ui)", adb: "var(--tp-domain-adb)",
    logic: "var(--tp-domain-logic)", pilot: "var(--tp-domain-pilot)",
  },
  text: { 1: "var(--tp-text-1)", 2: "var(--tp-text-2)", 3: "var(--tp-text-3)", 4: "var(--tp-text-4)" },
  bg: {
    layout: "var(--tp-bg-layout)", container: "var(--tp-bg-container)", elevated: "var(--tp-bg-elevated)",
    tableHead: "var(--tp-bg-table-head)", hover: "var(--tp-bg-hover)", selected: "var(--tp-bg-selected)",
  },
  split: "var(--tp-split)", border: "var(--tp-border)", borderHover: "var(--tp-border-hover)", mask: "var(--tp-mask)",
  radius: tp.radius,
  fontSize: tp.fontSize,
  shadow: {
    s1: "var(--tp-shadow-s1)", s2: "var(--tp-shadow-s2)", s3: "var(--tp-shadow-s3)",
  },
} as const;

/**
 * HTTP 方法徽标色（§11.6.3「HTTP 方法」行）——唯一一份，`api.tsx` 与 `ImportWizard.tsx`
 * 此前各抄一份一模一样的表。值是 antd Tag 预设色名而不是 hex：换成 hex 属于观感改动，
 * 已登记为 1G 计划 D48-c 待业主裁——**这里只做去重，不改色相**（色相现由 tag 组统一校准）。
 */
export const METHOD_TAG: Record<string, string> = {
  GET: "green", POST: "blue", PUT: "orange", DELETE: "red", PATCH: "purple",
};