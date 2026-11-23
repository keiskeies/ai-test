// 平台运维（D203）：服务集成 / 资源池 / 插件登记三块。
// 三块的共同口径：这里只做「登记面」的增删改查与启停，不假装已经接通——
// 集成不发连通性请求、资源池容量只是登记值、插件没有装载点（loadable 恒 false）。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import { platformOpsApi, type Integration, type Plugin, type Pool } from "../api/platformOps";
import { ApiErr } from "../api/client";
import { can } from "../auth/perms";

const INTEGRATION_KIND_LABEL: Record<string, string> = {
  github: "GitHub", gitlab: "GitLab", gitee: "Gitee",
};
const POOL_KIND_LABEL: Record<string, string> = {
  api: "接口", ui: "UI", adb: "ADB", local: "本地",
};
const PLUGIN_KIND_LABEL: Record<string, string> = {
  protocol: "协议", assertion: "断言",
};

// ══════════ 服务集成 ══════════
function IntegrationModal({ open, projectId, editing, onClose, onSaved }: {
  open: boolean; projectId: string; editing: Integration | null;
  onClose: () => void; onSaved: () => void;
}) {
  const [kind, setKind] = useState("github");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(editing?.kind ?? "github"); setName(editing?.name ?? "");
    setBaseUrl(editing?.base_url ?? ""); setToken("");
    setDescription(editing?.description ?? ""); setEnabled(editing?.enabled ?? true);
    setErr(null);
  }, [open, editing]);

  async function submit(): Promise<void> {
    if (!name.trim() || !baseUrl.trim()) { message.warning("名称与 base_url 必填"); return; }
    setBusy(true); setErr(null);
    try {
      if (editing) {
        await platformOpsApi.updateIntegration(projectId, editing.id, {
          name: name.trim(), base_url: baseUrl.trim(), description,
          enabled, ...(token ? { token } : {}),
        });
      } else {
        await platformOpsApi.createIntegration({
          project_id: projectId, kind, name: name.trim(), base_url: baseUrl.trim(),
          token: token || null, description, enabled,
        });
      }
      message.success(editing ? "已保存" : "服务集成已创建");
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} centered width={620}
      title={editing ? "编辑服务集成" : "新建服务集成"} okText="保存" cancelText="取消"
      okButtonProps={{ loading: busy, "data-testid": "si-save" }} onOk={() => void submit()}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <Space size={12} wrap>
          <div>
            <Typography.Text strong>平台</Typography.Text>
            {/* 平台类型是创建时的身份：后端更新入口不含 kind，这里编辑态锁住避免「改了没生效」。 */}
            <Select data-testid="si-kind" value={kind} style={{ width: 140 }} disabled={editing !== null}
              onChange={setKind}
              options={Object.entries(INTEGRATION_KIND_LABEL).map(([value, label]) => ({ value, label }))} />
          </div>
          <div>
            <Typography.Text strong>启用</Typography.Text>
            <Switch checked={enabled} onChange={setEnabled} />
          </div>
        </Space>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input data-testid="si-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>base_url</Typography.Text>
          <Input data-testid="si-url" maxLength={500} value={baseUrl}
            placeholder="https://api.github.com" onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>访问令牌</Typography.Text>
          <Input.Password data-testid="si-token" maxLength={500} value={token}
            placeholder={editing?.has_token
              ? `已保存（${editing.token_hint ?? "****"}），留空保持不变`
              : "可选；保存后只回显末 4 位"}
            onChange={(e) => setToken(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>说明</Typography.Text>
          <Input.TextArea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {err && <Alert type="error" showIcon message={err} />}
      </Space>
    </Modal>
  );
}

function IntegrationsSection({ projectId, perms }: { projectId: string; perms: string[] }) {
  const [items, setItems] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kw, setKw] = useState("");
  const [modal, setModal] = useState<{ editing: Integration | null } | null>(null);
  const canCreate = can(perms, "integration:integration:create");
  const canUpdate = can(perms, "integration:integration:update");
  const canDelete = can(perms, "integration:integration:delete");

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      setItems((await platformOpsApi.integrations(projectId, kw || undefined)).items);
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "服务集成加载失败");
    } finally { setLoading(false); }
  }, [projectId, kw]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section data-testid="platform-integrations">
      <Space style={{ marginBottom: 8 }} wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>服务集成</Typography.Title>
        {canCreate && (
          <Button size="small" icon={<PlusOutlined />} data-testid="si-new"
            onClick={() => setModal({ editing: null })}>新建集成</Button>
        )}
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
        <Input.Search allowClear placeholder="名称/base_url" style={{ width: 220 }} value={kw}
          onChange={(e) => setKw(e.target.value)} onSearch={() => void load()} />
      </Space>
      <Typography.Paragraph type="secondary" className="tp-text-sm" style={{ marginBottom: 8 }}>
        只登记配置，不主动发起任何出站请求（不做连通性测试）；令牌加密存储，列表只回末 4 位。
      </Typography.Paragraph>
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} />}
      <Table rowKey="id" size="small" loading={loading} pagination={false} dataSource={items}
        locale={{ emptyText: "还没有服务集成" }}
        columns={[
          { title: "名称", dataIndex: "name" },
          { title: "平台", dataIndex: "kind", width: 90,
            render: (v: string) => <Tag>{INTEGRATION_KIND_LABEL[v] ?? v}</Tag> },
          { title: "base_url", dataIndex: "base_url", ellipsis: true },
          { title: "令牌", key: "token", width: 120, render: (_, r) => r.has_token
            ? <Typography.Text code>{r.token_hint}</Typography.Text>
            : <Typography.Text type="secondary">未设置</Typography.Text> },
          { title: "启用", dataIndex: "enabled", width: 80, render: (v: boolean, r) => (
            <Switch size="small" checked={v} disabled={!canUpdate} data-testid={"si-toggle-" + r.id}
              onChange={async (checked) => {
                try {
                  await platformOpsApi.setIntegrationStatus(projectId, r.id, checked);
                  setItems((prev) => prev.map((x) => x.id === r.id ? { ...x, enabled: checked } : x));
                } catch { /* 统一提示在列表上方 */ }
              }} />) },
          { title: "", key: "ops", width: 140, render: (_, r) => (canUpdate || canDelete) && (
            <Space size={4}>
              {canUpdate && <Button size="small" onClick={() => setModal({ editing: r })}>编辑</Button>}
              {canDelete && <Button size="small" danger onClick={async () => {
                await platformOpsApi.deleteIntegration(projectId, r.id);
                message.success("已删除");
                await load();
              }}>删除</Button>}
            </Space>) },
        ]} />
      <IntegrationModal open={modal !== null} projectId={projectId} editing={modal?.editing ?? null}
        onClose={() => setModal(null)} onSaved={() => void load()} />
    </section>
  );
}

// ══════════ 资源池 ══════════
function PoolModal({ open, projectId, editing, onClose, onSaved }: {
  open: boolean; projectId: string; editing: Pool | null;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("local");
  const [capacity, setCapacity] = useState(1);
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? ""); setKind(editing?.kind ?? "local");
    setCapacity(editing?.capacity ?? 1); setDescription(editing?.description ?? "");
    setEnabled(editing?.enabled ?? true); setErr(null);
  }, [open, editing]);

  async function submit(): Promise<void> {
    if (!name.trim()) { message.warning("名称必填"); return; }
    setBusy(true); setErr(null);
    try {
      if (editing) {
        await platformOpsApi.updatePool(projectId, editing.id, {
          name: name.trim(), kind, capacity, description, enabled,
        });
      } else {
        await platformOpsApi.createPool({
          project_id: projectId, name: name.trim(), kind, capacity, description, enabled,
        });
      }
      message.success(editing ? "已保存" : "资源池已创建");
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} centered width={560}
      title={editing ? "编辑资源池" : "新建资源池"} okText="保存" cancelText="取消"
      okButtonProps={{ loading: busy, "data-testid": "pool-save" }} onOk={() => void submit()}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input data-testid="pool-name" maxLength={200} value={name}
            onChange={(e) => setName(e.target.value)} />
        </div>
        <Space size={12} wrap>
          <div>
            <Typography.Text strong>类型</Typography.Text>
            <Select data-testid="pool-kind" value={kind} style={{ width: 140 }} onChange={setKind}
              options={Object.entries(POOL_KIND_LABEL).map(([value, label]) => ({ value, label }))} />
          </div>
          <div>
            <Typography.Text strong>容量</Typography.Text>
            <InputNumber data-testid="pool-capacity" min={1} max={1000} value={capacity}
              onChange={(v) => setCapacity(v ?? 1)} />
          </div>
          <div>
            <Typography.Text strong>启用</Typography.Text>
            <Switch checked={enabled} onChange={setEnabled} />
          </div>
        </Space>
        <div>
          <Typography.Text strong>说明</Typography.Text>
          <Input.TextArea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {err && <Alert type="error" showIcon message={err} />}
      </Space>
    </Modal>
  );
}

function PoolsSection({ projectId, perms }: { projectId: string; perms: string[] }) {
  const [items, setItems] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<{ editing: Pool | null } | null>(null);
  const canCreate = can(perms, "resource:pool:create");
  const canUpdate = can(perms, "resource:pool:update");
  const canDelete = can(perms, "resource:pool:delete");

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      setItems((await platformOpsApi.pools(projectId)).items);
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "资源池加载失败");
    } finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section data-testid="platform-pools">
      <Space style={{ marginBottom: 8 }} wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>资源池</Typography.Title>
        {canCreate && (
          <Button size="small" icon={<PlusOutlined />} data-testid="pool-new"
            onClick={() => setModal({ editing: null })}>新建资源池</Button>
        )}
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
      </Space>
      <Typography.Paragraph type="secondary" className="tp-text-sm" style={{ marginBottom: 8 }}>
        容量是登记值：执行仍由单个后台 worker 消费，登记了资源池不等于接上了调度器。
      </Typography.Paragraph>
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} />}
      <Table rowKey="id" size="small" loading={loading} pagination={false} dataSource={items}
        locale={{ emptyText: "还没有资源池" }}
        columns={[
          { title: "名称", dataIndex: "name" },
          { title: "类型", dataIndex: "kind", width: 90,
            render: (v: string) => <Tag>{POOL_KIND_LABEL[v] ?? v}</Tag> },
          { title: "容量", dataIndex: "capacity", width: 80 },
          { title: "说明", dataIndex: "description", ellipsis: true },
          { title: "启用", dataIndex: "enabled", width: 80, render: (v: boolean) => v
            ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
          { title: "", key: "ops", width: 140, render: (_, r) => (canUpdate || canDelete) && (
            <Space size={4}>
              {canUpdate && <Button size="small" onClick={() => setModal({ editing: r })}>编辑</Button>}
              {canDelete && <Button size="small" danger onClick={async () => {
                await platformOpsApi.deletePool(projectId, r.id);
                message.success("已删除");
                await load();
              }}>删除</Button>}
            </Space>) },
        ]} />
      <PoolModal open={modal !== null} projectId={projectId} editing={modal?.editing ?? null}
        onClose={() => setModal(null)} onSaved={() => void load()} />
    </section>
  );
}

// ══════════ 插件登记 ══════════
function PluginModal({ open, projectId, editing, onClose, onSaved }: {
  open: boolean; projectId: string; editing: Plugin | null;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("protocol");
  const [version, setVersion] = useState("1.0.0");
  const [config, setConfig] = useState("{}");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? ""); setKind(editing?.kind ?? "protocol");
    setVersion(editing?.version ?? "1.0.0"); setConfig(editing?.config ?? "{}");
    setDescription(editing?.description ?? ""); setEnabled(editing?.enabled ?? true);
    setErr(null);
  }, [open, editing]);

  async function submit(): Promise<void> {
    if (!name.trim()) { message.warning("名称必填"); return; }
    try { JSON.parse(config); } catch { setErr("配置必须是合法 JSON"); return; }
    setBusy(true); setErr(null);
    try {
      if (editing) {
        await platformOpsApi.updatePlugin(projectId, editing.id, {
          name: name.trim(), kind, version: version.trim() || "1.0.0",
          config, description, enabled,
        });
      } else {
        await platformOpsApi.createPlugin({
          project_id: projectId, name: name.trim(), kind, version: version.trim() || "1.0.0",
          config, description, enabled,
        });
      }
      message.success(editing ? "已保存" : "插件已登记");
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} centered width={620}
      title={editing ? "编辑插件登记" : "登记插件"} okText="保存" cancelText="取消"
      okButtonProps={{ loading: busy, "data-testid": "plugin-save" }} onOk={() => void submit()}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <Space size={12} wrap>
          <div>
            <Typography.Text strong>名称</Typography.Text>
            <Input data-testid="plugin-name" maxLength={200} value={name}
              onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Typography.Text strong>类型</Typography.Text>
            <Select data-testid="plugin-kind" value={kind} style={{ width: 120 }} onChange={setKind}
              options={Object.entries(PLUGIN_KIND_LABEL).map(([value, label]) => ({ value, label }))} />
          </div>
          <div>
            <Typography.Text strong>版本</Typography.Text>
            <Input data-testid="plugin-version" style={{ width: 110 }} maxLength={32} value={version}
              onChange={(e) => setVersion(e.target.value)} />
          </div>
          <div>
            <Typography.Text strong>启用</Typography.Text>
            <Switch checked={enabled} onChange={setEnabled} />
          </div>
        </Space>
        <div>
          <Typography.Text strong>配置（JSON）</Typography.Text>
          <Input.TextArea data-testid="plugin-config" rows={5} value={config}
            onChange={(e) => setConfig(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>说明</Typography.Text>
          <Input.TextArea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {err && <Alert type="error" showIcon message={err} />}
      </Space>
    </Modal>
  );
}

function PluginsSection({ projectId, perms }: { projectId: string; perms: string[] }) {
  const [items, setItems] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [modal, setModal] = useState<{ editing: Plugin | null } | null>(null);
  const canCreate = can(perms, "plugin:plugin:create");
  const canUpdate = can(perms, "plugin:plugin:update");
  const canDelete = can(perms, "plugin:plugin:delete");

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [list, meta] = await Promise.all([
        platformOpsApi.plugins(projectId), platformOpsApi.pluginMeta(projectId),
      ]);
      setItems(list.items); setNote(meta.note);
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "插件加载失败");
    } finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const noteText = useMemo(() => note || "插件只做登记：当前版本没有动态装载点。", [note]);

  return (
    <section data-testid="platform-plugins">
      <Space style={{ marginBottom: 8 }} wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>插件登记</Typography.Title>
        {canCreate && (
          <Button size="small" icon={<PlusOutlined />} data-testid="plugin-new"
            onClick={() => setModal({ editing: null })}>登记插件</Button>
        )}
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
      </Space>
      <Typography.Paragraph type="secondary" className="tp-text-sm" style={{ marginBottom: 8 }}>
        {noteText}
      </Typography.Paragraph>
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} />}
      <Table rowKey="id" size="small" loading={loading} pagination={false} dataSource={items}
        locale={{ emptyText: "还没有插件" }}
        columns={[
          { title: "名称", dataIndex: "name" },
          { title: "类型", dataIndex: "kind", width: 90,
            render: (v: string) => <Tag>{PLUGIN_KIND_LABEL[v] ?? v}</Tag> },
          { title: "版本", dataIndex: "version", width: 90 },
          { title: "配置", dataIndex: "config", ellipsis: true,
            render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: "启用", dataIndex: "enabled", width: 80, render: (v: boolean, r) => (
            <Switch size="small" checked={v} disabled={!canUpdate} data-testid={"plugin-toggle-" + r.id}
              onChange={async (checked) => {
                try {
                  await platformOpsApi.setPluginStatus(projectId, r.id, checked);
                  setItems((prev) => prev.map((x) => x.id === r.id ? { ...x, enabled: checked } : x));
                } catch { /* 统一提示在列表上方 */ }
              }} />) },
          // 「已启用」≠「已装载」：这一列恒为未装载，开关不冒充能力。
          { title: "装载", dataIndex: "loadable", width: 90, render: (v: boolean) => v
            ? <Tag color="green">已装载</Tag> : <Tag data-testid="plugin-unloaded">未装载</Tag> },
          { title: "", key: "ops", width: 140, render: (_, r) => (canUpdate || canDelete) && (
            <Space size={4}>
              {canUpdate && <Button size="small" onClick={() => setModal({ editing: r })}>编辑</Button>}
              {canDelete && <Button size="small" danger onClick={async () => {
                await platformOpsApi.deletePlugin(projectId, r.id);
                message.success("已删除");
                await load();
              }}>删除</Button>}
            </Space>) },
        ]} />
      <PluginModal open={modal !== null} projectId={projectId} editing={modal?.editing ?? null}
        onClose={() => setModal(null)} onSaved={() => void load()} />
    </section>
  );
}

export default function PlatformOpsTab({ projectId, perms }: {
  projectId: string;
  perms: string[];
}) {
  return (
    <div data-testid="tab-platform-ops">
      <IntegrationsSection projectId={projectId} perms={perms} />
      <div style={{ height: 20 }} />
      <PoolsSection projectId={projectId} perms={perms} />
      <div style={{ height: 20 }} />
      <PluginsSection projectId={projectId} perms={perms} />
    </div>
  );
}
