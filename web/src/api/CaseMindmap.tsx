// 用例脑图（D268 / C11）：把模块树 + 便签 + 用例画成一棵树。
//
// 与 MS 的边界一致：**用例只挂模块**，便签（MS 的「空白节点」）是并列的笔记层，
// 不承载用例。写操作全部走既有端点——模块 CRUD、用例 PATCH、便签 CRUD——
// 不另造「批量保存」契约（MS 的 minderEdit 是一个事务，我们的编辑器是一步一请求，
// 失败即停，不会出现改了一半又假装成功的情况）。
//
// 拖拽规则（服务端同尺）：
// - 用例只能落到模块（或根=未分类）；落到便签会被拦下（后端也会 422）；
// - 模块只能落到模块或根；落到便签/自己的子树被拦下（后端有环检测）；
// - 便签可落到模块、便签或根。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TreeProps } from "antd";
import { Button, Dropdown, Empty, Input, Modal, Tag, Tooltip, Tree, Typography, message } from "antd";
import type { DataNode } from "antd/es/tree";
import { MoreOutlined, PlusOutlined } from "../ui/icons";
import { functionalApi, functionalMinderApi } from "../api/functional";
import type { MinderCase, MinderNode, MinderTree } from "../api/functional";

interface Props {
  projectId: string;
  /** 写操作开关（用例/模块/便签共用 `functional:case:update` 口径，页面侧已按权限算好）。 */
  canEdit: boolean;
  /** 点用例叶 → 页面打开详情（脑图不复制详情逻辑）。 */
  onOpenCase: (caseId: string) => void;
}

type PromptKind = "new-module" | "new-note" | "module" | "note" | "case";
type Prompt = { kind: PromptKind; id?: string; parentId: string | null };
type KeyKind = "module" | "note" | "case" | "unfiled";

const UNFILED_KEY = "unfiled:__all";

function kindOf(key: string): KeyKind {
  const k = key.slice(0, key.indexOf(":"));
  return (k === "module" || k === "note" || k === "case" ? k : "unfiled");
}
function idOf(key: string): string {
  return key.slice(key.indexOf(":") + 1);
}

export default function CaseMindmap({ projectId, canEdit, onOpenCase }: Props) {
  const [data, setData] = useState<MinderTree | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await functionalMinderApi.tree(projectId);
      setData(r);
      setErr(null);
    } catch {
      // 失败不装成空脑图（ModuleTree 的 loadError 同尺）：空着不等于项目里没有用例。
      setErr("脑图没取到（最近一次加载失败）——空着不等于项目里没有用例");
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  // 树数据是异步来的：`defaultExpandAll` 只在首帧生效，晚到就全折叠。用受控展开，
  // 每次重拉后默认全展开（改完名/移完位不该让用户再去点开一层层节点）。
  const [expanded, setExpanded] = useState<string[]>([]);
  const allKeys = useMemo(() => {
    const keys: string[] = [];
    function walk(nodes: MinderNode[]): void {
      for (const n of nodes) { keys.push(n.kind + ":" + n.id); walk(n.children); }
    }
    walk(data?.nodes ?? []);
    if (data?.unfiled_cases.length) keys.push(UNFILED_KEY);
    return keys;
  }, [data]);
  useEffect(() => { setExpanded(allKeys); }, [allKeys]);

  // key → 父节点 key（根为 null）。拖拽落点要靠它区分「放进节点里」与「插到同级」。
  const parents = useMemo(() => {
    const map: Record<string, string | null> = {};
    function walk(nodes: MinderNode[], parent: string | null): void {
      for (const n of nodes) {
        const key = n.kind + ":" + n.id;
        map[key] = parent;
        for (const c of n.cases) map["case:" + c.id] = key;
        walk(n.children, key);
      }
    }
    walk(data?.nodes ?? [], null);
    map[UNFILED_KEY] = null;
    for (const c of data?.unfiled_cases ?? []) map["case:" + c.id] = UNFILED_KEY;
    return map;
  }, [data]);

  function openPrompt(kind: PromptKind, parentId: string | null, current = "", id?: string): void {
    setPrompt({ kind, parentId, id });
    setName(current);
  }

  async function submitPrompt(): Promise<void> {
    if (!prompt || saving) return;
    const v = name.trim();
    if (!v) { message.warning("名称不能为空"); return; }
    setSaving(true);
    try {
      if (prompt.kind === "new-module") {
        await functionalApi.createModule({ project_id: projectId, parent_id: prompt.parentId, name: v });
        message.success("模块已创建");
      } else if (prompt.kind === "new-note") {
        await functionalMinderApi.createNote(projectId, v, prompt.parentId);
        message.success("便签已创建");
      } else if (prompt.kind === "module") {
        await functionalApi.updateModule(prompt.id ?? "", { project_id: projectId, name: v });
        message.success("已重命名");
      } else if (prompt.kind === "note") {
        await functionalMinderApi.updateNote(prompt.id ?? "", { project_id: projectId, name: v });
        message.success("已重命名");
      } else {
        await functionalApi.updateCase(prompt.id ?? "", { project_id: projectId, name: v });
        message.success("已重命名");
      }
      setPrompt(null); setName("");
      await load();
    } catch { /* toast 由 client 统一弹 */ } finally { setSaving(false); }
  }

  function remove(kind: "module" | "note", id: string, label: string): void {
    Modal.confirm({
      centered: true,
      title: kind === "module" ? "模块进回收站？" : "删除便签？",
      content: kind === "module"
        ? "「" + label + "」连子孙模块一起进回收站；用例不会被删，恢复后原样回归。"
        : "「" + label + "」及其子便签会一起删除，无法恢复；便签下不能还有模块。",
      okText: kind === "module" ? "放入回收站" : "删除便签",
      okButtonProps: { danger: true, "data-testid": "minder-confirm-ok" },
      cancelText: "取消",
      onOk: async () => {
        try {
          if (kind === "module") {
            await functionalApi.deleteModule(projectId, id);
            message.success("已放入回收站");
          } else {
            await functionalMinderApi.deleteNote(projectId, id);
            message.success("便签已删除");
          }
          await load();
        } catch { /* toast */ }
      },
    });
  }

  /** 祖先链检查（防把模块/便签拖进自己的子树）。 */
  function isDescendant(targetKey: string, ancestorKey: string): boolean {
    let cur: string | null = targetKey;
    let guard = 0;
    while (cur && guard < 10000) {
      if (cur === ancestorKey) return true;
      cur = parents[cur] ?? null;
      guard += 1;
    }
    return false;
  }

  const handleDrop: NonNullable<TreeProps["onDrop"]> = async (info) => {
    const dragKey = String(info.dragNode.key);
    const dropKey = String(info.node.key);
    const dragKind = kindOf(dragKey);
    const dragId = idOf(dragKey);
    // dropToGap = 插到落点同级；否则 = 放进落点里
    const targetKey = info.dropToGap ? (parents[dropKey] ?? null) : dropKey;
    const targetKind = targetKey ? kindOf(targetKey) : null;
    // 未分类组不是真实父节点：用例落进去 = module_id null，模块/便签不许落。
    const targetId = targetKey && targetKind !== "unfiled" ? idOf(targetKey) : null;
    if (targetKind === "case") { message.warning("用例不能当父节点"); return; }

    if (dragKind === "case") {
      if (targetKind === "note") { message.warning("用例只能挂在模块下"); return; }
      try {
        await functionalApi.updateCase(dragId, {
          project_id: projectId, module_id: targetId, module_set: true });
        message.success("已移动");
        await load();
      } catch { /* toast */ }
      return;
    }
    if (dragKind === "module") {
      if (targetKind === "note") { message.warning("模块只能挂在模块下"); return; }
      if (targetKind === "unfiled") { message.warning("「未分类用例」不是模块，不能把模块拖进去"); return; }
      if (targetKey && isDescendant(targetKey, dragKey)) {
        message.warning("不能移动到自己的子树里"); return;
      }
      try {
        await functionalApi.updateModule(dragId, {
          project_id: projectId, parent_id: targetId, parent_set: true });
        message.success("已移动");
        await load();
      } catch { /* toast */ }
      return;
    }
    if (dragKind === "note") {
      if (targetKind === "unfiled") { message.warning("便签不能放进「未分类用例」"); return; }
      if (targetKey && isDescendant(targetKey, dragKey)) {
        message.warning("不能移动到自己的子树里"); return;
      }
      try {
        await functionalMinderApi.updateNote(dragId, {
          project_id: projectId, parent_id: targetId, parent_set: true });
        message.success("已移动");
        await load();
      } catch { /* toast */ }
    }
  };

  function caseLeaf(c: MinderCase): DataNode {
    return {
      key: "case:" + c.id,
      isLeaf: true,
      title: (
        <span data-testid={"minder-case-" + c.id}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          onClick={() => onOpenCase(c.id)}>
          <Typography.Text type="secondary" className="tp-text-sm">#{c.num}</Typography.Text>
          <span>{c.name}</span>
          <Tag style={{ marginInlineEnd: 0 }}>{c.priority}</Tag>
        </span>
      ),
    };
  }

  function toTreeData(n: MinderNode, parentId: string | null): DataNode {
    const key = n.kind + ":" + n.id;
    const menuItems = [
      { key: "rename", label: n.kind === "module" ? "重命名模块" : "重命名便签" },
      ...(n.kind === "module" ? [{ key: "child-module", label: "新建子模块" }] : []),
      { key: "child-note", label: "新建子便签" },
      { key: "del", danger: true, label: n.kind === "module" ? "放入回收站" : "删除便签" },
    ];
    const title = (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        data-testid={"minder-" + n.kind + "-" + n.id}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {n.kind === "note" ? "✎ " + n.name : n.name}
        </span>
        {n.kind === "module" && <Tag style={{ marginInlineEnd: 0 }}>{n.case_count}</Tag>}
        {canEdit && (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: menuItems,
              onClick: ({ key: action, domEvent }) => {
                domEvent.stopPropagation();
                if (action === "rename") {
                  openPrompt(n.kind, parentId, n.name, n.id);
                } else if (action === "child-module") {
                  openPrompt("new-module", n.id);
                } else if (action === "child-note") {
                  openPrompt("new-note", n.id);
                } else {
                  remove(n.kind, n.id, n.name);
                }
              },
            }}
          >
            <Button size="small" type="text" icon={<MoreOutlined />}
              aria-label={"脑图菜单-" + n.name} data-testid={"minder-menu-" + n.id}
              onClick={(e) => e.stopPropagation()} />
          </Dropdown>
        )}
      </span>
    );
    return {
      key,
      title,
      children: [
        ...n.children.map((c) => toTreeData(c, n.id)),
        ...n.cases.map(caseLeaf),
      ],
    };
  }

  const treeData = useMemo<DataNode[]>(() => {
    if (!data) return [];
    const out: DataNode[] = data.nodes.map((n) => toTreeData(n, null));
    if (data.unfiled_cases.length) {
      out.push({
        key: UNFILED_KEY,
        title: (
          <span data-testid="minder-unfiled" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span>未分类用例</span>
            <Tag style={{ marginInlineEnd: 0 }}>{data.unfiled_cases.length}</Tag>
          </span>
        ),
        children: data.unfiled_cases.map(caseLeaf),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, canEdit]);

  const promptTitle =
    prompt?.kind === "new-module" ? "新建模块"
      : prompt?.kind === "new-note" ? "新建便签"
        : prompt?.kind === "case" ? "重命名用例" : "重命名";

  return (
    <div data-testid="case-minder" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Typography.Text type="secondary" data-testid="minder-total">
          共 {data?.total_cases ?? 0} 条用例（不含回收站）
        </Typography.Text>
        <span style={{ flex: 1 }} />
        {canEdit && (
          <>
            <Tooltip title="在根层写字（便签不承载用例）">
              <Button size="small" icon={<PlusOutlined />} data-testid="minder-add-note"
                onClick={() => openPrompt("new-note", null)}>新建便签</Button>
            </Tooltip>
            <Button size="small" icon={<PlusOutlined />} data-testid="minder-add-module"
              onClick={() => openPrompt("new-module", null)}>新建模块</Button>
          </>
        )}
      </div>
      {err && (
        <Typography.Text type="danger" className="tp-text-sm" data-testid="minder-error">{err}</Typography.Text>
      )}
      {!err && data && treeData.length === 0 ? (
        <Empty description="还没有模块或用例" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Tree
          blockNode
          selectable={false}
          expandedKeys={expanded}
          onExpand={(keys) => setExpanded(keys.map(String))}
          draggable={canEdit ? { icon: false } : false}
          onDrop={(info) => void handleDrop(info)}
          treeData={treeData}
        />
      )}

      <Modal centered open={prompt !== null} title={promptTitle}
        okText="保存" cancelText="取消" confirmLoading={saving}
        onOk={() => void submitPrompt()} onCancel={() => { setPrompt(null); setName(""); }}>
        <Input data-testid="minder-name" value={name} autoFocus maxLength={200}
          placeholder={prompt?.kind === "new-note" ? "便签内容" : "名称"}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={() => void submitPrompt()} />
      </Modal>
    </div>
  );
}
