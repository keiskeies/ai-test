// 设备卡片墙（§11.4.14）的纯逻辑 + 组件测试（1D T9；D47-b 步5e 改页码 + state 下推）。
// 纯逻辑四件（cardStateOf/batteryBadge/queueBadgeLabel/agoLabel）是本页全部「数据→展示」
// 判断；组件测试钉取数形状（current/size/state 下推、占用随行、失败分腿）+ D17（排队徽标只显
// 真实人数、全页不出现「预计」）+ 权限位缺按钮就**不渲染**（不是 disabled）。fetch 全 mock，
// 同 workbench.test.tsx 手法。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";

// useNavigate 换成可断言的 spy（要抓第二个参数 state 对象，所以不能只靠 MemoryRouter）。
// 其余导出走真实现（ProjectGate 也用 useNavigate，不能整体断掉）。
const navSpy = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navSpy,
}));

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import AdbDevicesPage, {
  agoLabel, batteryBadge, cardStateOf, queueBadgeLabel, PILOT_DRAFT_MAX, pilotDraftFor,
} from "./adbDevices";
import { useAuth } from "../auth/store";
import type { AdbDeviceOut as Row, AdbDeviceRowOccupation } from "../api/adb";

const NOW = Date.parse("2026-11-16T10:00:00+08:00"); // 东八区上午 10 点（UTC 02:00）

// 组件里的「N前」用真 Date.now()（nowMs 初始化自 Date.now），所以喂给组件的时间戳
// 必须相对**真时钟**构造，不能钉死日历常量——否则过一天断言从「2m前」变「1d前」白红。
const RECENT_ISO = new Date(Date.now() - 2 * 60_000).toISOString();

function device(over: Partial<Row> = {}): Row {
  return {
    id: "d1", project_id: "p1", name: "Pixel6", serial: "192.168.1.20:5555",
    connect_type: "wifi", wifi_addr: "192.168.1.20", enabled: true,
    last_state: { model: "Pixel 6", os: "13", online: true, battery_level: 86,
      last_check_at: RECENT_ISO },
    owner_id: null, project_public: true, status: "normal", updated_by: null,
    created_at: null, updated_at: null, occupied_by: null,
    // D47-b 步5e：占用读数随行（默认 = 读到了、真空闲）。null/缺键 = 没读到 → 卡片画
    // 「占用未知」，缺省给「读到且空闲」才符合真实列表响应（无 state 腿正常时的形状）。
    occupation: { occupied: false, holder: null, queued: 0 }, ...over,
  };
}

function rowOcc(over: Partial<AdbDeviceRowOccupation> = {}): AdbDeviceRowOccupation {
  return { occupied: false, holder: null, queued: 0, ...over };
}

describe("cardStateOf（row + 随行占用读数 → 卡片状态；离线压倒占用，缺失 ≠ 空闲）", () => {
  it("在线且读到「无人持有」= 空闲", () => {
    expect(cardStateOf(device(), rowOcc())).toBe("idle");
  });
  it("在线且有持有者 = 占用（不管排没排队）", () => {
    expect(cardStateOf(device(), rowOcc({ occupied: true, holder: "run:r1:1:h", queued: 2 })))
      .toBe("occupied");
  });
  it("心跳说离线 = 离线，优先于占用读数", () => {
    const off = device({ last_state: { online: false, model: "Pixel 6", battery_level: 30 } });
    expect(cardStateOf(off, rowOcc({ occupied: true, holder: "run:r1:1:h" }))).toBe("offline");
  });
  it("从没测过（last_state 缺失/null）= 按离线灰，不装空闲", () => {
    expect(cardStateOf(device({ last_state: null }), null)).toBe("offline");
    expect(cardStateOf(device({ last_state: {} }), undefined)).toBe("offline");
  });
  it("在线但 occupation=null（批量读锁故障，整页同缺）= 「占用未知」，绝不塌缩成空闲", () => {
    // D47-b 步5e 业主裁决（§13 纪律 1）：旧兜底「缺失退化为在线=空闲」在逐台拉挂时只脏
    // 一张卡，换成随行批量读数后一次脏一整页——那条退化从此是成片的谎。
    expect(cardStateOf(device(), null)).toBe("unknown");
    expect(cardStateOf(device(), undefined)).toBe("unknown");
    // 离线压倒缺失：离线行同时缺读数仍画灰，不画「占用未知」
    const off = device({ last_state: { online: false } });
    expect(cardStateOf(off, null)).toBe("offline");
  });
});

describe("batteryBadge（电量徽标阈值）", () => {
  it("86% 绿（sketch 的「电86%」）", () => {
    expect(batteryBadge(86)).toEqual({ text: "电 86%", color: "green" });
  });
  it("20-50 橙，19 及以下红", () => {
    expect(batteryBadge(50).color).toBe("orange");
    expect(batteryBadge(20).color).toBe("orange");
    expect(batteryBadge(19).color).toBe("red");
    expect(batteryBadge(0).color).toBe("red");
  });
  it("取不到 = 「电量未知」，绝不画 0%（建连首帧没有电量）", () => {
    expect(batteryBadge(null)).toEqual({ text: "电量未知", color: "default" });
    expect(batteryBadge(undefined).text).toBe("电量未知");
    expect(batteryBadge(Number.NaN).text).toBe("电量未知");
  });
  it("越界值折回 0-100，小数四舍五入", () => {
    expect(batteryBadge(120).text).toBe("电 100%");
    expect(batteryBadge(-5).text).toBe("电 0%");
    expect(batteryBadge(85.6).text).toBe("电 86%");
  });
});

describe("queueBadgeLabel（D17：只显真实位次，不做估算）", () => {
  it("queued=2 → 「排队 #2」", () => {
    expect(queueBadgeLabel(2)).toBe("排队 #2");
    expect(queueBadgeLabel(1)).toBe("排队 #1");
  });
  it("没人排队 = 没有徽标（null），不是「排队 #0」", () => {
    expect(queueBadgeLabel(0)).toBeNull();
    expect(queueBadgeLabel(null)).toBeNull();
    expect(queueBadgeLabel(undefined)).toBeNull();
  });
});

describe("agoLabel（「最后心跳3m前」）", () => {
  it("两分钟前 = 2m前", () => {
    expect(agoLabel("2026-11-16T09:58:00+08:00", NOW)).toBe("2m前");
  });
  it("59 秒内 = 刚刚；59m 仍是分钟档，60m 进小时档", () => {
    expect(agoLabel(new Date(NOW - 59_000).toISOString(), NOW)).toBe("刚刚");
    expect(agoLabel(new Date(NOW - 59 * 60_000).toISOString(), NOW)).toBe("59m前");
    expect(agoLabel(new Date(NOW - 60 * 60_000).toISOString(), NOW)).toBe("1h前");
    expect(agoLabel(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe("3d前");
  });
  it("未来时刻不画负数（按刚刚）；缺失/非法 = null 由调用方画「尚无心跳」", () => {
    expect(agoLabel(new Date(NOW + 90_000).toISOString(), NOW)).toBe("刚刚");
    expect(agoLabel(null, NOW)).toBeNull();
    expect(agoLabel("昨天", NOW)).toBeNull();
  });
});

// ── 组件级（fetch mock 到 client 的 fetch 层）────────────────────────────────

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

const OCCUPIED = device({ id: "d2", name: "小米13", serial: "192.168.1.21:5555",
  occupation: rowOcc({ occupied: true, holder: "run:r9:1:host", queued: 2 }),
  last_state: { model: "小米 13", os: "14", online: true, battery_level: 40,
    last_check_at: "2026-11-16T09:59:00+08:00" } });
const OFFLINE = device({ id: "d3", name: "Nexus5", serial: "192.168.1.22:5555",
  last_state: { model: "Nexus 5", os: "8", online: false, battery_level: 12,
    last_check_at: "2026-11-16T09:57:00+08:00" } });

// ── 请求风暴刹车（罩住本文件全部 fetch 桩）──────────────────────────────────────
// 「挂载恰好一条列表请求」的绊线挡的是「取数落地把自己写的 state（rows/total）塞回 load
// 依赖」的无限回路。它的表现形式不是报红，是**整份文件挂死**（uiElements 步5d 实测：回路
// 每一跳都排在微任务里，act() 冲不干净，vitest 的用例超时自己也是宏任务、被同一条链饿死，
// 连绊线那一行都执行不到）→ 「跑不到」会被读成「守住了」。刹车两处形状照抄
// uiElements.test.tsx：① 超阈值不抛错（抛错 → catch → setRows([]) → 新数组 → 依赖又脏 →
// 回路自己续命），反复交出同一个冻结响应体让 React 按同一性跳过；② cap 不能高（25 时
// worker 已被冲崩，日志只剩 onUnexpectedExit，又没有汇总行）。包在 vi.fn **里面**：
// 包外面会把被刹掉的请求挡在 mock.calls 之外，绊线报出一个偏小的假数字。
const LIST_STORM_CAP = 10;
const STORM_BODY = Object.freeze({ items: Object.freeze([]), next_cursor: null, total: 0 });
function stormyFetch(inner: typeof fetch): typeof fetch {
  let listCalls = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/adb-devices\?/.test(String(input))) {
      listCalls += 1;
      if (listCalls > LIST_STORM_CAP) {
        return { ok: true, status: 200, json: async () => STORM_BODY } as unknown as Response;
      }
    }
    return inner(input, init);
  }) as unknown as typeof fetch;
}

/** 列表响应（页码模式：{items, next_cursor: null, total}）。total 缺省 = 行数。 */
function pageResp(items: Row[], over: { total?: number | null } = {}) {
  const body: Record<string, unknown> = { items, next_cursor: null };
  if (over.total !== null) body.total = over.total ?? items.length;
  return body;
}

/**
 * D47-b 步5e 的 fetch 桩：占用读数**随行**给出（不再有逐台 GET /occupation ——
 * 桩里不注册那个路由，若页面还在逐台拉它就会 throw「未 mock 的请求」，N+1 复活当场红）。
 * rows/recycledRows 按 URL 的 state / recycled 参数过滤后切片，报 total（筛完全集长度）。
 * 每次调用现拷一份全新响应体（JSON.parse(JSON.stringify)）——同引用反复交出会把无限回路
 * 吃成假绿（计划 §六 步 3b 的学费）。
 */
function mockBackend(items: Row[], opts: {
  recycledRows?: Row[]; total?: number | null; listStatus?: number; listBody?: unknown;
} = {}) {
  const listUrls: string[] = [];
  const resp = (json: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) }) as unknown as Response;
  global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/adb-devices\?/.test(url)) {
      listUrls.push(url);
      if (opts.listStatus) {
        return resp(opts.listBody ?? { code: "db_error", message: "设备库挂了", details: null },
          opts.listStatus);
      }
      const q = new URLSearchParams(url.split("?")[1]);
      const size = Number(q.get("size") ?? "20");
      const current = Number(q.get("current") ?? "1");
      const wantRecycled = q.get("recycled") === "true";
      const state = q.get("state");
      const pool = wantRecycled ? opts.recycledRows ?? [] : items;
      // 桩按后端三档谓词过滤（离线压倒占用；state 词表与后端逐字对齐）
      const hit = pool.filter((d) => {
        const online = d.last_state?.online === true;
        if (state === "offline") return !online;
        if (state === "occupied") return online && d.occupation?.occupied === true;
        if (state === "idle") return online && d.occupation != null && !d.occupation.occupied;
        return true;
      });
      const pageItems = hit.slice((current - 1) * size, (current - 1) * size + size);
      // total 原样透传：opts.total=undefined → 筛完全集长度 hit.length（**不是**切页后的
      // pageItems.length——那会把 25 条的 total 报成 20，第 2 页永远点不到）；
      // opts.total=null → pageResp 整个不给 total 键（游标式旧形状），不许折叠成数字。
      return resp(pageResp(pageItems, { total: opts.total === undefined ? hit.length : opts.total }));
    }
    throw new Error("未 mock 的请求: " + url);
  })) as unknown as typeof fetch;
  return { listUrls };
}
function lastListQ(h: { listUrls: string[] }): URLSearchParams {
  return new URLSearchParams(h.listUrls[h.listUrls.length - 1].split("?")[1]);
}
const cardCount = () => screen.queryAllByTestId(/^adb-device-card-/).length;
/** 页码一律走 .ant-pagination-item-N 类选择器（uiElements.test.tsx 同款：AntD 往两汉字
 *  按钮里插空格，文本断言不可用）。 */
function clickPage(n: number): void {
  fireEvent.click(screen.getByTestId("list-pager")
    .querySelector(`.ant-pagination-item-${n} a`) as Element);
}

beforeEach(() => {
  cleanup();
  navSpy.mockClear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("卡片墙渲染", () => {
  it("三张卡各按状态着色带；占用卡出「排队 #2」徽标且全页无「预计」字样（D17）", async () => {
    const h = mockBackend([device(), OCCUPIED, OFFLINE]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());

    const labels = ["d1", "d2", "d3"].map((id) =>
      screen.getByTestId("adb-device-card-" + id).querySelector('[data-testid="adb-device-state"]')!.textContent);
    expect(labels).toEqual(["空闲", "占用", "离线"]);

    // sketch 字段逐一点名：型号/系统/电量/WiFi 地址/最后心跳
    const c1 = screen.getByTestId("adb-device-card-d1");
    expect(c1.textContent).toContain("Pixel 6");
    expect(c1.textContent).toContain("Android 13");
    expect(c1.textContent).toContain("电 86%");
    expect(c1.textContent).toContain("192.168.1.20");
    expect(c1.textContent).toContain("最后心跳 2m前");

    // 占用卡：排队 #2（真实人数），且整页任何地方都不许出现「预计」
    expect(screen.getByTestId("adb-device-card-d2").textContent).toContain("排队 #2");
    expect(document.body.textContent).not.toContain("预计");
    // 离线卡是灰态：没有红色「异常」过滤器按钮（D18）
    expect(document.body.textContent).not.toContain("异常");

    // 无限回路绊线（全文件最早挂载列表的这条，uiElements 步5d 同法）：取数落地把自己写的
    // state 塞回 load 依赖 = 每跳微任务、整份文件挂死，绊线放后面每条用例都带着后台回路跑。
    await new Promise((r) => setTimeout(r, 300));
    expect(h.listUrls).toHaveLength(1);
  });

  it("占用读数随行：整页零次逐台 GET /occupation（D47-b 步5e 的 N+1 退场）", async () => {
    // 桩只注册列表路由：页面若还在按 r.items.map(...) 逐台 GET /occupation，fetch 会 throw
    // 「未 mock 的请求」并落到 loadError，这条在行渲染前就红。断言逐条扫 mock.calls 是
    // 第二把锁（throw 之后 fetch 桩仍记录了调用，能点名是哪台）。
    mockBackend([device(), OCCUPIED, OFFLINE]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d3")).not.toBeNull());
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]));
    expect(calls.filter((u) => /\/adb-devices\/[^/]+\/occupation/.test(u))).toHaveLength(0);
    expect(calls.filter((u) => /\/adb-devices\?/.test(u))).toHaveLength(1);
    // 三台的占用读数各归各：只有 d2 显示占用/排队，d1 空闲、d3 离线
    expect(screen.getByTestId("adb-device-card-d1")
      .querySelector('[data-testid="adb-device-state"]')!.textContent).toBe("空闲");
    expect(screen.queryAllByTestId("adb-device-queue")).toHaveLength(1);
  });

  it("只读成员（无 create/update/delete）：添加/重连/强制释放/删除按钮不渲染，测试连接仍在", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] } });
    mockBackend([device(), device({ ...OCCUPIED, occupation: rowOcc({ occupied: true, holder: "run:r9:1:host", queued: 1 }) })]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    // 隐藏不是禁用：节点根本不在 DOM 里
    expect(screen.queryByTestId("adb-device-add")).toBeNull();
    expect(screen.queryByTestId("adb-device-reconnect")).toBeNull();
    expect(screen.queryByTestId("adb-device-edit")).toBeNull(); // D121：编辑同走 :update，无权限不渲染
    expect(screen.queryByTestId("adb-device-force-release")).toBeNull();
    expect(screen.queryByTestId("adb-device-delete")).toBeNull();
    // /test 是 POST 但权限 adb:device:read——只读成员能测连接（读得到才算诚实）
    expect(screen.getAllByTestId("adb-device-test").length).toBe(2);
  });

  it("D159：MEMBER（持 update 无 manage）不渲染强制释放，重连仍在——门是 :manage 不是 :update", async () => {
    // 旧实现把强制释放挂在 canUpdate 上：MEMBER 的 ["*","-*:delete","-*:manage",…]
    // 顺手放行 → 与三处「管理员」承诺相违。新契约：按钮只跟 adb:device:manage 走。
    // 同页放一个 canUpdate 按钮（重连）做对照组：MEMBER 下它必须在，
    // 证明红/绿来自 :manage 这一位，而不是「整个 OPERATOR 面被错杀」。
    useAuth.setState({ project: { ...PROJECT, my_role: "MEMBER",
      my_perms: ["*", "-*:delete", "-*:manage", "-system:*"] } });
    mockBackend([device(), device({ ...OCCUPIED, occupation: rowOcc({ occupied: true, holder: "run:r9:1:host", queued: 1 }) })]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(
      screen.getByTestId("adb-device-card-d2").querySelector('[data-testid="adb-device-state"]')!.textContent,
    ).toBe("占用"));
    // §11.5.1 隐藏不是禁用：强制释放节点不在 DOM 里
    expect(screen.queryByTestId("adb-device-force-release")).toBeNull();
    // 对照组：update 位按钮照常（不是把 MEMBER 当成了只读）
    expect(screen.getAllByTestId("adb-device-reconnect").length).toBe(2);
    expect(screen.getByTestId("adb-device-add")).not.toBeNull();
  });

  it("D159：PROJECT_ADMIN（持 manage）强制释放仍在——翻案不是收权到只有系统管理员", async () => {
    useAuth.setState({ project: { ...PROJECT, my_role: "PROJECT_ADMIN",
      my_perms: ["*", "-system:*"] } });
    mockBackend([device(), device({ ...OCCUPIED, occupation: rowOcc({ occupied: true, holder: "run:r9:1:host", queued: 1 }) })]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(
      screen.getByTestId("adb-device-card-d2").querySelector('[data-testid="adb-device-state"]')!.textContent,
    ).toBe("占用"));
    expect(screen.getByTestId("adb-device-force-release")).not.toBeNull();
  });

  it("强制释放后占用读数刷新（M13：refreshOne 的 occupation 合并被摘掉就没人拦）", async () => {
    // 本文件 mockBackend 的桩**只注册列表路由**，getDevice/occupation 一律 throw——于是
    // 逐台刷新（重连/强制释放走 refreshOne）从来没被任何用例走到成功路径：
    // refreshOne 里那行 `{...row, occupation:{...}}` 摘掉、卡上的「占用」停在旧读数，
    // 全套还绿（变异实测 SURVIVED）。本例把这两条路由补上，把强制释放的收尾钉死：
    // force-release 成功 → 重新 GET 详情（详情**不带** occupation，后端 adb_device_get
    // 就是 `return _out(d)`，occupation 全靠列表腿填）→ GET /occupation 拿新锁读 →
    // 合并写回该行。卡片必须从「占用」变成「空闲」；「占用未知」（读没到）也要有。
    const occCall: AdbDeviceRowOccupation = { occupied: true, holder: "run:r9:1:host", queued: 0 };
    const afterRelease: AdbDeviceRowOccupation = { occupied: false, holder: null, queued: 0 };
    let occState: AdbDeviceRowOccupation = occCall;
    const detail = device({ id: "d2", name: "小米13",
      occupation: undefined, // 详情端不带 occupation（后端形状）
      last_state: { model: "小米 13", os: "14", online: true, battery_level: 40,
        last_check_at: RECENT_ISO } });
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && /\/adb-devices\?/.test(url)) {
        return { ok: true, status: 200, json: async () => pageResp([device({
          id: "d2", name: "小米13", occupation: occState,
          last_state: { model: "小米 13", os: "14", online: true, battery_level: 40,
            last_check_at: RECENT_ISO },
        })]) } as unknown as Response;
      }
      if (method === "GET" && /\/adb-devices\/d2\/occupation/.test(url)) {
        return { ok: true, status: 200, json: async () =>
          ({ device_id: "d2", ...occState }) } as unknown as Response;
      }
      if (method === "GET" && /\/adb-devices\/d2(?:\?|$)/.test(url)) {
        return { ok: true, status: 200, json: async () => detail } as unknown as Response;
      }
      if (method === "POST" && /\/adb-devices\/d2\/force-release/.test(url)) {
        occState = afterRelease; // 释放成功后，锁读立刻是空
        return { ok: true, status: 200, json: async () =>
          ({ ok: true, device_id: "d2", released_holder: "run:r9:1:host" }) } as unknown as Response;
      }
      throw new Error("未 mock 的请求: " + method + " " + url);
    })) as unknown as typeof fetch;
    useAuth.setState({ project: { ...PROJECT, my_role: "PROJECT_ADMIN", my_perms: ["*"] } });
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(
      screen.getByTestId("adb-device-card-d2").querySelector('[data-testid="adb-device-state"]')!.textContent,
    ).toBe("占用"));
    fireEvent.click(screen.getByTestId("adb-device-force-release"));
    // Modal.confirm 的确认钮（与 notifyChannels.test.tsx:631 同款：okButtonProps 的
    // data-testid 会被 cloneElement 吞掉，按容器内按钮文字找；antd 会在 CJK 字之间插空格，
    // 匹配时先剥光空白再比对）。赋值走「查得到才返回」的辅助，不用闭包变量
    // （闭包内赋值 TS 证明不了赋值发生过：TS2454）。
    const findOk = () => Array.from(document.querySelectorAll<HTMLElement>(".ant-modal-confirm-btns button"))
      .find((b) => (b.textContent ?? "").replace(/\s+/g, "") === "确认强制释放");
    await waitFor(() => expect(findOk()).toBeTruthy());
    fireEvent.click(findOk() as HTMLElement);
    // 收尾走 refreshOne：详情 + /occupation 两次 GET，卡从「占用」变「空闲」
    await waitFor(() => expect(
      screen.getByTestId("adb-device-card-d2").querySelector('[data-testid="adb-device-state"]')!.textContent,
    ).toBe("空闲"));
  });

  it("回收站两列（§11.4.18）：删除人显人名不显 id；正常视图不出现删除人行", async () => {
    // updated_by 是 UUID：正常卡片把它当「删除人」渲染是说谎（那是最后编辑人），
    // 所以删除人行只在 inRecycled 渲染（卡片里的守卫是这条钉的靶子）。
    const dead = device({ id: "d9", name: "被删的机器", status: "recycled", last_state: null,
      updated_by: "u-deleter-uuid", updated_by_name: "删设备的老李",
      updated_at: "2026-11-16T10:00:00+08:00" });
    const alive = device({ updated_by: "u-editor-uuid", updated_by_name: "还在编辑的老李",
      updated_at: "2026-11-16T09:00:00+08:00" });
    mockBackend([alive], { recycledRows: [dead] });
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    // 正常视图：删除人行不在 DOM，人名不许从任何地方露出
    expect(screen.queryByTestId("adb-device-recycler")).toBeNull();
    expect(document.body.textContent).not.toContain("删设备的老李");

    fireEvent.click(screen.getByTestId("adb-device-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-device-restore")).not.toBeNull());
    // 回收站视图：人名来自 updated_by_name，时间换算成东八区（fmtTime，§3.4-6）
    const recycler = screen.getByTestId("adb-device-recycler").textContent;
    expect(recycler).toContain("删设备的老李");
    expect(recycler).toContain("2026-11-16 10:00");
    // 查不到人 = 后端给 null → 画「—」，绝不把 updated_by 的 UUID 摊到界面上
    expect(document.body.textContent).not.toContain("u-deleter-uuid");
  });

  it("空库：诚实空态文案引导「添加会真的 adb connect 验证」，不画假网格", async () => {
    mockBackend([]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-empty")).not.toBeNull());
    expect(document.body.textContent).toContain("点「添加设备」输入 ip:port");
    expect(document.body.textContent).toContain("adb connect");
  });
});

// ── D84「让 Pilot 排查」：预填出口（nav + state.pilotDraft，零写库、不建会话）────
describe("让 Pilot 排查（预填草稿，D84 诚实切片）", () => {
  /** 点 d1 卡上的按钮，返回传给 navigate 的 (to, options)。 */
  async function clickAskPilot(cardId = "d1"): Promise<{ to: string; opts: { state: { pilotDraft: string } } }> {
    const btn = await waitFor(() => {
      const b = screen.getByTestId("adb-device-card-" + cardId)
        .querySelector('[data-testid="adb-device-ask-pilot"]') as HTMLElement | null;
      if (!b) throw new Error("ask-pilot 未渲染");
      if (b.textContent !== "让 Pilot 排查") throw new Error("按钮文案不对：" + b.textContent);
      return b;
    });
    fireEvent.click(btn);
    await waitFor(() => expect(navSpy).toHaveBeenCalled());
    const [to, opts] = navSpy.mock.calls[0] as [string, { state: { pilotDraft: string } }];
    return { to, opts };
  }

  it("设备卡上有「让 Pilot 排查」按钮", async () => {
    mockBackend([device()]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    expect(screen.getByTestId("adb-device-ask-pilot").textContent).toBe("让 Pilot 排查");
  });

  it("点击 → nav(/bench, {state:{pilotDraft}})，草稿含设备名与序列号", async () => {
    // 占用读数随行到货（同一次列表响应），没有旧「等逐台 /occupation 落地」的中间态了
    // （R31 那条等待连同逐台拉取一起退役——随行读数和行本体同一次 setState，同帧可见）。
    mockBackend([device()]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    const { to, opts } = await clickAskPilot();
    expect(to).toBe("/bench");
    const draft = opts.state.pilotDraft;
    expect(draft).toContain("Pixel6");
    expect(draft).toContain("192.168.1.20:5555");
    expect(draft).toContain("项目：履约"); // project.name，卡片数据之外本页真实持有
    expect(draft).toContain("- 卡片状态：空闲");
    expect(draft).toContain("- 电量：电 86%");
    expect(draft).toContain("- 占用：无人持有");
    expect(draft).toContain("最后心跳");
    expect(draft.length).toBeLessThanOrEqual(PILOT_DRAFT_MAX);
  });

  it("occupation=null 的卡草稿写「占用读数缺失」；有读数的卡不写（两端都实测）", async () => {
    // 批量读锁故障的形状：整行 occupation=null（后端把「没读到」逐行摊给清单腿）
    mockBackend([device({ occupation: null }),
      device({ ...OCCUPIED, occupation: rowOcc({ occupied: true, holder: "run:r9:1:host", queued: 1 }) })]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    // 先证 d2 的占用读数真的落卡（「占用」状态带），再点它——否则「不含缺失」可能只是时序巧合
    await waitFor(() => expect(
      screen.getByTestId("adb-device-card-d2").querySelector('[data-testid="adb-device-state"]')!.textContent,
    ).toBe("占用"));

    const missing = await clickAskPilot("d1");
    expect(missing.opts.state.pilotDraft).toContain("占用读数缺失");
    // 「卡片状态」行说「占用未知」——草稿不许替读数缺失的卡把状态写成空闲
    expect(missing.opts.state.pilotDraft).toContain("- 卡片状态：占用未知");

    navSpy.mockClear();
    const present = await clickAskPilot("d2");
    expect(present.opts.state.pilotDraft).not.toContain("占用读数缺失");
    expect(present.opts.state.pilotDraft).toContain("被 run:r9:1:host 持有");
    expect(present.opts.state.pilotDraft).toContain("- 排队：1 人");
  });

  it("新按钮不挂权限位（READONLY 也有），且没改动 test/force-release 的渲染条件", async () => {
    // 管理员：test / force-release（占用卡）/ ask-pilot 全在
    const occ1 = rowOcc({ occupied: true, holder: "run:r9:1:host" });
    mockBackend([device(), device({ ...OCCUPIED, occupation: occ1 })]);
    const { unmount } = render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(
      screen.getByTestId("adb-device-card-d2").querySelector('[data-testid="adb-device-state"]')!.textContent,
    ).toBe("占用"));
    expect(screen.getAllByTestId("adb-device-test").length).toBe(2);
    expect(screen.getByTestId("adb-device-force-release")).not.toBeNull();
    expect(screen.getAllByTestId("adb-device-ask-pilot").length).toBe(2);
    unmount();

    // 只读成员：test 仍在、force-release 仍不渲染（与改动前的既有断言同条件）、ask-pilot 不受权限影响
    useAuth.setState({ project: { ...PROJECT, my_role: "READONLY", my_perms: ["*:read", "-system:*"] } });
    mockBackend([device(), device({ ...OCCUPIED, occupation: occ1 })]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    await waitFor(() => expect(
      screen.getByTestId("adb-device-card-d2").querySelector('[data-testid="adb-device-state"]')!.textContent,
    ).toBe("占用"));
    expect(screen.getAllByTestId("adb-device-test").length).toBe(2);
    expect(screen.queryByTestId("adb-device-force-release")).toBeNull();
    expect(screen.getAllByTestId("adb-device-ask-pilot").length).toBe(2);
  });

  it("回收站视图没有这个出口（邻居「测试连接」在那里同样隐藏，保持同一诚实面）", async () => {
    const dead = device({ id: "d9", name: "被删的机器", status: "recycled", last_state: null });
    mockBackend([device()], { recycledRows: [dead] });
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    fireEvent.click(screen.getByTestId("adb-device-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-device-restore")).not.toBeNull());
    expect(screen.queryByTestId("adb-device-ask-pilot")).toBeNull();
    expect(screen.queryByTestId("adb-device-test")).toBeNull();
  });

  it("pilotDraftFor：缺失字段整行省略、超长截断到 20000", () => {
    const bare = device({ name: "裸机", last_state: null, wifi_addr: null });
    const d = pilotDraftFor(bare, null, { projectName: null, nowMs: Date.now() });
    expect(d).not.toContain("- 电量"); // last_state 缺失 → 不编电量
    expect(d).not.toContain("项目：");
    expect(d).toContain("占用读数缺失");
    expect(d).toContain("尚无心跳");
    const huge = device({ name: "x".repeat(PILOT_DRAFT_MAX * 2) });
    expect(pilotDraftFor(huge, rowOcc(), { projectName: "p", nowMs: Date.now() })
      .length).toBe(PILOT_DRAFT_MAX);
  });
});

// ── D47-b 步5e：state 三档下推 + 页码请求形状 ──────────────────────────────────
// 旧「脚注现攒共 N 台 / 游标 hedging」整组用例随游标世界退役（scenes/uiElements 同款先例），
// 「共 N 台」从此只有服务端 total 这一张嘴（ListPager「共 N 条」）。
describe("D47-b 步5e 取数形状：current/size 上线、state 下推、不带 cursor", () => {
  it("① 挂载恰好一条 current=1&size=20 的请求，不带 cursor 也不带 state", async () => {
    const h = mockBackend([device(), OCCUPIED, OFFLINE]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    expect(h.listUrls).toHaveLength(1);
    const q = lastListQ(h);
    expect(q.get("current")).toBe("1");
    expect(q.get("size")).toBe("20");
    expect(q.has("cursor")).toBe(false); // current+cursor 同传后端直接 400，永不同屏
    expect(q.has("state")).toBe(false); // 「全部」= 不带 state 参数（后端 None = 不过滤）
  });

  it("② 三档筛选各自的 state 词与后端逐字对齐，且都回第 1 页", async () => {
    // 变异靶：把 FILTER_TO_STATE 的词表打乱（空闲→occupied…）或筛选不发参数 → 本条红。
    // 词表是「三档各自的 total 相加 == 不带 state 的 total」这条后端总账的前端一半，
    // 词错了不报错，只是筛选与卡片各说一套——正是本刀要消灭的说谎。
    const rows = [device(), OCCUPIED, OFFLINE];
    const h = mockBackend(rows);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    const pick = (label: string) => {
      const seg = screen.getByTestId("adb-device-filter");
      const input = Array.from(seg.querySelectorAll("input")).find((el) =>
        (el.closest("label")?.textContent ?? "").includes(label)) as HTMLInputElement | undefined;
      if (!input) throw new Error("筛选条里没有「" + label + "」");
      fireEvent.click(input);
    };
    for (const [label, state] of [["空闲", "idle"], ["占用", "occupied"], ["离线", "offline"]] as const) {
      const before = h.listUrls.length;
      pick(label);
      await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
      const q = lastListQ(h);
      expect(q.get("state")).toBe(state);
      expect(q.get("current")).toBe("1"); // 筛选必须回第 1 页（patchFilters 唯一写入口）
      expect(q.has("cursor")).toBe(false);
    }
    // 桩按 state 过滤后墙上只剩对应档：循环结束时正停在「离线」，只剩 d3。
    // （Segmented 同值再点不触发 onChange，别再 pick 一次——pick 同项 = 空点。）
    await waitFor(() => expect(cardCount()).toBe(1));
    expect(screen.getByTestId("adb-device-card-d3")).not.toBeNull();
  });

  it("③ 点第 2 页恰好一条 current=2，行是替换不是追加", async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      device({ id: "d" + (i + 1), name: "机" + (i + 1) }));
    const h = mockBackend(rows);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 300));
    expect(h.listUrls).toHaveLength(1);
    clickPage(2);
    await waitFor(() => expect(h.listUrls).toHaveLength(2));
    expect(lastListQ(h).get("current")).toBe("2");
    await waitFor(() => expect(cardCount()).toBe(5));
    expect(screen.getByTestId("adb-device-card-d21")).not.toBeNull();
    expect(screen.queryByTestId("adb-device-card-d1")).toBeNull(); // 替换语义：第 1 页的行下桌
  });

  it("④ 停在第 3 页切回收站 → recycled=true 与 current=1 一起上线", async () => {
    // 变异靶：回收站钮改回 setInRecycled((v) => !v)（绕开 patchFilters）→ current 停在 3，
    // 回收集只有 1 行、第 3 页切片为空——「切回收站把数据切没了」，正向对照（d9 到货）同条钉住。
    const rows = Array.from({ length: 55 }, (_, i) => device({ id: "d" + (i + 1), name: "机" + (i + 1) }));
    const dead = device({ id: "d9", name: "被删的机器", status: "recycled", last_state: null });
    const h = mockBackend(rows, { recycledRows: [dead] });
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    clickPage(3);
    await waitFor(() => expect(lastListQ(h).get("current")).toBe("3"));
    fireEvent.click(screen.getByTestId("adb-device-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-device-restore")).not.toBeNull());
    const q = lastListQ(h);
    expect(q.get("recycled")).toBe("true");
    expect(q.get("current")).toBe("1"); // 唯一写入口的回页
  });

  it("④b 停在第 3 页选状态筛选 → state 与 current=1 一起上线（筛选钮不许绕开回页）", async () => {
    // ② 从第 1 页点筛选，current=1 恒成立——「筛选钮绕开 patchFilters」的变异在那是瞎的
    // （F9 同款教训：只在正向路径测 latch = 没测）。这条先真走到第 3 页再点「空闲」：
    // 绕开回页 = current 停在 3，45 台的 idle 档第 3 页只剩 5 行，点筛选后仍停 5 行且
    // current=3（断言双红）；正确实现回第 1 页 → 20 行。
    const rows = Array.from({ length: 45 }, (_, i) => device({ id: "d" + (i + 1), name: "机" + (i + 1) }));
    const h = mockBackend(rows);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    clickPage(3);
    await waitFor(() => expect(lastListQ(h).get("current")).toBe("3"));
    const seg = screen.getByTestId("adb-device-filter");
    const input = Array.from(seg.querySelectorAll("input")).find((el) =>
      (el.closest("label")?.textContent ?? "").includes("空闲")) as HTMLInputElement;
    fireEvent.click(input);
    await waitFor(() => expect(lastListQ(h).get("state")).toBe("idle"));
    expect(lastListQ(h).get("current")).toBe("1"); // 回页：确实从第 3 页被拍回第 1 页
    // 正向对照：25 台全在线无锁 → idle 档第 1 页有行（不是「筛选把数据筛没了」）
    await waitFor(() => expect(cardCount()).toBe(20));
  });

  it("停在第 3 页换档位到 50 → 恰好一条 size=50&current=1（ListPager 内部回页）", async () => {
    const rows = Array.from({ length: 65 }, (_, i) => device({ id: "d" + (i + 1), name: "机" + (i + 1) }));
    const h = mockBackend(rows);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    clickPage(3);
    await waitFor(() => expect(lastListQ(h).get("current")).toBe("3"));
    const before = h.listUrls.length;
    // 档位文案由 AntD locale 拼装（测试环境「50 / page」），只认数字前缀——照
    // shared/listPagination.test.tsx / uiElements.test.tsx 的 pickSize，别拼全文。
    const sizeChanger = screen.getByTestId("list-pager")
      .querySelector(".ant-pagination-options-size-changer .ant-select-selector") as HTMLElement;
    fireEvent.mouseDown(sizeChanger);
    const contents = ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content";
    await waitFor(() => expect(Array.from(document.querySelectorAll(contents))
      .some((n) => (n.textContent ?? "").startsWith("50"))).toBe(true));
    const opt = Array.from(document.querySelectorAll(contents))
      .find((n) => (n.textContent ?? "").startsWith("50")) as Element;
    fireEvent.click(opt);
    await waitFor(() => expect(h.listUrls.length).toBe(before + 1));
    const q = lastListQ(h);
    expect(q.get("size")).toBe("50");
    expect(q.get("current")).toBe("1"); // 换档位必回第 1 页（listPagination.tsx 注释③）
  });
});

// ── D47-b 步5e：「共 N 台」只有服务端 total 这一张嘴 + 失败清行清 total ─────────
describe("页脚 total 只认服务端；失败清行清 total、503/400 各说各话", () => {
  it("total=45 而行数 3：pager 说「共 45 台」的数，脚注不再现攒「共 3 台」", async () => {
    mockBackend([device(), OCCUPIED, OFFLINE], { total: 45 });
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    expect(screen.getByTestId("list-pager").textContent).toContain("共 45 条");
    expect(document.body.textContent).not.toContain("共 3 台"); // 行数不是总数（旧现攒腿已删）
    expect(document.body.textContent).not.toContain("后面还有没取的"); // 游标 hedging 退役
    expect(document.body.textContent).not.toContain("筛自"); // 「筛自 rows.length」也退役
  });

  it("响应没有 total 键 → pager 整块不渲染，不报假「共 0 条」", async () => {
    mockBackend([device()], { total: null });
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(document.body.textContent).not.toContain("共 0 条");
  });

  it("刷新失败清行清 total：无卡、pager 消失、脚注只说不作数（失败 ≠ 这一档没有设备）", async () => {
    // 可翻故障的桩：成功一轮再翻 fail。页码模式下失败必须清行清 total——陈旧卡/陈旧
    // 「共 N 条」+ 新 current 同屏就是「我在第几页」的两把尺子（uiElements 步5d 同款分歧）。
    let fail = false;
    const resp = (json: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(json)) }) as unknown as Response;
    global.fetch = vi.fn(stormyFetch(async () => {
      if (fail) return resp({ code: "db_error", message: "设备库挂了", details: null }, 500);
      return resp(pageResp([device(), OCCUPIED], { total: 45 }));
    })) as unknown as typeof fetch;
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    expect(screen.getByTestId("list-pager").textContent).toContain("共 45 条");
    fail = true;
    fireEvent.click(screen.getByTestId("adb-device-reload"));
    await screen.findByTestId("adb-device-load-error");
    expect(cardCount()).toBe(0);
    expect(screen.queryByTestId("list-pager")).toBeNull(); // 陈旧「共 45 条」不许挂在空墙上
    expect(document.body.textContent).not.toContain("共 45 条");
    expect(document.body.textContent).toContain("本次设备列表加载失败，本行计数不作数");
    expect(screen.queryByTestId("adb-device-empty")).toBeNull(); // 失败不许演成空态
  });

  it("503 lock_store_unavailable：说自己那腿的话 + 指路，不演空列表", async () => {
    // 后端占用/空闲腿：Redis 挂 → 整请求 503（列表根本给不出，与「这一档没有设备」是两回事）
    mockBackend([device()], { listStatus: 503, listBody: {
      code: "lock_store_unavailable",
      message: "设备锁读数不可用（Redis 故障），state=occupied/idle 无法给出可信的列表与 total；请去掉 state 先看设备清单，或稍后重试",
      details: { state: "occupied" } } });
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    const alert = await screen.findByTestId("adb-device-load-error");
    // 标题说占用腿的事（不许合并成一句「设备列表加载失败」）
    expect(alert.textContent).toContain("占用读数不可用，这一档列不出来");
    // 后端原话逐字回显（缩小范围/重试的出口写在其内）
    expect(screen.getByTestId("adb-echo-text").textContent).toContain("Redis 故障");
    // 前端指路：哪些档不受影响（真把手：筛选条上就摆着）
    expect(alert.textContent).toContain("「全部」「离线」");
    expect(alert.textContent).toContain("刷新");
    // 不演空列表：没有卡、没有 pager、没有空态
    expect(cardCount()).toBe(0);
    expect(screen.queryByTestId("list-pager")).toBeNull();
    expect(screen.queryByTestId("adb-device-empty")).toBeNull();
  });

  it("400 state_filter_too_broad：说自己那腿的话，后端缩小范围的出口摊开可见", async () => {
    mockBackend([device()], { listStatus: 400, listBody: {
      code: "state_filter_too_broad",
      message: "在线设备超过 2000 台：occupied/idle 需要整集读锁才报得出真 total，本次拒绝给一个只数了部分行的假「共 N 台」。"
        + "缩小范围：改用 state=offline 先排除离线的、切 recycled 视图、或按项目拆小。",
      details: { state: "occupied", cap: 2000 } } });
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    const alert = await screen.findByTestId("adb-device-load-error");
    expect(alert.textContent).toContain("占用/空闲这一档的筛选范围过大");
    expect(alert.textContent).not.toContain("设备列表加载失败"); // 不与通用失败共用一句话
    // 后端 message 原话直出：三个出口（offline / 回收站 / 按项目拆）一个不缩
    expect(screen.getByTestId("adb-echo-text").textContent)
      .toContain("改用 state=offline 先排除离线的、切 recycled 视图、或按项目拆小");
    expect(cardCount()).toBe(0);
    expect(screen.queryByTestId("adb-device-empty")).toBeNull();
  });
});

// 「占用未知」卡（在线 + occupation=null，批量读锁故障整页同缺）：业主裁决的仅显示态。
describe("占用读数缺失的卡：「占用未知」+ 缺失说明行，不进筛选条也不冒充空闲", () => {
  function missingCard(): HTMLElement {
    const el = screen.getByTestId("adb-device-card-d1");
    return el;
  }
  it("卡片状态词=「占用未知」，卡上有缺失说明行，且没有强制释放按钮", async () => {
    mockBackend([device({ occupation: null })]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    const card = missingCard();
    const stateTag = card.querySelector('[data-testid="adb-device-state"]')!;
    // 状态词精确 =「占用未知」——旧兜底「缺失退化为空闲」哪怕换了措辞也红（逐字比）
    expect(stateTag.textContent).toBe("占用未知");
    expect(screen.getByTestId("adb-device-occ-missing").textContent)
      .toContain("占用读数缺失（本次列表未随行返回占用读数，不能据此断定空闲/占用）");
    // 强制释放只在「读到占用」时给——读数缺失时按下它等于对一次读数失败做破坏性动作
    expect(card.querySelector('[data-testid="adb-device-force-release"]')).toBeNull();
    // 占用详情的入口也不在（标签不可点，没有 holder 可展示）
    expect(card.querySelector('[data-testid="adb-device-state"]')!.getAttribute("style") ?? "")
      .not.toContain("pointer");
  });
  it("「占用未知」不进筛选条：FILTERS 仍是全部/空闲/占用/离线四项（后端兑现不了就是假按钮）", async () => {
    mockBackend([device({ occupation: null })]);
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    const seg = screen.getByTestId("adb-device-filter");
    const opts = Array.from(seg.querySelectorAll(".ant-segmented-item-label")).map((n) => n.textContent);
    expect(opts).toEqual(["全部", "空闲", "占用", "离线"]);
  });
});

// ── D180（第二十四轮）：回收站模板跟「已到货的数据」（shownRecycled），行身份逐行认
// d.status。视图旗标在点击瞬间翻、行要等下一次 list() 落定才换——那截在途窗口（以及
// refetch 一直失败期间）按旗标挂回收模板，就是给活行套「删除人」+「彻底删除」。
// 竞态用手工 deferred 定格（不用 setTimeout：见 snapshot-vs-live 口径），四条各钉一面：
// 在途 / 取数 500 / 成功到货（正对照，独立于既有 :212 那条）/ 回收列表混入 status:normal。
// 别在本页找「空态那条腿」（其余五页各有 ⑤）：本页空态是 !loading && visible.length===0
// 的独立 Card（adbDevices.tsx:535），在途窗口里 loading=true → 根本没有空态节点可断言。
// 第三十四轮实测：空项目 + 回收站请求扣住不放行，屏上是「(无空卡)」；两个实现（读
// shownRecycled / 读 inRecycled）在这一格里输出逐字相同 → 那是等价变异，不是漏测。
// 生产侧同口径见 :544 注释（空态可见时 loading 已落，两旗标事实上等值）。
describe("D180 回收站模板跟数据：点击与取数之间不给活行套回收模板", () => {
  const alive = device({ id: "d1", updated_by: "u-editor-uuid",
    updated_by_name: "最后编辑的老李", updated_at: "2026-11-16T09:00:00+08:00" });
  const dead = device({ id: "d9", name: "被删的机器", status: "recycled", last_state: null,
    updated_by: "u-deleter-uuid", updated_by_name: "删设备的老李",
    updated_at: "2026-11-16T10:00:00+08:00" });
  const stray = device({ id: "d8", name: "混进来的活机",
    updated_by: "u-stray-uuid", updated_by_name: "混进来的编辑者",
    updated_at: "2026-11-16T09:30:00+08:00" });

  const okResp = (items: Row[]) => ({ ok: true, status: 200,
    json: async () => pageResp(items) }) as unknown as Response;

  /** 正常页恒回 [alive]；recycled=true 那一页按 mode：hold=手工 deferred / fail=500 / ok=直接给。 */
  function mockRecycledFetch(recycledItems: Row[], mode: "hold" | "fail" | "ok" = "ok") {
    let release: ((r: Response) => void) | null = null;
    let gets = 0;
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/adb-devices\?/.test(url)) {
        if (url.includes("recycled=true")) {
          gets += 1;
          if (mode === "fail") {
            return { ok: false, status: 500, json: async () => ({
              code: "db_error", message: "回收站取挂了", details: null }) } as unknown as Response;
          }
          return new Promise<Response>((r) => {
            if (mode === "hold") release = r;
            else r(okResp(recycledItems));
          });
        }
        return okResp([alive]);
      }
      throw new Error("未 mock 的请求: " + url);
    })) as unknown as typeof fetch;
    return { recycledGets: () => gets, release: () => release!(okResp(recycledItems)) };
  }

  it("点击回收站 + refetch 在途：活行保持正常模板，脚注不预告「回收站视图」", async () => {
    const ctl = mockRecycledFetch([dead], "hold");
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    fireEvent.click(screen.getByTestId("adb-device-recycled"));
    // deferred 门：回收站请求已发出且未 resolve——此刻页面上是「新旗标 + 旧数据」。
    await waitFor(() => expect(ctl.recycledGets()).toBe(1));
    expect(screen.queryByTestId("adb-device-recycler")).toBeNull();
    expect(screen.queryByTestId("adb-device-purge")).toBeNull();
    expect(screen.queryByTestId("adb-device-restore")).toBeNull();
    // 活行此刻画的就是正常操作（负断言不挂在永不渲染的分支里）
    const card = screen.getByTestId("adb-device-card-d1");
    expect(card.querySelector('[data-testid="adb-device-test"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="adb-device-purge"]')).toBeNull();
    // 活行自己的 updated_by_name（「删除人」位上它是指鹿为马）与回收站文案都不许出现
    expect(document.body.textContent).not.toContain("最后编辑的老李");
    expect(document.body.textContent).not.toContain("删除人");
    expect(document.body.textContent).not.toContain("回收站视图");
    // 放行：同一段查询此刻必须查得到——上面负断言的正对照
    ctl.release();
    await waitFor(() => expect(screen.getByTestId("adb-device-recycler")).not.toBeNull());
  });

  it("点击回收站 + refetch 500：清行照旧，但模板不跟着翻；脚注不预告「回收站视图」", async () => {
    mockRecycledFetch([dead], "fail");
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d1")).not.toBeNull());
    fireEvent.click(screen.getByTestId("adb-device-recycled"));
    const alert = await screen.findByTestId("adb-device-load-error");
    expect(alert.textContent).toContain("回收站取挂了");
    expect(screen.queryByTestId("adb-device-recycler")).toBeNull();
    expect(document.body.textContent).not.toContain("删除人");
    // shownRecycled 不跟失败的点击：脚注继续按旧数据说话
    expect(document.body.textContent).not.toContain("回收站视图");
    // 既有失败陈述原样保留：catch 清行 → 脚注不作数、空卡墙被 !loadError 挡住
    expect(document.body.textContent).toContain("本次设备列表加载失败，本行计数不作数");
    expect(screen.queryByTestId("adb-device-empty")).toBeNull();
  });

  it("成功切进回收站：删除人照旧出（人名不是 UUID）+ 删除时间走 fmtTime（正对照）", async () => {
    mockRecycledFetch([dead], "ok");
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await screen.findByTestId("adb-device-card-d1");
    fireEvent.click(screen.getByTestId("adb-device-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-device-restore")).not.toBeNull());
    const recycler = screen.getByTestId("adb-device-recycler").textContent!;
    expect(recycler).toContain("删设备的老李");
    expect(recycler).toContain("2026-11-16 10:00");
    expect(document.body.textContent).not.toContain("u-deleter-uuid");
    expect(document.body.textContent).toContain("回收站视图");
  });

  it("混数据：回收列表里 status:normal 的行没有删除人/彻底删除，真回收行两样都有", async () => {
    mockRecycledFetch([dead, stray], "ok");
    render(<MemoryRouter><AdbDevicesPage /></MemoryRouter>);
    await screen.findByTestId("adb-device-card-d1");
    fireEvent.click(screen.getByTestId("adb-device-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d8")).not.toBeNull());
    const deadCard = screen.getByTestId("adb-device-card-d9");
    const strayCard = screen.getByTestId("adb-device-card-d8");
    expect(deadCard.querySelector('[data-testid="adb-device-recycler"]')!.textContent)
      .toContain("删设备的老李");
    expect(deadCard.querySelector('[data-testid="adb-device-purge"]')).not.toBeNull();
    expect(deadCard.querySelector('[data-testid="adb-device-restore"]')).not.toBeNull();
    expect(strayCard.querySelector('[data-testid="adb-device-recycler"]')).toBeNull();
    expect(strayCard.querySelector('[data-testid="adb-device-purge"]')).toBeNull();
    expect(document.body.textContent).not.toContain("混进来的编辑者");
    // 正对照：活行按正常操作画（视图级文案仍跟到货的视图走，不受逐行闸影响）
    expect(strayCard.querySelector('[data-testid="adb-device-test"]')).not.toBeNull();
    expect(document.body.textContent).toContain("回收站视图");
  });
});

// ── D121（第四十六轮）：卡片「编辑」（蓝图 :1391）──────────────────────────────
// 此前按钮从未渲染、只有页头注释空头承诺。弹窗只开 PATCH 认的浅字段
// （device_services.py:218-234），提交按后端 None 语义只送改动过的字段；
// serial 只读 + 后端原话引用（:229-230）。手法抄 purge.test.tsx：fetch 层桩记录 calls、
// motion:false（destroyOnHidden 的关窗断言要能落）。
describe("D121 编辑弹窗：浅字段 PATCH 只送改动位，serial 只读", () => {
  interface Req { url: string; method: string; body?: string }
  const res = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
  const jso = (b: string | undefined) => JSON.parse(b ?? "{}") as Record<string, unknown>;

  function mockPatch(behavior: { ok?: boolean } = {}): Req[] {
    const calls: Req[] = [];
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
      if (method === "GET" && url.includes("/adb-devices?")) {
        return res(200, pageResp([device()]));
      }
      if (method === "PATCH" && /\/adb-devices\/d1$/.test(url)) {
        if (behavior.ok === false) {
          return res(409, { code: "conflict", message: "设备名在回收站占位，请先恢复",
            details: { name: "Pixel6" } });
        }
        return res(200, device());
      }
      // D47-b 步5e：逐台 GET /occupation 的路由**不注册**——列表加载若还在逐台拉占用，
      // 这里直接 throw → loadError → 卡不渲染，openEdit 等待先红（N+1 复活的兜底之二）。
      throw new Error("未 mock 的请求: " + method + " " + url);
    })) as unknown as typeof fetch;
    return calls;
  }
  const patches = (c: Req[]) => c.filter((x) => x.method === "PATCH");

  function renderAdmin() {
    return render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <MemoryRouter><AdbDevicesPage /></MemoryRouter>
      </ConfigProvider>,
    );
  }

  /** 点 d1 卡的「编辑」并等弹窗就位。 */
  async function openEdit(): Promise<void> {
    const card = await screen.findByTestId("adb-device-card-d1");
    const btn = card.querySelector('[data-testid="adb-device-edit"]') as HTMLElement;
    // antd 两字按钮自动空格成「编 辑」（CaseList.test.tsx 同款正则容忍）
    expect(btn.textContent).toMatch(/^编\s*辑$/);
    fireEvent.click(btn);
    await screen.findByTestId("adb-device-edit-ok");
  }

  /** 弹窗真的在屏上（destroyOnHidden + motion:false 下，关闭 = 节点整个从 DOM 消失）。 */
  function editModalVisible(): boolean {
    const wrap = screen.queryByTestId("adb-device-edit-ok")
      ?.closest(".ant-modal-wrap") as HTMLElement | undefined;
    return wrap != null && wrap.style.display !== "none";
  }

  it("弹窗预填当前值：name=本名、两个开关跟 enabled/project_public、串号只读带后端原话", async () => {
    mockPatch();
    renderAdmin();
    await openEdit();
    expect((screen.getByTestId("adb-device-edit-name") as HTMLInputElement).value).toBe("Pixel6");
    expect(screen.getByTestId("adb-device-edit-enabled").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("adb-device-edit-public").getAttribute("aria-checked")).toBe("true");
    // serial 只读：弹窗里唯一的文本输入框是 name；串号不出现在任何 input 的 value 里
    // （antd5 Switch 是 button[role=switch]，不产 input）
    const modal = screen.getByTestId("adb-device-edit-ok").closest(".ant-modal") as HTMLElement;
    const inputs = Array.from(modal.querySelectorAll("input"));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toBe(screen.getByTestId("adb-device-edit-name"));
    for (const el of inputs) expect(el.value).not.toContain("5555");
    // hint 行摊出串号 + 后端 422 的原话（debug_services 同款「原话引用」口径）
    const hint = screen.getByTestId("adb-device-edit-serial-hint").textContent!;
    expect(hint).toContain("192.168.1.20:5555");
    expect(hint).toContain("改 serial/connect_type 请用设备的「测试连接」端点完成重验，不直接 PATCH——连不上的对象不该静默入库");
  });

  it("只改名字：PATCH body 逐字 {project_id,name}，其余字段一个不带；成功后关窗并 load() 刷新", async () => {
    const calls = mockPatch();
    renderAdmin();
    await openEdit();
    fireEvent.change(screen.getByTestId("adb-device-edit-name"), { target: { value: "Pixel6 改" } });
    fireEvent.click(screen.getByTestId("adb-device-edit-ok"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].url).toBe("/api/v1/adb-devices/d1");
    // None 语义：没动的 enabled/project_public 不得出现在 body 里
    expect(jso(patches(calls)[0].body)).toEqual({ project_id: "p1", name: "Pixel6 改" });
    // 成功：toast + 关窗 + 列表重拉（list GET 第 2 次发出 = load()）
    await waitFor(() => expect(editModalVisible()).toBe(false));
    await waitFor(() => expect(calls.filter((x) => x.method === "GET"
      && x.url.includes("/adb-devices?")).length).toBeGreaterThanOrEqual(2));
  });

  it("只拨停用开关：body 逐字 {project_id,enabled:false}，name 原样未送", async () => {
    const calls = mockPatch();
    renderAdmin();
    await openEdit();
    fireEvent.click(screen.getByTestId("adb-device-edit-enabled"));
    fireEvent.click(screen.getByTestId("adb-device-edit-ok"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(jso(patches(calls)[0].body)).toEqual({ project_id: "p1", enabled: false });
  });

  it("一个字没改：不发 PATCH，直接关窗", async () => {
    const calls = mockPatch();
    renderAdmin();
    await openEdit();
    fireEvent.click(screen.getByTestId("adb-device-edit-ok"));
    await waitFor(() => expect(editModalVisible()).toBe(false));
    expect(patches(calls)).toHaveLength(0);
  });

  it("409 重名（回收站占位变体）：弹窗不关，toast 原话弹回，PATCH 只发过一次", async () => {
    const calls = mockPatch({ ok: false });
    renderAdmin();
    await openEdit();
    fireEvent.change(screen.getByTestId("adb-device-edit-name"), { target: { value: "Pixel6 改" } });
    fireEvent.click(screen.getByTestId("adb-device-edit-ok"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    // toast 原样带后端消息（client.ts:99 非 silent 必弹）
    await waitFor(() => expect(document.body.textContent).toContain("设备名在回收站占位，请先恢复"));
    expect(editModalVisible()).toBe(true);
  });

  it("回收卡没有「编辑」（只有恢复/彻底删除），且没有「测试连接」", async () => {
    const dead = device({ id: "d9", name: "被删的机器", status: "recycled", last_state: null });
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/adb-devices?")) {
        return { ok: true, status: 200, json: async () => pageResp(
          url.includes("recycled=true") ? [dead] : [device()]),
        } as unknown as Response;
      }
      throw new Error("未 mock 的请求: " + url);
    })) as unknown as typeof fetch;
    renderAdmin();
    await screen.findByTestId("adb-device-card-d1");
    // 活卡先立正对照：编辑在
    expect(screen.getByTestId("adb-device-card-d1")
      .querySelector('[data-testid="adb-device-edit"]')).not.toBeNull();
    fireEvent.click(screen.getByTestId("adb-device-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-device-card-d9")).not.toBeNull());
    const dc = screen.getByTestId("adb-device-card-d9");
    expect(dc.querySelector('[data-testid="adb-device-edit"]')).toBeNull();
    expect(dc.querySelector('[data-testid="adb-device-test"]')).toBeNull();
    expect(dc.querySelector('[data-testid="adb-device-restore"]')).not.toBeNull();
    expect(dc.querySelector('[data-testid="adb-device-purge"]')).not.toBeNull();
  });
});

// ── D125（第四十七轮）：软删/彻底删除文案不再引后端从不发的「默认设备未绑定」────
// 后端真话只有 debug_services.py:202-204 那一句，且只钉在「默认设备指向不可用设备」这一支；
// purge 勾选解绑走 debug_services.py:195-197（default_device=None → 任一空闲），不因这台设备报错
// ——但 :205-206 还有一句：项目零可用设备时「任一空闲」自己挑不出，文案两半都得说（钉在下面）。
describe("D125 删除文案：引后端原话，解绑说「任一空闲不报错」", () => {
  const SUFFIX = "不在本项目可用设备里（未登记 / 已停用 / 已回收）：这一步没有设备可跑";

  function renderAdmin() {
    return render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <MemoryRouter><AdbDevicesPage /></MemoryRouter>
      </ConfigProvider>,
    );
  }

  it("软删确认：含后端原话（按该卡 serial 代入 who+repr 前缀），旧假串「默认设备未绑定」绝迹", async () => {
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/adb-devices?")) {
        return { ok: true, status: 200, json: async () => pageResp([device()]) } as unknown as Response;
      }
      throw new Error("未 mock 的请求: " + url);
    })) as unknown as typeof fetch;
    renderAdmin();
    const card = await screen.findByTestId("adb-device-card-d1");
    fireEvent.click(card.querySelector('[data-testid="adb-device-delete"]') as HTMLElement);
    const box = await screen.findByText("把「Pixel6」放入回收站？",
      { selector: ".ant-modal-confirm-title" });
    const content = (box.closest(".ant-modal-confirm") as HTMLElement)
      .querySelector(".ant-modal-confirm-content")!.textContent!;
    expect(content).toContain(`默认设备 '192.168.1.20:5555' ${SUFFIX}`);
    expect(document.body.textContent).not.toContain("默认设备未绑定");
  });

  it("彻底删除「释放引用」说明：解绑后按「任一空闲」不报错；旧假串绝迹", async () => {
    const dead = device({ id: "d9", name: "被删的机器", status: "recycled", last_state: null });
    global.fetch = vi.fn(stormyFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/adb-devices?")) {
        return { ok: true, status: 200, json: async () => pageResp(
          url.includes("recycled=true") ? [dead] : [device()]) } as unknown as Response;
      }
      throw new Error("未 mock 的请求: " + url);
    })) as unknown as typeof fetch;
    renderAdmin();
    await screen.findByTestId("adb-device-card-d1");
    fireEvent.click(screen.getByTestId("adb-device-recycled"));
    await waitFor(() => expect(screen.getByTestId("adb-device-purge")).not.toBeNull());
    fireEvent.click(screen.getByTestId("adb-device-purge"));
    await screen.findByTestId("adb-device-purge-confirm");
    expect(document.body.textContent).toContain("解绑后那些用例执行时按「任一空闲」挑设备");
    // 后半个真话也要钉：debug_services.py:205-206——项目零可用设备时任一空闲自己也报错。
    // 不钉的话，下一轮「精简文案」会把这半句优化成一张新的空头支票。
    expect(document.body.textContent).toContain("「任一空闲」自己也挑不出");
    expect(document.body.textContent).not.toContain("默认设备未绑定");
  });
});
