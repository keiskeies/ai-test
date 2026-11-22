// 候选只读预览页测试（1F T4）。Canvas 用 vi.mock 换成桩：@xyflow 在 jsdom 里跑不动
// （尺寸观察/ResizeObserver），它的真实渲染归 e2e（T6 pilotCards.spec）——本页要钉的是
// 「坏键 → 人话空态」「好键 → 灌 store + 只读说明条」「保存钮恒 disabled + 二期开放」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useSceneStore } from "../scene/store";
import { previewStorageKey } from "../agent/cards/previewLink";

vi.mock("../scene/Canvas", () => ({
  default: () => <div data-testid="canvas-stub" />,
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

const importPage = () => import("./scenePreview");

const GRAPH = {
  version: 1,
  nodes: [{ key: "s1", kind: "api_case", name: "登录", config: { est_steps: ["打开登录页"] } }],
  layout: { s1: { x: 0, y: 0 } },
};

function renderAt(url: string) {
  // 懒加载在 app.tsx 做；测试直挂默认导出，MemoryRouter 负责喂 ?k=
  return importPage().then(({ default: Page }) =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <Page />
      </MemoryRouter>,
    ));
}

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  useSceneStore.setState({ readOnly: false, nodes: [], layout: {}, baselineNodes: "[]" });
});

describe("scenePreview 坏键空态（不白屏、不抛、各说各的事）", () => {
  it("没有 k 参数 / 键不存在 → 「预览内容不存在」+ 回试验台的指引", async () => {
    await renderAt("/scene-preview");
    expect(await screen.findByTestId("preview-empty")).toBeTruthy();
    expect(screen.getByText("预览内容不存在")).toBeTruthy();
    expect(screen.getByText(/重新点「画布预览」/)).toBeTruthy();
    expect(screen.queryByTestId("canvas-stub")).toBeNull();

    cleanup();
    sessionStorage.clear();
    await renderAt("/scene-preview?k=tp-scene-preview:run-x:0"); // 键不存在 = 过期同态
    expect(await screen.findByText("预览内容不存在")).toBeTruthy();
  });

  it("存的值 JSON 解析失败 → 「预览内容读不出来」", async () => {
    const key = previewStorageKey("run-1", 0);
    sessionStorage.setItem(key, "{不是 JSON");
    await renderAt("/scene-preview?k=" + encodeURIComponent(key));
    expect(await screen.findByText("预览内容读不出来")).toBeTruthy();
    expect(screen.getByTestId("preview-empty")).toBeTruthy();
  });

  it("解析成功但 graph 结构不对（缺 nodes 数组）→ 「不是可画的场景图」", async () => {
    const key = previewStorageKey("run-1", 1);
    sessionStorage.setItem(key, JSON.stringify({ plan_name: "坏图方案", graph: { foo: 1 } }));
    await renderAt("/scene-preview?k=" + encodeURIComponent(key));
    expect(await screen.findByText("预览内容不是可画的场景图")).toBeTruthy();
    expect(screen.getByTestId("preview-empty")).toBeTruthy();
    // 坏图不许灌进画布 store
    expect(useSceneStore.getState().nodes).toEqual([]);
  });
});

describe("scenePreview 正常装载", () => {
  it("好键：graph 进 store（只读）+ 说明条文案 + 方案名 + 渲染画布", async () => {
    const key = previewStorageKey("run-42", 1);
    sessionStorage.setItem(key, JSON.stringify({ plan_name: "登录异常回归", graph: GRAPH }));
    await renderAt("/scene-preview?k=" + encodeURIComponent(key));
    expect(await screen.findByTestId("canvas-stub")).toBeTruthy();
    expect(screen.getByTestId("preview-banner").textContent).toContain("Pilot 候选预览（未落库）");
    expect(screen.getByTestId("preview-banner").textContent).toContain("登录异常回归");
    const s = useSceneStore.getState();
    expect(s.readOnly).toBe(true);
    expect(s.nodes).toEqual(GRAPH.nodes as never);
  });

  it("[保存为正式场景] 只以 disabled + Tooltip「二期开放」存在（§4 :206 / §13 :1604）", async () => {
    const key = previewStorageKey("run-42", 0);
    sessionStorage.setItem(key, JSON.stringify({ plan_name: "登录正路回归", graph: GRAPH }));
    await renderAt("/scene-preview?k=" + encodeURIComponent(key));
    const btn = await screen.findByTestId("preview-save");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.textContent).toContain("保存为正式场景");
    // 一期不开任何可用的保存口子：页面上不许有第二个非 disabled 的「保存」钮
    const liveSave = Array.from(document.querySelectorAll("button"))
      .filter((b) => (b.textContent ?? "").includes("保存") && !b.disabled);
    expect(liveSave).toHaveLength(0);
  });
});
