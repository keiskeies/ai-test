// 空 / 加载 / 错误三态的一套画法（§11.7.5）。
//
// 旧版全站 29 处 `Empty.PRESENTED_IMAGE_SIMPLE` + 各页自己拼的一段灰字，插画是 antd
// 那张通用信封——「没有数据」和「没有权限」看起来一模一样，这与「诚实」纪律相抵：
// 空态是唯一能说清「为什么空」的地方，不该只剩一张通用图。
//
// 本组件只说三件不同的事：
//   ① empty —— 真的没有数据（可带一句该做什么、以及主动作）；
//   ② locked —— 没有权限/未选项目（锁形图标 + 需要什么，不暗示重试）；
//   ③ error —— 请求失败（图标 + 错误原话 + 重试入口）。错误绝不画成空。
import type { ReactNode } from "react";
import { Inbox, Lock, TriangleAlert } from "lucide-react";

export type StateKind = "empty" | "locked" | "error";

export interface StateViewProps {
  kind?: StateKind;
  /** 一行标题（如「还没有执行记录」）。 */
  title: ReactNode;
  /** 一句补充：为什么空 / 缺什么权限 / 失败原话。 */
  desc?: ReactNode;
  /** 主动作（如「新建接口」）；error 态里通常是「重试」。 */
  action?: ReactNode;
  testId?: string;
  /** 紧凑版：用于卡片内部、抽屉里，垂直留白减半。 */
  compact?: boolean;
}

const ICON: Record<StateKind, typeof Inbox> = { empty: Inbox, locked: Lock, error: TriangleAlert };

export default function StateView({ kind = "empty", title, desc, action, testId, compact }: StateViewProps) {
  const Icon = ICON[kind];
  return (
    <div className="tp-empty" data-testid={testId} style={compact ? { padding: "20px 12px" } : undefined}>
      <Icon className="tp-empty-icon" size={compact ? 28 : 36} strokeWidth={1.25}
        aria-hidden style={kind === "error" ? { color: "var(--tp-func-error)" } : undefined} />
      <div className="tp-empty-title">{title}</div>
      {desc && <div className="tp-empty-desc">{desc}</div>}
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </div>
  );
}

/** 列表/详情「加载中」的骨架替代：比中途闪一次 Spin 更稳（<300ms 不显，§11.7.5）。 */
export function LoadingBlock({ label = "加载中…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div style={{ padding: "12px 0" }} role="status" aria-live="polite" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{
          height: 14, marginBottom: 12, borderRadius: 4,
          width: `${72 - i * 12}%`,
          background: "linear-gradient(90deg, var(--tp-bg-hover) 25%, var(--tp-split) 37%, var(--tp-bg-hover) 63%)",
          backgroundSize: "400% 100%",
          animation: "tp-shimmer 1.4s ease infinite",
        }} />
      ))}
      <style>{`@keyframes tp-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}`}</style>
    </div>
  );
}