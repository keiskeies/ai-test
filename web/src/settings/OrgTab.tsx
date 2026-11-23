// 组织（D269/D270）：平台级分组层——管组织、组织成员、项目归属与用户组；
// 组织只做分组，不给项目数据权限（项目可见性仍按成员制）。
//
// D270：本组件同时服务「组织管理员/组织成员的独立组织页」。按钮按后端逐行投影的
// `my_perms` 显隐（组织授权是 dynamic_perm，前端不看项目权限位）：
//   新建/删除组织 → 仅系统管理员（后端独占）；
//   改资料/管成员/管项目归属/管用户组/管缺陷状态流 → 对应组织管理位（ORG_ADMIN 天然全量）。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message,
} from "antd";
import { get } from "../api/client";
import {
  ORG_CAP, hasCap, orgApi, type OrgItem, type OrgMemberRow, type OrgPayload, type OrgProjectRow,
} from "../api/org";
import OrgGroupDrawer from "./OrgGroupDrawer";
import DefectFlowTab from "./DefectFlowTab";

interface ProjectLite {
  id: string;
  name: string;
}

const ROLE_LABEL: Record<string, string> = {
  SYSTEM_ADMIN: "平台管理员", ORG_ADMIN: "组织管理员", ORG_MEMBER: "组织成员",
};

export default function OrgTab({ isSysAdmin }: { isSysAdmin: boolean }) {
  const [rows, setRows] = useState<OrgItem[]>([]);
  const [q, setQ] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OrgItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<OrgPayload>();

  const [memberOrg, setMemberOrg] = useState<OrgItem | null>(null);
  const [members, setMembers] = useState<OrgMemberRow[]>([]);
  const [account, setAccount] = useState("");
  const [role, setRole] = useState("ORG_MEMBER");

  const [projectOrg, setProjectOrg] = useState<OrgItem | null>(null);
  const [orgProjects, setOrgProjects] = useState<OrgProjectRow[]>([]);
  const [allProjects, setAllProjects] = useState<ProjectLite[]>([]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [groupOrg, setGroupOrg] = useState<OrgItem | null>(null);
  const [flowOrg, setFlowOrg] = useState<OrgItem | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await orgApi.list(q);
      setRows(r.items);
      setLoadErr("");
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }, [q]);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (org: OrgItem) => {
    setEditing(org);
    form.setFieldsValue({ name: org.name, code: org.code, description: org.description ?? "" });
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await orgApi.update(editing.id, {
          name: values.name,
          description: values.description || null,
        });
        message.success("组织已更新");
      } else {
        await orgApi.create({ ...values, description: values.description || null });
        message.success("组织已创建");
      }
      setOpen(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (org: OrgItem) => {
    try {
      await orgApi.remove(org.id);
      message.success("组织已删除");
      await load();
    } catch {
      // 409 的文案（默认组织 / 仍有项目 / 最后一名管理员）由 client 统一提示
    }
  };

  const openMembers = async (org: OrgItem) => {
    setMemberOrg(org);
    setMembers([]);
    setAccount("");
    setRole("ORG_MEMBER");
    try {
      setMembers((await orgApi.members(org.id)).items);
    } catch {
      // 403/404 已由 client 提示
    }
  };

  const addMember = async () => {
    if (!memberOrg) return;
    const acc = account.trim();
    if (!acc) {
      message.warning("先填账号");
      return;
    }
    try {
      await orgApi.setMember(memberOrg.id, acc, role);
      message.success("成员已保存");
      setAccount("");
      setMembers((await orgApi.members(memberOrg.id)).items);
      await load();
    } catch {
      // 404 账号不存在 / 409 最后一名管理员：client 统一提示
    }
  };

  const removeMember = async (m: OrgMemberRow) => {
    if (!memberOrg) return;
    try {
      await orgApi.removeMember(memberOrg.id, m.user_id);
      message.success("已移出组织");
      setMembers((await orgApi.members(memberOrg.id)).items);
      await load();
    } catch {
      // 409 最后一名管理员
    }
  };

  const openProjects = async (org: OrgItem) => {
    setProjectOrg(org);
    setOrgProjects([]);
    setPicked(undefined);
    try {
      const [mine, all] = await Promise.all([
        orgApi.projects(org.id),
        get<{ items: ProjectLite[] }>("/projects?size=200", { silent: true }),
      ]);
      setOrgProjects(mine.items);
      setAllProjects(all.items);
    } catch {
      // 403 等由 client 提示
    }
  };

  const assign = async () => {
    if (!projectOrg || !picked) {
      message.warning("先选一个项目");
      return;
    }
    try {
      await orgApi.assignProject(projectOrg.id, picked);
      message.success("项目已归档到本组织");
      setPicked(undefined);
      setOrgProjects((await orgApi.projects(projectOrg.id)).items);
      await load();
    } catch {
      // 404 项目不存在
    }
  };

  const unassign = async (p: OrgProjectRow) => {
    if (!projectOrg) return;
    try {
      await orgApi.unassignProject(projectOrg.id, p.id);
      message.success("项目已移出组织");
      setOrgProjects((await orgApi.projects(projectOrg.id)).items);
      await load();
    } catch {
      // 404 项目不在该组织
    }
  };

  const projectOptions = useMemo(
    () => allProjects.map((p) => ({ value: p.id, label: p.name })),
    [allProjects],
  );

  return (
    <div data-testid="tab-orgs">
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search allowClear placeholder="按名称/代码搜索" style={{ width: 260 }}
          data-testid="org-search" onSearch={(v) => setQ(v)} />
        {isSysAdmin && (
          <Button type="primary" data-testid="org-create" onClick={openCreate}>新建组织</Button>
        )}
        {loadErr ? <Typography.Text type="danger" data-testid="org-error">{loadErr}</Typography.Text> : null}
      </Space>
      <Table<OrgItem> size="small" rowKey="id" dataSource={rows} pagination={false}
        onRow={(r) => ({ "data-testid": "org-row-" + r.id } as React.HTMLAttributes<HTMLTableRowElement>)}
        columns={[
          {
            title: "组织", dataIndex: "name", key: "name",
            render: (v: string, r: OrgItem) => (
              <div>
                <Typography.Text strong>{v}</Typography.Text>
                <div className="tp-text-sm" style={{ color: "var(--tp-color-text-secondary, #8c8c8c)" }}>
                  {r.code}
                </div>
              </div>
            ),
          },
          {
            title: "说明", dataIndex: "description", key: "desc",
            render: (v: string | null) => <span className="tp-text-sm">{v || "—"}</span>,
          },
          { title: "成员", dataIndex: "member_count", key: "mc", width: 80 },
          { title: "项目", dataIndex: "project_count", key: "pc", width: 80 },
          {
            title: "我的角色", dataIndex: "my_role", key: "my_role", width: 120,
            render: (v: string | null) => (v
              ? <Tag>{ROLE_LABEL[v] ?? v}</Tag>
              : <span className="tp-text-sm">—</span>),
          },
          {
            title: "状态", dataIndex: "status", key: "status", width: 90,
            render: (v: string) => <Tag color={v === "normal" ? "green" : "default"}>
              {v === "normal" ? "正常" : "停用"}
            </Tag>,
          },
          {
            title: "操作", key: "ops", width: 400,
            render: (_: unknown, r: OrgItem) => (
              <Space size={4} wrap>
                {hasCap(r, ORG_CAP.member) && (
                  <Button size="small" data-testid={"org-members-" + r.id}
                    onClick={() => void openMembers(r)}>成员</Button>
                )}
                <Button size="small" data-testid={"org-projects-" + r.id}
                  onClick={() => void openProjects(r)}>项目</Button>
                {hasCap(r, ORG_CAP.group) && (
                  <Button size="small" data-testid={"org-groups-" + r.id}
                    onClick={() => setGroupOrg(r)}>用户组</Button>
                )}
                {hasCap(r, ORG_CAP.defect) && (
                  <Button size="small" data-testid={"org-flow-" + r.id}
                    onClick={() => setFlowOrg(r)}>状态流</Button>
                )}
                {hasCap(r, ORG_CAP.update) && (
                  <Button size="small" data-testid={"org-edit-" + r.id}
                    onClick={() => openEdit(r)}>编辑</Button>
                )}
                {isSysAdmin && (
                  <Popconfirm title="删除组织？组织下的项目需先移出。" okText="删除" cancelText="取消"
                    onConfirm={() => void remove(r)}>
                    <Button size="small" danger data-testid={"org-delete-" + r.id}>删除</Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
        locale={{ emptyText: "还没有组织" }} />

      <Modal open={open} title={editing ? "编辑组织" : "新建组织"} okText="保存" cancelText="取消"
        confirmLoading={saving} onOk={() => void submit()} onCancel={() => setOpen(false)}
        destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "组织名称必填" }]}>
            <Input data-testid="org-name" maxLength={200} placeholder="例如：研发中心" />
          </Form.Item>
          <Form.Item name="code" label="代码" rules={[
            { required: !editing, message: "组织代码必填" },
            { pattern: /^[a-z0-9][a-z0-9_-]*$/, message: "小写字母/数字开头，可含 -_" },
          ]}>
            <Input data-testid="org-code" maxLength={64} disabled={Boolean(editing)}
              placeholder="例如：rd-center" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea data-testid="org-desc" maxLength={2000} rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title={memberOrg ? `组织成员 · ${memberOrg.name}` : "组织成员"} width={620}
        open={Boolean(memberOrg)} onClose={() => setMemberOrg(null)} destroyOnHidden>
        <div data-testid="org-member-drawer">
          <Space style={{ marginBottom: 12 }} wrap>
            <Input placeholder="账号" style={{ width: 180 }} value={account}
              data-testid="org-member-account" onChange={(e) => setAccount(e.target.value)} />
            <Select style={{ width: 150 }} value={role} data-testid="org-member-role"
              onChange={(v) => setRole(v)} options={[
                { value: "ORG_MEMBER", label: "组织成员" },
                { value: "ORG_ADMIN", label: "组织管理员" },
              ]} />
            <Button type="primary" data-testid="org-member-add"
              onClick={() => void addMember()}>添加/调整</Button>
          </Space>
          <Table<OrgMemberRow> size="small" rowKey="id" dataSource={members} pagination={false}
            columns={[
              { title: "账号", dataIndex: "account", key: "account" },
              { title: "姓名", dataIndex: "name", key: "name" },
              {
                title: "角色", dataIndex: "role_code", key: "role", width: 140,
                render: (v: string) => <Tag>{ROLE_LABEL[v] ?? v}</Tag>,
              },
              {
                title: "操作", key: "ops", width: 100,
                render: (_: unknown, m: OrgMemberRow) => (
                  <Popconfirm title="移出这个成员？" okText="移出" cancelText="取消"
                    onConfirm={() => void removeMember(m)}>
                    <Button size="small" danger data-testid={"org-member-remove-" + m.user_id}>移出</Button>
                  </Popconfirm>
                ),
              },
            ]}
            locale={{ emptyText: "还没有成员" }} />
        </div>
      </Drawer>

      <Drawer title={projectOrg ? `组织项目 · ${projectOrg.name}` : "组织项目"} width={620}
        open={Boolean(projectOrg)} onClose={() => setProjectOrg(null)} destroyOnHidden>
        <div data-testid="org-project-drawer">
          {projectOrg && hasCap(projectOrg, ORG_CAP.project) && (
            <Space style={{ marginBottom: 12 }} wrap>
              <Select showSearch style={{ width: 260 }} placeholder="选择要归档的项目"
                data-testid="org-project-select" value={picked} onChange={(v) => setPicked(v)}
                options={projectOptions} optionFilterProp="label" />
              <Button type="primary" data-testid="org-project-assign"
                onClick={() => void assign()}>归档到本组织</Button>
            </Space>
          )}
          <Table<OrgProjectRow> size="small" rowKey="id" dataSource={orgProjects} pagination={false}
            columns={[
              { title: "项目", dataIndex: "name", key: "name" },
              {
                title: "说明", dataIndex: "description", key: "desc",
                render: (v: string | null) => <span className="tp-text-sm">{v || "—"}</span>,
              },
              {
                title: "操作", key: "ops", width: 100,
                render: (_: unknown, p: OrgProjectRow) => (
                  projectOrg && hasCap(projectOrg, ORG_CAP.project) ? (
                    <Popconfirm title="把项目移出组织？" okText="移出" cancelText="取消"
                      onConfirm={() => void unassign(p)}>
                      <Button size="small" danger data-testid={"org-project-remove-" + p.id}>移出</Button>
                    </Popconfirm>
                  ) : <span className="tp-text-sm">—</span>
                ),
              },
            ]}
            locale={{ emptyText: "本组织还没有项目" }} />
        </div>
      </Drawer>

      <OrgGroupDrawer org={groupOrg} onClose={() => setGroupOrg(null)}
        onChanged={() => void load()} />

      <Drawer title={flowOrg ? `缺陷状态流模板 · ${flowOrg.name}` : "缺陷状态流模板"} width={900}
        open={Boolean(flowOrg)} onClose={() => setFlowOrg(null)} destroyOnHidden>
        {flowOrg && <DefectFlowTab orgId={flowOrg.id} />}
      </Drawer>
    </div>
  );
}
