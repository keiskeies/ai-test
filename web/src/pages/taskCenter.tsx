// 任务中心（D196）：运行概览 + 排队位次 + 停止/重跑 + 详情。
// 数据只来自后端读时聚合（run_record + Celery 队列），页面不编造后台任务。
import { useCallback, useEffect, useState } from "react";
import {
  Alert, Button, Input, Modal, Select, Space, Statistic, Tag, Typography, message,
} from "antd";
import { ReloadOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import StateView from "../ui/StateView";
import { FilterBar } from "../ui/Toolbar";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get } from "../api/client";
import {
  SUBJECT_LABELS, TASK_STATUS_META, TRIGGER_LABELS, taskCenterApi,
  type TaskDetail, type TaskRow, type TaskSummary,
} from "../api/taskcenter";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import {
  applyColumnPrefs, emptyFilter, isFilterEmpty,
  type ColumnChoice, type FilterDoc,
} from "../shared/listFilters";

// D239：列设置面板要露的列（key 与 columns 的 key 逐字一致；ops 是操作钮，不可隐藏）。
const TASK_COL_CHOICES: ColumnChoice[] = [
  { key: "name", label: "任务" },
  { key: "subject_type", label: "类型" },
  { key: "trigger", label: "触发" },
  { key: "status", label: "状态" },
  { key: "pos", label: "排队位次" },
  { key: "elapsed", label: "耗时" },
  { key: "by", label: "触发人" },
  { key: "at", label: "创建时间" },
];

type MemberRow = { user_id: string; account: string | null; name: string | null };

function fmtElapsed(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return ms + " ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + " s";
  return (ms / 60_000).toFixed(1) + " min";
}

function Center() {
  const { project, user } = useAuth();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canStop = can(perms, "task:center:stop");
  const canRerun = can(perms, "task:center:run");

  const [summary, setSummary] = useState<TaskSummary | null>(null);
  const [state, setState] = useState<"active" | "finished">("active");
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  const [kwDraft, setKwDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [subjectType, setSubjectType] = useState<string | undefined>();
  const [queueLength, setQueueLength] = useState<number | null>(null);
  const [queueAvailable, setQueueAvailable] = useState(true);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  // D237：批量停止的勾选集。只放 can_stop 的行（勾了但任务已结束会变成假操作）；
  // 每次重拉后按新行集剪一次，防「翻页前勾的、页上已经没有了」的幽灵选中。
  const [selected, setSelected] = useState<string[]>([]);
  // D239：高级搜索条件组 + 列设置偏好 + 触发人候选（枚举选项来自 runVocab 同源词表）。
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [colPref, setColPref] = useColumnPrefs("task_center", TASK_COL_CHOICES.map((c) => c.key));

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const [s, r] = await Promise.all([
        taskCenterApi.summary(pid),
        taskCenterApi.list({
          project_id: pid, state, subject_type: subjectType,
          keyword: keyword || undefined, current, size: pageSize,
          // 空条件不拼参数（与列表页同一把尺：URL 里不出现骗人的 filter=）
          filter: isFilterEmpty(advFilter) ? undefined : JSON.stringify(advFilter),
        }),
      ]);
      setSummary(s); setRows(r.items); setTotal(r.total);
      setSelected((prev) => prev.filter((id) => r.items.some((x) => x.id === id && x.can_stop)));
      if (state === "active") {
        const q = await taskCenterApi.queue(pid).catch(() => null);
        setQueueLength(q?.queue_length ?? null);
        setQueueAvailable(q?.available ?? false);
      }
    } catch (e) {
      setRows([]); setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "任务列表加载失败");
    } finally { setLoading(false); }
  }, [pid, state, subjectType, keyword, current, pageSize, advFilter]);
  useEffect(() => { void load(); }, [load]);

  // 触发人候选：只用于高级搜索下拉（列表里的名字由后端 created_by_name 给，不靠这份）。
  // 拉不到就空着——筛选仍然可以按 id 走，不把「没取到成员」演成页面报错。
  useEffect(() => {
    void (async () => {
      try {
        const r = await get<{ items: MemberRow[] }>("/projects/" + encodeURIComponent(pid) + "/members",
          { silent: true });
        setMembers(r.items);
      } catch { setMembers([]); }
    })();
  }, [pid]);

  async function stop(row: TaskRow): Promise<void> {
    Modal.confirm({
      centered: true, title: "停止任务「" + row.subject_name + "」？",
      content: "取消旗在步骤边界生效；已完成的步骤与结果保留可读。",
      okText: "停止", cancelText: "取消", okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await taskCenterApi.stop(pid, row.id);
          message.success("已请求停止");
          await load();
        } catch { /* toast */ }
      },
    });
  }

  async function batchStop(): Promise<void> {
    if (selected.length === 0) return;
    Modal.confirm({
      centered: true, title: "停止选中的 " + selected.length + " 个任务？",
      content: "取消旗在步骤边界生效；已结束或已在取消中的任务会被跳过，结果按条计数。",
      okText: "批量停止", cancelText: "取消", okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const out = await taskCenterApi.batchStop(pid, selected);
          const extra = (out.skipped ? "，跳过 " + out.skipped : "")
            + (out.failed.length ? "，失败 " + out.failed.length : "");
          message.success("已停止 " + out.stopped + " 个任务" + extra);
          setSelected([]);
          await load();
        } catch { /* toast */ }
      },
    });
  }

  async function rerun(row: TaskRow): Promise<void> {
    try {
      const out = await taskCenterApi.rerun(pid, row.id);
      message.success("已重新投递：" + out.run_id.slice(0, 8));
      setState("active");
      await load();
    } catch { /* toast */ }
  }

  async function openDetail(row: TaskRow): Promise<void> {
    setDetailErr(null);
    try { setDetail(await taskCenterApi.detail(pid, row.id)); }
    catch (e) { setDetailErr(e instanceof ApiErr ? e.message : "详情加载失败"); }
  }

  // 高级搜索下拉候选：类型/触发/状态三轴直接用页面上同一份词表（runVocab 是唯一真相）；
  // 触发人是成员列表（拉不到就空着——仍可按 id 筛，不把拉取失败演成页面故障）。
  const filterValueOptions: Record<string, Option[]> = {
    subject_type: Object.entries(SUBJECT_LABELS).map(([value, label]) => ({ value, label })),
    trigger: Object.entries(TRIGGER_LABELS).map(([value, label]) => ({ value, label })),
    status: Object.entries(TASK_STATUS_META).map(([value, m]) => ({ value, label: m.label })),
    created_by: members.map((m) => ({ value: m.user_id, label: m.name ?? m.account ?? m.user_id })),
  };

  return (
    <div className="tp-fill tp-fill-body">
      <div style={{ flex: "0 0 auto" }}>
        <div className="tp-card" style={{ padding: 12, marginBottom: 12 }} data-testid="task-summary">
          <Space size={32} wrap>
            <Statistic title="任务总数" value={summary?.total ?? 0} />
            <Statistic title="排队中" value={summary?.queued ?? 0} />
            <Statistic title="运行中" value={summary?.running ?? 0} />
            <Statistic title="通过率" value={summary?.pass_rate ?? 0} suffix="%" precision={2} />
            <Statistic title="平均耗时" value={summary?.avg_elapsed_ms ?? 0}
              formatter={(v) => fmtElapsed(Number(v))} />
            {state === "active" && (
              <Statistic title="队列长度" value={queueAvailable ? (queueLength ?? 0) : "—"} />
            )}
          </Space>
        </div>
        {/* D239：任务中心高级搜索。条件是 WHERE（后端 TASK_LIST_FILTER），与下方
            state/类型/keyword 快捷筛选并行 AND；筛选一变回第 1 页。 */}
        <ListToolbar projectId={pid} viewType="task_center"
          filter={advFilter} onFilterChange={(f) => { setAdvFilter(f); setCurrent(1); }}
          allColumns={TASK_COL_CHOICES} columnPref={colPref} onColumnPrefChange={setColPref}
          valueOptions={filterValueOptions}
          canSaveView={can(perms, "search:view:create")}
          canDeleteView={can(perms, "search:view:delete")} />
        <FilterBar actions={(
          <>
            <Select value={state} style={{ width: 120 }}
              onChange={(v) => { setState(v as "active" | "finished"); setCurrent(1); }}
              options={[{ value: "active", label: "运行中" }, { value: "finished", label: "已结束" }]} />
            <Select allowClear placeholder="任务类型" style={{ width: 130 }} value={subjectType}
              onChange={(v) => { setSubjectType(v); setCurrent(1); }}
              options={Object.entries(SUBJECT_LABELS).map(([value, label]) => ({ value, label }))} />
            {canStop && (
              <Button danger data-testid="task-batch-stop" disabled={selected.length === 0}
                onClick={() => void batchStop()}>
                批量停止{selected.length ? "（" + selected.length + "）" : ""}
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
          </>
        )}>
          <Input.Search allowClear placeholder="名称 / run id" style={{ width: 220 }} value={kwDraft}
            onChange={(e) => setKwDraft(e.target.value)}
            onSearch={() => { setKeyword(kwDraft.trim()); setCurrent(1); }} />
        </FilterBar>
        {loadError && <Alert type="error" showIcon style={{ marginBottom: 12 }}
          message="任务列表加载失败" description={loadError} />}
      </div>
      <AdminTable<TaskRow> rowKey="id" loading={loading} dataSource={rows} pagination={false}
        rowSelection={canStop ? {
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys.map(String)),
          getCheckboxProps: (r) => ({ disabled: !r.can_stop }),
        } : undefined}
        locale={{ emptyText: loadError ? (
          <StateView kind="error" title="任务列表没取到，以上方提示为准"
            action={<Button size="small" onClick={() => void load()}>重试</Button>} />
        ) : <StateView title={state === "active" ? "当前没有运行中或排队中的任务" : "还没有已结束的任务"} /> }}
        columns={applyColumnPrefs([
          { title: "任务", key: "name", render: (_, r) => (
            <Typography.Link onClick={() => void openDetail(r)} data-testid="task-row-name">
              {r.subject_name}
            </Typography.Link>) },
          { title: "类型", key: "subject_type", dataIndex: "subject_type", width: 100, render: (v: string) => (
            <Tag>{SUBJECT_LABELS[v] ?? v}</Tag>) },
          { title: "触发", key: "trigger", dataIndex: "trigger", width: 90, render: (v: string) => (
            TRIGGER_LABELS[v] ?? v) },
          { title: "状态", key: "status", dataIndex: "status", width: 100, render: (v: string, r) => {
            const m = TASK_STATUS_META[v] ?? { label: v, color: "default" };
            return (
              <Space size={4}>
                <Tag color={m.color}>{m.label}</Tag>
                {r.cancel_requested && <Tag color="warning">取消中</Tag>}
              </Space>
            );
          } },
          { title: "排队位次", key: "pos", width: 100, render: (_, r) => (
            r.queue_position != null ? "#" + r.queue_position : "—") },
          { title: "耗时", key: "elapsed", width: 100, render: (_, r) => fmtElapsed(r.elapsed_ms) },
          { title: "触发人", key: "by", width: 110, render: (_, r) => r.created_by_name ?? "—" },
          { title: "创建时间", key: "at", width: 150, render: (_, r) => (
            <Typography.Text type="secondary" className="tp-text-sm">
              {fmtTime(r.created_at, { seconds: false }) ?? "—"}
            </Typography.Text>) },
          { title: "", key: "ops", width: 160, render: (_, r) => (
            <Space size={4}>
              {canStop && r.can_stop && (
                <Button size="small" danger data-testid="task-stop" onClick={() => void stop(r)}>
                  停止
                </Button>
              )}
              {canRerun && r.can_rerun && (
                <Button size="small" data-testid="task-rerun" onClick={() => void rerun(r)}>
                  重跑
                </Button>
              )}
              <Button size="small" onClick={() => void openDetail(r)}>详情</Button>
            </Space>) },
        ], colPref)}
        cardFooter={(
          <div className="tp-cardfoot">
            <Typography.Text type="secondary" className="tp-cardfoot-note tp-text-sm">
              {queueAvailable ? "" : "队列位次暂不可用（Redis 未连上）· "}
              队列位次来自 Celery 实际队列，不是估算
            </Typography.Text>
            <ListPager current={current} pageSize={pageSize} total={total}
              onPage={setCurrent} onPageSize={(s) => { setPageSize(s); setCurrent(1); }} />
          </div>
        )}
      />

      <Modal open={detail !== null || detailErr !== null} onCancel={() => { setDetail(null); setDetailErr(null); }}
        centered width={640} footer={null} title="任务详情">
        {detailErr && <Alert type="error" showIcon message={detailErr} />}
        {detail && (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Typography.Title level={5} style={{ margin: 0 }}>{detail.subject_name}</Typography.Title>
            <Space size={8} wrap>
              <Tag>{SUBJECT_LABELS[detail.subject_type] ?? detail.subject_type}</Tag>
              <Tag color={(TASK_STATUS_META[detail.status] ?? { color: "default" }).color}>
                {(TASK_STATUS_META[detail.status] ?? { label: detail.status }).label}
              </Tag>
              <Typography.Text type="secondary">{detail.trigger}</Typography.Text>
            </Space>
            <Typography.Text>run id：{detail.id}</Typography.Text>
            <Typography.Text>耗时：{fmtElapsed(detail.elapsed_ms)}</Typography.Text>
            <Typography.Text>创建：{fmtTime(detail.created_at) ?? "—"} · 开始：{fmtTime(detail.started_at) ?? "—"} · 结束：{fmtTime(detail.finished_at) ?? "—"}</Typography.Text>
            {detail.error && <Alert type="error" showIcon message={detail.error} />}
            <Typography.Text strong>步骤状态</Typography.Text>
            <Space size={8} wrap>
              {Object.entries(detail.step_counts).length === 0
                ? <Typography.Text type="secondary">没有步骤明细</Typography.Text>
                : Object.entries(detail.step_counts).map(([k, v]) => <Tag key={k}>{k}: {v}</Tag>)}
            </Space>
            {detail.stats && (
              <Typography.Paragraph type="secondary" style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                {JSON.stringify(detail.stats, null, 2)}
              </Typography.Paragraph>
            )}
          </Space>
        )}
      </Modal>
    </div>
  );
}

export default function TaskCenterPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-task-center" className="tp-fill-stack">
      <PageHead title="任务中心" descHover
        desc="排队位次、运行中任务、停止与重跑；数据来自 run_record 与 Celery 实际队列。" />
      <ProjectGate>{project ? <Center /> : null}</ProjectGate>
    </div>
  );
}
