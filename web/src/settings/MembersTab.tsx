// 项目成员（§11.4.27 Tab1）。
// 弹窗里的候选查找按账号/姓名而不是让人粘 UUID：UUID 的唯一来源 /system/users 是平台权限，
// 项目管理员拿不到——所以后端开了 GET /project-member-candidates 这条项目范围内的查找。
// 「加入项目」本身不是搜索而是授权：PUT 落库角色下拉当前值（默认 MEMBER），对已存在行整体覆盖。
import { useCallback, useEffect, useState } from "react";
import AdminTable from "../ui/AdminTable";
import { Alert, Button, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { PlusOutlined, ReloadOutlined, SearchOutlined } from "../ui/icons";
import type { ColumnsType } from "antd/es/table";
import { del, get, put, ApiErr } from "../api/client";
import type { CandidateRow, MemberRow, Page, RoleRow } from "../api/api";
import { FilterBar, Toolbar } from "../ui/Toolbar";

export default function MembersTab({ projectId, canManage, selfId, onChanged }: {
  projectId: string; canManage: boolean; selfId: string;
  /** 成员或角色变了就通知外层重取项目 my_perms（改的是自己时按钮必须立刻跟着变） */
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<MemberRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [cands, setCands] = useState<CandidateRow[]>([]);
  const [searching, setSearching] = useState(false);
  // 候选查失败与「查了但没匹配」在两行字上分开：catch 里 setCands([]) 之后，
  // notFoundContent 那句「没有匹配的用户」是对一个根本没成功的查询下的结论。
  const [searchFailed, setSearchFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [role, setRole] = useState<string>("MEMBER");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailed(false);
    setDenied(false);
    try {
      const m = await get<{ items: MemberRow[] }>("/projects/" + projectId + "/members", { silent: true });
      setRows(m.items);
      const r = await get<{ items: RoleRow[] }>("/roles", { silent: true });
      // D37：自定义角色并进下拉数据源（内置在前）；读失败不拦成员页——
      // 内置角色照常可挂，只是这次刷新里看不到自定义项。
      let custom: RoleRow[] = [];
      try {
        const c = await get<{ items: { code: string; name: string; perms: string[] }[] }>(
          "/custom-roles?project_id=" + encodeURIComponent(projectId) + "&size=200", { silent: true });
        custom = c.items.map((x) => ({ code: x.code, name: x.name + "（自定义）", perms: x.perms }));
      } catch { /* 无 iam:role:read 或网络失败：内置照常用 */ }
      setRoles([...r.items, ...custom.filter((x) => !r.items.some((y) => y.code === x.code))]);
    } catch (e) {
      // 403（routes.py:123 → ensure_member → forbidden）是稳定结论：你已不是成员，刷新不会变；
      // 其余失败才是传输问题。分句口径同 schedules.tsx:362/535，只有 ApiErr.status=403 配喊权限。
      setFailed(true);
      setDenied(e instanceof ApiErr && e.status === 403);
    }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function search(q: string): Promise<void> {
    setSearching(true);
    setSearchFailed(false);
    try {
      const r = await get<Page<CandidateRow>>("/project-member-candidates?project_id="
        + encodeURIComponent(projectId) + "&q=" + encodeURIComponent(q) + "&size=20", { silent: true });
      setCands(r.items);
    } catch { setCands([]); setSearchFailed(true); }
    finally { setSearching(false); }
  }

  async function add(): Promise<void> {
    if (!picked) { message.warning("先选一个用户"); return; }
    setSaving(true);
    // 同一个 PUT 在后端是两条分支：无行则建（project_services.py:274-276），
    // 有行则整体覆盖 role_code（:277-280）。候选行的 is_member 标的就是这个，
    // 所以「已添加」只在真的建行时成立——对已在项目的人喊「已添加成员」是把覆盖说成新增。
    const already = cands.find((c) => c.id === picked)?.is_member ?? false;
    try {
      await put("/projects/" + projectId + "/members/" + picked, { role_code: role });
      message.success(already ? "该成员的角色已覆盖为「" + roleName(role) + "」" : "已添加成员");
      setOpen(false); setPicked(null);
      await load();
      onChanged?.();
    } catch { /* client 已 toast */ }
    finally { setSaving(false); }
  }

  const roleName = (code: string) => roles.find((r) => r.code === code)?.name ?? code;

  async function changeRole(userId: string, code: string): Promise<void> {
    try {
      await put("/projects/" + projectId + "/members/" + userId, { role_code: code });
      message.success("角色已更新");
      await load();
      onChanged?.();
    } catch { await load(); }
  }

  const cols: ColumnsType<MemberRow> = [
    { title: "账号", dataIndex: "account", render: (v: string | null, r: MemberRow) => (
      <Space size={6}>
        <Typography.Text data-testid="member-account">{v ?? r.user_id.slice(0, 8)}</Typography.Text>
        {r.user_id === selfId && <Tag color="blue">我</Tag>}
      </Space>) },
    { title: "姓名", dataIndex: "name", render: (v: string | null) => v ?? "—" },
    { title: "角色", dataIndex: "role_code", width: 210, render: (v: string, r: MemberRow) => (
      canManage ? (
        <Select size="small" style={{ width: 180 }} value={v} data-testid="member-role"
          onChange={(c) => void changeRole(r.user_id, c)}
          options={roles.map((x) => ({ value: x.code, label: x.name }))} />
      ) : (
        <Tag data-testid="member-role-static">{roleName(v)}</Tag>
      )) },
    { title: "", key: "ops", width: 80, render: (_: unknown, r: MemberRow) => (
      canManage && (
        <Popconfirm title="把该成员移出项目？" okText="移出" cancelText="取消"
          onConfirm={() => void remove(r.user_id)}
          okButtonProps={{ danger: true, "data-testid": "member-remove-ok" } as never}>
          <Button size="small" type="text" danger data-testid="member-remove">移出</Button>
        </Popconfirm>
      )) },
  ];

  async function remove(userId: string): Promise<void> {
    try {
      await del("/projects/" + projectId + "/members/" + userId);
      message.success("已移出");
      await load();
      onChanged?.();
    } catch { await load(); }
  }

  return (
    <div data-testid="tab-members">
      <FilterBar actions={(
        <Toolbar>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>刷新</Button>
          {canManage && (
            // 打开时把角色退回 MEMBER：弹窗文案承诺「默认 MEMBER」（:145），而 role 是
            // 组件级 state、只初始化一次——上一个人在这里被设成 READONLY 后，第二次打开
            // 仍停在 READONLY，文案却在说默认 MEMBER。destroyOnClose 清不掉父组件的 state。
            <Button type="primary" icon={<PlusOutlined />} data-testid="member-add"
              onClick={() => { setOpen(true); setPicked(null); setRole("MEMBER"); void search(""); }}>添加成员</Button>
          )}
        </Toolbar>
      )}>
        <Typography.Text type="secondary" className="tp-text-sm">
          {failed ? "成员列表没取到（见下方提示）" : loading ? "加载中…" : `本项目成员 ${rows.length} 人`}
        </Typography.Text>
      </FilterBar>
      {failed && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="成员列表没取到"
          description={denied ? "你已不是本项目成员或没有读取权限，刷新不会改变结论"
            : "可能是网络不通，点「刷新」重试"} />
      )}
      <div className="tp-card tp-tablecard" style={{ padding: "0 4px" }}>
        <AdminTable<MemberRow> rowKey="id" loading={loading} columns={cols} dataSource={rows}
          locale={{ emptyText: failed
            // catch 里 rows 不清（与 UsersTab 不同），但首拉就失败时 rows 本就是空——
            // 这一格和「项目里真没人」长得一模一样，得说清是哪一种。
            ? "成员列表没取到，以上方的加载失败提示为准"
            : "还没有成员" }} />
      </div>
      <Modal open={open} title="添加成员" data-testid="member-modal" okText="加入项目" cancelText="取消"
        okButtonProps={{ loading: saving, "data-testid": "member-add-ok" } as never}
        onOk={() => void add()} onCancel={() => setOpen(false)} destroyOnClose>
        <Typography.Paragraph type="secondary" className="tp-text-sm">
          按账号或姓名搜索平台用户。点「加入项目」即把该人设为下方「角色」下拉当前选中的角色（每次打开都是 MEMBER）；已在项目的人点确定会覆盖其原角色（后端只在「降级唯一的项目管理员」时拦下，平台管理员不受这条限制）。
        </Typography.Paragraph>
        <Select showSearch filterOption={false}
          notFoundContent={searching ? "搜索中…" : searchFailed ? "候选用户没取到，重新输入可重试" : "没有匹配的用户"}
          style={{ width: "100%" }} placeholder="输入账号或姓名" data-testid="member-candidate"
          suffixIcon={<SearchOutlined />} onSearch={(q) => void search(q)} value={picked}
          onChange={(v) => setPicked(v)} loading={searching}
          options={cands.map((c) => ({ value: c.id, label: c.account + " · " + c.name
            + (c.is_member ? "（已在项目）" : "") }))} />
        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary">角色</Typography.Text>
          <Select style={{ width: "100%", marginTop: 4 }} value={role} data-testid="member-new-role"
            onChange={setRole} options={roles.map((x) => ({ value: x.code,
              label: <Tooltip title={(x.perms ?? []).join(" ")}>{x.name}</Tooltip> }))} />
        </div>
      </Modal>
    </div>
  );
}
