// 候选场景卡组件测试。**渲染一律走 renderCard（kind 协议分派）**，不直接 import 组件——
// 这样把 registry 分派摘掉时本文件必红（计划 T3 变异自证的反向钉：渲染真走协议而非 tool_name 硬编码）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../cards"; // 内置渲染器注册副作用（每个测试文件独立模块表，注册只跑一次即够）
import { renderCard } from "./registry";
import type { CardContext } from "./registry";
import { PREVIEW_KEY_PREFIX, readPreviewEntry } from "./previewLink";
import type { CardPayload, ScenarioPlansPayload } from "./types";

// antd 响应式观察器要 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// T2 计划写明的 payload 形状：{ui:"card", card:{kind:"scenario_plans", plans:[...]}}（自包含）
const PAYLOAD: ScenarioPlansPayload = {
  kind: "scenario_plans",
  plans: [
    {
      name: "登录正路回归",
      intent: "覆盖账号密码登录主链路",
      est_steps: ["打开登录页", "输入正确账号密码", "断言跳转首页"],
      risks: ["验证码依赖人工"],
      env_hint: "演示环境",
      graph: { nodes: [], edges: [] },
    },
    {
      name: "登录异常回归",
      intent: "覆盖错密码/锁定策略",
      est_steps: ["打开登录页", "连续输错 5 次", "断言账号锁定提示"],
      risks: ["锁定策略各环境不同", "需要干净数据集"],
    },
  ],
};

function view(ctx: CardContext) {
  return render(<div>{renderCard(PAYLOAD as unknown as CardPayload, ctx)}</div>);
}

beforeEach(cleanup);

describe("ScenarioPlansCard · [画布预览]（T4 接真）", () => {
  // PAYLOAD 里 plan[0] 带 graph（可预览）、plan[1] 没带（保持 disabled + 人话）
  it("有 graph 才可点：plan[0] 可点、plan[1] 恒 disabled", () => {
    view({ onUserMessage: () => undefined, busy: false });
    const btns = screen.getAllByTestId("plan-preview");
    expect((btns[0] as HTMLButtonElement).disabled).toBe(false);
    expect((btns[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("点击：sessionStorage 写入 tp-scene-preview:<run>:<index> 正确键 + 新 Tab 打开 /scene-preview?k=…", () => {
    sessionStorage.clear();
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      view({ onUserMessage: () => undefined, busy: false, projectId: "p-1" });
      fireEvent.click(screen.getAllByTestId("plan-preview")[0]);
      expect(openSpy).toHaveBeenCalledTimes(1);
      const url = String(openSpy.mock.calls[0][0]);
      expect(openSpy.mock.calls[0][1]).toBe("_blank"); // 新 Tab：同 Tab 跳会丢 bench 现场
      const m = /^#\/scene-preview\?k=(.+)$/.exec(url);
      expect(m).toBeTruthy();
      const key = decodeURIComponent(m![1]);
      // 键 = 前缀 + run 段 + plan_index（plan[0] → :0）
      expect(key.startsWith(PREVIEW_KEY_PREFIX + ":")).toBe(true);
      expect(key.endsWith(":0")).toBe(true);
      // 存的内容预览页读得回来，且 graph/plan_name/归属项目逐字保真
      const entry = readPreviewEntry(key);
      expect(entry.kind).toBe("ok");
      if (entry.kind === "ok") {
        expect(entry.planName).toBe("登录正路回归");
        expect(entry.graph).toEqual({ nodes: [], edges: [] });
        expect(entry.projectId).toBe("p-1");
      }
    } finally {
      openSpy.mockRestore();
    }
  });

  it("没带 graph 的方案：disabled 的钮 + Tooltip 说人话（悬停出文案）", async () => {
    view({ onUserMessage: () => undefined, busy: false });
    const btn = screen.getAllByTestId("plan-preview")[1];
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // antd Tooltip：hover 外层 span 后文案进 DOM（rc-trigger 异步渲染，等一下）
    const wrap = btn.closest("span") as Element;
    fireEvent.mouseEnter(wrap);
    expect(await screen.findByText(/没带场景图/)).toBeTruthy();
  });

  it("运行中（busy）不拦预览：预览不落库不写后端", () => {
    view({ onUserMessage: () => undefined, busy: true });
    expect((screen.getAllByTestId("plan-preview")[0] as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ScenarioPlansCard", () => {
  it("两案并排：两张 plan-card，名称/意图都进 DOM", () => {
    view({ onUserMessage: () => undefined, busy: false });
    expect(screen.getAllByTestId("plan-card")).toHaveLength(2);
    expect(screen.getByText("登录正路回归")).toBeTruthy();
    expect(screen.getByText("登录异常回归")).toBeTruthy();
    expect(screen.getByText(/覆盖错密码\/锁定策略/)).toBeTruthy();
  });

  it("步骤预览逐行：每个 est_step 一个 li", () => {
    view({ onUserMessage: () => undefined, busy: false });
    const rows = screen.getAllByTestId("step-preview-row").map((el) => el.textContent);
    expect(rows).toContain("打开登录页");
    expect(rows).toContain("断言账号锁定提示");
    expect(rows).toHaveLength(6); // 3+3 逐行，不是拼成一段
  });

  it("风险点渲染", () => {
    view({ onUserMessage: () => undefined, busy: false });
    expect(screen.getByText(/锁定策略各环境不同/)).toBeTruthy();
  });

  it("点[选择]：回调收到含方案名的文本", () => {
    const onUserMessage = vi.fn();
    view({ onUserMessage, busy: false });
    fireEvent.click(screen.getAllByTestId("plan-select")[1]);
    expect(onUserMessage).toHaveBeenCalledTimes(1);
    expect(onUserMessage.mock.calls[0][0]).toContain("登录异常回归");
  });

  it("运行中：[选择] disabled 且有「等本轮结束」文案", () => {
    view({ onUserMessage: () => undefined, busy: true });
    for (const btn of screen.getAllByTestId("plan-select")) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getAllByTestId("card-busy-note").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("等本轮结束").length).toBeGreaterThanOrEqual(1);
  });
});

describe("ScenarioPlansCard · [保存为场景]（D264 接真）", () => {
  it("宿主没接 onSaveScenarioPlan：保存钮不渲染（也不留「二期开放」的假提示）", () => {
    view({ onUserMessage: () => undefined, busy: false });
    expect(screen.queryAllByTestId("plan-save")).toHaveLength(0);
    expect(screen.queryByText(/保存（二期开放）/)).toBeNull();
  });

  it("有宿主 + 有 graph：弹窗改名 → 回调收到 (trim 后名字, graph)，成功后翻「已保存」+ 场景链接", async () => {
    const onSaveScenarioPlan = vi.fn().mockResolvedValue({ id: "sc-1", name: "登录正路回归-改名" });
    view({ onUserMessage: () => undefined, busy: false, onSaveScenarioPlan });
    const btns = screen.getAllByTestId("plan-save");
    expect(btns).toHaveLength(2);
    fireEvent.click(btns[0]);
    const input = await screen.findByTestId("plan-save-name");
    fireEvent.change(input, { target: { value: "  登录正路回归-改名  " } });
    fireEvent.click(screen.getByTestId("plan-save-ok"));
    await waitFor(() => expect(onSaveScenarioPlan).toHaveBeenCalledTimes(1));
    expect(onSaveScenarioPlan).toHaveBeenCalledWith("登录正路回归-改名", { nodes: [], edges: [] });
    expect(await screen.findByTestId("plan-saved")).toBeTruthy();
    expect(screen.getByTestId("plan-saved-open").getAttribute("href")).toBe("#/scene/sc-1");
  });

  it("没带 graph 的方案：保存钮 disabled + Tooltip 说人话（不拿空图落库）", async () => {
    const onSaveScenarioPlan = vi.fn();
    view({ onUserMessage: () => undefined, busy: false, onSaveScenarioPlan });
    const btn = screen.getAllByTestId("plan-save")[1];
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.mouseEnter(btn.closest("span") as Element);
    expect(await screen.findByText(/没带场景图.*不能落库/)).toBeTruthy();
    expect(onSaveScenarioPlan).not.toHaveBeenCalled();
  });

  it("保存回调失败（如 409 同名）：弹窗留在原地，不翻「已保存」", async () => {
    const onSaveScenarioPlan = vi.fn().mockRejectedValue(new Error("conflict"));
    view({ onUserMessage: () => undefined, busy: false, onSaveScenarioPlan });
    fireEvent.click(screen.getAllByTestId("plan-save")[0]);
    fireEvent.click(await screen.findByTestId("plan-save-ok"));
    await waitFor(() => expect(onSaveScenarioPlan).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("plan-saved")).toBeNull();
    expect(screen.getByTestId("plan-save-name")).toBeTruthy(); // 弹窗还开着，能改名重试
  });
});
