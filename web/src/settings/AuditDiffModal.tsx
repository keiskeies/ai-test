// 审计 [diff] 双栏 JSON 对照模态（§11.4.27：「before/after 双栏 JSON 高亮对照」——
// 蓝图画的就是双栏并排，不是行内 diff；所以不引 diff 库，键级并排 + 不同标色即达标）。
//
// 数据形状（后端唯一生产者 api_test/import_services 的覆盖审计）：
//   diff = { overwrite, name, before: {...}, after: {...} }
// 对照以 **顶层键** 为粒度：键只在一侧有、或两侧 JSON 值不等 → 整行高亮。
// 嵌套对象不递归展开比较——键级不同已足够定位「改了哪」，值级高亮留给细节卡的全量 JSON。
import { Modal, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { tp } from "../theme";

export interface DiffRow {
  key: string;
  before: string;
  after: string;
  changed: boolean;
}

const dump = (v: unknown): string | null =>
  v === undefined ? null : JSON.stringify(v, null, 2);

/** before/after 顶层键并集排序 → 双栏行；仅一侧存在或 JSON 不等 = changed。 */
export function diffRows(before: unknown, after: unknown): DiffRow[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  return keys.map((k) => {
    const bs = dump(b[k]);
    const as = dump(a[k]);
    return { key: k, before: bs ?? "—", after: as ?? "—", changed: bs !== as };
  });
}

/** 该行是否带 before/after 对照（没有就没有可对照物，[diff] 钮该诚实置灰）。 */
export function hasComparison(diff: Record<string, unknown> | null): boolean {
  return !!diff && "before" in diff && "after" in diff;
}

const cell = (v: string) => (
  <pre className="tp-mono tp-text-sm" style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
    {v}
  </pre>
);

export default function AuditDiffModal({ diff, action, onClose }: {
  diff: Record<string, unknown> | null;
  action: string;
  onClose: () => void;
}) {
  const rows = diffRows(diff?.before, diff?.after);
  const changedCount = rows.filter((r) => r.changed).length;
  const cols: ColumnsType<DiffRow> = [
    { title: "键", dataIndex: "key", width: 130, render: (v: string) => (
      <Typography.Text className="tp-mono" data-testid="audit-diff-key">{v}</Typography.Text>) },
    { title: "before", dataIndex: "before", render: (v: string, r: DiffRow) => (
      <div data-testid={"audit-diff-before-" + r.key} style={r.changed ? { background: tp.tag.red.bg } : undefined}
        >{cell(v)}</div>) },
    { title: "after", dataIndex: "after", render: (v: string, r: DiffRow) => (
      <div data-testid={"audit-diff-after-" + r.key} style={r.changed ? { background: tp.tag.green.bg } : undefined}
        >{cell(v)}</div>) },
  ];
  return (
    // centered：antd 默认 top:100，768 高屏上 960 宽的对照表底部顶出视口（2026-11-22 实测）。
    <Modal open onCancel={onClose} width={960} centered destroyOnHidden title={"变更对照 · " + action}
      data-testid="audit-diff-modal"
      footer={<Typography.Text data-testid="audit-diff-summary" className="tp-text-sm">
        {changedCount === 0 ? <Tag>无差异键</Tag> : <Tag color="orange">{changedCount} 个差异键</Tag>}
      </Typography.Text>}
    >
      {/* 对照之外的杂项（overwrite 标记 / 名称等）摊在表头上方，不丢信息 */}
      {diff && Object.entries(diff).filter(([k]) => k !== "before" && k !== "after").length > 0 && (
        <Typography.Paragraph data-testid="audit-diff-meta" className="tp-mono tp-text-sm"
          style={{ marginBottom: 8 }}>
          {JSON.stringify(Object.fromEntries(Object.entries(diff).filter(([k]) => k !== "before" && k !== "after")))}
        </Typography.Paragraph>
      )}
      <Table<DiffRow> rowKey="key" size="small" columns={cols} dataSource={rows} pagination={false}
        scroll={{ y: 420 }}
        rowClassName={(r) => (r.changed ? "audit-diff-row-changed" : "")}
        onRow={(r) => ({ "data-testid": "audit-diff-row", "data-changed": String(r.changed) } as React.HTMLAttributes<HTMLTableRowElement>)} />
    </Modal>
  );
}
