// 接口管理（§11.4）：左模块树 + 右列表 + 全屏编辑器 + 详情抽屉 + 实时调试。
// 行「最近结果」来自 GET /runs?subject_id=&size=1（后端保证最新在前）；页码分页、关键词、
// 模块子树在 D47-b 步4b 全部下推到后端 SQL——本页不再「拉一页 200 条再本地过滤」。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert, Button, Card, Col, Drawer, Empty, Input, Modal, Row, Select, Space, Switch, Tag,
  Tooltip, Typography, message,
} from "antd";
import { DeleteOutlined, EditOutlined, ExportOutlined, ImportOutlined, PlusOutlined, ReloadOutlined, UndoOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import ShareButton from "../ui/ShareButton";
import { ApiErr, get, patch, post } from "../api/client";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { sceneApi } from "../api/scene";
import type { components } from "../api/schema";
import ModuleTree from "../api/ModuleTree";
import type { ModNode } from "../api/ModuleTree";
import { flatten, subtreeIds } from "../shared/moduleTree";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { STATUSES, TRIGGERS } from "../shared/runVocab";
import RequestEditor, { fromDraft, toDraft } from "../api/RequestEditor";
import type { Draft } from "../api/RequestEditor";
import DebugPanel from "../api/DebugPanel";
import type { DebugResult } from "../api/DebugPanel";
import ImportWizard, { downloadBlob } from "../api/ImportWizard";
import CaseList, { ScenarioRefsBlockModal, scenarioBlockOf } from "../api/CaseList";
import type { ScenarioBlockDetails } from "../api/CaseList";
import EnvSelect from "../api/EnvPanel";
import { cleanRequest, varRefs, METHODS } from "../api/req";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import { applyColumnPrefs, emptyFilter, filterQuery, isFilterEmpty } from "../shared/listFilters";
import type { ColumnChoice, FilterDoc } from "../shared/listFilters";
import type { ApiDef, Page, RunRow } from "../api/api";
import { METHOD_TAG } from "../theme";
/** 列设置面板要露的列（key 必须与下方 columns 的 key 逐字对上，对不上就是「面板能勾、
 *  表头不动」的假把手——api.test.tsx 的「勾掉方法 → 表头真消失」钉这一环）。
 *  操作列不列：它带着恢复/彻底删除的入口，被关掉等于把回收站的出口藏起来。 */
const API_COL_CHOICES: ColumnChoice[] = [
  { key: "name", label: "接口" },
  { key: "method", label: "方法" },
  { key: "mod", label: "模块" },
  { key: "status", label: "状态" },
  { key: "owner", label: "负责人" },
  { key: "upd", label: "更新时间" },
  { key: "badge", label: "最近结果" },
];

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  draft: { color: "orange", label: "草稿" },
  complete: { color: "green", label: "完整" },
  recycled: { color: "default", label: "回收站" },
};


interface Badge { status: string; code: number | null; elapsed: number | null; trigger: string;
  /** hover 补的两项（蓝图 :1376「hover 时间+环境」，D80）：同一行 run 的 created_at / env_name。 */
  at: string | null; env: string | null }

// flatten / subtreeIds 取自 shared/moduleTree.ts（R99 抽公共；步4b 起本页筛选用
// subtreeIds 的「节点+全部子孙」集合，ownModuleIds 只有场景页与 UI 元素页还在用）。

function BadgeCell({ b }: { b: Badge | undefined }) {
  if (!b || b.status === "none") {
    return <Typography.Text className="tp-text-sm" type="secondary">未运行</Typography.Text>;
  }
  // 「这一行的运行记录没取到」与「这条接口真的还没跑过」是两件事（§13 纪律 1）：
  // 徽标 loader 是 silent:true，以前 catch 留空 → badges[id] 缺席 → 落进上面那句
  // 肯定的「未运行」，把挂掉的请求演成实测零条。unknown 态另起一句，且不挂
  // data-testid="run-badge"（那是 e2e api.spec.mjs 认状态码的把手，失败不许冒充真徽标）。
  // Tooltip 不说死是哪种失败：silent catch 里 5xx/网络与 403 本来就无法区分，猜就是编。
  if (b.status === "unknown") {
    return (
      <Tooltip title="这一行的运行记录没取到（可能是请求失败或无权查看），刷新后重试——不能把它当成「未运行」">
        <Typography.Text className="tp-text-sm" type="secondary" data-testid="run-badge-unknown">
          运行记录没取到
        </Typography.Text>
      </Tooltip>
    );
  }
  // 触发词与状态都吃 shared/runVocab（与后端 Field(pattern=...) 同源，runVocab.test.ts
  // 从后端源码抠 pattern 对表）：这里曾手写私有 TRIGGER_LABEL 副本，第 26 轮修主词表时
  // 漏改它，漂出三种实测病——agent 在这画「✦Agent」而 runs 页/后端通知模板都叫 Pilot
  // （同一条 run 两译）；死键 case 是当年 422 事故（services.py:34-35 R46：后端 pattern
  // 根本没有 case）；pattern 里的 webhook 副本没有，真出现只能画生码。
  // 颜色同理：副本只认 passed/failed，T9 起 enqueue/runner 真会写 queued/running/
  // cancelled（services.py:23 六态），彼时 status_code 为 null，徽标直出英文生码，
  // 而同一条 run 在运行记录页叫「排队中/运行中/已取消」。
  // 徽标查 TRIGGERS 全表、不裁 reserved（口径 runVocab.ts:20-24：徽标报已发生的事，
  // 库里存了就得照实画，裁承诺面的是筛选项）；查不到渲染原文，不编友好标签
  // （同 SUBJECT_TYPES 对 inline 的处理：宁可生码，不可撒谎）。
  const trig = TRIGGERS[b.trigger];
  // b.code 优先是 e2e 契约（api.spec.mjs:96/107 断言徽标文本 200）：error 的「请求失败」
  // 特判删掉——STATUSES.error.label 本来就是它，不再需要第二份。
  const color = STATUSES[b.status]?.color ?? "default";
  // hover 三段（D80，蓝图 :1376「hover 时间+环境」）：触发词 + 时间 + 环境。
  // 缺哪个少哪个：时间走 fmtTime（空/非法 → null → 整段不出现），环境为 null
  // （如不带环境的调试）也整段不出现——「环境：null」与编一个时刻一样是撒谎。
  const time = fmtTime(b.at, { seconds: false });
  return (
    <Tooltip title={(trig ? trig.icon + trig.label : b.trigger)
      + (b.elapsed != null ? " · " + b.elapsed + "ms" : "")
      + (time ? " · " + time : "")
      + (b.env ? " · " + b.env : "")}
    >
      <Tag data-testid="run-badge" color={color}>
        {b.code ?? (STATUSES[b.status]?.label ?? b.status)}
      </Tag>
    </Tooltip>
  );
}

function ApiWorkbench() {
  const { project, user } = useAuth();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canRead = can(perms, "api:def:read");
  const canCreate = can(perms, "api:def:create");
  const canUpdate = can(perms, "api:def:update");
  const canDelete = can(perms, "api:def:delete");
  // D202：接口文档公开分享（写副作用，缺位不渲染）。
  const canShare = can(perms, "share:link:create");
  const canDebug = can(perms, "api:debug:run");

  const [defs, setDefs] = useState<ApiDef[]>([]);
  const [tree, setTree] = useState<ModNode[]>([]);
  const [recycledTree, setRecycledTree] = useState<ModNode[]>([]);
  const [inRecycled, setInRecycled] = useState(false);
  // D180：回收站模板（回收空态、脚注后缀）读 shownRecycled——点击只翻 inRecycled（请求参数、
  // 新建/导出/勾选闸），模板要等取数成功那一刻跟行一起翻；失败不翻。在途/失败窗口里屏上留着
  // 的还是正常行，按点击位挂回收模板就是说谎（同 adbDevices.tsx:449-453 口径）。
  const [shownRecycled, setShownRecycled] = useState(false);
  const [moduleId, setModuleId] = useState<string | null>(null);
  // D47-b 步4b：输入框现值（qText）与**已提交**关键词（kw）分两个 state——打字只动 qText，
  // 进 load 依赖的是 kw。合并成一个的话「查询订单」打六个字发六条 GET；提交口只有
  // Enter/放大镜/allowClear 三处（antd 5.29 的 Input.Search 恰好把这三条路径都汇进
  // onSearch——allowClear 的清空也带 source:'clear' 触发它，见 extra 的注释）。
  const [qText, setQText] = useState("");
  const [kw, setKw] = useState("");
  // D47-b：页码分页（current/size/total）替换「拉 200 条本地过滤」。默认档位 20 在
  // ListPager 档位表（20/50/100）里、后端 size 上限（le=200）内。current 只有 pager
  // 回调与 patchFilters 写，load 永不写它（runs.tsx 同法，一页只许有一个「我在第几页」的真相）。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  // 取数失败与「项目里真的没有接口」必须分两句话说（本文件原来的 catch 注释写着
  // 「toast 已在 client 里弹」，而这两个请求都是 silent:true —— 连 toast 都没有，
  // 故障只剩一句「还没有接口」把挂掉的请求演成实测零条）。
  const [loadError, setLoadError] = useState<string | null>(null);
  const [envId, setEnvId] = useState<string | null>(null);
  const [badges, setBadges] = useState<Record<string, Badge>>({});
  const [seq, setSeq] = useState(0); // 每次 load 自增：徽标 effect 靠它重跑（ids 不变时也要刷新）

  const [editing, setEditing] = useState<ApiDef | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(() => toDraft(null));
  const [form, setForm] = useState({ name: "", path: "", module_id: null as string | null, project_public: true });
  const [saving, setSaving] = useState(false);
  const [debugging, setDebugging] = useState(false);
  const [result, setResult] = useState<DebugResult | null>(null);
  const [detail, setDetail] = useState<ApiDef | null>(null);
  // 彻底删除（§11.4.18）：不可逆，必须手输接口名才放行
  const [purge, setPurge] = useState<{ id: string; name: string } | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purging, setPurging] = useState(false);
  // 导入向导（1E T4，§11.4.6）：完成/关闭后 onImported 走一次 load()
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // 行勾选（1E T5 补完）：只有选中行才会以 definition_ids 传进 /api-export；
  // 每次 load 清空——列表变了还留着旧勾选就是骗人。
  const [selected, setSelected] = useState<string[]>([]);

  // D47-a 高级搜索（§11.5.1）：条件由后端 filter_meta 定义可筛字段，前端不列字段名。
  // 打在 SQL 谓词上（与可见性谓词同一个 .where，AND 在一起）。D47-b 步4b 起关键词与
  // 模块子树也下推后端，三条筛选与回收站开关走同一个 patchFilters 写入口。
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const hasAdv = !isFilterEmpty(advFilter);
  // 任一筛选（模块/已提交关键词/高级搜索/回收站开关）变化必回第 1 页：停在第 7 页改筛选，
  // 落的是新条件下无关的切片甚至空页（runs.tsx:84 同款 hazard，listPagination.tsx 注释③）。
  // 四类筛选只有 patchFilters 这一个写入口，回页钉在唯一入口处——各自 setState 漏接一个 reset 没人拦得住。
  const patchFilters = useCallback((p: {
    moduleId?: string | null; kw?: string; advFilter?: FilterDoc; inRecycled?: boolean;
  }): void => {
    if ("moduleId" in p) setModuleId(p.moduleId!);
    if ("kw" in p) setKw(p.kw!);
    if ("advFilter" in p) setAdvFilter(p.advFilter!);
    if ("inRecycled" in p) setInRecycled(p.inRecycled!);
    setCurrent(1);
  }, []);
  // id/enum 字段的候选来自页面已经拿得到的数据：方法词表用 src/api/req.ts 的 METHODS
  // （编辑器下拉同一个来源，不在这里另列一份），模块候选用已经拉在手里的模块树。
  const filterValueOptions = useMemo<Record<string, Option[]>>(() => ({
    method: METHODS.map((m) => ({ value: m, label: m })),
    // status 只有 draft/complete：回收与否是 recycled 开关，不是这一列的取值，
    // 把 recycled 摆进候选会让人筛出一个恒空集
    status: [{ value: "draft", label: "草稿" }, { value: "complete", label: "完整" }],
    module_id: flatten(tree),
  }), [tree]);

  // 导出备份（1E T5 补完）：ids 传了 → 只导这几条（批量条 [导出选中]）；不传 → 后端全量口径
  // （顶栏 [全量导出]）。两个入口各自如实命名，绝不让「勾了 3 条点导出」悄悄变全量（§13 纪律 1）。
  // blob 落盘复用 ImportWizard 的 downloadBlob（与「下载错误报告」同一手法，不复制第二份）。
  async function exportDefs(ids: string[] | null): Promise<void> {
    setExporting(true);
    try {
      const out = await post<{ openapi: Record<string, unknown>; exported: number; notes: string[] }>(
        "/api-export", {
          project_id: pid,
          // 选中导出才带 ids（缺省键 = 后端「全量 = 项目内全部非回收」语义，见 ApiExportIn）
          ...(ids ? { definition_ids: ids } : {}),
        });
      downloadBlob(new Blob([JSON.stringify(out.openapi, null, 2)], { type: "application/json" }),
        "testpilot-api-export.json");
      if (out.notes.length > 0) message.warning("导出 " + out.exported + " 条，另有 " + out.notes.length + " 条说明：\n" + out.notes.join("\n"));
      else message.success("已导出 " + out.exported + " 条（OpenAPI3，可被导入向导吃回）");
    } catch { /* toast 在 client */ } finally { setExporting(false); }
  }

  // Ctrl+K 直达（T22）：#/api?def=<id>[&tab=case] 打开对应详情抽屉；
  // 只认一次（deepRef latch），之后用户手动关抽屉不会被查询串「复活」。
  // D47-b 步4b：列表改成页码模式后「第一页没有 ≠ 没有这条」——旧代码只认已加载行、
  // 翻页前 miss 只能装没看见；现在 miss 走**恰好一次** GET /api-definitions/{id}
  // （按 id 取回的形状与列表行同为 ApiDefOut），取到就开抽屉；取不到不编行，
  // 老实弹后端原话（client 非 silent 自弹）后翻篇。firstLoaded 保证「首帧列表已落地」
  // 之后才消费（含失败落地：列表都没取到时按 id 再试一次同样诚实）。
  const [sp] = useSearchParams();
  const deepRef = useRef({ consumed: false });
  const [firstLoaded, setFirstLoaded] = useState(false);
  useEffect(() => {
    if (deepRef.current.consumed) return;
    const target = sp.get("def");
    if (!target || !firstLoaded) return;
    deepRef.current.consumed = true;
    const hit = defs.find((d) => d.id === target);
    if (hit) {
      setDetail(hit);
      if (sp.get("tab") === "case") setDeepCase(true);
      return;
    }
    void (async () => {
      try {
        const d = await get<ApiDef>("/api-definitions/" + encodeURIComponent(target)
          + "?project_id=" + encodeURIComponent(pid));
        setDetail(d);
        if (sp.get("tab") === "case") setDeepCase(true);
      } catch { /* client 已把后端原话 toast 出去；没有行就是没有行，绝不塞一条编的进抽屉 */ }
    })();
    // defs 进依赖只为让命中判断看到已落地行；consumed latch 后本 effect 直接 return
  }, [sp, firstLoaded, defs, pid]);
  const [deepCase, setDeepCase] = useState(false);

  // 模块子树集合要从**已到手**的树里算（subtreeIds 是纯内存 DFS）。load 自己也写 tree，
  // 把 tree 放进 load 依赖就是 D127 记过的回路（响应→新 tree→load 换身份→effect 重跑）；
  // 树与列表在同一次点击里必然先后落地（首帧取回树才可能点到节点），用 ref 镜像即可。
  const treeRef = useRef<{ tree: ModNode[]; recycled: ModNode[] }>({ tree: [], recycled: [] });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [t, d] = await Promise.all([
        get<{ tree: ModNode[]; recycled: ModNode[] }>(
          "/api-modules?project_id=" + encodeURIComponent(pid) + "&include_recycled=true", { silent: true }),
        (() => {
          // 页码模式（D47-b）：current 一上线就是「这页要第几页」的唯一口径，
          // 请求永不带 cursor——current+cursor 同传后端直接 400，一页两把尺子正是被禁的那件事。
          const q = new URLSearchParams({ project_id: pid, size: String(pageSize), current: String(current) });
          if (inRecycled) q.set("recycled", "true");
          if (kw.trim()) q.set("keyword", kw.trim()); // 空/纯空白 = 不过滤，参数整个不上线
          if (moduleId) {
            // 子树 = 选中节点 + 全部子孙，与步4a 的子树徽标配套（subtreeIds 的注释记着这笔账）；
            // 树里查不到该节点时不拼 module_ids——与本地过滤时代的「找不到当不过滤」同款语义。
            const sub = subtreeIds(inRecycled ? treeRef.current.recycled : treeRef.current.tree, moduleId);
            if (sub) for (const id of sub) q.append("module_ids", id); // 重复键（后端 list[str] 的收法）
          }
          // 空筛选不拼参数（filterQuery 内建）：留一条 `filter=` 在 URL 上是骗人的参数
          return get<Page<ApiDef>>("/api-definitions?" + q.toString() + filterQuery(advFilter), { silent: true });
        })(),
      ]);
      setTree(t.tree); setRecycledTree(t.recycled);
      treeRef.current = { tree: t.tree, recycled: t.recycled };
      // 页码模式是替换语义：第 3 页的行就只画第 3 页的，别页的行必须下桌。
      setDefs(d.items);
      // total 只从响应来，永不由 items.length 客户端现攒（页内行数不是总数）。
      // 缺键（后端尚未上页码模式的游标式响应）→ null → ListPager 整块不渲染。
      setTotal(d.total ?? null);
      // D180：模板与模块树选择在成功路径追平点击——行、树、模板同一批提交；失败路径不碰，
      // 留在屏上的旧行继续按正常模板说话（失败时按点击位换 recycledTree 还会把活行筛没了）。
      setShownRecycled(inRecycled);
      setSelected([]);
      setSeq((s) => s + 1);
    } catch (e) {
      // D47-b 步4b：页码模式下失败**清行**（旧「失败不清行」的世界随本地过滤一起退役了）：
      // 陈旧行 + 新 current 同屏就是「我在第几页」的两把尺子，与后端禁 cursor+current 同罪。
      // 故障仍然摊开说（loadError Alert），只是不再拿上一批行冒充当前页。
      setDefs([]);
      setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "接口列表加载失败");
    } finally {
      setLoading(false);
      setFirstLoaded(true);
    }
  }, [pid, inRecycled, advFilter, kw, moduleId, current, pageSize]);

  useEffect(() => { void load(); }, [load]);

  // D47-b 步4b：旧「子树 + 关键词过滤都在本地」的 visible useMemo 已整块删除——
  // 子树（module_ids 重复键）与关键词（keyword=）都下推到 SQL（步4a 落地、步4b 前端接线），
  // 表里画的就是服务端筛后的当前页；1A 时代「数百级本地过滤、服务端检索留给 1B」的前提
  // 随页码分页一并作废（后端已支持，没有 1B 要留了）。

  // 行徽标：逐行懒加载最近一次运行（每批 pageSize 行可接受，1B 换批量接口）
  const visibleIds = useMemo(() => defs.map((d) => d.id).join(","), [defs]);
  useEffect(() => {
    const ids = visibleIds ? visibleIds.split(",") : [];
    if (!ids.length) return;
    let cancelled = false;
    void (async () => {
      for (const id of ids) {
        if (cancelled) return;
        try {
          const r = await get<Page<RunRow>>("/runs?project_id=" + encodeURIComponent(pid)
            + "&subject_id=" + encodeURIComponent(id) + "&size=1", { silent: true });
          if (cancelled) return;
          const last = r.items[0];
          // env_name/created_at 必须带进 Badge：hover 的「时间+环境」（蓝图 :1376，D80）
          // 就靠这两个字段，此前拉回来了却在这里被扔掉。
          setBadges((prev) => ({ ...prev, [id]: last
            ? { status: last.status, code: last.status_code, elapsed: last.elapsed_ms, trigger: last.trigger,
                at: last.created_at ?? null, env: last.env_name ?? null }
            : { status: "none", code: null, elapsed: null, trigger: "", at: null, env: null } }));
        } catch {
          // 拉取失败必须落成可渲染的 unknown 态：silent:true 下这里没有 toast，
          // 留空（badges[id] 缺席）会让 BadgeCell 把「没取到」画成肯定的「未运行」。
          setBadges((prev) => ({ ...prev, [id]: { status: "unknown", code: null,
            elapsed: null, trigger: "", at: null, env: null } }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [visibleIds, pid, seq]);

  const moduleName = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (ns: ModNode[]) => ns.forEach((n) => { map.set(n.id, n.name); walk(n.children); });
    walk(tree); walk(recycledTree);
    return map;
  }, [tree, recycledTree]);

  function openEditor(target: ApiDef | "new") {
    setEditing(target); setResult(null);
    if (target === "new") {
      setDraft(toDraft(null));
      setForm({ name: "", path: "", module_id: moduleId, project_public: true });
    } else {
      setDraft(toDraft(target.request));
      setForm({
        name: target.name, path: target.path, module_id: target.module_id,
        project_public: target.project_public,
      });
    }
  }

  async function save(): Promise<void> {
    const name = form.name.trim();
    const pathv = form.path.trim();
    if (!name || !pathv) { message.warning("接口名与路径必填"); return; }
    setSaving(true);
    try {
      const req = fromDraft(draft);
      if (editing === "new") {
        await post<ApiDef>("/api-definitions", {
          project_id: pid, name, method: req.method, path: pathv, request: req,
          module_id: form.module_id, project_public: form.project_public,
        });
        message.success("接口已创建");
      } else if (editing) {
        const out = await patch<ApiDef>("/api-definitions/" + editing.id, {
          project_id: pid, name, path: pathv, request: req,
          module_id: form.module_id, version: editing.version,
        });
        message.success("已保存 v" + out.version);
      } else {
        return;
      }
      setEditing(null);
      await load();
    } catch { /* toast */ } finally { setSaving(false); }
  }

  async function debugDraft(): Promise<void> {
    setDebugging(true);
    try {
      const editingId = editing && editing !== "new" ? editing.id : null;
      const r = await post<DebugResult>("/api-debug", {
        project_id: pid, request: cleanRequest(fromDraft(draft)), env_id: envId,
        // 编辑既有接口时跑的是未保存草稿：记录仍挂在接口名下，列表徽标才会亮
        ...(editingId ? { subject_definition_id: editingId } : {}),
      });
      setResult(r);
      await load();
    } catch { /* toast */ } finally { setDebugging(false); }
  }

  // 回收被场景引用 409（D86）：details 点名引用者，摆成拦截弹窗而不是只留一句 toast；
  // 拦截 DOM 与用例侧共用 CaseList.tsx 导出的 ScenarioRefsBlockModal（同一套错误词汇）。
  const [defBlock, setDefBlock] = useState<{ def: ApiDef; details: ScenarioBlockDetails } | null>(null);
  const [defBlocking, setDefBlocking] = useState(false);

  async function doRemoveDef(d: ApiDef, force: boolean): Promise<boolean> {
    try {
      await post("/api-definitions/" + d.id + "/delete", { project_id: pid, ...(force ? { force: true } : {}) });
      message.success(force ? "已放入回收站（引用它的场景步骤会当场解析失败）" : "已放入回收站");
      if (detail?.id === d.id) setDetail(null);
      await load();
      return true;
    } catch (e) {
      // 被场景引用的 409 是保护不是失败：details.scenarios 里点名了是谁（services._blocked_definition）
      const blk = scenarioBlockOf(e);
      if (blk && !force) setDefBlock({ def: d, details: blk });
      return false;
      // 其余错误 client 已 toast
    }
  }

  // D251：批量回收。全有或全无的判据在后端，前端只把 409 的 blocked 清单翻译成人话，
  // 不给「批量 force」——强删必须逐个过一段确认（后端同样没有这个参数）。
  const [batchRemoving, setBatchRemoving] = useState(false);
  async function doBatchRemove(): Promise<void> {
    setBatchRemoving(true);
    try {
      await post("/api-definitions/batch-delete",
        { project_id: pid, definition_ids: selected });
      message.success("已放入回收站（" + selected.length + " 个接口）");
      setSelected([]);
      await load();
    } catch (e) {
      const blk = (e instanceof ApiErr
        ? (e.details as { blocked?: { name: string; count: number }[]; reason?: string } | null)
        : null)?.blocked;
      if (blk && blk.length > 0) {
        Modal.error({
          centered: true,
          title: "整批未删除：有接口被场景引用",
          content: (
            <div>
              <p>{blk.map((b) => b.name + "（" + b.count + " 个场景）").join("、")}</p>
              <p>整批一行未动。请先在场景里解除引用；确认要连带断掉场景步骤时，请逐个回收。</p>
            </div>
          ),
        });
      }
      // 其余错误 client 已 toast
    } finally { setBatchRemoving(false); }
  }
  function batchRemove() {
    Modal.confirm({
      centered: true,
      title: "将选中的 " + selected.length + " 个接口放入回收站？",
      content: "全有或全无：只要有一个接口被未回收场景引用，整批都不会删。"
        + "用例不删，restore 后原样回来。",
      okText: "放入回收站",
      okButtonProps: { danger: true },
      onOk: doBatchRemove,
    });
  }

  // D252：批量恢复。与批量回收同一个「全有或全无」判据，只是方向相反。
  const [batchRestoring, setBatchRestoring] = useState(false);
  async function doBatchRestore(): Promise<void> {
    setBatchRestoring(true);
    try {
      await post("/api-definitions/batch-restore",
        { project_id: pid, definition_ids: selected });
      message.success("已恢复（" + selected.length + " 个接口）");
      setSelected([]);
      await load();
    } catch { /* client 已 toast；弹窗关闭，选择保留让用户改名单 */ }
    finally { setBatchRestoring(false); }
  }
  function batchRestore() {
    Modal.confirm({
      centered: true,
      title: "恢复选中的 " + selected.length + " 个接口？",
      content: "全有或全无：只要有一个不在回收站，整批都不会恢复。"
        + "恢复后有请求内容的回到「已完成」，没请求内容的回到「草稿」。",
      okText: "恢复",
      onOk: doBatchRestore,
    });
  }

  function removeDef(d: ApiDef) {
    Modal.confirm({
      centered: true,
      title: "接口放入回收站？",
      // D131：后端只把定义置为 recycled（services.py:275），用例一行都不动——不进回收站、
      // 正常列表里还在，只是所属接口回收期间执行/调试一律 404（services.py:393-394
      // 「用例所属接口在回收站」），恢复接口后原样回来。旧文案「跟着接口一起进回收站」
      // 承诺了后端没做的事。
      content: "「" + d.name + "」的用例不会删，也不会跟着进回收站：接口回收期间它们不可用，恢复接口后原样回归。"
        // 「点名是哪些场景」只对了一半：api_test/services.py:236 的 hidden 分支（无
        // scenario:read）只报数量、刻意不点名。可达路径：D37 自定义角色可只带
        // api:def:delete 而不带 scenario:read。文案按两条分支都给得出的下限说。
        + "其未回收用例若被场景引用会拒绝回收，并给出引用情况（引用明细要 scenario:read 才看得到）。",
      okText: "放入回收站", okButtonProps: { danger: true }, cancelText: "取消",
      onOk: async () => { await doRemoveDef(d, false); },
    });
  }

  // force 第二步：只从拦截弹窗进来（明细可见才给这扇钮）。后端在明细被隐瞒时
  // 连 force 一起拦（services.py:243），所以 hidden 分支的弹窗根本不摆这个按钮。
  async function forceRemoveDef(): Promise<void> {
    if (!defBlock) return;
    setDefBlocking(true);
    try {
      if (await doRemoveDef(defBlock.def, true)) setDefBlock(null);
    } finally { setDefBlocking(false); }
  }

  async function restoreDef(d: ApiDef): Promise<void> {
    try {
      await post("/api-definitions/" + d.id + "/restore", { project_id: pid });
      message.success("已恢复");
      await load();
    } catch { /* toast */ }
  }

  async function purgeDef(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      await post("/api-definitions/" + purge.id + "/purge", { project_id: pid, confirm_name: purge.name });
      message.success("已彻底删除，接口名可以重新使用");
      setPurge(null); setPurgeName("");
      await load();
    } catch { /* toast 已在 client 里弹；保持弹窗打开，让用户改名字重试或放弃 */ } finally {
      setPurging(false);
    }
  }

  const refs = varRefs(fromDraft(draft));

  // 列设置：入口在 ListToolbar 左组（lt-cols），落盘/读盘在 useColumnPrefs，本页只做
  // 「把 hidden 集套到 columns 上」这一件事。此前它挂在 ProTable 的 options.setting 上，
  // ProTable 为此在卡片顶边自造一条 48px 空工具栏，只放一个 16px 齿轮——全站只有本页开
  // options，所以只有本页出现这条孤栏（1280 宽时齿轮正好落在「接口」列表头正上方）。
  const [colPref, setColPref] = useColumnPrefs("api", API_COL_CHOICES.map((c) => c.key));

  return (
    /* 满高页：外层 .tp-fill-stack 算到内容区底，页头有几行吃几行，正文（.tp-fill）拿
       剩下的。不用 tp-fill--head：它按 metrics 的 56px 扣页头，而本页页头带 desc 会折
       到 86px，扣少了就凭空多出一条 18px 的整页竖滚（见 styles.css 那段）。
       此前这里根本没有满高约束，表格卡 min-height 实测 0px 纯内容撑高——空项目时一张
       295px 的小卡浮在 915px 视口里（下方空 414px = 45%），有数据时又长出一条竖滚，
       同一页的版式跟着数据变。 */
    <div className="tp-fill">
      {/* wrap={false}：antd Row 默认 flex-wrap: wrap，而**多行**弹性容器的行高按内容算
          （align-content 只在有余量时才补，20 行时是 −725 的负余量）。于是整行的交叉轴
          尺寸跟着表格内容走：行 729 高、右列实测 1454，卡里根本不存在「剩余高度」，
          min-height:0 那条链在第一环就断了——20 行时表格卡长到 1366、整页滚到 1617
          （视口 915），分页器掉到 1616。关掉换行后行回到单行模式，交叉轴用容器自身的
          确定高度 729，卡 641、正文内滚 725/1364、分页器钉在 891、整页 915/915。 */}
      <Row gutter={16} wrap={false} style={{ flex: "1 1 auto", minHeight: 0 }}>
        {/* 288 与 scenes.tsx:451 的模块树同宽（此前 208）：模块名是用户起的中文长句，
            208 下二级模块普遍截断；两棵树的省略口径应该一致。 */}
        {/* 列本身吃满行高；卡的高度上下界都由 styles.css 管——.tp-fill .ant-col > .ant-card
            封顶（max-height:100%，展开到 31 个节点时在列里内滚）+ .tp-fill-side 拉满
            （与右卡同底，短树不再 112 对 641）。这里不写 alignSelf: flex-start——那一行会让
            列高变成「随内容」，卡的 max-height:100% 就没有确定基准可解，实测 896 的树卡照样
            溢出 167px 把整页顶滚。 */}
        <Col flex="288px" className="tp-fill-side">
        <Card size="small">
          <ModuleTree
            projectId={pid} tree={tree} recycled={recycledTree}
            inRecycled={inRecycled} onToggleRecycled={(v) => patchFilters({ inRecycled: v })}
            selected={moduleId} onSelect={(id) => patchFilters({ moduleId: id })}
            onChanged={() => void load()}
            canManage={canDelete} canCreate={canCreate}
            // 树与列表在同一把 Promise.all 里，失败时两边一起停：不传给树的话，
            // 回收站视图会在「没取到」时画一句「回收站是空的」。
            loadError={loadError}
          />
        </Card>
      </Col>
      {/* minWidth: 0 是必需的：flex 项的 min-width:auto 会拿内容的 min-content 当下限，
          表就压不进这一列、只能把列撑宽（内滚也就无从谈起）。基准值 0/auto 实测无差别
          （1180 宽下 bodyW 都是 642），折行这件事由上面的 wrap={false} 兜住——
          此前这里靠 `1 1 0` 防折行（2026-11-22 截图：右列整块折到下一行横跨全宽），
          现在两道闸都在，留着 0 只是让它不必去解内容基准。
          右栏与左栏同构（.tp-fill-side）：一张吃满列高的面板卡，筛选条 / 表 / 页码
          三段都住在这张卡里，于是左右两栏共用上下两条边。此前这三段是列的裸子项，
          卡只有 677、列 765，上下各缩 44/44——同一页里两套容器语义。
          .tp-fill-body 挂在列上：满高表格卡那串 flex 链（styles.css）按后代选择器命中，
          搬进卡里不改一行。 */}
      <Col flex="1 1 0" className="tp-fill-body tp-fill-side" style={{ minWidth: 0 }}>
        <Card size="small" styles={{ body: { padding: 0 } }}>
        <div style={{ padding: "12px 12px 0", flex: "0 0 auto" }}>
        {/* D47-a 三件套（视图 / 高级搜索 / 列设置）。关键词框保留在 extra 里：D47-b 步4b 起
            它不再是本地子串，而是把已提交关键词以 keyword= 打到后端（name OR path 的
            SQL LIKE，大小写/声调不敏感由后端负责）；与高级搜索仍是两个入口，各打各的参数，
            不互相替代——MS 也是「快捷搜索 + 高级搜索」并存。 */}
        <ListToolbar
          projectId={pid} viewType="api"
          filter={advFilter} onFilterChange={(f) => patchFilters({ advFilter: f })}
          valueOptions={filterValueOptions}
          allColumns={API_COL_CHOICES} columnPref={colPref} onColumnPrefChange={setColPref}
          canSaveView={can(perms, "search:view:create")}
          canDeleteView={can(perms, "search:view:delete")}
          extra={(<>
          {/* 关键词是服务端契约：打字只动 qText（受控现值），提交才进 load 依赖（kw）。
              提交口恰好三个：Enter、放大镜钮、allowClear 清空——antd 5.29 的 Input.Search
              把三条路径都汇进 onSearch（Search.js：clear 图标点击也以 source:'clear' 触发它）。
              第一个入参是 antd 给的当前值（clear 路径上是空串），不读闭包里的 qText——
              onChange 里**绝不**发请求。空/纯空白提交 = 不带 keyword 参数。 */}
          <Input.Search data-testid="api-search" allowClear style={{ width: 180 }}
            placeholder="搜索接口名或路径" value={qText}
            onChange={(e) => setQText(e.target.value)}
            onSearch={(v) => patchFilters({ kw: v.trim() })} />
          <EnvSelect projectId={pid} value={envId} onChange={setEnvId} width={170}
            canManage={can(perms, "env:config:update")} canCreate={can(perms, "env:config:create")} />
          <Tooltip title="刷新"><Button icon={<ReloadOutlined />} aria-label="刷新"
            data-testid="api-reload" onClick={() => void load()} /></Tooltip>
          {canCreate && !inRecycled && (
            <Tooltip title="导入">
              <Button icon={<ImportOutlined />} aria-label="导入"
                data-testid="api-import" onClick={() => setImportOpen(true)} />
            </Tooltip>
          )}
          {canRead && !inRecycled && (
            <Tooltip title="全量导出">
              <Button icon={<ExportOutlined />} aria-label="全量导出" data-testid="api-export"
                loading={exporting} onClick={() => void exportDefs(null)} />
            </Tooltip>
          )}
          {canCreate && !inRecycled && (
            <Button type="primary" icon={<PlusOutlined />} data-testid="api-new"
              onClick={() => openEditor("new")}>新建接口</Button>
          )}
          </>)}
        />
        {/* 批量条（1E T5 补完）：选中才出现，[导出选中] 把 ids 原样带进 /api-export；
            全量导出走顶栏独立按钮，两者不共用一个按钮位，杜绝「以为选了其实全量」。
            D252：回收站里同一条子变成 [批量恢复]——彻底删除仍要求逐字确认名称，不做批量。 */}
        {canRead && !inRecycled && selected.length > 0 && (
          <Space style={{ marginBottom: 12 }} data-testid="api-batch-bar">
            <Typography.Text>已选 {selected.length} 项</Typography.Text>
            <Button size="small" type="primary" ghost icon={<ExportOutlined />} data-testid="api-export-selected"
              loading={exporting} onClick={() => void exportDefs(selected)}>导出选中</Button>
            {canDelete && (
              <Button size="small" danger icon={<DeleteOutlined />} data-testid="api-batch-delete"
                loading={batchRemoving} onClick={batchRemove}>批量回收</Button>
            )}
            <Button size="small" data-testid="api-clear-selection" onClick={() => setSelected([])}>取消选择</Button>
          </Space>
        )}
        {canUpdate && inRecycled && selected.length > 0 && (
          <Space style={{ marginBottom: 12 }} data-testid="api-batch-bar">
            <Typography.Text>已选 {selected.length} 项</Typography.Text>
            <Button size="small" type="primary" icon={<ReloadOutlined />} data-testid="api-batch-restore"
              loading={batchRestoring} onClick={batchRestore}>批量恢复</Button>
            <Button size="small" data-testid="api-clear-selection" onClick={() => setSelected([])}>取消选择</Button>
          </Space>
        )}
        {/* 刻意不给 ×：与 scenes/uiCases 同口径——关掉这条会把「接口没取到」擦成
            「还没有接口，点右上角新建」，还能把上一批旧行说成「共 N 条」。 */}
        {loadError && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="api-def-load-error"
            message="接口列表加载失败" description={loadError} />
        )}
        </div>
        <AdminTable<ApiDef> rowKey="id" loading={loading} dataSource={defs}
          className="tp-inpanel"
          // 列设置在工具条（allColumns/columnPref 三个 props），不走 ProTable 的
          // options.setting：那会让 ProTable 在卡片顶边多造一条只放一个齿轮的空工具栏。
          options={false}
          rowSelection={(!inRecycled && canRead) || (inRecycled && canUpdate) ? {
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys.map(String)),
            preserveSelectedRowKeys: false,
          } : undefined}
          locale={{ emptyText: loadError ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="接口列表没取到，以上方的加载失败提示为准" />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
              // D134（api 站点，台账「复用 D134」）：表渲染的就是服务端筛后的那一页，
              // 空表只说明「当前条件下后端没给行」。归因链照真实筛选态走：高级搜索排最前
              // （打到后端的那一层不摘掉，关键词与模块怎么调都是空）；有关键词怪关键词；
              // 只剩模块筛选怪模块（未分类行 module_id=null，摘掉模块筛选即在「全部接口」里看见）。
              // D47-b 续：归因读的全是**已提交**的筛选（kw 不是 qText、模块子树、advFilter）——
              // 输入框里没敲回车的那半截关键词不许替用户背锅。
              description={shownRecycled ? "回收站是空的"
                : hasAdv ? "当前高级搜索条件筛掉了全部接口（点上方条件条可清空）"
                  : kw.trim() ? "没有匹配的接口，换个关键词试试"
                    : moduleId ? "这个模块下没有接口（换个模块或看「未分类」）"
                      // 「点右上角新建」指向的钮在 canCreate && !inRecycled 之后（:360）：
                      // 无 api:def:create 的人那里它压根不在 DOM，指路就是假门。
                      // 句式与 uiCases.tsx:180 / adbCases.tsx:146 同一套。
                      // 真分支整串是 e2e api.spec.mjs:12 的契约，不许动。
                      : canCreate ? "还没有接口，点右上角新建" : "还没有接口（你没有新建权限）"} />
          ) }}
          // 998 = 其余固定列 746 + 选择列 32 + 「接口」列下限 220（下面那列刻意不给 width）。
          // fixed：auto 布局会把超出 998 的部分按比例摊给每一列，实测 1680 视口下 8 列各涨
          // 12.7%（方法 80→90、最近结果 104→117、操作 158→178）——盈余落在短列就成了空隙。
          tableLayout="fixed"
          scroll={{ x: 998 }}
          columns={applyColumnPrefs([
            // 「接口」是表里唯一可伸缩的列：table-layout: fixed 下不给 width 就是「吃掉其余
            // 固定列之外的全部」，窄到 998 时拿到 998−746−32=220 的下限，1680 视口实测 346。
            // 写死 220 的话盈余就只会去摊别的列（见上面 tableLayout 注释）。加/删列要同步 998。
            { key: "name", title: "接口", dataIndex: "name", render: (v: string, r) => (
              <Space direction="vertical" size={0}>
                <a data-testid="api-row" onClick={() => setDetail(r)}>{v}</a>
                <Typography.Text type="secondary" className="tp-mono tp-text-sm" ellipsis
                  style={{ maxWidth: "100%" }} title={r.path}>
                  {r.path}
                </Typography.Text>
              </Space>
            ) },
            { key: "method", title: "方法", dataIndex: "method", width: 80, render: (v: string) => (
              <Tag data-testid="api-method" color={METHOD_TAG[v] ?? "default"}>{v}</Tag>) },
            { title: "模块", key: "mod", width: 100, render: (_, r) => (
              r.module_id ? <Tag>{moduleName.get(r.module_id) ?? "已回收模块"}</Tag>
                : <Typography.Text type="secondary">—</Typography.Text>) },
            { key: "status", title: "状态", dataIndex: "status", width: 88, render: (v: string) => {
                const t = STATUS_TAG[v] ?? { color: "default", label: v };
                return <Tag data-testid="api-status" color={t.color}>{t.label}</Tag>;
              } },
            // 负责人 / 更新时间（蓝图 :1376，D79 可自决半条）：名字来自后端 join app_user
            // 的 owner_name（前端拉成员表换名字在权限上就是错的——/members 要 ensure_member）。
            // 宽度按实测内容下限：owner_name 最长是「演示项目管理员」7 字 = 94px（含 16 内边距），
            // 90 会在 1440 宽（实测列被压到 87）折成两行、行高 86→108。
            { title: "负责人", key: "owner", width: 96, render: (_, r) => (
              // owner_id 为 null = 真没填负责人 →「—」；owner_id 有值但名字查不到（账号已删）
              // 说「已删除 <短id>」——查不到人 ≠ 没人负责，画「—」会把悬空负责人伪装成空缺。
              <span data-testid="api-row-owner">{!r.owner_id ? "—"
                : r.owner_name ?? ("已删除 " + r.owner_id.slice(0, 8))}</span>) },
            { title: "更新时间", key: "upd", width: 120, render: (_, r) => (
              // 换算走 shared/timefmt（§3.4-6：UTC 存 / Asia/Shanghai 展示）；
              // 截 ISO 字符串是 ledger R68 记过的 UTC 钟点假绿，禁止。
              // 120 = 实测「2026-11-20 11:11」102px + 16 内边距（128 是凭手感给的，多出的 8px
              // 在这一列没有任何用处：内容是定长的）。
              <Typography.Text className="tp-text-sm" type="secondary" data-testid="api-row-updated">
                {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
              </Typography.Text>) },
            // 104 的下限来自 run-badge-unknown 那句「运行记录没取到」（实测 84px + 16）：
            // 它是诚实口径的一部分，折行会把「没取到」说成半句话。
            { title: "最近结果", key: "badge", width: 104, render: (_, r) => <BadgeCell b={badges[r.id]} /> },
            // 158 = 回收站视图实测下限（恢复 66 + 彻底删除 72 + 4 间距 + 16 内边距 = 158）。
            // 原计划砍到 118 把盈余给「接口」列，实测否掉了：118 会让两个按钮折成两行，
            // 回收站整行 86→108，而活行的按钮只有 76px——列宽得按最宽的那个视图给。
            { title: "", key: "ops", width: 158, hideInSetting: true, render: (_, r) => (
              // D180：行身份逐行认 r.status，不认视图旗标——视图翻转与 refetch 之间那截窗口里
              // （以及取数一直失败期间）屏上还是活行，「彻底删除」长到活行上不是样式错，
              // 是给用户一个物理删除活接口的按钮。权限位分工不动（canUpdate/canDelete）。
              r.status === "recycled"
                ? (
                  <Space size={4}>
                    {canUpdate && (
                      <Button size="small" icon={<UndoOutlined />} data-testid="api-restore"
                        onClick={() => void restoreDef(r)}>恢复</Button>
                    )}
                    {canDelete && (
                      <Button size="small" danger data-testid="api-purge" onClick={() => setPurge({ id: r.id, name: r.name })}>
                        彻底删除
                      </Button>
                    )}
                  </Space>
                )
                : (
                  <Space size={4}>
                    <Button size="small" data-testid="api-detail" onClick={() => setDetail(r)}>详情</Button>
                    {canDelete && (
                      <Tooltip title="放入回收站">
                        <Button size="small" danger type="text" icon={<DeleteOutlined />}
                          data-testid="api-delete" aria-label={"删除-" + r.name} onClick={() => removeDef(r)} />
                      </Tooltip>
                    )}
                  </Space>
                )
            ) },
          ], colPref)}
        />
        {/* 页脚小字与分页器同一行：满高页的纵向是稀缺资源，这一行口径此前单独吃掉
            18px 行高 + 12 间距。grid 的最小宽度写死 0（不是 auto），左栏放不下就省略号，
            不许把中间的分页器挤走；分页器因此仍精确居中，与其余列表页同形。 */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)", alignItems: "center", gap: 8, padding: "12px 12px", flex: "0 0 auto" }}>
          <Typography.Text className="tp-text-sm" type="secondary"
            style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {/* D47-b 步4b：hasMore 那句「本页取到 N 条（单页上限 200，后面还有没取的）」随游标
                世界退役——页码模式下下一页永远点得到，「还有没取的」不再是脚注能说的事。
                失败路径清行清 total（load 的 catch），这句只说「计数不作数」，
                上一批行与陈旧「共 N」都不再留在屏上冒充当前页。 */}
            {loadError ? "本次列表加载失败，本行计数不作数" : ""}
            {/* 「选中模块」四个字的口径随徽标一起改了：徽标与列表如今都是子树口径
                （步4a 徽标卷算 + 步4b module_ids 带上全部子孙，subtreeIds 的注释记着这笔账），
                这句只说「你选了哪个模块」，不承诺直属/子树——两个口径下它都是真话。 */}
            {moduleId ? "（选中模块）" : ""}{shownRecycled ? " · 回收站视图" : ""}
          </Typography.Text>
          <ListPager
            current={current}
            pageSize={pageSize}
            total={total}
            onPage={setCurrent}
            onPageSize={setPageSize}
          />
        </div>
        </Card>
      </Col>

      {/* 全屏编辑器：左基本信息 360 + 右请求编辑器 + 下方调试面板（§11.4.2） */}
      <Drawer
        open={editing !== null} onClose={() => setEditing(null)} width="100%" destroyOnHidden
        title={editing === "new" ? "新建接口" : editing ? "编辑接口 · v" + editing.version : "编辑接口"}
        extra={(
          <Space>
            {canDebug && (
              <Button data-testid="api-debug" loading={debugging} onClick={() => void debugDraft()}>调试</Button>
            )}
            {/* 保存是表单控件不是权限入口：进编辑器的两条路（新建/详情编辑）已按 create/update 隐藏，
                可达即有写位；藏掉提交钮反而残缺表单（§11.5.1 的「隐藏」管的是入口，不是提交）。 */}
            <Button type="primary" data-testid="api-save" loading={saving}
              disabled={!canCreate && !canUpdate} onClick={() => void save()}>保存</Button>
          </Space>
        )}
      >
        <Row gutter={16}>
          <Col flex="360px">
            <Space direction="vertical" style={{ width: "100%" }} size={12}>
              <div>
                <Typography.Text type="secondary">接口名</Typography.Text>
                <Input data-testid="def-name" maxLength={200} value={form.name} placeholder="如：查询订单"
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Typography.Text type="secondary">路径（展示用，实际执行用右侧 URL）</Typography.Text>
                <Input data-testid="def-path" maxLength={500} className="tp-mono" value={form.path}
                  placeholder="/order/{id}" onChange={(e) => setForm({ ...form, path: e.target.value })} />
              </div>
              <div>
                <Typography.Text type="secondary">所属模块</Typography.Text>
                <Select allowClear data-testid="def-module" style={{ width: "100%" }}
                  value={form.module_id ?? undefined} placeholder="未分类"
                  options={flatten(tree)} onChange={(v) => setForm({ ...form, module_id: v ?? null })} />
              </div>
              {editing === "new" && (
                <Space>
                  <Switch data-testid="def-public" checked={form.project_public}
                    onChange={(v) => setForm({ ...form, project_public: v })} />
                  <Typography.Text type="secondary">项目内公开（关掉后仅自己与项目管理员可见）</Typography.Text>
                </Space>
              )}
              {refs.length > 0 && (
                <Card size="small" title="用到的变量">
                  <Space size={4} wrap>
                    {refs.map((v) => (
                      <Tooltip key={v} title="取值来自所选环境；同名时请求内写死优先">
                        <Tag data-testid="def-varref">{"$" + "{" + v + "}"}</Tag>
                      </Tooltip>
                    ))}
                  </Space>
                </Card>
              )}
              <Typography.Text className="tp-text-sm" type="secondary">
                断言为空时调试只发请求不判定，建议至少加一条状态码断言。
              </Typography.Text>
            </Space>
          </Col>
          {/* flex 基准必须是 0：`auto` 会拿表格内容的 max-content 当基准，208+宽表 > 行宽，
          antd Row 的 flex-wrap 就把右列整块折到下一行、横跨全宽（2026-11-22 截图实测）。 */}
      <Col flex="1 1 0" style={{ minWidth: 0 }}>
            <RequestEditor value={draft} onChange={setDraft} />
            {/* 「让 Pilot 分析」的对象名：编辑既有接口用定义名，新建只有用户此刻填的名；
                两处都为空时 DebugPanel 拿到假值 → 钮不渲染（不给点了没内容的假门）。 */}
            <DebugPanel result={result}
              subject={form.name.trim() !== "" ? form.name.trim() : null}
              requestLine={draft.url.trim() === "" ? null : draft.method + " " + draft.url.trim()} />
          </Col>
        </Row>
      </Drawer>

      {/* 详情抽屉：定义（只读 + 就地调试）/ 用例(N) / 场景引用(N)（D69，§11.4.3） */}
      <Drawer open={detail !== null} onClose={() => { setDetail(null); setDeepCase(false); }}
        width="min(70vw, 1000px)" destroyOnHidden
        title={detail ? detail.name : ""}
        extra={detail && (
          <Space>
            {/* 编辑既有定义走 PATCH（api:def:update），入口按同一位隐藏而非禁用（§11.5.1） */}
            {canUpdate && (
              <Button type="primary" ghost data-testid="detail-edit" icon={<EditOutlined />}
                onClick={() => openEditor(detail)}>编辑</Button>
            )}
            {canShare && detail && (
              <ShareButton projectId={pid} targetType="api_doc" targetId={detail.id}
                title={detail.name} />
            )}
            {canDelete && !inRecycled && (
              <Button danger data-testid="detail-delete" icon={<DeleteOutlined />}
                onClick={() => removeDef(detail)}>回收站</Button>
            )}
          </Space>
        )}
      >
        {detail && (
          <DetailBody def={detail} envId={envId} canDebug={canDebug} perms={perms}
            initialTab={deepCase ? "case" : "def"} onChanged={() => void load()} />
        )}
      </Drawer>

      {/* 彻底删除：不可逆，§11.4.18 要求「输名称确认」；服务端同样硬校验，不靠前端拦 */}
      <Modal centered
        open={purge !== null} onCancel={() => { setPurge(null); setPurgeName(""); }}
        destroyOnHidden width={520}
        title="彻底删除接口？" okText="我已确认，彻底删除" cancelText="取消"
        okButtonProps={{ danger: true, "data-testid": "purge-ok", disabled: purgeName !== (purge?.name ?? ""), loading: purging }}
        onOk={() => void purgeDef()}
      >
        <Typography.Paragraph>
          「{purge?.name}」及其
          <Typography.Text strong>全部用例</Typography.Text>
          将被物理删除，
          <Typography.Text strong>无法恢复</Typography.Text>；运行记录会保留（历史不追删）。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          输入接口名 <Typography.Text code>{purge?.name}</Typography.Text> 以确认。
        </Typography.Paragraph>
        <Input data-testid="purge-confirm" value={purgeName} autoFocus
          placeholder={purge?.name} onChange={(e) => setPurgeName(e.target.value)} />
      </Modal>

      {/* 回收被场景引用 409（D86）：点名引用者与命中步骤；明细可见才给 force 第二步。
          文案照抄后端 services._blocked_definition 的语义，不改口径。 */}
      <ScenarioRefsBlockModal
        subject={defBlock?.def.name ?? ""}
        details={defBlock?.details ?? null}
        testid="api-scenario-block"
        busy={defBlocking}
        maySeeRefs={can(perms, "scenario:read")}
        blurb="回收不会删除用例，但用例随接口整体不可达，这些步骤会当场解析失败（restore 后原样回来）；也可先在场景里改引用。"
        onCancel={() => setDefBlock(null)}
        onForce={() => void forceRemoveDef()}
      />

      {/* 导入向导（1E T4，§11.4.6）：三步 Steps；完成或关闭都刷一次列表 */}
      <ImportWizard projectId={pid} open={importOpen} onClose={() => setImportOpen(false)}
        onImported={() => void load()} />
      </Row>
    </div>
  );
}

/** 详情抽屉内容：定义只读渲染 + 就地调试；用例 Tab 复用 CaseList 并把数量回填到 Tab 文案。 */
function DetailBody({ def, envId, canDebug, perms, initialTab = "def", onChanged }: {
  def: ApiDef; envId: string | null; canDebug: boolean; perms: string[];
  initialTab?: "def" | "case" | "refs"; onChanged: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [rows, setRows] = useState<number | null>(null);
  const [dbg, setDbg] = useState<DebugResult | null>(null);
  const [running, setRunning] = useState(false);
  // 保存为用例（D81，蓝图 :1379）：按钮只在调试真出结果后出现（没跑过就没有
  // 「刚调试出来的请求」可存），且按 api:case:create 走隐藏派（D47 口径）。
  const canCreateCase = can(perms, "api:case:create");
  // 接口自带的断言条数：用例断言是**追加**在这些之后判定的（后端 case_services.py:37-41），
  // 不是替换。弹窗要说「这条用例会判几条」，只能从这里算，不能假定「0 条 = 未校验」。
  // D132：引擎对 `enabled is False` 的行不执行、不产结果行（shared/assertions.py:150-158，
  // D78 为防假绿刻意选的语义），编辑器开关（RequestEditor.tsx 的 -assert-enabled-）关掉
  // 一行它就真不判。所以「判几条」只数启用的行；未启用的单独点名报出去，不静默吞掉——
  // 计数与引擎两头必须说同一句话。
  const defAssertions = def.request?.assertions ?? [];
  const defAssertCount = defAssertions.filter((a) => a.type && a.enabled !== false).length;
  const defAssertDisabled = defAssertions.filter((a) => a.type && a.enabled === false).length;
  const [caseModal, setCaseModal] = useState(false);
  const [caseName, setCaseName] = useState("");
  const [caseSaving, setCaseSaving] = useState(false);
  // 场景引用（D69，§11.4.3 第三个 Tab）：GET /scenario-references 按 definition_id 查。
  // 真实响应只有 items（scenario_id/scenario_name/step_keys）——该端点自己 require
  // scenario:read，无权直接 403，线上不存在「明细被隐藏但数量照报」那种形状（那是
  // 内部件 scenario_case_refs 的 details_hidden，不暴露 HTTP）。所以「拉失败」必须
  // 落成可见错误 + 重试（照 adbCaseDetail 的引用区手法），绝不退化成「无引用」——
  // 查不到是谁 ≠ 没人引用（§13 纪律 1）。
  const [refs, setRefs] = useState<components["schemas"]["ScenarioReferencesOut"] | null>(null);
  const [refsError, setRefsError] = useState<string | null>(null);

  async function loadRefs(): Promise<void> {
    setRefsError(null);
    try {
      setRefs(await sceneApi.references({ project_id: def.project_id, definition_id: def.id }));
    } catch (e) {
      setRefsError(e instanceof ApiErr ? e.message : "引用清单没拉到");
    }
  }
  // 只在切到该 Tab 时拉一次（与「用例(N)」计数同款：拿到数之前 Tab 上不显示括号）；
  // 失败后不自动重拉（refsError 已可见），重试走按钮。
  useEffect(() => {
    if (tab === "refs" && refs === null && refsError === null) void loadRefs();
    // refs/refsError 只在「首次进入且无结果」时参与判断，刻意不进依赖：拉过一次就不自动重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function runDebug(): Promise<void> {
    setRunning(true);
    try {
      const r = await post<DebugResult>("/api-debug", {
        project_id: def.project_id, definition_id: def.id, env_id: envId,
      });
      setDbg(r);
      onChanged();
    } catch { /* toast */ } finally { setRunning(false); }
  }

  // 保存为用例（D81，蓝图 :1379「调试按钮 → 响应面板 + [保存为用例]」）。
  // payload 口径逐字照 CaseList.save() 的新建分支（覆盖层语义的唯一实现处）：
  // · request=null = 「完全继承接口」——不预填任何覆盖键。新建入口的弹窗本就
  //   「打开即全继承」（CaseList.tsx:167 注释），这里连编辑请求的机会都不给，
  //   更该是纯继承；把接口请求抄一份存进覆盖层，接口改了用例不跟，正是覆盖层
  //   语义最容易做错的地方（CaseList.tsx 文件头）。
  // · assertions=[] = 真话：定义调试跑的是接口自带断言，用例自己一条追加断言
  //   都没有。用例列的「追加断言 0 条」、调试面板的「未校验」不变量都不破。
  // · dataset_id=null：调试没有数据集概念，编一个绑定才是假门。
  // · priority=P2：与后端 CaseCreateIn 缺省同值；弹窗文案里说出去，创建后用例可改。
  async function saveAsCase(): Promise<void> {
    const v = caseName.trim();
    if (!v) { message.warning("用例名不能为空"); return; }
    setCaseSaving(true);
    try {
      await post("/api-cases", {
        project_id: def.project_id, definition_id: def.id, name: v, priority: "P2",
        request: null, assertions: [], dataset_id: null,
      });
      message.success("用例已创建");
      setCaseModal(false);
      // 当场可见：切到用例 Tab → CaseList 挂载自拉列表，计数经 onCount 回填 Tab 文案；
      // onChanged() 让父层列表（徽标）同步一次，与 CaseList.save() 成功后的动作对齐。
      setTab("case");
      onChanged();
    } catch { /* 4xx 原话 toast 在 client（ApiErr.message = 后端信封 message）；弹窗保持打开可改名重试 */ }
    finally { setCaseSaving(false); }
  }

  return (
    <div data-testid="api-detail-drawer">
      <Space style={{ marginBottom: 12 }} wrap>
        <Tag color={METHOD_TAG[def.method] ?? "default"}>{def.method}</Tag>
        <Typography.Text className="tp-mono">{def.path}</Typography.Text>
        <Tag color={(STATUS_TAG[def.status] ?? { color: "default", label: def.status }).color}>
          {(STATUS_TAG[def.status] ?? { color: "default", label: def.status }).label}
        </Tag>
        <Typography.Text type="secondary">v{def.version}</Typography.Text>
        {/* 「仅自己可见」是假话：visibility.py:13-25 的 _is_project_admin（系统管理员，
            或 perms 命中 api:*:delete / *:delete —— PROJECT_ADMIN 的 ["*","-system:*"] 正命中）
            全见私有行，本文件 :512 的开关文案说的才是同一套口径。 */}
        <Typography.Text type="secondary">
          {def.project_public ? "项目公开" : "私有（仅自己与项目管理员可见）"}
        </Typography.Text>
      </Space>
      <Space style={{ marginBottom: 12 }}>
        <Button size="small" type={tab === "def" ? "primary" : "default"}
          data-testid="detail-tab-def" onClick={() => setTab("def")}>定义</Button>
        <Button size="small" type={tab === "case" ? "primary" : "default"}
          data-testid="detail-tab-case" onClick={() => setTab("case")}>
          用例{rows != null ? "(" + rows + ")" : ""}
        </Button>
        <Button size="small" type={tab === "refs" ? "primary" : "default"}
          data-testid="detail-tab-refs" onClick={() => setTab("refs")}>
          场景引用{refs != null ? "(" + refs.items.length + ")" : ""}
        </Button>
      </Space>
      {tab === "def" && (
        <div data-testid="detail-def">
          <Space style={{ marginBottom: 12 }}>
            {canDebug && (
              <Button type="primary" data-testid="detail-run" loading={running}
                onClick={() => void runDebug()}>用当前环境调试</Button>
            )}
            <Typography.Text className="tp-text-sm" type="secondary">
              调试会发真实请求并记入运行记录，不会改动定义。
            </Typography.Text>
          </Space>
          <RequestEditor value={toDraft(def.request)} readOnly />
          <DebugPanel result={dbg} subject={def.name}
            requestLine={def.request ? def.request.method + " " + def.request.url : null} />
          {/* [保存为用例]（D81，蓝图 :1379）：挂在响应面板之后，且 dbg != null 才出现——
              没跑过调试就没有「刚调试出的请求」可存，摆个死按钮是假门；
              无 api:case:create 时整个不渲染（D47 隐藏派）。 */}
          {dbg != null && canCreateCase && (
            <div style={{ marginTop: 12 }}>
              <Button size="small" type="primary" ghost icon={<PlusOutlined />}
                data-testid="detail-save-case"
                onClick={() => { setCaseName(def.name); setCaseModal(true); }}>保存为用例</Button>
              <Typography.Text className="tp-text-sm" type="secondary" style={{ marginLeft: 8 }}>
                把本次调试的请求存为该接口下的用例（完全继承接口请求，追加断言 0 条）。
              </Typography.Text>
            </div>
          )}
          <Modal centered open={caseModal} onCancel={() => setCaseModal(false)} destroyOnHidden width={480}
            title={"保存为用例 · 继承自「" + def.name + "」"}
            okText="创建" cancelText="取消"
            okButtonProps={{ "data-testid": "detail-save-case-ok", loading: caseSaving }}
            onOk={() => void saveAsCase()}>
            <div data-testid="save-case-modal">
              <Typography.Paragraph className="tp-text-sm" type="secondary">
                请求对象完全继承接口「{def.name}」（后续在用例编辑器里按键覆盖），追加 0 条断言，
                优先级默认 P2，可创建后编辑。
                <br />
                {defAssertDisabled > 0
                  // D132：接口有未启用的行时，「自带 N 条」和「没有自带断言」两句都不诚实——
                  // 前者把引擎不判的行计进「判 N 条」，后者在有 N 条停用行时仍是「未校验」的
                  // 巧合正确。逐数分开报：判几条只数启用，未启用点名说明引擎不执行不判。
                  ? `判定断言 = 接口启用 ${defAssertCount} 条 + 用例追加 0 条 = ${defAssertCount} 条；另有 ${defAssertDisabled} 条未启用，引擎不执行也不判${defAssertCount === 0 ? "——这条用例调试时会被如实标「未校验」" : ""}。`
                  : defAssertCount > 0
                    // 「未校验」那句话在接口自带断言时是假话：后端把用例断言**追加**在接口断言
                    // 之后一起判（case_services.py:37-41），所以判几条必须按接口实际条数说。
                    ? `判定断言 = 接口自带 ${defAssertCount} 条 + 用例追加 0 条 = ${defAssertCount} 条。`
                    : "该接口没有自带断言，用例也没追加——这条用例调试时会被如实标「未校验」。"}
              </Typography.Paragraph>
              <Input data-testid="save-case-name" maxLength={200} value={caseName}
                placeholder="用例名，如「已支付订单」" onChange={(e) => setCaseName(e.target.value)} />
            </div>
          </Modal>
        </div>
      )}
      {tab === "case" && (
        <div data-testid="detail-cases">
          <CaseList def={def} envId={envId} perms={perms} onCount={setRows} onChanged={onChanged} />
        </div>
      )}
      {/* 场景引用（D69，§11.4.3）：只读事实，渲染形状照 adbCaseDetail 的引用区。
          空态两种且必须可区分：items 真空 = 「还没有场景引用」；拉失败 = 错误原话 + 重试，
          绝不把「查不到」画成「没人引用」（后端 items 里没有任何「明细隐瞒」字段——该端点
          自己 require scenario:read，无权是 403 走错误分支，不是空列表）。 */}
      {tab === "refs" && (
        <div data-testid="detail-refs">
          {refsError != null ? (
            <Space size={6} data-testid="detail-refs-error">
              <Typography.Text className="tp-text-sm" type="secondary">引用清单没拉到：{refsError}</Typography.Text>
              <Button size="small" type="link" onClick={() => void loadRefs()}>重试</Button>
            </Space>
          ) : refs === null ? (
            <Typography.Text className="tp-text-sm" type="secondary">加载中…</Typography.Text>
          ) : refs.items.length === 0 ? (
            <Typography.Text className="tp-text-sm" type="secondary" data-testid="detail-refs-empty">
              还没有场景引用这个接口
            </Typography.Text>
          ) : (
            <ul className="tp-text-sm" style={{ margin: "2px 0 0", paddingLeft: 18 }}>
              {refs.items.map((it) => (
                <li key={it.scenario_id} data-testid="detail-ref">
                  <Typography.Link href={"#/scene/" + it.scenario_id}>{it.scenario_name}</Typography.Link>
                  {it.step_keys.length > 0 && (
                    <Typography.Text type="secondary">（步骤 {it.step_keys.join("、")}）</Typography.Text>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}


export default function ApiPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-api" className="tp-fill-stack">
      <PageHead title="接口管理" descHover
        desc="接口定义与其用例的统一入口：左侧模块树、右侧列表，命令行「调试」即产生运行记录。"
        extra={project ? (
          <Tooltip title={"当前项目：" + project.name}>
            <Tag data-testid="api-project">{project.name}</Tag>
          </Tooltip>
        ) : null} />
      <ProjectGate>{project ? <ApiWorkbench /> : null}</ProjectGate>
    </div>
  );
}
