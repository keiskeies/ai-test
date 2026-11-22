// 底部运行抽屉（T20/T21，§11.5.6/§11.7.3/§12.2）：调试跑**未保存草稿**（trigger=debug），
// 执行跑**库里已保存**的场景（trigger=manual）——同一状态机、同一抽屉，只差发起端点。
// 进度来源 T21 起是 SSE run 通道（openRunStream：seq 去重 + Last-Event-ID 断线续传），
// 原始帧留在 store.run.events——画布呼吸高亮与抽屉日志共用同一份事实，不各订一路。
// 步骤详情（请求/响应/日志）仍走 report_get/stepDetail：那是落库的取证面，不是进度面。
// 诚实条款：debug 不回写「最近结果」（Review Focus 11），抽屉展示的就是过程本身。
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Spin, Tag, Typography, message } from "antd";
import { CloseOutlined } from "../ui/icons";
import { reportApi } from "../api/report";
import { sceneApi } from "../api/scene";
import { openRunStream } from "../shared/sse";
import { STEP_STATUSES, STATUSES } from "../shared/runVocab";
import { walk, toGraphV1 } from "./graphOps";
import { selectDirty, useSceneStore, type RunStepState } from "./store";

const MIN_H = 120;

function defaultHeight(): number {
  return Math.min(300, Math.max(MIN_H, Math.round(window.innerHeight * 0.35)));
}

interface StepDetailData {
  step_key: string;
  kind: string;
  status: string;
  detail: Record<string, unknown> | null;
  /** 这次详情请求本身失败了：空 detail 既可能是「这步确实没日志」也可能是「没取到」。 */
  failed?: boolean;
}

export default function DebugDrawer() {
  const open = useSceneStore((s) => s.run.open);
  const trigger = useSceneStore((s) => s.run.trigger);
  const runId = useSceneStore((s) => s.run.runId);
  const phase = useSceneStore((s) => s.run.phase); // idle | starting | running | done | error
  const errorText = useSceneStore((s) => s.run.errorText);
  const finalStatus = useSceneStore((s) => s.run.finalStatus);
  const stats = useSceneStore((s) => s.run.stats);
  const stepStatus = useSceneStore((s) => s.run.stepStatus);
  const events = useSceneStore((s) => s.run.events);
  const closeRun = useSceneStore((s) => s.closeRun);
  const [height, setHeight] = useState(defaultHeight);
  const [detail, setDetail] = useState<StepDetailData | null>(null);
  // 断流信号 = openStream 的 onDown/onOpen（shared/sse.ts 每次断连必发 onDown、
  // 每次连上必发 onOpen）。断流期间旧标签「SSE 实时进度」就是假话——进度恰恰不实时了。
  const [streamDown, setStreamDown] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // SSE 订阅跟着 (runId, phase) 走：新一轮 runId 变化时旧流随 cleanup 关掉，
  // 终态（phase≠running）流也随 cleanup 停——run_end 之后徽标不再变是这条保证的，
  // 不是「凑巧没事件」。attachRun 先置 runId 再订流：服务端从 seq>cursor 重放，
  // 订阅前发生的事件重放补齐，不丢。
  // 诚实条款：终态只由 SSE run_end 这一条路收敛，没有轮询兜底——断流且始终接不上时
  // run 停在 running，这里用 onDown/onOpen 把「流断了」如实标出来，不装「实时进度」。
  useEffect(() => {
    if (!runId || phase !== "running") return;
    setStreamDown(false); // 新一轮/重挂：旧断流结论作废
    const pid = useSceneStore.getState().projectId;
    const handle = openRunStream(pid, runId, {
      onEvent: (ev) => {
        // 迟到的旧流帧由 store 的 runId 判据挡掉；这里只转事实
        useSceneStore.getState().applyRunEvent({ seq: ev.seq, type: ev.type, payload: ev.payload });
      },
      onOpen: () => setStreamDown(false), // 续传成功（Last-Event-ID 补差集），进度恢复实时
      onDown: () => {
        setStreamDown(true); // 断连进入 1500ms 重连间隙
        // D150：断流计数进 store，连续第 3 次触发一次性对账（noteStreamDown：取一次
        // run 详情，终态就走 finishRun 收敛——流真死透时 run 不再永远停在 running）。
        useSceneStore.getState().noteStreamDown();
      },
    });
    return () => handle.close();
  }, [runId, phase]);

  // 新一轮发起时旧的步骤详情作废（旧 run 的响应混进新树会演「秒回」假象）。
  // 只清空挡不住已经在飞的请求——序号自增把那些旧回应一起作废。
  // 每一次点击认领自己发起的那一份：乱序到达的（慢步骤 A 盖过快步骤 B）
  // 与换轮之后才回来的旧请求都在这里丢掉，不进 detail。
  const detailSeq = useRef(0);
  useEffect(() => {
    detailSeq.current += 1;
    setDetail(null);
  }, [runId]);

  // 步骤名来自当前草稿的节点树：debug 跑的就是这份草稿，manual 时它与库内图一致
  const names = useMemo(() => {
    const m = new Map<string, string>();
    const nodes = useSceneStore.getState().nodes;
    for (const [n] of walk(nodes)) m.set(n.key, n.name || n.key);
    return m;
    // stepStatus/phase 变化时重取：抽屉只在有运行会话时渲染，树在运行中不变，
    // 但要保证名字始终来自「本轮发起时」的节点树
  }, [stepStatus, phase]);

  const pickStep = async (key: string, st: RunStepState) => {
    const pid = useSceneStore.getState().projectId;
    if (!runId) return;
    const seq = ++detailSeq.current;
    try {
      const d = await reportApi.stepDetail({ project_id: pid, run_id: runId, step_key: key });
      if (seq !== detailSeq.current) return; // 用户已经点了别的步 / 已经换轮
      setDetail({ step_key: d.step_key, kind: d.kind, status: d.status, detail: d.detail });
    } catch {
      if (seq !== detailSeq.current) return;
      // client 已经 toast 过了，但右侧详情区不能因此回到「点左边的步骤看…」——
      // 用户明明点了，只是没取到。记一条失败态，让面板自己说清这件事。
      setDetail({ step_key: key, kind: "", status: st.status, detail: null, failed: true });
    }
  };

  const logs = useMemo(() => {
    const d = detail?.detail as { logs?: string[]; response?: unknown; request?: Record<string, unknown> } | null;
    if (!d) return [];
    const out: string[] = [];
    if (d.request) out.push("→ " + String(d.request.method ?? "GET") + " " + String(d.request.url ?? ""));
    if (d.response !== undefined) out.push("← " + JSON.stringify(d.response));
    for (const l of d.logs ?? []) out.push(l);
    return out;
  }, [detail]);

  if (!open) return null;
  const maxH = Math.round(window.innerHeight * 0.6);
  const badgeStatus = phase === "running" ? "running" : phase === "done" ? finalStatus : null;
  const badge = phase === "error"
    ? <Tag color="red" data-testid="debug-run-badge" data-status="error">发起失败</Tag>
    : badgeStatus
      ? <Tag color={STATUSES[badgeStatus]?.color ?? "default"} data-testid="debug-run-badge"
          data-status={badgeStatus}>
          {STATUSES[badgeStatus]?.label ?? badgeStatus}
        </Tag>
      : null;
  const rows = Object.entries(stepStatus);

  return (
    <div data-testid="debug-drawer" style={{
      height, minHeight: MIN_H, maxHeight: maxH, background: "var(--tp-bg-container)",
      borderTop: "1px solid var(--tp-border)", display: "flex", flexDirection: "column", flexShrink: 0,
    }}>
      {/* 拖把手：120 ~ 60vh（§11.7.3） */}
      <div data-testid="debug-resize"
        onPointerDown={(e) => {
          dragRef.current = { startY: e.clientY, startH: height };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const dh = dragRef.current.startH + (dragRef.current.startY - e.clientY);
          setHeight(Math.min(maxH, Math.max(MIN_H, dh)));
        }}
        onPointerUp={() => { dragRef.current = null; }}
        style={{ height: 6, cursor: "ns-resize", background: "#F2F6F4", flexShrink: 0 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px", borderBottom: "1px solid var(--tp-split)" }}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          {trigger === "debug" ? "调试（未保存草稿）" : "执行（已保存场景）"}
        </Typography.Text>
        {badge}
        {phase === "done" && typeof stats?.elapsed_ms === "number" && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{stats.elapsed_ms}ms</Typography.Text>
        )}
        <span style={{ flex: 1 }} />
        {phase === "running" && (
          <Typography.Text type="secondary" data-testid="debug-progress-label" style={{ fontSize: 12 }}>
            {streamDown ? "进度流断了，正在重连——期间状态可能不再更新" : "SSE 实时进度"}
          </Typography.Text>
        )}
        {runId && phase === "done" && (
          <Typography.Link data-testid="debug-report-link" href={"#/reports/" + runId}>查看报告</Typography.Link>
        )}
        <Button size="small" type="text" data-testid="debug-drawer-close"
          icon={<CloseOutlined />} onClick={closeRun} />
      </div>
      {phase === "error" && (
        <div style={{ padding: "8px 12px" }}>
          <Alert type="error" showIcon message="运行没有发起" description={errorText ?? "未知错误"} />
        </div>
      )}
      {stats && (
        <div data-testid="debug-stats" data-stats={JSON.stringify(stats)}
          style={{ padding: "2px 12px", borderBottom: "1px solid var(--tp-split)", fontSize: 12, color: "var(--tp-text-2)" }}>
          共 {String(stats.total ?? 0)} · 过 {String(stats.pass ?? 0)} · 败 {String(stats.fail ?? 0)}
          {" · 跳 "}{String(stats.skip ?? 0)} · 错 {String(stats.error ?? 0)} · 取消 {String(stats.cancelled ?? 0)}
        </div>
      )}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ width: 300, borderRight: "1px solid var(--tp-split)", overflow: "auto", padding: "4px 0" }}>
          {phase === "running" && rows.length === 0 && (
            <Spin size="small" style={{ margin: 16 }} data-testid="debug-loading" />
          )}
          {rows.map(([key, st]) => (
            <div key={key} data-testid="debug-step-row" data-key={key} data-status={st.status}
              onClick={() => void pickStep(key, st)}
              style={{
                display: "flex", gap: 8, alignItems: "center", padding: "3px 12px", cursor: "pointer",
                background: detail?.step_key === key ? "#EAF6F1" : undefined,
              }}>
              <Typography.Text style={{ fontSize: 12, flex: 1, minWidth: 0 }}
                ellipsis={{ tooltip: key }}>{names.get(key) ?? key}</Typography.Text>
              {st.rowProgress && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>{st.rowProgress}</Typography.Text>
              )}
              <Tag data-testid={"debug-step-status-" + key}
                color={STEP_STATUSES[st.status]?.color ?? "default"} style={{ marginInlineEnd: 0 }}>
                {STEP_STATUSES[st.status]?.label ?? st.status}
              </Tag>
            </div>
          ))}
        </div>
        <div data-testid="debug-step-detail" style={{ flex: 1, overflow: "auto", padding: 8, fontFamily: "Consolas, monospace", fontSize: 12 }}>
          {!detail && !logs.length && (
            <Typography.Text type="secondary">点左边的步骤看请求 / 响应 / 日志。</Typography.Text>
          )}
          {detail?.failed && (
            <Alert type="warning" showIcon data-testid="debug-step-detail-failed"
              message="这一步的详情没取到"
              description="请求没成功或后端没应答（原话见上方提示）。步骤状态来自 SSE，仍然作数；这里缺的只是请求 / 响应 / 日志。" />
          )}
          {logs.map((l, i) => (
            <div key={"log" + i} data-testid="debug-log-line" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{l}</div>
          ))}
          {events.map((ev) => (
            <div key={ev.seq} data-testid="debug-event-line" data-seq={ev.seq}
              style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--tp-text-3)" }}>
              [{String(ev.seq).padStart(3, " ")}] {ev.type}
              {typeof ev.payload.key === "string" ? " " + ev.payload.key : ""}
              {ev.payload.row_progress ? " " + String(ev.payload.row_progress) : ""}
              {typeof ev.payload.message === "string" ? " — " + ev.payload.message : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 「点了执行但没跑起来」到底卡在哪：save() 的三条失败路留在 store 上的痕迹不一样，
 * 出路也不一样——一律喊「先处理问题面板」会把人支使到一张本来就没行的面板。
 */
function saveBlockedReason(s: ReturnType<typeof useSceneStore.getState>): string {
  if (s.conflict) return "保存撞上版本冲突，请先在弹出的冲突框里裁决（用我的/用服务器的）";
  if (s.refused) return "保存被校验拒了，先看右侧问题面板里列出的行";
  return "保存请求本身没成功（原话见上方提示），与图里的内容无关——重试或看后端日志";
}

/**
 * 发起一轮运行（SceneEditor 顶栏调用）：
 * - debug：把当前**未保存**草稿发给 scenario_debug（§11.5.6 的调试语义）；
 * - manual：执行跑的是**库里已保存**的图——有未保存修改先保存，保存被拒（本地校验/冲突）
 *   就如实停下，绝不「拿草稿演执行」。
 */
// F3：一次发起从「点击」跨到「attachRun/failRun 落地」，中间那一格两个钮都可再点
// （manual+脏要先 await save()，debug 钮本来就没 disabled）。再入 = 两个 run 在飞，
// 后到的 attachRun 覆盖 runId，先发起那个从此没人追进度，而它晚到的 failRun 会把新 run
// 的 phase 洗成 error。门放在这里而不是按钮上：顶栏那条口径（disabled 只跟 runPhase 走、
// dirty 只改 title）照旧成立，被挡的是同一轮发起的再入，不是「上一轮还在跑就不许再点」。
let startingRun = false;

export async function startRun(trigger: "debug" | "manual"): Promise<void> {
  if (startingRun) return;
  const s = useSceneStore.getState();
  if (!s.scenario) return;
  startingRun = true;
  try {
    if (trigger === "manual" && selectDirty(s)) {
      await s.save();
      if (selectDirty(useSceneStore.getState())) {
        message.error("执行跑的是已保存的场景：" + saveBlockedReason(useSceneStore.getState()));
        return;
      }
    }
    const st = useSceneStore.getState();
    st.beginRun(trigger);
    const out = trigger === "debug"
      ? await sceneApi.debug(st.scenario!.id, {
          project_id: st.projectId,
          graph: toGraphV1(st.nodes, st.layout) as unknown as Record<string, unknown>,
          variables: Object.fromEntries(Object.entries(st.variables).filter(([k]) => k !== "")),
          env_id: st.envId,
          // 裁定①同源：草稿里改了失败策略没保存就点调试，执行按草稿来（后端 d326ab3
          // 接的就是这个字段；缺省 None=继承保存行，那是「没改」不是「按默认」）。
          // 注意：公共断言**不走** debug 请求体——后端 405647b 的快照在 enqueue 时取
          // **保存行**（ScenarioDebugIn 没有该字段；面板草稿改了没保存就调试，执行按
          // 保存行判）。前端不偷传一个会被静默忽略的字段假装草稿生效。
          fail_fast: st.failFast,
        } as Parameters<typeof sceneApi.debug>[1])
      : await sceneApi.run(st.scenario!.id, { project_id: st.projectId, env_id: st.envId });
    useSceneStore.getState().attachRun(out.run_id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    useSceneStore.getState().failRun(msg);
  } finally {
    startingRun = false;
  }
}
