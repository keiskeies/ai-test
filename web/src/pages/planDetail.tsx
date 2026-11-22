// 测试计划详情页（D183 步 6b，§11.1 任务中心「测试计划」下钻；后端 app/modules/testplan/ 为准）。
//
// 本页六条命门口径（写错就是假门/谎数，逐条对后端）：
// ① 数字只进不出：四态 / 两个率 / 六个计数**全部从 GET /plans/{id}/status 直读直画**——
//    页面一条除法都不做。_rates（services.py:548）是唯一算式；TS 里再写一份
//    passed÷total 正是后端 M5/P3 变异要杀的「第二算式」形状（判据 2/3，测试钉渲染值
//    == fixture 的 pass_rate/execute_rate，fixture 特意让 naive 除法得出不同的数）。
//    空计划 0.0 照画 0%，不是 1.0。百分号化（round(rate*100)）只是展示形状，不是重算。
// ② 分页关联行 join /status 现算结论的**唯一键是 link_id == PlanLinkOut.id**
//    （services.py:605-606 现核）。status.links 覆盖全部关联、本页只画一页——join 不上
//    是跨页常态，画「—」，绝不现算一个结论填上（没答过的问题不许编）。
// ③ 「执行中」不在 LINK_RESULTS 词表里：_link_result 对 executed==0 **恒回 none——
//    正在跑的那条也算 none**（services.py:520-526）。所以渲染顺序是 executing 优先：
//    {executed:false, executing:true} 画「执行中」，**不画「未执行」**；executed 与
//    executing 同真两个 Tag 并排——结论 Tag 永远不独自扛「跑没跑过」这句话（裁定口径）。
// ④ 权限位：读门 testplan:plan:read——无 :read **不发一条请求**（schedules.tsx:777-784
//    同款）；撞 403 走 PermEmpty（D38，只读后端原话）；404/410（不存在/别项目）把后端
//    原话逐字上屏（reportDetail.tsx:81 同码同处理）。关联/报告两节各按 link:read /
//    report:read 分流——缺位明说，不演空表；归档走 **:manage** 且只对未归档计划渲染
//    （终态无反归档）；写钮缺位一律不渲染。env 下拉要 env:config:read：缺位时关联行
//    的 env 列退化为只读（有 id 画短 id，没 id 明说「沿用对象默认」，不是「无环境」）。
// ⑤ 分页 = 页码制（current/size，两个子列表各一份 useState；不进 URL、不进 localStorage）。
//    请求永远不带 cursor——plan_link_list / plan_report_list 的裁决（schemas.py:111-117/241-246）。
//    load 读 current/pageSize 并把它们放进依赖、自己绝不写（D127 回路守卫）。
// ⑥ 「加关联」选择器：后端四个 subject 列表里**只有 /scenarios 支持服务端 keyword**
//    （api/ui/adb 的入参实测没有 keyword）——搜索框因此明说是「在本页已加载的 N 条里筛」，
//    绝不摆一个假装全库搜索的框（§13 纪律 1）；「按 ID 直接关联」输入框是长尾出口，
//    后端校验 id（不存在/跨项目/回收站 → 404 原话直出，不翻译）。缺对象读权限的类型
//    明说「读不到清单≠项目里没有」并保留 ID 通路，不渲染空列表冒充「没有用例」。
// 挂账（后端刀，本刀不做）：api/ui/adb 三个对象列表补服务端 keyword + 统一分页形状。
// 6c 已落地：报告名列是**真链接**——/plan-reports/:id 路由与 <a onClick=nav>、planDetail.test.tsx
// 第⑨条同批翻（6a ⑬ 的同款纪律：catch-all `{path:"*"}` 弹回工作台这把锁随路由消失，入口与测试
// 不许只翻一半）。报告页本体见 pages/planReportDetail.tsx。
// 契约（nav.spec 钉）：根节点 data-testid="page-plan-detail" + PageHead 标题「计划详情」。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert, Button, Card, Descriptions, Input, Modal, Select, Space, Spin, Table, Tag,
  Tooltip, Typography, message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get } from "../api/client";
import PermEmpty from "../components/PermEmpty";
import { planApi, type PlanLinkUpdateBody, type PlanReportListRow } from "../api/plan";
import type { CaseRow, EnvRow, Page } from "../api/api";
import type { components } from "../api/schema";
import { sceneApi } from "../api/scene";
import { uiApi } from "../api/ui";
import { adbCaseApi } from "../api/adbCase";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { LINK_RESULTS, SUBJECT_TYPES, vocabMeta } from "../shared/runVocab";
// ratePct 不再各页各写一份：小数→百分数这条算式先前在 4 个文件里各有副本，
// 断言只钉得住其中一处时，改坏另一处照样全绿（6b V1 变异的形状）。见 shared/passRate.ts。
import { ratePct } from "../shared/passRate";
import { planDisplayMeta } from "./plans";
import { PassRing } from "./reports";
import { tp, tpv } from "../theme";

type PlanOut = components["schemas"]["PlanOut"];
type PlanStatusOut = components["schemas"]["PlanStatusOut"];
type PlanLinkOut = components["schemas"]["PlanLinkOut"];
type PlanLinkStatusOut = components["schemas"]["PlanLinkStatusOut"];

/** 名单外的 id 截断显示（宁可生码，不留白、不编名——schedules.tsx:296 同款）。 */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + "…" : id;
}

/** 后端/网络原话直出块（plans.tsx EchoBlock 同款：原话是证据，不许翻译）。 */
function EchoBlock({ text, testid }: { text: string; testid?: string }) {
  return (
    <pre data-testid={testid} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all",
      background: tpv.bg.layout, padding: 12, borderRadius: 6, margin: 0 }}>{text}</pre>
  );
}

/** 「沿用对象默认」的人话：env_id 为空 ≠「无环境」——执行时回落到 subject 自己的环境
 *  （后端建关联时抄 subject_env，services.py:386-389）。把空说成「无环境」是说错。 */
const ENV_INHERIT = "沿用对象默认";

// ── 关联结论单元（口径 ②③ 的渲染落点） ──────────────────────────────────────

function LinkResultCell({ st, rowId }: { st: PlanLinkStatusOut | undefined; rowId: string }) {
  if (!st) {
    // join 不上 ≠ 未执行：status 覆盖全部关联、列表只画一页，跨页行本来就不在 links 里。
    // 这里只有一支笔可下：「—」+ 一句为什么。
    return (
      <Tooltip title="GET /status 本轮没报这条关联的结论（status 覆盖全部关联，本页只画其中一页，跨页时这很正常）。后端没答过，就不编一个结论上来。">
        <Typography.Text type="secondary" data-testid={"plan-link-result-" + rowId}
          data-result="unknown">—</Typography.Text>
      </Tooltip>
    );
  }
  const res = vocabMeta(LINK_RESULTS, st.result);
  return (
    // 外层用原生 span：data-* 要落在测试能押的节点上，antd 组件不保证转发未知 prop
    // （PassRing 的同款教训，reports.tsx:34）。
    <span data-testid={"plan-link-result-" + rowId}
      data-result={st.result} data-executing={String(st.executing)}
      style={{ display: "inline-flex", gap: 4 }}>
      {st.executing && <Tag color="processing" data-testid="plan-link-executing">执行中</Tag>}
      {/* executing 时结论 Tag 不独自代表「跑没跑过」；executed=false 且正在跑时 none 那条
          谎（「未执行」）根本不画——口径 ③。 */}
      {(!st.executing || st.executed) && <Tag color={res.color}>{res.label}</Tag>}
    </span>
  );
}

// ── 「加关联」选择器（口径 ⑥） ───────────────────────────────────────────────

interface PickerRow { id: string; name: string }

/** 四种 subject 的读法：perm 位逐条对后端注册表现核
 *  （api:case:read / scenario:read / ui:case:read / adb:case:read），fetch 全部
 *  recycled=false + size=200（200 是各端点 size 上限，不是拍的）；只有 scenario 传
 *  keyword——另外三个的入参模型里没有这个键，传了也会被 pydantic 静默丢掉，
 *  摆了就是假门。 */
const PICKERS: Record<string, { perm: string; serverSearch: boolean;
  fetch: (pid: string, keyword?: string) => Promise<PickerRow[]> }> = {
  api_case: {
    perm: "api:case:read", serverSearch: false,
    fetch: async (pid) => {
      const r = await get<Page<CaseRow>>("/api-cases?" + new URLSearchParams(
        { project_id: pid, recycled: "false", size: "200" }).toString(), { silent: true });
      return r.items.map((c) => ({ id: c.id, name: c.name }));
    },
  },
  scenario: {
    perm: "scenario:read", serverSearch: true,
    fetch: async (pid, kw) => {
      const r = await sceneApi.list({ project_id: pid, recycled: false, size: 200,
        keyword: kw || undefined });
      return r.items.map((s) => ({ id: s.id, name: s.name }));
    },
  },
  ui_case: {
    perm: "ui:case:read", serverSearch: false,
    fetch: async (pid) => {
      const r = await uiApi.listCases({ project_id: pid, recycled: false, size: 200 });
      return r.items.map((c) => ({ id: c.id, name: c.name }));
    },
  },
  adb_case: {
    perm: "adb:case:read", serverSearch: false,
    fetch: async (pid) => {
      const r = await adbCaseApi.listCases({ project_id: pid, recycled: false, size: 200 });
      return r.items.map((c) => ({ id: c.id, name: c.name }));
    },
  },
};

type PickerList =
  | { kind: "loading" }
  | { kind: "denied"; perm: string }
  | { kind: "error"; msg: string }
  | { kind: "ok"; rows: PickerRow[] };

function LinkPickerModal({ open, planId, projectId, perms, canEnvRead, envs, envsError, onClose, onCreated }: {
  open: boolean;
  planId: string;
  projectId: string;
  perms: string[];
  canEnvRead: boolean;
  envs: EnvRow[];
  envsError: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [subjectType, setSubjectType] = useState("api_case");
  const [keyword, setKeyword] = useState("");
  const [list, setList] = useState<PickerList>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [idInput, setIdInput] = useState("");
  const [envId, setEnvId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 每次打开重置（上次选的类型/关键词/选中都不该活到下一次）。
  useEffect(() => {
    if (!open) return;
    setSubjectType("api_case"); setKeyword(""); setSelectedId(null);
    setIdInput(""); setEnvId(undefined); setErr(null);
  }, [open]);

  // 非 scenario 类型的 keyword 不进 effect 依赖：客户端过滤不该触发重新请求
  // （触发=每次敲键一条 GET，而那三个端点根本不认 keyword）。
  const serverKeyword = PICKERS[subjectType]?.serverSearch ? keyword : "";

  useEffect(() => {
    if (!open) return;
    const meta = PICKERS[subjectType];
    if (!meta) return;
    if (!can(perms, meta.perm)) { setList({ kind: "denied", perm: meta.perm }); return; }
    let dead = false;
    setList({ kind: "loading" });
    setSelectedId(null);
    meta.fetch(projectId, serverKeyword || undefined).then(
      (rows) => { if (!dead) setList({ kind: "ok", rows }); },
      (e: unknown) => {
        if (dead) return;
        // 服务端也回 403（本地位判定只是第一道）：同一条诚实路。
        if (e instanceof ApiErr && e.status === 403) setList({ kind: "denied", perm: meta.perm });
        else setList({ kind: "error", msg: e instanceof ApiErr ? e.message : "对象列表没取到" });
      },
    );
    return () => { dead = true; };
  }, [open, subjectType, serverKeyword, projectId, perms]);

  const meta = PICKERS[subjectType];
  const loaded = list.kind === "ok" ? list.rows : [];
  const rows = meta?.serverSearch
    ? loaded
    : loaded.filter((r) => keyword === "" || r.name.includes(keyword) || r.id.includes(keyword));

  async function submit(): Promise<void> {
    const sid = (selectedId ?? idInput.trim()) || "";
    if (!sid) { message.warning("从列表选一条，或在「按 ID 直接关联」里填对象 id"); return; }
    setBusy(true);
    setErr(null);
    try {
      // 没选环境就**整个省略 env_id**：省略 = 后端抄 subject 自己的 env（services.py:386-389）；
      // 送 null 语义相同但会让 body 多一个键，按后端口径原样镜像——body 恰好
      // {project_id, subject_type, subject_id}（+ 选了就加 env_id），不夹带计划 id 之类的键。
      const body: Parameters<typeof planApi.createLink>[1] = {
        project_id: projectId, subject_type: subjectType, subject_id: sid,
      };
      if (envId) body.env_id = envId;
      await planApi.createLink(planId, body);
      onCreated();
    } catch (e: unknown) {
      if (e instanceof ApiErr) setErr(e.message); // 409 已挂 / 404 不存在·跨项目·回收站：原话直出
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} width={560} destroyOnHidden title="加关联（给计划挂执行对象）"
      okText="挂入计划" okButtonProps={{ loading: busy, "data-testid": "plan-picker-submit" }}
      cancelText="取消" onOk={() => void submit()}>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>对象类型</Typography.Text>
          <Select data-testid="plan-picker-type" style={{ width: "100%" }} value={subjectType}
            onChange={(v: string) => setSubjectType(v)}
            options={Object.keys(PICKERS).map((t) => ({
              value: t, label: (SUBJECT_TYPES[t]?.label ?? t) + "（" + t + "）",
            }))} />
        </div>
        <div>
          <Typography.Text strong>按名称挑</Typography.Text>
          <Input data-testid="plan-picker-search" allowClear value={keyword}
            placeholder="输入名称片段" onChange={(e) => setKeyword(e.target.value)} />
          {/* 诚实标签（纪律 1）：三个列表后端不支持按名搜索——搜索只在已加载的 200 条里生效。 */}
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}
            data-testid="plan-picker-filter-note">
            {meta?.serverSearch
              ? `场景支持后端搜索；当前清单 ${loaded.length} 条。`
              : `在本页已加载的 ${loaded.length} 条里筛——这个列表后端不支持按名搜索，筛不到 ≠ 不存在（长尾走「按 ID 直接关联」）。`}
          </Typography.Text>
          {list.kind === "loading" && <Spin size="small" data-testid="plan-picker-loading" style={{ margin: 8 }} />}
          {list.kind === "denied" && (
            // 缺读权限 ≠ 没有对象：明说读不到，并把 ID 通路留在同一屏上。
            <Alert type="warning" showIcon style={{ marginTop: 8 }} data-testid="plan-picker-perm-note"
              message={`没有 ${list.perm} 权限，这个类型的对象清单读不到——这不代表项目里没有`}
              description="可在下方「按 ID 直接关联」填 id 挂入：id 对不对由后端校验，它会原话告诉你为什么不行。" />
          )}
          {list.kind === "error" && (
            <Alert type="error" showIcon style={{ marginTop: 8 }} data-testid="plan-picker-error"
              message="对象列表没取到" description={<EchoBlock text={list.msg} />} />
          )}
          {list.kind === "ok" && (
            <div data-testid="plan-picker-list" style={{ maxHeight: 180, overflow: "auto", marginTop: 6,
              border: "1px solid " + tpv.border, borderRadius: 6 }}>
              {rows.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", padding: 8 }}>
                  {`已加载的 ${loaded.length} 条里没有匹配项（列表只拉前 200 条且不含回收站）——换关键词，或用「按 ID 直接关联」。`}
                </Typography.Text>
              ) : rows.map((r) => (
                <div key={r.id} data-testid={"plan-picker-row-" + r.id}
                  onClick={() => setSelectedId(r.id)}
                  style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 8px",
                    cursor: "pointer",
                    background: selectedId === r.id ? tpv.bg.selected : undefined }}>
                  {/* 选中行底色引 theme Token（tpv.bg.selected）——手抄那个同值 hex 会被
                      theme.tokens.test.ts 的棘轮当场拦下（6a 在 tpv.bg.layout 上撞过同款；
                      棘轮连注释一起数，这句里都不许写 hex 原值）。 */}
                  <input type="radio" readOnly checked={selectedId === r.id}
                    style={{ pointerEvents: "none" }} />
                  <Typography.Text style={{ fontSize: 12, flex: 1, minWidth: 0 }}
                    ellipsis={{ tooltip: r.name }}>{r.name}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}
                    className="tp-mono">{shortId(r.id)}</Typography.Text>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <Typography.Text strong>按 ID 直接关联（长尾出口）</Typography.Text>
          <Input data-testid="plan-picker-id" value={idInput} allowClear
            placeholder="对象 id——不存在/跨项目/在回收站都会撞回后端原话"
            onChange={(e) => setIdInput(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>执行环境覆盖（可选）</Typography.Text>
          {canEnvRead ? (
            <Select data-testid="plan-picker-env" allowClear style={{ width: "100%" }}
              value={envId} placeholder={envsError ? "环境清单没取到（可刷新页面重试）" : "不选 = " + ENV_INHERIT}
              onChange={(v: string | undefined) => setEnvId(v)}
              options={envs.map((e) => ({ value: e.id, label: e.name }))} />
          ) : (
            // 缺 env:config:read：不摆一个永远空的假下拉；不覆盖=后端抄 subject 默认。
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}
              data-testid="plan-picker-env-note">
              没有 env:config:read 权限，这里不提供环境覆盖——挂入后沿用对象自己的默认环境。
            </Typography.Text>
          )}
        </div>
        {err && (
          <Alert type="error" showIcon data-testid="plan-picker-save-error"
            message="后端拒绝（原话回显）" description={<EchoBlock text={err} testid="plan-picker-save-error-text" />} />
        )}
      </Space>
    </Modal>
  );
}

// ── 页体 ─────────────────────────────────────────────────────────────────────

function Detail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { project, user } = useAuth();
  const projectId = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const mayRead = can(perms, "testplan:plan:read");
  const canLinkRead = can(perms, "testplan:link:read");
  const canLinkCreate = can(perms, "testplan:link:create");
  const canLinkUpdate = can(perms, "testplan:link:update");
  const canLinkDelete = can(perms, "testplan:link:delete");
  const canReportRead = can(perms, "testplan:report:read");
  const canReportCreate = can(perms, "testplan:report:create");
  // 归档权限位是 :manage——拿 :update 当归档门是 6a 文件头点过的那位最贵的错，这里同尺。
  const canManage = can(perms, "testplan:plan:manage");
  const canEnvRead = can(perms, "env:config:read");

  // 主读（GET /plans/{id}）的四态：在读 / 读到了 / 403（PermEmpty）/ 404·410（原话）/ 其它失败。
  const [plan, setPlan] = useState<PlanOut | null>(null);
  const [planDenied, setPlanDenied] = useState<ApiErr | null>(null);
  const [notFoundMsg, setNotFoundMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [status, setStatus] = useState<PlanStatusOut | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [links, setLinks] = useState<PlanLinkOut[]>([]);
  const [linkTotal, setLinkTotal] = useState<number | null>(null);
  const [linkCurrent, setLinkCurrent] = useState(1);
  const [linkPageSize, setLinkPageSize] = useState(50); // = 后端 PlanLinkListIn size 默认
  const [linksError, setLinksError] = useState<string | null>(null);
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null);

  const [reports, setReports] = useState<PlanReportListRow[]>([]);
  const [reportTotal, setReportTotal] = useState<number | null>(null);
  const [reportCurrent, setReportCurrent] = useState(1);
  const [reportPageSize, setReportPageSize] = useState(50);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState(false);

  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [envsError, setEnvsError] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // load* 一律读 current/pageSize 放进依赖、自己绝不写它们（D127 守卫，plans.tsx 同款）。

  const loadPlan = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      const p = await planApi.get(projectId, id);
      setPlan(p); setPlanDenied(null); setNotFoundMsg(null); setLoadError(null);
    } catch (e: unknown) {
      if (e instanceof ApiErr && e.status === 403) setPlanDenied(e);
      else if (e instanceof ApiErr && (e.status === 404 || e.status === 410)) {
        // 跨项目与不存在同码同文案（services._plan），前端不分句、更不翻译。
        setNotFoundMsg(e.message);
      } else setLoadError(e instanceof ApiErr ? e.message : "计划详情加载失败");
    }
  }, [projectId, id]);
  useEffect(() => { if (mayRead) void loadPlan(); }, [mayRead, loadPlan]);

  const loadStatus = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      const s = await planApi.status(projectId, id);
      setStatus(s); setStatusError(null);
    } catch (e: unknown) {
      setStatusError(e instanceof ApiErr ? e.message : "实时状态没取到");
    }
  }, [projectId, id]);
  useEffect(() => { if (mayRead) void loadStatus(); }, [mayRead, loadStatus]);

  const loadLinks = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      const page = await planApi.listLinks(id,
        { project_id: projectId, current: linkCurrent, size: linkPageSize });
      setLinks(page.items);
      setLinkTotal(page.total ?? null); // total 只从响应来；缺键 → null → ListPager 整块不渲染
      setLinksError(null);
    } catch (e: unknown) {
      setLinks([]); setLinkTotal(null);
      setLinksError(e instanceof ApiErr ? e.message : "关联列表加载失败");
    }
  }, [projectId, id, linkCurrent, linkPageSize]);
  useEffect(() => { if (mayRead && canLinkRead) void loadLinks(); }, [mayRead, canLinkRead, loadLinks]);

  const loadReports = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      const page = await planApi.listReports(id,
        { project_id: projectId, current: reportCurrent, size: reportPageSize });
      setReports(page.items);
      setReportTotal(page.total ?? null);
      setReportsError(null);
    } catch (e: unknown) {
      setReports([]); setReportTotal(null);
      setReportsError(e instanceof ApiErr ? e.message : "报告列表加载失败");
    }
  }, [projectId, id, reportCurrent, reportPageSize]);
  useEffect(() => { if (mayRead && canReportRead) void loadReports(); }, [mayRead, canReportRead, loadReports]);

  // 环境清单只在「真的会摆 env 控件」时拉（缺 update 或缺 env 读位就不发这条请求）。
  const loadEnvs = useCallback(async (): Promise<void> => {
    try {
      const r = await get<Page<EnvRow>>("/envs?project_id=" + encodeURIComponent(projectId) + "&size=200",
        { silent: true });
      setEnvs(r.items); setEnvsError(false);
    } catch { setEnvs([]); setEnvsError(true); }
  }, [projectId]);
  useEffect(() => {
    if (mayRead && canEnvRead && (canLinkUpdate || canLinkCreate)) void loadEnvs();
  }, [mayRead, canEnvRead, canLinkUpdate, canLinkCreate, loadEnvs]);

  // join 的唯一键：status.links[i].link_id == PlanLinkOut.id（services.py:605-606 现核）。
  const statusMap = useMemo(
    () => new Map((status?.links ?? []).map((l) => [l.link_id, l])),
    [status],
  );
  const envName = useCallback((envId: string): string =>
    envs.find((e) => e.id === envId)?.name ?? shortId(envId), [envs]);

  function archiveOne(): void {
    if (!plan) return;
    Modal.confirm({
      title: `归档计划「${plan.name}」？`,
      content: "归档是终态：归档后计划不再参与执行编排，且**没有反归档入口**（重复归档后端会 409）。",
      okText: "归档", okButtonProps: { danger: true, "data-testid": "plan-detail-archive-ok" },
      cancelText: "取消",
      onOk: async () => {
        try {
          setPlan(await planApi.archive(plan.id, { project_id: projectId }));
          message.success("已归档");
          void loadStatus(); // 展示态是现算的，归档后 status 取 archived
        } catch { /* toast 已在 client 弹 */ }
      },
    });
  }

  function removeLink(row: PlanLinkOut): void {
    Modal.confirm({
      title: `从计划摘除「${row.subject_name}」？`,
      content: "摘挂只删关联行，用例对象本身毫发无损；已生成的报告是快照副本，也不动。",
      okText: "摘除", okButtonProps: { danger: true, "data-testid": "plan-link-remove-ok" },
      cancelText: "取消",
      onOk: async () => {
        setBusyLinkId(row.id);
        try {
          await planApi.deleteLink(row.plan_id, row.id, { project_id: projectId });
          message.success("已摘除");
          void loadLinks();
          void loadStatus(); // 分母变了：计数与两个率跟着变
        } catch { /* toast 已在 client 弹 */ } finally { setBusyLinkId(null); }
      },
    });
  }

  /** env 编辑的互斥两路（422「env_id 与 clear_env 不能同时给」由类型堵死，见
   *  PlanLinkUpdateBody）：选了环境发 {env_id}，清空发 {clear_env:true}，永远只带一个。 */
  async function saveLinkEnv(row: PlanLinkOut, next: string | undefined): Promise<void> {
    setBusyLinkId(row.id);
    const body: PlanLinkUpdateBody = next === undefined
      ? { project_id: projectId, clear_env: true }
      : { project_id: projectId, env_id: next };
    try {
      const out = await planApi.updateLink(row.plan_id, row.id, body);
      setLinks((prev) => prev.map((l) => (l.id === out.id ? out : l)));
      message.success("环境已更新");
    } catch { /* toast 已在 client 弹 */ } finally { setBusyLinkId(null); }
  }

  function generateReport(): void {
    if (!id) return;
    setReportBusy(true);
    planApi.createReport(id, { project_id: projectId })
      .then(() => {
        message.success("报告已生成（当前结论定格为快照）");
        void loadReports();
      })
      .catch(() => { /* 原话已由 client toast */ })
      .finally(() => setReportBusy(false));
  }

  const linkColumns: ColumnsType<PlanLinkOut> = [
    { title: "对象", key: "subject",
      render: (_: unknown, r) => (
        <Space size={4} data-testid={"plan-link-row-" + r.id}>
          <Tag style={{ marginInlineEnd: 0 }}
            color={SUBJECT_TYPES[r.subject_type]?.color ?? "default"}>
            {SUBJECT_TYPES[r.subject_type]?.label ?? r.subject_type}
          </Tag>
          <Typography.Text style={{ fontSize: 12 }}>{r.subject_name}</Typography.Text>
        </Space>
      ) },
    { title: "对象 id", dataIndex: "subject_id", key: "subject_id", width: 120,
      render: (v: string) => (
        <Typography.Text type="secondary" className="tp-mono" style={{ fontSize: 11 }}
          title={v}>{shortId(v)}</Typography.Text>) },
    { title: "执行结论", key: "result", width: 150,
      render: (_: unknown, r) => <LinkResultCell st={statusMap.get(r.id)} rowId={r.id} /> },
    { title: "环境", key: "env", width: 200,
      render: (_: unknown, r) => {
        const label = r.env_id
          // 有 env id 但清单没取到/查不到名字：画短 id（生码），不编名字（schedules 同款）。
          ? (canEnvRead ? envName(r.env_id) : shortId(r.env_id))
          : <Tooltip title="未单独覆盖：执行时沿用该对象自己的默认环境（后端建关联时抄 subject 的环境）">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{ENV_INHERIT}</Typography.Text>
            </Tooltip>;
        // env 编辑把手同时要求 link:update 与 env:config:read：缺 env 读位时摆一个
        // 永远拉不出选项的空下拉，就是假门（§13 纪律 1）。
        if (!canLinkUpdate || !canEnvRead) return <span data-testid={"plan-link-env-" + r.id}>{label}</span>;
        return (
          <Space size={6} style={{ width: "100%" }}>
            <span data-testid={"plan-link-env-" + r.id}
              style={{ fontSize: 12, maxWidth: 96, overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}>
              {label}
            </span>
            <Select size="small" data-testid={"plan-link-env-edit-" + r.id} allowClear
              style={{ width: 130 }} value={r.env_id ?? undefined}
              disabled={busyLinkId === r.id}
              placeholder={envsError ? "环境清单没取到" : "覆盖…"}
              onChange={(v: string | undefined) => void saveLinkEnv(r, v)}
              options={envs.map((e) => ({ value: e.id, label: e.name }))} />
          </Space>
        );
      } },
    { title: "挂入时间", dataIndex: "created_at", key: "created_at", width: 150,
      render: (v: string | null) => (
        <Typography.Text data-testid="plan-link-created" style={{ fontSize: 12 }}>
          {fmtTime(v) ?? "—"}
        </Typography.Text>) },
    { title: "操作", key: "ops", width: 88,
      render: (_: unknown, row: PlanLinkOut) => canLinkDelete ? (
        <Button size="small" danger data-testid={"plan-link-remove-" + row.id}
          disabled={busyLinkId === row.id} onClick={() => removeLink(row)}>摘除</Button>
      ) : null },
  ];

  const reportColumns: ColumnsType<PlanReportListRow> = [
    { title: "报告名", dataIndex: "name", key: "name",
      render: (v: string, r) => (
        // 6c 落地：/plan-reports/:id 路由已在 app.tsx（`{path:"plan-reports/:id"}`），
        // 报告名列与 ⑨ 测试同批翻成真链接（plans.tsx 名称列同款形状）。
        <a data-testid={"plan-report-row-" + r.id} onClick={() => nav("/plan-reports/" + r.id)}>{v}</a>
      ) },
    { title: "生成时状态", key: "status", width: 110,
      render: (_: unknown, r) => {
        const m = planDisplayMeta(r.status);
        return <Tag color={m.color} data-testid={"plan-report-status-" + r.id}>{m.label}</Tag>;
      } },
    { title: "通过率", key: "pass", width: 150,
      render: (_: unknown, r) => (
        <Space size={6} data-testid={"plan-report-pass-" + r.id}
          data-rate={String(r.pass_rate)} data-execute-rate={String(r.execute_rate)}>
          <PassRing rate={r.pass_rate} size={30} />
          <span>{ratePct(r.pass_rate)}</span>
        </Space>
      ) },
    { title: "执行率", key: "exec", width: 80,
      render: (_: unknown, r) => <span>{ratePct(r.execute_rate)}</span> },
    { title: "过/败", key: "counts", width: 80,
      render: (_: unknown, r) => (
        <Typography.Text style={{ fontSize: 12 }}>{r.passed + " / " + r.failed}</Typography.Text>) },
    { title: "生成时间", dataIndex: "created_at", key: "created_at", width: 150,
      render: (v: string | null) => (
        <Typography.Text style={{ fontSize: 12 }}>{fmtTime(v) ?? "—"}</Typography.Text>) },
  ];

  // 无读权限：什么都渲染不了，也**一条请求都不发**（门在 effect 的 mayRead 上）。
  if (!mayRead) {
    return (
      <Alert type="warning" showIcon style={{ marginTop: 8 }} data-testid="plan-detail-no-read"
        message="当前项目没有 testplan:plan:read 权限"
        description="计划详情（含实时状态）需要读权限，权限位在后端把守。" />
    );
  }
  // D38：撞 403 走权限空页——位名只认后端原话。
  if (planDenied) {
    return <PermEmpty error={planDenied} projectName={project?.name ?? ""} context="查看该测试计划" />;
  }
  if (notFoundMsg) {
    // 「报告没取到」同款（reportDetail.tsx:400）：原话进 description，不 closable。
    return (
      <Alert type="error" showIcon style={{ margin: 24 }} data-testid="plan-detail-not-found"
        message="计划没取到——不存在，或它属于别的项目"
        description={<EchoBlock text={notFoundMsg} testid="plan-detail-not-found-text" />} />
    );
  }
  if (!plan) {
    if (loadError) {
      // 非 closable；重试只在「再试一次真的可能不同」的来路递（D142 口径）——transient 在这里。
      // 404/410 走上面的 notFound 分支，那里**不摆重试**：不存在不是暂时。
      return (
        <div style={{ margin: 24 }}>
          <Alert type="error" showIcon data-testid="plan-detail-load-error"
            message="计划详情加载失败" description={<EchoBlock text={loadError} />} />
          <Button style={{ marginTop: 12 }} data-testid="plan-detail-retry"
            onClick={() => { setLoadError(null); void loadPlan(); void loadStatus(); }}>重试</Button>
        </div>
      );
    }
    return <Spin style={{ display: "block", margin: "20vh auto" }} data-testid="plan-detail-loading" />;
  }

  // 展示态只有 /status 给过这一题的答案：status 没取到时**不画态**（用 archived 这个真实
  // 布尔顶上），不拿 plan 猜一个「未开始」——口径 ① 对态同样成立。
  const dm = status ? planDisplayMeta(status.status) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Button data-testid="plan-detail-back" onClick={() => nav("/plans")}>返回计划列表</Button>
        <Space>
          <Button icon={<ReloadOutlined />} data-testid="plan-detail-reload"
            onClick={() => {
              void loadPlan(); void loadStatus();
              if (canLinkRead) void loadLinks();
              if (canReportRead) void loadReports();
            }}>刷新</Button>
          {/* 归档钮只对未归档计划渲染（终态无反归档——摆了把手就是引人点必失败的假门），
              且权限位是 :manage 不是 :update。 */}
          {canManage && !plan.archived && (
            <Button danger data-testid="plan-detail-archive" onClick={archiveOne}>归档</Button>
          )}
        </Space>
      </Space>

      <Card size="small" data-testid="plan-detail-status-card"
        title={
          <Space wrap size={6}>
            <Typography.Text strong>{plan.name}</Typography.Text>
            {/* 态只有 /status 答过这一题：没取到时不画态（archived 是另一列真实布尔，
                下面的归档 Tag 答它），不拿 plan 编一个「未开始」（口径 ① 对态同样成立）。 */}
            {dm && <Tag color={dm.color} data-testid="plan-detail-display-status">{dm.label}</Tag>}
            {plan.archived
              ? <Tag color="orange" data-testid="plan-detail-archived-tag">已归档</Tag>
              : <Typography.Text type="secondary" style={{ fontSize: 12 }}>未归档</Typography.Text>}
          </Space>
        }>
        {status ? (
          <>
            <Space size={24} wrap>
              {/* 外壳只挂后端原值（data-rate），百分数**只由 PassRing 从同一个 rate 算一次**。
                  这里先前是自己 `Math.round(status.pass_rate*100)` 再算一遍、和环里那份并存，
                  测试钉的是外壳那个数 ⇒ 有人把 rate 改成 `passed/total` 时外壳跟着变、测试照绿
                  （变异 V1 实测 SURVIVED）。外壳改挂原值后，环是唯一算式，也是唯一断言点。 */}
              <span data-testid="plan-detail-pass-ring" data-rate={String(status.pass_rate)}>
                <PassRing rate={status.pass_rate} size={56} />
              </span>
              <Descriptions size="small" column={4} colon={false} items={[
                // 两个率与六个计数全部直读 /status（口径 ①：页面零除法——data-rate 上钉的是
                // 后端给的原值，测试逐字断言，naive passed/total 复算必红）。
                { key: "pr", label: "通过率", children: (
                  <span data-testid="plan-detail-pass-rate" data-rate={String(status.pass_rate)}>
                    {ratePct(status.pass_rate)}
                  </span>) },
                { key: "er", label: "执行率", children: (
                  <span data-testid="plan-detail-execute-rate" data-rate={String(status.execute_rate)}>
                    {ratePct(status.execute_rate)}
                  </span>) },
                { key: "to", label: "关联总数", children: status.total },
                { key: "ex", label: "已执行", children: status.executed },
                { key: "ig", label: "执行中", children: status.executing },
                { key: "ne", label: "未执行", children: status.not_executed },
                { key: "pa", label: "通过", children: status.passed },
                { key: "fa", label: "未通过", children: status.failed },
              ]} />
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
              两个率出自后端唯一算式 _rates（分母恒为关联总数；未执行/执行中拉低通过率，
              空计划是 0% 不是 100%）。本页一条除法都不做。
            </Typography.Text>
          </>
        ) : null}
        {/* 计划本体的静态列（PlanOut 真实字段）——与现算数字分区：这些不依赖 /status。 */}
        <Descriptions size="small" column={3} colon={false} style={{ marginTop: status ? 8 : 0 }}
          items={[
            { key: "desc", label: "描述", children: plan.description ?? "—" },
            { key: "ct", label: "创建时间", children: (
              <span data-testid="plan-detail-created">{fmtTime(plan.created_at) ?? "—"}</span>) },
            { key: "ut", label: "更新时间", children: (
              <span data-testid="plan-detail-updated">{fmtTime(plan.updated_at) ?? "—"}</span>) },
          ]} />
        {status ? null : (
          statusError ? (
            <Alert type="error" showIcon data-testid="plan-detail-status-error"
              message="实时状态没取到（四态与两个率是 /status 现算的，这一屏没有结论可画）"
              description={<EchoBlock text={statusError} />} />
          ) : <Spin size="small" data-testid="plan-detail-status-loading" />
        )}
      </Card>

      {/* ── 关联用例 ── */}
      {canLinkRead ? (
        <Card size="small" title="关联用例" data-testid="plan-detail-links"
          extra={canLinkCreate && (
            <Button type="primary" size="small" icon={<PlusOutlined />}
              data-testid="plan-link-create" onClick={() => setPickerOpen(true)}>加关联</Button>
          )}>
          {linksError && (
            <Alert type="error" showIcon style={{ marginBottom: 8 }} data-testid="plan-detail-links-error"
              message="关联列表加载失败" description={<EchoBlock text={linksError} />} />
          )}
          <Table<PlanLinkOut> size="small" rowKey="id" dataSource={links} columns={linkColumns}
            pagination={false}
            locale={{ emptyText: linksError
              ? "没取到关联——原因见上方错误条，点右上角「刷新」重试"
              : canLinkCreate ? "还没有关联，点右上角「加关联」" : "还没有关联（你没有 testplan:link:create 权限）" }} />
          <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
            <ListPager current={linkCurrent} pageSize={linkPageSize} total={linkTotal}
              onPage={setLinkCurrent} onPageSize={setLinkPageSize} />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
            「执行结论」按 link_id join 实时状态——join 不上画「—」（跨页时是常态，不是没跑过）；
            「执行中」来自 executing 布尔，不混进结论词表。
          </Typography.Text>
        </Card>
      ) : (
        <Alert type="warning" showIcon data-testid="plan-detail-links-noread"
          message="当前项目没有 testplan:link:read 权限"
          description="关联用例清单需要读权限，缺位时这一节整块不演空表。" />
      )}

      {/* ── 计划报告 ── */}
      {canReportRead ? (
        <Card size="small" title="计划报告" data-testid="plan-detail-reports"
          extra={canReportCreate && (
            <Button size="small" type="primary" loading={reportBusy}
              data-testid="plan-report-generate" onClick={generateReport}>生成报告</Button>
          )}>
          {reportsError && (
            <Alert type="error" showIcon style={{ marginBottom: 8 }} data-testid="plan-detail-reports-error"
              message="报告列表加载失败" description={<EchoBlock text={reportsError} />} />
          )}
          <Table<PlanReportListRow> size="small" rowKey="id" dataSource={reports}
            columns={reportColumns} pagination={false}
            locale={{ emptyText: reportsError
              ? "没取到报告——原因见上方错误条，点右上角「刷新」重试"
              : canReportCreate
                ? "还没有报告——点右上角「生成报告」把当前结论定格成快照"
                : "还没有报告（你没有 testplan:report:create 权限）" }} />
          <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
            <ListPager current={reportCurrent} pageSize={reportPageSize} total={reportTotal}
              onPage={setReportCurrent} onPageSize={setReportPageSize} />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
            报告是生成时刻的定格快照：此后的执行不动已生成的报告。点报告名进详情页
            （/plan-reports/:id，含明细分页——6c 已落地）。
          </Typography.Text>
        </Card>
      ) : (
        <Alert type="warning" showIcon data-testid="plan-detail-reports-noread"
          message="当前项目没有 testplan:report:read 权限"
          description="计划报告清单需要读权限，缺位时这一节整块不演空表。" />
      )}

      <LinkPickerModal open={pickerOpen} planId={plan.id} projectId={projectId} perms={perms}
        canEnvRead={canEnvRead} envs={envs} envsError={envsError}
        onClose={() => setPickerOpen(false)}
        onCreated={() => {
          setPickerOpen(false);
          void loadLinks();
          void loadStatus(); // 新增一条关联 = 分母变了，状态卡跟着重取
        }} />
    </div>
  );
}

export default function PlanDetailPage() {
  return (
    <div data-testid="page-plan-detail">
      <PageHead title="计划详情" />
      <ProjectGate><Detail /></ProjectGate>
    </div>
  );
}
