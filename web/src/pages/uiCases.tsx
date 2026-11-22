// UI 用例列表页（§11.5.4，T17 交付完整版；D73 补回收站）。
// 契约（nav.spec.mjs 钉死）：根 testid `page-ui-cases` + PageHead「UI 用例」+ ProjectGate，
// .tp-page-title 每页恰好一个。正常视图六列 = 名称 | 优先级 | 启用 | 最近结果 | 负责人 | 更新时间。
// 名称点击进详情编辑器（最近结果列读后端冗余列，debug 不回写——列表不会把过程演成结论）。
// 按钮按权限**隐藏不是禁用**（settings.spec 钉的手感）：无 ui:case:create 不渲染「新建用例」。
// 回收站（D73，§11.4.18）：后端 ui_case_delete / ui_case_restore / ui_case_purge
// （case_services.py:267/296/324）早已落地，界面一直没有入口——端点存在而界面藏 = 反向假门，
// 这页欠账被孪生 adbCases.tsx 文件头点过名。交互照抄兄弟页既有形状，不造第二套：
// toggle / 软删确认 / 输名彻底删除同 adbCases，「删除人/删除时间」两列的 inRecycled 守卫
// 与「正常行标删除人就是说谎」的口径同 uiElements.tsx:232-247。
// 三件套端点 uiApi 尚未收录（ui.ts 本任务只许动类型镜像），照 ModuleTree.tsx 先例直接走
// client.post——路径/请求体逐字对齐 schema.d.ts 的 ui_case_delete/restore/purge_body。
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Input, Modal, Space, Table, Tag, Typography, message } from "antd";
import { PlusOutlined, UndoOutlined } from "../ui/icons";
import StateView from "../ui/StateView";
import { FilterBar } from "../ui/Toolbar";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { get, post, ApiErr } from "../api/client";
import { uiApi, type UiCaseListRow } from "../api/ui";
import { ScenarioRefsBlockModal, scenarioBlockOf } from "../api/CaseList";
import type { ScenarioBlockDetails } from "../api/CaseList";
import { ownerLabel, MEMBERS_FAILED, MEMBERS_LOADING, membersReady, type MemberLookup } from "../shared/ownerName";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { STATUSES } from "../shared/runVocab";
import type { Page } from "../api/api";

type Row = UiCaseListRow;
type MemberRow = { user_id: string; account: string | null; name: string | null };

const PRIO_COLOR: Record<string, string> = { P0: "red", P1: "volcano", P2: "blue", P3: "default" };

function CasesList() {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canCreate = can(perms, "ui:case:create");
  // 后端权限位照 case_services.py 逐个对：delete/purge 挂 ui:case:delete，
  // restore 挂 ui:case:update（:291）——恢复不是删除，别拿 delete 位门它。
  const canUpdate = can(perms, "ui:case:update");
  const canDelete = can(perms, "ui:case:delete");
  const [rows, setRows] = useState<Row[]>([]);
  // 成员表是「负责人」列的名字来源。三态而不是 {}：加载中/拉挂了都不能把人判成
  // 「非项目成员」（那是冤枉人），详见 shared/ownerName.ts。
  const [members, setMembers] = useState<MemberLookup>(MEMBERS_LOADING);
  const [loading, setLoading] = useState(false);
  const [inRecycled, setInRecycled] = useState(false);
  // D180：视图模板读 shownRecycled——只在取数成功那一刻跟行一起翻，失败不翻。
  // 在途/失败窗口里留着的还是正常行，模板不许先换成回收站那套（说谎窗口）。
  const [shownRecycled, setShownRecycled] = useState(false);
  // 取数失败与「项目里真的没有用例」是两句话：把失败画成实测零，是把故障演成空数据
  // （adbCases / uiElements 已按同口径修过，本页是同一病灶的第三个站点）。
  const [loadError, setLoadError] = useState<string | null>(null);
  // D47-b 步5a：页码分页（current/size/total）退役「拉一页 200 + 脚注猜有没有下一页」。
  // 一页只许有一个「我在第几页」的真相；默认档位 20 是 ListPager 档位表（20/50/100）里的真值。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  // inRecycled 只有这一个写入口（runs.tsx 的 patch 同款）：三个 setState 各写各的时，
  // 漏接一个 setCurrent(1) 没人拦得住——停在第 3 页点回收站，落的是回收集里无关的切片，
  // 和换档位不回页是同一个 hazard（listPagination.tsx 注释③）。
  const toggleRecycled = (): void => { setInRecycled((v) => !v); setCurrent(1); };

  // load 依赖 [pid, inRecycled, current, pageSize]，**绝不把 rows 放进去**：load 自己
  // setRows(新数组)——写者进自己的依赖就是「响应→新 rows→load 换身份→effect 重跑→再请求」
  // 的无限回路（reports.tsx 步3b 刚为这个付过学费，fetch 桩深拷 + 挂载恰好一条请求的绊线
  // 在 uiCases.test.tsx 头一条用例上兜它）。load 也从不写 current/pageSize/inRecycled。
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 请求永不带 cursor：current+cursor 同传后端直接 400，一页两把尺子正是被禁的那件事
      const r = await uiApi.listCases({
        project_id: pid, size: pageSize, current,
        ...(inRecycled ? { recycled: true } : {}) });
      // 页码模式是替换语义：第 3 页的行就只画第 3 页的，别页的行必须下桌。
      setRows(r.items);
      // total 只从响应来，永不由 rows.length 客户端现攒（页内行数不是总数）。
      // 缺键（后端尚未上页码模式的游标式响应）→ null → ListPager 整块不渲染。
      setTotal(r.total ?? null);
      // D180：视图模板只在这一行（成功路径）追平点击——行与模板同一批提交；失败不碰。
      setShownRecycled(inRecycled);
    } catch (e) {
      // D47-b 步5a：页码模式下失败**清行清 total**——旧「失败不清行」的口径随游标世界一起
      // 退役（这是有意分歧，不是回归）：陈旧行 + 新 current 同屏就是「我在第几页」的两把
      // 尺子，与后端禁 cursor+current 同罪（接口页步4b 已为此改过一次，理由在 api.tsx catch）。
      // 故障仍摊开说（loadError Alert + 空态改口），只是不再拿上一批行冒充当前页。
      // D180 不变量一条不丢：shownRecycled 失败不翻——清行后屏上无行、无回收列、无「回收站视图」字样。
      setRows([]);
      setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "用例列表加载失败");
    } finally { setLoading(false); }
  }, [pid, inRecycled, current, pageSize]);
  useEffect(() => { void load(); }, [load]);
  // 负责人列要名字不是 id：成员表拉一次。失败如实标 failed（ownerLabel 会说「名字未取到」），
  // 不静默把 uuid 当名字摊出去——同 scenes.tsx 一起改的口径。
  useEffect(() => {
    setMembers(MEMBERS_LOADING);
    void (async () => {
      try {
        const m = await get<Page<MemberRow>>("/projects/" + encodeURIComponent(pid) + "/members", { silent: true });
        const map: Record<string, string> = {};
        for (const x of m.items) map[x.user_id] = x.name ?? x.account ?? x.user_id;
        setMembers(membersReady(map));
      } catch { setMembers(MEMBERS_FAILED); }
    })();
  }, [pid]);

  // —— 回收站三件套（端点语义见 case_services.py；uiApi 未收录，走 client.post，
  //    请求体逐字对齐 ui_case_delete/restore/purge_body = {project_id[, confirm_name][, force]}） ——
  // 回收 409「被场景引用」的拦截态（D86 同款，交互与 CaseList.tsx remove/forceRemove 一致）：
  // 非空即弹窗点名引用场景，force 只对「已看见清单」的人开放（hidden 分支后端连 force 一起拦）。
  const [blocked, setBlocked] = useState<{ row: Row; details: ScenarioBlockDetails } | null>(null);
  const [blocking, setBlocking] = useState(false);

  async function doRemove(r: Row, force: boolean): Promise<boolean> {
    try {
      await post("/ui-cases/" + encodeURIComponent(r.id) + "/delete",
        { project_id: pid, ...(force ? { force: true } : {}) });
      message.success(force ? "已放入回收站（引用它的场景步骤会当场解析失败）" : "已放入回收站");
      await load();
      return true;
    } catch (e) {
      // 被场景引用的 409 是保护不是失败：details.scenarios 点名了是谁（case_services._blocked），
      // 摆成拦截弹窗才有的可解（与 api.tsx removeDef / CaseList remove 同一套错误词汇）。
      const blk = scenarioBlockOf(e);
      if (blk && !force) setBlocked({ row: r, details: blk });
      return false;
      // 其余错误 client 已 toast
    }
  }

  // force 第二段只从拦截弹窗进来（明细被隐瞒时弹窗根本不摆这扇钮，后端同尺）。
  async function forceRemove(): Promise<void> {
    if (!blocked) return;
    setBlocking(true);
    try {
      if (await doRemove(blocked.row, true)) setBlocked(null);
    } finally { setBlocking(false); }
  }

  function removeOne(r: Row): void {
    Modal.confirm({
      // 文案照 adbCases.tsx:74-76（同族页面的软删手感：可恢复 + 彻底删除要输名，两句都在）
      title: `把「${r.name}」放入回收站？`,
      // 后半句别承诺「点名」：无 scenario:read 的调用方（D37 自定义角色可带 delete 不带
      // scenario:read）拿到的 409 只报数量不说名字（ui_test/case_services.py:263 的 hidden
      // 分支）——两个分支都兑现的只有「拒绝 + 给出引用情况」，明细那句得带上权限前提。
      content: "软删，可随时恢复；彻底删除需逐字确认名称。其若被未回收场景引用会拒绝回收，并给出引用情况（引用明细要 scenario:read 才看得到）。",
      okText: "放入回收站", okButtonProps: { danger: true, "data-testid": "ui-case-del-ok" }, cancelText: "取消",
      onOk: async () => { await doRemove(r, false); },
    });
  }

  async function restoreOne(r: Row): Promise<void> {
    try {
      await post("/ui-cases/" + encodeURIComponent(r.id) + "/restore", { project_id: pid });
      message.success("已恢复");
      await load();
    } catch { /* 回收期间名字被占 409（:307-309）：toast 说人话，不静默改名 */ }
  }

  // 彻底删除：逐字输名（confirm_name != c.name → 409 name_mismatch，:338；前端 disabled 只是少跑一次腿）
  const [purge, setPurge] = useState<Row | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purging, setPurging] = useState(false);
  async function submitPurge(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      await post("/ui-cases/" + encodeURIComponent(purge.id) + "/purge",
        { project_id: pid, confirm_name: purgeName });
      message.success("已彻底删除，用例名可以重新使用");
      setPurge(null); setPurgeName("");
      await load();
    } catch { /* name_mismatch/not_recycled 等保持弹窗打开重试（toast 已弹） */ }
    finally { setPurging(false); }
  }

  return (
    <>
      <FilterBar actions={(
        <>
          {canCreate && !inRecycled && (
            <Button type="primary" icon={<PlusOutlined />} data-testid="ui-case-new"
              onClick={() => nav("/ui/cases/new")}>
              新建用例
            </Button>
          )}
          {/* 回收站 toggle：照 adbCases.tsx:120-121 同位同文案（本页无模块树，孪生是它不是元素页）。
              按钮挂 ui:case:read（本页可读即可见）——与 adbCases 一致不另设门；写操作在行上再各自门控。 */}
          <Button data-testid="ui-case-recycled" type={inRecycled ? "primary" : "default"}
            onClick={toggleRecycled}>
            {inRecycled ? "退出回收站" : "♻ 回收站"}
          </Button>
        </>
      )}>
        {/* 左槽只放「影响看到什么」的东西：本页固定一屏列表、无筛选控件（页码模式下
            关键词/模块筛选都没下推到本页），所以左槽在正常视图留空；回收站视图给一句
            这一屏能做什么，免得用户对着回收站列表找删除入口。 */}
        {shownRecycled && (
          <Typography.Text type="secondary" className="tp-text-sm">
            回收站里的用例可恢复；彻底删除要逐字输名
          </Typography.Text>
        )}
      </FilterBar>
      {/* 刻意不给 ×：脚注（:251）与空态都读 loadError，关掉这条会把「用例没取到」
          擦成「还没有 UI 用例」——一条能消证的错误提示，比没有提示更会骗人。 */}
      {loadError && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="ui-case-load-error"
          message="用例列表加载失败" description={loadError} />
      )}
      <AdminTable<Row> rowKey="id" loading={loading} dataSource={rows}
        pagination={false}
        locale={{ emptyText: loadError ? (
          // 失败不许画成空：kind="error" + 真重试把手，原文案逐字保留
          <StateView kind="error" title="用例列表没取到，以上方的加载失败提示为准"
            action={<Button size="small" onClick={() => void load()}>重试</Button>} />
        ) : (
          <StateView
            title={shownRecycled ? "回收站是空的"
              : canCreate ? "还没有 UI 用例，点「新建用例」进命令编辑器"
                : "还没有 UI 用例（你没有新建权限）"} />
        ) }}
        columns={[
          { title: "名称", dataIndex: "name", render: (v: string, r) => (
            // 回收站行名称不是链接：ui_case_get 对已回收用例回 404（case_services.py:211-212）。
            // 按**行自己**的 status 判（D180）：在途/失败窗口里后面的行还是正常行，摘链接就是说谎。
            r.status === "recycled"
              ? <span data-testid="ui-case-row-name">{v}</span>
              : (
                <Typography.Link data-testid="ui-case-row-name" onClick={() => nav("/ui/cases/" + r.id)}>
                  {v}
                </Typography.Link>)
          ) },
          // §11.4.18 回收站「删除人/删除时间」两列——模板整组读 shownRecycled（D180：跟数据走），
          // 单元格再按 r.status 逐行兜底。
          // 为什么必须守卫：同一份 updated_by/updated_at 在正常行上是「最后编辑人/时间」
          // （ui_case_update 也写它们，:256），标成「删除人」就是说谎；只有回收站里每行都是
          // 回收过的，最后那次写操作才恰好是回收本身（回收落 updated_by 见 case_services.py:285），
          // 「删除人」才名副其实。口径逐字同 uiElements.tsx:232-247。
          ...(shownRecycled ? [
            { title: "删除人", key: "delby", width: 96, render: (_: unknown, r: Row) => (
              // 非回收行不画（混合/陈旧数据里画了就是说谎）；查不到人落「—」，不拿 user id 冒充人名
              r.status === "recycled"
                ? <span data-testid="ui-case-recycled-by">{r.updated_by_name ?? "—"}</span>
                : <span>—</span>) },
            { title: "删除时间", key: "delat", width: 150, render: (_: unknown, r: Row) => (
              // 换算走 shared/timefmt（§3.4-6），同元素页；非回收行不画（同删除人列）
              r.status === "recycled" ? (
                <Typography.Text type="secondary" className="tp-text-sm" data-testid="ui-case-recycled-at">
                  {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
                </Typography.Text>) : <span>—</span>) },
          ] : []),
          { title: "优先级", dataIndex: "priority", width: 80, render: (v: string) => (
            <Tag color={PRIO_COLOR[v] ?? "default"}>{v}</Tag>) },
          { title: "启用", dataIndex: "enabled", width: 70, render: (v: boolean) => (
            <Tag color={v ? "green" : "default"}>{v ? "启用" : "停用"}</Tag>) },
          { title: "最近结果", key: "last", width: 110, render: (_, r) => {
            if (!r.last_run_status) return <Typography.Text type="secondary">未运行</Typography.Text>;
            const m = STATUSES[r.last_run_status] ?? null;
            return <Tag color={m?.color ?? "default"}>{m?.label ?? r.last_run_status}</Tag>;
          } },
          { title: "负责人", key: "owner", width: 110, render: (_, r) => (
            <span>{ownerLabel(r.owner_id, members)}</span>) },
          { title: "更新时间", key: "upd", width: 150, render: (_, r) => (
            <Typography.Text type="secondary" className="tp-text-sm">
              {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
            </Typography.Text>) },
          { title: "", key: "ops", width: 180, render: (_, r) => (
            // 行身份按 r.status 判（D180）：在途/失败时视图标记会与行脱节，恢复/彻底删除
            // 绝不落到正常行上。权限位分工不动（:40-43）：恢复挂 update、彻底删除挂 delete。
            r.status === "recycled"
              ? (
                <Space size={4}>
                  {canUpdate && (
                    <Button size="small" icon={<UndoOutlined />} data-testid="ui-case-restore"
                      onClick={() => void restoreOne(r)}>恢复</Button>
                  )}
                  {canDelete && (
                    <Button size="small" danger data-testid="ui-case-purge"
                      onClick={() => { setPurge(r); setPurgeName(""); }}>彻底删除</Button>
                  )}
                </Space>
              )
              // 正常视图的删除入口按 ui:case:delete 出现（隐藏不是禁用）；
              // 软删进回收站，恢复/彻底删除在回收站视图里做——同 adbCases.tsx:188-192。
              : (canDelete && (
                <Button size="small" danger data-testid="ui-case-del"
                  onClick={() => removeOne(r)}>删除</Button>)
              )
          ) },
        ]}
      />
      {/* D47-b 步5a：共享页码分页器。total 缺键（响应没带 total）时 ListPager 整块不渲染，
          这里垫在 Table 之下（居中垫法同 runs.tsx）。 */}
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
        {/* D47-b 步5a：「单页上限 200，后面还有没取的」随游标世界退役——页码模式下下一页
            永远点得到，「还有没取的」不再是脚注能说的事；「共 N 条」从此只有服务端 total
            这一张嘴（ListPager 报），脚注不再拿 rows.length 现攒。失败清行清 total，
            「上次取到 N 条（本次刷新失败，这个数可能已旧）」那条腿也没有意义了——失败就清行，
            这里只剩一句真话（照 api.tsx:656）。 */}
        {loadError ? "本次列表加载失败，本行计数不作数" : ""}
        {shownRecycled ? " · 回收站视图" : ""} ·
        「最近结果」只记正式执行（调试是过程，不回写结论）
      </Typography.Text>

      {/* 彻底删除：不可逆，逐字输名才放行 ok（与元素/场景/ADB 页同手感；服务端 :338 同样硬校验） */}
      <Modal open={purge !== null} onCancel={() => { setPurge(null); setPurgeName(""); }}
        width={520} title="彻底删除用例？" okText="我已确认，彻底删除" cancelText="取消"
        okButtonProps={{ danger: true, "data-testid": "ui-case-purge-ok",
          disabled: purgeName !== (purge?.name ?? ""), loading: purging }}
        onOk={() => void submitPurge()}>
        <Typography.Paragraph>
          「{purge?.name}」将被物理删除，<Typography.Text strong>无法恢复</Typography.Text>。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          输入用例名 <Typography.Text code>{purge?.name}</Typography.Text> 以确认。
        </Typography.Paragraph>
        <Input data-testid="ui-case-purge-confirm" value={purgeName} autoFocus
          placeholder={purge?.name} onChange={(e) => setPurgeName(e.target.value)} />
      </Modal>

      {/* 回收被场景引用 409（与 CaseList.tsx / api.tsx 的 D86 拦截弹窗同一份 DOM/文案，
          点名引用者与命中步骤；明细可见才给 force 第二步）。 */}
      <ScenarioRefsBlockModal
        subject={blocked?.row.name ?? ""}
        details={blocked?.details ?? null}
        testid="ui-case-scenario-block"
        busy={blocking}
        maySeeRefs={can(perms, "scenario:read")}
        blurb="回收不会删除用例，放进回收站后引用它的场景步骤会当场解析失败（restore 后原样回来）；也可先在场景里改引用。"
        onCancel={() => setBlocked(null)}
        onForce={() => void forceRemove()}
      />
    </>
  );
}

export default function UiCasesPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-ui-cases">
      <PageHead title="UI 用例" crumbs={["UI 测试"]}
        desc="命令序列组成的 UI 自动化用例；「最近结果」只记正式执行（调试属于过程，不回写结论）。" />
      <ProjectGate>{project ? <CasesList /> : null}</ProjectGate>
    </div>
  );
}
