// 组织级用户组抽屉（D270）：一组 = 一份组织管理权限集（改资料/管成员/管项目归属/管组）。
// 组不参与项目数据权限——界面文案里明确这一点，避免被当成「项目角色」。
// 授权：进入本抽屉要求界面已判定 group:manage；服务端每个请求还会再复核一次。
import { useCallback, useEffect, useState } from "react";
import { Button, Checkbox, Drawer, Form, Input, Modal, Popconfirm, Space, Table, Tag, message } from "antd";
import {
  ORG_CAP_OPTIONS, orgApi, type OrgGroupMemberRow, type OrgGroupRow, type OrgItem,
} from "../api/org";

const CAP_LABEL: Record<string, string> = Object.fromEntries(
  ORG_CAP_OPTIONS.map((o) => [o.value, o.label]),
);

interface GroupForm {
  name: string;
  description?: string;
}

export default function OrgGroupDrawer({ org, onClose, onChanged }: {
  org: OrgItem | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<OrgGroupRow[]>([]);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<OrgGroupRow | null>(null);
  const [perms, setPerms] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<GroupForm>();

  const [memberGroup, setMemberGroup] = useState<OrgGroupRow | null>(null);
  const [members, setMembers] = useState<OrgGroupMemberRow[]>([]);
  const [account, setAccount] = useState("");

  const load = useCallback(async () => {
    if (!org) return;
    try {
      setRows((await orgApi.groups(org.id)).items);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [org]);

  useEffect(() => {
    setRows([]);
    setErr("");
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setPerms([]);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (g: OrgGroupRow) => {
    setEditing(g);
    setPerms(g.perms);
    form.setFieldsValue({ name: g.name, description: g.description ?? "" });
    setOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields();
    if (!org) return;
    setSaving(true);
    try {
      if (editing) {
        await orgApi.updateGroup(editing.id, {
          name: v.name, description: v.description || null, perms,
        });
        message.success("用户组已更新");
      } else {
        await orgApi.createGroup(org.id, v.name, perms, v.description || null);
        message.success("用户组已创建");
      }
      setOpen(false);
      await load();
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (g: OrgGroupRow) => {
    try {
      await orgApi.removeGroup(g.id);
      message.success("用户组已删除");
      await load();
      onChanged();
    } catch {
      // 403/404 由 client 统一提示
    }
  };

  const openMembers = async (g: OrgGroupRow) => {
    setMemberGroup(g);
    setMembers([]);
    setAccount("");
    try {
      setMembers((await orgApi.groupMembers(g.id)).items);
    } catch {
      // 403 由 client 提示
    }
  };

  const addMember = async () => {
    if (!memberGroup) return;
    const acc = account.trim();
    if (!acc) {
      message.warning("先填账号");
      return;
    }
    try {
      await orgApi.addGroupMember(memberGroup.id, acc);
      message.success("组员已添加");
      setAccount("");
      setMembers((await orgApi.groupMembers(memberGroup.id)).items);
      await load();
    } catch {
      // 404 账号不存在 / 409 非组织成员：client 统一提示
    }
  };

  const removeMember = async (m: OrgGroupMemberRow) => {
    if (!memberGroup) return;
    try {
      await orgApi.removeGroupMember(memberGroup.id, m.user_id);
      message.success("已移出用户组");
      setMembers((await orgApi.groupMembers(memberGroup.id)).items);
      await load();
    } catch {
      // 404
    }
  };

  return (
    <Drawer title={org ? `用户组 · ${org.name}` : "用户组"} width={760}
      open={Boolean(org)} onClose={onClose} destroyOnHidden>
      <div data-testid="org-group-drawer">
        <Space style={{ marginBottom: 8 }} wrap>
          <Button type="primary" data-testid="org-group-create" onClick={openCreate}>新建用户组</Button>
          <span className="tp-text-sm" style={{ color: "var(--tp-color-text-secondary, #8c8c8c)" }}>
            用户组只授予组织层管理动作，不改变项目数据权限。
          </span>
        </Space>
        {err ? <div style={{ marginBottom: 8 }}><Tag color="red" data-testid="org-group-error">{err}</Tag></div> : null}
        <Table<OrgGroupRow> size="small" rowKey="id" dataSource={rows} pagination={false}
          columns={[
            { title: "名称", dataIndex: "name", key: "name" },
            {
              title: "管理位", dataIndex: "perms", key: "perms",
              render: (v: string[]) => (v.length
                ? <Space size={4} wrap>{v.map((p) => <Tag key={p}>{CAP_LABEL[p] ?? p}</Tag>)}</Space>
                : <span className="tp-text-sm">只读</span>),
            },
            { title: "组员", dataIndex: "member_count", key: "mc", width: 70 },
            {
              title: "操作", key: "ops", width: 220,
              render: (_: unknown, g: OrgGroupRow) => (
                <Space size={4} wrap>
                  <Button size="small" data-testid={"org-group-members-" + g.id}
                    onClick={() => void openMembers(g)}>组员</Button>
                  <Button size="small" data-testid={"org-group-edit-" + g.id}
                    onClick={() => openEdit(g)}>编辑</Button>
                  <Popconfirm title="删除这个用户组？组员关系一并清掉。" okText="删除" cancelText="取消"
                    onConfirm={() => void remove(g)}>
                    <Button size="small" danger data-testid={"org-group-delete-" + g.id}>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          locale={{ emptyText: "还没有用户组" }} />
      </div>

      <Modal open={open} title={editing ? "编辑用户组" : "新建用户组"} okText="保存" cancelText="取消"
        confirmLoading={saving} onOk={() => void submit()} onCancel={() => setOpen(false)}
        destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "用户组名称必填" }]}>
            <Input data-testid="org-group-name" maxLength={128} placeholder="例如：用例评审组" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea data-testid="org-group-desc" maxLength={2000} rows={2} />
          </Form.Item>
          <Form.Item label="管理位">
            <Checkbox.Group data-testid="org-group-perms" value={perms}
              onChange={(v) => setPerms(v as string[])}
              options={ORG_CAP_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title={memberGroup ? `组员 · ${memberGroup.name}` : "组员"} width={480}
        open={Boolean(memberGroup)} onClose={() => setMemberGroup(null)} destroyOnHidden>
        <div data-testid="org-group-member-drawer">
          <Space style={{ marginBottom: 12 }} wrap>
            <Input placeholder="组织成员账号" style={{ width: 200 }} value={account}
              data-testid="org-group-member-account" onChange={(e) => setAccount(e.target.value)} />
            <Button type="primary" data-testid="org-group-member-add"
              onClick={() => void addMember()}>加入用户组</Button>
          </Space>
          <Table<OrgGroupMemberRow> size="small" rowKey="id" dataSource={members} pagination={false}
            columns={[
              { title: "账号", dataIndex: "account", key: "account" },
              { title: "姓名", dataIndex: "name", key: "name" },
              {
                title: "操作", key: "ops", width: 100,
                render: (_: unknown, m: OrgGroupMemberRow) => (
                  <Popconfirm title="移出这个组员？" okText="移出" cancelText="取消"
                    onConfirm={() => void removeMember(m)}>
                    <Button size="small" danger data-testid={"org-group-member-remove-" + m.user_id}>
                      移出
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
            locale={{ emptyText: "还没有组员" }} />
        </div>
      </Drawer>
    </Drawer>
  );
}
