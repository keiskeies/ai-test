// 角色（§11.4.21 / D37）：内置模板只读卡 ×4 + [+ 新建自定义(从模板复制)] + 角色编辑抽屉。
// 权限菜单树是 antd Tree checkable 的两级勾选——树的数据源是后端 role_perm_tree
// （REGISTRY.perm_points() 的运行时投影），前端一棵树都不许硬编码：硬编码 = 后端加了位、
// 界面上永远选不到的第二道假门（§13 纪律 1）。
// 内置卡上永远没有 [编辑]/[删除]（门禁在后端 403，前端只是不给门把手）。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Card, Drawer, Input, Space, Tag, Tree, Typography, message,
} from "antd";
import type { DataNode } from "antd/es/tree";
import { get, patch, post } from "../api/client";
import { matchPerm } from "../auth/perms";
import { FilterBar, Toolbar } from "../ui/Toolbar";
import StateView from "../ui/StateView";

export interface RoleTemplate {
  code: string;
  name: string;
  perms: string[];
}

export interface CustomRole {
  code: string;
  project_id: string;
  name: string;
  perms: string[];
  template_code: string;
}

export interface PermTreeNode {
  key: string;
  title: string;
  children?: PermTreeNode[];
}

interface TreeOut {
  nodes: PermTreeNode[];
  templates: RoleTemplate[];
}

/** 勾选值 → 提交的 perms：只留叶子（完整权限位），父节点 key 是前缀族不是位。 */
export function leavesOnly(checked: string[], nodes: PermTreeNode[]): string[] {
  const leafKeys = new Set<string>();
  for (const fam of nodes) {
    for (const c of fam.children ?? []) leafKeys.add(c.key);
  }
  return checked.filter((k) => leafKeys.has(k));
}

/** 已存 perms → Tree checkedKeys。叶子精确命中直接勾；含模式串（`*`、`api:*`、`-x`）时
 * 按 matchPerm 展开成「这些模式实际放行的叶子」——从模板复制（内置位全是模式串）时
 * 预勾选如实反映模板语义，而不是给一棵空树让用户重勾。保存按当前勾选整体替换为叶子位。 */
export function toCheckedKeys(perms: string[], nodes: PermTreeNode[]): string[] {
  const leafKeys = new Set<string>();
  for (const fam of nodes) {
    for (const c of fam.children ?? []) leafKeys.add(c.key);
  }
  const exact = perms.filter((p) => leafKeys.has(p));
  const patterns = perms.filter((p) => !leafKeys.has(p));
  if (patterns.length === 0) return exact;
  const expanded = [...leafKeys].filter((l) => matchPerm(patterns, l));
  return [...new Set([...exact, ...expanded])];
}

export default function RolesTab({ projectId, canCreate, canUpdate, canDelete }: {
  projectId: string; canCreate: boolean; canUpdate: boolean; canDelete: boolean;
}) {
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [templates, setTemplates] = useState<RoleTemplate[]>([]);
  const [nodes, setNodes] = useState<PermTreeNode[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // 抽屉态：null=关；template=从模板复制新建；editing=改既有自定义角色
  const [drawer, setDrawer] = useState<null | { mode: "create"; template: string; initName: string; initPerms: string[] }
    | { mode: "edit"; code: string; initName: string; initPerms: string[] }>(null);
  const [name, setName] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setFailed(false);
    try {
      const t = await get<Partial<TreeOut>>("/role-perm-tree?project_id=" + encodeURIComponent(projectId), { silent: true });
      setNodes(t.nodes ?? []);
      setTemplates(t.templates ?? []);
      const r = await get<{ items: CustomRole[] }>("/custom-roles?project_id=" + encodeURIComponent(projectId), { silent: true });
      setRoles(r.items);
    } catch { setFailed(true); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const treeData: DataNode[] = useMemo(() => nodes.map((fam) => ({
    key: fam.key,
    title: fam.title,
    children: (fam.children ?? []).map((c) => ({ key: c.key, title: c.title })),
  })), [nodes]);

  const openDrawer = useCallback((init: NonNullable<typeof drawer>) => {
    setDrawer(init);
    setName(init.initName);
    setChecked(toCheckedKeys(init.initPerms, nodes));
  }, [nodes]);

  const save = useCallback(async (): Promise<void> => {
    const perms = leavesOnly(checked, nodes);
    if (!name.trim()) { message.warning("角色名不能为空"); return; }
    if (perms.length === 0) { message.warning("至少勾一个权限位"); return; }
    setSaving(true);
    try {
      if (drawer?.mode === "create") {
        await post("/custom-roles", { project_id: projectId, name: name.trim(),
          template_code: drawer.template, perms });
        message.success("自定义角色已创建");
      } else if (drawer?.mode === "edit") {
        await patch("/custom-roles/" + drawer.code, { project_id: projectId, name: name.trim(), perms });
        message.success("自定义角色已更新");
      }
      setDrawer(null);
      await load();
    } catch { /* client 已 toast（含「内置不可改」的 403 原因） */ }
    finally { setSaving(false); }
  }, [checked, drawer, load, name, nodes, projectId]);

  const remove = useCallback(async (code: string): Promise<void> => {
    setBusy(true);
    try {
      await post("/custom-roles/" + code + "/delete", { project_id: projectId });
      message.success("已删除");
      await load();
    } catch { /* in_use 409 的计数与原因由 client 弹出，不静默 */ }
    finally { setBusy(false); }
  }, [load, projectId]);

  return (
    <div data-testid="tab-roles" className="tp-fill-tab">
      {failed && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message="角色数据没取到（权限树/自定义角色列表请求失败）" data-testid="roles-load-failed" />
      )}
      <Typography.Title level={5} style={{ marginTop: 0 }}>内置模板（只读）</Typography.Title>
      {/* 容器断点卡片墙（2026-11-22 实测：xl={6} 在 1200 视口下卡宽 216，标题内容盒只剩
          104 < 自然宽 135，三张内置卡全裁）。--tp-wall-min=300：标题盒 ≥135 + extra 钮
          实测 86 + 卡片左右内边距 40 ≈ 280 是下限，抬到 300 给「项目管理员」这类 6 字
          模板名留冗余；944 容器出 3×304、1552 封顶容器出 4×368，两种都不裁。 */}
      <div className="tp-wall" style={{ "--tp-wall-min": "300px" } as React.CSSProperties}>
        {templates.map((t) => (
          <Card key={t.code} size="small" data-testid="role-tpl-card" data-tpl={t.code}
            title={<Space size={8}><span>{t.name}</span><Tag>内置</Tag></Space>}
            extra={canCreate && (
              <Button size="small" type="primary" data-testid="role-clone-btn"
                onClick={() => openDrawer({ mode: "create", template: t.code,
                  initName: t.name + "（副本）", initPerms: toCheckedKeys(t.perms, nodes) })}>
                从模板复制
              </Button>
            )}>
            <Typography.Text type="secondary" className="tp-mono tp-text-sm">
              {t.perms.join(" · ")}
            </Typography.Text>
          </Card>
        ))}
      </div>
      <FilterBar>
        <Typography.Title level={5} style={{ margin: 0 }}>自定义角色</Typography.Title>
        {canCreate && (
          <Button type="primary" data-testid="role-create-btn"
            onClick={() => openDrawer({ mode: "create", template: "READONLY", initName: "", initPerms: [] })}>
            + 新建自定义(从模板复制)
          </Button>
        )}
      </FilterBar>
      <div className="tp-wall" style={{ "--tp-wall-min": "300px" } as React.CSSProperties}>
        {roles.map((r) => (
          <Card key={r.code} size="small" data-testid="role-custom-card" data-role-code={r.code}
            title={<Space size={8}><span>{r.name}</span><Tag color="blue">{r.template_code} 复制</Tag></Space>}>
            {/* 36 = 12 号字行高 18 × 两行：预置两行高度让同排卡片的按钮行对齐；
                原 34 是行高没算对的两行半吊子值。 */}
            <Typography.Paragraph type="secondary" className="tp-mono tp-text-sm" style={{ minHeight: 36 }}>
              {r.perms.join(" · ")}
            </Typography.Paragraph>
            <Toolbar compact>
              {canUpdate && (
                <Button size="small" data-testid="role-edit-btn"
                  onClick={() => openDrawer({ mode: "edit", code: r.code, initName: r.name, initPerms: r.perms })}>
                  编辑
                </Button>
              )}
              {canDelete && (
                <Button size="small" danger loading={busy} data-testid="role-delete-btn"
                  onClick={() => void remove(r.code)}>删除</Button>
              )}
            </Toolbar>
          </Card>
        ))}
      </div>
      {roles.length === 0 && !failed && (
        <StateView title={canCreate
          ? "还没有自定义角色——从上方模板复制一个开始裁剪"
          : "还没有自定义角色。你只能看：新建要 iam:role:create，这页上没有可点的入口"} />
      )}
      {drawer && (
        <Drawer open width={720} data-testid="role-drawer"
          title={drawer.mode === "create" ? "新建自定义角色（从模板复制）" : "编辑自定义角色"}
          onClose={() => setDrawer(null)}
          extra={(
            <Space>
              <Button onClick={() => setDrawer(null)}>取消</Button>
              <Button type="primary" loading={saving} data-testid="role-save-btn" onClick={() => void save()}>保存</Button>
            </Space>
          )}>
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <Input addonBefore="名称" value={name} data-testid="role-f-name"
              onChange={(e) => setName(e.target.value)} placeholder="如：接口测试专员" />
            {drawer.mode === "create" && (
              <Typography.Text className="tp-text-sm" type="secondary">
                模板 {drawer.template} · 勾选即裁剪（任意裁剪 + 任意勾选，计划 D37 假设 4）
              </Typography.Text>
            )}
            {/* 两级勾选树：一级 = 权限位前缀族，二级 = 完整权限位；数据源永远是后端。
                virtual=false：全量挂载（位全集 ~百级，不需要虚拟滚动），也让测试能点到叶子。 */}
            <div data-testid="role-perm-tree">
              <Tree checkable defaultExpandAll virtual={false} treeData={treeData}
                checkedKeys={checked}
                onCheck={(keys) => setChecked((Array.isArray(keys) ? keys : keys.checked).map(String))} />
            </div>
          </Space>
        </Drawer>
      )}
    </div>
  );
}
