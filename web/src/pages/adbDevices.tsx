// ADB 设备管理（§11.4.14 卡片墙，1D T9）。
// 契约（nav.spec.mjs 钉死）：根 testid `page-adb-devices` + PageHead「设备管理」+ ProjectGate，
// .tp-page-title 每页恰好一个。
// D47-b 步5e（后端半边 = 26f4dde）：三档筛选（state=空闲/占用/离线）与页码分页（current/size +
// 服务端 total）全部下推，本页不再「拉 200 条再本地过滤」；占用读数随行返回（一次 mget 批量读锁），
// 逐台 GET /occupation 的 N+1 退场（refreshOne 的「改动一台刷新这一台」保留，那不是 N+1）。
// 四条本页特有的判断：
// ① 卡片状态带：三档筛选词（全部/空闲/占用/离线）与后端 state 词表逐字对齐（D18：§11.4.14 mock
//    只有这三种，「异常红」不造）；另有一个**仅显示用的第四态「占用未知」**——在线但行上没有
//    占用读数（occupation=null，批量读锁故障时整页同缺）时画它，绝不塌缩回「空闲」（见 cardStateOf）。
//    它不进筛选条：后端兑现不了这个筛选项，摆了就是假按钮（§13 纪律 1）。
//    离线是**灰且安静**的，不是故障红——心跳把 online=False 的帧原样落库，卡片如实画灰。
// ② 占用徽标只显后端随行给出的真实读数（D17：「预计 3m」没有公式出处，编数字就是假数据
//    ——本页一根时间估算都不出现）。
// ③ 「测试连接/添加」的失败文案**原样回显**：后端 422 的 message 里是 adb 的 stderr/stdout
//    或安装指引（T4 的设计目的就是让操作员看到真 adb 输出排错），所以 <pre> 直出，
//    不翻译、不精简、不吞进 toast。
// ④ 编辑（D121，蓝图 :1391 的卡片「编辑」）只开浅字段弹窗：name/enabled/project_public
//    走 PATCH，且按后端 None 语义**只送改动过的字段**（device_services.py:218-234）；
//    serial 只读展示——后端对改串号直接 422（:227-230），重验唯一入口是「测试连接」。
// 按钮按权限**隐藏不是禁用**（settings.spec 钉的手感）：无 adb:device:create 不渲染「添加设备」，
// 无 :update 不渲染重连/编辑（D121 起「编辑」真渲染浅字段弹窗，此前只有本注释在空头承诺），
// 无 :manage（D159：管理员位，MEMBER 被 -*:manage 拒）不渲染强制释放，
// 无 :delete 不渲染删除。/test 是 POST 但权限是
// adb:device:read（读类动作不写库），所以「测试」按钮跟读权限走，不按「POST 即写」猜。
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Card, Checkbox, Drawer, Input, Modal, Segmented, Space, Switch,
  Tag, Tooltip, Typography, message,
} from "antd";
import { DeleteOutlined, PlusOutlined, ReloadOutlined, UndoOutlined } from "../ui/icons";
import StateView from "../ui/StateView";
import { FilterBar } from "../ui/Toolbar";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { ApiErr, get } from "../api/client";
import { adbApi, type AdbDeviceOut, type AdbDevicePurgeDetails,
  type AdbDeviceRowOccupation, type DeviceListInput } from "../api/adb";
import { reportApi } from "../api/report";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { ListToolbar } from "../shared/listToolbar/ListToolbar";
import { emptyFilter, isFilterEmpty } from "../shared/listFilters";
import type { FilterDoc } from "../shared/listFilters";
import type { components } from "../api/schema";

// 本地别名沿用原形状（antd 的 Row 组件占值空间，import 改名会两头撞名）
type Row = AdbDeviceOut;
type TestOut = components["schemas"]["AdbDeviceTestOut"];

// ── 纯逻辑（adbDevices.test.tsx 直接测这些，行为不靠浏览器）─────────────────────

/** 卡片状态（§11.4.14 左状态带 4px）：离线灰 > 占用蓝 > 空闲绿；unknown 是仅显示态。
 *  色值一律取 CSS var（深浅两套自动跟随；`tp.*` 的静态值在深色下会偏暗）。 */
export type DeviceCardState = "offline" | "occupied" | "idle" | "unknown";

export const CARD_COLOR: Record<DeviceCardState, string> = {
  offline: "var(--tp-text-4)", occupied: "var(--tp-func-processing)",
  idle: "var(--tp-primary-500)", unknown: "var(--tp-func-warning)",
};
export const CARD_LABEL: Record<DeviceCardState, string> = {
  offline: "离线", occupied: "占用", idle: "空闲", unknown: "占用未知",
};

/**
 * row + 行上的占用读数 → 卡片状态。占用判据只认**随行返回**的读数（D47-b 步 5e：
 * 一次 mget 批量读锁，occupation 随行走）：
 * - `occupation == null`（Redis 故障时后端逐行给 null，**一次影响整页**）→「占用未知」，
 *   绝不塌缩成「空闲」——旧版「读数缺失退化为在线=空闲」的兜底在批量读失败下会一次
 *   撒一页谎（加这个仅显示态是**我（本轮 Claude）按 §13 纪律 1 的裁决，不是业主裁的** ——
 *   业主在本页只裁过 §五·4「补齐后端：批量占用 + state 下推」那一条，没裁过这个；
 *   业主若要改口径，改的就是这一处。「占用未知」不进筛选条：后端兑现不了这个筛选项，
 *   摆了就是假按钮，同一纪律）。
 * - 离线优先于一切——心跳说设备不在线，锁在不在都没意义（§五·实测前提 5：离线压倒占用）。
 * - last_state 缺失 = 从没测过 = 未探测，按灰（离线）处理，与后端离线谓词 IS NOT TRUE 同尺。
 */
export function cardStateOf(row: Row, occ: AdbDeviceRowOccupation | null | undefined): DeviceCardState {
  if (row.last_state?.online !== true) return "offline";
  if (occ == null) return "unknown";
  return occ.occupied ? "occupied" : "idle";
}

/**
 * 电量徽标阈值（§11.4.14「电86%」）：<20 红、<=50 橙、其余绿。
 * **null/undefined 说「电量未知」**——建连首帧就没有电量（心跳才读 dumpsys battery），
 * 画 0% 是假数据，画「—」又会被读成设备坏了，所以明说「未知」。
 */
export function batteryBadge(level: number | null | undefined): { text: string; color: string } {
  if (level === null || level === undefined || Number.isNaN(level)) {
    return { text: "电量未知", color: "default" };
  }
  const l = Math.max(0, Math.min(100, Math.round(level)));
  const color = l < 20 ? "red" : l <= 50 ? "orange" : "green";
  return { text: `电 ${l}%`, color };
}

/**
 * 排队徽标（D17）：只显 /occupation 的真实读数 queued（持有者之后的等候人数）。
 * 措辞「排队 #n」+ tooltip 说清语义边界：这是「队列里有几个人」，不是「你排第几」
 * （个人位次要到发起执行 acquire 那一刻才有）。sketch 的「预计3m」不做——编数字是假数据。
 */
export function queueBadgeLabel(queued: number | null | undefined): string | null {
  if (!queued || queued <= 0) return null;
  return `排队 #${queued}`;
}

/** 相对时间（sketch 的「最后心跳3m前」）；now 由调用方注入（纯函数可测）。 */
export function agoLabel(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const s0 = iso.trim();
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s0) ? s0 : s0 + "Z");
  if (Number.isNaN(d.getTime())) return null;
  const s = Math.max(0, Math.floor((nowMs - d.getTime()) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)}m前`;
  if (s < 86400) return `${Math.floor(s / 3600)}h前`;
  return `${Math.floor(s / 86400)}d前`;
}

/**
 * D169：解析持有者 token `run:{run_id}:{attempt}:{host}:{pid}`（execution/adb_lock.py
 * make_token；host 段可带冒号，uuid 不含，故 parts[1] 即 run_id）。形状不认识返回 null，
 * 界面把原串摊到「原始持有标识」位（此刻唯一的证据），不硬凑 run id。
 */
export function parseHolder(holder: string | null | undefined): { runId: string } | null {
  const parts = (holder ?? "").split(":");
  if (parts[0] !== "run" || parts.length < 4 || !parts[1]) return null;
  return { runId: parts[1] };
}

/** 已执行时长（D169 抽屉，打开时快照）：naive UTC 补 Z 后换算差值，不实时跳动。 */
export function elapsedLabel(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const s0 = iso.trim();
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s0) ? s0 : s0 + "Z");
  if (Number.isNaN(d.getTime())) return null;
  const s = Math.max(0, Math.floor((nowMs - d.getTime()) / 1000));
  for (const [div, suf] of [[86400, "d"], [3600, "h"], [60, "m"]] as [number, string][]) {
    if (s >= div) return `${Math.floor(s / div)}${suf}`;
  }
  return `${s}s`;
}

/** D169 占用详情抽屉的取数快照（打开时一次，不实时跳动；见抽屉内注释）。 */
interface OccInfo {
  row: Row; raw: string | null; runId: string | null; loading: boolean; openedAt: number;
  // D141：这条 run 走 GET /runs/{id}（RunOut.subject_name = str，列 NOT NULL 快照），
  // 旧声明 string | null 与 :652 的「…已删除」假兜底都是不可达的谎，已删。
  // 注意与 :378 区分：那里是 run_step_result.subject_name，**可空是真契约**（0015 迁移）。
  run: { subject_name: string; subject_type: string; started_at: string | null } | null;
  runFailed: boolean; steps: { n: number; last: string | null } | null; stepsFailed: boolean;
}

/** 后端 MessageIn.content 上限 20000（backend/app/modules/agent/routes.py:33），超限会被 422——预填侧先自查截断。 */
export const PILOT_DRAFT_MAX = 20000;

/**
 * 「让 Pilot 排查」的预填简报（D84 诚实切片）：只拼本页该设备卡片**实际持有**的读数——
 * 名称/序列号/卡片状态/电量/占用/心跳 + 所属项目。
 * 占用读数缺失（行上 occupation=null，批量读锁故障整页同缺）就明写「占用读数缺失」，
 * 绝不拿「空闲」顶替；
 * 缺失字段的整行省略，不编值。这只是**填进输入框的草稿**，发不发由人按发送——
 * 不建会话、不传 context 字段（协议没这东西，D29）。
 * 回收站视图没有这个出口（邻居「测试连接/重连」在那里同样隐藏），所以回收行的
 * updated_by/updated_at 是「删除人/删除时间」而不是「最后编辑」——正常视图里挂上去
 * 就是说谎（见卡片注释），这里也照同样的诚实规则不拼。
 */
export function pilotDraftFor(row: Row, occ: AdbDeviceRowOccupation | null | undefined, opts: {
  projectName: string | null | undefined; nowMs: number;
}): string {
  const st = cardStateOf(row, occ);
  const state = row.last_state ?? null;
  const lines: string[] = [
    "请帮我排查这台 ADB 设备（以下均为设备卡片墙当前读数，非推测）：",
    `- 设备：${row.name}`,
    `- 序列号：${row.serial}`,
  ];
  if (opts.projectName) lines.push(`- 项目：${opts.projectName}`);
  lines.push(`- 卡片状态：${CARD_LABEL[st]}${row.enabled ? "" : "（已停用）"}`);
  const level = state?.battery_level as number | null | undefined;
  if (level !== null && level !== undefined && !Number.isNaN(level)) {
    lines.push(`- 电量：${batteryBadge(level).text}`);
  }
  if (occ == null) {
    // 卡上此刻没有占用读数（批量读锁故障/该键读失败）——草稿如实说缺失
    lines.push("- 占用读数缺失（本次列表未随行返回占用读数，不能据此断定空闲/占用）");
  } else {
    lines.push(`- 占用：${occ.occupied ? `被 ${occ.holder ?? "未知"} 持有` : "无人持有"}`);
    if (occ.queued && occ.queued > 0) lines.push(`- 排队：${occ.queued} 人`);
  }
  const ago = agoLabel(state?.last_check_at as string | null | undefined, opts.nowMs);
  const stamp = ago && state?.last_check_at ? `（${fmtTime(state.last_check_at as string) ?? ""}）` : "";
  lines.push(`- 心跳：${ago ? `最后心跳 ${ago}${stamp}` : "尚无心跳"}`);
  const text = lines.join("\n");
  return text.length > PILOT_DRAFT_MAX ? text.slice(0, PILOT_DRAFT_MAX) : text;
}

// ── 页体 ────────────────────────────────────────────────────────────────────

// 三档筛选词与后端 state 词表逐字对齐（schemas.py AdbDeviceListIn.state 的 Literal）；
// 「全部」= 不带 state 参数。「占用未知」（读数缺失的显示态）**不在这里**：后端兑现不了
// 这个筛选项，摆了就是假按钮（§13 纪律 1），它只在卡片上出现。
const FILTERS = ["全部", "空闲", "占用", "离线"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_TO_STATE: Record<Exclude<Filter, "全部">, "idle" | "occupied" | "offline"> = {
  空闲: "idle", 占用: "occupied", 离线: "offline",
};

/** adb 原样回显：错误 message（含 stderr/stdout 或安装指引）整段 <pre> 直出。 */
function EchoBlock({ text }: { text: string }) {
  return (
    <pre data-testid="adb-echo-text" className="tp-mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all",
      background: "var(--tp-bg-layout)", padding: 12, borderRadius: "var(--tp-radius-md)", margin: 0 }}>{text}</pre>
  );
}

/** 卡片墙上「测试连接」的成功回执：连接原话 + 机型/系统 + base64 PNG 截图内联。 */
function TestResultModal({ name, out, onClose }: { name: string; out: TestOut; onClose: () => void }) {
  return (
    <Modal open title={`测试连接：${name}`} width={480} centered okText="关闭"
      cancelButtonProps={{ style: { display: "none" } }}
      okButtonProps={{ "data-testid": "adb-test-close" }} onOk={onClose} onCancel={onClose}>
      <div data-testid="adb-test-result">
        <Alert style={{ marginBottom: 12 }} showIcon type={out.ok ? "success" : "error"}
          message={out.message}
          description={out.ok && (out.model || out.os_version)
            ? `机型 ${out.model ?? "未知"} · 系统 ${out.os_version ?? "未知"}` : undefined} />
        {!out.ok && (
          <Typography.Paragraph className="tp-text-sm" type="secondary">
            以上是 adb 的原始输出（未翻译未改写）。常见原因：设备未先执行过 adb connect、
            不在同一网段、5555 端口未开无线调试。
          </Typography.Paragraph>
        )}
        {out.screenshot_b64 ? (
          <img data-testid="adb-test-shot" alt="设备截屏"
            style={{ maxWidth: 220, borderRadius: 8, border: "1px solid var(--tp-border)" }}
            src={"data:image/png;base64," + out.screenshot_b64} />
        ) : out.ok ? (
          <Typography.Text type="secondary">这次没截到图（screencap 未回 PNG 字节）。</Typography.Text>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * 添加设备弹窗（§11.4.14：名称 + WiFi 地址 + [测试连接]，成功才允许保存）。
 * 计划 vs 现实的形状差异（不藏）：后端**没有**「未入库 serial 的独立预验端点」——
 * /test 只认已入库的 device_id；连新串号的唯一入口就是 create 本身（先 connect+getprop
 * 验证、失败 422 且零脏行、成功才 201）。所以这里的 [测试连接] 就是「验证并添加」：
 * 失败 → 弹窗不关、adb 原话整段回显、库里没有这台设备（后端 test_create_connect_fail_is_loud_422
 * 钉过零脏行）；成功 → 真入库并刷新卡片墙。「失败绝不入库、成功才允许保存」由后端保证，
 * 界面不另造一个假的分步状态机。
 */
function AddDeviceModal({ open, pid, onClose, onCreated }: {
  open: boolean; pid: string; onClose: () => void; onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [serial, setSerial] = useState("");
  const [pub, setPub] = useState(true);
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!name.trim()) { message.warning("设备名必填"); return; }
    if (!serial.trim()) { message.warning("WiFi 地址必填（ip:port）"); return; }
    setBusy(true);
    setEcho(null);
    try {
      await adbApi.createDevice({
        project_id: pid, name: name.trim(), serial: serial.trim(),
        connect_type: "wifi", wifi_addr: null, enabled: true, project_public: pub,
      });
      message.success("连接验证通过，设备已入库（首帧已落）");
      setName(""); setSerial(""); setPub(true);
      onClose();
      await onCreated();
    } catch (e) {
      if (e instanceof ApiErr) setEcho(e.message); // 422：adb 原话 / 安装指引；409：重名说法照报
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} title="添加设备" width={560} centered okText="测试连接并添加" cancelText="取消"
      confirmLoading={busy} okButtonProps={{ "data-testid": "adb-device-add-ok" }}
      onCancel={() => { setEcho(null); onClose(); }} onOk={() => void submit()}>
      <Space direction="vertical" style={{ width: "100%" }} size={10}>
        <Input data-testid="adb-device-name" maxLength={200} value={name} autoFocus
          placeholder="设备名，如「Pixel6」（项目内唯一）" onChange={(e) => setName(e.target.value)} />
        <Input data-testid="adb-device-add-serial" maxLength={64} value={serial}
          placeholder="WiFi 地址 ip:port，如 192.168.1.20:5555"
          onChange={(e) => setSerial(e.target.value)} onPressEnter={() => void submit()} />
        <Space>
          <Switch data-testid="adb-device-public" checked={pub} onChange={setPub} size="small" />
          <Typography.Text className="tp-text-sm" type="secondary">项目内公开（关掉后仅自己可见）</Typography.Text>
        </Space>
        <Typography.Text className="tp-text-sm" type="secondary">
          保存前会真的执行 adb connect + getprop 验证；连不上不会入库，下面是 adb 的原话。
          USB 直连一期不开放写入口（D14）。
        </Typography.Text>
        {echo !== null && (
          <div data-testid="adb-device-add-echo">
            <EchoBlock text={echo} />
          </div>
        )}
      </Space>
    </Modal>
  );
}

/**
 * 编辑设备弹窗（D121，蓝图 :1391 的卡片「编辑」）：只开后端 PATCH 认的浅字段
 * name/enabled/project_public（device_services.py:218-234）。三处形状差异不藏：
 * ① serial 只读展示——PATCH 改串号被后端 422 挡（:227-230「连不上的对象不该静默
 *    入库」），重验唯一入口是「测试连接」，这里就原样引用后端那句话，不自造说法；
 * ② 提交按后端 None 语义**只送改动过的字段**（:218/:231/:233 全是 `is not None` 才动），
 *    一个没改就不发请求；
 * ③ 重名 409（含回收站占位变体）的消息由 client toast 原话弹回、弹窗不关，留着重改。
 */
function EditDeviceModal({ row, open, onClose, onSaved }: {
  row: Row | null; open: boolean; onClose: () => void; onSaved: () => Promise<void>;
}) {
  // 每次打开用当前行重置（antd Modal 不 destroyOnClose，不用 remount 就得自己同步）
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [pub, setPub] = useState(true);
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState<string | null>(null);
  if (open && row && seeded !== row.id) {
    setSeeded(row.id);
    setName(row.name); setEnabled(row.enabled === true); setPub(row.project_public === true);
  }
  const serial = row?.serial ?? "";

  // 关窗时清掉种子标记：下次打开（哪怕同一行）也按当下最新的 row 重新预填，
  // 不吃上一轮编辑后的残值。
  function close(): void {
    setSeeded(null);
    onClose();
  }

  async function submit(): Promise<void> {
    if (!row) return;
    const nm = name.trim();
    if (!nm) { message.warning("设备名必填"); return; }
    // None 语义：只有真改动的字段进 body（name 两侧空格吃掉后与原名相等 = 没改）
    const body: {
      project_id: string; name?: string; enabled?: boolean; project_public?: boolean;
    } = { project_id: row.project_id };
    if (nm !== row.name) body.name = nm;
    if (enabled !== (row.enabled === true)) body.enabled = enabled;
    if (pub !== (row.project_public === true)) body.project_public = pub;
    if (Object.keys(body).length === 1) { close(); return; } // 没改就不 PUT 一个空 PATCH 出去
    setBusy(true);
    try {
      await adbApi.updateDevice(row.id, body);
      message.success("已保存");
      close();
      await onSaved();
    } catch {
      // 409 重名（含「设备名在回收站占位」变体）：toast 已原话弹回，弹窗留着重改
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} title={`编辑设备：${row?.name ?? ""}`} width={480} centered okText="保存"
      cancelText="取消" confirmLoading={busy} destroyOnHidden
      okButtonProps={{ "data-testid": "adb-device-edit-ok" }}
      onCancel={close} onOk={() => void submit()}>
      <Space direction="vertical" style={{ width: "100%" }} size={10}>
        <div>
          <Typography.Text className="tp-text-sm" type="secondary">设备名（项目内唯一）</Typography.Text>
          <Input data-testid="adb-device-edit-name" maxLength={200} value={name} autoFocus
            onChange={(e) => setName(e.target.value)} />
        </div>
        <Space>
          <Switch data-testid="adb-device-edit-enabled" checked={enabled} onChange={setEnabled} size="small" />
          <Typography.Text className="tp-text-md">启用（关掉后不再被调度选中）</Typography.Text>
        </Space>
        <Space>
          <Switch data-testid="adb-device-edit-public" checked={pub} onChange={setPub} size="small" />
          <Typography.Text className="tp-text-md">项目内公开（关掉后仅自己可见）</Typography.Text>
        </Space>
        <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ marginBottom: 0 }}
          data-testid="adb-device-edit-serial-hint">
          串号只读：<Typography.Text code>{serial}</Typography.Text>
          ——改串号/连接方式请走「测试连接」重验。后端原话：改 serial/connect_type 请用设备的「测试连接」端点完成重验，不直接
          PATCH——连不上的对象不该静默入库。
        </Typography.Paragraph>
      </Space>
    </Modal>
  );
}

function DevicesWall() {
  const { project, user } = useAuth();
  const nav = useNavigate();
  const pid = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const canCreate = can(perms, "adb:device:create");
  const canUpdate = can(perms, "adb:device:update");
  const canManage = can(perms, "adb:device:manage");
  const canDelete = can(perms, "adb:device:delete");

  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<Filter>("全部");
  const [inRecycled, setInRecycled] = useState(false);
  // D180：回收站模板跟「已到货的数据」而不是点击。inRecycled 在点击瞬间翻，行却要等
  // 下一次 list() 落定才换——那段窗口（和取数一直失败期间）按视图位挂回收模板，就是
  // 给活行套「删除人/彻底删除」。shownRecycled 只在 fetch 成功路径赋值，模板只认它。
  const [shownRecycled, setShownRecycled] = useState(false);
  const [loading, setLoading] = useState(false);
  // 503 lock_store_unavailable（占用档读不到锁）与 400 state_filter_too_broad（在线超 2000）
  // 各说自己那腿的话（title 按 code 分流）；其余失败维持通用标题 + 原话回显。
  const [loadError, setLoadError] = useState<{ code: string; message: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // D47-b 步5e：页码分页（current/pageSize/total）替换「拉 200 条本地过滤 + 游标 hasMore」。
  // 默认档位 20 在 ListPager 档位表（20/50/100）里、后端 size 上限（le=200）内。
  // current 只有 pager 回调与 patchFilters 写，load 永不写它（一页只许有一个「我在第几页」的真相）。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState<number | null>(null);
  // D224：高级搜索条件（D47-a 三件套铺到设备页）。卡片墙不是表格——没有可切列的列设置，
  // 所以不给 allColumns（组件在 allColumns 为空时不渲染那个按钮，不摆一个点了没反应的假钮）；
  // state 三档仍是页面自己的 Segmented，两条轴在服务端并行 AND。
  const [advFilter, setAdvFilter] = useState<FilterDoc>(emptyFilter());

  // 两类筛选（状态档/回收站开关）只有 patchFilters 这一个写入口，「回第 1 页」钉在唯一
  // 入口处——停在第 7 页改筛选，落的是新条件下无关的切片甚至空页（listPagination.tsx
  // 注释③同款 hazard）；各 setState 漏接一个回页没人拦得住。
  const patchFilters = useCallback((p: { filter?: Filter; inRecycled?: boolean }): void => {
    if ("filter" in p) setFilter(p.filter!);
    if ("inRecycled" in p) setInRecycled(p.inRecycled!);
    setCurrent(1);
  }, []);

  // load 依赖 [pid, inRecycled, filter, current, pageSize]，**绝不把 rows 或 total 放进去**：
  // load 自己 setRows/setTotal(新对象)——写者进自己的依赖就是「响应→新 rows→load 换身份→
  // effect 重跑→再请求」的无限回路（uiElements 步5d 实测：症状是整份测试文件挂死而不是
  // 报红，5s 用例超时被同一条微任务链饿死；测试侧 LIST_STORM_CAP 刹车兜它）。
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 页码模式（D47-b 步5e）：current 一上线就是「这页要第几页」的唯一口径，请求永不带
      // cursor——current+cursor 同传后端直接 400，一页两把尺子正是被禁的那件事。
      const q: DeviceListInput = { project_id: pid, size: pageSize, current };
      if (inRecycled) q.recycled = true;
      if (filter !== "全部") q.state = FILTER_TO_STATE[filter]; // 全部 = 不带 state 参数
      // D224：空条件整个参数不上线（与 filterQuery 同口径）；qs() 负责 URL 编码。
      if (!isFilterEmpty(advFilter)) q.filter = JSON.stringify(advFilter);
      const r = await adbApi.listDevices(q);
      // 页码模式是替换语义：第 3 页的行就只画第 3 页的，别页的行必须下桌。
      setRows(r.items);
      // total 只从响应来，永不由 rows.length 客户端现攒（页内行数不是总数）。
      // 缺键（后端未给 total 的响应形状）→ null → ListPager 整块不渲染。
      setTotal(r.total ?? null);
      // D180：模板只在这一行（成功路径）追平点击；失败路径不动 shownRecycled——
      // 「回收站视图」不先于到货的回收行说出口。
      setShownRecycled(inRecycled);
      setNowMs(Date.now());
    } catch (e) {
      // D47-b 步5e：页码模式下失败**清行清 total**（旧「失败不清行」的口径随游标世界一起
      // 退役，这是有意分歧不是回归，scenes/uiCases/uiElements 同款）：陈旧行 + 新 current
      // 同屏就是「我在第几页」的两把尺子，与后端禁 cursor+current 同罪。
      // 503/400 尤其不许演成「这一档没有设备」：行与 total 都清零后，空态卡被 loadError
      // 挡住、pager 被 total=null 挡住，屏幕上只剩下面那条分腿说清的 Alert（§13 纪律 1）。
      setRows([]);
      setTotal(null);
      setLoadError(e instanceof ApiErr
        ? { code: e.code, message: e.message }
        : { code: "", message: "设备列表加载失败" });
    } finally { setLoading(false); }
  }, [pid, inRecycled, filter, current, pageSize, advFilter]);
  useEffect(() => { void load(); }, [load]);

  // D47-b 步5e：旧「filter 在本地按卡片状态过滤 visible」的 useMemo 已整块删除——
  // 三档筛选全部下推成 state= 参数（词表与后端逐字对齐），墙上画的就是服务端筛后的当前页；
  // 占用读数随行返回，本地 occ 映射表与逐台 GET /occupation 的 N+1 一起退场。

  const [echo, setEcho] = useState<{ title: string; text: string } | null>(null);
  const [testRes, setTestRes] = useState<{ name: string; out: TestOut } | null>(null);
  const [adding, setAdding] = useState(false);
  // D121：编辑弹窗的目标行（null = 关）
  const [editing, setEditing] = useState<Row | null>(null);

  // 单点刷新（改动一台之后刷新这一台：重连/强制释放的收尾）——这不是 N+1，逐台 GET
  // /occupation 只留这一处按 id 取最新；读数写回该行的 occupation 键（随行读数的形状）。
  const refreshOne = useCallback(async (d: Row) => {
    try {
      const [row, o] = await Promise.all([adbApi.getDevice(pid, d.id), adbApi.occupation(pid, d.id)]);
      const merged: Row = { ...row, occupation: { occupied: o.occupied, holder: o.holder, queued: o.queued } };
      setRows((prev) => prev.map((x) => (x.id === d.id ? merged : x)));
    } catch { /* toast 已在 client 里弹 */ }
  }, [pid]);

  async function testOne(d: Row): Promise<void> {
    try {
      setTestRes({ name: d.name, out: await adbApi.testDevice(pid, d.id) });
    } catch (e) {
      // /test 对「连不上」不抛（ok=false 带原话）；抛出来的是 404/500 层故障，同样原话弹窗
      if (e instanceof ApiErr) setEcho({ title: `测试连接失败：${d.name}`, text: e.message });
    }
  }

  // D84 诚实切片：把该卡片当前读数拼成草稿带进 /bench 的输入框，人过目后自己按发送。
  // 不建会话、不给协议加 context 字段——只是预填，发不发在人。
  function askPilot(d: Row): void {
    const draft = pilotDraftFor(d, d.occupation, { projectName: project?.name, nowMs });
    nav("/bench", { state: { pilotDraft: draft } });
  }

  // D169 占用详情抽屉（蓝图 :1391）：点占用卡的「占用」标签打开；取数是打开时一次快照
  // （活时长每秒跳位对「要不要强制释放」没有增量信息）。run 详情与报告 allSettled 互不拖累。
  const [occDetail, setOccDetail] = useState<OccInfo | null>(null);

  async function openOccDetail(d: Row): Promise<void> {
    const raw = d.occupation?.holder ?? null;
    const runId = parseHolder(raw)?.runId ?? null;
    setOccDetail({ row: d, raw, runId, loading: runId !== null, run: null, runFailed: false,
      steps: null, stepsFailed: false, openedAt: Date.now() });
    if (runId === null) return; // 形状不认识：没有 run 可查，抽屉只摊原始持有标识
    const [runRes, repRes] = await Promise.allSettled([
      get<NonNullable<OccInfo["run"]>>("/runs/" + encodeURIComponent(runId) + "?project_id=" + encodeURIComponent(pid), { silent: true }),
      reportApi.get(pid, runId),
    ]);
    const steps = repRes.status === "fulfilled" ? repRes.value.steps : null;
    const last = steps && steps.length > 0 ? steps[steps.length - 1] : null;
    // 迟到的响应只许写回它自己那次打开的抽屉（用户可能已关/已换设备）
    setOccDetail((prev) => (prev && prev.row.id === d.id && prev.runId === runId ? {
      ...prev, loading: false,
      run: runRes.status === "fulfilled" ? runRes.value : null, runFailed: runRes.status === "rejected",
      steps: steps ? { n: steps.length, last: last ? last.subject_name ?? last.kind : null } : null,
      stepsFailed: repRes.status === "rejected",
    } : prev));
  }

  async function reconnectOne(d: Row): Promise<void> {
    try {
      await adbApi.reconnectDevice(pid, d.id);
      message.success("重连成功，状态帧已刷新");
      await refreshOne(d);
    } catch (e) {
      // disconnect 后重验失败 = 422 + adb 原话——弹窗直出，不缩成一句 toast
      if (e instanceof ApiErr) setEcho({ title: `重连失败：${d.name}`, text: e.message });
    }
  }

  // 强制释放（D16 管理员逃生门）：确认弹窗点名这是越权覆盖 + 会落审计。
  // onDone：抽屉里的入口在成功后要收掉已陈旧的占用详情（卡片入口不传，行为不变）。
  function forceReleaseOne(d: Row, onDone?: () => void): void {
    const holder = d.occupation?.holder;
    Modal.confirm({
      title: `强制释放「${d.name}」的占用？`,
      width: 540,
      content: (
        <div>
          <Typography.Paragraph>
            这是<strong>项目管理员及以上</strong>的越权动作：直接删设备锁并清空整个排队队列，不需要持有者同意。
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            被释放的执行{holder ? `「${holder}」` : "（持有者未知）"}此后无法再续期/释放自己的锁，
            它还在跑的话会在下一步边界报错。锁泄漏通常会让 TTL（60s 无续期）自行到期——
            确定等不到再按。此动作落审计日志。
          </Typography.Paragraph>
        </div>
      ),
      okText: "确认强制释放", okButtonProps: { danger: true }, cancelText: "取消", centered: true,
      onOk: async () => {
        try {
          const r = await adbApi.forceRelease(pid, d.id);
          message.success(r.released_holder
            ? `已强制释放（原持有者 ${r.released_holder}，含排队队列已清空）`
            : "已清空占用（当时并无持有者，排队队列如有已一并清掉）");
          await refreshOne(d);
          onDone?.();
        } catch { /* toast 已在 client 里弹 */ }
      },
    });
  }

  function removeOne(d: Row): void {
    Modal.confirm({
      title: `把「${d.name}」放入回收站？`,
      // D125：引后端真话——adb_test/debug_services.py:202-204 逐字句式（who + repr(serial)
      // 前缀按这台卡的 serial 代入）。「默认设备未绑定」后端从来不发，旧文案在替后端说谎。
      content: "软删，可随时恢复。被 ADB 用例设为默认设备也能删——那些用例执行时会如实报"
        + `「默认设备 '${d.serial}' 不在本项目可用设备里（未登记 / 已停用 / 已回收）：这一步没有设备可跑」；`
        + "彻底删除才会硬拦引用。",
      okText: "放入回收站", okButtonProps: { danger: true }, cancelText: "取消", centered: true,
      onOk: async () => {
        try {
          await adbApi.removeDevice(pid, d.id);
          message.success("已放入回收站");
          await load();
        } catch { /* toast */ }
      },
    });
  }

  // —— 回收站：恢复 + 彻底删除（输名确认；409 in_use 点名是哪几条用例） ——
  const [purge, setPurge] = useState<Row | null>(null);
  const [purgeName, setPurgeName] = useState("");
  const [detach, setDetach] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeBlock, setPurgeBlock] = useState<{ row: Row; details: AdbDevicePurgeDetails } | null>(null);

  async function restoreOne(d: Row): Promise<void> {
    try {
      await adbApi.restoreDevice(pid, d.id);
      message.success("已恢复");
      await load();
    } catch { /* 回收期间重名被占 409：toast 说人话，不静默改名 */ }
  }

  async function submitPurge(): Promise<void> {
    if (!purge) return;
    setPurging(true);
    try {
      await adbApi.purgeDevice(pid, purge.id, purgeName, detach);
      message.success("已彻底删除，设备名可以重新使用");
      setPurge(null); setPurgeName(""); setDetach(false);
      await load();
    } catch (e) {
      if (e instanceof ApiErr && e.code === "in_use") {
        // 硬拦不是失败是保护：details.referring_cases 点名是哪几条，别让它只化成一句 toast
        setPurgeBlock({ row: purge, details: e.details as AdbDevicePurgeDetails });
        setPurge(null); setPurgeName(""); setDetach(false);
      } // name_mismatch 等其他错保持弹窗打开重试（toast 已弹）
    } finally { setPurging(false); }
  }

  function card(d: Row) {
    const st = cardStateOf(d, d.occupation);
    const o = d.occupation;
    const state = d.last_state ?? null;
    const bat = batteryBadge(state?.battery_level as number | null | undefined);
    const q = queueBadgeLabel(o?.queued);
    const ago = agoLabel(state?.last_check_at as string | null | undefined, nowMs);
    const muted = st === "offline";
    return (
      <div key={d.id}>
        {/* 卡片三层信息（扫描顺序）：① 设备名 + 状态（含左上角状态点）② 机型/系统/电量/排队
            ③ serial/心跳/回收站（tp-tertiary 弱化）。左侧 4px 状态带保留——它是整墙快速扫读
            的主要线索，比状态点更早被眼睛抓到；hover 抬升用 tp.shadow.s2（不再手写阴影色）。
            离线卡 opacity 0.72 的弱化是「安静地灰」而不是「故障红」，保留。 */}
        <Card hoverable size="small" data-testid={"adb-device-card-" + d.id}
          className="tp-device-card"
          style={{ borderLeft: `4px solid ${CARD_COLOR[st]}`, opacity: muted ? 0.72 : 1,
            height: "100%", borderRadius: "var(--tp-radius-lg)" }}>
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            <Space size={6} wrap align="center">
              {/* 状态点：只做「扫一眼知道哪种态」的辅助线索，颜色与状态带同源 */}
              <span aria-hidden data-testid="adb-device-dot"
                style={{ width: 8, height: 8, borderRadius: "var(--tp-radius-pill)",
                  background: CARD_COLOR[st], display: "inline-block", flex: "0 0 auto" }} />
              <Typography.Text strong data-testid="adb-device-name-label">{d.name}</Typography.Text>
              {/* D169：占用态的标签就是「占用详情」的入口（此前持有者只藏在排队徽标的
                  tooltip 里，没排队就哪儿都看不到）。沿用同一 testid，只在占用态可点；
                  标签文本保持「占用」二字（既有断言逐字比 textContent），提示走 tooltip。 */}
              {st === "occupied" ? (
                <Tooltip title="点击查看占用详情（场景 / 时长 / 强制释放）">
                  <Tag color="blue" data-testid="adb-device-state" style={{ cursor: "pointer" }}
                    onClick={() => void openOccDetail(d)}>{CARD_LABEL[st]}</Tag>
                </Tooltip>
              ) : (
                <Tag color={st === "idle" ? "green" : st === "unknown" ? "gold" : "default"}
                  data-testid="adb-device-state">{CARD_LABEL[st]}</Tag>
              )}
              {!d.enabled && <Tag>停用</Tag>}
            </Space>
            {/* 二级：机型 / 系统 / 电量 / 排队 */}
            <Space size={6} wrap align="center">
              <Typography.Text className="tp-text-md">
                {String(state?.model ?? "机型未知")}
              </Typography.Text>
              <Typography.Text type="secondary" className="tp-text-sm">
                {state?.os ? `Android ${state.os}` : "系统未知"}
              </Typography.Text>
              <Tag data-testid="adb-device-battery" color={bat.color}
                className="tp-num">{bat.text}</Tag>
              {q && (
                <Tooltip title={`当前 ${o?.queued} 个执行在排队等这台设备（真实排队人数；不提供等待时长估算——没有可靠公式就不编数字）。持有者：${o?.holder ?? "未知"}`}>
                  <Tag color="blue" data-testid="adb-device-queue" className="tp-num">{q}</Tag>
                </Tooltip>
              )}
            </Space>
            {/* 「占用未知」卡（在线但行上 occupation=null，批量读锁故障整页同缺）明说读数
                缺失——与「让 Pilot 排查」草稿同款话术（pilotDraftFor），不许让琥珀色标签
                单独承载「我们不知道」这句话。 */}
            {st === "unknown" && (
              <Typography.Text type="secondary" className="tp-text-sm" data-testid="adb-device-occ-missing">
                占用读数缺失（本次列表未随行返回占用读数，不能据此断定空闲/占用）
              </Typography.Text>
            )}
            {/* 三级信息：serial / 心跳 / 回收站——tp-tertiary 再弱一档，扫读时让位给上面两级 */}
            <Typography.Text className="tp-text-sm tp-tertiary tp-mono" data-testid="adb-device-serial">
              {d.wifi_addr ?? d.serial}
            </Typography.Text>
            <Typography.Text className="tp-text-sm tp-tertiary" data-testid="adb-device-heartbeat">
              {ago ? `最后心跳 ${ago}` : "尚无心跳"}
              {ago && state?.last_check_at ? `（${fmtTime(state.last_check_at as string) ?? ""}）` : ""}
            </Typography.Text>
            {/* §11.4.18 回收站「删除人/删除时间」，只在回收站视图出现：同一份 updated_by/
                updated_at 在正常卡上是「最后编辑人/时间」，只有回收行上那次写操作就是回收
                本身（device_services.py:290-291 写状态同写人）——挂到正常视图就是说谎。
                D180 双闸：模板跟到货数据（shownRecycled）不跟点击，身份逐行认 d.status——
                视图翻转与 refetch 之间那截窗口里，活行既不在回收模板下也没有回收身份。
                人名只认后端解析的 updated_by_name（查不到 → 「—」，不许回填 id）；
                时间换算走 fmtTime（§3.4-6 UTC 存 / Asia/Shanghai 展示）。 */}
            {shownRecycled && d.status === "recycled" && (
              <Typography.Text type="secondary" className="tp-text-sm" data-testid="adb-device-recycler">
                删除人 {d.updated_by_name ?? "—"} · 删除时间 {fmtTime(d.updated_at, { seconds: false }) ?? "—"}
              </Typography.Text>
            )}
            <Space size={4} wrap style={{ marginTop: 4 }}>
              {/* D180：恢复/彻底删除逐行认 status——「彻底删除」长在一行 status:normal 的
                  活设备上不是样式错，是给用户一个物理删除活设备的按钮。 */}
              {d.status === "recycled" ? (
                <>
                  {canUpdate && (
                    <Button size="small" icon={<UndoOutlined />} data-testid="adb-device-restore"
                      onClick={() => void restoreOne(d)}>恢复</Button>
                  )}
                  {canDelete && (
                    <Button size="small" danger data-testid="adb-device-purge"
                      onClick={() => { setPurge(d); setPurgeName(""); setDetach(false); }}>彻底删除</Button>
                  )}
                </>
              ) : (
                <>
                  {/* 测试 = adb:device:read（/test 是 POST 但只读不写库，READONLY 角色可用） */}
                  <Button size="small" data-testid="adb-device-test" onClick={() => void testOne(d)}>测试连接</Button>
                  {/* D84：预填 Pilot 输入框（只是 nav + 草稿，零写库），与 workbench 的
                      「问 Pilot」入口一样不挂权限位——挂权限就是发明产品合同。 */}
                  <Button size="small" data-testid="adb-device-ask-pilot" onClick={() => askPilot(d)}>让 Pilot 排查</Button>
                  {/* D121：蓝图 :1391 的卡片「编辑」——浅字段弹窗，跟 :update 走（隐藏不是禁用） */}
                  {canUpdate && (
                    <Button size="small" data-testid="adb-device-edit"
                      onClick={() => setEditing(d)}>编辑</Button>
                  )}
                  {canUpdate && (
                    <Button size="small" icon={<ReloadOutlined />} data-testid="adb-device-reconnect"
                      onClick={() => void reconnectOne(d)}>重连</Button>
                  )}
                  {canManage && st === "occupied" && (
                    <Tooltip title="管理员逃生门（D16，项目管理员及以上）：锁泄漏时删锁+清队，带审计">
                      <Button size="small" danger data-testid="adb-device-force-release"
                        onClick={() => forceReleaseOne(d)}>强制释放</Button>
                    </Tooltip>
                  )}
                  {canDelete && (
                    <Tooltip title="放入回收站">
                      <Button size="small" danger type="text" icon={<DeleteOutlined />}
                        data-testid="adb-device-delete" aria-label={"回收-" + d.name} onClick={() => removeOne(d)} />
                    </Tooltip>
                  )}
                </>
              )}
            </Space>
          </Space>
        </Card>
      </div>
    );
  }

  return (
    <div className="tp-fill">
      <div style={{ flex: "0 0 auto" }}>
      {/* D224：D47-a 三件套（视图保存 / 高级搜索；卡片墙没有列设置）。
          条件变更与 state/回收站同一口径：回第 1 页——停在第 5 页套新条件，落的是
          新条件下无关的切片甚至空页（patchFilters 注释同款 hazard）。 */}
      <ListToolbar projectId={pid} viewType="adb_device"
        filter={advFilter}
        onFilterChange={(f) => { setAdvFilter(f); setCurrent(1); }}
        canSaveView canDeleteView />
      <FilterBar actions={(
        <>
          <Button icon={<ReloadOutlined />} data-testid="adb-device-reload" onClick={() => void load()}>刷新</Button>
          <Tooltip title="回收站（软删的设备在这里恢复或彻底删除）">
            <Button data-testid="adb-device-recycled" type={inRecycled ? "primary" : "default"}
              onClick={() => patchFilters({ inRecycled: !inRecycled })}>{inRecycled ? "退出回收站" : "♻ 回收站"}</Button>
          </Tooltip>
          {canCreate && !inRecycled && (
            <Button type="primary" icon={<PlusOutlined />} data-testid="adb-device-add"
              onClick={() => setAdding(true)}>添加设备</Button>
          )}
        </>
      )}>
        <Segmented data-testid="adb-device-filter" options={FILTERS as unknown as string[]}
          value={filter} onChange={(v) => patchFilters({ filter: v as Filter })} />
      </FilterBar>
      {/* 刻意不给 ×：空卡墙（下面的 `&& !loadError`）与脚注都读 loadError，关掉这条 =
          把「设备没取到」擦成一面空墙 + pager 的「共 0 条」——正是本页最怕被误读的现场。 */}
      {loadError && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="adb-device-load-error"
          action={<Button size="small" onClick={() => void load()}>重试</Button>}
          message={loadError.code === "lock_store_unavailable"
            ? "占用读数不可用，这一档列不出来"
            : loadError.code === "state_filter_too_broad"
              ? "占用/空闲这一档的筛选范围过大"
              : "设备列表加载失败"}
          description={
            <>
              <EchoBlock text={loadError.message} />
              {loadError.code === "lock_store_unavailable" && (
                <Typography.Paragraph type="secondary" className="tp-text-sm" style={{ marginBottom: 0 }}>
                  这是设备锁读数（Redis）故障：占用/空闲/全部三档里只有「全部」「离线」不依赖它——
                  切到那两档能照常看设备清单（占用读数会在卡上明说缺失），或稍后点「刷新」重试。
                </Typography.Paragraph>
              )}
            </>
          } />
      )}
      </div>
      {/* 空墙/空卡按内容高会浮在 677 高的正文顶上，底下空一片（满高页最扎眼的一种空）：
          没行时把唯一的空态块垂直居中，有墙时仍从顶部铺开。 */}
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden",
        display: "flex", flexDirection: "column",
        justifyContent: rows.length === 0 ? "center" : "flex-start" }}>
      {!loading && rows.length === 0 && !loadError && (
        <Card size="small" className="tp-card">
          {/* D47-b 步5e：墙画的就是服务端按 state 筛后的当前页，空墙只说明「当前条件下
              后端没给行」；旧「rows.length 还有行→怪筛选」那条归因腿随本地过滤一起退役
              （rows 本身就是筛后的）。归因只读已提交的 filter，没有第四把尺子。
              空态用 StateView（不再是通用信封插画），文案逐字保留——测试按文案断言。 */}
          <StateView testId="adb-device-empty" title={
            shownRecycled ? "回收站是空的"
              : filter !== "全部" ? `「${filter}」这一档没有设备（换「全部」或换个筛看看）`
              : canCreate ? "还没有设备。点「添加设备」输入 ip:port——添加会真的 adb connect 验证，连不上不入库并原样回显 adb 输出。"
                : "还没有设备（你没有添加权限）。"
          } />
          {/* D180：整条空态（含这段脚注）与回收模板同源——都读 shownRecycled。本渲染树里
              空态可见时 loading 已落且 loadError 已清空，两flag 事实上等值；选 shownRecycled
              是为了让「回收文案只认到货数据」这条不变式在本文件内可一眼审计。 */}
          {!shownRecycled && filter === "全部" && (
            <Typography.Paragraph className="tp-text-sm" type="secondary" style={{ textAlign: "center", marginBottom: 0 }}>
              若列表曾正常但设备一直「尚无心跳」，可能是后端未配置 adb 可执行（TP_ADB_PATH）或心跳未跑——
              空列表不等于一切正常，点添加试一次就能看到 adb 的原话。
            </Typography.Paragraph>
          )}
        </Card>
      )}
      {rows.length > 0 && (
        // tp-wall（--tp-wall-min=376）：底排并排钮是最宽一行：测试连接 72 + 让 Pilot 排查 114 + 编辑 44
        // + 重连 60 + 回收钮 24 + 4×4 gap ≈ 330，+左右内边距 40 ≈ 370 → 取 8 的倍数 376：
        // 1552 封顶容器恰好 4×376+3×16，944 容器 2 列各 464。旧 xs/sm/lg/xxl 量视口：1200
        // 视口 lg=8 只切 3 列内容 ~303，按钮行被挤成两排。
        <div className="tp-wall" style={{ "--tp-wall-min": "376px" } as React.CSSProperties}>
          {rows.map(card)}
        </div>
      )}
      </div>
      {/* D47-b 步5e：共享页码分页器。total 缺键（后端未报总数）时 ListPager 整块不渲染，
          绝不画假「共 0 条」；「共 N 台」从此只有服务端 total 这一张嘴。 */}
      {/* 页码与脚注并成一行（版式口径同 api.tsx / scenes.tsx）：脚注占左格、页码恒居中，省下表格下方整整一行。
          本页是卡片墙、没有 AdminTable 可挂卡内脚注，所以自己穿同一套外壳（.tp-card 的底色/描边/圆角
          + .tp-cardfoot 的三列格）——小字此前裸画在页面底色上，卡有边有角它没有，读起来像掉在卡外的批注。 */}
      {/* 空脚注 + 无页码（首屏未到货）时整条不画：否则页面底部闪一条空卡底条。 */}
      {(loadError !== null || shownRecycled || total !== null) && (
      <div className="tp-card tp-cardfoot-strip" style={{ flex: "0 0 auto" }}>
        <div className="tp-cardfoot">
        <Typography.Text className="tp-text-sm tp-cardfoot-note" type="secondary">
        {/* D47-b 步5e：旧脚注的两条现攒腿随游标世界退役——「共 visible.length 台」
            （本地过滤的行数当总数）与「本页取到 N 台（单页上限 200，后面还有没取的）」
            （游标 hedging，页码模式下下一页永远点得到，它不再是脚注能说的事）；
            「（筛自 rows.length 台）」也是本地过滤时代的算术，同样退场。
            「共 N 条」归 ListPager 报服务端 total，这里失败时只剩一句真话。 */}
        {/* 「状态来自心跳 + 设备锁」已升为页头 desc，脚注只留随状态变化的两句（加载失败 / 回收站视图），
            不再复述固定口径。 */}
        {[loadError ? "本次设备列表加载失败，本行计数不作数" : "",
          shownRecycled ? "回收站视图" : ""].filter(Boolean).join(" · ")}
        </Typography.Text>
        <ListPager
          current={current}
          pageSize={pageSize}
          total={total}
          onPage={setCurrent}
          onPageSize={setPageSize}
        />
        </div>
      </div>
      )}

      <AddDeviceModal open={adding} pid={pid} onClose={() => setAdding(false)} onCreated={load} />

      {/* D121 编辑弹窗：PATCH 只送改动字段；保存成功后整墙 load() 刷新（卡片会换行，
          编辑目标随之失效，弹窗此时已关） */}
      <EditDeviceModal row={editing} open={editing !== null}
        onClose={() => setEditing(null)} onSaved={load} />

      {/* D169 占用详情抽屉（蓝图 :1391）：实时「当前步骤」需要不存在的 REST 回放——
          如实写「已完成 N 步 · 末步」，绝不拿末行冒充当前步；run 取数失败明说取不到，
          强制释放照给（逃生门不依赖读数）。 */}
      <Drawer open={occDetail !== null} destroyOnHidden width={480}
        title={occDetail ? `占用详情 · ${occDetail.row.name}` : "占用详情"}
        data-testid="adb-occ-drawer" onClose={() => setOccDetail(null)}>
        {occDetail && (
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            {occDetail.loading && <Typography.Text type="secondary" data-testid="adb-occ-loading">占用信息取数中…</Typography.Text>}
            {!occDetail.loading && occDetail.run && !occDetail.runFailed && (
              <>
                <Typography.Paragraph style={{ marginBottom: 0 }} data-testid="adb-occ-scene">
                  占用场景：<Typography.Text strong>{occDetail.run.subject_name}</Typography.Text>（{occDetail.run.subject_type}）
                </Typography.Paragraph>
                <Space size={6} wrap>
                  <Typography.Text className="tp-text-sm" type="secondary" data-testid="adb-occ-run-id">run {occDetail.runId?.slice(0, 8)}</Typography.Text>
                  <Button size="small" type="link" style={{ padding: 0 }} data-testid="adb-occ-report"
                    onClick={() => nav("/reports/" + occDetail!.runId)}>报告</Button>
                </Space>
                <Typography.Text data-testid="adb-occ-elapsed">已执行时长：{elapsedLabel(occDetail.run.started_at, occDetail.openedAt) ?? "未记录开始时间"}（打开时快照，不实时跳动）</Typography.Text>
              </>
            )}
            {!occDetail.loading && occDetail.runFailed && (
              <Alert type="warning" showIcon data-testid="adb-occ-run-missing" message="占用信息没取到（run 可能已清理）"
                description="持有锁的执行记录取不到了（无权限或已清理）。若确认锁泄漏，下方仍可强制释放。" />
            )}
            {!occDetail.loading && occDetail.runId === null && (
              <Typography.Text data-testid="adb-occ-unknown">持有者标识不是可识别的 run 形状，无法查询占用场景。原始持有标识：
                <Typography.Text code>{occDetail.raw ?? "（无）"}</Typography.Text></Typography.Text>
            )}
            {!occDetail.loading && occDetail.steps && (
              <Typography.Paragraph style={{ marginBottom: 0 }} data-testid="adb-occ-steps">已完成 {occDetail.steps.n} 步{occDetail.steps.last ? ` · 末步「${occDetail.steps.last}」` : ""}</Typography.Paragraph>
            )}
            {!occDetail.loading && occDetail.stepsFailed && <Typography.Text type="secondary" data-testid="adb-occ-steps-missing">步骤读数没取到（报告可能还没生成）。</Typography.Text>}
            {!occDetail.loading && (
              <Typography.Text className="tp-text-sm" type="secondary" data-testid="adb-occ-honest">「当前步骤」需要执行中的实时回放接口（目前没有），这里只给报告里已落库的步骤行，不把末步冒充当前步。</Typography.Text>
            )}
            {/* D159 门与卡片按钮同源：只跟 adb:device:manage，隐藏不是禁用 */}
            {canManage && <Button danger data-testid="adb-occ-force-release"
              onClick={() => forceReleaseOne(occDetail.row, () => setOccDetail(null))}>强制释放</Button>}
          </Space>
        )}
      </Drawer>

      {testRes && <TestResultModal name={testRes.name} out={testRes.out} onClose={() => setTestRes(null)} />}
      {echo && (
        <Modal open title={echo.title} width={640} centered okText="知道了"
          cancelButtonProps={{ style: { display: "none" } }}
          okButtonProps={{ "data-testid": "adb-echo-ok" }}
          onOk={() => setEcho(null)} onCancel={() => setEcho(null)}>
          <Typography.Paragraph className="tp-text-sm" type="secondary">
            以下是后端/adb 的原始输出，未做翻译或改写——排错要看的就是这句原话。
          </Typography.Paragraph>
          <EchoBlock text={echo.text} />
        </Modal>
      )}

      {/* 彻底删除：逐字输名（后端同样硬校验）；被 default_device 引用时要显式勾选释放引用 */}
      <Modal open={purge !== null} onCancel={() => { setPurge(null); setPurgeName(""); setDetach(false); }}
        width={560} centered title="彻底删除设备？" okText="我已确认，彻底删除" cancelText="取消"
        okButtonProps={{ danger: true, "data-testid": "adb-device-purge-ok",
          disabled: purgeName !== (purge?.name ?? ""), loading: purging }}
        onOk={() => void submitPurge()}>
        <Typography.Paragraph>
          「{purge?.name}」将被物理删除，<Typography.Text strong>无法恢复</Typography.Text>。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          若仍有 ADB 用例把它设为默认设备，删除会被拒绝并点名是哪几条；届时勾选「释放引用」
          才会连同解绑一起删除——解绑后那些用例执行时按「任一空闲」挑设备，不会再因这台设备报错；
          但项目里没有任何启用且未回收的设备时，「任一空闲」自己也挑不出——解绑不等于永远有机器。
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          输入设备名 <Typography.Text code>{purge?.name}</Typography.Text> 以确认。
        </Typography.Paragraph>
        <Input data-testid="adb-device-purge-confirm" value={purgeName} autoFocus
          placeholder={purge?.name} onChange={(e) => setPurgeName(e.target.value)} />
        <div style={{ marginTop: 12 }}>
          <Checkbox data-testid="adb-device-purge-detach" checked={detach} onChange={(e) => setDetach(e.target.checked)}>
            释放引用（连同把该设备设为默认设备的用例一起解绑）
          </Checkbox>
        </div>
      </Modal>

      {/* purge 被引用硬拦（409 in_use）：referring_cases 一条都不藏，点名是哪几条用例 */}
      <Modal open={purgeBlock !== null} title="删除被拦截：这些 ADB 用例把它设为默认设备"
        okText="知道了" cancelButtonProps={{ style: { display: "none" } }} width={560} centered
        okButtonProps={{ "data-testid": "adb-purge-block-ok" }}
        onOk={() => setPurgeBlock(null)} onCancel={() => setPurgeBlock(null)}>
        <div data-testid="adb-purge-block">
          <Typography.Paragraph>
            「{purgeBlock?.row.name}」被 <Typography.Text strong>
            {purgeBlock?.details.referring_cases.length}</Typography.Text> 条 ADB 用例设为 default_device：
          </Typography.Paragraph>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {(purgeBlock?.details.referring_cases ?? []).map((c) => (
              <li key={c.id} data-testid="adb-purge-block-case">{c.name}</li>
            ))}
          </ul>
          <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
            先改那些用例的默认设备，或回到「彻底删除」勾选「释放引用」后重试（删除时自动解绑）。
          </Typography.Paragraph>
        </div>
      </Modal>
    </div>
  );
}

export default function AdbDevicesPage() {
  const { project } = useAuth();
  return (
    <div data-testid="page-adb-devices" className="tp-fill-stack">
      <PageHead title="设备管理" descHover
        desc="设备在线状态来自心跳、占用来自实时设备锁；排队数是真实等待数，不估时长。" />
      <ProjectGate>{project ? <DevicesWall /> : null}</ProjectGate>
    </div>
  );
}
