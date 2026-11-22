// 场景列表页（§11.4.8 / §11.5.6，T17）：左 scenario_module 树 + 右列表 + 批量条。
// 契约（nav.spec.mjs 钉死，替换本文件时必须保留）：
//   ① 根节点 data-testid="page-scene"；② PageHead 标题「场景编排」。
// D47-b 步5b（照接口页 8670d4c 同法）：页码分页、关键词、模块筛选全部下推到后端
// （current/size 页码、keyword 只打 name、module_ids 重复键），本页不再「拉一页 200 条
// 再本地过滤」。注意：模块筛选与接口页**刻意不同**：本页仍发 ownModuleIds（只有选中节点自身，
// 直属口径），接口页是 subtreeIds（子树）——场景树徽标还是直属数，换成子树就是「徽标写 3、
// 列表出 7」那个 R120 明令避免的谎；子树化要后端徽标同刀改、业主先裁（shared/moduleTree.ts
// ownModuleIds 的注释记着这笔账）。
// 诚实原则：「打开画布」走 T19 画布路由（#/scene/:id）；批量「执行」自 D70 起是真入口
// （批量条 → 环境选择弹窗 → 逐个 sceneApi.run；scenario_run 早已注册，此前只是按钮被锁着
// 并写着「后端尚未注册该 @service」——那是一句过期成谎的注释）。1E（定时任务）已交付，但「定时」列仍是「-」：后端 ScenarioOut
// 不带任何定时字段，真数据只在 GET /schedule-tasks 的项目级分页列表里（cursor 翻页、
// 单页封顶 200）——单次请求反查不完就不是每行的真相，宁画「-」不画可能漏的勾选；
// 单列真相要后端加字段，为一个展示列加契约字段不值当（场景编辑器右栏「定时绑定」
// 已按单场景反查真列表）。1F T6 起「让 Pilot 生成」
// 是真入口（跳 /bench 并预选当前项目），不再是说明占位——诚实原则不变：不做点了没动静的假按钮。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Card, Col, Dropdown, Empty, Input, Modal, Row, Select, Space, Table, Tag,
  Tooltip, Typography, message,
} from "antd";
import { DeleteOutlined, DownOutlined, ExportOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, UndoOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import { get, ApiErr } from "../api/client";
import { tpv } from "../theme";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import ModuleTree from "../api/ModuleTree";
import type { ModNode } from "../api/ModuleTree";
import { downloadBlob } from "../api/ImportWizard";
import { flatten, ownModuleIds } from "../shared/moduleTree";
import { sceneApi, type ScenarioListQuery, type ScenarioListRow } from "../api/scene";
import { ownerLabel, MEMBERS_FAILED, MEMBERS_LOADING, membersReady, type MemberLookup } from "../shared/ownerName";
import { STATUSES } from "../shared/runVocab";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import type { components } from "../api/schema";
import type { CaseRow, EnvRow, MemberRow, Page } from "../api/api";

type Row = ScenarioListRow;

const PRIO_COLOR: Record<string, string> = { P0: "red", P1: "volcano", P2: "blue", P3: "default" };
// 这一列的取值域只有四态 + NULL：last_run_status 全站唯一的回写门是终态门
// （orchestration.py:268 `status in TERMINAL` 且 trigger != "debug"、engine/runner.py:697 同款），
// running/queued 到不了这一列。词表也吃 shared/runVocab.STATUSES（uiCases.tsx / schedules.tsx 同源）：
// 「断言失败/请求失败」是 runs/reports 那两页对 failed/error 的既定叫法，本页此前自写
// 「失败/异常」是同一个值两个名字，无注释交代（D178）。
const RUN_DOT: Record<string, { color: string; label: string }> = {
  passed: { color: tpv.func.success, label: STATUSES.passed.label },
  failed: { color: tpv.func.error, label: STATUSES.failed.label },
  error: { color: tpv.func.error, label: STATUSES.error.label },
  cancelled: { color: tpv.func.skip, label: STATUSES.cancelled.label },
};

// flatten / ownModuleIds 已抽到 shared/moduleTree.ts（R99：api.tsx 与 scenes.tsx 曾逐字重复两份）。

function RunDot({ status }: { status: string | null | undefined }) {
  if (!status) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>未运行</Typography.Text>;
  const d = RUN_DOT[status] ?? { color: tpv.func.skip, label: status };
  return (
    <Space size={6}>
      <span data-testid="scene-run-dot" style={{
        display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: d.color,
      }} />
      {d.label}
    </Space>
  );
}

/** 生成物里 ScenarioModuleNode 的可选字段比 ModNode 宽（?: string|null），归一一下。 */
function toMod(n: components["schemas"]["ScenarioModuleNode"]): ModNode {
  return {
    id: n.id, parent_id: n.parent_id ?? null, name: n.name, sort: n.sort,
    status: n.status, count: n.count, children: n.children.map(toMod),
  };
}

function ScenesWorkbench() {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canRead = can(perms, "scenario:read");
  const canCreate = can(perms, "scenario:create");
  const canUpdate = can(perms, "scenario:update");
  const canDelete = can(perms, "scenario:delete");
  const canRun = can(perms, "scenario:run");
  const canModCreate = can(perms, "scenario:module:create");
  const canModDelete = can(perms, "scenario:module:delete");

  const [rows, setRows] = useState<Row[]>([]);
  const [tree, setTree] = useState<ModNode[]>([]);
  const [recycledTree, setRecycledTree] = useState<ModNode[]>([]);
  const [inRecycled, setInRecycled] = useState(false);
  // D180：回收站模板（删除人/删除时间两列、回收空态、脚注后缀）读 shownRecycled——点击只
  // 翻 inRecycled（请求参数/新建闸），模板要等取数成功那一刻跟行一起翻；失败不翻。
  // 在途/失败窗口里屏上留的还是正常行，按点击位挂回收模板就是给活行说谎（同 adbDevices.tsx:449-453）。
  const [shownRecycled, setShownRecycled] = useState(false);
  const [moduleId, setModuleId] = useState<string | null>(null);
  // D47-b 步5b：输入框现值（qText）与**已提交**关键词（kw）分两个 state——打字只动 qText，
  // 进 load 依赖的是 kw。合并成一个的话「查询订单」打六个字发六条 GET；提交口只有
  // Enter/放大镜/allowClear 三处（api.tsx 步4b 同法，antd 5.29 的 Input.Search 把三条路径
  // 都汇进 onSearch——allowClear 的清空也带 source:'clear' 触发它）。
  const [qText, setQText] = useState("");
  const [kw, setKw] = useState("");
  // D47-b 步5b：页码分页（current/pageSize/total）替换「拉 200 条本地过滤」。默认档位 20
  // 在 ListPager 档位表（20/50/100）里、后端 size 上限（le=200）内。current 只有 pager 回调
  // 与 patchFilters 写，load 永不写它（runs.tsx 同法，一页只许有一个「我在第几页」的真相）。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  // 三类筛选（模块/已提交关键词/回收站开关）只有 patchFilters 这一个写入口，「回第 1 页」
  // 钉在唯一入口处——停在第 7 页改筛选，落的是新条件下无关的切片甚至空页
  // （runs.tsx:84 / listPagination.tsx 注释③同款 hazard）；各 setState 漏接一个 reset 没人拦得住。
  const patchFilters = useCallback((p: {
    moduleId?: string | null; kw?: string; inRecycled?: boolean;
  }): void => {
    if ("moduleId" in p) setModuleId(p.moduleId!);
    if ("kw" in p) setKw(p.kw!);
    if ("inRecycled" in p) setInRecycled(p.inRecycled!);
    setCurrent(1);
  }, []);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  // 三态：加载中/拉挂了下不了结论，别把真成员判成「非项目成员」（shared/ownerName.ts）
  const [members, setMembers] = useState<MemberLookup>(MEMBERS_LOADING);
  // 取数失败与「项目里真的没有场景」是两句话：把失败画成实测零，是把故障演成空数据
  // （adbCases / uiCases / uiElements 已按同口径修过，本页是同一病灶的第四个站点；
  // 原来这句 catch 的注释写着「toast 已在 client 里弹」，而 sceneApi.list 是 silent:true——
  // 故障连 toast 都没有，只剩一句「还没有场景」把挂掉的请求演成实测零条）。
  const [loadError, setLoadError] = useState<string | null>(null);

  // 模块 id 集合必须从**已到手**的树算（ownModuleIds 是纯内存游走）。load 自己也写 tree，
  // 把 tree 放进 load 依赖就是 D127 记过的回路（响应→新 tree→load 换身份→effect 重跑）；
  // 树与列表在同一次点击里必然先后落地（首帧取回树才可能点到节点），用 ref 镜像即可（api.tsx 步4b 同法）。
  const treeRef = useRef<{ tree: ModNode[]; recycled: ModNode[] }>({ tree: [], recycled: [] });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 页码模式（D47-b 步5b）：current 一上线就是「这页要第几页」的唯一口径，
      // 请求永不带 cursor——current+cursor 同传后端直接 400，一页两把尺子正是被禁的那件事。
      const q: ScenarioListQuery = { project_id: pid, size: pageSize, current };
      if (inRecycled) q.recycled = true;
      if (kw.trim()) q.keyword = kw.trim(); // 空/纯空白 = 不过滤，参数整个不上线
      if (moduleId) {
        // **直属口径**（ownModuleIds = 只有选中节点自身），不是接口页那个 subtreeIds：
        // 场景树徽标还是直属数，发子树就是「徽标写 3、列表出 7」的 R120 谎；子树化要
        // 连后端徽标一起改、业主先裁（shared/moduleTree.ts ownModuleIds 注释记着这笔账）。
        // 树里查不到该节点时不发 module_ids——与本地过滤时代的「找不到当不过滤」同款语义。
        const sub = ownModuleIds(inRecycled ? treeRef.current.recycled : treeRef.current.tree, moduleId);
        if (sub) q.module_ids = [...sub]; // 重复 query 键由 sceneApi.list 拼（list[str] 的收法）
      }
      const [t, l] = await Promise.all([
        sceneApi.moduleTree(pid, true),
        sceneApi.list(q),
      ]);
      const tm = t.tree.map(toMod); const rm = t.recycled.map(toMod);
      setTree(tm); setRecycledTree(rm);
      treeRef.current = { tree: tm, recycled: rm };
      // 页码模式是替换语义：第 3 页的行就只画第 3 页的，别页的行必须下桌。
      setRows(l.items);
      // total 只从响应来，永不由 items.length 客户端现攒（页内行数不是总数）。
      // 缺键（后端尚未上页码模式的游标式响应）→ null → ListPager 整块不渲染。
      setTotal(l.total ?? null);
      // D180：模板只在这一行（成功路径）追平点击——行与模板同一批提交；失败路径不碰它，
      // 留在屏上的旧行继续按正常模板说话。
      setShownRecycled(inRecycled);
      // 换页/换筛选都清空勾选：批量条只对**当前页的行**成立（runBlocked 的 rows.find
      // 前校验就建立在这条不变量上——sel ⊆ 当前页 rows，不许有查无此行的勾）。
      setSel([]);
    } catch (e) {
      // D47-b 步5b：页码模式下失败**清行清 total**（旧「失败不清行」的世界随本地过滤一起
      // 退役了）：陈旧行 + 新 current 同屏就是「我在第几页」的两把尺子，与后端禁
      // cursor+current 同罪（理由原文在 api.tsx 的 catch 注释）。故障仍摊开说（loadError
      // Alert + 空态改口），只是不再拿上一批行冒充当前页。旧口径「失败保留旧行」由
      // 既有测试钉着——那条已按新口径改写并注明理由，不是静默删测试变绿。
      setRows([]);
      setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "场景列表加载失败");
    } finally { setLoading(false); }
  }, [pid, inRecycled, kw, moduleId, current, pageSize]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setMembers(MEMBERS_LOADING);
    void (async () => {
      try {
        const m = await get<Page<MemberRow>>("/projects/" + encodeURIComponent(pid) + "/members", { silent: true });
        const map: Record<string, string> = {};
        for (const x of m.items) map[x.user_id] = x.name ?? x.account ?? x.user_id;
        setMembers(membersReady(map));
      } catch { setMembers(MEMBERS_FAILED); } // 如实标失败，不静默把 uuid 当名字摊出去
    })();
  }, [pid]);

  // D47-b 步5b：旧「模块 + 关键词都在本地过滤」的 visible useMemo 已整块删除——
  // keyword= 与 module_ids 都下推到后端（keyword 大小写不敏感是后端契约，浏览器不再
  // toLowerCase），表里画的就是服务端筛后的当前页。

  const moduleName = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (ns: ModNode[]) => ns.forEach((n) => { map.set(n.id, n.name); walk(n.children); });
    walk(tree); walk(recycledTree);
    return map;
  }, [tree, recycledTree]);

  // —— 新建：空白 / 从用例生成 / Pilot（1F 说明） ——
  const [blank, setBlank] = useState(false);
  const [blankName, setBlankName] = useState("");
  const [blankPrio, setBlankPrio] = useState("P2");
  const [gen, setGen] = useState(false);
  const [genName, setGenName] = useState("");
  const [cases, setCases] = useState<CaseRow[]>([]);
  // 取回的用例总数（含被 status 过滤掉的）：光看 cases.length 分不清「一条没取到」与
  // 「取到 N 条全被回收站滤光」——后者项目里明明有用例，说「还没有」就是把存在演成 absence。
  const [casesFetched, setCasesFetched] = useState(0);
  // /api-cases 是 silent 拉取：失败连 toast 都没有，只剩空表配一句「还没有接口用例」——
  // 故障被演成空项目（规则③），且 silent catch 混装 403 与网络挂，谁也不能替用户点名。
  const [casesError, setCasesError] = useState<string | null>(null);
  // size=200 且 next_cursor 非空 = 只取到一页，「还没有」这类全称判断撑不住（规则②）。
  const [casesHasMore, setCasesHasMore] = useState(false);
  const [caseSel, setCaseSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function createBlank(): Promise<void> {
    const v = blankName.trim();
    if (!v) { message.warning("场景名必填"); return; }
    setBusy(true);
    try {
      await sceneApi.create({
        project_id: pid, name: v, priority: blankPrio, module_id: moduleId,
        step_graph: { version: 1, nodes: [] },
        variables: {}, fail_fast: true, project_public: true,
      });
      message.success("场景已创建");
      setBlank(false); setBlankName("");
      await load();
    } catch { /* toast */ } finally { setBusy(false); }
  }

  async function openGen(): Promise<void> {
    setGen(true); setGenName(""); setCaseSel([]);
    // 复位必须排在 await 之前：重开弹窗若先渲染上一轮的 verdict，就是拿上一次请求
    // 的结论给这一次定罪（同文件环境弹窗的教训，:294 注释）。
    setCasesError(null); setCasesHasMore(false); setCasesFetched(0);
    try {
      const r = await get<Page<CaseRow>>("/api-cases?project_id=" + encodeURIComponent(pid)
        + "&size=200", { silent: true });
      setCasesFetched(r.items.length);
      setCasesHasMore(r.next_cursor != null);
      setCases(r.items.filter((c) => c.status === "normal"));
    } catch (e) {
      // silent 下这里没有 toast 兜底：不说出口，空表就会替它说「项目里还没有接口用例」
      setCases([]); setCasesFetched(0);
      setCasesError(e instanceof ApiErr ? e.message : "接口用例请求失败");
    }
  }

  // 「从用例生成」= 真建场景：勾选的 N 个用例按顺序生成 api_case 节点骨架（§7.4 协议，
  // ref=case_id）。原注释「落地画布依赖 T19，尚不存在」已过期——画布路由 #/scene/:id
  // 随 T19 落地很久了；生成后落点当前仍落回列表并核实行数（改跳画布是行为决策，另议）。
  async function createFromCases(): Promise<void> {
    const v = genName.trim();
    if (!v) { message.warning("场景名必填"); return; }
    if (!caseSel.length) { message.warning("至少勾选一个用例"); return; }
    setBusy(true);
    try {
      const nodes = caseSel.map((cid, i) => {
        const c = cases.find((x) => x.id === cid);
        return { key: "s" + (i + 1), kind: "api_case", ref: cid, name: c?.name ?? "" };
      });
      await sceneApi.create({
        project_id: pid, name: v, priority: "P2", module_id: moduleId,
        step_graph: { version: 1, nodes },
        variables: {}, fail_fast: true, project_public: true,
      });
      message.success("已生成 " + nodes.length + " 个顺序步骤");
      setGen(false);
      await load();
    } catch { /* toast；422 issues 由 client 弹出 */ } finally { setBusy(false); }
  }

  // —— 行/批量操作 ——
  const [purge, setPurge] = useState<{ id: string; name: string } | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purging, setPurging] = useState(false);
  const [move, setMove] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);

  function removeOne(r: Row) {
    Modal.confirm({
      title: "场景放入回收站？",
      content: "「" + r.name + "」进入回收站，可随时恢复；报告与运行记录不受影响。",
      okText: "放入回收站", okButtonProps: { danger: true, "data-testid": "scene-del-ok" }, cancelText: "取消",
      onOk: async () => {
        try {
          await sceneApi.remove(pid, r.id);
          message.success("已放入回收站");
          await load();
        } catch { /* toast */ }
      },
    });
  }

  async function restoreOne(r: Row): Promise<void> {
    try {
      await sceneApi.restore(pid, r.id);
      message.success("已恢复");
      await load();
    } catch { /* toast */ }
  }

  async function submitPurge(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      await sceneApi.purge(pid, purge.id, purgeName);
      message.success("已彻底删除，场景名可以重新使用");
      setPurge(null); setPurgeName("");
      await load();
    } catch { /* toast；保持弹窗，改名重试或取消 */ } finally { setPurging(false); }
  }

  async function batchMove(): Promise<void> {
    setBusy(true);
    try {
      await sceneApi.batchMove({ project_id: pid, scenario_ids: sel, module_id: moveTarget });
      message.success("已移动 " + sel.length + " 个场景");
      setMove(false);
      await load();
    } catch { /* toast */ } finally { setBusy(false); }
  }

  async function batchDuplicate(): Promise<void> {
    setBusy(true);
    try {
      for (const id of sel) await sceneApi.duplicate(id, { project_id: pid });
      message.success("已复制 " + sel.length + " 个场景");
      await load();
    } catch { /* toast */ } finally { setBusy(false); }
  }

  // 导出备份（D74，§11.4.8 批量条 [导出]）：手法照接口域 api.tsx 的 exportDefs——
  // blob 落盘复用 downloadBlob（不复制第二份）。
  // 只挂批量条、恒带 sel 的 ids：批量条只在勾选时出现，所以不存在「以为选了其实全量」；
  // 蓝图批量条只有 [导出] 一格，不自造「全量导出」入口（后端 ids 缺省=全量 的能力留着，
  // 前端没入口就不说这句话——假门禁令反向适用）。
  const [exporting, setExporting] = useState(false);

  async function exportSelected(): Promise<void> {
    setExporting(true);
    try {
      const out = await sceneApi.export({ project_id: pid, scenario_ids: sel });
      downloadBlob(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }),
        "testpilot-scenario-export.json");
      // D133：后端只要导出过就固定追加一条「本导出是只读备份快照…」的口径说明
      // （scenario/export_services.py:123-126）——notes 非空 ≠ 出了问题，旧写法把
      // 干净的成功也染成 warning。缺失 id 走的是整批 404（:108-111），到不了这里；
      // 真正的逐条问题 note（图校验问题 / 跨域引用指针，:116-122）才配 warning，
      // 固定快照说明按内容开头排除。
      const issues = out.notes.filter((n) => !n.startsWith("本导出是只读备份快照"));
      if (issues.length > 0) message.warning("导出 " + out.exported + " 条，" + issues.length + " 条问题说明：\n" + issues.join("\n"));
      else message.success("已导出 " + out.exported + " 条（只读备份快照，当前无导入可回灌）");
    } catch { /* toast 在 client */ } finally { setExporting(false); }
  }

  // —— 批量执行（D70 解禁：scenario_run 早已注册，此前只是按钮被锁着撒谎）——
  // 环境口径与场景编辑器顶栏同一条（SceneEditor 的 scene-env Select + DebugDrawer.startRun
  // 的 { project_id, env_id }）：env_id=null 就是「用场景自己配置的环境」，不是第三种
  // 「没环境」——后端 scenario_run 落 env_id=payload.env_id or s.env_id，两边同语义。
  // 真拦的是「无环境可跑」：覆写未选 且 任一勾选场景自身 env_id 为空 → 执行必 400/失败，
  // 所以发起前点名挡下，不许偷偷跑。
  const [runOpen, setRunOpen] = useState(false);
  const [runEnvId, setRunEnvId] = useState<string | null>(null);
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [envsLoaded, setEnvsLoaded] = useState(false);
  // 环境取失败：placeholder 与窗内提示都要改口，且下次开窗要重试（见下面 finally）
  const [envsFailed, setEnvsFailed] = useState(false);

  async function openRunModal(): Promise<void> {
    setRunOpen(true); setRunEnvId(null);
    if (!envsLoaded) {
      try {
        const r = await get<Page<EnvRow>>("/envs?project_id=" + encodeURIComponent(pid)
          + "&size=200", { silent: true });
        setEnvs(r.items);
        setEnvsFailed(false);
        setEnvsLoaded(true);
      } catch {
        setEnvs([]); setEnvsFailed(true);
        // 失败不置 envsLoaded：置了就是「一次失败永久定性」。原来这句注释写的是
        // 「失败不假装环境列表为空是同一句话」，而它描述的正是假装本身——
        // envs=[] + envsLoaded=true 让 placeholder 从此只可能喊「还没有环境」。
      }
    }
  }

  const runBlocked = useMemo(() => {
    const missing = sel.filter((id) => {
      const r = rows.find((x) => x.id === id);
      return !runEnvId && !(r?.env_id ?? null);
    });
    return sel.length > 0 && missing.length > 0 ? missing : null;
  }, [sel, rows, runEnvId]);

  async function submitBatchRun(): Promise<void> {
    setBusy(true);
    let enqueued = 0;
    try {
      for (const id of sel) {
        await sceneApi.run(id, { project_id: pid, env_id: runEnvId });
        enqueued += 1;
      }
      message.success("已入队 " + enqueued + " 个执行，进度看报告中心");
    } catch {
      // 不能照抄 purge 的「留着弹窗可重试」：purge 幂等，enqueue 不幂等——
      // 第 2 个失败时第 1 个**已经跑起来了**，弹窗原样留着再点一次就是重跑第 1 个。
      // 所以任何结局都关窗，并把「已入队几个」说出口，重试由用户重新勾选显式发起。
      // （client 已统一弹错误原因，这里补的是「前面那几个去哪了」。）
      message.warning(enqueued > 0
        ? "已入队 " + enqueued + " 个，之后的没投递——重试请重新勾选（已入队的那几个会重跑）"
        : "一个都没投递成功");
    } finally {
      setBusy(false);
      setRunOpen(false);
    }
    if (enqueued > 0) await load();
  }
  const newMenu = {
    items: [
      { key: "blank", icon: <PlusOutlined />, label: "空白场景" },
      { key: "gen", label: "从用例生成" },
      { key: "pilot", icon: <RobotOutlined />, label: "让 Pilot 生成" },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === "blank") { setBlank(true); setBlankName(""); setBlankPrio("P2"); }
      if (key === "gen") void openGen();
      // 1F T6 哨兵翻真：此前是 Modal.info 说明占位（「1F 开放」），1F 落地后改跳试验台。
      // bench 挂载即把当前项目（auth store）预选进项目选择器，不需要额外传参。
      if (key === "pilot") nav("/bench");
    },
  };

  return (
    <Row gutter={16} align="top">
      <Col flex="208px">
        <Card size="small">
          <ModuleTree
            projectId={pid} tree={tree} recycled={recycledTree}
            inRecycled={inRecycled} onToggleRecycled={(v) => patchFilters({ inRecycled: v })}
            selected={moduleId} onSelect={(id) => patchFilters({ moduleId: id })}
            onChanged={() => void load()}
            canManage={canModDelete} canCreate={canModCreate}
            apiBase="/scenario-modules" allLabel="全部场景" noun="场景"
            // 树与列表在同一把 Promise.all 里，失败时两边一起停：不传给树的话，
            // 回收站视图会在「没取到」时画一句「回收站是空的」。
            loadError={loadError}
          />
        </Card>
      </Col>
      {/* flex 基准必须是 0：`auto` 会拿表格内容的 max-content 当基准，208+宽表 > 行宽，
          antd Row 的 flex-wrap 就把右列整块折到下一行、横跨全宽（2026-11-22 截图实测）。 */}
      <Col flex="1 1 0" style={{ minWidth: 0 }}>
        <Space style={{ marginBottom: 12 }} wrap>
          {/* 关键词是服务端契约（D47-b 步5b）：打字只动 qText（受控现值），提交才进 load
              依赖（kw）。提交口恰好三个：Enter、放大镜钮、allowClear 清空——antd 5.29 的
              Input.Search 把三条路径都汇进 onSearch（clear 图标点击也以 source:'clear' 触发它）。
              第一个入参是 antd 给的当前值（clear 路径上是空串），不读闭包里的 qText——
              onChange 里**绝不**发请求。空/纯空白提交 = 不带 keyword 参数。 */}
          <Input.Search data-testid="scene-search" allowClear style={{ width: 240 }}
            placeholder="搜索场景名" value={qText}
            onChange={(e) => setQText(e.target.value)}
            onSearch={(v) => patchFilters({ kw: v.trim() })} />
          <Button icon={<ReloadOutlined />} data-testid="scene-reload" onClick={() => void load()}>刷新</Button>
          {canCreate && !inRecycled && (
            <Dropdown menu={newMenu} data-testid="scene-new-menu">
              <Button type="primary" data-testid="scene-new">
                <Space>新建场景<DownOutlined /></Space>
              </Button>
            </Dropdown>
          )}
        </Space>
        {sel.length > 0 && !inRecycled && (
          <div data-testid="scene-batch-bar" style={{ marginBottom: 8 }}>
            <Space wrap>
              <Typography.Text>已选 {sel.length} 项</Typography.Text>
              {/* 执行(选环境)：D70 真入口——弹环境选择后逐个 sceneApi.run（投递语义，
                  trigger=manual 由入口自动决定）。无 scenario:run 时不渲染（按钮级权限点
                  隐藏而非禁用，§11.5.1/D47 口径）。 */}
              {canRun && (
                <Button size="small" data-testid="scene-batch-run" loading={busy}
                  onClick={() => void openRunModal()}>执行</Button>
              )}
              {canUpdate && <Button size="small" data-testid="scene-batch-move" onClick={() => { setMove(true); setMoveTarget(null); }}>移动</Button>}
              {canUpdate && <Button size="small" data-testid="scene-batch-copy" loading={busy} onClick={() => void batchDuplicate()}>复制</Button>}
              {/* 导出（D74）：位置照蓝图批量条 [移动][复制][导出][回收站]，权限 scenario:read
                  （与后端 scenario_export 的 perm 同源；无读位时隐藏而非禁用，§11.5.1/D47）。
                  导出选中：ids 原样带进 /scenario-export，勾 3 条绝不悄悄变全量（同 api.tsx 口径）。 */}
              {canRead && (
                <Button size="small" icon={<ExportOutlined />} data-testid="scene-batch-export" loading={exporting}
                  onClick={() => void exportSelected()}>导出</Button>
              )}
              {canDelete && (
                <Button size="small" danger data-testid="scene-batch-del" onClick={() => {
                  Modal.confirm({
                    title: "把选中的 " + sel.length + " 个场景放入回收站？",
                    content: "进入回收站后可恢复；报告与运行记录不受影响。",
                    okText: "放入回收站", okButtonProps: { danger: true, "data-testid": "scene-del-ok" }, cancelText: "取消",
                    onOk: async () => {
                      try {
                        for (const id of sel) await sceneApi.remove(pid, id);
                        message.success("已放入回收站");
                        await load();
                      } catch { /* toast */ }
                    },
                  });
                }}>回收站</Button>
              )}
            </Space>
          </div>
        )}
        {/* 刻意不给 ×：与 api.tsx 同口径——关掉这条会把「场景没取到」擦成「还没有场景，
            点右上角新建」，还能让脚注失去「这一屏是失败态」的唯一记号。 */}
        {loadError && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="scene-load-error"
            message="场景列表加载失败" description={loadError} />
        )}
        <AdminTable<Row> rowKey="id" loading={loading} dataSource={rows}
          rowSelection={inRecycled ? undefined : {
            selectedRowKeys: sel, onChange: (ks) => setSel(ks as string[]),
            columnWidth: 36,
          }}
          locale={{ emptyText: loadError ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="场景列表没取到，以上方的加载失败提示为准" />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
              // 「点右上角新建」是句指路，而右上角那枚钮在 canCreate && !inRecycled
              // 双闸圈住：无 scenario:create 的人照着空态去点，点的是一个根本没渲染的按钮
              // （规则④：同棵树里藏起来的把手不许在文案里许诺）。同口径已交付两份
              // （uiCases.tsx:183-184 / adbCases.tsx:148-149），本页是第三个站点。
              // D47-b 步5b：表渲染的就是服务端筛后的当前页，空表只说明「当前条件下后端
              // 没给行」。归因读的全是**已提交**的筛选（kw 不是 qText）——输入框里没敲
              // 回车的那半截关键词不许替用户背锅（D134 的归因链、api.tsx 步4b 同口径）。
              description={shownRecycled ? "回收站是空的"
                : kw.trim() ? "没有匹配的场景，换个关键词试试"
                  : moduleId ? "这个模块下没有场景（换个模块或看「未分类」）"
                    : canCreate ? "还没有场景，点右上角新建" : "还没有场景（你没有新建权限）"} />
          ) }}
          columns={[
            { title: "名称", dataIndex: "name", width: 200, render: (v: string) => (
              <span data-testid="scene-row-name">{v}</span>) },
            // §11.4.18 回收站「删除人/删除时间」两列——模板整组读 shownRecycled（D180：跟数据走），
            // 单元格再按 r.status 逐行兜底。
            // 为什么必须守卫：同一份 updated_by/updated_at 在正常行上是「最后编辑人/时间」
            // （update 也写它），标成「删除人」就是说谎；只有回收行最后那次写才恰好是回收本身。
            ...(shownRecycled ? [
              { title: "删除人", key: "delby", width: 96, render: (_: unknown, r: Row) => (
                // 非回收行不画（混合数据里画了就是说谎）；后端查不到人给 null，落「—」不拿 id 冒充人名
                r.status === "recycled"
                  ? <span data-testid="scene-recycled-by">{r.updated_by_name ?? "—"}</span>
                  : <span>—</span>) },
              { title: "删除时间", key: "delat", width: 150, render: (_: unknown, r: Row) => (
                // 换算走 shared/timefmt（§3.4-6：UTC 存 / Asia/Shanghai 展示）；回收行的
                // updated_at 就是回收那次的落库时刻。非回收行不画（同删除人列）
                r.status === "recycled" ? (
                  <Typography.Text type="secondary" data-testid="scene-recycled-at" style={{ fontSize: 12 }}>
                    {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
                  </Typography.Text>) : <span>—</span>) },
            ] : []),
            { title: "模块", key: "mod", width: 120, render: (_, r) => (
              r.module_id ? <Tag>{moduleName.get(r.module_id) ?? "已回收模块"}</Tag>
                : <Typography.Text type="secondary">—</Typography.Text>) },
            { title: "优先级", dataIndex: "priority", width: 80, render: (v: string) => (
              <Tag data-testid={"scene-prio-" + v} color={PRIO_COLOR[v] ?? "default"}>{v}</Tag>) },
            { title: (
              // 这列读的是场景行上的冗余列，它只在终态回写（orchestration.py:268 的 TERMINAL 门），
              // 调试也不回写（T11 裁定①）——正在跑的那次此刻不反映在这里。表头只写「最近结果」
              // 时读的人会拿它当实时状态（D178 裁 ①：口径改准，不开 start 侧回写）。
              <Tooltip title="最近一次真执行的终态（不含调试，也不反映正在跑的那次）">最近结果</Tooltip>
            ), key: "run", width: 100, render: (_, r) => <RunDot status={r.last_run_status} /> },
            { title: "步骤数", dataIndex: "step_count", width: 76, render: (v: number) => (
              <span data-testid="scene-steps">{v}</span>) },
            { title: (
              <Tooltip title="单场景的定时绑定看场景编辑器右栏；列表行不反查——GET /schedule-tasks 是项目级分页列表，逐行对照不是这里能如实给的">定时</Tooltip>
            ), key: "cron", width: 64, render: () => (
              <Typography.Text type="secondary" data-testid="scene-cron">-</Typography.Text>) },
            { title: "负责人", key: "owner", width: 96, render: (_, r) => (
              <span>{ownerLabel(r.owner_id, members)}</span>) },
            { title: "更新时间", key: "upd", width: 150, render: (_, r) => (
              // 分钟级（列宽 150 装不下秒），换算走 shared/timefmt：
              // 上一版在这里 slice(0,16)，显示的是 UTC 钟点，比真实时间早 8 小时（R68）。
              <Typography.Text type="secondary" data-testid="scene-updated" style={{ fontSize: 12 }}>
                {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
              </Typography.Text>) },
            { title: "", key: "ops", width: 150, render: (_, r) => (
              // D180：行身份逐行认 r.status，不认视图旗标——视图翻转与 refetch 之间那截窗口里
              // （以及取数一直失败期间）屏上还是活行，「彻底删除」长到活行上不是样式错，
              // 是给用户一个物理删除活场景的按钮。权限位分工不动（canUpdate/canDelete）。
              r.status === "recycled"
                ? (
                  <Space size={4}>
                    {canUpdate && (
                      <Button size="small" icon={<UndoOutlined />} data-testid="scene-restore"
                        onClick={() => void restoreOne(r)}>恢复</Button>
                    )}
                    {canDelete && (
                      <Button size="small" danger data-testid="scene-purge"
                        onClick={() => { setPurge({ id: r.id, name: r.name }); setPurgeName(""); }}>
                        彻底删除
                      </Button>
                    )}
                  </Space>
                )
                : (
                  <Space size={4}>
                    {/* 画布路由 #/scene/:id 随 T19 落地：入口从此处直达编辑器 */}
                    <Button size="small" type="link" data-testid="scene-open-canvas"
                      onClick={() => nav("/scene/" + r.id)}>打开画布</Button>
                    {canDelete && (
                      <Tooltip title="放入回收站">
                        <Button size="small" danger type="text" icon={<DeleteOutlined />}
                          data-testid="scene-delete" aria-label={"删除-" + r.name} onClick={() => removeOne(r)} />
                      </Tooltip>
                    )}
                  </Space>
                )
            ) },
          ]}
        />
        {/* D47-b 步5b：共享页码分页器。total 缺键（响应没带 total）时 ListPager 整块不渲染，
            这里垫在 Table 之下（runs.tsx:247-255 的居中垫法）；「共 N 条」从此只有服务端
            这一张嘴——旧脚注拿本地 visible.length / rows.length 现攒「共」的日子随本地过滤
            一起退役了。 */}
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <ListPager
            current={current}
            pageSize={pageSize}
            total={total}
            onPage={setCurrent}
            onPageSize={setPageSize}
          />
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {/* D47-b 步5b：hasMore 那句「本页取到 N 条（单页上限 200，后面还有没取的）」随游标
              世界退役——页码模式下下一页永远点得到，「还有没取的」不再是脚注能说的事；
              「上次取到 N 条」那句随「失败不清行」一起退役（api.tsx 同款），失败清行清 total
              后这句只剩「计数不作数」一条腿。
              「选中模块」四个字的口径（R120）：本页徽标与列表都是**直属**口径（见文件头），
              这句只说「你选了哪个模块」，不承诺直属/子树——两个口径下它都是真话。 */}
          {loadError ? "本次列表加载失败，本行计数不作数" : ""}
          {moduleId ? "（选中模块）" : ""}{shownRecycled ? " · 回收站视图" : ""}
        </Typography.Text>
      </Col>
      {/* 新建空白场景 */}
      <Modal open={blank} title="新建空白场景" okText="创建" cancelText="取消"
        confirmLoading={busy} data-testid="scene-blank-modal"
        okButtonProps={{ "data-testid": "scene-blank-ok" }}
        onOk={() => void createBlank()} onCancel={() => setBlank(false)}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input data-testid="scene-blank-name" maxLength={200} value={blankName} autoFocus
            placeholder="场景名，如「履约回归」" onChange={(e) => setBlankName(e.target.value)}
            onPressEnter={() => void createBlank()} />
          <Select data-testid="scene-blank-prio" style={{ width: "100%" }} value={blankPrio}
            options={["P0", "P1", "P2", "P3"].map((p) => ({ value: p, label: p }))}
            onChange={setBlankPrio} />
        </Space>
      </Modal>

      {/* 从用例生成：勾 N 个 api_case → 顺序步骤骨架（真调后端建场景） */}
      <Modal open={gen} title="从用例生成场景" width={640} okText="生成" cancelText="取消"
        confirmLoading={busy} data-testid="scene-gen-modal"
        okButtonProps={{ "data-testid": "scene-gen-ok", disabled: caseSel.length === 0 }}
        onOk={() => void createFromCases()} onCancel={() => setGen(false)}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input data-testid="scene-gen-name" maxLength={200} value={genName} autoFocus
            placeholder="场景名" onChange={(e) => setGenName(e.target.value)} />
          <Table<CaseRow> size="small" rowKey="id" dataSource={cases} pagination={false}
            rowSelection={{
              selectedRowKeys: caseSel,
              onChange: (ks) => setCaseSel(ks as string[]),
              columnWidth: 36,
            }}
            // 三个病态此前塌进同一句全称判断「项目里还没有接口用例」：
            // ① silent 请求失败（403 与网络挂都可能，代码证不了是哪种，所以两种都不点名，
            //    只否掉「没有」这个结论本身——规则①③）；② 取到 N 条全被 status 滤进回收站，
            //    项目明明有用例（后端 ApiCase.status 只有 normal/recycled 两值，models.py:55，
            //    滤光即「都在回收站」是实证的）；③ next_cursor 非空 = 只取到一页 200，
            //    全称否定撑不住（规则②）。真·空列表仍走原句，别把没病也喊成有病。
            locale={{ emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={casesError ? "接口用例没取到，不是项目里没有：刷新或重试本弹窗"
                  : (cases.length === 0 && casesFetched > 0)
                    ? `取到的 ${casesFetched} 条接口用例都在回收站里，先恢复或换项目`
                    : casesHasMore ? "只取到前 200 条接口用例，列表可能不全：勾不到的先去接口管理按模块找"
                      : "项目里还没有接口用例：先去接口管理建用例"} />
            ) }}
            columns={[
              { title: "用例", dataIndex: "name" },
              { title: "优先级", dataIndex: "priority", width: 80 },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            勾选的用例按列表顺序生成 api_case 步骤骨架，生成后可在画布上调整（画布 T19 交付）。
          </Typography.Text>
        </Space>
      </Modal>

      {/* 批量移动到模块 */}
      <Modal open={move} title={"移动 " + sel.length + " 个场景到模块"} okText="移动" cancelText="取消"
        confirmLoading={busy} data-testid="scene-move-modal"
        okButtonProps={{ "data-testid": "scene-move-ok" }}
        onOk={() => void batchMove()} onCancel={() => setMove(false)}>
        <Select allowClear data-testid="scene-move-target" style={{ width: "100%" }}
          value={moveTarget ?? undefined} placeholder="未分类（根）"
          options={flatten(tree)} onChange={(v) => setMoveTarget(v ?? null)} />
      </Modal>

      {/* 批量执行（D70）：选环境 → 逐个 enqueue。不选 = 各自用场景配置的环境（与编辑器
          scene-env 的 allowClear 同一语义，后端 scenario_run 的 env_id or s.env_id）；
          「无环境可跑」在前端点名拦下，不投递注定失败的 run。 */}
      <Modal open={runOpen} title={"执行 " + sel.length + " 个场景"} okText="入队执行" cancelText="取消"
        confirmLoading={busy} data-testid="scene-run-modal"
        okButtonProps={{ "data-testid": "scene-run-ok", disabled: runBlocked !== null }}
        onOk={() => void submitBatchRun()} onCancel={() => setRunOpen(false)}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Select allowClear data-testid="scene-run-env" style={{ width: "100%" }}
            value={runEnvId ?? undefined}
            placeholder={envsFailed ? "环境没取到，关掉重开可重试"
              : envsLoaded && envs.length === 0 ? "还没有环境" : "覆写环境（不选=各场景自带环境）"}
            options={envs.map((e) => ({ value: e.id, label: e.name }))}
            onChange={(v) => setRunEnvId(v ?? null)} />
          {envsFailed && (
            <Typography.Text type="danger" data-testid="scene-run-env-failed">
              环境列表没取到，这句「没有环境」不作数——覆写环境现在只能靠猜；关掉本窗再点一次[执行]会重新拉。
            </Typography.Text>
          )}
          {runBlocked && (
            <Typography.Text type="danger" data-testid="scene-run-blocked">
              {sel.length - runBlocked.length === 0
                ? "选中的场景都没有配置环境，且未选覆写环境——先在场景里配环境或在这里选一个"
                : "其中 " + runBlocked.length + " 个场景没有配置环境：选一个覆写环境，或取消勾选它们"}
            </Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            执行跑库里已保存的场景，逐个投递入队（trigger=manual），进度与结果见报告中心。
          </Typography.Text>
        </Space>
      </Modal>

      {/* 彻底删除：不可逆，输名确认（与 1A 回收站手感一致；服务端同样硬校验） */}
      <Modal
        open={purge !== null} onCancel={() => { setPurge(null); setPurgeName(""); }}
        destroyOnHidden width={520}
        title="彻底删除场景？" okText="我已确认，彻底删除" cancelText="取消"
        okButtonProps={{ danger: true, "data-testid": "scene-purge-ok",
          disabled: purgeName !== (purge?.name ?? ""), loading: purging }}
        onOk={() => void submitPurge()}
      >
        <Typography.Paragraph>
          「{purge?.name}」将被物理删除，
          <Typography.Text strong>无法恢复</Typography.Text>；运行记录与报告保留（历史不追删）。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          输入场景名 <Typography.Text code>{purge?.name}</Typography.Text> 以确认。
        </Typography.Paragraph>
        <Input data-testid="scene-purge-confirm" value={purgeName} autoFocus
          placeholder={purge?.name} onChange={(e) => setPurgeName(e.target.value)} />
      </Modal>
    </Row>
  );
}

export default function ScenesPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-scene">
      <PageHead title="场景编排"
        desc="多步骤场景的画布与列表双模式；步骤可调试草稿，也可执行已保存版本。" />
      <ProjectGate>{project ? <ScenesWorkbench /> : null}</ProjectGate>
    </div>
  );
}
