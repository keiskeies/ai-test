// UI 调试载荷的纯换算件（T17）：把后端 UiDebugOut 摊平成界面直接渲染的行。
// 纯模块（无 React/DOM）——node 环境 vitest 可测，与 commands.ts 同一纪律。
// 后端形状的事实源（debug_services.py:475 UiDebugOut / ui_core._row_cmd）：
//   commands[] = {id,type,status,message,elapsed_ms,assertions,detail}
//   artifacts[] = {kind,step_key,ref,bytes,reason}，ref 是 {run_id}/{name} 相对路径
// R108：断言行 {type,passed,expected,actual,error,path} 直接进 api/DebugPanel，这里只收集不改写。
// 命令中文名只有一张表（commands.ts 的 LABELS，与后端 _LABELS 同源），这里 import 不重抄。
import { LABELS as CMD_LABELS } from "./commands";
import { LABELS as ADB_CMD_LABELS } from "../adb/commands";

/** 与后端 UiDebugOut 手写镜像（schema.d.ts 的 POST 响应是 unknown，照 ui.ts 的 Page 同法）。 */
export interface UiDebugResult {
  run_id: string;
  status: string; // passed/failed/error/cancelled
  ok: boolean;
  passed: boolean;
  elapsed_ms: number;
  error: string | null;
  env_name: string | null;
  vars: Record<string, string>;
  commands: Record<string, unknown>[];
  artifacts: UiArtifactRef[];
}

export interface UiArtifactRef {
  kind: string; // SCREENSHOT / DOM
  step_key: string;
  ref: string;
  bytes: number;
  reason?: string | null;
}

/** ref "{run_id}/{name}" → fetchArtifactBlob 要的 name（ref 前缀就是 run 目录，不猜第二套拼法）。 */
export function artifactName(ref: string): string {
  const i = ref.lastIndexOf("/");
  return i >= 0 ? ref.slice(i + 1) : ref;
}

export interface ShotRow {
  name: string;
  reason: string;
}

/** 按命令行归组的截图（step_key = 命令 id，R102）；DOM 快照不进这里（不是图）。 */
export function shotsByStep(artifacts: UiArtifactRef[]): Record<string, ShotRow[]> {
  const map: Record<string, ShotRow[]> = {};
  for (const a of artifacts ?? []) {
    if (!a || a.kind !== "SCREENSHOT" || typeof a.ref !== "string" || a.ref === "") continue;
    const key = String(a.step_key ?? "?");
    (map[key] ??= []).push({ name: artifactName(a.ref), reason: String(a.reason ?? "截图") });
  }
  return map;
}

/**
 * 报告侧（step detail 的 detail.artifacts 摘要）截图 → 按**命令 id** 归组。
 * 制品 key 有两种实测形状，这里都落到同一行组：
 *   · 独立 UI 运行：_execute_ui_run 直接按命令 id 落 step_key，摘要没有 command 键；
 *   · 场景内 ui_case：h_ui_case 按画布步骤 key 落 step_key（保证报告制品区按步骤对得上号），
 *     命令 id 留在摘要的 command 键里保 provenance。
 * （golden test_golden_1c 的两段制品断言是这两种形状的事实源。）
 */
export function shotsByCommand(
  artifacts: Array<UiArtifactRef & { command?: string | null }>,
): Record<string, ShotRow[]> {
  return shotsByStep((artifacts ?? []).map((a) => (
    a && typeof a.command === "string" && a.command !== ""
      ? { ...a, step_key: a.command }
      : a
  )));
}

/** 收集全部断言行（保持命令行顺序；R108 形状原样透传，不改键名）。 */
export function assertionRows(commands: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const c of commands ?? []) {
    const rows = c?.assertions;
    if (Array.isArray(rows)) out.push(...(rows as Record<string, unknown>[]));
  }
  return out;
}

/** 命令行 → 可渲染行；对缺键的畸形载荷也给出行（显示 "?"），绝不抛。 */
export interface DebugCmdRow {
  id: string;
  type: string;
  status: string;
  message: string;
  elapsed_ms: number;
  assertions: number;
}

export function cmdRows(commands: Record<string, unknown>[]): DebugCmdRow[] {
  return (commands ?? []).map((c, i) => ({
    id: typeof c?.id === "string" && c.id !== "" ? c.id : "?" + (i + 1),
    type: typeof c?.type === "string" ? c.type : "?",
    status: typeof c?.status === "string" ? c.status : "error",
    message: typeof c?.message === "string" ? c.message : "",
    elapsed_ms: typeof c?.elapsed_ms === "number" ? c.elapsed_ms : 0,
    assertions: Array.isArray(c?.assertions) ? (c.assertions as unknown[]).length : 0,
  }));
}

/**
 * 命令行几何（时间线一行的列宽）。此前同样的四个数字在 UiDebugPanel、AdbDebugPanel、
 * reportDetail 各抄一份，缩进 54 也抄三份——改一列宽要记得改三处，迟早分叉。
 * indent = 命令 id 列 48 + 行内左右 padding 8（截图行要跟 id 对齐，不是随手值）。
 */
export const DEBUG_ROW = { idW: 48, typeW: 96, elapsedW: 64, indent: 56 };

/** 一列步骤在报告左树里的位置线索：来自这一份运行自己的 summary_graph 快照。 */
export interface StepTreeHint {
  /** 前序遍历序号（= 执行顺序；顶层步与它的子步共用一趟遍历）。 */
  order: number;
  /** 图上的节点名（画布显示的就是它）。null = 这个 key 在图上没有名字。 */
  name: string | null;
}

/**
 * summary_graph → {step_key: {order, name}}（报告左树的顺序与名字的事实源）。
 *
 * 现场（真走查量出来的第二个缺陷，跟「命令行顶著用例名」同一棵树）：混合场景跑完，
 * 报告左树是 fin / login / n1 / poll / poll.q / poll.st / tok——后端按 step_key 字母序返回
 * （`report_services.py:248` 的 `order_by(step_key, row_no)`），执行顺序 login→tok→poll→fin→n1
 * 被排没了；除数据集那一步外每行 `subject_name` 都是 null，于是树里只剩 u-key。
 * 同一屏右边的只读画布却是**又对又有名字**，因为它渲染的就是 summary_graph。
 * 也就是说名字与顺序一直都在这份报告里，只是左树没去读。
 *
 * 只读图、不猜第二套：前序遍历（父步、然后它的子步、再下一个兄弟）就是执行顺序，
 * 与 §7.4 的 step_graph 语义一致。图上没有的 key（独立 UI 运行的命令行走的是 `case` 节点
 * 的 detail.commands，不在图上）不进这张表——那些步保持后端返回序，不硬造顺序。
 * 对畸形输入（null / nodes 非数组 / 子步缺失）一律退回空表，绝不抛。
 */
export function stepTreeHints(graph: unknown): Record<string, StepTreeHint> {
  const out: Record<string, StepTreeHint> = {};
  let i = 0;
  const rec = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (!n || typeof n !== "object") continue;
      const key = (n as { key?: unknown }).key;
      if (typeof key !== "string" || key === "") continue;
      const nm = (n as { name?: unknown }).name;
      out[key] = { order: i++, name: typeof nm === "string" && nm !== "" ? nm : null };
      rec((n as { children?: unknown }).children);
    }
  };
  rec((graph as { nodes?: unknown } | null)?.nodes);
  return out;
}

/**
 * 同级步骤按图上的序排（稳定）：图上有号的按号排，没号的保持后端原序并排在后面。
 * 单独抽出来是因为「没号的排后面」这条要能被钉住——独立 UI 运行的命令行不在图上
 * （它们活在 `case` 节点的 detail.commands 里），它们的序本来就对，不该被这次改动打乱。
 */
export function orderKeysByHints(keys: string[], hints: Record<string, StepTreeHint>): string[] {
  return keys.map((k, i) => ({ k, i })).sort((a, b) => {
    const oa = hints[a.k]?.order;
    const ob = hints[b.k]?.order;
    if (oa != null && ob != null && oa !== ob) return oa - ob;
    if (oa != null && ob == null) return -1;
    if (oa == null && ob != null) return 1;
    return a.i - b.i;
  }).map((x) => x.k);
}

/**
 * 报告左步骤树里一行的标题（真走查量出来的缺陷：UI 运行的命令行全叫用例名）。
 *
 * 现场：独立跑一条 6 命令的 UI 用例，报告落 7 行（R102：`case` 汇总节点 + 每命令一行），
 * 后端把 `subject_name=case.name` 写在**每一行**上，于是树里 7 行逐字相同——
 * 只有状态颜色不同，看不出哪行是哪条命令。详情面板（cmdRows）有 id + 中文命令名，
 * 树这边什么都没有。
 *
 * 修在渲染侧而不是回写库里的 `subject_name`，是刻意的：报告要**永久自包含**（1B §5.8），
 * 老报告不会重新生成，改后端等于让历史继续难看；而 `step_key` + `kind` 从第一天就在行上，
 * 前端足以自己判出这是谁。同一份理由也管住了名字回落：`graphName` 取自这一份报告自己的
 * summary_graph 快照（画布用的就是它），不 join 任何资产表，资产被彻底删了也照样读得出。
 *
 * 判据：父节点是 `ui_case`/`adb_case` 的行 = 一条命令（独立运行与场景内嵌同形；
 * adb 命令行的 kind 同样是命令类型、parent 同样是汇总节点，见 adb_test/debug_services.py），
 * 标题给「命令 id + 中文命令名」；其余步骤（api_case / 循环 / 数据集…）照旧用 subject_name，
 * 只在它为空时退到图上的节点名，最后才退到 step_key（画布同名步有名字却不显示是白瞎）。
 * kind 查不到中文名（老数据/新命令）就退回 step_key，绝不显示空串。
 */
export function stepTreeLabel(step: {
  step_key: string; kind: string; subject_name: string | null; parent_step_key: string | null;
}, parentKind: string | null, graphName?: string | null): string {
  if (parentKind === "ui_case" || parentKind === "adb_case") {
    const table = parentKind === "adb_case" ? ADB_CMD_LABELS : CMD_LABELS;
    const label = table[step.kind];
    // 命令 id 是用户自己起的（u7 / d1 / login），带上它才能和右栏命令明细对上
    return step.kind ? step.step_key + " · " + (label ?? step.kind) : step.step_key;
  }
  return step.subject_name || graphName || step.step_key;
}
