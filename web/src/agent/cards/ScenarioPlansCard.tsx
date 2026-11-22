// 候选场景卡（§11.4.30 / §9.7 :600-601 草图形状）：每卡 名称/覆盖意图/步骤预览/风险点
// + [画布预览][选择]。**[保存] 不出现为可点按钮**——§13 纪律 1：能点但后端不认的按钮是假门，
// 只在选择钮旁留一句 secondary 文案「保存（二期开放）」（§4 :206 / §13 :1604 口径）。
// T4：[画布预览] 接真——payload 自包含，graph 合法即写 sessionStorage 后开新 Tab 跳
// /scene-preview（同 Tab 跳会丢 bench 会话现场）；没带 graph 的方案保持 disabled + 人话 Tooltip。
import { Button, Card, Space, Tooltip, Typography, message } from "antd";
import type { CardContext } from "./registry";
import type { ScenarioPlansPayload } from "./types";
import { previewPageUrl, previewStorageKey, previewableGraph } from "./previewLink";

/** sessionStorage 键里的 run 段：前端事件信封（{seq,ts,type,payload}）不携带 run_id
 *  （agent/sse.ts 头注实证），卡片侧拿不到真 run_id——退而求其次用点击期生成的唯一 token，
 *  唯一性/刷新可重进语义等价；计划口径差异回填台账。 */
function previewRunToken(): string {
  return "t" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function openPreview(planName: string, graph: unknown, index: number): void {
  const key = previewStorageKey(previewRunToken(), index);
  try {
    sessionStorage.setItem(key, JSON.stringify({ plan_name: planName, graph }));
  } catch {
    // 隐私模式/配额满：说清楚为什么打不开，不演「已打开」
    message.warning("浏览器会话存储不可用，无法打开画布预览（可能被隐私模式拦截）");
    return;
  }
  // 新 Tab：hash 相对地址在当前 URL 上解析出 #/scene-preview?k=…
  window.open(previewPageUrl(key), "_blank");
}

export default function ScenarioPlansCard({ payload, ctx }: { payload: ScenarioPlansPayload; ctx: CardContext }) {
  const plans = Array.isArray(payload.plans) ? payload.plans : [];
  return (
    <div data-testid="scenario-plans-card" style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      {plans.map((plan, i) => {
        // 「有 graph 才可点」：只认 §7.4 形状（对象 + nodes 数组）——预览不收坏图
        const canPreview = previewableGraph(plan.graph);
        const name = String(plan.name ?? "未命名方案 " + (i + 1));
        return (
          <Card
            key={i}
            data-testid="plan-card"
            size="small"
            title={<Typography.Text className="tp-text-md" strong>{name}</Typography.Text>}
            style={{ flex: "1 1 300px", minWidth: 280 }}
          >
            <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ marginBottom: 6 }}>
              覆盖意图：{String(plan.intent ?? "—")}
            </Typography.Paragraph>
            <div data-testid="step-preview">
              <Typography.Text className="tp-text-sm">步骤预览：</Typography.Text>
              <ol className="tp-text-sm" style={{ margin: "2px 0 6px", paddingLeft: 20 }}>
                {(Array.isArray(plan.est_steps) ? plan.est_steps : []).map((s, j) => (
                  <li key={j} data-testid="step-preview-row">{String(s)}</li>
                ))}
              </ol>
            </div>
            {Array.isArray(plan.risks) && plan.risks.length > 0 && (
              <Typography.Paragraph className="tp-text-sm" type="warning" style={{ marginBottom: 6 }}>
                风险点：{plan.risks.map(String).join("；")}
              </Typography.Paragraph>
            )}
            {plan.env_hint && (
              <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ marginBottom: 6 }}>
                环境建议：{String(plan.env_hint)}
              </Typography.Paragraph>
            )}
            <Space size={8} wrap>
              {/* 预览不落库不写后端，运行中也可看（busy 不拦它）；span 是 antd disabled 钮出 Tooltip 的成型写法 */}
              <Tooltip title={canPreview
                ? "新标签页只读预览（未落库，不影响本会话）"
                : "这个方案没带场景图（graph），暂时没有可预览的内容"}>
                <span style={{ display: "inline-block" }}>
                  <Button
                    size="small"
                    data-testid="plan-preview"
                    disabled={!canPreview}
                    onClick={() => openPreview(name, plan.graph, i)}
                  >
                    画布预览
                  </Button>
                </span>
              </Tooltip>
              <Button
                type="primary"
                size="small"
                data-testid="plan-select"
                disabled={ctx.busy}
                onClick={() => ctx.onUserMessage("选择方案：" + String(plan.name ?? "方案 " + (i + 1)))}
              >
                选择
              </Button>
              <Typography.Text className="tp-text-sm" type="secondary">保存（二期开放）</Typography.Text>
            </Space>
            {ctx.busy && (
              <Typography.Text className="tp-text-sm" type="secondary" data-testid="card-busy-note" style={{ display: "block", marginTop: 6 }}>
                等本轮结束
              </Typography.Text>
            )}
          </Card>
        );
      })}
    </div>
  );
}
