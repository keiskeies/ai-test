// 工具栏两条：FilterBar（左筛选 / 右动作）与 Toolbar（纯动作组）。
//
// 现状问题（接口管理页最典型）：11 个控件同权平铺——视图选择器、筛选、刷新、导入、
// 导出、新建……主按钮与次要动作抢同一条线，扫读成本高。约定：
//   · 左侧 = 影响**看到什么**的东西（筛选、搜索、视图、列设置）；
//   · 右侧 = 影响**数据**的动作（新建 = primary 且恒在最右，其余次级）；
//   · 同一屏只有一个 primary（§11.6.6 红线）。
// 用 flex + margin-left:auto 而不是 Space split：Space 的间距会把「右对齐」表达成
// 恰好填满，窗口一宽按钮就散在中间。
import type { ReactNode } from "react";
import { Button, Space } from "antd";

export function FilterBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="tp-filterbar" data-testid="filter-bar">
      {children}
      {actions && <div className="tp-filterbar-actions">{actions}</div>}
    </div>
  );
}

export interface ToolbarProps {
  /** 次要动作（刷新/导入/导出…），一律 default 或 text。 */
  children?: ReactNode;
  /** 主按钮：本组的唯一 primary。 */
  primary?: ReactNode;
  /** 图标按钮组：需要紧凑时把文字省掉，用 title 说明（可访问名仍要在）。 */
  compact?: boolean;
}

export function Toolbar({ children, primary, compact }: ToolbarProps) {
  return (
    <Space size={compact ? 4 : 8} wrap>
      {children}
      {primary}
    </Space>
  );
}

/** 图标按钮：无文字时必带 aria-label（图标本身不承载可访问名）。 */
export function IconButton(props: {
  icon: ReactNode; label: string; onClick: () => void; disabled?: boolean;
  danger?: boolean; testId?: string; loading?: boolean;
}) {
  return (
    <Button {...(props.danger ? { danger: true } : {})}
      icon={props.icon} title={props.label} aria-label={props.label}
      onClick={props.onClick} disabled={props.disabled} loading={props.loading}
      data-testid={props.testId} />
  );
}