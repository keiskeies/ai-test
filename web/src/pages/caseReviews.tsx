// 用例评审列表（D194）：评审模块树 + 评审列表 + 新建评审（选用例/评审人）。
// 评审状态与通过率由后端读时聚合，前端不重算。
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Checkbox, Input, Modal, Progress, Select, Space, Tag, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import StateView from "../ui/StateView";
import { FilterBar } from "../ui/Toolbar";
import ModuleTree, { type ModNode } from "../api/ModuleTree";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get } from "../api/client";
import { functionalApi, type CaseRow } from "../api/functional";
import {
  reviewApi, REVIEW_STATUS_META, type ReviewModuleNode, type ReviewRow,
} from "../api/review";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import { applyColumnPrefs, emptyFilter, isFilterEmpty } from "../shared/listFilters";
import type { ColumnChoice, FilterDoc } from "../shared/listFilters";

type MemberRow = { user_id: string; account: string | null; name: string | null };

// D221：列设置面板（列表八列，操作列不在内）。「状态/通过率」是后端读时聚合的展示列，
// 可以藏但**不可筛**（筛选白名单见后端 CASE_REVIEW_LIST_FILTER）。
const REVIEW_COL_CHOICES: ColumnChoice[] = [
  { key: "num", label: "ID" },
  { key: "name", label: "名称" },
  { key: "status", label: "状态" },
  { key: "rate", label: "通过率" },
  { key: "pass_rule", label: "规则" },
  { key: "reviewer_count", label: "评审人" },
  { key: "creator", label: "创建人" },
  { key: "upd", label: "更新时间" },
];

function toModNodes(nodes: ReviewModuleNode[]): ModNode[] {
  return nodes.map((n) => ({
    id: n.id, parent_id: n.parent_id, name: n.name, sort: n.sort, status: n.status,
    count: n.review_count, children: toModNodes(n.children),
  }));
}

function flattenModules(nodes: ReviewModuleNode[], depth = 0): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const n of nodes) {
    out.push({ value: n.id, label: "　".repeat(depth) + n.name });
    out.push(...flattenModules(n.children, depth + 1));
  }
  return out;
}

function CreateReviewModal({ open, projectId, modules, members, onClose, onSaved }: {
  open: boolean;
  projectId: string;
  modules: ReviewModuleNode[];
  members: MemberRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [passRule, setPassRule] = useState<"single" | "multiple">("single");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [caseIds, setCaseIds] = useState<string[]>([]);
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(""); setModuleId(null); setDescription(""); setPassRule("single");
    setStartAt(""); setEndAt(""); setCaseIds([]); setReviewerIds([]); setErr(null);
    void (async () => {
      try {
        const r = await functionalApi.listCases({ project_id: projectId, current: 1, size: 200 });
        setCases(r.items.filter((c) => !c.recycled));
      } catch { setCases([]); }
    })();
  }, [open, projectId]);

  async function submit(): Promise<void> {
    if (!name.trim()) { message.warning("评审名称必填"); return; }
    if (caseIds.length === 0) { message.warning("至少选择一条用例"); return; }
    if (reviewerIds.length === 0) { message.warning("至少选择一位评审人"); return; }
    setBusy(true); setErr(null);
    try {
      await reviewApi.create({
        project_id: projectId, module_id: moduleId, name: name.trim(), description,
        pass_rule: passRule,
        start_at: startAt ? new Date(startAt).toISOString() : null,
        end_at: endAt ? new Date(endAt).toISOString() : null,
        case_ids: caseIds, reviewer_ids: reviewerIds,
      });
      message.success("评审已创建");
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof ApiErr) setErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} centered width={720} destroyOnHidden
      title="新建用例评审" okText="创建" cancelText="取消"
      okButtonProps={{ loading: busy, "data-testid": "review-save" }} onOk={() => void submit()}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input data-testid="review-field-name" maxLength={255} value={name}
            onChange={(e) => setName(e.target.value)} />
        </div>
        <Space size={16} wrap>
          <div>
            <Typography.Text strong>模块</Typography.Text>
            <Select allowClear style={{ width: 200 }} value={moduleId ?? undefined}
              placeholder="未分类" onChange={(v) => setModuleId(v ?? null)}
              options={flattenModules(modules)} />
          </div>
          <div>
            <Typography.Text strong>通过规则</Typography.Text>
            <Select style={{ width: 150 }} value={passRule}
              onChange={(v) => setPassRule(v as "single" | "multiple")}
              options={[{ value: "single", label: "单人通过" }, { value: "multiple", label: "多人通过" }]} />
          </div>
        </Space>
        <Space size={16} wrap>
          <div>
            <Typography.Text strong>开始时间</Typography.Text>
            <Input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </div>
          <div>
            <Typography.Text strong>结束时间</Typography.Text>
            <Input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
          </div>
        </Space>
        <div>
          <Typography.Text strong>描述</Typography.Text>
          <Input.TextArea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>用例（最多列出前 200 条）</Typography.Text>
          <Select data-testid="review-field-cases" mode="multiple" style={{ width: "100%" }}
            value={caseIds} onChange={setCaseIds} optionFilterProp="label"
            placeholder="选择要评审的用例"
            options={cases.map((c) => ({ value: c.id, label: c.num + " " + c.name }))} />
        </div>
        <div>
          <Typography.Text strong>评审人</Typography.Text>
          <Select data-testid="review-field-reviewers" mode="multiple" style={{ width: "100%" }}
            value={reviewerIds} onChange={setReviewerIds} optionFilterProp="label"
            placeholder="选择评审人"
            options={members.map((m) => ({ value: m.user_id, label: m.name ?? m.account ?? m.user_id }))} />
        </div>
        {err && <Alert type="error" showIcon data-testid="review-save-error" message={err} />}
      </Space>
    </Modal>
  );
}

function ReviewsList() {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canCreate = can(perms, "review:review:create");
  const canDelete = can(perms, "review:review:delete");
  const canModuleCreate = can(perms, "review:module:create");
  const canModuleDelete = can(perms, "review:module:delete");

  const [tree, setTree] = useState<ReviewModuleNode[]>([]);
  const [recycled, setRecycled] = useState<ReviewModuleNode[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [inRecycled, setInRecycled] = useState(false);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  const [kwDraft, setKwDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<string | undefined>();
  const [createdByMe, setCreatedByMe] = useState(false);
  const [reviewingMe, setReviewingMe] = useState(false);
  const [myTodo, setMyTodo] = useState(false);
  // D221：高级搜索条件 + 列偏好（键 case_review，与后端 view_type 同字）。条件与左树模块、
  // 关键词、状态、我相关三开关并行（后端同一个 WHERE），不是替代关系。
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const [colPref, setColPref] = useColumnPrefs("case_review",
    REVIEW_COL_CHOICES.map((c) => c.key));
  const [createOpen, setCreateOpen] = useState(false);
  const [del, setDel] = useState<ReviewRow | null>(null);
  const [delName, setDelName] = useState("");
  const [deleting, setDeleting] = useState(false);

  const loadTree = useCallback(async () => {
    setTreeError(null);
    try {
      const t = await reviewApi.tree(pid, inRecycled);
      setTree(t.tree); setRecycled(t.recycled);
    } catch (e) {
      setTree([]); setRecycled([]);
      setTreeError(e instanceof ApiErr ? e.message : "评审模块加载失败");
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
    setLoading(true); setLoadError(null);
    try {
      const r = await reviewApi.list({
        project_id: pid, module_id: selected ?? undefined, keyword: keyword || undefined,
        status, created_by_me: createdByMe || undefined, reviewing_me: reviewingMe || undefined,
        my_todo: myTodo || undefined, current, size: pageSize,
        // D221：空条件整个参数不上线（后端把空串读成「没筛选」只是兜底）
        filter: isFilterEmpty(advFilter) ? undefined : JSON.stringify(advFilter),
      });
      setRows(r.items); setTotal(r.total);
    } catch (e) {
      setRows([]); setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "评审列表加载失败");
    } finally { setLoading(false); }
  }, [pid, selected, keyword, status, createdByMe, reviewingMe, myTodo, current, pageSize,
      advFilter]);
  useEffect(() => { void load(); }, [load]);

  async function submitDelete(): Promise<void> {
    if (!del) return;
    setDeleting(true);
    try {
      await reviewApi.remove(pid, del.id, delName);
      message.success("评审已删除");
      setDel(null); setDelName("");
      await load();
    } catch { /* toast */ } finally { setDeleting(false); }
  }

  return (
    <div className="tp-fill tp-fill-body" style={{ flexDirection: "row", alignItems: "stretch" }}>
      <div style={{ width: 240, flex: "0 0 240px", marginRight: 12, overflow: "auto" }}>
        <ModuleTree projectId={pid} tree={toModNodes(tree)} recycled={toModNodes(recycled)}
          inRecycled={inRecycled}
          onToggleRecycled={(v) => { setInRecycled(v); setSelected(null); }}
          selected={selected} onSelect={(id) => { setSelected(id); setCurrent(1); }}
          onChanged={() => { void loadTree(); void load(); }}
          canManage={canModuleDelete} canCreate={canModuleCreate}
          apiBase="/case-review-modules" allLabel="全部评审" noun="评审"
          loadError={treeError}
          countTip="徽标是该模块直属的评审数（不含子模块）"
          deleteHint="模块下还有子模块或评审时会被拒绝（409）；请先移走或回收它们。" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }} className="tp-fill tp-fill-body">
        <div style={{ flex: "0 0 auto" }}>
          {/* D221：D47-a 三件套（视图保存 / 高级搜索 / 列设置）铺到评审页。条件与左树/
              快捷搜索/状态/我相关三开关并行（后四者是视图/取数轴）。 */}
          <ListToolbar
            projectId={pid} viewType="case_review"
            filter={advFilter} onFilterChange={(f) => { setAdvFilter(f); setCurrent(1); }}
            allColumns={REVIEW_COL_CHOICES}
            columnPref={colPref} onColumnPrefChange={setColPref}
            canSaveView canDeleteView
            valueOptions={{
              pass_rule: [{ value: "single", label: "单人通过" },
                          { value: "multiple", label: "多人通过" }],
              created_by: members.map((m) => ({ value: m.user_id,
                                                label: m.name ?? m.account ?? m.user_id })),
            }}
          />
          <FilterBar actions={(
            <>
              {canCreate && (
                <Button type="primary" icon={<PlusOutlined />} data-testid="review-new"
                  onClick={() => setCreateOpen(true)}>
                  新建评审
                </Button>
              )}
              <Button icon={<ReloadOutlined />} onClick={() => { void load(); void loadTree(); }}>刷新</Button>
            </>
          )}>
            <Space wrap size={8}>
              <Input.Search data-testid="review-filter-keyword" allowClear placeholder="评审名称/描述"
                style={{ width: 200 }} value={kwDraft} onChange={(e) => setKwDraft(e.target.value)}
                onSearch={() => { setKeyword(kwDraft.trim()); setCurrent(1); }} />
              <Select allowClear placeholder="状态" style={{ width: 120 }} value={status}
                options={Object.entries(REVIEW_STATUS_META).map(([value, m]) => ({ value, label: m.label }))}
                onChange={(v) => { setStatus(v); setCurrent(1); }} />
              <Checkbox checked={createdByMe} onChange={(e) => { setCreatedByMe(e.target.checked); setCurrent(1); }}>
                我创建的
              </Checkbox>
              <Checkbox checked={reviewingMe} onChange={(e) => { setReviewingMe(e.target.checked); setCurrent(1); }}>
                我评审的
              </Checkbox>
              <Checkbox checked={myTodo} onChange={(e) => { setMyTodo(e.target.checked); setCurrent(1); }}>
                我的待办
              </Checkbox>
            </Space>
          </FilterBar>
          {loadError && <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="review-load-error"
            message="评审列表加载失败" description={loadError} />}
        </div>
        <AdminTable<ReviewRow> rowKey="id" loading={loading} dataSource={rows} pagination={false}
          locale={{ emptyText: loadError ? (
            <StateView kind="error" title="评审列表没取到，以上方提示为准"
              action={<Button size="small" onClick={() => void load()}>重试</Button>} />
          ) : <StateView title={canCreate ? "还没有评审，点「新建评审」开始" : "当前筛选下还没有评审"} /> }}
          columns={applyColumnPrefs([
            { title: "ID", key: "num", dataIndex: "num", width: 90 },
            { title: "名称", key: "name", dataIndex: "name", render: (v: string, r) => (
              <Typography.Link data-testid="review-row-name" onClick={() => nav("/reviews/" + r.id)}>
                {v}
              </Typography.Link>) },
            { title: "状态", key: "status", dataIndex: "status", width: 100, render: (v: string) => {
              const m = REVIEW_STATUS_META[v] ?? { label: v, color: "default" };
              return <Tag color={m.color}>{m.label}</Tag>;
            } },
            { title: "通过率", key: "rate", width: 160, render: (_, r) => (
              <Space size={6}>
                <Progress percent={r.pass_rate} size="small" style={{ width: 90 }}
                  status={r.status === "completed" && r.pass_count < r.case_count ? "exception" : "normal"} />
                <Typography.Text className="tp-text-sm">{r.pass_count}/{r.case_count}</Typography.Text>
              </Space>) },
            { title: "规则", key: "pass_rule", dataIndex: "pass_rule", width: 100, render: (v: string) => (
              <Tag>{v === "multiple" ? "多人" : "单人"}</Tag>) },
            { title: "评审人", key: "reviewer_count", dataIndex: "reviewer_count", width: 80 },
            { title: "创建人", key: "creator", width: 110, render: (_, r) => r.created_by_name ?? "—" },
            { title: "更新时间", key: "upd", width: 140, render: (_, r) => (
              <Typography.Text type="secondary" className="tp-text-sm">
                {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
              </Typography.Text>) },
            { title: "", key: "ops", width: 90, render: (_, r) => (
              canDelete && (
                <Button size="small" danger data-testid="review-del"
                  onClick={() => { setDel(r); setDelName(""); }}>删除</Button>
              )) },
          ], colPref)}
          cardFooter={(
            <div className="tp-cardfoot">
              <Typography.Text type="secondary" className="tp-cardfoot-note tp-text-sm">
                {loadError ? "本次列表加载失败，本行计数不作数" : ""}
                通过率与状态由评审内用例结论实时聚合
              </Typography.Text>
              <ListPager current={current} pageSize={pageSize} total={total}
                onPage={setCurrent} onPageSize={(s) => { setPageSize(s); setCurrent(1); }} />
            </div>
          )}
        />

        <CreateReviewModal open={createOpen} projectId={pid} modules={tree} members={members}
          onClose={() => setCreateOpen(false)}
          onSaved={() => { void load(); void loadTree(); }} />

        <Modal centered open={del !== null} onCancel={() => { setDel(null); setDelName(""); }}
          width={520} title="删除评审？" okText="我已确认，删除" cancelText="取消"
          okButtonProps={{ danger: true, disabled: delName !== (del?.name ?? ""), loading: deleting }}
          onOk={() => void submitDelete()}>
          <Typography.Paragraph>
            「{del?.name}」及其全部关联、评审人与结论历史将被物理删除，<Typography.Text strong>无法恢复</Typography.Text>。
          </Typography.Paragraph>
          <Input data-testid="review-del-confirm" value={delName} autoFocus
            placeholder={del?.name} onChange={(e) => setDelName(e.target.value)} />
        </Modal>
      </div>
    </div>
  );
}

export default function CaseReviewsPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-case-reviews" className="tp-fill-stack">
      <PageHead title="用例评审" descHover
        desc="把功能用例放进评审、分派评审人、提交结论；状态与通过率由结论实时聚合。" />
      <ProjectGate>{project ? <ReviewsList /> : null}</ProjectGate>
    </div>
  );
}

export { flattenModules };
