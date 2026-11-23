// 测试计划列表（D183 步 6a，§11.1 任务中心「测试计划」；后端 app/modules/testplan/ 为准）。
//
// 本页四条命门口径（写错就是假门/谎数，逐条对后端）：
// ① 列表行 = PlanOut 九字段，**没有展示态字段**——库里没有 status 列，_plan_display 现算
//    只从 GET /plans/{id}/status 出口给。列表页只画 archived（真实布尔列）；逐行拉 /status
//    是 N+1 请求 + 给列表编一个它没给过的数，两头都不许。「计划跑到哪了」归 6b 详情页。
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
  Alert, Button, Input, Modal, Space, Tag, Tree, Typography, message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { DataNode } from "antd/es/tree";
import type { TagProps } from "antd";
import { PlusOutlined, ReloadOutlined, StarOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr } from "../api/client";
import { planApi } from "../api/plan";
import type { PlanModuleNode, PlanModuleTree, PlanRow } from "../api/plan";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import { applyColumnPrefs, emptyFilter, isFilterEmpty } from "../shared/listFilters";
import type { ColumnChoice, FilterDoc } from "../shared/listFilters";

// D212：列设置面板要露的列（key 与下方 columns 的 key 逐字对上，对不上就是
// 「面板能勾、表头不动」的假把手——plans.test.tsx 的勾掉列用例钉这一环）。
// 操作列不列：它带着编辑/复制/归档/删除入口，被关掉等于把写动作藏起来。
const PLAN_COL_CHOICES: ColumnChoice[] = [
  { key: "name", label: "名称" },
  { key: "description", label: "描述" },
  { key: "archived", label: "归档" },
  { key: "created_at", label: "创建时间" },
  { key: "updated_at", label: "更新时间" },
];
import type { components } from "../api/schema";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { PLAN_DISPLAY, vocabMeta } from "../shared/runVocab";
import { tpv } from "../theme";

type PlanOut = components["schemas"]["PlanOut"];

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
// 字段 = 后端 PlanCreateIn / plan_update_body 的全部可写位（name/description）；
// 归档不在这里也不许在这里：PATCH 改不了归档（文件头②），弹窗里放个归档开关就是假门。

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
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // 每次打开从当前行重置（新建=全空）。
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setDescription(editing?.description ?? "");
    setSaveErr(null);
  }, [open, editing]);

  async function submit(): Promise<void> {
    if (!name.trim()) { message.warning("计划名称必填"); return; }
    setBusy(true);
    setSaveErr(null);
    try {
      if (editing) {
        await planApi.update(editing.id, { project_id: projectId, name: name.trim(), description });
      } else {
        // D211：module_id 只在新建时带（编辑路径不动模块归属——PlanUpdateIn 要 module_set
        // 哨兵才认，弹窗里没有搬模块这一栏，就不许悄悄发一个改不动的字段）。
        await planApi.create({ project_id: projectId, name: name.trim(), description,
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
    <Modal open={open} onCancel={onClose} width={560} centered destroyOnHidden
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
          <Input.TextArea data-testid="plan-field-description" rows={3} value={description}
            placeholder="这套计划覆盖什么" onChange={(e) => setDescription(e.target.value)} />
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
  }, [projectId, current, pageSize, filter, advFilter, followedOnly]);
  useEffect(() => { if (mayRead) void load(); }, [mayRead, load]);

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
    { title: "名称", dataIndex: "name", key: "name",
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
    { title: "描述", dataIndex: "description", key: "description", ellipsis: true, width: 260,
      render: (v: string | null) => v ?? "—" },
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
    { title: "操作", key: "ops", width: 260,
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
    <div className="tp-fill tp-fill-body" style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
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
              「归档」是终态列（无反归档）；列表不展示通过率/执行状态——那是详情页每次现算的结论
              （空计划「全部通过」是空真，列表端点压根没给这个数，这里就不编）。
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
