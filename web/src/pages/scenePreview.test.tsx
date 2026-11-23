// 候选只读预览页测试（1F T4 / D264）。Canvas 用 vi.mock 换成桩：@xyflow 在 jsdom 里跑不动
// （尺寸观察/ResizeObserver），它的真实渲染归 e2e（T6 pilotCards.spec）——本页要钉的是
// 「坏键 → 人话空态」「好键 → 灌 store + 只读说明条」「保存钮按项目位出/不出 + 真发 POST」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useSceneStore } from "../scene/store";
import { useAuth } from "../auth/store";
import { previewStorageKey } from "../agent/cards/previewLink";

vi.mock("../scene/Canvas", () => ({
  default: () => <div data-testid="canvas-stub" />,
}));

// D264：保存走 sceneApi.create；归属项目 ≠ 当前项目时页面会单拉项目位（client.get）。
const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }));
vi.mock("../api/scene", () => ({ sceneApi: { create: mocks.create } }));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, get: mocks.get };
});

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
  useAuth.setState({ project: null, user: null });
  mocks.create.mockReset();
  mocks.get.mockReset();
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

  it("[保存为场景] 在信封没有 project_id 时不渲染（不猜归属项目）", async () => {
    const key = previewStorageKey("run-42", 0);
    sessionStorage.setItem(key, JSON.stringify({ plan_name: "登录正路回归", graph: GRAPH }));
    await renderAt("/scene-preview?k=" + encodeURIComponent(key));
    expect(await screen.findByTestId("canvas-stub")).toBeTruthy();
    expect(screen.queryByTestId("plan-save")).toBeNull();
  });
});

describe("scenePreview · 保存为场景（D264）", () => {
  const ADMIN = {
    id: "u-1", account: "admin", name: "管理员", email: null,
    is_system_admin: true, status: "ACTIVE",
  };
  const PROJECT = {
    id: "p-1", name: "项目一", description: null, status: "ACTIVE",
    my_role: "PROJECT_ADMIN", my_perms: ["*", "-system:*"],
  };

  function seed(extra: Record<string, unknown> = {}): string {
    const key = previewStorageKey("run-77", 0);
    sessionStorage.setItem(key, JSON.stringify({ plan_name: "登录正路回归", graph: GRAPH, ...extra }));
    return key;
  }

  it("归属 = 当前项目且有 scenario:create：POST /scenarios（剥掉 ref_name）→ 已保存 + 场景链接", async () => {
    useAuth.setState({ project: PROJECT, user: ADMIN });
    mocks.create.mockImplementation(async (b: { name: string }) => ({ id: "sc-9", name: b.name }));
    const graph = {
      ...GRAPH,
      nodes: [{ ...GRAPH.nodes[0], ref_name: "登录接口" }],
    };
    const key = previewStorageKey("run-77", 0);
    sessionStorage.setItem(key, JSON.stringify({ plan_name: "登录正路回归", graph, project_id: "p-1" }));
    await renderAt("/scene-preview?k=" + encodeURIComponent(key));

    fireEvent.click(await screen.findByTestId("plan-save"));
    fireEvent.click(await screen.findByTestId("plan-save-ok"));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const body = mocks.create.mock.calls[0][0] as {
      project_id: string; name: string; step_graph: { nodes: Record<string, unknown>[] };
    };
    expect(body.project_id).toBe("p-1");
    expect(body.name).toBe("登录正路回归");
    // 卡片专用的 ref_name 不进正式场景；其余字段逐字保留
    expect(body.step_graph.nodes[0]).not.toHaveProperty("ref_name");
    expect(body.step_graph.nodes[0].key).toBe("s1");
    expect(await screen.findByTestId("plan-saved")).toBeTruthy();
    expect(screen.getByTestId("plan-saved-open").getAttribute("href")).toBe("#/scene/sc-9");
    // 横幅跟着翻面：不许一边写「尚未保存」一边摆着「已保存」
    expect(screen.getByTestId("preview-banner").textContent).toContain("已保存为正式场景");
    expect(screen.getByTestId("preview-banner").textContent).not.toContain("尚未保存为场景");
  });

  it("当前项目没有 scenario:create（只读角色）：不渲染保存钮", async () => {
    useAuth.setState({
      project: { ...PROJECT, my_role: "READONLY", my_perms: [] },
      user: { ...ADMIN, is_system_admin: false },
    });
    await renderAt("/scene-preview?k=" + encodeURIComponent(seed({ project_id: "p-1" })));
    expect(await screen.findByTestId("canvas-stub")).toBeTruthy();
    expect(screen.queryByTestId("plan-save")).toBeNull();
  });

  it("归属项目 ≠ 当前项目：单拉该项目位，有 scenario:create 才画保存钮", async () => {
    useAuth.setState({ project: { ...PROJECT, id: "p-other" }, user: ADMIN });
    mocks.get.mockResolvedValue({ ...PROJECT, id: "p-2" });
    await renderAt("/scene-preview?k=" + encodeURIComponent(seed({ project_id: "p-2" })));
    expect(await screen.findByTestId("plan-save")).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledWith("/projects/p-2", { silent: true });
  });
});
