// ADB 调试面板（1D T9，计划原话「调试面板复用 DebugPanel/R108 断言行/截图内联 R107 三件套」）。
// 与 ui/UiDebugPanel.tsx 是近亲孪生：高度/拖把手 mechanic（DebugDrawer 同源）、断言卡
// （api/DebugPanel 直复）、断言行收集（ui/debugRows 的纯件直复——ADB 的 commands[] 行
// 形状与 UI 同为 {id,type,status,message,elapsed_ms,assertions}，R108 逐键不改）、
// 截图内联（shared/artifactSrc 的 fetchArtifactBlob，用完 revoke）——四件套一根都没另造。
// ADB 侧多出来的两件事（都在头部，不藏）：
// ① mode 徽标：u2=控件树会话 / dump=轮询降级（「慢但判定同一份」，T6 交接：降级不可见
//    是纪律 1 违例）/ null=没连上设备；
// ② device 徽标：真跑在哪台设备（serial）。调试档占用 422 绝不排队（D17），所以这里
//    永远不会出现「排队中」的半截态——发起失败就是发起失败，Alert 直出 422 原话。
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty, Space, Tag, Typography } from "antd";
import { CloseOutlined } from "../ui/icons";
import DebugPanel from "../api/DebugPanel";
import type { DebugResult } from "../api/DebugPanel";
import { fetchArtifactBlob } from "../shared/artifactSrc";
import { STATUSES } from "../shared/runVocab";
import { assertionRows, cmdRows, shotsByStep, DEBUG_ROW } from "../ui/debugRows";
import type { AdbDebugResult } from "../api/adbCase";

const MIN_H = 120;
// 与 UiDebugPanel/DebugDrawer 同一 clamp 公式：300 是 §11.4.12 的标注高，作上限而不是定值。
function defaultHeight(): number {
  return Math.min(300, Math.max(MIN_H, Math.round(window.innerHeight * 0.35)));
}

/** mode 徽标的三态措辞——「降级」要说人话，不写 u2/dump 生码糊弄。 */
export function modeBadge(mode: string | null | undefined): { text: string; color: string } | null {
  if (mode === "u2") return { text: "控件树会话 (u2)", color: "green" };
  if (mode === "dump") return { text: "降级：dump 轮询（慢但判定同一份）", color: "orange" };
  if (mode == null) return null; // 没跑起来：device/执行回执会说话，这里不叠徽标
  return { text: "模式 " + mode, color: "default" }; // 后端加了新模式：照实显示，不猜语义
}

/** 截图缩略：blob → objectURL → <img>，卸载 revoke（与 UiDebugPanel 的 ShotImg 同规矩）。 */
function ShotImg({ runId, name, projectId, testId }: {
  runId: string; name: string; projectId: string; testId: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    let created: string | null = null;
    void fetchArtifactBlob(runId, name, { projectId, silent: true })
      .then((u) => {
        if (dead) { URL.revokeObjectURL(u); return; }
        created = u;
        setUrl(u);
      })
      .catch((e: unknown) => { if (!dead) setErr((e as Error)?.message ?? "截图取不到"); });
    return () => { dead = true; if (created) URL.revokeObjectURL(created); };
  }, [runId, name, projectId]);
  if (err) return <Typography.Text className="tp-text-sm" type="danger">{err}</Typography.Text>;
  if (!url) return <Typography.Text className="tp-text-sm" type="secondary">截图加载中…</Typography.Text>;
  return (
    <img data-testid={testId} src={url} alt={name}
      style={{ maxWidth: 260, maxHeight: 150, border: "1px solid var(--tp-border)", borderRadius: 4 }} />
  );
}

export default function AdbDebugPanel({ result, running, error, note, projectId, onClose }: {
  result: AdbDebugResult | null;
  running: boolean;
  /** 发起本身失败（占用 422 / 不可执行等）——面板说「没有发起」，不演半截结论。 */
  error: string | null;
  /** 发起语义说明（含「本次发起前已代为保存」的出口，adbCaseDetail 组织文案）。 */
  note: string | null;
  projectId: string;
  onClose: () => void;
}) {
  const [height, setHeight] = useState(defaultHeight);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const rows = useMemo(() => cmdRows(result?.commands ?? []), [result]);
  // shotsByStep 只收 SCREENSHOT（VIDEO/LOG 不是图，别硬塞 <img>）；
  // 录屏/日志在「查看报告」里看——面板不放假的播放器。
  const shots = useMemo(() => shotsByStep(result?.artifacts ?? []), [result]);

  // 断言卡直复用 DebugPanel：adb 运行没有 HTTP status/响应体，字段照实缺失
  //（UiDebugPanel 同口径「字段缺失就照实缺失，不编造」）。
  const assertResult: DebugResult | null = result ? {
    run_id: result.run_id,
    ok: result.ok,
    passed: result.passed,
    status: null,
    headers: {},
    body_text: null,
    truncated: false,
    body_size: 0,
    elapsed_ms: result.elapsed_ms,
    error: result.error,
    assertions: assertionRows(result.commands),
    env_name: null,
  } : null;

  const meta = result ? STATUSES[result.status] : null;
  const maxH = Math.round(window.innerHeight * 0.45);
  const varsCount = result ? Object.keys(result.vars ?? {}).length : 0;
  const mode = result ? modeBadge(result.mode) : null;

  return (
    <div data-testid="adb-debug-panel" style={{
      height, minHeight: MIN_H, maxHeight: maxH, background: "var(--tp-bg-container)",
      borderTop: "1px solid var(--tp-border)", display: "flex", flexDirection: "column", flexShrink: 0,
    }}>
      {/* 拖把手：120 ~ 45vh（DebugDrawer/UiDebugPanel 同款 pointer-capture mechanic） */}
      <div data-testid="adb-debug-resize"
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
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 12px",
        borderBottom: "1px solid var(--tp-split)", flexShrink: 0, flexWrap: "wrap" }}>
        <Typography.Text className="tp-text-md" strong>调试</Typography.Text>
        {running && <Tag color="processing" data-testid="adb-debug-badge">运行中</Tag>}
        {!running && error && <Tag color="red" data-testid="adb-debug-badge" data-status="error">发起失败</Tag>}
        {!running && !error && result && (
          <Tag color={meta?.color ?? "default"} data-testid="adb-debug-badge" data-status={result.status}>
            {meta?.label ?? result.status}
          </Tag>
        )}
        {result && !running && (
          <Typography.Text className="tp-text-sm" type="secondary">{result.elapsed_ms}ms</Typography.Text>
        )}
        {/* 降级与设备当场说出（T6 交接：dump 模式界面必须可见） */}
        {result && !running && mode && (
          <Tag color={mode.color} data-testid="adb-debug-mode">{mode.text}</Tag>
        )}
        {result?.device && (
          <Tag data-testid="adb-debug-device">设备 {result.device}</Tag>
        )}
        {result && (
          <Typography.Link data-testid="adb-debug-report-link" href={"#/reports/" + result.run_id}>
            查看报告
          </Typography.Link>
        )}
        <span style={{ flex: 1 }} />
        <Button size="small" type="text" data-testid="adb-debug-close" icon={<CloseOutlined />} onClick={onClose} />
      </div>
      {note && !running && (
        <div className="tp-text-sm" data-testid="adb-debug-note" style={{ padding: "8px 12px", color: "var(--tp-text-2)", borderBottom: "1px solid var(--tp-split)", flexShrink: 0 }}>
          {note}
        </div>
      )}
      {error && !running && (
        <div style={{ padding: "8px 12px" }}>
          <Alert type="error" showIcon message="调试没有发起" description={error} />
        </div>
      )}
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {running && (
          <Typography.Text type="secondary" style={{ display: "block", padding: 12 }}>
            真设备正在跑（每步一条 adb/u2 指令，一轮几秒到几十秒）……跑完这里会出逐步明细。
          </Typography.Text>
        )}
        {!running && !result && !error && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="点「调试」用空闲设备真跑一遍（占用会当场拒绝，不排队）"
            style={{ marginTop: 24 }} />
        )}
        {result && !running && (
          <div style={{ padding: 8 }}>
            <Typography.Text className="tp-text-sm" strong>步骤时间线</Typography.Text>
            {rows.map((r) => (
              <div key={r.id} data-testid="adb-debug-step-row" data-id={r.id} data-status={r.status}
                style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap",
                  padding: "3px 4px", borderBottom: "1px dashed #F0F2F4" }}>
                <Typography.Text className="tp-text-sm" style={{ width: DEBUG_ROW.idW }}>{r.id}</Typography.Text>
                <Typography.Text className="tp-text-sm" style={{ width: DEBUG_ROW.typeW }}>{r.type}</Typography.Text>
                <Tag style={{ marginInlineEnd: 0 }}
                  color={r.status === "pass" ? "green" : r.status === "fail" ? "orange"
                    : r.status === "error" ? "red" : "default"}>{r.status}</Tag>
                <Typography.Text className="tp-text-sm" type="secondary" style={{ width: DEBUG_ROW.elapsedW }}>{r.elapsed_ms}ms</Typography.Text>
                <span className="tp-text-sm" data-testid={"adb-debug-step-message-" + r.id} style={{ color: "var(--tp-text-2)", flex: 1, minWidth: 120 }}>{r.message}</span>
                {(shots[r.id]?.length ?? 0) > 0 && (
                  <Space size={6} wrap style={{ width: "100%", paddingLeft: DEBUG_ROW.indent }}>
                    {shots[r.id].map((s, i) => (
                      <span key={i} style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                        <ShotImg runId={result.run_id} name={s.name} projectId={projectId}
                          testId={"adb-debug-shot-" + r.id} />
                        <Typography.Text className="tp-text-xs" type="secondary">{s.reason}</Typography.Text>
                      </span>
                    ))}
                  </Space>
                )}
              </div>
            ))}
            <div className="tp-text-sm" data-testid="adb-debug-vars" style={{ marginTop: 8 }}>
              <Typography.Text className="tp-text-sm" strong>变量快照（{varsCount}）</Typography.Text>
              {varsCount === 0 ? (
                <Typography.Text type="secondary"> （没有存过变量；screenshot/record 的 save_var
                  与 extract_ui_text 的结果会落在这里）</Typography.Text>
              ) : (
                Object.entries(result.vars).map(([k, v]) => (
                  <div key={k}><Typography.Text code>{"${" + k + "}"}</Typography.Text> = {v}</div>
                ))
              )}
            </div>
            {assertResult && <DebugPanel result={assertResult} />}
          </div>
        )}
      </div>
    </div>
  );
}
