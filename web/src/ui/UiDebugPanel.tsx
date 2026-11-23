// UI 调试面板（T17，§11.4.12 底部那个「300」）：默认高 min(300, 35vh)（clamp ≥120）、
// 拖把手 120~45vh——高度与拖拽手感与 scene/DebugDrawer.tsx 同一套 clamp 公式（同一套 pointer-capture）。
// 组成（计划原话：UI 专属块在断言面板**旁边**，不是替换）：
//   ① 命令时间线：逐条状态/耗时/回执（数据 = UiDebugOut.commands，ui_core 行逐键不改）
//   ② 断言卡：**直接复用 api/DebugPanel.tsx**（R108 行形状 {type,passed,expected,actual,error,path}）
//   ③ 失败/终态截图：按命令行内联，字节走 shared/artifactSrc 的 fetchArtifactBlob（R107，用完 revoke）
//   ④ 变量快照：vars 摊开（save_var 的最终值）
// 诚实条款：蓝图说的「控制台输出」后端执行核没有采集（ui_core 不接 page.on("console")），
// 界面上不摆一个永远空的 Console 块——这里展示 vars 快照并写明白，差异记录上报。
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty, Space, Tag, Typography } from "antd";
import { CloseOutlined } from "../ui/icons";
import DebugPanel from "../api/DebugPanel";
import type { DebugResult } from "../api/DebugPanel";
import { fetchArtifactBlob } from "../shared/artifactSrc";
import { STATUSES } from "../shared/runVocab";
import { assertionRows, cmdRows, shotsByStep, DEBUG_ROW, type UiDebugResult } from "./debugRows";

const MIN_H = 120;

// 与 DebugDrawer.defaultHeight 同一公式：300 是 §11.4.12 的标注高，作上限而不是定值。
function defaultHeight(): number {
  return Math.min(300, Math.max(MIN_H, Math.round(window.innerHeight * 0.35)));
}

/** 截图缩略：blob → objectURL → <img>，卸载 revoke（artifactSrc 的「谁创建谁释放」口径）。 */
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

export default function UiDebugPanel({ result, running, error, note, projectId, onClose }: {
  result: UiDebugResult | null;
  running: boolean;
  /** 发起本身失败（422 不可执行等）——面板说「没有发起」，不演半截结论。 */
  error: string | null;
  /** 发起语义说明（含「本次发起前已代为保存」的出口，uiCaseDetail 组织文案）。 */
  note: string | null;
  projectId: string;
  onClose: () => void;
}) {
  const [height, setHeight] = useState(defaultHeight);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const rows = useMemo(() => cmdRows(result?.commands ?? []), [result]);
  const shots = useMemo(() => shotsByStep(result?.artifacts ?? []), [result]);

  // 断言卡直接复用 DebugPanel：UI 运行没有 HTTP status/响应体，这些字段照实缺失
  //（runs.tsx toResult 同口径「字段缺失就照实缺失，不编造」）。结论徽标在本面板头部自己给。
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
    env_name: result.env_name,
  } : null;

  const meta = result ? STATUSES[result.status] : null;
  const maxH = Math.round(window.innerHeight * 0.45);
  const varsCount = result ? Object.keys(result.vars ?? {}).length : 0;

  return (
    <div data-testid="ui-debug-panel" style={{
      // 停靠：父链（uiCaseDetail，非本页可改）的滚动容器是 .tp-main-content，
      // sticky bottom 让面板钉在视口底，内容再长也不把调试台卷出屏幕
      position: "sticky", bottom: 0, zIndex: 5,
      height, minHeight: MIN_H, maxHeight: maxH, background: "var(--tp-bg-container)",
      borderTop: "1px solid var(--tp-border)", display: "flex", flexDirection: "column", flexShrink: 0,
    }}>
      {/* 拖把手：120 ~ 45vh（DebugDrawer 同款 clamp） */}
      <div data-testid="ui-debug-resize"
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
        style={{ height: 6, cursor: "ns-resize", background: "var(--tp-bg-hover)", flexShrink: 0 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
        borderBottom: "1px solid var(--tp-split)", flexShrink: 0 }}>
        <Typography.Text className="tp-text-md" strong>调试</Typography.Text>
        {running && <Tag color="processing" data-testid="ui-debug-badge">运行中</Tag>}
        {!running && error && <Tag color="red" data-testid="ui-debug-badge" data-status="error">发起失败</Tag>}
        {!running && !error && result && (
          <Tag color={meta?.color ?? "default"} data-testid="ui-debug-badge" data-status={result.status}>
            {meta?.label ?? result.status}
          </Tag>
        )}
        {result && !running && (
          <Typography.Text className="tp-text-sm" type="secondary">{result.elapsed_ms}ms</Typography.Text>
        )}
        {result?.env_name && <Tag>{result.env_name}</Tag>}
        {result && (
          <Typography.Link data-testid="ui-debug-report-link" href={"#/reports/" + result.run_id}>
            查看报告
          </Typography.Link>
        )}
        <span style={{ flex: 1 }} />
        <Button size="small" type="text" data-testid="ui-debug-close" icon={<CloseOutlined />} onClick={onClose} />
      </div>
      {note && !running && (
        <div className="tp-text-sm" data-testid="ui-debug-note" style={{ padding: "8px 12px", color: "var(--tp-text-2)", borderBottom: "1px solid var(--tp-split)", flexShrink: 0 }}>
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
            真浏览器正在跑（无头 Playwright 打靶场，一轮几秒到十几秒）……跑完这里会出逐命令明细。
          </Typography.Text>
        )}
        {!running && !result && !error && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="点「调试」用真浏览器跑一遍"
            style={{ marginTop: 24 }} />
        )}
        {result && !running && (
          <div style={{ padding: 8 }}>
            <Typography.Text className="tp-text-sm" strong>命令时间线</Typography.Text>
            {rows.map((r) => (
              <div key={r.id} data-testid="debug-cmd-row" data-id={r.id} data-status={r.status}
                style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap",
                  padding: "8px 8px", borderBottom: "1px dashed var(--tp-split)" }}>
                <Typography.Text className="tp-text-sm" style={{ width: DEBUG_ROW.idW }}>{r.id}</Typography.Text>
                <Typography.Text className="tp-text-sm" style={{ width: DEBUG_ROW.typeW }}>{r.type}</Typography.Text>
                <Tag style={{ marginInlineEnd: 0 }}
                  color={r.status === "pass" ? "green" : r.status === "fail" ? "orange"
                    : r.status === "error" ? "red" : "default"}>{r.status}</Tag>
                <Typography.Text className="tp-text-sm" type="secondary" style={{ width: DEBUG_ROW.elapsedW }}>{r.elapsed_ms}ms</Typography.Text>
                <span className="tp-text-sm" data-testid={"debug-cmd-message-" + r.id} style={{ color: "var(--tp-text-2)", flex: 1, minWidth: 120 }}>{r.message}</span>
                {(shots[r.id]?.length ?? 0) > 0 && (
                  <Space size={8} wrap style={{ width: "100%", paddingLeft: DEBUG_ROW.indent }}>
                    {shots[r.id].map((s, i) => (
                      <span key={i} style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                        <ShotImg runId={result.run_id} name={s.name} projectId={projectId}
                          testId={"debug-shot-" + r.id} />
                        <Typography.Text className="tp-text-xs" type="secondary">{s.reason}</Typography.Text>
                      </span>
                    ))}
                  </Space>
                )}
              </div>
            ))}
            <div className="tp-text-sm" data-testid="debug-vars" style={{ marginTop: 8 }}>
              <Typography.Text className="tp-text-sm" strong>变量快照（{varsCount}）</Typography.Text>
              {varsCount === 0 ? (
                <Typography.Text type="secondary"> （没有存过变量；执行核不采集浏览器 console，
                  命令回执与断言卡就是现场）</Typography.Text>
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
