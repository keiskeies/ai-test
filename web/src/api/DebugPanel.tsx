// 调试结果面板（§11.4.4 子集）：状态徽标 + 耗时 + 断言卡 + 响应体折叠。
// 「调试失败 → 让 Pilot 分析（带响应体）」是蓝图 :1426 的出口，走 D84 诚实切片：
// 只把现场拼成草稿预填进 Pilot 输入框，发不发由人决定。
import { Alert, Button, Card, Collapse, Empty, Tag, Tooltip, Typography } from "antd";
import { CheckCircleFilled, CloseCircleFilled } from "../ui/icons";
import { useNavigate } from "react-router-dom";
import { statusColor } from "./req";
import { askPilotAboutDebug, debugFailedForPilot } from "./debugPilot";


export interface DebugResult {
  run_id: string;
  ok: boolean;
  passed: boolean;
  status: number | null;
  headers: Record<string, string>;
  body_text: string | null;
  truncated: boolean;
  body_size: number;
  elapsed_ms: number;
  error: string | null;
  assertions: Array<Record<string, unknown>>;
  env_name: string | null;
}

const pretty = (t: string | null): string => {
  if (t == null) return "（无响应体）";
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; }
};

/**
 * 「让 Pilot 分析」钮。单独成组件是为了把 useNavigate 关在这里：本文件被 AdbDebugPanel /
 * UiDebugPanel / reportDetail 三处当作**只读断言卡**复用，那三处不传 subject、这个组件不渲染，
 * 钩子也就不会被调用——AdbDebugPanel.test.tsx 那类没有 Router 的渲染面才不会因为
 * 一个顶层 useNavigate 直接炸。
 *
 * 已知体验缺口（挂在 D47-g / D49-e 那笔「未保存离开警告」账上，本轮不自行修）：这里是
 * `nav("/bench")`，而接口抽屉与用例覆盖层的请求草稿只活在 `useState` 里、既无持久化也无
 * 离开拦截，所以在**编辑抽屉**里点这个钮会连带未保存的草稿一起丢掉（侧边栏早就同样丢，
 * 只是这个钮的语义恰恰是「帮我看看这份请求」）。三条出路（路由拦截 / 草稿随导航带走 /
 * 只在无脏态现场给钮）都改产品行为，等业主裁，见 1G 计划「第十一轮」第六节。
 */
function AskPilotButton({ subject, result, requestLine }: {
  subject: string; result: DebugResult; requestLine?: string | null;
}) {
  const nav = useNavigate();
  return (
    <Button size="small" type="link" data-testid="debug-ask-pilot"
      style={{ paddingInline: 0 }}
      onClick={() => askPilotAboutDebug(subject, result, nav, requestLine)}>
      让 Pilot 分析
    </Button>
  );
}

export default function DebugPanel({ result, subject, requestLine, assertionsKnown = true }: {
  result: DebugResult | null;
  /**
   * 传了才在失败态给「让 Pilot 分析」出口（蓝图 :1426）。判定只在生产端做一次：
   * 给不出人类可读对象名的复用方（ADB/UI 的断言卡）不传，就一个钮都不画，
   * 而不是画一个点了之后草稿写「对象：undefined」的假门。
   */
  subject?: string | null;
  /** 请求行（`GET url`）：接口编辑器草稿有，运行记录抽屉没这个形状就不给。 */
  requestLine?: string | null;
  /**
   * 档案面（运行记录抽屉）专用：场景/UI/ADB 运行的逐条断言按设计只落在步骤明细里，
   * run_record.assertions 恒空（只有接口调试路径的 save_run 写它）。对这种记录，
   * 「零行」是「这块面板没拿到行」，不是「没执行断言」——传 false 时零行分支改口，
   * 不再输出「本次没有执行任何断言」这句它没资格下的结论。默认 true = 调试页现状。
   */
  assertionsKnown?: boolean;
}) {
  if (!result) {
    return (
      <Card data-testid="debug-panel" size="small" style={{ marginTop: 16 }}>
        <Empty description="点「调试」发送真实请求" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </Card>
    );
  }
  const badge = result.ok
    ? <Tag data-testid="debug-status" color={statusColor(result.status)}>{result.status}</Tag>
    : <Tag data-testid="debug-status" color="default">请求失败</Tag>;
  const rows = (result.assertions ?? []) as ({ type: string; path?: string; expected?: unknown; timeout_ms?: number } & Record<string, unknown>)[];
  // 断言徽标按「真跑了几条」说话，不按 passed 布尔直出：passed = ok && all(rows.passed)，
  // 而 all([]) === true——D78 之后用户可以停掉每一条断言（停用行不执行、不产结果行），
  // 于是「一条都没校验」和「全过了」在布尔上长得一模一样。画成绿色就是假门（§13 纪律 1）。
  // 零行时不猜原因：结果行里区分不出「没配断言」与「全停用」，两因一果都归「未校验」。
  // assertionsKnown=false 是第三种因：档案面的记录本来就不带断言行（见 prop 注释），
  // 「拿不到行」不是「没执行断言」，所以另走「明细在步骤里」，不套「未校验」那句。
  const assertTag = !result.ok ? null
    : rows.length === 0
      ? assertionsKnown
        ? (
          <Tooltip title="本次没有执行任何断言：要么没配，要么全部停用（停用的断言不执行、不产结果行）。请求发出去了 ≠ 校验通过。">
            <Tag data-testid="debug-assert-none">未校验</Tag>
          </Tooltip>
        )
        : (
          <Tooltip title="这条运行记录不携带断言结果行：场景/UI/ADB 运行的逐条断言落在各步骤明细里（报告详情右栏可看）。这里既不说「校验了几条」，也不说「没执行任何断言」。">
            <Tag data-testid="debug-assert-unknown">断言明细在步骤里</Tag>
          </Tooltip>
        )
      : result.passed
        ? (
          // 文案保持「断言全过」原样：e2e/api.spec.mjs:76 与 README-1a-demo.md:135 都按这四个字认，
          // 条数进 tooltip，不改既定话术。
          <Tooltip title={`本次真跑了 ${rows.length} 条断言，全部通过。`}>
            <Tag data-testid="debug-assert-pass" color="green">断言全过</Tag>
          </Tooltip>
        )
        : <Tag data-testid="debug-assert-fail" color="orange">有断言失败</Tag>;
  return (
    <Card data-testid="debug-panel" size="small" style={{ marginTop: 16 }}
      title={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {badge}
          <Typography.Text type="secondary">{result.elapsed_ms} ms</Typography.Text>
          {result.env_name && <Tag>{result.env_name}</Tag>}
          {assertTag}
          {subject && debugFailedForPilot(result) && (
            <span style={{ marginLeft: "auto" }}>
              <AskPilotButton subject={subject} result={result} requestLine={requestLine} />
            </span>
          )}
        </span>
      }
    >
      {result.error && <Alert type="error" showIcon message={result.error} style={{ marginBottom: 12 }} />}
      {rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          {rows.map((a, i) => (
            <Card data-testid="assertion-card" key={i} size="small"
              style={{ background: a.passed ? "var(--tp-tag-green-bg)" : "var(--tp-tag-red-bg)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                {a.passed
                  ? <CheckCircleFilled style={{ color: "var(--tp-func-success)" }} />
                  : <CloseCircleFilled style={{ color: "var(--tp-func-error)" }} />}
                <Typography.Text strong>{a.type}</Typography.Text>
                {a.path && <Typography.Text code>{a.path}</Typography.Text>}
                <Typography.Text type="secondary">期望 {JSON.stringify(a.expected ?? null)}</Typography.Text>
                {"actual" in a && (
                  <Typography.Text type={a.passed ? "secondary" : "danger"}>
                    实际 {JSON.stringify(a.actual ?? null)}
                  </Typography.Text>
                )}
                {typeof a.error === "string" && a.error && (
                  <Typography.Text type="danger">{a.error}</Typography.Text>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <Collapse size="small" items={[
        { key: "body", label: "响应体" + (result.truncated ? "（已截断）" : "") , children: (
          <pre data-testid="debug-body" className="tp-mono" style={{ maxHeight: 320, overflow: "auto", margin: 0 }}>
            {pretty(result.body_text)}
          </pre>
        ) },
        { key: "headers", label: "响应头", children: (
          <pre className="tp-mono" style={{ maxHeight: 200, overflow: "auto", margin: 0 }}>
            {Object.entries(result.headers ?? {}).map(([k, v]) => k + ": " + v).join("\n") || "（无）"}
          </pre>
        ) },
      ]} />
    </Card>
  );
}
