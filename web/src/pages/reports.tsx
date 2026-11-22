// 报告中心（T22，§11.4.15）：时间（默认近 7 天）/场景/触发/执行人/环境/结果筛选 +
// 通过率环形进度 + 「含调试」开关（默认关——Review Focus 11：报告是结论，调试去运行记录页）。
// 诚实条款：没有批量删除——后端没有报告删除端点（执行记录是审计事实，§14），
// 计划里的「批量[删除]」随现实修正为不做，不做假按钮。
// 契约（nav.spec 钉）：根节点 data-testid="page-reports" + PageHead 标题「报告中心」。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Progress, Select, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import { ReloadOutlined } from "../ui/icons";
import type { ColumnsType } from "antd/es/table";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import { useAuth } from "../auth/store";
import { reportApi, type ReportRow } from "../api/report";
import { sceneApi } from "../api/scene";
import { get } from "../api/client";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { SELECTABLE_TRIGGERS, STATUSES, SUBJECT_TYPES, TRIGGERS, vocabMeta } from "../shared/runVocab";
import { pctAttr, ratePctNum } from "../shared/passRate";
import { useNavigate } from "react-router-dom";
import type { EnvRow, Page } from "../api/api";

/** 通过率环：null（分母≤0，全跳步/空集）画「-」，不画 0%——0% 是结论，「-」是没结论。 */
export function PassRing({ rate, size = 34 }: { rate: number | null; size?: number }) {
  if (rate == null) {
    return (
      <span data-testid="report-pass-rate" data-percent={pctAttr(rate)}
        style={{ display: "inline-flex", width: size, alignItems: "center", justifyContent: "center", color: "var(--tp-text-3)" }}>
        -
      </span>
    );
  }
  const pct = ratePctNum(rate);
  const color = pct >= 100 ? "#2BA47D" : pct >= 60 ? "#D48806" : "#D3564F";
  return (
    // data 属性落在外层 span：antd Progress 不保证转发未知 prop，测试事实不能押在它身上。
    // 值走 pctAttr（和 reportDetail 概览卡外壳同一个函数）——两处若有两份算式，
    // 断言钉住一份就等于没钉（6b V1 变异实测），同源之后分歧在源码层不存在。
    <span data-testid="report-pass-rate" data-percent={pctAttr(rate)} style={{ display: "inline-flex" }}>
      <Progress type="circle" size={size} percent={pct} strokeColor={color} trailColor="#EEF1F0"
        format={() => <span style={{ fontSize: 10 }}>{pct}%</span>} />
    </span>
  );
}

/** 近 N 天的 since（UTC ISO，后端 _parse_iso 认 naive=UTC 口径，R62）。 */
function daysAgoIso(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return d.toISOString().replace("Z", "").replace(/:\d{2}\.\d{3}$/, "");
}

interface Filters {
  days: number; // 7 / 30 / 0=不限
  subject: string; // 场景下拉（列表数据里出现的场景名；后端按 subject_id 筛）
  // R112：对象类型（后端 subject_type 筛选；场景下拉只装场景，UI 运行以前筛不出来）
  subjectType?: string;
  trigger?: string;
  status?: string;
  envId?: string;
  createdBy?: string;
  includeDebug: boolean;
}

function ReportsWorkbench() {
  const { project } = useAuth();
  const pid = project!.id;
  const nav = useNavigate();
  const [items, setItems] = useState<ReportRow[]>([]);
  // D47-b：页码分页（current/size/total）替换「加载更多」游标追加。一页只许有一个
  // 「我在第几页」的真相——按钮和页码并存就是两把尺子，后端拿 400 禁的正是这个。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [sceneOpts, setSceneOpts] = useState<Array<{ value: string; label: string }>>([]);
  const [members, setMembers] = useState<Array<{ user_id: string; name: string | null; account: string | null }>>([]);
  const [f, setF] = useState<Filters>({ days: 7, subject: "", includeDebug: false });
  // 任一筛选变化必回第 1 页：停在第 7 页改筛选，落的是新条件下无关的切片甚至空页，
  // 和换档位是同一个 hazard（listPagination.tsx 注释③）。七个筛选只有 patch 这一个写入口，
  // 回页就钉在这唯一入口处，测试从第 3 页改筛选钉它。
  const patch = (p: Partial<Filters>): void => { setF((old) => ({ ...old, ...p })); setCurrent(1); };

  useEffect(() => {
    get<Page<EnvRow>>("/envs?project_id=" + encodeURIComponent(pid) + "&size=200", { silent: true })
      .then((r) => setEnvs(r.items)).catch(() => undefined);
  }, [pid]);

  // 场景筛选项来自场景列表（列表行里没有 subject_id，选项不能从结果里现攒——
  // 「没进过结果页的场景就筛不到」是假筛选）
  useEffect(() => {
    sceneApi.list({ project_id: pid, size: 200 })
      .then((r) => setSceneOpts(r.items.map((s) => ({ value: s.id, label: s.name }))))
      .catch(() => undefined);
    get<{ items: Array<{ user_id: string; name: string | null; account: string | null }> }>(
      "/projects/" + encodeURIComponent(pid) + "/members", { silent: true })
      .then((r) => setMembers(r.items)).catch(() => undefined);
  }, [pid]);

  // D127 的教训换了形态仍然成立：load 读 current/pageSize 并把它们放进依赖，但 load
  // 自己绝不写 current/pageSize（只有 pager 回调和 patch 写），所以取数落地不会重建
  // load、不会重跑下面的 effect——点一次页码恰好一条请求，没有多余的「回第 1 页」重置。
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailed(false);
    try {
      const q: Record<string, unknown> = { project_id: pid, size: pageSize, current };
      if (f.days > 0) q.since = daysAgoIso(f.days);
      if (f.subject) q.subject_id = f.subject;
      if (f.subjectType) q.subject_type = f.subjectType;
      if (f.trigger) q.trigger = f.trigger;
      if (f.status) q.status = f.status;
      if (f.envId) q.env_id = f.envId;
      if (f.createdBy) q.created_by = f.createdBy;
      if (f.includeDebug) q.include_debug = true;
      const r = await reportApi.list(q as Parameters<typeof reportApi.list>[0]);
      setItems(r.items);
      // total 只从响应来，永不由 items.length 客户端现攒（页内行数不是总数）。
      // 缺键（游标式响应）→ null → ListPager 整块不渲染。
      setTotal(r.total ?? null);
    } catch {
      setFailed(true);
      // 失败不留谎脚注：total 清空，不许在空表上面挂一条陈旧的「共 N 条」。
      setItems([]);
      setTotal(null);
    } finally { setLoading(false); }
  }, [pid, f, current, pageSize]);

  useEffect(() => { void load(); }, [load]);

  // 场景/执行人筛选项走各自的权威列表：从已加载结果里现攒是假筛选
  // （没进过当前结果页的场景/人永远筛不到）。执行人选项=项目成员（value=user_id，
  // 与 run 表的 created_by 同口径）。
  const subjectOpts = sceneOpts;
  const creatorOpts = useMemo(
    () => members.map((m) => ({ value: m.user_id, label: m.name || m.account || m.user_id })),
    [members]);

  const cols: ColumnsType<ReportRow> = [
    { title: "对象", dataIndex: "subject_name", render: (v: string, r) => (
      // D141：ReportListItemOut.subject_name 是 str（report_services.py `class ReportListItemOut` = 52），
      // 旧兜底「…已删除」类型上进不来、语义也是假的，删。
      <a data-testid="reports-row-link" onClick={() => nav("/reports/" + r.id)}>
        {v}
      </a>) },
    { title: "触发", dataIndex: "trigger", width: 96, render: (v: string) => {
        // 徽标查 TRIGGERS 全表：它报的是「这条 run 当时是怎么起来的」，库里既然存了
        // webhook 就得照实画出来（查 SELECTABLE_TRIGGERS 会把它降级成 "? webhook"，
        // 那是把已发生的事演成不认识——筛选才需要裁承诺面，见下面 :168 与 runVocab.ts）。
        const m = TRIGGERS[v] ?? { icon: "?", label: v, color: "default" as const };
        return <Tag data-testid="report-trigger" color={m.color}>{m.icon + " " + m.label}</Tag>;
      } },
    { title: "结果", dataIndex: "status", width: 104, render: (v: string) => {
        const m = vocabMeta(STATUSES, v);
        return <Tag data-testid="report-status" color={m.color}>{m.label}</Tag>;
      } },
    { title: "通过率", dataIndex: "pass_rate", width: 92, render: (v: number | null) => <PassRing rate={v} /> },
    { title: "步骤", key: "steps", width: 72, render: (_, r) => (
      // stats.total = 顶层步骤数（§11.4.15 的「步骤」列口径：看规模，不是叶子计数）
      <Typography.Text data-testid="report-steps" className="tp-mono">
        {typeof r.stats?.total === "number" ? r.stats.total : "—"}
      </Typography.Text>) },
    { title: "耗时", dataIndex: "elapsed_ms", width: 92, render: (v: number | null) => (
      <Typography.Text style={{ fontSize: 12 }}>{v == null ? "—" : v + " ms"}</Typography.Text>) },
    { title: "环境", dataIndex: "env_name", width: 104, render: (v: string | null) => v ?? "—" },
    { title: "执行人", dataIndex: "created_by_name", width: 104, render: (v: string | null) => v ?? "—" },
    { title: "开始时间", dataIndex: "started_at", width: 168, render: (v: string | null) => (
      <Typography.Text data-testid="report-time" style={{ fontSize: 12 }}>{fmtTime(v) ?? "—"}</Typography.Text>) },
  ];

  return (
    <div data-testid="reports-body">
      <Space style={{ marginBottom: 12 }} wrap data-testid="reports-filters">
        <Select data-testid="reports-filter-days" style={{ width: 128 }} value={f.days}
          onChange={(v) => patch({ days: v })}
          options={[{ value: 7, label: "近 7 天" }, { value: 30, label: "近 30 天" }, { value: 0, label: "不限时间" }]} />
        <Select data-testid="reports-filter-scene" style={{ width: 180 }} allowClear showSearch
          optionFilterProp="label" placeholder="场景" value={f.subject || undefined}
          onChange={(v) => patch({ subject: v ?? "" })} options={subjectOpts} />
        <Select data-testid="reports-filter-subject-type" style={{ width: 132 }} allowClear placeholder="对象类型"
          value={f.subjectType} onChange={(v) => patch({ subjectType: v })}
          options={Object.entries(SUBJECT_TYPES).map(([k, v]) => ({ value: k, label: v.label }))} />
        <Select data-testid="reports-filter-trigger" style={{ width: 128 }} allowClear placeholder="触发"
          value={f.trigger} onChange={(v) => patch({ trigger: v })}
          // reserved（如 webhook，写入方是 §12.4 一期 run-hook，待业主裁 D82）不进筛选：
          // 点了必是空表 = 假门（§13 纪律 1）。裁的是承诺面不是数据契约，见 runVocab.ts。
          options={Object.entries(SELECTABLE_TRIGGERS).map(([k, v]) => ({ value: k, label: v.icon + " " + v.label }))} />
        <Select data-testid="reports-filter-status" style={{ width: 128 }} allowClear placeholder="结果"
          value={f.status} onChange={(v) => patch({ status: v })}
          options={Object.entries(STATUSES).map(([k, v]) => ({ value: k, label: v.label }))} />
        <Select data-testid="reports-filter-env" style={{ width: 132 }} allowClear placeholder="环境"
          value={f.envId} onChange={(v) => patch({ envId: v })}
          options={envs.map((e) => ({ value: e.id, label: e.name }))} />
        <Tooltip title="按项目成员筛（名单是项目全员，不限于当前已加载的结果）；全员名单在系统设置里看">
          <Select data-testid="reports-filter-creator" style={{ width: 132 }} allowClear showSearch
            placeholder="执行人" value={f.createdBy} onChange={(v) => patch({ createdBy: v })}
            options={creatorOpts} />
        </Tooltip>
        <Space size={6}>
          <Switch data-testid="reports-include-debug" size="small" checked={f.includeDebug}
            onChange={(v) => patch({ includeDebug: v })} />
          <Typography.Text className="tp-text-sm">含调试</Typography.Text>
        </Space>
        <Button icon={<ReloadOutlined />} data-testid="reports-refresh" loading={loading} onClick={() => void load()}>刷新</Button>
      </Space>
      {failed && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} data-testid="reports-failed"
          message="报告没取到" description="可能是角色刚被改动或网络不通，点「刷新」重试" />
      )}
      <AdminTable<ReportRow>
          rowKey="id" loading={loading} columns={cols} dataSource={items}
          pagination={false} scroll={{ x: 1080 }}
          onRow={(r) => ({
            "data-testid": "reports-row", "data-trigger": r.trigger,
            style: { cursor: "pointer" },
            onClick: () => nav("/reports/" + r.id),
          } as React.HTMLAttributes<HTMLTableRowElement> & { "data-trigger": string })}
          locale={{ emptyText: failed
            ? "暂时取不到报告"
            : f.includeDebug ? "这个条件下还没有报告——跑一次场景就有了" : "还没有报告（调试运行默认不显示，右上角「含调试」可看）" }}
        />
      {/* 表格自身即卡片（.tp-tablecard）：不再外套 Card，避免双边框双圆角。 */}
      {/* D47-b：共享页码分页器。total 缺键（响应没带 total）时 ListPager 整块不渲染，
          这里照旧挂在表格卡之下；「加载更多」随游标语义一起退场（一页两把尺子的老账）。 */}
      <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
        <ListPager
          current={current}
          pageSize={pageSize}
          total={total}
          onPage={setCurrent}
          onPageSize={setPageSize}
        />
      </div>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <div data-testid="page-reports">
      <PageHead title="报告中心"
        desc="场景与 UI 执行的报告归档；调试运行默认不入榜，右上角「含调试」可看。" />
      <ProjectGate>
        <ReportsWorkbench />
      </ProjectGate>
    </div>
  );
}
