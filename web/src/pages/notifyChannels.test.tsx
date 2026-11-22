// 通知渠道页（§11.4.26）纯逻辑 + 组件测试（1E 补记）。
// fetch 全 mock，同 workbench/adbDevices 手法。四条最要紧的钉：
// ① 列表渲染五类类型徽标；
// ② 密钥列显示的是**后端给的掩码原串**（含 `••••`、`[已配置]`、`****(无法解密)` 各一）——
//    前端截断就是假门，所以断言的是「原串逐字出现在页面上」；
// ③ D165 平台级门：非系统管理员整页诚实空态、列表 GET 不发（旧「READONLY 可点测试」
//    的钉已随假门一起撤——后端对非系统管理员连读都 403，那条行为本身就是假门样本）；
// ④ 「发送测试」点击真的打 POST /notify-channels/{id}/test 并回显成败与原话。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Modal, message } from "antd";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import NotifyChannelsPage, {
  buildConfig, CHANNEL_TYPES, missingRequired, pickDeepLinkHit, TYPE_META,
} from "./notifyChannels";
import { useAuth } from "../auth/store";
import type { components } from "../api/schema";

type Row = components["schemas"]["ChannelOut"];

function channel(id: string, type: string, over: Partial<Row> = {}): Row {
  return { id, name: "渠道" + id, type, config: {}, last_send: null,
    created_at: null, updated_at: null, ...over };
}

// 后端 mask_config 给的三种掩码形状（senders.py：前5位•••• / [已配置] / ****(无法解密)）
const MASK_TOKEN = "abcde••••";
const FIVE = [
  channel("c1", "WEBHOOK", { name: "通用钩子", config: { url: "https://h.example.com/x?token=%5B%E5%B7%B2%E9%85%8D%E7%BD%AE%5D" } }),
  channel("c2", "DINGTALK", { name: "钉钉群A", config: { access_token: MASK_TOKEN },
    last_send: { ok: true, latency_ms: 120, raw: "{\"errcode\":0}", checked_at: "2026-11-16T10:00:00+00:00" } }),
  channel("c3", "WECOM", { name: "企微值班群" }),
  channel("c4", "FEISHU", { name: "飞书发布群" }),
  channel("c5", "EMAIL", { name: "告警邮箱", config: { smtp_host: "smtp.example.com", password: "****(无法解密)" },
    last_send: { ok: false, latency_ms: 2094, error: "ConnectTimeout: timed out", checked_at: null } }),
];

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

const calls: { url: string; init?: RequestInit }[] = [];

/** 每次调用现拷一份：真 fetch 每次解析出一棵**全新的对象图**。桩若把同一个对象/数组反复
 *  交出，setRows(同一引用) 会被 React 按同一性直接跳过，「取数落地把 load 的依赖改脏 →
 *  effect 重跑 → 无限请求」这类回路在线上必现、在这种桩下永远测不出（reports.tsx 的 load
 *  依赖里一度真的多了 items；桩比真接口更好说话 = 把 bug 藏进桩里）。 */
function deepCopied(json: unknown): unknown {
  return JSON.parse(JSON.stringify(json)) as unknown;
}

function mockBackend(items: Row[]) {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/notify-channels?")) {
      return { ok: true, status: 200, json: async () => deepCopied({ items, next_cursor: null }) } as unknown as Response;
    }
    const m = url.match(/\/notify-channels\/([^/?]+)\/test$/);
    if (m) {
      return { ok: true, status: 200, json: async () => deepCopied({
        ok: false, latency_ms: 42, error: "HTTP 500", raw: "server said no", last_send: null,
      }) } as unknown as Response;
    }
    throw new Error("未 mock 的请求: " + url);
  }) as unknown as typeof fetch;
}

// ── 列表路由 mock（筛选/刷新/失败/页码断言共用）─────────────────────────────
// 按请求 URL 上的 (type, current) 分流，同一路由可给「按调用次序」的不同应答。
// D47-b：路由键的游标位换成页码位（键形 "type|current"，"|1" = 无筛选第 1 页）。
// 关键：每个路由返回的行集互不相同，且翻页页与首页零重叠——这样
// 「筛选方向反了」「翻页是追加不是替换」「刷新错回第 1 页」
// 都会把错误行集摆到屏幕上，而不是同 fixture 下的盲断言。
type ListResp = { items: Row[]; next_cursor?: string | null; total?: number | null } | { error: string };

function mockListRoutes(routes: Record<string, ListResp | ListResp[]>) {
  calls.length = 0;
  const seen: Record<string, number> = {};
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/notify-channels?")) {
      const qs = new URL(url, "http://t.test").searchParams;
      const key = (qs.get("type") ?? "") + "|" + (qs.get("current") ?? "");
      const r = routes[key];
      if (r === undefined) throw new Error("未 mock 的列表路由: " + url);
      const arr = Array.isArray(r) ? r : [r];
      const i = seen[key] ?? 0;
      seen[key] = i + 1;
      const page = arr[Math.min(i, arr.length - 1)];
      if ("error" in page) {
        return { ok: false, status: 503,
          json: async () => deepCopied({ code: "db_down", message: page.error }) } as unknown as Response;
      }
      return { ok: true, status: 200,
        json: async () => deepCopied({ items: page.items, next_cursor: null,
          ...("total" in page ? { total: page.total } : {}) }) } as unknown as Response;
    }
    throw new Error("未 mock 的请求: " + url);
  }) as unknown as typeof fetch;
}

// 当前表格行集（按配置列 testid 认行，比数 tr 稳）。
function shownRows(): string[] {
  return Array.from(document.querySelectorAll("[data-testid^='notify-channel-config-']"))
    .map((n) => (n.getAttribute("data-testid") ?? "").replace("notify-channel-config-", ""));
}

// 页头类型筛选（testid 挂外层 div，展开靠 .ant-select-selector 的 mousedown，同抽屉里那条手法）
async function pickFilter(label: string): Promise<void> {
  const sel = screen.getByTestId("notify-channel-filter").querySelector(".ant-select-selector")!;
  fireEvent.mouseDown(sel);
  fireEvent.click(await screen.findByText(label));
}

const PAGE1 = [channel("p1a", "WEBHOOK", { name: "第一页甲" }),
  channel("p1b", "DINGTALK", { name: "第一页乙" })];
const PAGE2 = [channel("p2c", "FEISHU", { name: "第二页丙" })];

beforeEach(() => {
  cleanup();
  // Modal.confirm 的静态弹窗挂在 body 独立 root 上，cleanup 拆不掉（EnvPanel/ModuleTree
  // 同款）：不清就会把上一条用例残留的「删除渠道？」二确撞进本条的查询里。
  Modal.destroyAll();
  document.querySelectorAll(".ant-modal-root").forEach((n) => n.remove());
  message.destroy();
  useAuth.setState({
    // D165 后本页只对系统管理员挂载页体：既有全量渲染用例统一以系统管理员身份跑
    // （= 正对照「管理员照旧」）；非管理员的空态/零请求由下方 D165 组专钉。
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: true, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("buildConfig（掩码原样送回 = 后端视为没改，D24 契约）", () => {
  const fields = [
    { key: "url", label: "URL", required: true },
    { key: "access_token", label: "token", secret: true },
  ];
  it("未动的键以打码回显为底原样送回，前端一个字符都不加工", () => {
    const stored = { url: "https://x/y?token=%5B%E5%B7%B2%E9%85%8D%E7%BD%AE%5D", access_token: MASK_TOKEN };
    const out = buildConfig(stored, fields, { url: stored.url, access_token: MASK_TOKEN });
    expect(out).toEqual(stored); // 逐字相等：这就是「PATCH 回显不许毁密钥」的前端半边
  });
  it("新值覆盖、清空的键删除", () => {
    const out = buildConfig({ access_token: MASK_TOKEN }, fields, { url: " https://new ", access_token: "  " });
    expect(out).toEqual({ url: "https://new" });
  });
});

describe("missingRequired（必填只在「表单空且库里也没有」时报）", () => {
  const fields = [{ key: "url", label: "URL", required: true }];
  it("表单空、库里没有 → 点名缺哪个", () => {
    expect(missingRequired(fields, { url: "  " }, {})).toEqual(["URL"]);
  });
  it("表单空但库里已有（含掩码回显）→ 不算缺", () => {
    expect(missingRequired(fields, {}, { url: "[已配置]" })).toEqual([]);
  });
});

describe("渠道列表", () => {
  it("五类徽标齐 + 密钥列显示后端掩码原串（前端不截断）+ 最近发送 ✓/✗", async () => {
    mockBackend(FIVE);
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("notify-channel-config-c2")).not.toBeNull());

    // D127 绊线（reports.filters.test.tsx renderAndSettle 同款）：挂载稳定后列表 GET
    // 必须恰好一条。放在**全文件最早挂载列表**的用例上——load 依赖里塞回它自己写的
    // state 时，回路在这里当场红一句 expected length 1 but got N；绊线若只在页码块里，
    // 回路会先把 worker 打死，全文件只剩一句 tinypool onUnexpectedExit，看不出谁的锅。
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((c) => c.url.includes("/notify-channels?"))).toHaveLength(1);

    // 五类徽标（中文标签 + 枚举原文）
    const tags = screen.getAllByTestId("notify-channel-type").map((n) => n.textContent);
    for (const t of CHANNEL_TYPES) {
      expect(tags.some((x) => x?.includes(TYPE_META[t].label) && x?.includes(t))).toBe(true);
    }

    // 后端给的掩码原串逐字上屏：•••• 是后端截的，前端只是显示
    expect(screen.getByTestId("notify-channel-config-c2").textContent).toContain(MASK_TOKEN);
    expect(screen.getByTestId("notify-channel-config-c5").textContent).toContain("****(无法解密)");
    // url query 段的 [已配置] 也在（后端 urlencode 过，前端解码回显不做——原样拼进 config 键值
    // 已由 mock 保证；这里断言 URL 串原样出现，不含明文 token）
    expect(screen.getByTestId("notify-channel-config-c1").textContent).toContain("https://h.example.com");

    // 最近发送：成功 ✓、失败 ✗ 各一枚，没发过的三行「从未发送」
    expect(screen.getAllByTestId("notify-last-send").length).toBe(2);
    expect(screen.getAllByText(/从未发送/).length).toBe(3);
  });

  it("点「发送测试」→ POST /notify-channels/{id}/test，弹窗回显失败与原话", async () => {
    mockBackend(FIVE);
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("notify-channel-test-c2")).not.toBeNull());
    fireEvent.click(screen.getByTestId("notify-channel-test-c2"));
    await waitFor(() => expect(screen.getByTestId("notify-test-result")).not.toBeNull());
    expect(calls.some((c) => c.url.endsWith("/notify-channels/c2/test") && c.init?.method === "POST")).toBe(true);
    expect(screen.getByTestId("notify-test-result").textContent).toContain("发送失败");
    expect(screen.getByTestId("notify-test-raw").textContent).toContain("server said no");
    // 「未改写」只保证内容，不保证长度：senders.py 的 RAW_CAP=500 先截过才回传，
    // 标题不加限定就是让用户拿截断片段当对端全文去比对。
    expect(screen.getByTestId("notify-test-result").textContent).toContain("可能不是全文");
  });

  // ── D165 平台级门（替换旧「READONLY 三钮隐藏」钉：那条钉的是假门行为本身——
  // 后端 build_ctx 对非系统管理员恒 {"auth:*"}，五端点全 403，READONLY 看得到
  // 「发送测试」钮点了也必 403。现在整页按 isSysAdmin && can 挂载，同 ModelTab 形状）。
  it("D165：PROJECT_ADMIN（非系统管理员）⇒ 三钮不在 DOM + 诚实空态在场 + 列表 GET 未发出", async () => {
    useAuth.setState({
      user: { id: "u2", account: "demo_pm", name: "项目管理员", email: null, is_system_admin: false, status: "active" },
      project: { ...PROJECT, my_role: "PROJECT_ADMIN", my_perms: ["*", "-system:*"] },
    });
    mockBackend(FIVE);
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    const alert = await screen.findByTestId("notify-channel-admin-only");
    expect(alert.textContent).toContain("仅系统管理员可管理");
    // 诚实空态不是错误脸：load-error 不许出现（发了必 403 的请求再报错 = 让用户看错误脸）
    expect(screen.queryByTestId("notify-channel-load-error")).toBeNull();
    // 三钮与整个页体不在 DOM（隐藏不是禁用；PROJECT_ADMIN 的 ["*","-system:*"] 盖得住
    // notify:channel:*，纯 can 画门在这里必假绿——m1 变异就退回纯 can）
    expect(screen.queryByTestId("notify-channel-create")).toBeNull();
    expect(screen.queryByTestId("notify-channel-edit-c2")).toBeNull();
    expect(screen.queryByTestId("notify-channel-remove-c2")).toBeNull();
    expect(screen.queryByTestId("notify-channel-reload")).toBeNull();
    expect(shownRows()).toEqual([]);
    // 列表 GET 未发出：数 fetch 调用，/notify-channels 一枪都不许有
    expect(calls.filter((c) => c.url.includes("/notify-channels")).length).toBe(0);
  });

  it("D165 正对照：系统管理员 ⇒ 照旧全量渲染（防「对谁都藏」的镜像假绿）", async () => {
    // beforeEach 即系统管理员；项目角色仍是 PROJECT_ADMIN——身份盖过项目词表
    mockBackend(FIVE);
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("notify-channel-config-c2")).not.toBeNull());
    expect(screen.getByTestId("notify-channel-create")).not.toBeNull();
    expect(screen.getByTestId("notify-channel-edit-c2")).not.toBeNull();
    expect(screen.getByTestId("notify-channel-remove-c2")).not.toBeNull();
    expect(screen.queryByTestId("notify-channel-admin-only")).toBeNull();
    // 列表 GET 照发（管理员这条路一切如旧）
    expect(calls.some((c) => c.url.includes("/notify-channels?"))).toBe(true);
  });

  it("新建抽屉：EMAIL 类型切出 SMTP 配置表单（键 = senders.py 真实消费的键）", async () => {
    mockBackend([]);
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("notify-channel-create")).not.toBeNull());
    fireEvent.click(screen.getByTestId("notify-channel-create"));
    fireEvent.change(screen.getByTestId("notify-field-name"), { target: { value: "告警邮箱" } });
    // 默认 WEBHOOK 只有 url 一个键
    expect(screen.getByTestId("notify-field-url")).not.toBeNull();
    // antd Select 的展开靠 .ant-select-selector 上的 mousedown（testid 挂在外层 div 上点不开）
    const selector = document.querySelector(".ant-drawer .ant-select-selector")!;
    fireEvent.mouseDown(selector);
    fireEvent.click(await screen.findByText("邮箱（EMAIL）"));
    await waitFor(() => expect(screen.getByTestId("notify-field-smtp_host")).not.toBeNull());
    expect(screen.getByTestId("notify-field-to_addr")).not.toBeNull();
    expect(screen.getByTestId("notify-field-password")).not.toBeNull();
    expect(screen.queryByTestId("notify-field-url")).toBeNull(); // 切类型后不残留别的类型的键
  });
});

// ── Ctrl+K ?q=<id> 直达高亮（落点从「只到页」升级成「标出那一条」）──────────────
// 形状照元素库（uiElements.tsx）：横幅点名 + 行高亮；行不在已加载集里就老实什么都不标。

describe("pickDeepLinkHit（?q=<id> 认行的纯判断，无 DOM）", () => {
  it("id 在已加载行里 → 认出该 id", () => {
    expect(pickDeepLinkHit(FIVE, "c3")).toBe("c3");
  });
  it("id 不在行里 / q 为空 / 行还没加载 → 一律 null（不编一行出来）", () => {
    expect(pickDeepLinkHit(FIVE, "c404")).toBeNull();
    expect(pickDeepLinkHit(FIVE, null)).toBeNull();
    expect(pickDeepLinkHit(FIVE, "")).toBeNull();
    expect(pickDeepLinkHit([], "c1")).toBeNull(); // 列表还没加载完
  });
});

describe("Ctrl+K 落点 ?q=<id> 高亮", () => {
  it("?q=c4：横幅点名「飞书发布群」，且该行带 tp-row-hit 高亮", async () => {
    mockBackend(FIVE);
    render(<MemoryRouter initialEntries={["/notify/channels?q=c4"]}><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("notify-channel-hit")).not.toBeNull());
    expect(screen.getByTestId("notify-channel-hit").textContent).toContain("飞书发布群");
    // 行高亮挂在 <tr> 上：从行内控件往上找
    const tr = screen.getByTestId("notify-channel-test-c4").closest("tr")!;
    expect(tr.className).toContain("tp-row-hit");
    // 别的行不许跟着亮
    const other = screen.getByTestId("notify-channel-test-c1").closest("tr")!;
    expect(other.className).not.toContain("tp-row-hit");
  });

  it("?q 指向不在列表里的 id：横幅不出现、没有任何行高亮（老实不编）", async () => {
    mockBackend(FIVE);
    render(<MemoryRouter initialEntries={["/notify/channels?q=c404"]}><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("notify-channel-test-c1")).not.toBeNull());
    expect(screen.queryByTestId("notify-channel-hit")).toBeNull();
    expect(document.querySelector(".tp-row-hit")).toBeNull();
  });
});

// ── 工具栏四把零引用 handles（audit axis ③）────────────────────────────────
// 每条都是行为断言：请求 URL 带对的参数 + 屏幕行集真的换/长/消失。
// fixture 按路由分流且互不相同（防「同一份 rows 应答所有 URL」的盲断言陷阱）。

describe("notify-channel-filter（类型筛选换的是服务端口径的行集）", () => {
  it("选「飞书」→ 请求带 type=FEISHU，行集从五类收窄到只剩 FEISHU 那一条", async () => {
    mockListRoutes({
      "|1": { items: FIVE }, // 无筛选：五类混合
      "FEISHU|1": { items: [channel("c4", "FEISHU", { name: "飞书发布群" })] },
    });
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toEqual(["c1", "c2", "c3", "c4", "c5"]));

    await pickFilter("飞书（FEISHU）");
    await waitFor(() => expect(shownRows()).toEqual(["c4"]));

    // 请求真的把类型带成了服务端参数（不是前端把五类都拉回来自己挑）
    expect(calls.some((c) => c.url.includes("/notify-channels?") && c.url.includes("type=FEISHU"))).toBe(true);
    // 没筛掉的其余四行从 DOM 消失，不是「还在但被隐藏」
    for (const gone of ["c1", "c2", "c3", "c5"]) {
      expect(screen.queryByTestId("notify-channel-config-" + gone)).toBeNull();
    }
    expect(screen.queryByText("通用钩子")).toBeNull();
    // 剩下这条的类型徽标就是所选枚举
    expect(screen.getByTestId("notify-channel-type").textContent).toContain("FEISHU");
  });

  it("再换「邮箱」→ 行集换成 EMAIL 那条（连续换筛选不残留上一类）", async () => {
    mockListRoutes({
      "|1": { items: FIVE },
      "FEISHU|1": { items: [channel("c4", "FEISHU", { name: "飞书发布群" })] },
      "EMAIL|1": { items: [channel("c5", "EMAIL", { name: "告警邮箱" })] },
    });
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toEqual(["c1", "c2", "c3", "c4", "c5"]));
    await pickFilter("飞书（FEISHU）");
    await waitFor(() => expect(shownRows()).toEqual(["c4"]));
    await pickFilter("邮箱（EMAIL）");
    await waitFor(() => expect(shownRows()).toEqual(["c5"]));
    expect(screen.queryByText("飞书发布群")).toBeNull();
  });
});

describe("notify-channel-reload（刷新 = 重发当前页且列表换成新 fixture）", () => {
  it("点刷新 → 再发一次列表请求，页面只剩新 fixture 的行（stale 行消失，不是 append）", async () => {
    // 同一 URL 两次应答必须给不同行集：同 fixture 下 append/replace 不可分辨
    mockListRoutes({
      "|1": [
        { items: PAGE1 }, // 首屏：第一页甲/乙
        { items: [channel("r9", "WECOM", { name: "刷新后才出现" })] }, // 刷新应答：全新行
      ],
    });
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toEqual(["p1a", "p1b"]));
    const before = calls.length;

    fireEvent.click(screen.getByTestId("notify-channel-reload"));
    await waitFor(() => expect(shownRows()).toEqual(["r9"]));

    // 真的又打了一次 GET（不是纯前端重绘）
    const listCalls = calls.filter((c) => c.url.includes("/notify-channels?"));
    expect(listCalls.length).toBe(before + 1);
    // 替换语义：旧两行不在 DOM——append 实现（D47-b 前的 setRows(prev=>[...prev,…])）这里会数出 3 行
    expect(screen.queryByTestId("notify-channel-config-p1a")).toBeNull();
    expect(screen.queryByText("第一页甲")).toBeNull();
    expect(screen.getByText("刷新后才出现")).not.toBeNull();
  });

  it("刷新失败：已有行必须清零——失败态不许挂着一张旧表装没事（NC09）", async () => {
    // 杀 NC09：catch 里的失败清行（D47-b 前是 if (reset) { setRows([]); setCursor(null); }，
    // 现在是 setRows([]) + setTotal(null)）被改成「保住旧表」时，既有测全绿——首载失败测
    // （load-error 那条）首屏就没有行，删 setRows([]) 也判不出；只有「先成功、刷新才挂」这个方向能证。
    // 形状照 schedules.test.tsx 同名契约。同一 URL 应答序列：先 200 给两行，再 503。
    mockListRoutes({
      "|1": [
        { items: PAGE1 }, // 首屏成功：p1a/p1b 上屏
        { error: "网关 503：刷新这枪没打通" }, // 刷新失败
      ],
    });
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toEqual(["p1a", "p1b"]));

    fireEvent.click(screen.getByTestId("notify-channel-reload"));
    // 错误条上屏（含后端原话）…
    const alert = await screen.findByTestId("notify-channel-load-error");
    expect(alert.textContent).toContain("网关 503：刷新这枪没打通");
    // …且旧行整张清零：保住 stale rows 的变异体在这里数出 ["p1a","p1b"] → 红
    await waitFor(() => expect(shownRows()).toEqual([]));
    expect(screen.queryByTestId("notify-channel-config-p1a")).toBeNull();
    expect(screen.queryByText("第一页甲")).toBeNull();
    // 刷新确实打了第二次列表 GET（不是前端自己把表擦了没请求）
    expect(calls.filter((c) => c.url.includes("/notify-channels?")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("notify-channel-load-error（列表请求挂了才有这条不可关的 Alert）", () => {
  it("列表 503 → Alert 出现且回显后端原话；没有 ×，关掉它的唯一通路是刷新成功", async () => {
    mockListRoutes({ "|1": [{ error: "网关 503：notify 库连不上" }, { items: FIVE }] });
    expect(screen.queryByTestId("notify-channel-load-error")).toBeNull(); // 渲染前就没有
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);

    const alert = await screen.findByTestId("notify-channel-load-error");
    expect(alert.textContent).toContain("渠道列表加载失败");
    expect(alert.textContent).toContain("网关 503：notify 库连不上"); // loadError 原话进 EchoBlock
    // 失败清空半边：reset 失败路径 setRows([])——表格不许残留任何行
    expect(shownRows()).toEqual([]);

    // 第二十三轮：× 摘掉了。失败时表里零行，这条 Alert 是「这一屏没取到」的唯一证据，
    // 给它一个关闭钮 = 发一个消证按钮：关掉后屏幕只剩一张空表，读起来就是「还没有渠道」。
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull();
    // 不许「关掉就没了」：连着点两下这块区域，节点必须在场（不是靠隐藏装掉）。
    fireEvent.click(alert);
    expect(screen.queryByTestId("notify-channel-load-error")).not.toBeNull();
    // 唯一的消失通路：刷新且成功。
    fireEvent.click(screen.getByTestId("notify-channel-reload"));
    await waitFor(() => expect(screen.queryByTestId("notify-channel-load-error")).toBeNull());
    // load() 一进去就同步清 loadError（notifyChannels.tsx:301-303），所以「Alert 没了」在请求
    // 刚发出时就成立；行随回包才来（:309）。不等内容的话这一句读到的是 0 行——
    // 「证据换成了真数据」这件事本身就还没发生。
    await waitFor(() => expect(shownRows().length).toBeGreaterThan(0)); // 证据换成了真数据，不是换成了空白
  });

  it("happy path：列表正常返回时该 Alert 不在 DOM（错误门只在 loadError 上）", async () => {
    mockListRoutes({ "|1": { items: FIVE } });
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toContain("c2"));
    expect(screen.queryByTestId("notify-channel-load-error")).toBeNull();
  });
});

describe("notify-channel-more 已退役（D47-b 页码分页 ListPager 接班）", () => {
  // 「加载更多」按设计不存在了（一页两把尺子的老账）；游标路由随 mock 键一起换成页码键。
  // 这里先钉「按钮不在」这条设计事实本身，再钉页码制的每条口径。
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
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/notify-channels?")).length).toBeGreaterThan(before));
    const all = calls.filter((c) => c.url.includes("/notify-channels?"));
    return new URL(all[all.length - 1].url, "http://t.test").searchParams;
  }
  // 页码 fixture：total=250、100/页 → 3 页；三页行集零重叠（替换/追加从 DOM 可分辨）。
  // 5 行总数与 250 对不上正是「total 只从响应来、不由行数现攒」的证明原料。
  const P1 = { items: PAGE1, total: 250 };
  const P2 = { items: PAGE2, total: 250 };
  const P3 = { items: [channel("p3d", "EMAIL", { name: "第三页丁" })], total: 250 };
  const PAGED3 = { "|1": P1, "|2": P2, "|3": P3 };

  it("按钮按设计不存在：有 next_cursor 形状的响应也不再画「加载更多」，改画分页器", async () => {
    // 起步 size=100：原固定 size=200 不在档位表（20/50/100）里，取最接近的 100——
    // 数值确实变小了，注释写在 notifyChannels.tsx（「共 N 条」把其余的说出来，不是数据消失）。
    mockListRoutes(PAGED3);
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toEqual(["p1a", "p1b"]));
    expect(screen.queryByTestId("notify-channel-more")).toBeNull();
    expect(pager().textContent).toContain("共 250 条");
    expect(calls.some((c) => c.url.includes("/notify-channels?") && c.url.includes("size=100"))).toBe(true);
    // 游标键在整页的任何一条请求上都不许出现（后端 current+cursor 同传必 400）
    expect(calls.every((c) => !c.url.includes("cursor="))).toBe(true);
  });

  it("响应没有 total 键（后端游标式形状）→ 分页器整块不渲染，不挂假「共 0 条」", async () => {
    mockBackend(FIVE); // {items, next_cursor} 无 total
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toContain("c2"));
    expect(screen.queryByTestId("list-pager")).toBeNull();
  });

  it("点第 3 页：恰好一条 current=3 请求（D127 换皮），行是替换不是追加，任何请求都不带 cursor", async () => {
    mockListRoutes(PAGED3);
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toEqual(["p1a", "p1b"]));
    const before = calls.length;
    clickPage(3);
    await waitFor(() => expect(shownRows()).toEqual(["p3d"]));
    // 替换语义：p1a/p1b 必须下桌（append 变异这里是 3 行、首页还挂着）
    expect(screen.queryByTestId("notify-channel-config-p1a")).toBeNull();
    await waitFor(() => expect(calls.length).toBe(before + 1)); // 迟到/多余请求都抓
    const q = new URL(calls[calls.length - 1].url, "http://t.test").searchParams;
    expect(q.get("current")).toBe("3");
    expect(q.has("cursor")).toBe(false);
    // 受控闭环：current 回写到 3，高亮跟过来
    expect(pager().querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
  });

  it("停在第 3 页改类型筛选 → 下一条请求 current=1 且 type 在线", async () => {
    mockListRoutes({ ...PAGED3, "FEISHU|1": { items: [channel("c4", "FEISHU", { name: "飞书发布群" })], total: 1 } });
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toEqual(["p1a", "p1b"]));
    const atPage3 = calls.length;
    clickPage(3);
    const landed = await lastListQuery(atPage3);
    expect(landed.get("current")).toBe("3"); // 正对照：确实停在第 3 页，reset 才有东西可回
    const before = calls.length;
    await pickFilter("飞书（FEISHU）");
    const q = await lastListQuery(before);
    expect(q.get("current")).toBe("1"); // 改筛选后落回第 1 页
    expect(q.get("type")).toBe("FEISHU"); // 正对照：筛选与回页同时在线，不是筛选没生效的假回页
    await waitFor(() => expect(shownRows()).toEqual(["c4"]));
    // 页码高亮同步回 1（受控回写，不只是请求里改了口）
    expect(pager().querySelector(".ant-pagination-item-1.ant-pagination-item-active")).toBeTruthy();
  });

  it("停在第 3 页点「刷新」→ 重发的是 current=3，不是回第 1 页", async () => {
    mockListRoutes(PAGED3);
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toEqual(["p1a", "p1b"]));
    const atPage3 = calls.length;
    clickPage(3);
    const landed = await lastListQuery(atPage3);
    expect(landed.get("current")).toBe("3"); // 正对照：刷新前先确实停在第 3 页
    const before = calls.length;
    fireEvent.click(screen.getByTestId("notify-channel-reload"));
    await waitFor(() => expect(calls.length).toBe(before + 1));
    const q = new URL(calls[calls.length - 1].url, "http://t.test").searchParams;
    expect(q.get("current")).toBe("3");
    // 刷新不许顺手把用户弹回第 1 页：页码高亮原地不动
    expect(pager().querySelector(".ant-pagination-item-3.ant-pagination-item-active")).toBeTruthy();
  });

  it("停在第 3 页换 20/页 → 线上一条 size=20&current=1（换档位必回第 1 页，AntD 钳过的页码不上线）", async () => {
    // 250 条：100/页停第 3 页，换 20/页 AntD 会自己钳出 onChange(13, 20) 之类——
    // 页面若把钳过的页码转发上线（绕过 ListPager 的 onPage(1)），这条的红就在 current 上。
    mockListRoutes(PAGED3);
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toEqual(["p1a", "p1b"]));
    const atPage3 = calls.length;
    clickPage(3);
    const landed = await lastListQuery(atPage3);
    expect(landed.get("current")).toBe("3"); // 正对照：换档位前确实停在第 3 页
    const before = calls.length;
    await pickPagerSize("20");
    await waitFor(() => expect(calls.length).toBe(before + 1));
    const q = new URL(calls[calls.length - 1].url, "http://t.test").searchParams;
    expect(q.get("size")).toBe("20");
    expect(q.get("current")).toBe("1");
  });

  it("取数失败不留谎脚注：先「共 250 条」落地，刷新失败后分页器整块消失", async () => {
    mockListRoutes({ "|1": [P1, { error: "网关 503：刷新这枪没打通" }] });
    render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(pager().textContent).toContain("共 250 条"));
    fireEvent.click(screen.getByTestId("notify-channel-reload"));
    await waitFor(() => expect(screen.getByTestId("notify-channel-load-error")).not.toBeNull());
    // 空表上面不许挂着陈旧的「共 250 条」——total 必须随失败清空
    await waitFor(() => expect(shownRows()).toEqual([]));
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(screen.queryByText("共 250 条")).toBeNull();
  });

  it("要找的行在第 3 页（不在当前页）→ 横幅不出现、不编一行：seenQ 的诚实口径在页码制依旧成立", async () => {
    // seenQ 认行的唯一证据是「当前页的行」。p2c 真实存在、翻到第 2 页就能看到，
    // 但前端手里只有第 1 页的两行——横幅宁可不出现，也不许说「已定位/已标出」，
    // 也不许把高亮编到别的行上（pickDeepLinkHit 返回 null 的组件版钉）。
    mockListRoutes(PAGED3);
    render(<MemoryRouter initialEntries={["/notify/channels?q=p2c"]}><NotifyChannelsPage /></MemoryRouter>);
    await waitFor(() => expect(shownRows()).toEqual(["p1a", "p1b"]));
    expect(screen.queryByTestId("notify-channel-hit")).toBeNull();
    expect(document.querySelector(".tp-row-hit")).toBeNull();
  });
});

// ── 删除 409 in_use 弹窗：截断必须说出口（第二十二轮修复 3）────────────────────
// 后端 service.py 的 count 是全量、tasks 被 REF_DETAIL_CAP（:35，SQL LIMIT :73）截过；
// details_hidden 只编码 schedule:read 权限、从不编码截断（:167）。所以「21+ 个引用只列 20 条」
// 时页脚必须自己数出来（details_truncated 缺席时按 count > tasks.length 自推），
// 否则用户看完 20 行以为找齐了，「先解绑再删」成了没法执行的话术。
// 注：details_truncated 是后端并行在补的字段——前端按可选处理，这里的 fixture 故意不带它，
// 自推腿先立住；带 true 的那条钉后端字段落地后话术依旧成立。

function inUseTasks(n: number): { task_id: string; name: string }[] {
  return Array.from({ length: n }, (_, i) => ({ task_id: "t" + i, name: "定时任务" + (i + 1) }));
}

function mockInUseDelete(details: Record<string, unknown>) {
  calls.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    if (url.includes("/notify-channels?")) {
      return { ok: true, status: 200, json: async () => deepCopied({ items: FIVE, next_cursor: null }) } as unknown as Response;
    }
    if (/\/notify-channels\/[^/]+\/delete$/.test(url)) {
      return { ok: false, status: 409, json: async () => ({
        code: "in_use", message: "该渠道被 " + String(details.count) + " 个定时任务引用，先解绑再删", details,
      }) } as unknown as Response;
    }
    throw new Error("未 mock 的请求: " + url);
  }) as unknown as typeof fetch;
}

/** 走完整删除流：行内 [删除] → Modal.confirm 二确 → 409 in_use 弹窗上屏（行 c3 企微值班群）。 */
async function openInUseModal(details: Record<string, unknown>) {
  mockInUseDelete(details);
  render(<MemoryRouter><NotifyChannelsPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByTestId("notify-channel-remove-c3")).not.toBeNull());
  fireEvent.click(screen.getByTestId("notify-channel-remove-c3"));
  await screen.findByText("删除渠道「企微值班群」？", { selector: ".ant-modal-confirm-title" });
  // okButtonProps 的 data-testid 会被 cloneElement 吞掉（datasets.test.tsx:224 同款口径）：
  // 从 confirm 自己的页脚按文本认「删 除」钮（两 CJK 字被 antd 空格化），
  // 表格里行内的同名「删 除」钮不在这个容器里。
  const okBtn = Array.from(document.querySelectorAll<HTMLElement>(".ant-modal-confirm-btns button"))
    .find((b) => /^删\s*除$/.test((b.textContent ?? "").trim()))!;
  fireEvent.click(okBtn);
  return screen.findByTestId("notify-inuse");
}

describe("删除 409 in_use：count 全量 vs 明细截断的诚实口径", () => {
  it("count 25 只列 20 条（legacy 无 details_truncated）→ 「仅列前 20 条，另有 5 个未列出」", async () => {
    const box = await openInUseModal({ channel_id: "c3", count: 25, tasks: inUseTasks(20), details_hidden: false });
    expect(box.querySelectorAll("[data-testid='notify-inuse-task']").length).toBe(20);
    expect(screen.getByTestId("notify-inuse-truncated").textContent)
      .toContain("仅列前 20 条，另有 5 个未列出");
    // 删除请求真的发过（拦截发生在 POST delete 之后，不是前端自己编的 409）
    expect(calls.some((c) => c.url.endsWith("/notify-channels/c3/delete"))).toBe(true);
  });

  it("count == 列出条数 → 注记不出现：全量就是全量时不编一句假截断", async () => {
    const box = await openInUseModal({ channel_id: "c3", count: 2, tasks: inUseTasks(2), details_hidden: false });
    expect(box.querySelectorAll("[data-testid='notify-inuse-task']").length).toBe(2);
    expect(screen.queryByTestId("notify-inuse-truncated")).toBeNull();
  });

  it("details_truncated=true（后端字段落地后）→ 同一句话依旧成立", async () => {
    await openInUseModal({ channel_id: "c3", count: 25, tasks: inUseTasks(20),
      details_hidden: false, details_truncated: true });
    expect(screen.getByTestId("notify-inuse-truncated").textContent).toContain("另有 5 个未列出");
  });

  it("details_truncated=true 但一条没少（count==列出数）→ 仍不出现注记：「另有 0 个」是假话", async () => {
    await openInUseModal({ channel_id: "c3", count: 2, tasks: inUseTasks(2),
      details_hidden: false, details_truncated: true });
    expect(screen.queryByTestId("notify-inuse-truncated")).toBeNull();
  });

  it("明细被权限隐瞒（details_hidden）→ 只报计数，count>0 行也不给「仅列前 N 条」注记", async () => {
    // D165 后页体只挂给系统管理员（perms 恒 ["*"]，maySeeSchedule 恒真）：隐瞒腿由
    // 后端 details_hidden=true 驱动——它才是真信号（后端按 schedule:read 判过再下发）。
    useAuth.setState({ project: { ...PROJECT, my_perms: ["notify:channel:*"] } });
    const box = await openInUseModal({ channel_id: "c3", count: 25, tasks: [], details_hidden: true });
    expect(box.textContent).toContain("25"); // 计数照报
    expect(box.textContent).toContain("schedule:read"); // 隐瞒要说出口
    expect(screen.queryAllByTestId("notify-inuse-task").length).toBe(0);
    // 0 行是权限隐瞒不是截断：说「仅列前 0 条」是另一种假话
    expect(screen.queryByTestId("notify-inuse-truncated")).toBeNull();
  });
});
