// §11.5.2 趋势图单测：**钉 option 对象与生命周期，不钉像素**——jsdom 里 canvas 根本不画，
// 组件的全部契约就是递给 chart.setOption 的那个对象 + init/dispose/resize 的收发。
// 手法：把 echarts 四个入口（core/charts/components/renderers）整体 mock 在模块边界上，
// 记录 setOption 实参与 LinearGradient 构造实参。颜色一律对 ../theme 的 tp 断言而非硬编码
// hex：主题改了这里跟着动，「theme.ts 唯一真相」（§11.6）才不会被图里一份私抄悄悄架空。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const h = vi.hoisted(() => {
  const setOption = vi.fn(); const resize = vi.fn(); const dispose = vi.fn();
  const chart = { setOption, resize, dispose };
  const init = vi.fn(() => chart);
  const use = vi.fn();
  const gradients: Array<{ args: unknown[] }> = [];
  class LinearGradient {
    args: unknown[];
    constructor(...args: unknown[]) { this.args = args; gradients.push(this); }
  }
  return { setOption, resize, dispose, chart, init, use, gradients, LinearGradient };
});

vi.mock("echarts/core", () => ({ use: h.use, init: h.init, graphic: { LinearGradient: h.LinearGradient } }));
vi.mock("echarts/charts", () => ({ LineChart: { __stub: "LineChart" } }));
vi.mock("echarts/components", () => ({ GridComponent: { __stub: "Grid" }, TooltipComponent: { __stub: "Tooltip" } }));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: { __stub: "CanvasRenderer" } }));

import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import WorkbenchTrend from "./workbenchTrend";
import type { TrendPoint } from "./workbenchTrend";
import { tp } from "../theme";

const PTS: TrendPoint[] = [
  { date: "2026-11-10", runs: 3, pass_rate: 0.6667 }, // 四舍五入一位小数的样本
  { date: "2026-11-11", runs: 0, pass_rate: null },   // 当日无运行 → 断点
  { date: "2026-11-12", runs: 2, pass_rate: 0.5 },
  { date: "2026-11-13", runs: 1, pass_rate: 1 },
];
const PTS2: TrendPoint[] = [{ date: "2026-12-01", runs: 1, pass_rate: 0.25 }];
// 后端 DailyPoint 对 pass_rate=null 给了两个原因：当日无运行 / 当日有运行但分母为 0
//（全 skip）。这条 fixture 把两种 null 并排放，tooltip 措辞必须分得开。
const PTS_NULL: TrendPoint[] = [
  { date: "2026-12-01", runs: 0, pass_rate: null },
  { date: "2026-12-02", runs: 5, pass_rate: null },
  { date: "2026-12-03", runs: 4, pass_rate: 0.75 },
];

beforeEach(() => {
  cleanup();
  for (const f of [h.setOption, h.init, h.resize, h.dispose]) f.mockClear();
  h.gradients.length = 0;
});

describe("按需注册（bundle 纪律：不引全量包）", () => {
  it("import 期就 use 了 Line+Grid+Tooltip+CanvasRenderer 四件套", () => {
    expect(h.use).toHaveBeenCalledTimes(1); // 顶层调用：模块加载即注册，不 lazy 到首帧
    expect(h.use.mock.calls[0][0]).toEqual([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);
  });
});

describe("option：数据映射与诚实条款", () => {
  it("一次 mount 一次 setOption；轴标签 MM-DD、通过率换算、null 保 null", () => {
    render(<WorkbenchTrend points={PTS} />);
    expect(h.setOption).toHaveBeenCalledTimes(1);
    const o = h.setOption.mock.calls[0][0];
    // 完整 YYYY-MM-DD 在 7 天轴上挤不下 → slice(5)
    expect(o.xAxis.data).toEqual(["11-10", "11-11", "11-12", "11-13"]);
    // 0.6667 → 66.7（toFixed(1) 四舍五入），0.5 → 50、1 → 100；null 不许塌成 0
    expect(o.series[0].data).toEqual([66.7, null, 50, 100]);
  });

  it("connectNulls=false：「缺一天」不得画成跨过它的直线（诚实条款）", () => {
    render(<WorkbenchTrend points={PTS} />);
    expect(h.setOption.mock.calls[0][0].series[0].connectNulls).toBe(false);
  });

  it("颜色全部来自 tp：折线/数据点 primary[500]（§11.6.5 :1496 的 #2BA47D），渐变 50→透明，轴走 split/text[3]", () => {
    render(<WorkbenchTrend points={PTS} />);
    const o = h.setOption.mock.calls[0][0];
    // 此处曾长期错用 primary[600]——那是实底按钮与小字的档位，图形大元素归 500（§11.6.1）
    expect(o.series[0].lineStyle.color).toBe(tp.primary[500]);
    expect(o.series[0].itemStyle.color).toBe(tp.primary[500]);
    const stops = h.gradients[0].args[4] as Array<{ offset: number; color: string }>;
    expect(stops).toEqual([
      { offset: 0, color: tp.primary[50] },          // 面积是底不是数据：浅到透明
      { offset: 1, color: "rgba(234,246,241,0)" },
    ]);
    expect(o.xAxis.axisLine.lineStyle.color).toBe(tp.split);
    expect(o.xAxis.axisLabel.color).toBe(tp.text[3]);
    expect(o.yAxis.axisLabel.color).toBe(tp.text[3]);
    expect(o.yAxis.splitLine.lineStyle.color).toBe(tp.split);
  });

  it("yAxis 钉死 0..100 + {value}%；tooltip 的 null 措辞按当日 runs 二分（「无运行」/「无有效分母」），不伪造 0%", () => {
    render(<WorkbenchTrend points={PTS} />);
    const o = h.setOption.mock.calls[0][0];
    expect([o.yAxis.min, o.yAxis.max, o.yAxis.axisLabel.formatter]).toEqual([0, 100, "{value}%"]);
    const fmt = o.tooltip.valueFormatter as (v: unknown, idx?: number) => string;
    expect(fmt(66.7)).toBe("66.7%");
    // 不带 dataIndex（ECharts 之外的调用方）时不许猜「无运行」——那是断言「那天没跑」
    expect(fmt(null)).toBe("无有效分母");
    expect(fmt(undefined)).toBe("无有效分母");
  });

  it("tooltip 两种 null：runs=0 那天说「无运行」，runs=5 而分母为 0 那天说「无有效分母」（后端 DailyPoint 的两因）", () => {
    render(<WorkbenchTrend points={PTS_NULL} />);
    const o = h.setOption.mock.calls[0][0];
    // 断点仍是 null：措辞二分不许把 null 塌成 0（connectNulls=false 的缺口靠它）
    expect(o.series[0].data).toEqual([null, null, 75]);
    const fmt = o.tooltip.valueFormatter as (v: unknown, idx?: number) => string;
    expect(fmt(null, 0)).toBe("无运行");     // 当日真的一次都没跑
    expect(fmt(null, 1)).toBe("无有效分母"); // 跑了 5 次全 skip：不能说「无运行」
    expect(fmt(75, 2)).toBe("75%");          // 有值那一侧仍走百分比
  });
});

describe("生命周期：监听器与实例必须原路归还", () => {
  it("挂 resize 监听（触发即 chart.resize），卸载时摘监听 + dispose", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const { unmount } = render(<WorkbenchTrend points={PTS} />);
      const leg = add.mock.calls.find(([t]) => t === "resize");
      expect(leg).toBeTruthy();
      (leg![1] as () => void)();
      expect(h.resize).toHaveBeenCalledTimes(1);
      unmount();
      // 摘的必须是同一个 handler：摘错了等于监听器永久泄漏在 window 上
      expect(remove).toHaveBeenCalledWith("resize", leg![1]);
      expect(h.dispose).toHaveBeenCalledTimes(1);
    } finally {
      add.mockRestore(); remove.mockRestore();
    }
  });

  it("points 变化重跑整轮 effect：dispose 旧实例 → 再 init + setOption", () => {
    const { rerender } = render(<WorkbenchTrend points={PTS} />);
    rerender(<WorkbenchTrend points={PTS2} />);
    expect([h.dispose.mock.calls.length, h.init.mock.calls.length, h.setOption.mock.calls.length]).toEqual([1, 2, 2]);
    expect(h.setOption.mock.calls[1][0].xAxis.data).toEqual(["12-01"]);
  });
});
