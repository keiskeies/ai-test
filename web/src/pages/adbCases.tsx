// ADB 用例列表页（§11.5.5，1D T9）。uiCases.tsx 的近亲孪生：同一套六列、同一套
// 权限隐藏（不是禁用）、同一套「最近结果只记正式执行」的口径。
// 契约（nav.spec.mjs 钉死）：根 testid `page-adb-cases` + PageHead「ADB 用例」+ ProjectGate，
// .tp-page-title 每页恰好一个。
// 与 UI 孪生的两处有意差异（都有后端事实撑腰，不是随手改样式）：
// ① 多一列「默认设备」：adb_case.default_device 是执行策略本体（serial / 任一空闲），
//    列表不显示它就等于让用户对着「不知道会打到哪台机器」的用例做决策；
// ② 有回收站视图：adb 端点 delete/restore/purge 三件套已落地（T7），UI 侧列表没做
//    回收站入口是它的历史欠账，这里不做「跟孪生一样缺」的辩护——有端点就诚实给入口。
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Empty, Input, Modal, Space, Tag, Typography, message } from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get, post } from "../api/client";
import { adbCaseApi, type AdbCaseOut } from "../api/adbCase";
import { ownerLabel, MEMBERS_FAILED, MEMBERS_LOADING, membersReady, type MemberLookup } from "../shared/ownerName";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { ListToolbar, useColumnPrefs } from "../shared/listToolbar/ListToolbar";
import type { Option } from "../shared/listToolbar/ListToolbar";
import { applyColumnPrefs, emptyFilter, isFilterEmpty } from "../shared/listFilters";
import type { ColumnChoice, FilterDoc } from "../shared/listFilters";
import { STATUSES } from "../shared/runVocab";
import type { Page } from "../api/api";

type Row = AdbCaseOut;
type MemberRow = { user_id: string; account: string | null; name: string | null };

const PRIO_COLOR: Record<string, string> = { P0: "red", P1: "volcano", P2: "blue", P3: "default" };

// D217：列设置面板要露的列（key 与 columns 的 key 逐字一致）。回收站独有的
// 「删除人/删除时间/操作」不进清单——它们跟着视图走，不跟着偏好走。
const ADB_COL_CHOICES: ColumnChoice[] = [
  { key: "name", label: "名称" },
  { key: "prio", label: "优先级" },
  { key: "dev", label: "默认设备" },
  { key: "enabled", label: "启用" },
  { key: "last", label: "最近结果" },
  { key: "owner", label: "负责人" },
  { key: "upd", label: "更新时间" },
];

// adb 运行的 error 全来自「没跑成」（debug_services.py _run_status:275-289 / _finish_error
// :331-371，如「用例不可执行：默认设备…不在本项目可用设备里」），一条 adb 运行里没有
// HTTP 请求，runVocab 的「请求失败」在这一列是错配。runVocab.ts 与后端 pattern 逐字
// 相等不许动，这里只在本页改这个词，颜色仍取 STATUSES.error 不漂移。
const ADB_RUN_LABEL: Record<string, string> = { error: "执行失败" };

function CasesList() {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canCreate = can(perms, "adb:case:create");
  const canDelete = can(perms, "adb:case:delete");
  const canUpdate = can(perms, "adb:case:update");
  const [rows, setRows] = useState<Row[]>([]);
  // 成员表是「负责人」列的名字来源。三态而不是 {}：加载中/拉挂了都不能把人判成
  // 「非项目成员」（那是冤枉人），详见 shared/ownerName.ts。
  const [members, setMembers] = useState<MemberLookup>(MEMBERS_LOADING);
  const [loading, setLoading] = useState(false);
  const [inRecycled, setInRecycled] = useState(false);
  // D180：回收站模板跟「已到货的数据」而不是点击——inRecycled 点击瞬间翻，行要等下一次
  // list() 落定才换，那窗口按视图位挂回收列就是给活行套「删除人/彻底删除」。shownRecycled
  // 只在成功路径赋值；失败不翻（页码模式失败清行，旧行不留在屏上——「不翻」此刻的意义是
  // 空表也不许挂回收站列/字样，见 adbCases.test.tsx 的 500 用例）。
  const [shownRecycled, setShownRecycled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // D47-b 步5a：页码分页（current/size/total）退役「拉一页 200 + 脚注猜有没有下一页」。
  // 默认档位 20 是 ListPager 档位表（20/50/100）里的真值（口径同 uiCases.tsx 孪生页）。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  // D217：高级搜索条件 + 列偏好（列设置落盘键 adb_case，与 filter-meta 的 view_type 同源）
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());
  const [colPref, setColPref] = useColumnPrefs("adb_case", ADB_COL_CHOICES.map((c) => c.key));
  // D273：批量选择（正常视图=批量回收，回收站=批量恢复）。换视图/翻页清空——批量钮只对
  // 当前可见行有意义，留着的名单按下去操作的是屏幕上看不见的行。
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => { setSelected([]); }, [inRecycled, current, pageSize]);
  // inRecycled 只有这一个写入口（runs.tsx 的 patch 同款）：三个 setState 各写各的时，
  // 漏接一个 setCurrent(1) 没人拦得住——停在第 3 页点回收站，落的是回收集里无关的切片
  // （listPagination.tsx 注释③ 的同一个 hazard）。
  const toggleRecycled = (): void => { setInRecycled((v) => !v); setCurrent(1); };
  // D217：高级搜索是第二类筛选，与回收站开关同一条「改条件必回第 1 页」纪律
  const patchAdv = (next: FilterDoc): void => { setAdvFilter(next); setCurrent(1); };

  // load 依赖 [pid, inRecycled, current, pageSize]，**绝不把 rows 放进去**：load 自己
  // setRows(新数组)——写者进自己的依赖就是「响应→新 rows→load 换身份→effect 重跑→再请求」
  // 的无限回路（reports.tsx 步3b 付过的学费），fetch 桩深拷 + 挂载恰好一条请求的绊线在
  // adbCases.test.tsx 头一条用例上兜它。load 也从不写 current/pageSize/inRecycled。
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 请求永不带 cursor：current+cursor 同传后端直接 400，一页两把尺子正是被禁的那件事
      const r = await adbCaseApi.listCases({
        project_id: pid, size: pageSize, current,
        ...(inRecycled ? { recycled: true } : {}),
        // D217：空条件不上线（不是 filter=），非空才拼条件组 JSON
        ...(isFilterEmpty(advFilter) ? {} : { filter: JSON.stringify(advFilter) }) });
      // 页码模式是替换语义：第 3 页的行就只画第 3 页的，别页的行必须下桌。
      setRows(r.items);
      // total 只从响应来，永不由 rows.length 客户端现攒（页内行数不是总数）。
      // 缺键（后端尚未上页码模式的游标式响应）→ null → ListPager 整块不渲染。
      setTotal(r.total ?? null);
      // D180：模板只在这一行（成功路径）追平点击；catch 里照旧清行，但
      // shownRecycled 不动——「回收站视图」的列/文案不先于到货的回收行说出口。
      setShownRecycled(inRecycled);
    } catch (e) {
      // 清行本来就是本页既有口径（孪生 uiCases 的老「不清行」随页码一起退役，见其 catch 注释）；
      // 页码模式下它还多了一层必要性：陈旧行 + 新 current 同屏就是「我在第几页」的两把尺子，
      // 与后端禁 cursor+current 同罪（api.tsx 步4b 同款理由）。total 一并清空——
      // 空表上面挂一条陈旧的「共 N 条」是第二句谎（D180 不变量不丢：shownRecycled 失败不翻）。
      setRows([]);
      setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "用例列表加载失败");
    } finally { setLoading(false); }
  }, [pid, inRecycled, current, pageSize, advFilter]);
  useEffect(() => { void load(); }, [load]);
  // 负责人列要名字不是 id：成员表拉一次。失败如实标 failed（ownerLabel 会说「名字未取到」），
  // 不静默把 uuid 当名字摊出去——同 uiCases.tsx 一起改的口径。
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

  function removeOne(r: Row): void {
    Modal.confirm({
      centered: true,
      title: `把「${r.name}」放入回收站？`,
      content: "软删，可随时恢复；彻底删除需逐字确认名称。",
      okText: "放入回收站", okButtonProps: { danger: true, "data-testid": "adb-case-del-ok" }, cancelText: "取消",
      onOk: async () => {
        try {
          await adbCaseApi.removeCase(pid, r.id);
          message.success("已放入回收站");
          await load();
        } catch { /* toast 已在 client 里弹 */ }
      },
    });
  }

  async function restoreOne(r: Row): Promise<void> {
    try {
      await adbCaseApi.restoreCase(pid, r.id);
      message.success("已恢复");
      await load();
    } catch { /* 回收期间重名被占 409：toast 说人话，不静默改名 */ }
  }

  // —— D273 批量回收/恢复（判据在后端：全有或全无；批量不提供 force，同 api.tsx D251/D252）——
  const [batchRemoving, setBatchRemoving] = useState(false);
  async function doBatchRemove(): Promise<void> {
    setBatchRemoving(true);
    try {
      await post("/adb-cases/batch-delete", { project_id: pid, case_ids: selected });
      message.success("已放入回收站（" + selected.length + " 条用例）");
      setSelected([]);
      await load();
    } catch (e) {
      const blk = (e instanceof ApiErr
        ? (e.details as { blocked?: { name: string; count: number }[] } | null)
        : null)?.blocked;
      if (blk && blk.length > 0) {
        Modal.error({
          centered: true,
          title: "整批未回收：有用例被场景引用",
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
  function batchRemove(): void {
    Modal.confirm({
      centered: true,
      title: "把选中的 " + selected.length + " 条用例放入回收站？",
      content: "全有或全无：只要有一条被未回收场景引用，整批都不会删。软删，可随时恢复。",
      okText: "放入回收站", okButtonProps: { danger: true },
      onOk: doBatchRemove,
    });
  }

  const [batchRestoring, setBatchRestoring] = useState(false);
  async function doBatchRestore(): Promise<void> {
    setBatchRestoring(true);
    try {
      await post("/adb-cases/batch-restore", { project_id: pid, case_ids: selected });
      message.success("已恢复（" + selected.length + " 条用例）");
      setSelected([]);
      await load();
    } catch { /* client 已 toast（名被占 409 等）；选择保留让用户改名单 */ }
    finally { setBatchRestoring(false); }
  }
  function batchRestore(): void {
    Modal.confirm({
      centered: true,
      title: "恢复选中的 " + selected.length + " 条用例？",
      content: "全有或全无：只要有一条不在回收站或名字已被占用，整批都不会恢复。",
      okText: "恢复",
      onOk: doBatchRestore,
    });
  }

  // 彻底删除：逐字输名（后端 name_mismatch 同样硬校验）
  const [purge, setPurge] = useState<Row | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [purging, setPurging] = useState(false);

  // D217：高级搜索的候选值全部复用页面已在手的数据（成员表/优先级/执行结果词表），
  // 不为一个下拉再拉第二遍；成员表没就绪时不给候选，用户仍可按原值精确筛。
  const filterValueOptions: Record<string, Option[]> = {
    priority: ["P0", "P1", "P2", "P3"].map((v) => ({ value: v, label: v })),
    last_run_status: Object.entries(STATUSES).map(([k, v]) => ({ value: k, label: v.label })),
    owner_id: members.state === "ready"
      ? Object.entries(members.names).map(([k, v]) => ({ value: k, label: v })) : [],
  };
  async function submitPurge(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      await adbCaseApi.purgeCase(pid, purge.id, purgeName);
      message.success("已彻底删除，用例名可以重新使用");
      setPurge(null); setPurgeName("");
      await load();
    } catch { /* name_mismatch 等保持弹窗打开重试（toast 已弹） */ }
    finally { setPurging(false); }
  }

  return (
    <div className="tp-fill tp-fill-body">
      <div style={{ flex: "0 0 auto" }}>
      {/* D217：D47-a 三件套铺到 ADB 用例页。快捷入口（新建/回收站）留在下一行，
          高级搜索管任意组合，两者并存不互相替代。 */}
      <ListToolbar
        projectId={pid} viewType="adb_case"
        filter={advFilter} onFilterChange={patchAdv}
        valueOptions={filterValueOptions}
        allColumns={ADB_COL_CHOICES} columnPref={colPref} onColumnPrefChange={setColPref}
        canSaveView={can(perms, "search:view:create")}
        canDeleteView={can(perms, "search:view:delete")}
      />
      <Space style={{ marginBottom: 12 }} wrap>
        {canCreate && !inRecycled && (
          <Button type="primary" icon={<PlusOutlined />} data-testid="adb-case-new"
            onClick={() => nav("/adb/cases/new")}>
            新建用例
          </Button>
        )}
        <Button data-testid="adb-case-recycled" type={inRecycled ? "primary" : "default"}
          onClick={toggleRecycled}>{inRecycled ? "退出回收站" : "♻ 回收站"}</Button>
      </Space>
      {/* D273 批量条（api.tsx 的 D251/D252 同口径）：选中才出现；正常视图 [批量回收]，
          回收站 [批量恢复]——彻底删除仍要求逐字确认名称，不做批量。 */}
      {canDelete && !inRecycled && selected.length > 0 && (
        <Space style={{ marginBottom: 8 }} data-testid="adb-case-batch-bar">
          <Typography.Text>已选 {selected.length} 项</Typography.Text>
          <Button size="small" danger data-testid="adb-case-batch-delete"
            loading={batchRemoving} onClick={batchRemove}>批量回收</Button>
          <Button size="small" data-testid="adb-case-clear-selection" onClick={() => setSelected([])}>取消选择</Button>
        </Space>
      )}
      {canUpdate && inRecycled && selected.length > 0 && (
        <Space style={{ marginBottom: 8 }} data-testid="adb-case-batch-bar">
          <Typography.Text>已选 {selected.length} 项</Typography.Text>
          <Button size="small" type="primary" icon={<ReloadOutlined />} data-testid="adb-case-batch-restore"
            loading={batchRestoring} onClick={batchRestore}>批量恢复</Button>
          <Button size="small" data-testid="adb-case-clear-selection" onClick={() => setSelected([])}>取消选择</Button>
        </Space>
      )}
      {/* 刻意不给 ×：脚注与空态都读 loadError（:140/:212），关掉这条就把「列表加载失败」
          擦成「还没有 ADB 用例」+「共 0 条」——能关掉的故障陈述，等于给了个消证据的按钮。
          要它消失只有刷新成功一条路（同 reportDetail.tsx:346「报告没取到」不 closable）。 */}
      {loadError && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="adb-case-load-error"
          message="用例列表加载失败" description={loadError} />
      )}
      </div>
      <AdminTable<Row>
        size="middle" rowKey="id" loading={loading} dataSource={rows}
        pagination={false}
        rowSelection={(!inRecycled && canDelete) || (inRecycled && canUpdate) ? {
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys.map(String)),
          preserveSelectedRowKeys: false,
        } : undefined}
        locale={{ emptyText: loadError ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="用例列表未取到，以上方的加载失败提示为准" />
          : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={shownRecycled ? "回收站是空的"
              : canCreate ? "还没有 ADB 用例，点「新建用例」进步骤编辑器"
              : "还没有 ADB 用例（你没有新建权限）"} />
        ) }}
        columns={applyColumnPrefs([
          { title: "名称", dataIndex: "name", key: "name", render: (v: string, r) => (
            <Typography.Link data-testid="adb-case-row-name" onClick={() => nav("/adb/cases/" + r.id)}>
              {v}
            </Typography.Link>) },
          { title: "优先级", dataIndex: "priority", key: "prio", width: 80, render: (v: string) => (
            <Tag color={PRIO_COLOR[v] ?? "default"}>{v}</Tag>) },
          { title: "默认设备", key: "dev", width: 160, render: (_, r) => (
            r.default_device
              ? <Typography.Text className="tp-text-sm" data-testid="adb-case-row-device">{r.default_device}</Typography.Text>
              : <Tag data-testid="adb-case-row-device" color="blue">任一空闲</Tag>) },
          { title: "启用", dataIndex: "enabled", key: "enabled", width: 70, render: (v: boolean) => (
            <Tag color={v ? "green" : "default"}>{v ? "启用" : "停用"}</Tag>) },
          { title: "最近结果", key: "last", width: 110, render: (_, r) => {
            if (!r.last_run_status) return <Typography.Text type="secondary">未运行</Typography.Text>;
            const m = STATUSES[r.last_run_status] ?? null;
            return <Tag color={m?.color ?? "default"}>
              {ADB_RUN_LABEL[r.last_run_status] ?? m?.label ?? r.last_run_status}
            </Tag>;
          } },
          { title: "负责人", key: "owner", width: 110, render: (_, r) => (
            <span>{ownerLabel(r.owner_id, members)}</span>) },
          { title: "更新时间", key: "upd", width: 150, render: (_, r) => (
            <Typography.Text className="tp-text-sm" type="secondary">
              {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
            </Typography.Text>) },
          ...(shownRecycled
            ? [
              // §11.4.18 回收站「删除人/删除时间」。语义（为什么只许在这里出现）：同一份
              // updated_by/updated_at 在正常行上是「最后编辑人/最后编辑时间」，只有回收行上
              // 那次写操作就是回收本身（case_services.py:228-229 写状态同写人）——把它标成
              // 「删除人」。正常视图挂这两列就是说谎，所以整段按 shownRecycled 守卫（D180：
              // 跟到货数据不跟点击），行内再按 r.status 逐行把关——混进来的活行也不配这两列。
              // 人名只认后端解析的 updated_by_name（查不到 → 「—」，不许回填 id）；
              // 时间换算走 fmtTime（§3.4-6 UTC 存 / Asia/Shanghai 展示）。
              { title: "删除人", key: "deleter", width: 100, render: (_: unknown, r: Row) => (
                r.status === "recycled"
                  ? <span data-testid="adb-case-row-deleter">{r.updated_by_name ?? "—"}</span>
                  : null) },
              { title: "删除时间", key: "delat", width: 150, render: (_: unknown, r: Row) => (
                r.status === "recycled" ? (
                  <Typography.Text className="tp-text-sm" type="secondary" data-testid="adb-case-row-delat">
                    {fmtTime(r.updated_at, { seconds: false }) ?? "—"}
                  </Typography.Text>
                ) : null) },
            ]
            : []),
          ...(shownRecycled
            ? [{ title: "操作", key: "ops", width: 160, render: (_: unknown, r: Row) => (
              // D180：按钮逐行认 r.status——恢复/彻底删除绝不长在 status:normal 的行上；
              // 混进回收列表的活行拿正常视图那个删除入口，行说自己是活的那就按活的画。
              r.status === "recycled" ? (
              <Space size={4}>
                {canUpdate && (
                  <Button size="small" data-testid={"adb-case-restore-" + r.id}
                    onClick={() => void restoreOne(r)}>恢复</Button>
                )}
                {canDelete && (
                  <Button size="small" danger data-testid={"adb-case-purge-" + r.id}
                    onClick={() => { setPurge(r); setPurgeName(""); }}>彻底删除</Button>
                )}
              </Space>
              ) : (canDelete ? (
                <Button size="small" danger data-testid="adb-case-del"
                  onClick={() => removeOne(r)}>删除</Button>) : null)) }]
            // 正常视图的删除入口按 adb:case:delete 出现（隐藏不是禁用）；
            // 软删进回收站，恢复/彻底删除在回收站视图里做。
            : (canDelete ? [{ title: "操作", key: "ops", width: 90, render: (_: unknown, r: Row) => (
              <Button size="small" danger data-testid="adb-case-del"
                onClick={() => removeOne(r)}>删除</Button>) }] : [])),
        ], colPref)}
        cardFooter={(
          // 脚注与页码住进卡底（业主点名：卡有边有角，小字却散在卡外的页面底色上）。
          <div className="tp-cardfoot">
            <Typography.Text type="secondary" className="tp-cardfoot-note tp-text-sm">
            {/* D47-b 步5a：「单页上限 200，后面还有没取的」随游标世界退役——页码模式下下一页
                永远点得到，「还有没取的」不再是脚注能说的事；「共 N 条」从此只有服务端 total
                这一张嘴（ListPager 报），脚注不再拿 rows.length 现攒。失败清行清 total，
                这里只剩一句真话（照 api.tsx:656）。 */}
            {loadError ? "本次列表加载失败，本行计数不作数" : ""}
            {shownRecycled ? " · 回收站视图" : ""}
            {(loadError || shownRecycled) ? " · " : ""}
            「最近结果」只记正式执行（调试是过程，不回写结论）；「任一空闲」= 执行时锁第一台未被占用（未回收且启用）的设备，心跳离线不剔除它
            </Typography.Text>
            <ListPager
              current={current}
              pageSize={pageSize}
              total={total}
              onPage={setCurrent}
              onPageSize={setPageSize}
            />
          </div>
        )}
      />

      <Modal centered open={purge !== null} onCancel={() => { setPurge(null); setPurgeName(""); }}
        width={520} title="彻底删除用例？" okText="我已确认，彻底删除" cancelText="取消"
        okButtonProps={{ danger: true, "data-testid": "adb-case-purge-ok",
          disabled: purgeName !== (purge?.name ?? ""), loading: purging }}
        onOk={() => void submitPurge()}>
        <Typography.Paragraph>
          「{purge?.name}」将被物理删除，<Typography.Text strong>无法恢复</Typography.Text>。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          输入用例名 <Typography.Text code>{purge?.name}</Typography.Text> 以确认。
        </Typography.Paragraph>
        <Input data-testid="adb-case-purge-confirm" value={purgeName} autoFocus
          placeholder={purge?.name} onChange={(e) => setPurgeName(e.target.value)} />
      </Modal>
    </div>
  );
}

export default function AdbCasesPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-adb-cases" className="tp-fill-stack">
      <PageHead title="ADB 用例" descHover
        desc="面向 Android 设备的 UI 自动化步骤；执行前需有可用设备。" />
      <ProjectGate>{project ? <CasesList /> : null}</ProjectGate>
    </div>
  );
}
