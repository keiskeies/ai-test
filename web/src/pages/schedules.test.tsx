// 定时任务页（§11.4.17）组件测试（1E 补记；D76 补「最近结果/cron 人话化/主体场景名」）。
// fetch 全 mock，同 notifyChannels 手法。
// 最要紧的钉：
// ① 无 schedule:task:read → 表格压根不渲染（也不发列表请求）；
// ② READONLY（*:read,-system:*）下 [新建]/删除不在 DOM，抽屉里 [预览] 在、保存不在；
// ③ POST/PATCH 的 body 字段名与 schemas.py 逐字段一致（断言 JSON 本体，不是「发过请求」）；
// ④ 后端 422 的 message 原样上屏（含 crontab 原话）——前端零校验的假门反证；
// ⑤ [预览] 打 /schedule-tasks/next-5 且带的是**当前草稿** cron（编辑旧任务改成新串后发的新串）；
// ⑥ 渠道候选 403 → 降级只读提示，已挂 id 原样留形，绝不编造渠道名；
// ⑦ D76 三态：有 run_final 才配配色（ok 定生死）；没 run_final 按 run_id 分两句——
//    有 run_id（还在跑）只有 fired_at/run_id + 「执行结果未回」；没 run_id（未投递/
//    投递失败，回执压根没建 run）说「未产生执行，不会回结果」——两种都不许出现绿/红 Tag；
// ⑧ cron 人话化只说后端 cron.py（celery crontab）说得准的形状，说不了就 raw 兜底；
// ⑨ 主体列用页体那一份场景/计划列表（各只请求一次 /scenarios、/plans），名单外 id 画截断 id；
// ⑩ D76 尾账「计划」三选：反解 parsePlan 是 humanizeCron 的严格逆运算（选择器拼不出
//    原文的一律落自定义，如 `0 2 * * 1-5`）；POST/PATCH 断的是最终 cron 原文；
//    每天/每周可拼集合 round-trip（拼串→人话→反解回同态同值）；切态不静默清用户 cron。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConfigProvider } from "antd"; // schedule-save-error 可关例：motion:false 让 Alert 关闭即卸载（jsdom 无 transitionend）

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import SchedulesPage, { cronFromDaily, cronFromWeekly, humanizeCron, parsePlan, pickDeepLinkHit } from "./schedules";
import type { TaskRow } from "./schedules";
import { useAuth } from "../auth/store";

function task(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id, project_id: "p1", name: "任务" + id, subject_type: "scenario", subject_id: "s1",
    cron: "0 2 * * *", env_id: null, enabled: 1, notify_channel_ids: [],
    last_run: null, consecutive_failures: 0, created_at: null, updated_at: null, ...over,
  };
}

// 名单外主体（模拟已删场景/超出 size=200 页）：截断 id 的原料
const UNKNOWN_SUBJECT = "9f8e7d6c-5b4a-4321-8765-4321fedcba98";

const ROWS: TaskRow[] = [
  // run 终态已过：fire 回执 + notify 钩子合并的 run_final（notify/hooks._merged_receipt 形状）
  task("t1", { name: "夜间回归", notify_channel_ids: ["c1"],
    last_run: { ok: true, run_id: "r9", fired_at: "2026-11-16T10:00:00+08:00",
      run_final: { run_id: "r9", status: "passed", ok: true,
        finished_at: "2026-11-16T10:12:00+08:00", notified: true, channels: [],
        reason: null, alert_fired: false, consecutive_failures: 0 } } }),
  // run 终态未过 + 主体已不在场景名单
  task("t2", { name: "冒烟巡检", enabled: 0, consecutive_failures: 2, subject_id: UNKNOWN_SUBJECT,
    cron: "0 2 * * 1",
    last_run: { ok: true, run_id: "r8", fired_at: "2026-11-15T03:00:00+08:00",
      run_final: { run_id: "r8", status: "failed", ok: false,
        finished_at: "2026-11-15T03:09:00+08:00", notified: false, channels: [],
        reason: "未绑定通知渠道", alert_fired: false, consecutive_failures: 2 } } }),
  // 投出去了但 run 还没落终态（或钩子没跑）：没有 run_final → 不许配色
  task("t3", { name: "还在跑", cron: "0 2 15 * *",
    last_run: { ok: true, run_id: "r7", fired_at: "2026-11-16T09:00:00+08:00" } }),
  // fire 就没投出去（无 run_id、无 run_final）：顶层 ok=false 也不许画成「执行失败」
  task("t4", { name: "投递都没成", cron: "*/15 * * * *",
    last_run: { ok: false, reason: "投递失败：connection refused",
      fired_at: "2026-11-16T08:45:00+08:00" } }),
  task("t5", { name: "从没跑过" }),
  // 周字段区间：humanizeCron 能翻成人话，但计划选择器拼不出这个原文（只认列表）→ 必须落自定义
  task("t6", { name: "工作日区间", cron: "0 2 * * 1-5",
    last_run: { ok: true, run_id: "r6", fired_at: "2026-11-14T02:00:00+08:00" } }),
];

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

const READONLY_PROJECT = { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] };

const calls: { url: string; method: string; body: unknown }[] = [];

const RESP = {
  page: (items: unknown[]) => ({ items, next_cursor: null }),
  scenarios: { items: [{ id: "s1", name: "履约场景A" }], next_cursor: null },
  // D226：计划候选（主体类型 = plan 时抽屉/主体列共用）
  plans: { items: [{ id: "p9", name: "夜间回归计划" }], next_cursor: null },
  envs: { items: [{ id: "e1", name: "测试环境" }], next_cursor: null },
  channels: { items: [{ id: "c1", name: "钉钉值班群" }], next_cursor: null },
  NEXT5: { cron: "*/5 * * * *", times: ["2026-11-16T10:05:00+08:00", "2026-11-16T10:10:00+08:00",
    "2026-11-16T10:15:00+08:00", "2026-11-16T10:20:00+08:00", "2026-11-16T10:25:00+08:00"] },
  // crontab 原话（后端 _check_cron 的 422 message 形状）——前端只回显不重写
  CRON422: { code: "validation_failed", message: "cron 非法：Bug in crontab: 6 is not in range (0 - 59)!",
    details: { cron: "60 2 * * *" } },
  // 列表 5xx 的信封形状（client 把 message 原样塞进 ApiErr，loadError 再 EchoBlock 直出）
  LOAD503: { code: "schedule_unavailable", message: "调度服务暂不可用：DB 连接超时", details: {} },
};

interface BackendOpts {
  channelsStatus?: number; createStatus?: number;
  /** next-5 返 422（预览失败腿）。 */
  previewStatus?: number;
  /** 第一次列表 GET 失败、之后成功（reload 恢复腿）。 */
  listFailOnce?: boolean;
  /** 反向：第一次成功、第二次起一直失败。用来钉「刷新失败要把已有行清零」——
   *  `listFailOnce` 那一种首屏就没行，删掉 catch 里的 `setRows([])` 也看不出区别。 */
  listFailAfterFirst?: boolean;
  /** 追加到默认列表尾部的行（不碰 ROWS——既有用例钉着 ROWS.length 与逐行文案）。 */
  extraRows?: TaskRow[];
  /** D47-b 页码分页 fixture：按 current 参数路由（缺省=第 1 页，越界回最后一页），
   *  响应带 total。不带此选项时响应没有 total 键（后端游标式形状 → 分页器不渲染）。 */
  paged?: { items: TaskRow[]; total: number }[];
  /** 启停筛选按参数路由：enabled=0 只回停用行、enabled=1 只回启用行、无参数回全量。 */
  filterByEnabled?: boolean;
  /** 预览：草稿 cron 等于该串时返 422（其余照常成功）——同一次抽屉里成功→失败两拍。 */
  previewFailCron?: string;
  /** 新建 POST 直接 422，且信封 message 用这个串（schedule-save-error 的「原话回显」腿：
   *  消息必须足够独特，任何「前端自己翻译一句」的实现都会在这条断言上露馅）。 */
  createFailMessage?: string;
}

function mockBackend(over: BackendOpts = {}) {
  calls.length = 0;
  let listFailed = false;
  let listGets = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const resp = (status: number, json: unknown) => ({
      ok: status < 400, status,
      // 每次调用都现拷一份：真 fetch 每次解析出一棵**全新的对象图**。桩若把同一个对象反复
      // 交出，setRows(同一个数组引用) 会被 React 按同一性直接跳过，「取数落地把 load 的
      // 依赖改脏 → effect 重跑 → 无限请求」这类回路在线上必现、在这种桩下永远测不出
      // （reports.tsx 的 load 依赖里一度真的多了 items；桩比真接口更好说话=把 bug 藏进桩里）。
      json: async () => JSON.parse(JSON.stringify(json)) as unknown,
    }) as unknown as Response;
    // D240：高级搜索三件套的依赖（元数据 / 个人视图）。不 mock 的话未 mock 请求直接 throw，
    // 「本测试没 mock」会被演成「筛选功能故障」。
    if (url.includes("/filter-meta?")) {
      return resp(200, {
        view_type: "schedule", view_label: "定时任务",
        supported_view_types: ["schedule"],
        fields: [
          { field: "name", label: "任务名称", kind: "text",
            ops: ["CONTAINS", "NOT_CONTAINS", "EQUALS", "NOT_EQUALS"] },
          { field: "subject_type", label: "主体类型", kind: "enum",
            ops: ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN"] },
          { field: "enabled", label: "启用（1/0）", kind: "number",
            ops: ["EQUALS", "NOT_EQUALS", "GT", "LT", "BETWEEN"] },
        ],
        unavailable: {},
      });
    }
    if (url.includes("/saved-views?")) return resp(200, []);
    if (url.includes("/schedule-tasks/next-5") && method === "POST") {
      if (over.previewStatus === 422) return resp(422, RESP.CRON422);
      if (over.previewFailCron && (body as { cron?: string })?.cron === over.previewFailCron) {
        return resp(422, RESP.CRON422);
      }
      return resp(200, RESP.NEXT5);
    }
    if (/\/schedule-tasks\/[^/?]+\/delete$/.test(url) && method === "POST") return resp(200, { ok: true });
    if (url.includes("/schedule-tasks?") && method === "GET") {
      if (over.listFailOnce && !listFailed) { listFailed = true; return resp(503, RESP.LOAD503); }
      if (over.listFailAfterFirst) { listGets += 1; if (listGets > 1) return resp(503, RESP.LOAD503); }
      if (over.paged) {
        // 页码路由：current 缺省=1，越界回最后一页（最后一页之后的行为不归前端管）
        const cur = Number(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("current") ?? "1");
        const p = over.paged[Math.min(Math.max(cur, 1), over.paged.length) - 1];
        return resp(200, { items: p.items, next_cursor: null, total: p.total });
      }
      if (over.filterByEnabled) {
        const en = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("enabled");
        const items = ROWS.filter((r) => en === null || String(r.enabled) === en);
        return resp(200, RESP.page(items));
      }
      return resp(200, RESP.page([...ROWS, ...(over.extraRows ?? [])]));
    }
    if (url.includes("/schedule-tasks") && method === "POST") {
      if (over.createStatus === 422) return resp(422, RESP.CRON422);
      if (over.createFailMessage) {
        return resp(422, { code: "validation_failed", message: over.createFailMessage, details: {} });
      }
      return resp(201, { ...task("t9"), ...body, created_at: null, updated_at: null });
    }
    const m = url.match(/\/schedule-tasks\/([^/?]+)$/);
    if (m && method === "PATCH") {
      const row = ROWS.find((r) => r.id === m[1]) ?? ROWS[0];
      return resp(200, { ...row, ...body });
    }
    if (url.includes("/scenarios?")) return resp(200, RESP.scenarios);
    if (url.includes("/plans?")) return resp(200, RESP.plans);
    if (url.includes("/envs?")) return resp(200, RESP.envs);
    if (url.includes("/notify-channels?")) {
      if (over.channelsStatus === 403) {
        return resp(403, { code: "forbidden", message: "无权查看通知渠道", details: {} });
      }
      // 非权限类失败（S3 的靶）：500 不许被降级提示诊断成「权限」问题
      if (over.channelsStatus === 500) {
        return resp(500, { code: "internal_error", message: "渠道服务 500：数据库连接重置", details: {} });
      }
      return resp(200, RESP.channels);
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
}

// vitest 无 globals ⇒ RTL 的自动 cleanup 不会注册：两头各钉一次（beforeEach 清上一条
// 的残留，afterEach 清本条的），否则「全页只许两个配色 Tag」这类全局查询会被上一条用例污染。
afterEach(cleanup);

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

/** 展开抽屉里指定 testid 的 antd 下拉。不再按 .ant-select-selector 数第 n 个：
 *  计划选择器在每天/每周态多插了时刻/分钟两份下拉，按 DOM 顺序数必然错位。 */
function openSelectByTestId(testid: string): void {
  const trigger = screen.getByTestId(testid).querySelector(".ant-select-selector") as HTMLElement;
  fireEvent.mouseDown(trigger);
}

/** 计划区的时刻下拉（daily/weekly 态共用同一对 testid，各自块内各只有一份）。 */
async function setClock(hourLabel: string, minuteLabel: string): Promise<void> {
  openSelectByTestId("schedule-plan-hour");
  await clickOption(hourLabel);
  openSelectByTestId("schedule-plan-minute");
  await clickOption(minuteLabel);
}

/** 勾 / 取消勾选某个星期（Checkbox.Group 内的原生 input）。 */
function toggleDay(label: string): void {
  const wrap = screen.getByTestId("schedule-plan-days");
  const input = [...wrap.querySelectorAll("label")].find((l) => l.textContent === label)!;
  fireEvent.click(input.querySelector("input") as HTMLElement);
}

/** 点计划 Radio.Group 里的某个态。 */
function radio(label: "每天" | "每周" | "自定义 cron"): void {
  const group = screen.getByTestId("schedule-plan-mode");
  const input = [...group.querySelectorAll("label")].find((l) => l.textContent === label)!;
  fireEvent.click(input.querySelector("input") as HTMLElement);
}

/** 点下拉浮层里的选项（D76 起场景名同屏出现在主体列，getByText 会撞主体列那一份）。
 *  只认**当前展开**的浮层：一个测试里先后展开多个下拉时，收起的浮层可能仍留在 DOM，
 *  不限定就会撞上别家下拉的同文案选项。 */
async function clickOption(text: string): Promise<void> {
  const opt = await screen.findByText(text, {
    selector: ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content",
  });
  fireEvent.click(opt);
}

async function openDrawer(testid: string): Promise<void> {
  await waitFor(() => expect(screen.getByTestId(testid)).not.toBeNull());
  fireEvent.click(screen.getByTestId(testid));
  await waitFor(() => expect(screen.getByTestId("schedule-plan-mode")).not.toBeNull());
}

describe("权限门", () => {
  it("无 schedule:task:read：表格不渲染，列表请求压根不发", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "MEMBER", my_perms: ["notify:channel:read"] } });
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-no-read")).not.toBeNull());
    expect(screen.queryByTestId("schedules-table")).toBeNull();
    expect(calls.some((c) => c.url.includes("/schedule-tasks?"))).toBe(false);
  });

  it("READONLY：新建/删除不在 DOM；抽屉里保存不在、预览在（next-5 是 POST 但 perm :read 结尾）", async () => {
    useAuth.setState({ project: READONLY_PROJECT });
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-view-t1")).not.toBeNull());
    // D127 绊线（reports.filters.test.tsx renderAndSettle 同款）：挂载稳定后列表 GET
    // 必须恰好一条。放在**全文件最早挂载列表**的用例上——load 依赖里塞回它自己写的
    // state 时，回路在这里当场红一句 expected length 1 but got N；绊线若只在页码块里，
    // 回路会先把 worker 打死，全文件只剩一句 tinypool onUnexpectedExit，看不出谁的锅。
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((c) => c.method === "GET" && c.url.includes("/schedule-tasks?"))).toHaveLength(1);
    expect(screen.queryByTestId("schedule-create")).toBeNull();
    expect(screen.queryByTestId("schedule-remove-t1")).toBeNull();
    await openDrawer("schedule-view-t1");
    expect(screen.queryByTestId("schedule-save")).toBeNull();
    expect(screen.getByTestId("schedule-preview-btn")).not.toBeNull();
  });
});

describe("最近结果三态（配色只认 run_final.ok，回执里没有的语义不编）", () => {
  it("run_final.ok=true → 绿 Tag + 完成时间；ok=false → 红 Tag；连续失败整数直出", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-result-t1")).not.toBeNull());
    const c1 = within(screen.getByTestId("schedule-result-t1"));
    expect(c1.getByTestId("schedule-result-tag").className).toContain("ant-tag-green");
    expect(c1.getByTestId("schedule-result-tag").textContent).toBe("通过"); // runVocab STATUSES.passed
    expect(c1.getByTestId("schedule-last-run-time").textContent).toBe("完成 2026-11-16 10:12:00");
    expect(c1.getByText("run r9")).not.toBeNull();
    const c2 = within(screen.getByTestId("schedule-result-t2"));
    expect(c2.getByTestId("schedule-result-tag").className).toContain("ant-tag-red");
    expect(c2.getByTestId("schedule-result-tag").textContent).toBe("断言失败"); // STATUSES.failed
    expect(c2.getByTestId("schedule-last-run-time").textContent).toBe("完成 2026-11-15 03:09:00");
    expect(screen.getAllByTestId("schedule-failures").map((n) => n.textContent))
      .toEqual(["0", "2", "0", "0", "0", "0"]);
  });

  it("没有 run_final：有 run_id →「执行结果未回」；没 run_id（未投递/投递失败）→「未产生执行，不会回结果」；两者零配色 Tag", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-result-t3")).not.toBeNull());
    const c3 = within(screen.getByTestId("schedule-result-t3"));
    expect(c3.queryByTestId("schedule-result-tag")).toBeNull();
    expect(c3.getByTestId("schedule-last-run-time").textContent).toBe("2026-11-16 09:00:00");
    expect(c3.getByText("执行结果未回")).not.toBeNull(); // 有 run_id：结果真的可能还在路上
    expect(c3.getByText("run r7")).not.toBeNull();
    // fire 顶层 ok=false（投递失败，run 压根没建 / 孤儿 run 被当场删）：既不配色，
    // 也不许许诺「执行结果未回」——不会有的结果不承诺在路（service.py 两种无 run 回执）
    const c4 = within(screen.getByTestId("schedule-result-t4"));
    expect(c4.queryByTestId("schedule-result-tag")).toBeNull();
    expect(c4.getByText("未产生执行，不会回结果")).not.toBeNull();
    expect(c4.queryByText("执行结果未回")).toBeNull();
    expect(c4.getByText("投递失败：connection refused")).not.toBeNull();
    expect(c4.getByText("—")).not.toBeNull(); // 缺 run_id 仍画「—」
    // 全页配色 Tag 只许出现在 t1/t2 两个有 run_final 的单元里
    expect(screen.getAllByTestId("schedule-result-tag").length).toBe(2);
    // last_run=null 的 t5 照旧「从未触发」
    expect(screen.getByText("从未触发")).not.toBeNull();
  });

  it("未投递回执（场景已删，无 run_id 有 reason）→ 说「未产生执行」并把 reason 原样直出", async () => {
    mockBackend({ extraRows: [task("t7", { name: "场景没了",
      last_run: { ok: false, reason: "场景不存在，未投递",
        fired_at: "2026-11-16T07:00:00+08:00" } })] });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-result-t7")).not.toBeNull());
    const c7 = within(screen.getByTestId("schedule-result-t7"));
    expect(c7.queryByTestId("schedule-result-tag")).toBeNull();
    expect(c7.getByText("未产生执行，不会回结果")).not.toBeNull();
    expect(c7.queryByText("执行结果未回")).toBeNull();
    expect(c7.getByText("场景不存在，未投递")).not.toBeNull();
  });
});

// ── D163：run_final.reason / channels[].error 后端写了（notify/hooks._handle），
//    前端终态分支必须渲染——「未绑定通知渠道」/渠道发送失败原文不许藏。──────────────
describe("run_final.reason 与渠道失败原文（D163：后端写了前端零渲染 = 藏证据）", () => {
  it("rf.reason 非空 → secondary 一行原话直出（t2 未绑定通知渠道）；rf.reason=null 的 t1 不多渲染", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-result-t2")).not.toBeNull());
    const c2 = within(screen.getByTestId("schedule-result-t2"));
    expect(c2.getByTestId("schedule-final-reason").textContent).toBe("未绑定通知渠道");
    // 负的一侧：t1 的 rf.reason=null、channels=[]——等它的 Tag 真落地再断「不多渲染」，
    // 否则读的是还没回包的空壳（假绿）。
    const c1 = within(screen.getByTestId("schedule-result-t1"));
    await waitFor(() => expect(c1.getByTestId("schedule-result-tag")).not.toBeNull());
    expect(c1.queryByTestId("schedule-final-reason")).toBeNull();
    expect(c1.queryAllByTestId("schedule-channel-error")).toHaveLength(0);
  });

  it("channels 一成功两失败 → 只 ok=false 项上屏且含 error 原文；缺 name 画截断 id 不编名；成功项不出现", async () => {
    // run ok=true 但通知失败是真实形状（通知坏了 ≠ 执行坏了）：渲染不许只挂在 ok=false 上。
    // channels 里混入 null/字符串垃圾项：未知形状防御取值，不许崩也不许上屏。
    mockBackend({ extraRows: [task("t11", { name: "渠道发送失败",
      last_run: { ok: true, run_id: "r11", fired_at: "2026-11-16T10:00:00+08:00",
        run_final: { run_id: "r11", status: "passed", ok: true,
          finished_at: "2026-11-16T10:05:00+08:00", notified: true, reason: null, alert_fired: false,
          channels: [
            { channel_id: "c1", name: "钉钉值班群", ok: true, error: null },
            { channel_id: "c2", name: "邮件组", ok: false, error: "发送失败：HTTP 502 Bad Gateway（码 0x1f6）" },
            { channel_id: "c404abcd-1234-5678-9abc-def012345678", ok: false, error: "渠道不存在" },
            null, "junk",
          ] } } })] });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-result-t11")).not.toBeNull());
    const c = within(screen.getByTestId("schedule-result-t11"));
    await waitFor(() => expect(c.getAllByTestId("schedule-channel-error")).toHaveLength(2));
    const texts = c.getAllByTestId("schedule-channel-error").map((n) => n.textContent ?? "");
    expect(texts[0]).toContain("邮件组");
    expect(texts[0]).toContain("发送失败：HTTP 502 Bad Gateway（码 0x1f6）"); // error 原文逐字，不翻译
    expect(texts[1]).toContain("渠道不存在");
    expect(texts[1]).toContain("c404abcd…"); // 渠道已删无 name → 截断 id（主体列同尺），绝不编名
    expect(texts[1]).not.toContain("c404abcd-1234"); // 全长 id 不进可见文本
    // 成功项不上屏（m3 的靶：摘掉 ok=false 过滤，钉钉值班群也会混进来）
    expect(screen.getByTestId("schedule-result-t11").textContent).not.toContain("钉钉值班群");
  });

  it("rf 根本没有 reason/channels 键 → 一行都不多渲染（负断言等数据真落地）", async () => {
    mockBackend({ extraRows: [task("t12", { name: "裸终态",
      last_run: { ok: true, run_id: "r12", fired_at: "2026-11-16T10:00:00+08:00",
        run_final: { run_id: "r12", status: "passed", ok: true,
          finished_at: "2026-11-16T10:06:00+08:00" } } })] });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-result-t12")).not.toBeNull());
    const c = within(screen.getByTestId("schedule-result-t12"));
    await waitFor(() => expect(c.getByTestId("schedule-result-tag").textContent).toBe("通过"));
    expect(c.queryByTestId("schedule-final-reason")).toBeNull();
    expect(c.queryAllByTestId("schedule-channel-error")).toHaveLength(0);
  });
});

describe("cron 人话化（只说 celery crontab 说得准的，说不准 raw 兜底）", () => {
  // 形状×期望逐条对 backend/app/modules/schedule/cron.py 的尺（5 段 + celery 关键字映射，
  // 周字段 0=周日…6=周六）——期望值里的 weekday 已用 next_fire_times 实算核对过。
  it.each([
    ["0 2 * * *", "每天 02:00"],
    ["5 4 * * *", "每天 04:05"],
    ["0 2 * * 1", "每周一 02:00"],
    ["0 2 * * 0", "每周日 02:00"], // celery 周字段 0=周日（repo cron.py 实算：0→Sun）
    ["30 9 * * 1-5", "每周一、周二、周三、周四、周五 09:30"],
    ["0 2 15 * *", "每月 15 日 02:00"],
    ["*/15 * * * *", "每 15 分钟"],
    ["*/20 * * * *", "每 20 分钟"], // 20 | 60：每小时内 {0,20,40}，跨小时仍是均匀 20 分
  ])("%s → %s", (cron, want) => {
    expect(humanizeCron(cron)).toBe(want);
  });
  // 「每 N 分钟」要求 N | 60：celery 分钟步进集 {0,N,2N…}∩[0,59] 每小时归零，
  // N 不整除 60 时小时尾部间隔是 60−N·⌊59/N⌋ ≠ N（repo venv 实算：*/7 尾部只有 1 分、
  // */25 是 00:00/00:25/00:50/01:00、*/45 是 45 分后接 15 分）——均匀性一说就谎，raw 兜底。
  it.each([
    "*/7 * * * *",        // 59→00:00 只隔 1 分钟
    "*/25 * * * *",       // 00:50→01:00 只隔 10 分钟
    "*/45 * * * *",       // 00:45→01:00 只隔 15 分钟
    "*/8 * * * *",        // 56→00:00 只隔 4 分钟
    "*/0 * * * *",        // 0 起步长没有意义（后端也 422），更不许翻成人话
  ])("%s → null（步进不整除 60，间隔不均，raw 兜底）", (cron) => {
    expect(humanizeCron(cron)).toBeNull();
  });
  it.each([
    "0 2 * * 7",          // celery 周字段上限 6，7 会被后端 422——不替非法形状编人话
    "0 2 15 6 *",         // 月限定：一年一次，说「每月 15 日」就是撒谎
    "0 2 15 * 1",         // 日+周同时限定 = OR 语义，一句人话装不下
    "2,17 * * * *",       // 分字段列表
    "*/5 */2 * * *",      // 小时步进
    "0 2 * * 1-7",        // 区间越界（7 非法）
    "0 2 * *",            // 段数不对（后端同样 422，这里 raw 兜底）
    "0 25 * * *",         // 越界小时（不替非法形状编人话）
    "@daily",             // 非 5 段别名
  ])("%s → null（raw 兜底）", (cron) => {
    expect(humanizeCron(cron)).toBeNull();
  });
  it("列表里：说得准的行人话 + raw 同屏；说不准的只剩 raw", async () => {
    mockBackend({ extraRows: [task("t8", { name: "不均匀步进", cron: "*/45 * * * *" })] });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId("schedule-cron").length).toBe(ROWS.length + 1));
    const cells = screen.getAllByTestId("schedule-cron").map((n) => n.textContent);
    expect(cells).toContain("每天 02:000 2 * * *"); // 人话行 + raw 行（t1/t5 同 cron）
    expect(cells).toContain("每周一 02:000 2 * * 1");
    expect(cells).toContain("每月 15 日 02:000 2 15 * *");
    expect(cells).toContain("每 15 分钟*/15 * * * *");
    expect(cells).toContain("*/45 * * * *"); // 不整除 60 的步进：只剩 raw，不许有「每 45 分钟」
    expect(cells.some((t) => t?.startsWith("每 45 分钟"))).toBe(false);
  });
});

// ── D76 尾账「计划」三选：反解（parsePlan）/ 拼串 / round-trip ─────────────────
// 口径：每天/每周两态各拼唯一规范串（无零时分、升序去重列表）；parsePlan 只认
// 选择器能逐字节重拼出来的串，其余（区间/乱序/重复/前导零/日或月限定…）一律自定义。

describe("parsePlan 反解落点（humanizeCron 的严格逆运算：拼不出原文就落自定义）", () => {
  it.each([
    ["0 2 * * *", { mode: "daily", hour: 2, minute: 0 }],
    ["5 4 * * *", { mode: "daily", hour: 4, minute: 5 }],
    ["0 0 * * *", { mode: "daily", hour: 0, minute: 0 }],
    ["59 23 * * *", { mode: "daily", hour: 23, minute: 59 }],
    ["0 2 * * 1", { mode: "weekly", days: [1], hour: 2, minute: 0 }],
    ["0 2 * * 0", { mode: "weekly", days: [0], hour: 2, minute: 0 }], // celery 0=周日
    ["0 2 * * 1,3", { mode: "weekly", days: [1, 3], hour: 2, minute: 0 }],
    ["30 9 * * 0,2,6", { mode: "weekly", days: [0, 2, 6], hour: 9, minute: 30 }],
  ] as const)("%s → 每天/每周态 %j", (cron, want) => {
    expect(parsePlan(cron)).toEqual(want);
  });
  it.each([
    "0 2 * * 1-5",   // 区间：humanizeCron 翻得出「每周一…周五 02:00」，但选择器拼不回区间原文
    "0 2 * * 5,1",   // 乱序列表（选择器只会拼升序，认下来就是偷偷改写原文）
    "0 2 * * 1,1",   // 重复（同上，去重即改写）
    "05 02 * * *",   // 前导零：选择器会重拼成 "5 2 * * *"，改原文即出局
    "0 2 * * 07",    // 周字段前导零同理
    "0 2 15 * *", "0 2 15 6 *", "0 2 15 * 1",  // 日限定 / 月限定 / 日+周 OR——三选装不下
    "*/15 * * * *", "2,17 * * * *", "*/5 */2 * * *", // 步进与分字段列表
    "0 2 * * 7", "0 25 * * *", "60 2 * * *",   // 越界（后端也 422，这里同样不许演成可编辑态）
    "0 2 * *", "@daily", "",                    // 段数不对 / 别名 / 空
  ])("%s → 自定义（raw 原样随行，不演可编辑态）", (cron) => {
    expect(parsePlan(cron)).toEqual({ mode: "custom", cron });
  });
});

describe("round-trip：选择器拼串 → humanizeCron 同句人话 → parsePlan 回同态同值", () => {
  // 期望句写死在表里（不复用实现里的映射），防「实现错了断言跟着错」的同谋测试。
  it.each([
    [0, 0, "每天 00:00"],
    [2, 0, "每天 02:00"],
    [4, 5, "每天 04:05"],
    [23, 59, "每天 23:59"],
  ] as const)("每天 %i:%i 拼串→人话→反解逐字节回环", (hour, minute, want) => {
    const cron = cronFromDaily(hour, minute);
    const p = parsePlan(cron);
    expect(humanizeCron(cron)).toBe(want);
    expect(p).toEqual({ mode: "daily", hour, minute });
    // 反解回的值再拼一次：逐字节相同（round-trip 闭包）
    expect(p.mode === "daily" && cronFromDaily(p.hour, p.minute)).toBe(cron);
  });
  it.each([
    [[1], 2, 0, "每周一 02:00"],
    [[0], 2, 0, "每周日 02:00"],
    [[6], 23, 59, "每周六 23:59"],
    [[0, 6], 0, 0, "每周日、周六 00:00"],
    [[1, 3, 5], 9, 30, "每周一、周三、周五 09:30"],
  ] as const)("每周 %j %i:%i 拼串→人话→反解逐字节回环", (days, hour, minute, want) => {
    const cron = cronFromWeekly([...days], hour, minute);
    if (cron === null) throw new Error("不该拼不出：" + JSON.stringify(days));
    const p = parsePlan(cron);
    expect(humanizeCron(cron)).toBe(want);
    expect(p).toEqual({ mode: "weekly", days: [...days], hour, minute });
    expect(p.mode === "weekly" && cronFromWeekly(p.days, p.hour, p.minute)).toBe(cron);
  });
  it("cronFromWeekly 乱序/重复输入拼成升序去重规范串；空列表拼不出（null）", () => {
    expect(cronFromWeekly([3, 1, 3], 2, 0)).toBe("0 2 * * 1,3");
    expect(cronFromWeekly([], 2, 0)).toBeNull();
  });
});

describe("抽屉计划三选：渲染 / 反解落点 / 切态不丢原文（断最终 body 的 cron）", () => {
  /** 当前选中的计划态（Radio 原生 checked，不靠文案碰运气）。 */
  function checkedMode(): string | null {
    const group = screen.getByTestId("schedule-plan-mode");
    for (const l of [...group.querySelectorAll("label")]) {
      if ((l.querySelector("input") as HTMLInputElement).checked) return l.textContent;
    }
    return null;
  }

  it("新建：默认「每天」态且默认 02:00 明晃晃在 derived 行（不是藏起来的 0 0 * * *）", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("schedule-create"));
    await waitFor(() => expect(screen.getByTestId("schedule-plan-mode")).not.toBeNull());
    expect(checkedMode()).toBe("每天");
    expect(screen.getByTestId("schedule-plan-daily")).not.toBeNull();
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：0 2 * * *");
    radio("每周");
    expect(checkedMode()).toBe("每周");
    expect(screen.getByTestId("schedule-plan-days")).not.toBeNull();
    // 一天没勾：拼不出就明说，derived 行不许演一个假 cron
    expect(screen.getByTestId("schedule-plan-empty")).not.toBeNull();
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：（未拼出：星期一天没勾）");
    radio("自定义 cron");
    expect(checkedMode()).toBe("自定义 cron");
    expect((screen.getByTestId("schedule-field-cron") as HTMLInputElement).value).toBe("");
    // 自定义态的空框与每周态的没勾星期是两回事，derived 行得分别说清——
    // 演成空白等于在用户问「我到底会存什么」时装没看见。
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：（未填 cron）");
  });

  it("编辑落点：t2 `0 2 * * 1` → 每周态勾着周一；t6 `0 2 * * 1-5` → 自定义且 raw 逐字在输入框", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t2");
    expect(checkedMode()).toBe("每周");
    const dayInputs = [...screen.getByTestId("schedule-plan-days").querySelectorAll("input")];
    expect(dayInputs.map((i) => i.checked)).toEqual([false, true, false, false, false, false, false]); // 0=周日在前
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：0 2 * * 1");
    await openDrawer("schedule-view-t6");
    expect(checkedMode()).toBe("自定义 cron");
    expect((screen.getByTestId("schedule-field-cron") as HTMLInputElement).value).toBe("0 2 * * 1-5");
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：0 2 * * 1-5");
  });

  it("每周态拼串进 PATCH：勾周一/周三 + 09:30 → cron 逐字 `30 9 * * 1,3`", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1"); // 0 2 * * *（每天 02:00）
    radio("每周");
    toggleDay("周一");
    toggleDay("周三");
    await setClock("09", "30");
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：30 9 * * 1,3");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const c = calls.find((x) => x.method === "PATCH")!;
    expect((c.body as { cron: string }).cron).toBe("30 9 * * 1,3");
  });

  it("每天态改时刻进 PATCH 的 cron：23:59 → `59 23 * * *`", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1");
    await setClock("23", "59");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const c = calls.find((x) => x.method === "PATCH")!;
    expect((c.body as { cron: string }).cron).toBe("59 23 * * *");
  });

  it("切态不静默清 cron：t4 `*/15 * * * *` 切走再切回，raw 原样还在；停留在自定义保存发的仍是原文", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t4"); // */15 * * * *（落自定义）
    radio("每天");
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：0 2 * * *");
    radio("每周");
    toggleDay("周五");
    radio("自定义 cron");
    expect((screen.getByTestId("schedule-field-cron") as HTMLInputElement).value).toBe("*/15 * * * *");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const c = calls.find((x) => x.method === "PATCH")!;
    expect((c.body as { cron: string }).cron).toBe("*/15 * * * *");
  });

  it("每周态一天没勾：derived 明说未拼出，点保存不发 PATCH（也不发假 cron）", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t2"); // 每周 周一 02:00
    toggleDay("周一"); // 全部勾掉
    expect(screen.getByTestId("schedule-plan-empty")).not.toBeNull();
    fireEvent.click(screen.getByTestId("schedule-save"));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("主体列（名单里有才配叫名字，名单外截断 id）", () => {
  it("s1 → 「履约场景A」（与抽屉选场景共用同一份列表）；名单外 id 画前 8 位截断", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-subject-t1")).not.toBeNull());
    expect(screen.getByTestId("schedule-subject-t1").textContent).toContain("履约场景A");
    expect(screen.getByTestId("schedule-subject-t1").textContent).not.toContain("s1");
    const unknown = screen.getByTestId("schedule-subject-t2");
    expect(unknown.textContent).toContain("9f8e7d6c…"); // 截断 id，不是空白、不是编名
    expect(unknown.textContent).not.toContain(UNKNOWN_SUBJECT); // 全长 id 不在可见文本（走 title 悬浮）
  });

  it("场景列表全程只请求一次（页体拉，抽屉共用——没有第二份 fetch）", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-view-t1")).not.toBeNull());
    await openDrawer("schedule-view-t1");
    await openDrawer("schedule-view-t2");
    const n = calls.filter((c) => c.url.includes("/scenarios?")).length;
    expect(n).toBe(1);
  });
});

describe("保存 body 逐字段（= schemas.py TaskCreateIn/TaskUpdateIn，path 参数不进 body）", () => {
  it("新建：POST /schedule-tasks 的 body 字段名与 TaskCreateIn 完全一致", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("schedule-create"));
    await waitFor(() => expect(screen.getByTestId("schedule-field-name")).not.toBeNull());
    fireEvent.change(screen.getByTestId("schedule-field-name"), { target: { value: "夜间回归" } });
    // 新建默认「每天 02:00」= `0 2 * * *`（derived 行同屏可见），直接吃默认值
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：0 2 * * *");
    openSelectByTestId("schedule-field-subject_id"); // 场景下拉
    await clickOption("履约场景A");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/schedule-tasks") && c.method === "POST")).toBe(true));
    const c = calls.find((x) => x.url.endsWith("/schedule-tasks") && x.method === "POST")!;
    expect(c.body).toEqual({
      project_id: "p1", name: "夜间回归", subject_type: "scenario", subject_id: "s1",
      cron: "0 2 * * *", env_id: null, enabled: 1, notify_channel_ids: [],
    });
  });

  it("编辑：PATCH /schedule-tasks/{id} 的 body = TaskUpdateIn（task_id 走路径不进 body）", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1");
    // t1 的 `0 2 * * *` 反解落「每天 02:00」，将写入的串同屏展示
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：0 2 * * *");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const c = calls.find((x) => x.method === "PATCH")!;
    expect(c.url).toContain("/schedule-tasks/t1");
    expect(c.body).toEqual({
      project_id: "p1", name: "夜间回归", subject_type: "scenario", subject_id: "s1",
      cron: "0 2 * * *", env_id: null, enabled: 1, notify_channel_ids: ["c1"],
    });
  });
});

describe("cron 唯一裁判是后端（前端零校验，422 原话回显）", () => {
  it("保存被 422：crontab 原话逐字出现在红字里，且保存前没有任何前端拦截挡住请求", async () => {
    mockBackend({ createStatus: 422 });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("schedule-create"));
    await waitFor(() => expect(screen.getByTestId("schedule-field-name")).not.toBeNull());
    fireEvent.change(screen.getByTestId("schedule-field-name"), { target: { value: "坏排期" } });
    // 60 分——前端不拦：切到自定义原样输入，请求必须真的发出去，让后端说话
    radio("自定义 cron");
    fireEvent.change(screen.getByTestId("schedule-field-cron"), { target: { value: "60 2 * * *" } });
    openSelectByTestId("schedule-field-subject_id");
    await clickOption("履约场景A");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/schedule-tasks") && c.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("schedule-save-error-text")).not.toBeNull());
    expect(screen.getByTestId("schedule-save-error-text").textContent)
      .toContain("cron 非法：Bug in crontab: 6 is not in range (0 - 59)!");
  });

  it("预览：next-5 带的是当前草稿 cron（编辑旧任务改成新串后发新串，times 走 fmtTime）", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1"); // 已落库 cron 是 0 2 * * *（反解落每天 02:00）
    radio("自定义 cron"); // 切到自定义：raw 槽里是 t1 原串，改成新串
    expect((screen.getByTestId("schedule-field-cron") as HTMLInputElement).value).toBe("0 2 * * *");
    fireEvent.change(screen.getByTestId("schedule-field-cron"), { target: { value: "*/5 * * * *" } });
    fireEvent.click(screen.getByTestId("schedule-preview-btn"));
    await waitFor(() => expect(screen.getAllByTestId("schedule-preview-time").length).toBe(5));
    const c = calls.find((x) => x.url.includes("/schedule-tasks/next-5"))!;
    expect(c.method).toBe("POST");
    expect(c.body).toEqual({ project_id: "p1", cron: "*/5 * * * *" }); // 草稿值，不是 t1 的旧值
    // +08:00 ISO 串经 fmtTime 变上海日历
    expect(screen.getAllByTestId("schedule-preview-time")[0].textContent).toBe("2026-11-16 10:05:00");
  });

  it("预览：cron 为空 → 不发请求，给一句人话提示", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1");
    radio("自定义 cron");
    fireEvent.change(screen.getByTestId("schedule-field-cron"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("schedule-preview-btn"));
    await waitFor(() => expect(screen.getByTestId("schedule-preview-hint")).not.toBeNull());
    expect(calls.some((c) => c.url.includes("/next-5"))).toBe(false);
  });
});

describe("渠道候选（平台级 GET /notify-channels；失败降级不编名，诊断按状态码分句）", () => {
  it("403：多选框降级为只读提示，已挂 id 原样留形，页面不出现编造的渠道名", async () => {
    mockBackend({ channelsStatus: 403 });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1"); // t1 挂了 c1
    await waitFor(() => expect(screen.getByTestId("schedule-channels-fallback")).not.toBeNull());
    // 403 才配喊「权限」——这句是状态码专属诊断，不是所有失败的套话
    expect(screen.getByTestId("schedule-channels-fallback").textContent).toContain("无渠道读取权限");
    // id 原样（前端没有 c1→钉钉值班群 的映射，也不许有）
    expect(screen.getByTestId("schedule-channels-fallback").textContent).toContain("c1");
    expect(screen.getByTestId("schedule-channels-fallback").textContent).not.toContain("钉钉值班群");
    expect(screen.queryByTestId("schedule-field-channels")).toBeNull();
    // 请求确实不带 project_id（平台级口径）
    expect(calls.some((c) => c.url.includes("/notify-channels?size=200"))).toBe(true);
  });

  it("500：降级提示不许诊断成「权限」问题；后端原话进 description，已挂 id 照旧留形", async () => {
    mockBackend({ channelsStatus: 500 });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1"); // t1 挂了 c1
    await waitFor(() => expect(screen.getByTestId("schedule-channels-fallback")).not.toBeNull());
    const fb = screen.getByTestId("schedule-channels-fallback");
    // S3 的靶：500 被写成「无渠道读取权限」就是拿五种病开一张权限药方
    expect(fb.textContent).not.toContain("无渠道读取权限");
    expect(fb.textContent).toContain("渠道列表加载失败");
    expect(fb.textContent).toContain("渠道服务 500：数据库连接重置"); // 原话仍在 description
    expect(fb.textContent).toContain("c1"); // 已挂 id 原样保留（load-bearing，不许动）
    expect(screen.queryByTestId("schedule-field-channels")).toBeNull();
  });

  it("200：候选以后端给的 name 做 label、id 做 value（下拉里出现渠道名）", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1");
    // 渠道候选是另一只 GET（/notify-channels）：在飞时抽屉画的是「加载中…」的禁用 Select，
    // 那只带 testid 的节点要等回包才挂上（schedules.tsx:527-528 vs :542-544）。
    // 慢后端下这里先 findBy 再点开，否则点开的是不存在的把手。
    await screen.findByTestId("schedule-field-channels");
    openSelectByTestId("schedule-field-channels"); // 渠道多选
    // t1 已挂 c1：候选拉回来后，已挂 id 应被后端给的名称回显（有映射才配叫名字）
    await waitFor(() => expect(screen.getByText("钉钉值班群", { selector: ".ant-select-selection-item-content" })).not.toBeNull());
  });
});

// ── Ctrl+K ?q=<id> 直达高亮（落点从「只到页」升级成「标出那一条」）──────────────
// 形状照元素库（uiElements.tsx）：横幅点名 + 行高亮；行不在已加载集里就老实什么都不标。

describe("pickDeepLinkHit（?q=<id> 认行的纯判断，无 DOM）", () => {
  it("id 在已加载行里 → 认出该 id", () => {
    expect(pickDeepLinkHit(ROWS, "t2")).toBe("t2");
  });
  it("id 不在行里 / q 为空 / 行还没加载 → 一律 null（不编一行出来）", () => {
    expect(pickDeepLinkHit(ROWS, "t404")).toBeNull();
    expect(pickDeepLinkHit(ROWS, null)).toBeNull();
    expect(pickDeepLinkHit(ROWS, "")).toBeNull();
    expect(pickDeepLinkHit([], "t1")).toBeNull(); // 列表还没加载完
  });
});

describe("Ctrl+K 落点 ?q=<id> 高亮", () => {
  it("?q=t2：横幅点名「冒烟巡检」，且该行带 tp-row-hit 高亮", async () => {
    mockBackend();
    render(<MemoryRouter initialEntries={["/schedules?q=t2"]}><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-hit")).not.toBeNull());
    expect(screen.getByTestId("schedule-hit").textContent).toContain("冒烟巡检");
    // 行高亮挂在 <tr> 上：从行内控件往上找
    const tr = screen.getByTestId("schedule-enabled-t2").closest("tr")!;
    expect(tr.className).toContain("tp-row-hit");
    // 别的行不许跟着亮
    const other = screen.getByTestId("schedule-enabled-t1").closest("tr")!;
    expect(other.className).not.toContain("tp-row-hit");
  });

  it("?q 指向不在列表里的 id：横幅不出现、没有任何行高亮（老实不编）", async () => {
    mockBackend();
    render(<MemoryRouter initialEntries={["/schedules?q=t404"]}><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-view-t1")).not.toBeNull());
    expect(screen.queryByTestId("schedule-hit")).toBeNull();
    expect(document.querySelector(".tp-row-hit")).toBeNull();
  });
});

// ── 第十八轮补账：零引用把手（主体类型/环境/启停开关/计划切态陈旧值/预览出参/
//    启停筛选/刷新/加载失败）。D47-b 退役记录：「加载更多」用例随按钮一起删除——
//    本页已按设计去掉游标追加改页码模式（一页两把尺子的老账），D127 的 bug 类
//    （取数落地触发 effect 重跑）换皮成「点第 3 页恰好一条请求」继续钉。
//    断言全部落在 body JSON、URL 参数、请求次数
//    与渲染出的服务端回执上，不钉「testid 存在」这种点不动也绿的壳。──────────────

describe("主体类型控件（D226 两值：场景 / 测试计划，显示值与提交值同源）", () => {
  it("默认场景；切到测试计划后环境框消失、候选换 /plans、POST body subject_type=plan 且 env_id=null", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("schedule-create"));
    await waitFor(() => expect(screen.getByTestId("schedule-field-subject_type")).not.toBeNull());
    const root = screen.getByTestId("schedule-field-subject_type");
    expect(root.querySelector(".ant-select-selection-item")?.textContent).toBe("场景（scenario）");
    // 场景态：环境框在（任务级环境只属于场景）
    expect(screen.queryByTestId("schedule-field-env_id")).not.toBeNull();

    openSelectByTestId("schedule-field-subject_type");
    await clickOption("测试计划（plan）");
    await waitFor(() =>
      expect(root.querySelector(".ant-select-selection-item")?.textContent).toBe("测试计划（plan）"));
    // plan 不绑任务级环境：控件整块不渲染（不是灰着，是不存在）
    expect(screen.queryByTestId("schedule-field-env_id")).toBeNull();

    // 候选来自 /plans（页体拉一次那份）
    expect(calls.some((c) => c.url.includes("/plans?") && c.url.includes("project_id=p1"))).toBe(true);
    fireEvent.change(screen.getByTestId("schedule-field-name"), { target: { value: "夜间回归" } });
    openSelectByTestId("schedule-field-subject_id");
    await clickOption("夜间回归计划");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/schedule-tasks") && c.method === "POST")).toBe(true));
    const body = calls.find((c) => c.url.endsWith("/schedule-tasks") && c.method === "POST")!.body as Record<string, unknown>;
    expect(body.subject_type).toBe("plan");
    expect(body.subject_id).toBe("p9");
    expect(body.env_id).toBeNull(); // 切主体后旧环境不许带进 body
  });

  it("主体列按类型各查各的名单：plan 行显示计划名，不拿场景表去猜", async () => {
    mockBackend({ extraRows: [task("t11", { name: "计划任务", subject_type: "plan",
      subject_id: "p9" })] });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-subject-t11")).not.toBeNull());
    expect(screen.getByTestId("schedule-subject-t11").textContent).toContain("夜间回归计划");
    // 场景行不受影响
    expect(screen.getByTestId("schedule-subject-t1").textContent).toContain("履约场景A");
  });

  it("D229 计划报告：环境框消失、候选换 /plans、POST body subject_type=plan_report 且 env_id=null", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("schedule-create"));
    await waitFor(() => expect(screen.getByTestId("schedule-field-subject_type")).not.toBeNull());
    const root = screen.getByTestId("schedule-field-subject_type");

    openSelectByTestId("schedule-field-subject_type");
    await clickOption("计划报告（plan_report）");
    await waitFor(() =>
      expect(root.querySelector(".ant-select-selection-item")?.textContent).toBe("计划报告（plan_report）"));
    // 计划类主体不绑环境：控件整块不渲染
    expect(screen.queryByTestId("schedule-field-env_id")).toBeNull();
    // 候选来自 /plans（subject_id 也是 plan_id）
    expect(calls.some((c) => c.url.includes("/plans?") && c.url.includes("project_id=p1"))).toBe(true);

    fireEvent.change(screen.getByTestId("schedule-field-name"), { target: { value: "每晚报告" } });
    openSelectByTestId("schedule-field-subject_id");
    await clickOption("夜间回归计划");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/schedule-tasks") && c.method === "POST")).toBe(true));
    const body = calls.find((c) => c.url.endsWith("/schedule-tasks") && c.method === "POST")!.body as Record<string, unknown>;
    expect(body.subject_type).toBe("plan_report");
    expect(body.subject_id).toBe("p9");
    expect(body.env_id).toBeNull();
  });

  it("主体列：plan_report 行同样用 /plans 名单显示计划名", async () => {
    mockBackend({ extraRows: [task("t12", { name: "报告任务", subject_type: "plan_report",
      subject_id: "p9" })] });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-subject-t12")).not.toBeNull());
    expect(screen.getByTestId("schedule-subject-t12").textContent).toContain("夜间回归计划");
  });
});

// D229：plan_report 的回执没有 run（不产生执行），但**产生了一份报告**——
// 必须画「已生成报告 + 链接 + 计数 + 未推送原因」，不许演成「未产生执行，不会回结果」。
describe("最近结果：计划报告回执（D229）", () => {
  it("有 report_id：画已生成报告与计数，不画「未产生执行」", async () => {
    mockBackend({ extraRows: [task("t21", { name: "每晚报告", subject_type: "plan_report",
      subject_id: "p9",
      last_run: { ok: true, plan_id: "p9", report_id: "pr1", report_name: "夜间回归计划 报告",
        status: "not_started", total: 5, passed: 3, notified: false,
        reason: "未绑定通知渠道", fired_at: "2026-11-23T08:00:00+08:00" } })] });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-last-report")).not.toBeNull());
    const cell = screen.getByTestId("schedule-result-t21");
    expect(cell.textContent).toContain("已生成报告");
    expect(cell.textContent).toContain("夜间回归计划 报告");
    expect(cell.textContent).toContain("总数 5");
    expect(cell.textContent).toContain("通过 3");
    expect(cell.textContent).toContain("未推送：未绑定通知渠道");
    expect(cell.textContent).not.toContain("未产生执行");
    // 链接落到计划报告详情
    const link = screen.getByTestId("schedule-last-report").querySelector("a");
    expect(link?.getAttribute("href")).toBe("/plan-reports/pr1");
  });

  it("没有 report_id 的失败回执：画「本次未生成报告」，不冒用 run 的「未产生执行」", async () => {
    mockBackend({ extraRows: [task("t22", { name: "报告失败", subject_type: "plan_report",
      subject_id: "p9",
      last_run: { ok: false, reason: "计划不存在，未生成报告",
        fired_at: "2026-11-23T08:00:00+08:00" } })] });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-result-t22")).not.toBeNull());
    const cell = screen.getByTestId("schedule-result-t22");
    expect(cell.textContent).toContain("本次未生成报告");
    expect(cell.textContent).toContain("计划不存在，未生成报告");
    expect(cell.textContent).not.toContain("未产生执行");
  });
});

describe("环境字段（候选带 project_id、选中进 body、清空回 null）", () => {
  it("选「测试环境」→ POST body env_id=e1；/envs 候选请求带 project_id（项目级口径）", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("schedule-create"));
    await waitFor(() => expect(screen.getByTestId("schedule-field-env_id")).not.toBeNull());
    expect(calls.some((c) => c.url.includes("/envs?") && c.url.includes("project_id=p1"))).toBe(true);
    openSelectByTestId("schedule-field-env_id");
    await clickOption("测试环境");
    fireEvent.change(screen.getByTestId("schedule-field-name"), { target: { value: "带环境" } });
    openSelectByTestId("schedule-field-subject_id");
    await clickOption("履约场景A");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/schedule-tasks") && c.method === "POST")).toBe(true));
    const body = calls.find((c) => c.url.endsWith("/schedule-tasks") && c.method === "POST")!.body as Record<string, unknown>;
    expect(body.env_id).toBe("e1");
  });

  it("选了再清空（allowClear）→ PATCH body env_id 回到 null，回落到占位「不绑定环境」", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1"); // fixture env_id=null
    openSelectByTestId("schedule-field-env_id");
    await clickOption("测试环境");
    expect(screen.getByTestId("schedule-field-env_id").querySelector(".ant-select-selection-item")?.textContent)
      .toBe("测试环境");
    fireEvent.mouseDown(screen.getByTestId("schedule-field-env_id").querySelector(".ant-select-clear") as HTMLElement);
    expect(screen.getByTestId("schedule-field-env_id").querySelector(".ant-select-selection-item")).toBeNull();
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(body.env_id).toBeNull();
  });

  it("编辑已绑定环境的任务（TaskOut.env_id=\"e1\"）：抽屉环境框回填「测试环境」；不改任何东西直接保存 → PATCH body env_id 仍是 \"e1\"（不是 null——回填断了用户点保存就把绑定洗掉）", async () => {
    // 差集「fixture ↔ TaskOut schema」：后端 schemas.py:58 env_id: str | None 真回填，
    // 页面上却全是 env_id:null 的行——schedules.tsx:324 setEnvId(editing?.env_id) 这一支
    // 从没跑过。它坏了的样子恰是数据丢失形状：打开→（界面一切正常）→保存，绑定蒸发。
    mockBackend({ extraRows: [task("t10", { name: "绑着环境", env_id: "e1" })] });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t10");
    // 环境候选随抽屉拉（项目级 /envs 带 project_id，:751 那条钉过口径）：
    // 回填的「名」要有出处，e1 得经候选列表配出「测试环境」才算后端 id→前端 label 走通
    await waitFor(() => expect(calls.some((c) => c.url.includes("/envs?") && c.url.includes("project_id=p1"))).toBe(true));
    await waitFor(() => expect(
      screen.getByTestId("schedule-field-env_id").querySelector(".ant-select-selection-item")?.textContent,
    ).toBe("测试环境"));
    // 实质那一句：界面原样、零改动，点保存——PATCH body 必须把 e1 原样带回去
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const c = calls.find((x) => x.method === "PATCH")!;
    expect(c.url).toContain("/schedule-tasks/t10");
    expect((c.body as { env_id: unknown }).env_id).toBe("e1");
  });
});

// 计划三选的陈旧值双向钉：切态保留各槽原值（已有用例钉过 custom→回 custom），
// 这里钉反方向——**提交的是当前态拼出的串，上一个态的值一丝不许混进去**。
describe("计划切态不夹带陈旧值（weekly/custom 双向，断 PATCH body 的 cron）", () => {
  it("每周勾一二 + 09:30 后切回每天：PATCH cron=`30 9 * * *`，星期列表不残留", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1"); // 每天 02:00
    radio("每周");
    expect(screen.getByTestId("schedule-plan-weekly")).not.toBeNull();
    toggleDay("周一");
    toggleDay("周二");
    await setClock("09", "30");
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：30 9 * * 1,2");
    radio("每天");
    expect(screen.queryByTestId("schedule-plan-weekly")).toBeNull();
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：30 9 * * *");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(body.cron).toBe("30 9 * * *"); // 时刻跟着走（共用槽），星期列表必须蒸发
  });

  it("自定义 `*/15 * * * *` 切到每周勾周二：PATCH cron=`0 2 * * 2`，raw 串不残留", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t4"); // */15 * * * *（落自定义）
    radio("每周");
    toggleDay("周二");
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：0 2 * * 2");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(body.cron).toBe("0 2 * * 2");
    expect(String(body.cron)).not.toContain("15");
  });

  it("每周勾着的态切到自定义改串保存：PATCH cron=新敲的 raw，weekly 的 days 不夹带", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t2"); // `0 2 * * 1` → 每周态、周一勾着
    radio("自定义 cron");
    expect(screen.getByTestId("schedule-plan-custom")).not.toBeNull();
    fireEvent.change(screen.getByTestId("schedule-field-cron"), { target: { value: "7 7 * * *" } });
    expect(screen.getByTestId("schedule-plan-derived").textContent).toBe("将写入：7 7 * * *");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(body.cron).toBe("7 7 * * *"); // days=[1] 还躺在 state 里，但不许进 body
  });
});

describe("预览出参（schedule-preview-out：成功画 times，失败换错误且旧 times 不残留）", () => {
  it("成功→失败两拍同抽屉：先 5 行 fmtTime 回执，坏串再预览换成 crontab 原话、times 清空", async () => {
    mockBackend({ previewFailCron: "60 2 * * *" });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t1");
    fireEvent.click(screen.getByTestId("schedule-preview-btn"));
    await waitFor(() => expect(screen.getAllByTestId("schedule-preview-time").length).toBe(5));
    const out = screen.getByTestId("schedule-preview-out");
    expect(within(out).getAllByTestId("schedule-preview-time").map((n) => n.textContent))
      .toEqual(["2026-11-16 10:05:00", "2026-11-16 10:10:00", "2026-11-16 10:15:00",
        "2026-11-16 10:20:00", "2026-11-16 10:25:00"]); // mock 回执逐行 fmtTime（上海日历）
    radio("自定义 cron");
    fireEvent.change(screen.getByTestId("schedule-field-cron"), { target: { value: "60 2 * * *" } });
    fireEvent.click(screen.getByTestId("schedule-preview-btn"));
    await waitFor(() => expect(screen.getByTestId("schedule-preview-error")).not.toBeNull());
    expect(within(out).getByTestId("schedule-preview-error").textContent)
      .toContain("cron 非法：Bug in crontab: 6 is not in range (0 - 59)!"); // 422 原话逐字
    // 上一次的 times 不许赖在出参区冒充这次的结论
    expect(within(out).queryAllByTestId("schedule-preview-time").length).toBe(0);
  });
});

describe("启用开关（switch 与 body 的 1/0 整数双向一致）", () => {
  it("新建：默认开着；关掉再保存 → POST body enabled=0", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("schedule-create"));
    await waitFor(() => expect(screen.getByTestId("schedule-field-enabled")).not.toBeNull());
    expect((screen.getByTestId("schedule-field-enabled") as HTMLElement).className).toContain("ant-switch-checked");
    fireEvent.click(screen.getByTestId("schedule-field-enabled"));
    fireEvent.change(screen.getByTestId("schedule-field-name"), { target: { value: "先存不启" } });
    openSelectByTestId("schedule-field-subject_id");
    await clickOption("履约场景A");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/schedule-tasks") && c.method === "POST")).toBe(true));
    const body = calls.find((c) => c.url.endsWith("/schedule-tasks") && c.method === "POST")!.body as Record<string, unknown>;
    expect(body.enabled).toBe(0);
  });

  it("编辑 t2（enabled=0）：开关初始关着，打开保存 → PATCH body enabled=1", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openDrawer("schedule-view-t2");
    const sw = screen.getByTestId("schedule-field-enabled") as HTMLElement;
    expect(sw.className).not.toContain("ant-switch-checked"); // 初始态 = 行的 enabled
    fireEvent.click(sw);
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(body.enabled).toBe(1);
  });
});

describe("启停筛选 / 刷新 / 加载失败（列表把手钉请求，不钉壳）", () => {
  it("筛「只看停用」→ GET 带 enabled=0 且表里只剩 t2；清空 → GET 去掉参数并回全量", async () => {
    mockBackend({ filterByEnabled: true });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-view-t2")).not.toBeNull());
    const listGets = () => calls.filter((c) => c.method === "GET" && c.url.includes("/schedule-tasks?"));
    expect(listGets().at(-1)!.url).not.toContain("enabled=");
    openSelectByTestId("schedule-filter-enabled");
    await clickOption("只看停用");
    await waitFor(() => expect(listGets().at(-1)!.url).toContain("enabled=0"));
    // 上面那条 waitFor 只证明 enabled=0 这只请求**发出去了**；行的更替在回包里
    // （schedules.tsx:634）。慢后端下「t1 不在」这一句会在旧行还在屏上时就读掉——
    // 缺席断言同样要等内容落定，否则它就是条假绿。
    await waitFor(() => expect(screen.queryByTestId("schedule-view-t1")).toBeNull()); // 服务端过滤：停用只剩 t2
    expect(screen.getByTestId("schedule-view-t2")).not.toBeNull();
    fireEvent.mouseDown(screen.getByTestId("schedule-filter-enabled").querySelector(".ant-select-clear") as HTMLElement);
    await waitFor(() => expect(listGets().at(-1)!.url).not.toContain("enabled="));
    await waitFor(() => expect(screen.getByTestId("schedule-view-t1")).not.toBeNull());
    expect(listGets().length).toBe(3); // 初载 + 筛选 + 清空：每次改筛选真发一次新请求
  });

  it("刷新按钮 = 重发列表请求（第二次 GET 真的发生）", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-view-t1")).not.toBeNull());
    const n0 = calls.filter((c) => c.method === "GET" && c.url.includes("/schedule-tasks?")).length;
    fireEvent.click(screen.getByTestId("schedule-reload"));
    await waitFor(() => expect(
      calls.filter((c) => c.method === "GET" && c.url.includes("/schedule-tasks?")).length).toBe(n0 + 1));
  });

  it("首载 503：失败态上屏（message + 后端原话），行清零不演有数据的表", async () => {
    mockBackend({ listFailOnce: true });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-load-error")).not.toBeNull());
    expect(screen.getByTestId("schedule-load-error").textContent).toContain("定时任务列表加载失败");
    expect(screen.getByTestId("schedule-load-error").textContent).toContain("调度服务暂不可用：DB 连接超时");
    expect(screen.queryByTestId("schedule-view-t1")).toBeNull(); // 失败后不许留着（或假装）行
    expect(calls.some((c) => c.url.includes("/schedule-tasks?") && c.method === "GET")).toBe(true);
  });

  it("失败态这条错误条没有 ×：关掉它只能靠刷新成功（× = 消证按钮）", async () => {
    // 失败时 catch 里 setRows([])，表里零行，这条 Alert 是「这一屏没取到」的唯一证据。
    // 留着 closable 就等于给用户一个把证据关掉、只剩一张空表的机会——
    // 那张空表读起来和「这个项目没有定时任务」一模一样（同 notifyChannels.tsx:420）。
    mockBackend({ listFailOnce: true });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    const alert = await screen.findByTestId("schedule-load-error");
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull();
    fireEvent.click(alert); // 点它本体也不该消失（不是靠隐藏装掉）
    expect(screen.queryByTestId("schedule-load-error")).not.toBeNull();
    fireEvent.click(screen.getByTestId("schedule-reload"));
    await waitFor(() => expect(screen.queryByTestId("schedule-load-error")).toBeNull());
    // load() 一进去就同步清掉 loadError（schedules.tsx:627），所以上面这条「错误条没了」在
    // 请求刚发出时就成立；行要等回包（:634）。慢后端下这一句得等内容，不然读的是空表。
    await waitFor(() => expect(screen.getByTestId("schedule-view-t1")).not.toBeNull()); // 证据换成了真数据
  });

  it("失败后点刷新：错误条消失、行真的渲染出来（刷新是真恢复不是壳）", async () => {
    mockBackend({ listFailOnce: true });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-load-error")).not.toBeNull());
    fireEvent.click(screen.getByTestId("schedule-reload"));
    await waitFor(() => expect(screen.getByTestId("schedule-view-t1")).not.toBeNull());
    expect(screen.queryByTestId("schedule-load-error")).toBeNull();
  });

  it("刷新失败：已有行必须清零——失败态不许挂着一张旧表装没事", async () => {
    // 与上一条相反的方向：先让它成功拿到行，再让第二次 GET 挂。
    // `listFailOnce` 那种首屏就没行，删掉 catch 里的 setRows([]) 也判不出，
    // 所以「清零」这句话只有这个方向能证。
    mockBackend({ listFailAfterFirst: true });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await screen.findByTestId("schedule-view-t1");
    fireEvent.click(screen.getByTestId("schedule-reload"));
    await waitFor(() => expect(screen.getByTestId("schedule-load-error")).not.toBeNull());
    expect(screen.queryByTestId("schedule-view-t1")).toBeNull();
    expect(calls.filter((c) => c.url.includes("/schedule-tasks?") && c.method === "GET").length)
      .toBeGreaterThanOrEqual(2);
  });
});

// ── D47-b 页码分页（ListPager）：current / total 的线上形状 ──────────────────
// 「加载更多」三条游标用例随按钮按设计退场；这里钉页码制的每条口径。
// 两条反挂死护栏（reports.filters.test.tsx 同款，缺一就是一句 240s 超时让 CI 背锅）：
// ① resp() 每次深拷（在 mockBackend 里）——桩不许比真 fetch 更好说话；
// ② 挂载稳定后 /schedule-tasks? 恰好一条（renderSettled 绊线）——load 依赖里塞回
//    load 自己写的 state（D127 bug 类）时，这里当场「expected length 1 but got 22」。

/** 表内行 id（按行内「编辑」钮 testid 认行，比数 tr 稳）。 */
function shownTaskRows(): string[] {
  return Array.from(document.querySelectorAll("[data-testid^='schedule-view-']"))
    .map((n) => (n.getAttribute("data-testid") ?? "").replace("schedule-view-", ""));
}

function listReqs(): typeof calls {
  return calls.filter((c) => c.method === "GET" && c.url.includes("/schedule-tasks?"));
}

/** 渲染 + 等首屏行落地 + D127 绊线：300ms 观察窗后列表 GET 必须恰好一条。 */
async function renderSettled(entry = "/schedules"): Promise<void> {
  mockBackend();
  render(<MemoryRouter initialEntries={[entry]}><SchedulesPage /></MemoryRouter>);
  await waitFor(() => expect(shownTaskRows().length).toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 300));
  expect(listReqs()).toHaveLength(1);
}

/** 页码一律走 .ant-pagination-item-N 类选择器：AntD 在两汉字按钮里插空格，文本断言不可用。 */
function pager(): HTMLElement {
  return screen.getByTestId("list-pager");
}
function clickPage(n: number): void {
  fireEvent.click(pager().querySelector(`.ant-pagination-item-${n} a`) as Element);
}
/** 展开档位下拉并按数字前缀点其中一项（口径同 listPagination.test.tsx pickSize）。 */
async function pickPagerSize(prefix: string): Promise<void> {
  const sel = pager().querySelector(
    ".ant-pagination-options-size-changer .ant-select-selector",
  ) as HTMLElement;
  fireEvent.mouseDown(sel);
  const contents = ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content";
  await waitFor(() => expect(
    Array.from(document.querySelectorAll(contents))
      .some((n) => (n.textContent ?? "").startsWith(prefix))).toBe(true));
  const opt = Array.from(document.querySelectorAll(contents))
    .find((n) => (n.textContent ?? "").startsWith(prefix)) as Element;
  fireEvent.click(opt);
}
/** 等「比 before 更多的列表请求」落地，返回最后一条的 query。 */
async function lastListQuery(before: number): Promise<URLSearchParams> {
  await waitFor(() => expect(listReqs().length).toBeGreaterThan(before));
  const last = listReqs()[listReqs().length - 1];
  return new URLSearchParams(last.url.slice(last.url.indexOf("?") + 1));
}

/** 页码 fixture：3 页各两行、total=137（行数 2 ≠ 总数 137，total 冒充的变异在「共 N 条」处露馅）。 */
const PAGED = [
  { items: [ROWS[0], ROWS[1]], total: 137 },
  { items: [ROWS[2], ROWS[3]], total: 137 },
  { items: [ROWS[4], ROWS[5]], total: 137 },
];

describe("页码分页 ListPager（D47-b）：current / total 的线上形状", () => {
  it("响应 total=137 → 「共 137 条」；每条请求都带 current，任何一条都不带 cursor", async () => {
    calls.length = 0;
    mockBackend({ paged: PAGED });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(shownTaskRows()).toEqual(["t1", "t2"]));
    expect(pager().textContent).toContain("共 137 条");
    expect(listReqs().length).toBeGreaterThan(0); // 正对照：不是整块渲染了个寂寞
    // 起步 size=50：原固定 size 恰好是档位表里的 50，保持不动（注释在 schedules.tsx）
    for (const c of listReqs()) {
      const q = new URLSearchParams(c.url.slice(c.url.indexOf("?") + 1));
      expect(q.get("current")).toBe("1");
      expect(q.get("size")).toBe("50");
    }
    // 游标键在整页的任何一条请求上都不许出现（后端 current+cursor 同传必 400）
    expect(listReqs().some((c) => c.url.includes("cursor="))).toBe(false);
  });

  it("响应没有 total 键（后端游标式形状）→ 分页器整块不渲染，不挂假「共 0 条」", async () => {
    await renderSettled(); // 默认 RESP.page 无 total 键
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(shownTaskRows().length).toBeGreaterThan(0); // 正对照：行照渲染，只是分页器不撒谎
  });

  it("点第 3 页：恰好一条 current=3 请求（D127 换皮），行是替换不是追加", async () => {
    calls.length = 0;
    mockBackend({ paged: PAGED });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(shownTaskRows()).toEqual(["t1", "t2"]));
    const before = listReqs().length;
    clickPage(3);
    await waitFor(() => expect(listReqs().length).toBe(before + 1));
    const q = new URLSearchParams(listReqs().at(-1)!.url.slice(listReqs().at(-1)!.url.indexOf("?") + 1));
    expect(q.get("current")).toBe("3");
    expect(q.has("cursor")).toBe(false);
    // 替换语义：t1/t2 必须下桌（append 变异这里是 4 行、前页还挂着）
    await waitFor(() => expect(shownTaskRows()).toEqual(["t5", "t6"]));
    // 受控闭环：current 回写到 3，高亮跟过来
    expect(pager().querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
    // 迟到的重置请求也要抓到：替换落地后请求总数仍恰好 before+1
    expect(listReqs().length).toBe(before + 1);
  });

  it("停在第 3 页改启停筛选 → 下一条请求 current=1 且 enabled 在线", async () => {
    calls.length = 0;
    mockBackend({ paged: PAGED });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(shownTaskRows()).toEqual(["t1", "t2"]));
    const atPage3 = listReqs().length;
    clickPage(3);
    const landed = await lastListQuery(atPage3);
    expect(landed.get("current")).toBe("3"); // 正对照：确实停在第 3 页，reset 才有东西可回
    const before = listReqs().length;
    openSelectByTestId("schedule-filter-enabled");
    await clickOption("只看停用");
    const q = await lastListQuery(before);
    expect(q.get("current")).toBe("1"); // 改筛选后落回第 1 页
    expect(q.get("enabled")).toBe("0"); // 正对照：筛选参数与 current=1 同时在线，不是筛选没生效的假回页
    // 页码高亮同步回 1（受控回写，不只是请求里改了口）
    await waitFor(() => expect(
      pager().querySelector(".ant-pagination-item-1.ant-pagination-item-active")).toBeTruthy());
  });

  it("停在第 3 页点「刷新」→ 重发的是 current=3，不是回第 1 页", async () => {
    calls.length = 0;
    mockBackend({ paged: PAGED });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(shownTaskRows()).toEqual(["t1", "t2"]));
    const atPage3 = listReqs().length;
    clickPage(3);
    const landed = await lastListQuery(atPage3);
    expect(landed.get("current")).toBe("3"); // 正对照：刷新前先确实停在第 3 页
    const before = listReqs().length;
    fireEvent.click(screen.getByTestId("schedule-reload"));
    await waitFor(() => expect(listReqs().length).toBe(before + 1));
    const q = new URLSearchParams(listReqs().at(-1)!.url.slice(listReqs().at(-1)!.url.indexOf("?") + 1));
    expect(q.get("current")).toBe("3");
    // 刷新不许顺手把用户弹回第 1 页：页码高亮原地不动
    expect(pager().querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
  });

  it("停在第 3 页换 100/页 → 线上一条 size=100&current=1（换档位必回第 1 页，AntD 钳过的页码不上线）", async () => {
    // 137 条：50/页停第 3 页，换 100/页 AntD 会自己钳出 onChange(2, 100)——
    // 页面若把那个 2 转发上线（绕过 ListPager 的 onPage(1)），这条的红就在 current 上。
    calls.length = 0;
    mockBackend({ paged: PAGED });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(shownTaskRows()).toEqual(["t1", "t2"]));
    const atPage3 = listReqs().length;
    clickPage(3);
    const landed = await lastListQuery(atPage3);
    expect(landed.get("current")).toBe("3"); // 正对照：换档位前确实停在第 3 页
    const before = listReqs().length;
    await pickPagerSize("100");
    await waitFor(() => expect(listReqs().length).toBe(before + 1));
    const q = new URLSearchParams(listReqs().at(-1)!.url.slice(listReqs().at(-1)!.url.indexOf("?") + 1));
    expect(q.get("size")).toBe("100");
    expect(q.get("current")).toBe("1");
  });

  it("取数失败不留谎脚注：先「共 137 条」落地，刷新失败后分页器整块消失", async () => {
    calls.length = 0;
    // listFailAfterFirst 在 paged 分流之前判：首载成功，刷新这枪 503
    mockBackend({ paged: PAGED, listFailAfterFirst: true });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(pager().textContent).toContain("共 137 条"));
    fireEvent.click(screen.getByTestId("schedule-reload"));
    await waitFor(() => expect(screen.getByTestId("schedule-load-error")).not.toBeNull());
    // 空表上面不许挂着陈旧的「共 137 条」——total 必须随失败清空
    await waitFor(() => expect(shownTaskRows()).toEqual([]));
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(screen.queryByText("共 137 条")).toBeNull();
  });

  it("要找的行在第 3 页（不在当前页）→ 横幅不出现、不编一行：seenQ 的诚实口径在页码制依旧成立", async () => {
    // seenQ 认行的唯一证据是「当前页的行」。t5 真实存在、翻到第 3 页就能看到，
    // 但前端手里只有第 1 页的两行——横幅宁可不出现，也不许说「已定位/已标出」，
    // 也不许把高亮编到别的行上（pickDeepLinkHit 返回 null 的组件版钉）。
    calls.length = 0;
    mockBackend({ paged: PAGED });
    render(<MemoryRouter initialEntries={["/schedules?q=t5"]}><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(shownTaskRows()).toEqual(["t1", "t2"]));
    expect(screen.queryByTestId("schedule-hit")).toBeNull();
    expect(document.querySelector(".tp-row-hit")).toBeNull();
  });
});

// ── schedule-save-error（schedules.tsx:535）补账 ─────────────────────────────
// Alert 标题喊「后端拒绝（原话回显）」——这句话的可证伪形式：让后端回一段**独特到不可能
// 被前端硬编码**的 message，逐字节（toBe，不是 toContain）量它落到 EchoBlock（:536
// description={<EchoBlock text={saveErr}/>）里。前端若自己翻译一句（「保存失败」「cron
// 非法」之类），toBe 立刻红——既有那条 422 用例用 toContain 且消息来自共享 RESP，
// 「回显的是不是原话」其实没被逐字钉过。另一半：closable 是真关掉（setSaveErr(null)，
// schedules.tsx:537），成功保存则整个 Alert 不出现（{saveErr && …} 的假腿）。
// motion:false（ConfigProvider）只为让 closable 腿量得到「卸载不是隐藏」：jsdom 无
// transitionend，开着动效的 Alert leave-motion 永远挂起、DOM 摘不掉。

// 独特到不可能被硬编码的后端原话（含十六进制码 + 全角标点；前端翻译/硬编码必 red）
const BACKEND_RAW = "crontab 原话：分钟位必须在 0-59，你给了 60（段=minute，码 0x5f3759df）";

async function openCreateAndFailSave(): Promise<void> {
  fireEvent.click(screen.getByTestId("schedule-create"));
  await waitFor(() => expect(screen.getByTestId("schedule-field-name")).not.toBeNull());
  fireEvent.change(screen.getByTestId("schedule-field-name"), { target: { value: "坏排期" } });
  openSelectByTestId("schedule-field-subject_id");
  await clickOption("履约场景A");
  fireEvent.click(screen.getByTestId("schedule-save"));
  await waitFor(() => expect(
    calls.some((c) => c.method === "POST" && c.url.endsWith("/schedule-tasks"))).toBe(true));
}

describe("保存失败的回显与关闭（schedule-save-error）", () => {
  it("schedule-save-error：后端 422 的 message 逐字节进 Alert（原话回显不翻译），抽屉留着可改可重试", async () => {
    mockBackend({ createFailMessage: BACKEND_RAW });
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await openCreateAndFailSave(); // 前端零校验：非法输入照发 POST，后端说话
    const alert = await screen.findByTestId("schedule-save-error");
    expect(alert.className).toContain("ant-alert-error"); // type="error"：这是拒绝不是提示
    expect(alert.textContent).toContain("后端拒绝（原话回显）"); // 标题与行为对得上
    // 「原话」的严格量法：description 里的 <pre> 与响应体 message 逐字节相等——
    // 变异 description 的 text 换成静态译文 / catch 里 setSaveErr 换成写死句，都红。
    expect(screen.getByTestId("schedule-save-error-text").textContent).toBe(BACKEND_RAW);
    // 失败不许关抽屉（submit 只在成功路 onClose）：错了得能改完再点保存
    expect(screen.getByTestId("schedule-plan-mode")).not.toBeNull();
  });

  it("schedule-save-error：× 真把它关掉（DOM 消失不是隐藏）；关掉后再存成功，Alert 不再出现", async () => {
    mockBackend({ createFailMessage: BACKEND_RAW });
    render(<ConfigProvider theme={{ token: { motion: false } }}>
      <MemoryRouter><SchedulesPage /></MemoryRouter>
    </ConfigProvider>);
    await openCreateAndFailSave();
    const alert = await screen.findByTestId("schedule-save-error");
    const closeBtn = alert.querySelector(".ant-alert-close-icon");
    expect(closeBtn).not.toBeNull(); // closable 摘掉 → 这里 null（标题叫回显却关不掉也是谎）
    fireEvent.click(closeBtn as HTMLElement);
    // onClose={() => setSaveErr(null)}：节点整个从 DOM 摘掉（motion:false 下无挂起动画）
    await waitFor(() => expect(screen.queryByTestId("schedule-save-error")).toBeNull());
    // 反向腿：换回成功后端，同一路点击再保存 → 有成功、无拒绝 Alert
    mockBackend(); // calls 清零，第二腿的 POST 计数干净
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(
      calls.filter((c) => c.method === "POST" && c.url.endsWith("/schedule-tasks"))).toHaveLength(1));
    expect(screen.queryByTestId("schedule-save-error")).toBeNull();
  });
});

// ── D240：高级搜索 + 列设置（D47-a 三件套铺到定时任务页）─────────────────────
// 与 taskCenter.test.tsx 的 D239 同法：空条件整个参数不上线；应用条件后断**线上的
// filter JSON**（字段名来自后端 meta 第一项，前端不自列）；列设置只藏被勾掉的那一列。
describe("D240 高级搜索与列设置", () => {
  it("空条件不拼 filter；应用「任务名称包含 夜间」后列表请求带条件 JSON", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-view-t1")).not.toBeNull());
    expect(listReqs()[0].url).not.toContain("filter="); // 空条件整个参数不上线（不是 filter=）
    fireEvent.click(await screen.findByTestId("lt-search"));
    const panel = await screen.findByTestId("lt-panel");
    fireEvent.click(within(panel).getByTestId("lt-add-cond"));
    const cond = await within(panel).findByTestId("lt-cond-row");
    fireEvent.change(within(cond).getByTestId("lt-val-text"), { target: { value: "夜间" } });
    const before = listReqs().length; // 基线在点「应用」之前取：fetch 在桩里同步入队
    fireEvent.click(within(panel).getByTestId("lt-apply"));
    await waitFor(() => expect(listReqs().length).toBe(before + 1));
    const raw = new URLSearchParams(listReqs().at(-1)!.url.slice(listReqs().at(-1)!.url.indexOf("?") + 1))
      .get("filter");
    expect(JSON.parse(raw!)).toEqual({
      search_mode: "AND",
      conditions: [{ field: "name", operator: "CONTAINS", value: "夜间" }],
    });
  });

  it("列设置勾掉「调度」只藏那一列（其余表头原样，操作列不可隐藏）", async () => {
    mockBackend();
    render(<MemoryRouter><SchedulesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("schedule-view-t1")).not.toBeNull());
    const thead = () => document.querySelector(".ant-table-thead")?.textContent ?? "";
    expect(thead()).toContain("调度");
    fireEvent.click(await screen.findByTestId("lt-cols"));
    const panel = await screen.findByTestId("lt-col-panel");
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const labels = boxes.map((b) => (b.closest("label")?.textContent ?? "").trim());
    expect(labels).toEqual(["名称", "主体", "调度", "启用", "最近结果", "连续失败"]);
    fireEvent.click(boxes[labels.indexOf("调度")]);
    await waitFor(() => expect(thead()).not.toContain("调度"));
    expect(thead()).toContain("最近结果");
  });
});
