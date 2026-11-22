// adbDevices 卡片墙「破坏性流 + 原话回显」的组件层补测（测试债第十五轮：轴③ 零引用 testid）。
// 手法抄 adbDevices.test.tsx（fetch 层 mock / navSpy / matchMedia / useAuth.setState），
// purge 门禁写法同 ModuleTree.test.tsx:488 的既有先例。覆盖契约（file:line 均指 adbDevices.tsx）：
// ① 彻底删除逐字输名门禁（:464 → :562 gate → :574）：disabled 条件 `purgeName !== purge.name`
//    两侧都钉——空/错名/大小写差/首尾空格不放行，逐字相等才放行；POST /purge 的 URL 与
//    body（project_id/confirm_name/detach_referencing，adb.ts:111-113）只在放行后出现。
// ② 释放引用勾选（:577 → submitPurge :391）：勾选与否决定 body.detach_referencing 的 true/false。
// ③ 409 in_use 点名引用（:588/:595）：details.referring_cases 给 3 条 → 恰好 3 个
//    adb-purge-block-case，名字逐个对上，一条不藏。
// ④ adb 原话直出（:146 EchoBlock）：重连失败的 message（含「adb: device offline」行）
//    按字节进 <pre>，不翻译不改写。
// ⑤ 测试连接回执（:157/:169）：ok=false 无图；ok=true 带 screenshot_b64 → 恰一张 data: URI 图；
//    ok=true 无截图 → 「这次没截到图」且无 img。字段名以 schema.d.ts 的 AdbDeviceTestOut 为准。
// ⑥ 刷新（:505）：list GET 计数 +1 且 URL 逐字不变；加载失败（:516）：error Alert + 原话，可关。
// ⑦ 添加设备公开开关（:228 → submit :204-207）：默认开；关掉后 create body.project_public=false。
// ⑧ 名称标签（:418）：卡片显 name；名 ≠ 序列号时标签是名字不是序列号。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfigProvider } from "antd";
import { MemoryRouter } from "react-router-dom";

// useNavigate 换 spy（同 adbDevices.test.tsx:11）：其余导出走真实现，ProjectGate 要用。
const navSpy = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navSpy,
}));

// antd 响应式观察器要 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import AdbDevicesPage from "./adbDevices";
import { useAuth } from "../auth/store";
import type { AdbDeviceOut as Row } from "../api/adb";
import type { components } from "../api/schema";

type Occupation = components["schemas"]["AdbDeviceOccupationOut"];

// 相对**真时钟**构造（同 adbDevices.test.tsx:40 的教训）：钉死日历常量过一天就白红。
const RECENT_ISO = new Date(Date.now() - 2 * 60_000).toISOString();

function device(over: Partial<Row> = {}): Row {
  return {
    id: "d1", project_id: "p1", name: "Pixel6", serial: "192.168.1.20:5555",
    connect_type: "wifi", wifi_addr: "192.168.1.20", enabled: true,
    last_state: { model: "Pixel 6", os: "13", online: true, battery_level: 86,
      last_check_at: RECENT_ISO },
    owner_id: null, project_public: true, status: "normal", updated_by: null,
    created_at: null, updated_at: null, occupied_by: null,
    // D47-b 步5e：占用读数随行——缺省 = 「读到且空闲」（在线卡的正常形状）。
    // 不给这个默认的话在线卡会画「占用未知」（occupation 缺键 = 没读到），不是本文件的靶子。
    occupation: { occupied: false, holder: null, queued: 0 }, ...over,
  };
}

/** 回收站行：名字与序列号不同（门禁比的是 name，:562），彻底删除/恢复按钮只在这出现。 */
function dead(over: Partial<Row> = {}): Row {
  return device({ id: "d9", name: "Pixel6", serial: "192.168.9.99:5555",
    status: "recycled", last_state: null, ...over });
}

const PROJECT = { id: "p1", name: "履约", description: null, status: "normal",
  my_role: "PROJECT_ADMIN", my_perms: ["*"] };

// ── fetch 层桩（client.ts:77 前缀 /api/v1；409 信封 {code,message,details} 在 client.ts:96-102
//    变成 ApiErr.code/.message/.details，adbDevices.tsx:396 就按 e.code === "in_use" 分流）──
interface Req { url: string; method: string; body?: string }
type Resp = { status: number; body: unknown };
const res = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
// seqAt 交出去必须是 **Response 形状**：直接给 {status, body} 时 client.ts:91 的
// `await res.json()` 会 TypeError → body 落 null、`res.ok` 是 undefined 走错误分支，
// 最后抛的 ApiErr 变成兜底的「请求失败」/`http_undefined`——409 的 in_use 分流就此失效，
// 测试会红得像是产品的问题。
const seqAt = (s: Resp[], i: number) => {
  const r = s[Math.min(i, s.length - 1)];
  return res(r.status, r.body);
};
const jso = (b: string | undefined) => JSON.parse(b ?? "{}") as Record<string, unknown>;

interface BackendOpts {
  items?: Row[];
  recycled?: Row[];
  occ?: Record<string, Partial<Occupation>>;
  listResp?: Resp[];
  testResp?: Resp[];
  reconnectResp?: Resp[];
  purgeResp?: Resp[];
  recycledResp?: Resp[];
  createResp?: Resp[];
}
function mockBackend(over: BackendOpts = {}): Req[] {
  const calls: Req[] = [];
  const n = { list: 0, recycled: 0, test: 0, reconnect: 0, purge: 0, create: 0 };
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    if (method === "GET" && url.includes("/adb-devices?")) {
      if (url.includes("recycled=true")) {
        return over.recycledResp ? seqAt(over.recycledResp, n.recycled++)
          : res(200, { items: over.recycled ?? [], next_cursor: null });
      }
      return over.listResp ? seqAt(over.listResp, n.list++)
        : res(200, { items: over.items ?? [], next_cursor: null });
    }
    const occ = url.match(/\/adb-devices\/([^/?]+)\/occupation/);
    if (method === "GET" && occ) {
      return res(200, { device_id: occ[1], occupied: false, holder: null, queued: 0,
        ...(over.occ?.[occ[1]] ?? {}) });
    }
    if (method === "POST" && url.endsWith("/test")) {
      return seqAt(over.testResp ?? [{ status: 200, body: { ok: true, connected: true,
        message: "默认回执" } }], n.test++);
    }
    if (method === "POST" && url.endsWith("/reconnect")) {
      return seqAt(over.reconnectResp ?? [{ status: 200, body: device() }], n.reconnect++);
    }
    if (method === "POST" && url.endsWith("/purge")) {
      return seqAt(over.purgeResp ?? [{ status: 200, body: { ok: true } }], n.purge++);
    }
    if (method === "POST" && url.endsWith("/api/v1/adb-devices")) {
      return seqAt(over.createResp ?? [{ status: 201, body: device() }], n.create++);
    }
    throw new Error("未 mock 的请求: " + method + " " + url);
  }) as unknown as typeof fetch;
  return calls;
}

const posts = (c: Req[], re: RegExp) => c.filter((x) => x.method === "POST" && re.test(x.url));
const listGets = (c: Req[]) => c.filter((x) => x.method === "GET" && x.url.includes("/adb-devices?"));

function renderPage() {
  // motion:false（ModuleTree.test.tsx:121 同款）：jsdom 里 rc-motion 不完成，弹窗开关断言会失真
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <MemoryRouter><AdbDevicesPage /></MemoryRouter>
    </ConfigProvider>,
  );
}

/** 进回收站视图并点开 d9 的「彻底删除」弹窗。 */
async function openPurgeModal(): Promise<void> {
  fireEvent.click(await screen.findByTestId("adb-device-recycled"));
  // 回收站那一页到货后整批卡片会被换掉：等 d9 真在场再查钮，
  // 拿换掉之前那个节点点下去是空点（实测 isConnected=false、弹窗 0 个）。
  await waitFor(() => expect(screen.getByTestId("adb-device-card-d9")).not.toBeNull());
  fireEvent.click(screen.getByTestId("adb-device-purge"));
  await screen.findByTestId("adb-device-purge-confirm");
}

beforeEach(() => {
  cleanup();
  navSpy.mockClear();
  useAuth.setState({
    user: { id: "u1", account: "a", name: "张三", email: null, is_system_admin: false, status: "active" },
    project: PROJECT, ready: true,
  });
});

describe("彻底删除：逐字输名门禁（:464/:562/:574）", () => {
  it("空/错名/大小写差/首尾空格全部不放行；逐字相等才发 POST /purge，URL+body 逐字对 adb.ts", async () => {
    const calls = mockBackend({ items: [device()], recycled: [dead()] });
    renderPage();
    await screen.findByTestId("adb-device-card-d1");
    await openPurgeModal();

    const ok = () => screen.getByTestId("adb-device-purge-ok") as HTMLButtonElement;
    const input = screen.getByTestId("adb-device-purge-confirm") as HTMLInputElement;
    const purgePosts = () => posts(calls, /\/api\/v1\/adb-devices\/d9\/purge$/);

    expect(ok().disabled).toBe(true); // 空输入：gate purgeName !== "Pixel6"
    for (const wrong of ["Pixel", "Pixel66", "pixel6", " Pixel6", "Pixel6 "]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(ok().disabled).toBe(true); // 大小写差/带空格都算不等（!== 严格比较）
      fireEvent.click(ok()); // disabled 的钮点了也不该发请求
      expect(purgePosts()).toHaveLength(0);
    }

    fireEvent.change(input, { target: { value: "Pixel6" } });
    await waitFor(() => expect(ok().disabled).toBe(false));
    fireEvent.click(ok());
    await waitFor(() => expect(purgePosts()).toHaveLength(1));
    expect(purgePosts()[0].url).toBe("/api/v1/adb-devices/d9/purge");
    // confirm_name 送的是设备本名；detach 没勾就是 false（adb.ts:111-113 的三字段）
    expect(jso(purgePosts()[0].body)).toEqual({
      project_id: "p1", confirm_name: "Pixel6", detach_referencing: false,
    });
    // 成功后重拉列表（load()，:394）
    await waitFor(() => expect(listGets(calls).filter((x) => x.url.includes("recycled=true")).length)
      .toBeGreaterThanOrEqual(2));
  });

  it("「释放引用」勾选（:577）进 payload：未勾 detach_referencing=false，勾上=true（两次 payload 不同）", async () => {
    const calls = mockBackend({ items: [device()], recycled: [dead()] });
    renderPage();
    await screen.findByTestId("adb-device-card-d1");
    await openPurgeModal();
    const purgePosts = () => posts(calls, /\/api\/v1\/adb-devices\/d9\/purge$/);

    // 第一轮：不勾，逐字输名放行 → body.detach_referencing false
    fireEvent.change(screen.getByTestId("adb-device-purge-confirm"), { target: { value: "Pixel6" } });
    await waitFor(() => expect((screen.getByTestId("adb-device-purge-ok") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("adb-device-purge-ok"));
    await waitFor(() => expect(purgePosts()).toHaveLength(1));
    expect(jso(purgePosts()[0].body).detach_referencing).toBe(false);

    // posts() 数的是「发出」：purge 响应落地（慢后端下晚到）才跑 submitPurge 的
    // setPurge(null)/setPurgeName("")/setDetach(false) 复位（:396），随后才 await load()
    // （:397）重拉回收站列表。不等它就在飞行中重开弹窗，迟到的复位会关掉重开的弹窗、
    // 把 detach/confirm 冲回初始（实测 cb.checked 断言正红在这）。门不能用重开前的
    // OK 按钮 ant-btn-loading：弹窗不 destroyOnClose，关着期间整棵子树不重渲染，
    // 类名冻在 LOADING 不掉（实测：purge 成功、busy 已 false 之后 700ms，关着的 OK 按钮
    // className 仍含 ant-btn-loading）——下面 :238 那条同款等待之所以有效，是因为它在
    // 重开之后、弹窗开着跑。
    // 用 GET 计数当门：recycled 列表第 2 次拉取的「发出」排在 :396 复位同一拍之后
    // （load() 同步派 fetch），数到它 = 复位必然已应用。下面 :238 保留——那钉的是
    // setPurging(false) 压轴（finally :404）在 load()（:397 连占用逐拉）全部落定后
    // 才释放 OK 的 loading，开着弹窗时类名如实更新，点击不被 rc-button 吞。
    await waitFor(() => expect(listGets(calls).filter((x) => x.url.includes("recycled=true")).length)
      .toBeGreaterThanOrEqual(2));

    // 第二轮：重新开弹窗（成功后 submitPurge 把 name/detach 复位，:393）→ 勾选 → true
    fireEvent.click(await screen.findByTestId("adb-device-purge"));
    await screen.findByTestId("adb-device-purge-confirm");
    const cb = screen.getByTestId("adb-device-purge-detach") as HTMLInputElement;
    expect(cb.checked).toBe(false); // 复位断言：上一轮没带过来
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
    fireEvent.change(screen.getByTestId("adb-device-purge-confirm"), { target: { value: "Pixel6" } });
    await waitFor(() => expect((screen.getByTestId("adb-device-purge-ok") as HTMLButtonElement).disabled).toBe(false));
    // 第一次 submitPurge（:390-405）的 setPurging(false) 在 finally，要等 :397 的 await load()
    // 连占用逐拉都跑完才释放；这段窗口里 OK 挂着 ant-btn-loading，rc-button 直接吞点击
    // （满载实测：第二次 click 空点，POST 停在 1）。等上一提交真正落定再按。
    await waitFor(() => expect(screen.getByTestId("adb-device-purge-ok").className).not.toContain("ant-btn-loading"));
    fireEvent.click(screen.getByTestId("adb-device-purge-ok"));
    await waitFor(() => expect(purgePosts()).toHaveLength(2));
    expect(jso(purgePosts()[1].body).detach_referencing).toBe(true);
    // 勾选只改 detach 这一个字段，confirm_name/URL 不变
    expect(jso(purgePosts()[1].body)).toEqual({
      project_id: "p1", confirm_name: "Pixel6", detach_referencing: true,
    });
  });
});

describe("purge 被引用硬拦（409 in_use → :588/:595 点名每一条）", () => {
  it("referring_cases 三条 → 恰好三个 adb-purge-block-case，名字逐个对上，一条不藏", async () => {
    const cases = [
      { id: "c1", name: "登录成功链路" },
      { id: "c2", name: "下单-退款" },
      { id: "c3", name: "扫码支付冒烟" },
    ];
    const calls = mockBackend({
      items: [device()], recycled: [dead()],
      purgeResp: [{ status: 409, body: {
        code: "in_use", message: "仍被 3 条用例设为默认设备",
        details: { device_id: "d9", referring_cases: cases },
      } }],
    });
    renderPage();
    await screen.findByTestId("adb-device-card-d1");
    await openPurgeModal();
    fireEvent.change(screen.getByTestId("adb-device-purge-confirm"), { target: { value: "Pixel6" } });
    await waitFor(() => expect((screen.getByTestId("adb-device-purge-ok") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("adb-device-purge-ok"));

    const block = await screen.findByTestId("adb-purge-block");
    const items = screen.getAllByTestId("adb-purge-block-case");
    expect(items).toHaveLength(3); // 「一条都不藏」：数量
    expect(items.map((li) => li.textContent)).toEqual(["登录成功链路", "下单-退款", "扫码支付冒烟"]); // 名字+顺序
    expect(block.textContent).toContain("Pixel6");
    expect(block.textContent).toContain("被 3 条 ADB 用例设为 default_device"); // 计数与文案同屏
    expect(posts(calls, /\/purge$/)).toHaveLength(1); // 只试了一次，没有自动重试

    // 被拦后 purge 弹窗状态复位（:399 setPurgeName("")/setDetach(false)）：重开是空名未勾。
    // 「关掉」不能断 toBeNull：antd Modal 不 destroyOnClose，关后 wrap 只是 display:none
    // （同 SceneEditor.test.tsx:59 记过的坑）——按同一口径判「看不见」。
    const blockGone = () => {
      const wrap = screen.queryByTestId("adb-purge-block")
        ?.closest(".ant-modal-wrap") as HTMLElement | null;
      return wrap === null || wrap.style.display === "none";
    };
    fireEvent.click(await screen.findByTestId("adb-purge-block-ok"));
    await waitFor(() => expect(blockGone()).toBe(true));
    fireEvent.click(screen.getByTestId("adb-device-purge"));
    await screen.findByTestId("adb-device-purge-confirm");
    expect((screen.getByTestId("adb-device-purge-confirm") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("adb-device-purge-detach") as HTMLInputElement).checked).toBe(false);
  });
});

describe("adb 原话直出（:146 EchoBlock，不翻译不改写）", () => {
  it("重连失败：弹窗标题是「重连失败：<设备名>」，<pre> 内容逐字节等于 adb 原话", async () => {
    const RAW = "adb: device offline\nerror: cannot connect to 192.168.1.20:5555\n"
      + "* daemon not running; starting now at tcp:5037";
    mockBackend({
      items: [device()],
      reconnectResp: [{ status: 422, body: { code: "connect_failed", message: RAW } }],
    });
    renderPage();
    const card = await screen.findByTestId("adb-device-card-d1");
    fireEvent.click(card.querySelector('[data-testid="adb-device-reconnect"]') as HTMLElement);

    await screen.findByTestId("adb-echo-text");
    // 原话按字节进 <pre>：换行、星号、英文原样，不 paraphrase
    expect(screen.getByTestId("adb-echo-text").textContent).toBe(RAW);
    expect(screen.getByTestId("adb-echo-text").textContent).toContain("adb: device offline");
    expect(screen.getByText("重连失败：Pixel6")).not.toBeNull();
    // 说明文案自己也说「未做翻译或改写」
    expect(document.body.textContent).toContain("未做翻译或改写");
  });
});

describe("测试连接回执（:157 adb-test-result / :169 adb-test-shot）", () => {
  const cardTestBtn = async () => {
    const card = await screen.findByTestId("adb-device-card-d1");
    return card.querySelector('[data-testid="adb-device-test"]') as HTMLElement;
  };

  it("ok=false：error Alert 带 adb 原话，且没有截图 img", async () => {
    const failMsg = "adb connect 192.168.1.20:5555 失败: unable to connect to daemon";
    mockBackend({ items: [device()], testResp: [{ status: 200, body: {
      ok: false, connected: false, message: failMsg,
    } }] });
    renderPage();
    fireEvent.click(await cardTestBtn());

    const box = await screen.findByTestId("adb-test-result");
    expect(box.querySelector(".ant-alert")!.className).toContain("ant-alert-error");
    expect(box.querySelector(".ant-alert-message")!.textContent).toBe(failMsg);
    expect(screen.queryByTestId("adb-test-shot")).toBeNull();
    expect(box.textContent).toContain("以上是 adb 的原始输出（未翻译未改写）");
  });

  it("ok=true 带 screenshot_b64：恰好一张 adb-test-shot，src 是 data:image/png;base64, 前缀", async () => {
    mockBackend({ items: [device()], testResp: [{ status: 200, body: {
      ok: true, connected: true, message: "连接成功", model: "Pixel 6", os_version: "13",
      screenshot_b64: "iVBORw0KGgoAAAANSUhEUg==",
    } }] });
    renderPage();
    fireEvent.click(await cardTestBtn());

    await screen.findByTestId("adb-test-result");
    const shots = screen.getAllByTestId("adb-test-shot");
    expect(shots).toHaveLength(1);
    expect((shots[0] as HTMLImageElement).src)
      .toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");
    expect(screen.getByTestId("adb-test-result").textContent).toContain("机型 Pixel 6 · 系统 13");
  });

  it("ok=true 无 screenshot_b64：画「这次没截到图」，没有 img", async () => {
    mockBackend({ items: [device()], testResp: [{ status: 200, body: {
      ok: true, connected: true, message: "连接成功", screenshot_b64: null,
    } }] });
    renderPage();
    fireEvent.click(await cardTestBtn());

    const box = await screen.findByTestId("adb-test-result");
    expect(box.textContent).toContain("这次没截到图（screencap 未回 PNG 字节）。");
    expect(screen.queryByTestId("adb-test-shot")).toBeNull();
  });
});

describe("刷新与加载失败（:505/:516）", () => {
  it("点「刷新」→ list GET 计数 +1 且用的是同一个 URL", async () => {
    const calls = mockBackend({ items: [device()] });
    renderPage();
    await screen.findByTestId("adb-device-card-d1");
    expect(listGets(calls)).toHaveLength(1);

    fireEvent.click(screen.getByTestId("adb-device-reload"));
    await waitFor(() => expect(listGets(calls)).toHaveLength(2));
    // 同 URL 重拉（project_id+size 一个字符没变），不是拍了个别的端点
    expect(listGets(calls)[1].url).toBe(listGets(calls)[0].url);
    expect(listGets(calls)[0].url).toContain("/api/v1/adb-devices?");
  });

  it("列表 500：Alert 原样带后端 message，且刻意没有 ×（关不掉是设计）", async () => {
    mockBackend({ listResp: [{ status: 500, body: {
      code: "db_down", message: "数据库连接池耗尽（内部错误码 0x5f3759df）",
    } }] });
    renderPage();
    const alert = await screen.findByTestId("adb-device-load-error");
    expect(alert.textContent).toContain("设备列表加载失败");
    // 描述位是 EchoBlock：后端 message 原话逐字进 <pre>
    expect(screen.getByTestId("adb-echo-text").textContent)
      .toBe("数据库连接池耗尽（内部错误码 0x5f3759df）");

    // 不给 closable：脚注与空卡墙都读同一个 loadError，加个 × 就是给用户一个
    // 「把故障擦成实测零台」的按钮——关掉后墙上会画「还没有设备」+「共 0 台」。
    // 要它消失只有刷新成功一条路（同 reportDetail.tsx:346「报告没取到」不 closable）。
    expect(alert.querySelector(".ant-alert-close-icon")).toBeNull();
    expect(document.body.textContent).toContain("本次设备列表加载失败，本行计数不作数");
    expect(screen.queryByTestId("adb-device-empty")).toBeNull();
  });
});

describe("添加设备公开开关（:228 → submit :204-207）", () => {
  it("开关默认开；关掉提交 body.project_public=false；成功复位后重开再提交是 true", async () => {
    const calls = mockBackend({ items: [] });
    renderPage();
    fireEvent.click(await screen.findByTestId("adb-device-add"));

    const sw = screen.getByTestId("adb-device-public");
    expect(sw.getAttribute("aria-checked")).toBe("true"); // 初值 useState(true)，:194
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");

    fireEvent.change(screen.getByTestId("adb-device-name"), { target: { value: "新机甲" } });
    fireEvent.change(screen.getByTestId("adb-device-add-serial"), { target: { value: " 192.168.9.9:5555 " } });
    fireEvent.click(screen.getByTestId("adb-device-add-ok"));
    await waitFor(() => expect(posts(calls, /\/api\/v1\/adb-devices$/)).toHaveLength(1));
    // 字段名/值逐字对 adbDevices.tsx:204-207；serial 被 trim（:205 两侧空格吃掉）
    expect(jso(posts(calls, /\/api\/v1\/adb-devices$/)[0].body)).toEqual({
      project_id: "p1", name: "新机甲", serial: "192.168.9.9:5555",
      connect_type: "wifi", wifi_addr: null, enabled: true, project_public: false,
    });

    // 成功后 submit 复位 pub=true（:209）→ 重开弹窗开关回到开，直接再提交 → true。
    // 但 posts() 数的是「发出」：create 响应落地（慢后端下晚到）才跑 submit 的
    // setName("")/setSerial("")/setPub(true) 复位（:209），随后 onClose()（:210）、
    // await onCreated()（:211 = load 重拉列表）——不等它就重开，迟到的复位会把刚
    // 填的名字/序列号清空、开关冲回 true（实测 sw2 aria-checked 断言正红在这）。
    // 门不能用 OK 按钮 ant-btn-loading：弹窗不 destroyOnClose，关着期间整棵子树不
    // 重渲染，类名冻在 LOADING 不掉（实测：create 成功、busy 已 false 之后 700ms，关着的
    // OK 按钮 className 仍含 ant-btn-loading）——下面 :442 那条同款等待有效，是因为它在
    // 重开之后、弹窗开着跑。
    // 用 GET 计数当门：list 第 2 次拉取的「发出」排在 :209 复位同一拍之后（load()
    // 同步派 fetch），数到它 = 复位必然已应用。:424 保留——那钉的是 setBusy(false)
    // （finally :214，压在 await onCreated :211 之后）真正释放，点击不被 rc-button 吞。
    await waitFor(() => expect(listGets(calls).length).toBeGreaterThanOrEqual(2));
    fireEvent.click(await screen.findByTestId("adb-device-add"));
    const sw2 = await screen.findByTestId("adb-device-public");
    expect(sw2.getAttribute("aria-checked")).toBe("true");
    fireEvent.change(screen.getByTestId("adb-device-name"), { target: { value: "新机乙" } });
    fireEvent.change(screen.getByTestId("adb-device-add-serial"), { target: { value: "192.168.9.10:5555" } });
    // 同 purge 那条的机制：submit（:198-215）的 setBusy(false) 排在 await onCreated()
    // （:211 → load 重拉列表）之后，第一次 create 落定前 add-ok 一直 ant-btn-loading，
    // 点下去被 rc-button 吞掉（满载实测 POST 停在 1）。等 busy 真正释放再提交。
    await waitFor(() => expect(screen.getByTestId("adb-device-add-ok").className).not.toContain("ant-btn-loading"));
    fireEvent.click(screen.getByTestId("adb-device-add-ok"));
    await waitFor(() => expect(posts(calls, /\/api\/v1\/adb-devices$/)).toHaveLength(2));
    expect(jso(posts(calls, /\/api\/v1\/adb-devices$/)[1].body).project_public).toBe(true);
  });
});

describe("卡片名称标签（:418 adb-device-name-label）", () => {
  it("每卡渲染 name；名 ≠ 序列号的设备标签是名字，序列号只出现在序列号行", async () => {
    mockBackend({ items: [
      device(),
      device({ id: "d7", name: "测试机乙", serial: "10.0.0.9:5555", wifi_addr: null }),
    ] });
    renderPage();
    await screen.findByTestId("adb-device-card-d1");
    await screen.findByTestId("adb-device-card-d7");

    const labels = screen.getAllByTestId("adb-device-name-label").map((n) => n.textContent);
    expect(labels).toEqual(["Pixel6", "测试机乙"]);
    // 名字标签绝不用序列号顶名
    expect(labels).not.toContain("10.0.0.9:5555");
    // 序列号在 serial 行如实出现（wifi_addr 为 null 时回落到 serial）
    const serials = screen.getAllByTestId("adb-device-serial").map((n) => n.textContent);
    expect(serials).toEqual(["192.168.1.20", "10.0.0.9:5555"]);
  });
});
