// 1D T9：ADB 步骤参数表单（CFG_SCHEMA 生成控件）的组件测试。
// 这张表的钉点是「表单与参数表同源」——ui 侧同类表单靠 e2e 钉（uiCase.spec），这里用
// jsdom 组件级钉更快也更狠：每个 kind 出一个对的控件、必填有星号、切类型清空 config
// （带脏值装新命令就是假合法）、optional 对操作类锁死（和保存期 optional_on_action 同
// 一条规则，界面先说、后端兜底）。Monaco 只服务 shell 的 cmd：懒加载件 mock 成占位，
// canvas 级渲染留给 e2e（workbench.test.tsx 对趋势图的同款分工）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../components/CodeEditor", () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea data-testid="mock-monaco" value={value}
      onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

import StepParams from "./StepParams";
import { CFG_SCHEMA, newStep, type AdbStep } from "./commands";

beforeEach(() => cleanup());

function renderStep(step: AdbStep, on?: (s: AdbStep) => void) {
  const onChange = on ?? vi.fn();
  render(<StepParams step={step} testIdPrefix="p" onChange={onChange} />);
  return onChange as ReturnType<typeof vi.fn>;
}

describe("kind → 控件（表单由 CFG_SCHEMA 生成，不是手写分支）", () => {
  it("每个 kind 在对应类型里渲染出该 kind 的控件形态", () => {
    // antd InputNumber 把多余 DOM 属性落在**内层 input** 上，包壳要 closest 找（实测）
    renderStep({ ...newStep("click_xy"), id: "a1" });
    expect(screen.getByTestId("p-x").closest(".ant-input-number")).toBeTruthy();
    cleanup();
    // bool：开关
    renderStep({ ...newStep("install"), id: "a1" });
    expect(document.querySelector('[data-testid="p-reinstall"].ant-switch')).toBeTruthy();
    cleanup();
    // enum：下拉
    renderStep({ ...newStep("assert_text"), id: "a1" });
    expect(screen.getByTestId("p-mode").closest(".ant-select")).toBeTruthy();
    cleanup();
    // text：单行输入，必填有星号
    renderStep({ ...newStep("input_text"), id: "a1" });
    expect(screen.getByTestId("p-text").tagName).toBe("INPUT");
    expect(document.body.textContent).toContain("*"); // !text 的必填星号
  });

  it("shell 的 cmd 走 Monaco（懒加载 mock），不是普通单行框", async () => {
    renderStep({ ...newStep("shell"), id: "a1" });
    expect(screen.getByTestId("p-cmd")).toBeTruthy();
    // 懒加载的 dynamic import 要等一拍：兜底文案先出，mock 组件到位才算真挂上
    expect(await screen.findByTestId("mock-monaco")).toBeTruthy();
  });

  it("无参类型（back/home）没有参数控件，只有一句人话", () => {
    renderStep({ ...newStep("back"), id: "a1" });
    expect(document.body.textContent).toContain("没有参数");
  });
});

describe("改参数的回传形状（updateAt 的 config 深一层合并的对端）", () => {
  it("文本键：输入回传 config 合并，其余键原样带着", () => {
    const step: AdbStep = { id: "a1", type: "assert_text",
      config: { text: "旧", timeout_ms: 1000 }, device: "auto" };
    const onChange = renderStep(step);
    fireEvent.change(screen.getByTestId("p-text"), { target: { value: "登录成功" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({
      id: "a1", type: "assert_text", config: { text: "登录成功", timeout_ms: 1000 },
    });
  });

  it("清空文本 = 删键，不是空串装填过（required 校验要看得见没填）", () => {
    const step: AdbStep = { id: "a1", type: "input_text", config: { text: "abc" } };
    const onChange = renderStep(step);
    fireEvent.change(screen.getByTestId("p-text"), { target: { value: "" } });
    expect("text" in onChange.mock.calls[0][0].config).toBe(false);
  });

  it("数字键：输入提交数字（change+blur 才是 antd InputNumber 的提交时机），清空删键", () => {
    const step: AdbStep = { id: "a1", type: "sleep", config: { ms: 500 } };
    const onChange = renderStep(step);
    const input = screen.getByTestId("p-ms"); // antd 把 testid 落在内层 <input>
    fireEvent.change(input, { target: { value: "800" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)![0].config.ms).toBe(800);
    cleanup();
    const onChange2 = renderStep({ id: "a1", type: "sleep", config: { ms: 500 } });
    fireEvent.change(screen.getByTestId("p-ms"), { target: { value: "" } });
    fireEvent.blur(screen.getByTestId("p-ms"));
    expect("ms" in onChange2.mock.calls.at(-1)![0].config).toBe(false);
  });
});

describe("切类型 = 换一套字段（绝不带旧 config 装新命令）", () => {
  it("从 assert_text 换到 back：config 整个换成新类型的空壳", async () => {
    const step: AdbStep = { id: "a1", type: "assert_text",
      config: { text: "脏值", timeout_ms: 999 }, optional: true };
    const onChange = renderStep(step);
    // 点开下拉。26 个选项是虚拟列表：不在视口的选项不在 DOM 里（uiCase.spec ⑤ 同款
    // 取证），所以按搜索过滤到「返回」再点——和 e2e 教用户做的方式一模一样。
    const typeSel = screen.getByTestId("p-type");
    fireEvent.mouseDown(typeSel.closest(".ant-select")!.querySelector(".ant-select-selector")!);
    fireEvent.change(typeSel.closest(".ant-select")!.querySelector("input")!,
      { target: { value: "返回" } });
    const opt = await screen.findByText("返回键", { selector: ".ant-select-item-option-content" });
    fireEvent.click(opt);
    const next = onChange.mock.calls.at(-1)![0];
    expect(next.type).toBe("back");
    expect(next.config).toEqual({});
    expect(next.config).toEqual(newStep("back").config); // 空壳与 newStep 同源（emptyConfig）
  });
});

describe("optional 开关与校验表同规（界面先说、后端兜底）", () => {
  it("操作类步骤（click_xy）的 optional 锁死，且原因写在控件旁边（不是藏在 hover 里）", () => {
    renderStep({ ...newStep("click_xy"), id: "a1" });
    const sw = document.querySelector('[data-testid="p-optional"]')!;
    expect(sw.className).toContain("ant-switch-disabled");
    // 禁用了却说不出为什么 = 和乱猜禁用了什么同量级的坑（CommandParams 对 BLOCKED 的先例）
    expect(screen.getByTestId("p-optional-why").textContent).toContain("对着空气操作");
  });

  it("断言类（assert_text）可开可关，开了回传 optional=true", () => {
    const onChange = renderStep({ ...newStep("assert_text"), id: "a1" });
    fireEvent.click(screen.getByTestId("p-optional"));
    expect(onChange.mock.calls[0][0].optional).toBe(true);
  });

  it("每行都带 device / pre_wait_ms / 行摘要三件套（§7.3 步骤对象顶层字段）", () => {
    const step: AdbStep = { id: "a1", type: "connect", config: { addr: "10.0.0.2:5555" } };
    renderStep(step);
    expect((screen.getByTestId("p-device") as HTMLInputElement).value).toBe("auto");
    expect(screen.getByTestId("p-summary").textContent).toContain("连接设备 10.0.0.2:5555");
  });

  it("表内每个必填键都有对应的 data-testid 控件（表单覆盖参数表，缺一键就红）", () => {
    // 逐类型挂载，逐个必填键找控件——CFG_SCHEMA 加键不写控件渲染，这里当场红
    for (const [t, schema] of Object.entries(CFG_SCHEMA)) {
      const host = render(<StepParams step={{ ...newStep(t), id: "a1" }} testIdPrefix="q"
        onChange={() => {}} />);
      for (const spec of Object.keys(schema)) {
        const key = spec.replace(/^!/, "");
        if (t === "shell" && key === "cmd") continue; // shell 走 Monaco 容器（已单独钉）
        expect(host.container.querySelector('[data-testid="q-' + key + '"]'),
          t + "." + key + " 没有控件").toBeTruthy();
      }
      cleanup();
    }
  });
});
