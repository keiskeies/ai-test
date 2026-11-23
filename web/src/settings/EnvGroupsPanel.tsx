// 环境组面板（D200 / C1）。D249：接 ListToolbar 三件套（高级搜索 / 视图 / 列设置）。
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { PlusOutlined } from "../ui/icons";
import { projectAssetsApi, type EnvGroup } from "../api/projectAssets";
import { get, ApiErr } from "../api/client";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import {
  applyColumnPrefs, emptyFilter, isFilterEmpty,
  type ColumnChoice, type FilterDoc,
} from "../shared/listFilters";
import type { ColumnsType } from "antd/es/table";

type EnvRow = { id: string; name: string };

// key 与列定义逐字一致；操作钮列（ops）不可隐藏，不列入候选。
const ENV_GROUP_COL_CHOICES: ColumnChoice[] = [
  { key: "name", label: "名称" },
  { key: "envs", label: "环境" },
  { key: "description", label: "说明" },
];

export default function EnvGroupsPanel({ projectId, canEdit, canSaveView, canDeleteView }: {
  projectId: string;
  canEdit: boolean;
  /** D249：视图写入位（search:view:create/delete）。 */
  canSaveView: boolean;
  canDeleteView: boolean;
}) {
  const [groups, setGroups] = useState<EnvGroup[]>([]);
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<{ editing: EnvGroup | null } | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [envIds, setEnvIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const [colPref, setColPref] = useColumnPrefs(
    "env_group", ENV_GROUP_COL_CHOICES.map((c) => c.key));

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const [g, e] = await Promise.all([
        // 空条件不拼 filter（URL 里不出现骗人的 filter=）。
        projectAssetsApi.envGroups(projectId,
          isFilterEmpty(advFilter) ? undefined : JSON.stringify(advFilter)),
        get<{ items: EnvRow[] }>("/envs" + "?project_id=" + encodeURIComponent(projectId), { silent: true }),
      ]);
      setGroups(g.items); setEnvs(e.items);
    } catch (e2) {
      setErr(e2 instanceof ApiErr ? e2.message : "环境组加载失败");
    } finally { setLoading(false); }
  }, [projectId, advFilter]);
  useEffect(() => { void load(); }, [load]);

  function open(editing: EnvGroup | null): void {
    setName(editing?.name ?? ""); setDescription(editing?.description ?? "");
    setEnvIds((editing?.envs ?? []).map((x) => x.id));
    setModal({ editing });
  }

  async function submit(): Promise<void> {
    if (!name.trim()) { message.warning("组名必填"); return; }
    setBusy(true);
    try {
      if (modal?.editing) {
        await projectAssetsApi.updateEnvGroup(modal.editing.id, {
          project_id: projectId, name: name.trim(), description, env_ids: envIds,
        });
      } else {
        await projectAssetsApi.createEnvGroup({
          project_id: projectId, name: name.trim(), description, env_ids: envIds,
        });
      }
      message.success("已保存");
      setModal(null); await load();
    } catch (e) {
      message.error(e instanceof ApiErr ? e.message : "保存失败");
    } finally { setBusy(false); }
  }

  const cols: ColumnsType<EnvGroup> = applyColumnPrefs([
    { title: "名称", key: "name", dataIndex: "name" },
    { title: "环境", key: "envs", render: (_: unknown, g: EnvGroup) => g.envs.length
      ? g.envs.map((e) => <Tag key={e.id}>{e.name}</Tag>)
      : <Typography.Text type="secondary">—</Typography.Text> },
    { title: "说明", key: "description", dataIndex: "description", ellipsis: true },
    { title: "", key: "ops", width: 140, render: (_: unknown, g: EnvGroup) => canEdit && (
      <Space size={4}>
        <Button size="small" onClick={() => open(g)}>编辑</Button>
        <Button size="small" danger onClick={async () => {
          await projectAssetsApi.deleteEnvGroup(projectId, g.id);
          message.success("已删除");
          await load();
        }}>删除</Button>
      </Space>) },
  ], colPref);

  return (
    <div data-testid="env-groups-panel">
      <Space style={{ marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>环境组</Typography.Title>
        {canEdit && (
          <Button size="small" icon={<PlusOutlined />} data-testid="env-group-new"
            onClick={() => open(null)}>新建环境组</Button>
        )}
      </Space>
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 8 }} />}
      <ListToolbar projectId={projectId} viewType="env_group" filter={advFilter}
        onFilterChange={setAdvFilter} allColumns={ENV_GROUP_COL_CHOICES}
        columnPref={colPref} onColumnPrefChange={setColPref}
        canSaveView={canSaveView} canDeleteView={canDeleteView} />
      <Table rowKey="id" size="small" loading={loading} pagination={false} dataSource={groups}
        locale={{ emptyText: "还没有环境组" }} columns={cols} />
      <Modal open={modal !== null} onCancel={() => setModal(null)} centered width={560}
        title={modal?.editing ? "编辑环境组" : "新建环境组"} okText="保存" cancelText="取消"
        okButtonProps={{ loading: busy, "data-testid": "env-group-save" }} onOk={() => void submit()}>
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Input placeholder="组名" value={name} onChange={(e) => setName(e.target.value)} />
          <Input.TextArea rows={2} placeholder="说明" value={description}
            onChange={(e) => setDescription(e.target.value)} />
          <Select mode="multiple" style={{ width: "100%" }} value={envIds} onChange={setEnvIds}
            optionFilterProp="label" placeholder="选择环境"
            options={envs.map((e) => ({ value: e.id, label: e.name }))} />
        </Space>
      </Modal>
    </div>
  );
}
