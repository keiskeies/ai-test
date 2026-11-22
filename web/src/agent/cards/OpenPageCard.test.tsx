// suggest_open_page 卡 + toPageUrl 单测。钉的是**今天的契约**：route 白名单门在后端出口，
// 卡片对 params 逐字透传（D119「Pilot 自家跳转不带 ?q=<id> 高亮参数」是待业主裁项——
// 这里既不钉 q、也不许顺手改）。渲染走 renderCard 协议分派（QuestionCard/ScenarioPlansCard
// 同纪律），不直连组件。导航断言选 vi.mock react-router-dom → 录制 useNavigate（ProjectGate/
// CommandPalette 同款）：直接咬住 navigate 收到的字符串，证明「点击的 URL」与「屏显的 URL」
// 是同一个值、不可能各说各话。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "./index"; // 注册副作用：generic:open_page 进 registry
import { renderCard } from "./registry";
import { toPageUrl } from "./OpenPageCard";
import type { CardPayload, OpenPagePayload } from "./types";

// antd 响应式观察器要 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const nav = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => nav,
}));

function view(p: OpenPagePayload, busy = false) {
  return render(<div>{renderCard(p as unknown as CardPayload, { onUserMessage: () => undefined, busy })}</div>);
}
const shownUrl = () => document.querySelector(".tp-mono")!.textContent!;
const go = () => screen.getByTestId("open-page-go") as HTMLButtonElement;

beforeEach(() => { cleanup(); nav.mockClear(); });

describe("toPageUrl（查询串拼接，纯函数）", () => {
  it("route 带/不带前导斜杠都归一到 /", () => {
    expect(toPageUrl("/scene/1")).toBe("/scene/1");
    expect(toPageUrl("scene/1")).toBe("/scene/1"); // 后端可能给裸路由，前端补斜杠
  });
  it("无 params（undefined/空对象）= 裸路径，绝不留悬空 ?", () => {
    expect(toPageUrl("/scene/1")).toBe("/scene/1");
    expect(toPageUrl("/scene/1", {})).toBe("/scene/1");
    expect(toPageUrl("x", undefined)).toBe("/x");
  });
  it("一个/两个参数：单项直拼，多项 & 连接", () => {
    expect(toPageUrl("/s", { a: "1" })).toBe("/s?a=1");
    expect(toPageUrl("/s", { a: "1", b: "2" })).toBe("/s?a=1&b=2");
  });
  it("键与值都过 encodeURIComponent：中文/空格/&/= 不得原样进 URL", () => {
    // & 不编码会把一个值劈成两个参数；= 不编码键值对会错位——这是查询串的生死线
    expect(toPageUrl("/s", { "a b&c=d": "中 &x=1" }))
      .toBe("/s?a%20b%26c%3Dd=%E4%B8%AD%20%26x%3D1");
  });
  it("数值经 String(v) 强转（payload 声明 number 也拼得出来）", () => {
    expect(toPageUrl("/s", { page: 3 })).toBe("/s?page=3");
  });
});

describe("OpenPageCard（renderCard 协议分派）", () => {
  const PAYLOAD: OpenPagePayload = {
    kind: "generic", form: "open_page", route: "scene/1", params: { q: "支付 场景", page: 2 },
  };
  const URL = "/scene/1?q=" + encodeURIComponent("支付 场景") + "&page=2";

  it("走 generic:open_page 注册键渲染，屏显文本 = toPageUrl 的计算结果", () => {
    view(PAYLOAD);
    expect(screen.getByTestId("open-page-card")).toBeTruthy();
    expect(screen.getByTestId("open-page-go")).toBeTruthy();
    expect(shownUrl()).toBe(toPageUrl(PAYLOAD.route, PAYLOAD.params));
    expect(shownUrl()).toBe(URL); // 且 params 逐字透传：卡片不加键、不删键、不改序
  });

  it("点[前往]：navigate 收到的就是屏显那一条（label 与点击不可能漂移）", () => {
    view(PAYLOAD);
    const shown = shownUrl();
    fireEvent.click(go());
    expect(nav).toHaveBeenCalledTimes(1);
    expect(nav).toHaveBeenCalledWith(shown);
  });

  it("busy：按钮 disabled + 「等本轮结束」，点了也不导航", () => {
    view(PAYLOAD, true);
    expect(go().disabled).toBe(true);
    expect(screen.getByTestId("card-busy-note").textContent).toBe("等本轮结束");
    fireEvent.click(go()); // 运行中点了也不许跳：本轮结果还没落地，跳走就丢了现场
    expect(nav).not.toHaveBeenCalled();
  });

  it("空闲：「等本轮结束」缺席（busy 文案不能常驻吓人）", () => {
    view(PAYLOAD, false);
    expect(go().disabled).toBe(false);
    expect(screen.queryByTestId("card-busy-note")).toBeNull();
  });

  it("route 空串/缺席：toPageUrl(\"\") = \"/\"，卡片不崩、文本无 undefined", () => {
    view({ kind: "generic", form: "open_page", route: "" });
    expect(shownUrl()).toBe("/");
    cleanup();
    view({ kind: "generic", form: "open_page" } as unknown as OpenPagePayload);
    expect(screen.getByTestId("open-page-card")).toBeTruthy();
    expect(shownUrl()).toBe("/"); // String(undefined ?? "") → "" → "/"，不是 "undefined"
  });
});
