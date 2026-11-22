// AdbDebugPanel 的**默认导出**此前从未被任何测试接走：全仓唯一一条边是
// pages/adbCaseDetail.test.tsx:32 的 `import { modeBadge }`（具名纯函数），
// scripts/audit-test-debt.mjs 轴②（「有 export default 但默认导出没接走」）因此把
// 整块面板判成「整块面没测过」——面板 ~10 个静态 testid 一个都没被渲染过。
// modeBadge 的三态映射在 adbCaseDetail.test.tsx:121-130 已钉死，这里不重复；
// 预算全花在渲染面与「门」的组合上。钉十条（行号 = AdbDebugPanel.tsx）：
// ① running 半截态：正文只说「真设备正在跑」，note(:144)/发起失败 Alert(:150)/
//   耗时(:126)/mode 徽标(:130) 四道 !running 门全部让位；但设备标(:133)与
//   「查看报告」(:136) 只 gate result——门不对称，见 FINDING-1；
// ② 空态（!running && !result && !error）：Empty 话术「占用会当场拒绝，不排队」原样，
//   没有任何徽标/报告链接；关闭钮点一次叫一次 onClose（:142）；
// ③ 发起失败（error && !running）：徽标「发起失败」data-status=error 红，
//   Alert「调试没有发起」+ description = 后端原话逐字（422 不演半截结论），
//   note 逐字（含「已代为保存」出口），Empty 让位，无时间线行；
// ④ 成功回执：徽标走 STATUSES（passed→「通过」绿），耗时 :126 逐字「1234ms」，
//   mode 徽标 u2 绿、设备标带 serial、「查看报告」href=#/reports/{run_id}；
// ⑤ 时间线行（:168-192）：id/type/status/message 逐行 data-* 可定位，message 逐字
//   （cmdRows 对缺键行也出行——message 为空串时空 span 仍在）；
// ⑥ 变量快照（:193-203）：vars 条数进标题，非空画 ${k} = v，空画「没有存过变量」；
// ⑦ 断言卡直复 api/DebugPanel：ok=true 且 status=null → debug-status 画**空徽标**
//   （字段照实缺失的副作用，见 FINDING-2）；断言行 期望/实际 逐字上屏（ADB 核 _row 的
//   error 恒为 None，DebugPanel.tsx:147 的 error 分支在 ADB 域生产不可达，不为其造假形状）；
// ⑧ 未知 status/未知 mode：徽标回落原始码（:123 meta?.label ?? result.status），
//   mode 回落「模式 {raw}」（modeBadge 尾支），device=null / vars={} 的缺失态不造假；
// ⑨ 截图内联（:180-190 + ShotImg :33-56）：只有 SCREENSHOT 进 <img>（VIDEO/LOG 拒收），
//   取字节必须带 projectId（fetchArtifactBlob 的 ?project_id=，:41）；加载中/失败
//   （后端 message 逐字）两态可见；卸载必 revokeObjectURL（:48）；
// ⑩ 拖把手（:104-115）：120 ~ round(0.6·innerHeight) 双向夹紧，pointerUp 收尾后
//   pointerMove 不再改高度。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfigProvider } from "antd";
// 必须是默认导出：轴②钉的就是「默认导出没人接走」，具名 import 写了也白写。
import AdbDebugPanel from "./AdbDebugPanel";
import type { AdbDebugResult } from "../api/adbCase";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补，同 EnvPanel.test.tsx:44）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});
// jsdom 没有 pointer capture，:107 的 setPointerCapture 直调会在 handler 里炸——
// 桩成 no-op（只桩环境件，不桩组件逻辑）。
HTMLElement.prototype.setPointerCapture = vi.fn();
HTMLElement.prototype.releasePointerCapture = vi.fn();

/** 字段逐字 = AdbDebugResult（adbCase.ts:88-102）。 */
function mkResult(over: Partial<AdbDebugResult> = {}): AdbDebugResult {
  return {
    run_id: "run-1",
    status: "passed",
    ok: true,
    passed: true,
    elapsed_ms: 1234,
    error: null,
    mode: "u2",
    device: "emulator-5554",
    vars: { tok: "abc" },
    commands: [
      // 形状逐字抄生产：type 在 commands.py:26-34 STEP_TYPES 里（没有 tap）；
      // message = adb_core.py:387 的 click_xy 回执拼接（逗号后无空格）；
      // 断言行 = adb_core.py:452-454 assert_element 的 _row 形状（expected=控件值、
      // actual="存在"、path=by+":"+value）。
      { id: "s1", type: "click_xy", status: "pass", message: "点击 (320,540)", elapsed_ms: 800,
        assertions: [{ type: "assert_element", path: "resource_id:btn_login", passed: true, expected: "btn_login", actual: "存在" }] },
      { id: "s2", type: "assert_text", status: "skip", message: "", elapsed_ms: 12 },
    ],
    artifacts: [],
    ...over,
  };
}

function renderPanel(props: Partial<Parameters<typeof AdbDebugPanel>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <AdbDebugPanel result={null} running={false} error={null} note={null}
        projectId="p1" onClose={onClose} {...props} />
    </ConfigProvider>,
  );
  return { ...utils, onClose };
}

const panel = () => screen.getByTestId("adb-debug-panel");
const badge = () => screen.getByTestId("adb-debug-badge");

/** jsdom 默认 innerHeight=768 → :94 maxH=round(768*0.6)；夹紧断言按同一公式量，不写死。 */
const MAX_H = Math.round(window.innerHeight * 0.6);

beforeEach(() => {
  cleanup();
  URL.createObjectURL = vi.fn(() => "blob:shot");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => cleanup());

describe("① running 半截态：四道 !running 门 + 两扇只认 result 的门", () => {
  it("running=true 时 note/Alert/耗时/mode 全部让位，正文只说真设备在跑；设备标与报告链接照旧在场", () => {
    renderPanel({
      running: true,
      result: mkResult(),
      error: "设备被占用的原话",
      note: "本次发起前已代为保存屏幕上的修改。",
    });
    // :119 running 分支独占徽标：即便 error 与 result 都在场，也只画「运行中」
    expect(badge().textContent).toBe("运行中");
    expect(badge().className).toContain("ant-tag-processing");
    expect(screen.getByText(/真设备正在跑/)).not.toBeNull();
    // 四道 !running 门逐条钉（删任何一道本用例都要红）
    expect(screen.queryByTestId("adb-debug-note")).toBeNull(); // :144 note && !running
    expect(screen.queryByText("调试没有发起")).toBeNull(); // :150 error && !running
    expect(screen.queryByText("1234ms")).toBeNull(); // :126 result && !running
    expect(screen.queryByTestId("adb-debug-mode")).toBeNull(); // :130 result && !running && mode
    expect(screen.queryAllByTestId("adb-debug-step-row")).toHaveLength(0); // :165
    // 【FINDING-1】:133/:136 只 gate result，不 gate !running——重跑进行中仍画着
    // **上一轮**的 serial 与报告链接（新轮可能换了设备），与 :126/:130 的 !running
    // 门不对称；调试面板当场说错设备是 T6「降级不可见」同款纪律 1 风险。此处按现状钉。
    expect(screen.getByTestId("adb-debug-report-link")).not.toBeNull();
    expect(screen.getByTestId("adb-debug-device").textContent).toBe("设备 emulator-5554");
  });
});

describe("② 空态与关闭", () => {
  it("全空：Empty 话术原样、无徽标无报告链接；点[关闭]恰叫一次 onClose", () => {
    const { onClose } = renderPanel();
    expect(screen.getByText("点「调试」用空闲设备真跑一遍（占用会当场拒绝，不排队）")).not.toBeNull();
    expect(screen.queryByTestId("adb-debug-badge")).toBeNull();
    expect(screen.queryByTestId("adb-debug-report-link")).toBeNull();
    expect(screen.queryByTestId("adb-debug-note")).toBeNull();
    expect(screen.queryByText(/真设备正在跑/)).toBeNull();
    fireEvent.click(screen.getByTestId("adb-debug-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("③ 发起失败（error 直出，不演半截结论）", () => {
  it("徽标「发起失败」红 + Alert description = 422 原话逐字 + note 逐字 + Empty 让位 + 零时间线行", () => {
    const ERR = "设备 emulator-5554 正被「张三」占用，调试不排队（422）";
    const NOTE = "本次发起前已代为保存屏幕上的修改（已保存的步骤序列）。";
    renderPanel({ error: ERR, note: NOTE });
    expect(badge().textContent).toBe("发起失败");
    expect(badge().getAttribute("data-status")).toBe("error");
    expect(badge().className).toContain("ant-tag-red");
    expect(screen.getByText("调试没有发起")).not.toBeNull();
    // description 逐字（截断/吞字段正是这条要抓的）
    expect(screen.getByText(ERR)).not.toBeNull();
    expect(screen.getByTestId("adb-debug-note").textContent).toContain(NOTE);
    // 面板说「没有发起」：不该长出任何演出来的结论件
    expect(screen.queryByText("点「调试」用空闲设备真跑一遍（占用会当场拒绝，不排队）")).toBeNull();
    expect(screen.queryAllByTestId("adb-debug-step-row")).toHaveLength(0);
    expect(screen.queryByTestId("adb-debug-report-link")).toBeNull();
  });
});

describe("④/⑤/⑥ 成功回执的整板渲染", () => {
  it("通过徽标+耗时+u2 绿标+设备 serial+报告 href；时间线两行 data-* 齐全、message 逐字；变量快照摊开 ${tok}", () => {
    renderPanel({ result: mkResult() });
    expect(badge().textContent).toBe("通过"); // STATUSES.passed（runVocab.ts:53）
    expect(badge().getAttribute("data-status")).toBe("passed");
    expect(badge().className).toContain("ant-tag-green");
    expect(screen.getByText("1234ms")).not.toBeNull();
    expect(screen.getByTestId("adb-debug-mode").textContent).toBe("控件树会话 (u2)");
    expect(screen.getByTestId("adb-debug-mode").className).toContain("ant-tag-green");
    expect(screen.getByTestId("adb-debug-device").textContent).toBe("设备 emulator-5554");
    const link = screen.getByTestId("adb-debug-report-link");
    expect(link.getAttribute("href")).toBe("#/reports/run-1");
    expect(link.textContent).toBe("查看报告");

    const rows = screen.getAllByTestId("adb-debug-step-row");
    expect(rows.map((r) => r.getAttribute("data-id"))).toEqual(["s1", "s2"]);
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["pass", "skip"]);
    // message 逐字 = adb_core.py:387 拼接（"点击 (x,y)"，逗号后无空格、没有目标名可编）；
    // s2 的空 message 也要有空 span 在场（:178）
    expect(screen.getByTestId("adb-debug-step-message-s1").textContent)
      .toBe("点击 (320,540)");
    expect(screen.getByTestId("adb-debug-step-message-s2").textContent).toBe("");
    expect(rows[0].textContent).toContain("click_xy"); // 类型列原样（cmdRows 不翻中文名）
    expect(rows[0].textContent).toContain("800ms");
    expect(screen.getByText("步骤时间线")).not.toBeNull();

    const vars = screen.getByTestId("adb-debug-vars");
    expect(vars.textContent).toContain("变量快照（1）");
    const code = screen.getByText("${tok}");
    expect(code.tagName).toBe("CODE");
    expect(vars.textContent).toContain("= abc");

    // ⑦ 断言卡直复 DebugPanel：一行通过的 assert_element（adb_core.py:452 的真实形状）
    expect(screen.getByTestId("debug-assert-pass").textContent).toBe("断言全过");
    const card = screen.getByTestId("assertion-card");
    expect(card.textContent).toContain("assert_element");
    expect(card.textContent).toContain("resource_id:btn_login");
    expect(card.textContent).toContain('期望 "btn_login"');
    expect(card.textContent).toContain('实际 "存在"');
    // 【FINDING-2】AdbDebugPanel.tsx:82 喂给复用 DebugPanel 的 status 恒为 null，
    // DebugPanel.tsx:36 对 ok=true 画 {result.status} → 成功运行顶着一枚**空徽标**
    // （无占位文案）。「字段照实缺失」是对的，但空 Chip 与渲染失败在视觉上无法区分。
    expect(screen.getByTestId("debug-status").textContent).toBe("");
  });

  it("未知 status/未知 mode 回落原始码；device=null / vars={} 的缺失态不造假", () => {
    renderPanel({ result: mkResult({ status: "aborted", mode: "scrcpy", device: null, vars: {} }) });
    // :123 meta?.label ?? result.status —— 查不到的状态照实显示生码，不编友好标签
    expect(badge().textContent).toBe("aborted");
    expect(badge().getAttribute("data-status")).toBe("aborted");
    expect(screen.getByTestId("adb-debug-mode").textContent).toBe("模式 scrcpy");
    expect(screen.queryByTestId("adb-debug-device")).toBeNull();
    expect(screen.getByTestId("adb-debug-vars").textContent).toContain("变量快照（0）");
    expect(screen.getByTestId("adb-debug-vars").textContent).toContain("没有存过变量");
    expect(screen.queryByText("${tok}")).toBeNull();
  });
});

describe("⑤/⑦ 失败与执行错误回执", () => {
  it("failed：徽标「断言失败」橙；断言卡把 期望/实际 两段原话上屏", () => {
    renderPanel({
      result: mkResult({
        status: "failed", ok: false, passed: false,
        commands: [{
          id: "t1", type: "assert_text", status: "fail", message: "期望文案「余额」未出现", elapsed_ms: 640,
          // 形状照抄 adb_core.py:441-442 的 assert_text 失败行（expected=期望文案、actual=屏幕文本）。
          // 不造 error 键：ADB 核 5 处 _row 调用的 error 实参恒为 None（:441/:452/:462/:477/:550/:557），
          // DebugPanel.tsx:147 的 error 渲染分支在 ADB 域生产不可达——其可测性归 API 域（DebugPanel 直测）。
          assertions: [{ type: "assert_text", passed: false, expected: "余额", actual: "首页" }],
        }],
      }),
    });
    expect(badge().textContent).toBe("断言失败"); // STATUSES.failed
    expect(badge().getAttribute("data-status")).toBe("failed");
    expect(badge().className).toContain("ant-tag-orange");
    const row = screen.getByTestId("adb-debug-step-row");
    expect(row.getAttribute("data-status")).toBe("fail");
    expect(row.textContent).toContain("fail");
    const card = screen.getByTestId("assertion-card");
    expect(card.textContent).toContain('期望 "余额"');
    expect(card.textContent).toContain('实际 "首页"');
    // ok=false 时 DebugPanel 的断言标不画（DebugPanel.tsx:43），状态标改口「请求失败」
    expect(screen.queryByTestId("debug-assert-fail")).toBeNull();
    expect(screen.getByTestId("debug-status").textContent).toBe("请求失败");
  });

  it("status=error + result.error：徽标「请求失败」，执行错误原话走复用 DebugPanel 的 Alert（不是发起失败 Alert）", () => {
    renderPanel({
      result: mkResult({ status: "error", ok: false, passed: false, error: "adb daemon 挂了：device offline" }),
    });
    // 头部徽标与 DebugPanel 徽标此刻都叫「请求失败」，所以必须按 testid 取，不能裸 getByText
    expect(badge().textContent).toBe("请求失败");
    expect(badge().getAttribute("data-status")).toBe("error");
    expect(screen.getByText("adb daemon 挂了：device offline")).not.toBeNull();
    // error prop（发起失败 Alert）与 result.error（执行错误）是两条通道，不许串
    expect(screen.queryByText("调试没有发起")).toBeNull();
  });
});

describe("⑨ 截图内联：只有 SCREENSHOT 进 <img>，projectId 必须跟着走", () => {
  it("SCREENSHOT 走 /artifacts/{run}/{name}?project_id=pid-9 → img src=blob URL；VIDEO 拒收；卸载 revoke", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return {
        ok: true, status: 200,
        blob: async () => new Blob(["px"]),
        json: async () => ({}),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { unmount } = renderPanel({
      projectId: "pid-9",
      result: mkResult({
        run_id: "run-9",
        commands: [{ id: "s1", type: "screenshot", status: "pass", message: "截图已存", elapsed_ms: 90 }],
        artifacts: [
          { kind: "SCREENSHOT", step_key: "s1", ref: "run-9/fail.png", bytes: 100, reason: "失败截图" },
          { kind: "SCREENSHOT", step_key: "no-such-row", ref: "run-9/x.png", bytes: 1, reason: "不该出现" },
          { kind: "VIDEO", step_key: "s1", ref: "run-9/v.mp4", bytes: 9, reason: "录屏" },
        ],
      }),
    });
    // 加载中态（:51）——fetch 的 promise 还没落地，此刻必须可见
    expect(screen.getByText("截图加载中…")).not.toBeNull();
    const img = await screen.findByTestId("adb-debug-shot-s1");
    expect(img.getAttribute("src")).toBe("blob:shot");
    expect(img.getAttribute("alt")).toBe("fail.png"); // ref 去 run 前缀后的 name（artifactName）
    expect(screen.getByText("失败截图")).not.toBeNull();
    // projectId 逐字进 query（:41 fetchArtifactBlob({projectId})）；VIDEO 与非本行之外的
    // SCREENSHOT 一条都不许多发
    expect(urls).toEqual(["/api/v1/artifacts/run-9/fail.png?project_id=pid-9"]);
    expect(screen.queryByText("录屏")).toBeNull();
    expect(screen.queryByText("不该出现")).toBeNull();
    unmount();
    // 用完 revoke（:48）——漏了就是 Blob 常驻内存
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:shot");
  });

  it("制品 404：后端 message 逐字上屏（danger 文案），img 不在场", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 404,
      blob: async () => new Blob([]),
      json: async () => ({ code: "not_found", message: "制品已过期" }),
    })) as unknown as typeof fetch;
    renderPanel({
      result: mkResult({
        run_id: "run-9",
        commands: [{ id: "s1", type: "screenshot", status: "pass", message: "", elapsed_ms: 1 }],
        artifacts: [{ kind: "SCREENSHOT", step_key: "s1", ref: "run-9/gone.png", bytes: 0, reason: "r" }],
      }),
    });
    const err = await screen.findByText("制品已过期");
    expect(err.className).toContain("ant-typography-danger");
    expect(screen.queryByTestId("adb-debug-shot-s1")).toBeNull();
  });
});

describe("⑩ 拖把手：120 ~ round(0.6·innerHeight) 双向夹紧", () => {
  it("默认 300px；上拖 +100 → 400px；越界夹到 maxH；pointerUp 后再移动不改高；下拖夹到 120px", () => {
    renderPanel();
    expect(panel().style.height).toBe("300px"); // DEFAULT_H（:22）
    expect(panel().style.minHeight).toBe("120px");
    expect(panel().style.maxHeight).toBe(MAX_H + "px");
    const handle = screen.getByTestId("adb-debug-resize");
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 300, pointerId: 1 }); // dh = 300 + (400-300)
    expect(panel().style.height).toBe("400px");
    fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 }); // dh = 600 → 夹到 maxH
    expect(panel().style.height).toBe(MAX_H + "px");
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 10, pointerId: 1 }); // :114 收尾后再动无效
    expect(panel().style.height).toBe(MAX_H + "px");
    fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 600, pointerId: 1 }); // dh < 0 → 夹到 MIN_H
    expect(panel().style.height).toBe("120px");
  });
});
