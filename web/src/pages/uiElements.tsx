// 元素库页（T14，§11.4.11 / §11.5.4）：左 ui_module 树 + 右列表 + 新建弹窗 + 回收站三件套。
// 契约（nav.spec.mjs 钉死）：根节点 data-testid="page-ui-elements" + PageHead 标题「元素库」
// （每页恰好一个 .tp-page-title）。
// D47-b 步5d（照场景页 25862f3 / 用例页 992c3a5 同法，后端半边 = 222f843）：页码分页、
// 关键词、模块筛选全部下推到后端（current/size 页码、keyword 只打 name、module_ids 重复键），
// 本页不再「拉一页 200 条再本地过滤」。注意：模块口径与场景页同一条**直属**（ownModuleIds，
// 只发选中节点那一枚 id）：UI 树徽标至今是直属计数（ui_test/module_services.py 的 _counts
// docstring「count=直属未回收元素+用例」），单边把列表改成子树就是「徽标写 3、列表出 7」
// 那句 R120 明令避免的谎；子树化要后端徽标同刀改、业主先裁。
// 两条本模块特有的判断：
// ① 删除/改定位器不是失败是保护——后端对「被未回收 UI 用例引用」回硬 409
//   （R106；改定位器同拦见 D120），details.cases 就是用例清单，必须原样列出来
//   （含 details_hidden 的诚实分支）；
// ② 按钮按权限**隐藏不是禁用**（settings.spec 钉的手感：写入口一个都不渲染）。
// 树徽标读 count（元素+用例合计，ModuleTree 的徽标语义）；本页面自己不碰 count。
// 页码模式下行数不再是全量：落点横幅（Ctrl+K 的 ?q=<id>）的存在性改读详情接口作证，
// 不再拿「在不在当前页的行里」当「存不存在」（详见 hitId 一节注释）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert, Button, Card, Col, Input, Modal, Row, Select, Space, Switch, Table, Tag, Tooltip,
  Typography, message,
} from "antd";
import { DeleteOutlined, PlusOutlined, ReloadOutlined, UndoOutlined } from "../ui/icons";
import StateView from "../ui/StateView";
import { FilterBar } from "../ui/Toolbar";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr } from "../api/client";
import ModuleTree from "../api/ModuleTree";
import type { ModNode } from "../api/ModuleTree";
import { ownModuleIds } from "../shared/moduleTree";
import { uiApi, type ElementRefDetails, type ElementListInput, type UiElementListRow } from "../api/ui";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import type { components } from "../api/schema";

type Row = UiElementListRow;

// 定位方式词表 = 后端 ELEMENT_TYPES 全集（id/css/xpath/text/name，R100：§4.4 表 5 个，
// 第 6 种待业主点名 D2）。这里逐一对色，**不留词表外的键**——多一个 `test_id` 之类
// 的键就是给界面挂一个后端给不出的类型，读代码的人会以为它存在。
const LOCATOR_COLOR: Record<string, string> = {
  id: "green", css: "blue", xpath: "purple", text: "cyan", name: "orange",
};
const LOCATOR_OPTIONS = Object.keys(LOCATOR_COLOR).map((t) => ({ value: t, label: t }));

/** 生成物里 UiModuleNode 的可选字段比 ModNode 宽（?: string|null），归一一下。 */
function toMod(n: components["schemas"]["UiModuleNode"]): ModNode {
  return {
    id: n.id, parent_id: n.parent_id ?? null, name: n.name, sort: n.sort,
    status: n.status, count: n.count, children: n.children.map(toMod),
  };
}

function ElementsWorkbench() {
  const { project, user } = useAuth();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canCreate = can(perms, "ui:element:create");
  const canUpdate = can(perms, "ui:element:update");
  const canDelete = can(perms, "ui:element:delete");
  const canModCreate = can(perms, "ui:module:create");
  const canModDelete = can(perms, "ui:module:delete");

  const [rows, setRows] = useState<Row[]>([]);
  const [tree, setTree] = useState<ModNode[]>([]);
  const [recycledTree, setRecycledTree] = useState<ModNode[]>([]);
  const [inRecycled, setInRecycled] = useState(false);
  // D180：视图模板读 shownRecycled——只在取数成功那一刻跟行一起翻，失败不翻。
  // 模板不许在没拿到回收行时先换成回收站那套（说谎窗口）；行身份另有 r.status 逐行兜底。
  const [shownRecycled, setShownRecycled] = useState(false);
  const [moduleId, setModuleId] = useState<string | null>(null);
  // D47-b 步5d：输入框现值（qText）与**已提交**关键词（kw）分两个 state——打字只动 qText，
  // 进 load 依赖的是 kw。合并成一个的话打字逐字发 GET；提交口只有 Enter/放大镜/allowClear
  // 三处（scenes.tsx 步5b 同法，antd 5.29 的 Input.Search 把三条路径都汇进 onSearch）。
  const [qText, setQText] = useState("");
  const [kw, setKw] = useState("");
  // D47-b 步5d：页码分页（current/pageSize/total）替换「拉 200 条本地过滤」。默认档位 20
  // 在 ListPager 档位表（20/50/100）里、后端 size 上限（le=200）内。current 只有 pager 回调
  // 与 patchFilters 写，load 永不写它（一页只许有一个「我在第几页」的真相）。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  // 三类筛选（模块/已提交关键词/回收站开关）只有 patchFilters 这一个写入口，「回第 1 页」
  // 钉在唯一入口处——停在第 7 页改筛选，落的是新条件下无关的切片甚至空页
  // （listPagination.tsx 注释③同款 hazard）；各 setState 漏接一个回页没人拦得住。
  const patchFilters = useCallback((p: {
    moduleId?: string | null; kw?: string; inRecycled?: boolean;
  }): void => {
    if ("moduleId" in p) setModuleId(p.moduleId!);
    if ("kw" in p) setKw(p.kw!);
    if ("inRecycled" in p) setInRecycled(p.inRecycled!);
    setCurrent(1);
  }, []);
  const [loading, setLoading] = useState(false);
  // 取数失败与「项目里真的没有元素」必须分两句话说：把失败画成实测零，是把故障演成空数据
  // （同一句病灶在 adbCases.tsx 的 loadError 上已修；runs.tsx 写明 403 与网络故障都要摊开说）。
  const [loadError, setLoadError] = useState<string | null>(null);

  // Ctrl+K 直达落点（T12 的 ?q=<元素id>，R121）。
  // D47-b 步5d 的语义改变：页码模式后 rows 只是**当前页**，深链那条元素被筛选挡住或在
  // 别的页时，rows 对它「存在与否」不再能作证——照旧 rows.find 会把「被你的筛选挡住了」
  // 说成「这个元素不存在」。存在性/名字/所属模块改由详情接口（getElement）作证；
  // 「在不在这一页」才读 rows。两条腿各答各的问题，横幅按证据说话（见下方 Alert 分支）。
  // 记「上一个认过的 id」而不是一次性 latch：hash 直访是同文档导航，组件不重建，
  // 一次性 latch 会让第二次 Ctrl+K 落点继续高亮上一条元素（反被自己的钉测出来）。
  // 同一串 q 只认一次，所以用户关掉横幅之后不会被查询串「复活」（api.tsx 的 ?def= 同顾虑）。
  const [sp] = useSearchParams();
  const [hitId, setHitId] = useState<string | null>(null);
  // 详情探针的结果与 load 完全解耦：探针只认 (pid, q)，不进 load 依赖，load 的响应
  // 也不喂它——D127 的回路（响应→依赖变脏→effect 重跑）在两条腿上都不许出现。
  const [hitProbe, setHitProbe] = useState<
    | { status: "pending" }
    | { status: "found"; name: string }
    | { status: "missing" }
    | { status: "error" }
  >({ status: "pending" });
  const seenQ = useRef<string | null>(null);
  useEffect(() => {
    const target = sp.get("q");
    if (!target || seenQ.current === target) return;
    seenQ.current = target;
    setHitId(target);
    setHitProbe({ status: "pending" });
    // 不挂 alive 旗/不取消：StrictMode 的假卸载会让「已作废 + seenQ 已记」合起来
    // 把探针永久卡死在 pending（第二次运行被 seenQ 挡回、第一次又被作废）。兄弟先例
    // api.tsx 的 deepDef 探针同法：once-per-q 的闩 + 不取消，晚到的响应只会把同一
    // 目标的名字再写一遍（同 q 同响应体，可重复且无害）。
    // silent：这是横幅的存在性探针，不是用户的操作——404/故障不许弹全局 toast，
    // 摊开说的义务由横幅自己按分支文案兑现。
    uiApi.getElement(pid, target, { silent: true })
      .then((el) => setHitProbe({ status: "found", name: el.name }))
      .catch((e) => {
        // getElement 对「已回收」与「不存在」都回 404（ui.ts 注释），两案在横幅里并说，
        // 不替后端二选一；其余失败（网络/500）= 存在性不可知，同样不许演成「不存在」。
        setHitProbe(e instanceof ApiErr && e.status === 404 ? { status: "missing" } : { status: "error" });
      });
  }, [sp, pid]);

  // 模块 id 集合必须从**已到手**的树算（ownModuleIds 是纯内存游走）。load 自己也写 tree，
  // 把 tree 放进 load 依赖就是 D127 记过的回路（响应→新 tree→load 换身份→effect 重跑）；
  // 树与列表在同一次点击里必然先后落地（首帧取回树才可能点到节点），用 ref 镜像即可
  // （scenes.tsx 步5b 同法）。
  const treeRef = useRef<{ tree: ModNode[]; recycled: ModNode[] }>({ tree: [], recycled: [] });

  // load 依赖 [pid, inRecycled, kw, moduleId, current, pageSize]，**绝不把 rows 或 tree 放进去**：
  // load 自己 setRows/setTree(新对象)——写者进自己的依赖就是「响应→新 rows→load 换身份→
  // effect 重跑→再请求」的无限回路（scenes/uiCases 同法，绊线在测试第一条用例上兜它）。
  // 实测口径（别只看注释就信这条依赖）：把 rows 塞回来，整份 uiElements.test.tsx
  // **跑不完**——600s 无汇总行。原因不是慢，是这条回路的每一跳都排在微任务里
  // （响应→setRows→load 换身份→effect 重跑→再请求），act() 冲不干净、vitest 的
  // 5s 用例超时本身是个宏任务、同样被饿死 → 连第一条用例的绊线都执行不到。
  // 也就是说：这条依赖一旦回来，症状是「挂住」而不是「报红」，测试等于没守。
  // 测试侧因此加了请求风暴刹车（uiElements.test.tsx 的 LIST_STORM_CAP），让它红得出来。
  // tree 同理走 treeRef 镜像（上面那段），两个写者都不许进依赖。
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 页码模式（D47-b 步5d）：current 一上线就是「这页要第几页」的唯一口径，
      // 请求永不带 cursor——current+cursor 同传后端直接 400，一页两把尺子正是被禁的那件事。
      const q: ElementListInput = { project_id: pid, size: pageSize, current };
      if (inRecycled) q.recycled = true;
      if (kw.trim()) q.keyword = kw.trim(); // 空/纯空白 = 不过滤，参数整个不上线
      if (moduleId) {
        // **直属口径**（ownModuleIds = 只有选中节点自身），不是接口页那个 subtreeIds：
        // UI 树徽标还是直属数（_counts docstring），发子树就是「徽标写 3、列表出 7」的
        // R120 谎；子树化要连后端徽标一起改、业主先裁（shared/moduleTree.ts 注释记着这笔账）。
        // 树里查不到该节点时不发 module_ids——与本地过滤时代的「找不到当不过滤」同款语义。
        const sub = ownModuleIds(inRecycled ? treeRef.current.recycled : treeRef.current.tree, moduleId);
        if (sub) q.module_ids = [...sub]; // 重复 query 键由 uiApi.listElements 拼（list[str] 的收法）
      }
      const [t, l] = await Promise.all([
        uiApi.moduleTree(pid, true),
        uiApi.listElements(q),
      ]);
      const tm = t.tree.map(toMod); const rm = t.recycled.map(toMod);
      setTree(tm); setRecycledTree(rm);
      treeRef.current = { tree: tm, recycled: rm };
      // 页码模式是替换语义：第 3 页的行就只画第 3 页的，别页的行必须下桌。
      setRows(l.items);
      // total 只从响应来，永不由 rows.length 客户端现攒（页内行数不是总数）。
      // 缺键（后端尚未上页码模式的游标式响应）→ null → ListPager 整块不渲染。
      setTotal(l.total ?? null);
      // D180：视图模板只在这一行（成功路径）追平点击——行与模板同一批提交；失败不碰。
      setShownRecycled(inRecycled);
    } catch (e) {
      // D47-b 步5d：页码模式下失败**清行清 total**（旧「失败不清行」的口径随游标世界一起
      // 退役，这是有意分歧不是回归，scenes/uiCases 同款）：陈旧行 + 新 current 同屏就是
      // 「我在第几页」的两把尺子，与后端禁 cursor+current 同罪。故障仍摊开说（loadError
      // Alert + 空态改口）。D180 不变量一条不丢：shownRecycled 失败不翻。
      setRows([]);
      setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "元素列表加载失败");
    } finally { setLoading(false); }
  }, [pid, inRecycled, kw, moduleId, current, pageSize]);
  useEffect(() => { void load(); }, [load]);

  // D47-b 步5d：旧「模块 + 关键词都在本地过滤」的 visible useMemo 已整块删除——
  // keyword= 与 module_ids 都下推到后端（keyword 大小写不敏感是后端契约，浏览器不再
  // toLowerCase），表里画的就是服务端筛后的当前页。

  // 落点横幅的两份证据（D47-b 步5d，语义与旧版不同，别照旧直觉读）：
  // - hitRow：落点在**不在当前页的行里**（决定行高亮与「已标出」措辞）；
  // - hitProbe：详情接口对「这条元素存不存在」的作证（rows 只剩当前页后不再能答这个问题）。
  // 横幅名优先取探针（found）：不在本页时 rows 里根本没有那条行，名字只有探针给得出；
  // 探针未落地/故障时退到 id 本体（不许编名字）。一个筛选都不在场时真凶只剩
  // 「在别的页/回收站里」，横幅必须把这句话也说得出来（不许赖给不在场的凶手）。
  const hitRow = useMemo(() => rows.find((r) => r.id === hitId) ?? null, [rows, hitId]);

  // —— 新建（快速弹窗：名称 / 类型 / 表达式 / 备注） ——
  const [creating, setCreating] = useState(false);
  const [cName, setCName] = useState("");
  const [cType, setCType] = useState("css");
  const [cLocator, CLocator] = useState("");
  const [cComment, setCComment] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitCreate(): Promise<void> {
    const v = cName.trim();
    if (!v) { message.warning("元素名必填"); return; }
    if (!cLocator.trim()) { message.warning("定位表达式必填"); return; }
    setBusy(true);
    try {
      await uiApi.createElement({
        project_id: pid, name: v, locator_type: cType, locator: cLocator.trim(),
        module_id: moduleId, comment: cComment.trim() || null,
        project_public: true, // 元素库是项目资产（后端默认同值；UI 暂不开放私有元素开关）
      });
      message.success("元素已创建");
      setCreating(false); setCName(""); CLocator(""); setCComment(""); setCType("css");
      await load();
    } catch { /* toast；重名 409 等留在弹窗里改 */ } finally { setBusy(false); }
  }

  // —— 编辑（D120）：改名/定位器/备注/可见性；PATCH 语义 None=不改，body 只装改动项 ——
  // module_id 不在弹窗里：本页没有跨模块移动入口，模块树只做列表筛选，跨模块搬迁超出本修法。
  // project_public 开关是 D120 点名的「可见性」项——新建流把它写死成 true（:136 注释），
  // 开关不开放；编辑流开放它，文案逐字沿用 api.tsx def-public 那句（后端语义相同：
  // 关掉后仅 owner 与项目管理员可见，shared/visibility.py:4）。
  const [editing, setEditing] = useState<Row | null>(null);
  const [eName, setEName] = useState("");
  const [eType, setEType] = useState("css");
  const [eLocator, setELocator] = useState("");
  const [eComment, setEComment] = useState("");
  const [ePublic, setEPublic] = useState(true);

  function openEdit(r: Row): void {
    setEditing(r); setEName(r.name); setEType(r.locator_type); setELocator(r.locator);
    setEComment(r.comment ?? ""); setEPublic(r.project_public);
  }

  async function submitEdit(): Promise<void> {
    if (!editing) return;
    const v = eName.trim();
    if (!v) { message.warning("元素名必填"); return; }
    if (!eLocator.trim()) { message.warning("定位表达式必填"); return; }
    const body: Record<string, unknown> = { project_id: pid };
    // PATCH 语义 None=不改：没动的字段一个都不发（后端 None 分支不写库，多发一份等于
    // 把「没改」伪造成「按当前值改一次」+ 一次多余的引用门）。module_set 不置真：
    // 弹窗没有模块选择项，绝不把行挪出模块。
    if (v !== editing.name) body.name = v;
    if (eType !== editing.locator_type) body.locator_type = eType;
    if (eLocator.trim() !== editing.locator) body.locator = eLocator.trim();
    const cm = eComment.trim();
    if (cm !== (editing.comment ?? "")) body.comment = cm;
    if (ePublic !== editing.project_public) body.project_public = ePublic;
    if (Object.keys(body).length === 1) { message.info("没有改动可保存"); return; }
    setBusy(true);
    try {
      await uiApi.updateElement(editing.id, body as components["schemas"]["ui_element_update_body"]);
      message.success("元素已更新");
      setEditing(null);
      await load();
    } catch (e) {
      if (e instanceof ApiErr && e.code === "referenced_by_case") {
        // PATCH 路的引用门只挂在「定位器真的被改掉」上（后端 element_services.py:255
        // 同口径），所以走到这里用户就在改定位器的现场——清单复用删除那条路的同一只弹窗，
        // 编辑窗留在原地：用户要的从来不是「保存失败」四个字，是**哪几条用例**挡着。
        setRefs({ name: editing.name, details: e.details as ElementRefDetails,
          reason: "locator" });
      } // 其余错误 client 已 toast；编辑窗留在原地改
    } finally { setBusy(false); }
  }

  // —— 回收：被引用时后端 409，引用清单必须说清楚（R106） ——
  // reason：同一只清单弹窗被三个入口共用（回收 / 彻底删除 / 改定位器 D120）：默认（undefined）
  // 是删除口，"locator" 是编辑口——标题与第一句按入口措辞，被引用时编辑弹窗不关
  // （用户就在改定位器的现场），清单本体三个入口共用一套 testid 与列表渲染。
  const [refs, setRefs] = useState<{
    name: string; details: ElementRefDetails;
    reason?: "locator";
  } | null>(null);

  function removeOne(r: Row) {
    Modal.confirm({
      title: "元素放入回收站？",
      content: "「" + r.name + "」进入回收站，可随时恢复；被未回收用例引用时会拒绝并列出是哪几条。",
      okText: "放入回收站", okButtonProps: { danger: true, "data-testid": "ui-element-del-ok" },
      cancelText: "取消",
      onOk: async () => {
        try {
          await uiApi.removeElement(pid, r.id);
          message.success("已放入回收站");
          await load();
        } catch (e) {
          // 硬拦不是失败是保护：409 的 details 直接开清单弹窗，别让它只化成一句 toast
          if (e instanceof ApiErr && e.code === "referenced_by_case") {
            setRefs({ name: r.name, details: e.details as ElementRefDetails });
          } // 其余错误 client 已 toast
        }
      },
    });
  }

  async function restoreOne(r: Row): Promise<void> {
    try {
      await uiApi.restoreElement(pid, r.id);
      message.success("已恢复");
      await load();
    } catch { /* toast；同名被占 409 要说人话，不静默改名 */ }
  }

  // —— 彻底删除（回收站出口）：逐字输名，服务端同样硬校验 + 引用硬拦（R53/R106） ——
  const [purge, setPurge] = useState<{ id: string; name: string } | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purging, setPurging] = useState(false);

  async function submitPurge(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      await uiApi.purgeElement(pid, purge.id, purgeName);
      message.success("已彻底删除，元素名可以重新使用");
      setPurge(null); setPurgeName("");
      await load();
    } catch (e) {
      if (e instanceof ApiErr && e.code === "referenced_by_case") {
        setRefs({ name: purge.name, details: e.details as ElementRefDetails });
        setPurge(null); setPurgeName("");
      } // 其余错误（name_mismatch 等）保持弹窗打开，改名重试或取消
    } finally { setPurging(false); }
  }

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
            apiBase="/ui-modules" allLabel="全部元素" noun="元素"
            // 树与列表在同一把 Promise.all 里（load :88），失败时两边一起停：
            // 不传给树的话，回收站视图会在「没取到」时画一句「回收站是空的」。
            loadError={loadError}
            countTip={"这个数字是这个模块下的未回收元素 + UI 用例合计（直属，不含子模块）。"
              + "下面的列表只有元素，所以用例存在时徽标会比行数大。"}
          />
        </Card>
      </Col>
      {/* flex 基准必须是 0：`auto` 会拿表格内容的 max-content 当基准，208+宽表 > 行宽，
          antd Row 的 flex-wrap 就把右列整块折到下一行、横跨全宽（2026-11-22 截图实测）。 */}
      <Col flex="1 1 0" style={{ minWidth: 0 }}>
        <FilterBar actions={(
          <>
            <Button icon={<ReloadOutlined />} data-testid="ui-element-reload" onClick={() => void load()}>刷新</Button>
            {canCreate && !inRecycled && (
              <Button type="primary" icon={<PlusOutlined />} data-testid="ui-element-new"
                onClick={() => { setCreating(true); setCName(""); CLocator(""); setCComment(""); setCType("css"); }}>
                新建元素
              </Button>
            )}
          </>
        )}>
          {/* 关键词是服务端契约（D47-b 步5d）：打字只动 qText（受控现值），提交才进 load
              依赖（kw）。提交口恰好三个：Enter、放大镜钮、allowClear 清空——antd 5.29 的
              Input.Search 把三条路径都汇进 onSearch。onChange 里**绝不**发请求；
              空/纯空白提交 = 不带 keyword 参数（scenes.tsx 步5b 同法）。 */}
          <Input.Search data-testid="ui-element-search" allowClear style={{ width: 240 }}
            placeholder="搜索元素名" value={qText}
            onChange={(e) => setQText(e.target.value)}
            onSearch={(v) => patchFilters({ kw: v.trim() })} />
        </FilterBar>
        {/* 刻意不给 ×：脚注（:311）与空态都读 loadError，关掉这条等于把「元素没取到」
            擦成「还没有元素，点右上角新建元素」——消掉证据的那一下正好把故障演成实测空。 */}
        {loadError && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="ui-element-load-error"
            message="元素列表加载失败" description={loadError} />
        )}
        {/* 落点横幅（D47-b 步5d 语义改造）。旧版拿 rows.find 一条腿说「存在/不存在」，
            页码模式后 rows 只是当前页——被筛选/翻页挡住≠不存在，照旧写就是说谎。
            现在每条分支只说自己那腿证据撑得住的话：
            ① 行在当前页（hitRow）→「已标出」（行确实画着并高亮）；
            ② 详情探针 found 而不在本页 → 元素还在，按在场的已提交筛选点名嫌疑人
              （都不在场就直说「在后面的页里」——指给下方页码，不许赖给不在场的凶手）；
            ③ 探针 404 → 详情只认未回收元素：正常视图说「不存在或已被放入回收站」，
              回收站视图说「详情不认已回收的行」，两边都不把「没取到」演成「不存在」；
            ④ 探针故障 → 存在性不可知，如实说确认不了（刷新是真把手）；
            ⑤ 探针在途 → 只说「正在确认」，不许抢跑下结论。
            每条分支的出口（清搜索/切模块/翻页/刷新）都是真在场的把手——§13 纪律 1。 */}
        {hitId && (
          <Alert type="info" showIcon closable data-testid="ui-element-hit" style={{ marginBottom: 12 }}
            message={hitRow
              ? "快捷搜索定位到「" + hitRow.name + "」——已在下表标出这一行。"
              : "快捷搜索定位到「" + (hitProbe.status === "found" ? hitProbe.name : hitId) + "」"
                + (hitProbe.status === "pending" ? "——正在向元素详情确认这条元素…"
                  : hitProbe.status === "found"
                    ? (inRecycled
                      // found = 详情取到了 = 这条还没进回收站（getElement 对回收行 404），
                      // 所以它在回收站视图里永远等不到——说「翻页找」是指错路。
                      ? "——这条元素还在，而且它不在回收站里：退出回收站视图就能在正常列表里找到它。"
                      : kw.trim() && moduleId
                      ? "——这条元素还在，但不在当前这一页（可能被已提交的搜索关键词或左上的模块筛选挡住——清空搜索框或点「全部元素」就能看到它）。"
                      : kw.trim()
                        ? "——这条元素还在，但不在当前这一页（被已提交的搜索关键词挡住了），换个关键词或清空搜索框就能看到它。"
                        : moduleId
                          ? "——这条元素还在，但不在当前这一页（可能被左上的模块筛选挡住——点「全部元素」或换个模块看看）。"
                          : "——这条元素还在，但不在当前这一页：它在列表后面的页里，用下方页码翻过去就能看到。")
                    : hitProbe.status === "missing"
                      ? (inRecycled
                        ? "——但这一条不在当前页里：元素详情接口只认未回收的元素，它不认已回收的行；若这条在回收站里，请翻回收站的页码找它。"
                        : "——这一条不在当前页里，元素详情也说查不到它：要么不存在，要么已被放入回收站（可切到回收站视图翻找）。")
                      : "——但它现在确认不了：元素详情没取到，这不代表这条元素不存在，刷新或修好列表后再看。")
            }
            description="这条是 Ctrl+K 直达带过来的：URL 里带着元素 id，页面把它认出来；行在当前页时会高亮那一行。"
            onClose={() => setHitId(null)} />
        )}
        <AdminTable<Row> rowKey="id" loading={loading} dataSource={rows}
          rowClassName={(r) => (r.id === hitId ? "tp-row-hit" : "")}
          locale={{ emptyText: loadError ? (
            // 失败不许画成空（§11.7.5）：kind="error" + 真重试把手，文案逐字保留。
            <StateView kind="error" title="元素列表没取到，以上方的加载失败提示为准"
              action={<Button size="small" onClick={() => void load()}>重试</Button>} />
          ) : (
            <StateView
              // D47-b 步5d：表渲染的就是服务端筛后的当前页，空表只说明「当前条件下后端
              // 没给行」。归因读的全是**已提交**的筛选（kw 不是 qText）——输入框里没敲
              // 回车的那半截关键词不许替用户背锅；旧「rows.length 还有行→怪筛选」那条腿
              // 随本地过滤一起退役（rows 本身就是筛后的）。（scenes.tsx 步5b 同口径）
              title={shownRecycled ? "回收站是空的"
                : kw.trim() ? "没有匹配的元素，换个关键词试试"
                  : moduleId ? "该模块下还没有元素"
                    // 「点右上角新建元素」指的那扇钮挂在上面 FilterBar 的 canCreate 之后（隐藏不是
                    // 禁用）：无新建权限时空态还指路，就是同一棵渲染树承诺自己藏掉的把手（假门）。
                    // 真分支逐字不许动——测试与 e2e 都按「点右上角新建元素」这句钉。
                    : canCreate ? "还没有元素，点右上角新建元素" : "还没有元素（你没有新建权限）"} />
          ) }}
          columns={[
            { title: "名称", dataIndex: "name", width: 200, render: (v: string) => (
              <span data-testid="ui-element-row-name">{v}</span>) },
            // §11.4.18 回收站「删除人/删除时间」两列——模板整组读 shownRecycled（D180：跟数据走），
            // 单元格再按 r.status 逐行兜底。
            // 为什么必须守卫：同一份 updated_by/updated_at 在正常行上是「最后编辑人/时间」
            // （update 也写它们），标成「删除人」就是说谎；只有回收站里每行都是回收过的，
            // 最后那次写操作才恰好是回收本身（回收落 updated_by 见 element_services.ui_element_delete），
            // 「删除人」才名副其实。
            ...(shownRecycled ? [
              { title: "删除人", key: "delby", width: 96, render: (_: unknown, r: Row) => (
                // 非回收行不画（混合/陈旧数据里画了就是说谎）；查不到人落「—」，不拿 user id 冒充人名
                r.status === "recycled"
                  ? <span data-testid="ui-element-recycled-by">{r.updated_by_name ?? "—"}</span>
                  : <span>—</span>) },
              { title: "删除时间", key: "delat", width: 150, render: (_: unknown, r: Row) => (
                // 换算走 shared/timefmt（§3.4-6，R68 教训），非回收行不画（同删除人列）
                r.status === "recycled" ? (
                  <Typography.Text type="secondary" className="tp-text-sm" data-testid="ui-element-recycled-at">
                    {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
                  </Typography.Text>) : <span>—</span>) },
            ] : []),
            { title: "定位方式", dataIndex: "locator_type", width: 110, render: (v: string) => (
              <Tag data-testid={"ui-element-tag-" + v} color={LOCATOR_COLOR[v] ?? "default"}>{v}</Tag>) },
            { title: "表达式", dataIndex: "locator", ellipsis: true, render: (v: string) => (
              // 省略 + hover 复制：定位表达式经常长到读不完，复制是刚需不是装饰
              <Typography.Text style={{ maxWidth: "100%" }} copyable={{ text: v }}
                ellipsis={{ tooltip: v }}>{v}</Typography.Text>) },
            { title: "关联用例数", dataIndex: "used_by", width: 110, render: (v: number) => (
              <span data-testid="ui-element-used-by">{v}</span>) },
            { title: "更新时间", key: "upd", width: 150, render: (_, r) => (
              <Typography.Text type="secondary" className="tp-text-sm">
                {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
              </Typography.Text>) },
            { title: "", key: "ops", width: 150, render: (_, r) => (
              // 行身份按 r.status 判（D180）：在途/失败时视图标记会与行脱节，恢复/彻底删除
              // 绝不落到正常行上；回收行也不给正常视图的回收入口。权限位不动。
              r.status === "recycled"
                ? (
                  <Space size={4}>
                    {canUpdate && (
                      <Button size="small" icon={<UndoOutlined />} data-testid="ui-element-restore"
                        onClick={() => void restoreOne(r)}>恢复</Button>
                    )}
                    {canDelete && (
                      <Button size="small" danger data-testid="ui-element-purge"
                        onClick={() => { setPurge({ id: r.id, name: r.name }); setPurgeName(""); }}>
                        彻底删除
                      </Button>
                    )}
                  </Space>
                )
                : (
                  <Space size={4}>
                    {/* D120：编辑入口按 canUpdate 隐藏不是禁用；回收行不给（后端对回收行
                        PATCH 直接 404）。回收钮仍只在 canDelete 时出现——两个把手各自跟位。 */}
                    {canUpdate && (
                      <Button size="small" data-testid="ui-element-edit" aria-label={"编辑-" + r.name}
                        onClick={() => openEdit(r)}>编辑</Button>
                    )}
                    {canDelete && (
                      <Tooltip title="放入回收站">
                        <Button size="small" danger type="text" icon={<DeleteOutlined />}
                          data-testid="ui-element-delete" aria-label={"回收-" + r.name}
                          onClick={() => removeOne(r)} />
                      </Tooltip>
                    )}
                  </Space>
                )
            ) },
          ]}
        />
        {/* D47-b 步5d：共享页码分页器。total 缺键（响应没带 total）时 ListPager 整块不渲染，
            这里垫在 Table 之下（runs.tsx / scenes.tsx 的居中垫法）；「共 N 条」从此只有服务端
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
        <Typography.Text type="secondary" className="tp-text-sm">
          {/* D47-b 步5d：hasMore 那句「本页取到 N 条（单页上限 200，后面还有没取的）」随游标
              世界退役——页码模式下下一页永远点得到，「还有没取的」不再是脚注能说的事；
              「共」归 ListPager 报服务端 total，脚注不再现攒。失败清行清 total，
              「上次取到 N 条」那条腿也没有意义了——失败就清行，这里只剩一句真话（照 uiCases.tsx）。
              「选中模块」不写「含子模块」：按模块筛选只看这个模块自己的行，与树徽标
              「count=直属未回收元素+用例」同口径（后端 module_services.py:100）。
              三页同一个词，文案不许比代码多说（R120）。 */}
          {loadError ? "本次列表加载失败，本行计数不作数" : ""}
          {moduleId ? "（选中模块）" : ""}{shownRecycled ? " · 回收站视图" : ""}
        </Typography.Text>
      </Col>

      {/* 新建元素：快速弹窗（§11.4.11） */}
      <Modal open={creating} title="新建元素" okText="创建" cancelText="取消"
        confirmLoading={busy} data-testid="ui-element-new-modal"
        okButtonProps={{ "data-testid": "ui-element-new-ok" }}
        onOk={() => void submitCreate()} onCancel={() => setCreating(false)}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input data-testid="ui-element-name" maxLength={200} value={cName} autoFocus
            placeholder="元素名，如「登录按钮」（项目内唯一）" onChange={(e) => setCName(e.target.value)} />
          <Select data-testid="ui-element-type" style={{ width: "100%" }} value={cType}
            options={LOCATOR_OPTIONS} onChange={setCType} />
          <Input data-testid="ui-element-new-locator" maxLength={500} value={cLocator}
            placeholder="定位表达式，如 #submit-btn 或 //button[@type='submit']"
            onChange={(e) => CLocator(e.target.value)}
            onPressEnter={() => void submitCreate()} />
          <Input.TextArea data-testid="ui-element-new-comment" maxLength={500} rows={2} value={cComment}
            placeholder="备注（可选）" onChange={(e) => setCComment(e.target.value)} />
          {moduleId && (
            <Typography.Text type="secondary" className="tp-text-sm">
              将创建在当前选中的模块下。
            </Typography.Text>
          )}
        </Space>
      </Modal>

      {/* 编辑元素（D120）：字段与新建弹窗同一套把手（名称 / 类型同词表 / 表达式 / 备注），
          外加可见性开关；初值从行 prefilled。不含模块选择项——跨模块搬迁另有门径与否都
          不在这扇窗里（module_set 恒不置真，行不会被挪走）。 */}
      <Modal open={editing !== null} title="编辑元素" okText="保存" cancelText="取消"
        confirmLoading={busy} data-testid="ui-element-edit-modal"
        okButtonProps={{ "data-testid": "ui-element-edit-ok" }}
        onOk={() => void submitEdit()} onCancel={() => setEditing(null)}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input data-testid="ui-element-edit-name" maxLength={200} value={eName} autoFocus
            placeholder="元素名，如「登录按钮」（项目内唯一）" onChange={(e) => setEName(e.target.value)} />
          <Select data-testid="ui-element-edit-type" style={{ width: "100%" }} value={eType}
            options={LOCATOR_OPTIONS} onChange={setEType} />
          <Input data-testid="ui-element-edit-locator" maxLength={500} value={eLocator}
            placeholder="定位表达式，如 #submit-btn 或 //button[@type='submit']"
            onChange={(e) => setELocator(e.target.value)} />
          <Input.TextArea data-testid="ui-element-edit-comment" maxLength={500} rows={2} value={eComment}
            placeholder="备注（可选）" onChange={(e) => setEComment(e.target.value)} />
          <Space>
            <Switch data-testid="ui-element-edit-public" checked={ePublic} onChange={setEPublic}
              size="small" />
            <Typography.Text type="secondary" className="tp-text-sm">
              项目内公开（关掉后仅自己与项目管理员可见）
            </Typography.Text>
          </Space>
          {(editing?.used_by ?? 0) > 0 && (
            <Typography.Text type="secondary" className="tp-text-sm">
              这一条正被 {editing?.used_by} 条未回收的 UI 用例引用：改名/备注/可见性随便改，
              定位方式与表达式一改就会被拒绝，并列出是哪几条用例挡着。
            </Typography.Text>
          )}
        </Space>
      </Modal>

      {/* 引用硬拦（R106；D120 起编辑改定位器同路复用）：details.cases 原样列出来，一个都不藏——
          除非调用方没有 ui:case:read（details_hidden），那也得说清「数量照报、名字不说」。
          标题/首句按入口措辞：清单本体（ui-element-refs / ui-element-ref-case）三个入口共用。 */}
      <Modal open={refs !== null}
        title={refs?.reason === "locator" ? "改定位器被拦截：还有 UI 用例在用这个元素"
          : "删除被拦截：还有 UI 用例在用这个元素"}
        okText="知道了" cancelButtonProps={{ style: { display: "none" } }} width={560}
        okButtonProps={{ "data-testid": "ui-element-refs-ok" }}
        onOk={() => setRefs(null)} onCancel={() => setRefs(null)}>
        <div data-testid="ui-element-refs">
          <Typography.Paragraph>
            「{refs?.name}」被 <Typography.Text strong>{refs?.details.referenced_by}</Typography.Text>
            {" "}条未回收的 UI 用例引用，先解引用再来
            {refs?.reason === "locator" ? "（回收或彻底删除同样会被拒绝）。"
              : "（回收、彻底删除或改定位器都一样会被拒绝）。"}
          </Typography.Paragraph>
          {refs?.details.details_hidden ? (
            <Typography.Paragraph type="secondary">
              你没有 UI 用例的读取权限，看不到具体是哪几条——数量照报、明细隐瞒是刻意的，
              请让有用例权限的同事解引用。
            </Typography.Paragraph>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {(refs?.details.cases ?? []).map((c) => (
                <li key={c.id} data-testid="ui-element-ref-case">
                  {c.name}
                  <Typography.Text type="secondary" className="tp-text-sm">
                    {" "}（第 {c.step_indexes.map((i) => i + 1).join("、")} 步）
                  </Typography.Text>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>

      {/* 彻底删除：不可逆，输名确认（与 1A/1B 回收站手感一致；服务端同样硬校验） */}
      <Modal
        open={purge !== null} onCancel={() => { setPurge(null); setPurgeName(""); }}
        destroyOnHidden width={520}
        title="彻底删除元素？" okText="我已确认，彻底删除" cancelText="取消"
        okButtonProps={{ danger: true, "data-testid": "ui-element-purge-ok",
          disabled: purgeName !== (purge?.name ?? ""), loading: purging }}
        onOk={() => void submitPurge()}
      >
        <Typography.Paragraph>
          「{purge?.name}」将被物理删除，
          <Typography.Text strong>无法恢复</Typography.Text>。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          被未回收用例引用的元素即使在回收站里也删不掉（彻底删除同样硬拦）——
          物理删除会让引用它的用例永久指不到定位目标。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          输入元素名 <Typography.Text code>{purge?.name}</Typography.Text> 以确认。
        </Typography.Paragraph>
        <Input data-testid="ui-element-purge-confirm" value={purgeName} autoFocus
          placeholder={purge?.name} onChange={(e) => setPurgeName(e.target.value)} />
      </Modal>
    </Row>
  );
}

export default function UiElementsPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-ui-elements">
      <PageHead title="元素库" crumbs={["UI 测试"]}
        desc="项目共享的 UI 定位器资产，按模块归类；被未回收用例引用时删除/改定位器会被硬拦并点名引用者。" />
      <ProjectGate>{project ? <ElementsWorkbench /> : null}</ProjectGate>
    </div>
  );
}
