// §11.4.12「UI 用例 / ADB 用例共用一个组件」的共用件（1D T9）：步骤列表编辑器的骨架——
// 工具条（添加/搜索/剪贴板/dirty）、本地预检与 422 issues 的展示、行摘要 + 展开参数、
// 拖拽重排、行菜单（插入/复制/剪贴板/粘贴/删除）。骨架只有一份；两家的差异全部经
// descriptor 注入：词表、可添加类型、草稿形状、id 前缀、行摘要、校验、参数面板。
//
// 从 pages/uiCaseDetail.tsx 原样搬出（testid 一字不改：cmd-toolbar/cmd-add/cmd-search/
// cmd-paste/cmd-dirty/cmd-row/cmd-more-N/cmd-add-end/case-save-issues/case-local-issues，
// uiCase.spec.mjs 钉的是这些，重构门禁 = 它全绿）。**这里只有列表**；元信息条、保存/
// 调试动作、路由都留在页面里——ADB 用例的元信息（默认设备等）与 UI 的不同，骨架共用、
// 页头各自，是蓝图 mock 的实际形状。
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert, Button, Dropdown, Input, Select, Space, Tooltip, Typography, message,
} from "antd";
import { DeleteOutlined, DownOutlined, PlusOutlined, RightOutlined } from "../ui/icons";
import {
  duplicateRowAt, insertAfterRow, moveRow, nextRowId, removeRowAt, updateRowAt,
  type StepRowLike,
} from "./stepList";

export interface StepIssue { index: number; code: string; message: string }

/** 两家步骤协议的共用形状：id + type，其余字段各家自己的接口兼容它即可。 */
export interface StepLike extends StepRowLike { type: string }

export interface StepDescriptor<T extends StepLike> {
  labels: Record<string, string>;
  /** 可添加类型清单（被拦类型不进——插进去就是一条存不了的命令，§13 纪律 1）。 */
  insertable: readonly string[];
  /** 末尾「添加命令」按钮用的类型（UI=open 的浏览链首步；ADB=connect 的设备链首步）。 */
  defaultAppendType: string;
  /** 草稿（id 留空，由本件按 max+1 分配，R102）。 */
  makeRow: (type: string) => T;
  /** 行 id 前缀（UI "u" / ADB "a"，§7.2/§7.3 示例各自的字面）。 */
  idPrefix: string;
  /** 复制/粘贴时的脱离引用方式：UI 浅拷贝即原型行为；ADB 行带 config 嵌套对象，
   *  必须深一层（副本改参数不许写穿原件）。默认浅拷贝。 */
  cloneRow?: (src: T) => T;
  summary: (row: T) => string;
  validate: (rows: unknown) => StepIssue[];
  /** 展开行参数面板；testIdPrefix 沿用 cmdp-N（e2e 钉点）。 */
  renderParams: (row: T, ctx: { testIdPrefix: string; onChange: (next: T) => void }) => ReactNode;
}

export interface StepListEditorProps<T extends StepLike> {
  descriptor: StepDescriptor<T>;
  steps: T[];
  onChange: (next: T[]) => void;
  canUpdate: boolean;
  /** 422 回传的 issues（库里没动）；本地预检本件自算，两者都不藏。 */
  saveIssues?: StepIssue[] | null;
  dirty: boolean;
}

export default function StepListEditor<T extends StepLike>({
  descriptor, steps, onChange, canUpdate, saveIssues, dirty,
}: StepListEditorProps<T>) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [clipboard, setClipboard] = useState<T[]>([]);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return steps.map((s, i) => ({ s, i }));
    return steps.map((s, i) => ({ s, i })).filter(({ s }) =>
      (descriptor.labels[s.type] ?? s.type).toLowerCase().includes(kw)
      || s.type.toLowerCase().includes(kw));
  }, [steps, q, descriptor]);

  const localIssues = useMemo(() => descriptor.validate(steps), [steps, descriptor]);

  const insertRow = (after: number, type: string) => {
    const row = { ...descriptor.makeRow(type), id: nextRowId(descriptor.idPrefix, steps) };
    onChange(insertAfterRow(steps, after, row));
    setExpanded(after + 1);
  };

  function pasteAfter(i: number) {
    if (clipboard.length === 0) return;
    const clone = descriptor.cloneRow ?? ((c: T): T => ({ ...c }));
    let list = steps.slice();
    // 粘贴件换新 id：id 是历史步骤行的行键（R102），同一用例内不许复用
    clipboard.forEach((c, k) => {
      list = insertAfterRow(list, i + k, { ...clone(c), id: nextRowId(descriptor.idPrefix, list) });
    });
    onChange(list);
  }

  function rowMenu(i: number) {
    return { items: [
      { key: "insert", label: "在这一行后插入…", children: descriptor.insertable.map((t) => ({
        key: "ins-" + t, label: descriptor.labels[t], onClick: () => insertRow(i, t),
      })) },
      { key: "dup", label: "复制（duplicate）", onClick: () => {
        const [next, copy] = duplicateRowAt(steps, i, descriptor.idPrefix, descriptor.cloneRow);
        onChange(next);
        if (copy) message.success("已复制为 " + copy.id);
      } },
      { key: "clip", label: "复制到剪贴板", onClick: () => {
        // 页内剪贴板：入板的是快照（后续改动不回写剪贴板）
        setClipboard((c) => [...c, { ...steps[i] }]);
      } },
      { key: "paste", label: clipboard.length ? "粘贴到后面（" + clipboard.length + "）"
        : "粘贴到后面（剪贴板为空）",
        disabled: clipboard.length === 0, onClick: () => pasteAfter(i) },
      { key: "del", label: "删除该行", danger: true, onClick: () => {
        onChange(removeRowAt(steps, i));
        setExpanded(null);
      } },
    ] };
  }

  // —— 原生 HTML5 拖拽（scene/ListMode.tsx 同款；筛选态禁用：过滤后行序不代表真实顺序）——
  const dragFrom = useRef<number | null>(null);
  const dragDisabled = q.trim() !== "";

  return (
    <>
      <div data-testid="cmd-toolbar" style={{ display: "flex", gap: 8, alignItems: "center",
        flexWrap: "wrap", marginBottom: 8 }}>
        {canUpdate && (
          <Select data-testid="cmd-add" style={{ width: 220 }} showSearch optionFilterProp="searchText"
            placeholder="+ 添加命令" value={null}
            options={descriptor.insertable.map((t) => ({ value: t, label: descriptor.labels[t],
              searchText: descriptor.labels[t] + " " + t }))}
            onChange={(t: string) => insertRow(steps.length - 1, t)}
            suffixIcon={<PlusOutlined />}
          />
        )}
        <Input data-testid="cmd-search" allowClear style={{ width: 200 }}
          placeholder="按命令名筛选（筛选态禁拖）"
          value={q} onChange={(e) => setQ(e.target.value)} />
        {canUpdate && clipboard.length > 0 && (
          <Space size={4}>
            <Typography.Text type="secondary" className="tp-text-sm">剪贴板:</Typography.Text>
            <Button size="small" data-testid="cmd-paste" onClick={() => pasteAfter(steps.length - 1)}>
              {"粘贴(" + clipboard.length + ")"}
            </Button>
            <Tooltip title="清空页内剪贴板（刷新页面也会清空，它不是系统剪贴板）">
              <Button size="small" type="text" danger icon={<DeleteOutlined />}
                onClick={() => setClipboard([])} />
            </Tooltip>
          </Space>
        )}
        <Typography.Text type="secondary" data-testid="cmd-dirty"
          className="tp-text-sm" style={{ marginLeft: "auto" }}>
          {dirty ? "有未保存修改" : "与库一致"}
        </Typography.Text>
      </div>

      {saveIssues && saveIssues.length > 0 && (
        <Alert type="error" showIcon data-testid="case-save-issues" style={{ marginBottom: 8 }}
          message={"保存被拒绝：共 " + saveIssues.length + " 个命令问题（库里没动）"}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {saveIssues.map((it, i) => (
                <li key={i} data-testid="case-save-issue">
                  <Typography.Text code>{it.code}</Typography.Text> {it.message}
                </li>
              ))}
            </ul>
          } />
      )}
      {!saveIssues && localIssues.length > 0 && (
        <Alert type="warning" showIcon data-testid="case-local-issues" style={{ marginBottom: 8 }}
          message={"本地预检发现 " + localIssues.length + " 个问题（保存会被拒）"}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {localIssues.slice(0, 6).map((it, i) => (
                <li key={i}>第 {it.index >= 0 ? it.index + 1 : "-"} 行{" "}
                  <Typography.Text code>{it.code}</Typography.Text> {it.message}</li>
              ))}
              {localIssues.length > 6 && <li>……共 {localIssues.length} 条</li>}
            </ul>
          } />
      )}

      <div style={{ flex: 1, border: "1px solid var(--tp-split)", borderRadius: 6, background: "var(--tp-bg-container)" }}>
        {steps.length === 0 && (
          <Typography.Text type="secondary" style={{ display: "block", padding: 24 }}>
            还没有命令。{canUpdate ? "点「+ 添加命令」加第一条——空用例保存会被拒（零步全绿是假绿）。"
              : "这条用例还没有命令。"}
          </Typography.Text>
        )}
        {filtered.map(({ s, i }) => {
          const open = expanded === i;
          const rowIssue = localIssues.find((it) => it.index === i);
          return (
            <div key={s.id || "row" + i}>
              <div data-testid="cmd-row" data-id={s.id} data-type={s.type}
                draggable={!dragDisabled && canUpdate}
                onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { if (dragFrom.current !== null) e.preventDefault(); }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom.current === null || dragFrom.current === i) return;
                  // move 的 toIndex 语义（graphOps.reorder 同法）：先删后插
                  const from = dragFrom.current;
                  onChange(moveRow(steps, from, from < i ? i - 1 : i));
                  dragFrom.current = null;
                }}
                onDragEnd={() => { dragFrom.current = null; }}
                onClick={() => canUpdate && setExpanded(open ? null : i)}
                style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 10px",
                  borderBottom: "1px solid var(--tp-split)", cursor: canUpdate ? "pointer" : "default",
                  background: open ? "var(--tp-bg-hover)" : undefined,
                  opacity: rowIssue ? 0.85 : 1 }}>
                {canUpdate
                  ? (open ? <DownOutlined style={{ fontSize: 10, color: "var(--tp-text-3)" }} />
                    : <RightOutlined style={{ fontSize: 10, color: "var(--tp-text-3)" }} />)
                  : <span style={{ width: 10 }} />}
                <span className="tp-text-sm" style={{ width: 28, color: "var(--tp-text-3)",
                  fontVariantNumeric: "tabular-nums" }}>
                  {i + 1}
                </span>
                <Typography.Text className="tp-text-sm" style={{ width: 84, flexShrink: 0 }}>
                  {descriptor.labels[s.type] ?? s.type}
                </Typography.Text>
                <Typography.Text className="tp-text-sm" style={{ flex: 1, minWidth: 0 }}
                  ellipsis={{ tooltip: descriptor.summary(s) }}>
                  {descriptor.summary(s)}
                </Typography.Text>
                {rowIssue && (
                  <Tooltip title={rowIssue.message}>
                    <Typography.Text type="danger" className="tp-text-sm" data-testid="cmd-row-issue">
                      {rowIssue.code}
                    </Typography.Text>
                  </Tooltip>
                )}
                {canUpdate && (
                  <Dropdown menu={rowMenu(i)} trigger={["click"]}>
                    <Button size="small" type="text" data-testid={"cmd-more-" + i}
                      onClick={(e) => e.stopPropagation()}>···</Button>
                  </Dropdown>
                )}
              </div>
              {open && canUpdate && (
                <div style={{ padding: "8px 12px 12px 36px", borderBottom: "1px solid var(--tp-split)",
                  background: "var(--tp-bg-hover)" }}>
                  {descriptor.renderParams(s, {
                    testIdPrefix: "cmdp-" + i,
                    onChange: (next) => onChange(updateRowAt(steps, i, next)),
                  })}
                </div>
              )}
            </div>
          );
        })}
        {canUpdate && filtered.length > 0 && (
          <Button type="dashed" block icon={<PlusOutlined />} data-testid="cmd-add-end"
            style={{ margin: 6, width: "calc(100% - 12px)" }}
            onClick={() => insertRow(steps.length - 1, descriptor.defaultAppendType)}>
            在末尾添加命令
          </Button>
        )}
      </div>
    </>
  );
}
