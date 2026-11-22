// D78：场景侧断言编辑器（AssertionListEditor，步骤断言与公共断言共用，R85）的组件测试。
// 整板 PropsPanel 渲染要拖 store/auth/router/定时接口，这里直接钉共用控件本体：
// 类型表来自 req.ts（不查第二份）、正则行有可选 path、启用开关落 enabled、上移/下移改顺序。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

// R49/D174：脚本断言正文换成懒加载 CodeEditor（monaco）。桩法与 PropsPanel.test.tsx:51、
// adb/StepParams.test.tsx:10 同源；转发 readOnly→disabled 让只读断言仍打在桩上。
vi.mock("../components/CodeEditor", () => ({
  default: (props: { value?: string; onChange?: (v: string) => void; readOnly?: boolean }) => (
    <textarea data-testid="code-editor-stub" value={props.value ?? ""} disabled={props.readOnly}
      onChange={(e) => props.onChange?.(e.target.value)} />
  ),
}));

import { AssertionListEditor } from "./PropsPanel";

beforeEach(() => cleanup());

function openTypeSelect(prefix: string, i: number): void {
  const sel = screen.getByTestId(prefix + "-" + i).querySelector(".ant-select-selector")!;
  fireEvent.mouseDown(sel);
}

/** R49/D174：字段 testid 包在外层 div，编辑面是其内的 CodeEditor（桩）。
 *  退回裸 TextArea 时内层找不到编辑器 → 必红。 */
async function editorIn(fieldTestId: string): Promise<HTMLElement> {
  return within(screen.getByTestId(fieldTestId)).findByTestId("code-editor-stub");
}

describe("AssertionListEditor（步骤/公共断言共用，D78）", () => {
  it("类型下拉的选项 == req.ts 的 ASSERT_TYPES 全集（含正则；不查第二份表）", () => {
    render(<AssertionListEditor items={[{ type: "status_code", expected: 200 }]}
      prefix="t-assert" addLabel="加断言" onChange={() => {}} />);
    openTypeSelect("t-assert", 0);
    const labels = Array.from(document.querySelectorAll(".ant-select-item-option-content"))
      .map((n) => n.textContent);
    for (const want of ["正则", "脚本断言", "状态码"]) {
      expect(labels, "下拉少了 " + want).toContain(want);
    }
  });

  it("正则行：出现可选 JSONPath 框，path/expected 经 onChange 落值", () => {
    const onChange = vi.fn();
    render(<AssertionListEditor items={[{ type: "regex", expected: "" }]}
      prefix="t-assert" addLabel="加断言" onChange={onChange} />);
    expect(screen.getByTestId("t-assert-path-0")).toBeTruthy();
    fireEvent.change(screen.getByTestId("t-assert-path-0"), { target: { value: "$.data.token" } });
    expect(onChange.mock.calls.at(-1)![0][0]).toMatchObject({ type: "regex", path: "$.data.token" });
  });

  it("启用开关：缺省显示启用（老数据），关掉落 enabled:false", () => {
    const onChange = vi.fn();
    render(<AssertionListEditor items={[{ type: "status_code", expected: 200 }]}
      prefix="t-assert" addLabel="加断言" onChange={onChange} />);
    const sw = screen.getByTestId("t-assert-enabled-0").closest(".ant-switch")!;
    expect(sw.className).toContain("ant-switch-checked");
    fireEvent.click(sw);
    expect(onChange.mock.calls.at(-1)![0][0]).toMatchObject({ enabled: false });
  });

  it("脚本断言行：正文进 CodeEditor 并落 code（表里有这个类型却不给输入框＝选了填不上）", async () => {
    const onChange = vi.fn();
    render(<AssertionListEditor items={[{ type: "script", code: "seed 1" }]}
      prefix="t-assert" addLabel="加断言" onChange={onChange} />);
    expect(screen.queryByPlaceholderText("预期值")).toBeNull(); // script 不吃 expected
    const ed = await editorIn("t-assert-code-0") as HTMLTextAreaElement;
    expect(ed.value).toBe("seed 1"); // 初值经 CodeEditor 的 value 绑定渲染
    fireEvent.change(ed, { target: { value: "assert 1" } });
    expect(onChange.mock.calls.at(-1)![0][0]).toMatchObject({ type: "script", code: "assert 1" });
    // 单条沙箱时限（§8.5）：留空走后端默认，填了就落 timeout_ms
    // antd InputNumber 的 data-* 落点是版本实现细节：可能拿到 wrapper，也可能就是 input
    const node = screen.getByTestId("t-assert-timeout-0");
    const input = node.tagName === "INPUT" ? node : node.querySelector("input")!;
    fireEvent.change(input, { target: { value: "3000" } });
    expect(onChange.mock.calls.at(-1)![0][0]).toMatchObject({ timeout_ms: 3000 });
  });

  it("R49 只读门：ro 透传 CodeEditor（公共断言/步骤断言共用同一套，门也只写一份）", async () => {
    render(<AssertionListEditor items={[{ type: "script", code: "assert 1" }]}
      prefix="t-assert" addLabel="加断言" ro onChange={vi.fn()} />);
    const ed = await editorIn("t-assert-code-0") as HTMLTextAreaElement;
    expect(ed.value).toBe("assert 1");
    expect(ed.disabled).toBe(true);
  });

  it("切类型清载荷：script→状态码 时 code 归零，不跟着 status_code 存进断言数组", () => {
    const onChange = vi.fn();
    render(<AssertionListEditor items={[{ type: "script", code: "assert 1", timeout_ms: 3000 }]}
      prefix="t-assert" addLabel="加断言" onChange={onChange} />);
    openTypeSelect("t-assert", 0);
    const opt = Array.from(document.querySelectorAll(".ant-select-item-option"))
      .find((o) => (o.textContent ?? "").includes("状态码"))!;
    fireEvent.click(opt);
    const row = onChange.mock.calls.at(-1)![0][0] as Record<string, unknown>;
    expect(row).toMatchObject({ type: "status_code" });
    expect(row.code ?? null).toBeNull();
    expect(row.timeout_ms ?? null).toBeNull();
    expect(row.enabled, "enabled 是行级属性，切类型不该动它").toBeUndefined();
  });

  it("上移/下移：onChange 收到交换后的数组；边界禁用", () => {
    const onChange = vi.fn();
    render(<AssertionListEditor items={[
      { type: "status_code", expected: 200 },
      { type: "body_contains", expected: "a" },
    ]} prefix="t-assert" addLabel="加断言" onChange={onChange} />);
    const btn = (id: string) => (screen.getByTestId(id).closest("button") ?? screen.getByTestId(id)) as HTMLButtonElement;
    expect(btn("t-assert-up-0").disabled).toBe(true);
    expect(btn("t-assert-down-1").disabled).toBe(true);
    fireEvent.click(btn("t-assert-up-1"));
    expect(onChange.mock.calls.at(-1)![0].map((x: { type: string }) => x.type))
      .toEqual(["body_contains", "status_code"]);
  });
});
