// DeviceSelect（1g/D168 共用设备选择器）的组件测试。
// 钉的是从 adbCaseDetail :253-283 搬过来时的原样契约（那条既有用例逐字不动地绿是
// 重构证据，本文件补的是共用件自己的边界）：
//   ① 选项渲染 = name（serial）/ 离线加 · 离线 后缀，searchText 让 name 也能搜；
//   ② onChange 收到的是 serial（不是 label/对象）——保存体里 default_device 就是它；
//   ③ 诚实空态两句：placeholder「项目里还没有设备」+ notFoundContent 指路设备管理；
//      有候选时这两句都不许出现（把「有设备没选」说成「没有设备」是反向撒谎）；
//   ④ testId 默认 case-device（adbCaseDetail 契约）、宿主可换 prop-adb-device-serial；
//   ⑤ 库里遗留的未登记 serial 按原值回显（rc-select 无匹配 option 时显示 value 本身）——
//      「设备未登记」橙标的职责在宿主，这里先把值本身显示对。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

import DeviceSelect from "./DeviceSelect";

const DEVICES = [
  { serial: "192.168.1.21:5555", name: "小米13", online: true },
  { serial: "10.0.0.9:5555", name: "中台平板", online: false },
];

function openDropdown(testId: string): void {
  const el = screen.getByTestId(testId);
  const sel = (el.querySelector(".ant-select-selector") ?? el) as HTMLElement;
  fireEvent.mouseDown(sel);
}
function visibleOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll(
    ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")) as HTMLElement[];
}

beforeEach(() => cleanup());

describe("DeviceSelect（画布/调试共用，D168）", () => {
  it("选项渲染：在线只 name（serial），离线补 · 离线；testId 默认 case-device", async () => {
    render(<DeviceSelect devices={DEVICES} value={null} onChange={vi.fn()} />);
    expect(screen.getByTestId("case-device")).toBeTruthy();
    openDropdown("case-device");
    await waitFor(() => expect(visibleOptions()).toHaveLength(2));
    expect(visibleOptions().map((o) => o.textContent))
      .toEqual(["小米13（192.168.1.21:5555）", "中台平板（10.0.0.9:5555 · 离线）"]);
  });

  it("选中回传 serial 本体（保存体 default_device/device_serial 吃的就是它）", async () => {
    const onChange = vi.fn();
    render(<DeviceSelect devices={DEVICES} value={null} onChange={onChange} />);
    openDropdown("case-device");
    await waitFor(() => expect(visibleOptions()).toHaveLength(2));
    fireEvent.click(visibleOptions().find((o) => o.textContent?.includes("小米13"))!);
    expect(onChange).toHaveBeenCalledWith("192.168.1.21:5555");
  });

  it("testId 可换（画布传 prop-adb-device-serial，既有宿主测试按这个 testid 找控件）", () => {
    render(<DeviceSelect testId="prop-adb-device-serial" devices={DEVICES}
      value="192.168.1.21:5555" onChange={vi.fn()} />);
    expect(screen.getByTestId("prop-adb-device-serial")).toBeTruthy();
    expect(screen.queryByTestId("case-device")).toBeNull();
    // 选中值回显在选中区
    expect(screen.getByTestId("prop-adb-device-serial").textContent).toContain("小米13");
  });

  it("诚实空态：空列表 = placeholder「项目里还没有设备」+ notFoundContent 指路设备管理", () => {
    render(<DeviceSelect devices={[]} value={null} onChange={vi.fn()} />);
    const root = screen.getByTestId("case-device");
    expect((root.querySelector(".ant-select-selection-placeholder") as HTMLElement).textContent)
      .toBe("项目里还没有设备");
    openDropdown("case-device");
    const empty = document.querySelector(
      ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-empty-description, .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-empty");
    expect(empty?.textContent).toBe("设备管理里先添加（会真的 adb connect 验证）");
  });

  it("有候选时不许出现空态话术（把「没选」说成「没有」＝反向撒谎）；placeholder 可覆写", async () => {
    render(<DeviceSelect devices={DEVICES} value={null} onChange={vi.fn()} placeholder="挑一台跑这个 case" />);
    const root = screen.getByTestId("case-device");
    expect(root.textContent).not.toContain("项目里还没有设备");
    expect((root.querySelector(".ant-select-selection-placeholder") as HTMLElement).textContent)
      .toBe("挑一台跑这个 case");
    openDropdown("case-device");
    await waitFor(() => expect(visibleOptions()).toHaveLength(2));
    const dropdownText = document.querySelector(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")!.textContent ?? "";
    expect(dropdownText).not.toContain("设备管理里先添加");
  });

  it("未登记 serial 原值回显：值不在清单也不清空不吞掉（「设备未登记」标归宿主画）", () => {
    render(<DeviceSelect devices={DEVICES} value="172.16.0.5:5555" onChange={vi.fn()} />);
    expect(screen.getByTestId("case-device").textContent).toContain("172.16.0.5:5555");
  });

  it("disabled 透传（只读成员整排禁编辑的口径由宿主传位）", () => {
    render(<DeviceSelect devices={DEVICES} value={null} onChange={vi.fn()} disabled />);
    expect(screen.getByTestId("case-device").className).toContain("ant-select-disabled");
  });
});
