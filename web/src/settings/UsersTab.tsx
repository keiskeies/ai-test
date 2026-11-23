// 平台用户（§11.4.27 Tab2，仅系统管理员可见）。
// 重置密码是「管理员设新密码」而不是「看回旧密码」：后端只存哈希，所以这里必须写清楚
// 明文不会留在平台上，靠线下转交——不写这句话，管理员会以为系统里有地方能查。
// D171：编辑弹窗带 name/email/password 三项（user_update 本就收 UserUpdateIn 三字段）；
// created_at 出参后端已吐，列渲染走 shared/timefmt 的 UTC→展示时区口径。
import { useCallback, useEffect, useState } from "react";
import AdminTable from "../ui/AdminTable";
import { Alert, Button, Form, Input, Modal, Popconfirm, Space, Switch, Tag, Typography, message } from "antd";
import { PlusOutlined, ReloadOutlined, UploadOutlined } from "../ui/icons";
import type { ColumnsType } from "antd/es/table";
import { get, patch, post } from "../api/client";
import type { Page, UserRow } from "../api/api";
import { fmtTime } from "../shared/timefmt";
import UserImportWizard from "./UserImportWizard";
import { FilterBar, Toolbar } from "../ui/Toolbar";
import StateView from "../ui/StateView";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import {
  applyColumnPrefs, emptyFilter, isFilterEmpty,
  type ColumnChoice, type FilterDoc,
} from "../shared/listFilters";

const PAGE = 50;

// D244：列设置面板要露的列（key 与下方 cols 的 key 逐字一致；ops 是操作钮，不可隐藏）。
const USER_COL_CHOICES: ColumnChoice[] = [
  { key: "account", label: "账号" },
  { key: "name", label: "姓名" },
  { key: "email", label: "邮箱" },
  { key: "created", label: "创建时间" },
  { key: "admin", label: "类型" },
  { key: "status", label: "状态" },
];

// 高级搜索候选：状态与类型直接用页面渲染词表（启用/停用、平台管理员/普通用户）。
// 布尔列候选的 value 必须是真布尔（后端 kind=bool 只收 JSON true/false）。
const USER_VALUE_OPTIONS: Record<string, Option[]> = {
  status: [{ value: "active", label: "启用" }, { value: "disabled", label: "停用" }],
  is_system_admin: [{ value: true, label: "平台管理员" }, { value: false, label: "普通用户" }],
};

// D171：UserOut 已带 created_at，但 api.ts 的 UserRow 与 schema.d.ts（生成物，D149）
// 都还没跟上——本地扩展，不动生成物。
type UserRowOut = UserRow & { created_at?: string | null };

export default function UsersTab({ projectId, canCreate, canUpdate, canDisable, selfId }: {
  projectId: string; canCreate: boolean; canUpdate: boolean; canDisable: boolean; selfId: string;
}) {
  const [items, setItems] = useState<UserRowOut[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pwFor, setPwFor] = useState<UserRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [pwForm] = Form.useForm();
  // D244：高级搜索条件组 + 列设置偏好（视图按当前项目存；用户表本身是平台级）。
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const [colPref, setColPref] = useColumnPrefs("user", USER_COL_CHOICES.map((c) => c.key));

  const load = useCallback(async (reset: boolean): Promise<void> => {
    setLoading(true);
    setFailed(false);
    try {
      const next = reset ? null : cursor;
      const q = new URLSearchParams({ size: String(PAGE) });
      // D244：空条件不拼参数（URL 里不出现骗人的 filter=），非空才交给后端编 WHERE。
      if (!isFilterEmpty(advFilter)) q.set("filter", JSON.stringify(advFilter));
      if (next) q.set("cursor", next);
      const r = await get<Page<UserRowOut>>("/system/users?" + q.toString(), { silent: true });
      setItems((prev) => (next === null ? r.items : [...prev, ...r.items]));
      setCursor(r.next_cursor);
    } catch { setFailed(true); if (reset) { setItems([]); setCursor(null); } }
    finally { setLoading(false); }
  }, [cursor, advFilter]);

  // D244：条件变化必须重查（reset 语义），否则面板里改了条件、表还是旧行。
  // load 自己不进依赖——写 items/cursor 的是它，把 load 放进 effect 依赖就是无限回路
  // （cursor 变 → load 换身份 → effect 重跑 → 再取一页）。同 AuditTab.tsx:66 的口径。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(true); }, [advFilter]);
  const refresh = () => void load(true);

  async function create(): Promise<void> {
    // validateFields 失败必须就地吞掉：字段旁已经有红字，再 toast 是噪音；而 onOk 是
    // `void create()`，让它 reject 出去就是一条 unhandled rejection（控制台噪音，且 vitest
    // 会当成未处理异常）。ChangePasswordModal.tsx:24-29 同款，这里此前漏了。
    let v: Record<string, unknown>;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      await post("/system/users", v);
      message.success("用户已创建，请把密码转告本人");
      setOpen(false); form.resetFields();
      await load(true);
    } catch { /* client 已 toast */ }
    finally { setSaving(false); }
  }

  async function resetPassword(): Promise<void> {
    if (!pwFor) return;
    let v: { name: string; email?: string; password?: string };
    try {
      v = await pwForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      // D171：后端 user_update 收 name/email/password 三项（user_services.py:66-78），
      // 弹窗此前只 PATCH password，改姓名/邮箱没有入口。密码留空 = 不带键：
      // 后端 `if payload.password is not None` 不触哈希，编辑资料不该强制重置密码。
      await patch("/system/users/" + pwFor.id, {
        name: v.name,
        email: v.email ? v.email : null,  // 清空邮箱落 null，不落空串（UserOut.email 可空）
        ...(v.password ? { password: v.password } : {}),
      });
      message.success(v.password ? "密码已重置，请转告本人尽快修改" : "用户资料已更新");
      setPwFor(null); pwForm.resetFields();
    } catch { /* client 已 toast */ }
    finally { setSaving(false); }
  }

  async function setStatus(u: UserRow, status: string): Promise<void> {
    try {
      await post("/system/users/" + u.id + "/status", { user_id: u.id, status });
      message.success(status === "active" ? "已启用" : "已停用");
      await load(true);
    } catch { await load(true); }
  }

  // D244：key 与 USER_COL_CHOICES 逐字一致——applyColumnPrefs 只按 key 过滤，
  // 只写 dataIndex 的列永远藏不掉（列设置会变成「勾了没反应」的假开关）。
  const cols: ColumnsType<UserRowOut> = [
    { title: "账号", key: "account", dataIndex: "account", render: (v: string) => (
      <Typography.Text data-testid="user-account">{v}</Typography.Text>) },
    { title: "姓名", key: "name", dataIndex: "name" },
    { title: "邮箱", key: "email", dataIndex: "email", render: (v: string | null) => v ?? "—" },
    { title: "创建时间", key: "created", dataIndex: "created_at", width: 150, render: (v: string | null | undefined) => (
      <span data-testid="user-created">{fmtTime(v) ?? "—"}</span>) },
    { title: "类型", key: "admin", dataIndex: "is_system_admin", width: 110, render: (v: boolean) => (
      v ? <Tag color="gold" data-testid="user-admin">平台管理员</Tag> : <Tag>普通用户</Tag>) },
    { title: "状态", key: "status", dataIndex: "status", width: 88, render: (v: string) => (
      <Tag data-testid="user-status" color={v === "active" ? "green" : "red"}
        >{v === "active" ? "启用" : "停用"}</Tag>) },
    { title: "", key: "ops", width: 150, render: (_: unknown, r: UserRow) => (
      (canUpdate || canDisable) && (
        <Space size={2}>
          {canUpdate && (
            <Button size="small" type="link" data-testid="user-pw"
              onClick={() => { setPwFor(r); pwForm.resetFields(); }}>编辑</Button>
          )}
          {canDisable && r.id !== selfId && (
            // 三行按三种后端结局分句（user_services.py:89-98）：自己的账号这里直接不给钮，
            // 因为后端 `user_id == ctx.user_id` 必 400「不能禁用自己的账号」——
            // 给一个注定被拒的确认框，等于让用户对着自己的名字读一句「无法登录」。
            // 平台管理员那一行多一句预告：后端在「这是最后一个可用的系统管理员」时也会 400，
            // 而列表这一行看不出是不是最后一个，所以只能说「会被拦下」而不是「一定拦得下」。
            <Popconfirm title={r.status === "active"
              ? "停用后该账号无法登录"
                + (r.is_system_admin ? "；若这是最后一个可用的平台管理员，后端会拦下这一步" : "")
              : "恢复该账号登录"}
              okText="确定" cancelText="取消" okButtonProps={{ danger: r.status === "active" } as never}
              onConfirm={() => void setStatus(r, r.status === "active" ? "disabled" : "active")}>
              <Button size="small" type="link" danger={r.status === "active"} data-testid="user-toggle">
                {r.status === "active" ? "停用" : "启用"}
              </Button>
            </Popconfirm>
          )}
        </Space>
      )) },
  ];

  return (
    <div data-testid="tab-users" className="tp-fill-tab">
      {/* D244：高级搜索三件套。条件是 WHERE（后端 USER_LIST_FILTER），平台用户表本身
          没有项目维度，视图按当前项目存。本 Tab 只对能读平台用户的角色渲染，
          保存/删除视图按后端 search:view:* 权限位放行（系统管理员为 *）。 */}
      <ListToolbar projectId={projectId} viewType="user"
        filter={advFilter} onFilterChange={setAdvFilter}
        allColumns={USER_COL_CHOICES} columnPref={colPref} onColumnPrefChange={setColPref}
        valueOptions={USER_VALUE_OPTIONS} canSaveView canDeleteView />
      <FilterBar actions={(
        <Toolbar>
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>刷新</Button>
          {/* D40 §11.4.22：批量导入与新建同位（system:user:create，门禁在后端 import-preview/commit） */}
          {canCreate && (
            <Button icon={<UploadOutlined />} data-testid="user-batch-import"
              onClick={() => setImportOpen(true)}>批量导入</Button>
          )}
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} data-testid="user-create"
              onClick={() => { setOpen(true); form.resetFields(); }}>新建用户</Button>
          )}
        </Toolbar>
      )}>
        <Typography.Text type="secondary" className="tp-text-sm">
          {failed ? "用户列表没取到（见下方提示）" : loading ? "加载中…" : `平台用户 ${items.length} 人`}
        </Typography.Text>
      </FilterBar>
      {failed && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message="用户列表没取到" description="可能是网络不通，点「刷新」重试" />
      )}
      {/* 外壳只有 AdminTable 自己那一层 tp-tablecard（与 MembersTab/AuditTab 同口径，
          此前多包一层 tp-card 是双白卡双描边 + 4px 手抄 padding）。 */}
      <AdminTable<UserRowOut> rowKey="id" loading={loading}
        columns={applyColumnPrefs(cols, colPref)} dataSource={items}
        locale={{ emptyText: failed
          // 第 9 处「取失败摊成空列表」（datasets/reports/runs/scenes/api/adbCases/CaseList…）：
          // catch 里 setItems([])，500 与「平台真没用户」在这一格长得一模一样。
          ? <StateView compact kind="error" title="用户列表没取到，以上方的加载失败提示为准"
              action={<Button size="small" onClick={refresh} loading={loading}>重试</Button>} />
          : <StateView compact title="还没有用户" /> }}
        cardFooter={(cursor ? (
          // 「加载更多」住进卡底（同列表页脚注口径：卡有边有角，控件不该散在卡外的页面底色上）。
          <div className="tp-cardfoot--center">
            <Button data-testid="users-more" onClick={() => void load(false)} loading={loading}>加载更多</Button>
          </div>) : undefined)} />
      <Modal centered open={open} title="新建用户" data-testid="user-modal" okText="创建" cancelText="取消"
        okButtonProps={{ loading: saving, "data-testid": "user-create-ok" } as never}
        onOk={() => void create()} onCancel={() => setOpen(false)} destroyOnHidden>
        <Form form={form} layout="vertical" data-testid="user-form">
          <Form.Item name="account" label="账号" rules={[{ required: true, min: 2, max: 64 },
            { pattern: /^[a-zA-Z0-9_.-]+$/, message: "只能有字母数字 _ . -" }]}>
            <Input data-testid="user-field-account" placeholder="zhangsan" />
          </Form.Item>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请输入姓名" }]}>
            <Input data-testid="user-field-name" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: "email", message: "邮箱格式不对" }]}>
            <Input data-testid="user-field-email" />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 8, message: "至少 8 位" }]}>
            <Input.Password data-testid="user-field-password" />
          </Form.Item>
          <Form.Item name="is_system_admin" label="平台管理员" valuePropName="checked">
            <Switch data-testid="user-field-admin" />
          </Form.Item>
        </Form>
        <Typography.Paragraph type="secondary" className="tp-text-sm" style={{ marginBottom: 0 }}>
          新密码将告知用户，平台不保存明文（只存哈希；忘记密码同样只能重置）。
        </Typography.Paragraph>
      </Modal>
      <Modal centered open={pwFor !== null} title={"编辑用户 · " + (pwFor?.name ?? "")} data-testid="pw-modal"
        okText="保存" cancelText="取消"
        okButtonProps={{ loading: saving, "data-testid": "pw-ok" } as never}
        onOk={() => void resetPassword()} onCancel={() => setPwFor(null)} destroyOnHidden>
        {/* destroyOnHidden 每次开窗都重挂 Form，initialValues 就是「打开时预填本人当前值」；
            清空邮箱送 null——UserUpdateIn.email 的 None 在后端是「不改」，
            把它表达成「改成空」需要后端先给 UserUpdateIn 一条清除语义（D171 记账）。 */}
        <Form form={pwForm} layout="vertical"
          initialValues={pwFor ? { name: pwFor.name, email: pwFor.email ?? "" } : undefined}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请输入姓名" }]}>
            <Input data-testid="pw-field-name" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: "email", message: "邮箱格式不对" }]}>
            <Input data-testid="pw-field-email" />
          </Form.Item>
          <Form.Item name="password" label="新密码（留空 = 不改密码）" rules={[{ min: 8, message: "至少 8 位" }]}>
            <Input.Password data-testid="pw-field" />
          </Form.Item>
        </Form>
        <Alert type="info" showIcon message="新密码将告知用户，平台不保存明文"
          description="重置密码请留线下渠道转给本人，并提醒尽快自助修改；只改资料则密码留空。" />
      </Modal>
      <UserImportWizard open={importOpen} onClose={() => setImportOpen(false)} onImported={refresh} />
    </div>
  );
}
