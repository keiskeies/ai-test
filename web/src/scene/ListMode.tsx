// 列表模式（T20，§11.4.10）：与画布同一 graph 同一时刻——树编辑全走 store/graphOps，
// 这里只是同一份不可变树的第二种视图。拖把手=排序，落到容器=嵌套（复用画布的
// HTML5 载荷与 moveNode 口径）；复制进剪贴板 → 粘贴；搜索定位。
// 勾选框=disable 位（与画布右键「禁用」同一字段，§7.4）。
import { useMemo, useState } from "react";
import { Button, Checkbox, Dropdown, Input, Typography, message } from "antd";
import {
  CopyOutlined, DeleteOutlined, DownOutlined, RightOutlined, SearchOutlined,
} from "../ui/icons";
import { childrenOf, findByKey, isValidKey } from "./graphOps";
import { DND_KIND, DND_NAME, DND_NODE, DND_REF } from "./Canvas";
import { CONTAINER_KINDS, kindMeta, labelOf, type Kind, type StepNode } from "./stepTypes";
import { mergeIssues, useSceneStore } from "./store";

interface Row {
  node: StepNode;
  no: string;
  depth: number;
  parentKey: string | null;
  hasChildren: boolean;
}

function rowsOf(nodes: StepNode[], collapsed: string[]): Row[] {
  const out: Row[] = [];
  const rec = (list: StepNode[], prefix: string, depth: number, parentKey: string | null) => {
    list.forEach((n, i) => {
      const no = prefix ? prefix + "." + (i + 1) : String(i + 1);
      const kids = childrenOf(n);
      out.push({ node: n, no, depth, parentKey, hasChildren: kids.length > 0 });
      if (kids.length && !collapsed.includes(n.key)) rec(kids, no, depth + 1, n.key);
    });
  };
  rec(nodes, "", 0, null);
  return out;
}

/** 行摘要：让「API·创建订单 (POST /order)」这类一眼可读（§11.4.10 草图）。 */
function summaryOf(n: StepNode, caseName: (ref: string) => string | null): string {
  switch (n.kind) {
    case "api_case": {
      const nm = caseName(n.ref ?? "") ?? (n.ref ? n.ref.slice(0, 8) : "未选用例");
      return "API·" + nm;
    }
    case "sleep":
      return "等待 " + String(n.config?.ms ?? "?") + "ms";
    case "loop":
      return (String(n.config?.mode ?? "count") === "while" ? "while ≤" : "×")
        + String(n.config?.max_iter ?? "?") + " 次";
    case "foreach":
      return String(n.config?.list_var ?? "?") + " → " + String(n.config?.item_var ?? "?");
    case "if": {
      const br = (n.config?.branches as unknown[]) ?? [];
      return br.length + " 分支";
    }
    case "http_direct":
      return String(n.config?.method ?? "GET") + " " + String(n.config?.url ?? "");
    case "script":
      return "受限沙箱脚本";
    case "assert":
      return ((n.config?.assertions as unknown[]) ?? []).length + " 条断言";
    case "extract":
      return ((n.config?.rules as unknown[]) ?? []).length + " 条提取";
    case "group": {
      const c = childrenOf(n).length;
      return c > 0 ? c + " 子步" : "分组（串行容器）";
    }
    default:
      return labelOf(n.kind as never);
  }
}

const ADD_KINDS: Kind[] = ["api_case", "sleep", "set_var", "assert", "extract", "script", "group", "if", "loop", "foreach"];
const INSERT_KINDS: Kind[] = ["sleep", "set_var", "assert", "extract", "script", "group", "if", "loop"];

function Toolbar(props: { q: string; setQ: (v: string) => void }) {
  const clipboard = useSceneStore((s) => s.clipboard);
  const readOnly = useSceneStore((s) => s.readOnly);
  const st = () => useSceneStore.getState();
  return (
    <div style={{ display: "flex", gap: 8, padding: "4px 12px 8px", alignItems: "center" }}>
      <Input data-testid="list-search" allowClear size="small" style={{ width: 200 }}
        prefix={<SearchOutlined style={{ color: "#B4BBC2" }} />}
        placeholder="搜索步骤（名称 / key）" value={props.q} onChange={(e) => props.setQ(e.target.value)} />
      {/* D146：添加/粘贴是写把手，只读隐藏（§11.5.1）；搜索是读把手，留着 */}
      {!readOnly && (<>
      <Dropdown
        menu={{
          items: ADD_KINDS.map((k) => ({
            key: k, label: <span data-testid={"list-addmenu-" + k}>{labelOf(k)}</span>,
            onClick: () => st().addStep(k, null),
          })),
        }}>
        <Button size="small" data-testid="list-add-step">+ 添加步骤</Button>
      </Dropdown>
      {clipboard && (
        <Button size="small" data-testid="list-paste" onClick={() => st().pasteInto(null)}>
          粘贴(1)
        </Button>
      )}
      </>)}
    </div>
  );
}

export default function ListMode() {
  const nodes = useSceneStore((s) => s.nodes);
  const collapsed = useSceneStore((s) => s.collapsed);
  const selectedKey = useSceneStore((s) => s.selectedKey);
  const serverIssues = useSceneStore((s) => s.serverIssues);
  const cases = useSceneStore((s) => s.cases);
  const readOnly = useSceneStore((s) => s.readOnly);
  const [q, setQ] = useState("");

  const badKeys = useMemo(
    () => new Set(mergeIssues(nodes, serverIssues).map((i) => i.node_key)),
    [nodes, serverIssues],
  );
  const caseName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cases) m.set(c.id, c.name);
    return (ref: string) => m.get(ref) ?? null;
  }, [cases]);

  const allRows = useMemo(() => rowsOf(nodes, collapsed), [nodes, collapsed]);
  // allRows 只含展开的行：被折叠藏住的步数要单算——「折叠里没搜」≠「全树都没有」，
  // 空文案按这个数二选一，才不折叠时才能说全称否定。
  const hiddenByCollapse = useMemo(() => rowsOf(nodes, []).length - allRows.length, [nodes, allRows]);
  const kw = q.trim().toLowerCase();
  const rows = kw
    ? allRows.filter((r) =>
        (r.node.name ?? "").toLowerCase().includes(kw) || r.node.key.toLowerCase().includes(kw))
    : allRows;

  const st = () => useSceneStore.getState();

  /** 落在某行上：容器=移入；普通行=插到它后面（同层）。与画布 dropOn 同一 moveNode 口径。 */
  const onRowDrop = (r: Row, dt: DataTransfer) => {
    const s = st();
    if (s.readOnly) return; // D146：只读不收任何拖放载荷（与 Canvas 的早退同一道门）
    const moved = dt.getData(DND_NODE);
    const kind = dt.getData(DND_KIND);
    if (moved) {
      if (moved === r.node.key) return;
      const isContainer = (CONTAINER_KINDS as readonly string[]).includes(r.node.kind);
      if (isContainer) {
        if (!s.moveInto(moved, r.node.key)) {
          message.warning("这个移动被拒绝：不能移进自己或自己的后代，目标也得是容器");
        }
        return;
      }
      // 普通行：在同层列表里插到它后面
      const parentKey = r.parentKey;
      const siblings = parentKey
        ? childrenOf(findByKey(s.nodes, parentKey)?.[0] ?? { key: "", kind: "group" })
        : s.nodes;
      const idx = siblings.findIndex((x) => x.key === r.node.key);
      // moveNode 是**先删后插**，而 idx 取自还没删的列表：往下拖时被拖节点自己那一格
      // 会被抽掉，不补这一格就会落到目标后面第二格（拖 a 到 b 后 ⇒ b,c,a）。
      // 与 StepListEditor.tsx:199 的 `from < i ? i - 1 : i` 同一口径。
      const from = siblings.findIndex((x) => x.key === moved);
      const at = from >= 0 && from < idx ? idx : idx + 1;
      if (!s.moveNodeTo(moved, parentKey, at)) {
        message.warning("这个移动被拒绝：不能移进自己或自己的后代");
      }
      return;
    }
    if (kind) {
      s.dropOn({ kind: kind as Kind, ref: dt.getData(DND_REF) || undefined, name: dt.getData(DND_NAME) || undefined }, r.node.key);
    }
  };

  if (nodes.length === 0) {
    return (
      <div data-testid="scene-list-mode" style={{ height: "100%", overflow: "auto", background: "var(--tp-bg-container)" }}>
        <Toolbar q={q} setQ={setQ} />
        <Typography.Text type="secondary" style={{ padding: 16 }}>
          还没有步骤。切回画布，从左侧把用例或逻辑控件拖进来。
        </Typography.Text>
      </div>
    );
  }

  return (
    <div data-testid="scene-list-mode" style={{ height: "100%", overflow: "auto", background: "var(--tp-bg-container)", padding: "4px 0" }}>
      <Toolbar q={q} setQ={setQ} />
      {rows.length === 0 && (
        <Typography.Text className="tp-text-sm" type="secondary" style={{ padding: "8px 12px", display: "block" }}>
          {/* 折叠着的步没进搜索结果——有折叠时把「未参与搜索」说破，全称否定只留给全展开态 */}
          {hiddenByCollapse > 0
            ? <>没有名字或 key 含「{q}」的步骤（折叠中的 {hiddenByCollapse} 个步骤未参与搜索，展开后再试）</>
            : <>没有名字或 key 含「{q}」的步骤</>}
        </Typography.Text>
      )}
      {rows.map((r) => {
        const n = r.node;
        const meta = kindMeta(n.kind);
        const bad = badKeys.has(n.key) || !isValidKey(n.key);
        return (
          <div key={n.key}
            data-testid="scene-list-row" data-key={n.key}
            data-selected={n.key === selectedKey ? "true" : "false"}
            draggable={!kw && !readOnly /* 搜索过滤态下行序不代表真实顺序，拖了会误导；只读没有排序 */}
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_NODE, n.key);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              const types = Array.from(e.dataTransfer.types);
              if (types.includes(DND_NODE) || types.includes(DND_KIND)) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRowDrop(r, e.dataTransfer);
            }}
            onClick={() => st().select(n.key)}
            style={{
              display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", cursor: "pointer",
              paddingLeft: 12 + r.depth * 16,
              background: n.key === selectedKey ? "#EAF6F1" : undefined,
              opacity: n.disable ? 0.55 : 1,
            }}>
            <Checkbox data-testid={"list-enable-" + n.key}
              checked={!n.disable} disabled={readOnly}
              onClick={(e) => e.stopPropagation()}
              onChange={() => st().toggleDisableKey(n.key)} />
            <span data-testid={"list-collapse-" + n.key}
              onClick={(e) => { e.stopPropagation(); if (r.hasChildren) st().toggleCollapsed(n.key); }}
              className="tp-text-xs"
              style={{ width: 16, textAlign: "center", color: "var(--tp-text-3)" }}>
              {r.hasChildren
                ? (collapsed.includes(n.key) ? <RightOutlined /> : <DownOutlined />)
                : <span style={{ opacity: 0 }}>·</span>}
            </span>
            <span className="tp-text-sm" style={{ width: 40, color: "var(--tp-text-3)", fontVariantNumeric: "tabular-nums" }}>{r.no}</span>
            <span style={{ width: 4, alignSelf: "stretch", background: meta.color, borderRadius: 2 }} />
            <span className="tp-text-sm" style={{ color: "var(--tp-text-2)", width: 80, flexShrink: 0 }}>{meta.label}</span>
            <span className="tp-text-md" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{n.name || n.key}</span>
            <span className="tp-text-sm" style={{ color: "var(--tp-text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
              {summaryOf(n, caseName)}
            </span>
            {bad && <span className="tp-text-xs" data-testid="node-badge" title="校验问题，见底部问题面板" style={{ width: 16, height: 16, borderRadius: "50%", background: "var(--tp-func-error)", color: "#fff", lineHeight: "16px", textAlign: "center", flexShrink: 0 }}>!</span>}
            <span style={{ flex: 1 }} />
            {/* D146：行菜单里除「重命名（去右面板）」外全是写动作，只读整钮隐藏 */}
            {!readOnly && (
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "add-after", label: <span data-testid={"list-add-after-" + n.key}>加一步到后…</span>,
                    children: INSERT_KINDS.map((k) => ({
                      key: "la-" + k, label: <span data-testid={"list-ins-" + n.key + "-" + k}>{labelOf(k)}</span>,
                      onClick: () => { st().addStep(k, n.key); },
                    })) },
                  { key: "rename", label: <span data-testid="list-rename">重命名（去右面板）</span>,
                    onClick: () => { st().select(n.key); } },
                  { key: "copy", icon: <CopyOutlined />, label: <span data-testid="list-copy">复制</span>,
                    onClick: () => st().copyNode(n.key) },
                  { key: "dup", label: <span data-testid="list-duplicate">就地副本</span>,
                    onClick: () => st().duplicateKey(n.key) },
                  { key: "disable", label: <span data-testid="list-disable">{n.disable ? "启用" : "禁用"}</span>,
                    onClick: () => st().toggleDisableKey(n.key) },
                  { type: "divider" as const },
                  { key: "del", danger: true, icon: <DeleteOutlined />,
                    label: <span data-testid="list-delete">删除</span>,
                    onClick: () => st().removeKey(n.key) },
                ],
              }}>
              <Button size="small" type="text" data-testid="list-menu"
                onClick={(e) => e.stopPropagation()} icon={<span style={{ letterSpacing: 1 }}>···</span>} />
            </Dropdown>
            )}
          </div>
        );
      })}
      <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ padding: "8px 12px" }}>
{/* 搜索过滤态 draggable 已摘（行序不代表真实顺序），页脚不许再承诺能拖；只读同理 */}
        {readOnly
          ? "只读模式：可查看与搜索，编辑把手已关闭。与画布同一份图，随时切换。"
          : kw
            ? "搜索过滤态中不可拖拽排序；清空搜索即恢复。与画布同一份图，随时切换。"
            : "拖把手=排序，拖到容器行=嵌套；与画布同一份图，随时切换。"}
      </Typography.Paragraph>
    </div>
  );
}
