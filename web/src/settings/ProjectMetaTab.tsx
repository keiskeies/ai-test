// 项目设置 · 模板与字段（D192）。
//
// 两个面板：模板（每个场景可有多套，系统默认模板不可删/改名）与自定义字段（值表归缺陷/用例）。
// 权限口径：读位 `project:template:read` 决定 Tab 是否出现；建/改/删按钮按位隐藏（不是禁用）。
// 删除护栏在后端（系统/默认/被引用 → 409），前端只把 409 原话弹出来，不自己重编判据。
import { useCallback, useEffect, useState } from "react";
import {
  Alert, Button, Checkbox, Input, Modal, Select, Space, Table, Tabs, Tag, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import {
  FIELD_TYPES, OPTION_TYPES, SCENES, projectMetaApi,
  type CustomFieldItem, type FieldOption, type FieldType, type Scene,
  type TemplateDetail, type TemplateFieldInput, type TemplateItem,
} from "../api/projectMeta";
import { ApiErr } from "../api/client";
import { fmtTime } from "../shared/timefmt";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import {
  applyColumnPrefs, emptyFilter, isFilterEmpty,
  type ColumnChoice, type FilterDoc,
} from "../shared/listFilters";
import type { ColumnsType } from "antd/es/table";

// D247：两张表各一枚 view_type（后端 project_meta/services.py 的白名单同源）。
// 列设置只列可隐藏的数据列，操作钮列不可隐藏。
const TEMPLATE_COL_CHOICES: ColumnChoice[] = [
  { key: "name", label: "名称" },
  { key: "field_count", label: "字段数" },
  { key: "at", label: "更新时间" },
];
const FIELD_COL_CHOICES: ColumnChoice[] = [
  { key: "name", label: "名称" },
  { key: "field_key", label: "field_key" },
  { key: "type", label: "类型" },
  { key: "opts", label: "选项" },
  { key: "template_count", label: "模板引用" },
];

const BOOL_INTERNAL: Option[] = [
  { value: true, label: "系统内置" },
  { value: false, label: "自建" },
];
// 字段类型词表就是建字段弹窗那一份（FIELD_TYPES），value 为后端存储值。
const TYPE_OPTIONS: Option[] = FIELD_TYPES.map((t) => ({ value: t.value, label: t.label }));

type FieldDraft = { value: string; label: string };

function TemplateModal({ open, projectId, scene, editing, allFields, onClose, onSaved }: {
  open: boolean;
  projectId: string;
  scene: Scene;
  editing: TemplateDetail | null;
  allFields: CustomFieldItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<Record<string, { required: boolean }>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setDescription(editing?.description ?? "");
    setName(editing?.name ?? "");
    if (!editing) {
      setDetail(null);
      setPicked({});
      return;
    }
    void (async () => {
      try {
        const d = await projectMetaApi.template(projectId, editing.id);
        setDetail(d);
        setName(d.name);
        setDescription(d.description ?? "");
        const map: Record<string, { required: boolean }> = {};
        for (const f of d.fields) map[f.field_id] = { required: f.required };
        setPicked(map);
      } catch (e) {
        setErr(e instanceof ApiErr ? e.message : "模板详情加载失败");
      }
    })();
  }, [open, editing, projectId]);

  async function submit(): Promise<void> {
    if (!name.trim()) { message.warning("模板名称必填"); return; }
    setBusy(true);
    setErr(null);
    const fields: TemplateFieldInput[] = allFields
      .filter((f) => picked[f.id])
      .map((f, i) => ({ field_id: f.id, required: picked[f.id].required, sort: i }));
    try {
      if (editing) {
        await projectMetaApi.updateTemplate(projectId, editing.id, {
          project_id: projectId,
          ...(detail?.internal ? {} : { name: name.trim() }),
          description, fields,
        });
      } else {
        await projectMetaApi.createTemplate({
          project_id: projectId, scene, name: name.trim(), description, fields,
        });
      }
      message.success(editing ? "模板已保存" : "模板已创建");
      onSaved();
      onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} width={720} centered destroyOnHidden
      title={editing ? "编辑模板：" + editing.name : "新建模板"}
      okText="保存" cancelText="取消" okButtonProps={{ loading: busy, "data-testid": "pm-template-save" }}
      onOk={() => void submit()}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input data-testid="pm-template-name" maxLength={120} value={name}
            disabled={Boolean(detail?.internal)} onChange={(e) => setName(e.target.value)} />
          {detail?.internal && (
            <Typography.Text type="secondary" className="tp-text-sm">
              系统默认模板不可改名
            </Typography.Text>
          )}
        </div>
        <div>
          <Typography.Text strong>描述</Typography.Text>
          <Input.TextArea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>字段</Typography.Text>
          <Table size="small" pagination={false} rowKey="id" dataSource={allFields}
            locale={{ emptyText: "该场景还没有自定义字段，先在右侧新建" }}
            columns={[
              { title: "字段", dataIndex: "name" },
              { title: "类型", dataIndex: "type", width: 120, render: (v: FieldType) =>
                FIELD_TYPES.find((x) => x.value === v)?.label ?? v },
              { title: "加入模板", width: 100, render: (_: unknown, f: CustomFieldItem) => (
                <Checkbox checked={Boolean(picked[f.id])}
                  onChange={(e) => setPicked((prev) => {
                    const next = { ...prev };
                    if (e.target.checked) next[f.id] = { required: false };
                    else delete next[f.id];
                    return next;
                  })} />
              ) },
              { title: "必填", width: 80, render: (_: unknown, f: CustomFieldItem) => (
                <Checkbox disabled={!picked[f.id]} checked={Boolean(picked[f.id]?.required)}
                  onChange={(e) => setPicked((prev) => ({ ...prev, [f.id]: { required: e.target.checked } }))} />
              ) },
            ]} />
        </div>
        {err && <Alert type="error" showIcon data-testid="pm-template-error" message={err} />}
      </Space>
    </Modal>
  );
}

function FieldModal({ open, projectId, scene, editing, onClose, onSaved }: {
  open: boolean;
  projectId: string;
  scene: Scene;
  editing: CustomFieldItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [type, setType] = useState<FieldType>("input");
  const [description, setDescription] = useState("");
  const [options, setOptions] = useState<FieldDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setName(editing?.name ?? "");
    setKey(editing?.field_key ?? "");
    setType(editing?.type ?? "input");
    setDescription(editing?.description ?? "");
    setOptions((editing?.options ?? []).map((o) => ({ value: o.value, label: o.label })));
  }, [open, editing]);

  const showOptions = OPTION_TYPES.has(type);
  async function submit(): Promise<void> {
    if (!name.trim() || !key.trim()) { message.warning("名称与 field_key 必填"); return; }
    if (showOptions && options.length === 0) { message.warning("选项型字段至少一个选项"); return; }
    setBusy(true);
    setErr(null);
    const opts: FieldOption[] = showOptions
      ? options.filter((o) => o.value.trim() && o.label.trim())
        .map((o, i) => ({ value: o.value.trim(), label: o.label.trim(), sort: i }))
      : [];
    try {
      if (editing) {
        await projectMetaApi.updateField(projectId, editing.id, {
          project_id: projectId, name: name.trim(), description, options: opts,
        });
      } else {
        await projectMetaApi.createField({
          project_id: projectId, scene, name: name.trim(), field_key: key.trim(),
          type, description, options: opts,
        });
      }
      message.success(editing ? "字段已保存" : "字段已创建");
      onSaved();
      onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} width={640} centered destroyOnHidden
      title={editing ? "编辑字段：" + editing.name : "新建自定义字段"}
      okText="保存" cancelText="取消" okButtonProps={{ loading: busy, "data-testid": "pm-field-save" }}
      onOk={() => void submit()}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input data-testid="pm-field-name" maxLength={120} value={name}
            onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>field_key（项目内唯一，创建后不可改）</Typography.Text>
          <Input data-testid="pm-field-key" maxLength={64} value={key} disabled={Boolean(editing)}
            placeholder="如 severity" onChange={(e) => setKey(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>类型（创建后不可改）</Typography.Text>
          <Select data-testid="pm-field-type" style={{ width: "100%" }} value={type}
            disabled={Boolean(editing)} onChange={(v) => setType(v as FieldType)}
            options={FIELD_TYPES} />
        </div>
        <div>
          <Typography.Text strong>描述</Typography.Text>
          <Input.TextArea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {showOptions && (
          <div>
            <Typography.Text strong>选项</Typography.Text>
            <Space direction="vertical" size={6} style={{ width: "100%", marginTop: 6 }}>
              {options.map((o, i) => (
                <Space key={i} style={{ width: "100%" }}>
                  <Input placeholder="value" value={o.value} style={{ width: 160 }}
                    onChange={(e) => setOptions((prev) => prev.map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x))} />
                  <Input placeholder="显示文案" value={o.label} style={{ width: 220 }}
                    onChange={(e) => setOptions((prev) => prev.map((x, j) =>
                      j === i ? { ...x, label: e.target.value } : x))} />
                  <Button danger size="small" onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}>
                    删除
                  </Button>
                </Space>
              ))}
              <Button size="small" icon={<PlusOutlined />} data-testid="pm-field-add-option"
                onClick={() => setOptions((prev) => [...prev, { value: "", label: "" }])}>
                加选项
              </Button>
            </Space>
          </div>
        )}
        {err && <Alert type="error" showIcon data-testid="pm-field-error" message={err} />}
      </Space>
    </Modal>
  );
}

export default function ProjectMetaTab({ projectId, canCreate, canUpdate, canDelete,
  canSaveView, canDeleteView }: {
  projectId: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  /** D247：视图写入位（search:view:create/delete）——READONLY 不摆保存/删除视图按钮。 */
  canSaveView: boolean;
  canDeleteView: boolean;
}) {
  const [scene, setScene] = useState<Scene>("bug");
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [fields, setFields] = useState<CustomFieldItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tplModal, setTplModal] = useState<{ editing: TemplateDetail | null } | null>(null);
  const [fieldModal, setFieldModal] = useState<{ editing: CustomFieldItem | null } | null>(null);
  // 高级搜索条件组 + 列设置偏好：两表各一套（view_type 不同，视图也分属两页）。
  const [tplFilter, setTplFilter] = useState<FilterDoc>(emptyFilter());
  const [fieldFilter, setFieldFilter] = useState<FilterDoc>(emptyFilter());
  const [tplColPref, setTplColPref] = useColumnPrefs(
    "template", TEMPLATE_COL_CHOICES.map((c) => c.key));
  const [fieldColPref, setFieldColPref] = useColumnPrefs(
    "custom_field", FIELD_COL_CHOICES.map((c) => c.key));

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 空条件不拼 filter 参数（URL 里不出现骗人的 filter=），非空才交给后端编 WHERE。
      const [t, f] = await Promise.all([
        projectMetaApi.templates(projectId, scene,
          isFilterEmpty(tplFilter) ? undefined : JSON.stringify(tplFilter)),
        projectMetaApi.fields(projectId, scene,
          isFilterEmpty(fieldFilter) ? undefined : JSON.stringify(fieldFilter)),
      ]);
      setTemplates(t.items);
      setFields(f.items);
    } catch (e) {
      setTemplates([]);
      setFields([]);
      setLoadError(e instanceof ApiErr ? e.message : "模板/字段加载失败");
    } finally { setLoading(false); }
  }, [projectId, scene, tplFilter, fieldFilter]);
  useEffect(() => { void load(); }, [load]);

  async function editTemplate(t: TemplateItem): Promise<void> {
    try {
      const d = await projectMetaApi.template(projectId, t.id);
      setTplModal({ editing: d });
    } catch { /* client 已 toast */ }
  }

  async function setDefault(t: TemplateItem): Promise<void> {
    try {
      await projectMetaApi.setDefaultTemplate(projectId, t.id);
      message.success("已设为默认");
      await load();
    } catch { /* client 已 toast */ }
  }

  function removeTemplate(t: TemplateItem): void {
    Modal.confirm({
      centered: true, title: "删除模板「" + t.name + "」？",
      content: "系统/默认/被缺陷引用的模板会被后端拒绝（409），前端不预判。",
      okText: "删除", cancelText: "取消", okButtonProps: { danger: true },
      onOk: async () => {
        await projectMetaApi.deleteTemplate(projectId, t.id);
        message.success("已删除");
        await load();
      },
    });
  }

  function removeField(f: CustomFieldItem): void {
    Modal.confirm({
      centered: true, title: "删除字段「" + f.name + "」？",
      content: "被模板引用或已有值行会被后端拒绝（409）。",
      okText: "删除", cancelText: "取消", okButtonProps: { danger: true },
      onOk: async () => {
        await projectMetaApi.deleteField(projectId, f.id);
        message.success("已删除");
        await load();
      },
    });
  }

  // key 与 *_COL_CHOICES 逐字一致——applyColumnPrefs 只按 key 过滤。
  const templateCols: ColumnsType<TemplateItem> = applyColumnPrefs([
    { title: "名称", key: "name", render: (_: unknown, t: TemplateItem) => (
      <Space size={6} wrap>
        <span data-testid="pm-template-name-cell">{t.name}</span>
        {t.internal && <Tag>系统</Tag>}
        {t.is_default && <Tag color="blue">默认</Tag>}
      </Space>
    ) },
    { title: "字段数", key: "field_count", dataIndex: "field_count", width: 80 },
    { title: "更新时间", key: "at", width: 140, render: (_: unknown, t: TemplateItem) => (
      <Typography.Text type="secondary" className="tp-text-sm">
        {fmtTime(t.updated_at, { seconds: false }) ?? "—"}
      </Typography.Text>
    ) },
    { title: "", key: "ops", width: 210, render: (_: unknown, t: TemplateItem) => (
      <Space size={4} wrap>
        {canUpdate && (
          <Button size="small" onClick={() => void editTemplate(t)}>编辑</Button>
        )}
        {canUpdate && !t.is_default && (
          <Button size="small" onClick={() => void setDefault(t)}>设默认</Button>
        )}
        {/* 系统/默认模板删不掉（后端 409）；摆一个必然被拒的钮就是假门 */}
        {canDelete && !t.internal && !t.is_default && (
          <Button size="small" danger onClick={() => removeTemplate(t)}>删除</Button>
        )}
      </Space>
    ) },
  ], tplColPref);

  const fieldCols: ColumnsType<CustomFieldItem> = applyColumnPrefs([
    { title: "名称", key: "name", dataIndex: "name" },
    { title: "field_key", key: "field_key", dataIndex: "field_key", width: 130 },
    { title: "类型", key: "type", dataIndex: "type", width: 110,
      render: (v: FieldType) => FIELD_TYPES.find((x) => x.value === v)?.label ?? v },
    { title: "选项", key: "opts", width: 70,
      render: (_: unknown, f: CustomFieldItem) => f.options.length || "—" },
    { title: "模板引用", key: "template_count", dataIndex: "template_count", width: 90 },
    { title: "", key: "ops", width: 130, render: (_: unknown, f: CustomFieldItem) => (
      <Space size={4}>
        {canUpdate && (
          <Button size="small" onClick={() => setFieldModal({ editing: f })}>编辑</Button>
        )}
        {canDelete && (
          <Button size="small" danger onClick={() => removeField(f)}>删除</Button>
        )}
      </Space>
    ) },
  ], fieldColPref);

  return (
    <div data-testid="project-meta-tab">
      <Tabs
        size="small"
        activeKey={scene}
        onChange={(k) => setScene(k as Scene)}
        items={SCENES.map((s) => ({ key: s.value, label: s.label }))}
        style={{ marginBottom: 8 }}
      />
      {loadError && <Alert type="error" showIcon data-testid="pm-load-error" message={loadError} />}
      <Space align="start" size={16} style={{ width: "100%" }} wrap>
        <div style={{ flex: "1 1 420px", minWidth: 360 }}>
          <Space style={{ marginBottom: 8 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>模板</Typography.Title>
            {canCreate && (
              <Button size="small" icon={<PlusOutlined />} data-testid="pm-template-new"
                onClick={() => setTplModal({ editing: null })}>
                新建模板
              </Button>
            )}
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          </Space>
          <ListToolbar projectId={projectId} viewType="template" filter={tplFilter}
            onFilterChange={setTplFilter} allColumns={TEMPLATE_COL_CHOICES}
            columnPref={tplColPref} onColumnPrefChange={setTplColPref}
            canSaveView={canSaveView} canDeleteView={canDeleteView}
            valueOptions={{ internal: BOOL_INTERNAL,
              is_default: [{ value: true, label: "默认" }, { value: false, label: "非默认" }] }} />
          <Table size="small" rowKey="id" loading={loading} pagination={false} dataSource={templates}
            locale={{ emptyText: "还没有模板" }} columns={templateCols} />
        </div>
        <div style={{ flex: "1 1 420px", minWidth: 360 }}>
          <Space style={{ marginBottom: 8 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>自定义字段</Typography.Title>
            {canCreate && (
              <Button size="small" icon={<PlusOutlined />} data-testid="pm-field-new"
                onClick={() => setFieldModal({ editing: null })}>
                新建字段
              </Button>
            )}
          </Space>
          <ListToolbar projectId={projectId} viewType="custom_field" filter={fieldFilter}
            onFilterChange={setFieldFilter} allColumns={FIELD_COL_CHOICES}
            columnPref={fieldColPref} onColumnPrefChange={setFieldColPref}
            canSaveView={canSaveView} canDeleteView={canDeleteView}
            valueOptions={{ type: TYPE_OPTIONS, internal: BOOL_INTERNAL }} />
          <Table size="small" rowKey="id" loading={loading} pagination={false} dataSource={fields}
            locale={{ emptyText: "还没有自定义字段" }} columns={fieldCols} />
        </div>
      </Space>

      <TemplateModal open={tplModal !== null} projectId={projectId} scene={scene}
        editing={tplModal?.editing ?? null} allFields={fields}
        onClose={() => setTplModal(null)} onSaved={() => void load()} />
      <FieldModal open={fieldModal !== null} projectId={projectId} scene={scene}
        editing={fieldModal?.editing ?? null}
        onClose={() => setFieldModal(null)} onSaved={() => void load()} />
    </div>
  );
}
