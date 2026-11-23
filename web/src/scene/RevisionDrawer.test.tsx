// D262 变更历史抽屉：只钉三件真事——①成功腿把后端的变更摘要如实摊开（含步骤数/变量
// 键名的降级格式）②空态与失败态分开说（空 = 真没改过；失败 = 没取到，可重试）③错误
// 文案来自 Error.message，不是自己编一句。antd Drawer 渲染到 body，用 screen 查询即可。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfigProvider } from "antd";
import RevisionDrawer from "./RevisionDrawer";
import type { ScenarioRevisionRow } from "../api/scene";

// antd List 的响应式 observer 要 matchMedia（jsdom 没有）；形状与 SceneEditor.test 同款。
const mm = (q: string) => ({ matches: false, media: q, onchange: null, addListener: () => {},
  removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: () => false });
Object.defineProperty(window, "matchMedia", { writable: true, value: mm });

const h = vi.hoisted(() => ({ revisions: vi.fn() }));
vi.mock("../api/scene", async (orig) => {
  const mod = await orig<typeof import("../api/scene")>();
  return { ...mod, sceneApi: { ...mod.sceneApi, revisions: h.revisions } };
});

const ROW: ScenarioRevisionRow = {
  id: "r1", scenario_id: "s1", version: 3, actor_id: "u1", actor_name: "张三",
  changed: [
    { field: "name", before: "旧名", after: "新名" },
    { field: "step_graph", before: { step_count: 1 }, after: { step_count: 3 } },
    { field: "variables", before: { keys: [] }, after: { keys: ["base", "token"] } },
  ],
  created_at: "2026-11-24T03:04:05+00:00",
};
const QUIET: ScenarioRevisionRow = {
  ...ROW, id: "r2", version: 2, actor_name: "李四", changed: [],
};

const page = (items: ScenarioRevisionRow[]) => ({ items, next_cursor: null });
const mount = () => render(
  <ConfigProvider theme={{ token: { motion: false } }}>
    <RevisionDrawer open onClose={() => undefined} projectId="p1" scenarioId="s1" />
  </ConfigProvider>,
);

beforeEach(() => { h.revisions.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("RevisionDrawer", () => {
  it("成功腿：版本/操作人/字段前后值（步骤数与变量键名按摘要格式展示）", async () => {
    h.revisions.mockResolvedValue(page([ROW, QUIET]));
    mount();
    expect(await screen.findByText("v3")).toBeTruthy();
    expect(screen.getByText("张三")).toBeTruthy();
    // 字段标签 + before/after 都在（名称、步骤数、变量键名）
    expect(screen.getByText("名称")).toBeTruthy();
    expect(screen.getByText("旧名")).toBeTruthy();
    expect(screen.getByText("新名")).toBeTruthy();
    expect(screen.getByText("1 步")).toBeTruthy();
    expect(screen.getByText("3 步")).toBeTruthy();
    expect(screen.getByText("base、token")).toBeTruthy();
    // changed=[] 的行如实说「只推进了版本」，不伪造一条变更
    expect(screen.getByText("本次保存只推进了版本，没有字段变化")).toBeTruthy();
  });

  it("空态文案是「还没改过」，不是「加载失败」", async () => {
    h.revisions.mockResolvedValue(page([]));
    mount();
    expect(await screen.findByText("还没有变更记录——场景创建后没有保存过修改")).toBeTruthy();
    expect(screen.queryByTestId("scene-revisions-failed")).toBeNull();
  });

  it("失败腿：显示后端/网络的 Error.message，重试成功后换成列表", async () => {
    h.revisions.mockRejectedValueOnce(new Error("网络断了")).mockResolvedValueOnce(page([ROW]));
    mount();
    expect(await screen.findByText("网络断了")).toBeTruthy();
    fireEvent.click(screen.getByTestId("scene-revisions-retry"));
    expect(await screen.findByText("v3")).toBeTruthy();
    expect(screen.queryByText("网络断了")).toBeNull();
  });
});
