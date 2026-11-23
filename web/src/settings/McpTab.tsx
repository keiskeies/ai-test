// MCP 服务（§11.4.24 / §11.5.8）：列表 + 编辑抽屉形的弹窗 + 连接测试 + 工具预览。
// 治理（§9.8）：只有系统管理员能进本 Tab；env/headers 只回键名，值永远不回显。
// 状态点的三种取值各有含义：在线（最近探测/常驻会话）/ 离线（最近探测失败）/ 停用。
import { useCallback, useEffect, useState } from "react";
import {
  Alert, Badge, Button, Descriptions, Divider, Empty, Input, Modal, Popconfirm, Select,
  Space, Switch, Table, Tag, Tooltip, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import { ApiErr, del, get, patch, post } from "../api/client";
import { fmtTime } from "../shared/timefmt";

export type Transport = "stdio" | "sse" | "http";

export interface McpServer {
  id: string;
  name: string;
  transport: Transport;
  command: string;
  args: string[];
  url: string;
  env_keys: string[];
  has_headers: boolean;
  enabled: boolean;
  status: "online" | "offline" | "disabled";
  tool_count: number;
  tool_effects: Record<string, string>;
  last_error: string | null;
  last_checked_at: string | null;
  last_latency_ms: number | null;
}

export interface McpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** 逐行参数：去空行；stdio 的 args 一行一个（npx -y ... 拆成三行）。 */
export function parseLines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** KEY=VALUE 逐行：忽略空行与 # 注释；没有 = 的行忽略（不静默变成空值键）。 */
export function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i <= 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

/** tool_effects 文本：`工具名=read` 一行一条；写侧只接受 read，其余按 write（后端保守默认）。 */
export function parseEffects(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parseKv(text))) {
    if (v === "read" || v === "write") out[k] = v;
  }
  return out;
}

export function statusMeta(status: McpServer["status"]): { badge: "success" | "error" | "default"; label: string } {
  if (status === "online") return { badge: "success", label: "在线" };
  if (status === "disabled") return { badge: "default", label: "停用" };
  return { badge: "error", label: "离线" };
}

interface FormState {
  name: string;
  transport: Transport;
  command: string;
  argsText: string;
  url: string;
  envText: string;
  headersText: string;
  effectsText: string;
  enabled: boolean;
  clearSecrets: boolean;
}

function blankForm(): FormState {
  return {
    name: "", transport: "stdio", command: "", argsText: "", url: "",
    envText: "", headersText: "", effectsText: "", enabled: true, clearSecrets: false,
  };
}

function toForm(s: McpServer): FormState {
  return {
    name: s.name, transport: s.transport, command: s.command, argsText: s.args.join("\n"),
    url: s.url, envText: "", headersText: "",
    effectsText: Object.entries(s.tool_effects).map(([k, v]) => k + "=" + v).join("\n"),
    enabled: s.enabled, clearSecrets: false,
  };
}

function ToolList({ items }: { items: McpTool[] }) {
  if (!items.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有发现工具，先点「测试连接」" />;
  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      {items.map((t) => (
        <div key={t.name} className="tp-card" style={{ padding: "var(--tp-gap-sm) var(--tp-gap-md)" }}>
          <Space size={8} wrap>
            <Typography.Text strong>{t.name}</Typography.Text>
            <Typography.Text type="secondary" className="tp-text-sm">{t.description || "（无描述）"}</Typography.Text>
          </Space>
          <pre data-testid={"mcp-schema-" + t.name}
            style={{ margin: "6px 0 0", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {JSON.stringify(t.input_schema, null, 2)}
          </pre>
        </div>
      ))}
    </Space>
  );
}

export default function McpTab({ canManage }: { canManage: boolean }) {
  const [items, setItems] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ server: McpServer; items: McpTool[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const out = await get<{ items: McpServer[] }>("/mcp-servers?size=200");
      setItems(out.items);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openCreate(): void {
    setEditing(null);
    setForm(blankForm());
    setFormErr(null);
  }

  function openEdit(s: McpServer): void {
    setEditing(s);
    setForm(toForm(s));
    setFormErr(null);
  }

  async function submit(): Promise<void> {
    if (!form) return;
    const name = form.name.trim();
    if (!name) { setFormErr("名称必填"); return; }
    if (form.transport === "stdio" && !form.command.trim()) { setFormErr("stdio 型必须填写启动命令"); return; }
    if (form.transport !== "stdio" && !form.url.trim()) { setFormErr("sse/http 型必须填写 URL"); return; }
    const body: Record<string, unknown> = {
      name, transport: form.transport, enabled: form.enabled,
      tool_effects: parseEffects(form.effectsText),
    };
    if (form.transport === "stdio") {
      body.command = form.command.trim();
      body.args = parseLines(form.argsText);
    } else {
      body.url = form.url.trim();
    }
    // env/headers：编辑时留空 = 保留旧值（密钥不回显，用户无法「原样提交」）；
    // 勾选「清空」才发 {}，与后端 None=保留 / {}=清空 的语义对齐。
    if (!editing || form.envText.trim() || form.clearSecrets) {
      body.env = form.envText.trim() ? parseKv(form.envText) : {};
    }
    if (!editing || form.headersText.trim() || form.clearSecrets) {
      body.headers = form.headersText.trim() ? parseKv(form.headersText) : {};
    }
    setBusy(editing ? editing.id : "__create");
    setFormErr(null);
    try {
      if (editing) {
        await patch("/mcp-servers/" + editing.id, body);
        message.success("已保存并重连");
      } else {
        await post("/mcp-servers", body);
        message.success("MCP 服务已登记");
      }
      setForm(null);
      setEditing(null);
      await load();
    } catch (e) {
      // 409 同名 / 422 校验 / 403：都按后端原话留在弹窗里，不关窗丢输入
      setFormErr(e instanceof ApiErr ? e.message : "保存失败");
    } finally {
      setBusy(null);
    }
  }

  async function test(s: McpServer): Promise<void> {
    setBusy("test:" + s.id);
    try {
      const out = await post<{ ok: boolean; latency_ms: number; tool_count: number; error: string | null }>(
        "/mcp-servers/" + s.id + "/test", {});
      if (out.ok) message.success(`连接成功：${out.tool_count} 个工具，${out.latency_ms}ms`);
      else message.error("连接失败：" + (out.error || "未知错误"));
      await load();
    } catch {
      // client 已 toast
    } finally {
      setBusy(null);
    }
  }

  async function toggle(s: McpServer, enabled: boolean): Promise<void> {
    setBusy("toggle:" + s.id);
    try {
      await post("/mcp-servers/" + s.id + "/toggle", { enabled });
      message.success(enabled ? "已启用并重连" : "已停用");
      await load();
    } catch {
      // client 已 toast
    } finally {
      setBusy(null);
    }
  }

  async function previewTools(s: McpServer): Promise<void> {
    setBusy("tools:" + s.id);
    try {
      const out = await get<{ items: McpTool[] }>("/mcp-servers/" + s.id + "/tools");
      setPreview({ server: s, items: out.items });
    } catch {
      // client 已 toast
    } finally {
      setBusy(null);
    }
  }

  async function remove(s: McpServer): Promise<void> {
    setBusy("del:" + s.id);
    try {
      await del("/mcp-servers/" + s.id);
      message.success("已删除");
      await load();
    } catch {
      // client 已 toast
    } finally {
      setBusy(null);
    }
  }

  const columns = [
    {
      title: "名称", dataIndex: "name", key: "name",
      render: (_: unknown, s: McpServer) => (
        <div>
          <Typography.Text strong>{s.name}</Typography.Text>
          {s.last_error ? (
            <Tooltip title={s.last_error}>
              <div data-testid={"mcp-error-" + s.id} className="tp-text-sm"
                style={{ color: "var(--tp-color-error, #cf1322)", maxWidth: 360,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                最近错误：{s.last_error}
              </div>
            </Tooltip>
          ) : null}
        </div>
      ),
    },
    {
      title: "transport", dataIndex: "transport", key: "transport", width: 110,
      render: (v: string) => <Tag data-testid="mcp-transport">{v}</Tag>,
    },
    {
      title: "状态", dataIndex: "status", key: "status", width: 100,
      render: (v: McpServer["status"]) => {
        const m = statusMeta(v);
        return <Badge data-testid="mcp-status" data-state={v} status={m.badge} text={m.label} />;
      },
    },
    {
      title: "工具数", dataIndex: "tool_count", key: "tool_count", width: 90,
      render: (v: number, s: McpServer) => (s.status === "disabled" || !s.tool_count ? "—" : v),
    },
    {
      title: "最近探测", dataIndex: "last_checked_at", key: "checked", width: 190,
      render: (v: string | null, s: McpServer) => (
        <span className="tp-text-sm">
          {fmtTime(v) ?? "—"}{s.last_latency_ms != null ? ` · ${s.last_latency_ms}ms` : ""}
        </span>
      ),
    },
    {
      title: "操作", key: "ops", width: 360,
      render: (_: unknown, s: McpServer) => (
        <Space size={4} wrap>
          <Button size="small" data-testid={"mcp-toggle-" + s.id}
            loading={busy === "toggle:" + s.id} disabled={!canManage}
            onClick={() => void toggle(s, !s.enabled)}>{s.enabled ? "停用" : "启用"}</Button>
          <Button size="small" data-testid={"mcp-test-" + s.id}
            loading={busy === "test:" + s.id} disabled={!canManage}
            onClick={() => void test(s)}>测试连接</Button>
          <Button size="small" data-testid={"mcp-tools-" + s.id}
            loading={busy === "tools:" + s.id} onClick={() => void previewTools(s)}>工具预览</Button>
          <Button size="small" data-testid={"mcp-edit-" + s.id}
            disabled={!canManage} onClick={() => openEdit(s)}>编辑</Button>
          <Popconfirm title="删除后不可恢复，确定？" okText="删除" cancelText="取消"
            onConfirm={() => void remove(s)} disabled={!canManage}>
            <Button size="small" danger data-testid={"mcp-del-" + s.id} disabled={!canManage}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Space wrap>
        <Button type="primary" icon={<PlusOutlined />} data-testid="mcp-add"
          disabled={!canManage} onClick={openCreate}>添加 MCP 服务</Button>
        <Button icon={<ReloadOutlined />} data-testid="mcp-reload" onClick={() => void load()}>刷新</Button>
        <Typography.Text type="secondary" className="tp-text-sm">
          工具会以 mcp__&lt;server&gt;__&lt;tool&gt; 的名字进入 Pilot 工具箱；写类默认需审批，可在编辑里逐工具改为只读。
        </Typography.Text>
      </Space>
      {failed ? (
        <Alert type="error" showIcon data-testid="mcp-load-failed"
          message="没取到 MCP 服务列表" description="可能是网络/服务故障，稍后重试；本页仅系统管理员可读。" />
      ) : (
        <Table<McpServer> rowKey="id" size="small" loading={loading} data-testid="mcp-table"
          columns={columns} dataSource={items} pagination={false}
          locale={{ emptyText: "还没有 MCP 服务。stdio 型会拉起服务器上的命令，登记前请确认来源可信。" }} />
      )}

      <Modal open={form !== null} width={640} centered title={editing ? "编辑 MCP 服务" : "添加 MCP 服务"}
        okText="保存并重连" cancelText="取消" confirmLoading={busy !== null} data-testid="mcp-form-modal"
        onCancel={() => { setForm(null); setEditing(null); }} onOk={() => void submit()} destroyOnHidden>
        {form ? (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            {formErr ? <Alert type="error" showIcon message={formErr} data-testid="mcp-form-error" /> : null}
            <div>
              <Typography.Text strong>名称</Typography.Text>
              <Input data-testid="mcp-form-name" maxLength={100} value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <Space size={12} wrap>
              <div>
                <Typography.Text strong>transport</Typography.Text>
                <Select data-testid="mcp-form-transport" style={{ width: 180 }} value={form.transport}
                  onChange={(v) => setForm({ ...form, transport: v as Transport })}
                  options={[{ value: "stdio", label: "stdio（本机命令）" },
                    { value: "sse", label: "SSE（远程 URL）" }, { value: "http", label: "HTTP（远程 URL）" }]} />
              </div>
              <div>
                <Typography.Text strong>启用</Typography.Text>
                <Switch data-testid="mcp-form-enabled" checked={form.enabled}
                  onChange={(v) => setForm({ ...form, enabled: v })} />
              </div>
            </Space>
            {form.transport === "stdio" ? (
              <>
                <div>
                  <Typography.Text strong>启动命令</Typography.Text>
                  <Input data-testid="mcp-form-command" placeholder="npx / uvx / python 的绝对路径"
                    value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
                </div>
                <div>
                  <Typography.Text strong>参数（一行一个）</Typography.Text>
                  <Input.TextArea data-testid="mcp-form-args" rows={3} value={form.argsText}
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/data"}
                    onChange={(e) => setForm({ ...form, argsText: e.target.value })} />
                </div>
              </>
            ) : (
              <div>
                <Typography.Text strong>URL</Typography.Text>
                <Input data-testid="mcp-form-url" placeholder="https://host/mcp"
                  value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </div>
            )}
            <Divider style={{ margin: "4px 0" }} />
            <div>
              <Typography.Text strong>环境变量</Typography.Text>
              <Typography.Text type="secondary" className="tp-text-sm">
                {" "}一行一条 KEY=VALUE，加密保存、不回显
                {editing && form.envText === "" ? "；留空=保留现有" : ""}
              </Typography.Text>
              <Input.TextArea data-testid="mcp-form-env" rows={2} value={form.envText}
                placeholder={editing && editing.env_keys.length ? "已保存：" + editing.env_keys.join(", ") : "KEY=VALUE"}
                onChange={(e) => setForm({ ...form, envText: e.target.value })} />
            </div>
            {form.transport !== "stdio" ? (
              <div>
                <Typography.Text strong>请求头</Typography.Text>
                <Input.TextArea data-testid="mcp-form-headers" rows={2} value={form.headersText}
                  placeholder={editing && editing.has_headers ? "已保存请求头（不回显）；留空=保留现有" : "Authorization=Bearer ..."}
                  onChange={(e) => setForm({ ...form, headersText: e.target.value })} />
              </div>
            ) : null}
            {editing && (editing.env_keys.length > 0 || editing.has_headers) ? (
              <Space size={8}>
                <Switch size="small" data-testid="mcp-form-clear" checked={form.clearSecrets}
                  onChange={(v) => setForm({ ...form, clearSecrets: v })} />
                <Typography.Text className="tp-text-sm">清空已保存的环境变量与请求头</Typography.Text>
              </Space>
            ) : null}
            <div>
              <Typography.Text strong>逐工具权限</Typography.Text>
              <Typography.Text type="secondary" className="tp-text-sm">
                {" "}一行一条 工具名=read|write；缺省 write（ASK 模式需审批）
              </Typography.Text>
              <Input.TextArea data-testid="mcp-form-effects" rows={2} value={form.effectsText}
                placeholder={"search=read\nread_file=read"} onChange={(e) => setForm({ ...form, effectsText: e.target.value })} />
            </div>
          </Space>
        ) : null}
      </Modal>

      <Modal open={preview !== null} width={720} centered footer={null} destroyOnHidden
        title={"工具预览 · " + (preview?.server.name ?? "")}
        onCancel={() => setPreview(null)}>
        <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="transport">{preview?.server.transport ?? ""}</Descriptions.Item>
          <Descriptions.Item label="工具数">{preview?.items.length ?? 0}</Descriptions.Item>
          <Descriptions.Item label="最近探测">{fmtTime(preview?.server.last_checked_at) ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="状态">
            {preview ? statusMeta(preview.server.status).label : ""}
          </Descriptions.Item>
        </Descriptions>
        <ToolList items={preview?.items ?? []} />
      </Modal>
    </Space>
  );
}
