// 通知渠道管理（§11.4.26，1E T2 前端补记）。后端已落地（commit 1efaf08）：
// /api/v1/notify-channels 五端点（list/get/create/patch + POST delete/test），
// 权限 notify:channel:{read,create,update,delete}——「测试发送」是 POST 但后端 perm 是
// notify:channel:read（读类动作，plan 里的 READONLY glob 口径），所以按钮跟读权限走。
//
// 本页特有的一条红线（计划 T2 前端补记原文）：config 里的密钥**只显示后端给的掩码原串**
// （`token前5位••••` / url query 段 `[已配置]` / `****(无法解密)`），前端绝不自己截断——
// 前端截 `••••` 就是第二条假门。编辑抽屉把回显原样放进输入框，保存时原样 PATCH 回去：
// 后端 merge_config_for_update 认定「值 == 打码回显 = 没改」保留旧密文（D24），
// 所以不改密钥的保存不会把掩码再加密一层。
//
// 诚实口径三处：① 渠道是平台级配置（models.py 无 project_id），列表不带项目过滤；
// ② 删除 409 in_use 的引用明细按 schedule:read 门控（details_hidden 时只报计数不编明细）；
// ③ 明细被 REF_DETAIL_CAP 截断时要说出口（count 是全量，截断不注明=用户以为找齐了）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert, Button, Drawer, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import { useAuth } from "../auth/store";
import { can, matchPerm, patternsForProject } from "../auth/perms";
import { get, patch, post, ApiErr } from "../api/client";
import type { Page } from "../api/api";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { tp, tpv } from "../theme";
import { FilterBar, Toolbar } from "../ui/Toolbar";
import type { components } from "../api/schema";

type Row = components["schemas"]["ChannelOut"];
type TestOut = components["schemas"]["ChannelTestOut"];
type CreateIn = components["schemas"]["ChannelCreateIn"];
type UpdateBody = components["schemas"]["notify_channel_update_body"];

/** last_send（D28 落账形状：service.py 的 notify_channel_test 写入）。 */
interface LastSend {
  ok?: boolean;
  latency_ms?: number;
  error?: string | null;
  raw?: string | null;
  checked_at?: string | null;
}

/** 删除 409 in_use 的 details（service.py 的 _schedule_refs + schedule:read 门控）。
 * details_truncated：后端正在补的字段（count 全量、tasks 按 REF_DETAIL_CAP 截断）。
 * 按可选处理——旧响应没有它，缺席时用 count > tasks.length 自推。 */
interface InUseDetails {
  channel_id: string;
  count: number;
  tasks: { task_id: string; name: string }[];
  details_hidden: boolean;
  details_truncated?: boolean;
}

// ── 类型元数据与配置表单字段（键名逐个对齐 senders.py 的真实消费，零假字段）──────

export type ChannelType = "WEBHOOK" | "DINGTALK" | "WECOM" | "FEISHU" | "EMAIL";

export const TYPE_META: Record<ChannelType, { label: string; color: string }> = {
  WEBHOOK: { label: "通用 Webhook", color: "geekblue" },
  DINGTALK: { label: "钉钉", color: "blue" },
  WECOM: { label: "企业微信", color: "green" },
  FEISHU: { label: "飞书", color: "purple" },
  EMAIL: { label: "邮箱", color: "orange" },
};
export const CHANNEL_TYPES = Object.keys(TYPE_META) as ChannelType[];

export interface ConfigField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
}

/**
 * 各类型配置字段 = senders.py 真实读取的键（_send_http 读 url/access_token(DINGTALK)，
 * _smtp_send 读 smtp_host/smtp_port/from_addr/to_addr/username/password）。
 * use_ssl/use_tls 不给开关：后端按端口自动推导（465→SSL），UI 不造后端不读的控件。
 */
export const CONFIG_FIELDS: Record<ChannelType, ConfigField[]> = {
  WEBHOOK: [
    { key: "url", label: "回调 URL", required: true, placeholder: "https://example.com/hook" },
  ],
  DINGTALK: [
    { key: "url", label: "机器人 Webhook URL", required: true,
      placeholder: "https://oapi.dingtalk.com/robot/send（access_token 可在下方单独填）" },
    { key: "access_token", label: "access_token（URL query 里带了就留空）", secret: true },
  ],
  WECOM: [
    { key: "url", label: "机器人 Webhook URL", required: true, placeholder: "https://qyapi.weixin.qq.com/..." },
  ],
  FEISHU: [
    { key: "url", label: "机器人 Webhook URL", required: true, placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/..." },
  ],
  EMAIL: [
    { key: "smtp_host", label: "SMTP 服务器", required: true, placeholder: "smtp.example.com" },
    { key: "smtp_port", label: "端口（465 自动走 SSL，其余自动 STARTTLS）", placeholder: "465" },
    { key: "from_addr", label: "发件地址（留空用登录账号）" },
    { key: "to_addr", label: "收件地址（多个用逗号分隔）", required: true },
    { key: "username", label: "登录账号（匿名 SMTP 留空）" },
    { key: "password", label: "登录密码/授权码", secret: true },
  ],
};

/**
 * 表单值 → 提交给后端的 config。以当前打码回显为底（未动的键原样送回 = 后端视为没改、
 * 保留旧密文——D24 merge_config_for_update 的契约），表单里的键按 trim 后覆盖、
 * 清空即删键。纯函数导出给测试钉「掩码原样送回、前端零加工」。
 */
export function buildConfig(
  stored: Record<string, unknown> | undefined,
  fields: ConfigField[],
  values: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(stored ?? {}) };
  for (const f of fields) {
    const v = (values[f.key] ?? "").trim();
    if (v) out[f.key] = v;
    else delete out[f.key];
  }
  return out;
}

export function missingRequired(
  fields: ConfigField[],
  values: Record<string, string>,
  stored: Record<string, unknown> | undefined,
): string[] {
  return fields.filter((f) => f.required
    && !(values[f.key] ?? "").trim()
    && stored?.[f.key] === undefined).map((f) => f.label);
}

/**
 * Ctrl+K ?q=<id> 直达的纯判断半边（与 uiElements.tsx / schedules.tsx 的高亮同一形状）：
 * id 在**已加载行**里才认（返回该 id 用于高亮），不在就返回 null——行真的不在
 * 加载集里（D47-b 页码制后：可能翻在其它页，或被类型筛选挡在服务端外）就老实
 * 什么都不标，绝不编一行出来。target 为空同样返回 null。抽成纯函数导出：这段「哪条是用户搜的
 * 那条」的判断是落点体验的命门，纯测试能钉住它，不必赌组件渲染。
 */
export function pickDeepLinkHit<T extends { id: string }>(rows: T[], target: string | null): string | null {
  if (!target || rows.length === 0) return null;
  return rows.some((r) => r.id === target) ? target : null;
}

// ── 小件 ─────────────────────────────────────────────────────────────────────

/** 后端/网络原话直出块（测试发送的 raw、错误 message 都走这里，不翻译不精简）。 */
function EchoBlock({ text, testid }: { text: string; testid?: string }) {
  return (
    <pre data-testid={testid} className="tp-text-sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all",
      background: tpv.bg.layout, padding: 12, borderRadius: tp.radius.md, margin: 0 }}>{text}</pre>
  );
}

/** 最近发送列（§11.4.26 行内 ✓/✗）：null=从没发过，绝不画成 ✓。 */
function LastSendCell({ ls }: { ls: LastSend | null | undefined }) {
  if (!ls || typeof ls.ok !== "boolean") return <Typography.Text type="secondary">从未发送</Typography.Text>;
  if (ls.ok) {
    return <Tag color="green" data-testid="notify-last-send">✓ {ls.latency_ms ?? 0}ms</Tag>;
  }
  return (
    <Tooltip title={ls.error ?? "发送失败（无错误详情）"}>
      <Tag color="red" data-testid="notify-last-send">✗ 失败</Tag>
    </Tooltip>
  );
}

// ── 新建/编辑抽屉（按类型切配置表单）──────────────────────────────────────────

function ChannelDrawer({ open, editing, onClose, onSaved }: {
  open: boolean;
  editing: Row | null;
  onClose: () => void;
  onSaved: (row: Row) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<ChannelType>("WEBHOOK");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // 每次打开（含切换编辑对象）都从当前行重置表单：config 预填 = 后端掩码回显**原样**，
  // 一个字都不加工——这既是显示口径也是 PATCH 语义（等值 = 没改）。
  useEffect(() => {
    if (!open) return;
    const t = (editing && (CHANNEL_TYPES as string[]).includes(editing.type) ? editing.type : "WEBHOOK") as ChannelType;
    setType(t);
    setName(editing?.name ?? "");
    const v: Record<string, string> = {};
    for (const f of CONFIG_FIELDS[t]) v[f.key] = String(editing?.config?.[f.key] ?? "");
    setValues(v);
  }, [open, editing]);

  async function submit(): Promise<void> {
    if (!name.trim()) { message.warning("渠道名称必填"); return; }
    const miss = missingRequired(CONFIG_FIELDS[type], values, editing?.config);
    if (miss.length) { message.warning("缺少必填配置：" + miss.join("、")); return; }
    const config = buildConfig(editing?.config, CONFIG_FIELDS[type], values);
    setBusy(true);
    try {
      if (editing) {
        const body: UpdateBody = { name: name.trim(), config };
        onSaved(await patch<Row>("/notify-channels/" + encodeURIComponent(editing.id), body));
        message.success("已保存（未改动的密钥按打码回显原样送回，后端保留原密文）");
      } else {
        const body: CreateIn = { name: name.trim(), type, config };
        onSaved(await post<Row>("/notify-channels", body));
        message.success("渠道已创建");
      }
      onClose();
    } catch { /* toast 已在 client 弹（409 重名/422 枚外都照报原话） */ } finally { setBusy(false); }
  }

  return (
    <Drawer open={open} onClose={onClose} width={520}
      title={editing ? `编辑渠道：${editing.name}` : "新建渠道"}
      extra={(
        <Button type="primary" loading={busy} data-testid="notify-channel-save" onClick={() => void submit()}>
          保存
        </Button>
      )}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input data-testid="notify-field-name" maxLength={200} value={name} autoFocus
            placeholder="如「钉钉群A」（全局唯一，重复会 409）" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>类型</Typography.Text>
          <Select data-testid="notify-field-type" style={{ width: "100%" }} value={type}
            disabled={editing !== null}
            onChange={(t) => { setType(t); setValues({}); }}
            options={CHANNEL_TYPES.map((t) => ({ value: t, label: `${TYPE_META[t].label}（${t}）` }))} />
          {editing && (
            <Typography.Text type="secondary" className="tp-text-sm">
              后端不支持改类型（PATCH 只收名称与配置）——换类型请新建后删除旧渠道。
            </Typography.Text>
          )}
        </div>
        {CONFIG_FIELDS[type].map((f) => (
          <div key={f.key}>
            <Typography.Text strong>{f.label}{f.required && <Typography.Text type="danger"> *</Typography.Text>}</Typography.Text>
            {f.secret
              ? <Input.Password data-testid={"notify-field-" + f.key} value={values[f.key] ?? ""}
                  placeholder={f.placeholder} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
              : <Input data-testid={"notify-field-" + f.key} value={values[f.key] ?? ""}
                  placeholder={f.placeholder} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />}
          </div>
        ))}
        {editing && (
          <Alert type="info" showIcon
            message="配置里显示的是后端给的打码回显（前5位•••• / [已配置]），不是明文。"
            description="不改动密钥就原样保存，后端识别为「没改」并保留旧密文；要换密钥就整段替换成新值。" />
        )}
      </Space>
    </Drawer>
  );
}

// ── 页体 ─────────────────────────────────────────────────────────────────────

function ChannelsPanel() {
  const { project, user } = useAuth();
  const perms = patternsForProject(project, user?.is_system_admin);
  const canCreate = can(perms, "notify:channel:create");
  const canUpdate = can(perms, "notify:channel:update");
  const canDelete = can(perms, "notify:channel:delete");
  // 409 引用明细后端按 schedule:read 门控（details_hidden），前端同尺判断要不要显示列表
  const maySeeSchedule = matchPerm(perms, "schedule:read");

  const [rows, setRows] = useState<Row[]>([]);
  // D47-b：页码分页（current/size/total）替换「加载更多」游标追加。一页只许有一个
  // 「我在第几页」的真相——按钮和页码并存就是两把尺子，后端拿 400 禁的正是这个。
  // 原固定 size=200 不在档位表（20/50/100）里，取最接近的 100 起步：单页确实比以前少拉一半，
  // 但「共 N 条」与页码会把其余的说出来——不是悄悄变少，数据一条不会「消失」。
  // （抽屉里候选渠道、以及 schedules.tsx 的渠道候选仍 size=200：那是选项全集，不是本页列表。）
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [total, setTotal] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ editing: Row | null } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testRes, setTestRes] = useState<{ name: string; out: TestOut } | null>(null);
  const [inUse, setInUse] = useState<{ row: Row; details: InUseDetails } | null>(null);

  // Ctrl+K 直达落点（?q=<渠道id>）：那一条标出来。形状逐字抄 uiElements.tsx:70-78，
  // 三条来由在那边的注释里都挨过打，这里一条都不能丢：
  // ① seenQ 同一串 q 只认一次——用户关掉横幅之后不会被查询串「复活」（api.tsx ?def= 同顾虑）；
  // ② 记「上一个认过的 id」而不是一次性 latch：hash 直访是同文档导航，组件不重建，
  //    一次性 latch 会让第二次 Ctrl+K 落点继续高亮上一条（uiElements 自己就被钉测出来过）；
  // ③ 等 rows 加载完再认（rows.length 挡在 effect 里而不是交给 helper 返回 null，
  //    否则空列表会把这串 q 认成「找不到」并 latch 死，加载完也不会再认一次）。
  // 本页的类型筛选是服务端参数：行在 rows 里就一定在表里，横幅只有一种话；
  // 行不在 rows（D47-b 页码制：可能翻在其它页上，或被类型筛选挡在服务端外）时
  // helper 返回 null——老实什么都不标，不编一行。「在别的页」这个信息前端手上
  // 没有（只有当前页的行），横幅宁可不说也不能编。
  const [sp] = useSearchParams();
  const [hitId, setHitId] = useState<string | null>(null);
  const seenQ = useRef<string | null>(null);
  useEffect(() => {
    const target = sp.get("q");
    if (!target || seenQ.current === target || rows.length === 0) return;
    seenQ.current = target;
    setHitId(pickDeepLinkHit(rows, target));
  }, [sp, rows]);

  // 类型筛选是页体唯一的列表筛选，也是它唯一的写入口：改筛选必回第 1 页——停在第 7 页
  // 换筛选，落的是新条件下无关的切片甚至空页（listPagination.tsx 注释③同一 hazard）。
  // 回页钉在这唯一入口处，测试从第 3 页改筛选钉它。
  const applyTypeFilter = (v: string | undefined): void => { setTypeFilter(v); setCurrent(1); };

  // D127 的教训换了形态仍然成立：load 读 current/pageSize 并把它们放进依赖，但 load
  // 自己绝不写 current/pageSize（只有 pager 回调和 applyTypeFilter 写），所以取数
  // 落地不会重建 load、不会重跑下面的 effect——点一次页码恰好一条请求。
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const q = new URLSearchParams({ size: String(pageSize), current: String(current),
        ...(typeFilter ? { type: typeFilter } : {}) });
      const page = await get<Page<Row>>("/notify-channels?" + q.toString(), { silent: true });
      setRows(page.items);
      // total 只从响应来，永不由 items.length 客户端现攒（页内行数不是总数）。
      // 缺键（后端尚未上页码模式）→ null → ListPager 整块不渲染。
      setTotal(page.total ?? null);
    } catch (e) {
      setRows([]);
      // 失败不留谎脚注：total 清空，不许在空表上面挂一条陈旧的「共 N 条」。
      setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "渠道列表加载失败");
    } finally { setLoading(false); }
  }, [typeFilter, current, pageSize]);
  useEffect(() => { void load(); }, [load]);

  const upsert = (row: Row) => setRows((prev) => {
    const i = prev.findIndex((r) => r.id === row.id);
    if (i < 0) return [...prev, row];
    const next = [...prev];
    next[i] = row;
    return next;
  });

  // 落点那条的名字（横幅用）；行不在已加载集里时 hitId 就是 null，这里自然空。
  const hitRow = useMemo(() => rows.find((r) => r.id === hitId) ?? null, [rows, hitId]);

  // WHY 截断必须说出口：count 是全量、tasks 被 REF_DETAIL_CAP 截过（service.py:35/:73），
  // 只列前几条不注明，用户会以为找齐了，「先解绑再删」就无从执行。details_truncated 是
  // 后端在补的字段：缺席时按 count > tasks.length 自推，前后都真；条数取自 payload，
  // 前端不复刻后端的 20。只在明细可见分支渲染（见 inUse 弹窗）。
  const iuTruncated = inUse !== null
    && (inUse.details.details_truncated ?? inUse.details.count > inUse.details.tasks.length)
    && inUse.details.count > inUse.details.tasks.length;

  /** 测试发送：POST /test（后端 perm 是 notify:channel:read——读类动作跟读权限走）。 */
  async function testOne(row: Row): Promise<void> {
    setTestingId(row.id);
    try {
      const out = await post<TestOut>("/notify-channels/" + encodeURIComponent(row.id) + "/test", {}, { silent: true });
      setTestRes({ name: row.name, out });
      if (out.last_send) upsert({ ...row, last_send: out.last_send });
    } catch (e) {
      // 404/500 层故障（渠道没了/后端炸）——原话弹窗，与 ok=false 同一入口
      if (e instanceof ApiErr) setTestRes({ name: row.name, out: { ok: false, latency_ms: 0, error: e.message, raw: null, last_send: null } });
    } finally { setTestingId(null); }
  }

  function removeOne(row: Row): void {
    Modal.confirm({
      title: `删除渠道「${row.name}」？`,
      content: "硬删除，不可恢复。被定时任务引用时后端会拦下（409）并列出引用，先解绑再删。",
      okText: "删除", okButtonProps: { danger: true, "data-testid": "notify-channel-delete-ok" }, cancelText: "取消", centered: true,
      onOk: async () => {
        try {
          await post("/notify-channels/" + encodeURIComponent(row.id) + "/delete", {});
          message.success("已删除");
          setRows((prev) => prev.filter((r) => r.id !== row.id));
        } catch (e) {
          if (e instanceof ApiErr && e.code === "in_use") {
            setInUse({ row, details: e.details as InUseDetails }); // 拦截不是失败：弹窗点名引用方
          } // 其余错误 toast 已弹
        }
      },
    });
  }

  const columns = [
    { title: "名称", dataIndex: "name", key: "name",
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    { title: "类型", dataIndex: "type", key: "type", width: 150,
      render: (t: string) => {
        const m = TYPE_META[t as ChannelType];
        return <Tag color={m?.color ?? "default"} data-testid="notify-channel-type">{m ? `${m.label} ${t}` : t}</Tag>;
      } },
    { title: "关键配置（后端打码回显）", dataIndex: "config", key: "config",
      render: (cfg: Row["config"], row: Row) => (
        <div data-testid={"notify-channel-config-" + row.id}>
          {Object.keys(cfg ?? {}).length === 0 && <Typography.Text type="secondary">（无配置）</Typography.Text>}
          {Object.entries(cfg ?? {}).map(([k, v]) => (
            <div key={k} className="tp-text-sm" style={{ wordBreak: "break-all" }}>
              <Typography.Text type="secondary">{k}:</Typography.Text> {String(v)}
            </div>
          ))}
        </div>
      ) },
    { title: "最近发送", dataIndex: "last_send", key: "last_send", width: 130,
      render: (ls: Row["last_send"]) => <LastSendCell ls={ls as LastSend | null} /> },
    { title: "操作", key: "ops", width: 220,
      render: (_: unknown, row: Row) => (
        <Space size={4}>
          {/* 测试 = notify:channel:read（后端就是这条 perm，读得到才谈得上测） */}
          <Button size="small" loading={testingId === row.id} data-testid={"notify-channel-test-" + row.id}
            onClick={() => void testOne(row)}>发送测试</Button>
          {canUpdate && (
            <Button size="small" data-testid={"notify-channel-edit-" + row.id}
              onClick={() => setDrawer({ editing: row })}>编辑</Button>
          )}
          {canDelete && (
            <Button size="small" danger data-testid={"notify-channel-remove-" + row.id}
              onClick={() => removeOne(row)}>删除</Button>
          )}
        </Space>
      ) },
  ];

  return (
    <div className="tp-fill tp-fill-body">
      <div style={{ flex: "0 0 auto" }}>
      <FilterBar actions={(
        <Toolbar>
          {/* 刷新 = 重发当前页（load() 读 current），不回第 1 页：把用户从第 3 页弹回
              第 1 页不是「刷新」这个词的意思。 */}
          <Button icon={<ReloadOutlined />} data-testid="notify-channel-reload" onClick={() => void load()}>刷新</Button>
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} data-testid="notify-channel-create"
              onClick={() => setDrawer({ editing: null })}>新建渠道</Button>
          )}
        </Toolbar>
      )}>
        <Select allowClear placeholder="按类型筛选" style={{ width: 176 }} value={typeFilter}
          data-testid="notify-channel-filter" onChange={(v) => applyTypeFilter(v)}
          options={CHANNEL_TYPES.map((t) => ({ value: t, label: `${TYPE_META[t].label}（${t}）` }))} />
      </FilterBar>
      {loadError && (
        // 不 closable：同 schedules.tsx:758 —— 失败时表里零行，这条是「这一屏没取到」的唯一
        // 证据，× 关掉后只剩一张空表，读起来就是「还没有渠道」。它消失只该靠刷新成功。
        <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="notify-channel-load-error"
          message="渠道列表加载失败" description={<EchoBlock text={loadError} />} />
      )}
      {hitRow && (
        <Alert type="info" showIcon closable data-testid="notify-channel-hit" style={{ marginBottom: 12 }}
          message={"快捷搜索定位到「" + hitRow.name + "」——已在下表标出这一行。"}
          description="这条是 Ctrl+K 直达带过来的：URL 里带着渠道 id，页面把它认出来并高亮那一行。"
          onClose={() => setHitId(null)} />
      )}
      </div>
      <AdminTable rowKey="id" loading={loading} dataSource={rows} columns={columns}
          rowClassName={(r: Row) => (r.id === hitId ? "tp-row-hit" : "")}
          pagination={false}
          expandable={{
            rowExpandable: (row: Row) => (row.last_send as LastSend | null)?.raw != null,
            // §11.4.26「原始响应」展开：后端收到的对端原文 raw 直出，不加工
            expandedRowRender: (row: Row) => {
              const ls = row.last_send as LastSend | null;
              return (
                <div data-testid={"notify-channel-raw-" + row.id}>
                  <Typography.Text type="secondary" className="tp-text-sm">
                    最近发送 {fmtTime(ls?.checked_at) ?? "时间未知"} · 延迟 {ls?.latency_ms ?? 0}ms
                  </Typography.Text>
                  {ls?.raw != null && <EchoBlock text={String(ls.raw)} testid="notify-channel-raw-text" />}
                </div>
              );
            },
          }}
          cardFooter={(
            // 脚注与页码住进卡底（业主点名：卡有边有角，小字却散在卡外的页面底色上）。
            <div className="tp-cardfoot">
              <Typography.Text className="tp-cardfoot-note tp-text-sm" type="secondary">
              渠道是平台级配置（全项目共用，无项目归属）；密钥列显示的是后端打码回显，前端不加工。
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

      <ChannelDrawer open={drawer !== null} editing={drawer?.editing ?? null}
        onClose={() => setDrawer(null)} onSaved={upsert} />

      {testRes && (
        <Modal open title={`发送测试：${testRes.name}`} width={640} centered okText="关闭"
          cancelButtonProps={{ style: { display: "none" } }}
          okButtonProps={{ "data-testid": "notify-test-close" }}
          onOk={() => setTestRes(null)} onCancel={() => setTestRes(null)}>
          <div data-testid="notify-test-result">
            <Alert style={{ marginBottom: 12 }} showIcon type={testRes.out.ok ? "success" : "error"}
              message={testRes.out.ok ? `发送成功（${testRes.out.latency_ms ?? 0}ms）`
                : `发送失败（${testRes.out.latency_ms ?? 0}ms）：${testRes.out.error ?? "未知错误"}`} />
            {testRes.out.raw != null && (
              <>
                {/* 「未改写」说的是内容，不含长度：senders.py 的 RAW_CAP 先截过再回传，
                    只说「未改写」会让用户把截断片段当成对端全文去比对。数字在前端不复刻。 */}
                <Typography.Text type="secondary" className="tp-text-sm">
                  对端原始响应（未翻译未改写；后端按长度截断，可能不是全文）：
                </Typography.Text>
                <EchoBlock text={String(testRes.out.raw)} testid="notify-test-raw" />
              </>
            )}
          </div>
        </Modal>
      )}

      {inUse && (
        <Modal open title="删除被拦截：该渠道被定时任务引用" width={560} centered okText="知道了"
          cancelButtonProps={{ style: { display: "none" } }}
          okButtonProps={{ "data-testid": "notify-inuse-close" }}
          onOk={() => setInUse(null)} onCancel={() => setInUse(null)}>
          <div data-testid="notify-inuse">
            <Typography.Paragraph>
              「{inUse.row.name}」被 <Typography.Text strong>{inUse.details.count}</Typography.Text> 个定时任务引用，先解绑再删。
            </Typography.Paragraph>
            {inUse.details.details_hidden || !maySeeSchedule ? (
              <Typography.Paragraph type="secondary">
                引用明细需要定时任务查看权限（schedule:read），当前不可见。
              </Typography.Paragraph>
            ) : (
              <>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {inUse.details.tasks.map((t) => <li key={t.task_id} data-testid="notify-inuse-task">{t.name}</li>)}
                </ul>
                {iuTruncated && (
                  <Typography.Paragraph type="secondary" data-testid="notify-inuse-truncated">
                    仅列前 {inUse.details.tasks.length} 条，另有 {inUse.details.count - inUse.details.tasks.length} 个未列出。
                  </Typography.Paragraph>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function NotifyChannelsPage() {
  const { project, user } = useAuth();
  // D165：渠道是平台级配置（payload 无 project_id），后端 build_ctx（core/service.py:205-213）
  // 对非系统管理员恒给 {"auth:*"} ⇒ 五端点全 403，连列表都读不到。而 PROJECT_ADMIN 的
  // ["*","-system:*"] 盖得住 notify:channel:*——按项目 perms 画门是 UX 假门（不是安全洞，
  // 后端方向保守）。对齐 ModelTab（settings.tsx:46）的 isSysAdmin && can(...) 挂载形状：
  // 非系统管理员不挂页体 = 列表 GET 也不发（发了必 403，别让用户看错误脸），整页诚实空态。
  // 不用 PermEmpty：它的申请文案指向「项目管理员」，而项目管理员给不了系统管理员身份——
  // 指一条走不通的路是另一句假话，这里用 Alert 直说身份口径。路由本身不藏（D47 进得去家族）。
  const perms = patternsForProject(project, user?.is_system_admin);
  const mayEnter = Boolean(user?.is_system_admin) && can(perms, "notify:channel:read");
  return (
    <div data-testid="page-notify-channels" className="tp-fill-stack">
      <PageHead title="通知渠道" descHover
        desc="执行结果的通知出口（平台级配置）；发送回执落库，刷新不回退。" />
      <ProjectGate>
        {mayEnter ? <ChannelsPanel /> : (
          <Alert type="info" showIcon data-testid="notify-channel-admin-only"
            message="通知渠道是平台级配置，仅系统管理员可管理"
            description="渠道无项目归属，后端只对系统管理员身份放行；当前账号不是系统管理员，本页不发起请求。" />
        )}
      </ProjectGate>
    </div>
  );
}
