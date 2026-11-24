// 缺陷管理列表（D191，补 MeterSphere 测试跟踪主链路里我们一直缺的那一格）。
//
// 后端契约：app/modules/defect/services.py（24 个 @service）+ D190 对账文档。
// 口径三条，写错就是假门：
// ① 写入口按权限**隐藏不是禁用**（settings.spec 钉的手感）：无 create 不渲染「新建缺陷」，
//    无 delete 不渲染删除/回收站彻底删除，无 update 不渲染恢复与关注。
// ② 回收站是同一张列表的 recycled 谓词（后端把 MS 的 /bug/page 与 /bug/trash/page 折叠成
//    一个 defect_list），删除人/删除时间两列只在回收站视图渲染——正常行标「删除人」就是说谎。
// ③ ID 列是项目内人读编号 `num`（D192 起由 project_num_next 取号，非 id 前缀）；
//    状态词表与转移边以项目状态图为准（D267），拉不到图才退回内置五态。
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Checkbox, Drawer, Input, Modal, Select, Space, Tag, Tooltip, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined, StarOutlined } from "../ui/icons";
import { tpv } from "../theme";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import EditorField from "../ui/EditorField";
import StateView from "../ui/StateView";
import { FilterBar } from "../ui/Toolbar";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get } from "../api/client";
import { defectApi, defectFlowApi, flowAllowed, flowLabel, isDefectFlow, severityMeta, statusMeta,
  DEFECT_STATUSES, SEVERITY_OPTIONS,
  type DefectFlow, type DefectRow } from "../api/defect";
import { projectMetaApi, type TemplateDetail, type TemplateField, type TemplateItem } from "../api/projectMeta";
import CustomFieldForm from "../ui/CustomFields";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import { applyColumnPrefs, emptyFilter, isFilterEmpty } from "../shared/listFilters";
import type { ColumnChoice, FilterDoc } from "../shared/listFilters";

type MemberRow = { user_id: string; account: string | null; name: string | null };
const PRIO_COLOR: Record<string, string> = { P0: "red", P1: "volcano", P2: "blue", P3: "default" };
// 默认词表兜底（D267）：拿到项目状态图后由组件内 statusOptions 覆盖；
// 拉图失败也不许把下拉变成空的——退回内置五态，写路径仍由后端把关。
const DEFAULT_STATUS_OPTIONS = DEFECT_STATUSES.map((v) => ({ value: v, label: statusMeta(v).label }));

// D216：列设置面板要露的列（key 与 columns 的 key 逐字一致）。回收站视图独有的
// 「删除人/删除时间」不在清单里——它们在正常视图不存在，跟着视图走比跟着偏好走更诚实。
const DEFECT_COL_CHOICES: ColumnChoice[] = [
  { key: "num", label: "ID" },
  { key: "title", label: "标题" },
  { key: "status", label: "状态" },
  { key: "priority", label: "优先级" },
  { key: "severity", label: "严重程度" },
  { key: "source", label: "缺陷来源" },
  { key: "tags", label: "标签" },
  { key: "custom", label: "自定义字段" },
  { key: "handle", label: "处理人" },
  { key: "links", label: "关联用例" },
  { key: "comments", label: "评论" },
  { key: "follow", label: "关注" },
  { key: "updby", label: "更新人" },
  { key: "updat", label: "更新时间" },
];

function DefectFormDrawer({ open, editing, projectId, members, flow, statusOptions, onClose, onSaved }: {
  open: boolean;
  editing: DefectRow | null;
  projectId: string;
  members: MemberRow[];
  flow: DefectFlow | null;
  statusOptions: { value: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("P2");
  // D280：来源（自由文本，空串 = 未填）与严重程度（null = 未评估）
  const [source, setSource] = useState("");
  const [severity, setSeverity] = useState<string | null>(null);
  // D289：MS v2 新建表单就带状态下拉；编辑时只给状态图允许的去向（同态放行）。
  const [status, setStatus] = useState("new");
  const [handle, setHandle] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [tpl, setTpl] = useState<TemplateDetail | null>(null);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [tplLoading, setTplLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const flowStart = flow?.start_key ?? "new";

  const loadTemplate = useCallback(async (id: string, base: Record<string, unknown>): Promise<void> => {
    if (!id) { setTpl(null); return; }
    setTplLoading(true);
    try {
      const d = await projectMetaApi.template(projectId, id);
      setTpl(d);
      const next: Record<string, unknown> = { ...base };
      for (const f of d.fields) {
        if (next[f.field_id] === undefined && f.default_value !== null && f.default_value !== undefined) {
          next[f.field_id] = f.default_value;
        }
      }
      setCustom(next);
    } catch {
      setTpl(null);
    } finally { setTplLoading(false); }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? "");
    setDescription(editing?.description ?? "");
    setPriority(editing?.priority ?? "P2");
    setSource(editing?.source ?? "");
    setSeverity(editing?.severity ?? null);
    setStatus(editing?.status ?? flowStart);
    setHandle(editing?.handle_user_id ?? null);
    setTags(editing?.tags ?? []);
    setErr(null);
    setTemplates([]);
    setTpl(null);
    setCustom({});
    void (async () => {
      try {
        const r = await projectMetaApi.templates(projectId, "bug");
        setTemplates(r.items);
        const chosen = editing?.template_id
          ?? r.items.find((t) => t.is_default)?.id
          ?? r.items[0]?.id
          ?? "";
        setTemplateId(chosen);
        await loadTemplate(chosen, editing?.custom_fields ?? {});
      } catch (e) {
        setErr(e instanceof ApiErr ? e.message : "模板加载失败");
      }
    })();
  }, [open, editing, projectId, loadTemplate, flowStart]);

  // 编辑时只列「当前态 + 允许的去向」：状态图的非法边不给点，免得选完吃 409。
  const allowedKeys = editing ? flowAllowed(flow, editing.status) : null;
  const statusChoices = allowedKeys
    ? statusOptions.filter((o) => allowedKeys.includes(o.value))
    : statusOptions;

  async function submit(): Promise<void> {
    if (!title.trim()) { message.warning("缺陷标题必填"); return; }
    if (!templateId) { message.warning("还没有可用模板（刷新项目设置）"); return; }
    if (!status) { message.warning("缺陷状态必填"); return; }
    setBusy(true);
    setErr(null);
    try {
      if (editing) {
        await defectApi.update(editing.id, {
          project_id: projectId, title: title.trim(), description,
          description_set: true, priority, status,
          handle_user_id: handle, handle_user_set: true, tags,
          // D280：两个可清空位都带哨兵——清空来源/把严重程度退回未评估必须发得出去
          source: source.trim() || null, source_set: true,
          severity, severity_set: true,
          template_id: templateId, custom_fields: custom,
        });
      } else {
        await defectApi.create({
          project_id: projectId, title: title.trim(), description, priority, status,
          source: source.trim() || null, severity,
          handle_user_id: handle, tags, template_id: templateId, custom_fields: custom,
        });
      }
      message.success(editing ? "已保存" : "缺陷已创建");
      onSaved();
      onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Drawer open={open} onClose={onClose} width="100%" destroyOnHidden
      className="tp-record-drawer"
      title={editing ? "编辑缺陷：" + editing.title : "新建缺陷"}
      styles={{ body: { padding: 0, overflow: "hidden" } }}
      footer={
        <div className="tp-record-editor__footer">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={busy} data-testid="defect-save" onClick={() => void submit()}>
            保存
          </Button>
        </div>
      }>
      <div className="tp-record-editor tp-record-editor--side-right">
        <main className="tp-record-editor__main">
          <section className="tp-record-editor__pane tp-record-editor__pane--fill">
            <header className="tp-record-editor__pane-head">
              <div className="tp-record-editor__pane-title">缺陷内容</div>
              <span className="tp-record-editor__pane-sub">复现步骤、期望 / 实际结果</span>
            </header>
            <div className="tp-case-form">
              <EditorField label="标题" required>
                <Input data-testid="defect-field-title" maxLength={255} value={title} autoFocus
                  placeholder="如「登录后偶发 500」" onChange={(e) => setTitle(e.target.value)} />
              </EditorField>
              <div className="tp-field tp-field--grow">
                <div className="tp-field-label">
                  <span>缺陷内容（Markdown）</span>
                  <span className="tp-field-hint-inline">用空行分段；代码块用 ```</span>
                </div>
                <Input.TextArea className="tp-defect-content" data-testid="defect-field-description"
                  value={description} placeholder={"## 复现步骤\n1. ...\n\n## 期望结果\n...\n\n## 实际结果\n..."}
                  onChange={(e) => setDescription(e.target.value)} />
              </div>
              {err && <Alert type="error" showIcon data-testid="defect-save-error" message={err} />}
            </div>
          </section>
        </main>
        <aside className="tp-record-editor__side" data-testid="defect-form-side">
          <div className="tp-record-editor__side-head">
            <div className="tp-record-editor__pane-title">缺陷属性</div>
            <div className="tp-record-editor__pane-sub">状态、严重程度与处理人</div>
          </div>
          <div className="tp-record-editor__side-body">
            <EditorField label="模板" hint="编辑时不可换模板（字段定义会变）">
              <Select data-testid="defect-field-template" style={{ width: "100%" }} value={templateId || undefined}
                loading={tplLoading} disabled={Boolean(editing)}
                placeholder="选择模板"
                onChange={(v) => { setTemplateId(String(v)); void loadTemplate(String(v), {}); }}
                options={templates.map((t) => ({ value: t.id, label: t.name + (t.is_default ? "（默认）" : "") }))} />
            </EditorField>
            <EditorField label="严重程度" hint="可留空 = 未评估（不伪造 P0）">
              <Select data-testid="defect-field-severity" style={{ width: "100%" }} allowClear
                value={severity ?? undefined} placeholder="未评估"
                onChange={(v) => setSeverity(v ?? null)} options={SEVERITY_OPTIONS} />
            </EditorField>
            <EditorField label="处理人">
              <Select data-testid="defect-field-handle" allowClear style={{ width: "100%" }}
                value={handle ?? undefined} placeholder="未指派" onChange={(v) => setHandle(v ?? null)}
                options={members.map((m) => ({ value: m.user_id, label: m.name ?? m.account ?? m.user_id }))} />
            </EditorField>
            <EditorField label="状态" required hint={editing ? "只列当前状态与状态图允许的去向" : "默认落项目状态图的起始态"}>
              <Select data-testid="defect-field-status" style={{ width: "100%" }}
                value={status || undefined} onChange={setStatus} options={statusChoices} />
            </EditorField>
            <EditorField label="优先级">
              <Select data-testid="defect-field-priority" value={priority} style={{ width: "100%" }}
                onChange={setPriority}
                options={["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v }))} />
            </EditorField>
            <EditorField label="缺陷来源">
              <Input data-testid="defect-field-source" maxLength={64}
                value={source} placeholder="如「客户反馈」" onChange={(e) => setSource(e.target.value)} />
            </EditorField>
            <EditorField label="标签">
              <Select data-testid="defect-field-tags" mode="tags" style={{ width: "100%" }}
                value={tags} onChange={setTags} maxCount={20} tokenSeparators={[",", "，"]}
                placeholder="回车创建标签，最多 20 个" />
            </EditorField>
            <EditorField label="自定义字段">
              {tpl ? (
                <CustomFieldForm fields={tpl.fields} values={custom} onChange={setCustom}
                  members={members} disabled={tplLoading} />
              ) : (
                <Typography.Text type="secondary" className="tp-text-sm">
                  {tplLoading ? "模板字段加载中…" : "请选择模板"}
                </Typography.Text>
              )}
            </EditorField>
          </div>
          <div className="tp-record-editor__side-foot">
            关联用例 / 附件 / 评论在缺陷详情页维护；这里只改缺陷本体。
          </div>
        </aside>
      </div>
    </Drawer>
  );
}

function DefectsList() {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canCreate = can(perms, "defect:defect:create");
  const canUpdate = can(perms, "defect:defect:update");
  const canDelete = can(perms, "defect:defect:delete");

  const [rows, setRows] = useState<DefectRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [fieldMeta, setFieldMeta] = useState<Record<string, TemplateField>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inRecycled, setInRecycled] = useState(false);
  const [shownRecycled, setShownRecycled] = useState(false);
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  // 输入草稿与已应用筛选分开：load 只依赖已应用值，否则每敲一个字都发一条列表请求。
  const [kwDraft, setKwDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<string | undefined>();
  const [priority, setPriority] = useState<string | undefined>();
  const [tagDraft, setTagDraft] = useState("");
  const [tag, setTag] = useState("");
  const [followedOnly, setFollowedOnly] = useState(false);
  // D267：项目状态图（读位 defect:defect:read，四枚内置角色都盖得住；拉不到就退回默认词表）。
  const [flow, setFlow] = useState<DefectFlow | null>(null);
  const statusOptions = flow
    ? flow.statuses.map((s) => ({ value: s.key, label: s.name }))
    : DEFAULT_STATUS_OPTIONS;
  // D216：高级搜索条件 + 列偏好。列偏好键 defect，与 filter-meta 的 view_type 同源。
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const [colPref, setColPref] = useColumnPrefs("defect", DEFECT_COL_CHOICES.map((c) => c.key));
  // 模板下拉候选（高级搜索的 template_id 值控件要用；它和「自定义字段列」共用同一次
  // templates 拉取，不为一个筛选再拉第二遍）。
  const [templateOpts, setTemplateOpts] = useState<Option[]>([]);
  const [selected, setSelected] = useState<string[]>([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DefectRow | null>(null);
  const [purge, setPurge] = useState<DefectRow | null>(null);
  const [purgeTitle, setPurgeTitle] = useState("");
  const [purging, setPurging] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchTags, setBatchTags] = useState<string[]>([]);
  const [batchAction, setBatchAction] = useState<"add_tags" | "replace_tags">("add_tags");
  const [batchBusy, setBatchBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await defectApi.list({
        project_id: pid, current, size: pageSize, recycled: inRecycled,
        status, priority, keyword: keyword.trim() || undefined, tag: tag.trim() || undefined,
        followed_by_me: followedOnly || undefined,
        // D216：空条件不上线（不是 filter=），非空才拼条件组 JSON
        filter: isFilterEmpty(advFilter) ? undefined : JSON.stringify(advFilter),
      });
      setRows(r.items);
      setTotal(r.total);
      setShownRecycled(inRecycled);
      setSelected([]);
    } catch (e) {
      // 失败不拿上一批行冒充当前页（页码模式下 current 变了，旧行与新页码同屏就是两套真相）。
      setRows([]);
      setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "缺陷列表加载失败");
    } finally { setLoading(false); }
  }, [pid, current, pageSize, inRecycled, status, priority, keyword, tag, followedOnly, advFilter]);
  useEffect(() => { void load(); }, [load]);

  // D267：状态图只随项目变；拉失败静默回落默认词表（列表/表单照常可用）。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const f = await defectFlowApi.get(pid);
        if (alive) setFlow(isDefectFlow(f) ? f : null);
      } catch {
        if (alive) setFlow(null);
      }
    })();
    return () => { alive = false; };
  }, [pid]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await get<{ items: MemberRow[] }>("/projects/" + encodeURIComponent(pid) + "/members",
          { silent: true });
        setMembers(r.items);
      } catch { setMembers([]); }
    })();
  }, [pid]);

  // 列表的「自定义字段」列要字段名，不是 field id：一次拉齐本场景所有模板的字段。
  useEffect(() => {
    void (async () => {
      try {
        const r = await projectMetaApi.templates(pid, "bug");
        setTemplateOpts(r.items.map((t) => ({ value: t.id, label: t.name })));
        const details = await Promise.all(r.items.map((t) =>
          projectMetaApi.template(pid, t.id).catch(() => null)));
        const map: Record<string, TemplateField> = {};
        for (const d of details) {
          if (!d) continue;
          for (const f of d.fields) map[f.field_id] = f;
        }
        setFieldMeta(map);
      } catch { setFieldMeta({}); }
    })();
  }, [pid]);

  const customText = (r: DefectRow): string => {
    const entries = Object.entries(r.custom_fields ?? {});
    if (entries.length === 0) return "—";
    return entries.map(([fid, val]) => {
      const f = fieldMeta[fid];
      const label = f?.name ?? fid.slice(0, 8);
      let shown: string;
      if (Array.isArray(val)) shown = val.join("、");
      else if (f?.options?.length && typeof val === "string") {
        shown = f.options.find((o) => o.value === val)?.label ?? val;
      } else shown = String(val ?? "");
      return label + "：" + shown;
    }).join("；");
  };

  const resetPage = (fn: () => void): void => { fn(); setCurrent(1); };
  const toggleRecycled = (): void => { setInRecycled((v) => !v); setCurrent(1); };
  // D216：高级搜索是第八类筛选，与快捷筛选同一条「改条件必回第 1 页」纪律
  const patchAdv = (next: FilterDoc): void => { setAdvFilter(next); setCurrent(1); };

  // 高级搜索的候选值全部复用页面已在手的数据（成员/状态词表/优先级/模板），
  // 不为一个下拉再拉第二遍。未知候选（如已删模板 id）仍可真值精确匹配。
  const filterValueOptions: Record<string, Option[]> = {
    status: statusOptions,
    priority: ["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v })),
    // D280：严重程度枚举（中文标签），来源是自由文本不需要候选
    severity: SEVERITY_OPTIONS,
    handle_user_id: members.map((m) => ({ value: m.user_id, label: m.name ?? m.account ?? m.user_id })),
    template_id: templateOpts,
  };

  async function toggleFollow(r: DefectRow): Promise<void> {
    try {
      if (r.followed) await defectApi.unfollow(pid, r.id);
      else await defectApi.follow(pid, r.id);
      await load();
    } catch { /* client 已 toast */ }
  }

  async function removeOne(r: DefectRow): Promise<void> {
    try {
      await defectApi.remove(pid, r.id);
      message.success("已放入回收站");
      await load();
    } catch { /* client 已 toast */ }
  }

  async function restoreOne(r: DefectRow): Promise<void> {
    try {
      await defectApi.restore(pid, r.id);
      message.success("已恢复");
      await load();
    } catch { /* client 已 toast */ }
  }

  async function submitPurge(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      await defectApi.purge(pid, purge.id, purgeTitle);
      message.success("已彻底删除");
      setPurge(null); setPurgeTitle("");
      await load();
    } catch { /* title_mismatch 等保持弹窗重试 */ }
    finally { setPurging(false); }
  }

  async function submitBatch(): Promise<void> {
    setBatchBusy(true);
    try {
      await defectApi.batchUpdateTags(pid, selected, batchAction, batchTags);
      message.success("已更新 " + selected.length + " 个缺陷的标签");
      setBatchOpen(false);
      await load();
    } catch { /* client 已 toast */ }
    finally { setBatchBusy(false); }
  }

  async function exportCsv(): Promise<void> {
    try {
      // 回收站视图没有导出入口语义：后端只导非回收缺陷，带 selected 只会得到 0 条 + 一条
      // 「未导出」提示；这里回到「全量非回收」，把按钮的真实能力说清楚。
      const out = await defectApi.exportCsv(pid, !inRecycled && selected.length ? selected : undefined);
      const blob = new Blob([out.content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = out.filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      message.success("已导出 " + out.exported + " 条" + (out.notes.length ? "（有未导出项，见提示）" : ""));
      if (out.notes.length) message.warning(out.notes.join("；"));
    } catch { /* client 已 toast */ }
  }

  const memberName = (id: string | null): string => {
    if (!id) return "—";
    return members.find((m) => m.user_id === id)?.name ?? "—";
  };

  return (
    <div className="tp-fill tp-fill-body">
      <div style={{ flex: "0 0 auto" }}>
        {/* D216：D47-a 三件套铺到缺陷页。第二行是本页既有快捷筛选，两行并存不互相替代：
            高级搜索管任意组合（含编号区间/时间区间），快捷筛选管常用一刀。 */}
        <ListToolbar
          projectId={pid} viewType="defect"
          filter={advFilter} onFilterChange={patchAdv}
          valueOptions={filterValueOptions}
          allColumns={DEFECT_COL_CHOICES} columnPref={colPref} onColumnPrefChange={setColPref}
          canSaveView={can(perms, "search:view:create")}
          canDeleteView={can(perms, "search:view:delete")}
        />
        <FilterBar actions={(
          <>
            {!inRecycled && canCreate && (
              <Button type="primary" icon={<PlusOutlined />} data-testid="defect-new"
                onClick={() => { setEditing(null); setFormOpen(true); }}>
                新建缺陷
              </Button>
            )}
            <Button icon={<ReloadOutlined />} data-testid="defect-refresh" onClick={() => void load()}>
              刷新
            </Button>
            <Button data-testid="defect-export" onClick={() => void exportCsv()}>导出 CSV</Button>
            <Button data-testid="defect-recycled" type={inRecycled ? "primary" : "default"}
              onClick={toggleRecycled}>
              {inRecycled ? "退出回收站" : "♻ 回收站"}
            </Button>
          </>
        )}>
          <Space wrap size={8}>
            <Input.Search data-testid="defect-filter-keyword" allowClear placeholder="标题/描述关键词"
              style={{ width: 200 }} value={kwDraft}
              onChange={(e) => setKwDraft(e.target.value)}
              onSearch={() => resetPage(() => setKeyword(kwDraft.trim()))} />
            <Select data-testid="defect-filter-status" allowClear placeholder="状态" style={{ width: 120 }}
              value={status} options={statusOptions}
              onChange={(v) => resetPage(() => setStatus(v))} />
            <Select data-testid="defect-filter-priority" allowClear placeholder="优先级" style={{ width: 100 }}
              value={priority}
              options={["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v }))}
              onChange={(v) => resetPage(() => setPriority(v))} />
            <Input.Search data-testid="defect-filter-tag" allowClear placeholder="标签" style={{ width: 140 }}
              value={tagDraft} onChange={(e) => setTagDraft(e.target.value)}
              onSearch={() => resetPage(() => setTag(tagDraft.trim()))} />
            <Checkbox data-testid="defect-filter-followed" checked={followedOnly}
              onChange={(e) => resetPage(() => setFollowedOnly(e.target.checked))}>
              我关注的
            </Checkbox>
          </Space>
        </FilterBar>
        {loadError && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="defect-load-error"
            message="缺陷列表加载失败" description={loadError} />
        )}
        {selected.length > 0 && !inRecycled && (
          <Space style={{ marginBottom: 8 }} data-testid="defect-batchbar">
            <Typography.Text type="secondary">已选 {selected.length} 项</Typography.Text>
            <Button size="small" data-testid="defect-batch-tags"
              onClick={() => { setBatchTags([]); setBatchAction("add_tags"); setBatchOpen(true); }}>
              批量编辑标签
            </Button>
            {canDelete && (
              <Button size="small" danger data-testid="defect-batch-delete"
                onClick={() => {
                  Modal.confirm({
                    centered: true, title: "把选中的 " + selected.length + " 个缺陷放入回收站？",
                    content: "软删，可随时恢复。", okText: "放入回收站", cancelText: "取消",
                    okButtonProps: { danger: true },
                    onOk: async () => {
                      await defectApi.batchDelete(pid, selected);
                      message.success("已放入回收站");
                      await load();
                    },
                  });
                }}>
                批量删除
              </Button>
            )}
          </Space>
        )}
      </div>

      <AdminTable<DefectRow> rowKey="id" loading={loading} dataSource={rows} pagination={false}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys.map(String)),
        }}
        locale={{ emptyText: loadError ? (
          <StateView kind="error" title="缺陷列表没取到，以上方的加载失败提示为准"
            action={<Button size="small" onClick={() => void load()}>重试</Button>} />
        ) : (
          <StateView title={shownRecycled ? "回收站是空的"
            : canCreate ? "还没有缺陷，点「新建缺陷」开始记录" : "还没有缺陷（你没有新建权限）"} />
        ) }}
        columns={applyColumnPrefs([
          { title: "ID", key: "num", width: 96, render: (_, r) => (
            <Typography.Text type="secondary" className="tp-text-sm" data-testid="defect-row-id">
              {r.num}
            </Typography.Text>) },
          { title: "标题", dataIndex: "title", key: "title", width: 260, render: (v: string, r) => (
            // 回收站行不是链接：defect_get 对已回收缺陷回 404（detail 只服务正常行）。
            // 按**行自己**的 recycled 判，而不是视图标记——在途/失败窗口里两者可能不同步。
            r.recycled
              ? <span data-testid="defect-row-title">{v}</span>
              : (
                <Typography.Link data-testid="defect-row-title" onClick={() => nav("/defects/" + r.id)}>
                  {v}
                </Typography.Link>)
          ) },
          { title: "状态", dataIndex: "status", key: "status", width: 96, render: (v: string) => {
            const m = statusMeta(v);
            return <Tag color={m.color} data-testid="defect-row-status">{flowLabel(flow, v)}</Tag>;
          } },
          { title: "优先级", dataIndex: "priority", key: "priority", width: 80, render: (v: string) => (
            <Tag color={PRIO_COLOR[v] ?? "default"}>{v}</Tag>) },
          // D280：严重程度（null = 未评估画「—」，不冒充「一般」）与缺陷来源
          { title: "严重程度", dataIndex: "severity", key: "severity", width: 96,
            render: (v: string | null) => (v
              ? <Tag color={severityMeta(v).color}
                  data-testid="defect-row-severity">{severityMeta(v).label}</Tag>
              : <span data-testid="defect-row-severity">—</span>) },
          { title: "缺陷来源", dataIndex: "source", key: "source", width: 130, ellipsis: true,
            render: (v: string | null) => (
              <span data-testid="defect-row-source">{v ?? "—"}</span>) },
          { title: "标签", dataIndex: "tags", key: "tags", width: 160, render: (v: string[]) => (
            v.length ? v.map((t) => <Tag key={t}>{t}</Tag>) : <span>—</span>) },
          { title: "自定义字段", key: "custom", width: 200, render: (_, r) => (
            <Typography.Text className="tp-text-sm" data-testid="defect-row-custom">
              {customText(r)}
            </Typography.Text>) },
          { title: "处理人", key: "handle", width: 110, render: (_, r) => (
            <span>{r.handle_user_name ?? memberName(r.handle_user_id)}</span>) },
          { title: "关联用例", dataIndex: "link_count", key: "links", width: 90, align: "center" },
          { title: "评论", dataIndex: "comment_count", key: "comments", width: 70, align: "center" },
          { title: "关注", key: "follow", width: 90, render: (_, r) => (
            canUpdate ? (
              <Tooltip title={r.followed ? "取消关注" : "关注"}>
                <Button type="text" size="small" data-testid="defect-row-follow"
                  icon={<StarOutlined />}
                  style={r.followed ? { color: tpv.primary[600] } : undefined}
                  onClick={() => void toggleFollow(r)}>
                  {r.follower_count}
                </Button>
              </Tooltip>
            ) : <span>{r.follower_count}</span>) },
          // 回收站视图换两列（正常行没有「删除人」这个事实，画了就是说谎）
          ...(shownRecycled ? [
            { title: "删除人", key: "delby", width: 110, render: (_: unknown, r: DefectRow) => (
              r.recycled ? (r.delete_user_name ?? "—") : "—") },
            { title: "删除时间", key: "delat", width: 150, render: (_: unknown, r: DefectRow) => (
              r.recycled
                ? <Typography.Text type="secondary" className="tp-text-sm">
                    {fmtTime(r.delete_time, { seconds: false }) ?? "—"}
                  </Typography.Text>
                : <span>—</span>) },
          ] : [
            { title: "更新人", key: "updby", width: 100, render: (_: unknown, r: DefectRow) => (
              r.updated_by_name ?? "—") },
            { title: "更新时间", key: "updat", width: 150, render: (_: unknown, r: DefectRow) => (
              <Typography.Text type="secondary" className="tp-text-sm">
                {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
              </Typography.Text>) },
          ]),
          { title: "", key: "ops", width: 170, render: (_, r) => (
            r.recycled ? (
              <Space size={4}>
                {canUpdate && (
                  <Button size="small" data-testid="defect-restore" onClick={() => void restoreOne(r)}>
                    恢复
                  </Button>
                )}
                {canDelete && (
                  <Button size="small" danger data-testid="defect-purge"
                    onClick={() => { setPurge(r); setPurgeTitle(""); }}>
                    彻底删除
                  </Button>
                )}
              </Space>
            ) : (
              <Space size={4}>
                {canUpdate && (
                  <Button size="small" data-testid="defect-edit"
                    onClick={() => { setEditing(r); setFormOpen(true); }}>
                    编辑
                  </Button>
                )}
                {canDelete && (
                  <Button size="small" danger data-testid="defect-del"
                    onClick={() => {
                      Modal.confirm({
                        centered: true, title: "把「" + r.title + "」放入回收站？",
                        content: "软删，可随时恢复；彻底删除需逐字确认标题。",
                        okText: "放入回收站", cancelText: "取消", okButtonProps: { danger: true },
                        onOk: async () => { await removeOne(r); },
                      });
                    }}>
                    删除
                  </Button>
                )}
              </Space>
            )
          ) },
        ], colPref)}
        // 列宽合计 1672（回收站视图 1682）：显式宽让表在卡内横向滚动。
        // 不给宽时 table-layout:fixed 会把「标题」压成一列竖排单字（2026-11-24 真机）。
        cardFooter={(
          <div className="tp-cardfoot">
            <Typography.Text type="secondary" className="tp-cardfoot-note tp-text-sm">
              {loadError ? "本次列表加载失败，本行计数不作数" : ""}
              {shownRecycled ? " · 回收站视图" : ""}
              「关联用例」「评论」是实时计数
            </Typography.Text>
            <ListPager current={current} pageSize={pageSize} total={total}
              onPage={setCurrent} onPageSize={(s) => { setPageSize(s); setCurrent(1); }} />
          </div>
        )}
      />

      <DefectFormDrawer open={formOpen} editing={editing} projectId={pid} members={members}
        flow={flow} statusOptions={statusOptions}
        onClose={() => setFormOpen(false)} onSaved={() => void load()} />

      <Modal centered open={purge !== null} onCancel={() => { setPurge(null); setPurgeTitle(""); }}
        width={520} title="彻底删除缺陷？" okText="我已确认，彻底删除" cancelText="取消"
        okButtonProps={{ danger: true, disabled: purgeTitle !== (purge?.title ?? ""), loading: purging }}
        onOk={() => void submitPurge()}>
        <Typography.Paragraph>
          「{purge?.title}」将被物理删除，<Typography.Text strong>无法恢复</Typography.Text>；
          它的评论、关注与关联用例记录会一并清掉。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          输入缺陷标题 <Typography.Text code>{purge?.title}</Typography.Text> 以确认。
        </Typography.Paragraph>
        <Input data-testid="defect-purge-confirm" value={purgeTitle} autoFocus
          placeholder={purge?.title} onChange={(e) => setPurgeTitle(e.target.value)} />
      </Modal>

      <Modal centered open={batchOpen} onCancel={() => setBatchOpen(false)} width={520}
        title={"批量编辑标签（已选 " + selected.length + " 个）"}
        okText="应用" cancelText="取消" okButtonProps={{ loading: batchBusy }} onOk={() => void submitBatch()}>
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Select data-testid="defect-batch-action" value={batchAction} style={{ width: 200 }}
            onChange={(v) => setBatchAction(v as "add_tags" | "replace_tags")}
            options={[{ value: "add_tags", label: "追加标签" }, { value: "replace_tags", label: "覆盖标签" }]} />
          <Select mode="tags" style={{ width: "100%" }} value={batchTags} onChange={setBatchTags}
            maxCount={20} tokenSeparators={[",", "，"]} placeholder="回车创建标签" />
        </Space>
      </Modal>
    </div>
  );
}

export default function DefectsPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-defects" className="tp-fill-stack">
      <PageHead title="缺陷管理" descHover
        desc="测试跟踪的缺陷记录：工作流状态按状态图真校验，回收站独立于工作流状态。" />
      <ProjectGate>{project ? <DefectsList /> : null}</ProjectGate>
    </div>
  );
}
