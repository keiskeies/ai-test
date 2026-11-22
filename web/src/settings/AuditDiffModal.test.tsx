// AuditDiffModal 独立单测（第五道差集：audit-diff-key 列渲染器零引用）。
// 钉的是「键」列：render (v) => <Typography.Text data-testid="audit-diff-key">{v}</> 必须
// 把本行 dataIndex=key 的值原样画出来，且与同行 before/after 单元格一一对应——
// 列错位（渲染成 r.before / 行序错乱 / 键名丢失）都要在这里红，而不是只在 e2e 里靠肉眼。
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AuditDiffModal from "./AuditDiffModal";

// antd 的响应式观察器要用 matchMedia，jsdom 没有（每个测试文件自己补）
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// 多键 fixture：3 个排序后的顶层键，且 changed 形态各不同——
// alpha 两侧同值（不变）；shared 值不同（变）；only_b 只在 before（变、after 画 —）。
// 键集刻意乱序（z… 在前）：若键列渲染顺序不是 Object.keys 并集排序，文本数组直接对不上。
const MULTI_DIFF = {
  overwrite: "d1",
  before: { zeta: [1, 2], alpha: "same", shared: { n: 1 } },
  after: { alpha: "same", shared: { n: 2 }, only_b: true },
};
// 排序后的顶层键并集（与 diffRows 文档口径一致）——键列文本必须逐字等于这份清单
const WANT_KEYS = ["alpha", "only_b", "shared", "zeta"];

beforeEach(() => cleanup());

describe("键列（audit-diff-key 渲染器）", () => {
  it("多键 fixture：键格文本 = 排序后的键并集，一格一键、逐字对应", () => {
    render(<AuditDiffModal diff={MULTI_DIFF} action="api_import_commit" onClose={() => {}} />);
    const cells = screen.getAllByTestId("audit-diff-key");
    // 行数 = 并集键数：多渲染/漏渲染键（如只渲染 before 侧键）在这条上给出不同数组
    expect(cells).toHaveLength(4);
    expect(cells.map((n) => n.textContent)).toEqual(WANT_KEYS);
  });

  it("键格与同行 before/after 单元格配对：键列画的必须是本行的 key", () => {
    render(<AuditDiffModal diff={MULTI_DIFF} action="api_import_commit" onClose={() => {}} />);
    for (const cell of screen.getAllByTestId("audit-diff-key")) {
      const k = cell.textContent!;
      // 行定位：td → tr；同行应有该键的 before/after 格（它们的 testid 拼的是 r.key）。
      // 若键列 render 错位（画成 r.before 或相邻行的 key），这里配对即断。
      const row = cell.closest("tr")!;
      expect(row).not.toBeNull();
      expect(row.querySelector(`[data-testid="audit-diff-before-${k}"]`)).not.toBeNull();
      expect(row.querySelector(`[data-testid="audit-diff-after-${k}"]`)).not.toBeNull();
    }
  });

  it("changed 形态跟键走：同值键不标色，单侧键缺侧画 —，且都各占一格键名", () => {
    render(<AuditDiffModal diff={MULTI_DIFF} action="api_import_commit" onClose={() => {}} />);
    expect(screen.getByTestId("audit-diff-summary").textContent).toContain("3 个差异键");
    // alpha：两侧同值 → before/after 都无底色，但键名照样在列里
    expect(screen.getByTestId("audit-diff-before-alpha").getAttribute("style") ?? "")
      .not.toContain("background");
    // only_b：只在 after → before 缺侧是 —，键名仍渲染（渲染单侧键时漏掉键格 → getByTestId 即抛）
    expect(screen.getByTestId("audit-diff-before-only_b").textContent).toBe("—");
    expect(screen.getByTestId("audit-diff-after-only_b").getAttribute("style"))
      .toContain("background");
    // zeta：只在 before → after 缺侧 —
    expect(screen.getByTestId("audit-diff-after-zeta").textContent).toBe("—");
    // 行级 changed 标志与键名一一对应（data-changed 由 onRow 按 r.changed 落）：
    // 若 changed 计算被写反/写死，键格所在行的 data-changed 就对不上期望表。
    const expectChanged: Record<string, string> =
      { alpha: "false", only_b: "true", shared: "true", zeta: "true" };
    for (const cell of screen.getAllByTestId("audit-diff-key")) {
      const k = cell.textContent!;
      const row = cell.closest("tr")!;
      expect(row.getAttribute("data-changed")).toBe(expectChanged[k]);
    }
  });

  it("单侧全空（before 缺）→ 键列只剩 after 侧键，且键格全部 changed", () => {
    // 与上一个 fixture 反向：keys 只来自 after。若键列从 diff 杂项（overwrite/name）
    // 取键或把 undefined 侧的键漏掉，这里数组就变。
    render(<AuditDiffModal
      diff={{ name: "创建订单接口", after: { path: "/orders", method: "POST" } }}
      action="api_import_commit" onClose={() => {}} />);
    const cells = screen.getAllByTestId("audit-diff-key");
    expect(cells.map((n) => n.textContent)).toEqual(["method", "path"]);
    expect(screen.getByTestId("audit-diff-summary").textContent).toContain("2 个差异键");
  });

  it("before/after 都缺（无对照物）→ 键列零格、汇总「无差异键」：空表上键列不虚渲染", () => {
    render(<AuditDiffModal diff={{ overwrite: "d1" }} action="env_create" onClose={() => {}} />);
    expect(screen.queryAllByTestId("audit-diff-key")).toHaveLength(0);
    expect(screen.getByTestId("audit-diff-summary").textContent).toContain("无差异键");
  });
});
