// 项目设置 · 应用开关与误报库（D199）。
import { useCallback, useEffect, useState } from "react";
import {
  Alert, Button, Input, Modal, Select, Space, Switch, Table, Tag, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import {
  projectSettingsApi, type ApplicationItem, type FakeErrorRule,
} from "../api/projectSettings";
import { ApiErr } from "../api/client";
import EnvGroupsPanel from "./EnvGroupsPanel";
import ScriptsPanel from "./ScriptsPanel";

function FakeErrorModal({ open, projectId, editing, onClose, onSaved }: {
  open: boolean;
  projectId: string;
  editing: FakeErrorRule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [matchType, setMatchType] = useState<"contains" | "regex" | "exact">("contains");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? ""); setPattern(editing?.pattern ?? "");
    setMatchType(editing?.match_type ?? "contains");
    setDescription(editing?.description ?? ""); setEnabled(editing?.enabled ?? true);
    setErr(null);
  }, [open, editing]);

  async function submit(): Promise<void> {
    if (!name.trim() || !pattern.trim()) { message.warning("名称与匹配串必填"); return; }
    setBusy(true); setErr(null);
    try {
      if (editing) {
        await projectSettingsApi.updateFakeError(projectId, editing.id, {
          name: name.trim(), pattern: pattern.trim(), match_type: matchType,
          description, enabled,
        });
      } else {
        await projectSettingsApi.createFakeError({
          project_id: projectId, name: name.trim(), pattern: pattern.trim(),
          match_type: matchType, description, enabled,
        });
      }
      message.success(editing ? "已保存" : "规则已创建");
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} centered width={600}
      title={editing ? "编辑误报规则" : "新建误报规则"} okText="保存" cancelText="取消"
      okButtonProps={{ loading: busy, "data-testid": "fe-save" }} onOk={() => void submit()}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input data-testid="fe-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Space size={12} wrap>
          <div>
            <Typography.Text strong>匹配方式</Typography.Text>
            <Select value={matchType} style={{ width: 140 }} onChange={(v) => setMatchType(v as typeof matchType)}
              options={[{ value: "contains", label: "包含" }, { value: "exact", label: "完全相同" },
                { value: "regex", label: "正则" }]} />
          </div>
          <div>
            <Typography.Text strong>启用</Typography.Text>
            <Switch checked={enabled} onChange={setEnabled} />
          </div>
        </Space>
        <div>
          <Typography.Text strong>匹配串</Typography.Text>
          <Input.TextArea data-testid="fe-pattern" rows={2} value={pattern}
            onChange={(e) => setPattern(e.target.value)} />
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

export default function ProjectSettingsTab({ projectId, canUpdate, canSaveView, canDeleteView }: {
  projectId: string;
  canUpdate: boolean;
  /** D249：环境组列表的视图写入位（search:view:create/delete）。 */
  canSaveView: boolean;
  canDeleteView: boolean;
}) {
  const [apps, setApps] = useState<ApplicationItem[]>([]);
  const [rules, setRules] = useState<FakeErrorRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kw, setKw] = useState("");
  const [modal, setModal] = useState<{ editing: FakeErrorRule | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [a, r] = await Promise.all([
        projectSettingsApi.applications(projectId),
        projectSettingsApi.fakeErrors(projectId, kw || undefined),
      ]);
      setApps(a.items); setRules(r.items);
    } catch (e) {
      setErr(e instanceof ApiErr ? e.message : "项目设置加载失败");
    } finally { setLoading(false); }
  }, [projectId, kw]);
  useEffect(() => { void load(); }, [load]);

  const groups = Array.from(new Set(apps.map((a) => a.group)));

  return (
    <div data-testid="project-settings-tab">
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}
      <Space style={{ marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>应用开关</Typography.Title>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
      </Space>
      <Space direction="vertical" size={10} style={{ width: "100%", marginBottom: 16 }}>
        {groups.map((g) => (
          <div key={g} className="tp-card" style={{ padding: 12 }}>
            <Typography.Text strong>{g}</Typography.Text>
            <Space direction="vertical" size={8} style={{ width: "100%", marginTop: 8 }}>
              {apps.filter((a) => a.group === g).map((a) => (
                <Space key={a.key} size={10} wrap>
                  <Switch data-testid={"app-" + a.key} checked={a.enabled} disabled={!canUpdate}
                    onChange={async (checked) => {
                      try {
                        await projectSettingsApi.updateApplication(projectId, a.key, checked);
                        setApps((prev) => prev.map((x) => x.key === a.key ? { ...x, enabled: checked } : x));
                        message.success("已更新");
                      } catch { /* toast */ }
                    }} />
                  <Typography.Text>{a.label}</Typography.Text>
                  {a.enabled === a.default
                    ? <Tag>默认</Tag>
                    : <Tag color="blue">已覆盖</Tag>}
                  <Typography.Text type="secondary" className="tp-text-sm">{a.description}</Typography.Text>
                </Space>
              ))}
            </Space>
          </div>
        ))}
      </Space>

      <Space style={{ marginBottom: 8 }} wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>误报库</Typography.Title>
        {canUpdate && (
          <Button size="small" icon={<PlusOutlined />} data-testid="fe-new"
            onClick={() => setModal({ editing: null })}>新建规则</Button>
        )}
        <Input.Search allowClear placeholder="名称/匹配串" style={{ width: 220 }} value={kw}
          onChange={(e) => setKw(e.target.value)} onSearch={() => void load()} />
      </Space>
      <Table rowKey="id" size="small" loading={loading} pagination={false} dataSource={rules}
        locale={{ emptyText: "还没有误报规则" }}
        columns={[
          { title: "名称", dataIndex: "name" },
          { title: "匹配", key: "m", render: (_, r) => (
            <Space size={6}>
              <Tag>{{ contains: "包含", exact: "完全相同", regex: "正则" }[r.match_type]}</Tag>
              <Typography.Text code>{r.pattern}</Typography.Text>
            </Space>) },
          { title: "说明", dataIndex: "description", ellipsis: true },
          { title: "启用", dataIndex: "enabled", width: 80, render: (v: boolean) => v
            ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
          { title: "", key: "ops", width: 140, render: (_, r) => canUpdate && (
            <Space size={4}>
              <Button size="small" onClick={() => setModal({ editing: r })}>编辑</Button>
              <Button size="small" danger onClick={async () => {
                await projectSettingsApi.deleteFakeError(projectId, r.id);
                message.success("已删除");
                await load();
              }}>删除</Button>
            </Space>) },
        ]} />

      <FakeErrorModal open={modal !== null} projectId={projectId} editing={modal?.editing ?? null}
        onClose={() => setModal(null)} onSaved={() => void load()} />

      <div style={{ height: 12 }} />
      <EnvGroupsPanel projectId={projectId} canEdit={canUpdate}
        canSaveView={canSaveView} canDeleteView={canDeleteView} />
      <div style={{ height: 12 }} />
      <ScriptsPanel projectId={projectId} canEdit={canUpdate}
        canSaveView={canSaveView} canDeleteView={canDeleteView} />
    </div>
  );
}
