// 测试计划列表（D183 步 6a，§11.1 任务中心「测试计划」；后端 app/modules/testplan/ 为准）。
//
// 本页四条命门口径（写错就是假门/谎数，逐条对后端）：
// ① 列表行 = PlanOut 九字段；「这个计划跑到哪了」由 **D275 批量摘要**回答
//    （POST /plan-status-batch 一次算齐当前页：状态/通过率/执行率/各类型用例数，
//    判据与详情页 /plans/{id}/status 同源）。**不逐行拉 /status**（50 行 = 50 份明细，
//    N+1 且给列表编一个端点没给过的数）；摘要取不到时画「—」+ 提示条，不画 0。
// ② 归档是**终态**：后端对已归档再归档 409 already_archived，无反归档路径。归档钮只对
//    未归档行渲染（对已归档行摆把手=点了必 409 的假门）；改名的 PATCH 也改不动归档
//    （后端把 archived 声明成拒收哨兵位，传值 422）。
// ③ 权限位 testplan:plan:{read,create,update,delete} + 归档走 **:manage**（不是 :update）。
//    无 :read：表格压根不渲染、列表请求压根不发（schedules.tsx:777-784 同款）；
//    写钮缺位一律**不渲染**（不是禁用）。
// ④ 分页 = 页码制（current/size，PlanListIn 逐字），后端 paginate_page 钳 size 1..200，
//    本端点压根没有 cursor——请求永远不许带 cursor 键。
// 契约（nav.spec 钉）：根节点 data-testid="page-plans" + PageHead 标题「测试计划」。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Input, Modal, Progress, Select, Space, Tag, Tooltip, Tree, Typography, message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { DataNode } from "antd/es/tree";
import type { TagProps } from "antd";
import { PlusOutlined, ReloadOutlined, StarOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get } from "../api/client";
import { planApi } from "../api/plan";
import type { PlanModuleNode, PlanModuleTree, PlanRow, PlanStatusSummary } from "../api/plan";
import type { MemberRow } from "../api/api";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import { applyColumnPrefs, emptyFilter, isFilterEmpty, timeFromLocalInput, timeToLocalInput } from "../shared/listFilters";
import type { ColumnChoice, FilterDoc } from "../shared/listFilters";

// D212：列设置面板要露的列（key 与下方 columns 的 key 逐字对上，对不上就是
// 「面板能勾、表头不动」的假把手——plans.test.tsx 的勾掉列用例钉这一环）。
// 操作列不列：它带着编辑/复制/归档/删除入口，被关掉等于把写动作藏起来。
const PLAN_COL_CHOICES: ColumnChoice[] = [
  { key: "name", label: "名称" },
  { key: "description", label: "描述" },
  { key: "tags", label: "标签" },
  { key: "status", label: "状态" },
  { key: "progress", label: "进度" },
  { key: "pass_rate", label: "通过率" },
  { key: "cases", label: "用例数" },
  { key: "stage", label: "测试阶段" },
  { key: "owner", label: "责任人" },
  { key: "planned_start", label: "计划开始" },
  { key: "planned_end", label: "计划结束" },
  { key: "actual_start", label: "实际开始" },
  { key: "actual_end", label: "实际结束" },
  { key: "archived", label: "归档" },
  { key: "created_at", label: "创建时间" },
  { key: "updated_at", label: "更新时间" },
];
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { PLAN_DISPLAY, vocabMeta } from "../shared/runVocab";
import { tpv } from "../theme";

/** D279：列表/弹窗的行类型 = 后端 PlanListRowOut（含新增六列与 owner_name）。 */
type PlanOut = PlanRow;

/**
 * 展示态徽标的查表（R112 口径）：词表外的值**渲染原文**，绝不回落成友好标签——
 * 把未知值映射成「进行中」这类认识的话，是把没见过的东西演成见过的（runVocab.ts:79-85
 * 记过这笔实际发生过的谎）。
 * 6a 的列表页**不画**展示态（PlanOut 没这个字段，见文件头①）；这是 6b 详情页/报告侧
 * 共用的读取出口，先把「未知值不许撒谎」钉在这里，而不是等 6b 再各自发明一份。
 */
export function planDisplayMeta(v: string): { label: string; color: TagProps["color"] } {
  return vocabMeta(PLAN_DISPLAY, v);
}

/** 后端/网络原话直出块（同 schedules.tsx EchoBlock：原话是证据，不许翻译）。
 *  底色引 theme Token（tpv.bg.layout）——手抄 hex 会被 theme.tokens.test.ts 棘轮当场拦下。 */
function EchoBlock({ text, testid }: { text: string; testid?: string }) {
  return (
    <pre data-testid={testid} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all",
      background: tpv.bg.layout, padding: 12, borderRadius: 6, margin: 0 }}>{text}</pre>
  );
}

// ── 新建/编辑弹窗 ─────────────────────────────────────────────────────────────
// 字段 = 后端 PlanCreateIn / plan_update_body 的全部可写位（name/description +
// D279 的 stage/planned_*/actual_*/owner_id）；归档不在这里也不许在这里：PATCH 改不了
// 归档（文件头②），弹窗里放个归档开关就是假门。

/** 原生 datetime-local ↔ ISO。本仓没有 dayjs 直接依赖（ListToolbar 同一条裁定），
 *  所以四个时刻用原生控件：value 是可控字符串，往返如实，不靠控件内部状态。 */
function isoFromLocal(local: string): string | null {
  return timeFromLocalInput(local) ?? null;
}

function PlanFormModal({ open, editing, projectId, moduleId, onClose, onSaved }: {
  open: boolean;
  editing: PlanOut | null;
  projectId: string;
  /** D211：新建时落在左树当前选中的模块里；未选模块（全部/未分组）= 建到未分组。 */
  moduleId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // D279：阶段/计划与实际起止/责任人（datetime-local 字符串，空串 = 没填）
  const [stage, setStage] = useState("");
  const [plannedStart, setPlannedStart] = useState("");
  const [plannedEnd, setPlannedEnd] = useState("");
  const [actualStart, setActualStart] = useState("");
  const [actualEnd, setActualEnd] = useState("");
  const [ownerId, setOwnerId] = useState<string | null>(null);
  // D285：标签
  const [tags, setTags] = useState<string[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [membersError, setMembersError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // 每次打开从当前行重置（新建=全空）。
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setDescription(editing?.description ?? "");
    setStage(editing?.stage ?? "");
    setPlannedStart(timeToLocalInput(editing?.planned_start));
    setPlannedEnd(timeToLocalInput(editing?.planned_end));
    setActualStart(timeToLocalInput(editing?.actual_start));
    setActualEnd(timeToLocalInput(editing?.actual_end));
    setOwnerId(editing?.owner_id ?? null);
    setTags(editing?.tags ?? []);
    setSaveErr(null);
  }, [open, editing]);

  // D279：责任人候选 = 本项目成员（与详情页指派执行人同一来源）。取不到就给空列表 +
  // 一句提示：不编人名，也不把「没取到」演成「项目里没人」。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setMembersError(false);
    get<{ items: MemberRow[] }>(
      "/projects/" + encodeURIComponent(projectId) + "/members", { silent: true })
      .then((r) => { if (alive) setMembers(r.items); })
      .catch(() => { if (alive) { setMembers([]); setMembersError(true); } });
    return () => { alive = false; };
  }, [open, projectId]);

  const memberOptions = useMemo(
    () => members.map((m) => ({
      value: m.user_id,
      label: m.name || m.account || m.user_id,
    })),
    [members],
  );

  async function submit(): Promise<void> {
    if (!name.trim()) { message.warning("计划名称必填"); return; }
    // 先后校验前端先说一句（后端仍会 422，判据不搬家）：datetime-local 的
    // "YYYY-MM-DDTHH:mm" 字符串可直接字典序比较，省一次白跑。
    if (plannedStart && plannedEnd && plannedEnd < plannedStart) {
      message.warning("计划结束不能早于计划开始"); return;
    }
    if (actualStart && actualEnd && actualEnd < actualStart) {
      message.warning("实际结束不能早于实际开始"); return;
    }
    setBusy(true);
    setSaveErr(null);
    const schedule = {
      stage: stage.trim() || null,
      planned_start: isoFromLocal(plannedStart),
      planned_end: isoFromLocal(plannedEnd),
      actual_start: isoFromLocal(actualStart),
      actual_end: isoFromLocal(actualEnd),
      owner_id: ownerId,
    };
    try {
      if (editing) {
        // 六列全部带 `*_set` 哨兵：表单呈现的是「这套计划安排的全貌」，清空也必须发得出去
        // （不带哨兵的 null 会被后端当成「这次不改」，清空就静默失败）。
        await planApi.update(editing.id, {
          project_id: projectId, name: name.trim(), description,
          ...schedule,
          stage_set: true, planned_start_set: true, planned_end_set: true,
          actual_start_set: true, actual_end_set: true, owner_set: true,
          // D285：整单提交标签（表单呈现的是全貌；[] 在这里 = 清空得出去）
          tags,
        });
      } else {
        // D211：module_id 只在新建时带（编辑路径不动模块归属——PlanUpdateIn 要 module_set
        // 哨兵才认，弹窗里没有搬模块这一栏，就不许悄悄发一个改不动的字段）。
        await planApi.create({ project_id: projectId, name: name.trim(), description,
          ...schedule, tags,
          ...(moduleId ? { module_id: moduleId } : {}) });
      }
      message.success(editing ? "已保存" : "测试计划已创建");
      onSaved(); // 重拉当前页：新行在不在这页由后端说了算，不本地插行冒充
      onClose();
    } catch (e) {
      // 409 重名 / 422 的 message 原样上屏——前端不重发明一套判据
      if (e instanceof ApiErr) setSaveErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onCancel={onClose} width={640} centered destroyOnHidden
      title={editing ? `编辑计划：${editing.name}` : "新建测试计划"}
      okText="保存" okButtonProps={{ loading: busy, "data-testid": "plan-save" }}
      cancelText="取消"
      onOk={() => void submit()}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input data-testid="plan-field-name" maxLength={200} value={name} autoFocus
            placeholder="如「结算回归 v2」" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>描述（可选）</Typography.Text>
          <Input.TextArea data-testid="plan-field-description" rows={2} value={description}
            placeholder="这套计划覆盖什么" onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>标签（可选）</Typography.Text>
          <Select mode="tags" data-testid="plan-field-tags" style={{ width: "100%" }}
            value={tags} placeholder="回车或逗号分隔；清空后保存 = 去掉全部标签"
            tokenSeparators={[",", "，"]} onChange={(v: string[]) => setTags(v)} />
        </div>
        {/* D279：阶段 + 责任人并排；四个时刻两列网格（窄屏自动折行由 Modal 宽度兜底）。 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <Typography.Text strong>测试阶段</Typography.Text>
            <Input data-testid="plan-field-stage" maxLength={32} value={stage}
              placeholder="如「系统测试」" onChange={(e) => setStage(e.target.value)} />
          </div>
          <div>
            <Typography.Text strong>责任人</Typography.Text>
            <Select<string | null> data-testid="plan-field-owner" allowClear showSearch
              optionFilterProp="label" style={{ width: "100%" }} value={ownerId}
              placeholder={membersError ? "成员列表没取到，稍后再试" : "未指派"}
              onChange={(v) => setOwnerId(v ?? null)}
              options={memberOptions} />
          </div>
          <div>
            <Typography.Text strong>计划开始</Typography.Text>
            <Input type="datetime-local" data-testid="plan-field-planned-start"
              value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} />
          </div>
          <div>
            <Typography.Text strong>计划结束</Typography.Text>
            <Input type="datetime-local" data-testid="plan-field-planned-end"
              value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} />
          </div>
          <div>
            <Typography.Text strong>实际开始</Typography.Text>
            <Input type="datetime-local" data-testid="plan-field-actual-start"
              value={actualStart} onChange={(e) => setActualStart(e.target.value)} />
          </div>
          <div>
            <Typography.Text strong>实际结束</Typography.Text>
            <Input type="datetime-local" data-testid="plan-field-actual-end"
              value={actualEnd} onChange={(e) => setActualEnd(e.target.value)} />
          </div>
        </div>
        {saveErr && (
          <Alert type="error" showIcon closable data-testid="plan-save-error" message="后端拒绝（原话回显）"
            description={<EchoBlock text={saveErr} testid="plan-save-error-text" />}
            onClose={() => setSaveErr(null)} />
        )}
      </Space>
    </Modal>
  );
}

// ── 页体 ─────────────────────────────────────────────────────────────────────

function PlansPanel() {
  const { project, user } = useAuth();
  const projectId = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const mayRead = can(perms, "testplan:plan:read");
  const canCreate = can(perms, "testplan:plan:create");
  const canUpdate = can(perms, "testplan:plan:update");
  const canDelete = can(perms, "testplan:plan:delete");
  // 归档权限位是 :manage——拿 :update 当归档门是本页最贵的一位错（后端 plan_archive 收 manage）。
  const canManage = can(perms, "testplan:plan:manage");

  // 行入口：6b 已落地 /plans/:id（app.tsx 真路由），名称恢复为链接——当初不挂链接的
  // 唯一原因是 catch-all 会把人弹回工作台，那条前提已随 6b 路由消失（⑬ 同批翻）。
  const nav = useNavigate();
  const [rows, setRows] = useState<PlanRow[]>([]);
  // D275：当前页的状态/规模摘要（plan_id → 摘要）。**不逐行拉 /status**（N+1），
  // 一次 /plan-status-batch 拿齐；失败时清空并亮提示条，绝不把「没取到」画成 0。
  const [summaries, setSummaries] = useState<Record<string, PlanStatusSummary>>({});
  const [summaryError, setSummaryError] = useState(false);
  // 页码状态只有这一份 useState（不进 URL、不进 localStorage——一页两把真相的老账）。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(50); // = 后端 PlanListIn 的 size 默认，起步不钳不漂
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ editing: PlanOut | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // D209：批量删的勾选集。只存 id（不存行对象——行对象会随刷新变成陈旧副本）。
  const [selected, setSelected] = useState<string[]>([]);
  // D211：左树过滤。all = 不过滤；unassigned = 只看未分组；module = 该模块整棵子树。
  // 一个 useState 装三种过滤态（不是三把互相能打架的开关）。
  type ModuleFilter = { kind: "all" } | { kind: "unassigned" } | { kind: "module"; id: string };
  const [filter, setFilter] = useState<ModuleFilter>({ kind: "all" });
  const [tree, setTree] = useState<PlanModuleTree | null>(null);
  // D212：高级搜索条件（§11.5.1 / D47-a 铺到计划页）。字段由后端 filter_meta 给，
  // 前端不列字段名；条件与左树模块过滤是**两个独立入口**（后端同样分开接）。
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  // D231：只看我关注（视图轴，后端 followed_by_me；不是高级搜索字段）。
  const [followedOnly, setFollowedOnly] = useState(false);
  // D285：标签精确筛选——tagText 是输入框现值，tagKw 是已提交值（回车/清空才进 load
  // 依赖）；空/全空白 = 参数不上线。
  const [tagText, setTagText] = useState("");
  const [tagKw, setTagKw] = useState("");
  const [colPref, setColPref] = useColumnPrefs("plan", PLAN_COL_CHOICES.map((c) => c.key));

  const loadTree = useCallback(async (): Promise<void> => {
    try {
      setTree(await planApi.moduleTree(projectId));
    } catch {
      // 树取不到不拦列表：左树缺席时列表仍可用（只是不能按模块过滤），不编一棵空树冒充。
      setTree(null);
    }
  }, [projectId]);
  useEffect(() => { if (mayRead) void loadTree(); }, [mayRead, loadTree]);

  /** 当前选中的模块节点（改名/删除/新建子模块的靶子；未选模块 = null）。 */
  function findModule(nodes: PlanModuleNode[], id: string): PlanModuleNode | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = findModule(n.children ?? [], id);
      if (hit) return hit;
    }
    return null;
  }
  const activeModule = filter.kind === "module" && tree
    ? findModule(tree.nodes, filter.id) : null;

  function pickFilter(next: ModuleFilter): void {
    setFilter(next);
    setCurrent(1); // 换过滤必然换结果集，停在第 3 页看新过滤的空白页是假空表
  }

  // D127 教训：load 读 current/pageSize 并把它们放进依赖，但 load 自己绝不写它们
  // （只有 pager 回调写）——取数落地不会重建 load、不会重跑 effect，点一次页恰好一条请求。
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const page = await planApi.list({
        project_id: projectId, size: pageSize, current,
        // D211：左树过滤两键与后端 PlanListIn 逐字（module_id = 整棵子树；unassigned = 未分组）
        ...(filter.kind === "module" ? { module_id: filter.id } : {}),
        ...(filter.kind === "unassigned" ? { unassigned: true } : {}),
        // 空条件不拼参数：留一条 filter= 在 URL 上是骗人的参数（api.tsx 同款口径）。
        ...(isFilterEmpty(advFilter) ? {} : { filter: JSON.stringify(advFilter) }),
        // D231：攒参也只在这个开关打开时出现（关掉 = 后端不筛，不是 followed_by_me=false）。
        ...(followedOnly ? { followed_by_me: true } : {}),
        // D285：标签精确筛选（后端 FIND_IN_SET）；空/全空白 = 不过滤。
        ...(tagKw.trim() ? { tag: tagKw.trim() } : {}),
      });
      setRows(page.items);
      // total 只从响应来，永不由 items.length 客户端现攒（页内行数不是总数）；
      // 缺键 → null → ListPager 整块不渲染。
      setTotal(page.total ?? null);
    } catch (e) {
      setRows([]);
      // 失败不留谎脚注：total 清空，不许在空表上面挂一条陈旧的「共 N 条」。
      setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "测试计划列表加载失败");
    } finally { setLoading(false); }
  }, [projectId, current, pageSize, filter, advFilter, followedOnly, tagKw]);
  useEffect(() => { if (mayRead) void load(); }, [mayRead, load]);

  // D275：状态/进度/通过率/用例数一次批量取（依赖 rows 身份：列表任何刷新都会重算，
  // 归档返回的新行也会让摘要跟着更新）。空页不发请求；失败只清摘要 + 亮提示条。
  useEffect(() => {
    if (!mayRead || rows.length === 0) { setSummaries({}); setSummaryError(false); return; }
    let alive = true;
    setSummaryError(false);
    planApi.statusBatch(projectId, rows.map((r) => r.id)).then((out) => {
      if (!alive) return;
      setSummaries(Object.fromEntries(out.items.map((it) => [it.plan_id, it])));
    }).catch(() => {
      if (!alive) return;
      setSummaries({});
      setSummaryError(true);
    });
    return () => { alive = false; };
  }, [mayRead, projectId, rows]);

  const upsert = (row: PlanOut): void => setRows((prev) => {
    const i = prev.findIndex((r) => r.id === row.id);
    if (i < 0) return prev; // 归档返回的行一定在表里；不在就不演「凭空多一行」
    const next = [...prev];
    // 归档/改名回执是 PlanOut（不回答 D231 的关注态）：保留本行已读到的 followed，
    // 不让一次归档把星标抹成「未关注」——那是后端没答过的。
    next[i] = { ...row, followed: prev[i].followed };
    return next;
  });

  function archiveOne(row: PlanOut): void {
    Modal.confirm({
      centered: true,
      title: `归档计划「${row.name}」？`,
      content: "归档是终态：归档后计划不再参与执行编排，且**没有反归档入口**（重复归档后端会 409）。",
      okText: "归档", okButtonProps: { danger: true, "data-testid": "plans-archive-ok" }, cancelText: "取消",
      onOk: async () => {
        setBusyId(row.id);
        try {
          upsert(await planApi.archive(row.id, { project_id: projectId }));
          message.success("已归档");
        } catch { /* toast 已在 client 弹 */ } finally { setBusyId(null); }
      },
    });
  }

  // D208：复制计划。非破坏性，不弹确认框（MS 列表的 copy 也是点一下就走）；
  // 复制完重新取列表——新计划按 id 序可能不在当前页，前端不许自己往 rows 里塞一行
  // 凭空位置，交给后端列表说话（upsert 只用于原地更新已有行）。
  async function copyOne(row: PlanOut): Promise<void> {
    setBusyId(row.id);
    try {
      const copied = await planApi.copy(row.id, { project_id: projectId });
      message.success(`已复制为「${copied.name}」`);
      await load();
    } catch { /* toast 已在 client 弹 */ } finally { setBusyId(null); }
  }

  function removeOne(row: PlanOut): void {
    Modal.confirm({
      centered: true,
      title: `删除计划「${row.name}」？`,
      content: "删除会级联删掉该计划的用例关联与已生成的计划报告（后端一条事务）。不可恢复。",
      okText: "删除", okButtonProps: { danger: true, "data-testid": "plans-delete-ok" }, cancelText: "取消",
      onOk: async () => {
        setBusyId(row.id);
        try {
          await planApi.remove(row.id, { project_id: projectId });
          message.success("已删除");
          setRows((prev) => prev.filter((r) => r.id !== row.id));
          setSelected((prev) => prev.filter((id) => id !== row.id));
        } catch { /* toast 已在 client 弹 */ } finally { setBusyId(null); }
      },
    });
  }

  // D209：批量删。全有或全无在后端（任一 id 不在本项目 → 404 整批不动）；
  // 前端只负责「确认一次 + 成功后清勾选 + 重取列表」——不许本地先删几行演成功。
  function batchRemove(): void {
    const ids = [...selected];
    Modal.confirm({
      centered: true,
      title: `删除选中的 ${ids.length} 个计划？`,
      content: "删除会级联删掉这些计划的用例关联、执行结论与已生成报告（后端一条事务）。不可恢复。",
      okText: "删除", okButtonProps: { danger: true, "data-testid": "plans-batch-delete-ok" }, cancelText: "取消",
      onOk: async () => {
        try {
          await planApi.batchDelete({ project_id: projectId, plan_ids: ids });
          message.success(`已删除 ${ids.length} 个计划`);
          setSelected([]);
          await load();
        } catch { /* toast 已在 client 弹 */ }
      },
    });
  }

  // D211：模块管理（新建 / 改名 / 删除）。都在左树工具栏上，权限位与计划本体同族
  // （create/update/delete），缺位不渲染。
  function addModule(): void {
    let value = "";
    Modal.confirm({
      centered: true,
      title: activeModule ? `在「${activeModule.name}」下新建子模块` : "新建根模块",
      content: <Input data-testid="plan-module-name-input" placeholder="模块名称" maxLength={200}
        onChange={(e) => { value = e.target.value; }} />,
      okText: "创建", okButtonProps: { "data-testid": "plan-module-name-ok" }, cancelText: "取消",
      onOk: async () => {
        if (!value.trim()) { message.warning("模块名称必填"); throw new Error("empty"); }
        await planApi.createModule({ project_id: projectId,
          parent_id: activeModule ? activeModule.id : null, name: value.trim() });
        message.success("模块已创建");
        await loadTree();
      },
    });
  }

  function renameModule(m: PlanModuleNode): void {
    let value = m.name;
    Modal.confirm({
      centered: true,
      title: `重命名模块「${m.name}」`,
      content: <Input data-testid="plan-module-rename-input" defaultValue={m.name} maxLength={200}
        onChange={(e) => { value = e.target.value; }} />,
      okText: "保存", okButtonProps: { "data-testid": "plan-module-rename-ok" }, cancelText: "取消",
      onOk: async () => {
        if (!value.trim()) { message.warning("模块名称必填"); throw new Error("empty"); }
        await planApi.updateModule(m.id, { project_id: projectId, name: value.trim() });
        message.success("模块已改名");
        await loadTree();
      },
    });
  }

  function removeModule(m: PlanModuleNode): void {
    Modal.confirm({
      centered: true,
      title: `删除模块「${m.name}」？`,
      content: "模块下还有子模块或计划时后端会拒绝（409）——本操作不会连计划一起删。",
      okText: "删除", okButtonProps: { danger: true, "data-testid": "plan-module-delete-ok" },
      cancelText: "取消",
      onOk: async () => {
        await planApi.deleteModule(m.id, { project_id: projectId });
        message.success("模块已删除");
        if (filter.kind === "module" && filter.id === m.id) pickFilter({ kind: "all" });
        await loadTree();
      },
    });
  }

  // D231：关注/取关。回执带操作后的真实状态（幂等），本页只把行上的 followed 改成
  // 后端答的那一位；在「我关注的」视图里取关 = 该行不再属于结果集，重取列表（不本地
  // 删行冒充过滤——分页总数得由后端重算）。
  async function toggleFollow(row: PlanRow): Promise<void> {
    setBusyId(row.id);
    try {
      const out = row.followed
        ? await planApi.unfollow(row.id, { project_id: projectId })
        : await planApi.follow(row.id, { project_id: projectId });
      if (followedOnly && !out.following) {
        await load();
      } else {
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, followed: out.following } : r)));
      }
      message.success(out.following ? "已关注" : "已取消关注");
    } catch { /* toast 已在 client 弹 */ } finally { setBusyId(null); }
  }

  const toTreeData = (nodes: PlanModuleNode[]): DataNode[] => nodes.map((n) => ({
    key: n.id,
    title: (
      <span data-testid={"plan-module-node-" + n.id}>
        {n.name} <Typography.Text type="secondary" className="tp-text-sm">({n.plan_count})</Typography.Text>
      </span>
    ),
    children: toTreeData(n.children ?? []),
  }));

  // 高级搜索的候选值：模块树本来就在手里，直接摊平成 id 选项（不去拉第二遍）；
  // created_by/updated_by 没有等价词表可复用 → 不给候选，按原值精确匹配（面板底部已写明）。
  const filterValueOptions = useMemo<Record<string, Option[]>>(() => {
    const modules: Option[] = [];
    const walk = (nodes: PlanModuleNode[]): void => nodes.forEach((n) => {
      modules.push({ label: n.name, value: n.id });
      walk(n.children ?? []);
    });
    walk(tree?.nodes ?? []);
    return { module_id: modules };
  }, [tree]);

  const columns: ColumnsType<PlanRow> = [
    // 名称必须给显式宽：10 列固定宽之和（1670）已超过 1440 视口的可用宽，
    // 无宽列会被 table-layout:fixed 压成 0（2026-11-24 真机：表头只剩「描述」，名称整列消失）。
    // 表在卡内横向滚动（.tp-fill-body .ant-table-content 的 overflow:auto），不用 fixed/scroll.x——
    // 那会插入一条隐藏的 measure-row（rc-table Table.js:501），把 tbody 的勾选框数从 2 变成 3。
    { title: "名称", dataIndex: "name", key: "name", width: 220,
      render: (v: string, r) => (
        // 6b 已把 /plans/:id 接成真路由（app.tsx），点名字真去详情页——⑬ 当初钉住「暂不
        // 可点」的前提（catch-all 静默弹回工作台）随路由落地消失，入口与测试同批翻。
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <a data-testid={"plans-row-" + r.id} onClick={() => nav("/plans/" + r.id)}>{v}</a>
          {/* D231：关注星。关注是写副作用（后端 testplan:plan:update），缺位不渲染；
              followed 来自列表行的现查结果（plan_list 批量 IN 查询），不在前端存第二份。 */}
          {canUpdate && (
            <Button type="text" size="small" disabled={busyId === r.id}
              data-testid={"plans-follow-" + r.id} data-followed={String(!!r.followed)}
              aria-label={r.followed ? "取消关注" : "关注"} title={r.followed ? "取消关注" : "关注"}
              onClick={(e) => { e.stopPropagation(); void toggleFollow(r); }}
              icon={<StarOutlined
                fill={r.followed ? "currentColor" : "none"}
                style={{ color: r.followed ? tpv.func.warning : tpv.text[3] }} />} />
          )}
        </span>
      ) },
    { title: "描述", dataIndex: "description", key: "description", ellipsis: true, width: 220,
      render: (v: string | null) => v ?? "—" },
    // D285：标签列最多画两枚 + 「+N」（Tooltip 给全量）；空画「—」，不画空 Tag。
    { title: "标签", key: "tags", width: 150,
      render: (_: unknown, r) => {
        const ts = r.tags ?? [];
        if (!ts.length) return <Typography.Text type="secondary" data-testid={"plans-tags-" + r.id}>—</Typography.Text>;
        return (
          <Space size={4} data-testid={"plans-tags-" + r.id} wrap={false}>
            {ts.slice(0, 2).map((t) => <Tag key={t}>{t}</Tag>)}
            {ts.length > 2 && (
              <Tooltip title={ts.slice(2).join("、")}><Tag>+{ts.length - 2}</Tag></Tooltip>
            )}
          </Space>
        );
      } },
    // D275：以下四列全部来自**一次批量现算**（/plan-status-batch），判据与详情页
    // /plans/{id}/status 同源。取不到时画「—」+ 顶部提示条，不画 0（0 是真实结论，
    // 「没取到」不是）——空计划的两个率同理画「—」而不是 0%（0/0 没有可信的百分比）。
    { title: "状态", key: "status", width: 96,
      render: (_: unknown, r) => {
        const s = summaries[r.id];
        if (!s) return <Tooltip title={summaryError ? "状态取数失败（见上方提示条）" : "状态加载中"}>
          <Typography.Text type="secondary" data-testid={"plans-status-" + r.id}>—</Typography.Text></Tooltip>;
        const m = planDisplayMeta(s.status);
        return <Tag color={m.color} data-testid={"plans-status-" + r.id}>{m.label}</Tag>;
      } },
    { title: "进度", key: "progress", width: 132,
      render: (_: unknown, r) => {
        const s = summaries[r.id];
        if (!s) return <Typography.Text type="secondary" data-testid={"plans-progress-" + r.id}>—</Typography.Text>;
        if (s.total === 0) return <Tooltip title="空计划：没有可执行的关联用例">
          <Typography.Text type="secondary" data-testid={"plans-progress-" + r.id}>—</Typography.Text></Tooltip>;
        return (
          <Tooltip title={`已执行 ${s.executed} / ${s.total}（执行中 ${s.executing}）`}>
            <Progress percent={Math.round(s.execute_rate * 100)} size="small"
              data-testid={"plans-progress-" + r.id} />
          </Tooltip>
        );
      } },
    { title: "通过率", key: "pass_rate", width: 118,
      render: (_: unknown, r) => {
        const s = summaries[r.id];
        if (!s) return <Typography.Text type="secondary" data-testid={"plans-passrate-" + r.id}>—</Typography.Text>;
        if (s.total === 0) return <Tooltip title="空计划：0/0 没有可信的通过率">
          <Typography.Text type="secondary" data-testid={"plans-passrate-" + r.id}>—</Typography.Text></Tooltip>;
        return (
          <span data-testid={"plans-passrate-" + r.id}>
            {Math.round(s.pass_rate * 100)}%
            <Typography.Text type="secondary" className="tp-text-sm">
              （{s.passed}/{s.total}）
            </Typography.Text>
          </span>
        );
      } },
    { title: "用例数", key: "cases", width: 220,
      render: (_: unknown, r) => {
        const s = summaries[r.id];
        if (!s) return <Typography.Text type="secondary" data-testid={"plans-cases-" + r.id}>—</Typography.Text>;
        const parts: string[] = [];
        if (s.counts.functional_case) parts.push("功能 " + s.counts.functional_case);
        if (s.counts.api_case) parts.push("接口 " + s.counts.api_case);
        if (s.counts.scenario) parts.push("场景 " + s.counts.scenario);
        if (s.counts.ui_case) parts.push("UI " + s.counts.ui_case);
        if (s.counts.adb_case) parts.push("ADB " + s.counts.adb_case);
        return (
          <div data-testid={"plans-cases-" + r.id}>
            <span>{s.total}</span>
            <div><Typography.Text type="secondary" className="tp-text-sm">
              {parts.length ? parts.join(" · ") : "无关联用例"}
            </Typography.Text></div>
          </div>
        );
      } },
    // D279：阶段/责任人/四个时刻。六列都是 plan_record 的真实列（列表行自带，不需要
    // 额外请求）；没填就画「—」，不拿更新时间冒充实际时间，也不把「未指派」画成某个人。
    { title: "测试阶段", dataIndex: "stage", key: "stage", width: 110,
      render: (v: string | null) => (v
        ? <Tag data-testid="plans-stage">{v}</Tag>
        : <Typography.Text type="secondary" data-testid="plans-stage">—</Typography.Text>) },
    { title: "责任人", dataIndex: "owner_name", key: "owner", width: 120, ellipsis: true,
      render: (v: string | null) => (v
        ? <span data-testid="plans-owner">{v}</span>
        : <Typography.Text type="secondary" data-testid="plans-owner">—</Typography.Text>) },
    { title: "计划开始", dataIndex: "planned_start", key: "planned_start", width: 150,
      render: (v: string | null) => (
        <Typography.Text className="tp-text-sm" data-testid="plans-planned-start">
          {fmtTime(v) ?? "—"}
        </Typography.Text>) },
    { title: "计划结束", dataIndex: "planned_end", key: "planned_end", width: 150,
      render: (v: string | null) => (
        <Typography.Text className="tp-text-sm" data-testid="plans-planned-end">
          {fmtTime(v) ?? "—"}
        </Typography.Text>) },
    { title: "实际开始", dataIndex: "actual_start", key: "actual_start", width: 150,
      render: (v: string | null) => (
        <Typography.Text className="tp-text-sm" data-testid="plans-actual-start">
          {fmtTime(v) ?? "—"}
        </Typography.Text>) },
    { title: "实际结束", dataIndex: "actual_end", key: "actual_end", width: 150,
      render: (v: string | null) => (
        <Typography.Text className="tp-text-sm" data-testid="plans-actual-end">
          {fmtTime(v) ?? "—"}
        </Typography.Text>) },
    // 归档是 PlanOut 真实布尔列——这一列只回答后端答过的问题（展示态不在列表里，文件头①）。
    { title: "归档", dataIndex: "archived", key: "archived", width: 88,
      render: (v: boolean) => (v
        ? <Tag color="orange" data-testid="plans-archived-tag">已归档</Tag>
        : <Typography.Text type="secondary" data-testid="plans-archived-tag">未归档</Typography.Text>) },
    { title: "创建时间", dataIndex: "created_at", key: "created_at", width: 168,
      render: (v: string | null) => (
        <Typography.Text className="tp-text-sm" data-testid="plans-created">{fmtTime(v) ?? "—"}</Typography.Text>) },
    { title: "更新时间", dataIndex: "updated_at", key: "updated_at", width: 168,
      render: (v: string | null) => (
        <Typography.Text className="tp-text-sm" data-testid="plans-updated">{fmtTime(v) ?? "—"}</Typography.Text>) },
    { title: "操作", key: "ops", width: 240,
      render: (_: unknown, row: PlanRow) => (
        <Space size={4}>
          {canUpdate && (
            <Button size="small" data-testid={"plans-edit-" + row.id} disabled={busyId === row.id}
              onClick={() => setModal({ editing: row })}>编辑</Button>
          )}
          {/* 复制与新建同一位（后端 plan_copy 收 testplan:plan:create，MS 的 copy 亦然）；
              已归档行也能复制——复制件是可用的新计划，正是「把归档计划捡回来」的路。 */}
          {canCreate && (
            <Button size="small" data-testid={"plans-copy-" + row.id} disabled={busyId === row.id}
              onClick={() => void copyOne(row)}>复制</Button>
          )}
          {/* 归档钮只对未归档行渲染：归档是终态（后端 409 拒重复归档），对已归档行
              摆把手就是引人点一个必失败的假门。 */}
          {canManage && !row.archived && (
            <Button size="small" data-testid={"plans-archive-" + row.id} disabled={busyId === row.id}
              onClick={() => archiveOne(row)}>归档</Button>
          )}
          {canDelete && (
            <Button size="small" danger data-testid={"plans-remove-" + row.id} disabled={busyId === row.id}
              onClick={() => removeOne(row)}>删除</Button>
          )}
        </Space>
      ) },
  ];

  // 无读权限：表格压根不渲染（也不发列表请求）——只给一句人话，不演假空表。
  if (!mayRead) {
    return (
      <Alert type="warning" showIcon data-testid="plans-no-read"
        message="当前项目没有 testplan:plan:read 权限"
        description="测试计划列表需要读权限，权限位在后端把守。" />
    );
  }

  return (
    // flexDirection 必须显式写 row：.tp-fill 自带 flex-direction:column，
    // 只写 display:flex 会被它按列排（2026-11-24 真机截图：左树整块压在工具栏上方，
    // 右栏折到下一行，整页错位）。
    <div className="tp-fill tp-fill-body"
      style={{ display: "flex", flexDirection: "row", gap: 12, alignItems: "stretch" }}>
      {/* D211 左树：模块导航 + 过滤 + 模块管理。树本身只有模块节点；「全部计划 / 未分组」
          是树外的两条入口（未分组不是模块，见后端 PlanModuleTreeOut docstring）。 */}
      <div data-testid="plans-module-tree"
        style={{ flex: "0 0 232px", width: 232, display: "flex", flexDirection: "column", gap: 8 }}>
        <Space size={4} wrap>
          {canCreate && (
            <Button size="small" icon={<PlusOutlined />} data-testid="plan-module-new"
              onClick={addModule}>新建模块</Button>
          )}
          {canUpdate && activeModule && (
            <Button size="small" data-testid="plan-module-rename"
              onClick={() => renameModule(activeModule)}>改名</Button>
          )}
          {canDelete && activeModule && (
            <Button size="small" danger data-testid="plan-module-delete"
              onClick={() => removeModule(activeModule)}>删除模块</Button>
          )}
        </Space>
        <Button size="small" block data-testid="plan-module-all"
          type={filter.kind === "all" ? "primary" : "default"}
          onClick={() => pickFilter({ kind: "all" })}>全部计划</Button>
        <Button size="small" block data-testid="plan-module-unassigned"
          type={filter.kind === "unassigned" ? "primary" : "default"}
          onClick={() => pickFilter({ kind: "unassigned" })}>
          未分组{tree ? "（" + tree.unassigned_count + "）" : ""}
        </Button>
        <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto" }}>
          <Tree
            blockNode
            selectedKeys={filter.kind === "module" ? [filter.id] : []}
            onSelect={(keys) => {
              const k = keys[0];
              if (typeof k === "string" && k) pickFilter({ kind: "module", id: k });
              else pickFilter({ kind: "all" }); // 再点一次已选节点 = 取消过滤，回全部
            }}
            treeData={toTreeData(tree?.nodes ?? [])}
          />
        </div>
      </div>
      <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: "0 0 auto" }}>
      {/* D212：D47-a 三件套（视图选择器 / 高级搜索 / 列设置）铺到计划列表。条件与左树
          模块过滤并行生效（后端两个入口分开收）。 */}
      <ListToolbar
        projectId={projectId} viewType="plan"
        filter={advFilter} onFilterChange={(f) => { setAdvFilter(f); setCurrent(1); }}
        valueOptions={filterValueOptions}
        allColumns={PLAN_COL_CHOICES}
        columnPref={colPref} onColumnPrefChange={setColPref}
        canSaveView={mayRead} canDeleteView={mayRead}
        extra={(
          <Space wrap>
            {/* D285：标签精确筛选（与高级搜索的条件组是两个入口，彼此并行 AND） */}
            <Input.Search data-testid="plans-tags-filter" allowClear style={{ width: 170 }}
              placeholder="标签（精确）" value={tagText}
              onChange={(e) => setTagText(e.target.value)}
              onSearch={(v) => { setTagKw(v.trim()); setCurrent(1); }} />
            {/* 刷新 = 重发当前页（load 读 current），不回第 1 页：把用户从第 3 页弹回
                第 1 页不是「刷新」这个词的意思。 */}
            <Button icon={<ReloadOutlined />} data-testid="plans-reload" onClick={() => void load()}>刷新</Button>
            {/* D231：视图轴开关（读权限即可用，不需要写位——看「我关注的」是读行为）。 */}
            <Button data-testid="plans-followed-only"
              type={followedOnly ? "primary" : "default"}
              icon={<StarOutlined />}
              onClick={() => { setFollowedOnly((v) => !v); setCurrent(1); }}>
              我关注的
            </Button>
            {canCreate && (
              <Button type="primary" icon={<PlusOutlined />} data-testid="plans-create"
                onClick={() => setModal({ editing: null })}>新建计划</Button>
            )}
            {canDelete && selected.length > 0 && (
              <Button danger data-testid="plans-batch-delete" onClick={batchRemove}>
                批量删除（{selected.length}）
              </Button>
            )}
          </Space>
        )} />
      {loadError && (
        // 不 closable：失败后这张表是空的（catch 里 setRows([])），这条 Alert 是「这一屏
        // 没取到」的唯一证据——给 × 等于发消证按钮，关掉后空表读起来和「没有计划」一模一样。
        <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="plans-load-error"
          message="测试计划列表加载失败" description={<EchoBlock text={loadError} />} />
      )}
      {summaryError && !loadError && (
        // 列表本身在，只是这一批现算值没取到：单独说清缺的是哪几列，不把整页判成失败。
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} data-testid="plans-summary-error"
          message="状态/进度/通过率/用例数取数失败"
          description="列表行仍然可用，但这四列现算值没取到（已画「—」而不是 0）。点「刷新」重试。" />
      )}
      </div>
      <div data-testid="plans-table" className="tp-fill-body">
        <AdminTable<PlanRow> rowKey="id" loading={loading} dataSource={rows}
          columns={applyColumnPrefs(columns, colPref)}
          pagination={false}
          // D209：勾选列只在有删权限时出现（READONLY/MEMBER 看不到一个用不了的勾选框）。
          rowSelection={canDelete ? {
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys as string[]),
          } : undefined}
          locale={{ emptyText: loadError
            ? "没取到计划——原因见上方错误条，点「刷新」重试"
            : canCreate ? "还没有计划，点右上角新建" : "还没有计划（你没有新建权限）" }}
          cardFooter={(
            // 脚注与页码住进卡底（业主点名：卡有边有角，小字却散在卡外的页面底色上）。
            // grid 三列与内边距归 .tp-cardfoot / .ant-table-footer（styles.css）。
            <div className="tp-cardfoot">
              <Typography.Text className="tp-cardfoot-note tp-text-sm" type="secondary">
              「归档」是终态列（无反归档）；状态/进度/通过率/用例数为当前页一次批量现算
              （与详情页同源，空计划的 0/0 画「—」而非 0%）。
              </Typography.Text>
              <ListPager
                current={current}
                pageSize={pageSize}
                total={total}
                onPage={setCurrent}
                onPageSize={setPageSize}
              />
            </div>
          )} />
      </div>
      </div>

      <PlanFormModal open={modal !== null} editing={modal?.editing ?? null} projectId={projectId}
        moduleId={filter.kind === "module" ? filter.id : null}
        onClose={() => setModal(null)} onSaved={() => void load()} />
    </div>
  );
}

export default function PlansPage() {
  return (
    <div data-testid="page-plans" className="tp-fill-stack">
      <PageHead title="测试计划" descHover
        desc="把用例按计划组织、定时执行并汇总成绩；计划状态由执行结果现算。" />
      <ProjectGate><PlansPanel /></ProjectGate>
    </div>
  );
}
