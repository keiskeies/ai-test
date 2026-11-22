// suggest_open_page 卡：[前往] 走 react-router（应用是 hash router），params 拼查询串。
// route 白名单门在后端出口（T2）；前端不认识 fetch，跳转语言经 ctx.onUserMessage 回写？
// 不——跳转是纯导航动作，不是对话回写，故用 react-router 的 navigate 经 props 注入，
// 组件依旧不 import 页面、不碰 fetch（vitest 里 MemoryRouter 好钉）。
import { Button, Space, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import type { CardContext } from "./registry";
import type { OpenPagePayload } from "./types";

export function toPageUrl(route: string, params?: Record<string, string | number>): string {
  const base = route.startsWith("/") ? route : "/" + route;
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return base;
  const qs = entries.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&");
  return base + "?" + qs;
}

export default function OpenPageCard({ payload, ctx }: { payload: OpenPagePayload; ctx: CardContext }) {
  const navigate = useNavigate();
  const url = toPageUrl(String(payload.route ?? ""), payload.params);
  return (
    <div data-testid="open-page-card" style={{ border: "1px solid #D6E4FF", borderRadius: 8, padding: "8px 12px", background: "#F7FAFF", display: "flex", alignItems: "center", gap: 8 }}>
      <Typography.Text className="tp-text-md">建议打开：</Typography.Text>
      <Typography.Text className="tp-text-sm tp-mono" style={{ color: "#1677ff" }}>{url}</Typography.Text>
      <Space size={8}>
        <Button size="small" type="primary" data-testid="open-page-go" disabled={ctx.busy} onClick={() => navigate(url)}>
          前往
        </Button>
        {ctx.busy && (
          <Typography.Text className="tp-text-sm" type="secondary" data-testid="card-busy-note">
            等本轮结束
          </Typography.Text>
        )}
      </Space>
    </div>
  );
}
