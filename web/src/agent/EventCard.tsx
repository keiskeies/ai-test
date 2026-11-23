// 事件卡（§11.3 最小子集 / §11.4.30 视觉 / 2026-11-21 会话流静默化改版）。
// USER/THINKING/TEXT/TOOL_*/USAGE/ERROR/APPROVAL_REQ。
// 改版口径：① 不再显示大写事件名徽标——「这是调用还是结果」由 chip 文案与状态标签承担；
// ② 工具收成一行 chip，参数/返回进深色代码块（§11.6.7 tp.code）；
// ③ TOOL_CALL 与配对的 TOOL_RESULT 由 turns.ts 合成一条，经 result 属性进来（见 props）。
import { Alert, Button, Collapse, Space, Tag, Typography } from "antd";
import type { CSSProperties } from "react";
import { ApiOutlined, BulbOutlined, CheckCircleOutlined, ClockCircleOutlined, UserOutlined } from "../ui/icons";
import ReactMarkdown from "react-markdown";
import type { AgentEvent } from "./sse";
import { renderCard, isCardPayload } from "./cards";
import type { CardContext, CardPayload } from "./cards";
import { tp, tpv } from "../theme";
import { fmtTime } from "../shared/timefmt";

export type EffectMap = Record<string, "read" | "write" | "destructive">;

function pretty(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

/** 深色代码块：命令/参数/返回的统一容器。浅底 14px 正文旁边读不出「这是一条命令」。 */
function CodeBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div data-testid="tool-json" style={{ background: tp.code.bg, border: `1px solid ${tp.code.border}`, borderRadius: 6, padding: "8px 10px", margin: 0 }}>
      <div className="tp-text-xs tp-mono" style={{ color: tp.code.subtle, marginBottom: 4 }}>{label}</div>
      <pre className="tp-text-sm tp-mono" style={{ color: tp.code.text, margin: 0, overflow: "auto", maxHeight: 260, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {pretty(value)}
      </pre>
    </div>
  );
}

/** chip 的三种强度：只读=蓝、写/破坏=橙、未知=灰。未知不借任何一侧的底色，
 *  否则等于用配色替用户做了它没拿到的判定（效果表异步拉、失败即清空）。 */
function effectTone(eff: EffectMap[string] | undefined) {
  if (eff === "write" || eff === "destructive") return { color: tpv.func.warning, border: tpv.tag.gold.bd };
  if (eff === "read") return { color: tpv.func.processing, border: tpv.tag.blue.bd };
  return { color: tpv.text[3], border: tpv.border };
}

/** 三档审批决策的人话（与后端 agent_approval.decision 对齐；未知值原样露，不吞）。 */
const DECISION_LABEL: Record<string, string> = {
  once: "已批准（仅本次）",
  session: "已批准（本会话该工具免再批）",
  deny: "已拒绝",
};

const chipBase: CSSProperties = {
  margin: "6px 0",
  border: `1px solid ${tpv.border}`,
  borderRadius: 8,
  background: tpv.bg.container,
  padding: "6px 10px",
};

export default function EventCard({ ev, result, effects, cardCtx, onApproval, approvalDecision, approvalBusy }: {
  ev: AgentEvent;
  /** 配对的 TOOL_RESULT（turns.ts 折叠而来）。缺省 = 结果还没回来，chip 停在「执行中」。 */
  result?: AgentEvent;
  effects: EffectMap;
  /** 卡片协议上下文（§12.2 ui="card"）；缺省时按钮恒 disabled——没接回写的宿主不开假门。 */
  cardCtx?: CardContext;
  /** D263 审批回传（ASK 模式的写工具）：缺省 = 宿主没接审批，卡片只陈述事实、不画按钮。 */
  onApproval?: (toolCallId: string, decision: "once" | "session" | "deny") => void;
  /** 已决决策（once/session/deny）；null/undefined = 仍待批。来自回放里的 APPROVAL_DECISION。 */
  approvalDecision?: string | null;
  /** 回传在途：防连点（后端也会 409，但按钮不该看起来还能再按一次）。 */
  approvalBusy?: boolean;
}) {
  const p = ev.payload ?? {};
  const kind = ev.type;

  if (kind === "USER") {
    return (
      <div data-testid="event-card" style={{ display: "flex", gap: 8, justifyContent: "flex-end", margin: "10px 0" }}>
        <div style={{ background: tpv.primary[50], border: `1px solid ${tpv.primary[100]}`, borderRadius: 10, padding: "8px 12px", maxWidth: "78%" }}>
          <Typography.Text style={{ whiteSpace: "pre-wrap" }}>{String(p.text ?? "")}</Typography.Text>
        </div>
        <UserOutlined style={{ color: tpv.text[2], marginTop: 6 }} />
      </div>
    );
  }

  if (kind === "THINKING") {
    return (
      <div data-testid="event-card" style={{ margin: "4px 0", paddingLeft: 2 }}>
        <Collapse
          ghost
          size="small"
          items={[{
            key: "t",
            label: (
              <Typography.Text className="tp-text-md" type="secondary">
                {/* 禁止 emoji 混入 UI（§11.6.6 红线）：💭 是彩色象形 emoji */}
                <BulbOutlined aria-label="思考" style={{ marginRight: 6, color: tpv.text[3] }} />
                思考中
              </Typography.Text>
            ),
            children: (
              <Typography.Text className="tp-text-md" type="secondary" italic style={{ whiteSpace: "pre-wrap" }}>
                {String(p.text ?? "")}
              </Typography.Text>
            ),
          }]}
        />
      </div>
    );
  }

  if (kind === "TEXT") {
    return (
      <div data-testid="event-card" style={{ margin: "10px 0" }}>
        <div className="tp-md tp-text-base">
          <ReactMarkdown>{String(p.text ?? "")}</ReactMarkdown>
        </div>
      </div>
    );
  }

  // 卡片协议分支（§12.2 / 1F T3）：只认 ui==="card" 且 content.card 带合法 kind。
  // 未注册的 kind 落折叠原始 JSON + 人话——未知形状不白屏、不装渲染（§13 纪律 1）。
  if (kind === "TOOL_RESULT" && p.ui === "card" && p.ok !== false && isCardPayload((p.content as Record<string, unknown> | undefined)?.card)) {
    const card = (p.content as { card: CardPayload }).card;
    const ctx: CardContext = cardCtx ?? { onUserMessage: () => undefined, busy: true };
    const node = renderCard(card, ctx);
    if (node !== null) {
      return (
        <div data-testid="event-card" style={{ margin: "10px 0" }}>
          {node}
        </div>
      );
    }
    return (
      <div data-testid="event-card" style={{ margin: "10px 0", ...chipBase }}>
        <Typography.Text className="tp-text-md" type="secondary" style={{ display: "block" }}>
          暂不支持的卡片类型（{String(card.kind)}{typeof card.form === "string" ? " / " + card.form : ""}），原始数据如下：
        </Typography.Text>
        <div style={{ marginTop: 4 }}>
          <Collapse ghost size="small" items={[{
            key: "raw",
            label: <span data-testid="tool-expand">卡片原始 JSON</span>,
            children: <CodeBlock label={String(card.kind)} value={card} />,
          }]} />
        </div>
      </div>
    );
  }

  if (kind === "TOOL_CALL" || kind === "TOOL_RESULT") {
    const name = String(p.tool_name ?? "");
    const eff = effects[name];
    const tone = effectTone(eff);
    // 旧的「调用」「结果」两行各一张卡：合成一条 chip 后，动作由「调用工具」说，
    // 成败由结果标签说，事件名不再上屏。三种到场形状各画各的，不拿缺的那半编出来：
    //   调用+结果 → 参数块 + 返回块 + 成败；只有调用 → 参数块 + 「执行中」；
    //   只有结果（历史被截断/单测直挂）→ 只画返回块，不凭空补一个参数块。
    const isResultEvent = kind === "TOOL_RESULT";
    const callP = isResultEvent ? undefined : p;
    const resP = result?.payload ?? (isResultEvent ? p : undefined);
    const done = resP !== undefined;
    const ok = resP === undefined || resP.ok === undefined ? null : Boolean(resP.ok);
    const produced = resP?.produced;
    return (
      <div data-testid="event-card" style={{ ...chipBase, borderColor: tone.border, borderLeft: `3px solid ${tone.color}` }}>
        <div data-testid="tool-chip" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <ApiOutlined style={{ color: tone.color }} />
          <Typography.Text className="tp-text-md" strong>调用工具</Typography.Text>
          <Typography.Text className="tp-text-md tp-mono" style={{ color: tone.color }}>{name}</Typography.Text>
          <Tag color={eff === "read" ? "blue" : eff === undefined ? "default" : "orange"} style={{ marginInlineStart: 4 }}>
            {eff === "read" ? "只读" : eff === "write" ? "写入" : eff === "destructive" ? "破坏性" : "效果未知"}
          </Tag>
          {ok !== null && (
            <Tag color={ok ? "green" : "red"} icon={<CheckCircleOutlined />} style={{ marginInlineEnd: 0 }}>
              {ok ? "成功" : "失败"}
            </Tag>
          )}
          {!done && <Typography.Text className="tp-text-sm" data-testid="tool-pending" type="secondary">执行中…</Typography.Text>}
          {done && Array.isArray(produced) && produced.length > 0 && (
            <Typography.Text className="tp-text-sm" data-testid="tool-produced" type="secondary">
              产出 {produced.length} 个资源
            </Typography.Text>
          )}
          {ev.ts && <Typography.Text className="tp-text-sm" type="secondary" style={{ marginLeft: "auto" }}>{fmtTime(ev.ts, { seconds: false })}</Typography.Text>}
        </div>
        {/* 卡片分支在上面已提前返回，所以这里的返回永远走代码块——参数与返回各一块，默认折叠。
            折叠头只写「参数」「返回结果」，不再写事件名。 */}
        <div style={{ marginTop: 4 }}>
          <Collapse
            ghost
            size="small"
            items={[
              ...(callP !== undefined
                ? [{ key: "args", label: <span data-testid="tool-expand">参数</span>, children: <CodeBlock label={name + " 参数"} value={callP.args ?? {}} /> }]
                : []),
              ...(done
                ? [{
                    key: "res",
                    label: <span data-testid="tool-expand">返回结果</span>,
                    children: <CodeBlock label={name + (resP?.ok === false ? " 报错" : " 返回")} value={resP?.ok === false ? { error: resP.error } : resP?.content ?? {}} />,
                  }]
                : []),
            ]}
          />
        </div>
      </div>
    );
  }

  if (kind === "APPROVAL_REQ") {
    return (
      <div data-testid="event-card" style={{ margin: "10px 0" }}>
        <div data-testid="approval-card" style={{ border: `1px dashed ${tpv.func.warning}`, background: tpv.func.warningBg, borderRadius: 8, padding: "10px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ClockCircleOutlined style={{ color: tpv.func.warning }} />
            <Typography.Text strong>等待审批：写工具 </Typography.Text>
            <Typography.Text className="tp-mono" style={{ color: tpv.func.warning }}>{String(p.tool_name ?? "")}</Typography.Text>
          </div>
          <div style={{ marginTop: 6 }}>
            <CodeBlock label={String(p.tool_name ?? "") + " 将要执行的参数"} value={p.args ?? {}} />
          </div>
          {approvalDecision ? (
            <div style={{ marginTop: 8 }}>
              <Tag data-testid="approval-decided"
                color={approvalDecision === "deny" ? "red" : "green"}>
                {DECISION_LABEL[approvalDecision] ?? approvalDecision}
              </Tag>
              <Typography.Text className="tp-text-sm" type="secondary">
                审批已处理，本轮会按该决策续推。
              </Typography.Text>
            </div>
          ) : onApproval ? (
            <Space style={{ marginTop: 8 }} wrap>
              <Button size="small" type="primary" data-testid="approval-once" disabled={approvalBusy}
                onClick={() => onApproval(String(p.tool_call_id ?? ""), "once")}>批准本次</Button>
              <Button size="small" data-testid="approval-session" disabled={approvalBusy}
                onClick={() => onApproval(String(p.tool_call_id ?? ""), "session")}>本会话都批准</Button>
              <Button size="small" danger data-testid="approval-deny" disabled={approvalBusy}
                onClick={() => onApproval(String(p.tool_call_id ?? ""), "deny")}>拒绝</Button>
              <Typography.Text className="tp-text-sm" type="secondary">
                批准只放行这一次工具调用；若模型随后再调同名工具，会重新询问。
              </Typography.Text>
            </Space>
          ) : (
            <Typography.Text className="tp-text-sm" type="secondary">
              本会话是 ASK 模式：写工具执行前需要你在页面上确认。
            </Typography.Text>
          )}
        </div>
      </div>
    );
  }

  if (kind === "USAGE") {
    return (
      <div data-testid="event-card" style={{ margin: "6px 0" }}>
        <div data-testid="usage-bar" className="tp-text-sm tp-mono" style={{ background: tpv.bg.layout, borderRadius: 6, padding: "3px 10px", display: "inline-flex", gap: 12, color: tpv.text[2] }}>
          <span>输入 {String(p.input_tokens ?? 0)} tokens</span>
          <span>输出 {String(p.output_tokens ?? 0)} tokens</span>
        </div>
      </div>
    );
  }

  if (kind === "ERROR") {
    return (
      <div data-testid="event-card" style={{ margin: "10px 0" }}>
        <Alert type="error" showIcon message={String(p.message ?? p.reason ?? "运行出错")} style={{ borderRadius: 8 }} />
      </div>
    );
  }

  // RUN_END / APPROVAL_DECISION / COMPACT_NOTE 等：不渲染卡片（RUN_END 仅作状态信号）
  return null;
}
