// 功能用例列表（D193）：第 5 份模块树 + 用例本体 + 回收站 + 动态字段。
// 模块树复用 ModuleTree（apiBase=/functional-modules），但本域模块回收是**非空拒绝**
// （deleteHint 写明），不承诺「资产转未分类」。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Card, Drawer, Input, Modal, Progress, Select, Space, Table, Tag, Tooltip, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined, StarOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import EditorField from "../ui/EditorField";
import StateView from "../ui/StateView";
import { FilterBar } from "../ui/Toolbar";
import ModuleTree, { type ModNode } from "../api/ModuleTree";
import CaseMindmap from "../api/CaseMindmap";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get, post } from "../api/client";
import {
  CASE_STATUS_OPTIONS, functionalApi, type CaseBatchCopyBody, type CaseBatchUpdateBody, type CaseRow,
  type CaseStats, type CaseStatsGroupBy, type CaseStep, type FunctionalModuleNode,
} from "../api/functional";
import { projectMetaApi, type TemplateDetail, type TemplateField, type TemplateItem } from "../api/projectMeta";
import CustomFieldForm from "../ui/CustomFields";
import { downloadBlob } from "../api/ImportWizard";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import { applyColumnPrefs, emptyFilter, isFilterEmpty } from "../shared/listFilters";
import type { ColumnChoice, FilterDoc } from "../shared/listFilters";

const PRIO_COLOR: Record<string, string> = { P0: "red", P1: "volcano", P2: "blue", P3: "default" };
type MemberRow = { user_id: string; account: string | null; name: string | null };

// D219：列设置面板要露的列（key 与 columns 的 key 逐字一致）。回收站独有的
// 「恢复/彻底删除」操作列不进清单——它跟着视图走，不跟着偏好走。
const FUNCTIONAL_COL_CHOICES: ColumnChoice[] = [
  { key: "num", label: "编号" },
  { key: "name", label: "名称" },
  { key: "review", label: "评审结果" },
  { key: "tags", label: "标签" },
  { key: "prio", label: "优先级" },
  { key: "module", label: "模块" },
  { key: "description", label: "用例描述" },
  { key: "exec", label: "执行结果" },
  { key: "owner", label: "责任人" },
  { key: "custom", label: "自定义字段" },
  { key: "updby", label: "更新人" },
  { key: "updat", label: "更新时间" },
];

/** D277：评审/执行两列的词表。未发生（null）在渲染里单独画「未评审/未执行」，
 *  不并进这两个表——「没发生过」与「结果是 pending/blocked」是两句话。 */
const REVIEW_META: Record<string, { color: string; label: string }> = {
  pending: { color: "default", label: "待评审" },
  pass: { color: "success", label: "通过" },
  fail: { color: "error", label: "未通过" },
};
const EXEC_META: Record<string, { color: string; label: string }> = {
  pass: { color: "success", label: "通过" },
  fail: { color: "error", label: "失败" },
  blocked: { color: "warning", label: "阻塞" },
  skip: { color: "default", label: "跳过" },
};

/** 一条用例的跨计划摘要（后端 functional-case-summary-batch 手写镜像）。 */
type CaseSummary = {
  case_id: string;
  review_result: string | null;
  review_name: string | null;
  exec_result: string | null;
  exec_at: string | null;
};

function toModNodes(nodes: FunctionalModuleNode[]): ModNode[] {
  return nodes.map((n) => ({
    id: n.id, parent_id: n.parent_id, name: n.name, sort: n.sort, status: n.status,
    count: n.case_count, children: toModNodes(n.children),
  }));
}

function flattenModules(nodes: FunctionalModuleNode[], depth = 0): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const n of nodes) {
    out.push({ value: n.id, label: "　".repeat(depth) + n.name });
    out.push(...flattenModules(n.children, depth + 1));
  }
  return out;
}

function moduleNameMap(nodes: FunctionalModuleNode[], acc: Record<string, string> = {}): Record<string, string> {
  for (const n of nodes) {
    acc[n.id] = n.name;
    moduleNameMap(n.children, acc);
  }
  return acc;
}

/** D289：步骤行的内部 key（用户删改行后仍稳定；不用数组下标当 React key）。 */
type StepRow = CaseStep & { key: number };
let stepKeySeq = 0;
const nextStepKey = (): number => { stepKeySeq += 1; return stepKeySeq; };

function CaseFormDrawer({ open, editing, projectId, modules, members, onClose, onSaved }: {
  open: boolean;
  editing: CaseRow | null;
  projectId: string;
  modules: FunctionalModuleNode[];
  members: MemberRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [priority, setPriority] = useState("P2");
  const [description, setDescription] = useState("");
  // D289：MS v2 用例表单的四项内容（步骤用行表格编辑）
  const [precondition, setPrecondition] = useState("");
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [remark, setRemark] = useState("");
  const [caseStatus, setCaseStatus] = useState("prepare");
  const [moduleId, setModuleId] = useState<string | null>(null);
  // D281：责任人（null = 还没定人，不默认指派）
  const [ownerId, setOwnerId] = useState<string | null>(null);
  // D283：标签
  const [tags, setTags] = useState<string[]>([]);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [tpl, setTpl] = useState<TemplateDetail | null>(null);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadTemplate = useCallback(async (id: string, base: Record<string, unknown>): Promise<void> => {
    if (!id) { setTpl(null); return; }
    setLoading(true);
    try {
      const d = await projectMetaApi.template(projectId, id);
      setTpl(d);
      const next = { ...base };
      for (const f of d.fields) {
        if (next[f.field_id] === undefined && f.default_value !== null && f.default_value !== undefined) {
          next[f.field_id] = f.default_value;
        }
      }
      setCustom(next);
    } catch { setTpl(null); } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setPriority(editing?.priority ?? "P2");
    setDescription(editing?.description ?? "");
    setModuleId(editing?.module_id ?? null);
    setOwnerId(editing?.owner_id ?? null);
    setTags(editing?.tags ?? []);
    setPrecondition(editing?.precondition ?? "");
    setSteps((editing?.steps ?? []).map((s) => ({ ...s, key: nextStepKey() })));
    setRemark(editing?.remark ?? "");
    setCaseStatus(editing?.case_status ?? "prepare");
    setErr(null);
    setTemplates([]);
    setTpl(null);
    setCustom({});
    void (async () => {
      try {
        const r = await projectMetaApi.templates(projectId, "functional");
        setTemplates(r.items);
        const chosen = editing?.template_id ?? r.items.find((t) => t.is_default)?.id ?? r.items[0]?.id ?? "";
        setTemplateId(chosen);
        await loadTemplate(chosen, editing?.custom_fields ?? {});
      } catch (e) {
        setErr(e instanceof ApiErr ? e.message : "模板加载失败");
      }
    })();
  }, [open, editing, projectId, loadTemplate]);

  async function submit(): Promise<void> {
    if (!name.trim()) { message.warning("用例名称必填"); return; }
    if (!templateId) { message.warning("还没有可用模板"); return; }
    if (!caseStatus) { message.warning("用例状态必填"); return; }
    // 两列全空的行不提交（后端也会丢，但请求体里就不该出现空行）
    const cleanSteps: CaseStep[] = steps
      .map(({ desc, expected }) => ({ desc: desc.trim(), expected: expected.trim() }))
      .filter((s) => s.desc || s.expected);
    const preconditionText = precondition.trim() || null;
    const remarkText = remark.trim() || null;
    setBusy(true);
    setErr(null);
    try {
      if (editing) {
        await functionalApi.updateCase(editing.id, {
          project_id: projectId, name: name.trim(), priority, description, description_set: true,
          precondition: preconditionText, precondition_set: true,
          steps: cleanSteps, steps_set: true,
          remark: remarkText, remark_set: true,
          case_status: caseStatus,
          owner_id: ownerId, owner_set: true,
          tags,
          module_id: moduleId, module_set: true, template_id: templateId, custom_fields: custom,
        });
      } else {
        await functionalApi.createCase({
          project_id: projectId, name: name.trim(), priority, description,
          precondition: preconditionText, steps: cleanSteps, remark: remarkText,
          case_status: caseStatus,
          owner_id: ownerId,
          tags,
          module_id: moduleId, template_id: templateId, custom_fields: custom,
        });
      }
      message.success(editing ? "已保存" : "用例已创建");
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  function patchStep(key: number, patch: Partial<CaseStep>): void {
    setSteps((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  }

  const stepColumns = [
    {
      title: "#", width: 44, align: "center" as const,
      render: (_: unknown, __: StepRow, index: number) => index + 1,
    },
    {
      title: "步骤描述",
      render: (_: unknown, row: StepRow, index: number) => (
        <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} value={row.desc}
          data-testid={`fc-step-desc-${index}`} placeholder="这一步做了什么"
          onChange={(e) => patchStep(row.key, { desc: e.target.value })} />
      ),
    },
    {
      title: "预期结果",
      render: (_: unknown, row: StepRow, index: number) => (
        <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} value={row.expected}
          data-testid={`fc-step-expected-${index}`} placeholder="应该看到什么"
          onChange={(e) => patchStep(row.key, { expected: e.target.value })} />
      ),
    },
    {
      title: "", width: 44,
      render: (_: unknown, row: StepRow, index: number) => (
        <Button type="text" danger size="small" data-testid={`fc-step-del-${index}`}
          onClick={() => setSteps((xs) => xs.filter((x) => x.key !== row.key))}>删</Button>
      ),
    },
  ];

  return (
    <Drawer open={open} onClose={onClose} width="100%" destroyOnHidden
      className="tp-record-drawer"
      title={editing ? "编辑用例：" + editing.name : "新建功能用例"}
      styles={{ body: { padding: 0, overflow: "hidden" } }}
      footer={
        <div className="tp-record-editor__footer">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={busy} data-testid="fc-save" onClick={() => void submit()}>
            保存
          </Button>
        </div>
      }>
      <div className="tp-record-editor tp-record-editor--side-right">
        <main className="tp-record-editor__main">
          <section className="tp-record-editor__pane tp-record-editor__pane--fill">
            <header className="tp-record-editor__pane-head">
              <div className="tp-record-editor__pane-title">用例内容</div>
              <span className="tp-record-editor__pane-sub">前置条件、步骤与备注</span>
            </header>
            <div className="tp-case-form">
              <EditorField label="用例名称" required>
                <Input data-testid="fc-field-name" maxLength={255} value={name} autoFocus
                  placeholder="一句话说清要验证什么"
                  onChange={(e) => setName(e.target.value)} />
              </EditorField>
              <EditorField label="前置条件" hint="执行这条用例之前，环境 / 数据 / 账号需要处于什么状态">
                <Input.TextArea data-testid="fc-field-precondition" rows={3} maxLength={20000}
                  value={precondition} placeholder="例如：已登录管理员账号；项目内已有默认模板"
                  onChange={(e) => setPrecondition(e.target.value)} />
              </EditorField>
              <EditorField label="步骤描述" hint="每行一步；两列都空的行不会保存">
                <Table<StepRow> size="small" pagination={false} rowKey="key"
                  className="tp-step-table" dataSource={steps} columns={stepColumns}
                  locale={{ emptyText: "还没有步骤；点下方「添加步骤」逐行补" }} />
                <Button type="dashed" block data-testid="fc-step-add" style={{ marginTop: 8 }}
                  onClick={() => setSteps((xs) => [...xs, { key: nextStepKey(), desc: "", expected: "" }])}>
                  添加步骤
                </Button>
              </EditorField>
              <EditorField label="备注" hint="只给组内看，不影响执行判定">
                <Input.TextArea data-testid="fc-field-remark" rows={3} maxLength={20000}
                  value={remark} placeholder="可选：执行注意事项、数据来源等"
                  onChange={(e) => setRemark(e.target.value)} />
              </EditorField>
              {err && <Alert type="error" showIcon data-testid="fc-save-error" message={err} />}
            </div>
          </section>
        </main>
        <aside className="tp-record-editor__side" data-testid="fc-form-side">
          <div className="tp-record-editor__side-head">
            <div className="tp-record-editor__pane-title">用例属性</div>
            <div className="tp-record-editor__pane-sub">模块、责任人与状态</div>
          </div>
          <div className="tp-record-editor__side-body">
            <EditorField label="所属模块">
              <Select data-testid="fc-field-module" allowClear style={{ width: "100%" }}
                value={moduleId ?? undefined} placeholder="未分类"
                onChange={(v) => setModuleId(v ?? null)}
                options={flattenModules(modules)} />
            </EditorField>
            <EditorField label="责任人" hint="可留空：还没定人时不伪造默认指派">
              <Select data-testid="fc-field-owner" allowClear style={{ width: "100%" }}
                value={ownerId ?? undefined} placeholder="未指派"
                onChange={(v) => setOwnerId(v ?? null)}
                options={members.map((m) => ({
                  value: m.user_id, label: m.name ?? m.account ?? m.user_id,
                }))} />
            </EditorField>
            <EditorField label="用例等级" required>
              <Select data-testid="fc-field-priority" style={{ width: "100%" }} value={priority}
                onChange={setPriority}
                options={["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v }))} />
            </EditorField>
            <EditorField label="用例状态" required>
              <Select data-testid="fc-field-status" style={{ width: "100%" }} value={caseStatus}
                onChange={setCaseStatus} options={CASE_STATUS_OPTIONS} />
            </EditorField>
            <EditorField label="模板" hint="编辑时不可换模板（字段定义会变）">
              <Select data-testid="fc-field-template" style={{ width: "100%" }} value={templateId || undefined}
                loading={loading} disabled={Boolean(editing)}
                onChange={(v) => { setTemplateId(String(v)); void loadTemplate(String(v), {}); }}
                options={templates.map((t) => ({ value: t.id, label: t.name + (t.is_default ? "（默认）" : "") }))} />
            </EditorField>
            <EditorField label="标签">
              <Select mode="tags" data-testid="fc-field-tags" style={{ width: "100%" }}
                value={tags} placeholder="回车或逗号分隔"
                tokenSeparators={[",", "，"]}
                onChange={(v: string[]) => setTags(v)} />
            </EditorField>
            <EditorField label="描述">
              <Input.TextArea rows={3} value={description}
                onChange={(e) => setDescription(e.target.value)} />
            </EditorField>
            <EditorField label="自定义字段">
              {tpl ? (
                <CustomFieldForm fields={tpl.fields} values={custom} onChange={setCustom}
                  members={members} disabled={loading} />
              ) : (
                <Typography.Text type="secondary" className="tp-text-sm">
                  {loading ? "模板字段加载中…" : "请选择模板"}
                </Typography.Text>
              )}
            </EditorField>
          </div>
          <div className="tp-record-editor__side-foot">
            前置条件 / 步骤 / 备注属于用例内容，改动会按项目开关触发自动重评审。
          </div>
        </aside>
      </div>
    </Drawer>
  );
}

function CasesList() {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canCreate = can(perms, "functional:case:create");
  const canUpdate = can(perms, "functional:case:update");
  const canDelete = can(perms, "functional:case:delete");
  const canModuleCreate = can(perms, "functional:module:create");
  const canModuleDelete = can(perms, "functional:module:delete");

  const [tree, setTree] = useState<FunctionalModuleNode[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [recycledModules, setRecycledModules] = useState<FunctionalModuleNode[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [inRecycled, setInRecycled] = useState(false);
  const [shownRecycled, setShownRecycled] = useState(false);
  const [rows, setRows] = useState<CaseRow[]>([]);
  // D277：当前页用例的评审/执行结论（一次批量）。null 值代表「从未发生」，摘要缺席
  // （取数失败）才画「—」——两者不许混。
  const [summaries, setSummaries] = useState<Record<string, CaseSummary>>({});
  const [summaryError, setSummaryError] = useState(false);
  const [fieldMeta, setFieldMeta] = useState<Record<string, TemplateField>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  const [kwDraft, setKwDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  // D283：标签精确筛选（与关键字/优先级并行）
  const [tagFilter, setTagFilter] = useState("");
  const [priority, setPriority] = useState<string | undefined>();
  // D234：「我关注的」是后端视图轴（与模块/关键词/高级搜索并行 AND），不做本地过滤。
  const [followedOnly, setFollowedOnly] = useState(false);
  // D268：脑图是模块树 + 便签 + 用例叶的另一个视图，不改列表面板。
  const [mindOpen, setMindOpen] = useState(false);
  // D219：高级搜索条件组 + 列设置偏好（键 functional_case，与后端 view_type 同字）。
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const [colPref, setColPref] = useColumnPrefs("functional_case",
    FUNCTIONAL_COL_CHOICES.map((c) => c.key));
  const patchAdv = (next: FilterDoc): void => { setAdvFilter(next); setCurrent(1); };
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CaseRow | null>(null);
  const [purge, setPurge] = useState<CaseRow | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purging, setPurging] = useState(false);
  // D232：批量编辑（优先级/模块）。勾选只在「有写位 + 非回收站」时出现；
  // 每次列表重取都清空勾选——不在看不见的行上暗改（不假装跨页全选）。
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchPrio, setBatchPrio] = useState<string | undefined>();
  const [batchModule, setBatchModule] = useState("__keep__");
  const [batchBusy, setBatchBusy] = useState(false);
  // D233：批量复制。模块默认「保持原模块」；后缀留空 = 副本与源同名（后端上限 255）。
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyModule, setCopyModule] = useState("__same__");
  const [copySuffix, setCopySuffix] = useState("（副本）");
  const [copyBusy, setCopyBusy] = useState(false);
  // D205：Excel 导入/导出/模板。导入错误按后端 details.errors 原样列行号。
  const [importing, setImporting] = useState(false);
  const [importErrs, setImportErrs] = useState<{ message: string; rows: { row: number; message: string }[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // D236：统计弹层。分组轴三选一；范围跟随当前视图（正常/回收站）。
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsGroup, setStatsGroup] = useState<CaseStatsGroupBy>("priority");
  const [stats, setStats] = useState<CaseStats | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);

  const loadTree = useCallback(async () => {
    setTreeError(null);
    try {
      const t = await functionalApi.tree(pid, inRecycled);
      setTree(t.tree);
      setRecycledModules(t.recycled);
    } catch (e) {
      setTree([]);
      setRecycledModules([]);
      setTreeError(e instanceof ApiErr ? e.message : "模块树加载失败");
    }
  }, [pid, inRecycled]);
  useEffect(() => { void loadTree(); }, [loadTree]);
  useEffect(() => {
    void (async () => {
      try {
        const r = await get<{ items: MemberRow[] }>("/projects/" + encodeURIComponent(pid) + "/members",
          { silent: true });
        setMembers(r.items);
      } catch { setMembers([]); }
    })();
  }, [pid]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSelectedIds([]); // D232：结果集变了，勾选作废（只对眼前这批行负责）
    try {
      const r = await functionalApi.listCases({
        project_id: pid, module_id: selected ?? undefined, priority,
        keyword: keyword || undefined, tag: tagFilter || undefined,
        recycled: inRecycled, current, size: pageSize,
        ...(followedOnly ? { followed_by_me: true } : {}),
        ...(isFilterEmpty(advFilter) ? {} : { filter: JSON.stringify(advFilter) }),
      });
      setRows(r.items);
      setTotal(r.total);
      setShownRecycled(inRecycled);
    } catch (e) {
      setRows([]);
      setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "用例列表加载失败");
    } finally { setLoading(false); }
  }, [pid, selected, priority, keyword, tagFilter, inRecycled, current, pageSize, advFilter, followedOnly]);
  useEffect(() => { void load(); }, [load]);

  // D277：当前页评审/执行结论一次批量取（rows 身份变化 = 任何刷新/翻页/筛选）。
  useEffect(() => {
    if (rows.length === 0) { setSummaries({}); setSummaryError(false); return; }
    let alive = true;
    setSummaryError(false);
    void (async () => {
      try {
        const out = await post<{ items: CaseSummary[]; total: number }>(
          "/functional-case-summary-batch",
          { project_id: pid, case_ids: rows.map((r) => r.id) },
          { silent: true },
        );
        if (!alive) return;
        setSummaries(Object.fromEntries(out.items.map((x) => [x.case_id, x])));
      } catch {
        if (!alive) return;
        setSummaries({});
        setSummaryError(true);
      }
    })();
    return () => { alive = false; };
  }, [pid, rows]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await projectMetaApi.templates(pid, "functional");
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

  const modNames = moduleNameMap(tree);
  const customText = (r: CaseRow): string => {
    const entries = Object.entries(r.custom_fields ?? {});
    if (!entries.length) return "—";
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

  function toggleRecycled(): void {
    setInRecycled((v) => !v);
    setSelected(null);
    setCurrent(1);
  }

  /** D234：关注/取关只改本行；在「我关注的」视图里取关后该行不该再出现，整页重取。 */
  async function toggleFollow(r: CaseRow): Promise<void> {
    try {
      const out = r.followed
        ? await functionalApi.unfollowCase(pid, r.id)
        : await functionalApi.followCase(pid, r.id);
      if (followedOnly && !out.following) {
        await load();
      } else {
        setRows((prev) => prev.map((x) =>
          x.id === r.id ? { ...x, followed: out.following } : x));
      }
    } catch { /* toast */ }
  }
  async function removeOne(r: CaseRow): Promise<void> {
    try {
      await functionalApi.deleteCase(pid, r.id);
      message.success("已放入回收站");
      await load();
    } catch { /* toast */ }
  }
  async function restoreOne(r: CaseRow): Promise<void> {
    try {
      await functionalApi.restoreCase(pid, r.id);
      message.success("已恢复");
      await load();
    } catch { /* toast */ }
  }
  async function submitPurge(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      await functionalApi.purgeCase(pid, purge.id, purgeName);
      message.success("已彻底删除");
      setPurge(null); setPurgeName("");
      await load();
    } catch { /* toast */ } finally { setPurging(false); }
  }

  // ── D253：回收站批量恢复（后端 batch-restore 早就在，界面只差这一根线）──────
  // 后端口径是「能恢复的都恢复，不在回收站的跳过」，不是全有或全无——文案必须如实说，
  // 恢复数与勾选数不一致时把跳过数报出来，别让用户以为整批成功。
  const [restoring, setRestoring] = useState(false);
  function batchRestore(): void {
    Modal.confirm({
      centered: true,
      title: "恢复所选 " + selectedIds.length + " 条用例？",
      content: "只恢复仍在回收站的用例；已被恢复或已彻底删除的会跳过。恢复后回到原模块。",
      okText: "恢复",
      onOk: async () => {
        setRestoring(true);
        try {
          const r = await functionalApi.batchRestore(pid, selectedIds);
          const skipped = selectedIds.length - r.affected;
          if (skipped > 0) {
            message.success("已恢复 " + r.affected + " 条，跳过 " + skipped + " 条（已不在回收站）");
          } else {
            message.success("已恢复 " + r.affected + " 条");
          }
          setSelectedIds([]);
          await load();
          await loadTree(); // 模块计数与回收站计数都会变
        } catch { /* client 已 toast；选择保留让用户改名单 */ }
        finally { setRestoring(false); }
      },
    });
  }

  // ── D254：回收站批量彻底删除 ────────────────────────────────────────────
  // 单条的护栏是「逐字输入用例名」，批量里 N 个名字没法逐个输——改成输固定短语
  // 「彻底删除」，并在弹窗里点名要删的前几条。后端 batch-purge 同样是「能删的都删、
  // 不在回收站的跳过」，跳过数必须如实报出来。
  const [batchPurgeOpen, setBatchPurgeOpen] = useState(false);
  const [batchPurgeWord, setBatchPurgeWord] = useState("");
  const [batchPurging, setBatchPurging] = useState(false);
  const selectedRows = rows.filter((r) => selectedIds.includes(r.id));
  async function doBatchPurge(): Promise<void> {
    setBatchPurging(true);
    try {
      const r = await functionalApi.batchPurge(pid, selectedIds);
      const skipped = selectedIds.length - r.affected;
      if (skipped > 0) {
        message.success("已彻底删除 " + r.affected + " 条，跳过 " + skipped + " 条（已不在回收站）");
      } else {
        message.success("已彻底删除 " + r.affected + " 条");
      }
      setBatchPurgeOpen(false);
      setBatchPurgeWord("");
      setSelectedIds([]);
      await load();
      await loadTree();
    } catch { /* client 已 toast；弹窗留着让用户重试 */ }
    finally { setBatchPurging(false); }
  }

  // ── D232：批量编辑 ───────────────────────────────────────────────────────
  function openBatch(): void {
    setBatchPrio(undefined);
    setBatchModule("__keep__");
    setBatchOpen(true);
  }

  async function submitBatch(): Promise<void> {
    const body: CaseBatchUpdateBody = { project_id: pid, case_ids: selectedIds };
    if (batchPrio) body.priority = batchPrio;
    if (batchModule !== "__keep__") {
      body.module_set = true;
      body.module_id = batchModule === "__unfiled__" ? null : batchModule;
    }
    if (!body.priority && !body.module_set) {
      // 不发空请求：后端会 422 `empty_update`，前端先拦住（同样的口径，少一次往返）。
      message.warning("至少选择优先级或模块");
      return;
    }
    setBatchBusy(true);
    try {
      const r = await functionalApi.batchUpdate(body);
      message.success(`已更新 ${r.affected} 条`);
      setBatchOpen(false);
      setSelectedIds([]);
      await load();
      await loadTree(); // 模块计数会变（直属用例数）
    } catch { /* toast 已由 client 出 */ } finally { setBatchBusy(false); }
  }

  // ── D233：批量复制 ───────────────────────────────────────────────────────
  function openCopy(): void {
    setCopyModule("__same__");
    setCopySuffix("（副本）");
    setCopyOpen(true);
  }

  async function submitCopy(): Promise<void> {
    const body: CaseBatchCopyBody = {
      project_id: pid, case_ids: selectedIds, name_suffix: copySuffix,
    };
    if (copyModule !== "__same__") {
      body.module_set = true;
      body.module_id = copyModule === "__unfiled__" ? null : copyModule;
    }
    setCopyBusy(true);
    try {
      const r = await functionalApi.batchCopy(body);
      message.success(`已复制 ${r.affected} 条`);
      setCopyOpen(false);
      setSelectedIds([]);
      await load();
      await loadTree(); // 模块计数会变（副本落在哪个模块由这里重算）
    } catch { /* toast 已由 client 出 */ } finally { setCopyBusy(false); }
  }

  async function downloadTemplate(): Promise<void> {
    try {
      downloadBlob(await functionalApi.importTemplate(pid), "功能用例导入模板.xlsx");
    } catch { /* toast 已由 client 出 */ }
  }
  /** D235：导出与列表同一把尺（模块/关键词/优先级/高级搜索/我关注的），不再「所见非所得」。 */
  async function exportCases(): Promise<void> {
    try {
      downloadBlob(await functionalApi.exportCases({
        project_id: pid, module_id: selected ?? undefined,
        keyword: keyword || undefined, priority: priority || undefined,
        ...(followedOnly ? { followed_by_me: true } : {}),
        ...(isFilterEmpty(advFilter) ? {} : { filter: JSON.stringify(advFilter) }),
      }), "功能用例.xlsx");
    } catch { /* toast 已由 client 出 */ }
  }
  /** D235：导出所选——只认勾选的 id（后端再与项目边界 AND）。 */
  async function exportSelected(): Promise<void> {
    try {
      downloadBlob(await functionalApi.exportCases({
        project_id: pid, ids: selectedIds.join(","),
      }), "功能用例-所选.xlsx");
    } catch { /* toast 已由 client 出 */ }
  }
  async function pickImport(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const f = e.target.files?.[0];
    e.target.value = ""; // 同一文件连选两次也要触发 change
    if (!f) return;
    setImporting(true);
    setImportErrs(null);
    try {
      const fd = new FormData();
      fd.append("project_id", pid);
      if (selected) fd.append("module_id", selected);
      fd.append("file", f);
      const r = await functionalApi.importCases(fd);
      message.success(`导入成功：${r.created} 条`);
      await load();
      await loadTree();
    } catch (err: unknown) {
      if (err instanceof ApiErr) {
        const det = err.details as { errors?: { row: number; message: string }[] } | undefined;
        setImportErrs({ message: err.message, rows: det?.errors ?? [] });
      } else {
        setImportErrs({ message: "导入没成功", rows: [] });
      }
    } finally {
      setImporting(false);
    }
  }

  // ── D236：统计 ───────────────────────────────────────────────────────────
  async function loadStats(groupBy: CaseStatsGroupBy): Promise<void> {
    setStatsGroup(groupBy);
    setStatsBusy(true);
    try {
      setStats(await functionalApi.stats({
        project_id: pid, group_by: groupBy, recycled: inRecycled,
      }));
    } catch {
      setStats(null); // 错误提示由 client 统一出；弹层里如实显示「没有数据」
    } finally { setStatsBusy(false); }
  }

  function openStats(): void {
    setStatsOpen(true);
    void loadStats(statsGroup);
  }

  return (
    <div className="tp-fill tp-fill-body" style={{ flexDirection: "row", alignItems: "stretch" }}>
      <div style={{ width: 240, flex: "0 0 240px", marginRight: 12 }} className="tp-fill-side">
        {/* 与接口/场景两页同构：树住进吃满列高的白卡（此前裸 div + overflow:auto，
            空树时左栏只剩 40px 高的一条，与右侧表格的底边完全对不上）。 */}
        <Card size="small">
        <ModuleTree projectId={pid} tree={toModNodes(tree)} recycled={toModNodes(recycledModules)}
          inRecycled={inRecycled} onToggleRecycled={toggleRecycled}
          selected={selected} onSelect={(id) => { setSelected(id); setCurrent(1); }}
          onChanged={() => { void loadTree(); void load(); }}
          canManage={canModuleDelete} canCreate={canModuleCreate}
          apiBase="/functional-modules" allLabel="全部用例" noun="用例"
          loadError={treeError}
          countTip="徽标是该模块直属的用例数（不含子模块）"
          deleteHint="模块下还有子模块或用例时会被拒绝（409）；请先移走或回收它们。" />
        </Card>
      </div>
      <div style={{ flex: 1, minWidth: 0 }} className="tp-fill tp-fill-body">
        <div style={{ flex: "0 0 auto" }}>
          {/* D219：D47-a 三件套铺到功能用例页。关键字/优先级快捷筛与左树照旧在下一行，
              高级搜索管任意组合，两者并存不互相替代（ADB 页同款布局）。 */}
          <ListToolbar
            projectId={pid} viewType="functional_case"
            filter={advFilter} onFilterChange={patchAdv}
            valueOptions={{
              priority: ["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v })),
              created_by: members.map((m) => ({ value: m.user_id,
                label: m.name ?? m.account ?? m.user_id })),
              updated_by: members.map((m) => ({ value: m.user_id,
                label: m.name ?? m.account ?? m.user_id })),
              owner_id: members.map((m) => ({ value: m.user_id,
                label: m.name ?? m.account ?? m.user_id })),
            } satisfies Record<string, Option[]>}
            allColumns={FUNCTIONAL_COL_CHOICES} columnPref={colPref}
            onColumnPrefChange={setColPref}
            canSaveView={can(perms, "search:view:create")}
            canDeleteView={can(perms, "search:view:delete")}
          />
          <FilterBar actions={(
            <>
              {canCreate && !inRecycled && (
                <Button type="primary" icon={<PlusOutlined />} data-testid="fc-new"
                  onClick={() => { setEditing(null); setFormOpen(true); }}>
                  新建用例
                </Button>
              )}
              {canUpdate && inRecycled && selectedIds.length > 0 && (
                <Button type="primary" data-testid="fc-batch-restore" loading={restoring}
                  onClick={batchRestore}>
                  批量恢复（{selectedIds.length}）
                </Button>
              )}
              {canDelete && inRecycled && selectedIds.length > 0 && (
                <Button danger data-testid="fc-batch-purge"
                  onClick={() => { setBatchPurgeWord(""); setBatchPurgeOpen(true); }}>
                  批量彻底删除（{selectedIds.length}）
                </Button>
              )}
              {canUpdate && !inRecycled && selectedIds.length > 0 && (
                <Button data-testid="fc-batch-edit" onClick={openBatch}>
                  批量编辑（{selectedIds.length}）
                </Button>
              )}
              {canCreate && !inRecycled && selectedIds.length > 0 && (
                <Button data-testid="fc-copy" onClick={openCopy}>
                  批量复制（{selectedIds.length}）
                </Button>
              )}
              <Button data-testid="fc-followed-only" type={followedOnly ? "primary" : "default"}
                onClick={() => { setFollowedOnly((v) => !v); setCurrent(1); }}>
                我关注的
              </Button>
              <Button data-testid="fc-stats" onClick={openStats}>统计</Button>
              <Button data-testid="fc-mind" onClick={() => setMindOpen(true)}>脑图</Button>
              <Button icon={<ReloadOutlined />} onClick={() => { void load(); void loadTree(); }}>刷新</Button>
              {!inRecycled && (
                <>
                  <Button data-testid="fc-template" onClick={() => void downloadTemplate()}>下载模板</Button>
                  <Button data-testid="fc-export" onClick={() => void exportCases()}>导出</Button>
                  {selectedIds.length > 0 && (
                    <Button data-testid="fc-export-selected" onClick={() => void exportSelected()}>
                      导出所选（{selectedIds.length}）
                    </Button>
                  )}
                </>
              )}
              {canCreate && !inRecycled && (
                <Button data-testid="fc-import" loading={importing}
                  onClick={() => fileRef.current?.click()}>导入</Button>
              )}
              <input ref={fileRef} type="file" accept=".xlsx" style={{ display: "none" }}
                data-testid="fc-import-input" onChange={(e) => void pickImport(e)} />
              <Button data-testid="fc-recycled" type={inRecycled ? "primary" : "default"}
                onClick={toggleRecycled}>
                {inRecycled ? "退出回收站" : "♻ 回收站"}
              </Button>
            </>
          )}>
            <Space wrap size={8}>
              <Input.Search data-testid="fc-filter-keyword" allowClear placeholder="名称/描述关键词"
                style={{ width: 200 }} value={kwDraft} onChange={(e) => setKwDraft(e.target.value)}
                onSearch={() => { setKeyword(kwDraft.trim()); setCurrent(1); }} />
              <Select allowClear placeholder="优先级" style={{ width: 100 }} value={priority}
                options={["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v }))}
                onChange={(v) => { setPriority(v); setCurrent(1); }} />
              <Input.Search data-testid="fc-filter-tag" allowClear placeholder="标签（精确）"
                style={{ width: 150 }} defaultValue={tagFilter}
                onSearch={(v) => { setTagFilter(v.trim()); setCurrent(1); }} />
            </Space>
          </FilterBar>
          {loadError && (
            <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="fc-load-error"
              message="用例列表加载失败" description={loadError} />
          )}
        </div>
        <AdminTable<CaseRow> rowKey="id" loading={loading} dataSource={rows} pagination={false}
          rowSelection={canUpdate ? {
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds(keys.map(String)),
          } : undefined}
          locale={{ emptyText: loadError ? (
            <StateView kind="error" title="用例列表没取到，以上方提示为准"
              action={<Button size="small" onClick={() => void load()}>重试</Button>} />
          ) : (
            <StateView title={shownRecycled ? "回收站是空的"
              : canCreate ? "当前筛选下还没有用例，点「新建用例」开始" : "当前筛选下还没有用例"} />
          ) }}
          columns={applyColumnPrefs([
            { title: "ID", key: "num", width: 90, render: (_, r) => (
              <Typography.Text type="secondary" className="tp-text-sm">{r.num}</Typography.Text>) },
            { title: "名称", dataIndex: "name", key: "name", width: 240,
              render: (v: string, r) => (
              <Space size={4}>
                {r.recycled ? <span>{v}</span> : (
                  <Typography.Link data-testid="fc-row-name" onClick={() => nav("/functional/cases/" + r.id)}>
                    {v}
                  </Typography.Link>
                )}
                {canUpdate && (
                  <Button type="text" size="small" data-testid={"fc-follow-" + r.id}
                    data-followed={r.followed ? "1" : "0"}
                    aria-label={r.followed ? "取消关注" : "关注"}
                    onClick={() => void toggleFollow(r)}
                    icon={<StarOutlined
                      style={r.followed ? { color: "#faad14" } : { color: "#bfbfbf" }} />} />
                )}
              </Space>
            ) },
            // D277：评审结果/执行结果来自一次批量投影。四态分开画：
            // 摘要缺席 →「—」+ 没取到；摘要在场但值为 null →「未评审/未执行」（真事实）。
            { title: "评审结果", key: "review", width: 96, render: (_, r) => {
                const s = summaries[r.id];
                if (!s) return <Tooltip title={summaryError ? "评审摘要取数失败" : "评审摘要加载中"}>
                  <Typography.Text type="secondary" data-testid={"fc-review-" + r.id}>—</Typography.Text></Tooltip>;
                if (!s.review_result) return <Typography.Text type="secondary" data-testid={"fc-review-" + r.id}>未评审</Typography.Text>;
                const m = REVIEW_META[s.review_result] ?? { color: "default", label: s.review_result };
                return <Tooltip title={s.review_name ? "评审：" + s.review_name : undefined}>
                  <Tag color={m.color} data-testid={"fc-review-" + r.id}>{m.label}</Tag></Tooltip>;
              } },
            // D283：标签（最多画两枚，其余进 Tooltip；空画「—」）
            { title: "标签", key: "tags", width: 140, render: (_, r) => {
                if (!r.tags.length) return <Typography.Text type="secondary"
                  data-testid={"fc-tags-" + r.id}>—</Typography.Text>;
                return <Tooltip title={r.tags.join("、")}>
                  <Space size={4} data-testid={"fc-tags-" + r.id}>
                    {r.tags.slice(0, 2).map((t) => <Tag key={t}>{t}</Tag>)}
                    {r.tags.length > 2 ? <Tag>+{r.tags.length - 2}</Tag> : null}
                  </Space>
                </Tooltip>;
              } },
            { title: "优先级", dataIndex: "priority", key: "prio", width: 80, render: (v: string) => (
              <Tag color={PRIO_COLOR[v] ?? "default"}>{v}</Tag>) },
            { title: "模块", key: "module", width: 130, render: (_, r) => (
              r.module_id ? (modNames[r.module_id] ?? "—") : "未分类") },
            { title: "用例描述", dataIndex: "description", key: "description", width: 220,
              ellipsis: true, render: (v: string | null) => v ?? "—" },
            { title: "执行结果", key: "exec", width: 96, render: (_, r) => {
                const s = summaries[r.id];
                if (!s) return <Tooltip title={summaryError ? "执行摘要取数失败" : "执行摘要加载中"}>
                  <Typography.Text type="secondary" data-testid={"fc-exec-" + r.id}>—</Typography.Text></Tooltip>;
                if (!s.exec_result) return <Typography.Text type="secondary" data-testid={"fc-exec-" + r.id}>未执行</Typography.Text>;
                const m = EXEC_META[s.exec_result] ?? { color: "default", label: s.exec_result };
                return <Tooltip title={s.exec_at ? "执行于 " + fmtTime(s.exec_at) : undefined}>
                  <Tag color={m.color} data-testid={"fc-exec-" + r.id}>{m.label}</Tag></Tooltip>;
              } },
            // D281：责任人（空 = 还没定人，画「—」；不拿创建人冒充）
            { title: "责任人", key: "owner", width: 110, render: (_, r) => (
              <span data-testid={"fc-owner-" + r.id}>{r.owner_name ?? "—"}</span>) },
            { title: "自定义字段", key: "custom", width: 220, render: (_, r) => (
              <Typography.Text className="tp-text-sm">{customText(r)}</Typography.Text>) },
            { title: "更新人", key: "updby", width: 100, render: (_, r) => r.updated_by_name ?? "—" },
            { title: "更新时间", key: "updat", width: 140, render: (_, r) => (
              <Typography.Text type="secondary" className="tp-text-sm">
                {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
              </Typography.Text>) },
            { title: "", key: "ops", width: 170, render: (_, r) => (
              r.recycled ? (
                <Space size={4}>
                  {canUpdate && (
                    <Button size="small" data-testid="fc-restore" onClick={() => void restoreOne(r)}>恢复</Button>
                  )}
                  {canDelete && (
                    <Button size="small" danger data-testid="fc-purge"
                      onClick={() => { setPurge(r); setPurgeName(""); }}>彻底删除</Button>
                  )}
                </Space>
              ) : (
                <Space size={4}>
                  {canUpdate && (
                    <Button size="small" data-testid="fc-edit"
                      onClick={() => { setEditing(r); setFormOpen(true); }}>编辑</Button>
                  )}
                  {canDelete && (
                    <Button size="small" danger data-testid="fc-del"
                      onClick={() => {
                        Modal.confirm({
                          centered: true, title: "把「" + r.name + "」放入回收站？",
                          content: "软删，可恢复；彻底删除需逐字确认名称。",
                          okText: "放入回收站", cancelText: "取消", okButtonProps: { danger: true },
                          onOk: async () => { await removeOne(r); },
                        });
                      }}>删除</Button>
                  )}
                </Space>
              )
            ) },
          ], colPref)}
          // 显式宽合计 1582 > 卡片可用宽：表在卡内横向滚动，无宽的名称列不会被压成 0。
          cardFooter={(
            <div className="tp-cardfoot">
              <Typography.Text type="secondary" className="tp-cardfoot-note tp-text-sm">
                {loadError ? "本次列表加载失败，本行计数不作数" : ""}
                {shownRecycled ? " · 回收站视图" : ""}
                用例编号按项目独立递增
              </Typography.Text>
              <ListPager current={current} pageSize={pageSize} total={total}
                onPage={setCurrent} onPageSize={(s) => { setPageSize(s); setCurrent(1); }} />
            </div>
          )}
        />

        <CaseFormDrawer open={formOpen} editing={editing} projectId={pid} modules={tree}
          members={members}
          onClose={() => setFormOpen(false)} onSaved={() => { void load(); void loadTree(); }} />

        <Modal centered open={purge !== null} onCancel={() => { setPurge(null); setPurgeName(""); }}
          width={520} title="彻底删除用例？" okText="我已确认，彻底删除" cancelText="取消"
          okButtonProps={{ danger: true, disabled: purgeName !== (purge?.name ?? ""), loading: purging }}
          onOk={() => void submitPurge()}>
          <Typography.Paragraph>
            「{purge?.name}」将被物理删除，<Typography.Text strong>无法恢复</Typography.Text>；
            自定义字段值会一并清掉。
          </Typography.Paragraph>
          <Input data-testid="fc-purge-confirm" value={purgeName} autoFocus
            placeholder={purge?.name} onChange={(e) => setPurgeName(e.target.value)} />
        </Modal>

        {/* D254：批量彻底删除——短语确认替代逐字名称（批量里没法输 N 个名字）。 */}
        <Modal centered open={batchPurgeOpen} width={520} title="彻底删除所选用例？"
          okText="我已确认，彻底删除" cancelText="取消"
          okButtonProps={{ danger: true, disabled: batchPurgeWord !== "彻底删除", loading: batchPurging }}
          onCancel={() => { setBatchPurgeOpen(false); setBatchPurgeWord(""); }}
          onOk={() => void doBatchPurge()}>
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <div data-testid="fc-batch-purge-summary">
              「{selectedRows.slice(0, 3).map((r) => r.name).join("」「")}」
              {selectedRows.length > 3 ? ` 等 ${selectedRows.length} 条` : ""}将被物理删除，
              <Typography.Text strong>无法恢复</Typography.Text>；步骤与执行记录一并清理。
            </div>
            <div>
              <Typography.Text type="secondary" className="tp-text-sm">
                输入「彻底删除」四个字确认（不在回收站的用例会被跳过）
              </Typography.Text>
              <Input data-testid="fc-batch-purge-confirm" value={batchPurgeWord} autoFocus
                placeholder="彻底删除" onChange={(e) => setBatchPurgeWord(e.target.value)} />
            </div>
          </Space>
        </Modal>

        {/* D232：批量编辑——只露两个真实列；「不修改模块」与「未分类」是两件事。 */}
        <Modal centered open={batchOpen} width={480} title={`批量编辑 ${selectedIds.length} 条用例`}
          okText="保存" cancelText="取消" confirmLoading={batchBusy}
          onCancel={() => setBatchOpen(false)} onOk={() => void submitBatch()}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <div>
              <Typography.Text type="secondary" className="tp-text-sm">优先级（留空 = 不改）</Typography.Text>
              <Select allowClear placeholder="不改" style={{ width: "100%" }} value={batchPrio}
                data-testid="fc-batch-priority"
                options={["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v }))}
                onChange={(v) => setBatchPrio(v)} />
            </div>
            <div>
              <Typography.Text type="secondary" className="tp-text-sm">模块</Typography.Text>
              <Select style={{ width: "100%" }} value={batchModule} data-testid="fc-batch-module"
                onChange={setBatchModule}
                options={[
                  { value: "__keep__", label: "不修改模块" },
                  { value: "__unfiled__", label: "未分类" },
                  ...flattenModules(tree).map((m) => ({ value: m.value, label: m.label })),
                ]} />
            </div>
            <Typography.Text type="secondary" className="tp-text-sm">
              只改优先级与模块；名称、描述、模板与自定义字段不动。回收站里的用例不参与。
            </Typography.Text>
          </Space>
        </Modal>

        {/* D233：批量复制——副本是新建，评论与前后置关系不跟着走。 */}
        <Modal centered open={copyOpen} width={480} title={`批量复制 ${selectedIds.length} 条用例`}
          okText="复制" cancelText="取消" confirmLoading={copyBusy}
          onCancel={() => setCopyOpen(false)} onOk={() => void submitCopy()}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <div>
              <Typography.Text type="secondary" className="tp-text-sm">目标模块</Typography.Text>
              <Select style={{ width: "100%" }} value={copyModule} data-testid="fc-copy-module"
                onChange={setCopyModule}
                options={[
                  { value: "__same__", label: "保持原模块" },
                  { value: "__unfiled__", label: "未分类" },
                  ...flattenModules(tree).map((m) => ({ value: m.value, label: m.label })),
                ]} />
            </div>
            <div>
              <Typography.Text type="secondary" className="tp-text-sm">名称后缀（留空 = 与源同名）</Typography.Text>
              <Input data-testid="fc-copy-suffix" maxLength={32} value={copySuffix}
                onChange={(e) => setCopySuffix(e.target.value)} />
            </div>
            <Typography.Text type="secondary" className="tp-text-sm">
              复制模板、名称、优先级、描述、责任人与自定义值；评论与前后置关系不复制。回收站里的用例不参与。
            </Typography.Text>
          </Space>
        </Modal>

        {/* D236：统计——分组之和等于总数；范围跟随当前视图。 */}
        <Modal centered open={statsOpen} width={560} title="用例统计"
          onCancel={() => setStatsOpen(false)}
          footer={<Button onClick={() => setStatsOpen(false)}>关闭</Button>}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Space wrap>
              <Typography.Text strong>分组</Typography.Text>
              <Select data-testid="fc-stats-groupby" style={{ width: 140 }} value={statsGroup}
                options={[
                  { value: "priority", label: "优先级" },
                  { value: "module", label: "模块" },
                  { value: "creator", label: "创建人" },
                  { value: "owner", label: "责任人" },
                ]}
                onChange={(v) => void loadStats(v as CaseStatsGroupBy)} />
              <Typography.Text type="secondary" className="tp-text-sm">
                {inRecycled ? "统计范围：回收站" : "统计范围：正常用例"}
              </Typography.Text>
            </Space>
            <Typography.Text data-testid="fc-stats-total">
              共 {stats?.total ?? 0} 条 · 回收站 {stats?.recycled_total ?? 0} 条
            </Typography.Text>
            <div data-testid="fc-stats-body" style={{ opacity: statsBusy ? 0.5 : 1 }}>
              {(stats?.groups ?? []).map((g) => {
                const total = stats?.total ?? 0;
                const pct = total ? Math.round((g.count * 100) / total) : 0;
                return (
                  <div key={g.key || "__none__"} data-testid="fc-stats-row" style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <Typography.Text>{g.label}</Typography.Text>
                      <Typography.Text type="secondary">{g.count} · {pct}%</Typography.Text>
                    </div>
                    <Progress percent={pct} showInfo={false} size="small" />
                  </div>
                );
              })}
              {stats && stats.groups.length === 0 && (
                <Typography.Text type="secondary">这个视图下还没有用例</Typography.Text>
              )}
            </div>
          </Space>
        </Modal>

        <Modal centered open={importErrs !== null} onCancel={() => setImportErrs(null)}
          footer={<Button type="primary" onClick={() => setImportErrs(null)}>知道了</Button>}
          width={620} title="导入未通过（一行都没写入）">
          <Alert type="error" showIcon message={importErrs?.message ?? "导入失败"} />
          {importErrs && importErrs.rows.length > 0 && (
            <ul style={{ margin: "12px 0 0", paddingLeft: 18 }}>
              {importErrs.rows.slice(0, 12).map((e, i) => (
                <li key={i}><Typography.Text>第 {e.row} 行：{e.message}</Typography.Text></li>
              ))}
              {importErrs.rows.length > 12 && (
                <li><Typography.Text type="secondary">
                  还有 {importErrs.rows.length - 12} 行错误未列出
                </Typography.Text></li>
              )}
            </ul>
          )}
        </Modal>

        {/* D268：脑图抽屉。标题点明边界（用例只挂模块），免得用户以为便签能装用例。 */}
        <Drawer title="用例脑图" open={mindOpen} width={760} destroyOnHidden
          onClose={() => setMindOpen(false)} data-testid="fc-mind-drawer">
          <Typography.Paragraph type="secondary" className="tp-text-sm">
            脑图 = 模块树 + 便签 + 用例。用例只能挂在模块下；便签用来写字，可以挂模块或其他便签。
          </Typography.Paragraph>
          <CaseMindmap projectId={pid} canEdit={canUpdate}
            onOpenCase={(id) => { setMindOpen(false); nav("/functional/cases/" + id); }} />
        </Drawer>
      </div>
    </div>
  );
}

export default function FunctionalCasesPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-functional-cases" className="tp-fill-stack">
      <PageHead title="功能用例" descHover
        desc="用例本体：模块树、模板动态字段、项目内编号与回收站；评审在后续批次。" />
      <ProjectGate>{project ? <CasesList /> : null}</ProjectGate>
    </div>
  );
}

// 供详情页复用的模块名映射（避免两处各写一份）
export { moduleNameMap, flattenModules };
