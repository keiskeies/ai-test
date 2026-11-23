// 计划报告详情页（D183 步 6c，从计划详情「计划报告」区块下钻；后端 app/modules/testplan/ 为准）。
//
// 本页五条命门口径（写错就是假门/谎数，逐条对后端）：
// ① 数字只进不出：两个率 / 六个计数**全部从 GET /plan-reports/{id} 的头直读直画**，
//    明细行从 GET /plan-reports/{id}/items 直读——页面一条除法都不做（判据 2 到前端的形状）。
//    PassRing 内部算一次百分数是唯一的展示换算；外层外壳只挂 data-rate 后端原值
//    （6b 状态卡的 V1 变异教训：外壳再 round 一遍，测试就钉在副本上，变异照绿）。
// ② 报告 = 生成时刻的定格快照：status 是生成时 _plan_display 的**快照列**（此后归档/新 run
//    都不动它），两率与 not_executed 是后端读时从存量计数派生的纯函数（_report_out，口径逐字
//    = PlanStatusOut：分母恒为 total，空报告 0.0 不是 1.0）。本页**绝不**去问「现在怎么样」
//    （那是 GET /plans/{id}/status 的职责，跨页 join = 把快照页演成实时页，步 4/5 变异点名要杀）。
// ③ 「执行中」不在 LINK_RESULTS 词表里，明细的 result 对没跑过的行恒是 none（生成路径抄的就是
//    当时现算的结论）——渲染顺序 executing 优先：{executed:false, executing:true} 画「执行中」，
//    **不画「未执行」**；executed 与 executing 同真两个 Tag 并排（口径逐字 = planDetail.tsx ③）。
// ④ env_id 为空 = 生成时刻关联行没覆盖环境，执行时沿用对象默认（副本抄的是当时的值，
//    此后改绑不动这里）——把空说成「无环境」是说错（ENV_INHERIT 口径同 6b）。
// ⑤ 权限位：读门 testplan:report:read——无 :read **不发一条请求**（门在 effect 上）；撞 403
//    走 PermEmpty（位名只认后端原话）；404/410（不存在/别项目，_report 同码同文案）把后端
//    原话逐字上屏、不 closable、**不摆重试**（不存在不是暂时）；transient 非 closable + 重试。
//    删除走 **:delete**（testplan:report:delete），缺位不渲染（不是禁用）。
// ⑥ 明细分页 = 页码制（current/size，size 后端夹 1..200，默认 50 = PlanReportItemListIn 的默认）；
//    请求永远不带 cursor（plan_report_item_list 的裁决，schemas.PlanReportItemListIn）。
//    loadItems 读 current/pageSize 并把它们放进依赖、自己绝不写（D127 回路守卫）。
// ⑦ 删除是物理删、不可恢复：确认文案只说后端答过的事实（plan_report_delete 现核——报告头与
//    该报告的明细行同事务删、级联只按 report_id、别的报告的明细不动），不编别的细节；
//    删成功直接导航回所属计划详情页，**不留在原地画一行「已删除」**（那是假状态）。
// ⑧ D230 导出：GET /plan-reports/{id}/export 返回 {filename, media_type, content}，
//    content 是后端渲染好的**快照 HTML**（读的还是报告行与明细副本，零现算零 join）。
//    页面只做 Blob 落地（downloadBlob），不拼内容、不补数、不换算率——导出文件里的
//    每个数与页面上的每个数同源（同一份 PlanReportOut）。按钮由本页读门兜着，不另设位。
// 契约（nav.spec 将来钉）：根节点 data-testid="page-plan-report-detail" + PageHead 标题「计划报告详情」。
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Button, Card, Descriptions, Modal, Space, Spin, Table, Tag, Tooltip, Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr } from "../api/client";
import PermEmpty from "../components/PermEmpty";
import { planApi } from "../api/plan";
import { downloadBlob } from "../api/ImportWizard";
import type { components } from "../api/schema";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { LINK_RESULTS, SUBJECT_TYPES, vocabMeta } from "../shared/runVocab";
import { ratePct } from "../shared/passRate"; // 同源理由见 planDetail.tsx 同处注释
import { planDisplayMeta } from "./plans";
import { PassRing } from "./reports";
import ShareButton from "../ui/ShareButton";
import { tp, tpv } from "../theme";

type PlanReportOut = components["schemas"]["PlanReportOut"];
type PlanReportItemOut = components["schemas"]["PlanReportItemOut"];

/** 名单外的 id 截断显示（宁可生码，不留白、不编名——schedules.tsx / planDetail.tsx 同款）。 */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + "…" : id;
}

/** 后端/网络原话直出块（planDetail.tsx EchoBlock 同款：原话是证据，不许翻译）。 */
function EchoBlock({ text, testid }: { text: string; testid?: string }) {
  return (
    <pre data-testid={testid} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all",
      background: tpv.bg.layout, padding: 12, borderRadius: 6, margin: 0 }}>{text}</pre>
  );
}

/** 「沿用对象默认」的人话：env_id 为空 ≠「无环境」（口径 ④）。 */
const ENV_INHERIT = "沿用对象默认";

// ── 明细结论单元（口径 ③ 的渲染落点） ────────────────────────────────────────

function ItemResultCell({ it }: { it: PlanReportItemOut }) {
  const res = vocabMeta(LINK_RESULTS, it.result);
  return (
    // 外层用原生 span：data-* 要落在测试能押的节点上，antd 组件不保证转发未知 prop
    // （PassRing / planDetail.tsx 的同款教训）。
    <span data-testid={"plan-report-item-result-" + it.id}
      data-result={it.result} data-executing={String(it.executing)}
      style={{ display: "inline-flex", gap: 4 }}>
      {it.executing && <Tag color="processing" data-testid="plan-report-item-executing">执行中</Tag>}
      {/* executing 时结论 Tag 不独自代表「跑没跑过」；executed=false 且正在跑时 none 那条
          谎（「未执行」）根本不画——口径 ③。 */}
      {(!it.executing || it.executed) && <Tag color={res.color}>{res.label}</Tag>}
    </span>
  );
}

// ── 页体 ─────────────────────────────────────────────────────────────────────

function Detail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { project, user } = useAuth();
  const projectId = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const mayRead = can(perms, "testplan:report:read");
  const canDelete = can(perms, "testplan:report:delete");
  const canShare = can(perms, "share:link:create");

  // 主读（GET /plan-reports/{id}）的四态：在读 / 读到了 / 403（PermEmpty）/ 404·410（原话）/ 其它失败。
  const [report, setReport] = useState<PlanReportOut | null>(null);
  const [reportDenied, setReportDenied] = useState<ApiErr | null>(null);
  const [notFoundMsg, setNotFoundMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [items, setItems] = useState<PlanReportItemOut[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(50); // = 后端 PlanReportItemListIn size 默认
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // load* 一律读 current/pageSize 放进依赖、自己绝不写它们（D127 守卫，planDetail.tsx 同款）。

  const loadReport = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      const r = await planApi.report(id, projectId);
      setReport(r); setReportDenied(null); setNotFoundMsg(null); setLoadError(null);
    } catch (e: unknown) {
      if (e instanceof ApiErr && e.status === 403) setReportDenied(e);
      else if (e instanceof ApiErr && (e.status === 404 || e.status === 410)) {
        // 跨项目与不存在同码同文案（services._report），前端不分句、更不翻译。
        setNotFoundMsg(e.message);
      } else setLoadError(e instanceof ApiErr ? e.message : "报告详情加载失败");
    }
  }, [projectId, id]);
  useEffect(() => { if (mayRead) void loadReport(); }, [mayRead, loadReport]);

  const loadItems = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      const page = await planApi.reportItems(id, { project_id: projectId, current, size: pageSize });
      setItems(page.items);
      setTotal(page.total ?? null); // total 只从响应来；缺键 → null → ListPager 整块不渲染
      setItemsError(null);
    } catch (e: unknown) {
      setItems([]); setTotal(null);
      setItemsError(e instanceof ApiErr ? e.message : "明细列表加载失败");
    }
  }, [projectId, id, current, pageSize]);
  useEffect(() => { if (mayRead) void loadItems(); }, [mayRead, loadItems]);

  function removeReport(): void {
    if (!report) return;
    Modal.confirm({
      title: `删除报告「${report.name}」？`,
      // 只说 plan_report_delete 答过的事实（services.py 现核：报告头 + 该报告明细同事务物理删、
      // 级联只按 report_id）；不编后端没承诺过的细节。
      content: "物理删除，不可恢复：后端在同一事务里删掉这份报告头和它的全部明细行"
        + "（级联只按 report_id，别的报告的明细一根毫毛不动）。",
      okText: "删除", okButtonProps: { danger: true, "data-testid": "plan-report-detail-delete-ok" },
      cancelText: "取消", centered: true,
      onOk: async () => {
        try {
          await planApi.deleteReport(report.id, { project_id: projectId });
          message.success("已删除");
          // 原地留一份「已删除」的页面 = 谎；直接回所属计划详情（那里重新拉报告列表）。
          nav("/plans/" + report.plan_id);
        } catch { /* toast 已在 client 弹 */ }
      },
    });
  }

  /** D230：导出 = 把后端返回的**快照 HTML 文本**落地成文件（页面不拼内容、不补数）。 */
  async function exportReport(): Promise<void> {
    if (!report) return;
    setExporting(true);
    try {
      const out = await planApi.exportReport(report.id, projectId);
      downloadBlob(new Blob([out.content], { type: out.media_type }), out.filename);
      message.success("已导出 " + out.item_count + " 条明细（" + out.filename + "）");
    } catch { /* client 已 toast */ } finally {
      setExporting(false);
    }
  }

  const itemColumns: ColumnsType<PlanReportItemOut> = [
    { title: "对象", key: "subject",
      render: (_: unknown, r) => (
        <Space size={4} data-testid={"plan-report-item-row-" + r.id}>
          <Tag style={{ marginInlineEnd: 0 }}
            color={SUBJECT_TYPES[r.subject_type]?.color ?? "default"}>
            {SUBJECT_TYPES[r.subject_type]?.label ?? r.subject_type}
          </Tag>
          {/* subject_name = 生成时刻的快照名（此后改用例不动这里）——生码直读，不 join 资产表。 */}
          <Typography.Text className="tp-text-sm">{r.subject_name}</Typography.Text>
        </Space>
      ) },
    { title: "对象 id", dataIndex: "subject_id", key: "subject_id", width: 120,
      render: (v: string) => (
        <Typography.Text type="secondary" className="tp-mono tp-text-xs" title={v}>{shortId(v)}</Typography.Text>) },
    { title: "生成时结论", key: "result", width: 150,
      render: (_: unknown, r) => <ItemResultCell it={r} /> },
    { title: "环境", key: "env", width: 240,
      render: (_: unknown, r) => {
        // env_id = 生成时刻关联行环境值的副本；有 id 画短 id（生码——本页不拉 /envs，
        // 为一个快照副本开一条实时清单请求不值当，也不许拿别的时刻的环境名冒充当时的）。
        const label = r.env_id
          ? <Typography.Text className="tp-text-sm">{shortId(r.env_id)}</Typography.Text>
          : <Tooltip title="生成时关联行没覆盖环境：执行时沿用该对象自己的默认环境（抄的是当时的值）">
              <Typography.Text className="tp-text-sm" type="secondary">{ENV_INHERIT}</Typography.Text>
            </Tooltip>;
        return <span data-testid={"plan-report-item-env-" + r.id}>{label}</span>;
      } },
    { title: "快照时间", dataIndex: "created_at", key: "created_at", width: 150,
      render: (v: string | null) => (
        <Typography.Text className="tp-text-sm" data-testid="plan-report-item-created">
          {fmtTime(v) ?? "—"}
        </Typography.Text>) },
  ];

  // 无读权限：什么都渲染不了，也**一条请求都不发**（门在 effect 的 mayRead 上）。
  if (!mayRead) {
    return (
      <Alert type="warning" showIcon style={{ marginTop: 8 }} data-testid="plan-report-detail-no-read"
        message="当前项目没有 testplan:report:read 权限"
        description="计划报告详情（含明细）需要读权限，权限位在后端把守。" />
    );
  }
  // D38：撞 403 走权限空页——位名只认后端原话。
  if (reportDenied) {
    return <PermEmpty error={reportDenied} projectName={project?.name ?? ""} context="查看该计划报告" />;
  }
  if (notFoundMsg) {
    // 6b 同款：原话进 description，不 closable，**不摆重试**——不存在不是暂时。
    return (
      <Alert type="error" showIcon style={{ margin: 24 }} data-testid="plan-report-detail-not-found"
        message="报告没取到——不存在，或它属于别的项目"
        description={<EchoBlock text={notFoundMsg} testid="plan-report-detail-not-found-text" />} />
    );
  }
  if (!report) {
    if (loadError) {
      // 非 closable；重试只在「再试一次真的可能不同」的来路递（D142 口径）——transient 在这里。
      return (
        <div style={{ margin: 24 }}>
          <Alert type="error" showIcon data-testid="plan-report-detail-load-error"
            message="报告详情加载失败" description={<EchoBlock text={loadError} />} />
          <Button style={{ marginTop: 12 }} data-testid="plan-report-detail-retry"
            onClick={() => { setLoadError(null); void loadReport(); void loadItems(); }}>重试</Button>
        </div>
      );
    }
    return <Spin style={{ display: "block", margin: "var(--tp-gap-lg) auto" }}
      data-testid="plan-report-detail-loading" />;
  }

  // 生成时状态是快照**列**：词表外值渲染原文不回落友好标签（planDisplayMeta，R112 口径）。
  const dm = planDisplayMeta(report.status);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Button data-testid="plan-report-detail-back" onClick={() => nav("/plans/" + report.plan_id)}>
          返回所属计划
        </Button>
        <Space>
          <Button icon={<ReloadOutlined />} data-testid="plan-report-detail-reload"
            onClick={() => { void loadReport(); void loadItems(); }}>刷新</Button>
          {/* D230：导出按钮由页面的读门兜着（本页能渲染 = 有 testplan:report:read，
              后端导出端点同一个位）——内容与格式全由后端给，前端只负责落地。 */}
          <Button data-testid="plan-report-detail-export" loading={exporting}
            onClick={() => void exportReport()}>导出 HTML</Button>
          {canShare && <ShareButton projectId={projectId} targetType="plan_report"
            targetId={report.id} title={report.name} />}
          {/* 删除钮缺 :delete **不渲染**（不是禁用）；确认与善后见 removeReport（口径 ⑦）。 */}
          {canDelete && (
            <Button danger data-testid="plan-report-detail-delete" onClick={removeReport}>删除报告</Button>
          )}
        </Space>
      </Space>

      <Card size="small" data-testid="plan-report-detail-overview"
        title={
          <Space wrap size={6}>
            <Typography.Text strong>{report.name}</Typography.Text>
            <Tag color={dm.color} data-testid="plan-report-detail-status">{dm.label}</Tag>
            <Typography.Text className="tp-text-sm" type="secondary">生成时状态快照</Typography.Text>
          </Space>
        }>
        <Space size={24} wrap>
          {/* 外壳只挂后端原值（data-rate），百分数**只由 PassRing 从同一个 rate 算一次**
              （6b 状态卡 V1 变异的教训，外壳绝不再 round 一遍）。 */}
          <span data-testid="plan-report-detail-pass-ring" data-rate={String(report.pass_rate)}>
            <PassRing rate={report.pass_rate} size={56} />
          </span>
          <Descriptions size="small" column={{ xs: 2, md: 4 }} colon={false} items={[
            // 两个率与六个计数全部直读详情头（口径 ①：页面零除法——data-rate 上钉的是后端
            // 给的原值，测试逐字断言，naive passed/total 复算必红）。
            { key: "pr", label: "通过率", children: (
              <span data-testid="plan-report-detail-pass-rate" data-rate={String(report.pass_rate)}>
                {ratePct(report.pass_rate)}
              </span>) },
            { key: "er", label: "执行率", children: (
              <span data-testid="plan-report-detail-execute-rate" data-rate={String(report.execute_rate)}>
                {ratePct(report.execute_rate)}
              </span>) },
            { key: "to", label: "关联总数", children: (
              <span data-testid="plan-report-detail-total">{report.total}</span>) },
            { key: "ex", label: "已执行", children: (
              <span data-testid="plan-report-detail-executed">{report.executed}</span>) },
            { key: "ig", label: "执行中", children: (
              <span data-testid="plan-report-detail-executing">{report.executing}</span>) },
            { key: "ne", label: "未执行", children: (
              <span data-testid="plan-report-detail-not-executed">{report.not_executed}</span>) },
            { key: "pa", label: "通过", children: (
              <span data-testid="plan-report-detail-passed">{report.passed}</span>) },
            { key: "fa", label: "未通过", children: (
              <span data-testid="plan-report-detail-failed">{report.failed}</span>) },
          ]} />
        </Space>
        <Typography.Text className="tp-text-sm" type="secondary" style={{ display: "block", marginTop: 8 }}>
          报告是生成时刻的定格快照：数字是当时抄下的副本（两率由后端从存量计数读时派生，
          分母恒为关联总数，空报告是 0% 不是 100%），此后的执行不动这份报告。本页一条除法都不做。
        </Typography.Text>
        <Descriptions size="small" column={3} colon={false} style={{ marginTop: 8 }}
          items={[
            { key: "plan", label: "所属计划", children: (
              // plan_id 是详情头的真实字段；报告页不回查计划本体（不 join——口径 ②），
              // 名单外/没读位都画得出的最短事实就是短 id。
              <a data-testid="plan-report-detail-plan-link" onClick={() => nav("/plans/" + report.plan_id)}>
                {shortId(report.plan_id)}
              </a>) },
            { key: "by", label: "生成人", children: report.created_by ?? "—" },
            { key: "ct", label: "生成时间", children: (
              <span data-testid="plan-report-detail-created">{fmtTime(report.created_at) ?? "—"}</span>) },
            { key: "ut", label: "更新时间", children: (
              <span data-testid="plan-report-detail-updated">{fmtTime(report.updated_at) ?? "—"}</span>) },
          ]} />
      </Card>

      <Card size="small" title="明细（生成时刻的副本）" data-testid="plan-report-detail-items">
        {itemsError && (
          <Alert type="error" showIcon style={{ marginBottom: 8 }} data-testid="plan-report-detail-items-error"
            message="明细列表加载失败" description={<EchoBlock text={itemsError} />} />
        )}
        <Table<PlanReportItemOut> size="small" rowKey="id" dataSource={items} columns={itemColumns}
          pagination={false}
          locale={{ emptyText: itemsError
            ? "没取到明细——原因见上方错误条，点右上角「刷新」重试"
            : "这份报告生成时计划没有关联对象（快照就是空的）" }} />
        {/* 页码与脚注并成一排（卡内脚注格 .tp-cardfoot，口径同列表页）：省下卡体里整整一行。 */}
        <div className="tp-cardfoot">
          <Typography.Text className="tp-cardfoot-note tp-text-sm" type="secondary">
              明细走页码窗口（序 = link_id 升序，与详情内联 items 同源同序）；「生成时结论」来自
              快照副本，不回查实时状态——「执行中」来自 executing 布尔，不混进结论词表。
          </Typography.Text>
          <ListPager current={current} pageSize={pageSize} total={total}
            onPage={setCurrent} onPageSize={setPageSize} />
        </div>
      </Card>
    </div>
  );
}

export default function PlanReportDetailPage() {
  return (
    <div data-testid="page-plan-report-detail">
      <PageHead title="计划报告详情" />
      <ProjectGate><Detail /></ProjectGate>
    </div>
  );
}
