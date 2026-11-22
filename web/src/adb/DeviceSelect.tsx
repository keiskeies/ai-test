// 设备选择器（1g/D168：蓝图 :1392「画布/调试共用设备选择器」的落地）。
// 形状 = adbCaseDetail 那份 Select 的逐字搬移——选项 label（name（serial · 离线））、
// showSearch、诚实空态两句文案原样保留，宿主切到本组件时既有测试契约不变。
// 候选由宿主加载后传入：设备清单「没取到 vs 还没有」的门归宿主守（本组件只负责说）。
// 为什么只有登记过的 serial、不给自由输入：执行链 _step_device 只认 any_idle/specified
// 两词（backend/app/modules/adb_test/debug_services.py:146），specified 的 serial 在
// resolve 期按项目可用设备清单逐字匹配（debug_services.py:198-204），不在清单 =
// 「这一步没有设备可跑」。自由文本只有「存得下、跑不了」一条路（graph.py:118 只非空
// 即可）——下拉不假装拥有这种能力；库里遗留的未登记 serial 仍按原值显示（rc-select
// 无匹配 option 时回显 value），「设备未登记」橙标的职责在宿主。
import type { CSSProperties } from "react";
import { Select } from "antd";

export interface DeviceOption {
  serial: string;
  name: string;
  online: boolean;
}

export default function DeviceSelect(props: {
  devices: DeviceOption[];
  value: string | null;
  onChange: (serial: string) => void;
  placeholder?: string;
  /** adbCaseDetail 既有契约默认 case-device；画布宿主传 prop-adb-device-serial。 */
  testId?: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const { devices, value, onChange, placeholder, testId = "case-device", disabled, style } = props;
  const options = devices.map((d) => ({
    value: d.serial,
    label: d.name + "（" + d.serial + (d.online ? "" : " · 离线") + "）",
    searchText: d.name + " " + d.serial,
  }));
  return (
    <Select data-testid={testId} showSearch optionFilterProp="searchText"
      style={{ minWidth: 220, ...style }} disabled={disabled}
      value={value ?? undefined} options={options}
      placeholder={placeholder ?? (devices.length ? "选择设备" : "项目里还没有设备")}
      onChange={(v: string) => onChange(v)}
      notFoundContent={devices.length ? undefined : "设备管理里先添加（会真的 adb connect 验证）"} />
  );
}
