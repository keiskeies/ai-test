// 场景编辑器状态（zustand，计划 T19）：graph 单一真相 + undo 栈 + dirty + 选中。
// 组件层只做渲染与输入转换；一切树编辑都走 graphOps（不可变），保存成功后同步 version。
// 乐观锁冲突在这里成形（409 → conflict 快照对），差异弹窗只消费状态、不做决策。
import { create } from "zustand";
import { ApiErr, get } from "../api/client";
import { sceneApi } from "../api/scene";
// D150：断流一次性对账取 run 终态——复用 reportApi（GET /reports/{run_id}，reportDetail
// 轮询终态的同一 api 模块，不另搓 URL；status 词表 = run 级 passed/failed/error/cancelled）。
import { reportApi } from "../api/report";
import { uiApi } from "../api/ui";
import { adbCaseApi } from "../api/adbCase";
import type { AdbCaseOut } from "../api/adbCase";
import type { components } from "../api/schema";
import type { CaseRow, EnvRow, Page } from "../api/api";
import type { SceneAssertion } from "../api/req";
import {
  allKeys,
  cloneNode,
  createUndoStack,
  duplicate,
  findByKey,
  fromGraphV1,
  insertAfter,
  insertInto,
  moveNode,
  nextKey,
  pushUndo,
  redo,
  remove,
  rename,
  toGraphV1,
  toggleDisable,
  undo as undoOp,
  validateLocal,
  walk,
} from "./graphOps";
import type { Issue, UndoStack } from "./graphOps";
import { CONTAINER_KINDS, kindMeta, labelOf, type Kind, type LayoutMap, type StepNode } from "./stepTypes";

type ScenarioOut = components["schemas"]["ScenarioOut"];
type ScenarioUpdateBody = components["schemas"]["scenario_update_body"];
type UiCaseOut = components["schemas"]["UiCaseOut"];

export interface Snapshot {
  nodes: StepNode[];
  layout: LayoutMap;
}

export interface ConflictState {
  /** 我方与服务器各自的 pretty JSON（差异弹窗并排渲染用）。 */
  mine: string;
  server: string;
  serverVersion: number;
  serverNodes: StepNode[];
  serverLayout: LayoutMap;
  serverEnvId: string | null;
  /** 服务器口径的场景级字段（「用服务器」要整套回退，不只图）。 */
  serverVariables: Record<string, string>;
  serverFailFast: boolean;
  serverMaxRuntimeMs: number | null;
  serverCommonAssertions: CommonAssertion[];
  /** D147：服务器图里被 fromGraphV1 过滤掉的原始条目（逐字）。takeServer 采纳服务器树时
   *  落进 graphRejected——不然「用服务器」会把畸形步骤静默洗掉，下一次保存照样写没。
   *  可选：旧冲突快照/测试夹具不带它，takeServer 按 [] 兜底。 */
  serverRejected?: unknown[];
}

/** 「用我的」覆盖被服务器/网络拒绝的原因（null = 没有待交代的失败）。
 *  三因分句，口径同 ListFailure/why()：validation = 422 图不合法被拒；
 *  denied = 真 403（写权限缺失）；error = 其余请求没成功（不许说成没权限）。
 *  再撞 409 不进这里——它刷新 conflict 回到裁决路径（save() 的故意，见其 catch）。 */
export type OverrideFailure = "validation" | "denied" | "error" | null;

/**
 * 场景级公共断言（R85/T20b，R88 语义修正）：**对每一个发出请求的步骤逐条求值**，
 * 语义与该步自己的断言一致（optional/fail_fast 一视同仁）；任一步不过 → 该步 fail
 * → run 判 failed（不是 error：断言没过不是跑不动）。空列表 = 不启用。
 * 行形状与步骤断言同源（app/shared/assertions.py 的 evaluate 吃同一套字典），
 * 求值行落在该步 detail.assertions 里带 scope="common" 标记。
 */
export type CommonAssertion = SceneAssertion;

/** 编辑器一次性静默拉四份清单（接口/UI/ADB 用例 + 环境）。每份的失败原因分开记：
 *  403 是稳定的权限结论，喊「恢复后重进」等于把缺权限说成等一会儿；其余才是取不到。
 *  null = 这一份真的取到了，空数组就是事实。 */
export type ListFailure = "denied" | "error" | null;
export interface AssetsFailed {
  cases: ListFailure;
  uiCases: ListFailure;
  adbCases: ListFailure;
  envs: ListFailure;
}
const NO_FAILURE: AssetsFailed = { cases: null, uiCases: null, adbCases: null, envs: null };
export type AssetsFailureSlot = keyof AssetsFailed;

/** 清单失败分因（load 与 loadMoreAssets 共用同一把尺）：403=denied，其余=error。 */
const listWhy = (e: unknown): Exclude<ListFailure, null> =>
  (e instanceof ApiErr && e.status === 403 ? "denied" : "error");

/** D152：四份清单各自的下一页游标（null = 取全了，或这份根本没取到）。
 *  load() 每次整体重置——上一场景的游标串进新场景就是拉错页。 */
export interface AssetsCursor {
  cases: string | null;
  uiCases: string | null;
  adbCases: string | null;
  envs: string | null;
}
const NO_CURSOR: AssetsCursor = { cases: null, uiCases: null, adbCases: null, envs: null };
/** D152：per-slot「加载更多」在途位：没有这道门，双击竞态会把同一页追加两遍。 */
export interface AssetsBusy {
  cases: boolean;
  uiCases: boolean;
  adbCases: boolean;
  envs: boolean;
}
const NO_BUSY: AssetsBusy = { cases: false, uiCases: false, adbCases: false, envs: false };

/** 四份清单是不是「只取到了第一页」：load() 每份只发一次 size=200 的请求，
 *  后端 next_cursor 非空 = 后面还有没取进来的。此时 items.length 只是已取到的条数，
 *  UI 拿它说「项目里有 N 条」就是把第一页冒充普查（「共 N」同族病灶）。 */
export interface AssetsHasMore {
  cases: boolean;
  uiCases: boolean;
  adbCases: boolean;
  envs: boolean;
}
const NO_MORE: AssetsHasMore = { cases: false, uiCases: false, adbCases: false, envs: false };

/** 场景本体（`sceneApi.get` 那一路）取不到的三种真事。分句口径逐字照搬同族孪生
 *  `adbCaseDetail.tsx:234-252` / `uiCaseDetail.tsx:195-212`：只有 404/410 才敢讲「已被回收」，
 *  403 是稳定的权限结论（该给权限空页而不是「等一会儿」），其余才是没取到。
 *  合成一句「可能已被回收或删除」= 每次后端故障都替用户下一次「这条没了」的结论。 */
export type SceneLoadFailure =
  | { kind: "denied"; err: ApiErr }
  | { kind: "missing" }
  | { kind: "error" };

function sceneFailureOf(e: unknown): SceneLoadFailure {
  if (e instanceof ApiErr && e.status === 403) return { kind: "denied", err: e };
  if (e instanceof ApiErr && (e.status === 404 || e.status === 410)) return { kind: "missing" };
  return { kind: "error" };
}

/** 本体没取到时草稿的归零态：草稿与基线成对相等 ⇒ `selectDirty` 恒 false。
 *  不归零的后果不是「画布旧了一点」——是顶栏的脏点常亮，于是失败页上唯一那个「返回」
 *  被未保存离开拦截弹窗扣住，人被困在一张并不存在的场景上。 */
const blankDraft = () => ({
  nodes: [] as StepNode[],
  layout: {} as LayoutMap,
  baselineNodes: "[]",
  envId: null,
  baselineEnvId: null,
  variables: {} as Record<string, string>,
  baselineVariables: "{}",
  failFast: true,
  baselineFailFast: true,
  maxRuntimeMs: null,
  baselineMaxRuntimeMs: null,
  commonAssertions: [] as CommonAssertion[],
  baselineCommonAssertions: "[]",
  undo: createUndoStack<Snapshot>({ nodes: [], layout: {} }),
  selectedKey: null,
  selectedKeys: [] as string[],
  serverIssues: [] as Issue[],
  graphRejected: [] as unknown[],
  clipboard: null,
});

/** 步骤现状（SSE step/* 事件投影；key → 最新状态 + 数据集行进度）。 */
export interface RunStepState {
  status: "running" | "pass" | "fail" | "skip" | "error" | "cancelled";
  rowProgress?: string; // "3/10"
  rowNo?: number;
  message?: string | null;
}

export interface RunSession {
  open: boolean;
  trigger: "debug" | "manual" | null;
  runId: string | null;
  phase: "idle" | "starting" | "running" | "done" | "error";
  errorText: string | null;
  finalStatus: string | null;
  stats: Record<string, unknown> | null;
  stepStatus: Record<string, RunStepState>;
  /** 原始事件帧（seq 去重后按到达序）；抽屉日志的数据源。 */
  events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
  /** 取消旗：按钮进「取消中…」态，等步骤边界生效。 */
  cancelRequested: boolean;
  /** D150：**本轮 run** 的连续断流计数（任一成功帧归零；随 run 对象整体作废，换轮即清零）。 */
  downStrikes: number;
}

const freshRun = (trigger: "debug" | "manual"): RunSession => ({
  open: true, trigger, runId: null, phase: "starting", errorText: null,
  finalStatus: null, stats: null, stepStatus: {}, events: [], cancelRequested: false,
  downStrikes: 0,
});

/** D150 断流对账阈值：连续 N 次断流才对账一次；取 3 与仓内三击惯例同源
 *  （notify/hooks.py 的 ALERT_THRESHOLD = 3）。 */
const SSE_DOWN_STRIKES = 3;
/** D150：run 级终态词表 = 后端 orchestration.TERMINAL（passed/failed/error/cancelled），
 *  即 GET /reports/{run_id} 的 status 与 SSE run_end payload.status 那套；**不是**
 *  stepStatus 的 pass/fail 那套（两表混用会把还在跑的场景判成已终态）。 */
const RUN_TERMINAL = new Set(["passed", "failed", "error", "cancelled"]);
/** D150：对账在途认领的 runId（模块级：要活得比被取代的那轮 run 久才挡得住迟到响应）。 */
let reconcilingRunId: string | null = null;

interface SceneState {
  loading: boolean;
  scenario: ScenarioOut | null;
  projectId: string;
  scenarioId: string;
  nodes: StepNode[];
  layout: LayoutMap;
  /** 上次加载/保存时的 nodes 序列化——dirty 的判据（layout 不参与 dirty）。 */
  baselineNodes: string;
  baselineEnvId: string | null;
  envId: string | null;
  // —— 场景级草稿（T20 场景级面板）：与 nodes 一样「改了就 dirty，保存才落库」——
  variables: Record<string, string>;
  baselineVariables: string;
  failFast: boolean;
  baselineFailFast: boolean;
  maxRuntimeMs: number | null;
  baselineMaxRuntimeMs: number | null;
  /** 场景级公共断言草稿（R85）：同款「改了就 dirty，保存才落库」。 */
  commonAssertions: CommonAssertion[];
  baselineCommonAssertions: string;
  undo: UndoStack<Snapshot>;
  selectedKey: string | null;
  selectedKeys: string[];
  mode: "canvas" | "list";
  collapsed: string[];
  serverIssues: Issue[];
  /** D147：本次装载被 fromGraphV1 白名单过滤掉的原始条目（逐字，不改造）。非空 = 画布
   *  不是库里的全量——save() 据此早退（直接保存会把它们写没），SceneEditor 挂警示横幅。
   *  每次 load/loadReport/loadCardGraph 重置；takeServer 采纳服务器树时落 serverRejected。 */
  graphRejected: unknown[];
  conflict: ConflictState | null;
  /** 「用我的（覆盖对方）」被拒的因（弹窗内交代「覆盖没发生」；每次重试点清）。 */
  overrideFailed: OverrideFailure;
  /** 本地预检拒绝保存后展示在问题面板顶部的警示（每次保存尝试重置）。 */
  refused: boolean;
  saving: boolean;
  cases: CaseRow[];
  /** UI 用例清单（R111 解禁：资产树可拖入 + 右面板下拉；无权限时与 cases 同款降级为空）。 */
  uiCases: UiCaseOut[];
  /** ADB 用例清单（1D：资产树可拖入 + 右面板下拉；无权限时与 uiCases 同款降级为空）。 */
  adbCases: AdbCaseOut[];
  /** 四份清单各自的失败原因（null = 取到了）。静默降级只负责不弹 toast，
   *  不负责让 UI 撒谎：缺了它，后端故障与「项目里真没有用例/环境」在界面上长得一样，
   *  而 403（稳定的权限结论）会被说成「等一会儿再试」。 */
  assetsFailed: AssetsFailed;
  /** 场景本体（不是四份清单）取不到的原因；null = 取到了。
   *  缺了它，`loading` 永远不会落 false，页面只剩一个转圈的 Spin 加一句一闪而过的 toast
   *  ——404（已回收）与 403（没读权限）都是这条死路，D144。 */
  loadFailure: SceneLoadFailure | null;
  /** 三份用例清单的游标语：true = 该份只取了第一页（N 不是普查），见 AssetsHasMore。 */
  assetsHasMore: AssetsHasMore;
  /** D152：四份清单各自的下一页游标（见 AssetsCursor）；load 每次重置。 */
  assetsCursor: AssetsCursor;
  /** D152：per-slot「加载更多」在途位（见 AssetsBusy）。 */
  assetsLoadingMore: AssetsBusy;
  /** D152 竞态修正：装载代数，load 的最终 set 每次 +1。loadMoreAssets 发请求前捕获它，
   *  写回前核对：不等 = 响应属于已被取代的装载代，整笔作废（迟到的旧场景页不许追加进
   *  新场景、不许写游标）。不用 revision 当令牌：它连画布编辑也 bump，编辑期翻页会被误杀。 */
  assetsEpoch: number;
  envs: EnvRow[];
  /** 结构变化的代数：Canvas 用它决定何时把 store 布局灌回 xyflow。 */
  revision: number;
  /** 列表模式剪贴板（复制→粘贴(N)）；存的是快照，粘贴时机由 UI 决定。 */
  clipboard: StepNode | null;
  /** 只读模式（T22 报告详情画布）：树来自报告快照，一切编辑入口关死。
   *  D146 起编辑器 load() 也按 scenario:update 落值：缺写权限 = 只读进编辑器。 */
  readOnly: boolean;
  /**
   * 运行会话（T20 调试 / T21 执行共用抽屉与状态机）：
   * debug 跑未保存草稿（trigger=debug），manual 跑库里已保存的场景（trigger=manual）。
   * stepStatus/rowProgress 是 SSE 事件驱动的步骤现状（画布呼吸高亮的单一真相）；
   * events 保留原始帧（seq 去重后），抽屉日志与「断线不重不漏」的可观察证据。
   */
  run: RunSession;

  /** D146：第三参由调用方传 `!can(perms,"scenario:update")`——缺省 false（可写）。
   *  只在**本体取到**的成功路径落值；失败路径（loadFailure 三态）不碰 readOnly。 */
  load: (projectId: string, scenarioId: string, readOnly?: boolean) => Promise<void>;
  /** D152：按游标追加拉一页（size=200，silent，与 load 同端点同参数 + cursor）。
   *  游标 null 或在途 ⇒ no-op 零请求；成功追加 items、游标/hasMore 从本次响应重算；
   *  失败保货保游标（可重试），只记 assetsFailed[slot]。 */
  loadMoreAssets: (slot: AssetsFailureSlot) => Promise<void>;
  /** 报告只读画布装载（T22）：summary_graph（graph ⊕ result 快照）→ 节点 + 结果着色。 */
  loadReport: (projectId: string, summaryGraph: unknown) => void;
  /** 候选卡只读预览装载（1F T4，/scene-preview）：照 loadReport 形状，但不带 result 染色层——
   *  候选没跑过，复用 loadReport 塞假 result 装执行过就是 §13 纪律 1 的假门。 */
  loadCardGraph: (graph: unknown) => void;
  /** 应用一次树编辑：压 undo、置 dirty 事实（baseline 不变）、bump revision。 */
  apply: (mutate: (nodes: StepNode[]) => StepNode[]) => boolean;
  doUndo: () => void;
  doRedo: () => void;
  select: (key: string | null) => void;
  setMulti: (keys: string[]) => void;
  setMode: (m: "canvas" | "list") => void;
  toggleCollapsed: (key: string) => void;
  setEnvId: (id: string | null) => void;
  setVariables: (v: Record<string, string>) => void;
  setFailFast: (v: boolean) => void;
  setMaxRuntimeMs: (v: number | null) => void;
  setCommonAssertions: (v: CommonAssertion[]) => void;
  addStep: (kind: Kind, targetKey: string | null, patch?: Partial<StepNode>) => void;
  dropOn: (payloadKeyOrKind: { node?: string; kind?: Kind; ref?: string; name?: string },
    targetKey: string | null) => void;
  removeKey: (key: string) => void;
  renameKey: (key: string, name: string) => void;
  duplicateKey: (key: string) => void;
  toggleDisableKey: (key: string) => void;
  moveInto: (targetKey: string, containerKey: string | null) => boolean;
  /** 列表模式拖把手排序：搬到 toParent 的 index 位（toParent=null → 顶层）。 */
  moveNodeTo: (targetKey: string, toParent: string | null, index?: number) => boolean;
  updateConfig: (key: string, patch: Record<string, unknown>) => void;
  patchNode: (key: string, fn: (n: StepNode) => StepNode) => void;
  groupSelected: () => void;
  copyNode: (key: string) => void;
  /** 粘贴剪贴板快照到容器/顶层；key 与全树冲突时重新分配（粘贴不是撤销的对偶）。 */
  pasteInto: (containerKey: string | null, branchIndex?: number) => void;
  beginRun: (trigger: "debug" | "manual") => void;
  attachRun: (runId: string) => void;
  /** 终态收敛点（幂等）。调用者只有两条：applyRunEvent 收到 SSE run_end 帧，与 D150 的
   *  断流对账（noteStreamDown 取到 run 级终态后走这里）——没有常驻轮询（D11 教训：
   *  轮询是第二真相源），断流兜底只此一处一次性取数。 */
  finishRun: (status: string, stats?: Record<string, unknown> | null) => void;
  failRun: (message: string) => void;
  closeRun: () => void;
  markCancelRequested: () => void;
  /** SSE 单帧归约（seq 已在 shared/sse 去重；这里只做状态投影，不再判重）。 */
  applyRunEvent: (ev: { seq: number; type: string; payload: Record<string, unknown> }) => void;
  /** D150：SSE 断流一次（openStream 的 onDown 回调位）。连续第 3 次才发**一次**
   *  run 状态取数（reportApi.get，与 reportDetail 轮询终态同一端点）；终态走 finishRun
   *  收敛，非终态只把计数归零（run 真的还在跑，下 3 次断流再对账一次）。 */
  noteStreamDown: () => void;
  save: () => Promise<void>;
  forceSaveWithVersion: (version: number) => Promise<boolean>;
  takeServer: () => void;
  clearConflict: () => void;
  copyMine: () => Promise<void>;
}

const j = (v: unknown) => JSON.stringify(v ?? null);

/**
 * 断言行的入库形状：丢掉 null/undefined 占位键，**保留 false**（`enabled: false` 是 D78
 * 唯一有语义的关闭位，丢掉等于把用户关掉的断言重新打开）。与后端
 * `app/shared/assertions.py` 的 `prune_rows` 同一口径——那侧才是唯一裁判，这里只是让
 * 请求体、脏判据基线与服务端回显三者从第一次保存起就是同一个字符串。
 * 导出只为让契约测试能直接钉它，不给页面用。
 */
export function pruneNull(a: SceneAssertion): Record<string, unknown> {
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * 公共断言「要发出去的那一份」：草稿位（没选类型的行）不进库，null 占位键不进库。
 * 保存请求体与脏判据必须共用这一个表达式——各算各的就会出现两种谎：
 * 「明明改了却说不脏」（发得比判得多）或「存过了还亮着未保存」（基线是剪过的回显、
 * 草稿还带着 null）。后端 `shared/assertions.prune_rows` 是同一口径的裁判。
 */
function caPayload(rows: CommonAssertion[]): Record<string, unknown>[] {
  return rows.filter((a) => a.type).map(pruneNull);
}

/** 脏判据基线：与服务端回显/请求体同一口径序列化。库里存过未剪枝的老行也不许一进来
 *  就亮「未保存」——那是要用户去存一份他根本没改的东西。 */
const jca = (rows: CommonAssertion[]) => j(caPayload(rows));

/** 场景本体 → 草稿 + 基线（成对赋值，dirty 的判据就是这个配对）。 */
function draftFrom(sc: ScenarioOut) {
  const { nodes, layout, rejected } = fromGraphV1(sc.step_graph);
  // R85：ScenarioOut 目前可能还没有 common_assertions（后端半边在路上）——
  // 防御式读取：缺字段按「没配」渲染，不炸面板。字段落地后这里自动吃到。
  const cas = Array.isArray((sc as { common_assertions?: unknown }).common_assertions)
    ? ((sc as unknown as { common_assertions: CommonAssertion[] }).common_assertions) : [];
  return {
    nodes,
    layout,
    baselineNodes: j(nodes),
    envId: sc.env_id ?? null,
    baselineEnvId: sc.env_id ?? null,
    variables: { ...(sc.variables ?? {}) },
    baselineVariables: j(sc.variables ?? {}),
    failFast: sc.fail_fast !== false,
    baselineFailFast: sc.fail_fast !== false,
    maxRuntimeMs: sc.max_runtime_ms ?? null,
    baselineMaxRuntimeMs: sc.max_runtime_ms ?? null,
    commonAssertions: cas,
    baselineCommonAssertions: jca(cas),
    undo: createUndoStack<Snapshot>({ nodes, layout }),
    selectedKey: null,
    selectedKeys: [] as string[],
    serverIssues: (sc.issues as unknown as Issue[]) ?? [],
    // D147：过滤掉的畸形条目随草稿入账——baseline 只含合规节点，但「库里有而画布没有」
    // 这件事必须可观察，save() 靠它拦下「打开→什么都没动→保存就把畸形步骤写没」。
    graphRejected: rejected,
    clipboard: null,
  };
}

/** 不可变地替换 key 节点（fn 返回值整体替换该节点）；覆盖 if 分支。找不到返回原引用。 */
export function updateNode(
  nodes: StepNode[],
  key: string,
  fn: (n: StepNode) => StepNode,
): StepNode[] {
  const rec = (list: StepNode[]): { list: StepNode[]; hit: boolean } => {
    let hit = false;
    const out = list.map((n) => {
      if (hit) return n;
      if (n.key === key) { hit = true; return fn(n); }
      if (n.kind === "if") {
        const branches = (n.config?.branches as { cond?: unknown; children?: StepNode[] }[]) ?? [];
        let bhit = false;
        const nb = branches.map((b) => {
          if (bhit) return b;
          const r = rec(b.children ?? []);
          if (r.hit) { bhit = true; return { ...b, children: r.list }; }
          return b;
        });
        if (bhit) { hit = true; return { ...n, config: { ...n.config, branches: nb } }; }
        return n;
      }
      if (Array.isArray(n.children)) {
        const r = rec(n.children);
        if (r.hit) { hit = true; return { ...n, children: r.list }; }
      }
      return n;
    });
    return { list: out, hit };
  };
  const r = rec(nodes);
  return r.hit ? r.list : nodes;
}

export const useSceneStore = create<SceneState>((set, getState) => ({
  loading: true,
  scenario: null,
  projectId: "",
  scenarioId: "",
  nodes: [],
  layout: {},
  baselineNodes: "[]",
  baselineEnvId: null,
  envId: null,
  variables: {},
  baselineVariables: "{}",
  failFast: true,
  baselineFailFast: true,
  maxRuntimeMs: null,
  baselineMaxRuntimeMs: null,
  commonAssertions: [],
  baselineCommonAssertions: "[]",
  undo: createUndoStack<Snapshot>({ nodes: [], layout: {} }),
  selectedKey: null,
  selectedKeys: [],
  mode: "canvas",
  collapsed: [],
  serverIssues: [],
  graphRejected: [],
  conflict: null,
  overrideFailed: null,
  refused: false,
  saving: false,
  cases: [],
  uiCases: [],
  adbCases: [],
  assetsFailed: { ...NO_FAILURE },
  loadFailure: null,
  assetsHasMore: { ...NO_MORE },
  assetsCursor: { ...NO_CURSOR },
  assetsLoadingMore: { ...NO_BUSY },
  assetsEpoch: 0,
  envs: [],
  revision: 0,
  clipboard: null,
  readOnly: false,
  run: { open: false, trigger: null, runId: null, phase: "idle", errorText: null,
    finalStatus: null, stats: null, stepStatus: {}, events: [], cancelRequested: false,
    downStrikes: 0 },

  load: async (projectId, scenarioId, readOnly = false) => {
    set({ loading: true, loadFailure: null, projectId, scenarioId });
    // 静默降级（不弹 toast）留着，但「哪一份没取到、为什么没取到」必须记下来：
    // 只把失败吞成空数组，资产树与顶栏就会对着一场后端故障说「项目里还没有可用的用例」。
    const failed: AssetsFailed = { ...NO_FAILURE };
    const why = listWhy;
    let sceneFailed: SceneLoadFailure | null = null;
    const [sc, cs, ev, ucs, acs] = await Promise.all([
      sceneApi.get(projectId, scenarioId).catch((e) => {
        // 本体不许 join reject：那会让下面的 loading:false 永远到不了。
        sceneFailed = sceneFailureOf(e);
        return null;
      }),
      get<Page<CaseRow>>("/api-cases?project_id=" + encodeURIComponent(projectId) + "&size=200",
        { silent: true }).catch((e) => {
          failed.cases = why(e); return { items: [] as CaseRow[], next_cursor: null };
        }),
      get<Page<EnvRow>>("/envs?project_id=" + encodeURIComponent(projectId) + "&size=200",
        { silent: true }).catch((e) => {
          failed.envs = why(e); return { items: [] as EnvRow[], next_cursor: null };
        }),
      // UI 用例清单（R111）：只读成员 / 无 ui:case:read 时与 api-cases 同款静默降级，
      // 树里不出现、面板下拉为空——不弹错，但要说「没取到/没权限」而不是「还没有」。
      uiApi.listCases({ project_id: projectId, size: 200 }).catch((e) => {
        failed.uiCases = why(e); return { items: [] as UiCaseOut[], next_cursor: null };
      }),
      // ADB 用例清单（1D）：与 UI 用例同口径的静默降级。
      adbCaseApi.listCases({ project_id: projectId, size: 200 }).catch((e) => {
        failed.adbCases = why(e); return { items: [] as AdbCaseOut[], next_cursor: null };
      }),
    ]);
    // 本体取不到：四份清单照常入账（它们各自说清自己没取到），草稿归零、落下 loadFailure。
    // 以前这条路上 `loading: false` 永远到不了 ⇒ 永久转圈。归零是为了 dirty 恒 false，
    // 否则失败页上唯一那个「返回」会被未保存离开拦截扣住。
    const draft = sc === null ? blankDraft() : draftFrom(sc);
    set({
      ...draft,
      scenario: sc,
      // D146：只读位只随「本体取到了」落值（调用方按 scenario:update 推导）；
      // 失败路径不碰它——失败页根本不渲染编辑器，乱设只会污染下一次装载的起点。
      ...(sc === null ? {} : { readOnly }),
      loadFailure: sc === null ? (sceneFailed ?? { kind: "error" }) : null,
      collapsed: [],
      conflict: null,
      refused: false,
      loading: false,
      revision: getState().revision + 1,
      cases: cs.items.filter((c) => c.status === "normal"),
      uiCases: ucs.items.filter((c) => c.status === "normal"),
      adbCases: acs.items.filter((c) => c.status === "normal"),
      assetsFailed: { ...failed },
      // 游标语只从这次取数自身推：next_cursor 非空 = 后端还有没发给我的，
      // 手里的 N 就只是「已取到的」，不是全集。不补拉、不加请求——只是不再撒谎。
      assetsHasMore: {
        cases: cs.next_cursor != null,
        uiCases: ucs.next_cursor != null,
        adbCases: acs.next_cursor != null,
        envs: ev.next_cursor != null,
      },
      // D152：游标落各自槽（失败路 next_cursor=null，游标随之 null）；换场景整体覆盖，
      // 上一场景的游标不许串进新场景。在途位一并归零。
      assetsCursor: {
        cases: cs.next_cursor,
        uiCases: ucs.next_cursor,
        adbCases: acs.next_cursor,
        envs: ev.next_cursor,
      },
      assetsLoadingMore: { ...NO_BUSY },
      // D152 竞态修正：装载换代——此刻仍在途的 loadMore 响应属于旧代，落地即作废。
      assetsEpoch: getState().assetsEpoch + 1,
      envs: ev.items,
      // 换场景 = 上一轮运行的步骤现状作废：不然旧场景的绿点会跟着呼吸到新画布上
      run: { open: false, trigger: null, runId: null, phase: "idle", errorText: null,
        finalStatus: null, stats: null, stepStatus: {}, events: [], cancelRequested: false,
        downStrikes: 0 },
    });
  },

  // D152：「清单本体永远看不到第 201 条」的出口。与 load 同端点同参数 + cursor 追加一页；
  // 显式动作，不是 effect——load 不依赖游标自动重拉（reports.tsx 的 D127 陷阱不许抄）。
  loadMoreAssets: async (slot) => {
    const s = getState();
    const epoch = s.assetsEpoch; // 代数声明：在途期间 load() 一旦换代，这次响应整笔作废
    const cursor = s.assetsCursor[slot];
    // 游标 null = 取全了（或没取到）；在途 = 双击竞态会追加重复页。两种都 no-op 零请求。
    if (cursor == null || s.assetsLoadingMore[slot]) return;
    set({ assetsLoadingMore: { ...s.assetsLoadingMore, [slot]: true } });
    const q = "project_id=" + encodeURIComponent(s.projectId) + "&size=200&cursor=" + encodeURIComponent(cursor);
    // 成功：追加不 wipe，游标/hasMore 从本次响应重算，失败位清 null。
    const done = (patch: Partial<Pick<SceneState, "cases" | "uiCases" | "adbCases" | "envs">>, next: string | null) =>
      set((st) => st.assetsEpoch !== epoch ? {} : ({
        ...patch,
        assetsCursor: { ...st.assetsCursor, [slot]: next },
        assetsHasMore: { ...st.assetsHasMore, [slot]: next != null },
        assetsFailed: { ...st.assetsFailed, [slot]: null },
        assetsLoadingMore: { ...st.assetsLoadingMore, [slot]: false },
      }));
    try {
      if (slot === "cases") {
        const p = await get<Page<CaseRow>>("/api-cases?" + q, { silent: true });
        done({ cases: [...getState().cases, ...p.items.filter((c) => c.status === "normal")] }, p.next_cursor);
      } else if (slot === "envs") {
        const p = await get<Page<EnvRow>>("/envs?" + q, { silent: true });
        done({ envs: [...getState().envs, ...p.items] }, p.next_cursor);
      } else if (slot === "uiCases") {
        const p = await uiApi.listCases({ project_id: s.projectId, size: 200, cursor });
        done({ uiCases: [...getState().uiCases, ...p.items.filter((c) => c.status === "normal")] }, p.next_cursor);
      } else {
        const p = await adbCaseApi.listCases({ project_id: s.projectId, size: 200, cursor });
        done({ adbCases: [...getState().adbCases, ...p.items.filter((c) => c.status === "normal")] }, p.next_cursor);
      }
    } catch (e) {
      // 失败保货保游标：已取到的一条不 wipe，游标留着可重试；只记失败因（与 load 同尺）。
      // 换代作废同 done：旧代失败的失败因也不许写进新场景的槽。
      set((st) => st.assetsEpoch !== epoch ? {} : ({
        assetsFailed: { ...st.assetsFailed, [slot]: listWhy(e) },
        assetsLoadingMore: { ...st.assetsLoadingMore, [slot]: false },
      }));
    }
  },

  // 报告只读画布（T22，§11.7.4）：summary_graph = graph ⊕ 每 key result（引擎终态落的快照）。
  // 结果着色复用 run.stepStatus 这条现成通路（Canvas 的 data-run-status 就认它）；
  // result.status 词表与 step 事件同源（pass/fail/skip/error/cancelled），不用换算。
  // 编辑动作在只读模式下由 Canvas/reportDetail 侧关死；store 这边只保证：无 baseline
  // 可比（dirty 恒 false）、undo 空栈。
  loadReport: (projectId, summaryGraph) => {
    const { nodes, layout, rejected } = fromGraphV1(summaryGraph);
    const stepStatus: Record<string, RunStepState> = {};
    for (const [n] of walk(nodes)) {
      const r = (n as StepNode & { result?: { status?: string } }).result;
      if (r?.status) stepStatus[n.key] = { status: r.status as RunStepState["status"] };
    }
    set((s) => ({
      projectId,
      readOnly: true,
      scenario: null,
      loading: false,
      nodes,
      layout,
      baselineNodes: j(nodes), // 与 nodes 相等 → selectDirty 恒 false（只读没有脏）
      undo: createUndoStack<Snapshot>({ nodes, layout }),
      selectedKey: null,
      selectedKeys: [],
      collapsed: [],
      serverIssues: [],
      graphRejected: rejected, // D147：报告快照同样过白名单，被滤条目如实入账（只读无 save，但状态不许撒谎）
      conflict: null,
      refused: false,
      revision: s.revision + 1,
      run: { open: false, trigger: null, runId: null, phase: "idle", errorText: null,
        finalStatus: null, stats: null, stepStatus, events: [], cancelRequested: false,
        downStrikes: 0 },
    }));
  },

  // 候选卡只读预览（1F T4，§9.7 :601 / D33）：形状照 loadReport，三处刻意不同：
  // ① 不扫 result 染色——候选没跑过，run.stepStatus 留空是「没执行」的事实本身；
  // ② projectId 不动——预览页不属于任何项目上下文，卡片 payload 里也没有；
  // ③ 不走 fromGraphV1 的节点白名单——graph 进本页前已被卡片层/后端 validate 把关
  //    （card_tools.py 出卡前过 scenario/graph.py 同一把尺），这里保持逐字往返，
  //    未知形状宁渲染原样也不静默丢节点装成「图本来就这么小」。
  loadCardGraph: (graph) => {
    const g = (graph && typeof graph === "object" ? graph : {}) as {
      nodes?: unknown; layout?: unknown;
    };
    const nodes = Array.isArray(g.nodes) ? (JSON.parse(JSON.stringify(g.nodes)) as StepNode[]) : [];
    const layout: LayoutMap = (g.layout && typeof g.layout === "object" && !Array.isArray(g.layout))
      ? { ...(g.layout as LayoutMap) } : {};
    set((s) => ({
      readOnly: true,
      scenario: null,
      loading: false,
      nodes,
      layout,
      baselineNodes: j(nodes), // 与 nodes 相等 → dirty 恒 false（只读没有脏）
      undo: createUndoStack<Snapshot>({ nodes, layout }),
      selectedKey: null,
      selectedKeys: [],
      collapsed: [],
      serverIssues: [],
      graphRejected: [], // D147：本路逐字往返、零过滤——重置，别让上一次装载的 rejected 串进来
      conflict: null,
      refused: false,
      revision: s.revision + 1,
      run: { open: false, trigger: null, runId: null, phase: "idle", errorText: null,
        finalStatus: null, stats: null, stepStatus: {}, events: [], cancelRequested: false,
        downStrikes: 0 },
    }));
  },

  apply: (mutate) => {
    const s = getState();
    const next = mutate(s.nodes);
    if (next === s.nodes) return false; // graphOps 的「没找到就原引用返回」语义
    set({
      nodes: next,
      undo: pushUndo(s.undo, { nodes: next, layout: s.layout }),
      selectedKeys: s.selectedKeys,
      refused: false,
      revision: s.revision + 1,
    });
    return true;
  },

  doUndo: () => {
    const s = getState();
    const u = undoOp(s.undo);
    if (!u) return;
    set({ undo: u, nodes: u.present.nodes, layout: u.present.layout,
      revision: s.revision + 1, refused: false });
  },
  doRedo: () => {
    const s = getState();
    const r = redo(s.undo);
    if (!r) return;
    set({ undo: r, nodes: r.present.nodes, layout: r.present.layout,
      revision: s.revision + 1, refused: false });
  },

  select: (key) => set({ selectedKey: key }),
  setMulti: (keys) => set({ selectedKeys: keys }),
  setMode: (m) => set({ mode: m }),
  toggleCollapsed: (key) => set((s) => ({
    collapsed: s.collapsed.includes(key)
      ? s.collapsed.filter((k) => k !== key)
      : [...s.collapsed, key],
  })),
  setEnvId: (id) => set({ envId: id }),
  setVariables: (v) => set({ variables: v }),
  setFailFast: (v) => set({ failFast: v }),
  setMaxRuntimeMs: (v) => set({ maxRuntimeMs: v }),
  setCommonAssertions: (v) => set({ commonAssertions: v }),

  addStep: (kind, targetKey, patch) => {
    getState().dropOn({ kind, ...patch }, targetKey);
  },

  dropOn: (payload, targetKey) => {
    const s = getState();
    // 移动画布上已有节点（HTML5 拖拽的路径之一）
    if (payload.node !== undefined) {
      const target = targetKey ? findByKey(s.nodes, targetKey) : null;
      const isContainer = !!target && (CONTAINER_KINDS as readonly string[]).includes(target[0].kind);
      if (targetKey && isContainer) {
        const out = moveNode(s.nodes, { key: payload.node, toParent: targetKey });
        if (out) set({ nodes: out, undo: pushUndo(s.undo, { nodes: out, layout: s.layout }),
          refused: false, revision: s.revision + 1 });
        return;
      }
      const out = targetKey
        ? moveNode(s.nodes, { key: payload.node, toParent: null,
            index: insertIndexAfterTopLevel(s.nodes, targetKey, payload.node) })
        : moveNode(s.nodes, { key: payload.node, toParent: null });
      if (out) set({ nodes: out, undo: pushUndo(s.undo, { nodes: out, layout: s.layout }),
        refused: false, revision: s.revision + 1 });
      return;
    }
    if (payload.kind === undefined) return;
    const used = allKeys(s.nodes);
    const key = nextKey(used, null);
    const kind = payload.kind;
    const node: StepNode = { key, kind, name: payload.name ?? labelOf(kind) };
    if (kind === "api_case" || kind === "ui_case" || kind === "adb_case") {
      node.ref = payload.ref ?? "";
    } else {
      // 新步骤带一份「可直接保存」的底稿（loop=count/max_iter、sleep=1000ms…），
      // 缺的字段留给用户补；不给底稿的话每个新节点都顶着 missing_config 红角标。
      const cfg = kindMeta(kind).defaultConfig();
      if (Object.keys(cfg).length > 0) node.config = cfg;
    }
    if (!targetKey) {
      set({ nodes: [...s.nodes, node],
        undo: pushUndo(s.undo, { nodes: [...s.nodes, node], layout: s.layout }),
        selectedKey: key, refused: false, revision: s.revision + 1 });
      return;
    }
    const target = findByKey(s.nodes, targetKey);
    if (!target) return;
    const isContainer = ["loop", "foreach", "if", "group"].includes(target[0].kind);
    const next = isContainer
      ? insertInto(s.nodes, targetKey, node, 0)
      : insertAfter(s.nodes, targetKey, node);
    set({ nodes: next, undo: pushUndo(s.undo, { nodes: next, layout: s.layout }),
      selectedKey: key, refused: false, revision: s.revision + 1 });
  },

  removeKey: (key) => {
    const s = getState();
    const next = remove(s.nodes, key);
    if (next === s.nodes) return;
    set({ nodes: next, undo: pushUndo(s.undo, { nodes: next, layout: s.layout }),
      selectedKey: null, revision: s.revision + 1 });
  },
  renameKey: (key, name) => {
    const s = getState();
    const next = rename(s.nodes, key, name);
    if (next === s.nodes) return;
    set({ nodes: next, undo: pushUndo(s.undo, { nodes: next, layout: s.layout }),
      revision: s.revision + 1 });
  },
  duplicateKey: (key) => {
    const s = getState();
    const next = duplicate(s.nodes, key);
    if (next === s.nodes) return;
    set({ nodes: next, undo: pushUndo(s.undo, { nodes: next, layout: s.layout }),
      revision: s.revision + 1 });
  },
  toggleDisableKey: (key) => {
    const s = getState();
    const next = toggleDisable(s.nodes, key);
    if (next === s.nodes) return;
    set({ nodes: next, undo: pushUndo(s.undo, { nodes: next, layout: s.layout }),
      revision: s.revision + 1 });
  },
  moveInto: (targetKey, containerKey) => {
    const s = getState();
    const out = moveNode(s.nodes, { key: targetKey, toParent: containerKey });
    if (!out) return false;
    set({ nodes: out, undo: pushUndo(s.undo, { nodes: out, layout: s.layout }),
      refused: false, revision: s.revision + 1 });
    return true;
  },
  moveNodeTo: (targetKey, toParent, index) => {
    const s = getState();
    const out = moveNode(s.nodes, { key: targetKey, toParent, index });
    if (!out) return false;
    set({ nodes: out, undo: pushUndo(s.undo, { nodes: out, layout: s.layout }),
      refused: false, revision: s.revision + 1 });
    return true;
  },
  updateConfig: (key, patch) => {
    const s = getState();
    const next = updateNode(s.nodes, key, (n) => ({ ...n, config: { ...n.config, ...patch } }));
    if (next === s.nodes) return;
    set({ nodes: next, undo: pushUndo(s.undo, { nodes: next, layout: s.layout }),
      revision: s.revision + 1 });
  },
  patchNode: (key, fn) => {
    const s = getState();
    const next = updateNode(s.nodes, key, fn);
    if (next === s.nodes) return;
    set({ nodes: next, undo: pushUndo(s.undo, { nodes: next, layout: s.layout }),
      revision: s.revision + 1 });
  },

  groupSelected: () => {
    const s = getState();
    if (s.selectedKeys.length < 2) return;
    // 只支持同层成组：全部选中项必须有同一个父（含都在顶层）
    const parents = new Map<string, string | null>();
    for (const [node, parent] of walk(s.nodes)) parents.set(node.key, parent);
    const ps = new Set(s.selectedKeys.map((k) => parents.get(k) ?? null));
    if (ps.size !== 1) return;
    const parent = [...ps][0];
    const key = nextKey(allKeys(s.nodes), null);
    const group: StepNode = { key, kind: "group", name: "分组" };
    let nodes = s.nodes;
    if (parent === null) {
      nodes = [...nodes, group];
      for (const k of s.selectedKeys) nodes = moveNode(nodes, { key: k, toParent: key }) ?? nodes;
    } else {
      nodes = insertInto(nodes, parent, group, 0);
      for (const k of s.selectedKeys) nodes = moveNode(nodes, { key: k, toParent: key }) ?? nodes;
    }
    set({ nodes, undo: pushUndo(s.undo, { nodes, layout: s.layout }),
      selectedKeys: [], selectedKey: key, revision: s.revision + 1 });
  },

  copyNode: (key) => {
    const s = getState();
    const found = findByKey(s.nodes, key);
    if (!found) return;
    // 剪贴板存的是「复制那一刻的快照」：复制后再改原步骤，粘贴出来的是旧副本——
    // 这是所有剪贴板的通义，别自作聪明存 key（粘贴时原步骤可能已被删/改）。
    set({ clipboard: cloneNode(s.nodes, found[0]) });
  },

  pasteInto: (containerKey, branchIndex = 0) => {
    const s = getState();
    if (!s.clipboard) return;
    // 剪贴板里的 key 可能已被后来粘贴/改名的节点占用（复制→粘贴→再粘贴会撞 dup_key）：
    // 每次粘贴都按「当前树」重新分配，粘贴不是撤销的对偶，不该复用旧 key。
    const fresh = cloneNode(s.nodes, s.clipboard);
    const next = containerKey
      ? insertInto(s.nodes, containerKey, fresh, branchIndex)
      : insertAfter(s.nodes, s.nodes.length ? s.nodes[s.nodes.length - 1].key : "", fresh);
    // 空树时 insertAfter 找不到锚点 → 直接追加
    const nodes = containerKey || next !== s.nodes ? next : [...s.nodes, fresh];
    if (nodes === s.nodes) return;
    set({ nodes, undo: pushUndo(s.undo, { nodes, layout: s.layout }),
      selectedKey: fresh.key, refused: false, revision: s.revision + 1 });
  },

  beginRun: (trigger) => set(() => ({
    // 上一轮运行的快照随新一轮作废：每次点都是新 run，旧步骤混进新树会演「秒回」假象
    run: freshRun(trigger),
  })),
  attachRun: (runId) => set((s) => ({
    run: { ...s.run, runId, phase: "running" },
  })),
  finishRun: (status, stats) => set((s) => ({
    // 幂等收敛（先到先得，后到者只补 stats）。调用者两条：SSE run_end 帧（applyRunEvent）
    // 与 D150 断流对账（noteStreamDown 取到终态）。没有常驻轮询兜底——那正是 D150
    // 否掉的第二真相源；断流兜底只有 noteStreamDown 这一处一次性取数。
    run: { ...s.run, phase: "done", finalStatus: status,
      stats: stats ?? s.run.stats ?? null },
  })),
  // D150：断流第 3 击 ⇒ 一次性对账（裁定形状①）。病根：shared/sse.ts 咽掉流错误、1500ms
  // 静默重连，流真死时 run 永远停在 running。不常驻轮询（D11：第二真相源）、不超时杀
  // 长场景，只在连续 3 击后发**一次** reportApi.get（run 详情，reportDetail 轮询终态的
  // 同一模块）；终态走 finishRun，非终态一字不动。世代门镜像 assetsEpoch 的在途认领：
  // 在途标记记 runId，响应落地时 runId 已换 ⇒ 迟到应答整笔作废。
  noteStreamDown: () => {
    const s = getState();
    if (s.run.phase !== "running" || !s.run.runId) return; // 非运行会话：断流没有可兜的
    // ??0 防御：旧快照 setState 覆盖 run 不带这字段时，undefined+1=NaN 会假跳阈值。
    const strikes = (s.run.downStrikes ?? 0) + 1;
    if (strikes < SSE_DOWN_STRIKES) {
      set({ run: { ...s.run, downStrikes: strikes } });
      return;
    }
    if (reconcilingRunId === s.run.runId) return; // 同一轮只允许一个对账在途（防 fetch 风暴）
    const runId = s.run.runId;
    reconcilingRunId = runId;
    // 第 3 击消费掉：终态/非终态/取数失败三条路都不留残余 strike，下一窗重新攒满。
    set({ run: { ...s.run, downStrikes: 0 } });
    reportApi.get(s.projectId, runId).then((r) => {
      const cur = getState();
      if (cur.run.runId !== runId) return; // 迟到的旧 run 应答：新会话一字不许动
      if (RUN_TERMINAL.has(r.status)) cur.finishRun(r.status, r.stats); // 既有收敛路径
      // 非终态：还在跑是事实，run 状态不动（下一次对账要重新攒满 3 击）
    }).catch(() => {
      /* 对账没取到 = 什么也没证实：不动 run 态，再断满 3 击会再试 */
    }).finally(() => {
      if (reconcilingRunId === runId) reconcilingRunId = null;
    });
  },
  failRun: (message) => set((s) => ({
    run: { ...s.run, phase: "error", errorText: message },
  })),
  closeRun: () => set((s) => ({ run: { ...s.run, open: false } })),
  markCancelRequested: () => set((s) => ({ run: { ...s.run, cancelRequested: true } })),

  applyRunEvent: (ev) => set((s) => {
    if (s.run.runId === null) return {}; // 迟到的旧流帧不进新会话
    // D150：任一成功帧 = 流是活的，连续断流计数归零（放在投影前，各分支都从这份派生）。
    const run = s.run.downStrikes === 0 ? s.run : { ...s.run, downStrikes: 0 };
    const events = [...run.events, ev].slice(-500);
    if (ev.type === "run_end") {
      return { run: { ...run, events,
        phase: "done", finalStatus: String(ev.payload.status ?? "error"),
        stats: (ev.payload.stats as Record<string, unknown> | undefined) ?? null } };
    }
    if (ev.type.startsWith("step/")) {
      const key = String(ev.payload.key ?? "");
      if (!key) return { run: { ...run, events } };
      const status = ev.type === "step/running"
        ? "running"
        : (ev.type.slice("step/".length) as RunStepState["status"]);
      const prev = run.stepStatus[key];
      const rowNo = typeof ev.payload.row_no === "number" ? ev.payload.row_no : undefined;
      const rowProgress = ev.payload.row_progress ? String(ev.payload.row_progress) : undefined;
      // 数据集行事件只推进度，不改节点色（节点色 = 节点行 row_no 缺省/0 的事件）
      const stepStatus = { ...run.stepStatus, [key]: {
        status: rowNo && rowNo > 0 ? (prev?.status ?? "running") : status,
        rowNo: rowNo ?? prev?.rowNo,
        rowProgress: rowProgress ?? prev?.rowProgress,
        message: (ev.payload.message as string | undefined) ?? prev?.message ?? null,
      } };
      return { run: { ...run, events, stepStatus } };
    }
    return { run: { ...run, events } };
  }),

  save: async () => {
    const s = getState();
    if (!s.scenario) return;
    // D147：画布不是库里全量（有畸形条目被滤掉）时早退，一个写请求都不发——
    // saveBody 把 s.nodes 原样写回，发出去就是把那些步骤写没。宁拦不装绿。
    // 话走 422 同款 surfaced 路径（refused + serverIssues → IssuePanel）：这些条目
    // 来自服务端图，是服务器口径的形状问题；load() 重取即清，不存在「修好还亮」。
    if (s.graphRejected.length > 0) {
      set({
        refused: true,
        serverIssues: dedupeIssues([{
          node_key: "", code: "graph_rejected", path: "$.nodes",
          message: "有 " + s.graphRejected.length + " 个步骤形状不合规未载入画布，直接保存会把它们写没——先修复图再保存",
        }], s.serverIssues),
      });
      return;
    }
    const localIssues = validateLocal(s.nodes);
    set({ refused: false, overrideFailed: null }); // 新一轮保存尝试：上一轮覆盖拒绝句一并撤下
    if (localIssues.length > 0) {
      // 只亮警示位：本地问题面板本来就实时显示 validateLocal，把本地 issue 复制进
      // serverIssues 会让「修好之后角标还在」——serverIssues 只装服务器口径的问题。
      void localIssues;
      set({ refused: true });
      return;
    }
    set({ saving: true });
    try {
      const out = await sceneApi.update(s.scenario.id, saveBody(s));
      // 基线逐项取**发出去的那份快照 s**，不取 await 之后的活状态：请求体是 saveBody(s)，
      // 在途期间用户又改了一笔的话，那一笔没进这次请求；若基线取 getState() 就会把
      // 它记成「已同步」并熄掉脏点——界面说已保存，库里没有。
      set({
        scenario: out,
        baselineNodes: j(s.nodes), // 保存不回改本地结构；version 才是同步事实
        baselineEnvId: s.envId,
        baselineVariables: j(s.variables),
        baselineFailFast: s.failFast,
        baselineMaxRuntimeMs: s.maxRuntimeMs,
        // 基线取**服务器回显**而不是草稿：R85 后端字段未落地时回显缺字段 →
        // 基线=空 → dirty 留在「没存上」这件事上，不演「已保存」。落地后自动对齐。
        baselineCommonAssertions: jca(serverCAs(out)),
        serverIssues: (out.issues as unknown as Issue[]) ?? [],
        conflict: null,
        refused: false,
      });
    } catch (e) {
      if (e instanceof ApiErr && e.code === "conflict") {
        const fresh = await sceneApi.get(s.projectId, s.scenario.id);
        const server = fromGraphV1(fresh.step_graph);
        // 故意不把 scenario.version 提前同步成服务器版本：冲突必须由用户在弹窗里
        // 显式裁决（用我的/用服务器/复制）。复制关闭后再点保存，还会再撞 409 再弹窗——
        // 「悄悄改版本号让下一次保存成功」等于替用户回答了「用我的」。
        set({
          conflict: {
            mine: JSON.stringify(toGraphV1(getState().nodes, getState().layout), null, 2),
            server: JSON.stringify(toGraphV1(server.nodes, server.layout), null, 2),
            serverVersion: fresh.version,
            serverNodes: server.nodes,
            serverLayout: server.layout,
            serverEnvId: fresh.env_id ?? null,
            serverVariables: { ...(fresh.variables ?? {}) },
            serverFailFast: fresh.fail_fast !== false,
            serverMaxRuntimeMs: fresh.max_runtime_ms ?? null,
            serverCommonAssertions: serverCAs(fresh),
            serverRejected: server.rejected, // D147：服务器图的畸形条目随冲突快照带走，takeServer 不许静默洗掉
          },
        });
      } else if (e instanceof ApiErr && e.code === "validation_error") {
        const issues = ((e.details as { issues?: Issue[] })?.issues) ?? [];
        set({ serverIssues: dedupeIssues(issues, []), refused: true });
      }
    } finally {
      set({ saving: false });
    }
  },

  forceSaveWithVersion: async (version) => {
    const s = getState();
    if (!s.scenario) return false;
    set({ saving: true, overrideFailed: null }); // 新一轮尝试：上一轮的拒绝先撤下
    try {
      const out = await sceneApi.update(s.scenario.id, saveBody(s, version));
      // 同 save()：基线=请求里那份快照，在途期间的编辑留给下一次保存。
      set({
        scenario: out,
        baselineNodes: j(s.nodes),
        baselineEnvId: s.envId,
        baselineVariables: j(s.variables),
        baselineFailFast: s.failFast,
        baselineMaxRuntimeMs: s.maxRuntimeMs,
        baselineCommonAssertions: jca(serverCAs(out)),
        serverIssues: (out.issues as unknown as Issue[]) ?? [],
        conflict: null,
      });
      return true;
    } catch (e) {
      // 覆盖被拒必须在弹窗里留下一句话：「用我的」钮不许在失败后还长得像「什么都没发生」。
      // 分因同 save()/why() 的口径；再撞 409 走 conflict 刷新（裁决路径，不落成静态错误句）。
      if (e instanceof ApiErr && e.code === "conflict") {
        const fresh = await sceneApi.get(s.projectId, s.scenario.id);
        const server = fromGraphV1(fresh.step_graph);
        set({
          overrideFailed: null,
          conflict: {
            mine: JSON.stringify(toGraphV1(getState().nodes, getState().layout), null, 2),
            server: JSON.stringify(toGraphV1(server.nodes, server.layout), null, 2),
            serverVersion: fresh.version,
            serverNodes: server.nodes,
            serverLayout: server.layout,
            serverEnvId: fresh.env_id ?? null,
            serverVariables: { ...(fresh.variables ?? {}) },
            serverFailFast: fresh.fail_fast !== false,
            serverMaxRuntimeMs: fresh.max_runtime_ms ?? null,
            serverCommonAssertions: serverCAs(fresh),
            serverRejected: server.rejected, // D147：服务器图的畸形条目随冲突快照带走，takeServer 不许静默洗掉
          },
        });
      } else if (e instanceof ApiErr && e.code === "validation_error") {
        set({ overrideFailed: "validation" });
      } else if (e instanceof ApiErr && e.status === 403) {
        set({ overrideFailed: "denied" });
      } else {
        set({ overrideFailed: "error" });
      }
      return false;
    } finally {
      set({ saving: false });
    }
  },

  takeServer: () => {
    const s = getState();
    const c = s.conflict;
    if (!c || !s.scenario) return;
    const nodes = c.serverNodes;
    set({
      nodes,
      layout: c.serverLayout,
      envId: c.serverEnvId,
      variables: { ...c.serverVariables },
      failFast: c.serverFailFast,
      maxRuntimeMs: c.serverMaxRuntimeMs,
      commonAssertions: c.serverCommonAssertions,
      baselineNodes: j(nodes),
      baselineEnvId: c.serverEnvId,
      baselineVariables: j(c.serverVariables),
      baselineFailFast: c.serverFailFast,
      baselineMaxRuntimeMs: c.serverMaxRuntimeMs,
      baselineCommonAssertions: jca(c.serverCommonAssertions),
      // D147：「用服务器」采纳的是**过滤后**的服务器树——被滤条目落进 graphRejected，
      // 下一次 save 照样被拦；不落的话裁决当场就把畸形步骤洗没了。
      graphRejected: c.serverRejected ?? [],
      scenario: { ...s.scenario, version: c.serverVersion, env_id: c.serverEnvId,
        variables: c.serverVariables, fail_fast: c.serverFailFast,
        max_runtime_ms: c.serverMaxRuntimeMs },
      undo: pushUndo(s.undo, { nodes, layout: c.serverLayout }),
      conflict: null,
      overrideFailed: null, // 裁决已定：覆盖失败句不许活到下一个冲突现场
      revision: s.revision + 1,
    });
  },
  clearConflict: () => set({ conflict: null, overrideFailed: null }),
  copyMine: async () => {
    const s = getState();
    if (s.conflict) {
      try { await navigator.clipboard.writeText(s.conflict.mine); } catch { /* 无剪贴板权限：弹窗照常关，内容没丢 */ }
    }
    set({ conflict: null });
  },
}));

/** ScenarioOut/Update 回显里的公共断言（R85：后端字段落地前缺字段 → 按空渲染）。 */
function serverCAs(sc: unknown): CommonAssertion[] {
  const v = (sc as { common_assertions?: unknown } | null)?.common_assertions;
  return Array.isArray(v) ? (v as CommonAssertion[]) : [];
}

/**
 * 保存请求体：图 + 场景级草稿一视同仁——「面板里改了就要落库」，
 * 各 *_set 开关按「偏离基线才声明要改」的口径（T20 起 fail_fast/variables/max_runtime
 * 都进 dirty 判据，不再依赖后端的 None=不动语义去兜「忘了传」）。
 */
function saveBody(s: SceneState, version?: number): ScenarioUpdateBody {
  const cur = version ?? s.scenario!.version;
  const body: ScenarioUpdateBody = {
    project_id: s.projectId,
    version: cur,
    module_set: false,
    step_graph: toGraphV1(s.nodes, s.layout) as unknown as Record<string, unknown>,
    // 空 key 行是「正在敲还没敲完」的草稿位，不发给后端（空名变量没有渲染语义）
    variables: Object.fromEntries(Object.entries(s.variables).filter(([k]) => k !== "")),
    fail_fast: s.failFast,
    env_id: s.envId,
    env_set: true, // 总是回带：env_set=false 时后端保持原值不动
    max_runtime_set: false,
    // R85 公共断言（后端 405647b 已落地）：UpdateIn 用 common_assertions_set 显式声明位
    // （与 max_runtime_set 同款，None=不改、set+[]=清空）。这里总是回带全量：
    // 场景级面板编辑的就是全量现状。type 为空的行是草稿位（同空 key 变量），不进库。
    // pruneNull 与后端 shared/assertions.prune_rows 同一口径：编辑器切类型会显式清出
    // `code: null` / `timeout_ms: null`（PropsPanel 的 D75/D77 载荷键归零），那些 null 是
    // 「这一型没有这个载荷」的占位，不是内容——留着就会让同一条断言在 api_case 侧
    // （exclude_none 落库）和场景侧长得不一样，「保存 → GET 原样」当场对不上。
    common_assertions: caPayload(s.commonAssertions),
    common_assertions_set: true,
  } as ScenarioUpdateBody;
  // max_runtime 允许清空（null）：只在偏离基线时声明 max_runtime_set，
  // 否则「没碰这一栏」与「把它清了」在请求体里不可分辨。
  if (s.maxRuntimeMs !== s.baselineMaxRuntimeMs) {
    body.max_runtime_set = true;
    body.max_runtime_ms = s.maxRuntimeMs;
  }
  return body;
}

function dedupeIssues(primary: Issue[], secondary: Issue[]): Issue[] {  const seen = new Set<string>();  const out: Issue[] = [];
  for (const i of [...primary, ...secondary]) {
    const id = i.node_key + "|" + i.code + "|" + i.message;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(i);
  }
  return out;
}

/** 顶层移动时「插到 target 之后」的索引；target 不在顶层则返回末尾。 */
function insertIndexAfterTopLevel(nodes: StepNode[], targetKey: string, movedKey: string): number {
  const idx = nodes.findIndex((n) => n.key === targetKey);
  if (idx < 0) return nodes.length;
  // moveNode 先删后插：被拖节点在目标**前面**时，删掉它会把目标往前挪一格，
  // 不补这一格就落到目标后面第二格。同层往下拖才会命中，跨层/往上拖保持 idx + 1。
  const from = nodes.findIndex((n) => n.key === movedKey);
  return from >= 0 && from < idx ? idx : idx + 1;
}

/** dirty：节点树、环境指针、场景级草稿（变量/失败策略/超时/公共断言）偏离上次保存点。
 *  layout 漂移不算——自动布局每次都会重排。 */
export function selectDirty(s: SceneState): boolean {
  return j(s.nodes) !== s.baselineNodes
    || s.envId !== s.baselineEnvId
    || j(s.variables) !== s.baselineVariables
    || s.failFast !== s.baselineFailFast
    || s.maxRuntimeMs !== s.baselineMaxRuntimeMs
    || j(caPayload(s.commonAssertions)) !== s.baselineCommonAssertions;
}

/** 本地 + 服务端 issue 的并集（node_key|code|message 维度）。画布与问题面板共用。 */
export function mergeIssues(nodes: StepNode[], serverIssues: Issue[]): Issue[] {
  return dedupeIssues(validateLocal(nodes), serverIssues);
}
