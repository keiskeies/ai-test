// IssuePanel（§11.4.9「校验错=节点角标+底部问题面板定位」）的组件测试。此前覆盖零：
// 它的 4 个 data-testid（scene-issue-panel / save-refused / issue-empty / issue-row-*）
// 没有任何 vitest 或 e2e 文件引用过。钉的都是面板对 store 的「投影 + 一条写回路」：
//   ① 空态文案独占（无 Table、无拒绝横幅）；refused=true 时横幅出现，且与空态可共存
//      （「预检拒了但面板列不出行」是 save() 只置 refused 不复制本地 issue 的真实形状）；
//   ② 行的数据源 = mergeIssues(nodes, serverIssues) 并集，顺序 local 在前 server 在后，
//      node_key|code|message 同键去重只留一条（store.dedupeIssues 的口径经面板可见）；
//      store 推新 serverIssues → 面板实时长出新行；全程零网络（面板不自己取数）；
//   ③ 行渲染三件套：error 角标 + issue-row-<code> testid + 「node_key 代码体 + 人话」；
//      空 key 的行显示「(无 key)」（bad_node 走 store 里 push(v, "") 的真实来路）；
//   ④ [定位] = 真实 select(node_key)：selectedKey 挪过去（画布角标/属性面板随之跟——
//      那是它们各自的测试）。空 key 行的 [定位] 必须 disabled，点下去选中不动。
// 【面板没有滚动/视口动作】：IssuePanel 的「定位」只写 selectedKey，不 scrollIntoView——
// 别处若假设点面板会把画布平移过去，那是假预期。
// 【分支可达性说明】(无 key)+disabled 分支不是死码：validateLocal 对非对象步骤
// push(v, "", "bad_node", …)，seed 一个非对象步骤即可真实到达，故正常钉。
// jsdom 垫片收在本文件内（Canvas.test.tsx 头注释同款理由：仓库刻意不建共享 setup）：
//   matchMedia——antd 响应式断点用，jsdom 没实现（Table/Badge 链路上同样要）。
// 【不证明】：rc-table 虚拟滚动/键盘导航/a11y 表格语义；「点击后画布红角标与属性面板
// 同时跟上」的跨组件联动（Canvas.test.tsx 与 PropsPanel 测试各自的地盘）；行排序稳定性
// 之外的 Table 内部行为。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfigProvider } from "antd";

// —— jsdom 垫片（理由见文件头，Canvas.test.tsx 同款）——
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import IssuePanel from "./IssuePanel";
import type { Issue } from "./graphOps";
import { useSceneStore } from "./store";
import type { StepNode } from "./stepTypes";

/** 干净树：一切断言都以它为「无 issue」底色，往里加坏步骤才出行。 */
function cleanTree(): StepNode[] {
  return [{ key: "n1", kind: "sleep", name: "等待", config: { ms: 100 } }];
}

function seed(over: Record<string, unknown> = {}): void {
  useSceneStore.setState({
    loading: false, projectId: "p1", scenarioId: "s1",
    nodes: cleanTree(), serverIssues: [], refused: false,
    selectedKey: null, selectedKeys: [],
    ...over,
  } as never);
}

function renderPanel(over: Record<string, unknown> = {}): void {
  seed(over);
  // motion:false 同 Canvas/ListMode：rc-motion 在 jsdom 里不完成 leave 动画
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <IssuePanel />
    </ConfigProvider>,
  );
}

const serverIssue = (over: Partial<Issue> = {}): Issue =>
  ({ node_key: "n1", code: "srv_code", message: "服务器口径的问题", path: "$.nodes[0]", ...over });

const rowTestids = () => Array.from(document.querySelectorAll<HTMLElement>("[data-testid^='issue-row-']"))
  .map((el) => el.getAttribute("data-testid")!);

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({}),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("IssuePanel（§11.4.9 底部问题面板，真 store + 真 mergeIssues）", () => {
  it("无 issue 且未拒绝：只有空态文案，没有表格也没有拒绝横幅；零网络", () => {
    renderPanel();
    expect(screen.getByTestId("scene-issue-panel")).toBeTruthy();
    expect(screen.getByTestId("issue-empty").textContent).toContain("没有校验问题");
    expect(document.querySelector(".ant-table")).toBeNull();
    expect(screen.queryByTestId("save-refused")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refused 横幅：有 issue 时出现在表格上方；空态时与空态共存（预检拒了但没行列出）", () => {
    // 有 issue：面板 = 横幅 + 表格（break 出循环是 validateLocal 的看家行）
    renderPanel({
      refused: true,
      nodes: [
        ...cleanTree(),
        { key: "n9", kind: "break", name: "跳出" } as unknown as StepNode,
      ],
    });
    expect(screen.getByTestId("save-refused").textContent)
      .toContain("保存被拒绝：先解决下面的问题");
    expect(screen.getByTestId("issue-row-break_outside_loop")).toBeTruthy();
    expect(screen.queryByTestId("issue-empty")).toBeNull();
    // 横幅在表格之前（「先解决下面的问题」的指代顺序）
    const panel = screen.getByTestId("scene-issue-panel");
    const refusedEl = screen.getByTestId("save-refused");
    const tableEl = panel.querySelector(".ant-table")!;
    expect(refusedEl.compareDocumentPosition(tableEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 干净树 + refused（本地预检拒但面板列不出行——save() 只置 refused 不复制 issue）：
    // 横幅与空态文案共存，谁也不吞谁
    cleanup();
    renderPanel({ refused: true });
    expect(screen.getByTestId("save-refused")).toBeTruthy();
    expect(screen.getByTestId("issue-empty")).toBeTruthy();
    // refused=false 的对照：横幅消失
    cleanup();
    renderPanel({ refused: false });
    expect(screen.queryByTestId("save-refused")).toBeNull();
  });

  it("并集口径：local 在前 server 在后；node_key|code|message 同键去重只留一条；store 推进实时长行", () => {
    const local = { node_key: "n9", code: "break_outside_loop",
      message: "break 只能出现在 loop / foreach 内部，否则执行时没有任何循环可以跳出",
      path: "$.nodes[1]" };
    renderPanel({
      nodes: [
        ...cleanTree(),
        { key: "n9", kind: "break", name: "跳出" } as unknown as StepNode,
      ],
      // 第一条与 local 行逐字同键（node_key|code|message）→ 去重；第二条是新行
      serverIssues: [serverIssue(local), serverIssue({ code: "srv_only", message: "只有服务器知道" })],
    });
    // 去重后共 2 行：local 的 break 行在前（dedupeIssues 以 local 为主序），server 独有在后
    expect(rowTestids()).toEqual(["issue-row-break_outside_loop", "issue-row-srv_only"]);
    expect(screen.getByTestId("issue-row-srv_only").textContent).toContain("只有服务器知道");
    // 画布红角标同款「修好就消失」：store 换掉 serverIssues → 面板实时只剩新行
    act(() => {
      useSceneStore.setState({ serverIssues: [serverIssue({ code: "fresh_code", message: "新推的问题" })] });
    });
    expect(rowTestids()).toEqual(["issue-row-break_outside_loop", "issue-row-fresh_code"]);
    expect(global.fetch).not.toHaveBeenCalled(); // 面板纯投影，不自己取数
  });

  it("行渲染三件套：error 角标 + issue-row-<code> + key 代码体与人话；空 key 行显示 (无 key)", () => {
    renderPanel({
      nodes: [
        { key: "n1", kind: "sleep", name: "等待" } as unknown as StepNode, // 缺 config.ms
        null as unknown as StepNode, // 非对象步骤 → validateLocal 真产 node_key="" 的 bad_node
      ],
    });
    const missing = screen.getByTestId("issue-row-missing_config");
    expect(missing.textContent).toContain("n1"); // key 以代码体出现
    expect(missing.querySelector("code")!.textContent).toBe("n1");
    expect(missing.textContent).toContain("sleep 缺少必填配置 config.ms（正整数毫秒）");
    const badNode = screen.getByTestId("issue-row-bad_node");
    expect(badNode.textContent).toContain("(无 key)");
    expect(badNode.textContent).toContain("步骤必须是 JSON 对象");
    // 每行一个 error 角标（sev 列的 Badge status="error"）
    expect(document.querySelectorAll(".ant-badge-status-error")).toHaveLength(2);
  });

  it("[定位]=真实 select(node_key)：selectedKey 挪过去；空 key 行的钮 disabled 且点不动选中", () => {
    renderPanel({
      nodes: [
        { key: "n9", kind: "break", name: "跳出" } as unknown as StepNode,
        null as unknown as StepNode,
      ],
    });
    const locate = (testid: string) =>
      Array.from(screen.getByTestId(testid).closest("tr")!.querySelectorAll("button"))
        // antd 对两字中文按钮会插空格（TwoCNChar）→ 去空白再认文案
        .find((b) => (b.textContent ?? "").replace(/\s+/g, "") === "定位") as HTMLButtonElement;

    const btnOk = locate("issue-row-break_outside_loop");
    expect(btnOk.disabled, "有 node_key 的行 [定位] 必须可点").toBe(false);
    fireEvent.click(btnOk);
    expect(useSceneStore.getState().selectedKey, "[定位] 必须真实 select(r.node_key)")
      .toBe("n9"); // 画布/属性面板由此跟上（各自测试的地盘）

    const btnBad = locate("issue-row-bad_node");
    expect(btnBad.disabled, "空 node_key 的行 [定位] 必须 disabled").toBe(true); // 空 key 没得定位——不许渲染成可点
    fireEvent.click(btnBad); // disabled 钮上的点击是 no-op
    expect(useSceneStore.getState().selectedKey).toBe("n9"); // 选中纹丝不动
  });
});
