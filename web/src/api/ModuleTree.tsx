// 接口模块树（§11.4.2 左栏 208）：树 + 计数 + 悬停菜单 + 回收站切换。
// 数据由父组件加载（列表要共用同一棵树做子树过滤）；这里只管展示与变更动作。
import { useState } from "react";
import type { ReactNode } from "react";
import { Button, Dropdown, Empty, Input, Modal, Tag, Tooltip, Tree, Typography, message } from "antd";
import { DeleteOutlined, MoreOutlined, PlusOutlined, RestOutlined, UndoOutlined } from "../ui/icons";
import { patch, post } from "../api/client";
import { purgeDetachedClauses, type PurgeReceipt } from "../shared/moduleTree";

export interface ModNode {
  id: string; parent_id: string | null; name: string; sort: number;
  status: string; count: number; children: ModNode[];
}

interface Props {
  projectId: string;
  tree: ModNode[];
  recycled: ModNode[];
  inRecycled: boolean;
  onToggleRecycled: (v: boolean) => void;
  selected: string | null;       // null = 全部
  onSelect: (id: string | null) => void;
  onChanged: () => void;         // 变更后父组件重拉树 + 列表
  canManage: boolean;            // api:def:delete 同位（MEMBER 无 *:delete 天然禁）
  canCreate: boolean;
  // 场景模块树（1B T17）复用本组件：交互约定完全一致，只有端点前缀与文案名词不同。
  // 全部可选且默认 = 接口模块原行为，api.tsx 一行不用改。
  apiBase?: string;              // 默认 "/api-modules"；场景传 "/scenario-modules"
  allLabel?: string;             // 默认「全部接口」
  noun?: string;                 // 删除/彻底删除文案里的资产名词，默认「接口」
  // 徽标数字口径的悬停说明（R122）。三棵树的 count 都是 group_by(module_id) 的**直属**
  // 计数，而 UI 树那份还把「用例」也算进去（ui_test/module_services.py:100）——于是元素库
  // 里出现过「徽标写 5、列表只有 4 行」的真冲突（演示项目：4 元素 + 1 用例），
  // 界面上一个字不解释，看着就像计数坏了。徽标是共用组件画的，解释也放在这里。
  countTip?: string;
  // 可选：本页模块回收是「非空拒绝」而不是「资产转未分类」时，用这句话替换默认承诺，
  // 免得确认框说「资产不会删」而后端回 409（假承诺）。默认 undefined = 沿用原行为。
  deleteHint?: string;
  // 回执里的计数键（文件库目录回执叫 purged_folders；其余树叫 purged_modules）
  purgeCountKey?: "purged_modules" | "purged_folders";
  // 第二十六轮：父页取树失败时把错传进来。三棵树的数据都由父组件加载，失败时
  // recycled 停在初始 [] —— 空回收站那一句「回收站是空的」于是是**故障**说的，
  // 不是数据库说的（父页刷新失败刻意不清行，但首屏就挂时无行可清，只剩这句假话）。
  // 可选且默认 undefined = 沿用原行为，没传的调用方一字不改。
  loadError?: string | null;
}

type Prompt = { kind: "root" | "child" | "rename"; parent: string | null; name: string; id?: string };

interface TreeNode { key: string; title: ReactNode; children?: TreeNode[] }

export default function ModuleTree(p: Props) {
  const base = p.apiBase ?? "/api-modules";
  const noun = p.noun ?? "接口";
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  // 彻底删除（§11.4.18）：不可逆，必须手输模块名；模块删了接口不陪葬，只是变未分类
  const [purge, setPurge] = useState<{ id: string; name: string } | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purging, setPurging] = useState(false);

  async function submitPrompt() {
    if (!prompt || saving) return;
    const v = name.trim();
    if (!v) { message.warning("名称不能为空"); return; }
    setSaving(true);
    try {
      if (prompt.kind === "rename" && prompt.id) {
        await patch(base + "/" + prompt.id, { project_id: p.projectId, name: v });
        message.success("已重命名");
      } else {
        await post(base, { project_id: p.projectId, parent_id: prompt.parent, name: v });
        message.success("模块已创建");
      }
      setPrompt(null); setName(""); p.onChanged();
    } catch { /* toast 已由 client 弹出 */ } finally { setSaving(false); }
  }

  function remove(id: string, label: string) {
    Modal.confirm({
      centered: true,
      title: "模块进回收站？",
      content: p.deleteHint ?? ("「" + label + "」连子孙一起进回收站；" + noun + "不会被删，恢复后原样回归。"),
      okText: "放入回收站", okButtonProps: { danger: true }, cancelText: "取消",
      onOk: async () => {
        try {
          await post(base + "/" + id + "/delete", { project_id: p.projectId });
          message.success("已放入回收站");
          if (p.selected === id) p.onSelect(null);
          p.onChanged();
        } catch { /* toast */ }
      },
    });
  }

  async function restore(id: string) {
    try {
      await post(base + "/" + id + "/restore", { project_id: p.projectId });
      message.success("已恢复");
      p.onChanged();
    } catch { /* toast */ }
  }

  async function submitPurge(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      const r = await post<PurgeReceipt>(
        base + "/" + purge.id + "/purge", { project_id: p.projectId, confirm_name: purge.name });
      // 回执键名三棵树各不同（definitions/scenarios/elements），全部接住——只认前两把
      // 时 UI 树的「N 个元素转为未分类」会被静默算成 0（moduleTree.ts 有钉死的单测）。
      const detached = purgeDetachedClauses(r, noun);
      const purged = (r as unknown as Record<string, number>)[p.purgeCountKey ?? "purged_modules"]
        ?? r.purged_modules ?? 0;
      message.success("已彻底删除 " + purged
        + (p.purgeCountKey === "purged_folders" ? " 个目录" : " 个模块")
        + (detached.length ? "，" + detached.join("，") : ""));
      setPurge(null); setPurgeName("");
      if (p.selected === purge.id) p.onSelect(null);
      p.onChanged();
    } catch { /* toast；保持弹窗打开，改名重试或取消 */ } finally { setPurging(false); }
  }

  const nodes = p.inRecycled ? p.recycled : p.tree;
  const toNode = (m: ModNode): TreeNode => ({
    key: m.id,
    title: (
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
        {!p.inRecycled && (p.countTip ? (
          <Tooltip title={p.countTip}>
            <Tag data-testid={"module-count-" + m.name} style={{ marginInlineEnd: 0, cursor: "help" }}>{m.count}</Tag>
          </Tooltip>
        ) : (
          <Tag style={{ marginInlineEnd: 0 }}>{m.count}</Tag>
        ))}
        {!p.inRecycled && (p.canCreate || p.canManage) && (
          <Dropdown
            trigger={["hover"]}
            menu={{
              items: [
                ...(p.canCreate ? [{ key: "child", icon: <PlusOutlined />, label: "新建子模块" }] : []),
                ...(p.canManage ? [{ key: "rename", label: "重命名" },
                  { key: "del", icon: <DeleteOutlined />, label: "放入回收站", danger: true }] : []),
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === "child") { setPrompt({ kind: "child", parent: m.id, name: "" }); setName(""); }
                if (key === "rename") { setPrompt({ kind: "rename", parent: m.parent_id, name: m.name, id: m.id }); setName(m.name); }
                if (key === "del") remove(m.id, m.name);
              },
            }}
          >
            <Button size="small" type="text" icon={<MoreOutlined />} aria-label={"模块菜单-" + m.name}
              onClick={(e) => e.stopPropagation()} />
          </Dropdown>
        )}
        {p.inRecycled && p.canManage && (
          <Button size="small" type="text" icon={<UndoOutlined />} aria-label={"恢复-" + m.name}
            onClick={(e) => { e.stopPropagation(); void restore(m.id); }} />
        )}
        {p.inRecycled && p.canManage && (
          <Button size="small" type="text" danger icon={<DeleteOutlined />}
            data-testid={"module-purge-" + m.name} aria-label={"彻底删除-" + m.name}
            onClick={(e) => { e.stopPropagation(); setPurge({ id: m.id, name: m.name }); setPurgeName(""); }} />
        )}
      </span>
    ),
    children: m.children.length ? m.children.map(toNode) : undefined,
  });

  return (
    <div data-testid="module-tree" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* 标题行：标题左、图标动作右。「回收站」是视图切换不是操作，降为标题行的图标钮
          （带 title/aria-label），树区不再被两个整行文字钮占掉三行高度。 */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <Typography.Text strong className="tp-text-md" style={{ flex: 1, color: "var(--tp-text-2)" }}>
          {p.inRecycled ? "回收站" : "模块"}
        </Typography.Text>
        {p.canManage && (
          <Tooltip title={p.inRecycled ? "退出回收站" : "回收站"}>
            <Button size="small" type="text" icon={p.inRecycled ? <UndoOutlined /> : <RestOutlined />}
              aria-label={p.inRecycled ? "退出回收站" : "回收站"}
              data-testid="module-recycled-toggle"
              onClick={() => { p.onToggleRecycled(!p.inRecycled); p.onSelect(null); }} />
          </Tooltip>
        )}
        {p.canCreate && !p.inRecycled && (
          <Tooltip title="新建模块">
            <Button size="small" type="text" icon={<PlusOutlined />} aria-label="新建模块"
              data-testid="module-create"
              onClick={() => { setPrompt({ kind: "root", parent: null, name: "" }); setName(""); }} />
          </Tooltip>
        )}
      </div>
      {p.loadError && (
        // 失败不摊成空栏（CaseList.tsx:360「回收站没取到」同尺）：首屏就挂时 recycled
        // 停在初始 []，只画一句「回收站是空的」等于把故障演成实测零条；刷新才挂时下面
        // 还是上次取到的行，那更得说清这一栏现在不作数。
        <Typography.Text className="tp-text-sm" type="secondary" data-testid="module-tree-load-error">
          {p.inRecycled ? "回收站" : "模块树"}没取到（最近一次加载失败）——这一栏现在不作数
          {nodes.length ? "，下面是上次取到的" : "，空着不等于真的没有"}
        </Typography.Text>
      )}
      {nodes.length === 0 && p.inRecycled && !p.loadError ? (
        <Empty description="回收站是空的" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Tree
          blockNode
          key={p.inRecycled ? "recycled" : "normal"}
          selectedKeys={p.selected ? [p.selected] : []}
          defaultExpandAll
          treeData={[
            ...(p.inRecycled ? [] : [{ key: "__all", title: <span data-testid="module-all">{p.allLabel ?? "全部接口"}</span> }]),
            ...nodes.map(toNode),
          ]}
          onSelect={(keys) => {
            const k = keys[0] as string | undefined;
            p.onSelect(!k || k === "__all" ? null : k);
          }}
        />
      )}
      <Modal centered open={prompt !== null} title={
        prompt?.kind === "rename" ? "重命名模块" : prompt?.kind === "child" ? "新建子模块" : "新建模块"
      } okText="保存" cancelText="取消" confirmLoading={saving}
      onOk={() => void submitPrompt()} onCancel={() => { setPrompt(null); setName(""); }}>
        <Input data-testid="module-name" value={name} autoFocus maxLength={200}
          placeholder="模块名" onChange={(e) => setName(e.target.value)}
          onPressEnter={() => void submitPrompt()} />
      </Modal>

      {/* 彻底删除：§11.4.18 要求「输名称确认」；服务端同样硬校验，不靠前端拦 */}
      <Modal centered
        open={purge !== null} onCancel={() => { setPurge(null); setPurgeName(""); }}
        destroyOnHidden width={520}
        title="彻底删除模块？" okText="我已确认，彻底删除" cancelText="取消"
        okButtonProps={{ danger: true, "data-testid": "module-purge-ok",
          disabled: purgeName !== (purge?.name ?? ""), loading: purging }}
        onOk={() => void submitPurge()}
      >
        <Typography.Paragraph>
          「{purge?.name}」及其
          <Typography.Text strong>全部子模块</Typography.Text>将被物理删除，
          <Typography.Text strong>无法恢复</Typography.Text>。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          模块下的{noun}不会被删，会变成「未分类」，仍然可以在列表里找到。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          输入模块名 <Typography.Text code>{purge?.name}</Typography.Text> 以确认。
        </Typography.Paragraph>
        <Input data-testid="module-purge-confirm" value={purgeName} autoFocus
          placeholder={purge?.name} onChange={(e) => setPurgeName(e.target.value)} />
      </Modal>
    </div>
  );
}
