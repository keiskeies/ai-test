// 报告详情（T22，§11.4.16/§11.7.4）：概览卡 → 左步骤树 300 → 中只读结果画布 → 右步骤详情 420。
// 只读画布复用编辑器的 Canvas：store.loadReport 把 summary_graph（graph ⊕ result 快照）
// 灌进同一状态机，结果着色走 run.stepStatus 这条现成通路——编辑器的呼吸高亮和报告的
// 终态着色是同一支笔，不存在「报告画的颜色和执行时不一样」的第二套口径。
// 数据全部来自报告快照：场景 purge 后这里照样整树上色（Review Focus 10 自包含承诺）。
// 诚实条款：running 的报告轮询到终态；stats.rerun_of 存在就明说是单步重跑的报告。
// 1C T19：同一份数据**绝不**开第二套报告页——UI 运行按 kind 在右栏分流：
//   · 命令汇总节点（kind=ui_case 且 detail.commands 在场）→ 命令时间线 + 断言卡
//     （DebugPanel 原样渲染 R108 行）+ 按命令 id 归位的截图；HTTP 请求/响应区
//     对 UI 步没有真数据，照实不渲染（纪律 1：宁可缺一块，不摆假 JSON）。
//   · 命令行（parent_step_key 指向汇总节点）→ 回执 + 该命令的断言/截图，键就是命令 id。
//   · 中间画布对独立 UI 运行只有单节点（R102）——「看起来很空」是形状不是 bug，
//     代价在 UI 运行上明说（③钉它不许撒到 API/场景报告上）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, Button, Card, Descriptions, Space, Spin, Table, Tag, Tooltip, Typography, message } from "antd";
import { CloseOutlined, RedoOutlined, RobotOutlined } from "../ui/icons";
import ProjectGate from "../layout/ProjectGate";
import { modeBadge } from "../adb/AdbDebugPanel";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { reportApi, type ReportDetail as ReportDetailData, type ReportStepSummary } from "../api/report";
import { ApiErr } from "../api/client";
import { sceneApi } from "../api/scene";
import CodeEditor from "../components/CodeEditor";
import DebugPanel from "../api/DebugPanel";
import { fmtTime } from "../shared/timefmt";
import { STEP_STATUSES, STATUSES, SUBJECT_TYPES, TRIGGERS, vocabMeta } from "../shared/runVocab";
import { fetchArtifactBlob } from "../shared/artifactSrc";
import { pctAttr, ratePct } from "../shared/passRate";
import { assertionRows, cmdRows, orderKeysByHints, shotsByCommand, stepTreeHints, stepTreeLabel, DEBUG_ROW,
  type StepTreeHint, type UiArtifactRef } from "../ui/debugRows";
import { PassRing } from "./reports";
import { tp } from "../theme";
import Canvas from "../scene/Canvas";
import { useSceneStore } from "../scene/store";

interface AssertRow {
  type?: string; passed?: boolean; expected?: unknown; actual?: unknown; error?: string | null;
  // R88：公共断言的求值行合进步骤明细，scope="common" 标记「这条来自场景级门」——
  // 处置动作不同（改场景 vs 改这一步），所以必须看得见来源，但不能另起一张卡。
  scope?: string;
}

/** step detail 的 detail 列在 UI/ADB 步上的扩展形状（_execute_ui_run / h_ui_case / h_adb_case 落的键）。 */
interface StepDetailExtra {
  request?: Record<string, unknown>; response?: unknown;
  assertions?: AssertRow[]; logs?: string[]; error?: string | null;
  // UI：命令时间线（ui_core 行，R108）+ 制品摘要。独立运行摘要带 ref（可直接取字节）；
  // 场景内 h_ui_case 的摘要刻意不落 ref（bytes 进 JSON 列的教训），截图走下方制品区。
  commands?: Record<string, unknown>[];
  artifacts?: Array<{ kind?: string; step_key?: string | null; ref?: string;
    bytes?: number | null; reason?: string | null; command?: string | null }>;
  vars?: Record<string, string>;
  message?: string | null;
  // adb_case 汇总行：跑在哪台/什么模式——mode="dump" = 没起 uiautomator2 会话的降级（T6「降级看得见」）。
  mode?: string | null; device?: string | null;
}

/** 步骤详情请求的四态：没选 / 在取 / 取到了 / 取失败。
 *  失败与「没取到所以是 null」必须可分辨——catch 里 setStep(null) 会把
 *  「取不到」演成「正在取」（永久转圈），比演成「没有」更难被发现。 */
type StepLoad =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ok"; data: Awaited<ReturnType<typeof reportApi.stepDetail>> }
  | { kind: "error"; failure: StepFailure };

/** 取不到的四种来路（D142）：以前只有一句「暂时取不到…点重试」，
 *  对着一个结构性缺失也喊「暂时」，人按十次重试还是那句话。 */
type StepFailure = "transient" | "gone" | "run_gone" | "denied";

/** 只认状态码与错误信封的 details，不正则匹配中文 message（D38 同口径）。
 *  两条 404 来路都得认：明细行缺 (`step_key` 在 details 里) 与报告本体没了
 *  （`{run_id}` 一条）在这一个调用点上撞进同一个 catch，而它们要说的话完全不同——
 *  列表页在缺 base 行时会用展开行归并出状态（report_services.py:250-254），
 *  明细端点却要精确匹配 (step_key,row_no)（:322-331），于是这一步**永远**读不到；
 *  而报告被回收时这一页还挂着上一次读到的内容（fetchOnce 只置 failed、不清 report）。 */
function stepFailureOf(e: unknown): StepFailure {
  if (!(e instanceof ApiErr)) return "transient"; // 断网/网关吞连接：没有状态码可依
  if (e.status === 403) return "denied";
  if (e.status === 404 || e.status === 410) {
    const d = e.details as { step_key?: unknown } | null;
    return typeof d?.step_key === "string" ? "gone" : "run_gone";
  }
  return "transient";
}

/** 每种来路的下一句话。`retry` = 递重试钮：只在「再试一次真的可能不同」时才递。
 *  缺明细行是数据本来就没有，喊重试是让人对着死路反复按（纪律 1）；
 *  权限则可能被人补回来，重新请求一次确实可能不同——那才是重试该出现的场合。 */
const STEP_FAIL_TEXT: Record<StepFailure, { message: (step: string) => string; description: string; retry: boolean }> = {
  transient: {
    message: (s) => "「" + s + "」这一步的详情暂时取不到",
    description: "报告本体还在——可能是单步详情落库失败或网络抖动，点重试再看。",
    retry: true,
  },
  gone: {
    message: (s) => "「" + s + "」这一步的明细行本来就没有",
    description: "后端当面回了「不存在」：这一步只有展开行、没有第 0 行汇总"
      + "（后端注释明写 runner 可能这样落，report_services.py:250）。"
      + "明细这一路永远不会有了，跟网络无关——重试也不会变。步骤状态看左栏那一行。",
    retry: false,
  },
  run_gone: {
    message: () => "这份报告已经不在了",
    description: "后端当面回了「不存在」：报告本体已被回收或从未存在。"
      + "这一页上还画着上一次读到的内容，它已经不再是后端的事实。",
    retry: false,
  },
  denied: {
    message: (s) => "「" + s + "」这一步的详情读不了了",
    description: "这一页刚才读得到这份报告，现在这一路回了「没权限」——不是这一步的问题。"
      + "权限补回来之后点重试（或重新选这一步）才可能读到。",
    retry: true,
  },
};

// ── 「让 Pilot 总结失败原因」草稿的三道口径（D84 诚实切片）──
/** 失败步最多列几个：200 步的运行的草稿不能变 50KB 的prompt，超出部分明说没列。 */
const PILOT_STEP_CAP = 8;
/** 单段报错（运行级 / 步骤级）截到这么长：断言 actual 可能整份响应体。 */
const PILOT_TEXT_CLIP = 500;
/** 整段草稿上限：与后端 MessageIn.content max_length=20000 对齐（backend/app/modules/agent/routes.py:33）。 */
const PILOT_DRAFT_MAX = 20000;

/** 截断加省略号；没超长原样返回（不给短文本尾巴上装饰）。 */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function childKeys(steps: ReportStepSummary[]): Map<string, ReportStepSummary[]> {
  const m = new Map<string, ReportStepSummary[]>();
  for (const s of steps) {
    if (!s.parent_step_key) continue;
    const list = m.get(s.parent_step_key) ?? [];
    list.push(s);
    m.set(s.parent_step_key, list);
  }
  return m;
}

function StepTree(props: {
  steps: ReportStepSummary[]; active: string | null; onPick: (k: string) => void;
  hints: Record<string, StepTreeHint>;
}) {
  const byParent = useMemo(() => childKeys(props.steps), [props.steps]);
  const rows: Array<{ s: ReportStepSummary; depth: number; parentKind: string | null }> = [];
  const rec = (parent: string | null, depth: number, parentKind: string | null) => {
    const list = parent === null
      ? props.steps.filter((s) => !s.parent_step_key)
      : byParent.get(parent) ?? [];
    // 后端按 step_key 字母序返回（report_services.py:248），执行顺序在这一步捡回来：
    // 图上读得到的按图上的序，读不到的（独立 UI 运行的命令行）保持原序排在后面。
    const ordered = orderKeysByHints(list.map((s) => s.step_key), props.hints);
    const byKey = new Map(list.map((s) => [s.step_key, s]));
    for (const key of ordered) {
      const s = byKey.get(key);
      if (!s) continue;
      rows.push({ s, depth, parentKind });
      rec(s.step_key, depth + 1, s.kind);
    }
  };
  rec(null, 0, null);
  return (
    <div style={{ overflow: "auto" }}>
      {rows.map(({ s, depth, parentKind }) => {
        const m = vocabMeta(STEP_STATUSES, s.status);
        return (
          <div key={s.step_key + ":" + s.row_no} data-testid="report-step-row"
            data-key={s.step_key} data-status={s.status}
            onClick={() => props.onPick(s.step_key)}
            style={{
              display: "flex", gap: 6, alignItems: "center", cursor: "pointer",
              padding: "4px 8px 4px " + (8 + depth * 14) + "px",
              background: props.active === s.step_key ? "#EAF6F1" : undefined,
            }}>
            <Typography.Text className="tp-text-sm" style={{ flex: 1, minWidth: 0 }}
              ellipsis={{ tooltip: s.step_key }}>
              {/* UI 命令行不能顶著用例名（7 行逐字相同的树读不出哪行是哪条命令），
                  非 UI 步空 subject_name 时退图上的节点名（画布早就显示着它），
                  规则在 ui/debugRows.stepTreeLabel，纯函数有 vitest 钉着 */}
              {stepTreeLabel(s, parentKind, props.hints[s.step_key]?.name)}
            </Typography.Text>
            {/* 数据集步：行进度 3/10（§11.7.4 折叠语义：一行看完整个展开） */}
            {s.total_rows != null && s.total_rows > 0 && (
              <Typography.Text type="secondary" className="tp-text-xs tp-mono">
                {(s.pass_rows ?? 0) + "/" + s.total_rows}
              </Typography.Text>
            )}
            <Tag color={m.color} style={{ marginInlineEnd: 0 }}>{m.label}</Tag>
          </div>
        );
      })}
    </div>
  );
}

/** 制品取字节的三态：没取到 ≠ 取到了（装成绿图正是本任务要防的失败模式）。 */
type BlobLoad = { kind: "loading" } | { kind: "ok"; url: string } | { kind: "error"; message: string };

/**
 * SCREENSHOT 制品：带鉴权 fetch → objectURL → <img> 内联（R107 + T8 魔数嗅探）。
 * 裸 href 点开是 401（Step 0 实测），objectURL 是唯一既带 token 又能内联渲染的路。
 * 取字节失败就如实报错 + 重试，**不许**留一张碎图标或装绿。
 */
function ArtifactImage({ runId, pid, name }: { runId: string; pid: string; name: string }) {
  const [st, setSt] = useState<BlobLoad>({ kind: "loading" });
  const urlRef = useRef<string | null>(null);
  const load = useCallback(() => {
    let dead = false;
    setSt({ kind: "loading" });
    fetchArtifactBlob(runId, name, { projectId: pid })
      .then((url) => {
        if (dead) { URL.revokeObjectURL(url); return; }
        urlRef.current = url;
        setSt({ kind: "ok", url });
      })
      .catch((e: unknown) => {
        if (!dead) setSt({ kind: "error", message: (e as Error)?.message ?? "截图取不到" });
      });
    return () => { dead = true; };
  }, [runId, pid, name]);
  useEffect(() => load(), [load]);
  // 卸载收尾：objectURL 的生命周期跟着这张图，不 leak 到整个报告页
  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);
  // 蓝图 §报告详情 :1544「截图灯箱全屏遮罩,S3」：点缩略图开页内灯箱，不再开新标签页。
  const [lightbox, setLightbox] = useState(false);
  // Esc 挂 window（CommandPalette 同款）：关窗不押「焦点恰好还在缩略图上」
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);
  if (st.kind === "loading") {
    return <Typography.Text className="tp-text-sm" type="secondary" data-testid="report-artifact-img-loading">截图加载中…</Typography.Text>;
  }
  if (st.kind === "error") {
    return <Alert type="warning" showIcon data-testid="report-artifact-img-error"
      message="截图取不到" description={st.message}
      action={<Button size="small" onClick={() => load()}>重试</Button>} />;
  }
  return (
    <>
      <a onClick={() => setLightbox(true)}
        title="点击放大查看" data-testid="report-artifact-img-open">
        {/* naturalWidth>0 由 e2e 钉：src 拼错的碎图标不许演绿（纪律 1） */}
        <img data-testid="report-artifact-img" src={st.url} alt={"失败截图 " + name}
          style={{ maxWidth: "100%", borderRadius: 6, display: "block" }} />
      </a>
      {lightbox && (
        <div role="dialog" aria-label={"失败截图 " + name}
          data-testid="report-artifact-lightbox"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setLightbox(false); }}
          style={{
            position: "fixed", inset: 0, zIndex: 1000, background: tp.mask,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
          <div style={{ position: "relative", background: tp.bg.container, borderRadius: 8,
            padding: 8, boxShadow: tp.shadow.s3 }}>
            <img data-testid="report-artifact-lightbox-img" src={st.url}
              alt={"失败截图 " + name}
              style={{ maxWidth: "88vw", maxHeight: "84vh", objectFit: "contain", display: "block" }} />
            <Button size="small" shape="circle" icon={<CloseOutlined />} aria-label="关闭截图"
              data-testid="report-artifact-lightbox-close"
              onClick={() => setLightbox(false)}
              style={{ position: "absolute", top: 6, right: 6 }} />
            {/* 「看原图」只活在灯箱里：缩略图那一下必须落在灯箱上，不能有跳过它的第二条路 */}
            <Typography.Text className="tp-text-sm" style={{ display: "block", marginTop: 6, textAlign: "right" }}>
              <a href={st.url} target="_blank" rel="noreferrer"
                data-testid="report-artifact-lightbox-origin">看原图</a>
            </Typography.Text>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 非截图制品：仍是链接，但点击走同一个带鉴权 fetch（裸 href 点开就是 401）。
 * objectURL 给新标签页留出加载时间后再回收——立刻 revoke 会把刚打开的标签页
 * 变成 about:blank，那等于没修。
 */
function ArtifactLink({ runId, pid, name, label }:
  { runId: string; pid: string; name: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const url = await fetchArtifactBlob(runId, name, { projectId: pid });
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: unknown) {
      // 与 client.ts 同口径：取不到要 toast 说清楚；401 已在 fetchArtifactBlob 里登出
      const m = (e as Error)?.message;
      if (m) message.error(m);
    } finally {
      setBusy(false);
    }
  };
  return (
    <a data-testid="report-artifact-link" onClick={() => void open()}
      style={busy ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
      {label}
    </a>
  );
}

function Detail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { project, user } = useAuth();
  const pid = project!.id;
  // 重跑是写操作（POST /runs/{id}/rerun-step，perm=scenario:run）：缺位整钮不渲染。
  // 口径抄 schedules.tsx:479 / notifyChannels.tsx:403 的 `{canCreate && <Button/>}`——
  // 写入口隐藏不是禁用（uiCaseDetail.tsx:13 同款），禁用了又不说原因才是 §13 纪律 1 的假门。
  const perms = patternsForProject(project, user?.is_system_admin);
  const canRerun = can(perms, "scenario:run");
  const [report, setReport] = useState<ReportDetailData | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [step, setStep] = useState<StepLoad>({ kind: "none" });
  const [rerunning, setRerunning] = useState(false);
  const [pilotBusy, setPilotBusy] = useState(false);
  const loadReport = useSceneStore((s) => s.loadReport);
  const selectedKey = useSceneStore((s) => s.selectedKey);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchOnce = useCallback(async (): Promise<ReportDetailData | null> => {
    if (!id) return null;
    try {
      const r = await reportApi.get(pid, id);
      setFailed(false);
      return r;
    } catch {
      setFailed(true);
      return null;
    }
  }, [pid, id]);

  useEffect(() => {
    let dead = false;
    const tick = async () => {
      const r = await fetchOnce();
      if (dead || !r) return;
      setReport(r);
      // running/queued：轮询到终态（执行还活着，报告页面跟着长）
      if (r.status === "running" || r.status === "queued") {
        timerRef.current = setTimeout(() => void tick(), 1500);
      }
    };
    void tick();
    return () => { dead = true; if (timerRef.current) clearTimeout(timerRef.current); };
  }, [fetchOnce]);

  // 只读画布装载：summary_graph 变化才灌（每次轮询都换引用会白白重算布局）
  const sgRef = useRef<unknown>(undefined);
  useEffect(() => {
    if (!report?.summary_graph || report.summary_graph === sgRef.current) return;
    sgRef.current = report.summary_graph;
    loadReport(pid, report.summary_graph);
    setActive(null);
  }, [report, pid, loadReport]);

  // 首次装载自动选中第一个失败步（重跑按钮第一眼就有对象；没有失败步就不装选）
  useEffect(() => {
    if (!report || active) return;
    const bad = report.steps.find((s) => s.row_no === 0
      && (s.status === "fail" || s.status === "error"));
    if (bad) setActive(bad.step_key);
  }, [report, active]);

  // 画布点击 → store.selectedKey → 右栏联动（一条选中态，两边共用）
  useEffect(() => { if (selectedKey) setActive(selectedKey); }, [selectedKey]);

  const loadStep = useCallback(() => {
    if (!active || !id) { setStep({ kind: "none" }); return; }
    let dead = false;
    setStep({ kind: "loading" });
    reportApi.stepDetail({ project_id: pid, run_id: id, step_key: active })
      .then((d) => { if (!dead) setStep({ kind: "ok", data: d }); })
      // 失败 ≠ 没选中：左栏选中态不动（选的确实是那一行），右栏如实说取不到 + 给重试
      .catch((e: unknown) => { if (!dead) setStep({ kind: "error", failure: stepFailureOf(e) }); });
    return () => { dead = true; };
  }, [active, id, pid]);

  useEffect(() => loadStep(), [loadStep]);

  // 左树的顺序与名字：读这一份报告自己的 summary_graph 快照（画布用的就是同一份），
  // 不 join 资产表——资产 purge 后这里照样读得出（§14 自包含）。
  // 位置在 early return 之前：hook 不能有条件跑（下面两条 return 会跳过它）。
  const treeHints = useMemo(() => stepTreeHints(report?.summary_graph), [report?.summary_graph]);

  if (failed && !report) {
    return <Alert type="error" showIcon message="报告没取到"
      description="链接可能过期、报告属于别的项目，或网络不通" style={{ margin: 24 }} />;
  }
  if (!report) return <Spin style={{ display: "block", margin: "20vh auto" }} data-testid="report-loading" />;

  const st = vocabMeta(STATUSES, report.status);
  const trig = TRIGGERS[report.trigger] ?? { icon: "?", label: report.trigger, color: "default" as const };
  const subjType = SUBJECT_TYPES[report.subject_type]; // 未知类型渲染原文，绝不回落成「接口」（R112）
  const activeStep0 = report.steps.find((s) => s.step_key === active && s.row_no === 0);
  // R103：命令行不可单步重跑——单独重放第 3 个 click（前面没导航）必然红，那是假红。
  // 命令行 = 汇总节点（kind=ui_case/adb_case）的子女行；重跑只认汇总节点（vars_snapshot 现成）。
  const parentKind = activeStep0?.parent_step_key
    ? report.steps.find((s) => s.step_key === activeStep0.parent_step_key && s.row_no === 0)?.kind
    : undefined;
  // 展示与重跑共用这条判据（D154 补 adb 腿）：命令行既不是 summary_graph 节点，
  // run_single_step 只能回 409 snapshot_missing——钮亮着就是让人去撞那堵墙。
  const isCmdRow = !!activeStep0 && (parentKind === "ui_case" || parentKind === "adb_case");
  const rerunnable = !!activeStep0 && !isCmdRow
    && (activeStep0.status === "fail" || activeStep0.status === "error")
    && (report.status === "failed" || report.status === "error" || report.status === "cancelled");
  const stepArtifacts = (report.artifacts ?? []).filter((a) => !active || a.step_key === active);
  const rerunOf = (report.stats as { rerun_of?: string; rerun_step?: string } | null)?.rerun_of;
  // D143：Pilot 出口门——有失败汇总行或运行级报错才成立（WHY 见渲染处注释）
  const pilotApplies = report.steps.some((s) => s.row_no === 0
    && (s.status === "fail" || s.status === "error")) || !!report.error;

  const rerun = async () => {
    if (!active || !id || !rerunnable) return;
    setRerunning(true);
    try {
      const out = await sceneApi.rerunStep(id, { project_id: pid, step_key: active });
      message.success("步骤重跑完成，已跳到新报告");
      nav("/reports/" + out.run_id);
    } catch {
      /* client 已 toast（snapshot_missing 等），留在本页，历史不动 */
    } finally { setRerunning(false); }
  };

  // D84 报告详情触点（§11.5.9 六触点之一）：预填不偷发——把上下文拼成草稿，
  // nav("/bench", { state: { pilotDraft } }) 落进 Pilot 输入框，人过目后自己按发送。
  // 不给 sessions 加 context 字段（协议变更待业主裁）、不建会话、不发消息（D29）。
  const askPilot = async () => {
    if (!id) return;
    setPilotBusy(true);
    try {
      // 失败步口径与「自动选中」同源：顶层汇总行（row_no=0）的 fail/error。
      // 数据集的按行明细（row_no>0）是同一节点的展开，不重复占额度。
      const bad = report.steps.filter((s) => s.row_no === 0
        && (s.status === "fail" || s.status === "error"));
      const shown = bad.slice(0, PILOT_STEP_CAP);
      // 报错文本不在 ReportStepSummary 上（类型里没有这字段），只有单步 detail 里
      // 才有真数据：按需取列出这几步的详情，取不到/为空就整行省略（宁缺不编）。
      const errs = await Promise.all(shown.map(async (s) => {
        try {
          const d = await reportApi.stepDetail({ project_id: pid, run_id: id, step_key: s.step_key });
          const e = (d.detail as StepDetailExtra | null)?.error;
          return typeof e === "string" && e !== "" ? e : null;
        } catch { return null; }
      }));
      const lines: string[] = ["请帮我总结这份运行报告的失败原因。", ""];
      const subjLabel = SUBJECT_TYPES[report.subject_type]?.label ?? report.subject_type;
      const stLabel = STATUSES[report.status]?.label ?? report.status;
      if (report.subject_name) lines.push("报告对象：" + report.subject_name + "（" + subjLabel + "）");
      lines.push("运行状态：" + stLabel, "报告 ID：" + report.id);
      if (report.env_name) lines.push("环境：" + report.env_name);
      if (report.error) lines.push("运行级报错：" + clip(report.error, PILOT_TEXT_CLIP));
      if (bad.length > 0) {
        // 截断口径说在明面上：列出前 N 个 + 总数，剩下几个没列也讲出来
        lines.push("", bad.length > shown.length
          ? "失败步骤（共 " + bad.length + " 个，只列前 " + shown.length + " 个）："
          : "失败步骤（共 " + bad.length + " 个）：");
        shown.forEach((s, i) => {
          const sParentKind = s.parent_step_key
            ? report.steps.find((p) => p.step_key === s.parent_step_key && p.row_no === 0)?.kind ?? null
            : null;
          lines.push((i + 1) + ". " + stepTreeLabel(s, sParentKind, treeHints[s.step_key]?.name)
            + " · " + s.kind
            + " · " + (STEP_STATUSES[s.status]?.label ?? s.status));
          if (errs[i]) lines.push("   报错：" + clip(errs[i]!, PILOT_TEXT_CLIP));
        });
      }
      // 后端 MessageIn.content max_length=20000（agent/routes.py `class MessageIn` = 69，
      // 注意：别引 :33 —— 那行是 `_register_full_mode_perm`，与本字段无关）：整段兜底截断，
      // 200 步 × 长断言报文也撑不出超限草稿（每段先各自 clip 过，这里只兜意外）。
      const draft = lines.join("\n");
      nav("/bench", { state: { pilotDraft: draft.length > PILOT_DRAFT_MAX
        ? draft.slice(0, PILOT_DRAFT_MAX) : draft } });
    } finally { setPilotBusy(false); }
  };

  const stepData = step.kind === "ok" ? step.data : null;
  const detail = stepData?.detail as StepDetailExtra | null;
  const asserts = detail?.assertions ?? [];
  const logs = detail?.logs ?? [];
  // UI 分流（T19，同页按 kind 不另开页面）：
  //   ui_case 汇总节点 → 命令时间线 + 断言卡（DebugPanel 原样渲染 R108 行）+ 变量快照；
  //   UI 命令行（kind = 命令 type、parent 是 ui_case）→ 回执 + 断言 + 自己的截图，
  //   没有 HTTP 请求/响应——照实不渲染两个永远空的假 JSON 编辑器（纪律 1）。
  // 汇总节点按数据形状分流（D154）：adb_case 与 ui_case 的 detail 同形（commands/vars_snapshot 都在）。
  const isCaseSummary = stepData?.kind === "ui_case" || stepData?.kind === "adb_case";
  const hideHttp = isCaseSummary || isCmdRow;
  // ui/adb 主体结构性不产生 HTTP 请求/响应：未选中态的引导句也不许承诺这两样（D154 后果③）。
  const noHttpSubject = report.subject_type === "ui_case" || report.subject_type === "adb_case";
  // 这两句话里的一个词（「UI 运行」/「1 条 UI 用例」）：从 subject_type 现推，
  // 别再各写一支 adb 分支——两处措辞历来是同一次改动一起改的。
  const subjectWord = SUBJECT_TYPES[report.subject_type]?.label.replace(/ 用例$/, "") ?? report.subject_type;
  // 「步骤」统计行首位计数的尺子（D138）：stats 的 pass/fail/skip/error 按主体类型是两把尺——
  // 场景按顶层节点计（scenario/engine/runner.py:506-510 汇总 top 节点结果，total=len(top)），
  // UI/ADB 用例按命令计（ui_test / adb_test 的 debug_services：`for r in result.commands` 逐命令
  // 累计，total=len(commands)）。后端两把尺都不许动（stats.total 是通过率分母、趋势图也吃它，
  // 裁定出界），所以换的是标签：「N 顶层」（节点尺）和「败 3」（命令尺）并排就是拿两把尺
  // 数同一行。用例类报这里写「N 命令」（数 stats.total），节点尺不上这行——
  // 独立运行的顶层恒为 1，画布提示（report-ui-note）已经说了「1 顶层 = 1 用例」。
  const statsByCommand = report.subject_type === "ui_case" || report.subject_type === "adb_case";
  const adbMode = modeBadge(detail?.mode);
  // 命令行内联截图的数据源：汇总行 detail.artifacts 摘要（独立运行含 ref 可直接取字节；
  // 场景内 h_ui_case 摘要无 ref 会被 shotsByCommand 的 ref 判据挡掉——那些图走下方制品区，
  // 它们按画布步骤 key 归位，stepArtifacts 的现成过滤就能带出来，两种形状都不孤儿）。
  // 每次渲染现算（命令数是个位数，不值得 memo；memo 摆在这会越过上方早退成为条件 Hook）。
  const uiShots = shotsByCommand(
    (detail?.artifacts ?? []).filter((a) => typeof a.ref === "string" && a.ref !== "") as UiArtifactRef[]);
  const uiCmdList = cmdRows(detail?.commands ?? []);
  const uiAssertRows = assertionRows(detail?.commands ?? []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card size="small" data-testid="report-overview"
        title={
          <Space wrap size={6}>
            {/* D141：ReportGetOut.subject_name 是 str（report_services.py:81），类型上就进不了
                旧兜底那个分支——「…已删除」是不可达的死码，且语义为假，删。 */}
            <Typography.Text strong>{report.subject_name}</Typography.Text>
            <Tag color={subjType?.color ?? "default"} data-testid="report-subject-type">
              {subjType?.label ?? report.subject_type}
            </Tag>
            <Tag color={trig.color}>{trig.icon + " " + trig.label}</Tag>
            <Tag color={st.color} data-testid="report-overview-status">{st.label}</Tag>
            {report.env_name && <Tag>{report.env_name}</Tag>}
            {rerunOf && <Tag color="purple">单步重跑 {String((report.stats as { rerun_step?: string } | null)?.rerun_step ?? "")}</Tag>}
          </Space>
        }
        extra={
          <Space>
            {/* D84：预填 Pilot 输入框的诚实出口（同 workbench.tsx:77 口径：无权限门，
                这只是导航+草稿，不碰任何写端点）；点了不发消息，发送键在人手里。
                D143 失败态门（隐藏不是禁用，同 api/DebugPanel.tsx:59）：草稿第一句就是断言，
                屏幕说「通过」时它自相矛盾；蓝图 :1428 把出口成立条件写成「带失败步骤上下文」，
                没有上下文就没有这支出口。 */}
            {pilotApplies && <Button icon={<RobotOutlined />} data-testid="report-ask-pilot"
              loading={pilotBusy} onClick={() => void askPilot()}>
              让 Pilot 总结失败原因
            </Button>}
            {canRerun && (
              <Tooltip title={rerunnable
                ? "只跑选中的这一步：从该步落库快照重建上下文，生成新报告（原报告不动）"
                : isCmdRow
                  ? "命令行不能单步重跑：单独重放中间一条命令（前面没导航）必然假红——要重来请选「用例」节点重跑整案"
                  : "选中失败/错误步骤后可重跑"}>
                <Button type="primary" danger icon={<RedoOutlined />} data-testid="report-rerun"
                  loading={rerunning} disabled={!rerunnable} onClick={() => void rerun()}>
                  失败步骤重跑
                </Button>
              </Tooltip>
            )}
            <Button onClick={() => nav("/reports")}>返回列表</Button>
          </Space>
        }>
        <Space size={24} wrap>
          {/* 外壳这份 data-percent 是 e2e 钉着的契约（web/e2e/reports.spec.mjs 在
              report-overview-pass-rate 上断言它），删不得；但它**不许自己算**——先前这里
              自己 `Math.round(pass_rate*100)` 一份、环里再算一份，两份各自都对时看不出问题，
              改坏任一份另一份还绿（6b V1 变异实测的就是这个形状）。现在两处同取 pctAttr，
              另有不变量断言钉「外壳 == 环」（reportDetail.test.tsx）。 */}
          <span data-testid="report-overview-pass-rate" data-percent={pctAttr(report.pass_rate)}>
            <PassRing rate={report.pass_rate} size={56} />
          </span>
          <Descriptions size="small" column={4} colon={false} items={[
            { key: "pr", label: "通过率", children: report.pass_rate == null
                ? "—" : ratePct(report.pass_rate) + "（跳步不计入分母）" },
            // 场景级公共断言**不在这张卡上单列**：业主裁定改为逐请求步求值后，
            // 没过的那条挂在它命中的步骤行上（那步就是 failed），通过率环与
            // 状态徽标自动一致——上一版「环 100% + 徽标断言失败」的并列说明作废。
            { key: "el", label: "耗时", children: report.elapsed_ms == null ? "—" : report.elapsed_ms + " ms" },
            { key: "who", label: "执行人", children: report.created_by_name ?? "—" },
            { key: "st", label: "开始", children: fmtTime(report.started_at) ?? "—" },
            { key: "fi", label: "结束", children: fmtTime(report.finished_at) ?? "—" },
            { key: "su", label: "步骤", children: (
              <Space size={4} wrap data-testid="report-stats-row">
                {statsByCommand
                  ? String(report.stats?.total ?? 0) + " 命令"
                  : report.steps.filter((s) => !s.parent_step_key && s.row_no === 0).length + " 顶层"}
                <span style={{ color: "#2BA47D" }}>过 {String(report.stats?.pass ?? 0)}</span>
                <span style={{ color: "#D48806" }}>败 {String(report.stats?.fail ?? 0)}</span>
                <span style={{ color: "var(--tp-text-3)" }}>跳 {String(report.stats?.skip ?? 0)}</span>
                <span style={{ color: "#D3564F" }}>错 {String(report.stats?.error ?? 0)}</span>
              </Space>) },
          ]} />
        </Space>
        {report.error && (
          <Alert type="error" showIcon style={{ marginTop: 8 }}
            message={report.error === "执行进程中断" ? "执行进程中断" : "运行结论"}
            description={report.error} data-testid="report-overview-error" />
        )}
        {rerunOf && (
          <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            这是步骤重跑生成的报告，来源：
            <a data-testid="report-rerun-origin" onClick={() => nav("/reports/" + rerunOf)}> 原报告</a>
          </Typography.Paragraph>
        )}
      </Card>

      {/* 三栏同高封顶 min(520px, 50vh)：768 高屏上「概览(≈300) + 520」超视口 → 页滚+卡滚双条 */}
      <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
        <Card size="small" title="步骤" style={{ width: 300, flex: "0 0 300px" }}
          styles={{ body: { padding: 0, maxHeight: "min(520px, 50vh)", overflow: "auto" } }}>
          <StepTree steps={report.steps} active={active} hints={treeHints}
            onPick={(k) => { setActive(k); useSceneStore.getState().select(k); }} />
        </Card>
        <Card size="small" title="结果画布（只读）" style={{ flex: 1, minWidth: 0 }}
          styles={{ body: { padding: 0, height: "min(520px, 50vh)", display: "flex", flexDirection: "column" } }}>
          {/* R102 的代价必须说出口：独立 UI/ADB 运行 = 单节点 summary_graph，中间画布「看起来很空」
              是形状不是 bug。这句话只属于这两类运行——撒到 API/场景报告上就是在说别报告的事。 */}
          {(report.subject_type === "ui_case" || report.subject_type === "adb_case") && (
            <div className="tp-text-sm" data-testid="report-ui-note" style={{ padding: "8px 12px", color: "var(--tp-text-2)", background: "var(--tp-bg-layout)", borderBottom: "1px solid var(--tp-split)", flexShrink: 0 }}>
              1 个顶层步骤 = 1 条 {subjectWord} 用例，命令明细在右栏（画布只有一个节点是 {subjectWord} 运行的形状，不是没跑到）。
            </div>
          )}
          <div data-testid="report-canvas" style={{ flex: 1, minHeight: 0 }}>
            <Canvas />
          </div>
        </Card>
        <Card size="small" title="步骤详情" style={{ width: 420, flex: "0 0 420px" }}
          styles={{ body: { maxHeight: "min(520px, 50vh)", overflow: "auto" } }}>
          <div data-testid="report-step-detail">
            {!active && (
              // UI/ADB 运行结构性没有 HTTP 请求/响应（按 hideHttp 不渲染两个编辑器），
              // 这句引导对这两类报出的是本页永远给不出的两样东西。
              <Typography.Text type="secondary">
                {noHttpSubject
                  ? `点左边的步骤或画布节点，看回执 / 断言 / 日志（${subjectWord} 运行不产生 HTTP 请求与响应）。`
                  : "点左边的步骤或画布节点，看请求 / 响应 / 断言 / 日志。"}
              </Typography.Text>
            )}
            {active && step.kind === "loading" && <Spin size="small" data-testid="report-step-loading" />}
            {active && step.kind === "error" && (
              // 「取不到」不许演成「正在取」：左栏选中态不动，右栏如实报错。
              // 重试钮按来路给（D142）：结构性缺明细行时递一个按了不变的重试，
              // 就是把一句能说死的话推给人反复试。
              (() => {
                const t = STEP_FAIL_TEXT[step.failure];
                return (
                  <Alert type="error" showIcon data-testid="report-step-error"
                    data-failure={step.failure}
                    message={t.message(active)} description={t.description}
                    action={t.retry
                      ? <Button size="small" data-testid="report-step-retry"
                          onClick={() => loadStep()}>重试</Button>
                      : undefined} />
                );
              })()
            )}
            {stepData && (
              <Space direction="vertical" size={10} style={{ width: "100%" }}>
                <Space wrap size={6}>
                  <Typography.Text strong className="tp-mono">{stepData.step_key}</Typography.Text>
                  <Tag color={vocabMeta(STEP_STATUSES, stepData.status).color}>
                    {vocabMeta(STEP_STATUSES, stepData.status).label}</Tag>
                  {stepData.elapsed_ms != null && (
                    <Typography.Text className="tp-text-sm" type="secondary">{stepData.elapsed_ms}ms</Typography.Text>
                  )}
                  {stepData.attempts > 1 && (
                    <Typography.Text className="tp-text-sm" type="secondary">尝试 {stepData.attempts} 次</Typography.Text>
                  )}
                </Space>
                {detail?.error && (
                  <Alert type="error" showIcon message="步骤报错" description={detail.error}
                    data-testid="report-detail-error" />
                )}
                {/* 命令行的回执（_write_step 的 detail.message）：UI 步没有 HTTP 报错时，
                    回执就是这一步说出口的话，不能只有状态色。 */}
                {hideHttp && typeof detail?.message === "string" && detail.message !== "" && (
                  <Typography.Paragraph className="tp-text-sm" style={{ marginBottom: 0 }}
                    data-testid="report-cmd-message">{detail.message}</Typography.Paragraph>
                )}
                {/* 汇总行：跑在哪台、u2 还是降级当场说出（T6「降级看得见」与调试面板同一支笔）。
                    纯按数据分流：全仓只有 adb 侧往 detail 写 mode/device，UI 步这俩恒缺 →
                    整块不出；mode/device 都为 null（设备没连上）也不摆空徽标行。 */}
                {(detail?.device || adbMode) && (
                  <Space size={6} wrap data-testid="report-adb-device">
                    {detail?.device && <Tag>设备 {detail.device}</Tag>}
                    {adbMode && <Tag color={adbMode.color}>{adbMode.text}</Tag>}
                  </Space>
                )}
                {/* UI/ADB 汇总节点：命令时间线（逐条状态/耗时/回执 + 按命令 id 归位的截图）。
                    截图字节 = 独立运行 detail.artifacts 摘要里的 ref（命令 id 形状）；
                    场景内 UI 制品按画布步骤 key，由下方制品区块带出（步骤 key 形状）。
                    adb 与 UI 的 commands[] 同形（handlers.py 的 h_adb_case 落同一套键），
                    所以这块以前少 adb 一条腿 = 逐命令回执整块不上屏（D154 后果①）。 */}
                {isCaseSummary && (
                  <div data-testid="report-ui-commands">
                    <Typography.Text className="tp-text-sm" strong>命令时间线（{uiCmdList.length}）</Typography.Text>
                    {uiCmdList.length === 0 && (
                      <Typography.Text className="tp-text-sm" type="secondary">
                        这次运行没有留下命令行{detail?.error ? "（用例没跑成，看上方报错）" : "（执行核没回命令结果——数据缺失，不编造）"}
                      </Typography.Text>
                    )}
                    {uiCmdList.map((r) => (
                      <div key={r.id} data-testid="report-cmd-row" data-id={r.id} data-status={r.status}
                        style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap",
                          padding: "3px 4px", borderBottom: "1px dashed #F0F2F4" }}>
                        <Typography.Text className="tp-text-sm tp-mono" style={{ width: DEBUG_ROW.idW }}>{r.id}</Typography.Text>
                        <Typography.Text className="tp-text-sm" style={{ width: DEBUG_ROW.typeW }}>{r.type}</Typography.Text>
                        <Tag style={{ marginInlineEnd: 0 }}
                          color={vocabMeta(STEP_STATUSES, r.status).color}>
                          {vocabMeta(STEP_STATUSES, r.status).label}</Tag>
                        <Typography.Text className="tp-text-sm" type="secondary" style={{ width: DEBUG_ROW.elapsedW }}>{r.elapsed_ms}ms</Typography.Text>
                        <span className="tp-text-sm" style={{ color: "var(--tp-text-2)", flex: 1, minWidth: 120 }}>{r.message}</span>
                        {(uiShots[r.id]?.length ?? 0) > 0 && (
                          <Space size={6} wrap style={{ width: "100%", paddingLeft: DEBUG_ROW.indent }}>
                            {uiShots[r.id].map((s, i) => (
                              <span key={i} style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                                <ArtifactImage runId={id!} pid={pid} name={s.name} />
                                <Typography.Text className="tp-text-xs" type="secondary">{s.reason}</Typography.Text>
                              </span>
                            ))}
                          </Space>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {/* UI/ADB 运行的断言卡：DebugPanel 原样渲染 R108 行（和调试面板同一支笔）。
                    汇总节点从 commands 收行；命令行自己的 detail.assertions 走下面的表。 */}
                {isCaseSummary && uiAssertRows.length > 0 && (
                  <DebugPanel result={{
                    run_id: id ?? "", ok: true,
                    passed: (detail?.commands ?? []).every((c) => c?.status !== "fail" && c?.status !== "error"),
                    status: null, headers: {}, body_text: null, truncated: false, body_size: 0,
                    elapsed_ms: stepData?.elapsed_ms ?? 0, error: detail?.error ?? null,
                    assertions: uiAssertRows, env_name: report.env_name,
                  }} />
                )}
                {isCaseSummary && (
                  <div data-testid="report-ui-vars">
                    <Typography.Text className="tp-text-sm" strong>
                      变量快照（{Object.keys(stepData?.vars_snapshot ?? {}).length}）</Typography.Text>
                    {Object.keys(stepData?.vars_snapshot ?? {}).length === 0 ? (
                      <Typography.Text className="tp-text-sm" type="secondary">（没有存过变量）</Typography.Text>
                    ) : Object.entries(stepData?.vars_snapshot ?? {}).map(([k, v]) => (
                      <div className="tp-text-sm" key={k}>
                        <Typography.Text code>{"${" + k + "}"}</Typography.Text> = {String(v)}
                      </div>
                    ))}
                  </div>
                )}
                {!isCaseSummary && asserts.length > 0 && (
                  <Table<AssertRow> size="small" rowKey={(_, i) => String(i)} pagination={false}
                    dataSource={asserts}
                    columns={[
                      { title: "项", dataIndex: "type", width: 110,
                        render: (v: string | undefined, r: AssertRow) => (
                          <Space size={4}>
                            <span>{v ?? "?"}</span>
                            {r.scope === "common" && (
                              <Tag color="purple" style={{ marginInlineEnd: 0 }}
                                data-testid="report-assert-scope">场景级</Tag>
                            )}
                          </Space>) },
                      { title: "预期", dataIndex: "expected", ellipsis: true,
                        render: (v: unknown) => <span className="tp-mono">{JSON.stringify(v ?? null)}</span> },
                      { title: "实际", dataIndex: "actual", ellipsis: true,
                        render: (v: unknown) => <span className="tp-mono">{JSON.stringify(v ?? null)}</span> },
                      { title: "", dataIndex: "passed", width: 36, render: (v: boolean) => (
                        <span data-testid="report-assert-mark" style={{ color: v ? "#2BA47D" : "#D3564F" }}>
                          {v ? "✓" : "✗"}
                        </span>) },
                    ]}
                    rowClassName={() => "assert-row"}
                    components={{ body: { row: (p: React.HTMLAttributes<HTMLTableRowElement>) => (
                      <tr {...p} data-testid="report-assert-row" />) } }} />
                )}
                {/* HTTP 请求/响应只属于 HTTP 步：UI 步的 detail 里没有这两样真数据，
                    摆一个空 JSON 编辑器就是装样子（纪律 1），分流后整块不渲染。 */}
                {!hideHttp && (
                  <div>
                    <Typography.Text className="tp-text-sm" type="secondary">请求</Typography.Text>
                    <CodeEditor readOnly height={152} language="json"
                      value={JSON.stringify(detail?.request ?? {}, null, 2)} />
                  </div>
                )}
                {!hideHttp && (
                  <div>
                    <Typography.Text className="tp-text-sm" type="secondary">响应</Typography.Text>
                    <CodeEditor readOnly height={160} language="json"
                      value={JSON.stringify(detail?.response ?? null, null, 2)} />
                  </div>
                )}
                {logs.length > 0 && (
                  <div>
                    <Typography.Text className="tp-text-sm" type="secondary">日志</Typography.Text>
                    <pre className=" tp-text-sm" data-testid="report-detail-logs"
                      style={{ margin: 0, background: "var(--tp-bg-layout)", padding: 8, borderRadius: 6, whiteSpace: "pre-wrap" }}>
                      {logs.join("\n")}
                    </pre>
                  </div>
                )}
                {stepArtifacts.length > 0 && (
                  <div>
                    {/* 原话「超阈值外置的原始字节」是错的：64KB 阈值只存在于 offload_detail
                        （step detail 内大字段外置，不产生这里列出的 run_artifact 行）；
                        本区条目来自 save_artifact，截图/DOM 无条件入库、与大小无关。 */}
                    <Typography.Text className="tp-text-sm" type="secondary">制品（截图/DOM 等外置的原始字节）</Typography.Text>
                    {stepArtifacts.map((a) => {
                      const name = String(a.ref).split("/").pop() ?? a.ref;
                      const label = a.kind + " · " + name + "（" + (a.bytes ?? "?") + "B）";
                      return (
                        <div className="tp-text-sm" key={a.ref} style={{ marginTop: 4 }}>
                          {a.kind === "SCREENSHOT" ? (
                            // R107：截图内联 = 带 token fetch → Blob → objectURL；
                            // 裸 href 点开是 401（T11 Step 0 端到端实测），不能留。
                            <>
                              <Typography.Text className="tp-text-sm" type="secondary">{label}</Typography.Text>
                              <ArtifactImage runId={id!} pid={pid} name={name} />
                            </>
                          ) : (
                            <ArtifactLink runId={id!} pid={pid} name={name} label={label} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Space>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function ReportDetailPage() {
  return (
    <div data-testid="page-report-detail">
      <ProjectGate>
        <Detail />
      </ProjectGate>
    </div>
  );
}
