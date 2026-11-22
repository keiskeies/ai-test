// 目标计划列表卡（§11.4.33 TodoList）：状态点 pending ○ / doing ▶（呼吸）/ done ✓ / skipped 灰划。
// 「同名工具的最新结果覆盖渲染」由 EventCard 的合流层保证（update_plan_item 的地形是原地更新），
// 本组件只管把拿到的一份 items 画对。
import { Typography } from "antd";
import type { PlanItem, PlanItemState } from "./types";

const STATE_META: Record<PlanItemState, { icon: string; color: string; strike: boolean; label: string }> = {
  // 2026-11-22 设计系统改版：antd 默认蓝 #1677ff 与老绿 #52C41A 不在 Token 表里（D48-d），
  // 改引功能色——进行中=processing、完成=success、待办/跳过=文字层级。
  pending: { icon: "○", color: "var(--tp-text-3)", strike: false, label: "待办" },
  doing: { icon: "▶", color: "var(--tp-func-processing)", strike: false, label: "进行中" },
  done: { icon: "✓", color: "var(--tp-func-success)", strike: false, label: "完成" }, // 绿勾不加删除线（审计感，§11.4.33）
  skipped: { icon: "○", color: "var(--tp-text-4)", strike: true, label: "已跳过" },
};

export default function PlanListCard({ items, title }: { items: PlanItem[]; title?: string }) {
  const list = Array.isArray(items) ? items : [];
  const done = list.filter((it) => it.state === "done" || it.state === "skipped").length;
  return (
    <div data-testid="plan-list-card" style={{ border: "1px solid var(--tp-tag-green-bd)", borderRadius: 8, padding: "10px 12px", background: "var(--tp-tag-green-bg)" }}>
      <Typography.Text strong style={{ fontSize: 13 }}>
        计划 · {String(title ?? "Pilot 任务清单")} {done}/{list.length}
      </Typography.Text>
      <ul data-testid="plan-items" style={{ listStyle: "none", margin: "6px 0 0", padding: 0, fontSize: 13 }}>
        {list.map((it, i) => {
          const meta = STATE_META[it.state as PlanItemState] ?? STATE_META.pending;
          return (
            <li key={String(it.id ?? i)} data-testid={"plan-item-" + String(it.state)} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0" }}>
              <span style={{ color: meta.color }} title={meta.label}>{meta.icon}</span>
              <span style={{ textDecoration: meta.strike ? "line-through" : "none", color: meta.strike ? "#8C9196" : undefined }}>
                {String(it.text ?? "")}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
