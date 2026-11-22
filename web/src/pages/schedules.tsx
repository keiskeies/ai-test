// 定时任务管理（§11.4.17，1E 前端补记；后端 schedule/service.py + schemas.py 为准）。
//
// 本页四条命门口径（写错就是假门，逐条对后端）：
// ① cron 合法性的唯一裁判是后端（5 段式否则 422、crontab 原话进 message）——前端**零校验**、
//    不写正则、不引 cron-parser，只在 422 时把 message 原样回显成红字（§13 纪律 1）。
// ② [预览未来 5 次] 打 POST /schedule-tasks/next-5，发的是抽屉里**未落库的草稿** cron；
//    返回 times 已带 +08:00（Shanghai 日历，§3.4-6），一律 fmtTime 展示。
// ③ subject_type 一期只有 scenario 一项（D30，后端白名单把守）——下拉里不许出现别的选项。
// ④ notify_channel_ids 候选来自 GET /notify-channels（平台级、不带 project_id）；
//    该接口加载失败（含 403）时多选框降级成只读提示（只有 403 才许喊「权限」），
//    **绝不把列表里的 id 编成渠道名**。
// ⑤ last_run 是 JSON 回执：fire 段 {ok/run_id/fired_at}；run 落终态后 notify 钩子把
//    run_final 段合并进同一字段（notify/hooks._merged_receipt）。成功/失败配色**只认
//    run_final.ok**——fire 顶层 ok 只是「投递成败」。没 run_final 分两句：有 run_id
//    （还在跑）画「执行结果未回」；没 run_id（未投递/投递失败——service.py 那两种回执
//    压根没建 run，投递失败的孤儿 run 当场删掉）画「未产生执行，不会回结果」，
//    绝不拿投递成败冒充执行结果，也不对没 run 的回执许诺「结果未回」。consecutive_failures 整数
//    直出，缺 run_id 显示「—」。
// ⑥ 「计划」三选（每天/每周/自定义 cron，D76 尾账）：反解 parsePlan 只把**选择器能逐字
//    重拼出来的规范 cron**（humanizeCron 的逆运算、还更严一档）落到每天/每周，其余一律
//    落自定义原样可见；将写入的串永远同屏（见下方「计划三选」段的口径注释）。
// 权限位 schedule:task:{read,create,update,delete}；next-5 是 POST 但后端 perm 以 :read 结尾
// （读类动作，同 notifyChannels「测试发送」口径），所以 [预览] 按钮跟读权限走。
//
// 类型说明：gen:api 已重跑（2026-11-17），schema.d.ts 里 TaskOut/TaskCreateIn/Next5Out 真实
// 在场（grep -c "schedule-tasks" = 4）。本页仍用下面这份本地声明：字段与生成物逐字段一致，
// 且 schedules.test.tsx 从这里 import TaskRow——换引生成物是一次纯类型替换的重构，
// 归到「前端统一改用 components["schemas"]」那笔账，不在本批顺手混做。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert, Button, Checkbox, Drawer, Input, Modal, Radio, Select, Space, Switch, Table, Tag, Tooltip, Typography, message,
} from "antd";
import { PlusOutlined, ReloadOutlined } from "../ui/icons";
import ProjectGate, { PageHead } from "../layout/ProjectGate";
import AdminTable from "../ui/AdminTable";
import { useAuth } from "../auth/store";
import { can, patternsForProject } from "../auth/perms";
import { get, patch, post, ApiErr } from "../api/client";
import type { Page } from "../api/api";
import { fmtTime } from "../shared/timefmt";
import { ListPager } from "../shared/listPagination";
import { STATUSES } from "../shared/runVocab";

// ── 本地类型（字段 = schemas.py TaskOut / TaskCreateIn / Next5Out，一个不许多一个不许少）──

export interface TaskRow {
  id: string;
  project_id: string;
  name: string;
  subject_type: string;
  subject_id: string;
  cron: string;
  env_id: string | null;
  enabled: number;
  notify_channel_ids: string[];
  last_run: Record<string, unknown> | null;
  consecutive_failures: number;
  created_at: string | null;
  updated_at: string | null;
}

/** POST /schedule-tasks 的 body = TaskCreateIn（PATCH 复用同形状，TaskUpdateIn 全可选）。 */
export interface TaskCreateBody {
  project_id: string;
  name: string;
  subject_type: string;
  subject_id: string;
  cron: string;
  env_id: string | null;
  enabled: number;
  notify_channel_ids: string[];
}

export interface Next5Out {
  cron: string;
  times: string[]; // 5 个严格递增 ISO 串，带 +08:00 偏移（后端 Shanghai 日历）
}

// D30：一期只放开 scenario（后端 SUBJECT_TYPES=("scenario",) 同尺）。
const SUBJECT_OPTIONS = [{ value: "scenario", label: "场景（scenario）" }];

/**
 * Ctrl+K ?q=<id> 直达的纯判断半边（与 uiElements.tsx 的高亮同一形状）：
 * id 在**已加载行**里才认（返回该 id 用于高亮），不在就返回 null——行真的不在
 * 加载集里（D47-b 页码制后：可能翻在其它页，也可能被服务端筛选挡在请求外）就
 * 老实什么都不标，绝不编一行出来。
 * target 为空同样返回 null。抽成纯函数：这段「哪条是用户搜的那条」的判断是
 * 落点体验的命门，纯测试能钉住它，不必赌组件渲染。
 */
export function pickDeepLinkHit<T extends { id: string }>(rows: T[], target: string | null): string | null {
  if (!target || rows.length === 0) return null;
  return rows.some((r) => r.id === target) ? target : null;
}

const enc = encodeURIComponent;

// ── 小件 ─────────────────────────────────────────────────────────────────────

/** 后端/网络原话直出块（422 的 message、预览的错误都走这里，不翻译不精简）。 */
function EchoBlock({ text, testid }: { text: string; testid?: string }) {
  return (
    <pre data-testid={testid} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all",
      background: "var(--tp-bg-layout)", padding: 12, borderRadius: 6, margin: 0 }}>{text}</pre>
  );
}

/**
 * 最近结果列：last_run 是 JSON 回执，两段两种来历——
 * ① fire 段 {ok, run_id, fired_at}：ok 只说明**投递成败**，不是执行结果；
 * ② run_final 段：run 落终态后 notify 钩子合并进来的 {ok, status, finished_at, ...}
 *    （notify/hooks._merged_receipt）。
 * 配色只认 run_final.ok：fire 失败（未投递）与 run 还在跑都**没有** run_final，
 * 这句时按 run_id 分两种说：有 run_id 才配「执行结果未回」，没 run_id（未投递/
 * 投递失败压根没建 run）说「未产生执行，不会回结果」——回执里没有的语义一概不编，
 * 更不拿投递成败冒充执行结果。
 */
function LastRunCell({ lastRun, testid }: { lastRun: TaskRow["last_run"]; testid: string }) {
  if (!lastRun) return <Typography.Text type="secondary">从未触发</Typography.Text>;
  const fired = typeof lastRun.fired_at === "string" ? fmtTime(lastRun.fired_at) : null;
  const runId = typeof lastRun.run_id === "string" && lastRun.run_id ? lastRun.run_id : null;
  const rf = lastRun.run_final;
  const final = rf !== null && typeof rf === "object" && !Array.isArray(rf)
    ? rf as Record<string, unknown> : null;
  const ok = typeof final?.ok === "boolean" ? final.ok : null;
  const status = typeof final?.status === "string" ? final.status : null;
  const finishedAt = typeof final?.finished_at === "string" ? fmtTime(final.finished_at) : null;
  const reason = typeof lastRun.reason === "string" ? lastRun.reason : null;
  // D163：run_final.reason / channels[].error 是后端真写进回执的（notify/hooks._handle：
  // 「未绑定通知渠道」/渠道不存在/发送失败原文）——终态分支以前零渲染等于把证据藏了。
  // 未知形状一律 typeof 守卫（同上），失败渠道只认 ok===false 的项。
  const finalReason = typeof final?.reason === "string" && final.reason ? final.reason : null;
  const failedChans = (final && Array.isArray(final.channels) ? final.channels : [])
    .filter((c): c is Record<string, unknown> =>
      c !== null && typeof c === "object" && !Array.isArray(c) && (c as Record<string, unknown>).ok === false);
  return (
    <div className="tp-text-sm" data-testid={testid}>
      {ok !== null ? (
        <div>
          <Tag color={ok ? "green" : "red"} data-testid="schedule-result-tag">
            {/* 措辞取 run 词表（runVocab STATUSES），颜色只由 ok 布尔决定；词表外状态画「通过/未通过」 */}
            {status && STATUSES[status] ? STATUSES[status].label : ok ? "通过" : "未通过"}
          </Tag>
          <div data-testid="schedule-last-run-time">{finishedAt ? "完成 " + finishedAt : "完成时间未知"}</div>
          {finalReason && (
            <div data-testid="schedule-final-reason"><Typography.Text type="secondary">{finalReason}</Typography.Text></div>
          )}
          {/* 失败渠道逐条上屏（形状镜像 notifyChannels LastSendCell 的 ✗/Tooltip）：
              成功项不渲染；name 缺失（渠道已删）画截断 id，绝不编名。 */}
          {failedChans.map((c, i) => {
            const label = typeof c.name === "string" && c.name ? c.name
              : typeof c.channel_id === "string" && c.channel_id ? shortId(c.channel_id) : "渠道";
            const err = typeof c.error === "string" && c.error ? c.error : "发送失败（无错误详情）";
            return (
              <div key={i} data-testid="schedule-channel-error">
                <Tooltip title={err}><Typography.Text type="danger">✗ {label}：{err}</Typography.Text></Tooltip>
              </div>
            );
          })}
        </div>
      ) : (
        <div>
          <div data-testid="schedule-last-run-time">{fired ?? "触发时间未知"}</div>
          {/* WHY: run 只在 run_id 存在时才存在（service.py 的未投递/投递失败回执没建 run，
              孤儿 run 还被当场删掉）——没 run 就不许许诺「结果未回」这种还在路上的话。 */}
          <Typography.Text type="secondary">
            {runId ? "执行结果未回" : "未产生执行，不会回结果"}
          </Typography.Text>
          {reason && <div><Typography.Text type="secondary">{reason}</Typography.Text></div>}
        </div>
      )}
      <Typography.Text type="secondary">{runId ? "run " + runId : "—"}</Typography.Text>
    </div>
  );
}

/**
 * cron 人话化：只说后端 cron.py 那把尺（5 段 + celery crontab 关键字映射）能确定的话。
 * celery 口径（backend/.venv 实测，crontab(minute/hour/day_of_month/month_of_year/day_of_week)）：
 * 周字段 0=周日…6=周六（7 直接 422）；分钟段的步进写法展开为「0 起步长 N」。
 * 说不准的一律返回 null → 调用方原样显示 raw 串——友好但错的句子比生码更骗人
 * （例：日/周同时限定的 OR 语义、月限定、分字段带列表）。
 */
export function humanizeCron(cron: string): string | null {
  const seg = cron.trim().split(/\s+/);
  if (seg.length !== 5) return null;
  const [min, hour, dom, mon, dow] = seg;
  const INT = /^\d{1,2}$/;
  const minN = INT.test(min) && Number(min) < 60 ? Number(min) : null;
  const hourN = INT.test(hour) && Number(hour) < 24 ? Number(hour) : null;
  const clock = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const step = /^\*\/(\d{1,2})$/.exec(min);
  // 每 N 分钟（*/N * * * *）——「每 N 分钟」只在 N 整除 60 时是真话：celery 分钟步进集是
  // {0,N,2N…}∩[0,59] 且每小时归零，*/45 实算 00:00→00:45→01:00（45 分后接 15 分）、
  // */7 尾部 59→00:00 只有 1 分——repo venv 实算均匀间隔 ⇔ N | 60，其余一律 raw 兜底。
  if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = Number(step[1]);
    return n >= 1 && 60 % n === 0 ? `每 ${step[1]} 分钟` : null;
  }
  if (minN === null || hourN === null) return null; // 以下三类都要求「分 时」是确定时刻
  const DOW = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const day = clock(hourN, minN);
  if (dom === "*" && mon === "*" && dow === "*") return `每天 ${day}`;
  // 周限定：数字/逗号列表/a-b 区间（各自展开后 ≤0-6，与 celery 的 422 闸同尺）
  if (dom === "*" && mon === "*" && dow !== "*") {
    const days: number[] = [];
    for (const p of dow.split(",")) {
      const rg = /^(\d)-(\d)$/.exec(p);
      if (rg) {
        const a = Number(rg[1]);
        const b = Number(rg[2]);
        if (a > b || b > 6) return null;
        for (let i = a; i <= b; i += 1) days.push(i);
      } else {
        if (!/^\d$/.test(p) || Number(p) > 6) return null;
        days.push(Number(p));
      }
    }
    const uniq = [...new Set(days)].sort((a, b) => a - b);
    return "每" + uniq.map((d) => DOW[d]).join("、") + " " + day;
  }
  // 月内日限定（分/时/日/月/周 的「日」，与 celery day_of_month 同位）
  if (dow === "*" && mon === "*" && INT.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
    return `每月 ${dom} 日 ${day}`;
  }
  return null;
}

// ── 计划三选（§11.4.17 D76 尾账）：选择器 ⇄ cron 的正反手 ──────────────────────
//
// 口径（和 humanizeCron 互为正反手，round-trip 钉在 schedules.test.tsx）：
// ① 每天/每周两态各自拼出**唯一规范串**：分 时不带前导零（`0 2 * * *`）、星期列表
//    去重升序逗号连（`0 2 * * 1,3`）；周字段沿用 celery 尺 0=周日…6=周六。
// ② 反解（parsePlan）比 humanizeCron **更严一档**：weekly 只认选择器自己能拼回的
//    规范形状（单个 0-6 数字、升序、无重复、无区间）。`0 2 * * 1-5` 虽然能被
//    humanizeCron 翻成「每周一…周五 02:00」，但选择器把它变成 1,2,3,4,5 就改了
//    落库原文——宁可落自定义让用户直面 raw 串，不做「看着能编辑、一保存就改写
//    调度原文」的假门。分/时接受前导零（`05 02 * * *` 与 `5 2 * * *` 同刻度），
//    保存时统一成无零规范串（调度语义不变，celery 两种写法同解）。
// ③ 切态不动其它态的值：三态各存各的，自定义 raw 串永远在输入框里原样可见——
//    没有用户看不见的隐藏状态（假数据的反面）。

export type PlanMode = "daily" | "weekly" | "custom";

export type ParsedPlan =
  | { mode: "daily"; hour: number; minute: number }
  | { mode: "weekly"; days: number[]; hour: number; minute: number }
  | { mode: "custom"; cron: string };

/** 每天 → `分 时 * * *`（无零规范串，与 humanizeCron 的 clock 同语义）。 */
export function cronFromDaily(hour: number, minute: number): string {
  return `${minute} ${hour} * * *`;
}

/** 每周 → `分 时 * * d1,d2,…`（去重升序）；一天没选拼不出合法 cron，返回 null 由 UI 明说。 */
export function cronFromWeekly(days: number[], hour: number, minute: number): string | null {
  const uniq = [...new Set(days)].sort((a, b) => a - b);
  if (uniq.length === 0) return null;
  return `${minute} ${hour} * * ${uniq.join(",")}`;
}

/**
 * 反解：cron → 计划三选落点。落「每天/每周」的门槛见本节头部②——比 humanizeCron
 * 严格（只认选择器能逐字节重拼出来的规范串；区间/乱序/重复/前导零都落自定义），
 * 落不进就原样带 raw 回自定义。
 */
export function parsePlan(cron: string): ParsedPlan {
  const custom = { mode: "custom", cron } as const;
  const seg = cron.trim().split(/\s+/);
  if (seg.length !== 5) return custom;
  const [min, hour, dom, mon, dow] = seg;
  // 规范形态：0-59 / 0-23 的无前导零十进制（"05" 会被选择器重拼成 "5"，改原文即出局）
  const CANON = (s: string, max: number) => /^\d{1,2}$/.test(s) && Number(s) <= max && s === String(Number(s));
  if (!CANON(min, 59) || !CANON(hour, 23)) return custom;
  if (dom !== "*" || mon !== "*") return custom; // 日/月限定、日+周 OR——三选装不下
  const h = Number(hour);
  const m = Number(min);
  if (dow === "*") return { mode: "daily", hour: h, minute: m };
  const days: number[] = [];
  for (const p of dow.split(",")) {
    if (!/^\d$/.test(p) || Number(p) > 6) return custom; // 区间 a-b、步进都出局
    const d = Number(p);
    if (days.length > 0 && d <= days[days.length - 1]) return custom; // 乱序/重复：选择器拼不出原文
    days.push(d);
  }
  if (days.length === 0) return custom;
  return { mode: "weekly", days, hour: h, minute: m };
}

// 周选项：value 用 celery 周字段原值（0=周日…6=周六），顺序也按它排。
const DOW_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const DOW_OPTIONS = DOW_NAMES.map((label, value) => ({ value, label }));
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({ value: i, label: String(i).padStart(2, "0") }));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => ({ value: i, label: String(i).padStart(2, "0") }));

/** 名单外 id 的截断显示（宁可生码，不留白、不编名）。 */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + "…" : id;
}

// ── 新建/编辑抽屉（计划三选：每天/每周/自定义 cron + 预览 + 挂渠道多选）────────

interface Option { value: string; label: string }
interface Cands { options: Option[]; error: string | null; is403?: boolean }

function TaskDrawer({ open, editing, projectId, canWrite, scenarios, onClose, onSaved }: {
  open: boolean;
  editing: TaskRow | null;
  projectId: string;
  canWrite: boolean;
  /** 场景候选：页体拉一次、和主体列共用同一份——抽屉再拉一份就是两套真相。 */
  scenarios: Cands | null;
  onClose: () => void;
  onSaved: (row: TaskRow) => void;
}) {
  const [name, setName] = useState("");
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [envId, setEnvId] = useState<string | null>(null);
  // 计划三选（§11.4.17 D76 尾账）：三个槽位各自存值、切态互不覆盖——将写入的 cron
  // 由当前态实时推导并同屏展示（schedule-plan-derived），用户看不见的状态一概没有。
  const [planMode, setPlanMode] = useState<PlanMode>("daily");
  const [days, setDays] = useState<number[]>([]);
  const [hour, setHour] = useState(2);
  const [minute, setMinute] = useState(0);
  const [customCron, setCustomCron] = useState("");
  const [enabled, setEnabled] = useState(1);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [envs, setEnvs] = useState<Cands | null>(null);
  const [channels, setChannels] = useState<Cands | null>(null);
  const [preview, setPreview] = useState<{ kind: "idle" | "times" | "error" | "hint"; text: string; times: string[] }>(
    { kind: "idle", text: "", times: [] });

  const planCron = useMemo<string | null>(() => {
    if (planMode === "daily") return cronFromDaily(hour, minute);
    if (planMode === "weekly") return cronFromWeekly(days, hour, minute);
    return customCron;
  }, [planMode, days, hour, minute, customCron]);

  // 每次打开从当前行重置（新建 = 全空 + 界面明说的默认「每天 02:00」）。
  // 已有 cron 一律原样留在自定义槽（切到自定义就逐字可见），同时 parsePlan 决定落点。
  // 场景候选由页体提供（共用，见 props 注释）；环境/渠道仍随抽屉静默拉：
  // 失败不上抛 toast，只把错误原话留在对应控件位置。
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setSubjectId(editing?.subject_id ?? null);
    setEnvId(editing?.env_id ?? null);
    const src = editing?.cron ?? "";
    setCustomCron(src);
    if (!editing) {
      // 新建：默认「每天 02:00」——这是界面当场显示出来的默认（derived 行同屏可见），
      // 不是藏在状态里的 0 0 * * *。
      setPlanMode("daily"); setDays([]); setHour(2); setMinute(0);
    } else {
      const p = parsePlan(src);
      if (p.mode === "daily") { setPlanMode("daily"); setDays([]); setHour(p.hour); setMinute(p.minute); }
      else if (p.mode === "weekly") { setPlanMode("weekly"); setDays(p.days); setHour(p.hour); setMinute(p.minute); }
      else { setPlanMode("custom"); setDays([]); setHour(2); setMinute(0); }
    }
    setEnabled(editing?.enabled ?? 1);
    setChannelIds(editing?.notify_channel_ids ?? []);
    setSaveErr(null);
    setPreview({ kind: "idle", text: "", times: [] });
    setEnvs(null); setChannels(null);
    void (async () => {
      try {
        const r = await get<Page<{ id: string; name: string }>>(
          "/envs?" + new URLSearchParams({ project_id: projectId, size: "200" }), { silent: true });
        setEnvs({ options: r.items.map((s) => ({ value: s.id, label: s.name })), error: null });
      } catch (e) {
        setEnvs({ options: [], error: e instanceof ApiErr ? e.message : "环境列表加载失败" });
      }
    })();
    void (async () => {
      try {
        // 渠道是平台级配置：不带 project_id（notifyChannels.tsx 同款口径）
        const r = await get<Page<{ id: string; name: string }>>("/notify-channels?size=200", { silent: true });
        setChannels({ options: r.items.map((s) => ({ value: s.id, label: s.name })), error: null });
      } catch (e) {
        // 一切失败都降级只读提示，但只有 403（ApiErr.status）才配诊断成「权限」；
        // 已挂的 id 原样留形不编名
        setChannels({
          options: [],
          error: e instanceof ApiErr ? e.message : "渠道列表加载失败",
          is403: e instanceof ApiErr && e.status === 403,
        });
      }
    })();
  }, [open, editing, projectId]);

  /** 预览：POST /schedule-tasks/next-5，body 是当前草稿 cron（保存前就能算）。 */
  async function previewNext5(): Promise<void> {
    const c = (planCron ?? "").trim();
    if (!c) { setPreview({ kind: "hint", text: "cron 为空，未发起预览——合法性只有后端能裁，前端不猜。", times: [] }); return; }
    try {
      const out = await post<Next5Out>("/schedule-tasks/next-5", { project_id: projectId, cron: c }, { silent: true });
      setPreview({ kind: "times", text: "", times: out.times });
    } catch (e) {
      // 422 的 crontab 原话原样回显（前端不许自己先拦一套）
      setPreview({ kind: "error", text: e instanceof ApiErr ? e.message : "预览请求失败", times: [] });
    }
  }

  async function submit(): Promise<void> {
    if (!name.trim() || !subjectId) { message.warning("任务名称与场景必填"); return; }
    if (planCron === null) { message.warning("每周计划至少勾选一个星期"); return; }
    setBusy(true);
    setSaveErr(null);
    const body: TaskCreateBody = {
      project_id: projectId,
      name: name.trim(),
      subject_type: "scenario", // D30：唯一合法值；别的类型根本不出现在这里
      subject_id: subjectId,
      cron: planCron,
      env_id: envId,
      enabled,
      notify_channel_ids: channelIds,
    };
    try {
      if (editing) {
        onSaved(await patch<TaskRow>("/schedule-tasks/" + enc(editing.id), body));
        message.success("已保存");
      } else {
        onSaved(await post<TaskRow>("/schedule-tasks", body));
        message.success("定时任务已创建");
      }
      onClose();
    } catch (e) {
      // 422（cron 非 5 段 / crontab 拒 / subject_type 白名单外）——原话上屏，一个字不翻
      if (e instanceof ApiErr) setSaveErr(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Drawer open={open} onClose={onClose} width={560}
      title={editing ? `定时任务：${editing.name}` : "新建定时任务"}
      extra={(
        canWrite && (
          <Button type="primary" loading={busy} data-testid="schedule-save" onClick={() => void submit()}>
            保存
          </Button>
        )
      )}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input data-testid="schedule-field-name" maxLength={200} value={name} autoFocus
            placeholder="如「夜间回归」" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Typography.Text strong>主体类型（一期只支持场景，D30）</Typography.Text>
          <Select style={{ width: "100%" }} disabled value="scenario" options={SUBJECT_OPTIONS}
            data-testid="schedule-field-subject_type" />
        </div>
        <div>
          <Typography.Text strong>场景</Typography.Text>
          {scenarios?.error ? (
            <EchoBlock text={"场景列表加载失败：" + scenarios.error} testid="schedule-scenarios-error" />
          ) : (
            <Select showSearch style={{ width: "100%" }} value={subjectId} placeholder="选择场景"
              data-testid="schedule-field-subject_id" optionFilterProp="label"
              loading={scenarios === null} options={scenarios?.options ?? []}
              onChange={(v) => setSubjectId(v)} />
          )}
        </div>
        <div>
          <Typography.Text strong>环境（可选）</Typography.Text>
          <Select allowClear style={{ width: "100%" }} value={envId} placeholder={envs ? "不绑定环境" : "加载中…"}
            data-testid="schedule-field-env_id" loading={envs === null} options={envs?.options ?? []}
            onChange={(v) => setEnvId(v ?? null)} />
          {editing && (
            <Typography.Text className="tp-text-sm" type="secondary">
              后端 PATCH 把 env_id=null 视为「未改动」——清空再保存不会解绑环境，换环境请直接选另一个。
            </Typography.Text>
          )}
        </div>
        <div>
          <Typography.Text strong>计划</Typography.Text>
          <Radio.Group data-testid="schedule-plan-mode" style={{ display: "block", marginTop: 4 }}
            value={planMode} onChange={(e) => setPlanMode(e.target.value as PlanMode)}>
            <Radio value="daily">每天</Radio>
            <Radio value="weekly">每周</Radio>
            <Radio value="custom">自定义 cron</Radio>
          </Radio.Group>
          {planMode === "daily" && (
            <Space size={6} style={{ marginTop: 6 }} data-testid="schedule-plan-daily">
              <span>时刻</span>
              <Select data-testid="schedule-plan-hour" style={{ width: 72 }} value={hour} virtual={false}
                options={HOUR_OPTIONS} onChange={(v) => setHour(v)} />
              <span>:</span>
              <Select data-testid="schedule-plan-minute" style={{ width: 72 }} value={minute} virtual={false}
                options={MINUTE_OPTIONS} onChange={(v) => setMinute(v)} />
            </Space>
          )}
          {planMode === "weekly" && (
            <div data-testid="schedule-plan-weekly" style={{ marginTop: 6 }}>
              <Checkbox.Group data-testid="schedule-plan-days" options={DOW_OPTIONS} value={days}
                onChange={(v) => setDays(v as number[])} style={{ rowGap: 6, display: "flex", flexWrap: "wrap" }} />
              <Space size={6} style={{ marginTop: 6, display: "flex" }}>
                <span>时刻</span>
                <Select data-testid="schedule-plan-hour" style={{ width: 72 }} value={hour} virtual={false}
                  options={HOUR_OPTIONS} onChange={(v) => setHour(v)} />
                <span>:</span>
                <Select data-testid="schedule-plan-minute" style={{ width: 72 }} value={minute} virtual={false}
                  options={MINUTE_OPTIONS} onChange={(v) => setMinute(v)} />
              </Space>
              {planCron === null && (
                <Typography.Text className="tp-text-sm" type="danger" style={{ display: "block", marginTop: 4 }}
                  data-testid="schedule-plan-empty">至少勾选一个星期，否则拼不出 cron。</Typography.Text>
              )}
            </div>
          )}
          {planMode === "custom" && (
            <div data-testid="schedule-plan-custom" style={{ marginTop: 6 }}>
              <Input data-testid="schedule-field-cron" value={customCron} placeholder="0 2 * * *"
                onChange={(e) => setCustomCron(e.target.value)} />
              <Typography.Text className="tp-text-sm" type="secondary" style={{ display: "block", marginTop: 4 }}>
                前端不校验 cron——合法与否唯一裁判是后端，非法会 422 并把原话回显在这里。
              </Typography.Text>
            </div>
          )}
          {/* 将写入的 cron 永远同屏：三态只是拼串的外壳，落库串本身不许藏在用户看不见处。
              空态分两种说清：每周态是「没勾星期拼不出」，自定义态是「框还空着」——
              合成一个空白是在用户问「我到底会存什么」时装没看见。 */}
          <Typography.Text className="tp-text-sm" data-testid="schedule-plan-derived" code style={{ display: "block", marginTop: 6 }}>
            将写入：{planCron === null ? "（未拼出：星期一天没勾）" : planCron === "" ? "（未填 cron）" : planCron}
          </Typography.Text>
        </div>
        <Space>
          <Button data-testid="schedule-preview-btn" onClick={() => void previewNext5()}>预览未来 5 次</Button>
          <Typography.Text className="tp-text-sm" type="secondary">按当前输入（未保存的草稿）计算</Typography.Text>
        </Space>
        {preview.kind !== "idle" && (
          <div data-testid="schedule-preview-out">
            {preview.kind === "hint" && (
              <Typography.Text type="secondary" data-testid="schedule-preview-hint">{preview.text}</Typography.Text>
            )}
            {preview.kind === "error" && <EchoBlock text={preview.text} testid="schedule-preview-error" />}
            {preview.kind === "times" && (
              <ol style={{ margin: 0, paddingLeft: 20 }}>
                {preview.times.map((t) => (
                  <li key={t} data-testid="schedule-preview-time">{fmtTime(t) ?? t}</li>
                ))}
              </ol>
            )}
          </div>
        )}
        <div>
          <Typography.Text strong>通知渠道（可选，执行结果发到这里）</Typography.Text>
          {channels === null ? (
            <Select mode="multiple" disabled style={{ width: "100%" }} value={channelIds} placeholder="加载中…" />
          ) : channels.error ? (
            // 加载失败降级：只读提示 + 已挂 id 原样留形——绝不把 id 编成渠道名。
            // WHY: catch 收的是 403/500/超时/断网一切失败，只有 ApiErr.status=403
            // 才配喊「权限」，否则一句诊断把五种病都赖在权限头上。
            <div data-testid="schedule-channels-fallback">
              <Alert type="warning" showIcon
                message={channels.is403 ? "无渠道读取权限，无法展示渠道名称" : "渠道列表加载失败，无法展示渠道名称"}
                description={channels.error} />
              <Typography.Text className="tp-text-sm" type="secondary">
                当前已挂渠道 ID：{channelIds.length ? channelIds.join("、") : "（无）"}（保存时原样保留，不做改动）
              </Typography.Text>
            </div>
          ) : (
            <Select mode="multiple" allowClear style={{ width: "100%" }} value={channelIds}
              data-testid="schedule-field-channels" placeholder="选择通知渠道"
              optionFilterProp="label" options={channels.options}
              onChange={(v) => setChannelIds(v as string[])} />
          )}
        </div>
        <Space>
          <Typography.Text strong>启用</Typography.Text>
          <Switch checked={enabled === 1} data-testid="schedule-field-enabled"
            onChange={(c) => setEnabled(c ? 1 : 0)} />
        </Space>
        {saveErr && (
          <Alert type="error" showIcon closable data-testid="schedule-save-error" message="后端拒绝（原话回显）"
            description={<EchoBlock text={saveErr} testid="schedule-save-error-text" />}
            onClose={() => setSaveErr(null)} />
        )}
      </Space>
    </Drawer>
  );
}

// ── 页体 ─────────────────────────────────────────────────────────────────────

function TasksPanel() {
  const { project, user } = useAuth();
  const projectId = project!.id;
  const perms = patternsForProject(project, user?.is_system_admin);
  const mayRead = can(perms, "schedule:task:read");
  const canCreate = can(perms, "schedule:task:create");
  const canUpdate = can(perms, "schedule:task:update");
  const canDelete = can(perms, "schedule:task:delete");

  const [rows, setRows] = useState<TaskRow[]>([]);
  // D47-b：页码分页（current/size/total）替换「加载更多」游标追加。一页只许有一个
  // 「我在第几页」的真相——按钮和页码并存就是两把尺子，后端拿 400 禁的正是这个。
  // 原固定 size=50 恰好是档位表里的 50，保持 50 起步（不是「悄悄变少」——数值没动）。
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState<number | null>(null);
  const [enabledFilter, setEnabledFilter] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ editing: TaskRow | null } | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // 场景候选拉在页体（size=200 一页，与 reports.tsx 筛选项同口径）：主体列的「场景名」
  // 和抽屉的选场景下拉共用这一份——列里每行再发一次请求是 N+1，抽屉自己再拉一份是两套真相。
  // 静默拉：失败只留错误原话给抽屉控件；主体列自然降级成截断 id。
  const [scenarios, setScenarios] = useState<Cands | null>(null);
  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const r = await get<Page<{ id: string; name: string }>>(
          "/scenarios?" + new URLSearchParams({ project_id: projectId, size: "200" }), { silent: true });
        if (!dead) setScenarios({ options: r.items.map((s) => ({ value: s.id, label: s.name })), error: null });
      } catch (e) {
        if (!dead) setScenarios({ options: [], error: e instanceof ApiErr ? e.message : "场景列表加载失败" });
      }
    })();
    return () => { dead = true; };
  }, [projectId]);
  const subjectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of scenarios?.options ?? []) m.set(o.value, o.label);
    return m;
  }, [scenarios]);

  // Ctrl+K 直达落点（?q=<任务id>）：那一条标出来。形状逐字抄 uiElements.tsx:70-78，
  // 三条来由在那边的注释里都挨过打，这里一条都不能丢：
  // ① seenQ 同一串 q 只认一次——用户关掉横幅之后不会被查询串「复活」（api.tsx ?def= 同顾虑）；
  // ② 记「上一个认过的 id」而不是一次性 latch：hash 直访是同文档导航，组件不重建，
  //    一次性 latch 会让第二次 Ctrl+K 落点继续高亮上一条（uiElements 自己就被钉测出来过）；
  // ③ 等 rows 加载完再认（rows.length 挡在 effect 里而不是交给 helper 返回 null，
  //    否则空列表会把这串 q 认成「找不到」并 latch 死，加载完也不会再认一次）。
  // 本页没有本地文本筛选（启停筛选是服务端参数）：行在 rows 里就一定在表里，
  // 所以横幅只有一种话；行不在 rows（D47-b 页码制：可能翻在其它页上，或被启停
  // 筛选挡在服务端外）时 helper 返回 null——老实什么都不标，不编一行。
  // 「在别的页」这个信息前端手上没有（只有当前页的行），横幅宁可不说也不能编。
  const [sp] = useSearchParams();
  const [hitId, setHitId] = useState<string | null>(null);
  const seenQ = useRef<string | null>(null);
  useEffect(() => {
    const target = sp.get("q");
    if (!target || seenQ.current === target || rows.length === 0) return;
    seenQ.current = target;
    setHitId(pickDeepLinkHit(rows, target));
  }, [sp, rows]);

  // 启停筛选是页体唯一的列表筛选，也是它唯一的写入口：改筛选必回第 1 页——停在第 7 页
  // 换筛选，落的是新条件下无关的切片甚至空页（listPagination.tsx 注释③同一 hazard）。
  // 回页钉在这唯一入口处，测试从第 3 页改筛选钉它。
  const applyEnabledFilter = (v: string | undefined): void => { setEnabledFilter(v); setCurrent(1); };

  // D127 的教训换了形态仍然成立：load 读 current/pageSize 并把它们放进依赖，但 load
  // 自己绝不写 current/pageSize（只有 pager 回调和 applyEnabledFilter 写），所以取数
  // 落地不会重建 load、不会重跑下面的 effect——点一次页码恰好一条请求。
  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const q = new URLSearchParams({ project_id: projectId, size: String(pageSize), current: String(current),
        ...(enabledFilter ? { enabled: enabledFilter } : {}) });
      const page = await get<Page<TaskRow>>("/schedule-tasks?" + q.toString(), { silent: true });
      setRows(page.items);
      // total 只从响应来，永不由 items.length 客户端现攒（页内行数不是总数）。
      // 缺键（后端尚未上页码模式）→ null → ListPager 整块不渲染。
      setTotal(page.total ?? null);
    } catch (e) {
      setRows([]);
      // 失败不留谎脚注：total 清空，不许在空表上面挂一条陈旧的「共 N 条」。
      setTotal(null);
      setLoadError(e instanceof ApiErr ? e.message : "定时任务列表加载失败");
    } finally { setLoading(false); }
  }, [projectId, enabledFilter, current, pageSize]);
  useEffect(() => { if (mayRead) void load(); }, [mayRead, load]);

  const upsert = (row: TaskRow) => setRows((prev) => {
    const i = prev.findIndex((r) => r.id === row.id);
    if (i < 0) return [...prev, row];
    const next = [...prev];
    next[i] = row;
    return next;
  });

  // 落点那条的名字（横幅用）；行不在已加载集里时 hitId 就是 null，这里自然空。
  const hitRow = useMemo(() => rows.find((r) => r.id === hitId) ?? null, [rows, hitId]);

  /** 启停 = PATCH enabled（1/0 整数，TaskUpdateIn.ge=0/le=1 的口径）。 */
  async function toggle(row: TaskRow, next: boolean): Promise<void> {
    setTogglingId(row.id);
    try {
      upsert(await patch<TaskRow>("/schedule-tasks/" + enc(row.id),
        { project_id: projectId, enabled: next ? 1 : 0 }));
    } catch { /* toast 已在 client 弹 */ } finally { setTogglingId(null); }
  }

  function removeOne(row: TaskRow): void {
    Modal.confirm({
      centered: true,
      title: `删除定时任务「${row.name}」？`,
      content: "调度真相在读表侧：删行即停排，错过的触发不补（D22）。不可恢复。",
      okText: "删除", okButtonProps: { danger: true, "data-testid": "schedule-delete-ok" }, cancelText: "取消",
      onOk: async () => {
        try {
          await post("/schedule-tasks/" + enc(row.id) + "/delete", { project_id: projectId });
          message.success("已删除");
          setRows((prev) => prev.filter((r) => r.id !== row.id));
        } catch { /* toast 已在 client 弹 */ }
      },
    });
  }

  const columns = [
    { title: "名称", dataIndex: "name", key: "name",
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    { title: "主体", key: "subject", width: 220,
      render: (_: unknown, r: TaskRow) => {
        // 名单里有才配叫名字；不在（场景已删/超出 size=200）画截断 id——留白和错名都算撒谎
        const name = subjectName.get(r.subject_id) ?? null;
        return (
          <span data-testid={"schedule-subject-" + r.id}>
            <Tag>{r.subject_type}</Tag>
            {name ? (
              <Typography.Text className="tp-text-sm" title={r.subject_id}>{name}</Typography.Text>
            ) : (
              <Typography.Text className="tp-text-sm" type="secondary" title={r.subject_id}>
                {shortId(r.subject_id)}
              </Typography.Text>
            )}
          </span>
        );
      } },
    { title: "调度", dataIndex: "cron", key: "cron", width: 170,
      render: (v: string) => {
        const h = humanizeCron(v);
        // 人话化只是糖：raw 串永远在同屏（下一行小字），说不了人话就只剩 raw
        return (
          <Tooltip title={h ? "cron 原文：" + v : undefined}>
            <span data-testid="schedule-cron">
              {h ? <div>{h}</div> : null}
              <Typography.Text className="tp-text-sm" code>{v}</Typography.Text>
            </span>
          </Tooltip>
        );
      } },
    { title: "启用", dataIndex: "enabled", key: "enabled", width: 80,
      render: (v: number, row: TaskRow) => (
        <Switch size="small" checked={v === 1} disabled={!canUpdate || togglingId === row.id}
          data-testid={"schedule-enabled-" + row.id}
          onChange={(c) => void toggle(row, c)} />
      ) },
    { title: "最近结果", dataIndex: "last_run", key: "last_run", width: 210,
      render: (lr: TaskRow["last_run"], row: TaskRow) => (
        <LastRunCell lastRun={lr} testid={"schedule-result-" + row.id} />
      ) },
    { title: "连续失败", dataIndex: "consecutive_failures", key: "consecutive_failures", width: 90,
      render: (n: number) => <span data-testid="schedule-failures">{n}</span> },
    { title: "操作", key: "ops", width: 200,
      render: (_: unknown, row: TaskRow) => (
        <Space size={4}>
          {/* 查看/编辑同一入口：打开抽屉的门槛就是列表读权限；保存按钮在抽屉里跟 update 权限走 */}
          <Button size="small" data-testid={"schedule-view-" + row.id}
            onClick={() => setDrawer({ editing: row })}>{canUpdate ? "编辑" : "查看"}</Button>
          {canDelete && (
            <Button size="small" danger data-testid={"schedule-remove-" + row.id}
              onClick={() => removeOne(row)}>删除</Button>
          )}
        </Space>
      ) },
  ];

  // 无读权限：表格压根不渲染（也不发列表请求）——只给一句人话，不演假空表。
  if (!mayRead) {
    return (
      <Alert type="warning" showIcon data-testid="schedule-no-read"
        message="当前项目没有 schedule:task:read 权限"
        description="定时任务列表需要读权限。列表与预览都是读类动作，权限位在后端把守。" />
    );
  }

  return (
    <div className="tp-fill tp-fill-body">
      <div style={{ flex: "0 0 auto" }}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select allowClear placeholder="按启停筛选" style={{ width: 150 }} value={enabledFilter}
          data-testid="schedule-filter-enabled" onChange={(v) => applyEnabledFilter(v)}
          options={[{ value: "1", label: "只看启用" }, { value: "0", label: "只看停用" }]} />
        {/* 刷新 = 重发当前页（load() 读 current），不回第 1 页：把用户从第 3 页弹回
            第 1 页不是「刷新」这个词的意思。 */}
        <Button icon={<ReloadOutlined />} data-testid="schedule-reload" onClick={() => void load()}>刷新</Button>
        {canCreate && (
          <Button type="primary" icon={<PlusOutlined />} data-testid="schedule-create"
            onClick={() => setDrawer({ editing: null })}>新建任务</Button>
        )}
      </Space>
      {loadError && (
        // 不 closable：这张表失败后是空的（catch 里 setRows([])），这条 Alert 是「这一屏没取到」
        // 的唯一证据。给个 × 等于发一个消证按钮——关掉之后屏幕只剩一张空表，
        // 读起来和「这个项目没有定时任务」一模一样。它消失只该有一条路：刷新成功。
        <Alert type="error" showIcon style={{ marginBottom: 12 }} data-testid="schedule-load-error"
          message="定时任务列表加载失败" description={<EchoBlock text={loadError} />} />
      )}
      {hitRow && (
        <Alert type="info" showIcon closable data-testid="schedule-hit" style={{ marginBottom: 12 }}
          message={"快捷搜索定位到「" + hitRow.name + "」——已在下表标出这一行。"}
          description="这条是 Ctrl+K 直达带过来的：URL 里带着任务 id，页面把它认出来并高亮那一行。"
          onClose={() => setHitId(null)} />
      )}
      </div>
      <div data-testid="schedules-table" className="tp-fill-body">
        <AdminTable rowKey="id" loading={loading} dataSource={rows} columns={columns}
          rowClassName={(r: TaskRow) => (r.id === hitId ? "tp-row-hit" : "")}
          cardFooter={(
            // 脚注与页码住进卡底（业主点名：卡有边有角，小字却散在卡外的页面底色上）。
            <div className="tp-cardfoot">
              <Typography.Text className="tp-cardfoot-note tp-text-sm" type="secondary">
              「最近结果」是后端回执原样：配色只认 run_final（run 终态后才合并进 last_run），
              没 run_final 有 run_id 只画触发时间与「执行结果未回」，没 run_id（未投递/投递失败）画
              「未产生执行，不会回结果」；连续失败计数到达阈值后的告警由后端投递，本页只如实展示计数。
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

      <TaskDrawer open={drawer !== null} editing={drawer?.editing ?? null} projectId={projectId}
        canWrite={canUpdate} scenarios={scenarios} onClose={() => setDrawer(null)} onSaved={upsert} />
    </div>
  );
}

export default function SchedulesPage() {
  return (
    <div data-testid="page-schedules" className="tp-fill-stack">
      <PageHead title="定时任务" descHover
        desc="按 cron 周期触发场景执行；停用不影响历史运行与报告。" />
      <ProjectGate><TasksPanel /></ProjectGate>
    </div>
  );
}
