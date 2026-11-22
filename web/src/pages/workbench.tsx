// 工作台（§11.5.2 一期简化版）：统计卡 ×4 | 近 7 天通过率趋势 | 最近执行 10 条 |
// 我最近编辑 10 条 | 快捷入口。项目卡列表保留在下方——它是全应用的当前项目开关
// （useAuth().setProject），统计区所有读数都跟着它走。
//
// 诚实条款（§13 纪律 1）：
// - 「我最近编辑」只有 scenario / ui_case 两类可算——api_definition / api_case 表上
//   没有记录编辑者的列（owner_id 是负责人不是编辑者），覆盖范围按后端下发的
//   my_recent_edits_types 如实标注，不假装四类都有。
// - 通过率 null（窗口内没有有效分母）画「-」，不画 0%——「没数据」和「全挂」是两回事。
//   同一把尺管着取不到数的时刻：/workbench-stats 是 silent 请求（api() 不弹 toast），
//   失败/未落定时四张卡一律画「-」并标一行「统计未加载」，不许 `?? 0` 把失败演成实测零值。
// - 快捷入口里未开放的批次 disabled + Tooltip 标批次，与 shell.tsx 侧栏同款，不做点了
//   没动静的假按钮（导入已在 1E T4 兑现为三步向导，不再是 disabled 占位）。
import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Button, Card, Col, Empty, Form, Input, List, Modal, Row, Space, Spin, Statistic, Tag,
  Tooltip, Typography, message,
} from "antd";
import {
  AndroidOutlined, ApiOutlined, ImportOutlined, NodeIndexOutlined, PlusOutlined,
  RobotOutlined, DesktopOutlined,
} from "../ui/icons";
import { useNavigate } from "react-router-dom";
import { get, post } from "../api/client";
import ImportWizard from "../api/ImportWizard";
import { PageHead } from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import type { ProjectOut } from "../auth/store";
import { fmtTime } from "../shared/timefmt";
import { tpv } from "../theme";
import { STATUSES, SUBJECT_TYPES, TRIGGERS, vocabMeta } from "../shared/runVocab";
import type { TrendPoint } from "./workbenchTrend";

// 懒加载同 SceneEditor/报告详情的理由（app.tsx 注释）：工作台是 index 路由，
// 静态引着 ECharts 会让**每一个页面**的首屏 main chunk 都背着它。dynamic import
// 让 echarts 单独成 chunk，只有真正渲染趋势图时才取。
const WorkbenchTrend = lazy(() => import("./workbenchTrend"));

const ROLE_NAMES: Record<string, string> = {
  SYSTEM_ADMIN: "系统管理员", PROJECT_ADMIN: "项目管理员", MEMBER: "测试工程师", READONLY: "只读",
};

// —— 响应类型本地声明：**不是**因为端点没进 schema.d.ts（它在），而是因为生成物对这个
// 端点的响应只能给出 `unknown`——`@service` 的返回标注是 BaseModel，_add_route 明确不给
// 裸 BaseModel 挂 response_model（core/service.py），所以 OpenAPI 里就没有形状。这与
// api/ui.ts 的 debugCase 手写 UiDebugResult 是同一条口径（R129 记的「混合类型」）。
// 字段以后端 app/modules/workbench/services.py 的 WorkbenchStatsOut 为准。
export interface WorkbenchStats {
  window: { days: number; since: string; until: string };
  // adb_case 是 1D T8 加的第 5 类资产（services.py AssetCounts）——总数与明细都必须吃进它，
  // 否则统计卡「资产数」系统性少报（1E T6 核对出的真 bug：后端发了、前端漏了）。
  assets: { api_definition: number; api_case: number; scenario: number; ui_case: number; adb_case: number };
  runs_7d: number;
  pass_rate: number | null;
  top_fail: { subject_id: string; subject_name: string; fail_count: number } | null;
  daily: TrendPoint[];
  recent_runs: Array<{
    id: string; subject_name: string; subject_type: string; trigger: string; status: string;
    started_at: string | null; elapsed_ms: number | null; created_by_name: string | null; pass_rate: number | null;
  }>;
  my_recent_edits: Array<{ id: string; name: string; type: string; updated_at: string | null }>;
  my_recent_edits_types: string[];
}

/** 「没有读数」的画法：null（无有效分母 / 没取到）→「-」，绝不画 0% 或 0。 */
const NO_DATA = "-";

/** 通过率展示：null（无有效分母）→「-」，绝不画 0%。 */
export function fmtRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return NO_DATA;
  return (rate * 100).toFixed(1) + "%";
}

// 「我最近编辑」注记与条目标签共用这一份人话名，别处不再各抄一份（漂移是实测出来的）。
const ASSET_TYPE_NAMES: Record<string, string> = {
  api_definition: "接口", api_case: "用例", scenario: "场景", ui_case: "UI 用例", adb_case: "ADB",
};
const ASSET_TYPE_ORDER = ["api_definition", "api_case", "scenario", "ui_case", "adb_case"];

/**
 * 「覆盖」后半句：只点名**没进本榜**的类别，且完全由后端下发的 my_recent_edits_types 推。
 * WHY：不能写「接口/用例暂无编辑者记录」——adb_case 有 updated_by（services.py:19-22），
 * 它没进榜是前端分节没加宽的范围决定，不是表上没列；照 types 推也保证后端加宽时这句话自己跟上。
 */
function editScopeNote(types: string[]): string {
  const off = ASSET_TYPE_ORDER.filter((t) => !types.includes(t)).map((t) => ASSET_TYPE_NAMES[t]);
  return off.length ? `（${off.join(" / ")} 未进本榜）` : "";
}

/** 快捷入口（§11.5.2）。to 缺省且 openWizard 缺省 = 未开放批次，disabled + Tooltip 标批次。 */
const QUICK: Array<{ key: string; label: string; icon: ReactNode; to?: string; note?: string; wizard?: boolean }> = [
  { key: "api-new", label: "新建接口", icon: <ApiOutlined />, to: "/api" },
  // 1E T4 兑现：哨兵换真——导入打开三步向导（§11.4.6），不再是 disabled 占位
  { key: "import", label: "导入", icon: <ImportOutlined />, wizard: true },
  { key: "scene-new", label: "新建场景", icon: <NodeIndexOutlined />, to: "/scene" },
  { key: "ui-cases", label: "UI 用例", icon: <DesktopOutlined />, to: "/ui/cases" },
  { key: "adb-cases", label: "ADB 用例", icon: <AndroidOutlined />, to: "/adb/cases" },
  { key: "pilot", label: "问 Pilot", icon: <RobotOutlined />, to: "/bench" },
];

function StatsSection({ project }: { project: ProjectOut }) {
  const nav = useNavigate();
  const [st, setSt] = useState<WorkbenchStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    get<WorkbenchStats>("/workbench-stats?project_id=" + encodeURIComponent(project.id), { silent: true })
      .then((r) => { if (!dead) setSt(r); })
      .catch(() => { if (!dead) setSt(null); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [project.id]);

  const noRuns = st !== null && st.runs_7d === 0;
  // 请求失败（silent 之下 api() 不弹 toast）必须自己显形：否则 st=null && !loading 会
  // 让四张卡把「没取到」画成 0/0/-/「无」——四个数冒充实测结果。
  const failed = st === null && !loading;
  const editTypeLabel = ASSET_TYPE_NAMES;
  // 「→ 打开」的目标路由（app.tsx 实有：/scene/:id、/ui/cases/:id）。后端 my_recent_edits
  // 只发这两类（services.py docstring 口径），表外类型前端渲染纯文本——宁缺毋伪。
  // 没有 api 条目不是漏写：api_definition/api_case 表上确实没有编辑者列。
  const EDIT_ROUTES: Record<string, string> = { scenario: "/scene/", ui_case: "/ui/cases/" };

  return (
    <Spin spinning={loading}>
      <Row gutter={[16, 16]} data-testid="wb-stats">
        <Col xs={12} md={6}>
          <Card size="small" data-testid="wb-card-assets">
            <Statistic title="资产数" value={st
              ? (st.assets.api_definition ?? 0) + (st.assets.api_case ?? 0)
                + (st.assets.scenario ?? 0) + (st.assets.ui_case ?? 0) + (st.assets.adb_case ?? 0)
              : NO_DATA} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {st ? (<>接口 {st.assets.api_definition ?? 0} · 用例 {st.assets.api_case ?? 0} · 场景 {st.assets.scenario ?? 0} · UI {st.assets.ui_case ?? 0} · ADB {st.assets.adb_case ?? 0}</>)
                : (<>接口 {NO_DATA} · 用例 {NO_DATA} · 场景 {NO_DATA} · UI {NO_DATA} · ADB {NO_DATA}</>)}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" data-testid="wb-card-runs"><Statistic title="近 7 天执行" value={st ? st.runs_7d : NO_DATA} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" data-testid="wb-card-rate">
            <Statistic title="近 7 天通过率" value={fmtRate(st?.pass_rate)} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" data-testid="wb-card-topfail">
            <Statistic title="失败 TOP1 场景"
              value={st ? (st.top_fail ? st.top_fail.subject_name : "无") : NO_DATA}
              valueStyle={{ fontSize: 18 }} />
            {st?.top_fail && (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>失败 {st.top_fail.fail_count} 次</Typography.Text>
            )}
          </Card>
        </Col>
      </Row>

      {/* 静默失败（silent 请求）api() 不弹 toast，页面自己说明白：「-」是没取到，不是 0 */}
      {failed && (
        <Typography.Text type="secondary" data-testid="wb-stats-failed"
          style={{ fontSize: 12, display: "block", marginTop: 8 }}>
          统计未加载（本次请求失败）——以上「-」表示没取到，不是 0
        </Typography.Text>
      )}

      <Card size="small" title="近 7 天通过率趋势" style={{ marginTop: 16 }} data-testid="wb-trend">
        {noRuns ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} data-testid="wb-trend-empty"
            description="近 7 天还没有执行记录" />
        ) : st ? (
          <Suspense fallback={<Spin style={{ display: "block", margin: "40px auto" }} />}>
            <WorkbenchTrend points={st.daily} />
          </Suspense>
        ) : null}
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card size="small" title="最近执行" data-testid="wb-recent-runs">
            {(st?.recent_runs.length ?? 0) === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有执行记录" />
            ) : (
              <List size="small" dataSource={st?.recent_runs ?? []} rowKey={(r) => r.id}
                renderItem={(r) => {
                  const stt = vocabMeta(STATUSES, r.status);
                  const spt = vocabMeta(SUBJECT_TYPES, r.subject_type);
                  // 未知 trigger 渲染原文（runVocab.ts 注释承诺的降级，也是同栏 STATUSES/SUBJECT_TYPES
                  // 同款降级）：旧的 TRIGGERS[r.trigger] + {trg && <Tag>} 把库里存着的触发方式静默吞掉——
                  // 同第 22 轮「静默假零」一族：发生了的事不许装作没发生。本页触发徽标本来就不画图标，
                  // 降级就只有原文。
                  const trg = TRIGGERS[r.trigger] ?? { label: r.trigger };
                  return (
                    <List.Item>
                      <Space size={8} wrap>
                        <Tag color={spt.color}>{spt.label}</Tag>
                        <Typography.Text ellipsis style={{ maxWidth: 200 }}>{r.subject_name}</Typography.Text>
                        <Tag color={stt.color}>{stt.label}</Tag>
                        <Tag>{trg.label}</Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {r.elapsed_ms == null ? "—" : r.elapsed_ms + " ms"}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {fmtTime(r.started_at, { seconds: false }) ?? "—"}
                          {r.created_by_name ? " · " + r.created_by_name : ""}
                        </Typography.Text>
                      </Space>
                    </List.Item>
                  );
                }} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="我最近编辑" data-testid="wb-my-edits"
            extra={st && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                覆盖：{(st.my_recent_edits_types ?? []).map((t) => editTypeLabel[t] ?? t).join(" / ")}
                {editScopeNote(st.my_recent_edits_types ?? [])}
              </Typography.Text>
            )}>
            {(st?.my_recent_edits.length ?? 0) === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="最近没有你编辑的资产" />
            ) : (
              <List size="small" dataSource={st?.my_recent_edits ?? []} rowKey={(r) => r.type + r.id}
                renderItem={(r) => (
                  <List.Item>
                    <Space size={8}>
                      <Tag color={r.type === "scenario" ? "purple" : "green"}>{editTypeLabel[r.type] ?? r.type}</Tag>
                      {/* §11.4.1「名称·类型·时间 → 打开」：名字即入口，跳各类型详情页；
                          未知类型（后端加宽覆盖面而前端没跟上时）保持纯文本，不给死链。 */}
                      {EDIT_ROUTES[r.type] ? (
                        <Typography.Link data-testid={"wb-edit-open-" + r.id}
                          onClick={() => nav(EDIT_ROUTES[r.type] + r.id)}
                          style={{ maxWidth: 220 }} ellipsis>{r.name}</Typography.Link>
                      ) : (
                        <Typography.Text ellipsis style={{ maxWidth: 220 }}>{r.name}</Typography.Text>
                      )}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )} />
            )}
          </Card>
        </Col>
      </Row>

      <Card size="small" title="快捷入口" style={{ marginTop: 16 }} data-testid="wb-quick">
        <Space wrap>
          {QUICK.map((q) => {
            const btn = (
              <Button key={q.key} icon={q.icon} disabled={!q.to && !q.wizard} data-testid={"wb-quick-" + q.key}
                onClick={() => { if (q.wizard) setWizardOpen(true); else if (q.to) nav(q.to); }}>
                {q.label}
              </Button>
            );
            return q.note
              ? <Tooltip key={q.key} title={q.note}><span>{btn}</span></Tooltip>
              : btn;
          })}
        </Space>
        <ImportWizard projectId={project.id} open={wizardOpen} onClose={() => setWizardOpen(false)}
          onImported={() => nav("/api")} />
      </Card>
    </Spin>
  );
}

export default function Workbench() {
  const { project, setProject } = useAuth();
  const nav = useNavigate();
  const [items, setItems] = useState<ProjectOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 项目卡默认只画前 12 个：一个账号下可能有数百个项目（实测 200 个 ≈ 10000px 页面），
  // 全量渲染会让滚动条变成一根极细的线、页面像「长得离谱」。需要时一键展开全部。
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [form] = Form.useForm();

  async function load() {
    setLoading(true);
    try {
      const r = await get<{ items: ProjectOut[] }>("/projects?size=200");
      setItems(r.items);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function create(v: { name: string; description?: string }) {
    if (submitting) return; // Enter+OK 双触发的防抖
    setSubmitting(true);
    try {
      const pr = await post<ProjectOut>("/projects", v);
      message.success("项目已创建");
      setOpen(false);
      form.resetFields();
      setProject(pr);
      void load();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="workbench">
      <PageHead title="工作台"
        desc="当前项目的资产规模、近 7 天执行与通过率、最近编辑；项目卡决定全站项目口径。"
        extra={(<Space>
          {/* 1F T6 哨兵翻真：此前 disabled + title「由 1F 开放」（ledger R69 的批次口径），
              1F 落地后改真入口——跳 /bench（候选场景卡在试验台出卡）。「生成即落库」仍是二期
              （§4 :206 draft 表 / §13 :1604 create_scenario），这里给的是出候选卡的入口，口径不变。 */}
          <Button icon={<RobotOutlined />} data-testid="wb-pilot-generate" onClick={() => nav("/bench")}>让 Pilot 生成</Button>
          <Button type="primary" icon={<PlusOutlined />} data-testid="project-create" onClick={() => setOpen(true)}>
            新建项目
          </Button>
        </Space>)} />

      {/* §11.5.2 统计区：跟着当前项目走；没选项目时不猜一个项目画数（那是假数据） */}
      {project ? (
        <div data-testid="wb-stats-section">
          <StatsSection project={project} />
        </div>
      ) : (
        <Card style={{ marginTop: 8 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先在下方选择项目，统计区随项目切换" />
        </Card>
      )}

      <Typography.Title level={5} style={{ margin: "24px 0 8px" }}>项目</Typography.Title>
      <Spin spinning={loading}>
        {items.length === 0 && !loading ? (
          <Card style={{ marginTop: 8 }}>
            <Empty description="还没有项目" image={Empty.PRESENTED_IMAGE_SIMPLE}>
              <Button type="primary" onClick={() => setOpen(true)}>新建项目</Button>
            </Empty>
          </Card>
        ) : (
          <div data-testid="project-list" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16, marginTop: 8 }}>
            {(showAllProjects ? items : items.slice(0, 12)).map((it) => {
              const active = project?.id === it.id;
              return (
                <Card
                  key={it.id}
                  hoverable
                  onClick={() => { setProject(it); message.success("已切换到「" + it.name + "」"); }}
                  style={{
                    borderLeft: active ? "3px solid var(--tp-primary-600)" : "3px solid transparent",
                    background: active ? "var(--tp-bg-selected)" : "var(--tp-bg-container)",
                    boxShadow: tpv.shadow.s1,
                  }}>
                  <Space direction="vertical" size={4} style={{ width: "100%" }}>
                    <Space>
                      <Typography.Text strong style={{ fontSize: 16 }}>{it.name}</Typography.Text>
                      {active && <Tag color="green">当前</Tag>}
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      {it.description || "（暂无描述）"}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {"我的角色：" + String(ROLE_NAMES[it.my_role] ?? it.my_role)}
                    </Typography.Text>
                  </Space>
                </Card>
              );
            })}
          </div>
        )}
        {items.length > 12 && (
          <div style={{ marginTop: 12 }}>
            <Button data-testid="project-list-toggle"
              onClick={() => setShowAllProjects((v) => !v)}>
              {showAllProjects ? "只看前 12 个" : `显示全部 ${items.length} 个项目`}
            </Button>
          </div>
        )}
      </Spin>
      <Modal title="新建项目" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} okText="创建" confirmLoading={submitting} cancelText="取消">
        <Form form={form} layout="vertical" onFinish={create}>
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: "请输入项目名称" }]} style={{ marginBottom: 16 }}>
            <Input data-testid="project-name" placeholder="如：履约回归" autoFocus />
          </Form.Item>
          <Form.Item name="description" label="描述（可选）">
            <Input.TextArea rows={3} maxLength={500} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
