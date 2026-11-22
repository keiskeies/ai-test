// step_graph 协议的前端镜像（设计 §7.4）：node/type 定义、KINDS、kindMeta。
// 纯数据模块：不 import React/DOM，供 graphOps 与画布/列表/属性面板共用。
// theme.ts 同为纯数据（零 import），引它不破坏这条约束。
// 后端 app/modules/scenario/graph.py 是最终真相；这里的常量只服务前端渲染与预检。
import { tpv } from "../theme";

/** §7.4 kind 全集（一期白名单 = 全集；ui_case 随 1C 开放（R111）、adb_case 随 1D 开放）。 */
export const KINDS = [
  "api_case", "ui_case", "adb_case", "http_direct", "sleep", "loop", "if", "foreach",
  "break", "continue", "script", "extract", "assert", "set_var", "group",
] as const;
export type Kind = (typeof KINDS)[number];

export const CONTAINER_KINDS = ["loop", "foreach", "if", "group"] as const;
export const REF_KINDS = ["api_case", "ui_case", "adb_case"] as const;
export const LOOP_KINDS = ["loop", "foreach"] as const;

/** 尚未开放的 kind（R48）：保存即报 issue，不能让场景跑到那一步才发现没人执行。
 * R111（1C）：ui_case 已摘——引擎 h_ui_case 注册且混合场景实跑过（后端 graph.py /
 * handlers.py 同口径）；R111 续（1D）：adb_case 摘——引擎 h_adb_case 注册，后端
 * graph.py BLOCKED 同口径清空。一期白名单开满，表留空但**不删**：这张表被
 * graphOps.validateLocal 与 Canvas 角标共用，二/三期新 kind 仍从这里拦。 */
export const BLOCKED_1B: Record<string, string> = {};

export const MAX_DEPTH = 10;
export const MAX_KEY_LENGTH = 64;
export const MAX_KEY_SEGMENTS = 10;
export const MAX_KEY_SEGMENT_LENGTH = 40;
export const MAX_EXPANSION = 500;

/** 画布坐标（layout 只影响画布可视位置，与执行语义无关，§7.4）。 */
export interface Pos {
  x: number;
  y: number;
}

/** 步骤节点（§7.4）：key/kind/name 必有，config/ref/children/disable 可选。 */
export interface StepNode {
  key: string;
  kind: Kind;
  name?: string;
  ref?: string;
  disable?: boolean | null;
  config?: Record<string, unknown> | null;
  /** 容器 children：数组顺序即执行顺序（§7.4）。if 的子节点在 config.branches[].children。 */
  children?: StepNode[] | null;
}

/** 画布坐标表：key → {x,y}；round-trip 时与 nodes 一同序列化。 */
export type LayoutMap = Record<string, Pos>;

/** if 分支的条件占位：「否则(else)」由后端 eval 语义兜底，是分支条件常量的真值。 */
export const ELSE_COND = "else";

/** 循环模式词表（§7.4 loop.config：mode count|while + cond + max_iter）。 */
export const LOOP_MODES = ["count", "while"] as const;

// §11.6.3 域色与循环/判断点缀色：全部引 theme.ts（§11.6 主题唯一真相），本文件不再手抄 hex。
// Domain 必须先声明再被 DOMAIN_COLORS 类型标注引用。
export type Domain = "api" | "ui" | "adb" | "logic";

const DOMAIN_COLORS: Record<Domain, string> = {
  api: tpv.domain.api,
  ui: tpv.domain.ui,
  adb: tpv.domain.adb,
  logic: tpv.domain.logic,
};
/** 循环/判断用各自点缀色（画布节点左边条仍用域色）。 */
const KIND_COLORS: Record<string, string> = {
  loop: tpv.func.processing,
  foreach: tpv.func.processing,
  if: tpv.func.warning,
};

const LABELS: Record<string, string> = {
  api_case: "API 用例",
  ui_case: "UI 用例",
  adb_case: "ADB 用例",
  http_direct: "HTTP 直连",
  sleep: "等待",
  loop: "循环",
  if: "判断",
  foreach: "遍历",
  break: "跳出循环",
  continue: "继续下一轮",
  script: "脚本",
  extract: "提取变量",
  assert: "断言",
  set_var: "设置变量",
  group: "分组",
};

const ICONS: Record<string, string> = {
  api_case: "api",
  ui_case: "ui",
  adb_case: "adb",
  http_direct: "link",
  sleep: "clock",
  loop: "loop",
  if: "branch",
  foreach: "repeat",
  break: "stop",
  continue: "forward",
  script: "script",
  extract: "export",
  assert: "check",
  set_var: "variable",
  group: "container",
};

/** kind 的展示面板：标签/域色/图标名/默认 config（§11.6.3 域色与 G6 图标命名）。 */
export interface KindMeta {
  kind: string;
  label: string;
  domain: Domain;
  color: string;
  icon: string;
  /** 容器 children 语义（§7.4）：普通容器走 children，if 走 config.branches[].children。 */
  containerKind?: "children" | "branches";
  defaultConfig: () => Record<string, unknown>;
}


/** kind → 元数据。未知 kind 也返回可读结果（保留 kind 原文），由 validateLocal 报 unknown_kind。 */
export function kindMeta(kind: string): KindMeta {
  const k = (KINDS as readonly string[]).includes(kind) ? (kind as Kind) : kind;
  const domain: Domain = k === "api_case" ? "api"
    : k === "ui_case" ? "ui"
    : k === "adb_case" ? "adb"
    : "logic";
  const defCfg = () => defaultConfigFor(kind);
  const meta: KindMeta = {
    kind,
    label: LABELS[k] ?? k,
    domain,
    color: KIND_COLORS[kind] ?? DOMAIN_COLORS[domain],
    icon: ICONS[k] ?? "step",
    defaultConfig: defCfg,
  };
  if (CONTAINER_KINDS.includes(k as never)) {
    meta.containerKind = k === "if" ? "branches" : "children";
  }
  return meta;
}

function defaultConfigFor(kind: string): Record<string, unknown> {
  // 给新建步骤一份可保存的底稿（缺的字段留给用户补，剩余校验由 validateLocal/后端兜底）
  switch (kind) {
    case "api_case": case "ui_case": case "adb_case":
      return { ref: "" };
    case "http_direct":
      return { method: "GET", url: "" };
    case "sleep":
      return { ms: 1000 };
    case "loop":
      return { mode: "count", cond: "", max_iter: 5 };
    case "if":
      return { branches: [{ cond: ELSE_COND, children: [] }] };
    case "foreach":
      return { list_var: "", item_var: "" };
    case "script":
      return { code: "" };
    case "extract":
      return { rules: [{ var: "", from: "last_response", expr: "" }] };
    case "assert":
      return { assertions: [{ type: "status_code", expected: 200 }] };
    case "set_var":
      return { vars: {} };
    default:
      return {};
  }
}

/** 按 kind 生成一个带默认 config 的步骤对象（key 由调用方指定以保证唯一）。 */
export function makeStep(kind: Kind): StepNode {
  const cfg = defaultConfigFor(kind);
  const node: StepNode = { key: "", kind, name: LABELS[kind] ?? kind };
  if (Object.keys(cfg).length > 0) node.config = cfg;
  return node;
}

/** kind → 中文标签（画布/列表/属性面板共用）。 */
export function labelOf(kind: Kind): string {
  return LABELS[kind] ?? kind;
}

export function domainOf(kind: string): Domain {
  return kindMeta(kind).domain;
}
