// 运行记录（§11.4.26 子集 + §13「1A：列表可看，详情后补」）。
// 详情抽屉复用 DebugPanel：调试页看到的断言卡与响应体，在记录里必须是同一套渲染，
// 否则「现场」与「档案」给出两种结论，用户不知道该信谁。
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Drawer, Empty, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import { ReloadOutlined } from "../ui/icons";
import type { ColumnsType } from "antd/es/table";
import { useSearchParams } from "react-router-dom";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import DebugPanel from "../api/DebugPanel";
import type { DebugResult } from "../api/DebugPanel";
import { statusColor } from "../api/req";
import { get } from "../api/client";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { SELECTABLE_TRIGGERS, STATUSES, SUBJECT_TYPES, TRIGGERS, vocabMeta } from "../shared/runVocab";
import type { Page, RunRow } from "../api/api";
import { useAuth } from "../auth/store";

// 触发来源与状态的展示词表在 shared/runVocab（与后端 Field(pattern=...) 同源，
// 由 runVocab.test.ts 钉死）：原先这两张表写死在本文件里，漂到过「筛选项里有 case、
// 后端 422 拒绝」和「T9 的 queued/running/cancelled 画成生码」两种实际故障。
function TriggerTag({ value }: { value: string }) {
  const m = TRIGGERS[value] ?? { icon: "?", label: value, color: "default" as const };
  return <Tag data-testid="run-trigger" color={m.color}>{m.icon + " " + m.label}</Tag>;
}

interface RunDetail extends RunRow {
  request_snapshot: Record<string, unknown> | null;
  response_snapshot: Record<string, unknown> | null;
  assertions: Array<Record<string, unknown>> | null;
}

// 快照 → DebugResult：与调试页共用渲染，字段缺失就照实缺失（不编造响应）。
function toResult(d: RunDetail): DebugResult {
  const snap = (d.response_snapshot ?? {}) as Record<string, unknown>;
  return {
    run_id: d.id,
    ok: d.status !== "error",
    passed: d.status === "passed",
    status: d.status_code,
    headers: (snap.headers ?? {}) as Record<string, string>,
    body_text: (snap.body_text as string | undefined) ?? null,
    truncated: Boolean(snap.truncated),
    body_size: Number(snap.body_size ?? 0),
    elapsed_ms: d.elapsed_ms ?? Number(snap.elapsed_ms ?? 0),
    error: d.error,
    assertions: d.assertions ?? [],
    env_name: d.env_name,
  };
}

// 只有接口调试路径（execution/services.py 的 save_run）会写 run_record.assertions，
// 且只写 api_definition/api_case/inline 三种对象；场景与 UI/ADB 运行走 new_run 出生、
// runner 终态收尾，逐条断言按设计只落在 run_step_result.detail 里（runner.py:513 注释
// 是这么写的，全仓 grep `\.assertions =` 也没有别处写这列）。其余对象的记录即使
// 零行也只说明「档案没带行」，不许被面板解读成「没执行任何断言」。
const API_DEBUG_SUBJECTS = new Set(["api_definition", "api_case", "inline"]);

/**
 * ?run=<id> 直达认行的纯判断半边（schedules.tsx:88 / notifyChannels.tsx:141 同形状）：
 * id 在**已加载行**里才认（返回该 id 用于高亮），不在就返回 null——行真的不在加载集里
 * 就老实什么都不标，绝不编一行出来。target 为空同样返回 null。抽成纯函数：这段
 * 「哪条是用户带来的那条」的判断是落点体验的命门，纯测试能钉住它，不必赌组件渲染。
 */
export function pickDeepLinkHit<T extends { id: string }>(rows: T[], target: string | null): string | null {
  if (!target || rows.length === 0) return null;
  return rows.some((r) => r.id === target) ? target : null;
}

function RunsWorkbench() {
  const { project } = useAuth();
  const pid = project!.id;
  const [items, setItems] = useState<RunRow[]>([]);
  // D47-b：页码分页（current/size/total）替换「加载更多」游标追加。一页只许有一个
  // 「我在第几页」的真相——按钮和页码并存就是两把尺子，后端拿 400 禁的正是这个。
  // 默认档位 20：与退役前的 PAGE=20 同行，且是 ListPager 档位表（20/50/100）里的真值。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  // 三个筛选合一份状态（reports.tsx 同款）：为的是「回第 1 页」能收在唯一写入口 patch 上，
  // 三个 setState 各写各的时，漏接一个 reset 没人拦得住（reports 转换时被测试逼出来的形状）。
  const [f, setF] = useState<{ trigger?: string; status?: string; subjectType?: string }>({});
  // 任一筛选变化必回第 1 页：停在第 7 页改筛选，落的是新条件下无关的切片甚至空页，
  // 和换档位是同一个 hazard（listPagination.tsx 注释③）。三个筛选只有 patch 这一个写入口，
  // 回页就钉在这唯一入口处，测试从第 3 页改筛选钉它。
  const patch = (p: Partial<typeof f>): void => { setF((old) => ({ ...old, ...p })); setCurrent(1); };
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [detail, setDetail] = useState<RunDetail | null>(null);

  // D123 的另一半：adbCaseDetail「执行」投完队列跳 /runs?run=<id>，此前没有任何代码读
  // 这个参数（useSearchParams 全页 0 引用）——参数被静默吞掉，用户落到列表还得自己找。
  // 现在做诚实消费者：?run= 只认**已加载行**里的那条（pickDeepLinkHit，schedules/
  // notifyChannels 同款纯函数）；第一页没回来前挂「正在查找」横幅，加载完没找到就明说
  // 「不在这页里」——不装没看见，也不假高亮。用户关掉横幅后不再被查询串「复活」
  // （dismissed 记的是被关掉的那串 id，换新 run= 仍会重新认——同 schedules seenQ 的顾虑）。
  // 每次 items 变化都重认（不是一次性 latch）：按 miss 横幅翻到别的页码后行真出现时，
  // 横幅必须翻成「已标出」，不能停在假话上。
  const [sp] = useSearchParams();
  const runTarget = sp.get("run");
  const [hitId, setHitId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!runTarget || runTarget === dismissed || items.length === 0) return;
    setHitId(pickDeepLinkHit(items, runTarget));
  }, [runTarget, dismissed, items]);

  // D127 的教训换了形态仍然成立：load 读 current/pageSize 并把它们放进依赖，但 load
  // 自己绝不写 current/pageSize（只有 pager 回调和 patch 写），也不把 items 放进依赖
  // （load 自己 setItems——写者进自己的依赖就是「响应→新 items→load 换身份→effect 重跑」
  // 的无限回路，reports.tsx 步3b 刚为这个付过学费），所以取数落地不会重建 load、
  // 不会重跑下面的 effect——点一次页码恰好一条请求。
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailed(false);
    try {
      const q = new URLSearchParams({ project_id: pid, size: String(pageSize), current: String(current) });
      if (f.trigger) q.set("trigger", f.trigger);
      if (f.status) q.set("status", f.status);
      // R112：UI 运行会出现在列表里——没有这个筛选，它就只能混在全量里看
      if (f.subjectType) q.set("subject_type", f.subjectType);
      // 请求永不带 cursor：current+cursor 同传后端直接 400，一页两把尺子正是被禁的那件事
      const r = await get<Page<RunRow>>("/runs?" + q.toString(), { silent: true });
      // 页码模式是替换语义：第 3 页的行就只画第 3 页的，别页的行必须下桌。
      setItems(r.items);
      // total 只从响应来，永不由 items.length 客户端现攒（页内行数不是总数）。
      // 缺键（游标式响应）→ null → ListPager 整块不渲染。
      setTotal(r.total ?? null);
    } catch {
      // 403（角色被改）与网络故障都要摊开说：装成「暂无记录」是把故障演成空数据
      setFailed(true);
      // 失败不留谎脚注：total 清空，不许在空表上面挂一条陈旧的「共 N 条」。
      setItems([]);
      setTotal(null);
    } finally { setLoading(false); }
  }, [pid, f, current, pageSize]);

  useEffect(() => { void load(); }, [load]);

  async function openDetail(id: string): Promise<void> {
    setDetail(null);
    try { setDetail(await get<RunDetail>("/runs/" + id + "?project_id=" + encodeURIComponent(pid))); }
    catch { /* client 已 toast，抽屉不打开 */ }
  }
  const cols: ColumnsType<RunRow> = [
    { title: "时间", dataIndex: "created_at", width: 168, render: (v: string | null) => (
      // UTC 存储 / Asia/Shanghai 展示（§3.4-6）：换算在 shared/timefmt，页面不碰字符串切片。
      // 老写法 slice(0,19) 显示的是 UTC 钟点，比真实时间早 8 小时，而形状正则测不出来（R68）。
      <Typography.Text data-testid="run-time" style={{ fontSize: 12 }}>
        {fmtTime(v) ?? "—"}
      </Typography.Text>) },
    { title: "对象", dataIndex: "subject_name", render: (v: string, r: RunRow) => (
      <Space size={4}>
        {/* D141：旧兜底 `v ?? 「…已删除」` 删了——subject_name 是 NOT NULL 快照列
            （execution/models.py:22，「对象删除后仍可读」），既不可达、语义也是假的：
            名字为空从来不代表对象被删。 */}
        <Typography.Text data-testid="run-subject">{v}</Typography.Text>
        <Tooltip title={"对象类型：" + r.subject_type}>
          {/* R112：词表查不到就渲染原文——老写法 `=== "api_case" ? "用例" : "接口"`
              会把 ui_case 贴成「接口」，那是主动说错。宁可生码，不可撒谎。 */}
          <Tag data-testid="run-subject-type" style={{ marginInlineEnd: 0 }}
            color={vocabMeta(SUBJECT_TYPES, r.subject_type).color}>
            {vocabMeta(SUBJECT_TYPES, r.subject_type).label}
          </Tag>
        </Tooltip>
      </Space>) },
    { title: "触发", dataIndex: "trigger", width: 92, render: (v: string) => <TriggerTag value={v} /> },
    { title: "状态", dataIndex: "status", width: 104, render: (v: string) => {
      const m = vocabMeta(STATUSES, v);
      return <Tag data-testid="run-status" color={m.color}>{m.label}</Tag>;
    } },
    { title: "码", dataIndex: "status_code", width: 74, render: (v: number | null) => (
      <Tag data-testid="run-code" color={statusColor(v)}>{v ?? "—"}</Tag>) },
    { title: "耗时", dataIndex: "elapsed_ms", width: 88, render: (v: number | null) => (
      <Typography.Text style={{ fontSize: 12 }}>{v == null ? "—" : v + " ms"}</Typography.Text>) },
    { title: "环境", dataIndex: "env_name", width: 100, render: (v: string | null) => v ?? "—" },
    { title: "执行人", dataIndex: "created_by_name", width: 100, render: (v: string | null) => v ?? "—" },
    { title: "", key: "ops", width: 66, render: (_: unknown, r: RunRow) => (
      <Button size="small" type="link" data-testid="run-detail" onClick={() => void openDetail(r.id)}>详情</Button>) },
  ];

  return (
    <div data-testid="runs-body">
      <Space style={{ marginBottom: 12 }} wrap data-testid="runs-filters">
        <Select allowClear placeholder="对象类型" style={{ width: 140 }} value={f.subjectType}
          onChange={(v) => patch({ subjectType: v })} data-testid="runs-filter-subject-type"
          options={Object.entries(SUBJECT_TYPES).map(([k, v]) => ({ value: k, label: v.label }))} />
        <Select allowClear placeholder="触发方式" style={{ width: 140 }} value={f.trigger}
          onChange={(v) => patch({ trigger: v })} data-testid="runs-filter-trigger"
          // 与 reports.tsx 同口径（D82）：reserved（webhook，零写入方，待业主裁）不进筛选，
          // 点了必是空表 = 假门。徽标仍查 TRIGGERS 全表，见 TriggerTag。
          options={Object.entries(SELECTABLE_TRIGGERS).map(([k, v]) => ({ value: k, label: v.icon + " " + v.label }))} />
        <Select allowClear placeholder="状态" style={{ width: 130 }} value={f.status}
          onChange={(v) => patch({ status: v })} data-testid="runs-filter-status"
          options={Object.entries(STATUSES).map(([k, v]) => ({ value: k, label: v.label }))} />
        {/* 刷新重发**当前页**（load 不带重置语义）：停在第 3 页点刷新被弹回第 1 页，
            等于页码控件说了话而不算数。 */}
        <Button icon={<ReloadOutlined />} data-testid="runs-refresh" onClick={() => void load()} loading={loading}>刷新</Button>
      </Space>
      {failed && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message="运行记录没取到" description="可能是角色刚被改动或网络不通，点「刷新」重试" />
      )}
      {/* D123 深链横幅：三态各说一句真话——找到了（标行）/ 第一页还在路上 / 加载完没找到。
          closable 是裁决要求的可关闭；关掉后 dismissed 钉住这串 id，横幅与高亮一起没了，
          不会再被查询串复活。 */}
      {runTarget && runTarget !== dismissed && (
        hitId === runTarget ? (
          <Alert type="info" showIcon closable style={{ marginBottom: 12 }}
            data-testid="runs-deeplink"
            message={"跳转带来的运行 " + runTarget.slice(0, 8) + " 就在下表——已标出这一行。"}
            onClose={() => { setHitId(null); setDismissed(runTarget); }} />
        ) : items.length === 0 && loading ? (
          <Alert type="info" showIcon closable style={{ marginBottom: 12 }}
            data-testid="runs-deeplink"
            message={"正在查找运行 " + runTarget.slice(0, 8) + "…"}
            onClose={() => { setHitId(null); setDismissed(runTarget); }} />
        ) : (
          <Alert type="warning" showIcon closable style={{ marginBottom: 12 }}
            data-testid="runs-deeplink"
            message={"运行 " + runTarget.slice(0, 8) + " 不在这页里——点右上「刷新」或减少筛选"}
            description="列表只带回了已加载的这些行，这条不在其中（也可能被当前筛选挡在了请求外）。"
            onClose={() => { setHitId(null); setDismissed(runTarget); }} />
        )
      )}
      <AdminTable<RunRow>
        rowKey="id"
        loading={loading}
        columns={cols}
        dataSource={items}
        pagination={false}
        scroll={{ x: 980 }}
        rowClassName={(r: RunRow) => (r.id === hitId ? "tp-row-hit" : "")}
        onRow={(r) => ({ "data-testid": "run-row", "data-run-id": r.id } as React.HTMLAttributes<HTMLTableRowElement>)}
        locale={{ emptyText: (
          <Empty data-testid="runs-empty" description={(
            <span data-testid="runs-empty-hint">
              {failed ? "暂时取不到记录" : "还没有运行记录，去接口管理点一次「调试」就会出现在这里"}
            </span>
          )} />
        ) }}
      />
      {/* D47-b：共享页码分页器。total 缺键（响应没带 total）时 ListPager 整块不渲染，
          这里垫在 Table 之下；「加载更多」随游标语义一起退场（一页两把尺子的老账）。 */}
      <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
        <ListPager
          current={current}
          pageSize={pageSize}
          total={total}
          onPage={setCurrent}
          onPageSize={setPageSize}
        />
      </div>
      <Drawer open={detail !== null} width={720} onClose={() => setDetail(null)}
        title={detail ? "运行详情 · " + detail.subject_name : "运行详情"}
        data-testid="run-drawer">
        {detail && (
          <>
          <Space wrap size={6} style={{ marginBottom: 12 }}>
            <TriggerTag value={detail.trigger} />
            <Tag color={vocabMeta(STATUSES, detail.status).color}>
              {vocabMeta(STATUSES, detail.status).label}</Tag>
            <Tag color={statusColor(detail.status_code)}>{detail.status_code ?? "无响应码"}</Tag>
            {detail.env_name && <Tag>{detail.env_name}</Tag>}
            <Typography.Text type="secondary">谁：{detail.created_by_name ?? "未知"}</Typography.Text>
          </Space>
          <Card size="small" title="请求" data-testid="run-request" style={{ marginBottom: 12 }}>
            <pre className="tp-mono" style={{ margin: 0, maxHeight: 200, overflow: "auto" }}>
              {JSON.stringify(detail.request_snapshot ?? {}, null, 2)}
            </pre>
          </Card>
          {/* 运行记录是失败现场最常回看的地方，失败态同样给 Pilot 出口（蓝图 :1426）。
              D141：subject_name 是 NOT NULL 快照列，草稿直接用它——不存在「对象：null」
              那一格，旧句「取回退链」描述的是已删的兜底。
              不给 requestLine：快照形状是 {method,url,...} 的混合体，拼出来的行不能保证
              真是当时发出去的那一行——宁缺不编。 */}
          {/* 现场与档案同一套渲染，但「行从哪来」两边不同：非接口调试对象的运行
              记录不携带断言行，面板就只说「没带」，不说「没执行」（见上 const 注释）。 */}
          <DebugPanel result={toResult(detail)}
            assertionsKnown={API_DEBUG_SUBJECTS.has(detail.subject_type)}
            subject={detail.subject_name} />
          </>
        )}
      </Drawer>
    </div>
  );
}

export default function RunsPage() {
  return (
    <div data-testid="page-runs">
      <PageHead title="运行记录"
        desc="调试 / 手动 / 定时 / Pilot 四类触发方式的执行存档；点行查看请求、响应与断言现场。" />
      <ProjectGate>
        <RunsWorkbench />
      </ProjectGate>
    </div>
  );
}
