// ask_user 卡（D32：运行内提问**不挂起** run）：问题 + 选项按钮组，
// 点选项 = 回写一条用户消息（R149），对话自然衔接。
import { Button, Space, Typography } from "antd";
import { QuestionCircleOutlined } from "../../ui/icons";
import type { CardContext } from "./registry";
import type { QuestionPayload } from "./types";

export default function QuestionCard({ payload, ctx }: { payload: QuestionPayload; ctx: CardContext }) {
  const options = Array.isArray(payload.options) ? payload.options : [];
  return (
    <div data-testid="question-card" style={{ border: "1px solid #D6E4FF", borderRadius: 8, padding: "10px 12px", background: "#F7FAFF" }}>
      <Typography.Text className="tp-text-md" strong>
        {/* 禁止 emoji 混入 UI（§11.6.6 红线）：原来的 <span role="img">❓</span> 是彩色象形 emoji，
            role="img" 就是「我在充当图标」的自供——换成同职责的线性图标，读屏文案不变。 */}
        <QuestionCircleOutlined aria-label="提问" style={{ marginRight: 4 }} />
        {String(payload.question ?? "")}
      </Typography.Text>
      <div style={{ marginTop: 8 }}>
        <Space size={8} wrap>
          {options.map((opt, i) => (
            <Button
              key={i}
              size="small"
              data-testid="question-option"
              disabled={ctx.busy}
              onClick={() => ctx.onUserMessage("回答：" + String(opt))}
            >
              {String(opt)}
            </Button>
          ))}
        </Space>
      </div>
      {ctx.busy && (
        <Typography.Text className="tp-text-sm" type="secondary" data-testid="card-busy-note" style={{ display: "block", marginTop: 6 }}>
          等本轮结束
        </Typography.Text>
      )}
    </div>
  );
}
