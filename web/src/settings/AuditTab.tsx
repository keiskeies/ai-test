// 审计日志（§11.4.27 Tab4 子集）：时间区间 + 入口 + 动作 + 成败筛选，游标「加载更多」。
// 读的是 GET /audit；只有 write 以上入口才落审计（GET 不审计是设计决定），所以这里看到
// 的永远是「动过东西」的记录——空列表不是 bug，得在空态里说清楚。
// 1E T7：区间端点发 YYYY-MM-DD，后端按 Shanghai 日历日解释（与工作台窗口同尺，§3.4-6）；
// 行 [diff] 开双栏 JSON 对照模态（§11.4.27 画的是双栏并排，不是行内 diff）。
import { useCallback, useEffect, useState } from "react";
import AdminTable from "../ui/AdminTable";
import { Alert, Button, Card, DatePicker, Input, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import { ReloadOutlined } from "../ui/icons";
import type { ColumnsType } from "antd/es/table";
import { get, ApiErr } from "../api/client";
import { fmtTime } from "../shared/timefmt";
import AuditDiffModal, { hasComparison } from "./AuditDiffModal";
import { FilterBar, Toolbar } from "../ui/Toolbar";
import StateView from "../ui/StateView";
import type { AuditRow, CandidateRow, Page } from "../api/api";

const PAGE = 20;
const ENTRIES: Record<string, string> = { http: "HTTP", agent: "Pilot", schedule: "定时" };

export default function AuditTab({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [entry, setEntry] = useState<string | undefined>(undefined);
  const [action, setAction] = useState("");
  // 输入框的草稿值：只在回车/点「搜索」/点 × 时与已生效的 action 同步（见下面 Input.Search）
  const [actionDraft, setActionDraft] = useState("");
  const [ok, setOk] = useState<string | undefined>(undefined);
  // §11.5.1 操作人筛选：后端 GET /audit 早收了 user_id（services 里 WHERE 都在），这里补前端接线
  const [uid, setUid] = useState<string | undefined>(undefined);
  const [ops, setOps] = useState<CandidateRow[]>([]);
  // RangePicker 的已选日历日对（"YYYY-MM-DD"）；后端把纯日期按 Shanghai 日历日归界
  const [range, setRange] = useState<[string, string] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // 报错分句：只有 403 配喊「权限/重新登录」，其余失败喊网络——口径同 MembersTab.tsx:46-51
  const [denied, setDenied] = useState(false);
  const [openRow, setOpenRow] = useState<AuditRow | null>(null);
  const [diffRow, setDiffRow] = useState<AuditRow | null>(null);

  const load = useCallback(async (reset: boolean): Promise<void> => {
    setLoading(true);
    setFailed(false);
    try {
      const next = reset ? null : cursor;
      const q = new URLSearchParams({ project_id: projectId, size: String(PAGE) });
      if (entry) q.set("entry", entry);
      if (action.trim()) q.set("action", action.trim());
      if (ok) q.set("ok", ok);
      if (uid) q.set("user_id", uid);
      if (range) { q.set("ts_from", range[0]); q.set("ts_to", range[1]); }
      if (next) q.set("cursor", next);
      const r = await get<Page<AuditRow>>("/audit?" + q.toString(), { silent: true });
      setItems((prev) => (next === null ? r.items : [...prev, ...r.items]));
      setCursor(r.next_cursor);
    } catch (e) { setFailed(true); setDenied(e instanceof ApiErr && e.status === 403); if (reset) { setItems([]); setCursor(null); } }
    finally { setLoading(false); }
  }, [projectId, entry, action, ok, uid, range, cursor]);

  // D128：这是真·受控输入框——value 绑草稿 state，onChange 只改草稿（不是每敲一键查一次）。
  // onSearch 仍守「回车/点钮才查」（业主裁过）；点 × 由 onClear 把已生效的 action 一并清掉，
  // 否则框里空了、查询还带着旧 action（旧注释把没绑 value 的框叫「受控值」，是假的）。
  // 依赖里保留 action：onSearch 改 action → effect 重查，与上面「入口」等筛选同机制。
  // 曾经漏过它——「动作」框回车后状态变了、请求却一个不发，直到动「入口」才把 action 顺带
  // 捎上；而审计页默认列表恰好含那条动作，e2e 就一路绿着（settings.spec.mjs 同形）。
  useEffect(() => { void load(true); }, [projectId, entry, action, ok, uid, range]);

  // 操作人下拉的数据源：复用 MembersTab 加人用的项目内查找（UUID 的唯一合法项目级来源；
  // /system/users 是平台权限位，即使本页只给系统管理员，也保持同一条读法不另开口子）。
  // 拉取失败留空列表即可：筛选是可选件，不该把整页变成报错。
  // 但「列表是空的」不等于「没有匹配的用户」——把没取到说成查无此人，就是拿取数失败化妆成没有数据。
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsFailed, setOpsFailed] = useState(false);
  // 403 单独一句：审计是系统级读（system:audit:read），候选名单是项目级读（project:member:manage），
  // 系统管理员读别人项目的审计是常态，这时喊「重新输入可重试」是死路。分句口径同上面 denied。
  const [opsDenied, setOpsDenied] = useState(false);
  const searchOps = useCallback(async (q: string): Promise<void> => {
    setOpsLoading(true);
    setOpsFailed(false);
    setOpsDenied(false);
    try {
      const r = await get<Page<CandidateRow>>("/project-member-candidates?project_id="
        + encodeURIComponent(projectId) + "&q=" + encodeURIComponent(q) + "&size=50", { silent: true });
      setOps(r.items);
    } catch (e) {
      setOps([]); setOpsFailed(true); setOpsDenied(e instanceof ApiErr && e.status === 403);
    }
    finally { setOpsLoading(false); }
  }, [projectId]);
  useEffect(() => { void searchOps(""); }, [searchOps]);

  // 空态文案要分清「没筛出东西」和「什么都没发生」：五个筛选项任一有值即算带筛选。
  // 注意 action 读的是已生效的 state（onSearch/onClear 才改，草稿 actionDraft 不算），与 load 的口径一致。
  const anyFilter = Boolean(entry || action.trim() || ok || uid || range);

  const cols: ColumnsType<AuditRow> = [
    { title: "时间", dataIndex: "ts", width: 168, render: (v: string | null) => (
      // 换算走 shared/timefmt（§3.4-6：UTC 存储 / Asia/Shanghai 展示）。
      // 原先是 slice(0,19)：形状对、钟点比真实时间早 8 小时，而形状正则的测试抓不到。
      <Typography.Text data-testid="audit-time" className="tp-text-sm"
        >{fmtTime(v) ?? "—"}</Typography.Text>) },
    { title: "操作人", dataIndex: "user_name", width: 110, render: (v: string | null) => v ?? "未知" },
    { title: "入口", dataIndex: "entry", width: 78, render: (v: string) => (
      <Tag data-testid="audit-entry" color={v === "agent" ? "purple" : v === "schedule" ? "geekblue" : "default"}
        >{ENTRIES[v] ?? v}</Tag>) },
    { title: "动作", dataIndex: "action", render: (v: string) => (
      <Typography.Text className="tp-mono" data-testid="audit-action">{v}</Typography.Text>) },
    { title: "结果", dataIndex: "ok", width: 78, render: (v: boolean) => (
      <Tag data-testid="audit-ok" color={v ? "green" : "red"}>{v ? "成功" : "失败"}</Tag>) },
    { title: "", key: "ops", width: 110, render: (_: unknown, r: AuditRow) => (
      <Space size={0}>
        <Button size="small" type="link" data-testid="audit-detail" onClick={() => setOpenRow(r)}>细节</Button>
        {/* §11.4.27 的 [diff]：只有带 before/after 的记录才有对照物，其余置灰而不是开空模态 */}
        <Tooltip title={hasComparison(r.diff) ? "before/after 双栏对照" : "该记录没有 before/after 快照"}>
          <Button size="small" type="link" data-testid="audit-diff" disabled={!hasComparison(r.diff)}
            onClick={() => setDiffRow(r)}>diff</Button>
        </Tooltip>
      </Space>) },
  ];

  return (
    <div data-testid="tab-audit">
      {/* audit-filters 仍是「五个筛选控件都在它里面」的那个容器（AuditTab.test.tsx 用
          node.contains 钉包含关系）；里面再按 FilterBar 的约定分成左筛选 / 右动作。 */}
      <div data-testid="audit-filters">
        <FilterBar actions={(
          <Toolbar>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(true)}>刷新</Button>
          </Toolbar>
        )}>
          {/* 端点发纯日期串（onChange 第二参已格式化好），Shanghai 日历日归界在后端——
              前端不当 UTC 也不当浏览器本地，§3.4-6 的尺只有一把 */}
          <DatePicker.RangePicker allowClear data-testid="audit-filter-range"
            onChange={(_, strs) => setRange(strs[0] && strs[1] ? [strs[0], strs[1]] : null)} />
          <Select allowClear placeholder="操作人" style={{ width: 160 }} value={uid} data-testid="audit-filter-user"
            onChange={setUid} showSearch optionFilterProp="label" onSearch={(q) => void searchOps(q)}
            notFoundContent={opsLoading ? "搜索中…" : opsDenied ? "这个项目里没有成员名单读取权限"
              : opsFailed ? "操作人名单没取到（不是项目里没人）" : "没有匹配的用户"}
            options={ops.map((c) => ({ value: c.id, label: c.account + " · " + c.name }))} />
          <Select allowClear placeholder="入口" style={{ width: 120 }} value={entry} data-testid="audit-filter-entry"
            onChange={setEntry} options={Object.entries(ENTRIES).map(([v, l]) => ({ value: v, label: l }))} />
          <Select allowClear placeholder="结果" style={{ width: 110 }} value={ok} data-testid="audit-filter-ok"
            onChange={setOk} options={[{ value: "true", label: "成功" }, { value: "false", label: "失败" }]} />
          <Input.Search allowClear placeholder="动作，如 env_create" style={{ width: 220 }} data-testid="audit-filter-action"
            value={actionDraft} onChange={(e) => setActionDraft(e.target.value)}
            onSearch={(v) => { setActionDraft(v); setAction(v); }}
            onClear={() => { setActionDraft(""); setAction(""); }} />
        </FilterBar>
      </div>
      {failed && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="审计日志没取到"
          description={denied
            ? "审计只有系统管理员能读；若你刚被改动角色，请重新登录"
            : "可能是网络不通或后端没起，点「刷新」重试"} />
      )}
      <AdminTable<AuditRow> rowKey="id" loading={loading} columns={cols} dataSource={items}
          scroll={{ x: 860 }}
          onRow={(r: AuditRow) => ({ "data-testid": "audit-row", "data-audit-id": r.id } as React.HTMLAttributes<HTMLTableRowElement>)}
          expandable={{ expandedRowRender: (r: AuditRow) => (
            <pre className="tp-mono" style={{ margin: 0, maxHeight: 220, overflow: "auto" }}
              >{JSON.stringify(r.diff ?? {}, null, 2)}</pre>
          ), showExpandColumn: false }}
          locale={{ emptyText: failed ? (
            // 没取到 ≠ 查到了 0 条：失败时不许借用「没有记录」的口径，判词交给上面的报错条
            <StateView compact kind="error" title="审计记录没取到，这次列表是空的——原因见上方提示"
              action={<Button size="small" loading={loading} onClick={() => void load(true)}>重试</Button>} />
          ) : anyFilter ? (
            // 空态不许超出当前筛选条件说话：带筛选时的 0 条只说明「这些条件下没匹配」
            <StateView compact title="当前筛选条件下没有匹配的记录" />
          ) : (
            <StateView compact title="这段时间没有写操作被记录（只读查询不进审计，这是设计如此）" />
          ) }} />
      {cursor && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <Button data-testid="audit-more" loading={loading} onClick={() => void load(false)}>加载更多</Button>
        </div>
      )}
      {openRow && (
        <Card size="small" style={{ marginTop: 12 }} title={"细节 · " + openRow.action}
          data-testid="audit-detail-card" extra={<Button type="link" size="small" data-testid="audit-detail-close"
            onClick={() => setOpenRow(null)}>收起</Button>}>
          <Typography.Paragraph className="tp-text-sm" style={{ marginBottom: 6 }}>
            目标：{openRow.target || "—"} · 用户 id：{openRow.user_id ?? "—"}
          </Typography.Paragraph>
          <pre className="tp-mono" data-testid="audit-detail-body" style={{ margin: 0, maxHeight: 260, overflow: "auto" }}
            >{JSON.stringify(openRow.diff ?? {}, null, 2)}</pre>
        </Card>
      )}
      {diffRow && (
        <AuditDiffModal diff={diffRow.diff} action={diffRow.action} onClose={() => setDiffRow(null)} />
      )}
    </div>
  );
}
