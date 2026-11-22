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
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Input, Modal, Space, Table, Tag, Typography, message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { TagProps } from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr } from "../api/client";
import { planApi } from "../api/plan";
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

function PlanFormModal({ open, editing, projectId, onClose, onSaved }: {
  open: boolean;
  editing: PlanOut | null;
  projectId: string;
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
        await planApi.create({ project_id: projectId, name: name.trim(), description });
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
  const [rows, setRows] = useState<PlanOut[]>([]);
  // 页码状态只有这一份 useState（不进 URL、不进 localStorage——一页两把真相的老账）。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(50); // = 后端 PlanListIn 的 size 默认，起步不钳不漂
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ editing: PlanOut | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // D127 教训：load 读 current/pageSize 并把它们放进依赖，但 load 自己绝不写它们
  // （只有 pager 回调写）——取数落地不会重建 load、不会重跑 effect，点一次页恰好一条请求。
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const page = await planApi.list({ project_id: projectId, size: pageSize, current });
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
  }, [projectId, current, pageSize]);
  useEffect(() => { if (mayRead) void load(); }, [mayRead, load]);

  const upsert = (row: PlanOut): void => setRows((prev) => {
    const i = prev.findIndex((r) => r.id === row.id);
    if (i < 0) return prev; // 归档返回的行一定在表里；不在就不演「凭空多一行」
    const next = [...prev];
    next[i] = row;
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
        } catch { /* toast 已在 client 弹 */ } finally { setBusyId(null); }
      },
    });
  }

  const columns: ColumnsType<PlanOut> = [
    { title: "名称", dataIndex: "name", key: "name",
      render: (v: string, r) => (
        // 6b 已把 /plans/:id 接成真路由（app.tsx），点名字真去详情页——⑬ 当初钉住「暂不
        // 可点」的前提（catch-all 静默弹回工作台）随路由落地消失，入口与测试同批翻。
        <a data-testid={"plans-row-" + r.id} onClick={() => nav("/plans/" + r.id)}>{v}</a>
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
    { title: "操作", key: "ops", width: 200,
      render: (_: unknown, row: PlanOut) => (
        <Space size={4}>
          {canUpdate && (
            <Button size="small" data-testid={"plans-edit-" + row.id} disabled={busyId === row.id}
              onClick={() => setModal({ editing: row })}>编辑</Button>
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
    <div className="tp-fill tp-fill-body">
      <div style={{ flex: "0 0 auto" }}>
      <Space style={{ marginBottom: 12 }} wrap>
        {/* 刷新 = 重发当前页（load 读 current），不回第 1 页：把用户从第 3 页弹回第 1 页
            不是「刷新」这个词的意思。本页后端入参只有 project_id/current/size——**没有
            任何列表筛选**，这里就不摆筛选项（摆了必 400/被忽略 = 假门，ListToolbar 同判）。 */}
        <Button icon={<ReloadOutlined />} data-testid="plans-reload" onClick={() => void load()}>刷新</Button>
        {canCreate && (
          <Button type="primary" icon={<PlusOutlined />} data-testid="plans-create"
            onClick={() => setModal({ editing: null })}>新建计划</Button>
        )}
      </Space>
      {loadError && (
        // 不 closable：失败后这张表是空的（catch 里 setRows([])），这条 Alert 是「这一屏
        // 没取到」的唯一证据——给 × 等于发消证按钮，关掉后空表读起来和「没有计划」一模一样。
        <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="plans-load-error"
          message="测试计划列表加载失败" description={<EchoBlock text={loadError} />} />
      )}
      </div>
      <div data-testid="plans-table" className="tp-fill-body">
        <AdminTable<PlanOut> rowKey="id" loading={loading} dataSource={rows} columns={columns}
          pagination={false}
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

      <PlanFormModal open={modal !== null} editing={modal?.editing ?? null} projectId={projectId}
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
