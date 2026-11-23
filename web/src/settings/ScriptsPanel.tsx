// 公共脚本面板（D200 / C2）。D250：接 ListToolbar 三件套（高级搜索 / 视图 / 列设置）。
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import { PlusOutlined } from "../ui/icons";
import { projectAssetsApi, type ScriptRow } from "../api/projectAssets";
import { ApiErr } from "../api/client";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import {
  applyColumnPrefs, emptyFilter, isFilterEmpty,
  type ColumnChoice, type FilterDoc,
} from "../shared/listFilters";
import type { ColumnsType } from "antd/es/table";

const LANGS = [
  { value: "python", label: "Python" }, { value: "javascript", label: "JavaScript" },
  { value: "groovy", label: "Groovy" }, { value: "shell", label: "Shell" },
];

// key 与列定义逐字一致；操作列不可隐藏。
const SCRIPT_COL_CHOICES: ColumnChoice[] = [
  { key: "name", label: "名称" },
  { key: "language", label: "语言" },
  { key: "version", label: "版本" },
  { key: "enabled", label: "启用" },
  { key: "description", label: "说明" },
];

const LANGUAGE_OPTIONS: Option[] = LANGS.map((l) => ({ value: l.value, label: l.label }));
const ENABLED_OPTIONS: Option[] = [
  { value: true, label: "启用" }, { value: false, label: "停用" },
];

export default function ScriptsPanel({ projectId, canEdit, canSaveView, canDeleteView }: {
  projectId: string;
  canEdit: boolean;
  /** D250：视图写入位（search:view:create/delete）。 */
  canSaveView: boolean;
  canDeleteView: boolean;
}) {
  const [rows, setRows] = useState<ScriptRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<{ editing: ScriptRow | null } | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("python");
  const [content, setContent] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const [colPref, setColPref] = useColumnPrefs(
    "public_script", SCRIPT_COL_CHOICES.map((c) => c.key));

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      setRows((await projectAssetsApi.scripts(projectId,
        isFilterEmpty(advFilter) ? {} : { filter: JSON.stringify(advFilter) })).items);
    } catch (e) { setErr(e instanceof ApiErr ? e.message : "脚本加载失败"); }
    finally { setLoading(false); }
  }, [projectId, advFilter]);
  useEffect(() => { void load(); }, [load]);

  function open(editing: ScriptRow | null): void {
    setName(editing?.name ?? ""); setDescription(editing?.description ?? "");
    setLanguage(editing?.language ?? "python"); setContent(editing?.content ?? "");
    setEnabled(editing?.enabled ?? true);
    setModal({ editing });
  }

  async function submit(): Promise<void> {
    if (!name.trim() || !content.trim()) { message.warning("名称与内容必填"); return; }
    setBusy(true);
    try {
      if (modal?.editing) {
        await projectAssetsApi.updateScript(modal.editing.id, {
          project_id: projectId, name: name.trim(), description, language, content, enabled,
        });
      } else {
        await projectAssetsApi.createScript({
          project_id: projectId, name: name.trim(), description, language, content, enabled,
        });
      }
      message.success("已保存");
      setModal(null); await load();
    } catch (e) {
      message.error(e instanceof ApiErr ? e.message : "保存失败");
    } finally { setBusy(false); }
  }

  const cols: ColumnsType<ScriptRow> = applyColumnPrefs([
    { title: "名称", key: "name", dataIndex: "name" },
    { title: "语言", key: "language", dataIndex: "language", width: 110,
      render: (v: string) => <Tag>{v}</Tag> },
    { title: "版本", key: "version", dataIndex: "version", width: 70,
      render: (v: number) => "v" + v },
    { title: "启用", key: "enabled", dataIndex: "enabled", width: 80,
      render: (v: boolean, r: ScriptRow) => (
        <Switch size="small" checked={v} disabled={!canEdit}
          onChange={async (checked) => {
            try {
              await projectAssetsApi.updateScript(r.id, {
                project_id: projectId, enabled: checked,
              });
              // 筛「启用=是」时把行改停用，它已不属于当前结果集——重拉而不是留一张
              // 与条件不符的旧脸（无筛选时仍走本地打补丁，省一次往返）。
              if (isFilterEmpty(advFilter)) {
                setRows((prev) => prev.map((x) => x.id === r.id ? { ...x, enabled: checked } : x));
              } else { await load(); }
            } catch { /* toast */ }
          }} />) },
    { title: "说明", key: "description", dataIndex: "description", ellipsis: true },
    { title: "", key: "ops", width: 140, render: (_: unknown, r: ScriptRow) => canEdit && (
      <Space size={4}>
        <Button size="small" onClick={() => open(r)}>编辑</Button>
        <Button size="small" danger onClick={async () => {
          await projectAssetsApi.deleteScript(projectId, r.id);
          message.success("已删除");
          await load();
        }}>删除</Button>
      </Space>) },
  ], colPref);

  return (
    <div data-testid="scripts-panel">
      <Space style={{ marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>公共脚本</Typography.Title>
        {canEdit && (
          <Button size="small" icon={<PlusOutlined />} data-testid="script-new"
            onClick={() => open(null)}>新建脚本</Button>
        )}
      </Space>
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} />}
      <ListToolbar projectId={projectId} viewType="public_script" filter={advFilter}
        onFilterChange={setAdvFilter} allColumns={SCRIPT_COL_CHOICES}
        columnPref={colPref} onColumnPrefChange={setColPref}
        canSaveView={canSaveView} canDeleteView={canDeleteView}
        valueOptions={{ language: LANGUAGE_OPTIONS, enabled: ENABLED_OPTIONS }} />
      <Table rowKey="id" size="small" loading={loading} pagination={false} dataSource={rows}
        locale={{ emptyText: "还没有公共脚本" }} columns={cols} />
      <Modal open={modal !== null} onCancel={() => setModal(null)} centered width={720}
        title={modal?.editing ? "编辑公共脚本" : "新建公共脚本"} okText="保存" cancelText="取消"
        okButtonProps={{ loading: busy, "data-testid": "script-save" }} onOk={() => void submit()}>
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Space size={12} wrap>
            <Input placeholder="脚本名" value={name} style={{ width: 260 }}
              onChange={(e) => setName(e.target.value)} />
            <Select value={language} style={{ width: 140 }} onChange={setLanguage} options={LANGS} />
            <Switch checked={enabled} onChange={setEnabled} />
          </Space>
          <Input placeholder="说明" value={description} onChange={(e) => setDescription(e.target.value)} />
          <Input.TextArea rows={14} value={content} style={{ fontFamily: "monospace" }}
            placeholder="脚本内容" onChange={(e) => setContent(e.target.value)} />
        </Space>
      </Modal>
    </div>
  );
}
